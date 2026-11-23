/**
 * 答案事实账本：把工具结果里的数字收成可核对证据，在交付前检查答案里的
 * 合计/条数/金额/时长等数字能不能在本次工具结果中找到。
 *
 * 边界：
 * - 只做确定性校验，不调用模型裁判；
 * - 只检查“带统计口径”的句子和明细表行，不把日期、编号、版本号当业务数字；
 * - 证据只来自本轮工具结果，长期记忆、历史回答和模型常识都不算；
 * - 派生指标（日均、占比、跨行合计）必须由 math_eval 或 rowStats 产出，否则不放行。
 */
import type { RowStats } from './batch-results.js'
import type { AgentToolTrace } from './routes/chat.js'

export interface ToolFactEvidence {
  /** 从工具 payload、rowStats、summary 里收集到的数字，最多 3000 个。 */
  readonly numbers: readonly number[]
  /** 调试用：证据文本摘要，不进入模型上下文。 */
  readonly sampleText: string
}

export interface ClaimNumber {
  readonly raw: string
  readonly value: number
}

export interface AnswerClaim {
  readonly text: string
  readonly marker: string
  readonly numbers: readonly ClaimNumber[]
}

export interface UnsupportedClaim {
  readonly text: string
  readonly numbers: readonly ClaimNumber[]
}

export type FactGateDecision =
  | {
      readonly action: 'finish'
      readonly text?: string
      readonly unsupported?: readonly UnsupportedClaim[]
    }
  | {
      readonly action: 'continue'
      readonly message: string
      readonly unsupported: readonly UnsupportedClaim[]
    }

const MAX_EVIDENCE_NUMBERS = 3_000
const MAX_CLAIM_LENGTH = 240

/**
 * 统计口径词。只抓这些词所在的句子，避免把“11月23日”“v2026.11.23.04”
 * 这类日期/版本号误判成业务数字。
 */
const CLAIM_MARKER_RE =
  /(合计|总计|总共|一共|共计|累计|平均|日均|占比|比例|人数|条数|条记录|记录数|金额|余额|库存|工资|薪酬|时长|小时|分钟|次数|天数|工作日|元|万元|%|％)/

const NON_CLAIM_PATTERNS: readonly RegExp[] = [
  // ISO 日期/时间
  /\d{4}-\d{1,2}-\d{1,2}(?:T\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?/g,
  // 中文日期
  /\d{4}年(?:\d{1,2}月)?(?:\d{1,2}日)?/g,
  /\d{1,2}月\d{1,2}日/g,
  // 时间
  /\d{1,2}:\d{2}(?::\d{2})?/g,
  // 版本号
  /(?:v|V)\d{4}\.\d{1,2}\.\d{1,2}(?:\.\d{1,2})?/g,
  // 工号/编号/单号：这些是标识，不是业务统计值。
  /(?:工号|编号|单号|业务号|审批号|身份证号?|手机号|电话)\s*[:：]?\s*[A-Za-z0-9_-]{3,}/g,
  // 手机号
  /1[3-9]\d{9}/g,
  // 长编号
  /\d{12,}/g,
]

function normalizeNumber(raw: string, unit?: string): number | null {
  const value = Number(raw.replace(/,/g, ''))
  if (!Number.isFinite(value)) return null
  if (unit === '万') return value * 10_000
  if (unit === '亿') return value * 100_000_000
  if (unit === '千') return value * 1_000
  if (unit === '百') return value * 100
  return value
}

/** 从一段文本里抽数字；跳过变量名、日期、编号，保留百分比和万/亿单位。 */
export function numbersInText(text: string): number[] {
  let cleaned = String(text ?? '')
  for (const pattern of NON_CLAIM_PATTERNS) cleaned = cleaned.replace(pattern, ' ')
  const out: number[] = []
  const re = /(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?)(\s*(?:万|亿|千|百))?/g
  let match: RegExpExecArray | null
  while ((match = re.exec(cleaned)) !== null) {
    const raw = match[1] ?? ''
    const unit = match[2]?.trim()
    const start = match.index
    const end = start + match[0].length
    const before = cleaned[start - 1] ?? ''
    const after = cleaned[end] ?? ''
    // dsh_5d94... / abc123 这类标识符里的数字不是业务数据。
    if (/[A-Za-z0-9_]/.test(before) || (/[A-Za-z0-9_]/.test(after) && unit === undefined)) continue
    // “11月”“23日”“2026年”已经在上面的日期规则里被清掉；这里再兜一层。
    if (unit === undefined && /[年月日号]/.test(after)) continue
    const value = normalizeNumber(raw, unit)
    if (value !== null) out.push(value)
  }
  return out
}

function collectNumbers(value: unknown, numbers: number[], depth: number, seen: Set<object>): void {
  if (numbers.length >= MAX_EVIDENCE_NUMBERS || depth > 8) return
  if (value === null || value === undefined) return
  if (typeof value === 'number') {
    if (Number.isFinite(value)) numbers.push(value)
    return
  }
  if (typeof value === 'string') {
    for (const number of numbersInText(value)) {
      if (numbers.length >= MAX_EVIDENCE_NUMBERS) return
      numbers.push(number)
    }
    return
  }
  if (typeof value !== 'object') return
  if (seen.has(value as object)) return
  seen.add(value as object)
  if (Array.isArray(value)) {
    for (const item of value) collectNumbers(item, numbers, depth + 1, seen)
    return
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    // 只跳过明显不是业务数值的字段名；其余交给 numbersInText 过滤标识符。
    if (/^(id|uuid|traceId|runId|sessionId|toolId|checksum|hash|version|createdAt|updatedAt|timestamp)$/i.test(key)) continue
    collectNumbers(child, numbers, depth + 1, seen)
  }
}

/** 把一次工具结果收成可核对证据；payload 与 rowStats 都算证据。 */
export function collectToolFactEvidence(payload: unknown, rowStats?: RowStats | null): ToolFactEvidence {
  const numbers: number[] = []
  const seen = new Set<object>()
  collectNumbers(payload, numbers, 0, seen)
  if (rowStats) collectNumbers(rowStats, numbers, 0, new Set<object>())
  const unique: number[] = []
  const seenNumbers = new Set<string>()
  for (const number of numbers) {
    const key = String(Math.round(number * 1_000_000) / 1_000_000)
    if (seenNumbers.has(key)) continue
    seenNumbers.add(key)
    unique.push(number)
    if (unique.length >= MAX_EVIDENCE_NUMBERS) break
  }
  return {
    numbers: unique,
    sampleText: JSON.stringify(payload ?? null).slice(0, 4_000),
  }
}

/** 把答案拆成“有统计口径的句子/明细表行”，并抽其中的数字。 */
export function extractAnswerClaims(answer: string): AnswerClaim[] {
  const claims: AnswerClaim[] = []
  const lines = String(answer ?? '').split(/\n/)
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    // 明细表行：有分隔符且至少两个数字，逐行核对，避免编造明细。
    if (line.includes('|') && !/^\|?\s*:?-{2,}/.test(line)) {
      const numbers = numbersInText(line)
      if (numbers.length >= 1 && (line.match(/\|/g) ?? []).length >= 2) {
        claims.push({ text: line.slice(0, MAX_CLAIM_LENGTH), marker: '明细行', numbers: numbers.map((value) => ({ raw: String(value), value })) })
      }
      continue
    }
    // 一句可能包含多个口径；按中文句号/分号切开，保留上下文。
    const parts = line.split(/(?<=[。！？；;])/).filter((part) => part.trim())
    for (const part of parts) {
      const text = part.trim()
      const marker = text.match(CLAIM_MARKER_RE)?.[1]
      if (!marker) continue
      const numbers = numbersInText(text)
      if (numbers.length === 0) continue
      claims.push({
        text: text.slice(0, MAX_CLAIM_LENGTH),
        marker,
        numbers: numbers.map((value) => ({ raw: String(value), value })),
      })
    }
  }
  return claims
}

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= 0.011
}

