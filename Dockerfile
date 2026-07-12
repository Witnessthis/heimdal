FROM alpine:3.24 AS builder
RUN apk add --no-cache nodejs npm
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY src/ ./src/
COPY web/ ./web/
# Icons are Git-LFS tracked: a checkout without LFS content leaves ~130-byte
# pointer files that would ship broken PWA icons silently — fail fast instead.
RUN test "$(wc -c < web/public/icons/icon-192.png)" -gt 1000
# tsc -> dist/  +  vite build -> dist/web/
RUN npm run build

FROM alpine:3.24
# su-exec: the entrypoint starts as root (needed to fix /app/data's
# ownership — see docker-entrypoint.sh) and drops to the non-root user
# below before running anything else. libcap: setcap below is what lets
# that non-root user still bind ports 80/443, which is normally
# root-only.
RUN apk add --no-cache caddy nodejs npm libcap su-exec && \
    setcap cap_net_bind_service=+ep /usr/sbin/caddy && \
    addgroup -g 1000 heimdal && \
    adduser -D -u 1000 -G heimdal heimdal
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY package*.json ./
RUN npm ci --omit=dev
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh && \
    mkdir -p /etc/caddy && \
    chown -R heimdal:heimdal /app /etc/caddy

EXPOSE 80 443

ENTRYPOINT ["/docker-entrypoint.sh"]
