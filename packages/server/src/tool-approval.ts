/**
 * 工具风险分级与逐次审批（AGT-05）。
 *
 * 目的：把“模型可以调到什么工具”和“高危动作真的能执行”分开。
 * - 风险分级只决定默认策略，不改变工具本身的权限校验；
 * - exec / irreversible / 高写工具每次执行都要有审批单，审批单与参数哈希绑定；
 * - 审批通过后只能核销一次，避免同一张批文被复用去跑另一条命令；
 * - 网页聊天会等待审批并弹卡片；钉钉和直接 API 返回待办 id，由管理员在控制台审批后重试。
 *
 * 这不是 OS 沙箱。它能拦住模型“顺手执行”的动作，但不能阻止已获准执行的命令
 * 读写工作区之外的文件；真正的隔离留给 AGT-05b。
 */
import { createHash } from 'node:crypto'
import { EC, EabError, ulid } from '@eab/domain'
import { appendAudit, canonicalJson, type Db } from '@eab/storage'

export type ToolRisk = 'read' | 'write' | 'exec' | 'irreversible'
export type ToolApprovalPolicy = 'always' | 'never'
export type ToolApprovalMode = 'wait' | 'defer' | 'bypass'

const EXEC_TOOLS = new Set([
  'project.exec',
  'project.job',
  'plugin.dev',
  'skill.dev',
  'browser',
  'browser.use',
])

const IRREVERSIBLE_TOOLS = new Set([
  'admin.password.reset',
  'workspace.delete',
  'workspace.send_dingtalk',
])

/** 可回滚但影响面大的写入：覆盖正文、套模板、恢复旧版本、批量改名。 */
const HIGH_RISK_WRITE_TOOLS = new Set([
  'office.rewrite',
  'office.format',
  'office.versions',
  'workspace.rename',
])

const APPROVAL_TTL_MS = 5 * 60_000
const APPROVAL_WAIT_MS = 120_000
const APPROVAL_POLL_MS = 300

export interface ToolRiskInput {
  readonly id: string
  readonly dangerous?: boolean
  readonly concurrency?: 'read' | 'write' | 'exclusive'
  readonly risk?: ToolRisk
  readonly approval?: ToolApprovalPolicy
}

export interface ToolApprovalSubject {
  readonly companyId: string
  readonly userId: string
}

export interface ToolApprovalRequest {
  readonly approvalId: string
  readonly toolId: string
  readonly toolName: string
  readonly risk: ToolRisk
  readonly argsSummary: string
  readonly expiresAt: number
  readonly messageId?: string
  readonly sessionId?: string
  readonly runId?: string
  readonly turnId?: string
  readonly channel?: string
}

export interface ToolApprovalOutcome {
  readonly approvalId: string
  readonly status: 'approved' | 'rejected' | 'expired'
  readonly reason?: string
  readonly request: ToolApprovalRequest
}

export interface ToolApprovalOptions {
  readonly mode: ToolApprovalMode
  readonly approvalId?: string
  readonly toolName?: string
  readonly messageId?: string
  readonly sessionId?: string
  readonly runId?: string
  readonly turnId?: string
  readonly channel?: string
  readonly traceId?: string
  readonly signal?: AbortSignal
  /** 聊天入口用它把待审批卡片推给前端；返回 false 表示没有可用的审批接收人。 */
  readonly onPending?: (request: ToolApprovalRequest) => void | boolean | Promise<void | boolean>
}

interface ApprovalRow {
  id: string
  requester_user_id: string
  status: string
  reason: string | null
  payload_json: string | null
  expires_at: number | null
  used_at: number | null
}

export function toolRisk(tool: ToolRiskInput): ToolRisk {
  if (tool.risk) return tool.risk
  if (EXEC_TOOLS.has(tool.id)) return 'exec'
  if (IRREVERSIBLE_TOOLS.has(tool.id)) return 'irreversible'
  if (HIGH_RISK_WRITE_TOOLS.has(tool.id)) return 'write'
  if (tool.dangerous) return 'irreversible'
  if (tool.concurrency === 'exclusive') return 'irreversible'
  if (tool.concurrency === 'write') return 'write'
  return 'read'
}

export function toolApprovalPolicy(tool: ToolRiskInput): ToolApprovalPolicy {
  if (tool.approval) return tool.approval
  const risk = toolRisk(tool)
  if (risk === 'exec' || risk === 'irreversible') return 'always'
  if (HIGH_RISK_WRITE_TOOLS.has(tool.id)) return 'always'
  return 'never'
}

export function requiresToolApproval(tool: ToolRiskInput): boolean {
  return toolApprovalPolicy(tool) === 'always'
}

