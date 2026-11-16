/**
 * 权限审批的钉钉 A2UI 卡片：主动投递、逐级更新、最终收口。
 *
 * 关键点：
 * - 先把 outTrackId 落库，再调用 createAndDeliver；进程重启后仍能凭 DB 找到原卡。
 * - 卡片状态保持 PROCESSING 以便长期停留；只有终态才 FINISH。
 * - 回调只读 DB 校验审批人/步骤，不依赖进程内 clarify 登记表。
 */
import { randomUUID } from 'node:crypto'
import { EabError } from '@eab/domain'
import type { Db } from '@eab/storage'
import type { ServerDeps } from './deps.js'
import { DingTalkAICardStream, type DingTalkRichCardState } from './dingtalk-card.js'
import { dingTalkRecipientOf } from './dingtalk-outbound.js'
import { resolveSecret } from './secrets.js'
import { actorFor, findActivePerson } from './session.js'
import {
  decidePermissionRequest,
} from './permission-approvals.js'

interface ChannelRow {
  app_id: string
  secret_ref: string | null
  robot_code: string | null
  status: string
  enabled: number
}

interface RequestRow {
  id: string
  company_id: string
  requester_user_id: string
  role_code: string
  role_name: string
  scopes_json: string
  request_type: string
  reason: string
  status: string
  current_step: number
  total_steps: number
  duration_hours: number
  created_at: number
}

interface StepRow {
  id: string
  request_id: string
  company_id: string
  step_no: number
  approver_user_id: string
  approver_name: string
  status: string
  card_out_track_id: string | null
  card_status: string
  card_error: string
}

const APPROVAL_CARD_PREFIX = 'approval:'
const OUT_TRACK_PREFIX = 'eab_a2ui_'

function channelOf(db: Db, companyId: string): ChannelRow | null {
  const row = db
    .prepare(
      `SELECT app_id, secret_ref, robot_code, status, enabled
         FROM channel_configs
        WHERE company_id = ? AND provider = 'dingtalk'
        LIMIT 1`,
    )
    .get(companyId) as ChannelRow | undefined
  return row ?? null
}

function scopesText(json: string): string {
  try {
    const value = JSON.parse(json) as unknown
    return Array.isArray(value) ? value.map((item) => String(item)).join('、') : ''
  } catch {
    return ''
  }
}

function daysText(hours: number): string {
  const value = Math.max(1, Number(hours) || 168)
  return value % 24 === 0 ? `${value / 24} 天` : `${value} 小时`
}

function requestOf(db: Db, companyId: string, requestId: string): RequestRow | null {
  return (db
    .prepare('SELECT * FROM permission_requests WHERE id = ? AND company_id = ? LIMIT 1')
    .get(requestId, companyId) as RequestRow | undefined) ?? null
}

function stepOf(db: Db, requestId: string, stepNo: number): StepRow | null {
  return (db
    .prepare('SELECT * FROM permission_approval_steps WHERE request_id = ? AND step_no = ? LIMIT 1')
    .get(requestId, stepNo) as StepRow | undefined) ?? null
}

function activeStepOf(db: Db, requestId: string): StepRow | null {
  return (db
    .prepare(
      `SELECT * FROM permission_approval_steps
        WHERE request_id = ? AND status = 'active'
        ORDER BY step_no LIMIT 1`,
    )
    .get(requestId) as StepRow | undefined) ?? null
}

function requesterNameOf(db: Db, userId: string): string {
  return (db.prepare('SELECT name FROM users WHERE id = ? LIMIT 1').get(userId) as { name: string } | undefined)?.name ?? userId
}

export function approvalSessionId(requestId: string, stepNo: number): string {
  return `${APPROVAL_CARD_PREFIX}${requestId}:${Number(stepNo)}`
}

export function parseApprovalSessionId(value: string): { requestId: string; stepNo: number } | null {
  const text = String(value ?? '').trim()
  if (!text.startsWith(APPROVAL_CARD_PREFIX)) return null
  const rest = text.slice(APPROVAL_CARD_PREFIX.length)
  const [requestId, stepText] = rest.split(':')
  const stepNo = Number(stepText)
  if (!requestId || !Number.isFinite(stepNo) || stepNo <= 0) return null
  return { requestId, stepNo }
}

