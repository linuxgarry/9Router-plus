import { NextResponse } from "next/server";
import {
  getClashSubscriptionById,
  updateClashSubscription,
  deleteClashSubscription,
} from "@/models";

// PUT /api/clash-subscriptions/[id] - Update subscription
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { url, name, enabled } = body;

    if (url) {
      try {
        new URL(url);
      } catch {
        return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
      }
    }

    const updated = await updateClashSubscription(id, {
      ...(url && { url: url.trim() }),
      ...(name && { name: name.trim() }),
      ...(enabled !== undefined && { enabled }),
    });

    if (!updated) {
      return NextResponse.json({ error: "Subscription not found" }, { status: 404 });
    }

    return NextResponse.json({ subscription: updated });
  } catch (error) {
    console.error("[clash-sub/:id] PUT error:", error);
    return NextResponse.json({ error: "Failed to update subscription" }, { status: 500 });
  }
}

// DELETE /api/clash-subscriptions/[id]
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const removed = await deleteClashSubscription(id);

    if (!removed) {
      return NextResponse.json({ error: "Subscription not found" }, { status: 404 });
    }

    return NextResponse.json({ subscription: removed });
  } catch (error) {
    console.error("[clash-sub/:id] DELETE error:", error);
    return NextResponse.json({ error: "Failed to delete subscription" }, { status: 500 });
  }
}
