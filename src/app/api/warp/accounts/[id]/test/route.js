import { NextResponse } from "next/server";
import { getAccount } from "@/lib/warp/accounts";
import { delay } from "@/lib/mihomo";

export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const acc = getAccount(id);
    if (!acc) return NextResponse.json({ error: "Account not found" }, { status: 404 });

    const body = await request.json().catch(() => ({}));
    const testUrl = body?.testUrl || "http://www.gstatic.com/generate_204";
    const proxyName = `WARP/${acc.name}`;

    const { ok, delay: latency } = await delay(proxyName, { url: testUrl, timeout: 8000 });
    return NextResponse.json({
      ok,
      latency: ok && latency > 0 ? latency : -1,
      proxy: proxyName,
      status: ok && latency > 0 ? "ok" : "down",
    });
  } catch (error) {
    console.error("[warp/accounts/:id/test] error:", error);
    return NextResponse.json({ error: "Test failed" }, { status: 500 });
  }
}
