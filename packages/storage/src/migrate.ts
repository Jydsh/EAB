/**
 * 迁移执行器。
 *
 * 约定（来自架构文档 15.7）：
 * - 迁移文件只前进不后退，靠"备份点 + 恢复"回滚，不写 down 迁移。
 * - 每个文件一个事务；失败即回滚并抛出，绝不留半截 schema。
 * - 重复执行幂等：已记录的版本跳过。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EC, EabError } from '@eab/domain'
import type { Db } from './db.js'
import { withTransaction } from './db.js'

export interface MigrationResult {
  readonly applied: readonly string[]
  readonly skipped: readonly string[]
}

const DEFAULT_MIGRATIONS_DIR = process.env.EAB_MIGRATIONS_DIR || fileURLToPath(new URL('../migrations', import.meta.url))

interface MigrationRow {
  name: string
  applied_at: number
}

function ensureMigrationsTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `)
}

export interface MigrateOptions {
  readonly dir?: string
  readonly now?: number
}

export function migrate(db: Db, options: MigrateOptions = {}): MigrationResult {
  const dir = options.dir ?? DEFAULT_MIGRATIONS_DIR
  const now = options.now ?? Date.now()

  ensureMigrationsTable(db)

  const appliedRows = db.prepare('SELECT name FROM _migrations').all() as unknown as MigrationRow[]
  const applied = new Set(appliedRows.map((row) => row.name))

  const files = readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b))

  const newlyApplied: string[] = []
  const skipped: string[] = []

  for (const file of files) {
    if (applied.has(file)) {
      skipped.push(file)
      continue
    }
    const sql = readFileSync(join(dir, file), 'utf8')
    try {
      withTransaction(db, () => {
        db.exec(sql)
        db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(file, now)
      })
    } catch (error) {
      throw new EabError(EC.INTERNAL, `迁移执行失败: ${file}`, {
        details: { file },
        cause: error,
      })
    }
    newlyApplied.push(file)
  }

  return { applied: newlyApplied, skipped }
}
