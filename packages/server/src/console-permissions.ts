/**
 * 成员后台页面权限的读写与 scope 翻译。
 *
 * 权限模型从“可见 / 管理”拆成：
 * - 可见（can_view）：能看页面、能读该页对应接口；
 * - 新增（can_create）、编辑（can_edit）、删除（can_delete）：分别对应三类写动作。
 *
 * 旧数据的 `can_manage=1` 会回填成三项写动作全开，保证升级后原有权限不缩水；
 * 新保存一律按动作落库。权限按页面保存，导航是否显示仍按页面可见计算。
 */
import type { Db } from '@eab/storage'
import { withTransaction } from '@eab/storage'
import type { Scope } from '@eab/domain'
import {
  CONSOLE_DOMAINS,
  CONSOLE_PAGES,
  CONSOLE_PAGE_KEYS,
  consolePageActionMetas,
  consolePageSectionActionMetas,
  consolePageSections,
  consolePermissionPageKey,
  consoleScopesForPage,
  parseConsolePermissionPageKey,
  type ConsolePageKey,
  type ConsoleWriteAction,
} from './console-pages.js'

export interface ConsolePagePermission {
  /** 权限键：整页是 `page`，页内分区是 `page:section`。 */
  readonly page: string
  readonly parentPage: ConsolePageKey
  readonly section?: string
  readonly canView: boolean
  readonly canCreate: boolean
  readonly canEdit: boolean
  readonly canDelete: boolean
  /** 兼容旧调用方：任一写动作打开即为 true；新代码请用三项动作字段。 */
  readonly canManage: boolean
}

export interface ConsolePagePermissionInput {
  readonly page: string
  readonly section?: string
  readonly canView?: boolean
  readonly canCreate?: boolean
  readonly canEdit?: boolean
  readonly canDelete?: boolean
  /** 旧接口字段；传 true 等价于三项写动作全开。 */
  readonly canManage?: boolean
}

interface PermissionRow {
  page: string
  can_view: number
  can_create: number
  can_edit: number
  can_delete: number
  can_manage: number
}

function permissionOfRow(row: PermissionRow): ConsolePagePermission | null {
  const parsed = parseConsolePermissionPageKey(row.page)
  if (!parsed) return null
  const actions = parsed.section
    ? consolePageSectionActionMetas(parsed.page, parsed.section)
    : consolePageActionMetas(parsed.page)
  // 迁移 0070 已把旧 can_manage=1 回填到三项动作，因此读取只看动作列；
  // 不能再把 can_manage 当“全部动作”的来源，否则只授权新增后编辑/删除会被误放开。
  const canCreate = Number(row.can_create) === 1 && actions.some((item) => item.id === 'create')
  const canEdit = Number(row.can_edit) === 1 && actions.some((item) => item.id === 'edit')
  const canDelete = Number(row.can_delete) === 1 && actions.some((item) => item.id === 'delete')
  const canManage = canCreate || canEdit || canDelete
  const canView = canManage || Number(row.can_view) === 1
  if (!canView) return null
  return {
    page: row.page,
    parentPage: parsed.page,
    section: parsed.section,
    canView,
    canCreate,
    canEdit,
    canDelete,
    canManage,
  }
}

function actionsOf(permission: ConsolePagePermission): {
  create: boolean
  edit: boolean
  delete: boolean
} {
  return { create: permission.canCreate, edit: permission.canEdit, delete: permission.canDelete }
}

function writeActionList(permission: ConsolePagePermission): ConsoleWriteAction[] {
  const actions: ConsoleWriteAction[] = []
  if (permission.canCreate) actions.push('create')
  if (permission.canEdit) actions.push('edit')
  if (permission.canDelete) actions.push('delete')
  return actions
}

/**
 * 读取成员个人单独配置的页面权限（不含角色带来的权限）。
 * 成员配置弹窗用它回显和保存，避免把角色权限复制成个人权限。
 */
export function readMemberConsolePagePermissions(
  db: Db,
  companyId: string,
  userId: string,
): Map<string, ConsolePagePermission> {
  const result = new Map<string, ConsolePagePermission>()
  let rows: PermissionRow[] = []
  try {
    rows = db
      .prepare(
        `SELECT page, can_view, can_create, can_edit, can_delete, can_manage
           FROM console_page_permissions
          WHERE company_id = ? AND user_id = ?`,
      )
      .all(companyId, userId) as unknown as PermissionRow[]
  } catch {
    // 迁移尚未落库时按无权限处理；服务启动会先执行迁移，正常不会走到这里。
    return result
  }
  for (const row of rows) {
    const permission = permissionOfRow(row)
    if (permission) result.set(row.page, permission)
  }
  return result
}

