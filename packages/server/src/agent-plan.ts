import { randomUUID } from 'node:crypto'
import { EC, EabError } from '@eab/domain'
import type { Db } from '@eab/storage'

export const AGENT_PLAN_MAX_STEPS = 7

export type AgentPlanStatus = 'running' | 'succeeded' | 'failed' | 'cancelled'
export type AgentPlanStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface AgentPlanStepInput {
  readonly title: string
  readonly detail?: string
  readonly owner?: string
  readonly status?: AgentPlanStepStatus
}

export interface AgentPlanStepView {
  readonly id: string
  readonly seq: number
  readonly title: string
  readonly detail: string
  readonly owner: string
  readonly status: AgentPlanStepStatus
  readonly note: string
  readonly runId: string | null
  readonly updatedAt: number
}

export interface AgentPlanVersionSummary {
  readonly id: string
  readonly version: number
  readonly status: AgentPlanStatus
  readonly createdAt: number
  readonly updatedAt: number
}

export interface AgentPlanView {
  readonly id: string
  readonly planKey: string
  readonly sessionId: string | null
  readonly traceId: string | null
  readonly title: string
  readonly status: AgentPlanStatus
  readonly version: number
  readonly steps: ReadonlyArray<AgentPlanStepView>
  readonly versions: ReadonlyArray<AgentPlanVersionSummary>
  readonly createdAt: number
  readonly updatedAt: number
}

interface PlanRow {
  id: string
  plan_key: string
  company_id: string
  user_id: string
  session_id: string | null
  trace_id: string | null
  title: string
  status: AgentPlanStatus
  version: number
  supersedes_id: string | null
  created_at: number
  updated_at: number
}

interface PlanStepRow {
  id: string
  plan_id: string
  seq: number
  title: string
  detail: string
  owner: string
  status: AgentPlanStepStatus
  note: string
  run_id: string | null
  updated_at: number
}

export interface WriteAgentPlanInput {
  readonly companyId: string
  readonly userId: string
  readonly sessionId: string
  readonly traceId?: string | null
  readonly planKey?: string | null
  readonly title?: string | null
  readonly steps: ReadonlyArray<AgentPlanStepInput>
}

export interface UpdateAgentPlanStepInput {
  readonly companyId: string
  readonly userId: string
  readonly sessionId: string
  readonly traceId?: string | null
  readonly planKey?: string | null
  readonly seq: number
  readonly status: AgentPlanStepStatus
  readonly note?: string | null
}

function trimText(value: unknown, max: number): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function allowedStatus(value: unknown): AgentPlanStepStatus {
  return value === 'running' || value === 'done' || value === 'failed' || value === 'skipped'
    ? value
    : 'pending'
}

function derivePlanStatus(steps: ReadonlyArray<{ status: AgentPlanStepStatus }>): AgentPlanStatus {
  if (steps.some((step) => step.status === 'failed')) return 'failed'
  if (steps.length > 0 && steps.every((step) => step.status === 'done' || step.status === 'skipped')) {
    return 'succeeded'
  }
  return 'running'
}

