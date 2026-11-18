# 对话附件进入个人云空间 + 消息卡片预览 + 云空间主动刷新

- 日期：2026-11-17
- 状态：设计稿，未实现
- 范围：网页工作台（`packages/server/public/chat.js`）与员工端服务端
- 约束：不改变 DSH 插件模型和对话循环改造；不新增模型调用；不引入高频全量轮询；不绕过个人云空间现有的配额、软删、回收站、版本和权限模型

## 1. 需求理解

用户要的是四个可观察结果，不是一个“把附件再存一份”的动作：

1. 网页对话发送的图片/文件，要成为该成员个人云空间里的真实文件，能在云空间列表里看到。
2. 历史消息里的附件卡片要读取这个云空间文件，图片显示缩略预览，文件显示文件卡，而不是只有“文件名 · 大小”文字 chip。
3. 文件从个人云空间删除后，对应消息卡片不再显示有效预览，改为“已被删除”的图标/状态。
4. 网页云空间列表随文件新增、删除、改名、Agent 写入而主动更新，不需要用户手动刷新。

明确不做的事：

- 不因为附件入库而增加一次模型调用，不把附件持久化塞进 `runAgentTurn` 的关键路径。
- 不为消息卡片逐文件请求 `preview-capability`，不在历史消息渲染时做 N+1 查询。
- 不新增一套 WebSocket/轮询基础设施；复用现有 `/api/chat/events` SSE。
- 不改变旧消息的现有展示；旧消息没有云空间文件 ID，无法反推出原图，保持文字 chip。
- 不改变“不使用文件空间”这一显式选择的语义。

## 2. 现状核对

### 2.1 个人云空间

- 文件真身在 `<workspacesDir>/<companyId>/<scopeType>-<scopeId>/<相对路径>`；未配置时跟随总存储位置，最后退回 `<db 同级>/workspaces`。
- 元数据表：`workspace_files`；共享表：`workspace_shares`；配额表：`storage_quotas`。
- 个人文件写入接口：`POST /api/workspace/files`，支持 `name/path/text/contentBase64/mime/baseVersion`，校验个人配额、公司配额，写磁盘并更新 `workspace_files`。
- 列表接口：`GET /api/workspace/files`，返回“本人所有未删除文件 + 有权限的共享文件”，按 `updated_at DESC` 排序。
- 删除是软删：`deleteUserWorkspaceFile()` 把文件移到 `_recycle/`，写 `deleted_at`，扣减配额，元数据保留。
- 预览能力：`GET /api/workspace/files/:id/preview-capability` 返回 `kind/mode/agentOps/reason`；图片、文本、Office、PDF 分别有预览类型。
- 下载：`GET /api/workspace/files/:id/download` 存在，但强制 `content-disposition: attachment`，不适合直接做消息卡片的缩略图。
- 现有 `workspace_files` 记录包含 `id/company_id/scope_type/scope_id/owner_user_id/rel_path/name/size/mime/storage_path/created_at/updated_at/deleted_at/recycled_path/archived_at`。

### 2.2 对话附件

- `POST /api/chat/messages` 的 `attachments` 每项字段是 `name/size/type/text/dataUrl`，单条最多 4 个。
- 图片只允许 `data:image/(png|jpeg|jpg|webp|gif);base64`，`dataUrl` 上限 14,000,000 字符；附件文本上限 5,000,000 字符。
- `ChatAttachmentInput` 只承载 `name/size/type/text/dataUrl/batchId/batchChars`。
- 文本超过 12,000 字符时，全文保存为文本批次，消息里只放前 12k 和批次提示。
- `attachmentMeta()` 会去掉 `dataUrl` 和 `text`，只持久化 `name/size/type/batchId/batchChars/chars/hasImage/readable`。
- 用户消息落库 `chat_messages.meta_json` 时写 `{ channel: 'web', attachments: attachmentMeta(attachments), space: {...} }`。
- 关键事实：附件链路完全没有把附件写入 `workspace_files`，消息里也没有云空间 `fileId`；`dataUrl` 不落库，所以旧图片消息无法从消息表重新取原图。

### 2.3 消息卡片

- 前端对话主文件是 `public/chat.js`。
- `appendMessage(role, text, meta, attachments, rich, options)` 负责渲染历史/实时消息。
- 用户消息气泡附件区域是 `<div class="bubble-files">${attachmentChips(attachments)}</div>`。
- `attachmentChips(list)` 只输出 `<span>文件名 · 大小 · 已接管</span>`；长文本批次额外输出批次卡。
- `.msg .bubble-files span` 只是小号文字 chip，没有图片缩略图、文件预览卡、删除态图标。

