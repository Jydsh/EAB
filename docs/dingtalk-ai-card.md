# 钉钉 AI 卡片：思考/工具过程折叠

## 结论

EAB 私聊回复**默认走新版 A2UI JSON 卡片**，保留思考/工具折叠面板；
只有 A2UI 建卡失败时才回退 dsh-im 同款模板卡（`02fcf2f4-...schema`）。

- A2UI 本身没有旧模板那种「正文末尾原生转圈」的流式 widget：`Icon.SpinLoading_L_outlined`
  官方注明不自转，`Text.textEffect: shimmer` 只在 iOS 生效且是扫光，`ProgressBar variant: block`
  是 32×32 块状进度。这几种原生组件都不能直接当 spinner 用。
- 但旧模板那个圆环的**视觉素材就在钉钉客户端安装目录**：
  `image_resource/taiji_loading.gif`，96×96、30 帧、30ms、无限循环，黑色主弧 + 灰色拖尾。
  与 dsh-im 真机截图里的圆环形状一致。
- 现在把这个原生 GIF 缩到 14px（白底、无彩色抖动）后，作为 `Text` 的前置图标放到
  `answerRow` 的末尾：`Row[Markdown(正文, weight:1), Text(零宽字符 + icon url)]`，
  底部对齐。圆环与正文最后一行同高、同一行，不靠 Markdown 的块级图片，也不显示百分比/文字。
  14px 版 CDN 为 `https://aka.doubaocdn.com/s/8Q14U759NP`；正文已出现且未收口时显示，
  收口/失败时用 `/ui/showAnswerSpinner` 置为 false。
- 旧模板卡仍保留为 A2UI 失败时的降级路径；它的 `msgContent` 是钉钉原生流式组件，
  客户端会在正文末尾自动转圈，但只能显示一段文字，无法保留折叠面板。
- 思考/工具用公开 Catalog 的 `CollapsiblePanel`，`defaultExpanded: false`；
  正文用 `Markdown`，放在折叠面板之后。
- 思考流式输出时，折叠面板外再放一个独立的单行 `Text` 预览（`maxLine: 1`），
  这样面板即使收起，标题下面也能实时看到最新一段思考内容；
  思考结束（正文开始或工具开始调用）后隐藏该预览。
- 思考标题在流式中是「✦ 正在思考…」，思考结束后切为「✦ 已深度思考」；
  工具面板处理中是「🛠️ 工具调用中…」，完成后是「🛠️ 工具调用记录」。
- 工具面板的正文不再只有工具名，而是完整链路：工具名、执行中/完成/失败、
  耗时、参数、结果/错误。参数和结果在写入数据模型前做长度截断。
- 根 `Card` 显式设置 `backgroundColor: "#FFFFFFFF"`，内部用 `rootColumn` 承载组件树，
  避免钉钉默认主题灰底。官方设计规范建议默认跟随客户端背景，这里是按“白色清晰”
  的产品要求做的显式覆盖。
- 结束时把卡片状态置为 `FINISH`，并重发两个折叠面板的组件定义：
  标题改为「✦ 已深度思考 / 🛠️ 工具调用记录」，同时去掉 `textEffect: shimmer`。
  面板仍保持收起，所以正文最突出。
- 会话列表外层摘要不再引用用户问题，而是引用机器人回复正文：
  - 建卡时回答还没生成，先用中性品牌文案「EAB 企业智能助手」占位；
  - 旧模板收口时通过 `PUT /v1.0/card/instances` 的
    `cardData.cardParamMap.sys_lastMessageI18n` 把摘要替换成回答正文
    （`zh_CN` / `en_US` JSON 字符串），这一步是 best-effort，失败不影响卡片收口；
  - A2UI 的 `/v1.0/card/ai/instances/update` 没有 `summary` 字段，因此 A2UI
    路径目前只能保持中性占位；等权限开通后再评估是否可用其他摘要机制。

实现文件：`packages/server/src/dingtalk-card.ts`（`DingTalkAICardStream`）。
完整消息示例：`docs/dingtalk-ai-card.example.json`。

