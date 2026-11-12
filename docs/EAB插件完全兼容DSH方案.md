# EAB 插件完全兼容 DSH 方案

> 状态：方案待确认，本文不改代码。
> 结论口径：以本仓库当前代码和本机 DSH NEXT 0.2.2-rc.1 的实际包为准，不把“兼容层里已经有一个同名服务”当成“DSH 能力已经实现”。
> **2026-11-12 路线收敛**：用户明确 EAB 保持主项目、单 Web 环境、不引入多 profile，只复用 DSH 的插件注入/页面显示机制。最新可行性结论见 `docs/EAB复用DSH插件注入与显示机制方案.md`。本文第 5～13 节的“每 scope 一个官方 DSH runtime sidecar”降为备选，不再作为实施主线；第 0.4、11.1、14 节的 EAB 主项目边界和影响评估仍然有效。

---

## 0. 直接回答

### 0.1 现在有没有实现“完全兼容 DSH”？

没有。

EAB 目前实现的是“DSH 插件协议的部分适配层”，不是“DSH 运行时”。它能跑通一部分插件，是因为这些插件只碰到适配层已经覆盖的服务和 slot；换一个插件，碰到没覆盖的契约，就会出现：

- 页面外壳能打开，但主面板空白；
- `ctx.slots.register` 调用了，页面没有出现；
- 插件的 `ctx.inject` 一直在等 `commands / credentials / llm / attachments`；
- 工具、模型、命令注册了，但 EAB 对话链路不消费；
- `dsh-context` 能打开设置页，但会话投影是空的，接不进真实对话。

这不是某一两个插件的 Bug，而是兼容层只覆盖了 DSH 的一个子集。

### 0.2 是两个项目架构完全不一样吗？

不是“完全不一样”，但也不是“用了 DSH 同一套核心代码”。

相同的是骨架：

- 都用 Cordis 的 `Context / Fiber / inject / effect / provide`；
- 都用 `window.__ModuleLoader__.load({ id, factory })` 加载客户端插件；
- 都用 slot 注册组件；
- 插件清单都读 `package.json` 的 `dsh` 段。

不同的是核心：

- DSH 的会话是 append-only 事件日志，工具、消息、审批、投影都从事件派生；
- EAB 的会话是 `chat_sessions / chat_messages` 两张表，插件看到的 `sessions` 只有元数据，`sessionQuery.observeSession` 固定返回 `events: []`；
- DSH 的页面由 `dsh-client-ui-layout` 等父级插件声明 slot，`ui-renderer` 负责真实渲染；
- EAB 的 `dsh-runtime.js` 是约 40KB 手写兼容层，只声明了 `main / conversation.view / sidebar.panellist / sidebar / settings.section` 五个位置；
- DSH 的 `agents / attachments / approval / userQuestions / pluginManager / commands.execute / webServer` 都是可工作的服务；
- EAB 里这些多数是 `available: false` 或固定空返回。

所以准确的判断是：

> EAB 复制了 DSH 的“外壳协议”，没有复制 DSH 的“运行时内核”。

### 0.3 把 DSH 的架构整理进 EAB，能不能做到“装 DSH 插件就能用”？

能，但前提是换掉“手写模拟层”，引入 DSH 官方运行时。

如果继续在 `plugin-host.ts` 里按插件补服务、在 `dsh-runtime.js` 里补模块 provider，就只能做到“当前这几个插件能用”，做不到“任意 DSH 插件安装即可用”。

“完全兼容”的最低要求是：

1. 插件的 host 侧跑在 DSH 官方 Cordis 运行时和官方服务实现上；
2. 插件的 client 侧跑在 DSH 官方 client runtime / slot renderer / layout 上；
3. 会话、工具、模型、附件、审批、命令由同一套 DSH 服务图提供，而不是 EAB 各写一个桩；
4. EAB 的多租户、权限、渠道、知识库作为“业务插件/桥接插件”接进去，而不是替代 DSH 内核。

### 0.4 本方案的边界：EAB 不被替换

这一条是硬约束，后面的设计都不能违反：

- **EAB 仍是唯一的产品主项目**：控制台、个人工作台、聊天、渠道、组织权限、知识库、计费、审计、数据表都留在 EAB。
- **DSH 不作为 EAB 的替代品**，只作为“插件兼容内核”运行在 EAB 背后。
- **EAB 聊天的执行引擎不变**：仍由 EAB 自己调度模型、工具、权限和渠道；DSH 不接管对话主流程。
- **EAB 会话主数据不变**：仍以 `chat_sessions / chat_messages` 为事实源；DSH session log 只做兼容镜像，供插件读取。
- **插件页面可以借用 DSH 的 Web 运行时**，但页面容器、入口、身份和权限仍由 EAB 提供。
- 用户感知不到“多了一个 DSH”：安装、启用、卸载、打开插件页，仍然全部在 EAB 里完成。

一句话：

> 不是把 EAB 换成 DSH，而是在 EAB 里嵌一个“DSH 插件兼容内核”。

---

## 1. 当前兼容性判定

### 1.1 按插件类型看

| 插件类型 | 典型插件 | 当前表现 | 判定 |
|---|---|---|---|
| 纯工具型 | 只注册 `tools` / `systemPrompt` | 能注册，EAB 对话可能消费 | 部分可用 |
| 设置页型 | 只注册 `settings.section` | 页面能显示 | 部分可用 |
| 全局页面型 | `dsh-cy-api`：`main` + `sidebar.panellist` | 已能显示基础页 | 部分可用 |
| 多渠道 RPC 型 | `dsh-ding-card`：settings + `connection.rpc` | 页面可出，RPC 依赖网关补齐 | 部分可用 |
| LLM adapter 型 | `dsh-our-free-model`：`llm.registerAdapter` + credentials + commands | 依赖多个服务，容易等待或降级 | 不稳定 |
| 会话/上下文型 | `dsh-context`：sessions + projections + conversation + sidebar-right | 页面能出壳，数据为空，接不进会话 | 不可用 |
| 布局/会话增强型 | 注册 `main` 之外的 `shell.*`、`rightbar`、`composer`、消息级 slot | 注册无效果或直接报未声明 | 不可用 |
| bundle/profile 型 | 依赖 `cordis.patch.yml`、多 bundle、`engines.dsh` | 安装器没有完整执行 DSH profile 语义 | 不可靠 |

### 1.2 已确认的硬证据

宿主侧 `packages/server/src/plugin-host.ts`：

- `sessions` 只有 `id / sessionId / header / events: [] / snapshotEvents() / append()`，`append()` 是空函数；
- `sessionQuery.observeSession` 固定返回 `events: []`；
- `sessionProjections.stateOf` 对 `contextTimeline` 返回固定空时间线；
- `agents`、`attachments`、`approval`、`userQuestions` 标记 `available: false`；
- `commands.execute` 固定返回 `commands-unavailable`；
- `pluginManager` 无实际 `enable / disable / reload`；
- `webServer.registerUpgrade` 只登记并警告，`registerFallback / tapIndex` 直接忽略；
- `connection.admit` 是空放行。

