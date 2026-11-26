import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage, RequestOptions } from 'node:http'
import { connect as tlsConnect } from 'node:tls'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'
import { EC, EabError } from '@eab/domain'

/**
 * 公网访问安全层。
 *
 * 通用上网工具和内置浏览器都从这里出网，统一处理：
 * - 只允许 http/https，禁止 URL 带账号密码和非标准端口；
 * - 解析域名后拒绝私网、环回、链路本地、组播和保留地址；
 * - 连接层固定已校验 IP，避免“检查完再解析”的 DNS rebinding；
 * - 重定向逐跳重新校验；
 * - 响应体流式限量，解压后再次限量。
 *
 * 管理员配置的搜索服务属于可信内部端点，单独走 `fetchJson`，不经过这里。
 */

const MAX_URL_LENGTH = 4_096
const MAX_REDIRECTS = 5
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_BYTES = 15 * 1024 * 1024
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 EAB-Web/1.0'
const PROXY_ENV_KEYS = ['EAB_HTTP_PROXY', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const
const NO_PROXY_ENV_KEYS = ['EAB_NO_PROXY', 'NO_PROXY', 'no_proxy'] as const

export interface SafeFetchOptions {
  readonly timeoutMs?: number
  readonly maxBytes?: number
  readonly signal?: AbortSignal
  /** 仅测试或管理员显式放行内网时使用；默认 false。 */
  readonly allowPrivateNetwork?: boolean
  /** 与 allowPrivateNetwork 搭配：只放行这些域名/IP；`*` 表示放行全部企业局域网。 */
  readonly privateNetworkHosts?: readonly string[]
  /** 仅测试或可信 provider 使用，允许非 80/443 端口。 */
  readonly allowedPorts?: readonly number[]
  readonly headers?: Readonly<Record<string, string>>
  /** 仅可信 provider 使用；网页抓取固定 GET。 */
  readonly method?: 'GET' | 'POST'
  readonly body?: string
}

export interface SafeFetchResponse {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: Buffer
  readonly finalUrl: string
  readonly contentType: string
}

interface ResolvedTarget {
  readonly url: URL
  readonly address: string
  readonly family: 4 | 6
}

interface RawResponse {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: Buffer
  readonly location: string | null
}

function ipv4Parts(address: string): number[] | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  const numbers = parts.map((part) => Number(part))
  if (numbers.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return null
  return numbers
}

function isPrivateIPv4(address: string): boolean {
  const parts = ipv4Parts(address)
  if (!parts) return false
  const [a, b] = parts
  if (a === 0) return true
  if (a === 10) return true
  if (a === 127) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 192 && b === 0 && parts[2] === 0) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a >= 224) return true
  return false
}

/**
 * 是否属于企业局域网可以访问的地址。
 *
 * 只包含 RFC1918、CGNAT 和 IPv6 ULA；环回、链路本地、未指定和组播不算内网，
 * 即使管理员打开“全部内网”也继续拒绝，避免浏览器打到 EAB 自己或云元数据。
 */
function isInternalIPv4(address: string): boolean {
  const parts = ipv4Parts(address)
  if (!parts) return false
  const [a, b] = parts
  if (a === 10) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  return false
}

function expandIPv6(address: string): number[] | null {
  let text = address.toLowerCase()
  const zone = text.indexOf('%')
  if (zone >= 0) text = text.slice(0, zone)
  if (!text.includes(':')) return null

  const ipv4Tail = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)
  let tailGroups: number[] = []
  if (ipv4Tail) {
    const parts = ipv4Parts(ipv4Tail[2])
    if (!parts) return null
    text = ipv4Tail[1]
    tailGroups = [(parts[0] << 8) | parts[1], (parts[2] << 8) | parts[3]]
  }

  const halves = text.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':').filter(Boolean) : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':').filter(Boolean) : []
  const explicit = left.length + right.length + tailGroups.length
  if (halves.length === 1 && explicit !== 8) return null
  if (halves.length === 2 && explicit > 7) return null

  const fill = 8 - explicit
  const groups: number[] = []
  for (const part of left) {
    const value = Number.parseInt(part, 16)
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) return null
    groups.push(value)
  }
  for (let i = 0; i < fill; i += 1) groups.push(0)
  for (const part of right) {
    const value = Number.parseInt(part, 16)
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) return null
    groups.push(value)
  }
  groups.push(...tailGroups)
  return groups.length === 8 ? groups : null
}

