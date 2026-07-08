FROM alpine:latest AS builder
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

FROM alpine:latest
RUN apk add --no-cache caddy nodejs npm
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY package*.json ./
RUN npm ci --omit=dev
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 80 443

ENTRYPOINT ["/docker-entrypoint.sh"]
