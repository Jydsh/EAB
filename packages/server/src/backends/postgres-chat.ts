/**
 * PostgreSQL 会话镜像插件。
 *
 * SQLite 的 `chat_sessions` 写入分散在网页、钉钉、飞书、定时任务和模型切换中，
 * 因此不在每个写入点改成异步仓储，而是在 SQLite 迁移里建 outbox 触发器：
 * - 会话增删改与主事务一起入队，回滚时 outbox 一起回滚；
 * - 本插件按 id 批量读取 outbox，把当前会话行 upsert 到 PG，成功后删 outbox；
 * - PG 不可用只影响镜像状态，不阻塞会话写入；读路径遇到未追平会回退 SQLite。
 *
 * 这是「会话域」的第一条 PG 读写分离切片，消息正文仍只写 SQLite。
 */
import type { Db } from '@eab/storage'
import type { PgQueryable } from './postgres.js'
import type { BackendStatus } from './types.js'

export interface ChatSessionListQuery {
  readonly companyId: string
  readonly userId: string
  readonly limit: number
}

export interface ChatSessionMirrorOptions {
  readonly batchSize?: number
  readonly flushIntervalMs?: number
}

const TABLE_SQL = `
CREATE TABLE IF NOT EXISTS eab_chat_sessions_mirror (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  user_id text NOT NULL,
  title text NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  last_message_at bigint,
  deleted_at bigint,
  source text,
  external_id text,
  space_kind text,
  space_id text,
  model_id text,
  reasoning_effort text,
  open_conversation_id text,
  last_read_at bigint,
  last_assistant_at bigint,
  mirrored_at timestamptz NOT NULL DEFAULT now()
)
`

const INDEX_SQL = [
  'CREATE INDEX IF NOT EXISTS idx_eab_chat_sessions_mirror_user ON eab_chat_sessions_mirror (company_id, user_id, deleted_at, last_message_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_eab_chat_sessions_mirror_updated ON eab_chat_sessions_mirror (company_id, updated_at DESC)',
]

const UPSERT_SQL = `
INSERT INTO eab_chat_sessions_mirror (
  id, company_id, user_id, title, created_at, updated_at, last_message_at, deleted_at,
  source, external_id, space_kind, space_id, model_id, reasoning_effort,
  open_conversation_id, last_read_at, last_assistant_at
) VALUES ?
ON CONFLICT (id) DO UPDATE SET
  company_id = EXCLUDED.company_id,
  user_id = EXCLUDED.user_id,
  title = EXCLUDED.title,
  created_at = EXCLUDED.created_at,
  updated_at = EXCLUDED.updated_at,
  last_message_at = EXCLUDED.last_message_at,
  deleted_at = EXCLUDED.deleted_at,
  source = EXCLUDED.source,
  external_id = EXCLUDED.external_id,
  space_kind = EXCLUDED.space_kind,
  space_id = EXCLUDED.space_id,
  model_id = EXCLUDED.model_id,
  reasoning_effort = EXCLUDED.reasoning_effort,
  open_conversation_id = EXCLUDED.open_conversation_id,
  last_read_at = EXCLUDED.last_read_at,
  last_assistant_at = EXCLUDED.last_assistant_at,
  mirrored_at = now()
`

const OUTBOX_SQL = `
SELECT o.id AS outbox_id, o.op AS outbox_op,
       s.id AS session_id, s.company_id, s.user_id, s.title, s.created_at, s.updated_at,
       s.last_message_at, s.deleted_at, s.source, s.external_id, s.space_kind, s.space_id,
       s.model_id, s.reasoning_effort, s.open_conversation_id, s.last_read_at, s.last_assistant_at
  FROM eab_pg_outbox o
  LEFT JOIN chat_sessions s ON s.id = o.entity_id
 WHERE o.entity = 'chat_sessions'
 ORDER BY o.id
 LIMIT ?
`

/** PG 每次接入都全量刷新一次会话镜像，避免上次运行已清空 outbox 后漏掉离线期间的旧会话。 */
const ENQUEUE_ALL_SQL = `
INSERT OR REPLACE INTO eab_pg_outbox (entity, entity_id, op, created_at)
SELECT 'chat_sessions', id, 'upsert', COALESCE(updated_at, created_at)
  FROM chat_sessions
`

interface OutboxRow {
  outbox_id: number
  outbox_op: string
  session_id: string | null
  company_id?: string
  user_id?: string
  title?: string
  created_at?: number
  updated_at?: number
  last_message_at?: number | null
  deleted_at?: number | null
  source?: string | null
  external_id?: string | null
  space_kind?: string | null
  space_id?: string | null
  model_id?: string | null
  reasoning_effort?: string | null
  open_conversation_id?: string | null
  last_read_at?: number | null
  last_assistant_at?: number | null
}

export class PostgresChatMirror {
  readonly id = 'postgres-chat'
  private readonly batchSize: number
  private readonly flushIntervalMs: number
  private timer: ReturnType<typeof setTimeout> | null = null
  private flushing = false
  private stopped = false
  private written = 0
  private failedFlushes = 0
  private lastError = ''

  constructor(
    private readonly db: Db,
    private readonly pg: PgQueryable,
    options: ChatSessionMirrorOptions = {},
  ) {
    this.batchSize = Math.max(1, Math.min(500, options.batchSize ?? 100))
    this.flushIntervalMs = Math.max(50, options.flushIntervalMs ?? 250)
  }