function isPrivateIPv6Shape(groups: number[]): boolean {
  const allZero = groups.every((value) => value === 0)
  if (allZero) return true
  if (groups.slice(0, 7).every((value) => value === 0) && groups[7] === 1) return true
  // fc00::/7 unique local
  if ((groups[0] & 0xfe00) === 0xfc00) return true
  // fe80::/10 link local
  if ((groups[0] & 0xffc0) === 0xfe80) return true
  // ff00::/8 multicast
  if ((groups[0] & 0xff00) === 0xff00) return true
  // 100::/64 discard
  if (groups[0] === 0x0100 && groups.slice(1, 4).every((value) => value === 0)) return true

  const embedded = `${Math.floor(groups[6] / 256)}.${groups[6] % 256}.${Math.floor(groups[7] / 256)}.${groups[7] % 256}`
  // IPv4-mapped ::ffff:a.b.c.d
  const mapped =
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  // NAT64 64:ff9b::/96
  const nat64 = groups[0] === 0x0064 && groups[1] === 0xff9b && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0
  if ((mapped || nat64) && isPrivateIPv4(embedded)) return true
  return false
}

/** 判断一个 IP 字面量是否属于不可访问的公网地址。 */
export function isPrivateAddress(address: string): boolean {
  const clean = address.trim().replace(/^\[|\]$/g, '')
  if (ipv4Parts(clean)) return isPrivateIPv4(clean)
  const groups = expandIPv6(clean)
  return groups ? isPrivateIPv6Shape(groups) : false
}

/** 判断一个 IP 字面量是否属于可放行的企业局域网地址。 */
export function isInternalNetworkAddress(address: string): boolean {
  const clean = address.trim().replace(/^\[|\]$/g, '')
  if (ipv4Parts(clean)) return isInternalIPv4(clean)
  const groups = expandIPv6(clean)
  if (!groups) return false
  if ((groups[0] & 0xfe00) === 0xfc00) return true
  const embedded = `${Math.floor(groups[6] / 256)}.${groups[6] % 256}.${Math.floor(groups[7] / 256)}.${groups[7] % 256}`
  const mapped =
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  const nat64 = groups[0] === 0x0064 && groups[1] === 0xff9b && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0
  return (mapped || nat64) && isInternalIPv4(embedded)
}

function domainList(env: NodeJS.ProcessEnv, key: string): string[] {
  return String(env[key] ?? '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
}

function matchesDomain(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase()
  const target = domain.toLowerCase().replace(/^\*\./, '')
  return host === target || host.endsWith(`.${target}`)
}

/**
 * 是否允许这个主机名访问私网。
 *
 * 只有管理员显式打开开关才可能为真；名单非空时还必须命中名单。
 * 这样即使误开开关，也不会把整个内网一次性放给模型。
 */
function allowsPrivateHost(hostname: string, options: SafeFetchOptions): boolean {
  if (!options.allowPrivateNetwork) return false
  const allowlist = options.privateNetworkHosts
  if (!allowlist || allowlist.length === 0) return true
  if (allowlist.includes('*')) return true
  return allowlist.some((domain) => matchesDomain(hostname, domain))
}

function assertDomainPolicy(url: URL, env: NodeJS.ProcessEnv): void {
  const allowed = domainList(env, 'EAB_WEB_ALLOWED_DOMAINS')
  const denied = domainList(env, 'EAB_WEB_DENIED_DOMAINS')
  const host = url.hostname.toLowerCase()
  if (denied.some((domain) => matchesDomain(host, domain))) {
    throw new EabError(EC.VALIDATION, `当前企业策略不允许访问 ${host}`, {
      hint: '换一个公开来源，或让管理员从禁止域名里移除',
    })
  }
  if (allowed.length > 0 && !allowed.some((domain) => matchesDomain(host, domain))) {
    throw new EabError(EC.VALIDATION, `当前企业策略只允许访问白名单域名，${host} 不在名单内`, {
      hint: '让管理员把该域名加入 EAB_WEB_ALLOWED_DOMAINS，或提供白名单内的链接',
    })
  }
}

/**
 * 判断 `NO_PROXY` 是否命中目标。支持 `*`、域名后缀、`host:port` 和 IPv6 字面量。
 * 企业代理是管理员配置的基础设施，不走公网域名策略。
 */
function matchesNoProxy(url: URL, entries: readonly string[]): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
  for (const raw of entries) {
    const entry = raw.trim().toLowerCase()
    if (!entry) continue
    if (entry === '*') return true

    let entryHost = entry
    let entryPort: number | null = null
    const bracket = entry.match(/^\[([^\]]+)\](?::(\d+))?$/)
    if (bracket) {
      entryHost = bracket[1]
      entryPort = bracket[2] ? Number(bracket[2]) : null
    } else {
      const colon = entry.lastIndexOf(':')
      if (colon > 0 && entry.indexOf(':') === colon) {
        const maybePort = Number(entry.slice(colon + 1))
        if (Number.isInteger(maybePort) && maybePort > 0) {
          entryHost = entry.slice(0, colon)
          entryPort = maybePort
        }
      }
    }
    if (entryPort !== null && entryPort !== port) continue
    entryHost = entryHost.replace(/^\*?\./, '').replace(/^\*/, '')
    if (!entryHost) continue
    if (host === entryHost || host.endsWith(`.${entryHost}`)) return true
  }
  return false
}

