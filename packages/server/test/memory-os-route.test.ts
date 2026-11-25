import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { migrate, openDatabase, type Db } from '@eab/storage'
import { SC } from '@eab/domain'
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
  const dir = mkdtempSync(join(tmpdir(), 'eab-memory-os-'))
  dirs.push(dir)
  const db = openDatabase({ path: ':memory:' })
  handles.push(db)
  migrate(db)
  const now = Date.now()
  db.prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('c1', '测试公司', 'memory-os', 'active', now)
  db.prepare('INSERT INTO departments (id, company_id, name, path, depth, order_no, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('d1', 'c1', '测试部门', '/c1/d1/', 1, 0, now)
  db.prepare('INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('u1', 'c1', 'd1', '/c1/d1/', '测试员工', 'active', now, now)
  for (const scope of [SC.MEMORY_READ, SC.MEMORY_WRITE, SC.MEMORY_ADMIN]) {
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
  } as ServerConfig
  const deps = {
    db,
    config,
    companyId: 'c1',
    migrations: [],
    consoleToken: '',
  } as ServerDeps
  const app = buildApp(deps, 'chat')
  apps.push(app)
  return { app, db }
}

async function createMemory(
  app: ReturnType<typeof buildApp>,
  payload: Record<string, unknown>,
) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/memories?as=u1',
    payload: { scopeType: 'user', ...payload },
  })
  return { response, body: response.json() as any }
}

