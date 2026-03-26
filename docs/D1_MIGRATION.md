# 从 KV 迁移到 D1（本项目实战版）

你这个项目目前所有状态都写在 `env.IPTV_KV` 里（用户、session、token、IP 列表、频道、配置）。迁移到 D1 的核心目标是：

1. **结构化存储**（查询更精确，能做 JOIN）。
2. **一致性更好**（尤其是 token/IP 限制这种需要强一致的逻辑）。
3. **后续扩展更轻松**（统计、审计、批量管理）。

---

## 1) 先绑定 D1

在 `wrangler.toml` 添加 D1 绑定（名字可改，但要和代码里一致）：

```toml
[[d1_databases]]
binding = "IPTV_DB"
database_name = "iptv-db"
database_id = "<your-d1-database-id>"
```

然后初始化库：

```bash
npx wrangler d1 execute iptv-db --file=docs/d1-schema.sql
```

> 说明：本仓库已经提供了可直接执行的 schema：`docs/d1-schema.sql`。

---

## 2) KV Key 到 D1 表映射

| KV Key 前缀 | D1 表 | 备注 |
|---|---|---|
| `user:<username>` | `users` | `password` 直接存明文（建议迁移时改哈希） |
| `session:<id>` | `sessions` | 用 `expires_at` 替代 KV TTL |
| `token:<token>` | `tokens` | `ip_limit` + `expires_at` |
| `ips:<token>` | `token_ips` | 一条 IP 一行，不再存 JSON 数组 |
| `owner:<token>` | `tokens.owner_username` | 合并字段 |
| `user_tokens:<username>` | `user_tokens` | 关系表 |
| `data:channels` | `channels` | 一行一个频道 |
| `config:*` | `config` | key-value 配置 |

---

## 3) 代码改造顺序（建议按阶段做）

### 阶段 A：只迁移“读路径”

- 保留 KV 写入。
- 读取优先走 D1，查不到再回退 KV。
- 先改这几个高频函数：
  - `getUserSession`
  - `generateUserM3U`
  - `handlePlay`

### 阶段 B：迁移“写路径”

把 `handleUserAPI` / `handleAdminAPI` 里的 `KV.put/delete/list` 全部替换成 SQL：

- 注册：`INSERT INTO users ...`
- 登录：`INSERT INTO sessions ...`
- 绑定 token：事务里同时写 `tokens.owner_username` 与 `user_tokens`
- 清理 IP：`DELETE FROM token_ips WHERE token = ?`
- token 管理：`INSERT/UPDATE/DELETE tokens`

### 阶段 C：下线 KV

- 全量压测通过后，删除 KV 绑定与 KV 分支逻辑。
- 保留一次性回滚开关（比如 `USE_D1=true/false`）观察 1~2 周。

---

## 4) 关键 SQL 示例

### 4.1 会话校验（替代 `session:<id>`）

```sql
SELECT username
FROM sessions
WHERE session_id = ?
  AND expires_at > unixepoch();
```

### 4.2 token + IP 限流判断

```sql
SELECT ip_limit, expires_at
FROM tokens
WHERE token = ?
  AND (expires_at IS NULL OR expires_at > unixepoch());
```

```sql
SELECT COUNT(*) AS used
FROM token_ips
WHERE token = ?;
```

```sql
INSERT OR IGNORE INTO token_ips(token, ip)
VALUES (?, ?);
```

### 4.3 用户看板 token 列表

```sql
SELECT t.token, t.ip_limit,
       (SELECT COUNT(*) FROM token_ips i WHERE i.token = t.token) AS used,
       t.expires_at
FROM user_tokens ut
JOIN tokens t ON t.token = ut.token
WHERE ut.username = ?;
```

### 4.4 更新频道（替代 `data:channels` 整包 JSON）

建议用事务：

1. `DELETE FROM channels;`
2. 批量 `INSERT OR REPLACE INTO channels ...`

---

## 5) 数据回填（一次性迁移脚本思路）

可做一个只跑一次的脚本：

1. 读取 KV 全量 key。
2. 按前缀解析并写入对应表。
3. 记录失败条目到日志表或文件。
4. 跑完做一致性核对：
   - 用户数
   - token 数
   - token 绑定关系数
   - 频道数

如果你愿意，我下一步可以直接帮你把 `src/index.js` 按“**先双写、再切读**”方式改成可灰度上线的版本（含最小侵入改造）。
