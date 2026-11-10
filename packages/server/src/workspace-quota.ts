/**
 * 个人工作区配额策略。
 *
 * 生效顺序：用户单独配置 > 角色配置（多角色取较大值）> 默认值。
 * 容量与单文件上限一起配置；角色/用户都允许比默认更小或更大，但单文件上限不能超过容量。
 */
import type { Db } from '@eab/storage'

export const DEFAULT_USER_QUOTA = 500 * 1024 * 1024
export const DEFAULT_COMPANY_QUOTA = 20 * 1024 * 1024 * 1024
export const DEFAULT_FILE_BYTES = 50 * 1024 * 1024

export type WorkspaceQuotaSource = 'default' | 'role' | 'user'

export interface WorkspaceQuotaPolicy {
  readonly limitBytes: number
  readonly fileLimitBytes: number
}

export interface EffectiveWorkspaceQuota extends WorkspaceQuotaPolicy {
  readonly source: WorkspaceQuotaSource
  /** 命中的角色 code；用户单独配置时为空 */
  readonly roleCodes: string[]
}

export type WorkspaceCapacityLevel = 'normal' | 'notice' | 'warning' | 'critical' | 'full'

export interface WorkspaceCapacity {
  readonly usedBytes: number
  readonly limitBytes: number
  readonly remainingBytes: number
  readonly percent: number
  readonly level: WorkspaceCapacityLevel
  readonly message: string
}

/** 云空间容量预警阈值：75% 提醒、85% 警告、95% 严重、100% 已满。 */
export function workspaceCapacity(limitBytes: number, usedBytes: number): WorkspaceCapacity {
  const limit = Math.max(0, Number(limitBytes) || 0)
  const used = Math.max(0, Number(usedBytes) || 0)
  const remaining = Math.max(0, limit - used)
  const percent = limit > 0 ? Math.min(100, (used / limit) * 100) : 100
  const level: WorkspaceCapacityLevel =
    limit <= 0 || percent >= 100
      ? 'full'
      : percent >= 95
        ? 'critical'
        : percent >= 85
          ? 'warning'
          : percent >= 75
            ? 'notice'
            : 'normal'
  const usedText = formatWorkspaceSize(used)
  const limitText = formatWorkspaceSize(limit)
  const remainingText = formatWorkspaceSize(remaining)
  const percentText = `${percent.toFixed(1)}%`
  const message =
    level === 'full'
      ? `个人云空间已满：已用 ${usedText} / ${limitText}。请清理文件或联系管理员扩容。`
      : level === 'critical'
        ? `个人云空间即将用完：已用 ${percentText}，剩余 ${remainingText}。再上传较大文件可能失败。`
        : level === 'warning'
          ? `个人云空间快满了：已用 ${percentText}，剩余 ${remainingText}。建议清理文件或联系管理员扩容。`
          : level === 'notice'
            ? `个人云空间已用 ${percentText}，剩余 ${remainingText}。建议留意大文件。`
            : `个人云空间剩余 ${remainingText}（已用 ${percentText}）。`
  return { usedBytes: used, limitBytes: limit, remainingBytes: remaining, percent, level, message }
}

export function formatWorkspaceSize(bytes: number): string {
  const value = Math.max(0, Number(bytes) || 0)
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`
  if (value >= 1024 * 1024) return `${Math.round(value / 1024 / 1024)} MB`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${Math.round(value)} B`
}

interface PolicyRow {
  limit_bytes: number
  file_limit_bytes: number
}

export function readWorkspaceQuotaPolicy(
  db: Db,
  companyId: string,
  scopeType: 'default' | 'role' | 'user',
  scopeId: string,
): WorkspaceQuotaPolicy | null {
  const row = db
    .prepare(
      `SELECT limit_bytes, file_limit_bytes
         FROM workspace_quota_policies
        WHERE company_id = ? AND scope_type = ? AND scope_id = ?`,
    )
    .get(companyId, scopeType, scopeId) as unknown as PolicyRow | undefined
  if (!row) return null
  return { limitBytes: Number(row.limit_bytes), fileLimitBytes: Number(row.file_limit_bytes) }
}

export function defaultWorkspaceQuota(db: Db, companyId: string): WorkspaceQuotaPolicy {
  return (
    readWorkspaceQuotaPolicy(db, companyId, 'default', 'default') ?? {
      limitBytes: DEFAULT_USER_QUOTA,
      fileLimitBytes: DEFAULT_FILE_BYTES,
    }
  )
}

/** 这个用户当前实际生效的个人工作区配额 */
export function resolveUserWorkspaceQuota(
  db: Db,
  companyId: string,
  userId: string,
): EffectiveWorkspaceQuota {
  const direct = readWorkspaceQuotaPolicy(db, companyId, 'user', userId)
  if (direct) return { ...direct, source: 'user', roleCodes: [] }

  const rows = db
    .prepare(
      `SELECT r.code, p.limit_bytes, p.file_limit_bytes
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id AND r.company_id = ? AND r.deleted_at IS NULL
         LEFT JOIN workspace_quota_policies p
           ON p.company_id = r.company_id AND p.scope_type = 'role' AND p.scope_id = r.code
        WHERE ur.user_id = ?`,
    )
    .all(companyId, userId) as unknown as Array<{
    code: string
    limit_bytes: number | null
    file_limit_bytes: number | null
  }>
  const hit = rows.filter((row) => row.limit_bytes !== null && row.file_limit_bytes !== null)
  if (hit.length > 0) {
    const limitBytes = Math.max(...hit.map((row) => Number(row.limit_bytes)))
    const fileLimitBytes = Math.min(
      limitBytes,
      Math.max(...hit.map((row) => Number(row.file_limit_bytes))),
    )
    return { limitBytes, fileLimitBytes, source: 'role', roleCodes: hit.map((row) => row.code) }
  }

  const fallback = defaultWorkspaceQuota(db, companyId)
  return { ...fallback, source: 'default', roleCodes: [] }
}

/** 工作区实际已用字节：只统计未删除文件，避免 storage_quotas.used_bytes 过期 */
export function workspaceUsedBytes(
  db: Db,
  companyId: string,
  scopeType: 'company' | 'user',
  scopeId: string,
): number {
  const row = (
    scopeType === 'company'
      ? db
          .prepare(
            `SELECT COALESCE(SUM(size), 0) AS used
               FROM workspace_files
              WHERE company_id = ? AND deleted_at IS NULL`,
          )
          .get(companyId)
      : db
          .prepare(
            `SELECT COALESCE(SUM(size), 0) AS used
               FROM workspace_files
              WHERE company_id = ? AND scope_type = 'user' AND scope_id = ? AND deleted_at IS NULL`,
          )
          .get(companyId, scopeId)
  ) as { used: number } | undefined
  return Number(row?.used ?? 0)
}
