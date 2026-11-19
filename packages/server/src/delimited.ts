export interface DelimitedRecords {
  columns: string[]
  rows: Array<Record<string, string>>
}

/** 给重复或空的表头补唯一列名，保证每一列都能按名字取到值。 */
export function uniqueDelimitedColumns(header: string[]): string[] {
  const seen = new Map<string, number>()
  return header.map((value, index) => {
    const base = value.trim() || `列${index + 1}`
    const count = (seen.get(base) ?? 0) + 1
    seen.set(base, count)
    return count > 1 ? `${base}_${count}` : base
  })
}

/**
 * 严格解析带引号的 CSV/TSV：
 * - 支持 "" 转义、字段内逗号、字段内换行、CRLF、UTF-8 BOM；
 * - 少于两行（表头 + 至少一条记录）返回 null；
 * - 空行不计入记录。
 */
export function parseDelimitedRecords(text: string, delimiter: string): DelimitedRecords | null {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  const source = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        cell += '"'
        index += 1
      } else if (char === '"') {
        quoted = false
      } else {
        cell += char
      }
      continue
    }
    if (char === '"') {
      quoted = true
    } else if (char === delimiter) {
      row.push(cell)
      cell = ''
    } else if (char === '\n') {
      row.push(cell)
      if (row.some((item) => item.trim())) rows.push(row)
      row = []
      cell = ''
    } else {
      cell += char
    }
  }
  row.push(cell)
  if (row.some((item) => item.trim())) rows.push(row)
  if (rows.length < 2) return null
  const columns = uniqueDelimitedColumns(rows[0]!)
  const records = rows.slice(1).map((cells) => {
    const record: Record<string, string> = {}
    for (let index = 0; index < columns.length; index += 1) {
      record[columns[index]!] = cells[index] ?? ''
    }
    return record
  })
  return { columns, rows: records }
}

/** 根据首个非空行的分隔符数量猜测 CSV/TSV 分隔符；猜不到时返回 null。 */
export function guessDelimitedChar(text: string): string | null {
  const firstLine = text.replace(/^\uFEFF/, '').split(/\r?\n/).find((line) => line.trim())
  if (!firstLine) return null
  const counts: Array<[string, number]> = [
    [',', 0],
    ['\t', 0],
    [';', 0],
  ]
  let quoted = false
  for (let index = 0; index < firstLine.length; index += 1) {
    const char = firstLine[index]
    if (char === '"') {
      if (quoted && firstLine[index + 1] === '"') {
        index += 1
      } else {
        quoted = !quoted
      }
      continue
    }
    if (quoted) continue
    const hit = counts.find(([delimiter]) => delimiter === char)
    if (hit) hit[1] += 1
  }
  const best = counts.sort((a, b) => b[1] - a[1])[0]!
  return best[1] > 0 ? best[0] : null
}

export interface TabularText {
  columns: string[]
  rows: string[][]
  format: 'csv' | 'tsv' | 'markdown' | 'lines' | 'json'
}

function trimEmptyEdges(rows: string[][]): string[][] {
  const out = rows.map((row) => row.map((cell) => cell ?? ''))
  while (out.length > 0 && out[out.length - 1]!.every((cell) => !cell.trim())) out.pop()
  return out
}

function parseMarkdownTable(text: string): string[][] | null {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length < 2 || !lines[0]!.startsWith('|')) return null
  const isSeparator = (line: string): boolean => /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?$/u.test(line)
  const cellsOf = (line: string): string[] => {
    let body = line
    if (body.startsWith('|')) body = body.slice(1)
    if (body.endsWith('|')) body = body.slice(0, -1)
    return body.split('|').map((cell) => cell.trim())
  }
  const header = cellsOf(lines[0]!)
  const body: string[][] = []
  for (const line of lines.slice(1)) {
    if (isSeparator(line)) continue
    if (!line.includes('|')) continue
    body.push(cellsOf(line))
  }
  if (body.length === 0) return null
  return [header, ...body]
}

function parseJsonTable(text: string): string[][] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const array = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { rows?: unknown }).rows)
      ? (parsed as { rows: unknown[] }).rows
      : null
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
  if (columns.length === 0) return null
  return [
    columns,
    ...array.map((item) => columns.map((key) => {
      const value = (item as Record<string, unknown>)[key]
      return value === null || value === undefined ? '' : String(value)
    })),
  ]
}

/**
 * 把用户/AI 提供的“文本表格”转换成行列结构。
 * 优先识别 JSON 数组、Markdown 表格、CSV/TSV；都不像时按每行一列保留原文，
 * 避免把整段文字塞进一个单元格。
 */
export function parseTabularText(text: string): TabularText {
  const source = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const trimmed = source.trim()
  if (!trimmed) return { columns: ['内容'], rows: [], format: 'lines' }

  const json = parseJsonTable(trimmed)
  if (json) {
    return { columns: uniqueDelimitedColumns(json[0]!), rows: trimEmptyEdges(json.slice(1)), format: 'json' }
  }

  const markdown = parseMarkdownTable(source)
  if (markdown) {
    return { columns: uniqueDelimitedColumns(markdown[0]!), rows: trimEmptyEdges(markdown.slice(1)), format: 'markdown' }
  }

  const delimiter = guessDelimitedChar(source)
  if (delimiter) {
    const parsed = parseDelimitedRecords(source, delimiter)
    if (parsed) {
      return {
        columns: parsed.columns,
        rows: parsed.rows.map((row) => parsed.columns.map((column) => row[column] ?? '')),
        format: delimiter === '\t' ? 'tsv' : 'csv',
      }
    }
  }

  const lines = source.split('\n')
  while (lines.length > 0 && !lines[lines.length - 1]!.trim()) lines.pop()
  return {
    columns: ['内容'],
    rows: lines.map((line) => [line]),
    format: 'lines',
  }
}
