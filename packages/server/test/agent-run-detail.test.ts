import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { migrate, openDatabase, type Db } from '@eab/storage'
import type { ServerConfig } from '../src/config.js'
import type { ServerDeps } from '../src/deps.js'
import { buildApp } from '../src/app.js'
import { getAgentRunDetail } from '../src/agent-runtime.js'

const dirs: string[] = []
const handles: Db[] = []
const apps: ReturnType<typeof buildApp>[] = []

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
  for (const db of handles.splice(0)) db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function seedRun(
  db: Db,
  input: {
    id: string
    companyId: string
    parentRunId: string | null
    agentId: string
    title: string
    status: string
    startedAt: number
    endedAt: number | null
    spentTokens: number
    error?: string | null
    budget?: number | null
  },
) {
  db.prepare(
    `INSERT INTO agent_runs
      (id, company_id, user_id, parent_run_id, agent_id, title, model_id, session_id, status,
       budget, spent_tokens, error, started_at, ended_at, created_at)
     VALUES (?, ?, 'u1', ?, ?, ?, 'model_test', 's1', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.companyId,
    input.parentRunId,
    input.agentId,
    input.title,
    input.status,
    input.budget ?? null,
    input.spentTokens,
    input.error ?? null,
    input.startedAt,
    input.endedAt,
    input.startedAt,
  )
}

function seedStep(
  db: Db,
  input: {
    id: string
    runId: string
    seq: number
    kind: string
    toolId?: string | null
    name: string
    status: string
    args?: unknown
    resultSummary?: string | null
    durationMs: number
  },
) {
  db.prepare(
    `INSERT INTO agent_steps
      (id, run_id, seq, kind, tool_id, name, status, args_json, result_summary, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.runId,
    input.seq,
    input.kind,
    input.toolId ?? null,
    input.name,
    input.status,
    input.args === undefined ? null : JSON.stringify(input.args),
    input.resultSummary ?? null,
    input.durationMs,
    Date.now(),
  )
}

function makeEnv(consoleToken = 'test-console-token') {
  const dir = mkdtempSync(join(tmpdir(), 'eab-agent-run-detail-'))
  dirs.push(dir)
  const db = openDatabase({ path: ':memory:' })
  handles.push(db)
  migrate(db)
  const now = Date.now()
  db.prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('c1', '测试公司', 'agent-run-detail', 'active', now)
  db.prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('c2', '另一家公司', 'agent-run-detail-other', 'active', now)
  db.prepare('INSERT INTO departments (id, company_id, name, path, depth, order_no, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('d1', 'c1', '测试部门', '/c1/d1/', 1, 0, now)
  db.prepare('INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('u1', 'c1', 'd1', '/c1/d1/', '测试员工', 'active', now, now)
  db.prepare('INSERT INTO chat_sessions (id, company_id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('s1', 'c1', 'u1', '任务详情测试', now, now)

  seedRun(db, {
    id: 'run-root',
    companyId: 'c1',
    parentRunId: null,
    agentId: 'eab-main',
    title: '核对本月加班',
    status: 'failed',
    startedAt: now - 60_000,
    endedAt: now - 20_000,
    spentTokens: 1200,
    error: '子任务验收未通过',
    budget: 2000,
  })
  seedRun(db, {
    id: 'run-child',
    companyId: 'c1',
    parentRunId: 'run-root',
    agentId: 'producer-1',
    title: '查询加班明细',
    status: 'failed',
    startedAt: now - 50_000,
    endedAt: now - 30_000,
    spentTokens: 800,
    error: '取数工具返回空结果',
    budget: 1000,
  })
  seedRun(db, {
    id: 'run-grand',
    companyId: 'c1',
    parentRunId: 'run-child',
    agentId: 'researcher-1',
    title: '检索制度口径',
    status: 'succeeded',
    startedAt: now - 45_000,
    endedAt: now - 40_000,
    spentTokens: 300,
    budget: 600,
  })
  seedRun(db, {
    id: 'run-other',
    companyId: 'c2',
    parentRunId: null,
    agentId: 'eab-main',
    title: '别的公司任务',
    status: 'succeeded',
    startedAt: now - 30_000,
    endedAt: now - 20_000,
    spentTokens: 100,
  })
  seedStep(db, {
    id: 'step-root-1',
    runId: 'run-root',
    seq: 0,
    kind: 'agent',
    name: '派发子任务',
    status: 'done',
    args: { worker: 'producer-1', prompt: '查询邓骏本月加班' },
    resultSummary: '已派发给 producer-1',
    durationMs: 12,
  })
  seedStep(db, {
    id: 'step-child-1',
    runId: 'run-child',
    seq: 0,
    kind: 'tool',
    toolId: 'kb.search',
    name: '知识库检索',
    status: 'error',
    args: { query: '邓骏 本月 加班', topK: 10 },
    resultSummary: '没有命中',
    durationMs: 860,
  })
  seedStep(db, {
    id: 'step-grand-1',
    runId: 'run-grand',
    seq: 0,
    kind: 'tool',
    toolId: 'kb.search',
    name: '知识库检索',
    status: 'done',
    args: { query: '加班 统计 口径' },
    resultSummary: '命中《加班管理办法》第 3 条',
    durationMs: 320,
  })

  const config = {
    host: '127.0.0.1',
    port: 0,
    adminPort: 0,
    dbPath: ':memory:',
    companyId: 'c1',
    devAuth: true,
    consoleToken,
    adminUser: 'admin',
    adminPassword: 'test-admin-password',
    logLevel: 'silent',
    onlyOfficeUrl: '',
    onlyOfficeJwtSecret: '',
    onlyOfficeInternalUrl: '',
    dataDir: dir,
    tmpDir: join(dir, 'tmp'),
  } as ServerConfig
  const deps = { db, config, companyId: 'c1', migrations: [], consoleToken } as ServerDeps
  return { db, deps, dir }
}

describe('任务详情可观测接口', () => {
  it('从任意子 Agent 点进去都能拿到整棵父子树、工具参数、耗时和 token', () => {
    const { db } = makeEnv()
    const detail = getAgentRunDetail(db, 'c1', 'run-child')
    expect(detail).not.toBeNull()
    expect(detail?.rootId).toBe('run-root')
    expect(detail?.selectedId).toBe('run-child')
    expect(detail?.truncated).toBe(false)
    expect(detail?.runs.map((run) => [run.id, run.depth, run.selected])).toEqual([
      ['run-root', 0, false],
      ['run-child', 1, true],
      ['run-grand', 2, false],
    ])
    const child = detail?.runs.find((run) => run.id === 'run-child')
    expect(child).toMatchObject({
      parentRunId: 'run-root',
      agentId: 'producer-1',
      status: 'failed',
      error: '取数工具返回空结果',
      spentTokens: 800,
      budget: 1000,
    })
    expect(child?.steps[0]).toMatchObject({
      toolId: 'kb.search',
      status: 'error',
      args: { query: '邓骏 本月 加班', topK: 10 },
      resultSummary: '没有命中',
      durationMs: 860,
    })
    expect(detail?.stats).toMatchObject({
      totalRuns: 3,
      activeRuns: 0,
      failedRuns: 2,
      totalSteps: 3,
      totalTokens: 2300,
    })
    expect(detail?.stats.wallMs).toBeGreaterThanOrEqual(40_000)
    expect(detail?.stats.totalDurationMs).toBeGreaterThanOrEqual(55_000)
  })

  it('控制台接口返回同一份详情，并拒绝找不到或跨公司的 run', async () => {
    const { deps } = makeEnv()
    const app = buildApp(deps, 'console')
    apps.push(app)
    await app.ready()
    const headers = { 'x-eab-console': '1', 'x-eab-console-token': 'test-console-token' }

    const response = await app.inject({ method: 'GET', url: '/api/console/agent-runs/run-child', headers })
    expect(response.statusCode).toBe(200)
    const body = response.json() as { ok: boolean; data: { rootId: string; runs: Array<{ id: string }> } }
    expect(body.ok).toBe(true)
    expect(body.data.rootId).toBe('run-root')
    expect(body.data.runs.map((run) => run.id)).toEqual(['run-root', 'run-child', 'run-grand'])

    const missing = await app.inject({ method: 'GET', url: '/api/console/agent-runs/run-missing', headers })
    expect(missing.statusCode).toBe(404)
    const other = await app.inject({ method: 'GET', url: '/api/console/agent-runs/run-other', headers })
    expect(other.statusCode).toBe(404)
    const noAuth = await app.inject({ method: 'GET', url: '/api/console/agent-runs/run-child' })
    expect(noAuth.statusCode).toBe(403)
  })
})
