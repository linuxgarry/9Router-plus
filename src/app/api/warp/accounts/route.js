import { NextResponse } from "next/server";
import {
  listAccounts,
  registerAccount,
} from "@/lib/warp/accounts";
import { rebuildAndReloadMihomo } from "@/lib/clash/importYaml";

export async function GET() {
  try {
    return NextResponse.json({ accounts: await listAccounts() });
  } catch (error) {
    console.error("[warp/accounts] GET error:", error);
    return NextResponse.json({ error: "Failed to list accounts" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const account = await registerAccount({ name: body?.name });
    rebuildAndReloadMihomo().catch(() => {});
    return NextResponse.json({ account }, { status: 201 });
  } catch (error) {
    console.error("[warp/accounts] POST error:", error);
    return NextResponse.json({ error: error.message || "Register failed" }, { status: 500 });
  }
}
