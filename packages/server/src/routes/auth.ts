/**
 * 员工登录 / 退出 / 会话查询。
 *
 * 与控制台登录（/api/console/login）互不影响：这里签的是组织成员会话。
 * 登录失败 5 次锁 10 分钟，锁定键 = IP + 账号，避免一个账号被全公司试。
 */
import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { EC, EabError, normalizeMobile } from '@eab/domain'
import { appendAudit } from '@eab/storage'
import type { ServerDeps } from '../deps.js'
import { ok } from '../http.js'
import { hashPassword, verifyPassword } from '../password.js'
import { resolveSecret } from '../secrets.js'
import {
  SESSION_COOKIE,
  createEmployeeSession,
  readSessionUserId,
  revokeAllSessions,
  revokeCurrentSession,
} from '../employee-session.js'
import { findPerson, roleCodesOf } from '../session.js'
import { refreshDingTalkUserAvatar } from '../dingtalk-avatar.js'

const MAX_FAILS = 5
const LOCK_MS = 10 * 60 * 1000
const COOKIE_DAYS = 7

interface UserRow {
  id: string
  company_id: string
  name: string
  employee_no: string | null
  email: string | null
  mobile: string | null
  password_hash: string | null
  status: string
  disabled_at: number | null
  deleted_at: number | null
}

function failKey(req: FastifyRequest, account: string): string {
  return createHash('sha256').update(`${req.ip ?? '-'}|${account.toLowerCase()}`).digest('hex')
}

function cookieHeader(req: FastifyRequest, value: string, maxAge: number): string {
  const secure = req.protocol === 'https' ? '; Secure' : ''
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
}

/* ---------------- 钉钉扫码登录 ---------------- */

const DINGTALK_API = 'https://api.dingtalk.com'
const DINGTALK_OAPI = 'https://oapi.dingtalk.com'
const LOGIN_STATE_TTL_MS = 5 * 60 * 1000

interface DingTalkApp {
  readonly appId: string
  readonly appSecret: string
  readonly tenantId: string | null
  readonly tenantName: string | null
}

interface LoginStateRow {
  readonly id: string
  readonly company_id: string
  readonly provider: string
  readonly state: string
  readonly redirect_path: string
  readonly created_at: number
  readonly expires_at: number
  readonly consumed_at: number | null
}

