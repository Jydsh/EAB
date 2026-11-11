# EAB 复用 DSH 插件协议与三渠道统一接入改造方案

> 状态：方案待确认，本轮不改代码。
> 目标：EAB 不再要求插件“适配 EAB”，而是让 EAB 成为 DSH 插件协议的兼容宿主；同时把钉钉、飞书、企业微信的“企业一键绑定”统一成同一套扫码 + 手工双入口。
> 事实依据：本仓库当前代码，以及 dsh-im 5.10.0 的插件源码。方案里区分“已实现”“待改造”“平台能力边界”，不把愿景写成已落地。

---

## 一、需求理解

这一轮要同时解决四件事，且它们不是四个独立功能，而是同一条链路上的四层：

1. **插件协议同一套**
   - DSH 插件按 `package.json` 的 `dsh` 段声明 host/client 入口、slot、依赖服务。
   - EAB 要按同一套协议加载、激活、渲染、清理插件；插件源码不需要为 EAB 另写一套。
   - 判断标准不是“能安装”，而是“安装后 host 能启动、client 能渲染、RPC 能通、停用能清理、缺能力有明确状态”。

2. **钉钉不再发 EAB 开场白**
   - 扫码绑定、手工绑定、插件绑定三条路径都不再由 EAB 发送“你好，我是 EAB 企业智能助手……”这类开场白。
   - 保留钉钉平台原生欢迎语；不再尝试改平台侧文案，也不追究那条 OpenClaw 文案归属。
   - 需要删掉的不只是发送函数，还包括控制台里的“欢迎语接收人 UserID”字段、成功提示里的“欢迎语已发送”、以及手工/扫码两处调用点。

3. **飞书、企业微信和钉钉一样有扫码 + 手工双入口**
   - 三个渠道共用同一个“企业一键绑定”弹窗：同一套分段切换、二维码区、状态区、错误区、按钮位置。
   - 扫码和手工只是同一绑定的两种取凭据方式，最终都落到同一套 `channel_configs` 写入、租户确认、首次通讯录同步。
   - 不再出现“钉钉是完整绑定，飞书/企业微信只是先配置接入”的分裂体验。

4. **插件绑定机器人要能反哺 EAB**
   - 插件里扫码/手工绑定机器人后，EAB 的渠道配置和通讯录要自动跟着更新。
   - 这条链路本轮已经跑通钉钉；方案要把它抽成通用能力，后续飞书、企业微信同样适用，而不是只给钉钉写死。

---

## 二、结论先行

### 2.1 建议的技术路线

- **插件侧**：把 EAB 现有的“DSH 兼容宿主”补成完整协议面，重点是 host `ctx` 服务、`effect` 生命周期、`webServer`、`sessions/settings` 适配，以及 client runtime 的 slot/settings/模块 shim。插件安装时补依赖安装和健康检查。
- **渠道侧**：新增一个与 UI 无关的 `ChannelOnboardingService`，内部用 `dingtalk / feishu / wecom` 三个 adapter；路由、状态机、错误码、前端弹窗全部统一。
- **钉钉欢迎语**：直接删除 EAB 自建欢迎语的发送链路，不做开关；平台原生欢迎语保持不动。
- **数据**：`channel_configs` 继续做“组织接入”的权威配置；企业微信扫码得到的智能机器人凭据单独存 `bot_id + bot_secret_ref`，不和组织通讯录凭据混在一列。

### 2.2 企业微信的口径：机器人与组织是两套凭据

本期按已确认的口径实现：**企业微信先做“智能机器人”的扫码 + 手工绑定**，飞书本期一并支持扫码 + 手工。

企业微信扫码走的是：

```text
GET https://work.weixin.qq.com/ai/qc/generate
GET https://work.weixin.qq.com/ai/qc/query_result?scode=...
```

扫码成功返回的是：

```json
{
  "status": "success",
  "bot_info": {
    "botid": "...",
    "secret": "..."
  }
}
```

这正是企业微信智能机器人的凭据，所以扫码/手工绑定机器人都可以直接做，不需要 corpId。

但要区分另一件事：EAB 现在的 `fetchWecomOrg()` 需要的是：

```text
corpId + corpSecret -> /cgi-bin/gettoken -> /cgi-bin/department/list + /cgi-bin/user/list
```

这是**企业自建应用**的通讯录凭据，和机器人 `botid + secret` 不是同一套。因此：

- 企业微信机器人：扫码和手工都支持，本期必须落地。
- 企业微信组织通讯录：纳入本期必做范围，作为“企业应用接入”能力单独做；需要 corpId + 通讯录 Secret，不能用机器人 Secret 代替。
- UI 上必须把“机器人已绑定”和“企业通讯录已同步”分成两个状态，不把前者冒充后者。

飞书不同：dsh-im 的飞书扫码走 `@larksuiteoapi/node-sdk` 的 `registerApp`，成功返回 `client_id / client_secret / user_info`，这本身就是飞书应用凭据，可以作为 EAB 的 `appId/appSecret` 使用；通讯录能否读到，取决于新应用是否拿到通讯录权限。本期按中国版飞书实现，Lark 国际版作为可选项。

---

## 三、现状与差距

### 3.1 插件协议：已经有的

- `packages/server/src/plugins.ts` 已能识别 DSH 插件：
  - `package.json.dsh`
  - `dsh.bundle.patch`
  - `dsh.client.entry` / `exports["./client"]` / `lib/client.js`
  - host 入口从 `main` / `exports["."]` / `lib/index.js` 解析
  - `dsh.client.platform` 只接受 `web`
  - `dsh.compatibility.dsh` 做基础版本判断
- `packages/server/src/plugin-host.ts` 已给 dsh-im 补了：
  - `connection.fetch.register`
  - `credentials`（resolve/set/unset）
  - `typertGateway`（invoke/stream）
  - `tools`、`systemPrompt`
  - `on/off/once/emit` 内存事件
  - `provide/get/inject`
- `packages/server/public/dsh-runtime.js` 已能：
  - 处理 `window.__ModuleLoader__.load`
  - 提供 React / slots / locale / connection.rpc
  - 执行 `ctx.effect`（client 侧已修好）
  - 渲染 `main` 与 `settings.section`

### 3.2 插件协议：还缺的

**Host 侧（影响插件真正运行）**

