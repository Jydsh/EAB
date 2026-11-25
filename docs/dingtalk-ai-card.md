# 钉钉 AI 卡片：思考/工具过程折叠

## 结论

EAB 私聊回复默认走新版 A2UI JSON 卡片，保留思考/工具折叠入口；
只有 A2UI 建卡失败时才回退 dsh-im 同款模板卡（`02fcf2f4-...schema`）。

思考与工具入口已经对齐网页 DSH 风格，不再使用旧文案：

| 阶段 | 思考标题 | 工具标题 |
|---|---|---|
| 进行中 | `思考中` | `工具调用中` |
| 完成且有耗时 | `已思考 3.2s` | `工具` |
| 完成但没有耗时（历史卡） | `思考` | `工具` |

两个入口默认收起，**收起态严格只有一行**：

```text
已思考 1.3s · 用户问我现在有什么能力，这是一个能力概述问题… ›
工具 · org.directory · 320ms ›
```

不再使用 `CollapsiblePanel`。公开 Catalog 的 `CollapsiblePanel.title` 只接受
string，且收起时不渲染 children；把预览放在面板外又会变成“标题一行 + 预览一行”。
现在改为一个自定义 `Text` 头部，把标题、首句/摘要和箭头全部放进同一个
`/thinking/header` 或 `/tools/header` 数据路径，再用 `onLinkClick` 触发点击。
展开后的完整思维链/工具明细由头部下方的 `Markdown` 承载，`visible` 绑定
`/ui/thinkingExpanded` 或 `/ui/toolsExpanded`。

外层 `Card` 仍然是钉钉 A2UI 卡片容器，无法像网页那样完全去掉容器观感；
这是客户端卡片平台的边界，不是组件树还能再拆掉的部分。

## 设计要点

- 思考/工具入口是 `Text`，`maxLine: 1`，`variant: caption`，浅/深色都用中性灰；
  标题、首句、箭头在同一个字符串里，客户端不会再拆成两行。
- 思考流式输出时头部带 `textEffect: shimmer`，只让这一行文字流光，不碰正文；
  正文开始即代表思考阶段结束，头部切为 `已思考 X.Xs` 并移除 shimmer。
- 工具面板只在真的有工具记录时显示。运行中头部 `工具调用中` 并带 shimmer；
  工具结束后头部切为 `工具` 并移除流光，不等整轮回答结束。
- 展开态由用户点击头部触发：`Text.onLinkClick` 上报
  `eab_panel_toggle`，context 带 `action=panel_toggle`、`panel=thinking|tools`、
  `sessionId`。回调只更新一条数据路径，不重建整张卡。
- 工具明细不是只有工具名，而是完整链路：工具名、执行中/完成/失败、耗时、
  参数、结果/错误。参数和结果在写入数据模型前做长度截断。
- 根 `Card` 使用 `backgroundColorToken: 'common_bg_color'` 跟随客户端主题，
  不再写死白底；避免桌面端出现灰边白卡。
- 会话列表外层摘要引用机器人回复正文：
  - 建卡时回答还没生成，先用中性品牌文案 `EAB 企业智能助手` 占位；
  - 收口后通过 `PUT /v1.0/card/instances/spaces` 的 `lastMessageI18n`
    把摘要替换成回答正文；失败只记日志，不影响卡片收口。

实现文件：`packages/server/src/dingtalk-card.ts`（`DingTalkAICardStream`、
`richCardComponents`、`buildDingTalkA2UICreateMessages`、
`buildDingTalkA2UIUpdateMessages`）与 `packages/server/src/dingtalk-bot.ts`
（每轮计时、最终状态写入、`handleDingTalkCardCallback` 的面板切换分支）。
完整消息示例：`docs/dingtalk-ai-card.example.json`。

## 数据路径映射

| 业务变量 | A2UI 数据路径 | 组件 |
|---|---|---|
| 思考单行入口 | `/thinking/header` | `thinkingHeader`（`Text`，`maxLine: 1`） |
| 思考完整内容 | `/thinking/text` | `thinkingBody`（`Markdown`，`visible: /ui/thinkingExpanded`） |
| 工具单行入口 | `/tools/header` | `toolHeader`（`Text`，`maxLine: 1`） |
| 工具完整内容 | `/tools/text` | `toolBody`（`Markdown`，`visible: /ui/toolsExpanded`） |
| 回答正文 | `/answer` | `answerBlocks` / `answerUnitN` |
| 是否显示思考 | `/ui/showThinking` | `thinkingBlock.visible` |
| 是否展开思考 | `/ui/thinkingExpanded` | `thinkingBody.visible` |
| 是否显示工具 | `/ui/showTools` | `toolBlock.visible` |
| 是否展开工具 | `/ui/toolsExpanded` | `toolBody.visible` |

