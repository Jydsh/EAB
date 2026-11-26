# 云空间 / 本地空间 实现方案

> 目标：把现有“个人工作区”明确为“云空间”，并新增可绑定本机目录的“本地空间”，让对话可以按当前空间读取、写入、整理文件。
>
> 本文只做方案，不改代码。涉及“本地目录”的部分按当前单机部署前提设计：EAB 服务端与用户要访问的本地目录在同一台 Windows 电脑上。

## 0. 实施状态（2026-11-26）

一期“本地项目工作区”已落地并通过真实 UI 验收，实际命名和范围与下文原计划有以下差异：

| 项 | 已实现 | 说明 |
|---|---|---|
| 资源命名 | **本地项目（local project）** | 对外 UI 与接口统一用“项目”，表仍为 `user_local_spaces` |
| REST 接口 | `GET/POST/PATCH/DELETE /api/local-projects`、`GET /api/local-projects/:id/files?path=&depth=&limit=` | 计划里的 `/local-spaces`、`entries/file/download/move/mkdir` 未采用 |
| Agent 文件工具 | `project.list`、`project.read`、`project.search`、`project.write`、`project.edit`、`project.delete` | 计划里的 `local.move/mkdir` 未实现；`project.delete` 只删文件、不递归删目录，且逐次审批 |
| 会话字段 | `chat_sessions.space_kind='local'` + `space_id` | 与计划一致 |
| 权限 | `local-space:read/write` | 与计划一致 |
| 桌面目录选择 | Electron `eab:pick-directory` 选目录；创建项目弹窗含项目名称、工作目录、云端资源、项目指令 | 仅桌面端可创建；Web 端不显示创建入口 |
| 桌面文件桥 | `POST /register`、`GET /jobs`（20s 长轮询）、`POST /jobs/:id/result`、`GET /status`；任务经桥转发到桌面端 | 服务端可远端部署；项目文件永远只在桌面电脑上 |
| 桌面浏览器桥 | 同一桥新增 `kind='browser'` 任务；`POST /api/desktop/bridge/tabs` 上报标签 | Agent 可读取/操作右侧 Electron 原生标签；仅桌面端可用，Web 端 409 |
| 会话类型 | `chat_sessions.project_mode='chat' \| 'task'` | 项目下直接挂会话；侧栏不再显示「对话 / 工作任务」分组标签，任务用图标区分；项目主页已不再是入口 |
| 命令执行 | 桌面设备绑定的项目本期不开放 `project.exec`（403） | 需要构建/测试时由用户在桌面终端手动执行 |
| 未落地 | 云端资源内容读取、配额统计、文件下载、图片预览、目录移动/删除 | 云端资源本期只做选择、存储和提示词清单 |
| 验证 | `typecheck` 通过；项目/系统提示/审批 20+ 用例通过；真实桌面端完成弹窗选目录创建、项目侧栏纯文件夹、输入区项目归属选择与刷新恢复、项目内会话菜单、项目操作菜单与桥任务 | 2026-11-26 侧栏与项目选择器验收 |

> 2026-11-26 二期已改为“桌面端绑定真实目录 + 服务端文件桥代理”：本地项目只能在桌面端创建，服务端可与桌面不在同一台电脑；文件读写经 `register / jobs / result` 长轮询任务转发到桌面端执行。服务端只保存 deviceId、显示路径、真实路径快照、项目指令和云端资源清单，不直接访问客户端磁盘。详见 §0.1。

### 0.1 二期落地：桌面项目与文件桥（2026-11-26）

