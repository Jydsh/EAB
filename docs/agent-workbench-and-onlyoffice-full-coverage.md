# Agent 工作现场与 OnlyOffice 全覆盖设计

## 0. 实施状态（2026-11-14）

| 阶段 | 状态 | 已落地 | 未落地 |
|---|---|---|---|
| P0 设计 | 完成 | 本文档 | 待用户评审 |
| P1 可观察多 Agent | 完成，已实测 | 后端 `agent` 事件（spawn/assign/content/tool/report/done）、按任务能力自动选模型、子 Agent 完成注销；前端 `agent-dock` 分窗口、父子派发与汇报、模型与步骤展示、无内容时隐藏右栏 | 事件未进 `chat-events` 总线；父子双向消息仍是第二阶段 |
| P2 预览能力矩阵 | 部分完成，已实测 | 服务端 `GET /api/workspace/files/:id/preview-capability`；前端按 `kind` 决定是否创建预览栏；无预览文件不显示空白面板 | 文本选区/diff、图片区域/OCR、PDF 高亮批注、权限失效自动关闭尚未实现 |
| P3 OnlyOffice 插件与内容工具 | 插件、读取/替换/插入/删除表格行/列、合并表网格删行删列、矩形合并/整表拆分、格式/批注、单元格插入、定位、高亮、查看态自动刷新、强制保存、插件保存按钮、修订读取/写入与插件接受/拒绝、xlsx `cell` 插件注入、工作表面板、保存同步、工作表追加/删除、列宽/行高、xlsx legacy 单元格批注已实现并验收 | 插件 manifest/页面/脚本、`editorConfig.plugins` 注入、短期 `plugin` token、插件 SDK 握手、只读/编辑模式读取文档结构、`office.read_outline` / `office.find` / `office.replace` / `office.insert` / `office.format` / `office.comment`、合并表 `gridSpan/vMerge` 网格布局、`office.insert action=merge|split`、单元格内插入、插件内定位并选中、编辑模式高亮全部命中、关闭预览保存回调、`POST /api/workspace/office/plugin/force-save`、`saved`/`pending`/`no_changes` 结果、无 token/非法 token/只读 token 拒绝、工具完成后查看态自动重载、插件保存后 `eab:onlyoffice:saved` + `refresh-guard` + 查看态重载、`workspace.file.force_save` 审计、xlsx `EditorsSupport:["cell"]`、`documentType:"cell"`、WORKSHEET 面板、工作表读取、查找选中、编辑态替换与保存、xlsx 工作表增删与列宽/行高、xlsx `comments`/VML 批注 add/list/delete 与最后一条清理 | xlsx threaded comments/persons、批注自定义 VML 位置、数字/公式/合并单元格的替换与保存未验证；pptx 插件注入与幻灯片面板已落地，但仅文本级读取/替换，多页跳转与结构编辑仍未覆盖 |
| P4 xlsx/pptx 与 GUI 兜底 | 未开始 | — | 表格/幻灯片分支、未覆盖 UI 的受控兜底清单 |

## 1. 目标

把现有 `/chat` 从“左侧对话 + 右侧文件预览”升级为一个可观察、可干预的 Agent 工作现场：

1. OnlyOffice 支持的全部文档内容操作可由模型发起，并在预览中看到定位、修改、批注、修订和保存过程。
2. PDF、图片、文本等降级预览页也支持相应的模型操作；没有可用预览时不出现空白预览区，有预览时才展示。
3. 一个对话对应一个父 Agent；父 Agent 可分派多个子 Agent，右侧顶部为每个子 Agent 展示独立窗口。
4. 子 Agent 窗口实时展示父 Agent 的派发、子 Agent 的工具步骤、中间输出和最终汇报。
5. 父 Agent 自动为子 Agent 选择当前身份可见、健康、能力匹配的模型。
6. 子 Agent 完成后立即释放运行资源并标记为“已注销”，历史轨迹保留可回看。
7. 对话页呈现有视觉冲击力的“Agent 运行台”，但不牺牲可读性、键盘操作和窄屏可用性。

## 2. 边界与口径

### 2.1 “全覆盖”的三层定义

OnlyOffice 是一个 Canvas 型编辑器，不能把“所有功能”简单等同于“模拟鼠标点所有按钮”。本项目按三层实现：

| 层 | 覆盖内容 | 稳定性 | 是否主路径 |
|---|---|---|---|
| L1 内容层 | 文档结构读取、段落/表格/单元格/幻灯片定位、文字与格式编辑、批注、修订、保存、版本 | 高 | 是 |
| L2 编辑器层 | 编辑器内选中、滚动、高亮、操作侧栏、修订可视化、保存状态、撤销 | 高 | 是 |
| L3 GUI 兜底层 | L1/L2 未暴露的原生按钮、打印设置、部分对话框、宏等 | 低，易受布局变化影响 | 否，人工确认后使用 |

因此“全覆盖”的产品承诺是：

- 文档内容操作全覆盖：凡 OnlyOffice 文档 API 暴露的段落、表格、格式、批注、修订、保存能力，都进入统一工具集。
- 编辑器可见过程全覆盖：所有 Agent 文档动作都在编辑器中留下可观察的定位/高亮/批注/修订记录。
- UI 按钮级全覆盖：提供受控 GUI 兜底，但不承诺 100% 稳定，也不作为无人值守的主路径。

### 2.2 预览显示规则

预览区不是常驻空面板。服务端返回 `previewCapability`，前端只在 `kind != none` 时创建预览栏：

```ts
type PreviewKind = 'office' | 'text' | 'image' | 'pdf' | 'none'

interface PreviewCapability {
  kind: PreviewKind
  mode: 'view' | 'edit'
  agentOps: string[]      // read / select / edit / annotate / comment / render
  reason?: string         // kind=none 时给出原因
}
```

规则：

- `kind=none`：不显示预览栏，不预留宽度，不创建 iframe/编辑器。
- `kind=office`：OnlyOffice 编辑器；本人可编辑，共享文件只读。
- `kind=text`：文本预览 + 选区引用 + Agent 文本修改 + diff 高亮。
- `kind=image`：图片预览 + 区域选择 + OCR/描述/标注；不承诺像素级重绘。
- `kind=pdf`：PDF 预览 + 文本提取/页与区域选择/高亮批注；原 PDF 重排编辑交给 PDF 工具。
- 文件删除、权限失效、OnlyOffice 不可用且无降级能力时，立即关闭预览栏并恢复对话宽度。
- Agent 产生/修改可预览文件时发 `preview_intent`；前端只有能力可用才自动打开，不能打开时只保留文件操作卡和下载入口。

## 3. OnlyOffice 全覆盖架构

### 3.1 内容层：EAB 文档工具

新增 `office.*` 工具族，不依赖浏览器，不要求编辑器打开：

