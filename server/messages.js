/* Messages for Scout: a tiny dependency-free backend.

   Visitors POST a message to /api/messages, with up to MAX_FILES photos,
   GIFs and videos (the text is optional when there's one). Each file is
   uploaded first, on its own, to /api/messages/upload (streamed to disk,
   checked by its first bytes), which hands back a token; the message then
   names its files by those tokens. A message is
   stored as pending and only shows up in GET /api/messages once approved at
   /messages-admin. That page uses the site's one admin sign-in, run by the
   media manager (server/media.js) at /admin/login: its scout_admin cookie
   is signed with SESSION_SECRET, which both servers' env files hold, and
   checked here the same way. nginx proxies both paths here; see
   server/README.md for the systemd unit and nginx config.

   Storage is a single JSON file in $STATE_DIRECTORY (systemd sets this to
   /var/lib/scout-messages), never inside the web root, with the files
   beside it in photos/ (uploads not yet in a message wait in uploads/, and
   go after UPLOAD_TTL_MS). File n of a message is served at
   /api/messages/file/<id>/<n> once it's approved (with Range requests, for
   video), and at /messages-admin/file/<id>/<n> to the admin any time. From
   the admin page a file can be copied into the site's
   media/ folder: this server can't write there, so it hands the file to the
   media manager (server/media.js) on 127.0.0.1, with IMPORT_TOKEN, which
   both servers read from their env files. */

"use strict";

var http = require("http");
var fs = require("fs");
var path = require("path");
var crypto = require("crypto");

var PORT = Number(process.env.PORT) || 3311;
var HOST = "127.0.0.1";
var SESSION_SECRET = process.env.SESSION_SECRET || "";
var IMPORT_TOKEN = process.env.IMPORT_TOKEN || "";
// Each new message is emailed to NOTIFY_EMAIL (if set), through the
// server's own Postfix on 127.0.0.1:25, from NOTIFY_FROM.
var NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || "";
var NOTIFY_FROM = process.env.NOTIFY_FROM || "scout@inlovingmemoryofscout.com";
var MEDIA_PORT = Number(process.env.MEDIA_PORT) || 3312;
var STATE = process.env.STATE_DIRECTORY || path.join(__dirname, "data");
var DATA_FILE = path.join(STATE, "messages.json");
var PHOTO_DIR = path.join(STATE, "photos");
var UPLOAD_DIR = path.join(STATE, "uploads");

var MAX_LEN = 2000;
var MAX_NAME = 80;
var MAX_BODY = 16 * 1024;          // admin forms
var MAX_PHOTO = 8 * 1024 * 1024;   // a photo, after the page has shrunk it
var MAX_VIDEO = 300 * 1024 * 1024; // a video, as it is (nginx allows a bit more)
var MAX_FILES = 10;                // photos and videos in one message
var MAX_POST = 64 * 1024;          // a message (its files are uploaded on their own)
var UPLOAD_LIMIT = 60;             // uploads per visitor per RATE_WINDOW_MS
var UPLOAD_TTL_MS = 6 * 60 * 60e3; // an upload no message has claimed is deleted after this
var MAX_CAPTION = 200;             // as in media.js
var RATE_LIMIT = 5;               // messages per visitor...
var RATE_WINDOW_MS = 60 * 60e3;   // ...per hour

