# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A static, single-page memorial site for Scout (a dog), served live at inlovingmemoryofscout.com. There is no build step, package manager, linter, or test suite: plain HTML/CSS/vanilla JS (ES5 style, IIFEs, `var`). This directory **is** the nginx document root, so edits on disk are live immediately.

- Server config: the site's nginx rules (root, media autoindex, backend proxies, deny rules, cache header) live in `server/nginx-site.conf`, which every domain's `listen 443` block in `/etc/nginx/sites-available/` includes (currently `inlovingmemoryofscout.com` and `scout.weisslab.dev`). To serve the site on another domain, give it a server block with its `server_name`, certificate and `include /var/www/inlovingmemoryofscout.com/html/server/nginx-site.conf;` — nothing in the page or backends is tied to a domain. After changing any of it: `sudo nginx -t && sudo systemctl reload nginx`. It sends `Cache-Control: no-cache` for HTML/CSS/JS/TXT (the `map` is in `/etc/nginx/conf.d/scout-cache.conf`), so browsers revalidate those on every visit instead of using a stale copy.
- Local preview: `python3 -m http.server` works for the page itself, but the slideshow will show its error state because it depends on nginx's autoindex HTML (see below).

## Live site vs. leftover files

Only these files make up the live page:
- `index.html` — all markup (hero `#top`, `#dedication`, `#slideshow`, `#moments` videos/GIFs, `#gallery` grid, `#messages`, lightbox).
- `style.css` — all styling (light-only; Newsreader + Karla from Google Fonts).
- `script.js` — all behaviour, as IIFEs: scenes + nav, slideshow + gallery grid + lightbox, frisbee video fallback, messages form.
- `server/` — the messages backend (Node, no dependencies; runs as systemd unit `scout-messages`). nginx denies `/server/`, dotfiles (incl. `.git`) and the notes files; see `server/README.md`. Restart the unit after editing `server/messages.js`.
- `media/` — one flat folder for every photo and video (no subfolders). `index.html` points at two directly, the hero photo and the `#moments` fallback video (`#frisbee`). Their current names are in `media/page_files.txt` (`intro=<file>`, `catch=<file>`); the media manager updates it when either is renamed, and when the owner picks another photo in its "Title page photo" dropdown; `script.js` swaps the new name in. The hero photo stays at opacity 0 (`.is-ready` in `style.css`) until `script.js` has checked `page_files.txt`, so the old photo never flashes up first. If you change those `src`s in `index.html`, update `page_files.txt` too.
- `server/media.js` — the media manager at `/media-admin` (systemd unit `scout-media`), and the site's one admin sign-in: `/admin/login` (password `ADMIN_PASSWORD` in `/etc/scout-media.env`) sets a site-wide `scout_admin` cookie signed with `SESSION_SECRET`, which `server/messages.js` also holds and checks; `/admin` links to every admin page. The owner uploads, renames and deletes files in `media/` from there, so `media/` changes on disk outside git; `media/` is owned by the `scout-media` user.

