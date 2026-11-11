import { afterEach, describe, expect, it, vi } from 'vitest'
import { pollFeishuScanNative, startFeishuScanNative } from '../src/onboarding.js'

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('飞书原生扫码（不依赖插件）', () => {
  it('begin 走 accounts.feishu.cn，二维码带 SDK 参数', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://accounts.feishu.cn/oauth/v1/app/registration')
      const params = new URLSearchParams(String(init?.body ?? ''))
      expect(params.get('action')).toBe('begin')
      expect(params.get('archetype')).toBe('PersonalAgent')
      return json({
        device_code: 'dc_1',
        verification_uri_complete: 'https://open.feishu.cn/page/launcher?user_code=AB12',
        expires_in: 600,
        interval: 5,
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const started = await startFeishuScanNative()
    expect(started.remoteId).toBe('dc_1')
    expect(started.qrContent).toContain('from=sdk')
    expect(started.qrContent).toContain('source=node-sdk')
    expect(started.qrDataUrl.startsWith('data:image/png')).toBe(true)
    expect(started.pollIntervalMs).toBe(5000)
  })

  it('poll 成功返回应用凭据，并识别 Lark 租户', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      expect(String(url)).toBe('https://accounts.feishu.cn/oauth/v1/app/registration')
      return json({ client_id: 'cli_new', client_secret: 'secret_new', user_info: { tenant_brand: 'lark' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    const polled = await pollFeishuScanNative('dc_1')
    expect(polled.status).toBe('success')
    expect(polled.appId).toBe('cli_new')
    expect(polled.appSecret).toBe('secret_new')
    expect(polled.domain).toBe('lark')
  })

  it('poll 等待时返回 waiting', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'authorization_pending' })))
    expect((await pollFeishuScanNative('dc_1')).status).toBe('waiting')
  })
})
