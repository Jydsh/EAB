/**
 * 知识库图片资产：落盘、入库、读取。
 *
 * 设计边界：
 * - 图片文件只落在文档自己的目录下（assets/），数据库保存相对路径，避免任意路径读取；
 * - 同一文档内按 sha256 去重，重复引用（同一张图出现在多页/多段）复用同一个资产；
 * - 资产说明与 OCR 文本单独保存，切片通过 chunk.meta.imageAssetId 回链；
 * - 读取接口必须由调用方先完成身份/知识库可见性校验。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import type { Db } from '@eab/storage'
import { EC, EabError } from '@eab/domain'

export interface KbAssetConfig {
  readonly dbPath: string
  readonly dataDir?: string
}

export interface KbImageAssetInput {
  readonly ref: string
  readonly buffer: Buffer
  readonly filename: string
  readonly mime?: string
  readonly pageNo?: number
  readonly caption?: string
  readonly kind?: 'document_image' | 'page_render' | 'standalone'
  readonly width?: number
  readonly height?: number
  /** 扫描页已经 OCR 过的文本；有值时流水线不再重复识别。 */
  readonly ocrText?: string
  readonly modelId?: string
}

export interface KbDocAssetRow {
  id: string
  company_id: string
  collection_id: string
  doc_id: string
  kind: string
  source_name: string | null
  relative_path: string
  mime: string
  size_bytes: number
  width: number | null
  height: number | null
  page_no: number | null
  ordinal: number
  caption: string | null
  ocr_text: string | null
  model_id: string | null
  content_hash: string | null
  created_at: number
  updated_at: number
}

export interface KbAssetSummary {
  id: string
  kind: string
  filename: string
  mime: string
  sizeBytes: number
  width: number | null
  height: number | null
  pageNo: number | null
  ordinal: number
  caption: string
  ocrText: string
  createdAt: number
}

export interface StoreDocImagesResult {
  readonly assets: KbAssetSummary[]
  readonly refToAssetId: Map<string, string>
  readonly warnings: string[]
  readonly createdCount: number
}

const ASSET_EXT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
}
const ALLOWED_MIME = new Set(Object.values(ASSET_EXT_MIME))
const MAX_SINGLE_IMAGE_BYTES = 12 * 1024 * 1024
const MAX_TOTAL_IMAGE_BYTES = 48 * 1024 * 1024

function dataRoot(config: KbAssetConfig): string {
  return resolve(config.dataDir ?? dirname(config.dbPath))
}

function ensureInside(root: string, absolute: string): void {
  if (!absolute.startsWith(root + '\\') && !absolute.startsWith(root + '/') && absolute !== root) {
    throw new EabError(EC.VALIDATION, '知识库图片路径越界')
  }
}

function mimeOf(filename: string, fallback?: string): string {
  const ext = extname(filename).toLowerCase()
  if (ASSET_EXT_MIME[ext]) return ASSET_EXT_MIME[ext]!
  if (fallback && ALLOWED_MIME.has(fallback)) return fallback
  return 'image/png'
}

function extOfMime(mime: string): string {
  const found = Object.entries(ASSET_EXT_MIME).find(([, value]) => value === mime)
  return found?.[0] ?? '.png'
}

function safeName(filename: string): string {
  return (filename.split(/[/\\]/).pop() ?? 'image').replace(/[^\w.\-()\u4e00-\u9fa5]/g, '_').slice(0, 120)
}

function docAssetsDir(config: KbAssetConfig, originalPath: string | null, docId: string): string {
  if (!originalPath) {
    throw new EabError(EC.VALIDATION, `文档 ${docId} 没有原始文件路径，无法保存图片资产`)
  }
  const root = dataRoot(config)
  const original = resolve(root, originalPath)
  ensureInside(root, original)
  return join(dirname(original), 'assets')
}

/** 清空一篇文档的图片资产（解析重跑时调用；只删除本目录，不碰原文）。 */
export function clearDocAssets(
  db: Db,
  config: KbAssetConfig,
  companyId: string,
  docId: string,
  originalPath: string | null,
): void {
  db.prepare('DELETE FROM kb_doc_assets WHERE company_id = ? AND doc_id = ?').run(companyId, docId)
  if (!originalPath) return
  try {
    const dir = docAssetsDir(config, originalPath, docId)
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // 图片目录清理失败不阻断解析；新资产仍会写入。
  }
}

