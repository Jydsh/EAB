import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate, openDatabase, type Db } from '@eab/storage'
import { loadMemoryProfile } from '../src/memory-profile.js'
import {
  extractMemoryCandidatesByRules,
  extractMemoryShadow,
  insertAutoMemoryCandidate,
} from '../src/memory-extractor.js'
import { findStructuredFactConflict, memoryStatus } from '../src/memory-os.js'
import { selectRelevantLongTermMemories } from '../src/context-policy.js'

interface MemoryInput {
  id: string
  companyId?: string
  scopeType?: string
  scopeId?: string
  userId?: string
  content: string
  memoryType?: string
  confirmed?: number
  factKey?: string
  subject?: string
  predicate?: string
  objectText?: string
  confidence?: number
  importance?: number
  sensitivity?: string
  extractionSource?: string
  createdAt?: number
  validFrom?: number
  validTo?: number
}

function insertMemory(db: Db, input: MemoryInput): void {
  db.prepare(
    `INSERT INTO memories
       (id, company_id, scope_type, scope_id, user_id, content, memory_type, confirmed,
        subject, predicate, object_text, fact_key, confidence, importance, sensitivity,
        extraction_source, valid_from, valid_to, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.companyId ?? 'c1',
    input.scopeType ?? 'user',
    input.scopeId ?? 'u1',
    input.userId ?? 'u1',
    input.content,
    input.memoryType ?? 'fact',
    input.confirmed ?? 1,
    input.subject ?? null,
    input.predicate ?? null,
    input.objectText ?? null,
    input.factKey ?? null,
    input.confidence ?? 1,
    input.importance ?? 0.5,
    input.sensitivity ?? 'normal',
    input.extractionSource ?? 'tool',
    input.validFrom ?? input.createdAt ?? 1000,
    input.validTo ?? null,
    input.createdAt ?? 1000,
  )
}

describe('结构化记忆画像', () => {
  let db: Db

  beforeEach(() => {
    db = openDatabase({ path: ':memory:' })
    migrate(db)
    db.prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('c1', '测试公司', 'test-co', 'active', 1000)
    db.prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('c2', '另一家公司', 'other-co', 'active', 1000)
  })

  it('同一 factKey 个人范围优先于公司范围，过期事实不进入画像', () => {
    insertMemory(db, {
      id: 'm-company-name',
      scopeType: 'company',
      scopeId: 'c1',
      userId: 'u1',
      content: '公司员工姓名：老张',
      factKey: 'user.name',
      subject: '我',
      predicate: '姓名',
      objectText: '老张',
      importance: 0.8,
    })
    insertMemory(db, {
      id: 'm-user-name',
      content: '我叫小张',
      factKey: 'user.name',
      subject: '我',
      predicate: '姓名',
      objectText: '小张',
      importance: 0.9,
      createdAt: 2000,
    })
    insertMemory(db, {
      id: 'm-expired-name',
      content: '我叫小小张',
      factKey: 'user.name',
      subject: '我',
      predicate: '姓名',
      objectText: '小小张',
      importance: 0.95,
      createdAt: 3000,
      validTo: 4000,
    })
    insertMemory(db, {
      id: 'm-sensitive',
      content: '我的手机号是 13800000000',
      factKey: 'user.phone',
      objectText: '13800000000',
      sensitivity: 'sensitive',
    })
    insertMemory(db, {
      id: 'm-other-company',
      companyId: 'c2',
      content: '另一家公司的小张',
      factKey: 'user.name',
      objectText: '别家小张',
    })

    const profile = loadMemoryProfile(db, {
      companyId: 'c1',
      userId: 'u1',
      now: 5000,
      limit: 8,
    })
    expect(profile.facts).toHaveLength(1)
    expect(profile.facts[0].objectText).toBe('小张')
    expect(profile.text).toContain('姓名：小张')
    expect(profile.text).not.toContain('小小张')
    expect(profile.text).not.toContain('13800000000')
    expect(profile.text).not.toContain('别家小张')
  })

  it('100 轮场景：最近噪声不会把第 1 轮的 10 条针事实挤出画像', () => {
    for (let index = 1; index <= 10; index += 1) {
      insertMemory(db, {
        id: `needle-${index}`,
        content: `针事实${index}：项目橙子-7319 的字段${index}是值${index}`,
        factKey: `project.orange.field${index}`,
        subject: '项目橙子-7319',
        predicate: `字段${index}`,
        objectText: `值${index}`,
        importance: 0.9,
        createdAt: 1000 + index,
      })
    }
    for (let index = 1; index <= 1900; index += 1) {
      insertMemory(db, {
        id: `noise-${index}`,
        content: `第 ${index + 10} 轮临时记录：今天聊了一个无关话题`,
        memoryType: 'episode',
        factKey: undefined,
        importance: 0.5,
        createdAt: 2000 + index,
      })
    }
    const profile = loadMemoryProfile(db, {
      companyId: 'c1',
      userId: 'u1',
      now: 5000,
      limit: 12,
      maxChars: 900,
    })
    expect(profile.facts.length).toBeGreaterThanOrEqual(9)
    expect(profile.facts.filter((fact) => fact.factKey.startsWith('project.orange.field')).length).toBeGreaterThanOrEqual(9)
  })

  it('memoryStatus 能识别过期与删除', () => {
    expect(memoryStatus({ confirmed: 1, conflict_with: null, valid_to: 2000 }, 3000)).toBe('expired')
    expect(memoryStatus({ confirmed: 1, conflict_with: null, deleted_at: 1 }, 3000)).toBe('expired')
    expect(memoryStatus({ confirmed: 1, conflict_with: null }, 3000)).toBe('active')
  })
})

describe('自动记忆抽取（影子模式）', () => {
  let db: Db

  beforeEach(() => {
    db = openDatabase({ path: ':memory:' })
    migrate(db)
    db.prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('c1', '测试公司', 'test-co', 'active', 1000)
  })

  afterEach(() => {
    delete process.env.EAB_MEMORY_AUTO_EXTRACT
    delete process.env.EAB_MEMORY_AUTO_CONFIRM
  })

  it('规则只抽第一人称稳定事实和明确偏好', () => {
    const candidates = extractMemoryCandidatesByRules('我叫小张，我特别怕狗。以后都用表格回复。')
    expect(candidates.some((item) => item.factKey === 'user.name' && item.objectText === '小张')).toBe(true)
    expect(candidates.some((item) => item.factKey === 'user.fear' && item.objectText === '狗')).toBe(true)
    expect(candidates.some((item) => item.memoryType === 'preference')).toBe(true)
    expect(candidates.every((item) => item.memoryType !== 'fact' || Boolean(item.factKey))).toBe(true)
  })

  it('影子模式下自动候选只落待确认区，重复抽取不重复插入', async () => {
    process.env.EAB_MEMORY_AUTO_EXTRACT = 'rules'
    process.env.EAB_MEMORY_AUTO_CONFIRM = 'off'
    const first = await extractMemoryShadow({
      db,
      dbPath: ':memory:',
      companyId: 'c1',
      userId: 'u1',
      sessionId: 's1',
      sourceMessageId: 'msg-1',
      userText: '我叫小张，我特别怕狗。',
      modelId: null,
    })
    expect(first.inserted).toBeGreaterThanOrEqual(2)
    const rows = db.prepare(
      `SELECT id, confirmed, extraction_source, fact_key, object_text, source_message_id
         FROM memories WHERE company_id = 'c1' ORDER BY created_at`,
    ).all() as unknown as Array<{
    id: string
    confirmed: number
    extraction_source: string
    fact_key: string
    object_text: string
    source_message_id: string
  }>
    expect(rows.every((row) => row.confirmed === 0)).toBe(true)
    expect(rows.every((row) => row.extraction_source === 'auto')).toBe(true)
    expect(rows.some((row) => row.fact_key === 'user.name' && row.object_text === '小张')).toBe(true)

    const second = await extractMemoryShadow({
      db,
      dbPath: ':memory:',
      companyId: 'c1',
      userId: 'u1',
      userText: '我叫小张，我特别怕狗。',
      modelId: null,
    })
    expect(second.inserted).toBe(0)
    expect(second.duplicates).toBeGreaterThanOrEqual(2)
  })

  it('抽取运行记录保存渠道和计数，不保存用户原话', async () => {
    process.env.EAB_MEMORY_AUTO_EXTRACT = 'rules'
    process.env.EAB_MEMORY_AUTO_CONFIRM = 'off'
    const result = await extractMemoryShadow({
      db,
      dbPath: ':memory:',
      companyId: 'c1',
      userId: 'u1',
      sessionId: 's-dingtalk',
      sourceMessageId: 'msg-dingtalk',
      userText: '我叫小张，我特别怕狗。',
      modelId: null,
      channel: 'dingtalk',
    })
    const run = db.prepare(
      `SELECT channel, mode, auto_confirm, extracted, inserted, activated, duplicates, conflicts, skipped_sensitive
         FROM memory_extraction_runs ORDER BY created_at DESC LIMIT 1`,
    ).get() as {
      channel: string
      mode: string
      auto_confirm: number
      extracted: number
      inserted: number
      activated: number
      duplicates: number
      conflicts: number
      skipped_sensitive: number
    }
    expect(run).toMatchObject({
      channel: 'dingtalk',
      mode: 'rules',
      auto_confirm: 0,
      extracted: result.extracted,
      inserted: result.inserted,
      activated: 0,
      duplicates: 0,
      conflicts: 0,
      skipped_sensitive: 0,
    })
    expect(JSON.stringify(run)).not.toContain('小张')
  })

  it('默认模式下个人高置信事实与偏好自动生效，不需要用户再去设置里确认', async () => {
    const result = await extractMemoryShadow({
      db,
      dbPath: ':memory:',
      companyId: 'c1',
      userId: 'u1',
      sessionId: 's1',
      userText: '我叫小张，我特别怕狗。以后都用表格回复。',
      modelId: null,
    })
    expect(result.autoConfirm).toBe(true)
    expect(result.activated).toBeGreaterThanOrEqual(3)
    const rows = db.prepare(
      `SELECT confirmed, memory_type, fact_key FROM memories WHERE company_id = 'c1'`,
    ).all() as unknown as Array<{ confirmed: number; memory_type: string; fact_key: string | null }>
    expect(rows).toHaveLength(result.inserted)
    expect(rows.every((row) => row.confirmed === 1)).toBe(true)
    expect(rows.some((row) => row.memory_type === 'preference' && row.confirmed === 1)).toBe(true)
    expect(rows.some((row) => row.fact_key === 'user.name')).toBe(true)
  })

  it('同一 factKey 出现不同对象时标记冲突，不覆盖已确认事实', async () => {
    insertMemory(db, {
      id: 'm-old-name',
      content: '我叫老张',
      factKey: 'user.name',
      subject: '我',
      predicate: '姓名',
      objectText: '老张',
      importance: 0.9,
    })
    const result = await extractMemoryShadow({
      db,
      dbPath: ':memory:',
      companyId: 'c1',
      userId: 'u1',
      userText: '我叫小张。',
      modelId: null,
    })
    expect(result.conflicts).toBe(1)
    const pending = db.prepare(
      `SELECT id, conflict_with, confirmed FROM memories WHERE fact_key = 'user.name' AND content = '我叫小张'`,
    ).get() as unknown as { id: string; conflict_with: string; confirmed: number }
    expect(pending.confirmed).toBe(0)
    expect(pending.conflict_with).toBe('m-old-name')
    expect(findStructuredFactConflict(db, {
      companyId: 'c1',
      scopeType: 'user',
      scopeId: 'u1',
      factKey: 'user.name',
      objectText: '老张',
    })?.kind).toBe('duplicate')
  })

  it('敏感信息不写入影子记忆，关闭开关时不抽取', async () => {
    process.env.EAB_MEMORY_AUTO_EXTRACT = 'rules'
    const sensitive = await extractMemoryShadow({
      db,
      dbPath: ':memory:',
      companyId: 'c1',
      userId: 'u1',
      userText: '我叫小张，我的手机号是 13800000000。',
      modelId: null,
    })
    expect(sensitive.inserted).toBe(0)
    expect(sensitive.skippedSensitive).toBeGreaterThan(0)

    process.env.EAB_MEMORY_AUTO_EXTRACT = 'off'
    const off = await extractMemoryShadow({
      db,
      dbPath: ':memory:',
      companyId: 'c1',
      userId: 'u1',
      userText: '我叫小张。',
      modelId: null,
    })
    expect(off.mode).toBe('off')
    expect(off.inserted).toBe(0)
  })

  it('插入函数本身也拒绝敏感凭证', () => {
    const result = insertAutoMemoryCandidate(db, {
      companyId: 'c1',
      userId: 'u1',
      candidate: {
        memoryType: 'fact',
        content: '我的密码是 abc123',
        factKey: 'user.password',
        objectText: 'abc123',
        confidence: 1,
        importance: 0.8,
      },
    })
    expect(result.status).toBe('sensitive')
  })
})

describe('全量候选召回', () => {
  it('候选池不再被最近 20 条截断，早期事实仍可命中', () => {
    const memories = Array.from({ length: 120 }, (_, index) => {
      if (index === 0) {
        return {
          id: 'm-1',
          content: '项目橙子-7319 的交付日期是 2026-12-01',
          memoryType: 'fact' as const,
          createdAt: 1,
          importance: 0.5,
        }
      }
      return {
        id: `m-${index + 1}`,
        content: `第 ${index + 1} 条无关记录：今天聊了别的`,
        memoryType: 'episode' as const,
        createdAt: 2 + index,
        importance: 0.5,
      }
    })
    const picked = selectRelevantLongTermMemories(memories, '橙子-7319 的交付日期是什么', {
      limit: 4,
      now: 200,
    })
    expect(picked[0]?.content).toContain('橙子-7319')
  })
})
