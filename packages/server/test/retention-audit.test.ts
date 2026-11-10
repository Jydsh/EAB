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