interface DingTalkMemberRow {
  readonly user_id: string
  readonly name: string
  readonly company_id: string
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function loginErrorPage(message: string, hint = ''): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>钉钉登录未完成</title>
<style>body{margin:0;background:#f6f7f9;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#1f2329}main{max-width:560px;margin:12vh auto;padding:28px 30px;background:#fff;border:1px solid #e5e6eb;border-radius:14px;box-shadow:0 8px 30px rgba(31,35,41,.06)}h1{font-size:20px;margin:0 0 10px}p{margin:0 0 10px;line-height:1.7;color:#4e5969}.hint{font-size:13px;color:#86909c}a{display:inline-block;margin-top:14px;color:#0b6bcb;text-decoration:none}code{background:#f2f3f5;padding:2px 6px;border-radius:5px;font-size:12px}</style></head>
<body><main><h1>钉钉登录未完成</h1><p>${escapeHtml(message)}</p>${hint ? `<p class="hint">${escapeHtml(hint)}</p>` : ''}<a href="/chat">返回登录页</a></main></body></html>`
}

function publicBaseUrl(req: FastifyRequest, deps: ServerDeps): string {
  const forwardedProto = String(req.headers['x-forwarded-proto'] ?? '')
    .split(',')[0]
    .trim()
  const forwardedHost = String(req.headers['x-forwarded-host'] ?? '')
    .split(',')[0]
    .trim()
  const proto = forwardedProto || req.protocol || 'http'
  const host = forwardedHost || String(req.headers.host ?? `127.0.0.1:${deps.config.port}`)
  return `${proto}://${host}`
}

function safeRedirectPath(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/chat'
  return raw.slice(0, 200)
}

function dingtalkAppOf(deps: ServerDeps, companyId: string): DingTalkApp {
  const row = deps.db
    .prepare(
      `SELECT app_id, secret_ref, tenant_id, tenant_name, enabled, status
         FROM channel_configs
        WHERE company_id = ? AND provider = 'dingtalk'`,
    )
    .get(companyId) as
    | {
        app_id: string | null
        secret_ref: string | null
        tenant_id: string | null
        tenant_name: string | null
        enabled: number
        status: string
      }
    | undefined
  if (!row?.app_id || !row.secret_ref) {
    throw new EabError(EC.VALIDATION, '这家公司还没有绑定钉钉应用，无法扫码登录', {
      hint: '先让公司管理员在控制台「渠道」里用钉钉 AppKey / AppSecret 完成绑定并同步组织架构。',
    })
  }
  const appSecret = resolveSecret(deps.config.dbPath, row.secret_ref)
  if (!appSecret) {
    throw new EabError(EC.VALIDATION, '钉钉应用密钥没有注入到当前服务器', {
      hint: '检查 .eab-dev/secrets.json 里对应的 secret 引用，或重新保存一次 AppSecret。',
    })
  }
  return {
    appId: row.app_id,
    appSecret,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
  }
}

async function readDingTalkJson(
  url: string,
  init?: RequestInit,
  stage = '',
): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(15_000),
  })
  const text = await res.text()
  let body: Record<string, unknown> = {}
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    throw new EabError(EC.INTERNAL, `钉钉接口返回非 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`)
  }
  if (!res.ok) {
    const message = String(body.message ?? body.errmsg ?? text).slice(0, 240)
    const denied = (body.AccessDeniedDetail ?? body.accessDeniedDetail) as
      | { requiredScopes?: unknown }
      | undefined
    const required = Array.isArray(denied?.requiredScopes)
      ? denied.requiredScopes.map((item) => String(item)).filter(Boolean)
      : []
    const code = typeof body.code === 'string' ? body.code : ''
    const parts = [
      stage ? `${stage}：` : '',
      `钉钉接口 HTTP ${res.status}：${message}`,
      code ? `（${code}）` : '',
      required.length ? `，缺少权限点 ${required.join('、')}` : '',
    ]
    throw new EabError(EC.INTERNAL, parts.join(''), {
      hint: required.length
        ? `在钉钉开放平台「权限管理」搜索 ${required.join('、')} 并开通，然后发布一个新版本让权限生效。`
        : '检查钉钉应用的接口权限与版本是否已发布生效。',
      details: { status: res.status, code, requiredScopes: required },
    })
  }
  return body
}

async function dingtalkAppAccessToken(app: DingTalkApp): Promise<string> {
  const body = await readDingTalkJson(
    `${DINGTALK_API}/v1.0/oauth2/accessToken`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appKey: app.appId, appSecret: app.appSecret }),
    },
    '获取应用 accessToken',
  )
  const token = typeof body.accessToken === 'string' ? body.accessToken : ''
  if (!token) throw new EabError(EC.INTERNAL, '钉钉没有返回应用 accessToken')
  return token
}

async function dingtalkUserAccessToken(app: DingTalkApp, code: string): Promise<string> {
  const body = await readDingTalkJson(
    `${DINGTALK_API}/v1.0/oauth2/userAccessToken`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: app.appId,
        clientSecret: app.appSecret,
        code,
        grantType: 'authorization_code',
      }),
    },
    '换取用户 accessToken',
  )
  const token = typeof body.accessToken === 'string' ? body.accessToken : ''
  if (!token) throw new EabError(EC.INTERNAL, '钉钉没有返回用户 accessToken')
  return token
}

async function dingtalkUserProfile(userAccessToken: string): Promise<{ unionId: string; openId: string; nick: string }> {
  const body = await readDingTalkJson(
    `${DINGTALK_API}/v1.0/contact/users/me`,
    { headers: { 'x-acs-dingtalk-access-token': userAccessToken } },
    '读取钉钉用户信息',
  )
  const unionId = typeof body.unionId === 'string' ? body.unionId : typeof body.unionid === 'string' ? body.unionid : ''
  const openId = typeof body.openId === 'string' ? body.openId : typeof body.openid === 'string' ? body.openid : ''
  const nick = typeof body.nick === 'string' ? body.nick : ''
  if (!unionId) throw new EabError(EC.INTERNAL, '钉钉用户信息里没有 unionId，无法定位企业成员')
  return { unionId, openId, nick }
}

