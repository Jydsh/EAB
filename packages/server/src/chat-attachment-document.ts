/**
 * 对话附件的文档解析：把个人云空间里的 PDF / OOXML 文件抽成可注入模型的正文。
 *
 * 附件本身只负责“保存与回放”；解析失败不影响文件可用，而是把原因作为提示带回本轮。
 * 持久引用会在每一轮重新走这里，因此按 fileId + updatedAt + 大小做 LRU 缓存，避免重复拆 PDF。
 */
import { extname } from 'node:path'
import { KbParseError, parseKbFile } from './kb-parsers.js'

export const CHAT_DOCUMENT_MAX_BYTES = 25 * 1024 * 1024
export const CHAT_DOCUMENT_MAX_CHARS = 5_000_000

const DOCUMENT_EXTENSIONS = new Set([
  '.pdf',
  '.docx',
  '.xlsx',
  '.xlsm',
  '.pptx',
  '.doc',
  '.xls',
  '.ppt',
])

export interface ChatDocumentParse {
  text: string
  parser: string
  pageCount: number
  truncated: boolean
  warning?: string
}

export interface ChatDocumentParseInput {
  fileId: string
  filename: string
  mime?: string | null
  buffer: Buffer
  updatedAt?: number
}

const CACHE_MAX_ENTRIES = 24
const CACHE_MAX_CHARS = 15_000_000
const parseCache = new Map<string, ChatDocumentParse>()
let parseCacheChars = 0

export function isChatDocumentFilename(filename: string): boolean {
  return DOCUMENT_EXTENSIONS.has(extname(String(filename || '')).toLowerCase())
}

function cacheKey(input: ChatDocumentParseInput): string {
  return `${input.fileId}:${input.updatedAt ?? 0}:${input.buffer.length}`
}

function cacheGet(key: string): ChatDocumentParse | undefined {
  const hit = parseCache.get(key)
  if (!hit) return undefined
  parseCache.delete(key)
  parseCache.set(key, hit)
  return hit
}

function cacheSet(key: string, value: ChatDocumentParse): void {
  const previous = parseCache.get(key)
  if (previous) {
    parseCacheChars -= previous.text.length
    parseCache.delete(key)
  }
  parseCache.set(key, value)
  parseCacheChars += value.text.length
  while (parseCache.size > CACHE_MAX_ENTRIES || parseCacheChars > CACHE_MAX_CHARS) {
    const oldest = parseCache.keys().next().value as string | undefined
    if (!oldest) break
    const removed = parseCache.get(oldest)
    if (removed) parseCacheChars -= removed.text.length
    parseCache.delete(oldest)
  }
}

function humanParseError(err: unknown): string {
  if (err instanceof KbParseError) {
    if (err.code === 'OCR_REQUIRED') {
      return 'PDF 没有可提取的文本层，需要配置 OCR 后再读取正文；文件已保存，可直接预览'
    }
    return err.message
  }
  const message = err instanceof Error ? err.message : String(err ?? '')
  return message ? `文档解析失败：${message.slice(0, 160)}` : '文档解析失败，暂未读取到正文'
}

/**
 * 解析一个已落云空间的对话附件。非文档类型返回 null；文档类型即使解析失败也返回结果，
 * 由调用方把 warning 带进提示，不能因为解析问题让消息发送失败。
 */
export async function parseChatDocument(input: ChatDocumentParseInput): Promise<ChatDocumentParse | null> {
  if (!isChatDocumentFilename(input.filename)) return null
  const key = cacheKey(input)
  const cached = cacheGet(key)
  if (cached) return cached

  if (input.buffer.length > CHAT_DOCUMENT_MAX_BYTES) {
    const result: ChatDocumentParse = {
      text: '',
      parser: 'skipped',
      pageCount: 0,
      truncated: false,
      warning: `文件超过 ${Math.round(CHAT_DOCUMENT_MAX_BYTES / 1024 / 1024)} MB，暂不解析正文；文件已保存，可在云空间预览`,
    }
    cacheSet(key, result)
    return result
  }

  let parsed: Awaited<ReturnType<typeof parseKbFile>>
  try {
    parsed = await parseKbFile({
      buffer: input.buffer,
      filename: input.filename,
      mime: input.mime || 'application/octet-stream',
    })
  } catch (err) {
    const result: ChatDocumentParse = {
      text: '',
      parser: err instanceof KbParseError ? err.code.toLowerCase() : 'failed',
      pageCount: 0,
      truncated: false,
      warning: humanParseError(err),
    }
    cacheSet(key, result)
    return result
  }

  let text = String(parsed.text ?? '').trim()
  let truncated = false
  let warning: string | undefined
  if (text.length > CHAT_DOCUMENT_MAX_CHARS) {
    text = text.slice(0, CHAT_DOCUMENT_MAX_CHARS)
    truncated = true
    warning = `正文超过 ${CHAT_DOCUMENT_MAX_CHARS.toLocaleString()} 字符，本轮只解析前 ${CHAT_DOCUMENT_MAX_CHARS.toLocaleString()} 字符`
  }
  if (!text) {
    warning = warning ?? '文档没有提取到正文；文件已保存，可在云空间预览'
  }
  const result: ChatDocumentParse = {
    text,
    parser: String(parsed.meta.parser ?? ''),
    pageCount: Math.max(0, Number(parsed.pageCount) || 0),
    truncated,
    ...(warning ? { warning } : {}),
  }
  cacheSet(key, result)
  return result
}
