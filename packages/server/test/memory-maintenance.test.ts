import { beforeEach, describe, expect, it } from 'vitest'
import { migrate, openDatabase, type Db } from '@eab/storage'
import { runMemoryMaintenance, lastMemoryMaintenanceRun } from '../src/memory-maintenance.js'
import { memoryStatus } from '../src/memory-os.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_760_000_000_000

function insertEpisode(
  db: Db,
  input: {
    id: string
    content: string
    createdAt: number
    importance?: number
    recallCount?: number
    confirmed?: number
  },
): void {
  db.prepare(
    `INSERT INTO memories
       (id, company_id, scope_type, scope_id, user_id, content, memory_type, confirmed,
        valid_from, importance, sensitivity, extraction_source, recall_count, created_at)
     VALUES (?, 'c1', 'user', 'u1', 'u1', ?, 'episode', ?, ?, ?, 'normal', 'auto', ?, ?)`,
  ).run(
    input.id,
    input.content,
    input.confirmed ?? 1,
    input.createdAt,
    input.importance ?? 0.55,
    input.recallCount ?? 0,
    input.createdAt,
  )
}

describe('记忆维护（D 阶段）', () => {
  let db: Db

  beforeEach(() => {
    db = openDatabase({ path: ':memory:' })
    migrate(db)
    db.prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('c1', '测试公司', 'test-co', 'active', 1000)
  })

  it('相似且时间相近的情景合并成一条合集，原始记录归档但保留', () => {
    for (let index = 1; index <= 3; index += 1) {
      insertEpisode(db, {
        id: `ep-${index}`,
        content: `第 ${index} 次讨论周报模板：把周报压成一页纸，保留结论和风险。`,
        createdAt: NOW - index * DAY,
      })
    }
    insertEpisode(db, {
      id: 'ep-unrelated',
      content: '客户投诉物流延迟，已让仓储组补发并回访。',
      createdAt: NOW - DAY,
    })

    const result = runMemoryMaintenance(db, { companyId: 'c1', now: NOW, force: true })
    expect(result.skipped).toBe(false)
    expect(result.scanned).toBe(4)
    expect(result.consolidated).toBe(1)

    const merged = db.prepare(
      `SELECT content, cluster_key, merged_from, archived_at, importance
         FROM memories WHERE extraction_source = 'consolidated'`,
    ).all() as unknown as Array<{
      content: string
      cluster_key: string
      merged_from: string
      archived_at: number | null
      importance: number
    }>
    expect(merged).toHaveLength(1)
    expect(merged[0]?.content).toContain('情景合集（3 条）')
    expect(merged[0]?.content).toContain('周报')
    expect(merged[0]?.archived_at).toBeNull()
    expect(JSON.parse(merged[0]?.merged_from ?? '[]')).toHaveLength(3)

    const originals = db.prepare(
      `SELECT archived_at, cluster_key FROM memories WHERE id LIKE 'ep-%' AND id <> 'ep-unrelated'`,
    ).all() as unknown as Array<{ archived_at: number | null; cluster_key: string | null }>
    expect(originals.every((row) => row.archived_at === NOW)).toBe(true)
    expect(originals.every((row) => Boolean(row.cluster_key))).toBe(true)

    const unrelated = db.prepare(`SELECT archived_at FROM memories WHERE id = 'ep-unrelated'`)
      .get() as { archived_at: number | null }
    expect(unrelated.archived_at).toBeNull()
  })

  it('超过归档期限且从未被召回的旧情景归档，被召回过的保留', () => {
    insertEpisode(db, {
      id: 'old-never',
      content: '很早以前讨论过一次会议室预订。',
      createdAt: NOW - 200 * DAY,
    })
    insertEpisode(db, {
      id: 'old-recalled',
      content: '很早以前讨论过一次差旅报销，但后来被召回。',
      createdAt: NOW - 200 * DAY,
      recallCount: 3,
    })
    insertEpisode(db, {
      id: 'recent',
      content: '昨天讨论了项目排期。',
      createdAt: NOW - DAY,
    })

    const result = runMemoryMaintenance(db, { companyId: 'c1', now: NOW, force: true })
    expect(result.archived).toBe(1)
    const rows = db.prepare(
      `SELECT id, archived_at FROM memories WHERE id IN ('old-never','old-recalled','recent') ORDER BY id`,
    ).all() as unknown as Array<{ id: string; archived_at: number | null }>
    expect(rows.find((row) => row.id === 'old-never')?.archived_at).toBe(NOW)
    expect(rows.find((row) => row.id === 'old-recalled')?.archived_at).toBeNull()
    expect(rows.find((row) => row.id === 'recent')?.archived_at).toBeNull()
    expect(memoryStatus({
      confirmed: 1,
      conflict_with: null,
      archived_at: NOW,
    })).toBe('archived')
  })

  it('20 小时内不重复自动运行，手动 force 可再跑，并留下运行记录', () => {
    const first = runMemoryMaintenance(db, { companyId: 'c1', now: NOW })
    expect(first.skipped).toBe(false)
    const second = runMemoryMaintenance(db, { companyId: 'c1', now: NOW + DAY / 24 })
    expect(second.skipped).toBe(true)
    const forced = runMemoryMaintenance(db, { companyId: 'c1', now: NOW + DAY / 24, force: true })
    expect(forced.skipped).toBe(false)
    const last = lastMemoryMaintenanceRun(db, 'c1')
    expect(last?.startedAt).toBe(NOW + DAY / 24)
    expect(last?.result).toMatchObject({ skipped: false })
  })
})
