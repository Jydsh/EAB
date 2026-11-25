/**
 * 长期记忆自动抽取。
 *
 * - 默认 rules 模式，只抽确定性的第一人称事实和偏好，不额外调用模型；
 * - EAB_MEMORY_AUTO_EXTRACT=llm 时再叠加一次 JSON 抽取；
 * - 个人范围、高置信、不冲突的事实/偏好默认自动生效（EAB_MEMORY_AUTO_CONFIRM=off 可退回影子模式）；
 * - 冲突、低置信、情景记忆仍然落待确认；公司/部门级记忆一律不由自动抽取写入。
 */
import { randomUUID } from 'node:crypto'
import type { Db } from '@eab/storage'
import { callModel } from './llm.js'
import {
  findMemoryDuplicateOrConflict,
  findStructuredFactConflict,
  memoryLooksSensitive,
  normalizeFactKey,
  type MemoryType,
} from './memory-os.js'

export type MemoryAutoExtractMode = 'off' | 'rules' | 'llm'

export interface MemoryExtractionCandidate {
  readonly memoryType: MemoryType
  readonly content: string
  readonly factKey?: string
  readonly subject?: string
  readonly predicate?: string
  readonly objectText?: string
  readonly confidence: number
  readonly importance: number
  readonly eventAt?: number
  readonly salience?: number
}

export interface MemoryExtractionResult {
  readonly mode: MemoryAutoExtractMode
  readonly autoConfirm: boolean
  readonly extracted: number
  readonly inserted: number
  readonly activated: number
  readonly duplicates: number
  readonly conflicts: number
  readonly skippedSensitive: number
  readonly insertedIds: readonly string[]
  readonly activatedIds: readonly string[]
}

export function memoryAutoExtractMode(): MemoryAutoExtractMode {
  const raw = String(process.env.EAB_MEMORY_AUTO_EXTRACT ?? 'rules').trim().toLowerCase()
  if (raw === 'off' || raw === '0' || raw === 'false' || raw === 'disabled') return 'off'
  if (raw === 'llm' || raw === 'model' || raw === 'shadow+llm') return 'llm'
  return 'rules'
}

/** 个人记忆默认自动生效；设 EAB_MEMORY_AUTO_CONFIRM=off 可退回“全部待确认”。 */
export function memoryAutoConfirmEnabled(): boolean {
  const raw = String(process.env.EAB_MEMORY_AUTO_CONFIRM ?? 'on').trim().toLowerCase()
  return !['off', '0', 'false', 'disabled'].includes(raw)
}

function clean(value: string, max: number): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function sentence(value: string): string {
  return String(value ?? '').replace(/[。！？\n]+$/g, '').trim()
}

function factCandidate(input: {
  content: string
  factKey: string
  subject: string
  predicate: string
  objectText: string
  confidence: number
  importance?: number
}): MemoryExtractionCandidate {
  return {
    memoryType: 'fact',
    content: sentence(input.content).slice(0, 300),
    factKey: normalizeFactKey(input.factKey),
    subject: clean(input.subject, 40),
    predicate: clean(input.predicate, 40),
    objectText: clean(input.objectText, 120),
    confidence: Math.max(0, Math.min(1, input.confidence)),
    importance: input.importance ?? 0.7,
  }
}

/**
 * 规则抽取只覆盖高置信、单句、第一人称事实。宁可不记，也不把“我今天很累”
 * 这类一次性状态写成长期事实。
 */
