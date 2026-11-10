/**
 * buildScopeFilter：把 Subject 翻译成"可以下推到数据库的过滤谓词"。
 *
 * 这是整套权限设计的承重墙。三条铁律：
 * 1. 永不返回"无限制"（P.TRUE）除非 subject.dataScope === 'global'，
 *    且 global 也必须被审计标记（reason = 'global-scope'）。
 * 2. 永远以 company 谓词打底，跨公司串号在谓词层面就不可能发生。
 * 3. 无可用列可过滤时返回 FALSE（宁可查不到，不可查过头）。
 *
 * 两个方向的部门语义（容易搞错，必须分清）：
 * - `down`：管人/管文件 —— 看本部门及**下级**（成员、部门文件）
 * - `up`  ：看知识 —— 看本部门及**上级**的制度/知识（下级不能看上级未公开的内容，但上级制度对下级公开）
 */
import {
  EC,
  EabError,
  SC,
  isKnowledgeKind,
  isPathWithin,
  resolveVisibleCollections,
  scopeAllows,
  type EntityKind,
  type KbCollectionAcl,
  type Scope,
  type Subject,
} from '@eab/domain'
import { P, type Predicate } from './predicate.js'

export interface EntityProfile {
  /** 公司列 */
  readonly company: string
  /** 归属用户列 */
  readonly owner?: string
  /** 部门物化路径列 */
  readonly deptPath?: string
  /** 归属维度列（user/dept/project/chat/company） */
  readonly scopeType?: string
  /** 归属对象 ID 列 */
  readonly scopeId?: string
  readonly deptMode?: 'up' | 'down'
  /** 所属知识库列（知识类实体用于 ACL 过滤） */
  readonly collection?: string
  /** 密级列（非知识库管理员看不到机密） */
  readonly classification?: string
}

/** 各资源实体的列画像。新增实体必须在这里登记，否则 buildScopeFilter 报错（不静默放行） */
export const ENTITY_PROFILES: Record<EntityKind, EntityProfile> = {
  company: { company: 'id' },
  dept: { company: 'company_id', deptPath: 'path', deptMode: 'down' },
  user: { company: 'company_id', owner: 'id', deptPath: 'dept_path', deptMode: 'down' },
  conversation: {
    company: 'company_id',
    owner: 'owner_user_id',
    scopeType: 'scope_type',
    scopeId: 'scope_id',
  },
  file: {
    company: 'company_id',
    owner: 'owner_user_id',
    deptPath: 'dept_path',
    scopeType: 'scope_type',
    scopeId: 'scope_id',
    deptMode: 'down',
  },
  kb_doc: {
    company: 'company_id',
    owner: 'owner_user_id',
    deptPath: 'dept_path',
    scopeType: 'scope_type',
    scopeId: 'scope_id',
    deptMode: 'up',
    collection: 'collection_id',
    classification: 'classification',
  },
  kb_chunk: {
    company: 'company_id',
    owner: 'owner_user_id',
    deptPath: 'dept_path',
    scopeType: 'scope_type',
    scopeId: 'scope_id',
    deptMode: 'up',
    collection: 'collection_id',
    classification: 'classification',
  },
  plugin: { company: 'company_id' },
  approval: { company: 'company_id', owner: 'requester_user_id' },
  audit: { company: 'company_id', owner: 'actor_user_id' },
  memory: {
    company: 'company_id',
    owner: 'owner_user_id',
    scopeType: 'scope_type',
    scopeId: 'scope_id',
  },
}

export interface ScopeFilter {
  readonly entity: EntityKind
  readonly action: Scope
  readonly predicate: Predicate
  /** 供日志/审计解释"为什么是这个范围" */
  readonly reason: string
}

export interface ScopeFilterContext {
  /**
   * 知识库可见范围配置（来自 `kb_collections`，进程内有缓存）。
   * 对知识类实体的**读**操作是必填：缺了就返回空集（宁可查不到，也不猜）。
   */
  readonly collections?: readonly KbCollectionAcl[]
}

/**
 * 知识类读操作的可见性谓词：公司内 + 可见知识库 + 密级。
 * 一个函数只做一件事，并且与 PDP 的 `kb-collection-acl` 分支共用 `isCollectionVisible`。
 */
function knowledgeVisibilityPredicate(
  subject: Subject,
  entity: EntityKind,
  action: Scope,
  collections: readonly KbCollectionAcl[] | undefined,
  profile: EntityProfile,
): Predicate | undefined {
  if (action !== SC.KB_READ || !isKnowledgeKind(entity) || profile.collection === undefined) {
    return undefined
  }
  // 配置没加载上来 → 空集。绝不允许"因为没配置就全放行"。
  if (collections === undefined) return P.FALSE

  const visible = resolveVisibleCollections(subject, collections)
  const collectionFilter = P.in(profile.collection, [...visible])

  // 密级：非知识库管理员看不到 confidential（与 PDP 的 classification 分支保持一致，
  // 否则会出现"列表里有、点开被拒"）。部门管理员的 kb:admin 只覆盖本部门，不能按公司级
  // 管理员绕过密级，否则会把公司机密库一并放出来。
  const kbAdmin = subject.scopes.has(SC.KB_ADMIN) && subject.dataScope === 'company'
  if (kbAdmin || profile.classification === undefined) {
    return collectionFilter
  }
  return P.and(collectionFilter, P.in(profile.classification, ['public', 'internal']))
}

