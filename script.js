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
  if (list.length < 2) return document.documentElement.classList.remove("is-loading");

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
  // The lightbox or an open memory (#memory-view) has the input instead.
  var memoryView = document.getElementById("memory-view");
  function busy() { return lightbox && !lightbox.hidden || memoryView && !memoryView.hidden; }

  function setShift(el, px) { el.style.setProperty("--shift", px + "px"); }

  // The docked .sidenav's width as --nav-w, which style.css keeps the
  // sections' content clear of: it wraps to a second column on a short
  // screen, so it isn't a fixed size.
  function measureNav() {
    if (sidenav) document.documentElement.style.setProperty("--nav-w", sidenav.offsetWidth + "px");
  }
  measureNav();
  window.addEventListener("resize", measureNav);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(measureNav); // Karla changes its size
  // The nav links to the scene on screen are marked (aria-current), however
  // it was reached.
  var navLinks = Array.prototype.slice.call(document.querySelectorAll(".sidenav a, .topnav a"));
  function markNav(scene) {
    var href = "#" + (scene.getAttribute("data-anchor") || scene.id);
    navLinks.forEach(function (a) {
      if (a.getAttribute("href") === href) a.setAttribute("aria-current", "location");
      else a.removeAttribute("aria-current");
    });
  }

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
    markNav(to);

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
  document.documentElement.classList.remove("is-loading"); // see index.html

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

function play(v) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
// A video plays muted (browsers only autoplay silent video); this button
// turns the sound on and off, and follows the player's own mute control too.
function soundButton(v) {
  var b = document.createElement("button");
  b.type = "button";
  b.className = "sound";
  b.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 6v4h2.5l3.5 3V3L5 6H2.5Z" fill="currentColor"/><path class="waves" d="M10.6 5.6a3.4 3.4 0 0 1 0 4.8M12.4 3.8a6 6 0 0 1 0 8.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path class="cross" d="m10.5 6 3.5 4m0-4-3.5 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg><span></span>';
  function label() {
    var on = !v.muted && v.volume > 0;
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.querySelector("span").textContent = on ? "Sound on" : "Tap for sound";
  }
  b.addEventListener("click", function () {
    v.muted = !v.muted;
    if (!v.muted && !v.volume) v.volume = 1;
    label();
  });
  v.addEventListener("volumechange", label);
  label();
  return b;
}

