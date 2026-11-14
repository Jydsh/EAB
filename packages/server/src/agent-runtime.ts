/**
 * 多 Agent 运行树：一次对话回合是一个根 run，agent.spawn 派生的子任务各有独立
 * runId 和独立会话锁 key。父子只通过 parent_run_id 关联；取消父 run 会级联取消子 run。
 *
 * 数据库只保存可回看的轨迹（agent_runs / agent_steps）；进程内 Map 负责正在运行的
 * AbortController、父子关系和取消传播。
 */
import { randomUUID } from 'node:crypto'
import type { Db } from '@eab/storage'
import { toolSlowThresholdMs } from './tool-metrics.js'
import { KeyedMutex } from './concurrency.js'
import {
  acquireCoordinationLock,
  clearRunAlive,
  isRunAlive,
  markRunAlive,
} from './backends/coordination.js'

export type AgentRunStatus = 'running' | 'suspended' | 'succeeded' | 'failed' | 'cancelled'
export type AgentStepKind = 'tool' | 'agent' | 'model'

export interface AgentRunInput {
  readonly id?: string
  readonly companyId: string
  readonly userId: string
  readonly parentRunId?: string | null
  readonly agentId?: string
  readonly title?: string | null
  readonly modelId?: string | null
  readonly sessionId?: string | null
  readonly budget?: number | null
  readonly startedAt?: number
}

export interface AgentRunHandle {
  readonly id: string
  readonly signal: AbortSignal
  /** 结束时调用：更新数据库状态并解除进程内登记。 */
  finish(status: AgentRunStatus, error?: string | null, spentTokens?: number): void
}

export interface AgentStepInput {
  readonly runId: string
  readonly seq: number
  readonly kind: AgentStepKind
  readonly toolId?: string | null
  readonly name?: string | null
  readonly status: 'running' | 'done' | 'error' | 'cancelled'
  readonly args?: unknown
  readonly resultSummary?: string | null
  readonly durationMs?: number
}

export interface AgentRunRecord {
  readonly id: string
  readonly parentRunId: string | null
  readonly agentId: string
  readonly title: string | null
  readonly modelId: string | null
  readonly sessionId: string | null
  readonly status: AgentRunStatus
  readonly budget: number | null
  readonly spentTokens: number
  readonly error: string | null
  readonly startedAt: number
  readonly endedAt: number | null
  readonly depth: number
  readonly steps: ReadonlyArray<{
    readonly id: string
    readonly seq: number
    readonly kind: string
    readonly toolId: string | null
    readonly name: string | null
    readonly status: string
    readonly resultSummary: string | null
    readonly durationMs: number
  }>
}

interface ActiveRun {
  readonly id: string
  readonly controller: AbortController
  readonly parentRunId: string | null
  readonly children: Set<string>
  readonly signal?: AbortSignal
  readonly abortListener?: () => void
  readonly startedAt: number
  heartbeatTimer?: ReturnType<typeof setInterval>
}

const activeRuns = new Map<string, ActiveRun>()
/** 仅在协作层不可用时使用的本地锁；正常情况下 acquireAgentSessionLock 会优先走 Redis。 */
export const agentSessionLocks = new KeyedMutex()

/**
 * 同一会话的回合互斥。
 *
 * Redis 在线时用分布式锁（跨进程生效，长回合自动续租）；离线时退化为进程内 KeyedMutex。
 */
export async function acquireAgentSessionLock(sessionId: string, signal?: AbortSignal): Promise<() => void> {
  const lease = await acquireCoordinationLock(`agent:session:${sessionId}`, {
    ttlMs: 180_000,
    waitMs: 120_000,
    signal,
  })
  return () => lease.release()
}

function removeRun(id: string): void {
  const run = activeRuns.get(id)
  if (!run) return
  if (run.heartbeatTimer) clearInterval(run.heartbeatTimer)
  if (run.signal && run.abortListener) run.signal.removeEventListener('abort', run.abortListener)
  if (run.parentRunId) activeRuns.get(run.parentRunId)?.children.delete(id)
  activeRuns.delete(id)
  void clearRunAlive(id)
}

