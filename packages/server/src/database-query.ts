/**
 * 控制台「数据库 → 查询」的只读查询执行器。
 *
 * 边界：
 * - 只执行单条只读 SQL；写入、DDL、多语句在进入驱动前就被拒绝；
 * - PostgreSQL 使用 READ ONLY 事务，MySQL 使用 READ ONLY 事务，SQLite 只读打开；
 * - 最多返回 100 行，剩余行标记 truncated；查询失败不改变连接的测试状态；
 * - 错误统一脱敏密码，不把原始 SQL 或凭据写进日志。
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { DatabaseKind, DatabaseProbeConfig } from './database-drivers.js'

export const DATABASE_QUERY_ROW_LIMIT = 100
export const DATABASE_QUERY_MAX_SQL = 8000

export interface DatabaseQueryResult {
  ok: boolean
  kind: DatabaseKind
  columns: string[]
  rows: Array<Record<string, unknown>>
  rowCount: number
  truncated: boolean
  durationMs: number
  error: string
}

interface RawQueryResult {
  columns: string[]
  rows: Array<Record<string, unknown>>
}

const READ_KEYWORDS = new Set(['select', 'with', 'explain', 'show', 'describe', 'desc', 'values', 'table'])
const SQLITE_READ_KEYWORDS = new Set(['select', 'with', 'explain', 'pragma', 'values'])

function safeError(error: unknown, password: string): string {
  const message = error instanceof Error ? error.message : String(error ?? '未知错误')
  const redacted = password ? message.split(password).join('[密码已隐藏]') : message
  return redacted.replace(/\s+/g, ' ').trim().slice(0, 400) || '查询失败'
}

function withTimeout<T>(task: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${Math.round(ms / 1000)}s）`)), ms)
    task.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function normalizeSql(raw: string, kind: DatabaseKind): string {
  const input = String(raw ?? '').replace(/^\uFEFF/, '').trim()
  if (!input) throw new Error('SQL 不能为空')
  if (input.length > DATABASE_QUERY_MAX_SQL) throw new Error(`SQL 不能超过 ${DATABASE_QUERY_MAX_SQL} 个字符`)

  const body = input.replace(/;+\s*$/, '').trim()
  if (!body) throw new Error('SQL 不能为空')
  if (body.includes(';')) throw new Error('一次只能执行一条 SQL；不支持多语句')
  if (/\binto\s+(outfile|dumpfile)\b/i.test(body)) throw new Error('不允许 INTO OUTFILE / DUMPFILE')
  if (/\bfor\s+update\b/i.test(body)) throw new Error('不允许 SELECT ... FOR UPDATE')
  if (/\block\s+in\s+share\s+mode\b/i.test(body)) throw new Error('不允许 LOCK IN SHARE MODE')
  if (/\bselect\b[\s\S]*\binto\b/i.test(body)) throw new Error('不允许 SELECT ... INTO')

  const lead = body
    .replace(/^(?:\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/))*/, '')
    .trim()
  const keyword = (lead.match(/^([a-zA-Z]+)/)?.[1] || '').toLowerCase()
  const allowed = kind === 'sqlite' ? SQLITE_READ_KEYWORDS : READ_KEYWORDS
  if (!allowed.has(keyword)) {
    throw new Error(`只允许执行单条只读查询（${[...allowed].join(' / ')}）`)
  }
  if (kind === 'sqlite' && keyword === 'pragma' && body.includes('=')) {
    throw new Error('不允许通过 PRAGMA 修改 SQLite 设置')
  }
  return body
}

function previewSql(sql: string): string {
  if (!/^(select|with)\b/i.test(sql)) return sql
  if (/\blimit\b/i.test(sql) || /\bfetch\b/i.test(sql)) return sql
  return `${sql} LIMIT ${DATABASE_QUERY_ROW_LIMIT + 1}`
}

function normalizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return `<binary ${value.length} bytes>`
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value)
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return value
}

function normalizeRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((row) => {
    const normalized: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(row || {})) normalized[key] = normalizeValue(value)
    return normalized
  })
}

function columnsFromRows(columns: string[], rows: Array<Record<string, unknown>>): string[] {
  if (columns.length) return columns
  return rows[0] ? Object.keys(rows[0]) : []
}

