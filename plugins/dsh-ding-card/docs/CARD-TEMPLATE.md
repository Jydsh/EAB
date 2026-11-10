# 卡片模板搭建指南

## 推荐方式：设计器 + 一键导出

1. 「钉卡片 → 卡片 → 添加卡片」：填写名称，选择卡片类型（消息/吊顶/通讯录/工作台/日程/标准）。
2. 在内容设计里编辑标题、副标题、正文、字段、图片；在「按钮组」添加预置选项（显示标签 + 回传值），并决定是否允许用户自行输入。
3. 保存后点「导出 JSON」，得到 `<卡片名>.card.json`。
4. 到 [钉钉卡片平台](https://open-dev.dingtalk.com/fe/card) 导入该 JSON，检查样式并发布，复制模板 ID。
5. 回到卡片列表，把模板 ID 粘贴到对应卡片的输入框，点「保存 ID」。

导出结构：

- 消息/吊顶/通讯录/工作台/日程：`type: "im"`，使用官方示例的 `Card` + `BaseText` + `ButtonList` 组件树；按钮 `direction: "vertical"`。
- 标准卡片：`type: "standard"`，使用 `StdCard` + `Markdown` + `ButtonBlock`。
- 变量：`title`、`subtitle`、`content`、`fields`、`image`、`state`、`option1`…`optionN`、`customText`。
- 按钮文案绑定 `${optionN}`（内容为「标签 — 回传值」），固定回传参数为 `{"<回调参数名>":"N"}`，插件再映射到选项的回传值。
- 开启「允许用户自行输入」时，导出会追加 `Input` 与提交按钮；提交按钮的回传参数名为 `dsh_text`，插件把它作为自定义答案。

> 通讯录/工作台/日程卡片的导出类型目前统一为 `im`；如钉钉导入器要求特定类型，请在导入时选择对应场景，或按平台提示调整 JSON 顶层的 `type` 字段。

## 手动搭建（使用已有模板）

如果你已经有设计好的模板，也可以跳过设计器，直接在卡片列表里绑定模板 ID。模板需要声明这些变量（变量名在卡片编辑器里可改）：

| 变量 | 类型 | 内容 |
| --- | --- | --- |
| `title` | 文本 | 卡片标题 |
| `subtitle` | 文本 | 副标题/标签 |
| `content` | Markdown / 文本 | 问题正文与编号选项 |
| `fields` | 文本 | 「名称：值」多行文本 |
| `image` | 文本 | 图片 URL |
| `state` | 文本 | `等待选择` / `已完成` / `已超时` |
| `option1`…`option6` | 文本 | 按钮文案 |

按钮列表里的每个按钮把 `value` 原样回传，例如：

```json
[
  { "id": "1", "label": "选项 A", "value": { "dsh_option": "1" } },
  { "id": "2", "label": "选项 B", "value": { "dsh_option": "2" } }
]
```

插件同时写入固定的 `option1`…`optionN` 和 `actions` JSON 两种形态，因此旧模板（按钮绑定 `actions`）和新导出的模板（按钮绑定 `${optionN}`）都能工作。

回调到达时，插件从 `cardPrivateData.params.<回调参数名>` 读取选项；默认参数名是 `dsh_option`，审批卡片默认 `dsh_decision`。

## 手动搭建的其余步骤

## 1. 新建模板

1. 打开 <https://open-dev.dingtalk.com/fe/card>，进入「卡片平台」。
2. 新建模板，分类选择 **AI 卡片**（只有 AI 卡片带「输入中 / 完成 / 出错」生命周期）。
3. 把模板关联到机器人所属的企业内部应用，**发布**，复制模板 ID（形如 `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.schema`）。

> 模板未发布时创建实例会返回 `param.templateUnpublished`。

## 2. 声明变量

在模板的「变量」里新增（名称必须与「钉卡片 → 卡片模板」页面一致，默认如下）：

| 变量名 | 类型 | 用途 |
| --- | --- | --- |
| `title` | 文本 | 标题 |
| `content` | Markdown | 正文与选项说明 |
| `state` | 文本 | 状态：等待选择 / 已完成 / 已超时 |
| `actions` | JSON 字符串 | 动态按钮列表 |

## 3. 三个布局

AI 卡片有「输入中 / 完成 / 出错」三个布局。建议：

- 三个布局都绑定 `content`；
- 「输入中」把 `content` 组件设为**流式**（打字机）；
- 「输入中」和「完成」都放按钮列表，绑定 `actions`，这样问题在等待期间也能点；
- `state` 放在底部状态栏；
- 不需要 `flowStatus` 变量，钉钉按生命周期自动切换布局。

## 4. 按钮列表

按钮列表组件绑定 `actions` 变量。插件写入的每一项形如：

```json
{
  "id": "1",
  "label": "选项 A",
  "style": "default",
  "disabled": false,
  "value": { "dsh_option": "1" }
}
```

关键约定：**按钮把 `value` 原样作为回调参数回传**。插件从回调的
`content → cardPrivateData → params → dsh_option` 读取选中项。

如果你使用的卡片平台版本不支持动态按钮列表，可以把「选项按钮模式」改为 `fixed`：

- 模板里放最多 6 个固定按钮；
- 文本分别绑定变量 `option1` … `option6`；
- 每个按钮的回传参数写成固定值 `{"dsh_option":"1"}`、`{"dsh_option":"2"}`……

## 5. 回调方式

插件创建实例时使用 `callbackType: "STREAM"`，按钮点击通过**机器人已有的 Stream 连接**推送，topic 为 `/v1.0/card/instances/callback`。因为钉钉一个事件只会投递给一个消费者，插件在 dsh-im 的 `DWClient` 上追加监听器，而不是另开连接。

如果模板里配置的是 HTTP 回调地址，按钮点击不会到达本插件；请把模板回调方式改为 Stream，或删除模板上的固定回调地址。

如果用的是**普通互动卡片**而不是 AI 卡片，请在「钉卡片 → 卡片模板」里关闭该模板的「AI 卡片模板」开关：插件不会再调用流式收口接口，按钮同样可用。

## 6. 审批卡片

审批卡片复用同一套变量，只是选项固定为：

```json
[
  { "id": "allow", "label": "允许一次", "value": { "dsh_decision": "allow" } },
  { "id": "deny", "label": "拒绝", "value": { "dsh_decision": "deny" } }
]
```

审批模板的「回调参数名」默认是 `dsh_decision`。插件也兼容 `allow`、`approve`、`approved`、`accept` 以及 `deny`、`denied`、`reject` 这些动作值。

## 7. 吊顶卡片（可选）

1. 再建一个模板（可以是普通互动卡片），同样声明 `title` / `content` / `state` / `actions`。
2. 在「钉卡片 → 卡片模板 → 吊顶卡片」里绑定模板 ID，并打开「启用吊顶卡片」。
3. 吊顶只在**单聊机器人会话**中开启；首次开启前需要机器人已给该用户发过消息。
4. 群聊吊顶需要群模板或群聊酷应用，本插件暂不自动创建。

## 8. 调试

- 在「钉卡片 → 概览」点「发送测试卡片」，插件会向最近一次钉钉会话投放一张测试卡片。
- 点击按钮后到「日志」页确认出现「卡片已提交答案」。
- 常见错误：
  - `param.templateUnpublished`：模板未发布。
  - `cardTemplate.not.exist`：模板 ID 不对，或模板不属于该应用。
  - `invalid-credentials`：Client ID / Secret 不正确。
  - `permission.*`：应用缺少卡片或会话权限。
