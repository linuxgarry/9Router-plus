import { NextResponse } from "next/server";
import { importWgConfig } from "@/lib/warp/accounts";
import { rebuildAndReloadMihomo } from "@/lib/clash/importYaml";

// POST /api/warp/accounts/import-wg
//
// Body shapes:
//   { config: "<single [Interface][Peer] text>", name?: string }
//   { entries: [{ name?, config }, ...] }
//
// Single-config calls return { account }; batch calls return
// { ok, failed, accounts }.
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));

    if (Array.isArray(body?.entries)) {
      const accounts = [];
      const failed = [];
      for (const entry of body.entries) {
        try {
          const acc = await importWgConfig({
            name: entry?.name,
            config: entry?.config,
          });
          accounts.push(acc);
        } catch (e) {
          failed.push({ name: entry?.name || null, error: e?.message || String(e) });
        }
      }
      rebuildAndReloadMihomo().catch(() => {});
      return NextResponse.json({
        ok: accounts.length,
        failed,
        total: body.entries.length,
        accounts,
      });
    }

    if (typeof body?.config === "string" && body.config.trim()) {
      const account = await importWgConfig({ name: body?.name, config: body.config });
      rebuildAndReloadMihomo().catch(() => {});
      return NextResponse.json({ account }, { status: 201 });
    }

    return NextResponse.json(
      { error: "Provide { config } or { entries: [{ name?, config }] }" },
      { status: 400 },
    );
  } catch (error) {
    console.error("[warp/accounts/import-wg] error:", error);
    return NextResponse.json(
      { error: error.message || "Import failed" },
      { status: 500 },
    );
  }
}
