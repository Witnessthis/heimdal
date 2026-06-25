#!/bin/sh
set -e

if [ -n "$DOMAIN" ]; then
  cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
    root * /srv/heimdal
    file_server
    encode gzip
}
EOF
else
  cat > /etc/caddy/Caddyfile <<EOF
:80 {
    root * /srv/heimdal
    file_server
    encode gzip
}
EOF
fi

exec caddy run --config /etc/caddy/Caddyfile
