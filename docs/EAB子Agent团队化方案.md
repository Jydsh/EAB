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
| `[工具]` 行 | 左侧缩进 | 它调用了什么工具、结果摘要、耗时（✓ / ◐ / ✕）；中间失败后自动重试成功时只显示成功，✕ 仅保留给最后一次未恢复的失败 |
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
- 父唤醒不是“再开一个用户请求”：它的消息带 `meta.backgroundWake`，前端按普通消息渲染，可以单独标成后台回传。
- 多子 Agent 几乎同时结束：本批唤醒只拿先结束的几个任务，模型返回后必须重新检查事件收件箱；只要还有没被本批消费的完成事件，就先写一条 `meta.progress:true` 的可见进展（本次已完成谁、还剩几个结果待汇总），不把模型的过程话术当最终汇报。全部批次收口后才写最终汇总。
- 模型偶尔会把“（内部调度：甲、乙已回报，丙仍在执行）”当正文返回；服务端识别这类过程话术，在没有剩余任务时改用真实任务结果生成用户可读汇总，内部调度文本不再进入用户消息流。
- 子 Agent 每次成功回报后，父 Agent 向该 worker 追加一条 `【主 Agent 已收到你的本次回报】任务已完成并收口，无需再执行任何操作` 的确认消息，保证子 Agent 不会停在“已回复、没人接”的状态；这条确认不追加新工作。
- 后台任务复用父请求的 `AbortSignal`：父回合被用户主动取消时，尚未结束的后台子任务会收到取消；父回合正常结束不会取消后台任务。
- 服务重启：`recoverInterruptedAgentTasks` 把 `queued|running` 任务标为 failed、写 error 事件并清空 `wake_at`，`running` worker 改回 idle；任务原文和检查点保留，启动阶段不做自动重跑，避免在未知身份下重复花模型费用。
- `agent_resume`：父 Agent 专用的“从检查点继续”。参数 `agent`（团队 key）、可选 `taskId`、可选 `background`（默认 true）。只接受 `failed|cancelled` 且有 `agent_tasks.child_run_id -> agent_runs.resume_state_json` 检查点的任务；`running/queued` 明确拒绝，`succeeded` 要求改用 `agent_task`，queued 阶段中断、没有 child run 的任务明确报“没有可用检查点”。恢复时以检查点消息为基座，补回 system prompt 和原任务，追加“不要重复已完成工作”的提示，并复用检查点的 `turnId` 作为工具幂等键；允许读取 `truncated:true` 但仍有合法消息的精简检查点，也允许消息为空但保留了原任务的检查点，避免极端长度下直接失去续跑资格；后台续跑会创建新 `agent_tasks`，返回 `resumed:true` 与原 `fromTaskId`。

## 六、模型分散分配

- `chooseSubAgentModel` 新增本轮已用模型负载 `load`：评分 = 能力命中 × 4 + 父模型连续性 + 模型 priority - 已用次数 × 6。
- `spawnSubAgents` 在并行执行前先按任务顺序把模型分完，维护 `modelLoad`；后一个子任务能看到前一个已经占用的模型，同能力时自动换一个，避免多个子 Agent 挤在同一个模型上放大并发压力。
- 显式 `modelId` 仍然最优先、不做覆盖，并继续用成员可见模型 `allowedModels` 校验。
- 模型理由会写进子 Agent 事件，前端事实区可以看到「本轮第 N 个使用」或「按可见模型优先级与并发负载分散」。
- 子 Agent 选模型前先做健康过滤：父 Agent 本轮真实调用失败过的模型会进入 `excludeModelIds`，从子 Agent 候选中排除；即使健康探测稍后把它重新标为可用，本轮也不会再派给子 Agent。
- 如果 SystemOne 决策模型从完整目录里挑回一个已被健康过滤或本轮失败的模型，`allowedModels` 校验会拒绝并回退到按能力/负载分配；没有可用候选时明确报错，不静默沿用坏模型。

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

