/* Media manager for Scout: a tiny dependency-free backend.

   /media-admin (sign in with ADMIN_PASSWORD; a signed cookie keeps you in) lists every
   folder under media/, and lets the owner upload, rename and delete files and
   create or remove folders. Uploads are streamed straight to disk, one file
   per request, with the file as the raw request body. In the slideshow
   folder each file also has two checkboxes, kept as plain lists the page
   reads (one filename per line): hidden.txt names files not shown on the site
   (everything is shown unless listed), slideshow.txt names files in the
   slideshow (nothing is unless listed). nginx proxies
   /media-admin here; see server/README.md for the systemd unit and nginx
   config. */

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
var MAX_FORM = 16 * 1024;
var SESSION_MS = 30 * 24 * 60 * 60e3; // stay signed in for 30 days
var LOGIN_LIMIT = 10;                 // wrong passwords per visitor...
var LOGIN_WINDOW_MS = 15 * 60e3;      // ...per 15 minutes
var MEDIA_EXT = /\.(jpe?g|png|gif|webp|avif|mp4|webm|mov|m4v)$/i;
var VIDEO_EXT = /\.(mp4|webm|mov|m4v)$/i;
var GIF_EXT = /\.gif$/i;
// How the file list is grouped on the admin page, in this order.
var KINDS = [["image", "Images"], ["gif", "GIFs"], ["video", "Videos"], ["other", "Other files"]];
// Folders the page itself depends on; they can't be removed from here.
var CORE_DIRS = ["pictures", "slideshow", "videos"];
// Files index.html points at directly; deleting them breaks the page.
var IN_USE = ["pictures/my_scouty_boy.jpg", "videos/scout_good_catch.mp4"];
// The folder script.js builds the slideshow and gallery from, and its lists.
var FLAG_DIR = "slideshow";
var HIDDEN_LIST = "hidden.txt";
var SLIDES_LIST = "slideshow.txt";

// ---- names and paths ----

function validDir(name) {
  return typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name);
}

function validFile(name) {
  return typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,150}$/.test(name) &&
    name.indexOf("..") < 0 && MEDIA_EXT.test(name);
}

// Turn an uploaded file's name into one validFile accepts.
function cleanName(name) {
  return String(name || "").replace(/[^A-Za-z0-9 ._()-]+/g, "_").replace(/\.{2,}/g, ".")
    .replace(/^[^A-Za-z0-9]+/, "").slice(-150);
}

function dirPath(dir) { return path.join(MEDIA_ROOT, dir); }
function filePath(dir, name) { return path.join(MEDIA_ROOT, dir, name); }

function listDirs() {
  return fs.readdirSync(MEDIA_ROOT, { withFileTypes: true })
    .filter(function (d) { return d.isDirectory() && validDir(d.name); })
    .map(function (d) { return d.name; })
    .sort(naturalCompare);
}

function listFiles(dir) {
  return fs.readdirSync(dirPath(dir), { withFileTypes: true })
    .filter(function (d) {
      return d.isFile() && d.name.charAt(0) !== "." && !(dir === FLAG_DIR && (d.name === HIDDEN_LIST || d.name === SLIDES_LIST));
    })
    .map(function (d) { return { name: d.name, size: fs.statSync(filePath(dir, d.name)).size }; })
    .sort(function (a, b) { return naturalCompare(a.name, b.name); });
}

// Same order the slideshow uses.
function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

// ---- show / slideshow lists ----

function readList(name) {
  try {
    return fs.readFileSync(filePath(FLAG_DIR, name), "utf8").split("\n")
      .map(function (l) { return l.trim(); }).filter(Boolean);
  } catch (e) { if (e.code !== "ENOENT") throw e; return []; }
}

function writeList(name, list) {
  var seen = {};
  list = list.filter(function (f) { return !seen[f] && (seen[f] = true); }).sort(naturalCompare);
  var tmp = filePath(FLAG_DIR, "." + name + ".tmp");
  fs.writeFileSync(tmp, list.length ? list.join("\n") + "\n" : "");
  fs.renameSync(tmp, filePath(FLAG_DIR, name));
}

// Put file on the named list (on) or take it off.
function setFlag(name, file, on) {
  var list = readList(name).filter(function (f) { return f !== file; });
  if (on) list.push(file);
  writeList(name, list);
}

