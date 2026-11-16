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
        const resumed = messages.some((message) => String(message.content).includes('【从检查点继续】'))
        const text = resumed ? '续跑完成' : '首次完成'
        options.onEvent?.({ type: 'content', text })
        return {
          text,
          reasoning: '',
          toolCalls: [],
          promptTokens: 1,
          completionTokens: 1,
        }
      }
      state.rootCalls += 1
      if (state.rootCalls === 1) {
        return {
          text: '',
          reasoning: '',
          toolCalls: [{
            id: 'resume-1',
            type: 'function',
            function: {
              name: 'agent_resume',
              arguments: JSON.stringify({ agent: 'worker', background: false }),
            },
          }],
          promptTokens: 1,
          completionTokens: 1,
        }
      }
      options.onEvent?.({ type: 'content', text: '已恢复并汇总' })
      return { text: '已恢复并汇总', reasoning: '', toolCalls: [], promptTokens: 1, completionTokens: 1 }
    }),
  }
})

import { AgentTeamStore } from '../src/agent-team.js'
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
  const now = Date.now()
  db.prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('c1', '测试公司', 'test-company', 'active', now)
  db.prepare('INSERT INTO departments (id, company_id, name, path, depth, order_no, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('d1', 'c1', '测试部门', '/d1', 1, 0, now)
  db.prepare('INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('u1', 'c1', 'd1', '/d1', '测试员工', 'active', now, now)
  db.prepare('INSERT INTO chat_sessions (id, company_id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('s1', 'c1', 'u1', '恢复测试', now, now)
  return { db, deps, actor }
}

describe('从检查点继续子 Agent', () => {
  it('读取失败任务的 child run 检查点，带着原消息续跑而不是从头再做', async () => {
    state.rootCalls = 0
    state.childCalls = 0
    const { db, deps, actor } = testEnv()
    const team = new AgentTeamStore({ db, teamId: 'session:s1', companyId: 'c1', userId: 'u1' })
    team.registerWorker({ key: 'worker', name: '长任务', index: 1 })
    const task = team.createTask({ workerKey: 'worker', prompt: '把 100 条记录逐条核对完', parentRunId: 'parent-1' })
    team.markTaskRunning(task.id, 'child-run-1')
    team.markTaskFailed(task.id, '服务重启中断；任务和检查点已保留，需要时请重新派活', Date.now())
    team.markWorkerIdle('worker', '服务重启中断', Date.now())
    db.prepare(
      `INSERT INTO agent_runs
         (id, company_id, user_id, parent_run_id, agent_id, title, status, resume_state_json, started_at, created_at)
       VALUES (?, 'c1', 'u1', 'parent-1', 'sub-1', '长任务', 'failed', ?, 1000, 1000)`,
    ).run('child-run-1', JSON.stringify({
      round: 3,
      turnId: 'turn-resume-1',
      system: '你是父 Agent 分派的子 Agent',
      prompt: '把 100 条记录逐条核对完',
      messages: [
        { role: 'system', content: '你是父 Agent 分派的子 Agent，负责把交给你的子任务做完。' },
        { role: 'user', content: '把 100 条记录逐条核对完' },
        { role: 'assistant', content: '已经核对到第 60 条，剩余 40 条。' },
      ],
    }))

    const events: any[] = []
    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '把刚才中断的核对任务继续做完' }],
      maxTokens: 16,
      sessionId: 's1',
      emit: (event) => events.push(event),
    })

    expect(result?.text).toBe('已恢复并汇总')
    expect(state.childCalls).toBe(1)
    const resumeCall = result?.toolCalls.find((call) => call.toolId === 'agent.resume')
    expect(resumeCall).toBeTruthy()
    expect(events.filter((event) => event.type === 'agent' && event.action === 'done')).toHaveLength(1)
    const messages = team.workerMessages('worker')
    expect(messages.some((message) => message.role === 'user' && message.content.includes('【从检查点继续】'))).toBe(true)
    expect(messages.some((message) => message.role === 'assistant' && message.content === '续跑完成')).toBe(true)
    expect(team.findWorker('worker')?.status).toBe('idle')
  })

  it('任务没有检查点时明确拒绝，不假装续跑', async () => {
    state.rootCalls = 0
    state.childCalls = 0
    const { db, deps, actor } = testEnv()
    const team = new AgentTeamStore({ db, teamId: 'session:s1', companyId: 'c1', userId: 'u1' })
    team.registerWorker({ key: 'worker', name: '长任务', index: 1 })
    const task = team.createTask({ workerKey: 'worker', prompt: '核对 100 条记录', parentRunId: 'parent-1' })
    team.markTaskRunning(task.id, 'child-run-empty')
    team.markTaskFailed(task.id, '服务重启中断', Date.now())
    team.markWorkerIdle('worker', '服务重启中断', Date.now())

    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '继续刚才的任务' }],
      maxTokens: 16,
      sessionId: 's1',
      emit: () => {},
    })

    const resumeCall = result?.toolCalls.find((call) => call.toolId === 'agent.resume')
    expect(resumeCall?.status).toBe('error')
    expect(String(resumeCall?.summary)).toContain('没有可用检查点')
    expect(state.childCalls).toBe(0)
  })

  it('已经成功的任务不再恢复，提示改用 agent_task', async () => {
    state.rootCalls = 0
    state.childCalls = 0
    const { db, deps, actor } = testEnv()
    const team = new AgentTeamStore({ db, teamId: 'session:s1', companyId: 'c1', userId: 'u1' })
    team.registerWorker({ key: 'worker', name: '长任务', index: 1 })
    const task = team.createTask({ workerKey: 'worker', prompt: '核对 100 条记录', parentRunId: 'parent-1' })
    team.markTaskRunning(task.id, 'child-run-done')
    team.markTaskDone(task.id, '已全部核对完', Date.now())
    team.markWorkerIdle('worker', '已全部核对完', Date.now())

    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '继续刚才的任务' }],
      maxTokens: 16,
      sessionId: 's1',
      emit: () => {},
    })

    const resumeCall = result?.toolCalls.find((call) => call.toolId === 'agent.resume')
    expect(resumeCall?.status).toBe('error')
    expect(String(resumeCall?.summary)).toContain('已经成功完成')
    expect(state.childCalls).toBe(0)
  })
})
