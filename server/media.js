/* Media manager for Scout: a tiny dependency-free backend.

   /media-admin (sign in with ADMIN_PASSWORD; a signed cookie keeps you in)
   lists everything in media/, the one folder the site's photos and videos
   live in, and lets the owner upload, rename and delete files. Uploads are
   streamed straight to disk, one file per request, with the file as the raw
   request body. Each file also has two checkboxes, kept as plain lists the
   page reads (one filename per line): not_in_gallery.txt names images left
   out of the gallery (every image is in it unless listed), slideshow.txt names files in
   the slideshow (nothing is unless listed). memorial.txt is the Memorial
   section's text, edited in a box at the bottom of the page (paragraphs
   separated by blank lines). captions.txt holds each file's optional
   caption ("<file>=<caption>"), and order.txt the display order the owner
   set by dragging (files it doesn't name follow, by filename).
   page_files.txt names the files
   index.html uses directly ("intro=<file>", "catch=<file>"); renaming one
   here updates it, and script.js picks up the new name. nginx proxies /media-admin here;
   see server/README.md for the systemd unit and nginx config. */

"use strict";

var http = require("http");
var fs = require("fs");
var path = require("path");
var crypto = require("crypto");

var PORT = Number(process.env.PORT) || 3312;
var HOST = "127.0.0.1";
var SITE_ORIGIN = process.env.SITE_ORIGIN || "https://inlovingmemoryofscout.com";
var ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
var MEDIA_ROOT = process.env.MEDIA_ROOT || path.join(__dirname, "..", "media");

var MAX_UPLOAD = 1024 * 1024 * 1024; // 1 GB per file
var MAX_FORM = 64 * 1024;
var MAX_MEMORIAL = 20000; // characters
var SESSION_MS = 30 * 24 * 60 * 60e3; // stay signed in for 30 days
var LOGIN_LIMIT = 10;                 // wrong passwords per visitor...
var LOGIN_WINDOW_MS = 15 * 60e3;      // ...per 15 minutes
var MEDIA_EXT = /\.(jpe?g|png|gif|webp|avif|mp4|webm|mov|m4v)$/i;
var VIDEO_EXT = /\.(mp4|webm|mov|m4v)$/i;
var GIF_EXT = /\.gif$/i;
// How the file list is grouped on the admin page, in this order.
var KINDS = [["image", "Images"], ["gif", "GIFs"], ["video", "Videos"], ["other", "Other files"]];
// The files the page uses directly live in PAGE_LIST, by role; deleting one
// leaves a gap on the page.
var PAGE_LIST = "page_files.txt";
var MEMORIAL_FILE = "memorial.txt";
var ROLES = { intro: "the intro photo", "catch": "the catch video" };
var GALLERY_OUT_LIST = "not_in_gallery.txt";
var SLIDES_LIST = "slideshow.txt";
var CAPTIONS_FILE = "captions.txt";
var ORDER_LIST = "order.txt";
var MAX_CAPTION = 200; // characters
// Kept in media/ for the page to read, but not media themselves.
var DATA_FILES = [GALLERY_OUT_LIST, SLIDES_LIST, PAGE_LIST, MEMORIAL_FILE, CAPTIONS_FILE, ORDER_LIST];

// ---- names and paths ----

function validFile(name) {
  return typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,150}$/.test(name) &&
    name.indexOf("..") < 0 && MEDIA_EXT.test(name);
}

// Turn an uploaded file's name into one validFile accepts.
function cleanName(name) {
  return String(name || "").replace(/[^A-Za-z0-9 ._()-]+/g, "_").replace(/\.{2,}/g, ".")
    .replace(/^[^A-Za-z0-9]+/, "").slice(-150);
}

function filePath(name) { return path.join(MEDIA_ROOT, name); }

function listFiles() {
  return fs.readdirSync(MEDIA_ROOT, { withFileTypes: true })
    .filter(function (d) { return d.isFile() && d.name.charAt(0) !== "." && DATA_FILES.indexOf(d.name) < 0; })
    .map(function (d) { return { name: d.name, size: fs.statSync(filePath(d.name)).size }; })
    .sort(displayCompare(readList(ORDER_LIST)));
}

function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

// The order the slideshow and gallery use: files named in ORDER_LIST first,
// in its order, then the rest by filename.
function displayCompare(order) {
  return function (a, b) {
    var i = order.indexOf(a.name), j = order.indexOf(b.name);
    if (i < 0) i = Infinity;
    if (j < 0) j = Infinity;
    return i !== j ? i - j : naturalCompare(a.name, b.name);
  };
}

// ---- show / slideshow lists ----

function readList(name) {
  try {
    return fs.readFileSync(filePath(name), "utf8").split("\n")
      .map(function (l) { return l.trim(); }).filter(Boolean);
  } catch (e) { if (e.code !== "ENOENT") throw e; return []; }
}

