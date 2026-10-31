# Hosted God's Eye View — runbook

One server, one domain, one instance, one login per person.

Everything is in this folder:

| File | What it is |
| --- | --- |
| `compose.hosted.yaml` | The stack: the app, plus Caddy for TLS and logins. Only Caddy publishes ports. |
| `Caddyfile` | TLS, the login block, security headers, and the proxy to the app. |
| `users.caddyfile` | Who may log in. One line per person, bcrypt hash only. Ignored by git. |
| `users.caddyfile.example` | The format, and why the file may not be empty. |
| `make-users.mjs` | Add, list and remove people without hand-writing a hash. |
| `.env.example` | The two values you must supply: `DOMAIN` and `ACME_EMAIL`. |

The app image, `Dockerfile` and root `compose.yaml` were already in the
repository; this folder adds the public, authenticated edge around them.

---

## 1. What you are deploying

- **One shared instance.** Everybody who logs in sees the same live data, the
  same layers and the same map. There is no per-person account inside the app.
- **Named logins at the edge.** Caddy holds a bcrypt hash per person and asks
  for a username and password before any request reaches the app. A browser
  keeps that in its password manager, so in practice people log in once.
- **Watchlists are personal and local.** The star list lives in each person's
  browser storage, so it follows the person's browser, not the account. A
  watchlist cannot be seen by, or shared with, another user. That is a deliberate
  limit of a one-instance design, not an oversight.
- **Keys stay on the server.** Provider keys live in the repository's `.env` on
  the server. Provider Settings in the browser is switched off for everybody
  (`GEV_KEY_SETUP_TRUSTED_PEERS=none`), so no visitor can read or change keys.

## 2. Prerequisites

1. **A server.** 2 vCPU, 2 GB RAM, 20 GB disk is ample; the app is a Node process
   and the heavy imagery is drawn by the visitor's browser.
2. **Docker Engine with the compose plugin.**
3. **A DNS `A` record** (and `AAAA` if the server has IPv6) pointing the name at
   the server, already propagated. Caddy asks Let's Encrypt for a certificate on
   first start and cannot prove ownership if the name does not resolve yet.
4. **Ports 80 and 443 open** in the cloud firewall *and* the host firewall.
   Port 80 is not optional: it is where the certificate challenge lands.
5. **The repository on the server**, cloned as the user that will run compose.

## 3. First deploy

```bash
# 1. Docker (skip if already installed)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"   # then log out and back in

# 2. The code
git clone <your fork> gev
cd gev

# 3. Who we are
cp deploy/.env.example deploy/.env
$EDITOR deploy/.env               # DOMAIN=fires.example.org, ACME_EMAIL=you@example.org

# 4. Keys (the root .env, inside the bind mount, so the container reads it)
cp .env.example .env
$EDITOR .env                      # at minimum FIRMS_MAP_KEY, see section 5

# 5. The first person
node deploy/make-users.mjs alice

# 6. Start
docker compose -f deploy/compose.hosted.yaml up -d --build
```

Then check, in this order:

```bash
docker compose -f deploy/compose.hosted.yaml ps        # both services Up, app healthy
curl -sI https://fires.example.org | head -1           # HTTP/2 401 - the login is working
docker compose -f deploy/compose.hosted.yaml logs caddy | grep -i -E 'certificate|acme'
```

Open the site, log in as `alice`, and confirm the Fire Watch panel lists fires.
If the list is empty but the map works, the FIRMS key is missing — see section 5.

**Do not open the app port to the world.** Only Caddy publishes 80 and 443. The
app is on the compose network as `app:4173` and is unreachable from outside, so
the login is the only way in. If you publish the app port "just for a moment",
you have published the key broker with no authentication at all.

## 4. Adding and removing people

```bash
node deploy/make-users.mjs bob            # asks for a password twice, writes the hash
node deploy/make-users.mjs --list         # usernames only, never hashes
node deploy/make-users.mjs --remove bob
docker compose -f deploy/compose.hosted.yaml restart caddy
```

`make-users.mjs` needs a bcrypt hasher and Node has none, so it asks Caddy to do
it: the `caddy` binary if it is on `PATH`, otherwise the `caddy:2.11-alpine`
image the stack already runs. The password goes in on stdin, is never an
argument, is never printed, and is never written anywhere but as a hash.

