import { NextResponse } from "next/server";
import { startCaddy } from "@/lib/ssl";

export async function POST() {
  try {
    const out = startCaddy();
    return NextResponse.json({ ok: true, supervisor: out.trim() });
  } catch (e) {
    return NextResponse.json({ error: e.message || "Failed to start caddy" }, { status: 500 });
  }
}
