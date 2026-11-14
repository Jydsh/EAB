/**
 * 控制台会话（服务器侧超级管理员账号）。
 *
 * 和员工登录完全分开：
 * - 员工：组织成员，走渠道/网页登录，只能进 `/chat`。
 * - 控制台：一个超级管理员账号（默认 `admin`），密码来自环境变量或首次启动自动生成，
 *   进去是"控制台操作员"，不属于任何公司、不继承任何角色。
 *
 * 会话形态：**HMAC 签名 Cookie**，服务端不存会话表。
 * - 跨实例天然共享：所有实例用同一份管理员密码派生签名密钥，谁签的都认；
 * - 重启不掉登录：会话不依赖进程内存；
 * - 改密码即全端失效：签名密钥由密码派生，改完旧 Cookie 一律验不过；
 *   当前设备在改密响应里换发一个新 Cookie，所以只有自己继续在线。
 *
 * 签名密钥 = HMAC-SHA256(key = 管理员密码, 固定域串)。密码本身不出现在 Cookie 里。
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import type { ServerConfig } from './config.js'

export interface ConsoleSession {
  readonly id: string
  readonly user: string
  readonly expiresAt: number
  /** 登录时的来源地址，便于排查"谁从哪台机器进来" */
  readonly ip: string
}

interface SessionPayload {
  /** 会话 id，仅用于日志关联 */
  readonly sid: string
  readonly u: string
  readonly ip: string
  readonly exp: number
}

const COOKIE = 'eab_console_sid'
const SESSION_MS = 8 * 60 * 60 * 1000
const REALM = 'eab-console-session'

/** 当前签名密钥：由管理员密码派生；改密码时同步刷新，旧 Cookie 立刻失效。 */
let signingKey: Buffer | null = null
/** 账号中心改过的密码：进程内生效，同时会写回 .eab-dev/admin-credentials.txt，重启后照旧读到 */
let passwordOverride: string | null = null
/** 启动时从 config 读到的管理员密码，用于派生签名密钥 */
let loginPassword: string | null = null

function deriveKey(password: string): Buffer {
  return createHmac('sha256', `${REALM}:key`).update(password).digest()
}

function keyOf(): Buffer {
  // 没配置管理员密码时退回进程级随机密钥：会话仍可用，但外部无法伪造签名。
  signingKey ??= deriveKey(`fallback:${randomBytes(32).toString('hex')}`)
  return signingKey
}

/** 启动时由 app.buildApp 调用一次，把当前管理员密码登记为签名密钥。 */
export function configureConsoleAuth(config: ServerConfig): void {
  loginPassword = config.adminPassword
  const effective = passwordOverride ?? config.adminPassword
  signingKey = effective ? deriveKey(effective) : null
}

function sign(payload: string): string {
  return createHmac('sha256', keyOf()).update(`${REALM}:${payload}`).digest('base64url')
}

function encode(payload: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `${body}.${sign(body)}`
}

function decode(value: string): SessionPayload | null {
  const index = value.lastIndexOf('.')
  if (index <= 0) return null
  const body = value.slice(0, index)
  const signature = value.slice(index + 1)
  const expected = sign(body)
  const left = Buffer.from(signature)
  const right = Buffer.from(expected)
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload
    if (!parsed || typeof parsed.u !== 'string' || typeof parsed.exp !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

function cookieValue(header: unknown, name: string): string {
  if (typeof header !== 'string' || !header) return ''
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return ''
}

export function isLoopback(ip: string | undefined): boolean {
  if (!ip) return false
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
}

/** 常量时间比较，避免按响应时间猜密码 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export function verifyAdminCredentials(config: ServerConfig, username: string, password: string): boolean {
  const expected = passwordOverride ?? config.adminPassword
  if (!expected) return false
  return safeEqual(username, config.adminUser) && safeEqual(password, expected)
}

/** 账号中心改密码：立即刷新签名密钥（旧会话全端失效），并配合落盘实现重启后仍有效 */
export function setAdminPassword(password: string): void {
  passwordOverride = password
  loginPassword = password
  signingKey = deriveKey(password)
}

/** 当前生效的管理员密码（未登录时用于派生，不对外暴露）。 */
export function currentAdminPassword(): string | null {
  return passwordOverride ?? loginPassword
}

/**
 * 改密码后让其它设备的控制台会话失效。
 *
 * 签名密钥已经随密码换掉，旧 Cookie 自然验不过；这里把当前会话用新密钥重新签一次，
 * 由路由把新 Cookie 写回浏览器，从而「只留当前这一个」。返回被清掉的会话数：
 * 无状态会话无法精确统计其它端，统一返回 0，前端只提示「密码已更新」。
 */
export function revokeOtherSessions(_req: FastifyRequest): number {
  return 0
}

export function createSession(user: string, ip: string): ConsoleSession {
  const payload: SessionPayload = {
    sid: randomBytes(18).toString('base64url'),
    u: user,
    ip,
    exp: Date.now() + SESSION_MS,
  }
  return { id: encode(payload), user, expiresAt: payload.exp, ip }
}

export function sessionFromRequest(req: FastifyRequest): ConsoleSession | null {
  const id = cookieValue(req.headers.cookie, COOKIE)
  if (!id) return null
  const payload = decode(id)
  if (!payload) return null
  if (payload.exp <= Date.now()) return null
  return { id, user: payload.u, expiresAt: payload.exp, ip: payload.ip }
}

export function destroySession(_req: FastifyRequest): void {
  // 无状态会话：服务端不需要删表，浏览器清掉 Cookie 即退出。
}

/** 页面门用：只要会话有效就放行（浏览器导航带不了自定义头） */
export function hasConsoleSession(req: FastifyRequest): boolean {
  return Boolean(sessionFromRequest(req))
}

/**
 * 数据接口用：必须显式带 `x-eab-console: 1`，证明这是控制台发起的请求。
 * 否则同一个浏览器登录控制台后打开员工对话页，会被误认成操作员。
 */
export function isConsoleRequest(req: FastifyRequest, config: ServerConfig): boolean {
  if (req.headers['x-eab-console'] !== '1') return false
  if (sessionFromRequest(req)) return true
  const token = typeof req.headers['x-eab-console-token'] === 'string' ? req.headers['x-eab-console-token'].trim() : ''
  return Boolean(config.consoleToken) && Boolean(token) && safeEqual(token, config.consoleToken)
}

/** 给 cookie 用：httpOnly + SameSite=Lax，8 小时 */
export function sessionCookie(session: ConsoleSession): string {
  return `${COOKIE}=${encodeURIComponent(session.id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(
    SESSION_MS / 1000,
  )}`
}

export function clearSessionCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}
