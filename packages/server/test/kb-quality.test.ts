import { describe, expect, it } from 'vitest'
import { migrate, openDatabase } from '@eab/storage'
import type { RequestActor } from '../src/session.js'
import { buildSystemPrompt } from '../src/routes/chat.js'
import { kbFreshnessOf, retrieveKbCore, type KbFreshness } from '../src/kb-retrieval.js'

const DAY = 86_400_000
const NOW = Date.parse('2026-11-24T00:00:00+08:00')

const actor = {
  person: {
    companyName: '测试公司',
    name: '测试用户',
    deptName: '测试部门',
  },
} as unknown as RequestActor

function seedKb() {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  const company = 'c1'
  const collection = 'kb1'
  db.prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(company, '测试公司', 'kb-quality', 'active', NOW)
  db.prepare(
    `INSERT INTO kb_collections (id, company_id, name, acl_mode, status, created_at, updated_at)
     VALUES (?, ?, ?, 'all', 'active', ?, ?)`,
  ).run(collection, company, '质量测试库', NOW, NOW)

  db.prepare(
    `INSERT INTO kb_docs
       (id, company_id, collection_id, title, source_type, mime, classification, status,
        chunk_count, created_at, updated_at, version)
     VALUES ('d_table', ?, ?, '采购审批权限表', 'upload', 'text/markdown', 'internal', 'indexed', 1, ?, ?, 3)`,
  ).run(company, collection, NOW - 200 * DAY, NOW - 200 * DAY)
  db.prepare(
    `INSERT INTO kb_chunks
       (id, company_id, doc_id, collection_id, ordinal, text, token_count, classification, created_at, meta_json)
     VALUES ('ch_table', ?, 'd_table', ?, 0, ?, 20, 'internal', ?, ?)`,
  ).run(
    company,
    collection,
    '金额区间 | 审批人\n50-100万元 | 分管副总\n100万元以上 | 总经理',
    NOW - 200 * DAY,
    JSON.stringify({ blockType: 'table', sheetName: '采购审批', rowRange: [1, 3] }),
  )

  db.prepare(
    `INSERT INTO kb_docs
       (id, company_id, collection_id, title, source_type, mime, classification, status,
        chunk_count, created_at, updated_at, version)
     VALUES ('d_image', ?, ?, '变电站设备巡检图示', 'upload', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'internal', 'indexed', 1, ?, ?, 1)`,
  ).run(company, collection, NOW - 30 * DAY, NOW - 30 * DAY)
  db.prepare(
    `INSERT INTO kb_chunks
       (id, company_id, doc_id, collection_id, ordinal, text, token_count, classification, created_at, meta_json)
     VALUES ('ch_image', ?, 'd_image', ?, 0, ?, 20, 'internal', ?, ?)`,
  ).run(
    company,
    collection,
    '[图片] 变电站设备巡检图示\n主变油温表读数应在 60℃ 以下。',
    NOW - 30 * DAY,
    JSON.stringify({
      blockType: 'image',
      imageAssetId: 'img_safety',
      imageCaption: '变电站设备巡检图示',
      pageNo: 2,
    }),
  )
  db.prepare(
    `INSERT INTO kb_docs
       (id, company_id, collection_id, title, source_type, mime, classification, status,
        chunk_count, created_at, updated_at, version)
     VALUES ('d_leave', ?, ?, '2024年休假管理制度', 'upload', 'text/markdown', 'internal', 'indexed', 1, ?, ?, 1)`,
  ).run(company, collection, NOW - 400 * DAY, NOW - 400 * DAY)
  db.prepare(
    `INSERT INTO kb_chunks
       (id, company_id, doc_id, collection_id, ordinal, text, token_count, classification, created_at, meta_json)
     VALUES ('ch_leave', ?, 'd_leave', ?, 0, ?, 20, 'internal', ?, ?)`,
  ).run(
    company,
    collection,
    '员工累计工作满20年的，休假15天，需提前3个工作日申请。',
    NOW - 400 * DAY,
    JSON.stringify({ blockType: 'paragraph', headingPath: ['休假管理'] }),
  )
  return { db, company, collection }
}

