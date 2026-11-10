# 并发安全与多 Agent 开发计划

## 目标

让 EAB 在多人、多会话、多模型、多 Agent 同时调用工具时：

- 同一会话不并发冲突；
- 不同会话之间可以并行；
- 同一文件、同一任务、同一外部副作用不会被重复或互相覆盖；
- 出现故障时能观测、能重试、能取消；
- 不在当前单机 SQLite 部署上过早引入分布式复杂度。

## 现状判断

| 层 | 当前实现 | 结论 |
|---|---|---|
| 会话 | `net/routes/chat.ts` 的 `acquireTurn` 按 `sessionId` 加内存锁 | 同一会话串行；跨会话可并行；多进程不共享 |
| 工具 | `executeTool` 是一个大 switch，没有统一资源锁 | 工具自身是否并发安全取决于实现 |
| 数据库 | SQLite + WAL + `busy_timeout=5000`，单连接同步 API | 单进程写请求实际串行；多进程会竞争写锁 |
| 外部副作用 | 钉钉发送、文件改名/删除、定时任务创建等直接执行 | 没有统一幂等键，重复调用可能重复生效 |
| 插件 | 插件在 EAB 进程内执行，注册表是全局状态 | 插件阻塞或共享状态会影响所有 Agent |

## 开发原则

1. 先做单机并发安全，再考虑多机；当前不换 PostgreSQL。
2. 不引入“全局工具大锁”，只锁具体资源，避免所有 Agent 被串行化。
3. 每个阶段都要有可区分旧行为的测试，不能只看类型检查通过。
4. 数据库迁移、工具协议变更单独成阶段，不和 UI 改动混在一起。
5. 未经用户明确要求，不自动推送 GitHub。

## 优先级与阶段

### P0-1 并发原语与工具资源锁（已完成代码，待验收）

内容：

- 新增 `packages/server/src/concurrency.ts`：`KeyedMutex`，支持 FIFO、等待超时、`AbortSignal`。
- `ToolDef` 增加 `concurrency` 与 `lockKey`。
- `executeTool` 在鉴权后、执行前统一获取资源锁，执行完在 `finally` 释放。
- 已接入：云空间写入/发送/改名/删除、本地空间写/删/移动/建目录、定时任务创建/删除、成员密码重置。
- 会话取消信号透传到锁等待，用户停止后不再排长队。

验收：

- 同一 key 串行，不同 key 并行；
- 超时和取消会把等待者从队列摘除；
- `workspace.write` 在持有同一路径锁时确实等待；
- 原有测试和类型检查全部通过。

### P0-2 外部副作用幂等

新增 `tool_operations` 表：

```sql
id, company_id, user_id, tool_id,
idempotency_key, status, result_json,
created_at, expires_at
UNIQUE(company_id, user_id, tool_id, idempotency_key)
```

接入工具：`workspace.send_dingtalk`、`workspace.rename`、`workspace.delete`、`schedule.create`、`schedule.delete`、`admin.password.reset`。

验收：

- 同一幂等键重复调用 10 次，只产生一次实际副作用；
- 第一次执行中重复请求不会绕过；
- 失败状态可重试，成功状态直接返回首次结果。

### P0-3 审批并发去重

给 `approvals` 增加部分唯一索引：

```sql
UNIQUE(company_id, requester_user_id, action, resource_id)
WHERE status = 'pending'
```

插入冲突时读回已有 pending 记录。

验收：

- 10 个并发请求只生成 1 条 pending；
- 已审批、已过期记录不阻塞新建；
- 原有审批流程和审计不变。

### P0-4 单写进程与 SQLite 写保护

内容：

- 启动时增加数据库文件锁/PID 守护，禁止两个 EAB 服务同时写同一 SQLite 库。
- `withTransaction` 改 `BEGIN IMMEDIATE`，增加 `SQLITE_BUSY` 短重试。
- 事务内禁止 `await` 持有写锁。
- 明确桌面端、Web 端、CLI 只能共用一个服务进程。

验收：

- 第二个写进程启动被拒绝并给出明确提示；
- 并发写事务不再出现瞬时 `SQLITE_BUSY`；
- 进程崩溃后锁可恢复，不会永久占用。

### P0-5 并发限流与观测

内容：

