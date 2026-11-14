# EAB 可选后端插件与部署

本文说明 EAB 的可选后端插件：**不接 PostgreSQL / Redis 也能完整运行**；接了以后按任意组合生效；外部服务连不上默认降级，不阻塞启动。

## 1. 硬约束

| 场景 | 结果 |
|---|---|
| 新机器只装 Node / pnpm，不装任何数据库 | SQLite + 进程内内存缓存，员工端、控制台、插件、知识库全部可用 |
| 只接 Redis | SQLite 主库 + Redis 优先缓存，Redis 故障自动落回内存 |
| 只接 PostgreSQL | SQLite 主库 + PostgreSQL 审计/会话镜像 |
| 两个都接 | SQLite + Redis 缓存 + PostgreSQL 审计/会话镜像 |
| 接错地址 / 外部服务没启动 | 默认降级并继续启动；只有 `EAB_BACKENDS_STRICT=1` 才启动失败 |

SQLite 仍是当前唯一主库。**PostgreSQL 当前承接审计镜像和会话镜像，不替换主库**，原因见第 4 节。

> 组合通过环境变量选择，**重启服务后生效**；控制台只负责展示当前状态，不提供在线切换，避免运行中换存储造成数据不一致。


## 2. 插件边界

后端代码在 `packages/server/src/backends/`：

```text
types.ts      后端状态与插件契约（state / capabilities / metrics，不回显连接串）
cache.ts      MemoryCache、RedisCache、HybridCache
postgres.ts   PostgresAuditMirror（批量审计旁路）
postgres-chat.ts PostgresChatMirror（会话 outbox 批量镜像）
audit-read.ts 审计列表/导出只读仓储（SQLite / PG / 回退）
chat-read.ts  会话列表只读仓储（SQLite / PG / 回退）
runtime.ts    按配置装配、失败降级、状态汇总、退出收尾
```

装配入口是 `initBackends(config, db)`，在 `main.ts` 的 `migrate(db)` 之后、`buildApp()` 之前执行。所有后端只通过 `BackendRuntime` 暴露：

- `cache`：业务可用的缓存接口；
- `postgres`：审计镜像；
- `chatMirror`：会话镜像；
- `auditRead` / `chatRead`：两条只读仓储；
- `statuses()`：控制台与健康检查读取的状态；
- `close()`：退出时收尾。

新增一种外部后端（例如 MySQL 主库、对象存储、向量库）时，按同一模式增加一个模块，再在 `runtime.ts` 装配并加入 `statuses()`。业务代码只依赖 `BackendRuntime`，不直接依赖具体驱动。当前已接线的是 Redis 与 PostgreSQL；MySQL / SQL Server 还没有实现，需要按这个边界新增插件，而不是改一行连接串。

## 3. 配置矩阵

| 环境变量 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `EAB_CACHE` | `auto` / `memory` / `redis` / `off` | `auto` | `auto` 且配置了 `EAB_REDIS_URL` 时用 Redis；`memory` / `off` 都只使用内存缓存 |
| `EAB_REDIS_URL` | Redis 连接串 | 空 | 例如 `redis://127.0.0.1:6379/0`；有密码用 `redis://:密码@host:6379/0` |
| `EAB_REDIS_PREFIX` | key 前缀 | `eab:` | 与服务器上其它应用隔离，避免 key 冲突 |
| `EAB_POSTGRES` | `auto` / `off` / `mirror` | `auto` | `auto` 且配置了 `EAB_POSTGRES_URL` 时启用审计镜像 |
| `EAB_POSTGRES_URL` | PostgreSQL 连接串 | 空 | 例如 `postgres://eab:密码@127.0.0.1:5432/eab` |
| `EAB_AUDIT_READ` | `sqlite` / `postgres` / `auto` | `sqlite` | 审计列表/导出读哪里；`postgres` 失败时自动回退 SQLite，哈希链校验始终读 SQLite |
| `EAB_CHAT_READ` | `sqlite` / `postgres` / `auto` | `sqlite` | 会话列表读哪里；PG 会话镜像未追平或失败时自动回退 SQLite |
| `EAB_BACKENDS_STRICT` | `1` / `0` | `0` | `1` 时显式要求的外部后端连不上直接启动失败 |

