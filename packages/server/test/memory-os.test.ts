import { describe, expect, it } from 'vitest'
import { migrate, openDatabase } from '@eab/storage'
import {
  findMemoryDuplicateOrConflict,
  loadMemoryEmbeddings,
  memoryContentSimilarity,
  memoryDecayWeight,
  memoryStatus,
  normalizeMemoryType,
} from '../src/memory-os.js'

function db() {
  const database = openDatabase({ path: ':memory:' })
  migrate(database)
  database.prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('c1', '测试公司', 'memory-os', 'active', 1)
  return database
}

describe('Memory OS 规则', () => {
  it('迁移补齐四类记忆、冲突和向量字段，历史记忆默认归为事实', () => {
    const database = db()
    const columns = database.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['memory_type', 'conflict_with', 'embedding', 'embedding_model']),
    )
    database.prepare(
      `INSERT INTO memories (id, company_id, scope_type, scope_id, user_id, content, confirmed, created_at)
       VALUES ('m1', 'c1', 'user', 'u1', 'u1', '历史记忆', 1, 1)`,
    ).run()
    const row = database.prepare('SELECT memory_type FROM memories WHERE id = ?').get('m1') as { memory_type: string }
    expect(row.memory_type).toBe('fact')
  })

  it('类型归一化与状态判断稳定', () => {
    expect(normalizeMemoryType('PREFERENCE', 'fact')).toBe('preference')
    expect(normalizeMemoryType('unknown', 'fact')).toBe('fact')
    expect(memoryStatus({ confirmed: 1, conflict_with: null })).toBe('active')
    expect(memoryStatus({ confirmed: 0, conflict_with: 'm_old' })).toBe('conflict')
    expect(memoryStatus({ confirmed: 0, conflict_with: null })).toBe('pending')
  })

  it('相近内容判冲突，完全相同判重复且不插新行', () => {
    const database = db()
    database.prepare(
      `INSERT INTO memories
        (id, company_id, scope_type, scope_id, user_id, content, memory_type, confirmed, created_at)
       VALUES ('m_old', 'c1', 'user', 'u1', 'u1', '周报统一在每周五 17:00 前提交', 'decision', 1, 1)`,
    ).run()
    expect(memoryContentSimilarity('周报统一在每周五 17:00 前提交', '周报统一在每周五 18:00 前提交'))
      .toBeGreaterThan(0.5)
    const conflict = findMemoryDuplicateOrConflict(database, {
      companyId: 'c1',
      scopeType: 'user',
      scopeId: 'u1',
      memoryType: 'decision',
      content: '周报统一在每周五 18:00 前提交',
    })
    expect(conflict).toMatchObject({ kind: 'conflict', memory: { id: 'm_old' } })
    const duplicate = findMemoryDuplicateOrConflict(database, {
      companyId: 'c1',
      scopeType: 'user',
      scopeId: 'u1',
      memoryType: 'decision',
      content: '周报统一在每周五 17:00 前提交',
    })
    expect(duplicate).toMatchObject({ kind: 'duplicate', memory: { id: 'm_old' } })
  })

  it('没有向量模型时召回退回词面，不报错也不写向量', async () => {
    const database = db()
    const result = await loadMemoryEmbeddings(
      database,
      ':memory:',
      'c1',
      [{ id: 'm1', content: '汇报材料控制在一页纸', confirmed: 1, created_at: 1 }],
      '汇报材料怎么写',
    )
    expect(result).toBeNull()
  })

  it('只有情景记忆按 45 天半衰期衰减', () => {
    const now = Date.UTC(2026, 10, 24)
    const old = now - 45 * 24 * 60 * 60 * 1000
    expect(memoryDecayWeight('episode', old, now)).toBeCloseTo(Math.exp(-1), 5)
    expect(memoryDecayWeight('preference', old, now)).toBe(1)
    expect(memoryDecayWeight('fact', old, now)).toBe(1)
    expect(memoryDecayWeight('decision', old, now)).toBe(1)
  })
})