/** 读取单个角色配置的后台页面权限。 */
export function readConsoleRolePagePermissions(
  db: Db,
  companyId: string,
  roleId: string,
): Map<string, ConsolePagePermission> {
  const result = new Map<string, ConsolePagePermission>()
  let rows: PermissionRow[] = []
  try {
    rows = db
      .prepare(
        `SELECT page, can_view, can_create, can_edit, can_delete, can_manage
           FROM console_role_page_permissions
          WHERE company_id = ? AND role_id = ?`,
      )
      .all(companyId, roleId) as unknown as PermissionRow[]
  } catch {
    return result
  }
  for (const row of rows) {
    const permission = permissionOfRow(row)
    if (permission) result.set(row.page, permission)
  }
  return result
}

/** 读取成员当前所有有效角色带来的后台页面权限。 */
export function readUserRoleConsolePagePermissions(
  db: Db,
  companyId: string,
  userId: string,
): Map<string, ConsolePagePermission> {
  const result = new Map<string, ConsolePagePermission>()
  let rows: PermissionRow[] = []
  try {
    rows = db
      .prepare(
        `SELECT p.page, p.can_view, p.can_create, p.can_edit, p.can_delete, p.can_manage
           FROM console_role_page_permissions p
           JOIN roles r ON r.id = p.role_id
           JOIN user_roles ur ON ur.role_id = r.id
          WHERE p.company_id = ? AND r.company_id = ? AND r.deleted_at IS NULL
            AND ur.user_id = ? AND (ur.expires_at IS NULL OR ur.expires_at > ?)`,
      )
      .all(companyId, companyId, userId, Date.now()) as unknown as PermissionRow[]
  } catch {
    return result
  }
  for (const row of rows) {
    const permission = permissionOfRow(row)
    if (!permission) continue
    const existing = result.get(row.page)
    if (!existing) {
      result.set(row.page, permission)
      continue
    }
    // 同一页面被多个角色重复授予时取并集，任一角色给出可见或写动作即生效。
    result.set(row.page, {
      ...existing,
      canView: existing.canView || permission.canView,
      canCreate: existing.canCreate || permission.canCreate,
      canEdit: existing.canEdit || permission.canEdit,
      canDelete: existing.canDelete || permission.canDelete,
      canManage: existing.canManage || permission.canManage,
    })
  }
  return result
}

/**
 * 合并多组页面权限。相同键取并集；整页写权限遇到该页已有分区时，
 * 把写动作展开到全部已知分区，避免旧整页授权被新分区配置截断。
 */
export function mergeConsolePagePermissions(
  ...sources: ReadonlyMap<string, ConsolePagePermission>[]
): Map<string, ConsolePagePermission> {
  const merged = new Map<string, ConsolePagePermission>()
  for (const source of sources) {
    for (const [key, permission] of source) {
      const existing = merged.get(key)
      if (!existing) {
        merged.set(key, { ...permission })
        continue
      }
      merged.set(key, {
        ...existing,
        canView: existing.canView || permission.canView,
        canCreate: existing.canCreate || permission.canCreate,
        canEdit: existing.canEdit || permission.canEdit,
        canDelete: existing.canDelete || permission.canDelete,
        canManage: existing.canManage || permission.canManage,
      })
    }
  }

  const sectionPages = new Map<ConsolePageKey, Set<string>>()
  for (const permission of merged.values()) {
    if (!permission.section) continue
    const sections = sectionPages.get(permission.parentPage) ?? new Set<string>()
    sections.add(permission.section)
    sectionPages.set(permission.parentPage, sections)
  }
  for (const [parentPage, sections] of sectionPages) {
    const parent = merged.get(parentPage)
    if (!parent) continue
    if (parent.canCreate || parent.canEdit || parent.canDelete) {
      for (const section of sections) {
        const key = consolePermissionPageKey(parentPage, section)
        const existing = merged.get(key)
        const inherited = {
          ...parent,
          page: key,
          section,
          canView: true,
        }
        merged.set(
          key,
          existing
            ? {
                ...existing,
                canView: true,
                canCreate: existing.canCreate || inherited.canCreate,
                canEdit: existing.canEdit || inherited.canEdit,
                canDelete: existing.canDelete || inherited.canDelete,
                canManage: existing.canManage || inherited.canManage,
              }
            : inherited,
        )
      }
    }
    merged.set(parentPage, {
      ...parent,
      canView: true,
      canCreate: false,
      canEdit: false,
      canDelete: false,
      canManage: false,
    })
  }
  return merged
}

