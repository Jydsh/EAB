# 工具按角色可用

## 目标与口径

工具角色默认值分两类：

- **内置工具**默认对**所有角色**可用。管理员可以在控制台「知识与模型 → 工具」里改成「指定角色」，只有拥有这些角色的成员才能看到并调用。
- **个人插件工具**默认**不授权任何角色**，且**不进入平台工具注册表**。安装个人插件只完成注册和页面/工具发现，不会自动把工具下发给安装人；个人工具只留在安装人的个人工作台，管理员在「插件管理 > 个人插件详情」里为 `plugin:<pluginId>:<toolName>` 选择角色后，该工具才对该角色开放。
- **公司插件工具**沿用历史默认：没有配置行时按 `all` 处理；也可以显式改成指定角色。

这是一层**附加限制**，不替代工具原有的 `scope` 校验：

- 内置工具没有配置行 → 按 `all` 处理；
- 个人插件工具没有配置行 → 按 `none` 处理；
- 公司插件工具没有配置行 → 按 `all` 处理；
- `mode = all` → 所有角色可用；
- `mode = roles` → 只有角色白名单命中的成员可用；
- `super_admin` 对内置工具和公司插件工具始终放行，避免管理员配错后把自己锁在门外；个人插件工具仍按安装人隔离，平台超管也不能代替安装人执行；
- 角色白名单和 `scope` **同时满足**才放行。没有 `scope` 的角色即使被加入白名单，仍然会被原有鉴权拦截。

插件工具同样按 `plugin:<pluginId>:<toolName>` 归并配置。同一插件的公司实例、个人实例共享这份角色白名单，避免同一工具在不同安装位置出现两套权限。个人插件实例仍然只属于安装人，个人工具也不会进入平台工具注册表；共享的只是“这个插件工具允许哪些角色使用”的配置。

## 数据模型

迁移：`packages/storage/migrations/0048_tool_role_access.sql`

```sql
tool_role_settings(company_id, tool_id, mode, updated_at)
tool_role_bindings(company_id, tool_id, role_code, created_at)
```

- `mode` 只允许 `all` / `roles`；
- 主键分别是 `(company_id, tool_id)` 和 `(company_id, tool_id, role_code)`；
- `tool_role_bindings` 上给 `role_code` 建了索引；
- 没有 `tool_role_settings` 行时：内置工具视为 `all`，公司插件工具视为 `all`，个人插件工具视为 `none`；
- `mode = roles` 且白名单为空表示没有角色命中；个人插件工具即使安装人是平台超管，也只能由安装人本人执行，平台超管不能代替他人；控制台会显示警告；
- 不需要为历史内置/公司插件工具补数据；个人插件工具要开放给角色时必须显式写一行。

## 服务端接入点

### 角色判断

`packages/server/src/tool-role-access.ts`

| 函数 | 作用 |
|---|---|
| `listCompanyRoleOptions(db, companyId)` | 返回公司角色的 `code / name / builtin / members`，供控制台选择 |
| `pluginToolAccessId(pluginId, toolName)` | 生成插件工具的配置键 `plugin:<pluginId>:<toolName>` |
| `readToolRoleAccess(db, companyId, toolId)` | 读单个工具配置，没有行返回 `{ mode: 'all', roles: [] }`（内置工具语义） |
| `readToolRoleAccessMap(db, companyId)` | 一次读出全公司配置；插件工具据此区分“没有行 = 默认拒绝” |
| `toolAllowedForRoles(access, roleCodes, defaultAllow = true)` | 纯函数：`super_admin` 直接放行；无配置时按 `defaultAllow`；`all` 放行；`roles` 要求交集 |
| `toolRoleAccessReady(db)` | 判断 0048 表是否已迁移；旧库/单测没有表时插件工具沿用历史默认放行 |
| `toolAllowedForActor(db, actor, toolId)` | 按当前 `actor.subject.roles` 判断 |
| `setToolRoleAccess(db, companyId, toolId, { mode, roles })` | 事务内写 settings + bindings，校验未知角色，支持 `all` 清空白名单 |

### 内置工具

`packages/server/src/routes/tools.ts`

- `toolSpecsForActor`：在原有 `dangerous`、`scope`、`toolAllowedInSpace` 条件之外，增加角色白名单判断；
- `executeTool`：找到工具后、`requireScope` 前再次判断角色，不通过抛 `EAB_FORBIDDEN`，提示管理员去「工具」页调整；
- `toolSpecsForAgent`：对话首轮的核心工具也走同一份过滤，因此角色配置对“模型能看到哪些工具”同样生效；
- `GET /api/tools`：`available` 改为 `scope && role`；
- `POST /api/tools/:id/invoke`：内置工具调用前做同样的角色判断。

### 插件工具

`packages/server/src/plugin-tools.ts`