组件树顺序：`rootColumn` → `thinkingBlock`（`thinkingHeader` + `thinkingBody`）
→ `toolBlock`（`toolHeader` + `toolBody`）→ `answerRow` → `clarifyBlock` →
`attachmentBlock`。

`thinkingHeader` / `toolHeader` 是唯一的收起态入口；`thinkingBody` / `toolBody`
只有在对应的 `/ui/*Expanded` 为 true 时才渲染。

## 图表映射与协议边界

钉钉公开图表协议只有 `lineChart` / `histogram` / `pieChart` 三种，A2UI `Chart`
组件消费的也是这同一套变量（官方协议见
<https://open.dingtalk.com/document/development/chart-variable>）。EAB 的图表清单以
`packages/domain/src/chart-catalog.ts` 为唯一数据源。**渠道能力分开计算，不能把
“协议里有类型”当成“原图能正常显示”**：

- **网页对话 17 种**：`pie`、`doughnut`、`bar`、`horizontalBar`、`line`、
  `area`、`scatter`、`radar`、`polarArea`、`bubble`、`stackedBar`、
  `groupedBar`、`rose`、`gauge`、`funnel`、`heatmap`、`waterfall`；
  每种都有独立 SVG renderer。
- **钉钉消息 7 种**：只保留 `dingtalk.fidelity=native` 且能保持原形的类型。
  清单外的类型不再画近似图，卡片正文会提示“请到网页端查看”。

| 钉钉可用图表 | 钉钉类型 | 映射方式 |
|---|---|---|
| `pie` | `pieChart` | 原生饼图，超过 6 项合并“其他” |
| `bar` | `histogram` | 原生纵向柱 |
| `horizontalBar` | `histogram` + `rotate:true` | 原生柱旋转成横向 |
| `line` | `lineChart` | 原生折线；双轴拆成左/右两张 |
| `scatter` | `lineChart` + `lineShape:'dot'` | 只画点不连线，和散点同形 |
| `stackedBar` | `histogram` + `stack:true` | 原生堆叠柱 |
| `groupedBar` | `histogram` | 多系列 `type` 原生分组 |

以下 10 种只在网页端提供，不在钉钉端宣称可用：`doughnut`（无环形挖空）、
`area`（无面积填充）、`radar`（无雷达几何）、`polarArea`、`bubble`（无气泡
大小维度）、`rose`、`gauge`、`funnel`、`heatmap`、`waterfall`。此前把它们
降级成饼图/柱图会在客户端变成“另一种图”，看起来像显示成功，实际是错误信息，
因此按真实能力收紧。

**块数预算也要优先保图表**：A2UI 正文只有 24 个块槽位。超预算时，文字和表格
可以合并压缩，图表不能被压成“图表已省略”或清空 `chart` 引用；实现会先给每张
图表留槽，再压缩其余正文。

**2026-11-25 验收记录**：网页真实会话单轮输出 17 种图表，页面实际出现 17 个
`.answer-chart`（每个都有 SVG，无“图表生成中”残留）；钉钉单聊发送“7 种原生
图表自检卡”（`cardId=eab_a2ui_136dc5c277c14631aeb64c1f5dac76da`），卡片创建
与收口成功，7 个图表块都在 24 块预算内。`GET /api/charts/catalog?channel=web`
返回 17，`channel=dingtalk` 返回 7；全量 252 个测试文件 / 1570 个用例通过。

### Agent 如何知道有哪些图表

- `chartCatalogPrompt(channel)` 按渠道生成数据回合清单；`chartCatalogSummary(channel)`
  给非数据回合一行摘要。网页 chat 传 `web`，钉钉 bot 传 `dingtalk`。
- `GET /api/charts/catalog?channel=web|dingtalk` 返回对应渠道清单和 `total`；
  不传 `channel` 默认网页全量。
- 新增图表时：先在目录加一条 `enabled=true` 并设置真实 `dingtalk.fidelity`；
  只有 `native` 才会进入钉钉清单。Agent 提示词、数量、API 会自动同步。