### 2.4 云空间刷新

- `loadWorkspaceFiles()` 同时请求 `/api/workspace/files` 与 `/api/workspace/quota`，然后 `renderWorkspaceFiles()`、`renderWorkspaceQuota()`。
- 调用点只有：页面初始化、上传完成后、部分本地文件操作、打开文件时找不到缓存、Office 刷新到云端版本等。
- 没有云空间列表的全局自动刷新，外部新增/删除/改名必须重新调用 `loadWorkspaceFiles()` 才能看到。
- 右侧预览有独立巡检：每 30 秒读一次 `preview-capability`，404/403 时关闭预览并提示“已被删除/权限失效”。这是预览面板，不是云空间列表，也不是消息卡片。

### 2.5 可复用实时通道

- `chat-events.ts` 已有进程内事件总线，配 Redis 时通过 Pub/Sub 跨实例广播。
- 现有事件类型：`message`、`delta`、`tool`、`subagent`、`models`。
- SSE 入口：`GET /api/chat/events`，`text/event-stream`，已用于把钉钉侧消息/增量/工具/子 Agent/模型目录变化同步到已打开网页。
- 因此云空间文件变化可以复用这条 SSE，只需要新增一个事件类型，不需要新建 WebSocket 或轮询服务。

## 3. 核心设计决策

| 编号 | 问题 | 决策 | 理由 |
|---|---|---|---|
| D1 | 附件是复制成云空间独立文件，还是引用消息附件对象 | 每个消息附件落成个人云空间里的独立文件，消息只保存 `workspaceFileId` | 复用现有 `workspace_files`、配额、软删、回收站、版本、权限与审计；删除语义以文件为准，消息不持有二进制 |
| D2 | 消息卡片预览怎么取图 | 新增受权限保护的图片预览端点，消息卡片用 `<img loading="lazy">` 指向该端点 | 不把大文件塞进 `meta_json`；不为每个附件请求 `preview-capability`；删除后端点直接 404，天然失效 |
| D3 | “已被删除”实时查询还是消息墓碑 | 以 `workspace_files.deleted_at` 和记录存在性为唯一事实来源；历史接口批量解析状态，SSE 增量更新 | 回收站清理、恢复、改名都可能改变状态；消息里写墓碑快照会过期。批量解析是一页一次查询，不是逐文件请求 |
| D4 | 云空间主动刷新用 SSE 还是轮询 | 主通道：SSE 新增 `workspace` 事件；兜底：SSE `ready` 重连后刷新一次、页面重新可见时刷新一次 | 只在文件真正变化时触发；前端 300ms 合并刷新；没有常驻高频全量轮询，不拖慢 EAB |
| D5 | 附件持久化失败是否阻断聊天 | 附件入云空间是“增强能力”，失败不阻断原消息发送；消息卡片明确显示“未保存到云空间” | 不改变原有“只发消息”的能力；配额、权限、网络异常时聊天仍可用 |
| D6 | 旧消息能否补预览 | 不补。旧消息没有 `workspaceFileId`，`dataUrl` 未落库，保持现有文字 chip | 没有可靠数据源，强行补需要重新上传或伪造缩略图，不能保证一致性 |

## 4. 数据与接口设计

### 4.1 消息附件元数据

新消息的 `chat_messages.meta_json.attachments[]` 在现有字段上扩展：

```json
{
  "name": "季度报告.pdf",
  "size": 1048576,
  "type": "application/pdf",
  "chars": 0,
  "hasImage": false,
  "readable": false,
  "workspaceFileId": "01J8Z8YQ6K5V4N3M2L1K0J9H8G",
  "workspaceRelPath": "对话附件/2026-11-17/8f3c2a1b/季度报告.pdf",
  "workspaceMime": "application/pdf"
}
```

- 保留现有 `name/size/type/chars/hasImage/readable/batchId/batchChars`，保证旧渲染和批次卡不受影响。
- 新增 `workspaceFileId`、`workspaceRelPath`、`workspaceMime`。`name/size/type` 改为以 `workspace_files` 实际值为准，避免客户端伪造。
- 不在消息里存 `previewUrl`、签名 URL、`dataUrl` 或缩略图二进制。URL 由前端按 `fileId` 拼，权限每次请求校验。
- 不新增数据库表、不新增列；只扩展现有 JSON 元数据，不需要迁移。

### 4.2 对话附件请求扩展

`ChatAttachmentInput` 增加一个可选字段：