(function slideshow() {
  var DIR = "media/";
  var AUTOPLAY_MS = 5000; // default; media/settings.txt's slide_seconds overrides it

  var IMAGE_RE = /\.(jpe?g|png|gif|webp|avif)$/i;
  var VIDEO_RE = /\.(mp4|webm|mov|m4v)$/i;
  var GIF_PLAYS = 4;      // a GIF stays on top for this many runs through
  var FALLBACK_MS = 5000; // a card that failed to load

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
  window.scoutLightbox = openLightbox; // for the Memorial's photos

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

  // slideshow.txt is what's in Moments; moments.txt is the old list of its
  // GIFs and videos, from before Moments and the slideshow were one (the
  // media manager merges it into slideshow.txt).
  var notInGallery = {}, inSlideshow = {}, order = [], captions = {};
  Promise.all([fetchLines("not_in_gallery.txt"), fetchLines("slideshow.txt"), fetchLines("order.txt"), fetchLines("captions.txt"), fetchLines("settings.txt"), fetchLines("moments.txt")])
    .then(function (lists) {
      notInGallery = toSet(lists[0]);
      inSlideshow = toSet(lists[1].concat(lists[5]));
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
      start(files.filter(function (f) { return inSlideshow[f]; }));
    })
    .catch(function (err) {
      console.error("slideshow: could not read " + DIR, err);
      stage.innerHTML = '<div class="ss-empty">Couldn’t load these right now.</div>';
      if (grid) grid.innerHTML = '<div class="ss-empty">Couldn’t load the photos right now.</div>';
    });

  // Moments: the photos, GIFs and videos as a stack of cards (cardStack):
  // the top one showing, the next couple peeking out below, and each one
  // sliding out left and under as the next comes up. A photo stays on top
  // for AUTOPLAY_MS, a GIF for GIF_PLAYS runs through, a video until it has
  // played (muted, with a sound button; only the top one plays).
  function start(files) {
    items = files.map(function (f) {
      return { file: f, caption: captions[f] || "", kind: VIDEO_RE.test(f) ? "video" : /\.gif$/i.test(f) ? "gif" : "photo" };
    });
    if (!items.length) {
      stage.innerHTML = '<div class="ss-empty">Nothing here yet.</div>';
      return;
    }
    var cards = items.map(function (item, i) {
      var card = document.createElement("div");
      card.className = "stack-card ss-card";
      var src = DIR + encodeURIComponent(item.file);
      function failed() {
        item.failed = true;
        card.classList.add("is-empty");
        if (stack && stack.top() === i) tick();
      }
      if (item.kind === "video") {
        var v = document.createElement("video");
        v.muted = true;
        v.playsInline = true;
        v.preload = "none";
        // The top few as you come near; the rest once you're on Moments.
        whenNear(stage, function () { v.preload = "metadata"; v.src = src; }, i < STACK_DEPTH ? 1 : 0);
        v.addEventListener("error", failed);
        v.addEventListener("ended", function () { if (stack && stack.top() === i) next(); });
        // The progress bar follows the video.
        v.addEventListener("timeupdate", function () {
          if (stack && stack.top() === i && v.duration) bar.style.width = (v.currentTime / v.duration * 100) + "%";
        });
        item.video = v;
        card.appendChild(v);
        card.appendChild(soundButton(v));
      } else {
        var el = document.createElement("img");
        whenNear(stage, function () {
          el.src = src;
          if (item.kind === "gif") gifLength(src).then(function (ms) { if (ms) item.ms = ms * GIF_PLAYS; });
        }, i < STACK_DEPTH ? 1 : 0);
        el.alt = item.caption || "Scout";
        el.loading = i < STACK_DEPTH ? "eager" : "lazy";
        el.addEventListener("error", failed);
        el.addEventListener("click", function () { openLightbox(el.src, false, item.caption); });
        card.appendChild(el);
      }
      var oops = document.createElement("div");
      oops.className = "ss-missing";
      oops.textContent = "Oops, this one didn’t load.";
      card.appendChild(oops);

      var b = document.createElement("button");
      b.type = "button";
      b.setAttribute("aria-label", "Moment " + (i + 1));
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

    // (Over a video the mouse doesn't pause it; its own controls do.)
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
      if (tag === "TEXTAREA" || tag === "INPUT" || !sceneShown()) return; // typing a message, or elsewhere
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

  // Card i has come to the top of the stack: only its video has controls
  // (and loops, if it's the only card).
  function show(i) {
    current = i;
    items.forEach(function (item, j) {
      if (!item.video) return;
      item.video.loop = items.length === 1;
      if (j === i) item.video.setAttribute("controls", "");
      else item.video.removeAttribute("controls");
    });
    dots.forEach(function (d, j) { d.setAttribute("aria-current", j === current ? "true" : "false"); });
    windowDots(dotWrap, dots, current);
    if (counter) counter.textContent = pad(current + 1) + " / " + pad(items.length);
    if (captionEl) captionEl.textContent = items[current].caption;
  }

  function pad(n) { return n < 10 ? "0" + n : String(n); }

  // Start the top card's time over: the progress bar runs for a photo's or
  // GIF's time, or follows a video (which starts from the beginning).
  function tick() {
    var item = items[current];
    bar.style.animation = "none";
    bar.style.width = "0";
    var on = items.length > 1;
    bar.parentNode.hidden = !on;
    if (item.video && !item.failed) { try { item.video.currentTime = 0; } catch (e) {} }
    if (on && !(item.video && !item.failed)) {
      void bar.offsetWidth;
      bar.style.width = "";
      bar.style.animation = "ss-fill " + (item.failed ? FALLBACK_MS : item.ms || AUTOPLAY_MS) + "ms linear forwards";
    }
    setPaused();
  }
  // Paused while the mouse is over a photo, the lightbox is open, or Moments
  // isn't the section on screen (see scenes: .is-shown). The top video plays
  // unless the lightbox is open or Moments isn't on screen.
  function sceneShown() {
    var sc = stage.closest(".scene");
    return !document.documentElement.classList.contains("scenes") || !sc || sc.classList.contains("is-shown");
  }
  function setPaused() {
    var hold = !sceneShown() || (lightbox && !lightbox.hidden);
    bar.style.animationPlayState = paused || hold ? "paused" : "running";
    items.forEach(function (item, j) {
      if (!item.video) return;
      if (j === current && !hold && !item.failed) play(item.video);
      else item.video.pause();
    });
  }
  // Arriving at Moments starts the card on top over, with its full time.
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

/* The intro photo is named in media/page_files.txt ("intro=<file>"), which
   /media-admin updates when it's renamed, or when another title page photo
   is picked there. index.html carries the name it had when it was written;
   when the file names another, this swaps it in. The photo stays hidden
   (.is-ready, in style.css) until that's settled, so the old one never
   flashes up first. */
(function pageFiles() {
  var hero = document.querySelector("#top .frame img");
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
    })
    .catch(showHero);
})();

/* The Memorial section's text lives in media/memorial.txt (edited at
   /media-admin), paragraphs separated by blank lines, with **bold**,
   *italic*, "# " headings and (caption[photo.jpg]) photos; memorial.js
   turns it into DOM nodes (never HTML). #dedication is empty in
   index.html. Its photos load once the Memorial is near, open in the
   lightbox when clicked, and are left out if the file is gone. */
(function memorialText() {
  var section = document.getElementById("dedication");
  if (!section || typeof renderMemorial !== "function") return;
  fetch("media/memorial.txt", { cache: "no-cache" })
    .then(function (r) { return r.ok ? r.text() : ""; })
    .then(function (t) {
      if (!memorialBlocks(t).length) return;
      renderMemorial(t, section, {
        dir: "media/",
        setSrc: function (img, url) { whenNear(img, function () { img.src = url; }); },
        onPhoto: function (fig, url, caption) {
          fig.querySelector("img").addEventListener("click", function () {
            if (window.scoutLightbox) window.scoutLightbox(url, false, caption);
          });
        }
      });
    })
    .catch(function () {});
})();

/* Memories: little stories from media/memories.json ([{ title, text,
   photos }], edited at /media-admin; photos are files in media/ (photos,
   GIFs or videos), the first the main one; older entries have a single
   "photo" instead), as a grid of cards, each its main picture and title
   (or the start of its story, with none). A GIF or video as the main
   picture shows as a still (still()), a frame a third of the way in (a
   GIF's first frame where the browser has no ImageDecoder), badged, with a count when there are more.
   Tapping one opens it in #memory-view: its pictures, title and whole
   story, with Previous / Next (and the arrow keys) to go through the
   memories; Esc, the × or a tap outside closes it. More than one picture
   plays as a slideshow (show()): a photo for slide_seconds
   (media/settings.txt, as in Moments), a GIF for GIF_PLAYS runs, a video
   until it ends (muted, with a sound button), with arrows, dots and a
   progress bar; a swipe on the pictures moves through them. The story is
   paragraphs (blank lines) with **bold** and *italic* (memorialInline,
   memorial.js), always as text, never HTML. */
(function memories() {
  var DIR = "media/", VIDEO_RE = /\.(mp4|webm|mov|m4v)$/i, GIF_RE = /\.gif$/i;
  var SLIDE_MS = 5000, GIF_PLAYS = 2, FALLBACK_MS = 5000;
  var grid = document.getElementById("memory-grid"), view = document.getElementById("memory-view");
  if (!grid || !view) return;
  var photoBox = document.getElementById("mv-photo"), titleEl = document.getElementById("mv-title");
  var textEl = document.getElementById("mv-text"), countEl = document.getElementById("mv-count");
  var prevBtn = document.getElementById("mv-prev"), nextBtn = document.getElementById("mv-next"), closeBtn = document.getElementById("mv-close");
  var list = [], current = 0, opener = null;
  var slides = [], at = 0, timer = null, bar = null, dots = [], dotWrap = null;
  var plain = function (t) { return String(t || "").replace(/\*+/g, "").replace(/\s+/g, " ").trim(); };
  function kind(f) { return VIDEO_RE.test(f) ? "video" : GIF_RE.test(f) ? "gif" : "photo"; }
  function url(f) { return DIR + encodeURIComponent(f); }
  function photosOf(m) {
    var p = Array.isArray(m.photos) ? m.photos : m.photo ? [m.photo] : [];
    return p.filter(function (f) { return typeof f === "string" && f; });
  }

  fetch(DIR + "settings.txt", { cache: "no-cache" })
    .then(function (r) { return r.ok ? r.text() : ""; }, function () { return ""; })
    .then(function (t) {
      var m = /^\s*slide_seconds\s*=\s*(\d+(?:\.\d+)?)\s*$/m.exec(t);
      if (m && +m[1] > 0) SLIDE_MS = Math.round(+m[1] * 1000);
    });

  // A still of a GIF (on a canvas) or a video for its card, a frame a third
  // of the way in.
  function still(f, box) {
    if (kind(f) === "video") {
      var v = document.createElement("video");
      v.muted = true;
      v.playsInline = true;
      v.preload = "metadata";
      v.tabIndex = -1;
      v.setAttribute("aria-hidden", "true");
      v.addEventListener("loadedmetadata", function () {
        if (isFinite(v.duration) && v.duration > 0) v.currentTime = v.duration / 3;
      });
      whenNear(grid, function () { v.src = url(f) + "#t=0.5"; }); // #t= so iOS shows a frame
      box.appendChild(v);
      return;
    }
    var c = document.createElement("canvas");
    function draw(pic, w, h) {
      c.width = w;
      c.height = h;
      c.getContext("2d").drawImage(pic, 0, 0);
      box.insertBefore(c, box.firstChild);
    }
    // The first frame, from an <img> (drawImage takes a GIF's first frame).
    function first(src) {
      var img = new Image();
      img.onload = function () {
        try { draw(img, img.naturalWidth, img.naturalHeight); }
        catch (e) { img.alt = ""; box.insertBefore(img, box.firstChild); }
      };
      img.src = src;
    }
    whenNear(grid, function () {
      if (!window.ImageDecoder) return first(url(f));
      // Where the browser can decode a chosen frame, one a third of the way in.
      fetch(url(f)).then(function (r) { return r.ok ? r.arrayBuffer() : Promise.reject(); }).then(function (buf) {
        var d = new ImageDecoder({ data: buf, type: "image/gif" });
        return d.tracks.ready.then(function () {
          return d.decode({ frameIndex: Math.floor(d.tracks.selectedTrack.frameCount / 3) });
        }).then(function (res) {
          draw(res.image, res.image.displayWidth, res.image.displayHeight);
          res.image.close();
          d.close();
        });
      }).catch(function () { if (!c.parentNode) first(url(f)); });
    });
  }
  function badge(cls, text) {
    var s = document.createElement("span");
    s.className = cls;
    s.setAttribute("aria-hidden", "true");
    if (text) s.textContent = text;
    return s;
  }

  fetch(DIR + "memories.json", { cache: "no-cache" })
    .then(function (r) { return r.ok ? r.json() : []; })
    .catch(function () { return []; })
    .then(function (data) {
      list = (Array.isArray(data) ? data : []).filter(function (m) { return m && (m.title || m.text || photosOf(m).length); });
      if (!list.length) {
        var none = document.createElement("p");
        none.className = "memory-empty";
        none.textContent = "Memories of Scout will be shared here soon.";
        grid.appendChild(none);
        return;
      }
      list.forEach(function (m, i) {
        var files = photosOf(m), main = files[0];
        var b = document.createElement("button");
        b.type = "button";
        b.className = "memory-card" + (main ? "" : " no-photo");
        if (main) {
          var ph = document.createElement("span");
          ph.className = "memory-card-photo";
          if (kind(main) === "photo") {
            var img = document.createElement("img");
            img.alt = "";
            whenNear(grid, function () { img.src = url(main); });
            ph.appendChild(img);
          } else still(main, ph);
          if (kind(main) === "video") ph.appendChild(badge("play"));
          else if (kind(main) === "gif") ph.appendChild(badge("memory-card-gif", "GIF"));
          if (files.length > 1) {
            var count = badge("memory-card-count");
            count.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="4.5" y="1.5" width="10" height="10" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M1.5 4.5v8.5a1.5 1.5 0 0 0 1.5 1.5h8.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
            count.appendChild(document.createTextNode(files.length));
            ph.appendChild(count);
          }
          b.appendChild(ph);
        }
        var t = document.createElement("span");
        t.className = "memory-card-title";
        t.textContent = m.title || "A memory";
        b.appendChild(t);
        if (!main && m.text) {
          var ex = document.createElement("span");
          ex.className = "memory-card-text";
          var words = plain(m.text);
          ex.textContent = words.length > 140 ? words.slice(0, 140).replace(/\s+\S*$/, "") + "…" : words;
          b.appendChild(ex);
        }
        if (files.length > 1) b.setAttribute("aria-label", (m.title || "A memory") + ", " + files.length + " pictures");
        b.addEventListener("click", function () { opener = b; open(i); });
        grid.appendChild(b);
      });
    });

  // The memory's pictures: one on its own, or a slideshow of them.
  function stopSlides() {
    clearTimeout(timer);
    timer = null;
    slides.forEach(function (s) { if (s.kind === "video") s.el.pause(); });
  }
  function arrow(label, path, dir) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "ss-arrow";
    b.setAttribute("aria-label", label);
    b.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="' + path + '" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    b.addEventListener("click", function () { show(at + dir); });
    return b;
  }
  function buildPictures(files, alt) {
    stopSlides();
    photoBox.textContent = "";
    photoBox.hidden = !files.length;
    photoBox.classList.toggle("is-slides", files.length > 1);
    var stage = document.createElement("div");
    stage.className = "mv-stage";
    photoBox.appendChild(stage);
    slides = files.map(function (f) {
      var s = { kind: kind(f), ms: SLIDE_MS, failed: false };
      s.slide = document.createElement("div");
      s.slide.className = "mv-slide";
      var fail = function () {
        s.failed = true;
        s.slide.classList.add("is-missing");
        if (slides[at] === s && slides.length > 1 && !view.hidden) { clearTimeout(timer); timer = setTimeout(function () { show(at + 1); }, FALLBACK_MS); }
      };
      if (s.kind === "video") {
        s.el = document.createElement("video");
        s.el.muted = true;
        s.el.playsInline = true;
        s.el.controls = true;
        s.el.preload = "metadata";
        s.el.addEventListener("error", fail);
        s.el.addEventListener("ended", function () { if (slides[at] === s && slides.length > 1) show(at + 1); });
        s.el.addEventListener("timeupdate", function () {
          if (slides[at] === s && bar && s.el.duration) bar.style.width = (100 * s.el.currentTime / s.el.duration) + "%";
        });
        s.el.src = url(f);
        s.slide.appendChild(s.el);
        s.slide.appendChild(soundButton(s.el));
      } else {
        s.el = document.createElement("img");
        s.el.alt = alt;
        s.el.onerror = fail;
        s.el.src = url(f);
        if (s.kind === "gif") gifLength(url(f)).then(function (ms) { if (ms) s.ms = Math.max(ms * GIF_PLAYS, 2000); });
        s.slide.appendChild(s.el);
      }
      var oops = document.createElement("div");
      oops.className = "ss-missing";
      oops.textContent = "Oops, this one didn’t load.";
      s.slide.appendChild(oops);
      stage.appendChild(s.slide);
      return s;
    });
    dots = [];
    bar = null;
    if (slides.length < 2) return;
    var progress = document.createElement("div");
    progress.className = "ss-progress";
    progress.setAttribute("aria-hidden", "true");
    bar = document.createElement("i");
    progress.appendChild(bar);
    stage.appendChild(progress);
    var strip = document.createElement("div");
    strip.className = "mv-strip";
    dotWrap = document.createElement("div");
    dotWrap.className = "ss-dots";
    slides.forEach(function (s, j) {
      var d = document.createElement("button");
      d.type = "button";
      d.setAttribute("aria-label", "Picture " + (j + 1));
      d.appendChild(document.createElement("i"));
      d.addEventListener("click", function () { show(j); });
      dotWrap.appendChild(d);
      dots.push(d);
    });
    strip.appendChild(arrow("Previous picture", "M10 2.5 4.5 8l5.5 5.5", -1));
    strip.appendChild(dotWrap);
    strip.appendChild(arrow("Next picture", "M6 2.5 11.5 8 6 13.5", 1));
    photoBox.appendChild(strip);
  }
  // Picture i on top, and its time (or its video) started.
  function show(i) {
    var n = slides.length;
    if (!n) return;
    at = (i + n) % n;
    clearTimeout(timer);
    slides.forEach(function (s, j) {
      s.slide.classList.toggle("is-on", j === at);
      if (s.kind === "video" && j !== at) s.el.pause();
    });
    dots.forEach(function (d, j) { d.setAttribute("aria-current", j === at ? "true" : "false"); });
    if (dotWrap && dots.length) windowDots(dotWrap, dots, at);
    var s = slides[at];
    if (n < 2) {
      if (s.kind === "video") { s.el.loop = true; play(s.el); }
      return;
    }
    bar.style.transition = "none";
    bar.style.width = "0";
    if (s.kind === "video" && !s.failed) {
      s.el.currentTime = 0;
      play(s.el);
      void bar.offsetWidth;
      bar.style.transition = "";
      return;
    }
    var ms = s.failed ? FALLBACK_MS : s.ms;
    void bar.offsetWidth;
    bar.style.transition = "width " + ms + "ms linear";
    bar.style.width = "100%";
    timer = setTimeout(function () { show(at + 1); }, ms);
  }

  function open(i) {
    current = (i + list.length) % list.length;
    var m = list[current];
    buildPictures(photosOf(m), m.title || "Scout");
    titleEl.textContent = m.title || "";
    titleEl.hidden = !m.title;
    textEl.textContent = "";
    String(m.text || "").split(/\n\s*\n/).forEach(function (p) {
      if (!p.trim()) return;
      var el = document.createElement("p");
      memorialInline(p.trim(), el);
      textEl.appendChild(el);
    });
    countEl.textContent = list.length > 1 ? (current + 1) + " of " + list.length : "";
    prevBtn.hidden = nextBtn.hidden = list.length < 2;
    var wasHidden = view.hidden;
    view.hidden = false;
    view.querySelector(".mv-card").scrollTop = 0;
    show(0);
    if (wasHidden) closeBtn.focus();
  }
  function shut() {
    stopSlides();
    view.hidden = true;
    if (opener) opener.focus();
  }
  closeBtn.addEventListener("click", shut);
  prevBtn.addEventListener("click", function () { open(current - 1); });
  nextBtn.addEventListener("click", function () { open(current + 1); });
  view.addEventListener("click", function (e) { if (e.target === view) shut(); });
  document.addEventListener("keydown", function (e) {
    if (view.hidden) return;
    if (e.key === "Escape") shut();
    else if (e.key === "ArrowLeft") open(current - 1);
    else if (e.key === "ArrowRight") open(current + 1);
  });
  // A swipe left or right goes to the next or previous memory, or, on a
  // slideshow's pictures, picture.
  var touchX = null, onPictures = false;
  view.addEventListener("touchstart", function (e) {
    touchX = e.touches[0].clientX;
    onPictures = slides.length > 1 && photoBox.contains(e.target);
  }, { passive: true });
  view.addEventListener("touchend", function (e) {
    if (touchX === null) return;
    var dx = e.changedTouches[0].clientX - touchX;
    touchX = null;
    if (Math.abs(dx) <= 60) return;
    if (onPictures) show(at + (dx < 0 ? 1 : -1));
    else if (list.length > 1) open(current + (dx < 0 ? 1 : -1));
  });
})();

/* A little Scout along the bottom of the screen, chasing a frisbee. How far
   across he is follows how far through the page you are: each section is
   a stretch of the way, and scrolling down inside one moves him along it,
   so he gets to the next section's spot as you get there. On the last
   section (Messages) he leaps and catches it, and keeps it in his mouth,
   tail wagging, until he's run all the way back to the start (or the
   page is reloaded). He runs while he's moving, keeps facing the way he
   last went (the frisbee ahead of him), and otherwise stands wagging.
   The bottom of each section fades out (.runway) to make room for him.
   Only with the
   scenes; drawn in SVG, sized and animated in style.css (.runner). */
(function scoutRun() {
  var RUN_MS = 1200; // as long as .runner-go's transition in style.css
  var scenes = Array.prototype.slice.call(document.querySelectorAll(".scene"));
  if (scenes.length < 2 || !document.documentElement.classList.contains("scenes")) return;
  var sidenav = document.getElementById("sidenav"), dots = document.querySelector(".scene-dots");
  var runner = document.createElement("div");
  runner.className = "runner";
  runner.setAttribute("aria-hidden", "true");
  // Drawn from his photos: red-gold, with a cream chest, feathering and
  // plume of a tail held high, darker ears, a whitish chin, his neon
  // yellow collar and teal and red tags; .disc is his favourite frisbee
  // (neon yellow) in his mouth once caught.
  runner.innerHTML = '<div class="runner-go"><svg class="runner-dog" viewBox="0 0 70 42" width="70" height="42">' +
    '<g class="dog">' +
    '<g class="tail"><path d="M17.5 17.5C13 14 10.5 9 10.8 2.5 7.5 5 6 9.5 6.6 13.5 4.6 12.6 2.6 12.8 1.4 14c2 3 5.2 5 8.8 5.6-2 .8-3.2 2-3.6 3.2 4 .9 8.2-.4 11.2-2.6z" fill="#E6BD84"/>' +
    '<path d="M17.5 18.5C13.5 15 11.6 10 11.6 4.5" stroke="#C98445" stroke-width="3.4" stroke-linecap="round" fill="none"/></g>' +
    '<rect class="leg leg-b" x="21" y="23" width="4.2" height="16" rx="2.1" fill="#A9652E"/>' +
    '<rect class="leg leg-a" x="44" y="23" width="4.2" height="16" rx="2.1" fill="#A9652E"/>' +
    '<path d="M18 26.5q2.5 5 5 1.8 2.5 5 5 1.8 2.5 5 5 1.8 2.5 4.5 5 1.2L41 24.5 19 24.5z" fill="#E6BD84"/>' +
    '<ellipse cx="31" cy="21" rx="17" ry="8.5" fill="#C98445"/>' +
    '<path d="M17 18c5-5.5 18-6.5 27-3" stroke="#B36E35" stroke-width="2.2" fill="none" stroke-linecap="round"/>' +
    '<path d="M40 16C42 9 46 5 51 5l3.5 9c-3.5 3-7 7-8.5 11z" fill="#C98445"/>' +
    '<path d="M44.5 13c5.5 3.5 6 11.5 1.5 17-2.5-3-4-8-4.5-12.5z" fill="#E6BD84"/>' +
    '<ellipse cx="53.5" cy="10" rx="7.5" ry="6.5" fill="#C98445"/>' +
    '<path d="M57.5 8.4c4.6-.3 8.6 1.3 8.6 4 0 2.6-4 3.7-8.6 3.2z" fill="#D9A066"/>' +
    '<path d="M58.5 14.6c2.6 1.6 5.4 1.5 7-.2.2 1.6-2.4 3.2-5 3-1.2-.1-2-.9-2-2.8z" fill="#EFDCBC"/>' +
    '<circle cx="65.6" cy="11.4" r="1.9" fill="#1E1612"/>' +
    '<circle cx="56" cy="8.2" r="1.15" fill="#2A1A12"/>' +
    '<path d="M42.2 13.4c1.6 3.4 3.6 6.4 6.3 8.9" stroke="#D8F51E" stroke-width="2.4" stroke-linecap="round" fill="none"/>' +
    '<circle cx="48.4" cy="24.4" r="1.6" fill="#2E9C9C"/><circle cx="46.9" cy="24" r="1.05" fill="#C8323A"/>' +
    '<path d="M50 4.5c-4 .3-5.3 6.5-4.4 11.8.6 2.4 3.8 2.7 4.8 0 1.3-3.4 1.5-8.5-.4-11.8z" fill="#A9652E"/>' +
    '<rect class="leg leg-a" x="17" y="24" width="4.6" height="15.5" rx="2.3" fill="#C98445"/>' +
    '<rect class="leg leg-b" x="40.5" y="24" width="4.6" height="15.5" rx="2.3" fill="#C98445"/>' +
    '<g class="disc"><ellipse cx="64" cy="15.5" rx="6.8" ry="2.4" fill="#DDFB2A" stroke="#AFC81A" stroke-width=".5"/>' +
    '<ellipse cx="64" cy="15.3" rx="4" ry="1.2" fill="none" stroke="#C4E01E" stroke-width=".5"/></g>' +
    '</g></svg><i class="runner-frisbee"></i></div>';
  document.body.appendChild(runner);
  var go = runner.firstChild, dog = go.firstChild;
  var x = null, facing = 1, stopTimer = null, running = false;
  var lastScene = -1, lastTop = 0; // to tell which way the visitor last went
  var caught = false, jumpTimers = [];
  var JUMP_MS = 700, CATCH_AT_MS = 300; // as runner-jump in style.css; the catch is at its top
  var reduceMotion = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  // The bottom of every section fades into the paper (.runway), so he has
  // room to run without covering anything.
  var runway = document.createElement("div");
  runway.className = "runway";
  runway.setAttribute("aria-hidden", "true");
  document.body.insertBefore(runway, runner);

  // Where he is: p from 0 at the top of the first section to 1 at the
  // bottom of the one before last (the same spot as the last), and whether
  // it's the last one, where he catches the frisbee.
  function where() {
    var i = 0, n = scenes.length;
    scenes.forEach(function (s, j) { if (s.classList.contains("is-active")) i = j; });
    var s = scenes[i], room = s.scrollHeight - s.clientHeight;
    if (i >= n - 1) return { p: 1, last: true, i: i, top: s.scrollTop };
    var f = room > 4 ? Math.min(1, Math.max(0, s.scrollTop / room)) : 0;
    return { p: (i + f) / (n - 1), last: false, i: i, top: s.scrollTop };
  }
  // A leap up for the frisbee, which comes down to meet him and is in his
  // mouth from the top of the jump (.disc).
  function jump() {
    caught = true;
    if (reduceMotion) return runner.classList.add("is-caught");
    runner.classList.add("is-jumping");
    jumpTimers.push(setTimeout(function () { runner.classList.add("is-caught"); }, CATCH_AT_MS));
    jumpTimers.push(setTimeout(function () { runner.classList.remove("is-jumping"); }, JUMP_MS));
  }
  function letGo() {
    caught = false;
    jumpTimers.forEach(clearTimeout);
    jumpTimers = [];
    runner.classList.remove("is-caught", "is-jumping");
  }
  function update() {
    var at = where();
    var left = (sidenav ? sidenav.offsetWidth : 0) + 10;
    var right = (dots ? window.innerWidth - dots.getBoundingClientRect().left : 0) + 10;
    var lead = 46; // room for the frisbee ahead of him
    var nx = Math.round(left + at.p * Math.max(0, window.innerWidth - left - right - dog.getBoundingClientRect().width - lead));
    // He faces the way the visitor last went (to a later or earlier
    // section, or scrolling down or up), the frisbee always ahead of him;
    // not by which way he moves, since a section growing as its photos
    // load also moves him back a little.
    if (lastScene >= 0 && at.i !== lastScene) facing = at.i > lastScene ? 1 : -1;
    else if (lastScene >= 0 && Math.abs(at.top - lastTop) > 2) facing = at.top > lastTop ? 1 : -1;
    lastScene = at.i;
    lastTop = at.top;
    if (x !== null && Math.abs(nx - x) > 1) {
      running = true;
      runner.classList.add("is-running");
      clearTimeout(stopTimer);
      stopTimer = setTimeout(function () {
        running = false;
        runner.classList.remove("is-running");
        var w = where();
        if (w.last && !caught) jump();
        else if (caught && w.p <= 0) letGo(); // back at the start: drops it
      }, RUN_MS);
    }
    runner.classList.toggle("is-left", facing < 0);
    if (at.last && !caught && !running) jump();
    if (caught && at.p <= 0 && !running) letGo();
    x = nx;
    go.style.transform = "translateX(" + nx + "px)";
  }
  var queued = false;
  function soon() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; update(); });
  }
  update();
  requestAnimationFrame(function () { runner.classList.add("is-ready"); }); // no run in on load
  document.addEventListener("scenechange", soon);
  scenes.forEach(function (s) { s.addEventListener("scroll", soon, { passive: true }); });
  window.addEventListener("resize", soon);
})();

