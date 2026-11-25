/**
 * 知识库检索核心。
 *
 * 对话检索与召回测试共用同一条路径：关键词召回 + 向量召回 + RRF 融合 + 可选 rerank。
 * 调用方负责先裁好 collectionIds 与密级权限；本模块只做纯检索与诊断，不读用户身份。
 */
import type { Db } from '@eab/storage'
import { callEmbeddings, callRerank, type EmbeddingResult } from './llm.js'
import { resolveModelForPurpose } from './model-registry.js'
import {
  getCollectionEmbeddingModel,
  searchChunkVectors,
  type EmbedFn,
} from './kb-vector.js'
import { chunkRetrievalText } from './kb-chunk-text.js'

export type KbRetrievalMode = 'hybrid' | 'keyword' | 'vector'

/** 知识库新鲜度：用于回答侧提示“这条资料是否可能过期”。 */
export type KbFreshnessLevel = 'fresh' | 'aging' | 'stale' | 'unknown'

export interface KbFreshness {
  readonly level: KbFreshnessLevel
  readonly label: string
  /** 距离最后更新（或标题年份）的天数；无法判断时为 null。 */
  readonly ageDays: number | null
  /** 文档最后更新时间（毫秒时间戳）。 */
  readonly updatedAt: number | null
  /** 标题中标注的年份，如“2024年差旅制度”；没有则为 null。 */
  readonly titleYear: number | null
  readonly message: string
  /** level 非 fresh，或标题年份明显早于当前年份时为 true。 */
  readonly shouldWarn: boolean
}

/** 切片类型：正文、表格、图片或同一片里既有表格又有图片。 */
export type KbHitKind = 'text' | 'table' | 'image' | 'mixed'

export interface KbHitLayout {
  readonly kind: KbHitKind
  readonly blockType: string
  readonly pageNo: number | null
  readonly sheetName: string | null
  readonly rowRange: readonly [number, number] | null
}

export interface KbRetrievalOptions {
  readonly mode?: KbRetrievalMode
  readonly topK?: number
  /** 向量相似度门槛，0–1；低于该值的向量候选不参与融合。 */
  readonly vectorThreshold?: number
  /** 是否在融合后尝试 kb.rerank；没有配置 rerank 模型时只返回 warning。 */
  readonly rerank?: boolean
  readonly canConfidential?: boolean
  /** 召回测试对比用：强制使用指定向量模型；默认按知识库路由。 */
  readonly embeddingModelId?: string
  readonly embed?: EmbedFn
  readonly rerankFn?: (
    query: string,
    documents: readonly string[],
  ) => Promise<readonly { index: number; score: number }[]>
}

import { docAssetUrl } from './kb-assets.js'

export interface KbRetrievalImage {
  assetId: string
  url: string
  caption: string
  pageNo: number | null
}

export interface KbRetrievalHit {
  readonly chunkId: string
  readonly docId: string
  readonly collectionId: string
  readonly collectionName: string
  readonly docTitle: string
  readonly classification: string
  readonly text: string
  readonly images: readonly KbRetrievalImage[]
  /** 正文/表格/图片类型与页码、工作表、行号，供引用卡片和表格题评测使用。 */
  readonly layout: KbHitLayout
  /** 文档最后更新时间和新鲜度分级，供回答侧做“可能过期”提示。 */
  readonly freshness: KbFreshness
  readonly docUpdatedAt: number | null
  readonly docVersion: number
  readonly keywordRank: number
  readonly vectorRank: number
  readonly keywordScore: number
  readonly vectorScore: number
  readonly rrfScore: number
  readonly rerankScore: number | null
  readonly finalRank: number
  readonly source: 'hybrid' | 'keyword' | 'vector'
}

export interface KbRetrievalDiagnostics {
  readonly mode: KbRetrievalMode
  readonly topK: number
  readonly vectorThreshold: number
  readonly keywordCandidates: number
  readonly vectorCandidates: number
  readonly mergedCandidates: number
  readonly rerankUsed: boolean
  readonly rerankModelId: string | null
  readonly embeddingModelIds: string[]
  readonly elapsedMs: number
  readonly warnings: string[]
  /** 本轮命中按新鲜度分布；stale 命中会在回答上下文里加提示。 */
  readonly freshness: Record<KbFreshnessLevel, number>
}

export interface KbRetrievalResult {
  readonly hits: KbRetrievalHit[]
  readonly diagnostics: KbRetrievalDiagnostics
}

interface KbCandidateRow {
  chunk_id: string
  doc_id: string
  collection_id: string
  text: string
  classification: string
  collection_name: string
  doc_title: string
  doc_updated_at: number | null
  doc_created_at: number | null
  doc_version: number | null
  meta_json: string | null
}

