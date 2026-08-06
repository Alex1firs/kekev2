# Production nginx

`infra/nginx/nginx.conf` is the **source of truth** for the gateway that
terminates TLS for `api.kekeride.ng`, `staging.kekeride.ng` and
`admin.kekeride.ng`.

Deploy it with `infra/nginx/deploy.sh`. Compare without changing anything with
`infra/nginx/deploy.sh --check`.

---

## Why it is copied into place instead of pulled

The container bind-mounts a single **file**:

```
/opt/kekev2/nginx.conf  ->  /etc/nginx/nginx.conf
```

Docker resolves that to an inode when the container starts. Anything that
*replaces* the file — `git pull`, `git checkout`, `mv` — creates a new inode,
and the container's mount stays pointed at the old one. nginx keeps serving the
previous config and the next `nginx -s reload` re-reads a file nobody can see.

That is strictly worse than the untracked file this replaced: a change that
looks deployed and is not. So `deploy.sh` uses `cp`, which opens the destination
with `O_TRUNC` and writes in place, preserving the inode.

**The proper fix** is to bind-mount the directory rather than the file:

```yaml
# docker-compose.yml, nginx_gateway
volumes:
  - /opt/kekev2/infra/nginx:/etc/nginx/conf.d:ro   # instead of the single file
```

That removes the copy step entirely. It needs the container recreated, which is
a few seconds of refused connections on ports 80 and 443 — a maintenance-window
change, not something to fold into a routine deploy. Until then, `deploy.sh`
verifies after every run that the container's checksum matches the file's, and
fails loudly if the mount has been orphaned.

---

## Production-specific settings, and why each is the way it is

### Basic auth is global, and switched off in specific places

`auth_basic` is declared once at `http` level, so **everything is behind
htpasswd by default** and each server or location opts out. The opt-outs:

| Location | Why auth is off |
|---|---|
| `api.kekeride.ng` (whole server) | It is the public API. Passenger and driver apps have no way to send htpasswd credentials. |
| `admin.kekeride.ng` (whole server) | The dashboard has its own staff login with per-role permissions. A second shared password in front of it adds no security and blocks the app-level session. |
| `/.well-known/acme-challenge/` | Let's Encrypt must reach it unauthenticated or renewal fails. This is what broke TLS in July 2026. |
| `staging` `/dispatch`, `/api/`, `/socket.io/`, `/uploads/` | A service worker's own fetches do not reliably carry basic-auth credentials, so push acknowledgement fails. The dispatcher app authenticates every request with a StaffUser session and park-scoped permissions, which is a stronger control than a shared htpasswd line. |

Staging's catch-all `location /` keeps auth **on**, so the box stays off the
open internet.

### One certificate for three hostnames

All three server blocks reference
`/etc/letsencrypt/live/api.kekeride.ng/`. The certificate carries
`staging.kekeride.ng` and `admin.kekeride.ng` as SANs. There is no separate
certificate for either, and renewal is driven by the `api.kekeride.ng` lineage
only.

Renewal runs from certbot **on the host**, not in a container. The deploy hook
that reloads this container after renewal is what was missing during the July
2026 expiry outage: the certificate renewed on disk and nginx went on presenting
the expired one for days.

### `resolver 127.0.0.11 valid=30s ipv6=off`

Docker's embedded DNS. Combined with assigning the upstream to a variable
first —

```nginx
set $prod_app http://api_prod:4000;
proxy_pass $prod_app;
```

— this forces nginx to resolve the container name **per request** instead of
once at startup. Without it, nginx caches the API container's IP at boot; when
`api_prod` is rebuilt it gets a new IP, and the gateway keeps proxying to an
address nothing is listening on. Every deploy would end in 502s that only a
gateway restart cleared.

`ipv6=off` because Docker's resolver returns AAAA records the container cannot
route, which shows up as a ~5 second delay on every request.

### Ports differ between prod and staging

`api_prod` listens on **4000**, `api_staging` on **3000**. They share one
`.env`, which is why environment-specific values are suffixed (`_PROD`,
`_STAGING`) rather than overridden.

### Asset caching on the admin dashboard

```nginx
location ~* \.(png|jpg|jpeg|gif|ico|svg|woff2?)$ { expires max; }
location ~* \.(js|css|html)$ { add_header Cache-Control "no-cache"; }
```

The admin dashboard is not built — nginx bind-mounts `apps/keke_admin`
straight from the repo, so `app.js`, `styles.css` and `index.html` are edited in
place under fixed names.

They previously fell under the same `expires max` as the images. Because the
names never change, every admin UI change since launch reached the droplet and
no returning admin's browser ever requested it again. `no-cache` means
revalidate, which the ETag turns into a `304` — one round trip, not a
re-download. **Do not fold these two blocks back together.**

### `proxy_read_timeout 3600s` on `/socket.io/`

Socket.IO connections are long-lived by design. The default 60s would drop a
dispatcher's connection every minute; the client would reconnect, so it would
look like it worked.

The Upgrade headers on that location are equally load-bearing. Without them the
client silently falls back to long-polling — still functional, which is why this
is easy to get wrong and never notice, but it costs battery and data on a park
tablet.

### Websockets on production ride via the catch-all

`api.kekeride.ng` has no separate `/socket.io/` block; its `location /` already
carries `proxy_http_version 1.1` and the Upgrade headers, so passenger and
driver sockets upgrade correctly. Adding a more specific location for
`/socket.io/` **without** those headers would break every live ride.

### `proxy_set_header Authorization $http_authorization`

Explicit on the production API. With basic auth configured at `http` level,
nginx can consume the `Authorization` header itself rather than forwarding it,
and every Bearer-token request would arrive unauthenticated.

---

## Things worth changing, not changed here

Recorded rather than acted on, because this file was brought into git on the
condition that behaviour stay **exactly** as it was.

- **`/adminer` is exposed on the production domain**, behind basic auth only. A
  database management UI on the public API hostname is a large target for one
  shared password. It should move behind the VPN or be removed.
- **The gateway has no rate limiting.** All throttling is in the application, so
  anything that gets past nginx costs a Node process.
- **No `client_max_body_size`**, so the 1 MB default applies. Driver KYC uploads
  work today; a larger photo would fail with a 413 that reads as a client bug.
- **The single-file bind mount**, as above.

---

## Verifying

```bash
# do the tracked file, the deployed file and the container all agree?
infra/nginx/deploy.sh --check

# what is the container actually serving?
docker exec keke_backend-nginx_gateway-1 sha256sum /etc/nginx/nginx.conf
sha256sum infra/nginx/nginx.conf
```

Backups from every deploy are at `/root/nginx.conf.bak-<timestamp>` on the
droplet. `deploy.sh` restores one automatically if `nginx -t` fails.
