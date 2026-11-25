/**
 * 钉钉里的工具执行审批卡（AGT-05 渠道补充）。
 *
 * 网页聊天会用 SSE 把审批卡推进同一个气泡；钉钉没有网页气泡，所以这里单独发一张
 * A2UI 卡给有 `approval:decide` 权限的成员。卡片按钮回调只读 approvals 表校验，
 * 不依赖进程内登记表；原工具轮次仍在等待，审批通过后自动续跑。
 *
 * 这不是权限审批卡：权限申请有自己的多级流程。这里只处理 `tool:<toolId>` 的
 * 单次执行审批，审批和参数哈希绑定，通过后仍只能核销一次。
 */
import { randomUUID } from 'node:crypto'
import { SC, scopeAllows, type Scope } from '@eab/domain'
import { appendAudit, type Db } from '@eab/storage'
import type { ServerDeps } from './deps.js'
import { DingTalkAICardStream, type DingTalkRichCardState } from './dingtalk-card.js'
import { dingTalkRecipientOf, sendDingTalkRichTextToUser } from './dingtalk-outbound.js'
import { resolveSecret } from './secrets.js'
import { actorFor, findActivePerson } from './session.js'
import { publishChatEvent } from './chat-events.js'
import {
  riskLabel,
  type ToolApprovalRequest,
  type ToolRisk,
} from './tool-approval.js'

const TOOL_APPROVAL_PREFIX = 'toolapproval:'
const OUT_TRACK_PREFIX = 'eab_a2ui_'
const MAX_APPROVER_CARDS = 5

interface ChannelRow {
  app_id: string
  secret_ref: string | null
  robot_code: string | null
  status: string
  enabled: number
}

interface ApprovalPayload {
  toolId?: string
  toolName?: string
  risk?: string
  argsSummary?: string
  sessionId?: string
  messageId?: string
  expiresAt?: number
}

interface ApprovalRow {
  id: string
  company_id: string
  requester_user_id: string
  action: string
  resource_id: string
  payload_json: string | null
  status: string
  expires_at: number | null
  used_at: number | null
}

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

function streamFor(
  deps: ServerDeps,
  companyId: string,
  userId: string,
  externalId?: string,
): DingTalkAICardStream | null {
  const cfg = channelOf(deps.db, companyId)
  if (!cfg?.app_id || cfg.status !== 'bound' || Number(cfg.enabled) !== 1) return null
  const secret = cfg.secret_ref ? resolveSecret(deps.config.dbPath, cfg.secret_ref) : null
  if (!secret) return null
  let target = String(externalId ?? '').trim()
  if (!target) {
    try {
      target = dingTalkRecipientOf(deps, companyId, userId)
    } catch {
      return null
    }
  }
  if (!target) return null
  return new DingTalkAICardStream(cfg.app_id, secret, target, cfg.robot_code || cfg.app_id)
}

function payloadOf(raw: string | null): ApprovalPayload {
  try {
    const value = JSON.parse(String(raw ?? '')) as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as ApprovalPayload
      : {}
  } catch {
    return {}
  }
}

function riskOf(value: string | undefined): ToolRisk {
  return value === 'read' || value === 'write' || value === 'exec' || value === 'irreversible'
    ? value
    : 'write'
}

function requesterNameOf(db: Db, userId: string): string {
  return (db.prepare('SELECT name FROM users WHERE id = ? LIMIT 1').get(userId) as { name: string } | undefined)?.name ?? userId
}

function formatDeadline(expiresAt: number): string {
  const left = Math.max(0, expiresAt - Date.now())
  const minutes = Math.max(1, Math.ceil(left / 60_000))
  return `${minutes} 分钟内有效`
}

function cardState(
  request: ToolApprovalRequest,
  requester: string,
  mode: 'pending' | 'approved' | 'rejected' | 'expired' | 'conflict' | 'no-permission',
): DingTalkRichCardState {
  const risk = riskLabel(request.risk)
  const header = [
    '### 工具执行审批',
    `**工具**：${request.toolName}（${request.toolId}）`,
    `**风险等级**：${risk}`,
    `**申请人**：${requester}`,
    `**参数摘要**：${request.argsSummary || '—'}`,
    `**有效期**：${formatDeadline(request.expiresAt)}`,
  ]
  const tail =
    mode === 'approved'
      ? '已允许一次执行，审批已核销，工具会继续运行。'
      : mode === 'rejected'
        ? '已拒绝本次执行，工具不会运行。'
        : mode === 'expired'
          ? '审批已过期，工具没有执行；需要时请重新发起。'
          : mode === 'conflict'
            ? '这张审批已经被其他管理员处理，本次点击未生效。'
            : mode === 'no-permission'
              ? '当前钉钉账号没有审批决定权限，请让具备权限的管理员处理。'
              : ''
  return {
    answer: [...header, ...(tail ? ['', tail] : [])].join('\n\n'),
    reasoning: '',
    tools: [],
    thinkingDone: true,
    toolDetails: [],
    clarify: mode === 'pending'
      ? {
          sessionId: `${TOOL_APPROVAL_PREFIX}${request.approvalId}`,
          question: '是否允许这次工具执行？',
          options: [
            {
              id: 'approve',
              label: '允许一次',
              description: '只放行本次参数；执行后审批立即失效',
            },
            {
              id: 'reject',
              label: '拒绝',
              description: '工具不会运行，模型会收到拒绝结果',
            },
          ],
          kind: 'single',
          allowCustom: false,
          step: 1,
        }
      : null,
  }
}

