import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import {
  createClashSubscription,
  updateClashSubscription,
} from "@/models";
import {
  parseClashYaml,
  importProxiesIntoPool,
  rebuildAndReloadMihomo,
} from "@/lib/clash/importYaml";

const MAX_BYTES = 8 * 1024 * 1024;

export async function POST(request) {
  try {
    let yaml;
    let name;
    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      const body = await request.json();
      yaml = body?.yaml;
      name = body?.name;
    } else if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (file && typeof file.text === "function") {
        yaml = await file.text();
      } else {
        yaml = form.get("yaml");
      }
      name = form.get("name");
    } else {
      yaml = await request.text();
    }

    if (!yaml || typeof yaml !== "string" || !yaml.trim()) {
      return NextResponse.json({ error: "YAML body is required" }, { status: 400 });
    }
    if (yaml.length > MAX_BYTES) {
      return NextResponse.json({ error: "YAML too large (max 8MB)" }, { status: 413 });
    }

    let proxies;
    try {
      proxies = parseClashYaml(yaml);
    } catch (err) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }

    const id = uuidv4();
    const subName = (typeof name === "string" && name.trim()) || `手工 YAML ${new Date().toLocaleString()}`;

    await createClashSubscription({
      id,
      url: `manual://${id}`,
      name: subName,
      rawYaml: yaml,
    });

    const imported = await importProxiesIntoPool(proxies);

    await updateClashSubscription(id, {
      nodeCount: imported,
      lastLoadedAt: new Date().toISOString(),
      rawYaml: yaml,
    });

    await rebuildAndReloadMihomo();

    return NextResponse.json(
      { ok: true, id, imported, message: `Imported ${imported} proxies from manual YAML` },
      { status: 201 }
    );
  } catch (error) {
    console.error("[clash-sub/import-yaml] error:", error);
    return NextResponse.json({ error: "Failed to import YAML" }, { status: 500 });
  }
}
