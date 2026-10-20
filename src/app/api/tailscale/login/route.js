import { NextResponse } from "next/server";
import { startLogin } from "@/lib/tunnel/tailscale/tailscale";

// POST /api/tailscale/login
//
// Kicks off `tailscale up` against the local tailscaled and returns the
// browser auth URL. The frontend opens the URL in a new tab; the
// /api/tailscale/status endpoint then reflects the logged-in state on
// the next poll.
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const hostname = (body?.hostname || "").trim() || null;
    const result = await startLogin(hostname);
    return NextResponse.json(result);
  } catch (error) {
    console.error("[tailscale/login] error:", error);
    return NextResponse.json({ error: error.message || "Login failed" }, { status: 500 });
  }
}
