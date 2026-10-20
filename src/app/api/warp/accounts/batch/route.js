import { registerAccount, updateAccountGeo } from "@/lib/warp/accounts";
import { rebuildAndReloadMihomo } from "@/lib/clash/importYaml";
import { buildConfig, writeConfig, reload, normaliseProxy } from "@/lib/mihomo";
import { isEnabled as isWarpEnabled, getActiveConfig as getWarpConfig } from "@/lib/warp";
import { getProxyPools } from "@/models";
import { probeGeoViaListener } from "@/lib/geo";
import http from "node:http";

const TEST_PORT = 29998;
const RELOAD_SETTLE_MS = 600;
const MAX_BATCH = 20;

const encoder = new TextEncoder();
const sse = (event, data) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

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
      finish({ ok: res.statusCode === 204 || res.statusCode === 200, latency: Date.now() - startedAt });
    });
    req.on("error", () => finish({ ok: false, latency: Date.now() - startedAt }));
    req.on("timeout", () => finish({ ok: false, latency: Date.now() - startedAt, error: "timeout" }));
    req.end();
  });
}

async function testAccount(account) {
  // Bind WARP/<name> to a temp listener, probe 204, then probe geo
  const allPools = await getProxyPools({ isActive: true });
  const normalised = allPools.map((p) => normaliseProxy(p)).filter(Boolean);
  const warpEnabled = (() => { try { return isWarpEnabled(); } catch { return false; } })();
  const warp = warpEnabled ? (() => { try { return getWarpConfig(); } catch { return null; } })() : null;

  const proxyName = `WARP/${account.name}`;
  const { yaml } = buildConfig({
    proxies: normalised,
    warp,
    warpEnabled,
    topListeners: [{ port: TEST_PORT, proxy: proxyName }],
    testUrl: "http://www.gstatic.com/generate_204",
  });
  writeConfig(yaml);
  await reload();
  await new Promise((r) => setTimeout(r, RELOAD_SETTLE_MS));

  const reach = await probe204(TEST_PORT);
  let geo = null;
  if (reach.ok) geo = await probeGeoViaListener(TEST_PORT, { timeoutMs: 6000 });

  return {
    ok: reach.ok,
    latency: reach.ok ? reach.latency : -1,
    exitIp: geo?.ip || null,
    country: geo?.country || null,
    city: geo?.city || null,
  };
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const count = Math.max(1, Math.min(MAX_BATCH, parseInt(body?.count, 10) || 1));
  const namePrefix = (body?.namePrefix || "").trim();

  const stream = new ReadableStream({
    async start(controller) {
      const safeEnqueue = (chunk) => { try { controller.enqueue(chunk); } catch {} };
      try {
        safeEnqueue(sse("start", { count }));
        const created = [];
        for (let i = 0; i < count; i++) {
          const name = namePrefix ? `${namePrefix}-${i + 1}` : "";
          try {
            safeEnqueue(sse("registering", { index: i + 1, total: count }));
            const account = await registerAccount({ name });
            created.push(account);
            safeEnqueue(sse("registered", { index: i + 1, total: count, account }));
          } catch (err) {
            safeEnqueue(sse("register-error", { index: i + 1, error: err.message }));
            continue;
          }
        }

        // single rebuild covering all newly-added accounts (registerAccount
        // already mutated the pool table, but mihomo only sees them after
        // a reload that includes them).
        try { await rebuildAndReloadMihomo(); } catch {}

        // sequentially test each new account so the temp listener doesn't
        // collide between them
        for (let i = 0; i < created.length; i++) {
          const acc = created[i];
          safeEnqueue(sse("testing", { index: i + 1, total: created.length, name: acc.name }));
          try {
            const r = await testAccount(acc);
            await updateAccountGeo(acc.id, { latency: r.latency, exitIp: r.exitIp, country: r.country });
            safeEnqueue(sse("tested", { index: i + 1, total: created.length, name: acc.name, ...r }));
          } catch (err) {
            safeEnqueue(sse("test-error", { index: i + 1, name: acc.name, error: err.message }));
          }
        }

        // restore mihomo to a config without the temp listener
        try { await rebuildAndReloadMihomo(); } catch {}

        safeEnqueue(sse("done", { created: created.length }));
      } catch (err) {
        safeEnqueue(sse("error", { error: err.message || "Batch failed" }));
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
