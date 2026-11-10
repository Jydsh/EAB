# 云空间 / 本地空间 实现方案

> 目标：把现有“个人工作区”明确为“云空间”，并新增可绑定本机目录的“本地空间”，让对话可以按当前空间读取、写入、整理文件。
>
> 本文只做方案，不改代码。涉及“本地目录”的部分按当前单机部署前提设计：EAB 服务端与用户要访问的本地目录在同一台 Windows 电脑上。

## 1. 需求理解

### 1.1 云空间

- 把左侧“个人工作区”改名为“云空间”。
- 这里的文件仍然是 Agent 存在 EAB 服务端的数据目录里的，不是用户本地磁盘文件。
- 标题后面加一个信息角标；鼠标悬停或键盘聚焦角标时，显示个人空间信息。
- 现在直接显示在侧栏的配额块（已用 / 500 MB / 单文件上限 / 配置来源）收进角标浮层，不再常驻页面。

### 1.2 本地空间

- 在“云空间”下面新增“本地空间”分组。
- 用户可以指定一个本机目录；绑定成功后，分组下面显示该目录的文件夹和文件。
- 对话时可以选择“当前空间”：
  - 云空间：默认；
  - 本地空间：选中某个已绑定的本地目录；
  - 不使用文件空间：纯对话。
- 选中本地空间后，Agent 可以在该目录范围内读取文件、创建文件、修改文件、移动/重命名文件，也可以按用户明确指令删除单个文件，用来读文档、整理资料、写代码。
- 本地空间不是云空间配额的一部分；它直接读写用户本机目录，不占云空间容量。

### 1.3 对话输入区的空间入口

- 在输入框上方/输入区工具条增加一个“空间”浮动按钮或 chip。
- 点击后可选择云空间、本地空间，或跳去绑定新的本地目录。
- 当前选择要跟会话绑定：重新打开该会话时，尽量恢复上次使用的空间。

### 1.4 一期不做的事

以下内容先明确排除，避免“本地空间”变成无边界远程终端：

- 不在本地空间里执行 shell 命令、`npm install`、`git commit`、启动服务；
- 不默认自动删除文件；只有用户明确说“删除/删掉/清理”时，才允许删除单个文件，且不能删除目录；
- 不默认读取 `.env`、私钥、`.ssh` 等敏感文件；
- 不把本地绝对路径原样传给模型或写进聊天记录；
- 不把本地文件自动上传到云空间；
- 不做远程服务器访问用户家里的电脑（该场景需要单独的本地连接器，见 §9）。

## 2. 现状与约束

### 2.1 现有云空间链路

| 层 | 现状 |
|---|---|
| 侧栏 | `chat.html` 的 `#side-files`，标题“个人工作区”，`#ws-quota` 常驻显示 |
| 文件列表 | `GET /api/workspace/files`，只列元数据表 `workspace_files` |
| 配额 | `GET /api/workspace/quota`，`workspace-quota.ts` 解析用户 > 角色 > 默认 |
| 文件真身 | `<db 同级>/workspaces/<companyId>/user-<userId>/...` |
| Agent 工具 | `workspace.list`、`workspace.write`，没有 `workspace.read` / `workspace.move` |
| 文件预览 | `#file-pane` 复用于云空间，预览头写死“个人工作区” |
| 会话 | `chat_sessions` 没有“当前空间”字段 |

### 2.2 关键约束

1. **浏览器不能直接给出任意本地绝对路径。** `<input type="file" webkitdirectory>` 只能拿到相对文件名，拿不到 `D:\Projects\demo` 这种根路径，也不能让 Agent 直接写回原目录。
2. 当前 EAB 是单机本地部署，Node 服务进程本身就在用户电脑上，所以可以让服务端直接读写用户指定目录。若以后服务端搬到远程服务器，这个前提就不成立。
3. 本地目录的读写权限比云空间敏感，必须做路径边界、软链接、敏感文件、大小和审计限制。
4. 云空间的 `/api/workspace/*` 和 `workspace_files` 是已有稳定契约，本次只改显示名，不改内部表名和接口名，避免历史数据/调用方返工。

## 3. 总体方案

### 3.1 三个空间概念

