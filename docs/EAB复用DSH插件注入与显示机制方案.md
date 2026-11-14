# EAB 复用 DSH 插件注入与页面显示机制方案

> 状态：可行性结论已整理，等确认后实施。
> 结论口径：以本机 DSH NEXT `0.2.2-rc.1` 的实际包、EAB 当前 `plugin-host.ts` / `dsh-runtime.js` / `plugin-host.html` 为准，不以 README 的产品组合描述代替实际代码。

---

## 1. 直接回答

### 1.1 这条路线能不能做

可以。**EAB 保持主项目、单 Web 环境、不搞多 profile、不启动 DSH sidecar，只复用 DSH 的插件注入协议和页面显示机制**，这个方向是可行的，而且比“每个 scope 一个官方 DSH runtime sidecar”更符合你要的产品形态。

但必须先把边界说清楚：

- **能解决**：有操作页面的 DSH 插件，安装后页面能出现、页面里的配置/按钮/网关能工作，插件注册的 slot 能被 EAB 的页面壳接住。
- **不能单独解决**：只改页面显示不够。DSH 插件页面能不能出现，不只取决于前端 slot，还取决于 host 侧插件有没有被真正加载、`inject` 有没有等到服务、`apply` 有没有执行。`sessions / sessionQuery / sessionProjections / commands / credentials / webServer` 这些服务不补齐，页面即使显示，里面也可能没有数据、注册不进来、context 接不上会话。
- **不能保证**：所有 DSH 插件。桌面专属插件（原生目录选择、打开本地应用、Office 转 PDF、subprocess、workspace 等）、只做 host 不提供页面的插件、深度依赖 DSH 原生 Agent/会话写入的插件，这条路线做不到等价。

一句话：**“只复用 DSH 插件注入 + 页面显示”是正确的主线，但它的验收对象是“页面型插件”，不是“所有 DSH 插件全能力”。**

### 1.2 和“把 EAB 换成 DSH”不是一回事

不替换 EAB，不把聊天执行引擎切给 DSH，不把 DSH session log 当事实源。EAB 仍然是：

- 聊天：EAB 自己的执行链路，`chat_sessions / chat_messages` 是唯一主数据；
- 多 Agent、渠道、权限、计费：EAB 负责；
- 插件：DSH 插件协议作为兼容内核，插件页面作为 EAB 工作台里的一个面板；
- 数据：每个插件实例仍然独立 `DSH_HOME` / 数据根，按 `(pluginId, companyId, scope)` 隔离。

---

## 2. 为什么现在“装了插件但页面出不来、能力注册不进来”

不是两个项目“架构完全不一样”，而是 EAB 现在只复制了 Cordis 的外壳，没有复制 DSH 的**插件装配协议**。

### 2.1 相同的是骨架

EAB 和 DSH 都用了：

- Cordis 的 `Context / Fiber / inject / effect / provide`；
- `window.__ModuleLoader__.load({ id, factory })` 这种客户端模块加载入口；
- `package.json` 的 `dsh` 清单段；
- slot 注册组件的方式。

### 2.2 不同的是“装配链路”

DSH 的插件不是“`ctx.plugin()` 一下就会自己出现在页面上”。它要同时成立两条链路：

**Host 链路：**

1. 读 `package.json` 的 `dsh` 段（`dsh.client`、`dsh.bundle.patch` 等）；
2. 给插件建一个 Loader entry；
3. `ctx.plugin(entry)` 建 fiber；
4. 插件的 `inject` 列表里所有服务就绪；
5. `apply` 执行，`ctx.tools.register` / `ctx.slots.register` / `ctx.webServer.route` 才真正生效。

**Client 链路：**

1. host 侧 `dsh-client-modules` 扫描启用的 Loader entry，组合 `window.__DSH_BOOT__` 启动图；
2. 通过 `/plugins/<package>/client.js` 提供 bundle；
3. 浏览器侧 `__ModuleLoader__` 懒加载 bundle；
4. `dsh-cordis-client-runner` 在浏览器里建一棵 client Cordis 树；
5. 插件 `client.js` 的 `apply` 调 `ctx.slots.register(...)`；
6. 父级必须先声明同名 slot，`ctx.slots.inject('main')` 的回调才会执行；
7. `ctx.uiRenderer.mount(container)` 渲染 `root`，slot 里的组件才真正出现。

EAB 现在缺的正是第 1～4 步和第 6 步的完整契约：

- `plugin-host.ts` 用 `ctx.plugin()` 直接加载，没有 DSH 的 Loader entry / `dsh.bundle.patch` 处理；
- `dsh-runtime.js` 只声明了少量 slot，插件用到 `conversation.view`、`plugins.bundle.config`、`plugins.detail.actions` 时，`ctx.slots.inject` 等不到声明，回调永远不执行；
- host 的 `sessions` 只有元数据，`sessionQuery.observeSession` 永远 `events: []`，`sessionProjections.stateOf` 固定空时间线，`dsh-context` 这类插件即使页面挂上了，也拿不到会话数据。

所以这不是“某个插件的 Bug”，是**插件装配协议只覆盖了一个子集**。

---

## 3. DSH 实际是怎么注入、怎么显示的

### 3.1 安装与 host 注入

DSH 插件的 `package.json` 里通常有：

```json
{
  "dsh": {
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": ["@deepseek-ai/dsh-client-connection", "..."]
    },
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

host 侧要做的不是“读一个入口文件然后 `import()`”，而是：

1. 把插件包解析成一个 Loader entry；
2. 让 Cordis Loader 按 entry 加载，`dsh.bundle.patch` 里的 patch 也要应用；
3. Cordis fiber 解析插件的 `inject`；
4. 所有被 inject 的服务都 `provide` 之后，`apply` 才跑；
5. `apply` 里注册的工具、命令、模型、HTTP 路由、slot 才进入 EAB 的注册表。

EAB 当前 `plugin-host.ts` 的 `startOne()` 已经在做 `ctx.plugin()` 和 `ctx.inject` 的等待，但它没有 Loader entry、没有 patch 处理，很多服务是手写桩。插件能跑，是因为它只碰到已经覆盖的服务；换一个插件就断。

### 3.2 页面显示

DSH 页面不是“插件自己画一个完整页面”，而是：

- 父级插件先声明 slot 树（`root`、`main`、`sidebar.panellist`、`settings.section`、`conversation.view` 等）；
- 子插件 `ctx.slots.inject('main', () => ctx.slots.register(...))`；
- `dsh-client-ui-renderer` 在启动时 `ctx.uiRenderer.mount(container)`，渲染 `root`；
- `root` 的 owner（DSH 里是 layout，EAB 里可以是 EAB 自己的页面壳）负责把 `main`、`sidebar` 等 outlet 画出来。

关键点：**slot 的声明是父级的责任，不是插件的责任。** 插件只负责“往已声明的 slot 里注册”；没有声明，`inject` 就一直等，页面自然空白。`dsh-client-ui-slots` 的 README 也明确：注册到未声明 slot、重复声明、单槽冲突，会在加载期抛错；`inject` 则是等待声明。

---

## 4. 目标架构：EAB 单 Web 环境 + DSH 插件内核

### 4.1 总体结构

```text
EAB 8787 员工端 / 8788 控制台（同一个 EAB 进程）
├─ chat / admin / 原有业务页面
├─ /plugin-runtime?instance=<instanceKey>   插件页（EAB 壳）
│   ├─ EAB 生成的 boot html
│   │   ├─ window.__DSH_BOOT__ 启动图（只含当前 scope 的插件）
│   │   └─ /plugins/<package>/client.js 路由
│   ├─ 官方 client kernel
│   │   ├─ dsh-client-modules（浏览器半边）
│   │   ├─ dsh-cordis-client-runner
│   │   ├─ dsh-client-ui-slots
│   │   └─ dsh-client-ui-renderer
│   ├─ EAB root shell（声明 root / main / sidebar / settings / conversation...）
│   └─ 插件 client bundle（dsh-cy-api、dsh-ding-card、dsh-context...）
│
└─ 服务端
    ├─ PluginInstanceRegistry：(pluginId, companyId, scope) -> host
    ├─ 每个 host：Cordis Context + DSH 清单/Loader + EAB 服务适配
    ├─ EAB SQLite：chat_sessions / chat_messages 唯一主数据
    └─ 可选：DSH session 兼容镜像 -> sessions / sessionQuery / sessionProjections