```ts
export interface ChatAttachmentInput {
  name: string
  size: number
  type: string
  text?: string
  dataUrl?: string
  /** 已在个人云空间落盘的文件 ID；有值时服务端以该文件为准 */
  workspaceFileId?: string
  batchId?: string
  batchChars?: number
}
```

`POST /api/chat/messages` 的 `attachments` 允许每项带 `workspaceFileId`。服务端处理顺序：

1. 校验 `workspaceFileId` 属于当前公司、当前员工、`scope_type='user'`、`scope_id=当前用户`、`owner_user_id=当前用户`、`deleted_at IS NULL`。
2. 查到记录后，用 `workspace_files` 的 `name/size/mime` 覆盖客户端传来的 `name/size/type`。
3. 按文件类型读取模型需要的部分：
   - 文本类：读取 UTF-8 正文，沿用现有 `MAX_ATTACHMENT_TEXT=12_000` 截断和文本批次逻辑；超过 `MAX_ATTACHMENT_INPUT_CHARS` 直接拒绝。
   - 图片类：只对 `image/png|jpeg|webp|gif` 生成 `dataUrl` 供视觉模型使用；单文件超过 10MB 或 `dataUrl` 超过 14,000,000 字符则拒绝。
   - 其它文件：不读正文，只在提示词里说明“已保存到个人云空间”，让模型需要时用 `workspace.*` / `office.*` 工具读取。
4. 没有 `workspaceFileId` 的附件仍按现有 `text/dataUrl` 路径处理，旧调用方和降级路径不变。

服务端读取文件必须用异步 `readFile`，不要在这个高并发路由里对大文件做同步读；读取只发生一次，不进入模型多轮循环。

### 4.3 图片预览端点

新增：

```http
GET /api/workspace/files/:id/preview
```

行为：

- 鉴权：`resolveActor` + `WORKSPACE_READ`；只允许文件所有者或有共享权限的人；`deleted_at IS NULL` 且磁盘文件存在。
- 只服务栅格图片：`png/jpeg/webp/gif/avif/bmp`。`svg`、HTML、PDF、Office 不从这个端点内联返回，避免 XSS 和错误内联；这些文件点击后走现有预览面板。
- 响应头：
  - `content-type` 使用白名单 MIME，绝不直接透传用户可控 MIME；
  - `content-disposition: inline`；
  - `x-content-type-options: nosniff`；
  - `content-security-policy: default-src 'none'; sandbox`；
  - `cache-control: private, max-age=300`；
  - `etag: "<updated_at>-<size>"`。
- 不做逐次下载审计，避免历史消息滚动把审计表打满；真正的“打开文件”仍走现有预览面板和审计。
- 文件已删除/记录不存在返回 404；无权限返回 403；类型不支持返回 415。前端 `<img>` 的 `onerror` 按状态兜底。

### 4.4 附件状态批量查询

新增：

```http
POST /api/workspace/files/status
Body: { "ids": ["...", "..."] }
```

返回：

```json
{
  "items": [
    { "id": "01J...", "status": "active", "name": "季度报告.pdf", "mime": "application/pdf", "size": 1048576, "updatedAt": 1760000000000 },
    { "id": "01K...", "status": "deleted" }
  ]
}
```

状态定义：

- `active`：记录存在、`deleted_at IS NULL`、属于当前用户。
- `deleted`：记录存在但 `deleted_at` 非空，或回收站清理后记录已不存在。
- `forbidden`：记录存在但不属于当前用户，或没有共享权限。
- `missing`：记录存在但磁盘内容不存在（可选，仅在需要精确区分时返回）。

约束：

- 最多 200 个 ID；超过直接拒绝。
- 非本人文件只返回 `forbidden/missing`，不返回文件名、大小、路径，避免信息泄露。
- 单次 SQL `WHERE company_id=? AND id IN (...)`，不逐文件查询。

### 4.5 历史消息接口增强

`GET /api/chat/sessions/:id/messages` 返回前，对本页消息的 `meta.attachments` 做一次批量状态解析：

- 收集本页所有 `workspaceFileId`，去重。
- 一次 `SELECT id, name, mime, size, updated_at, deleted_at, owner_user_id, scope_type, scope_id FROM workspace_files WHERE company_id=? AND id IN (...)`。
- 给每个附件补 `workspaceStatus` 和可选的 `workspaceCurrentName/workspaceUpdatedAt`。
- 没有 `workspaceFileId` 的旧附件原样返回，不加状态。

这样历史消息渲染不需要逐文件请求状态，也不需要 `preview-capability`。

### 4.6 SSE 新事件

在 `chat-events.ts` 增加：