function approvalState(
  db: Db,
  request: RequestRow,
  step: StepRow,
  mode: 'pending' | 'approved-wait' | 'approved-final' | 'rejected' | 'cancelled' | 'expired',
): DingTalkRichCardState {
  const progress = `第 ${step.step_no} / ${request.total_steps} 级`
  const requestedScopes = scopesText(request.scopes_json) || '—'
  const isScopeRequest = request.request_type === 'scope'
  const header = [
    '### 权限审批',
    `**申请人**：${requesterNameOf(db, request.requester_user_id)}`,
    ...(isScopeRequest
      ? [
          `**申请权限**：${requestedScopes}`,
          '**授权方式**：只授予所选权限，不新增角色',
        ]
      : [
          `**申请角色**：${request.role_name}（${request.role_code}）`,
          `**权限范围**：${requestedScopes}`,
        ]),
    `**有效期**：${daysText(request.duration_hours)}`,
    `**审批进度**：${progress}`,
    request.reason ? `**申请原因**：${request.reason}` : '',
    `**当前审批人**：${step.approver_name}`,
  ].filter(Boolean)

  if (mode === 'pending') {
    return {
      answer: header.join('\n\n'),
      reasoning: '',
      tools: [],
      thinkingDone: true,
      toolDetails: [],
      clarify: {
        sessionId: approvalSessionId(request.id, step.step_no),
        question: '是否同意本次权限申请？',
        options: [
          {
            id: 'approve',
            label: '同意',
            description: step.step_no < request.total_steps ? '通过后进入下一级审批' : (isScopeRequest ? '最后一级通过后授予所选权限' : '最后一级通过后立即授予角色'),
          },
          {
            id: 'reject',
            label: '拒绝',
            description: '不授予权限，审批流程结束',
          },
        ],
        kind: 'single',
        allowCustom: false,
        step: 1,
      },
    }
  }

  const tail =
    mode === 'approved-wait'
      ? '本级已同意，正在等待下一级审批。'
      : mode === 'approved-final'
        ? (isScopeRequest
            ? `审批已通过，所选权限 **${requestedScopes}** 已授予，到期后自动失效。`
            : `审批已通过，角色 **${request.role_name}** 已授予，到期后自动失效。`)
        : mode === 'rejected'
          ? '审批已拒绝，未授予任何权限。'
          : mode === 'cancelled'
            ? '申请人已撤回本次申请。'
            : '审批已超过处理时限，流程结束。'
  return {
    answer: [...header, '', tail].join('\n\n'),
    reasoning: '',
    tools: [],
    thinkingDone: true,
    toolDetails: [],
    clarify: null,
  }
}

function streamFor(deps: ServerDeps, companyId: string, approverUserId: string): DingTalkAICardStream | null {
  const cfg = channelOf(deps.db, companyId)
  if (!cfg?.app_id || cfg.status !== 'bound' || Number(cfg.enabled) !== 1) return null
  const secret = cfg.secret_ref ? resolveSecret(deps.config.dbPath, cfg.secret_ref) : null
  if (!secret) return null
  let externalId = ''
  try {
    externalId = dingTalkRecipientOf(deps, companyId, approverUserId)
  } catch {
    return null
  }
  if (!externalId) return null
  return new DingTalkAICardStream(cfg.app_id, secret, externalId, cfg.robot_code || cfg.app_id)
}

