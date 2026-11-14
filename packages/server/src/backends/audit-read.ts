/**
 * 审计只读仓储插件。
 *
 * 这是 PostgreSQL 主库改造的第一条垂直切片：把「审计列表/导出」从同步
 * `db.prepare()` 调用抽成异步数据源，SQLite 是默认实现，PG 审计镜像可选。
 * 写路径、哈希链校验和其余业务表仍走 SQLite，本文件不改变默认行为。
 */
import type { Db } from '@eab/storage'
import type { AuditListQuery, PostgresAuditMirror } from './postgres.js'

export type AuditReadSourceId = 'sqlite' | 'postgres'

export interface AuditReadPage {
  readonly total: number
  readonly rows: readonly Record<string, unknown>[]
  readonly source: AuditReadSourceId
  readonly fallbackReason?: string
}

export interface AuditReadExport {
  readonly rows: readonly Record<string, unknown>[]
  readonly source: AuditReadSourceId
  readonly fallbackReason?: string
}

export interface AuditReadSource {
  readonly id: AuditReadSourceId
  list(query: AuditListQuery): Promise<AuditReadPage>
  export(companyId: string): Promise<AuditReadExport>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** SQLite 默认实现：保持原来列表/导出的 SQL 与字段，只把返回值包成 Promise。 */
export class SqliteAuditReadSource implements AuditReadSource {
  readonly id = 'sqlite' as const

  constructor(private readonly db: Db) {}

  async list(query: AuditListQuery): Promise<AuditReadPage> {
    const where: string[] = ['company_id = ?']
    const args: Array<string | number> = [query.companyId]
    if (query.action) {
      where.push('action LIKE ?')
      args.push(`%${query.action}%`)
    }
    if (query.actor) {
      where.push('actor_user_id = ?')
      args.push(query.actor)
    }
    if (query.result) {
      where.push('result = ?')
      args.push(query.result)
    }
    if (query.from !== undefined) {
      where.push('created_at >= ?')
      args.push(query.from)
    }
    if (query.to !== undefined) {
      where.push('created_at <= ?')
      args.push(query.to)
    }
    const total = Number(
      (this.db.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE ${where.join(' AND ')}`).get(...args) as { n: number }).n,
    )
    const rows = this.db
      .prepare(
        `SELECT id, seq, actor_user_id, action, resource_type, resource_id, result, detail_json, trace_id, ip, channel, hash, created_at
           FROM audit_logs WHERE ${where.join(' AND ')} ORDER BY seq DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, query.limit, query.offset) as unknown as Array<Record<string, unknown>>
    return { total, rows, source: this.id }
  }

  async export(companyId: string): Promise<AuditReadExport> {
    const rows = this.db
      .prepare(
        `SELECT seq, actor_user_id, action, resource_type, resource_id, result, trace_id, ip, channel, hash, created_at
           FROM audit_logs WHERE company_id = ? ORDER BY seq ASC LIMIT 100000`,
      )
      .all(companyId) as unknown as Array<Record<string, unknown>>
    return { rows, source: this.id }
  }
}

/** PostgreSQL 审计镜像实现；只读镜像表，不参与主审计事务。 */
export class PostgresAuditReadSource implements AuditReadSource {
  readonly id = 'postgres' as const

  constructor(private readonly mirror: PostgresAuditMirror) {}

  async list(query: AuditListQuery): Promise<AuditReadPage> {
    const page = await this.mirror.listAudit(query)
    return { total: page.total, rows: page.rows, source: this.id }
  }

  async export(companyId: string): Promise<AuditReadExport> {
    return { rows: await this.mirror.exportAudit(companyId), source: this.id }
  }
}

/**
 * 主读源失败时回退 SQLite。
 *
 * - 显式 `postgres` 但 PG 没接上：第一次请求就带 fallbackReason；
 * - PG 查询中途失败：本次请求回退并带原因，下一次仍会先尝试 PG；
 * - 默认 `sqlite`：根本不构造 PG 主读源，行为与改造前一致。
 */
export class FallbackAuditReadSource implements AuditReadSource {
  readonly id: 'sqlite' | 'postgres'

  constructor(
    private readonly primary: AuditReadSource | null,
    private readonly fallback: AuditReadSource,
    private readonly initialReason = '',
  ) {
    this.id = primary?.id ?? fallback.id
  }

  private async run<T extends AuditReadPage | AuditReadExport>(
    action: (source: AuditReadSource) => Promise<T>,
  ): Promise<T> {
    if (this.primary) {
      try {
        return await action(this.primary)
      } catch (error) {
        const page = await action(this.fallback)
        return { ...page, fallbackReason: `PG 审计读取失败，已回退 SQLite：${errorMessage(error)}` }
      }
    }
    const page = await action(this.fallback)
    return this.initialReason ? { ...page, fallbackReason: this.initialReason } : page
  }

  list(query: AuditListQuery): Promise<AuditReadPage> {
    return this.run((source) => source.list(query))
  }

  export(companyId: string): Promise<AuditReadExport> {
    return this.run((source) => source.export(companyId))
  }
}

/** 按 `EAB_AUDIT_READ` 装配；默认 sqlite，PG 可选，失败回退。 */
export function createAuditReader(
  db: Db,
  mode: 'sqlite' | 'postgres' | 'auto',
  postgres?: PostgresAuditMirror,
): AuditReadSource {
  const sqlite = new SqliteAuditReadSource(db)
  if (mode === 'sqlite') return sqlite
  if (!postgres) {
    return mode === 'postgres'
      ? new FallbackAuditReadSource(null, sqlite, 'PostgreSQL 审计镜像未接入，已使用 SQLite')
      : sqlite
  }
  return new FallbackAuditReadSource(new PostgresAuditReadSource(postgres), sqlite)
}
