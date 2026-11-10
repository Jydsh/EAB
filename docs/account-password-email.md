# 账号密码、钉钉 ID 绑定与邮箱重置密码设计

## 1. 现状

现在并不是“没有账号密码”，而是能力不完整：

- `users` 已有 `password_hash`，`password.ts` 用内置 scrypt 做哈希。
- `POST /api/auth/login` 已支持用**工号、邮箱或手机号**登录，失败 5 次锁 10 分钟。
- `POST /api/auth/password` 已支持已登录成员改密码，但**必须提供旧密码**。
- 控制台已有 `POST /api/console/members/:id/password`，管理员可重置成员密码并吊销会话。
- 登录页已有「账号密码」Tab；设置页目前只有「我的记忆」「我的权限」「退出登录」，没有账号安全入口。
- 钉钉身份在 `user_identities`：`provider = 'dingtalk'`，`external_user_id` 是钉钉企业 UserID，`union_id` 是跨企业 unionId。
- 没有邮箱验证、验证码表、SMTP 配置，也没有“忘记密码”链路。

所以本轮要补的是四件事：

1. 让钉钉 UserID 也能作为账号密码登录的标识。
2. 让通过钉钉登录、但还没有密码的成员可以**本人首次设置密码**。
3. 增加邮箱绑定与验证码校验。
4. 增加“忘记密码 → 邮箱验证码 → 重置密码”闭环，并给控制台增加 SMTP 配置。

## 2. 设计原则

- **不另建一套账号体系**：密码仍写在 `users.password_hash`，钉钉身份仍写在 `user_identities`；不新增 `user_credentials` 表，避免同一个人出现两条账号记录。
- **钉钉 ID 是登录标识，不是密码载体**：登录时按 `user_identities.external_user_id` 反查 `users.id`，密码校验仍作用于 `users.password_hash`。
- **邮箱必须验证后才可用于重置密码**：只“填了邮箱”不够，验证码校验通过后写 `users.email_verified_at`。
- **重置密码不暴露账号是否存在**：请求验证码时统一返回“如果该账号已绑定邮箱，验证码已发送”。
- **重置后强制吊销全部会话**，当前浏览器重新登录；修改密码沿用现有“吊销全部 + 给当前浏览器重签”的做法。
- **单公司实例**：所有查询都带 `company_id`，登录页不增加公司选择器。

## 3. 账号标识与登录流程

### 3.1 允许的登录标识

账号密码登录的 `account` 支持三种，按以下顺序解析：

1. `users.employee_no`（工号），大小写不敏感。
2. `users.email`（必须是已绑定邮箱；未验证邮箱也允许登录，但重置密码不可用）。
3. `user_identities.external_user_id`（钉钉企业 UserID），仅 `provider = 'dingtalk'` 且 `status = 'active'`。

解析 SQL 示意：

```sql
SELECT u.id, u.company_id, u.name, u.employee_no, u.email, u.password_hash,
       u.status, u.disabled_at, u.deleted_at
  FROM users u
  LEFT JOIN user_identities ui
         ON ui.user_id = u.id
        AND ui.provider = 'dingtalk'
        AND ui.status = 'active'
 WHERE u.company_id = ?
   AND u.deleted_at IS NULL
   AND (
        lower(u.employee_no) = lower(?)
     OR lower(u.email) = lower(?)
     OR ui.external_user_id = ?
   )
 ORDER BY
   CASE
     WHEN lower(u.employee_no) = lower(?) THEN 0
     WHEN lower(u.email) = lower(?) THEN 1
     ELSE 2
   END
 LIMIT 1
```

- 命中后校验 `password_hash`、成员状态、公司状态；失败统一提示“账号或密码不正确”。
- 登录页文案从「工号或邮箱」改为「工号、邮箱或钉钉 UserID」。
- 如果同一个标识命中多个人（历史脏数据），不猜测，返回统一失败并写审计，交由管理员处理。

### 3.2 首次设置密码

已通过钉钉扫码登录、但 `password_hash IS NULL` 的成员，可以在设置页直接设置密码，不需要旧密码：

```text
设置页「账号安全」→「设置登录密码」
  → 输入新密码 + 确认
  → POST /api/auth/password { newPassword }
  → 服务端看到 password_hash 为空，允许直接写入
  → 审计 auth.password.set
```

已有密码的成员走「修改密码」，仍然要求旧密码：

