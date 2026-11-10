# 个人云空间容量工具与预警

## agent 能做什么

新增内置工具 `workspace.capacity`（模型侧函数名 `workspace_capacity`）：

- 查询当前员工个人云空间的已用字节、总容量、剩余字节、使用百分比。
- 返回单文件上限和配额来源（个人配置 / 角色配置 / 默认配置）。
- 返回分级预警 `warning.level` 与可直接转述给用户的 `warning.message`。

调用结果示例：

```json
{
  "scope": "个人云空间",
  "usedBytes": 18391,
  "limitBytes": 524288000,
  "remainingBytes": 524269609,
  "percent": 0,
  "level": "normal",
  "warning": {
    "level": "normal",
    "message": "个人云空间剩余 500 MB（已用 0.0%）。"
  },
  "fileLimitBytes": 52428800,
  "quotaSource": "default",
  "roleCodes": []
}
```

## 删除文件

新增内置工具 `workspace.delete`（模型侧函数名 `workspace_delete`）：

- 用户明确说“删掉/删除/清理某个文件”时，模型先 `workspace.list` 找文件，再传 `fileId` 或 `path`。
- 只允许删除当前员工自己的云空间文件；共享来的、别人的文件会明确拒绝。
- 删除是软删：文件移到 `_recycle/<id>-<name>`，`workspace_files.deleted_at` 写入时间，列表和容量统计不再计入，但元数据与回收文件保留可审计。
- 删除成功后返回 `deleted: true`、文件名、大小和 `recycled: true`，不把磁盘绝对路径返回给模型。
- 和容量工具一样，只在当前对话选择「云空间」时暴露；本地空间不使用这个工具。

## 作用范围

`workspace.capacity` 只在当前对话选择「云空间」时提供给模型；当前选择「本地空间」时不暴露这个工具，避免把本地磁盘和云空间配额混在一起。

## 预警阈值

| 已用比例 | 等级 | 用户侧提示 |
|---|---|---|
| < 75% | normal | 只显示剩余空间 |
| ≥ 75% | notice | 建议留意大文件 |
| ≥ 85% | warning | 快满了，建议清理或扩容 |
| ≥ 95% | critical | 即将用完，再传大文件可能失败 |
| ≥ 100% | full | 已满，请清理或扩容 |

## 网页侧展示

- 侧栏「i」角标：75% 起变为橙色，95% 起变为红色；无障碍标签包含剩余空间和预警原话。
- 配额浮层：进度条、剩余空间、单文件上限、配额来源；预警等级非 normal 时显示一条提示块。
- 进入工作台或刷新后，如果存在预警，右下角主动弹一次提醒；同一等级在一次页面会话内不重复弹，等级升级会再弹。
- 配额恢复到 normal 后，提醒记录会重置，下一次再触发预警仍会提示。

## 接口

`GET /api/workspace/quota` 在原返回结构上增加：

- `remainingBytes`、`percent`、`warning: { level, message }`
- `user.remainingBytes`、`user.percent`

原有 `user.limit/used/limitBytes/fileLimitBytes`、`company`、`quotaSource`、`roleCodes` 保持兼容。

## 钉钉侧

钉钉私聊收到文件并保存到个人云空间后，如果容量达到 notice 及以上，文件回执末尾会追加「容量提醒：……」；75% 以下不打扰用户。

## 验证

- `packages/server/test/workspace-quota.test.ts`：75/85/95/100% 等级、剩余空间、提示文案。
- `packages/server/test/workspace-capacity-tool.test.ts`：工具注册、模型可见、云空间下执行、返回预警；本地空间下不暴露；同一测试覆盖 `workspace.rename` 与 `workspace.delete` 的真实临时文件改名和删除。
- 真机：临时把个人配额调为 20 KB，页面显示 89.8% warning、橙色角标、主动提醒条；`POST /api/tools/workspace.capacity/invoke` 返回 `remainingBytes: 2089`、`level: warning`。验证后已删除临时配额，恢复默认 500 MB。
- agent 实测：选择云空间后问“我的个人云空间还剩多少？快满了吗？”，模型调用「个人云空间容量」工具，回答剩余 500 MB、已用约 18 KB、预警正常。
