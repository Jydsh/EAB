/**
 * 知识库入库流水线：上传落盘 → 解析 → 规则清洗 → 切片 → 向量索引。
 *
 * 设计边界：
 * - 原始文件落数据目录，数据库只存相对路径和文本；
 * - 每一步都更新 kb_docs.pipeline_stage，失败可定位、可重试；
 * - 没有向量模型或外部向量库时不阻断文本入库，降级为关键词检索；
 * - 任务记录在 kb_ingest_jobs，进程重启后由 worker 重新捡起 pending/stale 任务。
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import type { Db } from '@eab/storage'
import { EC, EabError } from '@eab/domain'
import { cleanKbBlocks } from './kb-cleaner.js'
import { cleanBlocksWithModel, MODEL_CLEAN_BATCH_TIMEOUT_MS } from './kb-model-clean.js'
import { ocrImageWithModel, understandImageWithModel } from './kb-ocr.js'
import {
  clearDocAssets,
  docAssetUrl,
  storeDocImages,
  updateDocAssetUnderstanding,
} from './kb-assets.js'
import { parseKbFile, KbParseError, isImageFilename, isSupportedKbFilename } from './kb-parsers.js'
import { splitKbBlocks, type KbBlock } from './kb-splitter.js'
import {
  estimateKbPipeline,
  modelCleanTimeoutMs,
  remainingPipelineSeconds,
  type KbEstimateInput,
  type KbPipelineEstimates,
  type KbPipelineStage,
} from './kb-pipeline-estimate.js'
import { getCollectionEmbeddingModel, indexKbCollection } from './kb-vector.js'
import { resolveModelForPurpose } from './model-registry.js'

export interface KbPipelineConfig {
  readonly dbPath: string
  readonly dataDir?: string
}

export interface KbUploadInput {
  readonly filename: string
  readonly mime: string
  readonly buffer: Buffer
}

export interface KbUploadOptions {
  readonly classification?: string
  readonly cleanMode?: 'rules' | 'model' | 'auto'
  readonly cleanModelId?: string | null
  readonly ocrModelId?: string | null
  readonly autoStart?: boolean
}

export interface KbUploadResult {
  readonly docId: string
  readonly title: string
  readonly sizeBytes: number
  readonly contentHash: string
  readonly duplicate: boolean
  readonly jobId: string | null
  readonly pipelineStage: string
}

const MAX_FILE_BYTES = 50 * 1024 * 1024
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_PDF_PAGES = 300
/**
 * 单个文档的模型清洗总预算不再是固定 4 分钟：按字符数/块数估算批次波次，
 * 留 2.5 倍余量并限制在 4~20 分钟，避免几万字文档被一刀切判超时。
 */

interface DocRow {
  id: string
  company_id: string
  collection_id: string
  title: string
  original_path: string | null
  size_bytes: number
  raw_text: string | null
  clean_text: string | null
  pipeline_stage: string
  status: string
  dept_path: string | null
  classification: string
  content_hash: string | null
  version: number
  chunk_count: number
  page_count: number
  clean_mode: string | null
  clean_model_id: string | null
  ocr_model_id: string | null
}

interface CollectionRow {
  id: string
  name: string
  clean_mode: string
  clean_model_id: string | null
  ocr_model_id: string | null
  chunk_size: number
  chunk_overlap: number
  embedding_model_id: string | null
}

interface IngestJobRow {
  id: string
  company_id: string
  collection_id: string
  doc_id: string | null
  stage: string
  status: string
  attempts: number
  max_attempts: number
  locked_by: string | null
  meta_json: string | null
}

function dataRoot(config: KbPipelineConfig): string {
  return resolve(config.dataDir ?? dirname(config.dbPath))
}

function relativeOriginalPath(companyId: string, collectionId: string, docId: string, filename: string): string {
  const ext = extname(filename).toLowerCase()
  return join('knowledge', companyId, collectionId, docId, `original${ext}`)
}

function absoluteOriginalPath(config: KbPipelineConfig, originalPath: string): string {
  const root = dataRoot(config)
  const absolute = resolve(root, originalPath)
  if (!absolute.startsWith(root + '\\') && absolute !== root) {
    throw new EabError(EC.VALIDATION, '知识库文件路径越界')
  }
  return absolute
}

function safeTitle(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? '未命名文档'
  const title = base.replace(/[\u0000-\u001f]/g, '').trim()
  return title.slice(0, 180) || '未命名文档'
}

function assertMagic(input: KbUploadInput): void {
  const ext = extname(input.filename).toLowerCase()
  const buffer = input.buffer
  const has = (bytes: readonly number[]): boolean => bytes.every((value, index) => buffer[index] === value)
  const zip = buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b
  if (ext === '.pdf' && !has([0x25, 0x50, 0x44, 0x46])) {
    throw new EabError(EC.VALIDATION, '文件后缀是 PDF，但内容不是 PDF')
  }
  if (ext === '.docx' || ext === '.xlsx' || ext === '.pptx') {
    if (!zip) throw new EabError(EC.VALIDATION, '文件后缀是 Office 文档，但内容不是有效的 OOXML 压缩包')
  }
  if (ext === '.png' && !has([0x89, 0x50, 0x4e, 0x47])) {
    throw new EabError(EC.VALIDATION, 'PNG 文件内容无效')
  }
  if ((ext === '.jpg' || ext === '.jpeg') && !has([0xff, 0xd8, 0xff])) {
    throw new EabError(EC.VALIDATION, 'JPEG 文件内容无效')
  }
  if (ext === '.webp' && !(buffer.length >= 4 && buffer.subarray(0, 4).toString('ascii') === 'RIFF')) {
    throw new EabError(EC.VALIDATION, 'WebP 文件内容无效')
  }
}

function validateUpload(input: KbUploadInput): void {
  if (!input.filename || !input.filename.trim()) {
    throw new EabError(EC.VALIDATION, '上传文件缺少文件名')
  }
  if (!isSupportedKbFilename(input.filename)) {
    throw new EabError(EC.VALIDATION, '当前文件类型不在知识库支持范围内', {
      hint: '支持 pdf/docx/xlsx/pptx/txt/md/markdown/csv/json/html/htm/png/jpg/jpeg/webp；老式 .doc/.xls/.ppt 请另存为新格式',
    })
  }
  const ext = extname(input.filename).toLowerCase()
  if (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp') {
    if (input.buffer.byteLength > MAX_IMAGE_BYTES) {
      throw new EabError(EC.VALIDATION, `图片单文件不能超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB`)
    }
  } else if (input.buffer.byteLength > MAX_FILE_BYTES) {
    throw new EabError(EC.VALIDATION, `单文件不能超过 ${MAX_FILE_BYTES / 1024 / 1024}MB`)
  }
  assertMagic(input)
}

