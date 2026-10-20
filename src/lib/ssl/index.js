/**
 * SSL / HTTPS reverse-proxy management.
 *
 * Pairs the bundled caddy with a stored config in /app/data/caddy/.
 * The user picks one of three modes through the UI:
 *
 *   - acme: caddy auto-fetches and renews a Let's Encrypt cert via
 *           HTTP-01 (port 80 must be reachable from the public
 *           internet, A record must point at this host).
 *   - manual: user pastes/uploads cert + private key. Caddy serves
 *             them directly, no ACME involvement.
 *   - off: caddy not running.
 *
 * Caddy is launched/stopped via supervisorctl; the [program:caddy]
 * entry has autostart=false so a fresh container does not try to
 * bind :443 before any domain is configured.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import dns from "node:dns/promises";
import { DATA_DIR } from "@/lib/dataDir.js";

const CADDY_DIR = path.join(DATA_DIR, "caddy");
const CONFIG_FILE = path.join(CADDY_DIR, "config.json");
const CADDYFILE = path.join(CADDY_DIR, "Caddyfile");
const CERTS_DIR = path.join(CADDY_DIR, "manual-certs");
const CADDY_BIN = "/usr/local/bin/caddy";
const SUPERVISOR_SOCK = "/app/data/supervisor.sock";
const SUPERVISOR_CONF = "/etc/supervisor/conf.d/9router.conf";
const SUPERVISORCTL = "/usr/bin/supervisorctl";

function ensureDir() {
  if (!fs.existsSync(CADDY_DIR)) fs.mkdirSync(CADDY_DIR, { recursive: true });
  if (!fs.existsSync(CERTS_DIR)) fs.mkdirSync(CERTS_DIR, { recursive: true });
}

const DEFAULTS = {
  enabled: false,
  autoStart: false,
  domain: "",
  httpsPort: 443,
  httpPort: 80,
  mode: "acme", // "acme" | "manual"
  acmeEmail: "",
  manualCertPath: null,
  manualKeyPath: null,
  upstream: "127.0.0.1:20128",
};

export function getConfig() {
  ensureDir();
  if (!fs.existsSync(CONFIG_FILE)) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(patch) {
  ensureDir();
  const cur = getConfig();
  const next = { ...cur, ...patch };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
  return next;
}

export function saveManualCert({ cert, key }) {
  ensureDir();
  if (!cert || !key) throw new Error("cert and key are both required");
  if (!/-----BEGIN CERTIFICATE-----/.test(cert)) throw new Error("cert does not look like a PEM certificate");
  if (!/-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/.test(key)) throw new Error("key does not look like a PEM private key");
  const certPath = path.join(CERTS_DIR, "cert.pem");
  const keyPath = path.join(CERTS_DIR, "key.pem");
  fs.writeFileSync(certPath, cert, { mode: 0o600 });
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  return { certPath, keyPath };
}

/**
 * Render a Caddyfile that proxies the configured domain to upstream.
 *
 * For ACME mode we let caddy do its thing — it manages its own ACME
 * client + persists the cert under XDG_DATA_HOME (which entrypoint.sh
 * pins to /app/data/caddy/data so renewals survive restarts).
 *
 * For manual mode we feed it the user-supplied cert + key and turn off
 * the ACME issuer entirely.
 */
export function renderCaddyfile(cfg) {
  const c = cfg || getConfig();
  if (!c.domain || !c.enabled) return null;

  const httpsAddr = c.httpsPort === 443 ? "" : `:${c.httpsPort}`;
  const lines = [];

  // global options
  lines.push("{");
  lines.push(`  http_port ${c.httpPort}`);
  lines.push(`  https_port ${c.httpsPort}`);
  if (c.mode === "acme" && c.acmeEmail) {
    lines.push(`  email ${c.acmeEmail}`);
  }
  lines.push("}");
  lines.push("");

  // site block
  lines.push(`${c.domain}${httpsAddr} {`);
  if (c.mode === "manual" && c.manualCertPath && c.manualKeyPath) {
    lines.push(`  tls ${c.manualCertPath} ${c.manualKeyPath}`);
  }
  // websocket-friendly reverse proxy to the dashboard / API
  lines.push(`  reverse_proxy ${c.upstream} {`);
  lines.push(`    header_up Host {host}`);
  lines.push(`    header_up X-Real-IP {remote_host}`);
  lines.push(`    header_up X-Forwarded-For {remote_host}`);
  lines.push(`    header_up X-Forwarded-Proto https`);
  lines.push(`  }`);
  lines.push(`}`);

  return lines.join("\n") + "\n";
}

