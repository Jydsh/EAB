# 控制台数据库连接与只读查询

> 状态：2026-11-13 已落地连接注册、真实连通性探测和只读查询；单测、真实 SQLite / PostgreSQL 接口与浏览器页面已验收。
> 页面入口：控制台「连接与平台 → 数据库」；API 只在管理面注册，按当前公司隔离。
> 相关代码：`packages/server/src/database-drivers.ts`、`database-connections.ts`、`database-query.ts`、
> `routes/console-databases.ts`、`packages/server/public/app.js` / `app.css`、
> 迁移 `0047_database_connections.sql`。

## 1. 它是什么，不是什么

这一页解决的是“管理后台没有地方配置 PostgreSQL 等外部数据库连接”的问题：管理员可以在控制台登记连接、保存凭据引用、真实测试连通性，并对已启用的 PostgreSQL / MySQL / SQLite 连接执行只读查询。

| 能力 | 当前已实现 | 说明 |
|---|---|---|
| 连接注册表 | 是 | 名称、驱动、地址/库、账号、SSL、启用状态，按公司隔离 |
| 真实连通性测试 | 是 | 请求时动态加载驱动，真正建立连接并执行最小探针 |
| 密码不落明文 | 是 | 密码只写 `secrets.json`，数据库只存 `secret_ref`；接口只返回 `passwordConfigured` |
| 状态筛选与最近结果 | 是 | 全部 / 可用 / 失败 / 未检测；失败原因、检测时间、延迟可见 |
| 未保存草稿测试 | 是 | 新增弹窗里可以先测再保存；草稿测试不写列表状态 |
| SQL 只读查询 | 是（PostgreSQL / MySQL / SQLite） | 单条只读 SQL，只读事务，最多返回 100 行 |
| Redis 命令控制台 | **否** | 只做 `PING` 连通性测试，不开放任意命令 |
| 接入智能体工具 / 切换 EAB 审计或会话后端 | **否** | 连接注册表是独立配置数据，不改运行时后端选择 |
| MySQL / MariaDB、Redis 真实服务验收 | **部分** | 驱动已加载，本机没有对应服务，只验证到“连接被拒绝”的失败路径 |

## 2. 页面行为

左侧二级导航位于「连接与平台」下，顺序为：渠道 → **数据库** → 公司资料 → 系统。

页面由四块组成：

1. **标题与计数**：`数据库 N`，右侧是状态胶囊（全部 / 可用 / 失败 / 未检测）。
2. **驱动条**：PostgreSQL `:5432`、MySQL / MariaDB `:3306`、SQLite `文件路径`、Redis `:6379`，并提示“测试失败只记录原因，不影响其它连接”。
3. **连接表格**：连接（名称 + 驱动徽标 + 启停）、地址 / 库、传输（SSL）、状态与最近错误、最近检测（时间 + 延迟）、操作（查询 / 测试 / 编辑 / 删除）。Redis 行不显示「查询」。
4. **空状态**：没有连接时显示“还没有数据库连接。添加 PostgreSQL、MySQL / MariaDB、SQLite 或 Redis 后，可在这里测试连通性。”

新增 / 编辑弹窗的字段随驱动切换：

- **PostgreSQL / MySQL / MariaDB**：名称、类型、主机、端口、数据库名、用户名、密码、SSL、启用。
- **SQLite**：名称、类型、文件路径、启用；文件路径必须是服务器上的绝对路径，探测只读打开，不会创建新文件。
- **Redis**：名称、类型、主机、端口、DB 编号（0~15）、用户名（可选）、密码、启用；不显示 SSL。
- 编辑时密码留空表示“不修改”；新增时密码可留空（例如无密码 Redis）。弹窗内“测试连接”只测草稿，不写列表状态；“保存”才创建或 PATCH。
- 删除使用站内确认卡二次确认；删除连接时会同时删除对应的 secret。

### 只读查询弹窗

