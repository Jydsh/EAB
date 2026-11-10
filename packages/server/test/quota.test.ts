import { describe, expect, it } from 'vitest'
import { openDatabase, migrate } from '@eab/storage'
import { EC } from '@eab/domain'
import { assertChatQuota, monthNow, scopeUsage, loadQuota } from '../src/quota.js'

function seededDb() {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  const now = Date.now()
  db.prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)').run(
    'c1',
    '甲科技',
    'jia',
    'active',
    now,
  )
  db.prepare(
    'INSERT INTO departments (id, company_id, parent_id, name, path, depth, order_no, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('d_root', 'c1', null, '甲科技', '/c1/d_root/', 1, 0, now)
  db.prepare(
    'INSERT INTO departments (id, company_id, parent_id, name, path, depth, order_no, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('d_child', 'c1', 'd_root', '研发部', '/c1/d_root/d_child/', 2, 1, now)
  db.prepare(
    'INSERT INTO departments (id, company_id, parent_id, name, path, depth, order_no, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('d_other', 'c1', 'd_root', '市场部', '/c1/d_root/d_other/', 2, 2, now)
  db.prepare(
    `INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).run('u1', 'c1', 'd_child', '/c1/d_root/d_child/', '张伟', now, now)
  db.prepare(
    `INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).run('u2', 'c1', 'd_other', '/c1/d_root/d_other/', '王芳', now, now)
  return db
}

const month = monthNow()

function bump(db: ReturnType<typeof seededDb>, userId: string, requests: number, prompt: number, completion: number) {
  db.prepare(
    `INSERT INTO usage_daily (company_id, user_id, day, requests, prompt_tokens, completion_tokens)
     VALUES ('c1', ?, ?, ?, ?, ?)`,
  ).run(userId, `${month}-01`, requests, prompt, completion)
}

function setQuota(db: ReturnType<typeof seededDb>, scopeType: string, scopeId: string, requests: number | null, mode = 'hard') {
  db.prepare(
    `INSERT INTO usage_quotas (company_id, scope_type, scope_id, monthly_requests, monthly_tokens, mode, enabled, updated_at)
     VALUES ('c1', ?, ?, ?, NULL, ?, 1, ?)`,
  ).run(scopeType, scopeId, requests, mode, Date.now())
}

describe('月度额度', () => {
  it('按成员 / 部门（含下级）/ 公司聚合用量', () => {
    const db = seededDb()
    bump(db, 'u1', 3, 100, 50)
    bump(db, 'u2', 2, 40, 20)
    expect(scopeUsage(db, { companyId: 'c1', month, scopeType: 'user', scopeId: 'u1' })).toMatchObject({
      requests: 3,
      totalTokens: 150,
    })
    expect(scopeUsage(db, {
      companyId: 'c1',
      month,
      scopeType: 'dept',
      scopeId: 'd_root',
      deptPath: '/c1/d_root/',
    })).toMatchObject({ requests: 5, totalTokens: 210 })
    expect(scopeUsage(db, {
      companyId: 'c1',
      month,
      scopeType: 'dept',
      scopeId: 'd_child',
      deptPath: '/c1/d_root/d_child/',
    })).toMatchObject({ requests: 3 })
    expect(scopeUsage(db, { companyId: 'c1', month, scopeType: 'company', scopeId: 'c1' })).toMatchObject({
      requests: 5,
    })
  })

  it('成员硬额度用尽时拒绝，并给出用了多少 / 上限多少', () => {
    const db = seededDb()
    bump(db, 'u1', 2, 10, 10)
    setQuota(db, 'user', 'u1', 2, 'hard')
    expect(loadQuota(db, 'c1', 'user', 'u1')).toMatchObject({ requests: 2, mode: 'hard' })
    let caught: unknown
    try {
      assertChatQuota(db, {
        companyId: 'c1',
        userId: 'u1',
        deptId: 'd_child',
        deptPath: '/c1/d_root/d_child/',
        month,
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as { code?: string }).code).toBe(EC.QUOTA_EXCEEDED)
    expect((caught as { details?: { used?: number; limit?: number } }).details).toMatchObject({ used: 2, limit: 2 })
  })

  it('软模式只记录不拦截；未设置额度时放行', () => {
    const db = seededDb()
    bump(db, 'u1', 9, 10, 10)
    setQuota(db, 'user', 'u1', 1, 'soft')
    expect(() =>
      assertChatQuota(db, {
        companyId: 'c1',
        userId: 'u1',
        deptId: 'd_child',
        deptPath: '/c1/d_root/d_child/',
        month,
      }),
    ).not.toThrow()
    db.prepare('DELETE FROM usage_quotas').run()
    expect(() =>
      assertChatQuota(db, {
        companyId: 'c1',
        userId: 'u1',
        deptId: 'd_child',
        deptPath: '/c1/d_root/d_child/',
        month,
      }),
    ).not.toThrow()
  })

  it('部门额度拦住整个部门（含下级）', () => {
    const db = seededDb()
    bump(db, 'u1', 1, 10, 10)
    bump(db, 'u2', 1, 10, 10)
    setQuota(db, 'dept', 'd_root', 2)
    expect(() =>
      assertChatQuota(db, {
        companyId: 'c1',
        userId: 'u1',
        deptId: 'd_child',
        deptPath: '/c1/d_root/d_child/',
        month,
      }),
    ).toThrow(/部门「甲科技」本月对话额度已用完/)
  })
})
