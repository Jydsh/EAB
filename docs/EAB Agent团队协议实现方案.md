# EAB Agent 团队协议实现方案

> 状态：技术实现草案（2026-11-22）
> 关联需求：`docs/EAB Agent团队协议优化需求（MCP-A2A-ACP）.md`
> 目标：把需求落成可以分 PR 实施、可回滚的代码改造；不推倒现有父子团队。

## 一、实现边界

采用「一个内部核心，三个边缘适配」的设计；当前实施 MCP 与 A2A 两个适配面，ACP 只在架构图中保留为可选扩展，不实施。

```
        MCP Adapter（工具）      A2A Adapter（远端 Agent）      ACP Bridge（IDE）
                 \                    |                    /
                  └──────────── 协议适配层 ────────────┘
                                      │
                          Protocol-neutral Core
                TaskEnvelope / AgentCard / Artifact / Trace / Budget
                                      │
                         现有 agent_* 运行时与团队面板
```

其中 ACP Bridge 仅保留在架构图中作为可选扩展，本期不实施；当前实际交付为 MCP Adapter 与 A2A Adapter。

实现原则：

- **内部核心不出现 MCP/A2A/ACP 名字**。核心只认任务、能力、产物、追踪和预算。
- **协议只在边界翻译**。MCP 翻译成工具目录，A2A 翻译成任务信封；ACP 若未来启用，才翻译成会话与审批，本期不实现。
- **不修改 `agent_tasks.status` 的 CHECK 约束**。用旁路字段表达暂停原因，避免重建 SQLite 表导致旧查询和测试大面积回归。
- **第一版不做公网 Agent 市场，也不做 ACP 工位桥接**。当前交付按「内部契约 → MCP 只读 → A2A 出站/入站」推进；ACP 仅保留为后续可选扩展，不进入本期范围。

## 二、数据模型

新增迁移：`packages/storage/migrations/0084_agent_protocol.sql`

```sql
ALTER TABLE agent_tasks ADD COLUMN context_id TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_tasks ADD COLUMN trace_id TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_tasks ADD COLUMN phase TEXT NOT NULL DEFAULT 'none';
ALTER TABLE agent_tasks ADD COLUMN reject_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_tasks ADD COLUMN input_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE agent_tasks ADD COLUMN artifacts_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE agent_tasks ADD COLUMN budget_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE agent_tasks ADD COLUMN deadline_at INTEGER;
ALTER TABLE agent_tasks ADD COLUMN used_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_tasks ADD COLUMN used_cost_micros INTEGER NOT NULL DEFAULT 0;

ALTER TABLE agent_events ADD COLUMN context_id TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_events ADD COLUMN trace_id TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS agent_cards (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL,
  agent_key      TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('builtin', 'runtime', 'a2a')),
  name           TEXT NOT NULL,
  version        TEXT NOT NULL DEFAULT '1',
  description    TEXT NOT NULL DEFAULT '',
  skills_json    TEXT NOT NULL DEFAULT '[]',
  tools_json     TEXT NOT NULL DEFAULT '[]',
  limits_json    TEXT NOT NULL DEFAULT '{}',
  endpoint_json  TEXT NOT NULL DEFAULT '{}',
  health         TEXT NOT NULL DEFAULT 'healthy',
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE (company_id, agent_key)
);

CREATE INDEX IF NOT EXISTS idx_agent_cards_company
  ON agent_cards (company_id, enabled, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_artifacts (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  team_id        TEXT NOT NULL,
  task_id        TEXT NOT NULL,
  name           TEXT NOT NULL,
  mime_type      TEXT NOT NULL DEFAULT '',
  size           INTEGER NOT NULL DEFAULT 0,
  checksum       TEXT NOT NULL DEFAULT '',
  source         TEXT NOT NULL CHECK (source IN ('workspace', 'cloud', 'inline', 'mcp', 'a2a')),
  uri            TEXT NOT NULL DEFAULT '',
  preview        TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_artifacts_task
  ON agent_artifacts (team_id, task_id, created_at);
```

### 2.1 为什么用 `phase` 而不是改 `status`

现有 `0060_agent_team.sql` 把 `agent_tasks.status` 限制为：

```sql
CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled'))
```

SQLite 不能直接改 CHECK。为了加 `input_required / auth_required / rejected` 而重建表，会牵动所有查询、索引、测试和旧数据。第一版采用**正交状态**：

| 字段 | 取值 | 作用 |
|---|---|---|
| `status` | `queued / running / succeeded / failed / cancelled` | 原有生命周期，不改 |
| `phase` | `none / input_required / auth_required / rejected` | 暂停/拒绝原因，不参与原有判断 |
| `reject_reason` | 文本 | `phase=rejected` 时说明原因 |

对外协议状态由纯函数合成：

| 内部 status | 内部 phase | 对外状态 |
|---|---|---|
| `queued` | `none` | `submitted` |
| `running` | `none` | `working` |
| `queued/running` | `input_required` | `input-required` |
| `queued/running` | `auth_required` | `auth-required` |
| `succeeded` | `none` | `completed` |
| `failed` | `none` | `failed` |
| `failed` | `rejected` | `rejected` |
| `cancelled` | `none` | `canceled` |

这样旧代码继续只看 `status`，新 UI 和 A2A 适配器看 `phase`，互不破坏。

## 三、代码结构

### 3.1 新增文件

