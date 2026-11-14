/**
 * PostgreSQL 审计旁路。
 *
 * 这版不替换 SQLite 主库：EAB 的同步 SQL 接口遍布服务端，直接换主库需要异步仓储改造。
 * 先把「审计/事件」这类 append-only、写量大、适合批量提交的数据镜像到 PostgreSQL：
 * - SQLite 仍是事务与读取的权威源，默认部署完全不依赖 PG；
 * - PG 可用时承接审计归档/分析，给后续全量主库迁移留出同一套插件边界；
 * - PG 断开只影响镜像状态，不影响 appendAudit 主路径。
 */
import type { Db } from '@eab/storage'
import type { BackendStatus } from './types.js'

export interface AuditMirrorRecord {
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
  readonly prevHash: string
  readonly hash: string
  readonly createdAt: number
}

export interface PgQueryable {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: unknown[] }>
  end?(): Promise<void>
}

/** 审计只读查询条件；字段是控制台现有筛选器的直接映射。 */
export interface AuditListQuery {
  readonly companyId: string
  readonly action?: string
  readonly actor?: string
  readonly result?: string
  readonly from?: number
  readonly to?: number
  readonly limit: number
  readonly offset: number
}

export interface AuditListPage {
  readonly total: number
  readonly rows: readonly Record<string, unknown>[]
}

export interface PostgresAuditMirrorOptions {
  readonly batchSize?: number
  readonly flushIntervalMs?: number
  readonly maxQueue?: number
}

const TABLE_SQL = `
CREATE TABLE IF NOT EXISTS eab_audit_mirror (
  id text PRIMARY KEY,
  seq bigint NOT NULL,
  company_id text NOT NULL,
  actor_user_id text,
  action text NOT NULL,
  resource_type text,
  resource_id text,
  resource_scope text,
  result text NOT NULL,
  detail_json jsonb,
  trace_id text,
  ip text,
  channel text,
  prev_hash text NOT NULL,
  hash text NOT NULL,
  created_at bigint NOT NULL,
  mirrored_at timestamptz NOT NULL DEFAULT now()
)
`

const INSERT_SQL = `
INSERT INTO eab_audit_mirror (
  id, seq, company_id, actor_user_id, action, resource_type, resource_id, resource_scope,
  result, detail_json, trace_id, ip, channel, prev_hash, hash, created_at
) VALUES ?
ON CONFLICT (id) DO NOTHING
`

/** 控制台审计列表按公司 + seq 倒序翻页，导出按 seq 正序；先建对应索引再开放读路径。 */
const INDEX_SQL = [
  'CREATE INDEX IF NOT EXISTS idx_eab_audit_mirror_company_seq ON eab_audit_mirror (company_id, seq DESC)',
  'CREATE INDEX IF NOT EXISTS idx_eab_audit_mirror_company_created ON eab_audit_mirror (company_id, created_at DESC)',
]

export class PostgresAuditMirror {
  readonly id = 'postgres-audit'
  private readonly batchSize: number
  private readonly flushIntervalMs: number
  private readonly maxQueue: number
  private queue: AuditMirrorRecord[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private flushing = false
  private written = 0
  private failedBatches = 0
  private dropped = 0
  private lastError = ''
  private stopped = false

  constructor(
    private readonly db: PgQueryable,
    options: PostgresAuditMirrorOptions = {},
  ) {
    this.batchSize = Math.max(1, options.batchSize ?? 100)
    this.flushIntervalMs = Math.max(50, options.flushIntervalMs ?? 500)
    this.maxQueue = Math.max(this.batchSize, options.maxQueue ?? 20_000)
  }

  async init(): Promise<void> {
    await this.db.query(TABLE_SQL)
    for (const sql of INDEX_SQL) await this.db.query(sql)
  }

  /**
   * 首次接入/离线期间补齐历史审计。
   *
   * 只补 PG 里最大 seq 之后的记录：正常启动是增量；首次接入时 max=0，会把 SQLite
   * 现有审计全量灌进镜像，避免 `EAB_AUDIT_READ=postgres` 一开就是空列表。
   */
  async backfillFromSqlite(db: Db, batchSize = 500): Promise<number> {
    const maxRow = (await this.db.query(
      'SELECT COALESCE(MAX(seq), 0) AS max_seq FROM eab_audit_mirror',
    )) as { rows?: Array<{ max_seq?: unknown }> }
    let after = Number(maxRow.rows?.[0]?.max_seq ?? 0)
    if (!Number.isFinite(after)) after = 0

    let total = 0
    while (true) {
      const rows = db
        .prepare(
          `SELECT id, seq, company_id, actor_user_id, action, resource_type, resource_id,
                  resource_scope, result, detail_json, trace_id, ip, channel, prev_hash, hash, created_at
             FROM audit_logs
            WHERE seq > ?
            ORDER BY seq
            LIMIT ?`,
        )
        .all(after, batchSize) as Array<{
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
      }>
      if (rows.length === 0) break

      const records: AuditMirrorRecord[] = rows.map((row) => ({
        id: row.id,
        seq: Number(row.seq),
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
        prevHash: row.prev_hash,
        hash: row.hash,
        createdAt: Number(row.created_at),
      }))
      const payload = this.buildBatch(records)
      await this.db.query(payload.sql, payload.values)
      total += records.length
      after = records[records.length - 1]!.seq
      if (rows.length < batchSize) break
    }
    this.written += total
    return total
  }

  /** 只入队，不等待 PG；主审计写成功后调用。 */
  append(record: AuditMirrorRecord): void {
    if (this.stopped) return
    if (this.queue.length >= this.maxQueue) {
      // 队列满时丢最老的镜像，不能反向阻塞 SQLite 主审计。
      this.queue.shift()
      this.dropped += 1
    }
    this.queue.push(record)
    if (this.queue.length >= this.batchSize) void this.flush()
    else this.schedule()
  }

  private schedule(): void {
    if (this.timer || this.flushing) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, this.flushIntervalMs)
    this.timer.unref?.()
  }