async function dingtalkUserProfileBySns(
  app: DingTalkApp,
  code: string,
): Promise<{ unionId: string; openId: string; nick: string }> {
  /**
   * 换机器人后新应用常常没有「通讯录个人信息读权限」（/contact/users/me 直接 403）。
   * 这个老 SNS 接口只要应用本身能登录就能拿到 unionId，再用组织同步时存下的 union_id
   * 定位成员；这样换机器人不会把扫码登录一起弄坏。
   */
  const appToken = await dingtalkAppAccessToken(app)
  const body = await readDingTalkJson(
    `${DINGTALK_OAPI}/sns/getuserinfo_bycode?access_token=${encodeURIComponent(appToken)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tmp_auth_code: code }),
    },
    '读取钉钉扫码用户信息',
  )
  const errcode = Number(body.errcode ?? 0)
  if (errcode !== 0) {
    throw new EabError(EC.INTERNAL, `钉钉 SNS 登录失败 ${errcode}：${String(body.errmsg ?? '')}`)
  }
  const info = (body.user_info ?? {}) as { unionid?: unknown; openid?: unknown; nick?: unknown }
  const unionId = typeof info.unionid === 'string' ? info.unionid : ''
  const openId = typeof info.openid === 'string' ? info.openid : ''
  const nick = typeof info.nick === 'string' ? info.nick : ''
  if (!unionId) throw new EabError(EC.INTERNAL, '钉钉 SNS 用户信息里没有 unionId')
  return { unionId, openId, nick }
}

function dingtalkPermissionDenied(error: unknown): boolean {
  if (!(error instanceof EabError)) return false
  const details = error.details as { status?: number } | undefined
  return (
    details?.status === 403 ||
    /HTTP 403|AccessTokenPermissionDenied|没有调用该接口的权限/.test(error.message)
  )
}

async function dingtalkUserIdByUnionId(appToken: string, unionId: string): Promise<string> {
  const body = await readDingTalkJson(
    `${DINGTALK_OAPI}/topapi/user/getbyunionid?access_token=${encodeURIComponent(appToken)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ unionid: unionId }),
    },
    '按 unionId 查企业 UserID',
  )
  const errcode = Number(body.errcode ?? 0)
  if (errcode !== 0) {
    throw new EabError(EC.INTERNAL, `钉钉 getbyunionid 失败 ${errcode}：${String(body.errmsg ?? '')}`)
  }
  const result = (body.result ?? {}) as { userid?: unknown }
  const userId = typeof result.userid === 'string' ? result.userid : ''
  if (!userId) throw new EabError(EC.INTERNAL, '钉钉没有返回企业 UserID')
  return userId
}

function findDingTalkMember(
  deps: ServerDeps,
  companyId: string,
  userId: string,
  unionId: string,
): DingTalkMemberRow | undefined {
  const base = `
    SELECT ui.user_id, u.name, u.company_id
      FROM user_identities ui
      JOIN users u ON u.id = ui.user_id
     WHERE ui.provider = 'dingtalk'
       AND u.company_id = ?
       AND u.deleted_at IS NULL
       AND u.status = 'active'`
  if (userId) {
    const exact = deps.db
      .prepare(`${base} AND ui.external_user_id = ? LIMIT 1`)
      .get(companyId, userId) as DingTalkMemberRow | undefined
    if (exact) return exact
  }
  if (unionId) {
    return deps.db
      .prepare(`${base} AND ui.union_id = ? LIMIT 1`)
      .get(companyId, unionId) as DingTalkMemberRow | undefined
  }
  return undefined
}

function dingtalkPermissionApplyUrl(appId: string): string {
  return `https://open-dev.dingtalk.com/appscope/apply?content=${encodeURIComponent(`${appId}#Contact.User.Read`)}`
}