```

### 4.2 关键决定

- **不引入 profile**：一个 EAB 进程，一个 Web 环境。实例隔离靠 `(pluginId, companyId, scope)` 和每实例数据根，不靠 `DSH_PROFILE`。
- **不引入 sidecar**：不额外起 DSH 进程、不额外开端口。
- **不整包引入 `dsh-web-app`**：它带 DSH 自己的聊天、终端、原生目录选择、Office 转 PDF、subprocess、workspace 等桌面/产品能力，不适合放进 EAB。
- **按需取包**：只取“插件注入 + 页面显示 + 必要服务契约”的包。
- **EAB 页面壳自己声明 slot**：不直接用 DSH 三列 layout，但 slot 名称对齐 DSH，这样插件不用改代码。

---

## 5. 复用清单

### 5.1 必须复用（客户端内核）

| 包 | 作用 | 是否可独立于 `dsh-web-app` |
|---|---|---|
| `@deepseek-ai/dsh-client-modules` | host 半边扫描 Loader entry、组合 `__DSH_BOOT__`、提供 `/plugins` bundle；浏览器半边 lazy-CJS 模块表 | 可以，但需要 Loader entry 和 `/plugins` 路由 |
| `@deepseek-ai/dsh-cordis-client-runner` | 浏览器里跑 Cordis 树 | 可以 |
| `@deepseek-ai/dsh-client-ui-slots` | SlotCore：声明、注册、keyed/list/single/chain、加载期校验 | 可以，纯核心 |
| `@deepseek-ai/dsh-client-ui-renderer` | `ctx.slots` Service、`ctx.uiRenderer.mount(container)`、React 渲染 | 可以。实际构建里 `inject = []`，不强制依赖 sessions/layout；README 的“在 slots/sessions/layout 之后”是官方产品组合顺序，不是硬依赖 |

> 实测证据：`dsh-client-ui-renderer/lib/client.js` 末尾 `const inject = [];`，`apply(ctx)` 里 `new SlotRegistry(ctx).install(createSlotRenderer())`，然后 `ctx.reflect.provide("uiRenderer", { mount })`。这说明 EAB 只要提供 `slots` 和 React 环境，就能独立 mount，不需要先把 DSH 的 layout/session 全部搬进来。

### 5.2 建议复用（页面插件常 inject 的模块）

| 包 | 作用 | 典型插件 |
|---|---|---|
| `@deepseek-ai/dsh-client-locale` | 字典、`ctx.locale.bind` | dsh-cy-api、dsh-ding-card、dsh-context |
| `@deepseek-ai/dsh-client-connection` | 客户端连接/准入 | dsh-ding-card |
| `@deepseek-ai/dsh-client-ui-primitives` | 插件常用 UI 原语 | 多数页面插件 |
| `@deepseek-ai/dsh-client-store` | 客户端状态 | 部分插件 |
| `@deepseek-ai/dsh-client-runtime` | 运行时别名/兼容 | dsh-ding-card 的 inject 列表 |
| `@deepseek-ai/dsh-client-ui-settings` | 设置页 slot/组件 | dsh-ding-card |
| `@deepseek-ai/dsh-client-shortcuts` | 快捷键 | 可选 |
| `@deepseek-ai/dsh-client-ui-theme` | 主题变量 | 可选 |

### 5.3 先不引入（按需再加）

| 包 | 为什么不先引入 |
|---|---|
| `@deepseek-ai/dsh-client-ui-layout` | EAB 用自己的页面壳；只有插件直接 `inject('@deepseek-ai/dsh-client-ui-layout')` 时才需要补 |
| `@deepseek-ai/dsh-client-ui-session` | 只有插件直接用 Session hooks 时才需要；`dsh-context` 只注册 `conversation.*` slot，EAB 自己声明即可 |
| `@deepseek-ai/dsh-api-remotes` / `dsh-api-session-controller` | 这是 DSH 的 BFF/会话控制器；EAB 用自己的 RPC 网关，不先搬 |
| `@deepseek-ai/dsh-client-ui-conversation` | 它会把 Lexical、workspace、file-upload、context-menu 等一大串带进来；先不整包搬 |
| `@deepseek-ai/dsh-web-app` / `dsh-web-frontend` | 完整 DSH Web 产品，含桌面/终端/Office 等，不适合 EAB |
| `@deepseek-ai/dsh-agent` / `dsh-web-app` | EAB 聊天引擎不变，不把 Agent 执行切给 DSH |

### 5.4 Host 侧

必须做：

- 以 DSH 清单/Loader 语义加载插件，处理 `dsh.client`、`dsh.bundle.patch`；
- 每个实例一个 Loader entry / Cordis Context；
- 提供 EAB 已有的 `tools`、`systemPrompt`、`llm`、`settings`、`credentials`、`connection`、`webServer`、`commands` 适配；
- 为 `sessions` / `sessionQuery` / `sessionProjections` 提供 EAB 会话的兼容视图。

可选：

- `@deepseek-ai/dsh-session`、`dsh-session-query`、`dsh-session-projection`：如果 EAB 自建镜像事件成本太高，可以先用官方契约包，把 EAB 消息投影成 DSH 事件；
- `dsh-plugin-manager`：如果要做插件清单/启停管理；
- `dsh-host-webserver`：如果 EAB 的 Fastify 适配 `upgrade/fallback/tapIndex` 成本高，可以借用它的路由注册语义，但不要整包替换 EAB 的 8787/8788。

---

## 6. Slot 兼容表（按实际插件代码核对）

| Slot | 类型 | 谁在用 | EAB 必须做什么 |
|---|---|---|---|
| `root` | single | `dsh-client-ui-renderer` 的 mount | EAB 声明 root，owner 是 EAB 页面壳 |
| `main` | keyed | `dsh-cy-api` 的 `PANEL_ID`、`dsh-ding-card` 的 `PANEL_ID` | EAB 声明 keyed `main`；EAB 用 key 切换面板 |
| `sidebar.panellist` | list | `dsh-cy-api` | EAB 声明；渲染为 EAB 插件列表项 |
| `settings.section` | list | `dsh-ding-card` | EAB 声明；渲染到 EAB 插件设置页 |
| `plugins.detail.actions` | list | `dsh-ding-card` | EAB 声明；渲染到插件详情操作区 |
| `conversation.view` | list/chain | `dsh-context` | EAB 声明；渲染为 EAB 对话页签 |
| `conversation.chat.assistant-actions` | list | `dsh-context` | EAB 声明；渲染为消息操作项 |
| `conversation.input.overlay` | single/list | `dsh-context` | EAB 声明；渲染为输入区浮层 |
| `plugins.bundle.config` | keyed | `dsh-context` | EAB 声明；渲染为插件配置卡片 |
| `shell.bottom` / `shell.overlay` / `rightbar` | 多种 | 少数 layout 类插件 | 先声明空 outlet，按需渲染 |

实测证据：

- `dsh-cy-api/lib/client.js`：`var inject = ['slots', 'locale']`，`ctx.slots.inject('main', ...)` 注册 keyed 面板，`ctx.slots.inject('sidebar.panellist', ...)` 注册侧栏项。
- `dsh-ding-card/lib/client.js`：注册 `main` keyed 面板、`settings.section`、`plugins.detail.actions`，并使用 `ctx.layout.selectPanel(PANEL_ID)`。
- `dsh-context` 客户端：`inject: ['slots', 'locale']`，注册 `conversation.view`、`conversation.chat.assistant-actions`、`conversation.input.overlay`、`plugins.bundle.config`；可选读 `ctx.get('sessions')` 并 `refreshProjections`。

这说明：**页面型插件能不能显示，主要卡在“slot 有没有声明”；页面里的数据能不能用，卡在“host 服务有没有实现”。**

未知 slot 的处理原则：

- 不要静默丢；
- 在插件页给出 `slot_not_declared` 诊断，写明插件 id、slot 名、注册回调未执行；
- 记录到 EAB 插件日志，便于后续补声明。

---

## 7. Host 服务矩阵

| 服务 | EAB 现状 | 谁需要 | 要补到什么程度 |
|---|---|---|---|
| `tools` | 已有，按实例注册 | dsh-cy-api | 保持，确保 `ctx.tools.register` 生效并进 EAB 工具目录 |
| `systemPrompt` | 已有，按实例 | dsh-cy-api | 保持，确保提示片段按实例生效 |
| `webServer` | 只有基础路由，缺 upgrade/fallback/tapIndex | dsh-cy-api | 补齐 DSH 路由语义；按实例加前缀/令牌，避免跨实例串路由 |
| `connection` | `admit` 空放行 | dsh-ding-card | 实现准入、实例作用域、RPC 通道；拒绝时给插件可读错误 |
| `credentials` | 部分 | dsh-ding-card、dsh-our-free-model | 按实例设置命名空间存取，不全局共享 |
| `settings` | 已有 | dsh-ding-card | 按实例隔离，防串号 |
| `llm` | 已有 adapter 桥 | dsh-our-free-model | 保持；模型目录按实例过滤 |
| `commands` | 未接 execute | 部分插件 | 实现 `commands.execute` 并接 EAB 命令链路 |
| `sessions` | 只有元数据 | dsh-context | 提供 `getSnapshot` / `refresh` / `refreshProjections`，至少能读到当前会话 |
| `sessionQuery` | `observeSession` 固定 `events: []` | dsh-context | 把 EAB 消息镜像成 DSH 事件形状，或提供只读事件流 |
| `sessionProjections` | `stateOf` 固定空时间线 | dsh-context | 计算 context 用量/步骤等投影，至少不返回空 |
| `agents` / `attachments` / `approval` / `userQuestions` | 标记 `available:false` | 少数插件 | 不要求全实现；但插件 `inject` 时不能无限等，应该 fail fast 或明确 unavailable |
| `pluginManager` | 无实际管理 | 插件页/管理类插件 | 提供 inventory、启停、状态查询 |

一个必须注意的坑：**`available:false` 不等于插件会自己跳过。** 如果插件 `inject` 了这个服务，Cordis 会一直等。现在 `plugin-host.ts` 用 1.2 秒 race 判断 pending，这只是 EAB 自己的观察，不是插件的超时。正确做法是：要么不把该服务放进 inject 表，要么提供一个“调用即报错”的 facade，并在插件页显示“缺少服务 X”。

---

## 8. 单 Web 环境与多实例

### 8.1 实例键

继续用现有 `plugin-scope.ts` 的模型：

- 实例键：`(pluginId, companyId, scope)`；
- 公司实例：`scope=company`；
- 个人实例：`scope=user`，带 `userId`；
- 数据根：公司 `...\.eab-dev\dsh-home\<pluginId>`，个人 `...\.eab-dev\dsh-home\scopes\users\c1\<userId>\<pluginId>`；
- 设置命名空间：按实例键隔离。

### 8.2 页面作用域

一个插件页只对应一个实例：

- 公司插件页：`/plugin-runtime?instance=company:<pluginId>`
- 个人插件页：`/plugin-runtime?instance=user:<userId>:<pluginId>`

不要把公司实例和个人实例放在同一张页面里。原因：DSH 的 client module graph 以 package 名为 key，同一张图里出现两个同名 package row 会被拒绝；不同页面各自 boot 一张图，就不会冲突。

### 8.3 `DSH_HOME` 并发缺陷

当前 `plugin-host.ts` 的 `startOne()` 在 1538-1543 行临时改 `process.env.DSH_HOME` / `DSH_PROFILE`，1561 行 `ctx.plugin()`，1586-1590 行恢复。这个做法在单实例启动时能工作，但：

- `process.env` 是进程全局，不能 async-local；
- 两个实例并发启动时，A 的 import/apply 可能读到 B 的 `DSH_HOME`；
- 插件如果在 `apply` 之后异步读 env，恢复后还会读错。

修复方向：

1. 所有实例启动串行化，`startOne()` 的 env 窗口加全局队列；
2. 新插件优先通过显式配置/参数拿数据根，不依赖 `DSH_HOME`；
3. 旧插件必须依赖 env 时，启动期间禁止并发；
4. 不再设置 `DSH_PROFILE`。

这是“单 Web 环境、无 profile”路线必须接受的代价：**没有进程隔离，就要用串行化和显式作用域换隔离。**

---

## 9. 实施步骤

### Phase 0：最小原型（1～2 天）

目标：证明官方 client kernel 能在 EAB 页面里独立跑，不接 host。

- vendor 4 个核心包：`dsh-client-modules`、`dsh-cordis-client-runner`、`dsh-client-ui-slots`、`dsh-client-ui-renderer`；
- 新建 `/plugin-runtime` 原型页；
- EAB 声明 `root`、`main`（keyed）、`sidebar.panellist`；
- 手工加载 `dsh-cy-api/lib/client.js`；
- 验证：页面出现、面板能打开、slot 注册成功、无 `slot_not_declared`；
- 暂不接 host 真实网关，先用 mock 响应验证渲染。

### Phase 1：客户端内核替换（3～5 天）

- 用官方 kernel 替换 `packages/server/public/dsh-runtime.js`；
- EAB 页面壳声明第 6 节 slot 表；
- 接 `dsh-client-modules` 的 host 半边，生成 `__DSH_BOOT__` 和 `/plugins` 路由；
- 支持 `dsh-cy-api`、`dsh-ding-card` 页面；
- 增加 unknown slot 诊断；
- 退役 `plugin-host.html` 里的手写模块表。

### Phase 2：Host 服务适配（3～5 天）

- 每个实例一个 Loader entry；
- `webServer` 补 `route/upgrade/fallback/tapIndex`；
- `connection.admit` 按实例实现；
- `credentials/settings` 按实例命名空间；
- `commands.execute` 接入；
- RPC/gateway 路由带实例键，服务端按员工会话鉴权。

### Phase 3：会话镜像与投影（3～5 天）

- EAB `chat_messages` -> DSH 事件形状的只读镜像；
- `sessions` / `sessionQuery` / `sessionProjections` 适配；
- `dsh-context` 的 `conversation.view`、assistant actions、input overlay、plugin config card 有数据；
- 明确 EAB 是唯一事实源，镜像只读、可重建、不作为写回源。

### Phase 4：硬化（2～3 天）

- 并发启动串行化、`DSH_HOME` 窗口保护；
- 卸载只删本人实例；
- 共享包缓存与最后归属清理；
- 备份覆盖插件数据根（或明确文档说明只备份 SQLite）；
- `scripts/eab-update.mjs` 的 `CODE_PATHS` 补 `packages/dsh-bridge`（如果新增该包）；
- 类型检查、测试、真实服务 8787/8788、插件页截图。

---

## 10. 验收标准

### 10.1 页面型插件

- `dsh-cy-api`：
  - 个人插件页可见；
  - `main` 面板能打开；
  - `sidebar.panellist` 有入口；
  - 配置保存后重开仍在；
  - 页面内网关请求成功；
  - 个人卸载后页面和数据都消失，公司/其他成员不受影响。
- `dsh-ding-card`：
  - `main` 面板可见；
  - `settings.section` 出现；
  - `plugins.detail.actions` 出现；
  - `ctx.layout.selectPanel` 能切到面板。
- `dsh-context`：
  - `conversation.view` 页签出现，并渲染当前会话投影（2026-11-13 已通过：57 条用户消息、47 步、29 次工具调用；页面无异常）；
  - `conversation.chat.assistant-actions` 出现；
  - `conversation.input.overlay` 出现；
  - `plugins.bundle.config` 卡片出现；
  - `sessions` 投影不是空，至少能读到当前会话。

### 10.2 隔离

- 公司 + 员工 A + 员工 B 三实例同时安装同一插件；
- A 改配置不影响 B；
- 个人页只显示本人安装的插件；
- 个人卸载只删本人实例和数据；
- 服务重启后实例仍能加载。

### 10.3 回归

- `pnpm typecheck` 通过；
- 现有测试通过；
- 8787/8788 正常；
- 插件宿主失败不阻塞主服务（保持现有行为）。

### 10.4 插件页首屏与内核预热

- `plugin-kernel.html` 的共享内核资源（`primitives.js` / `primitives.css` / `cordis` / `slots` / `renderer` / React UMD）在 head 中用 `modulepreload` / `preload` 并发拉起，boot 内的三个模块 `Promise.all` 并行 import，不再串行等待。
- 去掉固定 500ms 等待，改为轮询插件注册的 slot（`main` / `settings.section` / `conversation.view` 等），首个 slot 出现即挂载，最多兜底 500ms。
- 控制台插件工作台加载成功后，用隐藏的 `plugin-kernel.html?warm=1` 预热共享内核；预热页只执行 Cordis / slots / primitives / renderer，不执行任何插件 client bundle，避免一次性启动所有插件。`warm=1` 完成后通过 `parent.postMessage({ type: 'eab-plugin-kernel-warm', ready: true })` 让父页清理隐藏 iframe。
- 同时按插件版本 + 校验和预取已启用 DSH 插件的 `lib/client.js`；插件代码仍在用户点击时按 iframe 隔离启动。预热 iframe 每次页面会话只创建一次，插件列表后续刷新时只补拉新增或升级过的 bundle，不重复请求同一 URL。
- 内核 vendor 与插件静态代码资源使用 `private, max-age=3600, must-revalidate`；插件代码 URL 带 `v=<version>&h=<checksum>` 作为失效键，同版本覆盖重装也能失效；插件入口 HTML 仍为 `no-store`。
- 插件页首屏状态现在按阶段显示“正在加载共享内核 → 正在加载插件代码 → 正在渲染页面 → 内核已就绪”，启动失败时错误区带插件 id 和入口路径，并提示可点“重新加载”重试。
- 2026-11-13 加入校验和缓存键后实测：控制台 `dsh-context` 首次页面耗时约 157ms，`dsh-cy-api` 约 93ms，`dsh-ding-card` 约 199ms；三页均 `内核已就绪`、无 `#pk-error`。`dsh-context` 仍读到 9 个会话、926.3k Token、133 轮次。四个插件 bundle 的预取资源 `transferSize` 均为 0，命中 HTTP 缓存。

