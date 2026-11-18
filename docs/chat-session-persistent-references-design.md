# 会话级持久引用（文件 / 文件夹 / 对话）

- 日期：2026-11-18
- 状态：已实现，已通过本地真实工作台验收
- 范围：`packages/server/src/routes/chat.ts`、`packages/server/public/chat.js`、`packages/storage/migrations/0075_chat_session_references.sql`

## 1. 需求边界

从侧栏「云空间文件 / 文件夹」或「对话列表」拖进输入区的对象，是当前会话的常驻引用：

1. 只要 chip 上的 `×` 没有被删除，每一轮消息都继续把它作为上下文。
2. 点 `×` 后立即从当前会话移除，下一轮不再注入；已经发送或排队中的消息仍使用入队时的引用快照。
3. 引用只属于当前会话：新建会话为空，切换会话恢复各自的引用，删除会话随会话一起清理。
4. 本机临时上传的文件、blob URL、正文、图片 dataURL 不是常驻引用，只作用于当前一条消息。
5. 被删除/失效的常驻对象不能让之后每一轮都报错：保存时严格校验，发送时跳过失效项继续本轮。
6. 每条消息的 `meta.attachments` 记录本轮实际使用的引用，历史气泡可追溯。
7. 常驻引用与一次性附件合计沿用 4 个上限；当前不区分两套上限。

明确不做：

- 不把本机文件复制成云空间文件；拖入云空间对象只是引用原对象。
- 不在前端刷新后保留“尚未建立会话”的本地草稿引用。
- 不自动清理数据库里已失效的引用记录；删除动作由用户点 `×` 承担。
- 暂未把会话引用接入钉钉 / 飞书通道回合。

## 2. 数据与接口

### 2.1 存储

`chat_sessions` 新增：

```sql
ALTER TABLE chat_sessions ADD COLUMN references_json TEXT NOT NULL DEFAULT '[]';
```

只保存最小稳定字段，不保存正文、图片 dataURL、blob URL：

- 对话：`conversationId`、`conversationTitle`、`conversationMessageCount`、`persistent: true`
- 云空间文件：`workspaceFileId`、`workspaceRelPath`、`workspaceMime`、`name`、`size`、`type`、`persistent: true`
- 云空间文件夹：`workspaceFolderPath`、`workspaceFileCount`、`workspaceFolderCount`、`name`、`persistent: true`

### 2.2 API

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/chat/sessions` | 可选 `references`，新会话随创建落库 |
| `GET` | `/api/chat/sessions/:id/messages` | 返回 `session.references`，前端打开会话时恢复 chip |
| `PUT` | `/api/chat/sessions/:id/references` | 整体替换当前会话引用，不更新 `updated_at` |
| `POST` | `/api/chat/messages` | 可选 `references`，作为本轮引用快照 |

`POST /api/chat/messages` 的取舍：

- 新会话：`references` 随 `ensureSession` 写入会话，作为后续常驻引用。
- 已有会话：`references` 只作用于本轮，不写库；持久化由 `PUT /references` 负责，避免排队旧消息把用户刚删除的引用写回来。
- 未传 `references`（钉钉/飞书等通道）：读取该会话已保存的 `references_json`。
- 常驻引用和 `attachments` 合并前去重；`spaceKind !== 'cloud'` 时只保留对话引用。

## 3. 发送时序

1. 拖入对象：写入 `state.attachments`，标记 `persistent: true`，立即按会话串行 `PUT /references`。
2. 点 `×`：从 `state.attachments` 移除，常驻引用立即同步；本机一次性附件只清本地。
3. 发送：把当前输入区全部附件复制到 `pending`；发送后只保留 `pending` 里的常驻引用，本机附件清空并 revoke blob。
4. 入队消息保存入队时的 `pending` 快照；发送前等待该会话的引用同步完成，再把 `pending` 中的常驻引用单独作为 `references` 发送。
5. 新会话首条消息收到 `meta.data.sessionId` 后，再同步一次当前输入区引用，覆盖“发送过程中新增/删除”的情况。
6. 打开会话：先应用空间，再 `applySessionReferences(data.session.references)`；新建会话清空输入区。

## 4. 失效与安全

- `PUT` / 新建会话保存引用时严格校验：对话必须是本人对话；文件必须是本人个人云空间未删除文件；文件夹只允许云空间。
- `POST /api/chat/messages` 解析本轮引用时使用宽容模式：对话被删、文件被删/移走时跳过该项继续本轮；非持久附件仍按原错误返回。
- `resolveChatAttachments` 对常驻对话/文件读取失败也跳过，避免已删除对象阻断每轮。
- 文件夹保存时只做路径规范化，不校验目录真实存在；读取时由文件工具按路径处理。
- 引用只允许本人资源，拒绝共享文件、他人对话和本机正文。

## 5. 已验收链路

本地 `http://127.0.0.1:8787/chat`：

- 拖入 `workspace` 文件夹 → chip 显示「文件夹引用 · 常驻」→ 数据库 `references_json` 落库。
- 发送一轮 → chip 仍保留，消息 `meta.attachments` 带 `persistent: true`。
- 再发一轮 → 引用继续生效。
- 点 `×` → 下一轮消息 `meta.attachments` 为空。
- 切换会话 → 各自恢复各自引用，互不串用；刷新页面后引用仍在。
- 新会话拖入引用并发送首条消息 → 新会话 `references_json` 落库。