```ts
export interface ChatWorkspaceFilesEvent {
  type: 'workspace'
  companyId: string
  userId: string
  reason: 'created' | 'updated' | 'deleted' | 'renamed' | 'restored'
  fileIds: string[]
}
```

- 加入 `ChatLiveEventPayload` 联合类型。
- 加入 `initChatEventBridge()` 的 Redis 订阅白名单。
- `GET /api/chat/events` 对 `type === 'workspace'` 做公司/员工过滤后写：

```text
event: workspace
data: {"type":"workspace","reason":"deleted","fileIds":["..."]}
```

- 事件只带 ID、原因，不带文件名、路径、内容；前端需要更多信息时再拉列表/状态。
- 发布放在数据库提交之后；发布失败不影响主操作，只影响实时性，下一次 `ready`/可见性刷新会补上。

### 4.7 事件触发点

至少覆盖以下入口，实施时按调用图补齐：

- `POST /api/workspace/files`：网页上传、覆盖保存、对话附件落盘。
- `DELETE /api/workspace/files/:id`：软删。
- `PATCH /api/workspace/files/:id`：改名。
- Agent `workspace.write`、`workspace.edit`：写入/局部编辑后。
- Office 工具保存、OnlyOffice 回调保存、插件保存回调：文件内容或大小变化后。
- 回收站清理：只影响已删除文件，不需要推给在线页面；如要精确，可在清理后推 `deleted`。
- 分享/取消共享：本期不影响本人文件列表，可不推；如果后续要让被共享人实时看到，再扩展。

## 5. 端到端流程

### 5.1 发送带附件的消息

```text
用户点发送
  ├─ 没有附件：完全沿用现有 send() / drainQueue()，不改路径
  └─ 有附件：
      1. 前端为每个待发附件生成 uploadId（crypto.randomUUID）
      2. 逐个 POST /api/workspace/files
         path = 对话附件/YYYY-MM-DD/<uploadId>/<安全文件名>
         文本附件用 text；图片/二进制用 contentBase64；同时传 mime
      3. 成功得到 fileId；失败保留本地 text/dataUrl 作为降级
      4. POST /api/chat/messages
         attachments[] = 成功项带 workspaceFileId；失败项仍带 text/dataUrl
      5. 服务端按 4.2 读取/校验，落 chat_messages.meta_json
      6. 每次上传成功都已触发 SSE workspace 事件，云空间列表主动更新
```

为什么在发送时上传，而不是选文件时上传：

- 选文件时上传会在用户还没发送时就在云空间产生文件，容易产生误存和清理歧义。
- 发送时上传只在用户明确表达“要发这条消息”后发生，语义清楚。
- 上传使用现有 `POST /api/workspace/files` 的配额/权限/审计，不另建存储通道。

为什么逐个上传，不并行：

- 现有上传接口的配额检查是“读已用 + 判断 + 写回”，并行会有配额竞态。
- 单条消息最多 4 个附件，逐个上传的额外耗时可控；前端显示“正在保存附件到云空间…”进度。
- 某个文件失败时，后续文件仍可继续，最终消息按“成功项带 fileId、失败项降级”发送。

### 5.2 历史消息渲染

```text
GET /api/chat/sessions/:id/messages
  → 服务端批量解析 workspaceFileId 状态
  → 前端 appendMessage(..., meta.attachments)
  → 图片附件：<img loading="lazy" decoding="async" src="/api/workspace/files/:id/preview?...">
  → 文件附件：文件卡（类型图标 + 名称 + 大小 + “点击预览”）
  → workspaceStatus=deleted：只渲染“已被删除”图标，不生成 img
  → 没有 workspaceFileId 的旧附件：沿用现在的文字 chip
```

### 5.3 云空间删除后更新消息卡片

```text
用户/Agent 删除文件
  → deleteUserWorkspaceFile() 成功
  → 发布 workspace{reason:'deleted', fileIds:[id]}
  → SSE 推给同一员工的所有已打开标签页
  → 前端把页面上 [data-attachment-file-id=id] 的卡片切成“已被删除”
  → 如果右侧正在预览该文件，直接复用现有巡检关闭逻辑，不等 30 秒
```

不再显示有效预览的实现方式：

- 删除事件到达时，移除 `img` 的 `src` 或整个替换为删除态模板，避免浏览器继续显示缓存图。
- 历史接口在 `workspaceStatus=deleted` 时根本不输出 `img`，所以刷新页面也不会恢复预览。
- 回收站清理后记录不存在，状态仍是 `deleted`，表现一致。

### 5.4 云空间主动刷新

