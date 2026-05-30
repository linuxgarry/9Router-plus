import { NextResponse } from "next/server";
import {
  getClashSubscriptionById,
  updateClashSubscription,
} from "@/models";
import {
  parseClashYaml,
  importProxiesIntoPool,
  rebuildAndReloadMihomo,
} from "@/lib/clash/importYaml";

export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const sub = await getClashSubscriptionById(id);

    if (!sub) {
      return NextResponse.json({ error: "Subscription not found" }, { status: 404 });
    }

    const isManual = typeof sub.url === "string" && sub.url.startsWith("manual://");

    let rawYaml;
    if (isManual) {
      rawYaml = sub.rawYaml;
      if (!rawYaml) {
        return NextResponse.json(
          { error: "Manual subscription has no stored YAML — re-import via 手工粘贴" },
          { status: 400 }
        );
      }
    } else {
      try {
        const res = await fetch(sub.url, {
          timeout: 10000,
          headers: { "User-Agent": "9router/1.0" },
        });
        if (!res.ok) {
          return NextResponse.json(
            { error: `Failed to fetch subscription: ${res.status}` },
            { status: 400 }
          );
        }
        rawYaml = await res.text();
      } catch (err) {
        return NextResponse.json(
          { error: `Network error: ${err.message}` },
          { status: 400 }
        );
      }
    }

    let proxies;
    try {
      proxies = parseClashYaml(rawYaml);
    } catch (err) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }

    const imported = await importProxiesIntoPool(proxies);

    await updateClashSubscription(id, {
      nodeCount: imported,
      lastLoadedAt: new Date().toISOString(),
      rawYaml,
    });

    await rebuildAndReloadMihomo();

    return NextResponse.json({
      ok: true,
      imported,
      message: `Loaded ${imported} proxies from subscription`,
    });
  } catch (error) {
    console.error("[clash-sub/:id/load] error:", error);
    return NextResponse.json({ error: "Failed to load subscription" }, { status: 500 });
  }
}
