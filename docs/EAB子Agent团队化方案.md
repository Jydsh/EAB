# 子 Agent 团队化方案（可见的经理 + 团队）

> 需求：子 Agent 不是塞在「文件预览」里的附注，而是与「对话」「文件预览」同级的一等区域；每个子 Agent 有自己可见的对话窗口，看得见它怎么干活；父 Agent 是经理，派活、收回报、再派活；子 Agent 空闲没有新任务就自动注销，需要时重新注册。

## 一、布局（重设计后的右栏）

```
┌──────────────┬───────────────────────────┬───────────────────────────┐
│ 左栏（会话列表） │ 中栏：对话（父 Agent 气泡）      │ 右栏：工作台              │
│              │                           │ ┌ 团队 │ 文件 │ 并排 ┐      │
│              │                           │ ├───────────────────────┤ │
│              │                           │ │ AGENT TEAM            │ │
│              │                           │ │ 父 Agent · 当前对话    │ │
│              │                           │ │  2 工作中 · 共 3 个     │ │
│              │                           │ │ 01 查资料  ◐ 运行中     │ │
│              │                           │ │ 02 改文档  ✓ 待命       │ │
│              │                           │ │ 03 检索    ✓ 待命       │ │
│              │                           │ │ ┌ AGENT 01 详情 ──────┐│ │
│              │                           │ │ │ [父派发] 查三项资料  ││ │
│              │                           │ │ │ [工具] kb.search ✓   ││ │
│              │                           │ │ │ [子输出] 第一份……    ││ │
│              │                           │ │ │ [回报] 三点结论      ││ │
│              │                           │ │ └──────────────────────┘│ │
│              │                           │ └───────────────────────┘ │
└──────────────┴───────────────────────────┴───────────────────────────┘
```

- **同级而不是嵌套**：`#team-pane` 与 `#file-pane` 是 `#workbench-body` 下的两个平级 section；顶部 `#workbench-tabs` 切换「团队 / 文件 / 并排」。团队不再长在文件预览里面。
- 两块都能独立占满整栏；「并排」时各占一半；≤900px 自动改上下堆叠。
- 没有文件预览时团队独占；没有团队时文件独占；两个都没有则整栏隐藏（与升级前一致）。
- **宽度规则**（实机截图后修正）：
  - 右栏一出现就解除 `.chat-main` 的 960px 阅读宽度（`.is-workbench-open`），否则两栏一起被挤在 960 里、左右留大片空白。
  - 右栏与对话之间有一条可拖拽分界线（鼠标悬停变 `col-resize`、拖动实时改宽度、支持左右方向键），团队和文件共用同一条拖动条，但**各自记住自己的比例**：`--team-split`（默认 56%）与 `--file-split`（默认 50%），分别存在 `eab.chat.teamSplitRatio` / `eab.chat.fileSplitRatio`。
  - 拖动下限：团队模式右栏 ≥440px、对话 ≥360px；文件模式沿用 284px。
  - 团队 + 文件：仍按 `--team-split` 的可拖拽比例，两栏都在右栏里。
  - ≤900px：团队栏改为对话下方一条、最高 46vh，拖动条隐藏。

## 二、团队面板：左列表 + 右预览（对话式工作台）

屏幕空间有限，右栏不做「所有 Agent 窗口平铺」，改成左右两栏的主次结构：左边窄列表只显示身份与进度，右边预览显示当前选中的那个 Agent 的完整对话。列表与预览之间的分界线可以像「对话 / 文件预览」一样拖动，宽度记在 `eab.chat.teamListWidth`。

```
┌ 父 Agent · 当前对话                        1 工作中 · 1 待回答 ┐
├──────────────┬───────────────────────────────────────┤
│ 01 时间查询   │ AGENT 03 · agent-3  知识检索  ● 等待回答 │
│   运行中      │ 模型 · Qwen3.5-27B · 1 次工具 · 3.2s     │
│ 02 表格工具   │             [父 Agent] 调用 kb_search…  │
│   待命        │ [子 Agent] 检索结果：……                  │
│ 03 知识检索   │ [子 Agent · 提问] 要按哪个口径统计？      │
│   待回答      │             [父 Agent] 按 A 口径统计      │
│ 04 打开卡片   │ [子 Agent · 回报] 按 A 口径完成           │
│ 05 检索校验   │ key · agent-3 · 1 次工具 · 19.3s          │
└──────────────┴───────────────────────────────────────┘
```

