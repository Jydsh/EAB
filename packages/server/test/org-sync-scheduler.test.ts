import { beforeEach, describe, expect, it } from 'vitest'
import type { FastifyRequest } from 'fastify'
import { migrate, openDatabase, type Db } from '@eab/storage'
import type { RemoteOrg } from '@eab/channel'
import { createEmployeeSession, readSessionUserId } from '../src/employee-session.js'
import { syncBoundChannels, syncChannelOrg } from '../src/org-sync-scheduler.js'
import type { ServerConfig } from '../src/config.js'

const NOW = 1_800_000_000_000
const COMPANY = 'c1'
const ROOT = 'd_root'
const SECRET_ENV = 'EAB_TEST_ORG_SYNC_SECRET'
process.env[SECRET_ENV] = 'test-secret'

let db: Db
const config = { dbPath: ':memory:' } as ServerConfig

function seed() {
  db.prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)').run(
    COMPANY,
    '居易智能',
    'juyi',
    'active',
    NOW,
  )
  db.prepare(
    `INSERT INTO departments (id, company_id, parent_id, name, path, depth, created_at)
     VALUES (?, ?, NULL, ?, ?, 1, ?)`,
  ).run(ROOT, COMPANY, '居易智能', '/c1/', NOW)
  db.prepare(
    `INSERT INTO channel_configs
       (id, company_id, provider, enabled, status, sync_mode, app_id, secret_ref, tenant_id, tenant_name, created_at, updated_at)
     VALUES
       ('cc_ding', ?, 'dingtalk', 1, 'bound', 'org', 'ding-app', ?, 'tenant-ding', '钉钉企业', ?, ?),
       ('cc_fs', ?, 'feishu', 0, 'unbound', 'off', 'fs-app', ?, NULL, NULL, ?, ?)`,
  ).run(COMPANY, SECRET_ENV, NOW, NOW, COMPANY, SECRET_ENV, NOW, NOW)
}

function dingRemote(includeUser: boolean): RemoteOrg {
  return {
    depts: [
      { channelDeptId: '1', parentChannelDeptId: null, name: '钉钉企业' },
      { channelDeptId: '2', parentChannelDeptId: '1', name: '研发部' },
    ],
    users: [
      ...(includeUser
        ? [
            {
              channelUserId: 'dt_001',
              name: '张三',
              title: '工程师',
              channelDeptIds: ['2'],
              status: 'active' as const,
            },
          ]
        : []),
      {
        channelUserId: 'dt_keep',
        name: '李四',
        title: '产品经理',
        channelDeptIds: ['2'],
        status: 'active',
      },
    ],
  }
}

beforeEach(() => {
  db = openDatabase({ path: ':memory:' })
  migrate(db)
  seed()
})

describe('渠道通讯录自动同步', () => {
  it('只同步已绑定渠道；连续两次缺失后停用成员，并让原会话失效', async () => {
    const fetchCalls: string[] = []
    const fetchOrg = async (provider: string) => {
      fetchCalls.push(provider)
      if (provider !== 'dingtalk') throw new Error('未绑定渠道不应被同步')
      return dingRemote(true)
    }

    const first = await syncBoundChannels(db, config, COMPANY, { fetchOrg, now: NOW })
    expect(first.map((item) => item.provider)).toEqual(['dingtalk'])
    expect(fetchCalls).toEqual(['dingtalk'])

    const user = db
      .prepare("SELECT id, status FROM users WHERE name = '张三' AND deleted_at IS NULL")
      .get() as { id: string; status: string }
    expect(user.status).toBe('active')

    const fakeReq = {
      headers: { cookie: '', 'user-agent': 'vitest' },
      ip: '127.0.0.1',
    } as unknown as FastifyRequest
    const session = createEmployeeSession(db, user.id, fakeReq)
    fakeReq.headers.cookie = `eab_session=${session.cookie}`
    expect(readSessionUserId(db, fakeReq)).toBe(user.id)

    // 上游第一次缺失：只累计 missing_runs，不立即停用。
    await syncChannelOrg(db, config, COMPANY, 'dingtalk', {
      fetchOrg: async () => dingRemote(false),
      now: NOW + 1,
    })
    let missing = db
      .prepare('SELECT missing_runs, status FROM users WHERE id = ?')
      .get(user.id) as { missing_runs: number; status: string }
    expect(missing).toMatchObject({ missing_runs: 1, status: 'active' })
    expect(readSessionUserId(db, fakeReq)).toBe(user.id)

    // 连续第二次缺失：停用；已签发的员工会话也不能继续使用。
    await syncChannelOrg(db, config, COMPANY, 'dingtalk', {
      fetchOrg: async () => dingRemote(false),
      now: NOW + 2,
    })
    missing = db.prepare('SELECT missing_runs, status FROM users WHERE id = ?').get(user.id) as {
      missing_runs: number
      status: string
    }
    expect(missing).toMatchObject({ missing_runs: 2, status: 'disabled' })
    expect(readSessionUserId(db, fakeReq)).toBeNull()

    const channel = db
      .prepare("SELECT last_sync_status, last_sync_error FROM channel_configs WHERE provider = 'dingtalk'")
      .get() as { last_sync_status: string; last_sync_error: string | null }
    expect(channel).toEqual({ last_sync_status: 'ok', last_sync_error: null })
  })

  it('上游返回 0 个成员时拒绝落库，避免一次接口异常把现有成员全部停用', async () => {
    await syncChannelOrg(db, config, COMPANY, 'dingtalk', {
      fetchOrg: async () => dingRemote(true),
      now: NOW,
    })
    const before = db
      .prepare("SELECT id, status, missing_runs FROM users WHERE name = '张三'")
      .get() as { id: string; status: string; missing_runs: number }
    expect(before.status).toBe('active')

    await expect(
      syncChannelOrg(db, config, COMPANY, 'dingtalk', {
        fetchOrg: async () => ({ ...dingRemote(false), users: [] }),
        now: NOW + 1,
      }),
    ).rejects.toThrow('返回 0 个成员')

    const after = db.prepare('SELECT status, missing_runs FROM users WHERE id = ?').get(before.id) as {
      status: string
      missing_runs: number
    }
    expect(after).toEqual({ status: 'active', missing_runs: 0 })
    const channel = db
      .prepare("SELECT last_sync_status FROM channel_configs WHERE provider = 'dingtalk'")
      .get() as { last_sync_status: string }
    expect(channel.last_sync_status).toBe('error')
  })

  it('单个渠道失败只标记该渠道，不影响其他已绑定渠道', async () => {
    const outcomes = await syncBoundChannels(db, config, COMPANY, {
      now: NOW + 10,
      fetchOrg: async (provider: string) => {
        if (provider === 'dingtalk') throw new Error('网络超时')
        return { depts: [], users: [] }
      },
    })

    expect(outcomes).toEqual([
      expect.objectContaining({ provider: 'dingtalk', ok: false, error: expect.stringContaining('网络超时') }),
    ])
    const channel = db
      .prepare("SELECT last_sync_status, last_sync_error FROM channel_configs WHERE provider = 'dingtalk'")
      .get() as { last_sync_status: string; last_sync_error: string | null }
    expect(channel.last_sync_status).toBe('error')
    expect(channel.last_sync_error).toContain('网络超时')
  })
})