非法枚举值会在启动时报人话错误，而不是猜一个默认值：

```text
环境变量 EAB_CACHE 只能是 auto / memory / redis / off，当前是 xxxx
```

### 3.1 默认：什么都不配

```powershell
eab start
```

启动日志会出现：

```text
[eab:backends] 后端组合：SQLite 主库=ready，内存缓存=ready，PostgreSQL 外部存储=disabled
```

`GET /api/health` 返回：

```json
{
  "backends": [
    { "id": "sqlite", "state": "ready" },
    { "id": "memory", "state": "ready" },
    { "id": "postgres-audit", "state": "disabled" }
  ]
}
```

### 3.2 只接 Redis

```powershell
$env:EAB_CACHE = "redis"
$env:EAB_REDIS_URL = "redis://127.0.0.1:6379/0"
$env:EAB_REDIS_PREFIX = "eab:"
node scripts/eab.mjs server
```

成功时缓存状态是 `redis=ready`；Redis 断开或命令失败时变为 `degraded`，业务继续用内存缓存。启动阶段就连不上时，`backends` 里会同时出现 `memory=ready` 和 `redis=failed`，detail 写明“未接入，已回退内存缓存”，不会把失败藏起来。

### 3.3 只接 PostgreSQL

```powershell
$env:EAB_POSTGRES = "mirror"
$env:EAB_POSTGRES_URL = "postgres://eab:密码@127.0.0.1:5432/eab"
node scripts/eab.mjs server
```

成功时多两条 `postgres-audit=ready` 和 `postgres-chat=ready`，失败默认只显示一个 `postgres-audit=failed`（审计与会话镜像都跳过），SQLite 主审计照常写。

### 3.4 两个都接

同时设置上面的变量即可，互不依赖。也可以让 `EAB_CACHE` / `EAB_POSTGRES` 保持默认 `auto`，只配 URL：

```powershell
$env:EAB_REDIS_URL = "redis://127.0.0.1:6379/0"
$env:EAB_POSTGRES_URL = "postgres://eab:密码@127.0.0.1:5432/eab"
node scripts/eab.mjs server
```

### 3.5 审计读取切到 PostgreSQL

先按 3.3 接上 PG 审计镜像，再设置：

```powershell
$env:EAB_AUDIT_READ = "postgres"
node scripts/eab.mjs server
```

控制台「审计」页的列表和 CSV/JSON 导出会读 `eab_audit_mirror`，标题旁显示“数据源 PostgreSQL”。如果 PG 查询失败或镜像没接上，接口自动回退 SQLite，并在同一行显示回退原因，不会让审计页打不开。

`EAB_AUDIT_READ=auto` 表示“PG 可用就读 PG，否则读 SQLite”。默认 `sqlite`，所以不配 PG 的部署行为完全不变。

**首次接入会自动回填历史**：`PostgresAuditMirror` 启动时以 PG 当前最大 `seq` 为起点，把 SQLite 里更晚的审计分批写入 `eab_audit_mirror`。首次接入时 PG 为空，等价于全量补齐，不会出现“刚切到 PG 审计页却是 0 条”。之后每次启动只补新增部分。

**哈希链校验始终读 SQLite**：`eab_audit_mirror` 是异步批量镜像，可能落后主库，不能作为链完整性判据。

### 3.6 会话列表切到 PostgreSQL

先按 3.3 接上 PG，再设置：

```powershell
$env:EAB_CHAT_READ = "postgres"
node scripts/eab.mjs server
```

员工端 `GET /api/chat/sessions` 会读 `eab_chat_sessions_mirror`，响应里带 `source=postgres`。以下两种情况自动回退 SQLite，并在响应 `fallbackReason` 里写明原因：

- outbox 里还有会话变化没同步到 PG（例如刚新建会话）——本次直接读 SQLite，避免列表少一条；
- PG 查询失败或镜像没接上。

`EAB_CHAT_READ=auto` 表示“PG 会话镜像可用就读 PG，否则读 SQLite”。默认 `sqlite`，所以不配 PG 的部署行为完全不变。

**会话镜像只镜像 `chat_sessions` 元数据，不镜像消息正文**；未读红点用会话上的 `last_assistant_at` 与 `last_read_at` 比较得出，避免把整张 `chat_messages` 搬到 PG。

