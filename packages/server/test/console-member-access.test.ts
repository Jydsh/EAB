import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { migrate, openDatabase, type Db } from '@eab/storage'
import { SC } from '@eab/domain'
import type { ServerConfig } from '../src/config.js'
import type { ServerDeps } from '../src/deps.js'
import { buildApp } from '../src/app.js'
import { hashPassword } from '../src/password.js'
import { createSession, sessionCookie } from '../src/console-auth.js'
import { createEmployeeSession } from '../src/employee-session.js'
import {
  consoleScopesForMember,
  saveConsolePagePermissions,
  saveConsoleRolePagePermissions,
} from '../src/console-permissions.js'
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
  const dir = mkdtempSync(join(tmpdir(), 'eab-console-member-'))
  dirs.push(dir)
  const db = openDatabase({ path: ':memory:' })
  handles.push(db)
  migrate(db)
  const now = Date.now()
  db.prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('c1', '测试公司', 'console-member', 'active', now)
  db.prepare('INSERT INTO departments (id, company_id, name, path, depth, order_no, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('d1', 'c1', '测试部门', '/c1/d1/', 1, 0, now)
  db.prepare(
    `INSERT INTO users (id, company_id, dept_id, dept_path, name, employee_no, password_hash, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('u1', 'c1', 'd1', '/c1/d1/', '成员甲', 'M001', hashPassword('member-pass-123'), 'active', now, now)

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
  return { app, db, deps }
}

async function login(app: ReturnType<typeof buildApp>) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/console/member/login',
    headers: { 'x-eab-console': '1' },
    payload: { account: 'M001', password: 'member-pass-123' },
  })
  const setCookie = res.headers['set-cookie']
  const raw = Array.isArray(setCookie) ? setCookie : [String(setCookie ?? '')]
  const cookie = raw.map((item) => String(item).split(';')[0]).filter(Boolean).join('; ')
  return { res, cookie }
}

describe('console member access', () => {
  it('enters the member console from the chat page and clears a stale platform identity', async () => {
    const { app, db } = makeApp()
    saveConsolePagePermissions(db, 'c1', 'u1', [{ page: 'overview', canView: true }], 'test')
    const employee = createEmployeeSession(db, 'u1', {
      headers: { 'user-agent': 'test' },
      ip: '127.0.0.1',
    } as never)
    const employeeCookie = `eab_session=${employee.cookie}`
    const platformCookie = sessionCookie(createSession('admin', '127.0.0.1')).split(';')[0]

    const entry = await app.inject({
      method: 'GET',
      url: '/api/me/console-entry',
      headers: { cookie: employeeCookie },
    })
    expect(entry.statusCode).toBe(200)
    const entryBody = JSON.parse(entry.body).data
    expect(entryBody.visible).toBe(true)
    expect(entryBody.href).toMatch(/\/admin$/)

    const missingHeader = await app.inject({
      method: 'POST',
      url: '/api/me/console-entry/session',
      headers: { cookie: employeeCookie },
    })
    expect(missingHeader.statusCode).toBe(403)

    const sso = await app.inject({
      method: 'POST',
      url: '/api/me/console-entry/session',
      headers: { cookie: `${employeeCookie}; ${platformCookie}`, 'x-eab-console-entry': '1' },
    })
    expect(sso.statusCode).toBe(200)
    const setCookie = Array.isArray(sso.headers['set-cookie'])
      ? sso.headers['set-cookie'].map(String)
      : [String(sso.headers['set-cookie'] ?? '')]
    expect(setCookie.some((item) => item.includes('eab_console_sid=;') && item.includes('Max-Age=0'))).toBe(true)
    const memberCookie = setCookie
      .find((item) => item.startsWith('eab_console_member_sid='))
      ?.split(';')[0]
    expect(memberCookie).toBeTruthy()

    const access = await app.inject({
      method: 'GET',
      url: '/api/console/access',
      headers: { 'x-eab-console': '1', cookie: memberCookie ?? '' },
    })
    expect(access.statusCode).toBe(200)
    const body = JSON.parse(access.body).data
    expect(body.kind).toBe('member')
    expect(body.id).toBe('u1')
    expect(body.allowedPages).toEqual(['overview'])
  })

  it('hides and rejects the chat console entry when the member has no page permission', async () => {
    const { app, db } = makeApp()
    const employee = createEmployeeSession(db, 'u1', {
      headers: { 'user-agent': 'test' },
      ip: '127.0.0.1',
    } as never)
    const cookie = `eab_session=${employee.cookie}`
    const entry = await app.inject({ method: 'GET', url: '/api/me/console-entry', headers: { cookie } })
    expect(JSON.parse(entry.body).data.visible).toBe(false)
    const sso = await app.inject({
      method: 'POST',
      url: '/api/me/console-entry/session',
      headers: { cookie, 'x-eab-console-entry': '1' },
    })
    expect(sso.statusCode).toBe(403)
  })

  it('rejects login when the member has no console page permission', async () => {
    const { app } = makeApp()
    const { res } = await login(app)
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).code).toBe('EAB_FORBIDDEN')
  })

  it('only exposes allowed pages and blocks other console APIs', async () => {
    const { app, db } = makeApp()
    saveConsolePagePermissions(db, 'c1', 'u1', [
      { page: 'overview', canView: true, canManage: false },
      { page: 'usage', canView: true, canManage: false },
    ], 'test')

    const { res, cookie } = await login(app)
    expect(res.statusCode).toBe(200)
    const access = await app.inject({
      method: 'GET',
      url: '/api/console/access',
      headers: { 'x-eab-console': '1', cookie },
    })
    expect(access.statusCode).toBe(200)
    const body = JSON.parse(access.body).data
    expect(body.kind).toBe('member')
    expect(body.allowedPages.sort()).toEqual(['overview', 'usage'])
    expect(body.managePages.sort()).toEqual(['overview', 'usage'])
    expect(body.actionsByPage).toEqual({
      overview: ['create', 'edit', 'delete'],
      usage: ['create', 'edit', 'delete'],
    })

    const overview = await app.inject({
      method: 'GET',
      url: '/api/console/overview',
      headers: { 'x-eab-console': '1', cookie },
    })
    expect(overview.statusCode).toBe(200)

    const usage = await app.inject({
      method: 'GET',
      url: '/api/console/usage',
      headers: { 'x-eab-console': '1', cookie },
    })
    expect(usage.statusCode).toBe(200)

    const roles = await app.inject({
      method: 'GET',
      url: '/api/console/roles',
      headers: { 'x-eab-console': '1', cookie },
    })
    expect(roles.statusCode).toBe(403)
    expect(JSON.parse(roles.body).code).toBe('EAB_FORBIDDEN')

    const platformOnly = await app.inject({
      method: 'POST',
      url: '/api/console/password',
      headers: { 'x-eab-console': '1', cookie },
      payload: { currentPassword: 'x', newPassword: 'y' },
    })
    expect(platformOnly.statusCode).toBe(403)

    const page = await app.inject({ method: 'GET', url: '/admin', headers: { cookie } })
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('id="page-body"')
  })

  it('unlocks all member-management functions when the page is visible', async () => {
    const { app, db } = makeApp()
    saveConsolePagePermissions(db, 'c1', 'u1', [{ page: 'org', canView: true }], 'test')
    const { cookie } = await login(app)
    const headers = { 'x-eab-console': '1', cookie }
    const access = await app.inject({ method: 'GET', url: '/api/console/access', headers })
    const body = JSON.parse(access.body).data
    expect(body.allowedPages).toEqual(['org'])
    expect(body.actionsByPage).toEqual({ org: ['create', 'edit', 'delete'] })
    expect(body.createPages).toEqual(['org'])
    expect(body.editPages).toEqual(['org'])
    expect(body.deletePages).toEqual(['org'])

    const read = await app.inject({ method: 'GET', url: '/api/org/members', headers })
    expect(read.statusCode).toBe(200)
    const create = await app.inject({
      method: 'POST',
      url: '/api/console/members',
      headers,
      payload: { name: '新成员' },
    })
    expect(create.statusCode).not.toBe(403)
    const edit = await app.inject({
      method: 'PUT',
      url: '/api/console/members/u-missing',
      headers,
      payload: { name: '改成员' },
    })
    expect(edit.statusCode).not.toBe(403)
    const remove = await app.inject({
      method: 'DELETE',
      url: '/api/console/members/u-missing',
      headers,
    })
    expect(remove.statusCode).not.toBe(403)
  })

  it('requires channels page visibility instead of per-tab actions', async () => {
    const { app, db } = makeApp()
    saveConsolePagePermissions(db, 'c1', 'u1', [{ page: 'channels', canView: true }], 'test')

    const { cookie } = await login(app)
    const headers = { 'x-eab-console': '1', cookie }
    const access = await app.inject({ method: 'GET', url: '/api/console/access', headers })
    expect(access.statusCode).toBe(200)
    expect(JSON.parse(access.body).data.allowedPages).toEqual(['channels'])

    const list = await app.inject({ method: 'GET', url: '/api/console/channels', headers })
    expect(list.statusCode).toBe(200)
    const config = await app.inject({
      method: 'POST',
      url: '/api/console/channels/dingtalk',
      headers,
      payload: {},
    })
    expect(config.statusCode).not.toBe(403)
    const sync = await app.inject({
      method: 'POST',
      url: '/api/console/channels/dingtalk/sync',
      headers,
      payload: {},
    })
    expect(sync.statusCode).not.toBe(403)
    const bind = await app.inject({
      method: 'POST',
      url: '/api/console/channels/dingtalk/bind',
      headers,
      payload: {},
    })
    expect(bind.statusCode).not.toBe(403)
    const identities = await app.inject({ method: 'GET', url: '/api/console/channel-identities', headers })
    expect(identities.statusCode).not.toBe(403)
  })

  it('keeps system update as an independently visible secondary page', async () => {
    const { app, db } = makeApp()
    saveConsolePagePermissions(db, 'c1', 'u1', [
      { page: 'system', section: 'data', canView: true },
      { page: 'system', section: 'update', canView: true },
    ], 'test')

    const { cookie } = await login(app)
    const headers = { 'x-eab-console': '1', cookie }
    const access = await app.inject({ method: 'GET', url: '/api/console/access', headers })
    expect(access.statusCode).toBe(200)
    const body = JSON.parse(access.body).data
    expect(body.allowedPages).toEqual(['system'])
    expect(body.pages.find((item: { page: string }) => item.page === 'system:update')).toMatchObject({
      canView: true,
    })

    const update = await app.inject({ method: 'GET', url: '/api/console/update', headers })
    expect(update.statusCode).toBe(200)

    // 只取消「系统更新」可见权限，保留「系统与运维」；读取接口应立即拒绝。
    saveConsolePagePermissions(db, 'c1', 'u1', [
      { page: 'system', section: 'data', canView: true },
    ], 'test')
    const denied = await app.inject({ method: 'GET', url: '/api/console/update', headers })
    expect(denied.statusCode).toBe(403)
    expect(JSON.parse(denied.body).details.requiredSections).toEqual(['update'])
  })

  it('does not leak system scopes from a visible system-update page', async () => {
    const { app, db } = makeApp()
    saveConsolePagePermissions(db, 'c1', 'u1', [
      { page: 'system', section: 'update', canView: true },
    ], 'test')

    const { cookie } = await login(app)
    const headers = { 'x-eab-console': '1', cookie }
    const access = await app.inject({ method: 'GET', url: '/api/console/access', headers })
    expect(access.statusCode).toBe(200)
    const body = JSON.parse(access.body).data
    expect(body.pages.find((item: { page: string }) => item.page === 'system:update')).toMatchObject({
      canView: true,
    })

    // 「系统更新」不应顺带把系统页的运维 scope 放大给成员。
    const scopes = consoleScopesForMember(db, 'c1', 'u1')
    expect(scopes).not.toContain(SC.SERVICE_CONTROL)
    expect(scopes).not.toContain(SC.SYSTEM_BACKUP)
    expect(scopes).not.toContain(SC.SYSTEM_RESTORE)
  })

  it('grants console access through a role and keeps personal permissions additive', async () => {
    const { app, db } = makeApp()
    db.prepare(
      `INSERT INTO roles (id, company_id, code, name, data_scope, builtin, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('r-sub', 'c1', 'sub_admin', '子管理员', 'company', 0, Date.now())
    db.prepare('INSERT INTO user_roles (user_id, role_id, granted_by, granted_at) VALUES (?, ?, ?, ?)')
      .run('u1', 'r-sub', 'test', Date.now())

    saveConsoleRolePagePermissions(db, 'c1', 'r-sub', [
      { page: 'overview', canView: true },
      { page: 'channels', canView: true },
    ], 'test')

    // 没有个人权限也能登录：角色带来的后台入口已经生效。
    const { res, cookie } = await login(app)
    expect(res.statusCode).toBe(200)
    const headers = { 'x-eab-console': '1', cookie }
    const access = await app.inject({ method: 'GET', url: '/api/console/access', headers })
    expect(access.statusCode).toBe(200)
    const body = JSON.parse(access.body).data
    expect(body.allowedPages.sort()).toEqual(['channels', 'overview'])
    expect(body.actionsByPage).toEqual({
      overview: ['create', 'edit', 'delete'],
      channels: ['create', 'edit', 'delete'],
    })

    const sync = await app.inject({
      method: 'POST',
      url: '/api/console/channels/dingtalk/sync',
      headers,
      payload: {},
    })
    expect(sync.statusCode).not.toBe(403)

    const memberPermissions = await app.inject({
      method: 'GET',
      url: '/api/console/member-console-permissions/u1',
      headers: { 'x-eab-console': '1', 'x-eab-console-token': 'test-console-token' },
    })
    expect(memberPermissions.statusCode).toBe(200)
    const permissionBody = JSON.parse(memberPermissions.body).data
    expect(permissionBody.pages).toEqual([])
    expect(permissionBody.roleAllowedPages.sort()).toEqual(['channels', 'overview'])

    // 个人额外配置与角色权限叠加，不会把角色权限写进个人行。
    saveConsolePagePermissions(db, 'c1', 'u1', [{ page: 'usage', canView: true }], 'test')
    const merged = await app.inject({ method: 'GET', url: '/api/console/access', headers })
    expect(JSON.parse(merged.body).data.allowedPages.sort()).toEqual(['channels', 'overview', 'usage'])
  })

  it('lets a delegated member manage another role console access and records the real actor', async () => {
    const { app, db } = makeApp()
    db.prepare(
      `INSERT INTO roles (id, company_id, code, name, data_scope, builtin, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('r-role-admin', 'c1', 'role_admin', '角色管理员', 'company', 0, Date.now())
    db.prepare(
      `INSERT INTO roles (id, company_id, code, name, data_scope, builtin, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('r-target', 'c1', 'target_role', '目标角色', 'dept', 0, Date.now())
    db.prepare('INSERT INTO user_roles (user_id, role_id, granted_by, granted_at) VALUES (?, ?, ?, ?)')
      .run('u1', 'r-role-admin', 'test', Date.now())
    saveConsoleRolePagePermissions(db, 'c1', 'r-role-admin', [
      { page: 'roles', canView: true, canEdit: true },
    ], 'seed')

    const { cookie } = await login(app)
    const headers = { 'x-eab-console': '1', cookie }
    const save = await app.inject({
      method: 'PUT',
      url: '/api/console/roles/target_role',
      headers,
      payload: { consolePages: [{ page: 'overview', canView: true }] },
    })
    expect(save.statusCode).toBe(200)
    expect(JSON.parse(save.body).data.consolePages).toEqual([
      expect.objectContaining({ page: 'overview', parentPage: 'overview', canView: true }),
    ])

    const permissionRow = db
      .prepare(
        `SELECT page, updated_by FROM console_role_page_permissions
          WHERE company_id = 'c1' AND role_id = 'r-target' AND page = 'overview'`,
      )
      .get() as { page: string; updated_by: string }
    expect(permissionRow.page).toBe('overview')
    expect(permissionRow.updated_by).toBe('u1')

    const audit = db
      .prepare(
        `SELECT actor_user_id, action, resource_id FROM audit_logs
          WHERE company_id = 'c1' AND action = 'console.role.permissions.update'
          ORDER BY seq DESC LIMIT 1`,
      )
      .get() as { actor_user_id: string; action: string; resource_id: string }
    expect(audit.actor_user_id).toBe('u1')
    expect(audit.resource_id).toBe('target_role')

    // 只保存后台权限时，不覆盖角色名和数据范围。
    const role = db
      .prepare(`SELECT name, data_scope FROM roles WHERE company_id = 'c1' AND code = 'target_role'`)
      .get() as { name: string; data_scope: string }
    expect(role).toEqual({ name: '目标角色', data_scope: 'dept' })

    const clear = await app.inject({
      method: 'PUT',
      url: '/api/console/roles/target_role',
      headers,
      payload: { consolePages: [] },
    })
    expect(clear.statusCode).toBe(200)
    expect(JSON.parse(clear.body).data.consolePages).toEqual([])
    const remaining = db
      .prepare(
        `SELECT COUNT(*) AS count FROM console_role_page_permissions
          WHERE company_id = 'c1' AND role_id = 'r-target'`,
      )
      .get() as { count: number }
    expect(Number(remaining.count)).toBe(0)
  })

  it('blocks a delegated member from granting console pages to their own role', async () => {
    const { app, db } = makeApp()
    db.prepare(
      `INSERT INTO roles (id, company_id, code, name, data_scope, builtin, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('r-self', 'c1', 'self_admin', '自我管理员', 'company', 0, Date.now())
    db.prepare('INSERT INTO user_roles (user_id, role_id, granted_by, granted_at) VALUES (?, ?, ?, ?)')
      .run('u1', 'r-self', 'test', Date.now())
    saveConsoleRolePagePermissions(db, 'c1', 'r-self', [
      { page: 'roles', canView: true, canEdit: true },
    ], 'seed')

    const { cookie } = await login(app)
    const result = await app.inject({
      method: 'PUT',
      url: '/api/console/roles/self_admin',
      headers: { 'x-eab-console': '1', cookie },
      payload: { consolePages: [{ page: 'overview', canView: true }] },
    })
    expect(result.statusCode).toBe(403)
    expect(JSON.parse(result.body).message).toContain('自己所属角色')

    const rows = db
      .prepare(
        `SELECT COUNT(*) AS count FROM console_role_page_permissions
          WHERE company_id = 'c1' AND role_id = 'r-self' AND page = 'overview'`,
      )
      .get() as { count: number }
    expect(Number(rows.count)).toBe(0)
  })

  it('lets a member with the member-management page configure member console permissions', async () => {
    const { app, db } = makeApp()
    saveConsolePagePermissions(db, 'c1', 'u1', [
      { page: 'org', canView: true },
    ], 'test')

    const { res, cookie } = await login(app)
    expect(res.statusCode).toBe(200)
    const headers = { 'x-eab-console': '1', cookie }

    const access = await app.inject({ method: 'GET', url: '/api/console/access', headers })
    const accessBody = JSON.parse(access.body).data
    expect(accessBody.kind).toBe('member')
    expect(accessBody.canConfigureAccess).toBe(true)
    expect(accessBody.actionsByPage).toEqual({ org: ['create', 'edit', 'delete'] })
    const scopes = consoleScopesForMember(db, 'c1', 'u1')
    expect(scopes).toContain(SC.ORG_MEMBER_READ)
    expect(scopes).toContain(SC.ORG_MEMBER_MANAGE)
    expect(scopes).toContain(SC.AUTHZ_GRANT)

    const read = await app.inject({
      method: 'GET',
      url: '/api/console/member-console-permissions/u1',
      headers,
    })
    expect(read.statusCode).toBe(200)

    const save = await app.inject({
      method: 'PUT',
      url: '/api/console/member-console-permissions/u1',
      headers,
      payload: {
        pages: [
          { page: 'overview', canView: true },
          { page: 'org', canView: true },
        ],
      },
    })
    expect(save.statusCode).toBe(200)
    const rows = db.prepare(
      `SELECT page, can_edit, updated_by FROM console_page_permissions
        WHERE company_id = 'c1' AND user_id = 'u1' ORDER BY page`,
    ).all() as Array<{ page: string; can_edit: number; updated_by: string }>
    expect(rows).toEqual([
      { page: 'org', can_edit: 0, updated_by: 'u1' },
      { page: 'overview', can_edit: 0, updated_by: 'u1' },
    ])
  })

  it('lets the member-management page assign roles without extra section grants', async () => {
    const { app, db } = makeApp()
    saveConsolePagePermissions(db, 'c1', 'u1', [{ page: 'org', canView: true }], 'test')

    const { cookie } = await login(app)
    const headers = { 'x-eab-console': '1', cookie }
    const allowed = await app.inject({
      method: 'POST',
      url: '/api/console/members/u-missing/roles',
      headers,
      payload: { roles: ['member'] },
    })
    expect(allowed.statusCode).not.toBe(403)

    // 角色管理页本身可见也可以分配成员角色。
    saveConsolePagePermissions(db, 'c1', 'u1', [
      { page: 'roles', canView: true },
    ], 'test')
    const allowedByRoles = await app.inject({
      method: 'POST',
      url: '/api/console/members/u-missing/roles',
      headers,
      payload: { roles: ['member'] },
    })
    expect(allowedByRoles.statusCode).not.toBe(403)
  })

  it('lets a visible member-management page change member console permissions', async () => {
    const { app, db } = makeApp()
    saveConsolePagePermissions(db, 'c1', 'u1', [
      { page: 'org', canView: true },
    ], 'test')
    const { cookie } = await login(app)
    const access = await app.inject({
      method: 'GET',
      url: '/api/console/access',
      headers: { 'x-eab-console': '1', cookie },
    })
    expect(JSON.parse(access.body).data.canConfigureAccess).toBe(true)
    const save = await app.inject({
      method: 'PUT',
      url: '/api/console/member-console-permissions/u1',
      headers: { 'x-eab-console': '1', cookie },
      payload: { pages: [{ page: 'overview', canView: true }] },
    })
    expect(save.statusCode).toBe(200)
  })

  it('lets a role manager configure role tools without the tools page', async () => {
    const { app, db } = makeApp()
    db.prepare(
      `INSERT INTO roles (id, company_id, code, name, data_scope, builtin, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('r-role-admin', 'c1', 'role_admin', '角色管理员', 'company', 0, Date.now())
    db.prepare(
      `INSERT INTO roles (id, company_id, code, name, data_scope, builtin, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('r-target', 'c1', 'target_role', '目标角色', 'dept', 0, Date.now())
    db.prepare('INSERT INTO user_roles (user_id, role_id, granted_by, granted_at) VALUES (?, ?, ?, ?)')
      .run('u1', 'r-role-admin', 'test', Date.now())
    saveConsoleRolePagePermissions(db, 'c1', 'r-role-admin', [
      { page: 'roles', canView: true, canEdit: true },
    ], 'seed')

    const { cookie } = await login(app)
    const headers = { 'x-eab-console': '1', cookie }
    const catalog = await app.inject({ method: 'GET', url: '/api/console/tools/access', headers })
    expect(catalog.statusCode).toBe(200)
    const ids = (JSON.parse(catalog.body).data.tools as Array<{ accessId: string }>).map((row) => row.accessId)
    expect(ids).toContain('time.now')

    const save = await app.inject({
      method: 'PUT',
      url: '/api/console/roles/target_role/tools',
      headers,
      payload: { tools: ['time.now'] },
    })
    expect(save.statusCode).toBe(200)
    const access = readToolRoleAccess(db, 'c1', 'workspace.read')
    expect(access.mode).toBe('roles')
    expect(access.roles).toContain('role_admin')
    expect(access.roles).not.toContain('target_role')
  })

  it('keeps platform token at full access', async () => {
    const { app } = makeApp()
    const access = await app.inject({
      method: 'GET',
      url: '/api/console/access',
      headers: { 'x-eab-console': '1', 'x-eab-console-token': 'test-console-token' },
    })
    expect(access.statusCode).toBe(200)
    const body = JSON.parse(access.body).data
    expect(body.kind).toBe('platform')
    expect(body.allowedPages).toHaveLength(21)
    expect(body.canConfigureAccess).toBe(true)

    const roles = await app.inject({
      method: 'GET',
      url: '/api/console/roles',
      headers: { 'x-eab-console': '1', 'x-eab-console-token': 'test-console-token' },
    })
    expect(roles.statusCode).toBe(200)
  })
})
