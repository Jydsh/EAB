# 渠道解绑组织与人员清理设计

状态：已确认，按 1B / 2B / 3A 实施
日期：2026-11-12

## 0. 已确认的决策

- **1B：钉钉也全量删除。** 解绑钉钉时，删除钉钉同步来的全部部门、成员、身份和角色。
- **2B：直接移除成员。** 命中当前渠道身份的成员，不论是否还有网页或其他渠道身份，都移除成员并删除其全部角色。
- **3A：角色一并删除。** 被移除成员的 `user_roles` 和 `authz_overrides` 一起清理。

产品口径：一家公司下三个渠道各自同步一套组织/人员，渠道用户 ID 互不相同；EAB 自己创建的人员是独立的一套，不被渠道解绑牵连。

## 1. 现状

当前 `POST /api/channel/unbind` 只做四件事：

- 清空 `channel_configs` 的 `tenant_id / tenant_name / bound_at / bound_by_user_id`；
- `enabled = 0`、`status = 'unbound'`、`sync_mode = 'off'`；
- 不删除 `departments`；
- 不删除 `users`、`user_identities`、`channel_identities`、`user_roles`。

`0004_channel_bind.sql` 的注释也明确写着“解绑不删组织数据”，理由是部门/成员属于公司资产，且知识库 ACL 引用了部门 path。这与当前“解绑后自动移除该渠道带来的组织架构、成员和角色信息”的诉求冲突，需要把“渠道数据”和“公司主数据”分开处理。

## 2. 目标与非目标

### 目标

解绑某个渠道后，控制台立即看不到该渠道带来的：

- 渠道组织节点及其下级部门；
- 渠道同步进来的成员；
- 这些成员在角色管理里的授权；
- 这些成员的渠道身份（机器人不再能识别为该公司成员）。

同时保证：

- 同一家公司其他渠道的组织和人员不受影响；
- 按 2B，命中当前渠道身份的成员一律移除，即使他还有网页账号或其他渠道身份；只保护没有该渠道身份、挂在渠道部门下的 EAB 自有成员；
- 解绑后重新绑定同一渠道，组织能重新同步，成员能重新出现；
- 解绑动作可审计、可恢复软删数据；失败不留下半清理状态。

### 非目标

- 不删除公司根部门；
- 不删除知识库文档和知识库 ACL 配置；
- 默认不删除历史聊天会话；
- 不按“共享成员保留”处理：2B 明确选择直接移除，跨渠道成员只在结果里计数提示。

## 3. 数据归属

### 3.1 部门

`departments` 已有字段：

- `company_id`
- `parent_id`
- `name`
- `path`
- `depth`
- `channel`
- `channel_dept_id`
- `manager_user_id`
- `deleted_at`

渠道部门的判定：

- `channel = provider` 且 `channel_dept_id IS NOT NULL` 的部门是渠道同步生成的部门；
- 飞书、企业微信当前会在公司根部门下生成一个渠道根节点（飞书 `d_feishu_0`，企业微信预期为 `d_wecom_1`），渠道成员挂在该节点下；
- 钉钉当前没有独立渠道节点，钉钉部门直接挂在公司根部门下。

### 3.2 成员和身份

- `users`：成员主体，`dept_id / dept_path` 指向部门；
- `user_identities`：组织同步写入的渠道身份，字段 `user_id / provider / external_user_id / status`；
- `channel_identities`：机器人回调用到的渠道身份，字段 `company_id / provider / external_id / user_id / revoked_at`。

同一个人可能同时有：

- 飞书 `user_identities`；
- 钉钉 `user_identities`；
- 网页账号（`users.password_hash` 非空）；
- 多个 `channel_identities`。

### 3.3 角色和权限

- `user_roles`：成员和角色的授权关系，只有 `user_id / role_id / granted_by / granted_at / expires_at`，**没有记录“这个角色是渠道同步授予的还是手工授予的”**；
- `authz_overrides`：成员级权限覆盖；
- `sessions`：网页登录会话；
- `workspace_files`：个人工作区文件。