// Sorted by filename, except ORDER_LIST, whose order is the point.
function writeList(name, list) {
  var seen = {};
  list = list.filter(function (f) { return !seen[f] && (seen[f] = true); });
  if (name !== ORDER_LIST) list.sort(naturalCompare);
  writeFile(name, list.length ? list.join("\n") + "\n" : "");
}

// Replace a file in media/ all at once, so the page never reads half of it.
function writeFile(name, text) {
  var tmp = filePath("." + name + ".tmp");
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, filePath(name));
}

// file -> caption, from CAPTIONS_FILE's "file=caption" lines.
function readCaptions() {
  var out = {};
  readList(CAPTIONS_FILE).forEach(function (l) {
    var i = l.indexOf("=");
    if (i > 0) out[l.slice(0, i)] = l.slice(i + 1).trim();
  });
  return out;
}

function writeCaptions(caps) {
  writeFile(CAPTIONS_FILE, Object.keys(caps).filter(function (f) { return caps[f]; }).sort(naturalCompare)
    .map(function (f) { return f + "=" + caps[f] + "\n"; }).join(""));
}

// Put file on the named list (on) or take it off.
function setFlag(name, file, on) {
  var list = readList(name).filter(function (f) { return f !== file; });
  if (on) list.push(file);
  writeList(name, list);
}

// role -> filename, from PAGE_LIST's "role=file" lines.
function pageFiles() {
  var out = {};
  readList(PAGE_LIST).forEach(function (l) {
    var m = /^(\w+)\s*=\s*(.+)$/.exec(l);
    if (m && ROLES[m[1]]) out[m[1]] = m[2];
  });
  return out;
}

// What the page uses file for ("the intro photo"), or "".
function pageUse(file) {
  var roles = pageFiles();
  return Object.keys(roles).filter(function (r) { return roles[r] === file; }).map(function (r) { return ROLES[r]; }).join(" and ");
}

function renamePageFile(file, to) {
  var roles = pageFiles(), changed = false;
  Object.keys(roles).forEach(function (r) { if (roles[r] === file) { roles[r] = to; changed = true; } });
  if (!changed) return;
  writeFile(PAGE_LIST, Object.keys(roles).map(function (r) { return r + "=" + roles[r] + "\n"; }).join(""));
}

// After a delete (or rename), drop the old name from the lists, captions and
// order (or carry its ticks, caption and place over to the new name).
function forgetFile(file, renamedTo) {
  [GALLERY_OUT_LIST, SLIDES_LIST].forEach(function (name) {
    var list = readList(name);
    if (list.indexOf(file) < 0) return;
    setFlag(name, file, false);
    if (renamedTo) setFlag(name, renamedTo, true);
  });
  var order = readList(ORDER_LIST), at = order.indexOf(file);
  if (at >= 0) {
    if (renamedTo) order[at] = renamedTo;
    else order.splice(at, 1);
    writeList(ORDER_LIST, order);
  }
  var caps = readCaptions();
  if (caps[file] !== undefined) {
    if (renamedTo) caps[renamedTo] = caps[file];
    delete caps[file];
    writeCaptions(caps);
  }
}