### 3.7 strict 模式

生产探针希望“配置了就必须连上”时：

```powershell
$env:EAB_CACHE = "redis"
$env:EAB_REDIS_URL = "redis://127.0.0.1:6379/0"
$env:EAB_BACKENDS_STRICT = "1"
node scripts/eab.mjs server
```

连不上会直接退出并打印原因，不会进入半启动状态。**默认不要开 strict**，否则 Redis 抖动会变成整个 EAB 启动失败。

## 4. PostgreSQL：当前为什么还不是主库

EAB 现有服务端有 34 个文件直接使用 `node:sqlite` 的同步 `db.prepare()`，`Db` 类型也是 SQLite 具体类型。换 PostgreSQL 主库不是改连接串，而是：

1. 把 `Db` 抽象成异步 repository；
2. 改掉 31 处 SQLite 方言（`INSERT OR IGNORE`、`strftime`、`json_extract`、`changes()` 等）；
3. 重新验证事务、并发写、迁移和回滚。

这属于第二阶段的大改造，不能和“默认部署仍要开箱可用”同时仓促上线。因此当前阶段：

- SQLite 继续负责事务、读取和哈希链审计的权威写入；
- PostgreSQL 以 `eab_audit_mirror` 表承接 append-only 审计副本，适合归档、分析、外部审计查询；
- 审计列表/导出可以通过 `EAB_AUDIT_READ=postgres|auto` 读 PG 镜像，这是第一个跑通的“读写分离仓储切片”；
- 会话列表可以通过 `EAB_CHAT_READ=postgres|auto` 读 PG 会话镜像，这是第二个跑通的仓储切片；会话写入仍走 SQLite，由 outbox 触发器异步补写 PG；
- 其余业务表仍全部走 SQLite，按消息、插件、配额逐域迁移，不一次性切主库。
- 以后全量主库迁移可以复用同一套 `BackendRuntime` 边界。

### 4.1 审计镜像的写入模型

| 参数 | 默认 | 作用 |
|---|---|---|
| `batchSize` | 100 | 每批最多 100 条，一条 `INSERT ... VALUES (...),(...)` |
| `flushIntervalMs` | 500 | 不足一批时最多等 500ms 再刷 |
| `maxQueue` | 20,000 | 队列上限；满了丢最老镜像并计数 |
| 连接池 | 2 | 池小，避免审计旁路抢主业务连接 |
| 查询超时 | 3000ms | 单批查询超时即失败并记录，避免关闭服务时被挂住的 PG 连接拖死 |

关键行为：

- `append()` 只入队，不等待 PG；SQLite 主审计已经提交，镜像不会反向阻塞用户请求；
- 启动时自动回填 SQLite 历史审计：首次接入等价全量补齐，之后按 PG 最大 `seq` 增量补齐；
- 批量写失败只累加 `failedBatches` / `lastError`，不无限重试、不制造重复写；
- 队列满时丢最老镜像，保证内存不无界增长；
- 关闭服务时先等正在进行的 flush，再刷剩余队列，最后关闭连接池。

### 4.2 PostgreSQL 写入量大会不会有影响

会有影响，但影响点不是“EAB 一条回复写一行”。需要关注的是：

1. **WAL 与同步提交**：每个事务都要落 WAL，批量小、提交频繁时压力最大；审计镜像已经按批提交。
2. **热点行更新**：会话元数据、用量计数这类同一行高频更新会放大锁等待和膨胀。
3. **大 JSON 更新**：`detail_json` 这类大字段反复整行更新会产生写放大；审计是 append-only，相对友好。
4. **表 / 索引膨胀**：长期 append 需要保留策略或分区，否则查询和 vacuum 变慢。

EAB 当前量级（单公司、几十个活跃员工）不会因为聊天消息把 PG 写垮。真正需要治理的是审计、用量、插件日志、会话元数据的高频写。接入 PG 后建议：

- 给 EAB 独立 database 和独立账号，不与现有业务共用表；
- 审计表按 `created_at` 做保留/归档策略；
- 监控 `pg_stat_activity`、锁等待、WAL 生成速率和表膨胀；
- 不要把聊天消息主存储迁到 Redis。

### 4.3 会话镜像的写入模型

