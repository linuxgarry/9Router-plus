import { parseYAML } from "confbox";
import {
  createProxyPool,
  getProxyPools,
} from "@/models";
import { buildConfig, writeConfig, reload, normaliseProxy } from "@/lib/mihomo";
import { isEnabled as isWarpEnabled, getActiveConfig as getWarpConfig } from "@/lib/warp";

export function parseClashYaml(rawYaml) {
  let doc;
  try {
    doc = parseYAML(rawYaml);
  } catch (err) {
    throw new Error(`Invalid YAML: ${err.message}`);
  }
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.proxies)) {
    throw new Error("No proxies array found in YAML");
  }
  return doc.proxies;
}

export async function importProxiesIntoPool(proxies, { source = null } = {}) {
  const existingPools = await getProxyPools();
  const existingNames = new Set(existingPools.map((p) => p.name));
  let imported = 0;

  for (const proxy of proxies) {
    if (!proxy?.name) continue;

    let name = proxy.name;
    let counter = 1;
    while (existingNames.has(name)) {
      name = `${proxy.name}__${counter++}`;
    }

    try {
      await createProxyPool({
        name,
        clashProxy: proxy,
        source,
        country: proxy.country || null,
        isActive: true,
      });
      existingNames.add(name);
      imported++;
    } catch (err) {
      console.warn(`[clash-import] Failed to import proxy ${proxy.name}:`, err.message);
    }
  }

  return imported;
}

export async function rebuildAndReloadMihomo() {
  try {
    const allPools = await getProxyPools({ isActive: true });
    const normalised = allPools.map((p) => normaliseProxy(p)).filter(Boolean);

    let warp = null;
    let warpEnabled = false;
    try {
      warpEnabled = isWarpEnabled();
      if (warpEnabled) warp = getWarpConfig();
    } catch (err) {
      console.warn("[clash-import] Failed to read WARP state:", err.message);
    }

    const { yaml: configYaml } = buildConfig({
      proxies: normalised,
      warp,
      warpEnabled,
      topListeners: [],
      testUrl: "http://www.gstatic.com/generate_204",
    });
    writeConfig(configYaml);
    await reload();
    return true;
  } catch (err) {
    console.warn("[clash-import] Failed to reload mihomo:", err.message);
    return false;
  }
}
