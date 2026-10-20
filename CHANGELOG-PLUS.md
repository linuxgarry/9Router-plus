# 9Router-Plus 更新说明

> 基于 [decolua/9router](https://github.com/decolua/9router) v0.4.52 的二次开发分支
> Fork 时间:2026-05-18

## 🎯 核心改造

把原项目的「代理池」从一个**单条 HTTP 代理列表**升级为「**Clash 订阅 + WARP 跳板 + 一键测速 + 固定端口转发**」一体化代理网关。

```
                                       ┌──────────────────────────┐
   订阅 URL  ──┐                       │   mihomo (新增,容器内置)  │
   CSV 导入  ──┼─►  ProxyPool DB ─────►│   external-controller    │
   单条添加  ──┘                       │   :9090                  │
                                       └────────┬─────────────────┘
                                                │
                          ┌─────────────────────┼─────────────────────┐
                          │                     │                     │
                    mixed-port            listeners                出口
                     :7890                10001..10050   ────►  WARP? (可选)
                     (默认全局)            (Top 50 固定)
```

---

## ✨ 新功能

### 1. Clash 订阅(全局)
- 代理池页顶部新增「**Clash 订阅**」卡片(对齐图二样式)
- 输入订阅 URL,「**保存并加载**」一键拉取节点
- 订阅链接 + raw yaml **永久保存**到 SQLite,容器重启自动恢复
- 支持 ss / vmess / vless / trojan / hysteria2 / tuic 等所有 mihomo 内核协议
- 节点自动落到 `proxyPools` 表,与原有「批量导入」「Vercel Relay」等机制并存

**新增 API**:
- `GET/POST /api/clash-subscriptions` — 列出 / 新增订阅
- `PUT/DELETE /api/clash-subscriptions/[id]` — 更新 / 删除
- `POST /api/clash-subscriptions/[id]/load` — 拉取并加载到代理池

**新增表**:`clashSubscriptions`(id / url / name / enabled / nodeCount / lastLoadedAt / data / 时间戳)

---

### 2. WARP 跳板服务
- 订阅卡片右侧加 checkbox **「经 WARP 跳板」**
- 勾选后展开设置面板:
  - **内置 wgcf 自动注册**(推荐)— 容器内自动跑 `wgcf register && wgcf generate`,生成免费 WARP 账户,零配置
  - **自定义 WireGuard** — 贴 `[Interface]/[Peer]` 文本,适配 WARP+ / Zero Trust
- 启用后 mihomo 把每个节点串 `relay → WARP`,所有出口流量经 Cloudflare WARP

**新增 API**:`GET/PUT /api/warp` `POST /api/warp/test`

---

### 3. CSV 代理池导入
- 代理池页新增「**导入 CSV**」按钮(批量导入旁)
- 支持 OutlookRegister 项目的 `clashxlist_full.csv` 格式(列头 `id,source,name,type,server,port,raw,status,country,exit_ip,latency_ms`)
- `raw` 列直接 `JSON.parse` 出 mihomo proxy dict
- 默认跳过 `status=False` 行,可勾选「同时导入未验证节点」
- 重名节点自动以 `<name>__<csv_id>` 去重
- 带导入结果汇总:成功 / 跳过 / 失败 / 错误明细

**新增 API**:`POST /api/proxy-pools/import-csv`(支持 20 MB)

---

### 4. 一键测速 + Top 50 端口映射
- 代理池页新增「**Top 50 极速代理**」卡片
- 「一键测速」并发 30 调用 `mihomo /proxies/<name>/delay`
- 排序取最快 50 个,**绑定到本地端口 10001-10050** (mihomo `listeners`)
- 外部程序直接 `curl -x http://host:10001 https://api.ipify.org` 即可使用
- 表格展示:`端口 | 节点名 | 归属地 | 出口 IP | 延迟 ms | 状态`
- 测试 URL 默认 `http://www.gstatic.com/generate_204`,可在请求 body 里覆盖
- WARP 开启时,延迟反映"过 WARP 之后"的真实表现
- 每次测速重排,端口 ↔ 节点的映射会刷新(取舍:保证始终是当前最快的 50 个)

**新增 API**:
- `POST /api/proxy-pools/speed-test` — 触发测速 + 重排 Top 50
- `GET /api/proxy-pools/speed-test` — 读当前 Top 50 映射

---

## 🐳 Docker 改造

### Dockerfile 增量
- 基础镜像不变(`node:22-alpine`)
- 新增二进制下载层:
  - `mihomo v1.18.8` linux-amd64 → `/usr/local/bin/mihomo`
  - `wgcf v2.2.19` linux-amd64 → `/usr/local/bin/wgcf`
- 新增 `supervisor` 进程管理器
- `/etc/supervisor/conf.d/9router.conf` 同时拉起:
  - `9router` — Next.js 主服务(原 `node server.js`)
  - `mihomo` — 内核守护(`mihomo -d /app/data/mihomo`)
- 入口脚本 `/entrypoint.sh` 改为 `supervisord` 启动

### 新增持久化目录(全部在 `/app/data` 卷下)
```
/app/data/
├── data.sqlite              # 原有(新增 clashSubscriptions 表)
├── mihomo/
│   ├── config.yaml          # 后端动态生成
│   ├── .secret              # external-controller bearer token
│   └── top-fixed.json       # Top 50 端口映射
└── warp/
    ├── enabled              # WARP 开关持久化
    ├── settings.json        # 模式 + 自定义配置
    ├── wgcf-account.toml    # wgcf 注册账户
    └── wgcf-profile.conf    # WireGuard 配置
```

### 暴露端口
- `20128` — 原 9router 控制台(不变)
- `7890` — mihomo mixed-port(新增)
- `10001-10050` — Top 50 极速代理(新增)

### 部署命令变化
```bash
# 原命令
docker run -d -p 20128:20128 -v 9router-data:/app/data 9router

# 新命令(端口 + 卷不变,只是多了端口转发)
docker run -d \
  -p 20128:20128 \
  -p 7890:7890 \
  -p 10001-10050:10001-10050 \
  -v 9router-data:/app/data \
  9router-plus
```

**完全兼容原有数据卷**:旧数据库会自动迁移加表 `clashSubscriptions`,无需手动 reset。

---

## 📁 改动文件清单

### 新增
```
src/lib/mihomo/index.js                              mihomo 配置生成 + API 客户端
src/lib/warp/index.js                                WARP/wgcf 服务封装
src/lib/db/repos/clashSubscriptionsRepo.js           Clash 订阅 repo
src/app/api/clash-subscriptions/route.js             订阅列表 / 新增
src/app/api/clash-subscriptions/[id]/route.js        订阅 PUT/DELETE
src/app/api/clash-subscriptions/[id]/load/route.js   订阅拉取 + 入库 + mihomo reload
src/app/api/proxy-pools/import-csv/route.js          CSV 导入
src/app/api/proxy-pools/speed-test/route.js          测速 + Top 50 编排
src/app/api/warp/route.js                            WARP 状态 / 切换 / 测试
src/app/(dashboard)/dashboard/proxy-pools/ClashSubscriptionCard.js
src/app/(dashboard)/dashboard/proxy-pools/Top50Table.js
src/app/(dashboard)/dashboard/proxy-pools/CsvImportModal.js
CHANGELOG-PLUS.md                                    本文件
```

### 修改
```
Dockerfile                                           加 mihomo + wgcf + supervisor
src/lib/db/schema.js                                 加 clashSubscriptions 表定义
src/lib/db/index.js                                  导出订阅 repo
src/lib/localDb.js                                   shim 重导出
src/models/index.js                                  models barrel 导出
src/app/(dashboard)/dashboard/proxy-pools/page.js    挂三个新组件 + 新按钮
```

---

## 🔄 迁移注意

1. **数据库**:启动时自动加 `clashSubscriptions` 表(走 `syncSchemaFromTables`),无破坏性改动
2. **环境变量**:不变
3. **JWT/MITM 证书**:不变,继续使用原有 `/app/data-home/` 与 `/app/data/`
4. **节点存储**:Clash / CSV 导入的节点写入 `proxyPools.clashProxy` 字段,与原有 `proxyUrl` 字段共存

---

## 🧪 验证

1. `docker build -t 9router-plus:dev .`
2. `docker run -d -p 20128:20128 -p 7890:7890 -p 10001-10050:10001-10050 -v $(pwd)/data:/app/data 9router-plus:dev`
3. 浏览器进 http://localhost:20128/dashboard/proxy-pools:
   - Clash 订阅区贴一个真实订阅 → 「保存并加载」→ 节点出现在下方代理池
   - 上传 `clashxlist_full.csv` → 几千节点入库
   - 「一键测速」→ Top 50 表填满,端口 10001-10050 就绪
   - 勾选「经 WARP 跳板」→ 重新测速,出口 IP 全部变 Cloudflare 段
4. 终端验证:
   ```bash
   curl -x http://localhost:10001 https://api.ipify.org   # 拿到某海外 IP
   curl -x http://localhost:7890 https://www.cloudflare.com/cdn-cgi/trace | grep warp
   # warp=on(WARP 启用时)
   ```
5. `docker restart`:订阅 + Top 50 + WARP 状态全部自动恢复

---

## ⚠️ 已知取舍

- **每次测速重排都会刷新端口 ↔ 节点的映射**。这是有意设计——保证 10001-10050 始终是当前最快的 50 个。如果外部程序按"端口=固定身份"用,要接受这种漂移
- mihomo 配置 `mode: global`,所有出口都走选定节点。原 9router 的 MITM 工作流不受影响(走的是 Next.js 主进程,不经过 mihomo)
- WARP 内置模式用的是 Cloudflare 免费 WARP 账户,有带宽限制。生产环境建议自备 WARP+ Key 走自定义模式

---

## 🗓️ 2026-05-19 后续迭代时间线

> 这一波 24 个 commit 在初版基础上做了**架构级调整**:Top 50 + CSV 模型砍掉,换成「按需测速 + 真实 listener 探测 + 多模块叠加」的形态。同时加了 Tailscale、SSL、IP 检测下拉、i18n 一系列模块。

### 🚪 部署 / 镜像
- 🐳 `cfcf331` — 移除 BuildKit `--mount=type=cache` 兼容 legacy docker
- 🌱 `54269eb` — entrypoint.sh 首次启动写默认 mihomo config + .secret(避免 9090 上不来)
- 🛡️ `415daec` — **Tailscale + tailscaled 内置进镜像**(userspace-networking,免 NET_ADMIN)
- 🔒 `259953a` — **Caddy v2.8.4 内置进镜像**,supervisor 管理 + RPC socket 暴露
- 🔧 `f6275fc` — supervisorctl 改用 `-c` 指定项目配置文件

### 🧹 架构调整
- 🔥 `a8a5edd` — **砍掉 Top 50 + CSV 导入功能**(`Top50Table.js` / `CsvImportModal.js` / `import-csv` / `speed-test` 全部删除)。改为按需测速 + 每行展示出口 IP / 国家
- 🔁 `4517804` — 测速完全重写:不再用 mihomo 内部 `/proxies/<n>/delay`(404 就秒返),而是真起 listener 绑端口 → http.request 走 `127.0.0.1:port`,end-to-end http 验证
- 🔄 `9f250aa` — 连接级代理重构:`EditConnectionModal` 加「直连 / 自定义 / Clash 订阅 / 自建池」四选一互斥;原行内的 Proxy 按钮删除
- 🛠️ `0f690a9` — `createProxyPool` 字段保留 bug 修复(原本 spread 把 clashProxy/source/country 丢了);代理池按 source 分组折叠;批量操作 endpoint;FileDropZone 拖拽

### 🛡️ WARP 模块演进
- 🌐 `4517804` — **WARP 多账户**:`/lib/warp/accounts.js` 管理独立 wgcf 注册;每个账户镜像成 ProxyPool 行;批量 SSE 注册(1-20 个);`WarpAccountsCard` 卡片
- 🔧 `dbe00d0` — wgcf 配置 reserved/ipv6 字段空时不输出(否则 mihomo 拒载整个 config)
- 🎲 `a21aea2` — **每个 WARP 账户绑定随机 IPv4 endpoint**(分散到不同 PoP → 不同出口 IP)+ 单条 / 批量 reroll API + UI 按钮
- 📥 `74ec105` — **自定义 WireGuard 配置导入**(粘贴多份 / 拖拽多文件 / 批量 SSE)
- 🗑️ `08b8563` — WARP 多线路加批量 checkbox + 「批量删除 N 个」按钮

### 🔗 Tailscale 邻居代理探测
- 🆕 `91fcc63` — **新模块**:代理池页加「🔗 Tailscale Neighbour Proxy Probe」卡片
  - GET/POST `/api/tailscale/{status,login,probe-proxies,import-proxies}`
  - 一键授权 → 浏览器 OAuth → 探测所有在线邻居(账号/密码/端口/类型)→ 通的一键入池
  - SSE 实时进度 + 结果表格

### 🔒 SSL / HTTPS 模块
- 🆕 `259953a` — **新模块**:Endpoint 页加「🔒 SSL / HTTPS」卡片
  - GET/PUT `/api/ssl`,POST `/api/ssl/{start,stop,upload-cert,check-domain}`
  - 域名 DNS 检测(避免 ACME 限流)
  - ACME 自动签发 / 续签 + 手动证书上传二选一
  - 端口可自定义(默认 443/80)

### 🌐 IP 检测接口下拉框
- 🚫 `683d8ab` — **删信 X-Forwarded-For 的接口**(ipify / ipinfo / ip-api / ip.sb)
  - 默认改为 icanhazip / ifconfig.me / ifconfig.co / myip.wtf / wtfismyip
  - 新卡片 `IpCheckUrlsCard`:已知接口下拉选 + 粘贴自定义 + 上下移动 + 删除 + 恢复默认
  - GET 接口同时返回 `IP_CHECK_URL_CATALOG`

### 🧪 测速 + 出口 IP 探测
- 🩹 `08b8563` — 单行测速 `Proxy pool not found` 修复(handleTest 传参错);Vercel egress test 加 `pool-vercel` 模式
- 🔄 `af79275` — **vercel-relay 单行测速**改用 `probeViaVercelRelay`,真返回 latency + 出口 IP + 国家
- 🩹 `db7e0df` — 加 mihomo 健康徽章(顶部 10s 轮询);测速 SSE 流;每行单独 retest 按钮
- 🔍 `868e442` — 连接编辑保存时把 proxyPoolId 同步到顶层 body(原本嵌套在 providerSpecificData 里被后端 normalize 忽略);legacy `/test` 对 http/socks5 也探出口 IP / 国家

### 🌍 i18n
- 🇨🇳 `7a52ec9` — Vercel Relay 部署说明 + 代理池常用标签的 zh-CN 翻译(13 条新增)
- 🇨🇳 `e48f1ff` — **新卡片(IpCheckUrls / WarpAccounts / TailscaleNeighbors / Ssl)全部从硬编码中文换成英文源**;zh-CN 字典补 103 条新映射;运行时 DOM 翻译保证非中文用户正确显示

### 🛠️ 杂项修复
- 🩹 `19cff03` — Next.js 16 dynamic route 的 `params` 是 Promise 必须 await(原本同步解构导致删除/编辑订阅 404);加手动 YAML 导入路由
- 🩹 `9e3b4b6` — mihomo 不认的 proxy type(anytls 等)整行过滤(否则一个不认的就拒载整个 config)
- 🩹 `b148797` — WarpAccountsCard JSX fragment 闭合修复
- 🚧 `4653543` — 临时移除 `.github/workflows/*.yml`(PAT 缺 workflow scope,后续补回)

---

## 📋 当前模块全景

```
代理池页 /dashboard/proxy-pools
├── 🌍 mihomo 健康徽章          MihomoHealthBadge
├── 🔗 Clash 订阅              ClashSubscriptionCard
├── 🛡️ WARP 多线路             WarpAccountsCard
│   ├── 批量生成 wgcf
│   ├── 自定义 WG 导入(拖拽/粘贴/批量)
│   ├── 重排 endpoint(单条/全部)
│   └── 批量删除
├── 🌐 IP 检测接口             IpCheckUrlsCard
├── 🔗 Tailscale 邻居代理探测  TailscaleNeighborsCard
└── 代理池主列表(分组 checkbox + 每行测速)

端点页 /dashboard/endpoint
├── 🚇 Tunnel(原有)
├── 🛡️ Tailscale Funnel(原有,登录入口)
└── 🔒 SSL / HTTPS              SslCard

编辑连接(任何 provider)
└── 代理设置:直连 / 自定义 / Clash / 自建池(四选一)+ Test Connection 出口 IP 探测
```

---

## 📜 License

继承上游 MIT License.
