# EAB 插件「安装即用」兼容层方案

> 目标：把 EAB 从「每来一个 DSH 插件就补一次适配」改成「按 DSH 协议安装完就能跑」。
> 判断标准只有一个：新插件只改插件自己的代码，不改 EAB 的 `plugin-host.ts` / `dsh-runtime.js` / `plugin-host.html`。

## 1. 结论

当前问题的根因不是某个插件兼容得不够，而是 EAB 在手写一套 DSH 宿主协议，而且只实现了被现有插件碰到的部分。每装一个新插件，就会暴露一批新服务、新事件模式、新网关行为，于是又变成一次单插件适配。

建议把宿主层换成 **Cordis 内核 + EAB 服务提供者**，客户端侧保留 EAB 的外壳但按 **DSH client 契约**补齐，HTTP 侧改成 **统一插件网关**。这样：

- 插件的 `inject`、`apply`、`effect`、`provide`、`fiber`、事件模式由 Cordis 直接负责；
- EAB 只负责实现自己的服务（LLM、会话、凭据、工具、网关、多租户）；
- 插件页面不再按 `routes` 扫描拼桥，而是所有插件 API 统一走一个命名空间；
- 不支持的服务有明确状态和诊断，不会再静默空白。

## 2. 为什么现在必然要逐个适配

现有实现里有五个结构性问题：

1. **手写服务表，不是 Cordis 服务容器**
   `plugin-host.ts#makeContext` 用 `Map` 存服务，`ctx.inject` 只判断 `services.has(key)`；没有服务描述、版本、生命周期，也没有 Cordis 的 `Fiber` 状态。
   典型后果：`services.set('agents', undefined)`、`services.set('pluginManager', undefined)` 这种「键存在但值是 undefined」会被当成服务已就绪；反过来 `commands` 没注册，插件就永远排队。`dsh-our-free-model` 日志里的 `inject 等待服务：credentials,commands,llm` 就是后者。

2. **服务只补了被碰到的子集**
   目前有 `connection / webServer / credentials / settings / sessions / tools / systemPrompt / llm` 等，但缺 `commands / interval / fiber / profileContext / attachments / approval`；`llm.registerAdapter` 只返回 `() => undefined`，所以插件调用 `registration.replace()` 才报 `registration.replace is not a function`。

3. **插件入口形态只认一种**
   现在只检查 `mod.apply`。DSH/Cordis 插件还允许 `export default` 对象、类插件、`export const inject`、`export const Config`。入口形态判断不对，后面所有服务注入都无从谈起。

4. **客户端运行时是近似实现，manifest 里的 `dsh.client.inject` 被解析但没用**
   `plugins.ts` 已经把 `clientInject` 读出来了，但 `dsh-runtime.js` 仍然用一套固定模块和「万能 Proxy」兜底。插件依赖的模块没有真实实现，页面要么空白，要么静默 no-op。

5. **网关是「按路由前缀补桥」，不是协议网关**
   `plugin-host.html` 从 host 状态里提取 `/api/<x>` 前缀，只拦截 `fetch`；`XHR / EventSource / WebSocket` 不覆盖。服务端 `dispatchPluginWeb` 之前还会丢子路径和 query，`adaptNodeHandler` 会把 SSE 缓冲到 2 秒再一次性返回。这些都不是单个插件的问题，是网关层缺协议。

此外还有一个多租户正确性问题：`instances` 以 `pluginId` 为 key，`reloadPluginHosts` 只传最后一次的 `options`。同一插件被多家公司启用时，实际只有一个 host 实例，且公司上下文可能串。插件「装就能用」必须按 `companyId + pluginId` 隔离。

## 3. 方案总览

分三层，职责不混：

```
┌─────────────────────────────────────────────────────────────┐
│ EAB 控制台 / 个人工作台                                       │
│  └─ iframe：DSH Web Runtime（slots / settings / locale / ...）│
│       └─ 统一 API 代理：fetch / XHR / EventSource            │
├─────────────────────────────────────────────────────────────┤
│ 统一插件网关                                                  │
│  /api/console/plugins/:id/gateway/*                          │
│  /api/my/plugins/:id/gateway/*                               │
│  原样转发 method / path / query / body / stream              │
├─────────────────────────────────────────────────────────────┤
│ EAB DSH Host Kernel（每公司一个 Cordis root）                │
│  Cordis Context + Fiber + 服务注册 + 事件模式                │
│  EAB 服务提供者：llm / sessions / credentials / tools / ...  │
│  插件 fiber：ctx.plugin(pluginModule, config)                │
└─────────────────────────────────────────────────────────────┘
```

### 3.1 选型：用 Cordis，而不是继续手写

`@deepseek-ai/cordis` 已经发布（当前 4.1.0），核心能力正好是 EAB 现在手写的那些：

- `Context` 服务容器、`provide/get/inject`；
- `Fiber` 生命周期：`PENDING / LOADING / ACTIVE / FAILED / DISPOSED`；
- `ctx.effect` 自动清理；
- `ctx.on / emit / parallel / serial / bail / waterfall` 五种事件模式；
- `ctx.plugin(plugin, config)` 支持函数、对象、类三种入口；
- `Config` Standard Schema 校验与默认值；
- `fiber.inject` 直接给出「还在等哪些服务」。

这比继续在 `makeContext` 里补方法可靠得多，也不会每来一个插件就补一次。

**不选「整包内嵌 DSH」**：那会把 DSH 的 profile、文件树、会话、桌面端一起搬进来，和 EAB 的 SQLite、多租户、权限模型冲突，运维成本过高。
**不选「继续手写补丁」**：短期最快，长期一定回到今天这个局面。

