/**
 * 工具外部副作用的幂等记录。
 *
 * 设计目标：
 * - 同一次 Agent 回合里，模型重复发出同一个工具调用时，只真正执行一次；
 * - 调用方显式传 idempotencyKey 时，同键重复调用直接返回首次结果；
 * - 执行失败允许重试，不会把失败状态当成已成功缓存；
 * - 记录只落在 SQLite，不依赖外部服务；跨进程部署由 P0-4 的单写进程约束兜底。
 */
import { createHash } from 'node:crypto'
import type { Db } from '@eab/storage'
import { ulid } from '@eab/domain'

/** 成功结果保留 24 小时；同一幂等键在窗口内复用。 */
export const TOOL_OPERATION_RESULT_TTL_MS = 24 * 60 * 60 * 1000
/** running 状态超过 5 分钟视为执行进程已崩溃，允许重新执行。 */
export const TOOL_OPERATION_RUNNING_TTL_MS = 5 * 60 * 1000

interface ToolOperationRow {
  id: string
  company_id: string
  user_id: string
  tool_id: string
  idempotency_key: string
  status: string
  result_json: string | null
  error_message: string | null
  created_at: number
  updated_at: number
  expires_at: number
}

export type ToolOperationStart =
  | { kind: 'execute'; id: string }
  | { kind: 'replay'; result: unknown }
  | { kind: 'busy'; retryAfterMs: number }

export interface BeginToolOperationInput {
  readonly db: Db
  readonly companyId: string
  readonly userId: string
  readonly toolId: string
  readonly key: string
  readonly now?: number
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, stableValue(record[key])]),
    )
  }
  return value
}

/** 将参数稳定序列化后取哈希；只用于生成键，不把明文参数写进幂等表。 */
export function hashToolArgs(args: Record<string, unknown>): string {
  const text = JSON.stringify(stableValue(args)) ?? '{}'
  return createHash('sha256').update(text).digest('hex')
}

/**
 * 计算一次工具调用的幂等键。
 *
 * - 调用方显式给了 key：原样使用，跨回合也去重；
 * - 只给了 turnId：同一回合内按「工具 + 参数」去重，用户下一轮再发一次仍会执行；
 * - 两者都没有：不启用幂等，避免把两个不同请求误判成重复。
 */
export function resolveToolOperationKey(input: {
  readonly toolId: string
  readonly args: Record<string, unknown>
  readonly turnId?: string
  readonly idempotencyKey?: string
}): string | null {
  const explicit = input.idempotencyKey?.trim()
  if (explicit) return explicit
  const turnId = input.turnId?.trim()
  if (!turnId) return null
  return `turn:${turnId}:${input.toolId}:${hashToolArgs(input.args)}`
}

function readRow(
  db: Db,
  companyId: string,
  userId: string,
  toolId: string,
  key: string,
): ToolOperationRow | undefined {
  return db
    .prepare(
      `SELECT id, company_id, user_id, tool_id, idempotency_key, status, result_json, error_message,
              created_at, updated_at, expires_at
         FROM tool_operations
        WHERE company_id = ? AND user_id = ? AND tool_id = ? AND idempotency_key = ?`,
    )
    .get(companyId, userId, toolId, key) as ToolOperationRow | undefined
}

function parseResult(row: ToolOperationRow): unknown {
  if (!row.result_json) return null
  try {
    return JSON.parse(row.result_json) as unknown
  } catch {
    return null
  }
}

function decideExisting(row: ToolOperationRow, now: number): ToolOperationStart {
  if (row.status === 'succeeded' && row.expires_at > now) {
    return { kind: 'replay', result: parseResult(row) }
  }
  if (row.status === 'running') {
    const staleAt = row.updated_at + TOOL_OPERATION_RUNNING_TTL_MS
    if (staleAt > now) {
      return { kind: 'busy', retryAfterMs: Math.max(1, staleAt - now) }
    }
  }
  return { kind: 'execute', id: row.id }
}

function markRunning(db: Db, id: string, now: number): void {
  db.prepare(
    `UPDATE tool_operations
        SET status = 'running',
            result_json = NULL,
            error_message = NULL,
            updated_at = ?,
            expires_at = ?
      WHERE id = ?`,
  ).run(now, now + TOOL_OPERATION_RUNNING_TTL_MS, id)
}

/** 占用一个幂等键；成功占用返回 execute，已成功返回 replay，正在执行返回 busy。 */
export function beginToolOperation(input: BeginToolOperationInput): ToolOperationStart {
  const now = input.now ?? Date.now()
  const existing = readRow(input.db, input.companyId, input.userId, input.toolId, input.key)
  if (existing) {
    const decision = decideExisting(existing, now)
    if (decision.kind === 'execute') markRunning(input.db, existing.id, now)
    return decision
  }

  const id = ulid()
  try {
    input.db
      .prepare(
        `INSERT INTO tool_operations
           (id, company_id, user_id, tool_id, idempotency_key, status, result_json, error_message, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, 'running', NULL, NULL, ?, ?, ?)`,
      )
      .run(id, input.companyId, input.userId, input.toolId, input.key, now, now, now + TOOL_OPERATION_RUNNING_TTL_MS)
    return { kind: 'execute', id }
  } catch (error) {
    // 唯一索引冲突说明另一个请求刚刚插入；按已有记录重新判断。
    const raced = readRow(input.db, input.companyId, input.userId, input.toolId, input.key)
    if (!raced) throw error
    const decision = decideExisting(raced, now)
    if (decision.kind === 'execute') markRunning(input.db, raced.id, now)
    return decision
  }
}

/** 成功：缓存结果，后续同键直接返回。 */
export function completeToolOperation(db: Db, id: string, result: unknown, now = Date.now()): void {
  let resultJson: string | null = null
  try {
    resultJson = JSON.stringify(result) ?? null
  } catch {
    resultJson = null
  }
  db.prepare(
    `UPDATE tool_operations
        SET status = 'succeeded',
            result_json = ?,
            error_message = NULL,
            updated_at = ?,
            expires_at = ?
      WHERE id = ?`,
  ).run(resultJson, now, now + TOOL_OPERATION_RESULT_TTL_MS, id)
}

/** 失败：保留记录，但下一次同键调用允许重新执行。 */
export function failToolOperation(db: Db, id: string, error: unknown, now = Date.now()): void {
  const message = error instanceof Error ? error.message : String(error)
  db.prepare(
    `UPDATE tool_operations
        SET status = 'failed',
            result_json = NULL,
            error_message = ?,
            updated_at = ?,
            expires_at = ?
      WHERE id = ?`,
  ).run(message.slice(0, 500), now, now + TOOL_OPERATION_RESULT_TTL_MS, id)
}
