/**
 * 服务端 Office 内容读写。
 *
 * `office.read_outline` / `office.find` 用同一套 OOXML 解析；`office.replace`
 * 只改指定段落或单元格的文本节点，保留其余 XML、样式和其他内容不动。
 * xlsx/pptx 已支持文本级局部编辑；结构插入和格式能力按类型分别限制，遇到未覆盖的边界必须明确报错。
 */
import { unzipSync, zipSync } from 'fflate'

export type OfficeElementKind = 'paragraph' | 'table'

export interface OfficeParagraph {
  id: string
  kind: 'paragraph'
  index: number
  text: string
  style: string
  headingLevel?: number
}

export interface OfficeTableCell {
  id: string
  text: string
}

export interface OfficeTableRow {
  index: number
  cells: OfficeTableCell[]
}

export interface OfficeTable {
  id: string
  kind: 'table'
  index: number
  rows: number
  columns: number
  preview: OfficeTableRow[]
  /** 仅内部查找时填充；`office.read_outline` 不返回整张表，避免大文档输出膨胀。 */
  rowsData?: OfficeTableRow[]
}

export type OfficeElement = OfficeParagraph | OfficeTable

export interface OfficeOutline {
  fileName: string
  elementCount: number
  elements: OfficeElement[]
  truncated: boolean
}

export interface OfficeRunFormat {
  bold: boolean
  italic: boolean
  underline?: string
  color?: string
  fontSize?: number
  fontFamily?: string
  style?: string
}

export interface OfficeReadRangeRun {
  text: string
  start: number
  end: number
  format: OfficeRunFormat
}

export interface OfficeParagraphFormat {
  style: string
  align?: string
  lineSpacing?: number
  spaceBefore?: number
  spaceAfter?: number
}

export interface OfficeReadRangeTable {
  id: string
  rows: number
  columns: number
  data: OfficeTableRow[]
}

export interface OfficeReadRangeOptions {
  /** `pN`、`tN`、`tN-rN`、`tN-cN` 或 `tN-rN-cN`。 */
  elementId: string
  /** 目标元素完整文本内的起始偏移，默认 0；仅支持段落和单元格。 */
  start?: number
  /** 目标元素完整文本内的结束偏移，默认文本长度；仅支持段落和单元格。 */
  end?: number
}

export interface OfficeReadRangeResult {
  kind: 'docx'
  elementId: string
  elementKind: 'paragraph' | 'table' | 'table_row' | 'table_column' | 'table_cell'
  text: string
  start: number
  end: number
  totalLength: number
  runs: OfficeReadRangeRun[]
  paragraph?: OfficeParagraphFormat
  table?: OfficeReadRangeTable
}

export interface OfficeTextMatch {
  elementId: string
  elementIndex: number
  kind: 'paragraph' | 'table_cell'
  text: string
  start: number
  end: number
  context: string
  row?: number
  column?: number
}

export interface OfficeReplaceOptions {
  /** `pN` 或 `tN-rN-cN`，来自 office.read_outline / office.find。 */
  elementId: string
  /** 省略时替换目标元素的整段文本；提供时必须与文本完全一致。 */
  oldText?: string
  newText: string
  /** 第几次命中，1 起；0 表示替换全部，默认 1。 */
  occurrence?: number
  /** 为 true 时把删除文本写入 w:del、新文本写入 w:ins，保留修订标记。 */
  trackChanges?: boolean
  /** 修订作者，默认 EAB Agent。 */
  author?: string
}

export interface OfficeReplaceResult {
  buffer: Buffer
  elementId: string
  kind: 'paragraph' | 'table_cell'
  previousText: string
  nextText: string
  replacements: number
  /** 本次是否写入了 w:ins/w:del 修订。 */
  tracked?: boolean
}

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => XML_ENTITIES[name] ?? '')
}

/** 只保留 `<w:t>` 文本并按文档顺序拼接；换行/制表符单独映射。 */
function textOfXml(xml: string): string {
  const parts: string[] = []
  const tokenRe = /<w:(t|br|tab)\b[^>]*\/?>(?:([\s\S]*?)<\/w:\1>)?/gi
  let match: RegExpExecArray | null
  while ((match = tokenRe.exec(xml))) {
    if (match[1] === 'br') parts.push('\n')
    else if (match[1] === 'tab') parts.push('\t')
    else if (match[2]) parts.push(decodeXmlText(match[2]))
  }
  return parts.join('')
}

function styleOfParagraph(xml: string): { style: string; headingLevel?: number } {
  const styleMatch = /<w:pStyle\b[^>]*w:val="([^"]+)"/i.exec(xml)
  const raw = styleMatch?.[1] ?? ''
  const heading = /^Heading\s*(\d+)$/i.exec(raw)
  return {
    style: raw,
    ...(heading ? { headingLevel: Number.parseInt(heading[1], 10) } : {}),
  }
}

/** 找真正的 `<tag ...>`，避免 `<w:p` 误命中 `<w:pPr>`。 */
function findOpen(xml: string, tag: string, from: number): number {
  let pos = from
  const needle = `<${tag}`
  while (pos < xml.length) {
    const found = xml.indexOf(needle, pos)
    if (found < 0) return -1
    const after = xml.charAt(found + needle.length)
    if (after === '>' || after === '/' || /\s/.test(after)) return found
    pos = found + needle.length
  }
  return -1
}

/** 在指定起始位置找同名开闭标签的结束位置，支持嵌套。 */
function matchingClose(xml: string, start: number, tag: string): number {
  const close = `</${tag}>`
  let depth = 0
  let pos = start
  while (pos < xml.length) {
    const nextOpen = findOpen(xml, tag, pos)
    const nextClose = xml.indexOf(close, pos)
    if (nextClose < 0) return xml.length
    if (nextOpen >= 0 && nextOpen < nextClose) {
      depth += 1
      pos = nextOpen + tag.length + 1
      continue
    }
    depth -= 1
    if (depth === 0) return nextClose + close.length
    pos = nextClose + close.length
  }
  return xml.length
}

function tableOfXml(xml: string, index: number, includeRows: boolean): OfficeTable {
  const rows: string[] = []
  let pos = 0
  while (pos < xml.length) {
    const start = findOpen(xml, 'w:tr', pos)
    if (start < 0) break
    const end = matchingClose(xml, start, 'w:tr')
    rows.push(xml.slice(start, end))
    pos = end
  }
  const parsedRows: OfficeTableRow[] = rows.map((rowXml, rowIndex) => {
    const cells: OfficeTableCell[] = []
    let pos = 0
    while (pos < rowXml.length) {
      const start = findOpen(rowXml, 'w:tc', pos)
      if (start < 0) break
      const end = matchingClose(rowXml, start, 'w:tc')
      cells.push({
        id: `t${index + 1}-r${rowIndex + 1}-c${cells.length + 1}`,
        text: textOfXml(rowXml.slice(start, end)).trim(),
      })
      pos = end
    }
    return { index: rowIndex + 1, cells }
  })
  const columns = parsedRows.reduce((max, row) => Math.max(max, row.cells.length), 0)
  return {
    id: `t${index + 1}`,
    kind: 'table',
    index,
    rows: parsedRows.length,
    columns,
    preview: parsedRows.slice(0, 5),
    ...(includeRows ? { rowsData: parsedRows } : {}),
  }
}

function bodyElements(documentXml: string, includeTableRows: boolean): OfficeElement[] {
  const bodyStart = documentXml.indexOf('<w:body')
  if (bodyStart < 0) return []
  const bodyOpenEnd = documentXml.indexOf('>', bodyStart)
  if (bodyOpenEnd < 0) return []
  let pos = bodyOpenEnd + 1
  const elements: OfficeElement[] = []
  let paragraphIndex = 0
  let tableIndex = 0
  while (pos < documentXml.length) {
    const nextP = findOpen(documentXml, 'w:p', pos)
    const nextTable = findOpen(documentXml, 'w:tbl', pos)
    const nextBodyEnd = documentXml.indexOf('</w:body>', pos)
    const candidates = [nextP, nextTable, nextBodyEnd].filter((value) => value >= 0)
    if (candidates.length === 0) break
    const next = Math.min(...candidates)
    if (next === nextBodyEnd) break
    if (next === nextTable) {
      const end = matchingClose(documentXml, next, 'w:tbl')
      elements.push(tableOfXml(documentXml.slice(next, end), tableIndex, includeTableRows))
      tableIndex += 1
      pos = end
      continue
    }
    if (next === nextP) {
      const end = matchingClose(documentXml, next, 'w:p')
      const xml = documentXml.slice(next, end)
      const { style, headingLevel } = styleOfParagraph(xml)
      elements.push({
        id: `p${paragraphIndex + 1}`,
        kind: 'paragraph',
        index: paragraphIndex,
        text: textOfXml(xml).trim(),
        style,
        ...(headingLevel ? { headingLevel } : {}),
      })
      paragraphIndex += 1
      pos = end
      continue
    }
    break
  }
  return elements
}

export function readDocxOutline(
  buffer: Buffer,
  maxElements = 200,
  options: { includeTableRows?: boolean } = {},
): OfficeOutline {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(new Uint8Array(buffer))
  } catch {
    throw new Error('docx 文件不是有效的 Office Open XML 压缩包')
  }
  const documentXmlBytes = files['word/document.xml']
  if (!documentXmlBytes) throw new Error('docx 缺少 word/document.xml')
  const elements = bodyElements(new TextDecoder().decode(documentXmlBytes), options.includeTableRows === true)
  const limit = Math.max(1, Math.min(500, maxElements))
  return {
    fileName: '',
    elementCount: elements.length,
    elements: elements.slice(0, limit),
    truncated: elements.length > limit,
  }
}

export type OfficeRevisionKind = 'insert' | 'delete'

export interface OfficeRevision {
  id: string
  kind: OfficeRevisionKind
  author: string
  date: string
  text: string
  elementId: string
  elementKind: 'paragraph' | 'table_cell'
  elementIndex: number
  /** 在目标段落 XML 中按 w:t / w:delText 累计的字符偏移。 */
  start: number
  end: number
}

export interface OfficeRevisionAuthor {
  author: string
  count: number
  insertions: number
  deletions: number
}

export interface OfficeRevisionReport {
  revisionCount: number
  insertions: number
  deletions: number
  authors: OfficeRevisionAuthor[]
  revisions: OfficeRevision[]
  truncated: boolean
}

export interface OfficeTrackChangesResult {
  buffer: Buffer
  enabled: boolean
  changed: boolean
}

export interface OfficeRevisionApplyOptions {
  action: 'accept' | 'reject'
  revisionId?: string
  all?: boolean
}

export interface OfficeRevisionApplyResult {
  buffer: Buffer
  action: 'accept' | 'reject'
  processed: number
  revisionIds: string[]
  remaining: number
  trackChanges: boolean
}

interface RevisionParagraphSegment {
  elementId: string
  elementKind: 'paragraph' | 'table_cell'
  elementIndex: number
  xml: string
}

function paragraphSegmentsWithIds(documentXml: string): RevisionParagraphSegment[] {
  const result: RevisionParagraphSegment[] = []
  let paragraphIndex = 0
  let tableIndex = 0
  for (const child of bodyChildSegments(documentXml)) {
    if (child.kind === 'paragraph') {
      result.push({
        elementId: `p${paragraphIndex + 1}`,
        elementKind: 'paragraph',
        elementIndex: paragraphIndex,
        xml: child.segment.xml,
      })
      paragraphIndex += 1
      continue
    }
    const rowSegments: string[] = []
    let rowPos = 0
    while (rowPos < child.segment.xml.length) {
      const start = findOpen(child.segment.xml, 'w:tr', rowPos)
      if (start < 0) break
      const end = matchingClose(child.segment.xml, start, 'w:tr')
      rowSegments.push(child.segment.xml.slice(start, end))
      rowPos = end
    }
    rowSegments.forEach((rowXml, rowIndex) => {
      const cells: string[] = []
      let cellPos = 0
      while (cellPos < rowXml.length) {
        const start = findOpen(rowXml, 'w:tc', cellPos)
        if (start < 0) break
        const end = matchingClose(rowXml, start, 'w:tc')
        cells.push(rowXml.slice(start, end))
        cellPos = end
      }
      cells.forEach((cellXml, columnIndex) => {
        let cellParagraphIndex = 0
        let pos = 0
        while (pos < cellXml.length) {
          const start = findOpen(cellXml, 'w:p', pos)
          if (start < 0) break
          const end = matchingClose(cellXml, start, 'w:p')
          if (end <= start) break
          result.push({
            elementId: `t${tableIndex + 1}-r${rowIndex + 1}-c${columnIndex + 1}`,
            elementKind: 'table_cell',
            elementIndex: cellParagraphIndex,
            xml: cellXml.slice(start, end),
          })
          cellParagraphIndex += 1
          pos = end
        }
      })
    })
    tableIndex += 1
  }
  return result
}

function revisionText(xml: string): string {
  const parts: string[] = []
  const re = /<w:(t|delText)\b[^>]*\/?>(?:([\s\S]*?)<\/w:\1>)?/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(xml))) {
    if (match[2]) parts.push(decodeXmlText(match[2]))
  }
  return parts.join('')
}

function textOffsetAt(xml: string, position: number): number {
  let offset = 0
  const re = /<w:(t|delText)\b[^>]*\/?>(?:([\s\S]*?)<\/w:\1>)?/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(xml))) {
    if (match.index >= position) break
    if (match[2]) offset += decodeXmlText(match[2]).length
  }
  return offset
}

/**
 * 读取 docx 的修订标记。只识别 w:ins / w:del（含 w:delText），
 * 不猜测移动、格式变更等未覆盖的修订类型。
 */
export function readDocxRevisions(buffer: Buffer, maxRevisions = 200): OfficeRevisionReport {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(new Uint8Array(buffer))
  } catch {
    throw new Error('docx 文件不是有效的 Office Open XML 压缩包')
  }
  const documentBytes = files['word/document.xml']
  if (!documentBytes) throw new Error('docx 缺少 word/document.xml')
  const documentXml = new TextDecoder().decode(documentBytes)
  const revisions: OfficeRevision[] = []
  for (const segment of paragraphSegmentsWithIds(documentXml)) {
    let pos = 0
    while (pos < segment.xml.length) {
      const openRe = /<w:(ins|del)\b[^>]*>/gi
      openRe.lastIndex = pos
      const match = openRe.exec(segment.xml)
      if (!match) break
      const tag = `w:${match[1]}`
      const startAt = match.index
      const endAt = matchingClose(segment.xml, startAt, tag)
      const revisionXml = segment.xml.slice(startAt, endAt)
      const attrs = match[0].slice(0, match[0].lastIndexOf('>'))
      const text = revisionText(revisionXml)
      const start = textOffsetAt(segment.xml, startAt)
      revisions.push({
        id: xmlAttribute(attrs, 'w:id') || String(revisions.length + 1),
        kind: match[1].toLowerCase() === 'ins' ? 'insert' : 'delete',
        author: xmlAttribute(attrs, 'w:author') || '未知作者',
        date: xmlAttribute(attrs, 'w:date'),
        text,
        elementId: segment.elementId,
        elementKind: segment.elementKind,
        elementIndex: segment.elementIndex,
        start,
        end: start + text.length,
      })
      pos = Math.max(endAt, startAt + match[0].length)
    }
  }
  const insertions = revisions.filter((revision) => revision.kind === 'insert').length
  const deletions = revisions.length - insertions
  const authorMap = new Map<string, OfficeRevisionAuthor>()
  for (const revision of revisions) {
    const entry = authorMap.get(revision.author) ?? {
      author: revision.author,
      count: 0,
      insertions: 0,
      deletions: 0,
    }
    entry.count += 1
    if (revision.kind === 'insert') entry.insertions += 1
    else entry.deletions += 1
    authorMap.set(revision.author, entry)
  }
  const limit = Math.max(1, Math.min(500, maxRevisions))
  return {
    revisionCount: revisions.length,
    insertions,
    deletions,
    authors: [...authorMap.values()].sort((a, b) => b.count - a.count),
    revisions: revisions.slice(0, limit),
    truncated: revisions.length > limit,
  }
}

const SETTINGS_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings'
const SETTINGS_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml'

function readDocxFiles(buffer: Buffer): Record<string, Uint8Array> {
  try {
    return unzipSync(new Uint8Array(buffer))
  } catch {
    throw new Error('docx 文件不是有效的 Office Open XML 压缩包')
  }
}

function readDocumentXml(files: Record<string, Uint8Array>): string {
  const documentBytes = files['word/document.xml']
  if (!documentBytes) throw new Error('docx 缺少 word/document.xml')
  return new TextDecoder().decode(documentBytes)
}

function ensureSettingsPart(files: Record<string, Uint8Array>): string {
  const contentTypesPath = '[Content_Types].xml'
  let contentTypes = files[contentTypesPath]
    ? new TextDecoder().decode(files[contentTypesPath])
    : `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`
  if (!/<Types\b/i.test(contentTypes)) throw new Error('[Content_Types].xml 结构不完整')

  const relsPath = 'word/_rels/document.xml.rels'
  let rels = files[relsPath]
    ? new TextDecoder().decode(files[relsPath])
    : `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`
  if (!/<Relationships\b/i.test(rels)) throw new Error('word/_rels/document.xml.rels 结构不完整')

  let settingsPath = ''
  const relationships = [...rels.matchAll(/<Relationship\b([^>]*?)\/?>/gi)]
  for (const relationship of relationships) {
    if (xmlAttribute(relationship[1], 'Type') !== SETTINGS_REL_TYPE) continue
    settingsPath = docxPartPath(xmlAttribute(relationship[1], 'Target'))
    break
  }
  if (!settingsPath) {
    let target = 'settings.xml'
    let suffix = 0
    while (files[`word/${target}`]) {
      suffix += 1
      target = `settings${suffix}.xml`
    }
    const ids = new Set(relationships.map((relationship) => xmlAttribute(relationship[1], 'Id')).filter(Boolean))
    let id = 'rIdEabSettings'
    let idSuffix = 0
    while (ids.has(id)) {
      idSuffix += 1
      id = `rIdEabSettings${idSuffix}`
    }
    rels = rels.replace(
      /<\/Relationships>/,
      `<Relationship Id="${id}" Type="${SETTINGS_REL_TYPE}" Target="${target}"/></Relationships>`,
    )
    files[relsPath] = new TextEncoder().encode(rels)
    settingsPath = `word/${target}`
  }
  if (!files[settingsPath]) {
    files[settingsPath] = new TextEncoder().encode(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="${DOCX_MAIN_NS}"></w:settings>`,
    )
  }
  const partName = `/${settingsPath}`
  if (!new RegExp(`<Override\\b[^>]*PartName="${partName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'i').test(contentTypes)) {
    if (/<\/Types>/.test(contentTypes)) {
      contentTypes = contentTypes.replace(
        /<\/Types>/,
        `<Override PartName="${partName}" ContentType="${SETTINGS_CONTENT_TYPE}"/></Types>`,
      )
    } else {
      throw new Error('[Content_Types].xml 缺少结束标签')
    }
    files[contentTypesPath] = new TextEncoder().encode(contentTypes)
  }
  return settingsPath
}

export function readDocxTrackChanges(buffer: Buffer): boolean {
  const files = readDocxFiles(buffer)
  const settingsBytes = files['word/settings.xml']
  if (!settingsBytes) return false
  return /<w:trackChanges\b/i.test(new TextDecoder().decode(settingsBytes))
}

export function setDocxTrackChanges(buffer: Buffer, enabled: boolean): OfficeTrackChangesResult {
  const files = readDocxFiles(buffer)
  const settingsPath = ensureSettingsPart(files)
  let settingsXml = new TextDecoder().decode(files[settingsPath])
  const currentlyEnabled = /<w:trackChanges\b/i.test(settingsXml)
  if (currentlyEnabled === enabled) {
    return { buffer, enabled, changed: false }
  }
  if (enabled) {
    if (/<\/w:settings>/.test(settingsXml)) {
      settingsXml = settingsXml.replace(/<\/w:settings>/, '<w:trackChanges/></w:settings>')
    } else if (/<w:settings\b([^>]*)\/>/.test(settingsXml)) {
      settingsXml = settingsXml.replace(/<w:settings\b([^>]*)\/>/, '<w:settings$1><w:trackChanges/></w:settings>')
    } else {
      throw new Error('settings.xml 缺少结束标签')
    }
  } else {
    settingsXml = settingsXml
      .replace(/<w:trackChanges\b[^>]*\/>/gi, '')
      .replace(/<w:trackChanges\b[^>]*>[\s\S]*?<\/w:trackChanges>/gi, '')
  }
  files[settingsPath] = new TextEncoder().encode(settingsXml)
  return { buffer: Buffer.from(zipSync(files, { level: 6 })), enabled, changed: true }
}

function applyRevisionTags(
  xml: string,
  tag: 'w:ins' | 'w:del',
  action: 'accept' | 'reject',
  revisionId?: string,
): { xml: string; count: number; ids: string[] } {
  let output = ''
  let last = 0
  let count = 0
  const ids: string[] = []
  while (last < xml.length) {
    const openRe = new RegExp(`<${tag}\\b[^>]*>`, 'gi')
    openRe.lastIndex = last
    const match = openRe.exec(xml)
    if (!match) break
    const startAt = match.index
    const endAt = matchingClose(xml, startAt, tag)
    const attrs = match[0].slice(0, match[0].lastIndexOf('>'))
    const id = xmlAttribute(attrs, 'w:id')
    if (revisionId && id !== revisionId) {
      output += xml.slice(last, endAt)
      last = endAt
      continue
    }
    const innerStart = match[0].length + startAt
    const inner = xml.slice(innerStart, endAt - `</${tag}>`.length)
    output += xml.slice(last, startAt)
    if (tag === 'w:ins') {
      output += action === 'accept' ? inner : ''
    } else {
      output += action === 'accept'
        ? ''
        : inner
            .replace(/<w:delText\b/gi, '<w:t')
            .replace(/<\/w:delText>/gi, '</w:t>')
            .replace(/<w:delInstrText\b/gi, '<w:instrText')
            .replace(/<\/w:delInstrText>/gi, '</w:instrText>')
    }
    count += 1
    if (id) ids.push(id)
    last = endAt
  }
  output += xml.slice(last)
  return { xml: output, count, ids }
}

export function applyDocxRevisions(buffer: Buffer, options: OfficeRevisionApplyOptions): OfficeRevisionApplyResult {
  if (!options.revisionId && !options.all) {
    throw new Error('请指定 revisionId，或 all=true 处理全部修订')
  }
  const files = readDocxFiles(buffer)
  let documentXml = readDocumentXml(files)
  let processed = 0
  const revisionIds: string[] = []
  for (const tag of ['w:ins', 'w:del'] as const) {
    const applied = applyRevisionTags(documentXml, tag, options.action, options.revisionId)
    documentXml = applied.xml
    processed += applied.count
    revisionIds.push(...applied.ids)
  }
  if (options.revisionId && processed === 0) {
    throw new Error(`没有找到修订 id=${options.revisionId}`)
  }
  files['word/document.xml'] = new TextEncoder().encode(documentXml)
  const nextBuffer = Buffer.from(zipSync(files, { level: 6 }))
  return {
    buffer: nextBuffer,
    action: options.action,
    processed,
    revisionIds,
    remaining: readDocxRevisions(nextBuffer).revisionCount,
    trackChanges: readDocxTrackChanges(nextBuffer),
  }
}

/** 段落和表格单元格通用查找；表格需要先以 includeTableRows 读取。 */
export function findInOutline(
  outline: OfficeOutline,
  query: string,
  options: { regex?: boolean; limit?: number } = {},
): OfficeTextMatch[] {
  const limit = Math.max(1, Math.min(100, options.limit ?? 20))
  const matches: OfficeTextMatch[] = []
  let matcher: RegExp
  if (options.regex) {
    try {
      matcher = new RegExp(query, 'gi')
    } catch {
      throw new Error(`正则表达式无效: ${query}`)
    }
  } else {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    matcher = new RegExp(escaped, 'gi')
  }
  const pushMatches = (
    text: string,
    base: { elementId: string; elementIndex: number; kind: 'paragraph' | 'table_cell'; row?: number; column?: number },
  ) => {
    matcher.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = matcher.exec(text))) {
      const start = match.index
      const end = start + match[0].length
      matches.push({
        ...base,
        text,
        start,
        end,
        context: text.slice(Math.max(0, start - 80), Math.min(text.length, end + 80)),
      })
      if (matches.length >= limit) return true
      if (match[0].length === 0) matcher.lastIndex += 1
    }
    return false
  }
  for (const element of outline.elements) {
    if (element.kind === 'paragraph') {
      if (pushMatches(element.text, { elementId: element.id, elementIndex: element.index, kind: 'paragraph' })) {
        return matches
      }
      continue
    }
    for (const row of element.rowsData ?? []) {
      for (const cell of row.cells) {
        if (
          pushMatches(cell.text, {
            elementId: cell.id,
            elementIndex: element.index,
            kind: 'table_cell',
            row: row.index,
            column: row.cells.indexOf(cell) + 1,
          })
        ) {
          return matches
        }
      }
    }
  }
  return matches
}

interface XmlSegment {
  start: number
  end: number
  xml: string
}

function bodyChildSegments(documentXml: string): Array<{ kind: 'paragraph' | 'table'; segment: XmlSegment }> {
  const result: Array<{ kind: 'paragraph' | 'table'; segment: XmlSegment }> = []
  const bodyStart = documentXml.indexOf('<w:body')
  if (bodyStart < 0) return result
  const bodyOpenEnd = documentXml.indexOf('>', bodyStart)
  if (bodyOpenEnd < 0) return result
  let pos = bodyOpenEnd + 1
  while (pos < documentXml.length) {
    const nextP = findOpen(documentXml, 'w:p', pos)
    const nextTable = findOpen(documentXml, 'w:tbl', pos)
    const nextBodyEnd = documentXml.indexOf('</w:body>', pos)
    const candidates = [nextP, nextTable, nextBodyEnd].filter((value) => value >= 0)
    if (candidates.length === 0) break
    const next = Math.min(...candidates)
    if (next === nextBodyEnd) break
    if (next === nextTable) {
      const end = matchingClose(documentXml, next, 'w:tbl')
      result.push({ kind: 'table', segment: { start: next, end, xml: documentXml.slice(next, end) } })
      pos = end
      continue
    }
    if (next === nextP) {
      const end = matchingClose(documentXml, next, 'w:p')
      result.push({ kind: 'paragraph', segment: { start: next, end, xml: documentXml.slice(next, end) } })
      pos = end
      continue
    }
    break
  }
  return result
}

function nthNestedSegment(xml: string, tag: string, ordinal: number): XmlSegment | null {
  if (ordinal < 1) return null
  let pos = 0
  let index = 0
  while (pos < xml.length) {
    const start = findOpen(xml, tag, pos)
    if (start < 0) return null
    const end = matchingClose(xml, start, tag)
    index += 1
    if (index === ordinal) return { start, end, xml: xml.slice(start, end) }
    pos = end
  }
  return null
}

function locateElementSegment(documentXml: string, elementId: string): { segment: XmlSegment; kind: 'paragraph' | 'table_cell' } {
  const paragraph = /^p(\d+)$/.exec(elementId)
  if (paragraph) {
    const ordinal = Number.parseInt(paragraph[1], 10)
    const segment = bodyChildSegments(documentXml).filter((item) => item.kind === 'paragraph')[ordinal - 1]?.segment
    if (!segment) throw new Error(`文档中没有段落 ${elementId}`)
    return { segment, kind: 'paragraph' }
  }
  const cell = /^t(\d+)-r(\d+)-c(\d+)$/.exec(elementId)
  if (cell) {
    const tableOrdinal = Number.parseInt(cell[1], 10)
    const rowOrdinal = Number.parseInt(cell[2], 10)
    const columnOrdinal = Number.parseInt(cell[3], 10)
    const table = bodyChildSegments(documentXml).filter((item) => item.kind === 'table')[tableOrdinal - 1]?.segment
    if (!table) throw new Error(`文档中没有表格 t${tableOrdinal}`)
    const row = nthNestedSegment(table.xml, 'w:tr', rowOrdinal)
    if (!row) throw new Error(`表格 t${tableOrdinal} 没有第 ${rowOrdinal} 行`)
    const target = nthNestedSegment(row.xml, 'w:tc', columnOrdinal)
    if (!target) throw new Error(`表格 t${tableOrdinal} 第 ${rowOrdinal} 行没有第 ${columnOrdinal} 列`)
    const start = table.start + row.start + target.start
    return { segment: { start, end: start + target.xml.length, xml: target.xml }, kind: 'table_cell' }
  }
  throw new Error(`无法识别的元素 ID: ${elementId}`)
}

interface TextNode {
  start: number
  end: number
  attrs: string
  selfClosing: boolean
  text: string
  textStart: number
  textEnd: number
}

function encodeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function textNodesOf(xml: string): TextNode[] {
  const nodes: TextNode[] = []
  let pos = 0
  let textOffset = 0
  while (pos < xml.length) {
    const start = findOpen(xml, 'w:t', pos)
    if (start < 0) break
    const openEnd = xml.indexOf('>', start)
    if (openEnd < 0) break
    const selfClosing = xml.slice(start, openEnd + 1).trimEnd().endsWith('/>')
    const closeStart = selfClosing ? openEnd + 1 : xml.indexOf('</w:t>', openEnd + 1)
    if (closeStart < 0) break
    const end = selfClosing ? openEnd + 1 : closeStart + '</w:t>'.length
    const attrs = xml.slice(start + '<w:t'.length, openEnd).replace(/\/$/, '')
    const text = selfClosing ? '' : decodeXmlText(xml.slice(openEnd + 1, closeStart))
    nodes.push({
      start,
      end,
      attrs,
      selfClosing,
      text,
      textStart: textOffset,
      textEnd: textOffset + text.length,
    })
    textOffset += text.length
    pos = end
  }
  return nodes
}

function serializeTextNode(node: TextNode, text: string): string {
  let attrs = node.attrs
  if (text && (/^\s/.test(text) || /\s$/.test(text)) && !/xml:space=/.test(attrs)) {
    attrs += ' xml:space="preserve"'
  }
  if (!text && node.selfClosing) return `<w:t${attrs}/>`
  return `<w:t${attrs}>${encodeXmlText(text)}</w:t>`
}

function applyReplacement(nodes: TextNode[], start: number, end: number, replacement: string): boolean {
  if (nodes.length === 0) return false
  if (start === end) {
    let index = nodes.findIndex((node) => start >= node.textStart && start <= node.textEnd)
    if (index < 0) index = nodes.length - 1
    const node = nodes[index]
    const local = Math.max(0, Math.min(node.text.length, start - node.textStart))
    node.text = node.text.slice(0, local) + replacement + node.text.slice(local)
    return true
  }
  const first = nodes.findIndex((node) => end > node.textStart && start < node.textEnd)
  if (first < 0) return false
  let last = nodes.findIndex((node) => end > node.textStart && end <= node.textEnd)
  if (last < first) last = first
  const firstNode = nodes[first]
  const lastNode = nodes[last]
  if (first === last) {
    const localStart = Math.max(0, Math.min(firstNode.text.length, start - firstNode.textStart))
    const localEnd = Math.max(localStart, Math.min(firstNode.text.length, end - firstNode.textStart))
    firstNode.text = firstNode.text.slice(0, localStart) + replacement + firstNode.text.slice(localEnd)
    return true
  }
  const localStart = Math.max(0, Math.min(firstNode.text.length, start - firstNode.textStart))
  const localEnd = Math.max(0, Math.min(lastNode.text.length, end - lastNode.textStart))
  firstNode.text = firstNode.text.slice(0, localStart) + replacement
  for (let index = first + 1; index < last; index += 1) nodes[index].text = ''
  lastNode.text = lastNode.text.slice(localEnd)
  return true
}

function insertTextRun(xml: string, text: string, kind: 'paragraph' | 'table_cell'): string {
  if (!text) return xml
  const closeTag = kind === 'paragraph' ? '</w:p>' : '</w:tc>'
  const at = xml.lastIndexOf(closeTag)
  if (at < 0) return xml
  const preserve = /^\s/.test(text) || /\s$/.test(text) ? ' xml:space="preserve"' : ''
  return `${xml.slice(0, at)}<w:r><w:t${preserve}>${encodeXmlText(text)}</w:t></w:r>${xml.slice(at)}`
}

