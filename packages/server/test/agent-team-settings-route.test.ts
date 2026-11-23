import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { migrate, openDatabase, type Db } from '@eab/storage'
import type { ServerConfig } from '../src/config.js'
import type { ServerDeps } from '../src/deps.js'
import { buildApp } from '../src/app.js'

const dirs: string[] = []
const handles: Db[] = []
const apps: ReturnType<typeof buildApp>[] = []
const previousHomes: Array<string | undefined> = []

const CONSOLE_HEADERS = {
  'x-eab-console': '1',
  'x-eab-console-token': 'test-console-token',
}

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
  for (const db of handles.splice(0)) db.close()
  for (const home of previousHomes.splice(0)) {
    if (home === undefined) delete process.env.EAB_HOME
    else process.env.EAB_HOME = home
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeApps() {
  const dir = mkdtempSync(join(tmpdir(), 'eab-agent-team-settings-'))
  dirs.push(dir)
  previousHomes.push(process.env.EAB_HOME)
  process.env.EAB_HOME = dir
  const db = openDatabase({ path: ':memory:' })
  handles.push(db)
  migrate(db)
  const now = Date.now()
  db.prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('c1', '测试公司', 'agent-team-settings', 'active', now)
  db.prepare('INSERT INTO departments (id, company_id, name, path, depth, order_no, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('d1', 'c1', '测试部门', '/c1/d1/', 1, 0, now)
  db.prepare('INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('u1', 'c1', 'd1', '/c1/d1/', '测试员工', 'active', now, now)
  db.prepare('INSERT INTO chat_sessions (id, company_id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('s1', 'c1', 'u1', '容量测试', now, now)

  const config = {
    host: '127.0.0.1',
    port: 0,
    adminPort: 0,
    dbPath: ':memory:',
    companyId: 'c1',
    devAuth: true,
    consoleToken: 'test-console-token',
    adminUser: 'admin',
    adminPassword: 'test-admin-password',
    logLevel: 'silent',
    onlyOfficeUrl: '',
    onlyOfficeJwtSecret: '',
    onlyOfficeInternalUrl: '',
    dataDir: dir,
    tmpDir: join(dir, 'tmp'),
    agentWorkerIdleMs: 60_000,
    agentMaxWorkers: 10,
    agentMaxWorkersFromEnv: true,
  } as ServerConfig
  const deps = {
    db,
    config,
    companyId: 'c1',
    migrations: [],
    consoleToken: 'test-console-token',
  } as ServerDeps
  const consoleApp = buildApp(deps, 'console')
  const chatApp = buildApp(deps, 'chat')
  apps.push(consoleApp, chatApp)
  return { consoleApp, chatApp, db }
}

describe('Agent 团队容量控制台配置', () => {
  it('控制台值覆盖环境变量，并让团队状态接口立即使用新上限', async () => {
    const { consoleApp, chatApp, db } = makeApps()
    await consoleApp.ready()
    await chatApp.ready()

    const now = Date.now()
    db.prepare(`INSERT INTO agent_cards
      (id, company_id, agent_key, kind, name, version, description, skills_json, tools_json, limits_json, endpoint_json, health, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        'card-build', 'c1', 'builder', 'builtin', '架构实现员', '2', '',
        '["接口实现"]', '["project.exec"]', '{"maxRounds":30}', '{"kind":"internal"}', 'healthy', 1, now, now,
      )

    const before = await consoleApp.inject({
      method: 'GET',
      url: '/api/console/settings',
      headers: CONSOLE_HEADERS,
    })
    const beforeBody = before.json() as {
      data: {
        agentTeam: { maxWorkers: number; source: string; envPresent: boolean }
        agentCards: Array<{
          agentKey: string
          name: string
          source: string
          skills: string[]
          limits: { maxRounds?: number }
          overridden?: boolean
        }>
      }
    }
    expect(beforeBody.data.agentTeam).toMatchObject({
      maxWorkers: 10,
      source: 'env',
      envPresent: true,
    })
    expect(beforeBody.data.agentCards.map((card) => card.agentKey)).toEqual([
      'researcher',
      'builder',
      'critic',
      'producer',
      'worker',
    ])
    expect(beforeBody.data.agentCards[1]).toMatchObject({
      agentKey: 'builder',
      name: '架构实现员',
      source: 'company',
      overridden: true,
    })
    expect(beforeBody.data.agentCards[1].skills).toContain('接口实现')
    expect(beforeBody.data.agentCards[1].limits.maxRounds).toBe(30)

    const saved = await consoleApp.inject({
      method: 'PUT',
      url: '/api/console/settings/agent-team',
      headers: CONSOLE_HEADERS,
      payload: { maxWorkers: 6 },
    })
    expect(saved.statusCode).toBe(200)
    const savedBody = saved.json() as {
      data: { agentTeam: { maxWorkers: number; source: string; configured: number | null } }
    }
    expect(savedBody.data.agentTeam).toMatchObject({
      maxWorkers: 6,
      source: 'console',
      configured: 6,
    })

    const agents = await chatApp.inject({
      method: 'GET',
      url: '/api/chat/agents?sessionId=s1&as=u1',
    })
    const agentsBody = agents.json() as { data: { capacity: { limit: number } } }
    expect(agentsBody.data.capacity.limit).toBe(6)
  })

  it('非法上限被拒绝，清空后回落到环境变量', async () => {
    const { consoleApp } = makeApps()
    await consoleApp.ready()

    const invalid = await consoleApp.inject({
      method: 'PUT',
      url: '/api/console/settings/agent-team',
      headers: CONSOLE_HEADERS,
      payload: { maxWorkers: 0 },
    })
    expect(invalid.statusCode).toBe(400)

    const saved = await consoleApp.inject({
      method: 'PUT',
      url: '/api/console/settings/agent-team',
      headers: CONSOLE_HEADERS,
      payload: { maxWorkers: 6 },
    })
    expect(saved.statusCode).toBe(200)

    const reset = await consoleApp.inject({
      method: 'PUT',
      url: '/api/console/settings/agent-team',
      headers: CONSOLE_HEADERS,
      payload: { maxWorkers: null },
    })
    expect(reset.statusCode).toBe(200)
    const resetBody = reset.json() as {
      data: { agentTeam: { maxWorkers: number; source: string; configured: number | null } }
    }
    expect(resetBody.data.agentTeam).toMatchObject({
      maxWorkers: 10,
      source: 'env',
      configured: null,
    })
  })
})
