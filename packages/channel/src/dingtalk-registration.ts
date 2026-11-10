/**
 * 钉钉「扫码建机器人」设备码流程。
 *
 * 这不是公开的 OAuth 扫码登录，而是钉钉给桌面客户端/CLI 的机器人注册流程：
 *   init  -> nonce
 *   begin -> device_code + 用户扫码地址（钉钉官方机器人注册落地页）
 *   poll  -> WAITING / SUCCESS；SUCCESS 直接返回 client_id、client_secret、corp_id、
 *            agent_id、robot_code、unified_app_id、user_id
 *
 * 落地页由钉钉官方渲染，文案明确写着「连接后，自动完成所有权限配置」；
 * 因此 EAB 不再让自己人一个权限一个权限去点开通。
 */

const BASE = 'https://oapi.dingtalk.com'
const SOURCE = 'DING_DWS_CLAW'

export interface DingTalkRegistrationStart {
  nonce: string
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresIn: number
  interval: number
}

export interface DingTalkRegistrationResult {
  status: 'WAITING' | 'SUCCESS' | 'FAIL' | 'EXPIRED'
  clientId?: string
  clientSecret?: string
  corpId?: string
  agentId?: string
  robotCode?: string
  unifiedAppId?: string
  userId?: string
  mode?: string
  message?: string
}

async function postJson(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`钉钉扫码注册接口 HTTP ${response.status}：${text.slice(0, 300)}`)
  }
  let data: Record<string, unknown>
  try {
    data = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error(`钉钉扫码注册接口返回非 JSON：${text.slice(0, 300)}`)
  }
  if (typeof data.errcode === 'number' && data.errcode !== 0) {
    throw new Error(`钉钉扫码注册失败（${data.errcode}）：${String(data.errmsg ?? '未知错误')}`)
  }
  return data
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export async function startDingTalkRegistration(): Promise<DingTalkRegistrationStart> {
  const init = await postJson('/app/registration/init', { source: SOURCE })
  const nonce = str(init.nonce)
  if (!nonce) throw new Error('钉钉扫码注册没有返回 nonce')

  const begin = await postJson('/app/registration/begin', { nonce })
  const deviceCode = str(begin.device_code)
  const userCode = str(begin.user_code)
  const verificationUriComplete = str(begin.verification_uri_complete)
  if (!deviceCode || !verificationUriComplete) {
    throw new Error('钉钉扫码注册没有返回 device_code 或扫码地址')
  }
  const expiresIn = Number(begin.expires_in ?? 7200)
  const interval = Number(begin.interval ?? 2)
  return {
    nonce,
    deviceCode,
    userCode,
    verificationUri: str(begin.verification_uri),
    verificationUriComplete,
    expiresIn: Number.isFinite(expiresIn) ? expiresIn : 7200,
    interval: Number.isFinite(interval) ? Math.max(1, interval) : 2,
  }
}

export async function pollDingTalkRegistration(deviceCode: string): Promise<DingTalkRegistrationResult> {
  const data = await postJson('/app/registration/poll', { device_code: deviceCode })
  const rawStatus = str(data.status).toUpperCase()
  const status: DingTalkRegistrationResult['status'] =
    rawStatus === 'SUCCESS' ? 'SUCCESS' : rawStatus === 'FAIL' ? 'FAIL' : rawStatus === 'EXPIRED' ? 'EXPIRED' : 'WAITING'
  if (status !== 'SUCCESS') {
    return { status, message: str(data.errmsg) || str(data.message) || undefined }
  }
  return {
    status,
    clientId: str(data.client_id),
    clientSecret: str(data.client_secret),
    corpId: str(data.corp_id),
    agentId: str(data.agent_id),
    robotCode: str(data.robot_code),
    unifiedAppId: str(data.unified_app_id),
    userId: str(data.user_id),
    mode: str(data.mode),
  }
}
