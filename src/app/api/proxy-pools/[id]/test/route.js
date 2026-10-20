import { NextResponse } from "next/server";
import { getProxyPoolById, updateProxyPool } from "@/models";
import { testProxyUrl } from "@/lib/network/proxyTest";
import { probeViaVercelRelay, pingVercelRelay } from "@/lib/network/vercelRelay";
import { getIpCheckUrls } from "@/lib/geo";

async function testVercelRelay(relayUrl, timeoutMs = 10000) {
  // Two-step: ping for latency, then probe IP via configured IP-check URLs.
  // ping uses httpbin.org/get which is also the fallback for IP detection,
  // so worst case we still get an exit IP back.
  const ping = await pingVercelRelay(relayUrl, { timeoutMs });
  if (!ping.ok) {
    return {
      ok: false,
      status: ping.status || 500,
      error: ping.error || `Relay test failed with status ${ping.status}`,
      elapsedMs: ping.elapsedMs,
    };
  }
  let geo = null;
  try {
    const urls = await getIpCheckUrls();
    geo = await probeViaVercelRelay(relayUrl, urls, { timeoutMs });
  } catch {}
  return {
    ok: true,
    status: ping.status,
    elapsedMs: ping.elapsedMs,
    ip: geo?.ip || null,
    country: geo?.country || null,
    city: geo?.city || null,
    org: geo?.org || null,
    geoSource: geo?.url || null,
  };
}

// Test an http/socks5 proxyUrl by sending a real request through it,
// timing the round-trip, and parsing the exit IP / country out of the
// response. This replaces the legacy testProxyUrl-only path which only
// returned a bool — users couldn't tell a proxy's exit IP from the row,
// only "active" or "error".
async function testHttpProxy(proxyUrl, timeoutMs = 8000) {
  const startedAt = Date.now();
  let firstError = null;
  try {
    const { ProxyAgent } = await import("undici");
    const dispatcher = new ProxyAgent(proxyUrl);
    const urls = await getIpCheckUrls();
    for (const checkUrl of urls) {
      try {
        const res = await fetch(checkUrl, {
          dispatcher,
          headers: { "User-Agent": "9router-egress/1.0" },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) { firstError = firstError || `HTTP ${res.status} from ${checkUrl}`; continue; }
        const body = await res.text();
        let ip = null, country = null, city = null, org = null;
        try {
          const d = JSON.parse(body);
          ip = d.ip || d.query || d.ipAddress || d.origin || d.YourFuckingIPAddress || d.ipString || null;
          country = d.country_iso || d.country_code || d.countryCode || d.YourFuckingCountryCode ||
            (typeof d.country === "string" ? d.country : d.country?.isoNameFull || d.country?.name) || null;
          city = d.city || (typeof d.YourFuckingLocation === "string" ? d.YourFuckingLocation : null) || null;
          org = d.asn_org || d.org || d.organization || d.isp || d.YourFuckingISP || null;
        } catch {
          const m = body.trim().match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
          if (m) ip = m[1];
        }
        if (ip) {
          return {
            ok: true,
            status: res.status,
            elapsedMs: Date.now() - startedAt,
            ip,
            country,
            city,
            org,
            geoSource: checkUrl,
          };
        }
        firstError = firstError || `No IP in response from ${checkUrl}`;
      } catch (err) {
        firstError = firstError || (err?.code || err?.message || String(err));
      }
    }
    return {
      ok: false,
      status: 0,
      elapsedMs: Date.now() - startedAt,
      error: firstError || "All IP-check URLs failed",
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      elapsedMs: Date.now() - startedAt,
      error: err?.message || String(err),
    };
  }
}

// POST /api/proxy-pools/[id]/test - Test proxy pool entry
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const proxyPool = await getProxyPoolById(id);

    if (!proxyPool) {
      return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    }

    let result;
    if (proxyPool.type === "vercel" || proxyPool.type === "cloudflare" || proxyPool.type === "deno" || proxyPool.type === "netlify") {
      result = await testVercelRelay(proxyPool.proxyUrl);
    } else if (
      proxyPool.proxyUrl &&
      (proxyPool.type === "http" || proxyPool.type === "socks5" || proxyPool.type === "socks")
    ) {
      result = await testHttpProxy(proxyPool.proxyUrl);
    } else {
      result = await testProxyUrl({ proxyUrl: proxyPool.proxyUrl });
    }
    const now = new Date().toISOString();

    const updates = {
      testStatus: result.ok ? "active" : "error",
      lastTestedAt: now,
      lastError: result.ok ? null : (result.error || `Proxy test failed with status ${result.status}`),
      isActive: result.ok,
    };
    if (result.ok && typeof result.elapsedMs === "number" && result.elapsedMs > 0) {
      updates.cachedLatency = result.elapsedMs;
    }
    if (result.ip) updates.exitIp = result.ip;
    if (result.country) updates.country = result.country;

    await updateProxyPool(id, updates);

    return NextResponse.json({
      ok: result.ok,
      status: result.status,
      statusText: result.statusText || null,
      error: result.error || null,
      elapsedMs: result.elapsedMs || 0,
      latency: result.elapsedMs || 0,
      exitIp: result.ip || null,
      country: result.country || null,
      city: result.city || null,
      org: result.org || null,
      geoSource: result.geoSource || null,
      testedAt: now,
    });
  } catch (error) {
    console.log("Error testing proxy pool:", error);
    return NextResponse.json({ error: "Failed to test proxy pool" }, { status: 500 });
  }
}