/** 用钉钉授权码换出 unionId / 企业 UserID，并定位到本公司的成员。 */
async function dingtalkIdentityByCode(
  deps: ServerDeps,
  companyId: string,
  code: string,
): Promise<{
  profile: { unionId: string; openId: string; nick: string }
  externalUserId: string
  member: DingTalkMemberRow | undefined
}> {
  const app = dingtalkAppOf(deps, companyId)
  const userAccessToken = await dingtalkUserAccessToken(app, code)
  let profile: { unionId: string; openId: string; nick: string }
  try {
    profile = await dingtalkUserProfile(userAccessToken)
  } catch (error) {
    /**
     * 新机器人经常没有 Contact.User.Read，/contact/users/me 会直接 403。
     * 不论这里是什么错误，都先尝试老 SNS 接口换 unionId；SNS 成功就不再把
     * 权限问题暴露给扫码用户。SNS 也失败时，403 才转成可行动提示。
     */
    try {
      console.info('[eab] 钉钉 /contact/users/me 不可用，改用 SNS 换 unionId')
      profile = await dingtalkUserProfileBySns(app, code)
    } catch {
      if (!dingtalkPermissionDenied(error)) throw error
      throw new EabError(
        EC.FORBIDDEN,
        '扫码登录需要钉钉「通讯录个人信息读权限（Contact.User.Read）」，请开通并发布新版本后再扫。',
        {
          hint: '开通权限后必须发布一个新版本，权限才会对线上应用生效。',
          details: { applyUrl: dingtalkPermissionApplyUrl(app.appId) },
        },
      )
    }
  }
  let externalUserId = ''
  try {
    const appToken = await dingtalkAppAccessToken(app)
    externalUserId = await dingtalkUserIdByUnionId(appToken, profile.unionId)
  } catch (error) {
    /**
     * 新机器人可能没有通讯录权限（getbyunionid 返回 60011 时仍是 HTTP 200，
     * 在这里表现为错误码而不是 403）。登录只依赖 unionId + 同步时写入的
     * user_identities.union_id，因此这一步拿不到企业 UserID 也不应中断登录。
     */
    console.warn('[eab] 钉钉按 unionId 反查 UserID 失败，改用 union_id 匹配：', (error as Error).message)
  }
  return {
    profile,
    externalUserId,
    member: findDingTalkMember(deps, companyId, externalUserId, profile.unionId),
  }
}

/** 校验并一次性消费扫码登录 state，避免同一个授权码被重放。 */
function consumeLoginState(
  deps: ServerDeps,
  companyId: string,
  state: string,
): { redirect_path: string | null } {
  const row = deps.db
    .prepare(
      `SELECT id, redirect_path, expires_at, consumed_at
         FROM auth_login_states
        WHERE company_id = ? AND provider = 'dingtalk' AND state = ?
        LIMIT 1`,
    )
    .get(companyId, state) as
    | { id: string; redirect_path: string | null; expires_at: number; consumed_at: number | null }
    | undefined
  if (!row) throw new EabError(EC.NOT_FOUND, '登录状态不存在或已失效，请重新扫码')
  if (row.consumed_at) throw new EabError(EC.VALIDATION, '这个二维码已经使用过，请重新扫码')
  if (Date.now() > row.expires_at) throw new EabError(EC.VALIDATION, '二维码已过期，请重新扫码')
  deps.db
    .prepare('UPDATE auth_login_states SET consumed_at = ? WHERE id = ?')
    .run(Date.now(), row.id)
  return { redirect_path: row.redirect_path }
}

function checkLock(db: ServerDeps['db'], key: string): void {
  const row = db
    .prepare('SELECT fail_count, locked_until FROM login_attempts WHERE key = ?')
    .get(key) as { fail_count: number; locked_until: number | null } | undefined
  if (row?.locked_until && row.locked_until > Date.now()) {
    const minutes = Math.ceil((row.locked_until - Date.now()) / 60_000)
    throw new EabError(EC.RATE_LIMITED, `登录失败次数过多，请 ${minutes} 分钟后再试`, {
      hint: '忘记密码请联系管理员重置；管理员可在控制台「组织架构」重置成员密码',
    })
  }
}

function recordFail(db: ServerDeps['db'], key: string): void {
  const now = Date.now()
  const row = db
    .prepare('SELECT fail_count FROM login_attempts WHERE key = ?')
    .get(key) as { fail_count: number } | undefined
  const count = (row?.fail_count ?? 0) + 1
  const lockedUntil = count >= MAX_FAILS ? now + LOCK_MS : null
  db.prepare(
    `INSERT INTO login_attempts (key, fail_count, locked_until, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET fail_count = excluded.fail_count,
       locked_until = excluded.locked_until, updated_at = excluded.updated_at`,
  ).run(key, count, lockedUntil, now)
}

function clearFails(db: ServerDeps['db'], key: string): void {
  db.prepare('DELETE FROM login_attempts WHERE key = ?').run(key)
}

/**
 * 生成一次扫码登录的 state 与授权地址。
 *
 * 抽出来给两个入口共用：/start（管理台跳转）和 /qr（直接出二维码图片）。
 * 回调地址按当前请求的 Host 推导，因此本地 127.0.0.1、局域网 IP、公网域名
 * 都会自动使用“用户此刻访问的那个地址”，不需要额外配置域名。
 */
