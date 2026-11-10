/**
 * 员工会话（浏览器 Cookie → users.id）。
 *
 * 与控制台会话完全分开：控制台用 `eab_console` + `x-eab-console: 1`，
 * 员工用 `eab_session`。同一浏览器同时登录两边也不会串身份。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import type { Db } from '@eab/storage'

export const SESSION_COOKIE = 'eab_session'
const SESSION_DAYS = 7

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

function parseCookie(req: FastifyRequest, name: string): string | null {
  const raw = req.headers.cookie
  if (!raw) return null
  for (const part of raw.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    const key = part.slice(0, index).trim()
    if (key === name) return decodeURIComponent(part.slice(index + 1).trim())
  }
  return null
}

/** 创建会话，返回可以直接写进 Set-Cookie 的值（不含属性） */
export function createEmployeeSession(
  db: Db,
  userId: string,
  req: FastifyRequest,
): { cookie: string; expiresAt: number } {
  const sessionId = `sess_${randomUUID()}`
  const secret = randomBytes(32).toString('base64url')
  const now = Date.now()
  const expiresAt = now + SESSION_DAYS * 24 * 60 * 60 * 1000
  db.prepare(
    `INSERT INTO sessions (id, user_id, refresh_hash, device_fingerprint, user_agent, last_ip, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    userId,
    sha256(secret),
    null,
    String(req.headers['user-agent'] ?? '').slice(0, 200),
    req.ip ?? null,
    now,
    now,
  )
  return { cookie: `${sessionId}.${secret}`, expiresAt }
}

/** 校验 Cookie，返回仍然有效的 userId；失效/过期/被吊销返回 null */
export function readSessionUserId(db: Db, req: FastifyRequest): string | null {
  const token = parseCookie(req, SESSION_COOKIE)
  if (!token) return null
  const index = token.indexOf('.')
  if (index <= 0) return null
  const sessionId = token.slice(0, index)
  const secret = token.slice(index + 1)
  if (!sessionId || !secret) return null

  const row = db
    .prepare(
      `SELECT s.id, s.user_id, s.refresh_hash, s.created_at, s.last_seen_at, s.revoked_at,
              u.status, u.disabled_at, u.deleted_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.id = ?`,
    )
    .get(sessionId) as
    | {
        id: string
        user_id: string
        refresh_hash: string
        created_at: number
        last_seen_at: number
        revoked_at: number | null
        status: string
        disabled_at: number | null
        deleted_at: number | null
      }
    | undefined
  if (!row) return null
  if (row.revoked_at !== null) return null
  if (row.deleted_at !== null || row.disabled_at !== null || row.status !== 'active') return null
  if (Date.now() - row.created_at > SESSION_DAYS * 24 * 60 * 60 * 1000) return null
  if (row.refresh_hash !== sha256(secret)) return null

  if (Date.now() - row.last_seen_at > 60_000) {
    db.prepare('UPDATE sessions SET last_seen_at = ?, last_ip = ? WHERE id = ?').run(
      Date.now(),
      req.ip ?? null,
      sessionId,
    )
  }
  return row.user_id
}

/** 退出：吊销当前 Cookie 对应的会话 */
export function revokeCurrentSession(db: Db, req: FastifyRequest): void {
  const token = parseCookie(req, SESSION_COOKIE)
  if (!token) return
  const sessionId = token.split('.')[0]
  if (!sessionId) return
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(
    Date.now(),
    sessionId,
  )
}

/** 账号被停用/删除/离职时，立即吊销其全部会话（ORG-05） */
export function revokeAllSessions(db: Db, userId: string): number {
  const result = db
    .prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
    .run(Date.now(), userId)
  return Number(result.changes)
}
