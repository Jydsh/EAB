# EAB Agent 团队协议优化需求（借鉴 MCP / A2A / ACP）

> 状态：需求草案（2026-11-22）
> 来源：抖音视频《MCP、A2A、ACP：Agent 世界的三种普通话》（KyleBuilds｜零号工坊）
> 关联：`docs/EAB子Agent团队化方案.md`、`EAB企业智能体基座-总体架构方案.md` 第 12 章「客户端与协议」
> 实现方案：`docs/EAB Agent团队协议实现方案.md`

## 一、结论先行

视频用三个比喻把协议边界讲清楚了：

- **MCP 是手**：Agent 怎么接外部工具、资源、提示词。
- **A2A 是队伍**：Agent 之间怎么发现能力、派任务、报进度、交结果。
- **ACP 是工位**：Agent 怎么进入编辑器/IDE，带着当前工程上下文工作，并在写文件前等确认。

对 EAB 的判断是：**不需要推翻现有父子 Agent 团队，而是把现有团队从「内部自定义协议」升级成「内部先对齐 A2A 语义，外部再接 MCP/A2A 适配层」；ACP 仅作可选参考，本期不接。

建议顺序：

1. **先把内部任务、消息、产物、能力卡统一**，不引入外部协议也能受益。
2. **再接 MCP 客户端**，把外部工具安全地并入现有 `tool_search` / 工具权限体系。
3. **再接 A2A 出站与入站适配**，让 EAB 团队能调用外部专业 Agent，也能被其他 Agent 调用。
4. **ACP 当前不做**：没有真实 IDE 工位需求，不启动 IDE 边缘桥接，也不改网页对话主链路。

原因：EAB 现在已经具备任务队列、父子派活、等待回答、后台唤醒、检查点续跑、会话级团队和前端团队面板，缺的不是「多 Agent 运行时」，而是**标准能力描述、结构化任务状态、产物交接和外部互操作边界**。

## 二、视频里的三层模型

```
┌─────────────────────────────────────────────────────────────┐
│ ACP：工位层（保留，不实施）                                    │
│ 编辑器 / IDE / 工作台 ↔ EAB 会话、上下文、文件、权限确认        │
├─────────────────────────────────────────────────────────────┤
│ A2A：队伍层                                                  │
│ 主 Agent ↔ 子 Agent / 外部专业 Agent                         │
│ 能力发现、任务生命周期、消息、进度、产物                       │
├─────────────────────────────────────────────────────────────┤
│ MCP：工具层                                                  │
│ Agent ↔ 工具 / 数据源 / 资源 / 提示词                         │
│ 工具发现、调用、结构化返回、权限与健康                         │
└─────────────────────────────────────────────────────────────┘
```

三层不是三选一，而是各管一段。EAB 应当把三者当成**三个适配面**，而不是三套并行运行时。

## 三、现状盘点

### 3.1 已有能力

| 面 | 当前实现 | 评价 |
|---|---|---|
| 团队编队 | 主 Agent 自主拆 2–4 个自包含切片，服务端分配生肖/天干名 | 已具备经理制团队，不需要改成全互联 |
| 任务派发 | `agent_spawn / agent_task / agent_wait / agent_message / agent_resume` | 已有任务、追问、追加指示、续跑 |
| 任务状态 | `queued / running / succeeded / failed / cancelled`，另有 worker `waiting` | 基本覆盖，但缺 `input-required / auth-required / rejected` 的明确区分 |
| 父子问答 | `agent_ask_parent` + `agent_consult`，统一经主 Agent 中转 | 可追踪，优于子 Agent 私聊 |
| 后台长任务 | `background:true`、事件收件箱、父唤醒、检查点 | 已具备长时间异步执行 |
| 工具接入 | 内置工具 + `tool_search` + 插件 SDK + 角色/租户授权 | 工具体系成熟，但没有 MCP 标准适配 |
| 客户端 | Web 对话 + SSE + 团队面板；ADR-06 只给 ACP 保留可选适配位 | 主链路稳定；当前已决策不做 ACP，不存在“反客为主”风险 |

### 3.2 主要缺口

