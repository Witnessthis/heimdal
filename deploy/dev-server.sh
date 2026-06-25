#!/usr/bin/env bash
# Convenience wrapper for controlling the heimdal-dev systemd user service
# (the live-reload dev server installed by deploy/setup-dev-server.sh).
set -euo pipefail

ACTION="${1:-}"
case "$ACTION" in
  start|stop|restart)
    systemctl --user "$ACTION" heimdal-dev
    if systemctl --user is-active --quiet heimdal-dev; then
      echo "==> heimdal-dev is running"
    else
      echo "==> heimdal-dev is stopped"
    fi
    ;;
  status)
    systemctl --user status heimdal-dev
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status}" >&2
    exit 1
    ;;
esac