| 概念 | 存储位置 | 谁管理 | 用途 |
|---|---|---|---|
| 云空间 | EAB 服务端 `workspaces/`，元数据在 `workspace_files` | EAB 服务端 | 换设备也能用、可共享、受配额限制 |
| 本地空间 | 用户指定的本机目录 | 用户绑定，EAB 服务端代理读写 | 读写本机项目/文档，不占云配额 |
| 当前对话空间 | `chat_sessions.space_kind/space_id` + 消息 meta | 会话级选择 | 告诉 Agent 这一轮该用哪套文件工具 |

### 3.2 交互结构

```text
左侧栏
├─ 对话
├─ 云空间  [i]        ← 角标 hover/focus 弹出配额信息
│   └─ 文件列表
├─ 本地空间  [管理]
│   ├─ 当前目录：demo (D:\Projects\demo)  [切换]
│   └─ 目录树
└─ 可用模型

输入区
└─ [空间 chip] 云空间 ▾ / 本地 · demo ▾ / 不使用文件
```

### 3.3 数据流

```text
用户绑定本地目录
  → POST /api/local-spaces
  → 服务端 realpath + 目录校验 + 权限校验
  → 落 user_local_spaces
  → 左侧树 GET /api/local-spaces/:id/entries

对话发送
  → body 带 spaceKind/spaceId
  → 服务端校验空间归属与 mode
  → 该轮 Agent 只拿到当前空间对应的工具
  → 工具读写后写审计
  → 前端收到 done 后刷新对应文件列表
```

## 4. 数据模型

### 4.1 新增表 `user_local_spaces`

迁移文件建议：`packages/storage/migrations/0027_local_space.sql`
（账号安全方案里的 `0027_account_security.sql` 顺延为 `0028`，两者不要抢号。）

```sql
CREATE TABLE IF NOT EXISTS user_local_spaces (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES companies(id),
  user_id         TEXT NOT NULL REFERENCES users(id),
  name            TEXT NOT NULL,
  root_path       TEXT NOT NULL,       -- 用户输入路径，保留原样用于展示
  root_realpath   TEXT NOT NULL,       -- realpath 后的规范路径，所有读写以它为准
  mode            TEXT NOT NULL DEFAULT 'read_write', -- read_only | read_write
  allow_sensitive INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  last_used_at    INTEGER,
  deleted_at      INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_local_spaces_root
  ON user_local_spaces (company_id, user_id, root_realpath)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_user_local_spaces_user
  ON user_local_spaces (company_id, user_id, deleted_at, updated_at);
```

### 4.2 会话记录当前空间

```sql
ALTER TABLE chat_sessions ADD COLUMN space_kind TEXT NOT NULL DEFAULT 'cloud';
ALTER TABLE chat_sessions ADD COLUMN space_id TEXT;
```

- `space_kind`：`cloud` / `local` / `none`。
- `space_id`：本地空间 id；云空间为空。
- 发送消息时服务端校验并回写；打开会话时前端读取并恢复选择。
- `chat_messages.meta_json` 里同时存一份 `space` 快照，用于消息旁的“本地空间 · demo”标签，不存绝对路径。

### 4.3 权限点

建议新增两个独立权限，不复用 `workspace:read/write`：

```text
local-space:read   读取本地空间目录/文件
local-space:write  绑定/修改/写入本地空间（implies read）
```

- 在 `packages/domain/src/scopes.ts` 登记；
- `packages/authz/src/roles.ts` 的 `member`、`company_admin` 默认加入；
- 迁移里给现存 `member` / `company_admin` 角色补 `role_scopes`，否则老库用户看不到入口；
- 控制台角色页自动出现“本地空间”权限组。

> 这样云空间权限不会顺带把用户本机磁盘也打开；管理员可以单独关掉本地空间能力。

## 5. 服务端接口

