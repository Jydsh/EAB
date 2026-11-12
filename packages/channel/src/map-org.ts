/**
 * 渠道通讯录 → EAB 组织数据的映射（纯函数：不碰网络、不碰数据库）。
 *
 * 这一层是组织同步里唯一"会想错"的地方，所以单独抽出来用假数据全覆盖测试：
 * - 部门 path 由父链重建，不抄渠道给的层级/排序；
 * - 父部门缺失（多半是"该部门没授权给我们看"）→ 挂到公司根并记 orphan，不猜；
 * - 部门/成员 ID 由渠道 ID 派生，保证重复跑得到同一份结果（幂等的前提）。
 */
import { EC, EabError, normalizeMobile } from '@eab/domain'
import type { ChannelProviderId, RemoteDept, RemoteOrg, SyncDeptRow, SyncPlan, SyncUserRow } from './types.js'

export interface CompanyRootDept {
  readonly id: string
  /** 形如 `/c1/`，首尾都有斜杠 */
  readonly path: string
  readonly depth: number
}

export interface MapOrgOptions {
  readonly companyId: string
  readonly provider: ChannelProviderId
  readonly root: CompanyRootDept
  /**
   * 渠道自己用来代表"公司根"的部门 ID（飞书是 `0`）。
   * 默认不建行，它的子部门直接挂到 EAB 的公司根 —— 否则会出现"甲科技/甲科技"两层同名根。
   * 当 groupChannelRoot=true 时，这个渠道根会变成 EAB 公司根下的一个渠道分组节点，
   * 让飞书/企微的成员在组织架构里能按渠道来源区分。
   */
  readonly rootChannelDeptIds?: readonly string[]
  /** 为 true 时把渠道根建成当前公司下的渠道分组节点；钉钉保持原结构 */
  readonly groupChannelRoot?: boolean
  /** 渠道分组节点显示名称，例如「飞书 · Ai无限可能」 */
  readonly channelRootName?: string
}

/** 各家用来表示"我是顶层"的 parent 值；'0' 是钉钉/企微常见写法，'root' 是飞书沙箱里出现过的 */
const EMPTY_PARENT_MARKERS = new Set(['0', '-1', 'null', 'none', 'root'])

function safeSegment(raw: string, what: string): string {
  const cleaned = raw.trim().replace(/[^A-Za-z0-9_-]/g, '_')
  if (cleaned.length === 0) {
    throw new EabError(EC.VALIDATION, `${what}不是合法的渠道 ID`, { details: { raw } })
  }
  return cleaned.slice(0, 64)
}

export function channelDeptEntityId(provider: ChannelProviderId, channelDeptId: string): string {
  return `d_${provider}_${safeSegment(channelDeptId, '部门 ID ')}`
}

export function channelUserEntityId(provider: ChannelProviderId, channelUserId: string): string {
  return `u_${provider}_${safeSegment(channelUserId, '成员 ID ')}`
}

interface ResolvedParent {
  readonly parentChannelId: string | null
  readonly orphan: boolean
}

function resolveParent(
  dept: RemoteDept,
  byId: ReadonlyMap<string, RemoteDept>,
  rootChannelIds: ReadonlySet<string>,
  groupChannelRoot: boolean,
): ResolvedParent {
  const raw = (dept.parentChannelDeptId ?? '').trim()
  if (raw.length === 0) return { parentChannelId: null, orphan: false }
  if (raw === dept.channelDeptId) return { parentChannelId: null, orphan: false }
  // 渠道自己的"公司根"默认不建行；分组模式下它是一级节点，子部门应挂在它下面。
  if (rootChannelIds.has(raw)) {
    return groupChannelRoot ? { parentChannelId: raw, orphan: false } : { parentChannelId: null, orphan: false }
  }
  if (EMPTY_PARENT_MARKERS.has(raw.toLowerCase())) return { parentChannelId: null, orphan: false }
  if (byId.has(raw)) return { parentChannelId: raw, orphan: false }
  // 父部门没出现在返回里：可能是没授权可见，也可能是数据脏。挂根 + 记 orphan，不猜层级
  return { parentChannelId: null, orphan: true }
}