| 文件 | 职责 |
|---|---|
| `packages/server/src/agent-protocol.ts` | 任务信封、状态合成、Artifact 类型、Trace 类型、纯转换函数 |
| `packages/server/src/agent-capability-registry.ts` | 内置 Agent Card、运行时能力卡、选中评分、DB 覆盖 |
| `packages/server/src/agent-artifacts.ts` | Artifact 落库、文件校验、checksum、按任务查询 |
| `packages/server/src/mcp-client.ts` | JSON-RPC 2.0 客户端，stdio / HTTP / SSE 传输 |
| `packages/server/src/mcp-registry.ts` | MCP Server 登记、`tools/list` 同步、工具缓存、健康与熔断 |
| `packages/server/src/a2a-client.ts` | A2A 出站：Agent Card、建任务、查任务、取消 |
| `packages/server/src/routes/a2a.ts` | A2A 入站端点，后续阶段 |
| `packages/server/src/acp-bridge.ts` | IDE ACP 桥；当前范围不实施，不创建该文件 |

### 3.2 修改文件

| 文件 | 改动 |
|---|---|
| `packages/server/src/agent-team.ts` | `AgentTeamTask` 增加协议字段；`createTask` 接收 context/trace/input/budget；新增 `markTaskPhase`、`listArtifacts`、`listTasksByTrace` |
| `packages/server/src/routes/chat.ts` | 父回合生成 trace/context；派活和续派写入 task；提问原因透传；完成时写产物和用量；团队提示注入能力卡 |
| `packages/server/src/routes/tools.ts` | `agent.spawn/task/ask_parent` schema 扩展；`agent.publish_artifact` 新工具；工具目录合并 MCP；`resolveToolByFunctionName` 支持外部工具 |
| `packages/server/public/app.js` | 团队面板显示 `phase`、产物、协议来源、trace |
| `packages/server/public/app.css` | 团队面板状态样式 |
| `packages/storage/migrations/0084_agent_protocol.sql` | 上述表和字段 |

## 四、P0：内部契约

### 4.1 `agent-protocol.ts`

先定义纯类型和纯函数，不依赖数据库、不依赖网络：

```ts
export type TaskPhase = 'none' | 'input_required' | 'auth_required' | 'rejected'

export type ProtocolTaskStatus =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'auth-required'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'rejected'

export interface TaskBudget {
  maxTokens?: number
  maxCostMicros?: number
  maxDurationMs?: number
  maxRounds?: number
}

export interface AgentArtifactRef {
  id: string
  name: string
  mimeType: string
  size: number
  checksum: string
  source: 'workspace' | 'cloud' | 'inline' | 'mcp' | 'a2a'
  uri: string
  /** 工作区/云空间文件 id；前端复用现有文件预览时直接打开它 */
  fileId?: string
  preview?: string
}

export function protocolStatusOf(
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled',
  phase: TaskPhase,
): ProtocolTaskStatus {
  if (phase === 'rejected') return 'rejected'
  if (phase === 'input_required') return 'input-required'
  if (phase === 'auth_required') return 'auth-required'
  if (status === 'queued') return 'submitted'
  if (status === 'running') return 'working'
  if (status === 'succeeded') return 'completed'
  if (status === 'cancelled') return 'canceled'
  return 'failed'
}
```

验收只测纯函数和边界值，不启动模型。

### 4.2 `AgentTeamStore`

在 `agent-team.ts` 里做**增量扩展**：

```ts
export interface AgentTeamTask {
  // 现有字段保持不变
  contextId: string
  traceId: string
  phase: TaskPhase
  rejectReason: string
  input: Record<string, unknown>
  artifacts: AgentArtifactRef[]
  budget: TaskBudget
  deadlineAt: number | null
  usedTokens: number
  usedCostMicros: number
}

createTask(input: {
  // 现有字段
  contextId?: string
  traceId?: string
  input?: Record<string, unknown>
  budget?: TaskBudget
  deadlineAt?: number | null
}): AgentTeamTask

markTaskPhase(id: string, phase: TaskPhase, reason?: string, now?: number): void
markTaskDone(id: string, resultText: string, artifacts?: AgentArtifactRef[], now?: number): void
listArtifacts(taskId: string): AgentArtifactRef[]
listTasksByTrace(traceId: string, limit?: number): AgentTeamTask[]
```

实现要点：

- `getTask/listTasks` 的 SELECT 加新列；旧数据默认空值，`toTask` 做兜底。
- `markTaskDone` 更新 `artifacts_json`；`markTaskFailed` 不改 `phase`，除非显式拒绝。
- `createTask` 默认 `contextId = teamId` 去掉 `session:` 前缀，`traceId = parentRunId`；调用方显式传入优先。
- 新增的 `phase` 不参与 `listTasksAwaitingWake` 的既有判断，避免后台唤醒回归。
- `AgentTeamEvent` 增加 `contextId`、`traceId`，`recordEvent` 写入；事件查询返回。

### 4.3 `chat.ts` 接线

按现有调用链改，不动整体结构：

1. **父回合生成 trace**
   - 在 `registerChatRoutes` 生成 `runId` 处同时确定 `traceId`；第一版直接用根 `runId`，保证同一用户回合的全链路一致。
   - `contextId` 用 `sessionId`，团队内所有任务共享。

2. **派活**
   - `startBackgroundSubAgents` 的 `createTask` 传入 `contextId / traceId / input / budget`。
   - `SubAgentTask` 增加可选 `taskId`；`startBackgroundSubAgents` 建完任务后把 `taskId` 写回，传给 `spawnSubAgents`。
   - 同步续派 `agent_task` 的 `createTask` 同样补齐字段。

