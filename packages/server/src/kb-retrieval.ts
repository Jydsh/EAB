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

export type KbRetrievalMode = 'hybrid' | 'keyword' | 'vector'

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
  }

  if (!q || ids.length === 0) {
    return { hits: [], diagnostics: { ...baseDiagnostics, elapsedMs: Date.now() - startedAt } }
  }

  const placeholders = ids.map(() => '?').join(',')
  const terms = keywordTerms(q)
  const visibleFilter = canConfidential ? '' : `AND c.classification <> 'confidential'`

  let keywordRanked: RankedItem[] = []
  if (mode !== 'vector' && terms.length > 0) {
    const likeClause = terms.map(() => 'c.text LIKE ?').join(' OR ')
    const rows = db
      .prepare(
        `SELECT c.id AS chunk_id, c.doc_id, c.collection_id, c.text, c.classification, c.meta_json,
                k.name AS collection_name, d.title AS doc_title
           FROM kb_chunks c
           JOIN kb_collections k ON k.id = c.collection_id
           JOIN kb_docs d ON d.id = c.doc_id
          WHERE c.collection_id IN (${placeholders})
            AND d.deleted_at IS NULL
            ${visibleFilter}
            AND (${likeClause})
          LIMIT ${KEYWORD_CANDIDATE_LIMIT}`,
      )
      .all(...ids, ...terms.map((term) => `%${term}%`)) as unknown as KbCandidateRow[]

    keywordRanked = rows
      .map((row) => {
        let score = 0
        for (const term of terms) {
          if (row.text.includes(term)) score += 1
        }
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
                  k.name AS collection_name, d.title AS doc_title
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
      try {
        const results = options.rerankFn
          ? await options.rerankFn(q, candidates.map((item) => item.row.text))
          : (
              await callRerank(
                db,
                dbPath,
                companyId,
                rerankModel.id,
                q,
                candidates.map((item) => item.row.text),
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

  const hits: KbRetrievalHit[] = ranked.slice(0, topK).map((item, index) => ({
    chunkId: item.row.chunk_id,
    docId: item.row.doc_id,
    collectionId: item.row.collection_id,
    collectionName: item.row.collection_name,
    docTitle: item.row.doc_title,
    classification: item.row.classification,
    text: item.row.text,
    images: imagesOf(item.row),
    keywordRank: item.keywordRank,
    vectorRank: item.vectorRank,
    keywordScore: item.keywordScore,
    vectorScore: Number(item.vectorScore.toFixed(4)),
    rrfScore: Number(item.rrfScore.toFixed(4)),
    rerankScore: item.rerankScore === null ? null : Number(item.rerankScore.toFixed(4)),
    finalRank: index + 1,
    source: item.keywordRank && item.vectorRank ? 'hybrid' : item.vectorRank ? 'vector' : 'keyword',
  }))

  return {
    hits,
    diagnostics: { ...baseDiagnostics, elapsedMs: Date.now() - startedAt },
  }
}

function imagesOf(row: KbCandidateRow): KbRetrievalHit['images'] {
  if (!row.meta_json) return []
  try {
    const meta = JSON.parse(row.meta_json) as Record<string, unknown>
    const assetId = typeof meta.imageAssetId === 'string' ? meta.imageAssetId : ''
    if (!assetId) return []
    const pageNo = typeof meta.pageNo === 'number' ? meta.pageNo : Number.isFinite(Number(meta.pageNo)) ? Number(meta.pageNo) : null
    return [{
      assetId,
      url: docAssetUrl(row.doc_id, assetId),
      caption: typeof meta.imageCaption === 'string' ? meta.imageCaption : '',
      pageNo,
    }]
  } catch {
    return []
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
