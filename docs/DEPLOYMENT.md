# Deploying 9Router-plus

Recipe for bringing up a fresh 9Router-plus stack. Assumes Ubuntu/Debian
with sudo access.

## 1. Prerequisites

- Docker 20+ (`apt-get install docker.io`)
- git
- ≥10 GB free disk for the build (the multi-stage image is ~1.1 GB; the
  builder cache and base layers together need 5–6 GB transiently).
- Tailscale on the **host** if you want any feature that connects to a
  tailnet 100.x address (neighbour proxy probe, peer-to-peer Squid pool,
  etc.). See §3 for why.

## 2. Build & run

```bash
git clone https://github.com/linuxgarry/9Router-plus.git /opt/9Router-plus
cd /opt/9Router-plus

docker build -t 9router-plus:latest .

docker rm -f 9router 2>/dev/null
docker run -d --name 9router --restart unless-stopped \
  -p 80:80 -p 443:443 -p 7890:7890 -p 20128:20128 \
  -v /var/lib/9router:/app/data \
  9router-plus:latest
```

Dashboard: http://<host>:20128 (redirects to /login).

To upgrade later:

```bash
cd /opt/9Router-plus
git pull
docker build -t 9router-plus:latest .
docker rm -f 9router && docker run -d --name 9router --restart unless-stopped \
  -p 80:80 -p 443:443 -p 7890:7890 -p 20128:20128 \
  -v /var/lib/9router:/app/data \
  9router-plus:latest
```

## 3. Tailscale on the host (required for tailnet features)

The container runs `tailscaled` in `--tun=userspace-networking` mode
(no kernel TUN, no `NET_ADMIN` capability). That mode lets the
neighbour-probe card read the tailnet status, but **the application
process inside the container cannot directly connect to peer 100.x
addresses through it** — userspace networking only intercepts traffic
that tailscaled itself dials.

If the host runs native tailscale, Docker's bridge SNAT lets the
container's outbound traffic ride the host's `tailscale0` interface
transparently. That's what makes the neighbour Squid probes succeed.

```bash
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --hostname=<your-vps-host>
# Visit the AuthURL printed in the terminal and approve in the admin console.
```

After login, verify from inside the container:

```bash
docker exec 9router nc -zv -w 5 <peer-100-ip> <port>
```

## 4. Migrating data between hosts

`/var/lib/9router` is the single source of truth: SQLite db, jwt-secret,
caddy state, mihomo config, tailscale daemon state.

To clone a deployment:

```bash
# on source host
docker stop 9router
tar czf - -C /var/lib 9router > /tmp/9r.tgz

# transfer /tmp/9r.tgz to the new host

# on target host
mkdir -p /var/lib
tar xzf /tmp/9r.tgz -C /var/lib

# IMPORTANT: see §4.1 below before starting the new container
docker start 9router  # or the docker run command from §2
```

### 4.1 Reset the cloned tailscale state

`/var/lib/9router/tailscale/tailscaled.state` carries a wireguard
identity. If the same state file is in use by two running tailscaled
processes, Tailscale flags one of them as **"Duplicate node key"** and
silently breaks routing for that node — peer-to-peer connections will
appear up in `tailscale status` but `nc 100.x.x.x <port>` will time
out.

After cloning the data dir, wipe the daemon state on the **target**
host before starting the container:

```bash
rm -f /var/lib/9router/tailscale/tailscaled.state \
      /var/lib/9router/tailscale/tailscaled.sock \
      /var/lib/9router/tailscale/derpmap.cached.json
rm -rf /var/lib/9router/tailscale/files

docker start 9router
# Then click "Authorize Tailscale" in the dashboard, or run:
docker exec -d 9router /usr/local/bin/tailscale \
  --socket /app/data/tailscale/tailscaled.sock up --hostname=<unique-name>
docker exec 9router /usr/local/bin/tailscale \
  --socket /app/data/tailscale/tailscaled.sock status --json | grep AuthURL
```

The container picks up a fresh wireguard key and joins the tailnet as a
new node.

## 5. Switching the bound Tailscale account

The neighbour-probe card has a **Switch account** button next to the
logged-in indicator. It calls `/api/tailscale/logout` (which runs
`tailscale logout` against the daemon) and then immediately starts a
fresh login flow so you land on the auth page for the new identity.

Equivalent CLI:

```bash
docker exec 9router /usr/local/bin/tailscale \
  --socket /app/data/tailscale/tailscaled.sock logout
docker exec -d 9router /usr/local/bin/tailscale \
  --socket /app/data/tailscale/tailscaled.sock up --accept-routes
```

## 6. Port reference

| Port  | Purpose                                    |
| ----- | ------------------------------------------ |
| 80    | Caddy reverse proxy (optional)             |
| 443   | Caddy TLS (optional, requires cert)        |
| 7890  | Mihomo HTTP proxy                          |
| 20128 | Next.js dashboard                          |

If 80/443 conflict with an existing nginx, stop nginx first
(`systemctl disable --now nginx`) — the bundled caddy expects to own
those ports.
