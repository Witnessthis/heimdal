# Heimdal

Heimdal is an AI-powered mail client frontend designed to cut down on notification
noise and keep your inbox under control.

It connects to your existing mail provider(s) and uses an AI model — your choice of
self-hosted or third-party — to automatically:

- Filter and sort incoming mail based on your own rules and preferences
- Reduce notifications by surfacing only what actually matters
- Draft replies for review, so responding takes less time
- Identify and unsubscribe from promotional/marketing mail

## Goals

- **Installable everywhere**: built as a web app (PWA) that installs on iOS
  (via Safari), Android, Linux, Windows, and macOS, without needing native
  app store releases.
- **Provider-agnostic**: works with Gmail/Google Workspace, Outlook/Microsoft 365,
  and other mail providers, rather than locking you into one ecosystem.
- **AI-agnostic**: supports both self-hosted models and hosted AI providers, so
  you can choose based on cost, privacy, and capability needs.
- **User-configurable filtering**: the rules and intent behind sorting,
  notification suppression, and unsubscribing are driven by your configuration,
  not a fixed black-box policy.

## Status

Early stage — project intent and direction only. Implementation has not started yet.

## Local development

The `web/` folder holds the PWA shell, served with live-reload via
`npm run dev`. Two ways to try it out, depending on what you need:

### Quick local test (no domain needed)

To just try it out from a browser or phone on the same network:

```sh
deploy/serve-local.sh
```

This runs the dev server over plain HTTP and prints the URL to use from
other devices on your network. No domain, no Caddy, no certificate needed.
The one limitation: without HTTPS, the service worker won't register (so
offline caching won't activate), but the page loads normally and
"Add to Home Screen" still works on iOS/Android.

### Full setup with your own domain and HTTPS

To run it with live-reload and expose it publicly over HTTPS via
[Caddy](https://caddyserver.com/), both auto-starting on your machine:

```sh
deploy/setup-dev-server.sh yourdomain.com
```

Prerequisites: Arch Linux (pacman), Node.js/npm, a systemd user session, and a
domain whose DNS A record points at your machine's public IP with ports 80/443
forwarded to it.

This installs Caddy, writes `/etc/caddy/Caddyfile`, installs a
`heimdal-dev.service` systemd user unit that runs `npm run dev`
(`live-server` on `web/`, port 8080), and enables both to start automatically.
Re-run the script anytime after editing the templates in `deploy/`.

To undo all of that:

```sh
deploy/cleanup-dev-server.sh
```

This stops and disables both services and removes the files the setup script
generated. It leaves the `caddy` package and `node_modules/` installed; the
script prints how to remove those too if you want a fully clean machine.
