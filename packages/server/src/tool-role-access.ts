/**
 * 工具级角色可用性。
 *
 * 规则：
 * - 内置工具默认所有角色可用：没有 `tool_role_settings` 行就是 all；
 * - 插件工具默认不授权任何角色：安装插件只注册工具，不等于当前角色能使用；
 *   管理员在控制台为 `plugin:<pluginId>:<toolName>` 显式选择角色后才放开；
 * - 控制台可把单个工具改成「指定角色」，按 role_code 白名单过滤；
 * - 这是工具原有 scope 校验之外的附加限制，不替代 scope；
 * - super_admin 始终放行，避免运维被自己配错的白名单锁死。
 *
 * 工具键：
 * - 内置工具直接用 `ToolDef.id`；
 * - 插件工具用 `plugin:<pluginId>:<toolName>`，同一插件的公司/个人实例共享配置。
 */
import type { Db } from '@eab/storage'
import { EC, EabError } from '@eab/domain'

export type ToolRoleMode = 'all' | 'roles'

export interface ToolRoleAccess {
  readonly mode: ToolRoleMode
  readonly roles: readonly string[]
}

export interface CompanyRoleOption {
  readonly code: string
  readonly name: string
  readonly builtin: boolean
  readonly members: number
}

const ACCESS_ALL: ToolRoleAccess = { mode: 'all', roles: [] }
const tableReadyCache = new WeakMap<object, boolean>()

/** 兼容没有跑过 0048 迁移的测试/旧库：表不存在时按「所有角色」处理。 */
function tableReady(db: Db): boolean {
  const cached = tableReadyCache.get(db as unknown as object)
  if (cached !== undefined) return cached
  let ready = false
  try {
    db.prepare('SELECT 1 FROM tool_role_settings LIMIT 1').get()
    db.prepare('SELECT 1 FROM tool_role_bindings LIMIT 1').get()
    ready = true
  } catch {
    ready = false
  }
  tableReadyCache.set(db as unknown as object, ready)
  return ready
}

/** 角色表是否已迁移；旧库/单测没有 0048 表时，插件工具沿用历史的默认放行。 */
export function toolRoleAccessReady(db: Db): boolean {
  return tableReady(db)
}

export function pluginToolAccessId(pluginId: string, toolName: string): string {
  return `plugin:${pluginId}:${toolName}`
}

/** 控制台角色选择器用的公司角色列表。 */
export function listCompanyRoleOptions(db: Db, companyId: string): CompanyRoleOption[] {
  const rows = db
    .prepare(
      `SELECT r.code, r.name, r.builtin,
              (SELECT COUNT(*) FROM user_roles ur WHERE ur.role_id = r.id) AS members
         FROM roles r
        WHERE r.company_id = ? AND r.deleted_at IS NULL
        ORDER BY r.builtin DESC, r.code ASC`,
    )
    .all(companyId) as unknown as Array<{
    code: string
    name: string
    builtin: number
    members: number
  }>
  return rows.map((row) => ({
    code: row.code,
    name: row.name,
    builtin: Number(row.builtin) === 1,
    members: Number(row.members),
  }))
}

/** 读取单个工具的角色配置；没有显式配置时返回 all。 */
export function readToolRoleAccess(db: Db, companyId: string, toolId: string): ToolRoleAccess {
  if (!tableReady(db)) return ACCESS_ALL
  const setting = db
    .prepare('SELECT mode FROM tool_role_settings WHERE company_id = ? AND tool_id = ?')
    .get(companyId, toolId) as { mode: string } | undefined
  if (!setting) return ACCESS_ALL
  if (setting.mode !== 'roles') return ACCESS_ALL
  const rows = db
    .prepare('SELECT role_code FROM tool_role_bindings WHERE company_id = ? AND tool_id = ? ORDER BY role_code')
    .all(companyId, toolId) as unknown as Array<{ role_code: string }>
  return { mode: 'roles', roles: rows.map((row) => row.role_code) }
}

/** 一次读出整个公司的工具配置，供工具目录/插件目录批量过滤。 */
export function readToolRoleAccessMap(db: Db, companyId: string): Map<string, ToolRoleAccess> {
  if (!tableReady(db)) return new Map()
  const settings = db
    .prepare('SELECT tool_id, mode FROM tool_role_settings WHERE company_id = ?')
    .all(companyId) as unknown as Array<{ tool_id: string; mode: string }>
  if (settings.length === 0) return new Map()
  const rows = db
    .prepare('SELECT tool_id, role_code FROM tool_role_bindings WHERE company_id = ? ORDER BY tool_id, role_code')
    .all(companyId) as unknown as Array<{ tool_id: string; role_code: string }>
  const rolesByTool = new Map<string, string[]>()
  for (const row of rows) {
    const list = rolesByTool.get(row.tool_id) ?? []
    list.push(row.role_code)
    rolesByTool.set(row.tool_id, list)
  }
  const map = new Map<string, ToolRoleAccess>()
  for (const setting of settings) {
    map.set(
      setting.tool_id,
      setting.mode === 'roles'
        ? { mode: 'roles', roles: rolesByTool.get(setting.tool_id) ?? [] }
        : ACCESS_ALL,
    )
  }
  return map
}

/** 纯函数：按配置和当前角色判断工具是否可用。 */
export function toolAllowedForRoles(
  access: ToolRoleAccess | undefined,
  roleCodes: readonly string[],
  defaultAllow = true,
): boolean {
  const roles = roleCodes ?? []
  // 超管拥有全部工具，避免角色白名单把控制台运维自己锁死。
  if (roles.includes('super_admin')) return true
  if (!access) return defaultAllow
  if (access.mode === 'all') return true
  return access.roles.some((role) => roles.includes(role))
}

