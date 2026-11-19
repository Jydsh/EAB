import { describe, expect, it, vi } from 'vitest'
import { migrate, openDatabase } from '@eab/storage'
import { SC } from '@eab/domain'

const state = vi.hoisted(() => ({
  childCalls: 0,
  rootCalls: 0,
  hangWake: false,
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
      if (isChild) {
        state.childCalls += 1
        if (state.childCalls === 1) {
          return {
            text: '',
            reasoning: '',
            toolCalls: [{
              id: 'ask-bg-1',
              type: 'function',
              function: {
                name: 'agent_ask_parent',
                arguments: JSON.stringify({ question: '要按哪个口径统计？' }),
              },
            }],
            promptTokens: 1,
            completionTokens: 1,
          }
        }
        options.onEvent?.({ type: 'content', text: '按 A 口径完成' })
        return { text: '按 A 口径完成', reasoning: '', toolCalls: [], promptTokens: 1, completionTokens: 1 }
      }

      state.rootCalls += 1
      // 关键路径：父 Agent 只输出文字、没有调用 agent_task，服务端必须把这段答复发回子 Agent。
      if (last.includes('【子 Agent 提问，需要你直接回答】')) {
        if (state.hangWake) return new Promise(() => {})
        options.onEvent?.({ type: 'content', text: '按 A 口径统计' })
        return { text: '按 A 口径统计', reasoning: '', toolCalls: [], promptTokens: 1, completionTokens: 1 }
      }
      if (state.rootCalls === 1) {
        return {
          text: '',
          reasoning: '',
          toolCalls: [{
            id: 'spawn-bg-ask',
            type: 'function',
            function: {
              name: 'agent_spawn',
              arguments: JSON.stringify({
                tasks: [{ key: 'asker', title: '后台口径确认', prompt: '先确认口径再统计' }],
                background: true,
              }),
            },
          }],
          promptTokens: 1,
          completionTokens: 1,
        }
      }
      return { text: '全部完成', reasoning: '', toolCalls: [], promptTokens: 1, completionTokens: 1 }
    }),
  }
})

import { runAgentTurn } from '../src/routes/chat.js'