/** 解析管理员配置的 HTTP 代理；没有配置、命中了 NO_PROXY 或配置不合法时返回 null。 */
export function proxyForUrl(
  rawUrl: string | URL,
  env: NodeJS.ProcessEnv = process.env,
): URL | null {
  let target: URL
  try {
    target = typeof rawUrl === 'string' ? new URL(rawUrl) : rawUrl
  } catch {
    return null
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return null

  const noProxy = NO_PROXY_ENV_KEYS.flatMap((key) =>
    String(env[key] ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  )
  if (noProxy.length > 0 && matchesNoProxy(target, noProxy)) return null

  const rawProxy = PROXY_ENV_KEYS.map((key) => String(env[key] ?? '').trim()).find(Boolean)
  if (!rawProxy) return null
  let proxy: URL
  try {
    proxy = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(rawProxy) ? rawProxy : `http://${rawProxy}`)
  } catch {
    throw new EabError(EC.VALIDATION, 'EAB_HTTP_PROXY 不是有效地址', {
      hint: '代理地址应形如 http://127.0.0.1:7890',
    })
  }
  if (proxy.protocol !== 'http:' && proxy.protocol !== 'https:') {
    throw new EabError(EC.VALIDATION, '代理只支持 http/https', { hint: '检查 EAB_HTTP_PROXY 协议' })
  }
  if (!proxy.hostname) {
    throw new EabError(EC.VALIDATION, 'EAB_HTTP_PROXY 缺少主机名')
  }
  return proxy
}

function proxyPort(proxy: URL): number {
  if (proxy.port) return Number(proxy.port)
  return proxy.protocol === 'https:' ? 443 : 80
}

function proxyAuthorization(proxy: URL): Record<string, string> {
  if (!proxy.username && !proxy.password) return {}
  const user = decodeURIComponent(proxy.username)
  const pass = decodeURIComponent(proxy.password)
  return { 'proxy-authorization': `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` }
}

async function resolveTarget(url: URL, options: SafeFetchOptions, env: NodeJS.ProcessEnv): Promise<ResolvedTarget> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new EabError(EC.VALIDATION, '只支持 http/https 链接', {
      hint: '提供以 http:// 或 https:// 开头的公开链接',
    })
  }
  if (url.username || url.password) {
    throw new EabError(EC.VALIDATION, '链接不能包含账号密码', {
      hint: '把账号密码从 URL 里去掉，需要登录的页面请先让用户提供公开链接',
    })
  }
  if (url.href.length > MAX_URL_LENGTH) {
    throw new EabError(EC.VALIDATION, '链接过长', { hint: '使用更短的原始链接' })
  }
  const ports = options.allowedPorts ?? [80, 443]
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
  if (!ports.includes(port)) {
    throw new EabError(EC.VALIDATION, `不允许访问端口 ${port}`, { hint: '只开放 80/443 标准网页端口' })
  }

  assertDomainPolicy(url, env)

  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (!hostname) throw new EabError(EC.VALIDATION, '链接缺少域名')
  const allowPrivate = allowsPrivateHost(hostname, options)
  const wildcardPrivate = options.allowPrivateNetwork === true && options.privateNetworkHosts?.includes('*') === true
  // localhost 永远拒绝，包括管理员名单：EAB 自己的控制台和接口不能被模型访问。
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new EabError(EC.VALIDATION, '不允许访问本机或局域网地址', { hint: '换成公网域名或公网 IP' })
  }
  if (hostname.endsWith('.local') && !allowPrivate) {
    throw new EabError(EC.VALIDATION, '不允许访问本机或局域网地址', {
      hint: '让管理员把该域名加入内置浏览器内网白名单，或填 * 放行全部局域网目标',
    })
  }

  let address = hostname
  let family: 4 | 6 = 4
  if (ipv4Parts(hostname)) {
    if (isPrivateAddress(hostname)) {
      if (!allowPrivate) {
        throw new EabError(EC.VALIDATION, '不允许访问内网、本机或保留地址', { hint: '提供公网可访问的链接' })
      }
      if (wildcardPrivate && !isInternalNetworkAddress(hostname)) {
        throw new EabError(EC.VALIDATION, '内网访问仅放行企业局域网，本机、链路本地和保留地址仍被拒绝', {
          hint: '使用 RFC1918 / CGNAT / IPv6 ULA 内的地址',
        })
      }
    }
  } else if (expandIPv6(hostname)) {
    if (isPrivateAddress(hostname)) {
      if (!allowPrivate) {
        throw new EabError(EC.VALIDATION, '不允许访问内网、本机或保留地址', { hint: '提供公网可访问的链接' })
      }
      if (wildcardPrivate && !isInternalNetworkAddress(hostname)) {
        throw new EabError(EC.VALIDATION, '内网访问仅放行企业局域网，本机、链路本地和保留地址仍被拒绝', {
          hint: '使用 RFC1918 / CGNAT / IPv6 ULA 内的地址',
        })
      }
    }
    family = 6
  } else {
    let records: Array<{ address: string; family: number }>
    try {
      records = await lookup(hostname, { all: true, verbatim: true })
    } catch (err) {
      throw new EabError(EC.UPSTREAM, `域名解析失败：${hostname}`, {
        hint: '检查链接拼写或稍后重试',
        cause: err,
      })
    }
    const usable = records
      .filter((record) => record.family === 4 || record.family === 6)
      .sort((left, right) => left.family - right.family)
    if (usable.length === 0) {
      throw new EabError(EC.UPSTREAM, `域名没有可用地址：${hostname}`)
    }
    const privateRecords = usable.filter((record) => isPrivateAddress(record.address))
    if (!allowPrivate && privateRecords.length > 0) {
      throw new EabError(EC.VALIDATION, '域名解析到了内网或保留地址，已拒绝访问', {
        hint: '提供公网域名；如果确实是内网站点，让管理员把域名加入内置浏览器内网白名单，或填 * 放行全部局域网目标',
      })
    }
    if (wildcardPrivate && privateRecords.some((record) => !isInternalNetworkAddress(record.address))) {
      throw new EabError(EC.VALIDATION, '域名解析到了本机、链路本地或保留地址，已拒绝访问', {
        hint: '内网访问只放行 RFC1918 / CGNAT / IPv6 ULA 地址',
      })
    }
    address = usable[0].address
    family = usable[0].family === 6 ? 6 : 4
  }

  return { url, address, family }
}