Not used by `index.html` (artifacts of earlier tooling/iterations — don't edit them expecting site changes):
- `slideshow.html`, `slideshow.js` — older standalone slideshow reading `media/pictures/slideshow/`, which no longer exists.
- `Scout.dc.html`, `support.js`, `image-slot.js`, `.image-slots.state.json`, `.thumbnail` — an exported design-tool ("dc-runtime"/omelette) mockup; `support.js` is generated code.
- `github.md` — sync notes from that design tool; its paths are partly out of date.

## Scenes (fade between sections)

The page doesn't scroll as one document. Each of the six parts (intro, dedication, slideshow, moments, gallery, messages) is wrapped in a `.scene` div in `index.html`. `script.js` adds `.scenes` to `<html>`, which turns every scene into a fixed full-screen layer, with only `.is-active` visible. Wheel, touch swipe, keyboard and nav links fade to the next or previous scene. A scene taller than the screen scrolls inside itself and only fades once it reaches its top or bottom. All scene CSS is scoped under `.scenes`, so without JS the page falls back to normal scrolling. When adding a section, wrap it in `<div class="scene" data-anchor="<id>">`; `script.js` also adds a `.scene-dots` dot for it on the right edge, named after its `.sidenav` link. Videos in `#moments` have no `autoplay`; the scene code fires a `scenechange` event and the Moments code plays each one only while its scene is up and it is on screen. A scene can carry `data-clip="<gif or video path>"` and `data-clip-ms` to use that clip as a transition (`.scene-clip`: the old scene fades out, the clip fades in centred in a soft circle at 75% opacity, fades out, then the new scene fades in via an inline transition-delay; input locked until it ends) whenever you arrive at it; it's skipped on the first load and with reduced motion. `data-clip-from="<id or data-anchor>"` limits it to when that's the scene before. A clip belongs to the boundary between a scene and the one before it: it plays crossing that boundary either way, and a jump (nav link, dot) plays the one it would have crossed last (`clipAt()` / `playClip()`). Normally these come from `media/transitions.txt` (`<from>><to>=<gif>` lines, e.g. `top>dedication=x.gif`), set by the "Transition" menu on each GIF at `/media-admin` (one GIF per transition; taken ones greyed out; the list of transitions is `TRANSITIONS` in `server/media.js`, so add one there when adding a section). `script.js` reads it into those attributes and times each GIF to one run from its frame delays (`gifRunMs()`); it preloads only the clips on either side of the current scene. A GIF clip is preloaded as a Blob a second after the page starts and each showing gets a fresh `blob:` URL, because every `<img>` of one GIF URL shares one animation clock (the same GIF may be animating in Moments), which would start the transition mid-loop; until the blob is in, it uses a cache-busting `?t=`. Renaming or deleting a GIF at `/media-admin` carries its transition over (or drops it).

## Slideshow mechanism

`script.js` fetches `media/` and parses the **nginx autoindex** HTML listing (`autoindex on` for `location /media/` in `server/nginx-site.conf`) to discover files. Consequences:
- Two plain-text lists in `media/` (one filename per line, edited via the Gallery / Slideshow checkboxes at `/media-admin`) decide what's used, independently: `not_in_gallery.txt` = files left out of the gallery (default: in it), `slideshow.txt` = files in the slideshow (default: not). A new upload appears in the gallery but not the slideshow until it's ticked. The slideshow takes still photos only: GIFs and videos get a "Moments" checkbox instead (see below), and `script.js` ignores them in `slideshow.txt`.
- Order: `media/order.txt` (one filename per line, set by dragging rows in the "Display order" view at `/media-admin`) comes first; files it doesn't name follow in natural filename order. With no `order.txt`, it's purely by filename.
- Captions: `media/captions.txt`, `<file>=<caption>` lines, edited per file at `/media-admin`. Shown (as text) under the slideshow (`#slideshow-caption`) and at the bottom of the lightbox.
- The photos are a stack of cards (`cardStack()` in `script.js`, shared with Moments; `.card-stack` / `.stack-card` / `.ss-card` in `style.css`): the top photo shows with the next two peeking out below; moving on slides the top card out left and tucks it under the bottom while the rest move up. Each photo stays on top for `slide_seconds` from `media/settings.txt` (default 5; set in the "Slideshow" box at `/media-admin`). The timer is the `.ss-progress` bar's CSS animation (`animationend` advances), so hovering the photo or opening the lightbox pauses it.
- Dots: with more than 7 (`DOT_WINDOW`), `windowDots()` shows a sliding window of 7 around the current one, the end ones shrunk; same for Moments.
- The `#gallery` grid (4 columns, 2 on phones) is built from the same listing, photos and videos (minus `not_in_gallery.txt`), as a masonry layout: 1px grid rows, and `script.js` sets each tile's row span from its picture's shape once it loads. Video tiles show their first frame with a play badge.
- Clicking an image (in the slideshow or grid) opens the lightbox (wheel zoom toward cursor, drag-to-pan, Esc/click-out to close). A gallery video opens in the same lightbox and plays with sound and controls (no zoom).
- If the folder is moved or autoindex is disabled, the slideshow breaks — update both `DIR` in `script.js` and the nginx `location`.

The `#moments` section ("Moments", formerly "The Catch") shows every GIF and video ticked "Moments" at `/media-admin` (`media/moments.txt`), in display order (`order.txt`), as a stack of cards (`.moments-stack`, the same `cardStack()` as the slideshow): the top one showing, the next two peeking out below. A video plays through once, a GIF plays `GIF_PLAYS` (4) times (its length is summed from the file's frame delays in `gifLength()`); then the top card slides out left (`.is-out`) and tucks under the bottom while the rest move up. Arrows and dots (`#moments-controls`) move by hand. `#moments-caption` shows the top card's caption from `captions.txt`, or nothing if it has none (its text in `index.html` only shows with nothing ticked). `script.js` builds each card from a copy of the `#video-shell` in `index.html` (an `<img>` replaces the `<video>` for a GIF); videos are muted with a `.sound` button, and only the top one plays, only while its scene is up and it's on screen. With nothing ticked (or no JS), the `#frisbee` video in `index.html` (`media/scout_good_catch.mp4`) shows instead. A card that fails to load gets `.is-empty` (an "Oops" placeholder) and the stack moves on after 5s. Card transforms always use the same function list (`transform()` in `cardStack()`) so they interpolate. Headless Chrome barely draws frames, so check the animation there by pausing `getAnimations()`, not by screenshots.

## Link previews

`index.html` has Open Graph / Twitter tags pointing at `/share.jpg` (1200×630, a fixed image in the repo root, not in `media/`, so renames can't break it). To change the preview image, replace that file.

## Memorial text

The `#dedication` paragraphs come from `media/memorial.txt` (paragraphs separated by blank lines), which the owner edits in the "Memorial text" box at `/media-admin`. `index.html` keeps a copy as the no-JS fallback; `script.js` replaces it with the file's text (always via `textContent`) when they differ. To change the text, edit `memorial.txt`; if you also edit the fallback in `index.html`, keep the two in sync.

## Messages

The `#messages` scene (below the gallery) has a form for a message, a photo, or both. Visitors post to `/api/messages` and posts are held as pending. The owner approves them at `/messages-admin` (behind the shared `/admin` sign-in), and only approved messages (and their photos, at `/api/messages/photo/<id>`) are returned to the page. `script.js` shrinks a photo to 2400 px and re-saves it as a JPEG before sending (dropping EXIF/location); GIFs go as they are. Photos live in the service's state dir, not the web root. From `/messages-admin` the owner can delete a post, remove just its photo, or "Copy to my media", which hands the file to `server/media.js`'s `/internal/import` (localhost only, shared `IMPORT_TOKEN` in both env files) with the Gallery / Slideshow / Moments ticks and an optional caption. Message text is always rendered with `textContent`, never as HTML. See `server/README.md`.

## Conventions

- Commented-out blocks in `index.html` (headings, caption, footer) were left intentionally by the owner — leave them unless asked.
- The page forces light mode (`color-scheme: only light`, `darkreader-lock`); keep it that way.
