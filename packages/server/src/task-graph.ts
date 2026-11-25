/**
 * AGT-16 任务图 v1。
 *
 * 边界：
 * 1. 定义与版本分离：草稿可反复保存；发布后冻结 definition_json，运行只读发布版本。
 * 2. 一次运行有唯一 trace_id，步骤 append-only；人工 / 等待节点靠持久状态恢复。
 * 3. 工具与子 Agent 不在本模块直接调用，由调用方注入 executor，测试可替换为确定性实现。
 */
import { randomUUID } from 'node:crypto'
import { EC, EabError } from '@eab/domain'
import type { Db } from '@eab/storage'

export type TaskGraphNodeKind = 'start' | 'tool' | 'agent' | 'manual' | 'wait' | 'condition' | 'end'
export type TaskGraphRunStatus =
  | 'running'
  | 'waiting_manual'
  | 'waiting_wait'
  | 'succeeded'
  | 'failed'
  | 'rejected'
  | 'cancelled'

export interface TaskGraphEdgeRule {
  field?: string
  op?: 'eq' | 'neq' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists' | 'empty' | 'truthy'
  value?: unknown
  else?: boolean
}

export interface TaskGraphNode {
  id: string
  kind: TaskGraphNodeKind
  title: string
  description?: string
  nextIds?: string[]
  edgeLabels?: Record<string, string>
  edgeRules?: Record<string, TaskGraphEdgeRule>
  /** 工具节点的工具 id，例如 kb.search。 */
  tool?: string
  /** 工具参数；字符串支持 {{input.question}} / {{nodes.lookup.hits.0.title}} 模板。 */
  args?: Record<string, unknown>
  /** 子 Agent 节点：必须写明模型与指令，避免运行时靠猜。 */
  agent?: { modelId?: string; prompt?: string; maxRounds?: number }
  /** 人工节点：可写处理说明、处理角色和超时；拒绝时走 rejectNextId。 */
  manual?: { instructions?: string; assigneeRole?: string; timeoutHours?: number; rejectNextId?: string }
  /** 等待节点：durationSec 后自动恢复。 */
  wait?: { durationSec?: number }
  [key: string]: unknown
}

export interface TaskGraphDefinition {
  entry: string
  nodes: TaskGraphNode[]
}

export interface TaskGraphView {
  id: string
  name: string
  description: string
  status: 'draft' | 'published' | 'disabled'
  version: number
  draftVersion: number | null
  publishedVersion: number | null
  definition: TaskGraphDefinition
  validation: string[]
  updatedAt: number
  createdAt: number
}

export interface TaskGraphValidation {
  valid: boolean
  errors: string[]
}

export interface TaskGraphToolRequest {
  nodeId: string
  tool: string
  args: Record<string, unknown>
  traceId: string
  signal?: AbortSignal
}

export interface TaskGraphAgentRequest {
  nodeId: string
  modelId: string
  prompt: string
  maxRounds: number
  traceId: string
  signal?: AbortSignal
}

export interface TaskGraphExecutor {
  runTool(request: TaskGraphToolRequest): Promise<unknown>
  runAgent(request: TaskGraphAgentRequest): Promise<{ text: string; runId?: string }>
}

export interface TaskGraphRunIdentity {
  id: string
  userId: string
  graphId: string
}

/** 自动恢复时要按发起人重新组装执行身份：不能用控制台超管兜底。 */
export type TaskGraphExecutorProvider =
  | TaskGraphExecutor
  | ((run: TaskGraphRunIdentity) => TaskGraphExecutor)

export interface TaskGraphRunView {
  id: string
  traceId: string
  graphId: string
  graphName: string
  graphVersion: number
  definition: TaskGraphDefinition
  status: TaskGraphRunStatus
  userId: string
  input: Record<string, unknown>
  variables: Record<string, unknown>
  currentNodeId: string | null
  waiting: Record<string, unknown> | null
  error: string | null
  startedAt: number
  finishedAt: number | null
  steps: TaskGraphStepView[]
}

export interface TaskGraphStepView {
  seq: number
  nodeId: string
  nodeKind: TaskGraphNodeKind
  title: string
  status: string
  input: unknown
  output: unknown
  error: string | null
  startedAt: number
  finishedAt: number | null
  durationMs: number
}

interface GraphRow {
  id: string
  company_id: string
  name: string
  description: string
  status: string
  current_version: number
  draft_version_id: string | null
  published_version_id: string | null
  created_by: string | null
  created_at: number
  updated_at: number
}

interface VersionRow {
  id: string
  graph_id: string
  company_id: string
  version: number
  status: string
  definition_json: string
  validation_json: string | null
  created_at: number
  updated_at: number
  published_at: number | null
}

interface RunRow {
  id: string
  trace_id: string
  company_id: string
  graph_id: string
  graph_version: number
  version_id: string
  user_id: string
  status: string
  input_json: string
  variables_json: string
  current_node_id: string | null
  waiting_json: string | null
  error: string | null
  started_at: number
  finished_at: number | null
  created_at: number
  updated_at: number
  lease_owner: string | null
  lease_until: number | null
  cancel_requested_at: number | null
}

interface StepRow {
  id: string
  run_id: string
  seq: number
  node_id: string
  node_kind: string
  title: string
  status: string
  input_json: string | null
  output_json: string | null
  error: string | null
  started_at: number
  finished_at: number | null
  duration_ms: number
}

const NODE_KINDS = new Set<TaskGraphNodeKind>(['start', 'tool', 'agent', 'manual', 'wait', 'condition', 'end'])
const TERMINAL = new Set<TaskGraphRunStatus>(['succeeded', 'failed', 'rejected', 'cancelled'])
const MAX_NODES = 100
const MAX_STEPS_PER_ADVANCE = 200
const MAX_STORED_STRING = 4000
const MAX_STORED_ARRAY = 50
const RUN_LEASE_MS = 60_000
const RUN_HEARTBEAT_MS = 10_000
const PROCESS_LEASE_ID = `tgw_${randomUUID().replace(/-/g, '')}`

const runLocks = new Map<string, Promise<unknown>>()
const activeRunControllers = new Map<string, AbortController>()

class TaskGraphRunInterrupted extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TaskGraphRunInterrupted'
  }
}

function isRunInterrupted(error: unknown): boolean {
  return error instanceof TaskGraphRunInterrupted
}

function graphColumns(): string {
  return `id, company_id, name, description, status, current_version, draft_version_id,
          published_version_id, created_by, created_at, updated_at`
}

function runColumns(): string {
  return `id, trace_id, company_id, graph_id, graph_version, version_id, user_id, status,
          input_json, variables_json, current_node_id, waiting_json, error,
          started_at, finished_at, created_at, updated_at,
          lease_owner, lease_until, cancel_requested_at`
}

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback
  try {
    const value = JSON.parse(text)
    return (value ?? fallback) as T
  } catch {
    return fallback
  }
}

/** 存储时限制体量，但保持 JSON 可解析：只压深数组和超长字符串，不截断 JSON 文本。 */
function compactValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return null
  if (typeof value === 'string') {
    return value.length > MAX_STORED_STRING ? `${value.slice(0, MAX_STORED_STRING)}…` : value
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_STORED_ARRAY).map((item) => compactValue(item, depth + 1))
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    let count = 0
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (count >= 80) break
      out[key] = compactValue(item, depth + 1)
      count += 1
    }
    return out
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  return null
}

