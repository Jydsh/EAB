/**
 * 外部数据连接探测。
 *
 * 只负责“真实建立一次连接并执行最小探针”，不保存任何配置：
 * - PostgreSQL：SELECT version() / current_database()
 * - MySQL/MariaDB：SELECT VERSION() / DATABASE()
 * - SQLite：只读打开文件并 SELECT sqlite_version()
 * - Redis：PING
 *
 * 驱动都按需动态加载：默认部署不装 mysql2/pg/redis 也能启动控制台，
 * 只有测试对应连接时才报“驱动未安装”。
 */
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { createRequire } from 'node:module'

export const DATABASE_KINDS = ['postgres', 'mysql', 'sqlite', 'redis'] as const
export type DatabaseKind = (typeof DATABASE_KINDS)[number]

/** 产品分类：Redis 属于缓存，不按关系型数据库处理。 */
export type DatabaseCategory = 'relational' | 'file' | 'cache'

export interface DatabaseDriverInfo {
  id: DatabaseKind
  label: string
  category: DatabaseCategory
  categoryLabel: string
  defaultPort: number | null
  supportsSsl: boolean
  supportsTls: boolean
  supportsQuery: boolean
  notes: string
}

export const DATABASE_DRIVERS: DatabaseDriverInfo[] = [
  {
    id: 'postgres',
    label: 'PostgreSQL',
    category: 'relational',
    categoryLabel: '关系型数据库',
    defaultPort: 5432,
    supportsSsl: true,
    supportsTls: true,
    supportsQuery: true,
    notes: '关系型数据库：主机、端口、数据库名、账号；可选 TLS。',
  },
  {
    id: 'mysql',
    label: 'MySQL / MariaDB',
    category: 'relational',
    categoryLabel: '关系型数据库',
    defaultPort: 3306,
    supportsSsl: true,
    supportsTls: true,
    supportsQuery: true,
    notes: '关系型数据库：主机、端口、数据库名、账号；MySQL 8 默认使用 caching_sha2_password。',
  },
  {
    id: 'sqlite',
    label: 'SQLite',
    category: 'file',
    categoryLabel: '文件数据库',
    defaultPort: null,
    supportsSsl: false,
    supportsTls: false,
    supportsQuery: true,
    notes: '文件数据库：填写服务器上的绝对路径；探测只读打开，不会创建新文件。',
  },
  {
    id: 'redis',
    label: 'Redis',
    category: 'cache',
    categoryLabel: '键值缓存',
    defaultPort: 6379,
    supportsSsl: true,
    supportsTls: true,
    supportsQuery: false,
    notes: '键值缓存：主机、端口、DB 编号、可选 ACL 账号；探针执行 PING，不开放 SQL 查询。',
  },
]

export interface DatabaseProbeConfig {
  kind: DatabaseKind
  host: string
  port: number | null
  database: string
  username: string
  password: string
  ssl: boolean
  filePath: string
}

export interface DatabaseProbeResult {
  ok: boolean
  latencyMs: number
  detail: string
  error: string
}

export function isDatabaseKind(value: unknown): value is DatabaseKind {
  return typeof value === 'string' && (DATABASE_KINDS as readonly string[]).includes(value)
}

export function databaseDriver(kind: DatabaseKind): DatabaseDriverInfo {
  return DATABASE_DRIVERS.find((item) => item.id === kind) ?? DATABASE_DRIVERS[0]
}

export function databaseTarget(config: DatabaseProbeConfig): string {
  if (config.kind === 'sqlite') return config.filePath || '未填写文件路径'
  const host = config.host || '127.0.0.1'
  const port = config.port ?? databaseDriver(config.kind).defaultPort ?? ''
  if (config.kind === 'redis') return `${host}:${port} · DB ${config.database || '0'}`
  return `${host}:${port} · ${config.database || '未填写数据库'}`
}

function safeError(error: unknown, password: string): string {
  const message = error instanceof Error ? error.message : String(error ?? '未知错误')
  const redacted = password ? message.split(password).join('[密码已隐藏]') : message
  return redacted.replace(/\s+/g, ' ').trim().slice(0, 400) || '连接失败'
}

