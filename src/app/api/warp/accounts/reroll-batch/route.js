import { NextResponse } from "next/server";
import { rerollEndpoint, getAccount, listAccounts } from "@/lib/warp/accounts";
import { rebuildAndReloadMihomo } from "@/lib/clash/importYaml";

// POST /api/warp/accounts/reroll-batch
// Body: { ids?: string[] }   omit ids to reroll every account.
//
// Pick a fresh random Cloudflare WARP IPv4 endpoint for each named
// account. We rebuild mihomo once at the end rather than per-account
// to avoid kicking the proxy listener seven times in a row.
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    let ids = Array.isArray(body?.ids) ? body.ids.filter((x) => typeof x === "string" && x) : null;
    if (!ids) {
      const accounts = await listAccounts();
      ids = accounts.map((a) => a.id);
    }

    let ok = 0;
    const failed = [];
    for (const id of ids) {
      try {
        if (!getAccount(id)) {
          failed.push({ id, error: "not found" });
          continue;
        }
        await rerollEndpoint(id);
        ok++;
      } catch (e) {
        failed.push({ id, error: e?.message || String(e) });
      }
    }

    rebuildAndReloadMihomo().catch(() => {});
    return NextResponse.json({ ok, failed, total: ids.length });
  } catch (error) {
    console.error("[warp/accounts/reroll-batch] error:", error);
    return NextResponse.json({ error: error.message || "Reroll-batch failed" }, { status: 500 });
  }
}