| 工具 | 作用 |
|---|---|
| `office.read_outline` | 读取标题、段落、表格、单元格、页/幻灯片索引 |
| `office.read_range` | 按稳定 ID、页范围、段落范围读取文本和结构 |
| `office.find` | 按文本/正则定位，返回候选位置和上下文 |
| `office.replace` | 替换指定范围，保留周边格式；docx 支持 `trackChanges` 生成 `w:ins`/`w:del` |
| `office.insert` | 在指定锚点前后插入段落、表格行/列；`action=delete` 删除 docx 表格行/列（支持合并网格）；`action=merge` 矩形合并；`action=split` 整表拆分 |
| `office.format` | 字体、字号、颜色、加粗、对齐、行距、表格边框 |
| `office.comment` | 添加、回复、解决、删除、列出批注；短语级 `oldText`/`start+end`，线程关系写入 `commentsExtended`/`commentsIds` |
| `office.revisions` | 只读读取 docx `w:ins`/`w:del`；编辑器插件内开启/接受/拒绝修订 |
| `office.save` | 保存、版本快照、审计 |
| `office.export` | PDF/图片等导出；不支持时明确返回未覆盖 |

内容层优先使用服务端文档处理库；工具输出必须包含：

- `fileId`、`version`、`operationId`
- 目标定位（段落 ID、表格 ID/行列、幻灯片 ID/形状 ID、文本范围）
- 修改前后摘要
- 是否需要编辑器同步
- 审计记录

### 3.2 编辑器层：EAB OnlyOffice 插件

在 `buildOfficeEditorConfig` 中注入受信任插件：

```ts
editorConfig.plugins = {
  autostart: ['asc.{EAB-AGENT-PLUGIN-ID}'],
  pluginsData: [`${EAB_PUBLIC_URL}/onlyoffice/eab-agent/config.json`],
}
```

插件职责：

1. 建立与 EAB 的短连接通道（短期 token，绑定 company/user/file/mode）。
2. 接收 Agent 命令，调用 OnlyOffice Document API / `callCommand` 操作文档。
3. 执行前选中目标并滚动到可见区域；执行中显示“正在修改”状态；执行后高亮变化范围。
4. 在编辑器内展示 EAB Agent 侧栏：当前任务、步骤、修改摘要、撤销/继续。
5. 将结果回传 EAB：成功/失败、目标位置、修改前后文本摘要、保存状态。
6. 默认开启修订模式，让用户能看到改前/改后，并能接受或拒绝。

安全约束：

- 只允许加载 EAB 自己托管的插件，禁止 `pluginsData` 接受用户输入 URL。
- 插件 token 只允许当前用户、当前文件、当前模式，短时效。
- 插件命令只允许白名单动作；不允许执行任意宏、任意网络请求。
- 共享文件只读时，插件拒绝一切写命令。
- 所有命令落审计：`workspace.file.agent_edit`，包含 operationId、目标、结果。

### 3.3 GUI 兜底层

仅用于 L1/L2 确实没有 API 的 UI 功能：

- 打开原生对话框、打印设置、部分导出选项、宏管理器等。
- 必须由用户明确触发或在执行前确认。
- 使用浏览器页面自动化，不把坐标点击作为默认策略。
- 失败时不重试到无限循环；返回“该功能未开放 API，需要人工确认”。

### 3.4 OnlyOffice 版本与许可证

- 自定义插件 + 插件内 `callCommand` 不依赖 OnlyOffice Developer 版的 Automation API。
- OnlyOffice Automation API 仅 Developer 版提供且额外付费；如果后续采购，可作为更直接的外部连接器，但不是本项目第一阶段的依赖。
- 需要在部署前确认当前 Document Server 版本、插件目录/外链可达性、JWT 配置和 `EAB_PUBLIC_URL`。

## 4. 降级预览能力矩阵

| 文件类型 | 预览 | Agent 可做 | Agent 不可做 | 无能力时 |
|---|---|---|---|---|
| doc/docx/xlsx/pptx 等 | OnlyOffice | 结构读取、内容/格式/表格/批注/修订/保存 | API 未暴露的原生按钮 | 关闭预览，保留下载 |
| txt/md/json/csv/log | 文本预览 | 选区引用、范围替换、diff 高亮、保存 | 复杂排版渲染 | 不显示预览 |
| png/jpg/webp 等 | 图片预览 | 区域选择、OCR、描述、标注/裁剪建议 | 任意像素级生成式重绘 | 不显示预览 |
| pdf | PDF 预览 | 文本提取、页/区域选择、高亮批注、导出 | 任意重排编辑 | 不显示预览 |
| 其他二进制 | 无 | 仅下载/发送 | 预览与内容操作 | 不显示预览 |

## 5. 多 Agent 运行模型

### 5.1 层级

```text
Conversation（一个对话）
  └── ParentAgent（会话级父 Agent，身份稳定）
       └── TurnRun（一次用户消息对应的根 run）
            ├── ChildRun A（子 Agent，独立 runId / 独立会话锁）
            ├── ChildRun B
            └── ChildRun C
```

- `Conversation` 持有父 Agent 身份、模型偏好、右侧运行台状态。
- `TurnRun` 对应现有 `runAgentTurn` 的一次根 run。
- `ChildRun` 对应 `agent.spawn` 派生的子任务；沿用现有 `parent_run_id`、`agent_id`、`session_id`。
- 子 Agent 不共享父会话锁；同一文件仍走现有资源锁。

### 5.2 父子沟通

第一阶段先落“可观察沟通”：

- `assign`：父 Agent 向子 Agent 派发任务（任务标题 + 任务摘要）。
- `report`：子 Agent 汇报当前步骤/阶段结果。
- `done`：子 Agent 成功、失败或取消的最终汇报。

第二阶段增加双向消息：

- `agent.message`：父 Agent 在子任务运行中补充要求。
- `agent.ask`：子 Agent 向父 Agent 请求决策或补充材料。
- 消息进入 `agent_messages` 表，UI 在每个子 Agent 窗口内以对话气泡展示。

### 5.3 模型自动分配

父 Agent 为每个子任务选择模型，必须满足：

1. 只在当前员工可见、公司启用、provider 健康的模型中选择。
2. 任务显式指定 `modelId` 时优先，但仍要做可见性校验。
3. 未指定时按任务能力评分：

| 任务信号 | 优先能力 |
|---|---|
| 代码、脚本、接口、bug | `code` |
| 分析、规划、比较、推理 | `reasoning` / `decision` |
| 图片、截图、视觉 | `vision` / `multimodal` |
| 检索、资料、文档 | `tool` / `long_context` |
| 快速改写、短答 | `fast` |

4. 评分 = 能力命中 × 4 + 父模型连续性 × 2 + priority 归一化 + 健康状态。
5. 没有匹配模型时回退到父模型；父模型不可用时回退到可见模型的第一优先级。
6. 子 Agent 已经输出内容后不切换模型，避免半截输出拼接；只在重试开始时换模型。
7. 分配结果写入事件和 `agent_runs.model_id`，UI 展示“为什么选它”。

### 5.4 生命周期与资源释放

- `spawn`：登记 `activeRuns`，占一个并发槽，创建独立 session 锁。
- `running`：心跳/步骤事件；UI窗口实时更新。
- `done/failed/cancelled`：
  - `finish()` 更新 DB 状态；
  - 从 `activeRuns` 删除；
  - 释放 session 锁和并发槽；
  - 清理临时子会话工作目录；
  - UI 标记“已注销”，保留折叠卡片和最终摘要。