### 3.2 每公司一个 Cordis root

```
CompanyHost(c1)
  root = new Context()
  root.provide('connection', c1Connection)
  root.provide('commands', c1Commands)
  ...
  root.plugin(pluginA, patchConfigA)  // Fiber A
  root.plugin(pluginB, patchConfigB)  // Fiber B
CompanyHost(c2)
  root = new Context()
  ...
```

- 插件代码只加载一次，但 `apply` 每公司跑一次；
- 服务、设置、路由、工具贡献都挂在该公司的 root 下；
- 卸载某公司插件只 dispose 那个 Fiber，不影响其它公司；
- 网关按控制台会话解析 `companyId`，再找对应 `CompanyHost`。

## 4. Host 侧设计

### 4.1 插件入口统一走 Cordis

`startOne` 改成：

```ts
const plugin = normalizePluginModule(mod) // default / apply / class
const fiber = root.plugin(plugin, config)
await fiber // FAILED 抛错；PENDING 不阻塞启动，但状态可见
```

`normalizePluginModule` 的规则：

- `mod.default` 是函数/类/`{apply}` → 用它；
- 否则 `mod.apply` 是函数 → 用 `mod`；
- 否则报 `not a DSH/Cordis plugin`；
- 保留 `mod.inject`、`mod.Config`、`mod.name`。

不要自己判断 `inject`：交给 Cordis。`apply` 只在依赖服务齐备后才执行，这是 DSH 的原生语义。

### 4.2 基础服务矩阵

所有插件共用一套 **base services**。能实现的实现，暂时不能实现的给「明确降级」的 stub，不让 `inject` 永远挂起，也不让字段是 `undefined`。

| 服务 | 用途 | EAB 目标实现 | 优先级 |
|---|---|---|---|
| `logger` | 插件日志 | 已有，接入 Cordis logger | P0 |
| `effect` | 生命周期 | Cordis 原生 | P0 |
| `inject/provide/get` | 依赖注入 | Cordis 原生 | P0 |
| `fiber` | 插件身份/配置 | Cordis 原生；补 `entry.options.id` | P0 |
| `interval/timeout` | 定时器 | disposal-aware 定时器，挂到 Fiber | P0 |
| `connection` | `fetch.register` / `rpc` / `admit` | 完整契约，`admit` 由网关鉴权兜底 | P0 |
| `webServer` | `register / registerUpgrade / registerFallback / tapIndex` | 支持 exact/prefix、Node handler、SSE、WebSocket upgrade | P0 |
| `commands` | 注册/列出/执行命令 | 先实现注册与列表；执行接 EAB 对话命令 | P1 |
| `llm` | provider/model、adapter、model discovery | `registerAdapter` 返回 `{ replace, dispose }`；adapter 接入 EAB 模型路由 | P1 |
| `credentials` | secretRef 读写 | 已有 dsh-im 兼容，扩展为通用 secretRef | P0 |
| `settings` | 插件设置 | 复用现有 `makeSettingsService`，客户端走 RPC 而不是 localStorage | P1 |
| `sessions` | 会话列表/读取/创建 | 已有适配，补齐 DSH 形状 | P1 |
| `sessionController` | 会话控制 | 已有适配，补齐失败语义 | P2 |
| `workspaceController` | 工作区 | 已有适配 | P2 |
| `tools` | 工具注册 | 已有，接入 Cordis Fiber 清理 | P0 |
| `systemPrompt` | 系统提示贡献 | 已有 | P0 |
| `agents` | 子 Agent / 会话创建 | 先给 `list/get/create/resume` 的明确 stub；接 EAB Agent 后转正 | P2 |
| `pluginManager` | 插件管理 | 给 `list/enable/disable` stub | P2 |
| `profileContext` | 公司/用户上下文 | 用 EAB 当前公司、操作员、locale 实现 | P1 |
| `attachments` | 附件 | 复用 EAB 文件能力，先只读 | P2 |
| `approval` | 审批请求 | fail-closed stub；后续接 EAB approvals | P2 |
| `userQuestions` | 交互提问 | `NO_PROVIDER` 语义的 stub | P2 |
| `speechToText` | 语音 | 已有 unavailable stub | P2 |
| `typertGateway` | EAB 渠道桥 | 保留，作为 EAB 服务提供者 | P0 |

**stub 的规则**：必须有真实的方法名和返回值形状；`available: false`；调用不能抛未捕获异常，返回 `{ ok:false, code:'unsupported', message }` 或空数组。这样插件至少能完成 `apply`，页面能打开，兼容报告能说明「哪项降级」。

### 4.3 事件模式

`ctx.on` 只实现 emit 不够。DSH 的审批、工具前置检查用的是 waterfall：

- `ctx.emit` / `ctx.parallel` / `ctx.serial` / `ctx.bail` / `ctx.waterfall` 全部由 Cordis 提供；
- EAB 自有事件（如 `llm/adapters-updated`、`loader/volatile-update`）通过 `root.emit` 发；
- 插件注册的 `approval/request` 等事件如果 EAB 没有生产者，就保持注册但不触发，并在兼容报告里标记「事件源未接入」。

### 4.4 插件配置与 `cordis.patch.yml`

- 用 `mod.Config` + Cordis 校验配置，补默认值；`apply(ctx, config)` 拿到的是规范化后的 config；
- 解析 `cordis.patch.yml` 的 `insert` 行，取出该插件自己的 `id/name/config`；EAB 不需要实现完整 profile 分层，但不能把 `config` 丢了；
- 如果 patch 里有 EAB 不认识的 `!!js` 表达式，安装时标记 `unsupported`，不要静默忽略。