export function writeCaddyfile() {
  ensureDir();
  const cfg = getConfig();
  const text = renderCaddyfile(cfg);
  if (!text) {
    if (fs.existsSync(CADDYFILE)) fs.unlinkSync(CADDYFILE);
    return null;
  }
  fs.writeFileSync(CADDYFILE, text);
  return CADDYFILE;
}

function supervisorctl(...args) {
  try {
    return execFileSync(SUPERVISORCTL, ["-c", SUPERVISOR_CONF, ...args], {
      encoding: "utf8",
      timeout: 10000,
    });
  } catch (e) {
    throw new Error(e.stderr?.toString() || e.message);
  }
}

export function startCaddy() {
  writeCaddyfile();
  // Validate the file before asking supervisor to start the process —
  // a typo means caddy crashloops, which is harder to surface than
  // failing here with the validation error verbatim.
  try {
    execFileSync(CADDY_BIN, ["validate", "--config", CADDYFILE, "--adapter", "caddyfile"], {
      encoding: "utf8",
      timeout: 10000,
    });
  } catch (e) {
    throw new Error(`Caddyfile validation failed: ${e.stderr?.toString() || e.message}`);
  }
  return supervisorctl("restart", "caddy");
}

export function stopCaddy() {
  return supervisorctl("stop", "caddy");
}

export function caddyStatus() {
  try {
    const out = supervisorctl("status", "caddy");
    // line: "caddy   RUNNING   pid 123, uptime 0:01:23"
    const m = out.trim().match(/^caddy\s+(\w+)/);
    return { state: m ? m[1] : "UNKNOWN", raw: out.trim() };
  } catch (e) {
    return { state: "UNKNOWN", error: e.message };
  }
}

export async function getOwnPublicIp() {
  // Best-effort: ask icanhazip (doesn't trust XFF) for our public IP
  // so we can compare it to the domain's A record.
  try {
    const r = await fetch("https://icanhazip.com/", { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    return (await r.text()).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Boot-time hook: if the user previously enabled SSL and turned on
 * "auto-start", bring caddy back up at panel startup. Tolerates a stale
 * config (missing manual cert, broken Caddyfile, supervisor not ready)
 * by logging the failure rather than blocking the rest of the init.
 */
export function autoStartCaddyIfEnabled() {
  let cfg;
  try { cfg = getConfig(); } catch (e) {
    console.log("[SSL] auto-start skipped: read config failed:", e.message);
    return false;
  }
  if (!cfg.autoStart) return false;
  if (!cfg.enabled) return false;
  if (!cfg.domain) {
    console.log("[SSL] auto-start skipped: no domain configured");
    return false;
  }
  if (cfg.mode === "manual" && (!cfg.manualCertPath || !cfg.manualKeyPath)) {
    console.log("[SSL] auto-start skipped: manual mode but cert not uploaded");
    return false;
  }
  // If supervisor already has caddy running, don't bounce it.
  try {
    const st = caddyStatus();
    if (st.state === "RUNNING" || st.state === "STARTING") {
      console.log(`[SSL] auto-start: caddy already ${st.state}`);
      return true;
    }
  } catch { /* fall through to start */ }
  try {
    startCaddy();
    console.log("[SSL] auto-started caddy");
    return true;
  } catch (e) {
    console.log("[SSL] auto-start failed:", e.message);
    return false;
  }
}

/**
 * Resolve the user's domain and tell the UI whether it points at this
 * host. Used as a sanity check before flipping ACME on — if the A
 * record is wrong, HTTP-01 will fail and Let's Encrypt will rate-limit.
 */
export async function checkDomainBinding(domain) {
  const out = {
    domain,
    resolved: [],
    ownIp: null,
    matches: false,
    error: null,
  };
  if (!domain) { out.error = "domain required"; return out; }
  try {
    const a = await dns.resolve4(domain).catch(() => []);
    const aaaa = await dns.resolve6(domain).catch(() => []);
    out.resolved = [...a, ...aaaa];
  } catch (e) {
    out.error = e.message;
    return out;
  }
  out.ownIp = await getOwnPublicIp();
  if (out.ownIp && out.resolved.includes(out.ownIp)) out.matches = true;
  return out;
}
