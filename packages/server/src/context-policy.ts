/**
 * 上下文分层策略：决定“哪些记忆该进本轮提示，哪些只留在数据库”。
 *
 * 这里不负责检索，只做纯策略判断，便于测试，也避免把业务规则散落在
 * chat.ts 的提示拼装代码里。
 */
import { extractMemoryTerms } from './chat-memory.js'

/** 与 historyOf() 默认窗口保持一致；摘要只覆盖这个窗口之外的旧消息。 */
export const HISTORY_WINDOW_MESSAGES = 8

/** 长期记忆每轮最多注入几条；未命中的直接不进上下文。 */
export const LONG_TERM_MEMORY_LIMIT = 3

export interface LongTermMemoryLike {
  content: string
}

function normalize(input: string): string {
  return String(input || '').normalize('NFKC').toLowerCase()
}

/**
 * 查询词：保留 extractMemoryTerms 的实体词，再补中文双字片段。
 * 双字片段用于“文档/方案/考试/一题”这类短实体，避免整句词块过长导致漏配。
 */
function queryTerms(query: string): string[] {
  const base = extractMemoryTerms(query).filter((term) => term.length >= 2)
  const terms = new Set(base)
  const tokens = normalize(query).split(/[^\p{Script=Han}a-z0-9]+/u).filter(Boolean)
  for (const token of tokens) {
    if (!/^\p{Script=Han}{2,}$/u.test(token)) continue
    for (let index = 0; index + 2 <= token.length; index += 1) {
      terms.add(token.slice(index, index + 2))
    }
  }
  return [...terms]
}

/**
 * 只保留与当前问题有实际词面交集的长期记忆。
 *
 * 过去的长期记忆里经常出现“修改文档时必须…/以后都…”这类祈使句；
 * 如果每轮无条件注入，模型会把它当成本轮任务。这里要求至少命中一个
 * 长度 >= 3 的实体，或命中两个以上检索词，才认为“与当前问题相关”。
 */
export function selectRelevantLongTermMemories<T extends LongTermMemoryLike>(
  memories: readonly T[],
  query: string,
  limit = LONG_TERM_MEMORY_LIMIT,
): T[] {
  const terms = queryTerms(query)
  if (terms.length === 0) return []
  const picked: T[] = []
  for (const memory of memories) {
    const content = normalize(memory.content)
    if (!content) continue
    const matched = terms.filter((term) => content.includes(normalize(term))).length
    if (matched === 0) continue
    const strongMatch = terms.some((term) => term.length >= 3 && content.includes(normalize(term)))
    if (!strongMatch && matched < 2) continue
    picked.push(memory)
    if (picked.length >= limit) break
  }
  return picked
}
