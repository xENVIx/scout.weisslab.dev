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

The nginx rules are in `nginx-messages.conf`. They're already applied to `/etc/nginx/sites-available/inlovingmemoryofscout.com`.

After editing `messages.js`, run `systemctl restart scout-messages`.

# Media manager

`media.js` is a second dependency-free Node server, on `127.0.0.1:3312`. It serves `/media-admin`, behind HTTP basic auth with the `ADMIN_PASSWORD` in `/etc/scout-media.env` (any username). From that page you can upload photos and videos into any folder under `media/` (one file per request, streamed to disk, 1 GB max), rename or delete files, and create or remove folders. `pictures`, `slideshow` and `videos` can't be removed.

It runs as the system user `scout-media`, which owns `media/` and can't write anywhere else.

## Install (run as root)

```sh
useradd --system --no-create-home --shell /usr/sbin/nologin scout-media
chown -R scout-media:scout-media media
( umask 077; printf 'ADMIN_PASSWORD=%s\n' "$(openssl rand -base64 15)" > /etc/scout-media.env )
cp server/scout-media.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now scout-media
```

The nginx rule is in `nginx-media.conf` and is already applied. After editing `media.js`, run `systemctl restart scout-media`.