- 创建入口只在桌面端：侧栏顶部固定导航「更多 → 新建项目」，弹窗字段为项目名称、工作目录、云端资源、项目指令；Web 端隐藏项目区，`POST /api/local-projects` 强制要求 `x-eab-desktop:1` 和在线 `deviceId`。
- 服务端不直接访问客户端路径：创建时经桥 `describeRoot` 让桌面端校验目录并回传 `rootRealPath`；文件 `list/read/search/write/edit/delete` 全部转成桥任务，任务只带相对路径。
- 桌面端保存 `projectId -> root` 绑定表；`local-files.mjs` 做绝对路径、可写、危险根、越界、符号链接逃逸和敏感文件闸。
- 项目侧栏收口为一个可折叠的本地文件夹：项目行只保留文件夹图标、名称和更多菜单，不显示展开/收起箭头，也不显示“桌面端在线/离线”；项目下直接挂对话，任务用图标区分，不再显示「对话 / 工作任务」分组标签或绿色“＋ 新建对话”按钮；项目文件树不再占用左侧栏。
- 项目内会话复用普通会话菜单，支持悬浮“⋯”和右键重命名、删除；新建项目或新建项目会话后只展开项目，不再进入项目主页。项目操作菜单保留新建对话、新建工作任务、打开文件夹、重命名、移除项目。
- 输入区「云空间」chip 改为豆包式项目选择器：列出当前账号的项目，当前项目行显示根路径、桌面在线状态和勾选，底部为“创建新项目（仅桌面端）/ 不使用项目”；选中项目直接通过 `PATCH /api/chat/sessions/:id/space` 把已有会话归属到该项目，未落库的新对话只更新前端待发送状态；选择“不使用项目”退回云空间。网页端不显示创建入口，但可选择同账号的远程项目。
- 项目主页代码暂留但不再是任何入口；`#project-pane` 保持隐藏，后续可单独清理。
- 删除项目只解除项目绑定，不删除磁盘文件；项目内的对话和工作任务会一并逻辑删除；桌面端离线时项目可见，文件操作仍会返回桌面桥错误提示。
- 项目文件删除：新增 `project.delete`，只允许删除文件，不递归删除目录；命令经桌面桥 `delete` 在客户端执行，服务端本机项目走同语义卸载；`mode='read_only'` 时拒绝，工具风险等级为 `irreversible`，每次执行都要审批。
- 2026-11-26 第十三轮把同一个桌面桥扩成通用任务桥，新增 `kind='browser'`：Agent 的 `browser` 工具按 `x-eab-desktop-device` 路由到桌面主进程，对右侧 `WebContentsView` 执行 `list/open/activate/snapshot/click/type/scroll/navigate/back/forward/reload/screenshot/close`，不再只看服务端 Playwright 页面。
- 标签持久化：主进程把 `{ownerUserId,activePageId,tabs}` 写入 `desktop-config.json` 的 `browserTabs` 并上报服务端；聊天页刷新只隐藏原生视图、不销毁，应用重启按 URL 恢复；前端另用 `localStorage` 键 `eab.chat.browserTabs.v1:<person.id>` 保存草稿与布局。换账号或换服务器会清空旧标签，避免登录态泄露。
- 审批：`list/snapshot/screenshot/scroll/activate` 免审批；`open/navigate/click/type/back/forward/reload/close` 记 `tool:browser` 并逐次审批。
- 验收：真实桌面端完成刷新保留标签、重启恢复 3 个标签、Agent `snapshot` 读取 example.com、`click` 跳到 IANA、`type` 写入百度搜索框且不提交、`open` 新标签并同步前端标签栏、`screenshot` 在云空间生成 44 KB PNG、`close` 关闭标签后前端剩 3 个、`reload` 重新读出 IANA 页面、`back/forward` 调用成功（单页历史未产生位移）；`typecheck`、26 个项目/提示用例、13 个审批用例通过。
- 未验收：真实长页滚动位移、多页历史下的 `back/forward` 跳转；失效 URL 可能恢复成空白标签。
- 桌面端本地项目读取修复（2026-11-26）：旧安装包 `preload.cjs` 缺 `getDesktopInfo/pickDirectory/bindProject`，`main.mjs` 缺 `local-files`，导致新建项目弹窗一直停在“正在读取桌面设备…”。根因是桌面包过旧，不是 Windows 权限。构建脚本 `build-win-portable.mjs` 又漏拷 `main.mjs` 启动即 import 的 `local-files.mjs`，已补齐。修复后安装版能读取设备、点击“添加本地文件夹”可打开 Windows 原生目录对话框、`bindProject/unbindProject` 可用；新建的便携包和 Setup 均已重建，版本仍 `2026.11.24`，同版本旧客户端需手动重装。
- 豆包式桌面侧栏第一轮（2026-11-26）：顶部固定导航改为「新工作任务 / 新对话 / 工作台 / 定时任务 / 插件·技能·伙伴 / 云空间 / 更多」，中部滚动区直接显示项目及项目会话，再显示「最近」独立会话；底部收成紧凑账号 + 设置。云空间不再常驻侧栏文件列表，点击顶部「云空间」打开右侧面板；原上下拖拽条、配额角标、项目/新建项目标题和新建按钮从侧栏 DOM 移除。新增 `#schedule-modal` 展示员工端 `GET /api/schedules` 并支持暂停/恢复/刷新；新增「更多」浮层承载新建项目、打开云空间、管理后台（按权限显隐）和设置。会话行统一加线性图标，任务用方框笔图标。详见总体架构 23.3.7.7。

