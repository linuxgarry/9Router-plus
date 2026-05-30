/**
 * Multi-WARP account manager.
 *
 *   /app/data/warp/accounts/
 *     <id>/wgcf-account.toml
 *     <id>/wgcf-profile.conf
 *     <id>/meta.json   { id, name, createdAt }
 *
 * Each account uses an independent wgcf registration → different keypair
 * → different Cloudflare edge handshake → potentially different exit IP.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { DATA_DIR } from "@/lib/dataDir.js";
import { parseWgConfig, WARP_IPV4_ENDPOINTS, pickRandomEndpoint } from "@/lib/warp";
import {
  createProxyPool,
  getProxyPools,
  deleteProxyPool,
  updateProxyPool,
} from "@/models";

const ACCOUNTS_DIR = path.join(DATA_DIR, "warp", "accounts");

function ensureDir() {
  if (!fs.existsSync(ACCOUNTS_DIR)) fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
}

function accountPath(id) {
  return path.join(ACCOUNTS_DIR, id);
}

export async function listAccounts() {
  ensureDir();
  const entries = fs.readdirSync(ACCOUNTS_DIR, { withFileTypes: true });
  const accounts = [];

  // map pool data by warpAccountId so we can surface latency/exitIp/country
  let poolMap = new Map();
  try {
    const pools = await getProxyPools();
    for (const p of pools) {
      if (p.warpAccountId) poolMap.set(p.warpAccountId, p);
    }
  } catch {}

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = accountPath(e.name);
    const metaFile = path.join(dir, "meta.json");
    const profileFile = path.join(dir, "wgcf-profile.conf");
    if (!fs.existsSync(metaFile) || !fs.existsSync(profileFile)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, "utf-8"));
      const cfg = parseWgConfig(fs.readFileSync(profileFile, "utf-8"));
      const pool = poolMap.get(meta.id);
      const endpointHost = meta.endpoint || cfg.server || "engage.cloudflareclient.com";
      accounts.push({
        ...meta,
        endpoint: `${endpointHost}:${cfg.port || 2408}`,
        endpointHost,
        ipv4: cfg.address?.v4 || null,
        cachedLatency: pool?.cachedLatency ?? null,
        exitIp: pool?.exitIp ?? null,
        country: pool?.country ?? null,
        isActive: pool?.isActive ?? null,
      });
    } catch {}
  }
  accounts.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
  return accounts;
}

export function getAccountConfig(id, { pinIpv4 = false } = {}) {
  const dir = accountPath(id);
  const profile = path.join(dir, "wgcf-profile.conf");
  if (!fs.existsSync(profile)) return null;
  const cfg = parseWgConfig(fs.readFileSync(profile, "utf-8"));
  if (cfg && pinIpv4) {
    cfg.server = WARP_IPV4_ENDPOINTS[Math.floor(Math.random() * WARP_IPV4_ENDPOINTS.length)];
  }
  return cfg;
}

export function getAccount(id) {
  const dir = accountPath(id);
  const metaFile = path.join(dir, "meta.json");
  if (!fs.existsSync(metaFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaFile, "utf-8"));
  } catch {
    return null;
  }
}

export async function registerAccount({ name }) {
  ensureDir();
  const id = crypto.randomBytes(6).toString("hex");
  const dir = accountPath(id);
  fs.mkdirSync(dir, { recursive: true });

  const accountFile = path.join(dir, "wgcf-account.toml");
  const profileFile = path.join(dir, "wgcf-profile.conf");

  try {
    execFileSync(
      "/usr/local/bin/wgcf",
      ["register", "--accept-tos", "--config", accountFile],
      { cwd: dir, timeout: 30000 }
    );
    execFileSync(
      "/usr/local/bin/wgcf",
      ["generate", "--config", accountFile, "--profile", profileFile],
      { cwd: dir, timeout: 15000 }
    );
  } catch (err) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    throw new Error(`wgcf register failed: ${err.message}`);
  }

  const meta = {
    id,
    name: (name || "").trim() || `WARP-${id.slice(0, 4)}`,
    createdAt: new Date().toISOString(),
    // Pin a per-account anycast endpoint so each account gets a
    // different PoP / exit IP. Stored in meta so it survives a rebuild
    // and stays consistent across config regenerations.
    endpoint: pickRandomEndpoint(),
  };
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));

  // Sync into ProxyPool so it shows up in pools list, can be tested,
  // bound to ports, assigned to connections, etc.
  const cfg = parseWgConfig(fs.readFileSync(profileFile, "utf-8"));
  const poolId = `warp-${id}`;
  await createProxyPool({
    id: poolId,
    name: `WARP/${meta.name}`,
    type: "wireguard",
    source: "warp",
    isActive: true,
    clashProxy: {
      name: `WARP/${meta.name}`,
      type: "wireguard",
      "private-key": cfg.privateKey,
      "public-key": cfg.publicKey,
      // Use the pinned IPv4 endpoint instead of the anycast hostname.
      // Different IP → different Cloudflare PoP → different exit IP,
      // which is the entire point of having multiple WARP rows.
      server: meta.endpoint || cfg.server || "engage.cloudflareclient.com",
      port: cfg.port || 2408,
      ip: cfg.address?.v4 || "172.16.0.2",
      mtu: 1280,
      udp: true,
    },
    warpAccountId: id,
  });

  return { ...meta, poolId };
}

// Import a user-pasted WireGuard config and turn it into a WARP-style
// account row. Skips wgcf entirely. The "name" is shown in the proxy
// pool list; if omitted we synthesise WG-<id-prefix>. Endpoint is
// preserved as-is from the [Peer] block — caller chose it.
export async function importWgConfig({ name, config }) {
  ensureDir();
  if (!config || typeof config !== "string") {
    throw new Error("config text required");
  }
  const cfg = parseWgConfig(config);
  if (!cfg.privateKey || !cfg.publicKey || !cfg.server) {
    throw new Error("Could not parse [Interface] private-key + [Peer] public-key/Endpoint");
  }

  const id = crypto.randomBytes(6).toString("hex");
  const dir = accountPath(id);
  fs.mkdirSync(dir, { recursive: true });
  const profileFile = path.join(dir, "wgcf-profile.conf");
  fs.writeFileSync(profileFile, config);

  const meta = {
    id,
    name: (name || "").trim() || `WG-${id.slice(0, 4)}`,
    createdAt: new Date().toISOString(),
    endpoint: cfg.server,
    source: "manual",
  };
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));

  const poolId = `warp-${id}`;
  await createProxyPool({
    id: poolId,
    name: `WARP/${meta.name}`,
    type: "wireguard",
    source: "warp",
    isActive: true,
    clashProxy: {
      name: `WARP/${meta.name}`,
      type: "wireguard",
      "private-key": cfg.privateKey,
      "public-key": cfg.publicKey,
      server: cfg.server,
      port: cfg.port || 2408,
      ip: cfg.address?.v4 || "172.16.0.2",
      mtu: 1280,
      udp: true,
    },
    warpAccountId: id,
  });

  return { ...meta, poolId };
}

export async function updateAccountGeo(id, { latency, exitIp, country }) {
  const poolId = `warp-${id}`;
  const updates = {};
  if (typeof latency === "number") updates.cachedLatency = latency;
  if (exitIp) updates.exitIp = exitIp;
  if (country) updates.country = country;
  if (Object.keys(updates).length > 0) {
    await updateProxyPool(poolId, updates);
  }
}

// Re-randomise the per-account endpoint so an existing account can land
// on a different Cloudflare PoP without being deleted+re-registered.
// Updates meta.json, the linked ProxyPool's clashProxy.server, and
// clears the cached latency / exit IP since they refer to the old PoP.
export async function rerollEndpoint(id) {
  const acc = getAccount(id);
  if (!acc) return null;
  const dir = accountPath(id);
  const meta = { ...acc, endpoint: pickRandomEndpoint() };
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));

  const poolId = `warp-${id}`;
  try {
    const pools = await getProxyPools();
    const pool = pools.find((p) => p.id === poolId);
    if (pool) {
      const clashProxy = { ...(pool.clashProxy || {}), server: meta.endpoint };
      await updateProxyPool(poolId, {
        clashProxy,
        cachedLatency: null,
        exitIp: null,
      });
    }
  } catch {}

  return meta;
}

export async function deleteAccount(id) {
  const acc = getAccount(id);
  if (!acc) return false;

  // remove ProxyPool row first
  try {
    const pools = await getProxyPools();
    const linked = pools.filter((p) => p.warpAccountId === id || p.id === `warp-${id}`);
    for (const p of linked) {
      try { await deleteProxyPool(p.id); } catch {}
    }
  } catch {}

  try { fs.rmSync(accountPath(id), { recursive: true, force: true }); } catch {}
  return true;
}