### 4.5 依赖 Shim：不执行 npm install，也能 import `@deepseek-ai/*`

插件包经常 `import { Service } from '@deepseek-ai/cordis'`，但安装流程明确不跑 `npm install`。做法：

```
.eab-dev/plugins/node_modules/@deepseek-ai/
  cordis/          -> EAB 兼容实现（或直接依赖真实 cordis）
  dsh-commands/    -> EAB CommandService 导出
  dsh-credentials/ -> EAB credentials 导出
  dsh-llm/         -> EAB llm 导出
  schemastery/     -> 最小 Standard Schema 实现
```

- 插件自己的 `node_modules` 优先；没有时向上找到这层共享 shim；
- 安装/启动时按 manifest 的 `peerDependencies` 生成/校验这层 shim；
- 只对 `@deepseek-ai/*` 的宿主协议包做 shim；插件私有依赖仍要求随包提供，否则标记「依赖不完整」。
- 不执行任何 lifecycle 脚本，保持现有安装安全边界。

### 4.6 状态与诊断

`PluginHostStatus` 增加：

```ts
{
  companyId, pluginId,
  state: 'pending' | 'active' | 'failed' | 'disposed',
  pendingServices: string[],       // fiber.inject 里还没就绪的 key
  providedServices: string[],      // 插件自己 provide 的服务
  routes: [{ path, methods, kind }],
  client: { modules, slots, bootError },
  compatibility: 'full' | 'degraded' | 'unsupported',
  warnings: [{ code, message }]
}
```

控制台插件页直接显示「完整兼容 / 降级 / 不支持」和原因，不再用空白页表达失败。

## 5. 统一插件网关

### 5.1 服务端

两条命名空间，控制台和个人工作台分开：

```
/api/console/plugins/:id/gateway/<plugin-path>
/api/my/plugins/:id/gateway/<plugin-path>
```

规则：

- 解析控制台/员工会话得到 `companyId`，找到 `CompanyHost(companyId, pluginId)`；
- `targetPath` 是 `<plugin-path>` 原样，不再用注册表前缀猜；
- 转发 `method / path / query / content-type / body`；
- **流式响应直接 pipe**，不 `await response.text()`；SSE、下载、长轮询都保持；
- 只允许该插件自己注册的路由；不允许任意 host、路径穿越、保留前缀；
- 方法支持 `GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS`；
- `webServer.register({ kind:'exact'|'prefix' })` 按 kind 匹配，prefix 走最长前缀；
- `registerUpgrade` 走 WebSocket upgrade，`registerFallback` 只允许一个 owner；
- `connection.admit` 由网关鉴权结果回答，插件不直接决定控制台权限。

### 5.2 客户端代理

在加载插件 client 之前安装，覆盖所有出站方式：

```js
fetch        -> 同源 /api/** 改写到 gateway + 原 path + query
XMLHttpRequest.open -> 同上
EventSource  -> 同上；SSE 走 gateway
sendBeacon   -> 同上
```

- 不改 `/api/console/plugins/<id>/**`、`/plugins/assets/**`、`/api/health` 等宿主路径；
- 跨域请求原样放行；
- 控制台 scope 补 `x-eab-console: 1`；个人 scope 使用员工 cookie；
- 不再依赖 `host status.routes` 的前缀；即使插件启动晚、路由后来才注册，请求也不会打空。
- 可选设置 `<base href="/api/console/plugins/<id>/gateway/">`，但只作为兼容补充，不能替代代理。

### 5.3 兼容旧行为

旧网关路径 `/api/console/plugins/:id/gateway/*` 保留；新的客户端代理仍指向它。这样已经打开的控制台页面不需要改 URL。

## 6. 客户端运行时

### 6.1 模块注册表

`dsh-runtime.js` 不再用「万能 Proxy」当默认：

```js
const modules = {
  'react': window.React,
  'react-dom': window.ReactDOM,
  '@deepseek-ai/dsh-client-connection': makeConnection,
  '@deepseek-ai/dsh-client-ui-slots': makeSlots,
  '@deepseek-ai/dsh-client-ui-settings': makeSettingsModule,
  '@deepseek-ai/dsh-client-locale': makeLocale,
  '@deepseek-ai/dsh-client-runtime': makeRuntime,
}
```

- manifest 的 `dsh.client.inject` 决定要预置哪些模块；缺失模块在启动时报告；
- 未知模块返回明确 stub，`__unsupported: true`，不再假装所有属性都是函数；
- `dsh.client.inject` 里的模块如果 EAB 有真实实现，优先真实实现；没有则降级并标记。

### 6.2 `ctx` 与 slot props

slot 组件至少拿到：

```js
{
  ...spec.inject(),
  t,          // 绑定 spec.locale 的翻译函数
  ctx,        // 当前 client context
  locale,     // locale 对象
}
```

- `spec.inject()` 返回值不能覆盖标准字段；标准字段最后合并；
- 每个 slot 组件套一层 error boundary；单个页面组件抛错只影响该页，不把整个 iframe 清空；
- `shell.panelCount()` 之外补 `shell.lastError`，宿主状态可见。

### 6.3 设置与 RPC

- `settings` 不再只写 `localStorage`；改为 `connection.rpc.call(base, channel, call)` 到 host 的 `settings` 服务；
- 保留 localStorage 作为「离线缓存」，但以 host 为准；
- `connection.rpc.call` 的 `base` 参数要参与寻址，不能忽略；
- RPC 错误带 `code/message`，插件页面能显示具体失败原因。