interface RunSegment {
  start: number
  end: number
  xml: string
  attrs: string
  rPr: string
  text: string
  textStart: number
  textEnd: number
}

function runSegmentsOf(xml: string): RunSegment[] {
  const result: RunSegment[] = []
  let pos = 0
  let textOffset = 0
  while (pos < xml.length) {
    const start = findOpen(xml, 'w:r', pos)
    if (start < 0) break
    const openEnd = xml.indexOf('>', start)
    if (openEnd < 0) break
    if (xml.slice(start, openEnd + 1).trimEnd().endsWith('/>')) {
      pos = openEnd + 1
      continue
    }
    const end = matchingClose(xml, start, 'w:r')
    const runXml = xml.slice(start, end)
    const attrs = runXml.slice('<w:r'.length, openEnd - start).replace(/\/$/, '')
    const rPrMatch = /<w:rPr\b[^>]*>[\s\S]*?<\/w:rPr>|<w:rPr\b[^>]*\/>/.exec(runXml)
    const text = textOfXml(runXml)
    result.push({
      start,
      end,
      xml: runXml,
      attrs,
      rPr: rPrMatch?.[0] ?? '',
      text,
      textStart: textOffset,
      textEnd: textOffset + text.length,
    })
    textOffset += text.length
    pos = end
  }
  return result
}

function nextRevisionId(xml: string): number {
  let max = 0
  const re = /<w:(?:ins|del)\b[^>]*w:id="(\d+)"/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(xml))) max = Math.max(max, Number.parseInt(match[1], 10))
  return max + 1
}

function trackedRunXml(
  kind: 'insert' | 'delete',
  id: number,
  author: string,
  date: string,
  text: string,
  rPr: string,
): string {
  if (!text) return ''
  const tag = kind === 'insert' ? 'w:ins' : 'w:del'
  const textTag = kind === 'insert' ? 'w:t' : 'w:delText'
  const preserve = /^\s/.test(text) || /\s$/.test(text) ? ' xml:space="preserve"' : ''
  return (
    `<${tag} w:id="${id}" w:author="${encodeXmlText(author)}" w:date="${date}">` +
    `<w:r>${rPr}<${textTag}${preserve}>${encodeXmlText(text)}</${textTag}></w:r>` +
    `</${tag}>`
  )
}

function runXmlWithText(run: RunSegment, text: string): string {
  if (!text) return ''
  const preserve = /^\s/.test(text) || /\s$/.test(text) ? ' xml:space="preserve"' : ''
  return `<w:r${run.attrs}>${run.rPr}<w:t${preserve}>${encodeXmlText(text)}</w:t></w:r>`
}

function trackedReplaceInSegment(
  xml: string,
  start: number,
  end: number,
  newText: string,
  author: string,
  date: string,
): { xml: string; revisions: number } {
  if (/<w:(ins|del)\b/i.test(xml)) {
    throw new Error('目标元素已包含修订标记；请先接受或拒绝现有修订，再写入新的修订')
  }
  const runs = runSegmentsOf(xml)
  if (runs.length === 0) {
    if (start !== 0 || end !== 0) throw new Error('目标元素的文本偏移异常')
    const id = nextRevisionId(xml)
    const ins = trackedRunXml('insert', id, author, date, newText, '')
    if (!ins) return { xml, revisions: 0 }
    const paragraphClose = xml.lastIndexOf('</w:p>')
    if (paragraphClose >= 0) {
      return { xml: `${xml.slice(0, paragraphClose)}${ins}${xml.slice(paragraphClose)}`, revisions: 1 }
    }
    const cellClose = xml.lastIndexOf('</w:tc>')
    if (cellClose < 0) throw new Error('目标元素缺少段落结束标签')
    return {
      xml: `${xml.slice(0, cellClose)}<w:p>${ins}</w:p>${xml.slice(cellClose)}`,
      revisions: 1,
    }
  }
  if (start < 0 || end < start || end > (runs[runs.length - 1]?.textEnd ?? 0)) {
    throw new Error('目标元素的文本偏移异常')
  }

  const revisionStart = nextRevisionId(xml)
  let revisionId = revisionStart
  let revisionCount = 0
  let out = ''
  let cursor = 0
  let inserted = false
  const insertNew = (rPr: string) => {
    const ins = trackedRunXml('insert', revisionId, author, date, newText, rPr)
    if (ins) {
      revisionId += 1
      revisionCount += 1
      out += ins
      inserted = true
    }
  }

  if (start === end) {
    const index = runs.findIndex((run) => start >= run.textStart && start <= run.textEnd)
    const at = index >= 0 ? index : runs.length
    for (let i = 0; i < runs.length; i += 1) {
      const run = runs[i]
      out += xml.slice(cursor, run.start)
      cursor = run.start
      if (!inserted && (i === at || (at === runs.length && i === runs.length - 1))) {
        const before = start - run.textStart
        const prefix = before > 0 ? run.text.slice(0, before) : ''
        const suffix = before > 0 ? run.text.slice(before) : run.text
        out += runXmlWithText(run, prefix)
        insertNew(run.rPr)
        out += runXmlWithText(run, suffix)
        cursor = run.end
        continue
      }
      out += xml.slice(run.start, run.end)
      cursor = run.end
    }
    out += xml.slice(cursor)
    if (!inserted) throw new Error('插入位置没有落到有效文本 run 上')
    return { xml: out, revisions: revisionCount }
  }

  const firstIndex = runs.findIndex((run) => end > run.textStart && start < run.textEnd)
  if (firstIndex < 0) throw new Error('目标元素的文本偏移异常')
  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i]
    out += xml.slice(cursor, run.start)
    cursor = run.start
    const overlapStart = Math.max(start, run.textStart)
    const overlapEnd = Math.min(end, run.textEnd)
    if (overlapStart < overlapEnd) {
      if (/<w:(br|tab)\b/i.test(run.xml)) {
        throw new Error('目标范围包含换行或制表符，暂不支持写入修订')
      }
      const localStart = overlapStart - run.textStart
      const localEnd = overlapEnd - run.textStart
      const prefix = run.text.slice(0, localStart)
      const removed = run.text.slice(localStart, localEnd)
      const suffix = run.text.slice(localEnd)
      out += runXmlWithText(run, prefix)
      if (removed) {
        out += trackedRunXml('delete', revisionId, author, date, removed, run.rPr)
        revisionId += 1
        revisionCount += 1
      }
      if (i === firstIndex) insertNew(run.rPr)
      out += runXmlWithText(run, suffix)
    } else {
      if (!inserted && i > firstIndex) insertNew(runs[firstIndex]?.rPr ?? '')
      out += xml.slice(run.start, run.end)
    }
    cursor = run.end
  }
  out += xml.slice(cursor)
  if (!inserted) insertNew(runs[firstIndex]?.rPr ?? '')
  return { xml: out, revisions: revisionCount }
}

export interface OfficeInsertOptions {
  elementId: string
  position?: 'before' | 'after'
  text: string
}

export interface OfficeInsertResult {
  buffer: Buffer
  elementId: string
  kind: 'paragraph' | 'table' | 'table_cell'
  position: 'before' | 'after'
  insertedText: string
}

function runsXmlForText(text: string): string {
  const paragraphs = text.replace(/\r\n?/g, '\n').split('\n')
  return paragraphs
    .map((line, lineIndex) => {
      const parts = line.split('\t')
      const runs = parts
        .map((part) => {
          if (!part) return ''
          const preserve = /^\s/.test(part) || /\s$/.test(part) ? ' xml:space="preserve"' : ''
          return `<w:r><w:t${preserve}>${encodeXmlText(part)}</w:t></w:r>`
        })
        .join('<w:r><w:tab/></w:r>')
      return `${lineIndex > 0 ? '<w:r><w:br/></w:r>' : ''}${runs}`
    })
    .join('')
}

function locateInsertTarget(
  documentXml: string,
  elementId: string,
): { segment: XmlSegment; kind: 'paragraph' | 'table' | 'table_cell' } {
  const tableOnly = /^t(\d+)$/.exec(elementId)
  if (tableOnly) {
    const ordinal = Number.parseInt(tableOnly[1], 10)
    const segment = bodyChildSegments(documentXml).filter((item) => item.kind === 'table')[ordinal - 1]?.segment
    if (!segment) throw new Error(`文档中没有表格 ${elementId}`)
    return { segment, kind: 'table' }
  }
  const target = locateElementSegment(documentXml, elementId)
  return { segment: target.segment, kind: target.kind === 'table_cell' ? 'table_cell' : 'paragraph' }
}

function cellInsertOffset(cellXml: string, position: 'before' | 'after'): number {
  if (position === 'before') {
    const cellOpenEnd = cellXml.indexOf('>')
    if (cellOpenEnd < 0) return 0
    const tcPr = findOpen(cellXml, 'w:tcPr', cellOpenEnd + 1)
    return tcPr >= 0 ? matchingClose(cellXml, tcPr, 'w:tcPr') : cellOpenEnd + 1
  }
  const close = cellXml.lastIndexOf('</w:tc>')
  return close >= 0 ? close : cellXml.length
}

function firstParagraphInCell(cellXml: string): string | undefined {
  const open = findOpen(cellXml, 'w:p', 0)
  if (open < 0) return undefined
  return cellXml.slice(open, matchingClose(cellXml, open, 'w:p'))
}

function paragraphXmlForInsert(text: string, sourceXml?: string): string {
  const pPr = sourceXml?.match(/<w:pPr(?:\s[^>]*)?>[\s\S]*?<\/w:pPr>/)?.[0] ?? ''
  return `<w:p>${pPr}${runsXmlForText(text)}</w:p>`
}

export function insertDocxText(buffer: Buffer, options: OfficeInsertOptions): OfficeInsertResult {
  if (!options.text.trim()) throw new Error('text 不能为空')
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(new Uint8Array(buffer))
  } catch {
    throw new Error('docx 文件不是有效的 Office Open XML 压缩包')
  }
  const documentBytes = files['word/document.xml']
  if (!documentBytes) throw new Error('docx 缺少 word/document.xml')
  const documentXml = new TextDecoder().decode(documentBytes)
  const target = locateInsertTarget(documentXml, options.elementId)
  const targetKind = target.kind
  const position = options.position ?? 'after'
  const sourceXml =
    targetKind === 'paragraph'
      ? target.segment.xml
      : targetKind === 'table_cell'
        ? firstParagraphInCell(target.segment.xml)
        : undefined
  const paragraph = paragraphXmlForInsert(options.text, sourceXml)
  const localOffset =
    targetKind === 'table_cell'
      ? cellInsertOffset(target.segment.xml, position)
      : position === 'before'
        ? 0
        : target.segment.xml.length
  const at =
    targetKind === 'table_cell' ? target.segment.start + localOffset : position === 'before' ? target.segment.start : target.segment.end
  const nextDocumentXml = documentXml.slice(0, at) + paragraph + documentXml.slice(at)
  files['word/document.xml'] = new TextEncoder().encode(nextDocumentXml)
  return {
    buffer: Buffer.from(zipSync(files, { level: 6 })),
    elementId: options.elementId,
    kind: targetKind,
    position,
    insertedText: options.text,
  }
}

export interface OfficeDocxTableInsertOptions {
  /** `tN-rN` 插入行，或 `tN-cN` 插入列。 */
  elementId: string
  position?: 'before' | 'after'
  /** 行用制表符分隔多列；列用换行分隔各行值。 */
  text: string
}

export interface OfficeDocxTableInsertResult {
  buffer: Buffer
  elementId: string
  kind: 'table_row' | 'table_column'
  position: 'before' | 'after'
  insertedValues: string[]
}

function docxCellXmlWithText(cellXml: string, text: string): string {
  const cellOpenEnd = cellXml.indexOf('>')
  const tcPrStart = findOpen(cellXml, 'w:tcPr', Math.max(0, cellOpenEnd + 1))
  let tcPr = ''
  if (tcPrStart >= 0) {
    const openEnd = cellXml.indexOf('>', tcPrStart)
    const selfClosing = openEnd >= 0 && cellXml.slice(tcPrStart, openEnd + 1).trimEnd().endsWith('/>')
    tcPr = selfClosing ? cellXml.slice(tcPrStart, openEnd + 1) : cellXml.slice(tcPrStart, matchingClose(cellXml, tcPrStart, 'w:tcPr'))
  }
  const paragraph = paragraphXmlForInsert(text, firstParagraphInCell(cellXml))
  return `<w:tc>${tcPr}${paragraph}</w:tc>`
}

function docxRowXmlWithValues(rowXml: string, values: string[]): string {
  const rowOpenEnd = rowXml.indexOf('>')
  if (rowOpenEnd < 0) throw new Error('表格行 XML 不完整')
  const rowAttrs = rowXml.slice('<w:tr'.length, rowOpenEnd)
  const trPrStart = findOpen(rowXml, 'w:trPr', rowOpenEnd + 1)
  let trPr = ''
  if (trPrStart >= 0) {
    const openEnd = rowXml.indexOf('>', trPrStart)
    const selfClosing = openEnd >= 0 && rowXml.slice(trPrStart, openEnd + 1).trimEnd().endsWith('/>')
    trPr = selfClosing ? rowXml.slice(trPrStart, openEnd + 1) : rowXml.slice(trPrStart, matchingClose(rowXml, trPrStart, 'w:trPr'))
  }
  const cells: XmlSegment[] = []
  let pos = rowOpenEnd + 1
  while (pos < rowXml.length) {
    const start = findOpen(rowXml, 'w:tc', pos)
    if (start < 0) break
    const end = matchingClose(rowXml, start, 'w:tc')
    cells.push({ start, end, xml: rowXml.slice(start, end) })
    pos = end
  }
  if (cells.length === 0) throw new Error('表格行没有单元格')
  if (cells.some((cell) => /<w:(vMerge|hMerge)\b/i.test(cell.xml))) {
    throw new Error('目标行含纵向/旧式横向合并，暂不支持插入行；请先拆分合并单元格')
  }
  if (values.length > cells.length) {
    throw new Error(`新行有 ${values.length} 个值，但目标行只有 ${cells.length} 列`)
  }
  const nextCells = cells
    .map((cell, index) => docxCellXmlWithText(cell.xml, values[index] ?? ''))
    .join('')
  return `<w:tr${rowAttrs}>${trPr}${nextCells}</w:tr>`
}

function tableGridColumnsOf(tableXml: string): XmlSegment[] {
  const gridStart = findOpen(tableXml, 'w:tblGrid', 0)
  if (gridStart < 0) throw new Error('表格缺少 w:tblGrid')
  const gridEnd = matchingClose(tableXml, gridStart, 'w:tblGrid')
  const gridCols: XmlSegment[] = []
  let gridPos = gridStart + '<w:tblGrid'.length
  while (gridPos < gridEnd) {
    const start = findOpen(tableXml, 'w:gridCol', gridPos)
    if (start < 0) break
    const openEnd = tableXml.indexOf('>', start)
    if (openEnd < 0) break
    const selfClosing = tableXml.slice(start, openEnd + 1).trimEnd().endsWith('/>')
    const end = selfClosing ? openEnd + 1 : matchingClose(tableXml, start, 'w:gridCol')
    gridCols.push({ start, end, xml: tableXml.slice(start, end) })
    gridPos = end
    if (!selfClosing && end <= openEnd) break
  }
  if (gridCols.length === 0) throw new Error('表格缺少 w:gridCol')
  return gridCols
}

type TableMergeMode = 'restart' | 'continue' | null

interface TableCellLayout {
  cell: XmlSegment
  startColumn: number
  endColumn: number
  span: number
  vMerge: TableMergeMode
  hMerge: TableMergeMode
}

interface TableRowLayout {
  row: XmlSegment
  cells: TableCellLayout[]
}

function gridSpanOfCell(cellXml: string): number {
  const match = /<w:gridSpan\b[^>]*w:val="(\d+)"/i.exec(cellXml)
  if (!match) return 1
  const span = Number.parseInt(match[1], 10)
  if (!Number.isFinite(span) || span < 1) throw new Error('表格单元格的 gridSpan 无效')
  return span
}

function mergeModeOf(xml: string, tag: 'w:vMerge' | 'w:hMerge'): TableMergeMode {
  const start = findOpen(xml, tag, 0)
  if (start < 0) return null
  const openEnd = xml.indexOf('>', start)
  const openTag = xml.slice(start, openEnd + 1)
  const value = /w:val="([^"]+)"/i.exec(openTag)?.[1]
  return value?.toLowerCase() === 'restart' ? 'restart' : 'continue'
}

function tableRowLayoutsOf(tableXml: string, gridColumnCount: number): TableRowLayout[] {
  const rows = tableRowsOf(tableXml)
  if (rows.length === 0) throw new Error('表格没有数据行')
  return rows.map((row, rowIndex) => {
    const cells = tableCellsOfRow(tableXml, row).map((cell) => {
      const span = gridSpanOfCell(cell.xml)
      return {
        cell,
        startColumn: 1,
        endColumn: 1,
        span,
        vMerge: mergeModeOf(cell.xml, 'w:vMerge'),
        hMerge: mergeModeOf(cell.xml, 'w:hMerge'),
      }
    })
    let column = 1
    for (const cell of cells) {
      cell.startColumn = column
      cell.endColumn = column + cell.span - 1
      if (cell.endColumn > gridColumnCount) {
        throw new Error(`表格第 ${rowIndex + 1} 行单元格跨越了 ${gridColumnCount} 列网格`)
      }
      column = cell.endColumn + 1
    }
    if (column !== gridColumnCount + 1) {
      throw new Error(`表格第 ${rowIndex + 1} 行覆盖 ${column - 1} 列，与 ${gridColumnCount} 列网格不一致`)
    }
    return { row, cells }
  })
}

function removeXmlElement(xml: string, tag: string): string {
  const start = findOpen(xml, tag, 0)
  if (start < 0) return xml
  const openEnd = xml.indexOf('>', start)
  if (openEnd < 0) return xml
  const selfClosing = xml.slice(start, openEnd + 1).trimEnd().endsWith('/>')
  const end = selfClosing ? openEnd + 1 : matchingClose(xml, start, tag)
  return xml.slice(0, start) + xml.slice(end)
}

function upsertTcPrChild(cellXml: string, tag: string, childXml: string): string {
  const existing = findOpen(cellXml, tag, 0)
  if (existing >= 0) {
    const openEnd = cellXml.indexOf('>', existing)
    const selfClosing = openEnd >= 0 && cellXml.slice(existing, openEnd + 1).trimEnd().endsWith('/>')
    const end = selfClosing ? openEnd + 1 : matchingClose(cellXml, existing, tag)
    return cellXml.slice(0, existing) + childXml + cellXml.slice(end)
  }
  const tcPrStart = findOpen(cellXml, 'w:tcPr', 0)
  if (tcPrStart < 0) {
    const cellOpenEnd = cellXml.indexOf('>')
    return cellXml.slice(0, cellOpenEnd + 1) + `<w:tcPr>${childXml}</w:tcPr>` + cellXml.slice(cellOpenEnd + 1)
  }
  const tcPrOpenEnd = cellXml.indexOf('>', tcPrStart)
  if (tcPrOpenEnd < 0) throw new Error('表格单元格 tcPr 不完整')
  if (cellXml.slice(tcPrStart, tcPrOpenEnd + 1).trimEnd().endsWith('/>')) {
    return cellXml.slice(0, tcPrStart) + `<w:tcPr>${childXml}</w:tcPr>` + cellXml.slice(tcPrOpenEnd + 1)
  }
  const tcPrClose = matchingClose(cellXml, tcPrStart, 'w:tcPr') - '</w:tcPr>'.length
  return cellXml.slice(0, tcPrClose) + childXml + cellXml.slice(tcPrClose)
}

function cellXmlWithGridSpan(cellXml: string, span: number): string {
  if (span <= 1) return removeXmlElement(cellXml, 'w:gridSpan')
  return upsertTcPrChild(cellXml, 'w:gridSpan', `<w:gridSpan w:val="${span}"/>`)
}

function cellXmlWithVMerge(cellXml: string, mode: TableMergeMode): string {
  if (mode === null) return removeXmlElement(cellXml, 'w:vMerge')
  return upsertTcPrChild(cellXml, 'w:vMerge', `<w:vMerge w:val="${mode}"/>`)
}

function cellXmlUnmerged(cellXml: string): string {
  return cellXmlWithVMerge(cellXmlWithGridSpan(removeXmlElement(cellXml, 'w:hMerge'), 1), null)
}

function docxRowXmlWithCells(rowXml: string, cellsXml: string): string {
  const rowOpenEnd = rowXml.indexOf('>')
  if (rowOpenEnd < 0) throw new Error('表格行 XML 不完整')
  const rowAttrs = rowXml.slice('<w:tr'.length, rowOpenEnd)
  const trPrStart = findOpen(rowXml, 'w:trPr', rowOpenEnd + 1)
  let trPr = ''
  if (trPrStart >= 0) {
    const openEnd = rowXml.indexOf('>', trPrStart)
    const selfClosing = openEnd >= 0 && rowXml.slice(trPrStart, openEnd + 1).trimEnd().endsWith('/>')
    trPr = selfClosing ? rowXml.slice(trPrStart, openEnd + 1) : rowXml.slice(trPrStart, matchingClose(rowXml, trPrStart, 'w:trPr'))
  }
  return `<w:tr${rowAttrs}>${trPr}${cellsXml}</w:tr>`
}

function splitTableXmlMerged(tableXml: string): { xml: string; splitCells: number } {
  const gridColumnCount = tableGridColumnsOf(tableXml).length
  const layouts = tableRowLayoutsOf(tableXml, gridColumnCount)
  let splitCells = 0
  const edits = layouts.map((layout) => {
    const expanded: string[] = []
    for (const cell of layout.cells) {
      if (cell.span > 1 || cell.vMerge || cell.hMerge) splitCells += 1
      expanded.push(cellXmlUnmerged(cell.cell.xml))
      for (let index = 1; index < cell.span; index += 1) {
        expanded.push(cellXmlUnmerged(docxCellXmlWithText(cell.cell.xml, '')))
      }
    }
    return {
      at: layout.row.start,
      end: layout.row.end,
      xml: docxRowXmlWithCells(layout.row.xml, expanded.join('')),
    }
  })
  let next = tableXml
  for (const edit of edits.sort((a, b) => b.at - a.at)) {
    next = next.slice(0, edit.at) + edit.xml + next.slice(edit.end)
  }
  return { xml: next, splitCells }
}

function mergeTableXmlCells(tableXml: string, range: string): { xml: string; rows: number; columns: number } {
  const match = /^t(\d+)-r(\d+)-c(\d+):t(\d+)-r(\d+)-c(\d+)$/i.exec(range)
  if (!match) throw new Error(`无法识别的合并范围: ${range}；请用 tN-rA-cA:tN-rB-cB`)
  if (match[1] !== match[4]) throw new Error('合并范围必须位于同一张表格')
  const rowStart = Number.parseInt(match[2], 10)
  const columnStart = Number.parseInt(match[3], 10)
  const rowEnd = Number.parseInt(match[5], 10)
  const columnEnd = Number.parseInt(match[6], 10)
  if (rowStart < 1 || columnStart < 1 || rowEnd < rowStart || columnEnd < columnStart) {
    throw new Error('合并范围必须是从左上到右下的有效区域')
  }
  if (rowStart === rowEnd && columnStart === columnEnd) throw new Error('合并范围至少包含 2 个单元格')
  const gridColumnCount = tableGridColumnsOf(tableXml).length
  const layouts = tableRowLayoutsOf(tableXml, gridColumnCount)
  if (rowEnd > layouts.length || columnEnd > gridColumnCount) throw new Error('合并范围超出行列')
  if (layouts.some((layout) => layout.cells.some((cell) => cell.span !== 1 || cell.vMerge || cell.hMerge))) {
    throw new Error('表格包含合并单元格，请先用 action=split 拆分后再合并')
  }

  const span = columnEnd - columnStart + 1
  const height = rowEnd - rowStart + 1
  const targetRows = layouts.slice(rowStart - 1, rowEnd)
  let contentCell: string | null = null
  targetRows.forEach((layout, rowOffset) => {
    layout.cells.slice(columnStart - 1, columnEnd).forEach((cell, columnOffset) => {
      if (textOfXml(cell.cell.xml).trim()) {
        if (rowOffset > 0 || columnOffset > 0) throw new Error('合并区域内除左上角单元格外仍有文本，暂不支持合并')
        contentCell = cell.cell.xml
      }
    })
  })
  const sourceCell = contentCell ?? targetRows[0].cells[columnStart - 1].cell.xml
  const mergedTop = cellXmlWithVMerge(cellXmlWithGridSpan(sourceCell, span), height > 1 ? 'restart' : null)
  const mergedContinuation = cellXmlWithVMerge(
    cellXmlWithGridSpan(docxCellXmlWithText(sourceCell, ''), span),
    'continue',
  )

  const edits = targetRows.map((layout, rowOffset) => {
    const before = layout.cells.slice(0, columnStart - 1).map((cell) => cell.cell.xml).join('')
    const after = layout.cells.slice(columnEnd).map((cell) => cell.cell.xml).join('')
    const merged = rowOffset === 0 ? mergedTop : mergedContinuation
    return {
      at: layout.row.start,
      end: layout.row.end,
      xml: docxRowXmlWithCells(layout.row.xml, before + merged + after),
    }
  })
  let next = tableXml
  for (const edit of edits.sort((a, b) => b.at - a.at)) {
    next = next.slice(0, edit.at) + edit.xml + next.slice(edit.end)
  }
  return { xml: next, rows: height, columns: span }
}

function docxTableXmlWithColumn(
  tableXml: string,
  targetColumn: number,
  position: 'before' | 'after',
  values: string[],
): string {
  const globalStart = 0
  const gridCols = tableGridColumnsOf(tableXml)
  if (targetColumn < 1 || targetColumn > gridCols.length) {
    throw new Error(`表格只有 ${gridCols.length} 列，没有第 ${targetColumn} 列`)
  }

  const rows: XmlSegment[] = []
  let pos = globalStart
  while (pos < tableXml.length) {
    const start = findOpen(tableXml, 'w:tr', pos)
    if (start < 0) break
    const end = matchingClose(tableXml, start, 'w:tr')
    rows.push({ start, end, xml: tableXml.slice(start, end) })
    pos = end
  }
  if (rows.length === 0) throw new Error('表格没有数据行')

  const edits: Array<{ at: number; xml: string }> = []
  const targetGridCol = gridCols[targetColumn - 1]
  edits.push({
    at: position === 'before' ? targetGridCol.start : targetGridCol.end,
    xml: targetGridCol.xml,
  })

  rows.forEach((row, rowIndex) => {
    const cells: XmlSegment[] = []
    let cellPos = row.start
    while (cellPos < row.end) {
      const start = findOpen(tableXml, 'w:tc', cellPos)
      if (start < 0 || start >= row.end) break
      const end = matchingClose(tableXml, start, 'w:tc')
      cells.push({ start, end, xml: tableXml.slice(start, end) })
      cellPos = end
    }
    if (cells.some((cell) => /<w:(gridSpan|vMerge|hMerge)\b/i.test(cell.xml))) {
      throw new Error('表格包含合并单元格，列插入暂不支持；请先用 action=split 拆分合并单元格')
    }
    if (cells.length !== gridCols.length) {
      throw new Error(`表格第 ${rowIndex + 1} 行有 ${cells.length} 个单元格，与 ${gridCols.length} 列不一致`)
    }
    const targetCell = cells[targetColumn - 1]
    const cloned = docxCellXmlWithText(targetCell.xml, values[rowIndex] ?? '')
    edits.push({
      at: position === 'before' ? targetCell.start : targetCell.end,
      xml: cloned,
    })
  })

  let next = tableXml
  for (const edit of edits.sort((a, b) => b.at - a.at)) {
    next = next.slice(0, edit.at) + edit.xml + next.slice(edit.at)
  }
  return next
}

export function insertDocxTable(buffer: Buffer, options: OfficeDocxTableInsertOptions): OfficeDocxTableInsertResult {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(new Uint8Array(buffer))
  } catch {
    throw new Error('docx 文件不是有效的 Office Open XML 压缩包')
  }
  const documentBytes = files['word/document.xml']
  if (!documentBytes) throw new Error('docx 缺少 word/document.xml')
  const documentXml = new TextDecoder().decode(documentBytes)
  const position = options.position ?? 'after'
  const rowMatch = /^t(\d+)-r(\d+)$/i.exec(options.elementId)
  const columnMatch = /^t(\d+)-c(\d+)$/i.exec(options.elementId)
  if (!rowMatch && !columnMatch) throw new Error(`无法识别的 docx 表格 ID: ${options.elementId}`)
  const tableOrdinal = Number.parseInt((rowMatch ?? columnMatch)![1], 10)
  const table = bodyChildSegments(documentXml).filter((item) => item.kind === 'table')[tableOrdinal - 1]?.segment
  if (!table) throw new Error(`文档中没有表格 t${tableOrdinal}`)

  if (rowMatch) {
    const rowOrdinal = Number.parseInt(rowMatch[2], 10)
    const row = nthNestedSegment(table.xml, 'w:tr', rowOrdinal)
    if (!row) throw new Error(`表格 t${tableOrdinal} 没有第 ${rowOrdinal} 行`)
    const values = options.text.split('\t')
    const nextRowXml = docxRowXmlWithValues(row.xml, values)
    const at = table.start + (position === 'before' ? row.start : row.end)
    const nextDocumentXml = documentXml.slice(0, at) + nextRowXml + documentXml.slice(at)
    files['word/document.xml'] = new TextEncoder().encode(nextDocumentXml)
    return {
      buffer: Buffer.from(zipSync(files, { level: 6 })),
      elementId: options.elementId,
      kind: 'table_row',
      position,
      insertedValues: values,
    }
  }

  const targetColumn = Number.parseInt(columnMatch![2], 10)
  const values = options.text === '' ? [] : options.text.replace(/\r\n?/g, '\n').split('\n')
  const nextTableXml = docxTableXmlWithColumn(table.xml, targetColumn, position, values)
  const nextDocumentXml = documentXml.slice(0, table.start) + nextTableXml + documentXml.slice(table.end)
  files['word/document.xml'] = new TextEncoder().encode(nextDocumentXml)
  return {
    buffer: Buffer.from(zipSync(files, { level: 6 })),
    elementId: options.elementId,
    kind: 'table_column',
    position,
    insertedValues: values,
  }
}

export interface OfficeDocxTableDeleteOptions {
  /** `tN-rN` 删除行，或 `tN-cN` 删除列。 */
  elementId: string
}

export interface OfficeDocxTableDeleteResult {
  buffer: Buffer
  elementId: string
  kind: 'table_row' | 'table_column'
  deletedRow?: number
  deletedColumn?: number
  remainingRows: number
  remainingColumns: number
}

