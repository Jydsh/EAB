/**
 * 上下文窗口预算与压缩。
 *
 * 不依赖具体 tokenizer：按“中日韩字符约 1 token、其他字符约 3.5 字符/token”估算，
 * 估算值偏保守，用来决定保留多少历史。压缩不额外调用模型，避免把一次对话变成
 * 「先摘要再回答」两次调用；较早历史被压成一条 system 摘要，最近消息保持原文。
 */
import type { ChatMessage, LlmContent } from './llm.js'

const CJK_START = 0x2e80
const CJK_END = 0x9fff
const CJK_EXT_START = 0xac00
const CJK_EXT_END = 0xd7af

function isCjk(code: number): boolean {
  return (code >= CJK_START && code <= CJK_END) || (code >= CJK_EXT_START && code <= CJK_EXT_END)
}

export function contentText(content: LlmContent): string {
  if (typeof content === 'string') return content
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}

export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (isCjk(code)) cjk += 1
    else other += 1
  }
  return Math.ceil(cjk + other / 3.5)
}

export function messageTokens(message: ChatMessage): number {
  const text = contentText(message.content)
  const toolCalls = message.tool_calls ? JSON.stringify(message.tool_calls) : ''
  return estimateTokens(text) + (toolCalls ? estimateTokens(toolCalls) : 0)
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function roleLabel(role: ChatMessage['role']): string {
  if (role === 'user') return '用户'
  if (role === 'assistant') return '助手'
  if (role === 'tool') return '工具'
  return '系统'
}

function truncated(message: ChatMessage, maxChars: number): ChatMessage {
  const text = contentText(message.content)
  if (text.length <= maxChars) return message
  return { ...message, content: `${text.slice(0, Math.max(40, maxChars))}…` }
}

export interface CompressionOptions {
  readonly maxContext: number
  readonly maxOutputTokens: number
  /** 工具 schema 也占用上下文；由调用方按实际 tools 估算后传入 */
  readonly toolTokens?: number
  /** 预留的协议/模板开销 */
  readonly reserveTokens?: number
  /** 至少保留几条最近历史；预算实在不够时可以少于这个值 */
  readonly minRecentMessages?: number
}

export interface CompressionResult {
  readonly messages: ChatMessage[]
  readonly compressed: boolean
  readonly beforeTokens: number
  readonly afterTokens: number
  readonly removedMessages: number
}

/**
 * 把消息数组压到 maxContext 以内：
 * - 保留所有 system 消息和最后一条 user 及其之后的尾部；
 * - 历史里最近的消息保留原文；
 * - 更早的消息压成一条 system 摘要（每条最多约 240 字符）；
 * - 单条超长最近消息会被截断。
 */
export function compressMessagesForContext(
  messages: readonly ChatMessage[],
  options: CompressionOptions,
): CompressionResult {
  const reserveTokens = options.reserveTokens ?? 256
  const toolTokens = options.toolTokens ?? 0
  const minRecentMessages = options.minRecentMessages ?? 2
  const systemMessages = messages.filter((message) => message.role === 'system')
  let lastUserIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') {
      lastUserIndex = index
      break
    }
  }
  const tailStart = lastUserIndex >= 0 ? lastUserIndex : messages.length
  const history = messages.slice(0, tailStart).filter((message) => message.role !== 'system')
  const tail = messages.slice(tailStart)
  const fixedTokens =
    [...systemMessages, ...tail].reduce((sum, message) => sum + messageTokens(message), 0) +
    toolTokens +
    reserveTokens
  const available = Math.max(0, options.maxContext - options.maxOutputTokens - fixedTokens)
  const beforeTokens = history.reduce((sum, message) => sum + messageTokens(message), 0)

  if (beforeTokens <= available) {
    return { messages: [...messages], compressed: false, beforeTokens, afterTokens: beforeTokens, removedMessages: 0 }
  }

  // 输入预算已经被 system/当前问题占满，历史只能全部丢弃。
  if (available <= 0) {
    return {
      messages: [...systemMessages, ...tail],
      compressed: history.length > 0,
      beforeTokens,
      afterTokens: 0,
      removedMessages: history.length,
    }
  }

  const recentBudget = Math.floor(available * 0.7)
  const recent: ChatMessage[] = []
  let recentTokens = 0
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]
    const tokens = messageTokens(message)
    if (recent.length === 0 && tokens > recentBudget) {
      const maxChars = Math.max(200, Math.floor(recentBudget * 1.8))
      const clipped = truncated(message, maxChars)
      recent.unshift(clipped)
      recentTokens = messageTokens(clipped)
      break
    }
    if (recentTokens + tokens > recentBudget && recent.length >= minRecentMessages) break
    recent.unshift(message)
    recentTokens += tokens
  }

  const older = history.slice(0, Math.max(0, history.length - recent.length))
  const digestBudget = Math.max(0, available - recentTokens)
  const prefix = '【较早对话压缩摘要（原文已省略）】'
  const prefixTokens = estimateTokens(prefix)
  let digestTokens = prefixTokens
  const digestLines: string[] = []
  for (let index = older.length - 1; index >= 0; index -= 1) {
    const message = older[index]
    const text = oneLine(contentText(message.content))
    if (!text) continue
    const line = `- ${roleLabel(message.role)}：${text.length > 240 ? `${text.slice(0, 240)}…` : text}`
    const lineTokens = estimateTokens(line)
    if (digestTokens + lineTokens > digestBudget) continue
    digestLines.unshift(line)
    digestTokens += lineTokens
  }
  const omitted = older.length - digestLines.length
  const note =
    digestLines.length > 0
      ? `${prefix}${omitted > 0 ? `（更早的 ${omitted} 条已省略）` : ''}\n${digestLines.join('\n')}`
      : ''
  const resultMessages = [...systemMessages, ...(note ? [{ role: 'system' as const, content: note }] : []), ...recent, ...tail]
  return {
    messages: resultMessages,
    compressed: true,
    beforeTokens,
    afterTokens: resultMessages.reduce((sum, message) => sum + messageTokens(message), 0),
    removedMessages: history.length - recent.length,
  }
}
