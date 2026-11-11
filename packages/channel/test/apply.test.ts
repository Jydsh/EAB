import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, migrate, type Db } from '@eab/storage'
import { applyOrgSync } from '../src/apply.js'
import { mapRemoteOrg } from '../src/map-org.js'
import { mockFeishuOrg } from '../src/mock.js'

const NOW = 1_800_000_000_000
const COMPANY = 'c1'

let db: Db

function seedCompany(target: Db): void {
  target
    .prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(COMPANY, '甲科技', 'acme', 'active', NOW)
  target
    .prepare(
      'INSERT INTO departments (id, company_id, parent_id, name, path, depth, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)',
    )
    .run('d_root', COMPANY, '甲科技', '/c1/', 1, NOW)
}

function planFor(step: 1 | 2 | 3) {
  return mapRemoteOrg(mockFeishuOrg(step), {
    companyId: COMPANY,
    provider: 'mock',
    root: { id: 'd_root', path: '/c1/', depth: 1 },
    rootChannelDeptIds: ['0'],
  })
}

function sync(step: 1 | 2 | 3, recycleAfter = 2) {
  return applyOrgSync(db, { plan: planFor(step), now: NOW, recycleAfter })
}

function deptRow(channelDeptId: string) {
  return db
    .prepare(
      'SELECT id, parent_id, name, path, depth, deleted_at, missing_runs FROM departments WHERE company_id = ? AND channel = ? AND channel_dept_id = ?',
    )
    .get(COMPANY, 'mock', channelDeptId) as unknown as {
    id: string
    parent_id: string | null
    name: string
    path: string
    depth: number
    deleted_at: number | null
    missing_runs: number
  }
}

function userRow(channelUserId: string) {
  return db
    .prepare(
      `SELECT u.id, u.name, u.mobile, u.avatar, u.dept_id, u.dept_path, u.status, u.missing_runs, u.recycled_at
         FROM users u JOIN user_identities i ON i.user_id = u.id
        WHERE i.provider = ? AND i.external_user_id = ?`,
    )
    .get('mock', channelUserId) as unknown as {
    id: string
    name: string
    mobile: string | null
    avatar: string | null
    dept_id: string
    dept_path: string
    status: string
    missing_runs: number
    recycled_at: number | null
  }
}

beforeEach(() => {
  db = openDatabase({ path: ':memory:' })
  migrate(db)
  seedCompany(db)
})