### 6.4 `layout / slots / settings` 语义

- `ctx.slots.inject(name, callback)` 回调在 slot 可用时执行，返回 disposer；
- `ctx.slots.register` 注册的条目按 `order` 排序；
- `ctx.layout.selectPanel(key)` 选中当前插件自己的页面；
- `ctx.provide` 后通知 `inject` 等待者；
- `ctx.inject` 支持数组和 `{ required, optional }` 两种形式；optional 缺失不阻塞。

## 7. 安装与兼容检查

安装流程保持「只复制、不执行 npm install」，增加 **静态兼容检查**：

1. Node engine 是否满足；
2. `dsh.compatibility.dsh` 用完整 semver 范围判断，不再只支持 `=`/`>=`；
3. `dsh.client.platform` 必须是 `web`，`profiles` 必须包含 `web`；
4. `main` / `exports` / `client` 入口存在；
5. `dsh.bundle.patch` 存在，且能解析 `insert`；
6. `dsh.client.inject` 的模块是否在 EAB client 模块表里；
7. `peerDependencies` 的 `@deepseek-ai/*` 是否有 shim；
8. 缺依赖 / 缺服务 / 缺模块 → 生成 `compatibility` 报告，不阻止安装，但默认不启用或标记「降级」。

## 8. 代码落点

| 位置 | 改造 |
|---|---|
| `packages/server/src/plugin-host.ts` | 删除手写 `makeContext`，换成 `CompanyHost` + Cordis root；服务提供者拆到 `plugin-services/`；`dispatchPluginWeb` 改为原样转发 + 流式 |
| `packages/server/src/plugins.ts` | 入口形态、`Config`、完整 semver、`clientInject` 接入；安装时生成兼容报告 |
| `packages/server/src/routes/plugins.ts` | 网关传 `companyId`；支持 user scope；流式 pipe；方法全集 |
| `packages/server/public/dsh-runtime.js` | 模块注册表、slot props、error boundary、inject 语义、settings RPC |
| `packages/server/public/plugin-host.html` | 统一 API 代理（fetch/XHR/EventSource/beacon）；不再扫描 routes 前缀；状态与诊断展示 |
| `packages/plugin-compat/`（新增） | `@deepseek-ai/*` shim、服务接口类型、conformance fixtures |
| `packages/server/test/plugin-conformance.test.ts`（新增） | 安装/启停/页面/网关/多公司/降级矩阵 |

## 9. 分阶段实施

### P0：先把「不再逐个适配」的骨架立起来

1. 引入 `@deepseek-ai/cordis`，把 `makeContext` 换成每公司一个 Cordis root；
2. 插件入口统一 `ctx.plugin(module, config)`，尊重 `inject` / `Config`；
3. 基础服务矩阵落地：`connection / webServer / commands stub / llm registry / interval / fiber / agents stub / pluginManager stub`；
4. `llm.registerAdapter` 返回 `{ replace, dispose }`，先解决 `registration.replace` 类错误；
5. 统一网关：原样 path/query/method/body + 流式响应；
6. 客户端统一代理：fetch/XHR/EventSource；
7. 兼容报告与插件页错误展示。

### P1：让页面和常用能力真正可用

1. slot props 标准字段 + 单页 error boundary；
2. settings 走 host RPC，客户端 localStorage 只作缓存；
3. `commands` 接 EAB 命令面板/对话命令；
4. `llm` adapter 接 EAB 模型路由（插件模型能出现在模型选择器里）；
5. `profileContext` / `attachments` 接 EAB 现有能力；
6. 每公司 host 实例与网关 company 解析完成。

### P2：把「降级」变「完整」

1. `agents` / `approval` / `userQuestions` 接 EAB Agent/审批；
2. `webServer.registerUpgrade` WebSocket；
3. `settings` 热更新、插件 HMR；
4. 上游 DSH client 包如果可直接复用，替换手写 runtime；
5. 旧 `dsh-im-compat` 从 host core 挪到独立 integration provider，只保留服务适配，不再参与插件加载分支。

## 10. 验收标准

### 10.1 硬标准

- 安装一个只声明标准 `dsh` 字段的新插件，不改 EAB 任何代码，页面能打开、host `apply` 能完成、插件 API 能通。
- `plugin-host.ts`、`dsh-runtime.js`、`plugin-host.html` 里不出现 `dsh-<具体插件名>` 的分支；`dsh-im-compat` 这类外部集成只能出现在独立 provider。
- 同一插件在 c1、c2 同时启用时，两个 host 实例、两套设置/路由/数据，互不串。
- 插件 `inject` 缺少服务时，状态显示 `pending` 和缺失 key，不出现整页空白。
- 网关支持 `GET/POST/PUT/PATCH/DELETE`、子路径、query、二进制、SSE。

### 10.2 回归矩阵

| 插件 | 验证点 |
|---|---|
| `dsh-ding-card` | 3 个页面、RPC、渠道绑定不回归 |
| `dsh-our-free-model` | host `ACTIVE`、`inject` 无 pending、`registerAdapter.replace` 可调用、页面完整 |
| `dsh-mrrp` | `layout` 注入、settings 页、RPC、侧栏入口 |
| 新增 fixture `dsh-conformance-*` | 纯 slot / API / SSE / 抛错 / 缺服务五种形态 |

### 10.3 自动化

