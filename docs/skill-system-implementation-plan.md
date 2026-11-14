# EAB 技能体系实施计划（与插件同级）

> 状态：S1–S5 已落盘并通过真实路由/无头浏览器验收；S6 的提示词边界与工具声明白名单已完成，运行时工具门、公司总开关、隔离复核和审计冗余待做。
>
> 日期：2026-11-14

## 1. 目标与边界

技能是 EAB 的内建扩展，与插件同级：独立后台、独立权限、独立生命周期、独立前端入口、独立审计。实现上继续使用独立 `skill_*` 表，不把技能并入插件表；两者共享“安装 / 启停 / 卸载 / 列表 / 分级”的产品语言，但不共享危险执行面。

当前开放范围：

- L0：纯提示词业务知识，不声明工具。
- L1：只读技能，只能声明只读 scope。
- L2：可声明 EAB 已知工具，但工具调用仍受角色权限、审批和现有工具路由约束。
- L3：页面/Host 技能暂不开放，安装时直接 high 拒绝。

已支持 GitHub 仓库、tar.gz / zip 直链和服务器目录三种安装来源（2026-11-14 补充网络来源）；不在当前范围：npm/catalog 远程安装、脚本执行白名单、技能页面 Host、技能市场、跨公司共享技能。

## 2. 已完成基线

| 阶段 | 内容 | 证据 |
|---|---|---|
| S1 数据与权限 | `skill_*` 表、`SC.SKILL_LIST/USE/INSTALL/UNINSTALL/CONFIGURE/APPROVE`、内置角色授权、`0052` 迁移 | 真实 DB 迁移；member 迁移前 403、迁移后 200；`company_admin` 六项全开 |
| S2 包结构与扫描 | 200 文件 / 单文件 512KB / 总计 4MB；拒绝 symlink、脚本和可执行文件；扫描 `skill.json`、`SKILL.md`、`references/`、`assets/` | 单测覆盖破坏命令、代码执行、凭证读取、外发、提权、持久化、提示词注入、网络攻击、恶意软件 |
| S3 安装、隔离与生命周期 | critical/high 拒绝安装；写 `skills/.quarantine` 元数据；`install/update/install_blocked/load_blocked/checksum_mismatch/enable/disable/uninstall` 事件 | 真实高风险包 400 + 隔离文件；篡改后 `valid:false`；恢复后重新 `valid:true`；启停/卸载 200 |
| S4 员工工作台 | `/chat` 工作台“插件 / 技能”切换、技能列表、详情、安装弹窗、启停/卸载；只显示本人安装 | 无头 Chrome 真实点击通过；`title=技能工作台`、`badge=仅本人技能`、`1已装/1启用/0拦截` |
| S5 管理端公司级治理 | 控制台 `/api/console/skills/*`；新增一级“技能管理”页、制品表、风险与 checksum、公司安装/启停/卸载、最近 40 条事件 | 无头 Chrome 真实登录点击通过；页面显示制品、风险、事件、安装弹窗；真实 API 公司安装/启停/卸载均已验证 |

内置技能 `eab-fixed-doc-edit` 已修正 `tools` 为 EAB 真实工具名：`office.read_outline`、`office.read_range`、`office.replace`、`office.format`、`office.insert`。修正后重新安装风险为 `low`、`findings:[]`。

## 3. S6：运行时隔离与多层冗余

### 3.1 威胁模型

- T1 提示词注入：技能正文试图覆盖系统规则、伪造系统消息、隐藏行为。
- T2 越权工具：技能声明或在正文中诱导调用未授权、破坏性、外发或提权工具。
- T3 安装后篡改：磁盘文件被替换，但 DB 仍保留旧 checksum。
- T4 供应链执行：`scripts/`、`.sh/.ps1/.bat/.py/.js/.exe/.dll` 等被执行。
- T5 高风险命令：删除、格式化、读取凭证、关闭防护、持久化、反弹 shell。
- T6 运维误操作：管理员误装、误启、无法快速止血。

### 3.2 多层防线