| 缺口 | 当前事实 | 影响 |
|---|---|---|
| `ctx.effect` 只存不跑 | `plugin-host.ts` 里 `disposers.push(fn)`，从不执行 `fn()` | 插件在 `effect` 里注册的 `webServer` 路由、清理动作、事件订阅都不会生效 |
| 没有 `ctx.webServer` | 只有 `connection.fetch.register` | dsh-im 的 `/api/dsh-im/delivery/messages` 这类投递路由注册不了 |
| 没有 `ctx.sessions` | dsh-im 的 session title、会话投影会读它 | 相关增强功能静默不生效 |
| 没有 `sessionController / workspaceController` | dsh-im `ctx.inject([...], activate)` 依赖这两个服务 | 严格按 DSH 语义会一直等不到服务，插件不激活 |
| 没有 `settings` | dsh-im host-language 用 `ctx.inject(['settings'])` 读语言偏好 | 语言/设置类能力退化 |
| 没有 `speechToText` / `agents` / `pluginManager` | 插件有可选分支 | 语音、Agent 协调、插件自更新会降级 |
| `inject` 不等待服务 | 当前直接回调，缺服务也照跑 | 插件以为服务存在，运行时才报错；或者反过来永远不激活 |
| `cordis.patch.yml` 只校验存在 | 没有解析/应用 patch | 插件声明的配置、插入项没有进入 host 配置 |
| 版本兼容只支持 `=` / `>=` | 不支持 `^`、`~`、区间 | 一些 DSH 插件会被误判不兼容 |

**Client 侧（影响插件页面）**

| 缺口 | 当前事实 | 影响 |
|---|---|---|
| 只渲染 `main` / `settings.section` | `dsh-runtime.js` 的 Shell 只取这两个槽 | `sidebar.panellist`、`plugins.detail.actions` 注册了但看不见 |
| `ctx.inject(['settings'])` 没有 settings 对象 | 回调子上下文只补 slots/locale/connection/layout | 插件读设置会拿到 undefined |
| `requireModule` 对 DSH 内部包返回 `{}` | `@deepseek-ai/dsh-client-*` 全部空对象 | 依赖这些包导出的插件会在 `apply` 阶段报错或渲染空白 |
| 没有 `--dsw-alias-*` 主题变量 | 只靠 CSS `var()` fallback | 插件样式颜色/间距可能缺失 |
| `boot()` 不等待异步 `apply` | `exports.apply(makeContext())` 同步调用 | 异步初始化的 client 插件会在完成前被当作已加载 |

### 3.3 插件安装与依赖：会反复丢

- `packages/server/src/plugins.ts` 安装时只拷文件，`COPY_SKIP` 跳过 `node_modules`，不执行 `npm install`。
- dsh-im 曾经因为缺 `@tencent-connect/qqbot-nodejs` 启动失败；补装后重启又消失过一次。
- 这会导致“插件能装上，但 host 起不来”，而且报错藏在插件内部，不像安装失败那样直观。

### 3.4 钉钉欢迎语：调用点已经定位

当前 EAB 自建欢迎语链路：

- `packages/server/src/dingtalk-bot.ts`
  - `buildDingTalkWelcome(companyName, chatUrl)`
  - `sendDingTalkWelcome(deps, userId, companyName, chatUrl)`
- `packages/server/src/routes/admin.ts`
  - `POST /api/console/companies/onboard-dingtalk` 手工绑定后调用
  - `POST /api/console/dingtalk/onboard/poll` 扫码成功后调用
  - 入参 `welcomeUserId`、返回 `welcomeSent`
- `packages/server/public/app.js`
  - `openDingTalkOnboard()` 里的“欢迎语接收人 UserID”字段
  - 成功提示“欢迎语已发送”
  - 说明文案“绑定后 EAB 自己发欢迎语”

用户已经明确：这些全部不要，改用钉钉原生欢迎语，不再追究平台那条文案。

### 3.5 渠道接入：当前是“钉钉完整、飞书/企微半套”

- 钉钉：
  - `POST /api/console/companies/onboard-dingtalk`：手工建公司 + 绑定 + 同步。
  - `POST /api/console/dingtalk/onboard/start|poll`：扫码设备码。
  - `POST /api/console/channels/dingtalk/bind`：已有公司的手工/扫码绑定 + 首次同步。
  - 控制台 `openDingTalkOnboard()` 有“扫码绑定 / 手工填凭证”双入口。
- 飞书、企业微信：
  - `POST /api/console/channels/:provider` 只保存表单，不确认租户、不首次同步。
  - `GET /api/console/channels/:provider/sync` 可单独同步，但要求先保存过凭证。
  - 控制台的“扫码绑定”走 `POST /api/channel/bind/start`，返回的是 `eab://channel/bind?...` 占位二维码，真实渠道没有接入；只有开发模式能“模拟扫码”。
  - `bindingCard()` 里非钉钉未绑定时，要么“先配置接入”，要么“扫码绑定”占位；绑定后只有“解绑”，没有“重新绑定”。

### 3.6 组织同步：能力已具备，但入口不统一

- `packages/channel/src/providers.ts`
  - `fetchFeishuOrg` / `fetchDingTalkOrg` / `fetchWecomOrg` 都已实现。
- `packages/channel/src/map-org.ts`
  - `mapRemoteOrg` 已支持 `provider` 与 `rootChannelDeptIds`，飞书根是 `0`，钉钉/企微根是 `1`。
- `packages/channel/src/apply.ts`
  - `applyOrgSync` 已能写部门/成员、生成 diff、处理孤儿。
- 缺的是：
  - 飞书没有 `fetchFeishuTenant`，绑定时没有统一的“租户名”来源。
  - 企业微信没有 `fetchWecomTenant`，只能拿 corpId 当显示名。
  - 三个渠道没有统一的 `bind + first sync` 服务，钉钉那套逻辑写死在 `console.ts`。
  - 钉钉插件桥 `syncDingTalkOrg` 只针对钉钉，飞书/企微的插件绑定没有对应桥。

---

## 四、目标设计

### 4.1 DSH 插件协议兼容层

目标不是“再写一个 EAB 插件格式”，而是让 EAB 成为 DSH Host 的一个实现。分三层：

#### A. Host 协议层

在 `plugin-host.ts` 里把 `ctx` 补成以下服务面：

```text
logger
connection.fetch.register
credentials.resolve/set/unset
typertGateway.invoke/stream
tools.register
systemPrompt.context/add/section
sessions.list/get/append?
settings.get/set/observe?
webServer.register
sessionController（最小适配）
workspaceController（最小适配）
speechToText（可选，缺失时明确 unavailable）
agents（可选）
pluginManager（可选）
```

生命周期必须按 Cordis/DSH 语义：

