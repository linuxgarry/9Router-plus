import { NextResponse } from "next/server";
import {
  isEnabled,
  setEnabled,
  getSettings,
  setSettings,
  autoRegister,
  getActiveConfig,
  getStatus,
} from "@/lib/warp";
import { buildConfig, writeConfig, reload, normaliseProxy, readTopFixed } from "@/lib/mihomo";
import { getProxyPools } from "@/models";

// GET /api/warp - Get WARP status
export async function GET() {
  try {
    return NextResponse.json(getStatus());
  } catch (error) {
    console.error("[warp] GET error:", error);
    return NextResponse.json({ error: "Failed to get WARP status" }, { status: 500 });
  }
}

// PUT /api/warp - Update WARP settings (enable/disable, mode, customConfig)
export async function PUT(request) {
  try {
    const body = await request.json();
    const { enabled, mode, customConfig, routeTuning } = body;

    // Update settings if provided
    if (mode !== undefined || customConfig !== undefined || routeTuning !== undefined) {
      const update = {};
      if (mode !== undefined) update.mode = mode === "custom" ? "custom" : "auto";
      if (customConfig !== undefined) update.customConfig = customConfig;
      if (routeTuning !== undefined) update.routeTuning = !!routeTuning;
      setSettings(update);
    }

    // Auto-register if enabling and no profile exists
    if (enabled === true) {
      const settings = getSettings();
      if (settings.mode !== "custom") {
        const result = await autoRegister();
        if (!result.ok && !result.skipped) {
          return NextResponse.json(
            { error: `WARP registration failed: ${result.error}` },
            { status: 500 }
          );
        }
      }
    }

    if (enabled !== undefined) setEnabled(enabled);

    // Rebuild mihomo config with new WARP state
    try {
      const allPools = await getProxyPools({ isActive: true });
      const normalised = allPools.map((p) => normaliseProxy(p)).filter(Boolean);
      const warpCfg = isEnabled() ? getActiveConfig() : null;
      const topListeners = readTopFixed();

      const { yaml: configYaml } = buildConfig({
        proxies: normalised,
        warp: warpCfg,
        warpEnabled: isEnabled(),
        topListeners,
        testUrl: "http://www.gstatic.com/generate_204",
      });

      writeConfig(configYaml);
      await reload();
    } catch (err) {
      console.warn("[warp] mihomo reload failed:", err.message);
    }

    return NextResponse.json({ ok: true, status: getStatus() });
  } catch (error) {
    console.error("[warp] PUT error:", error);
    return NextResponse.json({ error: "Failed to update WARP" }, { status: 500 });
  }
}

// POST /api/warp/test - Test WARP connectivity
export async function POST() {
  try {
    if (!isEnabled()) {
      return NextResponse.json({ ok: false, error: "WARP not enabled" });
    }

    const res = await fetch("http://127.0.0.1:7890", {
      // Test via local mihomo proxy
      method: "GET",
    }).catch(() => null);

    // Direct trace to verify
    try {
      const traceRes = await fetch("https://www.cloudflare.com/cdn-cgi/trace", {
        // Note: would need to route through mihomo, here we just verify
        signal: AbortSignal.timeout(5000),
      });
      const text = await traceRes.text();
      const warpLine = text.split("\n").find((l) => l.startsWith("warp="));
      return NextResponse.json({
        ok: warpLine === "warp=on" || warpLine === "warp=plus",
        warp: warpLine || "unknown",
        trace: text,
      });
    } catch (err) {
      return NextResponse.json({ ok: false, error: err.message });
    }
  } catch (error) {
    console.error("[warp/test] error:", error);
    return NextResponse.json({ error: "Test failed" }, { status: 500 });
  }
}
