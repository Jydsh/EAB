# EAB 多级权限审批设计方案

> 状态：核心实现已落地（迁移 0061 与 0063、审批服务、员工端 API/工作台 UI、钉钉 A2UI 卡与回调、失败卡后台重发、管理端“权限审批”策略页）。2026-11-16 起员工端申请单位由“角色”改为“权限点”；历史角色申请保留可查看、可审批。
> 更新时间：2026-11-16
>
> 已拍板：
> 1. 申请入口：仅本人申请。
> 2. 申请对象：当前身份缺少的权限点（多角色取并集），可多选合并成一张单。
> 3. 审批链：按权限范围（scope）配置；一张单取所选权限中最严格的策略。
> 4. 授予粒度：通过后只写所选权限的临时授权，不写 `user_roles`、不新增角色。
> 5. 历史兼容：旧角色申请保留原审批与授权路径。
> 6. 钉钉卡片：复用 A2UI AI 卡片。

## 一、需求理解

把“申请权限”从控制台临时授权，升级成一条可追踪、可多级审批、能在钉钉长期停留的审批流程：

1. 成员本人在网页工作台发起权限申请，申请对象是自己。
2. 页面只展示当前身份缺少的权限点；已有权限不重复出现。
3. 勾选多个权限合并成一张申请单，审批链取所选权限中最严格的一条 scope 策略。
4. 每一级审批人都会在钉钉收到一张主动投放的 A2UI 审批卡片。
5. 卡片长期留在消息里，不因为超时、翻页或服务重启消失；直到点击“同意”或“拒绝”。
6. 最后一级同意后，系统只给申请人写入所选权限的临时授权，有效期由审批单决定，到期后读侧自动失效；不新增角色。
7. 任一级拒绝、申请人撤回、审批超时，都不授权，并留下可追踪状态。

关键点：审批卡不是“聊天回复的临时卡片”，而是一张**有数据库实例记录的长期卡片**。卡片本身留在钉钉会话里，审批状态以数据库为准，服务重启后仍能继续处理。

## 二、现状与可复用能力

### 2.1 可直接复用

| 能力 | 现有实现 | 复用方式 |
|---|---|---|
| 组织负责人 | `departments.manager_user_id`、`departments.parent_id`、`users.dept_id` | 从申请人部门逐级向上生成审批链 |
| 钉钉主动投放 | `DingTalkAICardStream.start()` 调 `/v1.0/card/ai/instances/createAndDeliver` | 给当前审批人主动发 A2UI 卡片 |
| 钉钉卡片回调 | `packages/server/src/dingtalk-bot.ts` 的 `handleDingTalkCardCallback` | 扩展 `approval_approve` / `approval_reject` 动作 |
| 异步任务 | `async_jobs` 表（`0049_async_jobs.sql`） | 卡片投递失败重试、超时扫描、通知 |
| 审计 | `appendAudit` | 每次发起、每级同意/拒绝、最终授权都记审计 |
| 角色与范围 | `roles`、`role_scopes`、`user_roles` | `requestable=1` 的角色提供“可申请权限点”的来源；scope 申请通过后只写 `permission_scope_grants`，不写 `user_roles` |

### 2.2 不建议直接复用 / 必须先修

- `approvals` 表（`0011_platform.sql`）是单级审批：只有 `requester_user_id / decided_by / status`，没有审批人、步骤、当前级、卡片实例、拒绝理由，无法承载多级。
- 钉钉澄清卡的进程内登记表 `dingtalk-clarify-sync.ts` 只适合短期澄清；审批卡必须把 `outTrackId` 落库，不能依赖内存。
- `roleCodesOf()` 已补上 `user_roles.expires_at` 过滤；权限点临时授权则在 `actorFor()` 读取 `permission_scope_grants` 时按 `expires_at` 过滤。
- `user_roles` 主键是 `(user_id, role_id)`，同一角色只能有一行；权限点申请改用 `permission_scope_grants(request_id, scope)` 单独记录，不经过 `user_roles`。