- 父 run 取消时级联取消所有子 run；子 run 不能继续发事件。
- 运行台最多同时展示 N 个活动窗口（建议 4），更多折叠为队列；完成窗口自动降权。

## 6. 事件协议

### 6.1 SSE 事件

新增 `agent` 事件，不混入父回答正文：

```ts
type AgentChildEvent = {
  type: 'agent'
  action: 'spawn' | 'assign' | 'content' | 'tool' | 'tool_result' | 'report' | 'done'
  parentRunId: string
  runId: string
  agentId: string
  index: number
  title: string
  modelId?: string
  modelName?: string
  modelReason?: string
  status?: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unregistered'
  text?: string
  tool?: { id: string; name: string; toolId: string }
  summary?: string
  durationMs?: number
  toolCount?: number
  error?: string
}
```

规则：

- 子 Agent 的 `content` 只进入子窗口，不进入父回答气泡。
- 子 Agent 的 `tool` 与 `tool_result` 只进入对应子窗口。
- `done` 必须最后发送一次，携带最终状态和资源释放标记。
- 每个事件带 `runId`，前端按 `runId` 做幂等更新。
- 事件只推给同一 `companyId + userId + sessionId` 的连接。

### 6.2 持久化

第一阶段沿用：

- `agent_runs`：父子关系、agent_id、model_id、status、耗时。
- `agent_steps`：工具步骤、状态、摘要、耗时。

建议后续迁移：

- `agent_runs.model_reason`：模型分配原因。
- `agent_messages`：父子对话/汇报，支持回看。
- `agent_runs.result_summary`：子 Agent 最终摘要，避免只存在 UI 内存。

## 7. 前端布局与视觉

### 7.1 结构

```text
chat-main
├── chat-thread（左：对话）
├── file-split-resizer
└── workbench-rail（右栏）
    ├── agent-dock（顶部：父 Agent + 子 Agent 窗口）
    └── file-pane（下部：预览；无预览时不存在）
```

- 右栏只在 `agent-dock` 或 `file-pane` 至少一个可见时出现。
- 没有子 Agent 时，`agent-dock` 完全隐藏，不显示空标题或空卡片。
- 没有预览时，`file-pane` 完全隐藏，右栏自动让位给对话。
- 宽屏右栏约占 44%–52%，可拖拽；窄屏改为上下堆叠，预览可全屏。

### 7.2 Agent 窗口

每个子 Agent 一个窗口：

```text
┌──────────────────────────────┐
│ 02  资料检索 Agent   ● 运行中 │
│ 模型：Qwen3.8-27B · 能力匹配  │
├──────────────────────────────┤
│ 父 Agent：查 2024 年制度文件  │
│ ✓ 检索知识库       120ms     │
│ ✓ 读取 3 个文档     2.1s      │
│ ◐ 汇总差异…                  │
│                              │
│ 最新输出：已找到 3 份相关制度 │
└──────────────────────────────┘
```

- 运行中：青色脉冲点、进度条、正在执行的工具名。
- 完成：状态改为“已注销”，卡片降权，保留结果摘要。
- 失败：红色状态和错误摘要，可重试按钮。
- 窗口数超过 4 个时使用可滚动网格；不无限挤压对话区。
- 键盘可聚焦每个窗口，`Enter` 展开详情，`Esc` 收起。
- `prefers-reduced-motion` 下关闭脉冲和扫光，只保留状态文字。

### 7.3 视觉语言

- 底色：石墨黑/深灰，不使用大面积紫色渐变。
- 强调：电光青表示运行，琥珀表示等待/需要关注，红色表示失败。
- 父 Agent 使用一条细的“任务总线”连接子窗口，传达派发关系。
- 预览区保持现有浅色 OnlyOffice 风格，与运行台形成“控制台 / 工作区”对比。
- 信息层级优先：当前任务 > 子 Agent 状态 > 工具步骤 > 折叠历史。

## 8. API 与代码落点

### 8.1 服务端

| 文件 | 改动 |
|---|---|
| `packages/server/src/routes/chat.ts` | `agent` 事件类型；`spawnSubAgents` 透传 emit；自动模型选择；子窗口事件映射 |
| `packages/server/src/agent-runtime.ts` | 子 run 生命周期、资源释放、完成回调；可选持久化扩展 |
| `packages/server/src/onlyoffice.ts` | 注入 `editorConfig.plugins`、插件 token、预览能力 |
| `packages/server/src/routes/workspace.ts` | `preview-capability`、插件桥接、Agent 文档命令审计 |
| `packages/server/src/model-registry.ts` / `model-health.ts` | 复用能力、健康、优先级；不另造白名单 |

### 8.2 前端

| 文件 | 改动 |
|---|---|
| `packages/server/public/chat.html` | 右栏 `workbench-rail`、`agent-dock`、预览栏结构 |
| `packages/server/public/chat.js` | `agent` 事件 reducer、子窗口渲染、预览能力判断、无预览隐藏 |
| `packages/server/public/chat.css` | 运行台、窗口、状态、响应式、reduced-motion |
| `packages/server/public/onlyoffice/eab-agent/*` | 插件 manifest、页面、脚本、样式 |

## 9. 分期实施

### P0 设计（本次）

- 本文档。
- 确认“全覆盖”的三层边界和预览能力矩阵。
- 确认父 Agent = 会话级、子 Agent = 回合级、完成后注销但保留审计。

### P1 可观察多 Agent（本次先落）

- 后端 `agent` SSE 事件。
- 子 Agent 自动模型选择与分配原因。
- 前端右栏 `agent-dock`：父派发、子窗口、工具步骤、汇报、注销状态。
- 无子 Agent 不显示运行台。
- 测试：一个父任务派生两个子 Agent，事件顺序与窗口数据正确。

### P2 预览栏与降级预览

- `previewCapability` 接口。
- 无预览隐藏、有预览展示。
- 文本/图片/PDF 的选区、diff、标注基础能力。
- 预览与 Agent 窗口共用右栏，互不挤占。

### P3 OnlyOffice 插件

已落地（2026-11-13 实测）：

