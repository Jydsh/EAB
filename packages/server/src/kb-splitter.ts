/**
 * 知识库切片器：所有入库入口共用这一份实现。
 *
 * 目标是“结构感知 + 可回链”，不是把文本按固定 800 字硬切：
 * - 标题、段落、列表、表格、代码分别处理；
 * - 表格按行组切，每片重复表头；
 * - 片与片保留少量重叠；
 * - 输出 heading / pageNo / sheetName / rowRange 等元数据。
 */
import { createHash } from 'node:crypto'

export type KbBlockType = 'heading' | 'paragraph' | 'list' | 'table' | 'code' | 'image'

export interface KbBlock {
  id: string
  text: string
  type: KbBlockType
  headingPath: string[]
  pageNo?: number
  sheetName?: string
  rowRange?: [number, number]
  meta?: Record<string, unknown>
}

export interface KbSplitOptions {
  maxTokens: number
  overlapTokens: number
  preserveTables?: boolean
  preserveCode?: boolean
}

export interface KbChunk {
  text: string
  heading: string
  pageNo: number | null
  sheetName: string | null
  meta: Record<string, unknown>
  tokenCount: number
  charCount: number
  contentHash: string
}

const DEFAULT_OPTIONS: KbSplitOptions = {
  maxTokens: 500,
  overlapTokens: 80,
  preserveTables: true,
  preserveCode: true,
}