## 三、第一期范围

### 做

- 仅本人申请：`target_user_id = requester_user_id`。
- 申请对象是**权限点**：只列当前身份缺少的 scope；多角色取并集，已有权限不重复申请。
- 可申请范围：`roles.requestable=1` 的角色提供的 scope 并集，排除管理角色；每个候选 scope 必须有 `target_type='scope'` 审批策略。
- 勾选多个权限合并成一张申请单；scope 策略必须一致，取最多级数、最短超时、任一要求公司管理员兜底则保留兜底。
- 审批链默认策略：直属部门负责人 → 上级部门负责人 → 公司管理员，最多 3 级，自动去重、跳过申请人。
- 通过后只写 `permission_scope_grants`；不写 `user_roles`、不写角色授权记录、不新增角色。
- 有效期必填，默认 7 天，最大 30 天；最后一级通过开始计时，读侧到期自动失效。
- 历史角色申请保留原流程：可查看、可审批、通过后仍按角色授权。
- 钉钉 A2UI 审批卡：同意 / 拒绝；卡片长期保留；服务重启后仍可回调。
- 审批单列表、状态时间线、失败重发。
- 拒绝理由选填；拒绝后立即通知申请人。

### 暂不做

- 上级代申请、批量申请。
- 转交、代理、加签、或签、会签。
- 群聊审批卡（第一期只做私聊机器人卡）。
- 权限到期自动提醒（先靠 `expires_at` 过滤，提醒后续补）。

## 四、数据模型

新增迁移：`packages/storage/migrations/0061_permission_approvals.sql` 建审批主表；`0063_permission_scope_grants.sql` 增补权限点申请类型与临时授权表。

### 4.1 `permission_requests`

```sql
CREATE TABLE IF NOT EXISTS permission_requests (
  id                   TEXT PRIMARY KEY,
  company_id           TEXT NOT NULL,
  requester_user_id    TEXT NOT NULL,
  target_user_id       TEXT NOT NULL,
  request_type         TEXT NOT NULL DEFAULT 'role', -- 0063 增补；'role' 历史，'scope' 权限点
  role_id              TEXT NOT NULL,        -- scope 申请时为身份锚点，不产生角色授权
  role_code            TEXT NOT NULL,
  role_name            TEXT NOT NULL,
  scopes_json          TEXT NOT NULL,        -- 本次申请的权限集合快照
  reason               TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','approved','rejected','cancelled','expired')),
  current_step         INTEGER NOT NULL DEFAULT 1,
  total_steps          INTEGER NOT NULL DEFAULT 0,
  policy_id            TEXT,
  requested_expires_at INTEGER NOT NULL,     -- 授权到期时间
  request_expires_at   INTEGER NOT NULL,     -- 审批单自身超时时间
  granted_role_grant_id TEXT,                -- 仅历史 role 申请使用
  source               TEXT NOT NULL DEFAULT 'web',
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  decided_at           INTEGER,
  cancelled_at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_permission_requests_company_status
  ON permission_requests (company_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_permission_requests_requester
  ON permission_requests (company_id, requester_user_id, status);
```

### 4.2 `permission_approval_policies`

按 scope 配置审批链；角色申请时展开角色的 scope 集合匹配。

```sql
CREATE TABLE IF NOT EXISTS permission_approval_policies (
  id                   TEXT PRIMARY KEY,
  company_id           TEXT NOT NULL,
  target_type          TEXT NOT NULL DEFAULT 'scope'
                       CHECK (target_type IN ('scope','role')),
  target_key           TEXT NOT NULL,        -- scope 名，或 role code（role 级覆盖）
  max_levels           INTEGER NOT NULL DEFAULT 3,
  approver_strategy    TEXT NOT NULL DEFAULT 'dept_chain'
                       CHECK (approver_strategy IN ('dept_chain','fixed_users')),
  include_company_admin INTEGER NOT NULL DEFAULT 1,
  timeout_hours        INTEGER NOT NULL DEFAULT 72,
  fixed_approvers_json TEXT,                 -- approver_strategy=fixed_users 时使用
  enabled              INTEGER NOT NULL DEFAULT 1,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_permission_policy_target
  ON permission_approval_policies (company_id, target_type, target_key);
```

