import { NextResponse } from "next/server";
import {
  getClashSubscriptions,
  createClashSubscription,
} from "@/models";

// GET /api/clash-subscriptions - List all subscriptions
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const enabled = searchParams.get("enabled");
    const filter = {};
    if (enabled !== null) {
      filter.enabled = enabled === "true";
    }
    const subs = await getClashSubscriptions(filter);
    return NextResponse.json({ subscriptions: subs });
  } catch (error) {
    console.error("[clash-sub] GET error:", error);
    return NextResponse.json({ error: "Failed to fetch subscriptions" }, { status: 500 });
  }
}

// POST /api/clash-subscriptions - Create new subscription
export async function POST(request) {
  try {
    const body = await request.json();
    const { url, name } = body;

    if (!url || typeof url !== "string" || !url.trim()) {
      return NextResponse.json({ error: "URL is required" }, { status: 400 });
    }

    try {
      new URL(url);
    } catch {
      return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
    }

    const sub = await createClashSubscription({
      url: url.trim(),
      name: name?.trim() || new URL(url).hostname,
    });

    return NextResponse.json({ subscription: sub }, { status: 201 });
  } catch (error) {
    console.error("[clash-sub] POST error:", error);
    return NextResponse.json({ error: "Failed to create subscription" }, { status: 500 });
  }
}
