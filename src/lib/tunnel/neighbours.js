/**
 * Tailscale neighbour discovery helpers.
 *
 * Reads the live tailscaled socket via `tailscale status --json` and
 * normalises the Self / Peer entries the dashboard cares about. Used
 * by the proxy-pools "Tailscale neighbour proxy probe" card.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir.js";

const SOCKET = process.env.TAILSCALED_SOCKET || path.join(DATA_DIR, "tailscale", "tailscaled.sock");
const BIN_CANDIDATES = [
  "/usr/local/bin/tailscale",
  "/usr/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
];

function findBin() {
  for (const p of BIN_CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

function runStatus() {
  const bin = findBin();
  if (!bin) throw new Error("tailscale binary not found");
  const args = [];
  if (fs.existsSync(SOCKET)) args.push("--socket", SOCKET);
  args.push("status", "--json");
  const out = execFileSync(bin, args, { encoding: "utf8", timeout: 5000 });
  return JSON.parse(out);
}

/** Friendly host label that strips the trailing tailnet domain dot. */
function hostnameOf(node) {
  if (!node) return null;
  return (node.DNSName || node.HostName || "").replace(/\.$/, "");
}

/**
 * Returns { loggedIn, status, self, tailnet, peers, online, total }.
 * `peers` is an array of { id, hostname, dnsName, os, ipv4, ipv6, online, lastSeen, user }.
 */
export function getNeighbourSnapshot() {
  let raw;
  try {
    raw = runStatus();
  } catch (e) {
    return {
      loggedIn: false,
      status: "error",
      error: e?.message || String(e),
      self: null,
      tailnet: null,
      peers: [],
      online: 0,
      total: 0,
    };
  }

  const loggedIn = raw.BackendState === "Running";
  const tailnet = raw.CurrentTailnet?.Name || raw.MagicDNSSuffix || null;
  const userMap = raw.User || {};

  const userOf = (uid) => {
    const u = userMap?.[String(uid)];
    return u ? { id: uid, login: u.LoginName, name: u.DisplayName } : null;
  };

  const ipv4Of = (ips) => (ips || []).find((ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) || null;
  const ipv6Of = (ips) => (ips || []).find((ip) => ip?.includes(":")) || null;

  const self = raw.Self
    ? {
        id: raw.Self.ID,
        hostname: hostnameOf(raw.Self),
        dnsName: raw.Self.DNSName?.replace(/\.$/, "") || null,
        os: raw.Self.OS || null,
        ipv4: ipv4Of(raw.Self.TailscaleIPs),
        ipv6: ipv6Of(raw.Self.TailscaleIPs),
        online: !!raw.Self.Online,
        user: userOf(raw.Self.UserID),
      }
    : null;

  const peers = [];
  for (const id of Object.keys(raw.Peer || {})) {
    const p = raw.Peer[id];
    peers.push({
      id,
      hostname: hostnameOf(p),
      dnsName: p.DNSName?.replace(/\.$/, "") || null,
      os: p.OS || null,
      ipv4: ipv4Of(p.TailscaleIPs),
      ipv6: ipv6Of(p.TailscaleIPs),
      online: !!p.Online,
      lastSeen: p.LastSeen || null,
      lastHandshake: p.LastHandshake || null,
      user: userOf(p.UserID),
      // active means traffic flowing right now; useful when sorting
      active: !!p.Active,
    });
  }

  // Stable sort: online first, then hostname
  peers.sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return (a.hostname || "").localeCompare(b.hostname || "");
  });

  const online = peers.filter((p) => p.online).length;

  return {
    loggedIn,
    status: raw.BackendState || "Unknown",
    authUrl: raw.AuthURL || null,
    self,
    tailnet,
    peers,
    online,
    total: peers.length,
  };
}
