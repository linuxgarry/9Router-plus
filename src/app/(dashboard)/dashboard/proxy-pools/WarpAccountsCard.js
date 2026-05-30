"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, Card } from "@/shared/components";

export default function WarpAccountsCard({ notify, onChanged }) {
  const [accounts, setAccounts] = useState([]);
  const [collapsed, setCollapsed] = useState(true);
  const [name, setName] = useState("");
  const [count, setCount] = useState(1);
  const [registering, setRegistering] = useState(false);
  const [batchProgress, setBatchProgress] = useState(null);
  const [testingId, setTestingId] = useState(null);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [importText, setImportText] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  const fetchAccounts = useCallback(async () => {
    try {
      const res = await fetch("/api/warp/accounts", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) setAccounts(data.accounts || []);
    } catch (e) { console.error(e); }
  }, []);

  useEffect(() => { fetchAccounts(); }, [fetchAccounts]);

  const addAccounts = async () => {
    setRegistering(true);
    setBatchProgress({ phase: "starting", done: 0, total: count });
    try {
      const res = await fetch("/api/warp/accounts/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count, namePrefix: name.trim() }),
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({}));
        notify?.error?.(err.error || "Bulk generate failed");
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let registeredCount = 0;
      let testedCount = 0;
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

          if (event === "registering") {
            setBatchProgress({ phase: "register", done: payload.index - 1, total: payload.total });
          } else if (event === "registered") {
            registeredCount++;
            setBatchProgress({ phase: "register", done: registeredCount, total: payload.total });
          } else if (event === "testing") {
            setBatchProgress({ phase: "test", done: testedCount, total: payload.total, currentName: payload.name });
          } else if (event === "tested") {
            testedCount++;
            setBatchProgress({
              phase: "test",
              done: testedCount,
              total: payload.total,
              currentName: payload.name,
              lastResult: { latency: payload.latency, country: payload.country, exitIp: payload.exitIp },
            });
            await fetchAccounts();
          } else if (event === "register-error" || event === "test-error") {
            notify?.warning?.(`#${payload.index} ${payload.name || ""}: ${payload.error}`);
          } else if (event === "done") {
            notify?.success?.(`Generated ${payload.created} WARP accounts`);
            onChanged?.();
          } else if (event === "error") {
            notify?.error?.(payload.error);
          }
        }
      }
      setName("");
      setCount(1);
      await fetchAccounts();
    } catch (e) {
      notify?.error?.(e.message);
    } finally {
      setRegistering(false);
      setBatchProgress(null);
    }
  };

  const removeAccount = async (acc) => {
    if (!confirm(`Delete WARP account "${acc.name}"? The matching proxy-pool row will also be removed.`)) return;
    try {
      const res = await fetch(`/api/warp/accounts/${acc.id}`, { method: "DELETE" });
      if (res.ok) {
        notify?.success?.("Deleted");
        setSelectedIds((prev) => { const n = new Set(prev); n.delete(acc.id); return n; });
        await fetchAccounts();
        onChanged?.();
      } else {
        const data = await res.json().catch(() => ({}));
        notify?.error?.(data.error || "Delete failed");
      }
    } catch (e) {
      notify?.error?.(e.message);
    }
  };

  const toggleSelect = (id) => {
    setSelectedIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };

  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      if (prev.size === accounts.length && accounts.length > 0) return new Set();
      return new Set(accounts.map((a) => a.id));
    });
  };

  const bulkDelete = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} selected WARP accounts? Matching proxy-pool rows will also be removed.`)) return;
    setBulkDeleting(true);
    try {
      const res = await fetch("/api/warp/accounts/batch-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const failedCount = (data.failed || []).length;
        if (failedCount === 0) notify?.success?.(`Deleted ${data.ok}`);
        else notify?.warning?.(`Deleted ${data.ok}, failed ${failedCount}`);
        setSelectedIds(new Set());
        await fetchAccounts();
        onChanged?.();
      } else {
        notify?.error?.(data.error || "Bulk delete failed");
      }
    } catch (e) {
      notify?.error?.(e.message);
    } finally {
      setBulkDeleting(false);
    }
  };

  const testAccount = async (acc) => {
    setTestingId(acc.id);
    try {
      const res = await fetch(`/api/proxy-pools/warp-${acc.id}/mihomo-test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (res.ok) {
        await fetchAccounts();
        const geo = [data.country, data.city].filter(Boolean).join(" / ");
        notify?.success?.(
          data.ok
            ? `${acc.name}: ${data.latency}ms${data.exitIp ? ` · ${data.exitIp}${geo ? ` (${geo})` : ""}` : ""}`
            : `${acc.name}: down`
        );
      } else {
        notify?.error?.(data.error || "Test failed");
      }
    } finally {
      setTestingId(null);
    }
  };

  const rerollAccount = async (acc) => {
    try {
      const res = await fetch(`/api/warp/accounts/${acc.id}/reroll`, { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        notify?.success?.(`${acc.name} → ${data.account?.endpoint || "new endpoint"}`);
        await fetchAccounts();
        onChanged?.();
      } else {
        notify?.error?.(data.error || "Reroll failed");
      }
    } catch (e) {
      notify?.error?.(e.message);
    }
  };

  const rerollAll = async () => {
    if (!confirm("Reroll the Cloudflare edge endpoint for every WARP account? This clears cached latency and exit IPs.")) return;
    try {
      const res = await fetch("/api/warp/accounts/reroll-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (res.ok) {
        const failedCount = (data.failed || []).length;
        if (failedCount === 0) notify?.success?.(`Rerolled ${data.ok} accounts`);
        else notify?.warning?.(`Rerolled ${data.ok}, failed ${failedCount}`);
        await fetchAccounts();
        onChanged?.();
      } else {
        notify?.error?.(data.error || "Bulk reroll failed");
      }
    } catch (e) {
      notify?.error?.(e.message);
    }
  };

  // Split a blob of pasted text into individual [Interface]/[Peer]
  // configs. Each config begins with a [Interface] line; we treat that
  // as the delimiter so users can dump 3 configs into the textarea
  // without needing a separator.
  const splitConfigs = (text) => {
    const trimmed = (text || "").trim();
    if (!trimmed) return [];
    const idx = [];
    const re = /^\s*\[Interface\]\s*$/gim;
    let m;
    while ((m = re.exec(trimmed)) !== null) idx.push(m.index);
    if (idx.length <= 1) return [trimmed];
    const parts = [];
    for (let i = 0; i < idx.length; i++) {
      const start = idx[i];
      const end = i + 1 < idx.length ? idx[i + 1] : trimmed.length;
      parts.push(trimmed.slice(start, end).trim());
    }
    return parts;
  };

  const importFromText = async () => {
    const configs = splitConfigs(importText);
    if (configs.length === 0) {
      notify?.error?.("Paste a WireGuard config first");
      return;
    }
    setImportBusy(true);
    try {
      const res = await fetch("/api/warp/accounts/import-wg", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entries: configs.map((c) => ({ config: c })),
        }),
      });
      const data = await res.json();
      if (res.ok) {
        const failedCount = (data.failed || []).length;
        if (failedCount === 0) {
          notify?.success?.(`Imported ${data.ok} WireGuard nodes`);
        } else {
          notify?.warning?.(
            `Imported ${data.ok}, failed ${failedCount}: ${data.failed[0].error}`,
          );
        }
        setShowImportModal(false);
        setImportText("");
        await fetchAccounts();
        onChanged?.();
      } else {
        notify?.error?.(data.error || "Import failed");
      }
    } catch (e) {
      notify?.error?.(e.message);
    } finally {
      setImportBusy(false);
    }
  };

  const handleDroppedFiles = async (files) => {
    if (!files || files.length === 0) return;
    setImportBusy(true);
    try {
      const entries = [];
      for (const f of files) {
        if (f.size > 64 * 1024) {
          notify?.warning?.(`${f.name} exceeds 64KB, skipped`);
          continue;
        }
        const text = await f.text();
        const baseName = f.name.replace(/\.(conf|wg)$/i, "");
        for (const cfg of splitConfigs(text)) {
          entries.push({ name: baseName, config: cfg });
        }
      }
      if (entries.length === 0) {
        notify?.error?.("No [Interface] config found in files");
        return;
      }
      const res = await fetch("/api/warp/accounts/import-wg", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries }),
      });
      const data = await res.json();
      if (res.ok) {
        const failedCount = (data.failed || []).length;
        if (failedCount === 0) notify?.success?.(`Imported ${data.ok} WireGuard nodes`);
        else notify?.warning?.(`Imported ${data.ok}, failed ${failedCount}`);
        setShowImportModal(false);
        setImportText("");
        await fetchAccounts();
        onChanged?.();
      } else {
        notify?.error?.(data.error || "Import failed");
      }
    } catch (e) {
      notify?.error?.(e.message);
    } finally {
      setImportBusy(false);
    }
  };

  const totalProgressPct = batchProgress
    ? Math.round(((batchProgress.done || 0) / Math.max(1, batchProgress.total || 1)) * 100)
    : 0;

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
              <h3 className="font-semibold text-base">🛡️ WARP Multi-line</h3>
              <p className="text-xs text-text-muted mt-0.5">
                Each row is an independent wgcf registration → distinct keypair → potentially distinct exit IP. Auto speed-test + country detection after generation.
              </p>
            </div>
          </div>
          <Badge variant="default" size="sm">{accounts.length}</Badge>
        </button>

        {!collapsed && (
          <>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Name prefix (optional, e.g. us → us-1, us-2)"
                className="flex-1 px-3 py-2 text-sm bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:outline-none"
                disabled={registering}
              />
              <input
                type="number"
                min="1"
                max="20"
                value={count}
                onChange={(e) => setCount(Math.max(1, Math.min(20, parseInt(e.target.value, 10) || 1)))}
                className="w-20 px-3 py-2 text-sm bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:outline-none"
                title="Count (1-20)"
                disabled={registering}
              />
              <Button onClick={addAccounts} disabled={registering}>
                {registering ? `${batchProgress?.phase === "test" ? "Testing" : "Registering"} ${batchProgress?.done || 0}/${batchProgress?.total || count}` : `+ Generate ${count > 1 ? `${count}` : "1"}`}
              </Button>
              <Button
                variant="ghost"
                onClick={() => setShowImportModal(true)}
                disabled={registering || importBusy}
                title="Import custom WireGuard configs (single, multiple, or drag-drop files)"
              >
                📥 Import WG
              </Button>
            </div>

            {batchProgress && (
              <div className="flex flex-col gap-1">
                <div className="h-2 rounded-full bg-black/5 dark:bg-white/5 overflow-hidden">
                  <div className="h-full bg-primary transition-all" style={{ width: `${totalProgressPct}%` }} />
                </div>
                <p className="text-xs text-text-muted">
                  {batchProgress.phase === "register" && `Registering wgcf accounts ${batchProgress.done}/${batchProgress.total}`}
                  {batchProgress.phase === "test" && `Speed-test + exit IP probe ${batchProgress.done}/${batchProgress.total}${batchProgress.currentName ? ` · ${batchProgress.currentName}` : ""}`}
                  {batchProgress.lastResult && batchProgress.lastResult.latency > 0 && (
                    <> · last: {batchProgress.lastResult.latency}ms{batchProgress.lastResult.country ? ` · ${batchProgress.lastResult.country}` : ""}{batchProgress.lastResult.exitIp ? ` · ${batchProgress.lastResult.exitIp}` : ""}</>
                  )}
                </p>
              </div>
            )}

            {accounts.length === 0 ? (
              <div className="text-center py-6">
                <p className="text-sm text-text-muted">No WARP accounts yet. Click the button above to generate.</p>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between gap-2 px-1">
                  <label className="flex items-center gap-2 text-xs text-text-muted cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={selectedIds.size === accounts.length && accounts.length > 0}
                      ref={(el) => {
                        if (el) el.indeterminate = selectedIds.size > 0 && selectedIds.size < accounts.length;
                      }}
                      onChange={toggleSelectAll}
                      disabled={registering || bulkDeleting}
                    />
                    {selectedIds.size > 0 ? `Selected ${selectedIds.size} / ${accounts.length}` : `Select all (${accounts.length})`}
                  </label>
                  {selectedIds.size > 0 ? (
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={bulkDelete}
                      disabled={bulkDeleting || registering}
                    >
                      {bulkDeleting ? "Deleting..." : `Bulk delete ${selectedIds.size}`}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={rerollAll}
                      disabled={registering || bulkDeleting}
                      title="Reroll Cloudflare edge endpoint for every account → different exit IP"
                    >
                      🎲 Reroll all endpoints
                    </Button>
                  )}
                </div>
                <div className="rounded-lg border border-black/5 dark:border-white/5 divide-y divide-black/[0.04] dark:divide-white/[0.05]">
                {accounts.map((acc) => (
                  <div key={acc.id} className="flex items-center gap-2 px-3 py-2">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(acc.id)}
                      onChange={() => toggleSelect(acc.id)}
                      disabled={registering || bulkDeleting}
                      className="shrink-0"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-medium truncate max-w-[14rem]">{acc.name}</p>
                        {acc.country && <Badge variant="default" size="sm">{acc.country}</Badge>}
                        {typeof acc.cachedLatency === "number" && acc.cachedLatency > 0 && (
                          <Badge variant={acc.cachedLatency < 200 ? "success" : acc.cachedLatency < 500 ? "warning" : "error"} size="sm">
                            {acc.cachedLatency}ms
                          </Badge>
                        )}
                        {acc.exitIp && (
                          <code className="text-[11px] text-text-muted bg-black/5 dark:bg-white/5 px-1 rounded">
                            exit={acc.exitIp}
                          </code>
                        )}
                      </div>
                      <p className="text-[11px] text-text-muted mt-0.5">
                        Pool: <code>WARP/{acc.name}</code>
                        {acc.endpoint && <> · {acc.endpoint}</>}
                        {acc.ipv4 && <> · local ip={acc.ipv4}</>}
                      </p>
                    </div>
                    <button
                      onClick={() => testAccount(acc)}
                      disabled={testingId === acc.id || registering}
                      className="p-1.5 rounded hover:bg-black/5 dark:hover:bg-white/5 text-text-muted hover:text-primary"
                      title="Speed test + check IP"
                    >
                      <span
                        className="material-symbols-outlined text-[18px]"
                        style={testingId === acc.id ? { animation: "spin 1s linear infinite" } : undefined}
                      >
                        {testingId === acc.id ? "progress_activity" : "speed"}
                      </span>
                    </button>
                    <button
                      onClick={() => rerollAccount(acc)}
                      disabled={registering || bulkDeleting}
                      className="p-1.5 rounded hover:bg-black/5 dark:hover:bg-white/5 text-text-muted hover:text-primary"
                      title="Reroll Cloudflare edge endpoint (switch exit PoP)"
                    >
                      <span className="material-symbols-outlined text-[18px]">casino</span>
                    </button>
                    <button
                      onClick={() => removeAccount(acc)}
                      disabled={registering}
                      className="p-1.5 rounded hover:bg-red-500/10 text-red-500"
                      title="Delete"
                    >
                      <span className="material-symbols-outlined text-[18px]">delete</span>
                    </button>
                  </div>
                ))}
              </div>
              </>
            )}
          </>
        )}
      </div>

      {showImportModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !importBusy && setShowImportModal(false)}
        >
          <div
            className="w-full max-w-2xl rounded-xl bg-white dark:bg-zinc-900 p-5 shadow-xl flex flex-col gap-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-base">Import custom WireGuard configs</h3>
              <button
                onClick={() => !importBusy && setShowImportModal(false)}
                className="text-text-muted hover:text-text-main text-xl leading-none"
                aria-label="close"
              >
                ×
              </button>
            </div>
            <p className="text-xs text-text-muted">
              Paste <code>[Interface]</code> + <code>[Peer]</code> sections; multiple configs in one paste are split on each <code>[Interface]</code>. You can also drag in multiple <code>.conf</code> files.
            </p>

            <div
              onDragOver={(e) => { e.preventDefault(); if (!importBusy) setDragOver(true); }}
              onDragEnter={(e) => { e.preventDefault(); if (!importBusy) setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                if (importBusy) return;
                handleDroppedFiles(e.dataTransfer?.files);
              }}
              onClick={() => !importBusy && fileInputRef.current?.click()}
              className={[
                "rounded-lg border-2 border-dashed p-5 text-center cursor-pointer transition-colors",
                dragOver
                  ? "border-primary bg-primary/10"
                  : "border-black/15 dark:border-white/15 hover:border-primary/50 hover:bg-black/[0.02] dark:hover:bg-white/[0.02]",
                importBusy ? "opacity-50 cursor-not-allowed" : "",
              ].join(" ")}
            >
              <span className="material-symbols-outlined text-[36px] text-text-muted block mb-1">
                cloud_upload
              </span>
              <p className="text-sm font-medium">Drag in .conf / .wg files (multi-select OK)</p>
              <p className="text-xs text-text-muted mt-0.5">Or click to pick; you can also paste text below.</p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".conf,.wg,.txt"
                multiple
                disabled={importBusy}
                onChange={(e) => {
                  handleDroppedFiles(e.target.files);
                  e.target.value = "";
                }}
                className="hidden"
              />
            </div>

            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              disabled={importBusy}
              placeholder={"[Interface]\nPrivateKey = ...\nAddress = 172.16.0.2/32\n\n[Peer]\nPublicKey = ...\nEndpoint = 162.159.192.1:2408\nAllowedIPs = 0.0.0.0/0"}
              className="min-h-[220px] py-2 px-3 text-xs font-mono bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:outline-none"
            />

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setShowImportModal(false)} disabled={importBusy}>
                Cancel
              </Button>
              <Button onClick={importFromText} disabled={!importText.trim() || importBusy}>
                {importBusy ? "Importing..." : `Import${splitConfigs(importText).length > 1 ? ` ${splitConfigs(importText).length}` : ""}`}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
