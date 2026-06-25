#!/usr/bin/env bash
# Minimal local-network testing: no domain, no Caddy, no certificate. Runs
# the live-reload dev server directly over plain HTTP, reachable from any
# device on the same network (phone, another computer, etc).
#
# Note: without HTTPS, the service worker won't register (so offline
# caching won't activate), but the page loads normally and "Add to Home
# Screen" still works on iOS/Android. For full HTTPS PWA testing with your
# own domain, see deploy/setup-dev-server.sh instead.
set -euo pipefail

if systemctl is-active --quiet caddy 2>/dev/null; then
  echo "Caddy is currently running and proxying your domain to localhost:8080." >&2
  echo "Starting this now would also expose it through Caddy/your domain," >&2
  echo "which defeats the point of testing purely locally." >&2
  echo "" >&2
  echo "Stop it first with: deploy/dev-server.sh stop" >&2
  exit 1
fi

if systemctl --user is-active --quiet heimdal-dev 2>/dev/null; then
  echo "The heimdal-dev service is already using port 8080." >&2
  echo "" >&2
  echo "Stop it first with: deploy/dev-server.sh stop" >&2
  exit 1
fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

if [ ! -d node_modules ]; then
  echo "==> Installing npm dependencies"
  npm install
fi

LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") {print $(i + 1); exit}}')"

echo "==> Starting dev server on port 8080"
echo "    From this machine:                          http://localhost:8080"
if [ -n "$LAN_IP" ]; then
  echo "    From your phone or another device on this network: http://$LAN_IP:8080"
fi
echo ""

exec npm run dev
