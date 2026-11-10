/**
 * 外部知识库适配器。
 *
 * 边界：
 * 1. 外部库仍然是 EAB 的 kb_collections 一行，因此沿用库级 ACL；
 * 2. 密钥只存 secrets.json 的引用名，不落 SQLite；
 * 3. Dify / 通用 HTTP 走在线检索，Obsidian 走本地 vault 导入（导入后由本地 chunk 检索）；
 * 4. 检索失败不阻断本地知识库，调用方拿到空结果继续。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, join, relative } from 'node:path'
import { EC, EabError, SC, resolveVisibleCollections } from '@eab/domain'
import { loadKbCollectionAcls } from '@eab/storage'
import type { Db } from '@eab/storage'
import { resolveSecret } from './secrets.js'
import type { RequestActor } from './session.js'

export type KbSourceKind = 'local' | 'dify' | 'obsidian' | 'generic'

export const KB_SOURCE_LABEL: Record<KbSourceKind, string> = {
  local: '本地知识库',
  dify: 'Dify 知识库',
  obsidian: 'Obsidian 库',
  generic: '通用 HTTP 知识库',
}

export interface ExternalCollectionRow {
  id: string
  name: string
  source_kind: string
  source_config: string | null
  source_secret_ref: string | null
}

export interface ExternalKbHit {
  collectionName: string
  docTitle: string
  text: string
  source: string
}

function parseConfig(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

function normalizeBaseUrl(raw: unknown): string {
  const value = str(raw)
  if (!/^https?:\/\//i.test(value)) throw new EabError(EC.VALIDATION, '知识库地址必须是 http(s) URL')
  return value.replace(/\/+$/, '')
}

async function requestJson(url: string, init: RequestInit, timeoutMs = 8000): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}${text ? `：${text.slice(0, 180)}` : ''}`)
    }
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new Error('上游返回的不是 JSON')
    }
  } finally {
    clearTimeout(timer)
  }
}

function pickPath(value: unknown, path: string): unknown {
  if (!path) return value
  return path.split('.').reduce<unknown>((current, key) => {
    if (current && typeof current === 'object' && !Array.isArray(current)) {
      return (current as Record<string, unknown>)[key]
    }
    return undefined
  }, value)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function makeHeaders(config: Record<string, unknown>, secret: string): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const extra = config.headers && typeof config.headers === 'object' && !Array.isArray(config.headers)
    ? (config.headers as Record<string, unknown>)
    : {}
  for (const [key, value] of Object.entries(extra)) {
    if (typeof value === 'string' && key) headers[key] = value
  }
  if (secret && !headers.authorization) headers.authorization = `Bearer ${secret}`
  return headers
}

async function retrieveDify(
  dbPath: string,
  collection: ExternalCollectionRow,
  query: string,
  limit: number,
): Promise<ExternalKbHit[]> {
  const config = parseConfig(collection.source_config)
  const baseUrl = normalizeBaseUrl(config.baseUrl)
  const datasetId = str(config.datasetId)
  if (!datasetId) throw new EabError(EC.VALIDATION, 'Dify 知识库缺少 datasetId')
  const secret = resolveSecret(dbPath, collection.source_secret_ref)
  if (!secret) throw new EabError(EC.VALIDATION, 'Dify 知识库还没有配置 API Key')

  const payload = await requestJson(`${baseUrl}/datasets/${encodeURIComponent(datasetId)}/retrieve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
    body: JSON.stringify({
      query,
      retrieval_model: {
        search_method: 'semantic_search',
        reranking_enable: false,
        reranking_model: { reranking_provider_name: '', reranking_model_name: '' },
        top_k: limit,
        score_threshold_enabled: false,
      },
      top_k: limit,
    }),
  })

  const records = asRecord(payload).records
  if (!Array.isArray(records)) return []
  return records.slice(0, limit).map((item) => {
    const record = asRecord(item)
    const segment = asRecord(record.segment)
    const document = asRecord(segment.document)
    return {
      collectionName: collection.name,
      docTitle: str(document.name, 'Dify 文档'),
      text: str(segment.content).slice(0, 420),
      source: 'dify',
    }
  }).filter((hit) => hit.text.length > 0)
}

async function retrieveGeneric(
  dbPath: string,
  collection: ExternalCollectionRow,
  query: string,
  limit: number,
): Promise<ExternalKbHit[]> {
  const config = parseConfig(collection.source_config)
  const endpoint = normalizeBaseUrl(config.endpoint)
  const secret = resolveSecret(dbPath, collection.source_secret_ref)
  const queryField = str(config.queryField, 'query')
  const topKField = str(config.topKField, 'top_k')
  const resultsPath = str(config.resultsPath, 'results')
  const titleField = str(config.titleField, 'title')
  const textField = str(config.textField, 'text')

  const payload = await requestJson(endpoint, {
    method: str(config.method, 'POST').toUpperCase(),
    headers: makeHeaders(config, secret),
    body: JSON.stringify({ [queryField]: query, [topKField]: limit }),
  })
  const raw = pickPath(payload, resultsPath)
  const list = Array.isArray(raw) ? raw : Array.isArray(asRecord(payload).data) ? asRecord(payload).data : []
  return (list as unknown[]).slice(0, limit).map((item) => {
    if (typeof item === 'string') {
      return { collectionName: collection.name, docTitle: collection.name, text: item.slice(0, 420), source: 'generic' }
    }
    const record = asRecord(item)
    const text = str(record[textField]) || str(asRecord(record.segment).content) || str(record.content)
    const title = str(record[titleField]) || str(asRecord(record.document).name) || collection.name
    return { collectionName: collection.name, docTitle: title, text: text.slice(0, 420), source: 'generic' }
  }).filter((hit) => hit.text.length > 0)
}

/** 在线检索：只查当前身份可见、且来源是 Dify / 通用 HTTP 的库；失败逐库吞掉。 */
export async function retrieveExternalKb(
  db: Db,
  dbPath: string,
  actor: RequestActor,
  query: string,
  limit = 4,
): Promise<ExternalKbHit[]> {
  if (!actor.subject.scopes.has(SC.KB_READ)) return []
  const acls = loadKbCollectionAcls(db, actor.subject.companyId)
  const visible = resolveVisibleCollections(actor.subject, acls)
  if (visible.size === 0) return []

  const rows = db
    .prepare(
      `SELECT id, name, source_kind, source_config, source_secret_ref
         FROM kb_collections
        WHERE company_id = ? AND deleted_at IS NULL AND status = 'active'
          AND source_kind IN ('dify', 'generic')`,
    )
    .all(actor.subject.companyId) as unknown as ExternalCollectionRow[]

  const hits: ExternalKbHit[] = []
  for (const row of rows) {
    if (!visible.has(row.id)) continue
    try {
      const next =
        row.source_kind === 'dify'
          ? await retrieveDify(dbPath, row, query, limit)
          : await retrieveGeneric(dbPath, row, query, limit)
      hits.push(...next)
    } catch {
      // 外部库单个失败不应该让本地检索整条链路失败
    }
    if (hits.length >= limit) break
  }
  return hits.slice(0, limit)
}

