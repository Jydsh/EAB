import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { migrate, openDatabase, type Db } from '@eab/storage'
import type { Scope } from '@eab/domain'
import type { ServerConfig } from '../src/config.js'
import type { ServerDeps } from '../src/deps.js'
import { notifyToolApprovalPending } from '../src/tool-approval-dingtalk.js'
import type { ToolApprovalRequest } from '../src/tool-approval.js'

const dirs: string[] = []
const handles: Db[] = []

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.EAB_TEST_DING_SECRET
  for (const db of handles.splice(0)) db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeDeps() {
  const dir = mkdtempSync(join(tmpdir(), 'eab-tool-approval-dingtalk-'))
  dirs.push(dir)
  const db = openDatabase({ path: ':memory:' })
  handles.push(db)
  migrate(db)
  const now = Date.now()
  db.prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('c1', '测试公司', 'tool-approval-ding', 'active', now)
  db.prepare('INSERT INTO departments (id, company_id, name, path, depth, order_no, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('d1', 'c1', '测试部门', '/c1/d1/', 1, 0, now)
  for (const [id, name] of [['u-req', '申请人'], ['u-admin', '审批管理员']]) {
    db.prepare('INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, 'c1', 'd1', '/c1/d1/', name, 'active', now, now)
  }
  db.prepare('INSERT INTO roles (id, company_id, code, name, data_scope, builtin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('r-admin', 'c1', 'company_admin', '公司管理员', 'company', 1, now)
  db.prepare('INSERT INTO role_scopes (role_id, scope) VALUES (?, ?)').run('r-admin', 'approval:decide')
  db.prepare('INSERT INTO user_roles (user_id, role_id, granted_at) VALUES (?, ?, ?)').run('u-admin', 'r-admin', now)
  db.prepare(
    `INSERT INTO channel_configs (id, company_id, provider, enabled, status, app_id, secret_ref, robot_code, created_at, updated_at)
     VALUES (?, ?, 'dingtalk', 1, 'bound', ?, ?, ?, ?, ?)`,
  ).run('cc-1', 'c1', 'ding_test_tool_approval', 'EAB_TEST_DING_SECRET', 'robot_test', now, now)
  db.prepare(
    `INSERT INTO channel_identities (id, company_id, provider, external_id, user_id, created_at)
     VALUES (?, ?, 'dingtalk', ?, ?, ?)`,
  ).run('ci-admin', 'c1', 'staff_admin', 'u-admin', now)

  const config = {
    dbPath: join(dir, 'eab.db'),
    dataDir: dir,
    tmpDir: join(dir, 'tmp'),
  } as ServerConfig
  const deps = { db, config, companyId: 'c1', migrations: [], consoleToken: '' } as ServerDeps
  return { db, deps }
}

function mockDingTalkCard() {
  const calls: Array<{ url: string; body: Record<string, any> }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const text = String(url)
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, any> : {}
    calls.push({ url: text, body })
    if (text.includes('/v1.0/oauth2/accessToken')) {
      return new Response(JSON.stringify({ accessToken: 'token_test', expireIn: 7200 }), { status: 200 })
    }
    if (text.includes('/v1.0/card/ai/instances/createAndDeliver')) {
      return new Response(JSON.stringify({ success: true, result: { deliverResults: [{ success: true }] } }), { status: 200 })
    }
    if (text.includes('/v1.0/card/ai/instances/update')) {
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    }
    if (text.includes('/oToMessages/batchSend')) {
      return new Response(JSON.stringify({ invalidStaffIdList: [], flowControlledStaffIdList: [] }), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }))
  return calls
}

function request(): ToolApprovalRequest {
  return {
    approvalId: 'ap-1',
    toolId: 'project.exec',
    toolName: '执行项目命令',
    risk: 'exec',
    argsSummary: 'command=node --version',
    expiresAt: Date.now() + 5 * 60_000,
  }
}

function actor(id: string, scopes: Scope[]) {
  return {
    subject: { companyId: 'c1', userId: id, scopes: new Set(scopes) },
    person: { id, name: id === 'u-admin' ? '审批管理员' : '申请人' },
  }
}

describe('钉钉工具审批卡投递', () => {
  it('申请人没有审批权限时，卡片发给具备 approval:decide 且已绑定钉钉的管理员', async () => {
    process.env.EAB_TEST_DING_SECRET = 'secret_test'
    const { deps } = makeDeps()
    const calls = mockDingTalkCard()

    const sent = await notifyToolApprovalPending(deps, actor('u-req', []), request())

    expect(sent).toBe(true)
    const create = calls.find((call) => call.url.includes('/v1.0/card/ai/instances/createAndDeliver'))
    expect(create?.body.openSpaceId).toBe('dtv1.card//im_robot.staff_admin')
    expect(create?.body.a2uiMessages.some((message: string) => message.includes('工具执行审批'))).toBe(true)
    expect(create?.body.a2uiMessages.some((message: string) => message.includes('允许一次'))).toBe(true)
  })

  it('申请人是管理员但没绑钉钉时，回退发给其他有权限的管理员，而不是直接失败', async () => {
    process.env.EAB_TEST_DING_SECRET = 'secret_test'
    const { deps } = makeDeps()
    const calls = mockDingTalkCard()

    const sent = await notifyToolApprovalPending(deps, actor('u-req', ['approval:decide']), request())

    expect(sent).toBe(true)
    const create = calls.find((call) => call.url.includes('/v1.0/card/ai/instances/createAndDeliver'))
    expect(create?.body.openSpaceId).toBe('dtv1.card//im_robot.staff_admin')
  })
})