### 5.1 本地空间管理

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/local-spaces` | 当前用户的本地空间列表 + 当前激活项 |
| `GET` | `/api/local-spaces/browse?path=` | 浏览本机目录（仅 loopback）；空 `path` 返回盘符列表，用于绑定弹窗选择文件夹 |
| `POST` | `/api/local-spaces` | 绑定目录，body `{name,path,mode,allowSensitive?}` |
| `PATCH` | `/api/local-spaces/:id` | 改名称、mode、allowSensitive |
| `DELETE` | `/api/local-spaces/:id` | 软删绑定；不删除磁盘文件 |
| `POST` | `/api/local-spaces/:id/check` | 重新校验目录存在、可读/可写 |

绑定校验：

1. 必须是绝对路径，不能是相对路径；
2. `stat` 必须是目录，不能是文件；
3. `realpath` 后保存 `root_realpath`；
4. 拒绝盘符根目录（`C:\`）、Windows/Program Files/系统目录、UNC 网络路径（一期）；
5. `read_write` 模式必须实际创建并删除一个临时探针文件，确认可写；
6. 失败返回可读错误，不落库。

### 5.2 目录与文件

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/local-spaces/:id/entries?path=` | 列一层目录；`path` 为相对路径，空为根 |
| `GET` | `/api/local-spaces/:id/stat?path=` | 单文件元数据 |
| `GET` | `/api/local-spaces/:id/file?path=` | 读文本内容（默认 ≤ 5 MB） |
| `GET` | `/api/local-spaces/:id/download?path=` | 下载原文件 |
| `PUT` | `/api/local-spaces/:id/file` | 写文本，body `{path,text,expectedMtime?}` |
| `DELETE` | `/api/local-spaces/:id/file?path=` | 删除单个文件；仅 `read_write` 空间可用，永久删除 |
| `POST` | `/api/local-spaces/:id/move` | 移动/重命名，body `{from,to,overwrite?}` |
| `POST` | `/api/local-spaces/:id/mkdir` | 新建目录（可选） |

约定：

- 所有 `path` 都是相对空间根目录的路径，复用 `normalizeRelativePath` / `safeJoin`；
- 读文本返回 `{path,name,size,mtime,text,truncated,encoding}`；
- 二进制只返回元数据，不强行转文本；
- 目录列表默认 `limit 200`，目录在前、文件在后；
- 默认忽略 `node_modules`、`.git`、`.venv`、`dist`、`build`、`target` 等重目录，前端提供“显示全部”开关；
- 写文件采用“同目录临时文件 + rename”的原子写，避免半截文件。

### 5.3 文件预览复用

现有 `#file-pane` 可以继续复用，只需把 `filePreview` 从“云文件对象”扩展为：

```ts
type FilePreview = {
  kind: 'cloud' | 'local'
  id?: string          // 云文件 id
  spaceId?: string     // 本地空间 id
  relPath: string
  name: string
  size: number
  mtime?: number
}
```

- `file-pane-kicker` 按 `kind` 显示“云空间”/“本地空间”；
- 本地文件编辑保存走 `PUT /api/local-spaces/:id/file`；
- 本地文件删除走 `DELETE /api/local-spaces/:id/file?path=...`，预览页删除按钮只在 `read_write` 空间显示，二次确认后永久删除；
- 本地文件下载走 `GET /api/local-spaces/:id/download`；
- 云空间现有逻辑不动。

## 6. Agent 工具

### 6.1 云空间补齐

现有云空间只有列表和写，建议补：

- `workspace.read`：读云空间文本文件；
- `workspace.move`：云空间内移动/重命名；
- `workspace.write` 增加 `maxBytes` 校验和原子写。

### 6.2 新增本地工具

| 工具 id | 作用 | scope |
|---|---|---|
| `local.list` | 列目录 / 递归列文件（限条数） | `local-space:read` |
| `local.read` | 读文本/代码/文档抽取文本 | `local-space:read` |
| `local.write` | 创建或覆盖文本文件（编辑） | `local-space:write` |
| `local.delete` | 删除单个文件（不删目录） | `local-space:write` |
| `local.move` | 移动/重命名 | `local-space:write` |
| `local.mkdir` | 新建目录 | `local-space:write` |

执行规则：

- 工具参数只接受相对路径，拒绝绝对路径、`..`、盘符、UNC；
- 服务端用 `root_realpath` + `safeJoin` + `realpath` 双重校验；
- 不存在的目标文件，先校验父目录 realpath 仍在根内，再创建；
- 文本写入默认 ≤ 5 MB，二进制不通过 `local.write` 写；
- 工具结果不返回绝对路径，只返回 `relPath`、大小、mtime；
- 每次读写写 `appendAudit`，记录 `spaceId`、`relPath`、字节数、结果、traceId。

### 6.3 当前空间如何影响工具

`toolSpecsForActor` 增加第三个参数：

```ts
toolSpecsForActor(db, actor, { kind: 'cloud' | 'local' | 'none', spaceId?: string })
```