- 测试 `packages/domain/test/chart-catalog.test.ts` 校验 17 种、7 种钉钉子集与
  渠道提示词；`packages/server/test/chart-catalog.test.ts` 校验目录示例在网页
  渲染结构、钉钉原生映射，以及降级类型在 `nativeOnly` 下被拒绝。

## 点击回调与展开态

`Text.onLinkClick` 是基础协议里的 `Action`，钉钉当前实现为“点击 `Text` 节点任意
位置”触发，不区分文本内部位置。头部组件下发：

```json
{
  "id": "thinkingHeader",
  "component": "Text",
  "text": { "path": "/thinking/header" },
  "maxLine": 1,
  "onLinkClick": {
    "event": {
      "name": "eab_panel_toggle",
      "context": {
        "action": "panel_toggle",
        "panel": "thinking",
        "sessionId": "chat_xxx"
      }
    }
  }
}
```

回调处理：

1. 从 `outTrackId + externalId` 反查 `channel_turns`，得到 `session_id`、
   `card_kind`；只有 `card_kind='a2ui'` 且 `session_id` 与回传值一致才接受。
2. 用进程内 `Map<outTrackId:panel, expanded>` 翻转展开态；服务端不持久化，
   避免用户点开后下一帧流式更新又把它收回。
3. 调用 `DingTalkAICardStream.togglePanel(outTrackId, panel, expanded)`，
   只发一条 `updateDataModel`：
   - `/ui/thinkingExpanded` 或 `/ui/toolsExpanded`
   - `flowStatus: FINISH`
4. 不回写整份 `ui` 对象；`buildDingTalkA2UIUpdateMessages` 现在逐项更新
   `/ui/*` 字段，所以服务端的 `false` 不会覆盖客户端刚点开的 `true`。

## 预览规则

思考预览取首行/首句，不再取最后 120 字：

- 首行以 `。！？!?` 结尾时，直接作为完整句子；
- 首行是不足 24 字的短碎片时，才并上下一行；
- 超过 96 字截断并追加 `…`；
- 流式阶段只有 `reasoning` 还没有内容时，预览显示
  `正在分析你的问题…`；正文开始后替换成首句；
- 头部最终形如 `已思考 3.2s · 首句… ›`。

工具摘要：

- 有工具正在执行：`当前工具名 · 执行中`；
- 没有 `toolDetails` 但已记录工具名：执行中显示最后工具名，完成后显示 `N 个`；
- 单个工具完成：`工具名 · 320ms`，失败追加 `· 失败`；
- 多个工具完成：`N 个 · 总耗时`，有失败追加 `· N 个失败`；
- 耗时小于 1 秒用 `320ms`，否则用 `1.2s`；思考标题始终用 `X.Xs`；
- 头部最终形如 `工具 · org.directory · 320ms ›`。

工具链路统一写成编号列表，每条形如：

```text
1. **org.directory** · 完成 · 320ms
   参数：{"query":"部门"}
   结果：找到 3 个部门
```

参数和结果分别截断到 360 个字符，避免单次工具输出把卡片撑爆。

处理中：

- 纯思考阶段：`showThinking=true`、`thinkingExpanded=false`；
  头部 `思考中 · 首句… ›` 带 shimmer。
- 真正有工具在跑时：`showThinking=true`、`showTools=true`；
  思考头部保持 `思考中`，工具头部为 `工具调用中 · … ›` 并带 shimmer。
  工具执行不再把思考入口隐藏，也不再提前把思考标题切成完成态。
- 正文开始或收口时，`thinkingDone=true`：
  思考头部切为 `已思考 X.Xs` 并移除 shimmer；工具结束则切为 `工具` 并移除 shimmer。
- 没有工具调用就不会出现工具入口，也不会用 `等待工具调用…` 占位。

完成：思考头部为 `已思考 X.Xs`（无耗时历史卡为 `思考`），工具头部为 `工具`；
两个入口的摘要仍保留；默认仍收起（`thinkingExpanded=false`、`toolsExpanded=false`）。
没有思考内容时隐藏思考入口，没有工具调用时隐藏工具入口。

## 思考耗时

- `dingtalk-bot.ts` 在每轮开始时记录 `turnStartedAt`；
- 首次收到 `reasoning` 事件时记录 `thinkingStartedAt`；
- 首次收到 `content` 事件时结算
  `thinkingMs = Date.now() - thinkingStartedAt`；
