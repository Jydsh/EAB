import { describe, expect, it, vi } from 'vitest'
import { migrate, openDatabase } from '@eab/storage'
import { SC } from '@eab/domain'

const state = vi.hoisted(() => ({
  childCalls: 0,
  rootCalls: 0,
  answered: false,
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
      const all = messages.map((message) => message.content).join('\n')

      if (isChild) {
        state.childCalls += 1
        if (state.childCalls === 1) {
          return {
            text: '',
            reasoning: '',
            toolCalls: [
              {
                id: 'ask-1',
                type: 'function',
                function: {
                  name: 'agent_ask_parent',
                  arguments: JSON.stringify({ question: '要按哪个口径统计？', context: '已经查到两份口径' }),
                },
              },
            ],
            promptTokens: 1,
            completionTokens: 1,
          }
        }
        options.onEvent?.({ type: 'content', text: '按 A 口径完成' })
        return { text: '按 A 口径完成', reasoning: '', toolCalls: [], promptTokens: 1, completionTokens: 1 }
      }

      state.rootCalls += 1
      if (state.answered) {
        options.onEvent?.({ type: 'content', text: '全部完成' })
        return { text: '全部完成', reasoning: '', toolCalls: [], promptTokens: 1, completionTokens: 1 }
      }
      if (all.includes('"status":"waiting"')) {
        state.answered = true
        return {
          text: '',
          reasoning: '',
          toolCalls: [
            {
              id: 'answer-1',
              type: 'function',
              function: {
                name: 'agent_task',
                arguments: JSON.stringify({ agent: 'asker', prompt: '按 A 口径统计' }),
              },
            },
          ],
          promptTokens: 1,
          completionTokens: 1,
        }
      }
      if (last.includes('先问')) {
        return {
          text: '',
          reasoning: '',
          toolCalls: [
            {
              id: 'spawn-ask',
              type: 'function',
              function: {
                name: 'agent_spawn',
                arguments: JSON.stringify({
                  tasks: [{ key: 'asker', title: '口径确认', prompt: '先确认口径再统计' }],
                }),
              },
            },
          ],
          promptTokens: 1,
          completionTokens: 1,
        }
      }
      options.onEvent?.({ type: 'content', text: '全部完成' })
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
    config: { dbPath: ':memory:', agentMaxParallel: 4, agentMaxDepth: 2, agentMaxRetries: 0 },
    companyId: 'c1',
  } as any
  return { deps, actor }
}

describe('子 Agent 向父 Agent 提问', () => {
  it('问题暂停本轮，父 Agent 用 agent_task 回答后子 Agent 接着完成', async () => {
    state.childCalls = 0
    state.rootCalls = 0
    state.answered = false
    const { deps, actor } = testEnv()
    const events: any[] = []
    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '请让子 Agent 先问口径再统计' }],
      maxTokens: 16,
      emit: (event) => events.push(event),
    })

    expect(result?.text).toBe('全部完成')
    expect(state.childCalls).toBe(2)
    const agentEvents = events.filter((event) => event.type === 'agent')
    expect(agentEvents.filter((event) => event.action === 'question')).toHaveLength(1)
    expect(agentEvents.find((event) => event.action === 'question')?.status).toBe('waiting')
    expect(agentEvents.filter((event) => event.action === 'assign')).toHaveLength(2)
    expect(agentEvents.filter((event) => event.action === 'done')).toHaveLength(1)
  })
})