- 团队由主 Agent 自主编制：用户不需要说“用团队模式”，也不需要点名人数、名字或分工。主 Agent 先判断任务能否拆成互不依赖、可独立验收的切片；能拆就派 2–4 个，确实只有一个不可拆主线才派 1 个，并说明原因。禁止反问“要不要派团队/派几个/叫什么”。
- 每个子任务由主 Agent 命名：名字由服务端按团队岗位序号统一分配，前 12 个用十二生肖（子鼠、丑牛、寅虎……亥猪），第 13–22 个用十天干（甲、乙、丙、丁、戊、己、庚、辛、壬、癸），超过 22 个自动组合生肖与天干，保证同一团队内不重名；`title` 用「名字（职责）」格式，例如「子鼠（资料检索）」「丑牛（接口实现）」；`key` 用稳定英文短名，同一职责多人并行时用 `build-1` / `build-2` 区分，不能共用一个 key。模型给的名字只用于提取职责描述，最终显示名由服务端分配。
- 每个切片必须自包含：子任务开工时就能拿到完成所需信息，不能派“等别的子任务产出后再整理 / 汇总 / 写报告”的依赖任务；最终汇总由主 Agent 自己完成。
- 子 Agent 的思考、工具和回报正文只进入右侧团队预览，不进入用户主对话；主对话只保留主 Agent 的简短进度（只写“已完成几个/还剩几个”，不带子 Agent 名字和原文）和最终整合结论，不转发子 Agent 的分析。
- 角色名做有限归一：`analyzer / analyst / 分析员` → `researcher`，`summarizer / 汇总 / 整理` → `producer`，`tester / reviewer / 验收` → `critic`，`coder / developer / 实现` → `builder`；其余未知角色仍直接拒绝，避免静默改变职责。
- 服务端不再在模型思考前直接生成一个“总包”子任务。命中前台实质任务时，只把本轮第一次工具调用锁定为 `agent_spawn`，并注入“自主团队编队”系统提示；具体人数、名字、切片和验收标准由模型生成，避免主 Agent 被确定性单任务派发绕过。
- 团队编队只允许主 Agent 做：`depth > 0` 的子 Agent 看不到 `agent_spawn` / `agent_task` / `agent_retire`，也不能再派下一层；需要额外帮助时只能 `agent_ask_parent` 说明缺口，防止无界递归。
- 子 Agent 的 `tool_search` 结果层也会过滤 `agent_spawn` / `agent_task` / `agent_retire`：即使子 Agent 主动搜索编队工具，也看不到它们，避免把 `{"tasks":...}` 参数当成最终答复返回。
- `agent.spawn` 的 `tasks` 每项可带 `key`（建议英文短名）与 `title`；返回值里每个子 Agent 会回传 `key` 与 `index`。
- `tasks` 参数做多层剥壳：既接受数组，也接受被再 `JSON.stringify` 一层的字符串、`{"tasks":"..."}` 包装；字符串内部若混入裸换行/制表符，会先在字符串值内转义再解析，避免把合法编队因一个换行直接打回。
- 工程类子任务增加交付门禁：服务端识别“开发/实现/修复/测试/构建/接口/页面”等工程意图后，子 Agent 第一次说“完成”时先检查本轮工具记录；没有 `project.exec` 前台执行 `test/build/typecheck/lint` 且 `status=completed`、`exitCode=0` 的证据，就注入“交付前自检门禁”并继续同一次 run，最多 3 轮。仍无通过证据的任务标为 `failed`，父 Agent 不能把它当成功汇总。
- 工程任务的首轮 prompt 自动追加执行合同：理解需求 → 检查现状 → 最小改动 → 自测 → 自检 → 失败修复 → 复测 → 交付；子 Agent 必须自己读 stdout/stderr 并改代码重跑，不能把测试失败丢回父 Agent。
- 复杂工程编队按互不冲突的文件/模块所有权切片；拆不出互不冲突切片时，一个 builder 做完整实现，另一个 critic 独立复跑测试，避免多个 builder 同时改同一文件。
- 非代码任务也要自检：前端/页面任务检查实际 HTTP/页面渲染，文档/数据任务生成后回读文件核对内容、格式、条数和引用。
- 父 Agent 收到工程 `failed` 且原因是“未取得测试通过证据”时，优先用 `agent_task` 让同一 key 继续修；只有外部凭据、权限或环境阻塞才在最终汇报里写明失败模块和已尝试命令。
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
11. 用户只给实质任务、不说明团队模式/人数/名字时，主 Agent 自主拆出 2–4 个可独立验收的子任务，为每个子任务写出「中文短名（职责）」并直接派发；切片必须自包含，汇总由主 Agent 完成，不再由服务端预先生成一个“总包”任务。
12. 父 Agent 本轮调用的模型失败并自动切换后，新派出的子 Agent 不再选择这个失败模型；子 Agent 也不能通过 `tool_search` 看到或调用编队工具。
13. 同一批子 Agent 名字不重名：服务端按团队岗位序号分配，前 12 个用十二生肖，第 13–22 个用十天干，超过 22 个自动组合生肖与天干；复用同一个 key 时保留原名；序号上限按包含已注销岗位的全表计算，避免旧岗位注销后新岗位从 1 重新编号而与历史名字重复。子 Agent 的回报正文只在右侧团队预览显示，用户主对话只保留不带名字和原文的简短进度，以及主 Agent 整合后的最终结论。

