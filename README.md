# 📺 M3U Proxy & Token Management System

基于 Worker Runtime（Wrangler）+ Docker 的轻量级 M3U 代理与用户分发系统。

本版本已改造为：
- ✅ **Docker 部署**（可直接容器运行）
- ✅ **Upstash Redis** 作为数据存储
- ✅ **GitHub Actions 自动构建并推送 GHCR 镜像**

---

## ✨ 核心功能

* Token 鉴权 + IP 限制（支持 0 表示无限）
* 用户注册/登录/绑定 Token
* 管理后台：源配置、同步、Token 管理、通知发布
* `/play/:id` 302 转发隐藏真实源地址
* 提供 `/sub`、`/sub/tvbox`、`/sub/txt` 三种订阅格式

---

## 🗄️ 数据库：支持 Upstash 与标准 Redis

默认使用 Upstash（`DB_TYPE=upstash`）：

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

也可切换为标准 Redis（`DB_TYPE=redis`），例如：

- `REDIS_URL=redis://default:password@host:port`
- 或 `REDIS_URL=rediss://default:password@host:port`（TLS）
- 若供应商只给 `redis://` 但实际要求 TLS，可额外设置 `REDIS_TLS=true`（若握手失败会自动回退到非 TLS，避免直接 500）

> `DB_TYPE=redis` 适用于 Node/Docker 启动（`npm run start`）。Cloudflare Worker 线上环境请继续使用 Upstash REST 变量。

---

## 🐳 Docker 部署

### 1) 本地构建

```bash
docker build -t m3ugc:local .
```

### 2) 运行容器

```bash
docker run -d --name m3ugc \
  -p 8787:8787 \
  -e DB_TYPE="upstash" \
  -e UPSTASH_REDIS_REST_URL="https://<your-upstash>.upstash.io" \
  -e UPSTASH_REDIS_REST_TOKEN="<your-token>" \
  -e DEFAULT_ADMIN_USER="admin" \
  -e DEFAULT_ADMIN_PASS="admin123" \
  -e LINUXDO_CLIENT_ID="<optional>" \
  -e LINUXDO_CLIENT_SECRET="<optional>" \
  -e NODELOC_CLIENT_ID="<optional>" \
  -e NODELOC_CLIENT_SECRET="<optional>" \
  -e CLOUDFLARE_TURNSTILE_SITE_KEY="<optional>" \
  -e CLOUDFLARE_TURNSTILE_SECRET_KEY="<optional>" \
  m3ugc:local
```

访问：
- 用户面板：`http://localhost:8787/`
- 管理后台：`http://localhost:8787/admin`

### 3) Cloudflare Turnstile 人机验证（可选）

登录/注册页支持 Cloudflare Turnstile。若配置以下两个环境变量，页面会自动显示 Turnstile 小组件，并在账号密码登录/注册接口校验验证结果：

- `CLOUDFLARE_TURNSTILE_SITE_KEY`
- `CLOUDFLARE_TURNSTILE_SECRET_KEY`

若不配置，登录页保持原有行为。

### 4) 两个 OAuth 授权登录（可选）

项目内的 **Linux DO** 与 **NodeLoc** 授权登录逻辑仍保留，配置对应环境变量后即可启用：

- `LINUXDO_CLIENT_ID`
- `LINUXDO_CLIENT_SECRET`
- `NODELOC_CLIENT_ID`
- `NODELOC_CLIENT_SECRET`

对应回调地址：

- `http://<你的域名>/api/auth/linuxdo/callback`
- `http://<你的域名>/api/auth/nodeloc/callback`

### 5) 外部 Cloudflare Workers Cron 定时抓取

已移除运行时内置 `scheduled` 触发，改为显式 HTTP 触发，便于你用外部 Cloudflare Workers Cron 调用。

请配置环境变量：

- `CRON_SECRET`

触发地址（GET/POST 都可）：

- `http://<你的域名>/api/cron/sync?key=<CRON_SECRET>`
- 或请求头带：`x-cron-key: <CRON_SECRET>` 调用 `http://<你的域名>/api/cron/sync`

返回 JSON 即同步结果（同管理后台“立即抓取”逻辑）。

---

## 📦 GHCR 自动构建

仓库内置工作流：`.github/workflows/ghcr.yml`

触发条件：
- push 到 `main`
- push 标签 `v*`
- 手动触发 `workflow_dispatch`

镜像地址格式：

```text
ghcr.io/<owner>/<repo>:latest
ghcr.io/<owner>/<repo>:<tag>
ghcr.io/<owner>/<repo>:sha-xxxxxxx
```

---

## 🛠️ 开发

```bash
npm install
npm run dev
```

容器/Render 启动命令（生产部署使用）：

```bash
npm run start
```

> `npm run start` 现在是 Node HTTP Server（`src/server.js`），不依赖 `wrangler dev`，更适合 Render/Fly.io 等平台。

---

## 🔐 备注

- 默认管理员账号密码可通过 `DEFAULT_ADMIN_USER` / `DEFAULT_ADMIN_PASS` 覆盖。
- Redis key TTL 用于实现 Token 与 Session 过期。
- 管理后台展示过期时间时，基于写入时同步保存的过期元数据。


### 2.1) 使用标准 Redis URL（可选）

```bash
docker run -d --name m3ugc \
  -p 8787:8787 \
  -e DB_TYPE="redis" \
  -e REDIS_URL="redis://default:password@your-host:6379" \
  -e REDIS_TLS="true" \
  -e DEFAULT_ADMIN_USER="admin" \
  -e DEFAULT_ADMIN_PASS="admin123" \
  m3ugc:local
```
