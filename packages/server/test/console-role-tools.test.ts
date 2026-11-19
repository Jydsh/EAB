import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { migrate, openDatabase, type Db } from '@eab/storage'
import type { ServerConfig } from '../src/config.js'
import type { ServerDeps } from '../src/deps.js'
import { buildApp } from '../src/app.js'
import { readToolRoleAccess } from '../src/tool-role-access.js'

const dirs: string[] = []
const handles: Db[] = []
const apps: ReturnType<typeof buildApp>[] = []

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
  for (const db of handles.splice(0)) db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeApp() {
  const dir = mkdtempSync(join(tmpdir(), 'eab-role-tools-'))
  dirs.push(dir)
  const db = openDatabase({ path: ':memory:' })
  handles.push(db)
  migrate(db)
  const now = Date.now()
  db.prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)').run(
    'c1',
    '测试公司',
    'role-tools',
    'active',
    now,
  )
  db.prepare('INSERT INTO departments (id, company_id, name, path, depth, order_no, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'd1',
    'c1',
    '测试部门',
    '/c1/d1/',
    1,
    0,
    now,
  )
  const insertRole = db.prepare(
    'INSERT INTO roles (id, company_id, code, name, data_scope, builtin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  for (const [id, code, name, builtin] of [
    ['r_member', 'member', '普通员工', 1],
    ['r_admin', 'company_admin', '公司管理员', 1],
    ['r_auditor', 'auditor', '审计员', 1],
    ['r_super', 'super_admin', '平台超管', 1],
  ] as const) {
    insertRole.run(id, 'c1', code, name, 'company', builtin, now)
  }
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
  const deps = { db, config, companyId: 'c1', migrations: [], consoleToken: 'test-console-token' } as ServerDeps
  const app = buildApp(deps, 'console')
  apps.push(app)
  return { app, db }
}

const headers = { 'x-eab-console': '1', 'x-eab-console-token': 'test-console-token' }

describe('角色页可用工具与工具页双向同步', () => {
  it('从角色页保存后，工具页看到相同的角色白名单', async () => {
    const { app, db } = makeApp()
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/console/roles/member/tools',
      headers,
      payload: { tools: ['time.now'] },
    })
    expect(saved.statusCode).toBe(200)
    const savedBody = JSON.parse(saved.body).data
    expect(savedBody.roleCode).toBe('member')
    expect(savedBody.tools).toEqual(['time.now'])

    expect(readToolRoleAccess(db, 'c1', 'time.now')).toEqual({ mode: 'all', roles: [] })
    expect(readToolRoleAccess(db, 'c1', 'workspace.read')).toEqual({
      mode: 'roles',
      roles: ['auditor', 'company_admin', 'super_admin'],
    })

    const access = await app.inject({ method: 'GET', url: '/api/console/tools/access', headers })
    expect(access.statusCode).toBe(200)
    const rows = JSON.parse(access.body).data.tools as Array<{
      accessId: string
      mode: string
      roleCodes: string[]
    }>
    expect(rows.find((row) => row.accessId === 'workspace.read')).toMatchObject({
      mode: 'roles',
      roleCodes: ['auditor', 'company_admin', 'super_admin'],
    })
  })

  it('从工具页恢复所有角色后，角色页保存不会覆盖其他角色', async () => {
    const { app, db } = makeApp()
    const toolSaved = await app.inject({
      method: 'PUT',
      url: '/api/console/tools/time.now/roles',
      headers,
      payload: { mode: 'roles', roles: ['member'] },
    })
    expect(toolSaved.statusCode).toBe(200)
    expect(readToolRoleAccess(db, 'c1', 'time.now')).toEqual({ mode: 'roles', roles: ['member'] })

    const allTools = (await app.inject({ method: 'GET', url: '/api/console/tools/access', headers }))
    const allIds = (JSON.parse(allTools.body).data.tools as Array<{ accessId: string }>).map((row) => row.accessId)
    const roleSaved = await app.inject({
      method: 'PUT',
      url: '/api/console/roles/member/tools',
      headers,
      payload: { tools: allIds },
    })
    expect(roleSaved.statusCode).toBe(200)
    expect(readToolRoleAccess(db, 'c1', 'time.now')).toEqual({ mode: 'roles', roles: ['member'] })

    const restore = await app.inject({
      method: 'PUT',
      url: '/api/console/tools/time.now/roles',
      headers,
      payload: { mode: 'all' },
    })
    expect(restore.statusCode).toBe(200)
    expect(readToolRoleAccess(db, 'c1', 'time.now')).toEqual({ mode: 'all', roles: [] })
  })

  it('平台超管不能从角色页收回工具，未知工具会被拒绝', async () => {
    const { app } = makeApp()
    const superAdmin = await app.inject({
      method: 'PUT',
      url: '/api/console/roles/super_admin/tools',
      headers,
      payload: { tools: [] },
    })
    expect(superAdmin.statusCode).toBe(400)

    const unknown = await app.inject({
      method: 'PUT',
      url: '/api/console/roles/member/tools',
      headers,
      payload: { tools: ['not.a.tool'] },
    })
    expect(unknown.statusCode).toBe(400)
  })
})
