/* Memorial text markup, shared by the page (script.js) and the preview in
   the Memorial text box at /media-admin. media/memorial.txt is paragraphs
   separated by blank lines, and:
     **bold**  *italic*
     # A heading            (a paragraph starting with "# ")
     (A caption[photo.jpg 35% print])   a photo from media/, anywhere: on
                            its own between paragraphs, or in the middle of
                            one, where the text after it wraps around it.
                            The caption is optional: ([photo.jpg]), and
                            <photo.jpg> works too; so are the size (% of the
                            text's width, MEMORIAL_SIZE when none is given;
                            centred on its own from MEMORIAL_WIDE up) and
                            the frame (outline, the default MEMORIAL_FRAME;
                            print, mat or none; see memorial.css).
   Everything is built as DOM nodes with textContent, never as HTML.
   renderMemorial(text, container, opts) fills container; opts.dir is the
   media folder's URL, opts.setSrc(img, url) sets a photo's src (the page
   uses it to load lazily), opts.onPhoto(el, url, caption, photo) hooks
   clicks (photo.n is its place among all the photos in the text, as in
   memorialPhotos()), opts.onMissing(el, file) a photo that's gone. */
var MEMORIAL_TAG = /\(([^()\[\]\n]*)\[\s*<?([^\[\]<>\/\\\n]+?)>?(?:\s+(\d{1,3})%)?(?:\s+(outline|print|mat|none))?\s*\]\)/gi;
var MEMORIAL_SIZE = 46, MEMORIAL_MIN = 15, MEMORIAL_WIDE = 70, MEMORIAL_WIDE_PHONE = 50;
var MEMORIAL_FRAMES = ["outline", "print", "mat", "none"], MEMORIAL_FRAME = "outline";

// A photo's size (% of the text's width), kept within MEMORIAL_MIN..100.
function memorialSize(n) {
  n = Math.round(Number(n));
  return isFinite(n) && n > 0 ? Math.max(MEMORIAL_MIN, Math.min(100, n)) : MEMORIAL_SIZE;
}

// A photo's tag: size 0 or the default, and the default frame, are left out.
function memorialTag(caption, file, size, frame) {
  return "(" + caption + "[" + file + (size && size !== MEMORIAL_SIZE ? " " + size + "%" : "") +
    (frame && frame !== MEMORIAL_FRAME ? " " + frame : "") + "])";
}

// Every photo tag in the text, in order: where it is ([start, end) of the
// text) and what it says.
function memorialPhotos(text) {
  var re = new RegExp(MEMORIAL_TAG.source, "gi"), out = [], m;
  while ((m = re.exec(text))) {
    out.push({ n: out.length, start: m.index, end: re.lastIndex, rawCaption: m[1], caption: m[1].trim(), file: m[2],
      size: memorialSize(m[3]), sized: !!m[3], frame: (m[4] || MEMORIAL_FRAME).toLowerCase() });
  }
  return out;
}

// Sizes a photo: --w for the CSS, and centred on its own when wide
// (.is-wide on a computer; .is-wide-phone on a phone, where the column is narrower).
function sizeMemorialPhoto(el, size) {
  el.style.setProperty("--w", size);
  el.classList.toggle("is-wide", size >= MEMORIAL_WIDE);
  el.classList.toggle("is-wide-phone", size >= MEMORIAL_WIDE_PHONE);
}

// The paragraphs: { kind: "para" | "heading" | "photos", parts }, where parts
// are strings and photos (from memorialPhotos) in order; "photos" is a
// paragraph of nothing but photo tags.
function memorialBlocks(text) {
  text = String(text || "").replace(/\r\n?/g, "\n");
  var photos = memorialPhotos(text), k = 0, out = [], re = /\n\s*\n/g, at = 0, m;
  function add(a, z) {
    while (a < z && /\s/.test(text[a])) a++;
    while (z > a && /\s/.test(text[z - 1])) z--;
    if (z <= a) return;
    var parts = [], pos = a;
    while (k < photos.length && photos[k].start < z) {
      if (photos[k].start > pos) parts.push(text.slice(pos, photos[k].start));
      parts.push(photos[k]);
      pos = photos[k++].end;
    }
    if (pos < z) parts.push(text.slice(pos, z));
    var words = parts.filter(function (p) { return typeof p === "string" && p.trim(); });
    var kind = !words.length ? "photos" : typeof parts[0] === "string" && /^#\s/.test(parts[0]) ? "heading" : "para";
    if (kind === "heading") parts[0] = parts[0].replace(/^#\s+/, "");
    out.push({ kind: kind, parts: parts });
  }
  while ((m = re.exec(text))) { add(at, m.index); at = re.lastIndex; }
  add(at, text.length);
  return out;
}

// **bold** and *italic* (either may hold the other once).
function memorialInline(s, parent) {
  var re = /\*\*(?=\S)([\s\S]+?)\*\*|\*(?=[^\s*])([\s\S]+?)\*/g, at = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > at) parent.appendChild(document.createTextNode(s.slice(at, m.index)));
    var el = document.createElement(m[1] !== undefined ? "strong" : "em");
    memorialInline(m[1] !== undefined ? m[1] : m[2], el);
    parent.appendChild(el);
    at = re.lastIndex;
  }
  if (at < s.length) parent.appendChild(document.createTextNode(s.slice(at)));
}

function renderMemorial(text, container, opts) {
  opts = opts || {};
  var dir = opts.dir || "media/", side = 0;
  var doc = container.ownerDocument;
  // A photo: a <figure> between paragraphs, or a <span> (styled as a block)
  // inside one, so the text after it wraps around it.
  function photo(b, inline) {
    var el = doc.createElement(inline ? "span" : "figure");
    el.className = "memorial-photo frame-" + b.frame + " " + (side % 2 ? "is-left" : "is-right") + (inline ? " is-inline" : "");
    if (b.size < MEMORIAL_WIDE) side++; // centred ones don't take a turn
    sizeMemorialPhoto(el, b.size);
    if (inline) el.setAttribute("role", "figure");
    var img = doc.createElement("img");
    img.alt = b.caption || "";
    img.onload = function () { el.classList.add("is-loaded"); };
    img.onerror = function () { el.classList.add("is-missing"); if (opts.onMissing) opts.onMissing(el, b.file); };
    var pic = doc.createElement("span");
    pic.className = "mp-frame";
    pic.appendChild(img);
    el.appendChild(pic);
    if (b.caption) {
      var cap = doc.createElement(inline ? "span" : "figcaption");
      cap.className = "mp-caption";
      cap.textContent = b.caption;
      el.appendChild(cap);
    } else el.classList.add("no-caption");
    var url = dir + encodeURIComponent(b.file);
    if (opts.setSrc) opts.setSrc(img, url); else img.src = url;
    if (opts.onPhoto) opts.onPhoto(el, url, b.caption, b);
    return el;
  }
  container.textContent = "";
  memorialBlocks(text).forEach(function (b) {
    if (b.kind === "photos") {
      b.parts.forEach(function (p) { if (typeof p !== "string") container.appendChild(photo(p, false)); });
      return;
    }
    var el = doc.createElement(b.kind === "heading" ? "h3" : "p");
    b.parts.forEach(function (p, i) {
      if (typeof p !== "string") return el.appendChild(photo(p, true));
      if (i > 0) p = p.replace(/^ +/, ""); // the space after a tag
      memorialInline(p, el);
    });
    container.appendChild(el);
  });
}
