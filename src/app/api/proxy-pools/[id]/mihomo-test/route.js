import { NextResponse } from "next/server";
import http from "node:http";
import { getProxyPoolById, updateProxyPool, getProxyPools } from "@/models";
import {
  buildConfig,
  writeConfig,
  reload,
  normaliseProxy,
} from "@/lib/mihomo";
import { isEnabled as isWarpEnabled, getActiveConfig as getWarpConfig } from "@/lib/warp";
import { probeGeoViaListener } from "@/lib/geo";

const TEST_PORT = 29999;
const RELOAD_SETTLE_MS = 600;

function probe204(port, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    const finish = (r) => { if (settled) return; settled = true; try { req.destroy(); } catch {} resolve(r); };
    const req = http.request({
      host: "127.0.0.1",
      port,
      method: "GET",
      path: "http://www.gstatic.com/generate_204",
      headers: { Host: "www.gstatic.com", Connection: "close" },
      timeout: timeoutMs,
    }, (res) => {
      res.resume();
      finish({ ok: res.statusCode === 204 || res.statusCode === 200, status: res.statusCode, latency: Date.now() - startedAt });
    });
    req.on("error", (err) => finish({ ok: false, latency: Date.now() - startedAt, error: err.code || err.message }));
    req.on("timeout", () => finish({ ok: false, latency: Date.now() - startedAt, error: "timeout" }));
    req.end();
  });
}

async function bindAndProbe(pool, viaWarp) {
  const allPools = await getProxyPools({ isActive: true });
  const normalised = allPools.map((p) => normaliseProxy(p)).filter(Boolean);
  const warpEnabled = (() => { try { return isWarpEnabled(); } catch { return false; } })();
  const warp = (warpEnabled || viaWarp) ? (() => { try { return getWarpConfig(); } catch { return null; } })() : null;

  const targetName = (viaWarp && warp) ? `${pool.name}__warp` : pool.name;
  const listeners = [{ port: TEST_PORT, proxy: targetName }];

  const { yaml } = buildConfig({
    proxies: normalised,
    warp,
    warpEnabled: viaWarp || warpEnabled,
    topListeners: listeners,
    testUrl: "http://www.gstatic.com/generate_204",
  });
  writeConfig(yaml);
  await reload();
  await new Promise((r) => setTimeout(r, RELOAD_SETTLE_MS));

  const reachability = await probe204(TEST_PORT);
  let geo = null;
  if (reachability.ok) {
    geo = await probeGeoViaListener(TEST_PORT, { timeoutMs: 6000 });
  }
  return { reachability, geo };
}

export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const pool = await getProxyPoolById(id);
    if (!pool) return NextResponse.json({ error: "Pool not found" }, { status: 404 });
    if (!normaliseProxy(pool)) {
      return NextResponse.json({
        error: "Pool has neither clashProxy nor proxyUrl — cannot test",
      }, { status: 400 });
    }

    const body = await request.json().catch(() => ({}));
    const viaWarp = !!body?.viaWarp;

    const { reachability, geo } = await bindAndProbe(pool, viaWarp);

    const cachedLatency = reachability.ok ? reachability.latency : -1;
    const updates = { cachedLatency };
    if (!viaWarp) {
      // Only persist non-WARP measurements as the canonical row state
      if (geo?.ip) updates.exitIp = geo.ip;
      if (geo?.country) updates.country = geo.country;
      updates.testStatus = reachability.ok ? "active" : "error";
      updates.lastTestedAt = new Date().toISOString();
      updates.lastError = reachability.ok ? null : (reachability.error || "unreachable");
    }
    await updateProxyPool(id, updates);

    return NextResponse.json({
      ok: reachability.ok,
      latency: cachedLatency,
      name: pool.name,
      viaWarp,
      exitIp: geo?.ip || null,
      country: geo?.country || null,
      city: geo?.city || null,
      org: geo?.org || null,
      geoSource: geo?.url || null,
      status: reachability.ok ? "ok" : (reachability.error || "down"),
    });
  } catch (error) {
    console.error("[proxy-pools/:id/mihomo-test] error:", error);
    return NextResponse.json({ error: error.message || "Test failed" }, { status: 500 });
  }
}
