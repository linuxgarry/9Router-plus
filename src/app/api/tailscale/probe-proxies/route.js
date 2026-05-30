import { getNeighbourSnapshot } from "@/lib/tunnel/neighbours";
import http from "node:http";
import net from "node:net";

// POST /api/tailscale/probe-proxies
//
// Body:
//   { username?, password?, ports: number[], types: ["http"|"socks5"], timeoutMs? }
//
// Streams Server-Sent Events:
//   event: start    { peers: N, totalProbes: M }
//   event: probing  { peer, ip, type, port }
//   event: result   { peer, ip, type, port, ok, latency, error?, exitIp? }
//   event: done     { ok, total }
//
// We probe each (online peer × port × type) combination over the
// tailnet wireguard interface, time the GET to a check URL via the
// proxy, and parse exit IP from the response. Failures don't abort
// the run — the user wants to see the whole grid.

const TIMEOUT = 6000;
const CHECK_URL = "http://icanhazip.com/";
const MAX_CONCURRENCY = 16;

async function probeHttp(host, port, user, pass, timeoutMs) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r) => { if (settled) return; settled = true; try { req.destroy(); } catch {} resolve(r); };
    const headers = {
      Host: "icanhazip.com",
      "User-Agent": "9router-tailscale-probe/1.0",
      Connection: "close",
    };
    if (user) {
      const auth = Buffer.from(`${user}:${pass || ""}`).toString("base64");
      headers["Proxy-Authorization"] = `Basic ${auth}`;
    }
    const req = http.request({
      host,
      port,
      method: "GET",
      path: CHECK_URL,
      headers,
      timeout: timeoutMs,
    }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        const ipMatch = body.trim().match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
        finish({
          ok,
          latency: Date.now() - startedAt,
          status: res.statusCode,
          exitIp: ipMatch ? ipMatch[1] : null,
          error: ok ? null : `HTTP ${res.statusCode}`,
        });
      });
    });
    req.on("error", (err) => finish({
      ok: false,
      latency: Date.now() - startedAt,
      error: err.code || err.message,
    }));
    req.on("timeout", () => finish({
      ok: false,
      latency: Date.now() - startedAt,
      error: "timeout",
    }));
    req.end();
  });
}

// Minimal SOCKS5 client. Implements username/password auth (RFC 1929)
// + CONNECT command. Speaks just enough to verify the proxy works
// and pull an IP from icanhazip.
async function probeSocks5(host, port, user, pass, timeoutMs) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    let phase = "greet";
    let buf = Buffer.alloc(0);
    const finish = (r) => { if (settled) return; settled = true; try { sock.destroy(); } catch {} resolve(r); };

    const sock = net.connect({ host, port, timeout: timeoutMs }, () => {
      // greeting: ver=5, nmethods=1 or 2, methods 0x00 (none) and 0x02 (user/pass)
      const methods = user ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]);
      sock.write(methods);
    });
    sock.setTimeout(timeoutMs);
    sock.on("timeout", () => finish({ ok: false, latency: Date.now() - startedAt, error: "timeout" }));
    sock.on("error", (err) => finish({ ok: false, latency: Date.now() - startedAt, error: err.code || err.message }));

    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        if (phase === "greet") {
          if (buf.length < 2) return;
          if (buf[0] !== 0x05) return finish({ ok: false, latency: Date.now() - startedAt, error: "bad-version" });
          const method = buf[1];
          buf = buf.slice(2);
          if (method === 0xff) return finish({ ok: false, latency: Date.now() - startedAt, error: "no-acceptable-method" });
          if (method === 0x02) {
            // Username/Password
            const u = Buffer.from(user || "", "utf8");
            const p = Buffer.from(pass || "", "utf8");
            const out = Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]);
            sock.write(out);
            phase = "auth";
          } else {
            // 0x00 no auth → straight to CONNECT
            sendConnect();
            phase = "connect";
          }
        } else if (phase === "auth") {
          if (buf.length < 2) return;
          if (buf[1] !== 0x00) return finish({ ok: false, latency: Date.now() - startedAt, error: "auth-failed" });
          buf = buf.slice(2);
          sendConnect();
          phase = "connect";
        } else if (phase === "connect") {
          if (buf.length < 4) return;
          if (buf[1] !== 0x00) return finish({ ok: false, latency: Date.now() - startedAt, error: `connect-rsp-${buf[1]}` });
          // skip the BND.ADDR + BND.PORT — figure out address type
          const atyp = buf[3];
          let addrLen;
          if (atyp === 0x01) addrLen = 4;
          else if (atyp === 0x03) addrLen = 1 + buf[4];
          else if (atyp === 0x04) addrLen = 16;
          else return finish({ ok: false, latency: Date.now() - startedAt, error: "bad-atyp" });
          const totalLen = 4 + addrLen + 2;
          if (buf.length < totalLen) return;
          buf = buf.slice(totalLen);
          // CONNECTed — fire HTTP request through the tunnel
          phase = "http";
          const httpReq =
            "GET / HTTP/1.1\r\n" +
            "Host: icanhazip.com\r\n" +
            "User-Agent: 9router-tailscale-probe/1.0\r\n" +
            "Connection: close\r\n\r\n";
          sock.write(httpReq);
        } else if (phase === "http") {
          // Accumulate response, look for body containing IP.
          const text = buf.toString("utf8");
          const headerEnd = text.indexOf("\r\n\r\n");
          if (headerEnd < 0) return;
          const headers = text.slice(0, headerEnd);
          const body = text.slice(headerEnd + 4);
          const statusLine = headers.split("\r\n")[0] || "";
          const m = statusLine.match(/HTTP\/\d\.\d (\d{3})/);
          const status = m ? parseInt(m[1], 10) : 0;
          const ipMatch = body.trim().match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
          finish({
            ok: status >= 200 && status < 300,
            latency: Date.now() - startedAt,
            status,
            exitIp: ipMatch ? ipMatch[1] : null,
            error: status >= 200 && status < 300 ? null : `HTTP ${status}`,
          });
        }
      } catch (e) {
        finish({ ok: false, latency: Date.now() - startedAt, error: e.message });
      }
    });

    function sendConnect() {
      // CONNECT to icanhazip.com (use domain ATYP so resolution happens
      // at the SOCKS server end — important when client lacks DNS).
      const host = "icanhazip.com";
      const hb = Buffer.from(host, "utf8");
      const out = Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, hb.length]),
        hb,
        Buffer.from([0x00, 0x50]), // port 80
      ]);
      sock.write(out);
    }
  });
}

