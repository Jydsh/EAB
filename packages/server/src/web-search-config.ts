/**
 * 联网搜索的控制台配置与运行时环境。
 *
 * 优先级固定为「环境变量 > 控制台 > 未配置」：
 * - provider 为 null 表示没有控制台覆盖，继续看 EAB_WEB_SEARCH_PROVIDER / EAB_SEARXNG_URL；
 * - 已设置环境变量时以部署侧为准，控制台只补环境变量未覆盖的部分；
 * - SearXNG 地址、博查 / Tavily / Serper 的 Key 也按同一顺序解析；
 * - 密钥只落 secrets.json，固定引用名与环境变量同名，接口只返回是否已配置。
 */
import { EC, EabError } from '@eab/domain'
import { readConsoleSettings, writeConsoleSettings, type WebSearchSettings } from './settings.js'
import { deleteSecret, resolveSecret, secretConfigured, storeSecret } from './secrets.js'
import {
  clearWebSearchCache,
  searchWeb,
  webSearchStatus,
  type WebSearchProvider,
} from './web-search.js'

export type WebSearchKeyName = 'bocha' | 'tavily' | 'serper'
export type WebSearchProviderConfig = WebSearchSettings['provider']

export const WEB_SEARCH_KEY_ENV: Record<WebSearchKeyName, string> = {
  bocha: 'EAB_BOCHA_API_KEY',
  tavily: 'EAB_TAVILY_API_KEY',
  serper: 'EAB_SERPER_API_KEY',
}

const PROVIDERS: readonly WebSearchProvider[] = ['none', 'searxng', 'bocha', 'tavily', 'serper']

function normalizeProvider(raw: unknown): WebSearchProvider | null {
  if (raw === undefined || raw === null || raw === '' || raw === 'auto') return null
  if (typeof raw !== 'string' || !PROVIDERS.includes(raw as WebSearchProvider)) {
    throw new EabError(EC.VALIDATION, '搜索服务类型只能是 auto / none / searxng / bocha / tavily / serper')
  }
  return raw as WebSearchProvider
}

function normalizeSearxngUrl(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') throw new EabError(EC.VALIDATION, 'SearXNG 地址必须是文本')
  const text = raw.trim()
  if (!text) return null
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    throw new EabError(EC.VALIDATION, 'SearXNG 地址格式不正确', {
      hint: '填写完整地址，例如 http://127.0.0.1:8080',
    })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new EabError(EC.VALIDATION, 'SearXNG 地址只支持 http/https')
  }
  if (parsed.username || parsed.password) {
    throw new EabError(EC.VALIDATION, 'SearXNG 地址不能包含账号密码')
  }
  parsed.hash = ''
  return parsed.href
}

/** 把控制台配置叠加到一份环境变量副本上；不修改 process.env。 */
export function effectiveWebSearchEnv(
  dbPath: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const settings = readConsoleSettings().webSearch
  const env: NodeJS.ProcessEnv = { ...base }
  if (!String(env.EAB_WEB_SEARCH_PROVIDER ?? '').trim() && settings.provider !== null) {
    env.EAB_WEB_SEARCH_PROVIDER = settings.provider
  }
  if (!String(env.EAB_SEARXNG_URL ?? '').trim() && settings.searxngUrl) {
    env.EAB_SEARXNG_URL = settings.searxngUrl
  }
  for (const name of Object.keys(WEB_SEARCH_KEY_ENV) as WebSearchKeyName[]) {
    const envName = WEB_SEARCH_KEY_ENV[name]
    const value = resolveSecret(dbPath, envName, base)
    if (value) env[envName] = value
  }
  return env
}

export interface WebSearchSettingsView {
  provider: WebSearchProvider
  configured: boolean
  detail: string
  /** 控制台显式选择的 provider；null 表示跟随环境变量 */
  configuredProvider: WebSearchProviderConfig
  /** 控制台保存的 SearXNG 地址；空字符串表示没有控制台覆盖 */
  searxngUrl: string
  effectiveSearxngUrl: string | null
  searxngUrlSource: 'console' | 'env' | 'none'
  providerSource: 'console' | 'env' | 'default'
  keys: Record<WebSearchKeyName, boolean>
}

