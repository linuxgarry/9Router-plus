import { NextResponse } from "next/server";
import { getProviderConnections } from "@/models";
import { probeGeoDirect, probeGeoViaListener, getIpCheckUrls } from "@/lib/geo";
import { getProxyPoolById } from "@/models";
import http from "node:http";
import https from "node:https";

const CLASH_LISTENER = 7890;

async function probeViaProxyUrl(proxyUrl, urls, timeoutMs = 6000) {
  // Use undici via fetch with a proxy agent. node 22+ has ProxyAgent.
  const { ProxyAgent } = await import("undici");
  const dispatcher = new ProxyAgent(proxyUrl);
  for (const checkUrl of urls) {
    try {
      const res = await fetch(checkUrl, {
        dispatcher,
        headers: { "User-Agent": "9router-egress/1.0" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) continue;
      const body = await res.text();
      try {
        const d = JSON.parse(body);
        const ip = d.ip || d.query || d.ipAddress;
        const country = d.country || d.country_code || d.countryCode;
        if (ip) return { ip, country: country || null, city: d.city || null, org: d.org || d.organization || null, url: checkUrl };
      } catch {
        const m = body.trim().match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
        if (m) return { ip: m[1], country: null, city: null, org: null, url: checkUrl };
      }
    } catch {
      continue;
    }
  }
  return null;
}

// Probe egress IP through a Vercel relay (x-relay-target + x-relay-path).
// Each check URL is split into target+path and forwarded by the relay; the
// IP we see is the Vercel data-center node that handled the request, which
// is the value users want to verify.
async function probeViaVercelRelay(relayUrl, urls, timeoutMs = 8000) {
  const { fetch: undiciFetch } = await import("undici");
  for (const checkUrl of urls) {
    try {
      const u = new URL(checkUrl);
      const target = `${u.protocol}//${u.host}`;
      const path = `${u.pathname}${u.search}` || "/";
      const res = await undiciFetch(relayUrl, {
        method: "GET",
        headers: {
          "x-relay-target": target,
          "x-relay-path": path,
          "User-Agent": "9router-egress/1.0",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) continue;
      const body = await res.text();
      try {
        const d = JSON.parse(body);
        // httpbin.org/get returns { origin: "1.2.3.4" }; ipinfo.io/json returns { ip, country, ... }
        const ip = d.ip || d.query || d.ipAddress || d.origin || null;
        const country = d.country || d.country_code || d.countryCode || null;
        if (ip) return { ip, country, city: d.city || null, org: d.org || d.organization || null, url: checkUrl };
      } catch {
        const m = body.trim().match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
        if (m) return { ip: m[1], country: null, city: null, org: null, url: checkUrl };
      }
    } catch {
      continue;
    }
  }
  return null;
}

export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const conns = await getProviderConnections();
    const conn = conns.find((c) => c.id === id);
    if (!conn) return NextResponse.json({ error: "Connection not found" }, { status: 404 });

    const psd = conn.providerSpecificData || {};
    const urls = await getIpCheckUrls();

    let mode = "direct";
    let proxyUrl = null;
    let geo = null;

    if (psd.proxyPoolId) {
      const pool = await getProxyPoolById(psd.proxyPoolId);
      if (pool) {
        // wireguard / clashProxy → goes through main mihomo listener (7890)
        if (pool.clashProxy || pool.type === "wireguard" || pool.source === "warp") {
          mode = "pool-mihomo";
          geo = await probeGeoViaListener(CLASH_LISTENER, { urls, timeoutMs: 6000 });
        } else if (pool.type === "vercel" && pool.proxyUrl) {
          mode = "pool-vercel";
          proxyUrl = pool.proxyUrl;
          geo = await probeViaVercelRelay(proxyUrl, urls);
        } else if (pool.proxyUrl) {
          mode = "pool-http";
          proxyUrl = pool.proxyUrl;
          geo = await probeViaProxyUrl(proxyUrl, urls);
        }
      }
    } else if (psd.connectionProxyEnabled && psd.connectionProxyUrl) {
      proxyUrl = psd.connectionProxyUrl;
      // 7890 → talk to mihomo via listener; otherwise treat as direct http proxy
      if (proxyUrl === "http://127.0.0.1:7890") {
        mode = "clash";
        geo = await probeGeoViaListener(CLASH_LISTENER, { urls, timeoutMs: 6000 });
      } else {
        mode = "custom";
        geo = await probeViaProxyUrl(proxyUrl, urls);
      }
    } else {
      mode = "direct";
      geo = await probeGeoDirect({ urls });
    }

    return NextResponse.json({
      mode,
      proxyUrl: proxyUrl ? proxyUrl.replace(/:[^:@]*@/, ":***@") : null,
      ip: geo?.ip || null,
      country: geo?.country || null,
      city: geo?.city || null,
      org: geo?.org || null,
      source: geo?.url || null,
      ok: !!geo?.ip,
    });
  } catch (error) {
    console.error("[providers/:id/test-egress] error:", error);
    return NextResponse.json({ error: error.message || "Test failed" }, { status: 500 });
  }
}
