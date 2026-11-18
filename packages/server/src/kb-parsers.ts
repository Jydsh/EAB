/**
 * 知识库文件解析器：把常见文档转成统一的 KbBlock[]。
 *
 * P0 覆盖文本类与 PDF / OOXML / 图片的“识别入口”；P1 接入扫描 PDF 页面渲染与 OCR：
 * - 文本、Markdown、CSV、JSON、HTML：纯 Node 实现；
 * - PDF：pdfjs-dist 文本层；空文本页用 canvas 渲染后交给 ocrPage，没有 OCR 时抛 OCR_REQUIRED；
 * - DOCX / XLSX / PPTX：fflate + OOXML 文本提取；
 * - 图片：由流水线直接调用 kb.ocr，单文件解析入口仍按 OCR_REQUIRED 处理。
 */
import { createHash } from 'node:crypto'
import { basename, extname, posix } from 'node:path'
import { unzipSync } from 'fflate'
import type { KbBlock, KbBlockType } from './kb-splitter.js'

export interface KbParsedImage {
  /** 解析结果内部引用，流水线落盘后换成 assetId。 */
  ref: string
  buffer: Buffer
  filename: string
  mime?: string
  pageNo?: number
  caption?: string
  width?: number
  height?: number
  kind?: 'document_image' | 'page_render' | 'standalone'
  /** 已经 OCR 过的文本（扫描页），流水线不再重复识别。 */
  ocrText?: string
}

export class KbParseError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'KbParseError'
    this.code = code
  }
}

export interface KbParseResult {
  blocks: KbBlock[]
  text: string
  meta: Record<string, unknown>
  pageCount: number
  /** 文档中抽出的图片资产；由流水线统一落盘并补 OCR/摘要。 */
  images?: KbParsedImage[]
}

interface ParseInput {
  buffer: Buffer
  filename: string
  mime: string
  /** 扫描页/图片没有文本层时的 OCR 回调；不传则按 needs_config 处理。 */
  ocrPage?: (png: Buffer, filename: string, pageNo: number) => Promise<string>
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
}

const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.html', '.htm', '.log'])
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const LEGACY_OFFICE = new Set(['.doc', '.xls', '.ppt'])
const OOXML_EXT = new Set(['.docx', '.xlsx', '.pptx'])

function decodeText(buffer: Buffer): string {
  if (buffer.length === 0) return ''
  const bytes = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? buffer.subarray(3) : buffer
  for (const encoding of ['utf-8', 'gb18030']) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(bytes)
    } catch {
      // 继续尝试下一个编码
    }
  }
  return bytes.toString('utf8')
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
}

function stripTags(value: string): string {
  return decodeXml(value.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

function block(
  text: string,
  type: KbBlockType,
  headingPath: string[] = [],
  extra: Partial<KbBlock> = {},
): KbBlock {
  return {
    id: extra.id ?? `b_${Math.random().toString(36).slice(2, 10)}`,
    text: text.trim(),
    type,
    headingPath,
    ...extra,
  }
}

function collectText(blocks: readonly KbBlock[]): string {
  return blocks.map((item) => item.text.trim()).filter(Boolean).join('\n\n')
}

function imageMime(filename: string): string {
  return IMAGE_MIME[extname(filename).toLowerCase()] ?? 'image/png'
}

function isImagePart(name: string): boolean {
  return Boolean(IMAGE_MIME[extname(name).toLowerCase()])
}

/** 把 OOXML 关系 Target（可能带 ../）解析成 zip 内的绝对 part 名。 */
function resolvePartPath(basePart: string, target: string): string {
  const baseDir = posix.dirname(basePart)
  const value = target.startsWith('/') ? target.slice(1) : posix.join(baseDir, target)
  return posix.normalize(value).replace(/^\.\//, '')
}

function parseRelationships(xml: Buffer | Uint8Array | undefined, basePart: string): Map<string, string> {
  const map = new Map<string, string>()
  if (!xml) return map
  const text = Buffer.from(xml).toString('utf8')
  for (const match of text.matchAll(/<Relationship[^>]*>/g)) {
    const tag = match[0]
    const id = /Id="([^"]+)"/.exec(tag)?.[1]
    const target = /Target="([^"]+)"/.exec(tag)?.[1]
    if (!id || !target) continue
    map.set(id, resolvePartPath(basePart, decodeXml(target)))
  }
  return map
}