- `effect(fn, label)`：
  - 立即执行 `fn()`；
  - 返回函数 → 作为 disposer；
  - 返回 `{ dispose }` → 包装成 disposer；
  - 异常只告警，不阻断插件启动；
  - 返回幂等 dispose；
  - 插件停用/卸载时按注册顺序反向执行。
- `inject(keys, callback)`：
  - 先查服务注册表；
  - 全部就绪 → 调用；
  - 缺失但属于 EAB 明确降级的可选服务 → 以 `undefined` 调用并写兼容日志；
  - 缺失且属于核心服务 → 挂起，等 `provide` 后再调用，避免插件在服务不存在时启动。
- `provide(key, value)`：写入服务表，并唤醒等待该 key 的 `inject`。
- `root`：子上下文共享 `root`，插件用 `ctx.root` 判断同一 Host。

`webServer.register` 与 `connection.fetch.register` 共用一张路由表：

- 只允许 `/api/...`，继续拒绝保留前缀；
- `kind: exact|prefix` 支持；
- `effect` 返回的 dispose 从路由表删除；
- 现有 `dispatchPluginRpc` 的 `method` 反推逻辑保持不变。

#### B. Client 协议层

在 `dsh-runtime.js` 里补齐：

- `boot()` 支持 `apply` 返回 Promise：`await` 后再标记 loaded；失败落到 `onError`，不吞掉。
- `requireModule`：
  - `react` / `react-dom` 保持真模块；
  - `@deepseek-ai/dsh-client-connection` → `{ rpc, fetch }`
  - `@deepseek-ai/dsh-client-runtime` → 最小 runtime 上下文
  - `@deepseek-ai/dsh-client-ui-slots` → `{ register, list, inject }`
  - `@deepseek-ai/dsh-client-ui-settings` → `{ settings }`
  - `@deepseek-ai/dsh-client-locale` → locale
  - 未知包返回一个 Proxy：属性访问返回 no-op 函数/空对象，并写一次 `module-shim` 日志，而不是直接 `{}` 让插件解构报错。
- `ctx.inject(['settings'])` 时给子上下文补 `settings`：
  - `get(namespace)` 读 EAB 插件设置；
  - `observe` 订阅变更；
  - 命名空间按插件 id 隔离。
- Shell 渲染：
  - `main`、`settings.section` 保持；
  - 新增 `sidebar.panellist`：渲染到插件页左侧/侧栏列表，点击切换 panel；
  - 新增 `plugins.detail.actions`：渲染到插件详情卡片的操作区；
  - 其他槽位先登记，未知槽位记录到 `slot-report`，不静默丢弃。
- 在 `plugin-host.html` / `chat.css` 里定义 `--dsw-alias-*` 主题变量，至少覆盖背景、文本、边框、主色、圆角、间距，避免插件 CSS 全靠 fallback。

#### C. 兼容判定与健康检查

`GET /api/console/plugins/:id/host` 的返回从 `{loaded,error,routes,logs}` 扩展为：

```json
{
  "health": {
    "manifest": "ok|error",
    "host": "ok|error|missing-entry",
    "client": "ok|error|missing-entry",
    "dependencies": "ok|missing|not-installed",
    "context": "ok|degraded",
    "missingServices": ["speechToText"],
    "slots": ["main", "sidebar.panellist"],
    "routes": 20
  }
}
```

- `dependencies` 检查插件 `package.json` 的 `dependencies` 是否能在插件目录解析；缺失不算安装失败，但控制台要显示“缺依赖，host 可能起不来”。
- 版本兼容：把 `dsh.compatibility.dsh` 的判断从 `=`/`>=` 扩展为 `^`、`~`、`>=x.y.z <x.y.z` 的常用子集；不认识的写法标 `unknown`，不直接判失败。
- `cordis.patch.yml`：
  - 解析 `insert` 里的插件 id/name/config；
  - 只应用 EAB 认识的字段；
  - 不认识的字段保留并写入兼容日志，不阻断加载。

### 4.2 渠道统一开通服务

#### 统一接口

新增 `packages/channel/src/onboarding/`，定义：

```ts
type OnboardProvider = 'dingtalk' | 'feishu' | 'wecom'

interface ChannelOnboardingAdapter {
  provider: OnboardProvider
  startScan(input): Promise<ScanStart>
  pollScan(attemptId): Promise<ScanPoll>
  cancelScan(attemptId): Promise<void>
  bindManual(input): Promise<BindResult>
}
```

`ScanStart`：

```ts
{
  attemptId: string
  state: 'qr_ready' | 'starting'
  qr: { imageUrl?: string; content?: string }
  expiresAt: number
  pollIntervalMs: number
  instructions?: string[]
}
```

`ScanPoll`：

```ts
{
  state: 'starting' | 'qr_ready' | 'polling' | 'slow_down' | 'saving'
       | 'succeeded' | 'expired' | 'cancelled' | 'error'
  tenant?: { id: string; name: string }
  binding?: { boundAt: number }
  sync?: { departments: number; members: number; stats?: unknown }
  error?: { code: string; message: string; retryable?: boolean }
  needs?: Array<'wecom-corp-credentials'>
}
```

`BindResult`：

```ts
{
  binding: { tenantId: string; tenantName: string }
  sync: { departments: number; members: number; stats?: unknown; warning?: string }
}
```

#### 三个 adapter

**DingTalk**

- 扫码：复用现有 `startDingTalkRegistration` / `pollDingTalkRegistration`，适配成统一状态。
- 手工：复用现有 `/api/console/channels/dingtalk/bind` 的验凭证 + 读根部门 + 写绑定 + 同步逻辑。
- 删除欢迎语发送；绑定结果不再返回 `welcomeSent`。
- 扫码落地页仍可能进入 OpenClaw 生态；UI 保留“优先选已有普通机器人”的提示，但不承诺改平台欢迎语。

**Feishu**

- 扫码：
  - 使用 `@larksuiteoapi/node-sdk@1.73.0` 的 `registerApp`（与 dsh-im 同款）；
  - `onQRCodeReady({ url, expireIn })` → `qr_ready`；
  - `onStatusChange({ status, interval })` → `polling/slow_down`；
  - 成功 `{ client_id, client_secret, user_info }`；
  - `user_info.tenant_brand === 'lark'` 时记 `domain='lark'`，否则 `feishu`；
  - 写 `secret_ref` 前先 `verifyApp`：换 `tenant_access_token`，读 `/open-apis/bot/v3/info` 拿应用名；
  - 绑定 `tenant_id = client_id`，`tenant_name = bot.app_name || client_id`；
  - 首次同步调用 EAB 的 `fetchFeishuOrg`；权限不足时保留绑定，返回 `sync.warning` 和权限申请链接。
