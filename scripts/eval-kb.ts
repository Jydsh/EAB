/**
 * AGT-15 知识库质量基准跑分器。
 *
 * 目标：用同一套可重放数据，验证回答侧依赖的三类证据：
 * - 引用：命中必须同时带文档标题和可读片段；
 * - 表格题：必须命中表格切片，并能找到对应数值/审批人；
 * - 图片题：必须命中图片切片，并带图片资产和说明；
 * - 新鲜度：较旧/过期/标题年份较早要能被稳定识别。
 *
 * 运行：pnpm eval:kb
 * 基准集：evals/kb-quality-baseline.v0.json
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate, openDatabase } from '@eab/storage'
import { retrieveKbCore, type KbFreshnessLevel } from '../packages/server/src/kb-retrieval.js'

const DAY = 86_400_000

interface FixtureChunk {
  id: string
  text: string
  meta: Record<string, unknown>
}

interface FixtureDocument {
  id: string
  title: string
  updatedDaysAgo: number
  chunks: FixtureChunk[]
}

interface FixtureCase {
  id: string
  kind: 'text' | 'table' | 'image'
  query: string
  expectDocId: string
  expectDocTitle: string
  expectSnippet: string
  expectValue?: string
  expectImageAsset?: string
  expectFreshness: KbFreshnessLevel
  expectTitleYearWarning?: boolean
}

interface Baseline {
  version: string
  name: string
  now: string
  company: { id: string; name: string }
  collection: { id: string; name: string }
  documents: FixtureDocument[]
  cases: FixtureCase[]
}

interface CaseResult {
  id: string
  kind: FixtureCase['kind']
  pass: boolean
  failures: string[]
  rank: number
  freshness: KbFreshnessLevel | null
}

const here = dirname(fileURLToPath(import.meta.url))
const baseline = JSON.parse(
  readFileSync(join(here, '..', 'evals', 'kb-quality-baseline.v0.json'), 'utf8'),
) as Baseline
const now = Date.parse(baseline.now)
if (!Number.isFinite(now)) throw new Error('基准集 now 不是有效日期')

function normalize(text: string): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

function seed(): ReturnType<typeof openDatabase> {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  const company = baseline.company.id
  const collection = baseline.collection.id
  db.prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(company, baseline.company.name, 'kb-quality-baseline', 'active', now)
  db.prepare(
    `INSERT INTO kb_collections
       (id, company_id, name, description, acl_mode, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'all', 'active', ?, ?)`,
  ).run(collection, company, baseline.collection.name, 'AGT-15 质量基准', now, now)

  for (const doc of baseline.documents) {
    const updatedAt = now - Math.max(0, doc.updatedDaysAgo) * DAY
    const createdAt = updatedAt
    db.prepare(
      `INSERT INTO kb_docs
         (id, company_id, collection_id, title, source_type, mime, classification, status,
          chunk_count, created_at, updated_at, version)
       VALUES (?, ?, ?, ?, 'upload', 'text/markdown', 'internal', 'indexed', ?, ?, ?, 1)`,
    ).run(doc.id, company, collection, doc.title, doc.chunks.length, createdAt, updatedAt)
    doc.chunks.forEach((chunk, ordinal) => {
      db.prepare(
        `INSERT INTO kb_chunks
           (id, company_id, doc_id, collection_id, ordinal, text, token_count, classification, created_at, meta_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'internal', ?, ?)`,
      ).run(
        chunk.id,
        company,
        doc.id,
        collection,
        ordinal,
        chunk.text,
        Math.ceil(chunk.text.length / 2),
        createdAt,
        JSON.stringify(chunk.meta),
      )
    })
  }
  return db
}

function evaluateCase(
  item: FixtureCase,
  hits: Awaited<ReturnType<typeof retrieveKbCore>>['hits'],
): CaseResult {
  const failures: string[] = []
  const hitIndex = hits.findIndex((hit) => hit.docId === item.expectDocId)
  const hit = hitIndex >= 0 ? hits[hitIndex] : null
  const rank = hitIndex + 1
  if (!hit) {
    failures.push(`未命中期望文档 ${item.expectDocId}`)
  } else {
    if (hit.docTitle !== item.expectDocTitle) failures.push(`标题不匹配：${hit.docTitle}`)
    const normalizedText = normalize(hit.text)
    if (!normalizedText.includes(normalize(item.expectSnippet))) {
      failures.push(`片段缺少「${item.expectSnippet}」`)
    }
    if (item.expectValue && !normalizedText.includes(normalize(item.expectValue))) {
      failures.push(`表格数值缺少「${item.expectValue}」`)
    }
    if (item.kind === 'table' && hit.layout.kind !== 'table' && hit.layout.kind !== 'mixed') {
      failures.push(`表格题命中了 ${hit.layout.kind} 切片`)
    }
    if (item.kind === 'image') {
      if (!hit.images.some((image) => image.assetId === item.expectImageAsset)) {
        failures.push(`图片资产缺少 ${item.expectImageAsset}`)
      }
      if (hit.layout.kind !== 'image' && hit.layout.kind !== 'mixed') failures.push(`图片题命中了 ${hit.layout.kind} 切片`)
    }
    if (hit.freshness.level !== item.expectFreshness) {
      failures.push(`新鲜度期望 ${item.expectFreshness}，实际 ${hit.freshness.level}`)
    }
    const titleYearWarning = Boolean(
      hit.freshness.titleYear && new Date(now).getFullYear() - hit.freshness.titleYear >= 2,
    )
    if (item.expectTitleYearWarning !== undefined && titleYearWarning !== item.expectTitleYearWarning) {
      failures.push(`标题年份提示期望 ${item.expectTitleYearWarning}，实际 ${titleYearWarning}`)
    }
    if (!normalize(hit.docTitle) || !normalize(hit.text)) failures.push('引用缺少文档标题或片段')
  }
  return {
    id: item.id,
    kind: item.kind,
    pass: failures.length === 0,
    failures,
    rank,
    freshness: hit?.freshness.level ?? null,
  }
}

async function main(): Promise<void> {
  const db = seed()
  const results: CaseResult[] = []
  for (const item of baseline.cases) {
    const result = await retrieveKbCore(
      db,
      ':memory:',
      baseline.company.id,
      [baseline.collection.id],
      item.query,
      { mode: 'keyword', topK: 3, rerank: false, canConfidential: true },
    )
    results.push(evaluateCase(item, result.hits))
  }

  const byKind = (kind: FixtureCase['kind']) => {
    const items = results.filter((item) => item.kind === kind)
    return `${items.filter((item) => item.pass).length}/${items.length}`
  }
  const freshnessPass = results.filter((item, index) => {
    const expected = baseline.cases[index].expectFreshness
    return item.freshness === expected
  }).length
  const failures = results.filter((item) => !item.pass)
  console.log(`[KB-EVAL] ${baseline.name} (${baseline.version})`)
  console.log(
    `文本 ${byKind('text')}｜表格 ${byKind('table')}｜图片 ${byKind('image')}｜` +
      `新鲜度 ${freshnessPass}/${baseline.cases.length}｜引用 ${results.filter((item) => item.rank > 0).length}/${baseline.cases.length}`,
  )
  if (failures.length > 0) {
    console.error('[KB-EVAL] 失败用例：')
    for (const failure of failures) {
      console.error(`- ${failure.id}：${failure.failures.join('；')}`)
    }
    process.exitCode = 1
    return
  }
  console.log('[KB-EVAL] 全部通过')
}

void main()