匹配规则：

1. `request_type='scope'`：每个勾选 scope 都必须有 `target_type='scope'` 策略，缺一条即拒绝申请。
2. 多个 scope 命中时，取最严格：级数最多、超时最短；任一策略要求公司管理员兜底则保留兜底。
3. 混用 `dept_chain` 与 `fixed_users` 不允许合并；多个 `fixed_users` 策略的审批人集合必须完全一致。
4. `request_type='role'`（历史）：先找角色级覆盖，否则展开角色 `role_scopes` 逐项匹配 scope 策略。
5. 没有策略的角色 = 不可申请；`company_admin / dept_admin / super_admin` 等管理角色默认不建策略。

### 4.3 `permission_approval_steps`

```sql
CREATE TABLE IF NOT EXISTS permission_approval_steps (
  id                  TEXT PRIMARY KEY,
  request_id          TEXT NOT NULL REFERENCES permission_requests(id),
  company_id          TEXT NOT NULL,
  step_no             INTEGER NOT NULL,
  approver_user_id    TEXT NOT NULL,
  approver_source     TEXT NOT NULL, -- dept_manager / parent_manager / company_admin / fixed
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','active','approved','rejected','skipped','expired')),
  comment             TEXT,
  card_out_track_id   TEXT,
  card_surface_id     TEXT,
  card_status         TEXT NOT NULL DEFAULT 'none'
                      CHECK (card_status IN ('none','sending','sent','failed')),
  notified_at         INTEGER,
  decided_at          INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE (request_id, step_no)
);
CREATE INDEX IF NOT EXISTS idx_permission_steps_approver
  ON permission_approval_steps (company_id, approver_user_id, status);
```

### 4.4 `permission_request_decisions`（幂等）

```sql
CREATE TABLE IF NOT EXISTS permission_request_decisions (
  id                  TEXT PRIMARY KEY,
  request_id          TEXT NOT NULL REFERENCES permission_requests(id),
  step_no             INTEGER NOT NULL,
  approver_user_id    TEXT NOT NULL,
  decision            TEXT NOT NULL CHECK (decision IN ('approve','reject','cancel','expire')),
  comment             TEXT,
  event_key           TEXT NOT NULL UNIQUE, -- approval:<requestId>:<stepNo>:<approverId>:<decision>
  created_at          INTEGER NOT NULL
);
```

同一张卡重复回调、网络重试、用户连点，都只能落一条 decision。

### 4.5 `permission_role_grants`（历史角色授权记录）

```sql
CREATE TABLE IF NOT EXISTS permission_role_grants (
  id                  TEXT PRIMARY KEY,
  company_id          TEXT NOT NULL,
  user_id             TEXT NOT NULL,
  role_id             TEXT NOT NULL,
  role_code           TEXT NOT NULL,
  request_id          TEXT NOT NULL,
  granted_by          TEXT NOT NULL,
  granted_at          INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL,
  revoked_at          INTEGER,
  UNIQUE (request_id)
);
CREATE INDEX IF NOT EXISTS idx_permission_role_grants_user
  ON permission_role_grants (company_id, user_id, role_code, expires_at);
```

`permission_role_grants` 记录“哪张审批单授了什么角色、到什么时候”，是审计和续期的权威记录。

### 4.6 `user_roles` 的写入

`user_roles` 仍是当前生效角色表，主键 `(user_id, role_id)`。最终同意时：

```sql
INSERT INTO user_roles (user_id, role_id, granted_by, granted_at, expires_at)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT (user_id, role_id) DO UPDATE SET
  granted_by = excluded.granted_by,
  granted_at = excluded.granted_at,
  expires_at = CASE
    WHEN user_roles.expires_at IS NULL THEN NULL
    WHEN excluded.expires_at IS NULL THEN NULL
    ELSE MAX(user_roles.expires_at, excluded.expires_at)
  END;
```

