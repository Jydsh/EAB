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

function cleanLine(line: string): string {
  return line
    .replace(ZERO_WIDTH, '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trimEnd()
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
    const lines = source.text.replace(/\r\n/g, '\n').split('\n').map(cleanLine)
    const kept: string[] = []
    for (const line of lines) {
      if (shouldDropLine(line)) {
        removedLines += 1
        continue
      }
      kept.push(line)
    }
    let text = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
    if (source.type === 'table') {
      // 表格保留行结构；只压掉全空行，不合并列。
      text = kept.filter((line) => line.trim().length > 0).join('\n').trim()
    }
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