- 模型故障转移清空思考/工具状态时，三个计时变量一起重置；
- 最终 `finalState` 写入 `thinkingMs`，A2UI 头部据此显示 `已思考 X.Xs`。

历史卡或恢复卡如果没有持久化的 `thinkingMs`，完成后只显示 `思考`，
不会伪造一个耗时。

## 状态流转

| 阶段 | 接口 | `flowStatus` | 动作 |
|---|---|---|---|
| 创建 | `POST /v1.0/card/ai/instances/createAndDeliver` | `PROCESSING` | 首帧即带单行头部与显隐正文 |
| 流式刷新 | `PUT /v1.0/card/ai/instances/update` | `INPUTTING` | 更新正文/头部/工具链路数据 |
| 思考结束 | `PUT /v1.0/card/ai/instances/update` | `INPUTTING` | 重发 `thinkingHeader`，切 `已思考 X.Xs` 并移除 shimmer |
| 工具状态变化 | `PUT /v1.0/card/ai/instances/update` | `INPUTTING` | 重发 `toolHeader`，在 `工具调用中` / `工具` 间切换 |
| 澄清卡更新 / 收口 | `PUT /v1.0/card/ai/instances/update` | `CONFIRMING` | 写澄清题组并停住，等待用户点击同卡续用 |
| 用户点开面板 | `PUT /v1.0/card/ai/instances/update` | `FINISH` | 只更新 `/ui/thinkingExpanded` 或 `/ui/toolsExpanded` |
| 完成 | `PUT /v1.0/card/ai/instances/update` | `FINISH` | 更新正文 + 重发头部组件 |
| 失败 | `PUT /v1.0/card/ai/instances/update` | `FAILED` / `ERROR`（代码按候选尝试） | 显示失败正文 |

`flowStatus` 用枚举名，不要用旧模板卡的数字码（旧模板是 `2/3/5`）。
官方 JSON 卡文档的完成枚举名是 `FINISH`，不是 `FINISHED`。

**不要在活跃态一次发多条 `a2uiMessages`**。真机验证：卡片创建后用 `INPUTTING`
或 `CONFIRMING` 更新时，`a2uiMessages` 只接受 **1 条**；同一次请求放 2 条（哪怕
只有 2 个极短字符串）会稳定返回 `400 param.invalid`。终态 `FINISH` 不受这个限制，
可以整包多条。

因此 EAB 的活跃帧会把答案、思考、工具、UI 显隐等字段拆成多次 update，每次只带
1 条消息、各自使用新的 `outUpdateId`。字段数超过 12 时先压成整包数据
（答案/思考/工具/UI/附件/澄清六类），避免 100 条澄清字段变成 100 次请求。
单条字段被 400 拒绝时只跳过该字段，其余字段继续刷新；网络错误或 5xx 仍按整帧
失败退避重试。

2026-11-24 真机验收：一条带柱状图、双轴柱状图的钉钉回合，同一张卡片的
`/answer` 从 14 字逐帧增长到 940 字（20 次活跃刷新，每次 1 条消息），
收口后正文 959 字并保留 2 个 `chart` 块，全部 update 返回 200。

`flowStatus` 仍用枚举名，旧模板卡的数字码（`2/3/5`）不适用。完成态是 `FINISH`，
不是 `FINISHED`。创建用 `PROCESSING`，内容产出用 `INPUTTING`；不要把已经完成的
卡片再用 `INPUTTING` 拉回活跃态，真机会返回 `param.invalid`。

流式刷新只在头部流光/澄清结构真的变化时重发对应组件；纯 token 更新只写数据路径，
避免把正在播放的 shimmer 打断。UI 字段逐项更新，不整份下发 `/ui`，避免把用户
刚展开的面板重新收起。

## 流式视觉的落点

当前 A2UI 卡片的流式阶段只保留低干扰提示，不使用独立 loading 组件：

| 位置 | 实现 | 说明 |
|---|---|---|
| 思考入口 | 单行 `Text`，`思考中` + `textEffect: shimmer` | 只让这一行文字流光，思考结束即移除 |
| 工具入口 | 单行 `Text`，运行中 `工具调用中` + shimmer | 工具结束立即切 `工具` 并停止 |
| 正文 | 纯 Markdown，不追加光标/图标 | 表格、代码块尾部和移动端都不会出现突兀字符 |
| 收口/澄清 | 不残留任何“生成中”符号 | 刷新失败或收口失败时，正文也不会卡着一个光标 |