因此“只删除渠道同步期间授予的角色”在现有表结构下无法精确做到；只能按“被移除成员的所有角色”或“保留角色”二选一。

## 4. 已确认的清理边界

### 4.1 钉钉解绑：也全量删除

钉钉当前是公司主组织：约 14 个部门、151 名成员直接挂在公司根部门下，没有独立渠道节点。

按 1B 决策，解绑钉钉时：

- 删除全部 `channel = 'dingtalk'` 的部门；
- 删除这些部门下、以及持有钉钉身份的成员；
- 删除这些成员的全部角色和权限覆盖；
- 公司根部门保留；EAB 自己创建、没有钉钉身份的成员如果被放在钉钉部门下，先移到公司根部门，不删除。

### 4.2 多身份成员：直接移除成员

按 2B 决策：

- 只要命中当前渠道身份，就移除该成员，不论他是否还有网页密码或其他渠道身份；
- 同时删除该成员的全部角色和权限覆盖；
- 结果里会单独返回 `crossChannelUsers` 计数，提示有多少被移除成员还持有其他渠道身份，便于管理员知悉；
- 产品口径是三个渠道各自一套人员，正常情况下不会命中这种跨渠道成员；这条规则主要防止历史脏数据留下。

### 4.3 角色清理：全部删除

按 3A 决策：

- 被移除成员的 `user_roles` 和 `authz_overrides` 一起删除；
- 角色页的成员计数立即下降；
- 重新绑定渠道后成员会恢复，但角色不会自动恢复，需要管理员重新授权。

## 5. 清理计划

### 5.1 成员范围

对指定 `provider`，先算出：

```text
providerUsers =
  users JOIN user_identities (provider = ?)
  UNION
  users JOIN channel_identities (provider = ?, revoked_at IS NULL)
  且都在当前 company_id
```

按 2B 决策：

- `providerUsers` **全部移除**，不按网页密码或其他渠道身份做保留；
- 额外统计 `crossChannelUsers`：同时还有其他渠道身份的成员数，只用于提示，不改变删除结果；
- 没有该渠道身份、只是被手工放到渠道部门下的人，不属于 `providerUsers`，不删除；在删部门前移到公司根部门。

### 5.2 部门范围

飞书、企业微信：

- 找到该 provider 的渠道根节点（父节点是公司根部门，且 `channel_dept_id` 是该渠道根 ID）；
- 清理范围 = 该根节点 + `path` 以该根节点 path 开头的全部下级部门；
- 下级部门即使是手工创建、`channel IS NULL`，只要挂在这个渠道节点下，也随节点一起清理，避免留下孤儿部门。

钉钉：

- 按 1B，清理全部 `channel = 'dingtalk'` 的部门，以及这些部门 path 下的手工下级部门；
- 公司根部门不在清理范围；
- EAB 自己创建、没有钉钉身份的成员，如果挂在钉钉部门下，先移到公司根部门。

### 5.3 事务顺序

预览只读，不写库。真正解绑在一个事务里完成：

1. 计算 `providerUsers`、`providerDepts`、`protectedUsers`（无渠道身份但挂在待删部门下的人）；
2. 把 `protectedUsers` 先移到公司根部门：
   - `users.dept_id = 公司根部门 id`
   - `users.dept_path = 公司根部门 path`
3. 标记渠道身份失效：
   - `channel_identities.revoked_at = now`（company + provider）；
   - `user_identities.status = 'revoked'`（只标记当前 provider，保留行供重新绑定识别，见 6）；
4. 软删除 `providerUsers`：
   - `users.deleted_at = now`
   - `users.status = 'disabled'`
   - `users.recycled_at = now`
5. 清理这些成员的全部角色和权限：
   - `DELETE FROM user_roles WHERE user_id IN (...)`
   - `DELETE FROM authz_overrides WHERE user_id IN (...)`
6. 撤销这些成员的网页会话：
   - `sessions.revoked_at = now`
