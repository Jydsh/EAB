# 用户自建定时任务（Schedule）— 按 DSH 定位重做

> 状态：重构中（2026-11-09）。事件日志、DSH canonical 选择器、delete 语义、错误码闭集已落盘；
> 任务中心 / 批量合并 / 无人值守审批仍是后续阶段。
> 相关代码：`packages/server/src/schedule.ts`、`routes/schedules.ts`、`routes/tools.ts`、
> 迁移 `0031_schedules.sql` + `0032_schedule_events.sql`。

## 1. 它是什么，不是什么

DSH 的 `@deepseek-ai/dsh-schedule` 不是任务编排平台，也不是工作流引擎。它的定位只有一句：

> **给一个活着的会话，挂一条持久提醒；到点后在原会话里起一个新 turn。**

EAB 沿用这个定位，并做产品化扩展：

| 维度 | DSH | EAB（本轮） | 为什么 |
|---|---|---|---|
| 真相 | 会话事件日志 append-only；timer/tool value 都是投影 | `schedule_events` 是真相；`user_schedules` / `schedule_runs` 是投影 | 后续 Trajectory、任务中心、排障共用同一套事件流 |
| 作用域 | session-scoped，只在原会话 live 时触发 | 任务绑定创建时的会话；EAB 会话是服务端持久化的，冷会话也能被唤醒 | 用户要的是“到点回复我”，不该要求他当时在线 |
| 选择器 | `after_seconds` / `at` / `every_seconds(>=300)`；不做 cron | 三者全支持；额外保留 `daily` / `weekly` 日历规则 | 国内办公场景每天/每周固定点是刚需，但由服务端校验，不让模型手写 cron |
| 删除 | `schedule_delete`，删除即终止 | `schedule.delete` 软删除为 `cancelled`，写 `delete` 事件 | 保留审计；HTTP `/cancel` 继续作为别名 |
| 触发 | 先 checkpoint，再 `followup()` 起新 turn；Agent 忙则等 idle | 写 `fire` → 执行 → 写 `complete/error`；结果落原会话 + 钉钉推送 | 保留跨设备主动通知，这是 EAB 的产品价值 |
| 逾期 | one-shot 优先；Every 合成一条 batch；每条只取最近一次 | one-shot 优先排序；每次只取 `next_run_at` 最近一次，绝不回放 | latest-only，避免补跑风暴 |
| 错误 | 10 个闭集错误码 | 同一套 `ScheduleErrorCode`，放在 `EabError.details.scheduleCode` | 模型/前端/日志能用同一套语义判断 |
| 冷会话 | 不外部通知 | 钉钉单聊主动推送（可选 `channel=web` 只落网页） | 单公司本地部署，用户主要在钉钉里收消息 |

**明确不做**：

- cron 表达式（5 段式对模型/用户都太容易错；确有需要时做成受控的高级规则，不放进模型工具）；
- 跨用户下发、群发、给别人的钉钉发消息；
- 停机期间逐条补跑错过的每个周期；
- exactly-once 承诺。崩溃在 `fire` 之后、`complete` 之前，重启会按“未完成”处理；同一 occurrence 由唯一键挡住重复执行。

## 2. 数据模型：事件是真相，表是投影

### 2.1 `schedule_events`（append-only）

```sql
schedule_events(
  id, schedule_id, company_id, user_id,
  type,          -- create | delete | pause | resume | fire | complete | error | delivery | recover
  payload_json,  -- 该事件的上下文（规则、runId、结果摘要、错误码、投递结果）
  created_at
)
```

规则：

- 只追加，不更新、不删除；任何状态变化必须先写事件，再改投影表；
- `fire` 只代表“已派发”，不代表模型成功；
- `complete` / `error` 记录一次 run 的终态；
- `delivery` 单独记录钉钉投递结果，投递失败不影响任务本身的成功状态；
- `recover` 记录进程重启后对 `running` 记录的恢复（默认不重放）。

### 2.2 `user_schedules`（当前状态投影）

`id / company_id / user_id / session_id / title / prompt / mode / payload_json / timezone / channel / status / next_run_at / last_run_at / last_error / attempts`。

状态机：`active → running → active|done|error`，`active/paused → cancelled`。

### 2.3 `schedule_runs`（执行投影）

`(schedule_id, scheduled_for)` 唯一索引保证同一 occurrence 最多执行一次；`status = running|success|error`；`delivery = sent|failed`。

## 3. 选择器与时间语义

模型入参（camelCase；HTTP 同名字段）：

| 选择器 | 说明 | 约束 |
|---|---|---|
| `afterSeconds` | 多少秒后触发一次 | >= 30 秒；写成 `once` + UTC ISO 的 `at` |
| `at` | 指定时间 | 严格可解析时间；`YYYY-MM-DD HH:mm` 按任务时区解释，带偏移的 ISO 原样使用 |
| `everySeconds` | 每隔多少秒重复 | >= 300 秒；换算为 `intervalMinutes` |
| `intervalMinutes` | 每隔多少分钟 | >= 5 分钟 |
| `daily` + `time` | 每天 HH:MM | 时分合法 |
| `weekly` + `time` + `days` | 每周几 HH:MM | `0=周日 … 6=周六` |