function imageHash(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 16)
}

function imageBlockText(caption: string, filename: string): string {
  return `[图片] ${caption || basename(filename)}`
}

/** 在 OOXML 的段落/表格里抽取图片块；rId 只在本 part 的关系文件里有效。 */
function pushOoxmlImages(
  blocks: KbBlock[],
  images: KbParsedImage[],
  xml: string,
  rels: Map<string, string>,
  files: Record<string, Uint8Array>,
  headingPath: string[],
  options: {
    pageNo?: number
    sheetName?: string
    source: 'docx' | 'pptx' | 'xlsx'
    caption?: string
  },
): void {
  const seen = new Set<string>()
  for (const match of xml.matchAll(/<a:blip[^>]*>/g)) {
    const tag = match[0]
    const rId = /r:embed="([^"]+)"/.exec(tag)?.[1] ?? /r:link="([^"]+)"/.exec(tag)?.[1]
    if (!rId || seen.has(rId)) continue
    seen.add(rId)
    const part = rels.get(rId)
    if (!part || !isImagePart(part)) continue
    const data = files[part]
    if (!data || data.length < 32) continue
    const buffer = Buffer.from(data)
    const caption = options.caption ? decodeXml(options.caption) : ''
    const ref = `img_${imageHash(buffer)}`
    if (!images.some((item) => item.ref === ref)) {
      images.push({
        ref,
        buffer,
        filename: basename(part),
        mime: imageMime(part),
        pageNo: options.pageNo,
        caption,
        kind: 'document_image',
      })
    }
    blocks.push(block(imageBlockText(caption, part), 'image', [...headingPath], {
      pageNo: options.pageNo,
      ...(options.sheetName ? { sheetName: options.sheetName } : {}),
      meta: {
        imageRef: ref,
        imageCaption: caption,
        imageSource: options.source,
        imagePart: part,
        positionApproximate: options.source === 'xlsx',
      },
    }))
  }
}

function docxCcprCaption(xml: string): string {
  return /<wp:docPr[^>]*descr="([^"]*)"/.exec(xml)?.[1] ?? ''
}

function parsePlainText(text: string, filename: string): KbParseResult {
  const blocks: KbBlock[] = []
  const parts = text.replace(/\r\n/g, '\n').split(/\n{2,}/)
  for (const part of parts) {
    const value = part.trim()
    if (!value) continue
    if (value.startsWith('#')) {
      const match = /^(#{1,6})\s+(.+)$/.exec(value)
      if (match) {
        blocks.push(block(match[2].trim(), 'heading', [match[2].trim()], { meta: { level: match[1].length } }))
        continue
      }
    }
    const lines = value.split('\n')
    const isList = lines.every((line) => /^[-*•]\s+/.test(line) || /^\d+[.)、]\s+/.test(line))
    blocks.push(block(value, isList ? 'list' : 'paragraph'))
  }
  return {
    blocks,
    text: collectText(blocks),
    meta: { parser: 'text', filename },
    pageCount: 0,
  }
}