- 新增 `plugin-conformance.test.ts`：入口形态、inject 等待/恢复、服务 stub、网关路径/方法/query/stream、多公司隔离；
- 保留 `node --check`、`tsc`、全量 `pnpm test`；
- 浏览器验收至少覆盖 3 个已装插件 + 1 个新 fixture。

## 11. 风险与边界

- **插件是代码执行**：host 侧插件和 EAB 同进程，能 import Node API。本方案解决协议兼容，不解决进程隔离；要真正隔离，后续用 worker/独立进程 + 受限 API。
- **不是所有 DSH 插件都能完整支持**：依赖 desktop profile、私有 host 内部包、未声明的 npm 依赖、需要真实 DSH Agent 运行时的插件，会标记 degraded/unsupported，而不是假装成功。
- **Cordis 版本要对齐**：以插件 `peerDependencies` 的 `@deepseek-ai/cordis` 范围为准，EAB 锁一个兼容版本，并保留 shim 层。
- **客户端无法完全复用上游**：如果上游 client 包没有可直接加载的浏览器产物，EAB 仍需维护契约运行时；但必须用 conformance fixture 锁住行为，不能靠逐个插件试。
- **多租户内存成本**：每公司一个 Cordis root，插件多时内存上升；可加空闲卸载/懒加载，但不改变隔离语义。

## 12. 一句话路线

**停止在 `makeContext` 里逐个补方法，改成 Cordis 内核 + 标准服务矩阵 + 统一插件网关 + 客户端契约运行时；用 conformance fixture 和三个已装插件验收，之后新插件只装不改 EAB。**

## 13. P0 实施记录（2026-11-11）

P0 已落到真实服务上，不是纸面方案。三个 DSH 插件在未改 EAB 插件专属代码的前提下完成安装、host 启动、页面渲染和 API 访问。

### 13.1 已落地的代码

| 位置 | 实际改动 |
|---|---|
| `packages/server/package.json` / `pnpm-lock.yaml` | 引入 `@deepseek-ai/cordis@4.1.0` |
| `packages/server/src/plugin-host.ts` | 每个 `companyId + pluginId` 一个 Cordis root 和 `Fiber`；入口支持函数、`{ apply }`、class，保留 `inject` / `Config` / `name`；服务矩阵补齐 `commands / llm / agents / pluginManager / profileContext / attachments / approval / userQuestions / webServer / connection`；`llm.registerAdapter` 返回可用的 `{ replace, dispose }`；`registerAdapter` 同步更新 `llmProviders`；`getHostInstance` 严格按公司隔离，不再跨公司回退；`dispatchPluginWeb` 支持 exact/prefix、方法匹配和 404 诊断；SSE 走流式 |
| `packages/server/src/routes/plugins.ts` | 控制台 `/api/console/plugins/:id/gateway/*` 与个人 `/api/my/plugins/:id/gateway/*` 统一走 `dispatchPluginWeb`，传真实 `companyId`；响应用 `Readable.fromWeb` 流式回传，复制除 `content-length` 外的响应头；临时路由树 debug 接口已删除 |
| `packages/server/public/plugin-host.html` | 不再解析 host status 的 route 前缀，统一代理同源 `/api/*` 到 `gatewayBase`；覆盖 `fetch`、`XMLHttpRequest`、`EventSource`（fetch + SSE 帧解析）、`navigator.sendBeacon`；控制台 scope 自动补 `x-eab-console`；保留 EAB 自身 API 前缀和插件静态资源路径；状态页展示 `pendingServices` |
| `packages/server/test/plugin-host-inject.test.ts` | 测试夹具补齐 `HostInstance` 的 `companyId / upgrades / root / fiber` 字段 |

### 13.2 真实运行验收

- `dsh-our-free-model`：`state=active`、`pendingServices=[]`、`routes=["/api/our-free-model","/api/our-free-model/events"]`，控制台插件页完整显示导航、模型、公告和更新检查。
- `dsh-ding-card`：`state=active`、`pendingServices=[]`、`routes=["/api/dsh-ding-card"]`，页面 3 个 tab，dsh-im、凭据、回调、卡片库均可见。
- `dsh-mrrp`：从 `D:\dsh\dsh-mrrp` 本地目录安装后，未改 EAB 代码，host 立即 `active`、`routes=["/api/mrrp"]`；控制台插件页的 iframe 直接渲染出「MRRP 模型路由控制台」，左侧导航、路由配置、角色部门、日志管理均可见，`clientInject` 的 `connection / runtime / ui-slots / ui-settings / locale` 没有缺模块。
- 网关实测：`/gateway/api/our-free-model/meta` 与 `/announcements` 返回 200；`/gateway/api/our-free-model/events` 带 `accept: text/event-stream` 返回 `200`、`content-type: text/event-stream`、`Transfer-Encoding: chunked`，收到 `: connected` 与 `event: hello`，SSE 不再被缓冲。
- 检查：`npx tsc -p tsconfig.json --noEmit` 通过；`node --check packages/server/public/app.js` 通过；`pnpm test` 55 个文件、304 个用例全部通过。

### 13.3 仍属 P1/P2 的能力

- `commands.execute` 仍是明确拒绝的 stub；`session.prompt` 尚未接真实执行面。
- `llm.registerAdapter` 已在 P1 合并进 EAB 对话模型路由（见第 14 节）。
- `agents / pluginManager / attachments / approval / userQuestions` 是 `available:false` 的形状正确 stub。
- `webServer.registerUpgrade` 只登记并告警，WebSocket upgrade 未实现。
- `dsh-runtime.js` 仍是 EAB 自己的 client 契约运行时，尚未改成按 `dsh.client.inject` 驱动的模块注册表；现有三个插件能跑，是因为它们使用的 `ctx.inject / slots / settings` 语义已被运行时覆盖。
- `dsh-our-free-model` 的 `free-channel pack` 仍因缺少 `@deepseek-ai/dsh-credentials` 降级，sealed lane 因未识别 host profile 隐藏；这是插件自身依赖和 profile 判定问题，不是宿主服务缺失。

