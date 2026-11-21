import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { normalizeDingTalkSessionWebhook, verifyDingTalkCallbackSignature } from '../src/dingtalk-bot.js'

function sign(timestamp: string, appSecret: string): string {
  return createHmac('sha256', appSecret).update(`${timestamp}\n${appSecret}`).digest('base64')
}

describe('钉钉 HTTP 回调验签', () => {
  const secret = 'test-app-secret'
  const now = Date.UTC(2026, 10, 21, 3, 30, 0)
  const timestamp = String(now)

  it('接受 1 小时内、签名正确的回调', () => {
    expect(
      verifyDingTalkCallbackSignature({
        timestamp,
        sign: sign(timestamp, secret),
        appSecret: secret,
        now,
      }),
    ).toBe(true)
  })

  it('拒绝超过 1 小时的时间戳', () => {
    expect(
      verifyDingTalkCallbackSignature({
        timestamp,
        sign: sign(timestamp, secret),
        appSecret: secret,
        now: now + 61 * 60 * 1000,
      }),
    ).toBe(false)
  })

  it('拒绝签名不匹配或缺失', () => {
    expect(
      verifyDingTalkCallbackSignature({
        timestamp,
        sign: sign(timestamp, 'wrong-secret'),
        appSecret: secret,
        now,
      }),
    ).toBe(false)
    expect(
      verifyDingTalkCallbackSignature({ timestamp, sign: '', appSecret: secret, now }),
    ).toBe(false)
  })
})

describe('sessionWebhook 白名单', () => {
  it('只放行钉钉开放平台 HTTPS 域名', () => {
    expect(normalizeDingTalkSessionWebhook('https://oapi.dingtalk.com/robot/send?access_token=x')).toBe(
      'https://oapi.dingtalk.com/robot/send?access_token=x',
    )
    expect(normalizeDingTalkSessionWebhook('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend')).toBe(
      'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend',
    )
  })

  it('拒绝 HTTP、非白名单域名、账号信息和非常规端口', () => {
    expect(() => normalizeDingTalkSessionWebhook('http://oapi.dingtalk.com/x')).toThrow(/HTTPS/)
    expect(() => normalizeDingTalkSessionWebhook('https://evil.example.com/x')).toThrow(/白名单/)
    expect(() => normalizeDingTalkSessionWebhook('https://user:pass@oapi.dingtalk.com/x')).toThrow(/账号信息/)
    expect(() => normalizeDingTalkSessionWebhook('https://oapi.dingtalk.com:8443/x')).toThrow(/443/)
    expect(() => normalizeDingTalkSessionWebhook('not a url')).toThrow(/合法 URL/)
  })
})