function parseMarkdown(text: string, filename: string): KbParseResult {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: KbBlock[] = []
  const headingPath: string[] = []
  let paragraph: string[] = []
  let code: string[] | null = null
  let codeLang = ''
  let table: string[] = []

  const flushParagraph = (): void => {
    if (!paragraph.length) return
    const value = paragraph.join('\n').trim()
    if (value) {
      const isList = value.split('\n').every((line) => /^[-*•]\s+/.test(line) || /^\d+[.)、]\s+/.test(line))
      blocks.push(block(value, isList ? 'list' : 'paragraph', [...headingPath]))
    }
    paragraph = []
  }
  const flushTable = (): void => {
    if (!table.length) return
    const value = table.join('\n').trim()
    if (value) blocks.push(block(value, 'table', [...headingPath], { meta: { format: 'markdown' } }))
    table = []
  }

  for (const line of lines) {
    if (code) {
      if (/^```/.test(line.trim())) {
        blocks.push(block(code.join('\n'), 'code', [...headingPath], { meta: { language: codeLang } }))
        code = null
        codeLang = ''
      } else {
        code.push(line)
      }
      continue
    }
    if (/^```/.test(line.trim())) {
      flushParagraph()
      flushTable()
      code = []
      codeLang = line.trim().replace(/^```/, '').trim()
      continue
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line)
    if (heading) {
      flushParagraph()
      flushTable()
      const level = heading[1].length
      headingPath.length = Math.max(0, level - 1)
      headingPath[level - 1] = heading[2].trim()
      blocks.push(block(heading[2].trim(), 'heading', [...headingPath], { meta: { level } }))
      continue
    }
    if (/^\|.*\|$/.test(line.trim())) {
      flushParagraph()
      table.push(line)
      continue
    }
    if (!line.trim()) {
      flushParagraph()
      flushTable()
      continue
    }
    flushTable()
    paragraph.push(line)
  }
  flushParagraph()
  flushTable()
  if (code) blocks.push(block(code.join('\n'), 'code', [...headingPath]))
  return {
    blocks,
    text: collectText(blocks),
    meta: { parser: 'markdown', filename },
    pageCount: 0,
  }
}

function parseCsv(text: string, filename: string): KbParseResult {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  const source = text.replace(/\r\n/g, '\n')
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
    } else if (char === ',') {
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

  const blocks: KbBlock[] = []
  if (rows.length > 0) {
    const textRows = rows.map((cells) => cells.map((value) => value.replace(/\t/g, ' ').trim()).join('\t'))
    blocks.push(block(textRows.join('\n'), 'table', [], { meta: { format: 'csv', columns: rows[0]?.length ?? 0 } }))
  }
  return {
    blocks,
    text: collectText(blocks),
    meta: { parser: 'csv', filename, rows: rows.length },
    pageCount: 0,
  }
}

function parseJson(text: string, filename: string): KbParseResult {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new KbParseError('PARSE_JSON', `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const blocks: KbBlock[] = []
  const push = (key: string, item: unknown): void => {
    const rendered = typeof item === 'string' ? item : JSON.stringify(item, null, 2)
    if (!rendered) return
    blocks.push(block(rendered, 'code', key ? [key] : [], { meta: { jsonKey: key } }))
  }
  if (Array.isArray(value)) {
    value.slice(0, 500).forEach((item, index) => push(`[${index}]`, item))
    if (value.length > 500) blocks.push(block(`（数组共 ${value.length} 项，已解析前 500 项）`, 'paragraph'))
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) push(key, item)
  } else {
    push('', value)
  }
  return {
    blocks,
    text: collectText(blocks),
    meta: { parser: 'json', filename },
    pageCount: 0,
  }
}

function parseHtml(text: string, filename: string): KbParseResult {
  const withoutNoise = text
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
  const blocks: KbBlock[] = []
  const headingRegex = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi
  const sectionRegex = /<(h[1-6]|p|li|table)[^>]*>([\s\S]*?)<\/\1>/gi
  let match: RegExpExecArray | null
  let headingPath: string[] = []
  while ((match = sectionRegex.exec(withoutNoise)) !== null) {
    const tag = match[1].toLowerCase()
    const value = stripTags(match[2])
    if (!value) continue
    if (tag.startsWith('h')) {
      const level = Number(tag.slice(1))
      headingPath.length = Math.max(0, level - 1)
      headingPath[level - 1] = value
      blocks.push(block(value, 'heading', [...headingPath], { meta: { level } }))
    } else if (tag === 'table') {
      blocks.push(block(value, 'table', [...headingPath]))
    } else if (tag === 'li') {
      blocks.push(block(value, 'list', [...headingPath]))
    } else {
      blocks.push(block(value, 'paragraph', [...headingPath]))
    }
  }
  if (blocks.length === 0) {
    const value = stripTags(withoutNoise)
    if (value) blocks.push(block(value, 'paragraph'))
  }
  // 避免 headingRegex 未使用导致 lint 报错；HTML 标题已由 sectionRegex 覆盖。
  void headingRegex
  return {
    blocks,
    text: collectText(blocks),
    meta: { parser: 'html', filename },
    pageCount: 0,
  }
}

async function parsePdf(
  buffer: Buffer,
  filename: string,
  ocrPage?: ParseInput['ocrPage'],
): Promise<KbParseResult> {
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as {
    getDocument(options: Record<string, unknown>): { promise: Promise<any> }
    OPS: Record<string, number>
    ImageKind: Record<string, number>
  }
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    disableWorker: true,
    isEvalSupported: false,
  }).promise
  const blocks: KbBlock[] = []
  const images: KbParsedImage[] = []
  const pageCount = Number(doc.numPages ?? 0)
  let emptyPages = 0
  let ocrPages = 0
  let imageCount = 0
  const seenImageHashes = new Set<string>()
  try {
    for (let pageNo = 1; pageNo <= pageCount; pageNo += 1) {
      const page = await doc.getPage(pageNo)
      const content = await page.getTextContent()
      const items = Array.isArray(content.items) ? content.items : []
      const lines: string[] = []
      for (const item of items as Array<Record<string, unknown>>) {
        if (typeof item.str !== 'string' || !item.str.trim()) continue
        lines.push(item.str)
      }
      const text = lines.join(' ').replace(/\s+/g, ' ').trim()
      if (!text) {
        if (ocrPage) {
          try {
            const png = await renderPdfPagePng(page)
            const ocrText = (await ocrPage(png, filename, pageNo)).trim()
            if (ocrText) {
              const ref = `pdf_page_${pageNo}`
              images.push({
                ref,
                buffer: png,
                filename: `page-${pageNo}.png`,
                mime: 'image/png',
                pageNo,
                caption: `第 ${pageNo} 页扫描页`,
                kind: 'page_render',
                ocrText,
              })
              blocks.push(block(`[图片] 第 ${pageNo} 页扫描页\n${ocrText}`, 'image', [], {
                pageNo,
                meta: { imageRef: ref, imageCaption: `第 ${pageNo} 页扫描页`, imageSource: 'pdf_scan', ocr: true },
              }))
              imageCount += 1
              ocrPages += 1
              page.cleanup?.()
              continue
            }
          } catch (error) {
            throw new KbParseError(
              'OCR_REQUIRED',
              `PDF 第 ${pageNo} 页是扫描页，OCR 失败：${error instanceof Error ? error.message : String(error)}`,
            )
          }
        }
        emptyPages += 1
        blocks.push(block(`（第 ${pageNo} 页没有可提取文本，可能是扫描页）`, 'paragraph', [], {
          pageNo,
          meta: { scanned: true },
        }))
      } else {
        blocks.push(block(text, 'paragraph', [], { pageNo }))
        try {
          const pageImages = await extractPdfPageImages(page, pageNo, pdfjs)
          for (const image of pageImages) {
            if (imageCount >= 24) break
            if (seenImageHashes.has(imageHash(image.buffer))) continue
            seenImageHashes.add(imageHash(image.buffer))
            const ref = `pdf_img_${pageNo}_${imageCount}`
            images.push({ ...image, ref, filename: `page-${pageNo}-image-${imageCount + 1}.png`, kind: 'document_image' })
            blocks.push(block(`[图片] 第 ${pageNo} 页图片`, 'image', [], {
              pageNo,
              meta: { imageRef: ref, imageCaption: `第 ${pageNo} 页图片`, imageSource: 'pdf' },
            }))
            imageCount += 1
          }
        } catch {
          // PDF 图片对象在不同生成器下差异很大；抽不到时不影响文本入库。
        }
      }
      page.cleanup?.()
    }
  } finally {
    await doc.destroy?.()
  }
  if (pageCount > 0 && emptyPages === pageCount) {
    throw new KbParseError('OCR_REQUIRED', 'PDF 没有可提取的文本层，需要配置 OCR 模型后重试')
  }
  return {
    blocks,
    text: collectText(blocks),
    meta: { parser: 'pdf', filename, emptyPages, pageCount, ocrPages, images: images.length },
    pageCount,
    ...(images.length ? { images } : {}),
  }
}