// After a delete (or rename), drop the old name from both lists (or carry
// its ticks over to the new name).
function forgetFile(dir, file, renamedTo) {
  if (dir !== FLAG_DIR) return;
  [HIDDEN_LIST, SLIDES_LIST].forEach(function (name) {
    var list = readList(name);
    if (list.indexOf(file) < 0) return;
    setFlag(name, file, false);
    if (renamedTo) setFlag(name, renamedTo, true);
  });
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
  var dir = query.get("dir"), name = cleanName(query.get("name"));
  if (!validDir(dir) || !fs.existsSync(dirPath(dir))) return json(res, 400, { error: "That folder doesn't exist." });
  if (!validFile(name)) return json(res, 400, { error: "Only photos and videos (jpg, png, gif, webp, avif, mp4, webm, mov, m4v) can be uploaded." });
  if (Number(req.headers["content-length"]) > MAX_UPLOAD) return json(res, 413, { error: "That file is over 1 GB." });
  var dest = filePath(dir, name);
  if (fs.existsSync(dest) && query.get("replace") !== "1") return json(res, 409, { error: "exists", name: name });

  // Write to a hidden temp file (nginx won't list or serve dotfiles), then
  // move it into place so the site never sees half a file.
  var tmp = filePath(dir, "." + name + "." + crypto.randomBytes(4).toString("hex") + ".part");
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
    var dir = f.dir, msg = "";
    // The checkboxes save in the background and get JSON back.
    if (f.action === "flags") {
      if (dir !== FLAG_DIR || !validFile(f.file) || !fs.existsSync(filePath(dir, f.file))) return json(res, 400, { error: "That file is gone." });
      try {
        setFlag(HIDDEN_LIST, f.file, f.shown !== "1");
        setFlag(SLIDES_LIST, f.file, f.slideshow === "1");
      } catch (e) { console.error(e); return json(res, 500, { error: "Couldn't save." }); }
      return json(res, 200, { ok: true });
    }
    try {
      if (f.action === "mkdir") {
        var name = String(f.name || "").trim().toLowerCase().replace(/\s+/g, "_");
        if (!validDir(name)) msg = "Folder names can use letters, numbers, - and _ only.";
        else if (fs.existsSync(dirPath(name))) msg = "There's already a folder called " + name + ".";
        else { fs.mkdirSync(dirPath(name)); dir = name; msg = "Created folder " + name + "."; }
      } else if (f.action === "rmdir") {
        if (!validDir(dir) || CORE_DIRS.indexOf(dir) >= 0) msg = "That folder can't be removed.";
        else if (listFiles(dir).length) msg = "Delete the files in " + dir + " first.";
        else { fs.rmSync(dirPath(dir), { recursive: true }); msg = "Removed folder " + dir + "."; dir = ""; }
      } else if (f.action === "delete") {
        if (!validDir(dir) || !validFile(f.file) || !fs.existsSync(filePath(dir, f.file))) msg = "That file is already gone.";
        else { fs.unlinkSync(filePath(dir, f.file)); forgetFile(dir, f.file); msg = "Deleted " + f.file + "."; }
      } else if (f.action === "rename") {
        var to = cleanName(f.to);
        if (!MEDIA_EXT.test(to)) to += path.extname(f.file || "");
        if (!validDir(dir) || !validFile(f.file) || !fs.existsSync(filePath(dir, f.file))) msg = "That file is gone.";
        else if (!validFile(to)) msg = "That name won't work; keep the file extension and use letters, numbers, spaces, . _ - ( ).";
        else if (to !== f.file && fs.existsSync(filePath(dir, to))) msg = "There's already a file called " + to + ".";
        else if (to !== f.file) { fs.renameSync(filePath(dir, f.file), filePath(dir, to)); forgetFile(dir, f.file, to); msg = "Renamed to " + to + "."; }
      }
    } catch (e) {
      console.error(e);
      msg = "Something went wrong: " + e.code;
    }
    var q = new URLSearchParams();
    if (validDir(dir)) q.set("dir", dir);
    if (msg) q.set("msg", msg);
    send(res, 303, "", { Location: "/media-admin?" + q });
  });
}

// ---- admin page ----

function kindOf(name) {
  return VIDEO_EXT.test(name) ? "video" : GIF_EXT.test(name) ? "gif" : MEDIA_EXT.test(name) ? "image" : "other";
}

