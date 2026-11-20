/**
 * 对话引用：默认只注入摘要，模型需要细节时再调用 conversation_read。
 * 只允许读取本人、本公司的对话，避免引用变成越权读别人聊天记录的入口。
 */
import { EC, EabError } from '@eab/domain'
import type { Db } from '@eab/storage'
import { extractMemoryTerms } from './chat-memory.js'

export const CONVERSATION_READ_TOOL_NAME = 'conversation_read'

export const CONVERSATION_READ_TOOL_SPEC = {
  type: 'function',
  function: {
    name: CONVERSATION_READ_TOOL_NAME,
    description:
      '读取用户引用对话的详细消息。默认注入的只是摘要；当摘要缺少具体数字、结论、文件名或上下文时调用本工具。只能读取用户自己引用的对话。',
    parameters: {
      type: 'object',
      properties: {
        conversationId: { type: 'string', description: '引用对话 id，系统提示的参考对话块里有' },
        query: { type: 'string', description: '可选：要找的关键词或短语；不传则按时间倒序返回最近消息' },
        limit: { type: 'number', description: '可选：返回消息条数，默认 8，最多 12' },
        offset: {
          type: 'number',
          description:
            '可选：不传 query 时生效，从最新一条往前跳过多少条，默认 0；用于分页读取更早消息。返回的 nextOffset 不为空时，表示还能继续往前读',
        },
      },
      required: ['conversationId'],
    },
  },
} as const

interface ConversationRow {
  role: 'user' | 'assistant'
  text: string
}

export interface ConversationReferenceSummary {
  title: string
  text: string
  messageCount: number
}

const SUMMARY_RECENT_MESSAGES = 8
const SUMMARY_FIRST_CHARS = 240
const SUMMARY_RECENT_CHARS = 1_600
const READ_MAX_MESSAGES = 12
const READ_SEARCH_MESSAGES = 50
const READ_MAX_CHARS = 3_000

function loadSession(db: Db, actor: { subject: { companyId: string }; person: { id: string } }, conversationId: string) {
  const session = db
    .prepare(
      `SELECT id, title FROM chat_sessions
        WHERE id = ? AND company_id = ? AND user_id = ? AND deleted_at IS NULL`,
    )
    .get(conversationId, actor.subject.companyId, actor.person.id) as
    | { id: string; title: string | null }
    | undefined
  if (!session) throw new EabError(EC.NOT_FOUND, '只能引用自己的对话，或该对话已删除')
  return session
}

function messageLine(row: ConversationRow): string {
  const body = String(row.text ?? '').replace(/\r\n/g, '\n').trim()
  return body ? `${row.role === 'user' ? '用户' : '助手'}：${body}` : ''
}

function recentRows(db: Db, conversationId: string, limit: number, offset = 0): ConversationRow[] {
  const rows = db
    .prepare(
      `SELECT role, text FROM chat_messages
        WHERE session_id = ? AND role IN ('user', 'assistant')
        ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(conversationId, limit, Math.max(0, offset)) as unknown as ConversationRow[]
  return rows.reverse()
}

/**
 * 关键词先做整段对话的原样子串匹配。
 * 只扫最近 50 条会漏掉长对话前半段的细节；SQL 的 LIKE 能覆盖全部消息，
 * 再用 limit 截断结果，既不把全文塞回上下文，也不会让早先内容不可达。
 */
function keywordRows(db: Db, conversationId: string, query: string, limit: number): ConversationRow[] {
  const escaped = query.replace(/[\\%_]/g, (char) => `\\${char}`)
  const rows = db
    .prepare(
      `SELECT role, text FROM chat_messages
        WHERE session_id = ? AND role IN ('user', 'assistant')
          AND text LIKE ? ESCAPE '\\'
        ORDER BY created_at DESC LIMIT 100`,
    )
    .all(conversationId, `%${escaped}%`) as unknown as ConversationRow[]
  return rows.slice(0, limit).reverse()
}

export function readChatConversationReference(
  db: Db,
  actor: { subject: { companyId: string }; person: { id: string } },
  conversationId: string,
): ConversationReferenceSummary {
  const session = loadSession(db, actor, conversationId)
  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ? AND role IN ('user', 'assistant')`)
    .get(conversationId) as { n: number | string } | undefined
  const totalCount = Number(total?.n ?? 0)
  const firstUser = db
    .prepare(
      `SELECT role, text FROM chat_messages
        WHERE session_id = ? AND role = 'user'
        ORDER BY created_at ASC LIMIT 1`,
    )
    .get(conversationId) as ConversationRow | undefined
  const recent = recentRows(db, conversationId, SUMMARY_RECENT_MESSAGES)
  const title = String(session.title ?? '').trim() || '未命名对话'
  const firstText = firstUser ? String(firstUser.text ?? '').replace(/\r\n/g, '\n').trim() : ''
  const recentText = recent.map(messageLine).filter(Boolean).join('\n\n')
  const text = [
    `对话「${title}」共 ${totalCount} 条用户/助手消息。`,
    firstText ? `最早的用户需求：${firstText.slice(0, SUMMARY_FIRST_CHARS)}${firstText.length > SUMMARY_FIRST_CHARS ? '…' : ''}` : '',
    `最近 ${recent.length} 条：`,
    recentText.slice(-SUMMARY_RECENT_CHARS),
    totalCount > recent.length
      ? `（这里只是摘要，另有 ${totalCount - recent.length} 条较早消息未展开；需要具体细节时调用 conversation_read，conversationId=${conversationId}）`
      : `（需要具体细节时调用 conversation_read，conversationId=${conversationId}）`,
  ]
    .filter(Boolean)
    .join('\n')
  return {
    title,
    text,
    messageCount: totalCount,
  }
}