客户端侧 `packages/server/public/dsh-runtime.js`：

- 是手写兼容运行时，不是 DSH 官方 client runtime；
- 只提供 `react / primitives / connection / slots / settings / locale / runtime` 等少量模块；
- slot 是“注册了就摆上去”的简化表，没有 DSH 的声明校验、single/list/keyed/chain、Component Factory、store seat、真实 renderer；
- 只渲染 `main / conversation.view / sidebar.panellist / sidebar / settings.section`，其他 slot 注册不会出现在页面。

插件侧实际依赖：

- `dsh-context` 的 `package.json` 明确声明 client inject：
  - `@deepseek-ai/dsh-api-remotes`
  - `@deepseek-ai/dsh-client-connection`
  - `@deepseek-ai/dsh-client-locale`
  - `@deepseek-ai/dsh-client-ui-conversation`
  - `@deepseek-ai/dsh-client-ui-settings`
  - `@deepseek-ai/dsh-client-ui-sidebar-right`
- EAB 当前没有 `dsh-api-remotes`、`dsh-client-ui-conversation`、`dsh-client-ui-sidebar-right` 的真实实现，所以 `dsh-context` 只能显示外壳，接不到会话。
- `dsh-ding-card` 依赖 `dsh-client-runtime / connection / settings / slots / locale`，EAB 只有最简版本。
- `dsh-our-free-model` host 侧依赖 `credentials / commands / llm / webServer / profileContext`，EAB 的 `commands.execute` 和 `llm.registerAdapter` 都不完整。

---

## 2. 根因：四个结构性错位

### 2.1 会话模型错位：消息表 vs 事件日志

DSH 的会话不是“消息列表”，而是 append-only 事件流：

- 用户消息、助手消息、工具调用、工具结果、审批、定时器、子 Agent、压缩检查点，都是事件；
- `sessionQuery`、`sessionProjections`、`dsh-context` 都从事件流派生；
- `resume / fork / replay` 共用同一份日志。

EAB 当前是：

- `chat_messages` 存最终文本；
- 工具轨迹塞在 `meta_json`；
- 插件拿到的 `events` 永远是空数组；
- `contextTimeline` 永远是空时间线。

所以 `dsh-context` 不是“页面没画好”，而是“它要读的源根本不存在”。继续补 `stateOf` 的字段名没有意义，除非真的把 EAB 的对话写成 DSH 事件。

### 2.2 UI 模型错位：声明式 slot 树 vs 固定位置表

DSH 的 slot 系统是：

- 父级插件声明 slot（名称、kind、scope、children）；
- 子插件只能注册到已声明 slot；
- `ui-renderer` 负责 React 渲染、store seat、factory、生命周期；
- 未声明、重复声明、单槽冲突会在加载期报错。

EAB 当前是：

- 固定五个位置；
- 注册表不做声明校验；
- 没有真实 renderer，只是在页面里手动挑 `main / sidebar / settings` 三组；
- 组件需要的 `ctx.sessions / ctx.layout / ctx.conversation / ctx.sidebar-right` 没有。

于是“插件注册了但页面没反应”是必然结果，不是偶发。

### 2.3 服务图错位：可工作的服务图 vs 大量 undefined 桩

DSH 插件不是只依赖一个 `ctx` 对象，它依赖一张服务图：

`tools → agents → sessions → sessionQuery → sessionProjections → llm → attachments → approval → userQuestions → commands → credentials → settings → pluginManager → webServer`

这些服务之间互相消费。EAB 目前是每个服务单独写一个对象，很多还是 `available: false`。结果是：

- 插件 `inject` 等不到服务，`apply` 不执行；
- 服务存在但返回空，插件完成 `apply` 后页面空白；
- 插件注册了工具/模型，EAB 对话链路不消费；
- 插件注册了路由，EAB 网关不支持 upgrade/fallback。

这不是“少一个字段”，是“少一张运行时图”。

### 2.4 安装模型错位：只读 manifest vs DSH profile/bundle

DSH 插件的安装不是“解压一个包、调一下 `apply`”：

- 插件声明 `dsh.bundle.patch`，通过 `cordis.patch.yml` 进入 profile；
- profile 组合多个 bundle；
- 启动前校验 `engines.dsh` 与 `peerDependencies`；
- 有 `pluginManager` 管理启用、禁用、重载、版本豁免；
- 有 HMR / 重启语义。

EAB 当前更多是“找到入口 JS，`ctx.plugin()` 一下”，对 `cordis.patch.yml`、多 bundle、profile 分层、版本校验处理不完整。插件“能 import”不等于“按 DSH 的 composition 正确挂载”。

---

## 3. 为什么继续按插件补服务不可行

### 3.1 组合爆炸

DSH 插件数量多，能力组合更多。每补一个服务，只覆盖碰到它的插件；下一个插件可能碰 `attachments + approval + userQuestions + commands` 的组合。补服务是线性的，插件能力组合是指数级的。

### 3.2 语义空洞补不出来

`events: []` 可以补成 `events: [fake]`，但 `dsh-context` 需要的是：

- 真实的 turn / step / tool call / tool result；
- 真实的 token 统计；
- 真实的 projection 版本；
- 真实的 session header / parent / child 关系。

这些不是字段名，是运行时产生的事实。没有事件源，补字段只会让页面从“报错”变成“显示 0”。

### 3.3 客户端运行时补不全

EAB 的 `dsh-runtime.js` 是手写子集。DSH 有几十个 client 包，插件可能依赖其中任意一个。继续加 provider 等于在 EAB 里重写一遍 DSH 前端框架，维护成本不会低于直接用官方包。

### 3.4 多实例隔离会继续踩坑

当前已经通过“每实例独立 DSH_HOME + 独立 host”解决了数据串号，但这是进程内改 `process.env.DSH_HOME` 的方案。DSH 官方运行时大量依赖进程级环境、模块解析、profile 目录、插件缓存；进程内多实例继续扩展，迟早会碰到：

- 全局模块缓存串实例；
- `process.env` 并发窗口；
- 同一包多版本解析冲突；
- 插件 native 依赖只加载一次；
- profile 级 HMR 监听互相干扰。

真正的隔离应该靠“每个 scope 一个运行时进程”，而不是在一个进程里反复切环境变量。

---

## 4. 目标架构

### 4.1 一句话

> EAB 保留产品壳和业务能力，把“DSH 插件运行时”整体替换为官方 DSH runtime；EAB 通过一个通用桥接层与它交互。

### 4.2 分层图

