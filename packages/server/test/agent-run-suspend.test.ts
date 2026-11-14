import { describe, expect, it } from 'vitest'
import { migrate, openDatabase } from '@eab/storage'
import {
  failSuspendedRun,
  loadSuspendedRun,
  resumeAgentRun,
  suspendAgentRun,
  sweepSuspendedRuns,
} from '../src/agent-runtime.js'

function testDb() {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  return db
}

function insertRun(db: ReturnType<typeof testDb>, id = 'run-1'): void {
  const now = Date.now()
  db.prepare(
    `INSERT INTO agent_runs
       (id, company_id, user_id, parent_run_id, agent_id, title, model_id, session_id, status, spent_tokens, started_at, created_at)
     VALUES (?, 'c1', 'u1', NULL, 'eab-main', '测试', 'm1', 's1', 'running', 0, ?, ?)`,
  ).run(id, now, now)
}

function insertJob(db: ReturnType<typeof testDb>, id: string, status: string): void {
  const now = Date.now()
  db.prepare(
    `INSERT INTO async_jobs
       (id, company_id, user_id, kind, title, status, payload_json, progress, total, attempts, created_at, updated_at)
     VALUES (?, 'c1', 'u1', 'tool.background', '后台工具', ?, '{}', 0, 1, 1, ?, ?)`,
  ).run(id, status, now, now)
}

describe('Agent run 挂起与恢复地基', () => {
  it('running 的 run 可以挂起，载荷可原样取回', () => {
    const db = testDb()
    insertRun(db, 'run-2')
    expect(suspendAgentRun(db, 'run-2', { jobId: 'job-1', state: { seq: 3, pendingCall: 'x' } })).toBe(true)
    const suspended = loadSuspendedRun(db, 'run-2')
    expect(suspended?.pendingJobId).toBe('job-1')
    expect(suspended?.state).toEqual({ seq: 3, pendingCall: 'x' })
    expect(suspended?.sessionId).toBe('s1')
  })

  it('重复挂起/非 running 的 run 不会被改状态', () => {
    const db = testDb()
    insertRun(db, 'run-3')
    suspendAgentRun(db, 'run-3', { jobId: 'job-1', state: {} })
    expect(suspendAgentRun(db, 'run-3', { jobId: 'job-2', state: {} })).toBe(false)
    expect(loadSuspendedRun(db, 'run-3')?.pendingJobId).toBe('job-1')
  })

  it('作业失败或丢失时，挂起 run 判 failed 并写明原因', () => {
    const db = testDb()
    insertRun(db, 'run-4')
    insertJob(db, 'job-failed', 'failed')
    suspendAgentRun(db, 'run-4', { jobId: 'job-failed', state: {} })
    expect(sweepSuspendedRuns(db)).toBe(1)
    const row = db.prepare(`SELECT status, error FROM agent_runs WHERE id = 'run-4'`).get() as {
      status: string
      error: string
    }
    expect(row.status).toBe('failed')
    expect(row.error).toContain('failed')
  })

  it('作业还在跑或已成功时保留挂起态，等待恢复', () => {
    const db = testDb()
    insertRun(db, 'run-5')
    insertJob(db, 'job-running', 'running')
    suspendAgentRun(db, 'run-5', { jobId: 'job-running', state: {} })
    expect(sweepSuspendedRuns(db)).toBe(0)

    insertRun(db, 'run-6')
    insertJob(db, 'job-done', 'succeeded')
    suspendAgentRun(db, 'run-6', { jobId: 'job-done', state: {} })
    expect(sweepSuspendedRuns(db)).toBe(0)
    expect(
      (db.prepare(`SELECT status FROM agent_runs WHERE id = 'run-6'`).get() as { status: string }).status,
    ).toBe('suspended')
  })

  it('作业记录完全丢失时同样判 failed', () => {
    const db = testDb()
    insertRun(db, 'run-7')
    suspendAgentRun(db, 'run-7', { jobId: 'job-missing', state: {} })
    expect(sweepSuspendedRuns(db)).toBe(1)
    expect(
      (db.prepare(`SELECT status FROM agent_runs WHERE id = 'run-7'`).get() as { status: string }).status,
    ).toBe('failed')
  })

  it('恢复：挂起态改回 running 并清空 pending 指针', () => {
    const db = testDb()
    insertRun(db, 'run-8')
    suspendAgentRun(db, 'run-8', { jobId: 'job-9', state: {} })
    expect(resumeAgentRun(db, 'run-8')).toBe(true)
    expect(loadSuspendedRun(db, 'run-8')).toBeNull()
    const row = db.prepare(`SELECT status, pending_job_id FROM agent_runs WHERE id = 'run-8'`).get() as {
      status: string
      pending_job_id: string | null
    }
    expect(row.status).toBe('running')
    expect(row.pending_job_id).toBeNull()
  })

  it('直接判定挂起 run 失败（供恢复流程放弃时使用）', () => {
    const db = testDb()
    insertRun(db, 'run-9')
    suspendAgentRun(db, 'run-9', { jobId: 'job-x', state: {} })
    expect(failSuspendedRun(db, 'run-9', '结果无法解析')).toBe(true)
    expect(loadSuspendedRun(db, 'run-9')).toBeNull()
  })
})
