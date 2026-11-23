import { EC, EabError } from '@eab/domain'
import { fetchJson } from './net-policy.js'

/**
 * 互联网搜索适配器。
 *
 * 搜索服务由管理员配置，不能让模型指定端点：
 * - `searxng`：自建、免费、无 Key，推荐默认；
 * - `bocha`：中文搜索 API，需要 Key；
 * - `tavily` / `serper`：海外搜索 API，需要 Key。
 *
 * 没有配置 provider 时返回空结果和明确提示，不抛工具失败，避免模型反复重试。
 */

const MAX_QUERY_LENGTH = 300
const MAX_RESULTS = 10
const CACHE_TTL_MS = 120_000
const MAX_CACHE_ENTRIES = 100

export type WebSearchProvider = 'none' | 'searxng' | 'bocha' | 'tavily' | 'serper'
export type WebSearchFreshness = 'all' | 'day' | 'week' | 'month'

export interface WebSearchInput {
  query: string
  count?: number
  freshness?: WebSearchFreshness
  site?: string
}

export interface WebSearchHit {
  title: string
  url: string
  snippet: string
  publishedAt: string | null
  site: string | null
}

export interface WebSearchResult {
  query: string
  provider: WebSearchProvider
  configured: boolean
  results: WebSearchHit[]
  total: number
  hint: string | null
}

export interface WebSearchOptions {
  fetchJsonImpl?: typeof fetchJson
  env?: NodeJS.ProcessEnv
  now?: () => number
}

interface CachedSearch {
  readonly result: WebSearchResult
  readonly storedAt: number
}

const searchCache = new Map<string, CachedSearch>()

export function clearWebSearchCache(): void {
  searchCache.clear()
}

function providerFromEnv(env: NodeJS.ProcessEnv): WebSearchProvider {
  const raw = String(env.EAB_WEB_SEARCH_PROVIDER ?? '').trim().toLowerCase()
  if (raw === 'searxng' || raw === 'bocha' || raw === 'tavily' || raw === 'serper') return raw
  if (raw === 'none' || raw === '') {
    return String(env.EAB_SEARXNG_URL ?? '').trim() ? 'searxng' : 'none'
  }
  throw new EabError(EC.VALIDATION, `不支持的搜索 provider：${raw}`, {
    hint: 'EAB_WEB_SEARCH_PROVIDER 只能是 none / searxng / bocha / tavily / serper',
  })
}

function providerKeyEnv(provider: WebSearchProvider): string {
  if (provider === 'bocha') return 'EAB_BOCHA_API_KEY'
  if (provider === 'tavily') return 'EAB_TAVILY_API_KEY'
  if (provider === 'serper') return 'EAB_SERPER_API_KEY'
  return ''
}

function normalizeQuery(input: WebSearchInput, provider: WebSearchProvider): string {
  let query = String(input.query ?? '').trim()
  if (!query) throw new EabError(EC.VALIDATION, '搜索词不能为空')
  if (query.length > MAX_QUERY_LENGTH) {
    throw new EabError(EC.VALIDATION, `搜索词过长（最多 ${MAX_QUERY_LENGTH} 字）`, {
      hint: '缩短到核心关键词再搜',
    })
  }
  // “今天/今日 + 具体日期”同时出现时，日期会被 SearXNG 的 Bing/Baidu 当成日历关键词，
  // 结果全变成万年历；今天/今日本身已经表达了时间，去掉冗余日期更接近用户想搜的新闻。
  if (/今天|今日/.test(query)) {
    query = query
      .replace(/\b20\d{2}[-/]\d{1,2}[-/]\d{1,2}\b/g, ' ')
      .replace(/\b20\d{2}年\d{1,2}月\d{1,2}日\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }
  const site = String(input.site ?? '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
  if (site && /^[a-z0-9.-]+$/i.test(site)) query = `${query} site:${site}`
  if (provider === 'searxng' && input.freshness && input.freshness !== 'all') {
    // SearXNG 用 time_range，不拼进 query。
    return query
  }
  return query
}

function normalizeFreshness(value: WebSearchFreshness | undefined): WebSearchFreshness {
  if (value === 'day' || value === 'week' || value === 'month') return value
  return 'all'
}

function isoDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const text = value.trim()
  if (text.length > 40) return text.slice(0, 40)
  return text
}

function siteFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname || null
  } catch {
    return null
  }
}

