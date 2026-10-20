/**
 * WARP (Cloudflare WireGuard) integration via wgcf.
 *
 *  /app/data/warp/
 *    enabled         "1" or absent
 *    account.toml    wgcf account file (created by `wgcf register`)
 *    wgcf-profile.conf  WireGuard config (created by `wgcf generate`)
 *    settings.json   { mode: 'auto' | 'custom', customConfig: '...' }
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DATA_DIR } from "@/lib/dataDir.js";

export const WARP_DIR = path.join(DATA_DIR, "warp");
const ENABLED_FILE = path.join(WARP_DIR, "enabled");
const ACCOUNT_FILE = path.join(WARP_DIR, "wgcf-account.toml");
const PROFILE_FILE = path.join(WARP_DIR, "wgcf-profile.conf");
const SETTINGS_FILE = path.join(WARP_DIR, "settings.json");

function ensureDir() {
  if (!fs.existsSync(WARP_DIR)) fs.mkdirSync(WARP_DIR, { recursive: true });
}

export function isEnabled() {
  return fs.existsSync(ENABLED_FILE);
}

export function setEnabled(on) {
  ensureDir();
  if (on) fs.writeFileSync(ENABLED_FILE, "1");
  else if (fs.existsSync(ENABLED_FILE)) fs.unlinkSync(ENABLED_FILE);
}

export function getSettings() {
  if (!fs.existsSync(SETTINGS_FILE)) return { mode: "auto", customConfig: "" };
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
  } catch {
    return { mode: "auto", customConfig: "" };
  }
}

export function setSettings(s) {
  ensureDir();
  const cur = getSettings();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ...cur, ...s }, null, 2));
}

/**
 * Run wgcf register/generate inside container to create a free WARP account.
 * Idempotent — skip if account.toml already exists.
 */
export async function autoRegister() {
  ensureDir();
  if (fs.existsSync(PROFILE_FILE)) return { ok: true, skipped: true };

  try {
    if (!fs.existsSync(ACCOUNT_FILE)) {
      execFileSync("/usr/local/bin/wgcf", ["register", "--accept-tos", "--config", ACCOUNT_FILE], {
        cwd: WARP_DIR,
        timeout: 30000,
      });
    }
    execFileSync("/usr/local/bin/wgcf", ["generate", "--config", ACCOUNT_FILE, "--profile", PROFILE_FILE], {
      cwd: WARP_DIR,
      timeout: 15000,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Parse a [Interface]/[Peer] WireGuard config into mihomo-compatible fields.
 */
export function parseWgConfig(text) {
  const out = {
    privateKey: null,
    publicKey: null,
    address: { v4: null, v6: null },
    server: null,
    port: 2408,
    reserved: null,
  };

  const sections = text.split(/^\s*\[(\w+)\]\s*$/m);
  let cur = null;
  for (let i = 0; i < sections.length; i++) {
    const part = sections[i];
    if (i % 2 === 1) {
      cur = part.toLowerCase();
      continue;
    }
    if (!cur) continue;
    const lines = part.split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*([\w-]+)\s*=\s*(.+?)\s*$/);
      if (!m) continue;
      const k = m[1].toLowerCase();
      const v = m[2];

      if (cur === "interface") {
        if (k === "privatekey") out.privateKey = v;
        if (k === "address") {
          // 172.16.0.2/32, 2606:4700::/128
          for (const a of v.split(",").map((x) => x.trim())) {
            const ip = a.split("/")[0];
            if (ip.includes(":")) out.address.v6 = ip;
            else out.address.v4 = ip;
          }
        }
      } else if (cur === "peer") {
        if (k === "publickey") out.publicKey = v;
        if (k === "endpoint") {
          const parts = v.split(":");
          out.port = parseInt(parts.pop(), 10) || 2408;
          out.server = parts.join(":").replace(/^\[|\]$/g, "");
        }
      }
    }
  }
  return out;
}

// Cloudflare WARP edge IPs. Anycast routes a wireguard handshake from
// the same source to the same PoP, which is why every account ends up
// with the same exit when they all use engage.cloudflareclient.com.
// Pinning a different IP per account spreads handshakes across PoPs.
//
// Range pulled from cf-warp tooling (162.159.192-195/24, 188.114.96-99).
// Generated programmatically — full /24 sweep is overkill, sample one
// per /28 to stay below ~256 entries.
export const WARP_IPV4_ENDPOINTS = (() => {
  const out = [];
  // 162.159.192.0/24 → 192.193.194.195
  for (const c of [192, 193, 194, 195]) {
    for (let d = 0; d < 256; d += 16) {
      out.push(`162.159.${c}.${d === 0 ? 1 : d}`);
    }
  }
  // 188.114.96.0/22 → 96.97.98.99
  for (const c of [96, 97, 98, 99]) {
    for (let d = 0; d < 256; d += 16) {
      out.push(`188.114.${c}.${d === 0 ? 1 : d}`);
    }
  }
  return out;
})();

export function pickRandomEndpoint() {
  return WARP_IPV4_ENDPOINTS[Math.floor(Math.random() * WARP_IPV4_ENDPOINTS.length)];
}

/**
 * Get the active WARP config (auto-generated or custom).
 * Returns null if WARP not configured.
 *
 * If settings.routeTuning === true, replace the WARP endpoint with a
 * random IPv4 candidate to bypass anycast routing that gets dropped on
 * some Chinese cloud providers (Tencent/Alibaba/Huawei).
 */
export function getActiveConfig() {
  const settings = getSettings();
  let cfg;
  if (settings.mode === "custom" && settings.customConfig) {
    cfg = parseWgConfig(settings.customConfig);
  } else if (fs.existsSync(PROFILE_FILE)) {
    cfg = parseWgConfig(fs.readFileSync(PROFILE_FILE, "utf-8"));
  } else {
    return null;
  }

  if (cfg && settings.routeTuning) {
    const pick = WARP_IPV4_ENDPOINTS[Math.floor(Math.random() * WARP_IPV4_ENDPOINTS.length)];
    cfg.server = pick;
  }

  return cfg;
}

export function getStatus() {
  return {
    enabled: isEnabled(),
    settings: getSettings(),
    hasAutoAccount: fs.existsSync(ACCOUNT_FILE),
    hasProfile: fs.existsSync(PROFILE_FILE),
  };
}