function pinnedLookup(address: string, family: 4 | 6): NonNullable<RequestOptions['lookup']> {
  return ((_hostname: string, options: { all?: boolean } | undefined, callback: (...args: unknown[]) => void) => {
    if (options?.all) callback(null, [{ address, family }])
    else callback(null, address, family)
  }) as NonNullable<RequestOptions['lookup']>
}

function decodeBody(body: Buffer, encoding: string): Buffer {
  const value = encoding.trim().toLowerCase()
  if (!value || value === 'identity') return body
  try {
    if (value === 'gzip' || value === 'x-gzip') return gunzipSync(body)
    if (value === 'deflate') return inflateSync(body)
    if (value === 'br') return brotliDecompressSync(body)
  } catch (err) {
    throw new EabError(EC.UPSTREAM, '网页压缩内容无法解压', { cause: err })
  }
  throw new EabError(EC.UPSTREAM, `不支持的压缩格式：${value}`)
}

function requestHeaders(options: SafeFetchOptions): Record<string, string> {
  return {
    'user-agent': USER_AGENT,
    accept: 'text/html,application/xhtml+xml,application/json,application/xml,text/plain;q=0.9,*/*;q=0.5',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.5',
    'accept-encoding': 'gzip, deflate, br',
    ...(options.headers ?? {}),
  }
}