```
┌──────────────────────────────────────────────────────────────┐
│ EAB 产品壳                                                    │
│ 控制台 / 个人工作台 / 聊天 / 渠道 / 权限 / 知识库 / 计费        │
│ 插件详情页：嵌入真实 DSH Web 页面（iframe）                     │
└──────────────────────────┬───────────────────────────────────┘
                           │ EAB 业务 API + 统一桥接 API
┌──────────────────────────▼───────────────────────────────────┐
│ EAB DSH Runtime Supervisor（每 scope 一个进程）                │
│  · 生成 profile / cordis.patch.yml                            │
│  · 启动官方 dsh-sdk-app 或 dsh-web-app                       │
│  · 健康检查、懒启动、空闲回收、重启、日志                       │
│  · 不实现 DSH 服务，只管理进程和目录                            │
└──────────────────────────┬───────────────────────────────────┘
                           │ stdio JSON-RPC 或 loopback HTTP
┌──────────────────────────▼───────────────────────────────────┐
│ 官方 DSH Runtime（MIT，版本锁定 0.2.2-rc.1）                   │
│  dsh-base + dsh-sdk-app / dsh-web-app                        │
│  sessions / sessionQuery / sessionProjections / agents        │
│  tools / systemPrompt / llm / attachments / approval          │
│  commands / credentials / settings / pluginManager            │
│  Cordis Fiber / Loader / profile / bundle / HMR               │
│  + 一个通用 EAB Bridge 插件（只做业务对接，不改 DSH 内核）       │
└──────────────────────────────────────────────────────────────┘
```

### 4.3 三条原则

1. **兼容性交给 DSH 官方代码**
   EAB 不再自己实现 `sessions / sessionQuery / projections / agents / attachments / approval / commands / pluginManager / webServer` 的语义。

2. **EAB 只做业务边界**
   组织、成员、角色、权限、渠道、知识库、计费、审计、多租户归属，仍然由 EAB 的 SQLite 和业务服务负责。

3. **一个 scope 一个运行时进程**
   公司一个实例，每个员工个人一个实例。进程级隔离 `DSH_HOME`、profile、插件目录、数据目录，不再在进程内切环境变量。

---

## 5. 路线比较

| 路线 | 做法 | 兼容性 | 隔离性 | 迁移成本 | 风险 | 结论 |
|---|---|---|---|---|---|---|
| A. 继续补适配层 | 在 `plugin-host.ts` / `dsh-runtime.js` 里继续加服务和 provider | 永远只覆盖子集 | 进程内切 env，复杂后不可控 | 短期低 | 每个新插件仍可能失败 | 不推荐作为终局 |
| B. 进程内嵌官方核心 | 在 EAB 进程里直接 `new Context()` + 挂官方包 | 高 | 差，进程级状态冲突 | 中高 | 多实例串环境、模块缓存冲突 | 不推荐 |
| C. 每 scope 官方 sidecar | 每公司/员工启动一个官方 DSH runtime 进程 | 最高，等价 DSH | 最好，进程级隔离 | 中高 | 进程数、启动时延、内存 | **推荐** |

### 5.1 推荐 C，但不是“把 DSH 桌面端搬进来”

不搬：

- 不搬 Electron 桌面壳；
- 不搬 DSH 的桌面窗口、菜单、更新器；
- 不要求用户安装 DSH NEXT。

只使用公开发布的 `@deepseek-ai/*` runtime 包：

- `@deepseek-ai/cordis`
- `@deepseek-ai/cordis-plugin-loader`
- `@deepseek-ai/dsh-app-boot`
- `@deepseek-ai/dsh-base`（profile bundle）
- `@deepseek-ai/dsh-sdk-app` + `dsh-sdk-jsonrpc-server`（每 scope 的 stdio runtime）
- 或 `@deepseek-ai/dsh-web-app` + `dsh-web-frontend`（每 scope 的 loopback Web runtime）
- 以及 `dsh-session* / dsh-tools / dsh-llm / dsh-agent / dsh-attachment* / dsh-user-approval / dsh-user-questions / dsh-commands / dsh-settings / dsh-credentials* / dsh-plugin-manager / dsh-host-webserver`

这些包在本机 DSH NEXT 里已经存在，版本 `0.2.2-rc.1`，`license = MIT`。建议通过 npm/pnpm 安装公开包，而不是从 `app.asar` 直接拷贝；`app.asar` 只用于本轮核对契约。

### 5.2 两种 sidecar 形态

| 形态 | 用途 | 优点 | 代价 |
|---|---|---|---|
| SDK sidecar：`dsh-sdk-app` + stdio JSON-RPC | 插件的 host 侧、工具、模型、命令、会话镜像；EAB 在需要调用插件能力时访问它 | 官方完整 base，协议稳定，无端口 | 需要 EAB 做 JSON-RPC 客户端；插件页面另走 Web 客户端 |
| Web sidecar：`dsh-web-app` + 官方前端 | 插件页面、设置页、slot 渲染 | 页面兼容性最高，直接复用官方 UI | 每 scope 一个 loopback 端口；需要反向代理/iframe |

建议组合：

- **插件 host 侧、工具、模型、命令、会话镜像**走 SDK sidecar；
- **插件页面**由同一个 scope 的 Web sidecar 提供，或在 SDK runtime 上单独挂 Web 客户端网关；
- 两者共享同一个 `DSH_HOME` 和 profile，保证 session/plugin 状态一致；
- **EAB 聊天本身不交给 sidecar 执行**，sidecar 只在 EAB 需要调用插件贡献时被访问。

如果第一阶段不想维护两个进程，可以先只上 **Web sidecar + iframe 插件页**，先把“页面能显示、slot 能注册、插件能跑”解决；随后再把插件工具/模型/命令接进 EAB 现有聊天链路。

---

## 6. 分阶段落地

### 阶段 0：建立兼容性基线（不改产品行为）

目标：把“感觉不兼容”变成可重复的失败清单。

要做：

1. 固定 DSH runtime 版本：`0.2.2-rc.1`；
2. 建 `dsh-compat/` 验收目录，放五个金标准插件：
   - `dsh-cy-api`（全局页面 + 工具 + 网关）
   - `dsh-context`（会话投影 + conversation + sidebar-right）
   - `dsh-ding-card`（settings + RPC + layout）
   - `dsh-our-free-model`（llm adapter + credentials + commands）
   - 一个自造 `compat-full-surface` 插件：同时注册 tool / prompt / command / model / main / settings / session projection / attachment
3. 同一插件在官方 DSH NEXT 里跑一遍，记录：
   - 页面截图
   - 注册出的 slot / 工具 / 模型 / 命令
   - 会话事件数量
   - RPC 调用
4. 在 EAB 当前实现里跑一遍，记录差异；
5. 输出机器可读的 `compatibility-report.json`，每条包含 `pluginId / capability / status / missingService / missingModule / missingSlot / error`。

验收：

