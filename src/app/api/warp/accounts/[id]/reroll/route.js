import { NextResponse } from "next/server";
import { rerollEndpoint, getAccount } from "@/lib/warp/accounts";
import { rebuildAndReloadMihomo } from "@/lib/clash/importYaml";

// POST /api/warp/accounts/[id]/reroll
// Pick a fresh random Cloudflare WARP IPv4 endpoint for one account
// and rebuild mihomo so the change is live immediately. Existing
// cached latency / exit IP are cleared because they belonged to the
// old PoP.
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    if (!getAccount(id)) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }
    const meta = await rerollEndpoint(id);
    rebuildAndReloadMihomo().catch(() => {});
    return NextResponse.json({ ok: true, account: meta });
  } catch (error) {
    console.error("[warp/accounts/:id/reroll] error:", error);
    return NextResponse.json({ error: error.message || "Reroll failed" }, { status: 500 });
  }
}
