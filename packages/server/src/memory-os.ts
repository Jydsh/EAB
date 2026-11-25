/**
 * AGT-13 Memory OS：
 * - 四类长期记忆：preference / fact / decision / episode；
 * - 写入前做重复与冲突检测，冲突记忆进入“待确认”，不静默覆盖旧记忆；
 * - 召回支持词面 + 向量混合分；情景记忆按时间衰减，偏好/事实/决策不衰减。
 *
 * 这里只放可复用规则，不直接拼系统提示；路由、工具和对话链路共用同一套判断。
 */
import type { Db } from '@eab/storage'
import { callEmbeddings } from './llm.js'
import { resolveModelForPurpose } from './model-registry.js'
import { cosineSimilarity, decodeVector, encodeVector } from './kb-vector.js'

export const MEMORY_TYPES = ['preference', 'fact', 'decision', 'episode'] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]

export const MEMORY_TYPE_LABELS: Record<MemoryType, string> = {
  preference: '偏好',
  fact: '事实',
  decision: '决策',
  episode: '情景',
}

export function normalizeMemoryType(value: unknown, fallback: MemoryType = 'fact'): MemoryType {
  const text = String(value ?? '').trim().toLowerCase()
  return (MEMORY_TYPES as readonly string[]).includes(text) ? (text as MemoryType) : fallback
}

/** 明确的敏感信息不进入长期记忆；宁可漏记，不可把凭证写进画像。 */
export function memoryLooksSensitive(value: string): boolean {
  const text = String(value ?? '')
  if (!text.trim()) return true
  if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(text)) return true
  if (/(?<!\d)1[3-9]\d{9}(?!\d)/.test(text)) return true
  if (/(?<!\d)\d{17}[\dXx](?!\d)/.test(text)) return true
  if (/(?<!\d)\d{16,19}(?!\d)/.test(text)) return true
  if (/(password|passwd|secret|token|api[_ -]?key|access[_ -]?key|私钥|密钥|密码|口令|验证码|身份证号|银行卡号)/i.test(text)) {
    return true
  }
  return false
}
export function normalizeFactKey(value: unknown): string {
  const text = String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '.')
    .replace(/[^a-z0-9_.:\-\u4e00-\u9fa5]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+|\.+$/g, '')
  return text.slice(0, 80)
}

export interface MemoryRowLike {
  id: string
  content: string
  memory_type?: string | null
  confirmed: number
  conflict_with?: string | null
  created_at: number
  fact_key?: string | null
  object_text?: string | null
  valid_from?: number | null
  valid_to?: number | null
  deleted_at?: number | null
  archived_at?: number | null
  importance?: number | null
}

export type MemoryStatus = 'active' | 'pending' | 'conflict' | 'expired' | 'archived'

export function memoryStatus(
  row: Pick<MemoryRowLike, 'confirmed' | 'conflict_with'> & {
    valid_to?: number | null
    deleted_at?: number | null
    archived_at?: number | null
  },
  now = Date.now(),
): MemoryStatus {
  if ((row.deleted_at ?? 0) > 0 || (row.valid_to != null && row.valid_to <= now)) return 'expired'
  if ((row.archived_at ?? 0) > 0) return 'archived'
  if (row.confirmed === 1) return 'active'
  return row.conflict_with ? 'conflict' : 'pending'
}

