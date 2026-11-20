import { describe, expect, it, vi, beforeEach } from 'vitest'
import { migrate, openDatabase } from '@eab/storage'
import { SC } from '@eab/domain'

const state = vi.hoisted(() => ({
  modelCalls: 0,
  toolCalls: 0,
  finalizeSawNoTools: false,
  finalizeSawPrompt: false,
}))

const fakeTools = vi.hoisted(() => {
  const def = {
    id: 'mock.write',
    name: '模拟写文件',
    description: '用于测试工具轮次耗尽后的收尾',
    scope: 'tool.invoke',
    input: { path: { type: 'string' } },
  }
  return {
    def,
    specs: [{
      type: 'function',
      function: {
        name: 'mock_write',
        description: '模拟写文件',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        },
      },
    }],
  }
})

vi.mock('../src/routes/tools.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/routes/tools.js')>()
  return {
    ...actual,
    toolSpecsForActor: () => fakeTools.specs,
    toolSpecsForAgent: () => fakeTools.specs,
    resolveToolByFunctionName: (name: string) =>
      name === 'mock_write' ? fakeTools.def : undefined,
    executeTool: async (_deps: unknown, _actor: unknown, id: string) => {
      if (id !== 'mock.write') return { ok: false, error: 'unknown tool' }
      state.toolCalls += 1
      return { ok: true, path: 'a.txt', wrote: true, saved: true }
    },
  }
})

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
      options: { tools?: unknown[] },
    ) => {
      state.modelCalls += 1
      if (state.modelCalls === 1) {
        return {
          text: '',
          reasoning: '',
          toolCalls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'mock_write', arguments: '{"path":"a.txt"}' },
          }],
          promptTokens: 1,
          completionTokens: 1,
        }
      }
      state.finalizeSawNoTools = (options.tools ?? []).length === 0
      state.finalizeSawPrompt = messages.some((message) =>
        message.content.includes('【工具已执行完成】'),
      )
      return {
        text: '已完成写入 a.txt，文件已保存。',
        reasoning: '',
        toolCalls: [],
        promptTokens: 2,
        completionTokens: 2,
      }
    }),
  }
})

const { runAgentTurn } = await import('../src/routes/chat.js')

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
    .run('c1', '测试公司', 'test-company-finalize', 'active', now)
  db.prepare('INSERT INTO departments (id, company_id, name, path, depth, order_no, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('d1', 'c1', '测试部门', '/d1', 1, 0, now)
  db.prepare('INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('u1', 'c1', 'd1', '/d1', '测试员工', 'active', now, now)
  db.prepare('INSERT INTO chat_sessions (id, company_id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('s1', 'c1', 'u1', '工具后收尾测试', now, now)
  return { deps, actor }
}

beforeEach(() => {
  state.modelCalls = 0
  state.toolCalls = 0
  state.finalizeSawNoTools = false
  state.finalizeSawPrompt = false
})

describe('工具轮次耗尽后的收尾', () => {
  it('最后一轮只调了工具时，补一次无工具模型调用写出完成句', async () => {
    const { deps, actor } = testEnv()
    const emitted: string[] = []
    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '把 a.txt 写好' }],
      maxTokens: 16,
      maxRounds: 1,
      sessionId: 's1',
      space: { kind: 'cloud' },
      emit: (event) => {
        if (event.type === 'content') emitted.push(event.text)
      },
    })

    expect(state.toolCalls).toBe(1)
    expect(state.modelCalls).toBe(2)
    expect(state.finalizeSawNoTools).toBe(true)
    expect(state.finalizeSawPrompt).toBe(true)
    expect(result?.text).toBe('已完成写入 a.txt，文件已保存。')
    expect(emitted.join('')).toContain('已完成写入 a.txt')
  })
})
