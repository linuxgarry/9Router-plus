import { NextResponse } from "next/server";
import { getIpCheckUrls, setIpCheckUrls, IP_CHECK_URL_CATALOG } from "@/lib/geo";

export async function GET() {
  try {
    const urls = await getIpCheckUrls();
    return NextResponse.json({ urls, catalog: IP_CHECK_URL_CATALOG });
  } catch (error) {
    console.error("[ip-check-urls] GET error:", error);
    return NextResponse.json({ error: "Failed to read settings" }, { status: 500 });
  }
}

export async function PUT(request) {
  try {
    const body = await request.json();
    const urls = Array.isArray(body?.urls) ? body.urls.filter((u) => typeof u === "string" && u.trim()) : null;
    if (!urls) {
      return NextResponse.json({ error: "urls[] required" }, { status: 400 });
    }
    await setIpCheckUrls(urls);
    return NextResponse.json({ urls });
  } catch (error) {
    console.error("[ip-check-urls] PUT error:", error);
    return NextResponse.json({ error: "Failed to save settings" }, { status: 500 });
  }
}
