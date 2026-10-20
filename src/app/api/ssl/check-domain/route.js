import { NextResponse } from "next/server";
import { checkDomainBinding } from "@/lib/ssl";

// POST /api/ssl/check-domain
// Body: { domain }
// Resolves the domain's A/AAAA records and compares them to this
// host's public IP. The UI uses this before letting the user flip
// "enabled" so a misconfigured DNS does not burn ACME rate-limits.
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const domain = (body?.domain || "").trim();
    if (!domain) return NextResponse.json({ error: "domain required" }, { status: 400 });
    const result = await checkDomainBinding(domain);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e.message || "Failed to check domain" }, { status: 500 });
  }
}
