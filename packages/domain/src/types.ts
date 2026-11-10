/**
 * 领域基元类型（无 IO、无框架依赖）。
 * 这里定义的 Subject / ResourceRef / Decision 是整条鉴权链路的通用语言，
 * 上层（server / runtime / plugin-host）只允许使用这些类型，不允许自造等价结构。
 */
import type { ErrorCode } from './errors.js'
import type { Scope } from './scopes.js'

/** 资源归属维度 */
export type ScopeType = 'company' | 'dept' | 'user' | 'project' | 'chat'

/**
 * 知识库可见范围模式（collection 级 ACL）。
 * - `all`    公司全员可见（公司级制度默认这样配）
 * - `roles`  仅指定角色可见（如"仅管理层"）
 * - `depts`  仅指定部门及其下级可见（如"仅研发中心"）
 * - `private` 仅所有者可见（个人知识库）
 */
export type KbAclMode = 'all' | 'roles' | 'depts' | 'private'

/**
 * 一个知识库（collection）的可见范围配置。
 * 粒度故意落在"知识库"而不是"单篇文档"：企业里逐篇授权既难维护也难解释，
 * 单篇 override 留到 V1（真有需要再给 doc 加一条覆盖）。
 */
export interface KbCollectionAcl {
  readonly collectionId: string
  readonly companyId: string
  readonly mode: KbAclMode
  /** mode='roles' 时生效：角色码集合（命中任一即可） */
  readonly roleCodes?: readonly string[]
  /** mode='depts' 时生效：部门物化路径集合（命中该部门或其下级） */
  readonly deptPaths?: readonly string[]
  /** mode='private' 时生效：所有者用户 ID */
  readonly ownerUserId?: string
}

/** 数据可见范围（ABAC 的核心属性） */
export type DataScope = 'self' | 'dept' | 'dept_tree' | 'company' | 'global'

export type UserStatus = 'invited' | 'active' | 'disabled' | 'archived' | 'expired'

export type ChannelType = 'web' | 'app' | 'feishu' | 'dingtalk' | 'wecom' | 'portal'

export type Classification = 'public' | 'internal' | 'confidential'

export type Risk = 'low' | 'medium' | 'high'

/**
 * 已认证主体。
 * 不变量：只能由「已验证会话」或「渠道签名事件 + 绑定表」构造，绝不允许从请求体拼装。
 */
export interface Subject {
  readonly userId: string
  readonly companyId: string
  readonly deptId: string
  /** 物化路径，形如 `/c1/d10/d23/` */
  readonly deptPath: string
  /** 祖先链（含自身），形如 `['/c1/', '/c1/d10/', '/c1/d10/d23/']` */
  readonly deptChain: readonly string[]
  readonly roles: readonly string[]
  readonly scopes: ReadonlySet<Scope>
  readonly dataScope: DataScope
  readonly channelType: ChannelType
  readonly status: UserStatus
  /** 已加入的项目 / 已绑定的群域 */
  readonly projectIds: readonly string[]
}

/** 可以被鉴权的资源种类 */
export type EntityKind =
  | 'company'
  | 'dept'
  | 'user'
  | 'conversation'
  | 'file'
  | 'kb_doc'
  | 'kb_chunk'
  | 'plugin'
  | 'approval'
  | 'audit'
  | 'memory'

export interface ResourceRef {
  readonly kind: EntityKind
  readonly id: string
  readonly companyId: string
  readonly scopeType: ScopeType
  readonly scopeId: string
  /** 归属用户（个人资源必填；部门/公司资源可为空） */
  readonly ownerId?: string
  /** 资源所在部门物化路径（部门/人员/文件类资源需要） */
  readonly deptPath?: string
  readonly classification?: Classification
  readonly risk?: Risk
  /** 显式共享给的人（ReBAC 的 granted 关系） */
  readonly sharedWithUserIds?: readonly string[]
  /** 知识资源所属知识库 ID（kb_doc / kb_chunk 必填） */
  readonly collectionId?: string
  /** 知识库的可见范围配置；缺失表示"还没配置"（读操作按拒绝处理，不猜） */
  readonly collectionAcl?: KbCollectionAcl
}

export type Decision =
  | { readonly result: 'allow'; readonly matchedBy: string }
  | {
      readonly result: 'deny'
      readonly code: ErrorCode
      readonly reason: string
      readonly matchedBy: string
    }
  | { readonly result: 'require-approval'; readonly approverRole: string; readonly matchedBy: string }

/** 便捷断言：判断一个决策是否放行 */
export function isAllowed(decision: Decision): decision is { result: 'allow'; matchedBy: string } {
  return decision.result === 'allow'
}

/**
 * 手机号归一化：渠道可能给 `+86 138-0013-8000`，登录页也可能带空格/横线。
 * 统一成纯数字并去掉中国区号，保证同步写入与登录查询是同一个键。
 */
export function normalizeMobile(raw: string | null | undefined): string {
  const digits = String(raw ?? '').replace(/\D/g, '')
  if (digits.length === 13 && digits.startsWith('86')) return digits.slice(2)
  if (digits.length === 15 && digits.startsWith('0086')) return digits.slice(4)
  return digits
}