function withTimeout<T>(task: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 连接超时（${Math.round(ms / 1000)}s）`)), ms)
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

async function probePostgres(config: DatabaseProbeConfig): Promise<string> {
  const moduleName = 'pg'
  const pg = (await import(/* @vite-ignore */ moduleName)) as {
    Client: new (options: Record<string, unknown>) => {
      connect(): Promise<void>
      query(text: string): Promise<{ rows: Array<Record<string, unknown>> }>
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
    query_timeout: 5000,
    application_name: 'eab-console-database',
  })
  try {
    await withTimeout(client.connect(), 6500, 'PostgreSQL')
    const result = await withTimeout(
      client.query('SELECT version() AS version, current_database() AS database'),
      6500,
      'PostgreSQL',
    )
    const row = result.rows[0] ?? {}
    const version = String(row.version ?? 'PostgreSQL').split(',')[0]
    return `${version} · 数据库 ${String(row.database ?? config.database)}`
  } finally {
    await client.end().catch(() => undefined)
  }
}

async function probeMysql(config: DatabaseProbeConfig): Promise<string> {
  const moduleName = 'mysql2/promise'
  const mysql = (await import(/* @vite-ignore */ moduleName)) as {
    createConnection(options: Record<string, unknown>): Promise<{
      query(text: string): Promise<[Array<Record<string, unknown>>, unknown]>
      end(): Promise<void>
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
    }),
    6500,
    'MySQL',
  )
  try {
    const [rows] = await withTimeout(
      connection.query('SELECT VERSION() AS version, DATABASE() AS database'),
      6500,
      'MySQL',
    )
    const row = rows[0] ?? {}
    return `MySQL ${String(row.version ?? '')} · 数据库 ${String(row.database ?? (config.database || '默认库'))}`
  } finally {
    await connection.end().catch(() => connection.destroy())
  }
}

async function probeSqlite(config: DatabaseProbeConfig): Promise<string> {
  const file = config.filePath.trim()
  if (!file) throw new Error('SQLite 文件路径不能为空')
  if (!existsSync(file)) throw new Error(`SQLite 文件不存在：${file}`)
  const nodeRequire = createRequire(import.meta.url)
  const sqlite = nodeRequire('node:sqlite') as typeof import('node:sqlite')
  const database = new sqlite.DatabaseSync(file, { readOnly: true, enableForeignKeyConstraints: true })
  try {
    const row = database.prepare('SELECT sqlite_version() AS version').get() as { version?: string } | undefined
    return `SQLite ${String(row?.version ?? '')} · ${basename(file)}`
  } finally {
    database.close()
  }
}

async function probeRedis(config: DatabaseProbeConfig): Promise<string> {
  const moduleName = 'redis'
  const redis = (await import(/* @vite-ignore */ moduleName)) as {
    createClient(options: Record<string, unknown>): {
      on(event: string, listener: (...args: unknown[]) => void): void
      connect(): Promise<void>
      ping(): Promise<string>
      quit(): Promise<void>
      disconnect(): void
    }
  }
  const client = redis.createClient({
    socket: {
      host: config.host,
      port: config.port ?? 6379,
      connectTimeout: 5000,
      // Redis 客户端默认会无限重连；控制台探针必须在一次超时后结束，
      // 否则点击“测试”会一直挂起，后续页面操作也拿不到结果。
      reconnectStrategy: false,
      tls: config.ssl ? {} : undefined,
    },
    username: config.username || undefined,
    password: config.password || undefined,
    database: Number(config.database || 0),
  })
  client.on('error', () => undefined)
  let connected = false
  try {
    await withTimeout(client.connect(), 6500, 'Redis')
    connected = true
    const pong = await withTimeout(client.ping(), 6500, 'Redis')
    return `${pong || 'PONG'} · DB ${config.database || 0}`
  } finally {
    if (connected) await client.quit().catch(() => client.disconnect())
    else client.disconnect()
  }
}

export async function probeDatabase(config: DatabaseProbeConfig): Promise<DatabaseProbeResult> {
  const startedAt = Date.now()
  try {
    const detail =
      config.kind === 'postgres'
        ? await probePostgres(config)
        : config.kind === 'mysql'
          ? await probeMysql(config)
          : config.kind === 'sqlite'
            ? await probeSqlite(config)
            : await probeRedis(config)
    return { ok: true, latencyMs: Date.now() - startedAt, detail, error: '' }
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      detail: '',
      error: safeError(error, config.password),
    }
  }
}
