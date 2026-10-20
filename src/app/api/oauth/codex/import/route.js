import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";

/**
 * Decode the email out of a Codex (OpenAI) access JWT.
 * The token is signed RS256; we just want the unverified payload's
 * `https://api.openai.com/profile.email` claim, which is what the
 * Codex CLI itself uses to label the connection.
 */
function emailFromAccessToken(accessToken) {
  if (typeof accessToken !== "string") return null;
  const parts = accessToken.split(".");
  if (parts.length !== 3) return null;
  try {
    let payload = parts[1];
    while (payload.length % 4) payload += "=";
    const decoded = JSON.parse(
      Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
    );
    const profile = decoded["https://api.openai.com/profile"];
    if (profile && typeof profile.email === "string" && profile.email) return profile.email;
    if (typeof decoded.email === "string" && decoded.email) return decoded.email;
    return null;
  } catch {
    return null;
  }
}

/**
 * Pull the chatgpt account / plan IDs out of the auth claims so the
 * existing token-refresh path can keep using them. Mirrors what the
 * exchange endpoint stores under providerSpecificData.
 */
function providerDataFromAccessToken(accessToken) {
  if (typeof accessToken !== "string") return {};
  const parts = accessToken.split(".");
  if (parts.length !== 3) return {};
  try {
    let payload = parts[1];
    while (payload.length % 4) payload += "=";
    const decoded = JSON.parse(
      Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
    );
    const auth = decoded["https://api.openai.com/auth"] || {};
    const out = {};
    if (auth.chatgpt_account_id) out.chatgptAccountId = auth.chatgpt_account_id;
    if (auth.chatgpt_plan_type) out.chatgptPlanType = auth.chatgpt_plan_type;
    if (auth.chatgpt_user_id) out.chatgptUserId = auth.chatgpt_user_id;
    return out;
  } catch {
    return {};
  }
}

/**
 * Coerce arbitrary input into a list of codex token records.
 * Supports:
 *   - { accessToken, refreshToken, ... }                    single object
 *   - [ {...}, ... ]                                        array
 *   - { accounts: [...] } / { items / data / records: [...] }
 *   - "..."                                                 JSON string of any of the above
 *   - Multiple JSON blobs concatenated (newline / whitespace / comma separated)
 */
const WRAPPER_KEYS = ["accounts", "items", "data", "records", "tokens"];

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

function normalizeImportPayload(input) {
  let value = input;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        value = JSON.parse(trimmed);
      } catch {
        const chunks = splitJsonValues(trimmed);
        if (chunks.length === 0) return [];
        const out = [];
        for (const chunk of chunks) {
          try { out.push(...normalizeImportPayload(JSON.parse(chunk))); } catch { /* skip */ }
        }
        return out;
      }
    } else {
      return [];
    }
  }

  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) {
      if (item && typeof item === "object" && WRAPPER_KEYS.some(k => Array.isArray(item[k]))) {
        out.push(...normalizeImportPayload(item));
        continue;
      }
      if (item && typeof item === "object" && typeof item.accessToken === "string") {
        out.push(item);
      }
    }
    return out;
  }

  if (value && typeof value === "object") {
    for (const key of WRAPPER_KEYS) {
      if (Array.isArray(value[key])) return normalizeImportPayload(value[key]);
    }
    if (typeof value.accessToken === "string") return [value];
    // map shape: { "<id>": { accessToken } }
    const out = [];
    for (const v of Object.values(value)) {
      if (v && typeof v === "object" && typeof v.accessToken === "string") out.push(v);
    }
    if (out.length) return out;
  }

  return [];
}

function resolveExpiresAt(raw) {
  if (raw.expiresAt) {
    const t = Date.parse(raw.expiresAt);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  if (typeof raw.expiresIn === "number" && raw.expiresIn > 0) {
    return new Date(Date.now() + raw.expiresIn * 1000).toISOString();
  }
  return null;
}

async function importOne(raw) {
  if (!raw || typeof raw !== "object") throw new Error("Invalid record");
  const accessToken = typeof raw.accessToken === "string" ? raw.accessToken.trim() : "";
  const refreshToken = typeof raw.refreshToken === "string" ? raw.refreshToken.trim() : "";
  if (!accessToken) throw new Error("accessToken is required");
  if (!refreshToken) throw new Error("refreshToken is required");

  const claimsEmail = emailFromAccessToken(accessToken);
  const email =
    (typeof raw.email === "string" && raw.email.trim()) ||
    claimsEmail ||
    null;

  const claimData = providerDataFromAccessToken(accessToken);
  const providerSpecificData = {
    ...claimData,
    ...(raw.providerSpecificData && typeof raw.providerSpecificData === "object"
      ? raw.providerSpecificData
      : {}),
  };

  const data = {
    provider: "codex",
    authType: "oauth",
    accessToken,
    refreshToken,
    expiresAt: resolveExpiresAt(raw),
    email,
    name: typeof raw.name === "string" && raw.name ? raw.name : email || undefined,
    testStatus: "active",
  };
  if (Object.keys(providerSpecificData).length) {
    data.providerSpecificData = providerSpecificData;
  }

  const connection = await createProviderConnection(data);
  return {
    id: connection.id,
    provider: connection.provider,
    email: connection.email,
  };
}

/**
 * POST /api/oauth/codex/import
 *
 * Body shapes (all accepted):
 *   - { accessToken, refreshToken, ... }              single record
 *   - [ {...}, ... ]                                  array
 *   - { accounts: [...] }                             wrapped export
 *   - { payload: <any of the above> } | { json: "..." }  explicit wrapper
 */
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  let source = body;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    if (body.payload !== undefined) source = body.payload;
    else if (typeof body.json === "string") source = body.json;
  }

  const records = normalizeImportPayload(source);
  if (records.length === 0) {
    return NextResponse.json(
      { error: "No codex tokens found in payload (expected accessToken + refreshToken)" },
      { status: 400 }
    );
  }

  const imported = [];
  const failed = [];
  for (let i = 0; i < records.length; i++) {
    try {
      imported.push(await importOne(records[i]));
    } catch (e) {
      console.log("[codex/import] record failed:", e.message);
      failed.push({ index: i, error: e.message });
    }
  }

  if (records.length === 1 && imported.length === 1) {
    return NextResponse.json({ success: true, connection: imported[0], imported, failed });
  }
  if (imported.length === 0) {
    return NextResponse.json(
      { success: false, imported, failed, error: failed[0]?.error || "Import failed" },
      { status: 400 }
    );
  }
  return NextResponse.json({ success: true, imported, failed, total: records.length });
}