| 缺口 | 现状 | 直接后果 |
|---|---|---|
| 没有 MCP 工具适配 | 外部工具只能写 EAB 插件或内置工具 | 接第三方 SaaS、数据库、MCP 生态成本高；工具发现与调用没有统一协议 |
| 没有能力卡/能力注册表 | 主 Agent 靠任务描述和角色别名拆活；子 Agent 没有机器可读的 skills/cost/limits 声明 | 容易出现「岗位名字像，但能力和工具不匹配」；无法按能力而不是按名字选人 |
| 结果是纯文本 | 子 Agent 回报 `result_text`，文件靠路径和上下文约定 | 产物交接弱：父 Agent 需要重新读文件，跨 Agent 传递容易丢元数据、校验和、预览 |
| 状态语义不够标准 | `waiting` 同时表示等输入、等授权、等外部条件 | 前端和父 Agent 无法区分「要用户补信息」和「要用户授权」 |
| 没有统一 trace | 有 `agent_runs` 和团队事件，但跨父子、工具、远程 Agent 没有统一 traceId | 排查一次任务链路要拼多处日志，成本/耗时也无法按任务归集 |
| 没有任务预算 | 有轮次上限，但没有 per-task token / 费用 / 时间预算 | 一个子 Agent 可能烧掉过多成本，主 Agent 无法按预算重新编队 |
| 外部互操作缺失 | 只能内部编队 | 不能接客户已有 A2A Agent、行业专家 Agent，也不能被外部系统按标准调用 |
| ACP 当前不做 | Web 是主入口；没有真实 IDE 试点 | IDE/本地代码工程场景暂无标准工位入口，这是当前范围取舍，不作为交付缺口 |

## 四、优化建议

### 4.1 把 A2A 语义先内化，不急着接外网

不建议直接做「互联网 Agent 市场」。先把现有团队事件模型改成 A2A 同构：

- 每个子 Agent 有稳定的 `agentId`、`contextId`、`taskId`。
- 每次派活是一条不可变任务；同一 key 的后续任务新建 `taskId`，但共享 `contextId`，保留历史。
- 任务状态从当前的 5 个扩展为：

| EAB 现状 | 建议标准状态 | 说明 |
|---|---|---|
| `queued` | `submitted` | 已受理，未开始 |
| `running` | `working` | 执行中 |
| `waiting`（缺信息） | `input-required` | 等父 Agent/用户补参数、口径、文件 |
| `waiting`（缺授权） | `auth-required` | 等权限审批、凭据、写入确认 |
| `succeeded` | `completed` | 成功，附产物 |
| `failed` | `failed` | 失败，带错误码与证据 |
| `cancelled` | `canceled` | 被取消 |
| 新增 | `rejected` | Agent 明确拒绝执行（越权、能力不匹配、策略禁止） |

- `agent_ask_parent` 的报文增加 `pauseReason`，区分 `input / auth / resource / external`；前端用不同颜色和操作按钮，不再都叫「等待回答」。
- 保持「主 Agent 是唯一经理」：内部子 Agent 不直接 A2A 互调，仍通过 `agent_consult` 让主 Agent 中转。A2A 的「各自负责、结果互传」在 EAB 里应落在**任务和产物**上，而不是放开子 Agent 私聊。

### 4.2 引入内部 Agent Card 与能力注册表

当前编队靠模型理解任务描述，建议增加机器可读的**岗位能力卡**：

```ts
type AgentCard = {
  agentId: string
  name: string
  version: string
  description: string
  companyId: string
  skills: Array<{
    id: string
    name: string
    description: string
    tags: string[]
    examples: string[]
    inputModes: string[]
    outputModes: string[]
  }>
  tools: string[]
  limits: { maxRounds: number; maxTokens?: number; timeoutMs: number; maxCost?: number }
  auth: { scopes: string[]; requiresApproval: boolean }
  health: { status: 'healthy' | 'degraded' | 'offline'; latencyMs?: number }
  endpoint?: { kind: 'internal' | 'a2a' | 'acp'; url?: string }
}
```

落地要求：

