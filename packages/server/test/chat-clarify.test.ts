import { describe, expect, it, vi } from 'vitest'
import { migrate, openDatabase } from '@eab/storage'
import { SC } from '@eab/domain'

const state = vi.hoisted(() => ({
  toolLists: [] as string[][],
  calls: 0,
}))

vi.mock('../src/llm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm.js')>()
  return {
    ...actual,
    callModelStream: vi.fn(async (_db: unknown, _path: unknown, _company: unknown, _model: unknown, _messages: unknown, options: { tools?: Array<{ function: { name: string } }> }) => {
      state.toolLists.push((options.tools ?? []).map((tool) => tool.function.name))
      state.calls += 1
      return {
        text: '',
        reasoning: '',
        toolCalls: [
          {
            id: `ask-${state.calls}`,
            type: 'function',
            function: {
              name: 'ask_user',
              arguments: JSON.stringify({
                question: '你想先处理哪类工作？',
                options: [
                  { label: '查通讯录', description: '查部门和成员信息' },
                  { label: '整理文档', description: '整理现有资料' },
                  { label: '设置提醒', description: '创建一个定时提醒' },
                ],
                allowCustom: true,
              }),
            },
          },
        ],
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

describe('引导式澄清', () => {
  it('模型调用 ask_user 时本轮结束并返回结构化的 2–4 个方向', async () => {
    state.toolLists.length = 0
    state.calls = 0
    const { deps, actor } = testEnv()
    const events: Array<{ type: string; clarify?: unknown }> = []

    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '帮我看看' }],
      maxTokens: 16,
      emit: (event) => events.push(event),
    })

    expect(state.toolLists[0]).toContain('ask_user')
    expect(result?.text).toBe('你想先处理哪类工作？')
    expect(result?.clarify?.question).toBe('你想先处理哪类工作？')
    expect(result?.clarify?.options.map((option) => option.label)).toEqual(['查通讯录', '整理文档', '设置提醒'])
    expect(result?.clarify?.allowCustom).toBe(true)
    expect(result?.toolCalls).toEqual([])
    expect(events.filter((event) => event.type === 'clarify')).toHaveLength(1)
    expect(events.some((event) => event.type === 'tool')).toBe(false)
  })

  it('模型第一次只返回短问句时，修复调用会补成结构化澄清', async () => {
    const { callModelStream } = await import('../src/llm.js')
    const mocked = callModelStream as unknown as { mockImplementationOnce: (fn: () => unknown) => void }
    mocked.mockImplementationOnce(async () => ({
      text: '你想先做哪件事？',
      reasoning: '',
      toolCalls: [],
      promptTokens: 1,
      completionTokens: 1,
    }))

    const { deps, actor } = testEnv()
    const events: Array<{ type: string; clarify?: unknown }> = []
    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '帮我看看' }],
      maxTokens: 16,
      emit: (event) => events.push(event),
    })

    expect(result?.clarify?.options).toHaveLength(3)
    expect(result?.text).toBe('你想先处理哪类工作？')
    expect(events.some((event) => event.type === 'clarify')).toBe(true)
  })

  it('修复调用仍只返回短问句时，服务端兜底也能生成可点击方向', async () => {
    const { callModelStream } = await import('../src/llm.js')
    const mocked = callModelStream as unknown as { mockImplementationOnce: (fn: () => unknown) => void }
    const textReply = async () => ({
      text: '你想先处理哪件事？',
      reasoning: '',
      toolCalls: [],
      promptTokens: 1,
      completionTokens: 1,
    })
    mocked.mockImplementationOnce(textReply)
    mocked.mockImplementationOnce(textReply)

    const { deps, actor } = testEnv()
    const events: Array<{ type: string; clarify?: unknown }> = []
    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '随便给点建议' }],
      maxTokens: 16,
      emit: (event) => events.push(event),
    })

    expect(result?.clarify?.options).toHaveLength(4)
    expect(result?.text).toBe('你想先处理哪件事？')
    expect(events.some((event) => event.type === 'clarify')).toBe(true)
  })

  it('模型给出的方向少于两个时退回普通回答，不执行未注册工具', async () => {
    const { callModelStream } = await import('../src/llm.js')
    const mocked = callModelStream as unknown as { mockImplementationOnce: (fn: () => unknown) => void }
    mocked.mockImplementationOnce(async () => ({
      text: '我先按默认方向处理。',
      reasoning: '',
      toolCalls: [
        {
          id: 'ask-bad',
          type: 'function',
          function: {
            name: 'ask_user',
            arguments: JSON.stringify({ question: '选一个方向？', options: [{ label: '只有一个' }] }),
          },
        },
      ],
      promptTokens: 1,
      completionTokens: 1,
    }))

    const { deps, actor } = testEnv()
    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '随便做点什么' }],
      maxTokens: 16,
      emit: () => {},
    })

    expect(result?.clarify).toBeUndefined()
    expect(result?.text).toBe('我先按默认方向处理。')
    expect(result?.toolCalls).toEqual([])
  })
})