function consumeResponse(
  response: IncomingMessage,
  finish: (fn: () => void) => void,
  resolve: (value: RawResponse) => void,
  reject: (reason: EabError) => void,
  maxBytes: number,
): void {
  const status = Number(response.statusCode ?? 0)
  const headers = response.headers
  const location = typeof headers.location === 'string' ? headers.location : null

  if (status >= 300 && status < 400) {
    response.resume()
    finish(() => resolve({ status, headers, body: Buffer.alloc(0), location }))
    return
  }

  const contentLength = Number(headers['content-length'] ?? 0)
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    response.destroy()
    finish(() =>
      reject(
        new EabError(EC.UPSTREAM, `网页内容超过 ${Math.round(maxBytes / 1024 / 1024)}MB 限制`, {
          hint: '换一个更小的页面，或先用搜索摘要',
        }),
      ),
    )
    return
  }

  const chunks: Buffer[] = []
  let received = 0
  response.on('data', (chunk: Buffer) => {
    received += chunk.length
    if (received > maxBytes) {
      response.destroy()
      finish(() =>
        reject(
          new EabError(EC.UPSTREAM, `网页内容超过 ${Math.round(maxBytes / 1024 / 1024)}MB 限制`, {
            hint: '换一个更小的页面，或先用搜索摘要',
          }),
        ),
      )
      return
    }
    chunks.push(chunk)
  })
  response.on('end', () => {
    let body: Buffer = Buffer.concat(chunks)
    try {
      body = decodeBody(body, String(headers['content-encoding'] ?? ''))
    } catch (err) {
      finish(() => reject(err as EabError))
      return
    }
    if (body.length > maxBytes) {
      finish(() =>
        reject(
          new EabError(EC.UPSTREAM, `网页解压后超过 ${Math.round(maxBytes / 1024 / 1024)}MB 限制`, {
            hint: '换一个更小的页面，或先用搜索摘要',
          }),
        ),
      )
      return
    }
    finish(() => resolve({ status, headers, body, location: null }))
  })
  response.on('error', (err) =>
    finish(() => reject(new EabError(EC.UPSTREAM, '读取网页内容失败', { cause: err }))),
  )
}

function requestOnce(
  target: ResolvedTarget,
  options: SafeFetchOptions,
  timeoutMs: number,
  maxBytes: number,
  env: NodeJS.ProcessEnv,
): Promise<RawResponse> {
  const proxy = proxyForUrl(target.url, env)
  if (proxy) return proxyRequestOnce(target, proxy, options, timeoutMs, maxBytes)

  return new Promise<RawResponse>((resolve, reject) => {
    const isHttps = target.url.protocol === 'https:'
    const headers = { ...requestHeaders(options), connection: 'close' }
    const requestOptions: RequestOptions = {
      hostname: target.url.hostname,
      port: target.url.port ? Number(target.url.port) : isHttps ? 443 : 80,
      path: `${target.url.pathname}${target.url.search}`,
      method: options.method ?? 'GET',
      headers,
      lookup: pinnedLookup(target.address, target.family),
      agent: false,
      ...(isHttps ? { servername: target.url.hostname } : {}),
    }

    let settled = false
    let timer: NodeJS.Timeout | undefined
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      fn()
    }

    const request = (isHttps ? httpsRequest : httpRequest)(requestOptions, (response) =>
      consumeResponse(response, finish, resolve, reject, maxBytes),
    )

    request.on('error', (err) => finish(() => reject(new EabError(EC.UPSTREAM, '访问网页失败', { cause: err }))))
    timer = setTimeout(() => {
      request.destroy(new Error('timeout'))
      finish(() =>
        reject(
          new EabError(EC.UPSTREAM, `访问网页超时（${Math.round(timeoutMs / 1000)} 秒）`, {
            hint: '稍后重试，或换一个更快的来源',
          }),
        ),
      )
    }, timeoutMs)

    if (options.signal) {
      options.signal.addEventListener(
        'abort',
        () => {
          request.destroy(new Error('aborted'))
          finish(() => reject(new EabError(EC.UPSTREAM, '网页请求已取消')))
        },
        { once: true },
      )
    }

    request.end(options.body)
  })
}