describe('applyOrgSync：第一次同步', () => {
  it('建部门、建成员、渠道身份先落 pending（不自动生效）', () => {
    const outcome = sync(1)

    expect(outcome.status).toBe('ok')
    expect(outcome.stats.deptsCreated).toBe(7) // 8 个部门里飞书根 '0' 不建行
    expect(outcome.stats.usersCreated).toBe(4)
    expect(outcome.stats.identitiesCreated).toBe(4)
    expect(outcome.stats.orphans).toBe(1) // 新业务部父部门不可见

    const fe = deptRow('od-fe')
    expect(fe.path).toBe('/c1/d_mock_od-rd/d_mock_od-fe/')
    expect(fe.depth).toBe(3)

    // 孤儿子部门挂到公司根，不猜层级
    expect(deptRow('od-new').parent_id).toBe('d_root')

    const lin = userRow('fs_lin')
    expect(lin.dept_path).toBe('/c1/d_mock_od-rd/d_mock_od-fe/')
    expect(lin.status).toBe('active')

    const identity = db
      .prepare(
        'SELECT status, bound_by, union_id FROM user_identities WHERE provider = ? AND external_user_id = ?',
      )
      .get('mock', 'fs_lin') as unknown as { status: string; bound_by: string; union_id: string }
    expect(identity.status).toBe('pending')
    expect(identity.bound_by).toBe('sync:mock')
    expect(identity.union_id).toBe('on_lin')
  })

  it('同步成员时把手机号写进 users.mobile，并参与变更比较', () => {
    const plan = mapRemoteOrg(
      {
        depts: [{ channelDeptId: 'rd', parentChannelDeptId: '0', name: '研发', order: 1 }],
        users: [
          {
            channelUserId: 'u1',
            name: '苏杭',
            mobile: '+86 138-0013-8000',
            channelDeptIds: ['rd'],
            status: 'active',
          },
        ],
      },
      { companyId: COMPANY, provider: 'mock', root: { id: 'd_root', path: '/c1/', depth: 1 } },
    )
    applyOrgSync(db, { plan, now: NOW })

    expect(userRow('u1').mobile).toBe('13800138000')

    const second = applyOrgSync(db, { plan, now: NOW })
    expect(second.diffs).toEqual([])
    expect(second.stats.usersUpdated).toBe(0)

    const withoutMobile = mapRemoteOrg(
      {
        depts: [{ channelDeptId: 'rd', parentChannelDeptId: '0', name: '研发', order: 1 }],
        users: [
          {
            channelUserId: 'u1',
            name: '苏杭',
            channelDeptIds: ['rd'],
            status: 'active',
          },
        ],
      },
      { companyId: COMPANY, provider: 'mock', root: { id: 'd_root', path: '/c1/', depth: 1 } },
    )
    const third = applyOrgSync(db, { plan: withoutMobile, now: NOW })
    expect(userRow('u1').mobile).toBe('13800138000')
    expect(third.stats.usersUpdated).toBe(0)
  })

  it('同步成员时把渠道头像写进 users.avatar，上游没给时保留已有值', () => {
    const base = {
      depts: [{ channelDeptId: 'rd', parentChannelDeptId: '0', name: '研发', order: 1 }],
      users: [
        {
          channelUserId: 'u1',
          name: '苏杭',
          avatar: 'https://static-legacy.dingtalk.com/media/a.jpg',
          channelDeptIds: ['rd'],
          status: 'active' as const,
        },
      ],
    }
    applyOrgSync(
      db,
      {
        plan: mapRemoteOrg(base, {
          companyId: COMPANY,
          provider: 'mock',
          root: { id: 'd_root', path: '/c1/', depth: 1 },
        }),
        now: NOW,
      },
    )
    expect(userRow('u1').avatar).toBe('https://static-legacy.dingtalk.com/media/a.jpg')

    const withoutAvatar = mapRemoteOrg(
      {
        ...base,
        users: [{ channelUserId: 'u1', name: '苏杭', channelDeptIds: ['rd'], status: 'active' as const }],
      },
      { companyId: COMPANY, provider: 'mock', root: { id: 'd_root', path: '/c1/', depth: 1 } },
    )
    const second = applyOrgSync(db, { plan: withoutAvatar, now: NOW })
    expect(userRow('u1').avatar).toBe('https://static-legacy.dingtalk.com/media/a.jpg')
    expect(second.stats.usersUpdated).toBe(0)
  })

  it('同步报告落库：run 一行、diff 明细若干', () => {
    const outcome = sync(1)
    const run = db
      .prepare('SELECT provider, mode, status, stats_json FROM org_sync_runs WHERE id = ?')
      .get(outcome.runId) as unknown as { provider: string; mode: string; status: string; stats_json: string }
    expect(run.provider).toBe('mock')
    expect(run.mode).toBe('full')
    expect(run.status).toBe('ok')
    expect(JSON.parse(run.stats_json).usersCreated).toBe(4)

    const diffCount = db
      .prepare('SELECT COUNT(*) AS n FROM org_sync_diffs WHERE run_id = ?')
      .get(outcome.runId) as unknown as { n: number }
    expect(Number(diffCount.n)).toBe(outcome.diffs.length)
    expect(outcome.diffs.length).toBeGreaterThan(0)
  })
})

