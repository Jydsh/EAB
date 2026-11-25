import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { migrate, openDatabase, type Db } from '@eab/storage'
import type { ServerConfig } from '../src/config.js'
import type { ServerDeps } from '../src/deps.js'
import { buildApp } from '../src/app.js'

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const dirs: string[] = []
const dbHandles: Db[] = []
const apps: ReturnType<typeof buildApp>[] = []
const servers: Server[] = []
const previousHomes: Array<string | undefined> = []

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  for (const db of dbHandles.splice(0)) db.close()
  for (const home of previousHomes.splice(0)) {
    if (home === undefined) delete process.env.EAB_HOME
    else process.env.EAB_HOME = home
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function fakeImageServer(): Promise<{ baseUrl: string; seen: Array<Record<string, unknown>> }> {
  const seen: Array<Record<string, unknown>> = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      seen.push(JSON.parse(raw || '{}') as Record<string, unknown>)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ b64_json: PNG_1PX }] }))
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('测试服务器没有端口')
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, seen }
}

function makeApp(baseUrl: string | null) {
  const dir = mkdtempSync(join(tmpdir(), 'eab-content-image-'))
  dirs.push(dir)
  previousHomes.push(process.env.EAB_HOME)
  process.env.EAB_HOME = dir
  const db = openDatabase({ path: ':memory:' })
  dbHandles.push(db)
  migrate(db)
  const now = Date.now()
  db.prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('c1', '测试公司', 'content-image', 'active', now)
  db.prepare('INSERT INTO departments (id, company_id, name, path, depth, order_no, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('d1', 'c1', '测试部门', '/c1/d1/', 1, 0, now)
  db.prepare('INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('u1', 'c1', 'd1', '/c1/d1/', '测试员工', 'active', now, now)
  if (baseUrl) {
    db.prepare(
      `INSERT INTO model_providers (id, company_id, kind, name, base_url, created_at, updated_at)
       VALUES ('p1', 'c1', 'openai_compatible', '图片供应商', ?, ?, ?)`,
    ).run(baseUrl, now, now)
    db.prepare(
      `INSERT INTO models
         (id, company_id, provider_id, name, model_key, tags, capabilities, endpoint_kind, priority, enabled, created_at, updated_at)
       VALUES ('m1', 'c1', 'p1', '图片生成', 'test-image', '["chat"]', '["chat"]', 'image', 10, 1, ?, ?)`,
    ).run(now, now)
  }
  const config = {
    host: '127.0.0.1',
    port: 0,
    adminPort: 0,
    dbPath: ':memory:',
    companyId: 'c1',
    devAuth: true,
    consoleToken: '',
    adminUser: 'admin',
    adminPassword: 'test-admin-password',
    logLevel: 'silent',
    onlyOfficeUrl: '',
    onlyOfficeJwtSecret: '',
    onlyOfficeInternalUrl: '',
    dataDir: dir,
    tmpDir: join(dir, 'tmp'),
    agentWorkerIdleMs: 60_000,
  } as ServerConfig
  const deps = { db, config, companyId: 'c1', migrations: [], consoleToken: '' } as ServerDeps
  const app = buildApp(deps, 'chat')
  apps.push(app)
  return app
}

describe('AGT-19 独立内容接口', () => {
  it('生成图片后落个人云空间，可直接下载', async () => {
    const fake = await fakeImageServer()
    const app = makeApp(fake.baseUrl)
    const response = await app.inject({
      method: 'POST',
      url: '/api/content/images?as=u1',
      payload: { prompt: '画一只橘猫', size: '1024x1024' },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as { data?: { file?: { id?: string; name?: string }; downloadUrl?: string } }
    expect(body.data?.file?.name).toMatch(/^生成图片-/)
    expect(body.data?.downloadUrl).toMatch(/^\/api\/workspace\/files\//)
    expect(fake.seen[0]).toMatchObject({ prompt: '画一只橘猫', size: '1024x1024' })

    const download = await app.inject({ method: 'GET', url: `${body.data?.downloadUrl}?as=u1` })
    expect(download.statusCode).toBe(200)
    expect(download.rawPayload.subarray(0, 4).toString('hex')).toBe('89504e47')
  })

  it('没有图片模型时明确提示去控制台配置，而不是调用聊天模型', async () => {
    const app = makeApp(null)
    const response = await app.inject({
      method: 'POST',
      url: '/api/content/images?as=u1',
      payload: { prompt: '画一张海报' },
    })
    expect(response.statusCode).toBe(400)
    const body = response.json() as { code?: string; message?: string }
    expect(body.code).toBe('EAB_VALIDATION')
    expect(body.message).toContain('图片生成模型')
  })
})