/**
 * 通过管理员配置的 HTTP 代理访问网页。
 *
 * - 目标是 HTTP：向代理发送 absolute-form 请求；
 * - 目标是 HTTPS：先 CONNECT 建隧道，再由本地做 TLS 握手，代理看不到明文；
 * - 目标域名已在 `resolveTarget` 中校验，代理只负责连接；
 * - `NO_PROXY` 命中的目标不会进入这里。
 */
function proxyRequestOnce(
  target: ResolvedTarget,
  proxy: URL,
  options: SafeFetchOptions,
  timeoutMs: number,
  maxBytes: number,
): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const targetPort = target.url.port ? Number(target.url.port) : target.url.protocol === 'https:' ? 443 : 80
    const headers = { ...requestHeaders(options), connection: 'close' }
    const proxyIsHttps = proxy.protocol === 'https:'
    const proxyOptions: RequestOptions = {
      hostname: proxy.hostname,
      port: proxyPort(proxy),
      method: 'CONNECT',
      path: `${target.url.hostname}:${targetPort}`,
      headers: {
        host: `${target.url.hostname}:${targetPort}`,
        'proxy-connection': 'close',
        ...proxyAuthorization(proxy),
      },
      agent: false,
      ...(proxyIsHttps ? { servername: proxy.hostname } : {}),
    }

    let settled = false
    let timer: NodeJS.Timeout | undefined
    let active: ClientRequest | null = null
    let tunnelSocket: ReturnType<typeof tlsConnect> | null = null
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      fn()
    }
    const fail = (message: string, cause?: unknown): void => {
      finish(() => reject(new EabError(EC.UPSTREAM, message, cause ? { cause } : undefined)))
    }
    const attachRequest = (request: ClientRequest): void => {
      active = request
      request.on('response', (response) => consumeResponse(response, finish, resolve, reject, maxBytes))
      request.on('error', (err) => fail('通过代理访问网页失败', err))
    }
    const armTimeout = (): void => {
      timer = setTimeout(() => {
        tunnelSocket?.destroy()
        active?.destroy(new Error('timeout'))
        fail(`访问网页超时（${Math.round(timeoutMs / 1000)} 秒）`)
      }, timeoutMs)
    }

    if (target.url.protocol === 'http:') {
      const request = (proxyIsHttps ? httpsRequest : httpRequest)({
        ...proxyOptions,
        method: options.method ?? 'GET',
        path: target.url.href,
        headers: {
          ...headers,
          host: target.url.host,
          ...proxyAuthorization(proxy),
        },
      })
      attachRequest(request)
      armTimeout()
      request.end(options.body)
      return
    }

    const connectRequest = (proxyIsHttps ? httpsRequest : httpRequest)(proxyOptions)
    active = connectRequest
    connectRequest.on('connect', (response, rawSocket) => {
      if (Number(response.statusCode ?? 0) !== 200) {
        rawSocket.destroy()
        fail(`代理拒绝建立隧道（HTTP ${response.statusCode ?? 0}）`)
        return
      }
      const servername = isIP(target.url.hostname) ? undefined : target.url.hostname
      const socket = tlsConnect({ socket: rawSocket, servername })
      tunnelSocket = socket
      socket.once('error', (err) => fail('代理隧道 TLS 握手失败', err))
      socket.once('secureConnect', () => {
        if (settled) {
          socket.destroy()
          return
        }
        const request = httpRequest({
          hostname: target.url.hostname,
          port: targetPort,
          path: `${target.url.pathname}${target.url.search}`,
          method: options.method ?? 'GET',
          headers: { ...headers, host: target.url.host },
          createConnection: () => socket,
        })
        attachRequest(request)
        request.end(options.body)
      })
    })
    connectRequest.on('error', (err) => fail('连接代理失败', err))
    armTimeout()
    connectRequest.end()

    if (options.signal) {
      options.signal.addEventListener(
        'abort',
        () => {
          active?.destroy(new Error('aborted'))
          connectRequest.destroy(new Error('aborted'))
          finish(() => reject(new EabError(EC.UPSTREAM, '网页请求已取消')))
        },
        { once: true },
      )
    }
  })
}

function normalizeContentType(headers: IncomingHttpHeaders): string {
  const value = headers['content-type']
  const raw = Array.isArray(value) ? value[0] : value
  return String(raw ?? '').split(';')[0].trim().toLowerCase()
}