/**
 * 读取成员的有效页面权限：个人单独配置 + 当前角色带来的权限。
 * 鉴权、导航和后台入口都走这里，保证成员绑定角色后立即获得后台访问范围。
 */
export function readConsolePagePermissions(
  db: Db,
  companyId: string,
  userId: string,
): Map<string, ConsolePagePermission> {
  return mergeConsolePagePermissions(
    readMemberConsolePagePermissions(db, companyId, userId),
    readUserRoleConsolePagePermissions(db, companyId, userId),
  )
}

export function hasAnyConsolePagePermission(db: Db, companyId: string, userId: string): boolean {
  return readConsolePagePermissions(db, companyId, userId).size > 0
}

/**
 * 是否允许配置其他成员的后台访问。
 *
 * 这是一个独立能力，挂在「成员管理 → 后台访问 → 配置后台访问」；
 * 老数据只有整页 org 编辑权限、还没有分区记录时，按整页编辑兼容，
 * 一旦该页配置了任一分区，就只认 memberAccess 分区自己的动作。
 */
export function canConfigureMemberConsoleAccess(
  permissions: ReadonlyMap<string, ConsolePagePermission>,
): boolean {
  const sectionKey = consolePermissionPageKey('org', 'memberAccess')
  const section = permissions.get(sectionKey)
  if (section) return section.canEdit
  const sectionConfigured = [...permissions.values()].some(
    (permission) => permission.parentPage === 'org' && permission.section,
  )
  return sectionConfigured ? false : permissions.get('org')?.canEdit === true
}

/** 把页面权限翻译成员工 scope；只用于成员后台会话，不影响成员对话会话。 */
export function consoleScopesForMember(db: Db, companyId: string, userId: string): Scope[] {
  const permissions = readConsolePagePermissions(db, companyId, userId)
  const scopes = new Set<Scope>()
  for (const permission of permissions.values()) {
    for (const scope of consoleScopesForPage(permission.parentPage, actionsOf(permission))) scopes.add(scope)
  }
  return [...scopes]
}

function normalizeConsolePermissionEntries(
  entries: readonly ConsolePagePermissionInput[],
): Map<string, ConsolePagePermission> {
  const normalized = new Map<string, ConsolePagePermission>()
  for (const entry of entries) {
    const base = parseConsolePermissionPageKey(String(entry.page || ''))
    const parsed = entry.section
      ? base && !base.section ? { page: base.page, section: entry.section } : null
      : base
    if (!parsed) continue
    const key = consolePermissionPageKey(parsed.page, parsed.section)
    const actions = parsed.section
      ? consolePageSectionActionMetas(parsed.page, parsed.section)
      : consolePageActionMetas(parsed.page)
    const legacyManage = entry.canManage === true
    const canCreate = legacyManage || (entry.canCreate === true && actions.some((item) => item.id === 'create'))
    const canEdit = legacyManage || (entry.canEdit === true && actions.some((item) => item.id === 'edit'))
    const canDelete = legacyManage || (entry.canDelete === true && actions.some((item) => item.id === 'delete'))
    const canManage = canCreate || canEdit || canDelete
    const canView = canManage || entry.canView === true
    if (!canView) continue
    normalized.set(key, {
      page: key,
      parentPage: parsed.page,
      section: parsed.section,
      canView,
      canCreate,
      canEdit,
      canDelete,
      canManage,
    })
  }

  // 只要配置了某个分区，父页面就只作为“页面入口”存在；写动作全部由分区自己承担，
  // 避免父页面的“管理/编辑”再次放大成整页所有 tab 的权限。
  const sectionParents = new Set(
    [...normalized.values()].filter((item) => item.section).map((item) => item.parentPage),
  )
  for (const parentPage of sectionParents) {
    normalized.set(parentPage, {
      page: parentPage,
      parentPage,
      canView: true,
      canCreate: false,
      canEdit: false,
      canDelete: false,
      canManage: false,
    })
  }
  return normalized
}

