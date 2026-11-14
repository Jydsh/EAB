/**
 * 审计流：append-only + 哈希链。
 *
 * 为什么要哈希链：审计的价值在于"能取证"。如果只有一张普通表，DBA 或运维
 * 改一行就能抹掉痕迹；哈希链让任何一行被改动都能在 `verifyAuditChain` 里暴露。
 * 数据库层另有 trigger 直接禁止 UPDATE/DELETE（见 0001_init.sql）。
 */
import { createHash } from 'node:crypto'
import { EC, EabError, ulid } from '@eab/domain'
import { withTransaction, type Db } from './db.js'

const GENESIS_HASH = 'EAB-GENESIS'
const PRUNE_SEQ_KEY = 'audit.prunedThroughSeq'
const PRUNE_HASH_KEY = 'audit.pruneAnchorHash'

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

/**
 * 可选审计镜像（例如 PostgreSQL 旁路）。
 * 主路径仍写 SQLite；镜像只入队，失败不能反向影响主审计。
 */
export interface AuditMirrorRecord extends AuditRecord {
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
  readonly prevHash: string
  readonly createdAt: number
}

export interface AuditMirror {
  append(record: AuditMirrorRecord): void
}

let auditMirror: AuditMirror | null = null

export function setAuditMirror(mirror: AuditMirror | null): void {
  auditMirror = mirror
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

interface AuditPruneAnchor {
  readonly seq: number
  readonly hash: string
}

/**
 * 清理旧审计时，被删段的最后一行会变成新的校验起点。
 * 锚点存在 system_meta，避免把「正常剪枝」和「有人偷偷删了开头一段」混为一谈。
 */
function readPruneAnchor(db: Db): AuditPruneAnchor | null {
  const rows = db
    .prepare('SELECT key, value FROM system_meta WHERE key IN (?, ?)')
    .all(PRUNE_SEQ_KEY, PRUNE_HASH_KEY) as unknown as Array<{ key: string; value: string }>
  let seq: number | null = null
  let hash: string | null = null
  for (const row of rows) {
    if (row.key === PRUNE_SEQ_KEY) {
      const value = Number(row.value)
      if (Number.isInteger(value) && value >= 0) seq = value
    }
    if (row.key === PRUNE_HASH_KEY && row.value) hash = row.value
  }
  return seq === null || hash === null ? null : { seq, hash }
}

const AUDIT_TRIGGER_SQL = [
  `CREATE TRIGGER IF NOT EXISTS trg_audit_no_update
   BEFORE UPDATE ON audit_logs
   BEGIN
     SELECT RAISE(ABORT, 'audit_logs is append-only');
   END;`,
  `CREATE TRIGGER IF NOT EXISTS trg_audit_no_delete
   BEFORE DELETE ON audit_logs
   BEGIN
     SELECT RAISE(ABORT, 'audit_logs is append-only');
   END;`,
]

export function appendAudit(db: Db, entry: AuditEntry, now: number = Date.now()): AuditRecord {
  const last = db
    .prepare('SELECT seq, hash FROM audit_logs ORDER BY seq DESC LIMIT 1')
    .get() as { seq: number; hash: string } | undefined

  const anchor = last === undefined ? readPruneAnchor(db) : null
  const seq = last === undefined ? (anchor?.seq ?? 0) + 1 : Number(last.seq) + 1
  const prevHash = last === undefined ? (anchor?.hash ?? GENESIS_HASH) : last.hash
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

  try {
    auditMirror?.append({
      id,
      seq,
      companyId: payload.companyId,
      actorUserId: payload.actorUserId,
      action: payload.action,
      resourceType: payload.resourceType,
      resourceId: payload.resourceId,
      resourceScope: payload.resourceScope,
      result: payload.result,
      detailJson: payload.detailJson,
      traceId: payload.traceId,
      ip: payload.ip,
      channel: payload.channel,
      prevHash,
      hash,
      createdAt: payload.createdAt,
    })
  } catch {
    // 镜像失败不能影响已提交的 SQLite 审计主路径。
  }

  return { id, seq, hash }
}

export interface AuditVerifyResult {
  readonly ok: boolean
  readonly checked: number
  /** 第一处不一致的 seq（不存在则为 null） */
  readonly brokenAt: number | null
  readonly reasons: readonly string[]
  /** 自动清理的剪枝锚点 seq（没有剪枝则为 0） */
  readonly pruned: number
  /** 当前链的第一条 seq；没有记录时为 null */
  readonly startSeq: number | null
}

/** 全量校验哈希链。发现不一致只报告，不修改任何数据 */
export function verifyAuditChain(db: Db): AuditVerifyResult {
  const anchor = readPruneAnchor(db)
  const rows = db
    .prepare('SELECT * FROM audit_logs ORDER BY seq ASC')
    .all() as unknown as AuditRow[]

  const reasons: string[] = []
  let expectedPrev = anchor?.hash ?? GENESIS_HASH
  let brokenAt: number | null = null
  let expectedSeq = anchor === null ? 1 : anchor.seq + 1

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

  return {
    ok: reasons.length === 0,
    checked: rows.length,
    brokenAt,
    reasons,
    pruned: anchor?.seq ?? 0,
    startSeq: rows[0]?.seq ?? null,
  }
}

export interface AuditPruneResult {
  readonly days: number
  readonly cutoff: string | null
  readonly deleted: number
  readonly remaining: number
  readonly anchorSeq: number | null
  readonly anchorHash: string | null
  readonly skipped: boolean
}

const DAY_MS = 86_400_000

/**
 * 按天数清理审计：只从最老一端删除连续的一段，并把被删段最后一行的哈希
 * 记成新锚点。后续 `verifyAuditChain` 从锚点接着校验，因此不会误报断链；
 * 新记录也会从锚点后面继续编号，不会退回 seq=1。
 */
export function pruneAuditLogs(db: Db, days: number, now: number = Date.now()): AuditPruneResult {
  const keptDays = Number.isFinite(days) && days > 0 ? Math.trunc(days) : 0
  if (keptDays <= 0) {
    return { days: keptDays, cutoff: null, deleted: 0, remaining: 0, anchorSeq: null, anchorHash: null, skipped: true }
  }

  const cutoffMs = now - keptDays * DAY_MS
  const cutoff = new Date(cutoffMs).toISOString()
  const firstKept = db
    .prepare('SELECT seq FROM audit_logs WHERE created_at >= ? ORDER BY seq ASC LIMIT 1')
    .get(cutoffMs) as { seq: number } | undefined
  const last = db
    .prepare('SELECT seq FROM audit_logs ORDER BY seq DESC LIMIT 1')
    .get() as { seq: number } | undefined
  if (last === undefined) {
    return { days: keptDays, cutoff, deleted: 0, remaining: 0, anchorSeq: null, anchorHash: null, skipped: false }
  }
  const countRows = () =>
    Number((db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get() as { n: number }).n)

  // 按 seq 切一个连续前缀；不能抽删中间行，否则后面的 prev_hash 立刻对不上。
  const deleteThrough = firstKept === undefined ? Number(last.seq) : Number(firstKept.seq) - 1
  if (deleteThrough < 1) {
    return {
      days: keptDays,
      cutoff,
      deleted: 0,
      remaining: countRows(),
      anchorSeq: null,
      anchorHash: null,
      skipped: false,
    }
  }

  const boundary = db
    .prepare('SELECT seq, hash FROM audit_logs WHERE seq = ?')
    .get(deleteThrough) as { seq: number; hash: string } | undefined
  if (boundary === undefined) {
    return {
      days: keptDays,
      cutoff,
      deleted: 0,
      remaining: countRows(),
      anchorSeq: null,
      anchorHash: null,
      skipped: false,
    }
  }

  return withTransaction(db, () => {
    // append-only 触发器必须临时摘掉；无论成功失败都恢复，避免清理把表变成可删表。
    db.exec('DROP TRIGGER IF EXISTS trg_audit_no_update')
    db.exec('DROP TRIGGER IF EXISTS trg_audit_no_delete')
    try {
      const result = db.prepare('DELETE FROM audit_logs WHERE seq <= ?').run(deleteThrough)
      const deleted = Number(result.changes)
      db.prepare(
        `INSERT INTO system_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(PRUNE_SEQ_KEY, String(boundary.seq))
      db.prepare(
        `INSERT INTO system_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(PRUNE_HASH_KEY, boundary.hash)
      const remaining = countRows()
      return {
        days: keptDays,
        cutoff,
        deleted,
        remaining,
        anchorSeq: boundary.seq,
        anchorHash: boundary.hash,
        skipped: false,
      }
    } finally {
      for (const sql of AUDIT_TRIGGER_SQL) db.exec(sql)
    }
  })
}

export function auditError(message: string, details?: unknown): EabError {
  return new EabError(EC.INTERNAL, message, { details })
}
