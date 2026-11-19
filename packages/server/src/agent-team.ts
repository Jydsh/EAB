/**
 * 子 Agent 团队登记表。
 *
 * 两套实现共存：
 * - 下面的自由函数是进程内内存表，保留给现有测试和没有 DB 上下文的轻量调用；
 * - `AgentTeamStore` 是生产路径，把 worker、消息、任务和事件落库，支持同一会话
 *   跨轮次继续派活、服务重启后恢复团队视图，以及父 Agent 的事件等待。
 *
 * 设计边界：
 * - worker 只保存身份、状态和最近一次摘要；真正的运行轨迹在 `agent_runs` /
 *   `agent_steps`，不在这里重复维护；
 * - 消息只保存文本，不保存工具调用细节；读取时仍然只取最近 20 条 / 约 16k 字符；
 * - waiting 不是 idle，不会被空闲退休误删；只有父 Agent 答复、取消或服务端
 *   显式清理才会改变它。
 */
import type { Db } from '@eab/storage'
import { randomUUID } from 'node:crypto'

export interface TeamMessage {
  role: 'user' | 'assistant'
  content: string
  at: number
}

export interface TeamWorker {
  key: string
  name: string
  /** 团队内的展示序号，从 1 开始，注册后固定 */
  index: number
  /** retired 是软注销：不参与活跃花名册，但仍可用 agent_task 在保留期内复活。 */
  status: 'idle' | 'running' | 'waiting' | 'retired'
  runId: string
  modelId: string
  modelName: string
  lastTaskAt: number
  lastText: string
  /** 岗位：producer / critic / researcher / builder / worker */
  role: string
  /** 组织归属；null 表示主 Agent 的直属岗位。评审关系不走这里。 */
  parentKey: string | null
  depth: number
  /** 派活时写下的验收标准，供 critic 和父 Agent 对齐 */
  acceptance: string
  /** true 表示空闲清理不会自动注销这个岗位 */
  pinned: boolean
  retiredAt: number | null
  retireReason: string
  /** 该子 Agent 的多轮对话上下文；同一 key 复用窗口时接着上一轮继续。 */
  messages: TeamMessage[]
}

export interface TeamTreeNode {
  key: string
  name: string
  role: string
  status: TeamWorker['status']
  index: number
  depth: number
  parentKey: string | null
  pinned: boolean
  retiredAt: number | null
  lastText: string
  children: TeamTreeNode[]
}

/** 启动收尾时被标为失败、需要父 Agent 决定是否从检查点继续的后台任务。 */
export interface RestartRecoveredTask {
  readonly id: string
  readonly teamId: string
  readonly workerKey: string
  readonly companyId: string
  readonly userId: string
  readonly parentRunId: string
  readonly modelId: string
  readonly error: string
  readonly updatedAt: number
}

export interface AgentTeamTask {
  id: string
  teamId: string
  workerKey: string
  parentRunId: string | null
  childRunId: string | null
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  prompt: string
  resultText: string
  error: string
  modelId: string
  startedAt: number | null
  finishedAt: number | null
  /** 父 Agent 是否已因这条任务被唤醒 */
  wakeAt: number | null
  createdAt: number
  updatedAt: number
}

export interface AgentTeamEvent {
  id: string
  teamId: string
  workerKey: string
  taskId: string | null
  kind: string
  payload: unknown
  createdAt: number
}

export interface AgentTeamStoreOptions {
  readonly db: Db
  readonly teamId: string
  readonly companyId: string
  readonly userId: string
  readonly idleMs?: number
  readonly maxWorkers?: number
  readonly waitingTtlMs?: number
  readonly retentionMs?: number
}

/** 默认空闲退休时间：2 分钟没有新任务就自动注销。 */
export const DEFAULT_WORKER_IDLE_MS = 120_000
/** 单个会话团队默认最多注册几个活跃子 Agent（不含主 Agent）。 */
export const DEFAULT_MAX_WORKERS = 8
/** 父 Agent 迟迟不回答子 Agent 提问时，等待态最长保留多久。 */
export const DEFAULT_WAITING_TTL_MS = 30 * 60_000
/** 注销后的 worker 和消息默认保留多久，便于同 key 复活与事后审计。 */
export const DEFAULT_RETENTION_MS = 24 * 60 * 60_000

const MAX_MESSAGES = 20
const MAX_MESSAGE_CHARS = 16_000
const MAX_MESSAGE_CHARS_EACH = 4_000

/* ------------------------------------------------------------------ */
/* 内存实现：保留给现有测试和没有 DB 上下文的轻量调用                  */
/* ------------------------------------------------------------------ */

const teams = new Map<string, Map<string, TeamWorker>>()

function teamOf(parentRunId: string, create = false): Map<string, TeamWorker> | undefined {
  let team = teams.get(parentRunId)
  if (!team && create) {
    team = new Map()
    teams.set(parentRunId, team)
  }
  return team
}

/** 清掉空闲超期的 worker，返回被注销的 key 列表。 */
export function pruneIdleWorkers(
  parentRunId: string,
  idleMs: number = DEFAULT_WORKER_IDLE_MS,
  now: number = Date.now(),
): string[] {
  const team = teamOf(parentRunId)
  if (!team) return []
  const retired: string[] = []
  for (const [key, worker] of team) {
    if (worker.status !== 'idle') continue
    if (worker.pinned) continue
    if (now - worker.lastTaskAt < idleMs) continue
    team.delete(key)
    retired.push(key)
  }
  return retired
}

