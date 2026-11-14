/**
 * 运行中的 OnlyOffice 绑定解析。
 *
 * 环境变量是部署级锁定：设置后优先于控制台；控制台只负责补齐未由环境变量
 * 提供的 URL / 内部回访地址 / JWT 密钥。JWT 明文始终从 secrets.json 或环境变量取。
 */
import type { ServerConfig } from './config.js'
import { resolveSecret } from './secrets.js'
import { readConsoleSettings } from './settings.js'

export interface OnlyOfficeRuntime {
  readonly url: string
  readonly internalUrl: string
  readonly jwtSecret: string
  readonly urlSource: 'env' | 'console' | 'none'
  readonly internalUrlSource: 'env' | 'console' | 'default'
  readonly secretSource: 'env' | 'console' | 'none'
  readonly enabled: boolean
}

function normaliseBaseUrl(value: string): string {
  const raw = value.trim()
  if (!raw) return ''
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    if (url.search || url.hash) return ''
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '')
  } catch {
    return ''
  }
}

export function resolveOnlyOffice(config: ServerConfig, dbPath: string): OnlyOfficeRuntime {
  const saved = readConsoleSettings().onlyOffice
  const consoleUrl = normaliseBaseUrl(saved.url ?? '')
  const envInternal = normaliseBaseUrl(process.env.EAB_ONLYOFFICE_INTERNAL_URL ?? '')
  const consoleInternal = normaliseBaseUrl(saved.internalUrl ?? '')
  const url = config.onlyOfficeUrl || consoleUrl
  const internalUrl = envInternal || consoleInternal || config.onlyOfficeInternalUrl
  const jwtSecret =
    config.onlyOfficeJwtSecret || (saved.jwtSecretRef ? resolveSecret(dbPath, saved.jwtSecretRef) : '')
  return {
    url,
    internalUrl,
    jwtSecret,
    urlSource: config.onlyOfficeUrl ? 'env' : consoleUrl ? 'console' : 'none',
    internalUrlSource: envInternal ? 'env' : consoleInternal ? 'console' : 'default',
    secretSource: config.onlyOfficeJwtSecret ? 'env' : jwtSecret ? 'console' : 'none',
    enabled: Boolean(url && jwtSecret),
  }
}

export function onlyOfficeReady(runtime: OnlyOfficeRuntime): boolean {
  return runtime.enabled
}