async function probeOne({ host, port, type }, user, pass, timeoutMs) {
  if (type === "http") return probeHttp(host, port, user, pass, timeoutMs);
  if (type === "socks5") return probeSocks5(host, port, user, pass, timeoutMs);
  return { ok: false, latency: 0, error: `unknown type ${type}` };
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const username = (body?.username || "").trim();
  const password = body?.password || "";
  const ports = (Array.isArray(body?.ports) ? body.ports : [])
    .map((x) => parseInt(x, 10))
    .filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
  const types = (Array.isArray(body?.types) ? body.types : []).filter((t) =>
    t === "http" || t === "socks5",
  );
  const timeoutMs = Math.min(Math.max(parseInt(body?.timeoutMs, 10) || TIMEOUT, 1000), 30000);

  if (ports.length === 0 || types.length === 0) {
    return new Response(JSON.stringify({ error: "ports[] and types[] required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const snap = getNeighbourSnapshot();
  if (!snap.loggedIn) {
    return new Response(JSON.stringify({ error: "Tailscale not logged in" }), {
      status: 412,
      headers: { "Content-Type": "application/json" },
    });
  }

  const onlinePeers = snap.peers.filter((p) => p.online && p.ipv4);
  const tasks = [];
  for (const peer of onlinePeers) {
    for (const port of ports) {
      for (const type of types) {
        tasks.push({
          peer: peer.hostname || peer.dnsName || peer.ipv4,
          ip: peer.ipv4,
          host: peer.ipv4,
          port,
          type,
        });
      }
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event, data) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      send("start", { peers: onlinePeers.length, totalProbes: tasks.length });

      let okCount = 0;
      const queue = [...tasks];
      const workers = new Array(Math.min(MAX_CONCURRENCY, queue.length))
        .fill(0)
        .map(async () => {
          while (queue.length > 0 && !closed) {
            const t = queue.shift();
            send("probing", { peer: t.peer, ip: t.ip, type: t.type, port: t.port });
            const r = await probeOne(t, username, password, timeoutMs);
            if (r.ok) okCount++;
            send("result", {
              peer: t.peer,
              ip: t.ip,
              type: t.type,
              port: t.port,
              ok: r.ok,
              latency: r.latency,
              status: r.status || null,
              exitIp: r.exitIp || null,
              error: r.error || null,
            });
          }
        });
      await Promise.all(workers);
      send("done", { ok: okCount, total: tasks.length });
      if (!closed) {
        try { controller.close(); } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
