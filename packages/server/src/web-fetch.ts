import { EC, EabError } from '@eab/domain'
import { KbParseError, parseKbFile } from './kb-parsers.js'
import { safeGet, type SafeFetchOptions } from './net-policy.js'

/**
 * 通用网页读取适配器。
 *
 * 只负责“把一个公开 URL 变成可读内容”：正文提取、标题、站点、发布时间、链接和截断。
 * 不做搜索、不做浏览器交互，也不接受 Cookie / Authorization 等用户自定义头。
 */

const DEFAULT_MAX_CHARS = 6_000
const MAX_MAX_CHARS = 20_000
const MIN_MAX_CHARS = 200
const MAX_CACHED_CHARS = 500_000
const CACHE_TTL_MS = 120_000
const MAX_CACHE_ENTRIES = 50
const MAX_LINKS = 12

export type WebFetchFormat = 'text' | 'html'

export interface WebFetchInput {
  url: string
  format?: WebFetchFormat
  maxChars?: number
  start?: number
}

export interface WebFetchResult {
  url: string
  finalUrl: string
  title: string | null
  siteName: string | null
  publishedAt: string | null
  contentType: string
  format: WebFetchFormat
  text: string
  start: number
  truncated: boolean
  nextStart: number | null
  links: Array<{ text: string; url: string }>
  provider: 'direct'
}

export interface WebFetchOptions extends SafeFetchOptions {
  /** 测试用时钟；生产不传，使用 Date.now。 */
  now?: () => number
}

interface CachedPage {
  readonly finalUrl: string
  readonly title: string | null
  readonly siteName: string | null
  readonly publishedAt: string | null
  readonly contentType: string
  readonly format: WebFetchFormat
  readonly fullText: string
  readonly links: Array<{ text: string; url: string }>
  readonly storedAt: number
}

const pageCache = new Map<string, CachedPage>()

/** 清空网页缓存；测试和配置变更时使用。 */
export function clearWebFetchCache(): void {
  pageCache.clear()
}

function cacheSet(key: string, page: CachedPage): void {
  if (pageCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = pageCache.keys().next().value
    if (oldest !== undefined) pageCache.delete(oldest)
  }
  pageCache.set(key, page)
}

function cacheGet(key: string, now: number): CachedPage | null {
  const page = pageCache.get(key)
  if (!page) return null
  if (now - page.storedAt > CACHE_TTL_MS) {
    pageCache.delete(key)
    return null
  }
  // LRU：命中后移到末尾。
  pageCache.delete(key)
  pageCache.set(key, page)
  return page
}

function clampNumber(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

function getAttribute(tag: string, name: string): string | null {
  const expression = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
  const match = tag.match(expression)
  if (!match) return null
  return match[1] ?? match[2] ?? match[3] ?? null
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    copy: '©',
    reg: '®',
    hellip: '…',
    mdash: '—',
    ndash: '–',
    middot: '·',
    ldquo: '“',
    rdquo: '”',
    lsquo: '‘',
    rsquo: '’',
  }
  return text.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, (whole, body: string) => {
    const lower = body.toLowerCase()
    if (lower.startsWith('#x')) {
      const value = Number.parseInt(lower.slice(2), 16)
      return Number.isFinite(value) ? String.fromCodePoint(value) : whole
    }
    if (lower.startsWith('#')) {
      const value = Number.parseInt(lower.slice(1), 10)
      return Number.isFinite(value) ? String.fromCodePoint(value) : whole
    }
    return named[lower] ?? whole
  })
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '')
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/g, '')
}

function stripNoise(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template|svg|canvas|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(nav|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
}

function pickMainHtml(html: string): string {
  const articles = [...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)].map((match) => match[1])
  if (articles.length > 0) {
    const longest = articles.sort((left, right) => right.length - left.length)[0]
    if (stripTags(longest).trim().length >= 200) return longest
  }
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)
  if (main && stripTags(main[1]).trim().length >= 120) return main[1]
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)
  return body ? body[1] : html
}

/** 把 HTML 正文转成保留段落结构的纯文本。 */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<img\b[^>]*\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi, (_whole, a: string, b: string, c: string) => {
      const alt = decodeEntities(a ?? b ?? c ?? '').trim()
      return alt ? `[图片: ${alt}]` : ''
    })
    .replace(/<t[dh]\b[^>]*>/gi, ' | ')
    .replace(/<\/(p|div|section|article|header|blockquote|pre|table|tr|ul|ol|h[1-6]|figure)\s*>/gi, '\n')
    .replace(/<h[1-6]\b[^>]*>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
  return normalizeText(decodeEntities(text))
}

function extractTitle(html: string): string | null {
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)
  if (title) {
    const value = normalizeText(decodeEntities(stripTags(title[1])).replace(/\s+/g, ' '))
    if (value) return value
  }
  const heading = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)
  return heading ? normalizeText(decodeEntities(stripTags(heading[1]))) || null : null
}

interface MetaInfo {
  title: string | null
  siteName: string | null
  publishedAt: string | null
  canonical: string | null
}