```text
POST /api/auth/password { oldPassword, newPassword }
  → 校验旧密码 → 写入新哈希 → 吊销全部会话 → 重签当前会话
  → 审计 auth.password.change
```

接口语义：

| 场景 | `password_hash` | 请求体 | 结果 |
|---|---|---|---|
| 首次设置 | 空 | `{ newPassword }` | 允许，写哈希 |
| 修改 | 非空 | `{ oldPassword, newPassword }` | 旧密码必须正确 |
| 管理员重置 | 任意 | 控制台现有接口 | 写哈希并吊销全部会话 |

密码策略沿用 `password.ts`：8–128 位，scrypt 哈希，不存明文；新密码不能和旧密码相同。

## 4. 邮箱绑定与验证

### 4.1 数据

`users.email` 已存在，新增：

```sql
ALTER TABLE users ADD COLUMN email_verified_at INTEGER;
```

- `email`：当前展示/接收验证码的邮箱。
- `email_verified_at`：验证码校验通过的时间；为空表示未验证。
- 组织同步如果会覆盖 `users.email`，同步逻辑要保留 `email_verified_at` 的语义；本设计默认同步不改邮箱，若要改，需先把验证状态清空，避免把未验证地址当成已验证。

邮箱唯一性：

```sql
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_company_email
  ON users (company_id, lower(email))
  WHERE email IS NOT NULL AND deleted_at IS NULL;
```

迁移前先检查同一公司是否存在重复邮箱；有重复时先让管理员处理，不能直接建索引导致迁移失败。

### 4.2 绑定流程

```text
设置页「账号安全」→「绑定邮箱」
  → 输入邮箱
  → POST /api/auth/email/code { email }
  → 服务端向该邮箱发 6 位验证码
  → 输入验证码
  → POST /api/auth/email/verify { email, code }
  → 校验通过：users.email = email, users.email_verified_at = now
  → 审计 auth.email.bind
```

规则：

- 只有已登录成员可以绑定/换绑邮箱。
- 换绑时先验证新邮箱，验证通过后才替换旧邮箱；旧邮箱不参与新验证码的发送。
- 邮箱已被同公司其他有效成员占用时，返回“该邮箱已被使用”，不透露具体是谁。
- 绑定成功后给旧邮箱发一封“邮箱已变更”通知（可选，SMTP 已配置时发送）。

### 4.3 验证码存储

新增表：

```sql
CREATE TABLE IF NOT EXISTS auth_email_codes (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL,
  user_id      TEXT NOT NULL REFERENCES users(id),
  email_norm   TEXT NOT NULL,
  purpose      TEXT NOT NULL,              -- verify_email | reset_password
  code_hash    TEXT NOT NULL,              -- sha256(code + salt)
  salt         TEXT NOT NULL,
  expires_at   INTEGER NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  consumed_at  INTEGER,
  created_at   INTEGER NOT NULL,
  request_ip   TEXT,
  request_ua   TEXT
);

CREATE INDEX IF NOT EXISTS idx_auth_email_codes_user
  ON auth_email_codes (user_id, purpose, created_at DESC);
```

- 验证码 6 位数字，有效期 10 分钟。
- 同一 `user_id + purpose` 只保留最近一条未消费记录；新验证码生成时把旧记录标为失效（或直接删除）。
- 校验最多 5 次，超过即失效；校验成功后 `consumed_at` 落库，不能重放。
- 发送冷却 60 秒；同一成员 1 小时最多 5 封；同一 IP 1 小时最多 10 封。
- 验证码只存哈希和盐，日志里不打印明文验证码。

## 5. 忘记密码流程

登录页「账号密码」面板下增加「忘记密码？」入口。

```text
忘记密码
  → 输入账号（工号 / 邮箱 / 钉钉 UserID）
  → POST /api/auth/password/reset/request { account }
  → 服务端解析成员：
       - 不存在 / 已停用 / 没有已验证邮箱 → 仍然返回统一成功文案，不发送
       - 有已验证邮箱 → 生成 reset_password 验证码并发送
  → 输入邮箱收到的验证码 + 新密码
  → POST /api/auth/password/reset/confirm { account, code, newPassword }
  → 校验验证码 → 写新哈希 → 吊销全部会话
  → 审计 auth.password.reset
  → 前端回到登录页，提示“密码已重置，请用新密码登录”
```

统一文案：

> 如果该账号已绑定并验证过邮箱，验证码已经发送，请检查邮箱。

这条文案避免把“账号不存在 / 未绑定邮箱 / 已停用”变成账号枚举接口。

