/* Scout page behaviour.

   Slideshow: /media/ is read via nginx's directory listing
   (autoindex is on for that location in the nginx config). Every image
   and video file found there is a candidate. Lists in the same folder (kept
   by /media-admin) decide the rest: not_in_gallery.txt names files left out
   of the gallery grid (all are in it otherwise), slideshow.txt names the
   files in the slideshow, order.txt sets their order (files it doesn't name
   follow, by filename), and captions.txt holds "<file>=<caption>" lines.
   settings.txt holds "slide_seconds=<n>", how long each photo shows.
*/

/* How long one run through a GIF takes, in ms, from its bytes: the sum of
   its frames' delays (in 1/100 s; browsers play 0 or 1 as 10). 0 if it
   can't be read. gifLength(src) fetches the file first. */
function gifRunMs(b) {
  var i = 13, total = 0;
  function skipBlocks() { while (i < b.length && b[i]) i += b[i] + 1; i++; }
  if (b.length < 13 || b[0] !== 0x47) return 0; // "GIF"
  if (b[10] & 0x80) i += 3 << ((b[10] & 7) + 1);
  while (i < b.length) {
    if (b[i] === 0x21) {
      if (b[i + 1] === 0xF9) { var d = b[i + 4] | (b[i + 5] << 8); total += d < 2 ? 10 : d; }
      i += 2;
      skipBlocks();
    } else if (b[i] === 0x2C) {
      var packed = b[i + 9];
      i += 10;
      if (packed & 0x80) i += 3 << ((packed & 7) + 1);
      i++; // LZW code size
      skipBlocks();
    } else break;
  }
  return total * 10;
}
function gifLength(src) {
  return fetch(src).then(function (r) { return r.arrayBuffer(); })
    .then(function (buf) { return gifRunMs(new Uint8Array(buf)); }, function () { return 0; });
}

/* Transition clips download one at a time through this queue (scenes:
   preloadClip), and a neighbouring section's media waits for it (whenNear),
   so a clip that's needed next never shares the connection. */
var clipQueue = Promise.resolve();

/* Scenes: the page is full-screen .scene layers (intro, dedication,
   slideshow, moments, gallery, messages) and scrolling fades between them instead of moving
   the page. A scene taller than the screen scrolls normally inside itself
   and only fades once you're at its top or bottom edge. Wheel, touch swipe,
   keyboard and the nav links all go through go(). .sidenav slides in on
   every scene after the intro (the intro has .topnav instead).

   A scene with data-clip="<gif or video>" (and data-clip-ms, how long to
   show it) uses that clip as the transition between it and the scene before
   it, in place of the usual cross-fade, both ways: arriving from above, and
   leaving it back up. A jump (nav link, dot) plays the one it would have
   crossed last, coming the normal way. A new scroll, tap, click or key
   press skips it (skipClip). With data-clip-from="<id or data-anchor>",
   only when that's the scene before.
   media/transitions.txt (set per GIF at /media-admin) fills these in:
   "<from>><to>=<gif>" lines, e.g. "top>dedication=river.gif", each GIF
   shown for one run through (its length read from its frame delays).
   "random=<gif>" lines make a pool: every boundary without its own GIF
   gets data-clip-random and plays one from it, picked (pickClip) before
   it's needed so it can preload, never the one played just before.
   The clips next to the current scene are preloaded as blobs, and each showing gets
   its own blob: URL. Every <img> of one GIF URL shares a single animation
   clock, so reusing the URL (it may be animating in Moments too) would start
   it mid-loop; until the blob is in, a cache-busting ?t= does the same job.

   .scene-dots, down the right edge, has one dot per scene: it shows where
   you are and jumps to a scene when clicked. */