- 手工：
  - 字段：`App ID`、`App Secret`、可选 `domain`（飞书/Lark）；
  - 与扫码共用 `verifyFeishuApp` + `bindFeishu` + `syncFeishuOrg`。
- 现有 EAB `fetchFeishuOrg` 只走 `open.feishu.cn`；如启用 Lark，需要把 origin 参数化，属 P1 可选项。

**WeCom**

- 扫码（机器人）：
  - `GET https://work.weixin.qq.com/ai/qc/generate?source=eab&plat=2` → `{ scode, auth_url }`；
  - `GET .../query_result?scode=` → `waiting|success|expired|failed`；
  - 成功拿到 `bot_info.botid / bot_info.secret`；
  - 写 `bot_id` + `bot_secret_ref`（机器人凭据），**不写** `app_id/corp_id`；
  - 绑定状态 `bot_bound`；UI 明确显示“机器人已绑定”，不宣称组织已同步。
- 手工（机器人）：
  - 字段：`Bot ID`、`Secret`；
  - 与扫码共用 `bindWecomBot`，只写 `bot_id + bot_secret_ref`。
- 组织通讯录（可选，独立入口）：
  - 字段：`企业 ID (corpId)`、`通讯录 Secret`、可选 `AgentId`；
  - `gettoken` 验证 → `department/get?id=1` 读企业名 → 写 `corp_id/app_id/secret_ref` → `fetchWecomOrg` → `applyOrgSync`；
  - 成功后状态 `bot_org_synced`；失败不回滚机器人绑定，只标记“组织同步失败，可重试”。

#### 统一绑定写库

所有 adapter 最终调用同一个 `bindChannel()`，由 `syncPolicy` 决定是否做首次组织同步：

1. 校验 provider + 输入；
2. 验凭据（provider 各自；WeCom 机器人没有可用的在线验凭据接口时，只做格式校验并标记“待插件连接验证”）；
3. 读租户/机器人信息：
   - DingTalk：`fetchDingTalkTenant`；
   - Feishu：`verifyFeishuApp`；
   - WeCom 机器人：`bot_info`，不需要 corpId；
   - WeCom 组织：`fetchWecomTenant`；
4. `storeSecret` 写 `secrets.json`；
5. 写 `channel_configs`：
   - `provider`
   - `app_id`（DingTalk/Feishu/WeCom 组织）
   - `corp_id`（DingTalk/WeCom 组织）
   - `secret_ref`（组织应用凭据）
   - `bot_id` / `bot_secret_ref`（机器人凭据，WeCom 必填）
   - `status='bound'` 或 `bot_bound`（WeCom 仅机器人）
   - `enabled=1`
   - `sync_mode`：有组织同步时为 `daily`，仅机器人时为 `off`
   - `tenant_id` / `tenant_name`
   - `bound_at` / `bound_by_user_id`
   - `bind_mode='scan'|'manual'`
6. `syncPolicy='required'`（DingTalk/Feishu）才做首次同步：
   `fetchChannelOrg` → `mapRemoteOrg` → `applyOrgSync`；
7. `syncPolicy='none'`（WeCom 机器人）不拉通讯录，只写机器人绑定；
8. `syncPolicy='optional'`（WeCom 组织）由独立接口触发，失败不回滚机器人绑定；
9. 写 `last_synced_at` / `last_sync_run_id` / `last_sync_status`；
10. 同步失败不回滚绑定，返回 `sync.warning`，渠道卡显示“已绑定 / 同步失败，可重试”。

### 4.3 数据模型

建议新增一个迁移（编号按现有顺序）：

```sql
ALTER TABLE channel_configs ADD COLUMN bind_mode TEXT;
ALTER TABLE channel_configs ADD COLUMN bot_id TEXT;
ALTER TABLE channel_configs ADD COLUMN bot_secret_ref TEXT;
ALTER TABLE channel_configs ADD COLUMN last_sync_status TEXT;
ALTER TABLE channel_configs ADD COLUMN last_sync_error TEXT;

ALTER TABLE channel_bind_sessions ADD COLUMN provider_state TEXT;
ALTER TABLE channel_bind_sessions ADD COLUMN poll_interval_ms INTEGER;
ALTER TABLE channel_bind_sessions ADD COLUMN remote_attempt_id TEXT;
ALTER TABLE channel_bind_sessions ADD COLUMN meta_json TEXT;
```

说明：

- `bot_id/bot_secret_ref` 只给“智能机器人”凭据用，尤其企业微信扫码；不和组织应用凭据混用。
- `bind_mode` 只用于审计/展示，不改变 `sync_mode` 语义。
- `last_sync_status/error` 让“绑定成功但同步失败”可恢复，不用只靠日志。
- `channel_bind_sessions` 继续承载飞书/企业微信的扫码会话；DingTalk 继续用 `dingtalk_onboard_attempts`，由 adapter 转换成统一状态，避免大迁移。
- 所有密钥只写 `secrets.json`，DB 只存 `secret_ref`。

### 4.4 统一 UI

把 `app.js` 里现有 `openDingTalkOnboard()` 抽成：

```text
openChannelOnboard(provider, options)
  ├─ 头部：{渠道} · 一键绑定并同步
  ├─ 分段：扫码绑定 | 手工填凭证
  ├─ 扫码面板
  │   ├─ 二维码/占位
  │   ├─ 倒计时 + 状态
  │   ├─ 步骤说明（provider 不同）
  │   ├─ 刷新二维码 / 取消
  │   └─ 成功后同步结果
  ├─ 手工面板
  │   ├─ provider 字段
  │   ├─ 绑定前确认（权限/发布/回调）
  │   └─ 绑定并同步
  └─ 统一状态：idle/starting/qr_ready/polling/slow_down/saving/succeeded/error/expired/cancelled
```

统一规则：

- 主操作按钮放左侧（绑定/刷新），取消/关闭放右侧。
- 说明性长文案收进 `hintBadge`，不在弹窗里堆常驻说明。
- 扫码和手工共用同一套错误展示：`message + hint + 权限链接/发布链接`。
- 非钉钉渠道不再有“先配置接入”这个中间态；未绑定直接“一键绑定”。
- 已绑定渠道操作变为：`重新绑定`、`立即同步`、`解绑`。
- 企业微信扫码/手工成功后先显示“机器人已绑定”；“企业通讯录”是同一卡片里的可选二级动作，不强迫补 corpId。
- 企业微信的“组织未同步”不能写成“绑定失败”；两者是不同状态。
- 删除“模拟扫码（开发预览）”按钮；开发环境用测试 adapter，不在生产 UI 出现。

