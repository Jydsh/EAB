/**
 * Agent 能力卡注册表。
 *
 * - 五张内置岗位卡是代码常量，不在每个公司重复落库；
 * - `agent_cards` 只存公司覆盖（同名 agentKey）和远端 A2A 卡；
 * - 主 Agent 编队时只看到技能摘要、工具 id 和限制，不拿完整工具 schema 或系统提示词；
 * - 运行时子 Agent 的卡按岗位和团队现场生成，不落库。
 */
import type { Db } from '@eab/storage'
import type { TaskBudget } from './agent-protocol.js'

export type AgentCardKind = 'builtin' | 'runtime' | 'a2a'
export type AgentCardHealth = 'healthy' | 'degraded' | 'offline' | 'unknown'
export type AgentCardSource = 'builtin' | 'company'

export interface AgentCardLimits {
  maxRounds?: number
  timeoutMs?: number
  maxTokens?: number
}

export interface AgentCard {
  id: string
  agentKey: string
  kind: AgentCardKind
  name: string
  version: string
  description: string
  skills: string[]
  tools: string[]
  limits: AgentCardLimits
  endpoint: Record<string, unknown>
  health: AgentCardHealth
  enabled: boolean
  source: AgentCardSource
  /** 公司行覆盖了同名内置卡时为 true，供管理端标「公司覆盖」 */
  overridden?: boolean
}

interface AgentCardRow {
  id: string
  company_id: string
  agent_key: string
  kind: string
  name: string
  version: string
  description: string
  skills_json: string | null
  tools_json: string | null
  limits_json: string | null
  endpoint_json: string | null
  health: string
  enabled: number
  created_at: number
  updated_at: number
}

const HEALTHS = new Set<AgentCardHealth>(['healthy', 'degraded', 'offline', 'unknown'])
const KINDS = new Set<AgentCardKind>(['builtin', 'runtime', 'a2a'])

/** 岗位顺序也是无技能命中时的默认优先级：检索 → 实现 → 验收 → 内容 → 通用。 */
export const AGENT_ROLE_PRIORITY: readonly string[] = ['researcher', 'builder', 'critic', 'producer', 'worker']

/**
 * 岗位卡的 tools 是运行时硬 allowlist，不再只是给模型看的摘要。
 * 每个岗位都必须显式登记协作工具和验证工具，避免“卡外能力”被 tool_search 重新捞回来。
 */