---

## 11. 缺陷与影响

### 11.1 兼容边界

- 不是“所有 DSH 插件”。桌面专属插件无法等价：原生目录选择、打开本地应用、Office 转 PDF、subprocess、workspace、终端等。
- host-only 插件只能做到“能力注册”，不一定有页面。
- 深度依赖 DSH Agent/DSH session 写入的插件，只能只读兼容，不能把 EAB 聊天切过去。

### 11.2 客户端包体与构建

- 不是 340 个包全搬，但也不是 2～3 个包。按第 5 节，初始大约 10～20 个 MIT 包；如果插件直接 inject `ui-layout`/`ui-conversation`/`api-remotes`，还会继续增加。
- 需要把 DSH client bundle 纳入 EAB 的构建/发布流程；`lib/client.js` 必须预构建，不能运行时临时编译。
- 需要保留 MIT 许可声明和版本锁定；DSH `0.2.2-rc.1` 是 pre-release，不能自动跟随升级。

### 11.3 Slot 契约债

- EAB 必须持续维护 slot 声明表；每接一个新插件，可能要多声明一个 slot。
- 未声明 slot 现在是静默等待，必须加诊断，否则又会回到“页面空白但没人知道为什么”。`plugin-kernel.html` 已包住插件自己的 `ctx.slots.register`：缺声明、重复声明、缺 `select` 的抛错会在页面顶部显示“插件使用了 EAB 尚未声明的 slot”，状态改为“内核已就绪 · N 个 slot 未声明”，并保留官方 SlotCore 的抛错，不把契约错误吞掉。
- EAB 页面壳可以不是 DSH 三列布局，但 slot 名要对齐；视觉可以 EAB 化，注册契约不能改。

