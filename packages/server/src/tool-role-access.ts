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
  if (mode === 'roles') {
    const known = new Set(listCompanyRoleOptions(db, companyId).map((role) => role.code))
    const unknown = requested.filter((role) => !known.has(role))
    if (unknown.length > 0) {
      throw new EabError(EC.VALIDATION, `存在未知角色：${unknown.join('、')}`)
    }
  }

  const now = Date.now()
  db.exec('BEGIN')
  try {
    db.prepare(
      `INSERT INTO tool_role_settings (company_id, tool_id, mode, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (company_id, tool_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at`,
    ).run(companyId, toolId, mode, now)
    db.prepare('DELETE FROM tool_role_bindings WHERE company_id = ? AND tool_id = ?').run(companyId, toolId)
    const insert = db.prepare(
      'INSERT INTO tool_role_bindings (company_id, tool_id, role_code, created_at) VALUES (?, ?, ?, ?)',
    )
    for (const role of requested) insert.run(companyId, toolId, role, now)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return mode === 'all' ? ACCESS_ALL : { mode: 'roles', roles: requested }
}