### 0.2 第二轮：入口即时性、顶部信息卡与网页远程项目（2026-11-26）

- **新会话即时入列**：`openNewSession(mode)` 统一“新工作任务 / 新对话”。云空间也会 `POST /api/chat/sessions` 创建 `projectMode=task|chat` 的会话并立即 `loadSessions()`，不再等首条消息；已有同类型空白会话时只回输入框，不叠加空记录。`newSession({create:false})` 保留给启动引导和定时任务草稿。**该做法已在 §0.5 收口：改为首条用户消息后才落库，空会话不进列表。**
- **头部语义拆开**：标题显示会话自己的 `title`；项目名单独放 `#chat-project-badge`，任务徽标只由 `projectMode='task'` 控制，网页端另有 `#chat-device-badge`。首条消息发送后若标题仍是“新对话 / 新工作任务”，前端用首条文字更新标题，服务端 `ensureSession()` 对默认标题补一次自动命名，用户手改过的标题不覆盖。
- **个人信息卡上移**：`#side-user` 从 `.side-bottom` 移到品牌区下方、固定导航上方，展示头像、姓名、职位、公司/部门、在线点；底部只保留“设置”。
- **空项目不占位**：`renderLocalProjects()` 在 `projects.length === 0` 时整块收起 `#side-projects`，不再渲染“还没有项目”空态。
- **网页端远程项目**：`GET /api/chat/sessions` 增加 `projectDeviceOnline`，历史接口和 `PATCH .../space` 返回 `project.deviceOnline`。网页“最近”混排 `spaceKind='local'` 会话并显示项目名与设备状态；打开会话恢复项目、项目指令和 `spaceId`；输入区项目选择器可切换远程项目，网页端不显示创建入口。文件操作带 `deviceId` 经桌面桥转发，因此另一台电脑只要项目所属桌面在线，就能继续对话并读写该项目文件。
- **验收**：临时远程项目会话在网页“最近”第 3 条出现，头部显示“远程项目验收 / 远程项目任务 / 工作任务 / 桌面在线”；在该会话发送“只回复 OK，不要调用任何工具”后返回 `OK`（Kilo Auto Free，70.1 tok/s）；依次新建工作任务、新对话后列表立即增至 4、5 条，任务徽标只在任务会话出现；清理后回到 2 条且项目区隐藏。`node --check chat.js`、`typecheck` 通过，`chat-session-space-route.test.ts` 2 条、`local-project.test.ts` 5 条通过。
- **边界**：远程项目只开放文件读写，不开 `project.exec` / 远程 shell；构建、测试、启动服务仍要在项目所属电脑本地执行。REST 直接创建的项目不会自动进入桌面桥 `bindings`，正常从桌面端“新建项目”创建才会绑定；旧安装包仍是 `2026.11.24`，需重装或更新后才能看到本轮 UI。

### 0.3 第三轮：项目入口与标签页会话隔离（2026-11-26）

