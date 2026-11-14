/**
 * 内置角色定义。
 *
 * 约束：
 * 1. 内置角色不可删除，只允许调整 scope 与 dataScope（调整必须审计）。
 * 2. 角色只是 scope 的集合，代码里禁止用角色名做权限判断（角色可变，scope 稳定）。
 */
import { SC, expandScopes, type DataScope, type Scope } from '@eab/domain'

export interface RoleDefinition {
  readonly code: string
  readonly name: string
  readonly dataScope: DataScope
  readonly scopes: readonly Scope[]
  readonly builtin: boolean
}

const MEMBER_SCOPES: readonly Scope[] = [
  SC.CHAT_USE,
  SC.CHAT_HISTORY_READ,
  SC.CHAT_HISTORY_DELETE,
  SC.WORKSPACE_READ,
  SC.WORKSPACE_WRITE,
  SC.WORKSPACE_SHARE,
  SC.LOCAL_SPACE_READ,
  SC.LOCAL_SPACE_WRITE,
  SC.AGENT_TOOL_LIST,
  SC.AGENT_TOOL_INVOKE,
  SC.KB_READ,
  SC.MEMORY_READ,
  SC.MEMORY_WRITE,
  SC.APPROVAL_READ,
  SC.MODEL_USE,
  /** 个人定时任务：任何员工都能创建自己的提醒/定时任务，到点结果回推自己的钉钉 */
  SC.SCHEDULE_READ,
  SC.SCHEDULE_WRITE,
  /** 个人插件：员工可以查看和使用本人插件；安装、启停、卸载分别需要 PLUGIN_INSTALL / PLUGIN_CONFIGURE / PLUGIN_UNINSTALL，按角色授权 */
  SC.PLUGIN_LIST,
  /** 技能：员工可以查看和使用已启用的技能；安装/启停/卸载按角色单独授权 */
  SC.SKILL_LIST,
  SC.SKILL_USE,
]

export const BUILTIN_ROLES: readonly RoleDefinition[] = [
  {
    code: 'super_admin',
    name: '平台超管',
    dataScope: 'global',
    builtin: true,
    // 超管拿全部已登记 scope（新增 scope 自动纳入，避免漏授权导致运维做不动）
    scopes: Object.values(SC),
  },
  {
    code: 'company_admin',
    name: '公司管理员',
    dataScope: 'dept_tree',
    builtin: true,
    scopes: [
      SC.CHAT_USE,
      SC.CHAT_HISTORY_READ,
      SC.CHAT_EXPORT,
      SC.WORKSPACE_READ,
      SC.WORKSPACE_WRITE,
      SC.WORKSPACE_SHARE,
      SC.LOCAL_SPACE_READ,
      SC.LOCAL_SPACE_WRITE,
      SC.AGENT_TOOL_LIST,
      SC.AGENT_TOOL_INVOKE,
      SC.KB_READ,
      SC.KB_WRITE,
      SC.KB_ADMIN,
      SC.KB_DELETE,
      SC.ORG_MEMBER_READ,
      SC.ORG_MEMBER_MANAGE,
      SC.ORG_DEPT_READ,
      SC.ORG_DEPT_MANAGE,
      SC.ORG_SYNC_RUN,
      SC.AUTHZ_ROLE_READ,
      SC.AUTHZ_ROLE_MANAGE,
      SC.AUTHZ_GRANT,
      SC.PLUGIN_LIST,
      SC.PLUGIN_INSTALL,
      SC.PLUGIN_UNINSTALL,
      SC.PLUGIN_CONFIGURE,
      SC.PLUGIN_APPROVE,
      SC.SKILL_LIST,
      SC.SKILL_USE,
      SC.SKILL_INSTALL,
      SC.SKILL_UNINSTALL,
      SC.SKILL_CONFIGURE,
      SC.SKILL_APPROVE,
      SC.CHANNEL_MANAGE,
      SC.CHANNEL_BIND,
      SC.CHANNEL_SEND,
      SC.MODEL_READ,
      SC.MODEL_MANAGE,
      SC.MODEL_USE,
      SC.SCHEDULE_READ,
      SC.SCHEDULE_WRITE,
      SC.APPROVAL_READ,
      SC.APPROVAL_DECIDE,
      SC.AUDIT_READ,
      SC.AUDIT_EXPORT,
      SC.SERVICE_STATUS,
      SC.SYSTEM_BACKUP,
      SC.MEMORY_READ,
      SC.MEMORY_WRITE,
      SC.MEMORY_ADMIN,
    ],
  },
  {
    code: 'company_sub_admin',
    name: '企业级子管理员',
    dataScope: 'company',
    builtin: true,
    scopes: [
      ...MEMBER_SCOPES,
      SC.ORG_MEMBER_READ,
      SC.ORG_DEPT_READ,
      SC.MODEL_READ,
      SC.MODEL_MANAGE,
      SC.MODEL_USE,
      SC.PLUGIN_INSTALL,
      SC.PLUGIN_UNINSTALL,
      SC.PLUGIN_CONFIGURE,
      SC.SKILL_INSTALL,
      SC.SKILL_UNINSTALL,
      SC.SKILL_CONFIGURE,
      SC.CHANNEL_SEND,
      SC.APPROVAL_READ,
    ],
  },
  {
    code: 'dept_admin',
    name: '部门管理员',
    dataScope: 'dept',
    builtin: true,
    scopes: [
      ...MEMBER_SCOPES,
      SC.ORG_MEMBER_READ,
      SC.ORG_DEPT_READ,
      SC.KB_WRITE,
      SC.KB_ADMIN,
      SC.KB_DELETE,
      SC.WORKSPACE_SHARE,
      SC.CHANNEL_SEND,
      SC.APPROVAL_READ,
      SC.APPROVAL_DECIDE,
    ],
  },
  {
    code: 'kb_admin',
    name: '知识库管理员',
    dataScope: 'dept',
    builtin: true,
    scopes: [
      SC.CHAT_USE,
      SC.CHAT_HISTORY_READ,
      SC.WORKSPACE_READ,
      SC.WORKSPACE_WRITE,
      SC.LOCAL_SPACE_READ,
      SC.LOCAL_SPACE_WRITE,
      SC.AGENT_TOOL_LIST,
      SC.AGENT_TOOL_INVOKE,
      SC.KB_READ,
      SC.KB_WRITE,
      SC.KB_ADMIN,
      SC.KB_DELETE,
      SC.MODEL_USE,
      SC.SCHEDULE_READ,
      SC.SCHEDULE_WRITE,
    ],
  },
  {
    code: 'auditor',
    name: '审计员',
    dataScope: 'company',
    builtin: true,
    scopes: [SC.AUDIT_READ, SC.AUDIT_EXPORT, SC.SERVICE_STATUS, SC.APPROVAL_READ],
  },
  {
    code: 'member',
    name: '普通员工',
    dataScope: 'self',
    builtin: true,
    scopes: MEMBER_SCOPES,
  },
  {
    code: 'guest',
    name: '外部访客',
    dataScope: 'self',
    builtin: true,
    scopes: [SC.PORTAL_USE, SC.CHAT_USE],
  },
]

