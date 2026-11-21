/**
 * 多级权限审批：权限点申请、审批链、步骤状态、最终授权。
 *
 * 设计约束（已拍板）：
 * - 只有成员本人能发起申请，不允许上级代申请。
 * - 员工端按权限点申请；所有已登记权限点都可申请，只排除当前身份已经拥有的权限。
 * - 多个权限点合并成一张申请单；审批链取所选权限点中最严格的 scope 策略，未单独配置的走默认策略。
 * - scope 申请最终只写 permission_scope_grants，不写 user_roles、不新增角色。
 * - 申请角色只作为申请身份与审批策略上下文，不参与最终授权。
 * - 历史 role 申请继续按原路径审批并授予角色，保证旧单可查看、可处理。
 * - scope 临时授权到期由读侧过滤，保留授权记录用于审计。
 */
import { ulid } from '@eab/domain'
import { EC, EabError, SCOPE_REGISTRY, isKnownScope, scopeAllows, type Scope } from '@eab/domain'
import { withTransaction, type Db } from '@eab/storage'
import { actorFor, roleCodesOf, type RequestActor } from './session.js'
import { listPublishedApprovalFlows, type ApprovalFlowNode, type PublishedApprovalFlow } from './approval-workflows.js'

const ADMIN_ROLE_CODES = new Set([
  'super_admin',
  'company_admin',
  'company_sub_admin',
  'dept_admin',
])

const DEFAULT_DURATION_HOURS = 168
const MAX_DURATION_HOURS = 720
const DEFAULT_MAX_LEVELS = 3
const MAX_MAX_LEVELS = 10
const DEFAULT_TIMEOUT_HOURS = 72
const MIN_TIMEOUT_HOURS = 1
const MAX_TIMEOUT_HOURS = 24 * 30

export type PermissionRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired'
export type PermissionStepStatus = 'pending' | 'active' | 'approved' | 'rejected' | 'skipped' | 'expired'
export type PermissionDecision = 'approve' | 'reject' | 'cancel' | 'expire'

interface RoleRow {
  id: string
  company_id: string
  code: string
  name: string
  requestable: number
}

interface PolicyRow {
  id: string
  company_id: string
  target_type: string
  target_key: string
  max_levels: number
  include_company_admin: number
  timeout_hours: number
  approver_strategy: string
  fixed_approvers_json: string | null
  created_at: number
}

interface RequestRow {
  id: string
  company_id: string
  requester_user_id: string
  role_id: string
  role_code: string
  role_name: string
  scopes_json: string
  request_type: string
  reason: string
  status: PermissionRequestStatus
  current_step: number
  total_steps: number
  policy_id: string | null
  duration_hours: number
  requested_expires_at: number
  request_deadline: number
  decided_at: number | null
  granted_role_grant_id: string | null
  created_at: number
  updated_at: number
}

interface StepRow {
  id: string
  request_id: string
  company_id: string
  step_no: number
  approver_user_id: string
  approver_name: string
  status: PermissionStepStatus
  card_out_track_id: string | null
  card_status: string
  card_error: string
  decided_at: number | null
  decided_by: string | null
  comment: string
  created_at: number
  updated_at: number
}

interface DeptRow {
  id: string
  parent_id: string | null
  manager_user_id: string | null
  name: string
}

interface ManagedPerson {
  id: string
  name: string
}

export interface PermissionPolicyView {
  /** 默认审批链也可能有持久化行；没有落库时 id 为 null。 */
  id: string | null
  /** 是否为公司默认审批链，用于界面区分“默认”和“单独配置”。 */
  isDefault: boolean
  maxLevels: number
  includeCompanyAdmin: boolean
  timeoutHours: number
  approverStrategy: string
}

export interface CurrentRoleView {
  code: string
  name: string
  /** 该角色单独配置的审批策略；没有则 null，表示按所选权限的策略或默认链。 */
  policy: PermissionPolicyView | null
}

export interface RequestableRoleView {
  code: string
  name: string
  scopes: string[]
  applicable: boolean
  policy: PermissionPolicyView | null
  reason: string
}

/** 员工端可勾选的权限点：全部已登记权限点中，当前身份尚未拥有的部分。 */
export interface RequestableScopeView {
  code: string
  label: string
  group: string
  dangerous: boolean
  applicable: boolean
  policy: PermissionPolicyView | null
  reason: string
}

/** 当前身份已经拥有的权限点，用于面板上的只读摘要。 */
export interface CurrentScopeView {
  code: string
  label: string
  group: string
  dangerous: boolean
}

export interface PermissionStepView {
  id: string
  stepNo: number
  approverUserId: string
  approverName: string
  status: PermissionStepStatus
  cardStatus: string
  cardError: string
  decidedAt: number | null
  decidedBy: string | null
  comment: string
}

export interface PermissionRequestView {
  id: string
  requestType: 'role' | 'scope'
  status: PermissionRequestStatus
  requesterUserId: string
  requesterName: string
  roleCode: string
  roleName: string
  scopes: string[]
  reason: string
  currentStep: number
  totalSteps: number
  durationHours: number
  requestedExpiresAt: number
  requestDeadline: number
  decidedAt: number | null
  grantedRoleGrantId: string | null
  createdAt: number
  updatedAt: number
  steps: PermissionStepView[]
}

export interface PermissionRequestListResult {
  mine: PermissionRequestView[]
  todo: PermissionRequestView[]
}

function parseScopes(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.map((item) => String(item)).filter(Boolean) : []
  } catch {
    return []
  }
}

function readPolicy(row: PolicyRow): PermissionPolicyView {
  return {
    id: row.id || null,
    isDefault: row.target_type === 'default',
    maxLevels: Math.min(MAX_MAX_LEVELS, Math.max(1, Math.trunc(Number(row.max_levels) || DEFAULT_MAX_LEVELS))),
    includeCompanyAdmin: Number(row.include_company_admin) === 1,
    timeoutHours: Math.min(MAX_TIMEOUT_HOURS, Math.max(MIN_TIMEOUT_HOURS, Math.trunc(Number(row.timeout_hours) || DEFAULT_TIMEOUT_HOURS))),
    approverStrategy: row.approver_strategy === 'fixed_users' ? 'fixed_users' : 'dept_chain',
  }
}

/** 未单独配置权限点或角色策略时的公司默认链。 */
function defaultScopePolicyRow(policies: PolicyRow[] = []): PolicyRow {
  const stored = policies.find((row) => row.target_type === 'default')
  if (stored) return stored
  return {
    id: '',
    company_id: '',
    target_type: 'default',
    target_key: 'default',
    max_levels: DEFAULT_MAX_LEVELS,
    include_company_admin: 1,
    timeout_hours: DEFAULT_TIMEOUT_HOURS,
    approver_strategy: 'dept_chain',
    fixed_approvers_json: null,
    created_at: 0,
  }
}

