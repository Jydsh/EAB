# 钉钉私聊文件：从个人云空间发到钉钉

## 现在能做什么

网页工作台的云空间文件预览区新增「发送到钉钉」，文件菜单里也有同一项。
点击后把**当前登录员工个人云空间里的这个文件**作为真正的钉钉文件消息，发到该员工自己的钉钉单聊。

- 发送对象固定是当前登录员工，不支持在网页里指定其他接收人。
- 发送前从磁盘重新读取文件内容，所以网页里「编辑 → 保存」后的新版本会被发出去，不是旧缓存。
- 图片会优先按文件消息发送；如果钉钉不接受图片作为 `sampleFile`，自动退回原生图片消息。
- 网页入口：`POST /api/workspace/files/:id/send-dingtalk`。
- 审计动作：`workspace.file.send_dingtalk`，记录文件名、大小、`mediaId`、接收人外部 ID。

## 钉钉里直接让 agent 发文件

新增内置工具 `workspace.send_dingtalk`（模型侧函数名 `workspace_send_dingtalk`）：

- 用户说“把文件发给我 / 发到钉钉 / 把这个文件发我”时，模型会调用它。
- 先用 `workspace.list` 找到文件名或相对路径，再传 `path`；也可以直接传 `fileId`。
- 工具从个人云空间重新读取文件内容并走上面的钉钉出站链路，成功后返回 `sent: true`、文件名、大小和发送方式。
- 和容量工具一样，只在当前对话选择「云空间」时暴露；本地空间不使用这个工具。
- 审计走统一工具调用记录，动作名 `tool.invoke.workspace.send_dingtalk`。

## 重命名

网页云空间的文件菜单里原本就有「重命名」；这次补上了 agent 侧的工具 `workspace.rename`（模型侧函数名 `workspace_rename`）：

- 用户说“重命名 / 改名 / 把文件名改成…”时，模型先 `workspace.list` 找文件，再传 `fileId` 或 `path` 和 `newName`。
- 只改文件名，同时更新磁盘路径和 `workspace_files` 元数据；同名文件已存在会明确拒绝。
- 改名后再让 agent 发送，会用新文件名发到钉钉。
- 同样只在「云空间」暴露；本地空间不使用这个工具。

## 钉钉侧链路

1. `POST https://oapi.dingtalk.com/media/upload?access_token=...`
   - `multipart/form-data`，字段 `type`（文件 `file` / 图片 `image`）+ `media`（带文件名）
   - 返回 `media_id`
2. `POST https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend`
   - header `x-acs-dingtalk-access-token`
   - body `{ robotCode, userIds: [当前员工钉钉 userId], msgKey: 'sampleFile', msgParam: { mediaId, fileName, fileType } }`
   - `fileType` 取文件名扩展名（不含点、小写）

webhook 回复（`replySessionWebhook`）不支持文件，所以这里没有复用它；文件只能走接口发送。

## 钉钉原生预览（钉盘）

`sampleFile` 的 `msgParam` 只有 `mediaId` / `fileName` / `fileType`，没有钉盘的 `spaceId` / `fileId`；钉钉不会对机器人推送的文件做内容提取，所以手机上只能打开/下载，不能像用户自己发的文件那样直接预览。这是消息类型的能力边界，不是 EAB 漏了参数。

原生预览只能由卡片里的 `File` 组件承担：`File` 的 `previewUrl` 是「在线预览页 URL」，点整行打开它；行尾打开按钮仍用 `url`。EAB 现在按下面链路发：

1. `workspace.send_dingtalk` 在钉钉 A2UI 卡片会话里先走钉盘：
   - `POST /v1.0/storage/spaces` 创建/复用当前员工的 USER 空间（`scene` + `sceneId` 固定，避免重复建空间）；
   - `POST /v1.0/storage/spaces/{spaceId}/dentries/0/folders` 创建/复用上传目录；
   - `POST /v2.0/storage/spaces/files/{parentDentryUuid}/uploadInfos/query` 拿 OSS 签名地址，PUT 上传；
   - `POST /v2.0/storage/spaces/files/{parentDentryUuid}/commit` 拿 `dentry.uuid`；
   - `POST /v1.0/storage/spaces/{spaceId}/dentries/{dentryId}/openInfos/query` 取 `previewUrl`；**这里必须用 commit 返回的数字 `dentry.id`，不能传 `dentry.uuid`**。
2. 工具把 `{fileName,url,previewUrl,size,mimeType}` 放进结果；`dingtalk-bot.ts` 从 `tool_result` 的 summary 解析出附件，挂到 A2UI 卡片的 `File` 组件。
3. 卡片用 `richCardComponents` 里的 `attachment0~2` 展示文件行；点击行打开 `previewUrl`，不再依赖 `sampleFile`。

### 权限与实测状态（2026-11-09）

以下五项已在钉钉开发者后台开通，接口从 403 转为 400 `paramError`，说明权限墙已拆除：

