/* Scout page behaviour.

   Slideshow: /media/slideshow/ is read via nginx's directory listing
   (autoindex is on for that location in conf/nginx.conf). Every image
   and video file found there becomes a slide, ordered by filename, so
   dropping a new file into the folder is all that's needed to add it.
*/

/* Scenes: the page is four full-screen .scene layers (intro, dedication,
   slideshow, the catch) and scrolling fades between them instead of moving
   the page. A scene taller than the screen scrolls normally inside itself
   and only fades once you're at its top or bottom edge. Wheel, touch swipe,
   keyboard and the nav links all go through go(). .sidenav slides in on
   every scene after the intro (the intro has .topnav instead). */
(function scenes() {
  var list = Array.prototype.slice.call(document.querySelectorAll(".scene"));
  var sidenav = document.getElementById("sidenav");
  var lightbox = document.getElementById("lightbox");
  var frisbee = document.getElementById("frisbee");
  if (list.length < 2) return;

  var SHIFT = 24;          // px of vertical drift during the fade
  var LOCK_MS = 1000;      // ignore further input while a fade runs
  var SETTLE_MS = 160;     // a scene must sit still this long at its edge before fading
  var current = 0;
  var lockUntil = 0;
  var lastScrollAt = 0;

  document.documentElement.classList.add("scenes");

  function atTop(el) { return el.scrollTop <= 1; }
  function atBottom(el) { return el.scrollTop + el.clientHeight >= el.scrollHeight - 2; }
  function busy() { return lightbox && !lightbox.hidden; }

  function setShift(el, px) { el.style.setProperty("--shift", px + "px"); }

  function activate(i, dir, instant) {
    var from = list[current];
    var to = list[i];

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
    to.classList.add("is-active");
    if (instant) { void to.offsetWidth; to.style.transition = ""; }

    current = i;
    lastScrollAt = 0;
    if (sidenav) sidenav.classList.toggle("visible", i > 0);

    var anchor = to.getAttribute("data-anchor");
    try { history.replaceState(null, "", anchor ? "#" + anchor : location.pathname + location.search); } catch (e) {}

    // The catch clip only plays (and only downloads) while its scene is up.
    if (frisbee && !frisbee.closest(".scene").classList.contains("is-active")) frisbee.pause();
    else if (frisbee) { var p = frisbee.play(); if (p && p.catch) p.catch(function () {}); }
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
    var now = Date.now();
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

(function slideshow() {
  var DIR = "media/slideshow/";
  var AUTOPLAY_MS = 6000; // 0 disables autoplay

  var IMAGE_RE = /\.(jpe?g|png|gif|webp|avif)$/i;
  var VIDEO_RE = /\.(mp4|webm|mov|m4v)$/i;

  var stage = document.getElementById("slideshow-stage");
  var dotWrap = document.getElementById("slideshow-dots");
  var counter = document.getElementById("slideshow-count");
  var prevBtn = document.getElementById("ss-prev");
  var nextBtn = document.getElementById("ss-next");

  var items = [];
  var layers = [];
  var dots = [];
  var current = 0;
  var timer = null;
  var paused = false;

  var lightbox = document.getElementById("lightbox");
  var lightboxImg = document.getElementById("lightbox-img");
  var lightboxClose = document.getElementById("lightbox-close");

  if (!stage) return;

  fetch(DIR)
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
      files.sort(function (a, b) { return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }); });

      start(files);
    })
    .catch(function (err) {
      console.error("slideshow: could not read " + DIR, err);
      stage.innerHTML = '<div class="ss-empty">Couldn’t load the slideshow right now.</div>';
    });

  function start(files) {
    items = files.map(function (f) {
      return { file: f, type: VIDEO_RE.test(f) ? "video" : "image" };
    });

    if (!items.length) {
      stage.innerHTML = '<div class="ss-empty">No photos or videos yet — drop some into media/slideshow/.</div>';
      return;
    }

    items.forEach(function (item, i) {
      var el;
      if (item.type === "video") {
        el = document.createElement("video");
        el.src = DIR + item.file;
        el.muted = true;
        el.playsInline = true;
        el.controls = true;
        el.preload = i === 0 ? "auto" : "metadata";
        // Don't let the fixed autoplay timer cut this off mid-playback —
        // advance only once the clip actually finishes (see tick()).
        el.addEventListener("ended", function () {
          if (i === current) next();
        });
      } else {
        el = document.createElement("img");
        el.src = DIR + item.file;
        el.alt = "Scout";
        el.loading = i === 0 ? "eager" : "lazy";
        el.addEventListener("click", function () { openLightbox(el.src); });
      }
      stage.appendChild(el);
      layers.push(el);

      var b = document.createElement("button");
      b.type = "button";
      b.setAttribute("aria-label", (item.type === "video" ? "Video " : "Photo ") + (i + 1));
      b.appendChild(document.createElement("i"));
      b.addEventListener("click", function () { goTo(i); });
      dotWrap.appendChild(b);
      dots.push(b);
    });

    stage.addEventListener("mouseenter", function () { paused = true; });
    stage.addEventListener("mouseleave", function () { paused = false; });

    var touchX = null;
    stage.addEventListener("touchstart", function (e) { touchX = e.touches[0].clientX; }, { passive: true });
    stage.addEventListener("touchend", function (e) {
      if (touchX === null) return;
      var dx = e.changedTouches[0].clientX - touchX;
      if (Math.abs(dx) > 44) { dx < 0 ? next() : previous(); }
      touchX = null;
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") previous();
    });

    if (prevBtn) prevBtn.addEventListener("click", previous);
    if (nextBtn) nextBtn.addEventListener("click", next);

    show();
    tick();
  }

  function show() {
    layers.forEach(function (el, i) {
      var on = i === current;
      el.classList.toggle("is-on", on);
      if (items[i].type === "video") {
        if (on) { try { el.currentTime = 0; el.play(); } catch (e) {} }
        else { el.pause(); }
      }
    });
    dots.forEach(function (d, i) { d.setAttribute("aria-current", i === current ? "true" : "false"); });
    if (counter) counter.textContent = pad(current + 1) + " / " + pad(items.length);
  }

  function pad(n) { return n < 10 ? "0" + n : String(n); }

  function tick() {
    clearTimeout(timer);
    if (!AUTOPLAY_MS || items.length < 2) return;
    if (items[current].type === "video") return; // its own "ended" event advances instead
    timer = setTimeout(function () {
      if (!paused) advance(1);
      tick();
    }, AUTOPLAY_MS);
  }

  function advance(d) {
    current = (current + d + items.length) % items.length;
    show();
  }

  function next() { advance(1); tick(); }
  function previous() { advance(-1); tick(); }
  function goTo(i) { current = i; show(); tick(); }

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
  function openLightbox(src) {
    if (!lightbox || !lightboxImg) return;
    zoom = 1;
    baseW = 0;
    lightboxImg.style.width = "";
    lightbox.classList.remove("zoomed");
    lightboxImg.src = src;
    lightbox.hidden = false;
    clearTimeout(timer);
    if (lightboxImg.complete) measureBase();
    else lightboxImg.onload = measureBase;
  }
  function closeLightbox() {
    if (!lightbox || !lightboxImg) return;
    lightbox.hidden = true;
    lightbox.classList.remove("zoomed");
    lightboxImg.style.width = "";
    lightboxImg.src = "";
    tick();
  }
  if (lightbox) {
    lightbox.addEventListener("click", function (e) {
      if (e.target !== lightboxImg) closeLightbox();
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

/* Dedicated "the catch" clip: hide the player behind a plate until the
   file actually exists at media/videos/scout_good_catch.mp4. */
(function frisbeeVideo() {
  var v = document.getElementById("frisbee");
  var shell = document.getElementById("video-shell");
  if (!v || !shell) return;
  function empty() { shell.classList.add("is-empty"); v.removeAttribute("controls"); }
  v.addEventListener("error", empty);
  if (v.networkState === 3) empty();
})();
