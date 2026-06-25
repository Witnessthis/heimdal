FROM archlinux:latest

RUN pacman -Syu --noconfirm caddy

COPY web/ /srv/heimdal/
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 80 443

ENTRYPOINT ["/docker-entrypoint.sh"]