- `Storage.Space.Write`
- `Storage.UploadInfo.Read`
- `Storage.File.Write`
- `Storage.File.Read`
- `Storage.Permission.Write`
- `ConvFile.File.Send`（群文件发送权限：会话文件消息 / 应用文件消息共用）
- `Storage.DownloadInfo.Read`（下载信息，已开通但代码尚未接入）

`Drive.Space.Read` 仍是 403，但本链路不需要空间列表，未申请。

真实 docx 已跑通：上传 → commit → `openInfos` 拿到 `alidocs.dingtalk.com/uni-preview?...` 预览 URL；带 `File` 组件的 A2UI 卡片已发送到用户钉钉（实例 `eab_a2ui_e24eac283dbc4035aab9732eb2bb48d0`）。`previewUrl` 在浏览器里匿名访问会 302 到钉钉登录页，这是 `checkLogin:true` 的正常语义；在钉钉客户端内使用当前登录态打开。

## 用户方向原生文件消息（2026-11-09 起默认）

目标形态是用户自己发文件时的右侧原生气泡：预览 + 未查收 + 下载 + 编辑。服务端四条链路里，只有 `POST /v1.0/convFile/conversations/files/send` 能同时给出这组能力；代价是它的 `unionId` 是**操作人**，文件会以用户身份出现在右侧。

采用方式：机器人替用户发，但机器人能识别这是自己代发的。

1. `workspace.send_dingtalk` 在钉钉会话里先 `uploadFileToUserDrive`（`conflictStrategy: 'OVERWRITE'`，同名文件保持原文件名，不再堆 `(1)(2)`）；
2. 写一条 `robot_user_file_sends` pending 标记（公司 + 用户 + `openConversationId` + 文件名 + 大小，10 分钟窗口）；
3. 调 `sendDingTalkFileToConversation`，文件以用户方向落到机器人私聊；
4. 机器人会收到同一条 `file` 入站消息；`dingtalk-bot.ts` 命中标记后**跳过下载和个人云空间保存**，只写一条 `[文件]` 会话记录并回复「你要的文件已发送」；
5. 没命中标记的 `file` 入站消息仍按用户自己上传处理，正常保存到个人云空间。

实测（2026-11-09）：

- `suale.txt`：发送返回 `fileId=242565680940`，标记 `matched`，云空间文件数不变（4 个 / 34,359 B），会话出现 `[文件] suale(1).txt` + 「你要的文件已发送」；
- `安全防护记录表.docx`：发送返回 `fileId=242565701693`，标记 `matched`，云空间文件数仍为 4，文件名保持原样，会话出现 `[文件] 安全防护记录表.docx` + 「你要的文件已发送」；
- 两条都证明回声不会重复落个人云空间。

限制：匹配依赖「同会话 + 同文件名 + 10 分钟窗口」。用户在同一窗口内恰好发同名同大小文件，理论上可能被误判为机器人代发；目前只按文件名匹配，命中一次即消费。要彻底消除，需要钉钉入站消息返回 `fileId`/`dentryId`（当前没有）。

## 原生文件消息（下载 / 编辑）

卡片 `File` 组件的 `url` 才是「下载 URL」，而此前代码把 `url` 也填成了预览页，所以行尾下载按钮只是再开一次预览；卡片也不会出现「未查收 / 下载 / 编辑」这组原生动作。

**接口选择（真机纠正过两次）**：

- `POST /v1.0/convFile/apps/conversations/files/send` 是「以应用身份发文件给指定用户」，落在**工作通知：应用名**会话，不在机器人私聊里；实测文件气泡带「下载 / 编辑」，但位置错。
- `POST /v1.0/convFile/conversations/files/send` 的 `unionId` 是**操作人**，文件会以**当前用户**的身份发进会话；实测在机器人私聊里变成用户自己发出的右侧文件气泡，方向反了。
- 机器人身份发文件到单聊只能用 `POST /v1.0/robot/oToMessages/batchSend` 的 `sampleFile`（`mediaId` + `fileName` + `fileType`）；它一定落在机器人私聊、发送者是机器人，但当前客户端不保证出现「编辑」按钮。

当前策略：

1. 钉钉单聊里优先 `convFile/conversations/files/send`（用户方向），拿到完整原生文件气泡；
2. 用 `robot_user_file_sends` 标记拦截回声，不重复保存个人云空间；
3. 网页会话拿不到 `openConversationId` 时，退回机器人 `sampleFile`，保证文件仍能送达；
4. 工作通知接口不再作为默认路径。


代码路径：

1. `dingtalk-bot.ts` 收到消息后写 `chat_sessions.open_conversation_id`；
2. `routes/tools.ts` 的 `workspace.send_dingtalk` 云空间分支：钉钉会话 + `openConversationId` 走 `uploadFileToUserDrive` + `sendDingTalkFileToConversation`，否则退回 `sendDingTalkFileToUser`；
3. `dingtalk-file-echo.ts` 负责 pending 标记的创建、消费、失败清理；

