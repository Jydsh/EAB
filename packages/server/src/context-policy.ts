/**
 * 上下文分层策略：决定“哪些记忆该进本轮提示，哪些只留在数据库”。
 *
 * 这里不负责检索，只做纯策略判断，便于测试，也避免把业务规则散落在
 * chat.ts 的提示拼装代码里。
 *
 * AGT-13 起，长期记忆召回从纯词面升级为“词面 + 向量”混合打分：
 * - 词面：沿用原来的实体命中门槛，避免无关记忆被无条件注入；
 * - 向量：问题向量与记忆向量的余弦相似度，补上“换了说法但语义相近”的召回；
 * - 衰减：只有 episode 情景记忆按时间衰减，偏好/事实/决策不受影响。
 */
import { extractMemoryTerms } from './chat-memory.js'
import {
  memoryContentSimilarity,
  memoryDecayWeight,
  memoryVectorSimilarity,
  normalizeMemoryType,
} from './memory-os.js'

/** 与 historyOf() 默认窗口保持一致；摘要只覆盖这个窗口之外的旧消息。 */
export const HISTORY_WINDOW_MESSAGES = 8

/** 长期记忆每轮最多注入几条；未命中的直接不进上下文。 */
export const LONG_TERM_MEMORY_LIMIT = 4

/** 向量召回门槛：低于该值的语义相似不参与注入，避免“同一领域但不相干”的记忆占满上下文。 */
export const LONG_TERM_VECTOR_THRESHOLD = 0.7

export interface LongTermMemoryLike {
  id?: string
  content: string
  memoryType?: string
  scopeType?: string
  source?: string
  createdAt?: number
  importance?: number
  embedding?: readonly number[]
}

export interface LongTermMemorySelection<T extends LongTermMemoryLike> {
  readonly memory: T
  readonly score: number
  readonly relevance: number
  readonly vectorScore: number
  readonly keywordHits: number
  readonly reasons: readonly string[]
}

export interface LongTermMemorySelectOptions {
  limit?: number
  queryVector?: readonly number[] | null
  now?: number
  vectorThreshold?: number
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
 * 只保留与当前问题有实际相关性的长期记忆。
 *
 * 旧规则要求至少命中一个长度 >= 3 的实体，或命中两个以上检索词；这样
 * “以后都…”这类祈使句不会每轮都进上下文。现在加一条向量通道：没有词面
 * 命中、但向量相似度足够高时也允许进入，用来覆盖换了说法的情况。
 */
export function selectRelevantLongTermMemories<T extends LongTermMemoryLike>(
  memories: readonly T[],
  query: string,
  limitOrOptions: number | LongTermMemorySelectOptions = LONG_TERM_MEMORY_LIMIT,
): T[] {
  return selectRelevantLongTermMemoriesDetailed(memories, query, limitOrOptions).map((item) => item.memory)
}

/**
 * 与 selectRelevantLongTermMemories 同一套打分，但额外返回命中原因。
 * 这些原因只写入消息 meta，用于“为什么这轮想起了这条”，不参与模型提示。
 */
export function selectRelevantLongTermMemoriesDetailed<T extends LongTermMemoryLike>(
  memories: readonly T[],
  query: string,
  limitOrOptions: number | LongTermMemorySelectOptions = LONG_TERM_MEMORY_LIMIT,
): LongTermMemorySelection<T>[] {
  const options: LongTermMemorySelectOptions =
    typeof limitOrOptions === 'number' ? { limit: limitOrOptions } : limitOrOptions
  const limit = Math.max(1, options.limit ?? LONG_TERM_MEMORY_LIMIT)
  const now = options.now ?? Date.now()
  const vectorThreshold = options.vectorThreshold ?? LONG_TERM_VECTOR_THRESHOLD
  const terms = queryTerms(query)
  const hasVector = Boolean(options.queryVector && options.queryVector.length > 0)
  if (terms.length === 0 && !hasVector) return []

  const picked: Array<LongTermMemorySelection<T> & { order: number }> = []
  memories.forEach((memory, order) => {
    const content = normalize(memory.content)
    if (!content) return
    const matched = terms.filter((term) => content.includes(normalize(term))).length
    const strongMatch = terms.some((term) => term.length >= 3 && content.includes(normalize(term)))
    const keywordEligible = matched > 0 && (strongMatch || matched >= 2)
    const keywordScore = terms.length > 0 ? matched / terms.length : 0
    const vectorScore = memoryVectorSimilarity(options.queryVector, memory.embedding)
    if (!keywordEligible && vectorScore < vectorThreshold) return

    const memoryType = normalizeMemoryType(memory.memoryType, 'fact')
    const decay = memoryDecayWeight(memoryType, memory.createdAt, now)
    // 偏好/事实/决策不随时间衰减；只有情景记忆按半衰期降权。
    const recency = memoryType === 'episode'
      ? 0.45 + 0.55 * decay
      : 1
    const importance = Math.max(0, Math.min(1, memory.importance ?? 0.5))
    const relevance = Math.min(1, keywordScore * 1.2 + Math.max(0, vectorScore) * 0.8)
    // 总分固定为 相关性 0.6 + 新近度 0.2 + 重要性 0.2，避免不同记忆类型用不同尺子。
    const score = relevance * 0.6 + recency * 0.2 + importance * 0.2
    const reasons: string[] = []
    if (matched > 0) reasons.push(`词面命中 ${matched} 个词`)
    if (vectorScore >= vectorThreshold) reasons.push(`语义相近 ${vectorScore.toFixed(2)}`)
    const scopeLabel = memory.scopeType === 'company' ? '公司' : memory.scopeType === 'dept' ? '部门' : '个人'
    reasons.push(scopeLabel)
    if (memoryType === 'episode') reasons.push(`时间权重 ${recency.toFixed(2)}`)
    reasons.push(`重要性 ${importance.toFixed(2)}`)
    picked.push({
      memory,
      score,
      relevance,
      vectorScore,
      keywordHits: matched,
      reasons,
      order,
    })
  })

  const sorted = picked.sort((a, b) => b.score - a.score || a.order - b.order)
  const selected: Array<LongTermMemorySelection<T>> = []
  for (const item of sorted) {
    // MMR 的轻量版：先按分数取，再跳过与已选内容高度重复的条目。
    // 情景记忆不在这里合并：同一句话在不同时间发生，是两条可区分的情景。
    const type = normalizeMemoryType(item.memory.memoryType, 'fact')
    if (
      type !== 'episode' &&
      selected.some((chosen) =>
        chosen.memory.content !== item.memory.content &&
        memoryContentSimilarity(chosen.memory.content, item.memory.content) >= 0.85
      )
    ) continue
    const { order: _order, ...selection } = item
    selected.push(selection)
    if (selected.length >= limit) break
  }
  return selected
}