export function deleteDocxTable(buffer: Buffer, options: OfficeDocxTableDeleteOptions): OfficeDocxTableDeleteResult {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(new Uint8Array(buffer))
  } catch {
    throw new Error('docx 文件不是有效的 Office Open XML 压缩包')
  }
  const documentBytes = files['word/document.xml']
  if (!documentBytes) throw new Error('docx 缺少 word/document.xml')
  const documentXml = new TextDecoder().decode(documentBytes)
  const rowMatch = /^t(\d+)-r(\d+)$/i.exec(options.elementId)
  const columnMatch = /^t(\d+)-c(\d+)$/i.exec(options.elementId)
  if (!rowMatch && !columnMatch) throw new Error(`无法识别的 docx 表格 ID: ${options.elementId}`)
  const tableOrdinal = Number.parseInt((rowMatch ?? columnMatch)![1], 10)
  const table = bodyChildSegments(documentXml).filter((item) => item.kind === 'table')[tableOrdinal - 1]?.segment
  if (!table) throw new Error(`文档中没有表格 t${tableOrdinal}`)

  const gridCols = tableGridColumnsOf(table.xml)
  const layouts = tableRowLayoutsOf(table.xml, gridCols.length)
  if (rowMatch) {
    const rowOrdinal = Number.parseInt(rowMatch[2], 10)
    if (rowOrdinal < 1 || rowOrdinal > layouts.length) {
      throw new Error(`表格 t${tableOrdinal} 没有第 ${rowOrdinal} 行`)
    }
    if (layouts.length <= 1) throw new Error('表格只有 1 行，不能删除最后一行')
    const target = layouts[rowOrdinal - 1]
    const nextRow = layouts[rowOrdinal]
    const edits: Array<{ at: number; end: number; xml?: string }> = [
      { at: table.start + target.row.start, end: table.start + target.row.end },
    ]
    if (nextRow) {
      target.cells
        .filter((cell) => cell.vMerge === 'restart')
        .forEach((cell) => {
          const continuation = nextRow.cells.find(
            (candidate) =>
              candidate.vMerge === 'continue' &&
              candidate.startColumn === cell.startColumn &&
              candidate.endColumn === cell.endColumn,
          )
          if (!continuation) return
          edits.push({
            at: table.start + continuation.cell.start,
            end: table.start + continuation.cell.end,
            xml: cellXmlWithVMerge(cell.cell.xml, 'restart'),
          })
        })
    }
    let nextDocumentXml = documentXml
    for (const edit of edits.sort((a, b) => b.at - a.at)) {
      nextDocumentXml = nextDocumentXml.slice(0, edit.at) + (edit.xml ?? '') + nextDocumentXml.slice(edit.end)
    }
    files['word/document.xml'] = new TextEncoder().encode(nextDocumentXml)
    return {
      buffer: Buffer.from(zipSync(files, { level: 6 })),
      elementId: options.elementId,
      kind: 'table_row',
      deletedRow: rowOrdinal,
      remainingRows: layouts.length - 1,
      remainingColumns: gridCols.length,
    }
  }

  const targetColumn = Number.parseInt(columnMatch![2], 10)
  if (targetColumn < 1 || targetColumn > gridCols.length) {
    throw new Error(`表格 t${tableOrdinal} 只有 ${gridCols.length} 列，没有第 ${targetColumn} 列`)
  }
  if (gridCols.length <= 1) throw new Error('表格只有 1 列，不能删除最后一列')
  if (layouts.some((layout) => layout.cells.some((cell) => cell.hMerge))) {
    throw new Error('表格包含旧式 hMerge 横向合并，列删除暂不支持；请先在 Word 中转换为 gridSpan')
  }
  const edits: Array<{ at: number; end: number; xml?: string }> = [
    { at: table.start + gridCols[targetColumn - 1].start, end: table.start + gridCols[targetColumn - 1].end },
  ]
  layouts.forEach((layout, rowIndex) => {
    const cell = layout.cells.find((candidate) => candidate.startColumn <= targetColumn && candidate.endColumn >= targetColumn)
    if (!cell) throw new Error(`表格第 ${rowIndex + 1} 行没有覆盖第 ${targetColumn} 个网格列`)
    const edit = {
      at: table.start + cell.cell.start,
      end: table.start + cell.cell.end,
      xml: cell.span > 1 ? cellXmlWithGridSpan(cell.cell.xml, cell.span - 1) : undefined,
    }
    edits.push(edit)
  })
  let nextDocumentXml = documentXml
  for (const edit of edits.sort((a, b) => b.at - a.at)) {
    nextDocumentXml = nextDocumentXml.slice(0, edit.at) + (edit.xml ?? '') + nextDocumentXml.slice(edit.end)
  }
  files['word/document.xml'] = new TextEncoder().encode(nextDocumentXml)
  return {
    buffer: Buffer.from(zipSync(files, { level: 6 })),
    elementId: options.elementId,
    kind: 'table_column',
    deletedColumn: targetColumn,
    remainingRows: layouts.length,
    remainingColumns: gridCols.length - 1,
  }
}

export interface OfficeDocxTableSplitOptions {
  /** 目标表格 `tN`。 */
  elementId: string
}

export interface OfficeDocxTableSplitResult {
  buffer: Buffer
  elementId: string
  kind: 'table_split'
  splitCells: number
  remainingRows: number
  remainingColumns: number
}

export function splitDocxTableMergedCells(
  buffer: Buffer,
  options: OfficeDocxTableSplitOptions,
): OfficeDocxTableSplitResult {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(new Uint8Array(buffer))
  } catch {
    throw new Error('docx 文件不是有效的 Office Open XML 压缩包')
  }
  const documentBytes = files['word/document.xml']
  if (!documentBytes) throw new Error('docx 缺少 word/document.xml')
  const documentXml = new TextDecoder().decode(documentBytes)
  const match = /^t(\d+)$/i.exec(options.elementId.trim())
  if (!match) throw new Error(`无法识别的表格 ID: ${options.elementId}；拆分合并单元格请用 tN`)
  const tableOrdinal = Number.parseInt(match[1], 10)
  const table = bodyChildSegments(documentXml).filter((item) => item.kind === 'table')[tableOrdinal - 1]?.segment
  if (!table) throw new Error(`文档中没有表格 t${tableOrdinal}`)
  const result = splitTableXmlMerged(table.xml)
  const nextDocumentXml = documentXml.slice(0, table.start) + result.xml + documentXml.slice(table.end)
  files['word/document.xml'] = new TextEncoder().encode(nextDocumentXml)
  return {
    buffer: Buffer.from(zipSync(files, { level: 6 })),
    elementId: options.elementId,
    kind: 'table_split',
    splitCells: result.splitCells,
    remainingRows: tableRowsOf(result.xml).length,
    remainingColumns: tableGridColumnsOf(result.xml).length,
  }
}

export interface OfficeDocxTableMergeOptions {
  /** 合并范围 `tN-rA-cA:tN-rB-cB`。 */
  range: string
}

export interface OfficeDocxTableMergeResult {
  buffer: Buffer
  elementId: string
  kind: 'table_merge'
  mergedRows: number
  mergedColumns: number
  remainingRows: number
  remainingColumns: number
}

export function mergeDocxTableCells(buffer: Buffer, options: OfficeDocxTableMergeOptions): OfficeDocxTableMergeResult {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(new Uint8Array(buffer))
  } catch {
    throw new Error('docx 文件不是有效的 Office Open XML 压缩包')
  }
  const documentBytes = files['word/document.xml']
  if (!documentBytes) throw new Error('docx 缺少 word/document.xml')
  const documentXml = new TextDecoder().decode(documentBytes)
  const range = options.range.trim()
  const match = /^t(\d+)-r(\d+)-c(\d+):t(\d+)-r(\d+)-c(\d+)$/i.exec(range)
  if (!match) throw new Error(`无法识别的合并范围: ${range}；请用 tN-rA-cA:tN-rB-cB`)
  if (match[1] !== match[4]) throw new Error('合并范围必须位于同一张表格')
  const tableOrdinal = Number.parseInt(match[1], 10)
  const table = bodyChildSegments(documentXml).filter((item) => item.kind === 'table')[tableOrdinal - 1]?.segment
  if (!table) throw new Error(`文档中没有表格 t${tableOrdinal}`)
  const result = mergeTableXmlCells(table.xml, range)
  const nextDocumentXml = documentXml.slice(0, table.start) + result.xml + documentXml.slice(table.end)
  files['word/document.xml'] = new TextEncoder().encode(nextDocumentXml)
  return {
    buffer: Buffer.from(zipSync(files, { level: 6 })),
    elementId: range,
    kind: 'table_merge',
    mergedRows: result.rows,
    mergedColumns: result.columns,
    remainingRows: tableRowsOf(result.xml).length,
    remainingColumns: tableGridColumnsOf(result.xml).length,
  }
}

/* ---------------- docx 范围读取：完整文本、run 级格式和表格结构 ---------------- */

function runBooleanProperty(rprXml: string, tag: string): boolean {
  const match = new RegExp(`<w:${tag}\\b([^>]*?)(?:/>|>)`, 'i').exec(rprXml)
  if (!match) return false
  const value = /w:val="([^"]*)"/i.exec(match[1])?.[1]?.toLowerCase()
  if (value === undefined) return true
  return value === '1' || value === 'true' || value === 'on'
}

function runFormatOf(runXml: string): OfficeRunFormat {
  const rprMatch = /<w:rPr\b[^>]*>[\s\S]*?<\/w:rPr>/i.exec(runXml)
  const rpr = rprMatch?.[0] ?? ''
  const underlineMatch = /<w:u\b([^>]*?)(?:\/>|>)/i.exec(rpr)
  const underlineValue = underlineMatch ? /w:val="([^"]*)"/i.exec(underlineMatch[1])?.[1] ?? 'single' : undefined
  const color = /<w:color\b[^>]*w:val="([^"]*)"/i.exec(rpr)?.[1]
  const size = /<w:sz\b[^>]*w:val="([^"]*)"/i.exec(rpr)?.[1]
  const fontMatch = /<w:rFonts\b([^>]*?)\/?>/i.exec(rpr)
  const fontAttributes = fontMatch?.[1] ?? ''
  const fontFamily =
    /w:eastAsia="([^"]*)"/i.exec(fontAttributes)?.[1] ??
    /w:ascii="([^"]*)"/i.exec(fontAttributes)?.[1] ??
    /w:hAnsi="([^"]*)"/i.exec(fontAttributes)?.[1]
  const style = /<w:rStyle\b[^>]*w:val="([^"]*)"/i.exec(rpr)?.[1]
  return {
    bold: runBooleanProperty(rpr, 'b'),
    italic: runBooleanProperty(rpr, 'i'),
    ...(underlineValue && underlineValue !== 'none' ? { underline: underlineValue } : {}),
    ...(color ? { color: color.toUpperCase() } : {}),
    ...(size && Number.isFinite(Number(size)) ? { fontSize: Number(size) / 2 } : {}),
    ...(fontFamily ? { fontFamily } : {}),
    ...(style ? { style } : {}),
  }
}

function runRangesOf(xml: string): OfficeReadRangeRun[] {
  const runs: OfficeReadRangeRun[] = []
  let pos = 0
  let offset = 0
  while (pos < xml.length) {
    const start = findOpen(xml, 'w:r', pos)
    if (start < 0) break
    const end = matchingClose(xml, start, 'w:r')
    const runXml = xml.slice(start, end)
    if (/<w:(t|br|tab)\b/i.test(runXml)) {
      const text = textOfXml(runXml)
      runs.push({ text, start: offset, end: offset + text.length, format: runFormatOf(runXml) })
      offset += text.length
    }
    pos = end
  }
  return runs
}

function sliceRuns(runs: OfficeReadRangeRun[], start: number, end: number): OfficeReadRangeRun[] {
  const result: OfficeReadRangeRun[] = []
  for (const run of runs) {
    const from = Math.max(start, run.start)
    const to = Math.min(end, run.end)
    if (to <= from) continue
    result.push({
      text: run.text.slice(from - run.start, to - run.start),
      start: from,
      end: to,
      format: { ...run.format },
    })
  }
  return result
}

function paragraphFormatOf(paragraphXml: string): OfficeParagraphFormat {
  const pprMatch = /<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>/i.exec(paragraphXml)
  const ppr = pprMatch?.[0] ?? ''
  const style = /<w:pStyle\b[^>]*w:val="([^"]*)"/i.exec(ppr)?.[1] ?? ''
  const align = /<w:jc\b[^>]*w:val="([^"]*)"/i.exec(ppr)?.[1]
  const spacingMatch = /<w:spacing\b([^>]*?)\/?>/i.exec(ppr)
  const spacingAttributes = spacingMatch?.[1] ?? ''
  const line = /w:line="([^"]*)"/i.exec(spacingAttributes)?.[1]
  const lineRule = /w:lineRule="([^"]*)"/i.exec(spacingAttributes)?.[1]
  const before = /w:before="([^"]*)"/i.exec(spacingAttributes)?.[1]
  const after = /w:after="([^"]*)"/i.exec(spacingAttributes)?.[1]
  return {
    style,
    ...(align ? { align } : {}),
    ...(line && Number.isFinite(Number(line)) && (lineRule === undefined || lineRule === 'auto')
      ? { lineSpacing: Number(line) / 240 }
      : {}),
    ...(before && Number.isFinite(Number(before)) ? { spaceBefore: Number(before) / 20 } : {}),
    ...(after && Number.isFinite(Number(after)) ? { spaceAfter: Number(after) / 20 } : {}),
  }
}

function normalizeRangeOffsets(options: OfficeReadRangeOptions, totalLength: number): { start: number; end: number } {
  const rawStart = options.start ?? 0
  const rawEnd = options.end ?? totalLength
  if (!Number.isInteger(rawStart) || !Number.isInteger(rawEnd)) {
    throw new Error('start/end 必须是整数偏移')
  }
  if (rawStart < 0 || rawEnd < rawStart || rawEnd > totalLength) {
    throw new Error(`文本范围必须在 0 到 ${totalLength} 之间，且 start 不能大于 end`)
  }
  return { start: rawStart, end: rawEnd }
}

function textOfCells(cells: XmlSegment[], separator: string): { text: string; runs: OfficeReadRangeRun[] } {
  let text = ''
  const runs: OfficeReadRangeRun[] = []
  cells.forEach((cell, index) => {
    if (index > 0) text += separator
    const cellText = textOfXml(cell.xml)
    const base = text.length
    for (const run of runRangesOf(cell.xml)) {
      runs.push({ ...run, start: base + run.start, end: base + run.end })
    }
    text += cellText
  })
  return { text, runs }
}

function tableCellsOfRow(tableXml: string, row: XmlSegment): XmlSegment[] {
  const cells: XmlSegment[] = []
  let pos = row.start
  while (pos < row.end) {
    const start = findOpen(tableXml, 'w:tc', pos)
    if (start < 0 || start >= row.end) break
    const end = matchingClose(tableXml, start, 'w:tc')
    cells.push({ start, end, xml: tableXml.slice(start, end) })
    pos = end
  }
  return cells
}

function tableRowsOf(tableXml: string): XmlSegment[] {
  const rows: XmlSegment[] = []
  let pos = 0
  while (pos < tableXml.length) {
    const start = findOpen(tableXml, 'w:tr', pos)
    if (start < 0) break
    const end = matchingClose(tableXml, start, 'w:tr')
    rows.push({ start, end, xml: tableXml.slice(start, end) })
    pos = end
  }
  return rows
}

export function readDocxRange(buffer: Buffer, options: OfficeReadRangeOptions): OfficeReadRangeResult {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(new Uint8Array(buffer))
  } catch {
    throw new Error('docx 文件不是有效的 Office Open XML 压缩包')
  }
  const documentBytes = files['word/document.xml']
  if (!documentBytes) throw new Error('docx 缺少 word/document.xml')
  const documentXml = new TextDecoder().decode(documentBytes)
  const elementId = options.elementId.trim()
  const paragraphMatch = /^p(\d+)$/i.exec(elementId)
  if (paragraphMatch) {
    const segment = bodyChildSegments(documentXml).filter((item) => item.kind === 'paragraph')[Number.parseInt(paragraphMatch[1], 10) - 1]?.segment
    if (!segment) throw new Error(`文档中没有段落 ${elementId}`)
    const totalText = textOfXml(segment.xml)
    const range = normalizeRangeOffsets(options, totalText.length)
    return {
      kind: 'docx',
      elementId,
      elementKind: 'paragraph',
      text: totalText.slice(range.start, range.end),
      start: range.start,
      end: range.end,
      totalLength: totalText.length,
      runs: sliceRuns(runRangesOf(segment.xml), range.start, range.end),
      paragraph: paragraphFormatOf(segment.xml),
    }
  }

  const tableMatch = /^t(\d+)(?:-r(\d+)|-c(\d+)|-r(\d+)-c(\d+))?$/i.exec(elementId)
  if (!tableMatch) throw new Error(`无法识别的元素 ID: ${elementId}；支持 pN、tN、tN-rN、tN-cN、tN-rN-cN`)
  const tableOrdinal = Number.parseInt(tableMatch[1], 10)
  const tableSegment = bodyChildSegments(documentXml).filter((item) => item.kind === 'table')[tableOrdinal - 1]?.segment
  if (!tableSegment) throw new Error(`文档中没有表格 t${tableOrdinal}`)
  const tableId = `t${tableOrdinal}`

  if (tableMatch[4] && tableMatch[5]) {
    const rowOrdinal = Number.parseInt(tableMatch[4], 10)
    const columnOrdinal = Number.parseInt(tableMatch[5], 10)
    const target = locateElementSegment(documentXml, `t${tableOrdinal}-r${rowOrdinal}-c${columnOrdinal}`)
    const totalText = textOfXml(target.segment.xml)
    const range = normalizeRangeOffsets(options, totalText.length)
    return {
      kind: 'docx',
      elementId,
      elementKind: 'table_cell',
      text: totalText.slice(range.start, range.end),
      start: range.start,
      end: range.end,
      totalLength: totalText.length,
      runs: sliceRuns(runRangesOf(target.segment.xml), range.start, range.end),
    }
  }

  if (options.start !== undefined || options.end !== undefined) {
    throw new Error('start/end 只支持 pN 或 tN-rN-cN；读取整张表/行/列时请省略')
  }

  if (tableMatch[2]) {
    const rowOrdinal = Number.parseInt(tableMatch[2], 10)
    const row = nthNestedSegment(tableSegment.xml, 'w:tr', rowOrdinal)
    if (!row) throw new Error(`表格 ${tableId} 没有第 ${rowOrdinal} 行`)
    const cells = tableCellsOfRow(tableSegment.xml, row)
    const { text, runs } = textOfCells(cells, '\t')
    const data: OfficeTableRow[] = [
      {
        index: rowOrdinal,
        cells: cells.map((cell, index) => ({
          id: `${tableId}-r${rowOrdinal}-c${index + 1}`,
          text: textOfXml(cell.xml).trim(),
        })),
      },
    ]
    return {
      kind: 'docx',
      elementId,
      elementKind: 'table_row',
      text,
      start: 0,
      end: text.length,
      totalLength: text.length,
      runs,
      table: { id: tableId, rows: 1, columns: cells.length, data },
    }
  }

  if (tableMatch[3]) {
    const columnOrdinal = Number.parseInt(tableMatch[3], 10)
    const rows = tableRowsOf(tableSegment.xml)
    const cells: XmlSegment[] = []
    const data: OfficeTableRow[] = []
    rows.forEach((row, rowIndex) => {
      const rowCells = tableCellsOfRow(tableSegment.xml, row)
      const target = rowCells[columnOrdinal - 1]
      if (!target) throw new Error(`表格 ${tableId} 第 ${rowIndex + 1} 行没有第 ${columnOrdinal} 列`)
      cells.push(target)
      data.push({
        index: rowIndex + 1,
        cells: [{ id: `${tableId}-r${rowIndex + 1}-c${columnOrdinal}`, text: textOfXml(target.xml).trim() }],
      })
    })
    const { text, runs } = textOfCells(cells, '\n')
    return {
      kind: 'docx',
      elementId,
      elementKind: 'table_column',
      text,
      start: 0,
      end: text.length,
      totalLength: text.length,
      runs,
      table: { id: tableId, rows: data.length, columns: 1, data },
    }
  }

  const parsed = tableOfXml(tableSegment.xml, tableOrdinal - 1, true)
  const data = parsed.rowsData ?? parsed.preview
  const rows = tableRowsOf(tableSegment.xml)
  let text = ''
  const runs: OfficeReadRangeRun[] = []
  rows.forEach((row, rowIndex) => {
    if (rowIndex > 0) text += '\n'
    const rowText = textOfCells(tableCellsOfRow(tableSegment.xml, row), '\t')
    const base = text.length
    runs.push(...rowText.runs.map((run) => ({ ...run, start: base + run.start, end: base + run.end })))
    text += rowText.text
  })
  return {
    kind: 'docx',
    elementId,
    elementKind: 'table',
    text,
    start: 0,
    end: text.length,
    totalLength: text.length,
    runs,
    table: { id: tableId, rows: parsed.rows, columns: parsed.columns, data },
  }
}

/* ---------------- docx 格式、批注：只改目标元素，保留其余 XML ---------------- */

const UNDERLINE_VALUES = new Set([
  'single',
  'double',
  'thick',
  'dotted',
  'dottedHeavy',
  'dash',
  'dashedHeavy',
  'dashLong',
  'dashLongHeavy',
  'dotDash',
  'dotDashHeavy',
  'dotDotDash',
  'dotDotDashHeavy',
  'wave',
  'wavyHeavy',
  'wavyDouble',
  'none',
])

const HIGHLIGHT_VALUES = new Set([
  'yellow',
  'green',
  'cyan',
  'magenta',
  'blue',
  'red',
  'darkBlue',
  'darkCyan',
  'darkGreen',
  'darkMagenta',
  'darkRed',
  'darkYellow',
  'gray',
  'lightGray',
  'black',
  'white',
  'none',
])

const RPR_ORDER: Record<string, number> = {
  rStyle: 1,
  rFonts: 2,
  b: 3,
  bCs: 4,
  i: 5,
  iCs: 6,
  caps: 7,
  smallCaps: 8,
  strike: 9,
  dstrike: 10,
  outline: 11,
  shadow: 12,
  emboss: 13,
  imprint: 14,
  noProof: 15,
  snapToGrid: 16,
  vanish: 17,
  webHidden: 18,
  color: 19,
  spacing: 20,
  w: 21,
  kern: 22,
  position: 23,
  sz: 24,
  szCs: 25,
  highlight: 26,
  u: 27,
  effect: 28,
  bdr: 29,
  shd: 30,
  fitText: 31,
  vertAlign: 32,
  rtl: 33,
  cs: 34,
  em: 35,
  lang: 36,
  eastAsianLayout: 37,
  specVanish: 38,
  oMath: 39,
}

const PPR_ORDER: Record<string, number> = {
  pStyle: 1,
  keepNext: 2,
  keepLines: 3,
  pageBreakBefore: 4,
  framePr: 5,
  widowControl: 6,
  numPr: 7,
  suppressLineNumbers: 8,
  pBdr: 9,
  shd: 10,
  tabs: 11,
  suppressAutoHyphens: 12,
  kinsoku: 13,
  wordWrap: 14,
  overflowPunct: 15,
  topLinePunct: 16,
  autoSpaceDE: 17,
  autoSpaceDN: 18,
  bidi: 19,
  adjustRightInd: 20,
  snapToGrid: 21,
  spacing: 22,
  ind: 23,
  contextualSpacing: 24,
  mirrorIndents: 25,
  suppressOverlap: 26,
  jc: 27,
  textDirection: 28,
  textAlignment: 29,
  textboxTightWrap: 30,
  outlineLvl: 31,
  divId: 32,
  cnfStyle: 33,
  rPr: 34,
  sectPr: 35,
  pPrChange: 36,
}

export interface OfficeFormatOptions {
  /** `pN` 或 `tN-rN-cN`。 */
  elementId: string
  bold?: boolean
  italic?: boolean
  underline?: boolean | string
  /** 6 位十六进制，例如 FF0000。 */
  color?: string
  /** OnlyOffice/Word 高亮色名，例如 yellow；none 表示清除。 */
  highlight?: string
  /** 字号（磅），内部转换为 OOXML 的半磅值。 */
  fontSize?: number
  /** 字体族名称，例如 宋体、Arial。 */
  fontFamily?: string
  /** 段落对齐：left / center / right / justify。 */
  align?: string
  /** 行距倍数，1 到 3，例如 1.5。 */
  lineSpacing?: number
  /** 段前间距（磅）。 */
  spaceBefore?: number
  /** 段后间距（磅）。 */
  spaceAfter?: number
}

export interface OfficeFormatResult {
  buffer: Buffer
  elementId: string
  kind: 'paragraph' | 'table_cell'
  applied: string[]
  runCount: number
}

function removeXmlTag(xml: string, tag: string): string {
  const selfClosing = new RegExp(`<${tag}\\b[^>]*/>`, 'gi')
  const paired = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi')
  return xml.replace(paired, '').replace(selfClosing, '')
}

function formatProperties(options: OfficeFormatOptions): Array<{ tag: string; xml: string }> {
  const result: Array<{ tag: string; xml: string }> = []
  if (options.bold === true) result.push({ tag: 'b', xml: '<w:b/><w:bCs/>' })
  if (options.italic === true) result.push({ tag: 'i', xml: '<w:i/><w:iCs/>' })
  if (options.underline !== undefined && options.underline !== false) {
    const value = options.underline === true ? 'single' : String(options.underline)
    if (!UNDERLINE_VALUES.has(value)) throw new Error(`不支持的 underline: ${value}`)
    result.push({ tag: 'u', xml: `<w:u w:val="${encodeXmlText(value)}"/>` })
  }
  if (options.color !== undefined) {
    const color = options.color.trim().replace(/^#/, '')
    if (!/^[0-9a-f]{6}$/i.test(color)) throw new Error('color 必须是 6 位十六进制，例如 FF0000')
    result.push({ tag: 'color', xml: `<w:color w:val="${color.toUpperCase()}"/>` })
  }
  if (options.highlight !== undefined) {
    const highlight = options.highlight.trim()
    if (!HIGHLIGHT_VALUES.has(highlight)) {
      throw new Error(`不支持的 highlight: ${highlight}`)
    }
    if (highlight !== 'none') result.push({ tag: 'highlight', xml: `<w:highlight w:val="${highlight}"/>` })
  }
  if (options.fontSize !== undefined) {
    if (!Number.isFinite(options.fontSize) || options.fontSize < 1 || options.fontSize > 300) {
      throw new Error('fontSize 必须在 1 到 300 磅之间')
    }
    const halfPoints = Math.round(options.fontSize * 2)
    result.push({ tag: 'sz', xml: `<w:sz w:val="${halfPoints}"/><w:szCs w:val="${halfPoints}"/>` })
  }
  if (options.fontFamily !== undefined) {
    const fontFamily = options.fontFamily.trim()
    if (!fontFamily) throw new Error('fontFamily 不能为空')
    if (fontFamily.length > 200 || /[<>"]/.test(fontFamily)) throw new Error('fontFamily 含非法字符')
    const escaped = encodeXmlText(fontFamily)
    result.push({
      tag: 'rFonts',
      xml: `<w:rFonts w:ascii="${escaped}" w:hAnsi="${escaped}" w:eastAsia="${escaped}" w:cs="${escaped}"/>`,
    })
  }
  return result
}

function rprTokens(xml: string): Array<{ tag: string; start: number; end: number }> {
  const tokens: Array<{ tag: string; start: number; end: number }> = []
  const re = /<w:([A-Za-z0-9]+)\b[^>]*?(?:\/>|>[\s\S]*?<\/w:\1>)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(xml))) {
    tokens.push({ tag: match[1], start: match.index, end: match.index + match[0].length })
  }
  return tokens
}

function insertRprProperty(inner: string, tag: string, xml: string): string {
  const rank = RPR_ORDER[tag] ?? 100
  const tokens = rprTokens(inner)
  const before = tokens.find((token) => (RPR_ORDER[token.tag] ?? 100) > rank)
  if (before) return `${inner.slice(0, before.start)}${xml}${inner.slice(before.start)}`
  return inner + xml
}

function insertPprProperty(inner: string, tag: string, xml: string): string {
  const rank = PPR_ORDER[tag] ?? 100
  const tokens = rprTokens(inner)
  const before = tokens.find((token) => (PPR_ORDER[token.tag] ?? 100) > rank)
  if (before) return `${inner.slice(0, before.start)}${xml}${inner.slice(before.start)}`
  return inner + xml
}

const ALIGN_VALUES = new Set(['left', 'center', 'right', 'both', 'justify', 'distribute'])

function paragraphSpacingXml(inner: string, options: OfficeFormatOptions): string | undefined {
  if (options.lineSpacing === undefined && options.spaceBefore === undefined && options.spaceAfter === undefined) {
    return undefined
  }
  if (options.lineSpacing !== undefined && (!Number.isFinite(options.lineSpacing) || options.lineSpacing < 1 || options.lineSpacing > 3)) {
    throw new Error('lineSpacing 必须在 1 到 3 之间')
  }
  for (const [name, value] of [
    ['spaceBefore', options.spaceBefore],
    ['spaceAfter', options.spaceAfter],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 300)) {
      throw new Error(`${name} 必须在 0 到 300 磅之间`)
    }
  }
  const existing = /<w:spacing\b([^>]*)\/>/i.exec(inner) ?? /<w:spacing\b([^>]*)>[\s\S]*?<\/w:spacing>/i.exec(inner)
  const attrs = new Map<string, string>()
  if (existing) {
    for (const match of existing[1].matchAll(/([A-Za-z0-9:]+)="([^"]*)"/g)) attrs.set(match[1], match[2])
  }
  if (options.lineSpacing !== undefined) {
    attrs.set('w:line', String(Math.round(options.lineSpacing * 240)))
    attrs.set('w:lineRule', 'auto')
  }
  if (options.spaceBefore !== undefined) attrs.set('w:before', String(Math.round(options.spaceBefore * 20)))
  if (options.spaceAfter !== undefined) attrs.set('w:after', String(Math.round(options.spaceAfter * 20)))
  return `<w:spacing ${[...attrs].map(([name, value]) => `${name}="${encodeXmlText(value)}"`).join(' ')}/>`
}

function applyParagraphProperties(paragraphXml: string, options: OfficeFormatOptions): string {
  const hasSpacing =
    options.lineSpacing !== undefined || options.spaceBefore !== undefined || options.spaceAfter !== undefined
  const align = options.align?.trim().toLowerCase()
  if (align !== undefined && !ALIGN_VALUES.has(align)) {
    throw new Error(`不支持的 align: ${options.align}`)
  }
  if (!hasSpacing && align === undefined) return paragraphXml
  const build = (inner: string): string => {
    let next = inner
    if (hasSpacing) {
      const spacing = paragraphSpacingXml(next, options)!
      next = removeXmlTag(next, 'w:spacing')
      next = insertPprProperty(next, 'spacing', spacing)
    }
    if (align !== undefined) {
      next = removeXmlTag(next, 'w:jc')
      next = insertPprProperty(next, 'jc', `<w:jc w:val="${align === 'justify' ? 'both' : align}"/>`)
    }
    return next
  }
  const pPrOpen = findOpen(paragraphXml, 'w:pPr', 0)
  if (pPrOpen < 0) {
    const pOpen = findOpen(paragraphXml, 'w:p', 0)
    if (pOpen < 0) return paragraphXml
    const at = paragraphXml.indexOf('>', pOpen) + 1
    return paragraphXml.slice(0, at) + `<w:pPr>${build('')}</w:pPr>` + paragraphXml.slice(at)
  }
  const pPrOpenEnd = paragraphXml.indexOf('>', pPrOpen) + 1
  if (paragraphXml.slice(pPrOpen, pPrOpenEnd).trimEnd().endsWith('/>')) {
    return (
      paragraphXml.slice(0, pPrOpen) +
      paragraphXml.slice(pPrOpen, pPrOpenEnd).replace(/\/>$/, '>') +
      build('') +
      '</w:pPr>' +
      paragraphXml.slice(pPrOpenEnd)
    )
  }
  const pPrEnd = matchingClose(paragraphXml, pPrOpen, 'w:pPr')
  return paragraphXml.slice(0, pPrOpenEnd) + build(paragraphXml.slice(pPrOpenEnd, pPrEnd - '</w:pPr>'.length)) + paragraphXml.slice(pPrEnd - '</w:pPr>'.length)
}

function applyParagraphPropertiesToXml(xml: string, options: OfficeFormatOptions): string {
  let result = xml
  const segments: Array<{ start: number; end: number }> = []
  let pos = 0
  while (pos < result.length) {
    const start = findOpen(result, 'w:p', pos)
    if (start < 0) break
    const end = matchingClose(result, start, 'w:p')
    segments.push({ start, end })
    pos = end
  }
  for (const segment of segments.reverse()) {
    result = result.slice(0, segment.start) + applyParagraphProperties(result.slice(segment.start, segment.end), options) + result.slice(segment.end)
  }
  return result
}

