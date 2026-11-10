/**
 * 知识库向量索引与向量检索的基础能力。
 *
 * 这里只解决三件事：
 * 1. 把文本切片批量送 embedding 模型，落成 float32 BLOB；
 * 2. 记录每篇文档的索引状态和失败原因，失败不影响文本关键词检索；
 * 3. 给混合检索提供"问题向量 → topN 切片"的候选。
 *
 * 不引入外部向量库：先旁表 + 内存余弦，数据到百万级再换 ANN。
 */
import { randomUUID } from 'node:crypto'
import type { Db } from '@eab/storage'
import { EC, EabError } from '@eab/domain'
import { callEmbeddings, type EmbeddingResult } from './llm.js'
import {
  findModelById,
  resolveModelForPurpose,
  type ModelCapabilityRecord,
} from './model-registry.js'

const DEFAULT_BATCH = 32
const MAX_BATCH = 64
const FLOAT32_BYTES = 4

export type EmbedFn = (texts: readonly string[]) => Promise<EmbeddingResult>

export interface KbVectorHit {
  readonly chunkId: string
  readonly docId: string
  readonly score: number
  readonly distance: number
}

interface CollectionRow {
  id: string
  name: string
  embedding_model_id: string | null
}

interface DocRow {
  id: string
  title: string
  status: string
}

interface ChunkRow {
  id: string
  doc_id: string
  ordinal: number
  text: string
}

interface EmbeddingRow {
  chunk_id: string
  doc_id: string
  dim: number
  vector: Uint8Array
  norm: number
}

function l2Norm(vector: readonly number[]): number {
  let sum = 0
  for (const value of vector) sum += value * value
  return Math.sqrt(sum)
}

export function encodeVector(vector: readonly number[]): Buffer {
  const buffer = Buffer.alloc(vector.length * FLOAT32_BYTES)
  vector.forEach((value, index) => buffer.writeFloatLE(value, index * FLOAT32_BYTES))
  return buffer
}

export function decodeVector(input: Uint8Array): number[] {
  const buffer = Buffer.from(input)
  const out: number[] = []
  for (let offset = 0; offset + FLOAT32_BYTES <= buffer.byteLength; offset += FLOAT32_BYTES) {
    out.push(buffer.readFloatLE(offset))
  }
  return out
}

/** 点积除以两边的模长；norm 为 0 时按不相似处理，避免 NaN 污染排序。 */
export function cosineSimilarity(a: readonly number[], aNorm: number, b: readonly number[], bNorm: number): number {
  if (a.length !== b.length || aNorm <= 0 || bNorm <= 0) return 0
  let dot = 0
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i]
  return dot / (aNorm * bNorm)
}

export function getCollectionEmbeddingModel(
  db: Db,
  companyId: string,
  collectionId: string,
): ModelCapabilityRecord | null {
  const collection = db
    .prepare('SELECT id, name, embedding_model_id FROM kb_collections WHERE id = ? AND company_id = ? AND deleted_at IS NULL')
    .get(collectionId, companyId) as unknown as CollectionRow | undefined
  if (!collection) throw new EabError(EC.NOT_FOUND, '知识库不存在或已删除')

  if (collection.embedding_model_id) {
    const explicit = findModelById(db, companyId, collection.embedding_model_id)
    if (!explicit) {
      throw new EabError(EC.VALIDATION, `知识库「${collection.name}」指定的向量模型已不可用`, {
        hint: '请到模型接入页启用该模型，或清空知识库的向量模型绑定后重新选择',
      })
    }
    return explicit
  }
  return resolveModelForPurpose(db, companyId, 'kb.embed')
}

function docStatus(db: Db, companyId: string, docId: string, status: string, extra: Record<string, unknown> = {}): void {
  const modelId = (extra.indexModelId as string | undefined) ?? null
  const error = (extra.error as string | undefined) ?? null
  const indexedAt = status === 'indexed' ? Date.now() : null
  db.prepare(
    `UPDATE kb_docs
        SET status = ?, index_error = ?, indexed_at = COALESCE(?, indexed_at), index_model_id = COALESCE(?, index_model_id)
      WHERE id = ? AND company_id = ?`,
  ).run(status, error, indexedAt, modelId, docId, companyId)
}

