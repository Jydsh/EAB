import { describe, expect, it } from 'vitest'
import { migrate, openDatabase } from '@eab/storage'
import { runRetention } from '../src/retention.js'

function testDb() {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  return db
}

const DAY = 86_400_000

function insertRun(
  db: ReturnType<typeof testDb>,
  id: string,
  status: string,
  ageMs: number | null,
): void {
  const started = Date.now() - (ageMs ?? 0)
  const ended = status === 'running' || status === 'suspended' ? null : started
  db.prepare(
    `INSERT INTO agent_runs
       (id, company_id, user_id, agent_id, title, model_id, session_id, status, spent_tokens, started_at, ended_at, created_at)
     VALUES (?, 'c1', 'u1', 'eab-main', '测试', 'm1', 's1', ?, 0, ?, ?, ?)`,
  ).run(id, status, started, ended, started)
}

function insertStep(db: ReturnType<typeof testDb>, runId: string, seq: number): void {
  db.prepare(
    `INSERT INTO agent_steps (id, run_id, seq, kind, status, duration_ms, created_at)
     VALUES (?, ?, ?, 'tool', 'done', 1, ?)`,
  ).run(`${runId}-step-${seq}`, runId, seq, Date.now())
}

describe('Agent 运行轨迹按天清理', () => {
  it('只删已结束且超过保留期的 run 与步骤', () => {
    const db = testDb()
    insertRun(db, 'old-succeeded', 'succeeded', 30 * DAY)
    insertStep(db, 'old-succeeded', 1)
    insertStep(db, 'old-succeeded', 2)
    insertRun(db, 'old-failed', 'failed', 20 * DAY)
    insertRun(db, 'recent-succeeded', 'succeeded', 1 * DAY)
    insertRun(db, 'old-running', 'running', 30 * DAY)
    insertRun(db, 'old-suspended', 'suspended', 30 * DAY)

    const result = runRetention(db, 0, 0, 7)
    expect(result.agentDays).toBe(7)
    expect(result.deleted.agentRuns).toBe(2)
    expect(result.deleted.agentSteps).toBe(2)

    const left = db.prepare(`SELECT id FROM agent_runs ORDER BY id`).all() as unknown as Array<{ id: string }>
    expect(left.map((row) => row.id)).toEqual(['old-running', 'old-suspended', 'recent-succeeded'])
  })

  it('保留天数为 0 时不清理任何轨迹', () => {
    const db = testDb()
    insertRun(db, 'old-succeeded', 'succeeded', 300 * DAY)
    insertStep(db, 'old-succeeded', 1)
    const result = runRetention(db, 0, 0, 0)
    expect(result.deleted.agentRuns).toBeUndefined()
    expect(result.deleted.agentSteps).toBeUndefined()
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM agent_runs`).get() as { n: number }).n,
    ).toBe(1)
  })
})