渠道卡片状态建议：

```text
unconfigured -> 未接入
scan_pending -> 扫码中
bound_sync_ok -> 已绑定 · 通讯录已同步（钉钉/飞书）
bound_sync_warn -> 已绑定 · 通讯录待补权限（钉钉/飞书）
bot_bound -> 机器人已绑定 · 组织未同步（企业微信）
bot_org_synced -> 机器人已绑定 · 通讯录已同步（企业微信）
bot_error -> 机器人连接失败/凭据失效
error -> 绑定失败/凭证失效
```

---

## 五、详细改造清单

### P0-1 Host 协议补齐

文件：`packages/server/src/plugin-host.ts`

1. 新增 `executeEffect(instance, fn, label)`：
   - 立即执行；
   - 收集 disposer；
   - 返回幂等 dispose；
   - `disposeAll()` 反向执行并清空。
2. `makeContext()` 增加：
   - `webServer = { register }`，复用 `register` 路由表；
   - `sessions`：`list()` / `get(id)`，先接 `chat_sessions`，无事件时返回最小对象；
   - `settings`：按插件 id 命名空间读写 `companies.settings_json` 的 `plugins.<id>`；
   - `sessionController` / `workspaceController`：最小对象，至少提供 `get/list/create`，不支持的调用返回明确错误；
   - `speechToText`：先提供 `{ available:false }`，不要 undefined；
   - `agents` / `pluginManager`：可选，`get()` 返回 undefined 不报错。
3. `inject` 改为服务就绪判断 + 等待队列；核心服务由 EAB 先 `services.set`，保证 dsh-im 的 `inject(['sessionController','workspaceController'])` 不会挂起。
4. `effect` 在插件停用/卸载时执行 disposer；失败只告警。
5. `cordis.patch.yml` 解析：支持 `insert[].id/name/config`，合并到 `apply(ctx, config)` 的第二参。
6. 版本兼容支持 `^` / `~` / 简单区间。

验收：dsh-im host 启动后 `routes` 保持 20 条；`/api/dsh-im/delivery/messages` 这类路由能注册；停用插件后路由消失、定时器/订阅清理。

### P0-2 Client 协议补齐

文件：`packages/server/public/dsh-runtime.js`、`packages/server/public/plugin-host.html`、`packages/server/public/chat.css`

1. `boot()` 异步化：`await apply`，失败写 `onError`，不把未完成当成功。
2. `requireModule` 增加 DSH 内部包 shim 与未知包 Proxy。
3. `ctx.inject(['settings'])` 补 `settings`。
4. Shell 渲染 `sidebar.panellist`、`plugins.detail.actions`。
5. 定义 `--dsw-alias-*` 主题变量。
6. 增加 `slot-report` 到 host 状态，显示注册了但未渲染的槽。

验收：dsh-im 插件页 15 个 `style[data-plugin-css]` 保持；`sidebar.panellist` 可见；`plugins.detail.actions` 在插件详情卡片可见；未知槽不静默消失。

### P0-3 插件安装与健康检查

文件：`packages/server/src/plugins.ts`、`packages/server/src/routes/plugins.ts`

1. 安装/更新后，若插件根有 `package.json` 且有 `dependencies`：
   - 执行 `npm install --omit=dev --ignore-scripts --no-audit --no-fund`；
   - 超时/失败不阻断安装，写 `health.dependencies`；
   - 永不执行 lifecycle scripts。
2. 安装/更新不删除已有 `node_modules`，成功后再替换目录；失败保留旧目录。
3. 健康检查增加：
   - manifest；
   - host/client 入口文件；
   - 依赖解析；
   - host `apply` 是否成功；
   - client bundle 是否可 boot；
   - 注册槽与路由。
4. 继续保留“不限插件包大小/文件数”的既有口径，不在安装环节加尺寸闸门。

验收：301 文件 / 70MB 包仍可安装；dsh-im 重装/重启后 `node_modules` 不再消失；缺依赖的插件在控制台显示“缺依赖”，而不是只报 host 启动失败。

### P0-4 删除 EAB 钉钉欢迎语

文件：

- `packages/server/src/dingtalk-bot.ts`
- `packages/server/src/routes/admin.ts`
- `packages/server/public/app.js`
- `packages/server/test/dingtalk-welcome.test.ts`
- `packages/server/test/dingtalk-manual-bind.test.ts`（如断言 `welcomeSent`）

改动：

1. 删除 `buildDingTalkWelcome` / `sendDingTalkWelcome`，或至少删除全部调用点并标记 deprecated；建议直接删，避免以后误用。
2. `onboard-dingtalk`：
   - 删除 `welcomeUserId` 入参；
   - 删除 `sendDingTalkWelcome` 调用；
   - 删除返回里的 `welcomeSent`；
   - `publicChatUrl` 若只服务于欢迎语，一并删除。
3. 扫码 poll 成功分支：
   - 删除 `sendDingTalkWelcome` 调用；
   - 成功结果不再有欢迎语字段。
4. `openDingTalkOnboard()`：
   - 删除“欢迎语接收人 UserID”字段；
   - 删除“绑定后 EAB 自己发欢迎语”的提示；
   - 删除“欢迎语已发送”的成功提示；
   - 改为“绑定后使用钉钉原生欢迎语，EAB 不再发送开场白”。
5. 测试：
   - 删除欢迎语测试；
   - 手工绑定测试只断言绑定/同步，不再断言欢迎语。

验收：全仓 grep `buildDingTalkWelcome`、`sendDingTalkWelcome`、`welcomeUserId`、`welcomeSent` 无生产调用；扫码/手工绑定都不发 EAB 文本。

### P1-1 渠道统一开通后端

新增文件：

```text
packages/channel/src/onboarding/types.ts
packages/channel/src/onboarding/dingtalk.ts
packages/channel/src/onboarding/feishu.ts
packages/channel/src/onboarding/wecom.ts
packages/channel/src/onboarding/index.ts
packages/server/src/channel-onboarding.ts
```

职责：