function jsonStored(value: unknown): string {
  return JSON.stringify(compactValue(value ?? null))
}

function normalizeDefinition(value: unknown): TaskGraphDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new EabError(EC.VALIDATION, 'definition 必须是对象')
  }
  const raw = value as Record<string, unknown>
  if (!Array.isArray(raw.nodes)) throw new EabError(EC.VALIDATION, 'definition.nodes 必须是数组')
  if (raw.nodes.length > MAX_NODES) throw new EabError(EC.VALIDATION, `任务图节点不能超过 ${MAX_NODES} 个`)
  return {
    entry: String(raw.entry ?? '').trim(),
    nodes: raw.nodes as TaskGraphNode[],
  }
}

function nodeMapOf(definition: TaskGraphDefinition): Map<string, TaskGraphNode> {
  return new Map(definition.nodes.map((node) => [String(node?.id ?? ''), node]))
}

function outgoingOf(node: TaskGraphNode): string[] {
  if (!Array.isArray(node.nextIds)) return []
  const out: string[] = []
  for (const raw of node.nextIds) {
    const id = String(raw ?? '').trim()
    if (id && !out.includes(id)) out.push(id)
  }
  return out
}

/** 校验用的出线集合：人工拒绝分支也是可达路径，必须参与可达性和环检测。 */
function validationOutgoingOf(node: TaskGraphNode): string[] {
  const out = outgoingOf(node)
  if (node.kind === 'manual') {
    const reject = String(node.manual?.rejectNextId ?? '').trim()
    if (reject && !out.includes(reject)) out.push(reject)
  }
  return out
}

function validateNext(
  node: TaskGraphNode,
  byId: Map<string, TaskGraphNode>,
  errors: string[],
): void {
  const id = String(node.id || '(空)')
  if (!Array.isArray(node.nextIds)) {
    if (node.kind !== 'end') errors.push(`节点 ${id} 缺少 nextIds`)
    return
  }
  if (node.kind === 'end' && node.nextIds.length > 0) errors.push(`结束节点 ${id} 不能有出线`)
  const targets: string[] = []
  for (const raw of node.nextIds) {
    const target = String(raw ?? '').trim()
    if (!target) {
      errors.push(`节点 ${id} 存在空出线目标`)
      continue
    }
    if (target === node.id) {
      errors.push(`节点 ${id} 不能连接到自身`)
      continue
    }
    if (!byId.has(target)) {
      errors.push(`节点 ${id} 的出线目标不存在：${target}`)
      continue
    }
    if (targets.includes(target)) {
      errors.push(`节点 ${id} 存在重复出线：${target}`)
      continue
    }
    targets.push(target)
  }
  if (node.kind !== 'condition' && node.kind !== 'end' && targets.length > 1) {
    errors.push(`节点 ${id} 不是条件节点，只能有一条出线`)
  }
  if (node.kind !== 'end' && targets.length === 0) {
    errors.push(`节点 ${id} 至少需要一条出线`)
  }
  if (node.kind === 'condition') {
    if (targets.length < 2) errors.push(`条件节点 ${id} 至少需要两条出线`)
    const rules = node.edgeRules
    if (!rules || typeof rules !== 'object' || Array.isArray(rules)) {
      errors.push(`条件节点 ${id} 缺少 edgeRules`)
    } else {
      const keys = Object.keys(rules)
      for (const target of targets) {
        if (!Object.prototype.hasOwnProperty.call(rules, target)) {
          errors.push(`条件节点 ${id} 的出线 ${target} 缺少判断规则`)
        }
      }
      for (const key of keys) {
        if (!targets.includes(key)) errors.push(`条件节点 ${id} 的规则指向不存在的出线：${key}`)
        const rule = rules[key]
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
          errors.push(`条件节点 ${id} 的出线 ${key} 规则必须是对象`)
          continue
        }
        if (rule.else) continue
        if (!String(rule.field ?? '').trim()) errors.push(`条件节点 ${id} 的出线 ${key} 缺少字段`)
        const op = String(rule.op ?? 'truthy')
        if (!['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte', 'exists', 'empty', 'truthy'].includes(op)) {
          errors.push(`条件节点 ${id} 的出线 ${key} 使用了不支持的操作：${op}`)
        }
      }
      const elseCount = Object.values(rules).filter((rule) => Boolean(rule?.else)).length
      if (elseCount > 1) errors.push(`条件节点 ${id} 最多只能有一个否则分支`)
    }
  }
}

export function validateTaskGraph(input: unknown): TaskGraphValidation {
  let definition: TaskGraphDefinition
  try {
    definition = normalizeDefinition(input)
  } catch (error) {
    return { valid: false, errors: [(error as Error).message] }
  }
  const errors: string[] = []
  const byId = nodeMapOf(definition)
  const seenIds = new Set<string>()
  if (!definition.entry) errors.push('缺少入口节点 entry')
  if (definition.nodes.length === 0) errors.push('任务图至少需要一个节点')

  for (const node of definition.nodes) {
    if (!node || typeof node !== 'object') {
      errors.push('存在无效节点')
      continue
    }
    const id = String(node.id ?? '').trim()
    if (!id) errors.push('存在缺少 id 的节点')
    else if (seenIds.has(id)) errors.push(`节点 id 重复：${id}`)
    else seenIds.add(id)
    if (!NODE_KINDS.has(node.kind)) errors.push(`节点 ${id || '(空)'} 的 kind 不合法：${node.kind}`)
    if (!String(node.title ?? '').trim()) errors.push(`节点 ${id || '(空)'} 缺少标题`)
    validateNext(node, byId, errors)

    if (node.kind === 'tool') {
      if (!String(node.tool ?? '').trim()) errors.push(`工具节点 ${id} 缺少 tool`)
      if (node.args !== undefined && (!node.args || typeof node.args !== 'object' || Array.isArray(node.args))) {
        errors.push(`工具节点 ${id} 的 args 必须是对象`)
      }
    }
    if (node.kind === 'agent') {
      if (!String(node.agent?.prompt ?? '').trim()) errors.push(`子 Agent 节点 ${id} 缺少 agent.prompt`)
      if (!String(node.agent?.modelId ?? '').trim()) errors.push(`子 Agent 节点 ${id} 缺少 agent.modelId`)
      const rounds = node.agent?.maxRounds
      if (rounds !== undefined && (!Number.isFinite(Number(rounds)) || Number(rounds) < 1 || Number(rounds) > 20)) {
        errors.push(`子 Agent 节点 ${id} 的 maxRounds 必须在 1–20`)
      }
    }
    if (node.kind === 'wait') {
      const seconds = Number(node.wait?.durationSec ?? 60)
      if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 30 * 24 * 3600) {
        errors.push(`等待节点 ${id} 的 durationSec 必须在 1 秒到 30 天之间`)
      }
    }
    if (node.kind === 'manual' && node.manual?.rejectNextId !== undefined) {
      const rejectId = String(node.manual.rejectNextId ?? '').trim()
      if (!rejectId) errors.push(`人工节点 ${id} 的 rejectNextId 不能为空`)
      else if (rejectId === String(node.id)) errors.push(`人工节点 ${id} 的 rejectNextId 不能指向自身`)
      else if (!byId.has(rejectId)) errors.push(`人工节点 ${id} 的 rejectNextId 不存在：${rejectId}`)
    }
  }

  const starts = definition.nodes.filter((node) => node?.kind === 'start')
  if (starts.length !== 1) errors.push('任务图必须且只能有一个开始节点')
  if (definition.entry && !byId.has(definition.entry)) errors.push(`入口节点不存在：${definition.entry}`)
  const entryNode = byId.get(definition.entry)
  if (entryNode && entryNode.kind !== 'start') errors.push('入口节点必须是 start')
  if (!definition.nodes.some((node) => node?.kind === 'end')) errors.push('任务图至少需要一个结束节点')

  // 可达性：避免定义了永远跑不到的节点。
  if (entryNode) {
    const seen = new Set<string>()
    const stack = [definition.entry]
    while (stack.length) {
      const id = stack.pop() as string
      if (seen.has(id)) continue
      seen.add(id)
      for (const target of validationOutgoingOf(byId.get(id) as TaskGraphNode)) stack.push(target)
    }
    for (const node of definition.nodes) {
      const id = String(node?.id ?? '')
      if (id && !seen.has(id)) errors.push(`节点 ${id} 从入口不可达`)
    }
  }

  // 环检测：v1 明确拒绝循环，保证一次运行可结束。
  const visiting = new Set<string>()
  const visited = new Set<string>()
  let hasCycle = false
  const walk = (id: string) => {
    if (hasCycle) return
    if (visiting.has(id)) {
      hasCycle = true
      return
    }
    if (visited.has(id)) return
    visiting.add(id)
    const node = byId.get(id)
    if (node) {
      for (const target of validationOutgoingOf(node)) walk(target)
    }
    visiting.delete(id)
    visited.add(id)
  }
  if (entryNode) walk(definition.entry)
  if (hasCycle) errors.push('任务图不能包含循环')

  return { valid: errors.length === 0, errors }
}