(function scenes() {
  var list = Array.prototype.slice.call(document.querySelectorAll(".scene"));
  var sidenav = document.getElementById("sidenav");
  var lightbox = document.getElementById("lightbox");
  if (list.length < 2) return;

  var SHIFT = 24;          // px of vertical drift during the fade
  var LOCK_MS = 1000;      // ignore further input while a fade runs
  var SETTLE_MS = 160;     // a scene must sit still this long at its edge before fading
  var SCENE_OUT_MS = 450;  // a scene's fade-out, as in style.css
  var SCENE_IN_MS = 650;   // a scene's fade-in, as in style.css
  var CLIP_FADE_OUT_MS = 700; // .scene-clip's fade-out, as in style.css
  var current = 0;
  var lockUntil = 0;
  var lastScrollAt = 0;
  var reduceMotion = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  var clip = null, clipScene = null, clipTimers = [];
  var clipRun = 0;          // bumped by stopClip, so a clip still waiting for its file gives up
  var CLIP_WAIT_MS = 15000; // longest the next scene waits for a GIF clip that's still downloading
  var clipShown = null;     // the waiting scene's shown(), until it's called
  var clipPool = [];        // GIFs for transitions without their own ("random=" lines)
  var lastClip = null;      // the clip played last, so Random doesn't repeat it
  var lastWheelAt = 0;

  document.documentElement.classList.add("scenes");

  // Named after the matching nav link ("Top" for the intro).
  var dotNav = document.createElement("nav");
  dotNav.className = "scene-dots";
  dotNav.setAttribute("aria-label", "Sections");
  var dots = list.map(function (el, i) {
    var anchor = el.getAttribute("data-anchor");
    var link = anchor && document.querySelector('.sidenav a[href="#' + anchor + '"]');
    var name = i === 0 ? "Top" : link ? link.textContent.trim() : anchor;
    var b = document.createElement("button");
    b.type = "button";
    b.setAttribute("aria-label", name);
    b.title = name;
    b.addEventListener("click", function () {
      if (i === current || busy()) return;
      lockUntil = Date.now() + LOCK_MS;
      activate(i, i > current ? 1 : -1, false);
    });
    dotNav.appendChild(b);
    return b;
  });
  document.body.appendChild(dotNav);

  function atTop(el) { return el.scrollTop <= 1; }
  function atBottom(el) { return el.scrollTop + el.clientHeight >= el.scrollHeight - 2; }
  function busy() { return lightbox && !lightbox.hidden; }

  function setShift(el, px) { el.style.setProperty("--shift", px + "px"); }

  // Sequence: the old scene fades out to the paper background, the clip
  // fades in from it, plays, fades back out, and only then does the new
  // scene fade in (its fade-in is held back with an inline transition-delay).
  function stopClip() {
    clipRun++;
    clipTimers.forEach(clearTimeout);
    clipTimers = [];
    clipShown = null;
    if (clip) clip.classList.remove("show");
    if (clipScene) {
      clipScene.style.transitionDelay = "";
      clipScene.style.opacity = "";
      clipScene.style.visibility = "";
      clipScene = null;
    }
  }

  // Cut a transition short: the clip goes, and the new scene fades straight
  // in (its delayed fade can't just be shortened, so it's restarted).
  function skipClip() {
    var to = clipScene, shown = clipShown;
    if (!shown) return; // only while the clip's up, not once the scene's fading in
    stopClip();
    to.style.transition = "none";
    to.style.opacity = "0";
    void to.offsetWidth;
    to.style.transition = "";
    to.style.transitionDelay = "0s";
    to.style.opacity = "";
    setTimeout(function () { if (!clipScene) to.style.transitionDelay = ""; }, SCENE_IN_MS);
    lockUntil = Date.now() + 400;
    if (shown) shown();
  }

  // Give a Random boundary's scene a GIF from the pool, if it has none yet
  // or has just played it: not the one played last, if there's a choice.
  function pickClip(scene) {
    if (!scene || !scene.hasAttribute("data-clip-random") || !clipPool.length) return;
    if (scene.getAttribute("data-clip") && !scene.hasAttribute("data-clip-used")) return;
    var choices = clipPool.filter(function (s) { return s !== lastClip; });
    if (!choices.length) choices = clipPool;
    scene.setAttribute("data-clip", choices[Math.floor(Math.random() * choices.length)]);
    scene.removeAttribute("data-clip-used");
  }

  // The scene carrying the clip between scenes i - 1 and i is list[i].
  function clipAt(i) {
    var sc = list[i], only = sc && sc.getAttribute("data-clip-from");
    if (!sc || i < 1 || !sc.getAttribute("data-clip")) return null;
    if (only !== null && only !== (list[i - 1].getAttribute("data-anchor") || list[i - 1].id)) return null;
    return sc;
  }
  // Going to scene `to` from scene `from`: down, the boundary just above
  // `to`; up, the one just below it. If there's a clip, plays it and calls
  // shown() once `to` starts fading in, and returns true. A GIF that hasn't
  // finished downloading yet (a first visit) holds `to` back, hidden, until
  // it has, so the clip isn't skipped; if it's still not in after
  // CLIP_WAIT_MS, `to` just fades in without it.
  function playClip(to, from, shown) {
    var i = list.indexOf(to), j = list.indexOf(from);
    var carrier = clipAt(i > j ? i : i + 1);
    if (!carrier || reduceMotion) return false;
    var src = carrier.getAttribute("data-clip");
    lastClip = src;
    if (carrier.hasAttribute("data-clip-random")) carrier.setAttribute("data-clip-used", "");
    var isVideo = /\.(mp4|webm|mov|m4v)$/i.test(src);
    if (!clip) {
      clip = document.createElement("div");
      clip.className = "scene-clip";
      clip.setAttribute("aria-hidden", "true");
      document.body.appendChild(clip);
    }
    clipScene = to;
    clipShown = shown;
    var run = clipRun, t0 = Date.now();
    if (isVideo || clipBlobs[src]) { start(); return true; }
    to.style.opacity = "0";
    to.style.visibility = "hidden";
    lockUntil = Math.max(lockUntil, Date.now() + CLIP_WAIT_MS + SCENE_IN_MS);
    var giveUp = new Promise(function (r) { clipTimers.push(setTimeout(r, CLIP_WAIT_MS)); });
    Promise.race([preloadClip(carrier), giveUp]).then(function () {
      if (run !== clipRun) return;
      if (clipBlobs[src]) return start();
      to.style.opacity = "";
      to.style.visibility = "";
      lockUntil = Date.now() + SCENE_IN_MS;
      stopClip();
      shown();
    });
    return true;

    function start() {
      var ms = Number(carrier.getAttribute("data-clip-ms")) || clipMs[src] || 2000;
      var out = Math.max(0, SCENE_OUT_MS - (Date.now() - t0)); // what's left of the old scene's fade-out
      var sceneIn = out + ms; // when the new scene starts fading in
      to.style.transitionDelay = sceneIn + "ms, " + sceneIn + "ms, 0s";
      to.style.opacity = "";
      to.style.visibility = "";
      lockUntil = Date.now() + sceneIn + SCENE_IN_MS;

      clipTimers.push(setTimeout(function () {
        // A fresh element each time so the clip starts from its first frame.
        var media = document.createElement(isVideo ? "video" : "img");
        if (isVideo) { media.muted = true; media.playsInline = true; media.autoplay = true; }
        else media.alt = "";
        if (clipUrl) URL.revokeObjectURL(clipUrl);
        clipUrl = clipBlobs[src] ? URL.createObjectURL(clipBlobs[src]) : null;
        media.src = clipUrl || (isVideo ? src : src + (src.indexOf("?") < 0 ? "?" : "&") + "t=" + Date.now());
        clip.textContent = "";
        clip.appendChild(media);
        void clip.offsetWidth;
        clip.classList.add("show");
      }, out));
      // Start fading out early enough to be gone by the end of the clip.
      clipTimers.push(setTimeout(function () { clip.classList.remove("show"); }, out + Math.max(0, ms - CLIP_FADE_OUT_MS)));
      clipTimers.push(setTimeout(function () { clipShown = null; shown(); }, sceneIn));
      clipTimers.push(setTimeout(stopClip, sceneIn + SCENE_IN_MS));
    }
  }

  var clipBlobs = {}; // GIF clip path -> its Blob, once downloaded and timed
  var clipMs = {};    // GIF clip path -> one run through, in ms, from its frames
  var clipLoads = {}; // GIF clip path -> the download, a promise
  var clipUrl = null; // the blob: URL on screen, revoked when it's done
  // Fetch a scene's GIF clip ahead of time (first in line: the other
  // sections' media wait until they're near, see whenNear), and time it from
  // its frames (clipMs) unless the scene sets data-clip-ms itself. The promise
  // resolves once it's ready, or failed. Clips download one after another,
  // in the order they're asked for (the next one in, then the one after).
  function preloadClip(scene) {
    var src = scene && scene.getAttribute("data-clip");
    if (!src || reduceMotion || /\.(mp4|webm|mov|m4v)$/i.test(src)) return Promise.resolve();
    if (clipLoads[src]) return clipLoads[src];
    return (clipLoads[src] = clipQueue = clipQueue
      .then(function () { return fetch(src, { priority: "high" }); })
      .then(function (r) { return r.ok ? r.blob() : Promise.reject(); })
      .then(function (b) {
        return new Response(b).arrayBuffer().then(function (buf) {
          var ms = gifRunMs(new Uint8Array(buf));
          if (ms) clipMs[src] = ms;
          clipBlobs[src] = b;
        });
      })
      .catch(function () { delete clipLoads[src]; }));
  }

  // The GIF transitions chosen at /media-admin.
  fetch("media/transitions.txt", { cache: "no-cache" })
    .then(function (r) { return r.ok ? r.text() : ""; }, function () { return ""; })
    .then(function (t) {
      t.split("\n").forEach(function (l) {
        var r = /^\s*random\s*=\s*(.+?)\s*$/.exec(l);
        if (r) { clipPool.push("media/" + encodeURIComponent(r[1])); return; }
        var m = /^\s*([\w-]+)>([\w-]+)\s*=\s*(.+?)\s*$/.exec(l);
        if (!m) return;
        var to = list.filter(function (sc) { return (sc.getAttribute("data-anchor") || sc.id) === m[2]; })[0];
        if (!to) return;
        to.setAttribute("data-clip", "media/" + encodeURIComponent(m[3]));
        to.setAttribute("data-clip-from", m[1]);
        to.removeAttribute("data-clip-ms");
      });
      list.forEach(function (sc, i) {
        if (i > 0 && clipPool.length && !sc.getAttribute("data-clip")) sc.setAttribute("data-clip-random", "");
      });
      pickClip(list[current]);
      pickClip(list[current + 1]);
      preloadClip(list[current]);
      preloadClip(list[current + 1]);
    });

  function activate(i, dir, instant) {
    var from = list[current];
    var to = list[i];
    stopClip();

    // Park the incoming scene on the side it arrives from, without animating.
    to.style.transition = "none";
    setShift(to, dir >= 0 ? SHIFT : -SHIFT);
    to.scrollTop = dir >= 0 ? 0 : to.scrollHeight;
    void to.offsetWidth;
    to.style.transition = instant ? "none" : "";

    if (from !== to) {
      setShift(from, dir >= 0 ? -SHIFT : SHIFT);
      from.classList.remove("is-active");
    }
    var held = !instant && from !== to && playClip(to, from, shown);
    list.forEach(function (el) { el.classList.remove("is-shown"); });
    to.classList.add("is-active");
    if (instant) { void to.offsetWidth; to.style.transition = ""; }

    current = i;
    lastScrollAt = 0;
    if (sidenav) sidenav.classList.toggle("visible", i > 0);
    dots.forEach(function (d, j) { d.setAttribute("aria-current", j === i ? "true" : "false"); });

    var anchor = to.getAttribute("data-anchor");
    try { history.replaceState(null, "", anchor ? "#" + anchor : location.pathname + location.search); } catch (e) {}

    pickClip(list[i]);
    pickClip(list[i + 1]);
    preloadClip(list[i]);     // the clip back up
    preloadClip(list[i + 1]); // the clip on down

    // The slideshow and Moments pause as soon as their scene is left, and
    // only start once it's .is-shown: right away, or after a transition
    // clip has finished. Each change fires "scenechange".
    document.dispatchEvent(new CustomEvent("scenechange"));
    function shown() {
      to.classList.add("is-shown");
      document.dispatchEvent(new CustomEvent("scenechange"));
    }
    if (!held) shown();
  }

  function go(dir) {
    var i = current + dir;
    if (i < 0 || i >= list.length) return false;
    lockUntil = Date.now() + LOCK_MS;
    activate(i, dir, false);
    return true;
  }

  function goToEl(el) {
    var scene = el && el.closest(".scene");
    var i = list.indexOf(scene);
    if (i < 0 || i === current) return;
    lockUntil = Date.now() + LOCK_MS;
    activate(i, i > current ? 1 : -1, false);
  }

  list.forEach(function (el) {
    el.addEventListener("scroll", function () { lastScrollAt = Date.now(); }, { passive: true });
  });

  // Start on the scene named in the URL hash, if any.
  var start = 0;
  if (location.hash) {
    var target = document.getElementById(location.hash.slice(1));
    var s = target && list.indexOf(target.closest(".scene"));
    if (s > 0) start = s;
  }
  list.forEach(function (el) { el.style.transition = "none"; });
  activate(start, 1, true);
  list.forEach(function (el) { void el.offsetWidth; el.style.transition = ""; });

  window.addEventListener("wheel", function (e) {
    if (busy()) return;
    var now = Date.now(), gap = now - lastWheelAt;
    lastWheelAt = now;
    if (clipShown) {
      // A fresh scroll (not the tail of the one that started it) skips the clip.
      e.preventDefault();
      if (gap > 300) skipClip();
      return;
    }
    if (now < lockUntil) {
      // Trackpad momentum keeps firing after a fade starts; hold the lock
      // until that stream of events dies down.
      lockUntil = Math.max(lockUntil, now + 250);
      e.preventDefault();
      return;
    }
    if (Math.abs(e.deltaY) < 4) return;
    var el = list[current];
    var dir = e.deltaY > 0 ? 1 : -1;
    var edge = dir > 0 ? atBottom(el) : atTop(el);
    if (!edge || now - lastScrollAt < SETTLE_MS) return; // let the scene scroll natively
    e.preventDefault();
    go(dir);
  }, { passive: false });

  var touchX = 0, touchY = 0, touchTop = false, touchBottom = false;
  window.addEventListener("touchstart", function (e) {
    var el = list[current];
    touchX = e.touches[0].clientX;
    touchY = e.touches[0].clientY;
    touchTop = atTop(el);
    touchBottom = atBottom(el);
  }, { passive: true });
  window.addEventListener("touchend", function (e) {
    if (busy() || Date.now() < lockUntil) return;
    var dx = e.changedTouches[0].clientX - touchX;
    var dy = touchY - e.changedTouches[0].clientY; // > 0 means swiped up (toward the next scene)
    if (Math.abs(dy) < 50 || Math.abs(dy) < Math.abs(dx) * 1.2) return; // too short, or a sideways slideshow swipe
    if (dy > 0 && touchBottom) go(1);
    else if (dy < 0 && touchTop) go(-1);
  }, { passive: true });

  document.addEventListener("keydown", function (e) {
    if (busy() || e.altKey || e.ctrlKey || e.metaKey) return;
    if (clipShown) { if (!e.repeat && e.key !== "Tab" && e.key !== "Shift") { e.preventDefault(); skipClip(); } return; }
    var tag = e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "VIDEO") return;
    var el = list[current];
    var page = el.clientHeight * 0.85;
    var dir = 0, step = 0;
    switch (e.key) {
      case "ArrowDown": dir = 1; step = 60; break;
      case "ArrowUp": dir = -1; step = 60; break;
      case "PageDown": dir = 1; step = page; break;
      case "PageUp": dir = -1; step = page; break;
      case " ":
        if (tag === "BUTTON" || tag === "A") return;
        dir = e.shiftKey ? -1 : 1; step = page; break;
      case "Home": e.preventDefault(); if (current) { lockUntil = Date.now() + LOCK_MS; activate(0, -1, false); } return;
      case "End": e.preventDefault(); if (current < list.length - 1) { lockUntil = Date.now() + LOCK_MS; activate(list.length - 1, 1, false); } return;
      default: return;
    }
    e.preventDefault();
    if (Date.now() < lockUntil) return;
    if (dir > 0 ? atBottom(el) : atTop(el)) go(dir);
    else el.scrollBy({ top: dir * step, behavior: "smooth" });
  });

  // A tap or click during a transition skips it (and goes no further,
  // unless it's on a nav link or dot, which go where they point).
  var swallowClick = 0;
  document.addEventListener("pointerdown", function (e) {
    if (!clipShown || busy() || e.target.closest('a[href^="#"], .scene-dots')) return;
    skipClip();
    swallowClick = Date.now() + 800;
  }, true);
  document.addEventListener("click", function (e) {
    if (Date.now() < swallowClick) { swallowClick = 0; e.preventDefault(); e.stopPropagation(); }
  }, true);

  // Nav links fade to their scene instead of jumping.
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest('a[href^="#"]');
    if (!a) return;
    var target = document.getElementById(a.getAttribute("href").slice(1));
    if (!target || !target.closest(".scene")) return;
    e.preventDefault();
    goToEl(target);
  });
})();