/** 同一个工具里只有真正有副作用的分支才逐次审批，读列表/读输出不重复打扰。 */
export function requiresToolApprovalForArgs(tool: ToolRiskInput, args: Record<string, unknown>): boolean {
  if (!requiresToolApproval(tool)) return false
  if (tool.id === 'project.job') {
    return String(args.action ?? 'output').trim().toLowerCase() === 'kill'
  }
  if (tool.id === 'office.versions') {
    return String(args.action ?? 'list').trim().toLowerCase() === 'restore'
  }
  if (tool.id === 'workspace.folder') {
    return String(args.action ?? '').trim().toLowerCase() === 'delete'
  }
  if (tool.id === 'browser' || tool.id === 'browser.use') {
    // 读取当前页、列标签、截屏和滚动不产生外部副作用，不需要每次弹审批；
    // 点按、输入、打开网址、前进后退、刷新和关闭标签仍然逐次审批。
    const action = String(args.action ?? 'snapshot').trim().toLowerCase()
    return !['list', 'snapshot', 'screenshot', 'scroll', 'activate'].includes(action)
  }
  return true
}

export function approvalAction(toolId: string): string {
  return `tool:${toolId}`
}

export function toolArgsDigest(args: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(args)).digest('hex')
}

function safeText(value: unknown): string {
  if (typeof value === 'string') return value.length > 160 ? `${value.slice(0, 157)}...` : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null) return 'null'
  if (Array.isArray(value)) return `[${value.length} 项]`
  if (typeof value === 'object') return '{…}'
  return ''
}

/** 只存人能看懂的短摘要，不把完整正文/凭据写进审批表。 */
export function summarizeToolArgs(args: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue
    if (/token|secret|password|passwd|authorization|cookie|credential|private[_-]?key/i.test(key)) {
      parts.push(`${key}=***`)
      continue
    }
    parts.push(`${key}=${safeText(value)}`)
    if (parts.join(' ').length > 220) break
  }
  const text = parts.join(' ')
  return text.length > 240 ? `${text.slice(0, 237)}...` : text
}

