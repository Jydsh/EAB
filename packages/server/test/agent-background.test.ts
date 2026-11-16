import { describe, expect, it, vi } from 'vitest'
import { migrate, openDatabase } from '@eab/storage'
import { SC } from '@eab/domain'

const state = vi.hoisted(() => ({
  rootCalls: 0,
  childCalls: 0,
  mode: 'wait' as 'wait' | 'wake',
}))

vi.mock('../src/llm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm.js')>()
  return {
    ...actual,
    callModelStream: vi.fn(async (
      _db: unknown,
      _path: unknown,
      _company: unknown,
      _model: unknown,
      messages: Array<{ role: string; content: string }>,
      options: { onEvent?: (event: { type: 'content' | 'reasoning'; text: string }) => void },
    ) => {
      const isChild = messages.some(
        (message) => message.role === 'system' && message.content.includes('父 Agent 分派的子 Agent'),
      )
      if (isChild) {
        state.childCalls += 1
        options.onEvent?.({ type: 'content', text: '后台完成' })
        return { text: '后台完成', reasoning: '', toolCalls: [], promptTokens: 1, completionTokens: 1 }
      }
      state.rootCalls += 1
      const last = messages[messages.length - 1]?.content ?? ''
      if (last.includes('【后台子 Agent 完成通知】')) {
        options.onEvent?.({ type: 'content', text: '已被后台结果唤醒' })
        return { text: '已被后台结果唤醒', reasoning: '', toolCalls: [], promptTokens: 1, completionTokens: 1 }
      }
      if (state.rootCalls === 1) {
        return {
          text: '',
          reasoning: '',
          toolCalls: [{
            id: 'bg-1',
            type: 'function',
            function: {
              name: 'agent_spawn',
              arguments: JSON.stringify({
                tasks: [{ key: 'bg', title: '后台任务', prompt: '后台长任务' }],
                background: true,
              }),
            },
          }],
          promptTokens: 1,
          completionTokens: 1,
        }
      }
      if (state.mode === 'wake') {
        return { text: '', reasoning: '', toolCalls: [], promptTokens: 1, completionTokens: 1 }
      }
      if (state.rootCalls === 2) {
        return {
          text: '',
          reasoning: '',
          toolCalls: [{
            id: 'wait-1',
            type: 'function',
            function: {
              name: 'agent_wait',
              arguments: JSON.stringify({ timeoutSeconds: 2 }),
            },
          }],
          promptTokens: 1,
          completionTokens: 1,
        }
      }
      options.onEvent?.({ type: 'content', text: '后台汇总完成' })
      return { text: '后台汇总完成', reasoning: '', toolCalls: [], promptTokens: 1, completionTokens: 1 }
    }),
  }
})

import { runAgentTurn } from '../src/routes/chat.js'

function testEnv() {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  const actor = {
    subject: {
      companyId: 'c1',
      userId: 'u1',
      status: 'active',
      deptId: 'd1',
      deptPath: '/d1',
      deptChain: [],
      roles: [],
      scopes: new Set(Object.values(SC)),
    },
    person: {
      id: 'u1',
      name: '测试员工',
      title: null,
      deptId: 'd1',
      deptPath: '/d1',
      deptName: '测试部门',
      companyId: 'c1',
      companyName: '测试公司',
    },
  } as any
  const deps = {
    db,
    config: {
      dbPath: ':memory:',
      agentMaxParallel: 4,
      agentMaxDepth: 2,
      agentMaxRetries: 0,
      agentWaitTimeoutMs: 5000,
    },
    companyId: 'c1',
  } as any
  const now = Date.now()
  db.prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('c1', '测试公司', 'test-company-bg', 'active', now)
  db.prepare('INSERT INTO departments (id, company_id, name, path, depth, order_no, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('d1', 'c1', '测试部门', '/d1', 1, 0, now)
  db.prepare('INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('u1', 'c1', 'd1', '/d1', '测试员工', 'active', now, now)
  db.prepare('INSERT INTO chat_sessions (id, company_id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('s1', 'c1', 'u1', '后台测试', now, now)
  return { db, deps, actor }
}

describe('后台派活与 agent_wait', () => {
  it('background:true 立即返回确认，父回合结束后由完成事件唤醒汇总', async () => {
    state.mode = 'wait'
    state.rootCalls = 0
    state.childCalls = 0
    const { deps, actor } = testEnv()
    const events: any[] = []
    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '后台并行处理这些资料' }],
      maxTokens: 16,
      emit: (event) => events.push(event),
    })

    // 网页前台不再让父 Agent 用 agent_wait 占住会话：后台派发后立即收口，
    // 子 Agent 的完成事件会走唤醒轮汇总（下一条用例覆盖）。
    expect(result?.text).toBe('已派给子 Agent，完成后我会把结果汇总给你。')
    expect(state.rootCalls).toBe(1)
    // 子 Agent 在后台异步执行，这里只验证父回合已经收口；子 Agent 是否真的跑完
    // 由下一条唤醒用例验证，避免在本条里等一个不属于这里的时序。
    const spawnCall = result?.toolCalls.find((call) => call.toolId === 'agent.spawn')
    expect(spawnCall?.status).toBe('done')
    expect(String(spawnCall?.summary)).toContain('"background":true')
    expect(result?.toolCalls.some((call) => call.toolId === 'agent.wait')).toBe(false)
  })

  it('父回合结束后，后台任务完成事件会唤醒父 Agent 并写出汇总', async () => {
    state.mode = 'wake'
    state.rootCalls = 0
    state.childCalls = 0
    const { db, deps, actor } = testEnv()
    const first = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '后台并行处理这些资料' }],
      maxTokens: 16,
      sessionId: 's1',
      emit: () => {},
    })
    expect(first?.toolCalls.find((call) => call.toolId === 'agent.spawn')?.status).toBe('done')

    const deadline = Date.now() + 4000
    let wake: { text: string } | undefined
    while (Date.now() < deadline) {
      wake = db.prepare(
        `SELECT text FROM chat_messages
          WHERE session_id = 's1' AND role = 'assistant' AND meta_json LIKE '%backgroundWake%'
          ORDER BY created_at DESC LIMIT 1`,
      ).get() as { text: string } | undefined
      if (wake) break
      await new Promise((resolve) => setTimeout(resolve, 80))
    }
    expect(wake?.text).toBe('已被后台结果唤醒')
    expect(state.rootCalls).toBeGreaterThanOrEqual(2)
  })
})