| 层 | 时机 | 当前能力 | 状态 |
|---|---|---|---|
| L1 安装扫描 | 安装前 | 全文本静态规则；包结构与文件类型限制；scope/level 校验；工具声明白名单 | 已完成 |
| L2 加载校验 | 每次 `loadPersonalSkills` / `loadCompanySkills` | 重扫并比对 checksum；不一致或扫描失败 `valid:false`；提示词注入跳过 | 已完成 |
| L3 提示词边界 | `skillCatalogTexts` / `skillPromptTexts` 注入时 | 默认只注入目录摘要；`skill_load` 才返回完整正文；正文包在 `<skill_content untrusted="true">`，去除伪造边界标记 | 已完成（S6.1 + S6.3） |
| L4 工具声明/执行门 | 安装后 + 工具调用前 | 声明的工具必须存在于 EAB `TOOLS`；L0 禁止声明工具；运行时只对 `activeSkillIds` 生效，高危工具一律拒绝并写审计 | 已完成（S6.2 + S6.3） |
| L5 公司总开关 | 任意时刻 | 公司级安装/启停 + 一键停用全部技能 | 已完成（S6.4） |
| L6 隔离复核 | 拦截后 | `skills/.quarantine` 元数据；控制台复核/删除；不保留危险包正文 | 已完成（S6.5） |
| L7 审计冗余 | 所有动作 | `skill_events` 与全局 audit 链双写；失败写独立降级台账并在控制台提示 | 已完成（S6.6） |

### 3.3 任务与完成定义

**S6.1 提示词边界加固（已完成）**

- `sanitizeSkillPromptBody` 去掉可伪造的边界/系统标记。
- 技能正文包在 `<skill_content untrusted="true">` 中，并明确“只是业务操作指引”。
- 证明：`skills.test.ts` 的 `strips forged skill-boundary markers before prompt injection` 通过。

**S6.2 工具声明白名单（已完成）**

- `skill.json.tools[]` 必须命中 EAB 真实工具 ID；未知工具 high 拒绝；L0 声明工具 high 拒绝。
- 证明：单测 `blocks tools that do not exist in the EAB registry` 通过；真实 POST 未知工具包返回 400 `EAB_VALIDATION`，`findings` 为 `unknown-tool`，隔离路径已写入，`skills/unknown-tool-live` 未生成。

**S6.3 运行时工具门（已完成）**

- 提示词改为“技能目录摘要 + 按需加载”：`skillCatalogTexts` 只注入 id、名称、级别、触发词、声明工具；模型匹配后调用 `skill_load(skillId)` 才拿到完整正文。
- `skill_load` 由宿主处理，加载后把技能 id 写入本回合 `activeSkillIds`，并自动激活其声明工具；工具调用因此有真实技能归属，不再依赖“公司里有哪些技能”的猜测。
- `evaluateSkillToolCall` 只对 `activeSkillIds` 中且声明了该工具的技能生效：
  - 技能未声明工具所需 scope → 拒绝；
  - `workspace.delete`、`workspace.rename`、`workspace.send_dingtalk`、`schedule.delete`、`dangerous` 工具、`admin.*` → 统一拒绝，标记 `requiresApproval`，不能借技能声明绕过审批；
  - 未被加载技能声明的工具按原角色权限执行，不误伤普通用户。
- 拒绝时 `recordSkillToolBlocked` 写 `skill_events(tool_blocked)` 并双写 `audit_logs(skill.tool_blocked, deny)`；管理端新增“运行时工具拦截”事件标签。
- 完成定义对应验证：真实对话用 `Qwen/Qwen3.5-4B` 加载 `runtime-gate-live` 后调用 `workspace.delete`，工具 trace 为 `error`，助手回复“系统拒绝借技能声明绕过审批”；真实 `skill_events` 与 `audit_logs` 各出现一条 `tool_blocked`/`deny`。普通技能 `eab-fixed-doc-edit` 的真实 `skill_load` 成功，返回完整说明。

**S6.4 公司级总开关（已完成）**

- 新增 `0053_skill_company_policy.sql` 与 `skill_company_policy` 表；默认开启，`companySkillsEnabled` 读取公司状态。
- `skillPromptTexts` 在注入前统一检查总开关；关闭后不注入任何公司/个人技能，个人技能不能绕过。`loadCompanySkills` 仍保留给控制台展示，避免管理员看不到已安装制品。
- `POST /api/console/skills/policy` 写总开关并记录 `company_policy` 事件；控制台技能页提供状态徽标、停用/启用按钮和确认弹窗。
- 真实 `/api/console/skills` 返回 `policy.enabled=true`；POST 关闭后返回 `false`，再开启返回 `true`；`/api/my/skills` 仍显示 1 个已装技能，未被卸载。