- 全局、公司、模型、工具四级并发信号量。
- 插件工具超时和并发上限。
- 记录 active turn、等待队列、锁等待、工具耗时、`SQLITE_BUSY`、模型 429。
- 控制台增加“并发与队列”面板。

验收：

- 超限请求排队而不是直接 500；
- 能看到当前谁在占用资源、排队多长；
- 压测数据能判断是否真的需要 PostgreSQL。

### P1 多 Agent 运行时

新增 `agent_runs`、`agent_steps`：

- `parent_run_id`、`agent_id`、`model_id`、`session_id`、`status`、`budget`、`started_at`、`ended_at`。
- 子 Agent 使用独立 `runId` 和独立会话锁 key，不共享父会话 `sessionId`。
- 共享云空间文件仍走 P0-1 资源锁。
- 支持并行调度、取消、重试、运行树展示。

验收：

- 一个父任务可并行运行多个子 Agent；
- 任一子 Agent 失败不影响其他子 Agent；
- 取消父任务能级联取消子任务并释放锁；
- 前端能看到每个子 Agent 的工具轨迹和耗时。

### P2 多机扩展（条件触发）

只有满足以下任一条件才启动：

- 需要多台服务器同时写同一个库；
- 持续并发写导致 `SQLITE_BUSY` 频繁；
- 单库体积或备份恢复时间不可接受；
- 需要跨机水平扩容。

方案：

- PostgreSQL；
- Redis 分布式锁；
- 独立任务队列；
- 插件 worker 进程隔离。

## 推荐执行顺序

1. P0-1 验收并提交。
2. P0-2 幂等表 + 外部副作用。
3. P0-3 审批唯一约束。
4. P0-4 单写进程与写事务。
5. P0-5 限流与观测。
6. P1 多 Agent。
7. 根据压测结果决定是否进入 P2。

## 当前进度

- P0-1：代码已落地，`pnpm test` 40 个测试文件 / 258 条测试通过，`pnpm typecheck` 通过；尚未提交。
- P0-2：代码已落地，`pnpm test` 42 个测试文件 / 263 条测试通过，`pnpm typecheck` 通过；真实库 `.eab-dev/eab.db` 已应用 `0037_tool_operations.sql`，`tool_operations` 表已存在；尚未提交。
- P0-3：代码已落地，`pnpm test` 43 个测试文件 / 265 条测试通过；真实库已应用 `0038_approvals_pending_unique.sql`，`uq_approvals_pending_resource` 索引已存在；尚未提交。
- P0-4：代码已落地，`pnpm test` 44 个测试文件 / 267 条测试通过，`pnpm typecheck` 通过；真实服务重启后 `.eab-dev/eab-server.lock` 已由当前服务进程持有；尚未提交。
- P0-5：代码已落地，`pnpm test` 45 个测试文件 / 273 条测试通过，`pnpm typecheck` 通过。已新增 `KeyedSemaphore`、对话全局/公司/模型三级闸门、内置工具与插件工具并发上限和超时、`SQLITE_BUSY` 计数、`/metrics` 新指标、`GET /api/console/concurrency` 与控制台「并发与队列」面板；真实服务已重启，接口与指标实测返回正常，面板已在真实浏览器打开并验证刷新；尚未做真实压测；尚未提交。
- P1：代码已落地，`pnpm test` 48 个测试文件 / 278 条测试通过，`pnpm typecheck` 通过。已新增 `agent_runs` / `agent_steps` 迁移（真实库已应用 `0039_agent_runs.sql`）、`agent-runtime.ts`（运行树、父子取消、会话锁、步骤记录）、`agent.spawn` 工具（工具循环中真正分发并行子 Agent、支持独立模型与重试）、`GET /api/console/agent-runs`、`POST /api/console/agent-runs/:id/cancel`、`eab_agent_runs_active` 指标和控制台「Agent 运行树」面板。真实服务已重启，接口实测返回正常；面板已在真实浏览器验证父任务/子 Agent/工具步骤与耗时展示；尚未提交。
- 环境说明：本轮验收时发现 `.eab-dev/eab.db` 的 `companies/users` 为 0，已将当时的空库与 WAL 保留到 `.eab-dev/lost-empty-20261110-134848`，并从 `.eab-dev/eab.db.bak-20261109` 恢复（1 家公司 / 163 名成员 / 28 个部门 / 6 个模型），启动后重新应用了迁移。该备份早于 11 月 9 日 17:55，恢复后可能缺少此后的增量数据。
