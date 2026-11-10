/**
 * 多 Agent 运行树：一次对话回合是一个根 run，agent.spawn 派生的子任务各有独立
 * runId 和独立会话锁 key。父子只通过 parent_run_id 关联；取消父 run 会级联取消子 run。
 *
 * 数据库只保存可回看的轨迹（agent_runs / agent_steps）；进程内 Map 负责正在运行的
 * AbortController、父子关系和取消传播。
 */
import { randomUUID } from 'node:crypto'
import type { Db } from '@eab/storage'
import { KeyedMutex } from './concurrency.js'

export type AgentRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled'
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
}

const activeRuns = new Map<string, ActiveRun>()
export const agentSessionLocks = new KeyedMutex()

/** 子 Agent 不使用父会话 id，锁 key 也按自己的 run/session 隔离。 */
export async function acquireAgentSessionLock(sessionId: string, signal?: AbortSignal): Promise<() => void> {
  return agentSessionLocks.acquire(`agent:${sessionId}`, { timeoutMs: 120_000, signal })
}

function removeRun(id: string): void {
  const run = activeRuns.get(id)
  if (!run) return
  if (run.signal && run.abortListener) run.signal.removeEventListener('abort', run.abortListener)
  if (run.parentRunId) activeRuns.get(run.parentRunId)?.children.delete(id)
  activeRuns.delete(id)
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
      Math.max(0, step.durationMs ?? 0),
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
