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
   idle（保留身份，页脚提示空闲 2 分钟后注销）
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
- **空闲期**：`EAB_AGENT_WORKER_IDLE_MS`，默认 120 秒；服务端在生成清单与派活前都会 `pruneIdleWorkers` 校验，前端按同一时长移除窗口。
- 会话被删除/服务重启：登记表在内存里，自然清空；不落库。

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

## 五、模型分散分配

- `chooseSubAgentModel` 新增本轮已用模型负载 `load`：评分 = 能力命中 × 4 + 父模型连续性 + 模型 priority - 已用次数 × 6。
- `spawnSubAgents` 在并行执行前先按任务顺序把模型分完，维护 `modelLoad`；后一个子任务能看到前一个已经占用的模型，同能力时自动换一个，避免多个子 Agent 挤在同一个模型上放大并发压力。
- 显式 `modelId` 仍然最优先、不做覆盖，并继续用成员可见模型 `allowedModels` 校验。
- 模型理由会写进子 Agent 事件，前端事实区可以看到「本轮第 N 个使用」或「按可见模型优先级与并发负载分散」。

## 六、后端落点

| 文件 | 内容 |
|---|---|
| `src/agent-team.ts` | 团队登记表（内存）：`registerWorker` / `markWorkerRun` / `markWorkerIdle` / `markWorkerWaiting` / `pruneIdleWorkers` / `findWorker` / `listWorkers` / `clearTeam`；`TeamWorker.messages` 保存多轮上下文，`appendWorkerMessage` 追加、`workerMessages` 取快照（最多 20 条 / 约 16k 字符） |
| `src/routes/chat.ts` | `SUB_AGENT_SYSTEM_PROMPT`；`spawnSubAgents`：key 化 `childId`（`runId:k:key`）、注册与 idle 标记、事件带 `key`、`waiting` 分支发 `action=question`；`agent_ask_parent` 拦截与 `pendingParentQuestion` 立即结束本轮；模型负载 `modelLoad` 预计算；`agent_task` 自动带 worker history |
| `src/routes/tools.ts` | `agent.task`（继续派活给子 Agent）与 `agent.ask_parent`（子 Agent 向父 Agent 提问），都加入核心工具列表；父 Agent 运行时过滤掉 `ask_parent` |
| `src/config.ts` | `agentWorkerIdleMs`（`EAB_AGENT_WORKER_IDLE_MS`，默认 120000） |
| `public/chat.html` | 右栏 `workbench-tabs` + `workbench-body`；团队面板内新增 `#team-list-resizer` 分界线 |
| `public/chat.js` | 团队渲染：父右子左对话流、`question` / `waiting`、完成去重、列表/预览拖拽宽度、key 稳定复用；切换 / 并排逻辑 |
| `public/chat.css` | Agent 预览 v3：父子气泡、等待态、可拖拽分界线、移动端堆叠 |

## 七、模型侧怎么用

- `agent.spawn` 的 `tasks` 每项可带 `key`（建议英文短名）与 `title`；返回值里每个子 Agent 会回传 `key` 与 `index`。
- 需要它做第二件事时：`agent_task { agent: "research-a", prompt: "把结论整理成三条要点" }`。
- 子 Agent 在工具结果里返回 `status:"waiting"` 和 `question` 时：父 Agent 能直接答就 `agent_task` 回答；需要用户拍板就先 `ask_user`，拿到答复后必须 `agent_task` 回给该子 Agent。
- key 已注销 → 明确报错「已注销或不存在：请先 agent_spawn 重新注册」，不让父 Agent 空转。

## 八、验收

1. 右栏在团队与文件之间可切换、可并排；团队不再出现在文件预览内部。
2. 有子 Agent 时左边列表、右边预览；点列表任意一项，预览切到该 Agent，父 Agent 消息在右、子 Agent 消息在左。
3. 列表与预览之间的分界线可拖动，宽度记住；≤900px 自动堆叠。
4. 子 Agent 缺信息时出现琥珀色提问气泡，父 Agent 可直接答复，或先问用户再用 `agent_task` 回给子 Agent；子 Agent 接着完成。
5. 同一 key 二次派活复用同一窗口与同一段历史，消息接着追加。
6. 多个子 Agent 同批派发时，同能力模型按本轮负载分散，不全部挤在父模型上。
7. 子 Agent 完成后窗口显示完成态，2 分钟后自动从团队栏消失；没有右栏内容时右栏隐藏，对话宽度恢复。

## 九、边界与后续

- 团队身份**按会话保留**：同一会话里空闲期内的子 Agent 可跨轮次继续派活；会话长期空闲后由空闲期自动注销，服务重启则内存登记表清空。
- 子 Agent 不能直接改用户右侧预览的文件（预览文件上下文只给父 Agent 的工具兜底）。
- 团队不落库：`agent_runs` 已有父子关系与步骤记录，审计从那里看；可视窗口只是运行时视图。
- 尚未做：团队并行度面板（正在跑的子 Agent 数、排队数）、按角色预置子 Agent 模板（如「检索员 / 审稿员 / 表格手」）。
