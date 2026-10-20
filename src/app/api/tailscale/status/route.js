import { NextResponse } from "next/server";
import { getNeighbourSnapshot } from "@/lib/tunnel/neighbours";

export async function GET() {
  try {
    const snap = getNeighbourSnapshot();
    return NextResponse.json(snap);
  } catch (error) {
    console.error("[tailscale/status] error:", error);
    return NextResponse.json({ error: error.message || "Failed to read tailscale status" }, { status: 500 });
  }
}
