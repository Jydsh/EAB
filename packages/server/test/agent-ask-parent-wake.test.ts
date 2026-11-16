import { describe, expect, it, vi } from 'vitest'
import { migrate, openDatabase } from '@eab/storage'
import { SC } from '@eab/domain'

const state = vi.hoisted(() => ({
  childCalls: 0,
  rootCalls: 0,
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
      const last = messages[messages.length - 1]?.content ?? ''
      if (isChild) {
        state.childCalls += 1
        if (state.childCalls === 1) {
          return {
            text: '',
            reasoning: '',
            toolCalls: [{
              id: 'ask-bg-1',
              type: 'function',
              function: {
                name: 'agent_ask_parent',
                arguments: JSON.stringify({ question: '要按哪个口径统计？' }),
              },
            }],
            promptTokens: 1,
            completionTokens: 1,
          }
        }
        options.onEvent?.({ type: 'content', text: '按 A 口径完成' })
        return { text: '按 A 口径完成', reasoning: '', toolCalls: [], promptTokens: 1, completionTokens: 1 }
      }

      state.rootCalls += 1
      // 关键路径：父 Agent 只输出文字、没有调用 agent_task，服务端必须把这段答复发回子 Agent。
      if (last.includes('【子 Agent 提问，需要你直接回答】')) {
        options.onEvent?.({ type: 'content', text: '按 A 口径统计' })
        return { text: '按 A 口径统计', reasoning: '', toolCalls: [], promptTokens: 1, completionTokens: 1 }
      }
      if (state.rootCalls === 1) {
        return {
          text: '',
          reasoning: '',
          toolCalls: [{
            id: 'spawn-bg-ask',
            type: 'function',
            function: {
              name: 'agent_spawn',
              arguments: JSON.stringify({
                tasks: [{ key: 'asker', title: '后台口径确认', prompt: '先确认口径再统计' }],
                background: true,
              }),
            },
          }],
          promptTokens: 1,
          completionTokens: 1,
        }
      }
      return { text: '全部完成', reasoning: '', toolCalls: [], promptTokens: 1, completionTokens: 1 }
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
    .run('c1', '测试公司', 'test-company-ask-wake', 'active', now)
  db.prepare('INSERT INTO departments (id, company_id, name, path, depth, order_no, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('d1', 'c1', '测试部门', '/d1', 1, 0, now)
  db.prepare('INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('u1', 'c1', 'd1', '/d1', '测试员工', 'active', now, now)
  db.prepare('INSERT INTO chat_sessions (id, company_id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('s1', 'c1', 'u1', '后台提问测试', now, now)
  return { db, deps, actor }
}

describe('后台子 Agent 提问的父 Agent 直接答复', () => {
  it('父 Agent 只输出文字未调 agent_task 时，服务端自动把答复发回等待中的子 Agent', async () => {
    state.childCalls = 0
    state.rootCalls = 0
    const { db, deps, actor } = testEnv()
    await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '请让后台子 Agent 先问口径再统计' }],
      maxTokens: 16,
      sessionId: 's1',
      emit: () => {},
    })

    const deadline = Date.now() + 6000
    let resumed: { prompt: string; status: string } | undefined
    while (Date.now() < deadline) {
      resumed = db.prepare(
        `SELECT prompt, status FROM agent_tasks
          WHERE prompt LIKE '%父 Agent 的决策%'
          ORDER BY created_at DESC LIMIT 1`,
      ).get() as { prompt: string; status: string } | undefined
      if (resumed?.status === 'succeeded') break
      await new Promise((resolve) => setTimeout(resolve, 80))
    }

    expect(state.childCalls).toBeGreaterThanOrEqual(2)
    expect(resumed?.prompt).toContain('按 A 口径统计')
    expect(resumed?.status).toBe('succeeded')
    const cancelled = db.prepare(
      `SELECT status FROM agent_tasks WHERE prompt = '先确认口径再统计' ORDER BY created_at ASC LIMIT 1`,
    ).get() as { status: string } | undefined
    expect(cancelled?.status).toBe('cancelled')
  })
})
