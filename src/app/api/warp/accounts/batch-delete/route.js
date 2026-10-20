import { NextResponse } from "next/server";
import { deleteAccount, getAccount } from "@/lib/warp/accounts";
import { rebuildAndReloadMihomo } from "@/lib/clash/importYaml";

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const ids = Array.isArray(body?.ids) ? body.ids.filter((x) => typeof x === "string" && x) : [];
    if (ids.length === 0) {
      return NextResponse.json({ error: "ids[] required" }, { status: 400 });
    }

    let ok = 0;
    const failed = [];
    for (const id of ids) {
      try {
        if (!getAccount(id)) {
          failed.push({ id, error: "not found" });
          continue;
        }
        const deleted = await deleteAccount(id);
        if (deleted) ok++;
        else failed.push({ id, error: "delete returned false" });
      } catch (e) {
        failed.push({ id, error: e?.message || String(e) });
      }
    }

    rebuildAndReloadMihomo().catch(() => {});

    return NextResponse.json({ ok, failed, total: ids.length });
  } catch (error) {
    console.error("[warp/accounts/batch-delete] error:", error);
    return NextResponse.json({ error: error.message || "Batch delete failed" }, { status: 500 });
  }
}
