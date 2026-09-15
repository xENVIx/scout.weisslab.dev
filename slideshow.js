/* Scout slideshow.
   Images come from IMAGE_DIR. If the server returns a browsable directory
   listing, every image in the folder is picked up automatically — drop a new
   file in and it appears. If listings are off, FALLBACK is used, so edit that
   array (or leave it) and the slideshow still works. */

var IMAGE_DIR = "media/pictures/slideshow/";

var FALLBACK = [
  "scout_stick.jpg",
  "CROPPED_EFFECTS.jpg"
];

var AUTOPLAY_MS = 6000;   // 0 disables autoplay

var images = [];
var currentImage = 0;
var layers = [];
var dots = [];
var timer = null;
var paused = false;

var stage = document.getElementById("slideshow-stage");
var dotWrap = document.getElementById("slideshow-dots");
var counter = document.getElementById("slideshow-count");

fetch(IMAGE_DIR)
  .then(function (r) { return r.ok ? r.text() : Promise.reject(); })
  .then(function (html) {
    var doc = new DOMParser().parseFromString(html, "text/html");
    var found = Array.prototype.slice.call(doc.querySelectorAll("a"))
      .map(function (a) { return a.getAttribute("href"); })
      .filter(function (f) { return f && /\.(jpg|jpeg|png|gif|webp|avif)$/i.test(f); })
      .map(function (f) { return f.split("/").pop(); });
    start(found.length ? dedupe(found) : FALLBACK);
  })
  .catch(function () { start(FALLBACK); });

function dedupe(list) {
  return list.filter(function (f, i) { return list.indexOf(f) === i; });
}

function start(list) {
  images = list;
  if (!images.length || !stage) return;

  images.forEach(function (file, i) {
    var img = document.createElement("img");
    img.src = IMAGE_DIR + file;
    img.alt = "Scout";
    img.loading = i === 0 ? "eager" : "lazy";
    stage.appendChild(img);
    layers.push(img);

    var b = document.createElement("button");
    b.type = "button";
    b.setAttribute("aria-label", "Photo " + (i + 1));
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
    if (Math.abs(dx) > 44) { dx < 0 ? nextImage() : previousImage(); }
    touchX = null;
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "ArrowRight") nextImage();
    else if (e.key === "ArrowLeft") previousImage();
  });

  showImage();
  tick();
}

function showImage() {
  layers.forEach(function (img, i) { img.classList.toggle("is-on", i === currentImage); });
  dots.forEach(function (d, i) { d.setAttribute("aria-current", i === currentImage ? "true" : "false"); });
  if (counter) {
    counter.textContent = pad(currentImage + 1) + " / " + pad(images.length);
  }
}

function pad(n) { return n < 10 ? "0" + n : String(n); }

function tick() {
  clearTimeout(timer);
  if (!AUTOPLAY_MS || images.length < 2) return;
  timer = setTimeout(function () {
    if (!paused) advance(1);
    tick();
  }, AUTOPLAY_MS);
}

function advance(d) {
  currentImage = (currentImage + d + images.length) % images.length;
  showImage();
}

function nextImage() { advance(1); tick(); }
function previousImage() { advance(-1); tick(); }
function goTo(i) { currentImage = i; showImage(); tick(); }
