# 9Router-Plus 🚀

> 基于 [decolua/9router](https://github.com/decolua/9router) (v0.4.52) 的二次开发分支 —— 把基础代理池面板升级为「**全栈代理网关**」,集成 Clash 订阅、WARP 多线路、Tailscale 节点探测、SSL/HTTPS 等。

---

## ✨ 与原版的区别

| 模块 | 原版 9router | 9Router-Plus |
|------|-------------|--------------|
| **代理池** | 单条 HTTP 代理列表 | Clash 订阅 + WARP + Tailscale + Vercel relay |
| **代理内核** | 无(只存 URL) | mihomo v1.18.8 内置进 Docker |
| **WARP** | 不支持 | 多账户 wgcf + 自定义 WireGuard 导入 + 每账户独立 endpoint |
| **Tailscale** | 仅桌面安装流程 | 容器内置 + 邻居代理探测卡片 |
| **SSL/HTTPS** | 不支持 | Caddy 反代 + ACME 自动续签 / 手动证书 |
| **测速** | 简单 URL ping | 真起 mihomo listener 探测 + 出口 IP / 国家识别 |
| **IP 检测** | ipify / ipinfo(信 XFF) | 默认改为不信 XFF 的接口(icanhazip / ifconfig.me / myip.wtf)+ 可配置目录 |
| **多语言** | 部分支持 | 所有新卡片用英文源 + zh-CN 字典(运行时 DOM 翻译) |
| **Docker** | 单 node 进程 | supervisor 同时管理 node + mihomo + tailscaled + caddy |

---

## 🧩 新增模块

### 🔗 Clash 订阅(全局)
- 输入订阅 URL → 自动拉取 YAML → 所有节点导入代理池
- 支持手动粘贴 / 上传 YAML
- 容器重启后自动恢复
- 支持 ss / vmess / vless / trojan / hysteria2 / tuic / wireguard 协议

### 🛡️ WARP 多线路
- 批量 wgcf 注册(一次 1-20 个账户)
- 每个账户绑定**随机的 Cloudflare IPv4 endpoint** → 不同 PoP → 不同出口 IP
- 🎲 一键重排 endpoint(单条 / 全部),不需要重新注册
- 📥 导入自定义 WireGuard 配置(粘贴多份 / 拖拽多文件)
- checkbox 多选批量删除
- 每行测速 + 出口 IP + 国家识别

### 🔗 Tailscale 邻居代理探测
- tailscaled 内置进 Docker(userspace-networking 模式,不需要 NET_ADMIN)
- 🔐 在代理池页一键授权 Tailscale
- 用同一套 用户名 / 密码 / 端口 / 类型 探测所有在线 tailnet 邻居
- SSE 流式返回结果,实时显示延迟 + 出口 IP
- 一键将通的代理加入代理池

### 🔒 SSL / HTTPS(端点页)
- Caddy v2.8.4 内置进镜像
- ACME(Let's Encrypt)自动签发 + 续签 —— 或手动上传证书
- **绑定前自动检测域名 DNS**(避免 ACME 限流)
- HTTPS/HTTP 端口可自定义(默认 443/80)
- 反代到 dashboard(后端可配置)

### 🌐 IP 检测接口
- 默认列表只含**不信 X-Forwarded-For** 的服务(icanhazip / ifconfig.me / ifconfig.co / myip.wtf / wtfismyip)
- UI 下拉选择:已知接口添加 / 粘贴自定义 / 排序 / 恢复默认
- 经 vercel-relay 或其他转发时也能拿到准确的真实出口 IP

### 📊 代理池增强
- **分组级 checkbox**:在 source 头部勾选,一次选 / 删整个订阅
- **每行 🧪 测速**:mihomo 兼容节点走真实 listener 端口探测
- **每行显示**:出口 IP + 国家 + 城市
- **Vercel relay 测速**:正确返回 Vercel 数据中心 IP(而不是 server 自己的 IP)
- **编辑连接保存**:proxyPoolId 现在能正确持久化(原版会静默丢失)

---

## 🐳 Docker 快速开始

```bash
docker run -d --name 9router \
  --restart unless-stopped \
  -p 20128:20128 \
  -p 7890:7890 \
  -p 80:80 \
  -p 443:443 \
  -v /var/lib/9router:/app/data \
  9router-plus:latest
```

| 端口 | 服务 |
|------|------|
| 20128 | Dashboard / API |
| 7890 | mihomo 混合端口(全局代理) |
| 80 | Caddy HTTP(ACME 验证) |
| 443 | Caddy HTTPS(反代到 dashboard) |

> 💡 80 / 443 仅在启用 SSL 时需要。不用 SSL 只映射 20128 + 7890 即可。

### 从源码构建

```bash
git clone https://github.com/linuxgarry/9Router-plus.git
cd 9Router-plus
docker build -t 9router-plus:latest .
```

---

## 🏗️ 架构

```
┌─────────────────────────────────────────────────────────┐
│  Docker 容器(node:22-alpine)                            │
│                                                         │
│  supervisord                                            │
│  ├── [program:9router]    node server.js (:20128)       │
│  ├── [program:mihomo]     mihomo -d /app/data/mihomo    │
│  ├── [program:tailscaled] tailscaled (userspace 模式)   │
│  └── [program:caddy]      caddy run (autostart=false)   │
│                                                         │
│  /app/data/(持久卷)                                     │
│  ├── db/data.sqlite       proxyPools + clashSubs + ...  │
│  ├── mihomo/config.yaml   9router 自动生成              │
│  ├── tailscale/           tailnet 身份 + 状态           │
│  ├── caddy/               Caddyfile + 证书 + 配置       │
│  └── warp/accounts/       每账户独立 wgcf 注册          │
└─────────────────────────────────────────────────────────┘
```

---

## 📝 兼容性说明

- 数据卷 `/app/data` **完全兼容**原 9router 镜像
- 已有的 SQLite 数据自动迁移(启动时声明式 schema 同步)
- 原版所有功能(providers / connections / API keys / MITM / CLI 工具)保留
- `↑ New version available` 提示来自上游 —— 本 fork 独立维护版本

---

## 🔗 相关链接

- **本仓库**: https://github.com/linuxgarry/9Router-plus
- **上游**: https://github.com/decolua/9router
- **mihomo 文档**: https://wiki.metacubex.one/
- **wgcf**: https://github.com/ViRb3/wgcf
- **Tailscale**: https://tailscale.com/
- **Caddy**: https://caddyserver.com/

---

## 📄 许可证

同上游 —— 见 [LICENSE](./LICENSE)。