function markCard(
  db: Db,
  step: StepRow,
  patch: { outTrackId?: string | null; status: string; error?: string },
): void {
  db.prepare(
    `UPDATE permission_approval_steps
        SET card_out_track_id = ?, card_status = ?, card_error = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    patch.outTrackId === undefined ? step.card_out_track_id : patch.outTrackId,
    patch.status,
    String(patch.error ?? '').slice(0, 500),
    Date.now(),
    step.id,
  )
}

/**
 * 给某一级审批人主动投递卡片。已有卡时优先原地更新；没有卡或更新失败才新建。
 * 返回是否已有一张可回调的卡。
 */
export async function sendPermissionApprovalCard(
  deps: ServerDeps,
  requestId: string,
  stepNo: number,
): Promise<boolean> {
  const companyId = deps.companyId
  const request = requestOf(deps.db, companyId, requestId)
  if (!request || request.status !== 'pending') return false
  const step = stepOf(deps.db, requestId, stepNo)
  if (!step || step.status !== 'active') return false
  const stream = streamFor(deps, companyId, step.approver_user_id)
  if (!stream) {
    markCard(deps.db, step, { status: 'failed', error: '审批人未绑定钉钉或渠道未就绪' })
    return false
  }

  const state = approvalState(deps.db, request, step, 'pending')
  const existingId = String(step.card_out_track_id ?? '').trim()
  if (existingId) {
    const updated = await stream.updateClarify(existingId, state)
    if (updated) {
      markCard(deps.db, step, { status: 'sent', error: '' })
      return true
    }
  }

  const outTrackId = existingId || `${OUT_TRACK_PREFIX}${randomUUID().replace(/-/g, '')}`
  markCard(deps.db, step, { outTrackId, status: 'sending', error: '' })
  const title = request.request_type === 'scope'
    ? `权限审批：${scopesText(request.scopes_json) || '权限申请'}`
    : `权限审批：${request.role_name}`
  const created = await stream.start(state, title, { outTrackId })
  if (!created) {
    markCard(deps.db, step, { outTrackId, status: 'failed', error: '钉钉 A2UI 卡片投递失败' })
    return false
  }
  markCard(deps.db, step, { outTrackId, status: 'sent', error: '' })
  return true
}

/**
 * 失败卡片的低频补偿：只补投当前 active 且仍 pending 的步骤，避免给已处理步骤重复发卡。
 * 手动重发仍走 API；这里兜底进程重启、渠道短暂不可用等情况。
 */
export function startPermissionApprovalCardRetry(
  deps: ServerDeps,
  options: { intervalMs?: number; initialDelayMs?: number; staleMs?: number } = {},
): () => void {
  const intervalMs = Math.max(60_000, options.intervalMs ?? 10 * 60_000)
  const staleMs = Math.max(60_000, options.staleMs ?? 5 * 60_000)
  let stopped = false
  let running = false

  const tick = async () => {
    if (stopped || running) return
    running = true
    try {
      const rows = deps.db
        .prepare(
          `SELECT s.request_id, s.step_no
             FROM permission_approval_steps s
             JOIN permission_requests r ON r.id = s.request_id
            WHERE s.company_id = ?
              AND s.status = 'active'
              AND s.card_status IN ('failed', 'sending')
              AND r.status = 'pending'
              AND s.updated_at < ?
            ORDER BY s.updated_at
            LIMIT 20`,
        )
        .all(deps.companyId, Date.now() - staleMs) as Array<{ request_id: string; step_no: number }>
      for (const row of rows) {
        if (stopped) break
        try {
          await sendPermissionApprovalCard(deps, row.request_id, row.step_no)
        } catch (error) {
          console.warn(
            `[eab] 审批卡后台重发失败 request=${row.request_id} step=${row.step_no}：${(error as Error).message}`,
          )
        }
      }
    } catch (error) {
      console.warn(`[eab] 审批卡后台巡检失败：${(error as Error).message}`)
    } finally {
      running = false
    }
  }

  const initial = setTimeout(() => void tick(), Math.max(5_000, options.initialDelayMs ?? 30_000))
  const timer = setInterval(() => void tick(), intervalMs)
  initial.unref()
  timer.unref()
  return () => {
    stopped = true
    clearTimeout(initial)
    clearInterval(timer)
  }
}

async function updateStepCard(
  deps: ServerDeps,
  step: StepRow,
  state: DingTalkRichCardState,
  final: boolean,
): Promise<boolean> {
  const outTrackId = String(step.card_out_track_id ?? '').trim()
  if (!outTrackId) return false
  const stream = streamFor(deps, step.company_id, step.approver_user_id)
  if (!stream) return false
  try {
    return final
      ? await stream.completeClarify(outTrackId, state)
      : await stream.updateClarify(outTrackId, state)
  } catch {
    return false
  }
}

/**
 * 审批状态变化后刷新卡片：
 * - 已经处理过的步骤收口成终态；
 * - 新激活的步骤投递卡片；
 * - 拒绝/撤回/超时把剩余卡全部收口。
 */
export async function refreshPermissionApprovalCards(
  deps: ServerDeps,
  requestId: string,
): Promise<void> {
  const companyId = deps.companyId
  const request = requestOf(deps.db, companyId, requestId)
  if (!request) return
  const steps = deps.db
    .prepare('SELECT * FROM permission_approval_steps WHERE request_id = ? ORDER BY step_no')
    .all(requestId) as unknown as StepRow[]
  const activeStep = activeStepOf(deps.db, requestId)

  for (const step of steps) {
    if (!step.card_out_track_id) {
      if (step.status === 'active') await sendPermissionApprovalCard(deps, requestId, step.step_no)
      continue
    }
    if (step.status === 'approved') {
      const final = step.step_no >= Number(request.total_steps)
      await updateStepCard(
        deps,
        step,
        approvalState(deps.db, request, step, final ? 'approved-final' : 'approved-wait'),
        final,
      )
      continue
    }
    if (step.status === 'rejected') {
      await updateStepCard(deps, step, approvalState(deps.db, request, step, 'rejected'), true)
      continue
    }
    if (step.status === 'skipped' || step.status === 'expired') {
      const mode = request.status === 'cancelled' ? 'cancelled' : request.status === 'expired' ? 'expired' : 'rejected'
      await updateStepCard(deps, step, approvalState(deps.db, request, step, mode), true)
      continue
    }
    if (activeStep && step.step_no === activeStep.step_no && step.status === 'active') {
      await sendPermissionApprovalCard(deps, requestId, step.step_no)
    }
  }
}

/** 撤回/拒绝/超时后把没有 card 的步骤也尽量收口；主要用于已投递过的卡。 */
export async function finishPermissionApprovalCards(
  deps: ServerDeps,
  requestId: string,
): Promise<void> {
  await refreshPermissionApprovalCards(deps, requestId)
}

function localUserOf(db: Db, externalId: string): string | null {
  const channel = db
    .prepare(
      `SELECT user_id FROM channel_identities
        WHERE provider = 'dingtalk' AND external_id = ? AND revoked_at IS NULL
        LIMIT 1`,
    )
    .get(externalId) as { user_id: string } | undefined
  if (channel?.user_id) return channel.user_id
  const identity = db
    .prepare(
      `SELECT user_id FROM user_identities
        WHERE provider = 'dingtalk' AND external_user_id = ? AND status <> 'revoked'
        LIMIT 1`,
    )
    .get(externalId) as { user_id: string } | undefined
  return identity?.user_id ?? null
}

/**
 * 处理审批卡按钮回调。进入题组/模型分支前调用；只信任 DB 里的步骤与审批人。
 * 返回 true 表示已消费该回调。
 */
export async function handlePermissionApprovalCardCallback(
  deps: ServerDeps,
  input: {
    outTrackId: string
    externalUserId: string
    sessionId: string
    optionId: string
    actionIds?: string[]
  },
): Promise<boolean> {
  const session = parseApprovalSessionId(input.sessionId)
  if (!session) return false
  const option = String(input.optionId ?? '').trim().toLowerCase()
  const fromAction = (input.actionIds ?? []).find((id) => id === 'approve' || id === 'reject') ?? ''
  const decision = option === 'approve' || option === 'reject'
    ? option
    : fromAction === 'approve' || fromAction === 'reject'
      ? fromAction
      : ''
  if (!decision) return true

  const localUserId = localUserOf(deps.db, input.externalUserId)
  if (!localUserId) {
    console.warn('[eab] 权限审批回调：钉钉账号还没有绑定 EAB 成员')
    return true
  }
  const person = findActivePerson(deps.db, localUserId)
  if (!person || person.companyId !== deps.companyId) {
    console.warn('[eab] 权限审批回调：EAB 成员不存在、已停用或公司不匹配')
    return true
  }
  try {
    const actor = actorFor(deps.db, person)
    decidePermissionRequest(deps.db, actor, {
      requestId: session.requestId,
      stepNo: session.stepNo,
      decision,
      eventKey: `permcard:${input.outTrackId}:${session.requestId}:${session.stepNo}:${decision}`,
    })
  } catch (error) {
    if (error instanceof EabError) {
      console.warn('[eab] 权限审批回调被拒绝：', error.message)
    } else {
      console.warn('[eab] 权限审批回调失败：', (error as Error).message)
    }
    return true
  }
  // 先让回调尽快 ACK；卡片刷新在后台进行，失败不影响审批结果。
  void refreshPermissionApprovalCards(deps, session.requestId).catch((error) => {
    console.warn('[eab] 权限审批卡片刷新失败：', (error as Error).message)
  })
  return true
}

/** 给 web 调用方用的摘要：某张卡是否还在处理中。 */
export function permissionStepCardOf(
  db: Db,
  companyId: string,
  requestId: string,
  stepNo: number,
): { outTrackId: string; status: string; error: string } | null {
  const request = requestOf(db, companyId, requestId)
  if (!request) return null
  const step = stepOf(db, request.id, stepNo)
  if (!step) return null
  return {
    outTrackId: step.card_out_track_id ?? '',
    status: step.card_status,
    error: step.card_error,
  }
}