/** 控制台「测试连接」：只验证连通性和凭证，不写入任何数据。 */
export async function probeExternalCollection(
  dbPath: string,
  collection: ExternalCollectionRow,
): Promise<{ ok: boolean; message: string; docs?: number }> {
  try {
    if (collection.source_kind === 'dify') {
      const hits = await retrieveDify(dbPath, collection, '测试连接', 1)
      return { ok: true, message: `连接成功，返回 ${hits.length} 条测试结果` }
    }
    if (collection.source_kind === 'generic') {
      const hits = await retrieveGeneric(dbPath, collection, '测试连接', 1)
      return { ok: true, message: `连接成功，返回 ${hits.length} 条测试结果` }
    }
    if (collection.source_kind === 'obsidian') {
      const config = parseConfig(collection.source_config)
      const vaultPath = str(config.vaultPath)
      if (!vaultPath || !existsSync(vaultPath) || !statSync(vaultPath).isDirectory()) {
        return { ok: false, message: 'Vault 目录不存在或不可读' }
      }
      const files = collectMarkdown(vaultPath)
      return { ok: true, message: `目录可读，发现 ${files.length} 个 Markdown 文件`, docs: files.length }
    }
    return { ok: true, message: '本地知识库不需要测试连接' }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** Dify 文档列表，只读展示；失败返回空数组，不阻断页面。 */
export async function listExternalDocs(
  dbPath: string,
  collection: ExternalCollectionRow,
): Promise<Array<{ id: string; title: string; status: string; chunkCount: number; sourceUri: string }>> {
  if (collection.source_kind !== 'dify') return []
  const config = parseConfig(collection.source_config)
  const baseUrl = normalizeBaseUrl(config.baseUrl)
  const datasetId = str(config.datasetId)
  const secret = resolveSecret(dbPath, collection.source_secret_ref)
  if (!datasetId || !secret) return []
  try {
    const payload = await requestJson(`${baseUrl}/datasets/${encodeURIComponent(datasetId)}/documents?page=1&limit=100`, {
      method: 'GET',
      headers: { authorization: `Bearer ${secret}` },
    })
    const list = asRecord(payload).data
    if (!Array.isArray(list)) return []
    return list.map((item) => {
      const record = asRecord(item)
      return {
        id: str(record.id),
        title: str(record.name, '未命名文档'),
        status: str(record.indexing_status, 'unknown'),
        chunkCount: Number(record.word_count ?? 0),
        sourceUri: 'dify',
      }
    })
  } catch {
    return []
  }
}

function chunkText(content: string): string[] {
  const rawChunks = content
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
  const chunks: string[] = []
  for (const part of rawChunks.length ? rawChunks : [content]) {
    if (part.length <= 800) chunks.push(part)
    else for (let i = 0; i < part.length; i += 800) chunks.push(part.slice(i, i + 800))
  }
  return chunks
}

function collectMarkdown(root: string, out: string[] = []): string[] {
  if (out.length >= 2000) return out
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      collectMarkdown(full, out)
      continue
    }
    if (entry.isFile() && ['.md', '.markdown', '.txt'].includes(extname(entry.name).toLowerCase())) {
      out.push(full)
      if (out.length >= 2000) return out
    }
  }
  return out
}

