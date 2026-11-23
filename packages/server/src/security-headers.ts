/**
 * 统一的安全响应头。
 *
 * 现状问题：整个服务以前只回 `x-eab-version`，没有 CSP / X-Frame-Options / HSTS，
 * 控制台和员工页都可能被第三方站点 iframe 套壳（点击劫持），也没有任何注入缓解。
 *
 * 取舍：页面里大量使用内联 `<script>`，钉钉登录还要从 `g.alicdn.com` 拉 ddlogin.js，
 * 所以脚本策略必须保留 `'unsafe-inline'` 和这一个白名单域名；OnlyOffice 编辑器
 * 是同机/异机独立部署的文档服务器，只能放行 http/https 的 frame 源。
 * 这不是最严的 CSP，但能挡住外部脚本注入、把 frame 限制在已知来源，并保留全部现有功能。
 */

export interface SecurityHeaderInput {
  /** 请求是否走 HTTPS（含反代声明的 x-forwarded-proto） */
  readonly secure: boolean
}

/** 钉钉网页登录脚本的唯一外部域名。 */
const DINGTALK_LOGIN_ORIGIN = 'https://g.alicdn.com'

export function buildSecurityHeaders(input: SecurityHeaderInput): Record<string, string> {
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' ${DINGTALK_LOGIN_ORIGIN}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "worker-src 'self' blob:",
    "frame-src 'self' http: https:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; ')

  const headers: Record<string, string> = {
    'content-security-policy': csp,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'SAMEORIGIN',
    'referrer-policy': 'same-origin',
    'permissions-policy': 'geolocation=(self), microphone=(self), camera=()',
  }
  // HSTS 只在确实走 HTTPS 时下发：明文访问时下发会把后续本地调试直接锁死。
  if (input.secure) headers['strict-transport-security'] = 'max-age=31536000; includeSubDomains'
  return headers
}

/** 从请求头判断这次访问是不是 HTTPS（直连或反代终止 TLS）。 */
export function requestIsSecure(headers: Record<string, unknown>, protocol?: string): boolean {
  if (String(protocol || '').toLowerCase() === 'https') return true
  const forwarded = headers['x-forwarded-proto']
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded
  return String(raw || '').split(',')[0]?.trim().toLowerCase() === 'https'
}