- `types.ts`：状态机、错误码、`ScanStart/ScanPoll/BindResult`，以及 `syncPolicy: 'required' | 'optional' | 'none'`。
- `dingtalk.ts`：包装现有 `startDingTalkRegistration` / `pollDingTalkRegistration` / `bindDingTalk`；`syncPolicy='required'`。
- `feishu.ts`：`registerApp` + `verifyFeishuApp` + `bindFeishu` + `syncFeishuOrg`；`syncPolicy='required'`。
- `wecom.ts`：`WecomQrAuth` + `bindWecomBot`（扫码/手工，`syncPolicy='none'`）+ 可选的 `bindWecomOrg` / `syncWecomOrg`。
- `channel-onboarding.ts`：统一 `bindChannel()`，处理 secrets、DB、可选首次同步、错误映射；只有 `syncPolicy='required'` 的渠道把“首次同步失败”作为绑定结果里的 warning，而不是回滚绑定。

路由（新增，旧路由保留兼容）：

```text
POST /api/console/channels/:provider/onboard/start
GET  /api/console/channels/:provider/onboard/:attemptId
POST /api/console/channels/:provider/onboard/:attemptId/cancel
POST /api/console/channels/:provider/onboard/manual
POST /api/console/channels/:provider/onboard/wecom-corp
```

旧的：

```text
POST /api/console/channels/dingtalk/bind
POST /api/console/dingtalk/onboard/start|poll
POST /api/channel/bind/start
```

保留为兼容包装，内部转到新 service；前端不再调用旧的 mock 扫码。

### P1-2 飞书 adapter

1. `packages/channel/package.json` 增加 `@larksuiteoapi/node-sdk@1.73.0`（生产依赖，不能只放 devDependencies）。
2. `feishu.ts` 复用 dsh-im 的 `RegistrationManager` 逻辑，或抽取等价实现：
   - `start()` 不阻塞长轮询；
   - `status()` 返回状态机；
   - `cancel()` abort；
   - 成功只把 secret 交给回调，不放进状态快照。
3. `verifyFeishuApp`：
   - `tenant_access_token`；
   - `/open-apis/bot/v3/info`；
   - 返回 `name/openId`。
4. `bindFeishu`：
   - `app_id/app_secret/domain`；
   - `tenant_id=appId`，`tenant_name=bot.app_name || appId`。
5. `syncFeishuOrg`：
   - 复用 `fetchFeishuOrg`；
   - `rootChannelDeptIds=['0']`；
   - 权限错误映射为 `feishu-scope-missing`，返回申请链接。
6. 手工/扫码共用同一 `bindChannel()`，`syncPolicy='required'`。

### P1-3 企业微信 adapter

本期先做“智能机器人”，组织通讯录作为可选能力，不阻塞机器人绑定。

1. `wecom.ts` 的 `WecomQrAuth` 参考 dsh-im：
   - `generate` / `query_result`；
   - `source=eab`、`plat` 按平台；
   - QR TTL 5 分钟、poll 3 秒；
   - 只接受 `https://work.weixin.qq.com/...` 的 `auth_url`。
2. 扫码成功：
   - 从 `bot_info` 取 `botid` / `secret`；
   - 存 `bot_id` + `bot_secret_ref`；
   - 绑定状态写 `bot_bound`；
   - 不要求 corpId，也不假装组织已同步。
3. 手工绑定机器人：
   - 字段：`Bot ID`、`Secret`；
   - 做格式校验，存 `bot_id` + `bot_secret_ref`；
   - 没有可用的平台“验 bot”接口时，状态标“已保存，待插件连接验证”，不要声称已验证在线。
4. 组织通讯录（可选，独立入口）：
   - `POST /api/console/channels/wecom/onboard/wecom-org`；
   - 字段：`corpId` + `通讯录 Secret` + 可选 `agentId`；
   - `fetchWecomTenant`（`department/get?id=1` 取企业名）；
   - `fetchWecomOrg` + `mapRemoteOrg(rootChannelDeptIds=['1'])`；
   - 成功后状态写 `bot_org_synced`；失败不回滚机器人绑定。
5. 状态必须能区分：
   - `bot_bound`：机器人已绑定，组织未同步；
   - `bot_org_synced`：机器人 + 组织都已就绪；
   - `bot_error`：机器人凭据失效/连接失败。

### P1-4 前端统一弹窗

文件：`packages/server/public/app.js`（必要时 `chat.css`）

1. 把 `openDingTalkOnboard()` 拆成 `openChannelOnboard(provider)` + provider 配置表。
2. 配置表：

```js
const CHANNEL_ONBOARD_UI = {
  dingtalk: { scan: true, manual: true, manualFields: [...], syncPolicy: 'required' },
  feishu: { scan: true, manual: true, manualFields: [...], syncPolicy: 'required' },
  wecom: { scan: true, manual: true, manualFields: ['botId', 'secret'], syncPolicy: 'none', orgSync: true },
}
```

3. `bindingCard()`：
   - 未绑定：`一键绑定`；
   - 已绑定（钉钉/飞书）：`重新绑定` + `立即同步` + `解绑`；
   - 已绑定（企业微信机器人）：`重新绑定` + `企业通讯录（可选）` + `解绑`；
4. 删除 `data-bind` 的 mock 扫码路径；统一走 `data-onboard`。
5. 所有状态文案走同一套：`开始扫码 → 等待扫码 → 扫码成功，正在保存 → 完成/失败`；钉钉/飞书多一段“正在同步通讯录”，企业微信机器人不显示这一段。
6. 角标使用现有 `hintBadge`，保证 hover/focus/触控可见。

### P2 验证与测试

1. **单元测试**
   - `packages/channel/test/onboarding-*.test.ts`：
     - 状态机流转；
     - 过期/取消/错误码；
     - 不把 secret 写进状态/日志；
     - WeCom 扫码只返回 bot 凭据、不误写 corp 凭据。
2. **路由测试**
   - 统一 start/poll/cancel/manual；
   - 旧路由兼容；
   - 未登录/无权限拒绝；
   - 绑定成功但同步失败时，绑定保留、状态可重试。
3. **插件协议测试**
   - dsh-im host 启动、20 条路由、14 渠道状态；
   - 新 fixture 插件测试 `effect`、`webServer`、`sessions`、`settings`、`sidebar.panellist`、`plugins.detail.actions`；
   - 停用插件后路由/定时器清理。
4. **浏览器验收**
   - 三个渠道的扫码/手工两个 tab；
   - 二维码过期、刷新、取消；
   - 企业微信 `bot_bound` 状态；可选组织同步单独验证；
   - 飞书权限不足的提示与重试；
   - 非钉钉绑定后“重新绑定/立即同步/解绑”。