/** 注册或复用 worker；复用时不重置序号，只把状态切回 running。 */
export function registerWorker(
  parentRunId: string,
  worker: {
    key: string
    name: string
    index?: number
    modelId?: string
    modelName?: string
    role?: string
    parentKey?: string | null
    depth?: number
    acceptance?: string
    pinned?: boolean
  },
  now: number = Date.now(),
): TeamWorker {
  const team = teamOf(parentRunId, true)!
  const previous = team.get(worker.key)
  const entry: TeamWorker = {
    key: worker.key,
    name: worker.name || previous?.name || worker.key,
    index: previous?.index ?? worker.index ?? team.size + 1,
    status: 'running',
    runId: previous?.runId ?? '',
    modelId: worker.modelId ?? previous?.modelId ?? '',
    modelName: worker.modelName ?? previous?.modelName ?? '',
    lastTaskAt: now,
    lastText: previous?.lastText ?? '',
    role: worker.role ?? previous?.role ?? 'worker',
    parentKey: worker.parentKey ?? previous?.parentKey ?? null,
    depth: worker.depth ?? previous?.depth ?? (worker.parentKey ? 2 : 1),
    acceptance: worker.acceptance ?? previous?.acceptance ?? '',
    pinned: worker.pinned ?? previous?.pinned ?? false,
    retiredAt: null,
    retireReason: '',
    messages: previous?.messages ?? [],
  }
  team.set(worker.key, entry)
  return entry
}

/** 子 run 拿到 runId 后回填，便于父 Agent 与前端定位。 */
export function markWorkerRun(parentRunId: string, key: string, runId: string): void {
  const worker = teamOf(parentRunId)?.get(key)
  if (worker) worker.runId = runId
}

/**
 * 追加一段子 Agent 对话。只保留文本，不保留工具调用细节：
 * 同一 key 再次派活时，父子双方都能接着上一轮说，而不是从零开始。
 */
export function appendWorkerMessage(
  parentRunId: string,
  key: string,
  role: TeamMessage['role'],
  content: string,
  now: number = Date.now(),
): void {
  const worker = teamOf(parentRunId)?.get(key)
  if (!worker) return
  const text = String(content ?? '').trim()
  if (!text) return
  worker.messages.push({ role, content: text.slice(0, MAX_MESSAGE_CHARS_EACH), at: now })
  while (worker.messages.length > MAX_MESSAGES) worker.messages.shift()
  let total = worker.messages.reduce((sum, message) => sum + message.content.length, 0)
  while (total > MAX_MESSAGE_CHARS && worker.messages.length > 2) {
    const removed = worker.messages.shift()
    total -= removed?.content.length ?? 0
  }
}

/** 子 Agent 需要父 Agent 决策时进入等待态，不按空闲退休。 */
export function markWorkerWaiting(
  parentRunId: string,
  key: string,
  question: string,
  now: number = Date.now(),
): TeamWorker | undefined {
  const worker = teamOf(parentRunId)?.get(key)
  if (!worker) return undefined
  worker.status = 'waiting'
  worker.lastTaskAt = now
  worker.lastText = String(question || '').slice(-1200)
  return worker
}

/** 当前子 Agent 的多轮上下文快照；父 Agent 下一轮派活时直接接在后面。 */
export function workerMessages(parentRunId: string, key: string): TeamMessage[] {
  return [...(teamOf(parentRunId)?.get(key)?.messages ?? [])]
}

/** 一次任务结束：进入 idle，并保留最后一段回报给下一次派活参考。 */
export function markWorkerIdle(
  parentRunId: string,
  key: string,
  text: string = '',
  now: number = Date.now(),
): TeamWorker | undefined {
  const worker = teamOf(parentRunId)?.get(key)
  if (!worker) return undefined
  worker.status = 'idle'
  worker.lastTaskAt = now
  worker.lastText = String(text || '').slice(-1200)
  return worker
}

export function findWorker(parentRunId: string, key: string): TeamWorker | undefined {
  return teamOf(parentRunId)?.get(key)
}

export function listWorkers(parentRunId: string): TeamWorker[] {
  const team = teamOf(parentRunId)
  return team ? [...team.values()].sort((a, b) => a.index - b.index) : []
}

/** 父回合结束：整个团队注销（子 run 已各自释放资源）。 */
export function clearTeam(parentRunId: string): void {
  teams.delete(parentRunId)
}

export function resetAgentTeamsForTest(): void {
  teams.clear()
  waiters.clear()
}

const ROLE_LABELS: Record<string, string> = {
  producer: '写稿/产出',
  critic: '审稿/挑刺',
  researcher: '调研',
  builder: '实现',
  worker: '执行',
}

function roleLabel(role: string): string {
  return ROLE_LABELS[role] || role || '执行'
}

/** 把平面 worker 列表按 parentKey 拼成组织树；评审关系不在这里，仍由任务链表达。 */
export function buildTeamTree(workers: readonly TeamWorker[]): TeamTreeNode[] {
  const active = workers.filter((worker) => worker.retiredAt === null)
  const nodes = new Map<string, TeamTreeNode>()
  for (const worker of active) {
    nodes.set(worker.key, {
      key: worker.key,
      name: worker.name,
      role: worker.role || 'worker',
      status: worker.status,
      index: worker.index,
      depth: worker.depth || 1,
      parentKey: worker.parentKey,
      pinned: worker.pinned,
      retiredAt: worker.retiredAt,
      lastText: worker.lastText,
      children: [],
    })
  }
  const roots: TeamTreeNode[] = []
  for (const node of nodes.values()) {
    const parent = node.parentKey ? nodes.get(node.parentKey) : undefined
    if (parent && parent.key !== node.key) parent.children.push(node)
    else roots.push(node)
  }
  const sortNodes = (items: TeamTreeNode[]): void => {
    items.sort((a, b) => (a.index || 0) - (b.index || 0) || a.key.localeCompare(b.key))
    for (const item of items) sortNodes(item.children)
  }
  sortNodes(roots)
  return roots
}

function statusLabel(worker: Pick<TeamWorker, 'status' | 'pinned'>): string {
  if (worker.status === 'running') return '工作中'
  if (worker.status === 'waiting') return '等待父 Agent 回答'
  if (worker.status === 'retired') return '已注销'
  return worker.pinned ? '空闲·固定岗位' : '空闲'
}

