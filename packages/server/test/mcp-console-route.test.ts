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

async function startMcp(): Promise<string> {
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const message = JSON.parse(body) as Record<string, unknown>
    if (message.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26', capabilities: {} } }))
      return
    }
    if (message.method === 'notifications/initialized') {
      res.writeHead(202)
      res.end()
      return
    }
    const respond = (result: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    }
    if (message.method === 'tools/list') {
      respond({
        tools: [
          { name: 'lookup', description: 'lookup', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, annotations: { readOnlyHint: true } },
          { name: 'write', description: 'write', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } },
        ],
      })
      return
    }
    if (message.method === 'tools/call') {
      respond({ content: [{ type: 'text', text: 'ok' }] })
    }
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('mock MCP server did not bind')
  return `http://127.0.0.1:${address.port}/mcp`
}

function makeApps() {
  const dir = mkdtempSync(join(tmpdir(), 'eab-mcp-console-'))
  dirs.push(dir)
  previousHomes.push(process.env.EAB_HOME)
  process.env.EAB_HOME = dir
  const dbPath = join(dir, 'test.db')
  const db = openDatabase({ path: ':memory:' })
  handles.push(db)
  migrate(db)
  const now = Date.now()
  db.prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('c1', '测试公司', 'mcp-console', 'active', now)
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
  return { consoleApp, chatApp, db }
}

describe('控制台 MCP 登记接口', () => {
  it('登记 Server 后立即同步工具，返回只读目录且不回显密钥', async () => {
    const { consoleApp } = makeApps()
    await consoleApp.ready()
    const endpoint = await startMcp()
    const created = await consoleApp.inject({
      method: 'POST',
      url: '/api/console/mcp',
      headers: CONSOLE_HEADERS,
      payload: {
        name: 'Docs Hub',
        transport: 'http',
        endpoint,
        authType: 'bearer',
        secret: 'token-1',
      },
    })
    expect(created.statusCode).toBe(200)
    const body = created.json() as {
      data: { server: { id: string; name: string; secretConfigured: boolean; tools: Array<{ name: string; enabled: boolean; readOnly: boolean }>; toolCount: number }; sync: { ok: boolean; toolCount: number; readOnlyToolCount: number } }
    }
    expect(body.data.sync).toMatchObject({ ok: true, toolCount: 2, readOnlyToolCount: 1 })
    expect(body.data.server).toMatchObject({ name: 'Docs Hub', secretConfigured: true, toolCount: 2 })
    expect(body.data.server.tools.map((tool) => [tool.name, tool.enabled, tool.readOnly])).toEqual([
      ['lookup', true, true],
      ['write', false, false],
    ])
    expect(JSON.stringify(body)).not.toContain('token-1')
    const serverId = body.data.server.id

    const list = await consoleApp.inject({ method: 'GET', url: '/api/console/mcp', headers: CONSOLE_HEADERS })
    expect((list.json() as { data: { servers: Array<{ id: string }> } }).data.servers[0].id).toBe(serverId)

    const synced = await consoleApp.inject({
      method: 'POST',
      url: `/api/console/mcp/${serverId}/sync`,
      headers: CONSOLE_HEADERS,
      payload: { timeoutMs: 5_000 },
    })
    expect((synced.json() as { data: { sync: { ok: boolean } } }).data.sync.ok).toBe(true)

    const disabled = await consoleApp.inject({
      method: 'PATCH',
      url: `/api/console/mcp/${serverId}`,
      headers: CONSOLE_HEADERS,
      payload: { enabled: false },
    })
    const disabledBody = disabled.json() as { data: { server: { enabled: boolean; health: string } } }
    expect(disabledBody.data.server.enabled).toBe(false)
    expect(disabledBody.data.server.health).toBe('offline')

    const deleted = await consoleApp.inject({
      method: 'DELETE',
      url: `/api/console/mcp/${serverId}`,
      headers: CONSOLE_HEADERS,
    })
    expect(deleted.statusCode).toBe(200)
    const after = await consoleApp.inject({ method: 'GET', url: '/api/console/mcp', headers: CONSOLE_HEADERS })
    expect((after.json() as { data: { servers: unknown[] } }).data.servers).toEqual([])
  })

  it('缺少控制台头或地址不合法时拒绝写操作', async () => {
    const { consoleApp } = makeApps()
    await consoleApp.ready()
    const noConsole = await consoleApp.inject({
      method: 'POST',
      url: '/api/console/mcp',
      payload: { name: 'x', transport: 'http', endpoint: 'http://127.0.0.1:1/mcp' },
    })
    expect(noConsole.statusCode).toBe(401)
    const invalid = await consoleApp.inject({
      method: 'POST',
      url: '/api/console/mcp',
      headers: CONSOLE_HEADERS,
      payload: { name: 'x', transport: 'stdio', endpoint: 'http://127.0.0.1:1/mcp' },
    })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json()).toMatchObject({ message: expect.stringMatching(/stdio/) })
  })
})