3. **子 Agent 执行**
   - `runAgentTurn` 增加 `taskId / traceId / contextId` 入参。
   - 执行工具的上下文 `ToolExecutionContext` 增加 `agentTaskId / agentTeam`，供 `agent.publish_artifact` 和审计使用。
   - `SubAgentResult` 增加 `promptTokens / completionTokens / artifacts`。

4. **提问与暂停**
   - `agent.ask_parent` 的 input 增加 `pauseReason`：`input / auth / resource / external`，默认 `input`。
   - 在 `pendingParentQuestion` 旁增加 `pendingParentPauseReason`。
   - `runAgentTurn` 返回 `question` 时同时返回 `pauseReason`。
   - `backgroundEmit` 的 `question` 事件 payload 带上 `pauseReason`，并调用 `team.markTaskPhase(taskId, 'input_required' | 'auth_required', text)`。
   - 父 Agent 用 `agent_task` 答复时，把 `phase` 复位为 `none`。

5. **完成**
   - `markTaskDone` 时传入子 Agent 的 artifacts 和 token 用量。
   - `markTaskFailed` 时如果错误码是 `rejected`，写 `phase='rejected'` 和 `rejectReason`。
   - 超时仍走 `failed`，不要伪装成 `rejected`。

6. **团队提示**
   - `teamRosterWithTasks(team)` 改成 `teamRosterWithTasks(team, db, companyId)`。
   - 花名册中每个岗位追加一行能力摘要：`技能 / 默认工具数 / 健康 / 当前负载`，不注入完整提示词和工具 schema。
   - 主 Agent 编队时优先按技能匹配，不再只看岗位名。

### 4.4 API 与前端

修改 `GET /api/chat/agents` 的返回：

```ts
tasks: team.listTasks(20).map((task) => ({
  // 现有字段
  contextId: task.contextId,
  traceId: task.traceId,
  status: task.status,
  protocolStatus: protocolStatusOf(task.status, task.phase),
  phase: task.phase,
  artifacts: task.artifacts,
  budget: task.budget,
  usedTokens: task.usedTokens,
}))
```

前端 `app.js` 只做增量：

- 任务卡显示 `input-required` / `auth-required` / `rejected` 不同颜色。
- `auth-required` 显示「去授权」，`input-required` 显示「等父 Agent/用户补充」。
- 产物显示文件名、类型、大小、来源。
- 底部 trace 行显示 `traceId` 前 8 位，点击可复制；不做复杂追踪页。

## 五、Artifact 落地

### 5.1 新增 `agent.publish_artifact` 工具

不自动扫描整个工作区，避免把临时文件误当交付物。由子 Agent 显式登记最终产物：

```ts
{
  id: 'agent.publish_artifact',
  name: '登记任务产物',
  scope: SC.AGENT_TOOL_INVOKE,
  dangerous: false,
  input: {
    path: { type: 'string', description: '个人云空间相对路径；与 fileId、uri 三选一' },
    fileId: { type: 'string', description: '个人云空间文件 id；与 path、uri 三选一' },
    uri: { type: 'string', description: '外部产物 uri，支持 mcp: / a2a: / https: / http: / eab:；与 path、fileId 三选一' },
    name: { type: 'string', description: '展示名；用 uri 登记时必填，文件可省略' },
    preview: { type: 'string', description: '可选：一句交付摘要，最多 500 字' },
  },
}
```

执行逻辑：

1. 从 `ToolExecutionContext` 取 `agentTaskId / agentTeam`；没有 `agentTaskId` 直接拒绝，防止主 Agent 伪造子任务产物。
2. `path` 必须位于当前员工的个人云空间根目录内，符号链接按真实路径校验；`fileId` 必须属于当前员工。
3. 文件类产物计算 `size` 和 `sha256`，MIME 按 `workspace_files` 或扩展名推断；外部 uri 只存元数据。
4. 按 `taskId + uri` 去重后写入 `agent_artifacts`，同时把引用追加到 `agent_tasks.artifacts_json`；同一文件重新发布会更新 size / checksum / preview。
5. 返回 `artifactId / name / uri / checksum / fileId`，模型只需要回一句「已登记」。

子 Agent 的工具描述已经写明：交付文件、表格、图片、代码包时，完成前必须对每个最终产物调用 `agent.publish_artifact`；临时文件、中间缓存不能登记为产物。

### 5.2 父 Agent 使用产物

- `agent_task` 同步返回和 `agent.wait` 事件都带 `artifacts`。
- 父 Agent 汇总时只拿 `name / mimeType / size / uri / preview`，需要细节再按 `uri` 读取，避免重复搬运全文。
- 产物仍然存在原工作区，不复制第二份；`agent_artifacts` 只存元数据。

## 六、Agent Card 落地

### 6.1 内置能力卡

先不追求复杂技能树，定义 5 张内置卡，对应现有岗位：

| agentKey | 名称 | 典型技能 | 默认工具 |
|---|---|---|---|
| `researcher` | 检索员 | 资料检索、知识库、网页、对比 | `kb.search / tool.search / workspace.read` |
| `builder` | 实现员 | 代码、文件写入、工程执行 | `workspace.* / project.* / office.*` |
| `critic` | 验收员 | 测试、构建、代码审查、回归 | `workspace.read / project.exec / project.job` |
| `producer` | 内容员 | 文档、表格、PPT、汇总 | `office.* / workspace.*` |
| `worker` | 通用执行 | 单点任务、补充材料 | 按任务动态下发 |

内置卡是代码常量，不落库；`agent_cards` 只存公司覆盖和远端 A2A 卡，避免每个公司初始化重复数据。

### 6.2 运行时能力卡

