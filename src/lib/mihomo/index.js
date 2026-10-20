/**
 * Mihomo (Clash.Meta) 配置生成 + external-controller 客户端
 *
 * 数据流:
 *   订阅 yaml / CSV proxy / 单条 → ProxyPool DB → buildConfig() → /app/data/mihomo/config.yaml
 *   POST /configs?force=true → mihomo 热加载
 *
 * Top 50 监听端口 10001-10050,每端口绑定一个具体节点(mihomo listeners)
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "@/lib/dataDir.js";

export const MIHOMO_DIR = path.join(DATA_DIR, "mihomo");
export const MIHOMO_CONFIG = path.join(MIHOMO_DIR, "config.yaml");
export const MIHOMO_API = "http://127.0.0.1:9090";

const SECRET_FILE = path.join(MIHOMO_DIR, ".secret");
const TOP_FIXED_FILE = path.join(MIHOMO_DIR, "top-fixed.json");

export const TOP_PORT_BASE = 10001;
export const TOP_PORT_COUNT = 50;

export function ensureMihomoDir() {
  if (!fs.existsSync(MIHOMO_DIR)) fs.mkdirSync(MIHOMO_DIR, { recursive: true });
}

export function getOrCreateSecret() {
  ensureMihomoDir();
  if (fs.existsSync(SECRET_FILE)) {
    return fs.readFileSync(SECRET_FILE, "utf-8").trim();
  }
  const secret = crypto.randomBytes(16).toString("hex");
  fs.writeFileSync(SECRET_FILE, secret);
  return secret;
}

/* ---------- YAML serialiser (no extra deps) ---------- */
function yamlStringify(v, indent = 0) {
  const pad = "  ".repeat(indent);
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  if (typeof v === "string") {
    if (v === "" || /[:#\-?{}\[\],&*!|>'"%@`\s]|^(true|false|null|yes|no)$/i.test(v) || /^\d/.test(v)) {
      return JSON.stringify(v);
    }
    return v;
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    return "\n" + v.map((it) => `${pad}- ${yamlInline(it, indent + 1)}`).join("\n");
  }
  if (typeof v === "object") {
    const keys = Object.keys(v);
    if (keys.length === 0) return "{}";
    return "\n" + keys.map((k) => {
      const val = v[k];
      const rendered = yamlStringify(val, indent + 1);
      if (rendered.startsWith("\n")) return `${pad}${k}:${rendered}`;
      return `${pad}${k}: ${rendered}`;
    }).join("\n");
  }
  return JSON.stringify(v);
}

function yamlInline(v, indent) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  if (typeof v === "string") return yamlStringify(v);
  if (Array.isArray(v)) {
    return "[" + v.map((it) => yamlInline(it, indent)).join(", ") + "]";
  }
  if (typeof v === "object") {
    const inner = yamlStringify(v, indent);
    if (inner.startsWith("\n")) return inner;
    return inner;
  }
  return JSON.stringify(v);
}

/* ---------- proxy normalisation ---------- */

/**
 * 把 ProxyPool 表里的一行(可能是 mihomo dict / 也可能只是 http://… url)规整成 mihomo proxy
 * Returns null when not a clash-style protocol.
 */
// mihomo v1.18.8 supported proxy types. Filtering keeps unsupported
// types (anytls, hysteria3-future, etc.) out of buildConfig() — otherwise
// a single bad row makes mihomo refuse to load the whole config and fall
// back to its bootstrap default.
const MIHOMO_SUPPORTED_PROXY_TYPES = new Set([
  "ss", "shadowsocks",
  "ssr", "shadowsocksr",
  "vmess", "vless", "trojan",
  "http", "socks5",
  "snell",
  "wireguard", "wg",
  "hysteria", "hysteria2",
  "tuic",
  "ssh",
  "mieru",
]);