/* A stack of cards (slideshow, Moments): els[0] starts on top, with the next
   couple peeking out below it. go(1) slides the top card out to the left and
   tucks it under the bottom while the rest move up one; go(-1) brings the
   bottom card back in from the left onto the top; goTo(i) turns the stack
   straight to card i. onTop(i) runs whenever card i comes to the top (right
   away, as the animation starts). The container needs .card-stack and each
   card .stack-card (style.css); they're placed with inline transforms. */
var STACK_DEPTH = 3;    // cards visible in a stack
var STACK_PEEK = 16;    // px each card below the top one sticks out
var STACK_OUT_MS = 450; // the top card's slide out to the left, as in style.css
function cardStack(els, onTop) {
  var reduceMotion = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  var order = els.map(function (el, i) { return i; }); // order[0] is on top
  var busy = false;
  // Every transform has the same functions in the same order, so the
  // browser can animate between any two of them.
  function transform(x, y, scale, deg) {
    return "translateX(" + x + "%) translateY(" + y + "px) scale(" + scale + ") rotate(" + deg + "deg)";
  }
  var OUT = transform(-75, 0, 1, -5);
  // 0 on top, each one below it a little lower and smaller, and those past
  // STACK_DEPTH tucked out of sight.
  function place(i, pos) {
    var el = els[i], d = Math.min(pos, STACK_DEPTH);
    el.style.zIndex = String(els.length - pos);
    el.style.transform = transform(0, d * STACK_PEEK, 1 - d * 0.05, 0);
    el.style.opacity = pos < STACK_DEPTH ? "" : "0";
    el.classList.toggle("is-top", pos === 0);
    el.setAttribute("aria-hidden", pos === 0 ? "false" : "true");
  }
  function layout() { order.forEach(place); onTop(order[0]); }
  function go(dir) {
    if (busy || els.length < 2) return false;
    busy = true;
    var out = reduceMotion ? 0 : STACK_OUT_MS, el;
    if (dir > 0) {
      var top = order.shift();
      order.push(top);
      el = els[top];
      order.forEach(function (i, pos) { if (i !== top) place(i, pos); });
      el.classList.add("is-out");
      el.classList.remove("is-top");
      el.style.zIndex = String(els.length + 1);
      el.style.transform = OUT;
      onTop(order[0]);
      setTimeout(function () {
        el.classList.remove("is-out");
        place(top, order.length - 1);
        busy = false;
      }, out);
    } else {
      var back = order.pop();
      order.unshift(back);
      el = els[back];
      el.classList.add("is-out");
      el.style.transition = "none";
      el.style.zIndex = String(els.length + 1);
      el.style.transform = OUT;
      el.style.opacity = "";
      void el.offsetWidth;
      el.style.transition = "";
      el.classList.remove("is-out");
      layout();
      setTimeout(function () { busy = false; }, out);
    }
    return true;
  }
  function goTo(i) {
    var steps = order.indexOf(i);
    if (steps <= 0) return;
    order = order.slice(steps).concat(order.slice(0, steps));
    layout();
  }
  layout();
  return { go: go, goTo: goTo, top: function () { return order[0]; } };
}

