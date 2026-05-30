import dgram from "node:dgram";
import dns from "node:dns/promises";
import { MIHOMO_API, getOrCreateSecret } from "@/lib/mihomo";

const UDP_TIMEOUT_MS = 2500;
const HTTP_TIMEOUT_MS = 8000;
const encoder = new TextEncoder();
const sse = (event, data) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

async function resolveIp(host) {
  try { return (await dns.lookup(host, { family: 0, all: false })).address; } catch { return null; }
}

function udpProbe(host, port) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    let settled = false;
    const startedAt = Date.now();
    const finish = (ok, error) => {
      if (settled) return;
      settled = true;
      try { sock.close(); } catch {}
      resolve({ ok, host, port, elapsedMs: Date.now() - startedAt, error: error || null });
    };
    const timer = setTimeout(() => finish(true, null), UDP_TIMEOUT_MS);
    sock.on("error", (err) => { clearTimeout(timer); finish(false, err.message); });
    sock.send(Buffer.from("9routerprobe"), port, host, (err) => {
      if (err) { clearTimeout(timer); finish(false, err.message); }
    });
  });
}

async function probeMihomoWarp() {
  try {
    const secret = getOrCreateSecret();
    const url = `${MIHOMO_API}/proxies/WARP/delay?url=${encodeURIComponent("http://www.gstatic.com/generate_204")}&timeout=8000`;
    const startedAt = Date.now();
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS + 5000),
    });
    const elapsedMs = Date.now() - startedAt;
    if (!res.ok) return { ok: false, status: res.status, elapsedMs, error: `HTTP ${res.status}` };
    const data = await res.json().catch(() => ({}));
    if (data.delay && data.delay > 0) return { ok: true, latency: data.delay, elapsedMs };
    return { ok: false, elapsedMs, error: data.message || "no delay returned" };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

const WARP_IPV4_CANDIDATES = [
  "162.159.192.1",
  "162.159.193.10",
  "188.114.96.0",
  "188.114.97.0",
];

export async function POST() {
  const stream = new ReadableStream({
    async start(controller) {
      const safeEnqueue = (chunk) => { try { controller.enqueue(chunk); } catch {} };
      const push = (name, result, extra = {}) => {
        safeEnqueue(sse("check", {
          name,
          ok: !!result?.ok,
          extra: extra.extra || (result?.elapsedMs != null ? `${result.elapsedMs}ms` : "") + (result?.error ? ` · ${result.error}` : ""),
          error: result?.error || null,
          latency: result?.latency,
        }));
      };

      try {
        safeEnqueue(sse("start", { totalChecks: 4 + WARP_IPV4_CANDIDATES.length }));

        // baseline UDP
        push("UDP 出站 → 1.1.1.1:53", await udpProbe("1.1.1.1", 53));

        // DNS
        const ip = await resolveIp("engage.cloudflareclient.com");
        push("DNS engage.cloudflareclient.com", { ok: !!ip }, { extra: ip ? `→ ${ip}` : "resolve failed" });
        if (ip) push("UDP 出站 → engage.cloudflareclient.com:2408", await udpProbe(ip, 2408));

        // candidates
        for (const cand of WARP_IPV4_CANDIDATES) {
          push(`UDP 出站 → ${cand}:2408`, await udpProbe(cand, 2408));
        }

        // mihomo wireguard handshake
        const wg = await probeMihomoWarp();
        push("mihomo /proxies/WARP/delay", wg, {
          extra: wg.ok ? `${wg.latency}ms` : (wg.error || "down"),
        });

        safeEnqueue(sse("done", {
          warpReachable: !!wg.ok,
          summary: wg.ok
            ? "WARP 握手成功,跳板可用"
            : "WARP wireguard 握手失败 — UDP 端口可达不代表协议能过(常见于腾讯云/阿里云出 Cloudflare anycast)",
        }));
      } catch (err) {
        safeEnqueue(sse("error", { error: err.message || "Probe failed" }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