function countRootChannels(byId: ReadonlyMap<string, RemoteDept>, rootChannelIds: ReadonlySet<string>): number {
  let count = 0
  for (const key of byId.keys()) if (rootChannelIds.has(key)) count += 1
  return count
}

export function mapRemoteOrg(remote: RemoteOrg, options: MapOrgOptions): SyncPlan {
  const { companyId, provider, root } = options
  const rootChannelIds = new Set((options.rootChannelDeptIds ?? []).map((id) => id.trim()).filter(Boolean))
  const groupChannelRoot = options.groupChannelRoot === true && rootChannelIds.size === 1
  const channelRootId = groupChannelRoot ? [...rootChannelIds][0] : ''

  const byId = new Map<string, RemoteDept>()
  for (const dept of remote.depts) {
    const id = dept.channelDeptId.trim()
    if (id.length === 0) {
      throw new EabError(EC.VALIDATION, '渠道返回了空部门 ID')
    }
    if (byId.has(id)) {
      throw new EabError(EC.VALIDATION, `渠道返回了重复的部门 ID: ${id}`, { details: { channelDeptId: id } })
    }
    if (!dept.name || dept.name.trim().length === 0) {
      throw new EabError(EC.VALIDATION, `部门 ${id} 没有名称`)
    }
    byId.set(id, dept)
  }

  if (groupChannelRoot) {
    const base = byId.get(channelRootId)
    byId.set(channelRootId, {
      channelDeptId: channelRootId,
      parentChannelDeptId: null,
      name: (options.channelRootName ?? '').trim() || base?.name?.trim() || '渠道组织',
      order: -1,
    })
  }

  // 部门负责人：优先用部门字段；钉钉从成员的 leader_in_dept 反推（同一部门取第一个标记为 leader 的人）
  const managerByChannelDept = new Map<string, string>()
  for (const dept of remote.depts) {
    const manager = dept.managerChannelUserId?.trim()
    if (manager) managerByChannelDept.set(dept.channelDeptId.trim(), manager)
  }
  for (const user of remote.users) {
    const userId = user.channelUserId.trim()
    for (const deptId of user.leaderDeptIds ?? []) {
      const key = deptId.trim()
      if (key && !managerByChannelDept.has(key)) managerByChannelDept.set(key, userId)
    }
  }

  const parentOf = new Map<string, ResolvedParent>()
  const orphans: { channelDeptId: string; parentChannelDeptId: string; name: string }[] = []
  const childrenOf = new Map<string, RemoteDept[]>()
  const roots: RemoteDept[] = []

  for (const dept of byId.values()) {
    const rawParent = resolveParent(dept, byId, rootChannelIds, groupChannelRoot)
    // 父是渠道自己的"公司根"（飞书 `0`）→ 默认视作挂在 EAB 公司根下；分组模式下保留父子关系
    const resolved: ResolvedParent =
      !groupChannelRoot && rawParent.parentChannelId !== null && rootChannelIds.has(rawParent.parentChannelId)
        ? { parentChannelId: null, orphan: false }
        : rawParent
    parentOf.set(dept.channelDeptId.trim(), resolved)
    if (resolved.orphan) {
      orphans.push({
        channelDeptId: dept.channelDeptId,
        parentChannelDeptId: dept.parentChannelDeptId ?? '',
        name: dept.name,
      })
    }
    const key = resolved.parentChannelId ?? ''
    const list = childrenOf.get(key) ?? []
    list.push(dept)
    childrenOf.set(key, list)
    if (resolved.parentChannelId === null) roots.push(dept)
  }

  const sortSiblings = (list: RemoteDept[]): RemoteDept[] =>
    [...list].sort((a, b) => {
      const ao = a.order ?? 0
      const bo = b.order ?? 0
      if (ao !== bo) return ao - bo
      const cmp = a.name.localeCompare(b.name, 'zh-Hans-CN')
      if (cmp !== 0) return cmp
      return a.channelDeptId.localeCompare(b.channelDeptId)
    })

  const deptRows: SyncDeptRow[] = []
  const rowByChannelId = new Map<string, SyncDeptRow>()
  const visiting = new Set<string>()

  const walk = (dept: RemoteDept, parentId: string, parentPath: string, depth: number): void => {
    const channelId = dept.channelDeptId.trim()
    if (visiting.has(channelId)) {
      throw new EabError(EC.VALIDATION, `渠道返回的部门关系存在环: ${channelId}`, {
        details: { channelDeptId: channelId },
      })
    }
    visiting.add(channelId)
    const id = channelDeptEntityId(provider, channelId)
    const path = `${parentPath}${id}/`
    const managerChannelUserId = managerByChannelDept.get(channelId)
    const row: SyncDeptRow = {
      id,
      channelDeptId: channelId,
      parentId,
      name: dept.name.trim(),
      path,
      depth,
      orderNo: dept.order ?? 0,
      orphan: parentOf.get(channelId)?.orphan ?? false,
      managerUserId: managerChannelUserId ? channelUserEntityId(provider, managerChannelUserId) : null,
    }
    deptRows.push(row)
    rowByChannelId.set(channelId, row)

    for (const child of sortSiblings(childrenOf.get(channelId) ?? [])) {
      walk(child, id, path, depth + 1)
    }
    visiting.delete(channelId)
  }

  const rootLevel: RemoteDept[] = []
  for (const dept of roots) {
    const channelId = dept.channelDeptId.trim()
    if (!groupChannelRoot && rootChannelIds.has(channelId)) {
      // 默认模式：渠道自己的根部门不建行，它的子部门直接成为本地根下的一级部门
      rootLevel.push(...(childrenOf.get(channelId) ?? []))
      continue
    }
    rootLevel.push(dept)
  }

  for (const dept of sortSiblings(rootLevel)) {
    walk(dept, root.id, root.path, root.depth + 1)
  }

  const expectedDeptRows = groupChannelRoot ? byId.size : byId.size - countRootChannels(byId, rootChannelIds)
  if (deptRows.length !== expectedDeptRows) {
    // 没被 DFS 走到的节点说明关系成环，属于渠道数据错误，宁可整次同步失败
    const missing = [...byId.keys()].filter((key) => !rowByChannelId.has(key) && !rootChannelIds.has(key))
    throw new EabError(EC.VALIDATION, '渠道部门关系不连通，疑似成环', { details: { channelDeptIds: missing } })
  }

  const seenUsers = new Set<string>()
  const users: SyncUserRow[] = []
  const unassignedUsers: string[] = []

  for (const user of remote.users) {
    const channelUserId = user.channelUserId.trim()
    if (channelUserId.length === 0) {
      throw new EabError(EC.VALIDATION, '渠道返回了空成员 ID')
    }
    if (seenUsers.has(channelUserId)) {
      throw new EabError(EC.VALIDATION, `渠道返回了重复的成员 ID: ${channelUserId}`, {
        details: { channelUserId },
      })
    }
    seenUsers.add(channelUserId)

    const mappedDeptIds = (user.channelDeptIds ?? [])
      .map((id) => rowByChannelId.get(id.trim()))
      .filter((row): row is SyncDeptRow => row !== undefined)

    const primary = mappedDeptIds[0]
    if (!primary) unassignedUsers.push(channelUserId)

    users.push({
      id: channelUserEntityId(provider, channelUserId),
      channelUserId,
      unionId: user.unionId ?? null,
      name: user.name || channelUserId,
      title: user.title ?? null,
      employeeNo: user.employeeNo ?? null,
      mobile:
        user.mobile === undefined ? undefined : normalizeMobile(user.mobile) || null,
      avatar: user.avatar ?? null,
      deptId: primary?.id ?? root.id,
      deptPath: primary?.path ?? root.path,
      status: user.status,
      extraDeptIds: mappedDeptIds.slice(1).map((row) => row.id),
    })
  }

  return {
    companyId,
    provider,
    depts: deptRows,
    users,
    orphans,
    unassignedUsers,
  }
}
