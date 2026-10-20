"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card } from "@/shared/components";

export default function IpCheckUrlsCard({ notify }) {
  const [collapsed, setCollapsed] = useState(true);
  const [urls, setUrls] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pickValue, setPickValue] = useState("");
  const [customUrl, setCustomUrl] = useState("");

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/ip-check-urls", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) {
        setUrls(Array.isArray(data.urls) ? data.urls : []);
        setCatalog(Array.isArray(data.catalog) ? data.catalog : []);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const save = async (next) => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings/ip-check-urls", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: next }),
      });
      const data = await res.json();
      if (res.ok) {
        setUrls(data.urls);
        notify?.success?.("IP check URLs saved");
      } else {
        notify?.error?.(data.error || "Save failed");
      }
    } catch (e) {
      notify?.error?.(e.message);
    } finally {
      setSaving(false);
    }
  };

  const addFromCatalog = () => {
    if (!pickValue) return;
    if (urls.includes(pickValue)) {
      notify?.warning?.("Already in the list");
      return;
    }
    save([...urls, pickValue]);
    setPickValue("");
  };

  const addCustom = () => {
    const u = customUrl.trim();
    if (!u) return;
    try { new URL(u); } catch { notify?.error?.("Invalid URL"); return; }
    if (urls.includes(u)) {
      notify?.warning?.("Already in the list");
      return;
    }
    save([...urls, u]);
    setCustomUrl("");
  };

  const remove = (url) => save(urls.filter((u) => u !== url));

  const move = (url, dir) => {
    const idx = urls.indexOf(url);
    if (idx < 0) return;
    const target = idx + dir;
    if (target < 0 || target >= urls.length) return;
    const next = [...urls];
    [next[idx], next[target]] = [next[target], next[idx]];
    save(next);
  };

  const resetDefaults = () => {
    if (!confirm("Reset to defaults (only services that ignore X-Forwarded-For)? Current custom list will be cleared.")) return;
    save([]);
  };

  const catalogByUrl = new Map(catalog.map((c) => [c.url, c]));
  const availableCatalog = catalog.filter((c) => !urls.includes(c.url));

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
              <h3 className="font-semibold text-base">🌐 IP Check Endpoints</h3>
              <p className="text-xs text-text-muted mt-0.5">
                Used by speed tests / Test Connection to probe exit IP, tried in order. Defaults ignore X-Forwarded-For so they stay accurate behind a relay (e.g. vercel-relay).
              </p>
            </div>
          </div>
          <Badge variant="default" size="sm">{urls.length || "default"}</Badge>
        </button>

        {!collapsed && (
          <>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="flex-1 min-w-0">
                <label className="text-xs text-text-muted">Pick from known endpoints</label>
                <select
                  value={pickValue}
                  onChange={(e) => setPickValue(e.target.value)}
                  disabled={saving || loading}
                  className="w-full px-3 py-2 text-sm bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:outline-none"
                >
                  <option value="">Select an endpoint...</option>
                  {availableCatalog.map((c) => (
                    <option key={c.url} value={c.url}>
                      {c.url} {c.trustsXff ? "⚠️ trusts XFF" : "✓"} — {c.note}
                    </option>
                  ))}
                </select>
              </div>
              <Button onClick={addFromCatalog} disabled={!pickValue || saving}>
                + Add
              </Button>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="flex-1 min-w-0">
                <label className="text-xs text-text-muted">Or paste a custom URL</label>
                <input
                  type="url"
                  value={customUrl}
                  onChange={(e) => setCustomUrl(e.target.value)}
                  placeholder="https://example.com/ip"
                  disabled={saving}
                  className="w-full px-3 py-2 text-sm bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:outline-none"
                />
              </div>
              <Button onClick={addCustom} disabled={!customUrl.trim() || saving}>
                + Add
              </Button>
            </div>

            <div className="rounded-lg border border-black/5 dark:border-white/5">
              {loading ? (
                <p className="text-sm text-text-muted text-center py-6">Loading...</p>
              ) : urls.length === 0 ? (
                <p className="text-sm text-text-muted text-center py-6">Using default list (services that ignore XFF).</p>
              ) : (
                <div className="divide-y divide-black/[0.04] dark:divide-white/[0.05]">
                  {urls.map((u, i) => {
                    const meta = catalogByUrl.get(u);
                    return (
                      <div key={u} className="flex items-center gap-2 px-3 py-2">
                        <span className="text-xs text-text-muted w-6">#{i + 1}</span>
                        <div className="min-w-0 flex-1">
                          <code className="text-xs break-all">{u}</code>
                          {meta?.trustsXff && (
                            <Badge variant="warning" size="sm" className="ml-2">⚠️ trusts XFF</Badge>
                          )}
                          {meta?.note && (
                            <p className="text-[11px] text-text-muted mt-0.5">{meta.note}</p>
                          )}
                        </div>
                        <button
                          onClick={() => move(u, -1)}
                          disabled={i === 0 || saving}
                          className="p-1.5 rounded hover:bg-black/5 dark:hover:bg-white/5 text-text-muted disabled:opacity-30"
                          title="Move up"
                        >
                          <span className="material-symbols-outlined text-[18px]">arrow_upward</span>
                        </button>
                        <button
                          onClick={() => move(u, 1)}
                          disabled={i === urls.length - 1 || saving}
                          className="p-1.5 rounded hover:bg-black/5 dark:hover:bg-white/5 text-text-muted disabled:opacity-30"
                          title="Move down"
                        >
                          <span className="material-symbols-outlined text-[18px]">arrow_downward</span>
                        </button>
                        <button
                          onClick={() => remove(u)}
                          disabled={saving}
                          className="p-1.5 rounded hover:bg-red-500/10 text-red-500"
                          title="Delete"
                        >
                          <span className="material-symbols-outlined text-[18px]">delete</span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {urls.length > 0 && (
              <div className="flex justify-end">
                <Button onClick={resetDefaults} variant="secondary" size="sm" disabled={saving}>
                  Reset to defaults
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