- 点列表任意一行，右边预览立刻切到那个 Agent 的完整工作过程；默认选中运行中的第一个，新派发或新提问时自动聚焦到该 Agent。
- 列表宽度可在 128px 到「总宽 - 260px」之间拖动，指针、触摸、键盘（←/→，Shift 加速，Home/End）都支持；≤900px 自动隐藏拖动条，列表回到自动宽，详情上下排列。
- 列表每条是一张卡片：左侧编号徽章、标题 + 短状态、下一行 key / 工具次数 / 耗时；选中项有高亮边和更亮的底色，运行中的编号徽章会发光，等待回答的卡片是琥珀色。
- 预览区吃掉剩余宽度，只有选中的那一个 Agent 展开；卡片铺满右栏高度，头部是身份与状态，中间对话流自己滚动，页脚贴底。
- 选中项被注销时自动回落：先找运行中的，再找等待回答的，最后取列表第一个，不会出现空白。

**对话流（父右子左）**：

| 元素 | 位置 | 含义 |
|---|---|---|
| `[父 Agent · 派发]` 气泡 | 右侧，实色深青 | 父 Agent 这次派给它的完整任务，也是父 Agent 的追问 / 答复 |
| `[子 Agent]` 输出气泡 | 左侧，浅青半透明 | 流式正文，按条合并，不碎裂 |
| `[子 Agent · 提问]` 气泡 | 左侧，琥珀色 | 子 Agent 缺信息 / 需授权时向父 Agent 提的问题 |
| `[子 Agent · 过程记录]` | 左侧 | 阶段汇报、失败原因等非最终结论 |
| `[工具]` 行 | 左侧缩进 | 它调用了什么工具、结果摘要、耗时（✓ / ◐ / ✕） |
| `[子 Agent · 回报]` 气泡 | 左侧，绿色边 | 最终结论，父 Agent 拿到的就是这段 |
| `[子 Agent · 完成 / 失败]` 气泡 | 左侧 | 结束标记，同一段正文已展示时不重复追加 |

同一个 key 再次派活 → **复用同一个窗口和同一段会话历史**，新的父 Agent 派发在右、子 Agent 回复在左，形成连续对话。

## 三、生命周期（注册 → 工作 → 待命 → 注销）

```
agent_spawn(key=research-a)
        │  注册 worker（status=running，窗口出现）
        ▼
     工作（子 run 独立 session / 独立 runId，事件只进自己的窗口）
        │  done
        ▼
   idle（保留身份，空闲 2 分钟后服务端注销；当前打开的预览窗口会保留给用户看历史，切走后回收）
        │  agent_task(key, prompt)  ← 父 Agent 再派活（复用窗口）
        │  ── 有任务就回到 running
        ▼
   idle 超期  →  注销（窗口移出团队，key 失效）
        │
        ▼
  需要它再干 → 重新 agent_spawn 注册（同 key 重新出现）
```

- **团队挂会话，不挂单次 run**：登记表的 key 是 `session:<sessionId>`，所以**下一轮用户消息里父 Agent 仍能凭同一个 key 给同一个子 Agent 派活**，窗口也接着用（`childId = session:k:key` 稳定）。没有 sessionId 的入口（定时任务等）退回按 run 隔离，回合结束即注销。
- **下一轮的“团队记忆”**：`teamRoster(sessionId)` 会把仍存活的子 Agent（key、名称、空闲/工作中、上次回报摘要）写进本轮系统提示，父 Agent 知道自己手上还有谁、谁在忙。
- **资源释放**：子 run 结束即释放会话锁与运行资源；注销只是把身份与可视窗口收掉，不额外占内存。
- **空闲期**：`EAB_AGENT_WORKER_IDLE_MS`，默认 120 秒；服务端在生成清单与派活前都会 `pruneIdleWorkers` 校验，前端按同一时长回收窗口，但当前正在查看的预览窗口保留到用户切走。
- **团队已落库**：`agent_workers` / `agent_team_messages` / `agent_tasks` / `agent_events` 四张表（迁移 `0060_agent_team.sql`）。会话被删除时清理对应团队；服务重启不再清空登记表，父 Agent 下一轮仍能凭 key 继续派活。上次进程留下的 running 后台任务在启动时标为 failed 并写一条 error 事件，任务原文与 `agent_runs.resume_state_json` 检查点保留，等待用户或父 Agent 明确重新派活。