export function webSearchSettingsView(
  dbPath: string,
  base: NodeJS.ProcessEnv = process.env,
): WebSearchSettingsView {
  const settings = readConsoleSettings().webSearch
  const env = effectiveWebSearchEnv(dbPath, base)
  const status = webSearchStatus(env)
  const keyNames = Object.keys(WEB_SEARCH_KEY_ENV) as WebSearchKeyName[]
  const keys = Object.fromEntries(
    keyNames.map((name) => [name, secretConfigured(dbPath, WEB_SEARCH_KEY_ENV[name], base)]),
  ) as Record<WebSearchKeyName, boolean>
  return {
    provider: status.provider,
    configured: status.configured,
    detail: status.detail,
    configuredProvider: settings.provider,
    searxngUrl: settings.searxngUrl ?? '',
    effectiveSearxngUrl: String(env.EAB_SEARXNG_URL ?? '').trim() || null,
    searxngUrlSource: String(base.EAB_SEARXNG_URL ?? '').trim()
      ? 'env'
      : settings.searxngUrl
        ? 'console'
        : 'none',
    providerSource: String(base.EAB_WEB_SEARCH_PROVIDER ?? '').trim() ||
      String(base.EAB_SEARXNG_URL ?? '').trim()
      ? 'env'
      : settings.provider
        ? 'console'
        : 'default',
    keys,
  }
}

export interface WebSearchSettingsInput {
  provider?: unknown
  searxngUrl?: unknown
  keys?: Partial<Record<WebSearchKeyName, unknown>>
}

export interface WebSearchProbeResult {
  ok: boolean
  provider: WebSearchProvider
  configured: boolean
  latencyMs: number
  results: Array<{ title: string; url: string; snippet: string }>
  error: string | null
  hint: string | null
}

/**
 * 保存搜索配置。`keys` 里：
 * - 非空字符串：写入 secrets.json；
 * - null：删除该密钥；
 * - undefined / 空字符串：保持原值。
 */
export function saveWebSearchSettings(
  dbPath: string,
  input: WebSearchSettingsInput,
  base: NodeJS.ProcessEnv = process.env,
): WebSearchSettingsView {
  const current = readConsoleSettings().webSearch
  const provider =
    input.provider === undefined ? current.provider : normalizeProvider(input.provider)
  const searxngUrl =
    input.searxngUrl === undefined ? current.searxngUrl : normalizeSearxngUrl(input.searxngUrl)

  if (input.keys && typeof input.keys === 'object') {
    for (const name of Object.keys(WEB_SEARCH_KEY_ENV) as WebSearchKeyName[]) {
      const value = input.keys[name]
      if (value === undefined || value === '') continue
      if (value === null) {
        deleteSecret(dbPath, WEB_SEARCH_KEY_ENV[name])
        continue
      }
      if (typeof value !== 'string') {
        throw new EabError(EC.VALIDATION, `${name} 密钥必须是文本`)
      }
      const key = value.trim()
      if (!key) continue
      if (key.length > 2_000) throw new EabError(EC.VALIDATION, `${name} 密钥过长`)
      storeSecret(dbPath, WEB_SEARCH_KEY_ENV[name], key, WEB_SEARCH_KEY_ENV[name])
    }
  }

  writeConsoleSettings({ webSearch: { provider, searxngUrl } })
  clearWebSearchCache()
  return webSearchSettingsView(dbPath, base)
}

/** 用已保存的配置发一次真实搜索，给控制台「保存并测试」用。 */
export async function probeWebSearch(
  dbPath: string,
  base: NodeJS.ProcessEnv = process.env,
): Promise<WebSearchProbeResult> {
  const env = effectiveWebSearchEnv(dbPath, base)
  const status = webSearchStatus(env)
  const startedAt = Date.now()
  if (!status.configured) {
    return {
      ok: false,
      provider: status.provider,
      configured: false,
      latencyMs: 0,
      results: [],
      error: status.detail,
      hint: '先填 SearXNG 地址或对应服务密钥，再测试',
    }
  }
  clearWebSearchCache()
  try {
    const result = await searchWeb(
      { query: '人工智能', count: 3 },
      { env },
    )
    return {
      ok: true,
      provider: result.provider,
      configured: true,
      latencyMs: Date.now() - startedAt,
      results: result.results.map((hit) => ({
        title: hit.title,
        url: hit.url,
        snippet: hit.snippet.slice(0, 120),
      })),
      error: null,
      hint: result.results.length ? null : '搜索服务连通，但没有返回结果；可换关键词再试',
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      provider: status.provider,
      configured: true,
      latencyMs: Date.now() - startedAt,
      results: [],
      error: message,
      hint: '检查搜索服务地址、密钥和网络后重试',
    }
  }
}
