#!/usr/bin/env bash
# Convenience wrapper for controlling the full domain+HTTPS stack installed
# by deploy/setup-dev-server.sh: the heimdal-dev systemd user service and
# the Caddy system service together, so they always move in lockstep.
set -euo pipefail

ACTION="${1:-}"
case "$ACTION" in
  start|stop|restart)
    dev_rc=0
    caddy_rc=0
    systemctl --user "$ACTION" heimdal-dev || dev_rc=$?
    sudo systemctl "$ACTION" caddy || caddy_rc=$?
    if systemctl --user is-active --quiet heimdal-dev; then
      echo "==> heimdal-dev is running"
    else
      echo "==> heimdal-dev is stopped"
    fi
    if systemctl is-active --quiet caddy; then
      echo "==> caddy is running"
    else
      echo "==> caddy is stopped"
    fi
    if [ "$dev_rc" -ne 0 ] || [ "$caddy_rc" -ne 0 ]; then
      echo "==> One or both actions failed (heimdal-dev rc=$dev_rc, caddy rc=$caddy_rc)" >&2
      exit 1
    fi
    ;;
  status)
    systemctl --user status heimdal-dev || true
    systemctl status caddy || true
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status}" >&2
    exit 1
    ;;
esac