  async init(): Promise<void> {
    await this.pg.query(TABLE_SQL)
    for (const sql of INDEX_SQL) await this.pg.query(sql)
    // 升级前已有会话在迁移里全部入队；每次 PG 接入再全量刷新一次，避免离线期间漏写。
    this.db.exec(ENQUEUE_ALL_SQL)
    await this.flushAll()
    this.start()
  }

  private start(): void {
    if (this.stopped || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
        .catch(() => {
          // 定时同步失败只记状态，保留 outbox 等下一轮；不能产生未处理的 Promise rejection。
        })
        .finally(() => this.start())
    }, this.flushIntervalMs)
    this.timer.unref?.()
  }

  private valuesOf(row: OutboxRow): unknown[] {
    return [
      row.session_id,
      row.company_id,
      row.user_id,
      row.title,
      row.created_at,
      row.updated_at,
      row.last_message_at ?? null,
      row.deleted_at ?? null,
      row.source ?? null,
      row.external_id ?? null,
      row.space_kind ?? null,
      row.space_id ?? null,
      row.model_id ?? null,
      row.reasoning_effort ?? null,
      row.open_conversation_id ?? null,
      row.last_read_at ?? null,
      row.last_assistant_at ?? null,
    ]
  }

  private buildUpsert(rows: readonly OutboxRow[]): { sql: string; values: unknown[] } {
    const tuples = rows.map((_row, index) => {
      const offset = index * 17
      return `(${Array.from({ length: 17 }, (_value, column) => `$${offset + column + 1}`).join(', ')})`
    })
    return {
      sql: UPSERT_SQL.replace('VALUES ?', `VALUES ${tuples.join(', ')}`),
      values: rows.flatMap((row) => this.valuesOf(row)),
    }
  }

  /** 单轮同步一批；失败时保留 outbox，下一轮重试。 */
  async flush(): Promise<void> {
    if (this.flushing || this.stopped) return
    this.flushing = true
    try {
      const rows = this.db
        .prepare(OUTBOX_SQL)
        .all(this.batchSize) as unknown as OutboxRow[]
      if (rows.length === 0) return

      const upserts = rows.filter((row) => row.outbox_op === 'upsert' && row.session_id)
      // 会话被硬删除（或 outbox 指向的行已不存在）时，删除 PG 镜像，避免残留。
      const deletes = rows.filter((row) => row.outbox_op !== 'upsert' || !row.session_id)

      if (upserts.length > 0) {
        const payload = this.buildUpsert(upserts)
        await this.pg.query(payload.sql, payload.values)
      }
      if (deletes.length > 0) {
        await this.pg.query(
          'DELETE FROM eab_chat_sessions_mirror WHERE id = ANY($1::text[])',
          [deletes.map((row) => row.session_id ?? '')],
        )
      }

      const ids = rows.map((row) => row.outbox_id)
      this.db
        .prepare(`DELETE FROM eab_pg_outbox WHERE id IN (${ids.map(() => '?').join(', ')})`)
        .run(...ids)
      this.written += rows.length
    } catch (error) {
      this.failedFlushes += 1
      this.lastError = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      this.flushing = false
    }
  }

  /** 启动时把已有 outbox 尽量追平；单次失败不阻断启动，后续定时重试。 */
  private async flushAll(): Promise<void> {
    for (let round = 0; round < 50; round += 1) {
      try {
        await this.flush()
      } catch {
        return
      }
      if (this.pendingCount() === 0) return
    }
  }

  /** 还有多少会话变化没同步；读路径用它决定是否回退 SQLite。 */
  pendingCount(): number {
    try {
      const row = this.db
        .prepare("SELECT COUNT(*) AS n FROM eab_pg_outbox WHERE entity = 'chat_sessions'")
        .get() as { n?: unknown } | undefined
      return Number(row?.n ?? 0)
    } catch {
      return 0
    }
  }

  async listSessions(query: ChatSessionListQuery): Promise<readonly Record<string, unknown>[]> {
    const rows = await this.pg.query(
      `SELECT id, title, source, created_at, updated_at, last_message_at, last_read_at,
              CASE
                WHEN last_assistant_at IS NOT NULL
                 AND last_assistant_at > COALESCE(last_read_at, 0) THEN 1
                ELSE 0
              END AS unread
         FROM eab_chat_sessions_mirror
        WHERE company_id = $1 AND user_id = $2 AND deleted_at IS NULL
        ORDER BY COALESCE(last_message_at, updated_at) DESC, created_at DESC
        LIMIT $3`,
      [query.companyId, query.userId, query.limit],
    )
    return rows.rows as Record<string, unknown>[]
  }

  status(): BackendStatus {
    const pending = this.pendingCount()
    const degraded = this.failedFlushes > 0
    return {
      id: this.id,
      kind: 'storage',
      label: 'PostgreSQL 会话镜像',
      mode: 'external',
      state: degraded ? 'degraded' : 'ready',
      detail: degraded
        ? `会话镜像有降级：失败 ${this.failedFlushes} 次，待同步 ${pending} 条${this.lastError ? `，最近错误：${this.lastError}` : ''}`
        : `会话列表可读 PG 镜像；SQLite 仍是写权威${pending > 0 ? `，当前待同步 ${pending} 条` : ''}`,
      capabilities: ['chat-session-mirror', 'chat-session-read'],
      metrics: { written: this.written, pending, failed: this.failedFlushes },
    }
  }

  async close(): Promise<void> {
    // 先给最后一轮同步机会，再停止定时器；PG 已断开时保留 outbox 等下次启动续传。
    try {
      await this.flush()
    } catch {
      // 关闭阶段不把镜像失败升级成主流程错误。
    }
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