function beginDingTalkLogin(
  req: FastifyRequest,
  deps: ServerDeps,
  companyId: string,
  redirectPath: string,
): {
  url: string
  state: string
  companyId: string
  companyName: string
  appId: string
  expiresAt: number
  callback: string
} {
  const company = deps.db.prepare('SELECT id FROM companies WHERE id = ? AND deleted_at IS NULL').get(companyId)
  if (!company) throw new EabError(EC.NOT_FOUND, '公司不存在或已删除')
  const app = dingtalkAppOf(deps, companyId)

  const now = Date.now()
  const state = `dts_${randomUUID().replace(/-/g, '')}`
  const id = `als_${randomUUID().replace(/-/g, '')}`
  deps.db
    .prepare(
      `INSERT INTO auth_login_states
         (id, company_id, provider, state, redirect_path, created_at, expires_at, consumed_at)
       VALUES (?, ?, 'dingtalk', ?, ?, ?, ?, NULL)`,
    )
    .run(id, companyId, state, redirectPath, now, now + LOGIN_STATE_TTL_MS)

  // 同一家公司只保留最近 20 条待扫 state，避免表无限增长
  deps.db
    .prepare(
      `DELETE FROM auth_login_states
        WHERE company_id = ? AND provider = 'dingtalk' AND consumed_at IS NULL
          AND id NOT IN (
            SELECT id FROM auth_login_states
             WHERE company_id = ? AND provider = 'dingtalk' AND consumed_at IS NULL
             ORDER BY created_at DESC LIMIT 20
          )`,
    )
    .run(companyId, companyId)

  const callback = `${publicBaseUrl(req, deps)}/api/auth/dingtalk/callback`
  const url = new URL('https://login.dingtalk.com/oauth2/auth')
  url.searchParams.set('redirect_uri', callback)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', app.appId)
  url.searchParams.set('scope', 'openid')
  url.searchParams.set('state', state)
  url.searchParams.set('prompt', 'consent')

  return {
    url: url.toString(),
    state,
    companyId,
    companyName: app.tenantName ?? '',
    appId: app.appId,
    expiresAt: now + LOGIN_STATE_TTL_MS,
    callback,
  }
}

