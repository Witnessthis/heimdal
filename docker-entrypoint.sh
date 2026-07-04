#!/bin/sh
set -e

if [ -n "$DOMAIN" ]; then
  cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
    reverse_proxy localhost:3000
    encode gzip
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

# Start the Node backend
node /app/dist/server.js &

# Wait for the backend to be ready before starting Caddy
until nc -z 127.0.0.1 3000 2>/dev/null; do
  sleep 0.1
done

exec caddy run --config /etc/caddy/Caddyfile
