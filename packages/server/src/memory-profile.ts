/**
 * 结构化记忆画像：把已确认的 fact 行按 fact_key 去重后拼成一张小卡片。
 *
 * 画像卡只放稳定事实，不替代情景记忆召回。同一 fact_key 同时出现在 user / dept /
 * company 三个范围时，按“个人 > 部门 > 公司”取最近生效的一条；已经 valid_to 失效的
 * 旧事实不进入画像。
 */
import type { Db } from '@eab/storage'

export interface MemoryProfileFact {
  readonly id: string
  readonly scopeType: string
  readonly scopeId: string
  readonly factKey: string
  readonly subject: string
  readonly predicate: string
  readonly objectText: string
  readonly content: string
  readonly confidence: number
  readonly importance: number
  readonly createdAt: number
}

export interface MemoryProfileResult {
  readonly facts: readonly MemoryProfileFact[]
  readonly text: string
  readonly total: number
}

interface MemoryProfileRow {
  id: string
  scope_type: string
  scope_id: string
  fact_key: string | null
  subject: string | null
  predicate: string | null
  object_text: string | null
  content: string
  confidence: number | null
  importance: number | null
  created_at: number
  valid_to: number | null
  sensitivity: string | null
}

const SCOPE_PRIORITY: Record<string, number> = { user: 3, dept: 2, company: 1 }

function clean(value: unknown, max: number): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

export function formatMemoryProfileFact(fact: MemoryProfileFact): string {
  const subject = clean(fact.subject, 40)
  const predicate = clean(fact.predicate, 40)
  const objectText = clean(fact.objectText, 120)
  let line = ''
  if (subject && predicate && objectText) {
    line = /^(我|用户|本人)$/.test(subject)
      ? `${predicate}：${objectText}`
      : `${subject} · ${predicate}：${objectText}`
  } else if (predicate && objectText) {
    line = `${predicate}：${objectText}`
  } else if (subject && objectText) {
    line = `${subject}：${objectText}`
  } else {
    line = clean(fact.content, 160)
  }
  return line
}

export function loadMemoryProfile(
  db: Db,
  input: {
    companyId: string
    userId: string
    deptId?: string | null
    now?: number
    limit?: number
    maxChars?: number
  },
): MemoryProfileResult {
  const now = input.now ?? Date.now()
  const limit = Math.max(1, Math.min(20, input.limit ?? 12))
  const maxChars = Math.max(120, input.maxChars ?? 900)
  const rows = db
    .prepare(
      `SELECT id, scope_type, scope_id, fact_key, subject, predicate, object_text, content,
              confidence, importance, created_at, valid_to, sensitivity
         FROM memories
        WHERE company_id = ?
          AND deleted_at IS NULL
          AND archived_at IS NULL
          AND confirmed = 1
          AND memory_type = 'fact'
          AND fact_key IS NOT NULL
          AND fact_key <> ''
          AND (valid_to IS NULL OR valid_to > ?)
          AND ((scope_type = 'user' AND scope_id = ?)
            OR (scope_type = 'dept' AND scope_id = ?)
            OR (scope_type = 'company' AND scope_id = ?))
        ORDER BY COALESCE(importance, 0.5) DESC, created_at DESC
        LIMIT 200`,
    )
    .all(
      input.companyId,
      now,
      input.userId,
      input.deptId ?? '',
      input.companyId,
    ) as unknown as MemoryProfileRow[]

  const best = new Map<string, MemoryProfileFact & { priority: number }>()
  for (const row of rows) {
    if (clean(row.sensitivity, 20).toLowerCase() === 'sensitive') continue
    const factKey = clean(row.fact_key, 80)
    if (!factKey) continue
    const priority = SCOPE_PRIORITY[row.scope_type] ?? 0
    const existing = best.get(factKey)
    if (existing && existing.priority > priority) continue
    if (existing && existing.priority === priority && existing.createdAt >= row.created_at) continue
    best.set(factKey, {
      id: row.id,
      scopeType: row.scope_type,
      scopeId: row.scope_id,
      factKey,
      subject: clean(row.subject, 80),
      predicate: clean(row.predicate, 80),
      objectText: clean(row.object_text, 200),
      content: clean(row.content, 300),
      confidence: Number.isFinite(row.confidence) ? Number(row.confidence) : 1,
      importance: Number.isFinite(row.importance) ? Number(row.importance) : 0.5,
      createdAt: row.created_at,
      priority,
    })
  }

  const selected = [...best.values()]
    .sort((a, b) => b.importance - a.importance || b.createdAt - a.createdAt)
    .slice(0, limit)
  const lines: string[] = []
  let chars = 0
  for (const fact of selected) {
    const line = `- ${formatMemoryProfileFact(fact)}`
    if (chars + line.length > maxChars && lines.length > 0) break
    lines.push(line)
    chars += line.length
  }

  return {
    facts: selected.slice(0, lines.length).map(({ priority: _priority, ...fact }) => fact),
    text: lines.join('\n'),
    total: best.size,
  }
}