### 11.4 Host 服务债

- 每接一个新插件，可能要多补一个服务或一个方法。
- `available:false` 的服务不能无限等；要有 fail-fast 和插件页提示。
- `webServer` 的 `upgrade/fallback/tapIndex` 仍未真正实现，但不再静默：`supportsUpgrade/supportsFallback/supportsTapIndex=false`，插件注册时写入实例 `hostGaps`，控制台插件状态显示“启用 · 能力缺口”，`/api/console/plugins` 的 `hosts[].hostGaps` 可读到具体路径。`available:false` 的 `speechToText / agents / pluginManager / attachments` 读方法会登记缺口，创建/写入类方法直接抛出带 `code` 的错误；`approval / userQuestions` 返回明确 failure。新增 `plugin-host-inject.test.ts` 覆盖 upgrade/fallback/tapIndex 与 `available:false` 写入失败。

### 11.5 安全

- 插件 client bundle 在 EAB 页面同源执行，能访问 EAB 的 cookie/API。DSH 插件生态默认是可信代码，但公司安装的第三方插件不能等同于可信。
- 必须做：
  - 服务端按员工会话鉴权，不能只信前端 `scope`；
  - 每个实例一个短期 token/网关前缀；
  - CSP、路由白名单、审计日志；
  - 插件页与主工作台之间的权限边界。
