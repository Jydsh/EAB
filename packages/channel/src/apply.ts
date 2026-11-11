/**
 * 把映射结果落库（幂等 + 缺失计数 + 同步报告）。
 *
 * 三条必须守住的规则（架构文档 8.6）：
 * 1. **幂等**：同一份 RemoteOrg 跑两次，第二次不产生任何写入、diff 为空。
 * 2. **不误删**：上游缺失只计数（missing_runs），连续 recycleAfter 次才回收。
 * 3. **路径不自洽就修**：部门移动后，子树 path 与成员的 dept_path 由一次全量重建补齐，
 *    包括本地手工建的、不在同步结果里的子部门。
 */
import { EC, EabError, ulid } from '@eab/domain'
import { withTransaction, type Db } from '@eab/storage'
import { emptyStats, type SyncDiff, type SyncPlan, type SyncStats } from './types.js'

export interface ApplyOrgSyncOptions {
  readonly plan: SyncPlan
  readonly mode?: 'full' | 'incremental'
  readonly now?: number
  /** 连续多少次全量缺失才回收（默认 2，对应"隔一次算数"） */
  readonly recycleAfter?: number
  readonly companyRootDeptId?: string
}

export interface SyncOutcome {
  readonly runId: string
  readonly status: 'ok'
  readonly stats: SyncStats
  readonly diffs: readonly SyncDiff[]
}

interface DeptDbRow {
  id: string
  parent_id: string | null
  name: string
  path: string
  depth: number
  order_no: number
  channel_dept_id: string | null
  manager_user_id: string | null
  deleted_at: number | null
  missing_at: number | null
  missing_runs: number
}

interface UserDbRow {
  id: string
  name: string
  title: string | null
  employee_no: string | null
  mobile: string | null
  avatar: string | null
  dept_id: string
  dept_path: string
  status: string
  missing_at: number | null
  missing_runs: number
  recycled_at: number | null
}

interface IdentityRow {
  user_id: string
  external_user_id: string
}

interface PathRepairResult {
  readonly changed: number
  readonly changedDeptIds: readonly string[]
}

/**
 * 全量重建部门 path / depth（按 parent_id 走一遍 BFS），顺带把成员的 dept_path 对齐。
 * 为什么每次同步都跑：一次部门移动会让所有后代 path 与成员的 dept_path 同时过期，
 * 与其在 N 处补丁里记得改，不如每次同步后统一收敛一次。
 */
export function rebuildDeptPaths(db: Db, companyId: string, root: { id: string; path: string }): PathRepairResult {
  const rows = db
    .prepare(
      `SELECT id, parent_id, path, depth FROM departments
        WHERE company_id = ? AND deleted_at IS NULL`,
    )
    .all(companyId) as unknown as Array<{ id: string; parent_id: string | null; path: string; depth: number }>

  const byId = new Map(rows.map((row) => [row.id, row]))
  const childrenOf = new Map<string, typeof rows>()
  for (const row of rows) {
    if (row.parent_id === null || !byId.has(row.parent_id)) continue
    const list = childrenOf.get(row.parent_id) ?? []
    list.push(row)
    childrenOf.set(row.parent_id, list)
  }

  const expected = new Map<string, { path: string; depth: number }>()
  const rootRow = byId.get(root.id)
  if (!rootRow) throw new EabError(EC.INTERNAL, `公司根部门不存在: ${root.id}`)
  expected.set(root.id, { path: root.path, depth: rootRow.depth })

  const queue: string[] = [root.id]
  const seen = new Set<string>([root.id])
  while (queue.length > 0) {
    const id = queue.shift() as string
    const parent = expected.get(id)
    if (!parent) continue
    for (const child of childrenOf.get(id) ?? []) {
      if (seen.has(child.id)) {
        throw new EabError(EC.INTERNAL, `部门结构存在环: ${child.id}`, { details: { deptId: child.id } })
      }
      seen.add(child.id)
      expected.set(child.id, { path: `${parent.path}${child.id}/`, depth: parent.depth + 1 })
      queue.push(child.id)
    }
  }

  const changedDeptIds: string[] = []
  const update = db.prepare('UPDATE departments SET path = ?, depth = ? WHERE id = ? AND company_id = ?')
  for (const row of rows) {
    const want = expected.get(row.id)
    if (!want) continue // 挂在环上的节点，交给上面抛错，不在这里猜
    if (want.path === row.path && want.depth === row.depth) continue
    update.run(want.path, want.depth, row.id, companyId)
    changedDeptIds.push(row.id)
  }

  // 成员的 dept_path 必须跟着部门走，否则范围过滤会拿旧路径算权限
  const users = db
    .prepare(
      `SELECT u.id AS id, u.dept_id AS dept_id, u.dept_path AS dept_path, d.path AS dept_path_now
         FROM users u JOIN departments d ON d.id = u.dept_id
        WHERE u.company_id = ?`,
    )
    .all(companyId) as unknown as Array<{ id: string; dept_id: string; dept_path: string; dept_path_now: string }>
  const fixUserPath = db.prepare('UPDATE users SET dept_path = ?, updated_at = ? WHERE id = ? AND company_id = ?')
  const now = Date.now()
  for (const user of users) {
    if (user.dept_path === user.dept_path_now) continue
    fixUserPath.run(user.dept_path_now, now, user.id, companyId)
    if (!changedDeptIds.includes(user.dept_id)) changedDeptIds.push(user.dept_id)
  }

  return { changed: changedDeptIds.length, changedDeptIds }
}

