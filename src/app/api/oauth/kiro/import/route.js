import { NextResponse } from "next/server";
import { KiroService, normalizeKiroProvider } from "@/lib/oauth/services/kiro";
import { createProviderConnection } from "@/models";

const PROVIDER_DISPLAY = {
  "builder-id": "BuilderId",
  "idc": "Enterprise",
  "github": "Github",
  "google": "Google",
};

const PROVIDER_KEYS = ["accounts", "items", "data", "records", "tokens"];

/**
 * Split a string that may contain multiple top-level JSON values back-to-back
 * (e.g. two KAM exports pasted one after the other, with whitespace, newlines,
 * or commas between them).
 */
function splitJsonValues(text) {
  const out = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{" || ch === "[") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

/**
 * Pull a credentials record out of a KAM-style account object, where the
 * actual token / clientId / clientSecret live under `credentials.`. Falls back
 * to top-level fields for plain records.
 */
function flattenAccountRecord(raw) {
  if (!raw || typeof raw !== "object") return null;
  const creds = raw.credentials && typeof raw.credentials === "object" ? raw.credentials : {};
  const refreshToken =
    (typeof raw.refreshToken === "string" && raw.refreshToken.trim()) ||
    (typeof creds.refreshToken === "string" && creds.refreshToken.trim()) ||
    "";
  if (!refreshToken) return null;
  return {
    refreshToken,
    // KAM uses `idp` (BuilderId/Enterprise/Github/Google); plain records use `provider`.
    provider: raw.provider || creds.provider || raw.idp,
    clientId: raw.clientId || creds.clientId,
    clientSecret: raw.clientSecret || creds.clientSecret,
    region: raw.region || creds.region,
    startUrl: raw.startUrl || creds.startUrl,
    email: raw.email || creds.email,
  };
}

/**
 * Coerce arbitrary input into a list of credential records.
 * Accepts:
 *   - "..."                                  bare refresh token
 *   - { refreshToken, provider?, ... }       single record
 *   - [ { refreshToken, ... }, ... ]         array
 *   - KAM export: { accounts: [{ idp, credentials: { refreshToken, ... } }] }
 *   - Multiple JSON blobs concatenated (newline, whitespace, comma separated)
 *   - NDJSON
 */
function normalizeImportPayload(input) {
  let value = input;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        value = JSON.parse(trimmed);
      } catch {
        // Multiple JSON values back-to-back, NDJSON, or list-with-commas.
        const chunks = splitJsonValues(trimmed);
        if (chunks.length === 0) return [];
        const out = [];
        for (const chunk of chunks) {
          try { out.push(...normalizeImportPayload(JSON.parse(chunk))); } catch { /* skip */ }
        }
        return out;
      }
    } else {
      return [{ refreshToken: trimmed }];
    }
  }

  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) {
      // Allow nested wrappers inside arrays (e.g. array of KAM exports).
      if (item && typeof item === "object" && PROVIDER_KEYS.some(k => Array.isArray(item[k]))) {
        out.push(...normalizeImportPayload(item));
        continue;
      }
      const flat = flattenAccountRecord(item);
      if (flat) out.push(flat);
    }
    return out;
  }

  if (value && typeof value === "object") {
    // KAM-style wrapper: recurse into the contained array.
    for (const key of PROVIDER_KEYS) {
      if (Array.isArray(value[key])) return normalizeImportPayload(value[key]);
    }
    // Plain record (top-level refreshToken or nested credentials.refreshToken).
    const flat = flattenAccountRecord(value);
    if (flat) return [flat];
    // { "<id>": { refreshToken / credentials } } map shape
    const collected = [];
    for (const v of Object.values(value)) {
      const f = flattenAccountRecord(v);
      if (f) collected.push(f);
    }
    if (collected.length) return collected;
  }

  return [];
}

async function importOne(kiroService, raw, fallbackEmail) {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid record");
  }
  const refreshToken = typeof raw.refreshToken === "string" ? raw.refreshToken.trim() : "";
  if (!refreshToken) {
    throw new Error("refreshToken is required");
  }

  const provider = normalizeKiroProvider(raw.provider);
  const tokenData = await kiroService.validateImportToken(refreshToken, {
    provider: raw.provider,
    clientId: raw.clientId,
    clientSecret: raw.clientSecret,
    region: raw.region,
    startUrl: raw.startUrl,
  });

  const email =
    (typeof raw.email === "string" && raw.email.trim()) ||
    kiroService.extractEmailFromJWT(tokenData.accessToken) ||
    fallbackEmail ||
    null;

  const providerLabel = provider ? PROVIDER_DISPLAY[provider] : "Imported";

  const providerSpecificData = {
    profileArn: tokenData.profileArn,
    authMethod: tokenData.authMethod || "imported",
    provider: providerLabel,
  };
  if (tokenData.clientId) providerSpecificData.clientId = tokenData.clientId;
  if (tokenData.clientSecret) providerSpecificData.clientSecret = tokenData.clientSecret;
  if (tokenData.region) providerSpecificData.region = tokenData.region;
  if (tokenData.startUrl) providerSpecificData.startUrl = tokenData.startUrl;

  const connection = await createProviderConnection({
    provider: "kiro",
    authType: "oauth",
    accessToken: tokenData.accessToken,
    refreshToken: tokenData.refreshToken,
    expiresAt: new Date(Date.now() + tokenData.expiresIn * 1000).toISOString(),
    email,
    providerSpecificData,
    testStatus: "active",
  });

  return {
    id: connection.id,
    provider: connection.provider,
    email: connection.email,
    authProvider: providerLabel,
  };
}

/**
 * POST /api/oauth/kiro/import
 * Import and validate refresh token(s) from Kiro IDE / Kiro Account Manager.
 *
 * Body shapes (all accepted):
 *   - { refreshToken: "..." }                       legacy single token
 *   - { refreshToken, provider, clientId, clientSecret, ... }  single with creds
 *   - [ { refreshToken, ... }, ... ]                array
 *   - { accounts: [ ... ] }                         Kiro Account Manager export
 *   - { payload: <any of the above> } | { json: "..." }    explicit wrapper
 */
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Allow callers to pass the export under `payload` / `json` to avoid clashing
  // with the legacy `refreshToken` shape.
  let source = body;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    if (body.payload !== undefined) source = body.payload;
    else if (typeof body.json === "string") source = body.json;
  }

  const records = normalizeImportPayload(source);
  if (records.length === 0) {
    return NextResponse.json(
      { error: "Refresh token is required" },
      { status: 400 }
    );
  }

  const kiroService = new KiroService();
  const imported = [];
  const failed = [];

  for (let i = 0; i < records.length; i++) {
    try {
      const conn = await importOne(kiroService, records[i]);
      imported.push(conn);
    } catch (error) {
      console.log("Kiro import token error:", error);
      failed.push({ index: i, error: error.message });
    }
  }

  // Preserve legacy shape when a single record is imported.
  if (records.length === 1 && imported.length === 1) {
    return NextResponse.json({
      success: true,
      connection: imported[0],
      imported,
      failed,
    });
  }

  if (imported.length === 0) {
    return NextResponse.json(
      {
        success: false,
        imported,
        failed,
        error: failed[0]?.error || "Import failed",
      },
      { status: 400 }
    );
  }

  return NextResponse.json({
    success: true,
    imported,
    failed,
    total: records.length,
  });
}
