import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { migrate, openDatabase, type Db } from '@eab/storage'
import { buildApp } from '../src/app.js'
import type { ServerConfig } from '../src/config.js'
import type { ServerDeps } from '../src/deps.js'
import { createLocalProject } from '../src/local-project.js'

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
  const dir = mkdtempSync(join(tmpdir(), 'eab-chat-space-route-'))
  dirs.push(dir)
  previousHomes.push(process.env.EAB_HOME)
  process.env.EAB_HOME = dir
  const db = openDatabase({ path: ':memory:' })
  handles.push(db)
  migrate(db)
  const now = Date.now()
  db.prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('c1', '测试公司', 'chat-space-route', 'active', now)
  db.prepare('INSERT INTO departments (id, company_id, name, path, depth, order_no, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('d1', 'c1', '测试部门', '/c1/d1/', 1, 0, now)
  db.prepare('INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('u1', 'c1', 'd1', '/c1/d1/', '测试员工', 'active', now, now)

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
  return { app, db, dir }
}

async function createSession(app: ReturnType<typeof buildApp>) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/chat/sessions?as=u1',
    payload: { title: '项目归属测试' },
  })
  expect(response.statusCode).toBe(200)
  return (response.json() as { data: { session: { id: string } } }).data.session.id
}

describe('会话归属接口', () => {
  it('把已有会话归入本地项目，再退回云空间', async () => {
    const { app, db, dir } = makeApp()
    await app.ready()
    const projectRoot = join(dir, 'demo-project')
    mkdirSync(projectRoot)
    const project = createLocalProject(db, 'c1', 'u1', {
      path: projectRoot,
      rootRealPath: projectRoot,
      deviceId: 'dev_test',
    }).project
    const sessionId = await createSession(app)

    const moved = await app.inject({
      method: 'PATCH',
      url: `/api/chat/sessions/${sessionId}/space?as=u1`,
      payload: { spaceKind: 'local', spaceId: project.id },
    })
    expect(moved.statusCode).toBe(200)
    const movedData = moved.json() as {
      data: { moved: boolean; session: { spaceKind: string; spaceId: string; project: { name: string } } }
    }
    expect(movedData.data.moved).toBe(true)
    expect(movedData.data.session.spaceKind).toBe('local')
    expect(movedData.data.session.spaceId).toBe(project.id)
    expect(movedData.data.session.project.name).toBe('demo-project')

    const row = db.prepare('SELECT space_kind, space_id FROM chat_sessions WHERE id = ?').get(sessionId) as {
      space_kind: string
      space_id: string | null
    }
    expect(row.space_kind).toBe('local')
    expect(row.space_id).toBe(project.id)

    const back = await app.inject({
      method: 'PATCH',
      url: `/api/chat/sessions/${sessionId}/space?as=u1`,
      payload: { spaceKind: 'cloud' },
    })
    expect(back.statusCode).toBe(200)
    const after = db.prepare('SELECT space_kind, space_id FROM chat_sessions WHERE id = ?').get(sessionId) as {
      space_kind: string
      space_id: string | null
    }
    expect(after.space_kind).toBe('cloud')
    expect(after.space_id).toBeNull()
  })

  it('拒绝不存在的项目和不存在的会话', async () => {
    const { app } = makeApp()
    await app.ready()
    const sessionId = await createSession(app)

    const badProject = await app.inject({
      method: 'PATCH',
      url: `/api/chat/sessions/${sessionId}/space?as=u1`,
      payload: { spaceKind: 'local', spaceId: 'lp_missing' },
    })
    expect(badProject.statusCode).toBe(404)

    const badSession = await app.inject({
      method: 'PATCH',
      url: '/api/chat/sessions/chat_missing/space?as=u1',
      payload: { spaceKind: 'cloud' },
    })
    expect(badSession.statusCode).toBe(404)
  })

  it('空会话不出现在对话列表，首条用户消息后才出现', async () => {
    const { app, db } = makeApp()
    await app.ready()
    const sessionId = await createSession(app)

    const before = await app.inject({ method: 'GET', url: '/api/chat/sessions?as=u1' })
    expect(before.statusCode).toBe(200)
    const beforeIds = (before.json() as { data: { sessions: Array<{ id: string }> } })
      .data.sessions.map((row) => row.id)
    expect(beforeIds).not.toContain(sessionId)

    db.prepare(
      `INSERT INTO chat_messages
         (id, company_id, session_id, user_id, role, text, model_id, model_name, meta_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('m_first_user', 'c1', sessionId, 'u1', 'user', '第一条用户消息', null, null, null, Date.now())

    const after = await app.inject({ method: 'GET', url: '/api/chat/sessions?as=u1' })
    const afterIds = (after.json() as { data: { sessions: Array<{ id: string }> } })
      .data.sessions.map((row) => row.id)
    expect(afterIds).toContain(sessionId)
  })
})
