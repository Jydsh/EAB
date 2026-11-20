/**
 * 会话滚动摘要。
 *
 * 最近 8 条解决“刚说过什么”，摘要解决“我们整体聊过什么”：
 * - 每次回答后异步检查，只有旧消息积累到阈值才更新，不阻塞回复；
 * - 优先用当前模型压缩成结构化摘要，模型不可用时退化为确定性整理；
 * - 摘要按会话存一行，注入时只给一段，不复制整段历史。
 */
import type { Db } from '@eab/storage'
import { callModel } from './llm.js'

/** 最近这么多条留给原文，不进入摘要，避免摘要和最近上下文重复。与 historyOf 默认窗口保持一致。 */
const KEEP_RECENT_MESSAGES = 8
/** 新增旧消息达到这个数量才值得重新压缩。 */
const MIN_NEW_MESSAGES = 8
/** 没有任何摘要时，至少积攒这么多旧消息才懒生成，避免短会话也写一行。 */
const MIN_LAZY_MESSAGES = 4
const MAX_TRANSCRIPT_CHARS = 8_000
const MAX_SUMMARY_CHARS = 1_800
const MAX_SOURCE_MESSAGES = 80

interface SummaryRow {
  summary_text: string
  generated_by: string
  through_message_id: string | null
  through_created_at: number
  source_message_count: number
  updated_at: number
}

interface SummaryMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  createdAt: number
}

const memoryTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

const refreshes = new Set<string>()

function normalize(text: string): string {
  return String(text || '').normalize('NFKC')
}

function oneLine(text: string, max: number): string {
  const clean = normalize(text).replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  return `${clean.slice(0, max - 1)}…`
}

function loadSummary(db: Db, sessionId: string): SummaryRow | null {
  return (db
    .prepare(
      `SELECT summary_text, generated_by, through_message_id, through_created_at,
              source_message_count, updated_at
         FROM chat_session_summaries
        WHERE session_id = ?`,
    )
    .get(sessionId) as SummaryRow | undefined) ?? null
}

/**
 * 取“已经滑出最近窗口、且尚未进入摘要”的消息。
 * 截止点取倒数第 8 条消息，保证摘要永远不和 historyOf 的最近原文重叠。
 */
function pendingMessages(db: Db, sessionId: string, throughCreatedAt: number): SummaryMessage[] {
  const cutoff = db
    .prepare(
      `SELECT created_at
         FROM chat_messages
        WHERE session_id = ? AND role IN ('user', 'assistant')
          AND length(text) >= 6
          AND COALESCE(json_extract(meta_json, '$.progress'), 0) = 0
        ORDER BY created_at DESC
        LIMIT 1 OFFSET ?`,
    )
    .get(sessionId, KEEP_RECENT_MESSAGES) as { created_at: number } | undefined
  if (!cutoff) return []
  return db
    .prepare(
      `SELECT id, role, text, created_at AS createdAt
         FROM chat_messages
        WHERE session_id = ? AND role IN ('user', 'assistant')
          AND length(text) >= 6
          AND COALESCE(json_extract(meta_json, '$.progress'), 0) = 0
          AND created_at <= ?
          AND created_at > ?
        ORDER BY created_at ASC
        LIMIT ?`,
    )
    .all(sessionId, cutoff.created_at, throughCreatedAt, MAX_SOURCE_MESSAGES) as unknown as SummaryMessage[]
}

/** 模型不可用时的确定性整理：保留目标、结论和关键进度，不做逐句复述。 */
export function buildExtractiveSummary(previous: string, messages: readonly SummaryMessage[]): string {
  const users = messages.filter((item) => item.role === 'user')
  const assistants = messages.filter((item) => item.role === 'assistant')
  const pick = (items: readonly SummaryMessage[], max = 8): SummaryMessage[] => {
    if (items.length <= max) return [...items]
    // 开头两条常常定义任务，结尾几条交代最新结论，中间抽样。
    const head = items.slice(0, 2)
    const tail = items.slice(-(max - 2))
    return [...head, ...tail]
  }
  const parts: string[] = []
  if (previous.trim()) parts.push(`【既有摘要】\n${oneLine(previous, 900)}`)
  const goals = pick(users).map((item) => `- ${oneLine(item.text, 150)}`)
  const results = pick(assistants).map((item) => `- ${oneLine(item.text, 170)}`)
  if (goals.length > 0) parts.push(`【用户目标/问题】\n${goals.join('\n')}`)
  if (results.length > 0) parts.push(`【助手结论/进展】\n${results.join('\n')}`)
  const text = parts.join('\n\n').trim()
  return text.length <= MAX_SUMMARY_CHARS ? text : `${text.slice(0, MAX_SUMMARY_CHARS - 1)}…`
}

