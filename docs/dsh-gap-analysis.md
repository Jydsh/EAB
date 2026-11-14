# DSH → EAB 能力差距清单

> 目的：回答「DSH 里还有哪些需要的设计没有整合到 EAB」。
> 口径：以 DSH 官方/社区插件的公开能力为参照，以本仓库当前代码为事实；不把「架构文档里的愿景」当成「已实现」。
> 调研时间：2026-11-09。参考链接见文末。

## 本轮变化（2026-11-09 夜）

调度域先按 DSH 定位重构，作为「事件流」的第一个试点：

- 新增 `schedule_events` append-only 事件日志；`user_schedules` / `schedule_runs` 降为投影；
- 采纳 DSH canonical 选择器 `after_seconds` / `every_seconds(>=300)`，保留 daily/weekly 产品扩展；
- 采纳 DSH `delete` 语义（`schedule_delete`），保留 HTTP `/cancel` 别名；
- 采纳 10 项错误码闭集（`EabError.details.scheduleCode`）；
- 启动恢复写 `recover`，不重放；one-shot 优先排序 + latest-only；
- **未采纳**：只做会话内投递、冷会话不通知。EAB 保留钉钉主动推送，因为这是产品价值。

这次试点的结论：**事件流必须先于「任务中心 UI」**。否则任务中心只是又一张读表，无法回答“第几次、哪一步、为什么失败”。

## 结论

EAB 已经具备 DSH 的**基座骨架**：多租户、角色/scope、对话、工具注册表、插件宿主、知识库、个人云空间、本地空间、钉钉渠道、审计、用量统计。真正缺的不是「再抄一个功能」，而是 DSH 的**Agent 运行时语义**：

1. **append-only 会话事件日志 + Trajectory**（resume / fork / search / replay）；
2. **Agent teams / subagents**（父 Agent 派生子 Agent，结果可追溯）；
3. **无人值守的审批 fail-closed**（定时/后台任务遇到高危动作不能默认放行）；
4. **沙箱（sandboxes）**（工具执行边界，当前工具是白名单但不是隔离沙箱）；
5. **调度器的生产化增强**（本轮已补基础版，任务中心已于 2026-11-13 落地；仍缺 cron、配额、只重投递的补偿）。

其中 1 是**最高优先级**：没有事件日志，fork/resume/replay、Agent teams、审批追踪都只能靠散落的表，后续每加一个能力都要再补一次。

## 差距矩阵

| 能力域 | DSH 公开形态 | EAB 当前 | 差距 | 建议优先级 |
|---|---|---|---|---|
| 会话事件日志 / Trajectory | append-only session log；timer/tool 是投影；resume / fork / search / replay 共用同一事件流 | `chat_messages` 直接存 user/assistant 文本；工具轨迹塞在 `meta_json`；无事件流、无快照、无 fork | **大**：所有高级运行时能力的共同底座 | **P0** |
| Agent teams / Subagents | 官方插件家族有 Agent teams、Subagents；父 Agent 派生、并行、汇总 | 单 Agent 循环；`runAgentTurn` 只能顺序调工具；无子 Agent 生命周期、无父子 trace | **大**：复杂任务只能靠一次对话硬扛 | **P0** |
| 无人值守审批 | Auto approval review；后台任务 fail-closed | 有 `approvals` 表 + 高危工具审批（HTTP 入口），但 Agent 工具只暴露 `!dangerous`；定时任务没有审批门 | 中：后台任务一旦放开高危工具，缺 fail-closed | **P0（与调度联动）** |
| 沙箱 / 执行隔离 | Sandboxes 是 DSH 能力面的一层；工具/终端在隔离环境跑 | 工具是代码白名单；本地空间直接读写用户目录；没有进程/文件/网络隔离 | 大：当前定位是单公司本地部署，风险可控但边界弱 | **P1** |
| 调度 / 定时任务 | 官方 `dsh-schedule`：`after_seconds` / `at` / `every_seconds(>=300)`，session-scoped；社区插件补 cron、有效期、并发上限、IM 通知 | **本轮已重构**：事件日志 + 投影、canonical 选择器、delete 语义、错误码闭集、latest-only、钉钉/网页回推、控制台任务中心 | 还缺：批量合并 framing、unattended 审批、投递补偿、有效期、多实例抢占 | **P1（底座已就绪）** |
| 插件 / Skill 统一热插拔 | models、tools、skills、sessions、sandboxes、storage、loops、scheduling、UI 皆插件；插件可热加载 | 有 DSH 插件宿主（host + client bundle + iframe + RPC），但内置功能不是插件；Skill 是文件目录约定，不是统一运行时 | 中：生态兼容有，但「一切皆插件」的运行时没有 | **P1** |
| 运行模式 | Standard / Code(PTC) / Minimal / Creator | 只有标准对话；无代码执行模式、无最小模式、无创作模式 | 中：影响特定任务形态，不影响基座 | **P2** |
| 终端 / Terminal | 官方插件家族有 Terminal；命令执行作为工具 | 无终端工具；本地空间只能读写文件，不能执行命令 | 中：与本地空间安全边界一起设计 | **P2** |
| 语音输入 | 官方插件家族有 Voice input | 无语音入口；钉钉/网页都是文本 | 低-中：渠道体验增强 | **P2** |
| 模型路由 | 模型是插件；按用途/能力路由 | 已有 `model_routes` + `resolveModelForPurpose` + 可见性/角色过滤 | **基本对齐**，无需大改 | — |
| 长期记忆 | Session / memory 属于运行时能力面 | 有 `memories` 表 + 读写 scope；但定时任务/子 Agent 没有统一记忆注入策略 | 小-中：已有存储，缺运行时统一 | **P2** |
| UI / 工作台 | UI 也是插件；DSH 有独立工作台体验 | 自建 `/chat` 单页 + 控制台；无插件化 UI 市场 | 低：产品形态不同，不必照搬 | **P3** |
| 可观测 / 审计 | session log + trajectory 可检索 | 有 `audit_logs`、`usage_daily`、插件事件；但无「一次任务完整轨迹」视图 | 中：排障靠日志拼接 | **P1** |