function readMeta(html: string): MetaInfo {
  const values = new Map<string, string>()
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0]
    const key = (getAttribute(tag, 'property') ?? getAttribute(tag, 'name') ?? '').trim().toLowerCase()
    const content = getAttribute(tag, 'content')
    if (key && content && !values.has(key)) values.set(key, decodeEntities(content).trim())
  }
  let canonical: string | null = null
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0]
    if ((getAttribute(tag, 'rel') ?? '').toLowerCase() === 'canonical') {
      canonical = getAttribute(tag, 'href')
      break
    }
  }
  const published =
    values.get('article:published_time') ??
    values.get('published_time') ??
    values.get('datepublished') ??
    values.get('date') ??
    null
  return {
    title: values.get('og:title') ?? values.get('twitter:title') ?? extractTitle(html),
    siteName: values.get('og:site_name') ?? null,
    publishedAt: published,
    canonical,
  }
}

function extractLinks(html: string, baseUrl: string): Array<{ text: string; url: string }> {
  const seen = new Set<string>()
  const links: Array<{ text: string; url: string }> = []
  for (const match of html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = getAttribute(match[0], 'href')
    const text = normalizeText(decodeEntities(stripTags(match[1])))
    if (!href || !text || text.length < 2 || text.length > 120) continue
    if (/^(javascript|mailto|tel|data):/i.test(href.trim()) || href.startsWith('#')) continue
    let resolved: URL
    try {
      resolved = new URL(href, baseUrl)
    } catch {
      continue
    }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue
    resolved.hash = ''
    const key = resolved.href
    if (seen.has(key)) continue
    seen.add(key)
    links.push({ text, url: key })
    if (links.length >= MAX_LINKS) break
  }
  return links
}

export interface HtmlExtraction {
  title: string | null
  siteName: string | null
  publishedAt: string | null
  text: string
  links: Array<{ text: string; url: string }>
}

/** 从 HTML 中提取正文，优先 article/main，再回退 body。 */
export function extractHtml(html: string, baseUrl: string): HtmlExtraction {
  const meta = readMeta(html)
  const cleaned = stripNoise(html)
  const main = pickMainHtml(cleaned)
  let text = htmlToText(main)
  if (text.length < 200) {
    const body = cleaned.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)
    text = htmlToText(body ? body[1] : cleaned)
  }
  return {
    title: meta.title,
    siteName: meta.siteName,
    publishedAt: meta.publishedAt,
    text,
    links: extractLinks(main, baseUrl),
  }
}

function charsetFromContentType(contentType: string): string | null {
  const match = contentType.match(/charset\s*=\s*"?([^";\s]+)"?/i)
  return match ? match[1].trim().toLowerCase() : null
}