function planFromRow(db: Db, row: PlanRow): AgentPlanView {
  const stepRows = db.prepare(
    'SELECT * FROM agent_plan_steps WHERE plan_id = ? ORDER BY seq',
  ).all(row.id) as unknown as PlanStepRow[]
  const versionRows = db.prepare(
    `SELECT id, version, status, created_at, updated_at
       FROM agent_plans
      WHERE company_id = ? AND plan_key = ?
      ORDER BY version DESC
      LIMIT 10`,
  ).all(row.company_id, row.plan_key) as unknown as Array<{
    id: string
    version: number
    status: AgentPlanStatus
    created_at: number
    updated_at: number
  }>
  return {
    id: row.id,
    planKey: row.plan_key,
    sessionId: row.session_id,
    traceId: row.trace_id,
    title: row.title,
    status: row.status,
    version: row.version,
    steps: stepRows.map((step) => ({
      id: step.id,
      seq: step.seq,
      title: step.title,
      detail: step.detail,
      owner: step.owner,
      status: step.status,
      note: step.note,
      runId: step.run_id,
      updatedAt: step.updated_at,
    })),
    versions: versionRows.map((version) => ({
      id: version.id,
      version: version.version,
      status: version.status,
      createdAt: version.created_at,
      updatedAt: version.updated_at,
    })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function latestPlan(db: Db, companyId: string, planKey: string): PlanRow | undefined {
  return db.prepare(
    'SELECT * FROM agent_plans WHERE company_id = ? AND plan_key = ? ORDER BY version DESC LIMIT 1',
  ).get(companyId, planKey) as unknown as PlanRow | undefined
}

function latestSessionPlan(
  db: Db,
  companyId: string,
  userId: string,
  sessionId: string,
): PlanRow | undefined {
  return db.prepare(
    `SELECT * FROM agent_plans
      WHERE company_id = ? AND user_id = ? AND session_id = ?
      ORDER BY updated_at DESC, version DESC
      LIMIT 1`,
  ).get(companyId, userId, sessionId) as unknown as PlanRow | undefined
}

/** 写一份计划；同一 planKey 再写一次会生成新版本，旧版本与旧步骤保留。 */
export function writeAgentPlan(db: Db, input: WriteAgentPlanInput): AgentPlanView {
  const sessionId = input.sessionId.trim()
  const companyId = input.companyId.trim()
  const userId = input.userId.trim()
  if (!sessionId) throw new EabError(EC.VALIDATION, '计划必须绑定一个对话会话')
  if (!companyId || !userId) throw new EabError(EC.VALIDATION, '缺少计划归属的公司或成员')
  const steps = input.steps.map((step, index) => {
    const title = trimText(step.title, 120)
    if (!title) throw new EabError(EC.VALIDATION, `计划第 ${index + 1} 步缺少标题`)
    return {
      title,
      detail: trimText(step.detail, 300),
      owner: trimText(step.owner, 40),
      status: allowedStatus(step.status),
    }
  })
  if (steps.length === 0) throw new EabError(EC.VALIDATION, '计划至少要一步')
  if (steps.length > AGENT_PLAN_MAX_STEPS) {
    throw new EabError(EC.VALIDATION, `计划最多 ${AGENT_PLAN_MAX_STEPS} 步；请合并或拆成两轮任务`)
  }

  const providedKey = trimText(input.planKey, 64)
  const planKey = providedKey || `plan_${randomUUID().slice(0, 12)}`
  const previous = latestPlan(db, companyId, planKey)
  if (previous && (previous.user_id !== userId || (previous.session_id ?? '') !== sessionId)) {
    throw new EabError(EC.FORBIDDEN, '这份计划不属于当前会话，不能改写')
  }
  const version = previous ? previous.version + 1 : 1
  const title = trimText(input.title, 120) || previous?.title || '任务计划'
  const now = Date.now()
  const status = derivePlanStatus(steps)
  const planId = randomUUID()

  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(
      `INSERT INTO agent_plans
        (id, plan_key, company_id, user_id, session_id, trace_id, title, status, version, supersedes_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      planId,
      planKey,
      companyId,
      userId,
      sessionId,
      input.traceId ?? null,
      title,
      status,
      version,
      previous?.id ?? null,
      now,
      now,
    )
    const insertStep = db.prepare(
      `INSERT INTO agent_plan_steps
        (id, plan_id, seq, title, detail, owner, status, note, run_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?)`,
    )
    steps.forEach((step, index) => {
      insertStep.run(
        randomUUID(),
        planId,
        index + 1,
        step.title,
        step.detail,
        step.owner,
        step.status,
        input.traceId ?? null,
        now,
      )
    })
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  const row = db.prepare('SELECT * FROM agent_plans WHERE id = ?').get(planId) as unknown as PlanRow
  return planFromRow(db, row)
}

/** 更新某一步状态，并重新推导整份计划状态。 */
export function updateAgentPlanStep(db: Db, input: UpdateAgentPlanStepInput): AgentPlanView {
  const companyId = input.companyId.trim()
  const userId = input.userId.trim()
  const sessionId = input.sessionId.trim()
  if (!sessionId) throw new EabError(EC.VALIDATION, '更新计划步骤必须绑定对话会话')
  const planKey = trimText(input.planKey, 64)
  const row = planKey
    ? latestPlan(db, companyId, planKey)
    : latestSessionPlan(db, companyId, userId, sessionId)
  if (!row) throw new EabError(EC.NOT_FOUND, '当前会话还没有任务计划；先调用 plan_write 写计划')
  if (row.user_id !== userId || (row.session_id ?? '') !== sessionId) {
    throw new EabError(EC.FORBIDDEN, '这份计划不属于当前会话，不能更新')
  }
  const seq = Math.floor(Number(input.seq))
  if (!Number.isFinite(seq) || seq < 1 || seq > AGENT_PLAN_MAX_STEPS) {
    throw new EabError(EC.VALIDATION, `计划步骤序号必须是 1–${AGENT_PLAN_MAX_STEPS}`)
  }
  const step = db.prepare('SELECT * FROM agent_plan_steps WHERE plan_id = ? AND seq = ?')
    .get(row.id, seq) as unknown as PlanStepRow | undefined
  if (!step) throw new EabError(EC.NOT_FOUND, `计划第 ${seq} 步不存在`)
  if (!['pending', 'running', 'done', 'failed', 'skipped'].includes(input.status)) {
    throw new EabError(EC.VALIDATION, `计划步骤状态不合法: ${String(input.status)}`)
  }
  const now = Date.now()
  db.prepare(
    'UPDATE agent_plan_steps SET status = ?, note = ?, run_id = ?, updated_at = ? WHERE id = ?',
  ).run(
    input.status,
    trimText(input.note, 500),
    input.traceId ?? step.run_id,
    now,
    step.id,
  )
  const steps = db.prepare('SELECT status FROM agent_plan_steps WHERE plan_id = ?')
    .all(row.id) as unknown as Array<{ status: AgentPlanStepStatus }>
  const status = derivePlanStatus(steps)
  db.prepare('UPDATE agent_plans SET status = ?, updated_at = ?, trace_id = COALESCE(?, trace_id) WHERE id = ?')
    .run(status, now, input.traceId ?? null, row.id)
  const updated = db.prepare('SELECT * FROM agent_plans WHERE id = ?').get(row.id) as unknown as PlanRow
  return planFromRow(db, updated)
}

/** 员工端读取当前会话最新计划；没有时返回 null。 */
export function getCurrentAgentPlan(
  db: Db,
  input: { companyId: string; userId: string; sessionId: string; planKey?: string | null },
): AgentPlanView | null {
  const planKey = trimText(input.planKey, 64)
  const row = planKey
    ? latestPlan(db, input.companyId, planKey)
    : latestSessionPlan(db, input.companyId, input.userId, input.sessionId)
  if (!row) return null
  if (row.user_id !== input.userId || (row.session_id ?? '') !== input.sessionId) return null
  return planFromRow(db, row)
}