- `PluginToolActor.subject.roles` 可选；
- `pluginToolSpecsFor`、`resolvePluginToolForActor`、`resolvePluginToolByCatalogId` 同时要求 `agent:tool:invoke` 和角色白名单；
- 没有 `tool_role_settings` 行时，**个人插件工具**默认 **不授权任何角色**；公司插件工具沿用历史默认 `all`。配置成 `roles` 后按当前角色过滤；
- `pluginToolCatalogFor` 的 `available` 改为 `本人实例/公司实例 && agent:tool:invoke && role`；`allCompanyInstances` 让管理员在个人插件详情里读取全公司（含员工个人安装）的插件工具，管理员看到的个人工具 `available = false`，只能配置角色，不能试运行；平台工具注册表调用时额外传 `scope: 'company'`，因此不会展示任何个人插件工具；
- 新增 `resolvePluginToolByCatalogId`，按完整目录 id `plugin:<instanceKey>:<toolName>` 定位工具。

`POST /api/tools/:id/invoke` 的插件分支改走 `resolvePluginToolByCatalogId`，不再按第一个冒号拆 `pluginId/functionName`。这同时修正了旧实现按实例目录 id 调用插件工具会拆错的问题。

### 控制台 API

`packages/server/src/routes/console.ts`

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/console/tools/access` | 默认只返回内置工具与公司插件工具（`tools` 仍含 `id / accessId / mode / roleCodes / available / personal`，但 `personal` 均为 `false`）；个人插件详情需要配置角色时带 `includePersonal=1`，此时才返回全公司个人插件工具；个人插件未配置时 `mode = 'none'`，公司插件未配置时 `mode = 'all'` |
| `PUT` | `/api/console/tools/:id/roles` | body `{ mode?: 'all' | 'roles', roles?: string[] }`；内置 id 与插件目录 id / `accessId` 都接受，统一换算成 `accessId` 后写入 |

每次写入记审计 `tool.access.update`，`resourceType = tool`，`detail` 保留 `toolId / name / mode / roles`。

删除自定义角色时，同时删除 `tool_role_bindings` 中该 `role_code` 的行，避免白名单指向已删除角色。

## 控制台交互

`packages/server/public/app.js` / `app.css`

- 平台工具表只展示内置工具与公司插件工具：
  - 内置工具默认显示「所有角色」；
  - 公司插件工具未配置仍显示「所有角色」；
  - `mode = roles` 显示角色 chip；
  - 白名单为空显示「未选择角色」；
  - 每行有「配置角色」按钮。
- 个人插件工具**不进入平台工具表**。它们只在安装人的个人工作台出现；管理员进入「插件管理 > 个人插件详情」后，才会在详情底部看到该安装人的工具列表和「配置角色」按钮，仍不能试运行或代替安装人执行。
- 弹窗内是「所有角色 / 指定角色」单选：
  - 个人插件工具打开时默认停在「指定角色」，未勾选任何角色；公司插件工具未配置时停在「所有角色」；
  - 指定角色时显示角色复选框（角色名、code、成员数）；
  - 未选择任何角色时显示琥珀色警告：插件工具保存后不会下发给任何成员；内置工具保存后除平台超管外无人可用；
  - 保存调用 `PUT /api/console/tools/:id/roles`，成功后关闭弹窗；平台工具表刷新列表，个人插件详情只刷新工具块；
  - 打开时焦点落到关闭按钮，关闭后恢复到触发按钮。
- 「工具说明」已补充“个人插件工具不进入平台注册表”、角色白名单与 `scope` 的关系、审计和插件默认行为。

## 个人插件与个人角色

个人插件（`plugin_user_installs`）先按安装人隔离，再按当前登录人的角色权限收口：

| 操作 | 入口 | 需要的权限 |
|---|---|---|
| 查看本人插件清单、打开页面、页面 RPC / 网关 | `GET /api/my/plugins`、`/api/my/plugins/:id/host`、`/rpc`、`/gateway/*` | `plugin:list` |
| 安装个人插件 | `POST /api/my/plugins/install` | `plugin:install` |
| 启停个人插件 | `POST /api/my/plugins/:id/state` | `plugin:configure` |
| 卸载个人插件 | `POST /api/my/plugins/:id/uninstall` | `plugin:uninstall` |
| 对话中调用个人插件工具 | 工具下发与 `POST /api/tools/:id/invoke` | `agent:tool:invoke` + 插件工具角色白名单（未配置默认拒绝） |

`GET /api/my/plugins` 额外返回 `permissions.install / uninstall / configure / invokeTools`，个人工作台据此禁用无权限按钮并显示锁定说明，不再让员工点完才收到 403。内置 `MEMBER_SCOPES` 默认只有 `plugin:list`；存量公司若通过「角色管理」给普通员工补授了 `plugin:install / plugin:configure / plugin:uninstall`，员工就能操作**本人**安装的插件，但仍然不能操作别人的个人插件。

个人插件工具的角色键仍是 `plugin:<pluginId>:<toolName>`，与同插件的公司实例共享白名单；实际是否可见还取决于当前登录人的 `subject.roles`，不会因为插件是本人安装就绕过角色限制。个人插件工具不进入平台工具注册表，也不会出现在其他员工的 `/api/tools` 或控制台工具表里。

安装个人插件不等于获得工具：插件工具未配置角色时默认拒绝；管理员在「插件管理 > 个人插件详情」为工具选择角色后，拥有该角色且具备 `agent:tool:invoke` 的安装人才能在对话和 `POST /api/tools/:id/invoke` 中拿到该工具。个人工作台会在「工具」页显示 `已授权给当前角色 / 当前角色未授权`，不再假装工具已经下发给模型。

## 验证

- `pnpm typecheck` 通过；
- `packages/server/test/tool-role-access.test.ts`，8 项通过：
  - 内置工具没有配置时 member / auditor 都能看到 `time.now`；
  - 限制到 `company_admin` 后，member 目录消失、`executeTool` 403，admin 与 super_admin 仍可用；
  - 恢复 `all` 后配置读回为空白名单；未知角色、非法 mode 被拒绝；
  - 对话首轮核心工具 `workspace.read` 同样按角色过滤；
  - 插件工具 `plugin:<pluginId>:<toolName>` 共享配置，auditor 看不到、member 可见；
  - 个人插件工具没有配置行时默认不下发；配置 `member` 后才可见，证明“安装插件不会自动获得工具”；
  - 公司插件工具在角色表就绪后仍沿用默认所有角色，避免既有公司插件被一并停用；
  - 控制台默认目录不展示其他员工个人工具；`scope: 'company'` 即使叠加 `allCompanyInstances` 也不展示个人工具；带 `includePersonal=1` 的目录能看到并拿到 `pluginId`，供个人插件详情配置角色；管理员对这些个人工具的 `available` 固定为 `false`，不能试运行或代替安装人执行。
- 相关既有测试 `tool-search / plugin-tools / plugin-tool-capacity / tool-lock` 11 项通过；
- 真实服务（SQLite + PostgreSQL 审计）实测：
  - 平台工具注册表返回 **18 个内置工具 + 3 个公司插件工具**，个人插件工具不进入该列表；
  - 个人插件详情带 `includePersonal=1` 时返回 12 个插件工具，其中个人插件工具 9 个（李鹏 4 个、李建川 5 个）、公司 `dsh-ding-card` 3 个；
  - 普通员工李鹏的 `dsh-cy-api` 4 个个人工具只在 `/api/my/plugins` 个人工作台出现；`/api/tools` 不返回这 4 个工具；
  - `PUT plugin:dsh-cy-api:cy_api_dsh_list -> member` 后，只有 `cy_api_dsh_list` 在个人工作台变为可用，其余 3 个仍为不可用；公司 `dsh-ding-card` 3 个工具在平台注册表仍可用；
  - 员工工具页显示「4 个工具 · 1 个已授权」；概览显示“1 个已按当前角色授权”；
  - 管理员的 `includePersonal=1` 目录能读到全部 12 个插件工具，其中 9 个个人工具带 `personal = true`、未配置时为 `mode = none`，且 `available = false`；
  - 个人插件详情底部的工具块只显示李鹏本人的 4 个工具，`cy_api_dsh_list` 的可用角色为「普通员工」；在弹窗里保持 `member` 勾选并点「保存」后，弹窗关闭、页面仍停在个人插件详情、工具块仍为 4 行；
  - 控制台角色弹窗对个人工具显示“默认不授权任何角色，安装插件不会自动获得工具”，`member` 勾选状态与已写入配置一致；
  - 审计 `tool.access.update` 可在 PostgreSQL 审计源中查；平台工具页、个人插件详情与角色弹窗截图验收通过。
- 个人插件角色权限真实接口验收（新建临时普通成员 `U_PLUGIN_MEMBER`、公司管理员 `U_PLUGIN_ADMIN`）：
  - 普通成员 `GET /api/my/plugins` 返回 `permissions = { install:false, uninstall:false, configure:false, invokeTools:true }`；
  - 普通成员调用个人插件安装、启停、卸载分别返回 `403`，缺失权限分别为 `plugin:install / plugin:configure / plugin:uninstall`；
  - 公司管理员同一接口权限位全部为 `true`，安装入口进入参数校验（返回 `400 请选择插件文件夹后再安装`），证明权限已通过；
  - 真实员工页面（李鹏，`member`）在临时角色数据下曾显示「安装插件…」「停用」「卸载…」禁用；当前真实库的 `role_scopes` 已给 `member` 补授 `plugin:install / plugin:configure / plugin:uninstall`，所以这三个按钮当前为可用。该差异只影响“能不能操作本人插件”，不改变个人插件只属于安装人、不能操作他人插件的边界；
  - 临时成员已通过控制台删除并撤销会话。

## 边界

- 角色白名单是 `scope` 之外的附加限制，不是绕过 `scope` 的开关；
- 插件工具默认拒绝只作用于**个人插件**，公司插件工具保持历史默认，避免既有公司工具被一并停用；
- `super_admin` 对内置工具和公司插件工具恒定放行，属于运维兜底，不参与白名单收窄；个人插件工具仍只属于安装人，平台超管也不能代替他人执行；
- 高危工具仍走原有 `dangerous` 过滤与审批流程，角色白名单不会绕过审批；
- 控制台可以配置全公司的插件工具；插件停用/卸载后，其配置行保留，重新启用后自动生效。
