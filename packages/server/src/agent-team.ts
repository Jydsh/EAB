/**
 * 子 Agent 团队登记表（只存内存，不落库）。
 *
 * 语义对齐用户要的「经理 + 团队」：
 * - 父 Agent（经理）通过 agent_spawn 注册子 Agent（worker），每个 worker 有稳定的 key；
 * - 同一 key 再次派活复用同一个窗口与会话身份（childId 稳定），所以父子对话能接着上一轮；
 * - worker 完成一次任务后进入 idle；超过空闲期没有任何新任务，就视为已注销，
 *   父 Agent 再派活必须先 agent_spawn 重新注册，避免长期占着资源；
 * - 真正的执行资源（子 run、会话锁、模型调用）在子 run 结束时就已经释放，这里只管身份与可视窗口。
 */

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
  status: 'idle' | 'running' | 'waiting'
  runId: string
  modelId: string
  modelName: string
  lastTaskAt: number
  lastText: string
  /** 该子 Agent 的多轮对话上下文；同一 key 复用窗口时接着上一轮继续。 */
  messages: TeamMessage[]
}

const teams = new Map<string, Map<string, TeamWorker>>()

/** 默认空闲退休时间：2 分钟没有新任务就自动注销。 */
export const DEFAULT_WORKER_IDLE_MS = 120_000

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
  worker.messages.push({ role, content: text.slice(0, 4_000), at: now })
  // 只保留最近 20 条，避免长会话无限占内存；总字符数也封顶。
  while (worker.messages.length > 20) worker.messages.shift()
  let total = worker.messages.reduce((sum, message) => sum + message.content.length, 0)
  while (total > 16_000 && worker.messages.length > 2) {
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
  const workers = listWorkers(teamId)
  if (workers.length === 0) return ''
  const lines = workers.map((worker) => {
    const state = worker.status === 'running' ? '工作中' : worker.status === 'waiting' ? '等待父 Agent 回答' : '空闲'
    const last = worker.lastText
      ? `上次${worker.status === 'waiting' ? '提问' : '回报'}：${worker.lastText.replace(/\s+/g, ' ').slice(0, 160)}`
      : '还没有回报'
    return `- ${worker.key}（${worker.name}，${state}，${last}）`
  })
  return [
    '当前会话里已有子 Agent 团队，同一个 key 可以直接继续派活：',
    lines.join('\n'),
    '需要它们接着做事时调用 agent_task {agent:"key", prompt:"完整任务"}；已注销的 key 不能再用，要先用 agent_spawn 重新注册。',
    '如果某个子 Agent 处于「等待父 Agent 回答」，先判断你能不能直接答；需要用户补充信息或授权时，用 ask_user 问用户，拿到答复后必须用 agent_task 把答复发回该子 Agent，让它继续。',
  ].join('\n')
}
