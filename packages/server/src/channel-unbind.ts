/**
 * 渠道解绑的组织清理。
 *
 * 产品口径（2026-11-12 已确认 1B / 2B / 3A）：
 * - 一家公司下三个渠道各自同步一套组织与人员，外部用户 ID 互不相同；
 * - 解绑哪个渠道，就删除该渠道的整棵部门树、成员、角色和身份；
 * - EAB 自己创建、没有该渠道身份的成员不被删除；如果他们被放在渠道部门下，先移到公司根部门。
 *
 * 为什么是软删部门/成员：
 * - users 被 chat_sessions / workspace_files 引用，departments 被 users.dept_id 引用；
 * - 保留 path 也让知识库 ACL 不会因为物理删行而失去依据；
 * - 重新绑定时可以按原 ID 恢复成员。
 *
 * 角色是例外：user_roles 没有软删字段，按 3A 直接物理删除；重绑后需要重新授权。
 */
import { EC, EabError } from '@eab/domain'
import { appendAudit, withTransaction, type Db } from '@eab/storage'

export type ChannelProvider = 'feishu' | 'dingtalk' | 'wecom'

const PROVIDER_LABELS: Record<ChannelProvider, string> = {
  feishu: '飞书',
  dingtalk: '钉钉',
  wecom: '企业微信',
}

interface CompanyRoot {
  id: string
  path: string
}

interface DeptRow {
  id: string
  parent_id: string | null
  name: string
  path: string
  depth: number
  manager_user_id: string | null
  channel: string | null
  channel_dept_id: string | null
}

interface UserRow {
  id: string
  name: string
  dept_id: string
  dept_path: string
}

interface CountRow {
  n: number
}

export interface ChannelUnbindPlan {
  provider: ChannelProvider
  label: string
  departments: number
  users: number
  roles: number
  overrides: number
  sessions: number
  workspaces: number
  identities: number
  protectedUsers: number
  crossChannelUsers: number
  chatSessions: number
  warnings: string[]
}

export interface ChannelUnbindResult {
  preview: ChannelUnbindPlan
  removed: {
    departments: number
    users: number
    roles: number
    overrides: number
    sessions: number
    workspaces: number
    identities: number
  }
  preserved: {
    protectedUsers: number
    chatSessions: number
  }
  crossChannelUsers: number
}

interface ExecuteOptions {
  companyId: string
  provider: ChannelProvider
  actorUserId?: string | null
  ip?: string | null
  now?: number
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ')
}

function defaultRootDept(db: Db, companyId: string): CompanyRoot {
  const row = db
    .prepare(
      `SELECT id, path FROM departments
        WHERE company_id = ? AND parent_id IS NULL AND deleted_at IS NULL
        ORDER BY depth, path LIMIT 1`,
    )
    .get(companyId) as { id?: string; path?: string } | undefined
  if (!row?.id || !row.path) {
    throw new EabError(EC.VALIDATION, `公司 ${companyId} 没有根部门，无法清理渠道组织`, {
      hint: '先建组织根部门（或恢复公司根部门）后再解绑',
    })
  }
  return { id: row.id, path: row.path }
}

function channelDeptRows(db: Db, companyId: string, provider: ChannelProvider): DeptRow[] {
  return db
    .prepare(
      `SELECT id, parent_id, name, path, depth, manager_user_id, channel, channel_dept_id
         FROM departments
        WHERE company_id = ? AND channel = ? AND deleted_at IS NULL
        ORDER BY depth, path`,
    )
    .all(companyId, provider) as unknown as DeptRow[]
}