/** 百分比与小数互认：12.5% 可以匹配 0.125，反之亦然。 */
export function numberInEvidence(value: number, evidence: readonly number[]): boolean {
  const candidates = [value, value / 100, value * 100]
  return evidence.some((item) => candidates.some((candidate) => nearlyEqual(candidate, item)))
}

function unsupportedOf(claims: readonly AnswerClaim[], evidence: readonly number[]): UnsupportedClaim[] {
  const out: UnsupportedClaim[] = []
  for (const claim of claims) {
    const missing = claim.numbers.filter((item) => !numberInEvidence(item.value, evidence))
    if (missing.length > 0) out.push({ text: claim.text, numbers: missing })
  }
  return out
}

function evidenceOfTrace(trace: AgentToolTrace): number[] {
  const numbers: number[] = []
  if (trace.evidence) numbers.push(...trace.evidence.numbers)
  // 兼容旧轨迹：没有 evidence 时至少检查 summary 里的数字。
  numbers.push(...numbersInText(trace.summary))
  return numbers
}

/**
 * 交付前事实门禁。`forced` 是连续拦截次数；超过上限时不再把错误数字放给用户，
 * 而是返回一段安全答复（说明已查到数据，但关键数字无法核对）。
 */
export function answerFactGateDecision(opts: {
  readonly dataTurn: boolean
  readonly answer: string
  readonly traces: readonly AgentToolTrace[]
  readonly forced: number
  readonly maxForced?: number
}): FactGateDecision {
  if (!opts.dataTurn) return { action: 'finish' }
  const claims = extractAnswerClaims(opts.answer)
  if (claims.length === 0) return { action: 'finish' }

  const evidence: number[] = []
  for (const trace of opts.traces) {
    if (trace.status !== 'done') continue
    evidence.push(...evidenceOfTrace(trace))
  }
  const unsupported = unsupportedOf(claims, evidence)
  if (unsupported.length === 0) return { action: 'finish' }

  const maxForced = Math.max(0, opts.maxForced ?? 2)
  const list = unsupported
    .slice(0, 5)
    .map((item) => `- ${item.numbers.map((number) => number.raw).join('、')}：${item.text}`)
    .join('\n')
  if (opts.forced < maxForced) {
    return {
      action: 'continue',
      unsupported,
      message: [
        '【交付前事实门禁｜数字必须能在本轮工具结果里找到】',
        `答案里有 ${unsupported.length} 处数字没有证据：`,
        list,
        '',
        '现在不能把这段答案交付给用户。请立即核对：',
        '1. 合计、条数、金额、时长等数字必须直接引用工具结果里的原值或 rowStats；',
        '2. 日均、占比、跨行汇总等派生指标必须调用 math_eval，把原值放进去算，不能心算或估算；',
        '3. 核对后仍查不到的数字，改成“查不到/无法核对”，不要保留估计值；',
        '4. 不要为了通过校验而把数字改小或删掉关键口径；必须重新取数或重新计算。',
      ].join('\n'),
    }
  }

  return {
    action: 'finish',
    unsupported,
    text: `我查到了数据，但其中 ${unsupported.length} 处数字无法与工具返回结果核对，不能给出确定结论。请缩小查询范围（指定人名、时间范围或字段）后我再查一次。`,
  }
}