interface IndexDocResult {
  readonly chunks: number
  readonly ok: boolean
  readonly error?: string
}

async function indexOneDoc(
  db: Db,
  companyId: string,
  collectionId: string,
  doc: DocRow,
  model: ModelCapabilityRecord,
  embed: EmbedFn,
  batchSize: number,
): Promise<IndexDocResult> {
  const chunks = db
    .prepare(
      `SELECT id, doc_id, ordinal, text
         FROM kb_chunks
        WHERE company_id = ? AND collection_id = ? AND doc_id = ?
        ORDER BY ordinal ASC`,
    )
    .all(companyId, collectionId, doc.id) as unknown as ChunkRow[]
  if (chunks.length === 0) {
    const error = '文档没有可索引的切片'
    docStatus(db, companyId, doc.id, 'failed', { error })
    return { chunks: 0, ok: false, error }
  }

  const vectors: number[][] = []
  try {
    for (let offset = 0; offset < chunks.length; offset += batchSize) {
      const batch = chunks.slice(offset, offset + batchSize)
      const result = await embed(batch.map((chunk) => chunk.text))
      if (result.vectors.length !== batch.length) {
        throw new EabError(EC.UPSTREAM, `向量数量不匹配：期望 ${batch.length}，实际 ${result.vectors.length}`)
      }
      vectors.push(...result.vectors.map((vector) => [...vector]))
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    docStatus(db, companyId, doc.id, 'failed', { error })
    return { chunks: chunks.length, ok: false, error }
  }

  const dim = vectors[0]?.length ?? 0
  if (dim === 0 || vectors.some((vector) => vector.length !== dim)) {
    const error = '向量模型返回了空向量或维度不一致'
    docStatus(db, companyId, doc.id, 'failed', { error })
    return { chunks: chunks.length, ok: false, error }
  }

  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM kb_chunk_embeddings WHERE doc_id = ?').run(doc.id)
    const insert = db.prepare(
      `INSERT INTO kb_chunk_embeddings
         (chunk_id, company_id, collection_id, doc_id, model_id, dim, vector, norm, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const now = Date.now()
    chunks.forEach((chunk, index) => {
      const vector = vectors[index]
      insert.run(
        chunk.id,
        companyId,
        collectionId,
        doc.id,
        model.id,
        dim,
        encodeVector(vector),
        l2Norm(vector),
        now,
      )
    })
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    const error = err instanceof Error ? err.message : String(err)
    docStatus(db, companyId, doc.id, 'failed', { error })
    return { chunks: chunks.length, ok: false, error }
  }

  db.prepare(
    `UPDATE kb_docs
        SET status = 'indexed', index_error = NULL, indexed_at = ?, index_model_id = ?
      WHERE id = ? AND company_id = ?`,
  ).run(Date.now(), model.id, doc.id, companyId)
  return { chunks: chunks.length, ok: true }
}

export interface KbIndexSummary {
  readonly totalDocs: number
  readonly indexedDocs: number
  readonly failedDocs: number
  readonly chunks: number
  readonly modelId: string | null
  readonly errors: readonly string[]
}

/**
 * 重建一个知识库的向量索引（同步版本，主要给测试和后台任务复用）。
 * `embed` 不传时走真实模型；传了可注入假向量，便于验证流程。
 */
export async function indexKbCollection(
  db: Db,
  dbPath: string,
  companyId: string,
  collectionId: string,
  options: {
    readonly docId?: string
    readonly embed?: EmbedFn
    readonly batchSize?: number
  } = {},
): Promise<KbIndexSummary> {
  const model = getCollectionEmbeddingModel(db, companyId, collectionId)
  if (!model) {
    throw new EabError(EC.VALIDATION, '还没有配置知识库向量模型', {
      hint: '先到「模型接入」添加一个 embedding 模型，并在用途路由里把它绑定到「知识库向量化」；未配置时系统继续用关键词检索。',
    })
  }
  const batchSize = Math.max(1, Math.min(MAX_BATCH, options.batchSize ?? DEFAULT_BATCH))
  const embed =
    options.embed ??
    ((texts: readonly string[]) => callEmbeddings(db, dbPath, companyId, model.id, texts))

  const docs = db
    .prepare(
      `SELECT id, title, status
         FROM kb_docs
        WHERE company_id = ? AND collection_id = ? AND deleted_at IS NULL
          ${options.docId ? 'AND id = ?' : ''}
        ORDER BY created_at ASC`,
    )
    .all(
      ...(options.docId ? [companyId, collectionId, options.docId] : [companyId, collectionId]),
    ) as unknown as DocRow[]

  const errors: string[] = []
  let indexedDocs = 0
  let failedDocs = 0
  let chunks = 0
  for (const doc of docs) {
    db.prepare('UPDATE kb_docs SET status = ? WHERE id = ? AND company_id = ?').run('indexing', doc.id, companyId)
    const result = await indexOneDoc(db, companyId, collectionId, doc, model, embed, batchSize)
    chunks += result.chunks
    if (result.ok) indexedDocs += 1
    else {
      failedDocs += 1
      errors.push(`${doc.title}: ${result.error ?? '未知错误'}`)
    }
  }
  return {
    totalDocs: docs.length,
    indexedDocs,
    failedDocs,
    chunks,
    modelId: model.id,
    errors,
  }
}

interface JobRow {
  id: string
  status: string
  total: number
  done: number
  failed: number
  error: string | null
  model_id: string | null
}

function updateJob(
  db: Db,
  jobId: string,
  patch: Partial<Pick<JobRow, 'status' | 'total' | 'done' | 'failed' | 'error' | 'model_id'>>,
): void {
  db.prepare(
    `UPDATE kb_index_jobs
        SET status = COALESCE(?, status), total = COALESCE(?, total), done = COALESCE(?, done),
            failed = COALESCE(?, failed), error = ?, model_id = COALESCE(?, model_id), updated_at = ?
      WHERE id = ?`,
  ).run(
    patch.status ?? null,
    patch.total ?? null,
    patch.done ?? null,
    patch.failed ?? null,
    patch.error ?? null,
    patch.model_id ?? null,
    Date.now(),
    jobId,
  )
}

async function runJob(
  db: Db,
  dbPath: string,
  jobId: string,
  companyId: string,
  collectionId: string,
  docId: string | undefined,
  embed: EmbedFn | undefined,
): Promise<void> {
  updateJob(db, jobId, { status: 'running' })
  try {
    const model = getCollectionEmbeddingModel(db, companyId, collectionId)
    if (model) updateJob(db, jobId, { model_id: model.id })
    const summary = await indexKbCollection(db, dbPath, companyId, collectionId, {
      ...(docId ? { docId } : {}),
      ...(embed ? { embed } : {}),
    })
    updateJob(db, jobId, summary.failedDocs > 0 ? {
      status: 'failed',
      total: summary.totalDocs,
      done: summary.indexedDocs,
      failed: summary.failedDocs,
      error: summary.errors.slice(0, 5).join('；').slice(0, 1000),
    } : {
      status: 'done',
      total: summary.totalDocs,
      done: summary.indexedDocs,
      failed: 0,
      error: '',
    })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    updateJob(db, jobId, { status: 'failed', error: error.slice(0, 1000) })
    db.prepare(
      `UPDATE kb_docs SET status = 'failed', index_error = ?
        WHERE company_id = ? AND collection_id = ? AND status = 'indexing'`,
    ).run(error.slice(0, 500), companyId, collectionId)
  }
}

/**
 * 创建后台索引任务并立刻返回 jobId；真正的 embedding 在后台跑。
 * 没配向量模型时同步抛错，让页面直接提示，而不是留下一个永远 pending 的任务。
 */
export function startKbIndexJob(
  db: Db,
  dbPath: string,
  companyId: string,
  collectionId: string,
  options: { readonly docId?: string; readonly embed?: EmbedFn } = {},
): { jobId: string; modelId: string } {
  const collection = db
    .prepare('SELECT id, name FROM kb_collections WHERE id = ? AND company_id = ? AND deleted_at IS NULL')
    .get(collectionId, companyId) as unknown as { id: string; name: string } | undefined
  if (!collection) throw new EabError(EC.NOT_FOUND, '知识库不存在或已删除')
  const model = getCollectionEmbeddingModel(db, companyId, collectionId)
  if (!model) {
    throw new EabError(EC.VALIDATION, '还没有配置知识库向量模型', {
      hint: '先到「模型接入」添加一个 embedding 模型，并在用途路由里把它绑定到「知识库向量化」。未配置时系统继续用关键词检索。',
    })
  }

  const jobId = randomUUID()
  const now = Date.now()
  db.prepare(
    `INSERT INTO kb_index_jobs (id, company_id, collection_id, doc_id, model_id, status, total, done, failed, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', 0, 0, 0, ?, ?)`,
  ).run(jobId, companyId, collectionId, options.docId ?? null, model.id, now, now)

  void runJob(db, dbPath, jobId, companyId, collectionId, options.docId, options.embed).catch((err) => {
    // runJob 内部已处理失败；这里兜底避免未处理的 rejection 打崩进程
    updateJob(db, jobId, { status: 'failed', error: (err instanceof Error ? err.message : String(err)).slice(0, 1000) })
  })
  return { jobId, modelId: model.id }
}

export function latestKbIndexJob(
  db: Db,
  companyId: string,
  collectionId: string,
): JobRow | null {
  const row = db
    .prepare(
      `SELECT id, status, total, done, failed, error, model_id
         FROM kb_index_jobs
        WHERE company_id = ? AND collection_id = ?
        ORDER BY updated_at DESC
        LIMIT 1`,
    )
    .get(companyId, collectionId) as unknown as JobRow | undefined
  return row ?? null
}

export function collectionVectorStats(
  db: Db,
  companyId: string,
  collectionId: string,
): { chunks: number; vectors: number; dim: number | null; modelIds: string[] } {
  const chunks = db
    .prepare(
      `SELECT COUNT(*) AS count FROM kb_chunks WHERE company_id = ? AND collection_id = ?`,
    )
    .get(companyId, collectionId) as { count: number }
  const rows = db
    .prepare(
      `SELECT model_id, dim, COUNT(*) AS count FROM kb_chunk_embeddings
        WHERE company_id = ? AND collection_id = ?
        GROUP BY model_id, dim`,
    )
    .all(companyId, collectionId) as unknown as Array<{ model_id: string; dim: number; count: number }>
  return {
    chunks: Number(chunks.count),
    vectors: rows.reduce((sum, row) => sum + Number(row.count), 0),
    dim: rows[0]?.dim ?? null,
    modelIds: rows.map((row) => row.model_id),
  }
}

/**
 * 向量候选：只比较与问题同一模型的向量，避免不同 embedding 模型的维度/语义混算。
 * 权限过滤已经由调用方先裁好 collectionIds，这里只做纯相似度计算。
 */
export function searchChunkVectors(
  db: Db,
  companyId: string,
  collectionIds: readonly string[],
  modelId: string,
  queryVector: readonly number[],
  limit: number,
): KbVectorHit[] {
  if (collectionIds.length === 0 || queryVector.length === 0) return []
  const placeholders = collectionIds.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT chunk_id, doc_id, dim, vector, norm
         FROM kb_chunk_embeddings
        WHERE company_id = ? AND model_id = ? AND collection_id IN (${placeholders})
        LIMIT 20000`,
    )
    .all(companyId, modelId, ...collectionIds) as unknown as EmbeddingRow[]
  const queryNorm = l2Norm(queryVector)
  return rows
    .map((row) => {
      const vector = decodeVector(row.vector)
      const score = cosineSimilarity(queryVector, queryNorm, vector, Number(row.norm))
      return { chunkId: row.chunk_id, docId: row.doc_id, score, distance: 1 - score }
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}
