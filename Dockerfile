FROM alpine:latest

RUN apk add --no-cache caddy

COPY web/ /srv/heimdal/
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 80 443

ENTRYPOINT ["/docker-entrypoint.sh"]