function defaultScopePolicyView(policies: PolicyRow[] = []): PermissionPolicyView {
  return readPolicy(defaultScopePolicyRow(policies))
}

/** 管理端读取当前生效的默认审批链；没有落库时返回内置默认值。 */
export function defaultPolicyView(db: Db, companyId: string): PermissionPolicyView {
  return defaultScopePolicyView(policiesOf(db, companyId))
}

function policiesOf(db: Db, companyId: string): PolicyRow[] {
  return db
    .prepare(
      `SELECT * FROM permission_approval_policies
        WHERE company_id = ?
        ORDER BY target_type, target_key`,
    )
    .all(companyId) as unknown as PolicyRow[]
}

function roleScopesOf(db: Db, roleId: string): string[] {
  return (db.prepare('SELECT scope FROM role_scopes WHERE role_id = ? ORDER BY scope').all(roleId) as unknown as Array<{ scope: string }>)
    .map((row) => row.scope)
}

/**
 * 所选 scope 的审批链：每个 scope 优先使用单独策略，未配置的走默认链，取最严格的一条。
 * “最严格”= 级数最多、超时最短、只要有一条要求公司管理员兜底就保留兜底。
 */
function resolveScopePolicy(
  policies: PolicyRow[],
  scopes: string[],
): { policy: PermissionPolicyView; policies: PolicyRow[] } | null {
  if (scopes.length === 0) return null
  const fallback = defaultScopePolicyRow(policies)
  const matched = scopes.map((scope) => policies.find((row) => row.target_type === 'scope' && row.target_key === scope) ?? fallback)
  if (matched.some((row) => !row)) return null
  const rows = matched as PolicyRow[]
  const strategies = new Set(rows.map((row) => row.approver_strategy === 'fixed_users' ? 'fixed_users' : 'dept_chain'))
  if (strategies.size > 1) return null
  if (strategies.has('fixed_users')) {
    // 多个固定审批人策略只有在审批人集合完全一致时才能合并为一张单；
    // 否则每张策略的审批人不同，用第一条会漏掉其余审批人。
    const signatures = new Set(rows.map((row) => {
      try {
        const parsed = row.fixed_approvers_json ? JSON.parse(row.fixed_approvers_json) as unknown : []
        const ids = Array.isArray(parsed) ? parsed.map((value) => String(value)).filter(Boolean).sort() : []
        return ids.join('|')
      } catch {
        return ''
      }
    }))
    if (signatures.size > 1) return null
  }
  const strictest = [...rows].sort((a, b) => {
    const level = Number(b.max_levels) - Number(a.max_levels)
    if (level !== 0) return level
    return Number(a.timeout_hours) - Number(b.timeout_hours)
  })[0] as PolicyRow
  const maxLevels = Math.max(...rows.map((row) => readPolicy(row).maxLevels))
  const timeoutHours = Math.min(...rows.map((row) => readPolicy(row).timeoutHours))
  const includeCompanyAdmin = rows.some((row) => readPolicy(row).includeCompanyAdmin)
  return {
    policy: {
      id: strictest.id || null,
      isDefault: strictest.target_type === 'default',
      maxLevels,
      includeCompanyAdmin,
      timeoutHours,
      approverStrategy: readPolicy(strictest).approverStrategy,
    },
    policies: rows,
  }
}

/**
 * 角色级策略优先；没有角色策略时按所选 scope 逐项取策略，未单独配置的走默认链。
 */
function resolveRolePolicy(
  policies: PolicyRow[],
  role: RoleRow,
  scopes: string[],
): { policy: PermissionPolicyView; policies: PolicyRow[] } | null {
  const rolePolicy = policies.find((row) => row.target_type === 'role' && row.target_key === role.code)
  if (rolePolicy) {
    return { policy: readPolicy(rolePolicy), policies: [rolePolicy] }
  }
  return resolveScopePolicy(policies, scopes)
}

function roleRowOf(db: Db, companyId: string, roleCode: string): RoleRow | null {
  const row = db
    .prepare(
      `SELECT id, company_id, code, name, requestable
         FROM roles
        WHERE company_id = ? AND code = ? AND deleted_at IS NULL
        LIMIT 1`,
    )
    .get(companyId, roleCode) as RoleRow | undefined
  return row ?? null
}

function requestableRoleRows(db: Db, companyId: string): RoleRow[] {
  return db
    .prepare(
      `SELECT id, company_id, code, name, requestable
         FROM roles
        WHERE company_id = ? AND deleted_at IS NULL AND requestable = 1
        ORDER BY name`,
    )
    .all(companyId) as unknown as RoleRow[]
}

function isAdminRole(code: string): boolean {
  return ADMIN_ROLE_CODES.has(code)
}

function currentPersonOf(db: Db, userId: string): ManagedPerson | null {
  const row = db
    .prepare(
      `SELECT id, name FROM users
        WHERE id = ? AND status = 'active' AND disabled_at IS NULL
        LIMIT 1`,
    )
    .get(userId) as { id: string; name: string } | undefined
  return row ?? null
}

/** 只为判定能力构造最小 person；deptPath 不参与 scope 判定，避免被路径校验拦住。 */
function canDecideInCompany(db: Db, companyId: string, userId: string): boolean {
  const person = db
    .prepare(
      `SELECT id, name, dept_id, dept_path, company_id
         FROM users
        WHERE id = ? AND company_id = ? AND status = 'active' AND disabled_at IS NULL
        LIMIT 1`,
    )
    .get(userId, companyId) as { id: string; name: string; dept_id: string; dept_path: string; company_id: string } | undefined
  if (!person) return false
  const actor = actorFor(db, {
    id: person.id,
    name: person.name,
    title: null,
    avatar: null,
    deptId: person.dept_id,
    deptPath: person.dept_path,
    deptName: '',
    companyId: person.company_id,
    companyName: '',
  })
  return scopeAllows(actor.subject.scopes, 'approval:decide' as Scope)
}