旧模板卡（A2UI 建卡失败时的降级路径）仍使用钉钉原生流式组件，客户端会在正文末尾
自带转圈动效；它只能显示一段文字，不支持折叠，因此不作为默认路径。

历史尝试过的字符帧、独立 `Text` 行、`taiji_loading.gif`、28px 自绘 GIF 和正文光标
`▍/▏` 都已被观感否决，不要恢复。`textEffect: shimmer` 只保留在
`思考中 / 工具调用中` 入口上，终态和正文不要使用。A2UI `Markdown` 里的
`![]()` 在钉钉渲染器里是块级图片，会独占一行且尺寸不受控，也不要再走那条。

## 权限

`createAndDeliver` 的权限要求是 **AI卡片实例写权限**，错误里通常给出
`AICard.Instance.Write`。还需要 **`Card.Streaming.Write`** 才能持续刷新。
在开发者后台给应用开通这两个权限后，必须**重新发布应用版本**，再重启 EAB
让 access token 重新获取。

未开通时的行为：

- A2UI 卡创建失败后自动回退 `DingTalkCardStream`（旧模板卡）。
- 旧模板卡不支持折叠，因此处理中只显示一行状态；工具链路会以编号列表追加，
  至少包含工具名、状态、参数与结果。完成时只用正文覆盖整张卡，不再把
  思考/工具拼在正文前面。
- A2UI 403 后熔断 5 分钟，避免每条私聊都先等一次 403 重试。

## 如果坚持用卡片平台模板

在卡片平台新建「消息卡片 → AI 卡片」，变量至少配置：

- `think_content`（Markdown）
- `think_preview`（文本，单行）
- `tool_content`（Markdown）
- `tool_preview`（文本，单行）
- `answer_content`（Markdown）
- `flowStatus`（系统变量）

模板路线的折叠面板使用平台原生组件，`think_preview` / `tool_preview` 只能放在
折叠面板外面，因此仍然是“标题一行 + 预览一行”，无法做到 A2UI 的单行入口。
发布后把模板 ID 配到服务端，走 `v1.0/card/instances/*` + `cardParamMap`。
这条路线需要额外维护模板，且多变量流式刷新不如 A2UI 直接；如果要做，
必须把 `answer_content` 配成流式组件才能拿到原生转圈。

## 服务重启后的中断回合恢复

钉钉 Stream 的入站消息一旦 ACK，本地进程重启后钉钉不会重推。为了避免卡片永久停在
「处理中」，EAB 在开始建卡前把这一轮写进 `channel_turns`：

- `payload_json`：原始钉钉消息，重启后能知道用户问什么、属于哪个会话；
- `user_message_id` / `assistant_message_id`：恢复时不再重复插用户消息，AI 消息可原地更新；
- `card_instance_id` / `card_kind`：复用原 A2UI / 旧模板卡，不新建第二条机器人消息；
- `agent_turn_id`：同一轮工具幂等键不变，已成功的工具不会重复写文件/发消息。

启动后 `recoverInterruptedDingTalkTurns` 扫描最近 7 天内仍为 `running/recovering`
的回合：复用原卡重新跑同一轮；超过 24 小时、会话/成员已失效或连续 3 次恢复失败时，
只把原卡收口成「服务重启导致这一轮中断，请重新发送一次」，不再自动重跑，避免重复副作用。

恢复在服务监听后延迟 10 秒执行，等插件模型与工具注册完成，避免模型目录还没就绪就判失败。
升级前只写了 `channel_events`、没写 `channel_turns` 的旧中断，启动时会先尝试补登：
只有 `result_json` 为空、事件时间附近能唯一匹配一条用户消息、且该消息之后没有 assistant
回复时才补登，避免把已经正常回答过的旧消息重新发一遍。

原卡续用失败时，会先调用 `closeAfterResumeFailure` 尝试把原卡收口成「这一轮已转到新消息继续」；
只有这次收口也失败（卡片确已过期/被客户端清理）才新建卡。这样瞬时网络失败不会留下
一张永久转圈的旧卡。旧代码没有保存 `outTrackId` 的历史卡无法反查关闭，这是升级前数据的
已知限制。

`channel_turns` 会跟随全局日志保留天数清理，但只删 `completed/failed`；`running/recovering`
不清，保证启动恢复还有机会接手。清理发生在常规 retention 周期内，不额外增加定时任务。
