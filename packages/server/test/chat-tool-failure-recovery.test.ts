import { describe, expect, it, vi, beforeEach } from 'vitest'
import { migrate, openDatabase } from '@eab/storage'
import { SC } from '@eab/domain'

const state = vi.hoisted(() => ({
  rootCalls: 0,
  failCalls: 0,
  successCalls: 0,
}))

const fakeTools = vi.hoisted(() => {
  const failDef = {
    id: 'mock.fail',
    name: '失败工具',
    description: '用于测试工具失败后的自动修复',
    scope: 'tool.invoke',
    input: { path: { type: 'string' } },
  }
  const successDef = {
    id: 'mock.success',
    name: '成功工具',
    description: '用于测试修复后继续执行',
    scope: 'tool.invoke',
    input: { path: { type: 'string' } },
  }
  const spec = (name: string, description: string) => ({
    type: 'function',
    function: {
      name,
      description,
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    },
  })
  return {
    failDef,
    successDef,
    specs: [spec('mock_fail', '失败工具'), spec('mock_success', '成功工具')],
  }
})

vi.mock('../src/routes/tools.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/routes/tools.js')>()
  return {
    ...actual,
    toolSpecsForActor: () => fakeTools.specs,
    toolSpecsForAgent: () => fakeTools.specs,
    resolveToolByFunctionName: (name: string) =>
      name === 'mock_fail' ? fakeTools.failDef : name === 'mock_success' ? fakeTools.successDef : undefined,
    executeTool: async (_deps: unknown, _actor: unknown, id: string) => {
      if (id === 'mock.fail') {
        state.failCalls += 1
        return { ok: false, error: '非法路径：路径为空' }
      }
      state.successCalls += 1
      return { ok: true, path: 'a.txt' }
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
      options: { onEvent?: (event: { type: 'content' | 'reasoning'; text: string }) => void },
    ) => {
      state.rootCalls += 1
      if (state.rootCalls === 1) {
        return {
          text: '',
          reasoning: '',
          toolCalls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'mock_fail', arguments: '{"path":""}' },
          }],
          promptTokens: 1,
          completionTokens: 1,
        }
      }
      if (state.rootCalls === 2) {
        options.onEvent?.({ type: 'content', text: '请再试一次。' })
        return { text: '请再试一次。', reasoning: '', toolCalls: [], promptTokens: 1, completionTokens: 1 }
      }
      if (state.rootCalls === 3) {
        return {
          text: '',
          reasoning: '',
          toolCalls: [{
            id: 'call-2',
            type: 'function',
            function: { name: 'mock_success', arguments: '{"path":"a.txt"}' },
          }],
          promptTokens: 1,
          completionTokens: 1,
        }
      }
      expect(messages.some((message) => message.content.includes('工具执行失败，不能就此结束'))).toBe(true)
      options.onEvent?.({ type: 'content', text: '已完成读取 a.txt。' })
      return { text: '已完成读取 a.txt。', reasoning: '', toolCalls: [], promptTokens: 1, completionTokens: 1 }
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
    .run('c1', '测试公司', 'test-company-tool', 'active', now)
  db.prepare('INSERT INTO departments (id, company_id, name, path, depth, order_no, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('d1', 'c1', '测试部门', '/d1', 1, 0, now)
  db.prepare('INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('u1', 'c1', 'd1', '/d1', '测试员工', 'active', now, now)
  db.prepare('INSERT INTO chat_sessions (id, company_id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('s1', 'c1', 'u1', '工具失败测试', now, now)
  return { db, deps, actor }
}

beforeEach(() => {
  state.rootCalls = 0
  state.failCalls = 0
  state.successCalls = 0
})

describe('工具失败自动修复', () => {
  it('工具失败且模型想收口时，注入恢复指令并继续执行到成功', async () => {
    const { deps, actor } = testEnv()
    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '读取 a.txt' }],
      maxTokens: 16,
      sessionId: 's1',
      space: { kind: 'cloud' },
      emit: () => {},
    })

    expect(state.rootCalls).toBe(4)
    expect(state.failCalls).toBe(1)
    expect(state.successCalls).toBe(1)
    expect(result?.text).toBe('已完成读取 a.txt。')
  })
})
