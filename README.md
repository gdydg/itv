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

## 🗄️ 数据库：Upstash Redis

项目使用以下环境变量连接 Upstash：

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

可在 [Upstash 控制台](https://console.upstash.com/) 创建 Redis 并获取 REST URL 与 Token。

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
  -e UPSTASH_REDIS_REST_URL="https://<your-upstash>.upstash.io" \
  -e UPSTASH_REDIS_REST_TOKEN="<your-token>" \
  -e DEFAULT_ADMIN_USER="admin" \
  -e DEFAULT_ADMIN_PASS="admin123" \
  -e LINUXDO_CLIENT_ID="<optional>" \
  -e LINUXDO_CLIENT_SECRET="<optional>" \
  -e NODELOC_CLIENT_ID="<optional>" \
  -e NODELOC_CLIENT_SECRET="<optional>" \
  m3ugc:local
```

访问：
- 用户面板：`http://localhost:8787/`
- 管理后台：`http://localhost:8787/admin`

### 3) 两个 OAuth 授权登录（可选）

项目内的 **Linux DO** 与 **NodeLoc** 授权登录逻辑仍保留，配置对应环境变量后即可启用：

- `LINUXDO_CLIENT_ID`
- `LINUXDO_CLIENT_SECRET`
- `NODELOC_CLIENT_ID`
- `NODELOC_CLIENT_SECRET`

对应回调地址：

- `http://<你的域名>/api/auth/linuxdo/callback`
- `http://<你的域名>/api/auth/nodeloc/callback`

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