export function buildScopeFilter(
  subject: Subject,
  action: Scope,
  entity: EntityKind,
  context: ScopeFilterContext = {},
): ScopeFilter {
  const profile = ENTITY_PROFILES[entity]
  if (!profile) {
    throw new EabError(EC.INTERNAL, `未登记的实体类型: ${entity}`, { details: { entity } })
  }

  // 非 active 账号：查不到任何东西（不是"报错"，而是空集，避免探测）
  if (subject.status !== 'active') {
    return { entity, action, predicate: P.FALSE, reason: 'subject-inactive' }
  }

  // 功能权限不具备时，"数据范围"讨论没有意义：
  // 直接给空集，避免仓储层拿着一个看似合法的过滤器去查一个用户本来就无权做的动作。
  if (!scopeAllows(subject.scopes, action)) {
    return { entity, action, predicate: P.FALSE, reason: 'missing-scope' }
  }

  // 基础：本公司的数据。跨公司串号在这里被切断。
  const base = P.eq(profile.company, subject.companyId)

  /**
   * 平台超管：本公司内无限制（部门/归属都不限），但**不跨公司**。
   *
   * 多公司（一个平台托多家企业）下，"global" 只表示"这家公司里什么都管"，
   * 不能退化成 `1 = 1` —— 那会让一次查询把别家公司的组织、知识库一起捞出来。
   * 跨公司读业务数据应该是"平台运维侧的运维视图"（只读、走 /platform 口令），
   * 而不是超管的一次业务查询。reason 保留显式标记，方便审计认出"这里没加部门限制"。
   */
  if (subject.dataScope === 'global') {
    const kb = knowledgeVisibilityPredicate(subject, entity, action, context.collections, profile)
    return kb === undefined
      ? { entity, action, predicate: base, reason: 'global-scope:company' }
      : { entity, action, predicate: P.and(base, kb), reason: 'global-scope:company+kb-acl' }
  }

  const kb = knowledgeVisibilityPredicate(subject, entity, action, context.collections, profile)
  const withKb = (predicate: Predicate, reason: string): ScopeFilter =>
    kb === undefined
      ? { entity, action, predicate, reason }
      : { entity, action, predicate: P.and(predicate, kb), reason: `${reason}+kb-acl` }

  // 知识类"读"：可见性完全由知识库 ACL 决定，不再叠加部门范围。
  // 否则一个"全员可见"的公司级知识库，会被"只能读本部门"的组织范围挡住（互相打架）。
  if (kb !== undefined) {
    return withKb(base, `${subject.dataScope}-scope:${entity}`)
  }

  if (subject.dataScope === 'company' || subject.dataScope === 'dept_tree') {
    return { entity, action, predicate: base, reason: 'company-scope' }
  }

  // self / dept：在"自己的"与"部门/项目范围内的"之间取并集
  const inner: Predicate[] = []

  // 本部门共享区（部门知识库、部门共享文件）：本部门成员可见
  // 注意：这条必须与 PDP 的 `own-dept` 分支保持一致，否则"列表看得到但打不开"或反之
  if (profile.scopeType && profile.scopeId) {
    inner.push(P.and(P.eq(profile.scopeType, 'dept'), P.eq(profile.scopeId, subject.deptId)))
  }

  if (subject.dataScope === 'dept') {
    if (profile.deptPath) {
      if (profile.deptMode === 'down') {
        // 本部门及下级
        inner.push(P.prefix(profile.deptPath, subject.deptPath))
      } else {
        // 本部门及上级（祖先链，深度很小，直接 IN，可走索引）
        inner.push(P.in(profile.deptPath, subject.deptChain))
      }
    }
    if (profile.scopeType && profile.scopeId && subject.projectIds.length > 0) {
      inner.push(P.and(P.eq(profile.scopeType, 'project'), P.in(profile.scopeId, subject.projectIds)))
    }
  }

  // 自己的：归属列 + 维度为 user 且 ID 是自己
  if (profile.owner) inner.push(P.eq(profile.owner, subject.userId))
  if (profile.scopeType && profile.scopeId) {
    inner.push(P.and(P.eq(profile.scopeType, 'user'), P.eq(profile.scopeId, subject.userId)))
  }

  if (inner.length === 0) {
    // 该实体没有任何可用于限定范围的列 → 宁可查不到
    return { entity, action, predicate: P.FALSE, reason: `no-scopable-column:${entity}` }
  }

  return {
    entity,
    action,
    predicate: P.and(base, P.or(...inner)),
    reason: `${subject.dataScope}-scope:${entity}`,
  }
}

/**
 * 防御性断言：非 global 主体拿到"无限制谓词"一定是代码写错了。
 * 仓储层在真正拼 SQL 之前调用它，把错误暴露在开发期而不是生产期。
 */
export function assertScoped(filter: ScopeFilter, subject: Subject): void {
  if (filter.predicate.kind === 'true' && subject.dataScope !== 'global') {
    throw new EabError(EC.INTERNAL, '越权过滤器：非 global 主体不能使用无限制谓词', {
      details: { entity: filter.entity, action: filter.action, dataScope: subject.dataScope },
    })
  }
}

/** 谓词是否等价于"无限制" */
export function isUnrestricted(predicate: Predicate): boolean {
  return predicate.kind === 'true'
}

/**
 * 部门路径是否命中（按实体登记的 deptMode 判定方向）。
 * PDP 与 buildScopeFilter 共用这一个函数，避免"决策放行但列表查不到"这类口径漂移。
 */
export function deptPathMatches(
  profile: EntityProfile,
  resourcePath: string,
  subjectPath: string,
): boolean {
  const mode = profile.deptMode ?? 'down'
  if (mode === 'down') return isPathWithin(resourcePath, subjectPath)
  if (mode === 'up') return isPathWithin(subjectPath, resourcePath)
  return isPathWithin(resourcePath, subjectPath) || isPathWithin(subjectPath, resourcePath)
}