function formatRprInner(inner: string, options: OfficeFormatOptions, fragments: Array<{ tag: string; xml: string }>): string {
  let result = inner
  if (options.bold !== undefined) {
    result = removeXmlTag(result, 'w:b')
    result = removeXmlTag(result, 'w:bCs')
  }
  if (options.italic !== undefined) {
    result = removeXmlTag(result, 'w:i')
    result = removeXmlTag(result, 'w:iCs')
  }
  if (options.underline !== undefined) result = removeXmlTag(result, 'w:u')
  if (options.color !== undefined) result = removeXmlTag(result, 'w:color')
  if (options.highlight !== undefined) result = removeXmlTag(result, 'w:highlight')
  if (options.fontSize !== undefined) {
    result = removeXmlTag(result, 'w:sz')
    result = removeXmlTag(result, 'w:szCs')
  }
  if (options.fontFamily !== undefined) result = removeXmlTag(result, 'w:rFonts')
  for (const fragment of fragments) result = insertRprProperty(result, fragment.tag, fragment.xml)
  return result
}

function rprXml(fragments: Array<{ tag: string; xml: string }>, options: OfficeFormatOptions): string {
  return `<w:rPr>${formatRprInner('', options, fragments)}</w:rPr>`
}

function applyRunFormatting(runXml: string, options: OfficeFormatOptions, fragments: Array<{ tag: string; xml: string }>): string {
  const selfClosing = /<w:rPr\b[^>]*\/>/i.exec(runXml)
  if (selfClosing) {
    const open = selfClosing[0].replace(/\/>$/, '>')
    return runXml.slice(0, selfClosing.index) + open + formatRprInner('', options, fragments) + '</w:rPr>' + runXml.slice(selfClosing.index + selfClosing[0].length)
  }
  const open = /<w:rPr\b[^>]*>/i.exec(runXml)
  if (open) {
    const start = open.index + open[0].length
    const close = runXml.indexOf('</w:rPr>', start)
    if (close < 0) throw new Error('docx run 的 rPr 结构不完整')
    return runXml.slice(0, start) + formatRprInner(runXml.slice(start, close), options, fragments) + runXml.slice(close)
  }
  const runOpen = findOpen(runXml, 'w:r', 0)
  if (runOpen < 0) return runXml
  const at = runXml.indexOf('>', runOpen) + 1
  return runXml.slice(0, at) + rprXml(fragments, options) + runXml.slice(at)
}

function applyParagraphMarkFormatting(paragraphXml: string, options: OfficeFormatOptions, fragments: Array<{ tag: string; xml: string }>): string {
  const pPrOpen = findOpen(paragraphXml, 'w:pPr', 0)
  const markRpr = rprXml(fragments, options)
  if (pPrOpen < 0) {
    const pOpen = findOpen(paragraphXml, 'w:p', 0)
    if (pOpen < 0) return paragraphXml
    const at = paragraphXml.indexOf('>', pOpen) + 1
    return paragraphXml.slice(0, at) + `<w:pPr>${markRpr}</w:pPr>` + paragraphXml.slice(at)
  }
  const pPrOpenEnd = paragraphXml.indexOf('>', pPrOpen) + 1
  const pPrOpenTag = paragraphXml.slice(pPrOpen, pPrOpenEnd)
  if (pPrOpenTag.trimEnd().endsWith('/>')) {
    return paragraphXml.slice(0, pPrOpen) + pPrOpenTag.replace(/\/>$/, '>') + markRpr + '</w:pPr>' + paragraphXml.slice(pPrOpenEnd)
  }
  const pPrEnd = matchingClose(paragraphXml, pPrOpen, 'w:pPr')
  const pPrXml = paragraphXml.slice(pPrOpen, pPrEnd)
  const selfClosingRpr = /<w:rPr\b[^>]*\/>/i.exec(pPrXml)
  if (selfClosingRpr) {
    const start = pPrOpen + selfClosingRpr.index
    return (
      paragraphXml.slice(0, start) +
      `<w:rPr>${formatRprInner('', options, fragments)}</w:rPr>` +
      paragraphXml.slice(start + selfClosingRpr[0].length)
    )
  }
  const runRprOpen = /<w:rPr\b[^>]*>/i.exec(pPrXml)
  if (runRprOpen) {
    const start = pPrOpen + runRprOpen.index + runRprOpen[0].length
    const close = paragraphXml.indexOf('</w:rPr>', start)
    if (close < 0 || close > pPrEnd) throw new Error('docx 段落标记的 rPr 结构不完整')
    return (
      paragraphXml.slice(0, start) +
      formatRprInner(paragraphXml.slice(start, close), options, fragments) +
      paragraphXml.slice(close)
    )
  }
  return paragraphXml.slice(0, pPrEnd - '</w:pPr>'.length) + markRpr + paragraphXml.slice(pPrEnd - '</w:pPr>'.length)
}

function textRunSegments(xml: string): Array<{ start: number; end: number }> {
  const result: Array<{ start: number; end: number }> = []
  let pos = 0
  while (pos < xml.length) {
    const start = findOpen(xml, 'w:r', pos)
    if (start < 0) break
    const end = matchingClose(xml, start, 'w:r')
    if (end <= start) break
    const runXml = xml.slice(start, end)
    if (/<w:(t|br|tab)\b/i.test(runXml)) result.push({ start, end })
    pos = end
  }
  return result
}

function validateFormatOptions(options: OfficeFormatOptions): string[] {
  const applied: string[] = []
  if (options.bold !== undefined) applied.push(options.bold ? 'bold' : 'bold-off')
  if (options.italic !== undefined) applied.push(options.italic ? 'italic' : 'italic-off')
  if (options.underline !== undefined) applied.push(options.underline === false ? 'underline-off' : 'underline')
  if (options.color !== undefined) applied.push('color')
  if (options.highlight !== undefined) applied.push(options.highlight === 'none' ? 'highlight-off' : 'highlight')
  if (options.fontSize !== undefined) applied.push('fontSize')
  if (options.fontFamily !== undefined) applied.push('fontFamily')
  if (options.align !== undefined) applied.push('align')
  if (options.lineSpacing !== undefined) applied.push('lineSpacing')
  if (options.spaceBefore !== undefined) applied.push('spaceBefore')
  if (options.spaceAfter !== undefined) applied.push('spaceAfter')
  if (applied.length === 0) throw new Error('至少指定一个格式属性')
  return applied
}

export function formatDocxText(buffer: Buffer, options: OfficeFormatOptions): OfficeFormatResult {
  const applied = validateFormatOptions(options)
  const fragments = formatProperties(options)
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(new Uint8Array(buffer))
  } catch {
    throw new Error('docx 文件不是有效的 Office Open XML 压缩包')
  }
  const documentBytes = files['word/document.xml']
  if (!documentBytes) throw new Error('docx 缺少 word/document.xml')
  const documentXml = new TextDecoder().decode(documentBytes)
  const { segment, kind } = locateElementSegment(documentXml, options.elementId)
  let segmentXml = segment.xml
  if (kind === 'paragraph') {
    segmentXml = applyParagraphProperties(segmentXml, options)
    segmentXml = applyParagraphMarkFormatting(segmentXml, options, fragments)
  } else {
    segmentXml = applyParagraphPropertiesToXml(segmentXml, options)
  }
  let runCount = 0
  for (const run of textRunSegments(segmentXml).reverse()) {
    const nextRun = applyRunFormatting(segmentXml.slice(run.start, run.end), options, fragments)
    if (nextRun !== segmentXml.slice(run.start, run.end)) runCount += 1
    segmentXml = segmentXml.slice(0, run.start) + nextRun + segmentXml.slice(run.end)
  }
  const nextDocumentXml = documentXml.slice(0, segment.start) + segmentXml + documentXml.slice(segment.end)
  files['word/document.xml'] = new TextEncoder().encode(nextDocumentXml)
  return {
    buffer: Buffer.from(zipSync(files, { level: 6 })),
    elementId: options.elementId,
    kind,
    applied,
    runCount,
  }
}

/* ---------------- docx 批注：comments.xml + document.xml 范围标记 ---------------- */

const COMMENTS_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments'
const COMMENTS_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml'
const DOCX_MAIN_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

export type OfficeCommentAction = 'add' | 'reply' | 'resolve' | 'delete' | 'list'

export interface OfficeCommentOptions {
  /** add / reply / resolve / delete / list，默认 add。 */
  action?: OfficeCommentAction
  /** `pN` 或 `tN-rN-cN`；add 必填。 */
  elementId?: string
  /** 目标批注 ID；reply / resolve / delete 必填。 */
  commentId?: number
  text?: string
  author?: string
  /** 短语范围起始字符偏移（含），只对 add 有效。 */
  start?: number
  /** 短语范围结束字符偏移（不含），只对 add 有效。 */
  end?: number
  /** 按文本定位短语范围，与 start/end 二选一。 */
  oldText?: string
  occurrence?: number
  /** resolve 是否标记为解决，默认 true；false 表示重新打开。 */
  resolved?: boolean
}
export interface DocxCommentSummary {
  id: number
  author: string
  initials: string
  date: string
  text: string
  anchor: string
  paraId: string
  parentId: number | null
  threadRootId: number
  resolved: boolean
  replyCount: number
  durableId: string | null
}

export interface DocxCommentReport {
  comments: DocxCommentSummary[]
  total: number
  open: number
  resolvedCount: number
  threads: number
}

export interface OfficeCommentResult {
  buffer: Buffer
  action: OfficeCommentAction
  changed: boolean
  elementId?: string
  kind?: 'paragraph' | 'table_cell'
  commentId?: number
  parentCommentId?: number
  author?: string
  text?: string
  start?: number
  end?: number
  resolved?: boolean
  replyId?: number
  deletedIds?: number[]
  deletedCommentIds?: number[]
  comments?: DocxCommentSummary[]
  total?: number
  open?: number
  resolvedCount?: number
  threads?: number
  unresolved?: number
}

export interface OfficeCommentAddResult extends OfficeCommentResult {
  elementId: string
  kind: 'paragraph' | 'table_cell'
  commentId: number
  author: string
  text: string
}

export interface OfficeCommentReplyResult extends OfficeCommentResult {
  commentId: number
  parentCommentId: number
  replyId: number
}

export interface OfficeCommentDeleteResult extends OfficeCommentResult {
  commentId: number
  deletedIds: number[]
}

function xmlAttribute(attrs: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`${escaped}\\s*=\\s*"([^"]*)"`, 'i').exec(attrs)
  return match ? decodeXmlText(match[1]) : ''
}

function docxPartPath(target: string): string {
  const clean = target.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!clean) return ''
  if (clean.startsWith('word/')) return clean
  const parts = clean.split('/').filter(Boolean)
  const out = ['word']
  for (const part of parts) {
    if (part === '..') out.pop()
    else if (part !== '.') out.push(part)
  }
  return out.join('/')
}

function ensureCommentsPart(files: Record<string, Uint8Array>): string {
  const contentTypesPath = '[Content_Types].xml'
  let contentTypes = files[contentTypesPath]
    ? new TextDecoder().decode(files[contentTypesPath])
    : `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`
  if (!/<Types\b/i.test(contentTypes)) throw new Error('[Content_Types].xml 结构不完整')

  const relsPath = 'word/_rels/document.xml.rels'
  let rels = files[relsPath]
    ? new TextDecoder().decode(files[relsPath])
    : `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`
  if (!/<Relationships\b/i.test(rels)) throw new Error('word/_rels/document.xml.rels 结构不完整')

  let commentsPath = ''
  const relationships = [...rels.matchAll(/<Relationship\b([^>]*?)\/?>/gi)]
  for (const relationship of relationships) {
    if (xmlAttribute(relationship[1], 'Type') !== COMMENTS_REL_TYPE) continue
    commentsPath = docxPartPath(xmlAttribute(relationship[1], 'Target'))
    break
  }

  if (!commentsPath) {
    let target = 'comments.xml'
    let suffix = 0
    while (files[`word/${target}`]) {
      suffix += 1
      target = `comments${suffix}.xml`
    }
    const ids = new Set(
      relationships.map((relationship) => xmlAttribute(relationship[1], 'Id')).filter(Boolean),
    )
    let id = 'rIdEabComments'
    let idSuffix = 0
    while (ids.has(id)) {
      idSuffix += 1
      id = `rIdEabComments${idSuffix}`
    }
    const rel = `<Relationship Id="${id}" Type="${COMMENTS_REL_TYPE}" Target="${target}"/>`
    rels = rels.replace(/<\/Relationships>/, `${rel}</Relationships>`)
    files[relsPath] = new TextEncoder().encode(rels)
    commentsPath = `word/${target}`
  }
  if (!files[commentsPath]) {
    files[commentsPath] = new TextEncoder().encode(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments xmlns:w="${DOCX_MAIN_NS}"></w:comments>`,
    )
  }
  const partName = `/${commentsPath}`
  if (!new RegExp(`<Override\\b[^>]*PartName="${partName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'i').test(contentTypes)) {
    if (/<\/Types>/.test(contentTypes)) {
      contentTypes = contentTypes.replace(
        /<\/Types>/,
        `<Override PartName="${partName}" ContentType="${COMMENTS_CONTENT_TYPE}"/></Types>`,
      )
    } else if (/<Types\b[^>]*\/>/.test(contentTypes)) {
      contentTypes = contentTypes.replace(
        /<Types\b([^>]*)\/>/,
        `<Types$1><Override PartName="${partName}" ContentType="${COMMENTS_CONTENT_TYPE}"/></Types>`,
      )
    } else {
      throw new Error('[Content_Types].xml 缺少结束标签')
    }
    files[contentTypesPath] = new TextEncoder().encode(contentTypes)
  }
  if (!files[commentsPath]) throw new Error(`docx 缺少批注部件 ${commentsPath}`)
  return commentsPath
}

const W14_NS = 'http://schemas.microsoft.com/office/word/2010/wordml'

function nextCommentId(commentsXml: string): number {
  let max = 0
  const re = /<w:comment\b[^>]*w:id="(\d+)"/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(commentsXml))) max = Math.max(max, Number.parseInt(match[1], 10))
  return max + 1
}

function xmlAttributeExists(attrs: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${escaped}\\s*=\\s*"`, 'i').test(attrs)
}

function ensureCommentRoot(xml: string): string {
  let next = xml
  if (/<w:comments\b[^>]*\/>/.test(next)) {
    next = next.replace(/<w:comments\b([^>]*)\/>/i, '<w:comments$1></w:comments>')
  }
  if (!/xmlns:w14\s*=/.test(next)) {
    next = next.replace(/<w:comments\b([^>]*)>/i, `<w:comments$1 xmlns:w14="${W14_NS}">`)
  }
  return next
}

function relatedPartPath(files: Record<string, Uint8Array>, relType: string, fallback: string): string {
  const rels = files['word/_rels/document.xml.rels']
  if (rels) {
    const relsXml = new TextDecoder().decode(rels)
    for (const relationship of [...relsXml.matchAll(/<Relationship\b([^>]*?)\/?>/gi)]) {
      if (xmlAttribute(relationship[1], 'Type') !== relType) continue
      return docxPartPath(xmlAttribute(relationship[1], 'Target'))
    }
  }
  return files[fallback] ? fallback : ''
}

function ensureContentTypeEntry(files: Record<string, Uint8Array>, partPath: string, contentType: string): void {
  const contentTypesPath = '[Content_Types].xml'
  let contentTypes = files[contentTypesPath]
    ? new TextDecoder().decode(files[contentTypesPath])
    : `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`
  if (!/<Types\b/i.test(contentTypes)) throw new Error('[Content_Types].xml 结构不完整')
  const partName = `/${partPath}`
  const present = new RegExp(
    `<Override\\b[^>]*PartName="${partName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`,
    'i',
  ).test(contentTypes)
  if (present) return
  if (/<\/Types>/.test(contentTypes)) {
    contentTypes = contentTypes.replace(
      /<\/Types>/,
      `<Override PartName="${partName}" ContentType="${contentType}"/></Types>`,
    )
  } else if (/<Types\b[^>]*\/>/.test(contentTypes)) {
    contentTypes = contentTypes.replace(
      /<Types\b([^>]*)\/>/,
      `<Types$1><Override PartName="${partName}" ContentType="${contentType}"/></Types>`,
    )
  } else {
    throw new Error('[Content_Types].xml 缺少结束标签')
  }
  files[contentTypesPath] = new TextEncoder().encode(contentTypes)
}

function ensureRelatedCommentsPart(
  files: Record<string, Uint8Array>,
  relType: string,
  contentType: string,
  baseName: string,
  rootXml: string,
): string {
  const relsPath = 'word/_rels/document.xml.rels'
  let rels = files[relsPath]
    ? new TextDecoder().decode(files[relsPath])
    : `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`
  if (!/<Relationships\b/i.test(rels)) throw new Error('word/_rels/document.xml.rels 结构不完整')

  let partPath = ''
  const relationships = [...rels.matchAll(/<Relationship\b([^>]*?)\/?>/gi)]
  for (const relationship of relationships) {
    if (xmlAttribute(relationship[1], 'Type') !== relType) continue
    partPath = docxPartPath(xmlAttribute(relationship[1], 'Target'))
    break
  }

  if (!partPath) {
    let target = baseName
    let suffix = 0
    while (files[`word/${target}`]) {
      suffix += 1
      target = `${baseName.replace(/\.xml$/i, '')}${suffix}.xml`
    }
    const ids = new Set(relationships.map((relationship) => xmlAttribute(relationship[1], 'Id')).filter(Boolean))
    const idBase = `rIdEab${baseName.replace(/\W+/g, '')}`
    let id = idBase
    let idSuffix = 0
    while (ids.has(id)) {
      idSuffix += 1
      id = `${idBase}${idSuffix}`
    }
    rels = rels.replace(
      /<\/Relationships>/,
      `<Relationship Id="${id}" Type="${relType}" Target="${target}"/></Relationships>`,
    )
    files[relsPath] = new TextEncoder().encode(rels)
    partPath = `word/${target}`
  }

  if (!files[partPath]) files[partPath] = new TextEncoder().encode(rootXml)
  ensureContentTypeEntry(files, partPath, contentType)
  return partPath
}

function ensureCommentsExtendedPart(files: Record<string, Uint8Array>): string {
  return ensureRelatedCommentsPart(
    files,
    'http://schemas.microsoft.com/office/2011/relationships/commentsExtended',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml',
    'commentsExtended.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"></w15:commentsEx>`,
  )
}

function ensureCommentsIdsPart(files: Record<string, Uint8Array>): string {
  return ensureRelatedCommentsPart(
    files,
    'http://schemas.microsoft.com/office/2016/09/relationships/commentsIds',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.commentsIds+xml',
    'commentsIds.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w16cid:commentsIds xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid"></w16cid:commentsIds>`,
  )
}

function nextParaId(commentsXml: string, seed: number): string {
  const used = new Set(
    [...commentsXml.matchAll(/w14:paraId="([0-9A-Fa-f]{8})"/gi)].map((match) => match[1].toUpperCase()),
  )
  let value = (0x40000000 + seed) >>> 0
  let candidate = value.toString(16).toUpperCase().padStart(8, '0')
  while (used.has(candidate)) {
    value = (value + 1) >>> 0
    candidate = value.toString(16).toUpperCase().padStart(8, '0')
  }
  return candidate
}

function nextDurableId(commentsIdsXml: string, seed: number): string {
  const used = new Set(
    [...commentsIdsXml.matchAll(/w16cid:durableId="([0-9A-Fa-f]{8})"/gi)].map((match) => match[1].toUpperCase()),
  )
  let value = (0x50000000 + seed) >>> 0
  let candidate = value.toString(16).toUpperCase().padStart(8, '0')
  while (used.has(candidate)) {
    value = (value + 1) >>> 0
    candidate = value.toString(16).toUpperCase().padStart(8, '0')
  }
  return candidate
}

function commentBlockOf(commentsXml: string, id: number): string {
  const re = new RegExp(`<w:comment\\b[^>]*w:id="${id}"[^>]*>[\\s\\S]*?</w:comment>`, 'i')
  const match = re.exec(commentsXml)
  if (!match) throw new Error(`没有找到批注 id=${id}`)
  return match[0]
}

function commentParaId(commentsXml: string, id: number): string {
  const block = commentBlockOf(commentsXml, id)
  const paragraph = /<w:p\b([^>]*)>/i.exec(block)
  return paragraph ? xmlAttribute(paragraph[1], 'w14:paraId') : ''
}

function ensureCommentParaId(commentsXml: string, id: number): { xml: string; paraId: string } {
  let xml = ensureCommentRoot(commentsXml)
  const existing = commentParaId(xml, id)
  if (existing) return { xml, paraId: existing }
  const block = commentBlockOf(xml, id)
  const paragraph = /<w:p\b([^>]*)>/i.exec(block)
  if (!paragraph) throw new Error(`批注 id=${id} 没有段落，无法生成 paraId`)
  const paraId = nextParaId(xml, id)
  const replacement = block.replace(
    paragraph[0],
    paragraph[0].trimEnd().endsWith('/>')
      ? `<w:p${paragraph[1].replace(/\/$/, '')} w14:paraId="${paraId}"></w:p>`
      : `<w:p${paragraph[1]} w14:paraId="${paraId}">`,
  )
  xml = xml.replace(block, replacement)
  return { xml, paraId }
}

function commentEntryXml(id: number, author: string, text: string, paraId: string, parentId?: number): string {
  const preserve = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : ''
  void parentId
  return (
    `<w:comment w:id="${id}" w:author="${encodeXmlText(author)}" ` +
    `w:initials="${encodeXmlText(author.slice(0, 8))}" w:date="${new Date().toISOString()}">` +
    `<w:p w14:paraId="${paraId}" w14:textId="77777777">` +
    `<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:annotationRef/></w:r>` +
    `<w:r><w:t${preserve}>${encodeXmlText(text)}</w:t></w:r>` +
    `</w:p></w:comment>`
  )
}

function appendCommentEx(xml: string, paraId: string, parentParaId: string | undefined, done: boolean): string {
  if (!/<\/w15:commentsEx>/.test(xml)) throw new Error('commentsExtended.xml 结构不完整')
  const parent = parentParaId ? ` w15:paraIdParent="${parentParaId}"` : ''
  return xml.replace(
    /<\/w15:commentsEx>/,
    `<w15:commentEx w15:paraId="${paraId}"${parent} w15:done="${done ? '1' : '0'}"/></w15:commentsEx>`,
  )
}

function appendCommentId(xml: string, paraId: string, durableId: string): string {
  if (!/<\/w16cid:commentsIds>/.test(xml)) throw new Error('commentsIds.xml 结构不完整')
  return xml.replace(
    /<\/w16cid:commentsIds>/,
    `<w16cid:commentId w16cid:paraId="${paraId}" w16cid:durableId="${durableId}"/></w16cid:commentsIds>`,
  )
}

function commentExEntries(xml: string): Array<{ paraId: string; parentParaId: string; done: boolean }> {
  const result: Array<{ paraId: string; parentParaId: string; done: boolean }> = []
  for (const match of xml.matchAll(/<w15:commentEx\b([^>]*?)\/?>/gi)) {
    const attrs = match[1]
    const paraId = xmlAttribute(attrs, 'w15:paraId').toUpperCase()
    if (!paraId) continue
    const doneValue = xmlAttribute(attrs, 'w15:done').toLowerCase()
    result.push({
      paraId,
      parentParaId: xmlAttribute(attrs, 'w15:paraIdParent').toUpperCase(),
      done: doneValue === '1' || doneValue === 'true' || doneValue === 'on',
    })
  }
  return result
}

function commentIdsEntries(xml: string): Array<{ paraId: string; durableId: string }> {
  const result: Array<{ paraId: string; durableId: string }> = []
  for (const match of xml.matchAll(/<w16cid:commentId\b([^>]*?)\/?>/gi)) {
    const paraId = xmlAttribute(match[1], 'w16cid:paraId').toUpperCase()
    if (paraId) {
      result.push({ paraId, durableId: xmlAttribute(match[1], 'w16cid:durableId').toUpperCase() })
    }
  }
  return result
}

function ensureCommentExEntry(
  xml: string,
  paraId: string,
  parentParaId: string | undefined,
  done: boolean,
): string {
  const re = new RegExp(`<w15:commentEx\\b[^>]*w15:paraId="${paraId}"[^>]*\\/?>`, 'i')
  const match = re.exec(xml)
  if (!match) return appendCommentEx(xml, paraId, parentParaId, done)
  let attrs = match[0].slice('<w15:commentEx'.length, match[0].indexOf('>')).replace(/\/$/, '')
  if (attrs.match(/w15:done\s*=\s*"[^"]*"/i)) {
    attrs = attrs.replace(/w15:done\s*=\s*"[^"]*"/i, `w15:done="${done ? '1' : '0'}"`)
  } else {
    attrs += ` w15:done="${done ? '1' : '0'}"`
  }
  if (parentParaId && !xmlAttributeExists(attrs, 'w15:paraIdParent')) {
    attrs += ` w15:paraIdParent="${parentParaId}"`
  }
  return xml.replace(match[0], `<w15:commentEx${attrs}/>`)
}

function ensureCommentIdEntry(xml: string, paraId: string, durableId: string): string {
  const re = new RegExp(`<w16cid:commentId\\b[^>]*w16cid:paraId="${paraId}"[^>]*\\/?>`, 'i')
  return re.test(xml) ? xml : appendCommentId(xml, paraId, durableId)
}

function parseDocxComments(commentsXml: string, documentXml: string): DocxCommentSummary[] {
  const parsed: Array<{
    id: number
    author: string
    initials: string
    date: string
    text: string
    paraId: string
    resolved: boolean
  }> = []
  for (const match of commentsXml.matchAll(/<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/gi)) {
    const attrs = match[1]
    const id = Number.parseInt(xmlAttribute(attrs, 'w:id'), 10)
    if (!Number.isFinite(id)) continue
    const paragraph = /<w:p\b([^>]*)>/i.exec(match[2])
    parsed.push({
      id,
      author: xmlAttribute(attrs, 'w:author') || '未知作者',
      initials: xmlAttribute(attrs, 'w:initials'),
      date: xmlAttribute(attrs, 'w:date'),
      text: textOfXml(match[2]).trim(),
      paraId: paragraph ? xmlAttribute(paragraph[1], 'w14:paraId').toUpperCase() : '',
      resolved: false,
    })
  }
  return parsed.map((comment) => ({
    ...comment,
    anchor: commentAnchor(documentXml, comment.id),
    parentId: null,
    threadRootId: comment.id,
    resolved: false,
    replyCount: 0,
    durableId: null,
  }))
}

function commentAnchor(documentXml: string, id: number): string {
  const startRe = new RegExp(`<w:commentRangeStart\\b[^>]*w:id="${id}"[^>]*/>`, 'i')
  const endRe = new RegExp(`<w:commentRangeEnd\\b[^>]*w:id="${id}"[^>]*/>`, 'i')
  const start = startRe.exec(documentXml)
  if (!start) return ''
  const rest = documentXml.slice(start.index + start[0].length)
  const end = endRe.exec(rest)
  if (!end) return ''
  return textOfXml(rest.slice(0, end.index)).trim()
}

function completeCommentThreads(
  comments: Array<Omit<DocxCommentSummary, 'parentId' | 'threadRootId' | 'resolved' | 'durableId' | 'replyCount'>>,
  exEntries: Array<{ paraId: string; parentParaId: string; done: boolean }>,
  idEntries: Array<{ paraId: string; durableId: string }>,
): DocxCommentSummary[] {
  const byPara = new Map<string, (typeof comments)[number]>()
  for (const comment of comments) if (comment.paraId) byPara.set(comment.paraId, comment)
  const exByPara = new Map(exEntries.map((entry) => [entry.paraId, entry]))
  const durableByPara = new Map(idEntries.map((entry) => [entry.paraId, entry.durableId]))
  const completed = comments.map((comment) => {
    const ex = comment.paraId ? exByPara.get(comment.paraId) : undefined
    const parent = ex?.parentParaId ? byPara.get(ex.parentParaId) : undefined
    let rootId = comment.id
    const visited = new Set<number>()
    let cursor = parent
    while (cursor && !visited.has(cursor.id)) {
      visited.add(cursor.id)
      rootId = cursor.id
      const cursorEx = cursor.paraId ? exByPara.get(cursor.paraId) : undefined
      cursor = cursorEx?.parentParaId ? byPara.get(cursorEx.parentParaId) : undefined
    }
    return {
      ...comment,
      parentId: parent?.id ?? null,
      threadRootId: rootId,
      resolved: ex?.done ?? false,
      durableId: comment.paraId ? durableByPara.get(comment.paraId) ?? null : null,
      replyCount: 0,
    }
  })
  const replyCounts = new Map<number, number>()
  for (const comment of completed) {
    if (comment.parentId !== null) replyCounts.set(comment.parentId, (replyCounts.get(comment.parentId) ?? 0) + 1)
  }
  return completed.map((comment) => ({ ...comment, replyCount: replyCounts.get(comment.id) ?? 0 }))
}

function commentsPartOf(files: Record<string, Uint8Array>): { path: string; xml: string } | undefined {
  const path = relatedPartPath(files, COMMENTS_REL_TYPE, 'word/comments.xml')
  if (!path || !files[path]) return undefined
  return { path, xml: new TextDecoder().decode(files[path]) }
}

function extendedPartOf(files: Record<string, Uint8Array>): { path: string; xml: string } | undefined {
  const path = relatedPartPath(
    files,
    'http://schemas.microsoft.com/office/2011/relationships/commentsExtended',
    'word/commentsExtended.xml',
  )
  if (!path || !files[path]) return undefined
  return { path, xml: new TextDecoder().decode(files[path]) }
}

function idsPartOf(files: Record<string, Uint8Array>): { path: string; xml: string } | undefined {
  const path = relatedPartPath(
    files,
    'http://schemas.microsoft.com/office/2016/09/relationships/commentsIds',
    'word/commentsIds.xml',
  )
  if (!path || !files[path]) return undefined
  return { path, xml: new TextDecoder().decode(files[path]) }
}

export function readDocxComments(buffer: Buffer): DocxCommentReport {
  const files = readDocxFiles(buffer)
  const commentsPart = commentsPartOf(files)
  if (!commentsPart) {
    return {
      comments: [],
      total: 0,
      open: 0,
      resolvedCount: 0,
      threads: 0,
    }
  }
  const documentXml = readDocumentXml(files)
  const base = parseDocxComments(commentsPart.xml, documentXml)
  const extended = extendedPartOf(files)
  const ids = idsPartOf(files)
  const comments = completeCommentThreads(
    base.map((comment) => ({
      id: comment.id,
      author: comment.author,
      initials: comment.initials,
      date: comment.date,
      text: comment.text,
      anchor: comment.anchor,
      paraId: comment.paraId,
    })),
    extended ? commentExEntries(extended.xml) : [],
    ids ? commentIdsEntries(ids.xml) : [],
  )
  const replyCounts = new Map<number, number>()
  for (const comment of comments) {
    if (comment.parentId !== null) {
      replyCounts.set(comment.parentId, (replyCounts.get(comment.parentId) ?? 0) + 1)
    }
  }
  const withReplyCount = comments.map((comment) => ({
    ...comment,
    replyCount: replyCounts.get(comment.id) ?? 0,
  }))
  const resolvedCount = withReplyCount.filter((comment) => comment.resolved).length
  const roots = new Set(withReplyCount.map((comment) => comment.threadRootId))
  return {
    comments: withReplyCount,
    total: withReplyCount.length,
    open: withReplyCount.length - resolvedCount,
    resolvedCount,
    threads: roots.size,
  }
}

