import { describe, expect, it } from 'vitest'
import { buildSecurityHeaders, requestIsSecure } from '../src/security-headers.js'

describe('安全响应头', () => {
  it('页面响应带 CSP、防套壳、nosniff 与来源策略', () => {
    const headers = buildSecurityHeaders({ secure: false })
    expect(headers['content-security-policy']).toContain("default-src 'self'")
    expect(headers['content-security-policy']).toContain("frame-ancestors 'self'")
    expect(headers['content-security-policy']).toContain("object-src 'none'")
    expect(headers['x-frame-options']).toBe('SAMEORIGIN')
    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(headers['referrer-policy']).toBe('same-origin')
    // 明文访问时不能下发 HSTS，否则本地调试会被浏览器锁死。
    expect(headers['strict-transport-security']).toBeUndefined()
  })

  it('HTTPS 访问才下发 HSTS', () => {
    expect(buildSecurityHeaders({ secure: true })['strict-transport-security']).toContain('max-age=')
  })

  it('保留钉钉登录脚本域名与营销/预览需要的内联脚本', () => {
    const csp = buildSecurityHeaders({ secure: false })['content-security-policy']
    expect(csp).toContain('https://g.alicdn.com')
    expect(csp).toContain("'unsafe-inline'")
  })

  it('从请求头/协议判断 HTTPS（反代声明也算）', () => {
    expect(requestIsSecure({}, 'https')).toBe(true)
    expect(requestIsSecure({ 'x-forwarded-proto': 'https' }, 'http')).toBe(true)
    expect(requestIsSecure({ 'x-forwarded-proto': 'http, https' }, 'http')).toBe(false)
    expect(requestIsSecure({}, 'http')).toBe(false)
  })
})