- 这不是完整沙箱；只是把“同源全权限”收窄到“按实例、按路由、按用户”。

### 11.6 性能

- 每个插件页启动时加载当前 scope 的 client roster；插件多时首屏会变慢。
- 官方模块系统是懒加载，bundle 只在首次使用时 materialize；可以接受。
- 需要缓存 `/plugins` bundle 和 boot 图，版本/实例变化要失效；当前插件代码缓存键已带 `v=<version>&h=<checksum>`，同版本覆盖重装也会重新取。

### 11.7 备份/更新

- SQLite 备份只覆盖 EAB 主库；已新增「运行数据备份」：`eab backup --full` 或 `POST /api/console/backups/runtime` 生成 `eab-runtime-*` 目录，包含 `eab.db`、`plugins/`、`dsh-home/`、`dsh/`、`workspaces/`、`company-assets/`、`console-settings.json`，并写 `manifest.json`。备份在后台异步生成，页面轮询 `/api/console/backup-jobs/:id`；列表只展示带 manifest 的完整快照。`secrets.json` / `admin-credentials.txt` 明确排除，恢复后需重新确认密钥。`eab restore <目录> --yes` 会先停服务、把当前运行目录改名到 `restore-safety-*`，再按 manifest 回填；已在独立 `EAB_HOME` 沙箱验证运行数据恢复和数据库恢复，真实运行目录尚未执行恢复。
- `scripts/eab-update.mjs` 的 `CODE_PATHS` 已从逐个子包改为整个 `packages/`，新增包不会再漏拷；`scripts/`、锁文件和 tsconfig 仍在更新范围。
- Node 版本：EAB `>=22.5.0`，部分 DSH 插件要求 `^22.19.0`；当前 `v22.23.2` 满足，但要在文档里写清楚。

### 11.8 多实例与 env

- 单进程无 profile，`DSH_HOME` 只能串行窗口；并发安装/启动必须排队。
- 如果未来要真正并行，还是得回到“每实例独立进程/worker”，那就接近 sidecar 了；这是这条路线固有的取舍。

---

## 12. 结论

**建议按这条路线改造**，但把验收目标写成：

> 有操作页面的 DSH 插件，安装后能在 EAB 单 Web 环境里显示页面、注册 slot、使用 EAB 提供的 host 服务；不保证桌面专属、host-only、DSH 原生 Agent/会话写入类插件完全等价。

具体做法：

1. 不替换 EAB，不引入 DSH 产品壳；
2. 用官方 `dsh-client-modules` + `dsh-cordis-client-runner` + `dsh-client-ui-slots` + `dsh-client-ui-renderer` 做客户端内核；
3. EAB 自己声明 DSH 兼容 slot 树，页面壳 EAB 化；
4. Host 侧补 Loader entry、`webServer`、`connection`、`credentials/settings`、`commands`、`sessions/sessionQuery/sessionProjections`；
5. 单 Web 环境、每实例数据根、启动串行化；
6. 先做 Phase 0 原型，用 `dsh-cy-api` 验证；再扩 `dsh-ding-card` / `dsh-context`。

如果要求“所有 DSH 插件装进来全部能力可用”，那这条路线不够，必须回到完整 DSH runtime/sidecar；但那会违背“EAB 主项目、单 Web 环境、无多 profile”的前提，不建议。

---

## 13. 引入官方包和手写 `dsh-runtime.js` 的区别

这不是“包大一点、手写小一点”的区别，而是**契约保真度**的区别。

| 维度 | 手写 `dsh-runtime.js`（现状） | 引入 DSH 官方 client 包 |
|---|---|---|
| 模块来源 | 自己维护 `moduleProviders`，缺的包用 `makeModuleShim()` 返回一个 Proxy 占位 | 官方 `dsh-client-modules` 扫描 `dsh.client`，按 `__DSH_BOOT__` 和 `/plugins` 加载真实 bundle |
| 加载方式 | 页面自己拼插件 bundle，缺模块就给空壳 | lazy-CJS：执行 bundle 只注册 factory，模块体在 materialize 时才跑；支持 `require.async` chunk |
| 客户端 Cordis | 近似模拟 `ctx.effect / provide / inject / get` | 官方 `dsh-cordis-client-runner` 在浏览器里跑真实 Cordis 树，生命周期和 host 侧一致 |
| slot 语义 | 自己实现的简化 registry，主要覆盖 `main / sidebar.panellist / settings.section` | 官方 `dsh-client-ui-slots` 的 SlotCore：single/list/keyed/chain、声明校验、Component Factory、store seat |
| 未声明 slot | 可能静默不注册，页面空白但不知道为什么 | 加载期抛错/诊断明确；`inject` 等待声明，能定位到具体 slot |
| 重复/冲突 | 自己判断，覆盖不全 | 重复声明、单槽冲突、跨 scope store 冲突会在加载期报错 |
| 插件 UI 原语 | 大量通用占位组件，视觉和真实 DSH 有差异 | 官方 `dsh-client-ui-primitives`，组件行为和 DSH 一致 |
| 资源文件 | 基本没有 `/plugins/<pkg>/assets` 的 revision/媒体类型处理 | 官方 asset route，带内容 revision、媒体类型、304、SVG CSP |
| 热更新/启停 | 多数情况要刷新页面 | 官方 graph 更新、HMR、启停同步 |
| 失败行为 | `makeModuleShim` 让插件“能 apply”，但能力可能是假的，问题被掩盖 | 缺模块/缺服务会明确失败，便于修契约，而不是假成功 |
| 体积/构建 | 约 40KB，无构建 | 初始约 10～20 个包，需要预构建 `lib/client.js`，版本要锁定 |
| 维护成本 | 每接一个新插件就可能要补一个 shim，债越滚越大 | 由 DSH 官方语义兜底，但受 `0.2.2-rc.1` 预发布版本影响 |

最关键的区别是**失败方式**：

- 手写 runtime 的思路是“缺什么就给个空壳，让插件先跑起来”。这能避免白屏，但会把“契约没实现”伪装成“插件已经加载”。`dsh-context` 页面能开、设置页能开，但会话投影是空的，就是这个结果。
- 官方包会把“slot 没声明、模块缺依赖、store 冲突”明确暴露出来。短期看更容易报错，长期看才可能做到“装一个插件就知道缺什么”，而不是每个插件都靠猜。

所以结论不是“官方包一定更好”，而是：

