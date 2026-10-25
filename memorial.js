/* Memorial text markup, shared by the page (script.js) and the preview in
   the Memorial text box at /media-admin. media/memorial.txt is paragraphs
   separated by blank lines, and:
     **bold**  *italic*
     # A heading            (a paragraph starting with "# ")
     (A description[photo.jpg])   (a paragraph of just this: a photo from
                            media/ with that caption; the description is
                            optional: ([photo.jpg]), and <photo.jpg> works too)
   Everything is built as DOM nodes with textContent, never as HTML.
   renderMemorial(text, container, opts) fills container; opts.dir is the
   media folder's URL, opts.setSrc(img, url) sets a photo's src (the page
   uses it to load lazily), opts.onPhoto(fig, file, caption) hooks clicks. */
var MEMORIAL_PHOTO = /^\(([^\[\]]*)\[\s*<?([^\[\]<>\/\\]+?)>?\s*\]\)$/;

function memorialBlocks(text) {
  return String(text || "").replace(/\r\n?/g, "\n").split(/\n\s*\n/)
    .map(function (p) { return p.trim(); }).filter(Boolean)
    .map(function (p) {
      var m = MEMORIAL_PHOTO.exec(p);
      if (m) return { kind: "photo", file: m[2], caption: m[1].trim() };
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
      el.className = "memorial-photo " + (side++ % 2 ? "is-left" : "is-right");
      var img = document.createElement("img");
      img.alt = b.caption || "";
      img.onload = function () { el.classList.add("is-loaded"); };
      img.onerror = function () { el.classList.add("is-missing"); if (opts.onMissing) opts.onMissing(el, b.file); };
      el.appendChild(img);
      if (b.caption) {
        var cap = document.createElement("figcaption");
        cap.textContent = b.caption;
        el.appendChild(cap);
      }
      var url = dir + encodeURIComponent(b.file);
      if (opts.setSrc) opts.setSrc(img, url); else img.src = url;
      if (opts.onPhoto) opts.onPhoto(el, url, b.caption);
    } else {
      el = document.createElement(b.kind === "heading" ? "h3" : "p");
      memorialInline(b.text, el);
    }
    container.appendChild(el);
  });
}