- 五个插件在官方 DSH 里全部通过；
- EAB 当前实现的失败点可以逐条定位，不再靠看空白页猜。

### 阶段 1：官方 DSH Runtime Supervisor

目标：让每个 scope 有一个真实的 DSH runtime，而不是 EAB 里的模拟宿主。

要做：

1. 新增 `packages/server/src/dsh-runtime/`：
   - `supervisor.ts`：按 `PluginScope` 管理进程；
   - `profile.ts`：生成 `DSH_HOME`、profile、`cordis.patch.yml`；
   - `client.ts`：stdio JSON-RPC / loopback HTTP 客户端；
   - `health.ts`：启动、就绪、心跳、退出、重启；
   - `paths.ts`：公司/个人目录布局。
2. 目录布局：

```
.eab-dev/dsh-runtime/
  packages/                         # 只读共享包缓存
  scopes/
    company/
      c1/
        DSH_HOME/
        profile/
        data/
        logs/
    users/
      c1/
        u_dingtalk_273939032226192369/
          DSH_HOME/
          profile/
          data/
          logs/
```

3. 启动参数固定：
   - `DSH_HOME` 指向该 scope；
   - `cwd` 指向该 scope 的 data；
   - profile 只包含该 scope 的插件集合；
   - stdout 只走协议，日志走 stderr 或文件；
   - 子进程退出/崩溃自动标记，不拖垮 EAB 主进程。
4. 生命周期：
   - 首次访问懒启动；
   - 空闲 N 分钟停止；
   - 安装/卸载/启用/禁用时只重启对应 scope；
   - EAB 重启后按活跃安装恢复。
5. 移除进程内 `process.env.DSH_HOME` 切换逻辑；`plugin-host.ts` 不再负责启动插件，只保留旧路径兼容开关。

验收：

- 公司、员工 A、员工 B 三个 scope 各自启动一个独立 DSH runtime；
- 三者的 `DSH_HOME`、profile、session 文件、插件数据目录不同；
- A 修改插件配置不影响 B；
- 停止 A 的 runtime 不影响公司实例和 B。

### 阶段 2：Host 侧桥接与会话镜像

目标：插件注册的工具/模型/命令/提示/审批能被 EAB 使用；EAB 的对话能投影成 DSH 会话事件供插件读取，但**不反向接管 EAB 对话**。

#### 2.1 通用 Bridge 插件

只做一个 DSH 插件：`@eab/dsh-bridge`，挂在每个 scope 的 profile 里。它负责：

| 方向 | 内容 |
|---|---|
| DSH → EAB | 把 `tools / systemPrompt / commands / llm adapter / settings / session projection` 的贡献通过桥接 API 报给 EAB |
| EAB → DSH | 把 EAB 的模型 provider、工具执行器、审批、附件、用户提问、业务上下文注入 DSH 服务 |
| 事件 | 把 EAB 的 turn 事件写成 DSH 会话事件；把 EAB 审批/用户回答写回 DSH；DSH 事件只用于插件读取和兼容性诊断，不回写 EAB 主消息 |

它不是“再实现一遍 DSH 服务”，而是“把 EAB 的业务能力适配成 DSH 服务”。DSH 内核仍然是官方的。

#### 2.2 会话：EAB 是事实源，DSH 是兼容镜像

这条必须定死：

> **EAB `chat_sessions / chat_messages` 仍然是唯一主数据；DSH session log 是镜像，不是事实源。**

理由：

- 用户明确要求 EAB 不被 DSH 替换，EAB 的渠道、权限、审计、计费、消息表不能被绕过；
- EAB 的功能比 DSH 多，切主数据会把现有聊天、工具、渠道全部拖进迁移风险；
- 插件需要的是“能读到真实事件流”，不要求“事件流必须由 DSH 写入”。

做法：

1. EAB 每产生一个 turn，向对应 scope 的 DSH runtime 镜像事件：
   - 用户消息；
   - 助手消息；
   - 工具调用开始 / 参数 / 结果；
   - 审批请求 / 结果；
   - 用户提问 / 回答；
   - turn 结束 / 错误 / 中断；
2. 事件字段按 DSH `dsh-session` 的类型和顺序生成，不自己造一套；
3. `sessionQuery.observeSession` 读镜像日志；
4. `sessionProjections` 由 DSH 官方投影消费镜像日志；
5. `dsh-context` 的 conversation / sidebar-right 读的是这份镜像，不读 EAB 表；
6. EAB UI 仍读自己的投影/缓存表，不依赖 DSH 页面；
7. 镜像失败不回滚 EAB 主消息，只标记该会话的插件兼容性为 `degraded`，并在插件详情页显示“上下文数据可能不完整”。

这样：

- EAB 的产品功能、数据归属、执行链路不变；
- context/session 类插件能拿到真实事件；
- DSH 仍然是插件兼容内核，不是新的主系统。

老会话处理：

- 不做强制迁移；
- 第一次被插件读取时，按需把该会话的历史消息补写成镜像事件；
- 补写失败就只让该插件降级，不影响 EAB 正常聊天。

#### 2.3 模型

- 把 EAB 现有模型 provider 作为 DSH `llm` 的一个 provider 暴露给插件；
- 把插件 `llm.registerAdapter` 注册的模型同步回 EAB 模型目录；
- 模型 ID 仍按实例隔离：公司模型、员工个人模型不互相可见；
- **对话路由仍由 EAB 决定**：EAB 选模型、做权限过滤、做计费、做失败转移；插件只提供 adapter 能力。

#### 2.4 工具与提示

- 插件 `ctx.tools.register` 的工具进入 DSH `tools` 服务；
- EAB 的 `executeTool` 作为 DSH 工具执行器的一个 provider；
- 系统提示按 DSH `systemPrompt` 贡献合并；
- 命令 `ctx.commands.register` 进入 DSH `commands`；EAB 聊天输入 `/` 命令时，只有插件命令转发到 `commands.execute`，EAB 自己的命令仍走 EAB。

#### 2.5 审批、附件、提问

- `approval` 接 EAB 现有审批表和通知渠道，后台/定时任务 fail-closed；
- `attachments` 接 EAB 文件存储，保留 DSH 的 content-addressed 引用；
- `userQuestions` 接 EAB 的交互提问/渠道卡片；
- `agents` 只作为“插件需要看到的 Agent 能力视图”，先支持 `list/get`；**EAB 自己的多 Agent 运行时仍是唯一执行者**，不迁到 DSH。

验收：

- 插件工具在 EAB 对话里可被模型调用；
- `dsh-our-free-model` 的模型出现在 EAB 模型目录并可对话；
- `dsh-context` 能看到真实 turn / tool call / token 统计；
- `dsh-ding-card` 的审批/提问能通过 RPC 到钉钉卡片；
- 会话关闭后重开，EAB 消息和 DSH 镜像都还在。**以 EAB 消息为准，镜像只做插件兼容。**