失败与限流：

- 验证码错误：提示“验证码不正确或已过期”，不区分具体原因。
- 超过 5 次：当前验证码作废，要求重新获取。
- 重置成功后，所有会话立即失效，包括当前浏览器。

## 6. 邮件服务（SMTP）

现在项目没有邮件发送能力，需要新增。

### 6.1 依赖与模块

新增 `nodemailer`（Node 没有内置 SMTP 客户端，手写 SMTP 协议不划算）。新增模块：

```text
packages/server/src/mailer.ts
```

职责：

- 从 `deps.config.dbPath` 读取 SMTP 配置；
- 密码从 `secrets.json` 取（沿用 `storeSecret` / `resolveSecret`）；
- `sendMail({ to, subject, text, html })`；
- 发送失败返回可分类错误，不把 SMTP 密码写进日志；
- 提供 `verifyMailConfig()` 供控制台“测试发送”使用。

### 6.2 配置存放

扩展 `ConsoleSettings`（`.eab-dev/console-settings.json`）：

```json
{
  "mail": {
    "enabled": true,
    "host": "smtp.example.com",
    "port": 465,
    "secure": true,
    "username": "noreply@example.com",
    "fromName": "EAB 企业智能体",
    "fromAddress": "noreply@example.com",
    "secretRef": "EAB_SMTP_PASSWORD"
  }
}
```

- `secretRef` 只存引用名，真实密码在 `.eab-dev/secrets.json` 或环境变量。
- 控制台接口只返回 `configured` / `secretConfigured`，不回显密码。
- 没有配置 SMTP 时，绑定邮箱和重置密码接口返回 `MAIL_NOT_CONFIGURED`，前端提示“邮件服务未配置，请联系管理员”。
- 开发机可选 `EAB_MAIL_DEV_LOG=1`，把验证码写进服务端日志，仅限本地调试；正式环境不要打开。

### 6.3 控制台入口

在控制台新增「邮件服务」页或「系统设置 → 邮件服务」卡片：

- 开关：启用/停用
- SMTP 主机、端口、SSL/TLS
- 发件人名称、发件邮箱
- 用户名、密码（密码只写不读）
- 「发送测试邮件」按钮，收件人默认当前操作员邮箱或手填
- 保存审计 `ops.mail.config`

## 7. API 设计

### 7.1 已有接口扩展

| 方法 | 路径 | 变更 |
|---|---|---|
| `POST` | `/api/auth/login` | `account` 增加钉钉 UserID 解析；文案更新 |
| `POST` | `/api/auth/password` | `password_hash` 为空时允许只传 `newPassword`；有密码时仍要求 `oldPassword` |

### 7.2 新增接口

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| `GET` | `/api/auth/account` | 已登录 | 返回密码/邮箱/钉钉绑定状态 |
| `POST` | `/api/auth/email/code` | 已登录 | 向待绑定邮箱发送验证码 |
| `POST` | `/api/auth/email/verify` | 已登录 | 校验验证码并写入 `email/email_verified_at` |
| `POST` | `/api/auth/password/reset/request` | 未登录 | 按账号解析成员并发重置验证码 |
| `POST` | `/api/auth/password/reset/confirm` | 未登录 | 验证码 + 新密码，重置并吊销会话 |
| `GET` | `/api/console/mail` | 控制台 | 读取邮件配置（不回显密码） |
| `PUT` | `/api/console/mail` | 控制台 | 保存配置，密码写 secrets |
| `POST` | `/api/console/mail/test` | 控制台 | 发送测试邮件 |

`GET /api/auth/account` 返回示例：

```json
{
  "password": { "configured": true, "updatedAt": "..." },
  "email": { "address": "li**@example.com", "verified": true, "verifiedAt": "..." },
  "dingtalk": { "bound": true, "userIdMasked": "0217****353", "unionIdMasked": "..." }
}
```

邮箱和钉钉 ID 只返回脱敏值，完整值不通过接口回显。

## 8. 前端设计

### 8.1 登录页

`chat.html` 的账号密码面板：

- 账号输入 label：`工号、邮箱或钉钉 UserID`
- 密码输入下增加一行：`忘记密码？`（链接）
- 点击后在同一登录卡内切到重置面板，不跳新页面：
  - 账号
  - 「获取验证码」按钮（60 秒倒计时）
  - 验证码
  - 新密码 / 确认新密码
  - 「重置密码」
  - 返回「账号密码登录」