5. **真实渠道 smoke**
   - 钉钉：现有应用手工绑定 + 扫码绑定，确认无 EAB 欢迎语；
   - 飞书：测试企业应用扫码/手工，确认 `tenant_access_token` 与通讯录权限；
   - 企业微信：扫码绑机器人、手工填 Bot ID/Secret 绑机器人；组织同步作为可选入口单独验证。
   - 外部平台需要真实管理员扫码/授权，不能只靠 mock。

---

## 六、验收标准

### 插件协议

- [ ] 一个只声明 `package.json.dsh` 的插件，不改代码即可安装、启用、打开页面。
- [ ] host `apply` 成功，`ctx.effect` 内注册的路由和清理动作实际执行。
- [ ] client 页面样式正常，`main` / `settings.section` / `sidebar.panellist` / `plugins.detail.actions` 按声明渲染。
- [ ] 插件停用/卸载后，路由、定时器、事件订阅、样式全部清理。
- [ ] 缺依赖/缺服务时，控制台显示明确健康状态，不是静默失败。
- [ ] dsh-im 14 个渠道 `connection.status` 全部 200，无 `TypeError` / `gateway` 报错。

### 钉钉欢迎语

- [ ] 扫码绑定后，EAB 不发送任何开场白。
- [ ] 手工绑定后，EAB 不发送任何开场白。
- [ ] 控制台没有“欢迎语接收人”字段和“欢迎语已发送”提示。
- [ ] 平台原生欢迎语不受 EAB 影响；EAB 不调用平台欢迎语修改接口。

### 渠道绑定

- [ ] 钉钉、飞书、企业微信三个渠道都有“扫码绑定 / 手工填凭证”两个入口。
- [ ] 三个渠道使用同一套弹窗结构、状态文案、错误展示、按钮位置。
- [ ] 钉钉/飞书扫码和手工最终写同一套 `channel_configs`，并触发首次通讯录同步。
- [ ] 企业微信扫码和手工都能绑定机器人；只写 `bot_id/bot_secret_ref`，不强制 corpId。
- [ ] 企业微信明确区分“机器人已绑定”和“组织已同步”；不把 Bot Secret 当 corpSecret 用。
- [ ] 绑定成功但同步失败时，绑定保留，渠道卡可重试。

---

## 七、风险与待拍板

### 7.1 已确认的口径

1. **企业微信机器人**：扫码 + 手工都要支持；凭据是 `botid + secret`，不要求 corpId。
2. **飞书**：本期支持，扫码 + 手工都要有；按中国版飞书实现。

### 7.2 仍需确认

1. **企业微信组织通讯录是否纳入本期**
   - 方案默认：机器人绑定是主能力；组织通讯录作为可选二级入口，用 `corpId + 通讯录 Secret` 单独接入。
   - 如果本期就要企业微信组织自动同步，需要把 `POST .../wecom-org` 和 `fetchWecomTenant` 一起排进 P1；机器人绑定本身不受影响。

2. **飞书是否支持 Lark 国际版**
   - 当前 EAB 的 `fetchFeishuOrg` 只走 `open.feishu.cn`。
   - 如果只做中国飞书，`domain` 可以不暴露；如果要和 dsh-im 一样支持 Lark，需要把 API origin 参数化，属额外改造。

3. **插件兼容的目标等级**
   - 方案按“DSH 协议面完整 + EAB 核心服务适配 + 不支持的 DSH 专有能力显式降级”执行。
   - 不建议承诺“任何 DSH 插件零差异”，因为沙箱、DSH 内部 Agent 调度、部分客户端组件没有等价实现；这些应显示为“降级/不支持”，而不是静默坏掉。

### 7.3 技术风险

- 飞书 `registerApp` 创建的新应用不一定自动带通讯录权限；扫码成功不等于能同步组织，必须把权限不足做成可恢复状态。
- 企业微信机器人 Secret 只适用于机器人长连接，不能用于 `fetchWecomOrg`；组织同步必须另配企业应用凭据。
- 钉钉扫码落地页仍可能进入 OpenClaw 生态，平台原生欢迎语不由 EAB 控制；用户已明确不再追究，方案不再尝试改平台文案。
- 插件依赖安装会拉长安装时间、受网络影响；必须异步、可失败、可重试，不能拖垮安装接口。
- `secrets.json` 是唯一明文落点；DB、日志、错误响应、插件状态快照都不能带 secret。
- 现有未提交改动较多，实施时要按文件分批提交，不能把既有“本地空间移除”等改动混进本轮。

### 7.4 不做的事

- 不新建一套 EAB 插件协议；DSH 插件继续按原 `package.json.dsh` 加载。
- 不自动修改钉钉平台欢迎语。
- 不把企业微信智能机器人 Secret 当企业应用 Secret。
- 不在本轮接 `session.prompt` / `commands.execute` 到 EAB `runAgentTurn`；这是插件消息真正跑 Agent 的下一阶段，和本次“绑定 + 同步 + 协议兼容”分开。
- 不自动 commit / push GitHub，按用户偏好，推送前单独确认。

---

## 八、建议实施顺序

1. **P0 插件协议底座**：`effect`、`webServer`、`sessions/settings`、`inject`、client runtime、依赖安装、健康检查。
2. **P0 钉钉欢迎语删除**：小改动、独立验证，先切断 EAB 开场白。
3. **P1 渠道统一服务**：`ChannelOnboardingService` + 三个 adapter + 迁移。
4. **P1 前端统一弹窗**：替换钉钉专用弹窗与非钉钉 mock 扫码。
5. **P1 真实渠道 smoke**：钉钉 → 飞书 → 企业微信，逐渠道验收。
6. **P2 兼容性回归**：dsh-im + 新 fixture 插件 + 停用清理 + 浏览器槽位。

每阶段独立可回滚；数据库迁移先加列、不删列，旧路由保留包装，避免一次性切换导致现有钉钉绑定失效。

---

## 九、实施记录（2026-11-11）

### 9.1 已落地