export const BUILTIN_ROLE_CODES: readonly string[] = BUILTIN_ROLES.map((r) => r.code)

/** dataScope 的包含关系（值越大越宽） */
const DATA_SCOPE_RANK: Record<DataScope, number> = {
  self: 0,
  dept: 1,
  dept_tree: 2,
  company: 3,
  global: 4,
}

export function widestDataScope(scopes: readonly DataScope[]): DataScope {
  let best: DataScope = 'self'
  for (const scope of scopes) {
    if (DATA_SCOPE_RANK[scope] > DATA_SCOPE_RANK[best]) best = scope
  }
  return best
}

export interface RoleLookup {
  get(code: string): RoleDefinition | undefined
}

export function createRoleLookup(extra: readonly RoleDefinition[] = []): RoleLookup {
  const map = new Map<string, RoleDefinition>()
  for (const role of BUILTIN_ROLES) map.set(role.code, role)
  for (const role of extra) map.set(role.code, role)
  return { get: (code) => map.get(code) }
}

export const DEFAULT_ROLE_LOOKUP: RoleLookup = createRoleLookup()

/** 角色集合 → 功能权限集合（含隐含展开）。未知角色码直接忽略（不报错，避免脏数据阻断登录） */
export function scopesOfRoles(
  roleCodes: readonly string[],
  lookup: RoleLookup = DEFAULT_ROLE_LOOKUP,
): Set<Scope> {
  const collected: Scope[] = []
  for (const code of roleCodes) {
    const role = lookup.get(code)
    if (role) collected.push(...role.scopes)
  }
  return expandScopes(collected)
}

/** 角色集合 → 数据范围（取最宽的那个） */
export function dataScopeOfRoles(
  roleCodes: readonly string[],
  lookup: RoleLookup = DEFAULT_ROLE_LOOKUP,
): DataScope {
  const scopes: DataScope[] = []
  for (const code of roleCodes) {
    const role = lookup.get(code)
    if (role) scopes.push(role.dataScope)
  }
  return scopes.length === 0 ? 'self' : widestDataScope(scopes)
}