// ---- helpers ----

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({ "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }, headers || {}));
  res.end(body);
}

function json(res, status, obj) {
  send(res, status, JSON.stringify(obj), { "Content-Type": "application/json; charset=utf-8" });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function sha(s) { return crypto.createHash("sha256").update(s).digest(); }

// The session cookie is "<expiry>.<hmac of expiry>", keyed on the password,
// so changing the password signs everyone out.
function sign(exp) { return crypto.createHmac("sha256", ADMIN_PASSWORD).update(String(exp)).digest("hex"); }

function sessionCookie() {
  var exp = Date.now() + SESSION_MS;
  return "scout_media=" + exp + "." + sign(exp) + "; Path=/media-admin; Max-Age=" + SESSION_MS / 1000 +
    "; HttpOnly; Secure; SameSite=Strict";
}

function isAdmin(req) {
  if (!ADMIN_PASSWORD) return false;
  var m = /(?:^|;\s*)scout_media=(\d+)\.([0-9a-f]{64})/.exec(req.headers.cookie || "");
  if (!m || Number(m[1]) < Date.now()) return false;
  return crypto.timingSafeEqual(Buffer.from(m[2], "hex"), Buffer.from(sign(m[1]), "hex"));
}

var failures = new Map(); // ip -> [timestamps of wrong passwords]

function login(req, res) {
  var ip = req.headers["x-real-ip"] || req.socket.remoteAddress || "";
  var now = Date.now();
  var list = (failures.get(ip) || []).filter(function (t) { return now - t < LOGIN_WINDOW_MS; });
  readForm(req, function (f) {
    if (list.length >= LOGIN_LIMIT) return loginPage(res, "Too many tries. Please wait 15 minutes and try again.");
    var pass = String(f.password || "").trim();
    if (ADMIN_PASSWORD && crypto.timingSafeEqual(sha(pass), sha(ADMIN_PASSWORD))) {
      failures.delete(ip);
      return send(res, 303, "", { Location: "/media-admin", "Set-Cookie": sessionCookie() });
    }
    list.push(now);
    failures.set(ip, list);
    loginPage(res, "That password isn't right.");
  });
}

function loginPage(res, error) {
  var html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Scout media</title><style>' +
    'body{margin:0;padding:24px 20px;background:#FAF4EA;color:#2B211B;font:16px/1.6 Georgia,serif}' +
    'main{max-width:360px;margin:12vh auto 0}h1{font-weight:400}label{display:block;font:600 13px system-ui,sans-serif;margin-bottom:6px}' +
    'input{box-sizing:border-box;width:100%;font:16px system-ui,sans-serif;padding:10px 12px;border:1px solid #DBC8AE;border-radius:4px;background:#FFFDF8;margin-bottom:14px}' +
    'button{font:600 15px system-ui,sans-serif;padding:10px 20px;border-radius:999px;border:1px solid #A8571F;background:#A8571F;color:#FFF8EC;cursor:pointer}' +
    '.err{color:#9b2c2c;font:14px system-ui,sans-serif}' +
    '</style></head><body><main><h1>Scout’s media</h1>' +
    (error ? '<p class="err">' + esc(error) + '</p>' : '') +
    '<form method="post" action="/media-admin/login"><label for="pw">Password</label>' +
    '<input id="pw" name="password" type="password" autocomplete="current-password" autofocus required>' +
    '<button>Sign in</button></form></main></body></html>';
  send(res, error ? 401 : 200, html, { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY" });
}

// Admin POSTs must come from this site's own pages, not a form on some other
// site (SameSite=Strict already blocks that; this is a second check).
function sameOrigin(req) {
  var o = req.headers.origin || req.headers.referer || "";
  return o === SITE_ORIGIN || o.indexOf(SITE_ORIGIN + "/") === 0;
}

function readForm(req, cb) {
  var size = 0, chunks = [];
  req.on("data", function (c) {
    size += c.length;
    if (size > MAX_FORM) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on("end", function () {
    var out = {};
    new URLSearchParams(Buffer.concat(chunks).toString("utf8")).forEach(function (v, k) { out[k] = v; });
    cb(out);
  });
}

function fmtSize(n) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  return Math.max(1, Math.round(n / 1024)) + " KB";
}

// ---- upload ----

function upload(req, res, query) {
  var name = cleanName(query.get("name"));
  if (!validFile(name)) return json(res, 400, { error: "Only photos and videos (jpg, png, gif, webp, avif, mp4, webm, mov, m4v) can be uploaded." });
  if (Number(req.headers["content-length"]) > MAX_UPLOAD) return json(res, 413, { error: "That file is over 1 GB." });
  var dest = filePath(name);
  if (fs.existsSync(dest) && query.get("replace") !== "1") return json(res, 409, { error: "exists", name: name });

  // Write to a hidden temp file (nginx won't list or serve dotfiles), then
  // move it into place so the site never sees half a file.
  var tmp = filePath("." + name + "." + crypto.randomBytes(4).toString("hex") + ".part");
  var out = fs.createWriteStream(tmp, { flags: "wx" });
  var size = 0, failed = false;
  function fail(status, msg) {
    if (failed) return;
    failed = true;
    out.destroy();
    fs.rm(tmp, { force: true }, function () {});
    if (!res.headersSent) json(res, status, { error: msg });
  }
  req.on("data", function (c) {
    size += c.length;
    if (size > MAX_UPLOAD) { fail(413, "That file is over 1 GB."); req.destroy(); }
  });
  req.on("aborted", function () { fail(400, "Upload interrupted."); });
  out.on("error", function () { fail(500, "Couldn't save the file."); });
  out.on("finish", function () {
    if (failed) return;
    if (!size) return fail(400, "That file is empty.");
    fs.rename(tmp, dest, function (err) {
      if (err) return fail(500, "Couldn't save the file.");
      json(res, 201, { ok: true, name: name });
    });
  });
  req.pipe(out);
}

// ---- actions (form posts) ----

function action(req, res) {
  readForm(req, function (f) {
    var msg = "";
    var exists = validFile(f.file) && fs.existsSync(filePath(f.file));
    if (f.action === "memorial") {
      // Tidy line endings and stray spaces; blank lines separate paragraphs.
      var text = String(f.text || "").replace(/\r\n?/g, "\n").split(/\n\s*\n/)
        .map(function (p) { return p.replace(/[ \t]+\n/g, "\n").trim(); }).filter(Boolean).join("\n\n");
      if (!text) msg = "The memorial text can't be empty.";
      else if (text.length > MAX_MEMORIAL) msg = "That's too long (" + MAX_MEMORIAL + " characters max).";
      else {
        try {
          writeFile(MEMORIAL_FILE, text + "\n");
          msg = "Saved the memorial text.";
        } catch (e) { console.error(e); msg = "Couldn't save the memorial text: " + e.code; }
      }
      return send(res, 303, "", { Location: "/media-admin?msg=" + encodeURIComponent(msg) + "#memorial" });
    }
    // The checkboxes save in the background and get JSON back.
    if (f.action === "flags") {
      if (!exists) return json(res, 400, { error: "That file is gone." });
      try {
        setFlag(GALLERY_OUT_LIST, f.file, f.gallery !== "1");
        setFlag(SLIDES_LIST, f.file, f.slideshow === "1");
      } catch (e) { console.error(e); return json(res, 500, { error: "Couldn't save." }); }
      return json(res, 200, { ok: true });
    }
    if (f.action === "caption") {
      if (!exists) return json(res, 400, { error: "That file is gone." });
      var caption = String(f.caption || "").replace(/\s+/g, " ").trim();
      if (caption.length > MAX_CAPTION) return json(res, 400, { error: "Too long (" + MAX_CAPTION + " characters max)." });
      try {
        var caps = readCaptions();
        caps[f.file] = caption;
        writeCaptions(caps);
      } catch (e) { console.error(e); return json(res, 500, { error: "Couldn't save." }); }
      return json(res, 200, { ok: true });
    }
    // The whole display order, one filename per line, after a drag.
    if (f.action === "order") {
      var names = String(f.order || "").split("\n").filter(function (n) { return validFile(n) && fs.existsSync(filePath(n)); });
      try { writeList(ORDER_LIST, names); } catch (e) { console.error(e); return json(res, 500, { error: "Couldn't save." }); }
      return json(res, 200, { ok: true });
    }
    try {
      if (f.action === "delete") {
        if (!exists) msg = "That file is already gone.";
        else { fs.unlinkSync(filePath(f.file)); forgetFile(f.file); msg = "Deleted " + f.file + "."; }
      } else if (f.action === "rename") {
        var to = cleanName(f.to);
        if (!MEDIA_EXT.test(to)) to += path.extname(f.file || "");
        if (!exists) msg = "That file is gone.";
        else if (!validFile(to)) msg = "That name won't work; keep the file extension and use letters, numbers, spaces, . _ - ( ).";
        else if (to !== f.file && fs.existsSync(filePath(to))) msg = "There's already a file called " + to + ".";
        else if (to !== f.file) { fs.renameSync(filePath(f.file), filePath(to)); forgetFile(f.file, to); renamePageFile(f.file, to); msg = "Renamed to " + to + "."; }
      }
    } catch (e) {
      console.error(e);
      msg = "Something went wrong: " + e.code;
    }
    send(res, 303, "", { Location: "/media-admin" + (msg ? "?msg=" + encodeURIComponent(msg) : "") });
  });
}

// ---- admin page ----

function kindOf(name) {
  return VIDEO_EXT.test(name) ? "video" : GIF_EXT.test(name) ? "gif" : MEDIA_EXT.test(name) ? "image" : "other";
}

function adminPage(req, res, query) {
  // "type" groups the list by kind; "order" is one list in display order,
  // where rows can be dragged to reorder. The choice sticks in a cookie.
  var view = query.get("view"), cookie = null;
  if (view === "type" || view === "order") cookie = "media_view=" + view + "; Path=/media-admin; Max-Age=31536000; HttpOnly; Secure; SameSite=Strict";
  else view = /(?:^|;\s*)media_view=order/.test(req.headers.cookie || "") ? "order" : "type";
  var files = listFiles();
  var msg = query.get("msg");
  var galleryOut = readList(GALLERY_OUT_LIST);
  var slidesList = readList(SLIDES_LIST);
  var captions = readCaptions();
  var memorial = "";
  try { memorial = fs.readFileSync(filePath(MEMORIAL_FILE), "utf8").trim(); } catch (e) { if (e.code !== "ENOENT") throw e; }

  function row(f) {
    var url = "/media/" + encodeURIComponent(f.name);
    var thumb = VIDEO_EXT.test(f.name)
      ? '<video src="' + esc(url) + '#t=0.5" preload="metadata" muted></video>'
      : MEDIA_EXT.test(f.name) ? '<img src="' + esc(url) + '" loading="lazy" alt="">' : '<span class="nothumb">file</span>';
    var inUse = pageUse(f.name);
    var hidden = '<input type="hidden" name="file" value="' + esc(f.name) + '">';
    var grip = view === "order" ? '<button type="button" class="grip" aria-label="Move ' + esc(f.name) + ' (drag, or use the arrow keys)" title="Drag to reorder">⠿</button>' : '';
    return '<div class="file" data-order="' + f.order + '" data-file="' + esc(f.name) + '" data-kind="' + kindOf(f.name) + '">' + grip +
      '<a class="thumb" href="' + esc(url) + '" target="_blank">' + thumb + '</a>' +
      '<div class="info"><div class="name">' + esc(f.name) + '</div><div class="meta">' + fmtSize(f.size) +
      ' · <span class="where"></span>' + (inUse ? ' · <b>' + esc(inUse) + '</b>' : '') + '</div>' +
      flagBoxes(f.name, galleryOut.indexOf(f.name) < 0, slidesList.indexOf(f.name) >= 0) +
      '<div class="row"><input class="caption" value="' + esc(captions[f.name] || "") + '" maxlength="' + MAX_CAPTION + '" placeholder="Caption (optional)" aria-label="Caption for ' + esc(f.name) + '"></div>' +
      '<form method="post" class="row">' + hidden + '<input type="hidden" name="action" value="rename">' +
      '<input name="to" value="' + esc(f.name) + '" aria-label="New name"><button>Rename</button></form>' +
      '<form method="post" data-confirm="Delete ' + esc(f.name) + '?' + (inUse ? ' It’s ' + esc(inUse) + ', which will show an empty spot without it.' : '') + '">' +
      hidden + '<button name="action" value="delete" class="delete">Delete</button></form></div></div>';
  }

  // listFiles is already in display order.
  files.forEach(function (f, i) { f.order = i; });
  var rows;
  if (!files.length) rows = '<p class="none">No photos or videos yet.</p>';
  else if (view === "order") rows = '<div id="sortable">' + files.map(row).join("") + '</div>';
  else rows = KINDS.map(function (k) {
    var group = files.filter(function (f) { return kindOf(f.name) === k[0]; });
    return group.length ? '<h3>' + k[1] + ' (' + group.length + ')</h3>' + group.map(row).join("") : '';
  }).join("");
  var viewLink = function (v, label) {
    return '<a href="/media-admin?view=' + v + '"' + (view === v ? ' class="on" aria-current="true"' : '') + '>' + label + '</a>';
  };
  var toggle = files.length ? '<div class="view">' + viewLink("type", "By type") + viewLink("order", "Display order") + '</div>' : '';

  var note = '<p class="hint"><b>Gallery</b> puts a file in the gallery grid; <b>Slideshow</b> puts it in the slideshow. New uploads are in the gallery but not the slideshow, and go at the end. ' +
    'To change the order, switch to <b>Display order</b> and drag a file by its ⠿ handle. A caption shows under the photo in the slideshow and the enlarged view.</p>';

  var html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Scout media</title><style>' +
    'body{margin:0;padding:24px 20px 60px;background:#FAF4EA;color:#2B211B;font:16px/1.6 Georgia,serif}' +
    'main{max-width:820px;margin:0 auto}h1{font-weight:400;margin-bottom:8px}' +
    'h2{font:600 13px system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:#8F4818;margin:36px 0 12px}' +
    '.msg{background:#FFF1D6;border:1px solid #E8C98F;border-radius:4px;padding:10px 14px;font:14px system-ui,sans-serif}' +
    '.hint,.none{color:#6B5748;font-size:15px}' +
    '.drop{display:block;margin-bottom:14px;border:2px dashed #DBC8AE;border-radius:6px;padding:28px 16px;text-align:center;background:#fff;font:15px system-ui,sans-serif;color:#6B5748;cursor:pointer}' +
    '.drop.over{border-color:#A8571F;background:#FFF8EC}.drop input{display:none}' +
    '#progress{font:14px system-ui,sans-serif;margin-top:10px}#progress div{margin:4px 0}#progress .err{color:#9b2c2c}' +
    '.file{display:flex;gap:16px;background:#fff;border:1px solid #E5D6C0;border-radius:4px;padding:12px;margin:10px 0;align-items:flex-start}' +
    '.thumb{flex:0 0 120px;height:90px;background:#F1E6D4;border-radius:3px;overflow:hidden;display:flex;align-items:center;justify-content:center}' +
    '.thumb img,.thumb video{width:100%;height:100%;object-fit:cover}.nothumb{font:13px system-ui;color:#6B5748}' +
    '.info{flex:1;min-width:0}.name{font:600 15px system-ui,sans-serif;word-break:break-all}.meta{font:13px system-ui,sans-serif;color:#6B5748;margin-bottom:8px}' +
    '.flags{display:flex;flex-wrap:wrap;gap:6px 18px;align-items:center;font:14px system-ui,sans-serif;margin-bottom:10px}' +
    '.flags label{display:flex;gap:6px;align-items:center;cursor:pointer}.flags input{width:17px;height:17px;padding:0;margin:0;accent-color:#A8571F}' +
    '.saved{font-size:12px;color:#6B5748}.saved.err{color:#9b2c2c}' +
    'h3{font:600 15px system-ui,sans-serif;margin:26px 0 6px;color:#4A3B31}' +
    '.listhead{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px 16px;margin:36px 0 4px}.listhead h2{margin:0}' +
    '.view{display:flex;border:1px solid #DBC8AE;border-radius:999px;overflow:hidden;font:600 13px system-ui,sans-serif}' +
    '.view a{padding:6px 14px;color:#2B211B;text-decoration:none;background:#fff}.view a.on{background:#A8571F;color:#FFF8EC}' +
    '.where{color:#8F4818;font-weight:600}.where.off{color:#9b8775;font-weight:400}' +
    'form{display:inline}.row{display:flex;gap:8px;margin-bottom:8px}.row input{flex:1;min-width:0}' +
    'input{font:14px system-ui,sans-serif;padding:7px 10px;border:1px solid #DBC8AE;border-radius:4px;background:#FFFDF8}' +
    'button{font:600 13px system-ui,sans-serif;padding:8px 14px;border-radius:999px;border:1px solid #DBC8AE;background:#FAF4EA;cursor:pointer;color:#2B211B}' +
    'button.primary{background:#A8571F;border-color:#A8571F;color:#FFF8EC}button.delete{color:#9b2c2c}' +
    '.grip{flex:none;align-self:stretch;width:34px;padding:0;border:0;border-radius:3px;background:#F6EEE2;color:#9b8775;font-size:20px;cursor:grab;touch-action:none}' +
    '.grip:hover,.grip:focus-visible{background:#EFE2CE;color:#8F4818}' +
    '.file.dragging{opacity:.75;border-color:#A8571F;box-shadow:0 8px 24px rgba(64,42,25,.18)}.file.dragging .grip{cursor:grabbing}' +
    '.order-note{font:13px system-ui,sans-serif;color:#6B5748;min-height:1.4em;margin:0}' +
    '@media(max-width:520px){.file{flex-direction:column}.thumb{flex-basis:auto;width:100%;height:180px}' +
    '#sortable .file{flex-direction:row;flex-wrap:wrap}#sortable .thumb{flex:1 1 0;height:90px}#sortable .info{flex-basis:100%}.grip{align-self:auto;height:90px}}' +
    '.memorial textarea{box-sizing:border-box;width:100%;min-height:340px;font:17px/1.6 Georgia,serif;padding:12px 14px;border:1px solid #DBC8AE;border-radius:4px;background:#FFFDF8;color:#2B211B;resize:vertical;margin-bottom:10px}' +
    '.jump{font:14px system-ui,sans-serif;margin:-4px 0 0}' +
    '.out{float:right;font:13px system-ui,sans-serif;margin-top:14px}.out button{padding:6px 12px}' +
    '</style></head><body><main><form method="post" action="/media-admin/logout" class="out"><button>Sign out</button></form><h1>Scout’s media</h1>' +
    '<p class="jump"><a href="#memorial">Edit the memorial text ↓</a></p>' +
    (msg ? '<p class="msg">' + esc(msg) + '</p>' : '') +
    '<h2>Upload</h2>' +
    '<label class="drop" id="drop">Drop photos or videos here, or click to choose' +
    '<input type="file" id="pick" multiple accept="image/*,video/*,.mov,.m4v"></label><div id="progress"></div>' +
    note +
    '<div class="listhead"><h2>All media (' + files.length + ')</h2>' + toggle + '</div>' +
    (view === "order" && files.length > 1 ? '<p class="order-note" id="order-note" aria-live="polite"></p>' : '') + rows +
    '<h2 id="memorial">Memorial text</h2>' +
    '<p class="hint">This is the text in the Memorial section. Leave a blank line between paragraphs; the first paragraph gets the large first letter.</p>' +
    '<form method="post" class="memorial"><input type="hidden" name="action" value="memorial">' +
    '<textarea name="text" aria-label="Memorial text" maxlength="' + MAX_MEMORIAL + '">' + esc(memorial) + '</textarea>' +
    '<button class="primary">Save memorial text</button></form>' +
    '</main><script>(' + adminClient + ')();</script></body></html>';
  var headers = { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY" };
  if (cookie) headers["Set-Cookie"] = cookie;
  send(res, 200, html, headers);
}

function flagBoxes(file, gallery, slides) {
  return '<div class="flags" data-file="' + esc(file) + '">' +
    '<label><input type="checkbox" class="flag-gallery"' + (gallery ? ' checked' : '') + '> Gallery</label>' +
    '<label><input type="checkbox" class="flag-slides"' + (slides ? ' checked' : '') + '> Slideshow</label>' +
    '<span class="saved" aria-live="polite"></span></div>';
}

// Runs in the browser: adminPage inlines its source into the page.
function adminClient() {
  // POST a small form in the background; resolves, or rejects with the
  // server's error message.
  function post(fields) {
    return fetch("/media-admin", { method: "POST", body: new URLSearchParams(fields) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error); }); });
  }
  function report(note, p) {
    note.className = "saved"; note.textContent = "Saving…";
    p.then(function () { note.textContent = "Saved"; },
      function (e) { note.className = "saved err"; note.textContent = (e && e.message) || "Couldn’t save"; });
  }

  // Label each file with where it shows up, the way script.js picks:
  // gallery and slideshow = their ticked files, both in display order.
  function renumber() {
    var rows = Array.prototype.slice.call(document.querySelectorAll(".file[data-order]"));
    rows.sort(function (a, b) { return a.getAttribute("data-order") - b.getAttribute("data-order"); });
    var slide = 0, galleryN = 0;
    rows.forEach(function (r) {
      var where = r.querySelector(".where"), gallery = r.querySelector(".flag-gallery"), slides = r.querySelector(".flag-slides");
      if (!where || !slides) return;
      var parts = [];
      if (slides.checked) parts.push("Slide " + (++slide));
      if (gallery && gallery.checked) parts.push("Gallery " + (++galleryN));
      where.textContent = parts.length ? parts.join(" · ") : "Not on the page";
      where.className = parts.length ? "where" : "where off";
    });
  }
  renumber();
  document.querySelectorAll(".flags").forEach(function (box) {
    var gallery = box.querySelector(".flag-gallery"), slides = box.querySelector(".flag-slides"), note = box.querySelector(".saved");
    function save() {
      renumber();
      report(note, post({ action: "flags", file: box.getAttribute("data-file"), gallery: gallery && gallery.checked ? "1" : "", slideshow: slides.checked ? "1" : "" }));
    }
    if (gallery) gallery.addEventListener("change", save);
    slides.addEventListener("change", save);
  });
  // Captions save when you leave the box (or press Enter).
  document.querySelectorAll("input.caption").forEach(function (input) {
    var file = input.closest(".file").getAttribute("data-file");
    var note = input.closest(".file").querySelector(".saved");
    var saved = input.value;
    input.addEventListener("change", function () {
      if (input.value === saved) return;
      var value = input.value;
      var p = post({ action: "caption", file: file, caption: value });
      p.then(function () { saved = value; }, function () {});
      report(note, p);
    });
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); input.blur(); } });
  });
  document.querySelectorAll("form[data-confirm]").forEach(function (f) {
    f.addEventListener("submit", function (e) { if (!confirm(f.getAttribute("data-confirm"))) e.preventDefault(); });
  });

  // Display order view: drag a row by its handle (mouse or finger), or focus
  // the handle and use the arrow keys. The new order saves when you let go.
  var sortable = document.getElementById("sortable");
  var orderNote = document.getElementById("order-note");
  if (sortable) {
    var saveOrder = function () {
      var rows = Array.prototype.slice.call(sortable.querySelectorAll(".file"));
      rows.forEach(function (r, i) { r.setAttribute("data-order", i); });
      renumber();
      orderNote.className = "order-note"; orderNote.textContent = "Saving the new order…";
      post({ action: "order", order: rows.map(function (r) { return r.getAttribute("data-file"); }).join("\n") })
        .then(function () { orderNote.textContent = "Order saved."; },
          function (e) { orderNote.className = "order-note saved err"; orderNote.textContent = (e && e.message) || "Couldn’t save the order."; });
    };
    var drag = null, scrollTimer = null;
    sortable.addEventListener("pointerdown", function (e) {
      var grip = e.target.closest(".grip");
      if (!grip || e.button > 0) return;
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      drag = { row: grip.closest(".file"), grip: grip, y: e.clientY, moved: false };
      drag.row.classList.add("dragging");
      // Scroll the page while the finger or mouse is near the top or bottom.
      scrollTimer = setInterval(function () {
        if (!drag) return;
        var edge = 70, h = window.innerHeight;
        if (drag.y < edge) window.scrollBy(0, -Math.ceil((edge - drag.y) / 4));
        else if (drag.y > h - edge) window.scrollBy(0, Math.ceil((drag.y - (h - edge)) / 4));
        else return;
        place();
      }, 16);
    });
    // Move the dragged row to wherever the pointer is among the others.
    var place = function () {
      var rows = Array.prototype.slice.call(sortable.querySelectorAll(".file"));
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (r === drag.row) continue;
        var box = r.getBoundingClientRect();
        if (drag.y < box.top + box.height / 2) {
          if (drag.row.nextElementSibling !== r) { sortable.insertBefore(drag.row, r); drag.moved = true; }
          return;
        }
      }
      if (sortable.lastElementChild !== drag.row) { sortable.appendChild(drag.row); drag.moved = true; }
    };
    sortable.addEventListener("pointermove", function (e) {
      if (!drag) return;
      drag.y = e.clientY;
      place();
    });
    var endDrag = function () {
      if (!drag) return;
      clearInterval(scrollTimer);
      drag.row.classList.remove("dragging");
      var moved = drag.moved;
      drag = null;
      if (moved) saveOrder();
    };
    sortable.addEventListener("pointerup", endDrag);
    sortable.addEventListener("pointercancel", endDrag);
    sortable.addEventListener("keydown", function (e) {
      var grip = e.target.closest(".grip");
      if (!grip || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
      e.preventDefault();
      var row = grip.closest(".file");
      var other = e.key === "ArrowUp" ? row.previousElementSibling : row.nextElementSibling;
      if (!other) return;
      sortable.insertBefore(row, e.key === "ArrowUp" ? other : other.nextElementSibling);
      grip.focus();
      grip.scrollIntoView({ block: "nearest" });
      saveOrder();
    });
  }

  var drop = document.getElementById("drop"), pick = document.getElementById("pick"), prog = document.getElementById("progress");
  if (!drop) return;
  pick.addEventListener("change", function () { start(pick.files); });
  ["dragenter", "dragover"].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add("over"); }); });
  ["dragleave", "drop"].forEach(function (t) { drop.addEventListener(t, function () { drop.classList.remove("over"); }); });
  drop.addEventListener("drop", function (e) { e.preventDefault(); start(e.dataTransfer.files); });
  function start(list) {
    var files = Array.prototype.slice.call(list), ok = 0;
    (function next() {
      var file = files.shift();
      if (!file) { if (ok) location.href = "/media-admin?msg=" + encodeURIComponent("Uploaded " + ok + " file" + (ok === 1 ? "" : "s") + "."); return; }
      var line = document.createElement("div"); line.textContent = file.name + ": starting…"; prog.appendChild(line);
      send(file, false);
      function send(file, replace) {
        var xhr = new XMLHttpRequest();
        xhr.open("POST", "/media-admin/upload?name=" + encodeURIComponent(file.name) + (replace ? "&replace=1" : ""));
        xhr.upload.onprogress = function (e) { if (e.lengthComputable) line.textContent = file.name + ": " + Math.round(e.loaded / e.total * 100) + "%"; };
        xhr.onload = function () {
          var r = {}; try { r = JSON.parse(xhr.responseText); } catch (e) {}
          if (xhr.status === 201) { ok++; line.textContent = file.name + ": done"; return next(); }
          if (xhr.status === 409 && confirm("There’s already a file called " + r.name + ". Replace it?")) return send(file, true);
          line.className = "err"; line.textContent = file.name + ": " + (xhr.status === 409 ? "skipped" : xhr.status === 413 ? "too big (1 GB max)" : r.error || "failed (" + xhr.status + ")");
          next();
        };
        xhr.onerror = function () { line.className = "err"; line.textContent = file.name + ": upload failed"; next(); };
        xhr.send(file);
      }
    })();
  }
}