// The kinds of file accepted, by their first bytes (see sniff()).
var FILE_TYPES = [
  { ext: "jpg", type: "image/jpeg", kind: "image", magic: [0xFF, 0xD8, 0xFF] },
  { ext: "png", type: "image/png", kind: "image", magic: [0x89, 0x50, 0x4E, 0x47] },
  { ext: "gif", type: "image/gif", kind: "image", magic: [0x47, 0x49, 0x46, 0x38] },
  { ext: "webp", type: "image/webp", kind: "image", magic: [0x52, 0x49, 0x46, 0x46], at8: "WEBP" },
  { ext: "webm", type: "video/webm", kind: "video", magic: [0x1A, 0x45, 0xDF, 0xA3] },
  { ext: "mp4", type: "video/mp4", kind: "video" },        // "ftyp" box, see sniff()
  { ext: "mov", type: "video/quicktime", kind: "video" }   // "ftyp" box, brand "qt  "
];
function typeByExt(ext) { return FILE_TYPES.filter(function (t) { return t.ext === ext; })[0]; }
var NOT_A_VIDEO_BRAND = /^(heic|heix|hevc|heim|heis|mif1|msf1|avif|avis)$/; // HEIC/AVIF stills
// The type of a file from its first 12 bytes, or null.
function sniff(head) {
  if (head.length >= 12 && head.toString("latin1", 4, 8) === "ftyp") {
    var brand = head.toString("latin1", 8, 12);
    if (NOT_A_VIDEO_BRAND.test(brand.trim())) return null;
    return typeByExt(brand === "qt  " ? "mov" : "mp4");
  }
  return FILE_TYPES.filter(function (t) {
    return t.magic && t.magic.every(function (b, i) { return head[i] === b; }) &&
      (!t.at8 || head.toString("latin1", 8, 12) === t.at8);
  })[0] || null;
}

// ---- storage ----

var messages = load();

// A message's files: m.files = [{ file, kind, imported? }]. Messages from
// before there could be several had a single m.photo.
function load() {
  var list;
  try { list = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch (e) { if (e.code !== "ENOENT") throw e; return []; }
  list.forEach(function (m) {
    if (!m.photo) return;
    m.files = [{ file: m.photo, kind: "image" }];
    if (m.imported) m.files[0].imported = m.imported;
    delete m.photo;
    delete m.imported;
  });
  return list;
}

function save() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  var tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(messages, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function filesOf(m) { return m.files || []; }
function filePath(f) { return path.join(PHOTO_DIR, f.file); }
function fileType(f) { return typeByExt(path.extname(f.file).slice(1)); }
function removeFile(m, f) {
  fs.rmSync(filePath(f), { force: true });
  m.files.splice(m.files.indexOf(f), 1);
  if (!m.files.length) delete m.files;
}
function removeFiles(m) { filesOf(m).slice().forEach(function (f) { removeFile(m, f); }); }

// Uploads waiting for their message: token -> { file, kind, at }. Kept in
// memory, so the folder is emptied on start; old ones go every hour.
var uploads = new Map();
fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
setInterval(function () {
  var now = Date.now();
  uploads.forEach(function (u, token) {
    if (now - u.at < UPLOAD_TTL_MS) return;
    fs.rm(path.join(UPLOAD_DIR, u.file), { force: true }, function () {});
    uploads.delete(token);
  });
}, 60 * 60e3).unref();

// ---- helpers ----

var recent = new Map(), recentUploads = new Map(); // ip -> [timestamps]

function rateLimited(ip, map, limit) {
  map = map || recent;
  var now = Date.now();
  var list = (map.get(ip) || []).filter(function (t) { return now - t < RATE_WINDOW_MS; });
  if (list.length >= (limit || RATE_LIMIT)) { map.set(ip, list); return true; }
  list.push(now);
  map.set(ip, list);
  return false;
}

function clientIp(req) {
  return req.headers["x-real-ip"] || req.socket.remoteAddress || "";
}

// cb(body), or cb(null) if it was over limit bytes.
function readBody(req, limit, cb) {
  var size = 0, chunks = [];
  req.on("data", function (c) {
    size += c.length;
    if (size <= limit) chunks.push(c);
  });
  req.on("end", function () { cb(size > limit ? null : Buffer.concat(chunks).toString("utf8")); });
}

function parseBody(req, raw) {
  var type = req.headers["content-type"] || "";
  if (type.indexOf("application/json") === 0) {
    try { return JSON.parse(raw) || {}; } catch (e) { return {}; }
  }
  var out = {};
  new URLSearchParams(raw).forEach(function (v, k) { out[k] = v; });
  return out;
}

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({ "Cache-Control": "no-store" }, headers || {}));
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

// Signed in at /admin/login: the scout_admin cookie is "<expiry>.<hmac of
// expiry>", keyed on SESSION_SECRET, exactly as media.js makes it.
function isAdmin(req) {
  if (!SESSION_SECRET) return false;
  var m = /(?:^|;\s*)scout_admin=(\d+)\.([0-9a-f]{64})/.exec(req.headers.cookie || "");
  if (!m || Number(m[1]) < Date.now()) return false;
  var good = crypto.createHmac("sha256", SESSION_SECRET).update(m[1]).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(m[2], "hex"), Buffer.from(good, "hex"));
}