function collectDeptSubtree(db: Db, companyId: string, provider: ChannelProvider, root: CompanyRoot): DeptRow[] {
  const channelRows = channelDeptRows(db, companyId, provider)
  if (channelRows.length === 0) return []

  const byId = new Map(channelRows.map((row) => [row.id, row]))
  const roots = channelRows.filter((row) => !row.parent_id || !byId.has(row.parent_id))
  const selected = new Map<string, DeptRow>()
  const selectStmt = db.prepare(
    `SELECT id, parent_id, name, path, depth, manager_user_id, channel, channel_dept_id
       FROM departments
      WHERE company_id = ? AND deleted_at IS NULL
        AND (path = ? OR path LIKE ?)
      ORDER BY depth`,
  )

  for (const row of channelRows) selected.set(row.id, row)
  for (const row of roots) {
    const prefix = row.path.endsWith('/') ? row.path : `${row.path}/`
    const descendants = selectStmt.all(companyId, row.path, `${prefix}%`) as unknown as DeptRow[]
    for (const child of descendants) {
      // 公司根部门永远不在清理范围
      if (child.id === root.id) continue
      selected.set(child.id, child)
    }
  }

  return [...selected.values()].sort((a, b) => a.depth - b.depth)
}

function providerUsers(db: Db, companyId: string, provider: ChannelProvider): UserRow[] {
  return db
    .prepare(
      `SELECT DISTINCT u.id, u.name, u.dept_id, u.dept_path
         FROM users u
        WHERE u.company_id = ? AND u.deleted_at IS NULL
          AND (
            EXISTS (
              SELECT 1 FROM user_identities ui
               WHERE ui.user_id = u.id AND ui.provider = ?
            )
            OR EXISTS (
              SELECT 1 FROM channel_identities ci
               WHERE ci.user_id = u.id AND ci.company_id = ? AND ci.provider = ?
                 AND ci.revoked_at IS NULL
            )
          )
        ORDER BY u.name, u.id`,
    )
    .all(companyId, provider, companyId, provider) as unknown as UserRow[]
}

function protectedUsers(
  db: Db,
  companyId: string,
  userDeptIds: readonly string[],
  targetUserIds: readonly string[],
): UserRow[] {
  if (userDeptIds.length === 0) return []
  const targetClause = targetUserIds.length > 0 ? `AND u.id NOT IN (${placeholders(targetUserIds.length)})` : ''
  return db
    .prepare(
      `SELECT u.id, u.name, u.dept_id, u.dept_path
         FROM users u
        WHERE u.company_id = ? AND u.deleted_at IS NULL
          AND u.dept_id IN (${placeholders(userDeptIds.length)})
          ${targetClause}
        ORDER BY u.name, u.id`,
    )
    .all(companyId, ...userDeptIds, ...targetUserIds) as unknown as UserRow[]
}