- 先做**内置岗位卡**：检索员、实现员、验收员、文档员、数据分析员、表格手等，声明默认工具、输入/输出格式、轮次和预算。
- 子 Agent 启动时生成运行时能力卡，补充当前模型、可用工具、当前负载、健康状态。
- 主 Agent 编队从「按角色名猜」升级为「按 skills 匹配 + 工具可用 + 健康 + 负载 + 预算」选人。
- 对模型只注入能力摘要，不注入完整提示词、内部工具白名单和成本明细。
- Agent Card 按公司隔离，不能跨租户发现。

### 4.3 用 Artifact 做结构化产物交接

当前子 Agent 的成果主要是 `result_text`，文件靠 workspace 路径二次读取。建议增加统一产物对象：

```ts
type Artifact = {
  id: string
  taskId: string
  name: string
  mimeType: string
  size: number
  checksum: string
  source: 'workspace' | 'cloud' | 'inline' | 'mcp' | 'a2a'
  uri?: string          // 文件路径 / fileId / 远端 URL
  preview?: string      // 短摘要，最多 500 字
  createdAt: string
}
```

要求：

- `agent_task` 支持 `inputArtifacts`，子 Agent 不必从自然语言里猜文件。
- 子 Agent 完成时返回 `artifacts[]`，父 Agent 汇总只拿摘要和引用，不重复搬运整份内容。
- 产物进入现有 workspace 元数据体系，复用 fileId、版本、权限、回收站。
- 前端团队面板显示「产物：文件名 / 类型 / 大小 / 来源 / 预览」。
- MCP 返回的资源、A2A 返回的 Artifact 统一映射到该结构。

### 4.4 MCP 作为工具接入适配层

不替换现有插件工具，而是把 MCP 当成新的工具来源：

```
MCP Server → MCP Client Gateway → EAB Tool Registry → tool_search / 权限 / 审计 → Agent
```

最低要求：

- 管理端可登记 MCP Server：公司、名称、传输方式（stdio / SSE / streamable HTTP）、端点、认证引用、允许工具列表、启停状态。
- 定时或手动同步 `tools/list`，缓存工具目录；按需刷新，避免每轮把全部 schema 打进提示词。
- 工具名统一命名空间：`mcp.<server>.<tool>`，防止与内置/插件工具撞名。
- 把 MCP 工具接入现有 `tool_search`、能力路由、角色白名单、高危审批、幂等键、超时和结果截断。
- 使用 MCP 工具注解做权限判断：`readOnlyHint`、`destructiveHint`、`idempotentHint`、`openWorldHint`。只读工具可直接用；破坏性工具必须走现有审批。
- MCP 资源与提示词作为后续能力接入；第一版只做 Tools。
- 凭证只存环境变量名或密钥引用，不落库明文。
- 记录 `serverId / toolName / latency / status / traceId`，失败可按服务器熔断。

可选后续：把 EAB 的 workspace、kb、office 等工具封装成 **EAB MCP Server**，让外部 IDE/Agent 按 MCP 调用；第一版不做，避免权限面扩大。

### 4.5 A2A 作为外部 Agent 适配层

内部先把 A2A 状态和 Agent Card 对齐，再做出站/入站适配：

- **出站（EAB 调外部 Agent）**：主 Agent 作为 A2A Client，按能力卡发现远端 Agent，创建任务，订阅 SSE 进度，接收 Artifact；超时/取消映射到 A2A `CancelTask`。
- **入站（外部 Agent 调 EAB）**：EAB 作为 A2A Server 暴露受限能力卡和任务端点，外部只能看到允许的技能，不暴露内部提示词、子 Agent 全文和工具清单。
- 远端 Agent 必须走**公司级允许列表**：域名、Agent Card 签名/来源、认证方式、可用技能、数据出站级别都要配置。
- 远端任务与本地任务共用 `taskId`、`contextId`、`traceId`，团队面板显示 `来源：本地 / A2A / MCP`。
- 不允许远端 Agent 再无限向下派活；默认只允许一跳，防止责任链和费用失控。
- 外部任务默认只返回最终产物与状态，不返回内部 CoT 和子 Agent 私聊。

### 4.6 ACP 只做可选 IDE 桥接（当前不实施）