/** 粗估 token：中文按字，英文/符号按 4 字符。只用于切分预算，不用于计费。 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let chinese = 0
  let other = 0
  for (const char of text) {
    if (/\p{Script=Han}/u.test(char)) chinese += 1
    else other += 1
  }
  return chinese + Math.ceil(other / 4)
}

function normalizeOptions(options?: Partial<KbSplitOptions>): KbSplitOptions {
  const maxTokens = Math.max(100, Math.min(1500, Math.round(options?.maxTokens ?? DEFAULT_OPTIONS.maxTokens)))
  const overlapTokens = Math.max(0, Math.min(maxTokens - 1, Math.round(options?.overlapTokens ?? DEFAULT_OPTIONS.overlapTokens)))
  return {
    maxTokens,
    overlapTokens,
    preserveTables: options?.preserveTables ?? true,
    preserveCode: options?.preserveCode ?? true,
  }
}

function hashText(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 12)
}

function splitSentences(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (!normalized) return []
  // 中文句末标点、英文句号/问号/感叹号、换行都作为候选边界；保留标点。
  const parts = normalized.split(/(?<=[。！？!?；;])|\n+/).map((part) => part.trim()).filter(Boolean)
  return parts.length ? parts : [normalized]
}

function takeTail(text: string, tokens: number): string {
  if (tokens <= 0 || !text) return ''
  const chars = text.slice(-Math.max(1, tokens * 2))
  const sentenceStart = chars.search(/[。！？!?；;\n]/)
  return sentenceStart >= 0 ? chars.slice(sentenceStart + 1).trim() : chars.trim()
}

function hardSlice(text: string, maxTokens: number): string[] {
  const out: string[] = []
  let current = ''
  for (const char of text) {
    const next = current + char
    if (estimateTokens(next) > maxTokens && current) {
      out.push(current)
      current = char
    } else {
      current = next
    }
  }
  if (current) out.push(current)
  return out
}

interface ChunkDraft {
  text: string
  block: KbBlock
}

function pushChunk(out: KbChunk[], draft: ChunkDraft): void {
  const text = draft.text.trim()
  if (!text) return
  out.push({
    text,
    heading: draft.block.headingPath.join(' > '),
    pageNo: draft.block.pageNo ?? null,
    sheetName: draft.block.sheetName ?? null,
    meta: {
      headingPath: draft.block.headingPath,
      pageNo: draft.block.pageNo ?? null,
      sheetName: draft.block.sheetName ?? null,
      rowRange: draft.block.rowRange ?? null,
      blockType: draft.block.type,
      ...(draft.block.meta ?? {}),
    },
    tokenCount: estimateTokens(text),
    charCount: text.length,
    contentHash: hashText(text),
  })
}

function splitTextBlock(block: KbBlock, options: KbSplitOptions, out: KbChunk[]): void {
  const sentences = splitSentences(block.text)
  let current = ''
  let overlap = ''
  for (const sentence of sentences) {
    const candidate = `${overlap}${current}${sentence}`
    if (estimateTokens(candidate) > options.maxTokens && current) {
      pushChunk(out, { text: current, block })
      overlap = takeTail(current, options.overlapTokens)
      current = `${overlap}${sentence}`
    } else {
      current = candidate
    }
  }
  if (current) pushChunk(out, { text: current, block })
}

function splitCodeBlock(block: KbBlock, options: KbSplitOptions, out: KbChunk[]): void {
  if (estimateTokens(block.text) <= options.maxTokens) {
    pushChunk(out, { text: block.text, block })
    return
  }
  const lines = block.text.split('\n')
  let current = ''
  let startLine = 0
  let lineNo = 0
  for (const line of lines) {
    lineNo += 1
    const candidate = current ? `${current}\n${line}` : line
    if (estimateTokens(candidate) > options.maxTokens && current) {
      pushChunk(out, {
        text: current,
        block: { ...block, rowRange: [startLine + 1, lineNo - 1] },
      })
      current = line
      startLine = lineNo - 1
    } else {
      current = candidate
    }
  }
  if (current) pushChunk(out, { text: current, block: { ...block, rowRange: [startLine + 1, lineNo] } })
}

function splitTableBlock(block: KbBlock, options: KbSplitOptions, out: KbChunk[]): void {
  if (!options.preserveTables) {
    splitTextBlock(block, options, out)
    return
  }
  const rows = block.text.split('\n').map((row) => row.trimEnd()).filter(Boolean)
  if (rows.length === 0) return
  const headerCount = Math.max(
    1,
    Math.min(rows.length, Math.round(Number(block.meta?.tableHeaderRows ?? 1)) || 1),
  )
  const headerRows = rows.slice(0, headerCount)
  const caption = String(block.meta?.tableCaption ?? '').trim()
  let header = headerRows.join('\n')
  if (caption && !headerRows.some((row) => row.includes(caption))) header = `${caption}\n${header}`
  const body = rows.slice(headerCount)
  const baseStart = block.rowRange?.[0] ?? 1
  if (estimateTokens(block.text) <= options.maxTokens) {
    pushChunk(out, { text: rows.join('\n'), block })
    return
  }
  let currentRows: string[] = []
  let currentTokens = estimateTokens(header)
  let groupStart = 0
  const flush = (endIndex: number): void => {
    if (currentRows.length === 0) return
    const text = [header, ...currentRows].join('\n')
    pushChunk(out, {
      text,
      block: { ...block, rowRange: [baseStart + groupStart, baseStart + endIndex] },
    })
    currentRows = []
    currentTokens = estimateTokens(header)
    groupStart = endIndex + 1
  }
  body.forEach((row, index) => {
    const rowTokens = estimateTokens(row)
    if (currentRows.length > 0 && currentTokens + rowTokens > options.maxTokens) flush(index - 1)
    if (rowTokens > options.maxTokens) {
      // 单行超长：按行内字符硬切，仍重复表头；避免一行撑爆上下文。
      if (currentRows.length > 0) flush(index - 1)
      for (const piece of hardSlice(row, Math.max(80, options.maxTokens - estimateTokens(header)))) {
        pushChunk(out, {
          text: `${header}\n${piece}`,
          block: { ...block, rowRange: [baseStart + index, baseStart + index] },
        })
      }
      groupStart = index + 1
      return
    }
    currentRows.push(row)
    currentTokens += rowTokens
  })
  if (currentRows.length > 0) flush(body.length - 1)
}

export function splitKbBlocks(blocks: readonly KbBlock[], rawOptions?: Partial<KbSplitOptions>): KbChunk[] {
  const options = normalizeOptions(rawOptions)
  const out: KbChunk[] = []
  for (const block of blocks) {
    const text = block.text.replace(/\r\n/g, '\n').trim()
    if (!text) continue
    if (block.type === 'heading') {
      // 标题单独不占正文片；它的路径已经写进后续 block 的 headingPath。
      if (estimateTokens(text) > 0 && out.length === 0) {
        pushChunk(out, { text, block })
      }
      continue
    }
    if (block.type === 'table') {
      splitTableBlock({ ...block, text }, options, out)
      continue
    }
    if (block.type === 'code' && options.preserveCode) {
      splitCodeBlock({ ...block, text }, options, out)
      continue
    }
    if (estimateTokens(text) <= options.maxTokens) {
      pushChunk(out, { text, block })
      continue
    }
    splitTextBlock({ ...block, text }, options, out)
  }
  return out
}