- **云空间降为平台能力**：云空间本来就所有对话都有，不再做成输入区可选项。输入区绿色“云空间”胶囊改为豆包式中性灰“项目”胶囊：线性文件夹图标 + “项目” + 右箭头；未归项目显示“项目”，归项目显示项目名。菜单仍是项目列表 / 创建新项目 / 不使用项目，其中“不使用项目”只表示不挂项目，不表示失去云空间。
- **标签页按会话隔离**：`eab.chat.browserTabs.v2:<userId>:session:<sessionId>` 一对话一份快照，无会话用 `:draft`。切会话前先保存旧会话，再清空当前标签并通知桌面主进程切到新会话；只恢复目标会话自己的标签和工作台状态。没开过标签的对话，右侧网页栏整块隐藏；开过的切回时恢复。
- **修复恢复竞态**：`browserTabsLoadedScope` 用 `null` 表示未恢复，`persistBrowserTabsNow()` 在恢复完成前拒绝写入。否则切会话时“先清空、后恢复”的 250ms 防抖会把该会话快照写成空数组，导致切回来没有标签。
- **桌面主进程**：新增 `activeChatSessionId`、按会话的 `browserTabsPayload`、`setActiveChatSession`、v2 持久化 `{version:2, ownerUserId, activeSessionId, sessions}`；每个原生页带 `sessionId`，打开、关闭、激活、bounds、show、Agent browser 动作都校验当前会话。IPC 新增 `eab:set-browser-session`，`eab:browser-tabs` 接收 `(userId, sessionId)`。
- **服务端桥**：`browserTabsBySession` 按会话存快照，每设备保留最近 40 个对话；系统提示和桌面 `browserCall` 都传 `sessionId`。
- **验收**：网页端“项目 >”胶囊显示正常；A 会话开标签后切到“钉钉·对话”右侧隐藏、标签为空，切回 A 恢复“新标签页”，刷新后仍恢复。桌面端源码启动实测草稿标签、真实 `example.com` 原生标签、切走隐藏、切回恢复、重启恢复全部成立；`node --check` 三文件、`typecheck` 通过，`desktop-bridge-tabs` 2 条 + 会话归属 2 条 + 本地项目 5 条共 9 条通过。
- **边界**：云空间默认空间与文件工具未改；桌面原生视图是隐藏保活，未做销毁/LRU；旧全局标签只在空草稿兜底；已删除会话的 v2 快照不会自动清理；安装包仍为 `2026.11.24`，打包版需重建后才能看到本轮 UI 与主进程逻辑。

### 0.4 第四轮：云空间头部、右键与拖拽上传（2026-11-26）

- **头部补齐**：右侧云空间面板顶部增加“新建文件夹”“上传”，和刷新按钮并列；新建与上传都作用于当前面包屑目录。上传改用独立的 `#cloud-upload-input`，不再借用侧栏工作区的文件选择。
- **右键菜单**：文件和文件夹行都在 `contextmenu` 打开 `#file-menu`，并带 `dataset.scope='cloud'`。文件项为打开、下载、重命名、编辑、发送到钉钉、删除；文件夹项为打开、新建子文件夹、新建文件、重命名、删除；共享文件夹的整体重命名/删除限制不变。
- **空白区菜单**：`#cloud-pane-body` 空白处右键出现“新建文件夹 / 新建文件 / 上传文件”，标题显示“云空间 / 当前路径”；新建文件弹窗先检查同名文件和文件夹，避免覆盖。
- **拖拽上传**：云空间面板监听 `dragenter/dragover/dragleave/drop`，只接受外部文件（排除侧栏文件拖拽的自定义 MIME）；拖入时显示“松开即可上传 + 目标目录”虚线遮罩，`drop` 后按当前目录逐个上传，并复用现有上传进度条。
- **状态同步**：`loadWorkspaceFiles()` 和 workspace 删除事件都会同步重渲染云空间面板；文件夹重命名/删除同时修正 `state.cloudSpacePath`，避免停留在已失效路径。
- **验收**：网页端新建文件夹、进入空目录新建文件、文件选择上传、拖拽上传、文件重命名/删除、文件夹删除全部通过；桌面端源码调试端口实测头部按钮、文件右键、空白右键和拖拽上传一致，验收后恢复普通启动。`node --check`、`typecheck`、15 条相关测试通过。
- **边界**：拖拽不递归上传文件夹；单文件上限沿用 50 MB 面板限制；新建文件只创建空文件；安装包仍为 `2026.11.24`，未重建。