7. 归档这些成员的个人工作区：
   - `workspace_files.archived_at = now`，不删文件；
8. 待删部门的负责人统一置空：
   - `departments.manager_user_id = NULL`
9. 软删除部门子树：
   - `departments.deleted_at = now`
10. 更新渠道配置：
    - 清空 `tenant_id / tenant_name / bound_at / bound_by_user_id`
    - `enabled = 0`、`status = 'unbound'`、`sync_mode = 'off'`
    - 清空 `last_sync_run_id / last_synced_at / last_sync_status / last_sync_error`
11. 在事务内追加审计：
    - action：`channel.unbind`
    - detail：provider、removed 计数、`crossChannelUsers`、`protectedUsers`、失败原因（如有）

事务提交后，再调用渠道连接刷新：

- 飞书：`refreshFeishuStream(deps)`
- 钉钉：`refreshDingTalkStream(deps)`
- 企业微信：如有连接管理器，同样刷新

刷新失败不回滚数据库，只记录日志并在返回值里标记 `streamRefreshFailed`；解绑本身已经提交。

### 5.4 为什么用软删除

- `users` 被 `chat_sessions`、`workspace_files` 等表引用，硬删会受外键限制或破坏历史；
- `departments` 被 `users.dept_id` 引用，硬删会留下无效引用；
- 软删保留 path，知识库 ACL 不会因为行被物理删除而找不到依据；
- 重新绑定时可以按原 ID 恢复。

角色行是例外：`user_roles` 没有软删字段，只能物理删除。删除后角色页计数立即下降；如果之后要恢复，需从备份或重新授权。

## 6. 重新绑定同一渠道

不能把身份行直接删掉，否则重新同步时会出现两类问题：

- `user_identities` 唯一键 `(provider, external_user_id)` 已经释放，但 `users` 里还留着同 ID 的软删行，`applyOrgSync` 直接插入会撞主键；
- 成员无法和旧会话、旧工作区重新关联。

因此解绑时：

- `channel_identities` 用 `revoked_at` 标记，不物理删除；
- `user_identities` 保留行，`status = 'revoked'`，不物理删除。

重新绑定时需要补一处同步逻辑：

- `applyOrgSync` 读到 `user_identities.status = 'revoked'` 时，把状态改回 `active`；
- 对应的 `users.deleted_at` 由同步的 `updateUser` 清空，成员恢复；
- `channel_identities` 由 `bridgeIdentity` 重新插入一条未撤销的身份；
- 角色不会自动恢复，需要管理员重新授权，这是安全默认。

成员列表查询需要过滤：

```sql
WHERE ui.status <> 'revoked'
```

否则共享成员被解绑后，成员行还会显示一个已经失效的飞书 ID。

## 7. 接口设计

### 7.1 解绑预览

```http
GET /api/channel/unbind/preview?provider=feishu
```

权限：`CHANNEL_MANAGE`。

返回：

```json
{
  "provider": "feishu",
  "label": "飞书",
  "departments": 1,
  "users": 7,
  "roles": 1,
  "overrides": 0,
  "sessions": 0,
  "workspaces": 0,
  "identities": 12,
  "protectedUsers": 0,
  "crossChannelUsers": 0,
  "chatSessions": 0,
  "warnings": []
}
```

预览只读，不写库；页面用它做二次确认。

### 7.2 解绑

```http
POST /api/channel/unbind
Content-Type: application/json

{ "provider": "feishu", "confirm": true }
```

缺少 `confirm: true` 时返回 `EAB_VALIDATION`，不会执行任何清理。

返回：

```json
{
  "bindings": [...],
  "preview": {
    "provider": "feishu",
    "label": "飞书",
    "departments": 1,
    "users": 7,
    "roles": 1,
    "overrides": 0,
    "sessions": 0,
    "workspaces": 0,
    "identities": 12,
    "protectedUsers": 0,
    "crossChannelUsers": 0,
    "chatSessions": 0,
    "warnings": []
  },
  "removed": {
    "departments": 1,
    "users": 7,
    "roles": 1,
    "overrides": 0,
    "sessions": 0,
    "workspaces": 0,
    "identities": 12
  },
  "preserved": {
    "protectedUsers": 0,
    "chatSessions": 0
  },
  "crossChannelUsers": 0,
  "streamRefreshFailed": false
}
```