function readVersion(db: Db, versionId: string | null, companyId: string): VersionRow | null {
  if (!versionId) return null
  const row = db
    .prepare(
      `SELECT id, graph_id, company_id, version, status, definition_json, validation_json,
              created_at, updated_at, published_at
         FROM task_graph_versions
        WHERE id = ? AND company_id = ? LIMIT 1`,
    )
    .get(versionId, companyId) as VersionRow | undefined
  return row ?? null
}

function definitionOf(row: VersionRow | null): TaskGraphDefinition {
  if (!row) return { entry: '', nodes: [] }
  const parsed = parseJson<unknown>(row.definition_json, { entry: '', nodes: [] })
  try {
    return normalizeDefinition(parsed)
  } catch {
    return { entry: '', nodes: [] }
  }
}

function validationOf(row: VersionRow | null): string[] {
  if (!row?.validation_json) return []
  const parsed = parseJson<unknown>(row.validation_json, [])
  return Array.isArray(parsed) ? parsed.map((item) => String(item)) : []
}

function readGraphView(db: Db, row: GraphRow): TaskGraphView {
  const draft = readVersion(db, row.draft_version_id, row.company_id)
  const published = readVersion(db, row.published_version_id, row.company_id)
  const active = draft ?? published
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status === 'published' || row.status === 'disabled' ? row.status : 'draft',
    version: Number(row.current_version) || 0,
    draftVersion: draft ? Number(draft.version) : null,
    publishedVersion: published ? Number(published.version) : null,
    definition: definitionOf(active),
    validation: validationOf(active),
    updatedAt: Number(row.updated_at),
    createdAt: Number(row.created_at),
  }
}

