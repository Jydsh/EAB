import { describe, expect, it, vi } from 'vitest'
import { openDatabase, migrate } from '@eab/storage'
import { SC } from '@eab/domain'

const state = vi.hoisted(() => ({
  step: 0,
  returnTool: true,
  toolLists: [] as string[][],
  prompts: [] as string[],
}))

vi.mock('../src/llm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm.js')>()
  return {
    ...actual,
    callModelStream: vi.fn(async (...raw: unknown[]) => {
      const messages = raw[4] as Array<{ role: string; content: unknown }>
      const options = raw[5] as {
        tools?: Array<{ function: { name: string } }>
        onEvent?: (event: { type: 'content' | 'reasoning'; text: string }) => void
      }
      state.toolLists.push((options.tools ?? []).map((tool) => tool.function.name))
      state.prompts.push(String(messages.find((message) => message.role === 'system')?.content ?? ''))
      state.step += 1
      if (state.returnTool && state.step === 1) {
        return {
          text: '',
          reasoning: '',
          toolCalls: [
            {
              id: 'switch-1',
              type: 'function',
              function: {
                name: 'switch_chat_model',
                arguments: JSON.stringify({ mode: 'switch', target: 'MiMo V2.6 Pro' }),
              },
            },
          ],
          promptTokens: 1,
          completionTokens: 1,
        }
      }
      options.onEvent?.({ type: 'content', text: '已切换，从下一条消息开始使用。' })
      return {
        text: '已切换，从下一条消息开始使用。',
        reasoning: '',
        toolCalls: [],
        promptTokens: 1,
        completionTokens: 1,
      }
    }),
  }
})

import { runAgentTurn } from '../src/routes/chat.js'

function testEnv() {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  const now = Date.now()
  db.prepare("INSERT INTO companies (id, name, slug, status, created_at) VALUES ('c1', '测试公司', 'c1', 'active', ?)").run(now)
  db.prepare(
    "INSERT INTO departments (id, company_id, name, path, created_at) VALUES ('d1', 'c1', '测试部门', 'd1', ?)",
  ).run(now)
  db.prepare(
    "INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at) VALUES ('u1', 'c1', 'd1', 'd1', '测试用户', 'active', ?, ?)",
  ).run(now, now)
  db.prepare(
    "INSERT INTO chat_sessions (id, company_id, user_id, title, model_id, created_at, updated_at) VALUES ('s1', 'c1', 'u1', '测试会话', 'deepseek-v4-flash', ?, ?)",
  ).run(now, now)
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
  return { db, deps, actor }
}

const models = [
  { id: 'deepseek-v4-flash', name: 'Deepseek V4 Flash' },
  { id: 'plugin:our-free-model:mimo-v2.6-pro-free', name: 'MiMo V2.6 Pro' },
]

function reset() {
  state.step = 0
  state.returnTool = true
  state.toolLists.length = 0
  state.prompts.length = 0
}

describe('switch_chat_model 接入 Agent 工具循环', () => {
  it('渠道父 Agent 能看到并执行工具，真实写入当前会话', async () => {
    reset()
    const { db, deps, actor } = testEnv()
    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '帮我换个模型' }],
      sessionId: 's1',
      space: { kind: 'none' },
      maxTokens: 16,
      emit: () => {},
      modelSwitch: {
        models,
        currentModelId: 'deepseek-v4-flash',
        activeModelId: 'deepseek-v4-flash',
        onChange: (modelId) => {
          db.prepare('UPDATE chat_sessions SET model_id = ? WHERE id = ?').run(modelId, 's1')
        },
      },
    })

    expect(result?.text).toContain('已切换')
    expect(result?.toolCalls.map((tool) => tool.name)).toContain('switch_chat_model')
    expect(state.toolLists[0]).toContain('switch_chat_model')
    expect(
      (db.prepare("SELECT model_id FROM chat_sessions WHERE id = 's1'").get() as { model_id: string }).model_id,
    ).toBe('plugin:our-free-model:mimo-v2.6-pro-free')
  })

  it('网页/子 Agent 不传上下文时工具不出现', async () => {
    reset()
    state.returnTool = false
    const { deps, actor } = testEnv()
    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '帮我换个模型' }],
      sessionId: 's1',
      space: { kind: 'none' },
      maxTokens: 16,
      emit: () => {},
    })

    expect(result?.text).toContain('已切换')
    expect(state.toolLists[0]).not.toContain('switch_chat_model')
  })
})