## 尚未整合清单（按「底座 → 产品」排序）

1. **统一 session_events + Trajectory**：当前只有 `schedule_events` 一个域试点，消息/工具/审批/子 Agent 还没进同一事件流；没有 fork/replay/search-by-event。
2. **Subagents / Agent teams**：无子 Agent 生命周期、父子 trace、超时取消、scope 收敛；复杂任务只能单 Agent 顺序跑。
3. **无人值守审批 fail-closed**：后台/定时任务遇到 `dangerous` 工具没有 `approval_required` 终态。
4. ~~**任务中心 UI**：没有列表/时间线/最近结果页面，用户只能对话或直接打 HTTP。~~ 已完成（2026-11-13）：控制台“运营与审计 > 任务中心”，公司级列表/详情/事件时间线/暂停恢复取消，直接读 `schedule_events`。
5. **调度批量合并**：同一 tick 的多条到期提醒仍是各自一轮；DSH 的 batch framing 未做。
6. **投递补偿**：模型成功、钉钉失败时没有“只重投递”的补偿；重试会重跑模型。
7. **有效期与多实例抢占**：无 `expiresAt`；`running` 抢占是进程内锁，不是 DB 条件更新，多实例会打架。
8. **沙箱 / 终端**：工具是代码白名单，不是隔离执行；没有只读挂载、网络策略、输出上限。
9. **插件运行时统一**：内置能力不是插件；Skill 是目录约定，不是统一注册表/生命周期。
10. **运行模式**：无 Code(PTC) / Minimal / Creator，只有标准对话。
11. **语音输入**：钉钉/网页都只有文本入口。
12. **记忆注入策略**：有 `memories` 表，但定时任务/子 Agent/渠道没有统一注入规则。

## 重点差异说明

### 1. 会话事件日志与 Trajectory（P0）

DSH 把「模型输出、工具调用、定时器、子 Agent、审批」都写进 append-only 的 session log；`resume` / `fork` / `search` / `replay` 读同一份事件流。EAB 现在：

- `chat_messages` 是最终消息，工具轨迹在 `meta_json.tools` 里，属于**投影**而不是事件源；
- 没有 `event_seq`、没有事件类型注册、没有快照；
- 因此无法可靠回答「这次回答用了哪些工具、第几轮、哪个子 Agent 做的、失败在哪一步」；
- 也无法做「从某轮 fork 出新会话」「回放某次任务」。

建议：新增 `session_events`（`session_id, seq, type, payload_json, created_at`），先双写「消息 / 工具开始 / 工具结束 / 定时触发 / 审批」五类事件；`chat_messages` 继续作为读模型，不破坏现有页面。等事件流稳定后，再实现 fork/replay。

### 2. Agent teams / Subagents（P0）

DSH 的 Agent teams / Subagents 是独立插件能力：父 Agent 可以派生、并行、汇总，子 Agent 有自己的会话和工具边界。EAB 的 `runAgentTurn` 是一个顺序循环，最多 4 轮工具；没有：

- 子 Agent 的创建/取消/超时；
- 父子 trace 关联；
- 子 Agent 的权限收敛（子 Agent 不应自动继承父的全部 scope）；
- 结果合并与冲突处理。

建议：不要直接做「多 Agent 编排 UI」；先做 `subagent.run` 工具（同步、单层、带超时和 scope 白名单），把 trace 写进 session events；验证稳定后再做并行/团队。

### 3. 无人值守审批（P0）

EAB 已有 `approvals` 表和高危工具的 HTTP 审批门（`POST /api/tools/:id/invoke` 里 `dangerous` 分支），但：

- Agent 对话的工具清单只暴露 `!dangerous`，所以模型不能直接触发高危工具；
- 定时任务同样只走 `executeTool`，没有审批上下文；如果未来把高危工具开放给定时任务，必须 fail-closed（没有审批就拒绝，而不是默认执行）；
- 审批过期、审批人撤回、任务重试时的审批复用，都还没有策略。