同一个渠道重复解绑：如果 `tenant_id` 已为空，继续返回现有的 `CONFLICT`，不重复清理。

## 8. 控制台交互

解绑按钮不再直接调用接口，改为：

1. 点击“解绑”；
2. 请求 `/api/channel/unbind/preview`；
3. 弹确认框，明确写出：
   - 将移除多少部门、多少成员、多少角色授权、多少渠道身份；
   - 有多少跨渠道身份成员会被一并移除（`crossChannelUsers`）；
   - 有多少 EAB 自有成员会被移到公司根部门（`protectedUsers`）；
   - 角色授权物理删除、聊天历史保留、个人工作区只归档；
4. 用户确认后带 `confirm: true` 调用解绑；
5. 成功后刷新顶栏公司来源、渠道页和组织页。

如果预览失败，不执行解绑，直接显示错误。

## 9. 审计与观测

- `audit_logs` 追加 `channel.unbind`，不修改历史；
- 返回结构里带 `removed / preserved` 计数，页面直接展示；
- 服务日志记录 provider、runId（可选）、耗时、刷新结果；
- 不写 `org_sync_runs` 的 `mode = 'unbind'`，避免现有同步历史页面把解绑当成一次同步；如果后续需要在同步历史里展示，再单独加迁移。

## 10. 验证计划

### 10.1 单元/集成

1. 飞书专属成员解绑：
   - 部门树删除 1 个渠道节点；
   - 命中飞书身份的成员从成员列表消失；
   - `user_roles` / `authz_overrides` 清空；
   - `channel_identities.revoked_at` 非空；
   - `user_identities.status = 'revoked'`；
   - 渠道配置为 `unbound`。
2. 跨渠道/网页身份成员按 2B 一并移除：
   - 成员行软删、角色和权限覆盖清空；
   - `crossChannelUsers` 只记录数量并在 `warnings` 提示，不改变删除结果；
   - 没有该渠道身份、只是挂在渠道部门下的 EAB 自有成员移到公司根部门并保留。
3. 钉钉方案 1B：
   - 钉钉 `channel = 'dingtalk'` 的部门和持有钉钉身份的成员全部清理；
   - 钉钉部门下的 EAB 自有成员移到公司根部门；
   - 飞书组织和飞书配置不受影响。
4. 重绑恢复：
   - 解绑后重新同步，成员按原 ID 恢复；
   - `user_identities.status` 回到 `active`，`stats.identitiesRestored` 递增；
   - 角色为空，需要重新授权。
5. 事务失败：
   - 在删部门前注入失败，确认成员、身份、配置均回滚。
6. 预览与实际一致：
   - 预览计数等于实际删除计数。
7. 接口守卫：
   - 不带 `confirm: true` 的解绑请求返回 `EAB_VALIDATION`，数据库无变化。

### 10.2 真实库验证

- 先复制 `.eab-dev/eab.db` 到临时目录，在副本上跑解绑；
- 确认预览计数对应的部门、成员从组织/成员/角色页消失；
- 重新绑定飞书，确认成员恢复；
- 不直接在唯一开发库上做不可逆测试。
- 已在真实开发库上只读验证预览弹窗与 `confirm` 守卫，未执行真实删除。

## 11. 回滚

- 代码回滚：恢复旧解绑接口即可，但已软删的数据不会自动回来；
- 数据回滚：解绑前备份 `.eab-dev/eab.db`；
- 软删行可以手工恢复 `deleted_at = NULL`、`status = 'active'`；
- `user_roles` 已物理删除，只能从备份恢复或重新授权；
- 部门 path 未改，恢复软删部门后组织树可原样出现。

## 12. 风险清单

