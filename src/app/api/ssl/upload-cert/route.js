import { NextResponse } from "next/server";
import { saveManualCert, saveConfig } from "@/lib/ssl";

// POST /api/ssl/upload-cert
// Body: { cert: "<PEM>", key: "<PEM>" }
// Persists cert + key under /app/data/caddy/manual-certs/ and updates
// the SSL config to reference them. Does NOT start caddy.
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const cert = (body?.cert || "").trim();
    const key = (body?.key || "").trim();
    const { certPath, keyPath } = saveManualCert({ cert, key });
    const next = saveConfig({ mode: "manual", manualCertPath: certPath, manualKeyPath: keyPath });
    return NextResponse.json({ ok: true, config: { ...next, manualCertPath: undefined, manualKeyPath: undefined, hasManualCert: true } });
  } catch (e) {
    return NextResponse.json({ error: e.message || "Failed to save certificate" }, { status: 400 });
  }
}
