import { NextResponse } from "next/server";
import { stopCaddy, saveConfig } from "@/lib/ssl";

export async function POST() {
  try {
    saveConfig({ enabled: false });
    const out = stopCaddy();
    return NextResponse.json({ ok: true, supervisor: out.trim() });
  } catch (e) {
    return NextResponse.json({ error: e.message || "Failed to stop caddy" }, { status: 500 });
  }
}