时间规则：

- 必须显式时区或使用默认 `Asia/Shanghai`；非法 IANA 时区返回 `invalid_time_zone`；
- 只存 canonical UTC epoch（`next_run_at` 是毫秒整数），展示时再转本地；
- once 必须晚于当前 30 秒，且不超过一年（`not_future` / `time_out_of_range`）；
- 重复任务只按“当前时刻”推进下一次，不补跑；
- 服务重启后 `running` 记录恢复为 `active` 并写 `recover`，不重放已派发的 run。

## 4. 错误码闭集

```ts
type ScheduleErrorCode =
  | 'invalid_prompt'       // 空 / 超长
  | 'invalid_selector'     // 选择器缺失或无法解析
  | 'invalid_rule'         // 模式不支持 / 通道不支持 / 其他规则错误
  | 'invalid_time_zone'    // 非法 IANA 时区
  | 'not_future'           // 一次性任务太近
  | 'time_out_of_range'    // 超过一年 / 时分越界
  | 'frequency_too_high'   // every < 300s、interval < 5min、任务数上限
  | 'corrupt_schedule_log' // 事件日志损坏（预留）
  | 'persistence_uncertain'// 创建/事件写入没有确定结果
  | 'internal_error'
```

`EabError.details.scheduleCode` 原样带出；日志、HTTP、模型工具结果都读同一个字段，避免“同一件事三种说法”。

## 5. 执行链路

```
用户/模型 → schedule_create
  → 校验 prompt/选择器/时区/上限
  → INSERT user_schedules（投影）
  → INSERT schedule_events(create)    同一事务
  → 返回 id / 下次执行时间

调度器（15s tick）
  → SELECT active AND next_run_at <= now
     ORDER BY once 优先, next_run_at
  → INSERT OR IGNORE schedule_runs(running)   唯一键去重
  → INSERT schedule_events(fire)
  → 写 user message（带【定时提醒】信封）
  → 在原 session 跑一轮 Agent
  → 写 assistant message + SSE
  → channel=dingtalk 时推送钉钉单聊
  → INSERT complete + delivery 事件
  → once 置 done；重复任务算下一次
```

用户消息信封：

```
【定时提醒】<title>
计划时间：2026-11-10 09:00（Asia/Shanghai）
任务：<prompt>
```

这样模型能区分“用户刚说的”与“计划到点”，也不会把提醒当成新需求重复确认。

## 6. 工具与 HTTP

工具（模型可见）：

- `schedule_create` → `schedule.create`
- `schedule_list` → `schedule.list`
- `schedule_delete` → `schedule.delete`（DSH 语义；旧名 `schedule.cancel` 不再暴露）

HTTP（员工端）：

- `GET /api/schedules`
- `POST /api/schedules`
- `POST /api/schedules/:id/cancel`（别名，等价 delete）
- `POST /api/schedules/:id/pause|resume`

权限：`schedule:read` / `schedule:write`；只能操作当前员工自己的任务；每员工最多 50 个进行中任务。

## 7. 当前边界与后续

已落地：

- 事件日志 + 投影写入（create/delete/pause/resume/fire/complete/error/delivery/recover）；
- DSH canonical 选择器与 5 分钟频率下限；
- 错误码闭集；
- `schedule.delete` 语义；
- 重启恢复不重放；
- 钉钉主动推送 + 网页 SSE。

未落地（按优先级）：

1. **任务中心 UI**：列表/暂停/恢复/删除/最近一次结果/事件时间线；
2. **批量合并**：同一 tick 内同一会话的多条到期提醒合成一条 framing，减少刷屏；
3. **无人值守审批 fail-closed**：定时任务遇到 `dangerous` 工具直接失败并写 `approval_required`；
4. **投递补偿**：模型成功但钉钉失败时，只重投递，不重跑模型；
5. **有效期 / 频控 / 多实例抢占**：`expiresAt`、每任务最小间隔、DB 条件更新抢占；
6. **会话事件流统一**：把 `schedule_events` 的写法推广到 `session_events`，让 Trajectory 直接读。

## 8. 验收口径

- `pnpm typecheck` 0；
- `pnpm exec vitest run packages/server/test/schedule.test.ts --pool=forks` 全过；
- 真机：网页/钉钉各建一条 `after_seconds` 任务，到点在原会话看到「定时提醒」+ 回答，钉钉单聊收到同一条结果；
- 查库：`user_schedules.status`、`schedule_runs`、`schedule_events` 三者能对上；同一 occurrence 不出现两条 run。
