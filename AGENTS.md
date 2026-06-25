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
  `web/` on port 8080 with `--host=0.0.0.0` (so it's also reachable directly
  from other devices on the LAN) and live-reload on file changes.
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
- The dev server itself currently runs as a systemd **user** unit (starts on
  graphical login), not a system unit. That's intentional for now since this
  is meant for a desktop dev machine with a normal login session. **If
  deploying to a headless host (no graphical login, e.g. a server or
  single-board computer running standalone), switch it to a system-level
  unit** (`/etc/systemd/system/...`) instead — a headless box never triggers
  a user unit since no one logs into a session. Caddy's setup doesn't need
  to change for that move.

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
- Don't forward SSH (22) directly to the internet for admin access — prefer
  a VPN (Tailscale/WireGuard) for remote management instead.
