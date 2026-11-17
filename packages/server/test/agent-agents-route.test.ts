import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { migrate, openDatabase, type Db } from '@eab/storage'
import type { ServerConfig } from '../src/config.js'
import type { ServerDeps } from '../src/deps.js'
import { buildApp } from '../src/app.js'
import { AgentTeamStore } from '../src/agent-team.js'
import { writeConsoleSettings } from '../src/settings.js'

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
  const dir = mkdtempSync(join(tmpdir(), 'eab-agent-team-route-'))
  dirs.push(dir)
  previousHomes.push(process.env.EAB_HOME)
  process.env.EAB_HOME = dir
  const db = openDatabase({ path: ':memory:' })
  handles.push(db)
  migrate(db)
  const now = Date.now()
  db.prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('c1', '测试公司', 'agent-team-route', 'active', now)
  db.prepare('INSERT INTO departments (id, company_id, name, path, depth, order_no, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('d1', 'c1', '测试部门', '/c1/d1/', 1, 0, now)
  db.prepare('INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('u1', 'c1', 'd1', '/c1/d1/', '测试员工', 'active', now, now)
  db.prepare('INSERT INTO chat_sessions (id, company_id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('s1', 'c1', 'u1', '团队进度测试', now, now)

  const team = new AgentTeamStore({
    db,
    teamId: 'session:s1',
    companyId: 'c1',
    userId: 'u1',
    idleMs: 60_000,
  })
  team.registerWorker({
    key: 'worker',
    name: '长任务',
    index: 1,
    role: 'producer',
    acceptance: '必须交回三条可核对结论',
  })
  const task = team.createTask({ workerKey: 'worker', prompt: '核对 100 条记录', parentRunId: 'parent-1' })
  team.markTaskRunning(task.id, 'child-run-1', now)
  team.recordEvent({ workerKey: 'worker', kind: 'done', taskId: task.id, payload: { text: '完成 60 条' } })

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

describe('GET /api/chat/agents', () => {
  it('按会话返回持久化的 worker、任务和未消费事件，供前端刷新后恢复团队面板', async () => {
    const app = makeApp()
    await app.ready()
    const response = await app.inject({
      method: 'GET',
      url: '/api/chat/agents?sessionId=s1&as=u1',
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as {
      ok: boolean
      data: {
        workers: Array<{ key: string; status: string; role: string; parentKey: string | null }>
        tree: Array<{ key: string; role: string; children: unknown[] }>
        capacity: { active: number; limit: number }
        tasks: Array<{ key: string; status: string; prompt: string }>
        events: Array<{ key: string; kind: string }>
      }
    }
    expect(body.ok).toBe(true)
    expect(body.data.workers.find((worker) => worker.key === 'worker')?.status).toBe('running')
    expect(body.data.workers.find((worker) => worker.key === 'worker')?.role).toBe('producer')
    expect(body.data.tree[0]?.key).toBe('worker')
    expect(body.data.capacity).toMatchObject({ active: 1, limit: 8 })
    expect(body.data.tasks.some((task) => task.key === 'worker' && task.status === 'running')).toBe(true)
    expect(body.data.events.some((event) => event.key === 'worker' && event.kind === 'done')).toBe(true)
  })

  it('读取控制台保存的团队上限，不依赖启动时的 config', async () => {
    const app = makeApp()
    writeConsoleSettings({ agentTeam: { maxWorkers: 6 } })
    await app.ready()
    const response = await app.inject({
      method: 'GET',
      url: '/api/chat/agents?sessionId=s1&as=u1',
    })
    const body = response.json() as { data: { capacity: { limit: number } } }
    expect(body.data.capacity.limit).toBe(6)
  })

  it('缺少 sessionId 或会话不属于当前用户时返回明确错误', async () => {
    const app = makeApp()
    await app.ready()
    const missing = await app.inject({ method: 'GET', url: '/api/chat/agents?as=u1' })
    expect(missing.statusCode).toBe(400)
    const notFound = await app.inject({ method: 'GET', url: '/api/chat/agents?sessionId=missing&as=u1' })
    expect(notFound.statusCode).toBe(404)
  })
})