interface PdfImageObject {
  width?: number
  height?: number
  data?: Uint8Array | Uint8ClampedArray
  kind?: number
}

async function extractPdfPageImages(
  page: any,
  pageNo: number,
  pdfjs: { OPS: Record<string, number>; ImageKind: Record<string, number> },
): Promise<Array<{ buffer: Buffer; width: number; height: number; pageNo: number }>> {
  const operatorList = await page.getOperatorList()
  const out: Array<{ buffer: Buffer; width: number; height: number; pageNo: number }> = []
  const ops = pdfjs.OPS
  const imageOps = new Set<number>(
    [ops.paintImageXObject, ops.paintJpegXObject, ops.paintInlineImageXObject].filter(
      (value): value is number => typeof value === 'number',
    ),
  )
  for (let index = 0; index < (operatorList.fnArray?.length ?? 0); index += 1) {
    const fn = Number(operatorList.fnArray[index])
    if (!imageOps.has(fn)) continue
    const args = operatorList.argsArray[index] ?? []
    let object: PdfImageObject | null = null
    if (Number(fn) === ops.paintInlineImageXObject) {
      object = args[0] as PdfImageObject
    } else if (typeof args[0] === 'string' && page.objs?.get) {
      try {
        object = (await page.objs.get(args[0])) as PdfImageObject
      } catch {
        object = null
      }
    }
    if (!object) continue
    const width = Number(object.width ?? 0)
    const height = Number(object.height ?? 0)
    if (width < 96 || height < 96 || width * height > 20_000_000) continue
    const png = await pdfImageToPng(object)
    if (png) out.push({ buffer: png, width, height, pageNo })
  }
  return out
}