实测记录：

- 2026-11-09 工作通知接口：直接 POST 返回 200，文件 id `242562687027`，conversationId `cidDRGv8DJaZXc+VMUgqISfng==`，名称 `安全防护记录表(3).docx`；完整工具链返回 `242563158268`。手机截图确认带「已查收 / 下载 / 编辑」，但落在「工作通知：重庆居易智能」。
- 2026-11-09 会话文件接口：员工发送「你好」后捕获 `open_conversation_id = cid53bpTKgRunyqO8012OU4UZZsYIxj8isOLbn18bpFw2k=`；发 `安全防护记录表.docx` 返回 `fileMessage.fileId=242564220465`、`conversationId` 与捕获值一致。**手机截图显示文件以用户身份出现在右侧，方向错误。**
- 2026-11-09 机器人 `sampleFile`：`mediaId=@lArPM3gyql4v7_HOEFk0a84wvS0G`、`fileName=安全防护记录表.docx`、`fileType=docx`。发送成功，待手机截图确认按钮。

仍需注意：

- `openInfos/query` 的 `option.type: 'EDIT'` 可以拿可编辑链接，但当前没有接入；原生文件消息自身已带「编辑」按钮。
- `downloadInfos/query`（`Storage.DownloadInfo.Read`）返回 `HEADER_SIGNATURE` + `resourceUrls` + headers，约 900 秒有效；接入 `File.url` 前要确认客户端下载按钮能否携带 header，风险较高，暂不替换。

申请入口形如：

`https://open-dev.dingtalk.com/appscope/apply?content=ding1qokwhr1smspersq%23Storage.Space.Write`

（其余四项把 `Storage.Space.Write` 换成对应权限名。）

## 限制

- 钉钉媒体上传官方上限 **20 MB**；个人云空间单文件上限是 50 MB。超过 20 MB 的文件会被明确拒绝，不会降级成链接或文本。
- 接收人必须是当前员工已绑定的钉钉账号；未绑定时返回可操作的错误提示。
- 钉钉后台如果限制了机器人可见范围，接口可能返回 `invalidStaffIdList`，前端会显示「接收人不在机器人可见范围内」。
- 文件消息是发到员工自己的钉钉单聊；机器人代发的回声会写一条 `[文件]` 记录到同一网页会话，但不会重复保存个人云空间。

## 验证

- 单测：`packages/server/test/dingtalk-outbound.test.ts`（上传 + `sampleFile` 请求体、20 MB 拒绝）
- 单测：`packages/server/test/workspace-file-save.test.ts`（编辑保存后读取磁盘新内容）
- 单测：`packages/server/test/workspace-capacity-tool.test.ts`（云空间工具清单包含 `workspace_send_dingtalk` / `workspace_rename`，本地空间不包含；真实临时文件重命名成功）
- 模型级：网页云空间会话要求“把 suale.txt 发送到钉钉给我”，模型调用 `workspace_send_dingtalk`（`path=suale.txt`），341 ms 返回 `sent:true`，回复“已发送 ✅”。
- 真机：网页云空间选中 `suale.txt` 点击「发送到钉钉」，接口返回 200，审计记录 `workspace.file.send_dingtalk` 成功；钉钉接口返回 `invalidStaffIdList: []`。
- 钉盘链路：2026-11-09 给应用开通 `Storage.Space.Write` / `Storage.UploadInfo.Read` / `Storage.File.Write` / `Storage.File.Read` / `Storage.Permission.Write` 后，用真实 `安全防护记录表.docx`（15,968 B）跑通「建 USER 空间 → 建目录 → 上传 → commit → 取 previewUrl」，返回预览 URL（`https://alidocs.dingtalk.com/uni-preview?...fileId=...`）。
- A2UI 文件卡片：用 `DingTalkAICardStream` 真实投放一张带 `File` 组件的卡片并收口成功（最新一次 card instance `eab_a2ui_e24eac283dbc4035aab9732eb2bb48d0`）。卡片已到用户钉钉，**手机端点开文件行是否打开钉钉预览页仍需用户截图确认**；未确认前不能把「原生预览已验收」写成既成事实。
- convFile 原生文件消息：2026-11-09 用探针 `.eab-dev/tmp/probe-convfile-send.mts` 真调 `POST /v1.0/convFile/apps/conversations/files/send`，返回 200 与 `file.id=242562687027`；代码已接入 `workspace.send_dingtalk` 的首选路径。随后用 `executeTool(...,'workspace.send_dingtalk')` 走完整工具链路再发一次，返回 `delivery:'file'`、`fileMessage.fileId=242563158268`（钉盘 `AUTO_RENAME` 后名 `安全防护记录表(4).docx`）。**手机端是否出现「未查收 / 下载 / 编辑」仍需截图确认。**