### 阶段 3：客户端与插件页面

目标：不再用 `dsh-runtime.js` 模拟 DSH 前端。

推荐先做“真实 DSH Web 页面 iframe”，再做“EAB 原生壳加载官方 client runtime”。

#### 3.1 方案 3A：iframe 真实 DSH Web（最快、兼容性最高）

- 每个 scope 的 DSH Web runtime 监听 loopback 端口；
- EAB 插件详情页只渲染 EAB 的标题栏、状态栏、操作按钮；
- 主体 iframe 指向该 scope 的 DSH Web；
- 通过一次性签名 URL / Cookie 绑定当前员工身份；
- EAB 不解析插件 DOM，不代理插件内部请求；
- 插件页面里的 slot、layout、settings、conversation、sidebar-right 全部由官方前端负责。

注意：

- iframe 只是“插件页面的渲染容器”，不是把 EAB 换成 DSH；
- EAB 的导航、工作台、聊天、权限、数据仍在 EAB 自己的页面里；
- 用户仍从 EAB 进入插件，看到的是 EAB 的标题栏和操作按钮，只有插件主体区域由 DSH Web 渲染。

优点：

- 不需要重写 `dsh-runtime.js`；
- `dsh-context` 这类强依赖 conversation/sidebar-right 的插件能直接用；
- 插件升级不需要 EAB 跟着改。

代价：

- 插件页是 DSH 的视觉，不是 EAB 的视觉；
- 需要管理 loopback 端口和会话票据；
- iframe 内的导航、弹窗、下载要按 DSH 原生行为处理。

#### 3.2 方案 3B：EAB 壳加载官方 client runtime

如果必须保持 EAB 视觉，再做：

- 用官方 `dsh-client-modules` / `dsh-cordis-client-runner` 替代手写 ModuleLoader；
- 用官方 `dsh-client-ui-slots` + `dsh-client-ui-renderer` 替代手写 slot 表；
- 用官方 `dsh-client-ui-layout` 或复制它的声明表，补齐标准 slot；
- 用官方 `dsh-client-connection` 接 RPC；
- 用官方 `dsh-client-ui-settings / locale / theme / store / primitives`；
- EAB 只提供页面骨架和主题变量。

这条路工作量大，建议在 3A 验证插件生态后再做。

#### 3.3 删除旧运行时

当 3A 或 3B 上线后：

- `dsh-runtime.js` 只保留历史兼容开关；
- `plugin-host.html` 不再从 host 状态拼路由前缀；
- 插件 RPC 统一走 scope 网关，不再按插件前缀猜。

验收：

- `dsh-context` 页面完整显示上下文仪表盘、token 统计、会话时间线；
- `dsh-cy-api` 主页面、侧栏入口、设置页都出现；
- `dsh-ding-card` 设置区和 RPC 正常；
- 任意注册到 `shell.* / rightbar / composer / message.*` 的组件不再静默消失。

### 阶段 4：安装器与插件市场

目标：按 DSH 的方式安装，而不是按 EAB 的方式解压。

要做：

1. 用官方 `dsh-plugin-manager` 或它的 profile 操作语义：
   - `add / remove / enable / disable / update`；
   - 写入该 scope 的 profile manifest 和 `cordis.patch.yml`；
   - 校验 `engines.dsh` / `peerDependencies`；
   - 记录 `skippedBundles` / 不兼容原因。
2. 包缓存：
   - 公司/个人共享只读包缓存；
   - 每个 scope 的 profile 做链接或复制；
   - 最后一个归属卸载才清共享缓存。
3. 安装后健康检查：
   - runtime 启动成功；
   - 插件 fiber 进入 `ACTIVE`；
   - 注册出的 slot / tool / model / command 数量；
   - 页面首屏无错误；
   - 失败时给出明确 `missingService / missingModule / incompatibleVersion`。
4. 不执行插件 lifecycle 脚本，除非用户显式允许；保持现有安装安全边界。

验收：

- 安装一个只在 DSH 里验证过的插件，不修改 EAB 代码即可启动；
- 安装失败时页面显示具体原因，不是空白；
- 卸载只影响当前 scope；
- 共享包缓存在最后一个归属卸载后才清理。

### 阶段 5：切换与回退

1. 新插件默认走 DSH runtime；
2. 旧插件保留 `compat=legacy` 开关，按 scope 灰度；
3. 每个 scope 记录 runtime 版本、profile hash、插件列表；
4. 出问题可回退到旧宿主，但旧宿主只作为过渡，不再扩展能力；
5. 兼容性报告进入控制台“插件详情”，显示：
   - `full / degraded / unsupported`
   - 缺失服务
   - 缺失客户端模块
   - 未声明 slot
   - 最近一次启动错误

---

## 7. 关键设计细节

### 7.1 每 scope profile 生成

公司 scope 的 profile 概念上：

```json
{
  "name": "eab-company-c1",
  "private": true,
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-sdk-app"
      ]
    }
  }
}
```

`cordis.patch.yml` 里追加：

```yaml
- insert:
    - id: eab-bridge
      name: '@eab/dsh-bridge'
      config:
        companyId: c1
        scope: company
        callbackBase: 'http://127.0.0.1:8788/internal/dsh'
```

个人 scope 同样生成，但：

- `DSH_HOME` 指向个人目录；
- `scope: user`；
- `userId` 写入 bridge config；
- 只加载本人安装的插件。

### 7.2 进程边界

```
EAB server (PID 12264)
  ├─ DshRuntimeSupervisor
  │   ├─ child: dsh-runtime company c1 (port/stdio)
  │   ├─ child: dsh-runtime user c1/u_A
  │   └─ child: dsh-runtime user c1/u_B
  └─ EAB business services
```

规则：

- 子进程崩溃只影响该 scope；
- 子进程启动失败不阻塞 EAB 登录，只让对应插件显示失败；
- 子进程 stdout 只用于协议，日志写文件；
- 子进程退出时 flush session，再关闭；
- 不在 EAB 进程里改 `process.env.DSH_HOME`。

### 7.3 桥接 API 的最小面

建议只开这些内部接口，避免 EAB 又变成“第二套 DSH”：

| 接口 | 方向 | 用途 |
|---|---|---|
| `POST /internal/dsh/:scope/session/:id/event` | EAB → DSH | 把 EAB 已完成/进行中的 turn 镜像为 DSH 事件 |
| `POST /internal/dsh/:scope/tool/:name/call` | EAB → DSH | EAB 调用插件注册的工具 |
| `GET /internal/dsh/:scope/session/:id/events` | EAB ← DSH | 读插件侧事件/投影，用于兼容性诊断 |
| `POST /internal/dsh/:scope/approval` | EAB → DSH | 把 EAB 审批结果回写给插件 |
| `POST /internal/dsh/:scope/question` | EAB → DSH | 把 EAB 用户回答回写给插件 |
| `GET /internal/dsh/:scope/contributions` | EAB ← DSH | 工具/模型/命令/提示清单 |
| `POST /internal/dsh/:scope/plugin/:id/action` | EAB → DSH | 启用/禁用/重载/卸载 |

