# Admin sign-in

There's one admin password: `ADMIN_PASSWORD` in `/etc/scout-media.env`. Signing in at `/admin/login` (served by `media.js`) sets a `scout_admin` cookie for the whole site (30 days), signed with `SESSION_SECRET`, which is in both `/etc/scout-media.env` and `/etc/scout-messages.env`; both servers check it the same way. `/admin` is a page of links to everything (with how many messages are waiting, asked of `messages.js` over 127.0.0.1 with `IMPORT_TOKEN`). Visiting any admin page signed out sends you to `/admin/login`, and back afterwards. To sign everyone out, change `SESSION_SECRET` in both files and restart both units.

# Messages for Scout backend

`messages.js` is a dependency-free Node server on `127.0.0.1:3311`:

- `GET /api/messages` returns approved messages, newest first (with `photo`, a URL, when there is one).
- `POST /api/messages` (`{"text": "...", "photo": "data:image/...;base64,..."}`, either or both) stores a pending message, with a honeypot field and a limit of 5 per IP per hour. The page shrinks a photo to 2400 px and re-saves it as a JPEG first (GIFs go as they are); the server takes JPEG, PNG, GIF or WebP (checked by their first bytes), 8 MB max.
- `GET /api/messages/photo/<id>` serves a photo once its message is approved; `/messages-admin/photo/<id>` serves it to the admin any time.
- `/messages-admin` is the approval page, behind the admin sign-in (above). Each message can be approved, hidden or deleted, and one with a photo can have just the photo removed, or copied into `media/` ("Copy to my media", with Gallery / Slideshow, or Moments for a GIF, and optionally its text as the caption).

Each new message is emailed to `NOTIFY_EMAIL` (in `/etc/scout-messages.env`; leave it out to turn emails off), from `NOTIFY_FROM` (set to `scout@weisslab.dev`; the code's default is `scout@inlovingmemoryofscout.com`), with a link to `/messages-admin`. `messages.js` hands it to the server's Postfix on `127.0.0.1:25` (the service's sandbox can't run `sendmail`), and Postfix delivers it directly, saying `HELO weisslab.dev` (`smtp_helo_name`). Gmail only accepts it if the sending domain's DNS has an SPF record for this server, `v=spf1 ip4:134.199.206.222 ~all` on `weisslab.dev`, and the server's reverse DNS (the droplet's name, `weisslab.dev`) points back to it. Delivery is logged in `/var/log/mail.log`.

Messages are stored in `/var/lib/scout-messages/messages.json`, outside the web root, with their photos in `/var/lib/scout-messages/photos/`. (systemd's `DynamicUser` puts them under `/var/lib/private/scout-messages/`.)

Copying a photo into `media/` goes through the media manager, since only it can write there: `messages.js` POSTs the file to `http://127.0.0.1:3312/internal/import` with an `X-Import-Token` header. Both env files hold the same `IMPORT_TOKEN`; the media manager refuses the request without it, or if it came through nginx (which never proxies `/internal/` anyway).

## Install (run as root)

```sh
cp server/scout-messages.service /etc/systemd/system/
TOKEN=$(openssl rand -hex 24)
SECRET=$(openssl rand -hex 32)
( umask 077; printf 'IMPORT_TOKEN=%s\nSESSION_SECRET=%s\n' "$TOKEN" "$SECRET" > /etc/scout-messages.env )
printf 'IMPORT_TOKEN=%s\nSESSION_SECRET=%s\n' "$TOKEN" "$SECRET" >> /etc/scout-media.env   # the same two, shared
systemctl daemon-reload && systemctl enable --now scout-messages && systemctl restart scout-media
cat /etc/scout-messages.env   # the admin password
```

The nginx rules are in `nginx-site.conf`, which every domain serving the site includes. nginx passes the domain on as `Host`, and admin POSTs must come from a page on that same domain.

After editing `messages.js`, run `systemctl restart scout-messages`.

# Media manager

`media.js` is a second dependency-free Node server, on `127.0.0.1:3312`. It serves the admin sign-in and `/admin` (above), and `/media-admin`. Ten wrong passwords from one IP locks sign-in out for 15 minutes. From that page you can upload photos and videos into `media/` (one flat folder; one file per request, streamed to disk, 1 GB max) and rename or delete them. Each file also has "Gallery" and "Slideshow" checkboxes, saved to `media/not_in_gallery.txt` and `media/slideshow.txt`, except that GIFs and videos get "Moments" in place of "Slideshow", saved to `media/moments.txt` (the slideshow is photos only). Each GIF also has a "Transition" menu picking which section-to-section transition it plays for (`media/transitions.txt`, `<from>><to>=<file>` lines; one GIF per transition, so ones already taken are greyed out in the other menus and refused by the server). Renaming the intro photo or catch video updates `media/page_files.txt`, which the page reads to find them; a "Title page photo" dropdown (still photos only, with a preview cropped like the page's frame) sets `intro=` there. A "Slideshow" box sets how many seconds each photo shows (`slide_seconds=<n>` in `media/settings.txt`, default 5). A "Memorial text" box at the bottom edits `media/memorial.txt`, the Memorial section's text. Each file has an optional caption box (saved to `media/captions.txt` as `<file>=<caption>` lines). Files are grouped by type (images, GIFs, videos), or listed in display order with a "Slide n · Gallery n" label; the choice is remembered in a cookie. In display order, rows can be dragged by their handle (mouse or touch) or moved with the arrow keys; the order saves to `media/order.txt`, and files it doesn't name come after, by filename.

It runs as the system user `scout-media`, which owns `media/` and can't write anywhere else.

## Install (run as root)

```sh
useradd --system --no-create-home --shell /usr/sbin/nologin scout-media
chown -R scout-media:scout-media media
( umask 077; printf 'ADMIN_PASSWORD=%s\n' "$(openssl rand -base64 15)" > /etc/scout-media.env )
cp server/scout-media.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now scout-media
```

The nginx rule is in `nginx-site.conf`. After editing `media.js`, run `systemctl restart scout-media`.