会话写入没有在 24 处业务 SQL 里逐个改成异步，而是用 SQLite 内部的 outbox：

1. 迁移 `0046_chat_session_mirror.sql` 给 `chat_sessions` 增加 `last_assistant_at`；
2. 建 `eab_pg_outbox`，用 `AFTER INSERT/UPDATE/DELETE` 触发器把会话变化写入同一事务；
3. 助手消息插入时只更新当前会话的 `last_assistant_at`，不复制消息正文；
4. `PostgresChatMirror` 每 250ms 读一批 outbox，按 id 取当前会话行，批量 upsert 到 `eab_chat_sessions_mirror`，成功后删除 outbox；
5. PG 每次接入先全量刷新一次现有会话，再追平 outbox，避免离线期间漏写。

关键边界：

- outbox 与主事务同生共死：会话写入回滚，outbox 也回滚，不会产生幽灵镜像；
- PG 失败只累加 `failedFlushes` 并保留 outbox，下一轮续传，不影响员工建会话/发消息；
- 会话列表读 PG 前检查 outbox 是否清零；没清零就本次读 SQLite，避免刚建会话看不到；
- `eab_pg_outbox` 的唯一索引让同一会话只保留一条变化，不会随消息条数无限增长。

### 4.4 建表

服务启动时会自动执行：

```sql
CREATE TABLE IF NOT EXISTS eab_audit_mirror (
  id text PRIMARY KEY,
  seq bigint NOT NULL,
  company_id text NOT NULL,
  actor_user_id text,
  action text NOT NULL,
  resource_type text,
  resource_id text,
  resource_scope text,
  result text NOT NULL,
  detail_json jsonb,
  trace_id text,
  ip text,
  channel text,
  prev_hash text NOT NULL,
  hash text NOT NULL,
  created_at bigint NOT NULL,
  mirrored_at timestamptz NOT NULL DEFAULT now()
);
```

```sql
CREATE TABLE IF NOT EXISTS eab_chat_sessions_mirror (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  user_id text NOT NULL,
  title text NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  last_message_at bigint,
  deleted_at bigint,
  source text,
  external_id text,
  space_kind text,
  space_id text,
  model_id text,
  reasoning_effort text,
  open_conversation_id text,
  last_read_at bigint,
  last_assistant_at bigint,
  mirrored_at timestamptz NOT NULL DEFAULT now()
);
```

账号至少需要这两张表的 `CREATE TABLE`、`INSERT`、`UPDATE`、`DELETE` 权限；`eab_pg_outbox` 在 SQLite 内，不需要 PG 权限。

## 5. Redis：现在接了什么，没接什么

### 5.1 已接入

- **钉钉 accessToken 共享缓存**：key 前缀 `dingtalk:access-token:`。多实例部署时，一个实例刷新后其它实例可以直接复用，减少重复调用钉钉接口。
- 通用 `CacheBackend`：`get / set / del / incr`，支持 TTL 和计数器，业务可以按需复用。

### 5.2 缓存策略

`HybridCache` 的行为：

- `set` 先写内存、再写 Redis；Redis 失败只记降级，不抛给业务；
- `get` 先读 Redis，失败或未命中再读内存；
- `incr` Redis 失败时落内存计数；
- 状态在 Redis 有失败时显示 `degraded`，detail 写明“Redis 降级，内存兜底生效”；
- Redis 客户端关闭 offline queue：连接断开后命令立即失败并落回内存，不会排队拖住业务请求。

### 5.3 尚未接入

当前**没有**把以下进程内状态迁到 Redis：

- 聊天并发容量与排队；
- 分布式锁 / 工具资源锁；
- 控制台登录会话；
- 跨实例限流；
- 跨实例事件推送。

这些是多实例协调能力，不能只靠“加一个 Redis”完成，需要单独设计原子性、租约、失效和回滚。单实例部署暂时不需要；多实例上线前再按优先级接。

### 5.4 不要把聊天消息主存储放 Redis

Redis 适合缓存、计数、短期会话和锁，不适合作为聊天消息的权威存储。消息仍应写 SQLite / 未来的 PostgreSQL 主库。

## 6. 部署步骤

### 6.1 不安装外部服务（推荐默认）