Rules worth keeping:

- **Twelve characters minimum**, enforced. It is the only thing guarding the
  site, and there is no rate limit or lockout at this layer.
- **One login per person, never shared.** The username in the Caddy log is the
  only record of who was looking.
- **Removing someone is a line and a restart.** Their browser keeps its
  watchlist; it stops being able to reach the site.
- Restarting **Caddy only** is enough. The app does not restart and no data
  moves.

## 5. Keys

The wildfire panel needs one key; everything else is optional.

| Key | Where | Needed for |
| --- | --- | --- |
| `FIRMS_MAP_KEY` | root `.env` | The live fire list. Free from <https://firms.modaps.eosdis.nasa.gov/api/map_key/>. Without it the Fire Watch panel loads and shows no incidents. |
| `GOOGLE_MAPS_API_KEY` | root `.env` | Google photorealistic 3D and place search. **Client-exposed by design** — restrict it by HTTP referrer in Google Cloud. |
| `CESIUM_ION_TOKEN` | root `.env` | Cesium world imagery and terrain. Also client-exposed; restrict it. |
| `GOOGLE_MAPS_SERVER_API_KEY` | root `.env` | Optional separate server-side Google key (Places, Street View static). Never reaches the browser. |

After changing the root `.env`:

```bash
docker compose -f deploy/compose.hosted.yaml restart app
```

A client-exposed key is visible to anyone who logs in and opens devtools. Since
every user is named, that is a known audience, but the keys should still be
restricted at the provider.

## 6. Backups

Four things are worth keeping. Everything else can be rebuilt from git.

```bash
sudo tar czf gev-backup-$(date +%F).tar.gz \
  deploy/.env deploy/users.caddyfile .env \
  --exclude='node_modules'
```

- `deploy/.env` — the domain and ACME address.
- `deploy/users.caddyfile` — who can log in. Losing it locks everybody out;
  hashes cannot be recovered, so each person would need a new password.
- `.env` — the keys.
- The **`caddy_data` volume** — the certificate and the ACME account key. Losing
  it costs a new certificate, which counts against Let's Encrypt's rate limits,
  so back it up occasionally rather than often. The volume is
  `gev-hosted_caddy_data` (the `name:` pinned in the compose file); `docker
  volume ls` confirms it:

```bash
docker compose -f deploy/compose.hosted.yaml exec caddy \
  tar czf - -C /data . > caddy-data-$(date +%F).tar.gz
```

Copy the archive off the server. A backup on the same disk is not a backup.

## 7. Updates

```bash
cd gev
git pull
docker compose -f deploy/compose.hosted.yaml up -d --build
docker compose -f deploy/compose.hosted.yaml ps
```

`--build` matters: the app is served from the bind-mounted checkout, but its
container image pins Node and installs dependencies, so the image is rebuilt when
that changes. New dependencies in `package-lock.json` need the rebuild even when
the code did not change.

`deploy/.env`, `deploy/users.caddyfile` and the root `.env` are ignored by git,
so a pull never overwrites them.

## 8. Logs, health, restart

```bash
docker compose -f deploy/compose.hosted.yaml logs -f app
docker compose -f deploy/compose.hosted.yaml logs -f caddy
docker compose -f deploy/compose.hosted.yaml ps
docker compose -f deploy/compose.hosted.yaml restart app     # after a key change
docker compose -f deploy/compose.hosted.yaml restart caddy   # after a user change
```

`ps` reports the app's healthcheck. The probe is a request to `/` inside the
container: `healthy` means the server answers, `unhealthy` means it does not, and
the container restarts after three failures.

Caddy's log records every request with the authenticated username, which is how
you answer "who was looking at this" later.

## 9. Takedown

```bash
docker compose -f deploy/compose.hosted.yaml down          # stop, keep data
docker compose -f deploy/compose.hosted.yaml down -v       # stop, delete volumes
```

`down` leaves the certificate volume in place, so bringing it back up does not
re-ask Let's Encrypt. `down -v` deletes it. Removing the DNS record first means
nobody can reach the box while it is still running.

