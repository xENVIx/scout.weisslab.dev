/* Memorial text markup, shared by the page (script.js) and the preview in
   the Memorial text box at /media-admin. media/memorial.txt is paragraphs
   separated by blank lines, and:
     **bold**  *italic*
     # A heading            (a paragraph starting with "# ")
     (A description[photo.jpg])   (a paragraph of just this: a photo from
                            media/ with that caption; the description is
                            optional: ([photo.jpg]), and <photo.jpg> works too)
     (A description[photo.jpg 35%])  the same at 35% of the text's width
                            (MEMORIAL_SIZE when none is given; from 70% up it
                            sits centred on its own instead of beside the text)
     (A description[photo.jpg 35% print])  with a frame: outline (the
                            default, MEMORIAL_FRAME), print, mat or none;
                            see memorial.css. Size and frame are each optional.
   Everything is built as DOM nodes with textContent, never as HTML.
   renderMemorial(text, container, opts) fills container; opts.dir is the
   media folder's URL, opts.setSrc(img, url) sets a photo's src (the page
   uses it to load lazily), opts.onPhoto(fig, url, caption, block) hooks
   clicks (block.n is its paragraph's place among the non-blank ones). */
var MEMORIAL_PHOTO = /^\(([^\[\]]*)\[\s*<?([^\[\]<>\/\\]+?)>?(?:\s+(\d{1,3})%)?(?:\s+(outline|print|mat|none))?\s*\]\)$/i;
var MEMORIAL_SIZE = 46, MEMORIAL_MIN = 15, MEMORIAL_WIDE = 70, MEMORIAL_WIDE_PHONE = 50;
var MEMORIAL_FRAMES = ["outline", "print", "mat", "none"], MEMORIAL_FRAME = "outline";

// A photo's line: size 0 or the default, and the default frame, are left out.
function memorialTag(caption, file, size, frame) {
  return "(" + caption + "[" + file + (size && size !== MEMORIAL_SIZE ? " " + size + "%" : "") +
    (frame && frame !== MEMORIAL_FRAME ? " " + frame : "") + "])";
}

// A photo's size (% of the text's width), kept within MEMORIAL_MIN..100.
function memorialSize(n) {
  n = Math.round(Number(n));
  return isFinite(n) && n > 0 ? Math.max(MEMORIAL_MIN, Math.min(100, n)) : MEMORIAL_SIZE;
}

// Sizes a photo's figure: --w for the CSS, and centred on its own when wide
// (.is-wide on a computer; .is-wide-phone on a phone, where the column is narrower).
function sizeMemorialPhoto(fig, size) {
  fig.style.setProperty("--w", size);
  fig.classList.toggle("is-wide", size >= MEMORIAL_WIDE);
  fig.classList.toggle("is-wide-phone", size >= MEMORIAL_WIDE_PHONE);
}

function memorialBlocks(text) {
  return String(text || "").replace(/\r\n?/g, "\n").split(/\n\s*\n/)
    .map(function (p) { return p.trim(); }).filter(Boolean)
    .map(function (p, n) {
      var m = MEMORIAL_PHOTO.exec(p);
      if (m) return { kind: "photo", n: n, file: m[2], caption: m[1].trim(), size: memorialSize(m[3]), frame: (m[4] || MEMORIAL_FRAME).toLowerCase() };
      if (/^#\s/.test(p)) return { kind: "heading", text: p.replace(/^#\s+/, "") };
      return { kind: "para", text: p };
    });
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
  container.textContent = "";
  memorialBlocks(text).forEach(function (b) {
    var el;
    if (b.kind === "photo") {
      el = document.createElement("figure");
      el.className = "memorial-photo frame-" + b.frame + " " + (side % 2 ? "is-left" : "is-right");
      if (b.size < MEMORIAL_WIDE) side++; // centred ones don't take a turn
      sizeMemorialPhoto(el, b.size);
      var img = document.createElement("img");
      img.alt = b.caption || "";
      img.onload = function () { el.classList.add("is-loaded"); };
      img.onerror = function () { el.classList.add("is-missing"); if (opts.onMissing) opts.onMissing(el, b.file); };
      var pic = document.createElement("span");
      pic.className = "mp-frame";
      pic.appendChild(img);
      el.appendChild(pic);
      if (b.caption) {
        var cap = document.createElement("figcaption");
        cap.textContent = b.caption;
        el.appendChild(cap);
      }
      var url = dir + encodeURIComponent(b.file);
      if (opts.setSrc) opts.setSrc(img, url); else img.src = url;
      if (opts.onPhoto) opts.onPhoto(el, url, b.caption, b);
    } else {
      el = document.createElement(b.kind === "heading" ? "h3" : "p");
      memorialInline(b.text, el);
    }
    container.appendChild(el);
  });
}
