/**
 * 审计流：append-only + 哈希链。
 *
 * 为什么要哈希链：审计的价值在于"能取证"。如果只有一张普通表，DBA 或运维
 * 改一行就能抹掉痕迹；哈希链让任何一行被改动都能在 `verifyAuditChain` 里暴露。
 * 数据库层另有 trigger 直接禁止 UPDATE/DELETE（见 0001_init.sql）。
 */
import { createHash } from 'node:crypto'
import { EC, EabError, ulid } from '@eab/domain'
import type { Db } from './db.js'

const GENESIS_HASH = 'EAB-GENESIS'

export type AuditResult = 'allow' | 'deny' | 'success' | 'failure'

export interface AuditEntry {
  readonly companyId: string
  readonly actorUserId?: string | null
  readonly action: string
  readonly resourceType?: string | null
  readonly resourceId?: string | null
  readonly resourceScope?: string | null
  readonly result: AuditResult
  /** 结构化上下文（脱敏后），会以规范化 JSON 存储并参与哈希 */
  readonly detail?: unknown
  readonly traceId?: string | null
  readonly ip?: string | null
  readonly channel?: string | null
}

export interface AuditRecord {
  readonly id: string
  readonly seq: number
  readonly hash: string
}

interface AuditRow {
  id: string
  seq: number
  company_id: string
  actor_user_id: string | null
  action: string
  resource_type: string | null
  resource_id: string | null
  resource_scope: string | null
  result: string
  detail_json: string | null
  trace_id: string | null
  ip: string | null
  channel: string | null
  prev_hash: string
  hash: string
  created_at: number
}

/** 规范化 JSON：键排序 + 数组保序，保证跨进程/跨平台算出的哈希一致 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    return `{${parts.join(',')}}`
  }
  return 'null'
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

interface HashPayload {
  readonly id: string
  readonly seq: number
  readonly companyId: string
  readonly actorUserId: string | null
  readonly action: string
  readonly resourceType: string | null
  readonly resourceId: string | null
  readonly resourceScope: string | null
  readonly result: string
  readonly detailJson: string | null
  readonly traceId: string | null
  readonly ip: string | null
  readonly channel: string | null
  readonly createdAt: number
}

function computeHash(prevHash: string, payload: HashPayload): string {
  return sha256Hex(`${prevHash}|${canonicalJson(payload)}`)
}

export function appendAudit(db: Db, entry: AuditEntry, now: number = Date.now()): AuditRecord {
  const last = db
    .prepare('SELECT seq, hash FROM audit_logs ORDER BY seq DESC LIMIT 1')
    .get() as { seq: number; hash: string } | undefined

  const seq = last === undefined ? 1 : Number(last.seq) + 1
  const prevHash = last === undefined ? GENESIS_HASH : last.hash
  const id = ulid(now)
  const detailJson = entry.detail === undefined ? null : canonicalJson(entry.detail)

  const payload: HashPayload = {
    id,
    seq,
    companyId: entry.companyId,
    actorUserId: entry.actorUserId ?? null,
    action: entry.action,
    resourceType: entry.resourceType ?? null,
    resourceId: entry.resourceId ?? null,
    resourceScope: entry.resourceScope ?? null,
    result: entry.result,
    detailJson,
    traceId: entry.traceId ?? null,
    ip: entry.ip ?? null,
    channel: entry.channel ?? null,
    createdAt: now,
  }
  const hash = computeHash(prevHash, payload)

  db.prepare(
    `INSERT INTO audit_logs (
       id, seq, company_id, actor_user_id, action, resource_type, resource_id, resource_scope,
       result, detail_json, trace_id, ip, channel, prev_hash, hash, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    seq,
    payload.companyId,
    payload.actorUserId,
    payload.action,
    payload.resourceType,
    payload.resourceId,
    payload.resourceScope,
    payload.result,
    payload.detailJson,
    payload.traceId,
    payload.ip,
    payload.channel,
    prevHash,
    hash,
    payload.createdAt,
  )

  return { id, seq, hash }
}

export interface AuditVerifyResult {
  readonly ok: boolean
  readonly checked: number
  /** 第一处不一致的 seq（不存在则为 null） */
  readonly brokenAt: number | null
  readonly reasons: readonly string[]
}

/** 全量校验哈希链。发现不一致只报告，不修改任何数据 */
export function verifyAuditChain(db: Db): AuditVerifyResult {
  const rows = db
    .prepare('SELECT * FROM audit_logs ORDER BY seq ASC')
    .all() as unknown as AuditRow[]

  const reasons: string[] = []
  let expectedPrev = GENESIS_HASH
  let brokenAt: number | null = null
  let expectedSeq = 1

  for (const row of rows) {
    if (row.seq !== expectedSeq) {
      reasons.push(`seq 断裂：期望 ${expectedSeq}，实际 ${row.seq}`)
      if (brokenAt === null) brokenAt = row.seq
    }
    if (row.prev_hash !== expectedPrev) {
      reasons.push(`seq ${row.seq} 的 prev_hash 不匹配`)
      if (brokenAt === null) brokenAt = row.seq
    }
    const payload: HashPayload = {
      id: row.id,
      seq: row.seq,
      companyId: row.company_id,
      actorUserId: row.actor_user_id,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      resourceScope: row.resource_scope,
      result: row.result,
      detailJson: row.detail_json,
      traceId: row.trace_id,
      ip: row.ip,
      channel: row.channel,
      createdAt: row.created_at,
    }
    const recomputed = computeHash(row.prev_hash, payload)
    if (recomputed !== row.hash) {
      reasons.push(`seq ${row.seq} 的 hash 不匹配（内容被改动）`)
      if (brokenAt === null) brokenAt = row.seq
    }
    expectedPrev = row.hash
    expectedSeq = row.seq + 1
  }

  return { ok: reasons.length === 0, checked: rows.length, brokenAt, reasons }
}

export function auditError(message: string, details?: unknown): EabError {
  return new EabError(EC.INTERNAL, message, { details })
}
