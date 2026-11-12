/**
 * 网页对话的后台运行登记表。
 *
 * 模型回合不跟随某一条 HTTP/SSE 连接存活：页面切走、刷新或重新登录时，
 * 只要用户没有显式停止，Agent 仍在这里继续跑。页面重新连上后先从这里取
 * 已生成的正文/工具轨迹，再接 EventSource 的增量事件。
 */
import { publishChatEvent } from './chat-events.js'

export interface ChatRunToolTrace {
  id: string
  name: string
  toolId: string
  args: Record<string, unknown>
  status: 'running' | 'done' | 'error'
  summary: string
  durationMs: number
}

export interface ChatRunSnapshot {
  runId: string
  companyId: string
  userId: string
  sessionId: string
  messageId: string
  modelId: string
  modelName: string
  autoSelected: boolean
  startedAt: number
  status: 'running' | 'stopped' | 'error'
  reasoning: string
  text: string
  toolCalls: ChatRunToolTrace[]
  error: string | null
}

interface ActiveChatRun {
  snapshot: ChatRunSnapshot
  controller: AbortController
}

const activeRuns = new Map<string, ActiveChatRun>()

export function beginChatRun(input: {
  runId: string
  companyId: string
  userId: string
  sessionId: string
  messageId: string
  modelId: string
  modelName: string
  autoSelected: boolean
  controller: AbortController
}): ChatRunSnapshot {
  const { controller, ...fields } = input
  const snapshot: ChatRunSnapshot = {
    ...fields,
    startedAt: Date.now(),
    status: 'running',
    reasoning: '',
    text: '',
    toolCalls: [],
    error: null,
  }
  activeRuns.set(input.runId, { snapshot, controller })
  return snapshot
}

function runOf(runId: string): ActiveChatRun | undefined {
  return activeRuns.get(runId)
}

/** 把正文或思考增量同时记进快照并广播给同一员工的所有页面。 */
export function noteChatRunDelta(
  runId: string,
  kind: 'reasoning' | 'content',
  text: string,
): void {
  const run = runOf(runId)
  if (!run || !text) return
  if (kind === 'reasoning') run.snapshot.reasoning += text
  else run.snapshot.text += text
  publishChatEvent({
    type: 'delta',
    companyId: run.snapshot.companyId,
    userId: run.snapshot.userId,
    sessionId: run.snapshot.sessionId,
    messageId: run.snapshot.messageId,
    kind,
    text,
    modelId: run.snapshot.modelId,
    modelName: run.snapshot.modelName,
  })
}

export function noteChatRunTool(
  runId: string,
  event: { id: string; name: string; toolId: string; args: Record<string, unknown> },
): void {
  const run = runOf(runId)
  if (!run) return
  run.snapshot.toolCalls.push({ ...event, status: 'running', summary: '', durationMs: 0 })
  publishChatEvent({
    type: 'tool',
    companyId: run.snapshot.companyId,
    userId: run.snapshot.userId,
    sessionId: run.snapshot.sessionId,
    messageId: run.snapshot.messageId,
    tool: { type: 'tool', ...event },
  })
}

export function noteChatRunToolResult(
  runId: string,
  event: { id: string; status: 'done' | 'error'; summary: string; durationMs: number },
): void {
  const run = runOf(runId)
  if (!run) return
  const trace = run.snapshot.toolCalls.find((item) => item.id === event.id)
  if (trace) {
    trace.status = event.status
    trace.summary = event.summary
    trace.durationMs = event.durationMs
  }
  publishChatEvent({
    type: 'tool',
    companyId: run.snapshot.companyId,
    userId: run.snapshot.userId,
    sessionId: run.snapshot.sessionId,
    messageId: run.snapshot.messageId,
    tool: { type: 'tool_result', ...event },
  })
}

/** 运行结束（成功/失败/主动停止）后从可恢复列表移除；最终消息由调用方落库广播。 */
export function completeChatRun(runId: string): void {
  activeRuns.delete(runId)
}

export function finishChatRun(
  runId: string,
  status: 'stopped' | 'error',
  error: string | null = null,
): void {
  const run = runOf(runId)
  if (!run) return
  run.snapshot.status = status
  run.snapshot.error = error
  activeRuns.delete(runId)
}

export function cancelChatRun(
  runId: string,
  owner: { companyId: string; userId: string } | null = null,
): boolean {
  const run = runOf(runId)
  if (!run) return false
  if (
    owner &&
    (run.snapshot.companyId !== owner.companyId || run.snapshot.userId !== owner.userId)
  ) {
    return false
  }
  run.snapshot.status = 'stopped'
  run.snapshot.error = '用户停止了本轮回复'
  run.controller.abort()
  return true
}

/** 页面刷新/重新登录时读取仍在运行的回合，避免半截输出丢失。 */
export function activeChatRuns(companyId: string, userId: string): ChatRunSnapshot[] {
  return [...activeRuns.values()]
    .map((item) => item.snapshot)
    .filter(
      (snapshot) =>
        snapshot.status === 'running' &&
        snapshot.companyId === companyId &&
        snapshot.userId === userId,
    )
    .sort((a, b) => a.startedAt - b.startedAt)
}