function commentRangeOffsets(
  segmentXml: string,
  options: OfficeCommentOptions,
): { start: number; end: number } | undefined {
  const hasPhrase = typeof options.oldText === 'string'
  const hasOffsets = options.start !== undefined || options.end !== undefined
  if (!hasPhrase && !hasOffsets) return undefined
  if (hasPhrase && hasOffsets) throw new Error('oldText 和 start/end 只能二选一')
  if (/<w:(?:br|tab)\b/i.test(segmentXml)) throw new Error('批注短语范围暂不支持含换行或制表符的元素')
  const runs = runSegmentsOf(segmentXml)
  if (runs.length === 0) throw new Error('目标元素没有可批注的文本')
  const totalLength = runs[runs.length - 1].textEnd
  let start = 0
  let end = totalLength
  if (hasPhrase) {
    const phrase = String(options.oldText)
    if (!phrase) throw new Error('oldText 不能为空')
    const matches: number[] = []
    let from = 0
    while (from < totalLength) {
      const found = runs.map((run) => run.text).join('').indexOf(phrase, from)
      if (found < 0) break
      matches.push(found)
      from = found + Math.max(1, phrase.length)
    }
    if (matches.length === 0) throw new Error(`目标元素中没有找到 oldText: ${phrase}`)
    const occurrence = options.occurrence ?? 1
    if (occurrence === 0) throw new Error('批注暂不支持 occurrence=0；请指定单处')
    if (occurrence < 1 || occurrence > matches.length) {
      throw new Error(`oldText 命中 ${matches.length} 次，occurrence=${occurrence} 超出范围`)
    }
    if (matches.length > 1 && options.occurrence === undefined) {
      throw new Error(`oldText 命中 ${matches.length} 次，请指定 occurrence（1 起）`)
    }
    start = matches[occurrence - 1]
    end = start + phrase.length
  } else {
    if (options.start === undefined || options.end === undefined) {
      throw new Error('start 和 end 必须同时提供')
    }
    start = options.start
    end = options.end
  }
  if (!Number.isInteger(start) || !Number.isInteger(end)) throw new Error('start/end 必须是整数偏移')
  if (start < 0 || end <= start || end > totalLength) {
    throw new Error(`批注范围必须在 0 到 ${totalLength} 之间，且 start 小于 end`)
  }
  return { start, end }
}

function commentStartXml(id: number): string {
  return `<w:commentRangeStart w:id="${id}"/>`
}

function commentEndAndReferenceXml(id: number): string {
  return `<w:commentRangeEnd w:id="${id}"/><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${id}"/></w:r>`
}

function paragraphCommentStart(xml: string, paragraphStart: number, id: number): string {
  const openEnd = xml.indexOf('>', paragraphStart)
  if (openEnd < 0) throw new Error('批注目标段落结构不完整')
  let at = openEnd + 1
  const pPr = findOpen(xml, 'w:pPr', at)
  if (pPr >= 0) {
    const pPrOpenEnd = xml.indexOf('>', pPr) + 1
    const pPrOpenTag = xml.slice(pPr, pPrOpenEnd)
    at = pPrOpenTag.trimEnd().endsWith('/>') ? pPrOpenEnd : matchingClose(xml, pPr, 'w:pPr')
  }
  return xml.slice(0, at) + commentStartXml(id) + xml.slice(at)
}

function paragraphCommentEnd(xml: string, paragraphStart: number, id: number): string {
  const close = xml.indexOf('</w:p>', paragraphStart)
  if (close < 0) throw new Error('批注目标段落缺少结束标签')
  return xml.slice(0, close) + commentEndAndReferenceXml(id) + xml.slice(close)
}

function paragraphSegments(xml: string): Array<{ start: number; end: number }> {
  const result: Array<{ start: number; end: number }> = []
  let pos = 0
  while (pos < xml.length) {
    const start = findOpen(xml, 'w:p', pos)
    if (start < 0) break
    const end = matchingClose(xml, start, 'w:p')
    if (end <= start) break
    result.push({ start, end })
    pos = end
  }
  return result
}

function addCommentMarkup(
  documentXml: string,
  elementId: string,
  id: number,
): { xml: string; kind: 'paragraph' | 'table_cell' } {
  const { segment, kind } = locateElementSegment(documentXml, elementId)
  let segmentXml = segment.xml
  if (kind === 'paragraph') {
    segmentXml = paragraphCommentEnd(segmentXml, 0, id)
    segmentXml = paragraphCommentStart(segmentXml, 0, id)
  } else {
    const paragraphs = paragraphSegments(segmentXml)
    if (paragraphs.length === 0) throw new Error(`目标 ${elementId} 中没有可批注的段落`)
    segmentXml = paragraphCommentEnd(segmentXml, paragraphs[paragraphs.length - 1].start, id)
    segmentXml = paragraphCommentStart(segmentXml, paragraphs[0].start, id)
  }
  return {
    xml: documentXml.slice(0, segment.start) + segmentXml + documentXml.slice(segment.end),
    kind,
  }
}

function addCommentRangeMarkup(
  documentXml: string,
  elementId: string,
  id: number,
  options: OfficeCommentOptions,
): { xml: string; kind: 'paragraph' | 'table_cell'; start?: number; end?: number } {
  const { segment, kind } = locateElementSegment(documentXml, elementId)
  const offsets = commentRangeOffsets(segment.xml, options)
  if (!offsets) {
    const marked = addCommentMarkup(documentXml, elementId, id)
    return { xml: marked.xml, kind: marked.kind }
  }
  if (/<w:(?:drawing|fldChar|instrText|object|pict|sym)\b/i.test(segment.xml)) {
    throw new Error('批注短语范围暂不支持含图片、域或特殊符号的元素')
  }
  const runs = runSegmentsOf(segment.xml)
  let startIdx = -1
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index]
    if (offsets.start < run.textEnd || (offsets.start === run.textStart && run.text.length > 0)) {
      startIdx = index
      break
    }
  }
  if (startIdx < 0 && offsets.start === runs[runs.length - 1].textEnd) startIdx = runs.length - 1
  let endIdx = -1
  for (let index = 0; index < runs.length; index += 1) {
    if (offsets.end > runs[index].textStart && offsets.end <= runs[index].textEnd) {
      endIdx = index
      break
    }
  }
  if (endIdx < 0 && offsets.end === runs[runs.length - 1].textEnd) endIdx = runs.length - 1
  if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) throw new Error('批注范围没有落在可定位的文本 run 内')
  const startMarker = commentStartXml(id)
  const endMarker = commentEndAndReferenceXml(id)
  let xml = ''
  let cursor = 0
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index]
    xml += segment.xml.slice(cursor, run.start)
    if (index === startIdx && index === endIdx) {
      const localStart = offsets.start - run.textStart
      const localEnd = offsets.end - run.textStart
      if (localStart > 0) xml += runXmlWithText(run, run.text.slice(0, localStart))
      xml += startMarker
      if (localEnd > localStart) xml += runXmlWithText(run, run.text.slice(localStart, localEnd))
      xml += endMarker
      if (localEnd < run.text.length) xml += runXmlWithText(run, run.text.slice(localEnd))
    } else if (index === startIdx) {
      const localStart = offsets.start - run.textStart
      if (localStart === 0) {
        xml += startMarker + run.xml
      } else if (localStart >= run.text.length) {
        xml += run.xml + startMarker
      } else {
        xml += runXmlWithText(run, run.text.slice(0, localStart)) + startMarker +
          runXmlWithText(run, run.text.slice(localStart))
      }
    } else if (index === endIdx) {
      const localEnd = offsets.end - run.textStart
      if (localEnd >= run.text.length) {
        xml += run.xml + endMarker
      } else if (localEnd <= 0) {
        xml += endMarker + run.xml
      } else {
        xml += runXmlWithText(run, run.text.slice(0, localEnd)) + endMarker +
          runXmlWithText(run, run.text.slice(localEnd))
      }
    } else {
      xml += run.xml
    }
    cursor = run.end
  }
  xml += segment.xml.slice(cursor)
  return {
    xml: documentXml.slice(0, segment.start) + xml + documentXml.slice(segment.end),
    kind,
    start: offsets.start,
    end: offsets.end,
  }
}

export function addDocxComment(buffer: Buffer, options: OfficeCommentOptions): OfficeCommentAddResult {
  const elementId = options.elementId?.trim()
  if (!elementId) throw new Error('elementId 不能为空')
  const text = options.text?.trim()
  if (!text) throw new Error('text 不能为空')
  const author = (options.author ?? 'EAB Agent').trim() || 'EAB Agent'
  const files = readDocxFiles(buffer)
  const documentXml = readDocumentXml(files)
  const commentsPath = ensureCommentsPart(files)
  let commentsXml = ensureCommentRoot(new TextDecoder().decode(files[commentsPath]))
  const commentId = nextCommentId(commentsXml)
  const paraId = nextParaId(commentsXml, commentId)
  commentsXml = commentsXml.replace(
    /<\/w:comments>/,
    `${commentEntryXml(commentId, author, text, paraId)}</w:comments>`,
  )
  files[commentsPath] = new TextEncoder().encode(commentsXml)
  const extendedPath = ensureCommentsExtendedPart(files)
  const idsPath = ensureCommentsIdsPart(files)
  let extendedXml = new TextDecoder().decode(files[extendedPath])
  let idsXml = new TextDecoder().decode(files[idsPath])
  extendedXml = ensureCommentExEntry(extendedXml, paraId, undefined, false)
  idsXml = ensureCommentIdEntry(idsXml, paraId, nextDurableId(idsXml, commentId))
  files[extendedPath] = new TextEncoder().encode(extendedXml)
  files[idsPath] = new TextEncoder().encode(idsXml)
  const marked = addCommentRangeMarkup(documentXml, elementId, commentId, options)
  files['word/document.xml'] = new TextEncoder().encode(marked.xml)
  return {
    buffer: Buffer.from(zipSync(files, { level: 6 })),
    action: 'add',
    changed: true,
    elementId,
    kind: marked.kind,
    commentId,
    author,
    text,
    start: marked.start,
    end: marked.end,
  }
}

export function replyDocxComment(
  buffer: Buffer,
  options: { commentId: number; text: string; author?: string },
): OfficeCommentReplyResult {
  const text = options.text.trim()
  if (!text) throw new Error('text 不能为空')
  const files = readDocxFiles(buffer)
  const commentsPart = commentsPartOf(files)
  if (!commentsPart) throw new Error('docx 缺少批注部件')
  let commentsXml = ensureCommentRoot(commentsPart.xml)
  const parent = commentBlockOf(commentsXml, options.commentId)
  if (!parent) throw new Error(`没有找到批注 id=${options.commentId}`)
  const prepared = ensureCommentParaId(commentsXml, options.commentId)
  commentsXml = prepared.xml
  const parentParaId = prepared.paraId
  const replyId = nextCommentId(commentsXml)
  const replyParaId = nextParaId(commentsXml, replyId)
  const author = (options.author ?? 'EAB Agent').trim() || 'EAB Agent'
  commentsXml = commentsXml.replace(
    /<\/w:comments>/,
    `${commentEntryXml(replyId, author, text, replyParaId, options.commentId)}</w:comments>`,
  )
  files[commentsPart.path] = new TextEncoder().encode(commentsXml)
  const extendedPath = ensureCommentsExtendedPart(files)
  const idsPath = ensureCommentsIdsPart(files)
  let extendedXml = new TextDecoder().decode(files[extendedPath])
  let idsXml = new TextDecoder().decode(files[idsPath])
  extendedXml = ensureCommentExEntry(extendedXml, parentParaId, undefined, false)
  extendedXml = ensureCommentExEntry(extendedXml, replyParaId, parentParaId, false)
  idsXml = ensureCommentIdEntry(idsXml, parentParaId, nextDurableId(idsXml, options.commentId))
  idsXml = ensureCommentIdEntry(idsXml, replyParaId, nextDurableId(idsXml, replyId))
  files[extendedPath] = new TextEncoder().encode(extendedXml)
  files[idsPath] = new TextEncoder().encode(idsXml)
  let documentXml = readDocumentXml(files)
  const parentRef = new RegExp(`<w:commentReference\\b[^>]*w:id="${options.commentId}"[^>]*/>`, 'i')
  const reference = parentRef.exec(documentXml)
  if (!reference) throw new Error(`父批注 id=${options.commentId} 在正文中没有 commentReference，无法建立线程锚点`)
  const runEnd = documentXml.indexOf('</w:r>', reference.index + reference[0].length)
  if (runEnd < 0) throw new Error('父批注 reference run 结构不完整')
  const at = runEnd + '</w:r>'.length
  const anchor =
    `<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr>` +
    `<w:commentRangeStart w:id="${replyId}"/><w:commentRangeEnd w:id="${replyId}"/>` +
    `<w:commentReference w:id="${replyId}"/></w:r>`
  documentXml = documentXml.slice(0, at) + anchor + documentXml.slice(at)
  files['word/document.xml'] = new TextEncoder().encode(documentXml)
  return {
    buffer: Buffer.from(zipSync(files, { level: 6 })),
    action: 'reply',
    changed: true,
    commentId: replyId,
    parentCommentId: options.commentId,
    replyId,
    author,
    text,
  }
}

export function resolveDocxComment(
  buffer: Buffer,
  options: { commentId: number; resolved: boolean },
): OfficeCommentResult {
  const files = readDocxFiles(buffer)
  const commentsPart = commentsPartOf(files)
  if (!commentsPart) throw new Error('docx 缺少批注部件')
  const commentsXml = ensureCommentRoot(commentsPart.xml)
  commentBlockOf(commentsXml, options.commentId)
  const prepared = ensureCommentParaId(commentsXml, options.commentId)
  files[commentsPart.path] = new TextEncoder().encode(prepared.xml)
  const extendedPath = ensureCommentsExtendedPart(files)
  const idsPath = ensureCommentsIdsPart(files)
  let extendedXml = new TextDecoder().decode(files[extendedPath])
  let idsXml = new TextDecoder().decode(files[idsPath])
  extendedXml = ensureCommentExEntry(extendedXml, prepared.paraId, undefined, options.resolved)
  idsXml = ensureCommentIdEntry(idsXml, prepared.paraId, nextDurableId(idsXml, options.commentId))
  files[extendedPath] = new TextEncoder().encode(extendedXml)
  files[idsPath] = new TextEncoder().encode(idsXml)
  return {
    buffer: Buffer.from(zipSync(files, { level: 6 })),
    action: 'resolve',
    changed: true,
    commentId: options.commentId,
    resolved: options.resolved,
  }
}

function removeCommentAnchors(documentXml: string, id: number): string {
  const idPattern = String(id)
  let xml = documentXml
    .replace(new RegExp(`<w:commentRangeStart\\b[^>]*w:id="${idPattern}"[^>]*/>`, 'gi'), '')
    .replace(new RegExp(`<w:commentRangeEnd\\b[^>]*w:id="${idPattern}"[^>]*/>`, 'gi'), '')
    .replace(
      new RegExp(
        `<w:r\\b[^>]*>\\s*(?:<w:rPr\\b[^>]*>(?:(?!</w:r>)[\\s\\S])*?</w:rPr>|<w:rPr\\b[^>]*/>)?\\s*` +
          `<w:commentReference\\b[^>]*w:id="${idPattern}"[^>]*/>\\s*</w:r>`,
        'gi',
      ),
      '',
    )
    .replace(new RegExp(`<w:commentReference\\b[^>]*w:id="${idPattern}"[^>]*/>`, 'gi'), '')
  return xml
}

export function deleteDocxComment(
  buffer: Buffer,
  options: { commentId: number },
): OfficeCommentDeleteResult {
  const files = readDocxFiles(buffer)
  const commentsPart = commentsPartOf(files)
  if (!commentsPart) throw new Error('docx 缺少批注部件')
  const documentXml = readDocumentXml(files)
  const base = parseDocxComments(commentsPart.xml, documentXml)
  if (!base.some((comment) => comment.id === options.commentId)) {
    throw new Error(`没有找到批注 id=${options.commentId}`)
  }
  const extendedPath = ensureCommentsExtendedPart(files)
  const idsPath = ensureCommentsIdsPart(files)
  const extendedXml = new TextDecoder().decode(files[extendedPath])
  const idsXml = new TextDecoder().decode(files[idsPath])
  const exEntries = commentExEntries(extendedXml)
  const complete = completeCommentThreads(
    base.map((comment) => ({
      id: comment.id,
      author: comment.author,
      initials: comment.initials,
      date: comment.date,
      text: comment.text,
      anchor: comment.anchor,
      paraId: comment.paraId,
    })),
    exEntries,
    commentIdsEntries(idsXml),
  )
  const ids = new Set<number>([options.commentId])
  let changed = true
  while (changed) {
    changed = false
    for (const comment of complete) {
      if (comment.parentId !== null && ids.has(comment.parentId) && !ids.has(comment.id)) {
        ids.add(comment.id)
        changed = true
      }
    }
  }
  let commentsXml = commentsPart.xml
  let nextExtended = extendedXml
  let nextIds = idsXml
  let nextDocument = documentXml
  for (const id of ids) {
    const comment = complete.find((item) => item.id === id)
    commentsXml = commentsXml.replace(
      new RegExp(`<w:comment\\b[^>]*w:id="${id}"[^>]*>[\\s\\S]*?</w:comment>`, 'gi'),
      '',
    )
    if (comment?.paraId) {
      const paraId = comment.paraId
      nextExtended = nextExtended.replace(
        new RegExp(`<w15:commentEx\\b[^>]*w15:paraId="${paraId}"[^>]*\\/?>`, 'gi'),
        '',
      )
      nextIds = nextIds.replace(
        new RegExp(`<w16cid:commentId\\b[^>]*w16cid:paraId="${paraId}"[^>]*\\/?>`, 'gi'),
        '',
      )
    }
    nextDocument = removeCommentAnchors(nextDocument, id)
  }
  files[commentsPart.path] = new TextEncoder().encode(commentsXml)
  files[extendedPath] = new TextEncoder().encode(nextExtended)
  files[idsPath] = new TextEncoder().encode(nextIds)
  files['word/document.xml'] = new TextEncoder().encode(nextDocument)
  return {
    buffer: Buffer.from(zipSync(files, { level: 6 })),
    action: 'delete',
    changed: true,
    commentId: options.commentId,
    deletedCommentIds: [...ids].sort((a, b) => a - b),
    deletedIds: [...ids].sort((a, b) => a - b),
  }
}

export function applyDocxComment(buffer: Buffer, options: OfficeCommentOptions): OfficeCommentResult {
  const action = options.action ?? 'add'
  if (action === 'add') return addDocxComment(buffer, options)
  if (action === 'reply') {
    const commentId = Number(options.commentId)
    if (!Number.isInteger(commentId) || commentId <= 0) throw new Error('commentId 必须是正整数')
    return replyDocxComment(buffer, {
      commentId,
      text: options.text ?? '',
      ...(options.author ? { author: options.author } : {}),
    })
  }
  if (action === 'resolve') {
    const commentId = Number(options.commentId)
    if (!Number.isInteger(commentId) || commentId <= 0) throw new Error('commentId 必须是正整数')
    return resolveDocxComment(buffer, {
      commentId,
      resolved: options.resolved !== false,
    })
  }
  if (action === 'delete') {
    const commentId = Number(options.commentId)
    if (!Number.isInteger(commentId) || commentId <= 0) throw new Error('commentId 必须是正整数')
    return deleteDocxComment(buffer, { commentId })
  }
  const report = readDocxComments(buffer)
  return {
    buffer,
    action: 'list',
    changed: false,
    ...report,
  }
}

export function replaceDocxText(buffer: Buffer, options: OfficeReplaceOptions): OfficeReplaceResult {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(new Uint8Array(buffer))
  } catch {
    throw new Error('docx 文件不是有效的 Office Open XML 压缩包')
  }
  const documentBytes = files['word/document.xml']
  if (!documentBytes) throw new Error('docx 缺少 word/document.xml')
  const documentXml = new TextDecoder().decode(documentBytes)
  const { segment, kind } = locateElementSegment(documentXml, options.elementId)
  const nodes = textNodesOf(segment.xml)
  const nodeText = nodes.map((node) => node.text).join('')
  const visibleText = nodeText.trim()
  const baseOffset = nodeText.indexOf(visibleText)
  let start = 0
  let end = visibleText.length
  let replacements = 1

  if (options.oldText !== undefined) {
    const oldText = options.oldText
    if (!oldText) throw new Error('oldText 不能为空；要替换整段请省略 oldText')
    const matches: number[] = []
    let from = 0
    while (from <= visibleText.length) {
      const found = visibleText.indexOf(oldText, from)
      if (found < 0) break
      matches.push(found)
      from = found + Math.max(1, oldText.length)
    }
    if (matches.length === 0) {
      throw new Error(`目标 ${options.elementId} 中没有找到 oldText: ${oldText}`)
    }
    const occurrence = options.occurrence ?? 1
    if (occurrence === 0) {
      replacements = matches.length
    } else {
      if (occurrence < 1 || occurrence > matches.length) {
        throw new Error(`目标 ${options.elementId} 中 oldText 命中 ${matches.length} 次，occurrence=${occurrence} 超出范围`)
      }
      if (matches.length > 1 && options.occurrence === undefined) {
        throw new Error(`目标 ${options.elementId} 中 oldText 命中 ${matches.length} 次，请指定 occurrence（1 起，0 表示全部）`)
      }
      start = matches[occurrence - 1]
      end = start + oldText.length
    }
    if (occurrence === 0) {
      start = matches[matches.length - 1]
      end = start + oldText.length
    }
  } else if (visibleText.length === 0) {
    start = 0
    end = 0
  }

  if (baseOffset < 0) throw new Error(`目标 ${options.elementId} 的文本偏移异常`)
  let changed = false
  if (options.trackChanges) {
    if (options.occurrence === 0) throw new Error('修订写入暂不支持 occurrence=0；请逐处替换')
    const author = (options.author ?? 'EAB Agent').trim() || 'EAB Agent'
    const tracked = trackedReplaceInSegment(
      segment.xml,
      baseOffset + start,
      baseOffset + end,
      options.newText,
      author,
      new Date().toISOString(),
    )
    segment.xml = tracked.xml
    changed = tracked.revisions > 0
  } else if (options.oldText !== undefined && options.occurrence === 0) {
    const matches: number[] = []
    let from = 0
    while (from <= visibleText.length) {
      const found = visibleText.indexOf(options.oldText, from)
      if (found < 0) break
      matches.push(found)
      from = found + Math.max(1, options.oldText.length)
    }
    // 从后往前替换，避免前面的长度变化影响后面的偏移。
    for (const match of [...matches].reverse()) {
      changed = applyReplacement(nodes, baseOffset + match, baseOffset + match + options.oldText.length, options.newText) || changed
    }
  } else if (visibleText.length === 0 && nodes.length === 0) {
    segment.xml = insertTextRun(segment.xml, options.newText, kind)
    changed = options.newText.length > 0
  } else {
    changed = applyReplacement(nodes, baseOffset + start, baseOffset + end, options.newText)
  }

  if (!changed) throw new Error(`目标 ${options.elementId} 没有产生文本变化`)
  let replacedXml = ''
  if (options.trackChanges) {
    replacedXml = segment.xml
  } else {
    let cursor = 0
    for (const node of nodes) {
      replacedXml += segment.xml.slice(cursor, node.start)
      replacedXml += serializeTextNode(node, node.text)
      cursor = node.end
    }
    replacedXml += segment.xml.slice(cursor)
  }
  const nextDocumentXml = documentXml.slice(0, segment.start) + replacedXml + documentXml.slice(segment.end)
  files['word/document.xml'] = new TextEncoder().encode(nextDocumentXml)
  const nextText = textOfXml(replacedXml).trim()
  return {
    buffer: Buffer.from(zipSync(files, { level: 6 })),
    elementId: options.elementId,
    kind,
    previousText: visibleText,
    nextText,
    replacements,
    ...(options.trackChanges ? { tracked: true } : {}),
  }
}

/* ---------------- xlsx：工作表 / 单元格级读取与局部修改 ---------------- */

export interface OfficeXlsxCell {
  id: string
  address: string
  row: number
  column: number
  text: string
  /** true 表示单元格是公式；text 是缓存结果，公式内容需从 newText 以 = 开头改写。 */
  formula?: boolean
}

export interface OfficeXlsxSheet {
  id: string
  name: string
  rows: number
  columns: number
  cellCount: number
  cells: OfficeXlsxCell[]
  truncated: boolean
}

export interface OfficeXlsxOutline {
  fileName: string
  sheetCount: number
  sheets: OfficeXlsxSheet[]
  truncated: boolean
}

export interface OfficeXlsxMatch {
  elementId: string
  sheetId: string
  sheetName: string
  address: string
  row: number
  column: number
  text: string
  formula?: boolean
  start: number
  end: number
  context: string
}

export interface OfficeXlsxReplaceOptions {
  /** `sN-rN-cN`，来自 office.find；N 是工作表序号、行号、列号（均从 1 开始）。 */
  elementId: string
  oldText?: string
  newText: string
  occurrence?: number
}

export interface OfficeXlsxReplaceResult {
  buffer: Buffer
  elementId: string
  kind: 'sheet_cell'
  previousText: string
  nextText: string
  replacements: number
}

interface XlsxSheetRef {
  id: string
  name: string
  path: string
}

interface XlsxCellRef extends OfficeXlsxCell {
  /** 单元格在工作表 XML 中的原始片段和位置，仅替换时使用。 */
  xml: string
  attrs: string
  type: string
  formula: boolean
  start: number
  end: number
}

interface XlsxPackage {
  files: Record<string, Uint8Array>
  sheets: XlsxSheetRef[]
  sharedStrings: string[]
}

function xlsxAttr(attrs: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`${escaped}\\s*=\\s*"([^"]*)"`, 'i').exec(attrs)
  return match ? decodeXmlText(match[1]) : ''
}

function xlsxTextFragment(xml: string): string {
  const parts: string[] = []
  const re = /<t\b[^>]*>([\s\S]*?)<\/t>/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(xml))) parts.push(decodeXmlText(match[1]))
  return parts.join('')
}

function xlsxInnerTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i')
  const match = re.exec(xml)
  return match ? decodeXmlText(match[1]) : ''
}

/** workbook.xml.rels 里的 Target 是相对 xl/ 的路径；统一成 zip 内路径。 */
function xlsxTargetPath(target: string): string {
  const clean = target.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!clean) return ''
  if (clean.startsWith('xl/')) return clean
  const parts = clean.split('/').filter(Boolean)
  const out = ['xl']
  for (const part of parts) {
    if (part === '..') out.pop()
    else if (part !== '.') out.push(part)
  }
  return out.join('/')
}

function xlsxColumnNumber(letters: string): number {
  let result = 0
  for (const char of letters.toUpperCase()) result = result * 26 + (char.charCodeAt(0) - 64)
  return result
}

function xlsxRefOfCell(address: string): { row: number; column: number } | null {
  const match = /^([A-Z]+)(\d+)$/i.exec(address.trim())
  if (!match) return null
  return { row: Number.parseInt(match[2], 10), column: xlsxColumnNumber(match[1]) }
}

function xlsxParseSharedStrings(files: Record<string, Uint8Array>): string[] {
  const bytes = files['xl/sharedStrings.xml']
  if (!bytes) return []
  const xml = new TextDecoder().decode(bytes)
  const result: string[] = []
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(xml))) result.push(xlsxTextFragment(match[1]))
  return result
}

function xlsxParseSheets(files: Record<string, Uint8Array>, workbookXml: string): XlsxSheetRef[] {
  const relsXml = files['xl/_rels/workbook.xml.rels']
    ? new TextDecoder().decode(files['xl/_rels/workbook.xml.rels'])
    : ''
  const relTargets = new Map<string, string>()
  const relRe = /<Relationship\b([^>]*)\/?>/gi
  let relMatch: RegExpExecArray | null
  while ((relMatch = relRe.exec(relsXml))) {
    const id = xlsxAttr(relMatch[1], 'Id')
    const target = xlsxAttr(relMatch[1], 'Target')
    if (id && target) relTargets.set(id, xlsxTargetPath(target))
  }

  const sheets: XlsxSheetRef[] = []
  const sheetRe = /<sheet\b([^>]*)\/?>/gi
  let sheetMatch: RegExpExecArray | null
  while ((sheetMatch = sheetRe.exec(workbookXml))) {
    const name = xlsxAttr(sheetMatch[1], 'name') || `Sheet${sheets.length + 1}`
    const rid = xlsxAttr(sheetMatch[1], 'r:id')
    const fallback = `xl/worksheets/sheet${sheets.length + 1}.xml`
    const path = (rid && relTargets.get(rid)) || fallback
    sheets.push({ id: `s${sheets.length + 1}`, name, path })
  }
  return sheets
}

function xlsxOpenPackage(buffer: Buffer): XlsxPackage {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(new Uint8Array(buffer))
  } catch {
    throw new Error('xlsx 文件不是有效的 Office Open XML 压缩包')
  }
  const workbookBytes = files['xl/workbook.xml']
  if (!workbookBytes) throw new Error('xlsx 缺少 xl/workbook.xml')
  const workbookXml = new TextDecoder().decode(workbookBytes)
  const sheets = xlsxParseSheets(files, workbookXml)
  if (sheets.length === 0) throw new Error('xlsx 中没有工作表')
  return {
    files,
    sheets,
    sharedStrings: xlsxParseSharedStrings(files),
  }
}

function xlsxCellText(type: string, innerXml: string, sharedStrings: string[]): string {
  if (type === 's') {
    const index = Number.parseInt(xlsxInnerTag(innerXml, 'v'), 10)
    return Number.isFinite(index) ? (sharedStrings[index] ?? '') : ''
  }
  if (type === 'inlineStr') return xlsxTextFragment(innerXml)
  return xlsxInnerTag(innerXml, 'v')
}

function xlsxParseCells(
  sheetXml: string,
  sheetIndex: number,
  sharedStrings: string[],
): XlsxCellRef[] {
  const cells: XlsxCellRef[] = []
  const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gi
  let match: RegExpExecArray | null
  while ((match = cellRe.exec(sheetXml))) {
    const attrs = match[1] ?? ''
    const address = xlsxAttr(attrs, 'r')
    const position = xlsxRefOfCell(address)
    if (!position) continue
    const innerXml = match[2] ?? ''
    const type = xlsxAttr(attrs, 't')
    cells.push({
      id: `s${sheetIndex}-r${position.row}-c${position.column}`,
      address,
      row: position.row,
      column: position.column,
      text: xlsxCellText(type, innerXml, sharedStrings),
      xml: match[0],
      attrs,
      type,
      formula: /<f\b/i.test(innerXml),
      start: match.index,
      end: match.index + match[0].length,
    })
  }
  return cells
}

function xlsxLoadSheets(
  pkg: XlsxPackage,
): Array<{ ref: XlsxSheetRef; cells: XlsxCellRef[] }> {
  return pkg.sheets.map((ref, index) => {
    const bytes = pkg.files[ref.path]
    const sheetXml = bytes ? new TextDecoder().decode(bytes) : ''
    return { ref, cells: xlsxParseCells(sheetXml, index + 1, pkg.sharedStrings) }
  })
}

export function readXlsxOutline(buffer: Buffer, maxCells = 200): OfficeXlsxOutline {
  const pkg = xlsxOpenPackage(buffer)
  const limit = Math.max(1, Math.min(1000, maxCells))
  const sheetsData = xlsxLoadSheets(pkg)
  const totalCells = sheetsData.reduce((sum, item) => sum + item.cells.length, 0)
  let remaining = limit
  const sheets = sheetsData.map(({ ref, cells }) => {
    const shown = cells.slice(0, Math.max(0, remaining))
    remaining -= shown.length
    return {
      id: ref.id,
      name: ref.name,
      rows: cells.reduce((max, cell) => Math.max(max, cell.row), 0),
      columns: cells.reduce((max, cell) => Math.max(max, cell.column), 0),
      cellCount: cells.length,
      cells: shown.map((cell) => ({
        id: cell.id,
        address: cell.address,
        row: cell.row,
        column: cell.column,
        text: cell.text,
        formula: cell.formula,
      })),
      truncated: shown.length < cells.length,
    }
  })
  return {
    fileName: '',
    sheetCount: sheets.length,
    sheets,
    truncated: totalCells > limit,
  }
}

export function findInXlsx(
  buffer: Buffer,
  query: string,
  options: { regex?: boolean; limit?: number } = {},
): OfficeXlsxMatch[] {
  const limit = Math.max(1, Math.min(100, options.limit ?? 20))
  let matcher: RegExp
  if (options.regex) {
    try {
      matcher = new RegExp(query, 'gi')
    } catch {
      throw new Error(`正则表达式无效: ${query}`)
    }
  } else {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    matcher = new RegExp(escaped, 'gi')
  }

  const pkg = xlsxOpenPackage(buffer)
  const matches: OfficeXlsxMatch[] = []
  for (const { ref, cells } of xlsxLoadSheets(pkg)) {
    for (const cell of cells) {
      matcher.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = matcher.exec(cell.text))) {
        const start = match.index
        const end = start + match[0].length
        matches.push({
          elementId: cell.id,
          sheetId: ref.id,
          sheetName: ref.name,
          address: cell.address,
          row: cell.row,
          column: cell.column,
          text: cell.text,
          formula: cell.formula,
          start,
          end,
          context: cell.text.slice(Math.max(0, start - 40), Math.min(cell.text.length, end + 40)),
        })
        if (matches.length >= limit) return matches
        if (match[0].length === 0) matcher.lastIndex += 1
      }
    }
  }
  return matches
}

