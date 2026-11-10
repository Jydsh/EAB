# dsh-mrrp

MRRP（Model Routing & Resource Planning）控制台：DSH 的模型路由与管理插件。

管理**模型分类**、**路由配置**、**决策模型配置**、**角色 / 部门** 与 **用户**，让不同角色 / 部门的请求路由到指定分类下的模型。

- 版本：2026.11.07
- 兼容：DSH 0.2.1-rc.2（profiles: web / desktop）
- 协议：TS 优先，client 侧混合 JS（零 JSX，`__ModuleLoader__.load` + 手写 `h()`）

## 功能

| 页面 | 能力 |
| --- | --- |
| 模型分类 | 上下布局：上左 = 路由配置（策略 / 负载均衡 / 超时 / 重试 / 兜底 / 故障切换 / 启用开关）；上右 = 模型分类列表（新建 / 编辑 / 删除 / 默认分类保护 / 选中高亮）；下 = 整宽模型列表（搜索 / 刷新 / 每行“未分类 ↔ 分类”绑定下拉） |
| 路由配置 | **决策模型路由**：启动决策模型开关 / 决策模型（**可多选**，选中提供方及其全部模型合成并发池，按最少在途自动分摊，全部在忙才排队）/ 兜底模型（原生下拉框，选项 `provider:model`，未设置显示「未设置（使用默认模型）」）/ 未注册用户策略 / 渠道。启用后插件向 DSH 对话暴露虚拟模型「MRRP 智能路由」，选中即按发送者用户权限路由真实模型回复（判定问题插件内置，无需配置） |
| 决策模型配置 | 决策模型提供方绑定：新增 / 编辑 / 删除 / 测试连接 / 获取模型，支持本地判定服务（如 laya-server）、云端判定服务、OpenAI 兼容对话判定（llama.cpp / vLLM 等） |
| 角色部门 | 双栏：角色 + 部门（新建 / 编辑 / 删除；角色 ↔ 部门多对多双向同步，任一页配置另一页自动显示；角色多选模型分类，每个分类可单独勾选角色可用的模型，**可勾选范围 = 该分类在「模型分类配置」页已绑定的模型**；角色列表可设**唯一「默认角色」**——dsh-im 新同步用户自动赋该角色，切换默认角色会提示原默认角色；部门为树形——点击部门展开子部门与部门内用户（用户只在**其直接绑定**的部门下显示，上级部门不汇总显示），新建 / 编辑可选上级部门收纳为子部门） |
| 用户 | 用户表格 + 搜索 + CRUD（ID = dsh-im 的 senderId 唯一标识；绑定角色 / 多部门 / **权限（可多选）**；未绑角色时自动使用所属部门绑定的角色；表格「权限」列如实显示自身 + 角色 + 部门继承来的权限，一条都没有时红色标注「未绑定·拒绝」） |
| 权限 | 侧边栏「角色部门 → 权限」：权限规则的增删改 + 「未绑定用户的默认权限」（默认 = 拒绝）。每条权限配 **6 个粗粒度能力开关**（对话应答 / 写文件 / 执行命令 / 插件管理 / 电源操作 / 接管桌面）、**会话沙箱**（只读 / 仅工作区可写 / 完全访问）、**审批策略**（每次询问 / 从不询问）、**工具白名单**（留空按能力开关判定）。内置三条（只读应答 / 标准操作 / 管理员）不可删除，被误删会自动补回；危险权限在列表里显式告警 |
| 模型列表（模型分类页下） | 模型搜索 / 刷新 / 分类绑定；每行可维护**模型画像**（擅长类型**可多选**，勾选后**实时自动保存**，无需保存按钮；勾选「其他」时下拉面板右侧浮动出擅长场景输入框，手动输入后自动保存，决策时即以该内容为场景）——**覆盖分类画像**，多选类型全部随候选带进 Laya 决策问题（如「类型：代码、推理」）；**擅长类型下拉框的选项来源「类型/场景」列表，随其增删实时同步** |
| 类型/场景（模型列表下） | 侧边栏「模型管理 → 类型/场景」：展示**全部类型/场景**（默认：推理 / 对话 / 代码 / 视觉 / 长文本 / 多模态 / 工具调用 / 快速 / 其他），可**手动添加 / 删除**，改动即保存；模型列表「类型/擅长场景」下拉框的**数据源始终来自此列表** |
| 日志管理 | 侧边栏「日志管理 → 日志」：路由决策日志**按天分文件**（`route-decision-YYYY-MM-DD.log`）列表，最新在前；「详情」在表格下方以**底部边栏**展开（表格压缩在上方滚动区，点任意行无需滚动即可见原始记录），元信息胶囊 + 深色 JSON 语法高亮，最小高度 240px 区内滚动。「日志设置」页：配置**日志存放目录**（绝对路径 / 留空用默认，保存前探测可写性）、**自动清理保留天数**（1~365）、**立即清理全部日志**（确认弹窗）、查看**全部历史日志文件**（整文件清理需确认 / 展开「管理」按关键词删除或逐行勾选批量删除；文件名白名单防路径穿越） |
| 设置抽屉 | 侧边栏入口 auto / show / hide + 插件信息 / 模型统计 / 配置路径 / 模型发现状态 |

侧边栏可折叠；深色青绿（#38C7BC）为原型视觉基调，DSH 内适配浅色主题（`--dsw-alias` 变量）。

## 安装

