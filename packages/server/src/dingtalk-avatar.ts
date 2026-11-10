/**
 * 员工头像：钉钉通讯录里本来就带 avatar，但组织同步只写姓名/手机号等字段，
 * users.avatar 一直空着。这里补三条取数路径：
 *
 * 1. 全量组织同步时由 channel 包把 avatar 一起写进 users（批量、无额外请求）；
 * 2. 已经同步过、但库里还没有头像的老成员，第一次打开工作台时按需补一次；
 * 3. 每次登录成功后再主动拉一次钉钉实时头像，钉钉换头像后网页能跟着更新。
 *
 * 钉钉用默认头像的员工不返回 avatar；这种“查过但没有”写空字符串做标记。
 * 接口失败时保留库里已有值，不把已抓到的地址清空。
 */
import type { Db } from '@eab/storage'
import { resolveSecret } from './secrets.js'

const DINGTALK_API = 'https://api.dingtalk.com'
const DINGTALK_OAPI = 'https://oapi.dingtalk.com'
/** 登录不能被钉钉接口无限拖住；超时后保留库里旧头像。 */
const AVATAR_FETCH_TIMEOUT_MS = 8_000

interface DingTalkChannelRow {
  app_id: string | null
  secret_ref: string | null
}

function channelConfig(
  db: Db,
  dbPath: string,
  companyId: string,
): { appId: string; appSecret: string } | null {
  const row = db
    .prepare(
      `SELECT app_id, secret_ref
         FROM channel_configs
        WHERE company_id = ? AND provider = 'dingtalk'
        LIMIT 1`,
    )
    .get(companyId) as DingTalkChannelRow | undefined
  if (!row?.app_id || !row.secret_ref) return null
  const appSecret = resolveSecret(dbPath, row.secret_ref)
  if (!appSecret) return null
  return { appId: row.app_id, appSecret }
}

async function appAccessToken(appId: string, appSecret: string): Promise<string> {
  const response = await fetch(`${DINGTALK_API}/v1.0/oauth2/accessToken`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appKey: appId, appSecret }),
    signal: AbortSignal.timeout(AVATAR_FETCH_TIMEOUT_MS),
  })
  const body = (await response.json()) as { accessToken?: string; message?: string }
  if (!response.ok || !body.accessToken) {
    throw new Error(`钉钉 accessToken 获取失败：${response.status} ${body.message ?? ''}`)
  }
  return body.accessToken
}

async function fetchAvatar(appToken: string, externalUserId: string): Promise<string | null> {
  const url = new URL('/topapi/v2/user/get', DINGTALK_OAPI)
  url.searchParams.set('access_token', appToken)
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userid: externalUserId, language: 'zh_CN' }),
    signal: AbortSignal.timeout(AVATAR_FETCH_TIMEOUT_MS),
  })
  const body = (await response.json()) as {
    errcode?: number
    errmsg?: string
    result?: { avatar?: string }
  }
  if (body.errcode && body.errcode !== 0) {
    throw new Error(`钉钉用户详情读取失败 ${body.errcode}：${body.errmsg ?? ''}`)
  }
  const avatar = body.result?.avatar ? String(body.result.avatar).trim() : ''
  return avatar || null
}

/**
 * 主动拉一次钉钉实时头像并落库（不受库里已有值影响）。
 *
 * 返回：
 * - 头像 URL：拉到了新头像；
 * - 空字符串：钉钉确认这个人没有自定义头像（默认头像），用于清掉旧地址；
 * - null：没有用户 / 没有钉钉身份 / 接口失败，保留库里原值不变。
 */
export async function refreshDingTalkUserAvatar(
  db: Db,
  dbPath: string,
  companyId: string,
  userId: string,
): Promise<string | null> {
  const user = db
    .prepare('SELECT avatar FROM users WHERE id = ? AND company_id = ? AND deleted_at IS NULL')
    .get(userId, companyId) as { avatar: string | null } | undefined
  if (!user) return null
  const current = user.avatar

  const identity = db
    .prepare(
      `SELECT external_user_id FROM user_identities
        WHERE user_id = ? AND provider = 'dingtalk'
        ORDER BY id LIMIT 1`,
    )
    .get(userId) as { external_user_id: string } | undefined
  if (!identity?.external_user_id) return current

  try {
    const cfg = channelConfig(db, dbPath, companyId)
    if (!cfg) return current
    const token = await appAccessToken(cfg.appId, cfg.appSecret)
    const avatar = await fetchAvatar(token, identity.external_user_id)
    const next = avatar ?? ''
    if (next !== (current ?? '')) {
      db.prepare('UPDATE users SET avatar = ?, updated_at = ? WHERE id = ? AND company_id = ?').run(
        next,
        Date.now(),
        userId,
        companyId,
      )
    }
    return next
  } catch (error) {
    console.warn('[eab] 刷新钉钉头像失败，本次保留旧头像：', (error as Error).message)
    return current
  }
}

/**
 * 确保 users.avatar 有取值（URL 或空字符串=已确认无头像）。
 * 返回可展示的头像 URL；没有或失败时返回 null。
 */
export async function ensureDingTalkUserAvatar(
  db: Db,
  dbPath: string,
  companyId: string,
  userId: string,
): Promise<string | null> {
  const user = db
    .prepare('SELECT avatar FROM users WHERE id = ? AND company_id = ? AND deleted_at IS NULL')
    .get(userId, companyId) as { avatar: string | null } | undefined
  if (!user) return null
  if (user.avatar !== null) return user.avatar || null

  const refreshed = await refreshDingTalkUserAvatar(db, dbPath, companyId, userId)
  return refreshed || null
}
