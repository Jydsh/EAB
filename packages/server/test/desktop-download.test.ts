import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { migrate, openDatabase, type Db } from '@eab/storage'
import { buildApp } from '../src/app.js'
import type { ServerConfig } from '../src/config.js'
import type { ServerDeps } from '../src/deps.js'

const dirs: string[] = []
const handles: Db[] = []
const apps: ReturnType<typeof buildApp>[] = []
const servers: Server[] = []
const previousHomes: Array<string | undefined> = []
const previousReleaseDirs: Array<string | undefined> = []
const previousReleaseUrls: Array<string | undefined> = []

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
  for (const db of handles.splice(0)) db.close()
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const home of previousHomes.splice(0)) {
    if (home === undefined) delete process.env.EAB_HOME
    else process.env.EAB_HOME = home
  }
  for (const dir of previousReleaseDirs.splice(0)) {
    if (dir === undefined) delete process.env.EAB_DESKTOP_RELEASE_DIR
    else process.env.EAB_DESKTOP_RELEASE_DIR = dir
  }
  for (const url of previousReleaseUrls.splice(0)) {
    if (url === undefined) delete process.env.EAB_DESKTOP_RELEASE_URL
    else process.env.EAB_DESKTOP_RELEASE_URL = url
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeApp(withLocalRelease = true) {
  const dir = mkdtempSync(join(tmpdir(), 'eab-desktop-download-'))
  dirs.push(dir)
  previousHomes.push(process.env.EAB_HOME)
  previousReleaseDirs.push(process.env.EAB_DESKTOP_RELEASE_DIR)
  previousReleaseUrls.push(process.env.EAB_DESKTOP_RELEASE_URL)
  process.env.EAB_HOME = dir
  const releaseDir = join(dir, 'desktop-release')
  process.env.EAB_DESKTOP_RELEASE_DIR = releaseDir
  mkdirSync(releaseDir, { recursive: true })

  if (withLocalRelease) {
    const exe = Buffer.from('fake-eab-setup')
    const portable = Buffer.from('fake-eab-portable')
    writeFileSync(join(releaseDir, 'EAB-Setup-2026.11.26-x64.exe'), exe)
    writeFileSync(join(releaseDir, 'EAB-Desktop-Windows-x64.zip'), portable)
    writeFileSync(
      join(releaseDir, 'desktop-release.json'),
      JSON.stringify({
        version: '2026.11.26',
        platform: 'win32',
        arch: 'x64',
        file: 'EAB-Setup-2026.11.26-x64.exe',
        size: exe.length,
        sha256: createHash('sha256').update(exe).digest('hex'),
        publishedAt: '2026-11-27T00:00:00.000Z',
        notes: '测试安装包',
      }),
    )
  }

  const db = openDatabase({ path: ':memory:' })
  handles.push(db)
  migrate(db)
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
  return { app, releaseDir, dir }
}

describe('桌面版下载发布目录', () => {
  it('优先读数据目录并返回与网页一致的版本清单', async () => {
    const { app } = makeApp()
    await app.ready()

    const version = await app.inject({ method: 'GET', url: '/api/desktop/version' })
    expect(version.statusCode).toBe(200)
    expect(version.json()).toMatchObject({
      data: { version: '2026.11.26', fileName: 'EAB-Setup-2026.11.26-x64.exe', available: true },
    })

    const update = await app.inject({ method: 'GET', url: '/api/desktop/update?currentVersion=2026.11.24' })
    expect(update.statusCode).toBe(200)
    expect(update.json()).toMatchObject({
      data: { version: '2026.11.26', hasUpdate: true, downloadUrl: '/download/desktop/setup' },
    })

    const page = await app.inject({ method: 'GET', url: '/download/desktop' })
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('v2026.11.26')
    expect(page.body).toContain('下载便携版 zip')
  })

  it('安装包和便携包都从当前发布目录下载', async () => {
    const { app } = makeApp()
    await app.ready()

    const setup = await app.inject({ method: 'GET', url: '/download/desktop/setup' })
    expect(setup.statusCode).toBe(200)
    expect(setup.headers['content-disposition']).toContain('EAB-Setup-2026.11.26-x64.exe')

    const portable = await app.inject({ method: 'GET', url: '/download/desktop/portable' })
    expect(portable.statusCode).toBe(200)
    expect(portable.headers['content-disposition']).toContain('EAB-Desktop-Windows-x64.zip')
  })

  it('本地无包时从远端清单回源一次并缓存，第二次不再请求远端', async () => {
    const { app, dir } = makeApp(false)
    const exe = Buffer.from('remote-eab-setup')
    let exeHits = 0
    const server = createServer((req, res) => {
      if (req.url === '/desktop-release.json') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            version: '2026.11.26',
            platform: 'win32',
            arch: 'x64',
            file: 'EAB-Setup-2026.11.26-x64.exe',
            size: exe.length,
            sha256: createHash('sha256').update(exe).digest('hex'),
          }),
        )
        return
      }
      if (req.url === '/EAB-Setup-2026.11.26-x64.exe') {
        exeHits += 1
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(exe.length) })
        res.end(exe)
        return
      }
      res.writeHead(404)
      res.end()
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    process.env.EAB_DESKTOP_RELEASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    await app.ready()
    const first = await app.inject({ method: 'GET', url: '/download/desktop/setup' })
    expect(first.statusCode).toBe(200)
    expect(exeHits).toBe(1)
    expect(readFileSync(join(dir, 'desktop-release', 'EAB-Setup-2026.11.26-x64.exe')).length).toBe(exe.length)

    const second = await app.inject({ method: 'GET', url: '/download/desktop/setup' })
    expect(second.statusCode).toBe(200)
    expect(exeHits).toBe(1)
  })
})
