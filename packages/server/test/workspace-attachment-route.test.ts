import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDatabase, migrate } from '@eab/storage'
import type { ServerConfig } from '../src/config.js'
import type { ServerDeps } from '../src/deps.js'
import type { AttachmentObjectStore } from '../src/object-storage.js'
import { buildApp } from '../src/app.js'
import { EICAR_SIGNATURE } from '../src/attachment-security.js'

const dirs: string[] = []
const apps: Array<ReturnType<typeof buildApp>> = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function memoryObjectStore(failPut = false): AttachmentObjectStore & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>()
  return {
    driver: 's3',
    bucket: 'test-bucket',
    objects,
    attachmentKey: (companyId, ownerUserId, fileId) => `chat-attachments/${companyId}/${ownerUserId}/${fileId}`,
    async put(key, buffer) {
      if (failPut) throw new Error('mock object storage down')
      objects.set(key, Buffer.from(buffer))
    },
    async get(key) {
      return objects.get(key) ?? null
    },
    async delete(key) {
      objects.delete(key)
    },
  }
}

function makeApp(options: { required?: boolean; failPut?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'eab-attachment-route-'))
  dirs.push(dir)
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  db.exec('PRAGMA foreign_keys = OFF')
  const now = Date.now()
  db.prepare('INSERT INTO companies (id, name, slug, status, settings_json, created_at) VALUES (?, ?, ?, ?, NULL, ?)')
    .run('c1', '测试公司', 'c1', 'active', now)
  db.prepare('INSERT INTO departments (id, company_id, parent_id, name, path, depth, order_no, created_at) VALUES (?, ?, NULL, ?, ?, 1, 0, ?)')
    .run('d1', 'c1', '测试部门', '/c1/测试部门/', now)
  db.prepare('INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('u1', 'c1', 'd1', '/c1/测试部门/', '附件测试', 'active', now, now)
  for (const scope of ['workspace:read', 'workspace:write']) {
    db.prepare(
      `INSERT INTO permission_overrides
         (id, company_id, user_id, scope, effect, reason, expires_at, created_by, created_at, revoked_at)
       VALUES (?, 'c1', 'u1', ?, 'allow', NULL, NULL, 'test', ?, NULL)`,
    ).run(`po_${scope}`, scope, now)
  }
  const config = {
    host: '127.0.0.1',
    port: 0,
    adminPort: 0,
    dbPath: join(dir, 'eab.db'),
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
    workspacesDir: join(dir, 'workspaces'),
    tmpDir: join(dir, 'tmp'),
    agentWorkerIdleMs: 60_000,
    ...(options.required
      ? {
          objectStorage: {
            driver: 's3',
            endpoint: 'http://127.0.0.1:9000',
            bucket: 'test-bucket',
            region: 'us-east-1',
            accessKey: 'test',
            secretKey: 'test',
            prefix: 'eab',
            forcePathStyle: true,
            required: true,
          },
        }
      : {}),
  } as ServerConfig
  const store = memoryObjectStore(options.failPut)
  const deps = { db, config, companyId: 'c1', migrations: [], consoleToken: '', attachmentObjectStore: store } as ServerDeps
  const app = buildApp(deps, 'chat')
  apps.push(app)
  return { app, db, dir, store }
}

describe('对话附件上传入口', () => {
  it('上传成功后本地落盘并镜像到对象存储，响应回显 objectStorage', async () => {
    const { app, db, dir, store } = makeApp()
    await app.ready()
    const response = await app.inject({
      method: 'POST',
      url: '/api/workspace/files?as=u1',
      payload: {
        path: '对话附件/2026-11-21/upload-1/巡检记录.txt',
        text: '设备运行正常',
        mime: 'text/plain',
      },
    })
    expect(response.statusCode, response.body).toBe(200)
    const body = response.json() as {
      ok: boolean
      data: { id: string; objectStorage?: { driver: string; status: string; key: string } }
    }
    expect(body.ok).toBe(true)
    expect(body.data.objectStorage).toMatchObject({ driver: 's3', status: 'stored' })
    expect(store.objects.get(body.data.objectStorage!.key)?.toString('utf8')).toBe('设备运行正常')
    const row = db.prepare('SELECT rel_path FROM workspace_files WHERE id = ?').get(body.data.id) as { rel_path: string }
    expect(row.rel_path).toBe('对话附件/2026-11-21/upload-1/巡检记录.txt')
    expect(existsSync(join(dir, 'workspaces', 'c1', 'user-u1', row.rel_path))).toBe(true)
    expect(store.objects.size).toBe(1)
  })

  it('EICAR 在写入前被拒绝，数据库、磁盘和对象存储都不留痕', async () => {
    const { app, db, dir, store } = makeApp()
    await app.ready()
    const response = await app.inject({
      method: 'POST',
      url: '/api/workspace/files?as=u1',
      payload: {
        path: '对话附件/2026-11-21/upload-1/eicar.txt',
        text: EICAR_SIGNATURE,
        mime: 'text/plain',
      },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ ok: false, code: 'EAB_VALIDATION' })
    expect(response.json().message).toContain('EICAR')
    const count = db.prepare('SELECT COUNT(*) AS count FROM workspace_files').get() as { count: number }
    expect(Number(count.count)).toBe(0)
    expect(store.objects.size).toBe(0)
    const root = join(dir, 'workspaces')
    expect(existsSync(root) ? readdirSync(root).length : 0).toBe(0)
  })

  it('EXE 改名成 PDF 在写入前按魔数拒绝', async () => {
    const { app, db } = makeApp()
    await app.ready()
    const response = await app.inject({
      method: 'POST',
      url: '/api/workspace/files?as=u1',
      payload: {
        path: '对话附件/2026-11-21/upload-1/伪造.pdf',
        contentBase64: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)]).toString('base64'),
        mime: 'application/pdf',
      },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().message).toContain('可执行文件')
    const count = db.prepare('SELECT COUNT(*) AS count FROM workspace_files').get() as { count: number }
    expect(Number(count.count)).toBe(0)
  })

  it('EAB_S3_REQUIRED=1 时对象写失败回滚本地内容，不推进元数据', async () => {
    const { app, db, dir } = makeApp({ required: true, failPut: true })
    await app.ready()
    const response = await app.inject({
      method: 'POST',
      url: '/api/workspace/files?as=u1',
      payload: {
        path: '对话附件/2026-11-21/upload-1/巡检记录.txt',
        text: '对象存储不可用时不应留下半成品',
        mime: 'text/plain',
      },
    })
    expect(response.statusCode).toBe(502)
    expect(response.json()).toMatchObject({ ok: false, code: 'EAB_UPSTREAM' })
    const count = db.prepare('SELECT COUNT(*) AS count FROM workspace_files').get() as { count: number }
    expect(Number(count.count)).toBe(0)
    expect(existsSync(join(dir, 'workspaces', 'c1', 'user-u1', '对话附件', '2026-11-21', 'upload-1', '巡检记录.txt'))).toBe(false)
  })
})