function xlsxReplaceValue(
  text: string,
  oldText: string | undefined,
  newText: string,
  occurrence: number | undefined,
): { nextText: string; replacements: number } {
  if (oldText === undefined) return { nextText: newText, replacements: 1 }
  if (!oldText) throw new Error('oldText 不能为空；要替换整个单元格请省略 oldText')
  const matches: number[] = []
  let from = 0
  while (from <= text.length) {
    const found = text.indexOf(oldText, from)
    if (found < 0) break
    matches.push(found)
    from = found + Math.max(1, oldText.length)
  }
  if (matches.length === 0) throw new Error(`目标单元格中没有找到 oldText: ${oldText}`)
  const selected = occurrence ?? 1
  if (selected === 0) {
    return { nextText: text.split(oldText).join(newText), replacements: matches.length }
  }
  if (selected < 1 || selected > matches.length) {
    throw new Error(`目标单元格中 oldText 命中 ${matches.length} 次，occurrence=${selected} 超出范围`)
  }
  if (matches.length > 1 && occurrence === undefined) {
    throw new Error(`目标单元格中 oldText 命中 ${matches.length} 次，请指定 occurrence（1 起，0 表示全部）`)
  }
  const start = matches[selected - 1]
  return {
    nextText: `${text.slice(0, start)}${newText}${text.slice(start + oldText.length)}`,
    replacements: 1,
  }
}

function xlsxColumnLetters(column: number): string {
  let value = Math.max(1, Math.floor(column))
  let letters = ''
  while (value > 0) {
    const remainder = (value - 1) % 26
    letters = String.fromCharCode(65 + remainder) + letters
    value = Math.floor((value - 1) / 26)
  }
  return letters
}

function xlsxNumericText(text: string): boolean {
  const trimmed = text.trim()
  return trimmed !== '' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)
}

function xlsxCellXmlForAddress(address: string, text: string): string {
  if (xlsxNumericText(text)) {
    return `<c r="${address}"><v>${encodeXmlText(text.trim())}</v></c>`
  }
  const preserve = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : ''
  return `<c r="${address}" t="inlineStr"><is><t${preserve}>${encodeXmlText(text)}</t></is></c>`
}

/** 把空单元格插到目标行；行按列号有序，缺失行按行号插入，保持工作表行顺序。 */
function xlsxInsertCellXml(
  sheetXml: string,
  sheetIndex: number,
  row: number,
  column: number,
  cellXml: string,
  sharedStrings: string[],
): string {
  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/gi
  let rowMatch: RegExpExecArray | null
  let insertAt = -1
  while ((rowMatch = rowRe.exec(sheetXml))) {
    const rowNumber = Number.parseInt(xlsxAttr(rowMatch[1] ?? '', 'r'), 10)
    if (rowNumber !== row) {
      // 目标行不存在时，必须插到第一个更大行号之前，不能一律追加到 sheetData 末尾。
      if (Number.isFinite(rowNumber) && rowNumber > row) insertAt = rowMatch.index
      if (insertAt >= 0) break
      continue
    }
    const rowXml = rowMatch[0]
    if (/\/\s*>$/.test(rowXml.trim())) {
      const openTag = rowXml.replace(/\/\s*>$/, '>')
      const replacement = `${openTag}${cellXml}</row>`
      return `${sheetXml.slice(0, rowMatch.index)}${replacement}${sheetXml.slice(rowMatch.index + rowXml.length)}`
    }
    const inner = rowMatch[2] ?? ''
    const existing = xlsxParseCells(inner, sheetIndex, sharedStrings)
    const next = existing.find((item) => item.column > column)
    const offset = next ? next.start : inner.length
    const nextInner = `${inner.slice(0, offset)}${cellXml}${inner.slice(offset)}`
    const openEnd = rowXml.indexOf('>') + 1
    const closeStart = rowXml.lastIndexOf('</row>')
    const replacement = `${rowXml.slice(0, openEnd)}${nextInner}${rowXml.slice(closeStart)}`
    return `${sheetXml.slice(0, rowMatch.index)}${replacement}${sheetXml.slice(rowMatch.index + rowXml.length)}`
  }

  const sheetEnd = sheetXml.lastIndexOf('</sheetData>')
  if (sheetEnd < 0) throw new Error('xlsx 工作表缺少 sheetData，无法写入空单元格')
  const rowXml = `<row r="${row}">${cellXml}</row>`
  const offset = insertAt >= 0 ? insertAt : sheetEnd
  return `${sheetXml.slice(0, offset)}${rowXml}${sheetXml.slice(offset)}`
}

function xlsxCellXmlWithText(cell: XlsxCellRef, text: string): string {
  if (cell.formula) {
    const formula = text.trim()
    if (!formula.startsWith('=')) {
      throw new Error(`目标单元格 ${cell.address} 含公式；如要改公式请让 newText 以 = 开头，避免把公式静默改成静态值`)
    }
    const attrs = cell.attrs.replace(/\s*\/$/, '')
    return `<c${attrs}><f>${encodeXmlText(formula.slice(1))}</f></c>`
  }
  const attrs = cell.attrs
    .replace(/\s+t\s*=\s*"[^"]*"/i, '')
    .replace(/\s*\/$/, '')
  if (xlsxNumericText(text) && cell.type !== 's' && cell.type !== 'inlineStr' && cell.type !== 'str') {
    return `<c${attrs}><v>${encodeXmlText(text.trim())}</v></c>`
  }
  const preserve = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : ''
  if (cell.type === 'str') {
    return `<c${attrs} t="str"><v>${encodeXmlText(text)}</v></c>`
  }
  return `<c${attrs} t="inlineStr"><is><t${preserve}>${encodeXmlText(text)}</t></is></c>`
}


export function replaceXlsxCellText(
  buffer: Buffer,
  options: OfficeXlsxReplaceOptions,
): OfficeXlsxReplaceResult {
  const refMatch = /^s(\d+)-r(\d+)-c(\d+)$/i.exec(options.elementId)
  if (!refMatch) throw new Error(`无法识别的 xlsx 单元格 ID: ${options.elementId}`)
  const sheetIndex = Number.parseInt(refMatch[1], 10)
  const row = Number.parseInt(refMatch[2], 10)
  const column = Number.parseInt(refMatch[3], 10)
  const pkg = xlsxOpenPackage(buffer)
  const sheet = pkg.sheets[sheetIndex - 1]
  if (!sheet) throw new Error(`xlsx 中没有工作表 s${sheetIndex}`)
  const bytes = pkg.files[sheet.path]
  if (!bytes) throw new Error(`xlsx 缺少工作表文件 ${sheet.path}`)
  const sheetXml = new TextDecoder().decode(bytes)
  const cells = xlsxParseCells(sheetXml, sheetIndex, pkg.sharedStrings)
  const cell = cells.find((item) => item.row === row && item.column === column)

  if (!cell) {
    if (options.oldText !== undefined) {
      throw new Error(`工作表 ${sheet.name} 的 ${xlsxColumnLetters(column)}${row} 是空单元格，不能按 oldText 局部替换；请省略 oldText 写入整格`)
    }
    const address = `${xlsxColumnLetters(column)}${row}`
    const nextCellXml = xlsxCellXmlForAddress(address, options.newText)
    const nextSheetXml = xlsxInsertCellXml(
      sheetXml,
      sheetIndex,
      row,
      column,
      nextCellXml,
      pkg.sharedStrings,
    )
    pkg.files[sheet.path] = new TextEncoder().encode(nextSheetXml)
    return {
      buffer: Buffer.from(zipSync(pkg.files, { level: 6 })),
      elementId: options.elementId,
      kind: 'sheet_cell',
      previousText: '',
      nextText: options.newText,
      replacements: 1,
    }
  }

  const { nextText, replacements } = xlsxReplaceValue(
    cell.text,
    options.oldText,
    options.newText,
    options.occurrence,
  )
  if (nextText === cell.text) throw new Error(`目标单元格 ${options.elementId} 没有产生文本变化`)
  const nextCellXml = xlsxCellXmlWithText(cell, nextText)
  const nextSheetXml = `${sheetXml.slice(0, cell.start)}${nextCellXml}${sheetXml.slice(cell.end)}`
  pkg.files[sheet.path] = new TextEncoder().encode(nextSheetXml)
  return {
    buffer: Buffer.from(zipSync(pkg.files, { level: 6 })),
    elementId: options.elementId,
    kind: 'sheet_cell',
    previousText: cell.text,
    nextText,
    replacements,
  }
}

export interface OfficeXlsxInsertOptions {
  /** `sN-rN` 或 `sN-rN-cN`；行号来自 office.read_outline / office.find。 */
  elementId: string
  text: string
  position?: 'before' | 'after'
}

export interface OfficeXlsxInsertResult {
  buffer: Buffer
  elementId: string
  kind: 'sheet_row'
  insertedRow: number
  insertedValues: string[]
}

function xlsxShiftRangeRef(
  ref: string,
  rowInsertAt: number | null,
  columnInsertAt: number | null,
): string {
  const match = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i.exec(ref.trim())
  if (!match) return ref
  const startColumn = xlsxColumnNumber(match[1])
  const startRow = Number.parseInt(match[2], 10)
  const endColumn = match[3] ? xlsxColumnNumber(match[3]) : startColumn
  const endRow = match[4] ? Number.parseInt(match[4], 10) : startRow
  const nextStartColumn = startColumn + (columnInsertAt !== null && startColumn >= columnInsertAt ? 1 : 0)
  const nextEndColumn = endColumn + (columnInsertAt !== null && endColumn >= columnInsertAt ? 1 : 0)
  const nextStartRow = startRow + (rowInsertAt !== null && startRow >= rowInsertAt ? 1 : 0)
  const nextEndRow = endRow + (rowInsertAt !== null && endRow >= rowInsertAt ? 1 : 0)
  const start = `${xlsxColumnLetters(nextStartColumn)}${nextStartRow}`
  const end = `${xlsxColumnLetters(nextEndColumn)}${nextEndRow}`
  return match[3] || match[4] ? `${start}:${end}` : start
}

function xlsxShiftRowXml(rowXml: string, row: number, insertAt: number): string {
  const openMatch = /^<row\b([^>]*?)(\/?)>/i.exec(rowXml)
  if (!openMatch) return rowXml
  const attrs = openMatch[1].replace(/\br\s*=\s*"\d+"/i, `r="${row + 1}"`)
  if (openMatch[2] === '/') return `<row${attrs}/>`
  const inner = rowXml.slice(openMatch[0].length, rowXml.lastIndexOf('</row>'))
  const shiftedInner = inner.replace(
    /(<c\b[^>]*?\br\s*=\s*")([A-Z]+)(\d+)(")/gi,
    (whole, prefix: string, column: string, cellRow: string, quote: string) => {
      const nextRow = Number.parseInt(cellRow, 10)
      return nextRow >= insertAt ? `${prefix}${column}${nextRow + 1}${quote}` : whole
    },
  )
  return `<row${attrs}>${shiftedInner}</row>`
}

export function insertXlsxRow(
  buffer: Buffer,
  options: OfficeXlsxInsertOptions,
): OfficeXlsxInsertResult {
  const refMatch = /^s(\d+)-r(\d+)(?:-c\d+)?$/i.exec(options.elementId)
  if (!refMatch) throw new Error(`无法识别的 xlsx 行 ID: ${options.elementId}`)
  if (options.position && options.position !== 'before' && options.position !== 'after') {
    throw new Error('position 只能是 before 或 after')
  }
  const sheetIndex = Number.parseInt(refMatch[1], 10)
  const targetRow = Number.parseInt(refMatch[2], 10)
  const pkg = xlsxOpenPackage(buffer)
  const sheet = pkg.sheets[sheetIndex - 1]
  if (!sheet) throw new Error(`xlsx 中没有工作表 s${sheetIndex}`)
  const bytes = pkg.files[sheet.path]
  if (!bytes) throw new Error(`xlsx 缺少工作表文件 ${sheet.path}`)
  const sheetXml = new TextDecoder().decode(bytes)
  if (/<f\b/i.test(sheetXml)) {
    throw new Error('工作表包含公式，结构插入会移动公式引用；请先在 Excel 中处理，或用 office.replace 按行号写入缺失行')
  }
  if (/<(dataValidations|conditionalFormatting|tableParts|hyperlinks)\b/i.test(sheetXml)) {
    throw new Error('工作表包含数据验证、条件格式、表格或超链接，结构插入暂不支持，避免引用失效')
  }

  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/gi
  const rows: Array<{ start: number; end: number; row: number; xml: string }> = []
  let rowMatch: RegExpExecArray | null
  while ((rowMatch = rowRe.exec(sheetXml))) {
    const row = Number.parseInt(xlsxAttr(rowMatch[1] ?? '', 'r'), 10)
    if (!Number.isFinite(row) || row < 1) throw new Error('工作表存在缺少行号的 row，无法安全插入')
    rows.push({
      start: rowMatch.index,
      end: rowMatch.index + rowMatch[0].length,
      row,
      xml: rowMatch[0],
    })
  }
  const exists = rows.some((row) => row.row === targetRow)
  const insertAt = exists && options.position !== 'before' ? targetRow + 1 : targetRow
  if (insertAt < 1) throw new Error('插入行号必须从 1 开始')

  const values = options.text === '' ? [] : options.text.split('\t')
  const cells = values
    .map((value, index) => {
      if (value === '') return ''
      const address = `${xlsxColumnLetters(index + 1)}${insertAt}`
      if (xlsxNumericText(value)) return `<c r="${address}"><v>${encodeXmlText(value.trim())}</v></c>`
      const preserve = /^\s|\s$/.test(value) ? ' xml:space="preserve"' : ''
      return `<c r="${address}" t="inlineStr"><is><t${preserve}>${encodeXmlText(value)}</t></is></c>`
    })
    .join('')
  const newRowXml = cells ? `<row r="${insertAt}">${cells}</row>` : `<row r="${insertAt}"/>`

  let output = ''
  let cursor = 0
  let inserted = false
  for (const row of rows) {
    output += sheetXml.slice(cursor, row.start)
    if (!inserted && row.row >= insertAt) {
      output += newRowXml
      inserted = true
    }
    output += row.row >= insertAt ? xlsxShiftRowXml(row.xml, row.row, insertAt) : row.xml
    cursor = row.end
  }
  if (!inserted) {
    const sheetDataEnd = sheetXml.lastIndexOf('</sheetData>')
    if (sheetDataEnd < 0) throw new Error('xlsx 工作表缺少 sheetData，无法插入行')
    output += sheetXml.slice(cursor, sheetDataEnd) + newRowXml
    cursor = sheetDataEnd
  }
  output += sheetXml.slice(cursor)

  output = output.replace(
    /(<dimension\b[^>]*\bref=")([^"]+)(")/i,
    (_whole, prefix: string, ref: string, suffix: string) => `${prefix}${xlsxShiftRangeRef(ref, insertAt, null)}${suffix}`,
  )
  output = output.replace(
    /(<mergeCell\b[^>]*\bref=")([^"]+)(")/gi,
    (_whole, prefix: string, ref: string, suffix: string) => `${prefix}${xlsxShiftRangeRef(ref, insertAt, null)}${suffix}`,
  )
  output = output.replace(
    /(<autoFilter\b[^>]*\bref=")([^"]+)(")/i,
    (_whole, prefix: string, ref: string, suffix: string) => `${prefix}${xlsxShiftRangeRef(ref, insertAt, null)}${suffix}`,
  )

  pkg.files[sheet.path] = new TextEncoder().encode(output)
  return {
    buffer: Buffer.from(zipSync(pkg.files, { level: 6 })),
    elementId: options.elementId,
    kind: 'sheet_row',
    insertedRow: insertAt,
    insertedValues: values,
  }
}

export interface OfficeXlsxInsertColumnOptions {
  /** `sN-rN-cN` 或 `sN-cN`；列号来自 office.read_outline / office.find。 */
  elementId: string
  text: string
  position?: 'before' | 'after'
}

export interface OfficeXlsxInsertColumnResult {
  buffer: Buffer
  elementId: string
  kind: 'sheet_column'
  insertedColumn: number
  insertedValues: string[]
}

function xlsxShiftColumns(
  sheetXml: string,
  insertAt: number,
): string {
  return sheetXml.replace(
    /(<c\b[^>]*?\br\s*=\s*")([A-Z]+)(\d+)(")/gi,
    (whole, prefix: string, column: string, row: string, quote: string) => {
      const columnNumber = xlsxColumnNumber(column)
      return columnNumber >= insertAt
        ? `${prefix}${xlsxColumnLetters(columnNumber + 1)}${row}${quote}`
        : whole
    },
  )
}

function xlsxShiftColWidths(sheetXml: string, insertAt: number): string {
  return sheetXml.replace(/<col\b([^>]*?)(\/?)>/gi, (_whole, attrs: string, closing: string) => {
    let next = attrs
    for (const key of ['min', 'max']) {
      next = next.replace(
        new RegExp(`\\b${key}\\s*=\\s*"(\\d+)"`, 'i'),
        (match, value: string) => {
          const number = Number.parseInt(value, 10)
          return number >= insertAt ? `${key}="${number + 1}"` : match
        },
      )
    }
    return `<col${next}${closing}>`
  })
}

function xlsxShiftRowSpans(sheetXml: string, insertAt: number): string {
  return sheetXml.replace(
    /(<row\b[^>]*?\bspans\s*=\s*")(\d+):(\d+)(")/gi,
    (_whole, prefix: string, min: string, max: string, suffix: string) => {
      const nextMin = Number.parseInt(min, 10) >= insertAt ? Number.parseInt(min, 10) + 1 : Number.parseInt(min, 10)
      const nextMax = Number.parseInt(max, 10) >= insertAt ? Number.parseInt(max, 10) + 1 : Number.parseInt(max, 10)
      return `${prefix}${nextMin}:${nextMax}${suffix}`
    },
  )
}

export function insertXlsxColumn(
  buffer: Buffer,
  options: OfficeXlsxInsertColumnOptions,
): OfficeXlsxInsertColumnResult {
  const refMatch = /^s(\d+)(?:-r\d+)?-c(\d+)$/i.exec(options.elementId)
  if (!refMatch) throw new Error(`无法识别的 xlsx 列 ID: ${options.elementId}`)
  if (options.position && options.position !== 'before' && options.position !== 'after') {
    throw new Error('position 只能是 before 或 after')
  }
  const sheetIndex = Number.parseInt(refMatch[1], 10)
  const targetColumn = Number.parseInt(refMatch[2], 10)
  const pkg = xlsxOpenPackage(buffer)
  const sheet = pkg.sheets[sheetIndex - 1]
  if (!sheet) throw new Error(`xlsx 中没有工作表 s${sheetIndex}`)
  const bytes = pkg.files[sheet.path]
  if (!bytes) throw new Error(`xlsx 缺少工作表文件 ${sheet.path}`)
  const sheetXml = new TextDecoder().decode(bytes)
  if (/<f\b/i.test(sheetXml)) {
    throw new Error('工作表包含公式，结构插入会移动公式引用；请先在 Excel 中处理')
  }
  if (/<(dataValidations|conditionalFormatting|tableParts|hyperlinks)\b/i.test(sheetXml)) {
    throw new Error('工作表包含数据验证、条件格式、表格或超链接，结构插入暂不支持，避免引用失效')
  }
  const cells = xlsxParseCells(sheetXml, sheetIndex, pkg.sharedStrings)
  const rows = cells.reduce((max, cell) => Math.max(max, cell.row), 0)
  const exists = cells.some((cell) => cell.column === targetColumn)
  const insertAt = exists && options.position !== 'before' ? targetColumn + 1 : targetColumn
  if (insertAt < 1) throw new Error('插入列号必须从 1 开始')
  const values = options.text === '' ? [] : options.text.split(/\r?\n/)
  if (values.length > rows) {
    throw new Error(`新列有 ${values.length} 个值，但工作表只有 ${rows} 行；请先在表格末尾补足行`)
  }

  let output = xlsxShiftColumns(sheetXml, insertAt)
  output = xlsxShiftColWidths(output, insertAt)
  output = xlsxShiftRowSpans(output, insertAt)
  const addressPrefix = xlsxColumnLetters(insertAt)
  output = output.replace(
    /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/gi,
    (whole, attrs: string, inner: string | undefined) => {
      const row = Number.parseInt(xlsxAttr(attrs, 'r'), 10)
      const value = values[row - 1]
      if (!value && value !== '0') return whole
      const cellXml = xlsxCellXmlForAddress(`${addressPrefix}${row}`, value)
      const rowInner = inner ?? ''
      const existing = xlsxParseCells(rowInner, sheetIndex, pkg.sharedStrings)
      const next = existing.find((item) => item.column > insertAt)
      const offset = next ? next.start : rowInner.length
      return `<row${attrs}>${rowInner.slice(0, offset)}${cellXml}${rowInner.slice(offset)}</row>`
    },
  )

  output = output.replace(
    /(<dimension\b[^>]*\bref=")([^"]+)(")/i,
    (_whole, prefix: string, ref: string, suffix: string) => `${prefix}${xlsxShiftRangeRef(ref, null, insertAt)}${suffix}`,
  )
  output = output.replace(
    /(<mergeCell\b[^>]*\bref=")([^"]+)(")/gi,
    (_whole, prefix: string, ref: string, suffix: string) => `${prefix}${xlsxShiftRangeRef(ref, null, insertAt)}${suffix}`,
  )
  output = output.replace(
    /(<autoFilter\b[^>]*\bref=")([^"]+)(")/i,
    (_whole, prefix: string, ref: string, suffix: string) => `${prefix}${xlsxShiftRangeRef(ref, null, insertAt)}${suffix}`,
  )

  pkg.files[sheet.path] = new TextEncoder().encode(output)
  return {
    buffer: Buffer.from(zipSync(pkg.files, { level: 6 })),
    elementId: options.elementId,
    kind: 'sheet_column',
    insertedColumn: insertAt,
    insertedValues: values,
  }
}

export interface OfficeXlsxSheetAppendResult {
  buffer: Buffer
  kind: 'sheet'
  sheetId: string
  sheetName: string
  sheetCount: number
}

export interface OfficeXlsxSheetDeleteResult {
  buffer: Buffer
  kind: 'sheet'
  deletedSheetId: string
  deletedSheetName: string
  remainingSheets: number
}

const XLSX_WORKSHEET_REL_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet'
const XLSX_WORKSHEET_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'
const XLSX_CALC_CHAIN_REL_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain'
const XLSX_COMMENTS_REL_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments'
const XLSX_VML_REL_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing'
const XLSX_COMMENTS_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml'
const XLSX_VML_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.vmlDrawing'

function xlsxNormalizeSheetName(value: string): string {
  return value.trim()
}

function xlsxValidateSheetName(name: string): string {
  const normalized = xlsxNormalizeSheetName(name)
  if (!normalized) throw new Error('工作表名称不能为空')
  if (normalized.length > 31) throw new Error('工作表名称不能超过 31 个字符')
  if (/[\\/?*\[\]:]/.test(normalized)) {
    throw new Error('工作表名称不能包含 \\ / ? * [ ] :')
  }
  if (normalized.startsWith("'") || normalized.endsWith("'")) {
    throw new Error('工作表名称不能以单引号开头或结尾')
  }
  return normalized
}

function xlsxAppendXmlChild(xml: string, parentTag: string, childXml: string): string {
  const closeTag = `</${parentTag}>`
  if (xml.includes(closeTag)) {
    return xml.replace(closeTag, `${childXml}${closeTag}`)
  }
  const selfClosing = new RegExp(`<${parentTag}\\b([^>]*?)/>`, 'i').exec(xml)
  if (selfClosing) {
    return xml.replace(selfClosing[0], `<${parentTag}${selfClosing[1]}>${childXml}</${parentTag}>`)
  }
  throw new Error(`xlsx XML 缺少 ${parentTag} 容器`)
}

function xlsxAddContentType(files: Record<string, Uint8Array>, partName: string, contentType: string): void {
  const bytes = files['[Content_Types].xml']
  if (!bytes) throw new Error('xlsx 缺少 [Content_Types].xml')
  let xml = new TextDecoder().decode(bytes)
  const escapedPart = partName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (!new RegExp(`<Override\\b[^>]*\\bPartName\\s*=\\s*"/?${escapedPart}"`, 'i').test(xml)) {
    const override = `<Override PartName="/${partName}" ContentType="${contentType}"/>`
    xml = xlsxAppendXmlChild(xml, 'Types', override)
  }
  files['[Content_Types].xml'] = new TextEncoder().encode(xml)
}

function xlsxEnsureDefaultContentType(
  files: Record<string, Uint8Array>,
  extension: string,
  contentType: string,
): void {
  const bytes = files['[Content_Types].xml']
  if (!bytes) throw new Error('xlsx 缺少 [Content_Types].xml')
  const xml = new TextDecoder().decode(bytes)
  if (new RegExp(`<Default\\b[^>]*\\bExtension\\s*=\\s*"${extension}"`, 'i').test(xml)) return
  files['[Content_Types].xml'] = new TextEncoder().encode(
    xlsxAppendXmlChild(xml, 'Types', `<Default Extension="${extension}" ContentType="${contentType}"/>`),
  )
}

function xlsxRemoveContentType(files: Record<string, Uint8Array>, partName: string): void {
  const bytes = files['[Content_Types].xml']
  if (!bytes) return
  const xml = new TextDecoder().decode(bytes)
  const escapedPart = partName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const next = xml.replace(
    new RegExp(`<Override\\b[^>]*\\bPartName\\s*=\\s*"/?${escapedPart}"[^>]*/>`, 'gi'),
    '',
  )
  if (next !== xml) files['[Content_Types].xml'] = new TextEncoder().encode(next)
}

function xlsxRemoveRelationship(
  files: Record<string, Uint8Array>,
  relsPath: string,
  predicate: (attrs: string) => boolean,
): void {
  const bytes = files[relsPath]
  if (!bytes) return
  const xml = new TextDecoder().decode(bytes)
  const next = xml.replace(/<Relationship\b([^>]*?)(?:\/>|>)\r?\n?/gi, (whole, attrs: string) =>
    predicate(attrs) ? '' : whole,
  )
  if (next !== xml) files[relsPath] = new TextEncoder().encode(next)
}

function xlsxWorkbookSheetTag(
  workbookXml: string,
  sheetIndex: number,
): { xml: string; attrs: string; start: number; end: number } | null {
  const re = /<sheet\b([^>]*?)(?:\/>|>)/gi
  let match: RegExpExecArray | null
  let count = 0
  while ((match = re.exec(workbookXml))) {
    count += 1
    if (count === sheetIndex) {
      return {
        xml: match[0],
        attrs: match[1] ?? '',
        start: match.index,
        end: match.index + match[0].length,
      }
    }
  }
  return null
}

function xlsxFormulaTexts(xml: string): string[] {
  const formulas: string[] = []
  const re = /<(f|formula|formula1|formula2)\b[^>]*>([\s\S]*?)<\/\1>/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(xml))) formulas.push(decodeXmlText(match[2]))
  const chartRe = /<c:f\b[^>]*>([\s\S]*?)<\/c:f>/gi
  while ((match = chartRe.exec(xml))) formulas.push(decodeXmlText(match[1]))
  return formulas
}

function xlsxReferencesSheet(text: string, sheetName: string): boolean {
  const normalized = text.replace(/\s+/g, '').toLowerCase()
  const quoted = `'${sheetName.replace(/'/g, "''")}'!`.toLowerCase()
  const plain = `${sheetName}!`.toLowerCase()
  return normalized.includes(quoted) || normalized.includes(plain)
}

function xlsxAssertNoOtherSheetReferences(
  pkg: XlsxPackage,
  target: XlsxSheetRef,
  workbookXml: string,
): void {
  for (const sheet of pkg.sheets) {
    if (sheet.path === target.path) continue
    const bytes = pkg.files[sheet.path]
    if (!bytes) continue
    const sheetXml = new TextDecoder().decode(bytes)
    if (xlsxFormulaTexts(sheetXml).some((formula) => xlsxReferencesSheet(formula, target.name))) {
      throw new Error(`工作表 ${sheet.name} 的公式引用了 ${target.name}，删除会破坏跨表引用；请先修改公式`)
    }
  }
  for (const [path, bytes] of Object.entries(pkg.files)) {
    if (!/^xl\/(?:charts|pivotTables|pivotCache)\//i.test(path)) continue
    if (xlsxFormulaTexts(new TextDecoder().decode(bytes)).some((formula) => xlsxReferencesSheet(formula, target.name))) {
      throw new Error(`图表或数据透视表 ${path} 引用了 ${target.name}，删除会破坏引用；请先调整或移除该部件`)
    }
  }
  const definedNameRe = /<definedName\b[^>]*>([\s\S]*?)<\/definedName>/gi
  let match: RegExpExecArray | null
  while ((match = definedNameRe.exec(workbookXml))) {
    if (xlsxReferencesSheet(decodeXmlText(match[1]), target.name)) {
      throw new Error(`工作簿的命名区域引用了 ${target.name}，删除会破坏定义；请先删除或修改该命名区域`)
    }
  }
}

function xlsxResolvePartPath(ownerPath: string, target: string): string {
  const raw = target.replace(/\\/g, '/')
  if (/^\/+/.test(raw)) return raw.replace(/^\/+/, '')
  const clean = raw.replace(/^\/+/, '')
  if (!clean) return ''
  const base = ownerPath.replace(/\\/g, '/').split('/').filter(Boolean)
  base.pop()
  for (const part of clean.split('/')) {
    if (part === '..') base.pop()
    else if (part !== '.') base.push(part)
  }
  return base.join('/')
}

function xlsxPartRelsPath(partPath: string): string {
  const slash = partPath.lastIndexOf('/')
  return `${partPath.slice(0, slash)}/_rels/${partPath.slice(slash + 1)}.rels`
}

function xlsxRelationshipAttrs(xml: string): string[] {
  const result: string[] = []
  const re = /<Relationship\b([^>]*?)(?:\/>|>)/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(xml))) result.push(match[1] ?? '')
  return result
}

function xlsxIsSheetOwnedRelationship(type: string): boolean {
  return /(?:comments|vmlDrawing|drawing|table|pivotTable|printerSettings|threadedComment)$/i.test(type)
}

function xlsxDeleteSheetRelatedParts(pkg: XlsxPackage, sheetPath: string): void {
  const relsPath = xlsxPartRelsPath(sheetPath)
  const relsBytes = pkg.files[relsPath]
  if (!relsBytes) return
  const relsXml = new TextDecoder().decode(relsBytes)

  const referencedByOthers = new Set<string>()
  for (const sheet of pkg.sheets) {
    if (sheet.path === sheetPath) continue
    const otherRels = pkg.files[xlsxPartRelsPath(sheet.path)]
    if (!otherRels) continue
    for (const attrs of xlsxRelationshipAttrs(new TextDecoder().decode(otherRels))) {
      if (xlsxAttr(attrs, 'TargetMode') === 'External') continue
      const related = xlsxResolvePartPath(sheet.path, xlsxAttr(attrs, 'Target'))
      if (related) referencedByOthers.add(related)
    }
  }

  for (const attrs of xlsxRelationshipAttrs(relsXml)) {
    if (xlsxAttr(attrs, 'TargetMode') === 'External') continue
    if (!xlsxIsSheetOwnedRelationship(xlsxAttr(attrs, 'Type'))) continue
    const related = xlsxResolvePartPath(sheetPath, xlsxAttr(attrs, 'Target'))
    if (!related || related === sheetPath || referencedByOthers.has(related)) continue
    delete pkg.files[related]
    delete pkg.files[xlsxPartRelsPath(related)]
    xlsxRemoveContentType(pkg.files, related)
  }
  delete pkg.files[relsPath]
}