function sniffCharset(buffer: Buffer): string | null {
  const head = buffer.subarray(0, 8_192).toString('latin1')
  const match = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([^"'\s/>]+)/i)
  if (match) return match[1].trim().toLowerCase()
  const httpEquiv = head.match(/<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([^"'\s;]+)/i)
  return httpEquiv ? httpEquiv[1].trim().toLowerCase() : null
}

function normalizeCharset(label: string | null): string {
  const value = (label ?? 'utf-8').toLowerCase()
  if (value === 'gb2312' || value === 'gb_2312-80') return 'gbk'
  if (value === 'utf8') return 'utf-8'
  return value
}

/** 按响应头或页面 meta 解码 HTML；中文站点常见 gbk/gb18030。 */
export function decodeHtmlBuffer(buffer: Buffer, contentType: string): string {
  const label = normalizeCharset(charsetFromContentType(contentType) ?? sniffCharset(buffer))
  try {
    return new TextDecoder(label, { fatal: false }).decode(buffer)
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(buffer)
  }
}

function isCacheable(headers: Record<string, unknown>, status: number): boolean {
  if (status !== 200) return false
  const cacheControl = String(headers['cache-control'] ?? '').toLowerCase()
  if (cacheControl.includes('no-store') || cacheControl.includes('private')) return false
  if (headers['set-cookie']) return false
  return true
}

function filenameFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname
    const name = pathname.split('/').filter(Boolean).pop() ?? ''
    if (!name) return 'download.pdf'
    return /\.pdf$/i.test(name) ? name : `${name}.pdf`
  } catch {
    return 'download.pdf'
  }
}

async function binaryText(buffer: Buffer, contentType: string, url: string): Promise<string | null> {
  if (contentType === 'application/pdf' || url.toLowerCase().endsWith('.pdf')) {
    try {
      const parsed = await parseKbFile({
        buffer,
        filename: filenameFromUrl(url),
        mime: 'application/pdf',
      })
      return parsed.text
    } catch (err) {
      if (err instanceof KbParseError && err.code === 'OCR_REQUIRED') {
        throw new EabError(EC.VALIDATION, '这份 PDF 是扫描件，需要 OCR 才能读取', {
          hint: '先把 PDF 上传到云空间并配置 OCR，或提供网页版',
        })
      }
      throw new EabError(EC.UPSTREAM, 'PDF 解析失败', {
        hint: '换一个网页版链接，或下载后上传到云空间',
        cause: err,
      })
    }
  }
  return null
}

function resultFromPage(
  page: CachedPage,
  requestedUrl: string,
  format: WebFetchFormat,
  start: number,
  maxChars: number,
): WebFetchResult {
  const full = page.fullText
  const slice = full.slice(start, start + maxChars)
  const next = start + maxChars
  const truncated = next < full.length
  return {
    url: requestedUrl,
    finalUrl: page.finalUrl,
    title: page.title,
    siteName: page.siteName,
    publishedAt: page.publishedAt,
    contentType: page.contentType,
    format,
    text: slice,
    start,
    truncated,
    nextStart: truncated ? next : null,
    links: page.links,
    provider: 'direct',
  }
}

/**
 * 读取一个公开网页。
 *
 * 同一 URL 在 2 分钟内会复用正文缓存，避免模型因为分页读取重复抓整页；
 * 带 Set-Cookie、private/no-store 的响应不缓存。
 */
export async function webFetch(input: WebFetchInput, options: WebFetchOptions = {}): Promise<WebFetchResult> {
  const url = String(input.url ?? '').trim()
  if (!url) throw new EabError(EC.VALIDATION, 'url 不能为空')
  if (input.format !== undefined && input.format !== 'text' && input.format !== 'html') {
    throw new EabError(EC.VALIDATION, 'format 只支持 text 或 html')
  }
  const format: WebFetchFormat = input.format ?? 'text'
  const maxChars = clampNumber(input.maxChars, MIN_MAX_CHARS, MAX_MAX_CHARS, DEFAULT_MAX_CHARS)
  const start = clampNumber(input.start, 0, 10_000_000, 0)
  if (format === 'html' && start > 0) {
    throw new EabError(EC.VALIDATION, 'html 格式不支持从中间分页', {
      hint: '需要分段读取时用 format=text，或先读取正文',
    })
  }
  const now = options.now ?? Date.now

  let href: URL
  try {
    href = new URL(url)
  } catch {
    throw new EabError(EC.VALIDATION, '链接格式不正确', { hint: '提供完整的 http/https 链接' })
  }
  href.hash = ''
  const cacheKey = `${href.href}|${format}`
  const cached = cacheGet(cacheKey, now())
  if (cached) return resultFromPage(cached, href.href, format, start, maxChars)

  const response = await safeGet(href.href, {
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    signal: options.signal,
    allowPrivateNetwork: options.allowPrivateNetwork,
    allowedPorts: options.allowedPorts,
  })

  if (response.status === 404) {
    throw new EabError(EC.NOT_FOUND, '网页不存在（HTTP 404）', { hint: '检查链接是否正确' })
  }
  if (response.status === 401 || response.status === 403) {
    throw new EabError(EC.UPSTREAM, `网页需要登录或无访问权限（HTTP ${response.status}）`, {
      hint: '请用户提供公开链接，当前上网工具不携带登录态',
    })
  }
  if (response.status >= 400) {
    throw new EabError(EC.UPSTREAM, `网页返回 HTTP ${response.status}`, {
      hint: '稍后重试或换一个来源',
    })
  }

  const contentType = response.contentType || 'application/octet-stream'
  let page: CachedPage

  if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml')) {
    const html = decodeHtmlBuffer(response.body, contentType)
    const extraction = extractHtml(html, response.finalUrl)
    page = {
      finalUrl: response.finalUrl,
      title: extraction.title,
      siteName: extraction.siteName,
      publishedAt: extraction.publishedAt,
      contentType,
      format,
      fullText: format === 'html' ? html.slice(0, 2_000_000) : extraction.text.slice(0, MAX_CACHED_CHARS),
      links: extraction.links,
      storedAt: now(),
    }
  } else if (
    contentType.startsWith('text/') ||
    contentType.includes('application/json') ||
    contentType.includes('application/xml') ||
    contentType.includes('application/xhtml')
  ) {
    let text = decodeHtmlBuffer(response.body, contentType)
    if (contentType.includes('application/json')) {
      try {
        text = JSON.stringify(JSON.parse(text), null, 2)
      } catch {
        // 保留原文，让模型自己判断。
      }
    }
    page = {
      finalUrl: response.finalUrl,
      title: null,
      siteName: null,
      publishedAt: null,
      contentType,
      format,
      fullText: text.slice(0, MAX_CACHED_CHARS),
      links: [],
      storedAt: now(),
    }
  } else {
    const text = await binaryText(response.body, contentType, response.finalUrl)
    if (text === null) {
      throw new EabError(EC.VALIDATION, `暂不支持读取 ${contentType}`, {
        hint: '当前只支持网页、纯文本、JSON、XML 和文本型 PDF；其他文件请下载后上传',
      })
    }
    page = {
      finalUrl: response.finalUrl,
      title: null,
      siteName: null,
      publishedAt: null,
      contentType,
      format,
      fullText: text.slice(0, MAX_CACHED_CHARS),
      links: [],
      storedAt: now(),
    }
  }

  if (isCacheable(response.headers as Record<string, unknown>, response.status)) {
    cacheSet(cacheKey, page)
  }
  return resultFromPage(page, href.href, format, start, maxChars)
}
