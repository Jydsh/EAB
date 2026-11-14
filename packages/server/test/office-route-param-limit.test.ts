import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { MAX_ROUTE_PARAM_LENGTH } from '../src/app.js'
import { signOfficeJwt } from '../src/onlyoffice.js'

const secret = 'test-onlyoffice-secret-0123456789abcdef'

describe('OnlyOffice 长令牌路由', () => {
  it('路径中的签名令牌超过 Fastify 默认 100 时仍能进入路由', async () => {
    const now = Math.floor(Date.now() / 1000)
    const token = signOfficeJwt(
      {
        kind: 'content',
        fileId: '01M7986WK6TA10XJBZZ08JQ2QX',
        companyId: 'c1',
        userId: 'u_dingtalk_021724185801860353',
        mode: 'view',
        version: 100,
        iat: now,
        exp: now + 300,
      },
      secret,
    )

    // Fastify/find-my-way 默认 maxParamLength=100；OnlyOffice 真实令牌会超过它。
    expect(token.length).toBeGreaterThan(100)
    expect(MAX_ROUTE_PARAM_LENGTH).toBeGreaterThanOrEqual(token.length)

    const app = Fastify({ routerOptions: { maxParamLength: MAX_ROUTE_PARAM_LENGTH } })
    app.get('/api/workspace/office/:id/content/:token', async () => ({ ok: true }))
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/workspace/office/01M7986WK6TA10XJBZZ08JQ2QX/content/${token}`,
      })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ ok: true })
    } finally {
      await app.close()
    }
  })
})
