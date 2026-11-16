import { afterEach, describe, expect, it } from 'vitest'
import { migrate, openDatabase, type Db } from '@eab/storage'
import { actorFor, roleCodesOf } from '../src/session.js'

const dbs: Db[] = []

afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
})

function testDb(): Db {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  dbs.push(db)
  const now = Date.now()
  db.prepare(
    `INSERT INTO companies (id, name, slug, status, created_at)
     VALUES ('c1', '测试公司', 'test', 'active', ?)`,
  ).run(now)
  db.prepare(
    `INSERT INTO departments (id, company_id, parent_id, name, path, depth, created_at)
     VALUES ('d1', 'c1', NULL, '根部门', '/c1/d1', 1, ?)`,
  ).run(now)
  db.prepare(
    `INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at)
     VALUES ('u1', 'c1', 'd1', '/c1/d1', '测试成员', 'active', ?, ?)`,
  ).run(now, now)
  for (const [id, code] of [
    ['r-perm', 'member'],
    ['r-future', 'kb_admin'],
    ['r-expired', 'auditor'],
    ['r-null', 'guest'],
  ]) {
    db.prepare(
      `INSERT INTO roles (id, company_id, code, name, data_scope, builtin, created_at)
       VALUES (?, 'c1', ?, ?, 'company', 1, ?)`,
    ).run(id, code, code, now)
  }
  return db
}

describe('角色到期过滤', () => {
  it('永久角色、未到期角色保留，已到期角色不再返回', () => {
    const db = testDb()
    const now = Date.now()
    const insert = db.prepare(
      `INSERT INTO user_roles (user_id, role_id, granted_by, granted_at, expires_at)
       VALUES ('u1', ?, 'test', ?, ?)`,
    )
    insert.run('r-perm', now, null)
    insert.run('r-future', now, now + 60_000)
    insert.run('r-expired', now, now - 1)
    insert.run('r-null', now, null)

    expect(roleCodesOf(db, 'u1')).toEqual(['guest', 'kb_admin', 'member'])
    expect(roleCodesOf(db, 'u1', now + 120_000)).toEqual(['guest', 'member'])
  })

  it('续期后角色重新可用，到期后 actorFor 不再包含该角色', () => {
    const db = testDb()
    const now = Date.now()
    db.prepare(
      `INSERT INTO user_roles (user_id, role_id, granted_by, granted_at, expires_at)
       VALUES ('u1', 'r-future', 'test', ?, ?)`,
    ).run(now, now - 1)

    expect(actorFor(db, {
      id: 'u1',
      name: '测试成员',
      title: null,
      avatar: null,
      deptId: 'd1',
      deptPath: '/c1/d1',
      deptName: '根部门',
      companyId: 'c1',
      companyName: '测试公司',
    }).subject.roles).not.toContain('kb_admin')

    db.prepare(
      `UPDATE user_roles SET expires_at = ? WHERE user_id = 'u1' AND role_id = 'r-future'`,
    ).run(now + 60_000)
    expect(roleCodesOf(db, 'u1')).toContain('kb_admin')
  })
})