规则：

- 已有永久角色（`expires_at IS NULL`）不降级为临时角色。
- 多次临时授予取较晚的到期时间。
- 审批单拒绝/撤回/超时不写 `user_roles`。
- `roleCodesOf()` 修改为：

```sql
SELECT r.code
  FROM user_roles ur
  JOIN roles r ON r.id = ur.role_id
 WHERE ur.user_id = ?
   AND (ur.expires_at IS NULL OR ur.expires_at > ?)
 ORDER BY r.code
```

这是本次唯一会改变全局角色解析行为的改动，必须补测试。

以上 `permission_role_grants` / `user_roles` 写入只用于历史 `request_type='role'` 申请；权限点申请写入下面的 `permission_scope_grants`，不经过角色表。

### 4.7 `permission_scope_grants`（权限点临时授权）

```sql
CREATE TABLE IF NOT EXISTS permission_scope_grants (
  id           TEXT PRIMARY KEY,
  request_id   TEXT NOT NULL REFERENCES permission_requests(id),
  company_id   TEXT NOT NULL REFERENCES companies(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  scope        TEXT NOT NULL,
  granted_by   TEXT,
  granted_at   INTEGER NOT NULL,
  expires_at   INTEGER,
  revoked_at   INTEGER,
  created_at   INTEGER NOT NULL,
  UNIQUE (request_id, scope)
);
CREATE INDEX IF NOT EXISTS idx_permission_scope_grants_user
  ON permission_scope_grants (company_id, user_id, scope, expires_at);
```

- 最后一级同意时按勾选 scope 逐条写入，到期时间 = 通过时间 + 审批单有效期。
- `actorFor()` 只读取 `revoked_at IS NULL AND expires_at > now` 的记录，并入 `extraScopes`。
- 到期不删除记录，读侧过滤即可失效；记录保留用于审计。
- scope 申请不写 `permission_role_grants`、不写 `user_roles`、不新增角色；`granted_role_grant_id` 为 NULL。

## 五、审批链生成

输入：申请人、所选权限点、最严格策略。

1. 取申请人 `users.dept_id`。
2. 从该部门开始沿 `departments.parent_id` 向上：
   - 若 `manager_user_id` 非空，且不等于申请人，加入链；
   - 继续父部门。
3. 按策略 `include_company_admin` 追加一个在职 `company_admin`。
4. 去重，按策略 `max_levels` 截断。
5. 若最终为空：拒绝创建，返回“没有可用审批人，请先配置部门负责人”。
6. 审批人必须在职、未禁用、有 `approval:decide`；无权限的审批人跳过并记审计。
7. 仅本人申请，所以不存在“代申请人自己批自己”的场景；但仍禁止审批链包含申请人本人。

## 六、状态机

### 审批单

```
pending ──全部步骤 approve──> approved
   │
   ├──任一步 reject─────────> rejected
   ├──申请人 cancel─────────> cancelled
   └──request_expires_at 到──> expired
```

### 单个步骤

```
pending ──轮到──> active ──approve──> approved
                     │
                     ├──reject──> rejected
                     └──超时────> expired
```

规则：

- 只有 `active` 步骤能接受同意/拒绝。
- 只有当前步骤同意后，才激活下一步骤。
- 最后一步同意后，在一个事务内：步骤 approved → 审批单 approved → 写 `permission_role_grants` + `user_roles`。
- 任一步拒绝：当前步骤 rejected → 审批单 rejected → 其余 `pending/active` 步骤 `skipped`。
- 审批单过期：所有未决步骤 `expired`，不授权。

## 七、钉钉审批卡（A2UI）

### 7.1 卡片生命周期