## 数据路径映射

| 业务变量 | A2UI 数据路径 | 组件 |
|---|---|---|
| `think_content` | `/thinking/text` | `thinkingText`（`Markdown`，位于 `thinkingPanel` 内） |
| `think_preview` | `/thinking/preview` | `thinkingPreview`（`Text`，位于 `thinkingPanel` 外） |
| `tool_content` | `/tools/text` | `toolText`（`Markdown`，位于 `toolPanel` 内） |
| `tool_preview` | `/tools/preview` | `toolsPreview`（`Text`，位于 `toolPanel` 外） |
| `answer_content` | `/answer/text` | `answer`（`Markdown`，位于根 `Column` 最后） |
| 是否显示思考 | `/ui/showThinking` | `thinkingBlock` / `thinkingPanel.visible` |
| 是否显示思考预览 | `/ui/showThinkingPreview` | `thinkingPreview.visible` |
| 是否显示工具 | `/ui/showTools` | `toolBlock` / `toolPanel.visible` |
| 是否显示工具预览 | `/ui/showToolsPreview` | `toolsPreview.visible` |

组件树顺序：`rootColumn` → `thinkingBlock`（`thinkingPanel` + `thinkingPreview`）
→ `toolBlock`（`toolPanel` + `toolsPreview`）→ `answer`。
预览行必须是折叠面板的**兄弟**组件，不能放进 `CollapsiblePanel.children`，
否则面板收起时子组件不渲染，预览也会一起消失。

预览内容在服务端做单行化与截断：思考预览取最近 120 个字符，工具预览显示当前
正在执行的工具名称与「执行中」状态；`Markdown` 组件没有 `maxLine`，所以预览使用
`Text` 组件并显式设置 `maxLine: 1`。

工具链路统一写成编号列表，每条形如：

```text
1. **org.directory** · 完成 · 320ms
   参数：{"query":"部门"}
   结果：找到 3 个部门
```

参数和结果分别截断到 360 个字符，避免单次工具输出把卡片撑爆。

处理中：

- 纯思考阶段：`showThinking=true`、`showThinkingPreview=true`；
  标题「✦ 正在思考…」，标题下面一行实时显示 `thinking.preview`。
- 正文开始或工具开始调用时，`thinkingDone` 置为 `true`：
  `showThinkingPreview=false`，标题切为「✦ 已深度思考」。
- 真正发生工具调用后：`showThinking=false`、`showTools=true`、
  `showToolsPreview=true`；工具标题下面一行显示最新工具状态。
  没有工具调用就不会出现工具面板，也不会再用「等待工具调用…」占位。

完成：标题改为「✦ 已深度思考」「🛠️ 工具调用记录」，去掉 shimmer；
两个预览均为空且隐藏；`showThinking` / `showTools` 按实际内容决定，
面板仍 `defaultExpanded: false`。没有思考内容时隐藏思考面板，
没有工具调用时隐藏工具面板。

## 状态流转

| 阶段 | 接口 | `flowStatus` | 动作 |
|---|---|---|---|
| 创建 | `POST /v1.0/card/ai/instances/createAndDeliver` | `PROCESSING` | 首帧即带折叠面板与预览行 |
| 流式刷新 | `PUT /v1.0/card/ai/instances/update` | `PROCESSING` | 更新正文/思考/预览/工具链路数据 |
| 思考结束 | `PUT /v1.0/card/ai/instances/update` | `PROCESSING` | 重发面板组件，标题切「已深度思考」 |
| 完成 | `PUT /v1.0/card/ai/instances/update` | `FINISH` | 更新正文 + 重发折叠面板组件，触发收起 |
| 失败 | `PUT /v1.0/card/ai/instances/update` | `FAILED` / `ERROR`（代码按候选尝试） | 显示失败正文 |

`flowStatus` 用枚举名，不要用旧模板卡的数字码（旧模板是 `2/3/5`）。
官方 JSON 卡文档的完成枚举名是 `FINISH`，不是 `FINISHED`。