function countUsersWithOtherChannels(
  db: Db,
  companyId: string,
  provider: ChannelProvider,
  userIds: readonly string[],
): number {
  if (userIds.length === 0) return 0
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT u.id) AS n
         FROM users u
        WHERE u.id IN (${placeholders(userIds.length)})
          AND (
            EXISTS (
              SELECT 1 FROM user_identities ui
               WHERE ui.user_id = u.id AND ui.provider <> ? AND ui.status <> 'revoked'
            )
            OR EXISTS (
              SELECT 1 FROM channel_identities ci
               WHERE ci.user_id = u.id AND ci.company_id = ? AND ci.provider <> ?
                 AND ci.revoked_at IS NULL
            )
          )`,
    )
    .get(...userIds, provider, companyId, provider) as CountRow | undefined
  return Number(row?.n ?? 0)
}

function countTable(
  db: Db,
  sql: string,
  userIds: readonly string[],
  companyId?: string,
): number {
  if (userIds.length === 0) return 0
  const row = companyId
    ? (db.prepare(sql).get(companyId, ...userIds) as CountRow | undefined)
    : (db.prepare(sql).get(...userIds) as CountRow | undefined)
  return Number(row?.n ?? 0)
}

function buildPlan(db: Db, companyId: string, provider: ChannelProvider): {
  preview: ChannelUnbindPlan
  root: CompanyRoot
  depts: DeptRow[]
  targetUsers: UserRow[]
  protected: UserRow[]
} {
  const root = defaultRootDept(db, companyId)
  const depts = collectDeptSubtree(db, companyId, provider, root)
  const deptIds = depts.map((row) => row.id)
  const targetUsers = providerUsers(db, companyId, provider)
  const targetIds = targetUsers.map((row) => row.id)
  const protectedRows = protectedUsers(db, companyId, deptIds, targetIds)
  const identityCounts = (() => {
    const channel = db
      .prepare(
        `SELECT COUNT(*) AS n FROM channel_identities
          WHERE company_id = ? AND provider = ? AND revoked_at IS NULL`,
      )
      .get(companyId, provider) as CountRow | undefined
    const org = db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM user_identities ui
           JOIN users u ON u.id = ui.user_id
          WHERE u.company_id = ? AND ui.provider = ? AND ui.status <> 'revoked'`,
      )
      .get(companyId, provider) as CountRow | undefined
    return Number(channel?.n ?? 0) + Number(org?.n ?? 0)
  })()
  const roles = countTable(
    db,
    `SELECT COUNT(*) AS n FROM user_roles WHERE user_id IN (${placeholders(targetIds.length)})`,
    targetIds,
  )
  const overrides = countTable(
    db,
    `SELECT COUNT(*) AS n FROM authz_overrides
      WHERE company_id = ? AND user_id IN (${targetIds.length > 0 ? placeholders(targetIds.length) : 'NULL'})`,
    targetIds,
    companyId,
  )
  const sessions = countTable(
    db,
    `SELECT COUNT(*) AS n FROM sessions
      WHERE revoked_at IS NULL AND user_id IN (${targetIds.length > 0 ? placeholders(targetIds.length) : 'NULL'})`,
    targetIds,
  )
  const workspaces = countTable(
    db,
    `SELECT COUNT(*) AS n FROM workspace_files
      WHERE archived_at IS NULL AND deleted_at IS NULL
        AND owner_user_id IN (${targetIds.length > 0 ? placeholders(targetIds.length) : 'NULL'})`,
    targetIds,
  )
  const chatSessions = countTable(
    db,
    `SELECT COUNT(*) AS n FROM chat_sessions
      WHERE deleted_at IS NULL AND user_id IN (${targetIds.length > 0 ? placeholders(targetIds.length) : 'NULL'})`,
    targetIds,
  )
  const crossChannelUsers = countUsersWithOtherChannels(db, companyId, provider, targetIds)

  const warnings: string[] = []
  if (provider === 'dingtalk') {
    warnings.push('钉钉按 1B 全量清理：将删除钉钉同步的全部部门和成员，公司根部门保留。')
  }
  if (crossChannelUsers > 0) {
    warnings.push(`有 ${crossChannelUsers} 名成员还持有其他渠道身份，按 2B 会连同成员一起移除。`)
  }
  if (protectedRows.length > 0) {
    warnings.push(`有 ${protectedRows.length} 名 EAB 自有成员挂在待删部门下，会先移到公司根部门。`)
  }

  return {
    preview: {
      provider,
      label: PROVIDER_LABELS[provider],
      departments: depts.length,
      users: targetUsers.length,
      roles,
      overrides,
      sessions,
      workspaces,
      identities: identityCounts,
      protectedUsers: protectedRows.length,
      crossChannelUsers,
      chatSessions,
      warnings,
    },
    root,
    depts,
    targetUsers,
    protected: protectedRows,
  }
}

export function previewChannelUnbind(
  db: Db,
  companyId: string,
  provider: ChannelProvider,
): ChannelUnbindPlan {
  return buildPlan(db, companyId, provider).preview
}

