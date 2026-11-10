import { describe, expect, it, vi } from 'vitest'
import { openDatabase, migrate } from '@eab/storage'
import { SC } from '@eab/domain'

const state = vi.hoisted(() => ({
  toolLists: [] as string[][],
}))

vi.mock('../src/llm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm.js')>()
  let step = 0
  return {
    ...actual,
    callModelStream: vi.fn(async (_db: unknown, _path: unknown, _company: unknown, _model: unknown, _messages: unknown, options: { tools?: Array<{ function: { name: string } }>; onEvent?: (event: { type: 'content' | 'reasoning'; text: string }) => void }) => {
      state.toolLists.push((options.tools ?? []).map((tool) => tool.function.name))
      step += 1
      if (step === 1) {
        return {
          text: '',
          reasoning: '',
          toolCalls: [
            {
              id: 'search-1',
              type: 'function',
              function: { name: 'tool_search', arguments: JSON.stringify({ query: '计算' }) },
            },
          ],
          promptTokens: 1,
          completionTokens: 1,
        }
      }
      if (step === 2) {
        return {
          text: '',
          reasoning: '',
          toolCalls: [
            {
              id: 'math-1',
              type: 'function',
              function: { name: 'math_eval', arguments: JSON.stringify({ expression: '1+1' }) },
            },
          ],
          promptTokens: 1,
          completionTokens: 1,
        }
      }
      options.onEvent?.({ type: 'content', text: '答案是 2' })
      return { text: '答案是 2', reasoning: '', toolCalls: [], promptTokens: 1, completionTokens: 1 }
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
  const deps = { db, config: { dbPath: ':memory:' }, companyId: 'c1' } as any
  return { deps, actor }
}

describe('Agent 工具动态加载', () => {
  it('先搜 tool_search，下一轮才把命中的数学工具加载进 tools', async () => {
    state.toolLists.length = 0
    const { deps, actor } = testEnv()
    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '算一下 1+1' }],
      maxTokens: 16,
      emit: () => {},
    })

    expect(result?.text).toBe('答案是 2')
    expect(state.toolLists[0]).toContain('tool_search')
    expect(state.toolLists[0]).not.toContain('math_eval')
    expect(state.toolLists[1]).toContain('math_eval')
    expect(state.toolLists[1]).toContain('tool_search')
    expect(result?.toolCalls.map((tool) => tool.toolId)).toEqual(['tool.search', 'math.eval'])
  })
})
