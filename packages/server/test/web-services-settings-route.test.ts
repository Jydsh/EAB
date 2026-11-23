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

function makeConsoleApp() {
  const dir = mkdtempSync(join(tmpdir(), 'eab-web-services-settings-'))
  dirs.push(dir)
  previousHomes.push(process.env.EAB_HOME)
  process.env.EAB_HOME = dir
  const db = openDatabase({ path: ':memory:' })
  handles.push(db)
  migrate(db)
  const now = Date.now()
  db.prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('c1', '测试公司', 'web-services-settings', 'active', now)

  const config = {
    host: '127.0.0.1',
    port: 0,
    adminPort: 0,
    dbPath: join(dir, 'eab.db'),
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
  apps.push(consoleApp)
  return consoleApp
}

describe('搜索与浏览器连接设置接口', () => {
  it('数据连接页只读取搜索、浏览器和内网策略三个视图', async () => {
    const app = makeConsoleApp()
    await app.ready()

    const response = await app.inject({
      method: 'GET',
      url: '/api/console/settings/web-services',
      headers: CONSOLE_HEADERS,
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as {
      data: Record<string, unknown> & {
        webSearch: { provider: string; configured: boolean }
        browser: { available: boolean }
        browserNetwork: { allowPrivateNetwork: boolean; allowedHosts: string[] }
      }
    }
    expect(Object.keys(body.data).sort()).toEqual(['browser', 'browserNetwork', 'webSearch'])
    expect(body.data.webSearch).toMatchObject({ provider: 'none', configured: false })
    expect(body.data.browserNetwork).toMatchObject({ allowPrivateNetwork: false, allowedHosts: [] })
    expect(body.data).not.toHaveProperty('dbPath')
    expect(body.data).not.toHaveProperty('storage')
    expect(body.data).not.toHaveProperty('logs')
  })
})