export function executeChannelUnbind(db: Db, options: ExecuteOptions): ChannelUnbindResult {
  const now = options.now ?? Date.now()
  const plan = buildPlan(db, options.companyId, options.provider)
  const { root, depts, targetUsers, protected: protectedRows, preview } = plan
  const deptIds = depts.map((row) => row.id)
  const userIds = targetUsers.map((row) => row.id)

  withTransaction(db, () => {
    // 1. 没有渠道身份、但挂在待删部门下的 EAB 自有成员，先移到公司根部门
    if (protectedRows.length > 0) {
      db.prepare(
        `UPDATE users SET dept_id = ?, dept_path = ?, updated_at = ?
          WHERE company_id = ? AND id IN (${placeholders(protectedRows.length)})`,
      ).run(root.id, root.path, now, options.companyId, ...protectedRows.map((row) => row.id))
    }

    // 2. 只撤销当前渠道的身份；行保留，供重新绑定时按原 user_id 恢复
    db.prepare(
      `UPDATE channel_identities SET revoked_at = ?
        WHERE company_id = ? AND provider = ? AND revoked_at IS NULL`,
    ).run(now, options.companyId, options.provider)
    if (userIds.length > 0) {
      db.prepare(
        `UPDATE user_identities SET status = 'revoked'
          WHERE provider = ? AND user_id IN (${placeholders(userIds.length)})`,
      ).run(options.provider, ...userIds)
    }

    // 3. 软删成员，保留聊天会话；撤销网页会话、归档工作区
    if (userIds.length > 0) {
      db.prepare(
        `UPDATE users SET deleted_at = ?, status = 'disabled', recycled_at = ?, updated_at = ?
          WHERE company_id = ? AND id IN (${placeholders(userIds.length)})`,
      ).run(now, now, now, options.companyId, ...userIds)

      // 按 3A：成员的完整角色和权限覆盖一起删除
      db.prepare(`DELETE FROM user_roles WHERE user_id IN (${placeholders(userIds.length)})`).run(...userIds)
      db.prepare(
        `DELETE FROM authz_overrides
          WHERE company_id = ? AND user_id IN (${placeholders(userIds.length)})`,
      ).run(options.companyId, ...userIds)
      db.prepare(
        `UPDATE sessions SET revoked_at = ?
          WHERE user_id IN (${placeholders(userIds.length)}) AND revoked_at IS NULL`,
      ).run(now, ...userIds)
      db.prepare(
        `UPDATE workspace_files SET archived_at = ?
          WHERE owner_user_id IN (${placeholders(userIds.length)})
            AND deleted_at IS NULL AND archived_at IS NULL`,
      ).run(now, ...userIds)
    }

    // 4. 负责人先置空，再软删部门，避免部门引用一个已删除成员
    if (userIds.length > 0) {
      db.prepare(
        `UPDATE departments SET manager_user_id = NULL
          WHERE company_id = ? AND manager_user_id IN (${placeholders(userIds.length)})`,
      ).run(options.companyId, ...userIds)
    }
    if (deptIds.length > 0) {
      db.prepare(
        `UPDATE departments SET manager_user_id = NULL, deleted_at = ?
          WHERE company_id = ? AND id IN (${placeholders(deptIds.length)})`,
      ).run(now, options.companyId, ...deptIds)
    }

    // 5. 清渠道绑定配置
    db.prepare(
      `UPDATE channel_configs
          SET tenant_id = NULL, tenant_name = NULL, bound_at = NULL, bound_by_user_id = NULL,
              enabled = 0, status = 'unbound', sync_mode = 'off',
              last_sync_run_id = NULL, last_synced_at = NULL,
              last_sync_status = NULL, last_sync_error = NULL, updated_at = ?
        WHERE company_id = ? AND provider = ?`,
    ).run(now, options.companyId, options.provider)

    appendAudit(
      db,
      {
        companyId: options.companyId,
        actorUserId: options.actorUserId ?? 'console-operator',
        action: 'channel.unbind',
        resourceType: 'channel',
        resourceId: options.provider,
        result: 'success',
        detail: {
          provider: options.provider,
          label: preview.label,
          removed: {
            departments: preview.departments,
            users: preview.users,
            roles: preview.roles,
            overrides: preview.overrides,
            sessions: preview.sessions,
            workspaces: preview.workspaces,
            identities: preview.identities,
          },
          protectedUsers: preview.protectedUsers,
          crossChannelUsers: preview.crossChannelUsers,
          chatSessionsPreserved: preview.chatSessions,
        },
        ip: options.ip ?? null,
        channel: 'console',
      },
      now,
    )
  })

  return {
    preview,
    removed: {
      departments: preview.departments,
      users: preview.users,
      roles: preview.roles,
      overrides: preview.overrides,
      sessions: preview.sessions,
      workspaces: preview.workspaces,
      identities: preview.identities,
    },
    preserved: {
      protectedUsers: preview.protectedUsers,
      chatSessions: preview.chatSessions,
    },
    crossChannelUsers: preview.crossChannelUsers,
  }
}
