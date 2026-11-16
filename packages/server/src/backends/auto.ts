/**
 * 从控制台「数据连接」自动选择平台后端。
 *
 * 边界：
 * - 只服务单公司部署；多公司时不替用户做跨租户选择；
 * - 数据连接是平台后端的实际来源：表里没有启用连接时，不连接、不探测 Redis/PG；
 *   环境变量只有在显式 EAB_BACKENDS_FROM_ENV=1 时才作为兼容回退；
 * - 密码不落新文件，按 `secret_ref` 从现有 secrets.json 解析；
 * - 状态只回显连接名与能力，不回显连接串。
 */
import type { Db } from '@eab/storage'
import { resolveSecret } from '../secrets.js'

export type AutoBackendKind = 'postgres' | 'redis'

export interface AutoBackendSource {
  readonly id: string
  readonly companyId: string
  readonly name: string
  readonly kind: AutoBackendKind
  readonly url: string
}

export interface AutoBackendSelection {
  readonly postgres?: AutoBackendSource
  readonly redis?: AutoBackendSource
  /** 未自动选择的原因；有显式环境变量时为空。 */
  readonly reason?: string
}

interface ConnectionRow {
  id: string
  company_id: string
  name: string
  kind: string
  host: string | null
  port: number | null
  database_name: string | null
  username: string | null
  ssl: number
  secret_ref: string | null
  status: string
}

function encode(value: string): string {
  return encodeURIComponent(value)
}

function hostPort(host: string, port: number): string {
  return `${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`
}

function postgresUrl(row: ConnectionRow, password: string): string {
  const host = (row.host ?? '').trim()
  if (!host) return ''
  const user = (row.username ?? '').trim()
  const auth = user
    ? `${encode(user)}${password ? `:${encode(password)}` : ''}@`
    : password
      ? `:${encode(password)}@`
      : ''
  const database = encode((row.database_name ?? '').trim() || 'postgres')
  const query = row.ssl ? '?sslmode=no-verify' : ''
  return `postgres://${auth}${hostPort(host, Number(row.port) || 5432)}/${database}${query}`
}

function redisUrl(row: ConnectionRow, password: string): string {
  const host = (row.host ?? '').trim()
  if (!host) return ''
  const user = (row.username ?? '').trim()
  const auth = user
    ? `${encode(user)}${password ? `:${encode(password)}` : ''}@`
    : password
      ? `:${encode(password)}@`
      : ''
  const database = encode((row.database_name ?? '').trim() || '0')
  return `${row.ssl ? 'rediss' : 'redis'}://${auth}${hostPort(host, Number(row.port) || 6379)}/${database}`
}

export function resolveAutoBackends(db: Db, dbPath: string): AutoBackendSelection {
  const companies = db
    .prepare("SELECT id FROM companies WHERE status = 'active' ORDER BY created_at, id")
    .all() as Array<{ id: string }>
  if (companies.length !== 1) {
    return {
      reason:
        companies.length === 0
          ? '当前没有可用公司，未自动选择平台后端'
          : '多公司部署不自动选择平台后端；请用 EAB_POSTGRES_URL / EAB_REDIS_URL 显式指定',
    }
  }
  const companyId = companies[0].id
  const rows = db
    .prepare(
      `SELECT id, company_id, name, kind, host, port, database_name, username, ssl, secret_ref, status
         FROM database_connections
        WHERE company_id = ?
          AND enabled = 1
          AND kind IN ('postgres', 'redis')
          AND status <> 'error'
        ORDER BY CASE status WHEN 'ok' THEN 0 WHEN 'untested' THEN 1 ELSE 2 END,
                 updated_at DESC, created_at DESC`,
    )
    .all(companyId) as unknown as ConnectionRow[]

  let postgres: AutoBackendSource | undefined
  let redis: AutoBackendSource | undefined
  for (const row of rows) {
    if (row.kind === 'postgres' && !postgres) {
      const url = postgresUrl(row, resolveSecret(dbPath, row.secret_ref))
      if (url) {
        postgres = { id: row.id, companyId: row.company_id, name: row.name, kind: 'postgres', url }
      }
    } else if (row.kind === 'redis' && !redis) {
      const url = redisUrl(row, resolveSecret(dbPath, row.secret_ref))
      if (url) {
        redis = { id: row.id, companyId: row.company_id, name: row.name, kind: 'redis', url }
      }
    }
  }
  return {
    postgres,
    redis,
    reason:
      rows.length === 0
        ? '“数据连接”中没有启用的 Redis / PostgreSQL 连接'
        : undefined,
  }
}
