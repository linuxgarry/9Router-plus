import { NextResponse } from "next/server";
import { createProxyPool, getProxyPools } from "@/models";

// POST /api/tailscale/import-proxies
// Body: { entries: [{ peer, ip, type, port, username?, password? }] }
//
// Synthesises a ProxyPool row per entry. Each becomes a regular pool
// the rest of the system already knows how to use — bind to listener,
// attach to a connection, bulk delete via the existing UI flow.
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const entries = Array.isArray(body?.entries) ? body.entries : [];
    if (entries.length === 0) {
      return NextResponse.json({ error: "entries[] required" }, { status: 400 });
    }

    // Pre-load existing pools so we can detect dupes by host+port+type.
    const existing = await getProxyPools().catch(() => []);
    const existingKey = new Set(
      existing.map((p) => `${p.proxyUrl || ""}`),
    );

    const created = [];
    const failed = [];
    const skipped = [];

    for (const entry of entries) {
      const { peer, ip, type, port, username, password } = entry || {};
      if (!ip || !type || !port) {
        failed.push({ entry, error: "ip/type/port required" });
        continue;
      }
      const auth = username
        ? `${encodeURIComponent(username)}:${encodeURIComponent(password || "")}@`
        : "";
      const proxyUrl = `${type}://${auth}${ip}:${port}`;
      if (existingKey.has(proxyUrl)) {
        skipped.push({ peer, proxyUrl, reason: "duplicate" });
        continue;
      }
      try {
        const pool = await createProxyPool({
          name: `tailscale/${peer || ip}:${port} (${type})`,
          type,
          source: "tailscale",
          proxyUrl,
          isActive: true,
        });
        created.push(pool);
        existingKey.add(proxyUrl);
      } catch (e) {
        failed.push({ entry, error: e?.message || String(e) });
      }
    }

    return NextResponse.json({
      ok: created.length,
      skipped: skipped.length,
      failed: failed.length,
      created,
      skippedDetails: skipped,
      failedDetails: failed,
    });
  } catch (error) {
    console.error("[tailscale/import-proxies] error:", error);
    return NextResponse.json({ error: error.message || "Import failed" }, { status: 500 });
  }
}