interface RankedItem {
  row: KbCandidateRow
  keywordRank: number
  vectorRank: number
  keywordScore: number
  vectorScore: number
  rrfScore: number
  rerankScore: number | null
}

const DEFAULT_TOP_K = 5
const MAX_TOP_K = 20
const KEYWORD_CANDIDATE_LIMIT = 500
const VECTOR_CANDIDATE_LIMIT = 40
const RERANK_CANDIDATE_LIMIT = 20

/** 把问题拆成短词/二元组；关键词路径用，向量路径直接用整句。 */
export function keywordTerms(question: string): string[] {
  const blocks = question
    .replace(/[，。！？、,.!?;:（）()【】“”"'《》\s]+/g, ' ')
    .split(' ')
    .map((item) => item.trim())
    .filter((item) => item.length >= 2)
  const terms: string[] = []
  for (const block of blocks) {
    if (block.length <= 4) {
      terms.push(block)
      continue
    }
    // 中文没有空格：用二元组保证「年假」「制度」这类词能被命中
    for (let index = 0; index < block.length - 1; index += 1) {
      const gram = block.slice(index, index + 2)
      if (!/^(的|了|是|在|和|与|及|有|吗|呢|么|什|怎|哪|这|那|我|你|他)$/.test(gram)) terms.push(gram)
    }
  }
  return [...new Set(terms)].slice(0, 12)
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

function clampScore(value: unknown, fallback: number): number {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(1, Math.max(0, number))
}

/**
 * 主检索。collectionIds 必须是调用方已做过身份/ACL 裁剪的集合。
 * 没有向量模型、向量调用失败、rerank 失败都只写 warning，不抛异常。
 */
export async function retrieveKbCore(
  db: Db,
  dbPath: string,
  companyId: string,
  collectionIds: readonly string[],
  question: string,
  options: KbRetrievalOptions = {},
): Promise<KbRetrievalResult> {
  const startedAt = Date.now()
  const q = String(question ?? '').trim()
  const ids = [...new Set(collectionIds)].filter(Boolean)
  const mode: KbRetrievalMode = options.mode === 'keyword' || options.mode === 'vector' ? options.mode : 'hybrid'
  const topK = clampInt(options.topK, DEFAULT_TOP_K, 1, MAX_TOP_K)
  const vectorThreshold = clampScore(options.vectorThreshold, 0)
  const canConfidential = options.canConfidential ?? true
  const warnings: string[] = []
  const baseDiagnostics = {
    mode,
    topK,
    vectorThreshold,
    keywordCandidates: 0,
    vectorCandidates: 0,
    mergedCandidates: 0,
    rerankUsed: false,
    rerankModelId: null as string | null,
    embeddingModelIds: [] as string[],
    elapsedMs: 0,
    warnings,
    freshness: { fresh: 0, aging: 0, stale: 0, unknown: 0 } as Record<KbFreshnessLevel, number>,
  }

  if (!q || ids.length === 0) {
    return { hits: [], diagnostics: { ...baseDiagnostics, elapsedMs: Date.now() - startedAt } }
  }

  const placeholders = ids.map(() => '?').join(',')
  const terms = keywordTerms(q)
  const visibleFilter = canConfidential ? '' : `AND c.classification <> 'confidential'`

  let keywordRanked: RankedItem[] = []
  if (mode !== 'vector' && terms.length > 0) {
    // 标题路径存在 meta_json 中，正文不一定重复。只扫 text 会漏掉“三、申诉、执行与公示”
    // 这类制度条框，因此关键词候选同时匹配正文、元数据标题路径和文档标题。
    const likeClause = terms.map(() => '(c.text LIKE ? OR c.meta_json LIKE ? OR d.title LIKE ?)').join(' OR ')
    const rows = db
      .prepare(
        `SELECT c.id AS chunk_id, c.doc_id, c.collection_id, c.text, c.classification, c.meta_json,
                k.name AS collection_name, d.title AS doc_title,
                d.updated_at AS doc_updated_at, d.created_at AS doc_created_at, d.version AS doc_version
           FROM kb_chunks c
           JOIN kb_collections k ON k.id = c.collection_id
           JOIN kb_docs d ON d.id = c.doc_id
          WHERE c.collection_id IN (${placeholders})
            AND d.deleted_at IS NULL
            ${visibleFilter}
            AND (${likeClause})
          LIMIT ${KEYWORD_CANDIDATE_LIMIT}`,
      )
      .all(...ids, ...terms.flatMap((term) => [`%${term}%`, `%${term}%`, `%${term}%`])) as unknown as KbCandidateRow[]

    keywordRanked = rows
      .map((row) => {
        const searchable = `${row.doc_title}\n${chunkRetrievalText(row.meta_json, row.text)}`
        let score = 0
        for (const term of terms) {
          if (searchable.includes(term)) score += 1
        }
        // 正文里完整出现文档标题的切片通常就是标题页/主图，标题同名查询时优先命中它。
        if (row.text.includes(row.doc_title)) score += 1
        return {
          row,
          keywordRank: 0,
          vectorRank: 0,
          keywordScore: score,
          vectorScore: 0,
          rrfScore: 0,
          rerankScore: null,
        }
      })
      .filter((item) => item.keywordScore > 0)
      .sort((a, b) => b.keywordScore - a.keywordScore)
      .slice(0, VECTOR_CANDIDATE_LIMIT)
      .map((item, index) => ({ ...item, keywordRank: index + 1 }))
  }
  baseDiagnostics.keywordCandidates = keywordRanked.length

  let vectorRanked: RankedItem[] = []
  if (mode !== 'keyword') {
    const modelGroups = new Map<
      string,
      { model: { id: string; name: string }; collectionIds: string[] }
    >()
    for (const collectionId of ids) {
      if (options.embeddingModelId) {
        const forced = { id: options.embeddingModelId, name: options.embeddingModelId }
        const group = modelGroups.get(forced.id) ?? { model: forced, collectionIds: [] }
        group.collectionIds.push(collectionId)
        modelGroups.set(forced.id, group)
        continue
      }
      let model: ReturnType<typeof getCollectionEmbeddingModel>
      try {
        model = getCollectionEmbeddingModel(db, companyId, collectionId)
      } catch (err) {
        warnings.push(`知识库 ${collectionId} 的向量模型不可用：${errorText(err)}`)
        continue
      }
      if (!model) continue
      const group: { model: { id: string; name: string }; collectionIds: string[] } =
        modelGroups.get(model.id) ?? { model, collectionIds: [] }
      group.collectionIds.push(collectionId)
      modelGroups.set(model.id, group)
    }
    baseDiagnostics.embeddingModelIds = [...modelGroups.keys()]

    const vectorHitsById = new Map<string, { chunkId: string; docId: string; score: number }>()
    for (const group of modelGroups.values()) {
      try {
        const questionText = q.slice(0, 2000)
        const embedded: EmbeddingResult = options.embed
          ? await options.embed([questionText])
          : await callEmbeddings(db, dbPath, companyId, group.model.id, [questionText])
        const queryVector = embedded.vectors[0] ?? []
        if (queryVector.length === 0) {
          warnings.push(`向量模型 ${group.model.name} 返回空向量`)
          continue
        }
        const hits = searchChunkVectors(
          db,
          companyId,
          group.collectionIds,
          group.model.id,
          queryVector,
          VECTOR_CANDIDATE_LIMIT,
        )
        for (const hit of hits) {
          if (hit.score < vectorThreshold) continue
          const current = vectorHitsById.get(hit.chunkId)
          if (!current || hit.score > current.score) {
            vectorHitsById.set(hit.chunkId, { chunkId: hit.chunkId, docId: hit.docId, score: hit.score })
          }
        }
      } catch (err) {
        warnings.push(`向量检索失败（${group.model.name}）：${errorText(err)}`)
      }
    }

    if (vectorHitsById.size > 0) {
      const rankedHits = [...vectorHitsById.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, VECTOR_CANDIDATE_LIMIT)
      const hitRows = db
        .prepare(
          `SELECT c.id AS chunk_id, c.doc_id, c.collection_id, c.text, c.classification, c.meta_json,
                  k.name AS collection_name, d.title AS doc_title,
                  d.updated_at AS doc_updated_at, d.created_at AS doc_created_at, d.version AS doc_version
             FROM kb_chunks c
             JOIN kb_collections k ON k.id = c.collection_id
             JOIN kb_docs d ON d.id = c.doc_id
            WHERE c.id IN (${rankedHits.map(() => '?').join(',')})
              AND d.deleted_at IS NULL
              ${visibleFilter}`,
        )
        .all(...rankedHits.map((hit) => hit.chunkId)) as unknown as KbCandidateRow[]
      const rowById = new Map(hitRows.map((row) => [row.chunk_id, row]))
      const items: RankedItem[] = []
      rankedHits.forEach((hit, index) => {
        const row = rowById.get(hit.chunkId)
        if (!row) return
        items.push({
          row,
          keywordRank: 0,
          vectorRank: index + 1,
          keywordScore: 0,
          vectorScore: hit.score,
          rrfScore: 0,
          rerankScore: null,
        })
      })
      vectorRanked = items
    }
  }
  baseDiagnostics.vectorCandidates = vectorRanked.length

  const merged = new Map<string, RankedItem>()
  for (const item of keywordRanked) {
    merged.set(item.row.chunk_id, { ...item, rrfScore: 1 / (60 + item.keywordRank) })
  }
  for (const item of vectorRanked) {
    const existing = merged.get(item.row.chunk_id)
    if (existing) {
      existing.vectorRank = item.vectorRank
      existing.vectorScore = item.vectorScore
      existing.rrfScore += 1 / (60 + item.vectorRank)
    } else {
      merged.set(item.row.chunk_id, { ...item, rrfScore: 1 / (60 + item.vectorRank) })
    }
  }

  const ranked = [...merged.values()].sort((a, b) => b.rrfScore - a.rrfScore)
  baseDiagnostics.mergedCandidates = ranked.length

  if (options.rerank && ranked.length > 1) {
    const rerankModel = resolveModelForPurpose(db, companyId, 'kb.rerank')
    if (!rerankModel) {
      warnings.push('没有配置 kb.rerank 模型，本次未重排序')
    } else {
      baseDiagnostics.rerankModelId = rerankModel.id
      const candidates = ranked.slice(0, RERANK_CANDIDATE_LIMIT)
      const candidateTexts = candidates.map((item) => chunkRetrievalText(item.row.meta_json, item.row.text))
      try {
        const results = options.rerankFn
          ? await options.rerankFn(q, candidateTexts)
          : (
              await callRerank(
                db,
                dbPath,
                companyId,
                rerankModel.id,
                q,
                candidateTexts,
                Math.min(4, topK),
              )
            ).results
        const seen = new Set<string>()
        for (const hit of results) {
          const item = candidates[hit.index]
          if (!item || seen.has(item.row.chunk_id)) continue
          seen.add(item.row.chunk_id)
          item.rerankScore = hit.score
        }
        if (seen.size > 0) {
          baseDiagnostics.rerankUsed = true
          ranked.sort((a, b) => {
            const aRerank = a.rerankScore
            const bRerank = b.rerankScore
            if (aRerank === null && bRerank === null) return b.rrfScore - a.rrfScore
            if (aRerank === null) return 1
            if (bRerank === null) return -1
            return bRerank - aRerank
          })
        }
      } catch (err) {
        warnings.push(`重排序失败：${errorText(err)}`)
      }
    }
  }

  // 强关键词命中保护：同一文档常有许多切片同时进入向量候选，融合后会靠“双路加分”
  // 把关键词排名第 1 的精确命中挤出 topK。这里只为首条高关键词分（>=2）命中保留席位，
  // 避免“问年休假却只返回快奖制度”这类精度倒退。
  const protectedIds = new Set(
    keywordRanked
      .filter((item) => item.keywordScore >= 2)
      .slice(0, Math.min(1, topK))
      .map((item) => item.row.chunk_id),
  )
  const ordered = [
    ...keywordRanked
      .filter((item) => protectedIds.has(item.row.chunk_id))
      .map((item) => merged.get(item.row.chunk_id) ?? item),
    ...ranked.filter((item) => !protectedIds.has(item.row.chunk_id)),
  ]

  const hits: KbRetrievalHit[] = ordered.slice(0, topK).map((item, index) => ({
    chunkId: item.row.chunk_id,
    docId: item.row.doc_id,
    collectionId: item.row.collection_id,
    collectionName: item.row.collection_name,
    docTitle: item.row.doc_title,
    classification: item.row.classification,
    text: chunkRetrievalText(item.row.meta_json, item.row.text),
    images: imagesOf(item.row),
    layout: layoutOf(item.row),
    freshness: kbFreshnessOf({
      title: item.row.doc_title,
      updatedAt: Number(item.row.doc_updated_at ?? item.row.doc_created_at ?? 0) || null,
    }),
    docUpdatedAt: Number(item.row.doc_updated_at ?? item.row.doc_created_at ?? 0) || null,
    docVersion: Math.max(1, Number(item.row.doc_version ?? 1) || 1),
    keywordRank: item.keywordRank,
    vectorRank: item.vectorRank,
    keywordScore: item.keywordScore,
    vectorScore: Number(item.vectorScore.toFixed(4)),
    rrfScore: Number(item.rrfScore.toFixed(4)),
    rerankScore: item.rerankScore === null ? null : Number(item.rerankScore.toFixed(4)),
    finalRank: index + 1,
    source: item.keywordRank && item.vectorRank ? 'hybrid' : item.vectorRank ? 'vector' : 'keyword',
  }))

  for (const hit of hits) baseDiagnostics.freshness[hit.freshness.level] += 1

  return {
    hits,
    diagnostics: { ...baseDiagnostics, elapsedMs: Date.now() - startedAt },
  }
}

function metaOf(row: KbCandidateRow): Record<string, unknown> {
  if (!row.meta_json) return {}
  try {
    const value = JSON.parse(row.meta_json) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function pageNoOf(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null
}

function rowRangeOf(value: unknown): readonly [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) return null
  const start = Number(value[0])
  const end = Number(value[1])
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  return [Math.max(1, Math.floor(start)), Math.max(Math.floor(start), Math.floor(end))]
}

function layoutOf(row: KbCandidateRow): KbHitLayout {
  const meta = metaOf(row)
  const blockType = String(meta.blockType ?? '').trim()
  const hasTable = blockType === 'table' || Boolean(meta.sheetName) || rowRangeOf(meta.rowRange) !== null
  const hasImage = Boolean(meta.imageAssetId) || blockType === 'image'
  return {
    kind: hasTable && hasImage ? 'mixed' : hasImage ? 'image' : hasTable ? 'table' : 'text',
    blockType: blockType || 'paragraph',
    pageNo: pageNoOf(meta.pageNo),
    sheetName: typeof meta.sheetName === 'string' && meta.sheetName.trim() ? meta.sheetName.trim() : null,
    rowRange: rowRangeOf(meta.rowRange),
  }
}

function titleYearOf(title: string): number | null {
  const match = String(title || '').match(/(?:19|20)\d{2}/)
  if (!match) return null
  const year = Number(match[0])
  return year >= 1900 && year <= 2100 ? year : null
}

/**
 * 判断知识新鲜度。
 *
 * 目前 EAB 没有单独的“制度生效日期”字段，这里使用文档最后更新时间作为主依据；
 * 标题里出现年份时额外做一次版本提示，防止旧制度刚上传就被当成新资料。
 * 阈值：180 天内较新；181-365 天较旧；超过 365 天可能过期。
 */
export function kbFreshnessOf(input: {
  title?: string | null
  updatedAt?: number | null
  now?: number
}): KbFreshness {
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now()
  const updatedAtRaw = Number(input.updatedAt)
  const updatedAt = Number.isFinite(updatedAtRaw) && updatedAtRaw > 0 ? updatedAtRaw : null
  const titleYear = titleYearOf(String(input.title ?? ''))
  const titleYearWarning = Boolean(titleYear && new Date(now).getFullYear() - titleYear >= 2)
  const titleNote = titleYearWarning ? `；标题标注 ${titleYear} 年，早于当前版本，请核对` : ''
  if (!updatedAt) {
    return {
      level: 'unknown',
      label: '更新时间未知',
      ageDays: null,
      updatedAt: null,
      titleYear,
      message: `资料更新时间未知，引用前请核对最新版本${titleNote}`,
      shouldWarn: true,
    }
  }
  const ageDays = Math.max(0, Math.floor((now - updatedAt) / 86_400_000))
  const level: KbFreshnessLevel = ageDays <= 180 ? 'fresh' : ageDays <= 365 ? 'aging' : 'stale'
  const label = level === 'fresh' ? '较新' : level === 'aging' ? '较旧' : '可能过期'
  const stamp = new Date(updatedAt)
  const pad = (value: number) => String(value).padStart(2, '0')
  const dateText = `${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}`
  const ageText = ageDays < 1 ? '今天更新' : `约 ${ageDays} 天前`
  const message = level === 'fresh'
    ? `资料最后更新于 ${dateText}（${ageText}）${titleNote}`
    : level === 'aging'
      ? `资料最后更新于 ${dateText}（${ageText}），已超过半年未更新，建议核对最新版本${titleNote}`
      : `资料最后更新于 ${dateText}（${ageText}），可能已过期，引用前请核对最新版本${titleNote}`
  return {
    level,
    label,
    ageDays,
    updatedAt,
    titleYear,
    message,
    shouldWarn: level !== 'fresh' || titleYearWarning,
  }
}

function imagesOf(row: KbCandidateRow): KbRetrievalHit['images'] {
  const meta = metaOf(row)
  const assetId = typeof meta.imageAssetId === 'string' ? meta.imageAssetId : ''
  if (!assetId) return []
  return [{
    assetId,
    url: docAssetUrl(row.doc_id, assetId),
    caption: typeof meta.imageCaption === 'string' ? meta.imageCaption : '',
    pageNo: pageNoOf(meta.pageNo),
  }]
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
