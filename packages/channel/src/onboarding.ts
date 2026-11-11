/**
 * 渠道统一开通的 provider 适配。
 *
 * 只依赖各渠道公开接口；插件（dsh-im）只作为飞书扫码的可选承载，不把凭据写到插件里。
 */
import QRCode from 'qrcode'

export type OnboardingProvider = 'feishu' | 'wecom'

export interface ProviderScanStart {
  readonly provider: OnboardingProvider
  readonly remoteId: string
  readonly qrContent: string
  readonly qrDataUrl: string
  readonly expiresAt: number
  readonly pollIntervalMs: number
  readonly meta: Record<string, unknown>
}

export interface ProviderScanPoll {
  readonly status: 'waiting' | 'success' | 'expired' | 'failed'
  readonly message?: string
  readonly tenantId?: string
  readonly tenantName?: string
  readonly appId?: string
  readonly appSecret?: string
  readonly botId?: string
  readonly botSecret?: string
  readonly domain?: 'feishu' | 'lark'
  readonly pollIntervalMs?: number
}

interface WecomGenerateResponse {
  data?: {
    scode?: unknown
    auth_url?: unknown
  }
}

interface WecomQueryResponse {
  data?: {
    status?: unknown
    bot_info?: {
      botid?: unknown
      secret?: unknown
      name?: unknown
    }
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function assertWecomAuthUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('企业微信返回了无效的扫码地址')
  }
  if (url.protocol !== 'https:' || url.hostname !== 'work.weixin.qq.com') {
    throw new Error('企业微信返回了不受信任的扫码地址')
  }
  return value
}

/** 企业微信扫码：平台只返回 botid + secret，不返回 corpid。 */
export async function startWecomScan(): Promise<ProviderScanStart> {
  const response = await fetch(
    'https://work.weixin.qq.com/ai/qc/generate?source=eab&plat=1',
    { headers: { accept: 'application/json' } },
  )
  if (!response.ok) throw new Error(`企业微信扫码接口 HTTP ${response.status}`)
  const body = (await response.json()) as WecomGenerateResponse
  const scode = text(body.data?.scode)
  const authUrl = text(body.data?.auth_url)
  if (!scode || !authUrl) throw new Error('企业微信没有返回扫码凭证')
  const safeUrl = assertWecomAuthUrl(authUrl)
  const qrDataUrl = await QRCode.toDataURL(safeUrl, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 320,
    type: 'image/png',
  })
  return {
    provider: 'wecom',
    remoteId: scode,
    qrContent: safeUrl,
    qrDataUrl,
    expiresAt: Date.now() + 5 * 60_000,
    pollIntervalMs: 3_000,
    meta: { source: 'eab', platform: 1 },
  }
}

export async function pollWecomScan(scode: string): Promise<ProviderScanPoll> {
  const response = await fetch(
    `https://work.weixin.qq.com/ai/qc/query_result?scode=${encodeURIComponent(scode)}`,
    { headers: { accept: 'application/json' } },
  )
  if (!response.ok) throw new Error(`企业微信扫码轮询 HTTP ${response.status}`)
  const body = (await response.json()) as WecomQueryResponse
  const status = text(body.data?.status).toLowerCase()
  if (status === 'success') {
    const botId = text(body.data?.bot_info?.botid)
    const botSecret = text(body.data?.bot_info?.secret)
    if (!botId || !botSecret) return { status: 'failed', message: '企业微信没有返回机器人凭据' }
    return {
      status: 'success',
      tenantId: botId,
      tenantName: text(body.data?.bot_info?.name) || '企业微信机器人',
      botId,
      botSecret,
    }
  }
  if (status === 'expired' || status === 'timeout') {
    return { status: 'expired', message: '二维码已过期，请重新生成' }
  }
  if (status === 'fail' || status === 'failed' || status === 'error') {
    return { status: 'failed', message: '企业微信扫码授权失败' }
  }
  return { status: 'waiting' }
}

interface FeishuTokenResponse {
  code?: number
  msg?: string
  tenant_access_token?: string
}

interface FeishuBotResponse {
  code?: number
  msg?: string
  bot?: {
    app_name?: string
    bot_name?: string
    open_id?: string
    activate_status?: number
  }
}

interface FeishuRegistrationResponse {
  device_code?: unknown
  verification_uri_complete?: unknown
  expires_in?: unknown
  interval?: unknown
  client_id?: unknown
  client_secret?: unknown
  user_info?: { tenant_brand?: unknown }
  error?: unknown
  error_description?: unknown
}

const FEISHU_ACCOUNTS = {
  feishu: 'https://accounts.feishu.cn',
  lark: 'https://accounts.larksuite.com',
} as const

async function feishuRegistration(
  base: string,
  params: Record<string, string>,
): Promise<FeishuRegistrationResponse> {
  const response = await fetch(`${base}/oauth/v1/app/registration`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(15_000),
  })
  const body = (await response.json().catch(() => null)) as FeishuRegistrationResponse | null
  if (!body || typeof body !== 'object') {
    throw new Error(`飞书扫码接口返回无效响应 HTTP ${response.status}`)
  }
  if (!response.ok && !body.error) {
    throw new Error(`飞书扫码接口 HTTP ${response.status}`)
  }
  return body
}