function normalizeContent(input: string): string {
  return String(input || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s，。！？、；：,.;:!?（）()【】\[\]<>《》"'“”‘’]/g, '')
}

function bigrams(text: string): Set<string> {
  const clean = normalizeContent(text)
  const out = new Set<string>()
  if (clean.length <= 2) {
    if (clean) out.add(clean)
    return out
  }
  for (let index = 0; index + 2 <= clean.length; index += 1) out.add(clean.slice(index, index + 2))
  return out
}

/**
 * 字符二元组 Jaccard 相似度，再补一个“短句包含”判断。
 * 真实语义冲突仍由用户确认；这里只负责把明显相近的新旧记忆拦到待确认队列，
 * 不能让新记忆直接覆盖旧记忆。
 */
export function memoryContentSimilarity(a: string, b: string): number {
  const left = normalizeContent(a)
  const right = normalizeContent(b)
  if (!left || !right) return 0
  if (left === right) return 1
  if (left.length >= 6 && right.length >= 6 && (left.includes(right) || right.includes(left))) {
    return Math.min(left.length, right.length) / Math.max(left.length, right.length) + 0.15
  }
  const aSet = bigrams(left)
  const bSet = bigrams(right)
  if (aSet.size === 0 || bSet.size === 0) return 0
  let intersection = 0
  for (const item of aSet) if (bSet.has(item)) intersection += 1
  return intersection / (aSet.size + bSet.size - intersection)
}

export interface MemoryConflictCandidate {
  readonly id: string
  readonly content: string
  readonly memoryType: MemoryType
  readonly confirmed: number
  readonly conflict_with?: string | null
  readonly factKey?: string | null
  readonly createdAt: number
}

export interface MemoryDuplicateOrConflict {
  readonly kind: 'duplicate' | 'conflict'
  readonly memory: MemoryConflictCandidate
  readonly similarity: number
}

/**
 * 同公司、同范围、同类型内查重与查冲突：
 * - 精确重复直接返回 duplicate，不再插入第二条；
 * - 与已确认记忆高度相近返回 conflict，新记忆应落成待确认；
 * - 已确认记忆之间不做二次互删，避免一次召回把历史全改掉。
 */
export function findMemoryDuplicateOrConflict(
  db: Db,
  input: {
    companyId: string
    scopeType: string
    scopeId: string
    memoryType: MemoryType
    content: string
    excludeId?: string
    conflictThreshold?: number
    now?: number
  },
): MemoryDuplicateOrConflict | null {
  const threshold = input.conflictThreshold ?? 0.5
  const now = input.now ?? Date.now()
  const rows = db
    .prepare(
      `SELECT id, content, memory_type, confirmed, conflict_with, fact_key, created_at
         FROM memories
        WHERE company_id = ? AND scope_type = ? AND scope_id = ?
          AND deleted_at IS NULL AND memory_type = ? AND archived_at IS NULL
          AND (valid_to IS NULL OR valid_to > ?)
        ORDER BY created_at DESC LIMIT 200`,
    )
    .all(input.companyId, input.scopeType, input.scopeId, input.memoryType, now) as unknown as MemoryRowLike[]
  let best: MemoryDuplicateOrConflict | null = null
  for (const row of rows) {
    if (input.excludeId && row.id === input.excludeId) continue
    const similarity = memoryContentSimilarity(input.content, row.content)
    const memory: MemoryConflictCandidate = {
      id: row.id,
      content: row.content,
      memoryType: normalizeMemoryType(row.memory_type, input.memoryType),
      confirmed: row.confirmed,
      conflict_with: row.conflict_with ?? null,
      factKey: row.fact_key ?? null,
      createdAt: row.created_at,
    }
    if (normalizeContent(input.content) === normalizeContent(row.content)) {
      return { kind: 'duplicate', memory, similarity: 1 }
    }
    // 只有已确认的旧记忆才构成“覆盖冲突”；两条待确认记忆可以并存，交给用户逐条处理。
    if (row.confirmed !== 1) continue
    if (similarity >= threshold && (!best || similarity > best.similarity)) {
      best = { kind: 'conflict', memory, similarity }
    }
  }
  return best
}

/**
 * 结构化事实按 fact_key 查重/查冲突：
 * - 同一键、同一对象值：duplicate；
 * - 同一键、不同对象值：conflict，新事实必须等用户确认后才替换旧事实；
 * - 只看当前有效且未删除的记录，已失效历史不参与。
 */
export function findStructuredFactConflict(
  db: Db,
  input: {
    companyId: string
    scopeType: string
    scopeId: string
    factKey: string
    objectText: string
    excludeId?: string
    now?: number
  },
): MemoryDuplicateOrConflict | null {
  const now = input.now ?? Date.now()
  const factKey = input.factKey.trim()
  if (!factKey) return null
  const rows = db
    .prepare(
      `SELECT id, content, memory_type, confirmed, conflict_with, fact_key, object_text, created_at
         FROM memories
        WHERE company_id = ? AND scope_type = ? AND scope_id = ?
          AND deleted_at IS NULL AND memory_type = 'fact' AND fact_key = ?
          AND archived_at IS NULL
          AND (valid_to IS NULL OR valid_to > ?)
        ORDER BY created_at DESC LIMIT 50`,
    )
    .all(input.companyId, input.scopeType, input.scopeId, factKey, now) as unknown as Array<
      MemoryRowLike & { object_text?: string | null }
    >
  const newObject = normalizeContent(input.objectText)
  for (const row of rows) {
    if (input.excludeId && row.id === input.excludeId) continue
    const oldObject = normalizeContent(row.object_text || row.content)
    const memory: MemoryConflictCandidate = {
      id: row.id,
      content: row.content,
      memoryType: 'fact',
      confirmed: row.confirmed,
      conflict_with: row.conflict_with ?? null,
      factKey: row.fact_key ?? factKey,
      createdAt: row.created_at,
    }
    if (newObject && oldObject === newObject) return { kind: 'duplicate', memory, similarity: 1 }
    if (row.confirmed === 1) return { kind: 'conflict', memory, similarity: 1 }
  }
  return null
}

export interface MemoryEmbeddingResult {
  readonly modelId: string
  readonly queryVector: readonly number[] | null
  readonly vectors: ReadonlyMap<string, readonly number[]>
}

/**
 * 为当前问题与候选记忆批量生成向量；已有同模型向量直接复用。
 * 任何失败都返回 null，让调用方退回词面召回，不能因为向量服务挂了就不回答。
 */
export async function loadMemoryEmbeddings(
  db: Db,
  dbPath: string,
  companyId: string,
  rows: readonly MemoryRowLike[],
  query: string,
): Promise<MemoryEmbeddingResult | null> {
  const model = resolveModelForPurpose(db, companyId, 'kb.embed')
  if (!model) return null
  const modelId = model.id
  const needEmbed: MemoryRowLike[] = []
  const stored = db
    .prepare(
      `SELECT id, embedding, embedding_model FROM memories
        WHERE company_id = ? AND id IN (${rows.map(() => '?').join(',') || "''"})`,
    )
    .all(companyId, ...rows.map((row) => row.id)) as unknown as Array<{
    id: string
    embedding: Uint8Array | null
    embedding_model: string | null
  }>
  const embeddingById = new Map(stored.map((row) => [row.id, row]))
  for (const row of rows) {
    const saved = embeddingById.get(row.id)
    if (!saved?.embedding || saved.embedding_model !== modelId) needEmbed.push(row)
  }
  const texts = [query, ...needEmbed.map((row) => row.content)]
  let result
  try {
    result = await callEmbeddings(db, dbPath, companyId, modelId, texts)
  } catch {
    return null
  }
  if (result.vectors.length !== texts.length) return null
  const vectors = new Map<string, readonly number[]>()
  for (const row of rows) {
    const saved = embeddingById.get(row.id)
    if (saved?.embedding && saved.embedding_model === modelId) {
      vectors.set(row.id, decodeVector(saved.embedding))
    }
  }
  for (const [index, row] of needEmbed.entries()) {
    const vector = result.vectors[index + 1]
    if (!vector || vector.length === 0) continue
    vectors.set(row.id, vector)
    try {
      db.prepare('UPDATE memories SET embedding = ?, embedding_model = ? WHERE id = ?')
        .run(encodeVector(vector), modelId, row.id)
    } catch {
      // 向量落库失败只影响下次重算，不影响本轮召回。
    }
  }
  return { modelId, queryVector: result.vectors[0] ?? null, vectors }
}

/** 写入或确认时预生成向量；没有向量模型或调用失败时保持 NULL，不阻断主操作。 */
export async function embedMemoryRow(
  db: Db,
  dbPath: string,
  companyId: string,
  row: MemoryRowLike,
): Promise<void> {
  const model = resolveModelForPurpose(db, companyId, 'kb.embed')
  if (!model) return
  try {
    const result = await callEmbeddings(db, dbPath, companyId, model.id, [row.content])
    const vector = result.vectors[0]
    if (!vector || vector.length === 0) return
    db.prepare('UPDATE memories SET embedding = ?, embedding_model = ? WHERE id = ?')
      .run(encodeVector(vector), model.id, row.id)
  } catch {
    // 预生成失败只影响下一次召回时补算，不影响记忆本身落库。
  }
}

/** 情景记忆按 45 天半衰期衰减；偏好、事实、决策不衰减。 */
export function memoryDecayWeight(memoryType: MemoryType, createdAt: number | undefined, now = Date.now()): number {
  if (memoryType !== 'episode' || !createdAt || !Number.isFinite(createdAt)) return 1
  const ageDays = Math.max(0, (now - createdAt) / 86_400_000)
  return Math.exp(-ageDays / 45)
}

export function memoryVectorSimilarity(a: readonly number[] | null | undefined, b: readonly number[] | null | undefined): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0
  const normA = Math.sqrt(a.reduce((sum, value) => sum + value * value, 0))
  const normB = Math.sqrt(b.reduce((sum, value) => sum + value * value, 0))
  return cosineSimilarity(a, normA, b, normB)
}
