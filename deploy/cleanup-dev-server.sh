#!/usr/bin/env bash
# Reverses deploy/setup-dev-server.sh: stops and disables the dev server and
# Caddy services, and removes the files that script generated. Leaves the
# `caddy` package itself installed and `node_modules/` in place, since those
# aren't unique to Heimdal's setup and removing them is a separate decision
# (see the printed notes at the end for how to do that too, if you want it
# all gone).
set -euo pipefail

echo "==> Stopping and disabling the dev server user service"
systemctl --user disable --now heimdal-dev 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/heimdal-dev.service"
systemctl --user daemon-reload

echo "==> Stopping and disabling Caddy"
sudo systemctl disable --now caddy 2>/dev/null || true

echo "==> Removing the Caddyfile this setup generated"
sudo rm -f /etc/caddy/Caddyfile

echo "==> Done. The dev server and Caddy are stopped, disabled, and their"
echo "    generated config/unit files are removed."
echo ""
echo "Still on this machine, if you want them gone too:"
echo "  - The caddy package:   sudo pacman -Rns caddy"
echo "  - npm dependencies:    rm -rf node_modules"