子 Agent 启动时生成：

```ts
{
  agentId: `${teamId}:${workerKey}`,
  skills: [role, ...task技能标签],
  tools: 当前角色可用工具 id,
  limits: { maxRounds, timeoutMs, maxTokens },
  health: 'healthy',
  endpoint: { kind: 'internal' },
}
```

只把 `skills` 和 `limits` 给主 Agent，不把完整工具 schema 和系统提示词给它。

### 6.3 选人评分

主 Agent 编队时按以下顺序过滤：

1. 技能标签命中任务关键词；
2. 所需工具在当前角色可用；
3. 健康状态不是 `offline`；
4. 当前负载未超限；
5. 预算足够；
6. 最后才按岗位名和默认优先级。

第一版可以先做规则评分，不引入向量检索。PR4 第一版只把技能摘要注入编队提示，评分尚未作为 `agent_spawn` 的硬过滤条件；实际派活仍由主 Agent 选岗，工具权限继续按角色、空间和权限过滤。

## 七、MCP 落地（P1）

### 7.1 数据表

在 `0085_mcp.sql` 增加：

```sql
CREATE TABLE IF NOT EXISTS mcp_servers (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL,
  name           TEXT NOT NULL,
  transport      TEXT NOT NULL CHECK (transport IN ('stdio', 'sse', 'http')),
  endpoint       TEXT NOT NULL DEFAULT '',
  auth_type      TEXT NOT NULL DEFAULT 'none',
  secret_ref     TEXT NOT NULL DEFAULT '',
  allowed_tools_json TEXT NOT NULL DEFAULT '[]',
  enabled        INTEGER NOT NULL DEFAULT 1,
  health         TEXT NOT NULL DEFAULT 'unknown',
  last_sync_at   INTEGER,
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_tools (
  id             TEXT PRIMARY KEY,
  server_id      TEXT NOT NULL,
  company_id     TEXT NOT NULL,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  input_schema_json TEXT NOT NULL DEFAULT '{}',
  annotations_json  TEXT NOT NULL DEFAULT '{}',
  enabled        INTEGER NOT NULL DEFAULT 1,
  synced_at      INTEGER NOT NULL,
  UNIQUE (server_id, name)
);
```

### 7.2 工具映射

MCP 工具不硬塞进 `TOOLS` 静态数组，走独立工具源：

```
mcp_servers → mcp_tools → mcpToolSpecsFor(actor) → toolSpecsForActor
                                      ↓
                          resolveMcpToolForActor(functionName)
                                      ↓
                          executeTool / executeMcpTool
```

具体改动：

- `toolSpecsForActor` 末尾追加 `mcpToolSpecsFor(db, actor, space)`。
- `searchToolCatalog` 的 `source` 类型从 `builtin | plugin` 扩为 `builtin | plugin | mcp`。
- `ToolSearchHit` 增加 `serverName`，前端显示「MCP · 服务器名」。
- `resolveToolByFunctionName` 保持内置；新增 `resolveMcpToolForActor(db, actor, functionName)`，chat 的工具循环里与 pluginTool 并列。
- 工具 function 名统一为 `mcp_<serverSlug>_<toolSlug>`，工具 id 为 `mcp:<serverId>:<toolName>`，避免撞名。
- `executeMcpTool` 复用现有 `tool-idempotency`、超时、并发、结果截断和审计；MCP 工具本身不重复实现这些。

### 7.3 同步与健康

- 管理端保存 Server 后异步 `tools/list`，写 `mcp_tools`；同步失败保留旧目录并把 `health` 标 `degraded`。
- 每 5 分钟或手动刷新一次；不在每轮对话时拉取。
- `tools/call` 失败连续 3 次熔断 60 秒，避免一个坏 Server 拖慢整个回合。
- 第一版只开放 `readOnlyHint=true` 的工具；`destructiveHint=true` 的工具即使被同步也不下发。
- 凭证只存 `secret_ref`，运行时从环境变量/密钥服务读取，不落库明文。

### 7.4 验收

- 真实接一个 MCP Server：同步出工具、`tool_search` 能搜到、模型能调用、结果结构化返回。
- 只读工具可直接调用；破坏性工具不可见。
- 停 Server 后 `health=offline`，工具从目录隐藏，已有对话不崩。
- 跨公司同名 Server 不串数据。

## 八、A2A 与 ACP

### 8.1 A2A 出站

- `agent_cards.kind='a2a'` 存远端卡；`endpoint_json` 存 URL 和鉴权引用。
- 主 Agent 通过 `agent.remote` 工具创建远端任务，内部仍写一条 `agent_tasks`，`status` 映射远端状态。
- `traceId / contextId` 原样带给远端；远端返回的 Artifact 映射成 `source='a2a'`。
- 只允许公司白名单；默认一跳，不允许远端再无限派活。

### 8.2 A2A 入站

- `GET /.well-known/agent.json` 返回受限 Agent Card；`POST /a2a` 用 JSON-RPC 支持 `message/send`、`tasks/get`、`tasks/cancel`。
- 只暴露允许的技能卡，不返回内部提示词、子 Agent 全文、工具清单。
- 入站任务必须绑定公司和 Bearer 令牌身份；无身份直接拒绝。

### 8.3 ACP（当前不实施）

- 原设计为独立 Bridge，支持 `initialize / newSession / loadSession / prompt / cancel`，文件写入与删除走现有工具审批。
- 当前没有真实 IDE 用户和明确工位试点，已决定本期不做 ACP；本节仅保留为后续可选扩展设计，不创建 `acp-bridge.ts`，也不增加 IDE 入口。
- 若未来启动，仍按 ADR-06 只做边缘桥接，不改 Web 对话与 SSE 主链路。