- 如果目标只是让两三个已知插件跑起来，手写 runtime 更轻；
- 如果目标是“装 DSH 插件就能用”，必须用官方注入/显示内核，手写 runtime 只能作为过渡，不能作为最终方案；
- 两者不要混用。混用会出现“官方 slot 注册了、手写 ctx 没接住”的双重语义，问题更难查。

---

## 14. DSH session 和 EAB 网页对话怎么融合

### 14.1 唯一事实源不变

- EAB `chat_sessions / chat_messages` 是唯一主数据；
- DSH session 是**兼容镜像 + 只读投影**，不是第二事实源；
- 插件读 session 时读镜像；插件写 session 时，不允许直接写 EAB 主库，只能走 EAB 的受控接口；
- 镜像可以随时从 `chat_messages` 重建，重建不影响聊天。

### 14.2 数据映射

| EAB 数据 | DSH session 形状 | 说明 |
|---|---|---|
| `chat_sessions.id` | `session.id` | 稳定复用，不另生成 ID |
| `chat_sessions.title` | `session.title` | 标题变更发 `session.title_changed` |
| `chat_sessions.created_at / updated_at` | `session.createdAt / updatedAt` | 只读 |
| `chat_sessions.model / agent` | `session.model / agent` | 模型切换发 `session.model_changed` |
| 用户消息 | `message.user` | 内容、附件、引用一起映射 |
| 助手消息 | `message.assistant` | 最终消息一条；流式增量可选 |
| 思考/推理 | `message.reasoning` | 有 `reasoning_effort` 时映射 |
| 工具调用 | `tool.call` + `tool.result` | 参数、结果、错误分开 |
| 审批 | `approval.requested` + `approval.resolved` | 只读镜像 |
| 错误 | `session.error` | 聊天失败也镜像，便于插件诊断 |
| 上下文用量 | `sessionProjections.context` | 从消息/token usage 计算 |

### 14.3 写入时序

推荐“先主库、后镜像”：

```text
EAB chat 写入 chat_messages（事务提交）
  -> EAB SSE / 对话链路继续
  -> mirror writer 异步追加 DSH 事件
  -> plugin_session_mirror 记录 cursor
```

规则：

- 镜像失败不回滚聊天；
- 镜像写入幂等，按 `(session_id, message_id, event_type)` 去重；
- 镜像落后时，插件读到的是“稍旧的会话”，不是错误；
- 提供 `rebuild` 命令，从 `chat_messages` 全量重建；
- 不在聊天请求里同步写 DSH session，避免把聊天延迟和兼容层耦合。

### 14.4 读取时序

```text
插件 ctx.get('sessions').getSnapshot()
  -> EAB sessions adapter
  -> 读 mirror + 当前会话元数据
  -> 返回 DSH 形状的 snapshot

插件 ctx.get('sessionQuery').observeSession(id)
  -> 读 mirror 事件流
  -> 只读，不反写 EAB
```

`sessionProjections.stateOf(sessionId)` 至少返回：

- 消息列表/时间线；
- 当前模型、Agent、状态；
- token/context 用量；
- 工具调用和错误摘要；
- 没有数据时返回空结构，不抛错。

### 14.5 实时更新

两种方式二选一，先做简单的：

1. **轮询/刷新**：插件页打开时拉一次，`sessions.refresh()` 重新拉；`dsh-context` 已经会调 `refreshProjections`。
2. **SSE 桥**：EAB 已有聊天 SSE，插件页通过实例网关订阅；mirror writer 落库后发 `session.changed`，插件 client 收到后 `refresh`。

先做 1，稳定后再做 2。不要一开始就做双向实时同步。

### 14.6 插件自己创建的 DSH session

要分开：

- `origin=eab-chat`：EAB 网页对话镜像，出现在 EAB 聊天列表；
- `origin=plugin`：插件内部 Agent/任务创建的 DSH session，只在插件里可见，不混入 EAB 聊天；
- 如果插件要把自己的 session 展示到 EAB 聊天，必须显式调用 EAB 的“导入会话”接口，不能靠同名 ID 猜。

### 14.7 双环境（公司/个人）的会话可见性

- `scope=company` 插件：按公司策略读公司会话；默认只读，写入必须走 EAB 授权接口；
- `scope=user` 插件：只读该员工自己的会话；
- 所有过滤在服务端做，不能只靠前端传 `scope`；
- `sessions.list` / `sessionQuery` / `sessionProjections` 都带实例键，避免公司插件读到个人会话。

### 14.8 当前落地状态（2026-11-12 续）

本轮已经落地的是**host 侧只读会话投影**，页面内核补了 `sessions` 入口：

- `plugin-kernel.html` 已经提供 `slots / layout / connection / locale / sessions` 五个页面级服务；`sessions` 先提供当前会话 ID 和刷新入口，真实会话内容仍由 host 路由读取；
- `packages/server/src/plugin-host.ts` 已把 `chat_messages` 映射成 DSH 事件：
  - `user/message`：用户文本；
  - `assistant/message`：文本、reasoning、`usage.inputTokens/outputTokens/reasoningTokens`；
  - `tool/call`：`meta_json.toolCalls` 的 `callId/name/arguments`；
  - `tool/result`：`content/isError/source.callId`；
- `sessionQuery.observeSession` 返回真实事件数组，不再固定 `events: []`；
- `sessionProjections.stateOf(session, 'contextTimeline')` 从同一批事件折叠出 `surface / sums / assistantReasoning / assistantAnswerTokens / requests / turnRuns / totals / callNames / toolTally`，空会话仍返回官方 init 形状；
- 所有查询都按实例 scope 过滤：公司实例按 `company_id`，个人实例再按 `user_id`，页面不直接读 `chat_messages`；
- 新增 `packages/server/test/plugin-session-projection.test.ts`，覆盖事件类型、seq、token 汇总、requests、surface 和空态形状；
- 用真实库会话 `chat_f2957cfe-a547-4acc-8e87-2c17a8db7f1e` 验证：137 个事件、106 个 surface、37 个 requests，`sums={user:318,assistant:28640,tool:6731}`；再通过 `dsh-context` 的 `/api/dsh-context/detail` 返回 37 个 requests、106 个 nodes，`head.toolCalls=23`、`humanInputs=50`、`answers=41`；
- `@deepseek-ai/dsh-client-ui-primitives` 已通过临时 esbuild 工程打成浏览器 ESM + CSS，落到 `packages/server/public/vendor/dsh-kernel/primitives.js`（约 4.28 MB）和 `primitives.css`（约 1.52 MB）；同时补了 `react-esm.js`、`react-dom-esm.js`、`react-jsx-runtime.js`，`plugin-kernel.html` 的 importmap 已映射 `react`、`react-dom`、`react/jsx-runtime`、primitives；
- `plugin-kernel.html` 的 locale facade 已兼容官方多语言字典 `{ de, en, ja, zh }`，`register(ns, { zh, en, ... })` 会按当前语言取词条，仍支持 `{name}` 插值；
- `dsh-context` 的 `main` / `sidebar.panellist` 已能在正式插件页完整渲染中文“上下文洞察”页；`overview` 从 404 变为 200，页面读到 9 个会话、Token 812.3k、轮次 112、近 7 天用量图表、Token 统计和耗时统计；
- 概览的“工具调用 / 工具执行 / 活跃时长 / 模型调用”已从 0 补齐为真实值：`summary.timing.toolCalls=61`、`toolsMs≈5274`（约 5.3s）、`wallMs≈1173000`（约 19m33s）、`calls=89`；`toolsMs` 使用 `meta_json.toolCalls[].durationMs`，`foldContextTiming` 还把 `tool/call`/`tool/result` 按 `callId` 聚合成每个工具名的 `calls/ms`；
- 助手消息的 `meta_json.timing` 已开始记录 `ttftMs / genMs / wallMs`：`routes/chat.ts` 用可注入时钟的 `createTurnTimingTracker`，在流式 `reasoning/content` 首次到达时记首字，按 `tool`/`tool_result`/`clarify` 切分生成窗口，累加模型生成时间；`messageEvents` 把这份 timing 带入 `assistant/message`，`foldContextTiming` 汇总到 timeline。旧消息没有这份字段，仍按 0 处理；
- `contextTimeline` 新增 `counts.turns`（`Ko` 读的是 `counts.turns`，不是 `turns`）和 `timing` 形状；空 timeline 也返回零值 `timing`；`sessionProjectionCache.cachedSnapshot/coldSnapshot` 与 `sessionProjections.snapshot` 同时返回 `contextTimeline + contextActivity`；
- `sessionQuery.listSessions`、`sessionProjectionCache.cachedSnapshot/coldSnapshot` 已补齐；`cachedSnapshot` 按 `chat_session_events` 现场折叠 `contextTimeline` 和 `contextActivity`，`sessionProjections.snapshot` 供 overview 的 live 会话路径读取，详情页仍走 `stateOf`；

