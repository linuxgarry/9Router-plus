/**
 * IP Geo detection helper.
 *
 * Probes exit IP + country by sending a request through a mihomo listener
 * (or directly) to one of the configured IP check URLs.
 *
 * Defaults are picked specifically to ignore X-Forwarded-For so they
 * keep working when the request is forwarded through a relay (e.g.
 * vercel-relay). Services that trust XFF — ipify.org, ipinfo.io,
 * ip-api.com, api.ip.sb — would surface the original client IP from
 * the proxy chain instead of the relay's real exit IP, defeating the
 * point of the test, so they are NOT in the default list.
 */
import http from "node:http";
import { getSettings, updateSettings } from "@/lib/db/repos/settingsRepo.js";

const DEFAULT_IP_CHECK_URLS = [
  "https://icanhazip.com/",
  "https://ifconfig.me/ip",
  "https://ifconfig.co/json",
  "https://myip.wtf/json",
  "https://wtfismyip.com/json",
];

// Catalog shown in the proxy-pools UI dropdown so users can pick or
// reorder. `trustsXff: false` means the service ignores X-Forwarded-For
// and shows the actual remote address — what we want when probing
// through a relay or proxy.
export const IP_CHECK_URL_CATALOG = [
  { url: "https://icanhazip.com/", trustsXff: false, returns: "text", note: "Cloudflare-backed; raw IP only" },
  { url: "https://ifconfig.me/ip", trustsXff: false, returns: "text", note: "Plain text remote IP" },
  { url: "https://ifconfig.co/json", trustsXff: false, returns: "json", note: "IP + country/city/asn" },
  { url: "https://myip.wtf/json", trustsXff: false, returns: "json", note: "IP + reverse DNS + ASN" },
  { url: "https://myip.wtf/text", trustsXff: false, returns: "text", note: "Plain text remote IP" },
  { url: "https://wtfismyip.com/json", trustsXff: false, returns: "json", note: "IP + ISP + country" },
  { url: "https://wtfismyip.com/text", trustsXff: false, returns: "text", note: "Plain text remote IP" },
  { url: "https://api.bigdatacloud.net/data/client-ip", trustsXff: false, returns: "json", note: "BigDataCloud client IP" },
  { url: "https://httpbin.org/ip", trustsXff: true, returns: "json", note: "Returns 'origin' which CHAINS XFF — only use directly, not through relay" },
];

export async function getIpCheckUrls() {
  const settings = await getSettings();
  const urls = settings.ipCheckUrls;
  if (Array.isArray(urls) && urls.length > 0) return urls;
  return DEFAULT_IP_CHECK_URLS;
}

export async function setIpCheckUrls(urls) {
  await updateSettings({ ipCheckUrls: urls });
}

/**
 * Probe exit IP + country through a local mihomo mixed-port listener.
 * @param {number} port - local listener port (e.g. 7890 or a temp test port)
 * @param {object} opts
 * @param {string[]} opts.urls - IP check URLs to try in order
 * @param {number} opts.timeoutMs - per-URL timeout
 * @returns {{ ip, country, city, org, raw, url } | null}
 */
export async function probeGeoViaListener(port, { urls, timeoutMs = 6000 } = {}) {
  const checkUrls = urls || await getIpCheckUrls();

  for (const checkUrl of checkUrls) {
    try {
      const parsed = new URL(checkUrl);
      const result = await new Promise((resolve, reject) => {
        const req = http.request({
          host: "127.0.0.1",
          port,
          method: "GET",
          path: checkUrl,
          headers: { Host: parsed.host, "User-Agent": "9router-geo/1.0", Connection: "close" },
          timeout: timeoutMs,
        }, (res) => {
          let body = "";
          res.on("data", (c) => { body += c; });
          res.on("end", () => resolve({ status: res.statusCode, body }));
        });
        req.on("error", reject);
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
        req.end();
      });

      if (result.status !== 200) continue;

      const geo = parseGeoResponse(result.body, checkUrl);
      if (geo?.ip) return { ...geo, url: checkUrl };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Probe exit IP directly (no proxy), for Test Connection "直连" mode.
 */
export async function probeGeoDirect({ urls, timeoutMs = 6000 } = {}) {
  const checkUrls = urls || await getIpCheckUrls();

  for (const checkUrl of checkUrls) {
    try {
      const res = await fetch(checkUrl, {
        headers: { "User-Agent": "9router-geo/1.0" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) continue;
      const body = await res.text();
      const geo = parseGeoResponse(body, checkUrl);
      if (geo?.ip) return { ...geo, url: checkUrl };
    } catch {
      continue;
    }
  }
  return null;
}

function parseGeoResponse(body, url) {
  // Try JSON first
  try {
    const d = JSON.parse(body);
    // Accepted shapes:
    //   icanhazip / ifconfig.me / ifconfig.co/ip → not JSON, handled below
    //   ifconfig.co/json   → { ip, country, city, asn_org, ... }
    //   myip.wtf/json      → { YourFuckingIPAddress, YourFuckingISP, YourFuckingLocation, ... }
    //   wtfismyip.com/json → { YourFuckingIPAddress, YourFuckingISP, YourFuckingLocation, YourFuckingCountryCode, ... }
    //   bigdatacloud       → { ipString, country: { isoNameFull, ... }, city, ... }
    //   ipinfo.io          → { ip, country, city, org }   (legacy, only if user kept it)
    //   api.ipify.org      → { ip }                       (legacy)
    //   ip-api.com         → { query, country, city, ... }
    //   httpbin.org/ip     → { origin }
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
    const city =
      d.city ||
      (typeof d.YourFuckingLocation === "string" ? d.YourFuckingLocation : null) ||
      null;
    const org =
      d.asn_org ||
      d.org ||
      d.organization ||
      d.isp ||
      d.YourFuckingISP ||
      null;
    if (ip) return { ip, country, city, org, raw: d };
  } catch {}

  // Plain text (api.ipify.org without ?format=json, or geo.geosurf.io text mode)
  const trimmed = (body || "").trim();
  const ipMatch = trimmed.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (ipMatch) return { ip: ipMatch[1], country: null, city: null, org: null, raw: trimmed };

  return null;
}
