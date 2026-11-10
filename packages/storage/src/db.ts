/**
 * SQLite 连接封装。
 *
 * 为什么用 `node:sqlite` 而不是 better-sqlite3：
 * Node 22.5+ 内置，无需原生编译——Windows 上省掉 node-gyp / VS Build Tools 一整条坑，
 * "一条命令装到任何机器上"这个产品承诺才守得住。代价是该 API 仍标记实验特性，
 * 所以把它隔离在本文件里：将来换驱动（better-sqlite3 / libsql）只改这一处。
 */
import { createRequire } from 'node:module'

/**
 * 为什么不用静态 `import { DatabaseSync } from 'node:sqlite'`：
 * Vite 5 / Vitest 2 的内置模块表里还没有 `sqlite`，静态导入会被当成第三方包
 * 去解析然后报 "Failed to load url sqlite"。用 createRequire 取运行时真实模块，
 * 绕过打包器的模块识别；类型仍然来自 @types/node 的声明，不受影响。
 */
type SqliteModule = typeof import('node:sqlite')

const nodeRequire = createRequire(import.meta.url)
const sqlite = nodeRequire('node:sqlite') as SqliteModule
const DatabaseSyncCtor = sqlite.DatabaseSync

export type Db = InstanceType<SqliteModule['DatabaseSync']>

export interface OpenDatabaseOptions {
  /** 文件路径或 `:memory:` */
  readonly path: string
  readonly readOnly?: boolean
}

export function openDatabase(options: OpenDatabaseOptions): Db {
  const db = new DatabaseSyncCtor(options.path)
  if (options.readOnly) {
    db.exec('PRAGMA query_only = ON')
  }
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  if (options.path !== ':memory:') {
    // WAL：读写不互相阻塞；单写者靠应用层写队列保证
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
  }
  return db
}

/** 事务包装：出错回滚。注意 SQLite 的 DDL 也在事务内，所以迁移可以整体回滚 */
const BUSY_RETRY_ATTEMPTS = 3
const BUSY_SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4))
let sqliteBusyCount = 0

/** SQLITE_BUSY 计数；跨进程单写锁之外的写冲突，用来判断是否需要进入 P2。 */
export function sqliteBusyStats(): { count: number } {
  return { count: sqliteBusyCount }
}

function isSqliteBusy(error: unknown): boolean {
  const record = error as { code?: string; errcode?: number; message?: string } | null
  if (!record) return false
  return record.code === 'SQLITE_BUSY' || record.errcode === 5 || /SQLITE_BUSY|database is locked/i.test(record.message ?? '')
}

function sleepSync(ms: number): void {
  Atomics.wait(BUSY_SLEEP_ARRAY, 0, 0, ms)
}

function execWithBusyRetry(db: Db, sql: string): void {
  let lastError: unknown
  for (let attempt = 0; attempt < BUSY_RETRY_ATTEMPTS; attempt += 1) {
    try {
      db.exec(sql)
      return
    } catch (error) {
      lastError = error
      if (isSqliteBusy(error)) sqliteBusyCount += 1
      if (!isSqliteBusy(error) || attempt === BUSY_RETRY_ATTEMPTS - 1) throw error
      // BEGIN/COMMIT 抢写锁失败时短暂退避；不回滚、不重跑事务体。
      sleepSync(100 * (attempt + 1))
    }
  }
  throw lastError
}

export function withTransaction<T>(db: Db, fn: () => T): T {
  // IMMEDIATE 在事务开始时就拿写锁，避免「先读后写」升级锁时出现两个事务互相等待。
  execWithBusyRetry(db, 'BEGIN IMMEDIATE')
  try {
    const result = fn()
    execWithBusyRetry(db, 'COMMIT')
    return result
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // 回滚失败时不要吞掉原始错误
    }
    throw error
  }
}

export function tableExists(db: Db, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name?: string } | undefined
  return row?.name === table
}