## 九、测试与验收

### 9.1 单元测试

- `agent-protocol.test.ts`：状态映射全表、`phase` 优先级、旧数据默认值。
- `agent-team.test.ts`：createTask 新字段、markTaskPhase、artifacts 查询、trace 查询、旧 5 状态行为不变。
- `agent-artifacts.test.ts`：路径越界、fileId 越权、checksum、重复登记幂等。
- `agent-capability-registry.test.ts`：技能匹配、offline 排除、公司隔离。
- `mcp-client.test.ts`：`tools/list`、`tools/call`、超时、坏 JSON、SSE 分帧。
- `a2a-client.test.ts`：Agent Card 解析、任务状态映射、取消。

### 9.2 集成测试

- 真实对话派 2 个子 Agent，其中一个提问 `pauseReason=auth`，前端显示「待授权」而不是「等待回答」。
- 子 Agent 写文件后调用 `agent.publish_artifact`，父 Agent 汇总能看到产物，不用重新读全文。
- 同一 `traceId` 能查到父任务、两个子任务、工具调用和产物。
- 原有后台任务、重启恢复、检查点续跑、团队面板全部不回归。

### 9.3 回归命令

```powershell
pnpm typecheck
pnpm vitest run --testTimeout=15000
node --check packages/server/public/app.js
```

当前验证基线是 203 个测试文件 / 1252 个用例；PR5 后为 207 个测试文件 / 1266 个用例，PR6 后为 211 个测试文件 / 1281 个用例；PR6.2 后全量为 213 个测试文件 / 1294 个用例（含并行开发中的浏览器与联网能力测试），且全绿。

## 十、PR 切分

| PR | 内容 | 可独立回滚 |
|---|---|---|
| PR1 | `0084` 迁移 + `agent-protocol.ts` + `AgentTeamStore` 字段与方法 + 单测 | 是 |
| PR2 | `chat.ts` 接线 context/trace/phase/usage；`/api/chat/agents` 返回新字段 | 是 |
| PR3 | `agent.publish_artifact` + `agent-artifacts.ts` + 工具描述 + 前端产物展示 | 是 |
| PR4 | `agent_capability_registry.ts` + 主 Agent 编队提示 + 能力卡管理端只读列表 | 是 |
| PR5 | `0085_mcp.sql` + `mcp-client.ts` + `mcp-registry.ts` + 只读工具接入 + 管理端登记 | 是 |
| PR6 | A2A 出站（已完成第一版）；A2A 入站受限问答（PR6.2 已完成第一版）；流式 / push 未开始 | 是 |
| PR7 | ACP Bridge；当前范围关闭，不实施 | — |

建议先做 **PR1–PR3**。这三步完成后，团队模式已经能得到「可追踪、可暂停、可交接产物」的实质提升；MCP/A2A 再接也不会把内部模型搞乱。

## 十一、实施进度

### 11.1 PR1：内部契约（已完成）

- 新增 `packages/storage/migrations/0084_agent_protocol.sql`：任务上下文、追踪、暂停原因、输入、产物、预算字段，以及 `agent_cards`、`agent_artifacts` 预留表。
- 新增 `packages/server/src/agent-protocol.ts`：协议中立状态映射、预算解析、产物解析。
- 扩展 `AgentTeamStore`：`createTask` 支持 `contextId/traceId/input/budget/deadlineAt`；新增 `markTaskPhase`、`markTaskRejected`、`markTaskUsage`、`listTasksByTrace`、`listArtifacts`；`markTaskDone` 支持产物参数。
- 保持 `agent_tasks.status` 五状态不变，用 `phase` 表达 `input_required / auth_required / rejected`，不改 CHECK 约束。
- 已补 `agent-protocol.test.ts` 与 `agent-team-store.test.ts` 用例；相关 22 个用例通过。

### 11.2 PR2：聊天链路接线（已完成）

- 后台子 Agent 提问时写 `phase`，并在团队唤醒消息里区分「待补充输入 / 待权限授权」；`agent_task` 续派取消旧任务时清空暂停原因。
- 同步 `agent_spawn` / `agent_resume` 通过 `spawnSubAgentsWithTasks` 落任务行，父回合仍同步等待，但 trace 和任务历史不再缺失。
- 子 Agent 每轮 `promptTokens/completionTokens` 回写到 `used_tokens`，完成、失败、取消都保留用量。
- `GET /api/chat/agents` 增加 `protocolStatus / phase / rejectReason / contextId / traceId / budget / deadlineAt / usedTokens / usedCostMicros / artifacts`，事件增加 `contextId / traceId`。
- 原 `status` 字段保持不变，前端旧逻辑可继续用；新逻辑可按 `protocolStatus` 显示暂停语义。

### 11.3 PR3：Artifact 产物交接（已完成）

