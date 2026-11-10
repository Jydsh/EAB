# dsh-ding-card

> 钉钉 AI 卡片交互插件 · 正式版本 v2026.11.06（版本号采用年月日管理）

把 DeepSeek Harness（DSH）的人机交互变成**钉钉互动卡片**：当 Agent 需要提问、审批或展示结构化信息时，插件自动投放一张带推荐选项的卡片；用户点击按钮后，答案直接回到正在流式运行的会话里。Web 界面与钉钉卡片同时可用，先答者生效。

插件复用 [dsh-im](https://github.com/xmanrui/dsh-im) 已经配置好的钉钉机器人与 Stream 连接，**不再新建连接、不复制密钥**。安装后左侧边栏会出现「钉卡片」，在里面设计卡片、绑定模板，并让 Agent 在对话中按场景选择卡片。

## 功能特性

### 卡片库
- **添加 / 编辑卡片**：选择类型（消息卡片 / 吊顶卡片），设计标题、正文、字段、图片、按钮，实时预览，填写卡片说明。
- **按钮体系**：每个选项有**显示标签**与**回传值**；按钮垂直排列。
  - **成组卡片**（按钮 + 旁文本回传区，如答题卡 `btnsA ↔ btnsAvalue`）：按钮显示短标签，旁文本显示完整内容，回传值自动去序号前缀（`A. 中国神话中的神` → 按钮 `A`、回传 `中国神话中的神`）。
  - **非成组卡片**（只有按钮，如消息卡 `option1..N`、审批同意/拒绝）：按钮文案即回传值，完整显示。
- **JSON 导入 / 导出**：按钉钉卡片搭建器格式导出模板 JSON，导入后保持设计一致。
- **发送测试**：选择会话、模糊查询会话、自定义参数（含模板变量）后直接投放测试。
- **卡片类型 / 名称模糊筛选**：卡片库支持按类型多选 + 关键词筛选。

### 变量集
- **模板变量 + 自定义变量**：模板变量随钉钉侧模板变动，自定义变量为插件扩展。
- **类型体系**：普通文本、长文本、数字、链接、图片、音乐音频、封面图、日期等；按类型生成录入控件与 Mock。
- **重复检测**：变量名与类型相同不能重复添加，导入 JSON 自动跳过重复。
- **筛选与统计**：支持按变量类型多选筛选、按名称/描述模糊搜索；顶部显示变量总数。

### 交互与回调
- **提问卡片**：`ask_user_question` 自动转为带选项的钉钉卡片。
- **审批卡片**：工具调用需要确认时自动转为「允许 / 拒绝」按钮。
- **吊顶卡片**：固定会话顶部的音乐播放器等卡片（仅单聊，一张回复最多一张）。
- **回调通道自动挂接（免重启）**：钩子直接挂在钉钉 SDK 的 `DWClient.prototype.onCallback` 分发点上，不需要持有 dsh-im 的 client 实例——先装本插件再装 dsh-im、先装 dsh-im 再装本插件，两种情况都能收到回调；还看不到 `dingtalk-stream` 时后台每 10 秒自动重试挂接（约 5 分钟后降频到 60 秒一次），装好后自动生效，**无需重启 DSH**。
- **回调持久化**：DSH 重启后，重启前的消息卡片回调仍可回收与记录。
- **回调日志**：记录每个按钮点击的回传值详情。
- **AI 流式填充**：AI 卡片逐 key 流式渲染，失败自动重试并落盘 `stream_failures.json` 明细。

### 版本检查与更新
- 插件启动时自动检查 GitHub Release 最新版本（`api.github.com` 优先，失败回退 `releases.atom`）。
- 侧边栏标题旁显示当前版本：`v2026.11.06`；发现新版本时变醒目色并显示 `v2026.11.05 ↑ v2026.11.06`。
- **安装环境识别**（与 dsh-mrrp 同一套判定）：检查前先识别本机环境，横幅按识别结果说明「本机将用 dsh plugin / pnpm / npm 安装到 desktop profile」，判断依据包括
  - profile：`DSH_PROFILE_DIR` → 插件自身安装路径 → `DSH_PROFILE` → 兜底 `desktop`；
  - 安装来源：读 profile 的 `package.json` 里本插件的声明，区分 `git`（`github:` / `.git#`）、`tgz`（Release 安装包 / `file:`）、`link`（`link:` 或 junction 指向工程目录）、`unknown`（默认按 Release 安装包）；
  - 更新动作：已装版本 == 目标版本 → `update`（原地刷新，用于同日替换 Release 资产），否则 `add`；`link` 安装一律 `add`；
  - CLI：按 `dsh` → `pnpm` → `npm` 顺序探测 PATH。
- **两个按钮，都是真功能**：
  - 「立即更新」：按识别出的环境执行安装（宿主暴露插件管理服务时走 `installBundle`，否则按识别出的命令 `spawn` 直接执行），失败时把同一条命令**自动写进剪贴板**并提示手工执行；
  - 「复制命令」：把横幅展示的、与「立即更新」实际执行的**同一条命令**复制到剪贴板。
  - 识别不出可执行环境时（无 CLI / `link` 安装 / 多个 profile 都装了却认不出当前），按钮置灰并在横幅里说明原因，命令仍可复制。
- **首次自动更新**：启动时识别到新版本会自动安装一次（同一版本只尝试一次）；若当前是本地开发链接（`--link` / junction）或多 profile 认不出，则跳过自动替换并提示。
- **更新后重启**：宿主没有热更新（HMR）时，覆盖安装后必须重启 DSH 才会换掉运行中的旧代码；界面会提示并给出「立即重启 DSH」按钮（桌面端由插件调 `app.relaunch` 自我重启，网页端给出重启方式）。

### 更新（覆盖安装，不需要卸载）

更新就是**往同一个包里装新版本**，底层执行 `pnpm add <spec>`，对已存在的同名依赖是覆盖升级。DSH 原生「插件」页对第三方插件只提供卸载，所以请在下面三种方式里选一种：

```bash
# 1) 命令行覆盖更新（不需要先 remove；DSH 运行中请先退出）
dsh plugin --profile desktop add github:Jydsh/dsh-ding-card#v2026.11.06
# 2) semver 范围内的常规升级（package.json 里是 ^x.y.z 时有效）
dsh plugin --profile desktop update dsh-ding-card
```

| 方式 | 是否需要卸载 | 生效时机 |
| --- | --- | --- |
| 概览页「立即更新」/ 版本号 | 否 | 宿主有 HMR：热重组，无需重启；无 HMR：重启 DSH 生效（界面给一键重启按钮） |
| 概览页「复制命令」→ 终端执行 | 否 | 重启 DSH 生效（命令由插件按本机环境生成，与「立即更新」一致） |
| 启动自动更新（发现新版本） | 否 | 同上；同一版本只自动尝试一次 |
| 命令行 `add` / `update` | 否 | 重启 DSH 生效 |

**为什么有的环境更新后必须重启**：DSH 宿主对“已装包的覆盖安装”会跳过插件重载（`installBundle` 内部 `Object.hasOwn(before, name)` 分支），只把结果标记为 `restart-required`；只有**首次安装**才会 `publishAndReload` 立即生效。插件无法绕过这个判定，所以改用「更新完成后由用户确认、一键重启」。

**热更新（免重启）的前提**：宿主的 `@deepseek-ai/dsh-base` bundle 默认装配 `hmr` 服务（`@deepseek-ai/dsh-hmr`）。检测到 `hmr` 可用时，插件把更新改为「先卸载、立即重装」，宿主热重组后**无需重启**；`hmr` 不可用（或宿主拒绝对已装包覆盖）时才提示重启。概览页的更新横幅会按当前情况显示对应文案。

**常见失败原因**（插件会把宿主的错误码翻成中文显示）：

| 错误码 | 含义 | 处理 |
| --- | --- | --- |
| `already-installed` | 当前 DSH 处于热更新模式，不允许对已装包直接覆盖 | 插件会自动改走「卸载后立即重装」，宿主热重组，无需重启 |
| `incompatible-version` | 新版本与当前 DSH 版本不兼容 | 保持原版本，等待匹配的 DSH 版本 |
| `ambiguous-install` | 安装结果无法定位唯一包 | 宿主已回滚 `package.json`，重试或换命令行 |
| `not-bundle` | 包没有声明 `dsh.bundle` | 确认安装的是插件包本身，不是源码仓库的其他产物 |
| `network` / `timeout` | GitHub 不通 | 检查网络/代理后重试（`gh`、`api.github.com` 是否可达） |
| `stop-profile` | 该 profile 正被 DSH 独占 | 退出 DSH 后在命令行执行 |


### 多环境隔离（桌面端 + 网页端）
同一台电脑同时装 DSH 桌面端（`desktop` profile）与网页端（`dsh web`，即 `web` profile）时，插件按**自己的安装位置**判断当前环境，不做跨环境借用：

- **环境识别**：从 `.../profiles/<name>/node_modules/dsh-ding-card` 推断当前 profile；`DSH_PROFILE_DIR` / `DSH_PROFILE` 存在时以宿主声明为准。概览页标题旁显示环境徽标（`desktop` / `web`）。
- **检测隔离**：只检查当前 profile 的 dsh-im，未装即显示「未安装」并给出**当前环境**的安装命令（如 `dsh plugin --profile web add @xmanrui/dsh-im`），不再回退到 desktop 的副本。
- **依赖隔离**：`dingtalk-stream` 只从当前 profile 解析，不借用其他 profile；当前环境未装 dsh-im 时卡片不可用，需在该 profile 各自安装。
- **数据隔离**：卡片库、模板、变量集、回调日志、昵称表、更新状态都落在 `~/.dsh/integrations/dsh-ding-card/profiles/<name>/`，两个环境互不影响；首次启动时会把旧的 DSH_HOME 级 `config.json` 复制一份到当前环境（旧文件保留）。
- **机器人配置引用**：机器人凭据与会话路由来自 dsh-im；当前 profile 未装 dsh-im 时不引用，避免出现「左边未安装、右边凭据就绪」的矛盾显示。


### AI 自主使用（Agent 工具）
插件向 Agent 提供三个工具，使其能**自己判断用哪张卡、怎么传参**：

| 工具 | 作用 |
|---|---|
| `ding_card_list` | 卡片清单：每卡返回 `description`（功能说明）、`sendVariables`（实际可配变量：类型/角色/paired/Mock/required）、`maxOptions`（按钮上限）、`usedAs`（question/approval/ceiling 场景）、`interactive`（是否等待回应） |
| `ding_var_list` | 全量变量集：模板 + 自定义变量，含类型、Mock 示例与绑定 |
| `ding_card_send` | 按卡片名发送：title/content/options/fields/variables，支持等待点击回传 |

Agent 读取卡片说明 → 分析功能 → 核对变量与按钮 → 判断场景与是否等待 → 自动发送并传参。

### 音乐播放器组件
- 发送测试预览中识别钉钉音乐播放器组件并渲染（封面、歌名、歌手、进度、播放/暂停）。
- 支持将左侧变量（音频地址 / 封面 / 标题 / 歌手）**拖拽绑定到播放器槽位**，持久化保存；卡片删除/更新 JSON 时绑定自动清理。

## 安装与配置

### 方式一：通过 DSH 自定义地址从 GitHub 源码安装（无需 npm / Release）

DSH 的「添加插件」输入框支持三种形式：**包名、GitHub 仓库地址、本地目录路径**。从 GitHub 地址安装时，DSH 底层用 pnpm 拉取源码并在本地完成安装，**不要求发布 npm、不要求 GitHub Release**。

1. 打开 DSH → 插件 → **添加插件**
2. 输入框填写仓库地址（二选一）：
   - `github:Jydsh/dsh-ding-card`
   - `https://github.com/Jydsh/dsh-ding-card`
3. **安装源**保持默认（npm 官方源 / 中国大陆镜像源均可，仅影响依赖下载，不影响 GitHub 安装）
4. 点「安装」，完成后**重启 DSH**，左侧边栏出现「钉卡片」即成功

命令行方式（`--profile <profile>` 指定 DSH 环境名，不同机器 / 场景可分别安装到对应环境）：

```bash
# 桌面端（desktop）环境
dsh plugin --profile desktop add github:Jydsh/dsh-ding-card

# Web（web）环境
dsh plugin --profile web add github:Jydsh/dsh-ding-card

# 其他自定义环境：把 <profile> 换成实际环境名即可
dsh plugin --profile <profile> add github:Jydsh/dsh-ding-card
```

指定版本安装（配合 GitHub Release tag）：

```bash
dsh plugin --profile desktop add github:Jydsh/dsh-ding-card#v2026.11.06
```

> **关于 `<profile>` 环境名**：
> - 用 `dsh plugin --help` 或 DSH 设置页查看当前机器可用的环境名（常见：`desktop` / `web`，也可能是自定义名称）。
> - 若执行报错 `profile "xxx" is managed exclusively by the Electron application`，说明该环境正被 DSH 应用（Electron）独占：**先退出 DSH 再执行命令行安装**，或直接改用上面的 DSH 界面「添加插件」方式安装。
> - 安装到哪个 profile，插件就只在该环境的 DSH 实例中生效。

> 本插件为**零构建安装**：服务端以 TypeScript 开发（已迁移模块在 `lib/*.ts`），`tsc` 编译产物 `dist/` 随源码提交仓库，`main` 直接指向预编译的 JS——GitHub 源码安装时无需执行任何构建脚本，**不需要配置 pnpm 构建白名单（allowBuilds）**，安装即用。

> **更新插件**：插件侧边栏会**自动检查 GitHub Release 新版本**并给出更新命令（也可手动点击版本号检查）。升级只需把命令里的版本号换成最新 tag：
>
> ```bash
> dsh plugin --profile desktop add github:Jydsh/dsh-ding-card#v2026.11.01
> ```
>
> 更新后**重启 DSH** 生效。

> **前提**：执行安装的 DSH 服务器需能访问 GitHub（源码拉取需要网络）。无法访问时，可将本地 `npm pack` 生成的 `.tgz` 包拷入服务器，改用「本地目录路径 / 本地文件」方式安装。

### 方式二：发布到 npm 后按包名安装（可选）

`dsh plugin add dsh-ding-card`（官方源或中国大陆镜像源均可）。本仓库未自动发布，需要时按需发布。

### 手动安装（本地开发）

1. 安装 [dsh-im](https://github.com/xmanrui/dsh-im) 并配置好钉钉机器人（插件复用其连接，不复制密钥）。
2. 安装本插件到 DSH 的 `integrations/dsh-ding-card`。
3. 重启 DSH，左侧边栏出现「钉卡片」入口。
4. 在「卡片库」添加卡片 → 导出模板 JSON → 在钉钉后台导入并绑定模板 ID。
5. 在「变量集」维护变量与 Mock，在「发送测试」验证效果。

## 开发与测试

```bash
npm run build                                   # tsc 编译 lib/*.ts → dist/（产物随源码提交）
node --test "D:\dsh\dsh-ding-card\test\*.test.mjs"   # 42/42
node --check lib/export.js lib/tools.js              # 语法检查（未迁移模块）
```

- **技术架构（混合）**：服务端模块逐步迁移 TypeScript（`store.ts` / `rpc.ts` / `updater.ts` 已完成，其余服务端模块迁移中）；`client.js` 保持 JavaScript（浏览器专用模块格式，TS 收益低）。类型契约集中在 `store.ts`（卡片/变量/配置结构）与 `rpc.ts`（管理页 RPC 消息），跨模块共享。
- 生效规则：`tools.js` / `export.js` / `cards.js` 改动需重启 DSH；`client.js` 改动重开管理页即可；`.ts` 改动需 `npm run build` 后重启。

## 目录结构

```
lib/
  store.ts        配置与变量集（已转 TS，类型契约中心）
  rpc.ts          管理页 RPC（已转 TS）
  updater.ts      版本检查 + 安装环境识别（profile / 来源 / CLI）与一键更新执行（已转 TS）
  log.ts          事件日志（已转 TS）
  index.ts        插件入口与安装（已转 TS）
  dshim.ts        dsh-im 集成（已转 TS）
  dingtalk.ts     钉钉 API 客户端（已转 TS）
  export.ts       卡片数据构建与模板导出（已转 TS）
  import.ts       钉钉模板 JSON 导入（已转 TS）
  tools.js        Agent 工具（ding_card_list / ding_var_list / ding_card_send，保持 JS）
  cards.js        卡片生命周期（发送/回调/回收/持久化，保持 JS）
  interactions.js 提问/审批卡片接入（保持 JS）
  stream-bridge.js 钉钉 Stream 回调（保持 JS）
  routing.js      路由解析（保持 JS）
  client.js       管理界面（保持 JS，浏览器模块格式）
dist/             tsc 编译产物（随源码提交，main 指向 dist/index.js）
docs/             架构与模板文档
test/             单元测试
```

## License

MIT
