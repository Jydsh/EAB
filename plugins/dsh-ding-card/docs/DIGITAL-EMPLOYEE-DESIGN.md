# dsh-ding-card 企业机器人模板卡片 · 架构设计（方向变更版）

> 版本：v0.2
> **方向变更记录（2026-10-24）**：数字员工路线已冻结。原因：① 组织未开通数字员工功能（`DIGITAL_EMPLOYEE_NOT_ENABLED`，需填申请且流程繁琐）；② 用户选择**退回企业机器人模板卡片**。A2UI 免模板卡片技术上只绑定数字员工身份（发送接口无 robotCode），企业机器人发不了——故免模板方案在未开通数字员工前不可落地。本文档更新为**企业机器人模板卡片**路线。
> 目标：让 dsh-ding-card 在 **dsh-im 企业机器人**会话中，**自动**发送模板卡片用于交互选择（单选/多选/自由输入/多问题/审批），并解决此前**卡片渲染空白**与**不自动触发**两个问题。

---

## 1. 为什么必须走数字员工

钉钉把"A2UI 免模板卡片"能力绑定在**数字员工（AI 助理 / DEAP）身份**上，企业机器人发不了：

| 身份 | 发送普通消息 | 发送卡片 |
| --- | --- | --- |
| 企业机器人（dsh-im 当前） | ✅ 文本/Markdown/图片/文件 | ❌ A2UI；只能用模板卡片（必须后台绑模板） |
| **数字员工** | ✅ 消息 | ✅ **A2UI 免模板卡片**（结构全由消息携带） |

- A2UI 卡片发送走 `im.create_and_send_a2ui_card`，参数只有 `a2uiMessages / openConversationId / receiverOpenDingTalkId`，**无 robotCode**。
- dws v1.0.65 已确认具备 A2UI 命令 + `dingtalk-tag`（数字员工生命周期）+ `event`（收事件）能力。

---

## 2. 复用 dws CLI 作为数字员工后端引擎

插件不自己实现钉钉 OAuth/Stream，而是**调用本机已装的 dws**（当前 v1.0.65）完成数字员工通道的全部底层操作：

| 能力 | dws 命令 | 说明 |
| --- | --- | --- |
| 扫码登录（主管身份） | `dws auth login` | 用户扫码授权，保存主管 Profile |
| 创建数字员工草稿 | `dws dingtalk-tag manage create --type local_agent` | 返回 `agentUuid`（必存） |
| 补全/发布 | `manage save-draft` / `manage publish` | 发布后进入线上生效 |
| 接入 DSH | `dws dingtalk-tag connect --channel dsh` | 保存数字员工 Profile、DSH binding、请求 DSH 宿主启动该员工 |
| 收消息/收事件 | `dws event consume` / `+listen-im` | 订阅 IM 与卡片回调事件 |
| 发 A2UI 卡片 | `dws chat message send-a2ui-card` | 创建（默认 PROCESSING），返回真实 `bizId` |
| 更新/完结卡片 | `dws chat message update-a2ui-card --flow-status FINISH` | 作答后收起/完结 |

**回复职责**：`connect --channel dsh` 是外部宿主接入，**由 DSH 宿主负责回复**（收消息→触发 DSH 会话→回文本）。插件只负责在 DSH 会话里需要用户选择/提问时，发 A2UI 卡片并收回调。

---

## 3. 架构与数据流

```
用户钉钉 → 数字员工(DEAP) → dws event/DSH 通道
              │
        DSH(DeepSeek Harness) 宿主 —— 原生数字员工通道（收消息、路由会话、回文本）
              │
        dsh-ding-card 插件（本次改造）
              ├─ 扫码创建数字员工（复用 dws）
              ├─ 会话映射：数字员工会话(openDingTalkId/openConversationId) ↔ DSH sessionId
              ├─ A2UI 卡片：ding_card_send / ask_user_question / 审批 → send-a2ui-card
              ├─ 回调收口：user_card_action_triggered / 卡片回调 → 解析选择
              └─ 作答收起：update-a2ui-card --flow-status FINISH（"像没出现过"）
```

**两种接入并存**（config 切换）：
- `config.connector = "dsh-im"`：现有企业机器人链路（模板卡片，保留）。
- `config.connector = "dws-digital-employee"`：新数字员工链路（A2UI 免模板）。

---

## 4. 模块改造清单

| 现有模块 | 改动 |
| --- | --- |
| `store.js` | 新增 `connector`（`dsh-im`/`dws-digital-employee`）+ 数字员工状态（agentUuid、binding、profile、登录态） |
| `dingtalk.js` | 新增 A2UI 发送方法（`send-a2ui-card`/`update-a2ui-card` 的 dws 封装，含 `bizId` 生命周期） |
| `stream-bridge.js` | 新增数字员工事件订阅（`dws event`：卡片回调 + IM），保留 dsh-im 分支 |
| `cards.js` | 新增 A2UI 分支：present/finish 走 A2UI 生命周期（`bizId`+`flowStatus`）；回调解析数字员工选项 |
| `interactions.js` | 按 `connector` 分派：数字员工→A2UI 卡片，企业机器人→模板卡片 |
| `tools.js` | `ding_card_send` 等工具按 `connector` 走 A2UI 或模板 |
| `dshim.js` | **保留**（仅企业机器人模式用） |
| **新增 `de-channel.js`** | 数字员工通道：扫码创建、连接管理、会话映射、事件消费、A2UI 发送编排 |

---

## 5. 关键前提（需要确认/用户配合）

1. **DSH 宿主支持数字员工接入**：`connect --channel dsh` 需要 DSH 版本支持"宿主员工级启动数字员工"。接入时若宿主不可用会返回 `restartRequired=true`——需先确认当前 DeepSeek Harness 支持。
2. **钉钉主管扫码**：创建数字员工需一个已登录的钉钉主管身份（`dws auth login` 扫码，需用户操作一次）。
3. **数字员工 local_agent 类型**：创建 `--type local_agent`，发布后接入 DSH。
4. **openDingTalkId 获取**：A2UI 单聊发送需要接收者 openDingTalkId，依赖 DSH 数字员工通道提供会话↔openDingTalkId 映射（或从事件解析）。

---

## 6. 分阶段实施计划

- **阶段 1**：扫码创建数字员工（引导用户 `dws auth login` 扫码 → 插件驱动 `manage create/publish` → `connect --channel dsh`，保存状态）。
- **阶段 2**：DSH 数字员工通道接入确认 + 会话↔openDingTalkId 映射。
- **阶段 3**：A2UI 卡片发送/更新/完结（`send-a2ui-card`/`update-a2ui-card`，bizId 生命周期）。
- **阶段 4**：卡片回调收口 + 作答解析（单选/多选/自由输入/多问题）。
- **阶段 5**：交互应答接入（user-questions/approval 走 A2UI）+ `connector` 并存切换。
- **阶段 6**：重启 dsh + 端到端验证（钉钉会话触发提问→卡片显示→作答→收起）。

---

## 7. 风险

- **DSH 原生数字员工通道支持度**未最终确认（最大不确定点，阶段 1/2 先验证）。
- 依赖 dws 本机安装且登录对应数字员工 profile；插件每次命令调用有进程开销。
- openDingTalkId 与会话映射若 DSH 未暴露，需插件从事件/回调自行解析。
- 扫码创建涉及主管权限与发布流程，需用户配合扫码与确认。

---

*本文档为方案稿；确认方向与阶段 1 前提后开始实现。*
