/**
 * Vercel Relay probe helpers.
 *
 * The Vercel Relay is not an HTTP/SOCKS proxy — it's a fetch forwarder
 * driven by request headers:
 *
 *   x-relay-target: https://target.example.com
 *   x-relay-path:   /some/path?query
 *
 * The relay then issues the request from a Vercel data-center node and
 * pipes the response back. The exit IP we observe is therefore the
 * Vercel node's IP, not the user's — which is exactly what we want to
 * surface so the user can verify the relay is healthy and see which
 * region they landed in.
 */

/**
 * Forward a single GET through the relay and return the parsed response.
 * Returns { ok, status, body, elapsedMs, error? }.
 */
export async function relayGet(relayUrl, target, path, { timeoutMs = 8000 } = {}) {
  const { fetch: undiciFetch } = await import("undici");
  const startedAt = Date.now();
  try {
    const res = await undiciFetch(relayUrl, {
      method: "GET",
      headers: {
        "x-relay-target": target,
        "x-relay-path": path,
        "User-Agent": "9router-egress/1.0",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      body,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: "",
      elapsedMs: Date.now() - startedAt,
      error: err?.name === "AbortError" ? "Relay test timed out" : (err?.message || String(err)),
    };
  }
}

/**
 * Probe egress IP through a Vercel relay using a list of IP-check URLs.
 *
 * For each URL, we split out target+path, send via the relay, and look
 * for an IP in the response body. JSON shapes we accept:
 *   { ip }         (ipinfo.io, api.ipify.org)
 *   { query }      (ip-api.com)
 *   { origin }     (httpbin.org/get)
 * Plain-text "1.2.3.4" responses also work.
 *
 * Returns { ip, country, city, org, url, elapsedMs } | null.
 */
export async function probeViaVercelRelay(relayUrl, urls, { timeoutMs = 8000 } = {}) {
  for (const checkUrl of urls) {
    try {
      const u = new URL(checkUrl);
      const target = `${u.protocol}//${u.host}`;
      const path = `${u.pathname}${u.search}` || "/";
      const r = await relayGet(relayUrl, target, path, { timeoutMs });
      if (!r.ok) continue;
      try {
        const d = JSON.parse(r.body);
        const ip =
          d.ip ||
          d.query ||
          d.ipAddress ||
          d.origin ||
          d.YourFuckingIPAddress ||
          d.ipString ||
          null;
        const country =
          d.country_iso ||
          d.country_code ||
          d.countryCode ||
          d.YourFuckingCountryCode ||
          (typeof d.country === "string" ? d.country : d.country?.isoNameFull || d.country?.name) ||
          null;
        if (ip) {
          return {
            ip,
            country,
            city: d.city || (typeof d.YourFuckingLocation === "string" ? d.YourFuckingLocation : null) || null,
            org: d.asn_org || d.org || d.organization || d.isp || d.YourFuckingISP || null,
            url: checkUrl,
            elapsedMs: r.elapsedMs,
          };
        }
      } catch {
        const m = (r.body || "").trim().match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
        if (m) return { ip: m[1], country: null, city: null, org: null, url: checkUrl, elapsedMs: r.elapsedMs };
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Liveness check. Hits httpbin.org/get through the relay; we just need
 * a 2xx with a parseable body to call the relay healthy.
 */
export async function pingVercelRelay(relayUrl, { timeoutMs = 8000 } = {}) {
  const r = await relayGet(relayUrl, "https://httpbin.org", "/get", { timeoutMs });
  return {
    ok: r.ok,
    status: r.status,
    elapsedMs: r.elapsedMs,
    error: r.error || null,
  };
}