function getGraphRow(db: Db, companyId: string, id: string): GraphRow {
  const row = db
    .prepare(
      `SELECT ${graphColumns()} FROM task_graphs
        WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
    )
    .get(id, companyId) as GraphRow | undefined
  if (!row) throw new EabError(EC.NOT_FOUND, '任务图不存在')
  return row
}

function insertGraph(
  db: Db,
  companyId: string,
  createdBy: string,
  input: { id: string; name: string; description: string },
  now: number,
): GraphRow {
  db.prepare(
    `INSERT INTO task_graphs
       (id, company_id, name, description, status, current_version, draft_version_id,
        published_version_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'draft', 0, NULL, NULL, ?, ?, ?)`,
  ).run(input.id, companyId, input.name, input.description, createdBy, now, now)
  return getGraphRow(db, companyId, input.id)
}

function writeDraftVersion(
  db: Db,
  graph: GraphRow,
  definition: TaskGraphDefinition,
  createdBy: string,
  now: number,
): { id: string; version: number; validation: string[] } {
  const version = Number(graph.current_version || 0) + 1
  const existing = graph.draft_version_id
    ? readVersion(db, graph.draft_version_id, graph.company_id)
    : null
  const validation = validateTaskGraph(definition)
  if (existing && Number(existing.version) === version) {
    db.prepare(
      `UPDATE task_graph_versions
          SET definition_json = ?, validation_json = ?, updated_at = ?, created_by = ?
        WHERE id = ?`,
    ).run(JSON.stringify(definition), JSON.stringify(validation.errors), now, createdBy, existing.id)
    return { id: existing.id, version, validation: validation.errors }
  }
  const id = `tgv_${randomUUID().replace(/-/g, '')}`
  db.prepare(
    `INSERT INTO task_graph_versions
       (id, graph_id, company_id, version, status, definition_json, validation_json,
        created_by, created_at, updated_at, published_at)
     VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, NULL)`,
  ).run(
    id,
    graph.id,
    graph.company_id,
    version,
    JSON.stringify(definition),
    JSON.stringify(validation.errors),
    createdBy,
    now,
    now,
  )
  return { id, version, validation: validation.errors }
}

export function listTaskGraphs(db: Db, companyId: string): TaskGraphView[] {
  const rows = db
    .prepare(
      `SELECT ${graphColumns()} FROM task_graphs
        WHERE company_id = ? AND deleted_at IS NULL
        ORDER BY CASE status WHEN 'published' THEN 0 ELSE 1 END, updated_at DESC, created_at ASC`,
    )
    .all(companyId) as unknown as GraphRow[]
  return rows.map((row) => readGraphView(db, row))
}

export function getTaskGraph(db: Db, companyId: string, id: string): TaskGraphView {
  return readGraphView(db, getGraphRow(db, companyId, id))
}

export interface SaveTaskGraphInput {
  id?: string
  name?: string
  description?: string
  definition?: unknown
}

export function saveTaskGraph(
  db: Db,
  companyId: string,
  createdBy: string,
  input: SaveTaskGraphInput,
): TaskGraphView {
  const definition = normalizeDefinition(input.definition)
  const name = String(input.name ?? '').trim()
  if (!name) throw new EabError(EC.VALIDATION, '任务图名称不能为空')
  const description = String(input.description ?? '').trim().slice(0, 500)
  const now = Date.now()

  let graph: GraphRow
  if (input.id) {
    graph = getGraphRow(db, companyId, String(input.id))
    db.prepare(
      `UPDATE task_graphs SET name = ?, description = ?, status = 'draft', updated_at = ?
        WHERE id = ? AND company_id = ?`,
    ).run(name, description, now, graph.id, companyId)
    graph = getGraphRow(db, companyId, graph.id)
  } else {
    const duplicate = db
      .prepare(
        `SELECT id FROM task_graphs WHERE company_id = ? AND name = ? AND deleted_at IS NULL LIMIT 1`,
      )
      .get(companyId, name) as { id: string } | undefined
    if (duplicate) throw new EabError(EC.VALIDATION, '任务图名称已存在')
    graph = insertGraph(db, companyId, createdBy, {
      id: `tg_${randomUUID().replace(/-/g, '')}`,
      name,
      description,
    }, now)
  }

  const draft = writeDraftVersion(db, graph, definition, createdBy, now)
  db.prepare(
    `UPDATE task_graphs SET draft_version_id = ?, status = 'draft', updated_at = ?
      WHERE id = ? AND company_id = ?`,
  ).run(draft.id, now, graph.id, companyId)
  return getTaskGraph(db, companyId, graph.id)
}

export function publishTaskGraph(
  db: Db,
  companyId: string,
  createdBy: string,
  id: string,
  definitionInput?: unknown,
): TaskGraphView {
  const graph = getGraphRow(db, companyId, id)
  const now = Date.now()
  let draft = readVersion(db, graph.draft_version_id, companyId)

  if (definitionInput !== undefined) {
    const definition = normalizeDefinition(definitionInput)
    const created = writeDraftVersion(db, graph, definition, createdBy, now)
    const row = readVersion(db, created.id, companyId)
    if (!row) throw new EabError(EC.INTERNAL, '任务图草稿写入失败')
    draft = row
    db.prepare(`UPDATE task_graphs SET draft_version_id = ?, status = 'draft', updated_at = ?
      WHERE id = ? AND company_id = ?`).run(draft.id, now, graph.id, companyId)
  } else if (!draft) {
    throw new EabError(EC.VALIDATION, '任务图还没有保存草稿')
  }
  if (!draft) throw new EabError(EC.INTERNAL, '任务图草稿不存在')

  const definition = definitionOf(draft)
  const validation = validateTaskGraph(definition)
  if (!validation.valid) {
    db.prepare(`UPDATE task_graph_versions SET validation_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(validation.errors), now, draft.id)
    throw new EabError(EC.VALIDATION, `任务图校验未通过：${validation.errors.join('；')}`)
  }

  const previous = readVersion(db, graph.published_version_id, companyId)
  if (previous && previous.id !== draft.id) {
    db.prepare(`UPDATE task_graph_versions SET status = 'superseded', updated_at = ? WHERE id = ?`)
      .run(now, previous.id)
  }
  db.prepare(
    `UPDATE task_graph_versions
        SET status = 'published', validation_json = ?, published_at = ?, updated_at = ?
      WHERE id = ?`,
  ).run(JSON.stringify(validation.errors), now, now, draft.id)
  db.prepare(
    `UPDATE task_graphs
        SET status = 'published', current_version = ?, draft_version_id = NULL,
            published_version_id = ?, updated_at = ?
      WHERE id = ? AND company_id = ?`,
  ).run(Number(draft.version), draft.id, now, graph.id, companyId)
  return getTaskGraph(db, companyId, graph.id)
}

export function deleteTaskGraph(db: Db, companyId: string, id: string): { id: string; name: string } {
  const graph = getGraphRow(db, companyId, id)
  const now = Date.now()
  db.prepare(
    `UPDATE task_graphs SET status = 'disabled', deleted_at = ?, updated_at = ?
      WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
  ).run(now, now, graph.id, companyId)
  return { id: graph.id, name: graph.name }
}

function ruleMatches(rule: TaskGraphEdgeRule, variables: Record<string, unknown>): boolean {
  if (rule.else) return true
  const actual = getPath(variables, String(rule.field ?? ''))
  const expected = rule.value
  switch (rule.op ?? 'truthy') {
    case 'eq':
      return actual === expected || String(actual ?? '') === String(expected ?? '')
    case 'neq':
      return actual !== expected && String(actual ?? '') !== String(expected ?? '')
    case 'contains':
      return Array.isArray(actual)
        ? actual.includes(expected)
        : String(actual ?? '').includes(String(expected ?? ''))
    case 'gt':
      return Number(actual) > Number(expected)
    case 'gte':
      return Number(actual) >= Number(expected)
    case 'lt':
      return Number(actual) < Number(expected)
    case 'lte':
      return Number(actual) <= Number(expected)
    case 'exists':
      return actual !== undefined && actual !== null
    case 'empty':
      return actual === undefined || actual === null || actual === '' || (Array.isArray(actual) && actual.length === 0)
    case 'truthy':
    default:
      return Boolean(actual)
  }
}

function getPath(source: unknown, path: string): unknown {
  if (!path) return undefined
  return path
    .split('.')
    .filter(Boolean)
    .reduce<unknown>((value, key) => {
      if (value === null || value === undefined) return undefined
      if (Array.isArray(value)) {
        const index = Number(key)
        return Number.isInteger(index) ? value[index] : undefined
      }
      if (typeof value === 'object') return (value as Record<string, unknown>)[key]
      return undefined
    }, source)
}

function resolveTemplate(value: unknown, variables: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const exact = value.match(/^\{\{\s*([^}]+?)\s*\}\}$/)
    if (exact) return getPath(variables, exact[1].trim())
    return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, path: string) => {
      const resolved = getPath(variables, path.trim())
      return resolved === undefined || resolved === null ? '' : String(resolved)
    })
  }
  if (Array.isArray(value)) return value.map((item) => resolveTemplate(item, variables))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = resolveTemplate(item, variables)
    }
    return out
  }
  return value
}

function nextFor(node: TaskGraphNode, variables: Record<string, unknown>): string | null {
  const targets = outgoingOf(node)
  if (node.kind === 'end') return null
  if (node.kind === 'condition') {
    const rules = node.edgeRules ?? {}
    const direct = targets.find((target) => {
      const rule = rules[target]
      return rule && !rule.else && ruleMatches(rule, variables)
    })
    if (direct) return direct
    const fallback = targets.find((target) => rules[target]?.else)
    if (fallback) return fallback
    throw new EabError(EC.VALIDATION, `条件节点 ${node.id} 没有命中任何分支`)
  }
  return targets[0] ?? null
}

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`
}

function withRunLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  const previous = runLocks.get(runId) ?? Promise.resolve()
  let release: () => void = () => {}
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const stored = previous.then(() => current)
  runLocks.set(runId, stored)
  return previous.then(async () => {
    try {
      return await fn()
    } finally {
      release()
      if (runLocks.get(runId) === stored) runLocks.delete(runId)
    }
  })
}

