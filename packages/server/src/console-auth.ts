/**
 * 控制台会话（服务器侧超级管理员账号）。
 *
 * 和员工登录完全分开：
 * - 员工：组织成员，走渠道/网页登录，只能进 `/chat`。
 * - 控制台：一个超级管理员账号（默认 `admin`），密码来自环境变量或首次启动自动生成，
 *   进去是"控制台操作员"，不属于任何公司、不继承任何角色。
 *
 * 这一版会话存在进程内存里（重启失效），够用且不需要额外表；多实例部署要换成共享会话表。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import type { ServerConfig } from './config.js'

export interface ConsoleSession {
  readonly id: string
  readonly user: string
  readonly expiresAt: number
  /** 登录时的来源地址，便于排查"谁从哪台机器进来" */
  readonly ip: string
}

const COOKIE = 'eab_console_sid'
const SESSION_MS = 8 * 60 * 60 * 1000
const sessions = new Map<string, ConsoleSession>()
/** 账号中心改过的密码：进程内生效，同时会写回 .eab-dev/admin-credentials.txt，重启后照旧读到 */
let passwordOverride: string | null = null

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

/** 账号中心改密码：运行时立即生效，配合落盘实现重启后仍有效 */
export function setAdminPassword(password: string): void {
  passwordOverride = password
}

/** 改密码后让其它设备的控制台会话失效，只留当前这一个 */
export function revokeOtherSessions(req: FastifyRequest): number {
  const current = sessionFromRequest(req)
  let removed = 0
  for (const [id, item] of sessions) {
    if (!current || item.id !== current.id) {
      sessions.delete(id)
      removed += 1
    }
  }
  return removed
}

export function createSession(user: string, ip: string): ConsoleSession {
  const session: ConsoleSession = {
    id: randomBytes(24).toString('base64url'),
    user,
    expiresAt: Date.now() + SESSION_MS,
    ip,
  }
  sessions.set(session.id, session)
  // 顺手清掉过期会话，避免进程越跑越多
  for (const [id, item] of sessions) {
    if (item.expiresAt <= Date.now()) sessions.delete(id)
  }
  return session
}

export function sessionFromRequest(req: FastifyRequest): ConsoleSession | null {
  const id = cookieValue(req.headers.cookie, COOKIE)
  if (!id) return null
  const session = sessions.get(id)
  if (!session) return null
  if (session.expiresAt <= Date.now()) {
    sessions.delete(id)
    return null
  }
  return session
}

export function destroySession(req: FastifyRequest): void {
  const id = cookieValue(req.headers.cookie, COOKIE)
  if (id) sessions.delete(id)
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
