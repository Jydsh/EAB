import type { FastifyInstance } from 'fastify'
import { EC, EabError, SC, isKnownScope, scopeAllows, ulid } from '@eab/domain'
import { ok, requireScope } from '../http.js'
import { resolveActor, type RequestActor } from '../session.js'
import type { ServerDeps } from '../deps.js'
import {
  cancelPermissionRequest,
  createPermissionRequest,
  currentScopeViews,
  defaultPolicyView,
  decidePermissionRequest,
  getPermissionRequest,
  listCurrentRoles,
  listPermissionRequests,
  listRequestableRoles,
  listRequestableScopes,
  type PermissionRequestView,
} from '../permission-approvals.js'
import {
  refreshPermissionApprovalCards,
  sendPermissionApprovalCard,
} from '../permission-approval-dingtalk.js'

function canView(actor: RequestActor, view: PermissionRequestView): boolean {
  if (view.requesterUserId === actor.person.id) return true
  return view.steps.some((step) => step.approverUserId === actor.person.id)
}

export function registerPermissionRoutes(app: FastifyInstance, deps: ServerDeps): void {
  /** 全部可申请权限点、当前角色、当前已有权限摘要 + 当前身份能否审批。 */
  app.get('/api/permissions/config', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireScope(actor.subject, SC.APPROVAL_READ)
    const roles = listRequestableRoles(deps.db, actor.person.companyId)
    const currentRoles = listCurrentRoles(deps.db, actor)
    const scopes = listRequestableScopes(deps.db, actor)
    const currentScopes = currentScopeViews(actor)
    return ok({
      // roles 保留给旧版面板/兼容调用；新面板使用 currentRoles 作为申请角色来源。
      roles,
      currentRoles,
      scopes,
      currentScopes,
      defaultPolicy: defaultPolicyView(deps.db, actor.person.companyId),
      canDecide: scopeAllows(actor.subject.scopes, SC.APPROVAL_DECIDE),
      selfOnly: true,
    })
  })

  /** 管理员查看/配置按 scope 的审批链，以及哪些角色可申请。 */
  app.get('/api/permissions/policies', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireScope(actor.subject, SC.AUTHZ_GRANT)
    const rows = deps.db
      .prepare(
        `SELECT id, target_type, target_key, max_levels, include_company_admin,
                timeout_hours, approver_strategy, fixed_approvers_json, updated_at
           FROM permission_approval_policies
          WHERE company_id = ?
          ORDER BY target_type, target_key`,
      )
      .all(actor.person.companyId) as unknown as Array<Record<string, unknown>>
    const roles = deps.db
      .prepare(
        `SELECT code, name, requestable FROM roles
          WHERE company_id = ? AND deleted_at IS NULL
          ORDER BY name`,
      )
      .all(actor.person.companyId) as unknown as Array<Record<string, unknown>>
    return ok({
      policies: rows.map((row) => ({
        id: row.id,
        targetType: row.target_type,
        targetKey: row.target_key,
        maxLevels: Number(row.max_levels),
        includeCompanyAdmin: Number(row.include_company_admin) === 1,
        timeoutHours: Number(row.timeout_hours),
        approverStrategy: row.approver_strategy,
        fixedApprovers: row.fixed_approvers_json ? JSON.parse(String(row.fixed_approvers_json)) : [],
        updatedAt: Number(row.updated_at),
      })),
      roles: roles.map((row) => ({
        code: row.code,
        name: row.name,
        requestable: Number(row.requestable) === 1,
      })),
      defaultPolicy: defaultPolicyView(deps.db, actor.person.companyId),
    })
  })

  app.post<{
    Body: {
      targetType?: string
      targetKey?: string
      maxLevels?: number
      includeCompanyAdmin?: boolean
      timeoutHours?: number
      approverStrategy?: string
      fixedApprovers?: string[]
    }
  }>('/api/permissions/policies', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireScope(actor.subject, SC.AUTHZ_GRANT)
    const companyId = actor.person.companyId
    const targetType = String(req.body?.targetType ?? '').trim()
    const targetKey = String(req.body?.targetKey ?? '').trim()
    if (targetType !== 'scope' && targetType !== 'role' && targetType !== 'default') {
      throw new EabError(EC.VALIDATION, 'targetType 只能是 scope / role / default')
    }
    if (targetType === 'default' && targetKey && targetKey !== 'default') {
      throw new EabError(EC.VALIDATION, 'default 策略的 targetKey 只能是 default')
    }
    if (targetType !== 'default' && !targetKey) throw new EabError(EC.VALIDATION, 'targetKey 不能为空')
    if (targetType === 'scope' && !isKnownScope(targetKey)) {
      throw new EabError(EC.VALIDATION, `未登记的权限点：${targetKey}`)
    }
    if (targetType === 'default' && req.body?.approverStrategy === 'fixed_users') {
      throw new EabError(EC.VALIDATION, '默认审批链只支持部门负责人链')
    }
    if (targetType === 'role') {
      const role = deps.db
        .prepare(`SELECT id FROM roles WHERE company_id = ? AND code = ? AND deleted_at IS NULL LIMIT 1`)
        .get(companyId, targetKey)
      if (!role) throw new EabError(EC.NOT_FOUND, '角色不存在')
    }
    const maxLevels = Math.min(10, Math.max(1, Math.trunc(Number(req.body?.maxLevels ?? 3) || 3)))
    const timeoutHours = Math.min(720, Math.max(1, Math.trunc(Number(req.body?.timeoutHours ?? 72) || 72)))
    const approverStrategy = req.body?.approverStrategy === 'fixed_users' ? 'fixed_users' : 'dept_chain'
    const fixedApprovers = (req.body?.fixedApprovers ?? []).map((id) => String(id).trim()).filter(Boolean).slice(0, 50)
    if (approverStrategy === 'fixed_users' && fixedApprovers.length === 0) {
      throw new EabError(EC.VALIDATION, 'fixed_users 策略必须提供 fixedApprovers')
    }
    const includeCompanyAdmin = req.body?.includeCompanyAdmin === true
    const now = Date.now()
    const id = `pap_${ulid(now)}`
    const effectiveTargetKey = targetType === 'default' ? 'default' : targetKey
    deps.db
      .prepare(
        `INSERT INTO permission_approval_policies
           (id, company_id, target_type, target_key, max_levels, include_company_admin,
            timeout_hours, approver_strategy, fixed_approvers_json, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(company_id, target_type, target_key) DO UPDATE SET
           max_levels = excluded.max_levels,
           include_company_admin = excluded.include_company_admin,
           timeout_hours = excluded.timeout_hours,
           approver_strategy = excluded.approver_strategy,
           fixed_approvers_json = excluded.fixed_approvers_json,
           created_by = excluded.created_by,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        companyId,
        targetType,
        effectiveTargetKey,
        maxLevels,
        includeCompanyAdmin ? 1 : 0,
        timeoutHours,
        approverStrategy,
        approverStrategy === 'fixed_users' ? JSON.stringify(fixedApprovers) : null,
        actor.person.id,
        now,
        now,
      )
    return ok({ saved: true, targetType, targetKey: effectiveTargetKey })
  })

  app.post<{
    Params: { code: string }
    Body: { requestable?: boolean }
  }>('/api/permissions/roles/:code/requestable', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireScope(actor.subject, SC.AUTHZ_GRANT)
    const companyId = actor.person.companyId
    const role = deps.db
      .prepare(`SELECT id, code FROM roles WHERE company_id = ? AND code = ? AND deleted_at IS NULL LIMIT 1`)
      .get(companyId, req.params.code) as { id: string; code: string } | undefined
    if (!role) throw new EabError(EC.NOT_FOUND, '角色不存在')
    const requestable = req.body?.requestable === true
    deps.db
      .prepare(`UPDATE roles SET requestable = ? WHERE id = ?`)
      .run(requestable ? 1 : 0, role.id)
    return ok({ code: role.code, requestable })
  })

  /** mode=mine 我发起的；mode=todo 轮到我审批的。 */
  app.get<{ Querystring: { mode?: string } }>('/api/permissions/requests', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireScope(actor.subject, SC.APPROVAL_READ)
    const mode = String(req.query?.mode ?? 'mine').toLowerCase() === 'todo' ? 'todo' : 'mine'
    return ok({ mode, requests: listPermissionRequests(deps.db, actor, mode) })
  })

  app.get<{ Params: { id: string } }>('/api/permissions/requests/:id', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireScope(actor.subject, SC.APPROVAL_READ)
    const view = getPermissionRequest(deps.db, actor.person.companyId, req.params.id)
    if (!view) throw new EabError(EC.NOT_FOUND, '审批申请不存在')
    if (!canView(actor, view) && !scopeAllows(actor.subject.scopes, SC.APPROVAL_DECIDE)) {
      throw new EabError(EC.FORBIDDEN, '只能查看自己发起或自己参与的审批')
    }
    return ok({ request: view })
  })

  /** 只允许本人发起，不接受“代某成员申请”。 */
  app.post<{
    Body: { scopeCodes?: string[]; roleCode?: string; reason?: string; durationHours?: number }
  }>('/api/permissions/requests', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireScope(actor.subject, SC.CHAT_USE)
    const scopeCodes = Array.isArray(req.body?.scopeCodes)
      ? req.body.scopeCodes.map((scope) => String(scope)).filter(Boolean)
      : undefined
    const view = createPermissionRequest(deps.db, actor, {
      scopeCodes,
      roleCode: String(req.body?.roleCode ?? ''),
      reason: String(req.body?.reason ?? ''),
      durationHours: req.body?.durationHours === undefined ? undefined : Number(req.body.durationHours),
    })
    // 先落库再投递；卡片失败不回滚审批单，详情里可见 card_status/error 并可重发。
    void sendPermissionApprovalCard(deps, view.id, view.currentStep).catch((error) => {
      console.warn('[eab] 权限审批首卡投递失败：', (error as Error).message)
    })
    return ok({ request: view, cardPending: true })
  })

  app.post<{ Params: { id: string } }>('/api/permissions/requests/:id/cancel', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireScope(actor.subject, SC.CHAT_USE)
    const view = cancelPermissionRequest(deps.db, actor, req.params.id)
    void refreshPermissionApprovalCards(deps, view.id).catch((error) => {
      console.warn('[eab] 权限审批撤回后刷新卡片失败：', (error as Error).message)
    })
    return ok({ request: view })
  })

  /** web 兜底审批；与钉钉按钮回调走同一套状态机。 */
  app.post<{
    Params: { id: string }
    Body: { stepNo?: number; decision?: string; comment?: string }
  }>('/api/permissions/requests/:id/decide', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireScope(actor.subject, SC.APPROVAL_DECIDE)
    const decision = String(req.body?.decision ?? '').toLowerCase()
    if (decision !== 'approve' && decision !== 'reject') {
      throw new EabError(EC.VALIDATION, 'decision 只能是 approve / reject')
    }
    const view = decidePermissionRequest(deps.db, actor, {
      requestId: req.params.id,
      stepNo: req.body?.stepNo === undefined ? undefined : Number(req.body.stepNo),
      decision,
      comment: String(req.body?.comment ?? ''),
    })
    void refreshPermissionApprovalCards(deps, view.id).catch((error) => {
      console.warn('[eab] 权限审批决定后刷新卡片失败：', (error as Error).message)
    })
    return ok({ request: view })
  })

  /** 卡片投递失败/审批人换了钉钉后，由当前审批人重发。 */
  app.post<{
    Params: { id: string }
    Body: { stepNo?: number }
  }>('/api/permissions/requests/:id/resend-card', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireScope(actor.subject, SC.APPROVAL_DECIDE)
    const view = getPermissionRequest(deps.db, actor.person.companyId, req.params.id)
    if (!view) throw new EabError(EC.NOT_FOUND, '审批申请不存在')
    const stepNo = req.body?.stepNo === undefined ? view.currentStep : Number(req.body.stepNo)
    const step = view.steps.find((item) => item.stepNo === stepNo)
    if (!step) throw new EabError(EC.NOT_FOUND, '审批步骤不存在')
    if (step.approverUserId !== actor.person.id && !scopeAllows(actor.subject.scopes, SC.AUTHZ_GRANT)) {
      throw new EabError(EC.FORBIDDEN, '只有当前审批人或公司管理员能重发卡片')
    }
    const sent = await sendPermissionApprovalCard(deps, view.id, stepNo)
    return ok({ sent, request: getPermissionRequest(deps.db, actor.person.companyId, view.id) })
  })
}