/** 标记某一棵 run 树为 cancelled；正在执行的子任务由 AbortSignal 真正中断。 */
export function cancelAgentRunTree(db: Db, rootRunId: string, reason = '任务已取消'): string[] {
  const cancelled: string[] = []
  const visit = (id: string): void => {
    const run = activeRuns.get(id)
    if (run) {
      cancelled.push(id)
      run.controller.abort()
      for (const child of [...run.children]) visit(child)
    }
    try {
      db.prepare(`UPDATE agent_runs SET status = 'cancelled', error = ?, ended_at = ? WHERE id = ? AND status = 'running'`)
        .run(reason, Date.now(), id)
    } catch {
      // 运行树接口是补充观测，不能因为撤消失败影响主流程。
    }
  }
  visit(rootRunId)
  return cancelled
}

/**
 * 启动时清理僵尸 run：库里还是 running、但心跳已经不存在的行，说明对应的进程
 * 已经退出（或重启前没来得及收尾），统一标成 cancelled。
 *
 * 多实例部署时，其它实例正在跑的 run 有心跳，不会被误杀。
 */
export async function sweepOrphanAgentRuns(db: Db): Promise<number> {
  const rows = db.prepare(`SELECT id FROM agent_runs WHERE status = 'running'`).all() as unknown as Array<{ id: string }>
  if (rows.length === 0) return 0
  const update = db.prepare(
    `UPDATE agent_runs
        SET status = 'cancelled', error = ?, ended_at = ?
      WHERE id = ? AND status = 'running'`,
  )
  let swept = 0
  for (const row of rows) {
    if (await isRunAlive(row.id)) continue
    update.run('实例已退出，任务未正常结束', Date.now(), row.id)
    swept += 1
  }
  return swept
}

/**
 * 对话内慢工具后台化的地基：把一次 run 挂起，等后台作业回填结果。
 *
 * - 只有 running 的 run 能被挂起（重复挂起返回 false）；
 * - `resume_state_json` 由调用方决定内容（消息游标、已发生的工具调用、预算余量等），
 *   这里只负责存和取，不解释业务字段；
 * - 挂起中的 run **没有心跳**，因此不能交给 `sweepOrphanAgentRuns` 判死，
 *   由 `sweepSuspendedRuns` 按后台作业的终态单独收尾。
 */
export interface SuspendRunInput {
  readonly jobId: string
  readonly state: unknown
}

export interface SuspendedRun {
  readonly runId: string
  readonly companyId: string
  readonly userId: string
  readonly sessionId: string | null
  readonly agentId: string
  readonly pendingJobId: string | null
  readonly state: unknown
  readonly startedAt: number
}

export function suspendAgentRun(db: Db, runId: string, input: SuspendRunInput): boolean {
  const now = Date.now()
  const updated = db
    .prepare(
      `UPDATE agent_runs
          SET status = 'suspended', pending_job_id = ?, resume_state_json = ?, updated_at = ?
        WHERE id = ? AND status = 'running'`,
    )
    .run(input.jobId, JSON.stringify(input.state ?? {}), now, runId)
  return Number(updated.changes) === 1
}

export function loadSuspendedRun(db: Db, runId: string): SuspendedRun | null {
  const row = db
    .prepare(
      `SELECT id, company_id, user_id, session_id, agent_id, pending_job_id, resume_state_json, started_at
         FROM agent_runs WHERE id = ? AND status = 'suspended'`,
    )
    .get(runId) as
    | {
        id: string
        company_id: string
        user_id: string
        session_id: string | null
        agent_id: string
        pending_job_id: string | null
        resume_state_json: string | null
        started_at: number
      }
    | undefined
  if (!row) return null
  let state: unknown = null
  try {
    state = row.resume_state_json ? JSON.parse(row.resume_state_json) : null
  } catch {
    state = null
  }
  return {
    runId: row.id,
    companyId: row.company_id,
    userId: row.user_id,
    sessionId: row.session_id,
    agentId: row.agent_id,
    pendingJobId: row.pending_job_id,
    state,
    startedAt: Number(row.started_at) || 0,
  }
}

/** 后台结果回来后续跑：挂起态改回 running，并清掉 pending 作业指针。 */
export function resumeAgentRun(db: Db, runId: string): boolean {
  const now = Date.now()
  const updated = db
    .prepare(
      `UPDATE agent_runs
          SET status = 'running', pending_job_id = NULL, updated_at = ?
        WHERE id = ? AND status = 'suspended'`,
    )
    .run(now, runId)
  return Number(updated.changes) === 1
}

