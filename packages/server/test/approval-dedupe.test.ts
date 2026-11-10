import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase, migrate } from '@eab/storage'
import { ulid } from '@eab/domain'
import type { Db } from '@eab/storage'

const dbs: Db[] = []

afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
})

function testDb(): Db {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  db.exec('PRAGMA foreign_keys = OFF')
  dbs.push(db)
  return db
}

function insertPending(db: Db, id: string, resourceId: string, expiresAt: number | null): void {
  db.prepare(
    `INSERT INTO approvals (id, company_id, requester_user_id, action, resource_type, resource_id, payload_json, status, created_at, expires_at)
     VALUES (?, 'c1', 'u1', 'tool:admin.password.reset', 'user', ?, '{}', 'pending', ?, ?)`,
  ).run(id, resourceId, Date.now(), expiresAt)
}

describe('审批 pending 去重', () => {
  it('同一公司、申请人、动作、资源并发插入 10 次，只保留 1 条 pending', () => {
    const db = testDb()
    const expiresAt = Date.now() + 30 * 60 * 1000
    for (let i = 0; i < 10; i += 1) {
      try {
        insertPending(db, `approval-${i}`, 'target-user', expiresAt)
      } catch {
        // 唯一索引拒绝重复 pending，模拟并发插入冲突。
      }
    }
    const row = db
      .prepare(
        `SELECT COUNT(*) AS c FROM approvals
          WHERE company_id = 'c1' AND requester_user_id = 'u1' AND action = 'tool:admin.password.reset'
            AND resource_id = 'target-user' AND status = 'pending'`,
      )
      .get() as { c: number }
    expect(row.c).toBe(1)
  })

  it('过期的 pending 标成 expired 后，同一资源可以重新申请', () => {
    const db = testDb()
    insertPending(db, ulid(), 'target-user', Date.now() - 1000)
    db.prepare(
      `UPDATE approvals SET status = 'expired', decided_by = 'system:expired', decided_at = ?
        WHERE company_id = 'c1' AND requester_user_id = 'u1' AND status = 'pending'`,
    ).run(Date.now())

    insertPending(db, ulid(), 'target-user', Date.now() + 30 * 60 * 1000)
    const pending = db
      .prepare(
        `SELECT COUNT(*) AS c FROM approvals
          WHERE company_id = 'c1' AND requester_user_id = 'u1' AND action = 'tool:admin.password.reset'
            AND resource_id = 'target-user' AND status = 'pending'`,
      )
      .get() as { c: number }
    expect(pending.c).toBe(1)
  })
})