export function registerAuthRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post<{ Body: { account?: string; password?: string } }>(
    '/api/auth/login',
    async (req, reply) => {
      const account = String(req.body?.account ?? '').trim()
      const password = String(req.body?.password ?? '')
      if (!account || !password) {
        throw new EabError(EC.VALIDATION, '请输入账号和密码')
      }
      const key = failKey(req, account)
      checkLock(deps.db, key)
      /** 手机号可能带 +86 / 空格 / 横线；落库与登录都用同一套归一化 */
      const mobileAccount = normalizeMobile(account)

      const row = deps.db
        .prepare(
          `SELECT id, company_id, name, employee_no, email, mobile, password_hash, status, disabled_at, deleted_at
             FROM users
            WHERE lower(employee_no) = lower(?) OR lower(email) = lower(?)
               OR (mobile IS NOT NULL AND mobile <> '' AND (mobile = ? OR mobile = ?))
            ORDER BY created_at LIMIT 1`,
        )
        .get(account, account, mobileAccount, account) as unknown as UserRow | undefined
      if (!row || !verifyPassword(row.password_hash, password)) {
        recordFail(deps.db, key)
        throw new EabError(EC.AUTH_REQUIRED, '账号或密码不正确', {
          hint: '账号是工号、邮箱或手机号；连续错 5 次会锁定 10 分钟',
        })
      }
      if (row.status !== 'active' || row.disabled_at !== null || row.deleted_at !== null) {
        throw new EabError(EC.FORBIDDEN, '该账号已停用，请联系管理员', {
          hint: '停用后所有会话立即失效，数据保留',
        })
      }
      if (row.company_id !== deps.companyId) {
        throw new EabError(EC.FORBIDDEN, '该账号不属于当前实例的唯一公司', {
          hint: '本实例只允许一家公司、一个组织架构；旧的多公司账号不能再登录。',
          details: { accountCompany: row.company_id, instanceCompany: deps.companyId },
        })
      }
      const companyStatus = deps.db
        .prepare('SELECT status FROM companies WHERE id = ?')
        .get(deps.companyId) as { status?: string } | undefined
      if (companyStatus?.status === 'suspended') {
        throw new EabError(EC.FORBIDDEN, '当前公司已停用，员工暂时不能登录', {
          hint: '管理员可在管理控制台「公司信息」恢复启用。',
        })
      }

      clearFails(deps.db, key)
      const session = createEmployeeSession(deps.db, row.id, req)
      reply.header('set-cookie', cookieHeader(req, session.cookie, COOKIE_DAYS * 24 * 60 * 60))
      let person = findPerson(deps.db, row.id)
      // 每次登录都主动拉一次钉钉实时头像；失败时 refresh 内部保留库里旧值。
      const avatar = await refreshDingTalkUserAvatar(deps.db, deps.config.dbPath, row.company_id, row.id)
      if (person && avatar !== null) person = { ...person, avatar }
      appendAudit(deps.db, {
        companyId: row.company_id,
        actorUserId: row.id,
        action: 'auth.login',
        resourceType: 'session',
        result: 'success',
        ip: req.ip ?? null,
        channel: 'web',
        detail: { account },
      })
      return ok({ person, roles: roleCodesOf(deps.db, row.id) })
    },
  )

  /**
   * 登录页需要知道这家公司配置了哪些扫码登录方式。
   * 未配置的渠道不展示为可点入口，避免用户点了才发现走不通。
   */
  app.get<{ Querystring: { company?: string } }>('/api/auth/methods', async (_req) => {
    /** 单公司实例：登录页只查唯一公司的扫码配置，不接受 URL 指定别家公司 */
    const companyId = deps.companyId
    const rows = deps.db
      .prepare(
        `SELECT provider, tenant_name, status, enabled, app_id, secret_ref
           FROM channel_configs
          WHERE company_id = ? AND provider IN ('dingtalk', 'feishu')`,
      )
      .all(companyId) as unknown as Array<{
      provider: string
      tenant_name: string | null
      status: string | null
      enabled: number
      app_id: string | null
      secret_ref: string | null
    }>
    const configured = (provider: string) => {
      const row = rows.find((item) => item.provider === provider)
      return Boolean(row && row.enabled === 1 && row.status === 'bound' && row.app_id && row.secret_ref)
    }
    const dingtalk = rows.find((item) => item.provider === 'dingtalk')
    const feishu = rows.find((item) => item.provider === 'feishu')
    const company = deps.db.prepare('SELECT name FROM companies WHERE id = ?').get(companyId) as
      | { name: string | null }
      | undefined
    return ok({
      companyId,
      companyName: company?.name ?? dingtalk?.tenant_name ?? null,
      dingtalk: {
        configured: configured('dingtalk'),
        tenantName: dingtalk?.tenant_name ?? null,
        appId: dingtalk?.app_id ?? null,
      },
      feishu: {
        configured: configured('feishu'),
        tenantName: feishu?.tenant_name ?? null,
        appId: feishu?.app_id ?? null,
        /** 飞书扫码登录链路尚未接入，前端只展示入口与说明。 */
        implemented: false,
      },
      defaultMethod: configured('dingtalk') ? 'dingtalk' : configured('feishu') ? 'feishu' : null,
    })
  })

  /**
   * 发起钉钉扫码登录。
   *
   * 二维码用“这家公司自己的钉钉应用”生成；扫码后拿到的 unionId / userid 只在这家公司
   * 的 user_identities 里查，查到就直接签员工会话。没有同步过的人不会进任何公司。
   */
  app.get<{ Querystring: { company?: string; redirect?: string } }>(
    '/api/auth/dingtalk/start',
    async (req) => {
      const companyId = deps.companyId
      const redirectPath = safeRedirectPath(req.query.redirect)
      return ok(beginDingTalkLogin(req, deps, companyId, redirectPath))
    },
  )

  /**
   * 内嵌二维码登录：前端拿到 authCode 后直接 POST 到这里换会话。
   *
   * 这条路径不要求手机访问 EAB 的回调地址，127.0.0.1 本地部署也能扫码登录。
   */
  app.post<{
    Body: { company?: string; authCode?: string; state?: string }
  }>('/api/auth/dingtalk/exchange', async (req, reply) => {
    const companyId = deps.companyId
    const authCode = String(req.body?.authCode ?? '').trim()
    const state = String(req.body?.state ?? '').trim()
    if (!authCode || !state) throw new EabError(EC.VALIDATION, '缺少钉钉授权码，请重新扫码')

    const loginState = consumeLoginState(deps, companyId, state)
    const { profile, externalUserId, member } = await dingtalkIdentityByCode(
      deps,
      companyId,
      authCode,
    )
    if (!member) {
      throw new EabError(
        EC.FORBIDDEN,
        `你的钉钉账号（UserID：${externalUserId}）还没有同步到这家 EAB 公司`,
        {
          hint: '请让公司管理员在控制台「渠道」里重新同步一次组织架构；同步完成后回来重新扫码。也可以先用工号、邮箱或手机号登录。',
        },
      )
    }

    const session = createEmployeeSession(deps.db, member.user_id, req)
    reply.header('set-cookie', cookieHeader(req, session.cookie, COOKIE_DAYS * 24 * 60 * 60))
    let person = findPerson(deps.db, member.user_id)
    const avatar = await refreshDingTalkUserAvatar(deps.db, deps.config.dbPath, companyId, member.user_id)
    if (person && avatar !== null) person = { ...person, avatar }
    appendAudit(deps.db, {
      companyId,
      actorUserId: member.user_id,
      action: 'auth.login',
      resourceType: 'session',
      result: 'success',
      ip: req.ip ?? null,
      channel: 'dingtalk',
      detail: { provider: 'dingtalk', externalUserId, unionId: profile.unionId, mode: 'embedded-qr' },
    })
    return ok({
      person,
      roles: roleCodesOf(deps.db, member.user_id),
      redirectPath: safeRedirectPath(loginState.redirect_path),
    })
  })

  /**
   * 钉钉扫码回调：code → 用户 accessToken → unionId → 企业 userid → user_identities。
   *
   * 判定顺序：先按钉钉 userid 精确匹配，再按 unionId 兜底；都查不到就明确告诉用户
   * “还没有同步到这家公司”，不偷偷创建账号。
   */
  app.get<{ Querystring: { code?: string; state?: string } }>(
    '/api/auth/dingtalk/callback',
    async (req, reply) => {
      const code = String(req.query.code ?? '').trim()
      const state = String(req.query.state ?? '').trim()
      if (!code || !state) {
        return reply
          .status(400)
          .type('text/html; charset=utf-8')
          .send(loginErrorPage('钉钉回调缺少 code 或 state，请重新扫码。'))
      }

      const row = deps.db
        .prepare(
          `SELECT id, company_id, provider, state, redirect_path, created_at, expires_at, consumed_at
             FROM auth_login_states WHERE state = ?`,
        )
        .get(state) as LoginStateRow | undefined
      if (!row || row.provider !== 'dingtalk') {
        return reply
          .status(400)
          .type('text/html; charset=utf-8')
          .send(loginErrorPage('登录状态不存在或已失效，请重新扫码。'))
      }
      if (row.consumed_at !== null) {
        return reply
          .status(400)
          .type('text/html; charset=utf-8')
          .send(loginErrorPage('这个二维码已经使用过，请重新扫码。'))
      }
      if (Date.now() > row.expires_at) {
        return reply
          .status(400)
          .type('text/html; charset=utf-8')
          .send(loginErrorPage('二维码已过期，请重新扫码。'))
      }

      // 先消费 state，避免同一个回调被重放
      deps.db
        .prepare('UPDATE auth_login_states SET consumed_at = ? WHERE id = ?')
        .run(Date.now(), row.id)

      try {
        const { profile, externalUserId, member } = await dingtalkIdentityByCode(deps, row.company_id, code)

        if (!member) {
          return reply
            .status(403)
            .type('text/html; charset=utf-8')
            .send(
              loginErrorPage(
                `你的钉钉账号（UserID：${externalUserId}）还没有同步到这家 EAB 公司。`,
                '请让公司管理员在控制台「渠道」里重新同步一次组织架构；同步完成后回来重新扫码。也可以先用工号、邮箱或手机号登录。',
              ),
            )
        }

        const session = createEmployeeSession(deps.db, member.user_id, req)
        reply.header('set-cookie', cookieHeader(req, session.cookie, COOKIE_DAYS * 24 * 60 * 60))
        // 扫码登录同样主动拉一次实时头像，避免钉钉换头像后网页长期用旧图。
        await refreshDingTalkUserAvatar(deps.db, deps.config.dbPath, row.company_id, member.user_id)
        appendAudit(deps.db, {
          companyId: row.company_id,
          actorUserId: member.user_id,
          action: 'auth.login',
          resourceType: 'session',
          result: 'success',
          ip: req.ip ?? null,
          channel: 'dingtalk',
          detail: { provider: 'dingtalk', externalUserId, unionId: profile.unionId },
        })
        return reply.redirect(row.redirect_path || '/chat')
      } catch (err) {
        const message = err instanceof EabError ? err.message : '钉钉登录失败，请稍后重试。'
        const hint =
          err instanceof EabError && err.hint
            ? err.hint
            : '如果反复失败，请检查钉钉应用的 AppKey / AppSecret 与「重定向URL」是否和当前访问地址一致。'
        return reply
          .status(400)
          .type('text/html; charset=utf-8')
          .send(loginErrorPage(message, hint))
      }
    },
  )

  app.post('/api/auth/logout', async (req, reply) => {    const userId = readSessionUserId(deps.db, req)
    revokeCurrentSession(deps.db, req)
    reply.header('set-cookie', cookieHeader(req, '', 0))
    if (userId) {
      const person = findPerson(deps.db, userId)
      if (person) {
        appendAudit(deps.db, {
          companyId: person.companyId,
          actorUserId: userId,
          action: 'auth.logout',
          resourceType: 'session',
          result: 'success',
          ip: req.ip ?? null,
          channel: 'web',
        })
      }
    }
    return ok({ loggedOut: true })
  })

  /** 当前员工会话；没登录返回 401，前端据此显示登录卡 */
  app.get('/api/auth/me', async (req) => {
    const userId = readSessionUserId(deps.db, req)
    if (!userId) throw new EabError(EC.AUTH_REQUIRED, '未登录')
    const person = findPerson(deps.db, userId)
    if (!person) throw new EabError(EC.AUTH_REQUIRED, '会话对应的成员已不存在')
    const passwordRow = deps.db
      .prepare('SELECT password_set_at FROM users WHERE id = ?')
      .get(userId) as { password_set_at?: number | null } | undefined
    return ok({
      person,
      roles: roleCodesOf(deps.db, userId),
      company: { id: person.companyId, name: person.companyName },
      passwordConfigured: passwordRow?.password_set_at != null,
    })
  })

  /** 改自己的密码：校验旧密码 → 换新哈希 → 吊销其它会话 → 给当前浏览器重新签一个 */
  app.post<{ Body: { oldPassword?: string; newPassword?: string } }>(
    '/api/auth/password',
    async (req, reply) => {
      const userId = readSessionUserId(deps.db, req)
      if (!userId) throw new EabError(EC.AUTH_REQUIRED, '未登录')
      const oldPassword = String(req.body?.oldPassword ?? '')
      const newPassword = String(req.body?.newPassword ?? '')
      if (newPassword.length < 8) throw new EabError(EC.VALIDATION, '新密码至少 8 位')
      if (newPassword.length > 128) throw new EabError(EC.VALIDATION, '新密码最多 128 位')
      const row = deps.db
        .prepare(
          'SELECT password_hash, password_set_at, company_id FROM users WHERE id = ? AND deleted_at IS NULL',
        )
        .get(userId) as
        | { password_hash: string | null; password_set_at: number | null; company_id: string }
        | undefined
      if (!row) throw new EabError(EC.AUTH_REQUIRED, '成员不存在')
      const passwordConfigured = row.password_hash !== null && row.password_set_at !== null
      if (passwordConfigured) {
        if (!oldPassword) throw new EabError(EC.VALIDATION, '请输入当前密码')
        if (!verifyPassword(row.password_hash, oldPassword)) {
          throw new EabError(EC.VALIDATION, '当前密码不正确')
        }
      }
      const hash = hashPassword(newPassword)
      const now = Date.now()
      deps.db
        .prepare('UPDATE users SET password_hash = ?, password_set_at = ?, updated_at = ? WHERE id = ?')
        .run(hash, now, now, userId)
      revokeAllSessions(deps.db, userId)
      const session = createEmployeeSession(deps.db, userId, req)
      reply.header('set-cookie', cookieHeader(req, session.cookie, COOKIE_DAYS * 24 * 60 * 60))
      appendAudit(deps.db, {
        companyId: row.company_id,
        actorUserId: userId,
        action: passwordConfigured ? 'auth.password.change' : 'auth.password.set',
        resourceType: 'user',
        resourceId: userId,
        result: 'success',
        ip: req.ip ?? null,
        channel: 'web',
      })
      return ok({ changed: true, firstSet: !passwordConfigured })
    },
  )
}
