import { NextResponse } from "next/server";
import {
  getConfig,
  saveConfig,
  caddyStatus,
  startCaddy,
  stopCaddy,
  saveManualCert,
  checkDomainBinding,
} from "@/lib/ssl";

// GET /api/ssl
// Returns the persisted SSL config + the current caddy supervisor state.
export async function GET() {
  try {
    const cfg = getConfig();
    const status = caddyStatus();
    // Don't expose key path bytes to the UI — just whether one is uploaded.
    const safe = {
      ...cfg,
      hasManualCert: !!(cfg.manualCertPath && cfg.manualKeyPath),
    };
    delete safe.manualCertPath;
    delete safe.manualKeyPath;
    return NextResponse.json({ config: safe, status });
  } catch (e) {
    return NextResponse.json({ error: e.message || "Failed to read SSL config" }, { status: 500 });
  }
}

// PUT /api/ssl
// Body: any subset of config fields { domain, mode, acmeEmail,
// httpsPort, httpPort, upstream, enabled }. Stores them but does
// NOT (re)start caddy — that's a separate explicit action.
export async function PUT(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const allowed = ["domain", "mode", "acmeEmail", "httpsPort", "httpPort", "upstream", "enabled", "autoStart"];
    const patch = {};
    for (const k of allowed) {
      if (body[k] !== undefined) patch[k] = body[k];
    }
    if (patch.mode && !["acme", "manual"].includes(patch.mode)) {
      return NextResponse.json({ error: "mode must be 'acme' or 'manual'" }, { status: 400 });
    }
    if (patch.autoStart !== undefined) patch.autoStart = !!patch.autoStart;
    if (patch.httpsPort != null) {
      const n = parseInt(patch.httpsPort, 10);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        return NextResponse.json({ error: "httpsPort out of range" }, { status: 400 });
      }
      patch.httpsPort = n;
    }
    if (patch.httpPort != null) {
      const n = parseInt(patch.httpPort, 10);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        return NextResponse.json({ error: "httpPort out of range" }, { status: 400 });
      }
      patch.httpPort = n;
    }
    const next = saveConfig(patch);
    return NextResponse.json({ config: next });
  } catch (e) {
    return NextResponse.json({ error: e.message || "Failed to save" }, { status: 500 });
  }
}
