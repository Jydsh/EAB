import { zipSync } from 'fflate'

export interface XlsxSheet {
  name: string
  rows: Array<Array<string | number | null | undefined>>
}

export interface XlsxBuildOptions {
  /** 第一行是否按表头样式加粗并填充底色，默认 true。 */
  headerRow?: boolean
}

const CONTENT_TYPE_SHEET = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'
const CONTENT_TYPE_WORKBOOK = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'
const CONTENT_TYPE_STYLES = 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml'
const REL_OFFICE_DOCUMENT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument'
const REL_WORKSHEET = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet'
const REL_STYLES = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles'

function xmlEscape(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function columnLetters(column: number): string {
  let value = column
  let letters = ''
  while (value > 0) {
    const remainder = (value - 1) % 26
    letters = String.fromCharCode(65 + remainder) + letters
    value = Math.floor((value - 1) / 26)
  }
  return letters
}

function normalizeSheetName(raw: string, index: number, used: Set<string>): string {
  const base = (raw || `Sheet${index + 1}`)
    .replace(/[\[\]:*?/\\]/g, '_')
    .replace(/^'+|'+$/g, '')
    .trim()
    .slice(0, 31)
  let name = base || `Sheet${index + 1}`
  let suffix = 2
  while (used.has(name.toLowerCase())) {
    const tail = `_${suffix}`
    name = `${base.slice(0, 31 - tail.length)}${tail}`
    suffix += 1
  }
  used.add(name.toLowerCase())
  return name
}

function cellWidth(value: string): number {
  let width = 0
  for (const char of value) width += char.charCodeAt(0) > 127 ? 2 : 1
  return width
}

function cellXml(ref: string, raw: unknown, styleId: number | null): string {
  if (raw === null || raw === undefined) return ''
  const style = styleId ? ` s="${styleId}"` : ''
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return `<c r="${ref}"${style}><v>${raw}</v></c>`
  }
  const text = String(raw)
  if (!text.trim()) return ''
  const clipped = text.length > 32_767 ? `${text.slice(0, 32_760)}…` : text
  return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xmlEscape(clipped)}</t></is></c>`
}

function sheetXml(sheet: XlsxSheet, headerRow: boolean): string {
  const rows = sheet.rows.length > 0 ? sheet.rows : [['']]
  const columnCount = Math.max(1, ...rows.map((row) => row.length))
  const rowCount = Math.max(1, rows.length)
  const dimension = `A1:${columnLetters(columnCount)}${rowCount}`
  const widths: number[] = []
  for (let column = 0; column < columnCount; column += 1) {
    const max = Math.max(1, ...rows.slice(0, 500).map((row) => cellWidth(String(row[column] ?? ''))))
    widths.push(Math.min(60, Math.max(8, max + 2)))
  }
  const cols = widths.length > 0
    ? `<cols>${widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('')}</cols>`
    : ''
  const sheetRows = rows.map((row, rowIndex) => {
    const isHeader = headerRow && rowIndex === 0
    const cells = row.map((cell, columnIndex) => cellXml(
      `${columnLetters(columnIndex + 1)}${rowIndex + 1}`,
      cell,
      isHeader ? 1 : null,
    )).join('')
    if (!cells) return ''
    return `<row r="${rowIndex + 1}">${cells}</row>`
  }).filter(Boolean).join('')
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<dimension ref="${dimension}"/>` +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    cols +
    `<sheetData>${sheetRows}</sheetData>` +
    '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
    '</worksheet>'
}

const STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD9E2F3"/><bgColor indexed="64"/></patternFill></fill></fills>' +
  '<borders count="1"><border/></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>' +
  '</styleSheet>'

/**
 * 生成一个可直接被 Excel / OnlyOffice 打开的最小 OOXML 工作簿。
 * 不含宏、图表、批注，所有文本使用 inlineStr，避免共享字符串表带来的跨文件问题。
 */
export function buildXlsx(sheets: XlsxSheet[], options: XlsxBuildOptions = {}): Buffer {
  const headerRow = options.headerRow ?? true
  const normalized: XlsxSheet[] = (sheets.length > 0 ? sheets : [{ name: 'Sheet1', rows: [['']] }]).slice(0, 255)
  const used = new Set<string>()
  const names = normalized.map((sheet, index) => normalizeSheetName(sheet.name, index, used))
  const files: Record<string, Uint8Array> = {}
  const encoder = new TextEncoder()
  const put = (path: string, xml: string): void => {
    files[path] = encoder.encode(xml)
  }

  put('[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    `<Override PartName="/xl/workbook.xml" ContentType="${CONTENT_TYPE_WORKBOOK}"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="${CONTENT_TYPE_STYLES}"/>` +
    normalized.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="${CONTENT_TYPE_SHEET}"/>`).join('') +
    '</Types>',
  )
  put('_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    `<Relationship Id="rId1" Type="${REL_OFFICE_DOCUMENT}" Target="xl/workbook.xml"/>` +
    '</Relationships>',
  )
  put('xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets>${names.map((name, index) => `<sheet name="${xmlEscape(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets>` +
    '<calcPr calcId="171027"/>' +
    '</workbook>',
  )
  put('xl/_rels/workbook.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    normalized.map((_, index) => `<Relationship Id="rId${index + 1}" Type="${REL_WORKSHEET}" Target="worksheets/sheet${index + 1}.xml"/>`).join('') +
    `<Relationship Id="rId${normalized.length + 1}" Type="${REL_STYLES}" Target="styles.xml"/>` +
    '</Relationships>',
  )
  put('xl/styles.xml', STYLES_XML)
  normalized.forEach((sheet, index) => {
    put(`xl/worksheets/sheet${index + 1}.xml`, sheetXml(sheet, headerRow))
  })
  return Buffer.from(zipSync(files, { level: 6 }))
}

/** 把一段文本（CSV/TSV/Markdown 表格/JSON/普通文本）转成单工作表工作簿。 */
export function buildXlsxFromTabular(input: {
  sheetName?: string
  columns: string[]
  rows: string[][]
}): Buffer {
  const header = input.columns.map((column) => column)
  return buildXlsx([{
    name: input.sheetName || 'Sheet1',
    rows: [header, ...input.rows],
  }], { headerRow: true })
}