/** 校验一个 URL 是否允许由服务端访问；浏览器导航和子资源也复用这套规则。 */
export async function assertPublicHttpUrl(
  rawUrl: string,
  options: SafeFetchOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<URL> {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new EabError(EC.VALIDATION, '链接格式不正确', { hint: '提供完整的 http/https 链接' })
  }
  parsed.hash = ''
  await resolveTarget(parsed, options, env)
  return parsed
}

/** 按安全策略抓取一个 URL，自动处理最多 5 次重定向。 */
export async function safeGet(
  rawUrl: string,
  options: SafeFetchOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<SafeFetchResponse> {
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const maxBytes = Math.max(64 * 1024, options.maxBytes ?? DEFAULT_MAX_BYTES)
  let current = rawUrl
  const visited = new Set<string>()

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let parsed: URL
    try {
      parsed = new URL(current)
    } catch {
      throw new EabError(EC.VALIDATION, '链接格式不正确', { hint: '提供完整的 http/https 链接' })
    }
    parsed.hash = ''
    const key = parsed.href
    if (visited.has(key)) {
      throw new EabError(EC.UPSTREAM, '网页重定向形成了循环', { hint: '换一个链接或直接访问最终页面' })
    }
    visited.add(key)

    const target = await resolveTarget(parsed, options, env)
    const response = await requestOnce(target, options, timeoutMs, maxBytes, env)

    if (response.status >= 300 && response.status < 400) {
      if (!response.location) {
        throw new EabError(EC.UPSTREAM, `网页返回 ${response.status}，但没有跳转地址`)
      }
      if (hop === MAX_REDIRECTS) {
        throw new EabError(EC.UPSTREAM, '网页重定向次数过多', { hint: '直接提供最终页面链接' })
      }
      current = new URL(response.location, parsed).href
      continue
    }

    return {
      status: response.status,
      headers: response.headers,
      body: response.body,
      finalUrl: parsed.href,
      contentType: normalizeContentType(response.headers),
    }
  }

  throw new EabError(EC.UPSTREAM, '网页重定向次数过多')
}

/**
 * 供管理员配置的搜索 provider 使用：不解析模型提供的任意地址，只请求固定配置的端点。
 * 仍禁止跟随重定向到其它主机，避免把 API Key 带到第三方。
 */
export async function fetchJson(
  url: string,
  init: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  const timeoutMs = Math.max(1_000, init.timeoutMs ?? 15_000)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const proxy = proxyForUrl(url, env)
    if (proxy) {
      const target: ResolvedTarget = { url: new URL(url), address: '', family: 4 }
      const maxBytes = 2 * 1024 * 1024
      const response = await proxyRequestOnce(
        target,
        proxy,
        {
          method: init.method ?? 'GET',
          headers: init.headers,
          body: init.body,
          signal: controller.signal,
        },
        timeoutMs,
        maxBytes,
      )
      if (response.status < 200 || response.status >= 300) {
        throw new EabError(EC.UPSTREAM, `搜索服务返回 HTTP ${response.status}`, {
          hint: '检查搜索服务地址和密钥，或稍后重试',
        })
      }
      try {
        return JSON.parse(response.body.toString('utf8'))
      } catch {
        throw new EabError(EC.UPSTREAM, '搜索服务返回了无法解析的数据')
      }
    }

    const response = await fetch(url, {
      method: init.method ?? 'GET',
      headers: init.headers,
      body: init.body,
      redirect: 'error',
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new EabError(EC.UPSTREAM, `搜索服务返回 HTTP ${response.status}`, {
        hint: '检查搜索服务地址和密钥，或稍后重试',
      })
    }
    try {
      return await response.json()
    } catch {
      throw new EabError(EC.UPSTREAM, '搜索服务返回了无法解析的数据')
    }
  } catch (err) {
    if (err instanceof EabError) throw err
    if (controller.signal.aborted) {
      throw new EabError(EC.UPSTREAM, `搜索服务超时（${Math.round(timeoutMs / 1000)} 秒）`, {
        hint: '稍后重试或检查搜索服务',
      })
    }
    throw new EabError(EC.UPSTREAM, '搜索服务请求失败', { cause: err })
  } finally {
    clearTimeout(timer)
  }
}