/* A section's photos and videos only start downloading once you're on it or
   on a section next to it (the scenes are all laid out at once, so lazy
   loading alone would fetch everything up front). That leaves the
   connection to the hero and the first transition clip on a first visit.
   whenNear(el, fn) runs fn once, then; right away without scenes, and for a
   neighbouring section only after any transition clip download (clipQueue).
   whenNear(el, fn, 0) waits until you're on el's section itself. */
function whenNear(el, fn, within) {
  var sc = el.closest(".scene");
  if (within === undefined) within = 1;
  function near() {
    if (!sc || !document.documentElement.classList.contains("scenes")) return true;
    var all = Array.prototype.slice.call(document.querySelectorAll(".scene"));
    var active = document.querySelector(".scene.is-active");
    return !active || Math.abs(all.indexOf(active) - all.indexOf(sc)) <= within;
  }
  function run() {
    var active = document.querySelector(".scene.is-active");
    if (!sc || active === sc || !document.documentElement.classList.contains("scenes")) fn();
    else clipQueue.then(fn);
  }
  if (near()) return run();
  document.addEventListener("scenechange", function check() {
    if (!near()) return;
    document.removeEventListener("scenechange", check);
    run();
  });
}

/* Dot rows (slideshow, Moments): with more than DOT_WINDOW dots, only a
   window of them around the current one shows, sliding along as it moves;
   the dots at an end with more beyond it shrink to hint at them. */
var DOT_WINDOW = 7;
function windowDots(wrap, dots, current) {
  var n = dots.length;
  if (n <= DOT_WINDOW) return;
  var strip = wrap.firstChild;
  if (!strip || !strip.classList || !strip.classList.contains("dot-strip")) {
    strip = document.createElement("div");
    strip.className = "dot-strip";
    dots.forEach(function (d) { strip.appendChild(d); });
    wrap.appendChild(strip);
    wrap.classList.add("is-windowed");
    window.addEventListener("resize", function () { windowDots(wrap, dots, wrap._current); });
  }
  wrap._current = current;
  var step = dots[1].offsetLeft - dots[0].offsetLeft; // a dot plus the gap, which changes on phones
  var start = Math.max(0, Math.min(current - (DOT_WINDOW - 1) / 2, n - DOT_WINDOW));
  wrap.style.width = (step * (DOT_WINDOW - 1) + dots[0].offsetWidth) + "px";
  strip.style.transform = "translateX(" + (-start * step) + "px)";
  dots.forEach(function (d, j) {
    var k = j - start, inside = k >= 0 && k < DOT_WINDOW;
    var fromEnd = Math.min(k, DOT_WINDOW - 1 - k);
    var more = k < DOT_WINDOW / 2 ? start > 0 : start + DOT_WINDOW < n;
    d.style.transform = !inside ? "scale(0)" : more && fromEnd === 0 ? "scale(.5)" : more && fromEnd === 1 ? "scale(.75)" : "";
    d.tabIndex = inside ? 0 : -1;
  });
}

