/**
 * 控制台「连接与平台 > 数据连接」的数据层。
 *
 * 边界：
 * - 连接配置按公司隔离，存在 SQLite 的 `database_connections`；
 * - 密码只存 secrets.json 的引用名（`secret_ref`），页面与列表接口不回显；
 * - 探测结果（status / status_detail / last_error / latency_ms）是投影，
 *   真实连通性由 `database-drivers.ts` 在请求时建立连接并执行最小探针。
 */
import { randomUUID } from 'node:crypto'
import { EC, EabError } from '@eab/domain'
import { withTransaction, type Db } from '@eab/storage'
import { deleteSecret, resolveSecret, secretConfigured, storeSecret } from './secrets.js'
import {
  DATABASE_DRIVERS,
  databaseDriver,
  databaseTarget,
  isDatabaseKind,
  probeDatabase,
  type DatabaseKind,
  type DatabaseCategory,
  type DatabaseProbeConfig,
} from './database-drivers.js'
import { queryDatabase, type DatabaseQueryResult } from './database-query.js'

export type DatabaseStatus = 'untested' | 'ok' | 'error'

export const DATABASE_STATUSES: DatabaseStatus[] = ['untested', 'ok', 'error']

export interface DatabaseConnectionView {
  id: string
  name: string
  kind: DatabaseKind
  kindLabel: string
  category: DatabaseCategory
  categoryLabel: string
  supportsQuery: boolean
  supportsTls: boolean
  host: string | null
  port: number | null
  database: string | null
  username: string | null
  filePath: string | null
  ssl: boolean
  enabled: boolean
  status: DatabaseStatus
  statusDetail: string | null
  lastError: string | null
  lastTestedAt: string | null
  latencyMs: number | null
  passwordConfigured: boolean
  target: string
  createdAt: string
  updatedAt: string
}

export interface DatabaseListResult {
  items: DatabaseConnectionView[]
  counts: Record<DatabaseStatus | 'all', number>
  total: number
  status: string
  drivers: typeof DATABASE_DRIVERS
}

interface DatabaseRow {
  id: string
  company_id: string
  name: string
  kind: string
  host: string | null
  port: number | null
  database_name: string | null
  username: string | null
  file_path: string | null
  ssl: number
  secret_ref: string | null
  enabled: number
  status: string
  status_detail: string | null
  last_error: string | null
  last_tested_at: number | null
  latency_ms: number | null
  created_at: number
  updated_at: number
}

interface ParsedFields {
  name: string
  kind: DatabaseKind
  host: string
  port: number | null
  database: string
  username: string
  filePath: string
  ssl: boolean
  enabled: boolean
}

function iso(epoch: number | null | undefined): string | null {
  return epoch ? new Date(epoch).toISOString() : null
}

function textOf(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : fallback
}

function boolOf(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  return value === 1 || value === '1' || value === 'true' || value === 'on'
}

function portOf(value: unknown): number {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0 || number > 65535) {
    throw new EabError(EC.VALIDATION, '端口需要在 1~65535 之间')
  }
  return Math.floor(number)
}

function readKind(input: Record<string, unknown>, fallback?: DatabaseKind): DatabaseKind {
  const raw = textOf(input.kind, fallback ?? '')
  if (!isDatabaseKind(raw)) {
    throw new EabError(EC.VALIDATION, '数据库类型不支持，可选 postgres / mysql / sqlite / redis')
  }
  return raw
}

