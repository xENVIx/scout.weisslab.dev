/* Media manager for Scout: a tiny dependency-free backend.

   /media-admin (HTTP basic auth, password from ADMIN_PASSWORD) lists every
   folder under media/, and lets the owner upload, rename and delete files and
   create or remove folders. Uploads are streamed straight to disk, one file
   per request, with the file as the raw request body. nginx proxies
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
var MEDIA_EXT = /\.(jpe?g|png|gif|webp|avif|mp4|webm|mov|m4v)$/i;
var VIDEO_EXT = /\.(mp4|webm|mov|m4v)$/i;
// Folders the page itself depends on; they can't be removed from here.
var CORE_DIRS = ["pictures", "slideshow", "videos"];
// Files index.html points at directly; deleting them breaks the page.
var IN_USE = ["pictures/my_scouty_boy.jpg", "videos/scout_good_catch.mp4"];

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
    .filter(function (d) { return d.isFile() && d.name.charAt(0) !== "."; })
    .map(function (d) { return { name: d.name, size: fs.statSync(filePath(dir, d.name)).size }; })
    .sort(function (a, b) { return naturalCompare(a.name, b.name); });
}

// Same order the slideshow uses.
function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
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

function isAdmin(req) {
  if (!ADMIN_PASSWORD) return false;
  var m = /^Basic (.+)$/.exec(req.headers.authorization || "");
  if (!m) return false;
  var decoded = Buffer.from(m[1], "base64").toString("utf8");
  var pass = decoded.slice(decoded.indexOf(":") + 1);
  return crypto.timingSafeEqual(sha(pass), sha(ADMIN_PASSWORD));
}

// Browsers send basic-auth credentials automatically, so admin POSTs must
// come from this site's own pages, not a form on some other site.
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
        else { fs.unlinkSync(filePath(dir, f.file)); msg = "Deleted " + f.file + "."; }
      } else if (f.action === "rename") {
        var to = cleanName(f.to);
        if (!MEDIA_EXT.test(to)) to += path.extname(f.file || "");
        if (!validDir(dir) || !validFile(f.file) || !fs.existsSync(filePath(dir, f.file))) msg = "That file is gone.";
        else if (!validFile(to)) msg = "That name won't work; keep the file extension and use letters, numbers, spaces, . _ - ( ).";
        else if (to !== f.file && fs.existsSync(filePath(dir, to))) msg = "There's already a file called " + to + ".";
        else { fs.renameSync(filePath(dir, f.file), filePath(dir, to)); msg = "Renamed to " + to + "."; }
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

function adminPage(res, query) {
  var dirs = listDirs();
  var dir = query.get("dir");
  if (dirs.indexOf(dir) < 0) dir = dirs.indexOf("slideshow") >= 0 ? "slideshow" : dirs[0];
  var files = dir ? listFiles(dir) : [];
  var msg = query.get("msg");

  var tabs = dirs.map(function (d) {
    return '<a class="tab' + (d === dir ? ' on' : '') + '" href="/media-admin?dir=' + encodeURIComponent(d) + '">' + esc(d) + '</a>';
  }).join("");

  var rows = files.length ? files.map(function (f) {
    var url = "/media/" + encodeURIComponent(dir) + "/" + encodeURIComponent(f.name);
    var thumb = VIDEO_EXT.test(f.name)
      ? '<video src="' + esc(url) + '#t=0.5" preload="metadata" muted></video>'
      : MEDIA_EXT.test(f.name) ? '<img src="' + esc(url) + '" loading="lazy" alt="">' : '<span class="nothumb">file</span>';
    var inUse = IN_USE.indexOf(dir + "/" + f.name) >= 0;
    var hidden = '<input type="hidden" name="dir" value="' + esc(dir) + '"><input type="hidden" name="file" value="' + esc(f.name) + '">';
    return '<div class="file"><a class="thumb" href="' + esc(url) + '" target="_blank">' + thumb + '</a>' +
      '<div class="info"><div class="name">' + esc(f.name) + '</div><div class="meta">' + fmtSize(f.size) +
      (inUse ? ' · <b>used on the page</b>' : '') + '</div>' +
      '<form method="post" class="row">' + hidden + '<input type="hidden" name="action" value="rename">' +
      '<input name="to" value="' + esc(f.name) + '" aria-label="New name"><button>Rename</button></form>' +
      '<form method="post" data-confirm="Delete ' + esc(f.name) + '?' + (inUse ? ' The page uses this file directly and will show an empty spot without it.' : '') + '">' +
      hidden + '<button name="action" value="delete" class="delete">Delete</button></form></div></div>';
  }).join("") : '<p class="none">No files in this folder yet.</p>';

  var note = dir === "slideshow"
    ? '<p class="hint">Everything here plays in the slideshow, and photos also appear in the gallery grid. Slides play in filename order, so start names with numbers (01_, 02_, …) and rename to reorder.</p>'
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
    'form{display:inline}.row{display:flex;gap:8px;margin-bottom:8px}.row input{flex:1;min-width:0}' +
    'input{font:14px system-ui,sans-serif;padding:7px 10px;border:1px solid #DBC8AE;border-radius:4px;background:#FFFDF8}' +
    'button{font:600 13px system-ui,sans-serif;padding:8px 14px;border-radius:999px;border:1px solid #DBC8AE;background:#FAF4EA;cursor:pointer;color:#2B211B}' +
    'button.primary{background:#A8571F;border-color:#A8571F;color:#FFF8EC}button.delete{color:#9b2c2c}' +
    '.folders{display:flex;flex-wrap:wrap;gap:8px;align-items:center}' +
    '@media(max-width:520px){.file{flex-direction:column}.thumb{flex-basis:auto;width:100%;height:180px}}' +
    '</style></head><body><main><h1>Scout’s media</h1>' +
    (msg ? '<p class="msg">' + esc(msg) + '</p>' : '') +
    '<div class="tabs">' + tabs + '</div>' +
    (dir ? '<h2>Upload to ' + esc(dir) + '</h2>' +
      '<label class="drop" id="drop">Drop photos or videos here, or click to choose' +
      '<input type="file" id="pick" multiple accept="image/*,video/*,.mov,.m4v"></label><div id="progress"></div>' +
      note +
      '<h2>In ' + esc(dir) + ' (' + files.length + ')</h2>' + rows : '') +
    '<h2>Folders</h2><div class="folders">' +
    '<form method="post"><input type="hidden" name="action" value="mkdir"><input name="name" placeholder="new_folder_name" required> <button class="primary">Create folder</button></form>' +
    (dir && CORE_DIRS.indexOf(dir) < 0 ? '<form method="post" data-confirm="Remove the empty folder ' + esc(dir) + '?"><input type="hidden" name="dir" value="' + esc(dir) + '"><button name="action" value="rmdir" class="delete">Remove ' + esc(dir) + '</button></form>' : '') +
    '</div></main><script>' + clientScript(dir) + '</script></body></html>';
  send(res, 200, html, { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY" });
}

function clientScript(dir) {
  return '(function () {' +
    'var DIR = ' + JSON.stringify(dir || "").replace(/</g, "\\u003c") + ';' +
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
  if (u.pathname !== "/media-admin" && u.pathname !== "/media-admin/upload") return send(res, 404, "Not found");
  if (!isAdmin(req)) return send(res, 401, "Password required", { "WWW-Authenticate": 'Basic realm="Scout media"' });
  if (req.method === "GET" && u.pathname === "/media-admin") return adminPage(res, u.searchParams);
  if (req.method !== "POST") return send(res, 405, "Method not allowed", { Allow: "GET, POST" });
  if (!sameOrigin(req)) return send(res, 403, "Forbidden");
  if (u.pathname === "/media-admin/upload") return upload(req, res, u.searchParams);
  action(req, res);
}).listen(PORT, HOST, function () {
  console.log("scout-media listening on " + HOST + ":" + PORT + ", managing " + MEDIA_ROOT);
});