**S6.5 隔离记录复核与删除（已完成）**

- `GET /api/console/skills/quarantine` 只返回隔离元数据（id、时间、risk、findings、checksum、文件名、复核状态），不回传危险包正文，不提供“直接恢复执行”。
- `POST /api/console/skills/quarantine/review` 需要 `SKILL_APPROVE`：`acknowledge` 写复核人、时间、备注并保留元数据；`delete` 删除元数据文件。文件名必须是 `.quarantine` 下的普通 `.json`，拒绝路径穿越。
- 控制台增加复核状态、备注、`标记已复核`、`删除…` 按钮和二次确认弹窗；说明“危险包正文从未保留，不能从这里还原执行”。
- 设计边界：不做“还原执行”。隔离时只保留元数据，不复制危险包内容；需要该技能时，必须由管理员重新提供完整包并重新扫描。
- 真实接口：安装 `review-live-test` 触发隔离；`acknowledge` 返回 `review.status=acknowledged`，`delete` 返回 `deleted=true`，隔离列表从 3 条回到 2 条。

**S6.6 审计冗余（已完成）**

- `eventOf` 在写 `skill_events` 后同步写全局 `appendAudit`，动作格式 `skill.<event>`，资源类型 `skill`，拦截类事件结果 `deny`，其余 `success`。
- 审计写失败不回滚、不改变安装/启停/卸载结果；除服务端 warning 外，新增 `0054_skill_audit_degraded.sql` 独立降级台账，记录 company、skill、event、actor、失败原因和时间。
- `/api/console/skills` 返回 `audit.degradedCount` 与最近失败；控制台增加“审计降级”面板和顶部徽标；台账写失败时仍有进程内计数兜底。
- 单测确认：删除 `audit_logs` 后安装技能，`skill_events(install)` 成功，`skill_audit_degraded` 记录 1 条失败，`skillAuditHealth` 返回 `degradedCount=1`。
- 真实：安装与启停均产生 `skill.install` / `skill.company_policy` 审计；隔离复核产生两条 `skill.quarantine_review` 审计。

### 3.4 S6 验收口径

- `pnpm exec vitest run packages/server/test/skills.test.ts` 全通过。
- `pnpm typecheck` exit 0；本机内存不足时，至少对 `skills.ts`、`routes/chat.ts` 及其依赖跑 scoped `tsc`，并记录未跑完整检查。
- 真实 8787：安装、启停、卸载、拦截、篡改、未知工具、提示词标记各至少一条真实请求证据。
- 真实 8788：管理端技能页可登录、可看到制品/风险/事件/安装弹窗；S6.4 后增加总开关与隔离记录。
- 不把“代码存在”当成“运行时生效”：每条防线都要有真实入口或单测的区分性证据。

## 4. S7：审批流与工具参数校验（已完成）

### S7.1 技能高危工具运行时审批（已完成）

- `skill_load` 归属仍然是前提：只有当前轮加载过、且技能 `tools[]` 声明了该工具，才进入技能运行时门；未加载或未声明时沿用正常工具流程。
- 新增 `validateSkillToolArguments`：按 `TOOLS` 的真实 `input` 校验 required/type/enum/array/object；高危工具额外拒绝未知参数。
- 高危工具（`workspace.delete`、`workspace.rename`、`workspace.send_dingtalk`、`schedule.delete`、`tool.dangerous`、`admin.*`）额外校验：
  - `fileId` / `path` 至少一个，`fileId` 限格式与长度；
  - `path` / `newName` 必须是相对路径，拒绝绝对路径、盘符、`..`、`~` 和空字节；
  - `path` 上限 512、`newName` 上限 255、普通字符串上限 4000；
  - `schedule.delete` 的 id 只允许安全字符集。
