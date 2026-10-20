#!/bin/sh
set -e

chown -R node:node /app/data /app/data-home 2>/dev/null || true
mkdir -p /app/data/mihomo /app/data/tailscale /app/data/caddy/data /app/data/caddy/config
chown -R node:node /app/data/mihomo /app/data/tailscale /app/data/caddy

SECRET_FILE=/app/data/mihomo/.secret
CONFIG_FILE=/app/data/mihomo/config.yaml

if [ ! -f "$SECRET_FILE" ]; then
  node -e "console.log(require('crypto').randomBytes(16).toString('hex'))" > "$SECRET_FILE"
  chown node:node "$SECRET_FILE"
fi

if [ ! -f "$CONFIG_FILE" ]; then
  SECRET=$(cat "$SECRET_FILE")
  cat > "$CONFIG_FILE" <<YAML
mixed-port: 7890
external-controller: 0.0.0.0:9090
secret: $SECRET
allow-lan: true
mode: global
log-level: warning
global-client-fingerprint: chrome
proxies: []
proxy-groups:
  - name: GLOBAL
    type: select
    proxies:
      - DIRECT
listeners: []
YAML
  chown node:node "$CONFIG_FILE"
fi

exec su-exec node /usr/bin/supervisord -c /etc/supervisor/conf.d/9router.conf