function readFields(input: Record<string, unknown>, existing?: DatabaseRow): ParsedFields {
  const kind = readKind(input, existing && isDatabaseKind(existing.kind) ? existing.kind : undefined)
  const name = textOf(input.name, existing?.name ?? '')
  const enabled = boolOf(input.enabled, existing ? Boolean(existing.enabled) : true)
  const ssl = boolOf(input.ssl, existing ? Boolean(existing.ssl) : false)

  if (kind === 'sqlite') {
    const filePath = textOf(input.filePath, existing?.file_path ?? '')
    if (!filePath) throw new EabError(EC.VALIDATION, 'SQLite 需要填写服务器上的文件路径')
    return {
      name,
      kind,
      host: '',
      port: null,
      database: '',
      username: '',
      filePath,
      ssl: false,
      enabled,
    }
  }

  const host = textOf(input.host, existing?.host ?? '')
  if (!host) throw new EabError(EC.VALIDATION, '数据库主机不能为空')
  if (host.length > 255) throw new EabError(EC.VALIDATION, '数据库主机名过长')

  if (kind === 'redis') {
    const database = textOf(input.database, existing?.database_name ?? '0') || '0'
    const index = Number(database)
    if (!Number.isInteger(index) || index < 0 || index > 15) {
      throw new EabError(EC.VALIDATION, 'Redis 数据库编号需要在 0~15 之间')
    }
    return {
      name,
      kind,
      host,
      port: portOf(input.port ?? existing?.port ?? 6379),
      database: String(index),
      username: textOf(input.username, existing?.username ?? ''),
      filePath: '',
      ssl,
      enabled,
    }
  }

  const database = textOf(input.database, existing?.database_name ?? '')
  if (!database) throw new EabError(EC.VALIDATION, '数据库名不能为空')
  if (database.length > 128) throw new EabError(EC.VALIDATION, '数据库名过长')
  return {
    name,
    kind,
    host,
    port: portOf(input.port ?? existing?.port ?? databaseDriver(kind).defaultPort ?? 5432),
    database,
    username: textOf(input.username, existing?.username ?? ''),
    filePath: '',
    ssl,
    enabled,
  }
}

function requireName(name: string): string {
  if (!name) throw new EabError(EC.VALIDATION, '连接名称不能为空')
  if (name.length > 60) throw new EabError(EC.VALIDATION, '连接名称不能超过 60 个字符')
  return name
}

function fingerprint(fields: ParsedFields): string {
  return [fields.kind, fields.host, fields.port ?? '', fields.database, fields.username, fields.ssl, fields.filePath].join('|')
}

function findRow(db: Db, companyId: string, id: string): DatabaseRow | undefined {
  return db
    .prepare('SELECT * FROM database_connections WHERE id = ? AND company_id = ?')
    .get(id, companyId) as unknown as DatabaseRow | undefined
}

function requireRow(db: Db, companyId: string, id: string): DatabaseRow {
  const row = findRow(db, companyId, id)
  if (!row) throw new EabError(EC.NOT_FOUND, `数据库连接不存在：${id}`)
  return row
}

function ensureUniqueName(db: Db, companyId: string, name: string, exceptId = ''): void {
  const row = db
    .prepare('SELECT id FROM database_connections WHERE company_id = ? AND name = ? LIMIT 1')
    .get(companyId, name) as { id?: string } | undefined
  if (row?.id && row.id !== exceptId) {
    throw new EabError(EC.CONFLICT, `同公司已有名为「${name}」的数据库连接`)
  }
}

function configOfRow(row: DatabaseRow, dbPath: string, passwordOverride?: string): DatabaseProbeConfig {
  const kind = isDatabaseKind(row.kind) ? row.kind : 'postgres'
  return {
    kind,
    host: row.host ?? '',
    port: row.port ?? databaseDriver(kind).defaultPort,
    database: row.database_name ?? '',
    username: row.username ?? '',
    password: passwordOverride !== undefined ? passwordOverride : resolveSecret(dbPath, row.secret_ref),
    ssl: Boolean(row.ssl),
    filePath: row.file_path ?? '',
  }
}

function toView(row: DatabaseRow, dbPath: string): DatabaseConnectionView {
  const kind = isDatabaseKind(row.kind) ? row.kind : 'postgres'
  const driver = databaseDriver(kind)
  const config = configOfRow(row, dbPath)
  return {
    id: row.id,
    name: row.name,
    kind,
    kindLabel: driver.label,
    category: driver.category,
    categoryLabel: driver.categoryLabel,
    supportsQuery: driver.supportsQuery,
    supportsTls: driver.supportsTls,
    host: row.host,
    port: row.port,
    database: row.database_name,
    username: row.username,
    filePath: row.file_path,
    ssl: Boolean(row.ssl),
    enabled: Boolean(row.enabled),
    status: (DATABASE_STATUSES as readonly string[]).includes(row.status)
      ? (row.status as DatabaseStatus)
      : 'untested',
    statusDetail: row.status_detail,
    lastError: row.last_error,
    lastTestedAt: iso(row.last_tested_at),
    latencyMs: row.latency_ms,
    passwordConfigured: Boolean(row.secret_ref && secretConfigured(dbPath, row.secret_ref)),
    target: databaseTarget(config),
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: iso(row.updated_at) ?? new Date(0).toISOString(),
  }
}