describe('知识库质量闭环', () => {
  it('新鲜度按更新时间分级，并额外识别标题里的旧年份', () => {
    expect(kbFreshnessOf({ updatedAt: NOW - 30 * DAY, title: '2026年制度', now: NOW }).level).toBe('fresh')
    expect(kbFreshnessOf({ updatedAt: NOW - 200 * DAY, title: '采购权限表', now: NOW }).level).toBe('aging')
    expect(kbFreshnessOf({ updatedAt: NOW - 400 * DAY, title: '2024年休假制度', now: NOW }).level).toBe('stale')
    const unknown = kbFreshnessOf({ updatedAt: null, title: '无日期制度', now: NOW })
    expect(unknown.level).toBe('unknown')
    expect(unknown.shouldWarn).toBe(true)

    const oldTitle = kbFreshnessOf({ updatedAt: NOW - 20 * DAY, title: '2023年项目验收管理办法', now: NOW })
    expect(oldTitle.level).toBe('fresh')
    expect(oldTitle.shouldWarn).toBe(true)
    expect(oldTitle.message).toContain('标题标注 2023 年')
  })

  it('检索命中带表格/图片类型、页码、版本和新鲜度', async () => {
    const { db, company, collection } = seedKb()
    const table = await retrieveKbCore(db, ':memory:', company, [collection], '采购50万元审批人', {
      mode: 'keyword',
      topK: 1,
      rerank: false,
    })
    expect(table.hits[0]).toMatchObject({
      docId: 'd_table',
      docTitle: '采购审批权限表',
      docVersion: 3,
      layout: { kind: 'table', sheetName: '采购审批', rowRange: [1, 3] },
      freshness: { level: 'aging' },
    })
    expect(table.hits[0].text).toContain('分管副总')

    const image = await retrieveKbCore(db, ':memory:', company, [collection], '主变油温表读数', {
      mode: 'keyword',
      topK: 1,
      rerank: false,
    })
    expect(image.hits[0]).toMatchObject({
      docId: 'd_image',
      layout: { kind: 'image', pageNo: 2 },
      freshness: { level: 'fresh' },
    })
    expect(image.hits[0].images[0]).toMatchObject({ assetId: 'img_safety', pageNo: 2 })
    expect(image.diagnostics.freshness).toMatchObject({ fresh: 1 })
  })

  it('关键词召回同时匹配文档标题，问“年休假制度”能找到标题命中', async () => {
    const { db, company, collection } = seedKb()
    const result = await retrieveKbCore(db, ':memory:', company, [collection], '年休假制度有哪些规定', {
      mode: 'keyword',
      topK: 2,
      rerank: false,
    })
    const leave = result.hits.find((hit) => hit.docId === 'd_leave')
    expect(leave?.docTitle).toBe('2024年休假管理制度')
    expect(leave?.freshness.level).toBe('stale')
    expect(leave?.freshness.shouldWarn).toBe(true)
  })

  it('系统提示把文档标题、片段和过期风险一起交给模型', () => {
    const freshness: KbFreshness = {
      level: 'stale',
      label: '可能过期',
      ageDays: 400,
      updatedAt: NOW - 400 * DAY,
      titleYear: 2026,
      message: '资料最后更新于 2025-10-20（约 400 天前），可能已过期，引用前请核对最新版本',
      shouldWarn: true,
    }
    const prompt = buildSystemPrompt({
      actor,
      chatTools: [],
      memories: [],
      hasAttachments: false,
      kbMode: 'retrieved',
      hits: [
        {
          collectionName: '制度库',
          docTitle: '2024年休假管理制度',
          text: '员工累计工作满20年的，年休假15天。',
          docId: 'd_leave',
          chunkId: 'ch_leave',
          layout: { kind: 'text', blockType: 'paragraph', pageNo: null, sheetName: null, rowRange: null },
          freshness,
        },
      ],
    })
    expect(prompt).toContain('【新鲜度提示】本轮有 1 条资料较旧或可能过期')
    expect(prompt).toContain('[K1] 知识库「制度库」/ 文档「2024年休假管理制度」')
    expect(prompt).toContain('资料状态：正文｜资料最后更新于 2025-10-20')
    expect(prompt).toContain('年休假15天')
    expect(prompt).toContain('必须给出资料更新时间并提示核对')
  })
})
