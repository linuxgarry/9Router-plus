"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/shared/components";

export default function MihomoHealthBadge({ refreshKey }) {
  const [health, setHealth] = useState({ alive: null });

  useEffect(() => {
    let cancelled = false;

    const probe = async () => {
      try {
        const res = await fetch("/api/mihomo/health", { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (!cancelled) setHealth(data);
      } catch {
        if (!cancelled) setHealth({ alive: false, error: "fetch failed" });
      }
    };

    probe();
    const id = setInterval(probe, 10000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [refreshKey]);

  if (health.alive === null) {
    return (
      <Badge variant="default" size="sm" dot>
        代理池核心 · 检测中…
      </Badge>
    );
  }

  if (health.alive) {
    const meta = [
      health.version ? `v${health.version.replace(/^v/, "")}` : null,
      typeof health.proxiesCount === "number" ? `${health.proxiesCount} 节点` : null,
      typeof health.topListenersCount === "number" && health.topListenersCount > 0
        ? `${health.topListenersCount} 端口`
        : null,
    ].filter(Boolean).join(" · ");
    return (
      <Badge variant="success" size="sm" dot>
        代理池核心运行中{meta ? ` · ${meta}` : ""}
      </Badge>
    );
  }

  return (
    <Badge variant="error" size="sm" dot title={health.error || ""}>
      代理池核心未响应{health.error ? ` · ${health.error}` : ""}
    </Badge>
  );
}
