# Messages for Scout backend

`messages.js` is a dependency-free Node server on `127.0.0.1:3311`:

- `GET /api/messages` returns approved messages, newest first.
- `POST /api/messages` (`{"text": "..."}`) stores a pending message, with a honeypot field and a limit of 5 per IP per hour.
- `/messages-admin` is the approval page, behind HTTP basic auth with `ADMIN_PASSWORD` (any username).

Messages are stored in `/var/lib/scout-messages/messages.json`, outside the web root.

## Install (run as root)

```sh
cp server/scout-messages.service /etc/systemd/system/
( umask 077; printf 'ADMIN_PASSWORD=%s\n' "$(openssl rand -base64 15)" > /etc/scout-messages.env )
systemctl daemon-reload && systemctl enable --now scout-messages
cat /etc/scout-messages.env   # the admin password
```

The nginx rules are in `nginx-site.conf`, which every domain serving the site includes. nginx passes the domain on as `Host`, and admin POSTs must come from a page on that same domain.

After editing `messages.js`, run `systemctl restart scout-messages`.

# Media manager

`media.js` is a second dependency-free Node server, on `127.0.0.1:3312`. It serves `/media-admin`, which shows a sign-in form for the `ADMIN_PASSWORD` in `/etc/scout-media.env` and then keeps you signed in for 30 days with a signed cookie. Ten wrong passwords from one IP locks it out for 15 minutes. From that page you can upload photos and videos into `media/` (one flat folder; one file per request, streamed to disk, 1 GB max) and rename or delete them. Each file also has "Gallery" and "Slideshow" checkboxes, saved to `media/not_in_gallery.txt` and `media/slideshow.txt`. Renaming the intro photo or catch video updates `media/page_files.txt`, which the page reads to find them. A "Slideshow" box sets how many seconds each photo shows (`slide_seconds=<n>` in `media/settings.txt`, default 5). A "Memorial text" box at the bottom edits `media/memorial.txt`, the Memorial section's text. Each file has an optional caption box (saved to `media/captions.txt` as `<file>=<caption>` lines). Files are grouped by type (images, GIFs, videos), or listed in display order with a "Slide n · Gallery n" label; the choice is remembered in a cookie. In display order, rows can be dragged by their handle (mouse or touch) or moved with the arrow keys; the order saves to `media/order.txt`, and files it doesn't name come after, by filename.

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