function managerCandidates(
  db: Db,
  companyId: string,
  requester: RequestActor,
  policy: PermissionPolicyView,
  policyRows: PolicyRow[],
): ManagedPerson[] {
  if (policy.approverStrategy === 'fixed_users') {
    const fixed = policyRows[0]?.fixed_approvers_json
    let ids: string[] = []
    try {
      const parsed = fixed ? JSON.parse(fixed) as unknown : []
      ids = Array.isArray(parsed) ? parsed.map((value) => String(value)).filter(Boolean) : []
    } catch {
      ids = []
    }
    if (ids.length === 0) {
      throw new EabError(EC.VALIDATION, '审批策略是 fixed_users，但没有配置固定审批人', {
        hint: '让管理员在权限审批策略里补 fixed_approvers_json',
      })
    }
    return ids
      .filter((id) => id !== requester.person.id)
      .map((id) => currentPersonOf(db, id))
      .filter((person): person is ManagedPerson => Boolean(person))
      .filter((person) => canDecideInCompany(db, companyId, person.id))
  }

  const chain: ManagedPerson[] = []
  const seen = new Set<string>()
  const push = (userId: string | null) => {
    if (!userId || userId === requester.person.id || seen.has(userId)) return
    seen.add(userId)
    if (!canDecideInCompany(db, companyId, userId)) return
    const person = currentPersonOf(db, userId)
    if (!person) return
    chain.push(person)
  }

  let dept = db
    .prepare(
      `SELECT id, parent_id, manager_user_id, name
         FROM departments
        WHERE id = ? AND company_id = ? AND deleted_at IS NULL
        LIMIT 1`,
    )
    .get(requester.person.deptId, companyId) as DeptRow | undefined
  const visited = new Set<string>()
  while (dept && !visited.has(dept.id)) {
    visited.add(dept.id)
    push(dept.manager_user_id)
    if (!dept.parent_id) break
    dept = db
      .prepare(
        `SELECT id, parent_id, manager_user_id, name
           FROM departments
          WHERE id = ? AND company_id = ? AND deleted_at IS NULL
          LIMIT 1`,
      )
      .get(dept.parent_id, companyId) as DeptRow | undefined
  }

  if (policy.includeCompanyAdmin) {
    const admins = db
      .prepare(
        `SELECT u.id, u.name
           FROM user_roles ur
           JOIN roles r ON r.id = ur.role_id
           JOIN users u ON u.id = ur.user_id
          WHERE r.company_id = ? AND r.code = 'company_admin' AND r.deleted_at IS NULL
            AND u.company_id = ? AND u.status = 'active' AND u.disabled_at IS NULL
            AND (ur.expires_at IS NULL OR ur.expires_at > ?)
          ORDER BY u.created_at, u.id
          LIMIT 5`,
      )
      .all(companyId, companyId, Date.now()) as unknown as Array<{ id: string; name: string }>
    for (const admin of admins) push(admin.id)
  }

  return chain
}

function planSteps(
  db: Db,
  companyId: string,
  requester: RequestActor,
  policy: PermissionPolicyView,
  policyRows: PolicyRow[],
  scopes: string[],
): ManagedPerson[] {
  const workflow = matchPublishedWorkflow(db, companyId, scopes)
  if (workflow) {
    const fromFlow = planStepsFromWorkflow(db, companyId, requester, policy, policyRows, workflow, scopes)
    if (fromFlow.length > 0) return fromFlow
  }

  const chain = managerCandidates(db, companyId, requester, policy, policyRows)
    .slice(0, policy.maxLevels)
  if (chain.length === 0) {
    throw new EabError(EC.FORBIDDEN, '没有可用的审批人，申请无法提交', {
      hint: '请先在部门设置负责人，或给公司管理员分配「审批决定」权限',
    })
  }
  return chain
}

interface WorkflowMatchContext {
  sensitive: boolean
  roleCodes: string[]
  deptName: string
}

function workflowContext(db: Db, requester: RequestActor, scopes: string[]): WorkflowMatchContext {
  return {
    sensitive: scopes.some((scope) => Boolean(SCOPE_REGISTRY[scope as Scope]?.dangerous)),
    roleCodes: roleCodesOf(db, requester.person.id),
    deptName: requester.person.deptName || '',
  }
}

/** 没有显式“模板→权限点”映射表时，按模板声明的范围模式做保守匹配。 */
/** 内置示例模板只用于设计器演示，不参与运行时匹配，避免覆盖现有权限策略链。 */
const SEED_WORKFLOW_IDS = new Set(['awf_default', 'awf_sensitive', 'awf_dept_custom'])

function matchPublishedWorkflow(db: Db, companyId: string, scopes: string[]): PublishedApprovalFlow | null {
  const workflows = listPublishedApprovalFlows(db, companyId)
    .filter((workflow) => !SEED_WORKFLOW_IDS.has(workflow.id))
  if (workflows.length === 0) return null
  const sensitive = scopes.some((scope) => Boolean(SCOPE_REGISTRY[scope as Scope]?.dangerous))
  const preferredScopeMode = sensitive ? '按权限点' : '全部权限点'
  const matched = workflows.find((workflow) => workflow.scopeMode === preferredScopeMode)
  if (matched) return matched
  return workflows.find((workflow) => workflow.scopeMode === '全部权限点') ?? workflows[0] ?? null
}

function flattenFlowNodes(nodes: ApprovalFlowNode[], out: ApprovalFlowNode[] = []): ApprovalFlowNode[] {
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue
    out.push(node)
    if (Array.isArray(node.branches)) {
      for (const branch of node.branches) {
        if (Array.isArray(branch?.nodes)) flattenFlowNodes(branch.nodes, out)
      }
    }
  }
  return out
}

function ruleMatches(
  rule: { field?: string; op?: string; value?: string } | undefined,
  ctx: WorkflowMatchContext,
): boolean {
  if (!rule?.field) return false
  const value = String(rule.value ?? '').trim()
  if (rule.field === 'else') return true
  if (rule.field === 'scopeRisk') {
    if (value === 'high') return ctx.sensitive
    if (value === 'low') return !ctx.sensitive
    return false
  }
  if (rule.field === 'role') {
    if (!value) return false
    return ctx.roleCodes.some((code) => code === value || code.includes(value))
  }
  if (rule.field === 'dept') {
    if (!value) return false
    return ctx.deptName.includes(value)
  }
  return false
}

function branchMatchesLabel(label: string, ctx: WorkflowMatchContext): boolean {
  const text = label.trim()
  if (!text) return false
  if (/高危|管理类|敏感/.test(text)) return ctx.sensitive
  if (/普通|低危/.test(text)) return !ctx.sensitive
  return false
}

function pickLegacyBranch(node: ApprovalFlowNode, ctx: WorkflowMatchContext): ApprovalFlowNode[] {
  const branches = Array.isArray(node.branches) ? node.branches : []
  const byRule = branches.find((branch) => ruleMatches(branch.rule, ctx))
  if (byRule) return Array.isArray(byRule.nodes) ? byRule.nodes : []
  const byLabel = branches.find((branch) => branchMatchesLabel(String(branch.label ?? ''), ctx))
  if (byLabel) return Array.isArray(byLabel.nodes) ? byLabel.nodes : []
  const fallback = branches.find((branch) => branch.rule?.field === 'else') ?? branches[0]
  return fallback && Array.isArray(fallback.nodes) ? fallback.nodes : []
}

function pickExplicitNext(
  node: ApprovalFlowNode,
  nodesById: Map<string, ApprovalFlowNode>,
  ctx: WorkflowMatchContext,
): string | null {
  const nextIds = Array.isArray(node.nextIds) ? node.nextIds.map(String).filter(Boolean) : []
  if (nextIds.length === 0) return null
  for (const target of nextIds) {
    const rule = node.edgeRules?.[target]
    if (rule && ruleMatches(rule, ctx)) return target
  }
  for (const target of nextIds) {
    const label = String(node.edgeLabels?.[target] ?? '')
    if (label && branchMatchesLabel(label, ctx)) return target
  }
  const elseTarget = nextIds.find((target) => node.edgeRules?.[target]?.field === 'else')
  if (elseTarget) return elseTarget
  return nodesById.has(nextIds[0]) ? nextIds[0] : null
}