describe('applyOrgSync：幂等与变更', () => {
  it('身份表残留孤儿身份（成员行已丢）时，重建成员而不是撞身份唯一键', () => {
    const plan = planFor(1)
    const lin = plan.users.find((user) => user.channelUserId === 'fs_lin')
    expect(lin).toBeTruthy()
    db.exec('PRAGMA foreign_keys = OFF')
    db.prepare(
      `INSERT INTO user_identities (id, user_id, provider, external_user_id, union_id, bound_at, bound_by, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('ident_orphan', lin!.id, 'mock', 'fs_lin', 'on_lin', NOW, 'seed', 'pending')
    db.exec('PRAGMA foreign_keys = ON')

    const outcome = applyOrgSync(db, { plan, now: NOW })

    expect(outcome.stats.usersCreated).toBe(4)
    expect(outcome.stats.identitiesCreated).toBe(3)
    expect(userRow('fs_lin').id).toBe(lin!.id)
    const identityCount = db
      .prepare("SELECT COUNT(*) AS n FROM user_identities WHERE provider = 'mock' AND external_user_id = 'fs_lin'")
      .get() as { n: number }
    expect(Number(identityCount.n)).toBe(1)
  })

  it('同一份通讯录跑第二次：零写入、diff 为空', () => {
    sync(1)
    const second = sync(1)

    expect(second.diffs).toEqual([])
    expect(second.stats.deptsCreated).toBe(0)
    expect(second.stats.usersCreated).toBe(0)
    expect(second.stats.deptsMoved).toBe(0)
    // unchanged = 7 部门 + 4 成员
    expect(second.stats.unchanged).toBe(11)
  })

  it('改名 + 部门移动：子树 path 与成员的 dept_path 一起收敛', () => {
    sync(1)
    const outcome = sync(2)

    expect(outcome.stats.deptsRenamed).toBe(1) // 市场部 → 市场与品牌部
    expect(outcome.stats.deptsMoved).toBeGreaterThanOrEqual(1) // 前端组挂到市场部门下
    expect(deptRow('od-mkt').name).toBe('市场与品牌部（飞书）')
    expect(deptRow('od-fe').path).toBe('/c1/d_mock_od-mkt/d_mock_od-fe/')

    // 林晨在前端组，路径必须跟着改，否则范围过滤会拿旧路径算权限
    expect(userRow('fs_lin').dept_path).toBe('/c1/d_mock_od-mkt/d_mock_od-fe/')
  })

  it('离职立即失效；新人进来', () => {
    sync(1)
    const outcome = sync(2)

    expect(outcome.stats.usersDeparted).toBe(1)
    expect(userRow('fs_zhao').status).toBe('departed')
    expect(userRow('fs_liu').status).toBe('active')
  })
})

describe('applyOrgSync：缺失不误删', () => {
  it('第一次缺失只计数，不回收', () => {
    sync(1)
    sync(2)
    const outcome = sync(3)

    expect(outcome.stats.usersMissing).toBe(1) // 苏杭
    expect(outcome.stats.deptsMissing).toBe(1) // 招聘组
    expect(userRow('fs_su').status).toBe('active')
    expect(userRow('fs_su').missing_runs).toBe(1)
    expect(deptRow('od-hr-rc').deleted_at).toBeNull()
  })

  it('连续两次缺失才回收：禁用成员、软删部门', () => {
    sync(1)
    sync(2)
    sync(3)
    const outcome = sync(3)

    expect(outcome.stats.usersDisabled).toBe(1)
    expect(outcome.stats.deptsRecycled).toBe(1)
    expect(userRow('fs_su').status).toBe('disabled')
    expect(userRow('fs_su').recycled_at).not.toBeNull()
    expect(deptRow('od-hr-rc').deleted_at).not.toBeNull()
  })

  it('重新出现在通讯录里：恢复部门与成员，缺失计数清零', () => {
    sync(1)
    sync(2)
    sync(3)
    sync(3)
    const outcome = sync(2)

    expect(outcome.stats.deptsRestored).toBe(1)
    expect(outcome.stats.usersRestored).toBe(1)
    expect(userRow('fs_su').status).toBe('active')
    expect(userRow('fs_su').missing_runs).toBe(0)
    expect(userRow('fs_su').recycled_at).toBeNull()
    expect(deptRow('od-hr-rc').deleted_at).toBeNull()
    expect(deptRow('od-hr-rc').missing_runs).toBe(0)
  })

  it('空通讯录直接拒绝，避免把整家公司判成缺失', () => {
    const empty = mapRemoteOrg(
      { depts: [], users: [] },
      { companyId: COMPANY, provider: 'mock', root: { id: 'd_root', path: '/c1/', depth: 1 } },
    )
    expect(() => applyOrgSync(db, { plan: empty, now: NOW })).toThrow(/同步结果为空/)
  })
})
