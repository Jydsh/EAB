import { describe, expect, it } from 'vitest'
import { migrate, openDatabase } from '@eab/storage'
import { toolDurationStats } from '../src/tool-metrics.js'

function testDb() {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  return db
}

function insertRun(db: ReturnType<typeof testDb>, runId: string): void {
  const now = Date.now()
  db.prepare(
    `INSERT INTO agent_runs
       (id, company_id, user_id, agent_id, title, model_id, session_id, status, spent_tokens, started_at, ended_at, created_at)
     VALUES (?, 'c1', 'u1', 'eab-main', '测试', 'm1', 's1', 'succeeded', 0, ?, ?, ?)`,
  ).run(runId, now, now, now)
}

let seq = 0
function insertStep(
  db: ReturnType<typeof testDb>,
  runId: string,
  kind: string,
  toolId: string | null,
  durationMs: number,
  createdAt = Date.now(),
): void {
  seq += 1
  db.prepare(
    `INSERT INTO agent_steps
       (id, run_id, seq, kind, tool_id, name, status, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'done', ?, ?)`,
  ).run(`s${seq}`, runId, seq, kind, toolId, toolId, durationMs, createdAt)
}

describe('工具耗时聚合', () => {
  it('按工具给出 p50 / p95 / 最长 / 超阈值次数，且不计模型步骤', () => {
    const db = testDb()
    insertRun(db, 'r1')
    for (const ms of [10, 20, 30, 40, 50, 60, 70, 80, 90, 3000]) insertStep(db, 'r1', 'tool', 'doc.read', ms)
    insertStep(db, 'r1', 'tool', 'mail.send', 12)
    insertStep(db, 'r1', 'model', null, 99_999)

    const stats = toolDurationStats(db, { days: 7, thresholdMs: 8000 })
    expect(stats.totalCalls).toBe(11)
    expect(stats.totalSlowCalls).toBe(0)

    const doc = stats.tools.find((row) => row.toolId === 'doc.read')!
    expect(doc.calls).toBe(10)
    expect(doc.maxMs).toBe(3000)
    // 10 个样本：p50 取第 6 个（60），p95 取第 10 个（3000）
    expect(doc.p50Ms).toBe(60)
    expect(doc.p95Ms).toBe(3000)

    const mail = stats.tools.find((row) => row.toolId === 'mail.send')!
    expect(mail.calls).toBe(1)
    expect(mail.p50Ms).toBe(12)
    expect(mail.p95Ms).toBe(12)
  })

  it('超过阈值的调用单独计数，窗口外的样本不计', () => {
    const db = testDb()
    insertRun(db, 'r2')
    insertStep(db, 'r2', 'tool', 'office.convert', 12_000)
    insertStep(db, 'r2', 'tool', 'office.convert', 9_500)
    insertStep(db, 'r2', 'tool', 'office.convert', 100)
    insertStep(db, 'r2', 'tool', 'office.convert', 40_000, Date.now() - 30 * 86_400_000)

    const stats = toolDurationStats(db, { days: 7, thresholdMs: 8000 })
    const row = stats.tools.find((item) => item.toolId === 'office.convert')!
    expect(row.calls).toBe(3)
    expect(row.slowCalls).toBe(2)
    expect(row.maxMs).toBe(12_000)
    expect(stats.totalSlowCalls).toBe(2)
  })
})