### 自动化验证

- `chat-system-prompt-space.test.ts`：系统提示明确要求主 Agent 自主编队、给子任务起中文短名（职责）、禁止反问人数和名字、禁止压成总包、切片必须自包含且汇总由主 Agent 完成；子 Agent 的 `tool_search` 结果会过滤编队工具。
- `agent-spawn.test.ts`：`analyzer` / `summarizer` 等常见角色别名归一到 `researcher` / `producer`；子 Agent 名字按生肖/天干顺序分配，同一批不重名。
- `agent-background.test.ts`：后台可见进展只写员工名和已完成/未完成状态，不粘贴子 Agent 的回报原文。
- `agent-background.test.ts`：`background:true` 立即返回、父 Agent 用 `agent_wait` 拿到 `done` 事件；父回合结束后后台完成事件唤醒父 Agent 并写出 `backgroundWake` 汇总。
- `agent-resume.test.ts`：读取失败任务的 `child_run` 检查点续跑、保留 worker 会话与进度；无检查点、已成功任务的拒绝路径。
- `agent-runtime-checkpoint.test.ts`：超长检查点仍写入合法 JSON，能直接 `JSON.parse`；单条消息本身超长时降级为保留 system 和原任务的精简检查点。
- `agent-agents-route.test.ts`：真实 `GET /api/chat/agents` 返回持久化 worker/task/event；缺 `sessionId` 返回 400、会话不存在返回 404。

## 十、工程闭环与自纠错（本轮补齐）

### 1. 串行步骤必须合并成一个工程任务

模型常把“运行失败 → 定位错误 → 修正 → 复测”拆成多个依赖岗位，真实页面上会看到 4 个岗位互相等待，测试岗还会在文件没改好时先跑。`parseSubAgentTasks` 现在先做“实现 + 纯验证”合并，再做 `mergeEngineeringClosurePipeline`：

- 命中 `确认失败 / 定位错误 / 修正后 / 重新运行 / 复测 / 验证修正结果 / rerun / retest` 中至少两条，或一条且总任务不少于 3 个；
- 整组合并成一个任务，保留第一个非纯验证任务的 key/title；
- 把所有步骤按顺序追加到 prompt，并写明“这是同一个工程闭环的连续步骤，全部由你按顺序完成，不要等待其他岗位”；
- acceptance 合并，默认要求“测试/构建全部通过且 exitCode=0”。

真实页面已验证：同一句“运行失败→定位→修正→复测”的任务只生成 1 个岗位 `子鼠（修复验收）`，不再出现 `test-1 / debug-1 / fix-1 / test-2` 四个岗位。

### 2. 子 Agent 自己的修复闭环

工程子任务拿到的是执行合同，不是一句“请实现”：

- 先检查现状，再做最小完整改动；
- 必须实际运行测试/构建，读 stdout/stderr/exitCode；
- 失败断言通常暴露实现错误，优先读被测试的实现文件（如 `mathx.mjs`），不要反复读测试文件；
- 改完立即重跑同一条命令，直到 `exitCode=0`，最后再复测一次。

服务端还有两道强制门禁：

- `completionGate`：没有 `exitCode=0` 证据就不允许收口，最多自动注入 5 次“交付前自检”；
- 交付校验：工程任务即使写了“已完成”，没有通过证据也不标记 succeeded，而是 failed，主 Agent 不会把它当成功汇总。

真实页面已验证：`mathx.mjs` 的 `mul` 被故意写成 `a + b`，子 Agent 先跑出 2 个失败，读取实现后把一行改成 `a * b`，连续两次 `node --test mathx.test.mjs` 都是 3/3、exitCode=0，才向主 Agent 回报；主 Agent 随后输出结论、依据和建议。

### 3. 空转保护