function normalizeStatus(value: string | undefined): string {
  const status = String(value ?? 'all').trim()
  return status === 'all' || (DATABASE_STATUSES as readonly string[]).includes(status) ? status : 'all'
}

export function listDatabaseConnections(
  db: Db,
  dbPath: string,
  companyId: string,
  statusValue?: string,
): DatabaseListResult {
  const status = normalizeStatus(statusValue)
  const counts: Record<DatabaseStatus | 'all', number> = { all: 0, untested: 0, ok: 0, error: 0 }
  const countRows = db
    .prepare('SELECT status, COUNT(*) AS count FROM database_connections WHERE company_id = ? GROUP BY status')
    .all(companyId) as Array<{ status: string; count: number }>
  for (const row of countRows) {
    const count = Number(row.count ?? 0)
    counts.all += count
    if ((DATABASE_STATUSES as readonly string[]).includes(row.status)) {
      counts[row.status as DatabaseStatus] = count
    }
  }

  const where = status === 'all' ? '' : ' AND status = ?'
  const params: Array<string | number> = status === 'all' ? [companyId] : [companyId, status]
  const rows = db
    .prepare(
      `SELECT * FROM database_connections
        WHERE company_id = ?${where}
        ORDER BY CASE WHEN enabled = 0 THEN 1 ELSE 0 END, updated_at DESC`,
    )
    .all(...params) as unknown as DatabaseRow[]

  return {
    items: rows.map((row) => toView(row, dbPath)),
    counts,
    total: counts.all,
    status,
    drivers: DATABASE_DRIVERS,
  }
}

export function createDatabaseConnection(
  db: Db,
  dbPath: string,
  companyId: string,
  input: Record<string, unknown>,
): DatabaseConnectionView {
  const fields = readFields(input)
  const name = requireName(fields.name)
  ensureUniqueName(db, companyId, name)

  const now = Date.now()
  const id = `db_${randomUUID()}`
  const password = textOf(input.password)
  let secretRef = password ? storeSecret(dbPath, null, password, 'EAB_DATABASE_PASSWORD') : null
  try {
    db.prepare(
      `INSERT INTO database_connections
        (id, company_id, name, kind, host, port, database_name, username, file_path, ssl,
         secret_ref, enabled, status, status_detail, last_error, last_tested_at, latency_ms,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'untested', NULL, NULL, NULL, NULL, ?, ?)`,
    ).run(
      id,
      companyId,
      name,
      fields.kind,
      fields.host || null,
      fields.port,
      fields.database || null,
      fields.username || null,
      fields.filePath || null,
      fields.ssl ? 1 : 0,
      secretRef,
      fields.enabled ? 1 : 0,
      now,
      now,
    )
  } catch (error) {
    if (secretRef) deleteSecret(dbPath, secretRef)
    if (/UNIQUE|unique/i.test(error instanceof Error ? error.message : String(error))) {
      throw new EabError(EC.CONFLICT, `同公司已有名为「${name}」的数据库连接`)
    }
    throw error
  }
  return toView(requireRow(db, companyId, id), dbPath)
}

