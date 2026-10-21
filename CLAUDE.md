# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A static, single-page memorial site for Scout (a dog), served live at inlovingmemoryofscout.com. There is no build step, package manager, linter, or test suite: plain HTML/CSS/vanilla JS (ES5 style, IIFEs, `var`). This directory **is** the nginx document root, so edits on disk are live immediately.

- Server config: `/etc/nginx/sites-available/inlovingmemoryofscout.com` (outside the repo). After changing it: `sudo nginx -t && sudo systemctl reload nginx`.
- Local preview: `python3 -m http.server` works for the page itself, but the slideshow will show its error state because it depends on nginx's autoindex HTML (see below).

## Live site vs. leftover files

Only these files make up the live page:
- `index.html` — all markup (hero `#top`, `#dedication`, `#slideshow`, `#catch` video, `#gallery` grid, `#messages`, lightbox).
- `style.css` — all styling (light-only; Newsreader + Karla from Google Fonts).
- `script.js` — all behaviour, as IIFEs: scenes + nav, slideshow + gallery grid + lightbox, frisbee video fallback, messages form.
- `server/` — the messages backend (Node, no dependencies; runs as systemd unit `scout-messages`). nginx denies `/server/`, dotfiles (incl. `.git`) and the notes files; see `server/README.md`. Restart the unit after editing `server/messages.js`.
- `media/` — `media/pictures/my_scouty_boy.jpg` (hero), `media/slideshow/*` (slides), `media/videos/*`.

Not used by `index.html` (artifacts of earlier tooling/iterations — don't edit them expecting site changes):
- `slideshow.html`, `slideshow.js` — older standalone slideshow reading `media/pictures/slideshow/`, which no longer exists.
- `Scout.dc.html`, `support.js`, `image-slot.js`, `.image-slots.state.json`, `.thumbnail` — an exported design-tool ("dc-runtime"/omelette) mockup; `support.js` is generated code.
- `github.md` — sync notes from that design tool; its paths are partly out of date.

## Scenes (fade between sections)

The page doesn't scroll as one document. Each of the six parts (intro, dedication, slideshow, the catch, gallery, messages) is wrapped in a `.scene` div in `index.html`. `script.js` adds `.scenes` to `<html>`, which turns every scene into a fixed full-screen layer, with only `.is-active` visible. Wheel, touch swipe, keyboard and nav links fade to the next or previous scene. A scene taller than the screen scrolls inside itself and only fades once it reaches its top or bottom. All scene CSS is scoped under `.scenes`, so without JS the page falls back to normal scrolling. When adding a section, wrap it in `<div class="scene" data-anchor="<id>">`. The `#catch` video has no `autoplay`; the scene code plays it on entering that scene and pauses it on leaving.

## Slideshow mechanism

`script.js` fetches `media/slideshow/` and parses the **nginx autoindex** HTML listing (`autoindex on` for `location /media/slideshow/` in the nginx config) to discover files. Consequences:
- Adding/removing a slide = adding/removing a file in `media/slideshow/`; no code change.
- Order is a natural-sort by filename, so files use numeric prefixes (`01_…`, `02_…`, `50_…`).
- Images (jpg/png/gif/webp/avif) autoplay on a 6s timer; videos (mp4/webm/mov/m4v) play muted and advance on `ended` instead of the timer.
- The `#gallery` grid (4 columns) is built from the same listing, images only, so it needs no separate upkeep.
- Clicking an image (in the slideshow or grid) opens the lightbox (wheel zoom toward cursor, drag-to-pan, Esc/click-out to close).
- If the folder is moved or autoindex is disabled, the slideshow breaks — update both `DIR` in `script.js` and the nginx `location`.

The `#catch` section plays `media/videos/scout_good_catch.mp4`; if it fails to load, `script.js` adds `.is-empty` to `#video-shell` to show a placeholder.

## Messages

Visitors post to `/api/messages` and posts are held as pending. The owner approves them at `/messages-admin` (basic auth, password in `/etc/scout-messages.env`), and only approved messages are returned to the page. Message text is always rendered with `textContent`, never as HTML.

## Conventions

- Commented-out blocks in `index.html` (headings, caption, footer) were left intentionally by the owner — leave them unless asked.
- The page forces light mode (`color-scheme: only light`, `darkreader-lock`); keep it that way.