- 审批绑定“技能 + 工具 + 同一组参数”：`skill-tool:<toolId>:<skillId>`，`resource_id` 为稳定排序参数的 sha256 前 20 位。
- 审批单 TTL 30 分钟；pending 复用，过期 pending 置 `expired`；approved 单在放行时把 `expires_at` 置为当前时间，做到一次消费。
- 同一参数未审批时抛出 `EAB_APPROVAL_REQUIRED`，错误里带审批单号、工具和技能；管理员通过后用同一组参数重试即可放行。参数变化会生成新审批单，不能复用。
- 事件链：`tool_approval`（建待办）、`tool_approved`（消费放行）、`tool_approval_approved` / `tool_approval_rejected`（管理端决定）；均双写全局审计 `skill.<event>`。
- 管理端审批页把 `skill-tool:` 动作显示为“技能高危工具 · <toolId>”，并展示技能名、参数预览和中文状态；不再直接显示内部 action。
- 审批通过后仍由 `executeTool` 内现有角色白名单和工具 handler 继续校验，技能门不替代角色权限，只增加一层前置拒绝。

### S7.2 安装/变更审批（已完成）

- 公司级安装固定走“准备待办 → 管理员审批 → 原入口重提同一包”：
  - `POST /api/console/skills/install` 先 `previewSkillInstall` 获取 `skillId/name/version/checksum/risk/level/sourcePath/alreadyInstalled`；目录已存在且未选择覆盖时，在创建/消费审批前直接返回 409 `EAB_CONFLICT`，避免可预见冲突消耗审批。
  - `ensureSkillInstallApproval` 负责 approved 查询/消费、过期 pending 置 `expired`、pending 复用和新建待办；公司动作 `skill-install:<skillId>`，`resource_id=<checksum>:<0|1>`，TTL 30 分钟。
  - 未审批时返回 HTTP 202 `EAB_APPROVAL_REQUIRED`，`details` 带 `approvalId/skillId/checksum/scope`；管理员通过后重提同一目录，原子把 approved 单 `expires_at=now` 并安装，返回 `approvalId`。
  - 安装前用 `expectedChecksum` 复核包内容；审批后包变化会拒绝安装。已消费的审批不能复用，重复提交会生成新 pending。
- 个人安装按公司策略：
  - `skill_company_policy.require_personal_install_approval` 默认 0；控制台策略 GET 返回该字段，POST 可只传 `enabled` 或只传 `requirePersonalInstallApproval`，两者都不传报校验错误。
  - 开启后 `/api/my/skills/install` 先在 staging 落临时目录，再走同一套审批；动作 `skill-install-user:<skillId>`，resource 仍绑定 checksum 与覆盖选择；审批资源只保存 `sourceRef`，不保存临时目录路径。
  - 关闭时保持原有直接安装路径。个人安装与公司同 id 且目录已存在、又未选择覆盖时，在审批前返回 409，不消费审批。
- `installSkillPackage` 增加 `expectedChecksum` 与 `approvalId`；安装事件 detail 增加 `sourceRef`、`approvalId`；新增事件 `install_approval`、`install_approval_approved`、`install_approval_rejected`、`install_approved`，并双写全局审计 `skill.<event>`。
- 管理端审批页把两类动作显示为“公司级技能安装 · <名称> / 版本 / 来源路径”和“个人技能安装 · <名称> / <id>”；技能页增加“个人安装审批：已开启/未开启”开关；安装弹窗遇到 202 显示审批单号、审批页链接和“审批通过后重试同一目录”；员工聊天遇到 202 显示“已提交安装审批”，保留已选文件。
- 新增迁移 `0055_skill_personal_install_policy.sql`，为策略表增加 `require_personal_install_approval INTEGER NOT NULL DEFAULT 0`。
- 真实验收（2026-11-14）：
  - 公司包 `install-approval-live`（checksum `404445ccf6eda749900c`）：首次 POST 202，审批单 `01M7CDFQGGZNAER5GKKCH99YKH`，`skills/install-approval-live` 未生成、制品数未变；审批页无头 Chrome 显示 1 行“公司级技能安装 · 技能安装审批验收”、待审批、1 个通过按钮；批准后同一路径重提 200，`approvalId` 为该单；再次提交生成新 pending `01M7CDGYYAA0BQ0TYGT259AXS9`，证明旧单已消费；该重复单随后被拒绝并写 `install_approval_rejected`。
  - 个人包 `install-approval-user-live`（checksum `1441bd616362e0ffc872`）：策略开启后首次 POST 202，审批单 `01M7CDSC88PRR43M1ZRJ2KY6NC`；批准后重提 200，`scope=user` 落盘，`/api/my/skills` 返回该技能；再次提交目录已存在，409 且未新建审批。
  - 同 id 公司技能存在时，个人无覆盖提交在审批前 409，未消耗任何审批。
  - 审批页同时显示公司/个人安装待办和已通过记录，`chipTexts` 覆盖两类标签；员工安装成功后个人列表只出现本人技能。