- **插件协议底座**：`plugin-host.ts` 补齐 `effect` 立即执行与幂等清理、`webServer.register`、`sessions` / `settings` / `sessionController` / `workspaceController` / `speechToText`、`inject` 缺服务排队与 `provide` 后唤醒；`dsh-runtime.js` 补齐 DSH client 模块 shim、`settings`、`sidebar.panellist`、`plugins.detail.actions`、异步 `boot()`。
- **钉钉开场白**：`buildDingTalkWelcome` / `sendDingTalkWelcome` 及调用点、控制台字段、测试全部删除；绑定后只用钉钉原生欢迎语。
- **渠道统一开通**：新增 `0040_channel_onboarding.sql`，`channel_configs` 增加 `bot_id` / `bot_secret_ref` / `bind_mode` / `last_sync_status` / `last_sync_error`，`channel_bind_sessions` 增加 `meta_json`；新增 `packages/channel/src/onboarding.ts`，实现企微扫码 `startWecomScan` / `pollWecomScan` 与飞书应用校验 `verifyFeishuApp`。
- **控制台接口**：新增 `POST /api/console/channels/:provider/onboard/start`、`GET .../onboard/:sessionId`、`POST .../onboard/manual`、`POST .../org`；飞书扫码复用 dsh-im `provision.begin/poll`，企微扫码走企业微信二维码接口；手工绑定时先通过插件 `bind-credentials` / `bot.bind-credentials` 把机器人交给插件，再由 EAB 保存组织通讯录凭据并同步。
- **前端**：控制台「企业一键绑定」对飞书、企业微信统一提供「扫码绑定 / 手工绑定」双入口；已绑定的飞书 / 企微可再进「配置组织/凭据」；说明文案统一，不再写“后续接入”。
- **网关桥**：新增 `dispatchPluginWeb()` 与 `ALL /api/console/plugins/:id/gateway/*`，控制台会话下可把请求转发到插件 `webServer` 注册的任意 `/api/*` 路由；已用 dsh-im 的 `/api/dsh-im/delivery/messages` 实测（插件返回 400 `bad-request`，证明路由已贯通）。`dispatchPluginRpc()` 继续负责渠道 RPC（`provision.*` / `bot.bind-credentials` / `connection.status`）。
- **企业微信组织通讯录**：按必做实现。扫码或手工先得到机器人；同一卡片内补 `CorpId + 通讯录 Secret` 后调用 `/org`，再执行 `fetchWecomOrg → mapRemoteOrg → applyOrgSync`。机器人凭据与通讯录凭据分列保存，互不替代。
- **无插件回退（双路兼容）**：飞书扫码不再依赖 dsh-im。插件可用时走插件 `provision.begin/poll`；插件未安装、未启用或 host 未运行时，EAB 直接调用飞书开放平台 `accounts.feishu.cn/oauth/v1/app/registration` 的设备注册流程，返回 `client_id/client_secret` 后自己保存凭据并同步组织。手工绑定同理：插件可用时先写插件，不可用时只落 EAB，绑定不失败。企业微信扫码/手工本来就不依赖插件。

### 9.2 实测结果

- `npx tsc -p tsconfig.json --noEmit`：exit 0。
- `pnpm test`：55 个测试文件 / 304 个用例全绿（含飞书原生扫码测试与 `ctx.inject(['connection'])` 回归测试）。
- dsh-im 5.10.0 重新装回并补齐生产依赖后：host `loaded=true`、`routes=21`，包含 `/api/dsh-im/delivery/messages`。
- 飞书扫码：`onboard/start` 返回 `sessionId`、`qrImageUrl`、`verificationUrl`，轮询返回 `waiting`。
- 企业微信扫码：`onboard/start` 返回 `qrImageUrl`，轮询可进入等待；扫码只返回机器人凭据，组织同步仍需 CorpId + CorpSecret。
- 飞书手工：无效 App ID/Secret 返回 `EAB_UPSTREAM` 校验失败；企业微信手工会先写插件再落 EAB 绑定。
- 网关桥：`POST /api/console/plugins/xmanrui-dsh-im/gateway/api/dsh-im/delivery/messages` 已到达插件路由并返回插件自己的 400 报文。
- 无插件：卸载 dsh-im 后，飞书扫码 `onboard/start` 返回原生 launcher 二维码，轮询 `waiting`；企业微信手工绑定返回 200 且不再报插件 host 未运行。飞书手工无效凭据仍按原生校验返回 502。
- 钉卡片识别渠道机器人：`POST /api/console/plugins/dsh-ding-card/rpc` 返回 `dshim.installed=true`、`bots=[dingjifmu37srsrlci8r]`、`bot.source=dsh-im`、`secretReady=true`、`stream.connected=true`；`bot.check` 返回 `ok=true`，插件事件记录“钉钉应用凭据校验通过”。

### 9.3 未验证与边界

- 飞书扫码走通“真实扫码授权 → `connected` → 写绑定”需要真实飞书账号；本轮只验证到 `waiting`。
- 企业微信扫码真实授权同样未完成；扫码成功后的组织同步需要企业通讯录凭据，未用真实企业验证。
- 控制台新弹窗已通过语法检查与后端接口验证，但未在登录态浏览器里逐项点选；登录态属于用户会话，未代填。
- `session.prompt` / `commands.execute` 仍未接 EAB Agent 执行面；本轮只到“插件绑定机器人 + EAB 同步组织 + 网关路由贯通”。

### 9.4 钉卡片读不到渠道机器人的根因与修复（2026-11-11）

- 现象：插件页报“插件 dsh-ding-card 没有注册通道 /api/dsh-ding-card”，同时显示 dsh-im 未安装、钉钉机器人未绑定、Client ID 为空。但 EAB 的 `channel_configs` 里钉钉机器人 `dingjifmu37srsrlci8r` 已绑定，兼容树 `.eab-dev/dsh-home/integrations/dsh-dingtalk/config.json` 也已有该机器人。
- 根因：`dsh-ding-card` 用 `ctx.inject(['connection'], cb)` 注册管理 RPC。宿主 `makeContext` 只把 `connection` 挂在 `ctx.connection` 上，没有登记进 `inject` 判断用的 `services` 表，回调永远不执行，`/api/dsh-ding-card` 未注册。客户端拿不到 status，于是全量回退成“未安装/未绑定/未知 profile”。
- 修复：`packages/server/src/plugin-host.ts` 在构造 `connection` 后执行 `services.set('connection', connection)`，让 `ctx.inject(['connection'])` 立即命中。重启后 host 日志出现 `DSH 路由已挂载：POST /api/dsh-ding-card`，`routes=['/api/dsh-ding-card']`。
- 验证：插件 RPC status 已识别 dsh-im `5.10.0-eab.1`（web profile）、机器人 `dingjifmu37srsrlci8r`、`stream.connected=true`；`bot.check` 通过钉钉接口校验。
- 关联边界：`dsh-ding-card` 不直接读 EAB `channel_configs`，而是读兼容层按 dsh-im 落盘协议生成的 `.eab-dev/dsh-home/integrations/dsh-dingtalk/config.json`。因此机器人识别依赖 `prepareDshImCompat` 在 host 启动前执行；本次已确认该文件包含渠道机器人。