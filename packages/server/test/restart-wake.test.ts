import { describe, expect, it, vi } from 'vitest'
import { migrate, openDatabase } from '@eab/storage'

const modelState = vi.hoisted(() => ({ calls: 0, prompts: [] as string[] }))

vi.mock('../src/llm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm.js')>()
  return {
    ...actual,
    callModelStream: vi.fn(async (
      _db: unknown,
      _path: unknown,
      _company: unknown,
      _model: unknown,
      _messages: Array<{ role: string; content: string }>,
      options?: { onEvent?: (event: { type: 'content' | 'reasoning'; text: string }) => void },
    ) => {
      modelState.calls += 1
      const last = _messages[_messages.length - 1]
      modelState.prompts.push(String(last?.content || ''))
      options?.onEvent?.({ type: 'content', text: '收到：已从检查点继续' })
      return {
        text: '收到：已从检查点继续',
        reasoning: '',
        toolCalls: [],
        promptTokens: 1,
        completionTokens: 1,
      }
    }),
  }
})

import { AgentTeamStore, listRestartRecoveredTasks, recoverInterruptedAgentTasks } from '../src/agent-team.js'
import { recoverRestartTaskWakes } from '../src/routes/chat.js'

function seed() {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  const now = Date.now()
  db.prepare(
    `INSERT INTO companies (id, name, slug, status, created_at) VALUES ('c1', '测试公司', 'test-restart', 'active', ?)`,
  ).run(now)
  db.prepare(
    `INSERT INTO departments (id, company_id, name, path, depth, order_no, created_at)
     VALUES ('d1', 'c1', '测试部门', '/c1/d1', 1, 0, ?)`,
  ).run(now)
  db.prepare(
    `INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at)
     VALUES ('u1', 'c1', 'd1', '/c1/d1', '测试员工', 'active', ?, ?)`,
  ).run(now, now)
  db.prepare(
    `INSERT INTO chat_sessions (id, company_id, user_id, title, created_at, updated_at)
     VALUES ('s1', 'c1', 'u1', '重启恢复', ?, ?)`,
  ).run(now, now)
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
  } as unknown as Parameters<typeof recoverRestartTaskWakes>[0]
  return { db, deps }
}

describe('服务重启中断任务唤醒', () => {
  it('只叫醒本次重启收尾的任务，并由父 Agent 写出续跑结论', async () => {
    const { db, deps } = seed()
    const team = new AgentTeamStore({ db, teamId: 'session:s1', companyId: 'c1', userId: 'u1' })
    team.registerWorker({ key: 'producer', name: 'Pro', index: 1 })
    const task = team.createTask({
      workerKey: 'producer',
      prompt: '把全量 6468 条按人员统计',
      parentRunId: 'run-parent-1',
    })
    db.prepare('UPDATE agent_tasks SET model_id = ? WHERE id = ?').run('model_test', task.id)
    team.markTaskRunning(task.id, 'child-1')
    team.markWorkerRun('producer', 'child-1', Date.now())
    // 真实中断任务会带 `agent_runs.resume_state_json`；唤醒提示必须据此优先指向 agent_resume。
    db.prepare(
      `INSERT INTO agent_runs (id, company_id, user_id, agent_id, session_id, status, started_at, created_at)
       VALUES ('child-1', 'c1', 'u1', 'producer', 's1', 'cancelled', ?, ?)`,
    ).run(Date.now(), Date.now())
    db.prepare('UPDATE agent_runs SET resume_state_json = ? WHERE id = ?').run(
      JSON.stringify({
        messages: [
          { role: 'user', content: '把全量 6468 条按人员统计' },
          { role: 'assistant', content: '已完成第 3 轮，下一步 batch_analyze' },
        ],
        turnId: 'child-1',
        prompt: '把全量 6468 条按人员统计',
      }),
      'child-1',
    )
    recoverInterruptedAgentTasks(db, Date.now())

    expect(listRestartRecoveredTasks(db).map((item) => item.id)).toEqual([task.id])
    expect(await recoverRestartTaskWakes(deps)).toBe(1)

    const deadline = Date.now() + 4000
    let wake: { text: string } | undefined
    while (Date.now() < deadline) {
      wake = db.prepare(
        `SELECT text FROM chat_messages
          WHERE session_id = 's1' AND role = 'assistant' AND meta_json LIKE '%backgroundWake%'
          ORDER BY created_at DESC LIMIT 1`,
      ).get() as { text: string } | undefined
      if (wake) break
      await new Promise((resolve) => setTimeout(resolve, 80))
    }
    expect(modelState.calls).toBeGreaterThan(0)
    expect(modelState.prompts.some((text) => text.includes('agent_resume') && text.includes('可用检查点'))).toBe(true)
    expect(wake?.text).toBe('收到：已从检查点继续')
    expect(db.prepare(
      'SELECT wake_at FROM agent_tasks WHERE id = ?',
    ).get(task.id)).toMatchObject({ wake_at: expect.any(Number) })
  })
})
