/* Messages for Scout: a tiny dependency-free backend.

   Visitors POST a message to /api/messages, with an optional photo; it's
   stored as pending and only shows up in GET /api/messages once approved at
   /messages-admin. That page uses the site's one admin sign-in, run by the
   media manager (server/media.js) at /admin/login: its scout_admin cookie
   is signed with SESSION_SECRET, which both servers' env files hold, and
   checked here the same way. nginx proxies both paths here; see
   server/README.md for the systemd unit and nginx config.

   Storage is a single JSON file in $STATE_DIRECTORY (systemd sets this to
   /var/lib/scout-messages), never inside the web root, with the photos
   beside it in photos/. A photo is served at /api/messages/photo/<id> once
   its message is approved, and at /messages-admin/photo/<id> to the admin
   any time. From the admin page a photo can be copied into the site's
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
var MEDIA_PORT = Number(process.env.MEDIA_PORT) || 3312;
var STATE = process.env.STATE_DIRECTORY || path.join(__dirname, "data");
var DATA_FILE = path.join(STATE, "messages.json");
var PHOTO_DIR = path.join(STATE, "photos");

var MAX_LEN = 2000;
var MAX_BODY = 16 * 1024;          // admin forms
var MAX_PHOTO = 8 * 1024 * 1024;   // a photo, after the page has shrunk it
var MAX_POST = 12 * 1024 * 1024;   // a message with its photo (base64 is 4/3 the size)
var MAX_CAPTION = 200;             // as in media.js
var RATE_LIMIT = 5;               // messages per visitor...
var RATE_WINDOW_MS = 60 * 60e3;   // ...per hour

// The kinds of photo accepted, by their first bytes.
var PHOTO_TYPES = [
  { ext: "jpg", type: "image/jpeg", magic: [0xFF, 0xD8, 0xFF] },
  { ext: "png", type: "image/png", magic: [0x89, 0x50, 0x4E, 0x47] },
  { ext: "gif", type: "image/gif", magic: [0x47, 0x49, 0x46, 0x38] },
  { ext: "webp", type: "image/webp", magic: [0x52, 0x49, 0x46, 0x46], at8: "WEBP" }
];

// ---- storage ----

var messages = load();

function load() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch (e) { if (e.code !== "ENOENT") throw e; return []; }
}

function save() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  var tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(messages, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function photoPath(m) { return path.join(PHOTO_DIR, m.photo); }
function photoType(m) {
  var ext = path.extname(m.photo).slice(1);
  return PHOTO_TYPES.filter(function (t) { return t.ext === ext; })[0];
}
function removePhoto(m) {
  if (!m.photo) return;
  fs.rmSync(photoPath(m), { force: true });
  delete m.photo;
  delete m.imported;
}

// ---- helpers ----

var recent = new Map(); // ip -> [timestamps]

function rateLimited(ip) {
  var now = Date.now();
  var list = (recent.get(ip) || []).filter(function (t) { return now - t < RATE_WINDOW_MS; });
  if (list.length >= RATE_LIMIT) { recent.set(ip, list); return true; }
  list.push(now);
  recent.set(ip, list);
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

// A photo sent as a data: URL -> { bytes, type }, or an error string.
function decodePhoto(dataUrl) {
  var m = /^data:image\/[\w.+-]+;base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl));
  if (!m) return "That photo couldn't be read. Please try another.";
  var bytes = Buffer.from(m[1], "base64");
  if (!bytes.length) return "That photo is empty.";
  if (bytes.length > MAX_PHOTO) return "That photo is too big (" + (MAX_PHOTO >> 20) + " MB max).";
  var type = PHOTO_TYPES.filter(function (t) {
    return t.magic.every(function (b, i) { return bytes[i] === b; }) &&
      (!t.at8 || bytes.toString("latin1", 8, 12) === t.at8);
  })[0];
  if (!type) return "Only photos (JPEG, PNG, GIF or WebP) can be sent.";
  return { bytes: bytes, type: type };
}

function sendPhoto(res, m) {
  var t = m && m.photo && photoType(m);
  if (!t) return send(res, 404, "Not found");
  fs.readFile(photoPath(m), function (err, data) {
    if (err) return send(res, 404, "Not found");
    send(res, 200, data, { "Content-Type": t.type, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
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
      if (m.photo) o.photo = "/api/messages/photo/" + m.id;
      return o;
    });
  json(res, 200, out);
}

function create(req, res) {
  readBody(req, MAX_POST, function (raw) {
    if (raw === null) return json(res, 413, { error: "That photo is too big. Please try a smaller one." });
    var body = parseBody(req, raw);
    // Honeypot: the form has a hidden "website" field people never fill in.
    if (body.website) return json(res, 201, { ok: true });
    var text = String(body.text || "").replace(/\r\n?/g, "\n").trim();
    var photo = body.photo ? decodePhoto(body.photo) : null;
    if (typeof photo === "string") return json(res, 400, { error: photo });
    if (!text && !photo) return json(res, 400, { error: "Please write a message or add a photo." });
    if (text.length > MAX_LEN) return json(res, 400, { error: "That message is too long (" + MAX_LEN + " characters max)." });
    if (rateLimited(clientIp(req))) return json(res, 429, { error: "You've sent a few messages already. Please try again later." });
    var m = { id: crypto.randomUUID(), text: text, createdAt: new Date().toISOString(), approved: false };
    if (photo) {
      m.photo = m.id + "." + photo.type.ext;
      try {
        fs.mkdirSync(PHOTO_DIR, { recursive: true });
        fs.writeFileSync(photoPath(m), photo.bytes);
      } catch (e) { console.error(e); return json(res, 500, { error: "Sorry, that photo couldn't be saved. Please try again." }); }
    }
    messages.push(m);
    save();
    json(res, 201, { ok: true });
  });
}

// ---- copying a photo into media/ (via the media manager) ----

function importPhoto(m, opts, cb) {
  if (!IMPORT_TOKEN) return cb("Copying isn't set up: IMPORT_TOKEN is missing from /etc/scout-messages.env.");
  var t = photoType(m);
  fs.readFile(photoPath(m), function (err, data) {
    if (err) return cb("That photo is gone.");
    var day = m.createdAt.slice(0, 10);
    var q = new URLSearchParams({
      name: "visitor-" + day + "-" + m.id.slice(0, 6) + "." + t.ext,
      gallery: opts.gallery ? "1" : "",
      slideshow: opts.slideshow ? "1" : "",
      moments: opts.moments ? "1" : "",
      caption: opts.caption || ""
    });
    var req = http.request({
      host: "127.0.0.1", port: MEDIA_PORT, method: "POST", path: "/internal/import?" + q,
      headers: { "X-Import-Token": IMPORT_TOKEN, "Content-Type": t.type, "Content-Length": data.length }
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
    req.end(data);
  });
}

// ---- admin page ----

function adminPage(res, msg) {
  var pending = messages.filter(function (m) { return !m.approved; });
  var approved = messages.filter(function (m) { return m.approved; });
  function photoBlock(m) {
    if (!m.photo) return '';
    var url = "/messages-admin/photo/" + encodeURIComponent(m.id);
    var gif = photoType(m).ext === "gif";
    var copy = m.imported
      ? '<p class="done">Copied to your media as <b>' + esc(m.imported) + '</b>. Tick it in the <a href="/media-admin">media manager</a> to change where it shows.</p>'
      : '<form method="post" class="copy"><input type="hidden" name="id" value="' + esc(m.id) + '"><input type="hidden" name="action" value="import">' +
        '<label><input type="checkbox" name="gallery" value="1" checked> Gallery</label>' +
        (gif ? '<label><input type="checkbox" name="moments" value="1"> Moments</label>'
             : '<label><input type="checkbox" name="slideshow" value="1"> Slideshow</label>') +
        (m.text && m.text.length <= MAX_CAPTION ? '<label><input type="checkbox" name="caption" value="1"> Use their message as the caption</label>' : '') +
        '<button>Copy to my media</button></form>';
    return '<div class="photo"><a href="' + url + '" target="_blank"><img src="' + url + '" alt="" loading="lazy"></a><div>' + copy + '</div></div>';
  }
  function rows(list, actions) {
    if (!list.length) return '<p class="none">None.</p>';
    return list.slice().sort(function (a, b) { return b.createdAt.localeCompare(a.createdAt); }).map(function (m) {
      return '<div class="msg">' + (m.text ? '<p>' + esc(m.text).replace(/\n/g, "<br>") + '</p>' : '<p class="none">(No message, just a photo.)</p>') +
        photoBlock(m) +
        '<div class="meta">' + esc(new Date(m.createdAt).toLocaleString("en-US", { timeZone: "America/New_York" })) + '</div>' +
        '<form method="post">' + '<input type="hidden" name="id" value="' + esc(m.id) + '">' +
        actions.map(function (a) { return '<button name="action" value="' + a[0] + '" class="' + a[0] + '">' + a[1] + '</button>'; }).join("") +
        (m.photo && m.text ? '<button name="action" value="removephoto" class="delete">Remove photo</button>' : '') +
        '</form></div>';
    }).join("");
  }
  var html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Messages for Scout – approve</title><style>' +
    'body{margin:0;padding:24px 20px 60px;background:#FAF4EA;color:#2B211B;font:16px/1.6 Georgia,serif}' +
    'main{max-width:720px;margin:0 auto}h1{font-weight:400}h2{font:600 13px system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:#8F4818;margin-top:40px}' +
    '.msg{background:#fff;border:1px solid #E5D6C0;border-radius:4px;padding:16px 18px;margin:12px 0}.msg p{margin:0 0 8px;white-space:normal}' +
    '.meta{font:13px system-ui,sans-serif;color:#6B5748;margin-bottom:10px}' +
    '.photo{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start;margin:4px 0 12px}.photo img{display:block;width:180px;max-height:180px;object-fit:cover;border-radius:3px;background:#F1E6D4}' +
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
    if (body.action === "import") {
      if (!m.photo) return done("That photo is gone.");
      var caption = body.caption && m.text && m.text.length <= MAX_CAPTION ? m.text.replace(/\s+/g, " ") : "";
      return importPhoto(m, { gallery: !!body.gallery, slideshow: !!body.slideshow, moments: !!body.moments, caption: caption }, function (err, name) {
        if (err) return done(err);
        m.imported = name;
        save();
        done("Copied the photo to your media as " + name + ".");
      });
    }
    if (body.action === "approve") m.approved = true;
    else if (body.action === "hide") m.approved = false;
    else if (body.action === "removephoto") removePhoto(m);
    else if (body.action === "delete") { removePhoto(m); messages.splice(messages.indexOf(m), 1); }
    save();
    done("");
  });
}

// ---- routing ----

http.createServer(function (req, res) {
  var u = new URL(req.url, "http://x");
  var url = u.pathname;
  var photo = /^\/(api\/messages|messages-admin)\/photo\/([\w-]+)$/.exec(url);
  if (url === "/api/messages") {
    if (req.method === "GET") return listApproved(res);
    if (req.method === "POST") return create(req, res);
    return send(res, 405, "Method not allowed", { Allow: "GET, POST" });
  }
  if (photo && photo[1] === "api/messages") {
    var m = find(photo[2]);
    return sendPhoto(res, m && m.approved ? m : null);
  }
  if (url === "/internal/stats" && req.method === "GET") {
    if (!internal(req)) return send(res, 403, "Forbidden");
    return json(res, 200, { pending: messages.filter(function (m) { return !m.approved; }).length, approved: messages.filter(function (m) { return m.approved; }).length });
  }
  if (url === "/messages-admin" || photo) {
    if (!isAdmin(req)) {
      if (req.method === "GET" && !photo) return send(res, 303, "", { Location: "/admin/login?next=/messages-admin" });
      return send(res, 401, "Please sign in at /admin.");
    }
    if (photo) return sendPhoto(res, find(photo[2]));
    if (req.method === "GET") return adminPage(res, u.searchParams.get("msg"));
    if (req.method === "POST") return adminAction(req, res);
    return send(res, 405, "Method not allowed", { Allow: "GET, POST" });
  }
  send(res, 404, "Not found");
}).listen(PORT, HOST, function () {
  console.log("scout-messages listening on " + HOST + ":" + PORT + ", data in " + DATA_FILE);
});