function collectWorkflowApprovalNodes(
  workflow: PublishedApprovalFlow,
  ctx: WorkflowMatchContext,
): ApprovalFlowNode[] {
  const all = flattenFlowNodes(workflow.flow)
  const byId = new Map(all.map((node) => [String(node.id ?? ''), node]))
  const explicit = all.some((node) => Array.isArray(node.nextIds))

  if (!explicit) {
    const result: ApprovalFlowNode[] = []
    const visitList = (nodes: ApprovalFlowNode[]): void => {
      for (const node of nodes) {
        if (!node || typeof node !== 'object') continue
        if (node.kind === 'approval') result.push(node)
        if (node.kind === 'condition') visitList(pickLegacyBranch(node, ctx))
        if (node.kind === 'end') break
      }
    }
    visitList(workflow.flow)
    return result
  }

  const start = byId.get('start') ?? all.find((node) => node.kind === 'start') ?? all[0]
  const result: ApprovalFlowNode[] = []
  const visited = new Set<string>()
  let current: ApprovalFlowNode | undefined = start
  while (current && result.length < 40) {
    const id = String(current.id ?? '')
    if (visited.has(id)) break
    visited.add(id)
    if (current.kind === 'approval') result.push(current)
    if (current.kind === 'end') break
    let nextId: string | null = null
    if (current.kind === 'condition') {
      nextId = pickExplicitNext(current, byId, ctx)
    } else if (Array.isArray(current.nextIds)) {
      nextId = current.nextIds.length > 0 ? String(current.nextIds[0] ?? '') : null
    }
    current = nextId ? byId.get(nextId) : undefined
  }
  return result
}

function approversFromMembers(
  db: Db,
  companyId: string,
  requester: RequestActor,
  node: ApprovalFlowNode,
): ManagedPerson[] {
  const ids = (Array.isArray(node.approvers) ? node.approvers : [])
    .map((approver) => String(approver?.id ?? '').trim())
    .filter(Boolean)
  return ids
    .filter((id) => id !== requester.person.id)
    .map((id) => currentPersonOf(db, id))
    .filter((person): person is ManagedPerson => Boolean(person))
    .filter((person) => canDecideInCompany(db, companyId, person.id))
}

