/**
 * 成员后台会话的持久化层。
 *
 * Cookie 本身是签名的，路由层可以先验签判断“这是后台请求”；
 * 真正的身份、过期、吊销、成员是否停用，都在这里查库确认。
 */
import type { FastifyRequest } from 'fastify'
import type { Db } from '@eab/storage'
import {
  createMemberSessionToken,
  hashToken,
  memberSessionFromRequest,
  memberSessionValueFromRequest,
  type ConsoleMemberToken,
} from './console-auth.js'

export interface ConsoleMemberSession {
  readonly id: string
  readonly userId: string
  readonly companyId: string
  readonly expiresAt: number
  readonly ip: string
}

interface MemberSessionRow {
  id: string
  company_id: string
  user_id: string
  token_hash: string
  expires_at: number
  revoked_at: number | null
  status: string
  disabled_at: number | null
  deleted_at: number | null
  company_status: string
}

export function createConsoleMemberSession(
  db: Db,
  userId: string,
  companyId: string,
  req: FastifyRequest,
): { session: ConsoleMemberSession; cookie: string } {
  const token = createMemberSessionToken(userId, companyId, req.ip ?? '')
  const now = Date.now()
  db.prepare(
    `INSERT INTO console_member_sessions
       (id, company_id, user_id, token_hash, created_at, expires_at, last_seen_at, user_agent, last_ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    token.token.id,
    companyId,
    userId,
    token.tokenHash,
    now,
    token.token.expiresAt,
    now,
    String(req.headers['user-agent'] ?? '').slice(0, 300),
    req.ip ?? '',
  )
  return {
    session: {
      id: token.token.id,
      userId,
      companyId,
      expiresAt: token.token.expiresAt,
      ip: token.token.ip,
    },
    cookie: token.cookie,
  }
}

/**
 * 读取当前请求的成员后台会话。
 * 返回 null 的原因包括：没 Cookie、签名不对、DB 没记录、已吊销、成员停用/删除、公司停用。
 */
export function readConsoleMemberSession(db: Db, req: FastifyRequest): ConsoleMemberSession | null {
  const token = memberSessionFromRequest(req)
  if (!token) return null
  const raw = memberSessionValueFromRequest(req)
  if (!raw) return null
  return readConsoleMemberSessionByToken(db, token, hashToken(raw))
}

function readConsoleMemberSessionByToken(
  db: Db,
  token: ConsoleMemberToken,
  tokenHash: string,
): ConsoleMemberSession | null {
  let row: MemberSessionRow | undefined
  try {
    row = db
      .prepare(
        `SELECT s.id, s.company_id, s.user_id, s.token_hash, s.expires_at, s.revoked_at,
                u.status, u.disabled_at, u.deleted_at,
                c.status AS company_status
           FROM console_member_sessions s
           JOIN users u ON u.id = s.user_id
           JOIN companies c ON c.id = s.company_id
          WHERE s.id = ?`,
      )
      .get(token.id) as MemberSessionRow | undefined
  } catch {
    return null
  }
  if (!row) return null
  if (row.revoked_at !== null) return null
  if (row.expires_at <= Date.now()) return null
  if (row.token_hash !== tokenHash) return null
  if (row.user_id !== token.userId || row.company_id !== token.companyId) return null
  if (row.deleted_at !== null || row.disabled_at !== null) return null
  if (row.status !== 'active') return null
  if (row.company_status === 'suspended') return null

  // 每次请求都写 last_seen 太吵；一分钟一次足够排查“这条会话还活着吗”。
  const now = Date.now()
  try {
    db.prepare(
      `UPDATE console_member_sessions
          SET last_seen_at = ?
        WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)`,
    ).run(now, row.id, now - 60_000)
  } catch {
    /* 更新时间失败不影响身份判断 */
  }

  return {
    id: row.id,
    userId: row.user_id,
    companyId: row.company_id,
    expiresAt: row.expires_at,
    ip: token.ip,
  }
}

export function revokeConsoleMemberSession(db: Db, sessionId: string): void {
  db.prepare('UPDATE console_member_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(
    Date.now(),
    sessionId,
  )
}

export function revokeConsoleMemberSessionsForUser(db: Db, companyId: string, userId: string): void {
  db.prepare(
    'UPDATE console_member_sessions SET revoked_at = ? WHERE company_id = ? AND user_id = ? AND revoked_at IS NULL',
  ).run(Date.now(), companyId, userId)
}
