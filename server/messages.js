/* Messages for Scout: a tiny dependency-free backend.

   Visitors POST a message to /api/messages; it's stored as pending and only
   shows up in GET /api/messages once approved at /messages-admin (HTTP basic
   auth, password from ADMIN_PASSWORD). nginx proxies both paths here; see
   server/README.md for the systemd unit and nginx config.

   Storage is a single JSON file in $STATE_DIRECTORY (systemd sets this to
   /var/lib/scout-messages), never inside the web root. */

"use strict";

var http = require("http");
var fs = require("fs");
var path = require("path");
var crypto = require("crypto");

var PORT = Number(process.env.PORT) || 3311;
var HOST = "127.0.0.1";
var ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
var DATA_FILE = path.join(process.env.STATE_DIRECTORY || path.join(__dirname, "data"), "messages.json");

var MAX_LEN = 2000;
var MAX_BODY = 16 * 1024;
var RATE_LIMIT = 5;               // messages per visitor...
var RATE_WINDOW_MS = 60 * 60e3;   // ...per hour

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

function readBody(req, cb) {
  var size = 0, chunks = [];
  req.on("data", function (c) {
    size += c.length;
    if (size > MAX_BODY) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on("end", function () { cb(Buffer.concat(chunks).toString("utf8")); });
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
// The site is served under several domains, so "this site" is whichever
// one the request came in on (nginx passes it on as Host).
function sameOrigin(req) {
  var o = req.headers.origin || req.headers.referer || "";
  var site = "https://" + (req.headers.host || "");
  return o === site || o.indexOf(site + "/") === 0;
}

// ---- public API ----

function listApproved(res) {
  var out = messages
    .filter(function (m) { return m.approved; })
    .sort(function (a, b) { return b.createdAt.localeCompare(a.createdAt); })
    .map(function (m) { return { id: m.id, text: m.text, createdAt: m.createdAt }; });
  json(res, 200, out);
}

function create(req, res) {
  readBody(req, function (raw) {
    var body = parseBody(req, raw);
    // Honeypot: the form has a hidden "website" field people never fill in.
    if (body.website) return json(res, 201, { ok: true });
    var text = String(body.text || "").replace(/\r\n?/g, "\n").trim();
    if (!text) return json(res, 400, { error: "Please write a message." });
    if (text.length > MAX_LEN) return json(res, 400, { error: "That message is too long (" + MAX_LEN + " characters max)." });
    if (rateLimited(clientIp(req))) return json(res, 429, { error: "You've sent a few messages already. Please try again later." });
    messages.push({ id: crypto.randomUUID(), text: text, createdAt: new Date().toISOString(), approved: false });
    save();
    json(res, 201, { ok: true });
  });
}

// ---- admin page ----

function adminPage(res) {
  var pending = messages.filter(function (m) { return !m.approved; });
  var approved = messages.filter(function (m) { return m.approved; });
  function rows(list, actions) {
    if (!list.length) return '<p class="none">None.</p>';
    return list.slice().sort(function (a, b) { return b.createdAt.localeCompare(a.createdAt); }).map(function (m) {
      return '<div class="msg"><p>' + esc(m.text).replace(/\n/g, "<br>") + '</p>' +
        '<div class="meta">' + esc(new Date(m.createdAt).toLocaleString("en-US", { timeZone: "America/New_York" })) + '</div>' +
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
    'button{font:600 13px system-ui,sans-serif;padding:8px 14px;margin-right:8px;border-radius:999px;border:1px solid #DBC8AE;background:#FAF4EA;cursor:pointer}' +
    'button.approve{background:#A8571F;border-color:#A8571F;color:#FFF8EC}button.delete{color:#9b2c2c}.none{color:#6B5748}' +
    '</style></head><body><main><h1>Messages for Scout</h1>' +
    '<h2>Waiting for approval (' + pending.length + ')</h2>' + rows(pending, [["approve", "Approve"], ["delete", "Delete"]]) +
    '<h2>On the site (' + approved.length + ')</h2>' + rows(approved, [["hide", "Hide"], ["delete", "Delete"]]) +
    '</main></body></html>';
  send(res, 200, html, { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY" });
}

function adminAction(req, res) {
  if (!sameOrigin(req)) return send(res, 403, "Forbidden");
  readBody(req, function (raw) {
    var body = parseBody(req, raw);
    var i = messages.findIndex(function (m) { return m.id === body.id; });
    if (i >= 0) {
      if (body.action === "approve") messages[i].approved = true;
      else if (body.action === "hide") messages[i].approved = false;
      else if (body.action === "delete") messages.splice(i, 1);
      save();
    }
    send(res, 303, "", { Location: "/messages-admin" });
  });
}

// ---- routing ----

http.createServer(function (req, res) {
  var url = req.url.split("?")[0];
  if (url === "/api/messages") {
    if (req.method === "GET") return listApproved(res);
    if (req.method === "POST") return create(req, res);
    return send(res, 405, "Method not allowed", { Allow: "GET, POST" });
  }
  if (url === "/messages-admin") {
    if (!isAdmin(req)) return send(res, 401, "Password required", { "WWW-Authenticate": 'Basic realm="Messages for Scout"' });
    if (req.method === "GET") return adminPage(res);
    if (req.method === "POST") return adminAction(req, res);
    return send(res, 405, "Method not allowed", { Allow: "GET, POST" });
  }
  send(res, 404, "Not found");
}).listen(PORT, HOST, function () {
  console.log("scout-messages listening on " + HOST + ":" + PORT + ", data in " + DATA_FILE);
});