function collectionRow(db: Db, companyId: string, collectionId: string): CollectionRow {
  const row = db
    .prepare(
      `SELECT id, name, clean_mode, clean_model_id, ocr_model_id, chunk_size, chunk_overlap, embedding_model_id
         FROM kb_collections
        WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
    )
    .get(collectionId, companyId) as unknown as CollectionRow | undefined
  if (!row) throw new EabError(EC.NOT_FOUND, '知识库不存在或已删除')
  return row
}

function enqueueJob(
  db: Db,
  companyId: string,
  collectionId: string,
  docId: string,
  meta: Record<string, unknown>,
): string {
  const jobId = randomUUID()
  const now = Date.now()
  db.prepare(
    `INSERT INTO kb_ingest_jobs
       (id, company_id, collection_id, doc_id, stage, status, attempts, max_attempts, meta_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pipeline', 'pending', 0, 3, ?, ?, ?)`,
  ).run(jobId, companyId, collectionId, docId, JSON.stringify(meta), now, now)
  return jobId
}

export function createKbUploadDocument(
  db: Db,
  config: KbPipelineConfig,
  companyId: string,
  collectionId: string,
  input: KbUploadInput,
  options: KbUploadOptions = {},
): KbUploadResult {
  validateUpload(input)
  const collection = collectionRow(db, companyId, collectionId)
  const contentHash = createHash('sha256').update(input.buffer).digest('hex')
  const existing = db
    .prepare(
      `SELECT id, title, size_bytes, pipeline_stage
         FROM kb_docs
        WHERE company_id = ? AND collection_id = ? AND content_hash = ? AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(companyId, collectionId, contentHash) as unknown as
    | { id: string; title: string; size_bytes: number; pipeline_stage: string }
    | undefined
  if (existing) {
    return {
      docId: existing.id,
      title: existing.title,
      sizeBytes: Number(existing.size_bytes),
      contentHash,
      duplicate: true,
      jobId: null,
      pipelineStage: existing.pipeline_stage,
    }
  }

  const docId = randomUUID()
  const relativePath = relativeOriginalPath(companyId, collectionId, docId, input.filename)
  const absolutePath = absoluteOriginalPath(config, relativePath)
  mkdirSync(dirname(absolutePath), { recursive: true })
  const temporaryPath = `${absolutePath}.tmp-${process.pid}`
  try {
    writeFileSync(temporaryPath, input.buffer)
    // rename 不跨目录，原子替换；先写临时文件避免半截文件被 worker 读到。
    renameSync(temporaryPath, absolutePath)
  } catch (error) {
    rmSync(temporaryPath, { force: true })
    throw new EabError(EC.INTERNAL, `知识库文件落盘失败：${error instanceof Error ? error.message : String(error)}`)
  }

  const now = Date.now()
  const title = safeTitle(input.filename)
  db.prepare(
    `INSERT INTO kb_docs
       (id, company_id, collection_id, title, source_type, source_uri, mime, size_bytes, checksum,
        classification, status, chunk_count, created_at, updated_at, original_path, pipeline_stage,
        clean_mode, clean_model_id, ocr_model_id, page_count, content_hash, version)
     VALUES (?, ?, ?, ?, 'upload', ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, 'uploaded',
             ?, ?, ?, 0, ?, 1)`,
  ).run(
    docId,
    companyId,
    collectionId,
    title,
    relativePath,
    input.mime || 'application/octet-stream',
    input.buffer.byteLength,
    contentHash,
    options.classification?.trim() || 'internal',
    now,
    now,
    relativePath,
    options.cleanMode ?? collection.clean_mode ?? 'rules',
    options.cleanModelId ?? collection.clean_model_id ?? null,
    options.ocrModelId ?? collection.ocr_model_id ?? null,
    contentHash,
  )

  const jobId = enqueueJob(db, companyId, collectionId, docId, {
    fromStage: 'parse',
    requestedCleanMode: options.cleanMode ?? collection.clean_mode ?? 'rules',
    originalFilename: input.filename,
  })
  if (options.autoStart === false) {
    db.prepare('UPDATE kb_ingest_jobs SET status = ? WHERE id = ?').run('paused', jobId)
  }
  return {
    docId,
    title,
    sizeBytes: input.buffer.byteLength,
    contentHash,
    duplicate: false,
    jobId,
    pipelineStage: 'uploaded',
  }
}

function docRow(db: Db, companyId: string, docId: string): DocRow {
  const row = db
    .prepare(
      `SELECT id, company_id, collection_id, title, original_path, raw_text, clean_text,
              pipeline_stage, status, dept_path, classification, content_hash, version,
              chunk_count, clean_mode, clean_model_id, ocr_model_id, size_bytes, page_count
         FROM kb_docs
        WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
    )
    .get(docId, companyId) as unknown as DocRow | undefined
  if (!row) throw new EabError(EC.NOT_FOUND, '文档不存在或已删除')
  return row
}

function stageRank(stage: string): number {
  return {
    parse: 0,
    clean: 1,
    chunk: 2,
    index: 3,
  }[stage] ?? 0
}

function setStage(
  db: Db,
  companyId: string,
  docId: string,
  stage: string,
  patch: { error?: string | null; status?: string; clearError?: boolean } = {},
): void {
  const now = Date.now()
  db.prepare(
    `UPDATE kb_docs
        SET pipeline_stage = ?, pipeline_error = ?, status = COALESCE(?, status), updated_at = ?,
            pipeline_progress = 0, pipeline_stage_started_at = ?
      WHERE id = ? AND company_id = ?`,
  ).run(
    stage,
    patch.clearError ? null : (patch.error ?? null),
    patch.status ?? null,
    now,
    now,
    docId,
    companyId,
  )
}

/** 当前步骤内的完成比例（0~1），只用于四步浮层进度条。 */
function setDocProgress(db: Db, companyId: string, docId: string, progress: number): void {
  const value = Math.max(0, Math.min(1, progress))
  db.prepare(
    `UPDATE kb_docs SET pipeline_progress = ?
      WHERE id = ? AND company_id = ?`,
  ).run(value, docId, companyId)
}

/** 记录每一步的实际耗时；重跑某一步时只覆盖该步，不丢其它步骤的历史耗时。 */
function recordStageTiming(db: Db, companyId: string, docId: string, stage: string, elapsedMs: number): void {
  const row = db
    .prepare('SELECT pipeline_timings_json FROM kb_docs WHERE id = ? AND company_id = ?')
    .get(docId, companyId) as { pipeline_timings_json: string | null } | undefined
  let timings: Record<string, number> = {}
  try {
    const parsed = row?.pipeline_timings_json ? (JSON.parse(row.pipeline_timings_json) as unknown) : null
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      timings = parsed as Record<string, number>
    }
  } catch {
    // 历史 JSON 损坏时从空记录重新写。
  }
  timings[stage] = Math.max(0, Math.round(elapsedMs))
  db.prepare(
    `UPDATE kb_docs SET pipeline_timings_json = ? WHERE id = ? AND company_id = ?`,
  ).run(JSON.stringify(timings), docId, companyId)
}

function hasEmbeddingModelForCollection(db: Db, companyId: string, collectionId: string): boolean {
  try {
    return Boolean(getCollectionEmbeddingModel(db, companyId, collectionId))
  } catch {
    return false
  }
}