/** 后台工具最终失败：把挂起的 run 直接判定为 failed，避免控制台永远停在「挂起」。 */
export function failSuspendedRun(db: Db, runId: string, reason: string): boolean {
  const now = Date.now()
  const updated = db
    .prepare(
      `UPDATE agent_runs
          SET status = 'failed', error = ?, ended_at = ?, updated_at = ?
        WHERE id = ? AND status = 'suspended'`,
    )
    .run(reason.slice(0, 500), now, now, runId)
  return Number(updated.changes) === 1
}

/**
 * 启动时收尾挂起的 run：
 * - 后台作业还在 queued/running：留着，worker 会继续跑；
 * - 作业已经成功：留着，等恢复流程把它续跑（此时不能判死）；
 * - 作业失败/取消/记录丢失：run 判 failed，原因写清楚。
 */
export function sweepSuspendedRuns(db: Db): number {
  const rows = db
    .prepare(
      `SELECT r.id, r.pending_job_id, j.status AS job_status
         FROM agent_runs r
         LEFT JOIN async_jobs j ON j.id = r.pending_job_id
        WHERE r.status = 'suspended'`,
    )
    .all() as unknown as Array<{ id: string; pending_job_id: string | null; job_status: string | null }>
  if (rows.length === 0) return 0
  let swept = 0
  for (const row of rows) {
    const jobStatus = row.job_status
    if (jobStatus === 'queued' || jobStatus === 'running' || jobStatus === 'succeeded') continue
    const reason = jobStatus ? `后台工具作业已结束：${jobStatus}` : '后台工具作业记录丢失'
    failSuspendedRun(db, row.id, reason)
    swept += 1
  }
  return swept
}

export function startAgentRun(db: Db, input: AgentRunInput, signal?: AbortSignal): AgentRunHandle {
  const id = input.id ?? randomUUID()
  const startedAt = input.startedAt ?? Date.now()
  const now = startedAt
  const parentRunId = input.parentRunId ?? null
  const controller = new AbortController()
  let abortListener: (() => void) | undefined
  if (signal) {
    if (signal.aborted) controller.abort()
    else {
      abortListener = () => controller.abort()
      signal.addEventListener('abort', abortListener, { once: true })
    }
  }
  if (parentRunId) activeRuns.get(parentRunId)?.children.add(id)
  const active: ActiveRun = {
    id,
    controller,
    parentRunId,
    children: new Set<string>(),
    signal,
    abortListener,
    startedAt,
  }
  activeRuns.set(id, active)
  // 心跳：Redis 在线时跨实例可见（其它实例据此判断这个 run 是否还活着）；
  // 离线时写在进程内，重启即消失，启动清理据此回收。
  void markRunAlive(id)
  active.heartbeatTimer = setInterval(() => {
    void markRunAlive(id)
  }, 30_000)
  active.heartbeatTimer.unref?.()
  try {
    db.prepare(
      `INSERT INTO agent_runs
        (id, company_id, user_id, parent_run_id, agent_id, title, model_id, session_id, status, budget, spent_tokens, started_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, 0, ?, ?)`,
    ).run(
      id,
      input.companyId,
      input.userId,
      parentRunId,
      input.agentId ?? 'eab-main',
      input.title ?? null,
      input.modelId ?? null,
      input.sessionId ?? null,
      input.budget ?? null,
      startedAt,
      now,
    )
  } catch (error) {
    removeRun(id)
    throw error
  }

  let finished = false
  return {
    id,
    signal: controller.signal,
    finish(status, error = null, spentTokens = 0) {
      if (finished) return
      finished = true
      try {
        db.prepare(
          `UPDATE agent_runs
              SET status = ?, error = ?, spent_tokens = ?, ended_at = ?
            WHERE id = ? AND status = 'running'`,
        ).run(status, error, Math.max(0, spentTokens), Date.now(), id)
      } catch {
        // 运行树是观测数据，写失败不能反噬对话结果。
      }
      removeRun(id)
    },
  }
}

