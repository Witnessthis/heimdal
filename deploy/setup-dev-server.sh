#!/usr/bin/env bash
# Sets up this machine to serve web/ as a live-reload dev server behind Caddy,
# both auto-starting on boot/login. Assumes Arch Linux (pacman) and a systemd
# user session. Re-run anytime to pick up template changes.
#
# Usage: deploy/setup-dev-server.sh <domain>
set -euo pipefail

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  echo "Usage: $0 <domain>" >&2
  echo "Example: $0 example.com" >&2
  exit 1
fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Installing Caddy (if needed)"
if ! command -v caddy >/dev/null 2>&1; then
  sudo pacman -Syy
  sudo pacman -S --needed --noconfirm caddy
fi

echo "==> Installing npm dependencies"
cd "$REPO_DIR"
npm install

echo "==> Writing /etc/caddy/Caddyfile for $DOMAIN"
sed "s/{{DOMAIN}}/$DOMAIN/" "$REPO_DIR/deploy/Caddyfile.template" | sudo tee /etc/caddy/Caddyfile >/dev/null

echo "==> Enabling Caddy system service"
sudo systemctl enable --now caddy
sudo systemctl reload caddy

echo "==> Writing systemd user service for the dev server"
mkdir -p "$HOME/.config/systemd/user"
sed "s|{{REPO_DIR}}|$REPO_DIR|" "$REPO_DIR/deploy/heimdal-dev.service.template" \
  > "$HOME/.config/systemd/user/heimdal-dev.service"

echo "==> Enabling dev server user service"
systemctl --user daemon-reload
systemctl --user enable --now heimdal-dev

echo "==> Done. Caddy is proxying https://$DOMAIN -> localhost:8080 (live-reload dev server)."