行内「查询」只对 PostgreSQL、MySQL / MariaDB、SQLite 显示；Redis 不显示，避免把配置页变成任意命令入口。

- 弹窗顶部显示连接名称、驱动徽标、地址和「只读」标识；
- 默认 SQL 按驱动给出：PostgreSQL / MySQL 查当前库、当前用户和版本；SQLite 列出 `sqlite_master` 里的表 / 视图；
- 只允许单条 `SELECT / WITH / EXPLAIN / SHOW / DESCRIBE / PRAGMA / VALUES / TABLE`（SQLite 只允许 `SELECT / WITH / EXPLAIN / PRAGMA / VALUES`）；
- 含分号的多语句、`DELETE / UPDATE / INSERT` 等写操作、`INTO OUTFILE / DUMPFILE`、`FOR UPDATE`、`LOCK IN SHARE MODE`、`SELECT ... INTO` 在进入驱动前直接拒绝；
- SQLite 的 `PRAGMA ... = ...` 写设置也被拒绝；查询本身以 `readOnly: true` 打开；
- PostgreSQL / MySQL 使用 READ ONLY 事务；PostgreSQL 额外设置 `statement_timeout = 6000`；
- 结果最多返回 100 行；超过时显示“结果超过 100 行，仅显示前 100 行”；查询成功或失败都不写回连接测试状态，列表状态仍以最近一次「测试」为准；
- 支持 `Ctrl / Cmd + Enter` 执行；关闭弹窗恢复页面。

## 3. 数据模型与安全边界

迁移：`packages/storage/migrations/0047_database_connections.sql`。

```sql
database_connections(
  id, company_id, name, kind, host, port, database_name, username,
  file_path, ssl, secret_ref, enabled,
  status, status_detail, last_error, last_tested_at, latency_ms,
  created_at, updated_at
)
```

约束与规则：

- `kind` 只能是 `postgres | mysql | sqlite | redis`；
- `status` 只能是 `untested | ok | error`，新建默认 `untested`；
- 同公司连接名唯一（`company_id, name`）；
- 索引：`company_id + updated_at`、`company_id + status + updated_at`；
- 密码：通过 `secrets.ts` 写入同目录 `secrets.json`，引用名前缀 `EAB_DATABASE_PASSWORD`；数据库只保存引用名，列表/详情接口只返回 `passwordConfigured: true|false`，不回显密码或引用名；
- 修改连接配置或密码会把状态重置为 `untested` 并清空上次错误/延迟；只改名称或启用状态则保留上次测试结果；
- 删除连接会删除数据库行，并在之后删除对应 secret；
- 所有创建、更新、删除、测试、查询写 `appendAudit`，资源类型 `database_connection`，测试/查询失败写 `result: 'failure'`；查询审计记录 SQL 预览（最多 200 字符）、行数、截断、耗时和错误，不记录密码。

## 4. 驱动与探针

驱动按需动态加载；默认部署没有安装某个驱动时，只影响对应连接的测试，不影响控制台启动。

| 类型 | 依赖 | 探针 | 超时 |
|---|---|---|---|
| PostgreSQL | `pg`（可选依赖） | `SELECT version(), current_database()` | 连接 5s / 外层 6.5s |
| MySQL / MariaDB | `mysql2`（本轮新增可选依赖） | `SELECT VERSION(), DATABASE()` | 连接 5s / 外层 6.5s |
| SQLite | Node 内置 `node:sqlite` | 只读打开文件，`SELECT sqlite_version()` | 立即失败或返回 |
| Redis | `redis`（可选依赖） | `PING` | 连接 5s / 外层 6.5s |

失败处理：

- 错误信息会脱敏密码（把密码替换成 `[密码已隐藏]`），压缩空白并截断到 400 字符；
- Redis 客户端显式关闭无限重连（`reconnectStrategy: false`），连接未成功时 `disconnect()`，避免点击“测试”后请求挂起；
- SQLite 文件不存在、路径为空会直接返回可读错误，不创建新文件。

### 查询执行