1. 创建审批单时生成 `request_id` 和步骤。
2. 给当前审批人主动投递 A2UI 卡片：
   - `createAndDeliver`；
   - `openSpaceId = dtv1.card//im_robot.<审批人 externalUserId>`；
   - `callbackType = 'STREAM'`；
   - `outTrackId` 由服务端生成并**先写库**，再投递；
   - 投递失败：`card_status=failed`，用 `async_jobs` 重试，不阻塞审批单创建。
3. 卡片待审批期间保持 `PROCESSING`，但隐藏“思考中”，只显示审批信息与按钮。
4. 同意后：当前卡更新为“已同意，等待下一级/已通过”，若有下一级则新建卡片；当前卡按钮隐藏。
5. 拒绝后：当前卡更新为“已拒绝”，按钮隐藏；其余审批人的卡更新为“流程已结束”；通知申请人。
6. 最终通过：最后一张卡更新为“已通过”；写角色；通知申请人。

卡片不删除、不撤回，长期留在私聊消息里。用户翻旧消息仍能看到最终状态。

### 7.2 卡片字段

- 标题：权限审批
- 申请人
- 申请角色：角色名称
- 覆盖权限：角色的 scope 摘要（最多 5 条，超出显示“等 N 项”）
- 原因
- 有效期
- 当前进度：第 N / M 级
- 当前审批人
- 操作：同意 / 拒绝
- 拒绝后显示拒绝理由（若填写）

### 7.3 回调校验

`handleDingTalkCardCallback` 收到 `approval_approve` / `approval_reject` 后：

1. 按 `outTrackId` 查 `permission_approval_steps`，找不到直接拒绝。
2. 校验 `request` 仍为 `pending`，步骤仍为 `active`。
3. 校验回调人就是该步骤的 `approver_user_id`，不能只信卡片参数。
4. 校验回调人有 `approval:decide`。
5. 写 `permission_request_decisions`，`event_key` 唯一；重复回调直接返回当前状态。
6. 2 秒内 ACK；后续更新卡片、激活下一步、授权都放异步任务或事务后的异步流程。
7. 任何一步失败：记 `card_status` / 审计，留给重试任务；不能出现“已经授权但卡片没更新”或“卡片显示通过但没授权”。

### 7.4 服务重启恢复

- 卡片实例 `outTrackId` 已在 `permission_approval_steps` 落库。
- 回调只依赖数据库，不依赖进程内 Map。
- 重建 `DingTalkAICardStream` 时用已有 `outTrackId` 和 `surfaceId` 绑定，不需要重新创建卡。
- 若卡片被用户删除/撤回，回调失败时在审批单详情页显示“重新发送审批卡”。

## 八、API

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/permissions/config` | 可申请角色、匹配到的策略、当前用户是否能审批 |
| `POST` | `/api/permissions/requests` | 创建审批单；body：`roleCode / reason / durationHours` |
| `GET` | `/api/permissions/requests?mode=mine\|todo` | 我发起的 / 待我审批的 |
| `GET` | `/api/permissions/requests/:id` | 详情 + 步骤时间线 + 卡片状态 |
| `POST` | `/api/permissions/requests/:id/cancel` | 申请人撤回；仅 `pending` |
| `POST` | `/api/permissions/requests/:id/decide` | 网页端审批兜底；参数 `stepNo / decision / comment` |
| `POST` | `/api/permissions/requests/:id/resend-card` | 卡片投递失败时重发 |
| `GET/POST` | `/api/permissions/policies` | 员工端 `authz:grant` 可读写的策略接口 |
| `GET/POST` | `/api/console/permission-policies` | 管理端按权限点/角色配置审批链；scope 会做登记校验，固定审批人必须非空 |
| `POST` | `/api/console/permission-policies/roles/:code/requestable` | 管理端切换角色是否可被自助申请 |

已实现的管理端页面：`/admin` → 组织与权限 → 权限审批，包含“可申请角色”勾选、“按权限点/角色”的策略表单、现有策略表与编辑回填。策略保存后立即生效，员工端刷新即可看到新的审批链。

权限：

- 本人申请：`permission:request`（建议新增；不新增时可临时允许所有在职成员）。
- 查看待我审批：`approval:read`。
- 同意/拒绝：`approval:decide`。
- 管理策略：`company_admin` 或 `permission:policy`。

## 九、角色授权风险与前置修复

### 9.1 必须修 `roleCodesOf()`

当前 `roleCodesOf()` 没有过滤 `user_roles.expires_at`，到期角色仍会出现在 `actor.subject.roles`。第一期只授角色，必须改为：

```sql
WHERE ur.user_id = ?
  AND (ur.expires_at IS NULL OR ur.expires_at > ?)