插件自己的 HTTP 路由仍由 DSH `webServer` 提供；EAB 只做 scope 鉴权和反向代理，不再按插件前缀拼桥。

### 7.4 数据归属

| 数据 | 归属 | 说明 |
|---|---|---|
| 组织/成员/角色/权限 | EAB SQLite | 业务事实 |
| 渠道配置/会话绑定 | EAB SQLite | business |
| 知识库/文档/向量 | EAB SQLite + 文件 | business |
| 计费/额度/审计 | EAB SQLite | business |
| 插件安装归属/启用状态 | EAB SQLite | 用于 scope 解析 |
| DSH session event log | DSH runtime 的 `DSH_HOME` | 插件兼容镜像，不是主事实源 |
| 插件自己的 settings/storage | 该 scope 的 `DSH_HOME` | 每实例独立 |
| 共享插件包 | 只读缓存 | 最后归属卸载才清理 |

---

## 8. 验收矩阵

### 8.1 功能验收

| 能力 | 验收动作 | 通过标准 |
|---|---|---|
| 页面 | 打开 `dsh-cy-api`、`dsh-context`、`dsh-ding-card` | 主面板、侧栏入口、设置区都显示，无空白 |
| slot | 自造插件注册 `main / sidebar.panellist / settings.section / shell.bottom / rightbar` | 每个位置都出现，未声明时有明确报错 |
| 工具 | 插件注册工具，EAB 对话调用 | 模型能看到工具，调用成功，结果写回事件 |
| 提示 | 插件注入 system prompt | 能在会话请求里看到贡献 |
| 模型 | `dsh-our-free-model` 注册 adapter | EAB 模型目录出现，能对话，权限过滤正确 |
| 命令 | 插件注册 `/xxx` | EAB 输入 `/xxx` 能执行，错误有明确返回 |
| 会话 | `dsh-context` 打开当前会话 | 有真实 turn / tool call / token 统计 |
| 投影 | 切换会话 | 投影随会话变化，不是固定空时间线 |
| 附件 | 插件上传/引用附件 | 文件可读，引用不丢 |
| 审批 | 插件请求审批 | EAB 审批表/渠道收到，结果回写 |
| RPC | `dsh-ding-card` 调 RPC | 网关原样转发，错误码保留 |
| 多实例 | 公司/A/B 同时装同一插件 | 配置、数据、模型 ID 独立 |
| 卸载 | 卸载 A 的个人插件 | 只删 A 的 profile/data，公司和 B 不变 |
| 重启 | 重启 EAB | 活跃 scope 恢复，会话/投影还在 |

### 8.2 兼容性报告

每个插件至少输出：

```json
{
  "pluginId": "dsh-context",
  "version": "0.83.1",
  "runtime": "0.2.2-rc.1",
  "scope": "user:c1:u_A",
  "state": "active",
  "compatibility": "full",
  "missingServices": [],
  "missingClientModules": [],
  "missingSlots": [],
  "contributions": {
    "tools": 0,
    "prompts": 0,
    "commands": 1,
    "models": 0,
    "slots": ["main", "settings.section", "sidebar.right"]
  },
  "lastError": null
}
```

`degraded` 必须写清楚缺什么；`unsupported` 必须写清楚版本/协议原因。不允许再用空白页表达失败。

---

## 9. 风险与边界

| 风险 | 影响 | 应对 |
|---|---|---|
| 进程数/内存 | 每员工一个 runtime，人数多时资源高 | 懒启动、空闲回收、限制并发 scope |
| 启动时延 | 首次打开插件页慢 | 预热活跃 scope；页面显示启动状态 |
| 端口管理 | Web sidecar 每 scope 一个端口 | 只绑 loopback，端口池 + 鉴权票据 |
| 版本漂移 | DSH 升级后插件不兼容 | 锁定 `0.2.2-rc.1`，升级前跑兼容矩阵 |
| native 依赖 | 某些插件带平台二进制 | 安装时校验平台/架构，失败明确提示 |
| 事件镜像保真 | EAB 消息转 DSH 事件时丢工具顺序/审批状态，context 插件会偏 | 先做单会话对账；镜像失败只降级插件，不改 EAB 主消息 |
| EAB 功能回归 | 聊天切 DSH 后，原有工具/权限/渠道要重接 | 分 scope 灰度，保留 legacy 回退 |
| 许可 | vendoring 需要保留 LICENSE/NOTICE | 只分发 MIT/Apache-2.0 包，保留版权声明 |
| stdout 污染 | 插件打印日志会破坏 JSON-RPC | 子进程 stdout 只给协议，插件日志重定向 |
| Windows 沙箱 | DSH base 默认带 PowerShell sandbox ACL | 先关闭不需要的 sandbox 行，或按 DSH 默认策略跑 |

---

## 10. 明确不做的事

1. 不从 `app.asar` 整包拷贝 DSH 桌面端；
2. 不把 DSH 的 Electron 壳、更新器、桌面窗口搬进 EAB；
3. 不再为单个插件补 `plugin-host.ts` 的服务桩；
4. 不再扩展手写 `dsh-runtime.js` 去模拟 DSH 前端；
5. 不在一个进程里用 `process.env.DSH_HOME` 切多实例；
6. 不用 `events: []` / 固定空时间线冒充“已兼容”；
7. 不把 EAB 的聊天、Agent、渠道、权限、计费迁到 DSH；
8. 不让 DSH session log 取代 EAB `chat_messages`；
9. 不在未确认前自动升级 DSH runtime 版本；
10. 不在未确认前推送 GitHub。

---

## 11. 已定边界与待拍板事项

### 11.1 已定，不再讨论

| 事项 | 结论 |
|---|---|
| EAB 与 DSH 的关系 | EAB 是主项目，DSH 只是插件兼容内核，不替换 EAB |
| EAB 聊天执行引擎 | 仍由 EAB 执行，不切到 DSH Agent |
| EAB 多 Agent / 渠道 / 权限 / 计费 | 仍由 EAB 负责 |
| 会话事实源 | EAB `chat_messages` 为准，DSH session log 为兼容镜像 |
| 插件页入口 | 仍从 EAB 进入，EAB 提供容器、身份和权限 |

### 11.2 还需要拍板

| 决策 | 选项 | 建议 |
|---|---|---|
| 插件页面形态 | DSH Web iframe / EAB 原生壳 + 官方 client runtime | **先 iframe**，快速验证生态；再按需要做原生壳 |
| 包引入方式 | npm 公开包 / app.asar 拷贝 | **npm 公开包**，锁 `0.2.2-rc.1`，保留 LICENSE |