function rosterText(workers: TeamWorker[], maxWorkers = DEFAULT_MAX_WORKERS): string {
  const active = workers.filter((worker) => worker.retiredAt === null)
  if (active.length === 0) return ''
  const roots = buildTeamTree(active)
  const lines: string[] = []
  const walk = (nodes: TeamTreeNode[], level: number): void => {
    for (const node of nodes) {
      const worker = active.find((item) => item.key === node.key)
      if (!worker) continue
      const state = statusLabel(worker)
      const last = worker.lastText
        ? `上次${worker.status === 'waiting' ? '提问' : '回报'}：${worker.lastText.replace(/\s+/g, ' ').slice(0, 160)}`
        : '还没有回报'
      const pin = worker.pinned ? '，固定' : ''
      lines.push(`${'  '.repeat(level)}- ${worker.key}（${roleLabel(worker.role)}，${worker.name}，${state}${pin}，${last}）`)
      walk(node.children, level + 1)
    }
  }
  walk(roots, 1)
  return [
    `当前会话里已有子 Agent 团队（${active.length}/${maxWorkers} 个活跃岗位）：`,
    '- 主 Agent（主持/裁判）',
    lines.join('\n'),
    '按岗位状态严格选工具：状态是「执行中」只能用 agent_message 追加约束/催进度；状态是「空闲」「等待回答」「已注销」只能用 agent_task 派新任务或回答。不要对同一个 key 同时调用 agent_message 和 agent_task。',
    '需要它们接着做事时调用 agent_task {agent:"key", prompt:"完整任务"}；同一 key 会复用原窗口和上下文。',
    '已注销的 key 在保留期内仍可用 agent_task 唤醒；只有超过保留期被清理后，才需要 agent_spawn 重新注册。',
    '如果某个子 Agent 处于「等待父 Agent 回答」，先判断你能不能直接答；需要用户补充信息或授权时，用 ask_user 问用户，拿到答复后必须用 agent_task 把答复发回该子 Agent，让它继续。',
    '岗位固定时优先复用 producer / critic / researcher / builder 这些 key，不要每轮换一个新 key；不再需要的岗位用 agent_retire 收掉，避免团队无限膨胀。',
  ].join('\n')
}

/**
 * 给父 Agent 的本轮提示：会话里还有哪些子 Agent、各自空闲还是工作中、上次回报是什么。
 * 没有团队或全部已注销时返回空串，提示词里就不会出现这一段。
 */
export function teamRoster(
  teamId: string,
  idleMs: number = DEFAULT_WORKER_IDLE_MS,
  now: number = Date.now(),
): string {
  pruneIdleWorkers(teamId, idleMs, now)
  return rosterText(listWorkers(teamId))
}

/* ------------------------------------------------------------------ */
/* 事件等待：内存版和 DB 版共用一个进程内唤醒器                        */
/* ------------------------------------------------------------------ */

const waiters = new Map<string, Set<() => void>>()

function wakeTeam(teamId: string): void {
  const set = waiters.get(teamId)
  if (!set) return
  for (const resolve of [...set]) {
    try {
      resolve()
    } catch {
      // 单个等待者失效不能影响其它等待者
    }
  }
}

function waitOnce(teamId: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      waiters.get(teamId)?.delete(done)
      if (waiters.get(teamId)?.size === 0) waiters.delete(teamId)
      resolve()
    }
    const onAbort = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      waiters.get(teamId)?.delete(done)
      if (waiters.get(teamId)?.size === 0) waiters.delete(teamId)
      reject(signal?.reason instanceof Error ? signal.reason : new Error('等待子 Agent 事件已取消'))
    }
    const timer = setTimeout(done, Math.max(0, timeoutMs))
    timer.unref?.()
    if (!waiters.has(teamId)) waiters.set(teamId, new Set())
    waiters.get(teamId)!.add(done)
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/* ------------------------------------------------------------------ */
/* DB 实现：生产路径                                                   */
/* ------------------------------------------------------------------ */

interface WorkerRow {
  key: string
  name: string
  idx: number
  status: string
  run_id: string
  model_id: string
  model_name: string
  last_task_at: number
  last_text: string
  role: string | null
  parent_key: string | null
  depth: number | null
  acceptance: string | null
  pinned: number | null
  retired_at: number | null
  retire_reason: string | null
  created_at: number
  updated_at: number
}

interface MessageRow {
  id: string
  role: string
  content: string
  created_at: number
}

interface TaskRow {
  id: string
  team_id: string
  worker_key: string
  parent_run_id: string | null
  child_run_id: string | null
  status: string
  prompt: string
  result_text: string | null
  error: string | null
  model_id: string | null
  started_at: number | null
  finished_at: number | null
  wake_at: number | null
  created_at: number
  updated_at: number
}

interface EventRow {
  id: string
  team_id: string
  worker_key: string
  task_id: string | null
  kind: string
  payload_json: string
  created_at: number
}