| 类型 | 只读方式 | 上限 |
|---|---|---|
| PostgreSQL | `BEGIN READ ONLY` + `SET LOCAL statement_timeout = 6000` | 连接 5s / 查询外层 7s，最多 100 行 |
| MySQL / MariaDB | `START TRANSACTION READ ONLY` | 连接 5s / 查询外层 7s，最多 100 行 |
| SQLite | `DatabaseSync(..., { readOnly: true })` | 立即失败或返回，最多 100 行 |
| Redis | 不执行 SQL / 命令 | 返回“Redis 暂不开放查询控制台” |

查询结果包含 `columns / rows / rowCount / truncated / durationMs / error`；日期转 ISO 字符串、BigInt 转字符串、二进制转为 `<binary N bytes>`，避免 JSON 序列化失败。

## 5. API

均只注册在管理面，需要控制台 cookie 且携带 `x-eab-console: 1`；缺任一项返回 401。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/console/databases?status=all\|ok\|error\|untested` | 列表 + `items / counts / total / status / drivers` |
| POST | `/api/console/databases` | 创建连接 |
| PATCH | `/api/console/databases/:id` | 更新连接 |
| DELETE | `/api/console/databases/:id` | 删除连接 |
| POST | `/api/console/databases/test` | 测试未保存草稿；可带 `id` 复用已保存地址与密码 |
| POST | `/api/console/databases/:id/test` | 测试已保存连接并写回状态 |
| POST | `/api/console/databases/:id/query` | 对已启用连接执行单条只读查询；body `{ "sql": "..." }`；写 `database.query` 审计 |

返回的连接视图字段：`id / name / kind / kindLabel / host / port / database / username / filePath / ssl / enabled / status / statusDetail / lastError / lastTestedAt / latencyMs / passwordConfigured / target / createdAt / updatedAt`。

注意：DELETE 不要强制发送空的 `Content-Type: application/json` body；前端 `apiSend('DELETE', ..., undefined)` 不设置 content-type，走正常路径。

## 6. 实际验收记录（2026-11-13）

### 真实接口（测试实例 8797 / 8798，连接验收）

- SQLite：`ok=true`，`SQLite 3.51.3 · eab.db`，84ms；
- PostgreSQL（真实服务 `192.168.1.4:5432`）：`ok=true`，`PostgreSQL 18.7 (Debian 18.7-1.pgdg13+2) ... · 数据库 postgres`，887ms；凭据从进程环境读取，未写入仓库、未回显；
- MySQL：驱动已加载，本机 3306 无服务，返回 `connect ECONNREFUSED 127.0.0.1:3306`；
- Redis：本机未运行，修复重连后约 1261ms 返回 `connect ECONNREFUSED 127.0.0.1:6379`，请求不再挂起。

### 查询验收（独立实例 8799 / 8800，测试库）

- SQLite 查询 `SELECT name, type FROM sqlite_master ...`：`ok=true`，58 行，6~82ms，列 `name,type`，第一行 `_migrations/table`；
- 写语句 `DELETE FROM demo`：`ok=false`，返回“只允许执行单条只读查询”；未执行到驱动；
- 多语句 `SELECT 1; SELECT 2`：`ok=false`，返回“一次只能执行一条 SQL”；
- 空 SQL：`ok=false`，返回“SQL 不能为空”；
- 审计：`database.query` 记录成功与失败，包含 SQL 预览、行数、耗时和错误，不包含密码；
- PostgreSQL 查询 `SELECT current_database() AS database, current_user, version()`：网络恢复后 `ok=true`，1 行，156ms，返回 `PostgreSQL 18.7 ...`；此前同一连接曾因 `192.168.1.4:5432` 不可达返回 `timeout expired`，`/test` 同时失败，恢复后查询与探测均正常。
- 截断查询（SQLite 递归 CTE 返回 150 行）：`ok=true`，`rowCount=100`，`truncated=true`。
- 主服务 8788 已重启加载查询路由：`/api/health` 四个后端 `sqlite / memory / postgres-audit / postgres-chat` 均为 `ready`；带控制台鉴权访问不存在的连接返回 `EAB_NOT_FOUND`，说明新路由已注册而不是 404 路由缺失。
- 主服务现有 `PostgreSQL` 连接（`192.168.1.4:5432 · postgres`，状态 `可用`，36ms）上执行 `SELECT current_database() ...`：`ok=true`，1 行，52ms，返回 `PostgreSQL 18.7 ...`；主服务审计可读到 `database.query success`。

### 浏览器页面（无头 Chrome，1440×1000）

- 页面标题「数据库」，侧边栏顺序「渠道 / 数据库 / 公司资料 / 系统」；
- 列表 3 条：SQLite `可用`、PostgreSQL `可用`、Redis `连接失败`；计数 `全部 3 / 可用 2 / 失败 1 / 未检测 0`；
- 「失败」筛选只显示 Redis 一条；
- 打开「新增连接」→ 切到 SQLite → 文件路径显示、主机/端口/库名/账号/密码/SSL 隐藏 → 点击「测试连接」显示 `连接成功 · SQLite 3.51.3 · eab.db · 26 ms` → 保存后列表变为 4 条 → 删除确认卡 → 列表恢复 3 条；
- 行内「查询」→ SQLite 弹窗显示只读标识和默认 SQL → 执行后显示 `查询完成 · 58 行 · 82 ms`，结果表 58 行 → 改为 `DELETE FROM demo` 后显示“只允许执行单条只读查询” → 关闭弹窗；
- 主服务 8788 数据库页显示 1 条 `PostgreSQL` 连接（`可用`，36ms）；主库已应用 `0047_database_connections.sql`，`database_connections` 表存在。

截图产物：

- `.eab-dev/tmp/database-list.png`
- `.eab-dev/tmp/database-filter-error.png`
- `.eab-dev/tmp/database-modal-test.png`
- `.eab-dev/tmp/database-list-final.png`
- `.eab-dev/tmp/database-list-query.png`
- `.eab-dev/tmp/database-query-modal.png`
- `.eab-dev/tmp/database-query-result.png`
- `.eab-dev/tmp/database-query-rejected.png`

### 自动化与静态检查

- `pnpm test -- database-connections`：5/5 通过（SQLite 真实测试、创建/更新/删除、密码 secret 保留与轮换、名称/类型/端口校验、公司隔离、草稿测试不写状态、只读查询与行数截断/写拒绝/多语句拒绝）；
- `pnpm typecheck`：通过；
- `node --check packages/server/public/app.js`：通过；
- 准入：无 cookie 带 `x-eab-console: 1` → 401；有 cookie 不带 header → 401；两者齐全 → 200。

## 7. 已知限制

1. 只读查询只覆盖 PostgreSQL、MySQL / MariaDB、SQLite；Redis 不开放任意命令。连接仍不会被智能体工具自动使用，也没有切换 EAB 审计/会话后端。
2. MySQL / MariaDB、Redis 仅验证了驱动加载与连接拒绝路径；没有可用的真实服务做成功路径验收。PostgreSQL 连接探测和只读查询均已用真实服务验收。
3. SQLite 路径是服务器本地绝对路径；网络盘、权限与生产部署的可访问性未验证。
4. 密码轮换、公司隔离、状态重置、只读查询由单测覆盖；主要浏览器验收走的是测试实例，不包含真实生产公司的多租户交叉操作。
5. 版本号已随本次发布更新为 `2026.11.14`，并随发布提交推送。
6. SSL / TLS 目前只支持 PostgreSQL / MySQL 勾选启用，使用 `rejectUnauthorized: false`，即加密但不校验证书；未提供 CA、客户端证书，Redis TLS 也未在页面开放。
7. 查询弹窗已写窄屏媒体规则，但本轮只在 1440×1000 桌面视口完成截图验收；未单独复验手机宽度下的表格横向滚动与键盘遮挡。