- `kind=cloud`：返回 `workspace.*`，不返回 `local.*`；
- `kind=local`：返回 `local.*`，不返回 `workspace.*`（避免模型同时看到两套路径空间而混用）；
- `kind=none`：两套都不返回；
- `runAgentTurn` 的 system prompt 增加一句：
  “当前文件空间：本地空间「demo」，所有文件路径都相对于该空间根目录；不要输出绝对路径。”

### 6.4 文档读取

一期先支持：

- 文本：`.txt` `.md` `.json` `.yaml` `.yml` `.csv` `.log`；
- 代码：`.ts` `.js` `.tsx` `.jsx` `.py` `.java` `.cs` `.go` `.rs` `.sql` `.html` `.css` 等；
- 图片：只返回元数据 + 预览，不把二进制塞进模型上下文。

二期再补文档抽取：

- `.pdf` 用 `pdf-parse`；
- `.docx` 用 `mammoth`；
- `.xlsx` 用现有表格能力或 `xlsx`；
- 抽取后截断到 token 预算，原文仍留在本地空间。

## 7. 前端改造

### 7.1 云空间改名与角标

`chat.html`：

```html
<div class="side-section-title side-section-title-row">
  <span>云空间</span>
  <span class="side-info-wrap">
    <button id="ws-info" class="side-info-badge" type="button"
      aria-label="查看云空间使用情况">i</button>
    <div id="ws-quota-popover" class="side-popover" hidden></div>
  </span>
  <button class="side-mini-btn" id="ws-upload" type="button">上传</button>
</div>
```

- 删除现在常驻的 `#ws-quota` 块，或把它改成 `hidden` 的数据容器；
- `renderWorkspaceQuota` 改为只更新浮层内容，不再渲染侧栏块；
- 角标 hover / focus 显示，`mouseleave` / `blur` 隐藏；移动端点击切换，点击外部关闭；
- 角标在用量 ≥85% 时变橙色，浮层里显示：
  - 已用 / 总容量 + 进度条；
  - 单文件上限；
  - 生效来源（个人配置 / 角色配置 / 默认配置，附角色 code）；
  - “文件保存在 EAB 服务端，换设备登录仍可见”。

### 7.2 本地空间分组

```html
<div class="side-section" id="side-local" hidden>
  <div class="side-section-title side-section-title-row">
    <span>本地空间</span>
    <button class="side-mini-btn" id="local-config" type="button">管理</button>
  </div>
  <div id="local-space-summary"></div>
  <div id="local-tree"></div>
</div>
```

状态：

- 未绑定：显示“绑定一个本机目录，AI 才能读写这里的文件” + “绑定目录”按钮；
- 已绑定：显示空间名、根目录（只显示路径，支持复制）、模式徽标（只读/读写）、目录树；
- 多个空间：标题旁下拉切换当前空间；侧栏只展开当前空间；
- 绑定弹窗：
  - 名称（可选，默认取所选文件夹名）；
  - 本地目录：点击“选择文件夹”在弹窗内浏览本机磁盘与目录，选中后自动回填绝对路径；也可手动粘贴路径；
  - 权限：只读 / 读写；
  - “允许读取敏感文件”开关（默认关）；
  - 绑定按钮。

> 浏览器原生目录选择拿不到绝对路径，所以目录浏览由本机服务端 `GET /api/local-spaces/browse?path=` 提供，前端渲染盘符与子目录列表。该接口只接受 loopback 请求，避免远程用户浏览服务器磁盘；服务端不在本机时仍可手动填写路径。选中目录后仍由 `validateLocalRoot` 做最终校验，盘符根、系统目录、UNC 等会被拒绝。

### 7.3 输入区空间 chip

在 `.composer-left` 增加：

```html
<button class="space-chip" id="space-chip" type="button" aria-haspopup="listbox">
  <span class="space-dot"></span>
  <span id="space-chip-label">云空间</span>
  <span class="caret">▾</span>
</button>
<div class="space-menu" id="space-menu" hidden></div>
```

菜单项：

- 云空间；
- 本地空间列表（每个显示名称 + 只读/读写 + 最近使用）；
- 不使用文件空间；
- “绑定本地空间…”。

发送时：

```js
{ modelId, text, attachments, sessionId, spaceKind, spaceId }
```

- chip 显示当前选择；
- 选中本地空间但目录失效时，禁止发送并提示重新绑定；
- 发送成功后把选择写入会话，`done` 后刷新当前空间文件列表；
- 用户消息气泡旁显示“云空间”/“本地 · demo”小标签，不显示绝对路径。

