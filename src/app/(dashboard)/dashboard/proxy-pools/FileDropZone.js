"use client";

import { useCallback, useRef, useState } from "react";

export default function FileDropZone({
  accept = "",
  maxBytes = 8 * 1024 * 1024,
  onFile,
  onError,
  disabled = false,
  label = "拖入文件",
  hint = "或点击选择文件",
  current,
}) {
  const inputRef = useRef(null);
  const [over, setOver] = useState(false);

  const acceptList = accept
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const matchesAccept = (file) => {
    if (acceptList.length === 0) return true;
    const name = file.name.toLowerCase();
    const type = (file.type || "").toLowerCase();
    return acceptList.some((a) => {
      if (a.startsWith(".")) return name.endsWith(a);
      if (a.endsWith("/*")) return type.startsWith(a.slice(0, -1));
      return type === a;
    });
  };

  const handleFile = useCallback(
    (file) => {
      if (!file) return;
      if (!matchesAccept(file)) {
        onError?.(`文件类型不支持: ${file.name}`);
        return;
      }
      if (file.size > maxBytes) {
        onError?.(`文件过大 (max ${(maxBytes / 1024 / 1024).toFixed(0)}MB): ${file.name}`);
        return;
      }
      onFile?.(file);
    },
    [maxBytes, onFile, onError, acceptList]
  );

  const onDragOver = (e) => {
    e.preventDefault();
    if (!disabled) setOver(true);
  };
  const onDragLeave = () => setOver(false);
  const onDrop = (e) => {
    e.preventDefault();
    setOver(false);
    if (disabled) return;
    const file = e.dataTransfer?.files?.[0];
    handleFile(file);
  };
  const onPick = (e) => {
    const file = e.target.files?.[0];
    handleFile(file);
    e.target.value = "";
  };

  return (
    <div
      onDragOver={onDragOver}
      onDragEnter={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={() => !disabled && inputRef.current?.click()}
      className={[
        "rounded-lg border-2 border-dashed p-5 text-center cursor-pointer transition-colors",
        over
          ? "border-primary bg-primary/10"
          : "border-black/15 dark:border-white/15 hover:border-primary/50 hover:bg-black/[0.02] dark:hover:bg-white/[0.02]",
        disabled ? "opacity-50 cursor-not-allowed" : "",
      ].join(" ")}
    >
      <span className="material-symbols-outlined text-[36px] text-text-muted block mb-1">
        cloud_upload
      </span>
      <p className="text-sm font-medium">{label}</p>
      <p className="text-xs text-text-muted mt-0.5">{hint}</p>
      {current && (
        <p className="text-xs text-primary mt-2 truncate">
          已选: {current.name}
          {typeof current.size === "number" ? ` (${(current.size / 1024).toFixed(1)} KB)` : ""}
        </p>
      )}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        onChange={onPick}
        disabled={disabled}
        className="hidden"
      />
    </div>
  );
}
