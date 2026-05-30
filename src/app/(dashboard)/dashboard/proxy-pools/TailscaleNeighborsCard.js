"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Card } from "@/shared/components";

// Tailscale neighbour proxy probe card.
//
// Flow:
//   1. Read /api/tailscale/status — show login state, online/total peer count.
//   2. If not logged in: "授权 Tailscale" button → POST /api/tailscale/login
//      → opens authUrl in a new tab → polls status until BackendState=Running.
//   3. Once logged in: show user / tailnet, and a probe form
//      (username/password/ports/types) with a streaming probe button.
//   4. Results table: per peer × port × type, each row has a checkbox.
//      Default-check the ones that came back ok.
//   5. "加入代理池" button POSTs the selected rows to /api/tailscale/import-proxies.

export default function TailscaleNeighborsCard({ notify, onChanged }) {
  const [collapsed, setCollapsed] = useState(true);
  const [status, setStatus] = useState(null);
  const [loadingStatus, setLoadingStatus] = useState(true);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [portsInput, setPortsInput] = useState("1080,7890,8080");
  const [typeHttp, setTypeHttp] = useState(true);
  const [typeSocks5, setTypeSocks5] = useState(true);

  const [probing, setProbing] = useState(false);
  const [progress, setProgress] = useState(null);
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(() => new Set());
  const [importing, setImporting] = useState(false);
  const [loginInFlight, setLoginInFlight] = useState(false);
  const [switching, setSwitching] = useState(false);

  const pollRef = useRef(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/tailscale/status", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) setStatus(data);
    } catch (e) { /* keep prev */ }
    finally { setLoadingStatus(false); }
  }, []);

  useEffect(() => {
    fetchStatus();
    const t = setInterval(fetchStatus, 10000);
    return () => clearInterval(t);
  }, [fetchStatus]);

  const startLogin = async () => {
    setLoginInFlight(true);
    try {
      const res = await fetch("/api/tailscale/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) {
        notify?.error?.(data.error || "Login start failed");
        return;
      }
      if (data.alreadyLoggedIn) {
        notify?.success?.("Already logged in");
        await fetchStatus();
        return;
      }
      if (data.authUrl) {
        window.open(data.authUrl, "_blank", "noopener");
        notify?.success?.("Tailscale auth page opened — will refresh once you finish");
        // Poll faster while waiting for the user to finish browser auth
        if (pollRef.current) clearInterval(pollRef.current);
        let ticks = 0;
        pollRef.current = setInterval(async () => {
          ticks++;
          await fetchStatus();
          if (status?.loggedIn || ticks > 90) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
        }, 2000);
      } else {
        notify?.warning?.("No auth URL returned, retry later");
      }
    } catch (e) {
      notify?.error?.(e.message);
    } finally {
      setLoginInFlight(false);
    }
  };

  const switchAccount = async () => {
    if (!confirm("Sign out of the current Tailscale account and bind a new one? Existing probe results will be cleared.")) {
      return;
    }
    setSwitching(true);
    try {
      const res = await fetch("/api/tailscale/logout", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        notify?.error?.(data.error || "Logout failed");
        return;
      }
      // Clear local state from the previous identity
      setResults([]);
      setSelected(new Set());
      setProgress(null);
      await fetchStatus();
      // Immediately kick off a fresh login so the user lands on the auth page.
      await startLogin();
    } catch (e) {
      notify?.error?.(e.message);
    } finally {
      setSwitching(false);
    }
  };

  const ports = useMemo(() => {
    return portsInput
      .split(/[\s,]+/)
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
  }, [portsInput]);

  const types = useMemo(() => {
    const out = [];
    if (typeHttp) out.push("http");
    if (typeSocks5) out.push("socks5");
    return out;
  }, [typeHttp, typeSocks5]);

  const probe = async () => {
    if (!status?.loggedIn) { notify?.error?.("Authorize Tailscale first"); return; }
    if (ports.length === 0) { notify?.error?.("Add at least one port"); return; }
    if (types.length === 0) { notify?.error?.("Pick at least one proxy type"); return; }

    setProbing(true);
    setResults([]);
    setSelected(new Set());
    setProgress({ done: 0, total: 0, peers: 0 });

    try {
      const res = await fetch("/api/tailscale/probe-proxies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: username.trim() || undefined,
          password: password || undefined,
          ports,
          types,
        }),
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({}));
        notify?.error?.(err.error || "Probe failed");
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let totalProbes = 0;
      let doneCount = 0;
      const okIds = new Set();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() || "";
        for (const block of blocks) {
          let event = "message";
          let data = "";
          for (const ln of block.split("\n")) {
            if (ln.startsWith("event:")) event = ln.slice(6).trim();
            else if (ln.startsWith("data:")) data += ln.slice(5).trim();
          }
          if (!data) continue;
          let payload;
          try { payload = JSON.parse(data); } catch { continue; }

          if (event === "start") {
            totalProbes = payload.totalProbes;
            setProgress({ done: 0, total: totalProbes, peers: payload.peers });
          } else if (event === "result") {
            doneCount++;
            const id = `${payload.ip}:${payload.port}:${payload.type}`;
            setResults((prev) => [...prev, { id, ...payload }]);
            if (payload.ok) {
              okIds.add(id);
              setSelected((prev) => {
                const n = new Set(prev);
                n.add(id);
                return n;
              });
            }
            setProgress({ done: doneCount, total: totalProbes, peers: payload.peers });
          } else if (event === "done") {
            setProgress({ done: payload.total, total: payload.total, ok: payload.ok });
          } else if (event === "error") {
            notify?.error?.(payload.error);
          }
        }
      }
    } catch (e) {
      notify?.error?.(e.message);
    } finally {
      setProbing(false);
    }
  };

  const toggleSelect = (id) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });

  const toggleSelectAllOk = () => {
    setSelected((prev) => {
      const okIds = results.filter((r) => r.ok).map((r) => r.id);
      const allChecked = okIds.length > 0 && okIds.every((id) => prev.has(id));
      if (allChecked) {
        const n = new Set(prev);
        for (const id of okIds) n.delete(id);
        return n;
      }
      const n = new Set(prev);
      for (const id of okIds) n.add(id);
      return n;
    });
  };

  const importSelected = async () => {
    const entries = results
      .filter((r) => selected.has(r.id))
      .map((r) => ({
        peer: r.peer,
        ip: r.ip,
        type: r.type,
        port: r.port,
        username: username.trim() || undefined,
        password: password || undefined,
      }));
    if (entries.length === 0) { notify?.error?.("Nothing selected"); return; }

    setImporting(true);
    try {
      const res = await fetch("/api/tailscale/import-proxies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries }),
      });
      const data = await res.json();
      if (res.ok) {
        const parts = [`Added ${data.ok}`];
        if (data.skipped) parts.push(`skipped ${data.skipped}`);
        if (data.failed) parts.push(`failed ${data.failed}`);
        notify?.success?.(parts.join(" / "));
        onChanged?.();
      } else {
        notify?.error?.(data.error || "Import failed");
      }
    } catch (e) {
      notify?.error?.(e.message);
    } finally {
      setImporting(false);
    }
  };

  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.length - okCount;

  return (
    <Card>
      <div className="flex flex-col gap-3">
        <button
          onClick={() => setCollapsed((v) => !v)}
          className="flex items-start justify-between gap-2 text-left hover:opacity-80"
        >
          <div className="flex items-center gap-2">
            <span
              className="material-symbols-outlined text-[20px] text-text-muted transition-transform"
              style={{ transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)" }}
            >
              expand_more
            </span>
            <div>
              <h3 className="font-semibold text-base">🔗 Tailscale Neighbour Proxy Probe</h3>
              <p className="text-xs text-text-muted mt-0.5">
                After Tailscale login, sweep all online peers with one set of credentials, batch-test HTTP/SOCKS5 proxies, and add the working ones to the proxy pool.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {status?.loggedIn ? (
              <>
                <Badge variant="success" size="sm">Online {status.online}</Badge>
                <Badge variant="default" size="sm">Total {status.total}</Badge>
              </>
            ) : (
              <Badge variant="warning" size="sm">{loadingStatus ? "..." : "Not logged in"}</Badge>
            )}
          </div>
        </button>

        {!collapsed && (
          <>
            {/* Login status */}
            <div className="rounded-lg border border-black/5 dark:border-white/5 px-3 py-2 flex items-center gap-2 flex-wrap">
              {status?.loggedIn ? (
                <>
                  <span className="material-symbols-outlined text-[18px] text-emerald-500">check_circle</span>
                  <span className="text-sm">
                    Logged in: <code className="text-xs">{status.self?.user?.login || status.self?.dnsName}</code>
                    {status.tailnet && <span className="text-text-muted"> @ {status.tailnet}</span>}
                  </span>
                  <Badge variant="success" size="sm">Online {status.online}</Badge>
                  <Badge variant="default" size="sm">Total {status.total}</Badge>
                  <div className="flex-1" />
                  <Button size="sm" variant="ghost" onClick={fetchStatus}>Refresh</Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={switchAccount}
                    disabled={switching || loginInFlight}
                    title="Sign out and bind a different Tailscale account"
                  >
                    {switching ? "Switching..." : "🔄 Switch account"}
                  </Button>
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined text-[18px] text-amber-500">warning</span>
                  <span className="text-sm">
                    {status?.status === "NeedsLogin"
                      ? "Tailscale ready, awaiting authorization"
                      : status?.status || (loadingStatus ? "Reading status..." : "tailscaled unavailable")}
                  </span>
                  <div className="flex-1" />
                  <Button size="sm" onClick={startLogin} disabled={loginInFlight}>
                    {loginInFlight ? "Starting..." : "🔐 Authorize Tailscale"}
                  </Button>
                </>
              )}
            </div>

            {/* Probe form */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-text-muted">Username (optional)</label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  disabled={probing || !status?.loggedIn}
                  className="w-full px-3 py-2 text-sm bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:outline-none"
                  placeholder="Leave empty for no auth"
                />
              </div>
              <div>
                <label className="text-xs text-text-muted">Password (optional)</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={probing || !status?.loggedIn}
                  className="w-full px-3 py-2 text-sm bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:outline-none"
                />
              </div>
              <div>
                <label className="text-xs text-text-muted">Ports (comma-separated)</label>
                <input
                  type="text"
                  value={portsInput}
                  onChange={(e) => setPortsInput(e.target.value)}
                  disabled={probing || !status?.loggedIn}
                  className="w-full px-3 py-2 text-sm bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:outline-none"
                  placeholder="1080,7890,8080"
                />
              </div>
              <div className="flex items-end gap-3">
                <label className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" checked={typeHttp} onChange={(e) => setTypeHttp(e.target.checked)} disabled={probing} /> HTTP
                </label>
                <label className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" checked={typeSocks5} onChange={(e) => setTypeSocks5(e.target.checked)} disabled={probing} /> SOCKS5
                </label>
                <div className="flex-1" />
                <Button
                  onClick={probe}
                  disabled={probing || !status?.loggedIn || ports.length === 0 || types.length === 0 || (status?.online || 0) === 0}
                >
                  {probing ? `Probing ${progress?.done || 0}/${progress?.total || 0}` : "🚀 Probe all"}
                </Button>
              </div>
            </div>

            {progress && progress.total > 0 && (
              <div className="h-2 rounded-full bg-black/5 dark:bg-white/5 overflow-hidden">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }}
                />
              </div>
            )}

            {results.length > 0 && (
              <>
                <div className="flex items-center justify-between gap-2 px-1">
                  <div className="flex items-center gap-2 text-xs">
                    <Badge variant="success" size="sm">OK {okCount}</Badge>
                    <Badge variant="default" size="sm">Down {failCount}</Badge>
                    <button
                      onClick={toggleSelectAllOk}
                      className="text-text-muted hover:text-primary"
                    >
                      {okCount > 0 && results.filter((r) => r.ok).every((r) => selected.has(r.id))
                        ? "Unselect"
                        : "Select all OK"}
                    </button>
                  </div>
                  <Button
                    size="sm"
                    onClick={importSelected}
                    disabled={importing || selected.size === 0}
                  >
                    {importing ? "Adding..." : `📥 Add to pool (${selected.size})`}
                  </Button>
                </div>
                <div className="rounded-lg border border-black/5 dark:border-white/5 max-h-[400px] overflow-auto divide-y divide-black/[0.04] dark:divide-white/[0.05]">
                  {results.map((r) => (
                    <div
                      key={r.id}
                      className={`flex items-center gap-2 px-3 py-2 text-sm ${r.ok ? "" : "opacity-60"}`}
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(r.id)}
                        onChange={() => toggleSelect(r.id)}
                        className="shrink-0"
                      />
                      <span className={`material-symbols-outlined text-[18px] ${r.ok ? "text-emerald-500" : "text-rose-500"}`}>
                        {r.ok ? "check_circle" : "cancel"}
                      </span>
                      <code className="text-xs">{r.peer}</code>
                      <Badge variant="default" size="sm">{r.type}</Badge>
                      <code className="text-[11px] text-text-muted">{r.ip}:{r.port}</code>
                      {r.ok && (
                        <Badge
                          variant={r.latency < 200 ? "success" : r.latency < 500 ? "warning" : "error"}
                          size="sm"
                        >
                          {r.latency}ms
                        </Badge>
                      )}
                      {r.exitIp && (
                        <code className="text-[11px] text-text-muted">exit={r.exitIp}</code>
                      )}
                      {!r.ok && r.error && (
                        <span className="text-[11px] text-text-muted truncate">{r.error}</span>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