// The media manager asks how many messages are waiting, for /admin: only
// straight from 127.0.0.1 (nginx adds X-Real-IP) with IMPORT_TOKEN.
function internal(req) {
  var token = String(req.headers["x-import-token"] || "");
  return !!IMPORT_TOKEN && !req.headers["x-real-ip"] && crypto.timingSafeEqual(sha(token), sha(IMPORT_TOKEN));
}

// The sign-in cookie is sent automatically, so admin POSTs must come from
// this site's own pages, not a form on some other site (SameSite=Strict
// already blocks that; this is a second check).
// The site is served under several domains, so "this site" is whichever
// one the request came in on (nginx passes it on as Host).
function sameOrigin(req) {
  var o = req.headers.origin || req.headers.referer || "";
  var site = "https://" + (req.headers.host || "");
  return o === site || o.indexOf(site + "/") === 0;
}

// A message's file, with Range support so videos can stream and seek.
function sendFile(req, res, m, n) {
  var f = m && filesOf(m)[n], t = f && fileType(f);
  if (!t) return send(res, 404, "Not found");
  fs.stat(filePath(f), function (err, st) {
    if (err) return send(res, 404, "Not found");
    var headers = { "Content-Type": t.type, "Accept-Ranges": "bytes", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" };
    var start = 0, end = st.size - 1, status = 200;
    var r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (r && (r[1] || r[2])) {
      if (r[1]) { start = Number(r[1]); if (r[2]) end = Math.min(end, Number(r[2])); }
      else start = Math.max(0, st.size - Number(r[2]));
      if (start > end || start >= st.size) {
        headers["Content-Range"] = "bytes */" + st.size;
        return send(res, 416, "", headers);
      }
      status = 206;
      headers["Content-Range"] = "bytes " + start + "-" + end + "/" + st.size;
    }
    headers["Content-Length"] = end - start + 1;
    res.writeHead(status, headers);
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(filePath(f), { start: start, end: end }).on("error", function () { res.destroy(); }).pipe(res);
  });
}

function find(id) { return messages.filter(function (m) { return m.id === id; })[0]; }

// ---- public API ----

function listApproved(res) {
  var out = messages
    .filter(function (m) { return m.approved; })
    .sort(function (a, b) { return b.createdAt.localeCompare(a.createdAt); })
    .map(function (m) {
      var o = { id: m.id, text: m.text, createdAt: m.createdAt };
      if (m.name) o.name = m.name;
      if (m.files) o.files = m.files.map(function (f, n) { return { url: "/api/messages/file/" + m.id + "/" + n, kind: f.kind }; });
      return o;
    });
  json(res, 200, out);
}

// One photo or video, as the raw request body, streamed to uploads/. Its
// first bytes decide what it is (and so its size limit); answers { token }.
function upload(req, res) {
  var len = Number(req.headers["content-length"]);
  if (!len) return json(res, 411, { error: "That file is empty." });
  if (len > MAX_VIDEO) return json(res, 413, { error: "That file is too big (" + (MAX_VIDEO >> 20) + " MB max)." });
  if (rateLimited(clientIp(req), recentUploads, UPLOAD_LIMIT)) return json(res, 429, { error: "You've sent a lot of files already. Please try again later." });
  var token = crypto.randomBytes(16).toString("hex");
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  var part = path.join(UPLOAD_DIR, token + ".part");
  var out = fs.createWriteStream(part, { flags: "wx" });
  var head = Buffer.alloc(0), size = 0, type = null, failed = false;
  function fail(status, error) {
    if (failed) return;
    failed = true;
    out.destroy();
    fs.rm(part, { force: true }, function () {});
    if (status) json(res, status, { error: error });
    req.resume(); // let the rest of it arrive, unread, so the answer gets through
  }
  req.on("data", function (c) {
    if (failed) return;
    size += c.length;
    if (!type && head.length < 12) {
      head = Buffer.concat([head, c.subarray(0, 12)]);
      if (head.length >= 12 && !(type = sniff(head))) return fail(415, "Only photos (JPEG, PNG, GIF, WebP) and videos (MP4, MOV, WebM) can be sent.");
    }
    var max = type && type.kind === "image" ? MAX_PHOTO : MAX_VIDEO;
    if (size > max) return fail(413, "That " + (max === MAX_PHOTO ? "photo" : "video") + " is too big (" + (max >> 20) + " MB max).");
    if (!out.write(c)) { req.pause(); out.once("drain", function () { req.resume(); }); }
  });
  req.on("aborted", function () { fail(0); });
  req.on("end", function () {
    if (failed) return;
    if (!type) return fail(415, "Only photos (JPEG, PNG, GIF, WebP) and videos (MP4, MOV, WebM) can be sent.");
    out.end(function () {
      var file = token + "." + type.ext;
      fs.rename(part, path.join(UPLOAD_DIR, file), function (err) {
        if (err) { console.error(err); return json(res, 500, { error: "Sorry, that file couldn't be saved. Please try again." }); }
        uploads.set(token, { file: file, kind: type.kind, at: Date.now() });
        json(res, 201, { token: token, kind: type.kind });
      });
    });
  });
  out.on("error", function (e) { console.error(e); fail(500, "Sorry, that file couldn't be saved. Please try again."); });
}

function create(req, res) {
  readBody(req, MAX_POST, function (raw) {
    if (raw === null) return json(res, 413, { error: "That message is too long." });
    var body = parseBody(req, raw);
    // Honeypot: the form has a hidden "website" field people never fill in.
    if (body.website) return json(res, 201, { ok: true });
    var text = String(body.text || "").replace(/\r\n?/g, "\n").trim();
    // Optional; blank stays anonymous. One line, no control characters.
    var name = String(body.name || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
    var tokens = Array.isArray(body.files) ? body.files.map(String) : [];
    if (!text && !tokens.length) return json(res, 400, { error: "Please write a message or add a photo or video." });
    if (text.length > MAX_LEN) return json(res, 400, { error: "That message is too long (" + MAX_LEN + " characters max)." });
    if (tokens.length > MAX_FILES) return json(res, 400, { error: "Up to " + MAX_FILES + " photos and videos per message, please." });
    var ups = tokens.map(function (t) { return uploads.get(t); });
    if (ups.some(function (u) { return !u; }) || new Set(tokens).size !== tokens.length)
      return json(res, 400, { error: "One of your files didn't finish uploading. Please remove it and add it again." });
    if (rateLimited(clientIp(req))) return json(res, 429, { error: "You've sent a few messages already. Please try again later." });
    var m = { id: crypto.randomUUID(), text: text, createdAt: new Date().toISOString(), approved: false };
    if (name) m.name = name;
    if (ups.length) {
      try {
        fs.mkdirSync(PHOTO_DIR, { recursive: true });
        m.files = ups.map(function (u, n) {
          var f = { file: m.id + "-" + n + path.extname(u.file), kind: u.kind };
          fs.renameSync(path.join(UPLOAD_DIR, u.file), filePath(f));
          uploads.delete(tokens[n]);
          return f;
        });
      } catch (e) { console.error(e); removeFiles(m); return json(res, 500, { error: "Sorry, your files couldn't be saved. Please try again." }); }
    }
    messages.push(m);
    save();
    json(res, 201, { ok: true });
    notify(m, req.headers.host);
  });
}

// Hand one plain-text email to Postfix on 127.0.0.1:25: a tiny SMTP client
// that waits for each reply before sending the next command.
function sendMail(to, subject, text, cb) {
  var net = require("net");
  var body = text.replace(/\r?\n/g, "\r\n").replace(/^\./gm, ".."); // dot-stuffing
  var steps = [
    "HELO localhost",
    "MAIL FROM:<" + NOTIFY_FROM + ">",
    "RCPT TO:<" + to + ">",
    "DATA",
    "From: Scout memorial <" + NOTIFY_FROM + ">\r\nTo: <" + to + ">\r\nSubject: " + subject +
      "\r\nDate: " + new Date().toUTCString() + "\r\nMessage-ID: <" + crypto.randomUUID() + "@" + NOTIFY_FROM.split("@")[1] + ">" +
      "\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n" + body + "\r\n.",
    "QUIT"
  ];
  var sock = net.connect(25, "127.0.0.1"), buf = "", done = false;
  function finish(err) { if (!done) { done = true; sock.destroy(); cb(err); } }
  sock.setTimeout(15000, function () { finish(new Error("timed out")); });
  sock.on("error", finish);
  sock.on("data", function (d) {
    buf += d.toString("utf8");
    var lines = buf.split("\r\n");
    var last = lines[lines.length - 2];
    if (!last || last.charAt(3) === "-") return; // wait for the whole reply
    buf = "";
    if (!/^[23]/.test(last)) return finish(new Error(last));
    if (!steps.length) return finish(null);
    sock.write(steps.shift() + "\r\n");
  });
}

// "a message, 2 photos and a video", "a photo", ...
function describe(m) {
  var photos = filesOf(m).filter(function (f) { return f.kind === "image"; }).length;
  var videos = filesOf(m).length - photos;
  var parts = [];
  if (m.text) parts.push("a message");
  if (photos) parts.push(photos === 1 ? "a photo" : photos + " photos");
  if (videos) parts.push(videos === 1 ? "a video" : videos + " videos");
  return parts.length > 1 ? parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1] : parts[0] || "nothing";
}

function notify(m, host) {
  if (!NOTIFY_EMAIL) return;
  var what = describe(m);
  var text = (m.name ? m.name + " (the name they gave)" : "Someone") + " left " + what + " for Scout. It's waiting for your approval:\n\n" +
    "https://" + (host || "inlovingmemoryofscout.com") + "/messages-admin\n\n" +
    (m.text ? "Their message:\n\n" + m.text + "\n" : "(No message, just " + describe(m) + ".)\n");
  sendMail(NOTIFY_EMAIL, "New " + (m.text ? "message" : filesOf(m).length > 1 ? "photos and videos" : filesOf(m)[0].kind === "video" ? "video" : "photo") + " for Scout", text, function (err) {
    if (err) console.error("couldn't email " + NOTIFY_EMAIL + ": " + err.message);
  });
}

// ---- copying a file into media/ (via the media manager) ----

function importFile(m, f, opts, cb) {
  if (!IMPORT_TOKEN) return cb("Copying isn't set up: IMPORT_TOKEN is missing from /etc/scout-messages.env.");
  var t = fileType(f), n = filesOf(m).indexOf(f);
  fs.stat(filePath(f), function (err, st) {
    if (err) return cb("That file is gone.");
    var day = m.createdAt.slice(0, 10);
    var q = new URLSearchParams({
      name: "visitor-" + day + "-" + m.id.slice(0, 6) + (filesOf(m).length > 1 ? "-" + (n + 1) : "") + "." + t.ext,
      gallery: opts.gallery ? "1" : "",
      slideshow: opts.slideshow ? "1" : "",
      moments: opts.moments ? "1" : "",
      caption: opts.caption || ""
    });
    var req = http.request({
      host: "127.0.0.1", port: MEDIA_PORT, method: "POST", path: "/internal/import?" + q,
      headers: { "X-Import-Token": IMPORT_TOKEN, "Content-Type": t.type, "Content-Length": st.size }
    }, function (res) {
      var chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        var body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (e) {}
        if (res.statusCode === 201 && body.name) cb(null, body.name);
        else cb(body.error || "The media manager said no (" + res.statusCode + ").");
      });
    });
    req.on("error", function () { cb("Couldn't reach the media manager. Is scout-media running?"); });
    fs.createReadStream(filePath(f)).on("error", function () { req.destroy(); }).pipe(req);
  });
}