```text
文件变化
  → 服务端发布 workspace 事件
  → SSE event: workspace
  → 前端 scheduleWorkspaceRefresh()
       ├─ 300ms 合并同一批事件
       ├─ document.hidden 时只置 pending，不拉列表
       └─ 可见时调用 loadWorkspaceFiles({silent:true})
            ├─ 保留当前滚动位置和选中文件
            ├─ 不关闭已打开的预览
            └─ 失败时保留旧列表，不把列表清空
```

兜底：

- SSE `ready`（首次连接/断线重连）后主动 `loadWorkspaceFiles()` 一次，补上连接建立前漏掉的变化。
- `visibilitychange` 从隐藏变可见且存在 pending 时刷新一次；如果超过 60 秒没刷新，也补一次。
- 不设置常驻 `setInterval` 做全量轮询。
- 如果浏览器不支持 `EventSource`，保持现有手动刷新 + 可见性刷新，不引入轮询。

### 5.5 “不使用文件空间”时

- `spaceKind === 'none'`：不把附件写入个人云空间，消息卡片沿用现有文字 chip；发送前在输入区提示“本轮不使用文件空间，附件不会保存到云空间”。
- 理由：保留“不使用文件空间”的原有语义；用户显式选择不读写文件时，不应因为附件预览而偷偷落盘。
- 默认 `spaceKind === 'cloud'`：按上面的完整流程执行。

### 5.6 失败与降级

| 场景 | 行为 |
|---|---|
| 个人配额不足 | 该附件不落盘，消息仍可发送；卡片标“未保存到云空间（空间不足）”；不阻断模型回答 |
| 公司配额不足 | 同上，提示公司空间不足 |
| 没有 `workspace:write` 权限 | 附件不落盘，消息仍可发送；卡片标“未保存到云空间（无写入权限）” |
| 上传网络失败 | 前端保留输入内容和待发附件，提示重试；不把消息发出去 |
| 上传成功但 `POST /api/chat/messages` 失败 | 云空间文件保留在 `对话附件/` 下，用户可在云空间看到并删除；不做自动删除，避免误删用户文件 |
| 文件已删除 | 消息卡片显示“已被删除”，点击无动作；预览端点 404 |
| 记录在但磁盘文件丢失 | 状态仍可能是 `active`，图片加载失败时显示“预览不可用/重试”，不误报“已被删除” |
| SSE 断线 | `ready`/可见性刷新补一次；期间文件变化不会丢，只是延迟到下一次刷新 |
| Redis 不可用 | 退回进程内广播；同一实例的标签页实时更新，跨实例靠重连/可见性刷新 |

## 6. 文件落盘与命名

- 目录：`<个人 scope 目录>/对话附件/YYYY-MM-DD/<uploadId>/<安全文件名>`。
- `uploadId` 由前端在选中附件时生成，使用 `crypto.randomUUID()`；同一附件重试时复用同一个 `uploadId`，上传接口按同一路径覆盖，天然幂等，不会产生重复文件。
- 文件名清洗：去掉路径分隔符、控制字符、Windows 非法字符；去掉首尾空格和点；保留扩展名；长度上限 120 字符；为空时用 `附件-<uploadId 前 8 位>`。
- 同名处理：如果个人云空间已有同名活动文件，服务端在显示名后追加 ` (2)`、` (3)`，并让 `rel_path` 的文件名与显示名一致，避免云空间列表出现两个无法区分的同名文件。
- 不覆盖用户已有文件：每条附件使用独立 `uploadId` 目录，绝不写用户根目录下的同名文件。
- 配额：走 `resolveUserWorkspaceQuota` / `ensureQuota`，个人和公司配额都校验；软删后配额立即释放；回收站保留期由现有 `workspace-recycle.ts` 管理。
- 审计：沿用 `workspace.file.upload` / `workspace.file.update` 审计；附件不再额外造审计类型。
- 物理副本：同一条消息的每个附件独立一份。用户把同一个文件发两次会产生两个云空间文件，删除其中一个只影响对应消息；这是为了让“删除文件 → 对应消息显示已删除”的语义可预测。后续如要省配额，可在文件内容哈希层面做去重，但不属于本期。

### 6.1 左侧云空间目录展示