- 新增 `packages/server/src/agent-artifacts.ts`：校验工作区路径和 `fileId` 归属，计算 `sha256`，按 `taskId + uri` 去重后写入 `agent_artifacts`，并同步追加到 `agent_tasks.artifacts_json`；只登记元数据，不复制文件。
- 新增子 Agent 工具 `agent.publish_artifact`：支持 `path`（个人云空间相对路径）、`fileId`（已有云空间文件）、`uri`（MCP/A2A/HTTP 外部产物）三种登记方式，三者只能选一个。
- `ToolExecutionContext` 增加 `agentTaskId / agentTeam`；`runAgentTurn` 把当前子任务 id 透传到工具执行器，父 Agent 的工具列表里不出现该工具。
- 后台派活、同步 `agent_spawn`、`agent_resume` 三条路径都把 `taskId` 注入 `SubAgentTask`；子 Agent 完成时从任务行读回产物，带回 `AgentChildEvent` 和 `SubAgentResult`。
- 后台唤醒父 Agent 的完成通知、历史任务摘要都附带产物名称和 `fileId`；`GET /api/chat/agents` 的 `artifacts` 已能被父 Agent 和团队面板读取。
- 前端 `public/chat.js` 团队详情新增产物列表：文件类产物点击后复用 `openWorkspaceFile(fileId)` 打开右侧预览；SSE 完成事件、轮询恢复、重绘签名都包含产物。
- 新增 `agent-artifacts.test.ts`（5 个用例）和 `agent-publish-artifact-tool.test.ts`（1 个用例）；Agent 相关 23 个测试文件 / 103 个用例通过，`pnpm typecheck` 通过；全量 202 个测试文件 / 1242 个用例通过。

### 11.4 PR4：Agent 能力卡（已完成第一版）

- 新增 `packages/server/src/agent-capability-registry.ts`：五张内置岗位卡（researcher / builder / critic / producer / worker），含技能、工具 id、回合/超时限制和健康状态。
- 内置卡是代码常量；`agent_cards` 只存公司覆盖和远端 A2A 卡。同名 `agent_key` 的公司行覆盖名称、技能、工具、限制和健康状态，空字段回落到内置卡；`a2a` 行作为额外卡追加。
- 主 Agent 编队提示新增「可用岗位能力卡」，每轮按当前公司合并内置卡与公司覆盖后再注入；只给岗位名、技能和工具 id，不给完整工具 schema，也不给系统提示词；offline 和已停用的岗位不进入提示。
- `GET /api/console/settings` 返回 `agentCards`；控制台「Agent 管理」新增只读能力卡表，显示来源（代码内置 / 公司覆盖 / 公司新增）、技能、工具、限制和健康状态。
- 新增 `agent-capability-registry.test.ts`（4 个用例），并在 `agent-team-settings-route.test.ts` 和 `chat-system-prompt-space.test.ts` 补控制台返回、公司覆盖和编队提示断言。
- 验证：`pnpm typecheck` 通过；`public/app.js`、`public/chat.js` 语法检查通过；全量 203 个测试文件 / 1252 个用例通过。
- 第一版尚未把「按技能评分」接进 `agent_spawn` 的硬过滤；运行时卡函数已提供，但不落库、不参与派活。当前派活仍由主 Agent 按提示选岗，实际工具仍按角色、空间和权限过滤。

### 11.5 PR5：MCP 适配（已完成第一版）

- 新增 `packages/storage/migrations/0085_mcp.sql`：`mcp_servers` 存公司级 Server 配置、鉴权引用、白名单、健康状态、最近同步、失败次数和 60 秒熔断；`mcp_tools` 缓存 `tools/list` 的结果，按 `server_id + name` 唯一。
- 新增 `packages/server/src/mcp-client.ts`：JSON-RPC 2.0 over HTTP / SSE 响应，完成 `initialize`、`notifications/initialized`、`tools/list`、`tools/call`，支持 `mcp-session-id`、`mcp-protocol-version`、超时、响应大小上限和 JSON-RPC error 映射。
- 新增 `packages/server/src/mcp-registry.ts`：
  - Server 增删改查、`tools/list` 同步；同步失败保留旧工具，只把 Server 标记为 degraded；
  - 只启用 `annotations.readOnlyHint = true` 且 `destructiveHint` 不为 true 的工具，并应用公司工具白名单；
  - 工具 id 为 `mcp:<serverId>:<toolName>`；OpenAI function 名带 Server / 工具短 hash，保证同名 Server、中文名和重名工具下仍稳定且不超过 64 字符；
  - 调用前检查公司、启用状态、health、熔断冷却、`AGENT_TOOL_INVOKE` scope 和角色白名单；调用失败连续 3 次熔断 60 秒；
  - 结果按 200 KB 截断，文本块单块 20 KB；审计只记录 Server / 工具 / 耗时 / 结果，不记录密钥。
- 工具目录接线：`toolSpecsForActor` 追加 MCP 工具，`toolSpecsForAgent` 首轮不直接下发；`tool_search` 能命中 MCP 工具并返回 `source: mcp` 和 Server 名；chat 工具循环在 `allowedToolNames` 内解析并执行 MCP 工具，未加载时仍要求先 `tool_search`。
- 管理端新增 `packages/server/src/routes/console-mcp.ts`：`GET /api/console/mcp`、`POST /api/console/mcp`、`PATCH /api/console/mcp/:id`、`DELETE /api/console/mcp/:id`、`POST /api/console/mcp/:id/sync`；保存时同步 `tools/list`，密钥写入 `secrets.json`，接口只返回 `secretConfigured`。
- 控制台「Agent 管理」新增「MCP 工具」块：登记 / 编辑 Server、同步、删除，展示传输、端点、鉴权状态、只读/全部工具数、健康、最近同步和失败/冷却状态。
- 第一版边界：只支持 http / sse 传输，不启动本地 stdio 进程；只读工具才进入模型目录；Server 登记属于公司级配置，暂不做用户级授权和 Server 级工具审批。
- 新增 `mcp-client.test.ts`（3 个用例）、`mcp-registry.test.ts`（6 个用例）、`mcp-tool-search.test.ts`（3 个用例）、`mcp-console-route.test.ts`（2 个用例）。
- 验证：`pnpm typecheck` 通过，`node --check public/app.js` 通过；全量 207 个测试文件 / 1266 个用例通过。