(function slideshow() {
  var DIR = "media/";
  var AUTOPLAY_MS = 5000; // default; media/settings.txt's slide_seconds overrides it

  var IMAGE_RE = /\.(jpe?g|png|gif|webp|avif)$/i;
  var VIDEO_RE = /\.(mp4|webm|mov|m4v)$/i;

  var stage = document.getElementById("slideshow-stage");
  var captionEl = document.getElementById("slideshow-caption");
  var grid = document.getElementById("photo-grid");
  var dotWrap = document.getElementById("slideshow-dots");
  var counter = document.getElementById("slideshow-count");
  var prevBtn = document.getElementById("ss-prev");
  var nextBtn = document.getElementById("ss-next");

  var items = [];
  var stack = null;
  var dots = [];
  var current = 0;
  var paused = false;
  var bar = document.createElement("i");

  var lightbox = document.getElementById("lightbox");
  var lightboxImg = document.getElementById("lightbox-img");
  var lightboxVideo = null; // made on first use, so photos never share the viewport with it
  var lightboxClose = document.getElementById("lightbox-close");
  var lightboxCaption = document.getElementById("lightbox-caption");

  if (!stage) return;

  // A missing list just means an empty one: its non-blank lines, trimmed.
  function fetchLines(name) {
    return fetch(DIR + name, { cache: "no-cache" })
      .then(function (r) { return r.ok ? r.text() : ""; }, function () { return ""; })
      .then(function (t) {
        return t.split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
      });
  }
  function toSet(lines) {
    var set = {};
    lines.forEach(function (l) { set[l] = true; });
    return set;
  }

  var notInGallery = {}, inSlideshow = {}, order = [], captions = {};
  Promise.all([fetchLines("not_in_gallery.txt"), fetchLines("slideshow.txt"), fetchLines("order.txt"), fetchLines("captions.txt"), fetchLines("settings.txt")])
    .then(function (lists) {
      notInGallery = toSet(lists[0]);
      inSlideshow = toSet(lists[1]);
      order = lists[2];
      lists[3].forEach(function (l) {
        var i = l.indexOf("=");
        if (i > 0) captions[l.slice(0, i)] = l.slice(i + 1).trim();
      });
      lists[4].forEach(function (l) {
        var m = /^slide_seconds\s*=\s*(\d+(?:\.\d+)?)$/.exec(l);
        if (m && +m[1] > 0) AUTOPLAY_MS = Math.round(+m[1] * 1000);
      });
      return fetch(DIR, { cache: "no-cache" });
    })
    .then(function (r) { return r.ok ? r.text() : Promise.reject(new Error("HTTP " + r.status)); })
    .then(function (html) {
      var doc = new DOMParser().parseFromString(html, "text/html");
      var files = Array.prototype.slice.call(doc.querySelectorAll("a"))
        .map(function (a) { return a.getAttribute("href"); })
        .filter(function (f) { return f && (IMAGE_RE.test(f) || VIDEO_RE.test(f)); })
        .map(function (f) { return decodeURIComponent(f.split("/").pop()); });

      var seen = {};
      files = files.filter(function (f) {
        if (seen[f]) return false;
        seen[f] = true;
        return true;
      });
      files.sort(function (a, b) {
        var i = order.indexOf(a), j = order.indexOf(b);
        if (i < 0) i = Infinity;
        if (j < 0) j = Infinity;
        return i !== j ? i - j : a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
      });
      buildGrid(files.filter(function (f) { return !notInGallery[f]; }));
      // Still photos only: GIFs and videos belong to Moments.
      start(files.filter(function (f) { return inSlideshow[f] && IMAGE_RE.test(f) && !/\.gif$/i.test(f); }));
    })
    .catch(function (err) {
      console.error("slideshow: could not read " + DIR, err);
      stage.innerHTML = '<div class="ss-empty">Couldn’t load the slideshow right now.</div>';
      if (grid) grid.innerHTML = '<div class="ss-empty">Couldn’t load the photos right now.</div>';
    });

  // The photos as a stack of cards (cardStack): the top one showing, the
  // next couple peeking out below, and each one sliding out left and under
  // as the next comes up.
  function start(files) {
    items = files.map(function (f) { return { file: f, caption: captions[f] || "" }; });
    if (!items.length) {
      stage.innerHTML = '<div class="ss-empty">No photos in the slideshow yet.</div>';
      return;
    }
    var cards = items.map(function (item, i) {
      var card = document.createElement("div");
      card.className = "stack-card ss-card";
      var el = document.createElement("img");
      // The top few as you come near; the rest once you're on the slideshow.
      whenNear(stage, function () { el.src = DIR + item.file; }, i < STACK_DEPTH ? 1 : 0);
      el.alt = item.caption || "Scout";
      el.loading = i < STACK_DEPTH ? "eager" : "lazy";
      el.addEventListener("click", function () { openLightbox(el.src, false, item.caption); });
      card.appendChild(el);

      var b = document.createElement("button");
      b.type = "button";
      b.setAttribute("aria-label", "Photo " + (i + 1));
      b.appendChild(document.createElement("i"));
      b.addEventListener("click", function () { goTo(i); });
      dotWrap.appendChild(b);
      dots.push(b);
      return card;
    });
    stage.classList.add("card-stack");
    // Bottom of the stack first, so the top card is last in the DOM too.
    cards.slice().reverse().forEach(function (c) { stage.appendChild(c); });

    // The progress bar along the bottom of the photo: a CSS animation as long
    // as AUTOPLAY_MS whose end moves to the next slide, so pausing it (mouse
    // over the photo, lightbox open) pauses the slideshow too.
    var progress = document.createElement("div");
    progress.className = "ss-progress";
    progress.setAttribute("aria-hidden", "true");
    progress.appendChild(bar);
    stage.appendChild(progress);
    bar.addEventListener("animationend", next);

    stage.addEventListener("mouseenter", function () { paused = true; setPaused(); });
    stage.addEventListener("mouseleave", function () { paused = false; setPaused(); });

    var touchX = null;
    stage.addEventListener("touchstart", function (e) { touchX = e.touches[0].clientX; }, { passive: true });
    stage.addEventListener("touchend", function (e) {
      if (touchX === null) return;
      var dx = e.changedTouches[0].clientX - touchX;
      if (Math.abs(dx) > 44) { dx < 0 ? next() : previous(); }
      touchX = null;
    });

    document.addEventListener("keydown", function (e) {
      var tag = e.target.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return; // typing a message
      if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") previous();
    });

    if (prevBtn) prevBtn.addEventListener("click", previous);
    if (nextBtn) nextBtn.addEventListener("click", next);

    stack = cardStack(cards, show);
    tick();
  }

  // The Gallery section: photos and videos from the same folder, as a
  // masonry grid that keeps each one's shape, opening in the lightbox. A
  // video tile shows its first frame (only its metadata loads until it's
  // opened) and a play badge.
  //
  // The grid's rows are 1px tall (style.css), so a tile spanning N rows is N
  // px tall: once a tile knows its picture's shape, it spans its width times
  // that ratio, plus the gap below it. Until then it's square.
  function sizeTile(b) {
    var ratio = Number(b.getAttribute("data-ratio")) || 1;
    var gap = parseFloat(getComputedStyle(b).marginBottom) || 0;
    b.style.gridRowEnd = "span " + Math.max(1, Math.round(b.offsetWidth * ratio + gap));
  }
  function sizeTiles() {
    if (grid) Array.prototype.forEach.call(grid.querySelectorAll("button"), sizeTile);
  }
  var resizeTimer = null;
  window.addEventListener("resize", function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(sizeTiles, 100); });

  function buildGrid(files) {
    if (!grid) return;
    files.forEach(function (file) {
      var isVideo = VIDEO_RE.test(file);
      var caption = captions[file] || "";
      var b = document.createElement("button");
      b.type = "button";
      b.setAttribute("aria-label", (isVideo ? "Play video" : "Open photo") + (caption ? ": " + caption : ""));
      var thumb;
      if (isVideo) {
        thumb = document.createElement("video");
        whenNear(grid, function () { thumb.src = DIR + encodeURIComponent(file) + "#t=0.1"; });
        thumb.muted = true;
        thumb.playsInline = true;
        thumb.preload = "metadata";
        thumb.addEventListener("loadedmetadata", function () {
          if (thumb.videoWidth) { b.setAttribute("data-ratio", thumb.videoHeight / thumb.videoWidth); sizeTile(b); }
        });
        var badge = document.createElement("span");
        badge.className = "play";
        badge.setAttribute("aria-hidden", "true");
        b.appendChild(badge);
      } else {
        thumb = document.createElement("img");
        whenNear(grid, function () { thumb.src = DIR + file; });
        thumb.alt = caption || "Scout";
        thumb.loading = "lazy";
        thumb.addEventListener("load", function () {
          if (thumb.naturalWidth) { b.setAttribute("data-ratio", thumb.naturalHeight / thumb.naturalWidth); sizeTile(b); }
        });
      }
      b.insertBefore(thumb, b.firstChild);
      b.addEventListener("click", function () { openLightbox(DIR + encodeURIComponent(file), isVideo, caption); });
      grid.appendChild(b);
      sizeTile(b);
    });
    if (!grid.children.length) grid.innerHTML = '<div class="ss-empty">Nothing in the gallery yet.</div>';
    else grid.classList.add("masonry");
  }

  // Card i has come to the top of the stack.
  function show(i) {
    current = i;
    dots.forEach(function (d, j) { d.setAttribute("aria-current", j === current ? "true" : "false"); });
    windowDots(dotWrap, dots, current);
    if (counter) counter.textContent = pad(current + 1) + " / " + pad(items.length);
    if (captionEl) captionEl.textContent = items[current].caption;
  }

  function pad(n) { return n < 10 ? "0" + n : String(n); }

  // Restart the progress bar for the current slide.
  function tick() {
    bar.style.animation = "none";
    bar.style.width = "0";
    var on = AUTOPLAY_MS && items.length > 1;
    bar.parentNode.hidden = !on;
    if (!on) return;
    void bar.offsetWidth;
    bar.style.width = "";
    bar.style.animation = "ss-fill " + AUTOPLAY_MS + "ms linear forwards";
    setPaused();
  }
  // Paused while the mouse is over the photo, the lightbox is open, or the
  // slideshow isn't the section on screen (see scenes: .is-shown).
  function sceneShown() {
    var sc = stage.closest(".scene");
    return !document.documentElement.classList.contains("scenes") || !sc || sc.classList.contains("is-shown");
  }
  function setPaused() {
    bar.style.animationPlayState = paused || !sceneShown() || (lightbox && !lightbox.hidden) ? "paused" : "running";
  }
  // Arriving at the slideshow starts the photo on top over, with its full time.
  var wasShown = false;
  document.addEventListener("scenechange", function () {
    var now = sceneShown();
    if (stack && now && !wasShown) tick(); else setPaused();
    wasShown = now;
  });

  function next() { stack.go(1); tick(); }
  function previous() { stack.go(-1); tick(); }
  function goTo(i) { stack.goTo(i); tick(); }

  // Click a photo to see it enlarged, then use the scroll wheel to zoom
  // smoothly in and out. Autoplay is paused while the lightbox is open.
  var MIN_ZOOM = 1;
  var MAX_ZOOM = 4;
  var zoom = 1;
  var baseW = 0;

  function measureBase() {
    lightbox.classList.remove("zoomed");
    lightboxImg.style.width = "";
    baseW = lightboxImg.offsetWidth;
  }
  function applyZoom() {
    if (zoom <= 1.001) {
      lightbox.classList.remove("zoomed");
      lightboxImg.style.width = "";
    } else {
      lightbox.classList.add("zoomed");
      lightboxImg.style.width = Math.round(baseW * zoom) + "px";
    }
  }
  // Videos open in the same lightbox, playing with sound and controls;
  // zoom and pan are for photos only (baseW stays 0 for a video).
  function openLightbox(src, isVideo, caption) {
    if (!lightbox || !lightboxImg) return;
    if (lightboxCaption) { lightboxCaption.textContent = caption || ""; lightboxCaption.hidden = !caption; }
    zoom = 1;
    baseW = 0;
    lightboxImg.style.width = "";
    lightbox.classList.remove("zoomed");
    // Shown and hidden with inline display, not [hidden], so a stale
    // stylesheet can't leave both in the flex row side by side.
    lightboxImg.style.display = isVideo ? "none" : "";
    if (lightboxVideo) lightboxVideo.style.display = isVideo ? "" : "none";
    lightbox.hidden = false;
    setPaused();
    if (isVideo) {
      if (!lightboxVideo) {
        lightboxVideo = document.createElement("video");
        lightboxVideo.controls = true;
        lightboxVideo.playsInline = true;
        lightboxImg.parentNode.appendChild(lightboxVideo);
      }
      lightboxVideo.src = src;
      var p = lightboxVideo.play();
      if (p && p.catch) p.catch(function () {});
      return;
    }
    lightboxImg.src = src;
    if (lightboxImg.complete) measureBase();
    else lightboxImg.onload = measureBase;
  }
  function closeLightbox() {
    if (!lightbox || !lightboxImg) return;
    lightbox.hidden = true;
    lightbox.classList.remove("zoomed");
    lightboxImg.style.width = "";
    lightboxImg.src = "";
    if (lightboxVideo && lightboxVideo.getAttribute("src")) {
      lightboxVideo.pause();
      lightboxVideo.removeAttribute("src");
      lightboxVideo.load();
    }
    setPaused();
  }
  if (lightbox) {
    lightbox.addEventListener("click", function (e) {
      if (e.target !== lightboxImg && e.target !== lightboxVideo && e.target !== lightboxCaption) closeLightbox();
    });
    lightbox.addEventListener("dblclick", function (e) {
      if (e.target !== lightboxImg) return;
      zoom = 1;
      applyZoom();
    });
    // Zoom toward the cursor: the point under it stays put as the scale
    // changes, same easing curve as the reframe-zoom in image-slot.js.
    lightbox.addEventListener("wheel", function (e) {
      if (lightbox.hidden || !baseW) return;
      e.preventDefault();
      var before = lightboxImg.getBoundingClientRect();
      var fracX = (e.clientX - before.left) / before.width;
      var fracY = (e.clientY - before.top) / before.height;

      zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * Math.pow(1.0015, -e.deltaY)));
      applyZoom();

      // Re-measure post-zoom and solve for the scroll offset that leaves
      // the same image point under the cursor.
      var after = lightboxImg.getBoundingClientRect();
      var docLeft = after.left + lightbox.scrollLeft;
      var docTop = after.top + lightbox.scrollTop;
      lightbox.scrollLeft = docLeft + fracX * after.width - e.clientX;
      lightbox.scrollTop = docTop + fracY * after.height - e.clientY;
    }, { passive: false });

    // Click-and-drag panning, only once zoomed in past the fit size.
    var dragging = false;
    var dragStartX = 0, dragStartY = 0, dragScrollLeft = 0, dragScrollTop = 0;
    lightboxImg.addEventListener("mousedown", function (e) {
      if (!lightbox.classList.contains("zoomed")) return;
      dragging = true;
      dragStartX = e.clientX; dragStartY = e.clientY;
      dragScrollLeft = lightbox.scrollLeft; dragScrollTop = lightbox.scrollTop;
      lightboxImg.classList.add("dragging");
      e.preventDefault();
    });
    window.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      lightbox.scrollLeft = dragScrollLeft - (e.clientX - dragStartX);
      lightbox.scrollTop = dragScrollTop - (e.clientY - dragStartY);
    });
    window.addEventListener("mouseup", function () {
      if (!dragging) return;
      dragging = false;
      lightboxImg.classList.remove("dragging");
    });
  }
  if (lightboxClose) lightboxClose.addEventListener("click", closeLightbox);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && lightbox && !lightbox.hidden) closeLightbox();
  });
})();

