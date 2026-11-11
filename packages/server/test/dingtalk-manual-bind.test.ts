import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDatabase, migrate } from '@eab/storage'
import type { FastifyRequest } from 'fastify'
import type { ServerConfig } from '../src/config.js'
import type { ServerDeps } from '../src/deps.js'
import { createDingTalkCompany } from '../src/routes/admin.js'

const dirs: string[] = []
const handles: Array<{ close: () => void }> = []

afterEach(() => {
  for (const db of handles.splice(0)) db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeDeps() {
  const dir = mkdtempSync(join(tmpdir(), 'eab-manual-bind-'))
  dirs.push(dir)
  const db = openDatabase({ path: join(dir, 'eab.db') })
  handles.push(db)
  migrate(db)
  const now = Date.now()
  db.prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)').run(
    'c1',
    '测试公司',
    'test-company',
    'active',
    now,
  )
  db.prepare(
    'INSERT INTO departments (id, company_id, parent_id, name, path, depth, order_no, created_at) VALUES (?, ?, NULL, ?, ?, 0, 0, ?)',
  ).run('d_root', 'c1', '公司总部', '/c1/', now)
  const config = { dbPath: join(dir, 'eab.db'), dataDir: dir } as ServerConfig
  return { db, deps: { db, config, companyId: 'c1', migrations: [], consoleToken: '' } as ServerDeps }
}

const req = {
  headers: { host: '192.168.168.102:8788' },
  ip: '127.0.0.1',
} as unknown as FastifyRequest

describe('手工绑定普通钉钉机器人', () => {
  it('把 RobotCode、AgentId、STREAM 模式和绑定时间写进现有渠道配置', async () => {
    const { db, deps } = makeDeps()
    const created = await createDingTalkCompany(deps, req, {
      appId: 'ding_test_app',
      appSecret: 'test-secret',
      corpId: 'ding_test_corp',
      tenant: { tenantId: 'ding_test_corp', name: '测试企业' },
      remote: {
        depts: [{ channelDeptId: '2', parentChannelDeptId: '1', name: '研发部' }],
        users: [],
      },
      actorLabel: 'console:onboard-dingtalk',
      action: 'platform.company.onboard_dingtalk',
      robotCode: 'ding_test_robot',
      agentId: '123456',
      robotMode: 'STREAM',
      botBoundAt: 1794329287538,
      botBoundBy: 'console:dingtalk-manual',
    })

    const row = db
      .prepare(
        `SELECT app_id, robot_code, agent_id, robot_mode, bot_bound_at, bot_bound_by_user_id,
                status, enabled
           FROM channel_configs
          WHERE company_id = ? AND provider = 'dingtalk'`,
      )
      .get('c1') as Record<string, unknown>

    expect(created.company.id).toBe('c1')
    expect(row.app_id).toBe('ding_test_app')
    expect(row.robot_code).toBe('ding_test_robot')
    expect(row.agent_id).toBe('123456')
    expect(row.robot_mode).toBe('STREAM')
    expect(row.bot_bound_at).toBe(1794329287538)
    expect(row.bot_bound_by_user_id).toBe('console:dingtalk-manual')
    expect(row.status).toBe('bound')
    expect(row.enabled).toBe(1)
  })
})