/** Obsidian vault 导入：把 Markdown 写成 kb_docs/kb_chunks，之后编辑、检索都走本地管线。 */
export async function syncObsidianCollection(
  db: Db,
  companyId: string,
  collection: ExternalCollectionRow,
): Promise<{ files: number; created: number; updated: number; skipped: number; bytes: number }> {
  const config = parseConfig(collection.source_config)
  const vaultPath = str(config.vaultPath)
  if (!vaultPath || !existsSync(vaultPath) || !statSync(vaultPath).isDirectory()) {
    throw new EabError(EC.VALIDATION, 'Obsidian Vault 目录不存在或不可读')
  }
  const classification = str(config.classification, 'internal')
  if (!['public', 'internal', 'confidential'].includes(classification)) {
    throw new EabError(EC.VALIDATION, 'Obsidian 密级只能是 public / internal / confidential')
  }
  const files = collectMarkdown(vaultPath)
  const now = Date.now()
  let created = 0
  let updated = 0
  let skipped = 0
  let bytes = 0

  const selectDoc = db.prepare(
    'SELECT id, checksum FROM kb_docs WHERE id = ? AND company_id = ? AND collection_id = ? AND deleted_at IS NULL',
  )
  const deleteChunks = db.prepare('DELETE FROM kb_chunks WHERE doc_id = ?')
  const insertChunk = db.prepare(
    `INSERT INTO kb_chunks (id, company_id, doc_id, collection_id, ordinal, text, token_count, classification, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  db.exec('BEGIN')
  try {
    for (const file of files) {
      const size = statSync(file).size
      if (size > 2 * 1024 * 1024) {
        skipped += 1
        continue
      }
      if (bytes + size > 20 * 1024 * 1024) {
        skipped += 1
        continue
      }
      const content = readFileSync(file, 'utf8')
      const checksum = createHash('sha256').update(content).digest('hex')
      const rel = relative(vaultPath, file).replace(/\\/g, '/')
      const docId = `doc_obs_${createHash('sha1').update(`${companyId}:${collection.id}:${rel}`).digest('hex').slice(0, 24)}`
      const title = basename(file, extname(file))
      const chunks = chunkText(content)
      const existing = selectDoc.get(docId, companyId, collection.id) as { id: string; checksum: string | null } | undefined
      if (existing?.checksum === checksum) {
        skipped += 1
        continue
      }
      if (existing) {
        db.prepare(
          `UPDATE kb_docs
              SET title = ?, source_type = 'obsidian', source_uri = ?, mime = 'text/markdown',
                  size_bytes = ?, classification = ?, status = 'indexed', chunk_count = ?,
                  content = ?, checksum = ?, updated_at = ?
            WHERE id = ?`,
        ).run(title, rel, size, classification, chunks.length, content, checksum, now, docId)
        updated += 1
      } else {
        db.prepare(
          `INSERT INTO kb_docs
             (id, company_id, collection_id, title, source_type, source_uri, mime, size_bytes,
              checksum, classification, status, chunk_count, content, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'obsidian', ?, 'text/markdown', ?, ?, ?, 'indexed', ?, ?, ?, ?)`,
        ).run(docId, companyId, collection.id, title, rel, size, checksum, classification, chunks.length, content, now, now)
        created += 1
      }
      deleteChunks.run(docId)
      chunks.forEach((text, ordinal) => {
        insertChunk.run(`chunk_${createHash('sha1').update(`${docId}:${ordinal}`).digest('hex').slice(0, 24)}`, companyId, docId, collection.id, ordinal, text, Math.ceil(text.length / 2), classification, now)
      })
      bytes += size
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return { files: files.length, created, updated, skipped, bytes }
}