### 0.5 第五轮：空草稿与会话标签收口（2026-11-26）

- **空对话不进列表**：`enterBlankDraft()` 只在内存建草稿，`state.sessionId=null`；首条消息由 `ensureSession()` 落库并取第一句话前 24 字作标题。`GET /api/chat/sessions` 在路由层批量检查 `chat_messages` 是否存在 `role='user'`，无用户消息的预创建会话/历史空会话不返回；SQLite 与 PostgreSQL 读源共用该过滤。
- **空草稿切走即丢弃**：`persistBrowserTabsNow()` 对空 scope 直接返回并删除 `:draft` 快照；`restoreBrowserTabsForSession('')` 不读旧 draft，清空标签。切到工作台、切到正式会话、换新任务类型都调用 `discardDraftSession()`，关闭草稿中的真实网页页并清掉云空间/文件/团队/审批。
- **标签按会话常驻**：v2 快照增加 `shell`，除网页标签外保存 `cloudSpaceOpen/cloudSpacePath/teamTabOpen/permOpen/filePreviewId/filePreviewSplit/workbenchTab/workbenchCollapsed/workbenchSplit`。`switchBrowserTabScope()` 先保存旧正式会话，再清空并恢复目标会话；文件按 id 异步重开，云空间按路径刷新，审批重新加载。
- **首条消息收养标签**：`meta` 返回新 sessionId 后，`adoptBrowserTabsForSession()` 把空 scope 的网页标签、云空间、文件等整体归入正式会话；桌面端新增 `eab:adopt-browser-session`，只收养列出的 `sessionId=''` 原生标签。
- **文件不再自动关**：`setChatMode()` 去掉无条件 `closeWorkspaceFile()`，切对话/切模式不会自动关文件标签；只有用户点 × 关闭。
- **验收**：空 POST 会话 `visible=false`；草稿开标签后左侧列表不变、`:draft` 为空；A/B 的云空间、文件、网页标签互不串且切回恢复；刷新恢复云空间；首条消息后标题、列表、scope 与标签归属一致。`node --check`、`typecheck`、16 条相关测试通过。
- **边界**：旧空会话只隐藏不删除；草稿发送后立即切走的竞态未覆盖；桌面安装包仍为 `2026.11.24`，需重建后才能获得新 IPC。桌面打包版本已改为读取项目根 `package.json`，与网页 `/api/health` 同源，不再单独取 `packages/desktop/package.json`。

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
- **2026-11-26 调整**：云空间是所有对话自带能力，不再作为用户可选空间。输入区入口改为豆包式“项目”胶囊，只负责选择当前对话归属的项目；具体见 `0.3`。

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
2. 当前 EAB 是单机本地部署，Node 服务进程本身就在用户电脑上，所以一期可以让服务端直接读写用户指定目录。**二期已改为桌面文件桥，不再依赖这个前提**，服务端可在远端。
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

### 9.2 远程部署（二期已落地）

如果 8787 服务端在机房/云主机，用户浏览器在另一台电脑，服务端无法直接访问用户磁盘。二期已经用桌面文件桥实现这条链路：

```text
浏览器 → EAB 服务端 → EAB 桌面端（安装在那台电脑上）→ 本地目录
```

- 桌面端负责实际的 `fs` 操作，服务端只转发任务，不直接访问客户端磁盘；
- 服务端按 `companyId + userId + deviceId` 隔离设备，任务只带相对路径；
- 桌面端需用户安装、登录并在线；项目只能在桌面端创建；
- 数据表用 `user_local_spaces.device_id` 标识设备，不再需要单独的 `connector_id`。

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
