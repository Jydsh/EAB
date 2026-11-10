import { describe, expect, it } from 'vitest'
import { migrate, openDatabase, tableExists } from '@eab/storage'

const CORE_TABLES = [
  'companies',
  'departments',
  'users',
  'user_identities',
  'roles',
  'role_scopes',
  'user_roles',
  'authz_overrides',
  'sessions',
  'audit_logs',
  'system_meta',
]

describe('迁移', () => {
  it('空库迁移后核心表齐备', () => {
    const db = openDatabase({ path: ':memory:' })
    const result = migrate(db)
    expect(result.applied.length).toBeGreaterThan(0)
    for (const table of CORE_TABLES) {
      expect(tableExists(db, table), `缺表: ${table}`).toBe(true)
    }
    db.close()
  })

  it('重复执行幂等（不重复建表、不报错）', () => {
    const db = openDatabase({ path: ':memory:' })
    migrate(db)
    const second = migrate(db)
    expect(second.applied).toEqual([])
    expect(second.skipped.length).toBeGreaterThan(0)
    db.close()
  })

  it('迁移版本被记录', () => {
    const db = openDatabase({ path: ':memory:' })
    migrate(db, { now: 1_760_000_000_000 })
    const rows = db.prepare('SELECT name, applied_at FROM _migrations').all() as unknown as Array<{
      name: string
      applied_at: number
    }>
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0]?.applied_at).toBe(1_760_000_000_000)
    db.close()
  })

  it('外键约束生效（脏数据进不去）', () => {
    const db = openDatabase({ path: ':memory:' })
    migrate(db)
    expect(() =>
      db
        .prepare(
          `INSERT INTO users (id, company_id, dept_id, dept_path, name, created_at, updated_at)
           VALUES ('u_bad', 'c_missing', 'd_missing', '/c_missing/', 'bad', 1, 1)`,
        )
        .run(),
    ).toThrow()
    db.close()
  })

  it('审计表在数据库层禁止 UPDATE / DELETE', () => {
    const db = openDatabase({ path: ':memory:' })
    migrate(db)
    db.prepare(
      `INSERT INTO audit_logs (id, seq, company_id, action, result, prev_hash, hash, created_at)
       VALUES ('a1', 1, 'c1', 'test.action', 'success', 'EAB-GENESIS', 'h1', 1)`,
    ).run()
    expect(() => db.prepare("UPDATE audit_logs SET action = 'tampered'").run()).toThrow()
    expect(() => db.prepare('DELETE FROM audit_logs').run()).toThrow()
    db.close()
  })
})
