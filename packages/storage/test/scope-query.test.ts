import { describe, expect, it } from 'vitest'
import { assertScoped, buildScopeFilter, buildSubject, predicateToSql } from '@eab/authz'
import { SC, type Scope, type Subject } from '@eab/domain'
import { migrate, openDatabase } from '@eab/storage'

/**
 * 这份测试证明一件关键的事：
 * 「同一条权限谓词，编译成 SQL 查数据库 与 在内存里逐条判定」结果必须一致。
 * 只要两者出现分歧，就说明存在"列表里看不到但直接点链接能打开"（或反之）的口子。
 */

function seededDb() {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)

  db.prepare("INSERT INTO companies (id, name, slug, created_at) VALUES ('c1', '甲公司', 'acme', 1)").run()
  db.prepare("INSERT INTO companies (id, name, slug, created_at) VALUES ('c2', '乙公司', 'beta', 1)").run()

  const dept = (id: string, company: string, parent: string | null, name: string, path: string) =>
    db
      .prepare(
        'INSERT INTO departments (id, company_id, parent_id, name, path, created_at) VALUES (?, ?, ?, ?, ?, 1)',
      )
      .run(id, company, parent, name, path)

  dept('d10', 'c1', null, '研发部', '/c1/d10/')
  dept('d23', 'c1', 'd10', '前端组', '/c1/d10/d23/')
  dept('d20', 'c1', null, '市场部', '/c1/d20/')
  dept('x1', 'c2', null, '乙公司部门', '/c2/x1/')

  const user = (id: string, company: string, deptId: string, path: string, name: string) =>
    db
      .prepare(
        `INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', 1, 1)`,
      )
      .run(id, company, deptId, path, name)

  user('u1', 'c1', 'd10', '/c1/d10/', '张三')
  user('u2', 'c1', 'd10', '/c1/d10/', '李四')
  user('u3', 'c1', 'd20', '/c1/d20/', '王五')
  user('u4', 'c2', 'x1', '/c2/x1/', '赵六')

  return db
}

function queryUserIds(db: ReturnType<typeof seededDb>, subject: Subject, action: Scope): string[] {
  const filter = buildScopeFilter(subject, action, 'user')
  assertScoped(filter, subject)
  const compiled = predicateToSql(filter.predicate, {
    allowedFields: ['company_id', 'dept_path', 'id'],
  })
  const rows = db
    .prepare(`SELECT id FROM users WHERE ${compiled.sql} ORDER BY id`)
    .all(...(compiled.params as string[])) as unknown as Array<{ id: string }>
  return rows.map((row) => row.id)
}

const member = buildSubject({
  userId: 'u1',
  companyId: 'c1',
  deptId: 'd10',
  deptPath: '/c1/d10/',
  roles: ['member'],
})

const deptAdmin = buildSubject({
  userId: 'u1',
  companyId: 'c1',
  deptId: 'd10',
  deptPath: '/c1/d10/',
  roles: ['dept_admin'],
})

const companyAdmin = buildSubject({
  userId: 'u1',
  companyId: 'c1',
  deptId: 'd10',
  deptPath: '/c1/d10/',
  roles: ['company_admin'],
})

describe('权限谓词在实际 SQL 上的效果', () => {
  it('普通员工只能列出自己（用他真有的 workspace:read 举例）', () => {
    const db = seededDb()
    expect(queryUserIds(db, member, SC.WORKSPACE_READ)).toEqual(['u1'])
    db.close()
  })

  it('普通员工没有 org:member:read 时，过滤器直接是空集', () => {
    const db = seededDb()
    const filter = buildScopeFilter(member, SC.ORG_MEMBER_READ, 'user')
    expect(filter.reason).toBe('missing-scope')
    expect(queryUserIds(db, member, SC.ORG_MEMBER_READ)).toEqual([])
    db.close()
  })

  it('部门管理员列出本部门及下级（不含兄弟部门、不含他公司）', () => {
    const db = seededDb()
    expect(queryUserIds(db, deptAdmin, SC.ORG_MEMBER_READ)).toEqual(['u1', 'u2'])
    db.close()
  })

  it('公司管理员列出本公司全部（不含他公司）', () => {
    const db = seededDb()
    expect(queryUserIds(db, companyAdmin, SC.ORG_MEMBER_READ)).toEqual(['u1', 'u2', 'u3'])
    db.close()
  })

  it('过滤器确实在起作用（不过滤时是 4 条）', () => {
    const db = seededDb()
    const all = db.prepare('SELECT id FROM users ORDER BY id').all() as unknown as Array<{ id: string }>
    expect(all.map((r) => r.id)).toEqual(['u1', 'u2', 'u3', 'u4'])
    db.close()
  })
})

describe('SQL 结果与 PDP 决策一致', () => {
  interface Row {
    id: string
    company_id: string
    dept_path: string
  }

  const cases: Array<[string, Subject, Scope, string[]]> = [
    ['member', member, SC.WORKSPACE_READ, ['u1']],
    ['dept_admin', deptAdmin, SC.ORG_MEMBER_READ, ['u1', 'u2']],
    ['company_admin', companyAdmin, SC.ORG_MEMBER_READ, ['u1', 'u2', 'u3']],
  ]

  for (const [name, subject, action, expected] of cases) {
    it(`${name}：列表可见 == 逐条放行`, async () => {
      const { decide } = await import('@eab/authz')
      const db = seededDb()
      const rows = db.prepare('SELECT id, company_id, dept_path FROM users ORDER BY id').all() as unknown as Row[]
      const visible = queryUserIds(db, subject, action)

      for (const row of rows) {
        const allowed = decide(subject, action, {
          kind: 'user',
          id: row.id,
          companyId: row.company_id,
          scopeType: 'user',
          scopeId: row.id,
          ownerId: row.id,
          deptPath: row.dept_path,
        }).result
        const inList = visible.includes(row.id)
        expect(inList, `${name} 对 ${row.id} 的判定与列表不一致`).toBe(allowed === 'allow')
      }
      expect(visible).toEqual(expected)
      db.close()
    })
  }
})
