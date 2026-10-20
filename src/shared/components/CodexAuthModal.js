"use client";

import { useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { Modal, Button, OAuthModal } from "@/shared/components";

/**
 * Codex auth picker.
 *
 * Two methods:
 *   - "oauth"  → delegate to <OAuthModal provider="codex" /> (existing flow)
 *   - "import" → paste/drop a Codex token JSON record (or a batch) and POST
 *                to /api/oauth/codex/import.
 *
 * Supported import shapes (all parsed server-side):
 *   - { accessToken, refreshToken, expiresAt, providerSpecificData, ... }
 *   - [ {...}, {...} ]
 *   - { accounts: [...] } / { items / data / records / tokens: [...] }
 *   - Multiple JSON blobs concatenated by newlines / whitespace.
 */
export default function CodexAuthModal({ isOpen, providerInfo, onSuccess, onClose }) {
  const [method, setMethod] = useState(null);
  const [text, setText] = useState("");
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (!isOpen) {
      setMethod(null);
      setText("");
      setError(null);
      setResult(null);
      setImporting(false);
      setDragActive(false);
    }
  }, [isOpen]);

  const appendText = (incoming) => {
    if (!incoming) return;
    setText((prev) => {
      const trimmed = prev.trim();
      const add = incoming.trim();
      return trimmed ? `${trimmed}\n${add}` : add;
    });
  };

  const readFiles = async (files) => {
    if (!files || files.length === 0) return;
    setError(null);
    try {
      const texts = await Promise.all(Array.from(files).map((f) => f.text()));
      texts.forEach(appendText);
    } catch (err) {
      setError(`Failed to read file: ${err.message}`);
    }
  };

  const handleDragOver = (e) => { e.preventDefault(); e.stopPropagation(); setDragActive(true); };
  const handleDragLeave = (e) => { e.preventDefault(); e.stopPropagation(); setDragActive(false); };
  const handleDrop = async (e) => {
    e.preventDefault(); e.stopPropagation(); setDragActive(false);
    if (e.dataTransfer.files?.length) { await readFiles(e.dataTransfer.files); return; }
    const t = e.dataTransfer.getData("text");
    if (t) appendText(t);
  };
  const handleFilePick = (e) => { readFiles(e.target.files); e.target.value = ""; };

  const submit = async () => {
    const raw = text.trim();
    if (!raw) { setError("Paste a Codex token JSON first"); return; }

    let body;
    if (raw.startsWith("{") || raw.startsWith("[")) {
      try { body = { payload: JSON.parse(raw) }; }
      catch { body = { payload: raw }; }
    } else {
      body = { json: raw };
    }

    setImporting(true); setError(null); setResult(null);
    try {
      const res = await fetch("/api/oauth/codex/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || data.success === false) throw new Error(data.error || "Import failed");
      setResult({
        imported: data.imported || (data.connection ? [data.connection] : []),
        failed: data.failed || [],
      });
      onSuccess?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setImporting(false);
    }
  };

  // Method "oauth" → render OAuthModal directly; close ourselves when it closes.
  if (method === "oauth") {
    return (
      <OAuthModal
        isOpen={isOpen}
        provider="codex"
        providerInfo={providerInfo}
        onSuccess={() => { onSuccess?.(); }}
        onClose={onClose}
      />
    );
  }

  return (
    <Modal isOpen={isOpen} title={`Connect ${providerInfo?.name || "Codex"}`} onClose={onClose} size="lg">
      <div className="flex flex-col gap-4">
        {!method && (
          <div className="space-y-3">
            <p className="text-sm text-text-muted mb-1">Choose how to add your Codex account:</p>

            <button
              onClick={() => setMethod("oauth")}
              className="w-full p-4 text-left border border-border rounded-lg hover:bg-sidebar transition-colors"
            >
              <div className="flex items-start gap-3">
                <span className="material-symbols-outlined text-primary mt-0.5">login</span>
                <div className="flex-1">
                  <h3 className="font-semibold mb-1">Sign in with ChatGPT</h3>
                  <p className="text-sm text-text-muted">
                    Standard OAuth flow via your ChatGPT account.
                  </p>
                </div>
              </div>
            </button>

            <button
              onClick={() => setMethod("import")}
              className="w-full p-4 text-left border border-border rounded-lg hover:bg-sidebar transition-colors"
            >
              <div className="flex items-start gap-3">
                <span className="material-symbols-outlined text-primary mt-0.5">file_upload</span>
                <div className="flex-1">
                  <h3 className="font-semibold mb-1">Import token (JSON)</h3>
                  <p className="text-sm text-text-muted">
                    Paste a Codex token JSON (single record, array, or wrapped export) — supports drag &amp; drop.
                  </p>
                </div>
              </div>
            </button>
          </div>
        )}

        {method === "import" && (
          <div className="space-y-4">
            <div className="bg-blue-50 dark:bg-blue-900/20 p-3 rounded-lg border border-blue-200 dark:border-blue-800">
              <div className="flex gap-2">
                <span className="material-symbols-outlined text-blue-600 dark:text-blue-400">info</span>
                <p className="text-sm text-blue-800 dark:text-blue-200">
                  Required: <code>accessToken</code> + <code>refreshToken</code>. Optional: <code>expiresAt</code>, <code>email</code>, <code>providerSpecificData</code>. Single records, arrays, and <code>{`{accounts:[…]}`}</code> exports are all accepted.
                </p>
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-sm font-medium">
                  Codex token JSON <span className="text-red-500">*</span>
                </label>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="text-xs text-primary hover:underline flex items-center gap-1"
                >
                  <span className="material-symbols-outlined text-[14px]">attach_file</span>
                  Choose file
                </button>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,.txt,application/json,text/plain"
                multiple
                onChange={handleFilePick}
                className="hidden"
              />
              <div
                onDragOver={handleDragOver}
                onDragEnter={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                className={`relative rounded-[10px] transition-colors ${
                  dragActive ? "ring-2 ring-brand-500/60 bg-brand-500/5" : ""
                }`}
              >
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={'Paste, drop a JSON file, or click Choose file.\n\n{ "accessToken": "eyJ...", "refreshToken": "rt_...", "expiresAt": "2026-...", "providerSpecificData": { ... } }'}
                  rows={10}
                  spellCheck={false}
                  className="w-full px-3 py-2.5 text-sm bg-surface-2 rounded-[10px] border border-transparent placeholder-text-muted/70 focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500/40 font-mono"
                />
                {dragActive && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-[10px] bg-brand-500/10 text-sm font-medium text-primary">
                    Drop JSON file to import
                  </div>
                )}
              </div>
            </div>

            {result && result.imported.length > 0 && (
              <div className="bg-green-50 dark:bg-green-900/20 p-3 rounded-lg border border-green-200 dark:border-green-800">
                <p className="text-sm text-green-800 dark:text-green-200">
                  Imported {result.imported.length} account{result.imported.length === 1 ? "" : "s"}
                  {result.failed.length > 0 ? `, ${result.failed.length} failed` : ""}.
                </p>
              </div>
            )}

            {result && result.failed.length > 0 && (
              <div className="bg-amber-50 dark:bg-amber-900/20 p-3 rounded-lg border border-amber-200 dark:border-amber-800 max-h-32 overflow-auto">
                <ul className="text-xs text-amber-800 dark:text-amber-200 space-y-1">
                  {result.failed.map((f, i) => (
                    <li key={i}>#{f.index + 1}: {f.error}</li>
                  ))}
                </ul>
              </div>
            )}

            {error && (
              <div className="bg-red-50 dark:bg-red-900/20 p-3 rounded-lg border border-red-200 dark:border-red-800">
                <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
              </div>
            )}

            <div className="flex gap-2">
              <Button onClick={submit} fullWidth disabled={importing || !text.trim()}>
                {importing ? "Importing..." : "Import"}
              </Button>
              <Button onClick={() => setMethod(null)} variant="ghost" fullWidth>
                Back
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

CodexAuthModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  providerInfo: PropTypes.shape({ name: PropTypes.string }),
  onSuccess: PropTypes.func,
  onClose: PropTypes.func.isRequired,
};
