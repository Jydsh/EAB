/**
 * 知识库规则清洗（P0）。
 *
 * 只做确定性的格式整理：编码/换行、零宽字符、重复空行、页码/页脚残留。
 * 不改数字、日期、金额、正文事实；模型清洗在 P1 单独实现。
 */
import type { KbBlock } from './kb-splitter.js'

export interface KbCleanResult {
  blocks: KbBlock[]
  text: string
  removedLines: number
  mode: 'rules'
}

const PAGE_NUMBER = /^(?:第\s*\d+\s*页(?:\s*[/／]\s*共\s*\d+\s*页)?|page\s*\d+(?:\s*of\s*\d+)?|-?\s*\d+\s*-?)$/i
const ZERO_WIDTH = /[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g

function cleanInline(value: string): string {
  return value
    .replace(ZERO_WIDTH, '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

function cleanLine(line: string): string {
  return cleanInline(line).trimEnd()
}

/** 表格行必须先按制表符拆列再清洗单元格，否则会把列结构压成一串空格。 */
function cleanTableLine(line: string): string {
  return line.split('\t').map(cleanInline).join('\t')
}

/** 代码块保留缩进和制表符，只去掉不可见字符与行尾空白。 */
function cleanCodeLine(line: string): string {
  return line.replace(ZERO_WIDTH, '').replace(/\u00a0/g, ' ').trimEnd()
}

function shouldDropLine(line: string): boolean {
  const value = line.trim()
  if (!value) return false
  return PAGE_NUMBER.test(value)
}

export function cleanKbBlocks(blocks: readonly KbBlock[]): KbCleanResult {
  let removedLines = 0
  const cleaned: KbBlock[] = []
  for (const source of blocks) {
    const preserveWhitespace = source.type === 'table' || source.type === 'code'
    const lines = source.text
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line) => (source.type === 'table' ? cleanTableLine(line) : source.type === 'code' ? cleanCodeLine(line) : cleanLine(line)))
    const kept: string[] = []
    for (const line of lines) {
      if (!preserveWhitespace && shouldDropLine(line)) {
        removedLines += 1
        continue
      }
      if (source.type === 'table' && !line.trim()) continue
      kept.push(line)
    }
    if (source.type === 'table') {
      // 表格保留行、列和空单元格；只压掉全空行，不合并列。
      const text = kept.join('\n').replace(/\n{3,}/g, '\n\n')
      if (!text.trim()) continue
      cleaned.push({ ...source, text })
      continue
    }
    if (source.type === 'code') {
      const text = kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
      if (!text.trim()) continue
      cleaned.push({ ...source, text })
      continue
    }
    const text = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
    if (!text) continue
    cleaned.push({ ...source, text })
  }
  return {
    blocks: cleaned,
    text: cleaned.map((item) => item.text).filter(Boolean).join('\n\n'),
    removedLines,
    mode: 'rules',
  }
}
