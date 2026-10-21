# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A static, single-page memorial site for Scout (a dog), served live at inlovingmemoryofscout.com. There is no build step, package manager, linter, or test suite: plain HTML/CSS/vanilla JS (ES5 style, IIFEs, `var`). This directory **is** the nginx document root, so edits on disk are live immediately.

- Server config: `/etc/nginx/sites-available/inlovingmemoryofscout.com` (outside the repo). After changing it: `sudo nginx -t && sudo systemctl reload nginx`. It sends `Cache-Control: no-cache` for HTML/CSS/JS/TXT (a `map` at the top of the file), so browsers revalidate those on every visit instead of using a stale copy.
- Local preview: `python3 -m http.server` works for the page itself, but the slideshow will show its error state because it depends on nginx's autoindex HTML (see below).

## Live site vs. leftover files

Only these files make up the live page:
- `index.html` — all markup (hero `#top`, `#dedication`, `#slideshow`, `#catch` video, `#gallery` grid, `#messages`, lightbox).
- `style.css` — all styling (light-only; Newsreader + Karla from Google Fonts).
- `script.js` — all behaviour, as IIFEs: scenes + nav, slideshow + gallery grid + lightbox, frisbee video fallback, messages form.
- `server/` — the messages backend (Node, no dependencies; runs as systemd unit `scout-messages`). nginx denies `/server/`, dotfiles (incl. `.git`) and the notes files; see `server/README.md`. Restart the unit after editing `server/messages.js`.
- `media/` — one flat folder for every photo and video (no subfolders). `index.html` points at two directly, the hero photo and the `#catch` video. Their current names are in `media/page_files.txt` (`intro=<file>`, `catch=<file>`); the media manager updates it when either is renamed, and `script.js` swaps the new name in. If you change those `src`s in `index.html`, update `page_files.txt` too.
- `server/media.js` — the media manager at `/media-admin` (systemd unit `scout-media`, password in `/etc/scout-media.env`). The owner uploads, renames and deletes files in `media/` from there, so `media/` changes on disk outside git; `media/` is owned by the `scout-media` user.

Not used by `index.html` (artifacts of earlier tooling/iterations — don't edit them expecting site changes):
- `slideshow.html`, `slideshow.js` — older standalone slideshow reading `media/pictures/slideshow/`, which no longer exists.
- `Scout.dc.html`, `support.js`, `image-slot.js`, `.image-slots.state.json`, `.thumbnail` — an exported design-tool ("dc-runtime"/omelette) mockup; `support.js` is generated code.
- `github.md` — sync notes from that design tool; its paths are partly out of date.

## Scenes (fade between sections)

The page doesn't scroll as one document. Each of the six parts (intro, dedication, slideshow, the catch, gallery, messages) is wrapped in a `.scene` div in `index.html`. `script.js` adds `.scenes` to `<html>`, which turns every scene into a fixed full-screen layer, with only `.is-active` visible. Wheel, touch swipe, keyboard and nav links fade to the next or previous scene. A scene taller than the screen scrolls inside itself and only fades once it reaches its top or bottom. All scene CSS is scoped under `.scenes`, so without JS the page falls back to normal scrolling. When adding a section, wrap it in `<div class="scene" data-anchor="<id>">`. The `#catch` video has no `autoplay`; the scene code plays it on entering that scene and pauses it on leaving. A scene can carry `data-clip="<gif or video path>"` and `data-clip-ms` to use that clip as a transition (`.scene-clip`: the old scene fades out, the clip fades in centred in a soft circle at 75% opacity, fades out, then the new scene fades in via an inline transition-delay; input locked until it ends) whenever you arrive at it; it's skipped on the first load and with reduced motion. No scene uses it right now; to try it, e.g. `data-clip="media/04_BARKY_SCOUT.gif" data-clip-ms="2640"` on the slideshow scene.

## Slideshow mechanism

`script.js` fetches `media/` and parses the **nginx autoindex** HTML listing (`autoindex on` for `location /media/` in the nginx config) to discover files. Consequences:
- Two plain-text lists in `media/` (one filename per line, edited via the Gallery / Slideshow checkboxes at `/media-admin`) decide what's used, independently: `not_in_gallery.txt` = files left out of the gallery (default: in it), `slideshow.txt` = files in the slideshow (default: not). A new upload appears in the gallery but not the slideshow until it's ticked.
- Order is a natural-sort by filename, so files use numeric prefixes (`01_…`, `02_…`, `50_…`).
- Images (jpg/png/gif/webp/avif) autoplay on a 6s timer; videos (mp4/webm/mov/m4v) play muted and advance on `ended` instead of the timer.
- The `#gallery` grid (4 columns) is built from the same listing, photos and videos (minus `not_in_gallery.txt`); video tiles show their first frame with a play badge.
- Clicking an image (in the slideshow or grid) opens the lightbox (wheel zoom toward cursor, drag-to-pan, Esc/click-out to close). A gallery video opens in the same lightbox and plays with sound and controls (no zoom).
- If the folder is moved or autoindex is disabled, the slideshow breaks — update both `DIR` in `script.js` and the nginx `location`.

The `#catch` section plays `media/scout_good_catch.mp4`; if it fails to load, `script.js` adds `.is-empty` to `#video-shell` to show a placeholder.

## Memorial text

The `#dedication` paragraphs come from `media/memorial.txt` (paragraphs separated by blank lines), which the owner edits in the "Memorial text" box at `/media-admin`. `index.html` keeps a copy as the no-JS fallback; `script.js` replaces it with the file's text (always via `textContent`) when they differ. To change the text, edit `memorial.txt`; if you also edit the fallback in `index.html`, keep the two in sync.

## Messages

Visitors post to `/api/messages` and posts are held as pending. The owner approves them at `/messages-admin` (basic auth, password in `/etc/scout-messages.env`), and only approved messages are returned to the page. Message text is always rendered with `textContent`, never as HTML.

## Conventions

- Commented-out blocks in `index.html` (headings, caption, footer) were left intentionally by the owner — leave them unless asked.
- The page forces light mode (`color-scheme: only light`, `darkreader-lock`); keep it that way.
