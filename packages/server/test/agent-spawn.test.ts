import { describe, expect, it, vi } from 'vitest'
import { migrate, openDatabase } from '@eab/storage'
import { SC } from '@eab/domain'

const state = vi.hoisted(() => ({
  rootCalls: 0,
  childCalls: 0,
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
      // 子 Agent 现在带独立的 system 角色，用角色判断而不是消息条数。
      const isChild = messages.some(
        (message) => message.role === 'system' && message.content.includes('父 Agent 分派的子 Agent'),
      )
      if (isChild) {
        state.childCalls += 1
        const content = messages[messages.length - 1]?.content ?? ''
        if (content.includes('任务B')) throw new Error('子任务 B 模型失败')
        options.onEvent?.({ type: 'content', text: `完成：${content}` })
        return { text: `完成：${content}`, reasoning: '', toolCalls: [], promptTokens: 1, completionTokens: 1 }
      }
      const content = messages[messages.length - 1]?.content ?? ''
      if (content.includes('并行分析')) {
        state.rootCalls += 1
        return {
          text: '',
          reasoning: '',
          toolCalls: [
            {
              id: 'spawn-1',
              type: 'function',
              function: {
                name: 'agent_spawn',
                arguments: JSON.stringify({
                  tasks: [
                    { title: '任务 A', prompt: '任务A：查资料' },
                    { title: '任务 B', prompt: '任务B：写总结' },
                  ],
                }),
              },
            },
          ],
          promptTokens: 1,
          completionTokens: 1,
        }
      }
      state.rootCalls += 1
      options.onEvent?.({ type: 'content', text: '全部完成' })
      return { text: '全部完成', reasoning: '', toolCalls: [], promptTokens: 1, completionTokens: 1 }
    }),
  }
})

import { listAgentRuns } from '../src/agent-runtime.js'
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
    config: { dbPath: ':memory:', agentMaxParallel: 4, agentMaxDepth: 2, agentMaxRetries: 1 },
    companyId: 'c1',
  } as any
  return { deps, actor }
}

describe('多 Agent 并行调度', () => {
  it('父子 run 独立记录；一个子 Agent 失败不影响另一个和父任务', async () => {
    state.rootCalls = 0
    state.childCalls = 0
    const { deps, actor } = testEnv()
    const events: any[] = []
    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '请并行分析两个方向' }],
      maxTokens: 16,
      emit: (event) => events.push(event),
    })

    expect(result?.text).toBe('全部完成')
    expect(result?.toolCalls[0]?.toolId).toBe('agent.spawn')
    expect(state.childCalls).toBe(3) // 任务 A 一次，任务 B 失败后按 retries=1 再试一次

    const agentEvents = events.filter((event) => event.type === 'agent')
    expect(agentEvents.filter((event) => event.action === 'assign')).toHaveLength(2)
    expect(agentEvents.filter((event) => event.action === 'spawn')).toHaveLength(3)
    expect(agentEvents.filter((event) => event.action === 'done')).toHaveLength(2)
    expect(agentEvents.filter((event) => event.action === 'done').map((event) => event.status))
      .toEqual(expect.arrayContaining(['unregistered', 'failed']))
    expect(agentEvents.filter((event) => event.action === 'content').length).toBeGreaterThan(0)
    expect(agentEvents.filter((event) => event.action === 'report').length).toBe(1)

    const runs = listAgentRuns(deps.db, 'c1')
    expect(runs).toHaveLength(4) // 根任务 + 任务 A + 任务 B 两次尝试
    const root = runs.find((run) => run.parentRunId === null)
    const a = runs.find((run) => run.title === '任务 A')
    const bRuns = runs.filter((run) => run.title === '任务 B')
    expect(root?.status).toBe('succeeded')
    expect(root?.id).toBe(result?.runId)
    expect(a?.parentRunId).toBe(root?.id)
    expect(a?.status).toBe('succeeded')
    expect(a?.sessionId).toBe(`agent:${a?.id}`)
    expect(bRuns).toHaveLength(2)
    expect(bRuns.every((run) => run.status === 'failed')).toBe(true)
    expect(bRuns.every((run) => run.parentRunId === root?.id)).toBe(true)
    expect(a?.id).not.toBe(bRuns[0]?.id)
  })
})