### 11.6 PR6：A2A 出站（已完成第一版）

- 新增 `packages/storage/migrations/0086_a2a.sql`：
  - `a2a_peers` 存公司级 Peer 名称、JSON-RPC 端点、Agent Card 地址、鉴权引用、技能白名单、Card 缓存、健康、最近同步、失败次数和 60 秒熔断；
  - `a2a_tasks` 存本地派遣 id、远端任务 / 上下文 id、EAB `contextId/traceId`、技能、状态、提示、结果摘要、错误和 Artifact 引用；
  - 状态允许 `submitted / working / input-required / auth-required / completed / canceled / failed / rejected / unknown`，不复制远端历史或内部 CoT。
- 新增 `packages/server/src/a2a-client.ts`：
  - 只接受 HTTP(S) JSON-RPC，拒绝 URL 内账号密码；Agent Card 默认取同源 `/.well-known/agent.json`，自定义 Card 和 Card 声明端点都必须与登记端点同源；
  - 完成 `message/send`、`tasks/get`、`tasks/cancel`，支持 JSON 与 `text/event-stream` 响应、`mcp` 式响应大小上限（2 MB）和 30–300 秒超时；
  - `summarizeA2ATask` 只抽取状态消息、Artifact 文本 / data 和带 URI 的文件；没有 URI 的远端文件只返回“未提供下载地址”，不落盘。
- 新增 `packages/server/src/a2a-registry.ts`：
  - Peer 增删改查、Card 同步、技能白名单、健康与熔断；密钥只写 `secrets.json`，库内只存 `secret_ref`；
  - Card 同步写入 `agent_cards`（`agent_key = a2a:<peerId>`、`kind='a2a'`），但内部编队提示 `agentCardBrief` 跳过 `kind='a2a'`，远端清单由 `a2aPeerBrief` 单独注入，最多 8 个；
  - `delegateA2ATask` 先落本地 `a2a_tasks` 再发 `message/send`，Task 表达轮询到终态或 `input-required/auth-required`；网络 / 协议失败连续 3 次进入 60 秒冷却，远端正常返回 `failed/rejected` 视为任务结果，不熔断；
  - `cancelA2ADelegation` 按本地 `delegationId` 映射远端任务并回写 `canceled`；
  - `allowed_skills_json` 非空时委派必须显式指定白名单技能，避免远端 Card 扩大公司授权范围。
- 工具与聊天接线：
  - `routes/tools.ts` 新增 `a2a.delegate`、`a2a.cancel`；`toolSpecsForAgent` 只有在 `hasUsableA2APeers` 为真时才把两个工具放进本轮核心工具；
  - `a2a.delegate` 的 `dangerous` 必须为 `false`，因为 `toolSpecsForActor` 会直接过滤 `dangerous=true` 的内置工具；真正的高风险标注由 `SKILL_HIGH_RISK_TOOL_IDS` 纳入；
  - `a2a.delegate` 使用 peer 级写锁、`idempotent=true`，`traceId` 透传自聊天 `runId`；子 Agent 的派生工具集合和 `tool_search` 都不下发 A2A；
  - `buildSystemPrompt` 新增 `remoteAgents`，只有当前工具包含 `a2a_delegate` 时才注入 `a2aPeerBrief`。
- 新增 `packages/server/src/routes/console-a2a.ts` 并注册到 `app.ts`：`GET/POST /api/console/a2a`、`PATCH/DELETE /api/console/a2a/:id`、`POST /api/console/a2a/:id/sync`；审计 `a2a.create/update/delete/sync`，响应只返回 `secretConfigured`，不回显密钥。
- 控制台「Agent 管理」新增「A2A 远端 Agent」块：登记 / 编辑、启停、Card 同步、删除、技能与健康展示，以及最近派遣任务的状态和 Trace。
- 第一版边界：只做出站，不做公网 / 内网入站 Agent Card、`message/send` 服务端点或入站任务落库；只做 blocking `message/send + tasks/get` 轮询，不做 `message/stream`、SSE 进度和 push notification；远端文件只登记 URI。
- 新增 `a2a-client.test.ts`（6 个用例，覆盖 JSON-RPC error 与 SSE）、`a2a-registry.test.ts`（6 个用例）、`a2a-tool.test.ts`（1 个用例）、`a2a-console-route.test.ts`（2 个用例），共 15 个用例。
- 验证：`pnpm typecheck` 通过，`node --check public/app.js` 通过；PR6 后全量 211 个测试文件 / 1281 个用例全绿。

### 11.7 PR6.2：A2A 入站受限问答（已完成第一版）

