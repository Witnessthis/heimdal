#!/bin/sh
set -e

if [ -n "$DOMAIN" ]; then
  cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
    reverse_proxy localhost:3000
    encode gzip
    header Strict-Transport-Security "max-age=31536000"
}
EOF
else
  cat > /etc/caddy/Caddyfile <<EOF
:80 {
    reverse_proxy localhost:3000
    encode gzip
}
EOF
fi

# /app/data (bind-mounted from the host) and the caddy-data volume
# (Caddy's cert/account storage — see docker-compose.yml) both get their
# ownership from outside this image, so it can't be fixed up at build
# time — do it here, every start, before dropping to the non-root user
# below. Idempotent and cheap either way. Without this, a freshly
# created caddy-data volume is root-owned and Caddy (running as heimdal
# below) can't write its certificate into it. Not $HOME — this script
# still runs as root at this point, so that would resolve to /root.
CADDY_DATA_DIR=/home/heimdal/.local/share/caddy
mkdir -p /app/data "$CADDY_DATA_DIR"
chown -R heimdal:heimdal /app/data /etc/caddy "$CADDY_DATA_DIR"

# This container starts as root only for the setup above. Everything
# that actually talks to the network or reads a decrypted secret runs as
# the unprivileged heimdal user from here on — caddy can still bind
# 80/443 despite that via the cap_net_bind_service file capability set
# on its binary at build time (see Dockerfile).
exec su-exec heimdal:heimdal sh -e -c '
  node /app/dist/server.js &

  until nc -z 127.0.0.1 3000 2>/dev/null; do
    sleep 0.1
  done

  exec caddy run --config /etc/caddy/Caddyfile
'