export function normaliseProxy(pool) {
  // Clash subscription / CSV import 落库时已经把 raw mihomo dict 存进 pool.clashProxy
  if (pool.clashProxy && typeof pool.clashProxy === "object") {
    const t = (pool.clashProxy.type || "").toLowerCase();
    if (t && !MIHOMO_SUPPORTED_PROXY_TYPES.has(t)) return null;
    return { ...pool.clashProxy, name: pool.name };
  }
  // Plain http/https/socks5 URL → 转 mihomo http/socks 节点
  const url = (pool.proxyUrl || "").trim();
  if (!url) return null;
  try {
    const u = new URL(url);
    const proto = u.protocol.replace(":", "");
    if (proto === "http" || proto === "https") {
      const out = {
        name: pool.name,
        type: "http",
        server: u.hostname,
        port: parseInt(u.port || (proto === "https" ? "443" : "80"), 10),
      };
      if (u.username) out.username = decodeURIComponent(u.username);
      if (u.password) out.password = decodeURIComponent(u.password);
      if (proto === "https") out.tls = true;
      return out;
    }
    if (proto === "socks5" || proto === "socks") {
      const out = {
        name: pool.name,
        type: "socks5",
        server: u.hostname,
        port: parseInt(u.port || "1080", 10),
      };
      if (u.username) out.username = decodeURIComponent(u.username);
      if (u.password) out.password = decodeURIComponent(u.password);
      return out;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/* ---------- WARP block ---------- */

/**
 * Build WARP wireguard proxy from /app/data/warp/wg.conf (parsed elsewhere).
 * @param {object} warpCfg { privateKey, publicKey, address, server, port, reserved }
 */
export function buildWarpProxy(warpCfg) {
  if (!warpCfg) return null;
  const proxy = {
    name: "WARP",
    type: "wireguard",
    "private-key": warpCfg.privateKey,
    "public-key": warpCfg.publicKey,
    server: warpCfg.server || "engage.cloudflareclient.com",
    port: warpCfg.port || 2408,
    ip: warpCfg.address?.v4 || "172.16.0.2",
    mtu: 1280,
    udp: true,
  };
  if (warpCfg.address?.v6) proxy.ipv6 = warpCfg.address.v6;
  if (Array.isArray(warpCfg.reserved) && warpCfg.reserved.length > 0) {
    proxy.reserved = warpCfg.reserved;
  }
  return proxy;
}

/* ---------- master config builder ---------- */

/**
 * @param {object} opts
 * @param {Array} opts.proxies     array of mihomo proxy dicts (already normalised)
 * @param {object|null} opts.warp  warp wg config or null
 * @param {boolean} opts.warpEnabled
 * @param {Array<{port:number,proxy:string}>} opts.topListeners
 * @param {string} opts.testUrl
 */
export function buildConfig({ proxies, warp, warpEnabled, topListeners, testUrl }) {
  const secret = getOrCreateSecret();
  const proxyNames = proxies.map((p) => p.name);

  const allProxies = [...proxies];
  if (warp) {
    const w = buildWarpProxy(warp);
    if (w) allProxies.push(w);
  }

  // chain groups: when warpEnabled,每个真实节点都通过 relay → WARP
  const chainGroups = [];
  if (warpEnabled && warp) {
    for (const p of proxies) {
      chainGroups.push({
        name: `${p.name}__warp`,
        type: "relay",
        proxies: [p.name, "WARP"],
      });
    }
  }
  const effectiveNames = warpEnabled && warp
    ? proxyNames.map((n) => `${n}__warp`)
    : proxyNames;

  const groups = [
    ...chainGroups,
    {
      name: "GLOBAL",
      type: "select",
      proxies: ["DIRECT", ...effectiveNames],
    },
  ];

  // listeners: 10001-10050 → top N proxies
  const listeners = (topListeners || []).map(({ port, proxy }, i) => {
    const target = warpEnabled && warp ? `${proxy}__warp` : proxy;
    return {
      name: `top-${i + 1}-${port}`,
      type: "mixed",
      port,
      proxy: target,
      listen: "0.0.0.0",
    };
  });

  const cfg = {
    "mixed-port": 7890,
    "external-controller": "0.0.0.0:9090",
    secret,
    "allow-lan": true,
    mode: "global",
    "log-level": "warning",
    "global-client-fingerprint": "chrome",
    proxies: allProxies,
    "proxy-groups": groups,
    listeners,
  };

  return { yaml: yamlStringify(cfg, 0).trimStart() + "\n", testUrl };
}

export function writeConfig(yaml) {
  ensureMihomoDir();
  fs.writeFileSync(MIHOMO_CONFIG, yaml);
}

/* ---------- external-controller client ---------- */

async function api(pathname, init = {}) {
  const secret = getOrCreateSecret();
  const headers = { Authorization: `Bearer ${secret}`, ...(init.headers || {}) };
  const res = await fetch(`${MIHOMO_API}${pathname}`, { ...init, headers });
  return res;
}

export async function reload() {
  // Force reload from on-disk config.yaml
  const res = await api(`/configs?force=true`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: MIHOMO_CONFIG }),
  });
  return res.ok;
}

export async function isAlive() {
  try {
    const res = await api(`/version`);
    return res.ok;
  } catch {
    return false;
  }
}

export async function delay(name, { url, timeout = 5000 } = {}) {
  const u = `/proxies/${encodeURIComponent(name)}/delay?url=${encodeURIComponent(url)}&timeout=${timeout}`;
  try {
    const res = await api(u);
    if (!res.ok) return { ok: false, delay: -1 };
    const data = await res.json();
    return { ok: true, delay: data.delay ?? -1 };
  } catch {
    return { ok: false, delay: -1 };
  }
}

export async function listProxies() {
  try {
    const res = await api(`/proxies`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/* ---------- top-50 persistence ---------- */

export function readTopFixed() {
  try {
    if (!fs.existsSync(TOP_FIXED_FILE)) return [];
    return JSON.parse(fs.readFileSync(TOP_FIXED_FILE, "utf-8"));
  } catch {
    return [];
  }
}

export function writeTopFixed(list) {
  ensureMihomoDir();
  fs.writeFileSync(TOP_FIXED_FILE, JSON.stringify(list, null, 2));
}
