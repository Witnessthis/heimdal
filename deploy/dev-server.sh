#!/usr/bin/env bash
# Convenience wrapper for controlling the heimdal-dev systemd user service
# (the live-reload dev server installed by deploy/setup-dev-server.sh).
set -euo pipefail

ACTION="${1:-}"
case "$ACTION" in
  start|stop|restart|status)
    systemctl --user "$ACTION" heimdal-dev
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status}" >&2
    exit 1
    ;;
esac