const XLSX_MAX_COLUMN = 16_384
const XLSX_MAX_ROW = 1_048_576
const XLSX_MAX_ROW_RANGE = 20_000

function xlsxAssertDimensionBounds(targetType: string, start: number, end: number): void {
  if (targetType === 'c') {
    if (start < 1 || end > XLSX_MAX_COLUMN) {
      throw new Error(`列号必须在 1 到 ${XLSX_MAX_COLUMN} 之间`)
    }
    return
  }
  if (start < 1 || end > XLSX_MAX_ROW) {
    throw new Error(`行号必须在 1 到 ${XLSX_MAX_ROW} 之间`)
  }
  if (end - start + 1 > XLSX_MAX_ROW_RANGE) {
    throw new Error(`单次行高设置最多 ${XLSX_MAX_ROW_RANGE} 行，请拆分范围`)
  }
}

export function appendXlsxSheet(buffer: Buffer, rawName: string): OfficeXlsxSheetAppendResult {
  const name = xlsxValidateSheetName(String(rawName ?? ''))
  const pkg = xlsxOpenPackage(buffer)
  if (pkg.sheets.some((sheet) => sheet.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(`工作表 ${name} 已存在，不能重复创建`)
  }
  const workbookBytes = pkg.files['xl/workbook.xml']
  const relsBytes = pkg.files['xl/_rels/workbook.xml.rels']
  if (!workbookBytes) throw new Error('xlsx 缺少 xl/workbook.xml')
  if (!relsBytes) throw new Error('xlsx 缺少 xl/_rels/workbook.xml.rels')
  let workbookXml = new TextDecoder().decode(workbookBytes)
  let relsXml = new TextDecoder().decode(relsBytes)

  const sheetIds = [...workbookXml.matchAll(/<sheet\b[^>]*\bsheetId\s*=\s*"([0-9]+)"/gi)].map(
    (match) => Number.parseInt(match[1], 10),
  )
  const sheetId = (sheetIds.length ? Math.max(...sheetIds) : pkg.sheets.length) + 1

  const usedRelIds = new Set(
    [...relsXml.matchAll(/<Relationship\b[^>]*\bId\s*=\s*"([^"]+)"/gi)].map((match) => match[1]),
  )
  let relationshipSeq = 1
  while (usedRelIds.has(`rId${relationshipSeq}`)) relationshipSeq += 1
  const relationshipId = `rId${relationshipSeq}`

  let sheetSeq = 1
  while (pkg.files[`xl/worksheets/sheet${sheetSeq}.xml`]) sheetSeq += 1
  const sheetPath = `xl/worksheets/sheet${sheetSeq}.xml`

  const sheetTag = `<sheet name="${encodeXmlText(name)}" sheetId="${sheetId}" r:id="${relationshipId}"/>`
  workbookXml = xlsxAppendXmlChild(workbookXml, 'sheets', sheetTag)
  relsXml = xlsxAppendXmlChild(
    relsXml,
    'Relationships',
    `<Relationship Id="${relationshipId}" Type="${XLSX_WORKSHEET_REL_TYPE}" Target="worksheets/sheet${sheetSeq}.xml"/>`,
  )

  pkg.files['xl/workbook.xml'] = new TextEncoder().encode(workbookXml)
  pkg.files['xl/_rels/workbook.xml.rels'] = new TextEncoder().encode(relsXml)
  pkg.files[sheetPath] = new TextEncoder().encode(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<dimension ref="A1"/><sheetViews><sheetView workbookViewId="0"/></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/><sheetData></sheetData></worksheet>',
  )
  xlsxAddContentType(pkg.files, sheetPath, XLSX_WORKSHEET_CONTENT_TYPE)
  return {
    buffer: Buffer.from(zipSync(pkg.files, { level: 6 })),
    kind: 'sheet',
    sheetId: `s${pkg.sheets.length + 1}`,
    sheetName: name,
    sheetCount: pkg.sheets.length + 1,
  }
}

export function deleteXlsxSheet(buffer: Buffer, elementId: string): OfficeXlsxSheetDeleteResult {
  const refMatch = /^s(\d+)$/i.exec(elementId.trim())
  if (!refMatch) throw new Error(`无法识别的 xlsx 工作表 ID: ${elementId}`)
  const sheetIndex = Number.parseInt(refMatch[1], 10)
  const pkg = xlsxOpenPackage(buffer)
  const target = pkg.sheets[sheetIndex - 1]
  if (!target) throw new Error(`xlsx 中没有工作表 s${sheetIndex}`)
  if (pkg.sheets.length <= 1) throw new Error('xlsx 至少需要保留一个工作表，不能删除唯一工作表')
  const workbookBytes = pkg.files['xl/workbook.xml']
  if (!workbookBytes) throw new Error('xlsx 缺少 xl/workbook.xml')
  let workbookXml = new TextDecoder().decode(workbookBytes)
  const tag = xlsxWorkbookSheetTag(workbookXml, sheetIndex)
  if (!tag) throw new Error(`xlsx 的 workbook.xml 中没有工作表 s${sheetIndex}`)
  xlsxAssertNoOtherSheetReferences(pkg, target, workbookXml)

  const relationshipId = xlsxAttr(tag.attrs, 'r:id')
  workbookXml = `${workbookXml.slice(0, tag.start)}${workbookXml.slice(tag.end)}`

  const relsPath = 'xl/_rels/workbook.xml.rels'
  xlsxRemoveRelationship(
    pkg.files,
    relsPath,
    relationshipId
      ? (attrs) => xlsxAttr(attrs, 'Id') === relationshipId
      : (attrs) => xlsxTargetPath(xlsxAttr(attrs, 'Target')) === target.path,
  )

  delete pkg.files[target.path]
  xlsxDeleteSheetRelatedParts(pkg, target.path)
  xlsxRemoveContentType(pkg.files, target.path)

  const calcChainPath = 'xl/calcChain.xml'
  if (pkg.files[calcChainPath]) {
    delete pkg.files[calcChainPath]
    xlsxRemoveContentType(pkg.files, calcChainPath)
    xlsxRemoveRelationship(
      pkg.files,
      relsPath,
      (attrs) =>
        xlsxAttr(attrs, 'Type') === XLSX_CALC_CHAIN_REL_TYPE ||
        xlsxTargetPath(xlsxAttr(attrs, 'Target')) === calcChainPath,
    )
  }

  pkg.files['xl/workbook.xml'] = new TextEncoder().encode(workbookXml)
  return {
    buffer: Buffer.from(zipSync(pkg.files, { level: 6 })),
    kind: 'sheet',
    deletedSheetId: `s${sheetIndex}`,
    deletedSheetName: target.name,
    remainingSheets: pkg.sheets.length - 1,
  }
}

export interface OfficeXlsxFormatOptions {
  /** `sN-rN-cN`，来自 office.read_outline / office.find。 */
  elementId: string
  bold?: boolean
  italic?: boolean
  underline?: boolean | string
  color?: string
  fill?: string
  fontSize?: number
  numberFormat?: string
}

export interface OfficeXlsxFormatResult {
  buffer: Buffer
  elementId: string
  kind: 'sheet_cell'
  applied: string[]
  styleIndex: number
}

export interface OfficeXlsxDimensionFormatOptions {
  /** `sN-cN` / `sN-rN`，也支持同类型范围 `sN-c2:c4`、`sN-r2:r4`。 */
  elementId: string
  columnWidth?: number
  rowHeight?: number
}

export interface OfficeXlsxDimensionFormatResult {
  buffer: Buffer
  elementId: string
  kind: 'sheet_column' | 'sheet_row'
  applied: string[]
  columns?: number
  rows?: number
}

interface XlsxColRange {
  attrs: string
  min: number
  max: number
}

function xlsxColRanges(xml: string): XlsxColRange[] {
  const ranges: XlsxColRange[] = []
  const re = /<col\b([^>]*?)(?:\/>|>)/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(xml))) {
    const attrs = match[1] ?? ''
    const min = Number.parseInt(xlsxAttr(attrs, 'min'), 10)
    const max = Number.parseInt(xlsxAttr(attrs, 'max'), 10)
    if (Number.isFinite(min) && Number.isFinite(max) && min > 0 && max >= min) {
      ranges.push({ attrs: attrs.trim(), min, max })
    }
  }
  return ranges
}

function xlsxColTag(attrs: string, min: number, max: number): string {
  let next = xlsxSetAttr(attrs.trim(), 'min', min)
  next = xlsxSetAttr(next, 'max', max)
  return `<col ${next.trim()}/>`
}

function xlsxSetColumnWidth(sheetXml: string, startColumn: number, endColumn: number, width: number): string {
  const existing = xlsxColRanges(sheetXml)
  let baseAttrs = ''
  const items: XlsxColRange[] = []
  for (const range of existing) {
    if (range.max < startColumn || range.min > endColumn) {
      items.push(range)
      continue
    }
    if (!baseAttrs) baseAttrs = range.attrs
    if (range.min < startColumn) {
      items.push({ attrs: range.attrs, min: range.min, max: startColumn - 1 })
    }
    if (range.max > endColumn) {
      items.push({ attrs: range.attrs, min: endColumn + 1, max: range.max })
    }
  }
  let targetAttrs = xlsxSetAttr(baseAttrs.trim(), 'width', Number(width.toFixed(2)))
  targetAttrs = xlsxSetAttr(targetAttrs, 'customWidth', 1)
  items.push({ attrs: targetAttrs, min: startColumn, max: endColumn })
  items.sort((left, right) => left.min - right.min)
  const colsXml = `<cols>${items.map((item) => xlsxColTag(item.attrs, item.min, item.max)).join('')}</cols>`

  const block = /<cols\b[^>]*?(?:\/>|>[\s\S]*?<\/cols>)/i.exec(sheetXml)
  if (block) return `${sheetXml.slice(0, block.index)}${colsXml}${sheetXml.slice(block.index + block[0].length)}`
  const sheetDataIndex = sheetXml.search(/<sheetData\b/i)
  if (sheetDataIndex < 0) throw new Error('xlsx 工作表缺少 sheetData，暂不支持设置列宽')
  return `${sheetXml.slice(0, sheetDataIndex)}${colsXml}${sheetXml.slice(sheetDataIndex)}`
}

function xlsxSetRowHeights(sheetXml: string, startRow: number, endRow: number, height: number): string {
  const sheetData = /<sheetData\b([^>]*?)(?:\/>|>([\s\S]*?)<\/sheetData>)/i.exec(sheetXml)
  if (!sheetData) throw new Error('xlsx 工作表缺少 sheetData，暂不支持设置行高')
  const inner = sheetData[2] ?? ''
  const missing: number[] = []
  for (let row = startRow; row <= endRow; row += 1) missing.push(row)
  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/gi
  const matches: Array<{ attrs: string; inner: string; selfClosing: boolean; row: number; start: number; end: number }> = []
  let match: RegExpExecArray | null
  while ((match = rowRe.exec(inner))) {
    const attrs = match[1] ?? ''
    const row = Number.parseInt(xlsxAttr(attrs, 'r'), 10)
    if (!Number.isFinite(row)) continue
    matches.push({
      attrs,
      inner: match[2] ?? '',
      selfClosing: match[2] === undefined,
      row,
      start: match.index,
      end: match.index + match[0].length,
    })
  }

  const emptyRow = (row: number): string =>
    `<row r="${row}" ht="${Number(height.toFixed(2))}" customHeight="1"/>`
  const updateRow = (item: (typeof matches)[number]): string => {
    let attrs = xlsxSetAttr(item.attrs.trim(), 'ht', Number(height.toFixed(2)))
    attrs = xlsxSetAttr(attrs, 'customHeight', 1)
    return item.selfClosing ? `<row ${attrs.trim()}/>` : `<row ${attrs.trim()}>${item.inner}</row>`
  }

  let output = ''
  let position = 0
  for (const item of matches) {
    output += inner.slice(position, item.start)
    while (missing.length > 0 && missing[0] < item.row) {
      output += emptyRow(missing.shift() as number)
    }
    output += missing[0] === item.row ? (missing.shift(), updateRow(item)) : item.selfClosing ? `<row${item.attrs}/>` : `<row${item.attrs}>${item.inner}</row>`
    position = item.end
  }
  output += inner.slice(position)
  while (missing.length > 0) output += emptyRow(missing.shift() as number)

  const dataTag = `<sheetData${sheetData[1] ?? ''}>${output}</sheetData>`
  return `${sheetXml.slice(0, sheetData.index)}${dataTag}${sheetXml.slice(sheetData.index + sheetData[0].length)}`
}

export function formatXlsxDimension(
  buffer: Buffer,
  options: OfficeXlsxDimensionFormatOptions,
): OfficeXlsxDimensionFormatResult {
  const refMatch = /^s(\d+)-([cr])(\d+)(?::([cr])(\d+))?$/i.exec(options.elementId.trim())
  if (!refMatch) throw new Error(`无法识别的 xlsx 行/列 ID: ${options.elementId}`)
  const targetType = refMatch[2].toLowerCase()
  const rangeType = refMatch[4]?.toLowerCase()
  if (rangeType && rangeType !== targetType) throw new Error('行列范围两端的类型必须一致')
  const sheetIndex = Number.parseInt(refMatch[1], 10)
  const start = Number.parseInt(refMatch[3], 10)
  const end = refMatch[5] ? Number.parseInt(refMatch[5], 10) : start
  if (start > end) throw new Error('行列范围的起始位置不能大于结束位置')
  xlsxAssertDimensionBounds(targetType, start, end)
  if (targetType === 'c') {
    if (options.rowHeight !== undefined) throw new Error('列宽设置请使用 columnWidth，不要传 rowHeight')
    if (options.columnWidth === undefined) throw new Error('设置列宽时 columnWidth 必填')
    if (!Number.isFinite(options.columnWidth) || options.columnWidth <= 0 || options.columnWidth > 255) {
      throw new Error('columnWidth 必须在 0 到 255 之间')
    }
  } else {
    if (options.columnWidth !== undefined) throw new Error('行高设置请使用 rowHeight，不要传 columnWidth')
    if (options.rowHeight === undefined) throw new Error('设置行高时 rowHeight 必填')
    if (!Number.isFinite(options.rowHeight) || options.rowHeight <= 0 || options.rowHeight > 409) {
      throw new Error('rowHeight 必须在 0 到 409 之间')
    }
  }

  const pkg = xlsxOpenPackage(buffer)
  const sheet = pkg.sheets[sheetIndex - 1]
  if (!sheet) throw new Error(`xlsx 中没有工作表 s${sheetIndex}`)
  const bytes = pkg.files[sheet.path]
  if (!bytes) throw new Error(`xlsx 缺少工作表文件 ${sheet.path}`)
  const sheetXml = new TextDecoder().decode(bytes)
  const nextSheetXml =
    targetType === 'c'
      ? xlsxSetColumnWidth(sheetXml, start, end, options.columnWidth as number)
      : xlsxSetRowHeights(sheetXml, start, end, options.rowHeight as number)
  pkg.files[sheet.path] = new TextEncoder().encode(nextSheetXml)
  return {
    buffer: Buffer.from(zipSync(pkg.files, { level: 6 })),
    elementId: options.elementId,
    kind: targetType === 'c' ? 'sheet_column' : 'sheet_row',
    applied: [targetType === 'c' ? 'columnWidth' : 'rowHeight'],
    ...(targetType === 'c' ? { columns: end - start + 1 } : { rows: end - start + 1 }),
  }
}

export interface OfficeXlsxCommentSummary {
  id: number
  elementId: string
  sheetId: string
  sheetName: string
  cell: string
  author: string
  text: string
  resolved: false
  replyCount: 0
}

export interface OfficeXlsxCommentReport {
  comments: OfficeXlsxCommentSummary[]
  total: number
  open: number
  resolvedCount: number
  threads: number
}

export interface OfficeXlsxCommentAddOptions {
  elementId: string
  text: string
  author?: string
}

export interface OfficeXlsxCommentAddResult {
  buffer: Buffer
  kind: 'sheet_cell'
  elementId: string
  sheetId: string
  sheetName: string
  cell: string
  commentId: number
  author: string
  text: string
}

export interface OfficeXlsxCommentDeleteOptions {
  elementId?: string
  commentId?: number
}

export interface OfficeXlsxCommentDeleteResult {
  buffer: Buffer
  kind: 'sheet_cell'
  elementId: string
  sheetId: string
  sheetName: string
  cell: string
  commentId: number
  deleted: true
  remaining: number
}

interface XlsxCommentEntry {
  ref: string
  authorId: number
  text: string
  xml: string
  start: number
  end: number
}

interface XlsxCommentParts {
  relsPath: string
  commentsPath?: string
  commentsRelId?: string
  vmlPath?: string
  vmlRelId?: string
}

function xlsxCommentEntries(xml: string): XlsxCommentEntry[] {
  const entries: XlsxCommentEntry[] = []
  const re = /<((?:[A-Za-z_][\w.-]*:)?)comment\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1comment>)/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(xml))) {
    const attrs = match[2] ?? ''
    const inner = match[3] ?? ''
    const textMatch = /<((?:[A-Za-z_][\w.-]*:)?)text\b[^>]*>([\s\S]*?)<\/\1text>/i.exec(inner)
    entries.push({
      ref: xlsxAttr(attrs, 'ref'),
      authorId: Number.parseInt(xlsxAttr(attrs, 'authorId'), 10) || 0,
      text: xlsxTextFragment(textMatch?.[2] ?? inner),
      xml: match[0],
      start: match.index,
      end: match.index + match[0].length,
    })
  }
  return entries
}

function xlsxCommentAuthors(xml: string): string[] {
  const block = /<((?:[A-Za-z_][\w.-]*:)?)authors\b[^>]*?(?:\/>|>([\s\S]*?)<\/\1authors>)/i.exec(xml)
  if (!block || block[2] === undefined) return []
  const authors: string[] = []
  const re = /<((?:[A-Za-z_][\w.-]*:)?)author\b[^>]*>([\s\S]*?)<\/\1author>/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(block[2]))) authors.push(decodeXmlText(match[2]))
  return authors
}

function xlsxEnsureCommentAuthor(xml: string, rawAuthor: string): { xml: string; authorId: number } {
  const author = rawAuthor.trim() || 'EAB Agent'
  const authors = xlsxCommentAuthors(xml)
  const existing = authors.findIndex((item) => item === author)
  if (existing >= 0) return { xml, authorId: existing }

  const block = /<((?:[A-Za-z_][\w.-]*:)?)authors\b[^>]*?(?:\/>|>([\s\S]*?)<\/\1authors>)/i.exec(xml)
  if (block) {
    const prefix = block[1] ?? ''
    const inner = block[2]
    const authorTag = `<${prefix}author>${encodeXmlText(author)}</${prefix}author>`
    const replacement =
      inner === undefined
        ? `<${prefix}authors>${authorTag}</${prefix}authors>`
        : `<${prefix}authors>${inner}${authorTag}</${prefix}authors>`
    return { xml: `${xml.slice(0, block.index)}${replacement}${xml.slice(block.index + block[0].length)}`, authorId: authors.length }
  }

  const list = /<((?:[A-Za-z_][\w.-]*:)?)commentList\b/i.exec(xml)
  if (!list) throw new Error('xlsx 批注 XML 缺少 commentList 容器')
  const prefix = list[1] ?? ''
  const blockXml = `<${prefix}authors><${prefix}author>${encodeXmlText(author)}</${prefix}author></${prefix}authors>`
  return { xml: `${xml.slice(0, list.index)}${blockXml}${xml.slice(list.index)}`, authorId: 0 }
}

function xlsxCommentParts(pkg: XlsxPackage, sheet: XlsxSheetRef): XlsxCommentParts {
  const relsPath = xlsxPartRelsPath(sheet.path)
  const parts: XlsxCommentParts = { relsPath }
  const bytes = pkg.files[relsPath]
  if (!bytes) return parts
  for (const attrs of xlsxRelationshipAttrs(new TextDecoder().decode(bytes))) {
    const id = xlsxAttr(attrs, 'Id')
    const type = xlsxAttr(attrs, 'Type')
    const target = xlsxAttr(attrs, 'Target')
    if (!id || !target) continue
    const path = xlsxResolvePartPath(sheet.path, target)
    if (type === XLSX_COMMENTS_REL_TYPE) {
      parts.commentsPath = path
      parts.commentsRelId = id
    } else if (type === XLSX_VML_REL_TYPE) {
      parts.vmlPath = path
      parts.vmlRelId = id
    }
  }
  return parts
}

function xlsxUnusedPartPath(
  files: Record<string, Uint8Array>,
  dir: string,
  base: string,
  extension: string,
): string {
  let seq = 1
  while (files[`${dir}/${base}${seq}.${extension}`]) seq += 1
  return `${dir}/${base}${seq}.${extension}`
}

function xlsxAddPartRelationship(
  files: Record<string, Uint8Array>,
  relsPath: string,
  type: string,
  target: string,
): string {
  let xml = files[relsPath]
    ? new TextDecoder().decode(files[relsPath])
    : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
  const used = new Set(
    [...xml.matchAll(/<Relationship\b[^>]*\bId\s*=\s*"([^"]+)"/gi)].map((match) => match[1]),
  )
  let seq = 1
  while (used.has(`rId${seq}`)) seq += 1
  const id = `rId${seq}`
  xml = xlsxAppendXmlChild(
    xml,
    'Relationships',
    `<Relationship Id="${id}" Type="${type}" Target="${encodeXmlText(target)}"/>`,
  )
  files[relsPath] = new TextEncoder().encode(xml)
  return id
}

function xlsxCommentListXml(ref: string, authorId: number, text: string): string {
  return `<comment ref="${ref}" authorId="${authorId}" shapeId="0"><text><t xml:space="preserve">${encodeXmlText(text)}</t></text></comment>`
}