  private valuesOf(record: AuditMirrorRecord): unknown[] {
    return [
      record.id,
      record.seq,
      record.companyId,
      record.actorUserId,
      record.action,
      record.resourceType,
      record.resourceId,
      record.resourceScope,
      record.result,
      record.detailJson,
      record.traceId,
      record.ip,
      record.channel,
      record.prevHash,
      record.hash,
      record.createdAt,
    ]
  }

  private buildBatch(records: readonly AuditMirrorRecord[]): { sql: string; values: unknown[] } {
    const tuples = records.map((_, index) => {
      const offset = index * 16
      return `(${Array.from({ length: 16 }, (_value, column) => `$${offset + column + 1}`).join(', ')})`
    })
    return {
      sql: INSERT_SQL.replace('VALUES ?', `VALUES ${tuples.join(', ')}`),
      values: records.flatMap((record) => this.valuesOf(record)),
    }
  }

  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return
    this.flushing = true
    try {
      while (this.queue.length > 0 && !this.stopped) {
        const batch = this.queue.splice(0, this.batchSize)
        const payload = this.buildBatch(batch)
        try {
          await this.db.query(payload.sql, payload.values)
          this.written += batch.length
        } catch (error) {
          this.failedBatches += 1
          this.lastError = error instanceof Error ? error.message : String(error)
          // 一批失败只记录，不重放；审计镜像不应制造无限重试和重复写。
        }
      }
    } finally {
      this.flushing = false
      if (this.queue.length > 0) this.schedule()
    }
  }

  private whereFor(query: AuditListQuery): { clause: string; values: unknown[] } {
    const clauses = ['company_id = $1']
    const values: unknown[] = [query.companyId]
    const add = (clause: (index: number) => string, value: unknown): void => {
      values.push(value)
      clauses.push(clause(values.length))
    }
    if (query.action) add((index) => `action LIKE $${index}`, `%${query.action}%`)
    if (query.actor) add((index) => `actor_user_id = $${index}`, query.actor)
    if (query.result) add((index) => `result = $${index}`, query.result)
    if (query.from !== undefined && Number.isFinite(query.from)) {
      add((index) => `created_at >= $${index}`, query.from)
    }
    if (query.to !== undefined && Number.isFinite(query.to)) {
      add((index) => `created_at <= $${index}`, query.to)
    }
    return { clause: clauses.join(' AND '), values }
  }

  /** 控制台审计列表的 PG 读路径；仅当显式配置 EAB_AUDIT_READ 时由路由调用。 */
  async listAudit(query: AuditListQuery): Promise<AuditListPage> {
    const { clause, values } = this.whereFor(query)
    const count = await this.db.query(
      `SELECT COUNT(*)::bigint AS n FROM eab_audit_mirror WHERE ${clause}`,
      values,
    )
    const total = Number((count.rows[0] as { n?: unknown } | undefined)?.n ?? 0)
    const limitIndex = values.length + 1
    const offsetIndex = values.length + 2
    const rows = await this.db.query(
      `SELECT id, seq, actor_user_id, action, resource_type, resource_id, result, detail_json,
              trace_id, ip, channel, hash, created_at
         FROM eab_audit_mirror WHERE ${clause}
        ORDER BY seq DESC LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
      [...values, query.limit, query.offset],
    )
    return { total, rows: rows.rows as Record<string, unknown>[] }
  }

  /** 审计导出：最多 10 万条，按 seq 正序，和 SQLite 导出保持相同字段。 */
  async exportAudit(companyId: string): Promise<readonly Record<string, unknown>[]> {
    const rows = await this.db.query(
      `SELECT seq, actor_user_id, action, resource_type, resource_id, result,
              trace_id, ip, channel, hash, created_at
         FROM eab_audit_mirror WHERE company_id = $1
        ORDER BY seq ASC LIMIT 100000`,
      [companyId],
    )
    return rows.rows as Record<string, unknown>[]
  }

  status(): BackendStatus {
    const degraded = this.failedBatches > 0 || this.dropped > 0
    return {
      id: this.id,
      kind: 'storage',
      label: 'PostgreSQL 审计镜像',
      mode: 'external',
      state: degraded ? 'degraded' : 'ready',
      detail: degraded
        ? `镜像有降级：失败批次 ${this.failedBatches}，丢弃 ${this.dropped}${this.lastError ? `，最近错误：${this.lastError}` : ''}`
        : '审计写入按批镜像到 PostgreSQL；SQLite 仍是主库',
      capabilities: ['audit-mirror', 'audit-read', 'batch-write', 'analytics'],
      metrics: {
        queued: this.queue.length,
        written: this.written,
        failedBatches: this.failedBatches,
        dropped: this.dropped,
      },
    }
  }

  async close(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    while (this.flushing) await new Promise((resolve) => setTimeout(resolve, 20))
    await this.flush()
    this.stopped = true
    await this.db.end?.()
  }
}
