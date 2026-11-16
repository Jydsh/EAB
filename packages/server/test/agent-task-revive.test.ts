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
      const isChild = messages.some(
        (message) => message.role === 'system' && message.content.includes('父 Agent 分派的子 Agent'),
      )
      if (isChild) {
        state.childCalls += 1
        options.onEvent?.({ type: 'content', text: '续派完成' })
        return { text: '续派完成', reasoning: '', toolCalls: [], promptTokens: 1, completionTokens: 1 }
      }
      state.rootCalls += 1
      if (state.rootCalls === 1) {
        return {
          text: '',
          reasoning: '',
          toolCalls: [{
            id: 'task-1',
            type: 'function',
            function: {
              name: 'agent_task',
              arguments: JSON.stringify({
                agent: 'worker',
                prompt: '继续核对剩下的记录',
              }),
            },
          }],
          promptTokens: 1,
          completionTokens: 1,
        }
      }
      options.onEvent?.({ type: 'content', text: '续派成功' })
      return { text: '续派成功', reasoning: '', toolCalls: [], promptTokens: 1, completionTokens: 1 }
    }),
  }
})

import { runAgentTurn } from '../src/routes/chat.js'
import { AgentTeamStore } from '../src/agent-team.js'

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
      agentWorkerIdleMs: 120_000,
    },
    companyId: 'c1',
  } as any
  const now = Date.now()
  db.prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('c1', '测试公司', 'test-company-task-revive', 'active', now)
  db.prepare('INSERT INTO departments (id, company_id, name, path, depth, order_no, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('d1', 'c1', '测试部门', '/d1', 1, 0, now)
  db.prepare('INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('u1', 'c1', 'd1', '/d1', '测试员工', 'active', now, now)
  db.prepare('INSERT INTO chat_sessions (id, company_id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('s1', 'c1', 'u1', '续派测试', now, now)
  return { db, deps, actor }
}

describe('agent_task 在 worker 注销后按历史任务自动恢复', () => {
  it('同一个 key 继续派活时恢复窗口，并收尾遗留 running 任务', async () => {
    state.rootCalls = 0
    state.childCalls = 0
    const { db, deps, actor } = testEnv()
    const team = new AgentTeamStore({
      db,
      teamId: 'session:s1',
      companyId: 'c1',
      userId: 'u1',
    })
    team.registerWorker({ key: 'worker', name: '旧窗口', index: 1 })
    const oldTask = team.createTask({ workerKey: 'worker', prompt: '旧任务', parentRunId: 'parent-old' })
    team.markTaskRunning(oldTask.id, 'child-old')
    // 模拟空闲超时：worker 已经不在了，但旧 task 仍然是 running。
    db.prepare('DELETE FROM agent_workers WHERE team_id = ? AND key = ?').run('session:s1', 'worker')

    const events: any[] = []
    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '续派测试' }],
      maxTokens: 16,
      sessionId: 's1',
      allowAgentWait: true,
      emit: (event) => events.push(event),
    })

    expect(result?.text).toBe('续派成功')
    expect(state.childCalls).toBe(1)
    const workers = team.listWorkers()
    expect(workers).toHaveLength(1)
    expect(workers[0]?.key).toBe('worker')
    const old = team.getTask(oldTask.id)
    expect(old?.status).toBe('cancelled')
    // 前台续派不会另建 background task 行；关键是同一个 worker key 已被恢复，
    // 子 Agent 会话确实执行了一次，旧 running 任务不再污染团队摘要。
    expect(state.childCalls).toBe(1)
  })
})
