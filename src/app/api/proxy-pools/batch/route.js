import { NextResponse } from "next/server";
import { updateProxyPool, deleteProxyPool } from "@/models";
import { rebuildAndReloadMihomo } from "@/lib/clash/importYaml";

const MAX_BATCH = 5000;

export async function POST(request) {
  try {
    const body = await request.json();
    const { ids, action, isActive } = body || {};

    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ error: "ids[] is required" }, { status: 400 });
    }
    if (ids.length > MAX_BATCH) {
      return NextResponse.json({ error: `Too many ids (max ${MAX_BATCH})` }, { status: 413 });
    }

    let ok = 0;
    let failed = 0;
    const failedIds = [];

    if (action === "delete") {
      for (const id of ids) {
        try {
          const removed = await deleteProxyPool(id);
          if (removed) ok++; else { failed++; failedIds.push(id); }
        } catch {
          failed++;
          failedIds.push(id);
        }
      }
    } else if (action === "set-active" || isActive !== undefined) {
      const next = action === "set-active" ? !!isActive : !!isActive;
      for (const id of ids) {
        try {
          const updated = await updateProxyPool(id, { isActive: next });
          if (updated) ok++; else { failed++; failedIds.push(id); }
        } catch {
          failed++;
          failedIds.push(id);
        }
      }
    } else {
      return NextResponse.json(
        { error: "action must be 'set-active' or 'delete'" },
        { status: 400 }
      );
    }

    rebuildAndReloadMihomo().catch(() => {});

    return NextResponse.json({ ok, failed, failedIds });
  } catch (error) {
    console.error("[proxy-pools/batch] error:", error);
    return NextResponse.json({ error: "Batch operation failed" }, { status: 500 });
  }
}