/** pdfjs 图像对象统一转 PNG；只支持常见的 1bpp 灰度、RGB、RGBA。 */
async function pdfImageToPng(image: PdfImageObject): Promise<Buffer | null> {
  const width = Number(image.width ?? 0)
  const height = Number(image.height ?? 0)
  const data = image.data
  if (!data || width <= 0 || height <= 0) return null
  const pixels = width * height
  if (data.length < pixels * 3) return null
  const rgba = new Uint8ClampedArray(pixels * 4)
  if (data.length >= pixels * 4) {
    rgba.set(data.subarray(0, pixels * 4))
  } else if (data.length >= pixels * 3) {
    for (let i = 0; i < pixels; i += 1) {
      rgba[i * 4] = data[i * 3]!
      rgba[i * 4 + 1] = data[i * 3 + 1]!
      rgba[i * 4 + 2] = data[i * 3 + 2]!
      rgba[i * 4 + 3] = 255
    }
  } else {
    return null
  }
  const { createCanvas, ImageData } = (await import('@napi-rs/canvas')) as {
    createCanvas(width: number, height: number): {
      getContext(type: '2d'): { putImageData(data: unknown, x: number, y: number): void }
      toBuffer(mime: 'image/png'): Buffer
    }
    ImageData: new (data: Uint8ClampedArray, width: number, height: number) => unknown
  }
  const canvas = createCanvas(width, height)
  canvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0)
  return canvas.toBuffer('image/png')
}

/** 用 canvas 渲染 PDF 页面，2 倍缩放保证 OCR 字形清楚。 */
async function renderPdfPagePng(page: any): Promise<Buffer> {
  const { createCanvas } = (await import('@napi-rs/canvas')) as {
    createCanvas(width: number, height: number): {
      getContext(type: '2d'): unknown
      toBuffer(mime: 'image/png'): Buffer
    }
  }
  const viewport = page.getViewport({ scale: 2 })
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
  const canvasContext = canvas.getContext('2d')
  await page.render({ canvasContext, viewport, canvas }).promise
  return canvas.toBuffer('image/png')
}

function parseDocx(buffer: Buffer, filename: string): KbParseResult {
  const files = unzipSync(new Uint8Array(buffer))
  const xml = files['word/document.xml']
  if (!xml) throw new KbParseError('PARSE_DOCX', 'DOCX 缺少 word/document.xml')
  const source = Buffer.from(xml).toString('utf8')
  const rels = parseRelationships(files['word/_rels/document.xml.rels'], 'word/document.xml')
  const blocks: KbBlock[] = []
  const images: KbParsedImage[] = []
  const headingPath: string[] = []
  const tableRegex = /<w:tbl>[\s\S]*?<\/w:tbl>/g
  const tables = source.match(tableRegex) ?? []
  const body = source.replace(tableRegex, '\n')
  const paragraphRegex = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g
  const paragraphs = body.match(paragraphRegex) ?? []
  for (const paragraph of paragraphs) {
    const text = stripTags(paragraph)
    if (text) {
      const styleMatch = /<w:pStyle[^>]*w:val="([^"]+)"/.exec(paragraph)
      const style = styleMatch?.[1] ?? ''
      const headingLevel = /Heading\s*([1-6])/i.exec(style)?.[1] ?? /^([1-6])$/.exec(style)?.[1]
      if (headingLevel) {
        const level = Number(headingLevel)
        headingPath.length = Math.max(0, level - 1)
        headingPath[level - 1] = text
        blocks.push(block(text, 'heading', [...headingPath], { meta: { level, style } }))
      } else {
        blocks.push(block(text, 'paragraph', [...headingPath], { meta: { style } }))
      }
    }
    pushOoxmlImages(blocks, images, paragraph, rels, files, headingPath, {
      caption: docxCcprCaption(paragraph),
      source: 'docx',
    })
  }
  for (const table of tables) {
    const rows = (table.match(/<w:tr[\s\S]*?<\/w:tr>/g) ?? []).map((row) => {
      const cells = (row.match(/<w:tc[\s\S]*?<\/w:tc>/g) ?? []).map((cell) => stripTags(cell))
      return cells.join('\t')
    })
    const text = rows.filter(Boolean).join('\n')
    if (text) blocks.push(block(text, 'table', [...headingPath], { meta: { format: 'docx' } }))
    for (const paragraph of table.match(paragraphRegex) ?? []) {
      pushOoxmlImages(blocks, images, paragraph, rels, files, headingPath, {
        caption: docxCcprCaption(paragraph),
        source: 'docx',
      })
    }
  }
  return {
    blocks,
    text: collectText(blocks),
    meta: { parser: 'docx', filename, tables: tables.length, images: images.length },
    pageCount: 0,
    ...(images.length ? { images } : {}),
  }
}