这两件事决定之后，阶段 1 的目录、进程、profile 才能定稿。

---

## 12. 预计新增/修改的代码位置

> 下面是落地时的目标位置，不是本轮已完成的改动。

### 12.1 新增

- `packages/server/src/dsh-runtime/supervisor.ts`
- `packages/server/src/dsh-runtime/profile.ts`
- `packages/server/src/dsh-runtime/client.ts`
- `packages/server/src/dsh-runtime/health.ts`
- `packages/server/src/dsh-runtime/paths.ts`
- `packages/server/src/dsh-runtime/bridge-protocol.ts`
- `packages/server/src/routes/dsh-runtime.ts`
- `packages/dsh-bridge/`（通用 DSH bridge 插件）
- `packages/server/test/dsh-runtime-supervisor.test.ts`
- `packages/server/test/dsh-compat-matrix.test.ts`
- `docs/dsh-compat-report.md`（由测试生成）

### 12.2 修改

- `packages/server/src/plugin-host.ts`：逐步退化成 legacy 适配器，只保留旧 scope 开关；
- `packages/server/src/plugins.ts`：安装/卸载改为操作 scope profile；
- `packages/server/src/routes/plugins.ts`：返回 runtime 状态、兼容性报告；
- `packages/server/public/plugin-host.html`：改为 iframe/官方 runtime 容器；
- `packages/server/public/dsh-runtime.js`：标记 deprecated，最终删除；
- `packages/server/src/routes/chat.ts`：EAB 主读写不变；每个 turn 结束后异步镜像 DSH 事件，镜像失败只标记插件降级；
- `packages/server/src/plugin-models.ts`：EAB 模型目录内合并 DSH `llm` 贡献；EAB 权限过滤和路由仍是入口。

### 12.3 保留

- `packages/server/src/plugin-scope.ts`：scope 身份/数据根继续用；
- `packages/server/src/plugin-tools.ts` / `plugin-models.ts` 的实例隔离逻辑：作为桥接层的索引，不再作为 DSH 服务实现；
- `packages/server/src/routes/plugins.ts` 的个人/公司归属规则：继续作为业务事实。

---

## 13. 结论

1. **EAB 没有实现“完全兼容 DSH”**，当前是“部分协议适配 + 手写运行时子集”。
2. **不是两个项目架构完全无关**，而是只借了 Cordis/ModuleLoader/slot 的骨架，没有用 DSH 的会话事件流、服务图和客户端渲染器。
3. **靠继续补服务无法做到任意插件安装即用**，只会把失败从“缺服务”转移到“缺语义/缺 slot/缺渲染”。
4. **可行路径是引入官方 DSH runtime 作为兼容内核**：每 scope 一个进程，EAB 只做业务桥接和产品壳。
5. **EAB 本体不换**：聊天、渠道、权限、计费、会话主数据都留在 EAB；DSH 只提供插件运行时和插件页面渲染。
6. **最快的可见收益**是先让插件页面跑在真实 DSH Web runtime 里；**完整兼容**是把插件工具/模型/命令接进 EAB 链路，并持续把 EAB 会话镜像成 DSH 事件供 context 类插件读取。
7. 这是架构级改造，不是再修一个 `plugin-host.ts`。已定边界见第 11.1 节，剩下两个待拍板项确认后即可进入阶段 1。

---

## 14. 实施影响与缺陷评估

> 这一节回答“按这个方案做，对当前 EAB 有什么缺陷、有什么影响”。结论先说：**产品形态不变，但 EAB 的运行时层要做一次大改；能显著提高兼容率，不能保证“所有 DSH 插件”都可用。**

### 14.1 方案自身的缺陷

| 缺陷 | 具体表现 | 严重度 | 缓解方式 |
|---|---|---|---|
| 会话镜像不是原生事件 | EAB 消息转成 DSH 事件时，工具顺序、审批状态、token 统计、子 Agent 关系可能丢；`dsh-context` 可能只显示部分时间线 | 高 | 建事件契约测试；逐 turn 对账；镜像失败标记 `degraded`，不冒充完整 |
| 双前端、双运行时 | EAB 一套 UI，DSH Web 一套 UI；插件页视觉和导航与 EAB 不一致 | 中 | 只嵌入插件主体，隐藏 DSH 外壳；后续再做 EAB 原生 client runtime |
| 桥接层仍是兼容瓶颈 | 插件依赖的某个 DSH 服务没桥接到 EAB，仍会 `inject` 等待或页面空白 | 中高 | 建服务覆盖矩阵；缺失时明确报错，不再静默 |
| “所有插件”不可达 | 依赖 DSH 桌面能力的插件（原生目录选择、打开本地应用、终端、Office 转 PDF、窗口/剪贴板）在 EAB Web 里没有等价能力 | 高（预期管理） | 插件分级：Web 可兼容 / 部分兼容 / 仅桌面；不承诺全量 |
| 版本锁定 | 锁定 `0.2.2-rc.1` 后，DSH 升级和插件升级会错位 | 中 | 升级前跑兼容矩阵；按 scope 灰度 |
| 不是安全沙箱 | 插件 host 代码仍在 Node 进程里，能读文件、起子进程、访问网络；sidecar 只解决崩溃隔离，不解决恶意插件 | 高 | 明确信任边界；后续加 OS 级沙箱/白名单；不把不可信插件当安全隔离 |
| 双数据源 | EAB `chat_messages` 与 DSH session log 两份；镜像延迟、丢失、重放都要处理 | 高 | EAB 永远为准；镜像异步、可重建；对账任务 |
| 运维复杂度 | 每 scope 一个进程、端口、日志、profile；孤儿进程、端口冲突、文件锁 | 中 | 进程守护、PID 台账、动态端口、退出清理 |
| 测试复杂度 | 子进程测试比进程内慢，Windows 上更容易受端口/文件锁影响 | 中 | 单测覆盖纯逻辑，集成测只跑金标准插件 |

### 14.2 对当前 EAB 的具体影响