export function updateDatabaseConnection(
  db: Db,
  dbPath: string,
  companyId: string,
  id: string,
  input: Record<string, unknown>,
): DatabaseConnectionView {
  const existing = requireRow(db, companyId, id)
  const fields = readFields(input, existing)
  const name = requireName(fields.name)
  ensureUniqueName(db, companyId, name, id)

  const password = textOf(input.password)
  const clearPassword = input.clearPassword === true
  const kindChanged = fields.kind !== existing.kind
  let secretRef = existing.secret_ref
  let passwordChanged = false
  if (kindChanged && secretRef) {
    deleteSecret(dbPath, secretRef)
    secretRef = null
    passwordChanged = true
  } else if (clearPassword && secretRef) {
    deleteSecret(dbPath, secretRef)
    secretRef = null
    passwordChanged = true
  } else if (password) {
    secretRef = storeSecret(dbPath, secretRef, password, 'EAB_DATABASE_PASSWORD')
    passwordChanged = true
  }

  const configChanged = fingerprint(fields) !== fingerprint(readFields({}, existing)) || passwordChanged
  const now = Date.now()
  withTransaction(db, () => {
    db.prepare(
      `UPDATE database_connections
          SET name = ?, kind = ?, host = ?, port = ?, database_name = ?, username = ?,
              file_path = ?, ssl = ?, secret_ref = ?, enabled = ?,
              status = ?, status_detail = ?, last_error = ?, last_tested_at = ?, latency_ms = ?,
              updated_at = ?
        WHERE id = ? AND company_id = ?`,
    ).run(
      name,
      fields.kind,
      fields.host || null,
      fields.port,
      fields.database || null,
      fields.username || null,
      fields.filePath || null,
      fields.ssl ? 1 : 0,
      secretRef,
      fields.enabled ? 1 : 0,
      configChanged ? 'untested' : existing.status,
      configChanged ? null : existing.status_detail,
      configChanged ? null : existing.last_error,
      configChanged ? null : existing.last_tested_at,
      configChanged ? null : existing.latency_ms,
      now,
      id,
      companyId,
    )
  })
  return toView(requireRow(db, companyId, id), dbPath)
}

export function deleteDatabaseConnection(
  db: Db,
  dbPath: string,
  companyId: string,
  id: string,
): { id: string; name: string } {
  const row = requireRow(db, companyId, id)
  withTransaction(db, () => {
    db.prepare('DELETE FROM database_connections WHERE id = ? AND company_id = ?').run(id, companyId)
  })
  if (row.secret_ref) deleteSecret(dbPath, row.secret_ref)
  return { id: row.id, name: row.name }
}

export interface DatabaseTestOutcome {
  connection: DatabaseConnectionView
  result: ReturnType<typeof probeDatabase> extends Promise<infer R> ? R : never
}

export async function testDatabaseConnection(
  db: Db,
  dbPath: string,
  companyId: string,
  id: string,
): Promise<DatabaseTestOutcome> {
  const row = requireRow(db, companyId, id)
  const result = await probeDatabase(configOfRow(row, dbPath))
  const now = Date.now()
  db.prepare(
    `UPDATE database_connections
        SET status = ?, status_detail = ?, last_error = ?, last_tested_at = ?, latency_ms = ?, updated_at = ?
      WHERE id = ? AND company_id = ?`,
  ).run(
    result.ok ? 'ok' : 'error',
    result.ok ? result.detail : null,
    result.ok ? null : result.error,
    now,
    result.latencyMs,
    now,
    id,
    companyId,
  )
  return { connection: toView(requireRow(db, companyId, id), dbPath), result }
}

/** 未保存草稿的测试：可带 id 复用已保存的地址与密码，但不会写 status。 */
export async function testDatabaseDraft(
  db: Db,
  dbPath: string,
  companyId: string,
  input: Record<string, unknown>,
): Promise<ReturnType<typeof probeDatabase> extends Promise<infer R> ? R : never> {
  const id = textOf(input.id)
  const existing = id ? findRow(db, companyId, id) : undefined
  const fields = readFields(input, existing)
  const password = textOf(input.password) || (existing ? resolveSecret(dbPath, existing.secret_ref) : '')
  return probeDatabase({
    kind: fields.kind,
    host: fields.host,
    port: fields.port,
    database: fields.database,
    username: fields.username,
    password,
    ssl: fields.ssl,
    filePath: fields.filePath,
  })
}

export interface DatabaseQueryOutcome {
  connection: DatabaseConnectionView
  result: DatabaseQueryResult
}

/** 对已保存连接执行一次只读查询；查询失败只返回结果，不改变连接的测试状态。 */
export async function queryDatabaseConnection(
  db: Db,
  dbPath: string,
  companyId: string,
  id: string,
  sql: string,
): Promise<DatabaseQueryOutcome> {
  const row = requireRow(db, companyId, id)
  if (!Boolean(row.enabled)) {
    throw new EabError(EC.VALIDATION, '连接已停用，请先启用后再查询')
  }
  const result = await queryDatabase(configOfRow(row, dbPath), sql)
  return { connection: toView(row, dbPath), result }
}
