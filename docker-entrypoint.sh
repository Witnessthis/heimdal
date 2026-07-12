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

# /app/data is a bind-mounted volume (see docker-compose.yml) whose
# ownership comes from the host, not this image, so it can't be fixed up
# at build time — do it here, every start, before dropping to the
# non-root user below. Idempotent and cheap either way.
mkdir -p /app/data
chown -R heimdal:heimdal /app/data /etc/caddy

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
