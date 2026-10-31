/* Media manager for Scout: a tiny dependency-free backend.

   It also runs the site's one admin sign-in: /admin/login takes the admin
   password and sets the scout_admin cookie (Path=/), signed with
   SESSION_SECRET, which server/messages.js shares and checks the same way,
   so one sign-in covers /admin (a page of links to everything),
   /media-admin and /messages-admin. The password is ADMIN_PASSWORD from the
   env file until the owner sets their own at /admin/password; that one is
   kept (as a salted scrypt hash) in password.json in $STATE_DIRECTORY
   (/var/lib/scout-media), outside the web root, and takes over.

   /media-admin
   lists everything in media/, the one folder the site's photos and videos
   live in, and lets the owner upload, rename and delete files. Uploads are
   streamed straight to disk, one file per request, with the file as the raw
   request body. Each file also has two checkboxes, kept as plain lists the
   page reads (one filename per line): not_in_gallery.txt names images left
   out of the gallery (every image is in it unless listed), slideshow.txt
   names the photos, GIFs and videos in the Moments section's stack (the
   "Moments" checkbox; nothing is unless listed). A GIF can also be
   picked as the transition between two sections, one GIF per transition,
   or put in the "Random" pool, which the page draws from for every
   transition without its own: transitions.txt, "<from>><to>=<file>" and
   "random=<file>" lines (script.js reads it).
   memorial.txt is the Memorial
   section's text and life.txt Scout's Life's, edited in a box at the
   bottom of the page (a tab for each) (paragraphs
   separated by blank lines). memories.json is the Memories section, a list
   of {title, text, photos} (photos: files, the first the main one), edited in its own box. captions.txt holds each file's optional
   caption ("<file>=<caption>"), and order.txt the display order the owner
   set by dragging (files it doesn't name follow, by filename). settings.txt
   holds "slide_seconds=<n>", how long each photo shows in Moments.
   /internal/import takes a visitor's photo or video from the messages server
   (server/messages.js), straight from 127.0.0.1 with IMPORT_TOKEN; nginx
   never passes that path on, and anything it does pass carries X-Real-IP.
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
var ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
var PASSWORD_FILE = path.join(process.env.STATE_DIRECTORY || path.join(__dirname, "data"), "password.json");
var MIN_PASSWORD = 8; // characters
var IMPORT_TOKEN = process.env.IMPORT_TOKEN || "";
var SESSION_SECRET = process.env.SESSION_SECRET || "";
var MESSAGES_PORT = Number(process.env.MESSAGES_PORT) || 3311;
// Where signing in can send you on to.
var ADMIN_PAGES = ["/admin", "/media-admin", "/messages-admin"];
var MEDIA_ROOT = process.env.MEDIA_ROOT || path.join(__dirname, "..", "media");

var MAX_UPLOAD = 1024 * 1024 * 1024; // 1 GB per file
var MAX_FORM = 2 * 1024 * 1024; // the memories editor sends all of them at once
var MAX_MEMORIAL = 20000; // characters
var SESSION_MS = 30 * 24 * 60 * 60e3; // stay signed in for 30 days
var LOGIN_LIMIT = 10;                 // wrong passwords per visitor...
var LOGIN_WINDOW_MS = 15 * 60e3;      // ...per 15 minutes
var MEDIA_EXT = /\.(jpe?g|png|gif|webp|avif|mp4|webm|mov|m4v)$/i;
var VIDEO_EXT = /\.(mp4|webm|mov|m4v)$/i;
var GIF_EXT = /\.gif$/i;
var PHOTO_EXT = /\.(jpe?g|png|webp|avif)$/i; // still photos, for the title page
// How the file list is grouped on the admin page, in this order.
var KINDS = [["image", "Images"], ["gif", "GIFs"], ["video", "Videos"], ["other", "Other files"]];
// The files the page uses directly live in PAGE_LIST, by role; deleting one
// leaves a gap on the page.
var PAGE_LIST = "page_files.txt";
var MEMORIAL_FILE = "memorial.txt";
var LIFE_FILE = "life.txt"; // Scout's Life, the section after the Memorial, written the same way
// The texts the memorial box edits, by the name its tabs send.
var TEXTS = { memorial: [MEMORIAL_FILE, "Memorial"], life: [LIFE_FILE, "Scout’s Life"] };
// A photo's tag in the memorial text, "(caption[file 35% print])",
// anywhere in it: the same as MEMORIAL_TAG in /memorial.js, which draws
// the page and the preview here.
var MEMORIAL_TAG = /\(([^()\[\]\n]*)\[\s*<?([^\[\]<>\/\\\n]+?)>?(?:\s+(\d{1,3})%)?(?:\s+(outline|print|mat|none))?\s*\]\)/gi;
var ROLES = { intro: "the intro photo" };
var GALLERY_OUT_LIST = "not_in_gallery.txt";
var SLIDES_LIST = "slideshow.txt"; // what's in Moments (once "the slideshow")
var OLD_MOMENTS_LIST = "moments.txt"; // GIFs and videos, before Moments and the slideshow became one; merged into SLIDES_LIST on start
var MEMORIES_FILE = "memories.json";
var MAX_MEMORIES = 100, MAX_MEMORY_TITLE = 120, MAX_MEMORY_TEXT = 6000; // characters
var MAX_MEMORY_PHOTOS = 30; // pictures per memory
var TRANSITIONS_FILE = "transitions.txt";
// The page's sections in order, by their data-anchor (the intro's id is
// "top"); a transition plays between one and the next, either way.
var TRANSITIONS = [
  ["top>dedication", "First page ↔ Memorial"],
  ["dedication>life", "Memorial ↔ Scout’s Life"],
  ["life>memories", "Scout’s Life ↔ Memories"],
  ["memories>moments", "Memories ↔ Moments"],
  ["moments>gallery", "Moments ↔ Gallery"],
  ["gallery>messages", "Gallery ↔ Messages"]
];
var CAPTIONS_FILE = "captions.txt";
var ORDER_LIST = "order.txt";
var MAX_CAPTION = 200; // characters
var SETTINGS_FILE = "settings.txt";
var DEFAULT_SLIDE_SECONDS = 5; // script.js uses the same default
var MAX_SLIDE_SECONDS = 120;
// Kept in media/ for the page to read, but not media themselves.
var DATA_FILES = [GALLERY_OUT_LIST, SLIDES_LIST, OLD_MOMENTS_LIST, MEMORIES_FILE, TRANSITIONS_FILE, PAGE_LIST, MEMORIAL_FILE, LIFE_FILE, CAPTIONS_FILE, ORDER_LIST, SETTINGS_FILE];

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

// The order Moments and the gallery use: files named in ORDER_LIST first,
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

function slideSeconds() {
  var n = DEFAULT_SLIDE_SECONDS;
  readList(SETTINGS_FILE).forEach(function (l) {
    var m = /^slide_seconds\s*=\s*(\d+(?:\.\d+)?)$/.exec(l);
    if (m && +m[1] > 0) n = +m[1];
  });
  return n;
}

// { "<from>><to>": file } for the transitions that have a GIF, plus
// random: [files] for the GIFs in the Random pool.
function readTransitions() {
  var t = { random: [] };
  readList(TRANSITIONS_FILE).forEach(function (l) {
    var i = l.indexOf("=");
    if (i <= 0) return;
    var k = l.slice(0, i).trim(), v = l.slice(i + 1).trim();
    if (k === "random") t.random.push(v); else t[k] = v;
  });
  return t;
}
function writeTransitions(t) {
  writeFile(TRANSITIONS_FILE, TRANSITIONS.filter(function (tr) { return t[tr[0]]; })
    .map(function (tr) { return tr[0] + "=" + t[tr[0]] + "\n"; }).join("") +
    t.random.map(function (f) { return "random=" + f + "\n"; }).join(""));
}

function writeCaptions(caps) {
  writeFile(CAPTIONS_FILE, Object.keys(caps).filter(function (f) { return caps[f]; }).sort(naturalCompare)
    .map(function (f) { return f + "=" + caps[f] + "\n"; }).join(""));
}

// The Memories section: [{ title, text, photos }], photos files in media/
// (photos, GIFs or videos), the first the main one. Older entries have a
// single "photo" (a file or ""), read as photos.
function readMemories() {
  try {
    var list = JSON.parse(fs.readFileSync(filePath(MEMORIES_FILE), "utf8"));
    return (Array.isArray(list) ? list : []).map(function (m) {
      m = m || {};
      var photos = Array.isArray(m.photos) ? m.photos : m.photo ? [m.photo] : [];
      return { title: String(m.title || ""), text: String(m.text || ""), photos: photos.filter(function (f) { return typeof f === "string" && f; }) };
    });
  } catch (e) { if (e.code !== "ENOENT") console.error(e); return []; }
}
function writeMemories(list) {
  writeFile(MEMORIES_FILE, JSON.stringify(list, null, 2) + "\n");
}

// Once, on start, after Moments and the slideshow became one section,
// Memories came in after the Memorial and Scout's Life between them: the
// old Moments list joins the slideshow list (now Moments), and the
// transitions move to the new section boundaries (the one into Memories
// still plays arriving at Memories).
function migrate() {
  try {
    if (fs.existsSync(filePath(OLD_MOMENTS_LIST))) {
      writeList(SLIDES_LIST, readList(SLIDES_LIST).concat(readList(OLD_MOMENTS_LIST)));
      fs.unlinkSync(filePath(OLD_MOMENTS_LIST));
      console.log("migrate: merged " + OLD_MOMENTS_LIST + " into " + SLIDES_LIST);
    }
    var t = readTransitions(), moved = false;
    [["dedication>slideshow", "memories>moments"], ["slideshow>moments", "moments>gallery"], ["dedication>memories", "life>memories"]].forEach(function (m) {
      if (!t[m[0]]) return;
      if (!t[m[1]]) t[m[1]] = t[m[0]];
      delete t[m[0]];
      moved = true;
    });
    if (moved) { writeTransitions(t); console.log("migrate: moved transitions to the new sections"); }
  } catch (e) { console.error("migrate:", e); }
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

function setPageFile(role, file) {
  var roles = pageFiles();
  roles[role] = file;
  writeFile(PAGE_LIST, Object.keys(roles).map(function (r) { return r + "=" + roles[r] + "\n"; }).join(""));
}

function renamePageFile(file, to) {
  var roles = pageFiles(), changed = false;
  Object.keys(roles).forEach(function (r) { if (roles[r] === file) { roles[r] = to; changed = true; } });
  if (!changed) return;
  writeFile(PAGE_LIST, Object.keys(roles).map(function (r) { return r + "=" + roles[r] + "\n"; }).join(""));
}

// After a delete (or rename), drop the old name from the lists, captions,
// order, transitions, memories and the Memorial and Scout's Life texts (or carry it all over to
// the new name).
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
  var trans = readTransitions(), moved = false;
  Object.keys(trans).forEach(function (k) {
    if (k === "random" || trans[k] !== file) return;
    if (renamedTo) trans[k] = renamedTo; else delete trans[k];
    moved = true;
  });
  var r = trans.random.indexOf(file);
  if (r >= 0) {
    if (renamedTo) trans.random[r] = renamedTo; else trans.random.splice(r, 1);
    moved = true;
  }
  if (moved) writeTransitions(trans);
  var caps = readCaptions();
  if (caps[file] !== undefined) {
    if (renamedTo) caps[renamedTo] = caps[file];
    delete caps[file];
    writeCaptions(caps);
  }
  var memories = readMemories(), changed = false;
  memories.forEach(function (m) {
    if (m.photos.indexOf(file) < 0) return;
    m.photos = m.photos.map(function (f) { return f === file ? renamedTo : f; }).filter(Boolean);
    changed = true;
  });
  if (changed) writeMemories(memories);
  [MEMORIAL_FILE, LIFE_FILE].forEach(function (textFile) {
    var memorial = "";
    try { memorial = fs.readFileSync(filePath(textFile), "utf8"); } catch (e) { if (e.code !== "ENOENT") throw e; }
    var tagged = false;
    var next = memorial.replace(MEMORIAL_TAG, function (all, cap, name, size, frame) {
      if (name !== file) return all;
      tagged = true;
      return renamedTo ? "(" + cap + "[" + renamedTo + (size ? " " + size + "%" : "") + (frame ? " " + frame : "") + "])" : "";
    });
    // A deleted photo's tag goes, and the space or blank lines it leaves.
    if (tagged && !renamedTo) next = next.replace(/[ \t]{2,}/g, " ").replace(/ +\n/g, "\n").replace(/\n\s*\n(\s*\n)+/g, "\n\n").trim() + "\n";
    if (tagged) writeFile(textFile, next);
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

// The session cookie is "<expiry>.<hmac of expiry>", keyed on SESSION_SECRET
// (in both servers' env files), so changing it signs everyone out.
// messages.js checks it with the same code.
function sign(exp) { return crypto.createHmac("sha256", SESSION_SECRET).update(String(exp)).digest("hex"); }

function sessionCookie() {
  var exp = Date.now() + SESSION_MS;
  return "scout_admin=" + exp + "." + sign(exp) + "; Path=/; Max-Age=" + SESSION_MS / 1000 +
    "; HttpOnly; Secure; SameSite=Strict";
}

function isAdmin(req) {
  if (!SESSION_SECRET) return false;
  var m = /(?:^|;\s*)scout_admin=(\d+)\.([0-9a-f]{64})/.exec(req.headers.cookie || "");
  if (!m || Number(m[1]) < Date.now()) return false;
  return crypto.timingSafeEqual(Buffer.from(m[2], "hex"), Buffer.from(sign(m[1]), "hex"));
}

function nextPage(v) { return ADMIN_PAGES.indexOf(v) >= 0 ? v : "/admin"; }

var failures = new Map(); // ip -> [timestamps of wrong passwords]

// ---- the admin password ----

// The owner's own password ({ salt, hash }, scrypt), or null while the env
// file's ADMIN_PASSWORD is still the one.
function storedPassword() {
  try { return JSON.parse(fs.readFileSync(PASSWORD_FILE, "utf8")); }
  catch (e) { if (e.code !== "ENOENT") console.error(e); return null; }
}
function checkPassword(pass) {
  var stored = storedPassword();
  if (stored && stored.salt && stored.hash) {
    var hash = crypto.scryptSync(pass, Buffer.from(stored.salt, "hex"), 64);
    return crypto.timingSafeEqual(hash, Buffer.from(stored.hash, "hex"));
  }
  return !!ADMIN_PASSWORD && crypto.timingSafeEqual(sha(pass), sha(ADMIN_PASSWORD));
}
function setPassword(pass) {
  var salt = crypto.randomBytes(16);
  var data = JSON.stringify({ salt: salt.toString("hex"), hash: crypto.scryptSync(pass, salt, 64).toString("hex"), changedAt: new Date().toISOString() });
  fs.mkdirSync(path.dirname(PASSWORD_FILE), { recursive: true });
  var tmp = PASSWORD_FILE + ".tmp";
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, PASSWORD_FILE);
}

// Wrong current passwords count towards the same lock-out as signing in.
function tooManyFailures(ip) {
  var now = Date.now();
  var list = (failures.get(ip) || []).filter(function (t) { return now - t < LOGIN_WINDOW_MS; });
  failures.set(ip, list);
  return list.length >= LOGIN_LIMIT;
}

function passwordPage(res, msg) {
  var html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Scout admin – password</title><style>' +
    'body{margin:0;padding:24px 20px;background:#FAF4EA;color:#2B211B;font:16px/1.6 Georgia,serif}' +
    'main{max-width:400px;margin:6vh auto 0}h1{font-weight:400}label{display:block;font:600 13px system-ui,sans-serif;margin-bottom:6px}' +
    'input{box-sizing:border-box;width:100%;font:16px system-ui,sans-serif;padding:10px 12px;border:1px solid #DBC8AE;border-radius:4px;background:#FFFDF8;margin-bottom:14px}' +
    'button{font:600 15px system-ui,sans-serif;padding:10px 20px;border-radius:999px;border:1px solid #A8571F;background:#A8571F;color:#FFF8EC;cursor:pointer}' +
    '.err{color:#9b2c2c;font:14px system-ui,sans-serif}.hint{font:14px system-ui,sans-serif;color:#6B5748}.back{font:14px system-ui,sans-serif}' +
    '</style></head><body><main><p class="back"><a href="/admin">← Admin</a></p><h1>Change password</h1>' +
    (msg ? '<p class="err">' + esc(msg) + '</p>' : '') +
    '<form method="post" action="/admin/password">' +
    '<label for="cur">Current password</label><input id="cur" name="current" type="password" autocomplete="current-password" required>' +
    '<label for="new">New password</label><input id="new" name="password" type="password" autocomplete="new-password" minlength="' + MIN_PASSWORD + '" required>' +
    '<label for="again">New password again</label><input id="again" name="again" type="password" autocomplete="new-password" minlength="' + MIN_PASSWORD + '" required>' +
    '<p class="hint">At least ' + MIN_PASSWORD + ' characters. It\'s the one password for every admin page.</p>' +
    '<button>Change password</button></form></main></body></html>';
  send(res, msg ? 400 : 200, html, { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY" });
}

function changePassword(req, res) {
  var ip = req.headers["x-real-ip"] || req.socket.remoteAddress || "";
  readForm(req, function (f) {
    if (tooManyFailures(ip)) return passwordPage(res, "Too many wrong passwords. Please wait 15 minutes and try again.");
    if (!checkPassword(String(f.current || "").trim())) {
      failures.get(ip).push(Date.now());
      return passwordPage(res, "Your current password isn't right.");
    }
    var pass = String(f.password || "").trim();
    if (pass.length < MIN_PASSWORD) return passwordPage(res, "The new password needs at least " + MIN_PASSWORD + " characters.");
    if (pass.length > 200) return passwordPage(res, "That's a very long password (200 characters max).");
    if (pass !== String(f.again || "").trim()) return passwordPage(res, "The two new passwords don't match.");
    try { setPassword(pass); } catch (e) { console.error(e); return passwordPage(res, "Couldn't save the new password: " + e.code); }
    send(res, 303, "", { Location: "/admin?msg=" + encodeURIComponent("Your password has been changed.") });
  });
}

function login(req, res) {
  var ip = req.headers["x-real-ip"] || req.socket.remoteAddress || "";
  var now = Date.now();
  var list = (failures.get(ip) || []).filter(function (t) { return now - t < LOGIN_WINDOW_MS; });
  readForm(req, function (f) {
    if (list.length >= LOGIN_LIMIT) return loginPage(res, "Too many tries. Please wait 15 minutes and try again.", f.next);
    var pass = String(f.password || "").trim();
    if (checkPassword(pass)) {
      failures.delete(ip);
      return send(res, 303, "", { Location: nextPage(f.next), "Set-Cookie": sessionCookie() });
    }
    list.push(now);
    failures.set(ip, list);
    loginPage(res, "That password isn't right.", f.next);
  });
}

function loginPage(res, error, next) {
  var html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Scout admin</title><style>' +
    'body{margin:0;padding:24px 20px;background:#FAF4EA;color:#2B211B;font:16px/1.6 Georgia,serif}' +
    'main{max-width:360px;margin:12vh auto 0}h1{font-weight:400}label{display:block;font:600 13px system-ui,sans-serif;margin-bottom:6px}' +
    'input{box-sizing:border-box;width:100%;font:16px system-ui,sans-serif;padding:10px 12px;border:1px solid #DBC8AE;border-radius:4px;background:#FFFDF8;margin-bottom:14px}' +
    'button{font:600 15px system-ui,sans-serif;padding:10px 20px;border-radius:999px;border:1px solid #A8571F;background:#A8571F;color:#FFF8EC;cursor:pointer}' +
    '.err{color:#9b2c2c;font:14px system-ui,sans-serif}' +
    '</style></head><body><main><h1>Scout admin</h1>' +
    (error ? '<p class="err">' + esc(error) + '</p>' : '') +
    '<form method="post" action="/admin/login"><input type="hidden" name="next" value="' + esc(nextPage(next)) + '"><label for="pw">Password</label>' +
    '<input id="pw" name="password" type="password" autocomplete="current-password" autofocus required>' +
    '<button>Sign in</button></form></main></body></html>';
  send(res, error ? 401 : 200, html, { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY" });
}

// Admin POSTs must come from this site's own pages, not a form on some other
// site (SameSite=Strict already blocks that; this is a second check).
// The site is served under several domains, so "this site" is whichever
// one the request came in on (nginx passes it on as Host).
function sameOrigin(req) {
  var o = req.headers.origin || req.headers.referer || "";
  var site = "https://" + (req.headers.host || "");
  return o === site || o.indexOf(site + "/") === 0;
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

// A visitor's photo from the messages server: the file is the raw body, and
// the query names it and says where it goes (gallery, moments, caption;
// "slideshow" is an old name for moments). A name that's taken gets -2, -3... added.
function importFromMessages(req, res, query) {
  var token = String(req.headers["x-import-token"] || "");
  if (!IMPORT_TOKEN || req.headers["x-real-ip"] || !crypto.timingSafeEqual(sha(token), sha(IMPORT_TOKEN))) return send(res, 403, "Forbidden");
  var name = cleanName(query.get("name"));
  if (!validFile(name)) return json(res, 400, { error: "That isn't a photo or video." });
  var base = name.replace(/(\.[^.]+)$/, ""), ext = path.extname(name);
  for (var n = 2; fs.existsSync(filePath(name)); n++) name = base + "-" + n + ext;
  // Streamed to a hidden .part file (videos can be big), then renamed.
  var tmp = filePath("." + name + "." + crypto.randomBytes(4).toString("hex") + ".part");
  var out = fs.createWriteStream(tmp, { flags: "wx" }), size = 0, failed = false;
  function fail(error) {
    if (failed) return;
    failed = true;
    out.destroy();
    fs.rm(tmp, { force: true }, function () {});
    json(res, 400, { error: error });
  }
  req.on("data", function (c) { size += c.length; if (size > MAX_UPLOAD) { fail("That file is too big."); req.destroy(); } });
  out.on("error", function (e) { console.error(e); fail("Couldn't save the file."); });
  out.on("finish", function () {
    if (failed) return;
    if (!size) return fail("That file is empty.");
    try {
      fs.renameSync(tmp, filePath(name));
      setFlag(GALLERY_OUT_LIST, name, query.get("gallery") !== "1");
      setFlag(SLIDES_LIST, name, query.get("moments") === "1" || query.get("slideshow") === "1");
      var caption = String(query.get("caption") || "").replace(/\s+/g, " ").trim().slice(0, MAX_CAPTION);
      if (caption) { var caps = readCaptions(); caps[name] = caption; writeCaptions(caps); }
    } catch (e) { console.error(e); return json(res, 500, { error: "Couldn't save the file." }); }
    json(res, 201, { ok: true, name: name });
  });
  req.pipe(out);
}

// ---- actions (form posts) ----

function action(req, res) {
  readForm(req, function (f) {
    var msg = "";
    var exists = validFile(f.file) && fs.existsSync(filePath(f.file));
    if (f.action === "memorial") {
      // The Memorial's text or Scout's Life's ("which"). Tidy line endings
      // and stray spaces; blank lines separate paragraphs.
      var which = TEXTS[f.which] ? f.which : "memorial", what = TEXTS[which][1];
      var text = String(f.text || "").replace(/\r\n?/g, "\n").split(/\n\s*\n/)
        .map(function (p) { return p.replace(/[ \t]+\n/g, "\n").trim(); }).filter(Boolean).join("\n\n");
      if (!text && which === "memorial") msg = "The memorial text can't be empty.";
      else if (text.length > MAX_MEMORIAL) msg = "That's too long (" + MAX_MEMORIAL + " characters max).";
      else {
        try {
          writeFile(TEXTS[which][0], text ? text + "\n" : "");
          msg = "Saved the " + what + " text.";
        } catch (e) { console.error(e); msg = "Couldn't save the " + what + " text: " + e.code; }
      }
      return send(res, 303, "", { Location: "/media-admin?msg=" + encodeURIComponent(msg) + "&text=" + which + "#memorial" });
    }
    // The memories editor saves them all at once and gets JSON back.
    if (f.action === "memories") {
      var list;
      try { list = JSON.parse(f.data || ""); } catch (e) { list = null; }
      if (!Array.isArray(list)) return json(res, 400, { error: "That didn’t come through right; try again." });
      if (list.length > MAX_MEMORIES) return json(res, 400, { error: "That’s more than " + MAX_MEMORIES + " memories." });
      var clean = [], tooLong = null;
      list.forEach(function (m, i) {
        m = m || {};
        var title = String(m.title || "").replace(/\s+/g, " ").trim().slice(0, MAX_MEMORY_TITLE);
        var text = String(m.text || "").replace(/\r\n?/g, "\n").split(/\n\s*\n/)
          .map(function (p) { return p.replace(/[ \t]+\n/g, "\n").trim(); }).filter(Boolean).join("\n\n");
        var photos = (Array.isArray(m.photos) ? m.photos : m.photo ? [m.photo] : []).map(String)
          .filter(function (p, j, all) { return all.indexOf(p) === j && validFile(p) && fs.existsSync(filePath(p)); });
        if (text.length > MAX_MEMORY_TEXT) tooLong = tooLong || "Memory " + (i + 1) + " is too long (" + MAX_MEMORY_TEXT + " characters max).";
        if (photos.length > MAX_MEMORY_PHOTOS) tooLong = tooLong || "Memory " + (i + 1) + " has more than " + MAX_MEMORY_PHOTOS + " pictures.";
        if (title || text || photos.length) clean.push({ title: title, text: text, photos: photos });
      });
      if (tooLong) return json(res, 400, { error: tooLong });
      try { writeMemories(clean); } catch (e) { console.error(e); return json(res, 500, { error: "Couldn’t save: " + e.code }); }
      return json(res, 200, { ok: true, count: clean.length });
    }
    if (f.action === "settings") {
      var secs = Number(f.slide_seconds);
      if (!(secs >= 1 && secs <= MAX_SLIDE_SECONDS)) msg = "Pick a number of seconds from 1 to " + MAX_SLIDE_SECONDS + ".";
      else {
        secs = Math.round(secs * 10) / 10;
        try {
          writeFile(SETTINGS_FILE, "slide_seconds=" + secs + "\n");
          msg = "Each photo now shows for " + secs + " second" + (secs === 1 ? "" : "s") + ".";
        } catch (e) { console.error(e); msg = "Couldn't save the setting: " + e.code; }
      }
      return send(res, 303, "", { Location: "/media-admin?msg=" + encodeURIComponent(msg) + "#slideshow" });
    }
    // The checkboxes save in the background and get JSON back.
    if (f.action === "flags") {
      if (!exists) return json(res, 400, { error: "That file is gone." });
      try {
        setFlag(GALLERY_OUT_LIST, f.file, f.gallery !== "1");
        setFlag(SLIDES_LIST, f.file, f.moments === "1");
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
    // The title page photo (saves in the background, like the checkboxes).
    if (f.action === "intro") {
      if (!PHOTO_EXT.test(f.file || "")) return json(res, 400, { error: "Pick a photo, not a GIF or video." });
      if (!exists) return json(res, 400, { error: "That photo is gone." });
      try { setPageFile("intro", f.file); } catch (e) { console.error(e); return json(res, 500, { error: "Couldn't save." }); }
      return json(res, 200, { ok: true });
    }
    // A GIF's transition ("" for none, "random" for the Random pool); one
    // GIF per transition, any number in the pool.
    if (f.action === "transition") {
      if (!exists || !GIF_EXT.test(f.file)) return json(res, 400, { error: "That GIF is gone." });
      var key = String(f.transition || "");
      if (key && key !== "random" && !TRANSITIONS.some(function (tr) { return tr[0] === key; })) return json(res, 400, { error: "No such transition." });
      try {
        var trans = readTransitions();
        if (key && key !== "random" && trans[key] && trans[key] !== f.file) return json(res, 409, { error: "Another GIF has that one." });
        Object.keys(trans).forEach(function (k) { if (k !== "random" && trans[k] === f.file) delete trans[k]; });
        trans.random = trans.random.filter(function (x) { return x !== f.file; });
        if (key === "random") trans.random.push(f.file);
        else if (key) trans[key] = f.file;
        writeTransitions(trans);
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

// ---- /admin: links to every admin page ----

// How many messages are waiting, from the messages server (null if it
// can't say).
function messageCounts(cb) {
  if (!IMPORT_TOKEN) return cb(null);
  var req = http.request({ host: "127.0.0.1", port: MESSAGES_PORT, path: "/internal/stats", headers: { "X-Import-Token": IMPORT_TOKEN }, timeout: 2000 }, function (r) {
    var chunks = [];
    r.on("data", function (c) { chunks.push(c); });
    r.on("end", function () { try { cb(r.statusCode === 200 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null); } catch (e) { cb(null); } });
  });
  req.on("timeout", function () { req.destroy(); });
  req.on("error", function () { cb(null); });
  req.end();
}

function hubPage(res, msg) {
  messageCounts(function (counts) {
    var waiting = counts ? counts.pending : null;
    function card(href, title, text, badge) {
      return '<a class="card" href="' + href + '"><span class="t">' + title + (badge ? ' <b class="badge">' + badge + '</b>' : '') + '</span><span class="d">' + text + '</span></a>';
    }
    var html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>Scout admin</title><style>' +
      'body{margin:0;padding:24px 20px 60px;background:#FAF4EA;color:#2B211B;font:16px/1.6 Georgia,serif}' +
      'main{max-width:640px;margin:0 auto}h1{font-weight:400;margin-bottom:4px}' +
      'h2{font:600 13px system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:#8F4818;margin:32px 0 10px}' +
      '.card{display:block;background:#fff;border:1px solid #E5D6C0;border-radius:6px;padding:14px 18px;margin:10px 0;color:inherit;text-decoration:none}' +
      '.card:hover{border-color:#A8571F}.t{display:block;font:600 16px system-ui,sans-serif}.d{display:block;font:14px system-ui,sans-serif;color:#6B5748}' +
      '.badge{display:inline-block;min-width:1.6em;padding:0 7px;border-radius:999px;background:#A8571F;color:#FFF8EC;font-size:13px;text-align:center}' +
      '.sub{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px}.sub .card{margin:0}' +
      '.out{float:right;margin-top:14px}.out button{font:600 13px system-ui,sans-serif;padding:6px 12px;border-radius:999px;border:1px solid #DBC8AE;background:#FAF4EA;cursor:pointer;color:#2B211B}' +
      '.site{font:14px system-ui,sans-serif}' +
      '.msg{background:#FFF1D6;border:1px solid #E8C98F;border-radius:4px;padding:10px 14px;font:14px system-ui,sans-serif}' +
      '</style></head><body><main><form method="post" action="/admin/logout" class="out"><button>Sign out</button></form>' +
      '<h1>Scout admin</h1><p class="site"><a href="/">View the site →</a></p>' +
      (msg ? '<p class="msg">' + esc(msg) + '</p>' : '') +
      '<h2>Messages</h2>' +
      card("/messages-admin", "Messages", waiting === null ? "Approve, hide or delete what visitors leave, and copy their photos into your media."
        : waiting ? waiting + " waiting for approval. Approve, hide or delete them, and copy their photos into your media." : "Nothing waiting. Approve, hide or delete what visitors leave, and copy their photos into your media.", waiting || "") +
      '<h2>Photos and videos</h2>' +
      card("/media-admin", "Media manager", "Upload, rename and delete files; pick what goes in Moments and the gallery; captions, order and transitions.") +
      '<div class="sub">' +
      card("/media-admin#title-photo", "Title page photo", "The big photo on the first page.") +
      card("/media-admin#memorial", "Memorial text", "The words in the Memorial section.") +
      card("/media-admin?text=life#memorial", "Scout’s Life text", "The words in the Scout’s Life section, after the Memorial.") +
      card("/media-admin#memories", "Memories", "The little stories in the Memories section, with their photos, GIFs and videos.") +
      card("/media-admin#slideshow", "Moments timing", "How long each photo shows in Moments.") +
      '</div>' +
      '<h2>You</h2>' +
      card("/admin/password", "Change password", "Set your own password for signing in to these pages.") +
      '</main></body></html>';
    send(res, 200, html, { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY" });
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
  var transitions = readTransitions();
  var intro = pageFiles().intro || "";
  var photos = files.map(function (f) { return f.name; }).filter(function (n) { return PHOTO_EXT.test(n); });
  var captions = readCaptions();
  // The memorial box edits the Memorial text or Scout's Life's, one at a
  // time (its tabs); it opens on the one just saved.
  var texts = {};
  Object.keys(TEXTS).forEach(function (k) {
    texts[k] = "";
    try { texts[k] = fs.readFileSync(filePath(TEXTS[k][0]), "utf8").trim(); } catch (e) { if (e.code !== "ENOENT") throw e; }
  });
  var textNow = TEXTS[query.get("text")] ? query.get("text") : "memorial";

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
      (GIF_EXT.test(f.name) ? transitionPicker(f.name, transitions) : '') +
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

  var note = '<p class="hint"><b>Moments</b> puts a photo, GIF or video in the Moments section, a stack that moves on by itself: a photo after its time (set under Moments timing), a GIF after four plays, a video after it plays once. <b>Gallery</b> puts it in the gallery grid. A GIF\'s <b>Transition</b> plays it once when moving between two sections (either way, or jumping there with the menu); each transition can have one GIF, and one already taken is greyed out. <b>Random</b> puts a GIF in a pool: every transition without its own GIF plays one from it, picked at random. Visitors can skip a transition by scrolling, tapping or pressing a key. New uploads are in the gallery but not Moments, and go at the end. ' +
    'To change the order, switch to <b>Display order</b> and drag a file to its new place (by its ⠿ handle on a phone). A caption shows under it in Moments and in the enlarged view.</p>';

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
    '.transition{align-items:center;font:14px system-ui,sans-serif}.transition label{display:flex;gap:8px;align-items:center}' +
    '.transition select{font:14px system-ui,sans-serif;padding:6px 8px;border:1px solid #DBC8AE;border-radius:4px;background:#FFFDF8;color:#2B211B}' +
    '.transition option:disabled{color:#b5a593}' +
    '.intro-pick{display:flex;gap:18px;align-items:flex-start;font:14px system-ui,sans-serif}.intro-pick label{display:flex;flex-wrap:wrap;gap:8px;align-items:center}' +
    '.intro-pick select{font:14px system-ui,sans-serif;padding:6px 8px;border:1px solid #DBC8AE;border-radius:4px;background:#FFFDF8;color:#2B211B;max-width:100%}' +
    '#intro-preview{flex:none;width:96px;aspect-ratio:499/934;object-fit:cover;border-radius:3px;border:1px solid #E5D6C0;background:#F1E6D4}' +
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
    '#sortable .file{cursor:grab}#sortable .file input,#sortable .file select,#sortable .file label{cursor:auto}#sortable .file button,#sortable .flags label{cursor:pointer}#sortable .file .grip{cursor:grab}' +
    '.file.dragging{opacity:.75;border-color:#A8571F;box-shadow:0 8px 24px rgba(64,42,25,.18)}.file.dragging .grip{cursor:grabbing}' +
    '.order-note{font:13px system-ui,sans-serif;color:#6B5748;min-height:1.4em;margin:0}' +
    '@media(max-width:520px){.file{flex-direction:column}.thumb{flex-basis:auto;width:100%;height:180px}' +
    '#sortable .file{flex-direction:row;flex-wrap:wrap}#sortable .thumb{flex:1 1 0;height:90px}#sortable .info{flex-basis:100%}.grip{align-self:auto;height:90px}}' +
    '.memorial textarea{box-sizing:border-box;width:100%;min-height:340px;font:17px/1.6 Georgia,serif;padding:12px 14px;border:1px solid #DBC8AE;border-radius:4px;background:#FFFDF8;color:#2B211B;resize:vertical;margin-bottom:10px}' +
    '.jump{font:14px system-ui,sans-serif;margin:-4px 0 0}' +
    '.tools{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}.tools button{min-width:44px}.tools button[aria-expanded=true]{background:#EFE2CE;border-color:#A8571F}' +
    '.photo-pick{border:1px solid #DBC8AE;border-radius:6px;background:#FFFDF8;padding:12px;margin-bottom:10px;font:14px system-ui,sans-serif}.photo-pick label input{width:100%;box-sizing:border-box;margin-top:4px}' +
    '.photo-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px;max-height:340px;overflow:auto}' +
    '.photo-grid button{padding:4px;border-radius:6px;display:flex;flex-direction:column;gap:4px;align-items:stretch;font-weight:400;font-size:11px}' +
    '.photo-grid img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:3px;display:block}.photo-grid button{position:relative}.photo-grid .gif-badge{position:absolute;top:8px;left:8px;padding:1px 5px;border-radius:3px;background:rgba(0,0,0,.65);color:#fff;font-size:10px;font-weight:600;letter-spacing:.04em}.photo-grid span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.preview-head{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;margin:28px 0 8px}.preview-head h3{font:600 13px system-ui,sans-serif;text-transform:uppercase;letter-spacing:.08em;color:#6B5748;margin:0}' +
    '.seg{display:inline-flex;gap:4px}.text-tabs{display:flex;margin:0 0 10px}.seg button{padding:6px 12px}.seg button[aria-pressed=true],.frames button[aria-pressed=true]{background:#A8571F;border-color:#A8571F;color:#FFF8EC}' +
    '.pv-box{position:relative;overflow:hidden;border:1px solid #DBC8AE;border-radius:6px;background:#E9DECD}.pv-box iframe{position:absolute;top:0;border:0;transform-origin:0 0;background:#FAF4EA;box-shadow:0 0 0 1px #DBC8AE}' +
    '.frames{display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin-top:6px}.frames button{padding:5px 10px;font-size:12px}.frames .lab{margin-right:4px}' +
    '.mem{border:1px solid #DBC8AE;border-radius:6px;background:#FFFDF8;padding:12px;margin-bottom:12px;font:14px system-ui,sans-serif}' +
    '.mem-pics{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}.mem-pic{position:relative;width:96px;display:flex;flex-direction:column;gap:3px}' +
    '.mem-pic img,.mem-pic video{width:96px;height:96px;object-fit:cover;border-radius:5px;display:block;background:#F3E8D8}.mem-pic.is-main img,.mem-pic.is-main video{outline:2px solid #A8571F;outline-offset:1px}' +
    '.mem-main{position:absolute;top:4px;left:4px;padding:1px 6px;border-radius:3px;background:#A8571F;color:#fff;font-size:10px;font-weight:600}' +
    '.mem-pic-tools{display:flex;gap:2px;justify-content:center}.mem-pic-tools button{padding:2px 0;flex:1;font-size:12px;min-width:0}' +
    '.mem-add-pic{width:96px;height:96px;padding:4px;border-radius:6px;border:1px dashed #DBC8AE;background:#F3E8D8;color:#6B5748;font-size:12px}' +
    '.mem-pick .photo-grid{max-height:360px;overflow-y:auto}.mem-pick .photo-grid video{width:100%;aspect-ratio:1;object-fit:cover;border-radius:3px;display:block}' +
    '.mem-pick button.is-picked{outline:3px solid #A8571F;outline-offset:-1px}.mem-pick button.is-picked::after{content:attr(data-n);position:absolute;top:6px;right:6px;min-width:20px;height:20px;border-radius:999px;background:#A8571F;color:#fff;font-size:11px;font-weight:600;display:grid;place-items:center}' +
    '.mem-pick-done{padding:3px 12px;font-size:12px;margin-left:6px}' +
    '.mem input.mem-title{width:100%;box-sizing:border-box;margin-top:4px;font:600 16px Georgia,serif;padding:6px 8px;border:1px solid #DBC8AE;border-radius:4px}' +
    '.mem textarea{box-sizing:border-box;width:100%;min-height:120px;font:16px/1.55 Georgia,serif;padding:8px 10px;border:1px solid #DBC8AE;border-radius:4px;background:#FFFDF8;resize:vertical;margin-top:8px}' +
    '.mem-tools{display:flex;gap:6px;flex-wrap:wrap;align-items:center}.mem-tools button{padding:4px 10px;font-size:12px}.mem-num{color:#6B5748;font-weight:600;margin-right:auto}' +
    '.mem .photo-pick{margin-top:8px}.nophoto{display:grid;place-items:center;aspect-ratio:1;border:1px dashed #DBC8AE;border-radius:3px;color:#6B5748}' +
    '.photo-edit .done{align-self:flex-start;padding:4px 10px;font-size:12px}' +
    '@media(max-width:520px){#photo-edit{gap:8px;padding:8px;align-items:flex-start}#photo-edit img{width:44px;height:44px}#photo-edit .size{margin-top:2px}.frames{gap:3px}.frames .lab{display:none}.frames button{padding:4px 8px}}' +
    // Sliders drawn here, not by the browser (its knob stops short of the end
    // at 100%): the filled part is --fill wide, set by fillRange().
    'input[type=range]{-webkit-appearance:none;appearance:none;height:22px;padding:0;border:0;box-shadow:none;background:transparent;cursor:pointer}' +
    'input[type=range]::-webkit-slider-runnable-track{height:6px;border-radius:3px;background:linear-gradient(#A8571F,#A8571F) 0 0/var(--fill,50%) 100% no-repeat,#E5D6C0}' +
    'input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:18px;height:18px;margin-top:-6px;border-radius:50%;background:#A8571F;border:2px solid #FFF8EC;box-sizing:border-box;box-shadow:0 1px 3px rgba(0,0,0,.3)}' +
    'input[type=range]::-moz-range-track{height:6px;border-radius:3px;background:#E5D6C0}input[type=range]::-moz-range-progress{height:6px;border-radius:3px;background:#A8571F}' +
    'input[type=range]::-moz-range-thumb{width:18px;height:18px;border-radius:50%;background:#A8571F;border:2px solid #FFF8EC;box-sizing:border-box;box-shadow:0 1px 3px rgba(0,0,0,.3)}' +
    'input[type=range]:focus-visible{outline:2px solid #A8571F;outline-offset:2px;border-radius:4px}' +
    '.photo-edit{position:sticky;top:0;z-index:2;display:flex;gap:12px;align-items:center;border:1px solid #A8571F;border-radius:6px;background:#FFFDF8;padding:10px;margin-bottom:10px;font:14px system-ui,sans-serif;box-shadow:0 4px 12px rgba(64,42,25,.12)}' +
    '.photo-edit[hidden]{display:none}.photo-edit img{width:64px;height:64px;object-fit:cover;border-radius:4px;flex:none}.pe-body{flex:1;min-width:0}' +
    '.pe-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.photo-edit .size{display:flex;gap:8px;align-items:center;margin-top:6px}.photo-edit .size input{flex:1}' +
    '.photo-pick .size{display:flex;gap:8px;align-items:center;margin-top:10px}.photo-pick .size input{flex:1;max-width:320px}' +
    '.settings{display:flex;flex-wrap:wrap;gap:10px;align-items:center;font:15px system-ui,sans-serif}.settings input{width:80px;margin-left:8px}' +
    '.out{float:right;font:13px system-ui,sans-serif;margin-top:14px}.out button{padding:6px 12px}' +
    '</style></head><body><main><form method="post" action="/admin/logout" class="out"><button>Sign out</button></form><p class="jump"><a href="/admin">← Admin</a></p><h1>Scout’s media</h1>' +
    '<p class="jump"><a href="#title-photo">Title page photo ↓</a> · <a href="#slideshow">Moments timing ↓</a> · <a href="#memorial">Memorial &amp; Scout’s Life text ↓</a> · <a href="#memories">Memories ↓</a></p>' +
    (msg ? '<p class="msg">' + esc(msg) + '</p>' : '') +
    '<h2>Upload</h2>' +
    '<label class="drop" id="drop">Drop photos or videos here, or click to choose' +
    '<input type="file" id="pick" multiple accept="image/*,video/*,.mov,.m4v"></label><div id="progress"></div>' +
    note +
    '<div class="listhead"><h2>All media (' + files.length + ')</h2>' + toggle + '</div>' +
    (view === "order" && files.length > 1 ? '<p class="order-note" id="order-note" aria-live="polite"></p>' : '') + rows +
    '<h2 id="title-photo">Title page photo</h2>' +
    '<div class="intro-pick"><img id="intro-preview" src="' + (intro ? esc("/media/" + encodeURIComponent(intro)) : '') + '" alt=""' + (intro ? '' : ' hidden') + '>' +
    '<div><label>The big photo on the first page <select id="intro-select" aria-label="Title page photo">' +
    (intro && photos.indexOf(intro) < 0 ? '<option value="" selected>(missing: ' + esc(intro) + ')</option>' : '') +
    photos.map(function (n) { return '<option value="' + esc(n) + '"' + (n === intro ? ' selected' : '') + '>' + esc(n) + '</option>'; }).join("") +
    '</select></label> <span class="saved" id="intro-saved" aria-live="polite"></span>' +
    '<p class="hint">It fills a tall frame, so the sides of a wide photo are cropped off; the preview shows how it will look.</p></div></div>' +
    '<h2 id="slideshow">Moments timing</h2>' +
    '<form method="post" class="settings"><input type="hidden" name="action" value="settings">' +
    '<label>Seconds each photo shows <input type="number" name="slide_seconds" min="1" max="' + MAX_SLIDE_SECONDS + '" step="0.5" value="' + esc(slideSeconds()) + '" required></label> ' +
    '<button class="primary">Save</button></form>' +

    '<h2 id="memorial">Memorial &amp; Scout’s Life text</h2>' +
    '<p class="seg text-tabs" role="group" aria-label="Which text">' + Object.keys(TEXTS).map(function (k) {
      return '<button type="button" data-text="' + k + '" aria-pressed="' + (k === textNow) + '">' + TEXTS[k][1] + '</button>';
    }).join("") + '</p>' +
    '<p class="hint">The text in the Memorial section, and in Scout’s Life after it (the tabs above switch between them; save each one on its own). Keep the Memorial short and sweet; Scout’s Life is for his story. Leave a blank line between paragraphs; the first paragraph gets the large first letter. ' +
    'Select some words and press <b>B</b> or <i>I</i> to make them bold or italic (they get **stars** around them). <b>Heading</b> makes the paragraph your cursor is in a heading (it starts with "# "). ' +
    '<b>Add photo or GIF</b> puts a photo or GIF right where your cursor is, even in the middle of a paragraph (the text after it wraps around it), or on its own if your cursor is on the empty line between two paragraphs. It shows up as a tag like <code>(Scout as a puppy[01_scout_baby.jpg])</code>: the words in brackets are its caption (optional). ' +
    'To change a photo’s size or frame, tap it in the preview or put your cursor in its tag: a bar with its <b>Size</b> slider and <b>Frame</b> buttons shows up and stays at the top of the screen. Its line then reads like <code>01_scout_baby.jpg 35% print</code> (35% of the text’s width; from 70% up it sits centered on its own). ' +
    'Photos sit beside the text, taking turns left and right, at the same size for their screen on a computer and a phone (on a phone, never smaller than a thumbnail, and from 50% up centered on their own); the preview shows either. Move or delete the tag to move or remove the photo. Nothing changes on the site until you save.</p>' +
    '<div class="photo-edit" id="photo-edit" hidden><img alt=""><div class="pe-body"><div class="pe-name" id="pe-name"></div>' +
    '<label class="size">Size <input type="range" id="pe-size" min="15" max="100" step="1" value="46"> <output id="pe-out"></output></label>' +
    frameButtonsHtml("pe-frames") + '</div><button type="button" class="done" id="pe-done">Done</button></div>' +
    '<form method="post" class="memorial" id="memorial-form"><input type="hidden" name="action" value="memorial"><input type="hidden" name="which" id="memorial-which" value="' + textNow + '">' +
    '<div class="tools" role="toolbar" aria-label="Formatting">' +
    '<button type="button" data-wrap="**" title="Bold"><b>B</b></button>' +
    '<button type="button" data-wrap="*" title="Italic"><i>I</i></button>' +
    '<button type="button" data-heading title="Heading">Heading</button>' +
    '<button type="button" id="photo-toggle" aria-expanded="false" aria-controls="photo-pick">Add photo or GIF</button></div>' +
    '<div class="photo-pick" id="photo-pick" hidden>' +
    '<label>Caption (optional) <input type="text" id="photo-cap" maxlength="200" placeholder="e.g. Scout at the farm, 2015"></label>' +
    '<label class="size">Size <input type="range" id="photo-size" min="15" max="100" step="1" value="46"> <output id="photo-size-out">46%</output></label>' +
    frameButtonsHtml("photo-frames") +
    '<p class="hint">Tap a photo or GIF (marked GIF) to add it where your cursor is.</p><div class="photo-grid">' +
    photoButtons(files) + '</div></div>' +
    '<textarea name="text" id="memorial-text" aria-label="' + TEXTS[textNow][1] + ' text" maxlength="' + MAX_MEMORIAL + '">' + esc(texts[textNow]) + '</textarea>' +
    '<script type="application/json" id="memorial-texts">' + JSON.stringify(texts).replace(/</g, "\\u003c") + '</script>' +
    '<button class="primary" id="memorial-save">Save ' + TEXTS[textNow][1] + ' text</button> <span class="saved" id="memorial-dirty" aria-live="polite"></span></form>' +
    '<div class="preview-head"><h3>Preview: how it looks on the site</h3><span class="seg" role="group" aria-label="Preview size">' +
    '<button type="button" data-view="computer">Computer</button><button type="button" data-view="phone">Phone</button></span></div>' +
    '<div class="pv-box" id="pv-box"><iframe id="memorial-frame" src="/memorial-preview.html" title="Preview of the section"></iframe></div>' +
    '<p class="hint">Tap a photo in the preview to pick it.</p>' +
    '<h2 id="memories">Memories</h2>' +
    '<p class="hint">The little stories in the Memories section: each one is a card with its main picture and title, and opens to the whole story when tapped. A memory can have up to 30 pictures (photos, GIFs or videos): the one marked <b>Main</b> is on its card (a GIF or video shows there as a still), and with more than one they play as a slideshow above the story. Under each picture, ★ makes it the main one, ← → move it and ✕ takes it off. ' +
    'Blank lines separate paragraphs; **stars** make words bold, *one star* italic. ↑ ↓ change the order of the memories. Nothing changes on the site until you press <b>Save memories</b>.</p>' +
    '<div id="memories-editor" class="memories-editor"></div>' +
    '<p><button type="button" id="mem-add">+ Add a memory</button></p>' +
    '<p><button type="button" class="primary" id="mem-save">Save memories</button> <span class="saved" id="mem-saved" aria-live="polite"></span></p>' +
    '<template id="mem-photos">' + photoGridHtml(files) + '</template>' +
    '<script type="application/json" id="memories-data">' + JSON.stringify(readMemories()).replace(/</g, "\\u003c") + '</script>' +
    '</main><script src="/memorial.js"></script><script>(' + adminClient + ')();</script></body></html>';
  var headers = { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY" };
  if (cookie) headers["Set-Cookie"] = cookie;
  send(res, 200, html, headers);
}

// A thumbnail button for each photo and GIF, for picking one (memorial text,
// memories); GIFs are badged, since a thumbnail of one looks like a photo.
function photoButtons(files) {
  return files.filter(function (f) { return PHOTO_EXT.test(f.name) || GIF_EXT.test(f.name); }).map(function (f) {
    return '<button type="button" data-file="' + esc(f.name) + '" title="' + esc(f.name) + '"><img src="' + esc("/media/" + encodeURIComponent(f.name)) + '" loading="lazy" alt="">' +
      (GIF_EXT.test(f.name) ? '<span class="gif-badge">GIF</span>' : '') + '<span>' + esc(f.name) + '</span></button>';
  }).join("");
}
// The pictures for a memory: photos, GIFs (badged) and videos (a frame
// half a second in, badged); adminClient numbers the ones it has.
function photoGridHtml(files) {
  var videos = files.filter(function (f) { return VIDEO_EXT.test(f.name); }).map(function (f) {
    return '<button type="button" data-file="' + esc(f.name) + '" title="' + esc(f.name) + '"><video src="' + esc("/media/" + encodeURIComponent(f.name)) + '#t=0.5" preload="metadata" muted playsinline></video>' +
      '<span class="gif-badge">VIDEO</span><span>' + esc(f.name) + '</span></button>';
  }).join("");
  return '<div class="photo-pick mem-pick"><p class="hint">Tap photos, GIFs or videos to add them to this memory, in the order you tap them (tap one again to take it off). ' +
    '<button type="button" class="mem-pick-done">Done</button></p><div class="photo-grid">' + photoButtons(files) + videos + '</div></div>';
}

// The Frame buttons for a memorial photo (adminClient marks the current one).
function frameButtonsHtml(id) {
  return '<div class="frames" role="group" aria-label="Frame" id="' + id + '"><span class="lab">Frame</span>' +
    [["outline", "Outline", "A thin line behind it, like the photo on the first page"], ["print", "Print", "A cream photo print, slightly tilted"], ["mat", "Thin line", "A fine line just around it"], ["none", "None", "Just a soft shadow"]].map(function (f) {
      return '<button type="button" data-frame="' + f[0] + '" title="' + f[2] + '">' + f[1] + '</button>';
    }).join("") + '</div>';
}

// A GIF's "Transition" menu: None, Random, or a transition between sections.
// Ones another GIF has are greyed out (adminClient keeps that up to date);
// Random never is.
function transitionPicker(file, transitions) {
  var mine = transitions.random.indexOf(file) >= 0 ? "random" : "";
  Object.keys(transitions).forEach(function (k) { if (k !== "random" && transitions[k] === file) mine = k; });
  return '<div class="row transition" data-file="' + esc(file) + '"><label>Transition ' +
    '<select class="transition-pick" aria-label="Transition for ' + esc(file) + '"><option value="">None</option>' +
    '<option value="random"' + (mine === "random" ? ' selected' : '') + '>Random (any without its own)</option>' +
    TRANSITIONS.map(function (tr) {
      var taken = transitions[tr[0]] && transitions[tr[0]] !== file;
      return '<option value="' + tr[0] + '"' + (tr[0] === mine ? ' selected' : '') + (taken ? ' disabled' : '') + '>' + esc(tr[1]) + '</option>';
    }).join("") + '</select></label><span class="saved" aria-live="polite"></span></div>';
}

function flagBoxes(file, gallery, moments) {
  return '<div class="flags" data-file="' + esc(file) + '">' +
    '<label><input type="checkbox" class="flag-moments"' + (moments ? ' checked' : '') + '> Moments</label>' +
    '<label><input type="checkbox" class="flag-gallery"' + (gallery ? ' checked' : '') + '> Gallery</label>' +
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
  // Moments and gallery = their ticked files, in display order.
  function renumber() {
    var rows = Array.prototype.slice.call(document.querySelectorAll(".file[data-order]"));
    rows.sort(function (a, b) { return a.getAttribute("data-order") - b.getAttribute("data-order"); });
    var galleryN = 0, momentN = 0;
    rows.forEach(function (r) {
      var where = r.querySelector(".where"), gallery = r.querySelector(".flag-gallery"), moments = r.querySelector(".flag-moments");
      if (!where) return;
      var parts = [];
      if (moments && moments.checked) parts.push("Moment " + (++momentN));
      if (gallery && gallery.checked) parts.push("Gallery " + (++galleryN));
      where.textContent = parts.length ? parts.join(" · ") : "Not on the page";
      where.className = parts.length ? "where" : "where off";
    });
  }
  renumber();
  document.querySelectorAll(".flags").forEach(function (box) {
    var gallery = box.querySelector(".flag-gallery"), moments = box.querySelector(".flag-moments"), note = box.querySelector(".saved");
    function save() {
      renumber();
      report(note, post({ action: "flags", file: box.getAttribute("data-file"), gallery: gallery && gallery.checked ? "1" : "", moments: moments && moments.checked ? "1" : "" }));
    }
    gallery.addEventListener("change", save);
    moments.addEventListener("change", save);
  });
  // Transitions: one GIF each, so a choice greys that transition out in
  // every other GIF's menu (and frees up the one it had).
  var picks = Array.prototype.slice.call(document.querySelectorAll(".transition-pick"));
  function greyOut() {
    var taken = {};
    picks.forEach(function (p) { if (p.value && p.value !== "random") taken[p.value] = p; });
    picks.forEach(function (p) {
      Array.prototype.forEach.call(p.options, function (o) { o.disabled = !!o.value && !!taken[o.value] && taken[o.value] !== p; });
    });
  }
  picks.forEach(function (p) {
    var before = p.value;
    p.addEventListener("change", function () {
      var note = p.closest(".transition").querySelector(".saved");
      greyOut();
      var req = post({ action: "transition", file: p.closest(".transition").getAttribute("data-file"), transition: p.value });
      report(note, req);
      req.then(function () { before = p.value; }, function () { p.value = before; greyOut(); });
    });
  });

  // The title page photo saves as soon as it's picked; the preview follows.
  var introSelect = document.getElementById("intro-select");
  if (introSelect) {
    var introBefore = introSelect.value;
    introSelect.addEventListener("change", function () {
      var preview = document.getElementById("intro-preview");
      var req = post({ action: "intro", file: introSelect.value });
      report(document.getElementById("intro-saved"), req);
      req.then(function () {
        introBefore = introSelect.value;
        preview.src = "/media/" + encodeURIComponent(introSelect.value);
        preview.hidden = false;
      }, function () { introSelect.value = introBefore; });
    });
  }

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

  // Display order view: drag a row by its handle (finger), anywhere on the
  // row but its boxes and buttons (mouse), or focus the handle and use the
  // arrow keys. The new order saves when you let go.
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
      var grip = e.target.closest(".grip"), row = e.target.closest(".file");
      if (!row || e.button > 0) return;
      if (!grip && (e.pointerType !== "mouse" || e.target.closest("input,select,textarea,button,label,form"))) return;
      e.preventDefault();
      sortable.setPointerCapture(e.pointerId);
      drag = { row: row, y: e.clientY, moved: false };
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
      if (moved) { saveOrder(); justDragged = true; setTimeout(function () { justDragged = false; }, 0); }
    };
    // Letting go over a thumbnail shouldn't also open it, and the browser's
    // own image/link dragging would take over from ours.
    var justDragged = false;
    sortable.addEventListener("click", function (e) { if (justDragged) { e.preventDefault(); e.stopPropagation(); } }, true);
    sortable.addEventListener("dragstart", function (e) { e.preventDefault(); });
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

  // The memorial text box: formatting buttons, photo picker, the photo bar
  // (size and frame of the photo whose line the cursor is on), a live
  // preview, and a warning before leaving with unsaved changes. The
  // preview is the real thing: /memorial-preview.html (the page's own
  // styles and /memorial.js) in a frame as wide as a computer's or a
  // phone's window, scaled down to fit.
  var ta = document.getElementById("memorial-text");
  if (ta && typeof renderMemorial === "function") {
    var dirtyNote = document.getElementById("memorial-dirty");
    var frame = document.getElementById("memorial-frame"), pvBox = document.getElementById("pv-box");
    var VIEWS = { computer: [1280, 820], phone: [390, 780] };
    var view = innerWidth < 700 ? "phone" : "computer";
    var saved = ta.value, drawTimer, editN = -1, shownN = -1;
    // Colours a slider's track up to the knob's centre (the knob runs from
    // 9px in to 9px from the end).
    var fillRange = function (r) {
      var f = (r.value - r.min) / (r.max - r.min);
      r.style.setProperty("--fill", "calc(9px + (100% - 18px) * " + f + ")");
    };
    var markDirty = function () { dirtyNote.textContent = ta.value === saved ? "" : "Not saved yet"; };
    var frameButtons = function (box, current) {
      Array.prototype.forEach.call(box.querySelectorAll("button"), function (b) {
        b.setAttribute("aria-pressed", String(b.getAttribute("data-frame") === current));
      });
    };

    // ---- preview ----
    var fdoc = function () { try { return frame.contentWindow.renderMemorial ? frame.contentDocument : null; } catch (e) { return null; } };
    var layout = function () {
      var v = VIEWS[view], s = Math.min(1, pvBox.clientWidth / v[0]);
      frame.style.width = v[0] + "px";
      frame.style.height = v[1] + "px";
      frame.style.transform = "scale(" + s + ")";
      frame.style.left = Math.max(0, (pvBox.clientWidth - v[0] * s) / 2) + "px";
      pvBox.style.height = Math.round(v[1] * s) + "px";
      Array.prototype.forEach.call(document.querySelectorAll("[data-view]"), function (b) {
        b.setAttribute("aria-pressed", String(b.getAttribute("data-view") === view));
      });
    };
    var figAt = function (n) { var d = fdoc(); return d && d.querySelector('.memorial-photo[data-n="' + n + '"]'); };
    // Outlines the picked photo in the preview, and scrolls to it when it's newly picked.
    var pickInPreview = function () {
      var d = fdoc();
      if (!d) return;
      Array.prototype.forEach.call(d.querySelectorAll(".is-picked"), function (f) { f.classList.remove("is-picked"); });
      var fig = figAt(editN);
      if (!fig) return;
      fig.classList.add("is-picked");
      if (shownN !== editN) {
        var scene = d.querySelector(".scene");
        scene.scrollTop += fig.getBoundingClientRect().top - 60;
      }
      shownN = editN;
    };
    var draw = function () {
      markDirty();
      var d = fdoc();
      if (!d) return;
      frame.contentWindow.renderMemorial(ta.value, d.getElementById("dedication"), {
        dir: "media/",
        onPhoto: function (fig, url, caption, block) {
          fig.setAttribute("data-n", block.n);
          fig.querySelector("img").addEventListener("click", function () { selectPhoto(block.n); });
        },
        onMissing: function (fig, file) {
          var s = d.createElement("span");
          s.className = "missing";
          s.textContent = "There’s no photo called " + file;
          fig.insertBefore(s, fig.firstChild);
        }
      });
      pickInPreview();
    };
    frame.addEventListener("load", draw);
    if (fdoc()) draw();
    Array.prototype.forEach.call(document.querySelectorAll("[data-view]"), function (b) {
      b.addEventListener("click", function () { view = b.getAttribute("data-view"); layout(); });
    });
    window.addEventListener("resize", layout);
    layout();

    // ---- the photo bar ----
    var bar = document.getElementById("photo-edit"), peImg = bar.querySelector("img"), peName = document.getElementById("pe-name");
    var peSize = document.getElementById("pe-size"), peOut = document.getElementById("pe-out"), peFrames = document.getElementById("pe-frames");
    // Rewrites photo n's tag with a new size and/or frame, keeping the
    // cursor where it was.
    var setPhoto = function (n, size, frameName) {
      var p = memorialPhotos(ta.value)[n];
      if (!p) return;
      var v = ta.value, r = [p.start, p.end];
      if (size === undefined) size = p.sized ? p.size : 0;
      if (frameName === undefined) frameName = p.frame;
      var tag = memorialTag(p.rawCaption, p.file, size, frameName), d = tag.length - (r[1] - r[0]);
      var a = ta.selectionStart, z = ta.selectionEnd;
      var fix = function (p) { return p <= r[0] ? p : p >= r[1] ? p + d : Math.min(p, r[0] + tag.length - 1); };
      ta.value = v.slice(0, r[0]) + tag + v.slice(r[1]);
      ta.setSelectionRange(fix(a), fix(z));
      markDirty();
    };
    // The bar shows the photo whose tag the cursor is in (or just after).
    var showBar = function () {
      var at = ta.selectionStart, p = null;
      memorialPhotos(ta.value).forEach(function (q) { if (at > q.start && at <= q.end) p = q; });
      editN = p ? p.n : -1;
      bar.hidden = !p;
      pickInPreview();
      if (!p) return;
      var url = "/media/" + encodeURIComponent(p.file);
      if (peImg.getAttribute("src") !== url) peImg.src = url;
      peName.textContent = (p.caption || "No caption") + " · " + p.file;
      peSize.value = p.size; fillRange(peSize); peOut.textContent = p.size + "%";
      frameButtons(peFrames, p.frame);
    };
    // Tapping a photo in the preview: put the cursor at the end of its tag.
    var selectPhoto = function (n) {
      var p = memorialPhotos(ta.value)[n];
      if (!p) return;
      ta.setSelectionRange(p.end, p.end);
      showBar();
    };
    ["click", "keyup", "input", "select", "focus"].forEach(function (t) { ta.addEventListener(t, showBar); });
    document.addEventListener("selectionchange", function () { if (document.activeElement === ta) showBar(); });
    peSize.addEventListener("input", function () {
      if (editN < 0) return;
      var size = memorialSize(peSize.value), fig = figAt(editN);
      fillRange(peSize); peOut.textContent = size + "%";
      setPhoto(editN, size);
      if (fig) frame.contentWindow.sizeMemorialPhoto(fig, size);
    });
    peSize.addEventListener("change", draw); // on letting go: re-lay the sides (centred ones don't take a turn)
    peFrames.addEventListener("click", function (e) {
      var b = e.target.closest("button[data-frame]");
      if (!b || editN < 0) return;
      setPhoto(editN, undefined, b.getAttribute("data-frame"));
      frameButtons(peFrames, b.getAttribute("data-frame"));
      draw();
    });
    document.getElementById("pe-done").addEventListener("click", function () { bar.hidden = true; editN = -1; pickInPreview(); });

    var changed = function () { clearTimeout(drawTimer); drawTimer = setTimeout(draw, 200); };
    ta.addEventListener("input", changed);
    document.getElementById("memorial-form").addEventListener("submit", function () { saved = ta.value; });
    window.addEventListener("beforeunload", function (e) { if (ta.value !== saved) { e.preventDefault(); e.returnValue = ""; } });
    // The tabs: the Memorial text or Scout's Life's, in the same box, the
    // preview and the photo tools; switching drops unsaved changes (asked first).
    var texts = JSON.parse(document.getElementById("memorial-texts").textContent);
    var which = document.getElementById("memorial-which");
    Array.prototype.forEach.call(document.querySelectorAll("[data-text]"), function (b) {
      b.addEventListener("click", function () {
        var k = b.getAttribute("data-text");
        if (k === which.value) return;
        if (ta.value !== saved && !confirm("Switch without saving your changes to this text?")) return;
        texts[which.value] = saved;
        which.value = k;
        ta.value = saved = texts[k] || "";
        var label = b.textContent;
        ta.setAttribute("aria-label", label + " text");
        document.getElementById("memorial-save").textContent = "Save " + label + " text";
        Array.prototype.forEach.call(document.querySelectorAll("[data-text]"), function (o) { o.setAttribute("aria-pressed", String(o === b)); });
        bar.hidden = true;
        editN = -1;
        draw();
      });
    });
    var edit = function (value, from, to) {
      ta.value = value;
      ta.focus();
      ta.setSelectionRange(from, to);
      draw();
      showBar();
    };
    // The paragraph the cursor is in: [start, end) of ta.value.
    var paraAt = function (at) {
      var v = ta.value, start = v.lastIndexOf("\n\n", at - 1), end = v.indexOf("\n\n", at);
      return [start < 0 ? 0 : start + 2, end < 0 ? v.length : end];
    };
    var tools = document.querySelector(".tools");
    tools.addEventListener("mousedown", function (e) { if (e.target.closest("button")) e.preventDefault(); }); // keep the selection
    tools.addEventListener("click", function (e) {
      var b = e.target.closest("button");
      if (!b) return;
      var v = ta.value, a = ta.selectionStart, z = ta.selectionEnd;
      if (b.hasAttribute("data-wrap")) {
        var w = b.getAttribute("data-wrap");
        while (a < z && /\s/.test(v[a])) a++;     // "**word **" wouldn't count as bold
        while (z > a && /\s/.test(v[z - 1])) z--;
        var sel = v.slice(a, z) || (w === "**" ? "bold words" : "italic words");
        edit(v.slice(0, a) + w + sel + w + v.slice(z), a + w.length, a + w.length + sel.length);
      } else if (b.hasAttribute("data-heading")) {
        var p = paraAt(a);
        if (v.slice(p[0], p[0] + 2) === "# ") edit(v.slice(0, p[0]) + v.slice(p[0] + 2), a - 2, z - 2);
        else edit(v.slice(0, p[0]) + "# " + v.slice(p[0]), a + 2, z + 2);
      } else if (b.id === "photo-toggle") {
        var pickBox = document.getElementById("photo-pick");
        pickBox.hidden = !pickBox.hidden;
        b.setAttribute("aria-expanded", String(!pickBox.hidden));
      }
    });

    // ---- the photo picker ----
    var pickSize = document.getElementById("photo-size"), pickFrames = document.getElementById("photo-frames"), pickFrame = MEMORIAL_FRAME;
    fillRange(pickSize);
    frameButtons(pickFrames, pickFrame);
    pickSize.addEventListener("input", function () { fillRange(pickSize); document.getElementById("photo-size-out").textContent = pickSize.value + "%"; });
    pickFrames.addEventListener("click", function (e) {
      var b = e.target.closest("button[data-frame]");
      if (!b) return;
      pickFrame = b.getAttribute("data-frame");
      frameButtons(pickFrames, pickFrame);
    });
    document.querySelector(".photo-grid").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-file]");
      if (!b) return;
      var cap = document.getElementById("photo-cap");
      var tag = memorialTag(cap.value.replace(/[\[\]\s]+/g, " ").trim(), b.getAttribute("data-file"), memorialSize(pickSize.value), pickFrame);
      // Right where the cursor is: in the middle of a word, after it; on a
      // blank line between paragraphs, as a paragraph of its own.
      var v = ta.value, at = ta.selectionStart;
      while (at > 0 && at < v.length && /\S/.test(v[at - 1]) && /\S/.test(v[at])) at++;
      var before = v.slice(0, at), after = v.slice(at), nv;
      if (!before.trim() && !after.trim()) nv = tag, at = tag.length;
      else if (/\n\s*$/.test(before) && /^\s*\n/.test(after) || !before.trim() || !after.trim()) {
        before = before.replace(/\s+$/, ""); after = after.replace(/^\s+/, "");
        nv = (before ? before + "\n\n" : "") + tag + (after ? "\n\n" + after : "");
        at = (before ? before.length + 2 : 0) + tag.length;
      } else {
        var l = /\s$/.test(before) ? "" : " ", r = /^\s/.test(after) ? "" : " ";
        nv = before + l + tag + r + after;
        at = before.length + l.length + tag.length;
      }
      edit(nv, at, at);
      cap.value = "";
      document.getElementById("photo-pick").hidden = true;
      document.getElementById("photo-toggle").setAttribute("aria-expanded", "false");
    });
  }

  // The memories editor: one box per memory (title, pictures, story), built
  // from #memories-data; Save sends them all as JSON.
  var memBox = document.getElementById("memories-editor");
  if (memBox) {
    var memories = JSON.parse(document.getElementById("memories-data").textContent || "[]");
    var memSaved = JSON.stringify(memories), memNote = document.getElementById("mem-saved");
    var memPickTpl = document.getElementById("mem-photos");
    var memOpen = null; // the memory whose picture grid is open
    memories.forEach(function (m) { m.photos = Array.isArray(m.photos) ? m.photos : m.photo ? [m.photo] : []; delete m.photo; });
    memSaved = JSON.stringify(memories);
    // A small picture of a file: a video's frame half a second in.
    var memThumb = function (f) {
      var el = document.createElement(/\.(mp4|webm|mov|m4v)$/i.test(f) ? "video" : "img");
      el.src = "/media/" + encodeURIComponent(f) + (el.tagName === "VIDEO" ? "#t=0.5" : "");
      if (el.tagName === "VIDEO") { el.muted = true; el.preload = "metadata"; el.setAttribute("playsinline", ""); }
      else el.alt = f;
      el.title = f;
      return el;
    };
    var memDirty = function () {
      memNote.className = "saved";
      memNote.textContent = JSON.stringify(memories) === memSaved ? "" : "Not saved yet";
    };
    var drawMemories = function () {
      memBox.textContent = "";
      if (!memories.length) {
        var none = document.createElement("p");
        none.className = "hint";
        none.textContent = "No memories yet.";
        memBox.appendChild(none);
      }
      memories.forEach(function (m, i) {
        var box = document.createElement("div");
        box.className = "mem";
        var tools = document.createElement("div");
        tools.className = "mem-tools";
        var num = document.createElement("span");
        num.className = "mem-num";
        num.textContent = "Memory " + (i + 1);
        tools.appendChild(num);
        [["↑", "Move up", i > 0, function () { memories.splice(i - 1, 0, memories.splice(i, 1)[0]); }],
         ["↓", "Move down", i < memories.length - 1, function () { memories.splice(i + 1, 0, memories.splice(i, 1)[0]); }],
         ["Delete", "Delete this memory", true, function () { if (confirm("Delete memory " + (i + 1) + (m.title ? ", “" + m.title + "”" : "") + "?")) memories.splice(i, 1); }]
        ].forEach(function (t) {
          var b = document.createElement("button");
          b.type = "button";
          b.textContent = t[0];
          b.title = t[1];
          b.setAttribute("aria-label", t[1]);
          b.disabled = !t[2];
          if (t[0] === "Delete") b.className = "delete";
          b.addEventListener("click", function () { t[3](); drawMemories(); memDirty(); });
          tools.appendChild(b);
        });
        box.appendChild(tools);

        var title = document.createElement("input");
        title.className = "mem-title";
        title.maxLength = 120;
        title.placeholder = "Title, e.g. The bucket";
        title.value = m.title || "";
        title.setAttribute("aria-label", "Title of memory " + (i + 1));
        title.addEventListener("input", function () { m.title = title.value; memDirty(); });
        box.appendChild(title);

        // Its pictures, in order, the first the main one (on the card);
        // each can be made the main one, moved or taken off.
        var pics = document.createElement("div");
        pics.className = "mem-pics";
        var redraw = function () { drawMemories(); memDirty(); };
        m.photos.forEach(function (f, j) {
          var pic = document.createElement("div");
          pic.className = "mem-pic" + (j === 0 ? " is-main" : "");
          pic.appendChild(memThumb(f));
          if (j === 0) {
            var main = document.createElement("span");
            main.className = "mem-main";
            main.textContent = "Main";
            pic.appendChild(main);
          }
          var row = document.createElement("div");
          row.className = "mem-pic-tools";
          [["★", "Make this the main picture", j > 0, function () { m.photos.unshift(m.photos.splice(j, 1)[0]); }],
           ["←", "Move left", j > 0, function () { m.photos.splice(j - 1, 0, m.photos.splice(j, 1)[0]); }],
           ["→", "Move right", j < m.photos.length - 1, function () { m.photos.splice(j + 1, 0, m.photos.splice(j, 1)[0]); }],
           ["✕", "Take this picture off", true, function () { m.photos.splice(j, 1); }]
          ].forEach(function (t) {
            if (!t[2] && t[0] === "★") return;
            var b = document.createElement("button");
            b.type = "button";
            b.textContent = t[0];
            b.title = t[1];
            b.setAttribute("aria-label", t[1] + " (" + f + ")");
            b.disabled = !t[2];
            b.addEventListener("click", function () { t[3](); redraw(); });
            row.appendChild(b);
          });
          pic.appendChild(row);
          pics.appendChild(pic);
        });
        var add = document.createElement("button");
        add.type = "button";
        add.className = "mem-add-pic";
        add.textContent = m.photos.length ? "+ Add more" : "+ Add pictures";
        pics.appendChild(add);
        box.appendChild(pics);

        var text = document.createElement("textarea");
        text.maxLength = 6000;
        text.placeholder = "The memory…";
        text.value = m.text || "";
        text.setAttribute("aria-label", "Memory " + (i + 1));
        text.addEventListener("input", function () { m.text = text.value; memDirty(); });
        box.appendChild(text);

        // "Add" opens a grid of photos, GIFs and videos under the pictures:
        // tapping one adds it (at the end) or, if it's already in, takes it off.
        var openPick = function () {
          var pick = memPickTpl.content.firstElementChild.cloneNode(true);
          var mark = function () {
            pick.querySelectorAll("button[data-file]").forEach(function (b) {
              var n = m.photos.indexOf(b.getAttribute("data-file"));
              b.classList.toggle("is-picked", n >= 0);
              b.setAttribute("data-n", n >= 0 ? n + 1 : "");
            });
          };
          pick.addEventListener("click", function (e) {
            if (e.target.closest(".mem-pick-done")) { memOpen = null; return drawMemories(); }
            var b = e.target.closest("button[data-file]");
            if (!b) return;
            var f = b.getAttribute("data-file"), n = m.photos.indexOf(f);
            if (n >= 0) m.photos.splice(n, 1);
            else if (m.photos.length >= 30) return alert("That’s 30 pictures, the most one memory can have.");
            else m.photos.push(f);
            memOpen = m;
            var y = pick.querySelector(".photo-grid").scrollTop;
            drawMemories();
            memDirty();
            var again = memBox.querySelector(".mem-pick .photo-grid");
            if (again) again.scrollTop = y;
          });
          mark();
          pics.insertAdjacentElement("afterend", pick);
        };
        add.addEventListener("click", function () {
          if (memOpen === m) { memOpen = null; return drawMemories(); }
          memOpen = m;
          drawMemories();
        });
        if (memOpen === m) openPick();
        memBox.appendChild(box);
      });
    };
    drawMemories();
    document.getElementById("mem-add").addEventListener("click", function () {
      memories.push({ title: "", text: "", photos: [] });
      drawMemories();
      memDirty();
      var boxes = memBox.querySelectorAll(".mem");
      var last = boxes[boxes.length - 1];
      last.scrollIntoView({ block: "center", behavior: "smooth" });
      last.querySelector(".mem-title").focus({ preventScroll: true });
    });
    document.getElementById("mem-save").addEventListener("click", function () {
      var sent = JSON.stringify(memories);
      memNote.className = "saved"; memNote.textContent = "Saving…";
      fetch("/media-admin", { method: "POST", body: new URLSearchParams({ action: "memories", data: sent }) })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error); return j; }); })
        .then(function (j) {
          memSaved = sent;
          memNote.textContent = "Saved (" + j.count + " memor" + (j.count === 1 ? "y" : "ies") + ")";
        }, function (e) { memNote.className = "saved err"; memNote.textContent = (e && e.message) || "Couldn’t save"; });
    });
    window.addEventListener("beforeunload", function (e) { if (JSON.stringify(memories) !== memSaved) { e.preventDefault(); e.returnValue = ""; } });
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
  if (u.pathname === "/internal/import" && req.method === "POST") return importFromMessages(req, res, u.searchParams);
  if (["/admin", "/admin/login", "/admin/logout", "/admin/password", "/media-admin", "/media-admin/upload"].indexOf(u.pathname) < 0) return send(res, 404, "Not found");
  if (u.pathname === "/admin/login") {
    if (req.method === "POST") return sameOrigin(req) ? login(req, res) : send(res, 403, "Forbidden");
    return isAdmin(req) ? send(res, 303, "", { Location: nextPage(u.searchParams.get("next")) }) : loginPage(res, "", u.searchParams.get("next"));
  }
  if (u.pathname === "/admin/logout" && req.method === "POST") {
    return send(res, 303, "", { Location: "/admin/login", "Set-Cookie": "scout_admin=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict" });
  }
  if (!isAdmin(req)) {
    if (req.method === "GET") return send(res, 303, "", { Location: "/admin/login?next=" + encodeURIComponent(u.pathname) });
    return json(res, 401, { error: "You've been signed out. Reload the page and sign in again." });
  }
  if (req.method === "GET" && u.pathname === "/admin") return hubPage(res, u.searchParams.get("msg"));
  if (req.method === "GET" && u.pathname === "/admin/password") return passwordPage(res, "");
  if (req.method === "GET" && u.pathname === "/media-admin") return adminPage(req, res, u.searchParams);
  if (req.method !== "POST") return send(res, 405, "Method not allowed", { Allow: "GET, POST" });
  if (!sameOrigin(req)) return send(res, 403, "Forbidden");
  if (u.pathname === "/admin/password") return changePassword(req, res);
  if (u.pathname === "/media-admin/upload") return upload(req, res, u.searchParams);
  action(req, res);
}).listen(PORT, HOST, function () {
  migrate();
  console.log("scout-media listening on " + HOST + ":" + PORT + ", managing " + MEDIA_ROOT);
});