function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref.toUpperCase())?.[0] ?? 'A'
  let value = 0
  for (const char of letters) value = value * 26 + (char.charCodeAt(0) - 64)
  return Math.max(0, value - 1)
}

function parseXlsx(buffer: Buffer, filename: string): KbParseResult {
  const files = unzipSync(new Uint8Array(buffer))
  const sharedXml = files['xl/sharedStrings.xml']
  const shared = sharedXml
    ? (Buffer.from(sharedXml).toString('utf8').match(/<si[\s\S]*?<\/si>/g) ?? []).map((item) => stripTags(item))
    : []
  const workbook = files['xl/workbook.xml']
  const rels = files['xl/_rels/workbook.xml.rels']
  const relMap = new Map<string, string>()
  if (rels) {
    const text = Buffer.from(rels).toString('utf8')
    for (const match of text.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
      relMap.set(match[1], match[2])
    }
  }
  const sheetNames = new Map<string, string>()
  if (workbook) {
    const text = Buffer.from(workbook).toString('utf8')
    for (const match of text.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
      sheetNames.set(match[2], decodeXml(match[1]))
    }
  }
  const blocks: KbBlock[] = []
  const images: KbParsedImage[] = []
  const sheetFiles = Object.keys(files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
  sheetFiles.sort((a, b) => Number(/(\d+)/.exec(a)?.[1] ?? 0) - Number(/(\d+)/.exec(b)?.[1] ?? 0))
  for (const file of sheetFiles) {
    const source = Buffer.from(files[file]).toString('utf8')
    const rows: string[] = []
    const rowRegex = /<row[^>]*r="(\d+)"[^>]*>[\s\S]*?<\/row>/g
    for (const rowMatch of source.matchAll(rowRegex)) {
      const cells: string[] = []
      const cellRegex = /<c[^>]*r="([A-Z]+)(\d+)"[^>]*>([\s\S]*?)<\/c>/g
      for (const cellMatch of rowMatch[0].matchAll(cellRegex)) {
        const col = columnIndex(cellMatch[1])
        const tag = /<c[^>]*>/.exec(cellMatch[0])?.[0] ?? ''
        const type = /t="([^"]+)"/.exec(tag)?.[1] ?? ''
        let value = ''
        if (type === 's') {
          const index = Number(/<v>(\d+)<\/v>/.exec(cellMatch[3])?.[1] ?? -1)
          value = shared[index] ?? ''
        } else if (type === 'inlineStr') {
          value = stripTags(cellMatch[3])
        } else {
          value = stripTags(cellMatch[3])
        }
        while (cells.length < col) cells.push('')
        cells[col] = value.replace(/\t/g, ' ').trim()
      }
      if (cells.some(Boolean)) rows.push(cells.join('\t'))
    }
    if (rows.length > 0) {
      const name = sheetNames.get(file.split('/').pop()?.replace('.xml', '') ?? '') ?? file
      blocks.push(block(rows.join('\n'), 'table', [], {
        sheetName: name,
        rowRange: [1, rows.length],
        meta: { format: 'xlsx', sheet: name },
      }))
    }
  }
  for (const part of Object.keys(files).filter((name) => name.startsWith('xl/media/') && isImagePart(name))) {
    const data = files[part]
    if (!data || data.length < 32) continue
    const buffer = Buffer.from(data)
    const ref = `img_${imageHash(buffer)}`
    if (images.some((item) => item.ref === ref)) continue
    images.push({
      ref,
      buffer,
      filename: basename(part),
      mime: imageMime(part),
      kind: 'document_image',
    })
    blocks.push(block(`[图片] 工作表内嵌图片 ${basename(part)}`, 'image', [], {
      meta: {
        imageRef: ref,
        imageCaption: `工作表内嵌图片 ${basename(part)}`,
        imageSource: 'xlsx',
        imagePart: part,
        positionApproximate: true,
      },
    }))
  }
  return {
    blocks,
    text: collectText(blocks),
    meta: { parser: 'xlsx', filename, sheets: sheetFiles.length, images: images.length },
    pageCount: 0,
    ...(images.length ? { images } : {}),
  }
}