- 清理与基线：测试技能目录、测试源、4 条审批单和对应安装记录已删除；`require_personal_install_approval` 恢复 0；管理端回到 1 个制品、2 条隔离、0 审计降级、0 审批。
- 检查：`skills.test.ts` 20/20；`pnpm typecheck` exit 0；`app.js`、`chat.js` `node --check` exit 0。
- 未覆盖/待决：审批在安装成功前消费，IO/配额等不可预检失败仍会消耗审批；`alreadyInstalled` 预检只覆盖“未选择覆盖且目录已存在”的可预见冲突。员工聊天 pending 提示只做静态检查，未做浏览器交互验收。

## 5. S8：内置目录与升级（后续）

- 建立内置技能 catalog/seed，解决 `skillRoot` 与仓库内置包目录重合导致“安装内置包先 409”的问题。
- 增加版本比较、升级/回滚、内置技能只读保护。
- 自定义角色不会自动获得 `skill:*`，需要显式授权；后台角色页应展示技能权限分组。

## 6. 待决定

1. 技能继续独立 `skill_*` 表，还是并入插件 `kind=skill` 统一表。当前实现为独立表。
2. L2 是否允许实际工具调用，还是只允许声明并由宿主按需执行。当前允许声明，S6.3 已按 `skill_load` 归属做运行时门，S7 已加逐工具参数校验和高危工具审批单；角色白名单仍在 `executeTool` 内独立校验。
3. 高风险隔离是否保留原始危险包供管理员复核。当前只保留 JSON 元数据。
4. 是否开放 `scripts/` 白名单执行。当前一律拒绝。
5. 公司总开关是全局策略还是按部门/角色细分。
6. 安装审批在落盘前消费；IO/配额等不可预检失败是否要回滚审批、或改为安装成功后再消费。当前对可预见的目录冲突已在审批前拦截。
7. 个人与公司同 id 技能共用 `skills/<id>` 目录；是否禁止同名、拆分目录，或只允许同内容覆盖。当前未选择覆盖时直接 409。

## 7. 操作入口与回归

- 员工工作台：`http://127.0.0.1:8787/chat`，工作台右上切换“插件 / 技能”。
- 管理端：`http://127.0.0.1:8788/admin?goto=skills`，一级“技能管理”。
- 技能 API：`/api/my/skills`、`/api/my/skills/install`、`/api/my/skills/:id/state`、`/api/my/skills/:id`。
- 控制台 API：`/api/console/skills`、`/api/console/skills/install`、`/api/console/skills/:id/state`、`/api/console/skills/:id`。
- 回归：`pnpm exec vitest run packages/server/test/skills.test.ts`、`pnpm typecheck`、`node --check packages/server/public/app.js`、`node --check packages/server/public/chat.js`。

### 7.1 2026-11-14 本轮验证