function claimRun(
  db: Db,
  companyId: string,
  runId: string,
  expectedStatus: TaskGraphRunStatus,
  owner: string,
  now: number,
): RunRow | null {
  const result = db
    .prepare(
      `UPDATE task_graph_runs
          SET status = 'running', lease_owner = ?, lease_until = ?, cancel_requested_at = NULL,
              updated_at = ?
        WHERE id = ? AND company_id = ? AND status = ?`,
    )
    .run(owner, now + RUN_LEASE_MS, now, runId, companyId, expectedStatus)
  if (Number(result.changes) === 0) return null
  return runRow(db, companyId, runId)
}

/** 续租并检查取消标记；返回 false 表示当前实例已失去该运行的执行权。 */
function heartbeatRun(db: Db, run: RunRow, owner: string, now: number): boolean {
  const current = runRow(db, run.company_id, run.id)
  if (current.status !== 'running' || current.cancel_requested_at !== null) return false
  if (current.lease_owner !== owner) return false
  const result = db
    .prepare(
      `UPDATE task_graph_runs SET lease_until = ?, updated_at = ?
        WHERE id = ? AND company_id = ? AND lease_owner = ? AND status = 'running'
          AND cancel_requested_at IS NULL`,
    )
    .run(now + RUN_LEASE_MS, now, run.id, run.company_id, owner)
  return Number(result.changes) > 0
}

function assertRunActive(db: Db, run: RunRow, owner: string): void {
  const current = runRow(db, run.company_id, run.id)
  if (current.status !== 'running') {
    throw new TaskGraphRunInterrupted(
      current.status === 'cancelled' ? '任务图运行已取消' : '任务图运行已不在执行状态',
    )
  }
  if (current.cancel_requested_at !== null) throw new TaskGraphRunInterrupted('任务图运行已取消')
  if (current.lease_owner !== owner) throw new TaskGraphRunInterrupted('任务图运行租约已被其他实例接管')
  if (Number(current.lease_until ?? 0) < Date.now()) {
    throw new TaskGraphRunInterrupted('任务图运行租约已过期')
  }
}