function relevanceScore(text: string, query: string): number {
  const q = query.toLowerCase().trim()
  if (!q) return 0
  const t = text.toLowerCase()
  let score = 0
  for (const token of q.split(/[^\p{L}\p{N}]+/u)) {
    if (token.length >= 2 && t.includes(token)) score += token.length * 2
  }
  const chars = [...q.replace(/[^\p{L}\p{N}]+/gu, '')]
  for (let i = 0; i + 2 <= chars.length; i += 1) {
    const pair = `${chars[i]}${chars[i + 1]}`
    if (t.includes(pair)) score += 1
  }
  return score
}

export function readChatConversationMessages(
  db: Db,
  actor: { subject: { companyId: string }; person: { id: string } },
  conversationId: string,
  options: { query?: string; limit?: number; offset?: number } = {},
): {
  conversationId: string
  title: string
  messageCount: number
  totalMessages: number
  offset: number
  nextOffset: number | null
  hasMore: boolean
  text: string
} {
  const session = loadSession(db, actor, conversationId)
  const limit = Math.max(1, Math.min(READ_MAX_MESSAGES, Number(options.limit) || 8))
  const query = String(options.query ?? '').trim()
  const offset = Math.max(0, Math.floor(Number(options.offset) || 0))
  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ? AND role IN ('user', 'assistant')`)
    .get(conversationId) as { n: number | string } | undefined
  const totalMessages = Number(total?.n ?? 0)
  let rows: ConversationRow[]
  let hasMore = false
  if (query) {
    // 优先在整段对话里找原词；找不到再退回最近 50 条做分词匹配。
    const exact = keywordRows(db, conversationId, query, limit)
    const candidates = exact.length > 0 ? exact : recentRows(db, conversationId, READ_SEARCH_MESSAGES)
    const scored = candidates
      .map((row) => ({ row, score: relevanceScore(String(row.text ?? ''), query) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((item) => item.row)
    // 关键词没命中时不要返回空，退回最近消息，避免模型误以为对话没内容。
    rows = scored.length > 0 ? scored : exact.length > 0 ? exact : recentRows(db, conversationId, limit)
    // 关键词路径按相关度排序，翻页没有稳定顺序；明确告诉调用方用更精确的 query。
    hasMore = false
  } else {
    rows = recentRows(db, conversationId, limit, offset)
    hasMore = offset + rows.length < totalMessages
  }
  let text = rows.map(messageLine).filter(Boolean).join('\n\n')
  if (text.length > READ_MAX_CHARS) text = `${text.slice(0, READ_MAX_CHARS)}…（已截断）`
  return {
    conversationId,
    title: String(session.title ?? '').trim() || '未命名对话',
    messageCount: rows.length,
    totalMessages,
    offset,
    nextOffset: hasMore ? offset + rows.length : null,
    hasMore,
    text: text || '（这段对话没有可读取的用户/助手消息）',
  }
}

const DETAIL_FIELD_PATTERN =
  /(编号|代号|字段|文件名|金额|日期|时间|结论|原话|原文|负责人|地址|电话|参数|状态|口径|控制器|简称|说了什么|怎么说的|第[一二三四五六七八九十0-9]+条|叫什么)/
const DETAIL_VALUE_PATTERN =
  /的([\p{Script=Han}A-Za-z0-9_-]{2,20})(?:是什么|是多少|叫什么|是哪个|在哪|有哪些|有多少|多久|什么时候)/u
const DETAIL_QUOTED_PATTERN = /[「“"'][^」”"']{2,30}[」”"']/

/**
 * 只有“问具体字段/具体值”才预读，避免“这个对话讲什么”“有多少条消息”这类
 * 泛问题也触发一次整段检索。命中字段词、引号里的原词，或“的 X 是什么/多少”才算细节问题。
 */
function isDetailQuestion(question: string): boolean {
  const text = String(question || '').normalize('NFKC')
  return DETAIL_FIELD_PATTERN.test(text) || DETAIL_VALUE_PATTERN.test(text) || DETAIL_QUOTED_PATTERN.test(text)
}

const DETAIL_TERM_NOISE = new Set([
  '什么', '多少', '几个', '几条', '这个', '那个', '这段', '那段', '对话', '聊天', '历史',
  '引用', '刚才', '之前', '上次', '当时', '直接', '回答', '只答', '不要', '帮我', '请问',
])

function normalizeTerm(input: string): string {
  return String(input || '').normalize('NFKC').replace(/[「」“”"'《》【】（）()]/g, '').trim()
}

/**
 * 从“这次对接的内部代号是什么”这类问题里抽出用于整段对话检索的词。
 * 先取“的 X 是什么/是多少”里的 X，再补用户原词里的实体；不要用整句去 LIKE。
 */
function detailQueryTerms(question: string): string[] {
  const raw = String(question || '').normalize('NFKC')
  const terms: string[] = []
  const push = (value: string) => {
    const term = normalizeTerm(value)
    if (term.length < 2 || term.length > 20) return
    if (DETAIL_TERM_NOISE.has(term)) return
    if (terms.some((item) => item.toLowerCase() === term.toLowerCase())) return
    terms.push(term)
  }
  for (const match of raw.matchAll(/[「“"']([^」”"']{2,30})[」”"']/g)) push(match[1])
  for (const match of raw.matchAll(/的([\p{Script=Han}A-Za-z0-9_-]{2,12})(?:是什么|是多少|叫什么|是哪个|在哪|有哪些|有多少)/gu)) {
    push(match[1])
  }
  for (const match of raw.matchAll(/([\p{Script=Han}A-Za-z0-9_-]{2,12})(?:是什么|是多少|叫什么|是哪个)/gu)) {
    push(match[1])
  }
  for (const keyword of ['编号', '代号', '文件名', '金额', '日期', '时间', '结论', '控制器', '参数', '状态', '负责人', '地址', '电话']) {
    if (raw.includes(keyword)) push(keyword)
  }
  for (const term of extractMemoryTerms(raw)) push(term)
  return terms.slice(0, 6)
}

function searchRowsForTerms(db: Db, conversationId: string, terms: readonly string[]): ConversationRow[] {
  const escaped = terms.map((term) => term.replace(/[\\%_]/g, (char) => `\\${char}`))
  const clauses = escaped.map(() => `text LIKE ? ESCAPE '\\'`).join(' OR ')
  const params = escaped.map((term) => `%${term}%`)
  return db
    .prepare(
      `SELECT role, text FROM chat_messages
        WHERE session_id = ? AND role IN ('user', 'assistant') AND (${clauses})
        ORDER BY created_at DESC LIMIT 60`,
    )
    .all(conversationId, ...params) as unknown as ConversationRow[]
}

/**
 * 细节问题预读：摘要只保留首条需求和最近 8 条，用户问的字段可能藏在未展开的历史里。
 * 这里按问题关键词在整段引用对话里取最多 4 条原文，避免模型拿摘要里的相近字段硬答。
 */
export function prefetchConversationReferenceDetails(
  db: Db,
  actor: { subject: { companyId: string }; person: { id: string } },
  references: readonly { conversationId?: string; title: string; messageCount: number }[],
  question: string,
): { conversationId: string; title: string; text: string }[] {
  if (!isDetailQuestion(question)) return []
  const terms = detailQueryTerms(question)
  if (terms.length === 0) return []
  const details: { conversationId: string; title: string; text: string }[] = []
  let budget = 3_000
  for (const reference of references.slice(0, 2)) {
    const conversationId = String(reference.conversationId ?? '').trim()
    if (!conversationId || reference.messageCount <= SUMMARY_RECENT_MESSAGES) continue
    loadSession(db, actor, conversationId)
    const rows = searchRowsForTerms(db, conversationId, terms)
    if (rows.length === 0) continue
    const picked = rows
      .map((row) => ({ row, score: relevanceScore(String(row.text ?? ''), terms.join(' ')) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 4)
      .map((item) => item.row)
    const text = picked.map(messageLine).filter(Boolean).join('\n\n').slice(0, 1_500)
    if (!text) continue
    details.push({
      conversationId,
      title: reference.title,
      text: text.slice(0, Math.max(0, budget)),
    })
    budget -= text.length
    if (budget <= 0) break
  }
  return details
}
