import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { migrate, openDatabase, type Db } from '@eab/storage'
import type { ServerConfig } from '../src/config.js'
import type { ServerDeps } from '../src/deps.js'
import { buildApp } from '../src/app.js'
import { toolArgsDigest } from '../src/tool-approval.js'
import { handleToolApprovalCardCallback, isToolApprovalCardSession } from '../src/tool-approval-dingtalk.js'

const dirs: string[] = []
const handles: Db[] = []
const apps: ReturnType<typeof buildApp>[] = []
const previousHomes: Array<string | undefined> = []

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
  for (const db of handles.splice(0)) db.close()
  for (const home of previousHomes.splice(0)) {
    if (home === undefined) delete process.env.EAB_HOME
    else process.env.EAB_HOME = home
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeApp() {
  const dir = mkdtempSync(join(tmpdir(), 'eab-chat-approval-route-'))
  dirs.push(dir)
  previousHomes.push(process.env.EAB_HOME)
  process.env.EAB_HOME = dir
  const db = openDatabase({ path: ':memory:' })
  handles.push(db)
  migrate(db)
  const now = Date.now()
  db.prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('c1', '测试公司', 'chat-approval-route', 'active', now)
  db.prepare('INSERT INTO departments (id, company_id, name, path, depth, order_no, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('d1', 'c1', '测试部门', '/c1/d1/', 1, 0, now)
  for (const [id, name] of [['u-admin', '审批管理员'], ['u-member', '普通员工'], ['u-requester', '申请人']]) {
    db.prepare('INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, 'c1', 'd1', '/c1/d1/', name, 'active', now, now)
  }
  db.prepare('INSERT INTO roles (id, company_id, code, name, data_scope, builtin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('r-admin', 'c1', 'company_admin', '公司管理员', 'company', 1, now)
  db.prepare('INSERT INTO role_scopes (role_id, scope) VALUES (?, ?)').run('r-admin', 'approval:read')
  db.prepare('INSERT INTO role_scopes (role_id, scope) VALUES (?, ?)').run('r-admin', 'approval:decide')
  db.prepare('INSERT INTO user_roles (user_id, role_id, granted_at) VALUES (?, ?, ?)').run('u-admin', 'r-admin', now)

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
  return { app, db, deps }
}

function insertPending(db: Db, id: string, requester = 'u-requester'): string {
  const argsHash = toolArgsDigest({ command: 'node -v' })
  const now = Date.now()
  db.prepare(
    `INSERT INTO approvals (id, company_id, requester_user_id, action, resource_type, resource_id, payload_json, status, created_at, expires_at)
     VALUES (?, 'c1', ?, 'tool:project.exec', 'tool', ?, ?, 'pending', ?, ?)`,
  ).run(
    id,
    requester,
    argsHash,
    JSON.stringify({
      toolId: 'project.exec', toolName: '执行项目命令', risk: 'exec', argsSummary: 'command=node -v',
      sessionId: 's1', messageId: 'm1', expiresAt: now + 60_000,
    }),
    now,
    now + 60_000,
  )
  return argsHash
}

describe('聊天内工具审批接口', () => {
  it('管理员通过后写回 approved，used_at 留给真正执行时核销', async () => {
    const { app, db } = makeApp()
    insertPending(db, 'approval-ok')
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/tool-approvals/approval-ok/decide?as=u-admin',
      payload: { decision: 'approved' },
    })
    expect(response.statusCode).toBe(200)
    const row = db.prepare('SELECT status, decided_by, used_at FROM approvals WHERE id = ?').get('approval-ok') as {
      status: string
      decided_by: string
      used_at: number | null
    }
    expect(row.status).toBe('approved')
    expect(row.decided_by).toBe('u-admin')
    expect(row.used_at).toBeNull()
  })

  it('普通员工没有 approval:decide 时返回 403，审批保持 pending', async () => {
    const { app, db } = makeApp()
    insertPending(db, 'approval-denied')
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/tool-approvals/approval-denied/decide?as=u-member',
      payload: { decision: 'approved' },
    })
    expect(response.statusCode).toBe(403)
    const row = db.prepare('SELECT status FROM approvals WHERE id = ?').get('approval-denied') as { status: string }
    expect(row.status).toBe('pending')
  })

  it('已经处理过的审批不能重复决定', async () => {
    const { app, db } = makeApp()
    insertPending(db, 'approval-done')
    db.prepare("UPDATE approvals SET status = 'rejected', decided_by = 'u-admin', decided_at = ? WHERE id = ?")
      .run(Date.now(), 'approval-done')
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/tool-approvals/approval-done/decide?as=u-admin',
      payload: { decision: 'approved' },
    })
    expect(response.statusCode).toBe(409)
  })

  it('钉钉审批卡只允许有审批权限的绑定成员决定，且同一张卡不能重复消费', async () => {
    const { db, deps } = makeApp()
    insertPending(db, 'approval-dingtalk')
    db.prepare(
      `INSERT INTO user_identities (id, user_id, provider, external_user_id, bound_at, status)
       VALUES ('id-ding-admin', 'u-admin', 'dingtalk', 'ding-admin', ?, 'active')`,
    ).run(Date.now())

    expect(isToolApprovalCardSession('toolapproval:approval-dingtalk')).toBe(true)
    expect(isToolApprovalCardSession('approval:approval-dingtalk:1')).toBe(false)

    const consumed = await handleToolApprovalCardCallback(deps, {
      outTrackId: 'eab_a2ui_test',
      externalUserId: 'ding-admin',
      sessionId: 'toolapproval:approval-dingtalk',
      optionId: 'approve',
    })
    expect(consumed).toBe(true)
    expect((db.prepare('SELECT status, decided_by, used_at FROM approvals WHERE id = ?').get('approval-dingtalk') as {
      status: string
      decided_by: string
      used_at: number | null
    })).toMatchObject({ status: 'approved', decided_by: 'u-admin', used_at: null })

    // 再点一次同一张卡：状态已经不是 pending，不能再改。
    await handleToolApprovalCardCallback(deps, {
      outTrackId: 'eab_a2ui_test',
      externalUserId: 'ding-admin',
      sessionId: 'toolapproval:approval-dingtalk',
      optionId: 'reject',
    })
    expect((db.prepare('SELECT status FROM approvals WHERE id = ?').get('approval-dingtalk') as { status: string }).status).toBe('approved')
  })

  it('钉钉普通成员没有审批权限时不能通过工具审批卡', async () => {
    const { db, deps } = makeApp()
    insertPending(db, 'approval-dingtalk-denied')
    db.prepare(
      `INSERT INTO user_identities (id, user_id, provider, external_user_id, bound_at, status)
       VALUES ('id-ding-member', 'u-member', 'dingtalk', 'ding-member', ?, 'active')`,
    ).run(Date.now())

    await handleToolApprovalCardCallback(deps, {
      outTrackId: 'eab_a2ui_test',
      externalUserId: 'ding-member',
      sessionId: 'toolapproval:approval-dingtalk-denied',
      optionId: 'approve',
    })
    expect((db.prepare('SELECT status FROM approvals WHERE id = ?').get('approval-dingtalk-denied') as { status: string }).status).toBe('pending')
  })

  it('钉钉审批卡在过期后不能通过，状态落为 expired', async () => {
    const { db, deps } = makeApp()
    insertPending(db, 'approval-dingtalk-expired')
    db.prepare(
      `INSERT INTO user_identities (id, user_id, provider, external_user_id, bound_at, status)
       VALUES ('id-ding-admin-2', 'u-admin', 'dingtalk', 'ding-admin-2', ?, 'active')`,
    ).run(Date.now())
    db.prepare('UPDATE approvals SET expires_at = ? WHERE id = ?').run(Date.now() - 1_000, 'approval-dingtalk-expired')

    await handleToolApprovalCardCallback(deps, {
      outTrackId: 'eab_a2ui_test',
      externalUserId: 'ding-admin-2',
      sessionId: 'toolapproval:approval-dingtalk-expired',
      optionId: 'approve',
    })
    expect((db.prepare('SELECT status FROM approvals WHERE id = ?').get('approval-dingtalk-expired') as { status: string }).status).toBe('expired')
  })
})
