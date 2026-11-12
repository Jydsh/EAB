import { describe, expect, it } from 'vitest'
import {
  activeChatRuns,
  beginChatRun,
  cancelChatRun,
  finishChatRun,
  noteChatRunDelta,
  noteChatRunTool,
  noteChatRunToolResult,
} from '../src/chat-runs.js'

function run(overrides: Partial<Parameters<typeof beginChatRun>[0]> = {}) {
  return beginChatRun({
    runId: `run_${Math.random().toString(36).slice(2)}`,
    companyId: 'c1',
    userId: 'u1',
    sessionId: 's1',
    messageId: `msg_${Math.random().toString(36).slice(2)}`,
    modelId: 'm1',
    modelName: '测试模型',
    autoSelected: false,
    controller: new AbortController(),
    ...overrides,
  })
}

describe('后台会话运行登记', () => {
  it('记录正文、思考、工具耗时，并按员工隔离', () => {
    const snapshot = run()
    noteChatRunDelta(snapshot.runId, 'reasoning', '先想')
    noteChatRunDelta(snapshot.runId, 'content', '再答')
    noteChatRunTool(snapshot.runId, { id: 't1', name: '查询', toolId: 'tool.x', args: { a: 1 } })
    noteChatRunToolResult(snapshot.runId, {
      id: 't1',
      status: 'done',
      summary: '20 条',
      durationMs: 1234,
    })

    const [active] = activeChatRuns('c1', 'u1')
    expect(active.reasoning).toBe('先想')
    expect(active.text).toBe('再答')
    expect(active.toolCalls[0].durationMs).toBe(1234)
    expect(activeChatRuns('c1', 'u2')).toHaveLength(0)
    finishChatRun(snapshot.runId, 'error')
  })

  it('主动取消会中止控制器；普通结束不会', () => {
    const controller = new AbortController()
    let aborted = false
    controller.signal.addEventListener('abort', () => {
      aborted = true
    })
    const active = beginChatRun({
      runId: `run_${Math.random().toString(36).slice(2)}`,
      companyId: 'c1',
      userId: 'u1',
      sessionId: 's1',
      messageId: `msg_${Math.random().toString(36).slice(2)}`,
      modelId: 'm1',
      modelName: '测试模型',
      autoSelected: false,
      controller,
    })
    expect(cancelChatRun(active.runId)).toBe(true)
    expect(aborted).toBe(true)
    finishChatRun(active.runId, 'stopped')
  })

  it('不能取消别人的后台回合', () => {
    const mine = run({ userId: 'u1' })
    const other = run({ userId: 'u2' })
    expect(cancelChatRun(other.runId, { companyId: 'c1', userId: 'u1' })).toBe(false)
    expect(cancelChatRun(other.runId, { companyId: 'c1', userId: 'u2' })).toBe(true)
    finishChatRun(mine.runId, 'stopped')
    finishChatRun(other.runId, 'stopped')
  })
})