- 新增 `packages/storage/migrations/0087_a2a_inbound.sql`：`a2a_inbound` 每公司一行（启停、令牌引用、技能白名单、模型、对外地址），`a2a_inbound_tasks` 存任务状态、输入、最终文本、错误和 token 用量；状态限定 `submitted / working / completed / failed / canceled / rejected`，只保留最终答复，不存 reasoning、工具轨迹或子 Agent 内容。
- 新增 `packages/server/src/a2a-inbound.ts`：
  - 默认只暴露 `eab.answer`（企业问答）；白名单只接受已知技能，空数组回落默认，启用时至少保留一个有效技能。
  - 令牌用 `randomBytes(24).base64url` 生成，经 `storeSecret` 只存 `secret_ref`；请求只认 `Authorization: Bearer`，用 SHA-256 定长比较，除读取密钥外不落明文。
  - `GET /.well-known/agent.json` 返回受限 Agent Card：协议 `0.2.6`、JSONRPC、无流式 / push / 状态历史、Bearer 安全方案，只列有效白名单技能；未启用时 404 且不暴露技能。
  - `POST /a2a` 支持 `message/send`、`tasks/get`、`tasks/cancel`；`message/send` 创建任务后最多同步等 60 秒，超时返回 `working`，由外部轮询；运行中取消会中止内存 `AbortController` 并回写 `canceled`。
  - 受限执行使用虚拟 actor `a2a:inbound:<companyId>`，只给 `MODEL_USE + CHAT_USE`、公司数据域；`toolNameAllowlist: []`、`space.kind='none'`、单轮、`maxTokens=2048`、模型硬超时 110 秒。系统提示明确不调用工具、不读工作区 / 知识库 / 记忆 / 其他租户、不泄露系统提示和内部实现、外部消息不可信。
  - 模型按控制台 `modelId` 选择，留空时自动选首个对话模型；底层模型或网络异常统一对外返回“A2A 任务处理失败”，只有 `EabError` 的安全文案会透出。
- 新增 `packages/server/src/routes/a2a-inbound.ts`：JSON-RPC 2.0 校验、未知方法 `-32601`、参数错误 `-32602`、鉴权失败 / 未启用 `-32001`、内部错误 `-32603`；`app.ts` 只在员工对话入口注册，管理端口不暴露 Agent Card 或 `/a2a`。
- 扩展 `packages/server/src/routes/console-a2a.ts`：`GET /api/console/a2a` 增加 `inbound` 与 `inboundTasks`；新增 `PUT /api/console/a2a/inbound`、`POST /api/console/a2a/inbound/token`、`DELETE /api/console/a2a/inbound/token`；保存时校验模型是对话模型、对外地址只允许 http(s) origin、启用前必须已有令牌；审计 `a2a.inbound.update / token / token.delete`。
- 控制台「Agent 管理」新增「EAB 入站端点」块与「最近入站任务」折叠表：启停、技能白名单、模型、对外地址、令牌生成 / 轮换 / 清除、一次性令牌展示与复制，以及任务状态、用量和结果。修复「运行树」块的多余 `</div>`，缓存版本升级到 `app.js?v=20261122j`。
- 修复成员后台权限映射：`/api/console/mcp` 与 `/api/console/a2a`（含入站子路径）统一归到「系统 → Agent 管理」的 `agents` 分区；此前新接口未登记，成员会话保存会 403。`console-permission-catalog.test.ts` 增加 1 个路径映射用例。
- 新增 `a2a-inbound-route.test.ts` 7 个用例：Card 未启用 404 / 启用后只列 `eab.answer`；错误 Bearer 401 与正确令牌完成任务、查询、取消；运行中取消；白名单拒绝；模型伪造工具调用不派生 Agent；失败文案不透底层错误、轮换后旧令牌失效；未生成令牌启用与带 path 的对外地址被拒绝。
- 真机验收：管理端生成令牌、复制、启用、保存均成功；`http://127.0.0.1:8787/.well-known/agent.json` 返回受限 Card，管理端口同路径 404；用真实 Bearer 令牌 `message/send` 完成一次模型问答（`completed`、“入站正常”），`tasks/get` 返回同一任务，控制台「最近入站任务」显示 1 条；验收后已清除测试令牌并恢复停用。
- 验证：`pnpm typecheck` 通过，`node --check public/app.js` 通过；PR6.2 后全量 213 个测试文件 / 1294 个用例全绿。
- 第一版边界：只做 blocking `message/send + tasks/get` 轮询，不做 `message/stream`、SSE 进度、push notification 和附件接收；不暴露知识库、工作区、记忆或内部 Agent 工具；令牌是公司级共享 Bearer，没有按调用方分密钥、有效期、IP 白名单或计费配额；进程重启后 `submitted / working` 任务不会自动恢复，仍缺少 stale recovery。

### 11.8 范围决策与后续

- PR1–PR6.2 已完成：内部契约、聊天接线、Artifact、能力卡、MCP 只读工具、A2A 出站与入站受限问答均已落地并回归通过。
- **ACP/PR7 已明确不做**：当前没有真实 IDE 用户和工位试点，ACP Bridge 不进入本期交付，不创建进程、不增加 IDE 入口，也不改 Web 主链路。
- 协议主线到此收口。后续只按实际需求补 PR6 运维能力：A2A 入站流式 / push、按调用方分密钥与调用方审计、入站任务重启恢复；这些不影响已经交付的第一版。

## 十二、实现时的关键风险

1. **SQLite 迁移不能改 CHECK**：不要试图在 `agent_tasks` 上加新 `status`；用 `phase` 旁路。
2. **`agent_task` 同步续派和后台派活是两条路径**：两边都要写 `taskId/contextId/traceId`，否则团队面板会出现“有 worker 没任务”的空窗。
3. **子 Agent 不能拿到父 Agent 的完整工具集**：能力卡只传技能摘要；工具仍按现有角色/空间过滤。
4. **MCP 工具不能绕过 `allowedToolNames`**：必须在工具循环入口加入允许列表，否则模型可以猜 function 名越权。
5. **Artifact 不复制文件**：只登记元数据，避免工作区出现第二份大文件。
6. **A2A 入站不能返回内部 CoT**：只返回状态、摘要和产物引用。
7. **前端状态不要只加颜色**：`input-required` 和 `auth-required` 的操作按钮不同，否则用户不知道下一步做什么。
