import { extname } from 'node:path'
import { buildBatchOverview } from './batch-results.js'
import { parseDelimitedRecords } from './delimited.js'
import { countTextLines } from './workspace-text.js'

export interface WorkspaceFileAnalysis {
  kind: 'records' | 'text'
  totalRows: number
  columns: string[]
  overview: string
  coverage: string
}

/**
 * 对整份文件做服务端全量概览：
 * - CSV/TSV：解析全部记录，逐字段给出非空数、去重数和取值分布，数量由服务端直接计算；
 * - JSON 对象数组：同样按字段统计；
 * - 其它文本：统计全部行/字符，并给出开头、结尾和高频重复行。
 * 不调用模型，文件很大也不会因为上游超时或限流而只分析一半。
 */
export function analyzeWorkspaceFile(text: string, filename: string, question: string): WorkspaceFileAnalysis {
  const ext = extname(filename).toLowerCase()
  if (ext === '.csv' || ext === '.tsv') {
    const delimiter = ext === '.tsv' ? '\t' : ','
    const records = parseDelimitedRecords(text, delimiter)
    if (records) {
      return {
        kind: 'records',
        totalRows: records.rows.length,
        columns: records.columns,
        overview: buildBatchOverview(records.rows, records.columns, question, {
          maxColumns: 40,
          maxValues: 12,
          maxChars: 24_000,
        }),
        coverage: `已完整解析全部 ${records.rows.length} 条记录，字段统计覆盖 100% 记录`,
      }
    }
  }
  if (ext === '.json') {
    const records = parseJsonRecords(text)
    if (records) {
      return {
        kind: 'records',
        totalRows: records.rows.length,
        columns: records.columns,
        overview: buildBatchOverview(records.rows, records.columns, question, {
          maxColumns: 40,
          maxValues: 12,
          maxChars: 24_000,
        }),
        coverage: `已完整解析全部 ${records.rows.length} 条记录，字段统计覆盖 100% 记录`,
      }
    }
  }
  return analyzeTextOverview(text)
}

function analyzeTextOverview(text: string): WorkspaceFileAnalysis {
  const totalLines = countTextLines(text)
  const lines = text.split(/\r\n|\r|\n/)
  if (text.endsWith('\n') || text.endsWith('\r')) lines.pop()
  const nonEmpty = lines.filter((line) => line.trim()).length
  const first = lines.slice(0, 10).map((line, index) => `${index + 1}: ${clip(line, 120)}`)
  const lastStart = Math.max(0, lines.length - 10)
  const last = lines.slice(lastStart).map((line, index) => `${lastStart + index + 1}: ${clip(line, 120)}`)
  const counts = new Map<string, number>()
  for (const line of lines) {
    const normalized = clip(line.trim().replace(/\s+/g, ' '), 120)
    if (normalized.length < 8) continue
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1)
  }
  const repeated = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
  const overview = [
    `全文 ${text.length.toLocaleString('en-US')} 字符，${totalLines.toLocaleString('en-US')} 行，非空 ${nonEmpty.toLocaleString('en-US')} 行。`,
    '这是服务端对全文的完整结构与计数统计，不是逐行语义总结。',
    first.length > 0 ? `开头 ${first.length} 行：\n${first.join('\n')}` : '',
    last.length > 0 ? `结尾 ${last.length} 行：\n${last.join('\n')}` : '',
    repeated.length > 0
      ? `重复最多的行：\n${repeated.map(([value, count]) => `${count}× ${value}`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n\n')
  return {
    kind: 'text',
    totalRows: 0,
    columns: [],
    overview,
    coverage: `已完整统计全部 ${totalLines.toLocaleString('en-US')} 行 / ${text.length.toLocaleString('en-US')} 字符`,
  }
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function parseJsonRecords(text: string): { columns: string[]; rows: Array<Record<string, unknown>> } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const array = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { rows?: unknown }).rows)
        ? (parsed as { rows: unknown[] }).rows
        : null)
  if (!array || array.length === 0) return null
  if (!array.every((item) => item && typeof item === 'object' && !Array.isArray(item))) return null
  const columns: string[] = []
  const seen = new Set<string>()
  for (const item of array.slice(0, 10_000)) {
    for (const key of Object.keys(item as Record<string, unknown>)) {
      if (!seen.has(key)) {
        seen.add(key)
        columns.push(key)
      }
    }
  }
  return { columns, rows: array as Array<Record<string, unknown>> }
}