- 目录仍不单独落库，前端按 `workspace_files.rel_path` 归并：当前层只显示直接文件和下一级文件夹，同层同名目录合并；文件夹的“N 个文件”统计全部后代文件，另显示“M 个文件夹”，只有文件和子文件夹都为 0 时才显示“空文件夹”。
- 左侧列表新增“位置：云空间 / 子目录 / …”面包屑，点击任意一级返回对应目录；点击文件夹进入下一级，点击文件仍进入原有预览、重命名、删除和共享文件流程。
- 当前目录变化只影响列表显示，`filePreview`、文件操作和下载仍按文件 `id` 工作；刷新文件列表时如果当前目录已不存在，自动回到根目录。
- 网页上传会写到当前所在目录：请求体使用 `path=<当前目录>/<文件名>`，服务端复用现有 `relPath` 写入；重命名只替换路径最后一段，保留原目录，不再把子目录文件移回根目录。
- 空文件夹用 `.gitkeep` 占位：目录项正常显示，`.gitkeep` 本身不作为用户文件展示，也不计入“N 个文件”。
- 标题栏新增“新建文件夹”，在当前所在目录创建；文件夹行提供 `⋯` 菜单和右键菜单，可“打开 / 新建子文件夹 / 重命名 / 删除”。文件夹重命名只接受最后一级名称；删除前弹确认框，按文件数提示会移入回收区。
- 三个后端接口 `POST/PATCH/DELETE /api/workspace/folders` 只作用于本人 `user` scope，要求 `WORKSPACE_WRITE` 权限并分别写 `workspace.folder.create/rename/delete` 审计。路径拒绝 `.`/`_` 开头的内部目录；重命名会整棵移动后代文件和 `storage_path`，失败时回滚磁盘；删除先把本人后代文件软删到 `_recycle` 并扣配额，再清理空目录。
- 如果文件夹里有其他成员共享来的文件，整体重命名和删除会被服务端拒绝，前端文件夹菜单对应项置灰，避免“只动了一半”的半完成状态。文件夹操作不删除其他成员的共享文件。
- Agent 侧新增 `workspace.folder` 核心工具，支持 `action=create/rename/delete`，`path` 为完整文件夹路径，`rename` 额外传 `newName`；`workspace.list` 同时返回 `folders` 与 `files`，并过滤 `.gitkeep`。Agent 不能通过 `workspace.rename` / `workspace.delete` 操作文件夹，这两个工具仍只服务文件。

## 7. 前端卡片设计

### 7.1 卡片状态

每个附件卡片有五种状态：

- `pending`：正在保存到云空间，显示骨架/进度，不显示删除图标。
- `active-image`：图片缩略图，`object-fit: cover`，最大 240×180，`loading="lazy"`、`decoding="async"`。
- `active-file`：文件卡，类型图标 + 文件名 + 大小 + “点击预览”。
- `deleted`：灰色虚线卡，垃圾桶/禁止图标 + “已被删除”，不生成 `img`，不可点击。
- `unsaved`：未保存到云空间（配额/权限/失败），保留文件名，提示原因，不显示预览。

### 7.2 结构

```html
<div class="bubble-files">
  <button class="bubble-attach is-image" type="button"
          data-attachment-file-id="01J..." data-preview-url="/api/workspace/files/01J.../preview?as=...">
    <img src="..." alt="季度报告.png" loading="lazy" decoding="async">
    <span class="bubble-attach-meta">季度报告.png · 1.2 MB</span>
  </button>

  <button class="bubble-attach is-file" type="button"
          data-attachment-file-id="01K...">
    <span class="bubble-attach-icon" data-kind="pdf" aria-hidden="true"></span>
    <span class="bubble-attach-name">季度报告.pdf</span>
    <span class="bubble-attach-size">3.4 MB · 点击预览</span>
  </button>

  <div class="bubble-attach is-deleted" role="img" aria-label="季度报告.png 已被删除">
    <span class="bubble-attach-icon" data-kind="deleted" aria-hidden="true"></span>
    <span class="bubble-attach-name">已被删除</span>
    <span class="bubble-attach-origin">季度报告.png</span>
  </div>
</div>
```

- 图片卡点击调用现有 `openWorkspaceFile(fileId)`，复用右侧预览面板，不另造图片查看器。
- 文件卡点击同样打开云空间预览；如果文件已删除，不绑定点击。
- `data-attachment-file-id` 用于 SSE 就地更新，不重新渲染整条消息。
- `alt` 用文件名；删除态使用 `role="img"` + `aria-label`；键盘可聚焦的卡片保留可见焦点。
- 现有 `.bubble-files span` 样式只作用于文字 chip，新卡片使用独立类名，避免影响批次卡和旧消息。

### 7.3 图片加载失败

- `<img onerror>`：
  - 先查一次批量状态（最多把当前页的 ID 合并成一次请求）。
  - `deleted` → 切删除态。
  - `forbidden` → 切“无权访问”。
  - `active` 但图片加载失败 → 显示“预览不可用”+重试按钮，不误报删除。
