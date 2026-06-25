# Agent notes for Heimdal

This file orients an AI coding agent picking up this repo. See `README.md`
for the product pitch; this file is about the current implementation state
and the dev/deploy setup, so you don't have to rediscover it from scratch.

## Project state

Early stage. `web/` contains a minimal PWA shell only — `index.html`,
`manifest.webmanifest`, a service worker (`sw.js`), and icons. No app logic,
no mail-provider integration, no AI filtering yet. Treat anything beyond
"static placeholder page" as not yet built.

## Local dev server

- `package.json` defines `npm run dev`, which runs `live-server` against
  `web/` on port 8080 with `--host=::` (dual-stack: covers IPv4 and IPv6 on
  one socket, so `localhost`/`127.0.0.1`/`::1`/the LAN IP all work — plain
  `0.0.0.0` only binds IPv4, which breaks `localhost` on any system where it
  resolves to `::1` first) and live-reload on file changes.
- `live-server` is an old, lightly-maintained package. Its declared
  dependencies (`chokidar@^2.0.4`, `http-auth@3.1.x`) pull in vulnerable
  transitive deps (`braces`/`chokidar` — high severity ReDoS-style issue in
  file-watching glob matching; `uuid` — moderate, only reachable through an
  optional basic-auth feature we never enable). `package.json` has an
  `overrides` block pinning `chokidar` and `uuid` to patched majors. This was
  verified safe by reading live-server's and http-auth's actual source: the
  chokidar API surface they use (`watch()` + standard events) is unchanged
  across the major bump, and the vulnerable uuid code path is in
  `http-auth`'s digest-auth flow, which is never invoked since live-server
  isn't started with auth options. **Don't run `npm audit fix --force`** —
  it tries to "fix" this by downgrading `live-server` itself, which is worse
  than the current override approach. Re-verify the override assumptions if
  you ever bump `live-server`'s version or change its CLI flags.
- Long-term: `live-server` is a dev-preview convenience, not meant to be the
  permanent production server. Revisit this once real backend/app code
  exists, before treating a deployed instance as "production."

## Deployment / serving setup

- `deploy/serve-local.sh` is the no-domain path: runs `npm run dev` directly
  over plain HTTP, reachable from other devices on the same LAN, with no
  Caddy/TLS involved at all. Doesn't autostart anything or touch the system —
  just runs in the foreground until killed. Service worker registration
  won't work over plain HTTP on a non-localhost origin, so offline caching
  won't activate in this mode, but the page and "Add to Home Screen" both
  work fine. This is intentionally separate from, not a replacement for, the
  domain+HTTPS path below. If Caddy is currently active, it refuses to start
  at all (rather than silently also becoming reachable through the domain)
  and tells the caller to run `deploy/dev-server.sh stop` first — no
  automatic side effects on other services.
- `deploy/setup-dev-server.sh <domain>` is the one-command setup path for a
  fresh clone. It is idempotent (safe to re-run after editing the templates
  in `deploy/`).
- It installs Caddy (Arch Linux / `pacman` only, currently — refreshes the
  package DB first since stale local sync DBs have caused 404s on package
  downloads before), runs `npm install`, generates `/etc/caddy/Caddyfile`
  from `deploy/Caddyfile.template` (reverse-proxying the given domain to
  `localhost:8080`), and generates a systemd **user** unit from
  `deploy/heimdal-dev.service.template` to autostart the dev server on
  login.
- Caddy is run as its distro-provided **system** service (`systemctl enable
  --now caddy`), so it starts at boot independent of any login session.
  Caddy handles HTTPS automatically via Let's Encrypt (HTTP-01 challenge),
  including renewal — no manual cert handling.
- `deploy/dev-server.sh {start|stop|restart|status}` controls the dev server
  (`systemctl --user <action> heimdal-dev`) and Caddy (`sudo systemctl
  <action> caddy`) together, so the two services covering the domain+HTTPS
  path always move in lockstep — there's no state where one is up and the
  other isn't from using this script.
- The dev server itself currently runs as a systemd **user** unit (starts on
  graphical login), not a system unit. That's intentional for now since this
  is meant for a desktop dev machine with a normal login session. **If
  deploying to a headless host (no graphical login, e.g. a server or
  single-board computer running standalone), switch it to a system-level
  unit** (`/etc/systemd/system/...`) instead — a headless box never triggers
  a user unit since no one logs into a session. Caddy's setup doesn't need
  to change for that move.

## Docker deployment

- `Dockerfile` builds an Alpine-based image (multi-arch: amd64 + arm64) with
  Caddy serving the static `web/` content from `/srv/heimdal/`.
- `docker-entrypoint.sh` is the container entrypoint. It generates
  `/etc/caddy/Caddyfile` at runtime based on the `DOMAIN` env var:
  - If `DOMAIN` is set → writes a domain-based config for HTTPS (Caddy
    auto-provisions Let's Encrypt certs).
  - If `DOMAIN` is unset → writes a `:80` config for plain HTTP.
- No Caddyfile is baked into the image — the entrypoint always writes one
  fresh on container start, so the same image works for both local and
  public modes.
- This is the distro-agnostic deployment path. Unlike the systemd-based
  setup in `deploy/`, it requires nothing but Docker on the host.

## Let's Encrypt rate limits in development

- Let's Encrypt enforces a **50 certificates per domain per week** limit, but
  a narrower limit that bites far more often in dev: **5 certificates per
  exact set of identifiers per week**. Every time you recreate the container
  with the `DOMAIN` env set (e.g. on a new machine, after a `docker rm`, or
  after a full rebuild), Caddy requests a fresh certificate, burning one of
  those 5 slots. Once exhausted, all further issuance gets `HTTP 429` until
  the window resets (~168h from the first of those 5 certs).
- **Best for local development**: don't set `DOMAIN` at all — serve over
  plain HTTP. No rate limits, no certs needed, and you avoid the 429 trap
  entirely:
  ```sh
  docker run -d --name heimdal -p 80:80 heimdal
  ```
- **If you need to test HTTPS behavior during development**, use the
  **staging** ACME endpoint to avoid burning production quota:
  ```sh
  docker run -d --name heimdal -p 80:80 -p 443:443 \
    -e DOMAIN=witnessthis.eu \
    heimdal caddy run --config /etc/caddy/Caddyfile \
    --ca https://acme-staging-v02.api.letsencrypt.org/directory
  ```
  Staging certs are not trusted by browsers, but they're identical in every
  other way (challenge flow, renewal, etc.) and have much higher rate limits.
- Once dev is stable, switch back to the production CA (just remove the
  `--ca` flag) — that single cert will renew automatically and never count
  against the limit again unless you tear down the container and recreate it.

## Networking prerequisites (host-specific, not in this repo)

Not encoded anywhere in the repo since it's environment-specific, but
required for the public-facing setup to work:
- A domain with its DNS A record pointed at the public IP of whoever is
  hosting it.
- The router forwarding TCP 80 and 443 to the host machine's LAN IP, with a
  **static DHCP reservation** for that machine (a forward to a DHCP-assigned
  IP silently breaks if the lease changes).
- Port 80 must stay forwarded even though the site is HTTPS-only in
  practice — Caddy needs it for the Let's Encrypt HTTP-01 challenge (initial
  issuance and renewal) and for the automatic HTTP→HTTPS redirect.
- **Hairpin NAT** enabled on the port-forward rule, so devices on the same
  LAN as the host can reach the public domain too (without it, internal
  clients hitting the public IP/domain get routed to the router's own admin
  interface instead of being looped back to the host).