1. **钉钉主组织被清空**：1B 已明确选择全量删除；真实执行前必须备份数据库并二次确认。
2. **跨渠道成员被移除**：2B 已明确选择直接移除，不再保留；用 `crossChannelUsers` 和 `warnings` 让管理员知情。
3. **角色来源不可追溯**：只能全删或保留；3A 选择全删。
4. **知识库 ACL**：不删 ACL，只软删部门；如果 ACL 依赖 dept path，部门失效后访问自然失效。
5. **重新绑定主键冲突**：保留 `user_identities` 行并增加 revoked→active 的同步逻辑，避免同 ID 插入冲突。
6. **唯一索引**：`user_identities` 唯一键不因软删释放；这是为了重绑复用，代价是该外部 ID 不能立刻给别的用户使用。
7. **历史会话**：默认保留；如果要彻底清，需单独加删除会话的开关。

## 13. 实现落盘与验证结果

### 13.1 代码位置

- `packages/server/src/channel-unbind.ts`：`buildPlan()` 计算清理范围，`previewChannelUnbind()` 只读预览，`executeChannelUnbind()` 单事务执行。
- `packages/server/src/routes/channel.ts`：新增 `GET /api/channel/unbind/preview`，改写 `POST /api/channel/unbind` 要求 `confirm: true`，提交后刷新飞书/钉钉连接。
- `packages/server/src/routes/org.ts`：成员身份查询过滤 `ui.status <> 'revoked'`。
- `packages/channel/src/apply.ts`：重绑时把 `revoked` 身份改回 `active`，`updateUser` 清空 `deleted_at`，成员按原 ID 恢复。
- `packages/channel/src/types.ts`：新增 `identitiesRestored` 统计。
- `packages/server/public/app.js`：解绑按钮改为调用 `openUnbindConfirm()`，弹窗先取预览，确认后带 `confirm: true` 提交。

### 13.2 自动化验证

- `packages/server/test/channel-unbind.test.ts`：3 条，覆盖飞书预览、飞书解绑、钉钉全量解绑与渠道隔离。
- `packages/channel/test/apply.test.ts`：新增 revoke → 重绑恢复用例。
- `pnpm typecheck`：通过。
- `pnpm test`：64 个文件、343 条用例全部通过。
- `node --check packages/server/public/app.js`：通过。

### 13.3 真实开发库只读验证

真实库 `c1` 的飞书预览：

```text
departments=1, users=7, roles=1, overrides=0, sessions=0, workspaces=0,
identities=12, protectedUsers=0, crossChannelUsers=0, chatSessions=0
```

其中 7 名命中飞书身份的成员 = 6 名组织同步成员 + 1 名早期飞书兜底成员「飞书用户 18cb6a」。后者没有 `user_identities`，但有未撤销的 `channel_identities`，按 2B 同样会被移除。控制台已实际打开确认弹窗并截图，随后取消，未执行真实解绑。`POST /api/channel/unbind` 不带 `confirm: true` 已验证返回 `EAB_VALIDATION`，数据库无变化。

### 13.4 真实库副本执行结果

在 `.eab-dev/eab.db` 的 SQLite 备份副本上实际执行，不改动唯一开发库：

- 飞书：删除 1 个渠道部门、7 名成员、1 条角色授权、12 条渠道身份；剩余 151 名活跃成员，配置变为 `unbound`。
- 钉钉：删除 14 个部门、151 名成员、302 条渠道身份、撤销 11 个网页会话；保留 7 条聊天历史、6 条飞书渠道身份、飞书组织和飞书配置不变；配置变为 `unbound`。

### 13.5 尚未验证

- 没有在真实库副本上完成“解绑 → 重新绑定飞书 → 成员按原 ID 恢复”的整条链路；重绑恢复目前由 `packages/channel/test/apply.test.ts` 的单元用例覆盖。
- 前端解绑成功后的刷新链路依赖 `loadCompanies / loadSync / switchChannelTab`，仅在预览弹窗和取消路径验证，未走真实成功回调。
