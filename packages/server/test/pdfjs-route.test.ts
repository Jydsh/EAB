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

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
  for (const db of handles.splice(0)) db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeApp() {
  const dir = mkdtempSync(join(tmpdir(), 'eab-pdfjs-route-'))
  dirs.push(dir)
  const db = openDatabase({ path: ':memory:' })
  handles.push(db)
  migrate(db)
  const config = {
    host: '127.0.0.1',
    port: 0,
    adminPort: 0,
    dbPath: ':memory:',
    companyId: 'c1',
    devAuth: false,
    consoleToken: '',
    adminUser: 'admin',
    adminPassword: 'test-admin-password',
    logLevel: 'silent',
    onlyOfficeUrl: '',
    onlyOfficeJwtSecret: '',
    onlyOfficeInternalUrl: '',
    dataDir: dir,
    tmpDir: join(dir, 'tmp'),
  } as ServerConfig
  const deps = { db, config, companyId: 'c1', migrations: [], consoleToken: '' } as ServerDeps
  const app = buildApp(deps, 'chat')
  apps.push(app)
  return app
}

async function get(url: string) {
  const app = makeApp()
  await app.ready()
  return app.inject({ method: 'GET', url })
}

describe('PDF.js 自托管静态路由', () => {
  it('放行构建文件并返回 JS MIME、缓存头和内容', async () => {
    const response = await get('/vendor/pdfjs/build/pdf.min.mjs')
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(response.headers['cache-control']).toBe('private, max-age=3600, must-revalidate')
    expect(response.rawPayload.length).toBeGreaterThan(100_000)
  })

  it('放行 worker、CMap、WASM 和标准字体，并按扩展名给出 MIME', async () => {
    const cases = [
      ['/vendor/pdfjs/build/pdf.worker.min.mjs', 'text/javascript; charset=utf-8', 100_000],
      ['/vendor/pdfjs/cmaps/UniGB-UCS2-H.bcmap', 'application/octet-stream', 10_000],
      ['/vendor/pdfjs/wasm/openjpeg.wasm', 'application/wasm', 10_000],
      ['/vendor/pdfjs/standard_fonts/FoxitSerif.pfb', 'application/x-font-type1', 10_000],
    ] as const
    for (const [url, type, minBytes] of cases) {
      const response = await get(url)
      expect(response.statusCode, url).toBe(200)
      expect(response.headers['content-type'], url).toBe(type)
      expect(response.rawPayload.length, url).toBeGreaterThan(minBytes)
    }
  })

  it('拒绝未列入白名单、目录穿越和不存在的资源', async () => {
    const urls = [
      '/vendor/pdfjs/package.json',
      '/vendor/pdfjs/build/nope.mjs',
      '/vendor/pdfjs/cmaps/nope.bcmap',
      '/vendor/pdfjs/standard_fonts/FoxitSans.pfb',
      '/vendor/pdfjs/build/%2e%2e/package.json',
      '/vendor/pdfjs/build/../../package.json',
    ]
    for (const url of urls) {
      const response = await get(url)
      expect(response.statusCode, url).toBe(404)
      expect(response.json(), url).toMatchObject({ ok: false, code: 'EAB_NOT_FOUND' })
    }
  })
})