// ---- routing ----

http.createServer(function (req, res) {
  var u = new URL(req.url, "http://x");
  if (["/media-admin", "/media-admin/upload", "/media-admin/login", "/media-admin/logout"].indexOf(u.pathname) < 0) return send(res, 404, "Not found");
  if (u.pathname === "/media-admin/login" && req.method === "POST") return sameOrigin(req) ? login(req, res) : send(res, 403, "Forbidden");
  if (u.pathname === "/media-admin/logout" && req.method === "POST") {
    return send(res, 303, "", { Location: "/media-admin", "Set-Cookie": "scout_media=; Path=/media-admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict" });
  }
  if (!isAdmin(req)) {
    if (req.method === "GET" && u.pathname === "/media-admin") return loginPage(res, "");
    return json(res, 401, { error: "You've been signed out. Reload the page and sign in again." });
  }
  if (req.method === "GET" && u.pathname === "/media-admin") return adminPage(req, res, u.searchParams);
  if (req.method !== "POST") return send(res, 405, "Method not allowed", { Allow: "GET, POST" });
  if (!sameOrigin(req)) return send(res, 403, "Forbidden");
  if (u.pathname === "/media-admin/upload") return upload(req, res, u.searchParams);
  action(req, res);
}).listen(PORT, HOST, function () {
  console.log("scout-media listening on " + HOST + ":" + PORT + ", managing " + MEDIA_ROOT);
});