function xlsxNewCommentsXml(ref: string, author: string, text: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<authors><author>${encodeXmlText(author)}</author></authors>` +
    `<commentList>${xlsxCommentListXml(ref, 0, text)}</commentList></comments>`
  )
}

function xlsxVmlShapeType(): string {
  return (
    '<v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe">' +
    '<v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype>'
  )
}

function xlsxVmlShapeXml(row: number, column: number, shapeId: number): string {
  return (
    `<v:shape type="#_x0000_t202" style="position:absolute;margin-left:59.25pt;margin-top:1.5pt;width:144px;height:79px;z-index:1;visibility:hidden"` +
    ` fillcolor="#ffffe1" o:insetmode="auto" id="_x0000_s${shapeId}">` +
    '<v:fill color2="#ffffe1"/><v:shadow color="black" obscured="t"/><v:path o:connecttype="none"/>' +
    '<v:textbox style="mso-direction-alt:auto"><div style="text-align:left"/></v:textbox>' +
    `<x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/><x:AutoFill>False</x:AutoFill>` +
    `<x:Row>${row - 1}</x:Row><x:Column>${column - 1}</x:Column></x:ClientData></v:shape>`
  )
}

function xlsxNextVmlShapeId(vmlXml: string): number {
  let max = 1025
  for (const match of vmlXml.matchAll(/_x0000_s(\d+)/g)) {
    const value = Number.parseInt(match[1], 10)
    if (Number.isFinite(value) && value > max) max = value
  }
  return max + 1
}

function xlsxNewVmlXml(row: number, column: number): string {
  return (
    '<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">' +
    xlsxVmlShapeType() +
    xlsxVmlShapeXml(row, column, 1026) +
    '</xml>'
  )
}

function xlsxAppendVmlShape(vmlXml: string, row: number, column: number): string {
  const shapeId = xlsxNextVmlShapeId(vmlXml)
  const needsShapeType = !vmlXml.includes('_x0000_t202')
  const block = `${needsShapeType ? xlsxVmlShapeType() : ''}${xlsxVmlShapeXml(row, column, shapeId)}`
  if (vmlXml.includes('</xml>')) return vmlXml.replace('</xml>', `${block}</xml>`)
  const selfClosing = /<xml\b([^>]*?)\/>/i.exec(vmlXml)
  if (selfClosing) return vmlXml.replace(selfClosing[0], `<xml${selfClosing[1]}>${block}</xml>`)
  throw new Error('xlsx VML 批注文件缺少 xml 根节点')
}

function xlsxRemoveVmlShape(vmlXml: string, row: number, column: number): { xml: string; removed: boolean } {
  const re = /<((?:[A-Za-z_][\w.-]*:)?)shape\b[^>]*>[\s\S]*?<\/\1shape>/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(vmlXml))) {
    const block = match[0]
    if (!/ObjectType\s*=\s*"Note"/i.test(block)) continue
    const rowRe = /<((?:[A-Za-z_][\w.-]*:)?)Row>\s*([0-9]+)\s*<\/\1Row>/i.exec(block)
    const colRe = /<((?:[A-Za-z_][\w.-]*:)?)Column>\s*([0-9]+)\s*<\/\1Column>/i.exec(block)
    if (Number.parseInt(rowRe?.[2] ?? '', 10) !== row - 1) continue
    if (Number.parseInt(colRe?.[2] ?? '', 10) !== column - 1) continue
    return {
      xml: `${vmlXml.slice(0, match.index)}${vmlXml.slice(match.index + block.length)}`,
      removed: true,
    }
  }
  return { xml: vmlXml, removed: false }
}

function xlsxVmlHasNonCommentShapes(vmlXml: string): boolean {
  const re = /<((?:[A-Za-z_][\w.-]*:)?)shape\b[^>]*>[\s\S]*?<\/\1shape>/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(vmlXml))) {
    const block = match[0]
    if (!/ObjectType\s*=\s*"Note"/i.test(block)) return true
    if (!/<((?:[A-Za-z_][\w.-]*:)?)Row>\s*[0-9]+\s*<\/\1Row>/i.test(block)) return true
    if (!/<((?:[A-Za-z_][\w.-]*:)?)Column>\s*[0-9]+\s*<\/\1Column>/i.test(block)) return true
  }
  return false
}

function xlsxParseCellElementId(
  value: string,
): { sheetIndex: number; row: number; column: number; elementId: string; cell: string } | null {
  const match = /^s(\d+)-r(\d+)-c(\d+)$/i.exec(value.trim())
  if (!match) return null
  const sheetIndex = Number.parseInt(match[1], 10)
  const row = Number.parseInt(match[2], 10)
  const column = Number.parseInt(match[3], 10)
  if (sheetIndex < 1 || row < 1 || column < 1) return null
  if (row > XLSX_MAX_ROW || column > XLSX_MAX_COLUMN) return null
  return {
    sheetIndex,
    row,
    column,
    elementId: `s${sheetIndex}-r${row}-c${column}`,
    cell: `${xlsxColumnLetters(column)}${row}`,
  }
}

function xlsxCommentElementTarget(
  buffer: Buffer,
  options: { elementId?: string; commentId?: number },
): { sheetIndex: number; row: number; column: number; elementId: string; cell: string; commentId: number } {
  if (options.elementId !== undefined) {
    const parsed = xlsxParseCellElementId(options.elementId)
    if (!parsed) throw new Error(`无法识别的 xlsx 单元格 ID: ${options.elementId}`)
    return { ...parsed, commentId: 0 }
  }
  if (options.commentId !== undefined) {
    if (!Number.isInteger(options.commentId) || options.commentId < 1) {
      throw new Error('commentId 必须是正整数')
    }
    const report = readXlsxComments(buffer)
    const comment = report.comments.find((item) => item.id === options.commentId)
    if (!comment) throw new Error(`xlsx 中没有批注 ${options.commentId}`)
    const parsed = xlsxParseCellElementId(comment.elementId)
    if (!parsed) throw new Error(`xlsx 批注 ${options.commentId} 的单元格引用无效`)
    return { ...parsed, commentId: comment.id }
  }
  throw new Error('elementId 和 commentId 至少传一个')
}

export function readXlsxComments(buffer: Buffer): OfficeXlsxCommentReport {
  const pkg = xlsxOpenPackage(buffer)
  const comments: OfficeXlsxCommentSummary[] = []
  pkg.sheets.forEach((sheet, index) => {
    const parts = xlsxCommentParts(pkg, sheet)
    if (!parts.commentsPath) return
    const bytes = pkg.files[parts.commentsPath]
    if (!bytes) return
    const xml = new TextDecoder().decode(bytes)
    const authors = xlsxCommentAuthors(xml)
    for (const entry of xlsxCommentEntries(xml)) {
      const position = xlsxRefOfCell(entry.ref)
      if (!position) continue
      comments.push({
        id: comments.length + 1,
        elementId: `s${index + 1}-r${position.row}-c${position.column}`,
        sheetId: `s${index + 1}`,
        sheetName: sheet.name,
        cell: `${xlsxColumnLetters(position.column)}${position.row}`,
        author: authors[entry.authorId] ?? 'EAB Agent',
        text: entry.text,
        resolved: false,
        replyCount: 0,
      })
    }
  })
  return {
    comments,
    total: comments.length,
    open: comments.length,
    resolvedCount: 0,
    threads: 0,
  }
}

export function addXlsxCellComment(
  buffer: Buffer,
  options: OfficeXlsxCommentAddOptions,
): OfficeXlsxCommentAddResult {
  if (typeof options.text !== 'string' || !options.text.trim()) throw new Error('批注正文不能为空')
  const target = xlsxParseCellElementId(options.elementId)
  if (!target) throw new Error(`无法识别的 xlsx 单元格 ID: ${options.elementId}`)
  const author = (options.author ?? 'EAB Agent').trim() || 'EAB Agent'
  const pkg = xlsxOpenPackage(buffer)
  const sheet = pkg.sheets[target.sheetIndex - 1]
  if (!sheet) throw new Error(`xlsx 中没有工作表 s${target.sheetIndex}`)
  const parts = xlsxCommentParts(pkg, sheet)
  if (parts.commentsPath) {
    const bytes = pkg.files[parts.commentsPath]
    if (bytes) {
      const xml = new TextDecoder().decode(bytes)
      if (xlsxCommentEntries(xml).some((entry) => entry.ref.toUpperCase() === target.cell.toUpperCase())) {
        throw new Error(`单元格 ${target.cell} 已有批注，请先删除该批注`)
      }
    }
  }

  let commentsPath = parts.commentsPath
  let commentId: number
  if (commentsPath) {
    const bytes = pkg.files[commentsPath]
    if (!bytes) throw new Error(`xlsx 缺少批注文件 ${commentsPath}`)
    let commentsXml = new TextDecoder().decode(bytes)
    const ensured = xlsxEnsureCommentAuthor(commentsXml, author)
    commentsXml = ensured.xml
    commentId = xlsxCommentEntries(commentsXml).length + 1
    commentsXml = xlsxAppendXmlChild(
      commentsXml,
      'commentList',
      xlsxCommentListXml(target.cell, ensured.authorId, options.text),
    )
    pkg.files[commentsPath] = new TextEncoder().encode(commentsXml)
    xlsxAddContentType(pkg.files, commentsPath, XLSX_COMMENTS_CONTENT_TYPE)
    if (!parts.commentsRelId) {
      xlsxAddPartRelationship(pkg.files, parts.relsPath, XLSX_COMMENTS_REL_TYPE, `/${commentsPath}`)
    }
  } else {
    commentsPath = xlsxUnusedPartPath(pkg.files, 'xl/comments', 'comment', 'xml')
    pkg.files[commentsPath] = new TextEncoder().encode(
      xlsxNewCommentsXml(target.cell, author, options.text),
    )
    xlsxAddContentType(pkg.files, commentsPath, XLSX_COMMENTS_CONTENT_TYPE)
    xlsxAddPartRelationship(pkg.files, parts.relsPath, XLSX_COMMENTS_REL_TYPE, `/${commentsPath}`)
    commentId = 1
  }

  if (parts.vmlPath) {
    const bytes = pkg.files[parts.vmlPath]
    if (bytes) {
      pkg.files[parts.vmlPath] = new TextEncoder().encode(
        xlsxAppendVmlShape(new TextDecoder().decode(bytes), target.row, target.column),
      )
      if (!parts.vmlRelId) {
        xlsxAddPartRelationship(pkg.files, parts.relsPath, XLSX_VML_REL_TYPE, `/${parts.vmlPath}`)
      }
    }
  } else {
    const vmlPath = xlsxUnusedPartPath(pkg.files, 'xl/drawings', 'vmlDrawing', 'vml')
    pkg.files[vmlPath] = new TextEncoder().encode(xlsxNewVmlXml(target.row, target.column))
    xlsxEnsureDefaultContentType(pkg.files, 'vml', XLSX_VML_CONTENT_TYPE)
    xlsxAddPartRelationship(pkg.files, parts.relsPath, XLSX_VML_REL_TYPE, `/${vmlPath}`)
  }
  return finishXlsxCommentAdd(pkg, target, sheet, commentId, author, options.text)
}

function finishXlsxCommentAdd(
  pkg: XlsxPackage,
  target: { sheetIndex: number; row: number; column: number; elementId: string; cell: string },
  sheet: XlsxSheetRef,
  commentId: number,
  author: string,
  text: string,
): OfficeXlsxCommentAddResult {
  return {
    buffer: Buffer.from(zipSync(pkg.files, { level: 6 })),
    kind: 'sheet_cell',
    elementId: target.elementId,
    sheetId: `s${target.sheetIndex}`,
    sheetName: sheet.name,
    cell: target.cell,
    commentId,
    author,
    text,
  }
}

export function deleteXlsxCellComment(
  buffer: Buffer,
  options: OfficeXlsxCommentDeleteOptions,
): OfficeXlsxCommentDeleteResult {
  const target = xlsxCommentElementTarget(buffer, options)
  const pkg = xlsxOpenPackage(buffer)
  const sheet = pkg.sheets[target.sheetIndex - 1]
  if (!sheet) throw new Error(`xlsx 中没有工作表 s${target.sheetIndex}`)
  const parts = xlsxCommentParts(pkg, sheet)
  if (!parts.commentsPath || !pkg.files[parts.commentsPath]) {
    throw new Error(`工作表 ${sheet.name} 没有批注文件`)
  }
  const commentsXml = new TextDecoder().decode(pkg.files[parts.commentsPath])
  const entries = xlsxCommentEntries(commentsXml)
  const entry = entries.find((item) => item.ref.toUpperCase() === target.cell.toUpperCase())
  if (!entry) throw new Error(`单元格 ${target.cell} 没有批注`)
  const nextCommentsXml = `${commentsXml.slice(0, entry.start)}${commentsXml.slice(entry.end)}`
  const remainingEntries = entries.length - 1
  const commentId =
    target.commentId ||
    readXlsxComments(buffer).comments.find((item) => item.elementId === target.elementId)?.id ||
    1
  let nextVmlXml: string | undefined
  if (parts.vmlPath && pkg.files[parts.vmlPath]) {
    const vml = new TextDecoder().decode(pkg.files[parts.vmlPath])
    nextVmlXml = xlsxRemoveVmlShape(vml, target.row, target.column).xml
  }

  if (remainingEntries > 0) {
    pkg.files[parts.commentsPath] = new TextEncoder().encode(nextCommentsXml)
    if (parts.vmlPath && nextVmlXml !== undefined) {
      pkg.files[parts.vmlPath] = new TextEncoder().encode(nextVmlXml)
    }
  } else {
    delete pkg.files[parts.commentsPath]
    xlsxRemoveContentType(pkg.files, parts.commentsPath)
    xlsxRemoveRelationship(
      pkg.files,
      parts.relsPath,
      (attrs) => xlsxAttr(attrs, 'Type') === XLSX_COMMENTS_REL_TYPE,
    )
    if (parts.vmlPath) {
      if (pkg.files[parts.vmlPath] && nextVmlXml !== undefined && xlsxVmlHasNonCommentShapes(nextVmlXml)) {
        pkg.files[parts.vmlPath] = new TextEncoder().encode(nextVmlXml)
      } else {
        delete pkg.files[parts.vmlPath]
        delete pkg.files[xlsxPartRelsPath(parts.vmlPath)]
        xlsxRemoveContentType(pkg.files, parts.vmlPath)
        xlsxRemoveRelationship(
          pkg.files,
          parts.relsPath,
          (attrs) => xlsxAttr(attrs, 'Type') === XLSX_VML_REL_TYPE,
        )
      }
    }
  }

  return {
    buffer: Buffer.from(zipSync(pkg.files, { level: 6 })),
    kind: 'sheet_cell',
    elementId: target.elementId,
    sheetId: `s${target.sheetIndex}`,
    sheetName: sheet.name,
    cell: target.cell,
    commentId,
    deleted: true,
    remaining: remainingEntries,
  }
}

export interface OfficePptxParagraph {
  id: string
  kind: 'slide_paragraph'
  index: number
  text: string
}

export interface OfficePptxSlide {
  id: string
  name: string
  paragraphCount: number
  paragraphs: OfficePptxParagraph[]
  truncated: boolean
}

export interface OfficePptxOutline {
  fileName: string
  slideCount: number
  slides: OfficePptxSlide[]
  truncated: boolean
}

export interface OfficePptxMatch {
  elementId: string
  slideId: string
  slideName: string
  paragraphIndex: number
  text: string
  start: number
  end: number
  context: string
}

export interface OfficePptxReplaceOptions {
  elementId: string
  oldText?: string
  newText: string
  occurrence?: number
}

export interface OfficePptxReplaceResult {
  buffer: Buffer
  elementId: string
  kind: 'slide_paragraph'
  previousText: string
  nextText: string
  replacements: number
}

interface PptxSlideRef {
  id: string
  name: string
  path: string
}

interface PptxTextNode {
  start: number
  end: number
  attrs: string
  text: string
}

interface PptxParagraphRef {
  id: string
  index: number
  start: number
  end: number
  xml: string
  text: string
  nodes: PptxTextNode[]
}

function pptxTargetPath(target: string): string {
  const clean = target.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!clean) return ''
  if (clean.startsWith('ppt/')) return clean
  const parts = clean.split('/').filter(Boolean)
  const out = ['ppt']
  for (const part of parts) {
    if (part === '..') out.pop()
    else if (part !== '.') out.push(part)
  }
  return out.join('/')
}

function pptxSlideRefs(files: Record<string, Uint8Array>): PptxSlideRef[] {
  const relsXml = files['ppt/_rels/presentation.xml.rels']
    ? new TextDecoder().decode(files['ppt/_rels/presentation.xml.rels'])
    : ''
  const relTargets = new Map<string, string>()
  const relRe = /<Relationship\b([^>]*)\/?>/gi
  let relMatch: RegExpExecArray | null
  while ((relMatch = relRe.exec(relsXml))) {
    const id = xlsxAttr(relMatch[1], 'Id')
    const target = xlsxAttr(relMatch[1], 'Target')
    if (id && target) relTargets.set(id, pptxTargetPath(target))
  }

  const presentationXml = files['ppt/presentation.xml']
    ? new TextDecoder().decode(files['ppt/presentation.xml'])
    : ''
  const slides: PptxSlideRef[] = []
  const sldRe = /<p:sldId\b([^>]*)\/?>/gi
  let sldMatch: RegExpExecArray | null
  while ((sldMatch = sldRe.exec(presentationXml))) {
    const rid = xlsxAttr(sldMatch[1], 'r:id')
    const path = rid ? relTargets.get(rid) : undefined
    if (path) slides.push({ id: `s${slides.length + 1}`, name: `幻灯片 ${slides.length + 1}`, path })
  }
  if (slides.length > 0) return slides

  return Object.keys(files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path))
    .sort((a, b) => Number(a.match(/slide(\d+)\.xml/i)?.[1]) - Number(b.match(/slide(\d+)\.xml/i)?.[1]))
    .map((path, index) => ({ id: `s${index + 1}`, name: `幻灯片 ${index + 1}`, path }))
}

function pptxOpenPackage(buffer: Buffer): { files: Record<string, Uint8Array>; slides: PptxSlideRef[] } {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(new Uint8Array(buffer))
  } catch {
    throw new Error('pptx 文件不是有效的 Office Open XML 压缩包')
  }
  if (!files['ppt/presentation.xml']) throw new Error('pptx 缺少 ppt/presentation.xml')
  const slides = pptxSlideRefs(files)
  if (slides.length === 0) throw new Error('pptx 中没有幻灯片')
  return { files, slides }
}

function pptxParseParagraphs(slideXml: string, slideIndex: number): PptxParagraphRef[] {
  const paragraphs: PptxParagraphRef[] = []
  const paragraphRe = /<a:p\b([^>]*)>([\s\S]*?)<\/a:p>/gi
  let paragraphMatch: RegExpExecArray | null
  while ((paragraphMatch = paragraphRe.exec(slideXml))) {
    const openEnd = paragraphMatch[0].indexOf('>') + 1
    const innerStart = paragraphMatch.index + openEnd
    const inner = paragraphMatch[2] ?? ''
    const nodes: PptxTextNode[] = []
    const textRe = /<a:t\b([^>]*)>([\s\S]*?)<\/a:t>/gi
    let textMatch: RegExpExecArray | null
    while ((textMatch = textRe.exec(inner))) {
      const start = innerStart + textMatch.index
      nodes.push({
        start,
        end: start + textMatch[0].length,
        attrs: textMatch[1] ?? '',
        text: decodeXmlText(textMatch[2] ?? ''),
      })
    }
    paragraphs.push({
      id: `s${slideIndex}-p${paragraphs.length + 1}`,
      index: paragraphs.length + 1,
      start: paragraphMatch.index,
      end: paragraphMatch.index + paragraphMatch[0].length,
      xml: paragraphMatch[0],
      text: nodes.map((node) => node.text).join(''),
      nodes,
    })
  }
  return paragraphs
}

function pptxLoadSlides(
  pkg: { files: Record<string, Uint8Array>; slides: PptxSlideRef[] },
): Array<{ ref: PptxSlideRef; paragraphs: PptxParagraphRef[] }> {
  return pkg.slides.map((ref, index) => {
    const bytes = pkg.files[ref.path]
    const xml = bytes ? new TextDecoder().decode(bytes) : ''
    return { ref, paragraphs: pptxParseParagraphs(xml, index + 1) }
  })
}

export function readPptxOutline(buffer: Buffer, maxParagraphs = 200): OfficePptxOutline {
  const pkg = pptxOpenPackage(buffer)
  const limit = Math.max(1, Math.min(1000, maxParagraphs))
  const loaded = pptxLoadSlides(pkg)
  const total = loaded.reduce((sum, item) => sum + item.paragraphs.length, 0)
  let remaining = limit
  const slides = loaded.map(({ ref, paragraphs }) => {
    const shown = paragraphs.slice(0, Math.max(0, remaining))
    remaining -= shown.length
    return {
      id: ref.id,
      name: ref.name,
      paragraphCount: paragraphs.length,
      paragraphs: shown.map((paragraph) => ({
        id: paragraph.id,
        kind: 'slide_paragraph' as const,
        index: paragraph.index,
        text: paragraph.text,
      })),
      truncated: shown.length < paragraphs.length,
    }
  })
  return {
    fileName: '',
    slideCount: slides.length,
    slides,
    truncated: total > limit,
  }
}

export function findInPptx(
  buffer: Buffer,
  query: string,
  options: { regex?: boolean; limit?: number } = {},
): OfficePptxMatch[] {
  const limit = Math.max(1, Math.min(100, options.limit ?? 20))
  let matcher: RegExp
  if (options.regex) {
    try {
      matcher = new RegExp(query, 'gi')
    } catch {
      throw new Error(`正则表达式无效: ${query}`)
    }
  } else {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    matcher = new RegExp(escaped, 'gi')
  }

  const pkg = pptxOpenPackage(buffer)
  const matches: OfficePptxMatch[] = []
  for (const { ref, paragraphs } of pptxLoadSlides(pkg)) {
    for (const paragraph of paragraphs) {
      matcher.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = matcher.exec(paragraph.text))) {
        if (matches.length >= limit) return matches
        const start = match.index
        const end = start + match[0].length
        matches.push({
          elementId: paragraph.id,
          slideId: ref.id,
          slideName: ref.name,
          paragraphIndex: paragraph.index,
          text: paragraph.text,
          start,
          end,
          context: `${paragraph.text.slice(0, start)}【${paragraph.text.slice(start, end)}】${paragraph.text.slice(end)}`,
        })
      }
    }
  }
  return matches
}

function pptxReplaceValue(
  text: string,
  oldText: string | undefined,
  occurrence: number | undefined,
): { start: number; end: number; replacements: number } {
  if (oldText === undefined) return { start: 0, end: text.length, replacements: 1 }
  if (!oldText) throw new Error('oldText 不能为空；要替换整段请省略 oldText')
  const matches: number[] = []
  let from = 0
  while (from <= text.length) {
    const found = text.indexOf(oldText, from)
    if (found < 0) break
    matches.push(found)
    from = found + Math.max(1, oldText.length)
  }
  if (matches.length === 0) throw new Error(`目标幻灯片段落中没有找到 oldText: ${oldText}`)
  const selected = occurrence ?? 1
  if (selected === 0) {
    throw new Error('pptx 段落替换暂不支持 occurrence=0；请分别指定命中的第几处')
  }
  if (selected < 1 || selected > matches.length) {
    throw new Error(`目标幻灯片段落中 oldText 命中 ${matches.length} 次，occurrence=${selected} 超出范围`)
  }
  if (matches.length > 1 && occurrence === undefined) {
    throw new Error(`目标幻灯片段落中 oldText 命中 ${matches.length} 次，请指定 occurrence（1 起）`)
  }
  const start = matches[selected - 1]
  return { start, end: start + oldText.length, replacements: 1 }
}

function pptxBuildParagraph(
  slideXml: string,
  paragraph: PptxParagraphRef,
  newText: string,
  start: number,
  end: number,
): string {
  if (paragraph.nodes.length === 0) throw new Error(`幻灯片段落 ${paragraph.id} 没有可写文本节点`)
  const offsets: number[] = []
  let offset = 0
  for (const node of paragraph.nodes) {
    offsets.push(offset)
    offset += node.text.length
  }
  let startNode = -1
  let endNode = -1
  let startOffset = 0
  let endOffset = 0
  for (let index = 0; index < paragraph.nodes.length; index += 1) {
    const node = paragraph.nodes[index]
    const nodeStart = offsets[index]
    const nodeEnd = nodeStart + node.text.length
    if (startNode < 0 && start >= nodeStart && (start < nodeEnd || (nodeEnd === nodeStart && start === nodeStart))) {
      startNode = index
      startOffset = start - nodeStart
    }
    if (endNode < 0 && end > nodeStart && end <= nodeEnd) {
      endNode = index
      endOffset = end - nodeStart
    }
  }
  if (startNode < 0) startNode = paragraph.nodes.length - 1
  if (endNode < 0) endNode = startNode

  const nextTexts = paragraph.nodes.map((node, index) => {
    if (index === startNode) {
      const prefix = node.text.slice(0, startOffset)
      const suffix = index === endNode ? node.text.slice(endOffset) : ''
      return `${prefix}${newText}${suffix}`
    }
    if (index === endNode) return node.text.slice(endOffset)
    if (index > startNode && index < endNode) return ''
    return node.text
  })

  let result = ''
  let cursor = paragraph.start
  for (let index = 0; index < paragraph.nodes.length; index += 1) {
    const node = paragraph.nodes[index]
    result += `${slideXml.slice(cursor, node.start)}<a:t${node.attrs}>${encodeXmlText(nextTexts[index])}</a:t>`
    cursor = node.end
  }
  result += slideXml.slice(cursor, paragraph.end)
  return `${slideXml.slice(0, paragraph.start)}${result}${slideXml.slice(paragraph.end)}`
}

export function replacePptxText(
  buffer: Buffer,
  options: OfficePptxReplaceOptions,
): OfficePptxReplaceResult {
  const match = /^s(\d+)-p(\d+)$/i.exec(options.elementId)
  if (!match) throw new Error(`无法识别的 pptx 段落 ID: ${options.elementId}`)
  const slideIndex = Number.parseInt(match[1], 10)
  const paragraphIndex = Number.parseInt(match[2], 10)
  if (options.newText.includes('\n') || options.newText.includes('\r')) {
    throw new Error('pptx 段落内暂不支持换行；请拆成多个段落或改用空格')
  }
  const pkg = pptxOpenPackage(buffer)
  const slide = pkg.slides[slideIndex - 1]
  if (!slide) throw new Error(`pptx 中没有幻灯片 s${slideIndex}`)
  const bytes = pkg.files[slide.path]
  if (!bytes) throw new Error(`pptx 缺少幻灯片文件 ${slide.path}`)
  const slideXml = new TextDecoder().decode(bytes)
  const paragraph = pptxParseParagraphs(slideXml, slideIndex).find(
    (item) => item.index === paragraphIndex,
  )
  if (!paragraph) throw new Error(`幻灯片 ${slide.name} 没有段落 p${paragraphIndex}`)
  const replacement = pptxReplaceValue(
    paragraph.text,
    options.oldText,
    options.occurrence,
  )
  const nextText =
    options.oldText === undefined
      ? options.newText
      : `${paragraph.text.slice(0, replacement.start)}${options.newText}${paragraph.text.slice(replacement.end)}`
  const nextSlideXml = pptxBuildParagraph(
    slideXml,
    paragraph,
    options.newText,
    replacement.start,
    replacement.end,
  )
  pkg.files[slide.path] = new TextEncoder().encode(nextSlideXml)
  return {
    buffer: Buffer.from(zipSync(pkg.files, { level: 6 })),
    elementId: options.elementId,
    kind: 'slide_paragraph',
    previousText: paragraph.text,
    nextText,
    replacements: replacement.replacements,
  }
}


const XLSX_BUILTIN_NUM_FMTS: Array<[string, number]> = [
  ['General', 0],
  ['0', 1],
  ['0.00', 2],
  ['#,##0', 3],
  ['#,##0.00', 4],
  ['0%', 9],
  ['0.00%', 10],
  ['0.00E+00', 11],
  ['@', 49],
]

const XLSX_NAMED_COLORS: Record<string, string> = {
  black: 'FF000000',
  white: 'FFFFFFFF',
  red: 'FFFF0000',
  green: 'FF00B050',
  blue: 'FF0070C0',
  yellow: 'FFFFFF00',
  cyan: 'FF00FFFF',
  magenta: 'FFFF00FF',
}

function xlsxStyleColor(value: string, label: string): string | null {
  const trimmed = value.trim()
  if (!trimmed || /^(none|transparent)$/i.test(trimmed)) return null
  const named = XLSX_NAMED_COLORS[trimmed.toLowerCase()]
  const candidate = (named || trimmed).replace(/^#/, '').toUpperCase()
  if (/^[0-9A-F]{6}$/.test(candidate)) return `FF${candidate}`
  if (/^[0-9A-F]{8}$/.test(candidate)) return candidate
  throw new Error(`${label}颜色必须是 6 位十六进制（如 FF0000）或 black/red/green/blue/yellow/cyan/magenta/white`)
}

interface XlsxXmlBlock {
  start: number
  end: number
  attrs: string
  inner: string
  selfClosing: boolean
}

function xlsxXmlBlock(xml: string, tag: string): XlsxXmlBlock | null {
  const re = new RegExp(`<${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${tag}>)`, 'i')
  const match = re.exec(xml)
  if (!match) return null
  return {
    start: match.index,
    end: match.index + match[0].length,
    attrs: match[1] ?? '',
    inner: match[2] ?? '',
    selfClosing: /\/\s*>$/i.test(match[0]) && match[2] === undefined,
  }
}

function xlsxNormalizeXml(value: string): string {
  return value.replace(/>\s*</g, '><').trim()
}

function xlsxSetCount(attrs: string, count: number): string {
  if (/\bcount\s*=\s*"[^"]*"/i.test(attrs)) {
    return attrs.replace(/\bcount\s*=\s*"[^"]*"/i, `count="${count}"`)
  }
  return `${attrs} count="${count}"`
}

function xlsxSetAttr(attrs: string, name: string, value: string | number): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`\\b${escaped}\\s*=\\s*"[^"]*"`, 'i')
  if (re.test(attrs)) return attrs.replace(re, `${name}="${value}"`)
  return `${attrs} ${name}="${value}"`
}

function xlsxBlockItems(xml: string, parentTag: string, childTag: string): string[] {
  const block = xlsxXmlBlock(xml, parentTag)
  if (!block) return []
  const items: string[] = []
  const re = new RegExp(`<${childTag}\\b[^>]*?(?:/>|>[\\s\\S]*?</${childTag}>)`, 'gi')
  let match: RegExpExecArray | null
  while ((match = re.exec(block.inner))) items.push(match[0])
  return items
}

function xlsxAppendBlockItem(
  xml: string,
  parentTag: string,
  childTag: string,
  item: string,
): { xml: string; index: number } {
  const block = xlsxXmlBlock(xml, parentTag)
  if (!block) throw new Error(`xlsx styles.xml 缺少 ${parentTag}`)
  const items = xlsxBlockItems(xml, parentTag, childTag)
  const inner = block.selfClosing ? item : `${block.inner}${item}`
  const nextAttrs = xlsxSetCount(block.attrs, items.length + 1)
  const next = `<${parentTag}${nextAttrs}>${inner}</${parentTag}>`
  return {
    xml: `${xml.slice(0, block.start)}${next}${xml.slice(block.end)}`,
    index: items.length,
  }
}

function xlsxUnderlineValue(value: boolean | string): string | null {
  if (value === false) return null
  if (value === true) return 'single'
  const normalized = String(value).trim().toLowerCase()
  if (!normalized || normalized === 'false' || normalized === 'none') return null
  return normalized
}

function xlsxFontInner(base: string, options: OfficeXlsxFormatOptions): string {
  let body = base.trim() || '<sz val="11"/><name val="Calibri"/><family val="2"/>'
  const remove = (tag: string): void => {
    body = body
      .replace(new RegExp(`<${tag}\\b[^>]*/>`, 'gi'), '')
      .replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'gi'), '')
  }
  if (options.bold !== undefined) {
    remove('b')
    if (options.bold) body = `<b/>${body}`
  }
  if (options.italic !== undefined) {
    remove('i')
    if (options.italic) body = `<i/>${body}`
  }
  if (options.underline !== undefined) {
    remove('u')
    const underline = xlsxUnderlineValue(options.underline)
    if (underline) body = `<u val="${encodeXmlText(underline)}"/>${body}`
  }
  if (options.color !== undefined) {
    remove('color')
    const color = xlsxStyleColor(options.color, '字体')
    if (color) body = `<color rgb="${color}"/>${body}`
  }
  if (options.fontSize !== undefined) {
    remove('sz')
    body = `<sz val="${options.fontSize}"/>${body}`
  }
  return body
}

function xlsxFillXml(color: string): string {
  return `<fill><patternFill patternType="solid"><fgColor rgb="${color}"/><bgColor indexed="64"/></patternFill></fill>`
}

function xlsxNumberFormat(
  stylesXml: string,
  formatCode: string,
): { xml: string; numFmtId: number; applied: boolean } {
  const code = formatCode.trim()
  if (!code) throw new Error('numberFormat 不能为空')
  const builtinId = /^builtin:(\d+)$/i.exec(code)
    ? Number.parseInt(code.slice('builtin:'.length), 10)
    : XLSX_BUILTIN_NUM_FMTS.find(([name]) => name === code)?.[1]
  if (builtinId !== undefined) return { xml: stylesXml, numFmtId: builtinId, applied: true }

  const block = xlsxXmlBlock(stylesXml, 'numFmts')
  const existing = block
    ? xlsxBlockItems(stylesXml, 'numFmts', 'numFmt').find((item) =>
        new RegExp(`formatCode\\s*=\\s*"${encodeXmlText(code).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'i').test(item),
      )
    : undefined
  if (existing) {
    const id = Number.parseInt(xlsxAttr(existing, 'numFmtId'), 10)
    if (Number.isFinite(id)) return { xml: stylesXml, numFmtId: id, applied: true }
  }

  const ids = block
    ? xlsxBlockItems(stylesXml, 'numFmts', 'numFmt')
        .map((item) => Number.parseInt(xlsxAttr(item, 'numFmtId'), 10))
        .filter((id) => Number.isFinite(id))
    : []
  const numFmtId = Math.max(163, ...ids) + 1
  const item = `<numFmt numFmtId="${numFmtId}" formatCode="${encodeXmlText(code)}"/>`
  if (block) {
    const appended = xlsxAppendBlockItem(stylesXml, 'numFmts', 'numFmt', item)
    return { xml: appended.xml, numFmtId, applied: true }
  }
  const sheetTag = /<styleSheet\b[^>]*>/i.exec(stylesXml)
  if (!sheetTag) throw new Error('xlsx styles.xml 缺少 styleSheet')
  const insertion = `${sheetTag[0]}<numFmts count="1">${item}</numFmts>`
  return {
    xml: `${stylesXml.slice(0, sheetTag.index)}${insertion}${stylesXml.slice(sheetTag.index + sheetTag[0].length)}`,
    numFmtId,
    applied: true,
  }
}

function xlsxCellWithStyle(cell: XlsxCellRef, styleIndex: number): string {
  let attrs = cell.attrs
  if (/\bs\s*=\s*"[^"]*"/i.test(attrs)) attrs = attrs.replace(/\bs\s*=\s*"[^"]*"/i, `s="${styleIndex}"`)
  else attrs = `${attrs} s="${styleIndex}"`
  if (/\/\s*>$/.test(cell.xml.trim())) return `<c${attrs}/>`
  return `<c${attrs}>${cell.xml.slice(cell.xml.indexOf('>') + 1, cell.xml.lastIndexOf('</c>'))}</c>`
}

export function formatXlsxCell(buffer: Buffer, options: OfficeXlsxFormatOptions): OfficeXlsxFormatResult {
  const refMatch = /^s(\d+)-r(\d+)-c(\d+)$/i.exec(options.elementId)
  if (!refMatch) throw new Error(`无法识别的 xlsx 单元格 ID: ${options.elementId}`)
  const sheetIndex = Number.parseInt(refMatch[1], 10)
  const row = Number.parseInt(refMatch[2], 10)
  const column = Number.parseInt(refMatch[3], 10)
  const pkg = xlsxOpenPackage(buffer)
  const sheet = pkg.sheets[sheetIndex - 1]
  if (!sheet) throw new Error(`xlsx 中没有工作表 s${sheetIndex}`)
  const sheetBytes = pkg.files[sheet.path]
  const stylesBytes = pkg.files['xl/styles.xml']
  if (!sheetBytes) throw new Error(`xlsx 缺少工作表文件 ${sheet.path}`)
  if (!stylesBytes) throw new Error('xlsx 缺少 xl/styles.xml，暂不支持创建单元格样式')
  let stylesXml = new TextDecoder().decode(stylesBytes)
  const sheetXml = new TextDecoder().decode(sheetBytes)
  const cell = xlsxParseCells(sheetXml, sheetIndex, pkg.sharedStrings).find(
    (item) => item.row === row && item.column === column,
  )
  if (!cell) throw new Error(`工作表 ${sheet.name} 的 ${xlsxColumnLetters(column)}${row} 是空单元格，请先写入内容再设置格式`)

  const applyParts: string[] = []
  if (options.bold !== undefined) applyParts.push(options.bold ? 'bold' : 'bold-clear')
  if (options.italic !== undefined) applyParts.push(options.italic ? 'italic' : 'italic-clear')
  if (options.underline !== undefined) applyParts.push(xlsxUnderlineValue(options.underline) ? 'underline' : 'underline-clear')
  if (options.color !== undefined) applyParts.push(xlsxStyleColor(options.color, '字体') ? 'color' : 'color-clear')
  if (options.fill !== undefined) applyParts.push(xlsxStyleColor(options.fill, '填充') ? 'fill' : 'fill-clear')
  if (options.fontSize !== undefined) applyParts.push('fontSize')
  if (options.numberFormat !== undefined) applyParts.push('numberFormat')
  if (applyParts.length === 0) throw new Error('至少指定一个 xlsx 格式属性')

  const fonts = xlsxBlockItems(stylesXml, 'fonts', 'font')
  const xfs = xlsxBlockItems(stylesXml, 'cellXfs', 'xf')
  const styleIndex = Number.parseInt(xlsxAttr(cell.attrs, 's'), 10)
  const baseXf = xfs[Number.isFinite(styleIndex) ? styleIndex : 0] ?? `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`
  const baseXfAttrs = /<xf\b([^>]*?)(?:\/>|>)/i.exec(baseXf)?.[1] ?? ''
  const baseFontId = Number.parseInt(xlsxAttr(baseXfAttrs, 'fontId'), 10) || 0
  const baseFillId = Number.parseInt(xlsxAttr(baseXfAttrs, 'fillId'), 10) || 0
  const baseFont = fonts[baseFontId] ?? ''
  const fontInner = xlsxFontInner(
    /<font\b[^>]*>([\s\S]*?)<\/font>/i.exec(baseFont)?.[1] ?? '',
    options,
  )
  let fontId = fonts.findIndex((item) => xlsxNormalizeXml(item) === xlsxNormalizeXml(`<font>${fontInner}</font>`))
  if (fontId < 0) {
    const appended = xlsxAppendBlockItem(stylesXml, 'fonts', 'font', `<font>${fontInner}</font>`)
    stylesXml = appended.xml
    fontId = appended.index
  }

  let fillId = baseFillId
  const fillColor = options.fill === undefined ? undefined : xlsxStyleColor(options.fill, '填充')
  if (options.fill !== undefined) {
    if (!fillColor) {
      fillId = 0
    } else {
      const fill = xlsxFillXml(fillColor)
      const existing = xlsxBlockItems(stylesXml, 'fills', 'fill').findIndex(
        (item) => xlsxNormalizeXml(item) === xlsxNormalizeXml(fill),
      )
      if (existing >= 0) fillId = existing
      else {
        const appended = xlsxAppendBlockItem(stylesXml, 'fills', 'fill', fill)
        stylesXml = appended.xml
        fillId = appended.index
      }
    }
  }

  let numFmtId = Number.parseInt(xlsxAttr(baseXfAttrs, 'numFmtId'), 10) || 0
  if (options.numberFormat !== undefined) {
    const format = xlsxNumberFormat(stylesXml, options.numberFormat)
    stylesXml = format.xml
    numFmtId = format.numFmtId
  }

  let nextXfAttrs = xlsxSetAttr(baseXfAttrs, 'fontId', fontId)
  nextXfAttrs = xlsxSetAttr(nextXfAttrs, 'fillId', fillId)
  nextXfAttrs = xlsxSetAttr(nextXfAttrs, 'numFmtId', numFmtId)
  nextXfAttrs = xlsxSetAttr(nextXfAttrs, 'applyFont', 1)
  if (fillId !== baseFillId) nextXfAttrs = xlsxSetAttr(nextXfAttrs, 'applyFill', 1)
  if (options.numberFormat !== undefined) nextXfAttrs = xlsxSetAttr(nextXfAttrs, 'applyNumberFormat', 1)
  const baseXfInner = /<xf\b[^>]*?(?:\/>|>([\s\S]*?)<\/xf>)/i.exec(baseXf)?.[1] ?? ''
  const nextXf = baseXfInner ? `<xf${nextXfAttrs}>${baseXfInner}</xf>` : `<xf${nextXfAttrs}/>`
  let nextStyleIndex = xlsxBlockItems(stylesXml, 'cellXfs', 'xf').findIndex(
    (item) => xlsxNormalizeXml(item) === xlsxNormalizeXml(nextXf),
  )
  if (nextStyleIndex < 0) {
    const appended = xlsxAppendBlockItem(stylesXml, 'cellXfs', 'xf', nextXf)
    stylesXml = appended.xml
    nextStyleIndex = appended.index
  }

  const nextSheetXml = `${sheetXml.slice(0, cell.start)}${xlsxCellWithStyle(cell, nextStyleIndex)}${sheetXml.slice(cell.end)}`
  pkg.files[sheet.path] = new TextEncoder().encode(nextSheetXml)
  pkg.files['xl/styles.xml'] = new TextEncoder().encode(stylesXml)
  return {
    buffer: Buffer.from(zipSync(pkg.files, { level: 6 })),
    elementId: options.elementId,
    kind: 'sheet_cell',
    applied: applyParts,
    styleIndex: nextStyleIndex,
  }
}
