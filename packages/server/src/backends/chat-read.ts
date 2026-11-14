/**
 * 会话列表只读仓储插件（PostgreSQL 主库改造的第二条垂直切片）。
 *
 * 默认 SQLite 实现保持原查询；`EAB_CHAT_READ=postgres|auto` 时读 PG 会话镜像。
 * PG 镜像未追平（outbox 还有待同步会话）时不读 PG，本次直接回退 SQLite，
 * 避免员工刚建会话却在列表里看不到。失败原因随响应返回，便于控制台/日志定位。
 */
import type { Db } from '@eab/storage'
import type { PostgresChatMirror } from './postgres-chat.js'

export type ChatReadSourceId = 'sqlite' | 'postgres'

export interface ChatSessionListQuery {
  readonly companyId: string
  readonly userId: string
  readonly limit: number
}

export interface ChatSessionListPage {
  readonly sessions: readonly Record<string, unknown>[]
  readonly source: ChatReadSourceId
  readonly fallbackReason?: string
}

export interface ChatReadSource {
  readonly id: ChatReadSourceId
  list(query: ChatSessionListQuery): Promise<ChatSessionListPage>
  /** PG 源实现：outbox 未追平数量；SQLite 源没有这个概念。 */
  pendingCount?(): number
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 默认实现：与改造前 `/api/chat/sessions` 完全相同的 SQL 和字段。 */
export class SqliteChatReadSource implements ChatReadSource {
  readonly id = 'sqlite' as const

  constructor(private readonly db: Db) {}

  async list(query: ChatSessionListQuery): Promise<ChatSessionListPage> {
    const rows = this.db
      .prepare(
        `SELECT id, title, source, created_at, updated_at, last_message_at, last_read_at,
                EXISTS(
                  SELECT 1 FROM chat_messages m
                   WHERE m.session_id = chat_sessions.id
                     AND m.role = 'assistant'
                     AND m.created_at > COALESCE(chat_sessions.last_read_at, 0)
                ) AS unread
           FROM chat_sessions
          WHERE company_id = ? AND user_id = ? AND deleted_at IS NULL
          ORDER BY COALESCE(last_message_at, updated_at) DESC, created_at DESC LIMIT ?`,
      )
      .all(query.companyId, query.userId, query.limit) as unknown as Array<Record<string, unknown>>
    return { sessions: rows, source: this.id }
  }
}

/** PostgreSQL 实现：读镜像表，未读红点由 last_assistant_at 计算。 */
export class PostgresChatReadSource implements ChatReadSource {
  readonly id = 'postgres' as const

  constructor(private readonly mirror: PostgresChatMirror) {}

  pendingCount(): number {
    return this.mirror.pendingCount()
  }

  async list(query: ChatSessionListQuery): Promise<ChatSessionListPage> {
    return { sessions: await this.mirror.listSessions(query), source: this.id }
  }
}

/**
 * 主读源不可用/未追平时回退 SQLite：
 * - 显式 postgres 但 PG 没接上：每次请求都带原因；
 * - outbox 还有待同步：本次回退，不返回滞后的 PG 列表；
 * - PG 查询中途失败：本次回退，下一次仍会先尝试 PG。
 */
export class FallbackChatReadSource implements ChatReadSource {
  readonly id: 'sqlite' | 'postgres'

  constructor(
    private readonly primary: ChatReadSource | null,
    private readonly fallback: ChatReadSource,
    private readonly initialReason = '',
  ) {
    this.id = primary?.id ?? fallback.id
  }

  pendingCount(): number {
    return this.primary?.pendingCount?.() ?? 0
  }

  async list(query: ChatSessionListQuery): Promise<ChatSessionListPage> {
    if (this.primary) {
      const pending = this.primary.pendingCount?.() ?? 0
      if (pending > 0) {
        const page = await this.fallback.list(query)
        return {
          ...page,
          fallbackReason: `PostgreSQL 会话镜像还有 ${pending} 条待同步，本次读 SQLite`,
        }
      }
      try {
        return await this.primary.list(query)
      } catch (error) {
        const page = await this.fallback.list(query)
        return {
          ...page,
          fallbackReason: `PG 会话读取失败，已回退 SQLite：${errorMessage(error)}`,
        }
      }
    }
    const page = await this.fallback.list(query)
    return this.initialReason ? { ...page, fallbackReason: this.initialReason } : page
  }
}

/** 按 `EAB_CHAT_READ` 装配；默认 sqlite，PG 可选，失败/未追平回退。 */
export function createChatReader(
  db: Db,
  mode: 'sqlite' | 'postgres' | 'auto',
  postgres?: PostgresChatMirror,
): ChatReadSource {
  const sqlite = new SqliteChatReadSource(db)
  if (mode === 'sqlite') return sqlite
  if (!postgres) {
    return mode === 'postgres'
      ? new FallbackChatReadSource(null, sqlite, 'PostgreSQL 会话镜像未接入，已使用 SQLite')
      : sqlite
  }
  return new FallbackChatReadSource(new PostgresChatReadSource(postgres), sqlite)
}