- 插件 manifest + 页面 + 脚本；`editorConfig.plugins.autostart/pluginsData` 注入，插件页经短期 `plugin` token 绑定文件、用户和模式。
- `plugins.js` 启动时会不带 token 请求 `./config.json`，服务端该分支返回不含文档令牌的公共插件元数据，SDK 才会发出 `initialize` 并触发插件 `init`。
- 插件配置 URL 必须以 `config.json` 结尾，插件入口/图标使用相对路径，避免 OnlyOffice 覆盖 `baseUrl` 后拼出双 URL。
- `Asc.plugin.callCommand` 在当前 OnlyOffice 10 / 插件 SDK 中是 **4 参数** `(func, isClose, isCalc, callback)`；回调必须放第四个参数，第三个参数传 `false`。只读和编辑模式均已实测返回：`顶层元素 3 个；首段：附件3`。
- `office.read_outline`：服务端解析 docx 的 OOXML，返回段落/标题/表格、稳定 ID、表格行列与预览，不需要打开编辑器；xlsx 返回工作表、`sN`、单元格 `sN-rN-cN` 与文本；pptx 返回 `kind:"pptx"`、`slideCount` 和 `slides[].paragraphs[]`（`sN-pM`），当前支持 `ppt/slides/slideN.xml` 的段落文本。
- `office.find`：按文本或正则搜索 docx 段落和表格单元格，返回 `pN` / `tN-rN-cN` ID、命中区间和上下文；xlsx 分支按工作表单元格文本查找并返回 `sN-rN-cN`；pptx 分支返回 `kind:"pptx"`、`sN-pM`、`start/end` 与上下文。
- `office.replace`：按 `elementId` 只替换指定段落或单元格内的目标文本；支持 `oldText` 精确匹配、`occurrence=0` 全部替换、空单元格插入。命中多处且未指定 occurrence 时拒绝写入，避免误改；保存走个人配额并记 `workspace.file.agent_edit` 审计。xlsx 支持 `sN-rN-cN`，空单元格会创建 sheetData 行/列，不改公式与共享字符串结构；pptx 支持 `sN-pM` 跨 run 文本替换，新文本沿用首个命中 run 的格式，未命中的 run 和 `a:rPr` 不变，`occurrence=0`、段落内换行和非法段落 ID 明确返回 400。
- `office.insert`：在指定段落、表格或表格单元格的前/后插入新段落，沿用目标段落的段落样式；支持换行和制表符。单元格内插入时，`before` 落在 `tcPr` 之后，`after` 落在 `</w:tc>` 之前，新段落沿用单元格首个段落的 `pPr`，不会把内容写到表格外。docx 表格 `tN-rN`/`tN-cN` 支持插入整行/整列并克隆目标行/列样式。xlsx 支持 `elementId=workbook` + `text=新表名` 追加工作表，以及 `action=delete` + `elementId=sN` 删除工作表；删除至少保留一个表，其他表公式或 definedName 引用目标表时拒绝。`action=delete` 删除行/列：行删除支持 `gridSpan/vMerge/hMerge`，目标行是 `vMerge=restart` 锚点时把锚点内容和 `restart` 迁移到下一行 continuation；列删除按 grid 列找到覆盖该列的 cell，跨列 cell 缩减 `gridSpan`，单列 cell 移除，旧式 `hMerge` 拒绝。`action=merge` 用 `tN-rA-cA:tN-rB-cB` 合并无合并表的矩形区域，除左上角外有文本时拒绝；`action=split` 用 `tN` 把整表按 `gridSpan` 展开为 grid cell，文本保留在首 cell。插入列、插入含 `vMerge` 的行、已合并表再 `merge` 前需先 `split`；拆分大跨度横向合并会改变版式；pptx 结构变更暂不支持。
- `office.format`：按 `pN` / `tN-rN-cN` 设置目标段落的字符格式，支持加粗、斜体、下划线、字体颜色（6 位十六进制）、高亮和字号（磅）；可传 `false` / `none` 清除。只改目标的文本 run 和段落标记，其余段落、表格结构和未指定格式保持不变。xlsx 支持 `sN-rN-cN` 单元格样式，以及 `sN-cN`/`sN-c2:c4` + `columnWidth` 列宽、`sN-rN`/`sN-r2:r4` + `rowHeight` 行高；列宽 0–255、行高 0–409，尺寸与单元格样式不能同调。
- `office.comment`：按 `pN` / `tN-rN-cN` 添加批注，支持 `action=add/list/reply/resolve/delete`，默认 `add` 兼容旧调用；`add` 可传 `oldText` + `occurrence` 或 `start/end`，短语落在 run 中间时拆成左/中/右三个 run，`commentRangeStart/End` 只包住目标片段；不传范围时批注覆盖整个目标元素（单元格取首段到末段）。自动创建或复用 `word/comments.xml`，补齐 comments/commentsExtended/commentsIds 关系和 `[Content_Types].xml` Override；根批注与回复写入 `w14:paraId`、`w15:paraIdParent`、`w16cid:durableId`。`reply` 在父 `commentReference` run 后插入零宽锚点；`resolve` 只写 `commentsExtended` 的 `w15:done`；`delete` 按 `w15:paraIdParent` 级联删除根和子树并清理正文 range/reference。工具返回 `commentId/replyId/deletedIds`，`list` 不写盘。默认作者 `EAB Agent`。xlsx 单元格批注仍不支持，工具会明确拒绝，不能复用 docx 的 `comments.xml` 模型。
- 单元格定位修复：表格单元格原来只返回相对行内的 XML 偏移，写入时会落到 body 开头；现已换算为文档绝对偏移 `table.start + row.start + cell.start`，`replace` / `format` / `comment` / `insert` 共用该定位。
- 插件定位：侧栏输入文本后调用 `Api.GetDocument().Search`，对首个命中执行 `Range.Select()`，日志回显页码、命中数量和内容；未命中、SDK 未就绪、5 秒无回调都会恢复按钮并给出错误提示。
- 插件注入按编辑器分流（S11/S13）：`buildOfficePluginConfig` 的 `editorTypes` 支持单个或数组，无 token 元数据默认声明 `word`/`cell`/`slide`，带 token 的 config 按实际文件类型返回 `EditorsSupport:["cell"]`、`["word"]` 或 `["slide"]`；`workspace.ts` 对 docx/xlsx/pptx 都生成 `pluginConfigUrl`，`/onlyoffice-plugin/config.json` 的 `editorType` 使用 `documentType || 'word'`，不再把 slide 落到 word。插件上下文返回 `documentType`，插件页用 `applyEditorMode()` 分流：docx 显示 REVISIONS/高亮，xlsx 隐藏这些并显示 WORKSHEET，pptx 隐藏修订/高亮和 cell 区并显示 `PRESENTATION`。`readWorksheet()` 读取 `Api.GetActiveSheet()` 的 `A1:F12`，返回工作表名、行列、非空格数和前 3 行预览；`locateCell()` 在前 20×8 区域按 `A1`…`H20` 扫描 `GetValue()` 并 `Select()`；`replaceSelectedCell()` 只在编辑模式对已选中地址 `SetValue()`，只读拒绝。`readPresentation()` 用 `Api.GetPresentation()`、`GetAllSlides()`、`GetAllShapes()`、`shape.GetContent().GetText()` 读取页数、形状数和各页前 4 段文本；`locateSlideText()` 逐页逐形状匹配，优先 `GoToSlide`，当前构建无该方法时回退 `ApiSlide.Select()`，再 `shape.Select(true)` 选中。真实 HTTP 已验证无 token `["word","cell","slide"]`、xlsx 令牌 `["cell"]`、docx 令牌 `["word"]`、pptx 令牌 `["slide"]` 与 context `documentType:"slide"`；真实浏览器插件面板与读取/查找/替换均已验收，见下方 S11/S13 验收段。
- 插件高亮：只在 `context.canEdit` 的编辑模式启用；对 `Search` 返回的全部命中逐个执行 `Range.SetHighlight("yellow")`，汇总跨页页码、命中数和实际标记数，并选中首个命中。只改编辑器内格式，编辑过程中不立即回写；可点“保存到云空间”立即强制保存，关闭预览时 OnlyOffice 也会触发保存回调；只读模式按钮禁用并给出提示。
- 强制保存：`POST /api/workspace/office/plugin/force-save` 只接受 `kind=plugin`、`mode=edit`、文件本人的插件 token；用 token 里的 `version` 计算编辑器 key，调用 OnlyOffice `/command` 的 `forcesave`，JWT 负载为 `{c:"forcesave",key}`。`error=4` 返回 `no_changes`；回调写回 `updated_at` 后返回 `saved`；4 秒未写回返回 `pending`，不把“命令已接受”当成“已落盘”。
- 插件保存按钮：编辑模式启用，只读模式禁用；请求期间禁用按钮，成功后日志显示版本和字节数，无修改显示“没有需要保存的修改”，失败进入错误状态并恢复按钮。