// ---- admin page ----

function adminPage(res, msg) {
  var pending = messages.filter(function (m) { return !m.approved; });
  var approved = messages.filter(function (m) { return m.approved; });
  function fileBlocks(m) {
    var files = filesOf(m);
    return files.map(function (f, n) {
      var url = "/messages-admin/file/" + encodeURIComponent(m.id) + "/" + n;
      var moving = f.kind === "video" || fileType(f).ext === "gif";
      var ids = '<input type="hidden" name="id" value="' + esc(m.id) + '"><input type="hidden" name="file" value="' + esc(f.file) + '">';
      var copy = f.imported
        ? '<p class="done">Copied to your media as <b>' + esc(f.imported) + '</b>. Tick it in the <a href="/media-admin">media manager</a> to change where it shows.</p>'
        : '<form method="post" class="copy">' + ids + '<input type="hidden" name="action" value="import">' +
          '<label><input type="checkbox" name="gallery" value="1" checked> Gallery</label>' +
          (moving ? '<label><input type="checkbox" name="moments" value="1"> Moments</label>'
                  : '<label><input type="checkbox" name="slideshow" value="1"> Slideshow</label>') +
          (m.text && m.text.length <= MAX_CAPTION ? '<label><input type="checkbox" name="caption" value="1"> Use their message as the caption</label>' : '') +
          '<button>Copy to my media</button></form>';
      var remove = files.length > 1 || m.text
        ? '<form method="post" class="remove">' + ids + '<button name="action" value="removefile" class="delete">Remove this ' + (f.kind === "video" ? "video" : "photo") + '</button></form>' : '';
      var thumb = f.kind === "video"
        ? '<video src="' + url + '" controls preload="metadata" playsinline></video>'
        : '<a href="' + url + '" target="_blank"><img src="' + url + '" alt="" loading="lazy"></a>';
      return '<div class="photo">' + thumb + '<div>' + copy + remove + '</div></div>';
    }).join("");
  }
  function rows(list, actions) {
    if (!list.length) return '<p class="none">None.</p>';
    return list.slice().sort(function (a, b) { return b.createdAt.localeCompare(a.createdAt); }).map(function (m) {
      return '<div class="msg">' + (m.text ? '<p>' + esc(m.text).replace(/\n/g, "<br>") + '</p>' : '<p class="none">(No message, just ' + esc(describe(m)) + '.)</p>') +
        fileBlocks(m) +
        '<div class="meta">' + (m.name ? '<b>' + esc(m.name) + '</b> · ' : 'Anonymous · ') + esc(new Date(m.createdAt).toLocaleString("en-US", { timeZone: "America/New_York" })) + '</div>' +
        '<form method="post">' + '<input type="hidden" name="id" value="' + esc(m.id) + '">' +
        actions.map(function (a) { return '<button name="action" value="' + a[0] + '" class="' + a[0] + '">' + a[1] + '</button>'; }).join("") +
        '</form></div>';
    }).join("");
  }
  var html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Messages for Scout – approve</title><style>' +
    'body{margin:0;padding:24px 20px 60px;background:#FAF4EA;color:#2B211B;font:16px/1.6 Georgia,serif}' +
    'main{max-width:720px;margin:0 auto}h1{font-weight:400}h2{font:600 13px system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:#8F4818;margin-top:40px}' +
    '.msg{background:#fff;border:1px solid #E5D6C0;border-radius:4px;padding:16px 18px;margin:12px 0}.msg p{margin:0 0 8px;white-space:normal}' +
    '.meta{font:13px system-ui,sans-serif;color:#6B5748;margin-bottom:10px}' +
    '.photo{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start;margin:4px 0 12px}.photo img,.photo video{display:block;width:180px;max-height:180px;object-fit:cover;border-radius:3px;background:#F1E6D4}.photo video{width:240px;max-height:240px;object-fit:contain;background:#000}.remove{margin-top:8px}' +
    '.photo>div{flex:1;min-width:200px}.copy{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:center;font:14px system-ui,sans-serif}' +
    '.copy label{display:flex;gap:6px;align-items:center}.copy input{accent-color:#A8571F}.copy button{margin-top:4px}' +
    '.done{font:14px system-ui,sans-serif;color:#4A3B31}' +
    '.note{background:#FFF1D6;border:1px solid #E8C98F;border-radius:4px;padding:10px 14px;font:14px system-ui,sans-serif}' +
    '.links{font:14px system-ui,sans-serif}' +
    'button{font:600 13px system-ui,sans-serif;padding:8px 14px;margin-right:8px;border-radius:999px;border:1px solid #DBC8AE;background:#FAF4EA;cursor:pointer}' +
    'button.approve{background:#A8571F;border-color:#A8571F;color:#FFF8EC}button.delete{color:#9b2c2c}.none{color:#6B5748}' +
    '</style></head><body><main><h1>Messages for Scout</h1>' +
    '<p class="links"><a href="/admin">← Admin</a> · <a href="/media-admin">Media manager →</a></p>' +
    (msg ? '<p class="note">' + esc(msg) + '</p>' : '') +
    '<h2>Waiting for approval (' + pending.length + ')</h2>' + rows(pending, [["approve", "Approve"], ["delete", "Delete"]]) +
    '<h2>On the site (' + approved.length + ')</h2>' + rows(approved, [["hide", "Hide"], ["delete", "Delete"]]) +
    '</main></body></html>';
  send(res, 200, html, { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY" });
}

function adminAction(req, res) {
  if (!sameOrigin(req)) return send(res, 403, "Forbidden");
  readBody(req, MAX_BODY, function (raw) {
    var body = parseBody(req, raw || "");
    var m = find(body.id);
    function done(msg) { send(res, 303, "", { Location: "/messages-admin" + (msg ? "?msg=" + encodeURIComponent(msg) : "") }); }
    if (!m) return done("That message is gone.");
    var f = filesOf(m).filter(function (x) { return x.file === body.file; })[0];
    if (body.action === "import") {
      if (!f) return done("That file is gone.");
      var caption = body.caption && m.text && m.text.length <= MAX_CAPTION ? m.text.replace(/\s+/g, " ") : "";
      return importFile(m, f, { gallery: !!body.gallery, slideshow: !!body.slideshow, moments: !!body.moments, caption: caption }, function (err, name) {
        if (err) return done(err);
        f.imported = name;
        save();
        done("Copied the " + (f.kind === "video" ? "video" : "photo") + " to your media as " + name + ".");
      });
    }
    if (body.action === "approve") m.approved = true;
    else if (body.action === "hide") m.approved = false;
    else if (body.action === "removefile") { if (f && (filesOf(m).length > 1 || m.text)) removeFile(m, f); }
    else if (body.action === "delete") { removeFiles(m); messages.splice(messages.indexOf(m), 1); }
    save();
    done("");
  });
}

// ---- routing ----

http.createServer(function (req, res) {
  var u = new URL(req.url, "http://x");
  var url = u.pathname;
  // /…/file/<id>/<n>, or /…/photo/<id> (file 0) from before there could be several.
  var file = /^\/(api\/messages|messages-admin)\/(?:file\/([\w-]+)\/(\d+)|photo\/([\w-]+))$/.exec(url);
  var fileMsg = file && find(file[2] || file[4]), fileN = file ? Number(file[3] || 0) : 0;
  if (file && req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed", { Allow: "GET, HEAD" });
  if (url === "/api/messages/upload") {
    if (req.method === "POST") return upload(req, res);
    return send(res, 405, "Method not allowed", { Allow: "POST" });
  }
  if (url === "/api/messages") {
    if (req.method === "GET") return listApproved(res);
    if (req.method === "POST") return create(req, res);
    return send(res, 405, "Method not allowed", { Allow: "GET, POST" });
  }
  if (file && file[1] === "api/messages") return sendFile(req, res, fileMsg && fileMsg.approved ? fileMsg : null, fileN);
  if (url === "/internal/stats" && req.method === "GET") {
    if (!internal(req)) return send(res, 403, "Forbidden");
    return json(res, 200, { pending: messages.filter(function (m) { return !m.approved; }).length, approved: messages.filter(function (m) { return m.approved; }).length });
  }
  if (url === "/messages-admin" || file) {
    if (!isAdmin(req)) {
      if (req.method === "GET" && !file) return send(res, 303, "", { Location: "/admin/login?next=/messages-admin" });
      return send(res, 401, "Please sign in at /admin.");
    }
    if (file) return sendFile(req, res, fileMsg, fileN);
    if (req.method === "GET") return adminPage(res, u.searchParams.get("msg"));
    if (req.method === "POST") return adminAction(req, res);
    return send(res, 405, "Method not allowed", { Allow: "GET, POST" });
  }
  send(res, 404, "Not found");
}).listen(PORT, HOST, function () {
  console.log("scout-messages listening on " + HOST + ":" + PORT + ", data in " + DATA_FILE);
});