- 不在每条消息渲染时主动请求状态；只有历史接口批量状态缺失或图片加载失败时才查。

## 8. 性能与 EAB 影响

- 纯文本消息：路径完全不变，不增加上传、不增加 SSE、不增加查询。
- 带附件消息：额外只有“上传到个人云空间”这一步；这是需求本身要求的持久化，不是额外模型开销。
- 聊天请求体：已落盘的附件只传 `workspaceFileId` 和少量元数据，不再把图片 `dataUrl`、文本正文重复塞进 `/api/chat/messages`；未落盘的降级项仍按旧格式传。
- 模型调用：仍然只调用一次；附件读取发生在模型调用前，读取量受 12k 文本 / 10MB 图片限制，不进入多轮工具循环。
- 历史消息：每页多一次 `IN` 查询；附件状态不是逐文件请求。图片用 `loading="lazy"`，只加载进入视口的缩略图。
- 云空间刷新：SSE 事件只在文件变化时产生；前端 300ms 合并；隐藏页只记 pending；没有常驻全量轮询。
- 不新增 npm 依赖、不新增数据库表/列、不改变 `runAgentTurn`、`context-window.ts`、`model-registry.ts`、`plugin-models.ts`。
- 建议增加默认开启的配置开关（例如 `EAB_CHAT_ATTACHMENT_SPACE=on|off`），出问题时无需改代码即可回到旧的“仅消息附件”模式。开关关闭时，前端不执行上传，服务端忽略 `workspaceFileId`，行为与当前版本一致。

## 9. 兼容与回归

必须保持：

- 文本附件仍按现有 12k 截断 + 文本批次逻辑进入模型上下文。
- 图片附件仍作为视觉输入传给模型；只是图片来源从 `dataUrl` 改为“云空间文件读取后生成 dataUrl”。
- 非文本/非图片附件在没有云空间文件时，仍按现有“暂时无法读取正文”提示。
- 旧消息（没有 `workspaceFileId`）显示现有文字 chip，不出现坏图、不出现“已删除”。
- `spaceKind='none'` 不落云空间，附件展示回到现有 chip。
- 云空间的下载、打开预览、重命名、删除、版本、共享、配额、回收站、审计行为不变。
- 共享文件不会因为消息附件解析被误当成“本人附件”；消息只引用本人 `scope_type='user'` 文件。
- 上一轮 DSH 插件模型与对话循环改造不回退。

需要专门验证的回归：

- 钉钉侧消息/增量/工具/子 Agent/模型目录的 SSE 仍正常。
- 右侧预览 30 秒巡检在文件删除、权限失效时仍能关闭面板。
- 云空间列表的本地操作（上传、删除、改名、Office 刷新）仍按原路径工作。
- 审核/审计记录数量不因图片预览请求暴涨。

## 10. 实施切片

### P0-1 服务端数据与协议

- `packages/server/src/routes/chat.ts`
  - `ChatAttachmentInput` 增加 `workspaceFileId`。
  - 解析附件时校验并读取云空间文件；`attachmentMeta` 写入新字段。
  - 历史消息返回前批量补 `workspaceStatus`。
- `packages/server/src/routes/workspace.ts`
  - 抽出 `readChatAttachmentFile(deps, actor, fileId)`：归属校验 + 文本/图片读取 + 大小限制。
  - 新增 `GET /api/workspace/files/:id/preview`。
  - 新增 `POST /api/workspace/files/status`。
  - 在 upload/delete/rename/Agent write/Office save 成功后发布 `workspace` 事件。

### P0-2 实时通道

- `packages/server/src/chat-events.ts`
  - 新增 `ChatWorkspaceFilesEvent`，加入联合类型和 Redis 订阅白名单。
- `packages/server/src/routes/chat.ts`
  - `GET /api/chat/events` 增加 `event: workspace` 分支，按公司/员工过滤。

### P0-3 前端附件落盘与卡片

- `packages/server/public/chat.js`
  - `send()`：带附件时逐个上传到 `/api/workspace/files`，拿到 `workspaceFileId`；失败项保留 `text/dataUrl` 降级。
  - `buildAttachmentPayload()`：已落盘项只传 `workspaceFileId`，未落盘项沿用旧字段。
  - `attachmentChips()` 改为 `attachmentCards()`，按状态输出图片/文件/删除/未保存卡。
  - `appendMessage()` 保留 `.bubble-files` 容器，更新内部结构。
  - `setupChatEvents()` 增加 `workspace` 监听、`ready` 刷新、`visibilitychange` 兜底。
  - `loadWorkspaceFiles()` 增加 `silent` 模式、并发保护、滚动位置保留。
  - 删除事件到达时就地更新 `[data-attachment-file-id]`；如果当前预览命中，调用现有 `checkWorkspacePreviewAccess`/关闭逻辑。
