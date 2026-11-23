import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrate, openDatabase, type Db } from '@eab/storage'
import type { ServerConfig } from '../src/config.js'
import type { ServerDeps } from '../src/deps.js'
import { buildApp } from '../src/app.js'

const dirs: string[] = []
const handles: Db[] = []
const apps: ReturnType<typeof buildApp>[] = []
const servers: Array<ReturnType<typeof createServer>> = []
const previousHomes: Array<string | undefined> = []

const CONSOLE_HEADERS = {
  'x-eab-console': '1',
  'x-eab-console-token': 'test-console-token',
}

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })))
  for (const db of handles.splice(0)) db.close()
  for (const home of previousHomes.splice(0)) {
    if (home === undefined) delete process.env.EAB_HOME
    else process.env.EAB_HOME = home
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function startA2A(): Promise<string> {
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    if (req.method === 'GET') {
      const address = server.address()
      const port = address && typeof address !== 'string' ? address.port : 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        protocolVersion: '0.2.6',
        name: '旅行规划员',
        description: '规划差旅',
        url: `http://127.0.0.1:${port}/a2a`,
        version: '1.2',
        capabilities: { streaming: false },
        skills: [
          { id: 'travel.plan', name: '行程规划' },
          { id: 'travel.book', name: '票务预订' },
        ],
      }))
      return
    }
    const message = JSON.parse(body) as Record<string, unknown>
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: { id: 'remote-1', contextId: 'ctx-1', status: { state: 'completed' }, artifacts: [] },
    }))
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('mock A2A server did not bind')
  return `http://127.0.0.1:${address.port}/a2a`
}

function makeApps() {
  const dir = mkdtempSync(join(tmpdir(), 'eab-a2a-console-'))
  dirs.push(dir)
  previousHomes.push(process.env.EAB_HOME)
  process.env.EAB_HOME = dir
  const dbPath = join(dir, 'test.db')
  const db = openDatabase({ path: ':memory:' })
  handles.push(db)
  migrate(db)
  const now = Date.now()
  db.prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('c1', '测试公司', 'a2a-console', 'active', now)
  db.prepare('INSERT INTO departments (id, company_id, name, path, depth, order_no, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('d1', 'c1', '测试部门', '/c1/d1/', 1, 0, now)
  db.prepare('INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('u1', 'c1', 'd1', '/c1/d1/', '测试员工', 'active', now, now)
  const config = {
    host: '127.0.0.1',
    port: 0,
    adminPort: 0,
    dbPath,
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
  return { consoleApp, db }
}

describe('控制台 A2A 登记接口', () => {
  it('登记后立即同步 Agent Card，返回技能摘要且不回显密钥', async () => {
    const { consoleApp } = makeApps()
    await consoleApp.ready()
    const endpoint = await startA2A()
    const created = await consoleApp.inject({
      method: 'POST',
      url: '/api/console/a2a',
      headers: CONSOLE_HEADERS,
      payload: {
        name: '旅行 Agent',
        endpoint,
        authType: 'bearer',
        secret: 'a2a-token-1',
        allowedSkills: ['travel.plan'],
      },
    })
    expect(created.statusCode).toBe(200)
    const body = created.json() as {
      data: {
        peer: { id: string; name: string; secretConfigured: boolean; effectiveSkills: string[]; health: string }
        sync: { ok: boolean; skillCount: number }
      }
    }
    expect(body.data.sync).toMatchObject({ ok: true, skillCount: 1 })
    expect(body.data.peer).toMatchObject({
      name: '旅行 Agent',
      secretConfigured: true,
      health: 'healthy',
      effectiveSkills: ['行程规划（travel.plan）'],
    })
    expect(JSON.stringify(body)).not.toContain('a2a-token-1')
    const peerId = body.data.peer.id

    const list = await consoleApp.inject({ method: 'GET', url: '/api/console/a2a', headers: CONSOLE_HEADERS })
    const listBody = list.json() as { data: { peers: Array<{ id: string }>; tasks: unknown[] } }
    expect(listBody.data.peers[0].id).toBe(peerId)
    expect(listBody.data.tasks).toEqual([])

    const disabled = await consoleApp.inject({
      method: 'PATCH',
      url: `/api/console/a2a/${peerId}`,
      headers: CONSOLE_HEADERS,
      payload: { enabled: false },
    })
    const disabledBody = disabled.json() as { data: { peer: { enabled: boolean; health: string }; sync: null } }
    expect(disabledBody.data.peer).toMatchObject({ enabled: false, health: 'offline' })
    expect(disabledBody.data.sync).toBeNull()

    const enabled = await consoleApp.inject({
      method: 'PATCH',
      url: `/api/console/a2a/${peerId}`,
      headers: CONSOLE_HEADERS,
      payload: { enabled: true, clearSecret: true, allowedSkills: [] },
    })
    const enabledBody = enabled.json() as {
      data: { peer: { health: string; secretConfigured: boolean; effectiveSkills: string[] }; sync: { ok: boolean; skillCount: number } }
    }
    expect(enabledBody.data.peer).toMatchObject({ health: 'healthy', secretConfigured: false })
    expect(enabledBody.data.peer.effectiveSkills).toHaveLength(2)
    expect(enabledBody.data.sync).toMatchObject({ ok: true, skillCount: 2 })

    const deleted = await consoleApp.inject({ method: 'DELETE', url: `/api/console/a2a/${peerId}`, headers: CONSOLE_HEADERS })
    expect(deleted.statusCode).toBe(200)
    const after = await consoleApp.inject({ method: 'GET', url: '/api/console/a2a', headers: CONSOLE_HEADERS })
    expect((after.json() as { data: { peers: unknown[] } }).data.peers).toEqual([])
  })

  it('缺少控制台头或端点不合法时拒绝写操作', async () => {
    const { consoleApp } = makeApps()
    await consoleApp.ready()
    const noConsole = await consoleApp.inject({
      method: 'POST',
      url: '/api/console/a2a',
      payload: { name: 'x', endpoint: 'http://127.0.0.1:1/a2a' },
    })
    expect(noConsole.statusCode).toBe(401)
    const invalid = await consoleApp.inject({
      method: 'POST',
      url: '/api/console/a2a',
      headers: CONSOLE_HEADERS,
      payload: { name: 'x', endpoint: 'ftp://example.com/a2a' },
    })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json()).toMatchObject({ message: expect.stringMatching(/http\/https/) })
  })
})