function parsePayload(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const value = JSON.parse(raw) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function asRequest(row: ApprovalRow, toolId: string, toolName: string, risk: ToolRisk): ToolApprovalRequest {
  const payload = parsePayload(row.payload_json)
  return {
    approvalId: row.id,
    toolId,
    toolName,
    risk,
    argsSummary: typeof payload.argsSummary === 'string' ? payload.argsSummary : '',
    expiresAt: row.expires_at ?? Date.now(),
    messageId: typeof payload.messageId === 'string' ? payload.messageId : undefined,
    sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : undefined,
    runId: typeof payload.runId === 'string' ? payload.runId : undefined,
    turnId: typeof payload.turnId === 'string' ? payload.turnId : undefined,
    channel: typeof payload.channel === 'string' ? payload.channel : undefined,
  }
}

function audit(
  db: Db,
  subject: ToolApprovalSubject,
  action: string,
  result: 'allow' | 'deny' | 'success' | 'failure',
  detail: Record<string, unknown>,
  traceId?: string,
  channel?: string,
): void {
  try {
    appendAudit(db, {
      companyId: subject.companyId,
      actorUserId: subject.userId,
      action,
      resourceType: 'tool',
      resourceId: String(detail.toolId ?? ''),
      result,
      detail,
      traceId: traceId ?? null,
      channel: channel ?? null,
    })
  } catch (error) {
    console.warn('[eab] 工具审批审计写入失败：', error instanceof Error ? error.message : String(error))
  }
}

function expireStalePending(
  db: Db,
  subject: ToolApprovalSubject,
  action: string,
  argsHash: string,
  now: number,
): void {
  db.prepare(
    `UPDATE approvals
        SET status = 'expired', decided_by = 'system:expired', decided_at = ?
      WHERE company_id = ? AND requester_user_id = ? AND action = ? AND resource_id = ?
        AND status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?`,
  ).run(now, subject.companyId, subject.userId, action, argsHash, now)
}

function findPending(
  db: Db,
  subject: ToolApprovalSubject,
  action: string,
  argsHash: string,
  now: number,
): ApprovalRow | undefined {
  return db.prepare(
    `SELECT id, requester_user_id, status, reason, payload_json, expires_at, used_at
       FROM approvals
      WHERE company_id = ? AND requester_user_id = ? AND action = ? AND resource_id = ?
        AND status = 'pending' AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at DESC LIMIT 1`,
  ).get(subject.companyId, subject.userId, action, argsHash, now) as ApprovalRow | undefined
}

function findApproval(
  db: Db,
  subject: ToolApprovalSubject,
  approvalId: string,
  action: string,
  argsHash: string,
): ApprovalRow | undefined {
  return db.prepare(
    `SELECT id, requester_user_id, status, reason, payload_json, expires_at, used_at
       FROM approvals
      WHERE id = ? AND company_id = ? AND requester_user_id = ? AND action = ? AND resource_id = ?`,
  ).get(approvalId, subject.companyId, subject.userId, action, argsHash) as ApprovalRow | undefined
}

function createPending(
  db: Db,
  subject: ToolApprovalSubject,
  tool: ToolRiskInput & { name?: string },
  argsHash: string,
  request: Omit<ToolApprovalRequest, 'approvalId' | 'expiresAt'>,
  now: number,
): ApprovalRow {
  const action = approvalAction(tool.id)
  expireStalePending(db, subject, action, argsHash, now)
  const existing = findPending(db, subject, action, argsHash, now)
  if (existing) return existing

  const id = ulid()
  const expiresAt = now + APPROVAL_TTL_MS
  const payload = {
    toolId: tool.id,
    toolName: request.toolName,
    risk: request.risk,
    argsSummary: request.argsSummary,
    messageId: request.messageId ?? null,
    sessionId: request.sessionId ?? null,
    runId: request.runId ?? null,
    turnId: request.turnId ?? null,
    channel: request.channel ?? null,
    expiresAt,
  }
  try {
    db.prepare(
      `INSERT INTO approvals
         (id, company_id, requester_user_id, action, resource_type, resource_id, payload_json, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, 'tool', ?, ?, 'pending', ?, ?)`,
    ).run(id, subject.companyId, subject.userId, action, argsHash, JSON.stringify(payload), now, expiresAt)
    return {
      id,
      requester_user_id: subject.userId,
      status: 'pending',
      reason: null,
      payload_json: JSON.stringify(payload),
      expires_at: expiresAt,
      used_at: null,
    }
  } catch (error) {
    // 唯一索引冲突说明另一个并发请求刚插入了同一个待办，读回它。
    const raced = findPending(db, subject, action, argsHash, now)
    if (raced) return raced
    throw error
  }
}

/** 核销一张已通过的审批；返回 false 表示已使用、已过期或不是 approved。 */
export function claimApprovedToolApproval(
  db: Db,
  subject: ToolApprovalSubject,
  toolId: string,
  argsHash: string,
  approvalId: string,
  now = Date.now(),
): boolean {
  const action = approvalAction(toolId)
  const result = db.prepare(
    `UPDATE approvals
        SET used_at = ?
      WHERE id = ? AND company_id = ? AND requester_user_id = ? AND action = ? AND resource_id = ?
        AND status = 'approved' AND used_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)`,
  ).run(now, approvalId, subject.companyId, subject.userId, action, argsHash, now)
  return Number(result.changes) === 1
}

function waitForDecision(
  db: Db,
  subject: ToolApprovalSubject,
  request: ToolApprovalRequest,
  toolId: string,
  argsHash: string,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Math.min(Date.now() + APPROVAL_WAIT_MS, request.expiresAt)
    let settled = false
    let timer: NodeJS.Timeout | null = null

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      fn()
    }

    const onAbort = (): void => {
      db.prepare(
        `UPDATE approvals SET status = 'expired', decided_by = 'system:aborted', decided_at = ?
          WHERE id = ? AND company_id = ? AND status = 'pending'`,
      ).run(Date.now(), request.approvalId, subject.companyId)
      finish(() => reject(new EabError(EC.CONFLICT, '操作已取消，审批待办已失效')))
    }

    const poll = (): void => {
      if (settled) return
      if (signal?.aborted) {
        onAbort()
        return
      }
      const row = db.prepare(
        `SELECT id, requester_user_id, status, reason, payload_json, expires_at, used_at
           FROM approvals WHERE id = ? AND company_id = ?`,
      ).get(request.approvalId, subject.companyId) as ApprovalRow | undefined
      if (!row) {
        finish(() => reject(new EabError(EC.NOT_FOUND, '审批单不存在或已被撤销')))
        return
      }
      if (row.status === 'rejected') {
        finish(() => reject(new EabError(EC.FORBIDDEN, row.reason || '审批已被拒绝', {
          details: { approvalId: row.id, toolId },
        })))
        return
      }
      if (row.status === 'expired' || (row.expires_at !== null && row.expires_at <= Date.now())) {
        finish(() => reject(new EabError(EC.APPROVAL_REQUIRED, '审批已超时，请重新发起', {
          details: { approvalId: row.id, toolId },
        })))
        return
      }
      if (row.status === 'approved') {
        if (claimApprovedToolApproval(db, subject, toolId, argsHash, row.id)) {
          finish(resolve)
        } else {
          finish(() => reject(new EabError(EC.CONFLICT, '审批已使用、已过期或参数与审批时不一致，请重新发起', {
            details: { approvalId: row.id, toolId },
          })))
        }
        return
      }
      if (Date.now() >= deadline) {
        finish(() => reject(new EabError(EC.APPROVAL_REQUIRED, '等待审批超时，管理员通过后可以重试', {
          details: { approvalId: request.approvalId, toolId },
          hint: '让管理员在控制台「审批」页通过；网页聊天会在审批通过后自动继续。',
        })))
        return
      }
      timer = setTimeout(poll, APPROVAL_POLL_MS)
      timer.unref?.()
    }

    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    poll()
  })
}