## 四、父子问答协议（子 Agent 暂停，父 Agent 回答）

父 Agent 在 `Promise.all` 里等子 Agent，不能同步反向调用；所以采用「子 Agent 暂停并提问、父 Agent 回答后继续」的协议，而不是让父 Agent 在阻塞期间被反向调用。

```
子 Agent 执行中缺信息 / 需授权
        │ 调用 agent_ask_parent(question, context)
        ▼
本轮立即结束：工具结果 status=waiting_for_parent
        │ 事件 action=question、status=waiting
        ▼
父 Agent 的工具结果看到 agents:[{status:"waiting", question}]
        │
        ├─ 能直接判断 → 直接 agent_task(key, 答复)
        └─ 需要用户拍板 → ask_user 问用户，拿到答复后再 agent_task(key, 答复)
        ▼
子 Agent 带着同一段历史继续，完成后正常回报
```

- `agent.ask_parent` 只下发给子 Agent，父 Agent 的工具列表里会被过滤掉，避免父 Agent 误用。
- 子 Agent 本轮被暂停后不会 `emitDone`，而是 `markWorkerWaiting`；`waiting` 状态不会被空闲退休误删，只在父 Agent 回复或任务取消时改变。
- 子 Agent 有独立 system prompt：只对父 Agent 负责、不直接面对用户、缺信息先问父 Agent、父 Agent 的答复会接在同一会话里。
- 父 Agent 的团队清单会显示 `工作中 / 空闲 / 等待父 Agent 回答`，并提示「能直接答就直接答；需要用户补充信息或授权时用 ask_user，拿到答复后必须用 agent_task 回给该子 Agent」。

## 五、后台长任务与父 Agent 唤醒

同步 `agent_spawn` / `agent_task` 仍然保留 `Promise.all` 语义：调用方等本批结束，适合“这一步就要结果”的派活。需要跨回合持续干活时显式加 `background:true`：

```
父 Agent: agent_spawn { tasks, background: true }
        │ 写 agent_tasks（queued）后立即返回 taskId
        ▼
后台子 Agent 独立跑（最长 12 轮模型→工具，轮间写 checkpoint）
        │  done / question / error
        ▼
写 agent_events（父 Agent 的事件收件箱）
        │
        ├─ 父回合还活着：父 Agent 用 agent_wait 取事件，或直接结束本轮
        └─ 父回合已结束：延迟 400ms 合并，唤醒父 Agent 继续一轮
```

- `agent_wait`：父 Agent 专用，只等 `question|done|error`，默认 30 秒（`agentWaitTimeoutMs`）；取到事件后把对应任务标记为已唤醒，避免同一结果被自动唤醒重复汇总。
- `agent_message`：父 Agent 给 **running** 子 Agent 追加约束；子 Agent 每轮开始前消费一次，以 `【父 Agent 追加指示】` 注入。idle/waiting 的子 Agent 不接受，仍走 `agent_task`。
- 父唤醒：`wakeParentForBackground` 先看父 run 是否仍在 running；在跑就每 5 秒重试一次、最多约 10 分钟，避免打断正在 `agent_wait` 的回合。父 run 已结束时，`acquireTurn` 拿会话锁，插入一条带 `backgroundWake:true` 的 user 消息（有提问就带上提问原文），跑最多 4 轮父 Agent，再写 assistant 消息并广播。`question` 和 `done/error` 都能触发唤醒；同一个任务回答完再结束会重新获得唤醒资格。
- 父唤醒不是“再开一个用户请求”：它的消息带 `meta.backgroundWake`，前端可以按普通消息渲染，也可以单独标成后台回传。
- 后台任务复用父请求的 `AbortSignal`：父回合被用户主动取消时，尚未结束的后台子任务会收到取消；父回合正常结束不会取消后台任务。
- 服务重启：`recoverInterruptedAgentTasks` 把 `queued|running` 任务标为 failed、写 error 事件并清空 `wake_at`，`running` worker 改回 idle；任务原文和检查点保留，启动阶段不做自动重跑，避免在未知身份下重复花模型费用。
- `agent_resume`：父 Agent 专用的“从检查点继续”。参数 `agent`（团队 key）、可选 `taskId`、可选 `background`（默认 true）。只接受 `failed|cancelled` 且有 `agent_tasks.child_run_id -> agent_runs.resume_state_json` 检查点的任务；`running/queued` 明确拒绝，`succeeded` 要求改用 `agent_task`，queued 阶段中断、没有 child run 的任务明确报“没有可用检查点”。恢复时以检查点消息为基座，补回 system prompt 和原任务，追加“不要重复已完成工作”的提示，并复用检查点的 `turnId` 作为工具幂等键；允许读取 `truncated:true` 但仍有合法消息的精简检查点，也允许消息为空但保留了原任务的检查点，避免极端长度下直接失去续跑资格；后台续跑会创建新 `agent_tasks`，返回 `resumed:true` 与原 `fromTaskId`。