export function recordAgentStep(db: Db, step: AgentStepInput): void {
  try {
    const durationMs = Math.max(0, step.durationMs ?? 0)
    // 慢工具是「要不要做对话后台化」的唯一判据，先在日志里留痕，聚合看板读同一份数据。
    if (step.kind === 'tool' && durationMs >= toolSlowThresholdMs()) {
      console.warn(
        `[eab] 慢工具：${step.toolId ?? step.name ?? '未知工具'} 耗时 ${durationMs}ms（run ${step.runId}）`,
      )
    }
    const argsJson = step.args === undefined ? null : JSON.stringify(step.args).slice(0, 4000)
    db.prepare(
      `INSERT INTO agent_steps
        (id, run_id, seq, kind, tool_id, name, status, args_json, result_summary, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      step.runId,
      step.seq,
      step.kind,
      step.toolId ?? null,
      step.name ?? null,
      step.status,
      argsJson,
      step.resultSummary ? step.resultSummary.slice(0, 2000) : null,
      durationMs,
      Date.now(),
    )
  } catch {
    // 轨迹写入失败不阻断工具执行。
  }
}

interface RunRow {
  id: string
  parent_run_id: string | null
  agent_id: string
  title: string | null
  model_id: string | null
  session_id: string | null
  status: AgentRunStatus
  budget: number | null
  spent_tokens: number
  error: string | null
  started_at: number
  ended_at: number | null
}

interface StepRow {
  id: string
  run_id: string
  seq: number
  kind: string
  tool_id: string | null
  name: string | null
  status: string
  result_summary: string | null
  duration_ms: number
}

/** 控制台运行树：按 started_at 倒序取最近 runs，再补每一步工具轨迹。 */
export function listAgentRuns(
  db: Db,
  companyId: string,
  options: { limit?: number; sessionId?: string } = {},
): AgentRunRecord[] {
  const limit = Math.min(200, Math.max(1, options.limit ?? 50))
  const rows = (options.sessionId
    ? db.prepare(
        `SELECT * FROM agent_runs WHERE company_id = ? AND session_id = ? ORDER BY started_at DESC LIMIT ?`,
      ).all(companyId, options.sessionId, limit)
    : db.prepare(
        `SELECT * FROM agent_runs WHERE company_id = ? ORDER BY started_at DESC LIMIT ?`,
      ).all(companyId, limit)) as unknown as RunRow[]
  if (rows.length === 0) return []
  const byId = new Map(rows.map((row) => [row.id, row]))
  const depthOf = (row: RunRow): number => {
    let depth = 0
    let parent = row.parent_run_id
    const seen = new Set<string>([row.id])
    while (parent && depth < 20 && !seen.has(parent)) {
      const parentRow = byId.get(parent)
      if (!parentRow) break
      seen.add(parent)
      depth += 1
      parent = parentRow.parent_run_id
    }
    return depth
  }
  const stepRows = db.prepare(
    `SELECT * FROM agent_steps WHERE run_id IN (${rows.map(() => '?').join(',')}) ORDER BY run_id, seq`,
  ).all(...rows.map((row) => row.id)) as unknown as StepRow[]
  const stepsByRun = new Map<string, StepRow[]>()
  for (const step of stepRows) {
    const list = stepsByRun.get(step.run_id) ?? []
    list.push(step)
    stepsByRun.set(step.run_id, list)
  }
  // 控制台按树展示：先父任务，再按时间顺序展开它派生出的子任务。
  const known = new Set(rows.map((row) => row.id))
  const children = new Map<string, RunRow[]>()
  for (const row of rows) {
    if (row.parent_run_id && known.has(row.parent_run_id)) {
      const list = children.get(row.parent_run_id) ?? []
      list.push(row)
      children.set(row.parent_run_id, list)
    }
  }
  const ordered: RunRow[] = []
  const visited = new Set<string>()
  const visit = (row: RunRow): void => {
    if (visited.has(row.id)) return
    visited.add(row.id)
    ordered.push(row)
    for (const child of children.get(row.id) ?? []) visit(child)
  }
  for (const row of rows) {
    if (!row.parent_run_id || !known.has(row.parent_run_id)) visit(row)
  }
  for (const row of rows) visit(row)
  return ordered.map((row) => ({
    id: row.id,
    parentRunId: row.parent_run_id,
    agentId: row.agent_id,
    title: row.title,
    modelId: row.model_id,
    sessionId: row.session_id,
    status: row.status,
    budget: row.budget,
    spentTokens: row.spent_tokens,
    error: row.error,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    depth: depthOf(row),
    steps: (stepsByRun.get(row.id) ?? []).map((step) => ({
      id: step.id,
      seq: step.seq,
      kind: step.kind,
      toolId: step.tool_id,
      name: step.name,
      status: step.status,
      resultSummary: step.result_summary,
      durationMs: step.duration_ms,
    })),
  }))
}

export function activeAgentRunCount(): number {
  return activeRuns.size
}
