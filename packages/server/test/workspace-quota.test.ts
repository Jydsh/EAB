import { describe, expect, it } from 'vitest'
import { openDatabase } from '@eab/storage'
import { resolveUserWorkspaceQuota, workspaceCapacity } from '../src/workspace-quota.js'

function memoryDb() {
  const db = openDatabase({ path: ':memory:' })
  db.exec(`
    CREATE TABLE roles (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      code TEXT NOT NULL,
      deleted_at INTEGER
    );
    CREATE TABLE user_roles (
      user_id TEXT NOT NULL,
      role_id TEXT NOT NULL
    );
    CREATE TABLE workspace_quota_policies (
      company_id TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      limit_bytes INTEGER NOT NULL,
      file_limit_bytes INTEGER NOT NULL,
      PRIMARY KEY (company_id, scope_type, scope_id)
    );
  `)
  return db
}

describe('个人工作区配额策略', () => {
  it('没有单独配置时落到默认 500 MB / 50 MB', () => {
    const db = memoryDb()
    const quota = resolveUserWorkspaceQuota(db, 'c1', 'u1')
    expect(quota).toMatchObject({
      source: 'default',
      limitBytes: 500 * 1024 * 1024,
      fileLimitBytes: 50 * 1024 * 1024,
    })
  })

  it('角色配置生效，多角色取容量较大的一组', () => {
    const db = memoryDb()
    db.prepare('INSERT INTO roles (id, company_id, code) VALUES (?, ?, ?)').run('r1', 'c1', 'member')
    db.prepare('INSERT INTO roles (id, company_id, code) VALUES (?, ?, ?)').run('r2', 'c1', 'leader')
    db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run('u1', 'r1')
    db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run('u1', 'r2')
    db.prepare(
      `INSERT INTO workspace_quota_policies
         (company_id, scope_type, scope_id, limit_bytes, file_limit_bytes) VALUES (?, 'role', ?, ?, ?)`,
    ).run('c1', 'member', 100, 20)
    db.prepare(
      `INSERT INTO workspace_quota_policies
         (company_id, scope_type, scope_id, limit_bytes, file_limit_bytes) VALUES (?, 'role', ?, ?, ?)`,
    ).run('c1', 'leader', 300, 40)

    const quota = resolveUserWorkspaceQuota(db, 'c1', 'u1')
    expect(quota.source).toBe('role')
    expect(quota.limitBytes).toBe(300)
    expect(quota.fileLimitBytes).toBe(40)
    expect(quota.roleCodes.sort()).toEqual(['leader', 'member'])
  })

  it('用户单独配置覆盖角色配置', () => {
    const db = memoryDb()
    db.prepare('INSERT INTO roles (id, company_id, code) VALUES (?, ?, ?)').run('r1', 'c1', 'leader')
    db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run('u1', 'r1')
    db.prepare(
      `INSERT INTO workspace_quota_policies
         (company_id, scope_type, scope_id, limit_bytes, file_limit_bytes) VALUES (?, 'role', ?, ?, ?)`,
    ).run('c1', 'leader', 300, 40)
    db.prepare(
      `INSERT INTO workspace_quota_policies
         (company_id, scope_type, scope_id, limit_bytes, file_limit_bytes) VALUES (?, 'user', ?, ?, ?)`,
    ).run('c1', 'u1', 50, 5)

    const quota = resolveUserWorkspaceQuota(db, 'c1', 'u1')
    expect(quota.source).toBe('user')
    expect(quota.limitBytes).toBe(50)
    expect(quota.fileLimitBytes).toBe(5)
  })

  it('按 75/85/95/100% 给出容量预警等级和剩余空间', () => {
    expect(workspaceCapacity(100, 10)).toMatchObject({
      remainingBytes: 90,
      percent: 10,
      level: 'normal',
    })
    expect(workspaceCapacity(100, 80).level).toBe('notice')
    expect(workspaceCapacity(100, 90).level).toBe('warning')
    expect(workspaceCapacity(100, 96).level).toBe('critical')
    expect(workspaceCapacity(100, 100).level).toBe('full')
    expect(workspaceCapacity(100, 96).message).toContain('剩余 4 B')
    expect(workspaceCapacity(100, 100).message).toContain('已满')
  })
})