function parseJson(value: string | null): unknown {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function toTask(row: TaskRow): AgentTeamTask {
  return {
    id: row.id,
    teamId: row.team_id,
    workerKey: row.worker_key,
    parentRunId: row.parent_run_id,
    childRunId: row.child_run_id,
    status: row.status as AgentTeamTask['status'],
    prompt: row.prompt,
    resultText: row.result_text ?? '',
    error: row.error ?? '',
    modelId: row.model_id ?? '',
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    wakeAt: row.wake_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toEvent(row: EventRow): AgentTeamEvent {
  return {
    id: row.id,
    teamId: row.team_id,
    workerKey: row.worker_key,
    taskId: row.task_id,
    kind: row.kind,
    payload: parseJson(row.payload_json),
    createdAt: row.created_at,
  }
}

export class AgentTeamStore {
  private readonly db: Db
  readonly teamId: string
  private readonly companyId: string
  private readonly userId: string
  readonly idleMs: number
  readonly maxWorkers: number
  readonly waitingTtlMs: number
  readonly retentionMs: number

  constructor(options: AgentTeamStoreOptions) {
    this.db = options.db
    this.teamId = options.teamId
    this.companyId = options.companyId
    this.userId = options.userId
    this.idleMs = options.idleMs ?? DEFAULT_WORKER_IDLE_MS
    this.maxWorkers = Math.max(1, options.maxWorkers ?? DEFAULT_MAX_WORKERS)
    this.waitingTtlMs = Math.max(1, options.waitingTtlMs ?? DEFAULT_WAITING_TTL_MS)
    this.retentionMs = Math.max(0, options.retentionMs ?? DEFAULT_RETENTION_MS)
  }

  private rowToWorker(row: WorkerRow): TeamWorker {
    const retiredAt = Number(row.retired_at) || null
    return {
      key: row.key,
      name: row.name,
      index: Number(row.idx) || 1,
      status: retiredAt
        ? 'retired'
        : (row.status === 'waiting' || row.status === 'idle' ? row.status : 'running') as TeamWorker['status'],
      runId: row.run_id,
      modelId: row.model_id,
      modelName: row.model_name,
      lastTaskAt: Number(row.last_task_at) || 0,
      lastText: row.last_text,
      role: row.role || 'worker',
      parentKey: row.parent_key || null,
      depth: Number(row.depth) || 1,
      acceptance: row.acceptance || '',
      pinned: Number(row.pinned) === 1,
      retiredAt,
      retireReason: row.retire_reason || '',
      messages: this.workerMessages(row.key),
    }
  }

  registerWorker(
    worker: {
      key: string
      name: string
      index?: number
      modelId?: string
      modelName?: string
      role?: string
      parentKey?: string | null
      depth?: number
      acceptance?: string
      pinned?: boolean
    },
    now = Date.now(),
  ): TeamWorker {
    const previous = this.findWorker(worker.key)
    const index = previous?.index ?? worker.index ?? this.maxWorkerIndex() + 1
    const role = (worker.role ?? previous?.role ?? 'worker').trim().slice(0, 24) || 'worker'
    const parentKey = worker.parentKey === undefined ? (previous?.parentKey ?? null) : (worker.parentKey || null)
    const depth = Math.max(1, Math.min(8, Number(worker.depth ?? previous?.depth ?? (parentKey ? 2 : 1)) || 1))
    const acceptance = (worker.acceptance ?? previous?.acceptance ?? '').trim().slice(0, 1200)
    const pinned = worker.pinned ?? previous?.pinned ?? false
    this.db.prepare(
      `INSERT INTO agent_workers
         (id, team_id, company_id, user_id, key, name, idx, status, run_id, model_id,
          model_name, last_task_at, last_text, role, parent_key, depth, acceptance,
          pinned, retired_at, retire_reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '', ?, ?)
       ON CONFLICT(team_id, key) DO UPDATE SET
         name = excluded.name,
         status = 'running',
         run_id = CASE WHEN agent_workers.run_id = '' THEN excluded.run_id ELSE agent_workers.run_id END,
         model_id = excluded.model_id,
         model_name = excluded.model_name,
         last_task_at = excluded.last_task_at,
         role = excluded.role,
         parent_key = excluded.parent_key,
         depth = excluded.depth,
         acceptance = excluded.acceptance,
         pinned = excluded.pinned,
         retired_at = NULL,
         retire_reason = '',
         updated_at = excluded.updated_at`,
    ).run(
      `${this.teamId}:${worker.key}`,
      this.teamId,
      this.companyId,
      this.userId,
      worker.key,
      worker.name || previous?.name || worker.key,
      index,
      previous?.runId ?? '',
      worker.modelId ?? previous?.modelId ?? '',
      worker.modelName ?? previous?.modelName ?? '',
      now,
      previous?.lastText ?? '',
      role,
      parentKey,
      depth,
      acceptance,
      pinned ? 1 : 0,
      Number(previous ? this.createdAtOf(worker.key) : now),
      now,
    )
    return this.findWorker(worker.key) as TeamWorker
  }

  private maxWorkerIndex(): number {
    const row = this.db.prepare(
      'SELECT MAX(idx) AS idx FROM agent_workers WHERE team_id = ?',
    ).get(this.teamId) as { idx: number | null } | undefined
    return Number(row?.idx) || 0
  }

  private createdAtOf(key: string): number {
    const row = this.db
      .prepare('SELECT created_at FROM agent_workers WHERE team_id = ? AND key = ?')
      .get(this.teamId, key) as { created_at: number } | undefined
    return Number(row?.created_at) || Date.now()
  }

  markWorkerRun(key: string, runId: string, now = Date.now()): void {
    this.db.prepare(
      `UPDATE agent_workers SET run_id = ?, updated_at = ?
        WHERE team_id = ? AND key = ?`,
    ).run(runId, now, this.teamId, key)
  }

  appendWorkerMessage(
    key: string,
    role: TeamMessage['role'],
    content: string,
    now = Date.now(),
  ): void {
    const text = String(content ?? '').trim()
    if (!text) return
    this.db.prepare(
      `INSERT INTO agent_team_messages (id, team_id, worker_key, role, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(`msg_${randomUUID()}`, this.teamId, key, role, text.slice(0, MAX_MESSAGE_CHARS_EACH), now)
    this.trimMessages(key)
  }

  private trimMessages(key: string): void {
    const rows = this.db.prepare(
      `SELECT id, content FROM agent_team_messages
        WHERE team_id = ? AND worker_key = ?
        ORDER BY created_at ASC, rowid ASC`,
    ).all(this.teamId, key) as unknown as Array<{ id: string; content: string }>
    let total = rows.reduce((sum, row) => sum + row.content.length, 0)
    let count = rows.length
    for (const row of rows) {
      if (count <= MAX_MESSAGES && total <= MAX_MESSAGE_CHARS) break
      if (count <= 2) break
      this.db.prepare('DELETE FROM agent_team_messages WHERE id = ?').run(row.id)
      total -= row.content.length
      count -= 1
    }
  }

  workerMessages(key: string): TeamMessage[] {
    const rows = this.db.prepare(
      `SELECT role, content, created_at FROM agent_team_messages
        WHERE team_id = ? AND worker_key = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?`,
    ).all(this.teamId, key, MAX_MESSAGES) as unknown as MessageRow[]
    let messages = rows.reverse().map((row) => ({
      role: (row.role === 'assistant' ? 'assistant' : 'user') as TeamMessage['role'],
      content: row.content,
      at: Number(row.created_at) || 0,
    }))
    let total = messages.reduce((sum, message) => sum + message.content.length, 0)
    while (total > MAX_MESSAGE_CHARS && messages.length > 2) {
      const removed = messages.shift()
      total -= removed?.content.length ?? 0
    }
    return messages
  }

  markWorkerWaiting(key: string, question: string, now = Date.now()): TeamWorker | undefined {
    this.db.prepare(
      `UPDATE agent_workers SET status = 'waiting', last_task_at = ?, last_text = ?, updated_at = ?
        WHERE team_id = ? AND key = ?`,
    ).run(now, String(question || '').slice(-1200), now, this.teamId, key)
    return this.findWorker(key)
  }

  markWorkerIdle(key: string, text = '', now = Date.now()): TeamWorker | undefined {
    this.db.prepare(
      `UPDATE agent_workers SET status = 'idle', last_task_at = ?, last_text = ?, updated_at = ?
        WHERE team_id = ? AND key = ?`,
    ).run(now, String(text || '').slice(-1200), now, this.teamId, key)
    return this.findWorker(key)
  }

  /**
   * 父 Agent 没能在时限内答复时，把仍显示“等待父 Agent 回答”的岗位收回到 idle。
   * 只改 waiting，避免覆盖已经重新跑起来的 running 岗位。
   */
  settleWaitingWorkers(keys: readonly string[], text = '', now = Date.now()): string[] {
    const unique = [...new Set(keys.map((key) => String(key || '').trim()).filter(Boolean))]
    const settled: string[] = []
    const statement = this.db.prepare(
      `UPDATE agent_workers SET status = 'idle', last_task_at = ?, last_text = ?, updated_at = ?
        WHERE team_id = ? AND key = ? AND status = 'waiting'`,
    )
    for (const key of unique) {
      const result = statement.run(now, String(text || '').slice(-1200), now, this.teamId, key) as
        | { changes?: number | bigint }
        | undefined
      if (Number(result?.changes ?? 0) > 0) settled.push(key)
    }
    return settled
  }

  findWorker(key: string): TeamWorker | undefined {
    const row = this.db.prepare(
      `SELECT key, name, idx, status, run_id, model_id, model_name, last_task_at, last_text,
              role, parent_key, depth, acceptance, pinned, retired_at, retire_reason, created_at, updated_at
         FROM agent_workers WHERE team_id = ? AND key = ?`,
    ).get(this.teamId, key) as WorkerRow | undefined
    return row ? this.rowToWorker(row) : undefined
  }

  /** 默认只返回活跃岗位；includeRetired=true 时把软注销的历史窗口也带出来。 */
  listWorkers(includeRetired = false): TeamWorker[] {
    const rows = this.db.prepare(
      `SELECT key, name, idx, status, run_id, model_id, model_name, last_task_at, last_text,
              role, parent_key, depth, acceptance, pinned, retired_at, retire_reason, created_at, updated_at
         FROM agent_workers
         WHERE team_id = ?${includeRetired ? '' : ' AND retired_at IS NULL'}
         ORDER BY idx ASC, created_at ASC`,
    ).all(this.teamId) as unknown as WorkerRow[]
    return rows.map((row) => this.rowToWorker(row))
  }

  listAllWorkers(): TeamWorker[] {
    return this.listWorkers(true)
  }

  teamTree(includeRetired = false): TeamTreeNode[] {
    return buildTeamTree(this.listWorkers(includeRetired))
  }

  /** 已注册的活跃岗位数量（不含软注销）。 */
  activeWorkerCount(): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS count FROM agent_workers WHERE team_id = ? AND retired_at IS NULL',
    ).get(this.teamId) as { count: number } | undefined
    return Number(row?.count) || 0
  }

  /** 取消一个 worker 的排队/执行任务，但保留 worker 行和消息，供后续审计或复活。 */
  retireWorker(key: string, reason = '', options: { force?: boolean; now?: number } = {}): TeamWorker {
    const now = options.now ?? Date.now()
    const worker = this.findWorker(key)
    if (!worker) throw new Error(`子 Agent「${key}」不存在`)
    if (worker.retiredAt !== null) return worker
    if (worker.status === 'running' && !options.force) {
      throw new Error(`子 Agent「${key}」正在执行任务，先等它完成；确实要强制注销请传 force`)
    }
    if (worker.pinned && !options.force) {
      throw new Error(`子 Agent「${key}」是固定岗位，不能被自动注销`)
    }
    this.db.prepare(
      `UPDATE agent_tasks
          SET status = 'cancelled', error = ?, finished_at = ?, updated_at = ?
        WHERE team_id = ? AND worker_key = ? AND status IN ('queued', 'running')`,
    ).run(`子 Agent 已注销：${reason || '父 Agent 主动收掉岗位'}`, now, now, this.teamId, key)
    this.db.prepare(
      `UPDATE agent_workers
          SET status = 'idle', retired_at = ?, retire_reason = ?, last_task_at = ?, updated_at = ?
        WHERE team_id = ? AND key = ?`,
    ).run(now, String(reason || '').slice(0, 240), now, now, this.teamId, key)
    return this.findWorker(key) as TeamWorker
  }

  /**
   * 注册容量控制：先软注销最老的空闲非固定岗位，仍放不下就明确报错。
   * 不静默丢弃任务，也不淘汰 running / waiting / pinned。
   */
  ensureCapacity(keys: readonly string[], now = Date.now()): string[] {
    const unique = [...new Set(keys.filter(Boolean))]
    const current = this.activeWorkerCount()
    const known = new Set(this.listWorkers().map((worker) => worker.key))
    const incoming = unique.filter((key) => !known.has(key)).length
    let need = current + incoming - this.maxWorkers
    if (need <= 0) return []
    const candidates = this.listWorkers()
      .filter((worker) => worker.status === 'idle' && !worker.pinned && !unique.includes(worker.key))
      .sort((a, b) => a.lastTaskAt - b.lastTaskAt || a.index - b.index)
    const retired: string[] = []
    for (const worker of candidates) {
      if (need <= 0) break
      this.retireWorker(worker.key, '团队容量已满，自动让位', { now })
      retired.push(worker.key)
      need -= 1
    }
    if (need > 0) {
      throw new Error(
        `团队活跃岗位已满（上限 ${this.maxWorkers} 个），没有可自动注销的空闲非固定岗位；请用 agent_task 复用现有 key，或先 agent_retire 收掉不用的岗位`,
      )
    }
    return retired
  }

  /** 等待父 Agent 回答太久：软注销并留下原因，避免 waiting 永久占着团队容量。 */
  pruneStaleWaiting(now = Date.now()): string[] {
    const cutoff = now - this.waitingTtlMs
    const rows = this.db.prepare(
      `SELECT key FROM agent_workers
        WHERE team_id = ? AND status = 'waiting' AND retired_at IS NULL
          AND pinned = 0 AND last_task_at < ?`,
    ).all(this.teamId, cutoff) as unknown as Array<{ key: string }>
    for (const row of rows) {
      try {
        this.retireWorker(row.key, '等待父 Agent 回答超时，已注销', { now })
      } catch {
        // pinned 或状态已变化：跳过，不阻断其它清理。
      }
    }
    return rows.map((row) => row.key)
  }

  /** 保留期结束后硬删除已注销的 worker 和消息；任务历史仍保留在 agent_tasks 供审计。 */
  purgeRetiredWorkers(now = Date.now()): string[] {
    if (this.retentionMs <= 0) return []
    const cutoff = now - this.retentionMs
    const rows = this.db.prepare(
      `SELECT key FROM agent_workers
        WHERE team_id = ? AND retired_at IS NOT NULL AND retired_at < ?`,
    ).all(this.teamId, cutoff) as unknown as Array<{ key: string }>
    for (const row of rows) {
      this.db.prepare('DELETE FROM agent_workers WHERE team_id = ? AND key = ?').run(this.teamId, row.key)
      this.db.prepare('DELETE FROM agent_team_messages WHERE team_id = ? AND worker_key = ?').run(this.teamId, row.key)
    }
    return rows.map((row) => row.key)
  }

  pruneIdleWorkers(now = Date.now()): string[] {
    const cutoff = now - this.idleMs
    const rows = this.db.prepare(
      `SELECT key FROM agent_workers
        WHERE team_id = ? AND status = 'idle' AND retired_at IS NULL
          AND pinned = 0 AND last_task_at < ?`,
    ).all(this.teamId, cutoff) as unknown as Array<{ key: string }>
    if (rows.length === 0) {
      this.purgeRetiredWorkers(now)
      return []
    }
    for (const row of rows) {
      try {
        // 软注销：保留 worker 行和 agent_team_messages，评审链稍后还能用同一 key 复活；
        // 只有超过 retentionMs 才由 purgeRetiredWorkers 硬删除。
        this.retireWorker(row.key, '空闲超时，已移出活跃岗位', { now })
      } catch {
        // 状态在清理过程中变化：跳过这个 key，继续处理其它空闲岗位。
      }
    }
    this.purgeRetiredWorkers(now)
    return rows.map((row) => row.key)
  }

  clearTeam(): void {
    this.db.prepare('DELETE FROM agent_workers WHERE team_id = ?').run(this.teamId)
    this.db.prepare('DELETE FROM agent_team_messages WHERE team_id = ?').run(this.teamId)
    this.db.prepare('DELETE FROM agent_events WHERE team_id = ?').run(this.teamId)
  }

  roster(now = Date.now()): string {
    this.pruneIdleWorkers(now)
    this.pruneStaleWaiting(now)
    const lines = [rosterText(this.listWorkers(), this.maxWorkers)]
    const pending = this.listPendingEvents(5)
    if (pending.length > 0) {
      lines.push(
        '还有未处理的子 Agent 事件：\n' +
          pending
            .map((event) => `- ${event.workerKey}：${event.kind}（${JSON.stringify(event.payload).slice(0, 220)}）`)
            .join('\n') +
          '\n用 agent_wait 取事件；需要它继续时用 agent_task 把答复或下一步发回去。',
      )
    }
    const tasks = this.listTasks(5).filter((task) => task.status === 'queued' || task.status === 'running')
    if (tasks.length > 0) {
      lines.push(
        '后台任务仍在执行：\n' +
          tasks
            .map((task) => `- ${task.workerKey}（${task.status}，task=${task.id}）：${task.prompt.slice(0, 120)}`)
            .join('\n'),
      )
    }
    return lines.filter(Boolean).join('\n')
  }

  /** 父 Agent 在子 Agent 运行中追加一条指示；子 Agent 下一轮工具循环前会读到。 */
  sendGuidance(workerKey: string, text: string, now = Date.now()): AgentTeamEvent {
    return this.recordEvent({ workerKey, kind: 'guidance', payload: { text: text.slice(0, 2000) }, now })
  }

  /** 子 Agent 取走父 Agent 的指示；只消费，不重复投递。 */
  takeGuidance(workerKey: string, limit = 5): string[] {
    const rows = this.db.prepare(
      `SELECT id, payload_json FROM agent_events
        WHERE team_id = ? AND worker_key = ? AND kind = 'guidance' AND consumed_at IS NULL
        ORDER BY created_at ASC, rowid ASC LIMIT ?`,
    ).all(this.teamId, workerKey, limit) as unknown as Array<{ id: string; payload_json: string }>
    const texts: string[] = []
    for (const row of rows) {
      const payload = parseJson(row.payload_json) as { text?: unknown } | null
      if (typeof payload?.text === 'string' && payload.text.trim()) texts.push(payload.text.trim())
      this.consumeEvent(row.id)
    }
    return texts
  }

  /* ---------------------------- 任务 ---------------------------- */

  createTask(input: {
    id?: string
    workerKey: string
    prompt: string
    parentRunId?: string | null
    modelId?: string
    now?: number
  }): AgentTeamTask {
    const id = input.id ?? `task_${randomUUID()}`
    const now = input.now ?? Date.now()
    this.db.prepare(
      `INSERT INTO agent_tasks
         (id, team_id, company_id, user_id, worker_key, parent_run_id, child_run_id, status,
          prompt, result_text, error, model_id, started_at, finished_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 'queued', ?, '', '', ?, NULL, NULL, ?, ?)`,
    ).run(
      id,
      this.teamId,
      this.companyId,
      this.userId,
      input.workerKey,
      input.parentRunId ?? null,
      input.prompt,
      input.modelId ?? '',
      now,
      now,
    )
    return this.getTask(id) as AgentTeamTask
  }

  markTaskRunning(id: string, childRunId: string, now = Date.now()): void {
    this.db.prepare(
      `UPDATE agent_tasks SET status = 'running', child_run_id = ?, started_at = COALESCE(started_at, ?), updated_at = ?
        WHERE id = ?`,
    ).run(childRunId, now, now, id)
  }

  markTaskDone(id: string, resultText: string, now = Date.now()): void {
    this.db.prepare(
      `UPDATE agent_tasks SET status = 'succeeded', result_text = ?, error = '', finished_at = ?, updated_at = ?
        WHERE id = ?`,
    ).run(resultText.slice(0, 4000), now, now, id)
  }

  markTaskFailed(id: string, error: string, now = Date.now()): void {
    this.db.prepare(
      `UPDATE agent_tasks SET status = 'failed', error = ?, finished_at = ?, updated_at = ?
        WHERE id = ?`,
    ).run(error.slice(0, 500), now, now, id)
  }

  markTaskCancelled(id: string, reason = '已取消', now = Date.now()): void {
    this.db.prepare(
      `UPDATE agent_tasks SET status = 'cancelled', error = ?, finished_at = ?, updated_at = ?
        WHERE id = ?`,
    ).run(reason.slice(0, 500), now, now, id)
  }

  getTask(id: string): AgentTeamTask | undefined {
    const row = this.db.prepare(
      `SELECT id, team_id, worker_key, parent_run_id, child_run_id, status, prompt, result_text,
              error, model_id, started_at, finished_at, wake_at, created_at, updated_at
         FROM agent_tasks WHERE team_id = ? AND id = ?`,
    ).get(this.teamId, id) as TaskRow | undefined
    return row ? toTask(row) : undefined
  }

  listTasks(limit = 20): AgentTeamTask[] {
    const rows = this.db.prepare(
      `SELECT id, team_id, worker_key, parent_run_id, child_run_id, status, prompt, result_text,
              error, model_id, started_at, finished_at, wake_at, created_at, updated_at
         FROM agent_tasks WHERE team_id = ?
         ORDER BY created_at DESC LIMIT ?`,
    ).all(this.teamId, Math.max(1, Math.min(100, limit))) as unknown as TaskRow[]
    return rows.map(toTask)
  }

  /**
   * 已经结束、或正在等父 Agent 回答、但父 Agent 还没有被唤醒的任务。
   * 传入 taskIds 时只取这些任务：启动恢复只唤醒本次重启打断的任务，不把历史积压一起捞出来。
   */
  listTasksAwaitingWake(limit = 10, taskIds?: readonly string[]): AgentTeamTask[] {
    const ids = taskIds?.filter((id) => id.trim().length > 0) ?? []
    if (taskIds && ids.length === 0) return []
    const idClause = ids.length > 0
      ? ` AND t.id IN (${ids.map(() => '?').join(', ')})`
      : ''
    const rows = this.db.prepare(
      `SELECT t.id, t.team_id, t.worker_key, t.parent_run_id, t.child_run_id, t.status, t.prompt,
              t.result_text, t.error, t.model_id, t.started_at, t.finished_at, t.wake_at, t.created_at, t.updated_at
         FROM agent_tasks t
        WHERE t.team_id = ?${idClause} AND t.wake_at IS NULL
          AND (
            t.status IN ('succeeded', 'failed', 'cancelled')
            OR EXISTS (
              SELECT 1 FROM agent_events e
               WHERE e.team_id = t.team_id AND e.task_id = t.id
                 AND e.kind = 'question' AND e.consumed_at IS NULL
            )
          )
        ORDER BY COALESCE(t.finished_at, t.created_at) ASC LIMIT ?`,
    ).all(this.teamId, ...ids, Math.max(1, Math.min(50, limit))) as unknown as TaskRow[]
    return rows.map(toTask)
  }

  /** 恢复唤醒时发现任务已无法重建身份/团队：标记为跳过，避免每次启动重复尝试。 */
  markTasksWakeSkipped(ids: string[], reason: string, now = Date.now()): void {
    for (const id of ids) {
      this.db.prepare(
        'UPDATE agent_tasks SET wake_state = ?, updated_at = ? WHERE team_id = ? AND id = ?',
      ).run(`skipped:${reason}`.slice(0, 120), now, this.teamId, id)
    }
  }


  markTasksWoken(ids: string[], now = Date.now()): void {
    for (const id of ids) {
      this.db.prepare(
        'UPDATE agent_tasks SET wake_at = ?, wake_state = ?, updated_at = ? WHERE team_id = ? AND id = ?',
      ).run(now, 'woken', now, this.teamId, id)
    }
  }

  /* ---------------------------- 事件 ---------------------------- */

  recordEvent(input: {
    workerKey: string
    kind: string
    payload?: unknown
    taskId?: string | null
    now?: number
  }): AgentTeamEvent {
    const now = input.now ?? Date.now()
    const id = `evt_${randomUUID()}`
    this.db.prepare(
      `INSERT INTO agent_events
         (id, team_id, company_id, user_id, worker_key, task_id, kind, payload_json, created_at, consumed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      id,
      this.teamId,
      this.companyId,
      this.userId,
      input.workerKey,
      input.taskId ?? null,
      input.kind,
      JSON.stringify(input.payload ?? {}),
      now,
    )
    // 同一个任务可能先提问、后完成：新事件必须重新获得唤醒资格，
    // 否则上一次 question 唤醒会把这条任务的 wake_at 永久写死。
    if (input.taskId) {
      this.db.prepare(
        'UPDATE agent_tasks SET wake_at = NULL, wake_state = NULL, updated_at = ? WHERE team_id = ? AND id = ?',
      ).run(now, this.teamId, input.taskId)
    }
    wakeTeam(this.teamId)
    return {
      id,
      teamId: this.teamId,
      workerKey: input.workerKey,
      taskId: input.taskId ?? null,
      kind: input.kind,
      payload: input.payload ?? {},
      createdAt: now,
    }
  }

  private takePendingEvent(kinds?: string[]): AgentTeamEvent | null {
    const kindFilter = kinds && kinds.length > 0
      ? ` AND kind IN (${kinds.map(() => '?').join(', ')})`
      : ''
    const row = this.db.prepare(
      `SELECT id, team_id, worker_key, task_id, kind, payload_json, created_at
         FROM agent_events
        WHERE team_id = ? AND consumed_at IS NULL${kindFilter}
        ORDER BY created_at ASC, rowid ASC LIMIT 1`,
    ).get(this.teamId, ...(kinds && kinds.length > 0 ? kinds : [])) as EventRow | undefined
    if (!row) return null
    this.db.prepare('UPDATE agent_events SET consumed_at = ? WHERE id = ?').run(Date.now(), row.id)
    return toEvent(row)
  }

  listPendingEvents(limit = 20): AgentTeamEvent[] {
    const rows = this.db.prepare(
      `SELECT id, team_id, worker_key, task_id, kind, payload_json, created_at
         FROM agent_events
        WHERE team_id = ? AND consumed_at IS NULL
        ORDER BY created_at ASC, rowid ASC LIMIT ?`,
    ).all(this.teamId, Math.max(1, Math.min(100, limit))) as unknown as EventRow[]
    return rows.map(toEvent)
  }

  consumeEvent(id: string): void {
    this.db.prepare('UPDATE agent_events SET consumed_at = ? WHERE team_id = ? AND id = ?')
      .run(Date.now(), this.teamId, id)
  }

  /** 等待下一个未消费事件；超时返回 null。父 Agent 用 agent_wait 调用。 */
  async waitForEvent(
    timeoutMs = 30_000,
    signal?: AbortSignal,
    kinds?: string[],
  ): Promise<AgentTeamEvent | null> {
    const deadline = Date.now() + Math.max(0, timeoutMs)
    while (true) {
      const immediate = this.takePendingEvent(kinds)
      if (immediate) return immediate
      const remaining = deadline - Date.now()
      if (remaining <= 0) return null
      await waitOnce(this.teamId, remaining, signal)
    }
  }
}

/**
 * 启动时收尾上次进程留下的后台任务和 running worker。
 *
 * 这不是“自动重跑”：任务原文和 `agent_runs.resume_state_json` 里的检查点都还在，
 * 但没有可信的调用方身份，不能擅自再花一次模型费用。先把状态改成可解释的失败/
 * 空闲，避免 UI 和控制台一直显示“运行中”；启动稳定后再由父 Agent 被唤醒决定
 * 是否 `agent_resume`，而不是启动代码直接重跑。
 *
 * 本轮收尾的任务额外标 `wake_state='restart'`，供启动后的恢复唤醒只捡“本次重启
 * 新打断”的任务，避免把历史积压的失败任务一起叫醒。
 */
export function recoverInterruptedAgentTasks(db: Db, now = Date.now()): number {
  let count = 0
  try {
    const tasks = db.prepare(
      `SELECT id, team_id, worker_key, company_id, user_id, child_run_id
         FROM agent_tasks WHERE status IN ('queued', 'running')`,
    ).all() as unknown as Array<{
      id: string
      team_id: string
      worker_key: string
      company_id: string
      user_id: string
      child_run_id: string | null
    }>
    for (const task of tasks) {
      db.prepare(
        `UPDATE agent_tasks
            SET status = 'failed', error = ?, finished_at = ?, updated_at = ?, wake_at = NULL, wake_state = 'restart'
          WHERE id = ? AND status IN ('queued', 'running')`,
      ).run('服务重启中断；任务和检查点已保留，需要时请重新派活', now, now, task.id)
      try {
        db.prepare(
          `INSERT INTO agent_events
             (id, team_id, company_id, user_id, worker_key, task_id, kind, payload_json, created_at, consumed_at)
           VALUES (?, ?, ?, ?, ?, ?, 'error', ?, ?, NULL)`,
        ).run(
          `evt_${randomUUID()}`,
          task.team_id,
          task.company_id,
          task.user_id,
          task.worker_key,
          task.id,
          JSON.stringify({ taskId: task.id, error: '服务重启中断；任务和检查点已保留' }),
          now,
        )
      } catch {
        // 事件写失败不影响收尾。
      }
      count += 1
    }
    db.prepare(
      `UPDATE agent_workers
          SET status = 'idle', last_task_at = ?, last_text = ?, updated_at = ?
        WHERE status IN ('running', 'waiting')`,
    ).run(now, '服务重启中断，等待父 Agent 重新派活', now)
  } catch {
    // 启动收尾失败只影响展示，不阻断服务启动。
  }
  return count
}

/**
 * 本次重启刚收尾、尚未唤醒父 Agent 的后台任务。
 *
 * 只认 `wake_state='restart'`：历史失败任务保持 NULL，不会被启动恢复一次性叫醒。
 */
export function listRestartRecoveredTasks(db: Db, limit = 50): RestartRecoveredTask[] {
  const rows = db.prepare(
    `SELECT id, team_id, worker_key, company_id, user_id, parent_run_id, model_id, error, updated_at
       FROM agent_tasks
      WHERE wake_state = 'restart' AND wake_at IS NULL AND status = 'failed'
      ORDER BY updated_at ASC
      LIMIT ?`,
  ).all(Math.max(1, Math.trunc(limit))) as unknown as Array<{
    id: string
    team_id: string
    worker_key: string
    company_id: string
    user_id: string
    parent_run_id: string
    model_id: string | null
    error: string | null
    updated_at: number
  }>
  return rows.map((row) => ({
    id: row.id,
    teamId: row.team_id,
    workerKey: row.worker_key,
    companyId: row.company_id,
    userId: row.user_id,
    parentRunId: row.parent_run_id,
    modelId: row.model_id ?? '',
    error: row.error ?? '',
    updatedAt: Number(row.updated_at) || 0,
  }))
}