async function queryPostgres(config: DatabaseProbeConfig, sql: string): Promise<RawQueryResult> {
  const moduleName = 'pg'
  const pg = (await import(/* @vite-ignore */ moduleName)) as {
    Client: new (options: Record<string, unknown>) => {
      connect(): Promise<void>
      query(text: string): Promise<{ rows?: Array<Record<string, unknown>>; fields?: Array<{ name?: string }> }>
      end(): Promise<void>
    }
  }
  const client = new pg.Client({
    host: config.host,
    port: config.port ?? 5432,
    database: config.database,
    user: config.username || undefined,
    password: config.password || undefined,
    ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 5000,
    query_timeout: 6000,
    application_name: 'eab-console-query',
  })
  try {
    await withTimeout(client.connect(), 6500, 'PostgreSQL')
    await client.query('BEGIN READ ONLY')
    await client.query('SET LOCAL statement_timeout = 6000')
    const result = await withTimeout(client.query(previewSql(sql)), 7000, 'PostgreSQL 查询')
    const rows = (result.rows || []) as Array<Record<string, unknown>>
    return { columns: (result.fields || []).map((field) => String(field.name || '')).filter(Boolean), rows }
  } finally {
    await client.query('ROLLBACK').catch(() => undefined)
    await client.end().catch(() => undefined)
  }
}

async function queryMysql(config: DatabaseProbeConfig, sql: string): Promise<RawQueryResult> {
  const moduleName = 'mysql2/promise'
  const mysql = (await import(/* @vite-ignore */ moduleName)) as {
    createConnection(options: Record<string, unknown>): Promise<{
      query(text: string): Promise<[unknown, Array<{ name?: string }> | undefined]>
      destroy(): void
    }>
  }
  const connection = await withTimeout(
    mysql.createConnection({
      host: config.host,
      port: config.port ?? 3306,
      database: config.database || undefined,
      user: config.username || undefined,
      password: config.password || undefined,
      ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
      connectTimeout: 5000,
      charset: 'utf8mb4',
      multipleStatements: false,
    }),
    6500,
    'MySQL',
  )
  try {
    await connection.query('START TRANSACTION READ ONLY')
    const [rows, fields] = await withTimeout(connection.query(previewSql(sql)), 7000, 'MySQL 查询')
    const records = (Array.isArray(rows) ? rows : []) as Array<Record<string, unknown>>
    return {
      columns: (fields || []).map((field) => String(field.name || '')).filter(Boolean),
      rows: records,
    }
  } finally {
    connection.destroy()
  }
}

async function querySqlite(config: DatabaseProbeConfig, sql: string): Promise<RawQueryResult> {
  const file = config.filePath.trim()
  if (!file) throw new Error('SQLite 文件路径不能为空')
  if (!existsSync(file)) throw new Error(`SQLite 文件不存在：${file}`)
  const nodeRequire = createRequire(import.meta.url)
  const sqlite = nodeRequire('node:sqlite') as typeof import('node:sqlite')
  const database = new sqlite.DatabaseSync(file, { readOnly: true, enableForeignKeyConstraints: true })
  try {
    const statement = database.prepare(previewSql(sql))
    const definition = typeof statement.columns === 'function' ? statement.columns() : []
    const rows = statement.all() as Array<Record<string, unknown>>
    return {
      columns: definition.map((column: { name?: string }) => String(column.name || '')).filter(Boolean),
      rows,
    }
  } finally {
    database.close()
  }
}

export async function queryDatabase(config: DatabaseProbeConfig, rawSql: string): Promise<DatabaseQueryResult> {
  const startedAt = Date.now()
  try {
    const kind = config.kind
    if (kind === 'redis') {
      throw new Error('Redis 暂不开放查询控制台；当前支持 PostgreSQL、MySQL / MariaDB、SQLite')
    }
    const sql = normalizeSql(rawSql, kind)
    const raw =
      kind === 'postgres'
        ? await queryPostgres(config, sql)
        : kind === 'mysql'
          ? await queryMysql(config, sql)
          : await querySqlite(config, sql)
    const records = normalizeRows(raw.rows)
    const columns = columnsFromRows(raw.columns, records)
    const truncated = records.length > DATABASE_QUERY_ROW_LIMIT
    const rows = truncated ? records.slice(0, DATABASE_QUERY_ROW_LIMIT) : records
    return {
      ok: true,
      kind,
      columns,
      rows,
      rowCount: rows.length,
      truncated,
      durationMs: Date.now() - startedAt,
      error: '',
    }
  } catch (error) {
    return {
      ok: false,
      kind: config.kind,
      columns: [],
      rows: [],
      rowCount: 0,
      truncated: false,
      durationMs: Date.now() - startedAt,
      error: safeError(error, config.password),
    }
  }
}
