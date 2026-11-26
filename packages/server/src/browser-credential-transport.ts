/**
 * 站点凭据传输边界。
 *
 * 本机开发允许 `http://127.0.0.1` 直接保存站点账号；一旦请求来自其他机器，
 * 必须满足以下之一：
 * - 连接本身是 TLS；
 * - 同机反向代理转发，且声明 `x-forwarded-proto: https`；
 * - 来源 IP 在 `EAB_CREDENTIAL_PROXY_HOSTS` 白名单内，且声明 HTTPS。
 *
 * 这样既保留本机 8787/8788 的调试便利，也不把密码放在远程 HTTP 明文里。
 */

function normalizeAddress(raw: string | undefined | null): string {
  return String(raw ?? '')
    .trim()
    .replace(/^::ffff:/i, '')
    .replace(/%.*$/, '')
}

export function isLoopbackAddress(raw: string | undefined | null): boolean {
  const address = normalizeAddress(raw)
  if (!address) return false
  return address === '::1' || address === '127.0.0.1' || address.startsWith('127.')
}

function firstHeader(headers: Record<string, unknown>, name: string): string {
  const raw = headers[name]
  const value = Array.isArray(raw) ? raw[0] : raw
  return String(value ?? '')
    .split(',')[0]
    ?.trim()
    .toLowerCase() ?? ''
}

export interface CredentialTransportInput {
  peerAddress?: string | null
  /** 直连 TLS 时 Node 会给出 encrypted=true。 */
  encrypted?: boolean
  headers: Record<string, unknown>
  trustedProxyHosts?: readonly string[]
}

export function allowCredentialTransport(input: CredentialTransportInput): boolean {
  if (input.encrypted) return true
  const peer = normalizeAddress(input.peerAddress)
  const forwardedFor = firstHeader(input.headers, 'x-forwarded-for')
  const forwardedProto = firstHeader(input.headers, 'x-forwarded-proto')
  if (isLoopbackAddress(peer) && !forwardedFor) return true
  if (forwardedProto !== 'https') return false
  if (isLoopbackAddress(peer)) return true
  const trusted = (input.trustedProxyHosts ?? []).map((item) => normalizeAddress(item)).filter(Boolean)
  return trusted.includes(peer)
}

export function trustedCredentialProxyHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  return String(env.EAB_CREDENTIAL_PROXY_HOSTS ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}