弱模型会反复用同一参数读同一个文件，表面在“工作”，实际没有任何进展。现在：

- 同一轮里同一参数的 `workspace.read` 只允许生效一次，第二次直接返回“重复读取被拒绝”，并计入工具失败恢复；
- 工具失败恢复最多 4 次，提示里明确要求换参数、换工具；`workspace.edit` 报“replace 与 find 相同”时，强制改用 `workspace.write` 整体重写；
- 工程任务轮次上限至少 24 轮，保证有足够空间完成“跑失败→修→复测”。

### 4. 系统指令位置

自动编队和出题模式的运行时说明以前被插到 user 消息之后，部分模型会返回 HTTP 400 `System message must be at the beginning`。现在统一由 `appendSystemInstruction` 追加到第一条 system 消息，没有 system 时才补到最前面。

### 5. 回归

- `agent-spawn.test.ts` 6 项：自动派发、自检门禁拦回再补跑、依赖切片合并、串行闭环合并；
- `agent-verification-gate.test.ts` 2 项：前台 `project.exec`、后台 `project.job output` 的通过/不通过证据；
- `agent-background.test.ts` 5 项、`agent-model-choice.test.ts` 13 项、`chat-system-prompt-space.test.ts` 10 项；
- `pnpm typecheck` 0；核心 4 文件 23 项、全量 5 文件 36 项通过（vitest 在本机需 `--minWorkers=1 --maxWorkers=1`，默认多 worker 会因内存不足退出）。

## 十一、团队对话闭环与流式汇总（本轮补齐）

### 1. 子 Agent 提问必须带决策上下文

`agent_ask_parent` 的报文从“一句问题”改为固定结构，并新增可选参数：

| 字段 | 作用 |
|---|---|
| `question` | 卡住的具体问题 |
| `context` | 当前进度、已经试过什么、失败证据 |
| `options` | 2–3 个可选方向 |
| `recommendation` | 子 Agent 自己的建议 |

服务端用 `formatAskParentMessage` 生成统一报文：

```
【需要主 Agent 决策】
【问题】…
【当前进度与卡点】…
【可选方向】…
【我的建议】…
【需要你给出】明确判断、下一步动作、不要做什么、以及怎么验收
```

同一个 key 续派时，父 Agent 的答复会以【主 Agent 决策】回到子 Agent 的会话，子 Agent 接着做，不重复已完成的工作；如果答复没有解决卡点，带着新证据再次提问。

### 2. 跨岗位协作走主 Agent 中转

新增 `agent_consult`（仅子 Agent 可用），用于“我需要另一个同事的数据/产出/判断”：

- 子 Agent 说明希望谁配合、要什么、自己做到哪一步；
- 问题进入团队线程，标为【申请协作】；
- 主 Agent 可以直接答复，也可以先用 `agent_task` 让目标同事给结论，再把整合方向答复原提问者；
- 不允许子 Agent 绕过主 Agent 直接找同事，避免团队里出现无法追踪的私聊。

### 3. 主 Agent 答复必须给方向和验收口径

多 Agent 规则要求主 Agent 回答子 Agent 时至少写清：

- 【判断】事实是什么、卡点是否成立；
- 【下一步】具体动作和替代路径；
- 【不要做什么】禁止重复搜索、换文件、再请示等；
- 【怎么验收】交付格式和必须包含的证据。

文件/路径类提问不再把选择推回用户：`pathQuestion` 为真时，主 Agent 本轮工具里不提供 `ask_user`，只保留 `agent_task`、`workspace_list`、`workspace_read`，迫使经理自己查清候选并拍板。选替代文件按内容语义判断，优先 `docs/` 正式业务文档，`archive/`、`test-fixtures/`、`tmp/`、`*.bak` 不能当业务文件。

### 4. 最终汇总流式输出

后台唤醒轮只有在“没有待回答提问、所有子任务已成功、没有排队/运行中的任务”时才进入 `streamFinal`：

- 主 Agent 的正文/思考增量通过 `publishChatEvent({type:'delta'})` 实时推到页面；
- 固定 `streamMessageId`，最终落库复用同一个 id，前端同一个 live 气泡收尾，不会出现两条重复消息；
- 非最终汇总轮不推正文增量，避免用户看到“已完成一部分/仍在执行”的调度话术；
- 后台汇总轮禁用出题路由，避免系统提示词里的“出题/题组”把普通任务误判成答题模式、压住正文增量。