2026-11-13 真实 HTTP 验收（临时副本 `office-p3-test2.docx`，fileId `01M7AGYRSEM53RTH6Z6GAF92PB`，操作后已软删）：

- `office.format`：`p2` 加粗 + `FF0000` + 黄色高亮 + 12 磅，返回 `kind=paragraph`、`runCount=1`、version `1794575925826`、operationId `op_01M7AGZ0H5Y0VY9FCM37SRRK84`；读回 XML 只有 `p2`（段落标记 + 文本 run）带新格式，`p1` 无加粗。
- `office.comment`：`p1` 添加 `验收批注：请核对附件编号`，作者 `EAB 验收`，返回 `commentId=1`、version `1794575925846`、operationId `op_01M7AGZ0JA313J728A12BGYV2R`；读回 `comments.xml`、comments 关系、content type 和 `p1` 的 range/reference 均存在，批注文本与作者一致。
- `office.insert`：`t1-r2-c2` 后插入 `单元格插入验收`，返回 `kind=table_cell`、version `1794575925865`、operationId `op_01M7AGZ0K1NR4X3N5X2H8W9J9D`；读回该单元格文本为 `单元格插入验收`，`p1` 仍为 `附件三`，插入段落位于 `<w:tbl>` 内、`p1` 与 `p2` 之间。
- 主文档 `OnlyOffice测试.docx` 未改动，仍为 version `1794574412139`、`p1=附件三`；两份临时副本已 `workspace.delete` 软删（`recycled:true`）。
- 审计：`workspace.file.agent_edit` 分别记录 `source=office.format` / `office.comment` / `office.insert`，elementId `p2` / `p1` / `t1-r2-c2`，size 13906 / 14361 / 14394。
- 插件高亮：临时副本 `office-highlight-test.docx`（fileId `01M7AJRGKMKXTM354QSJ8NSPT7`）在只读模式按钮禁用；切换编辑模式后按钮启用，输入 `附件三`、命中 1 处、第 1 页、标记 1 处，编辑器页面 `附件三` 显示黄色高亮；日志为“已高亮全部命中 / 第 1 页 · 命中 1 处，已标记 1 处。只改编辑器内格式；关闭预览时由 OnlyOffice 保存回调回写云空间，未关闭前可用撤销恢复。”。
- 关闭预览时保存：`office-save-test.docx`（fileId `01M7AK84Y5QFX7Y7YR66XR9Q03`）在编辑模式高亮 `附件三` 后关闭预览并等待，DB `updated_at` 从 `1794578322373` 变为 `1794578382463`，文件 size 从 13869 变为 31130；`word/document.xml` 中 `<w:highlight>` 数量为 1，`p1=附件三` 的 highlight 为 `yellow`，`p2` 无高亮。说明编辑过程中不回写，但关闭编辑器会触发 OnlyOffice 保存回调并持久化。
- `editorSync` 查看态刷新：`office-sync-test.docx`（fileId `01M7AKEP4NCSH6AZPY1ZCF5DBG`）直接调用 `office.format` 把 `p1` 加粗红色、`p2` 斜体，DB version 更新为 `1794578647331`、size 13895；前端 `refreshWorkspaceAfterFileOperation` 重新读取文件列表后，`state.filePreview` 的 `updatedAt/size` 同步为新值并重新打开预览。编辑模式调用同一刷新时只出现警告条“文档已在云端更新…请先保存或撤销后重新打开”，不刷新编辑器，`updatedAt` 保持 `1794578647331`。
- 副本清理：`office-highlight-test.docx`、`office-save-test.docx`、`office-sync-test.docx` 均已 `workspace.delete` 软删（`recycled:true`）；主文档 `OnlyOffice测试.docx` 未改动，仍为 version `1794574412139`、size 13869、`p1=附件三`。
- 强制保存（S1）：临时副本 `office-force-save-test.docx`（fileId `01M7ANDKYWESFPY865KMM9AN0J`）在真实 OnlyOffice 编辑器中打开，编辑器 key `74a69410aa3414b9bbbcb370`。无修改调用返回 `no_changes`（`error=4`）；通过 `Asc.plugin.callCommand` 写入 `EAB-S1-SAVE-20261113-2241` 后调用返回 `saved`，`updatedAt` `1794580598748` → `1794580853951`，size `13869` → `31140`，`word/document.xml` 含该测试文字。
- 插件保存按钮（S2）：编辑模式 `#save` 初始可用；再写入 `EAB-S2-BUTTON-20261113-2246` 并点击按钮，日志“已保存到云空间 · 版本 1794580925841 · 31156 字节”，size 变为 `31156`，`word/document.xml` 同时含两段测试文字；无修改时点击日志“没有需要保存的修改”；切到只读模式后按钮 `disabled=true`。
- 拒绝路径：无 token、非法 token 均返回 403“OnlyOffice 插件令牌无效或已过期”；只读插件 token 返回 403“只读模式不能保存”，且未产生写回。
- 命令失败路径：未打开编辑器的临时副本 `office-force-fail-test.docx`（fileId `01M7AP33MK7TDKC750W3YQWPCG`）调用返回 HTTP 409“OnlyOffice 找不到当前编辑会话”，文件 `updatedAt/size` 保持 `1794581302930/13869`；审计记为 `failure`，`error=1`。
- 审计：`workspace.file.force_save` 记录 `saved` / `no_changes`，detail 含 `relPath`、`key`、`state`、`updatedAt`、`size`。
- 编辑态版本同步（S3）：临时副本 `office-s3-test.docx` 在编辑态收到云端更新后显示持久警告条；取消二次确认保持原编辑器，确认后重开新版本。旧会话有 `STALE-OLD-004` 未保存修改、云端为 `...004` 时刷新，`refresh-guard` 记录 `cutoff=1794587163242`，旧回调 `payloadVersion=1794587015091` 被丢弃，审计 `workspace.file.office_stale_callback`；刷新后云端仍为 `...004`，新编辑器不含旧标记。
- 插件 token 恢复（S4）：云端更新到 `...007` 后插件上下文返回 409，显示“版本已更新”和“重新打开预览”；点击后重开编辑器，预览头更新到 `2026/11/14 00:44:05`，插件恢复“已连接”，内容为 `...009`。无效 token 直接打开插件页返回 403 并显示“令牌已过期”。旧编辑器对云端新版本调用 force-save 返回 409，云端保持 `...008` 未被覆盖。
- xlsx 插件注入（S11）：`格式测试.xlsx`（fileId `01M7TESTFORMAT0000000001`）在真实 OnlyOffice 表格编辑器中加载，插件 iframe URL 为 `http://192.168.1.13:8787/onlyoffice-plugin/index.html?token=...`。只读态 `status=已连接`、标签 `只读`、`cell-section` 可见、`review-section` 隐藏；点“读取工作表”返回 `隐患台账 · 12×6`、`A1:F12`、非空 4 格，预览含 `项目 | 10`、`负责人 | 何益`；输入 `何益` 后 `cell-summary=已选中 B2`、日志 `B2 · 何益`，“替换选中”保持禁用。切编辑态后标签 `可编辑`，选中 `B2`、输入 `验收替换值`、点“替换选中”，日志 `B2 → 验收替换值；保存或关闭预览后回写云空间`；再次读取工作表显示 `负责人 | 验收替换值`。直接关闭预览不保存，云端文件 SHA256 仍为 `6289B5960D398B6385913D15E0A5248E3765C9D24D7F17D2F1A7A9AE9024F61F`、size 2555、mtime `2026-11-13T22:58:44`，证明替换只发生在编辑器内存。xlsx→PDF 转换 `S11-xlsx.pdf` 219015 字节，第 1 页可见 `项目`、`负责人`、`何益`。
- xlsx 保存同步（S12b）：临时副本 `S12b保存验收.xlsx`（fileId `01M7CC6K3QCRNP5NBPN1NWXHEG`）在编辑态把 B1 替换为 `S12b最终值`，点“保存到云空间”后 HTTP `force_save state=saved`，`updatedAt=1794638449504`、size 8508；父页收到 `eab:onlyoffice:saved` 后先 `refresh-guard`，再自动以 `mode=view` 重开，预览头显示 `2026/11/14 14:40:49`，新插件以只读读回 `项目 | S12b最终值`。关闭旧编辑器的回调 `payloadVersion=1794638298917` 低于 `cutoff=1794638449504`，审计记为 `workspace.file.office_stale_callback` 并丢弃，最终 `updatedAt` 未被二次抬高。保存按钮路径补了 900ms 同步等待和 `no_changes` 重试，因为 `SetValue` 后立即 `force-save` 会因协同会话尚未登记修改返回 `error=4`。
- xlsx 结构与尺寸（S12-L3/L4）：真实副本 `S12c结构验收2.xlsx`（fileId `01M7CDYD1A81S7AF396A41GW00`）通过 `office.insert` 追加 `新增验收表`（`s2`、2 表），`office.replace` 写 `s2-r1-c1=结构验收`，`office.format` 设 `s2-c1` 列宽 22、`s2-r1` 行高 30，`office.read_outline` 读回 s2 A1；随后 `office.insert(action=delete,elementId=s2)` 返回 `remainingSheets=1`，原「隐患台账」4 格内容不变。副本 `S12c结构验收4.xlsx`（fileId `01M7CE0N1VC5D42XVSBSD6FH6G`）的 `sheet2.xml` 为 `<cols><col width="22" customWidth="1" min="1" max="1"/></cols>` 和 `<row r="1" ht="30" customHeight="1"><c r="A1" t="inlineStr"><is><t>结构验收</t></is></c></row>`；workbook 的 `r:id="rId5"`、rels 的 `worksheets/sheet2.xml`、Content Types override 齐全；OnlyOffice `ConvertService.ashx` 返回 `Percent=100/EndConvert=True`，PDF 221159 字节。审计逐条记录 `workspace.file.agent_edit` 的 `source=office.insert/office.replace/office.format`，`applied` 分别为 `columnWidth` 和 `rowHeight`。新增工作表最初写成 `<sheetData/>` 导致 `office.replace` 报“缺少 sheetData”，已改为成对标签并补回归测试。
- xlsx 结构硬化（2026-11-14）：`office.format` 现在拒绝列号 >16384、行号 >1048576、单次行高范围 >20000 行；真实副本 `S12c硬化验收3.xlsx`（fileId `01M7CFH0S9VXTNGM9M3H4C86YK`）对应调用均返回 400，正常列宽 22/行高 30、追加 `硬化验收表`（s2）与删除（`remainingSheets=1`）仍返回 200，最终 1 表、size 7242，原 4 格内容不变。`deleteXlsxSheet` 现在扫描 `<f>/<formula>/<formula1>/<formula2>`、definedName 和 `xl/charts|pivotTables|pivotCache` 的 `<c:f>`，并按其他工作表引用计数、仅对 comments/VML/drawing/table/pivotTable/printerSettings/threadedComment 类型清理目标表独占的关联部件；共享部件与 sharedStrings 保留。`office-content.test.ts` 当时 53 tests 全过，`pnpm typecheck` exit 0；随 S12-L6 批注用例增至 58 tests。
- xlsx 单元格批注（S12-L6，2026-11-14）：`office.comment` 现按 legacy comments + VML 模型支持 xlsx `add/list/delete`，不接受 `reply/resolve` 与 `oldText/start/end`。真实副本 `S12d批注验收.xlsx`（fileId `01M7CGAA1A3BY9E9MP1MW0X7S4`）初始列表 0 条；A1 新增返回 `commentId=1`、B2 新增返回 `commentId=2`，列表读回两条作者/正文；A1 重复新增返回 400「已有批注」；按 `elementId` 删除 A1 后 `remaining=1`，按 `commentId=1` 删除 B2 后 `remaining=0`；重建 B2 后列表 1 条，reply/resolve、oldText、`s1-c1` 均返回 400。重启服务加载最终代码后再次删除最后一条 B2：`remaining=0`、size 7527、列表 0 条，comments/VML 均被清理；重新 add B2 后 size 8572、列表 1 条，openpyxl 与 OnlyOffice 再次读回成功。最终文件 8572 字节，`office.read_outline` 四格内容不变。XML 含 `xl/comments/comment1.xml`、`xl/drawings/vmlDrawing1.vml`、sheet rels 与 Content Types `vml` Default/comments Override；`openpyxl.load_workbook` 读回 B2 批注“批注重建”、作者 `EAB Agent`，A1 无批注。OnlyOffice `ConvertService.ashx` 返回 `Percent=100/EndConvert=True`，PDF 221152 字节。成功 add/delete 均记 `workspace.file.agent_edit`，`source=office.comment`，失败路径无文件写入审计。`office-content.test.ts` 58 tests 全过，`pnpm typecheck` exit 0；其中新增用例覆盖“删最后一条批注但 VML 仍含按钮等非批注形状时保留 VML 与关系”的边界。
- pptx 插件注入（S13，2026-11-14）：`S13pptx验收2.pptx`（fileId `01M7CHH1132APQ7XFPRZQ9SMMM`）的 `office-config` 返回 `documentType:"slide"`，`editorConfig.plugins.pluginsData[0]` 为带 `plugin` token 的绝对 `/onlyoffice-plugin/config.json` 地址；token config 返回 `EditorsSupport:["slide"]`，context 返回 `documentType:"slide"`。真实 OnlyOffice 演示编辑器中插件 iframe 正常连接，右侧显示 `PRESENTATION`、`读取幻灯片`、`查找并选中`；xlsx 分支仍保持 `cell`，docx 保持 `word`。
- pptx 插件读取/定位（S13，2026-11-14）：点“读取幻灯片”返回 `1 页 · 2 个形状 · 2 个文本形状`，日志列出 `EAB 项目方案 / •这是PPTX 真实验收 •第二段保持原样`；输入 `PPTX 真实验收` 后返回 `已选中第 1 页 · 形状 2`、日志 `已跳转 · 已选中形状`。当前 OnlyOffice 构建没有 `Api.GoToSlide` 和 `presentation.GoToSlide`，已回退 `ApiSlide.Select()`；`ApiSlide.Select()` 实测可切换当前页，形状 `Select(true)` 可选中。
- pptx 内容工具（S14，2026-11-14）：`office.read_outline` 返回 `kind:"pptx"`、`slideCount:1`、`s1-p1/s1-p2/s1-p3`；`office.find query=真实链路验收` 命中 `s1-p2`、`start=2/end=8`、`context=这是【真实链路验收】`；`office.replace elementId=s1-p2, oldText=真实链路验收, newText=PPTX 真实验收` 返回 `previousText=这是真实链路验收`、`nextText=这是PPTX 真实验收`、`replacements=1`、`wrote:true/saved:true`，version `1794643624995 → 1794643625176`、size 28812。替换后 `find` 与 `read_outline` 均读回新文本，`s1-p1/s1-p3` 不变。`occurrence=0`、段落内换行、`s1-p99` 均返回 400，文件未变。
- pptx 包与 PDF（S14，2026-11-14）：解压对比仅有 `ppt/slides/slide1.xml` 变化（1065→1064 字节），无新增/删除部件；`p2` 仍为两个 run，`这是` 保留 `b=1`，新文本沿用第二个 run 的无格式，`p1`/`p3` 原样。OnlyOffice `ConvertService.ashx` 返回 `Percent=100/EndConvert=True`，`S13-pptx.pdf` 80323 字节，第 1 页可见加粗 `这是` + 常规 `PPTX 真实验收`。
- pptx 审计（S14，2026-11-14）：`workspace.file.agent_edit` 记录 `source=office.replace`、`elementId=s1-p2`、`replacements=1`、`size=28812`；被拒绝的 400 路径未产生文件写入审计。`office-content.test.ts` 58、`onlyoffice.test.ts` 11、`onlyoffice-plugin.test.ts` 4，合计 73 定向测试通过；`pnpm test` 107 文件 / 624 测试通过；`pnpm typecheck` exit 0。
- 回归（S13/S14）：`pnpm test` 107 文件 / 624 测试通过；`pnpm typecheck` exit 0；`node --check packages/server/public/onlyoffice-plugin/plugin.js` exit 0；`/api/health` 返回 `ok:true`、`sqlite/postgres-audit/postgres-chat` ready。
- 修订（S5）：临时副本 `S5修订验收.docx`（fileId `01M7BYYY0T9S52HAX3MK9D8KKH`）在干净 13869 字节文件上执行 `office.find` + `office.replace(trackChanges=true, author=S5验收)`，审计 `seq=774 workspace.file.agent_edit`，结果 size 13971、`nextText=附件四`；解压 XML 为 1 个 `w:del`（`w:delText=附件三`）+ 1 个 `w:ins`（`w:t=附件四`）。真实 OnlyOffice 编辑器显示“附件三”删除线 + “附件四”下划线；插件“读取修订”返回 `2 处 · 1 位作者`（TextRem 附件三、TextAdd 附件四），“接受全部”后正文为附件四、修订归零，“拒绝全部”后正文为附件三、修订归零。接受/拒绝使用 `executeMethod` 无回调，操作后物理文件 SHA256 仍为 `B5EC2EE972073C233992BA2745F8FF1CAE1FD88D0C6D219F27CF1720D30929D2`，主文档未改动。
- 副本清理（S5）：`S5修订验收.docx`（fileId `01M7BYYY0T9S52HAX3MK9D8KKH`）已用 `deleteUserWorkspaceFile` 软删（与 `workspace.delete` 同一语义），`deleted_at=1794627334684`，文件移入 `_recycle/01M7BYYY0T9S52HAX3MK9D8KKH-S5修订验收.docx`；主文档 `OnlyOffice测试.docx` 保持 SHA256 `27B7B286571BE64C7B87B8331DD7F57F0F514B8AD5D8C7F85F511F005A9ADE70`、size 13869 未改动。
- 批注（S6）：真实副本 `S6批注验收.docx` 在 `p2` 用 `oldText=通知开放信号` 新增批注，返回 `commentId=1/start=9/end=15`；回复得到 `commentId=2`、`threadRootId=1/replyCount=1`；解决根批注后 `commentsExtended` 为 `w15:done="1"`，回复仍为 `0`；删除根批注返回 `deletedIds=[1,2]`，正文 range/reference 归零。删除副本 14751 字节，3 个顶层元素文本与源一致；OnlyOffice 转换 PDF 260551 字节，第 3 页保留“通知开放信号”，PDF 不渲染批注气泡。
- 表格删除（S7）：以真实 `OnlyOffice测试.docx` 样式页为外壳生成 3×3 无合并夹具 `S7表格删除源.docx`，删除 `t1-r2` 后 2×3、再删除 `t1-c2` 后 2×2；剩余单元格为“检查项目/检查结果”“消防设施/合格”，`p1`/`p2` 文本不变，输出 10581 字节。OnlyOffice 转换返回 `Percent=100/EndConvert=True`，PDF 222821 字节，第 1 页为 2×2 表格并保留表格前后正文。
- 合并表结构变更（S7）：真实 `OnlyOffice测试.docx` 为 16 行 / 9 个 `gridCol`，含 `gridSpan` 与多组 `vMerge`，源 SHA256 `27B7B286571BE64C7B87B8331DD7F57F0F514B8AD5D8C7F85F511F005A9ADE70` 验收后未变。直接删除 `t1-r2` 得到 `remainingRows=15/remainingColumns=9`，原 row2 的“作业地点/天窗调度命令正式”内容迁到原 row3，并变为 `restart`；直接删除 `t1-c8` 得到 `16/8`，第 8 个 gridCol 覆盖的 cell 缩减 span 或移除；再删除 `t1-r15` 得到 `15/8`，每行 span 合计 8。`readDocxOutline` 对合并表按每行实际 cell 数显示 7 列，`remainingColumns` 是 grid 列数，两者不相等。
- 合并表 PDF：直接删列输出 `S7-merged-direct.pdf` 260251 字节，直接删行输出 `S7-merged-row.pdf` 260309 字节；PDF 第 2 页表格仍为 8/9 网格，标题、作业地点、天窗调度命令、命令号、填写说明均在，没有空白锚点块或竖排标题。
- 合并表真实 HTTP：临时员工会话 + 临时 `workspace_files` 行调用 `POST /api/tools/office.insert/invoke`，`delete t1-c8` 与 `delete t1-r15` 均返回 200，结果 `16/8`、`15/8`，文件 13869→13871→13765 字节；审计 `workspace.file.agent_edit` 记录 `source=office.insert`、`elementId=t1-c8/t1-r15`、`size=13871/13765`（seq 882/884）。`S7-http-final.pdf` 260257 字节，第 2 页与直接删除一致。
- 拆分/合并边界（S7）：对 row1 `gridSpan=9` 整行标题执行 `split` 后，标题会被压进第 1 个窄 grid cell，PDF 出现竖排标题和表格错位；因此真实合并表优先直接删行/删列，`split` 只作为列插入、含 vMerge 行插入或再 merge 的显式归一化，并会改变横向合并版式。矩形 `merge` 只允许整表无合并且除左上角外无文本；3×2→split 3×3→merge 2 cell→split 回 4 cell 已由单测覆盖。
- 回归（S6/S7）：`pnpm typecheck` exit 0；`pnpm test` 103 个测试文件 / 577 个测试全部通过；`office-content.test.ts` 50 tests、`office-comment-tool.test.ts` 1 test、`office-table-tool.test.ts` 2 tests 通过；8787 热重载后 `/api/health` 为 `ok:true`、`devAuth:false`。
- 副本清理（S3/S4）：`office-s3-test.docx`（fileId `01M7ATCP2K7WKHWCRMNBMNF6R6`）已 `workspace.delete` 软删，`deleted_at=1794588388132`；主文档 `OnlyOffice测试.docx` 未改动，仍为 version `1794574412139`、size 13869。
- 已知边界：`refresh-guard` 的 cutoff 存放在进程内 Map，服务重启会丢失；旧编辑器在重启后关闭时，保存回调仍可能覆盖云端。插件 force-save 已校验版本，回调侧的持久化水位留 S16。
- 修订边界（S5）：目标段落已有 `w:ins/w:del` 时拒绝再写；`occurrence=0` 和选中范围含 `<w:br>/<w:tab>` 拒绝；移动/格式修订不识别。编辑态下 Agent L1 写入与旧编辑器保存的覆盖关系未验证，建议先关闭编辑器再写入，冲突治理留 S16。
- 回归（S1/S2）：`pnpm test` 93 文件 / 504 测试通过；`pnpm typecheck` 通过；`node --check plugin.js` 与 `node --check chat.js` 通过。
- 回归（S3/S4）：`pnpm test` 95 文件 / 521 测试通过；`pnpm typecheck` 通过；`node --check plugin.js` 与 `node --check chat.js` 通过。
- 回归（S5）：`pnpm test` 95 文件 / 534 测试通过；`office-content.test.ts` 37 个通过；`pnpm typecheck` 通过；`node --check plugin.js` 通过。
- 副本清理（S1/S2）：`office-force-save-test.docx`、`office-force-fail-test.docx` 均已 `workspace.delete` 软删；主文档 `OnlyOffice测试.docx` 未改动，仍为 version `1794574412139`、size 13869。