/**
 * 飞书扫码（EAB 原生，不依赖 dsh-im）：直接走飞书开放平台的设备注册流程。
 * 平台会创建/绑定一个飞书应用，成功后返回 client_id + client_secret。
 */
export async function startFeishuScanNative(
  domain: 'feishu' | 'lark' = 'feishu',
): Promise<ProviderScanStart & { domain: 'feishu' | 'lark' }> {
  const base = FEISHU_ACCOUNTS[domain]
  const body = await feishuRegistration(base, {
    action: 'begin',
    archetype: 'PersonalAgent',
    auth_method: 'client_secret',
    request_user_info: 'open_id',
  })
  const deviceCode = text(body.device_code)
  const verification = text(body.verification_uri_complete)
  if (!deviceCode || !verification) {
    throw new Error('飞书没有返回扫码凭证')
  }
  let qrContent: URL
  try {
    qrContent = new URL(verification)
  } catch {
    throw new Error('飞书返回了无效的扫码地址')
  }
  if (qrContent.protocol !== 'https:') throw new Error('飞书返回了不安全的扫码地址')
  qrContent.searchParams.set('from', 'sdk')
  qrContent.searchParams.set('source', 'node-sdk')
  qrContent.searchParams.set('tp', 'sdk')
  const expiresIn = Number(body.expires_in ?? 600)
  const interval = Number(body.interval ?? 5)
  const expiresAt = Date.now() + Math.max(60, expiresIn) * 1000
  const pollIntervalMs = Math.min(10_000, Math.max(1_500, (interval || 5) * 1000))
  const qrDataUrl = await QRCode.toDataURL(qrContent.toString(), {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 360,
    type: 'image/png',
  })
  return {
    provider: 'feishu',
    remoteId: deviceCode,
    qrContent: qrContent.toString(),
    qrDataUrl,
    expiresAt,
    pollIntervalMs,
    meta: { kind: 'feishu-native', domain },
    domain,
  }
}

/** 轮询飞书原生扫码结果。`domain` 可能在 Lark 租户扫码后切换。 */
export async function pollFeishuScanNative(
  deviceCode: string,
  domain: 'feishu' | 'lark' = 'feishu',
): Promise<ProviderScanPoll> {
  const body = await feishuRegistration(FEISHU_ACCOUNTS[domain], {
    action: 'poll',
    device_code: deviceCode,
  })
  const appId = text(body.client_id)
  const appSecret = text(body.client_secret)
  if (appId && appSecret) {
    const brand = text(body.user_info?.tenant_brand).toLowerCase()
    return {
      status: 'success',
      appId,
      appSecret,
      tenantId: appId,
      tenantName: '飞书机器人',
      domain: brand === 'lark' ? 'lark' : domain,
    }
  }
  const brand = text(body.user_info?.tenant_brand).toLowerCase()
  if (brand === 'lark' && domain !== 'lark') {
    return { status: 'waiting', domain: 'lark', message: '检测到 Lark 租户，已切换国际版' }
  }
  const error = text(body.error)
  if (!error || error === 'authorization_pending') return { status: 'waiting' }
  if (error === 'slow_down') {
    return { status: 'waiting', pollIntervalMs: 8_000, message: '平台要求降低轮询频率' }
  }
  if (error === 'access_denied') {
    return { status: 'failed', message: text(body.error_description) || '扫码授权被拒绝' }
  }
  if (error === 'expired_token') {
    return { status: 'expired', message: '二维码已过期，请重新生成' }
  }
  return { status: 'failed', message: text(body.error_description) || `飞书扫码失败：${error}` }
}

/** 飞书手工凭据校验：换 tenant_access_token 后读 bot info。 */export async function verifyFeishuApp(
  appId: string,
  appSecret: string,
  domain: 'feishu' | 'lark' = 'feishu',
): Promise<{ appName: string; openId: string; activateStatus: number; tenantName: string }> {
  const origin = domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'
  const tokenResponse = await fetch(`${origin}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  })
  const tokenBody = (await tokenResponse.json()) as FeishuTokenResponse
  if (!tokenResponse.ok || tokenBody.code !== 0 || !tokenBody.tenant_access_token) {
    throw new Error(tokenBody.msg || `飞书凭证校验失败 HTTP ${tokenResponse.status}`)
  }
  const botResponse = await fetch(`${origin}/open-apis/bot/v3/info/`, {
    headers: { authorization: `Bearer ${tokenBody.tenant_access_token}` },
  })
  const botBody = (await botResponse.json()) as FeishuBotResponse
  if (!botResponse.ok || botBody.code !== 0 || !botBody.bot) {
    throw new Error(botBody.msg || `飞书机器人信息读取失败 HTTP ${botResponse.status}`)
  }
  const bot = botBody.bot
  return {
    appName: text(bot.app_name) || text(bot.bot_name) || '飞书机器人',
    openId: text(bot.open_id),
    activateStatus: Number(bot.activate_status ?? 0),
    tenantName: text(bot.app_name) || text(bot.bot_name) || '飞书企业',
  }
}
