# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE} AS base
WORKDIR /app

FROM base AS builder

RUN apk --no-cache upgrade && apk --no-cache add python3 make g++ linux-headers

COPY package.json ./
RUN npm install

COPY . ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM ${NODE_IMAGE} AS runner
WORKDIR /app

LABEL org.opencontainers.image.title="9router-pro"

ENV NODE_ENV=production
ENV PORT=20128
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATA_DIR=/app/data

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/open-sse ./open-sse
# Next file tracing can omit sibling files; MITM runs server.js as a separate process.
COPY --from=builder /app/src/mitm ./src/mitm
# Standalone node_modules may omit deps only required by the MITM child process.
COPY --from=builder /app/node_modules/node-forge ./node_modules/node-forge
# Ensure `next` is available at runtime in case tracing did not include it.
COPY --from=builder /app/node_modules/next ./node_modules/next

# Download mihomo, wgcf, tailscale, and caddy binaries
RUN apk --no-cache add curl iptables iproute2 ca-certificates && \
  mkdir -p /usr/local/bin && \
  curl -sL https://github.com/MetaCubeX/mihomo/releases/download/v1.18.8/mihomo-linux-amd64-v1.18.8.gz -o /tmp/mihomo.gz && \
  gunzip /tmp/mihomo.gz && mv /tmp/mihomo /usr/local/bin/mihomo && chmod +x /usr/local/bin/mihomo && \
  curl -sL https://github.com/ViRb3/wgcf/releases/download/v2.2.19/wgcf_2.2.19_linux_amd64 -o /usr/local/bin/wgcf && chmod +x /usr/local/bin/wgcf && \
  curl -sL https://pkgs.tailscale.com/stable/tailscale_1.78.1_amd64.tgz -o /tmp/tailscale.tgz && \
  tar -xzf /tmp/tailscale.tgz -C /tmp && \
  mv /tmp/tailscale_*/tailscale /usr/local/bin/tailscale && \
  mv /tmp/tailscale_*/tailscaled /usr/local/bin/tailscaled && \
  chmod +x /usr/local/bin/tailscale /usr/local/bin/tailscaled && \
  curl -sL https://github.com/caddyserver/caddy/releases/download/v2.8.4/caddy_2.8.4_linux_amd64.tar.gz -o /tmp/caddy.tgz && \
  tar -xzf /tmp/caddy.tgz -C /tmp caddy && \
  mv /tmp/caddy /usr/local/bin/caddy && chmod +x /usr/local/bin/caddy && \
  rm -rf /tmp/* && apk del curl

RUN mkdir -p /app/data && chown -R node:node /app && \
  mkdir -p /app/data-home && chown node:node /app/data-home && \
  ln -sf /app/data-home /root/.9router 2>/dev/null || true

# Install supervisor for process management
RUN apk --no-cache add supervisor

# Copy supervisor config (manages 9router + mihomo + tailscaled)
RUN mkdir -p /etc/supervisor/conf.d
COPY docker/supervisor.conf /etc/supervisor/conf.d/9router.conf

# Fix permissions + seed mihomo config so external-controller (9090) is up before any subscription
RUN apk --no-cache upgrade && apk --no-cache add su-exec
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 20128 7890 10001-10050

ENTRYPOINT ["/entrypoint.sh"]