| 当前模块 | 现在怎么做 | 改造后 | 影响 |
|---|---|---|---|
| 启动流程 | `main.ts` 里 `reloadPluginHosts()`，进程内 `new Context()` | 启动 Supervisor，按活跃 scope 懒启动子进程 | 启动逻辑变复杂；单个 scope 失败不能拖垮 EAB；需要就绪状态 |
| 聊天 | EAB 自己执行 turn，直接写 `chat_messages` | 主链路不变；每个 turn 额外异步镜像 DSH 事件 | SSE 不能被镜像阻塞；镜像失败只降级插件；多一次 RPC/序列化开销 |
| 工具 | `plugin-tools.ts` 维护实例工具注册表，EAB 直接调用 | 工具清单来自 DSH bridge；EAB 通过桥接调用插件工具 | 多一跳；错误码、超时、取消、流式结果要重新映射 |
| 模型 | `plugin-models.ts` 持有 adapter、健康探测、目录同步、失败转移 | adapter 在 sidecar 里；EAB 通过 RPC 探测和调用 | 现有 800ms 去抖、定时同步、健康缓存都要改成跨进程；最容易回归 |
| 插件页面 | `plugin-host.html` + 手写 `dsh-runtime.js` | iframe 真实 DSH Web，或 EAB 壳 + 官方 client runtime | `dsh-runtime.js` 废弃；页面路由、导航、Tab、刷新恢复都要重做 |
| 安装/卸载 | 解压到插件目录，按需 `npm install --ignore-scripts` | 写入 scope profile / `cordis.patch.yml`，由 DSH 加载 | 安装成功标准变了；要处理 profile 回滚、孤儿 profile、共享包缓存 |
| 多实例 | 进程内切 `DSH_HOME`，按实例查 host | 每 scope 独立进程、独立 profile、独立数据目录 | 隔离更好；内存和进程数上升；Windows 文件锁要处理 |
| 数据库 | 单写进程锁 + `busy_timeout` + WAL | sidecar 不直接写 `eab.db`，只通过 bridge API | 必须守住“只有一个 EAB 写库进程”；插件不能拿 db 句柄 |
| 备份 | `eab backup` 只快照 SQLite | DSH_HOME、profile、插件 settings 也需要备份 | 当前备份不完整；恢复后会丢插件配置和会话镜像 |
| 更新 | `scripts/eab-update.mjs` 只拷贝固定 `packages/*` | 还要包含 `packages/dsh-bridge`、runtime 依赖和 profile 模板 | 不加会“更新后插件运行时消失” |
| 体积 | 当前依赖很少 | 本机 DSH 包树约 **340 个包 / 278MB**（解包后，不含 npm 额外开销） | 安装包、更新包、首次安装时间都会明显变大 |
| Node 版本 | `engines.node >= 22.5.0` | 部分 DSH 插件要求 `^22.19.0` | 低版本 Node 上会出现“EAB 能跑、插件跑不起来” |
| 审计 | EAB 审计表记录业务动作 | 插件在 sidecar 里的动作需要 bridge 回传审计 | 否则插件工具调用、审批、配置变更会绕过审计 |

### 14.3 对现有功能的回归风险

| 现有功能 | 风险 | 说明 |
|---|---|---|
| 聊天 SSE 流式输出 | 中高 | 镜像如果同步做，会拖慢首 token；必须异步、可丢弃、可重试 |
| 工具调用与流式工具结果 | 高 | EAB `meta_json` 与 DSH 事件结构不同；映射错会导致工具卡片不显示或重复 |
| 审批 | 高 | EAB 审批和 DSH `approval` 是两套状态机；容易出现重复通知、状态不回写 |
| 插件模型健康探测 | 高 | 现在探测进程内 adapter；改 RPC 后启动窗口、超时、重试都会影响“模型是否可见” |
| 个人卸载 | 中 | 必须先停子进程再删目录；Windows 上文件被占用会删不掉 |
| 公司/个人隔离 | 中 | profile、共享包缓存、模型 ID 都要重新核对；否则又回到串号 |
| 钉钉/飞书渠道 | 中高 | 渠道机器人走 EAB 工具链；bridge 不通时插件工具在渠道里不可用 |
| 定时任务 | 中 | 后台审批默认 fail-closed；bridge 失败不能把任务卡死 |
| 插件页刷新恢复 | 中 | iframe 的 URL、scope、票据、当前页签都要重新设计 |
| 现有 361 个测试 | 中 | 进程内假设失效；插件相关测试要改成“启动 sidecar + 调用 bridge”的集成测试 |

### 14.4 额外的安全与隔离缺陷

1. **iframe 端口是第三个入口**
   EAB 现在有 8787 员工端、8788 控制台端，并有 surface guard。DSH Web 如果直接开 loopback 端口，会绕开这两个入口的路径隔离；必须只绑 `127.0.0.1`，加一次性票据，并优先走 EAB 反向代理，而不是让浏览器直连。

2. **Cookie 共享**
   Cookie 不按端口隔离。EAB 和 DSH Web 都在 `127.0.0.1` 时，浏览器会把同一 host 的 Cookie 发给两个端口；DSH 的会话 Cookie 可能和 EAB 的冲突或被 DSH 读到。建议统一走 EAB 同源代理，或使用不同 host 名并明确 Cookie 名。

3. **插件代码不是沙箱**
   插件 host 代码可以 `fs`、`child_process`、`net`。sidecar 只是崩溃隔离，不是权限隔离。如果未来要装不可信插件，需要 OS 级沙箱、文件白名单、网络白名单；这不在当前方案范围内。

4. **端口/进程暴露**
   子进程如果绑定 `0.0.0.0`，局域网可直接访问插件页面和 DSH API。必须强制 loopback，并在启动参数里写死。

### 14.5 影响最大的五个点（按优先级）

1. **会话镜像保真**：决定 `dsh-context` 是真能用，还是只显示半截。
2. **插件页鉴权与端口隔离**：决定是“嵌进来”，还是“开了一个绕过 EAB 的后门”。
3. **模型/工具桥接回归**：决定现有聊天、渠道、定时任务是否稳。
4. **子进程生命周期**：决定会不会留下孤儿进程、占端口、删不掉目录。
5. **备份与更新**：决定升级/恢复后插件配置和会话镜像还在不在。

### 14.6 最小影响落地建议

如果目标是“先把插件真正跑起来”，建议按这个顺序，避免一次性改动所有链路：

1. **阶段 0** 先建兼容矩阵，不改产品行为。
2. **阶段 1** 只做 Supervisor + 每 scope profile + 插件页 iframe/代理，不碰 EAB 聊天。
3. **阶段 3A** 先让页面类插件（`dsh-cy-api`、`dsh-ding-card`）完整可用。
4. **阶段 2** 再把工具/模型/命令接进 EAB 聊天；先接工具，再接模型，最后接审批/附件。
5. **会话镜像**最后做，先只镜像消息和工具事件；`dsh-context` 先接受 `degraded`，再逐步补 token/审批/子 Agent。
6. **备份/更新**与阶段 1 同步做，不要等上线后补。

### 14.7 结论

- 这个方案**能解决“插件页面打不开、注册不进来、context 接不上”的主因**，因为它换掉了手写模拟层。
- 但它**不是零成本、不是零回归、也不是所有插件都能用**。代价是双运行时、双数据源、进程/端口运维和一次较大的桥接改造。
- 如果目标只是让当前 3 个插件能用，这个方案偏重；如果目标是把 DSH 插件生态接进 EAB，这个方案是必要的。
- 实施前必须接受三条硬约束：**EAB 主数据不交出去、插件代码不是安全沙箱、桌面专属插件不承诺兼容**。