```powershell
cd D:\AI kaifa\EAB
pnpm install
node scripts/eab.mjs server
```

不需要任何 `EAB_CACHE` / `EAB_POSTGRES` 变量。控制台「系统 → 数据与运维 → 平台与运维」会显示：

- SQLite 主库：可用
- 内存缓存：可用
- PostgreSQL 外部存储：未启用

### 6.2 安装客户端依赖

`pg` / `redis` 已写入 `packages/server/package.json` 的 `optionalDependencies`，`pnpm install` 默认会装上。即使装不上，代码也是动态 import：没配外部服务时完全不加载；配了但包缺失时只降级，不会让默认部署启动失败。

### 6.3 准备 PostgreSQL

```sql
CREATE ROLE eab LOGIN PASSWORD '替换成强密码';
CREATE DATABASE eab OWNER eab;
```

连接串：

```text
postgres://eab:替换成强密码@127.0.0.1:5432/eab
```

生产建议加 `sslmode=require`（按服务器实际配置）。

### 6.4 准备 Redis

```text
redis://127.0.0.1:6379/0
```

有密码：

```text
redis://:替换成强密码@127.0.0.1:6379/0
```

建议给 EAB 单独 DB 或独立实例，并设置 `maxmemory-policy allkeys-lru` 之外的合理淘汰策略；EAB 的 key 都带 `eab:` 前缀。

### 6.5 验证

```powershell
Invoke-RestMethod http://127.0.0.1:8788/api/health | ConvertTo-Json -Depth 8
```

登录控制台后：

```powershell
Invoke-RestMethod http://127.0.0.1:8788/api/console/backends -Headers @{ Cookie = "..." } | ConvertTo-Json -Depth 8
```

控制台页面：系统 → 数据与运维 → 平台与运维 → 后端状态。

### 6.6 本次实测结果

| 场景 | 启动 | `/api/health` 的后端状态 |
|---|---|---|
| 默认部署（真实库已应用 0046） | 正常监听 8787/8788 | sqlite=ready、memory=ready、postgres-audit=disabled；`/api/chat/sessions` 返回 `source=sqlite` |
| Redis + PostgreSQL 都配但不可达 | 正常监听，降级运行 | sqlite=ready、memory=ready、redis=failed、postgres-audit=failed |
| 只配 PostgreSQL 且不可达 | 正常监听 | sqlite=ready、memory=ready、postgres-audit=failed |
| 只配 Redis 且不可达 | 正常监听 | sqlite=ready、memory=ready、redis=failed、postgres-audit=disabled |
| strict=1 + 外部服务不可达 | 退出码 1 | 输出“可选后端启动失败：…；这是 EAB_BACKENDS_STRICT=1 的预期行为” |
| 真实 PostgreSQL 18.7 成功路径（独立测试实例 8797/8798，strict=1） | 正常监听 | sqlite=ready、memory=ready、postgres-audit=ready、postgres-chat=ready；`auditRead=postgres`、`chatRead=postgres`；审计 240 条 `source=postgres`；会话 `source=postgres`、2 条 |

启动日志会打印组合摘要，例如：

```text
[eab:backends] 后端组合：SQLite 主库=ready，内存缓存=ready，Redis=failed，PostgreSQL 外部存储=failed
```

浏览器实测：

- 默认部署：控制台显示 SQLite 主库“可用”、内存缓存“可用”、PostgreSQL 外部存储“未启用”。
- 两个外部后端都不可达：控制台显示 Redis“失败”、PostgreSQL 外部存储“失败”，detail 分别写明回退内存和跳过审计/会话镜像。
- 真实 PostgreSQL 成功路径：控制台审计页显示“240 条 · 数据源 PostgreSQL”；后端状态里 PostgreSQL 外部存储“可用”，会话镜像同时 ready。
- 状态胶囊颜色只作辅助，文字本身能独立表达状态。

真实库迁移与接口：

