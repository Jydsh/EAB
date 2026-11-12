/**
 * 渠道与组织同步的类型（对应架构文档 8.6 / 15.5）。
 *
 * 这里只放"数据形状"，不放任何渠道 SDK 调用：
 * provider 负责把各家 API 的差异消化在 fetchOrg 里，产出统一的 RemoteOrg；
 * 之后的映射与落库完全不认识飞书/钉钉/企微。
 */

export type ChannelProviderId = 'feishu' | 'dingtalk' | 'wecom' | 'mock'

/** 渠道接入配置（明文 secret 不进这里，只存 secrets 表里的引用） */
export interface ChannelConfig {
  readonly provider: ChannelProviderId
  readonly appId?: string
  readonly appSecret?: string
  readonly agentId?: string
  readonly corpId?: string
}

export interface RemoteDept {
  readonly channelDeptId: string
  /** 顶层部门给 null / '0' / 自身 ID（各家约定不同，映射层统一处理） */
  readonly parentChannelDeptId: string | null
  readonly name: string
  readonly order?: number
  /** 渠道直接给出部门负责人时填这里（钉钉一般不直接给，靠成员的 leader_in_dept 补） */
  readonly managerChannelUserId?: string
}

export interface RemoteUser {
  readonly channelUserId: string
  readonly unionId?: string
  readonly name: string
  readonly title?: string
  readonly employeeNo?: string
  /** 渠道返回的手机号（可能带 +86 / 分隔符，映射层统一归一化） */
  readonly mobile?: string
  /** 渠道返回的头像地址；没有就留空，前端回退到姓名首字 */
  readonly avatar?: string
  /** 可能属于多个部门（兼职/多部门）；第一个能映射上的当主部门 */
  readonly channelDeptIds: readonly string[]
  /** 渠道标记了“这个人是这些部门的负责人/组长” */
  readonly leaderDeptIds?: readonly string[]
  readonly status: 'active' | 'departed'
}

export interface RemoteOrg {
  readonly depts: readonly RemoteDept[]
  readonly users: readonly RemoteUser[]
}

/** 渠道适配器：只做"取数"，不做映射、不写库 */
export interface OrgProvider {
  readonly id: ChannelProviderId
  readonly label: string
  verify(cfg: ChannelConfig): Promise<{ ok: boolean; message: string }>
  fetchOrg(cfg: ChannelConfig): Promise<RemoteOrg>
}

/** 映射结果里的一行部门（还没落库） */
export interface SyncDeptRow {
  readonly id: string
  readonly channelDeptId: string
  readonly parentId: string
  readonly name: string
  readonly path: string
  readonly depth: number
  readonly orderNo: number
  /** 父部门在渠道返回里不存在（多半是"该部门未授权可见"），已挂到公司根 */
  readonly orphan: boolean
  /** 部门负责人在本地的 users.id（来自渠道的 leader_in_dept / 部门负责人字段） */
  readonly managerUserId?: string | null
}

/** 映射结果里的一行成员 */
export interface SyncUserRow {
  readonly id: string
  readonly channelUserId: string
  readonly unionId: string | null
  readonly name: string
  readonly title: string | null
  readonly employeeNo: string | null
  /** 归一化后的手机号；同步时写入 users.mobile，也作为登录账号 */
  readonly mobile?: string | null
  /** 渠道头像地址；同步时写入 users.avatar，没有则保留库里已有值 */
  readonly avatar?: string | null
  readonly deptId: string
  readonly deptPath: string
  readonly status: 'active' | 'departed'
  /** 除了主部门之外的其它部门（仅记录，不参与权限判定） */
  readonly extraDeptIds: readonly string[]
}

export interface SyncPlan {
  readonly companyId: string
  readonly provider: ChannelProviderId
  readonly depts: readonly SyncDeptRow[]
  readonly users: readonly SyncUserRow[]
  readonly orphans: readonly { channelDeptId: string; parentChannelDeptId: string; name: string }[]
  /** 一个部门都映射不上、只能挂到公司根的成员 */
  readonly unassignedUsers: readonly string[]
}

export interface SyncStats {
  deptsCreated: number
  deptsRenamed: number
  deptsMoved: number
  deptsRestored: number
  deptsMissing: number
  deptsRecycled: number
  usersCreated: number
  usersUpdated: number
  usersDeparted: number
  usersMissing: number
  usersDisabled: number
  usersRestored: number
  identitiesCreated: number
  identitiesRestored: number
  orphans: number
  unassignedUsers: number
  unchanged: number
}

export type SyncDiffAction =
  | 'dept.create'
  | 'dept.rename'
  | 'dept.move'
  | 'dept.restore'
  | 'dept.missing'
  | 'dept.recycle'
  | 'user.create'
  | 'user.update'
  | 'user.depart'
  | 'user.missing'
  | 'user.disable'
  | 'user.restore'
  | 'identity.create'

export interface SyncDiff {
  readonly itemType: 'dept' | 'user' | 'identity'
  readonly action: SyncDiffAction
  readonly entityId: string
  readonly before: Record<string, unknown> | null
  readonly after: Record<string, unknown> | null
}

export function emptyStats(): SyncStats {
  return {
    deptsCreated: 0,
    deptsRenamed: 0,
    deptsMoved: 0,
    deptsRestored: 0,
    deptsMissing: 0,
    deptsRecycled: 0,
    usersCreated: 0,
    usersUpdated: 0,
    usersDeparted: 0,
    usersMissing: 0,
    usersDisabled: 0,
    usersRestored: 0,
    identitiesCreated: 0,
    identitiesRestored: 0,
    orphans: 0,
    unassignedUsers: 0,
    unchanged: 0,
  }
}
