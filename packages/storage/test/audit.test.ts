import { describe, expect, it } from 'vitest'
import { appendAudit, canonicalJson, migrate, openDatabase, verifyAuditChain } from '@eab/storage'

function freshDb() {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  return db
}

describe('审计流', () => {
  it('顺序追加并形成哈希链', () => {
    const db = freshDb()
    const first = appendAudit(db, { companyId: 'c1', action: 'user.create', result: 'success' }, 1000)
    const second = appendAudit(db, { companyId: 'c1', action: 'chat.use', result: 'allow' }, 1001)
    const third = appendAudit(db, { companyId: 'c1', action: 'tool.invoke', result: 'deny', detail: { tool: 'x' } }, 1002)

    expect([first.seq, second.seq, third.seq]).toEqual([1, 2, 3])
    expect(second.hash).not.toBe(first.hash)

    const rows = db.prepare('SELECT prev_hash, hash FROM audit_logs ORDER BY seq').all() as unknown as Array<{
      prev_hash: string
      hash: string
    }>
    expect(rows[0]?.prev_hash).toBe('EAB-GENESIS')
    expect(rows[1]?.prev_hash).toBe(rows[0]?.hash)
    expect(rows[2]?.prev_hash).toBe(rows[1]?.hash)

    const verified = verifyAuditChain(db)
    expect(verified.ok).toBe(true)
    expect(verified.checked).toBe(3)
    db.close()
  })

  it('规范化 JSON 与键顺序无关（哈希可复算）', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }))
    expect(canonicalJson([1, 2])).toBe('[1,2]')
    expect(canonicalJson(undefined)).toBe('null')
  })

  it('链被篡改（直接插入坏行）能被检测出来', () => {
    const db = freshDb()
    appendAudit(db, { companyId: 'c1', action: 'a', result: 'success' }, 1000)
    appendAudit(db, { companyId: 'c1', action: 'b', result: 'success' }, 1001)

    // 绕过应用层，手工插一行：seq 接得上，但 hash 是假的
    db.prepare(
      `INSERT INTO audit_logs (id, seq, company_id, action, result, prev_hash, hash, created_at)
       VALUES ('rogue', 3, 'c1', 'c', 'success', 'fake', 'fake', 1002)`,
    ).run()

    const verified = verifyAuditChain(db)
    expect(verified.ok).toBe(false)
    expect(verified.reasons.length).toBeGreaterThan(0)
    expect(verified.brokenAt).not.toBeNull()
    db.close()
  })

  it('内容被改动会被检测（模拟数据库文件被改写）', () => {
    const db = freshDb()
    appendAudit(db, { companyId: 'c1', action: 'secret.read', result: 'success' }, 1000)
    // 正常路径改不了（有 trigger）。这里直接绕过 trigger：删掉触发器后改，再恢复，
    // 用来验证"即便数据库层被绕过，哈希链仍能发现"。
    db.exec('DROP TRIGGER trg_audit_no_update')
    db.prepare("UPDATE audit_logs SET action = 'harmless' WHERE seq = 1").run()
    db.exec(`
      CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_logs
      BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
    `)

    const verified = verifyAuditChain(db)
    expect(verified.ok).toBe(false)
    expect(verified.reasons.join('|')).toContain('hash 不匹配')
    db.close()
  })
})