function estimateInputForDoc(
  db: Db,
  companyId: string,
  doc: DocRow,
  collection: CollectionRow,
  overrides: { blockCount?: number; chunkCount?: number } = {},
): KbEstimateInput {
  const imageStats = db
    .prepare('SELECT COUNT(*) AS count FROM kb_doc_assets WHERE company_id = ? AND doc_id = ?')
    .get(companyId, doc.id) as { count: number } | undefined
  let blockCount = overrides.blockCount ?? 0
  if (!blockCount && doc.raw_text) {
    blockCount = Math.max(1, Math.ceil(doc.raw_text.length / 160))
  }
  return {
    rawChars: doc.raw_text?.length ?? 0,
    sizeBytes: Number(doc.size_bytes) || 0,
    pageCount: Number(doc.page_count) || 0,
    imageCount: Number(imageStats?.count ?? 0),
    blockCount,
    chunkCount: overrides.chunkCount ?? (Number(doc.chunk_count) || 0),
    chunkSize: Number(collection.chunk_size) || 500,
    cleanMode: doc.clean_mode ?? collection.clean_mode,
    hasEmbeddingModel: hasEmbeddingModelForCollection(db, companyId, collection.id),
  }
}

function textBlock(text: string, type: KbBlock['type'] = 'paragraph'): KbBlock {
  return { id: randomUUID(), text, type, headingPath: [] }
}

function readOriginal(config: KbPipelineConfig, doc: DocRow): Buffer {
  if (!doc.original_path) {
    throw new EabError(EC.VALIDATION, '文档没有原始文件，不能重跑解析；请重新上传')
  }
  const path = absoluteOriginalPath(config, doc.original_path)
  if (!existsSync(path)) {
    throw new EabError(EC.NOT_FOUND, '原始文件已丢失，不能重跑解析；请重新上传', { details: { path } })
  }
  const buffer = readFileSync(path)
  if (buffer.byteLength > MAX_FILE_BYTES) {
    throw new EabError(EC.VALIDATION, `原始文件超过 ${MAX_FILE_BYTES / 1024 / 1024}MB，拒绝解析`)
  }
  return buffer
}

/** 结构块旁路存盘：DB 只存文本，blocks.json 保留表格/标题/页码，供清洗与重切片复用。 */
function blocksFilePath(config: KbPipelineConfig, doc: DocRow): string | null {
  if (!doc.original_path) return null
  return join(dirname(absoluteOriginalPath(config, doc.original_path)), 'blocks.json')
}

function writeBlocks(config: KbPipelineConfig, doc: DocRow, blocks: readonly KbBlock[]): void {
  const path = blocksFilePath(config, doc)
  if (!path) return
  try {
    writeFileSync(path, JSON.stringify(blocks))
  } catch {
    // 旁路文件失败不阻断主流程；没有它时清洗/切片会退化为纯文本。
  }
}

function readBlocks(config: KbPipelineConfig, doc: DocRow): KbBlock[] | null {
  const path = blocksFilePath(config, doc)
  if (!path || !existsSync(path)) return null
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!Array.isArray(value)) return null
    return value.filter((item): item is KbBlock =>
      Boolean(item && typeof item === 'object' && typeof (item as KbBlock).text === 'string'),
    )
  } catch {
    return null
  }
}

interface PipelineOptions {
  readonly fromStage?: 'parse' | 'clean' | 'chunk' | 'index'
  readonly cleanMode?: 'rules' | 'model' | 'auto'
  /** 导入时选择的清洗方式；清洗失败回退后仍用它恢复“重跑清洗”的原始意图。 */
  readonly requestedCleanMode?: 'rules' | 'model' | 'auto'
  readonly cleanModelId?: string | null
  readonly ocrModelId?: string | null
  readonly jobId?: string
  readonly touch?: () => void
}

function touchJob(db: Db, jobId: string | undefined): void {
  if (!jobId) return
  db.prepare('UPDATE kb_ingest_jobs SET heartbeat_at = ?, updated_at = ? WHERE id = ?').run(
    Date.now(),
    Date.now(),
    jobId,
  )
}

/** 把任务当前步骤写回 job.stage，失败时前端能定位是解析、清洗、切片还是索引出错。 */
function markJobStage(db: Db, jobId: string | undefined, stage: 'parse' | 'clean' | 'chunk' | 'index'): void {
  if (!jobId) return
  db.prepare('UPDATE kb_ingest_jobs SET stage = ?, heartbeat_at = ?, updated_at = ? WHERE id = ?').run(
    stage,
    Date.now(),
    Date.now(),
    jobId,
  )
}

function describeModelCleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/aborted due to timeout|timed?\s*out|timeout/i.test(message)) {
    return `模型 ${Math.round(MODEL_CLEAN_BATCH_TIMEOUT_MS / 1000)} 秒内未返回，已判定超时`
  }
  return message
}

/**
 * 文档级超时只放弃“等待模型结果”本身，不改写已解析文本或图片资产。
 * 被放弃的模型请求自身仍受单次请求超时约束，不会写入数据库。
 */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new EabError(EC.UPSTREAM, message)), timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function blocksText(blocks: readonly KbBlock[]): string {
  return blocks.map((item) => item.text.trim()).filter(Boolean).join('\n\n')
}

function parsedImageBlockText(caption: string, text: string, filename: string): string {
  const title = caption.trim() || filename
  const body = text.trim()
  return body ? `[图片] ${title}\n${body}` : `[图片] ${title}`
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = []
  let cursor = 0
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index]!, index)
    }
  })
  await Promise.all(runners)
  return results
}