function parsePptx(buffer: Buffer, filename: string): KbParseResult {
  const files = unzipSync(new Uint8Array(buffer))
  const slides = Object.keys(files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(/(\d+)/.exec(a)?.[1] ?? 0) - Number(/(\d+)/.exec(b)?.[1] ?? 0))
  const blocks: KbBlock[] = []
  const images: KbParsedImage[] = []
  let pageNo = 0
  for (const file of slides) {
    pageNo += 1
    const source = Buffer.from(files[file]).toString('utf8')
    const texts = (source.match(/<a:t[\s\S]*?<\/a:t>/g) ?? []).map((item) => stripTags(item)).filter(Boolean)
    const value = texts.join('\n').trim()
    if (value) blocks.push(block(value, 'paragraph', [], { pageNo, meta: { format: 'pptx' } }))
    const relPart = file.replace('ppt/slides/', 'ppt/slides/_rels/') + '.rels'
    const rels = parseRelationships(files[relPart], file)
    const caption = /<p:cNvPr[^>]*descr="([^"]*)"/.exec(source)?.[1] ?? ''
    pushOoxmlImages(blocks, images, source, rels, files, [], {
      pageNo,
      caption,
      source: 'pptx',
    })
  }
  return {
    blocks,
    text: collectText(blocks),
    meta: { parser: 'pptx', filename, slides: slides.length, images: images.length },
    pageCount: pageNo,
    ...(images.length ? { images } : {}),
  }
}

function imagePlaceholder(buffer: Buffer, filename: string): KbParseResult {
  void buffer
  throw new KbParseError(
    'OCR_REQUIRED',
    `图片 ${filename} 需要 OCR 模型；请在模型接入中绑定 kb.ocr 后在流水线重跑`,
  )
}

export async function parseKbFile(input: ParseInput): Promise<KbParseResult> {
  const ext = extname(input.filename).toLowerCase()
  if (LEGACY_OFFICE.has(ext)) {
    throw new KbParseError('LEGACY_OFFICE', `老式 Office 格式 ${ext} 暂不支持，请另存为 .docx/.xlsx/.pptx 后重新上传`)
  }
  if (TEXT_EXT.has(ext)) {
    const text = decodeText(input.buffer)
    if (ext === '.md' || ext === '.markdown') return parseMarkdown(text, input.filename)
    if (ext === '.csv') return parseCsv(text, input.filename)
    if (ext === '.json') return parseJson(text, input.filename)
    if (ext === '.html' || ext === '.htm') return parseHtml(text, input.filename)
    return parsePlainText(text, input.filename)
  }
  if (ext === '.pdf') return parsePdf(input.buffer, input.filename, input.ocrPage)
  if (ext === '.docx') return parseDocx(input.buffer, input.filename)
  if (ext === '.xlsx') return parseXlsx(input.buffer, input.filename)
  if (ext === '.pptx') return parsePptx(input.buffer, input.filename)
  if (IMAGE_EXT.has(ext)) return imagePlaceholder(input.buffer, input.filename)
  throw new KbParseError('UNSUPPORTED_TYPE', `不支持的文件类型：${ext || input.mime || '未知'}`)
}

export function isSupportedKbFilename(filename: string): boolean {
  const ext = extname(filename).toLowerCase()
  return TEXT_EXT.has(ext) || ext === '.pdf' || OOXML_EXT.has(ext) || IMAGE_EXT.has(ext)
}

export function isImageFilename(filename: string): boolean {
  return IMAGE_EXT.has(extname(filename).toLowerCase())
}