现有 ADR-06 已明确 ACP 不是核心协议。当前进一步确认：**EAB 本期不做 ACP**，没有真实 IDE 用户和明确工位试点，不启动 Bridge 开发。以下仅保留为后续可选设计：

- 若未来启动，做一个独立 ACP Bridge 进程/适配器，支持 `initialize / newSession / loadSession / prompt / cancel`。
- 编辑器提供当前文件、选区、工程根、诊断信息；EAB 把这些映射成对话上下文和 workspace 引用。
- 文件写入、删除、执行命令走 ACP `requestPermission`，在 EAB 侧复用现有工具审批与权限矩阵；不能绕过审批。
- IDE 只作为客户端，不改变 Web 对话和 SSE 主链路，也不把 ACP 当作团队内部通信协议。
- 第一版只支持代码工程场景；没有真实 IDE 需求时不启动该里程碑。

### 4.7 横切要求：安全、预算、可观测

- **委托授权**：父 Agent 给子 Agent 的不只是任务文本，还应包含能力租约：允许的工具、数据范围、最大轮次、token/费用/时间预算、有效期。子 Agent 不能凭父身份无限扩权。
- **任务预算**：每次 `agent_spawn/task` 可设置 `maxTokens / maxCost / timeoutMs`；超限进入 `failed` 或 `input-required`，由主 Agent 重新编队。
- **统一 trace**：`traceId` 从用户回合贯穿父 Agent、子 Agent、MCP 调用、A2A 远端任务；团队面板和审计都能按 traceId 还原。
- **取消与拒绝**：支持父取消子、用户取消整单、远端 `CancelTask`；Agent 可显式 `rejected` 并给原因，不把「拒绝」伪装成「失败」。
- **版本与兼容**：事件信封加 `schemaVersion`；MCP/A2A 适配器按协议版本声明能力，旧前端和旧任务不因新字段崩溃。
- **数据边界**：跨公司、跨租户不共享 Agent Card、工具、任务和产物；A2A/MCP 出站必须标注数据级别和脱敏策略。

## 五、需求清单

| ID | 优先级 | 需求 | 验收要点 |
|---|---|---|---|
| FR-01 | P0 | 统一任务/消息/产物信封 | 任务含 `taskId/contextId/traceId/status/parts/artifacts`；旧字段兼容；现有团队测试全过 |
| FR-02 | P0 | 内部 Agent Card 与能力注册表 | 主 Agent 能按 skills、工具、健康、负载选人；公司隔离；不泄露提示词 |
| FR-03 | P0 | Artifact 产物交接 | 子任务可带输入产物、返回输出产物；父 Agent 不重复读全文；前端可预览 |
| FR-04 | P0 | 状态语义补齐 | `input-required/auth-required/rejected` 可区分；前端与父 Agent 动作不同 |
| FR-05 | P0 | 委托授权与任务预算 | 工具/数据/轮次/token/时间/费用可约束；越权拒绝并审计 |
| FR-06 | P1 | MCP Client Gateway | 能登记、发现、调用 MCP Tools；命名空间、注解、审批、超时、熔断、审计齐全 |
| FR-07 | P1 | A2A 出站适配 | 能按 Agent Card 发现远端 Agent、建任务、收进度/产物、取消；仅允许列表 |
| FR-08 | P1 | A2A 入站适配 | 外部可按受限能力卡调用 EAB；租户隔离；不暴露内部提示词和子 Agent 全文 |
| FR-09 | P1 | 团队可观测与 UI | 团队面板显示协议来源、任务状态、产物、预算、trace；可按 trace 查链路 |
| FR-10 | P2 | EAB MCP Server | 外部 IDE/Agent 可调 EAB 允许的工具；权限、审计、限流不降级 |
| FR-11 | P2 | ACP Bridge（当前不做） | 原设支持会话、上下文、写入确认、取消；当前无 IDE 试点，已关闭 |
| FR-12 | P2 | 协议版本与兼容治理 | 适配器有版本声明和降级路径；旧客户端/旧任务不崩 |

## 六、非目标