### 7.4 会话恢复

`openSession` 读取 `data.session.spaceKind/spaceId`：

- 本地空间仍存在：恢复选择；
- 空间已删除/目录失效：回退到云空间，并提示一次；
- `newSession` 默认云空间，或沿用当前选择（建议沿用，减少重复操作）。

## 8. 安全设计

### 8.1 路径边界

- 绑定：`path.resolve` + `fs.realpath`，存 `root_realpath`；
- 每次操作：`safeJoin(root_realpath, relPath)`，再做一次父目录/目标 `realpath` 校验；
- 目标不存在时，校验最近的已存在父目录 realpath 仍在根内；
- 拒绝 `..`、绝对路径、盘符、UNC、Windows 保留名、ADS、控制字符；
- 拒绝 symlink/junction 指向根外；根内 symlink 默认不跟随（或标记为不可读）。

### 8.2 敏感文件

默认拒绝：

```text
.env, .env.*, *.pem, *.key, *.p12, id_rsa*, id_ed25519*
.ssh/**, .aws/**, .gnupg/**, .npmrc, .pypirc
```

- 默认 `allow_sensitive=0`；
- 用户可在绑定/编辑时显式开启，UI 二次确认；
- 开启后仍记录审计，并在工具结果里标注“敏感文件”。

### 8.3 大小与频率

- 文本读取 ≤ 5 MB，超出只返回前 5 MB + `truncated`；
- 文本写入 ≤ 5 MB/次；
- 二进制上传/下载 ≤ 50 MB；
- 单次对话最多 20 次文件工具调用，防止模型递归扫盘；
- 目录列表 ≤ 200 条/层；递归 ≤ 500 条；
- 默认忽略重目录，避免 `node_modules` 卡死。

### 8.4 审计

每次操作记录：

```text
action: local.space.bind / local.file.read / local.file.write / local.file.move
resourceType: local_space / local_file
resourceId: spaceId / relPath
detail: { relPath, bytes, mode, result }
```

不记录文件正文，不记录敏感内容。

### 8.5 多用户

- `user_local_spaces` 按 `company_id + user_id` 隔离；
- 接口只返回当前用户自己的空间；
- 同一台机器上多个 EAB 用户共享 OS 账号时，绑定目录本身是用户显式行为；管理员可通过权限点关闭本地空间；
- 不把根路径暴露给其他用户或插件。

## 9. 部署边界

### 9.1 当前单机部署（一期采用）

EAB 服务端跑在用户本机，`D:\AI kaifa\EAB` 这类路径对 Node 进程可见，直接 `fs` 读写。

适用：

- 本机 `pnpm dev` / 本机安装包；
- 单公司本地部署。

### 9.2 远程部署（后续）

如果 8787 服务端在机房/云主机，用户浏览器在另一台电脑，服务端无法直接访问用户磁盘。需要增加“EAB 本地连接器”：

```text
浏览器 → EAB 服务端 → 本地连接器（用户电脑）→ 本地目录
```

- 连接器负责实际的 `fs` 操作；
- 服务端只转发已签名的空间/文件请求；
- 连接器需用户安装并授权目录；
- 本期不做，但数据表保留 `connector_id` / `host_kind` 扩展位，避免以后改表。

## 10. 分阶段实施

### Phase 0：云空间改名 + 角标（0.5 天）

- `chat.html` 改标题、加角标、删常驻配额块；
- `chat.js` 改 `renderWorkspaceQuota` 输出到浮层；
- `chat.css` 加 badge/popover；
- `file-pane-kicker` 改为“云空间”。

验收：

- 页面不再出现“个人工作区”；
- 配额不常驻，hover/focus/点击能看到完整信息；
- 移动端点击可打开/关闭。

### Phase 1：本地空间绑定 + 目录浏览（1.5–2 天）

- 迁移 `0027_local_space.sql`（建表/会话字段/权限点）与 `0028_local_space_scope_name.sql`（权限点命名对齐 `local-space:*`）；
- `user-local-space.ts` 路径校验/读写封装；
- `routes/local-spaces.ts` 管理 + entries + file 读；
- 前端“本地空间”分组、绑定弹窗、目录树、文件预览；
- 审计接入。

验收：