### 13.4 下一步验收口径

新增插件只允许改插件自己的 `package.json` / host / client；如果必须改 `plugin-host.ts`、`plugin-host.html` 或 `dsh-runtime.js` 才能跑，就说明还缺标准服务或网关语义，应补服务而不是补插件分支。

## 14. P1 实施记录（插件 LLM adapter 接入模型路由）

### 14.1 目标

插件通过 `ctx.llm.registerAdapter(routes, adapter)` 注册的模型，必须能像 EAB 自己的模型一样进入 `/api/chat/models`，并在用户选择后真正走插件 adapter 的 `prepareCall / stream`。EAB 不要求插件把模型写进 `models` 表，也不为某个插件写死模型清单。

### 14.2 已落地的代码

| 位置 | 实际改动 |
|---|---|
| `packages/server/src/plugin-models.ts` | 新增进程内插件模型注册表。`registerPluginAdapter(companyId, pluginId, routes, adapter)` 保存 adapter，异步调用 `adapter.listModels(route)`，把返回的模型投影成带 `plugin:` 前缀的虚拟模型；`replace / dispose` 可更新和撤销；同一 adapter 重复注册会复用，不重复堆积 |
| `packages/server/src/plugin-host.ts` | `llm.registerAdapter` 不再只写本地 Map，改为调用 `registerPluginAdapter`，同时保留 `llmProviders` 状态统计；`replace / dispose` 同步到模型注册表 |
| `packages/server/src/routes/chat.ts` | `loadModelCatalog` 在 DB 模型之后合并 `listPluginModels(companyId)`，插件模型对拥有 `chat.use / model.use` 的身份可见；`runAgentTurn` 对 `plugin:` 前缀的模型改走 `callPluginModel`，其余模型继续走原 `callModelStream` |
| `packages/server/src/plugin-models.ts` | `callPluginModel` 把 EAB `ChatMessage` 归一成 DSH harness block（`text` / `image` / `tool-call`、`toolCallId`），再调用 `prepareCall().stream()`；把 `text-delta / reasoning-delta / tool-call-delta / usage / finish` 投影成 `CallResult` 与 `onEvent`；上游失败统一映射为 `EAB_UPSTREAM` 502，不再落成 500 系统异常 |
| `packages/server/test/plugin-models.test.ts` | 新增单测：adapter 模型投影、`plugin:` ID、图片能力、流式文本/用量、调用后 `dispose` 清理 |

### 14.3 真实服务验证

- 重启后 `GET /api/chat/models` 返回 24 个插件模型，例如：
  - `plugin:mrrp:route`（MRRP 智能路由）
  - `plugin:our-free-model:deepseek-v4.1-flash-free`
  - `plugin:our-free-model:mimo-v2.6-flash-free`
  - `plugin:our-free-model-region:beam-free`
- `POST /api/chat/messages` 使用 `plugin:our-free-model:deepseek-v4.1-flash-free` 发起真实对话，请求已进入插件 adapter，返回 `502 EAB_UPSTREAM`，错误信息为上游免费额度用尽（`Free usage limit reached...`），说明模型路由、adapter 调用和错误映射均已贯通；当前上游额度和出口限制导致没有拿到成功回复，不是 EAB 路由未接入。
- `npx tsc -p tsconfig.json --noEmit` 通过。
- `pnpm test` 56 个测试文件、305 个用例全部通过。
- P1 客户端运行时直接页 `plugin-host.html?id=dsh-mrrp&entry=lib/client.js&company=c1&version=2026.11.07&title=dsh-mrrp&inject=<五个模块>` 的运行时状态为 `ready=true`、`errors=[]`、`missingModules=[]`，五个声明模块全部 `available`，slot 注册包含 `settings.section / main / plugins.detail.actions / sidebar.panellist`；带有效控制台会话时页面完整渲染「MRRP 模型路由控制台」。
- 控制台会话失效时，插件页现在显示「控制台会话已失效」并给出「请先在 /admin 登录」，不再长期停在「host 状态检测中」；这条是 P1 错误边界在真实 401 下的实际触发结果。

### 14.4 尚未完成的验证

- `dsh-our-free-model` 的真实成功回答尚未拿到：当前上游返回免费额度用尽，需要用有额度的账号或其它插件模型做一次成功对话。
- 控制台 iframe 自动生成的带 `inject` URL 尚未在重启后重新点开回归；本轮用直接页和 `app.js` 的 `pluginPageUrl` 代码路径验证，尚未替代控制台真实点击。
- `SlotBoundary` 没有用故意抛错的客户端页面主动触发；当前只验证了三个正常插件不报错。
- `dsh-runtime.js` 仍只覆盖 5 个常用 `@deepseek-ai/dsh-client-*` 模块，未实现模块走 Proxy shim 并在页面提示，不是完整上游运行时。

## 15. P1.5 实施记录（插件模型通道进入控制台模型列表）

### 15.1 目标

DSH 里 `ctx.llm.registerAdapter` 注册的是“模型通道 + 模型目录”，模型列表由 DSH 自动展示。EAB 不能只让 `/api/chat/models` 能选，还必须让插件通道和模型出现在控制台“模型接入”页；不把插件模型写进 `models` 表，也不给任何插件写死适配。