export function extractMemoryCandidatesByRules(text: string): MemoryExtractionCandidate[] {
  const source = String(text ?? '').normalize('NFKC')
  if (!source || source.length > 4000) return []
  const out: MemoryExtractionCandidate[] = []
  const seen = new Set<string>()
  const add = (candidate: MemoryExtractionCandidate) => {
    const key = `${candidate.memoryType}:${candidate.factKey ?? ''}:${candidate.objectText ?? candidate.content}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(candidate)
  }

  const name = /我(?:的名字)?叫\s*([\p{Script=Han}A-Za-z·]{1,20})/u.exec(source)
    ?? /我的名字(?:是|叫)\s*([\p{Script=Han}A-Za-z·]{1,20})/u.exec(source)
  if (name?.[1] && !/^(很|在|个|一名|一个)/.test(name[1])) {
    add(factCandidate({
      content: `我叫${name[1]}`,
      factKey: 'user.name',
      subject: '我',
      predicate: '姓名',
      objectText: name[1],
      confidence: 0.98,
      importance: 0.9,
    }))
  }

  const fear = /我(?:很|特别|有些|有点)?(?:怕|害怕)\s*([\p{Script=Han}A-Za-z0-9·]{1,24})/u.exec(source)
  if (fear?.[1] && !/^(被|过|了|得|的|吗|呢)$/.test(fear[1])) {
    add(factCandidate({
      content: `我怕${fear[1]}`,
      factKey: 'user.fear',
      subject: '我',
      predicate: '害怕',
      objectText: fear[1],
      confidence: 0.9,
      importance: 0.7,
    }))
  }

  const like = /我(?:很|比较|更|最)?(?:喜欢|爱|偏好)\s*([^，。！？；\n]{1,40})/u.exec(source)
  if (like?.[1]) {
    add({
      memoryType: 'preference',
      content: sentence(`我喜欢${like[1]}`),
      confidence: 0.85,
      importance: 0.6,
    })
  }

  const habit = /我(?:通常|一般|习惯|平时)\s*([^，。！？；\n]{2,60})/u.exec(source)
  if (habit?.[1]) {
    add(factCandidate({
      content: `我习惯${habit[1]}`,
      factKey: 'user.habit',
      subject: '我',
      predicate: '习惯',
      objectText: habit[1],
      confidence: 0.8,
      importance: 0.65,
    }))
  }

  const possession = /我的([\p{Script=Han}A-Za-z]{1,20})(?:是|为|叫)\s*([^，。！？；\n]{1,60})/u.exec(source)
  if (possession?.[1] && possession[2] && !/^(名字|姓名)$/.test(possession[1])) {
    add(factCandidate({
      content: `我的${possession[1]}是${possession[2]}`,
      factKey: `user.${possession[1]}`,
      subject: '我',
      predicate: possession[1],
      objectText: possession[2],
      confidence: 0.85,
      importance: 0.7,
    }))
  }

  const preference = /(以后|今后)(?:都|请|统一)?(?:用|按|照|叫我|称呼我)\s*([^。！？\n]{2,80})/u.exec(source)
  if (preference?.[2] && /(回复|格式|汇报|文档|表格|邮件|称呼|写|排版|输出)/.test(preference[2])) {
    add({
      memoryType: 'preference',
      content: sentence(`${preference[1]}${preference[2]}`),
      confidence: 0.8,
      importance: 0.65,
    })
  }

  return out.slice(0, 8)
}

export function structuredFactFromContent(content: string): MemoryExtractionCandidate | null {
  return extractMemoryCandidatesByRules(content).find((item) => item.memoryType === 'fact') ?? null
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const raw = String(text ?? '').trim()
  if (!raw) return null
  const direct = raw.match(/\{[\s\S]*\}/)
  if (!direct) return null
  try {
    const parsed = JSON.parse(direct[0]) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function asArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    : []
}

function candidateFromModel(item: Record<string, unknown>, memoryType: MemoryType): MemoryExtractionCandidate | null {
  const content = clean(String(item.content ?? item.text ?? ''), 300)
  if (!content) return null
  const evidence = clean(String(item.evidence ?? item.quote ?? ''), 200)
  if (!evidence) return null
  const confidenceRaw = Number(item.confidence)
  const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : 0.7
  if (confidence < 0.6) return null
  if (memoryType === 'fact') {
    const factKey = normalizeFactKey(item.factKey ?? item.fact_key)
    const objectText = clean(String(item.object ?? item.objectText ?? item.object_text ?? content), 120)
    if (!factKey || !objectText) return null
    return {
      memoryType,
      content,
      factKey,
      subject: clean(String(item.subject ?? ''), 40),
      predicate: clean(String(item.predicate ?? ''), 40),
      objectText,
      confidence,
      importance: 0.7,
    }
  }
  if (memoryType === 'episode') {
    const salienceRaw = Number(item.salience)
    return {
      memoryType,
      content,
      confidence,
      importance: 0.55,
      salience: Number.isFinite(salienceRaw) ? Math.max(0, Math.min(1, salienceRaw)) : 0.55,
    }
  }
  return { memoryType, content, confidence, importance: 0.6 }
}

export function candidatesFromModelJson(text: string): MemoryExtractionCandidate[] {
  const parsed = parseJsonObject(text)
  if (!parsed) return []
  const out: MemoryExtractionCandidate[] = []
  for (const item of asArray(parsed.facts)) {
    const candidate = candidateFromModel(item, 'fact')
    if (candidate) out.push(candidate)
  }
  for (const item of asArray(parsed.preferences)) {
    const candidate = candidateFromModel(item, 'preference')
    if (candidate) out.push(candidate)
  }
  for (const item of asArray(parsed.episodes)) {
    const candidate = candidateFromModel(item, 'episode')
    if (candidate) out.push(candidate)
  }
  return out.slice(0, 10)
}

export interface InsertAutoMemoryResult {
  readonly status: 'activated' | 'inserted' | 'duplicate' | 'conflict' | 'sensitive'
  readonly id?: string
  readonly conflictWith?: string
}

/**
 * 个人范围的高置信事实/偏好/决策是否直接生效。
 * 团队/公司记忆一律不走这里，仍由管理员确认，避免个人判断污染共享上下文。
 */
export function personalMemoryAutoActivates(memoryType: MemoryType, confidence: number): boolean {
  if (!Number.isFinite(confidence)) return false
  if (memoryType === 'fact') return confidence >= 0.85
  if (memoryType === 'preference' || memoryType === 'decision') return confidence >= 0.8
  return false
}

export function insertAutoMemoryCandidate(
  db: Db,
  input: {
    companyId: string
    userId: string
    sessionId?: string | null
    sourceMessageId?: string | null
    candidate: MemoryExtractionCandidate
    autoConfirm?: boolean
  },
): InsertAutoMemoryResult {
  const candidate = input.candidate
  if (memoryLooksSensitive(candidate.content) || (candidate.objectText && memoryLooksSensitive(candidate.objectText))) {
    return { status: 'sensitive' }
  }
  const scopeType = 'user'
  const scopeId = input.userId
  const existing = candidate.factKey
    ? findStructuredFactConflict(db, {
        companyId: input.companyId,
        scopeType,
        scopeId,
        factKey: candidate.factKey,
        objectText: candidate.objectText ?? candidate.content,
      })
    : findMemoryDuplicateOrConflict(db, {
        companyId: input.companyId,
        scopeType,
        scopeId,
        memoryType: candidate.memoryType,
        content: candidate.content,
      })
  if (existing?.kind === 'duplicate') return { status: 'duplicate', id: existing.memory.id }
  const id = `mem_${randomUUID()}`
  const now = Date.now()
  const conflictWith = existing?.kind === 'conflict' ? existing.memory.id : null
  // 自动生效只覆盖个人范围、高置信、不冲突的事实/偏好/决策；情景与低置信候选继续待确认。
  const activate =
    input.autoConfirm === true &&
    !conflictWith &&
    personalMemoryAutoActivates(candidate.memoryType, candidate.confidence)
  db.prepare(
    `INSERT INTO memories
       (id, company_id, scope_type, scope_id, user_id, content, memory_type, confirmed,
        conflict_with, subject, predicate, object_text, fact_key, confidence,
        source_message_id, valid_from, importance, sensitivity, extraction_source,
        event_at, salience, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'normal', 'auto', ?, ?, ?)`,
  ).run(
    id,
    input.companyId,
    scopeType,
    scopeId,
    input.userId,
    candidate.content,
    candidate.memoryType,
    activate ? 1 : 0,
    conflictWith,
    candidate.subject ?? null,
    candidate.predicate ?? null,
    candidate.objectText ?? null,
    candidate.factKey ?? null,
    candidate.confidence,
    input.sourceMessageId ?? null,
    now,
    candidate.importance,
    candidate.eventAt ?? (candidate.memoryType === 'episode' ? now : null),
    candidate.salience ?? (candidate.memoryType === 'episode' ? 0.55 : null),
    now,
  )
  if (activate) return { status: 'activated', id }
  return { status: conflictWith ? 'conflict' : 'inserted', id, ...(conflictWith ? { conflictWith } : {}) }
}

async function extractWithModel(opts: {
  db: Db
  dbPath: string
  companyId: string
  modelId?: string | null
  userText: string
}): Promise<MemoryExtractionCandidate[]> {
  const modelId = String(opts.modelId ?? '').trim()
  if (!modelId || modelId.startsWith('plugin:')) return []
  const result = await callModel(
    opts.db,
    opts.dbPath,
    opts.companyId,
    modelId,
    [
      {
        role: 'system',
        content:
          '你是企业长期记忆抽取器。只抽取用户明确说过的稳定事实、长期偏好和可复用情景，不推断、不补全。' +
          '每条必须带 evidence，evidence 必须是用户原话里的连续片段；没有证据就不要输出。' +
          '忽略一次性任务、寒暄、工具结果、密码、手机号、身份证号、邮箱、银行卡号、客户隐私。' +
          '只输出 JSON，不要解释：{"facts":[{"subject":"","predicate":"","object":"","factKey":"user.name","content":"","evidence":"","confidence":0.9}],"preferences":[{"content":"","evidence":"","confidence":0.8}],"episodes":[{"content":"","evidence":"","confidence":0.7,"salience":0.6}]}。' +
          'factKey 用稳定英文键，例如 user.name、user.fear、user.habit、project.owner；没有就留空。',
      },
      { role: 'user', content: `用户本轮原话：\n${opts.userText.slice(0, 3000)}` },
    ],
    700,
    { timeoutMs: 30_000 },
  )
  return candidatesFromModelJson(result?.text ?? '')
}

export async function extractMemoryShadow(opts: {
  db: Db
  dbPath: string
  companyId: string
  userId: string
  sessionId?: string | null
  sourceMessageId?: string | null
  userText: string
  modelId?: string | null
  channel?: string | null
}): Promise<MemoryExtractionResult> {
  const mode = memoryAutoExtractMode()
  const autoConfirm = memoryAutoConfirmEnabled()
  const startedAt = Date.now()
  const channel = String(opts.channel || 'web').trim().toLowerCase().slice(0, 32) || 'web'
  const empty: MemoryExtractionResult = {
    mode,
    autoConfirm,
    extracted: 0,
    inserted: 0,
    activated: 0,
    duplicates: 0,
    conflicts: 0,
    skippedSensitive: 0,
    insertedIds: [],
    activatedIds: [],
  }
  if (mode === 'off') return empty
  const text = String(opts.userText ?? '').trim()
  if (!text || text.length < 4) return empty
  if (memoryLooksSensitive(text)) {
    const result = { ...empty, skippedSensitive: 1 }
    recordMemoryExtractionRun(opts.db, {
      companyId: opts.companyId,
      userId: opts.userId,
      sessionId: opts.sessionId,
      sourceMessageId: opts.sourceMessageId,
      channel,
      mode,
      autoConfirm,
      result,
      durationMs: Date.now() - startedAt,
    })
    return result
  }
  if (/^(你好|您好|嗨|在吗|谢谢|OK|好的)[。！？!?\s]*$/i.test(text)) return empty

  const candidates = extractMemoryCandidatesByRules(text)
  if (mode === 'llm') {
    try {
      candidates.push(...await extractWithModel(opts))
    } catch (error) {
      console.warn('[eab] 自动记忆抽取模型失败，保留规则候选：', (error as Error).message)
    }
  }
  const insertedIds: string[] = []
  const activatedIds: string[] = []
  let inserted = 0
  let activated = 0
  let duplicates = 0
  let conflicts = 0
  let skippedSensitive = 0
  for (const candidate of candidates.slice(0, 12)) {
    const result = insertAutoMemoryCandidate(opts.db, {
      companyId: opts.companyId,
      userId: opts.userId,
      sessionId: opts.sessionId,
      sourceMessageId: opts.sourceMessageId,
      candidate,
      autoConfirm,
    })
    if (result.status === 'activated') {
      inserted += 1
      activated += 1
      if (result.id) {
        insertedIds.push(result.id)
        activatedIds.push(result.id)
      }
    } else if (result.status === 'inserted') {
      inserted += 1
      if (result.id) insertedIds.push(result.id)
    } else if (result.status === 'conflict') {
      conflicts += 1
      if (result.id) insertedIds.push(result.id)
    } else if (result.status === 'duplicate') {
      duplicates += 1
    } else {
      skippedSensitive += 1
    }
  }
  const result: MemoryExtractionResult = {
    mode,
    autoConfirm,
    extracted: candidates.length,
    inserted,
    activated,
    duplicates,
    conflicts,
    skippedSensitive,
    insertedIds,
    activatedIds,
  }
  recordMemoryExtractionRun(opts.db, {
    companyId: opts.companyId,
    userId: opts.userId,
    sessionId: opts.sessionId,
    sourceMessageId: opts.sourceMessageId,
    channel,
    mode,
    autoConfirm,
    result,
    durationMs: Date.now() - startedAt,
  })
  return result
}

/**
 * 抽取运行记录只保存计数和渠道，不保存用户原话。
 * 统计失败不能影响记忆写入，因此所有错误只写服务日志。
 */
function recordMemoryExtractionRun(
  db: Db,
  opts: {
    companyId: string
    userId: string
    sessionId?: string | null
    sourceMessageId?: string | null
    channel: string
    mode: MemoryAutoExtractMode
    autoConfirm: boolean
    result: MemoryExtractionResult
    durationMs: number
  },
): void {
  try {
    db.prepare(
      `INSERT INTO memory_extraction_runs (
         id, company_id, user_id, session_id, source_message_id, channel, mode, auto_confirm,
         extracted, inserted, activated, duplicates, conflicts, skipped_sensitive, duration_ms, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `mer_${randomUUID()}`,
      opts.companyId,
      opts.userId,
      opts.sessionId ?? null,
      opts.sourceMessageId ?? null,
      opts.channel,
      opts.mode,
      opts.autoConfirm ? 1 : 0,
      opts.result.extracted,
      opts.result.inserted,
      opts.result.activated,
      opts.result.duplicates,
      opts.result.conflicts,
      opts.result.skippedSensitive,
      Math.max(0, Math.round(opts.durationMs)),
      Date.now(),
    )
  } catch (error) {
    console.warn('[eab] 自动记忆抽取记录写入失败：', (error as Error).message)
  }
}
