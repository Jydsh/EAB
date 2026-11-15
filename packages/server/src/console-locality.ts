/**
 * 判断控制台请求是否来自“服务器本机”，用于决定目录选择器走原生系统框还是
 * Web 服务器目录浏览。这里只影响交互方式，不参与权限判定。
 */
import { networkInterfaces } from 'node:os'

/** 去掉 IPv6 的 zone、IPv4-mapped 前缀，并统一小写。 */
export function normalizeAddress(value: unknown): string {
  let address = String(value ?? '').trim()
  if (!address) return ''
  const zone = address.indexOf('%')
  if (zone >= 0) address = address.slice(0, zone)
  if (address.startsWith('::ffff:')) address = address.slice(7)
  return address.toLowerCase()
}

/** 服务器当前所有网卡地址（含 IPv6），用于识别“本机通过自己的 LAN IP 访问”。 */
export function serverAddresses(): string[] {
  const found = new Set<string>()
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list ?? []) {
      if (!item.address) continue
      found.add(normalizeAddress(item.address))
    }
  }
  return [...found].filter(Boolean)
}

/** 回环地址或服务器自己的某个网卡地址，才视为本机。 */
export function isLocalAddress(value: unknown, locals: string[] = serverAddresses()): boolean {
  const address = normalizeAddress(value)
  if (!address) return false
  if (address === '::1' || address === '127.0.0.1' || address.startsWith('127.')) return true
  return locals.map(normalizeAddress).includes(address)
}

/**
 * 请求来源判断。存在 X-Forwarded-For 时，如果第一跳不是本机地址，按远程处理，
 * 避免远程代理把自己的请求伪装成本机、却弹出服务器桌面上的原生框。
 */
export function requestIsLocal(
  remoteAddress: unknown,
  forwardedFor: unknown = '',
  locals: string[] = serverAddresses(),
): boolean {
  const remote = normalizeAddress(remoteAddress)
  if (!isLocalAddress(remote, locals)) return false
  const forwarded = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor
  const first = String(forwarded ?? '').split(',')[0]?.trim() ?? ''
  if (first && !isLocalAddress(first, locals)) return false
  return true
}

/** 当前服务进程是否处在可显示 Windows 原生窗口的交互式会话。 */
export function hasInteractiveWindowsDesktop(
  platform: NodeJS.Platform = process.platform,
  sessionName: string | undefined = process.env.SESSIONNAME,
): boolean {
  if (platform !== 'win32') return false
  const session = String(sessionName ?? '').trim()
  return Boolean(session) && !/^services$/i.test(session)
}