### 15.2 通用机制

| 位置 | 实际改动 |
|---|---|
| `packages/server/src/plugin-models.ts` | `registerPluginAdapter` 增加 `pluginId` 参数；adapter 的每条 route 生成独立通道 ID `plugin:<pluginId>:<route>`；模型定义增加 `pluginId/channelId/source/readonly/inputModalities/outputModalities`；新增 `listPluginChannels` 返回通道名、插件归属、模型数、`settingsNs/settingsPath`、是否可配置、是否有模型探测 |
| `packages/server/src/plugin-models.ts` | 新增 `registerPluginConfigurableProviders`（通道显示名与设置归属）、`registerPluginModelDiscovery`（插件自己的模型探测回调）、`refreshPluginChannel`（先执行探测，再重读 adapter 的 `listModels`） |
| `packages/server/src/plugin-host.ts` | `llm.registerAdapter / registerConfigurableProviders / registerModelDiscovery` 都按插件实例 ID 写入注册表；`llm.listProviders` 合并插件通道，`llm.listModels` 对 `plugin:` 通道返回该通道模型 |
| `packages/server/src/routes/console.ts` | `GET /api/console/providers` 在 DB 供应商后追加插件通道（`kind:'plugin'`、`source:'plugin'`、`readonly:true`）；`GET /api/console/models` 追加 `listPluginModels`，映射成 `providerId=channelId`、`providerKind:'plugin'`、`source:'plugin'`、`readonly:true` 的只读模型；新增 `POST /api/console/plugin-channels/:id/refresh` |
| `packages/server/public/app.js` + `app.css` | 供应商表识别插件行：显示“插件托管 / 已注入 / 插件注入”，隐藏测试连接、检测模型、编辑、启停、删除，只保留“刷新模型”；模型表识别 `readonly`：隐藏压测、编辑、启停、删除，能力按钮改为只读展示；新增“刷新模型”调用插件探测接口；只有存在可写 DB 供应商时才渲染“添加模型”，插件模型的能力标签同时参与顶部“图片识别 / 模型类型”统计；用途路由过滤只读插件模型并说明未开放绑定 |

### 15.3 真实服务验证

- 重启后 `GET /api/console/providers` 返回 3 条插件通道：
  - `dsh-mrrp / mrrp`，1 个模型，无 configurable，无 discovery
  - `dsh-our-free-model / our-free-model`，22 个模型，`configurable=true`、`discovery=true`，`settingsNs=dsh-our-free-model`
  - `dsh-our-free-model / our-free-model-region`，1 个模型
- `GET /api/console/models` 返回 24 个 `source=plugin` 的只读模型；例如 `plugin:mrrp:route`、`plugin:our-free-model:deepseek-v4.1-flash-free`、`plugin:our-free-model-region:beam-free`；插件模型 `tags` 已合并 adapter 能力，顶部统计显示“图片识别 7、模型类型 2”。
- `POST /api/console/plugin-channels/:id/refresh` 对 `plugin:dsh-our-free-model:our-free-model` 返回 `{ models: 22 }`，刷新后控制台目录保持 24 个插件模型；控制台页面点击首条通道的刷新按钮后，模型数保持 24，未出现错误提示。
- `npx tsc -p tsconfig.json --noEmit` 通过；`pnpm test` 56 个测试文件、307 个用例通过；`node --check packages/server/public/app.js` 通过。

### 15.4 边界与未完成项

- 插件模型不写 `models` 表，因此不能进入 `model_routes` 的显式用途绑定：`model_routes.model_id` 对 `models(id)` 有外键。当前控制台把插件模型标为只读并从用途路由候选里过滤，自动兜底和对话手动选择仍可用；如果后续要支持显式绑定，需要独立的持久化表或改路由解析。
- 插件通道模型数依赖 adapter 异步 `listModels`，刚安装或刚刷新时可能短暂为 0；控制台“刷新模型”会重新读取。
- 控制台真实页面已验收：模型目录 24/24，每行带“插件”角标和“插件注入 · 只读”，操作列“随插件启停”；供应商与端点 3 条插件通道，只保留刷新图标；无 DB 供应商时“添加模型”按钮不渲染；顶部“0 个端点 · 3 个插件通道”“24 / 24 个”“图片识别 7”。
- 控制台插件 iframe 自动 `inject` URL 在重启后的点击回归仍未重做；本轮只验证模型接入页。

## 16. 对话侧模型切换实施记录（2026-11-11）

需求与验收细则见 [EAB 对话模型切换需求](EAB对话模型切换需求.md)。本节只记录本轮落点和真实服务结果。

### 16.1 实现

- 新增迁移 `0041_chat_session_model.sql`，`chat_sessions.model_id` 记录会话级模型偏好；`NULL` 表示自动选择，`plugin:` 模型可直接保存，不建 `models` 外键。
- `GET /api/chat/sessions/:id/messages` 返回 `session.modelId`。
- 新增 `POST /api/chat/sessions/:id/model`：校验 `chat:use`、`model:use`，只接受 `visibleModelsFor` 结果中的模型；`modelId: null` 表示恢复自动。
- `POST /api/chat/messages` 增加会话模型解析：显式模型优先；显式 `null` 清空偏好；未传时读取会话偏好，模型失效则回退自动并清空。
- `chat.js` 增加 `/model`、`/auto` 与“切换到 / 切换模型到 / 换成 / 使用 … 模型”等对话命令；候选列表只来自 `/api/chat/models`；切换成功后写入当前会话并即时显示提示。
- 刷新或重新打开会话时恢复该会话模型；原模型已不可见时提示并回退自动选择，不显示无权模型名称。
- 输入框占位与底部提示加入 `/model` 指引。