下一步是回归 `dsh-cy-api` 个人页与 `dsh-ding-card` 公司页，并逐步 vendor 其他官方 client 包；仍然不要为了一个插件把完整 `dsh-web-app` 塞进 EAB。


---

## 15. 两种环境（公司 / 个人）怎么对齐

你说的“两种环境插件都支持，可以对齐”，落地时按下面做：

1. **同一套 client kernel**：公司页和个人页都用 `dsh-client-modules + client-ui-slots + client-ui-renderer`，不维护两套 runtime。
2. **同一套 slot 树**：`root / main / sidebar.panellist / settings.section / plugins.detail.actions / conversation.* / plugins.bundle.config` 两边都声明；差异只在数据和权限。
3. **页面各自 boot**：公司页 `/plugin-kernel.html?id=...`（控制台 scope，走 `/api/console/plugins/...`），个人页 `/plugin-kernel.html?id=...&scope=user`（员工 scope，走 `/api/my/plugins/...`）；一张页面只加载一个实例的 boot graph。
4. **同包不重复 row**：同一张 boot graph 里不要出现两个同名 package row；公司/个人页分开 boot，就不会触发 `dsh-client-modules` 的同名包冲突。
5. **数据/设置按实例键隔离**：`(pluginId, companyId, scope)` 决定数据根、设置命名空间、RPC 路由。
6. **会话可见性按 scope**：公司插件按公司策略，个人插件只读本人；服务端鉴权，前端只拿结果。
7. **验收两边都跑**：`dsh-cy-api` 公司页 + 个人页都要过；`dsh-ding-card` 至少公司页 + 个人页各一次；`dsh-context` 个人页优先，因为它是会话相关。

---

## 16. 需要确认的四件事

1. 验收边界是否接受“页面型插件优先，桌面专属/host-only 不保证”？
2. 是否接受 EAB 的 slot 名对齐 DSH（`main`、`settings.section`、`conversation.*`），即使 EAB 页面壳不是 DSH 三列布局？
3. 是否接受引入约 10～20 个 MIT client 包并 vendor 进 EAB，而不是继续手写 `dsh-runtime.js`？
4. 是否接受 DSH session 只做 EAB 消息的只读镜像，EAB `chat_messages` 仍是唯一事实源？

这四条确认后，Phase 0 可以直接开始。

---

## 17. Phase 0 已落地结果（2026-11-12）

### 17.1 已跑通的真实页面

新的正式插件页是 `packages/server/public/plugin-kernel.html`，由 EAB 页面壳 + DSH 官方 client kernel 组成：

- 官方 `@deepseek-ai/cordis`：真实 `new Cordis.Context()`，不是手写近似 ctx；
- 官方 `@deepseek-ai/dsh-client-ui-slots`：真实 `SlotCore`，root 的 `main`（keyed）、`sidebar.panellist`（list）、`settings.section`（list）、`plugins.detail.actions`（list）、`plugins.bundle.config`（keyed）、`conversation.*`（list）都由 EAB 声明；
- 官方 `@deepseek-ai/dsh-client-ui-renderer`：真实 `SlotOutlet / RootOutlet`，由 `ctx.uiRenderer.mount()` 挂载；
- 插件 client bundle 仍按 DSH 的 `window.__ModuleLoader__.load({ id, factory })` 注册，EAB 只提供 lazy-CJS loader 和 React seed，不解析插件源码；
- 插件请求通过现有 EAB 插件网关：控制台 scope 走 `/api/console/plugins/:id/gateway`，个人 scope 走 `/api/my/plugins/:id/gateway`；RPC 走同一实例的 `/rpc`。

已实测：

| 实例 | Scope | 页面 | 结果 |
|---|---|---|---|
| `dsh-cy-api` | 个人 `scope=user` | `/plugin-kernel.html?id=dsh-cy-api...` | 完整渲染“API 转 DSH / 接口配置 / 数据调用 / 版本更新”，`main` 1 个页面 |
| `dsh-ding-card` | 公司控制台 | `/plugin-kernel.html?id=dsh-ding-card...`（8788） | 完整渲染“钉卡片”管理页，RPC 返回凭据、卡片、连接数，`main` 1 个页面 |

这不是 lab 模拟：`dsh-cy-api` 的页面来自 `.eab-dev/plugins/dsh-cy-api/lib/client.js`，`dsh-ding-card` 的页面来自 `.eab-dev/plugins/dsh-ding-card/lib/client.js`，两者都没有被改写。

### 17.2 这次真正修掉的三个问题

1. **JSX children 丢失**：`react/jsx-runtime` shim 之前把 `key` 作为第三个参数传给 `React.createElement`，即使 key 是 `undefined` 也会覆盖 `props.children`，官方 renderer 的整棵 JSX 树变成空。现已改为先从 props 拆 `children`，`key` 只在非 undefined 时放入 config。
2. **session scope / locale face 缺失**：官方 renderer 的 root 固定走 `session-maybe`，必须 `ctx.slots.installScope('session', ...)`；`locale` 也必须是带 `register/getSnapshot/subscribe/bind` 的 face，且 `getSnapshot` 返回稳定对象，否则 React `useSyncExternalStore` 会触发 maximum update depth。
3. **`ctx.inject` 服务等待**：`dsh-ding-card` 的 client `inject = ['slots','connection','locale']`，并用 `ctx.inject(['layout'], cb)` 等页面壳。EAB 现在在页面内核里直接提供 `layout / connection / locale`，并给 `ctx.inject` 一个兼容实现；没有这个，插件 `apply` 会被 Cordis 挂起，页面表现为“0 个页面”。