/* Moments: every GIF and video ticked "Moments" at /media-admin (listed in
   media/moments.txt), in display order (order.txt), as a stack of cards: the
   current one on top, the next couple peeking out below it (cardStack). A video plays
   through once and a GIF plays GIF_PLAYS times (its length is read from the
   file's frame delays); then the top
   card slides out to the left and tucks under the bottom of the stack while
   the rest move up one. The arrows and dots go back and forth by hand.
   Under the stack is the top card's caption from captions.txt (nothing if
   it has none). Videos are muted, with a sound
   button, and play only while the scene is up and the stack is on screen.
   With nothing ticked, the video in index.html stays as it is. One that
   fails to load gets .is-empty, which shows a placeholder. */
(function moments() {
  var DIR = "media/";
  var MOMENT_RE = /\.(gif|mp4|webm|mov|m4v)$/i;
  var GIF_PLAYS = 4;  // a GIF stays on top for this many runs through
  var FALLBACK_MS = 5000; // a GIF whose length can't be read, or a card that failed to load
  var list = document.getElementById("moments-list");
  var first = document.getElementById("video-shell");
  if (!list || !first) return;
  var template = first.cloneNode(true);
  var captionEl = document.getElementById("moments-caption");
  var controls = document.getElementById("moments-controls");
  var dotWrap = document.getElementById("moments-dots");

  var all = [];     // every card, in moments order
  var stack = null; // cardStack, once there are cards
  var dots = [];
  var videos = [];  // the videos on the page; only the top one plays
  var timer = null, inView = true;

  function play(v) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
  function topCard() { return stack ? all[stack.top()] : null; }
  function sceneUp() {
    var sc = list.closest(".scene");
    return !document.documentElement.classList.contains("scenes") || !sc || sc.classList.contains("is-shown");
  }
  // Play the top card's video (or time its GIF) while it can be seen; pause
  // everything else.
  function update() {
    var up = sceneUp() && inView;
    var top = topCard();
    videos.forEach(function (v) { if (up && (!top || top.video === v)) play(v); else v.pause(); });
    clearTimeout(timer);
    if (!up || !top || all.length < 2) return;
    var failed = top.el.querySelector(".is-empty");
    if (failed || !top.video) timer = setTimeout(function () { stack.go(1); }, failed ? FALLBACK_MS : top.ms || FALLBACK_MS);
  }
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (entries) {
      inView = entries[entries.length - 1].isIntersecting;
      update();
    }, { threshold: 0.25 }).observe(list);
  }
  document.addEventListener("scenechange", update);

  function wireVideo(shell, v) {
    function empty() { shell.classList.add("is-empty"); v.removeAttribute("controls"); }
    v.addEventListener("error", empty);
    // Only a real error counts: networkState reads NO_SOURCE for a moment
    // before the browser starts loading, which used to hide a working video.
    if (v.error) empty();
    v.addEventListener("loadeddata", function () {
      shell.classList.remove("is-empty");
      if (!stack || topCard().video === v) v.setAttribute("controls", "");
    });
    videos.push(v);

    // It plays muted (browsers only autoplay silent video); this button turns
    // the sound on and off, and follows the player's own mute control too.
    var sound = shell.querySelector(".sound");
    if (!sound) return;
    function label() {
      var on = !v.muted && v.volume > 0;
      sound.setAttribute("aria-pressed", on ? "true" : "false");
      sound.querySelector("span").textContent = on ? "Sound on" : "Tap for sound";
    }
    sound.addEventListener("click", function () {
      v.muted = !v.muted;
      if (!v.muted && !v.volume) v.volume = 1;
      if (!v.muted && v.paused) play(v);
      label();
    });
    v.addEventListener("volumechange", label);
    label();
  }
  wireVideo(first, first.querySelector("video"));
  update();

  // One card: a copy of the shell in index.html, with an <img> in place of
  // the player for a GIF.
  function build(name, caption) {
    var el = document.createElement("div");
    el.className = "moment stack-card";
    var shell = template.cloneNode(true);
    shell.removeAttribute("id");
    Array.prototype.forEach.call(shell.querySelectorAll("[id]"), function (n) { n.removeAttribute("id"); });
    var v = shell.querySelector("video");
    var src = DIR + encodeURIComponent(name);
    el.appendChild(shell);
    var card = { el: el, caption: caption, video: null };
    if (/\.gif$/i.test(name)) {
      var img = document.createElement("img");
      img.alt = caption || "Scout";
      img.addEventListener("error", function () { shell.classList.add("is-empty"); if (topCard() === card) update(); });
      whenNear(list, function () {
        img.src = src;
        gifLength(src).then(function (ms) { if (ms) card.ms = ms * GIF_PLAYS; });
      });
      shell.replaceChild(img, v);
      var sound = shell.querySelector(".sound");
      if (sound) shell.removeChild(sound);
    } else {
      v.removeAttribute("controls");
      // (index.html's video has preload="none", so the page never fetches it
      // unless nothing is ticked; the cards show their first frame.)
      whenNear(list, function () { v.preload = "metadata"; v.src = src; });
      card.video = v;
      wireVideo(shell, v);
      v.addEventListener("error", function () { if (topCard() === card) update(); });
      // With more than one, a video plays once and then the stack moves on.
      v.addEventListener("ended", function () { if (topCard() === card) stack.go(1); });
    }
    return card;
  }

  // Card i has come to the top: only its video has controls (and loops, if
  // it's the only one), the caption and dots follow it, and it starts over.
  function show(i) {
    var top = all[i];
    all.forEach(function (card) {
      if (!card.video) return;
      card.video.loop = all.length === 1;
      if (card === top && !card.el.querySelector(".is-empty")) card.video.setAttribute("controls", "");
      else { card.video.removeAttribute("controls"); card.video.pause(); }
    });
    if (captionEl) captionEl.textContent = top.caption || "";
    dots.forEach(function (d, j) { d.setAttribute("aria-current", j === i ? "true" : "false"); });
    if (dots.length) windowDots(dotWrap, dots, i);
    if (top.video) { try { top.video.currentTime = 0; } catch (e) {} }
    if (stack) update(); // the first call comes from cardStack itself, before stack is set
  }

  function fetchLines(name) {
    return fetch(DIR + name, { cache: "no-cache" })
      .then(function (r) { return r.ok ? r.text() : ""; }, function () { return ""; })
      .then(function (t) { return t.split("\n").map(function (l) { return l.trim(); }).filter(Boolean); });
  }
  Promise.all([fetchLines("moments.txt"), fetchLines("order.txt"), fetchLines("captions.txt"),
    fetch(DIR, { cache: "no-cache" }).then(function (r) { return r.ok ? r.text() : ""; }, function () { return ""; })])
    .then(function (r) {
      // Only files that are really there (the listing) and are GIFs or videos.
      var present = {}, dup = {}, captions = {};
      Array.prototype.forEach.call(new DOMParser().parseFromString(r[3], "text/html").querySelectorAll("a"), function (a) {
        var f = a.getAttribute("href");
        if (f) present[decodeURIComponent(f.split("/").pop())] = true;
      });
      var names = r[0].filter(function (f) { return MOMENT_RE.test(f) && present[f] && !dup[f] && (dup[f] = true); });
      if (!names.length) return;
      var order = r[1];
      names.sort(function (a, b) {
        var i = order.indexOf(a), j = order.indexOf(b);
        if (i < 0) i = Infinity;
        if (j < 0) j = Infinity;
        return i !== j ? i - j : a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
      });
      r[2].forEach(function (l) {
        var k = l.indexOf("=");
        if (k > 0) captions[l.slice(0, k)] = l.slice(k + 1).trim();
      });

      // Swap the page's own video for the stack.
      videos.forEach(function (v) { v.pause(); });
      videos = [];
      while (list.firstChild) list.removeChild(list.firstChild);
      list.classList.add("moments-stack", "card-stack");
      all = names.map(function (name) { return build(name, captions[name]); });
      // Bottom of the stack first, so the top card is last in the DOM too.
      all.slice().reverse().forEach(function (c) { list.appendChild(c.el); });

      if (all.length > 1 && controls && dotWrap) {
        all.forEach(function (card, i) {
          var b = document.createElement("button");
          b.type = "button";
          b.setAttribute("aria-label", "Moment " + (i + 1) + " of " + all.length);
          b.appendChild(document.createElement("i"));
          b.addEventListener("click", function () { stack.goTo(i); });
          dotWrap.appendChild(b);
          dots.push(b);
        });
        document.getElementById("moments-prev").addEventListener("click", function () { stack.go(-1); });
        document.getElementById("moments-next").addEventListener("click", function () { stack.go(1); });
        controls.hidden = false;
      }
      stack = cardStack(all.map(function (c) { return c.el; }), show);
      update();
    });
})();