- `skills.test.ts`：17/17 通过，新增 `skill_load` 目录摘要、运行时工具门、高危拒绝、逐工具参数校验、审批单参数绑定/一次性消费、隔离复核/删除、审计降级台账。
- 类型检查：S6.4–S6.6 后完整 `pnpm typecheck` exit 0；S6.3 后完整检查受本机可用内存限制未跑完，`skills.ts` + `routes/chat.ts` 的 scoped `tsc` 通过。
- `app.js` / `chat.js`：`node --check` 通过；本轮 `skills.ts`、`routes/skills.ts`、`routes/chat.ts` scoped `tsc` exit 0。
- 真实 `skill_load`：`Qwen3.8-27B-FP8` 收到“固定字段技能”请求后调用 `skill_load(eab-fixed-doc-edit)`，trace `done`，返回完整 `<skill_content>`，助手按技能第一步回答。
- 真实运行时工具门：`Qwen/Qwen3.5-4B` 加载 `runtime-gate-live` 后调用 `workspace.delete`，trace `error`，助手回复“系统拒绝借技能声明绕过审批”；`skill_events(tool_blocked)` 与 `audit_logs(skill.tool_blocked, deny)` 各一条。测试技能已卸载。
- 真实隔离复核：`review-live-test` 安装被 400 拒绝并写隔离；控制台 `acknowledge` 后状态 `acknowledged`、复核人 `console-operator`；`delete` 后隔离记录移除；产生两条 `skill.quarantine_review` 审计。
- 真实控制台接口：`/api/console/skills` 返回 `permissions.approve=true`、`audit.degradedCount=0`、`quarantine=2`。
- 真实安装修正后的 `eab-fixed-doc-edit`：200，`risk:low`，`findings:[]`，`tools` 为 5 个真实 `office.*` 工具。
- 真实 POST 未知工具包：400 `EAB_VALIDATION`，finding `unknown-tool`，隔离文件 `skills/.quarantine/unknown-tool-live-2026-11-14T04-58-17-098Z.json`，`skills/unknown-tool-live` 未生成。
- 真实总开关：`/api/console/skills` 返回 `policy.enabled=true`；POST 关闭返回 `false`，再开启返回 `true`；`/api/my/skills` 仍为 1 个已装、1 个启用。
- 真实隔离查询：`GET /api/console/skills/quarantine` 返回 2 条，仅元数据，无危险包正文。
- 真实审计：`audit_logs` 出现两条 `skill.company_policy`；单测确认安装产生 `skill.install`。
- 管理端 `/admin?goto=skills`：无头 Chrome 真实登录点击通过，显示“技能管理”、公司总开关已启用、1 个制品、checksum、公司安装按钮、2 条隔离记录（每行有复核/删除按钮）、审计降级面板“审计链路正常”、最近事件和安装弹窗。
- 测试制品 `runtime-gate-live` 已从 `skills/` 和 `skill_installs` 清除；隔离测试包 `review-live-test` 只留下被拒/复核事件，不再出现在制品列表。
- 8787/8788 已用最终代码重启，`/api/health` 的 chat/admin 端口与后端均 ready；`/api/my/skills` 200。
- S7 单测：17/17 通过；完整 `pnpm typecheck` exit 0；`app.js` / `chat.js` `node --check` exit 0。
- S7 真实审批：员工加载 `runtime-gate-live` 后调用 `workspace.delete(path=runtime-gate-approval.txt)`，首次返回 `EAB_APPROVAL_REQUIRED`，审批单 `01M7CCG0WPP2MW36DJ2MG864HE`；控制台通过后同一组参数重试，工具 `status=done`，文件 `recycled=true`。
- S7 一次性消费：再次同参数调用生成新审批单 `01M7CCJ71YAQN3M6EXYVKMDSR5` 并重新拦截，证明已通过审批不会二次放行；随后在控制台拒绝该单。
- S7 事件链：真实产生 `tool_approval`、`tool_approved`、`tool_approval_approved`、`tool_approval_rejected`，并双写 `audit_logs(skill.tool_approval|skill.tool_approved|skill.tool_approval_approved|skill.tool_approval_rejected)`。
- S7 管理端审批页：无头 Chrome 登录后显示 2 条记录，动作为“技能高危工具 · workspace.delete”，含“运行时工具门测试”和 `{"path":"runtime-gate-approval.txt"}` 参数预览，状态显示“已通过 / 已拒绝”。
- S7 验收清理：`runtime-gate-live` 目录、个人/公司安装记录、两条测试审批单已清理；管理端制品恢复为 1 个（`eab-fixed-doc-edit`），隔离仍为 2 条，审计降级 0；技能事件与审计链保留作为验收证据。
### 7.2 2026-11-14 S7.2 安装审批验收

