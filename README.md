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

The `web/` folder holds the PWA shell. To run it with live-reload and expose it
publicly over HTTPS via [Caddy](https://caddyserver.com/), both auto-starting
on your machine:

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