function approverIdsOf(db: Db, companyId: string, now: number): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT u.id
         FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN role_scopes rs ON rs.role_id = ur.role_id
        WHERE u.company_id = ? AND u.status = 'active' AND rs.scope = ?
          AND (ur.expires_at IS NULL OR ur.expires_at > ?)
        ORDER BY u.created_at, u.id
        LIMIT ?`,
    )
    .all(companyId, SC.APPROVAL_DECIDE, now, MAX_APPROVER_CARDS) as Array<{ id: string }>
  return rows.map((row) => row.id)
}

async function sendCard(
  deps: ServerDeps,
  companyId: string,
  userId: string,
  request: ToolApprovalRequest,
  requester: string,
): Promise<boolean> {
  const stream = streamFor(deps, companyId, userId)
  if (!stream) return false
  const outTrackId = `${OUT_TRACK_PREFIX}${randomUUID().replace(/-/g, '')}`
  try {
    return await stream.start(
      cardState(request, requester, 'pending'),
      `工具审批：${request.toolName}`,
      { outTrackId },
    )
  } catch (error) {
    console.warn('[eab] 钉钉工具审批卡发送失败：', (error as Error).message)
    return false
  }
}

/**
 * 工具执行前由 runAgentTurn 调用：给能审批的人投卡。
 * 返回 false 表示一张卡都没送达；调用方会立即失败，保留控制台待办，不空等。
 */
export async function notifyToolApprovalPending(
  deps: ServerDeps,
  actor: { subject: { companyId: string; userId: string; scopes: ReadonlySet<Scope> }; person: { id: string; name?: string } },
  request: ToolApprovalRequest,
): Promise<boolean> {
  const requester = requesterNameOf(deps.db, actor.subject.userId)
  const canDecide = scopeAllows(actor.subject.scopes, SC.APPROVAL_DECIDE)
  const otherApprovers = () =>
    approverIdsOf(deps.db, actor.subject.companyId, Date.now())
      .filter((id) => id !== actor.subject.userId)
  let targets = canDecide
    ? [actor.subject.userId]
    : otherApprovers()
  let sent = false
  for (const target of targets) {
    if (await sendCard(deps, actor.subject.companyId, target, request, requester)) sent = true
  }
  // 申请人自己有权审批但没绑钉钉时，不能因此让整单没有卡；改发给其他有权限的管理员。
  if (!sent && canDecide) {
    targets = otherApprovers()
    for (const target of targets) {
      if (await sendCard(deps, actor.subject.companyId, target, request, requester)) sent = true
    }
  }
  if (sent) return true

  // 没有审批人可投卡时，至少让申请人知道待办在哪处理。
  try {
    await sendDingTalkRichTextToUser(deps, {
      companyId: actor.subject.companyId,
      userId: actor.subject.userId,
      title: '工具执行待审批',
      text: [
        '### 工具执行待审批',
        `**工具**：${request.toolName}（${request.toolId}）`,
        `**风险等级**：${riskLabel(request.risk)}`,
        `**参数摘要**：${request.argsSummary || '—'}`,
        '',
        '没有可用的钉钉审批人接收审批卡。请管理员打开 EAB 工作台，在「审批」页处理这条待办。',
      ].join('\n'),
    })
  } catch (error) {
    console.warn('[eab] 钉钉工具审批兜底通知失败：', (error as Error).message)
  }
  return false
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

function approvalOf(db: Db, companyId: string, id: string): ApprovalRow | null {
  return (db
    .prepare(
      `SELECT id, company_id, requester_user_id, action, resource_id, payload_json, status, expires_at, used_at
         FROM approvals
        WHERE id = ? AND company_id = ?
        LIMIT 1`,
    )
    .get(id, companyId) as ApprovalRow | undefined) ?? null
}

async function updateCard(
  deps: ServerDeps,
  companyId: string,
  externalId: string,
  outTrackId: string,
  request: ToolApprovalRequest,
  requester: string,
  mode: 'approved' | 'rejected' | 'expired' | 'conflict' | 'no-permission',
): Promise<void> {
  const stream = streamFor(deps, companyId, '', externalId)
  if (!stream) return
  try {
    await stream.completeClarify(outTrackId, cardState(request, requester, mode))
  } catch (error) {
    console.warn('[eab] 钉钉工具审批卡收口失败：', (error as Error).message)
  }
}

function publishDecision(
  companyId: string,
  row: ApprovalRow,
  status: 'approved' | 'rejected' | 'expired',
  reason: string | null,
): void {
  const payload = payloadOf(row.payload_json)
  if (!payload.sessionId || !payload.messageId) return
  try {
    publishChatEvent({
      type: 'approval',
      companyId,
      userId: row.requester_user_id,
      sessionId: payload.sessionId,
      messageId: payload.messageId,
      approval: {
        id: row.id,
        toolId: payload.toolId ?? '',
        toolName: payload.toolName ?? '',
        risk: riskOf(payload.risk),
        argsSummary: payload.argsSummary ?? '',
        expiresAt: Number(payload.expiresAt) || Date.now(),
        status,
        reason,
      },
    })
  } catch {
    // 审批结果已落库，网页推送失败不影响工具继续。
  }
}

/**
 * 处理 `toolapproval:<approvalId>` 卡片回调。
 * 只信任 DB 里的审批单和审批人权限；返回 true 表示已消费本次回调。
 */
export async function handleToolApprovalCardCallback(
  deps: ServerDeps,
  input: {
    outTrackId: string
    externalUserId: string
    sessionId: string
    optionId: string
    actionIds?: string[]
  },
): Promise<boolean> {
  if (!isToolApprovalCardSession(input.sessionId)) return false
  const approvalId = String(input.sessionId ?? '').trim().slice(TOOL_APPROVAL_PREFIX.length)
  if (!approvalId) return true
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
    console.warn('[eab] 工具审批回调：钉钉账号还没有绑定 EAB 成员')
    return true
  }
  const person = findActivePerson(deps.db, localUserId)
  if (!person) {
    console.warn('[eab] 工具审批回调：EAB 成员不存在或已停用')
    return true
  }
  const companyId = person.companyId
  const actor = actorFor(deps.db, person)
  const row = approvalOf(deps.db, companyId, approvalId)
  if (!row || !row.action.startsWith('tool:')) return true
  const payload = payloadOf(row.payload_json)
  const request: ToolApprovalRequest = {
    approvalId: row.id,
    toolId: payload.toolId ?? '',
    toolName: payload.toolName ?? '高危工具',
    risk: riskOf(payload.risk),
    argsSummary: payload.argsSummary ?? '',
    expiresAt: row.expires_at ?? Date.now(),
  }
  const requester = requesterNameOf(deps.db, row.requester_user_id)

  if (!scopeAllows(actor.subject.scopes, SC.APPROVAL_DECIDE)) {
    void updateCard(deps, companyId, input.externalUserId, input.outTrackId, request, requester, 'no-permission')
    return true
  }
  if (row.status !== 'pending') {
    void updateCard(deps, companyId, input.externalUserId, input.outTrackId, request, requester, 'conflict')
    return true
  }
  const now = Date.now()
  if (row.expires_at !== null && row.expires_at <= now) {
    deps.db.prepare(
      `UPDATE approvals SET status = 'expired', decided_by = 'system:expired', decided_at = ?
        WHERE id = ? AND company_id = ? AND status = 'pending'`,
    ).run(now, row.id, companyId)
    void updateCard(deps, companyId, input.externalUserId, input.outTrackId, request, requester, 'expired')
    publishDecision(companyId, row, 'expired', null)
    return true
  }

  const status = decision === 'approve' ? 'approved' : 'rejected'
  const updated = deps.db.prepare(
    `UPDATE approvals
        SET status = ?, decided_by = ?, decided_at = ?, reason = COALESCE(?, reason)
      WHERE id = ? AND company_id = ? AND status = 'pending'`,
  ).run(status, actor.person.id, now, '钉钉审批卡', row.id, companyId)
  if (Number(updated.changes) !== 1) {
    void updateCard(deps, companyId, input.externalUserId, input.outTrackId, request, requester, 'conflict')
    return true
  }
  try {
    appendAudit(deps.db, {
      companyId,
      actorUserId: actor.person.id,
      action: `tool.approval.${status}`,
      resourceType: 'tool',
      resourceId: request.toolId,
      result: status === 'approved' ? 'allow' : 'deny',
      detail: { approvalId: row.id, toolName: request.toolName, risk: request.risk, channel: 'dingtalk' },
      channel: 'dingtalk',
    })
  } catch (error) {
    console.warn('[eab] 工具审批审计写入失败：', (error as Error).message)
  }
  publishDecision(companyId, row, status, '钉钉审批卡')
  void updateCard(deps, companyId, input.externalUserId, input.outTrackId, request, requester, status)
  return true
}

/** 供测试与回调路由识别：只接受 toolapproval: 前缀。 */
export function isToolApprovalCardSession(sessionId: string): boolean {
  return String(sessionId ?? '').startsWith(TOOL_APPROVAL_PREFIX)
}
