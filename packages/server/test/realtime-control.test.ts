import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase, migrate } from '@eab/storage'
import { beginChatRun, cancelChatRun } from '../src/chat-runs.js'
import { initRealtimeControl, requestCancelAgentRun, requestCancelChatRun } from '../src/realtime-control.js'
import type { PubSubBackend } from '../src/backends/pubsub.js'

class FakePubSub implements PubSubBackend {
  readonly id = 'fake'
  readonly shared = true
  readonly published: Array<{ channel: string; payload: string }> = []
  private readonly handlers = new Map<string, Set<(payload: string) => void>>()

  async publish(channel: string, payload: string): Promise<void> {
    this.published.push({ channel, payload })
  }

  async subscribe(channel: string, handler: (payload: string) => void): Promise<() => void> {
    let set = this.handlers.get(channel)
    if (!set) {
      set = new Set()
      this.handlers.set(channel, set)
    }
    set.add(handler)
    return () => set?.delete(handler)
  }

  deliverForTest(channel: string, payload: string): void {
    for (const handler of this.handlers.get(channel) ?? []) handler(payload)
  }
}

function memoryDb() {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  return db
}

afterEach(() => initRealtimeControl(null))

describe('跨实例控制指令', () => {
  it('其它实例发来的取消消息会真正打断本进程的对话运行', () => {
    const bridge = new FakePubSub()
    initRealtimeControl(bridge)
    const controller = new AbortController()
    beginChatRun({
      runId: 'run-x',
      companyId: 'c1',
      userId: 'u1',
      sessionId: 's1',
      messageId: 'm1',
      modelId: 'model-1',
      modelName: '模型一',
      autoSelected: false,
      controller,
    })

    bridge.deliverForTest(
      'control',
      JSON.stringify({ kind: 'cancel-chat-run', runId: 'run-x', companyId: 'c1', userId: 'u1' }),
    )
    expect(controller.signal.aborted).toBe(true)
    // 清理，避免影响其它用例
    cancelChatRun('run-x')
  })

  it('取消消息会把另一实例的 Agent 运行行标成 cancelled', () => {
    const db = memoryDb()
    const bridge = new FakePubSub()
    initRealtimeControl(bridge, db)
    db.prepare(
      `INSERT INTO agent_runs (id, company_id, user_id, agent_id, status, started_at, created_at)
       VALUES ('run-a', 'c1', 'u1', 'eab-main', 'running', ?, ?)`,
    ).run(Date.now(), Date.now())

    bridge.deliverForTest(
      'control',
      JSON.stringify({ kind: 'cancel-agent-run', runId: 'run-a', reason: '控制台取消了任务' }),
    )
    const row = db.prepare(`SELECT status, error FROM agent_runs WHERE id = 'run-a'`).get() as {
      status: string
      error: string | null
    }
    expect(row.status).toBe('cancelled')
    expect(row.error).toBe('控制台取消了任务')
  })

  it('没有 Redis 时请求返回 false，接入后返回 true 并发出消息', () => {
    expect(requestCancelChatRun('run-y', { companyId: 'c1', userId: 'u1' })).toBe(false)
    expect(requestCancelAgentRun('run-z')).toBe(false)

    const bridge = new FakePubSub()
    initRealtimeControl(bridge)
    expect(requestCancelChatRun('run-y', { companyId: 'c1', userId: 'u1' })).toBe(true)
    expect(requestCancelAgentRun('run-z')).toBe(true)
    expect(bridge.published).toHaveLength(2)
    expect(JSON.parse(bridge.published[0]!.payload)).toMatchObject({
      kind: 'cancel-chat-run',
      runId: 'run-y',
      companyId: 'c1',
    })
    expect(JSON.parse(bridge.published[1]!.payload)).toMatchObject({
      kind: 'cancel-agent-run',
      runId: 'run-z',
    })
  })
})