从 [GitHub Releases](https://github.com/Jydsh/dsh-mrrp/releases) 下载对应版本的 `dsh-mrrp-<version>.tgz` 安装包，按你的 DSH 环境执行：

### 桌面版

```bash
dsh plugin --profile desktop add ./dsh-mrrp-2026.11.07.tgz
```

### Web 版

```bash
dsh plugin --profile web add ./dsh-mrrp-2026.11.07.tgz
```

> `dsh plugin` 必须显式指定 `--profile`（DSH 的插件管理命令，转发给对应 profile 的 pnpm）。安装后**重启 DSH**（桌面版重启桌面端、Web 版重启 Web 端）插件即生效。

### 源码目录（开发模式，跳过打包）

```bash
dsh plugin --profile desktop add D:/dsh/dsh-mrrp
```

安装完成后，在 DSH 侧边栏找到 **MRRP** 进入控制台：先到「模型分类」页创建分类并绑定模型 →「角色部门」页建角色并勾选分类模型 →「决策模型配置」页新增并启用 Laya 提供方 →「路由配置」页启动决策模型路由并选择兜底模型 → 对话模型选择器选中「MRRP 智能路由」即可按用户权限路由。

### 版本检查与更新

打开 MRRP 控制台时会**自动检查 GitHub 最新 Release**（读取 `api.github.com/repos/Jydsh/dsh-mrrp/releases/latest`，失败回退 `releases.atom`）；有新版本时顶部版本号变为 `v当前 ↑ v最新` 并出现更新横幅，点击版本号或横幅的**「立即更新」**即由插件自己完成升级，**不需要卸载重装**，重启 DSH 后生效。

插件按「目标版本号与已装版本号是否相同」决定走哪条命令：

| 本机情况 | 插件执行 | 为什么 |
| --- | --- | --- |
| 装了旧版本（版本号不同） | `dsh plugin --profile <当前 profile> add "<新版本安装包>"` | 把 profile 的声明指到新版本，就是原地升级 |
| 版本号没变（只替换了 Release 资产） | `dsh plugin --profile <当前 profile> update dsh-mrrp` | 同一个 spec 再 `add` 会被 pnpm 判「Lockfile is up to date」跳过，只有 `update` 会重新解析 tarball |

CLI 降级顺序相同：只有 `pnpm` 时用 `pnpm add` / `pnpm update`，只有 `npm` 时用 `npm add` / `npm update`，命令都在当前 profile 目录下执行。

安装来源按 profile 的 `package.json` 判断：用 `github:` / codeload 安装的走 `github:<repo>#v<版本>`，其余走 Release 的 `.tgz`（tgz 不受 pnpm 的 git 依赖构建脚本白名单限制）。

插件不会执行更新的两种情况：**link 安装**（`link:` 或指向目录的 `file:`，装的就是工程目录本身，更新请直接改工程）；**认不出当前 profile**（先让你在横幅里选，见下节）。自动执行不了时，横幅仍保留「复制命令」兜底。

顶部版本号也可随时点击手动检查更新。仓库路径默认指向本插件仓库 `Jydsh/dsh-mrrp`；不同插件仓库不同，可在 `config.json` 增加 `updateRepo` 字段（如 `"updateRepo": "Jydsh/dsh-mrrp"`）覆盖检查来源。

### 多环境隔离（桌面版与 Web 版同机安装）

同一台电脑同时装了桌面端与网页端时，插件**只认自己所在的那一个 profile**，判定顺序如下：

1. 自身被真实加载的路径里带 `.dsh/profiles/<profile>/`（正常安装最准）；
2. 宿主给出的 `DSH_PROFILE`；
3. 你之前在界面上选过并记住的 profile；
4. 扫描 `~/.dsh/profiles` 里装了本插件的 profile，**只有唯一命中才采信**。

两个 profile 都装了本插件、又看不出自己是哪一个时，插件**不会猜**：横幅会列出候选（例如「desktop 更新」「web 更新」），点哪个就更新哪个，并记住这次选择，下次启动直接按它走。

运行数据同样按 profile 分开：

| 内容 | 位置 |
| --- | --- |
| 配置 / 路由决策日志 | `~/.dsh/integrations/dsh-mrrp/profiles/<profile>/`（`config.json` 与 `route-decision-YYYY-MM-DD.log`）——日志目录可在「日志设置」页改成任意绝对路径，改后不再写这里 |
| 旧的全机共享配置 | `~/.dsh/integrations/dsh-mrrp/config.json`——各 profile 首次启动时**复制一份**过去，只复制不删除，之后各自独立演化 |
| 手动选择的 profile | `~/.dsh/integrations/dsh-mrrp/profile-selection.json` |

profile 实在认定不出（例如候选为 0）时，配置回退到原来的共享位置：宁可共用，也不会把配置写到看不见的地方。

## 架构

```
host（TS，lib/*.ts → dist/）
  ├─ models.ts       只读发现 ctx.llm 模型（listProviders / listModels），绝不拦截主链路
  ├─ store.ts        ~/.dsh/integrations/dsh-mrrp/config.json 持久化（先写 .tmp 再 rename，原子写）
  ├─ rpc.ts          POST /api/mrrp 管理通道，22 个方法
  ├─ route-engine.ts 会话发送者映射 + 目标模型决策：订阅 DSH 会话事件（观察）记录「会话 → 发送者」；按用户（角色 + 部门）分类模型并集去重，候选多个时用内置判定问题（builtinModelChoiceQuestion）请 Laya 决策
  ├─ route-adapter.ts 决策模型路由 adapter：注册到 ctx.llm.registerAdapter(['mrrp'])，暴露虚拟模型「MRRP 智能路由」；stream 内解析发送者 → 决策真实模型 → ctx.llm.stream 代理转发
  └─ index.ts        apply：store.load → installRpc(ctx.inject(['connection','llm'])) → imRouting.start() → registerAdapter → effect dispose → provide dshMrrpClient

client（JS，lib/client.js，__ModuleLoader__.load 打包进 DSH）
  ├─ 五页导航（路由配置 / 决策模型配置 / 模型分类 / 角色部门 / 用户）+ 可折叠侧边栏 + 设置抽屉
  └─ 经 ctx.connection.rpc.call('/api','mrrp',{method,payload},signal) 调用 host
```

## RPC 通道

- 路径：`POST /api/mrrp`（`connection.fetch.register`，`requestBody: 'buffered'`）
- 请求：`{ type:'client-request', rpcId, method:'mrrp', payload:{method, payload} }`
- 响应：`{ type:'server-response', rpcId, result:{ ok, value | error:{code,message,details} } }`

### 方法

| 方法 | 说明 |
| --- | --- |
| `status` | 插件状态 / 模型统计 / 配置统计 / 模型发现异常 |
| `providers.list` / `models.list` | 只读列出提供方与全部已发现模型 |
| `config.get` / `config.save` | 读取 / 覆盖全量配置 |
| `categories.list / create / update / delete / bind / unbind` | 分类管理（同名去重 `duplicate-name`；默认分类受保护 `default-protected`；一个模型只属一个分类） |
| `route.get` / `route.save` | 路由配置（含 `imRoute` 决策模型路由配置） |
| `route.im.status` | 决策模型路由引擎运行状态（订阅 / 启用 / 决策模型 / 映射会话数 / 最近一次映射） |
| `roles.list` / `roles.save` | 角色（含部门列表；保存时按 `deptIds` 反向推导 `dept.roleIds` 实现双向同步） |
| `depts.list` / `depts.save` | 部门（含角色 / 用户列表；保存时按 `roleIds` 反向推导 `role.deptIds` 实现双向同步；`parentId` 构建部门树，悬空上级自动提升为顶级，循环引用会被拒绝） |
| `users.list` / `users.save` | 用户（含角色 / 部门 / 权限；`deptIds` 支持多部门；`permissionIds` 为用户自身绑定的权限；列表自动把 dsh-im 首次出现的发送者补为缺失用户） |
| `users.resolve` | 按 senderId 解析：不带 senderId 返回 dsh-im 发送者列表；带 senderId 解析姓名，用户表不存在时默认自动创建（`create:false` 仅解析） |
| `users.syncIm` | 手动触发 dsh-im 自动同步，返回 `{created, users, roles, depts}` |
| `permissions.list` / `permissions.save` | 权限规则表 + 未绑定用户的默认权限（空串 = 拒绝）；内置三条入住时缺失自动补回；`defaultPermissionId` 必须存在于权限表，否则 `unknown-permission` |
| `permissions.resolve` | 按 `用户自身 → 用户角色 → 用户部门 → 部门角色` 解析某个用户的最终权限（`{bound, ruleIds, sources, caps, sandbox, approval, toolAllow, summary}`），控制台用来核对绑定是否真的生效 |
| `sidebar-entry.get` / `sidebar-entry.set` | 侧边栏入口 auto / show / hide |
| `decision.list` | 决策模型提供方列表 |
| `decision.save` | 新增 / 更新决策模型提供方（`{ provider }`，无 id 自动生成） |
| `decision.delete` | 删除决策模型提供方（`{ id }`） |
| `decision.fetch` | 拉取模型列表：openai→`GET {base}/v1/models`、generic→`GET {base}/models`、laya→返回内置检查点（manual） |
| `decision.test` | 测试连通性：laya→真实 `POST /v1/systemone`、其余→拉列表，返回 `{ok,message,latencyMs}` |
| `decision.pool.stats` | 决策模型并发池状态：按当前选中提供方展开每个槽（提供方 + 模型），返回实时在途 / 成功 / 失败 / 冷却与当前池配置 |

## dsh-im 用户打通

- **唯一标识**：用户 `id` 直接使用 dsh-im 对话里的 `senderId`（钉钉场景即 staffId），不再强制 `usr_` 前缀；可解析出该用户的姓名（`sender_name`）。
- **自动建用户**：插件后台**只读轮询**（默认每 60s，`config.autoSyncIm=false` 可关闭）下面这几类只读源，首次出现的发送者自动创建用户（id = senderId、姓名 = 能拿到的姓名、角色 / 部门留空）。用户页「同步 dsh-im」按钮可手动触发。
  1. **dsh-dingtalk 桥 `bots/<botId>/state.json`**（主来源）：`sessions` / `recentOutboundMessages` 里的 `p2p:<staffId>` 就是**当前真实在用的发送者**——只走单聊时这个源最可靠。群聊键 `group:<chatId>` 拿不到唯一发送者，跳过。
  2. **dsh-im 群历史库 `dsh-im/group-history.sqlite`** 的 `messages` 表：`sender_id` + `sender_name`。注意它**只落群消息**，纯 p2p 场景下这张表可能是空表（0 行），不能只看它。
  3. **dsh-ding-card `user_names.json`**（`dsh-ding-card/profiles/<profile>/` 优先，也兼容根级旧布局）。
  4. **dsh-dingtalk `config.json` 的 `bots[].approvedSenders`**。

  上面前两项提供「谁」，后两项补「叫什么」；姓名全部缺失时用 senderId 兜底（控制台可手动改名）。多 profile 并存时 `profiles/*/` 下的库与 JSON 都会被扫到。

- **自动添加默认角色**：在「角色部门 → 角色」列表可把某个角色设为**唯一默认角色**（金色徽标标注；切换时提示原默认角色；默认角色禁止直接删除）。dsh-im 新同步 / 自动创建的用户自动赋该默认角色（走「直接角色」显式授权路线）；已存在用户不受影响；未设默认角色时新用户不赋。
- **新建 / 编辑弹窗**：新增「ID」字段（新建时手动填写 senderId）；原「用户名」改为「姓名」。
- **角色回退**：用户可单独绑定角色；未绑定时自动使用其所属部门绑定的角色（多部门取全部部门角色的并集，仅用于展示说明）。
- **不拦截主链路**：全程只读 dsh-im / dsh-dingtalk / dsh-ding-card 的数据，不注册 hook / 中间件；任何源缺失、JSON 损坏、库被占用都静默降级，下一次轮询继续尝试。

## 用户权限控制（IM 侧只读）

钉钉等 IM 渠道进来的消息会驱动本机 agent，默认等同于把整台电脑交出去。因此插件把「一个消息发送者能驱动多少主机能力」做成可配置的权限规则：

- **三层绑定**：权限可绑在 **用户自身**、**用户角色**、**用户部门**（以及部门绑定的角色）上；一个用户最终权限 = 四处绑定的**最严合并**——能力开关逐项 AND（任一处关闭即关闭）、沙箱与审批取更严的一档、工具白名单取交集。
- **没有绑定就拒绝**：用户没有任何绑定、且没配「未绑定用户的默认权限」时，adapter 在**发送者准入阶段**直接抛中文原因错误，一次模型调用都不会发生（日志 `guard-deny`）。
- **两道闸门**：准入通过后，请求侧按能力开关把不该有的工具从 `forwarded.tools` 里裁掉（`guard-tools` 记录 `dropped`/`kept`）；万一模型仍然吐出被禁的 tool-call，输出侧会把该 tool-call 及其分片整段丢弃，只把正文透给用户（`guard-deny`，`kind=tool-call`）。
- **会话级内核限制**：同一会话首次或被换人时，插件向宿主下发 `sandbox/mode` 与 `approval/policy`（与宿主 `setSandboxMode` / `setApprovalPolicy` 同一契约），让写盘范围与人工审批在宿主内核层面也生效，而不是只靠插件自觉。
- **权限只能在本机控制台改**：权限规则的读写只走本机桌面端控制台的 RPC，IM 侧的对话里没有可用工具去改权限表或给自己提权。
- **上线前务必先绑定**：权限层对「没有 `permissionIds` 的存量用户」一律按拒绝处理，升级后需要先在「用户」页把权限绑上，否则这些人会直接收到拒绝。

### 内置权限

| id | 名称 | 能力 | 沙箱 | 审批 |
| --- | --- | --- | --- | --- |
| `perm_readonly` | 只读应答 | 仅对话 | `read-only` | `ask` |
| `perm_standard` | 标准操作 | 对话 / 写文件 / 执行命令 | `workspace-write` | `ask` |
| `perm_admin` | 管理员 | 全部 | `danger-full-access` | `never` |

内置三条不可删除（被删会自动补回，防止把维护者自己锁在门外），但能力开关可编辑。新增权限默认从「只有对话」起步。

## 决策模型路由（adapter 暴露虚拟模型）

「路由配置」页的「决策模型路由」卡片启用（**启动决策模型**）后，插件通过宿主 `ctx.llm.registerAdapter` 把虚拟模型 **「MRRP 智能路由」** 暴露到 DSH 对话的模型选择器（dsh-im / DSH 对话均可见）。对话选中该模型后，生成请求进入插件的 adapter，按会话发送者权限决策真实模型并代理回复：

```
对话选中「MRRP 智能路由」
  → adapter 用会话 id 查「会话 → 发送者」映射（插件订阅 session/event 观测记录，含 senderId / senderName）
  → senderId 对应用户表 id
  → 用户可用模型 = 用户单独角色 + 所属部门绑定角色 的 categoryBindings（分类内模型并集，去重）
  → 候选唯一：直接使用；候选多个：内置判定问题请决策模型选一个（「路由配置」页选中的提供方及其全部模型合成一个池，按最少在途自动分摊，见下文「决策模型并发池」）
  → 插件代理该真实模型（ctx.llm.stream）生成回复
  → 未注册用户 / 未绑定分类 / 决策失败 → 兜底模型；未注册用户策略=ignore → 对话明确提示未注册
```

- **暴露虚拟模型**：无需用户在对话里配置，插件注册的提供方 `mrrp` 下出现模型 `route`（显示名「MRRP 智能路由」）。**「启动决策模型」关闭后 `llm.listModels('mrrp')` 返回空数组**，DSH 对话模型选择器与 MRRP 控制台「模型列表」页都不再出现该行；已选中它的旧会话仍按兜底模型转发（未配兜底则明确报错），不会中断。
- **决策模型（Laya）**：仅支持 `format=laya` 的提供方（本地 systemone / 0G decisions）。**候选模型的选择判定问题由插件内置**（`builtinModelChoiceQuestion`：根据消息内容从候选模型列表里选一个），用户不再配置判定问题与规则映射。
- **性能**：① **决策上下文缓存**——缓存「发送者 → 用户可用模型池」（候选 / 画像 / 指纹），同一发送者同配置在 10 分钟内复用候选池，不再重复组装；**每条消息仍执行 Laya 决策**（候选多时按本条消息内容重新选择模型，不按会话锁死）；② 候选选择用 6s 短超时——Laya 慢或不可达时快速落兜底，避免用户干等；③ 候选唯一时直接使用，不调决策模型；④ 候选池为空（用户无任何绑定分类模型）时直接使用兜底模型，不发起 Laya 决策；⑤ **模型容灾（生成阶段自动切换）**——路由到的真实模型**连不上 / 调用失败**时，只要还没向用户输出任何内容，就按容灾链静默换模型：`首选 → 候选池其余模型 → 兜底模型`（去重、剔除自身、最多 4 个）。**「调用失败」既包括抛异常，也包括宿主把 provider 异常归一化成的终态 `finish` 事件**（`reason.kind='error'`，里面带 `code` / `status` / `message`，典型是 429 限流、免费额度耗尽、provider 返回错误码）——这类失败不会抛异常，如果不识别就会被当成「正常结束但没内容」，兜底模型永远不会被拉起。用户主动停止（`reason.kind='aborted'`）不算失败，不切换。用户看到的是可用模型的回复，而不是「暂时无法连接模型服务」。`route.failover=false` 可关闭；链里只有一个模型时才用 `route.retries` 原地重试（有备选就直接换，连接类故障重试同模型基本无用还拖慢恢复）。**已输出部分内容后断开不切换**（宿主已把内容显示给用户，换模型会重复回复或重复执行工具），此时抛出的错误会说明「输出过程中断开、已输出部分内容」。
- **决策模型并发池（多模型分摊）**：`decisionProviderIds` 里选中的提供方 + **每个提供方下的全部模型**合成一个池（同一 API 填多个模型名，每个模型名各占一个槽）。每次决策按**最少在途**挑槽：某个模型正在决策时，新请求自动换空闲的模型，不必排队等它；主用模型（`decisionPool.primaryProviderId` / `primaryModel`）只作优先级，空闲时先上、它忙了照样分流；**全部槽都满额才排队**（`queueTimeoutMs`，默认 8s），排队超时落兜底模型——对话量远超决策模型承载力时才会排队。失败处理：失败槽冷却 15s 并换下一个槽（单次决策最多尝试 3 个槽），全失败落兜底。同一发送者开启会话粘性（`sticky`）时优先复用上次成功的模型，避免同一会话判定口径来回跳；关闭后每次按空闲程度重新挑。可在「路由配置」页逐槽设置**并发上限**（默认 1）与**权重**（1~5，权重越高越能多吃请求），并点「刷新各模型负载」查看实时在途 / 成功 / 失败 / 冷却；关闭「启用并发分摊」则回到旧的按提供方轮询 + 顺序故障转移。本地 laya 的模型名只是登记（请求不带 `model`，由服务端自选检查点），因此每个 laya 提供方在池里只占一个槽；真正可按模型切换的是 `openai` / `generic` 提供方的 `modelNames`。
- **决策问题完善**：发送给 Laya 的候选模型带**类型与擅长场景画像**——优先取「模型列表」页手动画像（`modelProfiles`），未配置则回退该模型所在分类的「名称 + 描述」；判定指令明确按问题语义 / 复杂度 / 是否涉及代码·视觉·长文本 / 所需推理深度决策，并附带**发送者姓名**与**候选授权来源**（直接角色 N 个 / 部门继承 M 个）；要求 Laya 输出一句简短 `reasoning`（选择理由），随路由日志记录，便于核对决策是否合理。
- **配置即时效**：决策缓存指纹覆盖影响候选池的全部配置（分类 / 角色 / 部门 / 用户 / 模型画像 / 默认角色），控制台任一改动保存后，已缓存会话立即失效并重新决策，无需等待 10 分钟缓存过期。
- **路由决策日志**：默认与 `config.json` 同目录（**存放目录可在「日志设置」页改成任意绝对路径**，见下），**按天分文件** `route-decision-YYYY-MM-DD.log`（append JSON 行，多人共用写入无压力；旧 `route-decision.log` 不再写入仅保留）。每次生成请求记录完整链路：会话 / 发送者 / 用户命中 / 候选池 / 决策来源（user=laya=fallback=unknown-fallback）/ 最终模型 / **Laya 选择理由（reasoning）**；`decide-before`（发送给 Laya 的 state 与 questions）/ `decide-after`（Laya 原始响应）/ `decide-error` 记录决策模型的请求与响应——用于确认「按用户权限路由」是否真实生效、Laya 决策是否命中。会话发送者观测（`scope: im-route`）也写入同目录文件：订阅成功 / 每次映射 / 事件被拒原因（首个样本，含事件 type 与字段结构）——映射未命中时据此定位是事件未到达还是形状不匹配。**控制台侧边栏「日志管理 → 日志」直接查看**：最新在前（默认 100 条 / 上限 1000 条），「详情」以**底部边栏**在表格下方展开（表格压缩在上方滚动区，点任意行无需滚动即见原始记录），元信息胶囊 + 深色 JSON 语法高亮（键 / 字符串 / 数字 / 布尔与 null 分色），最小高度 240px 区内滚动。**自动清理保留天数可在「日志设置」页配置**（默认 30，1~365；写入时 6 小时节流触发一次，启动时清一次）；「日志设置」页另支持**立即清理全部日志**、**查看全部历史日志文件**、整文件清理、按关键词 / 逐行勾选选择性删除记录（文件名白名单防路径穿越）。
- **日志存放目录可配置**：配置项 `logDir`（绝对路径，空串 = 默认与 `config.json` 同目录）。在「日志设置」页可直接粘贴路径点「保存」，也可以点**「浏览…」弹系统的文件夹选择框**挑目录（网页拿不到本地绝对路径，所以对话框由 host 侧弹出：宿主是 Electron 时用原生 `dialog.showOpenDialog`，否则在 Windows 回退 `FolderBrowserDialog`；两段式 `logs.dir.pick.start` / `.poll`，对话框停留不阻塞 RPC）。写入前会先做可写性探测（目录不存在则自动创建，不可写直接报错 `log-dir-not-writable` 并拦下保存），相对路径 / 超长 / 含空字节一律被清洗回默认。改完**即时生效**（日志路径、日志列表、清理、旧文件管理全部走同一个现取的目录，无需重装插件，重启后同样生效）；**不自动迁移**历史日志，旧目录里的 `route-decision-*.log` 需要的话手动拷到新目录。启动时若自定义目录不可写，本次运行回退默认目录并在宿主日志里 warn 一次，避免日志静默丢失。无人值守部署可用环境变量 `MRRP_DISABLE_NATIVE_PICK=1` 关掉原生弹窗，只保留手动填写。
- **会话事件兼容**：会话发送者映射同时识别 `user/message`（dsh-im）与 `agent/inbox/spliced` / `agent/inbox/inserted`（DSH agent inbox：inserted 最后一条 / data.message）。消息无 senderId（如 agent 自身注入）或纯删除（outcome=canceled）不建映射；渠道白名单在 channel 缺失时不拦截。
- **dsh-dingtalk 桥会话映射**：DSH agent inbox 的 user 消息不携带发送者身份（source 只有 kind:"user" + rpcId），而 dsh-dingtalk 桥在 `~/.dsh/integrations/dsh-dingtalk/bots/<botId>/state.json` 持久化了 `p2p:<staffId> -> DSH sessionId` 映射。插件只读该 state.json（写入中途重试一次、静默降级），把「DSH 会话 → 钉钉发送者」建立起来；事件观测与桥映射双来源取并集，adapter 解析发送者时优先事件观测、其次桥映射。诊断日志中 `会话映射（dingtalk 桥）：N 个会话` 表示桥映射已加载。
- **兜底模型**：`provider:id`，从已发现模型列表选择；用户未注册 / 未绑定分类 / 决策失败时使用。
- **未注册用户**：`ignore` = 对话明确提示「未注册用户，无法路由」；`fallback` = 使用兜底模型。
- **渠道**：默认 `dingtalk`；可配置多个渠道（逗号分隔），空 = 全部 dsh-im 渠道。
- **会话→发送者映射**：插件只订阅 `session/event`（观察），把「会话 id → 最近发送者」记入内存映射；对真实 dsh-im 事件做了兼容（senderId 在消息顶层、source 可能是懒函数、kind 缺失时由 senderId 强信号把关）。会话 id 与宿主生成请求的 `options.sessionId` 不一致时提供包含匹配兜底。
- **安全**：adapter 是宿主正规的提供方扩展点，事件观测只读不拦截；转发仅改 provider/model 字段，不修改消息内容；任何异常都带明确消息呈现给对话，绝不静默走错模型。

### 路由决策日志事件说明

`route-decision-YYYY-MM-DD.log` 按行 JSON 记录，每行 `event` 字段标识事件类型（控制台「日志管理 → 日志」页的事件标签即该值）。各事件来源与作用：

| 事件 | 触发时机 | 作用 |
| --- | --- | --- |
| `observe-call` | 消息**带多模态输入**（图片等）时 | 观测宿主调用形态（顶层字段、最后一条用户消息类型 / 块结构），供转发兼容调试；只记录不干预决策 |
| `ctx-hit` | 命中决策上下文缓存 | 同一发送者 + 同配置在 TTL 内**复用候选池**（不再重复组装）；本条消息仍会重新走 Laya 决策 |
| `decide-before` | 决策请求发出前 | 完整记录发给决策模型的请求：`state`（用户正文）、`questions`（候选模型 criteria）、提供方、**实际挑中的槽 `model`**、**排队时长 `waitMs`**（> 0 说明当时池内模型在忙）、超时 |
| `decide-after` | 决策模型返回 | 记录原始响应（选中的模型、reasoning 选择理由）与实际执行决策的 `model` |
| `decide-error` | 决策调用失败 | 失败槽的 `model` / 超时 / 错误 message；该槽随即冷却 15s，本次决策换下一个槽 |
| `route` | 决策完成 | **最终结果**：选中模型、来源（candidate / fallback / unknown-fallback…）、候选池、决策提供方、附件覆盖等 |
| `forward-media` | 转发阶段 | 目标模型**输出块观测**：返回的图片 / 视频 / 音频 / 文件等**非文本块**（首样本去重），确认"带图消息转发后目标模型能返回多媒体输出"的链路 |
| `failover-switch` | 目标模型不可用，切下一个 | 记录 `from` / `to` / 失败原因；候选链依次尝试，切换对用户无感 |
| `attempt-fail` | 某模型本次尝试失败 | 记录失败的 `model`、错误信息、**当时是否已输出内容**（`emitted`） |
| `model-failure` | 模型以 `finish` 事件报告错误（限流 / 额度不足 / 错误码） | 记录 `model`、`kind`（error / aborted）、`code`、HTTP `status`、`message`；这是容灾真正开始切换的触发点 |
| `failover-recovered` | 换模型后恢复正常 | 记录最终完成回复的 `model`、此前失败的模型列表与失败次数 |
| `forward-exhausted` | 整条候选链都不可用 | 记录依次尝试过的 `tried` 列表；随后对用户抛明确错误 |
| `unknown-sender` / `no-route` / `decision-disabled` | 边界分支 | 会话映射缺失、用户未注册且无兜底、决策模型未启动等分支记录 |
| `guard-deny` | 权限拦截 | `unknown-sender-unbound`（未识别发送者且未授权）、`no-chat`（绑定里没有对话能力）、`kind=tool-call` + `tool` + `group`（输出侧丢弃了被禁的 tool-call）。准入阶段的拒绝**不会发起任何模型调用** |
| `guard-apply` | 会话权限下发 | 按发送者解析出的可下发权限（沙箱 / 审批）被写进会话时记一条，便于核对是否真的收敛 |
| `guard-tools` | 请求侧裁剪 | 按能力开关 / 白名单从 `forwarded.tools` 里裁掉不该有的工具，记录 `dropped`（被裁掉的名字）与 `kept`（保留数量） |

> 说明：`forward-media` 是正常观测不是错误——带图 / 多媒体对话转发给目标模型时，其输出流里的非文本块（如 `block-start`、`reasoning-delta`、图片块）各记一条（首样本去重），同一条消息可能同时产生多条。另：旧版本曾输出 `cache-hit`（决策结果缓存：state 命中直接复用上次模型）；当前版本已改为 `ctx-hit`（只缓存候选池，**每条消息仍重新决策**），升级重启后日志不再出现 `cache-hit`。

## 配置存储

`~/.dsh/integrations/dsh-mrrp/profiles/<profile>/config.json`（多环境各存一份；profile 认定不出时回退 `~/.dsh/integrations/dsh-mrrp/config.json`。可用 `DSH_HOME` 覆盖主目录）。结构：

```json
{
  "version": 1,
  "route": { "active": true, "strategy": "category", "lb": "round-robin",
             "weights": {}, "fallback": "random", "timeoutMs": 60000,
             "retries": 0, "failover": true,
             "imRoute": { "enabled": false, "decisionProviderId": "",
                          "decisionProviderIds": ["dp_xxx"],
                          "decisionPool": { "enabled": true, "defaultLimit": 1,
                                            "queueTimeoutMs": 8000, "sticky": true,
                                            "primaryProviderId": "", "primaryModel": "",
                                            "limits": {}, "weights": {} },
                          "questions": {}, "rules": [],
                          "fallbackModel": "", "unknownUser": "ignore",
                          "channels": ["dingtalk"] } },
  "categories": [ { "id": "cat_xxx", "name": "深度推理", "desc": "", "modelIds": [], "isDefault": true } ],
  "roles": [], "depts": [], "users": [],
  "permissions": [
    { "id": "perm_readonly", "name": "只读应答",
      "caps": { "chat": true, "fsWrite": false, "exec": false,
                "pluginManage": false, "power": false, "computerUse": false },
      "toolAllow": [], "sandbox": "read-only", "approval": "ask" }
  ],
  "defaultPermissionId": "",
  "sidebar": { "mode": "auto" },
  "decisionProviders": [
    { "id": "dp_xxx", "name": "Laya 本地", "format": "laya",
      "baseUrl": "http://127.0.0.1:8000", "apiKey": "",
      "modelNames": ["english", "multilingual"], "categoryId": "cat_xxx",
      "enabled": true, "createdAt": "", "updatedAt": "" }
  ]
}
```

> 说明：`route` 下除 `imRoute` 外的字段（`active / strategy / lb / weights / fallback / timeoutMs`）为旧版「路由模型配置」的历史遗留，当前版本 UI 已移除，业务链路不再读取；保留仅为兼容既有 config.json，可安全忽略。**例外**：`failover`（默认 `true`）与 `retries`（默认 `0`）已被「模型容灾」重新启用——`failover` 控制生成失败时是否自动换模型，`retries` 只在容灾链仅剩一个模型时生效（同模型重试次数，上限 2）。

## 决策模型提供方（laya_decide）

在「决策模型配置」页维护提供方：`API 地址 + API 密钥（可空）` 获取 / 手动维护模型。

支持的接口格式：

| format | 模型列表 | 决策调用 |
| --- | --- | --- |
| `laya`（本地 `endpoint: systemone`） | 无 `/v1/models`，手动输入检查点（english / multilingual / typed-decisions，按钮可一键填入） | `POST {baseUrl}/v1/systemone`（TypeSafe Jev 协议） |
| `laya`（0G 云端 `endpoint: decisions`） | 同上（内置检查点可一键填入） | `POST {baseUrl}/v1/decisions`，请求体自动带 `model: "laya"` |
| `openai` | `GET {baseUrl}/v1/models` | ——（拉列表后手填/保存） |
| `generic` | `GET {baseUrl}/models` | —— |

本地判定服务提供方（如 laya-server 或其它兼容 `/v1/systemone` 判定协议的本地服务）可在弹窗「服务类型」选 **本地判定服务（/v1/systemone）**（`http://127.0.0.1:8000` → `/v1/systemone`）；**0G 云端**（`https://router-api.0g.ai` → `/v1/decisions`）选 **云端判定服务**。用 llama.cpp / vLLM 等框架启动的本地大模型当判定器，选 **OpenAI 兼容对话判定**（`{baseUrl}/v1` → `/chat/completions`，`baseUrl` 填 `http://127.0.0.1:8080/v1` 之类）。0G 云端调用示例：

```bash
curl "https://router-api.0g.ai/v1/decisions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_API_KEY>" \
  -d '{ "model": "laya", "state": "...", "questions": { ... } }'
```

鉴权：请求头 `Authorization: Bearer <apiKey>`；服务端未设置密钥时留空（不发送该头）。测试连接按钮：laya 走一条真实决策 ping，其余走模型列表拉取。

### laya_decide 工具

插件启动时向 DSH 注册 `laya_decide` 工具（运行时不提供 tools 时仅告警跳过，不影响控制台与 DSH 启动）。参数：

```json
{ "state": "待判断的文本（必填）",
  "questions": { "verdict": { "type": "choice",
                               "instructions": "…",
                               "criteria": { "yes": "…", "no": "…" } } } }
```

- `state`：字符串（或对象，Jev 会按原文判断）。
- `questions`：省略时使用默认简单 choice（yes/no）。
- 三种 primitive：`choice`（criteria = 至少两个选项的对象）、`score`（criteria = 至少两个档位的数组）、`noul`（criteria 可省）。
- 返回 Laya `/v1/systemone` 原始 JSON（`{ model, answers, usage }`）。

提供方解析优先级：控制台已配置且启用的 `laya` 提供方 → `cordis.patch.yml` 中 `config.laya` 覆盖项（未在控制台配置时的兜底）。

### cordis.patch.yml 配置片段

安装方式（`dsh plugin add ./dsh-mrrp-2026.11.07.tgz`）会自动写入 `cordis.patch.yml` 的 `insert: [{ id: dsh-mrrp }]`。如需用配置文件直接声明 Laya 服务（未在控制台新增提供方时的兜底），在插件的 `config` 下追加：

```yaml
# DSH 配置目录下（如 ~/.dsh/profiles/desktop/cordis.patch.yml）
insert:
  - id: dsh-mrrp
    config:
      laya:
        baseUrl: http://127.0.0.1:8000   # 本地判定服务（如 laya-server）默认 0.0.0.0:8000；云端填 https://router-api.0g.ai
        apiKey: ""                        # 可选；LAYA_API_KEY 未启用时留空
        endpoint: systemone               # 可选：systemone（本地 /v1/systemone，默认）| decisions（0G 云端 /v1/decisions）
```

控制台里新增并启用的 Laya 提供方优先于该片段。

## 开发

```bash
pnpm install
pnpm build      # tsc 编译 host（lib/*.ts → dist/）
pnpm test       # node --test 冒烟测试（store + RPC 全通道）
pnpm pack       # 打 tgz 发布包
```

## 故障排查

### 钉钉里只回「消息已尝试提交，但任务结果尚未确认 / INTERNAL_UNKNOWN」，且没有决策日志

症状：钉钉单聊里对机器人发消息，机器人只回一条固定兜底文案（带参考号 `MF-xxxx`），
用户消息被标「处理失败」；插件路由日志（`route-decision-YYYY-MM-DD.log`）里**连一条
`decide-before` / `route` 都没有**。

这通常不是决策模型的问题，而是消息在进入决策链路之前就已经失败。按两步定位：

1. **宿主日志**（`~/.dsh/logs/desktop-next.log`）：搜 `HARNESS_TURN_FAILED`。
   - 若同一条前后出现 `Cannot switch to mrrp/route: context compaction failed` +
     `… adapter.imageRequestPricing is not a function`，说明宿主在**压缩上下文**阶段
     回调 adapter 的图片定价方法，而本 adapter 当时没有实现它 → `TypeError` →
     turn 直接失败，adapter 的 `stream()` 根本没被调用，所以不会有决策日志。
     修复：adapter 已实现 `imageRequestPricing`（返回 `undefined`，宿主退回中性估算）
     与 `imageRequestTarget`（原样转发）。**这类方法缺失不会再打断 turn。**
   - 其它 `LlmError` / 模型不可达错误同理：先修宿主侧报错，再看路由。
2. **插件日志的发送者观测**（同上目录）：若出现
   `会话事件观测拒绝 … reason="extractEvent 未提取到 IM 消息（无 senderId 或非 IM 来源）"`，
   说明宿主 `agent/inbox/spliced` 事件里没有 `senderId`，发送者信息只在用户消息正文的
   `<dsh_im_source>` 前缀块里（可能是 JSON 形态 `{"senderId":"…","senderName":"…"}`，
   也可能是裸键值 `senderId: …`）。修复：发送者块解析两种形态都兼容，且 adapter 在
   映射缺失时会**从请求正文回退解析并回填会话映射**（日志出现
   `会话映射（请求正文回填）：…`）。

排查顺序建议：先看宿主日志确认 turn 是否在进入 adapter 前就失败，再看插件日志确认
发送者是否解析成功，最后才怀疑决策模型。

> 改完 `dist/` 后必须**重启 DSH 宿主**：junction（`link:`）安装下宿主进程已缓存旧模块，
> 不重启会继续跑旧代码。

## 安全边界

- **绝不注册 hook / 中间件拦截 DSH 主链路**——模型只读发现 + 管理 RPC 通道。
- **IM 侧无写权限**：钉钉等渠道进来的对话只能被权限规则约束，能改权限表的只有本机桌面端控制台，因此不存在「在群里让 agent 给自己提权」的路径。
- **默认拒绝**：用户没有任何权限绑定且没配默认权限时，请求在发送者准入阶段即被拒，不会触达模型、不会执行任何工具；`imRoute.unknownUser` 的历史取值（`fallback`）不再能绕过这道闸门。
- 未实现 `plugins.detail.actions` 挂载，避免“打开”按钮泄漏到其它插件页面。
