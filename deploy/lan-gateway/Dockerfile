# Caddy with the Cloudflare DNS module, so it can get a real certificate for
# photos.nomonlab.com via DNS-01 while only being reachable on the LAN.
FROM caddy:2-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/cloudflare

FROM caddy:2
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