- `packages/server/public/chat.css`
  - 新增 `.bubble-attach` 系列样式；保留现有 `.bubble-files span` 兼容旧 chip。

### P1 加固

- 为 office/agent 写入补齐事件触发点。
- 为“上传 4 个附件只刷新一次列表”“删除后卡片即时切换”“旧消息不变”补前端/服务端测试。
- 视实际体积再评估图片缩略图管线；P0 不做服务端压缩，不新增 `sharp`。

## 11. 验收

### API / 单测

1. 带 `workspaceFileId` 的消息：服务端用云空间实际 `name/size/mime`，忽略客户端伪造值；非本人文件被拒绝。
2. 文本附件落盘后，模型仍收到前 12k + 批次提示；超过 5M 字符被拒绝。
3. 图片附件落盘后，模型仍收到 `image_url`；超过 10MB 被拒绝。
4. 历史消息一页只发一次状态查询；`deleted_at` 非空和记录不存在都返回 `deleted`。
5. `POST /api/workspace/files/status` 最多 200 个 ID；他人文件不泄露名称。
6. `GET /preview` 对图片返回 inline 图片和缓存头；对删除文件 404；对 SVG/非图片 415。
7. `workspace` 事件经过进程内和 Redis 分支都能到同一员工；公司/员工过滤正确。

### 真实浏览器验收

1. 在 `http://127.0.0.1:8787/chat` 发送一张 PNG + 一个 PDF：
   - 云空间列表无需刷新立即出现两个文件；
   - 消息气泡显示图片缩略图和 PDF 文件卡；
   - 点击 PDF 打开右侧预览。
2. 刷新页面后重新打开会话：图片和文件卡仍从云空间文件预览，不依赖 `dataUrl`。
3. 在云空间删除图片：消息卡片在 SSE 到达后变为“已被删除”，图片不再显示；PDF 仍正常。
4. 再删除 PDF：两个卡片都变为删除态；刷新页面仍是删除态。
5. 打开两个网页标签：标签 A 发附件，标签 B 云空间列表自动出现；标签 A 删除，标签 B 列表和消息卡片同步更新。
6. 让 Agent 执行 `workspace.write`、`workspace.edit`、Office 保存，云空间列表自动更新。
7. 把个人配额调到不足：发送带附件消息仍成功，卡片显示“未保存到云空间（空间不足）”，云空间没有该文件。
8. 选择“不使用文件空间”发送图片：不产生云空间文件，消息卡片为现有文字 chip。
9. 打开旧会话（历史图片没有 `workspaceFileId`）：仍显示原文字 chip，不出现坏图。
10. 断网/重启服务后 SSE 重连：`ready` 后列表补刷新，消息卡片状态补齐。

### 性能验收

- 纯文本消息的请求数与当前版本一致。
- 带附件消息不增加模型请求数；`/api/chat/messages` 请求体不再包含已落盘图片的 `dataUrl`。
- 页面空闲 5 分钟，云空间不产生周期性全量列表请求。
- 历史页 50 条消息、20 个附件：状态查询为 1 次，图片请求只发生在视口内。
- SSE 连续 4 个上传事件只触发 1 次合并后的列表刷新。

## 12. 风险与需要确认的默认值

风险：

- 附件落盘会让个人配额消耗变快；需要在输入区和未保存状态里给出明确提示。
- 发送失败后已上传的云空间文件会留下“对话附件”目录，需要用户自行删除；本期不做自动清理，避免误删。
- 图片预览走原图，不做服务端缩略图；历史消息很多大图时，依赖 `loading="lazy"` 控制带宽。若实测仍慢，再单独做缩略图管线，不混进本期。
- 事件触发点分散在多个写入入口，漏一个就会出现“某个操作后列表不刷新”；实施时必须按写入调用图逐项核对，并用“Agent 写入、Office 保存、网页上传、删除、改名”五类验收覆盖。

按推荐默认值设计，若要改请直接指出：

1. 对话附件计入个人/公司配额，并出现在云空间的 `对话附件/` 目录。
2. 同一个文件发送两次生成两个独立云空间文件，删除其中一个只影响对应消息。
3. `spaceKind='none'` 时不落云空间，保留现有“不使用文件空间”语义。
4. 旧消息不补预览，保持文字 chip。
5. 附件持久化失败不阻断消息发送，卡片明确标注“未保存到云空间”。