function testEnv(sessionId = 's1') {
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
    .run('c1', '测试公司', 'test-company-ask-wake', 'active', now)
  db.prepare('INSERT INTO departments (id, company_id, name, path, depth, order_no, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('d1', 'c1', '测试部门', '/d1', 1, 0, now)
  db.prepare('INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('u1', 'c1', 'd1', '/d1', '测试员工', 'active', now, now)
  db.prepare('INSERT INTO chat_sessions (id, company_id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sessionId, 'c1', 'u1', '后台提问测试', now, now)
  return { db, deps, actor }
}

describe('后台子 Agent 提问的父 Agent 直接答复', () => {
  it('父 Agent 只输出文字未调 agent_task 时，服务端自动把答复发回等待中的子 Agent', async () => {
    state.childCalls = 0
    state.rootCalls = 0
    const { db, deps, actor } = testEnv()
    await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '请让后台子 Agent 先问口径再统计' }],
      maxTokens: 16,
      sessionId: 's1',
      emit: () => {},
    })

    const deadline = Date.now() + 6000
    let resumed: { prompt: string; status: string } | undefined
    while (Date.now() < deadline) {
      resumed = db.prepare(
        `SELECT prompt, status FROM agent_tasks
          WHERE prompt LIKE '%父 Agent 的决策%'
          ORDER BY created_at DESC LIMIT 1`,
      ).get() as { prompt: string; status: string } | undefined
      if (resumed?.status === 'succeeded') break
      await new Promise((resolve) => setTimeout(resolve, 80))
    }

    expect(resumed?.prompt).toContain('按 A 口径统计')
    expect(resumed?.status).toBe('succeeded')
    const cancelled = db.prepare(
      `SELECT status FROM agent_tasks WHERE prompt = '先确认口径再统计' ORDER BY created_at ASC LIMIT 1`,
    ).get() as { status: string } | undefined
    expect(cancelled?.status).toBe('cancelled')
  }, 15_000)

  it('父 Agent 唤醒轮一直不返回时，按超时收尾并让等待中的子 Agent 立即停止等待', async () => {
    state.childCalls = 0
    state.rootCalls = 0
    state.hangWake = true
    const { db, deps, actor } = testEnv('s2')
    deps.config.agentWakeTimeoutMs = 80
    await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '请让后台子 Agent 先问口径再统计' }],
      maxTokens: 16,
      sessionId: 's2',
      emit: () => {},
    })

    const deadline = Date.now() + 9000
    let fallbackTask: { prompt: string; status: string } | undefined
    let notice: { text: string } | undefined
    while (Date.now() < deadline) {
      fallbackTask = db.prepare(
        `SELECT prompt, status FROM agent_tasks
          WHERE prompt LIKE '%父 Agent 暂时无法答复%'
          ORDER BY created_at DESC LIMIT 1`,
      ).get() as { prompt: string; status: string } | undefined
      notice = db.prepare(
        `SELECT text FROM chat_messages
          WHERE session_id = 's2' AND role = 'assistant'
            AND (text LIKE '%没能在时限内给出决策%' OR text LIKE '%没能在时限内%')
          ORDER BY created_at DESC LIMIT 1`,
      ).get() as { text: string } | undefined
      if (fallbackTask && fallbackTask.status === 'succeeded' && notice) break
      await new Promise((resolve) => setTimeout(resolve, 80))
    }

    expect(fallbackTask?.prompt).toContain('请立即收口')
    expect(fallbackTask?.prompt).toContain('不要继续等待父 Agent')
    expect(notice?.text).toContain('停止等待')
    const worker = db.prepare(
      `SELECT status, last_text FROM agent_workers
        WHERE team_id = 'session:s2' AND key = 'asker'`,
    ).get() as { status: string; last_text: string } | undefined
    expect(worker?.status).toBe('idle')
    // 卡住的父 run 必须被标成终态，不能继续挡住后续唤醒。
    const stuckRun = db.prepare(
      `SELECT status, error FROM agent_runs
        WHERE error LIKE '%超时%'
        ORDER BY started_at DESC LIMIT 1`,
    ).get() as { status: string; error: string | null } | undefined
    expect(stuckRun?.status).toBe('failed')
    expect(stuckRun?.error).toContain('超时')
    const oldTask = db.prepare(
      `SELECT status FROM agent_tasks WHERE prompt = '先确认口径再统计' ORDER BY created_at ASC LIMIT 1`,
    ).get() as { status: string } | undefined
    expect(oldTask?.status).toBe('cancelled')
  }, 20_000)

  it('父 Agent 回合一直占着 running 时，重试窗口用尽后也会收口等待中的子 Agent', async () => {
    state.childCalls = 0
    state.rootCalls = 0
    state.hangWake = false
    const { db, deps, actor } = testEnv('s3')
    deps.config.agentWakeRetryLimit = 1
    deps.config.agentWakeRetryIntervalMs = 500
    await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '请让后台子 Agent 先问口径再统计' }],
      maxTokens: 16,
      sessionId: 's3',
      emit: () => {},
    })

    // 模拟父回合卡在模型/工具调用里：run 仍是 running，唤醒只能不断重试。
    const parentRun = db.prepare(
      `SELECT id FROM agent_runs
        WHERE agent_id = 'eab-main' AND session_id = 's3'
        ORDER BY started_at DESC LIMIT 1`,
    ).get() as { id: string } | undefined
    expect(parentRun?.id).toBeTruthy()
    db.prepare('UPDATE agent_runs SET status = ?, ended_at = NULL WHERE id = ?')
      .run('running', parentRun!.id)

    const deadline = Date.now() + 8000
    let fallbackTask: { prompt: string; status: string } | undefined
    let notice: { text: string } | undefined
    while (Date.now() < deadline) {
      fallbackTask = db.prepare(
        `SELECT prompt, status FROM agent_tasks
          WHERE prompt LIKE '%父 Agent 暂时无法答复%'
          ORDER BY created_at DESC LIMIT 1`,
      ).get() as { prompt: string; status: string } | undefined
      notice = db.prepare(
        `SELECT text FROM chat_messages
          WHERE session_id = 's3' AND role = 'assistant'
            AND text LIKE '%持续运行超过%'
          ORDER BY created_at DESC LIMIT 1`,
      ).get() as { text: string } | undefined
      if (fallbackTask && fallbackTask.status === 'succeeded' && notice) break
      await new Promise((resolve) => setTimeout(resolve, 80))
    }

    expect(fallbackTask?.prompt).toContain('请立即收口')
    expect(notice?.text).toContain('停止等待')
    const oldTask = db.prepare(
      `SELECT status FROM agent_tasks WHERE prompt = '先确认口径再统计' ORDER BY created_at ASC LIMIT 1`,
    ).get() as { status: string } | undefined
    expect(oldTask?.status).toBe('cancelled')
    const worker = db.prepare(
      `SELECT status FROM agent_workers
        WHERE team_id = 'session:s3' AND key = 'asker'`,
    ).get() as { status: string } | undefined
    expect(worker?.status).not.toBe('waiting')
  }, 20_000)
})