function directManagerOf(
  db: Db,
  companyId: string,
  requester: RequestActor,
): ManagedPerson[] {
  const dept = db
    .prepare(
      `SELECT manager_user_id FROM departments
        WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
    )
    .get(requester.person.deptId, companyId) as { manager_user_id: string | null } | undefined
  const id = dept?.manager_user_id ?? null
  if (!id || id === requester.person.id || !canDecideInCompany(db, companyId, id)) return []
  const person = currentPersonOf(db, id)
  return person ? [person] : []
}

function companyAdminsOf(db: Db, companyId: string, requester: RequestActor): ManagedPerson[] {
  const rows = db
    .prepare(
      `SELECT u.id, u.name
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
         JOIN users u ON u.id = ur.user_id
        WHERE r.company_id = ? AND r.code = 'company_admin' AND r.deleted_at IS NULL
          AND u.company_id = ? AND u.status = 'active' AND u.disabled_at IS NULL
          AND (ur.expires_at IS NULL OR ur.expires_at > ?)
        ORDER BY u.created_at, u.id
        LIMIT 5`,
    )
    .all(companyId, companyId, Date.now()) as unknown as ManagedPerson[]
  return rows.filter((person) => person.id !== requester.person.id && canDecideInCompany(db, companyId, person.id))
}

function approversForWorkflowNode(
  db: Db,
  companyId: string,
  requester: RequestActor,
  policy: PermissionPolicyView,
  policyRows: PolicyRow[],
  node: ApprovalFlowNode,
): ManagedPerson[] {
  const source = String(node.source ?? '').trim()
  let people: ManagedPerson[]
  if (source === 'members') {
    people = approversFromMembers(db, companyId, requester, node)
  } else if (source === 'manager') {
    people = directManagerOf(db, companyId, requester)
  } else if (source === 'company_admin') {
    people = companyAdminsOf(db, companyId, requester)
  } else {
    people = managerCandidates(db, companyId, requester, policy, policyRows).slice(0, policy.maxLevels)
  }

  const mode = String(node.mode ?? node.meta ?? '')
  if (mode.includes('或签')) return people.slice(0, 1)
  return people
}

function planStepsFromWorkflow(
  db: Db,
  companyId: string,
  requester: RequestActor,
  policy: PermissionPolicyView,
  policyRows: PolicyRow[],
  workflow: PublishedApprovalFlow,
  scopes: string[],
): ManagedPerson[] {
  const ctx = workflowContext(db, requester, scopes)
  const approvalNodes = collectWorkflowApprovalNodes(workflow, ctx)
  const steps: ManagedPerson[] = []
  for (const node of approvalNodes) {
    const people = approversForWorkflowNode(db, companyId, requester, policy, policyRows, node)
    if (people.length === 0) {
      throw new EabError(EC.FORBIDDEN, `审批节点「${node.title || node.id}」没有可用审批人，申请无法提交`, {
        hint: '请检查流程节点的审批人配置，或先给对应人员分配「审批决定」权限',
      })
    }
    for (const person of people) steps.push(person)
  }
  return steps
}

function stepViewsOf(db: Db, requestId: string): PermissionStepView[] {
  const rows = db
    .prepare(
      `SELECT * FROM permission_approval_steps
        WHERE request_id = ?
        ORDER BY step_no`,
    )
    .all(requestId) as unknown as StepRow[]
  return rows.map((row) => ({
    id: row.id,
    stepNo: Number(row.step_no),
    approverUserId: row.approver_user_id,
    approverName: row.approver_name,
    status: row.status,
    cardStatus: row.card_status,
    cardError: row.card_error,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    comment: row.comment,
  }))
}

function requesterNameOf(db: Db, userId: string): string {
  const row = db.prepare('SELECT name FROM users WHERE id = ? LIMIT 1').get(userId) as { name: string } | undefined
  return row?.name ?? userId
}

function requestViewOf(db: Db, row: RequestRow): PermissionRequestView {
  return {
    id: row.id,
    requestType: row.request_type === 'scope' ? 'scope' : 'role',
    status: row.status,
    requesterUserId: row.requester_user_id,
    requesterName: requesterNameOf(db, row.requester_user_id),
    roleCode: row.role_code,
    roleName: row.role_name,
    scopes: parseScopes(row.scopes_json),
    reason: row.reason,
    currentStep: Number(row.current_step),
    totalSteps: Number(row.total_steps),
    durationHours: Number(row.duration_hours),
    requestedExpiresAt: Number(row.requested_expires_at),
    requestDeadline: Number(row.request_deadline),
    decidedAt: row.decided_at,
    grantedRoleGrantId: row.granted_role_grant_id,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    steps: stepViewsOf(db, row.id),
  }
}

function requestRowOf(db: Db, companyId: string, requestId: string): RequestRow | null {
  const row = db
    .prepare(
      `SELECT * FROM permission_requests
        WHERE id = ? AND company_id = ?
        LIMIT 1`,
    )
    .get(requestId, companyId) as RequestRow | undefined
  return row ?? null
}

export function listRequestableRoles(db: Db, companyId: string): RequestableRoleView[] {
  const policies = policiesOf(db, companyId)
  return requestableRoleRows(db, companyId).map((role) => {
    const scopes = roleScopesOf(db, role.id)
    if (isAdminRole(role.code)) {
      return {
        code: role.code,
        name: role.name,
        scopes,
        applicable: false,
        policy: null,
        reason: '管理角色默认不可申请',
      }
    }
    const resolved = resolveRolePolicy(policies, role, scopes)
    return {
      code: role.code,
      name: role.name,
      scopes,
      applicable: Boolean(resolved),
      policy: resolved?.policy ?? null,
      reason: resolved ? '' : '角色包含未配置审批链的权限范围，需管理员先配置策略',
    }
  })
}

/**
 * 员工端可申请的权限点。
 *
 * 来源是全部已登记权限点，不再受 role.requestable 或可申请角色拥有的 scope 限制；
 * 只过滤当前身份已经拥有的权限（含 role/scope grant/override 的隐含能力）。
 * 未单独配置策略的权限点使用默认审批链，仍然可以提交。
 */
export function listRequestableScopes(db: Db, actor: RequestActor): RequestableScopeView[] {
  const companyId = actor.person.companyId
  const policies = policiesOf(db, companyId)
  const views: RequestableScopeView[] = []
  for (const [code, meta] of Object.entries(SCOPE_REGISTRY)) {
    if (!meta || actor.subject.scopes.has(code as Scope)) continue
    const policyRow = policies.find((row) => row.target_type === 'scope' && row.target_key === code)
    views.push({
      code,
      label: meta.label,
      group: meta.group,
      dangerous: Boolean(meta.dangerous),
      applicable: true,
      policy: policyRow ? readPolicy(policyRow) : defaultScopePolicyView(policies),
      reason: policyRow ? '' : '未单独配置，按公司默认审批链',
    })
  }
  return views.sort((a, b) => a.group.localeCompare(b.group, 'zh-CN') || a.label.localeCompare(b.label, 'zh-CN') || a.code.localeCompare(b.code))
}

/** 当前身份实际拥有的角色；申请角色下拉与审批路径预览的数据源。 */
export function listCurrentRoles(db: Db, actor: RequestActor): CurrentRoleView[] {
  const policies = policiesOf(db, actor.person.companyId)
  return roleCodesOf(db, actor.person.id)
    .map((code) => roleRowOf(db, actor.person.companyId, code))
    .filter((role): role is RoleRow => Boolean(role))
    .map((role) => {
      const policyRow = policies.find((row) => row.target_type === 'role' && row.target_key === role.code)
      return {
        code: role.code,
        name: role.name,
        policy: policyRow ? readPolicy(policyRow) : null,
      }
    })
}

/** 当前身份实际拥有的权限点摘要；只读展示，不参与申请。 */
export function currentScopeViews(actor: RequestActor): CurrentScopeView[] {
  return [...actor.subject.scopes]
    .filter((scope) => Boolean(SCOPE_REGISTRY[scope]))
    .map((scope) => ({
      code: scope,
      label: SCOPE_REGISTRY[scope].label,
      group: SCOPE_REGISTRY[scope].group,
      dangerous: Boolean(SCOPE_REGISTRY[scope].dangerous),
    }))
    .sort((a, b) => a.group.localeCompare(b.group, 'zh-CN') || a.label.localeCompare(b.label, 'zh-CN') || a.code.localeCompare(b.code))
}

/**
 * scope 申请需要一个现有角色作为身份与审批策略锚点。
 *
 * 数据库的 role_id / role_code / role_name 是 NOT NULL；这里写入申请人选择（或默认第一个）的当前角色，
 * 只用于满足历史表结构、审计上下文和角色级审批策略；审批通过不会把这个角色授予申请人。
 */
function anchorRoleOf(db: Db, companyId: string, actor: RequestActor, preferredRoleCode = ''): RoleRow {
  const currentCodes = roleCodesOf(db, actor.person.id)
  if (preferredRoleCode) {
    if (!currentCodes.includes(preferredRoleCode)) {
      throw new EabError(EC.FORBIDDEN, '申请角色不属于当前身份', {
        hint: '只能选择自己当前拥有的角色作为申请身份',
        details: { roleCode: preferredRoleCode },
      })
    }
    const preferred = roleRowOf(db, companyId, preferredRoleCode)
    if (!preferred) throw new EabError(EC.NOT_FOUND, '申请角色不存在')
    return preferred
  }
  for (const code of currentCodes) {
    const role = roleRowOf(db, companyId, code)
    if (role) return role
  }
  const fallback = roleRowOf(db, companyId, 'member')
  if (fallback) return fallback
  const first = db
    .prepare(
      `SELECT id, company_id, code, name, requestable
         FROM roles
        WHERE company_id = ? AND deleted_at IS NULL
        ORDER BY created_at, id
        LIMIT 1`,
    )
    .get(companyId) as RoleRow | undefined
  if (!first) {
    throw new EabError(EC.CONFLICT, '当前身份没有可用于权限申请的角色锚点', {
      hint: '请先给该成员分配一个基础角色，再发起权限申请',
    })
  }
  return first
}

export interface CreatePermissionRequestInput {
  /** 新员工端按权限点申请；与 roleCode 二选一。 */
  readonly scopeCodes?: readonly string[]
  /** 历史/兼容入口：按角色申请。 */
  readonly roleCode?: string
  readonly reason?: string
  readonly durationHours?: number
  readonly now?: number
}

type ResolvedPolicy = { policy: PermissionPolicyView; policies: PolicyRow[] }

interface PersistPermissionRequestInput {
  companyId: string
  actor: RequestActor
  role: RoleRow
  requestType: 'role' | 'scope'
  scopes: string[]
  reason: string
  durationHours: number
  resolved: ResolvedPolicy
  steps: ManagedPerson[]
  now: number
}

function persistPermissionRequest(db: Db, input: PersistPermissionRequestInput): PermissionRequestView {
  const requestId = `preq_${ulid(input.now)}`
  const job = withTransaction(db, () => {
    db.prepare(
      `INSERT INTO permission_requests
         (id, company_id, requester_user_id, role_id, role_code, role_name, scopes_json,
          request_type, reason, status, current_step, total_steps, policy_id, duration_hours,
          requested_expires_at, request_deadline, decided_at, granted_role_grant_id,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    ).run(
      requestId,
      input.companyId,
      input.actor.person.id,
      input.role.id,
      input.role.code,
      input.role.name,
      JSON.stringify(input.scopes),
      input.requestType,
      input.reason,
      input.steps.length,
      input.resolved.policy.id,
      input.durationHours,
      input.now + input.durationHours * 3_600_000,
      input.now + input.resolved.policy.timeoutHours * 3_600_000,
      input.now,
      input.now,
    )
    const insertStep = db.prepare(
      `INSERT INTO permission_approval_steps
         (id, request_id, company_id, step_no, approver_user_id, approver_name, status,
          card_out_track_id, card_status, card_error, decided_at, decided_by, comment,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'none', '', NULL, NULL, '', ?, ?)`,
    )
    input.steps.forEach((person, index) => {
      insertStep.run(
        `pstep_${ulid(input.now)}`,
        requestId,
        input.companyId,
        index + 1,
        person.id,
        person.name,
        index === 0 ? 'active' : 'pending',
        input.now,
        input.now,
      )
    })
    return requestId
  })
  const row = requestRowOf(db, input.companyId, job)
  if (!row) throw new EabError(EC.INTERNAL, '审批申请创建后读取失败')
  return requestViewOf(db, row)
}