/* The intro photo and the catch video are named in media/page_files.txt
   ("intro=<file>", "catch=<file>"), which /media-admin updates when either
   is renamed, or when another title page photo is picked there. index.html
   carries the names they had when it was written; when the file names
   another, this swaps it in. The intro photo stays hidden (.is-ready, in
   style.css) until that's settled, so the old one never flashes up first.
   (Once Moments, above, has built its list, #frisbee is gone.) */
(function pageFiles() {
  var hero = document.querySelector("#top .frame img");
  var v = document.getElementById("frisbee");
  var shell = document.getElementById("video-shell");
  function showHero() { if (hero) hero.classList.add("is-ready"); }
  setTimeout(showHero, 3000); // whatever happens, never leave it hidden
  function differs(el, name) {
    var src = el.getAttribute("src");
    return src !== "media/" + name && src !== "media/" + encodeURIComponent(name);
  }
  fetch("media/page_files.txt", { cache: "no-cache" })
    .then(function (r) { return r.ok ? r.text() : ""; })
    .then(function (t) {
      var names = {};
      t.split("\n").forEach(function (l) {
        var m = /^\s*(\w+)\s*=\s*(.+?)\s*$/.exec(l);
        if (m) names[m[1]] = m[2];
      });
      if (hero && names.intro && differs(hero, names.intro)) {
        hero.addEventListener("load", showHero);
        hero.addEventListener("error", showHero);
        hero.src = "media/" + encodeURIComponent(names.intro);
      } else showHero();
      if (v && shell && document.contains(v) && names["catch"] && differs(v, names["catch"])) {
        shell.classList.remove("is-empty");
        v.setAttribute("controls", "");
        v.src = "media/" + encodeURIComponent(names["catch"]);
        if (v.closest(".scene.is-active")) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
      }
    })
    .catch(showHero);
})();

