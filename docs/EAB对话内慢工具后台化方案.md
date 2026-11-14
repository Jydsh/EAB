# EAB 对话内慢工具后台化方案（Phase 4 收尾）

> 状态：**设计定稿 / 地基已落地 / 主链路待接入**
> 相关代码：`packages/storage/migrations/0050_agent_run_suspend.sql`、`src/agent-runtime.ts`（suspend/resume/sweep）、`src/job-queue.ts`（作业队列）

## 1. 问题

一次对话回合里，模型发出 tool_call 后必须**同步拿到结果**才能继续推理。现状是工具在请求线程里直接执行：

- 慢工具（插件 RPC、Office 转换、外部系统查询）会把 SSE 连接一直占住，用户只能看着「正在生成」；
- 工具并发名额 + 排队时间叠加，几百人同时用时会出现「明明是模型在答，实际卡在工具排队」；
- 实例重启时，正在跑的工具随进程一起丢，run 只能标 cancelled，用户得重问。

Phase 4 的队列（`async_jobs`）已经把「慢操作」搬出请求线程，但**对话内工具**没法直接套用：把工具扔进队列后模型这一轮拿不到返回值，就没法继续。

## 2. 方案总览

**run 挂起（suspend）→ 作业执行（async_jobs）→ 结果回填 → 续跑（resume）**

```
对话回合(running)
   │  模型返回 tool_call
   ├── 工具预计耗时 < 阈值 ──→ 同步执行（现状，默认路径）
   └── 超过阈值 / 命中白名单
         │
         ├─ 提交 async_jobs(kind=tool.background)，run 置 suspended + 存 resume_state
         ├─ SSE 推一条 {type:'tool-background', toolId, jobId} 事件（前端显示「已转后台」）
         │
         │   worker 执行工具 → 写回 job.result
         ▼
      恢复流程：loadSuspendedRun → 读 job.result → 置回 running → 用结果继续模型循环
         │
         └─ 最终 assistant 消息照常通过 chat-events 推给同一会话
```

好处：
- 请求线程/SSE 连接不再被单次工具拖住，模型侧并发名额也能及时释放；
- 作业有租约与回收，实例崩溃后作业被放回队列重跑，run 不再直接丢失；
- 控制台「后台作业」面板能看到工具作业的排队、耗时、失败原因。

## 3. 状态机

```
agent_runs.status
  running ──suspend──→ suspended ──resume──→ running ──→ succeeded / failed
                          │
                          ├─ job failed/cancelled/丢失 ──→ failed（原因写 error）
                          └─ 挂起超时（默认 30 分钟）──→ failed
```

约束：
- 只有 `running` 能挂起，重复挂起返回 false（幂等）；
- 挂起中的 run **没有心跳**，不能交给 `sweepOrphanAgentRuns` 判死；
- 启动时 `sweepSuspendedRuns` 按作业终态收尾：作业还在跑/已成功 → 保留等恢复；作业失败/取消/记录丢失 → 判 failed。

## 4. 数据

已落地（迁移 `0050`）：

| 列 | 用途 |
|---|---|
| `pending_job_id` | 指向 `async_jobs.id` |
| `resume_state_json` | 续跑所需的最小状态，见下 |
| `updated_at` | 状态变更时间（排查用） |

`resume_state_json` 建议结构（由 chat 层组装，agent-runtime 只存不解释）：

```json
{
  "modelId": "…",
  "messages": [ …最后 N 条，含 assistant 的 tool_calls… ],
  "pendingToolCalls": [{ "id": "call_1", "name": "…", "arguments": "…" }],
  "completedToolResults": [{ "toolCallId": "call_0", "content": "…" }],
  "budget": { "spentTokens": 1234, "maxTokens": 8000 },
  "space": { "kind": "cloud" },
  "stepSeq": 7
}
```

边界：**只存续跑必需的最小上下文**，不存整段会话正文（正文在消息表）；不存密钥、审计数据、Redis 原始键。