真实页面已验证：约 55 秒内同一个 AI 节点记录到 97 次长度变化，正文从几百字符增长到最终 862 字符，`hasQuiz=false`；最终结论不再整段弹出。

### 5. 团队线程可见性

后台唤醒轮以前会吞掉所有子 Agent 事件，团队面板只看到子 Agent 提问、看不到主 Agent 回答和后续执行。`emitWake` 现在对 `event.type === 'agent'` 始终发布 `subagent` 事件，因此团队面板能完整显示：

```
子 Agent · 提问 → 主 Agent · 回答 → 子 Agent 继续执行 → 子 Agent · 回报
```

`agent_message` 对运行中的子 Agent 追加约束时，会作为“主 Agent · 追加指示”进入同一个线程。

### 6. 资料任务不再被工程门禁误判

工程门禁只认真实工程动作（开发、实现、修复、跑测试、构建、编译、部署、启动服务等），不再因为正文出现“测试夹具/测试数据/项目资料”这类名词就要求 `project.exec`。否则文档读取任务会被反复注入“交付前自检”，最后被标成 failed，尽管内容已经交付。

真实页面已验证：子 Agent 读取 `docs/知识库落地风险要点清单.md`、提炼 2 条要点并交付，主 Agent 正常汇总；替代文件选择从 `archive/test-fixtures/长文本批次验收-张辉权.txt` 纠正为 `docs/知识库落地风险要点清单.md`，并明确排除测试夹具。

### 7. 答复等待中的员工必须转入后台续跑

父 Agent 在后台决策轮用 `agent_task` 答复等待中的子 Agent 时，本轮必须强制转后台（`forceBackgroundReplies`），不能同步等到员工做完：

- 同步路径会先取消旧任务、直接跑新一轮子 Agent，**不创建新任务行**，团队面板会把旧行标成“已由父 Agent 的后续派活接管”，看起来像失败；
- 父回合同步结束时拿不到“员工完成之后”的独立汇总轮，最终正文会被压到回合收口，用户看到的就是整段结论突然出现；
- 转为后台后，服务端会为续跑创建新的 `agent_tasks` 行，员工完成后再次唤醒父 Agent，最终汇总在独立轮里流式输出。

该强制只作用于后台“回答问题/跨岗协作”轮；普通前台对话仍保留调用方原本的同步/后台选择，避免改变既有语义。

### 8. 强制 tool_choice 必须存在于本轮工具目录

路径类提问会移除 `ask_user`，让经理自己拍板；但如果同一轮仍因“请确认/选一个”把 `tool_choice` 强制为 `ask_user`，厂商会直接返回 `HTTP 400: tool_choice function ask_user was not found`，员工会永远停在“等待回答”。

修复分两层：

- 后台决策轮不再强制 `ask_user`，由父 Agent 自己给判断；
- 所有 `tool_choice` 在发给模型前都要校验目标工具确实出现在本轮 `tools` 里，不在就丢弃，避免任何“提示词要求 A、工具目录没有 A”的组合把父 Agent 打断。

真实新会话已验证：员工提问 → 父 Agent 给出【判断】【下一步】【不要做什么】【怎么验收】→ 员工按指示回报“任务终止” → 父 Agent 流式汇总；团队面板完整显示提问、回答、回报，最新任务为 `succeeded`。

## 十二、边界与后续

- 团队身份**按会话保留并落库**：同一会话里空闲期内的子 Agent 可跨轮次继续派活；会话长期空闲后由空闲期自动注销；服务重启后登记表还在，父 Agent 仍能看到 key、上次回报和未处理事件。如果父 Agent 在注销后才用 `agent_task` 续派，系统会按同一个 key 和该 key 的历史任务自动恢复窗口与会话，不需要改用 `agent_spawn` 重新注册。
- 子 Agent 不能直接改用户右侧预览的文件（预览文件上下文只给父 Agent 的工具兜底）。
- `agent_runs` 仍保存父子关系、步骤和 `resume_state_json` 检查点；团队表只保存可视窗口需要的身份、任务和事件，不重复存完整轨迹。
- 尚未做：服务启动阶段的身份可信自动续跑（当前只在父 Agent 或用户明确调用 `agent_resume` 时继续）、团队并行度面板（正在跑的子 Agent 数、排队数）、按角色预置子 Agent 模板（如「检索员 / 审稿员 / 表格手」）。