- `skills.test.ts` 20/20 通过；新增安装审批 checksum 绑定/一次性消费、审批后包变化拒绝、个人安装策略与 `alreadyInstalled` 预检断言；完整 `pnpm typecheck` exit 0。
- 公司真实验收：`install-approval-live` 首次 202 `EAB_APPROVAL_REQUIRED`，审批单 `01M7CDFQGGZNAER5GKKCH99YKH`；审批页 1 行待审批；通过后同路径重提 200 并落盘；重复提交生成新 pending `01M7CDGYYAA0BQ0TYGT259AXS9`，拒绝后产生 `install_approval_rejected`。
- 个人真实验收：`install-approval-user-live` 首次 202，审批单 `01M7CDSC88PRR43M1ZRJ2KY6NC`；通过后重提 200，`scope=user` 落盘，`/api/my/skills` 可见；再次提交 409，未新建审批。
- 预检：公司同 id 已安装时个人无覆盖提交直接 409，审批单数量不变。
- 管理端无头 Chrome：审批页同时显示公司级/个人技能安装 chip，待审批按钮 2 个；截图 `.eab-dev/admin-approvals.png`。
- 清理：测试技能目录、测试源、4 条审批单、安装记录已删除；`require_personal_install_approval` 恢复 0；基线恢复 1 制品、2 隔离、0 审计降级、0 审批。
- 未验证：员工聊天 pending 提示只做 `node --check`；审批在安装成功前消费，IO/配额失败语义见第 6 节待决项。

### 7.3 2026-11-14 网络来源技能安装

- 控制台 `POST /api/console/skills/install` 扩展为统一来源：`source=git|http|server-path`，字段 `repo/ref/subdir/url/path/overwrite`；个人 `POST /api/my/skills/install` 支持 `git|http|browser-dir`，服务器路径仍拒绝。别名 `github→git`、`url/archive→http` 保持兼容。
- 新增 `packages/server/src/skill-network.ts`：GitHub 仓库通过 API 解析默认分支、codeload 下载 `tar.gz`，支持 `ref` 与仓库顶层目录内 `subdir`；直链按 magic bytes 识别 `.tar.gz/.tgz/.zip`；解包后优先根目录、最多下钻 4 层查找同时含 `skill.json` 与 `SKILL.md` 的技能根。
- 安全边界：只允许公网 HTTPS；本机/内网来源默认拒绝，需显式设置 `EAB_SKILL_ALLOW_PRIVATE_NETWORK=1`；URL 禁止账号密码；下载前 DNS 解析拒绝私网/本机地址；压缩包上限 12MB、条目最多 1000、解压后总量 16MB；拒绝绝对路径、盘符、`..`、反斜杠和符号链接；下载超时 60s；只读包内容，不执行脚本或 Git hooks。
- 来源标识：`sourceRef` 对压缩包 URL 去掉 query，避免签名 token 进入数据库/审计；GitHub 记录为 `github:owner/repo#ref?dir=subdir`。临时下载目录 `eab-skill-github-*` / `eab-skill-url-*` 在安装结束的 `finally` 中清理。
- 管理端安装弹窗改为 GitHub 仓库 / 压缩包 URL / 服务器目录三个来源 tab，默认新安装选 GitHub，更新按现有 `sourceRef` 预填；带下载/扫描/审批流程说明和进度条，202 时显示审批单号与审批页链接。员工工作台安装弹窗同样支持本机文件夹 / GitHub / 压缩包 URL。
- 验收：`pnpm typecheck` 通过；`skill-network.test.ts` 3/3、`skills.test.ts` 21/21 通过。临时实例真实路由：压缩包 URL 安装 `network-skill-e2e` 首次 202、审批后 200，返回 `source=http`、`sourceRef=url:http://127.0.0.1:8791/network-skill-e2e.tar.gz`；模拟 GitHub 子目录安装 `network-skill-git` 返回 `source=git`、`sourceRef=github:owner/repo#main?dir=skills%2Fnetwork-skill-git`；个人网络安装返回 `scope=user`。无头 Chrome 确认三来源 tab、默认 GitHub、切换压缩包 URL 面板和进度条，Runtime 无异常；截图 `.eab-dev/admin-skills-network-install.png`。临时库、技能目录与进程已清理，真实 8788 数据未改动。
- 未覆盖：GitHub 私有仓库 token、npm/catalog 来源、内网 Git/制品库接入；如企业需要内网来源，需确认网络边界后开启 `EAB_SKILL_ALLOW_PRIVATE_NETWORK`。
