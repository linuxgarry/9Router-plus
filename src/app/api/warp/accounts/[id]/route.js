import { NextResponse } from "next/server";
import { deleteAccount, getAccount } from "@/lib/warp/accounts";
import { rebuildAndReloadMihomo } from "@/lib/clash/importYaml";

export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    if (!getAccount(id)) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }
    const ok = await deleteAccount(id);
    rebuildAndReloadMihomo().catch(() => {});
    return NextResponse.json({ ok });
  } catch (error) {
    console.error("[warp/accounts/:id] DELETE error:", error);
    return NextResponse.json({ error: "Delete failed" }, { status: 500 });
  }
}
