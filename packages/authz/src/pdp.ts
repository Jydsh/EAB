/**
 * PDP（策略决策点）：唯一的鉴权入口。
 *
 * 规则优先级（必须保持这个顺序）：
 *   显式拒绝 > 显式允许 > 资源级范围与关系 > 角色继承 > 默认拒绝
 *
 * 设计要点：
 * 1. 每次决策都带 matchedBy，能回答"为什么放行/为什么拒绝"，日志与审计可直接引用。
 * 2. 缺省拒绝：任何没有明确依据的情况都是 deny，不是 allow。
 * 3. 决策是纯函数（除时间入参），便于单测与缓存；不要在决策里查库。
 */
import {
  SC,
  EC,
  isCollectionVisible,
  isKnowledgeKind,
  scopeAllows,
  type Decision,
  type EntityKind,
  type ResourceRef,
  type Scope,
  type Subject,
} from '@eab/domain'
import { ENTITY_PROFILES, deptPathMatches } from './scope-filter.js'

export interface OverrideRule {
  readonly effect: 'allow' | 'deny'
  readonly scope: Scope
  /** 限定到某个用户；不填表示对所有人生效 */
  readonly userId?: string
  /** 限定到某类资源 / 某个资源 */
  readonly resourceType?: EntityKind
  readonly resourceId?: string
  /** 过期时间（毫秒时间戳）；过期即失效 */
  readonly expiresAt?: number
}

export interface ApprovalRule {
  readonly action: Scope
  readonly when: 'always' | 'risk-high'
  readonly approverRole: string
}

export interface PolicyConfig {
  readonly overrides?: readonly OverrideRule[]
  readonly approvals?: readonly ApprovalRule[]
}

/** 默认审批策略：高危工具调用、插件安装、审计导出 */
export const DEFAULT_APPROVALS: readonly ApprovalRule[] = [
  { action: SC.AGENT_TOOL_INVOKE, when: 'risk-high', approverRole: 'dept_admin' },
  { action: SC.PLUGIN_INSTALL, when: 'always', approverRole: 'company_admin' },
  { action: SC.AUDIT_EXPORT, when: 'always', approverRole: 'company_admin' },
  { action: SC.SYSTEM_RESTORE, when: 'always', approverRole: 'company_admin' },
]

function overrideMatches(rule: OverrideRule, subject: Subject, action: Scope, resource: ResourceRef | undefined, now: number): boolean {
  if (rule.scope !== action) return false
  if (rule.expiresAt !== undefined && rule.expiresAt <= now) return false
  if (rule.userId !== undefined && rule.userId !== subject.userId) return false
  if (rule.resourceType !== undefined && resource?.kind !== rule.resourceType) return false
  if (rule.resourceId !== undefined && resource?.id !== rule.resourceId) return false
  return true
}

interface ScopeCheck {
  readonly ok: boolean
  readonly matchedBy: string
}

