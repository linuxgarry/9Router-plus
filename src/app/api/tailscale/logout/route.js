import { NextResponse } from "next/server";
import { logout } from "@/lib/tunnel/tailscale/tailscale";

/**
 * POST /api/tailscale/logout
 *
 * Logs the local tailscaled out of the current Tailscale account. The
 * neighbour-probe card calls this from "Switch account" so that the next
 * /api/tailscale/login emits an AuthURL that lets the user pick a new
 * identity. Best-effort: failures don't block the subsequent login flow.
 */
export async function POST() {
  try {
    const result = await logout();
    return NextResponse.json(result);
  } catch (error) {
    console.error("[tailscale/logout] error:", error);
    return NextResponse.json({ error: error.message || "Logout failed" }, { status: 500 });
  }
}