const BUILTIN_CARDS: readonly AgentCard[] = [
  {
    id: 'builtin:researcher',
    agentKey: 'researcher',
    kind: 'builtin',
    name: '检索员',
    version: '1',
    description: '负责资料检索、知识库核对、网页取证和竞品对比。',
    skills: ['资料检索', '知识库', '网页搜索', '竞品对比'],
    tools: ['tool.search', 'kb.search', 'web.search', 'web.fetch', 'workspace.list', 'workspace.read', 'workspace.search', 'agent.ask_parent', 'agent.publish_artifact'],
    limits: { maxRounds: 40, timeoutMs: 300_000, maxTokens: 120_000 },
    endpoint: { kind: 'internal' },
    health: 'healthy',
    enabled: true,
    source: 'builtin',
  },
  {
    id: 'builtin:builder',
    agentKey: 'builder',
    kind: 'builtin',
    name: '实现员',
    version: '1',
    description: '负责代码实现、文件写入、工程构建和接口联调。',
    skills: ['代码实现', '文件写入', '工程构建', '接口联调'],
    tools: [
      'workspace.list', 'workspace.read', 'workspace.search', 'workspace.write', 'workspace.edit', 'project.exec', 'project.job',
      'office.read_outline', 'agent.ask_parent', 'agent.publish_artifact',
    ],
    limits: { maxRounds: 120, timeoutMs: 1_800_000, maxTokens: 400_000 },
    endpoint: { kind: 'internal' },
    health: 'healthy',
    enabled: true,
    source: 'builtin',
  },
  {
    id: 'builtin:critic',
    agentKey: 'critic',
    kind: 'builtin',
    name: '验收员',
    version: '1',
    description: '负责测试、构建验证、代码审查和回归，不代替实现员写代码。',
    skills: ['测试', '构建验证', '代码审查', '回归'],
    tools: ['workspace.list', 'workspace.read', 'workspace.search', 'project.exec', 'project.job', 'office.read_outline', 'review.verdict'],
    limits: { maxRounds: 30, timeoutMs: 300_000, maxTokens: 150_000 },
    endpoint: { kind: 'internal' },
    health: 'healthy',
    enabled: true,
    source: 'builtin',
  },
  {
    id: 'builtin:producer',
    agentKey: 'producer',
    kind: 'builtin',
    name: '内容员',
    version: '1',
    description: '负责文档、表格、PPT 和汇总类交付。',
    skills: ['文档', '表格', 'PPT', '汇总'],
    tools: [
      'office.read_outline', 'office.find', 'office.replace', 'office.rewrite',
      'workspace.list', 'workspace.read', 'workspace.search', 'workspace.write', 'agent.ask_parent', 'agent.publish_artifact',
    ],
    limits: { maxRounds: 60, timeoutMs: 1_200_000, maxTokens: 200_000 },
    endpoint: { kind: 'internal' },
    health: 'healthy',
    enabled: true,
    source: 'builtin',
  },
  {
    id: 'builtin:worker',
    agentKey: 'worker',
    kind: 'builtin',
    name: '通用执行',
    version: '1',
    description: '负责单点任务和补充材料；需要写文件、跑命令时也走这条通用执行岗位。',
    skills: ['单点任务', '补充材料', '通用执行'],
    tools: [
      'tool.search', 'workspace.list', 'workspace.read', 'workspace.search', 'workspace.write', 'workspace.edit',
      'project.exec', 'project.job', 'office.read_outline', 'office.find', 'office.replace', 'office.rewrite',
      'agent.ask_parent', 'agent.publish_artifact',
    ],
    limits: { maxRounds: 80, timeoutMs: 1_200_000, maxTokens: 200_000 },
    endpoint: { kind: 'internal' },
    health: 'healthy',
    enabled: true,
    source: 'builtin',
  },
]

/** 返回副本，避免调用方改到模块常量。 */
export function builtinAgentCards(): AgentCard[] {
  return BUILTIN_CARDS.map((card) => ({
    ...card,
    skills: [...card.skills],
    tools: [...card.tools],
    limits: { ...card.limits },
    endpoint: { ...card.endpoint },
  }))
}

