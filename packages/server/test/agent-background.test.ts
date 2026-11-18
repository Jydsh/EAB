import { describe, expect, it, vi } from 'vitest'
import { migrate, openDatabase } from '@eab/storage'
import { SC } from '@eab/domain'

const state = vi.hoisted(() => ({
  rootCalls: 0,
  childCalls: 0,
  mode: 'wait' as 'wait' | 'wake' | 'progress' | 'timeout' | 'midrun' | 'plain',
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
        const prompt = messages[messages.length - 1]?.content ?? ''
        if (state.mode === 'progress' && prompt.includes('慢任务')) {
          // 模拟一个卡住的子 Agent：它的任务行保持 running，直到超时看门狗收尾。
          await new Promise(() => {})
        }
        if (state.mode === 'midrun' && prompt.includes('慢任务')) {
          // 慢任务在父唤醒模型运行期间结束，完成事件还没来得及被本批消费。
          await new Promise((resolve) => setTimeout(resolve, 550))
        }
        if (state.mode === 'timeout') {
          await new Promise(() => {})
        }
        options.onEvent?.({ type: 'content', text: '后台完成' })
        return { text: '后台完成', reasoning: '', toolCalls: [], promptTokens: 1, completionTokens: 1 }
      }
      state.rootCalls += 1
      const last = messages[messages.length - 1]?.content ?? ''
      if (state.mode === 'plain') {
        options.onEvent?.({ type: 'content', text: '汇总正文' })
        return { text: '汇总正文', reasoning: '', toolCalls: [], promptTokens: 1, completionTokens: 1 }
      }
      if (last.includes('【后台子 Agent 完成通知】')) {
        if (state.mode === 'midrun') {
          // 模型返回时另一个子 Agent 刚好结束，但完成事件还没进入本批收件箱。
          await new Promise((resolve) => setTimeout(resolve, 500))
          const internal = '（内部调度：quick 已回报，slow 仍在执行，等待其完成后统一汇总）'
          options.onEvent?.({ type: 'content', text: internal })
          return { text: internal, reasoning: '', toolCalls: [], promptTokens: 1, completionTokens: 1 }
        }
        options.onEvent?.({ type: 'content', text: '已被后台结果唤醒' })
        return { text: '已被后台结果唤醒', reasoning: '', toolCalls: [], promptTokens: 1, completionTokens: 1 }
      }
      if (state.rootCalls === 1) {
        const tasks = state.mode === 'progress' || state.mode === 'midrun'
          ? [
              { key: 'quick', title: '快任务', prompt: '快任务：整理简报' },
              { key: 'slow', title: '慢任务', prompt: '慢任务：继续处理几千条数据' },
            ]
          : [{ key: 'bg', title: '后台任务', prompt: '后台长任务' }]
        return {
          text: '',
          reasoning: '',
          toolCalls: [{
            id: 'bg-1',
            type: 'function',
            function: {
              name: 'agent_spawn',
              arguments: JSON.stringify({
                tasks,
                background: true,
              }),
            },
          }],
          promptTokens: 1,
          completionTokens: 1,
        }
      }
      if (state.mode === 'wake') {
        return { text: '', reasoning: '', toolCalls: [], promptTokens: 1, completionTokens: 1 }
      }
      if (state.rootCalls === 2) {
        return {
          text: '',
          reasoning: '',
          toolCalls: [{
            id: 'wait-1',
            type: 'function',
            function: {
              name: 'agent_wait',
              arguments: JSON.stringify({ timeoutSeconds: 2 }),
            },
          }],
          promptTokens: 1,
          completionTokens: 1,
        }
      }
      options.onEvent?.({ type: 'content', text: '后台汇总完成' })
      return { text: '后台汇总完成', reasoning: '', toolCalls: [], promptTokens: 1, completionTokens: 1 }
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
    .run('c1', '测试公司', 'test-company-bg', 'active', now)
  db.prepare('INSERT INTO departments (id, company_id, name, path, depth, order_no, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('d1', 'c1', '测试部门', '/d1', 1, 0, now)
  db.prepare('INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('u1', 'c1', 'd1', '/d1', '测试员工', 'active', now, now)
  db.prepare('INSERT INTO chat_sessions (id, company_id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('s1', 'c1', 'u1', '后台测试', now, now)
  return { db, deps, actor }
}

describe('后台派活与 agent_wait', () => {
  it('background:true 立即返回确认，父回合结束后由完成事件唤醒汇总', async () => {
    state.mode = 'wait'
    state.rootCalls = 0
    state.childCalls = 0
    const { deps, actor } = testEnv()
    const events: any[] = []
    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '后台并行处理这些资料' }],
      maxTokens: 16,
      emit: (event) => events.push(event),
    })

    // 网页前台不再让父 Agent 用 agent_wait 占住会话：后台派发后立即收口，
    // 子 Agent 的完成事件会走唤醒轮汇总（下一条用例覆盖）。
    expect(result?.text).toBe('已派给子 Agent，完成后我会把结果汇总给你。')
    expect(state.rootCalls).toBe(1)
    // 子 Agent 在后台异步执行，这里只验证父回合已经收口；子 Agent 是否真的跑完
    // 由下一条唤醒用例验证，避免在本条里等一个不属于这里的时序。
    const spawnCall = result?.toolCalls.find((call) => call.toolId === 'agent.spawn')
    expect(spawnCall?.status).toBe('done')
    expect(String(spawnCall?.summary)).toContain('"background":true')
    expect(result?.toolCalls.some((call) => call.toolId === 'agent.wait')).toBe(false)
  })

  it('一个子任务完成、另一个仍在运行时，主 Agent 写入可见进展而不是沉默', async () => {
    state.mode = 'progress'
    state.rootCalls = 0
    state.childCalls = 0
    const { db, deps, actor } = testEnv()
    deps.config.agentTaskTimeoutMs = 60_000
    const first = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '派两个员工，一个整理简报，一个处理几千条数据' }],
      maxTokens: 16,
      sessionId: 's1',
      emit: () => {},
    })
    expect(first?.text).toBe('已派给子 Agent，完成后我会把结果汇总给你。')
    expect((db.prepare('SELECT COUNT(*) AS n FROM agent_tasks').get() as { n: number }).n).toBe(2)

    const deadline = Date.now() + 4000
    let progress: { id: string; text: string; created_at: number; meta_json: string } | undefined
    while (Date.now() < deadline) {
      progress = db.prepare(
        `SELECT id, text, created_at, meta_json FROM chat_messages
          WHERE session_id = 's1' AND role = 'assistant'
            AND meta_json LIKE '%"progress":true%'
          ORDER BY created_at DESC LIMIT 1`,
      ).get() as { id: string; text: string; created_at: number; meta_json: string } | undefined
      if (progress?.text.includes('还有 1 个')) break
      await new Promise((resolve) => setTimeout(resolve, 80))
    }
    expect(progress?.text).toContain('已完成')
    expect(progress?.text).toContain('还有 1 个子 Agent 的结果待汇总')
    // 进度卡在派发时就落库，meta 必须带结构化计数，前端才能画进度条。
    const progressMeta = JSON.parse(progress?.meta_json ?? '{}') as {
      teamProgress?: { total: number; completed: number; remaining: number; state: string }
    }
    expect(progressMeta.teamProgress).toMatchObject({
      total: 2,
      completed: 1,
      remaining: 1,
      state: 'running',
    })
    // 子 Agent 的回报原文只留在团队预览，不转述到用户对话。
    expect(progress?.text).not.toContain('quick')
    // 唤醒轮不允许重新派活：任务数仍为 2，历史任务不会被 resume 拉起。
    expect((db.prepare('SELECT COUNT(*) AS n FROM agent_tasks').get() as { n: number }).n).toBe(2)
  })

  it('另一个子任务在唤醒模型运行中结束，也写可见进展而不是内部调度话术', async () => {
    state.mode = 'midrun'
    state.rootCalls = 0
    state.childCalls = 0
    const { db, deps, actor } = testEnv()
    deps.config.agentTaskTimeoutMs = 60_000
    const first = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '派两个员工，一个整理简报，一个处理几千条数据' }],
      maxTokens: 16,
      sessionId: 's1',
      emit: () => {},
    })
    expect(first?.text).toBe('已派给子 Agent，完成后我会把结果汇总给你。')

    const deadline = Date.now() + 5000
    let progress: { text: string } | undefined
    while (Date.now() < deadline) {
      progress = db.prepare(
        `SELECT text FROM chat_messages
          WHERE session_id = 's1' AND role = 'assistant'
            AND meta_json LIKE '%"progress":true%'
          ORDER BY created_at DESC LIMIT 1`,
      ).get() as { text: string } | undefined
      if (progress?.text.includes('还有 1 个')) break
      await new Promise((resolve) => setTimeout(resolve, 80))
    }
    expect(progress?.text).toContain('已完成')
    expect(progress?.text).toContain('还有 1 个子 Agent 的结果待汇总')
    // 子 Agent 的回报原文只留在团队预览，不转述到用户对话。
    expect(progress?.text).not.toContain('quick')

    // 本轮模型的“内部调度”正文不能被写进用户消息流。
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const leaked = db.prepare(
      `SELECT text FROM chat_messages
        WHERE session_id = 's1' AND role = 'assistant' AND text LIKE '%内部调度%'`,
    ).get() as { text: string } | undefined
    expect(leaked).toBeUndefined()
    expect((db.prepare('SELECT COUNT(*) AS n FROM agent_tasks').get() as { n: number }).n).toBe(2)
  }, 12_000)

  it('子 Agent 卡死时由总超时收尾为 failed，并唤醒父 Agent', async () => {
    state.mode = 'timeout'
    state.rootCalls = 0
    state.childCalls = 0
    const { db, deps, actor } = testEnv()
    deps.config.agentTaskTimeoutMs = 1_200
    await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '派一个员工处理很慢的几千条数据' }],
      maxTokens: 16,
      sessionId: 's1',
      emit: () => {},
    })

    const deadline = Date.now() + 5000
    let task: { status: string; error: string } | undefined
    let wake: { text: string } | undefined
    while (Date.now() < deadline) {
      task = db.prepare('SELECT status, error FROM agent_tasks ORDER BY created_at DESC LIMIT 1')
        .get() as { status: string; error: string } | undefined
      wake = db.prepare(
        `SELECT text FROM chat_messages
          WHERE session_id = 's1' AND role = 'assistant' AND meta_json LIKE '%backgroundWake%'
          ORDER BY created_at DESC LIMIT 1`,
      ).get() as { text: string } | undefined
      if (task?.status === 'failed' && wake?.text === '已被后台结果唤醒') break
      await new Promise((resolve) => setTimeout(resolve, 80))
    }
    expect(task?.status).toBe('failed')
    expect(task?.error).toContain('没有完成')
    expect(wake?.text).toBe('已被后台结果唤醒')
  })

  it('父回合结束后，后台任务完成事件会唤醒父 Agent 并写出汇总', async () => {
    state.mode = 'wake'
    state.rootCalls = 0
    state.childCalls = 0
    const { db, deps, actor } = testEnv()
    const first = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '后台并行处理这些资料' }],
      maxTokens: 16,
      sessionId: 's1',
      emit: () => {},
    })
    expect(first?.toolCalls.find((call) => call.toolId === 'agent.spawn')?.status).toBe('done')

    const deadline = Date.now() + 4000
    let wake: { text: string } | undefined
    while (Date.now() < deadline) {
      wake = db.prepare(
        `SELECT text FROM chat_messages
          WHERE session_id = 's1' AND role = 'assistant' AND meta_json LIKE '%backgroundWake%'
          ORDER BY created_at DESC LIMIT 1`,
      ).get() as { text: string } | undefined
      if (wake?.text === '已被后台结果唤醒') break
      await new Promise((resolve) => setTimeout(resolve, 80))
    }
    expect(wake?.text).toBe('已被后台结果唤醒')
    expect(state.rootCalls).toBeGreaterThanOrEqual(2)
  })

  it('后台汇报轮不会按出题路由压住正文', async () => {
    state.mode = 'plain'
    state.rootCalls = 0
    state.childCalls = 0
    const { deps, actor } = testEnv()
    const events: Array<{ type: string; text?: string }> = []
    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [
        // 系统提示词本身就带出题/题组说明，不能因此把普通“继续汇总”判成出题。
        { role: 'system', content: '用户要求出题、题组、上一题/下一题时，调用 ask_user。' },
        { role: 'user', content: '请继续汇总刚才两个员工的结果' },
      ],
      maxTokens: 16,
      sessionId: 's1',
      disableQuizRoute: true,
      emit: (event) => events.push(event),
    })
    expect(result?.text).toBe('汇总正文')
    expect(events.some((event) => event.type === 'content' && event.text === '正在生成题组卡…')).toBe(false)
  })
})
