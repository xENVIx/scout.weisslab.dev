/* Scout page behaviour.

   Slideshow: /media/slideshow/ is read via nginx's directory listing
   (autoindex is on for that location in conf/nginx.conf). Every image
   and video file found there becomes a slide, ordered by filename, so
   dropping a new file into the folder is all that's needed to add it.
*/

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
        el.loop = true;
        el.controls = true;
        el.preload = i === 0 ? "auto" : "metadata";
      } else {
        el = document.createElement("img");
        el.src = DIR + item.file;
        el.alt = "Scout";
        el.loading = i === 0 ? "eager" : "lazy";
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