/**
 * 统一审批门禁。调用方必须在真正执行工具之前 await 它。
 * - bypass 只给控制台/测试等已经完成自身权限校验的内部路径；
 * - defer 生成待办后直接抛 202，适合钉钉和直接工具 API；
 * - wait 生成待办、推送卡片并轮询，适合网页聊天。
 */
export async function ensureToolApproval(
  db: Db,
  subject: ToolApprovalSubject,
  tool: ToolRiskInput & { name?: string },
  args: Record<string, unknown>,
  options: ToolApprovalOptions,
): Promise<void> {
  if (!requiresToolApprovalForArgs(tool, args)) return
  if (options.mode === 'bypass') return

  const risk = toolRisk(tool)
  const toolName = options.toolName ?? tool.name ?? tool.id
  const argsHash = toolArgsDigest(args)
  const action = approvalAction(tool.id)
  const now = Date.now()

  if (options.approvalId) {
    const row = findApproval(db, subject, options.approvalId, action, argsHash)
    if (row && row.status === 'approved' && claimApprovedToolApproval(db, subject, tool.id, argsHash, row.id, now)) {
      audit(db, subject, 'tool.approval.allowed', 'allow', {
        toolId: tool.id, risk, approvalId: row.id, argsHash,
      }, options.traceId, options.channel)
      return
    }
    throw new EabError(EC.CONFLICT, '审批单不可用：可能已被使用、已过期，或本次参数与审批时不一致', {
      details: { approvalId: options.approvalId, toolId: tool.id, risk },
      hint: '重新发起一次调用生成新的审批待办，不要复用旧 approvalId。',
    })
  }

  const requestBase = {
    toolId: tool.id,
    toolName,
    risk,
    argsSummary: summarizeToolArgs(args),
    messageId: options.messageId,
    sessionId: options.sessionId,
    runId: options.runId,
    turnId: options.turnId,
    channel: options.channel,
  }
  const row = createPending(db, subject, tool, argsHash, requestBase, now)
  const request = asRequest(row, tool.id, toolName, risk)

  audit(db, subject, 'tool.approval.requested', 'deny', {
    toolId: tool.id, risk, approvalId: row.id, argsHash, argsSummary: request.argsSummary,
  }, options.traceId, options.channel)

  if (options.mode === 'wait') {
    const delivered = await options.onPending?.(request)
    if (delivered === false) {
      throw new EabError(
        EC.APPROVAL_REQUIRED,
        `「${toolName}」需要审批，但当前没有可送达审批卡的审批人`,
        {
          details: { approvalId: row.id, toolId: tool.id, risk, argsSummary: request.argsSummary },
          hint: '已生成待办；请管理员在控制台「审批」页处理，或先在钉钉绑定具备审批权限的成员。',
        },
      )
    }
    await waitForDecision(db, subject, request, tool.id, argsHash, options.signal)
    audit(db, subject, 'tool.approval.allowed', 'allow', {
      toolId: tool.id, risk, approvalId: row.id, argsHash,
    }, options.traceId, options.channel)
    return
  }

  throw new EabError(
    EC.APPROVAL_REQUIRED,
    `「${toolName}」属于${riskLabel(risk)}工具，需要审批，已生成待办`,
    {
      details: { approvalId: row.id, toolId: tool.id, risk, argsSummary: request.argsSummary },
      hint: '管理员在控制台「审批」页通过后，网页聊天会继续；直接 API 需带 approvalId 重试。',
    },
  )
}

export function riskLabel(risk: ToolRisk): string {
  switch (risk) {
    case 'read': return '只读'
    case 'write': return '写入'
    case 'exec': return '命令执行'
    case 'irreversible': return '不可逆'
  }
}

/** 控制台审批页使用：给已通过/已拒绝的审批补一条审计。 */
export function auditToolApprovalDecision(
  db: Db,
  input: {
    companyId: string
    actorUserId: string
    approvalId: string
    toolId: string
    decision: 'approved' | 'rejected'
    reason?: string
    traceId?: string
  },
): void {
  audit(
    db,
    { companyId: input.companyId, userId: input.actorUserId },
    input.decision === 'approved' ? 'tool.approval.approved' : 'tool.approval.rejected',
    input.decision === 'approved' ? 'allow' : 'deny',
    { toolId: input.toolId, approvalId: input.approvalId, reason: input.reason ?? null },
    input.traceId,
    'console',
  )
}
