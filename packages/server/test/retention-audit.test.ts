import { describe, expect, it } from 'vitest'
import { appendAudit, migrate, openDatabase, verifyAuditChain } from '@eab/storage'
import { runRetention } from '../src/retention.js'

describe('保留清理：审计', () => {
  it('按独立审计天数剪掉最老记录，链仍完整', () => {
    const db = openDatabase({ path: ':memory:' })
    migrate(db)
    const now = Date.now()
    const day = 86_400_000
    appendAudit(db, { companyId: 'c1', action: 'old.a', result: 'success' }, now - 20 * day)
    appendAudit(db, { companyId: 'c1', action: 'old.b', result: 'success' }, now - 15 * day)
    appendAudit(db, { companyId: 'c1', action: 'keep', result: 'success' }, now)

    const result = runRetention(db, 90, 10)
    expect(result.deleted.auditLogs).toBe(2)
    expect(result.total).toBe(2)
    expect(result.audit.anchorSeq).toBe(2)
    expect(verifyAuditChain(db)).toMatchObject({ ok: true, checked: 1, pruned: 2 })

    db.close()
  })

  it('审计保留为 0 时不清理', () => {
    const db = openDatabase({ path: ':memory:' })
    migrate(db)
    const now = Date.now()
    appendAudit(db, { companyId: 'c1', action: 'old', result: 'success' }, now - 20 * 86_400_000)

    const result = runRetention(db, 0, 0)
    expect(result.skipped).toBe(true)
    expect(result.deleted.auditLogs).toBeUndefined()
    expect(verifyAuditChain(db).checked).toBe(1)

    db.close()
  })
})

describe('保留清理：渠道回合', () => {
  it('只清理已收口且过期的回合，运行中的保留给启动恢复', () => {
    const db = openDatabase({ path: ':memory:' })
    migrate(db)
    const now = Date.now()
    const day = 86_400_000
    const insert = db.prepare(
      `INSERT INTO channel_turns
         (id, company_id, provider, external_id, user_id, session_id, event_key, payload_json,
          status, attempts, started_at, updated_at)
       VALUES (?, 'c1', 'dingtalk', 'staff-1', 'u1', 's1', ?, '{}', ?, 0, ?, ?)`,
    )
    insert.run('old-completed', 'evt-old-completed', 'completed', now - 40 * day, now - 40 * day)
    insert.run('old-failed', 'evt-old-failed', 'failed', now - 40 * day, now - 40 * day)
    insert.run('old-running', 'evt-old-running', 'running', now - 40 * day, now - 40 * day)
    insert.run('keep-completed', 'evt-keep-completed', 'completed', now, now)

    const result = runRetention(db, 30)
    expect(result.deleted.channelTurns).toBe(2)
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM channel_turns WHERE id IN ('old-running', 'keep-completed')").get() as any).n,
    ).toBe(2)

    db.close()
  })
})