## 六、模型分散分配

- `chooseSubAgentModel` 新增本轮已用模型负载 `load`：评分 = 能力命中 × 4 + 父模型连续性 + 模型 priority - 已用次数 × 6。
- `spawnSubAgents` 在并行执行前先按任务顺序把模型分完，维护 `modelLoad`；后一个子任务能看到前一个已经占用的模型，同能力时自动换一个，避免多个子 Agent 挤在同一个模型上放大并发压力。
- 显式 `modelId` 仍然最优先、不做覆盖，并继续用成员可见模型 `allowedModels` 校验。
- 模型理由会写进子 Agent 事件，前端事实区可以看到「本轮第 N 个使用」或「按可见模型优先级与并发负载分散」。

## 七、后端落点

| 文件 | 内容 |
|---|---|
| `src/agent-team.ts` | 两套实现：内存自由函数保留给轻量调用/测试；生产用 `AgentTeamStore`（`registerWorker` / `markWorkerRun` / `markWorkerIdle` / `markWorkerWaiting` / `pruneIdleWorkers` / `findWorker` / `listWorkers` / `clearTeam` / `roster`）。消息、任务和事件都走 DB；`TeamWorker.messages` 仍然最多 20 条 / 约 16k 字符 |
| `src/routes/chat.ts` | `SUB_AGENT_SYSTEM_PROMPT`；`spawnSubAgents`：key 化 `childId`（`runId:k:key`）、注册与 idle 标记、事件带 `key`、`waiting` 分支发 `action=question`；`agent_ask_parent` 拦截与 `pendingParentQuestion` 立即结束本轮；模型负载 `modelLoad` 预计算；`agent_task` 自动带 worker history；新增 `startBackgroundSubAgents`、`agent_wait`、`agent_message`、`agent_resume`、父 Agent 后台唤醒；`loadAgentResumeCheckpoint` / `resumeMessagesForSubAgent` 负责检查点读取与消息补齐；新增只读接口 `GET /api/chat/agents?sessionId=...` 返回 roster / workers / tasks / events，供前端轮询进度 |
| `src/routes/tools.ts` | `agent.task`（继续派活给子 Agent）、`agent.ask_parent`（子 Agent 向父 Agent 提问）、`agent.wait`（父 Agent 等下一个事件）、`agent.message`（给运行中的子 Agent 追加指示）、`agent.resume`（从检查点继续失败/中断任务），均已加入核心工具列表 |
| `src/config.ts` | `agentWorkerIdleMs`（`EAB_AGENT_WORKER_IDLE_MS`，默认 120000）、`agentChildMaxRounds`（默认 12）、`agentWaitTimeoutMs`（默认 30000） |
| `src/agent-runtime.ts` | `checkpointAgentRun`：子 Agent 每轮把轮次、`turnId`、system、原任务、最近 12 条消息（保留 `tool_calls` / `tool_call_id`）写进 `resume_state_json`；超长时逐条丢弃最早消息，仍超长才写一条合法的精简检查点（`truncated:true`，保留 `round`/`turnId`/`system`/`prompt`/`text` 并重建最小消息），绝不落半截 JSON；恢复侧接受这种精简检查点，必要时从 `prompt` 重建“system + 原任务” |
| `storage/migrations/0060_agent_team.sql` | 团队、消息、任务、事件四张表；`agent_tasks` 的 `wake_at` 标记父 Agent 是否已因该任务被唤醒 |
| `public/chat.html` | 右栏 `workbench-tabs` + `workbench-body`；团队面板内新增 `#team-list-resizer` 分界线 |
| `public/chat.js` | 团队渲染：父右子左对话流、`question` / `waiting`、完成去重、列表/预览拖拽宽度、key 稳定复用；切换 / 并排逻辑 |
| `public/chat.css` | Agent 预览 v3：父子气泡、等待态、可拖拽分界线、移动端堆叠 |