- 能绑定 `D:\Projects\demo`，刷新后仍在；
- 非法路径、文件路径、盘符根目录、UNC 被拒；
- 能展开目录、预览文本、下载文件；
- 不能通过 `..` 或软链接读到根外。

### Phase 2：对话空间选择 + Agent 读写（1.5–2 天）

- `chat_sessions` 加 `space_kind/space_id`；
- `/api/chat/messages` 接收空间选择并校验；
- `toolSpecsForActor` 按空间返回 `workspace.*` 或 `local.*`；
- 新增 `local.list/read/write/move/mkdir`；
- 输入区 chip、空间菜单、消息空间标签；
- `done` 后刷新当前空间列表。

验收：

- 选中本地空间后，对话能“列出文件 → 读某个文件 → 写一个新文件 → 移动/重命名”；
- 切回云空间后，本地工具不可见，云空间行为不变；
- 打开旧会话能恢复空间；
- 本地空间失效时能回退云空间。

### Phase 3：文档抽取 + 安全加固（1–2 天）

- PDF/DOCX/XLSX 文本抽取；
- 敏感文件拒绝/开关；
- 大小/频率/递归限制；
- 审计查询入口；
- 负向安全测试。

### Phase 4：可选增强

- 多本地空间管理完善；
- 文件 watcher + SSE 刷新；
- “在资源管理器打开”；
- 本地连接器（远程部署）；
- 带审批的代码执行（仅在你明确需要时）。

## 11. 验收清单

### 云空间

- [ ] 左侧标题为“云空间”，不再出现“个人工作区”；
- [ ] 角标 hover / focus / 点击可显示配额、单文件上限、配置来源；
- [ ] 角标不再常驻占位，侧栏高度不因配额块变化；
- [ ] 上传、预览、编辑、重命名、删除、配额逻辑不受影响。

### 本地空间

- [ ] 绑定合法目录成功，非法目录有明确错误；
- [ ] 刷新页面、重启服务后绑定仍在；
- [ ] 目录树能展开、文件能预览/下载；
- [ ] 只读空间不能写；
- [ ] 绝对路径、`..`、盘符、UNC、软链接逃逸全部拒绝；
- [ ] 敏感文件默认拒绝，开启后可用且审计；
- [ ] 大文件/深目录/重目录不会卡死。

### 对话

- [ ] 输入区能选择云空间/本地空间/不使用；
- [ ] 选中本地空间后，Agent 只拿到本地工具；
- [ ] Agent 能读、写、移动，不能越界；
- [ ] 消息上有空间标签，不泄露绝对路径；
- [ ] 切回云空间后云工具恢复，本地工具消失；
- [ ] 会话重新打开能恢复上次空间；
- [ ] 本地空间被删除/目录失效时能回退。

## 12. 需要你拍板的口径

1. **部署前提**：一期是否确认 EAB 服务端和本地目录在同一台 Windows 电脑上？
   - 推荐：是。远程部署的本地连接器放到 Phase 4。
2. **本地空间数量**：一个用户只绑定一个，还是可以绑定多个项目目录？
   - 推荐：数据模型支持多个，侧栏只展开当前一个，输入区下拉切换。
3. **绑定方式**：已按“点击选择文件夹”实现：绑定弹窗内浏览本机磁盘与目录，选中后回填绝对路径，同时保留手动输入兜底。
   - 目录浏览接口仅允许本机访问；远程部署时需改成本机连接器或只用手动输入。
4. **默认权限**：本地空间默认“读写”，并允许用户改成“只读”？
   - 推荐：默认读写；删除文件仍不开放给 AI。
5. **敏感文件**：默认拒绝 `.env`、私钥、`.ssh`，用户可显式开启？
   - 推荐：是。
6. **文档范围**：一期先支持文本/代码/Markdown，PDF/Word/Excel 放 Phase 3？
   - 推荐：是。若你希望第一期就能读 PDF/Word，我把文档抽取提前到 Phase 1。
7. **代码执行**：只写文件，不执行命令，是否符合你说的“写代码”？
   - 推荐：一期只写文件；执行命令需要单独的审批和沙箱设计。

## 13. 推荐落地顺序

先做 Phase 0（纯 UI，风险最低、当天可见），再做 Phase 1（绑定 + 浏览），最后接 Phase 2（对话工具）。这样即使本地空间后续调整，云空间改名和角标已经先交付，不会互相阻塞。
