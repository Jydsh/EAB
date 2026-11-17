import { describe, expect, it, vi } from 'vitest'
import { migrate, openDatabase } from '@eab/storage'
import { SC } from '@eab/domain'

const state = vi.hoisted(() => ({
  rootCalls: 0,
  childCalls: 0,
  scenario: 'idle' as 'idle' | 'busy',
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
        options.onEvent?.({ type: 'content', text: '子 Agent 已继续执行' })
        return {
          text: '子 Agent 已继续执行',
          reasoning: '',
          toolCalls: [],
          promptTokens: 1,
          completionTokens: 1,
        }
      }

      state.rootCalls += 1
      if (state.rootCalls === 1) {
        const messageFirst = state.scenario === 'idle'
        return {
          text: '',
          reasoning: '',
          toolCalls: [{
            id: 'call-1',
            type: 'function',
            function: {
              name: messageFirst ? 'agent_message' : 'agent_task',
              arguments: JSON.stringify(messageFirst
                ? { agent: 'builder', text: '汇报当前任务进度' }
                : { agent: 'builder', prompt: '汇报当前任务进度' }),
            },
          }],
          promptTokens: 1,
          completionTokens: 1,
        }
      }
      if (state.rootCalls === 2) {
        const messageFirst = state.scenario === 'idle'
        return {
          text: '',
          reasoning: '',
          toolCalls: [{
            id: 'call-2',
            type: 'function',
            function: {
              name: messageFirst ? 'agent_task' : 'agent_message',
              arguments: JSON.stringify(messageFirst
                ? { agent: 'builder', prompt: '汇报当前任务进度' }
                : { agent: 'builder', text: '汇报当前任务进度' }),
            },
          }],
          promptTokens: 1,
          completionTokens: 1,
        }
      }
      options.onEvent?.({ type: 'content', text: '已推进' })
      return {
        text: '已推进',
        reasoning: '',
        toolCalls: [],
        promptTokens: 1,
        completionTokens: 1,
      }
    }),
  }
})

import { runAgentTurn } from '../src/routes/chat.js'
import { AgentTeamStore } from '../src/agent-team.js'

function testEnv(name: string) {
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
    .run('c1', '测试公司', `test-company-${name}`, 'active', now)
  db.prepare('INSERT INTO departments (id, company_id, name, path, depth, order_no, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('d1', 'c1', '测试部门', '/d1', 1, 0, now)
  db.prepare('INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('u1', 'c1', 'd1', '/d1', '测试员工', 'active', now, now)
  db.prepare('INSERT INTO chat_sessions (id, company_id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('s1', 'c1', 'u1', name, now, now)
  return { db, deps, actor }
}

describe('agent.message / agent.task 状态误选返回结构化提示', () => {
  it('对空闲子 Agent 调用 agent.message 不抛错，并提示改用 agent.task', async () => {
    state.rootCalls = 0
    state.childCalls = 0
    state.scenario = 'idle'
    const { deps, actor } = testEnv('message-idle')
    const team = new AgentTeamStore({
      db: deps.db,
      teamId: 'session:s1',
      companyId: 'c1',
      userId: 'u1',
    })
    team.registerWorker({ key: 'builder', name: '表格整理三', index: 1 })
    team.markWorkerIdle('builder', '上一轮已完成')

    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '催一下进度' }],
      maxTokens: 16,
      sessionId: 's1',
      emit: () => undefined,
    })

    expect(result?.text).toBe('已推进')
    expect(state.childCalls).toBe(1)
    expect(team.findWorker('builder')?.status).toBe('idle')
    const run = deps.db
      .prepare("SELECT id FROM agent_runs WHERE session_id = 's1' ORDER BY rowid DESC LIMIT 1")
      .get() as { id: string }
    const steps = deps.db
      .prepare('SELECT tool_id, status FROM agent_steps WHERE run_id = ? ORDER BY seq')
      .all(run.id) as Array<{ tool_id: string; status: string }>
    expect(steps.find((step) => step.tool_id === 'agent.message')?.status).toBe('done')
    expect(steps.find((step) => step.tool_id === 'agent.task')?.status).toBe('done')
  })

  it('对运行中子 Agent 调用 agent.task 不抛错，并提示改用 agent.message', async () => {
    state.rootCalls = 0
    state.childCalls = 0
    state.scenario = 'busy'
    const { deps, actor } = testEnv('task-running')
    const team = new AgentTeamStore({
      db: deps.db,
      teamId: 'session:s1',
      companyId: 'c1',
      userId: 'u1',
    })
    team.registerWorker({ key: 'builder', name: '表格整理三', index: 1 })
    const running = team.createTask({ workerKey: 'builder', prompt: '正在整理表格', parentRunId: 'parent-old' })
    team.markTaskRunning(running.id, 'child-old')

    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '催一下进度' }],
      maxTokens: 16,
      sessionId: 's1',
      emit: () => undefined,
    })

    expect(result?.text).toBe('已推进')
    expect(state.childCalls).toBe(0)
    expect(team.takeGuidance('builder')).toContain('汇报当前任务进度')
    const run = deps.db
      .prepare("SELECT id FROM agent_runs WHERE session_id = 's1' ORDER BY rowid DESC LIMIT 1")
      .get() as { id: string }
    const steps = deps.db
      .prepare('SELECT tool_id, status FROM agent_steps WHERE run_id = ? ORDER BY seq')
      .all(run.id) as Array<{ tool_id: string; status: string }>
    expect(steps.find((step) => step.tool_id === 'agent.task')?.status).toBe('done')
    expect(steps.find((step) => step.tool_id === 'agent.message')?.status).toBe('done')
  })
})