## 10. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| **502 Bad Gateway** after login | Caddy cannot reach the app. `docker compose ... logs app` to see whether it started. If you are running Caddy outside Docker against a local dev server, note that the dev server binds `::1` only — use `APP_UPSTREAM=localhost:4173`, not `127.0.0.1:4173`. |
| **No certificate**, Caddy log shows ACME errors | DNS not propagated, port 80 blocked, or a CAA record forbids Let's Encrypt. `dig +short fires.example.org` must return the server. Rate limits apply after repeated failures: check with `--staging` style testing or wait. |
| **401 on a correct password** | The hash and the password disagree, or `users.caddyfile` was not reloaded. Regenerate with `make-users.mjs` and restart Caddy. Never hand-write a hash. |
| **Caddy will not start**: `import` file missing | `deploy/users.caddyfile` does not exist. Docker would create a *directory* at that path, so create the file first: `node deploy/make-users.mjs alice` writes it properly. |
| **403 Blocked request. This host is not allowed.** | The app's Host allowlist. `GEV_ALLOWED_HOSTS` is set from `DOMAIN` by compose; if `DOMAIN` is empty, the public name is not on the list. |
| **Map loads, Fire Watch is empty** | `FIRMS_MAP_KEY` missing or rejected. The panel says "KEY REQUIRED" when it is absent. |
| **Provider Settings does nothing** | By design: `GEV_KEY_SETUP_TRUSTED_PEERS=none`. Keys go in the root `.env` and the app restarts. |
| **504, "Outdated Optimize Dep", panels missing** | Vite's dependency optimiser is stale after a dependency change. `docker compose ... restart app`. |
| **Everyone locked out** | `deploy/users.caddyfile` is empty or lost. Re-add each person with `make-users.mjs`. Hashes cannot be recovered. |

## 11. Local dry run (no Docker)

This is how the edge was validated on a machine without Docker. It proves the
login and the proxy; it does not exercise the containers.

```bash
# Terminal 1 - the app
npm run dev -- --port 4174 --strictPort

# Terminal 2 - Caddy, plain HTTP on :8080, proxying to the dev server
cd gev
cp deploy/users.caddyfile.example deploy/users.caddyfile   # then add a real line
node deploy/make-users.mjs tester
DOMAIN=:8080 ACME_EMAIL=ops@example.org APP_UPSTREAM=localhost:4174 \
  caddy run --config deploy/Caddyfile --adapter caddyfile

# Terminal 3 - prove it
curl -sI http://localhost:8080/                        # 401 + WWW-Authenticate
curl -s  -u tester:<password> http://localhost:8080/   # the app's HTML
curl -s  -u tester:<password> http://localhost:8080/api/fire-risk | head -c 200
```

`DOMAIN=:8080` is the Caddy shorthand for "serve plain HTTP on this port", which
is why no certificate is involved locally. `localhost` rather than
`127.0.0.1` for `APP_UPSTREAM` because the dev server listens on `::1` only.

## 12. What has actually been tested

Stated plainly, because a runbook that overstates its evidence is worse than none.

**Proven**, with Caddy 2.11.7 on Windows against the local dev server:

- `caddy fmt` and `caddy validate` both pass on this `Caddyfile`.
- Anonymous `GET /` returns **401** with `WWW-Authenticate: Basic realm="restricted"`.
- Authenticated `GET /` returns **200**, `text/html`, the real application shell.
- `GET /api/fire-risk` through Caddy returns **200** with 40 zones.
- `X-Content-Type-Options: nosniff` and `Referrer-Policy` are present; no `Server`
  header is sent.
- A hash generated by `deploy/make-users.mjs` authenticates; a wrong password and
  an unknown username both return **401**.
- `make-users.mjs` adds, lists, removes, and rejects duplicates, short passwords,
  mismatched passwords and invalid usernames.

**Not proven here:** `compose.hosted.yaml` has never been built or run, because
Docker is not installed on the machine this was written on. The image tag
(`caddy:2.11-alpine`) matches the binary that was validated, and the app's own
container path was already in use, but the first real `up -d --build` is the
first real test. Expect to spend ten minutes on section 3 and section 10 the
first time.