- 0046 已应用到 `.eab-dev/eab.db`，`chat_sessions` 有 `last_assistant_at`，4 个 `trg_chat_*` 触发器存在，`eab_pg_outbox` 已入队 16 个现有会话；16 个会话中 4 个有助手消息并完成 `last_assistant_at` 回填。
- 控制台 `/api/console/backends` 的 config 返回 `chatRead=sqlite`。
- 员工端 `/api/chat/sessions` 通过真实路由返回 200、`source=sqlite`、2 条会话、无 `fallbackReason`。
- 设 `EAB_CHAT_READ=postgres` 但不接 PG 时，同一路由返回 200、`source=sqlite`，`fallbackReason=PostgreSQL 会话镜像未接入，已使用 SQLite`。

真实 PostgreSQL 成功路径（2026-11-13）：

- 连接的是远程 PostgreSQL 18.7，目标库初始为空；测试实例使用真实库副本 `.eab-dev/pg-test/eab.db`，监听 8797/8798，`strict=1`，审计/会话读都设为 `postgres`。
- 启动后后端状态四个都是 ready：`sqlite=ready`、`memory=ready`、`postgres-audit=ready`、`postgres-chat=ready`。
- 审计历史回填 240 条；远程 `eab_audit_mirror=240`、`eab_chat_sessions_mirror=16`，均建在 `public`。
- `/api/console/audit?limit=5` 返回 `total=240`、`source=postgres`、无 `fallbackReason`；控制台审计页实测显示“240 条 · 数据源 PostgreSQL”。
- 员工端 `/api/chat/sessions?as=…` 返回 `source=postgres`、2 条会话，无 `fallbackReason`。
- 主服务仍保持默认组合（`postgres=auto`、`auditRead=sqlite`、`chatRead=sqlite`），没有因为本次验收被切到远程 PG。
- 本次按给定连接直接使用了 `postgres` 库的 `public` schema；生产部署仍建议按 4.2 使用独立 database 和独立账号，避免与其它系统共用默认库。

主服务正式切换（本机，2026-11-13）：

- 主服务 8787/8788 以 `EAB_POSTGRES=mirror`、`EAB_AUDIT_READ=postgres`、`EAB_CHAT_READ=postgres` 重启；`strict` 仍为默认 `false`，远端 PG 故障时自动回退 SQLite。
- `/api/console/backends`：`sqlite=ready`、`memory=ready`、`postgres-audit=ready`、`postgres-chat=ready`；config 为 `{"cache":"auto","postgres":"mirror","auditRead":"postgres","chatRead":"postgres","strict":false}`。
- 启动后审计从 240 条增长到 242 条，新增的 `chat.message` 已实时镜像并被审计页读到，`source=postgres`、无 `fallbackReason`；说明历史回填和启动后的增量同步同时生效。
- PG 镜像行数随之为 `eab_audit_mirror=242`、`eab_chat_sessions_mirror=16`。

双路径复验：

- SQLite-only 隔离实例使用同一份真实库副本，设置 `EAB_POSTGRES=off`、`EAB_AUDIT_READ=sqlite`、`EAB_CHAT_READ=sqlite`，不连接任何外部服务。
- 该实例 `sqlite=ready`、`memory=ready`、`postgres-audit=disabled`；审计 240 条 `source=sqlite`；员工端 `/api/chat/sessions` 返回 `source=sqlite`、2 条会话。
- 因此默认无外部依赖路径与 PostgreSQL 增强路径都已真实验证；切换只需改环境变量并重启，失败自动回退 SQLite。

回归结果：`pnpm typecheck` 通过；`pnpm test` 77 个测试文件 / 393 个测试全部通过；`app.js` / `chat.js` 语法检查通过。

## 7. 排障

| 现象 | 检查 |
|---|---|
| `backends` 里只有 sqlite/memory | 没配 URL，或 `EAB_CACHE=memory/off`、`EAB_POSTGRES=off` |
| `redis=degraded` | Redis 地址、密码、DB、防火墙；detail 有最近错误 |
| `postgres-audit=disabled` | 连接串、账号权限、`pg_hba.conf`、数据库是否存在 |
| strict 启动失败 | 这是预期；确认外部服务可用，或去掉 `EAB_BACKENDS_STRICT=1` |
| 审计镜像有 `failedBatches` | PG 写入失败；看 detail 的最近错误，修好后新记录会继续写，旧批次不重放 |
| 审计镜像 `dropped > 0` | 队列满，PG 写入长期跟不上；检查 PG 压力或保留策略 |

状态接口只返回能力、健康、计数，不回显连接串、账号或密码。