function createScopePermissionRequest(
  db: Db,
  actor: RequestActor,
  scopeCodes: readonly string[],
  roleCodeInput: string,
  reason: string,
  durationHours: number,
  now: number,
): PermissionRequestView {
  const companyId = actor.person.companyId
  const scopes = [...new Set(scopeCodes.map((code) => String(code).trim()).filter(Boolean))].sort()
  if (scopes.length === 0) throw new EabError(EC.VALIDATION, '请至少选择一个要申请的权限')
  for (const code of scopes) {
    if (!isKnownScope(code)) throw new EabError(EC.VALIDATION, `未登记的权限点：${code}`)
    if (actor.subject.scopes.has(code)) {
      throw new EabError(EC.FORBIDDEN, `当前身份已经拥有权限：${code}`, {
        hint: '只需勾选当前身份没有的权限',
        details: { scope: code },
      })
    }
  }

  const anchorRole = anchorRoleOf(db, companyId, actor, roleCodeInput.trim())
  const resolved = resolveRolePolicy(policiesOf(db, companyId), anchorRole, scopes)
  if (!resolved) {
    throw new EabError(EC.VALIDATION, '所选权限的审批策略不一致或缺失', {
      hint: '请分开申请审批策略不一致的权限，或让管理员先补齐 scope 审批策略',
      details: { scopes },
    })
  }

  // 同一成员、同一申请角色、完全相同的权限集合已有待审批申请时，直接返回原单。
  const existing = db
    .prepare(
      `SELECT * FROM permission_requests
        WHERE company_id = ? AND requester_user_id = ? AND request_type = 'scope'
          AND role_id = ? AND status = 'pending' AND scopes_json = ?
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .get(companyId, actor.person.id, anchorRole.id, JSON.stringify(scopes)) as RequestRow | undefined
  if (existing) return requestViewOf(db, existing)

  const steps = planSteps(db, companyId, actor, resolved.policy, resolved.policies, scopes)
  return persistPermissionRequest(db, {
    companyId,
    actor,
    role: anchorRole,
    requestType: 'scope',
    scopes,
    reason,
    durationHours,
    resolved,
    steps,
    now,
  })
}

function createRolePermissionRequest(
  db: Db,
  actor: RequestActor,
  roleCodeInput: string,
  reason: string,
  durationHours: number,
  now: number,
): PermissionRequestView {
  const companyId = actor.person.companyId
  const roleCode = roleCodeInput.trim()
  if (!roleCode) throw new EabError(EC.VALIDATION, '请选择要申请的角色')
  if (isAdminRole(roleCode)) {
    throw new EabError(EC.FORBIDDEN, '管理角色默认不可自助申请', {
      hint: '请由公司管理员在控制台调整角色',
    })
  }
  const role = roleRowOf(db, companyId, roleCode)
  if (!role || Number(role.requestable) !== 1) {
    throw new EabError(EC.FORBIDDEN, '这个角色当前不可申请', {
      hint: '需要管理员先把角色标记为可申请，并配置审批策略',
    })
  }
  const scopes = roleScopesOf(db, role.id)
  const resolved = resolveRolePolicy(policiesOf(db, companyId), role, scopes)
  if (!resolved) {
    throw new EabError(EC.VALIDATION, '角色包含未配置审批策略的权限范围', {
      hint: '请先在「权限审批策略」里为每个 scope 配置审批链',
      details: { roleCode, scopes },
    })
  }

  // 同一成员对同一角色已有待审批申请时，不重复建单，直接返回原单。
  const existing = db
    .prepare(
      `SELECT * FROM permission_requests
        WHERE company_id = ? AND requester_user_id = ? AND role_id = ?
          AND request_type = 'role' AND status = 'pending'
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .get(companyId, actor.person.id, role.id) as RequestRow | undefined
  if (existing) return requestViewOf(db, existing)

  const steps = planSteps(db, companyId, actor, resolved.policy, resolved.policies, scopes)
  return persistPermissionRequest(db, {
    companyId,
    actor,
    role,
    requestType: 'role',
    scopes,
    reason,
    durationHours,
    resolved,
    steps,
    now,
  })
}

export function createPermissionRequest(
  db: Db,
  actor: RequestActor,
  input: CreatePermissionRequestInput,
): PermissionRequestView {
  const now = input.now ?? Date.now()
  const durationHours = Math.min(
    MAX_DURATION_HOURS,
    Math.max(1, Math.trunc(Number(input.durationHours ?? DEFAULT_DURATION_HOURS) || DEFAULT_DURATION_HOURS)),
  )
  const reason = String(input.reason ?? '').trim().slice(0, 500)
  const scopeCodes = Array.isArray(input.scopeCodes) ? input.scopeCodes : []
  if (scopeCodes.length > 0) {
    return createScopePermissionRequest(db, actor, scopeCodes, String(input.roleCode ?? ''), reason, durationHours, now)
  }
  return createRolePermissionRequest(db, actor, String(input.roleCode ?? ''), reason, durationHours, now)
}

export interface DecidePermissionInput {
  readonly requestId: string
  readonly stepNo?: number
  readonly decision: 'approve' | 'reject'
  readonly comment?: string
  readonly eventKey?: string
  readonly now?: number
  /**
   * 平台控制台超管兜底审批：跳过“当前步骤审批人必须是本人”的身份校验，
   * 但决策仍落在那位真实审批人身上（用户表外键），控制台另写审计。
   */
  readonly platformOverride?: boolean
}

function activeStepOf(db: Db, request: RequestRow): StepRow | null {
  const row = db
    .prepare(
      `SELECT * FROM permission_approval_steps
        WHERE request_id = ? AND status = 'active'
        ORDER BY step_no
        LIMIT 1`,
    )
    .get(request.id) as StepRow | undefined
  return row ?? null
}

function grantRole(
  db: Db,
  request: RequestRow,
  approverUserId: string,
  now: number,
): string {
  const grantId = `pgr_${ulid(now)}`
  const expiresAt = now + Number(request.duration_hours) * 3_600_000
  db.prepare(
    `INSERT INTO permission_role_grants
       (id, request_id, company_id, user_id, role_id, role_code, granted_by,
        granted_at, expires_at, revoked_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    grantId,
    request.id,
    request.company_id,
    request.requester_user_id,
    request.role_id,
    request.role_code,
    approverUserId,
    now,
    expiresAt,
    now,
  )
  // 已有永久角色不降级；已有更晚到期时间保留更晚的那个。
  db.prepare(
    `INSERT INTO user_roles (user_id, role_id, granted_by, granted_at, expires_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, role_id) DO UPDATE SET
       granted_by = excluded.granted_by,
       granted_at = excluded.granted_at,
       expires_at = CASE
         WHEN user_roles.expires_at IS NULL THEN NULL
         WHEN excluded.expires_at IS NULL THEN NULL
         ELSE MAX(user_roles.expires_at, excluded.expires_at)
       END`,
  ).run(
    request.requester_user_id,
    request.role_id,
    approverUserId,
    now,
    expiresAt,
  )
  return grantId
}

function grantScopes(
  db: Db,
  request: RequestRow,
  approverUserId: string,
  now: number,
): string[] {
  const scopes = parseScopes(request.scopes_json)
  const expiresAt = now + Number(request.duration_hours) * 3_600_000
  const insert = db.prepare(
    `INSERT OR IGNORE INTO permission_scope_grants
       (id, request_id, company_id, user_id, scope, granted_by,
        granted_at, expires_at, revoked_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  )
  const ids: string[] = []
  for (const scope of scopes) {
    const grantId = `psg_${ulid(now)}`
    insert.run(
      grantId,
      request.id,
      request.company_id,
      request.requester_user_id,
      scope,
      approverUserId,
      now,
      expiresAt,
      now,
    )
    ids.push(grantId)
  }
  return ids
}

export function decidePermissionRequest(
  db: Db,
  actor: RequestActor,
  input: DecidePermissionInput,
): PermissionRequestView {
  const now = input.now ?? Date.now()
  const companyId = actor.person.companyId
  const request = requestRowOf(db, companyId, String(input.requestId ?? ''))
  if (!request) throw new EabError(EC.NOT_FOUND, '审批申请不存在')
  if (request.status !== 'pending') {
    throw new EabError(EC.CONFLICT, `审批申请当前状态是 ${request.status}，不能再处理`, {
      details: { status: request.status },
    })
  }
  if (request.request_deadline <= now) {
    throw new EabError(EC.CONFLICT, '审批申请已超过处理时限，请重新发起', {
      details: { requestDeadline: request.request_deadline },
    })
  }
  if (!scopeAllows(actor.subject.scopes, 'approval:decide' as Scope)) {
    throw new EabError(EC.FORBIDDEN, '当前身份没有「审批决定」权限')
  }
  const step = activeStepOf(db, request)
  if (!step) throw new EabError(EC.CONFLICT, '审批申请没有可处理的当前步骤')
  if (input.stepNo !== undefined && Number(input.stepNo) !== Number(step.step_no)) {
    throw new EabError(EC.CONFLICT, '审批步骤已变化，请刷新后再处理', {
      details: { currentStep: step.step_no },
    })
  }
  if (!input.platformOverride && step.approver_user_id !== actor.person.id) {
    throw new EabError(EC.FORBIDDEN, '当前步骤的审批人不是你', {
      details: { stepNo: step.step_no, approverUserId: step.approver_user_id },
    })
  }
  const decision = input.decision
  if (decision !== 'approve' && decision !== 'reject') {
    throw new EabError(EC.VALIDATION, '审批决定只能是同意或拒绝')
  }
  const comment = String(input.comment ?? '').trim().slice(0, 500)
  const decidedByUserId = input.platformOverride ? step.approver_user_id : actor.person.id
  const eventKey =
    String(input.eventKey ?? '').trim() ||
    `perm:${request.id}:${step.step_no}:${decision}:${decidedByUserId}`
  const stepNo = Number(step.step_no)

  withTransaction(db, () => {
    // event_key 唯一：重复点击、重复回调都只产生一条决策。
    const inserted = db
      .prepare(
        `INSERT OR IGNORE INTO permission_request_decisions
           (id, request_id, step_id, step_no, company_id, approver_user_id, decision,
            comment, event_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `pdec_${ulid(now)}`,
        request.id,
        step.id,
        stepNo,
        companyId,
        decidedByUserId,
        decision,
        comment,
        eventKey,
        now,
      )
    if (Number(inserted.changes) === 0) return

    db.prepare(
      `UPDATE permission_approval_steps
          SET status = ?, decided_at = ?, decided_by = ?, comment = ?, updated_at = ?
        WHERE id = ?`,
    ).run(decision === 'approve' ? 'approved' : 'rejected', now, decidedByUserId, comment, now, step.id)

    if (decision === 'reject') {
      db.prepare(
        `UPDATE permission_approval_steps
            SET status = 'skipped', updated_at = ?
          WHERE request_id = ? AND status IN ('pending', 'active') AND id <> ?`,
      ).run(now, request.id, step.id)
      db.prepare(
        `UPDATE permission_requests
            SET status = 'rejected', decided_at = ?, updated_at = ?
          WHERE id = ? AND status = 'pending'`,
      ).run(now, now, request.id)
      return
    }

    if (stepNo >= Number(request.total_steps)) {
      if (request.request_type === 'scope') {
        grantScopes(db, request, decidedByUserId, now)
        db.prepare(
          `UPDATE permission_requests
              SET status = 'approved', current_step = total_steps,
                  decided_at = ?, granted_role_grant_id = NULL, updated_at = ?
            WHERE id = ? AND status = 'pending'`,
        ).run(now, now, request.id)
      } else {
        const grantId = grantRole(db, request, decidedByUserId, now)
        db.prepare(
          `UPDATE permission_requests
              SET status = 'approved', current_step = total_steps,
                  decided_at = ?, granted_role_grant_id = ?, updated_at = ?
            WHERE id = ? AND status = 'pending'`,
        ).run(now, grantId, now, request.id)
      }
      return
    }

    const next = db
      .prepare(
        `SELECT id FROM permission_approval_steps
          WHERE request_id = ? AND step_no = ? AND status = 'pending'
          LIMIT 1`,
      )
      .get(request.id, stepNo + 1) as { id: string } | undefined
    if (!next) {
      throw new EabError(EC.INTERNAL, '下一级审批步骤缺失')
    }
    db.prepare(
      `UPDATE permission_approval_steps SET status = 'active', updated_at = ? WHERE id = ?`,
    ).run(now, next.id)
    db.prepare(
      `UPDATE permission_requests SET current_step = ?, updated_at = ? WHERE id = ? AND status = 'pending'`,
    ).run(stepNo + 1, now, request.id)
  })

  const updated = requestRowOf(db, companyId, request.id)
  if (!updated) throw new EabError(EC.INTERNAL, '审批处理后读取失败')
  return requestViewOf(db, updated)
}

export function cancelPermissionRequest(
  db: Db,
  actor: RequestActor,
  requestId: string,
  now = Date.now(),
): PermissionRequestView {
  const companyId = actor.person.companyId
  const request = requestRowOf(db, companyId, requestId)
  if (!request) throw new EabError(EC.NOT_FOUND, '审批申请不存在')
  if (request.requester_user_id !== actor.person.id) {
    throw new EabError(EC.FORBIDDEN, '只有申请人本人能撤回申请')
  }
  if (request.status !== 'pending') {
    throw new EabError(EC.CONFLICT, `审批申请当前状态是 ${request.status}，不能撤回`)
  }
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO permission_request_decisions
         (id, request_id, step_id, step_no, company_id, approver_user_id, decision,
          comment, event_key, created_at)
       VALUES (?, ?, NULL, 0, ?, ?, 'cancel', '', ?, ?)`,
    ).run(
      `pdec_${ulid(now)}`,
      request.id,
      companyId,
      actor.person.id,
      `perm:${request.id}:cancel:${actor.person.id}`,
      now,
    )
    db.prepare(
      `UPDATE permission_approval_steps
          SET status = 'skipped', updated_at = ?
        WHERE request_id = ? AND status IN ('pending', 'active')`,
    ).run(now, request.id)
    db.prepare(
      `UPDATE permission_requests
          SET status = 'cancelled', decided_at = ?, updated_at = ?
        WHERE id = ? AND status = 'pending'`,
    ).run(now, now, request.id)
  })
  const updated = requestRowOf(db, companyId, request.id)
  if (!updated) throw new EabError(EC.INTERNAL, '撤回后读取审批申请失败')
  return requestViewOf(db, updated)
}

/** 懒清扫：列表/详情被访问时把超过处理时限的 pending 单标记为 expired。 */
export function expirePermissionRequests(db: Db, companyId: string, now = Date.now()): number {
  const rows = db
    .prepare(
      `SELECT * FROM permission_requests
        WHERE company_id = ? AND status = 'pending' AND request_deadline <= ?
        ORDER BY request_deadline`,
    )
    .all(companyId, now) as unknown as RequestRow[]
  if (rows.length === 0) return 0
  withTransaction(db, () => {
    for (const request of rows) {
      db.prepare(
        `INSERT OR IGNORE INTO permission_request_decisions
           (id, request_id, step_id, step_no, company_id, approver_user_id, decision,
            comment, event_key, created_at)
         VALUES (?, ?, NULL, 0, ?, ?, 'expire', '', ?, ?)`,
      ).run(
        `pdec_${ulid(now)}`,
        request.id,
        companyId,
        request.requester_user_id,
        `perm:${request.id}:expire`,
        now,
      )
      db.prepare(
        `UPDATE permission_approval_steps
            SET status = 'expired', updated_at = ?
          WHERE request_id = ? AND status IN ('pending', 'active')`,
      ).run(now, request.id)
      db.prepare(
        `UPDATE permission_requests
            SET status = 'expired', decided_at = ?, updated_at = ?
          WHERE id = ? AND status = 'pending'`,
      ).run(now, now, request.id)
    }
  })
  return rows.length
}

export function getPermissionRequest(
  db: Db,
  companyId: string,
  requestId: string,
  now = Date.now(),
): PermissionRequestView | null {
  expirePermissionRequests(db, companyId, now)
  const row = requestRowOf(db, companyId, requestId)
  return row ? requestViewOf(db, row) : null
}

export function listPermissionRequests(
  db: Db,
  actor: RequestActor,
  mode: 'mine' | 'todo',
  now = Date.now(),
): PermissionRequestView[] {
  const companyId = actor.person.companyId
  expirePermissionRequests(db, companyId, now)
  if (mode === 'todo') {
    const rows = db
      .prepare(
        `SELECT pr.* FROM permission_requests pr
           JOIN permission_approval_steps ps
             ON ps.request_id = pr.id AND ps.step_no = pr.current_step
          WHERE pr.company_id = ? AND pr.status = 'pending'
            AND ps.status = 'active' AND ps.approver_user_id = ?
          ORDER BY pr.created_at DESC
          LIMIT 50`,
      )
      .all(companyId, actor.person.id) as unknown as RequestRow[]
    return rows.map((row) => requestViewOf(db, row))
  }
  const rows = db
    .prepare(
      `SELECT * FROM permission_requests
        WHERE company_id = ? AND requester_user_id = ?
        ORDER BY created_at DESC
        LIMIT 50`,
    )
    .all(companyId, actor.person.id) as unknown as RequestRow[]
  return rows.map((row) => requestViewOf(db, row))
}

/**
 * 控制台审批记录：平台超管看全公司，不按“我是谁”过滤。
 * todo = 仍在审批中；done = 已结束；all = 全部。
 */
export function listCompanyPermissionRequests(
  db: Db,
  companyId: string,
  mode: 'todo' | 'done' | 'all' = 'all',
  now = Date.now(),
): PermissionRequestView[] {
  expirePermissionRequests(db, companyId, now)
  let rows: RequestRow[]
  if (mode === 'todo') {
    rows = db
      .prepare(
        `SELECT pr.* FROM permission_requests pr
           JOIN permission_approval_steps ps
             ON ps.request_id = pr.id AND ps.step_no = pr.current_step
          WHERE pr.company_id = ? AND pr.status = 'pending'
            AND ps.status = 'active'
          ORDER BY pr.created_at DESC
          LIMIT 100`,
      )
      .all(companyId) as unknown as RequestRow[]
  } else if (mode === 'done') {
    rows = db
      .prepare(
        `SELECT * FROM permission_requests
          WHERE company_id = ? AND status <> 'pending'
          ORDER BY updated_at DESC
          LIMIT 100`,
      )
      .all(companyId) as unknown as RequestRow[]
  } else {
    rows = db
      .prepare(
        `SELECT * FROM permission_requests
          WHERE company_id = ?
          ORDER BY created_at DESC
          LIMIT 100`,
      )
      .all(companyId) as unknown as RequestRow[]
  }
  return rows.map((row) => requestViewOf(db, row))
}

export function isPermissionAdminRole(roleCode: string): boolean {
  return ADMIN_ROLE_CODES.has(roleCode)
}