待落地：

- `editorSync`：查看态已实现“服务端保存后自动重载文件列表和预览”；编辑态已实现持久警告条和“刷新到云端版本”，但不自动刷新。插件自己保存成功后先 `refresh-guard` 再自动切查看态；刷新、插件保存和旧回调都拒绝旧版本，stale callback 防覆盖已落地；跨设备冲突合并仍留在 S16。
- docx 表格结构：行/列插入与删除已落地；合并表删行会迁移 `vMerge` 锚点和内容，删列按 grid 缩减 span 或移除 cell；`action=merge` 只支持无合并表的矩形区域且除左上角外无文本，`action=split` 会把横向 span 展开并改变版式。列插入、含 `vMerge` 的行插入、已合并表再 merge 前仍需 split；xlsx 已支持行/列插入、工作表追加/删除、列宽/行高与 legacy 单元格批注 `add/list/delete`（含 Excel 行列上限、单次行高 20000 行上限、删除表独占关联部件清理与图表/透视公式引用拒绝）；xlsx threaded comments/persons 与批注 VML 自定义位置仍未落地。
- pptx 文本级插件与内容工具已验收；仍需补多页跳转、组合形状、图片/版式/新增幻灯片等结构编辑样本。xlsx 插件注入、真实浏览器读/替换、保存同步、工作表增删、列宽/行高与 legacy 单元格批注已验收；xlsx 数字/公式/合并单元格的替换与保存仍未验证；xlsx threaded comments/persons 未实现；xlsx 的服务端读取/查找/替换已具备。