```

并补测试：永久角色、未到期角色、已到期角色、续期后角色。

### 9.2 角色可申请白名单

不要让审批成为提权通道：

- 只有存在 `permission_approval_policies` 的角色才可申请。
- `super_admin`、`company_admin`、`dept_admin` 默认不建策略，不可申请。
- 角色的每个 scope 都必须命中策略；缺一个就拒绝申请。
- 角色范围变更后，旧申请仍按申请时的 `scope_snapshot_json` 审批；授权写当前角色，风险在“角色范围扩大”时由策略重新匹配拦截。建议角色 scope 变更时，暂停该角色的新申请并复核。

### 9.3 到期与撤销

- `roleCodesOf()` 过滤 `expires_at`，到期即失效。
- `permission_role_grants` 作为审计记录；控制台撤销角色时，标记 `revoked_at` 并 `DELETE`/失效对应 `user_roles` 行。
- 到期后不自动删 `user_roles` 行，但解析不再返回该角色；后台可定期清理过期行。

## 十、通知

| 事件 | 通知对象 | 方式 |
|---|---|---|
| 发起成功 | 申请人 | 钉钉文本 / 工作台提示 |
| 轮到下一级 | 下一级审批人 | 钉钉审批卡（主动投放） |
| 某级同意 | 申请人 | 文本 + 审批单状态 |
| 拒绝 | 申请人 | 文本 + 理由 |
| 最终通过 | 申请人 | 文本 + “角色已生效至 X” |
| 超时 | 申请人、所有未决审批人 | 文本 + 卡片终态 |

## 十一、安全与审计

- `roleCode` 只能来自服务端可申请角色列表，不能前端任意传。
- 目标就是申请人；仍校验在职、未禁用、同公司。
- 审批人每级重新校验身份、步骤状态、审批单状态、`approval:decide`。
- 审批链最多 3 级，防止部门树异常导致无限链。
- 每次创建、发卡、同意、拒绝、撤回、授权、撤销都写 `appendAudit`。
- 卡片参数不可信；所有状态以数据库为准。
- 拒绝理由、申请原因长度限制 500 字。

## 十二、测试计划

### 纯逻辑

- 策略匹配：角色级覆盖、scope 级匹配、多 scope 取最严格、缺策略拒绝、管理角色拒绝。
- 审批链：直属、父部门、公司管理员兜底、去重、跳过申请人、缺失负责人、超过 3 级。
- 状态机：2 级全通过、1 级拒绝、2 级拒绝、撤回、超时、重复同意、重复拒绝。
- 角色授权：写入 `permission_role_grants` + `user_roles`；重复审批单不重复授权；已有永久角色不被降级；续期取较晚到期。
- `roleCodesOf()`：未到期返回、到期不返回、`expires_at NULL` 永久返回。

### 卡片

- 创建卡片时 `outTrackId` 写库；投递失败进入重试。
- 服务重启后，用 `outTrackId` 重建卡片并更新状态。
- 回调人不是当前审批人 → 拒绝。
- 非 `active` 步骤回调 → 拒绝。
- 重复回调 → 不产生第二条 decision，不重复授权。
- 同意后旧卡按钮隐藏、下一级卡发出；拒绝后所有未决卡结束。

### 真机

- 私聊主动投放审批卡是否成功；是否需要 `openConversationId`。
- 卡片在消息里停留超过 24 小时仍可点击。
- 服务重启后点击旧卡仍能审批。
- 同意后角色在网页/钉钉下一次请求立即生效；到期后不再生效。
- 拒绝后卡片文案、理由、通知是否符合预期。

## 十三、实施顺序

1. 先修 `roleCodesOf()` 到期过滤，补测试。
2. 迁移 + 策略表 + 审批链计算 + 创建/查询 API。
3. 审批状态机 + 角色授权 + 审计。
4. A2UI 审批卡 + 主动投递 + 回调校验。
5. 重试/超时/重发卡。
6. 工作台审批列表与时间线。
7. 测试与真机验收。

## 十四、已拍板结论

- 申请入口：仅本人申请。
- 审批链：按权限范围（scope）配置；角色申请展开 scope 取最严格策略，无策略不允许申请。
- 授予粒度：只授角色；前置修复 `roleCodesOf()` 的 `expires_at` 过滤。
- 钉钉卡片：复用 A2UI AI 卡片；`outTrackId` 落库，服务重启后可恢复。
  以上为 2026-11-15 角色申请阶段结论；2026-11-16 起员工端申请单位改为权限点，见第十五节。

## 十五、2026-11-16 权限点申请落地

### 数据兼容

- `permission_requests` 增加 `request_type`，默认 `'role'`；新权限点申请写 `'scope'`。
- 历史表的 `role_id` / `role_code` / `role_name` 仍为 `NOT NULL`。scope 申请写入申请人的一个现有角色作为“身份锚点”，只用于满足表结构和审计上下文；审批通过不会授予该角色。
- `scopes_json` 统一保存本次申请的权限集合：role 申请存角色全部 scope，scope 申请存勾选 scope。
- 新增 `permission_scope_grants`：`(request_id, scope)` 唯一，记录 `granted_by`、`granted_at`、`expires_at`、`revoked_at`。迁移文件 `0063_permission_scope_grants.sql`。
- `permission_role_grants` 与 `user_roles` 只服务历史 role 申请，scope 申请不写入。

### 读侧生效

- `actorFor()` 在角色 scope、`permission_overrides` 之后读取未过期、未撤销的 `permission_scope_grants`，并入 `extraScopes`。
- `buildSubject()` 继续做 `implies` 展开与 deny 过滤。
- 到期无需后台任务：读侧按 `expires_at > now` 过滤，记录保留用于审计。

### 申请与审批

- `GET /api/permissions/config` 返回 `roles`（兼容旧调用）、`scopes`（当前可申请权限点）、`currentScopes`（当前身份已有权限摘要）。
- `POST /api/permissions/requests` 接受 `scopeCodes: string[]`；为空时仍接受历史 `roleCode`。
- 可申请权限来源：`requestable=1` 的非管理角色提供的 scope 并集；排除当前身份已有权限；排除没有 `target_type='scope'` 策略的权限。
- 相同权限集合已有 pending 单时直接复用；不同集合另建单。
- 多权限策略必须一致；混用 `dept_chain` 与 `fixed_users`，或多个固定审批人集合不一致时拒绝合并。合并后取最多级数、最短超时、任一要求公司管理员兜底。
- 最后一级通过：`request_type='scope'` 调用 `grantScopes()` 逐条写 `permission_scope_grants`；`request_type='role'` 继续原 `grantRole()`。

### 前端与卡片

- 工作台申请面板改为按分组展示 scope 复选框，顶部展示当前已有权限 chips；提交体 `{ scopeCodes, reason, durationHours }`。
- 我的申请与详情按 `requestType` 区分：scope 显示“申请权限：…”与“权限点（通过后只授予所选权限，不新增角色）”；role 历史单仍显示角色。
- 钉钉审批卡：scope 卡正文写“申请权限 + 授权方式”，标题用权限列表；role 卡保持“申请角色 + 权限范围”。
- 管理端“权限审批”页把“可申请角色”解释为“开放申请的角色”，即决定员工端可申请的权限点范围。