/** 全量保存：先清空再写，天然支持“取消所有页面权限”。 */
export function saveConsolePagePermissions(
  db: Db,
  companyId: string,
  userId: string,
  entries: readonly ConsolePagePermissionInput[],
  updatedBy: string,
): Map<string, ConsolePagePermission> {
  const normalized = normalizeConsolePermissionEntries(entries)
  const now = Date.now()
  withTransaction(db, () => {
    db.prepare('DELETE FROM console_page_permissions WHERE company_id = ? AND user_id = ?').run(companyId, userId)
    const insert = db.prepare(
      `INSERT INTO console_page_permissions
         (company_id, user_id, page, can_view, can_create, can_edit, can_delete, can_manage, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const [page, value] of normalized) {
      insert.run(
        companyId,
        userId,
        page,
        value.canView ? 1 : 0,
        value.canCreate ? 1 : 0,
        value.canEdit ? 1 : 0,
        value.canDelete ? 1 : 0,
        value.canManage ? 1 : 0,
        updatedBy,
        now,
      )
    }
  })

  return readMemberConsolePagePermissions(db, companyId, userId)
}

/** 全量保存角色后台访问权限；传空数组等于收回该角色带来的全部后台页面。 */
export function saveConsoleRolePagePermissions(
  db: Db,
  companyId: string,
  roleId: string,
  entries: readonly ConsolePagePermissionInput[],
  updatedBy: string,
): Map<string, ConsolePagePermission> {
  const normalized = normalizeConsolePermissionEntries(entries)
  const now = Date.now()
  withTransaction(db, () => {
    db.prepare('DELETE FROM console_role_page_permissions WHERE company_id = ? AND role_id = ?').run(
      companyId,
      roleId,
    )
    const insert = db.prepare(
      `INSERT INTO console_role_page_permissions
         (company_id, role_id, page, can_view, can_create, can_edit, can_delete, can_manage, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const [page, value] of normalized) {
      insert.run(
        companyId,
        roleId,
        page,
        value.canView ? 1 : 0,
        value.canCreate ? 1 : 0,
        value.canEdit ? 1 : 0,
        value.canDelete ? 1 : 0,
        value.canManage ? 1 : 0,
        updatedBy,
        now,
      )
    }
  })

  return readConsoleRolePagePermissions(db, companyId, roleId)
}

/** 前端权限配置弹窗和 `/api/console/access` 共用的树结构。 */
export function consolePermissionCatalog() {
  return {
    pages: CONSOLE_PAGES.map((page) => ({
      page: page.key,
      title: page.title,
      domain: page.domain,
      actions: consolePageActionMetas(page.key),
      sections: consolePageSections(page.key).map((section) => ({
        key: section.key,
        title: section.title,
        actions: section.actions,
        hideView: section.hideView === true,
      })),
    })),
    domains: CONSOLE_DOMAINS.map((domain) => ({
      id: domain.id,
      title: domain.title,
      pages: domain.pages,
    })),
    pageKeys: CONSOLE_PAGE_KEYS,
  }
}

/** 给访问载荷复用的动作数组，前端无需自己推导；页内分区使用 `page:section` 键。 */
export function consoleActionsByPage(
  permissions: ReadonlyMap<string, ConsolePagePermission>,
): Record<string, ConsoleWriteAction[]> {
  const result: Record<string, ConsoleWriteAction[]> = {}
  for (const [page, permission] of permissions) {
    const actions = writeActionList(permission)
    if (actions.length > 0) result[page] = actions
  }
  return result
}

/** 导航/顶部统计只按父页面去重，不能把多个 tab 算成多个页面。 */
export function consoleVisibleParentPages(
  permissions: ReadonlyMap<string, ConsolePagePermission>,
): ConsolePageKey[] {
  const pages = new Set<ConsolePageKey>()
  for (const permission of permissions.values()) {
    if (permission.canView) pages.add(permission.parentPage)
  }
  return [...pages]
}

export function consoleActionParentPages(
  permissions: ReadonlyMap<string, ConsolePagePermission>,
  action: ConsoleWriteAction,
): ConsolePageKey[] {
  const pages = new Set<ConsolePageKey>()
  for (const permission of permissions.values()) {
    if (
      (action === 'create' && permission.canCreate) ||
      (action === 'edit' && permission.canEdit) ||
      (action === 'delete' && permission.canDelete)
    ) {
      pages.add(permission.parentPage)
    }
  }
  return [...pages]
}