function adminPage(req, res, query) {
  // "type" groups the list by kind; "order" is one list in display order.
  // The choice sticks in a cookie.
  var view = query.get("view"), cookie = null;
  if (view === "type" || view === "order") cookie = "media_view=" + view + "; Path=/media-admin; Max-Age=31536000; HttpOnly; Secure; SameSite=Strict";
  else view = /(?:^|;\s*)media_view=order/.test(req.headers.cookie || "") ? "order" : "type";
  var dirs = listDirs();
  var dir = query.get("dir");
  if (dirs.indexOf(dir) < 0) dir = dirs.indexOf("slideshow") >= 0 ? "slideshow" : dirs[0];
  var files = dir ? listFiles(dir) : [];
  var msg = query.get("msg");
  var hiddenList = dir === FLAG_DIR ? readList(HIDDEN_LIST) : [];
  var slidesList = dir === FLAG_DIR ? readList(SLIDES_LIST) : [];

  var tabs = dirs.map(function (d) {
    return '<a class="tab' + (d === dir ? ' on' : '') + '" href="/media-admin?dir=' + encodeURIComponent(d) + '">' + esc(d) + '</a>';
  }).join("");

  function row(f) {
    var url = "/media/" + encodeURIComponent(dir) + "/" + encodeURIComponent(f.name);
    var thumb = VIDEO_EXT.test(f.name)
      ? '<video src="' + esc(url) + '#t=0.5" preload="metadata" muted></video>'
      : MEDIA_EXT.test(f.name) ? '<img src="' + esc(url) + '" loading="lazy" alt="">' : '<span class="nothumb">file</span>';
    var inUse = IN_USE.indexOf(dir + "/" + f.name) >= 0;
    var hidden = '<input type="hidden" name="dir" value="' + esc(dir) + '"><input type="hidden" name="file" value="' + esc(f.name) + '">';
    return '<div class="file" data-order="' + f.order + '" data-kind="' + kindOf(f.name) + '"><a class="thumb" href="' + esc(url) + '" target="_blank">' + thumb + '</a>' +
      '<div class="info"><div class="name">' + esc(f.name) + '</div><div class="meta">' + fmtSize(f.size) +
      (dir === FLAG_DIR ? ' · <span class="where"></span>' : '') +
      (inUse ? ' · <b>used on the page</b>' : '') + '</div>' +
      (dir === FLAG_DIR ? flagBoxes(f.name, hiddenList.indexOf(f.name) < 0, slidesList.indexOf(f.name) >= 0) : '') +
      '<form method="post" class="row">' + hidden + '<input type="hidden" name="action" value="rename">' +
      '<input name="to" value="' + esc(f.name) + '" aria-label="New name"><button>Rename</button></form>' +
      '<form method="post" data-confirm="Delete ' + esc(f.name) + '?' + (inUse ? ' The page uses this file directly and will show an empty spot without it.' : '') + '">' +
      hidden + '<button name="action" value="delete" class="delete">Delete</button></form></div></div>';
  }

  // listFiles is already in display (filename) order.
  files.forEach(function (f, i) { f.order = i; });
  var rows;
  if (!files.length) rows = '<p class="none">No files in this folder yet.</p>';
  else if (view === "order") rows = files.map(row).join("");
  else rows = KINDS.map(function (k) {
    var group = files.filter(function (f) { return kindOf(f.name) === k[0]; });
    return group.length ? '<h3>' + k[1] + ' (' + group.length + ')</h3>' + group.map(row).join("") : '';
  }).join("");
  var viewLink = function (v, label) {
    return '<a href="/media-admin?dir=' + encodeURIComponent(dir) + '&view=' + v + '"' + (view === v ? ' class="on" aria-current="true"' : '') + '>' + label + '</a>';
  };
  var toggle = files.length ? '<div class="view">' + viewLink("type", "By type") + viewLink("order", dir === FLAG_DIR ? "Display order" : "By name") + '</div>' : '';

  var note = dir === "slideshow"
    ? '<p class="hint"><b>Shown on site</b> photos appear in the gallery grid; tick <b>In slideshow</b> as well to add a photo or video to the slideshow. New uploads are shown but not in the slideshow. Slides play in filename order, so start names with numbers (01_, 02_, …) and rename to reorder.</p>'
    : CORE_DIRS.indexOf(dir) < 0 ? '<p class="hint">Files in this folder are online at /media/' + esc(dir) + '/… but no section of the page shows them yet.</p>' : '';

  var html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Scout media</title><style>' +
    'body{margin:0;padding:24px 20px 60px;background:#FAF4EA;color:#2B211B;font:16px/1.6 Georgia,serif}' +
    'main{max-width:820px;margin:0 auto}h1{font-weight:400;margin-bottom:8px}' +
    'h2{font:600 13px system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:#8F4818;margin:36px 0 12px}' +
    '.tabs{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}.tab{font:600 14px system-ui,sans-serif;padding:7px 14px;border-radius:999px;border:1px solid #DBC8AE;color:#2B211B;text-decoration:none;background:#fff}' +
    '.tab.on{background:#A8571F;border-color:#A8571F;color:#FFF8EC}' +
    '.msg{background:#FFF1D6;border:1px solid #E8C98F;border-radius:4px;padding:10px 14px;font:14px system-ui,sans-serif}' +
    '.hint,.none{color:#6B5748;font-size:15px}' +
    '.drop{border:2px dashed #DBC8AE;border-radius:6px;padding:28px 16px;text-align:center;background:#fff;font:15px system-ui,sans-serif;color:#6B5748;cursor:pointer}' +
    '.drop.over{border-color:#A8571F;background:#FFF8EC}.drop input{display:none}' +
    '#progress{font:14px system-ui,sans-serif;margin-top:10px}#progress div{margin:4px 0}#progress .err{color:#9b2c2c}' +
    '.file{display:flex;gap:16px;background:#fff;border:1px solid #E5D6C0;border-radius:4px;padding:12px;margin:10px 0;align-items:flex-start}' +
    '.thumb{flex:0 0 120px;height:90px;background:#F1E6D4;border-radius:3px;overflow:hidden;display:flex;align-items:center;justify-content:center}' +
    '.thumb img,.thumb video{width:100%;height:100%;object-fit:cover}.nothumb{font:13px system-ui;color:#6B5748}' +
    '.info{flex:1;min-width:0}.name{font:600 15px system-ui,sans-serif;word-break:break-all}.meta{font:13px system-ui,sans-serif;color:#6B5748;margin-bottom:8px}' +
    '.flags{display:flex;flex-wrap:wrap;gap:6px 18px;align-items:center;font:14px system-ui,sans-serif;margin-bottom:10px}' +
    '.flags label{display:flex;gap:6px;align-items:center;cursor:pointer}.flags label.off{color:#B3A08C}.flags input{width:17px;height:17px;padding:0;margin:0;accent-color:#A8571F}' +
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
    '.folders{display:flex;flex-wrap:wrap;gap:8px;align-items:center}' +
    '@media(max-width:520px){.file{flex-direction:column}.thumb{flex-basis:auto;width:100%;height:180px}}' +
    '.out{float:right;font:13px system-ui,sans-serif;margin-top:14px}.out button{padding:6px 12px}' +
    '</style></head><body><main><form method="post" action="/media-admin/logout" class="out"><button>Sign out</button></form><h1>Scout’s media</h1>' +
    (msg ? '<p class="msg">' + esc(msg) + '</p>' : '') +
    '<div class="tabs">' + tabs + '</div>' +
    (dir ? '<h2>Upload to ' + esc(dir) + '</h2>' +
      '<label class="drop" id="drop">Drop photos or videos here, or click to choose' +
      '<input type="file" id="pick" multiple accept="image/*,video/*,.mov,.m4v"></label><div id="progress"></div>' +
      note +
      '<div class="listhead"><h2>In ' + esc(dir) + ' (' + files.length + ')</h2>' + toggle + '</div>' + rows : '') +
    '<h2>Folders</h2><div class="folders">' +
    '<form method="post"><input type="hidden" name="action" value="mkdir"><input name="name" placeholder="new_folder_name" required> <button class="primary">Create folder</button></form>' +
    (dir && CORE_DIRS.indexOf(dir) < 0 ? '<form method="post" data-confirm="Remove the empty folder ' + esc(dir) + '?"><input type="hidden" name="dir" value="' + esc(dir) + '"><button name="action" value="rmdir" class="delete">Remove ' + esc(dir) + '</button></form>' : '') +
    '</div></main><script>' + clientScript(dir) + '</script></body></html>';
  var headers = { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY" };
  if (cookie) headers["Set-Cookie"] = cookie;
  send(res, 200, html, headers);
}

function flagBoxes(file, shown, slides) {
  return '<div class="flags" data-file="' + esc(file) + '">' +
    '<label><input type="checkbox" class="flag-shown"' + (shown ? ' checked' : '') + '> Shown on site</label>' +
    '<label' + (shown ? '' : ' class="off"') + '><input type="checkbox" class="flag-slides"' + (slides ? ' checked' : '') + (shown ? '' : ' disabled') + '> In slideshow</label>' +
    '<span class="saved" aria-live="polite"></span></div>';
}

function clientScript(dir) {
  return '(function () {' +
    'var DIR = ' + JSON.stringify(dir || "").replace(/</g, "\\u003c") + ';' +
    // Label each file with where it shows up, the way script.js picks:
    // gallery = shown images and GIFs, slideshow = shown and ticked, both
    // in filename order.
    'function renumber() {' +
    '  var rows = Array.prototype.slice.call(document.querySelectorAll(".file[data-order]"));' +
    '  rows.sort(function (a, b) { return a.getAttribute("data-order") - b.getAttribute("data-order"); });' +
    '  var slide = 0, gallery = 0;' +
    '  rows.forEach(function (r) {' +
    '    var where = r.querySelector(".where"), shown = r.querySelector(".flag-shown"), slides = r.querySelector(".flag-slides");' +
    '    if (!where || !shown) return;' +
    '    var kind = r.getAttribute("data-kind"), parts = [];' +
    '    if (shown.checked && slides.checked) parts.push("Slide " + (++slide));' +
    '    if (shown.checked && (kind === "image" || kind === "gif")) parts.push("Gallery " + (++gallery));' +
    '    where.textContent = !shown.checked ? "Hidden" : parts.length ? parts.join(" · ") : "Not on the page";' +
    '    where.className = parts.length ? "where" : "where off";' +
    '  });' +
    '}' +
    'renumber();' +
    'document.querySelectorAll(".flags").forEach(function (box) {' +
    '  var shown = box.querySelector(".flag-shown"), slides = box.querySelector(".flag-slides"), note = box.querySelector(".saved");' +
    '  function save() {' +
    '    slides.disabled = !shown.checked; slides.parentNode.classList.toggle("off", !shown.checked); renumber();' +
    '    note.className = "saved"; note.textContent = "Saving…";' +
    '    var body = new URLSearchParams({ action: "flags", dir: DIR, file: box.getAttribute("data-file"), shown: shown.checked ? "1" : "", slideshow: slides.checked ? "1" : "" });' +
    '    fetch("/media-admin", { method: "POST", body: body }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error); }); })' +
    '      .then(function () { note.textContent = "Saved"; }, function (e) { note.className = "saved err"; note.textContent = (e && e.message) || "Couldn\u2019t save"; });' +
    '  }' +
    '  shown.addEventListener("change", save); slides.addEventListener("change", save);' +
    '});' +
    'document.querySelectorAll("form[data-confirm]").forEach(function (f) {' +
    '  f.addEventListener("submit", function (e) { if (!confirm(f.getAttribute("data-confirm"))) e.preventDefault(); });' +
    '});' +
    'var drop = document.getElementById("drop"), pick = document.getElementById("pick"), prog = document.getElementById("progress");' +
    'if (!drop) return;' +
    'pick.addEventListener("change", function () { start(pick.files); });' +
    '["dragenter", "dragover"].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add("over"); }); });' +
    '["dragleave", "drop"].forEach(function (t) { drop.addEventListener(t, function () { drop.classList.remove("over"); }); });' +
    'drop.addEventListener("drop", function (e) { e.preventDefault(); start(e.dataTransfer.files); });' +
    'function start(list) {' +
    '  var files = Array.prototype.slice.call(list), ok = 0;' +
    '  (function next() {' +
    '    var file = files.shift();' +
    '    if (!file) { if (ok) location.href = "/media-admin?dir=" + encodeURIComponent(DIR) + "&msg=" + encodeURIComponent("Uploaded " + ok + " file" + (ok === 1 ? "" : "s") + "."); return; }' +
    '    var line = document.createElement("div"); line.textContent = file.name + ": starting…"; prog.appendChild(line);' +
    '    send(file, false);' +
    '    function send(file, replace) {' +
    '      var xhr = new XMLHttpRequest();' +
    '      xhr.open("POST", "/media-admin/upload?dir=" + encodeURIComponent(DIR) + "&name=" + encodeURIComponent(file.name) + (replace ? "&replace=1" : ""));' +
    '      xhr.upload.onprogress = function (e) { if (e.lengthComputable) line.textContent = file.name + ": " + Math.round(e.loaded / e.total * 100) + "%"; };' +
    '      xhr.onload = function () {' +
    '        var r = {}; try { r = JSON.parse(xhr.responseText); } catch (e) {}' +
    '        if (xhr.status === 201) { ok++; line.textContent = file.name + ": done"; return next(); }' +
    '        if (xhr.status === 409 && confirm(r.name + " already exists in " + DIR + ". Replace it?")) return send(file, true);' +
    '        line.className = "err"; line.textContent = file.name + ": " + (xhr.status === 409 ? "skipped" : xhr.status === 413 ? "too big (1 GB max)" : r.error || "failed (" + xhr.status + ")");' +
    '        next();' +
    '      };' +
    '      xhr.onerror = function () { line.className = "err"; line.textContent = file.name + ": upload failed"; next(); };' +
    '      xhr.send(file);' +
    '    }' +
    '  })();' +
    '}' +
    '})();';
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