### P4 全覆盖补齐

- xlsx / pptx 分支。
- 未覆盖 UI 功能的 GUI 兜底清单。
- 版本快照、撤销、冲突处理、审计完善。
- 分步实施计划、缺口优先级和每步验收口径见 `docs/onlyoffice-agent-workbench-implementation-plan.md`。

## 10. 验收标准

### 10.1 多 Agent

- 父 Agent 一次派发 2 个子 Agent，右侧出现 2 个独立窗口。
- 每个窗口能看到父 Agent 的任务、模型、工具步骤、最新输出和最终状态。
- 一个子 Agent 失败不影响另一个；失败窗口显示错误。
- 子 Agent 完成后 1 秒内状态变为“已注销”，`activeRuns` 数量回落。
- 取消父任务时所有子窗口变为取消，资源释放。
- 没有子 Agent 时运行台不占位。

### 10.2 预览

- 无预览文件：不出现空白右栏，对话占满。
- 文本：选中内容可引用修改，修改后可看到 diff 高亮。
- 图片/PDF：能打开预览，能进行对应的区域/文本操作；不支持的编辑明确提示。
- Office：OnlyOffice 编辑器打开，Agent 操作可定位、高亮、修订、保存。
- 删除文件或权限失效时预览自动关闭。

### 10.3 安全与审计

- 共享文件只读时 Agent 写命令被拒绝，且没有实际写入。
- 插件 token 过期、跨文件、跨用户均被拒绝。
- 每次 Agent 文档修改都有 operationId 和审计记录。
- 子 Agent 不能绕过模型可见性，不能使用未授权模型。

## 11. 已知风险

1. OnlyOffice 插件 API 的跨文档类型差异较大；xlsx/pptx 已分别验证基础面板与读取/定位，pptx 的 `GoToSlide` 在当前构建缺失、多页与组合形状仍需补样本。
2. 插件从 EAB 外链加载时，Document Server 必须能访问 `EAB_PUBLIC_URL`；否则需把插件打入容器卷。
3. 父子双向消息需要把 `agent.spawn` 从阻塞式改为可异步等待，会影响现有工具契约，放在第二阶段。
4. GUI 兜底受 Canvas 和布局影响，不能承诺稳定全覆盖。
5. 同一文档用户与 Agent 同时编辑时，必须依赖修订模式/范围锁/版本回滚，不能静默覆盖。
