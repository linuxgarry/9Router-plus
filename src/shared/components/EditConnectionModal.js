"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import Modal from "@/shared/components/Modal";
import Input from "@/shared/components/Input";
import Button from "@/shared/components/Button";
import Badge from "@/shared/components/Badge";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider, AI_PROVIDERS } from "@/shared/constants/providers";
import Select from "@/shared/components/Select";

const CLASH_PROXY_URL = "http://127.0.0.1:7890";

function deriveProxyMode(connection) {
  const psd = connection?.providerSpecificData || {};
  if (psd.proxyPoolId) return "pool";
  if (psd.connectionProxyEnabled && psd.connectionProxyUrl) {
    return psd.connectionProxyUrl === CLASH_PROXY_URL ? "clash" : "custom";
  }
  return "direct";
}

export default function EditConnectionModal({ isOpen, connection, proxyPools, onSave, onClose }) {
  const [formData, setFormData] = useState({
    name: "",
    priority: 1,
    apiKey: "",
  });
  const [azureData, setAzureData] = useState({
    azureEndpoint: "",
    apiVersion: "2024-10-01-preview",
    deployment: "",
    organization: "",
  });
  const [cloudflareData, setCloudflareData] = useState({ accountId: "" });
  const [awsData, setAwsData] = useState({ profile: "", region: "", accessKeyId: "", sessionToken: "" });
  const [clearAwsSessionToken, setClearAwsSessionToken] = useState(false);
  const [region, setRegion] = useState("");

  // Proxy mode state
  const [proxyMode, setProxyMode] = useState("direct");
  const [proxyCustomUrl, setProxyCustomUrl] = useState("");
  const [proxyNoProxy, setProxyNoProxy] = useState("");
  const [proxyClashSubId, setProxyClashSubId] = useState("");
  const [proxyPoolId, setProxyPoolId] = useState("");
  const [clashSubs, setClashSubs] = useState([]);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [egressResult, setEgressResult] = useState(null);
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!connection) return;
    setFormData({
      name: connection.name || "",
      priority: connection.priority || 1,
      apiKey: "",
    });
    if (connection.provider === "azure" && connection.providerSpecificData) {
      setAzureData({
        azureEndpoint: connection.providerSpecificData.azureEndpoint || "",
        apiVersion: connection.providerSpecificData.apiVersion || "2024-10-01-preview",
        deployment: connection.providerSpecificData.deployment || "",
        organization: connection.providerSpecificData.organization || "",
      });
    }
    if (connection.provider === "cloudflare-ai" && connection.providerSpecificData) {
      setCloudflareData({ accountId: connection.providerSpecificData.accountId || "" });
    }
    if (AI_PROVIDERS?.[connection.provider]?.credentialForm === "aws") {
      const psd = connection.providerSpecificData || {};
      setAwsData({
        profile: psd.profile || "",
        region: psd.region || "",
        accessKeyId: psd.accessKeyId || "",
        sessionToken: "",
      });
      setClearAwsSessionToken(false);
    }
    // Load region for providers that support it (e.g. xiaomi-tokenplan)
    const providerCfg = AI_PROVIDERS?.[connection.provider];
    if (providerCfg?.regions) {
      const savedRegion = connection.providerSpecificData?.region || providerCfg.defaultRegion || providerCfg.regions[0]?.id || "";
      setRegion(savedRegion);
    }

    const psd = connection.providerSpecificData || {};
    setProxyMode(deriveProxyMode(connection));
    setProxyCustomUrl(psd.connectionProxyUrl && psd.connectionProxyUrl !== CLASH_PROXY_URL ? psd.connectionProxyUrl : "");
    setProxyNoProxy(psd.connectionNoProxy || "");
    setProxyClashSubId(psd.proxyClashSubscriptionId || "");
    setProxyPoolId(psd.proxyPoolId || "");

    setTestResult(null);
    setValidationResult(null);
  }, [connection, isOpen]);

  // Load clash subscriptions when modal opens
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    fetch("/api/clash-subscriptions", { cache: "no-store" })
      .then((r) => r.ok ? r.json() : { subscriptions: [] })
      .then((d) => { if (!cancelled) setClashSubs(d.subscriptions || []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [isOpen]);

  const isOAuth = connection?.authType === "oauth";
  const isAzure = connection?.provider === "azure";
  const isCloudflareAi = connection?.provider === "cloudflare-ai";
  const usesAwsCredentialForm = AI_PROVIDERS?.[connection?.provider]?.credentialForm === "aws";
  const isCompatible = connection
    ? (isOpenAICompatibleProvider(connection.provider) || isAnthropicCompatibleProvider(connection.provider))
    : false;
  const providerRegions = connection ? (AI_PROVIDERS?.[connection.provider]?.regions || null) : null;

  // Build providerSpecificData for region-aware providers
  const buildRegionSpecificData = () => {
    if (providerRegions && region) return { ...((connection?.providerSpecificData) || {}), region };
    return undefined;
  };

  // The server keeps a saved session token when this password field is blank. Other empty
  // fields still clear their saved values so a profile can be switched to static keys.
  const buildAwsSpecificData = () => ({
    profile: awsData.profile.trim(),
    region: awsData.region.trim(),
    accessKeyId: awsData.accessKeyId.trim(),
    sessionToken: clearAwsSessionToken ? null : awsData.sessionToken.trim(),
  });

  const handleTest = async () => {
    if (!connection?.provider) return;
    setTesting(true);
    setTestResult(null);
    setEgressResult(null);
    try {
      const [testRes, egressRes] = await Promise.all([
        fetch(`/api/providers/${connection.id}/test`, { method: "POST" }).then(r => r.json()).catch(() => null),
        fetch(`/api/providers/${connection.id}/test-egress`, { method: "POST" }).then(r => r.json()).catch(() => null),
      ]);
      setTestResult(testRes?.valid ? "success" : "failed");
      if (egressRes?.ip) setEgressResult(egressRes);
      else if (egressRes) setEgressResult({ ...egressRes, ok: false });
    } catch {
      setTestResult("failed");
    } finally {
      setTesting(false);
    }
  };

  const handleValidate = async () => {
    if (!connection?.provider || !formData.apiKey) return;
    setValidating(true);
    setValidationResult(null);
    try {
      const res = await fetch("/api/providers/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: connection.provider,
          apiKey: formData.apiKey,
          ...(isAzure ? { providerSpecificData: azureData } : {}),
          ...(isCloudflareAi ? { providerSpecificData: cloudflareData } : {}),
          ...(usesAwsCredentialForm ? { providerSpecificData: buildAwsSpecificData() } : {}),
          ...(providerRegions ? { providerSpecificData: buildRegionSpecificData() } : {}),
        }),
      });
      const data = await res.json();
      setValidationResult(data.valid ? "success" : "failed");
    } catch {
      setValidationResult("failed");
    } finally {
      setValidating(false);
    }
  };

  const buildProxyUpdates = () => {
    const psd = { ...(connection?.providerSpecificData || {}) };
    // Reset all proxy fields, then set per mode
    psd.proxyPoolId = null;
    psd.connectionProxyEnabled = false;
    psd.connectionProxyUrl = "";
    psd.connectionNoProxy = "";
    psd.proxyClashSubscriptionId = null;

    if (proxyMode === "custom" && proxyCustomUrl.trim()) {
      psd.connectionProxyEnabled = true;
      psd.connectionProxyUrl = proxyCustomUrl.trim();
      psd.connectionNoProxy = proxyNoProxy.trim();
    } else if (proxyMode === "clash") {
      psd.connectionProxyEnabled = true;
      psd.connectionProxyUrl = CLASH_PROXY_URL;
      psd.connectionNoProxy = proxyNoProxy.trim();
      if (proxyClashSubId) psd.proxyClashSubscriptionId = proxyClashSubId;
    } else if (proxyMode === "pool" && proxyPoolId) {
      psd.proxyPoolId = proxyPoolId;
    }

    return psd;
  };

  const handleSubmit = async () => {
    if (!connection) return;
    setSaving(true);
    try {
      const updates = {
        name: formData.name,
        priority: formData.priority,
      };
      if (!isOAuth && formData.apiKey) {
        updates.apiKey = formData.apiKey;
        let isValid = validationResult === "success";
        if (!isValid) {
          try {
            setValidating(true);
            setValidationResult(null);
            const res = await fetch("/api/providers/validate", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                provider: connection.provider,
                apiKey: formData.apiKey,
                ...(isAzure ? { providerSpecificData: azureData } : {}),
                ...(isCloudflareAi ? { providerSpecificData: cloudflareData } : {}),
                ...(usesAwsCredentialForm ? { providerSpecificData: buildAwsSpecificData() } : {}),
                ...(providerRegions ? { providerSpecificData: buildRegionSpecificData() } : {}),
              }),
            });
            const data = await res.json();
            isValid = !!data.valid;
            setValidationResult(isValid ? "success" : "failed");
          } catch {
            setValidationResult("failed");
          } finally {
            setValidating(false);
          }
        }
        if (isValid) {
          updates.testStatus = "active";
          updates.lastError = null;
          updates.lastErrorAt = null;
        }
      }

      // Merge proxy + provider-specific fields into providerSpecificData
      const psd = buildProxyUpdates();
      if (isAzure) {
        Object.assign(psd, {
          azureEndpoint: azureData.azureEndpoint,
          apiVersion: azureData.apiVersion,
          deployment: azureData.deployment,
          organization: azureData.organization,
        });
      }
      if (isCloudflareAi) {
        psd.accountId = cloudflareData.accountId;
      }
      updates.providerSpecificData = psd;
      if (usesAwsCredentialForm) {
        Object.assign(updates.providerSpecificData, buildAwsSpecificData());
      }
      // Persist updated region for region-aware providers
      if (providerRegions && region) {
        Object.assign(updates.providerSpecificData, buildRegionSpecificData());
      }

      // Mirror proxy fields onto the top-level body too. The PUT
      // /api/providers/[id] handler reads them via normalizeProxyConfig
      // and normalizeProxyPoolUpdate from body.* directly — without
      // these mirrors, the merge happily writes the right values into
      // providerSpecificData but the reset path (`hasProxyPoolField` /
      // `hasAnyProxyField` both false) never fires, so the inserted
      // values can race with the existing-data spread and reads stay
      // stale. Copying the keys to top-level keeps the two code paths
      // aligned.
      updates.proxyPoolId = psd.proxyPoolId ?? null;
      updates.connectionProxyEnabled = psd.connectionProxyEnabled ?? false;
      updates.connectionProxyUrl = psd.connectionProxyUrl || "";
      updates.connectionNoProxy = psd.connectionNoProxy || "";

      await onSave(updates);
    } finally {
      setSaving(false);
    }
  };

  if (!connection) return null;

  const activePools = (proxyPools || []).filter((p) => p.isActive !== false);

  return (
    <Modal isOpen={isOpen} title="Edit Connection" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <Input
          label="Name"
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          placeholder={isOAuth ? "Account name" : "Production Key"}
        />
        {isOAuth && connection.email && (
          <div className="bg-sidebar/50 p-3 rounded-lg">
            <p className="text-sm text-text-muted mb-1">Email</p>
            <p className="font-medium">{connection.email}</p>
          </div>
        )}
        <Input
          label="Priority"
          type="number"
          value={formData.priority}
          onChange={(e) => setFormData({ ...formData, priority: Number.parseInt(e.target.value, 10) || 1 })}
        />

        {/* ── Proxy mode picker ──────────────────────────────────── */}
        <div className="rounded-lg border border-black/10 dark:border-white/10 p-3 flex flex-col gap-3">
          <div>
            <p className="text-sm font-medium">代理设置</p>
            <p className="text-xs text-text-muted mt-0.5">
              这条连接发请求时走哪条代理。三种模式互斥。
            </p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            {[
              { v: "direct", label: "直连" },
              { v: "custom", label: "自定义 SOCKS5/HTTP" },
              { v: "clash", label: "Clash 订阅" },
              { v: "pool", label: "自建代理池" },
            ].map((opt) => (
              <label
                key={opt.v}
                className={`flex items-center gap-1.5 px-2 py-1.5 rounded border cursor-pointer transition-colors ${
                  proxyMode === opt.v
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-black/10 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/5"
                }`}
              >
                <input
                  type="radio"
                  name="proxyMode"
                  checked={proxyMode === opt.v}
                  onChange={() => setProxyMode(opt.v)}
                  className="size-3"
                />
                {opt.label}
              </label>
            ))}
          </div>

          {proxyMode === "custom" && (
            <div className="flex flex-col gap-2">
              <Input
                label="代理 URL"
                value={proxyCustomUrl}
                onChange={(e) => setProxyCustomUrl(e.target.value)}
                placeholder="socks5://user:pass@host:1080  或  http://host:8080"
                hint="支持 http / https / socks5。带认证写在 URL 里。"
              />
              <Input
                label="No Proxy(可选)"
                value={proxyNoProxy}
                onChange={(e) => setProxyNoProxy(e.target.value)}
                placeholder="localhost,127.0.0.1,*.internal"
                hint="逗号分隔的不走代理的主机/域名。"
              />
            </div>
          )}

          {proxyMode === "clash" && (
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium">订阅</label>
              <select
                value={proxyClashSubId}
                onChange={(e) => setProxyClashSubId(e.target.value)}
                className="px-3 py-2 text-sm bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:outline-none"
              >
                <option value="">默认(全部已加载订阅,GLOBAL 选择)</option>
                {clashSubs.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.nodeCount} 节点
                  </option>
                ))}
              </select>
              <p className="text-xs text-text-muted">
                请求会走 mihomo 主代理 <code>{CLASH_PROXY_URL}</code>。订阅在「代理池」页面管理,关闭这里只是不走 mihomo。
              </p>
            </div>
          )}

          {proxyMode === "pool" && (
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium">代理池</label>
              <select
                value={proxyPoolId}
                onChange={(e) => setProxyPoolId(e.target.value)}
                className="px-3 py-2 text-sm bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:outline-none"
              >
                <option value="">— 选择一个代理池 —</option>
                {activePools.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              {activePools.length === 0 && (
                <p className="text-xs text-text-muted">
                  尚无 active 代理池。先去「代理池」页面添加或激活。
                </p>
              )}
            </div>
          )}
        </div>

        {!isOAuth && (
          <>
            <div className="flex gap-2">
              <Input
                label="API Key"
                type="password"
                value={formData.apiKey}
                onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
                placeholder="Enter new API key"
                hint="Leave blank to keep the current API key."
                className="flex-1"
              />
              <div className="pt-6">
                <Button onClick={handleValidate} disabled={!formData.apiKey || validating || saving} variant="secondary">
                  {validating ? "Checking..." : "Check"}
                </Button>
              </div>
            </div>
            {validationResult && (
              <Badge variant={validationResult === "success" ? "success" : "error"}>
                {validationResult === "success" ? "Valid" : "Invalid"}
              </Badge>
            )}
          </>
        )}

        {isAzure && (
          <div className="bg-sidebar/50 p-4 rounded-lg border border-accent/20">
            <h3 className="font-semibold mb-3 text-sm">Azure OpenAI Configuration</h3>
            <div className="flex flex-col gap-3">
              <Input
                label="Azure Endpoint"
                value={azureData.azureEndpoint}
                onChange={(e) => setAzureData({ ...azureData, azureEndpoint: e.target.value })}
                placeholder="https://your-resource.openai.azure.com"
                hint="Your Azure OpenAI resource endpoint URL"
              />
              <Input
                label="Deployment Name"
                value={azureData.deployment}
                onChange={(e) => setAzureData({ ...azureData, deployment: e.target.value })}
                placeholder="gpt-4"
                hint="The deployment name in your Azure resource"
              />
              <Input
                label="API Version"
                value={azureData.apiVersion}
                onChange={(e) => setAzureData({ ...azureData, apiVersion: e.target.value })}
                placeholder="2024-10-01-preview"
                hint="Azure OpenAI API version to use"
              />
              <Input
                label="Organization"
                value={azureData.organization}
                onChange={(e) => setAzureData({ ...azureData, organization: e.target.value })}
                placeholder="Organization ID"
                hint="Required for billing"
              />
            </div>
          </div>
        )}

        {usesAwsCredentialForm && (
          <div className="bg-sidebar/50 p-4 rounded-lg border border-accent/20">
            <h3 className="font-semibold mb-3 text-sm">AWS Bedrock Credentials</h3>
            <div className="flex flex-col gap-3">
              <Input
                label="AWS Profile (SSO — recommended)"
                value={awsData.profile}
                onChange={(e) => setAwsData({ ...awsData, profile: e.target.value })}
                placeholder="my-sso-profile"
                hint="Clear this to use static keys instead; a profile takes precedence."
              />
              <Input
                label="Region"
                value={awsData.region}
                onChange={(e) => setAwsData({ ...awsData, region: e.target.value })}
                placeholder="us-east-1"
              />
              <Input
                label="Access Key ID (only for static keys)"
                value={awsData.accessKeyId}
                onChange={(e) => setAwsData({ ...awsData, accessKeyId: e.target.value })}
                placeholder="AKIA..."
              />
              <Input
                label="Session Token (only for temporary ASIA… keys)"
                type="password"
                value={awsData.sessionToken}
                onChange={(e) => setAwsData({ ...awsData, sessionToken: e.target.value })}
                placeholder="FwoGZXIvYXdz..."
                hint="Leave blank to keep the saved token. Enter a new token to replace it."
                disabled={clearAwsSessionToken}
              />
              <label className="flex items-center gap-2 text-sm text-text-muted">
                <input
                  type="checkbox"
                  checked={clearAwsSessionToken}
                  onChange={(e) => {
                    setClearAwsSessionToken(e.target.checked);
                    if (e.target.checked) setAwsData({ ...awsData, sessionToken: "" });
                  }}
                />
                Remove saved session token
              </label>
            </div>
          </div>
        )}

        {providerRegions && (
          <Select
            label="Region"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            options={providerRegions.map((r) => ({ value: r.id, label: r.label }))}
          />
        )}

        {!isCompatible && !isAzure && !isCloudflareAi && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-3">
              <Button onClick={handleTest} variant="secondary" disabled={testing}>
                {testing ? "Testing..." : "Test Connection"}
              </Button>
              {testResult && (
                <Badge variant={testResult === "success" ? "success" : "error"}>
                  {testResult === "success" ? "Valid" : "Failed"}
                </Badge>
              )}
            </div>
            {egressResult && (
              <div className="rounded-md bg-black/[0.03] dark:bg-white/[0.03] px-3 py-2 text-xs">
                <p className="font-medium text-text-main mb-1">出口信息(经代理)</p>
                {egressResult.ok ? (
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-text-muted">
                    <span>模式: <code>{egressResult.mode}</code></span>
                    {egressResult.proxyUrl && <span>代理: <code>{egressResult.proxyUrl}</code></span>}
                    {egressResult.ip && <span>IP: <code className="text-primary">{egressResult.ip}</code></span>}
                    {egressResult.country && <span>国家: <code className="text-primary">{egressResult.country}</code></span>}
                    {egressResult.city && <span>城市: <code>{egressResult.city}</code></span>}
                    {egressResult.org && <span title={egressResult.org}>ASN: <code>{(egressResult.org || "").slice(0, 30)}</code></span>}
                  </div>
                ) : (
                  <p className="text-yellow-700 dark:text-yellow-400">无法获取出口 IP — 检查代理是否可达,或者 IP 检测接口不通</p>
                )}
                {egressResult.source && <p className="text-text-muted mt-1 text-[10px]">来源: {egressResult.source}</p>}
              </div>
            )}
          </div>
        )}

        <div className="flex gap-2">
          <Button onClick={handleSubmit} fullWidth disabled={saving}>{saving ? "Saving..." : "Save"}</Button>
          <Button onClick={onClose} variant="ghost" fullWidth>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}

EditConnectionModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  connection: PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    email: PropTypes.string,
    priority: PropTypes.number,
    authType: PropTypes.string,
    provider: PropTypes.string,
    providerSpecificData: PropTypes.object,
  }),
  proxyPools: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
  })),
  onSave: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};
