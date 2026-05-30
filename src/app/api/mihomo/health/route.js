import { NextResponse } from "next/server";
import path from "node:path";
import fs from "node:fs";
import { DATA_DIR } from "@/lib/dataDir.js";
import { MIHOMO_API, getOrCreateSecret, readTopFixed } from "@/lib/mihomo";

const MIHOMO_CONFIG = path.join(DATA_DIR, "mihomo", "config.yaml");

export async function GET() {
  const startedAt = Date.now();
  const secret = (() => {
    try { return getOrCreateSecret(); } catch { return ""; }
  })();

  let alive = false;
  let version = null;
  let listenersCount = 0;
  let proxiesCount = 0;
  let error = null;

  try {
    const r1 = await fetch(`${MIHOMO_API}/version`, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(2500),
    });
    if (r1.ok) {
      alive = true;
      const v = await r1.json().catch(() => ({}));
      version = v.version || null;
    } else {
      error = `HTTP ${r1.status}`;
    }
  } catch (err) {
    error = err.message || "unreachable";
  }

  if (alive) {
    try {
      const r2 = await fetch(`${MIHOMO_API}/proxies`, {
        headers: { Authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(2500),
      });
      if (r2.ok) {
        const d = await r2.json().catch(() => ({}));
        proxiesCount = d.proxies ? Object.keys(d.proxies).length : 0;
      }
    } catch {}
  }

  try {
    listenersCount = readTopFixed().length;
  } catch {}

  let configMtime = null;
  try {
    configMtime = fs.statSync(MIHOMO_CONFIG).mtime.toISOString();
  } catch {}

  return NextResponse.json({
    alive,
    version,
    proxiesCount,
    topListenersCount: listenersCount,
    configMtime,
    error,
    elapsedMs: Date.now() - startedAt,
  });
}