旧模板收口时还会再发一次相同正文的 `PUT /v1.0/card/instances`，
额外带上 `cardData.cardParamMap.sys_lastMessageI18n`，只用于把会话列表摘要
从占位文案替换成回答正文；这一步失败只记日志，不会让已完成的卡片回退成文字消息。

## 原生加载动画的落点

需求是「正文流式输出时，每一段文字后面有一个持续转圈的加载提示，不显示百分比、不显示文字、不单独占一行」。实现结论：

| 路径 | 是否有原生转圈 | 结论 |
|---|---|---|
| A2UI 正文 `Row[Markdown + Text(icon: taiji_loading.gif)]` | 视觉与旧模板一致（同一套 loading 素材） | **默认走这条，保留折叠面板；14px、与正文同一行末尾** |
| 旧模板卡 `02fcf2f4` + `/v1.0/card/streaming` | 有，客户端自带流式组件动效 | A2UI 建卡失败时的降级 |
| A2UI `Icon SpinLoading_L_outlined` | 没有，官方注明图标名不自转 | 不能用 |
| A2UI `Text.textEffect: shimmer` | 扫光/流光，且仅 iOS 生效 | 不算转圈 |
| A2UI `ProgressBar variant: block` | 32×32 块状进度，不自旋 | 不能用 |

`dingtalk-bot.ts` 的私聊建卡顺序是：先 `DingTalkAICardStream`（A2UI，折叠面板），
失败才 `DingTalkCardStream`（旧模板卡）。A2UI 的正文转圈**不是自绘**：素材来自
钉钉客户端 `image_resource/taiji_loading.gif`，与旧模板 streaming widget 后面的圆环
同一套视觉；已缩到 14px 并上传为 `https://aka.doubaocdn.com/s/8Q14U759NP`，由
`answerRow` 里的 `Text.icon` 承载，不再写进 Markdown 图片语法。
字符帧、独立 Text 行、28px 自绘 GIF 都已被观感否决，不要恢复；A2UI `Markdown` 里的
`![]()` 在钉钉渲染器里是块级图片，会独占一行且尺寸不受控，也不要再走那条。


## 权限

`createAndDeliver` 的权限要求是 **AI卡片实例写权限**，错误里通常给出
`AICard.Instance.Write`。还需要 **`Card.Streaming.Write`** 才能持续刷新。
在开发者后台给应用开通这两个权限后，必须**重新发布应用版本**，再重启 EAB
让 access token 重新获取。

未开通时的行为：

- A2UI 卡创建失败后自动回退 `DingTalkCardStream`（旧模板卡）。
- 旧模板卡不支持折叠，因此处理中只显示**一行**状态：思考阶段是「✦ 正在思考…」，
  下面附一行思考预览；真正发生工具调用后切换成「🛠️ 工具调用中…」，
  不再同时出现；工具链路会以编号列表追加，至少包含工具名、状态、参数与结果。
  完成时只用正文覆盖整张卡，不再把思考/工具拼在正文前面。
  它的价值是正文末尾的钉钉原生转圈，这是 A2UI 卡没有的。
- A2UI 403 后熔断 5 分钟，避免每条私聊都先等一次 403 重试。

## 如果坚持用卡片平台模板

在卡片平台新建「消息卡片 → AI 卡片」，变量至少配置：

- `think_content`（Markdown）
- `think_preview`（文本，单行）
- `tool_content`（Markdown）
- `tool_preview`（文本，单行）
- `answer_content`（Markdown）
- `flowStatus`（系统变量）

把 `think_content` / `tool_content` 放进「折叠面板」组件，默认收起；
`think_preview` / `tool_preview` 放在对应折叠面板**外面**，这样面板收起时仍能显示；
`answer_content` 放在折叠面板之后。发布后把模板 ID 配到服务端，
走 `v1.0/card/instances/*` + `cardParamMap`。

这条路线需要额外维护模板，且多变量流式刷新不如 A2UI 直接；如果要做，
必须把 `answer_content` 配成**流式组件**才能拿到原生转圈。