- 统一成功文案，不区分账号是否存在。

### 8.2 设置页

在现有 `settings-stage` 增加一组「账号安全」，放在「个人设置」之后、「账号 → 退出登录」之前：

```text
账号安全
  登录密码     未设置 / 已设置        ›
  邮箱         未绑定 / li**@x.com 已验证 ›
  钉钉绑定     已绑定 · 0217****353   ›
```

点击行打开右侧/弹层表单，沿用现有设置页的卡片、字体和行高，不新造一套视觉。

**登录密码弹层**

- 未设置：只显示新密码、确认新密码，按钮「设置密码」。
- 已设置：显示旧密码、新密码、确认新密码，按钮「修改密码」。
- 成功后提示并刷新行状态。

**邮箱弹层**

- 当前邮箱（脱敏）
- 新邮箱输入
- 「发送验证码」按钮 + 60 秒倒计时
- 验证码输入
- 「保存邮箱」
- 未配置 SMTP 时按钮禁用并提示联系管理员。

**钉钉绑定弹层**

- 只读展示：已绑定 / 未绑定、钉钉 UserID 脱敏、unionId 脱敏、绑定时间。
- 不提供“解绑”按钮（避免登录渠道被误删）；需要解绑走管理员流程。

## 9. 安全与审计

- 登录、重置请求失败都返回统一文案，避免账号枚举。
- `account` 统一 `trim`；邮箱按小写归一化；钉钉 UserID 保留原值（数字串）。
- 密码哈希沿用 scrypt，校验用 `timingSafeEqual`。
- 验证码哈希 + 盐，不存明文；只保留最近一条有效码。
- 重置/修改密码后 `revokeAllSessions`，防止旧会话继续使用。
- 邮件发送不把验证码、SMTP 密码写日志；只在调试开关下打印。
- 审计事件：
  - `auth.password.set`
  - `auth.password.change`
  - `auth.password.reset.request`
  - `auth.password.reset`
  - `auth.email.bind`
  - `auth.email.verify.fail`
  - `ops.mail.config`
- 审计 detail 只记录脱敏邮箱、结果、IP，不记录密码/验证码。

## 10. 迁移与实施顺序

### 迁移

`packages/storage/migrations/0027_account_security.sql`：

1. `ALTER TABLE users ADD COLUMN email_verified_at INTEGER;`
2. 建 `auth_email_codes` 表与索引。
3. 预检重复邮箱后再建 `uq_users_company_email`；如果生产库有重复，先不建唯一索引，改为应用层校验，等管理员清理后再补迁移。

### 实施顺序

1. **数据与密码基础**：迁移、`/api/auth/login` 支持钉钉 UserID、`/api/auth/password` 支持首次设置。
2. **邮件基础设施**：`mailer.ts`、console settings 扩展、控制台邮件配置与测试发送。
3. **邮箱验证与重置**：验证码表、发送/校验/重置接口、限流与审计。
4. **前端**：登录页忘记密码、设置页账号安全三行与弹层。
5. **测试**：单元 + 路由 + 真实 SMTP 手工验证。

### 验证清单

- 工号、邮箱、钉钉 UserID 三种标识都能登录；错误密码统一提示。
- 钉钉扫码登录但无密码的成员，可在设置页首次设置密码；设置后可用钉钉 UserID + 新密码登录。
- 已有密码成员改密码必须旧密码正确；修改后其他浏览器会话失效。
- 绑定邮箱收到 6 位验证码；错误码/过期码/超次数都被拒绝；验证成功后 `email_verified_at` 落库。
- 忘记密码：有已验证邮箱才发码；账号不存在/未验证邮箱也返回统一文案。
- 重置成功后旧密码失效、所有会话失效、新密码可登录。
- SMTP 未配置时接口返回明确错误；控制台测试邮件可收到。
- 重复邮箱、已停用成员、已删除成员、跨公司标识都不能登录。

## 11. 需要确认的四个口径

1. **登录标识**：是否就按「工号 / 邮箱 / 钉钉 UserID」三种，不额外引入自定义用户名？推荐是。
2. **首次设置密码**：钉钉登录后的成员是否允许自助设置，不需要管理员审批？推荐允许。
3. **邮箱验证**：是否必须验证通过后才允许用于重置密码？推荐必须。
4. **SMTP**：正式环境用哪家 SMTP、发件邮箱是什么？需要提供主机、端口、账号、密码；没有的话先按控制台配置 + 开发日志兜底。