/**
 * 保存解析阶段抽出的图片。找不到/损坏的图片只记 warning，不影响正文入库。
 */
export function storeDocImages(
  db: Db,
  config: KbAssetConfig,
  doc: { id: string; company_id: string; collection_id: string; original_path: string | null; title: string },
  images: readonly KbImageAssetInput[],
): StoreDocImagesResult {
  const warnings: string[] = []
  const refToAssetId = new Map<string, string>()
  const assets: KbAssetSummary[] = []
  if (images.length === 0) return { assets, refToAssetId, warnings, createdCount: 0 }

  const dir = docAssetsDir(config, doc.original_path, doc.id)
  mkdirSync(dir, { recursive: true })
  const existingByHash = new Map<string, KbDocAssetRow>()
  const existingRows = listDocAssets(db, doc.company_id, doc.id)
  for (const row of existingRows) {
    if (row.content_hash) existingByHash.set(row.content_hash, row)
  }

  let totalBytes = 0
  let ordinal = existingRows.reduce((max, row) => Math.max(max, Number(row.ordinal) + 1), 0)
  const now = Date.now()
  const insert = db.prepare(
    `INSERT INTO kb_doc_assets
       (id, company_id, collection_id, doc_id, kind, source_name, relative_path, mime, size_bytes,
        width, height, page_no, ordinal, caption, ocr_text, model_id, content_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  for (const image of images) {
    if (!image.buffer || image.buffer.length < 32) {
      warnings.push(`图片 ${image.filename} 内容为空，已跳过`)
      continue
    }
    if (image.buffer.length > MAX_SINGLE_IMAGE_BYTES) {
      warnings.push(`图片 ${image.filename} 超过 12MB，已跳过`)
      continue
    }
    if (totalBytes + image.buffer.length > MAX_TOTAL_IMAGE_BYTES) {
      warnings.push('本批图片总量超过 48MB，后续图片已跳过')
      break
    }
    const mime = mimeOf(image.filename, image.mime)
    const ext = extname(image.filename).toLowerCase() || extOfMime(mime)
    const hash = createHash('sha256').update(image.buffer).digest('hex')
    const existing = existingByHash.get(hash)
    if (existing) {
      refToAssetId.set(image.ref, existing.id)
      assets.push(summaryOf(existing))
      continue
    }
    const id = `kba_${randomId()}`
    const relativePath = join(dirname(doc.original_path ?? ''), 'assets', `${id}${ext}`).replace(/\\/g, '/')
    const absolute = resolve(dataRoot(config), relativePath)
    try {
      ensureInside(dataRoot(config), absolute)
      writeFileSync(absolute, image.buffer)
    } catch (error) {
      warnings.push(`图片 ${image.filename} 落盘失败：${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    try {
      insert.run(
        id,
        doc.company_id,
        doc.collection_id,
        doc.id,
        image.kind ?? 'document_image',
        safeName(image.filename),
        relativePath,
        mime,
        image.buffer.length,
        image.width ?? null,
        image.height ?? null,
        image.pageNo ?? null,
        ordinal,
        image.caption ?? null,
        image.ocrText ?? null,
        image.modelId ?? null,
        hash,
        now,
        now,
      )
    } catch (error) {
      try {
        rmSync(absolute, { force: true })
      } catch {
        // 回滚文件失败不掩盖原始数据库错误。
      }
      warnings.push(`图片 ${image.filename} 入库失败：${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    totalBytes += image.buffer.length
    ordinal += 1
    refToAssetId.set(image.ref, id)
    const row: KbDocAssetRow = {
      id,
      company_id: doc.company_id,
      collection_id: doc.collection_id,
      doc_id: doc.id,
      kind: image.kind ?? 'document_image',
      source_name: safeName(image.filename),
      relative_path: relativePath,
      mime,
      size_bytes: image.buffer.length,
      width: image.width ?? null,
      height: image.height ?? null,
      page_no: image.pageNo ?? null,
      ordinal: ordinal - 1,
      caption: image.caption ?? null,
      ocr_text: image.ocrText ?? null,
      model_id: image.modelId ?? null,
      content_hash: hash,
      created_at: now,
      updated_at: now,
    }
    existingByHash.set(hash, row)
    assets.push(summaryOf(row))
  }
  return { assets, refToAssetId, warnings, createdCount: assets.length - existingRows.length }
}

function randomId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

function summaryOf(row: KbDocAssetRow): KbAssetSummary {
  return {
    id: row.id,
    kind: row.kind,
    filename: row.source_name ?? `${row.id}${extOfMime(row.mime)}`,
    mime: row.mime,
    sizeBytes: Number(row.size_bytes),
    width: row.width === null ? null : Number(row.width),
    height: row.height === null ? null : Number(row.height),
    pageNo: row.page_no === null ? null : Number(row.page_no),
    ordinal: Number(row.ordinal),
    caption: row.caption ?? '',
    ocrText: row.ocr_text ?? '',
    createdAt: Number(row.created_at),
  }
}

export function listDocAssets(db: Db, companyId: string, docId: string): KbDocAssetRow[] {
  return db
    .prepare(
      `SELECT id, company_id, collection_id, doc_id, kind, source_name, relative_path, mime, size_bytes,
              width, height, page_no, ordinal, caption, ocr_text, model_id, content_hash, created_at, updated_at
         FROM kb_doc_assets WHERE company_id = ? AND doc_id = ? ORDER BY ordinal ASC, created_at ASC`,
    )
    .all(companyId, docId) as unknown as KbDocAssetRow[]
}

export function listDocAssetSummaries(db: Db, companyId: string, docId: string): KbAssetSummary[] {
  return listDocAssets(db, companyId, docId).map(summaryOf)
}

export function updateDocAssetUnderstanding(
  db: Db,
  companyId: string,
  assetId: string,
  patch: { caption?: string | null; ocrText?: string | null; modelId?: string | null },
): void {
  db.prepare(
    `UPDATE kb_doc_assets
        SET caption = COALESCE(?, caption),
            ocr_text = COALESCE(?, ocr_text),
            model_id = COALESCE(?, model_id),
            updated_at = ?
      WHERE id = ? AND company_id = ?`,
  ).run(
    patch.caption === undefined ? null : patch.caption,
    patch.ocrText === undefined ? null : patch.ocrText,
    patch.modelId === undefined ? null : patch.modelId,
    Date.now(),
    assetId,
    companyId,
  )
}

export function getDocAsset(
  db: Db,
  config: KbAssetConfig,
  companyId: string,
  docId: string,
  assetId: string,
): { row: KbDocAssetRow; buffer: Buffer } {
  const row = db
    .prepare(
      `SELECT id, company_id, collection_id, doc_id, kind, source_name, relative_path, mime, size_bytes,
              width, height, page_no, ordinal, caption, ocr_text, model_id, content_hash, created_at, updated_at
         FROM kb_doc_assets WHERE company_id = ? AND doc_id = ? AND id = ?`,
    )
    .get(companyId, docId, assetId) as unknown as KbDocAssetRow | undefined
  if (!row) throw new EabError(EC.NOT_FOUND, '图片资产不存在')
  const root = dataRoot(config)
  const absolute = resolve(root, row.relative_path)
  ensureInside(root, absolute)
  if (!existsSync(absolute)) throw new EabError(EC.NOT_FOUND, '图片文件已丢失')
  const stat = statSync(absolute)
  if (!stat.isFile() || stat.size > MAX_SINGLE_IMAGE_BYTES) {
    throw new EabError(EC.VALIDATION, '图片文件不可读取或超过大小上限')
  }
  return { row, buffer: readFileSync(absolute) }
}

/** 员工对话侧读取图片的规范地址；切片只保存 assetId，不保存 URL。 */
export function docAssetUrl(docId: string, assetId: string): string {
  return `/api/kb/assets/${encodeURIComponent(docId)}/${encodeURIComponent(assetId)}`
}
