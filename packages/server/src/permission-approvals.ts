/**
 * 多级权限审批：角色申请、审批链、步骤状态、最终授权。
 *
 * 设计约束（已拍板）：
 * - 只有成员本人能发起申请，不允许上级代申请。
 * - 审批链按角色拥有的 scope 配置；管理者角色默认不可申请。
 * - 只授角色，不授 scope；最终通过写 permission_role_grants + user_roles。
 * - 角色到期由 user_roles.expires_at 控制，读侧 roleCodesOf 已过滤过期。
 */
import { ulid } from '@eab/domain'
import { EC, EabError, scopeAllows, type Scope } from '@eab/domain'
import { withTransaction, type Db } from '@eab/storage'
import { actorFor, type RequestActor } from './session.js'

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
  id: string
  maxLevels: number
  includeCompanyAdmin: boolean
  timeoutHours: number
  approverStrategy: string
}

export interface RequestableRoleView {
  code: string
  name: string
  scopes: string[]
  applicable: boolean
  policy: PermissionPolicyView | null
  reason: string
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
    id: row.id,
    maxLevels: Math.min(MAX_MAX_LEVELS, Math.max(1, Math.trunc(Number(row.max_levels) || DEFAULT_MAX_LEVELS))),
    includeCompanyAdmin: Number(row.include_company_admin) === 1,
    timeoutHours: Math.min(MAX_TIMEOUT_HOURS, Math.max(MIN_TIMEOUT_HOURS, Math.trunc(Number(row.timeout_hours) || DEFAULT_TIMEOUT_HOURS))),
    approverStrategy: row.approver_strategy === 'fixed_users' ? 'fixed_users' : 'dept_chain',
  }
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
 * 角色级策略优先；否则角色拥有的每个 scope 都必须有策略，取最严格的一条。
 * “最严格”= 级数最多、超时最短、只要有一条要求公司管理员兜底就保留兜底。
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
  if (scopes.length === 0) return null
  const matched = scopes.map((scope) => policies.find((row) => row.target_type === 'scope' && row.target_key === scope))
  if (matched.some((row) => !row)) return null
  const rows = matched as PolicyRow[]
  const strategies = new Set(rows.map((row) => row.approver_strategy === 'fixed_users' ? 'fixed_users' : 'dept_chain'))
  if (strategies.size > 1) return null
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
      id: strictest.id,
      maxLevels,
      includeCompanyAdmin,
      timeoutHours,
      approverStrategy: readPolicy(strictest).approverStrategy,
    },
    policies: rows,
  }
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
): ManagedPerson[] {
  const chain = managerCandidates(db, companyId, requester, policy, policyRows)
    .slice(0, policy.maxLevels)
  if (chain.length === 0) {
    throw new EabError(EC.FORBIDDEN, '没有可用的审批人，申请无法提交', {
      hint: '请先在部门设置负责人，或给公司管理员分配「审批决定」权限',
    })
  }
  return chain
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

export interface CreatePermissionRequestInput {
  readonly roleCode: string
  readonly reason?: string
  readonly durationHours?: number
  readonly now?: number
}

export function createPermissionRequest(
  db: Db,
  actor: RequestActor,
  input: CreatePermissionRequestInput,
): PermissionRequestView {
  const now = input.now ?? Date.now()
  const companyId = actor.person.companyId
  const roleCode = String(input.roleCode ?? '').trim()
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
  const durationHours = Math.min(
    MAX_DURATION_HOURS,
    Math.max(1, Math.trunc(Number(input.durationHours ?? DEFAULT_DURATION_HOURS) || DEFAULT_DURATION_HOURS)),
  )
  const reason = String(input.reason ?? '').trim().slice(0, 500)
  const steps = planSteps(db, companyId, actor, resolved.policy, resolved.policies)

  // 同一成员对同一角色已有待审批申请时，不重复建单，直接返回原单。
  const existing = db
    .prepare(
      `SELECT * FROM permission_requests
        WHERE company_id = ? AND requester_user_id = ? AND role_id = ? AND status = 'pending'
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .get(companyId, actor.person.id, role.id) as RequestRow | undefined
  if (existing) return requestViewOf(db, existing)

  const requestId = `preq_${ulid(now)}`
  const job = withTransaction(db, () => {
    db.prepare(
      `INSERT INTO permission_requests
         (id, company_id, requester_user_id, role_id, role_code, role_name, scopes_json,
          reason, status, current_step, total_steps, policy_id, duration_hours,
          requested_expires_at, request_deadline, decided_at, granted_role_grant_id,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    ).run(
      requestId,
      companyId,
      actor.person.id,
      role.id,
      role.code,
      role.name,
      JSON.stringify(scopes),
      reason,
      steps.length,
      resolved.policy.id,
      durationHours,
      now + durationHours * 3_600_000,
      now + resolved.policy.timeoutHours * 3_600_000,
      now,
      now,
    )
    const insertStep = db.prepare(
      `INSERT INTO permission_approval_steps
         (id, request_id, company_id, step_no, approver_user_id, approver_name, status,
          card_out_track_id, card_status, card_error, decided_at, decided_by, comment,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'none', '', NULL, NULL, '', ?, ?)`,
    )
    steps.forEach((person, index) => {
      insertStep.run(
        `pstep_${ulid(now)}`,
        requestId,
        companyId,
        index + 1,
        person.id,
        person.name,
        index === 0 ? 'active' : 'pending',
        now,
        now,
      )
    })
    return requestId
  })
  const row = requestRowOf(db, companyId, job)
  if (!row) throw new EabError(EC.INTERNAL, '审批申请创建后读取失败')
  return requestViewOf(db, row)
}

export interface DecidePermissionInput {
  readonly requestId: string
  readonly stepNo?: number
  readonly decision: 'approve' | 'reject'
  readonly comment?: string
  readonly eventKey?: string
  readonly now?: number
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
  if (step.approver_user_id !== actor.person.id) {
    throw new EabError(EC.FORBIDDEN, '当前步骤的审批人不是你', {
      details: { stepNo: step.step_no, approverUserId: step.approver_user_id },
    })
  }
  const decision = input.decision
  if (decision !== 'approve' && decision !== 'reject') {
    throw new EabError(EC.VALIDATION, '审批决定只能是同意或拒绝')
  }
  const comment = String(input.comment ?? '').trim().slice(0, 500)
  const eventKey = String(input.eventKey ?? '').trim() || `perm:${request.id}:${step.step_no}:${decision}:${actor.person.id}`
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
        actor.person.id,
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
    ).run(decision === 'approve' ? 'approved' : 'rejected', now, actor.person.id, comment, now, step.id)

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
      const grantId = grantRole(db, request, actor.person.id, now)
      db.prepare(
        `UPDATE permission_requests
            SET status = 'approved', current_step = total_steps,
                decided_at = ?, granted_role_grant_id = ?, updated_at = ?
          WHERE id = ? AND status = 'pending'`,
      ).run(now, grantId, now, request.id)
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

export function isPermissionAdminRole(roleCode: string): boolean {
  return ADMIN_ROLE_CODES.has(roleCode)
}