describe('AGT-13 Memory OS', () => {
  it('个人高置信偏好写入后直接生效，不需要再去设置里确认', async () => {
    const { app } = makeApp()
    await app.ready()
    const created = await createMemory(app, { content: '汇报材料尽量控制在一页纸', memoryType: 'preference' })
    expect(created.response.statusCode).toBe(201)
    expect(created.body.data).toMatchObject({
      memoryType: 'preference',
      memoryTypeLabel: '偏好',
      confirmed: true,
      status: 'active',
      conflictWith: null,
    })

    const listed = await app.inject({ method: 'GET', url: '/api/memories?as=u1' })
    expect(listed.statusCode).toBe(200)
    const rows = (listed.json() as any).data.memories as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ memoryType: 'preference', status: 'active', confirmed: true })
  })

  it('高度相近的新决策不覆盖旧记忆，确认新记忆后才软删除旧记忆', async () => {
    const { app, db } = makeApp()
    await app.ready()
    const old = await createMemory(app, {
      content: '周报统一在每周五 17:00 前提交',
      memoryType: 'decision',
    })
    await app.inject({
      method: 'POST',
      url: `/api/memories/${old.body.data.id}/confirm?as=u1`,
    })

    const next = await createMemory(app, {
      content: '周报统一在每周五 18:00 前提交',
      memoryType: 'decision',
    })
    expect(next.response.statusCode).toBe(201)
    expect(next.body.data).toMatchObject({
      status: 'conflict',
      confirmed: false,
      conflictWith: old.body.data.id,
    })
    expect(next.body.data.conflictContent).toContain('17:00')

    const oldRow = db.prepare('SELECT confirmed, deleted_at FROM memories WHERE id = ?')
      .get(old.body.data.id) as { confirmed: number; deleted_at: number | null }
    expect(oldRow.confirmed).toBe(1)
    expect(oldRow.deleted_at).toBeNull()

    const confirm = await app.inject({
      method: 'POST',
      url: `/api/memories/${next.body.data.id}/confirm?as=u1`,
    })
    expect(confirm.statusCode).toBe(200)
    expect((confirm.json() as any).data).toMatchObject({
      confirmed: true,
      status: 'active',
      replacedConflictId: old.body.data.id,
    })
    const after = db.prepare('SELECT id, confirmed, deleted_at, conflict_with FROM memories ORDER BY created_at').all() as Array<{
      id: string
      confirmed: number
      deleted_at: number | null
      conflict_with: string | null
    }>
    const oldAfter = after.find((row) => row.id === old.body.data.id)
    const nextAfter = after.find((row) => row.id === next.body.data.id)
    expect(oldAfter?.deleted_at).not.toBeNull()
    expect(nextAfter).toMatchObject({ confirmed: 1, deleted_at: null, conflict_with: null })
  })

  it('完全相同的内容不重复写入', async () => {
    const { app, db } = makeApp()
    await app.ready()
    const first = await createMemory(app, { content: '常用项目叫 EAB', memoryType: 'fact' })
    expect(first.response.statusCode).toBe(201)
    const second = await createMemory(app, { content: '常用项目叫 EAB', memoryType: 'fact' })
    expect(second.response.statusCode).toBe(200)
    expect(second.body.data).toMatchObject({ id: first.body.data.id, duplicate: true })
    const count = db.prepare('SELECT COUNT(*) AS count FROM memories').get() as { count: number }
    expect(count.count).toBe(1)
  })

  it('手工事实自动补结构化槽位，确认后同一 factKey 的旧事实失效而不是删除', async () => {
    const { app, db } = makeApp()
    await app.ready()
    const first = await createMemory(app, { content: '我叫小张', memoryType: 'fact' })
    expect(first.response.statusCode).toBe(201)
    expect(first.body.data).toMatchObject({ factKey: 'user.name' })
    expect(db.prepare('SELECT subject, predicate, object_text, fact_key, extraction_source FROM memories WHERE id = ?')
      .get(first.body.data.id)).toMatchObject({
      subject: '我',
      predicate: '姓名',
      object_text: '小张',
      fact_key: 'user.name',
      extraction_source: 'manual',
    })

    await app.inject({ method: 'POST', url: `/api/memories/${first.body.data.id}/confirm?as=u1` })
    const second = await createMemory(app, { content: '我叫小李', memoryType: 'fact' })
    expect(second.body.data).toMatchObject({
      factKey: 'user.name',
      status: 'conflict',
      conflictWith: first.body.data.id,
    })
    const confirm = await app.inject({
      method: 'POST',
      url: `/api/memories/${second.body.data.id}/confirm?as=u1`,
    })
    expect((confirm.json() as any).data.expiredFactIds).toContain(first.body.data.id)

    const firstAfter = db.prepare('SELECT confirmed, deleted_at, valid_to FROM memories WHERE id = ?')
      .get(first.body.data.id) as { confirmed: number; deleted_at: number | null; valid_to: number | null }
    expect(firstAfter.confirmed).toBe(1)
    expect(firstAfter.deleted_at).toBeNull()
    expect(firstAfter.valid_to).not.toBeNull()
  })

  it('删除记忆时清空向量并写 valid_to，避免旧向量继续参与召回', async () => {
    const { app, db } = makeApp()
    await app.ready()
    const created = await createMemory(app, { content: '我的汇报习惯是一页纸', memoryType: 'fact' })
    db.prepare('UPDATE memories SET embedding = ?, embedding_model = ? WHERE id = ?')
      .run(new Uint8Array([1, 2, 3]), 'test-embed', created.body.data.id)
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/memories/${created.body.data.id}?as=u1`,
    })
    expect(removed.statusCode).toBe(200)
    const row = db.prepare('SELECT deleted_at, valid_to, embedding, embedding_model FROM memories WHERE id = ?')
      .get(created.body.data.id) as {
      deleted_at: number | null
      valid_to: number | null
      embedding: Uint8Array | null
      embedding_model: string | null
    }
    expect(row.deleted_at).not.toBeNull()
    expect(row.valid_to).not.toBeNull()
    expect(row.embedding).toBeNull()
    expect(row.embedding_model).toBeNull()
  })

  it('统计接口返回生效/待确认/自动记忆数量与维护状态', async () => {
    const { app } = makeApp()
    await app.ready()
    await createMemory(app, { content: '汇报材料尽量控制在一页纸', memoryType: 'preference' })
    const stats = await app.inject({ method: 'GET', url: '/api/memories/stats?as=u1' })
    expect(stats.statusCode).toBe(200)
    const data = (stats.json() as any).data
    expect(data.counts).toMatchObject({ total: 1, active: 1, pending: 0 })
    expect(data.autoExtract.autoConfirm).toBe(true)
    expect(data.maintenance).toBeNull()
  })

  it('统计接口返回近 7 天抽取质量与各入口轮次', async () => {
    const { app, db } = makeApp()
    await app.ready()
    const now = Date.now()
    const insertRun = db.prepare(
      `INSERT INTO memory_extraction_runs
         (id, company_id, user_id, session_id, channel, mode, auto_confirm,
          extracted, inserted, activated, duplicates, conflicts, skipped_sensitive, duration_ms, created_at)
       VALUES (?, 'c1', 'u1', 's1', ?, 'rules', 1, ?, ?, ?, ?, ?, ?, 12, ?)`,
    )
    insertRun.run('run-web', 'web', 6, 4, 3, 1, 1, 0, now)
    insertRun.run('run-dingtalk', 'dingtalk', 0, 0, 0, 0, 0, 0, now - 60_000)
    const stats = await app.inject({ method: 'GET', url: '/api/memories/stats?as=u1' })
    expect(stats.statusCode).toBe(200)
    const data = (stats.json() as any).data
    expect(data.extraction).toMatchObject({
      windowDays: 7,
      runs: 2,
      extracted: 6,
      inserted: 4,
      activated: 3,
      pending: 1,
      duplicates: 1,
      conflicts: 1,
      activationRate: 75,
      duplicateRate: 16.7,
      conflictRate: 16.7,
    })
    expect(data.extraction.channels).toEqual([
      { channel: 'web', runs: 1, inserted: 4, activated: 3, conflicts: 1 },
      { channel: 'dingtalk', runs: 1, inserted: 0, activated: 0, conflicts: 0 },
    ])
  })

  it('管理员可运行 100 条记忆评测并在统计中取回最近结果', async () => {
    const { app } = makeApp()
    await app.ready()
    const run = await app.inject({ method: 'POST', url: '/api/memories/benchmark/run?as=u1' })
    expect(run.statusCode).toBe(200)
    const result = (run.json() as any).data
    expect(result).toMatchObject({
      version: '2026-11-24.1',
      total: 100,
      expectedExtract: 60,
      expectedIgnore: 30,
      sensitiveCases: 10,
      sensitiveLeaks: 0,
      retention: { rounds: 100, recalled: true, rank: 1 },
    })
    expect(result.passed + result.missed + result.unexpected + result.sensitiveLeaks).toBe(100)
    const stats = await app.inject({ method: 'GET', url: '/api/memories/stats?as=u1' })
    expect(stats.statusCode).toBe(200)
    const data = (stats.json() as any).data
    expect(data.benchmark.dataset).toMatchObject({
      version: '2026-11-24.1',
      total: 100,
      expectedExtract: 60,
      expectedIgnore: 30,
      sensitive: 10,
      retentionRounds: 100,
    })
    expect(data.benchmark.lastRun).toMatchObject({
      id: result.id,
      total: 100,
      missed: result.missed,
      unexpected: result.unexpected,
      sensitiveLeaks: 0,
      retention: { rounds: 100, recalled: true, rank: 1 },
      stale: false,
    })
  })

  it('管理员可手动整理情景记忆，接口返回合并与归档数量', async () => {
    const { app, db } = makeApp()
    await app.ready()
    const now = Date.now()
    const insertEpisode = db.prepare(
      `INSERT INTO memories
         (id, company_id, scope_type, scope_id, user_id, content, memory_type, confirmed,
          valid_from, importance, sensitivity, extraction_source, created_at)
       VALUES (?, 'c1', 'user', 'u1', 'u1', ?, 'episode', 1, ?, 0.55, 'normal', 'auto', ?)`,
    )
    for (let index = 1; index <= 3; index += 1) {
      insertEpisode.run(`ep-${index}`, `第 ${index} 次讨论周报模板：压成一页纸。`, now - index * 86400000, now - index * 86400000)
    }
    const run = await app.inject({ method: 'POST', url: '/api/memories/maintenance/run?as=u1' })
    expect(run.statusCode).toBe(200)
    expect((run.json() as any).data).toMatchObject({ consolidated: 1, skipped: false })
    const merged = db.prepare(`SELECT COUNT(*) AS count FROM memories WHERE extraction_source = 'consolidated'`)
      .get() as { count: number }
    expect(merged.count).toBe(1)
    const listed = await app.inject({ method: 'GET', url: '/api/memories?status=all&as=u1' })
    const rows = (listed.json() as any).data.memories as Array<Record<string, unknown>>
    expect(rows.some((row) => row.source === 'consolidated')).toBe(true)
  })
})