/* Messages: visitors leave a note for Scout, up to MAX_FILES photos, GIFs
   and videos, or both (the note is optional with a file). New ones are
   held until approved at /messages-admin (server/messages.js), so the form
   only says thanks; the list shows already-approved ones, newest first.
   A photo is shrunk here before it's sent (at most PHOTO_MAX px a side,
   re-saved as a JPEG, which also drops its location data); a GIF or video
   goes as it is. Each file is uploaded on its own first (uploadItem). */
(function messages() {
  var form = document.getElementById("message-form");
  var list = document.getElementById("message-list");
  var status = document.getElementById("message-status");
  if (!form || !list) return;
  var API = "/api/messages";
  var PHOTO_MAX = 2400;           // px, longest side
  var GIF_MAX = 8 * 1024 * 1024;  // bytes, as in server/messages.js
  var VIDEO_MAX = 300 * 1024 * 1024;
  var MAX_FILES = 10;
  var picker = document.getElementById("message-photo");
  var attachList = document.getElementById("attach-list");
  var items = []; // what's being sent: { kind, blob, preview (blob: URL), token once uploaded }

  fetch(API)
    .then(function (r) { return r.ok ? r.json() : []; })
    .then(function (msgs) {
      msgs.forEach(function (m) {
        var div = document.createElement("div");
        div.className = "msg";
        if (m.text) {
          var p = document.createElement("p");
          p.textContent = m.text;
          div.appendChild(p);
        }
        var files = m.files || [];
        if (files.length) {
          var media = document.createElement("div");
          media.className = "msg-media" + (files.length > 1 ? " is-multi" : "");
          files.forEach(function (f) {
            if (f.kind === "video") {
              var v = document.createElement("video");
              v.className = "msg-video";
              v.controls = true;
              v.playsInline = true;
              v.preload = "none";
              whenNear(list, function () { v.preload = "metadata"; v.src = f.url; });
              media.appendChild(v);
              return;
            }
            var a = document.createElement("a");
            a.className = "msg-photo";
            a.href = f.url;
            a.target = "_blank";
            var img = document.createElement("img");
            whenNear(list, function () { img.src = f.url; });
            img.alt = "A photo of Scout, shared by a visitor";
            img.loading = "lazy";
            a.appendChild(img);
            media.appendChild(a);
          });
          div.appendChild(media);
        }
        if (m.name) {
          var who = document.createElement("p");
          who.className = "msg-name";
          who.textContent = "\u2014 " + m.name;
          div.appendChild(who);
        }
        var t = document.createElement("time");
        t.dateTime = m.createdAt;
        t.textContent = new Date(m.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
        div.appendChild(t);
        list.appendChild(div);
      });
    })
    .catch(function () {});

  // A picked photo, ready to send as a Blob: a GIF as it is, anything else
  // drawn onto a canvas no bigger than PHOTO_MAX and saved as a JPEG (which
  // also drops its location data). A video goes as it is.
  function readPhoto(file) {
    return new Promise(function (resolve, reject) {
      if (/^image\/gif$/i.test(file.type)) {
        if (file.size > GIF_MAX) return reject(new Error("That GIF is too big (8 MB max)."));
        return resolve(file);
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
        c.toBlob(function (b) { if (b) resolve(b); else reject(new Error("")); }, "image/jpeg", 0.86);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("")); };
      img.src = url;
    });
  }
  function readFile(file) {
    if (/^video\//i.test(file.type) || /\.(mp4|mov|m4v|webm)$/i.test(file.name)) {
      if (file.size > VIDEO_MAX) return Promise.reject(new Error("“" + file.name + "” is too big (300 MB max for a video)."));
      return Promise.resolve({ kind: "video", blob: file });
    }
    if (!/^image\//i.test(file.type)) return Promise.reject(new Error("“" + file.name + "” isn’t a photo or video."));
    return readPhoto(file).then(function (b) { return { kind: "image", blob: b }; }, function (err) {
      throw new Error(err.message || "“" + file.name + "” couldn’t be opened. Please try a JPEG or PNG.");
    });
  }

  // The thumbnails of what's attached, each with a remove button.
  function showItems() {
    attachList.textContent = "";
    attachList.hidden = !items.length;
    items.forEach(function (it) {
      var box = document.createElement("div");
      box.className = "attach";
      var el = document.createElement(it.kind === "video" ? "video" : "img");
      if (it.kind === "video") { el.muted = true; el.playsInline = true; el.preload = "metadata"; el.src = it.preview + "#t=0.1"; }
      else el.alt = "A photo you're sending";
      if (it.kind !== "video") el.src = it.preview;
      box.appendChild(el);
      if (it.kind === "video") {
        var badge = document.createElement("span");
        badge.className = "attach-badge";
        badge.textContent = "Video";
        box.appendChild(badge);
      }
      var x = document.createElement("button");
      x.type = "button";
      x.setAttribute("aria-label", "Remove this " + (it.kind === "video" ? "video" : "photo"));
      x.textContent = "\u00d7";
      x.addEventListener("click", function () {
        URL.revokeObjectURL(it.preview);
        items.splice(items.indexOf(it), 1);
        showItems();
      });
      box.appendChild(x);
      attachList.appendChild(box);
    });
  }
  function clearItems() {
    items.forEach(function (it) { URL.revokeObjectURL(it.preview); });
    items = [];
    showItems();
  }

  if (picker && attachList) {
    picker.addEventListener("change", function () {
      var files = Array.prototype.slice.call(picker.files || []);
      picker.value = ""; // so the same file can be picked again
      if (!files.length) return;
      var room = MAX_FILES - items.length, problems = [];
      if (files.length > room) {
        problems.push("Up to " + MAX_FILES + " photos and videos per message.");
        files = files.slice(0, Math.max(0, room));
      }
      status.textContent = "Getting " + (files.length === 1 ? "it" : "them") + " ready…";
      files.reduce(function (chain, file) {
        return chain.then(function () {
          return readFile(file).then(function (it) {
            it.preview = URL.createObjectURL(it.blob);
            items.push(it);
            showItems();
          }, function (err) { problems.push(err.message); });
        });
      }, Promise.resolve()).then(function () { status.textContent = problems.join(" "); });
    });
  }

  // Each file goes up on its own, with progress, and comes back as a token
  // the message then names. A file that's already up keeps its token, so
  // trying again after a failure only sends what's left.
  function uploadItem(it, n, total) {
    if (it.token) return Promise.resolve(it.token);
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      var label = (total > 1 ? " " + (n + 1) + " of " + total : "");
      xhr.open("POST", API + "/upload");
      xhr.setRequestHeader("Content-Type", it.blob.type || "application/octet-stream");
      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable) status.textContent = "Uploading" + label + "… " + Math.floor(e.loaded / e.total * 100) + "%";
      };
      xhr.onload = function () {
        var b = {};
        try { b = JSON.parse(xhr.responseText); } catch (e) {}
        if (xhr.status === 201 && b.token) { it.token = b.token; resolve(b.token); }
        else reject(new Error(b.error || (xhr.status === 413 ? "That file is too big." : "")));
      };
      xhr.onerror = function () { reject(new Error("The upload was interrupted. Please try again.")); };
      status.textContent = "Uploading" + label + "…";
      xhr.send(it.blob);
    });
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var button = form.querySelector("button[type=submit]");
    var text = form.elements.text.value.trim();
    if (!text && !items.length) { status.textContent = "Please write a message or add a photo or video."; return; }
    button.disabled = true;
    var tokens = [];
    items.reduce(function (chain, it, n) {
      return chain.then(function () { return uploadItem(it, n, items.length).then(function (t) { tokens.push(t); }); });
    }, Promise.resolve())
      .then(function () {
        status.textContent = "Sending…";
        return fetch(API, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: text, name: form.elements.name.value.trim(), website: form.elements.website.value, files: tokens })
        });
      })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (b) {
          if (!r.ok) {
            // A token the server no longer knows (it waited too long): upload again next time.
            if (r.status === 400 && /didn't finish uploading/.test(b.error || "")) items.forEach(function (it) { delete it.token; });
            throw new Error(b.error || "");
          }
        });
      })
      .then(function () {
        form.reset();
        clearItems();
        status.textContent = "Thank you. It will appear here once it’s been approved.";
      })
      .catch(function (err) {
        status.textContent = err.message || "Sorry, that didn’t send. Please try again in a moment.";
      })
      .then(function () { button.disabled = false; });
  });
})();