/* The Memorial section's text lives in media/memorial.txt (edited at
   /media-admin), paragraphs separated by blank lines. index.html holds a copy
   as the fallback; this replaces it when the file says something different.
   Always set as text, never HTML. */
(function memorialText() {
  var section = document.getElementById("dedication");
  if (!section) return;
  fetch("media/memorial.txt", { cache: "no-cache" })
    .then(function (r) { return r.ok ? r.text() : ""; })
    .then(function (t) {
      var paras = t.replace(/\r\n?/g, "\n").split(/\n\s*\n/)
        .map(function (p) { return p.trim(); }).filter(Boolean);
      if (!paras.length) return;
      var now = Array.prototype.map.call(section.querySelectorAll("p"), function (p) { return p.textContent.trim(); });
      if (now.join("\n\n") === paras.join("\n\n")) return;
      section.textContent = "";
      paras.forEach(function (text) {
        var p = document.createElement("p");
        p.textContent = text;
        section.appendChild(p);
      });
    })
    .catch(function () {});
})();

/* Messages: visitors leave a note for Scout, a photo, or both. New ones are
   held until approved at /messages-admin (server/messages.js), so the form
   only says thanks; the list shows already-approved ones, newest first.
   A photo is shrunk here before it's sent (at most PHOTO_MAX px a side,
   re-saved as a JPEG, which also drops its location data); a GIF goes as
   it is, so it still moves. */
(function messages() {
  var form = document.getElementById("message-form");
  var list = document.getElementById("message-list");
  var status = document.getElementById("message-status");
  if (!form || !list) return;
  var API = "/api/messages";
  var PHOTO_MAX = 2400;           // px, longest side
  var GIF_MAX = 8 * 1024 * 1024;  // bytes, as in server/messages.js
  var picker = document.getElementById("message-photo");
  var preview = document.getElementById("photo-preview");
  var photo = null; // the photo to send, as a data: URL

  fetch(API)
    .then(function (r) { return r.ok ? r.json() : []; })
    .then(function (items) {
      items.forEach(function (m) {
        var div = document.createElement("div");
        div.className = "msg";
        if (m.text) {
          var p = document.createElement("p");
          p.textContent = m.text;
          div.appendChild(p);
        }
        if (m.photo) {
          var a = document.createElement("a");
          a.className = "msg-photo";
          a.href = m.photo;
          a.target = "_blank";
          var img = document.createElement("img");
          whenNear(list, function () { img.src = m.photo; });
          img.alt = "A photo of Scout, shared by a visitor";
          img.loading = "lazy";
          a.appendChild(img);
          div.appendChild(a);
        }
        var t = document.createElement("time");
        t.dateTime = m.createdAt;
        t.textContent = new Date(m.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
        div.appendChild(t);
        list.appendChild(div);
      });
    })
    .catch(function () {});

  // The picked photo, ready to send: a GIF as it is, anything else drawn
  // onto a canvas no bigger than PHOTO_MAX and saved as a JPEG.
  function readPhoto(file) {
    return new Promise(function (resolve, reject) {
      if (/^image\/gif$/i.test(file.type)) {
        if (file.size > GIF_MAX) return reject(new Error("That GIF is too big (8 MB max)."));
        var fr = new FileReader();
        fr.onload = function () { resolve(fr.result); };
        fr.onerror = function () { reject(new Error("")); };
        return fr.readAsDataURL(file);
      }
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, PHOTO_MAX / Math.max(img.naturalWidth, img.naturalHeight));
        var c = document.createElement("canvas");
        c.width = Math.round(img.naturalWidth * scale);
        c.height = Math.round(img.naturalHeight * scale);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL("image/jpeg", 0.86));
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("")); };
      img.src = url;
    });
  }
  function clearPhoto() {
    photo = null;
    if (picker) picker.value = "";
    if (preview) { preview.hidden = true; preview.querySelector("img").removeAttribute("src"); }
  }
  if (picker && preview) {
    picker.addEventListener("change", function () {
      var file = picker.files && picker.files[0];
      if (!file) return clearPhoto();
      status.textContent = "Getting the photo ready…";
      readPhoto(file).then(function (data) {
        photo = data;
        preview.querySelector("img").src = data;
        preview.hidden = false;
        status.textContent = "";
      }, function (err) {
        clearPhoto();
        status.textContent = err.message || "That photo couldn’t be opened. Please try a JPEG or PNG.";
      });
    });
    document.getElementById("photo-remove").addEventListener("click", clearPhoto);
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var button = form.querySelector("button[type=submit]");
    var text = form.elements.text.value.trim();
    if (!text && !photo) { status.textContent = "Please write a message or add a photo."; return; }
    button.disabled = true;
    status.textContent = "Sending…";
    var body = { text: text, website: form.elements.website.value };
    if (photo) body.photo = photo;
    fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (b) {
          if (!r.ok) throw new Error(b.error || (r.status === 413 ? "That photo is too big. Please try a smaller one." : ""));
        });
      })
      .then(function () {
        form.reset();
        clearPhoto();
        status.textContent = "Thank you. It will appear here once it’s been approved.";
      })
      .catch(function (err) {
        status.textContent = err.message || "Sorry, that didn’t send. Please try again in a moment.";
      })
      .then(function () { button.disabled = false; });
  });
})();
