import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrate, openDatabase } from '@eab/storage'
import { resolveAutoBackends } from '../src/backends/auto.js'
import { createDatabaseConnection } from '../src/database-connections.js'

const tempDirs: string[] = []

function testDb() {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  db.exec(
    "INSERT INTO companies (id, name, slug, status, created_at) VALUES ('c1', '测试公司', 'test', 'active', 1)",
  )
  return db
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'eab-auto-backend-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* Windows 上偶发占用，交给系统清理 */
    }
  }
})

describe('数据连接自动接入平台后端', () => {
  it('单公司部署下把启用中的 PostgreSQL / Redis 连接转换成后端连接串', () => {
    const db = testDb()
    const dir = tempDir()
    const dbPath = join(dir, 'eab.db')

    createDatabaseConnection(db, dbPath, 'c1', {
      name: '平台 PostgreSQL',
      kind: 'postgres',
      host: '127.0.0.1',
      port: 5432,
      database: 'eab',
      username: 'eab',
      password: 'p@ss word',
    })
    createDatabaseConnection(db, dbPath, 'c1', {
      name: '平台 Redis',
      kind: 'redis',
      host: '127.0.0.1',
      port: 6379,
      database: '0',
      password: 'p@ss word',
    })

    const auto = resolveAutoBackends(db, dbPath)
    expect(auto.postgres?.name).toBe('平台 PostgreSQL')
    expect(auto.postgres?.url).toBe('postgres://eab:p%40ss%20word@127.0.0.1:5432/eab')
    expect(auto.redis?.name).toBe('平台 Redis')
    expect(auto.redis?.url).toBe('redis://:p%40ss%20word@127.0.0.1:6379/0')
  })

  it('跳过停用连接与最近测试失败的连接', () => {
    const db = testDb()
    const dir = tempDir()
    const dbPath = join(dir, 'eab.db')

    const healthy = createDatabaseConnection(db, dbPath, 'c1', {
      name: '可用库',
      kind: 'postgres',
      host: '127.0.0.1',
      port: 5432,
      database: 'eab',
      username: 'eab',
      password: 'secret',
    })
    db.prepare("UPDATE database_connections SET status = 'ok', updated_at = 1 WHERE id = ?").run(healthy.id)

    const failed = createDatabaseConnection(db, dbPath, 'c1', {
      name: '失败库',
      kind: 'postgres',
      host: '127.0.0.1',
      port: 5432,
      database: 'bad',
      username: 'eab',
      password: 'secret',
    })
    db.prepare("UPDATE database_connections SET status = 'error', updated_at = 2000 WHERE id = ?").run(failed.id)

    const disabled = createDatabaseConnection(db, dbPath, 'c1', {
      name: '停用库',
      kind: 'redis',
      host: '127.0.0.1',
      port: 6379,
      database: '0',
      enabled: false,
    })

    const auto = resolveAutoBackends(db, dbPath)
    expect(auto.postgres?.name).toBe('可用库')
    expect(auto.redis).toBeUndefined()

    db.prepare('UPDATE database_connections SET enabled = 1 WHERE id = ?').run(disabled.id)
    const afterEnable = resolveAutoBackends(db, dbPath)
    expect(afterEnable.redis?.name).toBe('停用库')
  })

  it('多公司部署不自动跨租户选择', () => {
    const db = testDb()
    const dir = tempDir()
    const dbPath = join(dir, 'eab.db')
    db.exec("INSERT INTO companies (id, name, slug, status, created_at) VALUES ('c2', '另一家公司', 'other', 'active', 1)")
    createDatabaseConnection(db, dbPath, 'c1', {
      name: '公司一库',
      kind: 'postgres',
      host: '127.0.0.1',
      port: 5432,
      database: 'c1',
      username: 'eab',
      password: 'secret',
    })

    const auto = resolveAutoBackends(db, dbPath)
    expect(auto.postgres).toBeUndefined()
    expect(auto.redis).toBeUndefined()
    expect(auto.reason).toContain('多公司部署')
  })
})