function jsonValue(value: string | null): unknown {
  if (!value) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function stringList(value: string | null): string[] {
  const parsed = jsonValue(value)
  if (!Array.isArray(parsed)) return []
  return [...new Set(parsed.map((item) => String(item ?? '').trim()).filter(Boolean))]
}

function positiveInt(value: unknown): number | undefined {
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(num) && num > 0 ? num : undefined
}

function parseLimits(value: string | null): AgentCardLimits {
  const parsed = jsonValue(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const record = parsed as Record<string, unknown>
  const limits: AgentCardLimits = {}
  const maxRounds = positiveInt(record.maxRounds)
  const timeoutMs = positiveInt(record.timeoutMs)
  const maxTokens = positiveInt(record.maxTokens)
  if (maxRounds !== undefined) limits.maxRounds = maxRounds
  if (timeoutMs !== undefined) limits.timeoutMs = timeoutMs
  if (maxTokens !== undefined) limits.maxTokens = maxTokens
  return limits
}

function parseEndpoint(value: string | null): Record<string, unknown> {
  const parsed = jsonValue(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'internal' }
  return parsed as Record<string, unknown>
}

function healthOf(value: string): AgentCardHealth {
  return HEALTHS.has(value as AgentCardHealth) ? (value as AgentCardHealth) : 'unknown'
}

function cardFromRow(row: AgentCardRow): AgentCard | null {
  const agentKey = String(row.agent_key ?? '').trim()
  if (!agentKey) return null
  const kind = KINDS.has(row.kind as AgentCardKind)
    ? (row.kind as AgentCardKind)
    : (row.kind === 'builtin' ? 'builtin' : 'a2a')
  return {
    id: row.id,
    agentKey,
    kind,
    name: String(row.name ?? '').trim() || agentKey,
    version: String(row.version ?? '').trim() || '1',
    description: String(row.description ?? '').trim(),
    skills: stringList(row.skills_json),
    tools: stringList(row.tools_json),
    limits: parseLimits(row.limits_json),
    endpoint: parseEndpoint(row.endpoint_json),
    health: healthOf(String(row.health ?? '')),
    enabled: Number(row.enabled) !== 0,
    source: 'company',
  }
}

/**
 * 合并内置卡与公司覆盖：
 * - 同 agentKey 的公司行覆盖内置卡的名称、技能、工具、限制和健康状态；
 * - `a2a` 行作为额外远端卡追加；
 * - 空字段回落到内置卡，避免一行只改名称就把技能清空。
 */
export function listAgentCards(db: Db, companyId: string): AgentCard[] {
  let rows: AgentCardRow[]
  try {
    rows = db
      .prepare('SELECT * FROM agent_cards WHERE company_id = ? ORDER BY updated_at DESC, agent_key ASC')
      .all(companyId) as unknown as AgentCardRow[]
  } catch (err) {
    if (/no such table: agent_cards/.test(err instanceof Error ? err.message : String(err))) rows = []
    else throw err
  }
  const companyCards = new Map<string, AgentCard>()
  const extra: AgentCard[] = []
  for (const row of rows) {
    const card = cardFromRow(row)
    if (!card) continue
    if (card.kind === 'a2a' || !AGENT_ROLE_PRIORITY.includes(card.agentKey)) {
      extra.push(card)
    } else {
      companyCards.set(card.agentKey, card)
    }
  }
  const merged = builtinAgentCards().map((base) => {
    const override = companyCards.get(base.agentKey)
    if (!override) return base
    return {
      ...base,
      id: override.id,
      name: override.name || base.name,
      version: override.version || base.version,
      description: override.description || base.description,
      skills: override.skills.length ? override.skills : base.skills,
      tools: override.tools.length ? override.tools : base.tools,
      limits: Object.keys(override.limits).length ? override.limits : base.limits,
      endpoint: Object.keys(override.endpoint).length ? override.endpoint : base.endpoint,
      health: override.health,
      enabled: override.enabled,
      source: 'company' as const,
      overridden: true,
    }
  })
  return [...merged, ...extra]
}

/** 主 Agent 编队用的紧凑摘要：只给技能、岗位名和工具 id，不给 schema。 */
export function agentCardBrief(cards: AgentCard[] = builtinAgentCards()): string {
  const usable = cards.filter((card) => card.kind !== 'a2a' && card.enabled && card.health !== 'offline')
  if (usable.length === 0) {
    return '【可用岗位能力卡】当前没有可用的内部岗位；内部编队只能由主 Agent 自己完成，已登记的远端 Agent 另见 A2A 清单。'
  }
  const lines = usable.map((card) => {
    const tools = card.tools.length ? card.tools.slice(0, 6).join(' / ') : '按任务动态下发'
    const more = card.tools.length > 6 ? ` 等 ${card.tools.length} 个` : ''
    return `- ${card.agentKey}（${card.name}）：${card.skills.join('、')}｜工具 ${tools}${more}`
  })
  return [
    '【可用岗位能力卡｜工具为运行时硬白名单，这里只展示前 6 个】',
    ...lines,
    '按技能匹配优先选岗；卡外工具不会下发给该岗位，也不能通过 tool_search 重新加载。offline 或已停用的岗位不要派。',
  ].join('\n')
}

export interface RuntimeAgentCardInput {
  teamId: string
  workerKey: string
  name?: string
  role?: string
  status?: string
  maxRounds?: number
  timeoutMs?: number
  maxTokens?: number
}

/** 子 Agent 启动时的运行时卡，不落库；只表达岗位、状态和限制。 */
export function runtimeAgentCard(input: RuntimeAgentCardInput): AgentCard {
  const role = String(input.role ?? '').trim() || 'worker'
  const status = String(input.status ?? '').trim()
  const limits: AgentCardLimits = {}
  if (positiveInt(input.maxRounds) !== undefined) limits.maxRounds = positiveInt(input.maxRounds)
  if (positiveInt(input.timeoutMs) !== undefined) limits.timeoutMs = positiveInt(input.timeoutMs)
  if (positiveInt(input.maxTokens) !== undefined) limits.maxTokens = positiveInt(input.maxTokens)
  return {
    id: `runtime:${input.teamId}:${input.workerKey}`,
    agentKey: role,
    kind: 'runtime',
    name: String(input.name ?? '').trim() || input.workerKey,
    version: '1',
    description: `${role} 运行时能力卡`,
    skills: [role],
    tools: [],
    limits,
    endpoint: { kind: 'internal', teamId: input.teamId, workerKey: input.workerKey },
    health: status === 'retired' ? 'offline' : 'healthy',
    enabled: status !== 'retired',
    source: 'builtin',
  }
}

export interface AgentTaskPolicy {
  role: string
  card: AgentCard
  /** 运行时硬 allowlist：不在集合内的工具不会出现在模型工具表里，也不能被 tool_search 重新加载。 */
  toolIds: string[]
  /** 岗位默认预算与任务显式预算合并后的硬限制。 */
  budget: TaskBudget
  /** 有 maxDurationMs 时才给出绝对截止时间，便于任务行和子 Agent 超时共用同一时刻。 */
  deadlineAt?: number
}

/**
 * 把一个岗位解析成可执行策略。
 *
 * 岗位卡的工具清单是唯一来源：这里不做“协议工具偷偷放行”，
 * 需要提问/登记产物的岗位必须自己在卡里登记 agent.ask_parent、agent.publish_artifact。
 */
export function resolveAgentTaskPolicy(
  cards: AgentCard[],
  role: string | undefined,
  requestedBudget?: TaskBudget,
  now: number = Date.now(),
): AgentTaskPolicy {
  const agentKey = String(role ?? '').trim() || 'worker'
  const card = cards.find((item) => item.kind !== 'a2a' && item.agentKey === agentKey)
  if (!card) throw new Error(`岗位 ${agentKey} 没有登记能力卡，不能派活`)
  if (!card.enabled || card.health === 'offline') {
    throw new Error(`岗位 ${agentKey}（${card.name}）当前不可用，不能派活`)
  }
  const toolIds = [...new Set(card.tools.map((id) => String(id ?? '').trim()).filter(Boolean))]
  if (toolIds.length === 0) throw new Error(`岗位 ${agentKey}（${card.name}）没有登记任何工具，不能派活`)
  // 任务显式预算只能收紧岗位卡，不能把上限调大；这是硬预算而不是建议值。
  const tighter = (cardLimit?: number, requested?: number): number | undefined => {
    if (cardLimit === undefined) return requested
    if (requested === undefined) return cardLimit
    return Math.min(cardLimit, requested)
  }
  const maxTokens = tighter(card.limits.maxTokens, requestedBudget?.maxTokens)
  const maxDurationMs = tighter(card.limits.timeoutMs, requestedBudget?.maxDurationMs)
  const maxRounds = tighter(card.limits.maxRounds, requestedBudget?.maxRounds)
  const budget: TaskBudget = {}
  if (maxTokens !== undefined) budget.maxTokens = maxTokens
  if (maxDurationMs !== undefined) budget.maxDurationMs = maxDurationMs
  if (maxRounds !== undefined) budget.maxRounds = maxRounds
  if (requestedBudget?.maxCostMicros !== undefined) budget.maxCostMicros = requestedBudget.maxCostMicros
  return {
    role: agentKey,
    card,
    toolIds,
    budget,
    deadlineAt: maxDurationMs === undefined ? undefined : now + maxDurationMs,
  }
}