function checkDataScope(subject: Subject, action: Scope, resource: ResourceRef): ScopeCheck {
  // 跨公司一律拒绝（global 也不跨公司读业务数据，只做运维动作）
  if (resource.companyId !== subject.companyId) {
    return { ok: false, matchedBy: 'company-mismatch' }
  }

  const granted = resource.sharedWithUserIds?.includes(subject.userId) ?? false
  if (granted) return { ok: true, matchedBy: 'granted' }

  // 知识类"读"：可见性由知识库 ACL 决定（与 buildScopeFilter 共用 isCollectionVisible）
  if (action === SC.KB_READ && isKnowledgeKind(resource.kind)) {
    const acl = resource.collectionAcl
    // 没配 ACL 的知识资源：拒绝，不猜（否则等于"默认全员可见"）
    if (acl === undefined) return { ok: false, matchedBy: 'kb-acl-missing' }
    if (isCollectionVisible(acl, subject)) return { ok: true, matchedBy: 'kb-collection-acl' }
    return { ok: false, matchedBy: 'kb-collection-denied' }
  }

  switch (subject.dataScope) {
    case 'global':
      return { ok: true, matchedBy: 'global' }
    case 'company':
    case 'dept_tree':
      return { ok: true, matchedBy: `${subject.dataScope}-scope` }
    case 'dept': {
      if (resource.ownerId === subject.userId) return { ok: true, matchedBy: 'owner' }
      if (resource.scopeType === 'user' && resource.scopeId === subject.userId) {
        return { ok: true, matchedBy: 'self-scope' }
      }
      if (resource.scopeType === 'dept' && resource.scopeId === subject.deptId) {
        return { ok: true, matchedBy: 'own-dept' }
      }
      if (
        resource.deptPath !== undefined &&
        deptPathMatches(ENTITY_PROFILES[resource.kind], resource.deptPath, subject.deptPath)
      ) {
        return { ok: true, matchedBy: 'dept-path' }
      }
      if (resource.scopeType === 'project' && subject.projectIds.includes(resource.scopeId)) {
        return { ok: true, matchedBy: 'project-member' }
      }
      return { ok: false, matchedBy: 'outside-dept' }
    }
    case 'self':
    default: {
      if (resource.ownerId === subject.userId) return { ok: true, matchedBy: 'owner' }
      if (resource.scopeType === 'user' && resource.scopeId === subject.userId) {
        return { ok: true, matchedBy: 'self-scope' }
      }
      // 部门共享区（知识库/共享文件）：本部门成员可见，但他部门不可见
      if (resource.scopeType === 'dept' && resource.scopeId === subject.deptId) {
        return { ok: true, matchedBy: 'own-dept' }
      }
      if (resource.scopeType === 'project' && subject.projectIds.includes(resource.scopeId)) {
        return { ok: true, matchedBy: 'project-member' }
      }
      return { ok: false, matchedBy: 'outside-self' }
    }
  }
}

export function decide(
  subject: Subject,
  action: Scope,
  resource?: ResourceRef,
  policy: PolicyConfig = {},
  now: number = Date.now(),
): Decision {
  // 0. 账号状态
  if (subject.status !== 'active') {
    return { result: 'deny', code: EC.AUTH_REQUIRED, reason: '账号不可用', matchedBy: 'subject-inactive' }
  }

  const overrides = policy.overrides ?? []

  // 1. 显式拒绝优先
  for (const rule of overrides) {
    if (rule.effect === 'deny' && overrideMatches(rule, subject, action, resource, now)) {
      return { result: 'deny', code: EC.FORBIDDEN, reason: '被显式拒绝', matchedBy: 'override-deny' }
    }
  }

  // 2. 功能权限（角色继承 + 隐含），或显式允许
  const hasAllowOverride = overrides.some(
    (rule) => rule.effect === 'allow' && overrideMatches(rule, subject, action, resource, now),
  )
  if (!hasAllowOverride && !scopeAllows(subject.scopes, action)) {
    return {
      result: 'deny',
      code: EC.FORBIDDEN,
      reason: '无功能权限',
      matchedBy: 'missing-scope',
    }
  }

  // 3. 没有资源上下文 = 功能级判定（列表类操作请改用 buildScopeFilter）
  if (resource === undefined) {
    return { result: 'allow', matchedBy: hasAllowOverride ? 'override-allow' : 'role-inherited' }
  }

  // 4. 数据范围与关系
  const scopeCheck = checkDataScope(subject, action, resource)
  if (!scopeCheck.ok) {
    return {
      result: 'deny',
      code: EC.SCOPE_DENIED,
      reason: '超出数据范围',
      matchedBy: scopeCheck.matchedBy,
    }
  }

  // 5. 密级：机密资源仅公司级知识库管理员可读；部门管理员的 kb:admin 只覆盖本部门
  if (
    resource.classification === 'confidential' &&
    !(subject.scopes.has(SC.KB_ADMIN) && subject.dataScope === 'company')
  ) {
    return {
      result: 'deny',
      code: EC.SCOPE_DENIED,
      reason: '密级不足（机密）',
      matchedBy: 'classification',
    }
  }

  // 6. 审批策略
  const approvals = policy.approvals ?? DEFAULT_APPROVALS
  for (const rule of approvals) {
    if (rule.action !== action) continue
    const triggered = rule.when === 'always' || resource.risk === 'high'
    if (triggered) {
      return { result: 'require-approval', approverRole: rule.approverRole, matchedBy: 'approval-policy' }
    }
  }

  return { result: 'allow', matchedBy: scopeCheck.matchedBy }
}