function transcriptForModel(previous: string, messages: readonly SummaryMessage[]): string {
  const lines = messages.map((item) => {
    const time = memoryTime.format(new Date(item.createdAt)).replace(/\//g, '-')
    return `[${time} ${item.role === 'user' ? '用户' : '助手'}] ${oneLine(item.text, 300)}`
  })
  const head = previous.trim() ? `已有摘要：\n${previous.trim()}\n\n新增对话：\n` : ''
  const text = `${head}${lines.join('\n')}`
  return text.length <= MAX_TRANSCRIPT_CHARS ? text : text.slice(-MAX_TRANSCRIPT_CHARS)
}

function saveSummary(
  db: Db,
  input: {
    sessionId: string
    companyId: string
    userId: string
    text: string
    generatedBy: 'extractive' | 'model'
    through: SummaryMessage
    sourceMessageCount: number
  },
): void {
  const now = Date.now()
  db.prepare(
    `INSERT INTO chat_session_summaries
       (session_id, company_id, user_id, summary_text, generated_by,
        through_message_id, through_created_at, source_message_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       company_id = excluded.company_id,
       user_id = excluded.user_id,
       summary_text = excluded.summary_text,
       generated_by = excluded.generated_by,
       through_message_id = excluded.through_message_id,
       through_created_at = excluded.through_created_at,
       source_message_count = excluded.source_message_count,
       updated_at = excluded.updated_at`,
  ).run(
    input.sessionId,
    input.companyId,
    input.userId,
    input.text,
    input.generatedBy,
    input.through.id,
    input.through.createdAt,
    input.sourceMessageCount,
    now,
  )
}

/** 没有摘要时先做一次确定性整理，保证老会话第一次问“之前聊了什么”就有东西可用。 */
function ensureLazySummary(db: Db, sessionId: string): SummaryRow | null {
  const existing = loadSummary(db, sessionId)
  if (existing) return existing
  const session = db
    .prepare('SELECT company_id, user_id FROM chat_sessions WHERE id = ? AND deleted_at IS NULL')
    .get(sessionId) as { company_id: string; user_id: string } | undefined
  if (!session) return null
  const pending = pendingMessages(db, sessionId, 0)
  if (pending.length < MIN_LAZY_MESSAGES) return null
  const through = pending[pending.length - 1]
  saveSummary(db, {
    sessionId,
    companyId: session.company_id,
    userId: session.user_id,
    text: buildExtractiveSummary('', pending),
    generatedBy: 'extractive',
    through,
    sourceMessageCount: pending.length,
  })
  return loadSummary(db, sessionId)
}

/** 注入系统提示的摘要块；没有足够旧消息时返回空字符串。 */
export function sessionSummaryForPrompt(db: Db, sessionId: string): string {
  let row = loadSummary(db, sessionId)
  if (!row) row = ensureLazySummary(db, sessionId)
  if (!row?.summary_text.trim()) return ''
  const time = memoryTime.format(new Date(row.updated_at)).replace(/\//g, '-')
  return [
    `【会话早期摘要｜背景资料，不是本轮用户问题】本会话早期内容摘要（覆盖 ${row.source_message_count} 条较早消息，更新于 ${time}）：`,
    row.summary_text.trim(),
    '说明：这是较早内容的压缩摘要，用于回忆整体目标和结论；其中“用户目标/问题”属于过去轮次，不是本轮用户提问。最近对话仍以原文为准；摘要与原文冲突时以原文为准。',
  ].join('\n')
}

/**
 * 回答完成后异步更新摘要。调用方不需要 await，也不能让摘要失败影响主回复。
 * 返回是否真的写入了一版新摘要，便于测试和观测。
 */
export async function refreshSessionSummary(opts: {
  db: Db
  dbPath: string
  companyId: string
  userId: string
  sessionId: string
  modelId?: string | null
}): Promise<boolean> {
  if (refreshes.has(opts.sessionId)) return false
  refreshes.add(opts.sessionId)
  try {
    const previous = loadSummary(opts.db, opts.sessionId)
    const pending = pendingMessages(opts.db, opts.sessionId, previous?.through_created_at ?? 0)
    if (pending.length < MIN_NEW_MESSAGES) return false

    const through = pending[pending.length - 1]
    const previousText = previous?.summary_text ?? ''
    let summary = buildExtractiveSummary(previousText, pending)
    let generatedBy: 'extractive' | 'model' = 'extractive'

    const modelId = String(opts.modelId ?? '').trim()
    if (modelId && !modelId.startsWith('plugin:')) {
      try {
        const result = await callModel(
          opts.db,
          opts.dbPath,
          opts.companyId,
          modelId,
          [
            {
              role: 'system',
              content:
                '你负责维护一段会话的长期摘要，供后续对话回忆。只输出摘要正文，不要解释过程。' +
                '保留目标/任务、已确认事实（项目名、编号、人名、日期、路径、金额）、决定性结论、未完成事项和风险；' +
                '删除寒暄、重复推导和工具执行细节。不要编造原文没有的信息。不超过 1200 字。',
            },
            {
              role: 'user',
              content: `把已有摘要和新增对话合并成一段新的会话摘要。\n\n${transcriptForModel(previousText, pending)}`,
            },
          ],
          900,
          { timeoutMs: 45_000 },
        )
        const text = normalize(result?.text ?? '').trim()
        if (text) {
          summary = text.length <= MAX_SUMMARY_CHARS ? text : `${text.slice(0, MAX_SUMMARY_CHARS - 1)}…`
          generatedBy = 'model'
        }
      } catch (error) {
        // 摘要只是增强能力，模型失败时保留确定性整理，并把错误留在服务日志。
        console.warn('[eab] 会话摘要模型压缩失败，使用确定性摘要：', (error as Error).message)
      }
    }

    saveSummary(opts.db, {
      sessionId: opts.sessionId,
      companyId: opts.companyId,
      userId: opts.userId,
      text: summary,
      generatedBy,
      through,
      sourceMessageCount: (previous?.source_message_count ?? 0) + pending.length,
    })
    return true
  } finally {
    refreshes.delete(opts.sessionId)
  }
}