export function toolAllowedForActor(
  db: Db,
  actor: { readonly subject: { readonly companyId: string; readonly roles?: readonly string[] } },
  toolId: string,
): boolean {
  return toolAllowedForRoles(
    readToolRoleAccess(db, actor.subject.companyId, toolId),
    actor.subject.roles ?? [],
  )
}

/** 写入单个工具配置，调用方负责事务；白名单覆盖全部角色时归一为 all，避免两处显示不一致。 */
function writeToolRoleAccess(
  db: Db,
  companyId: string,
  toolId: string,
  mode: ToolRoleMode,
  roles: readonly string[],
  allRoleCodes: readonly string[],
  now: number,
): ToolRoleAccess {
  const normalized =
    mode === 'roles' &&
    allRoleCodes.length > 0 &&
    roles.length === allRoleCodes.length &&
    allRoleCodes.every((code) => roles.includes(code))
      ? ACCESS_ALL
      : mode === 'all'
        ? ACCESS_ALL
        : { mode: 'roles' as const, roles: [...roles] }
  db.prepare(
    `INSERT INTO tool_role_settings (company_id, tool_id, mode, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (company_id, tool_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at`,
  ).run(companyId, toolId, normalized.mode, now)
  db.prepare('DELETE FROM tool_role_bindings WHERE company_id = ? AND tool_id = ?').run(companyId, toolId)
  const insert = db.prepare(
    'INSERT INTO tool_role_bindings (company_id, tool_id, role_code, created_at) VALUES (?, ?, ?, ?)',
  )
  for (const role of normalized.roles) insert.run(companyId, toolId, role, now)
  return normalized
}

/** 保存工具的角色配置；mode=all 时清空白名单。 */
export function setToolRoleAccess(
  db: Db,
  companyId: string,
  toolId: string,
  input: { mode: unknown; roles?: unknown },
): ToolRoleAccess {
  const mode = String(input.mode ?? '')
  if (mode !== 'all' && mode !== 'roles') {
    throw new EabError(EC.VALIDATION, 'mode 只能是 all 或 roles')
  }
  if (input.roles !== undefined && !Array.isArray(input.roles)) {
    throw new EabError(EC.VALIDATION, 'roles 必须是数组')
  }
  const requested = mode === 'roles'
    ? [...new Set((input.roles ?? []).map((role) => String(role).trim()).filter(Boolean))]
    : []
  const allRoleCodes = listCompanyRoleOptions(db, companyId).map((role) => role.code)
  if (mode === 'roles') {
    const known = new Set(allRoleCodes)
    const unknown = requested.filter((role) => !known.has(role))
    if (unknown.length > 0) {
      throw new EabError(EC.VALIDATION, `存在未知角色：${unknown.join('、')}`)
    }
  }

  const now = Date.now()
  db.exec('BEGIN')
  try {
    const saved = writeToolRoleAccess(db, companyId, toolId, mode, requested, allRoleCodes, now)
    db.exec('COMMIT')
    return saved
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * 从「角色管理 → 可用工具」保存某个角色的完整工具集合。
 *
 * 角色页看到的是全部工具对该角色的勾选结果；工具页看到的是一条工具的角色白名单。
 * 两边共用同一张表，按下面的规则换算，避免把“所有角色可用”误写成一次性的角色快照：
 * - 保留勾选：工具本来就是 all，保持 all；是 roles 时把该角色加进去。
 * - 取消勾选：工具是 all 时改成 roles，白名单为“其他所有角色”；是 roles 时只移除该角色。
 * 平台超管始终拥有全部工具，不允许通过角色页收回。
 */
export function setRoleToolAccess(
  db: Db,
  companyId: string,
  roleCode: string,
  allToolIds: readonly string[],
  allowedToolIds: readonly string[],
): { roleCode: string; changed: string[] } {
  const roleOptions = listCompanyRoleOptions(db, companyId)
  const role = roleOptions.find((item) => item.code === roleCode)
  if (!role) throw new EabError(EC.NOT_FOUND, `角色不存在：${roleCode}`)
  if (role.code === 'super_admin') {
    throw new EabError(EC.VALIDATION, '平台超管始终拥有全部工具，不能在角色页收回', {
      hint: '如需限制平台超管，请改为调整其他角色或工具的可用范围。',
    })
  }
  const allIds = [...new Set(allToolIds.map((id) => String(id).trim()).filter(Boolean))]
  const allowed = [...new Set(allowedToolIds.map((id) => String(id).trim()).filter(Boolean))]
  const unknownAllowed = allowed.filter((id) => !allIds.includes(id))
  if (unknownAllowed.length > 0) {
    throw new EabError(EC.VALIDATION, `存在未知工具：${unknownAllowed.join('、')}`)
  }
  const allRoleCodes = roleOptions.map((item) => item.code)
  const allowedSet = new Set(allowed)
  const now = Date.now()
  const changed: string[] = []

  db.exec('BEGIN')
  try {
    for (const toolId of allIds) {
      const current = readToolRoleAccess(db, companyId, toolId)
      const desired = allowedSet.has(toolId)
      let mode: ToolRoleMode = current.mode
      let roles = [...current.roles]

      if (desired) {
        if (current.mode === 'roles' && !roles.includes(roleCode)) {
          roles = [...roles, roleCode]
          changed.push(toolId)
        }
      } else if (current.mode === 'all') {
        mode = 'roles'
        roles = allRoleCodes.filter((code) => code !== roleCode)
        changed.push(toolId)
      } else if (roles.includes(roleCode)) {
        roles = roles.filter((code) => code !== roleCode)
        changed.push(toolId)
      }

      if (!changed.includes(toolId)) continue
      writeToolRoleAccess(db, companyId, toolId, mode, roles, allRoleCodes, now)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return { roleCode, changed }
}