### 16.2 真实服务验证

- 对话页输入 `/model` 展示“可用模型（24）”，列表包含 `MRRP 智能路由`、`MiMo V2.6 Flash`、`Deepseek V4 1 Flash Free` 等插件模型。
- 输入 `/model MiMo` 与“切换到 MiMo V2.6 Flash”均切换成功，chip 变为 `MiMo V2.6 Flash`，对话内出现切换提示。
- 切换后 `chat_sessions.model_id` 写入 `plugin:our-free-model:mimo-v2.6-flash-free`；刷新页面后 chip 仍恢复为 `MiMo V2.6 Flash`。
- 使用该插件模型发送“你好”，请求进入插件 adapter，上游返回免费额度用尽，页面显示 `EAB_UPSTREAM`；确认插件模型已参与真实对话链路，未绕过插件路由。
- 输入 `/auto` 后 `chat_sessions.model_id` 清空为 `NULL`，chip 回到自动选择。
- `npx tsc -p tsconfig.json --noEmit` 通过；`node --check packages/server/public/chat.js` 通过；`pnpm test` 56 个测试文件、307 个用例通过。

### 16.3 渠道机器人对话模型切换（2026-11-11 追加）

- 新增 `packages/server/src/channel-model-command.ts`：渠道无关的纯文本命令解析与可见模型匹配，后续飞书/企微入站可直接复用。
- 钉钉 `handleDingTalkMessage` 在额度校验前拦截 `/model`、`/auto`、`切换到 …` 等命令；命令不建 AI 卡片、不调用 `runAgentTurn`、不扣月度额度。
- 命令候选只来自 `loadModelCatalog + visibleModelsFor`，并先校验 `chat:use`、`model:use`；无权/不存在统一提示，不展示未授权模型名。
- 普通钉钉消息读取 `chat_sessions.model_id`：仍可见则使用，模型下线/角色不可见则清空并回退自动；图片消息额外校验视觉能力。
- 切换命令写入当前钉钉会话的 `chat_sessions.model_id`，同一员工再次对话继续沿用。
- 隔离真实库副本集成验证：注册测试插件模型 `MiMo 测试模型` 后，`/model` 返回命令文本；`/model MiMo 测试模型` 写入 `plugin:%2Fapi%2Fchannel-test:mimo-test`；`/auto` 清空为 `NULL`；`/model Top Secret` 不泄露无权模型名。
- 同一隔离库继续发普通消息“你好”，`chat_messages` 的用户与助手记录均使用 `plugin:%2Fapi%2Fchannel-test:mimo-test`，助手正文来自测试插件 adapter，证明渠道普通消息确实按会话模型选择并进入插件调用链。
- `npx tsc -p tsconfig.json --noEmit` 通过；`pnpm test` 57 个测试文件、314 个用例通过（新增 7 个渠道命令用例）。
- 尚未向真实钉钉客户端发送消息；渠道侧验证使用隔离库 + 真实入站函数完成，外部钉钉网络回调未计入本轮证据。

### 16.4 插件模型健康检测与故障转移（2026-11-11 追加）

- 新增 `packages/server/src/model-health.ts`：进程内健康表、错误分类、最短请求探测、定时探测（默认 30 分钟、15 秒超时、首轮立即执行）。
- `loadModelCatalog` 对插件模型执行 `filterHealthyModels`：探测失败的插件模型从对话候选隐藏，但不影响控制台只读展示和插件启停；真实调用成功后恢复。
- `runAgentTurn` 增加 `fallbackModelIds`、`bufferModelEvents`、`onModelFailover` 和 `usedModelId / usedModelName / fallbackFromModelId`：
  - 机器人渠道开启缓冲，失败模型的半截 content/reasoning 丢弃，接替模型成功后一次性下发；
  - 网页不缓冲，失败前没有输出才重试，避免拼接两个模型的半截回答；
  - 所有候选失败且候选数大于 1 时抛“当前有权限的模型都暂时无法回复，请稍后再试。”。
- 钉钉渠道的备用列表来自当前员工可见模型，图片消息只放行有视觉能力的模型；接替成功后助手消息、审计、渠道事件和会话 `model_id` 使用实际 `effectiveModel`。
- 网页 `POST /api/chat/messages` 同样接入备用列表；`done` 增加 `fallbackFromModelId`，前端在固定模型被接替时同步模型 chip。
- `main.ts` 在 DSH 插件宿主启动后启动健康监控，关闭时停止。
- 新增单测：`test/model-health.test.ts`（健康过滤、错误分类、真实插件 adapter 探测）、`test/model-failover.test.ts`（半截失败丢弃、备用接替、全部失败聚合错误）。
- 验证结果：`npx tsc -p tsconfig.json --noEmit` 通过；`test/model-health.test.ts` 3 个用例通过、`test/model-failover.test.ts` 2 个用例通过；全量 `pnpm test` 59 个测试文件、319 个用例通过。
- 已重启真实服务（`node scripts/eab.mjs stop` 后 `node scripts/eab.mjs server --background`）并等待首轮探测完成：`GET /api/chat/models`（控制台会话）从 24 个插件模型降为 10–12 个（两次首轮探测观察值）；同一时刻 `GET /api/console/models` 仍为 24 个，证明健康过滤只作用于对话候选，不影响控制台模型目录。被过滤的数量以首轮真实探测结果为准，后续恢复健康的模型会重新出现。