function writeChunks(
  db: Db,
  doc: DocRow,
  collection: CollectionRow,
  chunks: ReturnType<typeof splitKbBlocks>,
): void {
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM kb_chunks WHERE company_id = ? AND doc_id = ?').run(doc.company_id, doc.id)
    const insert = db.prepare(
      `INSERT INTO kb_chunks
         (id, company_id, doc_id, collection_id, ordinal, text, token_count, dept_path, classification,
          created_at, heading, page_no, meta_json, char_count, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const now = Date.now()
    chunks.forEach((chunk, ordinal) => {
      insert.run(
        randomUUID(),
        doc.company_id,
        doc.id,
        collection.id,
        ordinal,
        chunk.text,
        chunk.tokenCount,
        doc.dept_path,
        doc.classification,
        now,
        chunk.heading,
        chunk.pageNo,
        JSON.stringify(chunk.meta),
        chunk.charCount,
        chunk.contentHash,
      )
    })
    db.prepare(
      `UPDATE kb_docs
          SET chunk_count = ?, status = 'pending', pipeline_stage = 'chunked', pipeline_error = NULL,
              updated_at = ?, version = version + 1
        WHERE id = ? AND company_id = ?`,
    ).run(chunks.length, now, doc.id, doc.company_id)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

const MAX_MANUAL_TEXT_CHARS = 5_000_000

/**
 * 人工修正解析/清洗产物。
 * 手动修改上游文本后，下游切片与向量必须失效，避免旧索引继续召回过期内容。
 */
export function saveManualPipelineText(
  db: Db,
  config: KbPipelineConfig,
  companyId: string,
  docId: string,
  stage: 'parse' | 'clean',
  value: string,
): { docId: string; stage: string; chars: number; version: number } {
  const doc = docRow(db, companyId, docId)
  const text = String(value ?? '')
  const chars = text.length
  if (!text.trim()) throw new EabError(EC.VALIDATION, '文本不能为空')
  if (chars > MAX_MANUAL_TEXT_CHARS) {
    throw new EabError(EC.VALIDATION, `手动编辑文本不能超过 ${MAX_MANUAL_TEXT_CHARS.toLocaleString()} 字符`)
  }
  const nextStage = stage === 'parse' ? 'parsed' : 'cleaned'
  const now = Date.now()
  // 手动文本会替换正文，但图片块必须保留：否则编辑一次就会丢掉图片资产与切片回链。
  const previousBlocks = readBlocks(config, doc) ?? []
  const imageBlocks = previousBlocks.filter((item) => item.type === 'image')
  let textOnly = text
  for (const image of imageBlocks) {
    if (image.text && textOnly.includes(image.text)) {
      textOnly = textOnly.replace(image.text, '')
    }
  }
  const rebuilt = [
    ...(textOnly.trim() ? [textBlock(textOnly.trim())] : []),
    ...imageBlocks,
  ]
  writeBlocks(config, doc, rebuilt.length ? rebuilt : [textBlock(text)])
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM kb_chunks WHERE company_id = ? AND doc_id = ?').run(companyId, docId)
    db.prepare('DELETE FROM kb_chunk_embeddings WHERE company_id = ? AND doc_id = ?').run(companyId, docId)
    if (stage === 'parse') {
      db.prepare(
        `UPDATE kb_docs
            SET raw_text = ?, clean_text = NULL, clean_mode = 'auto', clean_model_id = NULL,
                chunk_count = 0, status = 'pending', pipeline_stage = 'parsed', pipeline_error = NULL,
                updated_at = ?, version = version + 1
          WHERE id = ? AND company_id = ?`,
      ).run(text, now, docId, companyId)
    } else {
      db.prepare(
        `UPDATE kb_docs
            SET clean_text = ?, clean_mode = 'manual', clean_model_id = NULL,
                chunk_count = 0, status = 'pending', pipeline_stage = 'cleaned', pipeline_error = NULL,
                updated_at = ?, version = version + 1
          WHERE id = ? AND company_id = ?`,
      ).run(text, now, docId, companyId)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  const row = db
    .prepare('SELECT version FROM kb_docs WHERE id = ? AND company_id = ?')
    .get(docId, companyId) as { version: number } | undefined
  return { docId, stage: nextStage, chars, version: Number(row?.version) || doc.version + 1 }
}

/** 人工修正单个切片；后续只需重建索引，不重新切片。 */
export function updateManualKbChunk(
  db: Db,
  companyId: string,
  docId: string,
  ordinal: number,
  value: string,
): { docId: string; ordinal: number; chars: number; version: number } {
  const doc = docRow(db, companyId, docId)
  const text = String(value ?? '')
  if (!Number.isInteger(ordinal) || ordinal < 0) throw new EabError(EC.VALIDATION, '切片序号不合法')
  if (!text.trim()) throw new EabError(EC.VALIDATION, '切片文本不能为空')
  if (text.length > MAX_MANUAL_TEXT_CHARS) {
    throw new EabError(EC.VALIDATION, `切片文本不能超过 ${MAX_MANUAL_TEXT_CHARS.toLocaleString()} 字符`)
  }
  const chunk = db
    .prepare(
      `SELECT id FROM kb_chunks
        WHERE company_id = ? AND doc_id = ? AND ordinal = ?`,
    )
    .get(companyId, docId, ordinal) as { id: string } | undefined
  if (!chunk) throw new EabError(EC.NOT_FOUND, '切片不存在或已被重新生成')
  const now = Date.now()
  const tokenCount = Math.ceil(text.length / 2)
  const contentHash = createHash('sha256').update(text).digest('hex')
  db.exec('BEGIN')
  try {
    db.prepare(
      `UPDATE kb_chunks
          SET text = ?, token_count = ?, char_count = ?, content_hash = ?
        WHERE id = ? AND company_id = ?`,
    ).run(text, tokenCount, text.length, contentHash, chunk.id, companyId)
    // 切片正文已变，旧的同文档向量立即失效；下一步重建索引会补齐。
    db.prepare('DELETE FROM kb_chunk_embeddings WHERE company_id = ? AND doc_id = ?').run(companyId, docId)
    db.prepare(
      `UPDATE kb_docs
          SET status = 'pending', pipeline_stage = 'chunked', pipeline_error = NULL,
              updated_at = ?, version = version + 1
        WHERE id = ? AND company_id = ?`,
    ).run(now, docId, companyId)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  const row = db
    .prepare('SELECT version FROM kb_docs WHERE id = ? AND company_id = ?')
    .get(docId, companyId) as { version: number } | undefined
  return { docId, ordinal, chars: text.length, version: Number(row?.version) || doc.version + 1 }
}

async function indexDocument(
  db: Db,
  config: KbPipelineConfig,
  doc: DocRow,
  options: PipelineOptions,
): Promise<{ ok: boolean; error: string | null }> {
  markJobStage(db, options.jobId, 'index')
  setStage(db, doc.company_id, doc.id, 'indexing', { status: 'indexing', clearError: true })
  touchJob(db, options.jobId)
  const model = getCollectionEmbeddingModel(db, doc.company_id, doc.collection_id)
  if (!model) {
    const error = '尚未配置知识库向量模型，当前文档仅支持关键词检索'
    db.prepare(
      `UPDATE kb_docs SET status = 'indexed', index_error = ?, pipeline_stage = 'indexed', updated_at = ?
        WHERE id = ? AND company_id = ?`,
    ).run(error, Date.now(), doc.id, doc.company_id)
    return { ok: false, error }
  }
  try {
    await indexKbCollection(db, config.dbPath, doc.company_id, doc.collection_id, {
      docId: doc.id,
    })
    db.prepare(
      `UPDATE kb_docs SET status = 'indexed', index_error = NULL, pipeline_stage = 'indexed', updated_at = ?
        WHERE id = ? AND company_id = ?`,
    ).run(Date.now(), doc.id, doc.company_id)
    return { ok: true, error: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // 向量失败不阻断文本检索：文档仍然 indexed，只是 index_error 有值。
    db.prepare(
      `UPDATE kb_docs SET status = 'indexed', index_error = ?, pipeline_stage = 'indexed', updated_at = ?
        WHERE id = ? AND company_id = ?`,
    ).run(message.slice(0, 1000), Date.now(), doc.id, doc.company_id)
    return { ok: false, error: message }
  }
}

/**
 * 处理单篇文档；worker 和单元测试都走这里。
 * 抛出的错误会由 runIngestJob 写入 job/doc；OCR 缺组件会转成 needs_config。
 */
export async function processKbDocument(
  db: Db,
  config: KbPipelineConfig,
  companyId: string,
  docId: string,
  options: PipelineOptions = {},
): Promise<{ ok: boolean; stage: string; warning: string | null }> {
  const doc = docRow(db, companyId, docId)
  const collection = collectionRow(db, companyId, doc.collection_id)
  let startRank = stageRank(options.fromStage ?? 'parse')
  let warning: string | null = null
  let workBlocks: KbBlock[] | null = null

  try {
    // 从“清洗/切片”重跑但上游文本缺失时，自动回退到解析，避免用空文本覆盖已有数据。
    if (startRank >= 1 && !doc.raw_text) {
      startRank = 0
    }
    if (startRank <= 0) {
      const parseStartedAt = Date.now()
      markJobStage(db, options.jobId, 'parse')
      setStage(db, companyId, doc.id, 'parsing', { status: 'indexing', clearError: true })
      touchJob(db, options.jobId)
      const buffer = readOriginal(config, doc)
      const filename = doc.original_path ? basename(doc.original_path) : doc.title
      const explicitOcrModelId =
        options.ocrModelId ?? (doc.ocr_model_id as string | null) ?? (collection.ocr_model_id as string | null)
      const ocrRoute = explicitOcrModelId ? null : resolveModelForPurpose(db, companyId, 'kb.ocr')
      const ocrModelId = explicitOcrModelId || ocrRoute?.id || null
      let parsed
      if (isImageFilename(filename)) {
        if (!ocrModelId) {
          throw new KbParseError('OCR_REQUIRED', `图片 ${filename} 需要 OCR 模型；请在知识库/模型接入中配置 kb.ocr 后重跑`)
        }
        const understanding = await understandImageWithModel(
          db,
          config.dbPath,
          companyId,
          ocrModelId,
          buffer,
          filename,
        )
        const caption = understanding.caption || filename
        const text = parsedImageBlockText(caption, understanding.text, filename)
        parsed = {
          blocks: [
            {
              id: randomUUID(),
              text,
              type: 'image' as const,
              headingPath: [],
              meta: {
                imageRef: 'img_standalone',
                imageCaption: caption,
                imageSource: 'standalone',
              },
            },
          ],
          text,
          meta: { parser: 'image', filename, modelId: ocrModelId },
          pageCount: 1,
          images: [
            {
              ref: 'img_standalone',
              buffer,
              filename,
              mime: '',
              caption,
              kind: 'standalone' as const,
              ocrText: understanding.text,
            },
          ],
        }
      } else {
        parsed = await parseKbFile({
          buffer,
          filename,
          mime: '',
          // 扫描 PDF 的空页也交给同一个 OCR 模型，避免只支持图片而卡住扫描件。
          ocrPage: ocrModelId
            ? async (png, name) => {
                const pageOcr = await ocrImageWithModel(db, config.dbPath, companyId, ocrModelId, png, name)
                return pageOcr.text
              }
            : undefined,
        })
      }
      if (parsed.pageCount > MAX_PDF_PAGES) {
        throw new EabError(EC.VALIDATION, `PDF 页数 ${parsed.pageCount} 超过上限 ${MAX_PDF_PAGES}`)
      }

      const imageWarnings: string[] = []
      const extractedImages = parsed.images ?? []
      let enrichedBlocks = parsed.blocks
      let storedAssetCount = 0
      if (extractedImages.length > 0) {
        clearDocAssets(db, config, companyId, doc.id, doc.original_path)
        const stored = storeDocImages(db, config, doc, extractedImages)
        imageWarnings.push(...stored.warnings)
        storedAssetCount = stored.assets.length
        const understandingByRef = new Map<string, { caption: string; text: string; assetId: string }>()
        for (const image of extractedImages) {
          const assetId = stored.refToAssetId.get(image.ref)
          if (!assetId) continue
          if (image.ocrText || image.caption) {
            understandingByRef.set(image.ref, {
              caption: image.caption ?? '',
              text: image.ocrText ?? '',
              assetId,
            })
          }
        }
        const pending = extractedImages.filter((image) => Boolean(stored.refToAssetId.get(image.ref)) && !image.ocrText)
        if (pending.length > 0) {
          if (!ocrModelId) {
            imageWarnings.push(`已提取 ${pending.length} 张图片，但未配置 kb.ocr，图片只有文件名/替代文本，未生成 OCR 与图片说明`)
          } else {
            await mapLimit(pending, 3, async (image) => {
              touchJob(db, options.jobId)
              try {
                const understanding = await understandImageWithModel(
                  db,
                  config.dbPath,
                  companyId,
                  ocrModelId,
                  image.buffer,
                  image.filename,
                )
                const assetId = stored.refToAssetId.get(image.ref)!
                updateDocAssetUnderstanding(db, companyId, assetId, {
                  caption: understanding.caption,
                  ocrText: understanding.text,
                  modelId: ocrModelId,
                })
                understandingByRef.set(image.ref, {
                  caption: understanding.caption || image.caption || '',
                  text: understanding.text,
                  assetId,
                })
              } catch (error) {
                imageWarnings.push(
                  `图片 ${image.filename} 理解失败：${(error instanceof Error ? error.message : String(error)).slice(0, 120)}`,
                )
                understandingByRef.set(image.ref, {
                  caption: image.caption ?? '',
                  text: image.ocrText ?? '',
                  assetId: stored.refToAssetId.get(image.ref)!,
                })
              }
            })
          }
        }
        enrichedBlocks = parsed.blocks.map((item) => {
          const ref = typeof item.meta?.imageRef === 'string' ? item.meta.imageRef : ''
          if (!ref) return item
          const assetId = stored.refToAssetId.get(ref)
          if (!assetId) return item
          const understanding = understandingByRef.get(ref)
          const caption = understanding?.caption || String(item.meta?.imageCaption ?? '')
          const sourceFilename = basename(String(item.meta?.imagePart ?? filename))
          return {
            ...item,
            text: parsedImageBlockText(caption, understanding?.text ?? '', sourceFilename),
            meta: {
              ...item.meta,
              imageAssetId: assetId,
              imageCaption: caption,
              imageUrl: docAssetUrl(doc.id, assetId),
            },
          }
        })
        if (imageWarnings.length > 0) {
          const next = `图片处理：${imageWarnings.slice(0, 3).join('；')}${imageWarnings.length > 3 ? `；另有 ${imageWarnings.length - 3} 项` : ''}`
          warning = warning ? `${warning}；${next}` : next
        }
      }

      const rawText = blocksText(enrichedBlocks)
      const parseMeta = {
        ...parsed.meta,
        images: storedAssetCount,
        imageWarnings,
        blocks: enrichedBlocks.length,
        chars: rawText.length,
      }
      db.prepare(
        `UPDATE kb_docs SET raw_text = ?, parse_meta_json = ?, page_count = ?, pipeline_stage = 'parsed',
             pipeline_error = NULL, updated_at = ? WHERE id = ? AND company_id = ?`,
      ).run(
        rawText,
        JSON.stringify(parseMeta),
        parsed.pageCount,
        Date.now(),
        doc.id,
        companyId,
      )
      doc.raw_text = rawText
      workBlocks = enrichedBlocks
      writeBlocks(config, doc, enrichedBlocks)
      setStage(db, companyId, doc.id, 'parsed', { clearError: true })
      recordStageTiming(db, companyId, doc.id, 'parse', Date.now() - parseStartedAt)
    }

    if (startRank <= 1) {
      const cleanStartedAt = Date.now()
      markJobStage(db, options.jobId, 'clean')
      setStage(db, companyId, doc.id, 'cleaning', { clearError: true })
      touchJob(db, options.jobId)
      const requested =
        options.cleanMode ??
        options.requestedCleanMode ??
        (doc.clean_mode as PipelineOptions['cleanMode']) ??
        collection.clean_mode
      const sourceBlocks = workBlocks ?? readBlocks(config, doc) ?? (doc.raw_text ? [textBlock(doc.raw_text)] : [])
      let cleaned = cleanKbBlocks(sourceBlocks)
      let mode: 'rules' | 'model' = 'rules'
      let usedModelId: string | null = null
      if (requested === 'model' || requested === 'auto') {
        const explicitModelId =
          options.cleanModelId ?? (doc.clean_model_id as string | null) ?? (collection.clean_model_id as string | null)
        const route = explicitModelId ? null : resolveModelForPurpose(db, companyId, 'kb.clean')
        const modelId = explicitModelId || route?.id || null
        if (modelId) {
          try {
            const estimateInput = estimateInputForDoc(db, companyId, doc, collection, {
              blockCount: sourceBlocks.length,
            })
            const timeoutMs = modelCleanTimeoutMs(estimateInput)
            const abortController = new AbortController()
            const abortTimer = setTimeout(() => abortController.abort(), timeoutMs)
            let modelCleaned
            try {
              modelCleaned = await withTimeout(
                cleanBlocksWithModel(
                  db,
                  config.dbPath,
                  companyId,
                  modelId,
                  sourceBlocks,
                  {
                    signal: abortController.signal,
                    onProgress: (progress) => {
                      setDocProgress(
                        db,
                        companyId,
                        doc.id,
                        progress.totalBatches > 0 ? progress.completedBatches / progress.totalBatches : 0,
                      )
                      touchJob(db, options.jobId)
                    },
                  },
                ),
                timeoutMs,
                `模型清洗超过 ${Math.max(1, Math.round(timeoutMs / 60_000))} 分钟仍未完成，已回退规则清洗`,
              )
            } finally {
              clearTimeout(abortTimer)
            }
            const normalized = cleanKbBlocks(modelCleaned.blocks)
            cleaned = normalized
            usedModelId = modelCleaned.modelId
            mode = 'model'
            if (modelCleaned.keptOriginalCount > 0) {
              warning = `模型清洗有 ${modelCleaned.keptOriginalCount} 个块未返回，已保留规则清洗结果`
            }
          } catch (modelError) {
            const message = describeModelCleanError(modelError)
            warning = `模型清洗失败，已回退规则清洗：${message.slice(0, 240)}`
          }
        } else if (requested === 'model') {
          warning = '没有配置 kb.clean 模型，已回退规则清洗；可在模型接入页绑定后重跑'
        }
      }
      const cleanText = cleaned.text
      workBlocks = cleaned.blocks
      db.prepare(
        `UPDATE kb_docs SET clean_text = ?, clean_mode = ?, clean_model_id = ?, pipeline_stage = 'cleaned',
             pipeline_error = NULL, updated_at = ? WHERE id = ? AND company_id = ?`,
      ).run(cleanText, mode, usedModelId, Date.now(), doc.id, companyId)
      doc.clean_text = cleanText
      writeBlocks(config, doc, cleaned.blocks)
      setStage(db, companyId, doc.id, 'cleaned', { clearError: true })
      recordStageTiming(db, companyId, doc.id, 'clean', Date.now() - cleanStartedAt)
    }

    if (startRank <= 2) {
      const chunkStartedAt = Date.now()
      markJobStage(db, options.jobId, 'chunk')
      setStage(db, companyId, doc.id, 'chunking', { clearError: true })
      touchJob(db, options.jobId)
      const source = doc.clean_text ?? doc.raw_text
      if (!source) throw new EabError(EC.VALIDATION, '文档没有清洗后的文本，不能切片')
      const blocks = workBlocks ?? readBlocks(config, doc) ?? [textBlock(source)]
      const chunks = splitKbBlocks(blocks, {
        maxTokens: Number(collection.chunk_size) || 500,
        overlapTokens: Number(collection.chunk_overlap) || 80,
      })
      if (chunks.length === 0) throw new EabError(EC.VALIDATION, '清洗后没有可切片的文本')
      writeChunks(db, doc, collection, chunks)
      doc.clean_text = source
      doc.chunk_count = chunks.length
      recordStageTiming(db, companyId, doc.id, 'chunk', Date.now() - chunkStartedAt)
    } else if (Number(doc.chunk_count) <= 0) {
      throw new EabError(EC.VALIDATION, '文档还没有切片，不能只重建索引；请从切片步骤重试')
    }

    const indexStartedAt = Date.now()
    const indexResult = await indexDocument(db, config, doc, options)
    recordStageTiming(db, companyId, doc.id, 'index', Date.now() - indexStartedAt)
    if (!indexResult.ok) warning = indexResult.error
    return { ok: true, stage: 'indexed', warning }
  } catch (error) {
    const code = error instanceof KbParseError ? error.code : ''
    const message = error instanceof Error ? error.message : String(error)
    if (code === 'OCR_REQUIRED' || code === 'LEGACY_OFFICE') {
      db.prepare(
        `UPDATE kb_docs SET status = 'failed', pipeline_stage = 'needs_config', pipeline_error = ?, updated_at = ?
          WHERE id = ? AND company_id = ?`,
      ).run(message.slice(0, 1000), Date.now(), doc.id, companyId)
      return { ok: false, stage: 'needs_config', warning: message }
    }
    db.prepare(
      `UPDATE kb_docs SET status = 'failed', pipeline_stage = 'failed', pipeline_error = ?, updated_at = ?
        WHERE id = ? AND company_id = ?`,
    ).run(message.slice(0, 1000), Date.now(), doc.id, companyId)
    throw error
  }
}

function updateJob(
  db: Db,
  jobId: string,
  patch: { status: string; error?: string | null; lockedBy?: string | null },
): void {
  db.prepare(
    `UPDATE kb_ingest_jobs
        SET status = ?, error = ?, locked_by = ?, updated_at = ?
      WHERE id = ?`,
  ).run(patch.status, patch.error ?? null, patch.lockedBy ?? null, Date.now(), jobId)
}

async function runIngestJob(
  db: Db,
  config: KbPipelineConfig,
  job: IngestJobRow,
): Promise<void> {
  if (!job.doc_id) {
    updateJob(db, job.id, { status: 'failed', error: '入库任务缺少 doc_id' })
    return
  }
  let meta: PipelineOptions = {}
  try {
    meta = job.meta_json ? (JSON.parse(job.meta_json) as PipelineOptions) : {}
  } catch {
    meta = {}
  }
  try {
    const result = await processKbDocument(db, config, job.company_id, job.doc_id, {
      ...meta,
      fromStage: (meta.fromStage ?? 'parse') as PipelineOptions['fromStage'],
      jobId: job.id,
    })
    if (result.ok) {
      updateJob(db, job.id, { status: 'done', error: result.warning ?? null })
    } else {
      updateJob(db, job.id, { status: result.stage === 'needs_config' ? 'needs_config' : 'failed', error: result.warning })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    updateJob(db, job.id, { status: 'failed', error: message.slice(0, 1000) })
    db.prepare(
      `UPDATE kb_docs SET status = 'failed', pipeline_stage = 'failed', pipeline_error = ?, updated_at = ?
        WHERE id = ? AND company_id = ?`,
    ).run(message.slice(0, 1000), Date.now(), job.doc_id, job.company_id)
  }
}

let workerStarted = false
let workerRunning = false

/** 进程中途退出会留下“文档处理中 + 任务已失败”的组合，启动时补一次失败状态。 */
function reconcileFailedDocuments(db: Db): void {
  const rows = db
    .prepare(
      `SELECT d.id, d.company_id, j.error
         FROM kb_docs d
         JOIN kb_ingest_jobs j ON j.id = (
           SELECT id FROM kb_ingest_jobs
            WHERE doc_id = d.id AND company_id = d.company_id
            ORDER BY created_at DESC LIMIT 1
         )
        WHERE d.status IN ('parsing', 'cleaning', 'chunking', 'indexing')
          AND j.status IN ('failed', 'needs_config')
          AND NOT EXISTS (
            SELECT 1 FROM kb_ingest_jobs a
             WHERE a.doc_id = d.id AND a.company_id = d.company_id
               AND a.status IN ('pending', 'running')
          )`,
    )
    .all() as Array<{ id: string; company_id: string; error: string | null }>
  if (rows.length === 0) return
  const now = Date.now()
  const update = db.prepare(
    `UPDATE kb_docs
        SET status = 'failed', pipeline_stage = 'failed', pipeline_error = ?, updated_at = ?
      WHERE id = ? AND company_id = ?`,
  )
  for (const row of rows) {
    update.run((row.error ?? '上次入库任务未完成').slice(0, 1000), now, row.id, row.company_id)
  }
}

async function tick(db: Db, config: KbPipelineConfig): Promise<void> {
  if (workerRunning) return
  workerRunning = true
  try {
    const now = Date.now()
    const stale = now - 10 * 60 * 1000
    const job = db
      .prepare(
        `SELECT id, company_id, collection_id, doc_id, stage, status, attempts, max_attempts, locked_by, meta_json
           FROM kb_ingest_jobs
          WHERE status = 'pending'
             OR (status = 'running' AND COALESCE(heartbeat_at, updated_at) < ?)
          ORDER BY created_at ASC
          LIMIT 1`,
      )
      .get(stale) as unknown as IngestJobRow | undefined
    if (!job) return
    if (Number(job.attempts) >= Number(job.max_attempts)) {
      const reason = `重试次数超过 ${job.max_attempts}`
      updateJob(db, job.id, { status: 'failed', error: reason })
      // 过期任务被判定失败后，文档必须一起落到 failed；否则界面会一直显示“清洗中”，
      // 用户既看不到失败原因，也无法判断能否重跑。只更新仍在处理中的文档，避免覆盖后来的成功结果。
      if (job.doc_id) {
        db.prepare(
          `UPDATE kb_docs
              SET status = 'failed', pipeline_stage = 'failed', pipeline_error = ?, updated_at = ?
            WHERE id = ? AND company_id = ?
              AND status IN ('pending', 'parsing', 'cleaning', 'chunking', 'indexing')`,
        ).run(reason, now, job.doc_id, job.company_id)
      }
      return
    }
    const lock = `${process.pid}:${randomUUID().slice(0, 8)}`
    const claim = db.prepare(
      `UPDATE kb_ingest_jobs
          SET status = 'running', attempts = attempts + 1, locked_at = ?, heartbeat_at = ?, locked_by = ?, updated_at = ?
        WHERE id = ? AND (status = 'pending' OR (status = 'running' AND COALESCE(heartbeat_at, updated_at) < ?))`,
    ).run(lock, now, lock, now, job.id, stale)
    if (Number(claim.changes ?? 0) === 0) return
    await runIngestJob(db, config, { ...job, status: 'running', attempts: Number(job.attempts) + 1 })
  } finally {
    workerRunning = false
  }
}

export function kickKbPipelineWorker(db: Db, config: KbPipelineConfig): void {
  void tick(db, config).catch(() => {
    // worker 内部已记录 job 失败；这里只防止未处理的 rejection。
  })
}

export function startKbPipelineWorker(db: Db, config: KbPipelineConfig): void {
  if (workerStarted) return
  workerStarted = true
  reconcileFailedDocuments(db)
  const timer = setInterval(() => kickKbPipelineWorker(db, config), 1500)
  timer.unref?.()
}

export function enqueueDocumentPipeline(
  db: Db,
  companyId: string,
  collectionId: string,
  docId: string,
  fromStage: 'parse' | 'clean' | 'chunk' | 'index',
): string {
  const active = db
    .prepare(
      `SELECT id, status FROM kb_ingest_jobs
        WHERE company_id = ? AND doc_id = ? AND status IN ('pending', 'running')
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(companyId, docId) as unknown as { id: string; status: string } | undefined
  if (active) {
    throw new EabError(EC.CONFLICT, '该文档已有入库任务在执行，请等待完成后再重试', {
      details: { jobId: active.id, status: active.status },
    })
  }
  // 清洗失败回退后，文档的 clean_mode 会被写成 rules。重跑清洗时必须沿用
  // 首次导入时选择的清洗方式，否则“重跑清洗”会静默变成规则清洗。
  const previous = db
    .prepare(
      `SELECT meta_json FROM kb_ingest_jobs
        WHERE company_id = ? AND doc_id = ? AND meta_json LIKE '%requestedCleanMode%'
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(companyId, docId) as unknown as { meta_json: string | null } | undefined
  let requestedCleanMode: 'rules' | 'model' | 'auto' | undefined
  try {
    const parsed = previous?.meta_json ? (JSON.parse(previous.meta_json) as { requestedCleanMode?: string }) : null
    if (parsed?.requestedCleanMode === 'rules' || parsed?.requestedCleanMode === 'model' || parsed?.requestedCleanMode === 'auto') {
      requestedCleanMode = parsed.requestedCleanMode
    }
  } catch {
    // 历史任务元数据损坏时按文档/知识库当前配置执行。
  }
  const meta: Record<string, unknown> = { fromStage }
  if (requestedCleanMode) meta.requestedCleanMode = requestedCleanMode
  const jobId = enqueueJob(db, companyId, collectionId, docId, meta)
  db.prepare(
    `UPDATE kb_docs SET status = 'pending', pipeline_stage = 'uploaded', pipeline_error = NULL,
         pipeline_progress = 0, pipeline_stage_started_at = ?, updated_at = ?
      WHERE id = ? AND company_id = ?`,
  ).run(Date.now(), Date.now(), docId, companyId)
  return jobId
}

export interface KbPipelineStatus {
  docId: string
  title: string
  status: string
  pipelineStage: string
  pipelineError: string | null
  /** 流程已完成但存在可降级问题时记录，例如模型清洗部分回退。 */
  pipelineWarning: string | null
  cleanMode: string | null
  cleanModelId: string | null
  cleanModelName: string | null
  pageCount: number
  chunkCount: number
  rawChars: number
  cleanChars: number
  embeddingCount: number
  embeddingModels: number
  imageCount: number
  imageTextCount: number
  indexError: string | null
  version: number
  originalPath: string | null
  updatedAt: number
  /** 每一步的预计秒数；完成后仍保留，用于“预计耗时”说明。 */
  estimates: KbPipelineEstimates
  /** 每一步最近一次实际耗时（秒）。重跑只覆盖该步。 */
  timings: Partial<Record<KbPipelineStage, number>>
  /** 当前步骤完成比例 0~1。 */
  progress: number
  stageStartedAt: number | null
  activeStage: KbPipelineStage | null
  remainingSeconds: number | null
  lastJob: {
    id: string
    stage: string
    status: string
    attempts: number
    error: string | null
    updatedAt: number
  } | null
}

export function readKbPipelineStatus(db: Db, companyId: string, docId: string): KbPipelineStatus {
  const doc = db
    .prepare(
      `SELECT d.id, d.title, d.status, d.pipeline_stage, d.pipeline_error, d.clean_mode, d.clean_model_id,
              d.page_count, d.chunk_count, d.version, d.original_path, d.index_error, d.updated_at,
              d.size_bytes, d.parse_meta_json, d.pipeline_progress, d.pipeline_stage_started_at,
              d.pipeline_timings_json, d.collection_id,
              length(d.raw_text) AS raw_chars, length(d.clean_text) AS clean_chars,
              c.chunk_size AS collection_chunk_size, c.clean_mode AS collection_clean_mode,
              c.embedding_model_id AS collection_embedding_model_id
         FROM kb_docs d
         LEFT JOIN kb_collections c
           ON c.id = d.collection_id AND c.company_id = d.company_id AND c.deleted_at IS NULL
        WHERE d.id = ? AND d.company_id = ? AND d.deleted_at IS NULL`,
    )
    .get(docId, companyId) as unknown as
    | {
        id: string
        title: string
        status: string
        pipeline_stage: string
        pipeline_error: string | null
        clean_mode: string | null
        clean_model_id: string | null
        page_count: number
        chunk_count: number
        version: number
        original_path: string | null
        index_error: string | null
        updated_at: number
        size_bytes: number | null
        collection_id: string
        raw_chars: number | null
        clean_chars: number | null
        parse_meta_json: string | null
        pipeline_progress: number | null
        pipeline_stage_started_at: number | null
        pipeline_timings_json: string | null
        collection_chunk_size: number | null
        collection_clean_mode: string | null
        collection_embedding_model_id: string | null
      }
    | undefined
  if (!doc) throw new EabError(EC.NOT_FOUND, '文档不存在或已删除')
  const job = db
    .prepare(
      `SELECT id, stage, status, attempts, error, updated_at
         FROM kb_ingest_jobs WHERE company_id = ? AND doc_id = ? ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(companyId, docId) as unknown as
    | { id: string; stage: string; status: string; attempts: number; error: string | null; updated_at: number }
    | undefined
  const cleanModel = doc.clean_model_id
    ? (db.prepare('SELECT name FROM models WHERE id = ? AND company_id = ?').get(doc.clean_model_id, companyId) as
        | { name: string }
        | undefined)
    : undefined
  const embeddings = db
    .prepare(
      `SELECT COUNT(*) AS count, COUNT(DISTINCT model_id) AS models
         FROM kb_chunk_embeddings WHERE company_id = ? AND doc_id = ?`,
    )
    .get(companyId, doc.id) as { count: number; models: number } | undefined
  const imageStats = db
    .prepare(
      `SELECT COUNT(*) AS count,
              SUM(CASE WHEN COALESCE(ocr_text, '') <> '' OR COALESCE(caption, '') <> '' THEN 1 ELSE 0 END) AS text_count
         FROM kb_doc_assets WHERE company_id = ? AND doc_id = ?`,
    )
    .get(companyId, doc.id) as { count: number; text_count: number | null } | undefined
  const rawChars = Number(doc.raw_chars ?? 0)
  const cleanChars = Number(doc.clean_chars ?? 0)
  let blockCount = 0
  try {
    const parsedMeta = doc.parse_meta_json ? (JSON.parse(doc.parse_meta_json) as { blocks?: unknown }) : null
    blockCount = Number(parsedMeta?.blocks ?? 0) || 0
  } catch {
    // 旧文档没有块数时按字符数估算。
  }
  const progress = Number(doc.pipeline_progress ?? 0)
  const stageStartedAt = doc.pipeline_stage_started_at ? Number(doc.pipeline_stage_started_at) : null
  const estimateInput: KbEstimateInput = {
    rawChars,
    sizeBytes: Number(doc.size_bytes ?? 0),
    pageCount: Number(doc.page_count ?? 0),
    imageCount: Number(imageStats?.count ?? 0),
    blockCount,
    chunkCount: Number(doc.chunk_count ?? 0),
    chunkSize: Number(doc.collection_chunk_size ?? 500),
    cleanMode: doc.clean_mode ?? doc.collection_clean_mode,
    hasEmbeddingModel:
      Boolean(doc.collection_embedding_model_id) ||
      hasEmbeddingModelForCollection(db, companyId, doc.collection_id),
  }
  const estimates = estimateKbPipeline(estimateInput)
  const { activeStage, remaining } = remainingPipelineSeconds(
    estimates,
    doc.pipeline_stage,
    progress,
    stageStartedAt,
    Date.now(),
  )
  let timings: Partial<Record<KbPipelineStage, number>> = {}
  try {
    const parsed = doc.pipeline_timings_json
      ? (JSON.parse(doc.pipeline_timings_json) as Record<string, unknown>)
      : {}
    for (const stage of ['parse', 'clean', 'chunk', 'index'] as const) {
      const value = Number(parsed[stage])
      if (Number.isFinite(value) && value >= 0) timings[stage] = Math.round(value / 100) / 10
    }
  } catch {
    timings = {}
  }
  return {
    docId: doc.id,
    title: doc.title,
    status: doc.status,
    pipelineStage: doc.pipeline_stage,
    pipelineError: doc.pipeline_error,
    pipelineWarning: job && job.status === 'done' ? job.error : null,
    cleanMode: doc.clean_mode,
    cleanModelId: doc.clean_model_id,
    cleanModelName: cleanModel?.name ?? null,
    pageCount: Number(doc.page_count),
    chunkCount: Number(doc.chunk_count),
    rawChars,
    cleanChars,
    embeddingCount: Number(embeddings?.count ?? 0),
    embeddingModels: Number(embeddings?.models ?? 0),
    imageCount: Number(imageStats?.count ?? 0),
    imageTextCount: Number(imageStats?.text_count ?? 0),
    indexError: doc.index_error,
    version: Number(doc.version),
    originalPath: doc.original_path,
    updatedAt: Number(doc.updated_at),
    estimates,
    timings,
    progress: Math.max(0, Math.min(1, progress)),
    stageStartedAt,
    activeStage,
    remainingSeconds: remaining,
    lastJob: job
      ? {
          id: job.id,
          stage: job.stage,
          status: job.status,
          attempts: Number(job.attempts),
          error: job.error,
          updatedAt: Number(job.updated_at),
        }
      : null,
  }
}
