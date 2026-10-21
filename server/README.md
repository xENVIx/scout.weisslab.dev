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