## 八、模型侧怎么用

- `agent.spawn` 的 `tasks` 每项可带 `key`（建议英文短名）与 `title`；返回值里每个子 Agent 会回传 `key` 与 `index`。
- 需要它做第二件事时：`agent_task { agent: "research-a", prompt: "把结论整理成三条要点" }`。
- 子 Agent 在工具结果里返回 `status:"waiting"` 和 `question` 时：父 Agent 能直接答就 `agent_task` 回答；需要用户拍板就先 `ask_user`，拿到答复后必须 `agent_task` 回给该子 Agent。
- key 已注销 → 明确报错「已注销或不存在：请先 agent_spawn 重新注册」，不让父 Agent 空转。

## 九、验收

1. 右栏在团队与文件之间可切换、可并排；团队不再出现在文件预览内部。
2. 有子 Agent 时左边列表、右边预览；点列表任意一项，预览切到该 Agent，父 Agent 消息在右、子 Agent 消息在左。
3. 列表与预览之间的分界线可拖动，宽度记住；≤900px 自动堆叠。
4. 子 Agent 缺信息时出现琥珀色提问气泡，父 Agent 可直接答复，或先问用户再用 `agent_task` 回给子 Agent；子 Agent 接着完成。
5. 同一 key 二次派活复用同一窗口与同一段历史，消息接着追加。
6. 多个子 Agent 同批派发时，同能力模型按本轮负载分散，不全部挤在父模型上。
7. 子 Agent 完成后窗口显示完成态；服务端仍按 2 分钟空闲期注销，但当前打开的预览窗口会保留，方便用户上滑查看父子对话，切到别的子 Agent 或新派发后再回收；没有右栏内容时右栏隐藏，对话宽度恢复。
8. `agent_spawn { background:true }` 立即返回 `taskId`；父 Agent 不退出时可用 `agent_wait` 取下一个完成/提问事件，父回合已结束时由后台唤醒补一条汇总。
9. 刷新页面或服务重启后，团队栏仍能从 `GET /api/chat/agents?sessionId=...` 恢复上一次的 worker、任务状态和最近一次回报。
10. 后台任务被服务重启标为 failed 后，父 Agent 调 `agent_resume` 能读取检查点继续，不再从头重做；没有检查点或任务已成功时给出可执行的拒绝原因。`agent_resume` 的后台路径同样会写新任务并触发父唤醒。

### 自动化验证

- `agent-background.test.ts`：`background:true` 立即返回、父 Agent 用 `agent_wait` 拿到 `done` 事件；父回合结束后后台完成事件唤醒父 Agent 并写出 `backgroundWake` 汇总。
- `agent-resume.test.ts`：读取失败任务的 `child_run` 检查点续跑、保留 worker 会话与进度；无检查点、已成功任务的拒绝路径。
- `agent-runtime-checkpoint.test.ts`：超长检查点仍写入合法 JSON，能直接 `JSON.parse`；单条消息本身超长时降级为保留 system 和原任务的精简检查点。
- `agent-agents-route.test.ts`：真实 `GET /api/chat/agents` 返回持久化 worker/task/event；缺 `sessionId` 返回 400、会话不存在返回 404。

## 十、边界与后续

- 团队身份**按会话保留并落库**：同一会话里空闲期内的子 Agent 可跨轮次继续派活；会话长期空闲后由空闲期自动注销；服务重启后登记表还在，父 Agent 仍能看到 key、上次回报和未处理事件。如果父 Agent 在注销后才用 `agent_task` 续派，系统会按同一个 key 和该 key 的历史任务自动恢复窗口与会话，不需要改用 `agent_spawn` 重新注册。
- 子 Agent 不能直接改用户右侧预览的文件（预览文件上下文只给父 Agent 的工具兜底）。
- `agent_runs` 仍保存父子关系、步骤和 `resume_state_json` 检查点；团队表只保存可视窗口需要的身份、任务和事件，不重复存完整轨迹。
- 尚未做：服务启动阶段的身份可信自动续跑（当前只在父 Agent 或用户明确调用 `agent_resume` 时继续）、团队并行度面板（正在跑的子 Agent 数、排队数）、按角色预置子 Agent 模板（如「检索员 / 审稿员 / 表格手」）。
