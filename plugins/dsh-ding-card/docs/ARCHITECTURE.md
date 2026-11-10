# 架构说明

## 为什么复用 dsh-im 的 Stream 连接

钉钉 Stream 模式对同一个应用是**竞争消费**：一条事件只会投递给其中一个客户端。若 dsh-ding-card 另开一条连接：

- 用户发给机器人的普通消息可能被本插件消费，dsh-im 收不到；
- 卡片按钮回调也可能只到其中一条连接。

因此本插件不创建连接，而是在 dsh-im 已经注册的 `DWClient` 上追加一个
EventEmitter 监听器：

```js
DWClient.prototype.registerCallbackListener = function (topic, callback) {
  const result = original.call(this, topic, callback);
  if (topic === '/v1.0/card/instances/callback') {
    this.on(topic, ourHandler); // dsh-im 的监听器照常工作
  }
  return result;
};
```

dsh-im 收到回调后会先 `socketCallBackResponse` 确认，再按自己的 `outTrackId`
处理；未知 `outTrackId` 会被忽略。我们的监听器并行运行，用自己生成的
`outTrackId`（`dsh_card_<uuid>`）匹配待处理卡片。

原型在插件模块加载时就被替换，因此插件要排在 dsh-im **之前**加载。若 dsh-im
已经连接后才启用插件，需要重启 DSH。

## 卡片库与导出

配置 v2 把卡片从三个固定槽位改成数组：

```json
{
  "cards": [{
    "id": "card_xxx",
    "name": "计划确认",
    "type": "message",
    "templateId": "....schema",
    "design": {
      "title": "${title}",
      "content": "${content}",
      "fields": [{ "label": "环境", "value": "${env}" }],
      "showButtons": true,
      "maxOptions": 4
    }
  }]
}
```

`lib/export.js` 以 `assets/im-template-base.json`（官方审批卡片）和
`assets/standard-template-base.json`（官方标准卡片）为骨架，克隆其中的
`Card`/`BaseText`/`ButtonList` 或 `StdCard`/`Markdown`/`ButtonBlock` 节点，
替换文案、变量与按钮后输出 `{ type, mode, editorData, widgetInfo }`。这样
导出文件沿用官方组件 schema，导入钉钉卡片平台后与设计器预览保持一致。

通讯录/工作台/日程三种类型目前也输出 `type: "im"` 结构，因为 dsh-im 会话
只能投放消息/标准/吊顶卡片；它们的设计与导出仍可用。

## Agent 选卡片

`lib/tools.js` 注册两个工具：

- `ding_card_list`：列出卡片名称、类型、说明、是否绑定模板。
- `ding_card_send`：按名称/id 选择卡片，填充标题/正文/选项/字段/图片后投放。

工具通过 `exec.agent.session.id` 走与会话应答器相同的 `routing.js` 解析，
因此只有在钉钉来源的会话中才能发送。系统提示词会带上卡片目录和用途说明。
`ding_card_send` 发出的卡片按钮只做展示；需要等待答案时使用
`ask_user_question`，它会自动走卡片应答器。

## 交互应答器

DSH 的 `@deepseek-ai/dsh-user-questions` 与 `@deepseek-ai/dsh-user-approval`
通过 Cordis waterfall 分发：

- `user-questions/request`
- `approval/request`

插件注册 `user-questions/request`、`approval/request` 两个 `prepend` 应答器。
Cordis 的 waterfall 会通过 `next()` 继续调用下游监听器，因此无论插件排在
dsh-im 之前还是之后，两个表面都会运行；处理流程与 dsh-im 的 IM 适配器一致：

1. 把 `request.signal` 换成卡片自己的生命周期控制器；
2. 并行调用 `next()`（Web / 原生界面）与卡片；
3. 任意一方先答即结算；
4. 卡片先答时 abort 本地控制器，让 Web 卡片收起；
5. 原生先答时向钉钉卡片写入「已完成」并关闭吊顶。

问题只处理「单题、有选项、非多选、无 `intent`」的批次；其余直接 `next()`，
保持 DSH 原有交互。

## 会话 → 钉钉会话

dsh-im 在 `$DSH_HOME/integrations/dsh-dingtalk/bots/<botId>/state.json` 里保存
`conversationKey → sessionId`。插件反查：

- `p2p:<staffId>` → 单聊，投递到 `IM_ROBOT.<staffId>`
- `group:<conversationId>` → 群聊，投递到 `IM_GROUP.<conversationId>`

目标与 dsh-im 的 `cardDeliverBody` 保持一致。插件每 1.5 秒最多重读一次状态，
避免每次提问都扫描磁盘。

## 凭据

dsh-im 的 `config.json` 只保存 `clientId` 与 `secretRef`。插件用
`ctx.credentials.resolve(secretRef)` 读取密钥，不落盘、不写进自己的配置。

## 渲染

客户端面板是一个普通 DSH client 插件，使用
`sidebar.panellist` + `main` + `plugins.detail.actions` 三个插槽，样式全部走
`--dsw-alias-*` 主题变量，因此浅色 / 深色主题一致。面板通过
`/api/dsh-ding-card` RPC 读写配置与触发测试。

## 已知取舍

- dsh-im 仍会发送自己的提问文本，形成「文本 + 卡片」双表面；这是它的原生
  兜底，插件无法在不修改 dsh-im 的前提下关闭。
- 审批超时交回原生；若没有原生应答器，审批保持等待。
- 吊顶卡片依赖钉钉会话能力，错误只记录日志，不影响消息卡片。