function cleanTitle(value: unknown): string {
  return String(value ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}

function cleanSnippet(value: unknown, limit = 500): string {
  return String(value ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}

function validHttpUrl(value: unknown): string | null {
  try {
    const url = new URL(String(value ?? ''))
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.hash = ''
    return url.href
  } catch {
    return null
  }
}

function dedupeHits(hits: WebSearchHit[], count: number): WebSearchHit[] {
  const seen = new Set<string>()
  const out: WebSearchHit[] = []
  for (const hit of hits) {
    if (!hit.title || !hit.url || seen.has(hit.url)) continue
    seen.add(hit.url)
    out.push(hit)
    if (out.length >= count) break
  }
  return out
}

async function searchSearxng(
  query: string,
  freshness: WebSearchFreshness,
  env: NodeJS.ProcessEnv,
  request: typeof fetchJson,
): Promise<WebSearchHit[]> {
  const base = String(env.EAB_SEARXNG_URL ?? '').trim()
  if (!base) {
    throw new EabError(EC.VALIDATION, 'SearXNG 地址未配置', {
      hint: '设置 EAB_SEARXNG_URL，例如 http://127.0.0.1:8080',
    })
  }
  let endpoint: URL
  try {
    endpoint = new URL('/search', base.endsWith('/') ? base : `${base}/`)
  } catch {
    throw new EabError(EC.VALIDATION, 'EAB_SEARXNG_URL 不是有效地址')
  }
  endpoint.searchParams.set('q', query)
  endpoint.searchParams.set('format', 'json')
  endpoint.searchParams.set('language', 'zh-CN')
  endpoint.searchParams.set('safesearch', '1')
  endpoint.searchParams.set('categories', 'general')
  if (freshness !== 'all') endpoint.searchParams.set('time_range', freshness)

  const data = (await request(endpoint.href, {
    headers: { accept: 'application/json' },
  })) as { results?: Array<Record<string, unknown>> }
  const items = Array.isArray(data.results) ? data.results : []
  return items.map((item) => {
    const url = validHttpUrl(item.url) ?? ''
    return {
      title: cleanTitle(item.title),
      url,
      snippet: cleanSnippet(item.content),
      publishedAt: isoDate(item.publishedDate),
      site: siteFromUrl(url),
    }
  })
}

async function searchBocha(
  query: string,
  count: number,
  freshness: WebSearchFreshness,
  env: NodeJS.ProcessEnv,
  request: typeof fetchJson,
): Promise<WebSearchHit[]> {
  const key = String(env.EAB_BOCHA_API_KEY ?? '').trim()
  if (!key) throw new EabError(EC.VALIDATION, '博查搜索 Key 未配置', { hint: '设置 EAB_BOCHA_API_KEY' })
  const body: Record<string, unknown> = { query, count, page: 1, summary: true }
  if (freshness !== 'all') body.freshness = freshness
  const data = (await request('https://api.bochaai.com/v1/web-search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  })) as { data?: { webPages?: { value?: Array<Record<string, unknown>> } } }
  const items = Array.isArray(data.data?.webPages?.value) ? data.data.webPages.value : []
  return items.map((item) => {
    const url = validHttpUrl(item.url) ?? ''
    return {
      title: cleanTitle(item.name),
      url,
      snippet: cleanSnippet(item.summary ?? item.snippet),
      publishedAt: isoDate(item.datePublished),
      site: String(item.siteName ?? '') || siteFromUrl(url),
    }
  })
}

async function searchTavily(
  query: string,
  count: number,
  env: NodeJS.ProcessEnv,
  request: typeof fetchJson,
): Promise<WebSearchHit[]> {
  const key = String(env.EAB_TAVILY_API_KEY ?? '').trim()
  if (!key) throw new EabError(EC.VALIDATION, 'Tavily Key 未配置', { hint: '设置 EAB_TAVILY_API_KEY' })
  const data = (await request('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key: key, query, max_results: count, search_depth: 'basic', include_answer: false }),
  })) as { results?: Array<Record<string, unknown>> }
  const items = Array.isArray(data.results) ? data.results : []
  return items.map((item) => {
    const url = validHttpUrl(item.url) ?? ''
    return {
      title: cleanTitle(item.title),
      url,
      snippet: cleanSnippet(item.content),
      publishedAt: isoDate(item.published_date),
      site: siteFromUrl(url),
    }
  })
}

async function searchSerper(
  query: string,
  count: number,
  freshness: WebSearchFreshness,
  env: NodeJS.ProcessEnv,
  request: typeof fetchJson,
): Promise<WebSearchHit[]> {
  const key = String(env.EAB_SERPER_API_KEY ?? '').trim()
  if (!key) throw new EabError(EC.VALIDATION, 'Serper Key 未配置', { hint: '设置 EAB_SERPER_API_KEY' })
  const body: Record<string, unknown> = { q: query, num: count, gl: 'cn', hl: 'zh-cn' }
  if (freshness !== 'all') body.tbs = `qdr:${freshness === 'day' ? 'd' : freshness === 'week' ? 'w' : 'm'}`
  const data = (await request('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify(body),
  })) as { organic?: Array<Record<string, unknown>> }
  const items = Array.isArray(data.organic) ? data.organic : []
  return items.map((item) => {
    const url = validHttpUrl(item.link) ?? ''
    return {
      title: cleanTitle(item.title),
      url,
      snippet: cleanSnippet(item.snippet),
      publishedAt: isoDate(item.date),
      site: siteFromUrl(url),
    }
  })
}

/**
 * 搜索互联网。未配置 provider 时返回 `configured:false` 和提示，不抛错；
 * 已配置但上游失败时抛 `EAB_UPSTREAM`，让调用方明确看到外部故障。
 */
export async function searchWeb(input: WebSearchInput, options: WebSearchOptions = {}): Promise<WebSearchResult> {
  const env = options.env ?? process.env
  const provider = providerFromEnv(env)
  const query = normalizeQuery(input, provider)
  const count = Math.min(MAX_RESULTS, Math.max(1, Math.floor(Number(input.count ?? 5)) || 5))
  const freshness = normalizeFreshness(input.freshness)

  if (provider === 'none') {
    return {
      query,
      provider,
      configured: false,
      results: [],
      total: 0,
      hint: '搜索服务未配置。不要猜测或编造网址，也不要用其他方式伪造搜索结果；请直接告诉用户当前无法联网搜索，并建议给出具体 URL 用 web.fetch 读取，或让管理员配置 EAB_SEARXNG_URL / 搜索 API Key。',
    }
  }

  const keyEnv = providerKeyEnv(provider)
  if (keyEnv && !String(env[keyEnv] ?? '').trim()) {
    return {
      query,
      provider,
      configured: false,
      results: [],
      total: 0,
      hint: `${provider} 未配置密钥，设置 ${keyEnv} 后可用。`,
    }
  }

  const now = options.now ?? Date.now
  const cacheKey = `${provider}|${query}|${count}|${freshness}`
  const cached = searchCache.get(cacheKey)
  if (cached && now() - cached.storedAt <= CACHE_TTL_MS) {
    return cached.result
  }

  const request = options.fetchJsonImpl ?? fetchJson
  const runSearch = (range: WebSearchFreshness): Promise<WebSearchHit[]> => {
    if (provider === 'searxng') return searchSearxng(query, range, env, request)
    if (provider === 'bocha') return searchBocha(query, count, range, env, request)
    if (provider === 'tavily') return searchTavily(query, count, env, request)
    return searchSerper(query, count, range, env, request)
  }
  let hits = await runSearch(freshness)
  let relaxedFreshness = false
  // SearXNG 的 Bing/Baidu 引擎在 time_range=day/week 下经常直接返回空结果；
  // 先按用户要求的时间窗搜，空结果再放宽到不限时间，避免把“上游过滤过严”误报成“没有结果”。
  if (hits.length === 0 && freshness !== 'all') {
    relaxedFreshness = true
    hits = await runSearch('all')
  }

  const results = dedupeHits(hits, count)
  const result: WebSearchResult = {
    query,
    provider,
    configured: true,
    results,
    total: results.length,
    hint: results.length === 0
      ? '没有搜到结果，换更短的关键词或换搜索服务。'
      : relaxedFreshness
        ? `按「${freshness}」时间范围没有结果，已放宽为不限时间；结果可能不是最近一天。`
        : null,
  }
  if (searchCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = searchCache.keys().next().value
    if (oldest !== undefined) searchCache.delete(oldest)
  }
  searchCache.set(cacheKey, { result, storedAt: now() })
  return result
}

/** 供控制台显示搜索能力状态，不返回密钥。 */
export function webSearchStatus(env: NodeJS.ProcessEnv = process.env): {
  provider: WebSearchProvider
  configured: boolean
  detail: string
} {
  let provider: WebSearchProvider
  try {
    provider = providerFromEnv(env)
  } catch {
    return { provider: 'none', configured: false, detail: 'EAB_WEB_SEARCH_PROVIDER 配置值不支持' }
  }
  if (provider === 'none') return { provider, configured: false, detail: '未配置搜索服务' }
  if (provider === 'searxng') {
    const url = String(env.EAB_SEARXNG_URL ?? '').trim()
    return { provider, configured: Boolean(url), detail: url || 'EAB_SEARXNG_URL 未配置' }
  }
  const keyEnv = providerKeyEnv(provider)
  return {
    provider,
    configured: Boolean(keyEnv && String(env[keyEnv] ?? '').trim()),
    detail: keyEnv && String(env[keyEnv] ?? '').trim() ? '密钥已配置' : `${keyEnv} 未配置`,
  }
}
