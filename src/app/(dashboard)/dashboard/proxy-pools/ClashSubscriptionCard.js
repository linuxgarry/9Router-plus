"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, Input, Toggle } from "@/shared/components";
import FileDropZone from "./FileDropZone";

function formatDateTime(value) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Never";
  return date.toLocaleString();
}

export default function ClashSubscriptionCard({ onLoaded, notify }) {
  const [subs, setSubs] = useState([]);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState(null);

  // WARP state
  const [warpEnabled, setWarpEnabled] = useState(false);
  const [warpMode, setWarpMode] = useState("auto");
  const [warpCustom, setWarpCustom] = useState("");
  const [warpRouteTuning, setWarpRouteTuning] = useState(false);
  const [warpBusy, setWarpBusy] = useState(false);
  const [showWarpPanel, setShowWarpPanel] = useState(false);
  const [warpProbeBusy, setWarpProbeBusy] = useState(false);
  const [warpProbeResult, setWarpProbeResult] = useState(null);

  // Manual YAML import
  const [showYamlModal, setShowYamlModal] = useState(false);
  const [yamlText, setYamlText] = useState("");
  const [yamlName, setYamlName] = useState("");
  const [yamlBusy, setYamlBusy] = useState(false);

  const fetchSubs = useCallback(async () => {
    try {
      const res = await fetch("/api/clash-subscriptions", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) setSubs(data.subscriptions || []);
    } catch (e) {
      console.error(e);
    }
  }, []);

  const fetchWarp = useCallback(async () => {
    try {
      const res = await fetch("/api/warp", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) {
        setWarpEnabled(!!data.enabled);
        setWarpMode(data.settings?.mode || "auto");
        setWarpCustom(data.settings?.customConfig || "");
        setWarpRouteTuning(!!data.settings?.routeTuning);
        if (data.enabled) setShowWarpPanel(true);
      }
    } catch (e) {
      console.error(e);
    }
  }, []);

  useEffect(() => {
    fetchSubs();
    fetchWarp();
  }, [fetchSubs, fetchWarp]);

  const saveAndLoad = async () => {
    if (!url.trim()) return;
    setLoading(true);
    try {
      let subId = editingId;
      if (!subId) {
        const res = await fetch("/api/clash-subscriptions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: url.trim(), name: name.trim() }),
        });
        const data = await res.json();
        if (!res.ok) {
          notify?.error?.(data.error || "Failed to save subscription");
          return;
        }
        subId = data.subscription.id;
      } else {
        await fetch(`/api/clash-subscriptions/${subId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: url.trim(), name: name.trim() }),
        });
      }

      const loadRes = await fetch(`/api/clash-subscriptions/${subId}/load`, { method: "POST" });
      const loadData = await loadRes.json();
      if (loadRes.ok) {
        notify?.success?.(`Loaded ${loadData.imported} proxies`);
        await fetchSubs();
        onLoaded?.();
      } else {
        notify?.error?.(loadData.error || "Failed to load");
      }
    } finally {
      setLoading(false);
    }
  };

  const refresh = async (id) => {
    setLoading(true);
    try {
      const loadRes = await fetch(`/api/clash-subscriptions/${id}/load`, { method: "POST" });
      const loadData = await loadRes.json();
      if (loadRes.ok) {
        notify?.success?.(`Refreshed: ${loadData.imported} proxies`);
        await fetchSubs();
        onLoaded?.();
      } else {
        notify?.error?.(loadData.error || "Refresh failed");
      }
    } finally {
      setLoading(false);
    }
  };

  const remove = async (id) => {
    if (!confirm("Delete this subscription? Imported proxies will remain.")) return;
    const res = await fetch(`/api/clash-subscriptions/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      notify?.error?.(data.error || `Delete failed (HTTP ${res.status})`);
      return;
    }
    notify?.success?.("Subscription deleted");
    await fetchSubs();
  };

  const importYaml = async () => {
    if (!yamlText.trim()) return;
    setYamlBusy(true);
    try {
      const res = await fetch("/api/clash-subscriptions/import-yaml", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yaml: yamlText, name: yamlName.trim() || undefined }),
      });
      const data = await res.json();
      if (res.ok) {
        notify?.success?.(`Imported ${data.imported} proxies from YAML`);
        setShowYamlModal(false);
        setYamlText("");
        setYamlName("");
        await fetchSubs();
        onLoaded?.();
      } else {
        notify?.error?.(data.error || "YAML import failed");
      }
    } finally {
      setYamlBusy(false);
    }
  };

  const editSub = (sub) => {
    setEditingId(sub.id);
    setUrl(sub.url);
    setName(sub.name);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setUrl("");
    setName("");
  };

  const toggleWarp = async (next) => {
    setWarpBusy(true);
    try {
      const res = await fetch("/api/warp", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: next,
          mode: warpMode,
          customConfig: warpMode === "custom" ? warpCustom : undefined,
          routeTuning: warpRouteTuning,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setWarpEnabled(next);
        if (next) setShowWarpPanel(true);
        notify?.success?.(next ? "WARP enabled" : "WARP disabled");
      } else {
        notify?.error?.(data.error || "WARP toggle failed");
      }
    } finally {
      setWarpBusy(false);
    }
  };

  const saveWarpSettings = async () => {
    setWarpBusy(true);
    try {
      const res = await fetch("/api/warp", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: warpEnabled,
          mode: warpMode,
          customConfig: warpCustom,
          routeTuning: warpRouteTuning,
        }),
      });
      const data = await res.json();
      if (res.ok) notify?.success?.("WARP settings saved");
      else notify?.error?.(data.error || "Save failed");
    } finally {
      setWarpBusy(false);
    }
  };

  const toggleRouteTuning = async (next) => {
    setWarpRouteTuning(next);
    try {
      const res = await fetch("/api/warp", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: warpEnabled,
          mode: warpMode,
          customConfig: warpMode === "custom" ? warpCustom : undefined,
          routeTuning: next,
        }),
      });
      if (res.ok) {
        notify?.success?.(next ? "WARP 路由调优已启用" : "WARP 路由调优已关闭");
      } else {
        const data = await res.json().catch(() => ({}));
        notify?.error?.(data.error || "保存失败");
        setWarpRouteTuning(!next);
      }
    } catch (e) {
      notify?.error?.(e.message);
      setWarpRouteTuning(!next);
    }
  };

  const probeWarp = async () => {
    setWarpProbeBusy(true);
    setWarpProbeResult({ checks: [], summary: "测试启动中…", warpReachable: false, streaming: true });
    try {
      const res = await fetch("/api/warp/probe", { method: "POST" });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        notify?.error?.(data.error || "探测失败");
        setWarpProbeResult(null);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const checks = [];
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
          if (event === "check") {
            checks.push(payload);
            setWarpProbeResult((prev) => ({ ...(prev || {}), checks: [...checks], streaming: true }));
          } else if (event === "done") {
            setWarpProbeResult((prev) => ({
              ...(prev || {}),
              checks: [...checks],
              summary: payload.summary,
              warpReachable: !!payload.warpReachable,
              streaming: false,
            }));
          } else if (event === "error") {
            notify?.error?.(payload.error || "探测错误");
          }
        }
      }
    } catch (e) {
      notify?.error?.(e.message);
      setWarpProbeResult(null);
    } finally {
      setWarpProbeBusy(false);
    }
  };

  const latest = subs[0];

  return (
    <Card>
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-base">Clash 订阅(全局)</h3>
            <p className="text-xs text-text-muted mt-1">
              填入订阅链接 → 「保存并加载」,节点会进入下方代理池。订阅永久保存,重启不丢。
            </p>
          </div>
          <label className="flex items-center gap-2 cursor-pointer" title="勾选后,所有订阅里的 trojan/vmess/ss 等节点都先进入 Cloudflare WARP,再用真实节点出网。出口 IP 仍是节点 IP,但加多一跳隐藏真实链路;关闭则节点直连。">
            <input
              type="checkbox"
              checked={warpEnabled}
              onChange={(e) => toggleWarp(e.target.checked)}
              disabled={warpBusy}
              className="size-4 rounded border-black/20 dark:border-white/20"
            />
            <span className="text-sm font-medium">所有节点经 WARP 跳板</span>
          </label>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <Input
            label="订阅 URL"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/sub?target=clash"
            className="flex-1"
          />
          <Input
            label="名称(可选)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="主订阅"
            className="sm:w-48"
          />
          <div className="flex gap-2">
            {editingId && (
              <Button variant="ghost" onClick={cancelEdit} disabled={loading}>
                取消
              </Button>
            )}
            <Button variant="ghost" onClick={() => setShowYamlModal(true)} disabled={loading}>
              粘贴 YAML
            </Button>
            <Button onClick={saveAndLoad} disabled={!url.trim() || loading}>
              {loading ? "加载中..." : editingId ? "更新并加载" : "保存并加载"}
            </Button>
          </div>
        </div>

        {warpEnabled && showWarpPanel && (
          <div className="rounded-lg border border-purple-500/30 bg-purple-500/5 p-3 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-purple-700 dark:text-purple-300">
                ⚡ WARP 跳板设置
              </p>
              <button
                onClick={() => setShowWarpPanel(false)}
                className="text-xs text-text-muted hover:text-text-main"
              >
                收起
              </button>
            </div>
            <p className="text-xs text-text-muted">
              所有订阅里的 trojan/vmess/shadowsocks 节点会被自动包成 <code>relay</code> 链:本机 → WARP → 真实节点 → 目标。订阅切换或新加节点时自动套用。
            </p>
            <div className="flex gap-3">
              <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                <input
                  type="radio"
                  checked={warpMode === "auto"}
                  onChange={() => setWarpMode("auto")}
                  name="warpMode"
                />
                内置 wgcf 自动注册(免费)
              </label>
              <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                <input
                  type="radio"
                  checked={warpMode === "custom"}
                  onChange={() => setWarpMode("custom")}
                  name="warpMode"
                />
                自定义 WireGuard 配置
              </label>
            </div>
            {warpMode === "custom" && (
              <textarea
                value={warpCustom}
                onChange={(e) => setWarpCustom(e.target.value)}
                placeholder={"[Interface]\nPrivateKey = ...\nAddress = 172.16.0.2/32\n\n[Peer]\nPublicKey = ...\nEndpoint = engage.cloudflareclient.com:2408"}
                className="min-h-[140px] py-2 px-3 text-xs font-mono bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:outline-none"
              />
            )}
            <div className="flex items-center justify-between flex-wrap gap-2">
              <label
                className="flex items-center gap-2 cursor-pointer text-sm"
                title="开启后,WARP 节点的 endpoint 会从 anycast (engage.cloudflareclient.com) 改为随机 162/188 IPv4。在国内云出 Cloudflare anycast 被丢包时能显著提高握手成功率"
              >
                <input
                  type="checkbox"
                  checked={warpRouteTuning}
                  onChange={(e) => toggleRouteTuning(e.target.checked)}
                  disabled={warpBusy}
                  className="size-4 rounded border-black/20 dark:border-white/20"
                />
                <span>WARP 路由调优(轰炸路线)</span>
              </label>
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={probeWarp} disabled={warpProbeBusy}>
                  {warpProbeBusy ? "测试中..." : "测试 WARP"}
                </Button>
                <Button size="sm" onClick={saveWarpSettings} disabled={warpBusy}>
                  保存 WARP 设置
                </Button>
              </div>
            </div>
          </div>
        )}

        {subs.length > 0 && (
          <div className="flex flex-col divide-y divide-black/[0.04] dark:divide-white/[0.05] rounded-lg border border-black/5 dark:border-white/5">
            {subs.map((sub) => (
              <div key={sub.id} className="flex items-center justify-between gap-2 py-2 px-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-medium truncate max-w-[18rem]">{sub.name}</p>
                    <Badge variant="success" size="sm">
                      已加载 {sub.nodeCount} 个节点
                    </Badge>
                    {sub.lastLoadedAt && (
                      <span className="text-xs text-text-muted">
                        · 更新于 {formatDateTime(sub.lastLoadedAt)}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-text-muted truncate mt-0.5">{sub.url}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => refresh(sub.id)}
                    className="p-1.5 rounded hover:bg-black/5 dark:hover:bg-white/5 text-text-muted hover:text-primary"
                    title="刷新"
                    disabled={loading}
                  >
                    <span className="material-symbols-outlined text-[18px]">refresh</span>
                  </button>
                  <button
                    onClick={() => editSub(sub)}
                    className="p-1.5 rounded hover:bg-black/5 dark:hover:bg-white/5 text-text-muted hover:text-primary"
                    title="编辑"
                  >
                    <span className="material-symbols-outlined text-[18px]">edit</span>
                  </button>
                  <button
                    onClick={() => remove(sub.id)}
                    className="p-1.5 rounded hover:bg-red-500/10 text-red-500"
                    title="删除"
                  >
                    <span className="material-symbols-outlined text-[18px]">delete</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showYamlModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !yamlBusy && setShowYamlModal(false)}
        >
          <div
            className="w-full max-w-2xl rounded-xl bg-white dark:bg-zinc-900 p-5 shadow-xl flex flex-col gap-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-base">手工导入 Clash YAML</h3>
              <button
                onClick={() => !yamlBusy && setShowYamlModal(false)}
                className="text-text-muted hover:text-text-main text-xl leading-none"
                aria-label="close"
              >
                ×
              </button>
            </div>
            <p className="text-xs text-text-muted">
              粘贴或上传 Clash/mihomo 风格 YAML(必须含 <code>proxies:</code> 列表)。导入后会作为一条订阅记录保存,可后续刷新重新解析。
            </p>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <Input
                label="名称(可选)"
                value={yamlName}
                onChange={(e) => setYamlName(e.target.value)}
                placeholder="手工 YAML"
                className="flex-1"
              />
            </div>
            <FileDropZone
              accept=".yaml,.yml,.txt"
              maxBytes={8 * 1024 * 1024}
              onFile={async (f) => {
                const text = await f.text();
                setYamlText(text);
                if (!yamlName.trim()) setYamlName(f.name.replace(/\.(ya?ml|txt)$/i, ""));
              }}
              onError={(msg) => notify?.error?.(msg)}
              disabled={yamlBusy}
              label="拖入 .yaml / .yml 文件"
              hint="或点击选择,也可以直接在下方粘贴文本"
            />
            <textarea
              value={yamlText}
              onChange={(e) => setYamlText(e.target.value)}
              placeholder={"proxies:\n  - name: example\n    type: ss\n    server: 1.2.3.4\n    port: 8388\n    cipher: aes-256-gcm\n    password: ..."}
              className="min-h-[260px] py-2 px-3 text-xs font-mono bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:outline-none"
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setShowYamlModal(false)} disabled={yamlBusy}>
                取消
              </Button>
              <Button onClick={importYaml} disabled={!yamlText.trim() || yamlBusy}>
                {yamlBusy ? "导入中..." : "导入"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {warpProbeResult && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setWarpProbeResult(null)}
        >
          <div
            className="w-full max-w-xl rounded-xl bg-white dark:bg-zinc-900 p-5 shadow-xl flex flex-col gap-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-base">WARP 连通性探测结果</h3>
              <button
                onClick={() => setWarpProbeResult(null)}
                className="text-text-muted hover:text-text-main text-xl leading-none"
              >
                ×
              </button>
            </div>
            <div
              className={`text-sm rounded-md px-3 py-2 ${
                warpProbeResult.warpReachable
                  ? "bg-green-500/10 text-green-700 dark:text-green-300"
                  : "bg-yellow-500/10 text-yellow-700 dark:text-yellow-300"
              }`}
            >
              {warpProbeResult.summary}
            </div>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-black/5 dark:border-white/5 text-left text-text-muted">
                  <th className="py-1.5 px-1 font-medium">检查项</th>
                  <th className="py-1.5 px-1 font-medium text-center">结果</th>
                  <th className="py-1.5 px-1 font-medium">说明</th>
                </tr>
              </thead>
              <tbody>
                {warpProbeResult.checks.map((c, i) => (
                  <tr key={i} className="border-b border-black/[0.03] dark:border-white/[0.03]">
                    <td className="py-1.5 px-1 font-mono">{c.name}</td>
                    <td className="py-1.5 px-1 text-center">
                      {c.ok ? (
                        <span className="text-green-600">✅</span>
                      ) : (
                        <span className="text-red-500">❌</span>
                      )}
                    </td>
                    <td className="py-1.5 px-1 text-text-muted">
                      {c.extra || c.error || (typeof c.elapsedMs === "number" ? `${c.elapsedMs}ms` : "")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-xs text-text-muted">
              UDP 端口可达 ≠ wireguard 协议能过。Cloudflare 对部分国内云 IP(腾讯云/阿里云)有概率性丢包,免费 WARP 经常握不上手。
              {!warpProbeResult.warpReachable && !warpRouteTuning && (
                <span className="text-yellow-700 dark:text-yellow-400">
                  {" 试试勾上「WARP 路由调优」用 IPv4 endpoint 替代 anycast。"}
                </span>
              )}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setWarpProbeResult(null)}>
                关闭
              </Button>
              <Button onClick={probeWarp} disabled={warpProbeBusy}>
                {warpProbeBusy ? "测试中..." : "再测一次"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