function startRunHeartbeat(
  db: Db,
  run: RunRow,
  owner: string,
  controller: AbortController,
): () => void {
  const timer = setInterval(() => {
    try {
      if (!heartbeatRun(db, run, owner, Date.now())) {
        controller.abort(new TaskGraphRunInterrupted('任务图运行已取消或租约丢失'))
      }
    } catch {
      // 心跳失败不直接中止：数据库短暂锁冲突不应该误杀正在执行的节点。
    }
  }, RUN_HEARTBEAT_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}

function runRow(db: Db, companyId: string, runId: string): RunRow {
  const row = db
    .prepare(
      `SELECT ${runColumns()}
         FROM task_graph_runs WHERE id = ? AND company_id = ? LIMIT 1`,
    )
    .get(runId, companyId) as RunRow | undefined
  if (!row) throw new EabError(EC.NOT_FOUND, '任务图运行不存在')
  return row
}

function stepRows(db: Db, runId: string): StepRow[] {
  return db
    .prepare(
      `SELECT id, run_id, seq, node_id, node_kind, title, status, input_json, output_json,
              error, started_at, finished_at, duration_ms
         FROM task_graph_steps WHERE run_id = ? ORDER BY seq ASC`,
    )
    .all(runId) as unknown as StepRow[]
}

function stepView(row: StepRow): TaskGraphStepView {
  return {
    seq: Number(row.seq),
    nodeId: row.node_id,
    nodeKind: row.node_kind as TaskGraphNodeKind,
    title: row.title,
    status: row.status,
    input: parseJson(row.input_json, null),
    output: parseJson(row.output_json, null),
    error: row.error,
    startedAt: Number(row.started_at),
    finishedAt: row.finished_at === null ? null : Number(row.finished_at),
    durationMs: Number(row.duration_ms) || 0,
  }
}

function runView(db: Db, row: RunRow): TaskGraphRunView {
  const graphRow = db
    .prepare(`SELECT name FROM task_graphs WHERE id = ? AND company_id = ? LIMIT 1`)
    .get(row.graph_id, row.company_id) as { name: string } | undefined
  return {
    id: row.id,
    traceId: row.trace_id,
    graphId: row.graph_id,
    graphName: graphRow?.name ?? '',
    graphVersion: Number(row.graph_version),
    definition: definitionOf(readVersion(db, row.version_id, row.company_id)),
    status: row.status as TaskGraphRunStatus,
    userId: row.user_id,
    input: parseJson(row.input_json, {}),
    variables: parseJson(row.variables_json, {}),
    currentNodeId: row.current_node_id,
    waiting: parseJson(row.waiting_json, null),
    error: row.error,
    startedAt: Number(row.started_at),
    finishedAt: row.finished_at === null ? null : Number(row.finished_at),
    steps: stepRows(db, row.id).map(stepView),
  }
}

function updateRun(
  db: Db,
  run: RunRow,
  patch: Partial<{
    status: TaskGraphRunStatus
    current_node_id: string | null
    variables_json: string
    waiting_json: string | null
    error: string | null
    finished_at: number | null
    lease_owner: string | null
    lease_until: number | null
    cancel_requested_at: number | null
  }>,
  now: number,
): void {
  const fields: string[] = []
  const values: Array<string | number | null> = []
  for (const [key, value] of Object.entries(patch)) {
    fields.push(`${key} = ?`)
    values.push(value as string | number | null)
  }
  fields.push('updated_at = ?')
  values.push(now, run.id, run.company_id)
  db.prepare(
    `UPDATE task_graph_runs SET ${fields.join(', ')}
      WHERE id = ? AND company_id = ?
        AND status NOT IN ('succeeded', 'failed', 'rejected', 'cancelled')`,
  ).run(...values)
}

function finishRun(
  db: Db,
  run: RunRow,
  status: TaskGraphRunStatus,
  error: string | null,
  now: number,
): void {
  updateRun(db, run, {
    status,
    current_node_id: run.current_node_id,
    waiting_json: null,
    error,
    finished_at: now,
    lease_owner: null,
    lease_until: null,
  }, now)
}

function lastStepSeq(db: Db, runId: string): number {
  const row = db.prepare(`SELECT COALESCE(MAX(seq), 0) AS seq FROM task_graph_steps WHERE run_id = ?`)
    .get(runId) as { seq: number }
  return Number(row?.seq) || 0
}

function insertStep(
  db: Db,
  run: RunRow,
  node: TaskGraphNode,
  status: string,
  input: unknown,
  now: number,
): { id: string; seq: number } {
  const seq = lastStepSeq(db, run.id) + 1
  const id = newId('tgs')
  db.prepare(
    `INSERT INTO task_graph_steps
       (id, run_id, seq, node_id, node_kind, title, status, input_json, output_json,
        error, started_at, finished_at, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, 0)`,
  ).run(
    id,
    run.id,
    seq,
    node.id,
    node.kind,
    node.title,
    status,
    input === undefined ? null : jsonStored(input),
    now,
  )
  return { id, seq }
}

function finishStep(
  db: Db,
  stepId: string,
  status: string,
  output: unknown,
  error: string | null,
  startedAt: number,
  now: number,
): void {
  db.prepare(
    `UPDATE task_graph_steps
        SET status = ?, output_json = ?, error = ?, finished_at = ?, duration_ms = ?
      WHERE id = ? AND status IN ('running', 'waiting')`,
  ).run(status, output === undefined ? null : jsonStored(output), error, now, Math.max(0, now - startedAt), stepId)
}

async function advanceRun(
  db: Db,
  run: RunRow,
  executor: TaskGraphExecutor,
  owner: string,
): Promise<TaskGraphRunView> {
  const controller = new AbortController()
  activeRunControllers.set(run.id, controller)
  const stopHeartbeat = startRunHeartbeat(db, run, owner, controller)
  try {
    return await advanceRunLoop(db, run, executor, owner, controller.signal)
  } catch (error) {
    if (isRunInterrupted(error)) {
      return runView(db, runRow(db, run.company_id, run.id))
    }
    const message = (error as Error).message || '任务图执行失败'
    try {
      finishRun(db, runRow(db, run.company_id, run.id), 'failed', message, Date.now())
    } catch {
      // 运行行已经不存在时不做二次覆盖。
    }
    return runView(db, runRow(db, run.company_id, run.id))
  } finally {
    stopHeartbeat()
    if (activeRunControllers.get(run.id) === controller) activeRunControllers.delete(run.id)
  }
}

async function advanceRunLoop(
  db: Db,
  run: RunRow,
  executor: TaskGraphExecutor,
  owner: string,
  signal: AbortSignal,
): Promise<TaskGraphRunView> {
  let current = run
  let variables = parseJson<Record<string, unknown>>(current.variables_json, {})
  let guard = 0

  while (current.status === 'running') {
    assertRunActive(db, current, owner)
    guard += 1
    if (guard > MAX_STEPS_PER_ADVANCE) {
      finishRun(db, current, 'failed', '任务图单次执行超过 200 步，已停止', Date.now())
      return runView(db, runRow(db, current.company_id, current.id))
    }
    const version = readVersion(db, current.version_id, current.company_id)
    if (!version) {
      finishRun(db, current, 'failed', '任务图版本不存在', Date.now())
      return runView(db, runRow(db, current.company_id, current.id))
    }
    const definition = definitionOf(version)
    const node = definition.nodes.find((item) => String(item.id) === String(current.current_node_id))
    if (!node || !NODE_KINDS.has(node.kind)) {
      finishRun(db, current, 'failed', `当前节点不存在：${current.current_node_id}`, Date.now())
      return runView(db, runRow(db, current.company_id, current.id))
    }
    const now = Date.now()

    if (node.kind === 'start') {
      const step = insertStep(db, current, node, 'running', {}, now)
      finishStep(db, step.id, 'succeeded', {}, null, now, Date.now())
      const next = nextFor(node, variables)
      if (!next) {
        finishRun(db, current, 'failed', '开始节点没有出线', Date.now())
        return runView(db, runRow(db, current.company_id, current.id))
      }
      updateRun(db, current, { current_node_id: next }, now)
      current = runRow(db, current.company_id, current.id)
      continue
    }

    if (node.kind === 'end') {
      const step = insertStep(db, current, node, 'running', {}, now)
      finishStep(db, step.id, 'succeeded', { completed: true }, null, now, Date.now())
      finishRun(db, current, 'succeeded', null, now)
      return runView(db, runRow(db, current.company_id, current.id))
    }

    if (node.kind === 'condition') {
      const step = insertStep(db, current, node, 'running', { variables: variables.nodes ?? {} }, now)
      try {
        const next = nextFor(node, variables)
        finishStep(db, step.id, 'succeeded', { matchedNext: next }, null, now, Date.now())
        updateRun(db, current, { current_node_id: next }, now)
        current = runRow(db, current.company_id, current.id)
        continue
      } catch (error) {
        finishStep(db, step.id, 'failed', null, (error as Error).message, now, Date.now())
        finishRun(db, current, 'failed', (error as Error).message, Date.now())
        return runView(db, runRow(db, current.company_id, current.id))
      }
    }

    if (node.kind === 'manual') {
      const resume = node.manual ?? {}
      const waiting = {
        kind: 'manual',
        nodeId: node.id,
        title: node.title,
        instructions: String(resume.instructions ?? ''),
        assigneeRole: String(resume.assigneeRole ?? ''),
        since: now,
        timeoutHours: Number(resume.timeoutHours ?? 0) || null,
      }
      const step = insertStep(db, current, node, 'waiting', waiting, now)
      updateRun(db, current, {
        status: 'waiting_manual',
        current_node_id: node.id,
        waiting_json: JSON.stringify(waiting),
        variables_json: jsonStored(variables),
        lease_owner: null,
        lease_until: null,
      }, now)
      void step
      return runView(db, runRow(db, current.company_id, current.id))
    }

    if (node.kind === 'wait') {
      const seconds = Math.max(1, Number(node.wait?.durationSec ?? 60) || 60)
      const resumeAt = now + seconds * 1000
      const waiting = { kind: 'wait', nodeId: node.id, title: node.title, since: now, resumeAt }
      const step = insertStep(db, current, node, 'waiting', waiting, now)
      updateRun(db, current, {
        status: 'waiting_wait',
        current_node_id: node.id,
        waiting_json: JSON.stringify(waiting),
        variables_json: jsonStored(variables),
        lease_owner: null,
        lease_until: null,
      }, now)
      void step
      return runView(db, runRow(db, current.company_id, current.id))
    }

    if (node.kind === 'tool') {
      const args = resolveTemplate(node.args ?? {}, variables) as Record<string, unknown>
      const step = insertStep(db, current, node, 'running', { tool: node.tool, args }, now)
      try {
        const output = await executor.runTool({
          nodeId: node.id,
          tool: String(node.tool),
          args,
          traceId: current.trace_id,
          signal,
        })
        assertRunActive(db, current, owner)
        variables = { ...variables, nodes: { ...(variables.nodes as Record<string, unknown> ?? {}), [node.id]: output } }
        finishStep(db, step.id, 'succeeded', output, null, now, Date.now())
        const next = nextFor(node, variables)
        if (!next) {
          finishRun(db, current, 'failed', `节点 ${node.id} 没有出线`, Date.now())
          return runView(db, runRow(db, current.company_id, current.id))
        }
        updateRun(db, current, { current_node_id: next, variables_json: jsonStored(variables) }, Date.now())
        current = runRow(db, current.company_id, current.id)
        continue
      } catch (error) {
        if (isRunInterrupted(error)) {
          finishStep(db, step.id, 'cancelled', null, '任务图运行已取消', now, Date.now())
          return runView(db, runRow(db, current.company_id, current.id))
        }
        const message = (error as Error).message || '工具执行失败'
        finishStep(db, step.id, 'failed', null, message, now, Date.now())
        finishRun(db, current, 'failed', message, Date.now())
        return runView(db, runRow(db, current.company_id, current.id))
      }
    }

    if (node.kind === 'agent') {
      const prompt = String(resolveTemplate(node.agent?.prompt ?? '', variables))
      const modelId = String(node.agent?.modelId ?? '')
      const step = insertStep(db, current, node, 'running', { modelId, prompt }, now)
      try {
        const output = await executor.runAgent({
          nodeId: node.id,
          modelId,
          prompt,
          maxRounds: Math.max(1, Math.min(20, Number(node.agent?.maxRounds ?? 4) || 4)),
          traceId: current.trace_id,
          signal,
        })
        assertRunActive(db, current, owner)
        const stored = { text: output.text, runId: output.runId ?? null }
        variables = { ...variables, nodes: { ...(variables.nodes as Record<string, unknown> ?? {}), [node.id]: stored } }
        finishStep(db, step.id, 'succeeded', stored, null, now, Date.now())
        const next = nextFor(node, variables)
        if (!next) {
          finishRun(db, current, 'failed', `节点 ${node.id} 没有出线`, Date.now())
          return runView(db, runRow(db, current.company_id, current.id))
        }
        updateRun(db, current, { current_node_id: next, variables_json: jsonStored(variables) }, Date.now())
        current = runRow(db, current.company_id, current.id)
        continue
      } catch (error) {
        if (isRunInterrupted(error)) {
          finishStep(db, step.id, 'cancelled', null, '任务图运行已取消', now, Date.now())
          return runView(db, runRow(db, current.company_id, current.id))
        }
        const message = (error as Error).message || '子 Agent 执行失败'
        finishStep(db, step.id, 'failed', null, message, now, Date.now())
        finishRun(db, current, 'failed', message, Date.now())
        return runView(db, runRow(db, current.company_id, current.id))
      }
    }

    finishRun(db, current, 'failed', `不支持的节点类型：${node.kind}`, now)
    return runView(db, runRow(db, current.company_id, current.id))
  }

  return runView(db, runRow(db, current.company_id, current.id))
}

export function createTaskGraphRun(
  db: Db,
  companyId: string,
  actorUserId: string,
  graphId: string,
  input: Record<string, unknown>,
): TaskGraphRunView {
  const graph = getGraphRow(db, companyId, graphId)
  if (!graph.published_version_id || graph.status === 'disabled') {
    throw new EabError(EC.VALIDATION, '任务图还没有发布，不能运行')
  }
  const version = readVersion(db, graph.published_version_id, companyId)
  if (!version) throw new EabError(EC.NOT_FOUND, '任务图发布版本不存在')
  const definition = definitionOf(version)
  const validation = validateTaskGraph(definition)
  if (!validation.valid) throw new EabError(EC.VALIDATION, `任务图校验未通过：${validation.errors.join('；')}`)
  const now = Date.now()
  const runId = newId('tgr')
  const traceId = newId('trace')
  const owner = PROCESS_LEASE_ID
  db.prepare(
    `INSERT INTO task_graph_runs
       (id, trace_id, company_id, graph_id, graph_version, version_id, user_id, status,
        input_json, variables_json, current_node_id, waiting_json, error,
        started_at, finished_at, created_at, updated_at,
        lease_owner, lease_until, cancel_requested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, NULL, NULL, ?, NULL, ?, ?, ?, ?, NULL)`,
  ).run(
    runId,
    traceId,
    companyId,
    graph.id,
    Number(version.version),
    version.id,
    actorUserId,
    jsonStored(input),
    jsonStored({ input, nodes: {}, meta: { runId, traceId, graphId, graphVersion: Number(version.version) } }),
    definition.entry,
    now,
    now,
    now,
    owner,
    now + RUN_LEASE_MS,
  )
  return runView(db, runRow(db, companyId, runId))
}

export async function runTaskGraphRun(
  db: Db,
  companyId: string,
  runId: string,
  executor: TaskGraphExecutor,
): Promise<TaskGraphRunView> {
  return withRunLock(runId, async () => {
    const row = runRow(db, companyId, runId)
    if (row.status !== 'running') return runView(db, row)
    const owner = row.lease_owner ?? PROCESS_LEASE_ID
    return advanceRun(db, row, executor, owner)
  })
}

export async function startTaskGraphRun(
  db: Db,
  companyId: string,
  actorUserId: string,
  graphId: string,
  input: Record<string, unknown>,
  executor: TaskGraphExecutor,
): Promise<TaskGraphRunView> {
  const created = createTaskGraphRun(db, companyId, actorUserId, graphId, input)
  return runTaskGraphRun(db, companyId, created.id, executor)
}

export async function decideTaskGraphManual(
  db: Db,
  companyId: string,
  runId: string,
  decision: 'approved' | 'rejected',
  note: string,
  executor: TaskGraphExecutor,
  deciderRoles?: readonly string[],
  deferAdvance = false,
): Promise<TaskGraphRunView> {
  return withRunLock(runId, async () => {
    let run = runRow(db, companyId, runId)
    if (run.status !== 'waiting_manual') throw new EabError(EC.CONFLICT, '当前运行不在人工节点')
    const version = readVersion(db, run.version_id, companyId)
    if (!version) throw new EabError(EC.NOT_FOUND, '任务图版本不存在')
    const definition = definitionOf(version)
    const node = definition.nodes.find((item) => String(item.id) === String(run.current_node_id))
    if (!node || node.kind !== 'manual') throw new EabError(EC.CONFLICT, '当前节点不是人工节点')
    const requiredRole = String(node.manual?.assigneeRole ?? '').trim()
    if (
      requiredRole &&
      deciderRoles &&
      !deciderRoles.includes(requiredRole) &&
      !deciderRoles.includes('super_admin')
    ) {
      throw new EabError(EC.FORBIDDEN, `当前人工节点只允许角色「${requiredRole}」处理`)
    }
    const now = Date.now()
    const owner = PROCESS_LEASE_ID
    const claimed = claimRun(db, companyId, runId, 'waiting_manual', owner, now)
    if (!claimed) throw new EabError(EC.CONFLICT, '人工节点已被其他实例处理')
    run = claimed
    const steps = stepRows(db, run.id)
    const last = steps[steps.length - 1]
    if (last && last.status === 'waiting') {
      finishStep(
        db,
        last.id,
        decision === 'approved' ? 'succeeded' : 'rejected',
        { decision, note: note.slice(0, 500) },
        null,
        Number(last.started_at),
        now,
      )
    }
    if (decision === 'rejected') {
      const target = String(node.manual?.rejectNextId ?? '').trim()
      if (target) {
        updateRun(db, run, {
          status: 'running',
          current_node_id: target,
          waiting_json: null,
          variables_json: jsonStored({
            ...parseJson<Record<string, unknown>>(run.variables_json, {}),
            manual: { decision, note: note.slice(0, 500) },
          }),
        }, now)
        const nextRun = runRow(db, companyId, run.id)
        return deferAdvance ? runView(db, nextRun) : advanceRun(db, nextRun, executor, owner)
      }
      updateRun(db, run, {
        status: 'rejected',
        waiting_json: null,
        error: note ? `人工拒绝：${note.slice(0, 200)}` : '人工拒绝',
        finished_at: now,
        lease_owner: null,
        lease_until: null,
      }, now)
      return runView(db, runRow(db, companyId, run.id))
    }
    const variables = {
      ...parseJson<Record<string, unknown>>(run.variables_json, {}),
      manual: { decision, note: note.slice(0, 500) },
    }
    const next = nextFor(node, variables)
    if (!next) {
      updateRun(db, run, {
        status: 'failed',
        waiting_json: null,
        error: `人工节点 ${node.id} 没有通过出线`,
        finished_at: now,
        lease_owner: null,
        lease_until: null,
      }, now)
      return runView(db, runRow(db, companyId, run.id))
    }
    updateRun(db, run, {
      status: 'running',
      current_node_id: next,
      waiting_json: null,
      variables_json: jsonStored(variables),
    }, now)
    const nextRun = runRow(db, companyId, run.id)
    return deferAdvance ? runView(db, nextRun) : advanceRun(db, nextRun, executor, owner)
  })
}

export async function resumeDueTaskGraphRuns(
  db: Db,
  companyId: string,
  executorProvider: TaskGraphExecutorProvider,
  now = Date.now(),
): Promise<number> {
  const rows = db
    .prepare(
      `SELECT ${runColumns()}
         FROM task_graph_runs
        WHERE company_id = ? AND status = 'waiting_wait'
        ORDER BY updated_at ASC LIMIT 20`,
    )
    .all(companyId) as unknown as RunRow[]
  let resumed = 0
  for (const row of rows) {
    const waiting = parseJson<Record<string, unknown>>(row.waiting_json, {})
    const resumeAt = Number(waiting.resumeAt ?? 0)
    if (!resumeAt || resumeAt > now) continue
    await withRunLock(row.id, async () => {
      let current = runRow(db, row.company_id, row.id)
      if (current.status !== 'waiting_wait') return
      const owner = PROCESS_LEASE_ID
      const claimed = claimRun(db, row.company_id, row.id, 'waiting_wait', owner, now)
      if (!claimed) return
      current = claimed
      const executor =
        typeof executorProvider === 'function'
          ? executorProvider({ id: current.id, userId: current.user_id, graphId: current.graph_id })
          : executorProvider
      const steps = stepRows(db, current.id)
      const last = steps[steps.length - 1]
      if (last && last.status === 'waiting') {
        finishStep(db, last.id, 'succeeded', { resumedAt: now }, null, Number(last.started_at), now)
      }
      const version = readVersion(db, current.version_id, current.company_id)
      if (!version) {
        finishRun(db, current, 'failed', '任务图版本不存在', now)
        return
      }
      const definition = definitionOf(version)
      const node = definition.nodes.find((item) => String(item.id) === String(current.current_node_id))
      if (!node) {
        finishRun(db, current, 'failed', '等待节点不存在', now)
        return
      }
      const next = nextFor(node, parseJson<Record<string, unknown>>(current.variables_json, {}))
      if (!next) {
        finishRun(db, current, 'failed', `等待节点 ${node.id} 没有出线`, now)
        return
      }
      updateRun(db, current, { status: 'running', current_node_id: next, waiting_json: null }, now)
      await advanceRun(db, runRow(db, current.company_id, current.id), executor, owner)
      resumed += 1
    })
  }
  return resumed
}

export function cancelTaskGraphRun(db: Db, companyId: string, runId: string): TaskGraphRunView {
  const run = runRow(db, companyId, runId)
  if (TERMINAL.has(run.status as TaskGraphRunStatus)) {
    throw new EabError(EC.CONFLICT, '任务图运行已结束，不能取消')
  }
  const now = Date.now()
  db.prepare(
    `UPDATE task_graph_steps
        SET status = 'cancelled', error = '人工取消', finished_at = ?, duration_ms = ?
      WHERE run_id = ? AND status IN ('running', 'waiting')`,
  ).run(now, Math.max(0, now - Number(run.started_at)), run.id)
  updateRun(db, run, {
    status: 'cancelled',
    waiting_json: null,
    error: '人工取消',
    finished_at: now,
    lease_owner: null,
    lease_until: null,
    cancel_requested_at: now,
  }, now)
  // 先落库再中止，避免正在 await 的节点在状态写入前抢先完成。
  activeRunControllers.get(run.id)?.abort(new TaskGraphRunInterrupted('任务图运行已取消'))
  return runView(db, runRow(db, companyId, run.id))
}

/**
 * 回收进程崩溃后遗留的 running 运行。
 *
 * 这里不重试节点：工具可能已经产生副作用，盲目重放会重复写文件/发消息。
 * 只把租约过期的运行标记失败，保留已有 append-only 步骤供审计。
 */
export function recoverStaleTaskGraphRuns(
  db: Db,
  companyId: string,
  now = Date.now(),
): number {
  const rows = db
    .prepare(
      `SELECT ${runColumns()}
         FROM task_graph_runs
        WHERE company_id = ? AND status = 'running'
          AND ((lease_until IS NOT NULL AND lease_until < ?)
            OR (lease_until IS NULL AND updated_at < ?))
        ORDER BY updated_at ASC LIMIT 20`,
    )
    .all(companyId, now, now - RUN_LEASE_MS * 4) as unknown as RunRow[]
  let recovered = 0
  for (const row of rows) {
    const cancelled = row.cancel_requested_at !== null
    db.prepare(
      `UPDATE task_graph_steps
          SET status = ?, error = ?, finished_at = ?, duration_ms = ?
        WHERE run_id = ? AND status IN ('running', 'waiting')`,
    ).run(
      cancelled ? 'cancelled' : 'failed',
      cancelled ? '人工取消' : '执行进程中断，租约已过期',
      now,
      Math.max(0, now - Number(row.started_at)),
      row.id,
    )
    finishRun(
      db,
      row,
      cancelled ? 'cancelled' : 'failed',
      cancelled ? '人工取消' : '执行进程中断，租约已过期',
      now,
    )
    recovered += 1
  }
  return recovered
}

export function listTaskGraphRuns(
  db: Db,
  companyId: string,
  graphId?: string,
  limit = 30,
): TaskGraphRunView[] {
  const capped = Math.max(1, Math.min(100, Math.trunc(limit) || 30))
  const rows = graphId
    ? db
        .prepare(
          `SELECT ${runColumns()}
             FROM task_graph_runs WHERE company_id = ? AND graph_id = ?
            ORDER BY created_at DESC LIMIT ?`,
        )
        .all(companyId, graphId, capped)
    : db
        .prepare(
          `SELECT ${runColumns()}
             FROM task_graph_runs WHERE company_id = ?
            ORDER BY created_at DESC LIMIT ?`,
        )
        .all(companyId, capped)
  return (rows as unknown as RunRow[]).map((row) => runView(db, row))
}

export function getTaskGraphRun(db: Db, companyId: string, runId: string): TaskGraphRunView {
  return runView(db, runRow(db, companyId, runId))
}

export function getTaskGraphRunByTrace(db: Db, companyId: string, traceId: string): TaskGraphRunView {
  const row = db
    .prepare(
      `SELECT ${runColumns()}
         FROM task_graph_runs WHERE company_id = ? AND trace_id = ? LIMIT 1`,
    )
    .get(companyId, traceId) as RunRow | undefined
  if (!row) throw new EabError(EC.NOT_FOUND, `traceId 不存在：${traceId}`)
  return runView(db, row)
}

export function getTaskGraphDefinition(
  db: Db,
  companyId: string,
  graphId: string,
): TaskGraphDefinition {
  const graph = getGraphRow(db, companyId, graphId)
  const version = readVersion(db, graph.published_version_id ?? graph.draft_version_id, companyId)
  return definitionOf(version)
}
