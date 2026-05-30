"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card } from "@/shared/components";

// SSL / HTTPS reverse-proxy card.
//
// User flow:
//   1. type a domain, click "检测域名" — the server resolves A/AAAA
//      and reports whether they match this host's public IP.
//   2. pick mode (acme / manual)
//        acme:   email + ports
//        manual: paste cert + key (or upload .pem files)
//   3. save → 启用 → caddy starts via supervisor.
//
// Once caddy is running, the configured https://<domain> serves the
// dashboard at /. SSL settings live under /app/data/caddy so they
// survive restarts.

export default function SslCard({ notify }) {
  const [config, setConfig] = useState(null);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);

  const [domain, setDomain] = useState("");
  const [httpsPort, setHttpsPort] = useState(443);
  const [httpPort, setHttpPort] = useState(80);
  const [mode, setMode] = useState("acme");
  const [acmeEmail, setAcmeEmail] = useState("");
  const [upstream, setUpstream] = useState("127.0.0.1:20128");
  const [autoStart, setAutoStart] = useState(false);

  const [cert, setCert] = useState("");
  const [key, setKey] = useState("");

  const [domainCheck, setDomainCheck] = useState(null);
  const [checking, setChecking] = useState(false);

  const fetchAll = useCallback(async () => {
    try {
      const res = await fetch("/api/ssl", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) {
        setConfig(data.config);
        setStatus(data.status);
        setDomain(data.config.domain || "");
        setHttpsPort(data.config.httpsPort ?? 443);
        setHttpPort(data.config.httpPort ?? 80);
        setMode(data.config.mode || "acme");
        setAcmeEmail(data.config.acmeEmail || "");
        setUpstream(data.config.upstream || "127.0.0.1:20128");
        setAutoStart(!!data.config.autoStart);
      }
    } catch (e) { /* keep prev */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Poll status while caddy is RUNNING/STARTING so the chip stays fresh
  useEffect(() => {
    if (!status) return;
    if (["RUNNING", "STARTING", "BACKOFF"].includes(status.state)) {
      const t = setInterval(fetchAll, 6000);
      return () => clearInterval(t);
    }
  }, [status, fetchAll]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/ssl", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: domain.trim(),
          httpsPort: parseInt(httpsPort, 10),
          httpPort: parseInt(httpPort, 10),
          mode,
          acmeEmail: acmeEmail.trim(),
          upstream: upstream.trim() || "127.0.0.1:20128",
          autoStart,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setConfig(data.config);
        notify?.success?.("Saved");
      } else {
        notify?.error?.(data.error || "Save failed");
      }
    } catch (e) {
      notify?.error?.(e.message);
    } finally {
      setSaving(false);
    }
  };

  const checkDomain = async () => {
    if (!domain.trim()) { notify?.error?.("Enter a domain first"); return; }
    setChecking(true);
    setDomainCheck(null);
    try {
      const res = await fetch("/api/ssl/check-domain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: domain.trim() }),
      });
      const data = await res.json();
      if (res.ok) setDomainCheck(data);
      else notify?.error?.(data.error || "Check failed");
    } catch (e) {
      notify?.error?.(e.message);
    } finally {
      setChecking(false);
    }
  };

  const uploadCert = async () => {
    if (!cert.trim() || !key.trim()) { notify?.error?.("Paste both certificate and private key"); return; }
    setBusy(true);
    try {
      const res = await fetch("/api/ssl/upload-cert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cert, key }),
      });
      const data = await res.json();
      if (res.ok) {
        notify?.success?.("Certificate saved — enable SSL to load it");
        setCert("");
        setKey("");
        await fetchAll();
      } else {
        notify?.error?.(data.error || "Save failed");
      }
    } catch (e) {
      notify?.error?.(e.message);
    } finally {
      setBusy(false);
    }
  };

  const enable = async () => {
    if (!config?.domain) { notify?.error?.("Save a domain first"); return; }
    if (mode === "manual" && !config?.hasManualCert) {
      notify?.error?.("Manual mode requires a certificate first"); return;
    }
    if (mode === "acme" && !domainCheck?.matches) {
      if (!confirm("DNS check did not pass. Enabling ACME may trigger Let's Encrypt rate-limits. Continue?")) return;
    }
    setBusy(true);
    try {
      // flip enabled=true then start
      const r1 = await fetch("/api/ssl", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      if (!r1.ok) {
        const e = await r1.json().catch(() => ({}));
        notify?.error?.(e.error || "Save failed");
        return;
      }
      const res = await fetch("/api/ssl/start", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        notify?.success?.("Caddy started");
      } else {
        notify?.error?.(data.error || "Start failed");
      }
      await fetchAll();
    } catch (e) {
      notify?.error?.(e.message);
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (!confirm("Stop Caddy? The HTTPS domain will become unreachable.")) return;
    setBusy(true);
    try {
      const res = await fetch("/api/ssl/stop", { method: "POST" });
      const data = await res.json();
      if (res.ok) notify?.success?.("Caddy stopped");
      else notify?.error?.(data.error || "Stop failed");
      await fetchAll();
    } catch (e) {
      notify?.error?.(e.message);
    } finally {
      setBusy(false);
    }
  };

  const running = status?.state === "RUNNING";

  return (
    <Card>
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h3 className="font-semibold text-base flex items-center gap-2">
            🔒 SSL / HTTPS
            {running ? (
              <Badge variant="success" size="sm">Running</Badge>
            ) : status?.state ? (
              <Badge variant="default" size="sm">{status.state}</Badge>
            ) : null}
          </h3>
          <p className="text-xs text-text-muted mt-1">
            Bind a domain + HTTPS for the dashboard / API. Caddy auto-issues and renews Let's Encrypt certificates, or you can upload your own.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {running ? (
            <Button size="sm" variant="danger" onClick={disable} disabled={busy}>
              Stop
            </Button>
          ) : (
            <Button size="sm" onClick={enable} disabled={busy || !config?.domain}>
              Enable SSL
            </Button>
          )}
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-text-muted">Loading...</p>
      ) : (
        <div className="flex flex-col gap-4">
          {/* domain */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1 min-w-0">
              <label className="text-xs text-text-muted">Domain</label>
              <input
                type="text"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="api.example.com"
                className="w-full px-3 py-2 text-sm bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:outline-none"
              />
            </div>
            <Button onClick={checkDomain} variant="secondary" disabled={checking || !domain.trim()}>
              {checking ? "Checking..." : "Check domain"}
            </Button>
          </div>

          {domainCheck && (
            <div className={`rounded-md border px-3 py-2 text-sm flex items-center gap-2 ${
              domainCheck.matches
                ? "border-emerald-300 dark:border-emerald-800 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400"
                : "border-amber-300 dark:border-amber-800 bg-amber-500/5 text-amber-600 dark:text-amber-400"
            }`}>
              <span className="material-symbols-outlined text-[18px]">
                {domainCheck.matches ? "check_circle" : "warning"}
              </span>
              {domainCheck.matches ? (
                <span>
                  ✓ Domain <code>{domainCheck.domain}</code> resolves to this host
                  <span className="text-xs ml-2">resolved={domainCheck.resolved.join(", ")} / ours={domainCheck.ownIp}</span>
                </span>
              ) : (
                <div className="flex-1">
                  <p>⚠ Domain <code>{domainCheck.domain}</code> does NOT point at this host</p>
                  <p className="text-xs mt-0.5">
                    resolved={domainCheck.resolved.length ? domainCheck.resolved.join(", ") : "(no A/AAAA records)"} / ours={domainCheck.ownIp || "?"}
                    {" "}— please update the A record to this host's IP, otherwise ACME will fail.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* ports + upstream */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div>
              <label className="text-xs text-text-muted">HTTPS port</label>
              <input
                type="number"
                value={httpsPort}
                onChange={(e) => setHttpsPort(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:outline-none"
              />
            </div>
            <div>
              <label className="text-xs text-text-muted">HTTP port (for ACME)</label>
              <input
                type="number"
                value={httpPort}
                onChange={(e) => setHttpPort(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:outline-none"
              />
            </div>
            <div>
              <label className="text-xs text-text-muted">Reverse-proxy upstream</label>
              <input
                type="text"
                value={upstream}
                onChange={(e) => setUpstream(e.target.value)}
                placeholder="127.0.0.1:20128"
                className="w-full px-3 py-2 text-sm bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:outline-none"
              />
            </div>
          </div>

          {/* mode */}
          <div>
            <label className="text-xs text-text-muted">Certificate source</label>
            <div className="flex gap-3 mt-1">
              <label className={`flex-1 flex items-center gap-2 px-3 py-2 rounded-md border cursor-pointer ${
                mode === "acme"
                  ? "border-primary bg-primary/5"
                  : "border-black/10 dark:border-white/10"
              }`}>
                <input type="radio" checked={mode === "acme"} onChange={() => setMode("acme")} />
                <div>
                  <p className="text-sm font-medium">ACME (Let's Encrypt)</p>
                  <p className="text-xs text-text-muted">Port 80 must be reachable, A record must point here</p>
                </div>
              </label>
              <label className={`flex-1 flex items-center gap-2 px-3 py-2 rounded-md border cursor-pointer ${
                mode === "manual"
                  ? "border-primary bg-primary/5"
                  : "border-black/10 dark:border-white/10"
              }`}>
                <input type="radio" checked={mode === "manual"} onChange={() => setMode("manual")} />
                <div>
                  <p className="text-sm font-medium">Upload certificate</p>
                  <p className="text-xs text-text-muted">Use existing .pem cert + private key</p>
                </div>
              </label>
            </div>
          </div>

          {mode === "acme" && (
            <div>
              <label className="text-xs text-text-muted">ACME email (optional, for renewal alerts)</label>
              <input
                type="email"
                value={acmeEmail}
                onChange={(e) => setAcmeEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full px-3 py-2 text-sm bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:outline-none"
              />
            </div>
          )}

          {mode === "manual" && (
            <div className="flex flex-col gap-2 rounded-md border border-black/10 dark:border-white/10 p-3">
              <p className="text-xs text-text-muted">
                Uploaded: {config?.hasManualCert ? "✓" : "not yet"}
              </p>
              <div>
                <label className="text-xs text-text-muted">Certificate (PEM .crt)</label>
                <textarea
                  value={cert}
                  onChange={(e) => setCert(e.target.value)}
                  placeholder="-----BEGIN CERTIFICATE-----..."
                  className="w-full min-h-[100px] py-2 px-3 text-xs font-mono bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md"
                />
              </div>
              <div>
                <label className="text-xs text-text-muted">Private key (PEM .key)</label>
                <textarea
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="-----BEGIN PRIVATE KEY-----..."
                  className="w-full min-h-[100px] py-2 px-3 text-xs font-mono bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md"
                />
              </div>
              <div className="flex justify-end">
                <Button onClick={uploadCert} disabled={busy || !cert.trim() || !key.trim()}>
                  Save certificate
                </Button>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between gap-3 rounded-md border border-black/10 dark:border-white/10 px-3 py-2">
            <label className="flex items-center gap-2 cursor-pointer flex-1 min-w-0">
              <input
                type="checkbox"
                checked={autoStart}
                onChange={(e) => setAutoStart(e.target.checked)}
              />
              <div className="min-w-0">
                <p className="text-sm font-medium">Auto-start on panel boot</p>
                <p className="text-xs text-text-muted">
                  When enabled, Caddy starts automatically with the dashboard. Requires a saved domain (and an uploaded cert in manual mode).
                </p>
              </div>
            </label>
          </div>

          <div className="flex justify-end">
            <Button onClick={save} disabled={saving}>{saving ? "Saving..." : "Save settings"}</Button>
          </div>

          {running && config?.domain && (
            <div className="rounded-md border border-emerald-300 dark:border-emerald-800 bg-emerald-500/5 px-3 py-2 text-sm">
              ✓ HTTPS ready — <a
                href={`https://${config.domain}${config.httpsPort === 443 ? "" : `:${config.httpsPort}`}/`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline"
              >
                https://{config.domain}{config.httpsPort === 443 ? "" : `:${config.httpsPort}`}/
              </a>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