## 5. 触发条件（默认关闭）

- `EAB_TOOL_BACKGROUND_MS`：未设置或 `0` → 全部同步执行，**行为与升级前完全一致**（当前默认）。
- 设置后：只对「预计耗时可能超过阈值」且**在白名单内**的工具后台化。
- 白名单只放**只读/可重复执行**的工具（查询、列表、探测、转换结果落库前）；
  **写类工具默认不进白名单**：`workspace.write`、`workspace.delete`、审批提交、消息发送等，重跑会导致重复写入或重复外发。
- 判定方式：先按工具 id 白名单，再按历史平均耗时（`agent_steps.duration_ms`）超过阈值的工具进入后台。

## 6. 恢复流程

- 恢复触发：作业完成事件（Redis Pub/Sub 频道 `jobs`，离线时 1.5 秒轮询）。
- 恢复步骤：
  1. `loadSuspendedRun(runId)` 拿到 `resume_state` 与 `pending_job_id`；
  2. 读 `async_jobs.result`：成功 → 作为 tool 消息写回上下文；失败 → `failSuspendedRun` 并给用户一条明确的失败消息（不静默）；
  3. `resumeAgentRun(runId)` 置回 running，继续模型循环；
  4. 后续 delta / message 事件仍走 `chat-events`（跨实例由 Pub/Sub 扇出）。
- 恢复失败（状态解析不了、模型已下线、额度不足）→ run 判 failed，并推一条 `error` 事件，避免用户永远等。

## 7. 失败与超时

| 场景 | 处理 |
|---|---|
| 作业 failed | run → failed，error 带作业错误原因 |
| 作业租约过期（实例崩溃） | `recoverStaleJobs` 放回队列重跑；仅白名单内的幂等工具允许重跑 |
| 作业记录丢失 | `sweepSuspendedRuns` 判 failed |
| 挂起超过 30 分钟 | 恢复流程判 failed（防「永远挂起」） |
| 用户主动「停止生成」 | 取消挂起 run，同时 `cancelJob` 取消排队中的作业 |

## 8. 验收标准

1. 未配 `EAB_TOOL_BACKGROUND_MS`：所有对话行为、时延与升级前一致（回归测试）。
2. 配了阈值 + 白名单工具：一次慢工具调用后，SSE 连接不被占住，run 显示「挂起 · 等后台工具」，作业完成后回复正常出现且内容正确。
3. 作业失败：用户收到明确的失败说明，run 状态 failed，不留「挂起」僵尸。
4. 杀进程重启：作业被回收重跑，run 不会永远挂起（要么续跑成功，要么明确 failed）。
5. 控制台「后台作业」能看到 `tool.background` 作业的排队/执行/结果。

## 9. 代码落点

| 位置 | 状态 |
|---|---|
| `migrations/0050_agent_run_suspend.sql` | 已落地 |
| `agent-runtime.ts`：`suspendAgentRun` / `loadSuspendedRun` / `resumeAgentRun` / `failSuspendedRun` / `sweepSuspendedRuns` | 已落地，7 例测试通过 |
| `main.ts`：启动时 `sweepSuspendedRuns` 收尾 | 已落地 |
| `job-queue.ts`：`tool.background` 处理器与恢复 worker | **待接入** |
| `routes/chat.ts`：工具调用超阈值改提交作业、组装 `resume_state` | **待接入** |
| `chat-events.ts`：`tool-background` 状态事件 | **待接入** |
| `public/app.js` / `chat.js`：气泡上的「已转后台」提示 | **待接入** |

## 10. 为什么分两步

主链路接入要动 `runAgentTurn` 的工具调用分支和消息落库顺序，属于对话核心，一旦回归影响所有人。所以先把**状态与收尾**做扎实（本步已落地并有测试覆盖），再在开关默认关闭的前提下接入主链路，出问题可以立刻把 `EAB_TOOL_BACKGROUND_MS` 清空回到同步路径。