function defaultRootDept(db: Db, companyId: string): { id: string; path: string } {
  const row = db
    .prepare(
      `SELECT id, path FROM departments
        WHERE company_id = ? AND parent_id IS NULL AND deleted_at IS NULL
        ORDER BY path LIMIT 1`,
    )
    .get(companyId) as { id?: string; path?: string } | undefined
  if (!row?.id || !row.path) {
    throw new EabError(EC.VALIDATION, `公司 ${companyId} 没有根部门，无法同步`, {
      hint: '先建组织根部门（或执行演示数据初始化）',
    })
  }
  return { id: row.id, path: row.path }
}

export function applyOrgSync(db: Db, options: ApplyOrgSyncOptions): SyncOutcome {
  const plan = options.plan
  const now = options.now ?? Date.now()
  const mode = options.mode ?? 'full'
  const recycleAfter = Math.max(1, options.recycleAfter ?? 2)

  if (plan.depts.length === 0 && plan.users.length === 0) {
    throw new EabError(EC.VALIDATION, '同步结果为空，拒绝对空结果执行（否则会把整家公司的组织判成缺失）')
  }

  const runId = ulid(now)
  const stats = emptyStats()
  const diffs: SyncDiff[] = []

  const deptByChannel = new Map<string, DeptDbRow>()
  const identityByExternal = new Map<string, string>()
  const userById = new Map<string, UserDbRow>()

  const rootDept = options.companyRootDeptId
    ? (() => {
        const row = db
          .prepare('SELECT id, path FROM departments WHERE id = ? AND company_id = ?')
          .get(options.companyRootDeptId, plan.companyId) as { id?: string; path?: string } | undefined
        if (!row?.id || !row.path) {
          throw new EabError(EC.VALIDATION, `指定的公司根部门不存在: ${options.companyRootDeptId}`)
        }
        return { id: row.id, path: row.path }
      })()
    : defaultRootDept(db, plan.companyId)

  withTransaction(db, () => {
    const existingDepts = db
      .prepare(
        `SELECT id, parent_id, name, path, depth, order_no, channel_dept_id, manager_user_id, deleted_at, missing_at, missing_runs
           FROM departments
          WHERE company_id = ? AND channel = ? AND channel_dept_id IS NOT NULL`,
      )
      .all(plan.companyId, plan.provider) as unknown as DeptDbRow[]
    for (const row of existingDepts) {
      if (row.channel_dept_id) deptByChannel.set(row.channel_dept_id, row)
    }

    const identities = db
      .prepare('SELECT user_id, external_user_id FROM user_identities WHERE provider = ?')
      .all(plan.provider) as unknown as IdentityRow[]
    for (const row of identities) identityByExternal.set(row.external_user_id, row.user_id)

    if (identities.length > 0) {
      const userIds = identities.map((row) => row.user_id)
      const users = db
        .prepare(
          `SELECT id, name, title, employee_no, mobile, avatar, dept_id, dept_path, status, missing_at, missing_runs, recycled_at
             FROM users WHERE id IN (${userIds.map(() => '?').join(', ')})`,
        )
        .all(...userIds) as unknown as UserDbRow[]
      for (const row of users) userById.set(row.id, row)
    }

    const insertDept = db.prepare(
      `INSERT INTO departments
         (id, company_id, parent_id, name, path, depth, order_no, channel, channel_dept_id, manager_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const updateDept = db.prepare(
      `UPDATE departments
          SET parent_id = ?, name = ?, path = ?, depth = ?, order_no = ?,
              manager_user_id = ?, deleted_at = ?, missing_at = ?, missing_runs = ?
        WHERE id = ? AND company_id = ?`,
    )

    for (const row of plan.depts) {
      const existing = deptByChannel.get(row.channelDeptId)
      if (!existing) {
        insertDept.run(
          row.id,
          plan.companyId,
          row.parentId,
          row.name,
          row.path,
          row.depth,
          row.orderNo,
          plan.provider,
          row.channelDeptId,
          row.managerUserId ?? null,
          now,
        )
        stats.deptsCreated += 1
        diffs.push({
          itemType: 'dept',
          action: 'dept.create',
          entityId: row.id,
          before: null,
          after: { name: row.name, path: row.path, parentId: row.parentId },
        })
        continue
      }

      const renamed = existing.name !== row.name
      const moved =
        existing.parent_id !== row.parentId ||
        existing.path !== row.path ||
        existing.depth !== row.depth ||
        existing.order_no !== row.orderNo
      const restored = existing.deleted_at !== null
      const wasMissing = existing.missing_runs > 0 || existing.missing_at !== null
      const managerChanged = existing.manager_user_id !== (row.managerUserId ?? null)

      if (!renamed && !moved && !restored && !wasMissing && !managerChanged) {
        stats.unchanged += 1
        continue
      }

      updateDept.run(
        row.parentId,
        row.name,
        row.path,
        row.depth,
        row.orderNo,
        row.managerUserId ?? null,
        null,
        null,
        0,
        existing.id,
        plan.companyId,
      )

      if (renamed) {
        stats.deptsRenamed += 1
        diffs.push({
          itemType: 'dept',
          action: 'dept.rename',
          entityId: existing.id,
          before: { name: existing.name },
          after: { name: row.name },
        })
      }
      if (moved) {
        stats.deptsMoved += 1
        diffs.push({
          itemType: 'dept',
          action: 'dept.move',
          entityId: existing.id,
          before: { parentId: existing.parent_id, path: existing.path },
          after: { parentId: row.parentId, path: row.path },
        })
      }
      if (restored) {
        stats.deptsRestored += 1
        diffs.push({
          itemType: 'dept',
          action: 'dept.restore',
          entityId: existing.id,
          before: { deletedAt: existing.deleted_at },
          after: { deletedAt: null },
        })
      }
      if (!renamed && !moved && !restored) stats.unchanged += 1
    }

    // 部门移动后子树 path 会过期：统一重建（含本地手工建的子部门）。
    // 重建本身不再记 diff —— 移动这件事已经在被移动的那个部门上记过一次了。
    rebuildDeptPaths(db, plan.companyId, rootDept)

    const insertUser = db.prepare(
      `INSERT INTO users
         (id, company_id, dept_id, dept_path, name, title, employee_no, mobile, avatar, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const updateUser = db.prepare(
      `UPDATE users
          SET dept_id = ?, dept_path = ?, name = ?, title = ?, employee_no = ?, mobile = ?, avatar = ?, status = ?,
              missing_at = ?, missing_runs = ?, recycled_at = ?, updated_at = ?
        WHERE id = ? AND company_id = ?`,
    )
    const insertIdentity = db.prepare(
      `INSERT INTO user_identities (id, user_id, provider, external_user_id, union_id, bound_at, bound_by, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
    )
    /**
     * 机器人回调只读 channel_identities；同步只写 user_identities 会导致“钉钉里同步进来的人，
     * 机器人却认不出”。这里把两张表在同步时打通：以 provider + external_id 为唯一键，
     * 已存在（哪怕绑到别人）就不动，避免一家公司抢走另一家的外部账号。
     */
    const ensureChannelIdentity = db.prepare(
      `INSERT INTO channel_identities (id, company_id, provider, external_id, user_id, created_at)
       SELECT ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM channel_identities
           WHERE provider = ? AND external_id = ? AND revoked_at IS NULL
        )`,
    )
    const bridgeIdentity = (userId: string, externalId: string) => {
      ensureChannelIdentity.run(
        ulid(now),
        plan.companyId,
        plan.provider,
        externalId,
        userId,
        now,
        plan.provider,
        externalId,
      )
    }

    for (const row of plan.users) {
      const existingUserId = identityByExternal.get(row.channelUserId)
      const existing = existingUserId ? userById.get(existingUserId) : undefined
      if (!existing) {
        /**
         * 身份表里可能残留“成员行已被删掉”的孤儿身份（例如历史清理/恢复只带回了身份）。
         * 这种身份不能再插一行：provider + external_user_id 是唯一键，会整次同步失败。
         * 直接复用身份指向的 user_id 重建成员，并跳过身份插入；没有身份时才新建。
         */
        const userId = existingUserId ?? row.id
        insertUser.run(
          userId,
          plan.companyId,
          row.deptId,
          row.deptPath,
          row.name,
          row.title,
          row.employeeNo,
          row.mobile ?? null,
          row.avatar ?? null,
          row.status === 'departed' ? 'departed' : 'active',
          now,
          now,
        )
        if (!existingUserId) {
          insertIdentity.run(
            ulid(now),
            userId,
            plan.provider,
            row.channelUserId,
            row.unionId,
            now,
            `sync:${plan.provider}`,
          )
          stats.identitiesCreated += 1
        }
        bridgeIdentity(userId, row.channelUserId)
        stats.usersCreated += 1
        diffs.push({
          itemType: 'user',
          action: 'user.create',
          entityId: userId,
          before: null,
          after: { name: row.name, deptId: row.deptId, mobile: row.mobile ?? null, channelUserId: row.channelUserId },
        })
        if (!existingUserId) {
          diffs.push({
            itemType: 'identity',
            action: 'identity.create',
            entityId: userId,
            before: null,
            after: { provider: plan.provider, externalUserId: row.channelUserId, status: 'pending' },
          })
        }
        continue
      }

      const targetStatus = row.status === 'departed' ? 'departed' : 'active'
      bridgeIdentity(existing.id, row.channelUserId)
      /** 上游没给手机号（常见于钉钉未开「企业员工手机号信息」权限）时保留库里已有值，不覆盖手工补的号码 */
      const nextMobile = row.mobile === undefined ? existing.mobile : row.mobile
      /** 头像同理：钉钉用默认头像时不返回 avatar，不能把库里已经抓到的地址清空 */
      const nextAvatar = row.avatar || existing.avatar
      // disabled（被回收）或 departed（上游已标离职）只要回来就是恢复，不该混进"成员变更"
      const restoredToActive = targetStatus === 'active' && existing.status !== 'active'
      const departedNow = targetStatus === 'departed' && existing.status !== 'departed'
      const changed =
        existing.name !== row.name ||
        existing.title !== row.title ||
        existing.employee_no !== row.employeeNo ||
        (row.mobile !== undefined && existing.mobile !== row.mobile) ||
        nextAvatar !== existing.avatar ||
        existing.dept_id !== row.deptId ||
        existing.dept_path !== row.deptPath ||
        existing.status !== targetStatus ||
        existing.missing_runs > 0 ||
        existing.missing_at !== null ||
        existing.recycled_at !== null

      if (!changed) {
        stats.unchanged += 1
        continue
      }

      updateUser.run(
        row.deptId,
        row.deptPath,
        row.name,
        row.title,
        row.employeeNo,
        nextMobile,
        nextAvatar,
        targetStatus,
        null,
        0,
        null,
        now,
        existing.id,
        plan.companyId,
      )

      if (restoredToActive) {
        stats.usersRestored += 1
        diffs.push({
          itemType: 'user',
          action: 'user.restore',
          entityId: existing.id,
          before: { status: existing.status },
          after: { status: targetStatus },
        })
      } else if (departedNow) {
        stats.usersDeparted += 1
        diffs.push({
          itemType: 'user',
          action: 'user.depart',
          entityId: existing.id,
          before: { status: existing.status },
          after: { status: targetStatus },
        })
      } else {
        stats.usersUpdated += 1
        diffs.push({
          itemType: 'user',
          action: 'user.update',
          entityId: existing.id,
          before: {
            name: existing.name,
            title: existing.title,
            mobile: existing.mobile,
            avatar: existing.avatar,
            deptId: existing.dept_id,
            deptPath: existing.dept_path,
            status: existing.status,
          },
          after: {
            name: row.name,
            title: row.title,
            mobile: nextMobile,
            avatar: nextAvatar,
            deptId: row.deptId,
            deptPath: row.deptPath,
            status: targetStatus,
          },
        })
      }
    }

    // 上游缺失：只计数，不立刻删
    const planDeptChannels = new Set(plan.depts.map((row) => row.channelDeptId))
    const missDept = db.prepare(
      'UPDATE departments SET missing_at = ?, missing_runs = ?, deleted_at = ? WHERE id = ? AND company_id = ?',
    )
    for (const [channelId, existing] of deptByChannel) {
      if (planDeptChannels.has(channelId)) continue
      const runs = existing.missing_runs + 1
      const missingAt = existing.missing_at ?? now
      const recycle = runs >= recycleAfter && existing.deleted_at === null
      missDept.run(missingAt, runs, recycle ? now : existing.deleted_at, existing.id, plan.companyId)
      if (recycle) {
        stats.deptsRecycled += 1
        diffs.push({
          itemType: 'dept',
          action: 'dept.recycle',
          entityId: existing.id,
          before: { name: existing.name, path: existing.path },
          after: { deletedAt: now, missingRuns: runs },
        })
      } else {
        stats.deptsMissing += 1
        diffs.push({
          itemType: 'dept',
          action: 'dept.missing',
          entityId: existing.id,
          before: { missingRuns: existing.missing_runs },
          after: { missingRuns: runs },
        })
      }
    }

    const planUserChannels = new Set(plan.users.map((row) => row.channelUserId))
    const missUser = db.prepare(
      `UPDATE users SET missing_at = ?, missing_runs = ?, status = ?, recycled_at = ?, updated_at = ?
        WHERE id = ? AND company_id = ?`,
    )
    for (const [externalId, userId] of identityByExternal) {
      if (planUserChannels.has(externalId)) continue
      const existing = userById.get(userId)
      if (!existing) continue
      const runs = existing.missing_runs + 1
      const missingAt = existing.missing_at ?? now
      const disable = runs >= recycleAfter
      missUser.run(
        missingAt,
        runs,
        disable ? 'disabled' : existing.status,
        disable ? now : existing.recycled_at,
        now,
        existing.id,
        plan.companyId,
      )
      if (disable) {
        stats.usersDisabled += 1
        diffs.push({
          itemType: 'user',
          action: 'user.disable',
          entityId: existing.id,
          before: { status: existing.status },
          after: { status: 'disabled', missingRuns: runs },
        })
      } else {
        stats.usersMissing += 1
        diffs.push({
          itemType: 'user',
          action: 'user.missing',
          entityId: existing.id,
          before: { missingRuns: existing.missing_runs },
          after: { missingRuns: runs },
        })
      }
    }

    stats.orphans = plan.orphans.length
    stats.unassignedUsers = plan.unassignedUsers.length

    // 写同步报告：先 run 再 diffs，diffs 外键指向 run
    db.prepare(
      `INSERT INTO org_sync_runs (id, company_id, provider, mode, status, started_at, ended_at, stats_json, error_json)
       VALUES (?, ?, ?, ?, 'ok', ?, ?, ?, NULL)`,
    ).run(runId, plan.companyId, plan.provider, mode, now, Date.now(), JSON.stringify(stats))

    const insertDiff = db.prepare(
      `INSERT INTO org_sync_diffs (id, run_id, company_id, item_type, action, entity_id, before_json, after_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const diff of diffs) {
      insertDiff.run(
        ulid(now),
        runId,
        plan.companyId,
        diff.itemType,
        diff.action,
        diff.entityId,
        diff.before === null ? null : JSON.stringify(diff.before),
        diff.after === null ? null : JSON.stringify(diff.after),
        now,
      )
    }

    const config = db
      .prepare('SELECT id FROM channel_configs WHERE company_id = ? AND provider = ?')
      .get(plan.companyId, plan.provider) as { id?: string } | undefined
    if (config?.id) {
      // status 由绑定决定（已绑定='bound'），同步只更新"上次跑的是哪次"，不要把绑定状态盖掉
      db.prepare(
        `UPDATE channel_configs
            SET last_sync_run_id = ?, last_synced_at = ?,
                status = CASE WHEN tenant_id IS NOT NULL THEN 'bound' ELSE 'ok' END,
                updated_at = ?
          WHERE id = ?`,
      ).run(runId, now, now, config.id)
    }
  })

  return { runId, status: 'ok', stats, diffs }
}