### 17.3 公司/个人两套 scope 的对齐结果

- 页面 URL 已经切换：控制台 `app.js`、员工端 `chat.js` 都生成 `/plugin-kernel.html`，不再生成 `/plugin-host.html`；
- 公司页无 `scope=user`，请求自动带 `x-eab-console: 1`；
- 个人页 `scope=user`，不要求控制台会话，走员工 `/api/my/plugins/...`；
- 页面仍是“一张页面只 boot 一个实例”，没有把公司实例和个人实例塞进同一张图的同名 package 冲突。

### 17.4 仍需继续做的部分

- `settings.section` 现在通过页面顶部“页面 / 设置”切换：有 `main` 时默认显示页面，点设置切到 `settings.section`；没有 `main` 时自动回退到 `settings.section` 或 `plugins.bundle.config`。
- `conversation.view` 已在插件页接入：`Root` 检测 `registry.entries('conversation.view')` 且存在当前会话时，显示“会话上下文”页签；渲染时把 `sessionId`（URL 的 `session` 参数或 localStorage 当前会话）作为 owner props 传给插件组件。`dsh-context` 的上下文统计、Token、趋势和 Context Browser 已读到真实会话投影（57 条用户消息、47 步、29 次工具调用），不再全 0。
- `sessions / sessionQuery / sessionProjections` 的 host 投影已经接真实 `chat_messages`；页面内核目前只注入 `sessions` 的当前会话入口，还没有把 `sessionQuery` 的完整事件流暴露给前端插件，避免同源插件直接读全量消息。
- `dsh-context` 正式页已跑通：primitives 及其必要依赖已 vendor，页面显示 9 个会话、Token `812.3k`、轮次 `112`、近 7 天柱状图、Token 统计和耗时统计；`detail head` 对真实会话返回 `toolCalls:23`、`humanInputs:50`、`answers:41`；overview 的“工具调用 61 / 工具执行 5.3s / 活跃时长 19m33s / 模型调用 89”已来自 `summary.timing`，由 `chat_messages.meta_json.toolCalls[].durationMs` 与事件时间跨度折叠。
- “模型等待 / 模型生成”已完成真实链路验证：`EAB_DEV_AUTH=1` 下发送一条真实对话，助手消息落库 `meta_json.timing={ttftMs:17692,genMs:1109,wallMs:18850}`；`chatSessionEvents` + `foldContextTimeline` 读回同一组值；清理测试会话后，页面仍基于真实消息显示“模型等待 1.1% / 13.0s / 89次”“模型生成 2.3% / 26.5s”，截图保存在 `.eab-dev/tmp/dsh-context-page.png`。历史消息没有 timing 仍按 0 处理。
- 为跑通开发预览，`dev-seed.ensureModelCatalog` 增加了“公司不存在则跳过”的保护：演示目录包含 `c1/c2`，但真实库只启用 `c1` 时原逻辑会向不存在的 `c2` 插 `model_providers` 并触发 FK。
- `dsh-cy-api` 个人页已回归：`installScope=user`、host `loaded=true`、3 个工具；页面“API 转 DSH / v2026.11.12 / 全局页面 / 已配置”完整渲染，`/gateway/dsh-cy-api/api/connection` 返回 200。此前页面 404 的根因是 `plugin-kernel.html` 的网关转发没有把 URL 里的 `as=<userId>` 带给 `/api/my/plugins/:id/gateway/*`，被后端判成“未安装”；已在 `mapPluginUrl` 中为 user scope 补 `as`。两个个人账号的存储目录分别落在各自 `dsh-home/scopes/users/...` 下。
- `dsh-ding-card` 公司页已回归；primitives/importmap 接入后公司页与个人页均可用。
- 管理后台与员工对话页的 401 已统一改为“直接跳登录页”：`app.js` 的 `parseResponse` 在 401 时 `location.replace('/admin' + location.search)`，`chat.js` 的 `api` 与 `streamChat` 在 401 时跳 `/chat?login=1`（保留 company、去掉失效 as），并通过永不结束的 Promise 阻止调用方继续渲染错误提示。实测控制台 Cookie 清空后点击导航会落到管理员登录门，员工页无效 `as` 会落到 `/chat?login=1`，均无“需要登录”提示。
- 非 `api()` 路径也已接入同样的 401 跳转：控制台导出 `downloadConsoleFile`、对话页文件读取/下载、插件页 `RPC`/网关 `fetch`/`XHR`，以及 client bundle 的脚本预探测；插件 iframe 会把最外层页面带回 `/chat?login=1` 或 `/admin`。
- 已新增 `pnpm test:auth-redirect`（`scripts/auth-redirect.e2e.mjs`）固化上述行为：覆盖控制台有效会话、导航 401、导出 401、员工 API 401、个人插件 iframe 401；默认连接 9335 的独立测试 Chrome，没有则自动启动 headless Chrome，控制台凭据读 `.eab-dev/admin-credentials.txt` 或 `EAB_ADMIN_USER/EAB_ADMIN_PASSWORD`。前置要求 `pnpm dev` 已运行。
- 插件宿主已补 `sessionPersistence.stat/open`：`dsh-context` 的 projection backfill 通过 `open(id, 'read')` 读取 `chat_messages` 映射出的 DSH 事件，再写回 `sessionProjectionCache.coldSnapshot`。补上该服务后，`dsh-context v0.84.0` 页面不再卡在“投影补算中…”，9 个会话投影完成；耗时统计实测为活跃 19m59s、模型等待 25.8s（90 次）、模型生成 37.4s、工具执行 5.3s（62 次）。顶部 KPI 读取 `contextActivity.days` 的 `toolsMs/wallMs`，已在 `foldContextActivity` 为每日桶补上这两个字段，避免概览顶部继续显示 `—`。
- 不是所有 DSH 插件都能“无条件全能力可用”：桌面专属（原生目录选择、打开本地应用、Office 转 PDF、subprocess、workspace、终端）仍不保证；host-only 插件可能只有能力注册、没有页面；深度写 DSH Agent/session 的插件只能只读兼容。
- 插件宿主的依赖预装已改为“按插件目录并发、单插件预算内失败即降级”：`runNpmInstall` 支持 `AbortSignal`，默认单轮 60 秒、单插件 90 秒预算，可用 `EAB_PLUGIN_INSTALL_TIMEOUT_MS` / `EAB_PLUGIN_INSTALL_BUDGET_MS` 覆盖；`reloadPluginHosts` 先创建全部实例，再并发预装，最后串行启动 host。某个插件装不上时只在该实例上写 `依赖安装失败：...`，后面的插件继续启动。新增 `plugin-dependency-isolation.test.ts`，验证失败只返回错误 Map、不抛断批量预装。
- `plugin-kernel.html` 已补入口校验：`scope=user` 必须带有效员工 Cookie，且 `as` 不能与当前登录身份不一致；未登录跳 `/chat?company=...&login=1`。控制台 scope 必须带有效 `eab_console_sid`，否则落到 `admin-gate.html`。查询里的 `company` 与当前实例不一致直接 403。有效员工本人页、错误 `as` 403、无会话跳登录、控制台无会话进登录门均已实测；`pnpm test:auth-redirect` 8 项仍全绿。