建议：定时任务执行上下文加 `approvalMode: 'interactive' | 'unattended'`；`unattended` 下遇到 `dangerous` 工具直接失败并写 `approval_required`，由人后续处理。

### 4. 沙箱（P1）

当前「工具白名单 + 本地空间路径校验」是**权限边界**，不是**执行隔离**。本地空间工具直接读写用户目录；没有容器、没有只读挂载、没有网络策略。对单公司本地部署可接受，但一旦开放终端/代码执行，必须先有沙箱。

### 5. 调度器的差距（P1，底座已按 DSH 重构）

本轮 EAB 实现与 DSH 官方/社区对照：

| 维度 | DSH 官方 `dsh-schedule` | 社区插件（cron/automation/tasks） | EAB 本轮 |
|---|---|---|---|
| 真相 | 会话事件日志 append-only；timer 是投影 | 多数直接写任务表 | `schedule_events` append-only；`user_schedules`/`schedule_runs` 是投影 |
| 规则 | after_seconds / at / every_seconds / weekly；明确排除 cron | 真 cron、有效期窗口、并发上限 | after_seconds / every_seconds / at / daily / weekly / interval；**不做 cron** |
| 作用域 | session-scoped，只在原会话 live 时跑 | 可绑定新会话/独立会话 | 绑定创建会话；冷会话由服务端唤醒执行 |
| 冷会话 | 不外部通知 | IM 通知（微信/飞书/钉钉/Telegram） | 钉钉单聊主动推送 + 网页 SSE |
| 错过 | one-shot 优先；Every 合成一条 batch；只取最近一次 | 有的补最近、有的记 missed | one-shot 优先；latest-only；无 batch framing（待做） |
| 有效期 | 无强制 | 多数要求有效期窗口 | 无 `expiresAt`；靠删除/暂停 |
| 并发 | session 内串行；忙则等 idle | per-task 并发上限、skipped(overlap) | 进程内锁 + run 唯一索引；无 per-task 上限、无多实例抢占 |
| 审批 | 无 | automation 明确 fail-closed | 定时任务只跑非高危工具；未做 `unattended` 审批门 |
| 错误 | 10 项闭集 | 各自定义 | 同一套 `ScheduleErrorCode` |
| 结果 | followup 新 turn | 执行结论 + 通知失败标注 | 带 `【定时提醒】` 信封的新 turn + 结果落库 + 钉钉投递事件 |

结论：**事件日志与语义已对齐，任务中心已落地；生产化还差批量合并、unattended 审批、投递补偿、多实例抢占**。

## 建议路线图

### P0（下一阶段，先打底座）

1. **`session_events` 事件流 + 双写**：把 `schedule_events` 的写法推广到消息/工具开始/工具结束/定时/审批；`chat_messages` 继续做读模型。没有它，Trajectory / fork / replay 都做不实。
2. **`subagent.run` 单层子 Agent 工具 + 父子 trace**：同步、带超时、scope 白名单；先不做并行团队。
3. **定时任务 `unattended` 审批 fail-closed**：遇到 `dangerous` 工具直接失败并写 `approval_required`。
4. ~~**任务中心页面**：列表/暂停/恢复/删除/最近结果/事件时间线；数据直接读 `schedule_events`，不再拼日志。~~ 已完成（2026-11-13）。

### P1（生产化）

5. 调度器收尾：同 tick 批量合并、只重投递补偿、`expiresAt`、多实例条件抢占（任务中心时间线已落地）；
6. 沙箱边界：终端/代码执行前先做隔离，至少做到只读挂载 + 超时 + 输出上限；
7. 一次任务完整轨迹视图（直接读 `session_events`，不再拼日志）；
8. 插件运行时统一：内置能力逐步插件化，Skill 纳入统一清单。

### P2（体验）

9. 运行模式（Code PTC / Minimal）；
10. 语音输入；
11. 记忆注入策略统一；
12. cron/日历规则（如果确实有用户需要）。

## 参考链接

- 官方 `@deepseek-ai/dsh-schedule`：https://www.npmjs.com/package/@deepseek-ai/dsh-schedule
- DSH 官网：https://www.deepseek.com/harness/
- DSH 英文站：https://www.deepseek.com/en/harness/
- `@aiwayds/dsh-cron`：https://www.dshplugin.store/plugin/fan56/dsh-cron
- `@weibaohui/dsh-tasks`：https://awesome-dsh-plugin.com/p/weibaohui/dsh-tasks/
- `@michengai/dsh-automation`：https://www.dshplugin.store/plugin/MichengAI/dsh-automation
- `yangyongzhen/dsh-scheduler`：https://awesome-dsh-plugin.com/p/yangyongzhen/dsh-scheduler/
- `@qihongmu/dsh-plugins-scheduled-task`：http://raw.githubusercontent.com/qihongmu/dsh-plugins/HEAD/packages/scheduled-task/README.md

> 说明：社区插件的字段与限制来自其公开 README/插件页；不同版本可能变化，落地前应再核对一次原文。