- 不把 MCP 当成 Agent 间通信协议；A2A 才是队伍层。
- 本期不做 ACP：不把 ACP 升级成 Web 对话核心协议，不新增 IDE 工位入口，也不重写现有 SSE 对话链路。
- 不放开子 Agent 任意互联、任意递归派活；主 Agent 仍是唯一编队者。
- 不在第一版接公网 Agent 市场，不默认信任任何外部 Agent Card。
- 不把内部完整提示词、CoT、子 Agent 对话原文通过 A2A/MCP 暴露给外部。
- 不为了协议形式重写现有工具注册、权限矩阵、审批和 workspace 体系。

## 七、实施阶段

### 阶段 0：内部契约（不接外部协议）

- 统一 `taskId/contextId/traceId`。
- 任务状态映射与 `pauseReason`。
- Artifact schema 与 workspace 元数据对接。
- Agent Card 内置岗位卡。
- 团队面板显示新字段，旧行为保持不变。

### 阶段 1：MCP 只读接入

- MCP Server 登记、认证引用、工具发现缓存。
- 第一版只允许 `readOnlyHint=true` 的工具，破坏性工具走审批后再开放。
- 复用 `tool_search`、能力路由、审计、超时、结果截断。
- 先接 1 个真实 MCP Server 做端到端验收。

### 阶段 2：A2A 出站

- 远端 Agent Card 拉取、允许列表、认证。
- 任务创建、SSE 进度、产物接收、取消。
- 先用于「一个明确专业能力」的外部 Agent，不从公网随机发现。

### 阶段 3：A2A 入站与 MCP Server

- 受限能力卡、任务端点、租户隔离、审计。
- 评估是否把 EAB 工具暴露为 MCP Server。

### 阶段 4：ACP（当前不启动）

- 已决策本期不做 IDE Bridge、会话映射、文件上下文、写入审批和 diff 展示。
- 保留该阶段作为后续可选工位，不影响 Web 对话和已交付的 MCP/A2A 链路。

## 八、验收总口径

1. 现有父子团队、后台任务、检查点续跑、团队面板行为不回归。
2. 同一个任务链能用 `traceId` 串起父 Agent、子 Agent、工具、MCP Server、A2A 远端 Agent。
3. 子 Agent 产物通过 Artifact 交接，父 Agent 不靠猜路径、不重复读全文。
4. `input-required` 与 `auth-required` 在前端和父 Agent 侧有不同处理，不混为「等待回答」。
5. MCP 工具只能通过登记服务器进入，工具有命名空间、权限注解、审批、超时和审计。
6. A2A 远端 Agent 只能来自公司允许列表，跨租户不可见，不能无限递归派活。
7. 本期不实施 ACP，因此不设 ACP 验收项；若未来接入，写文件/执行命令必须经过权限确认，关闭 ACP 不影响网页主链路。
8. 协议字段有版本号，旧客户端和旧任务可兼容读取。

## 九、待确认

1. **MCP 的真实需求优先级**：现在是否需要接客户已有 MCP Server？如果只需要内置工具，MCP 可放 P1；如果要接第三方 SaaS/数据库，建议提前到阶段 1。
2. **外部 A2A Agent 的范围**：只接公司自有 Agent，还是允许第三方行业 Agent？前者可先做，后者必须补签名、来源、数据出站审批。
3. **是否要把 EAB 暴露成 A2A Server / MCP Server**：这会把权限面从「内部员工」扩到「外部系统」，建议在出站稳定后再评估。
4. **ACP 是否有真实 IDE 用户**：已决策当前没有 VS Code/JetBrains 场景，本期不做 ACP；只有出现明确 IDE 试点后再评估。
5. **预算口径**：任务预算是按 token、费用还是时间为主？需要和现有模型计费、团队容量策略统一。

## 十、参考资料

- 抖音视频：<https://v.douyin.com/WGE_c6YJ3lQ/>
- MCP 规范：<https://modelcontextprotocol.io/specification/2025-11-25/index>
- MCP Tools：<https://modelcontextprotocol.io/specification/2025-11-25/server/tools>
- A2A 规范：<https://a2a-protocol.org/v0.2.6/specification/>
- A2A Task 生命周期：<https://agent2agent.info/docs/concepts/task/>
- ACP（JetBrains）：<https://www.jetbrains.com/acp/>
