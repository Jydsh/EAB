import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LiveDatabase } from '../src/live-db.js'
import { copyDatabaseCompanionFiles, migrateStorageJobs } from '../src/settings.js'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'eab-live-storage-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  }
})

describe('运行时存储迁移', () => {
  it('VACUUM INTO 快照可以在线切库，旧库仍保留', () => {
    const dir = tempDir()
    const oldPath = join(dir, 'old.db')
    const newPath = join(dir, 'new', 'eab.db')
    const live = new LiveDatabase(oldPath)
    live.db.exec('CREATE TABLE t(x INTEGER)')
    live.db.exec('INSERT INTO t VALUES (1), (2)')
    live.snapshotTo(newPath)
    const prepared = live.prepareAt(newPath)
    expect((prepared.db.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n).toBe(2)
    prepared.activate()
    expect(live.path).toBe(newPath)
    expect((live.db.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n).toBe(2)
    expect(existsSync(oldPath)).toBe(true)
    live.close()
  })

  it('目标库不可用时 prepareAt 失败，旧连接继续可用', () => {
    const dir = tempDir()
    const oldPath = join(dir, 'old.db')
    const badPath = join(dir, 'bad.db')
    const live = new LiveDatabase(oldPath)
    live.db.exec('CREATE TABLE t(x INTEGER)')
    live.db.exec('INSERT INTO t VALUES (7)')
    writeFileSync(badPath, 'not a sqlite database', 'utf8')

    expect(() => live.prepareAt(badPath)).toThrow()
    expect((live.db.prepare('SELECT x FROM t').get() as { x: number }).x).toBe(7)
    live.close()
  })

  it('目录迁移复制后校验，旧目录保留', () => {
    const dir = tempDir()
    const from = join(dir, 'old-ws')
    const to = join(dir, 'new-ws')
    mkdirSync(join(from, 'c1'), { recursive: true })
    writeFileSync(join(from, 'c1', 'a.txt'), 'hello')
    const result = migrateStorageJobs([
      { key: 'workspaces', kind: 'directory', from, to, createdAt: new Date().toISOString() },
    ])
    expect(result.moved).toEqual([to])
    expect(existsSync(join(to, 'c1', 'a.txt'))).toBe(true)
    expect(existsSync(from)).toBe(true)
  })

  it('凭据伴随文件不复制旧库 WAL', () => {
    const dir = tempDir()
    const from = join(dir, 'from')
    const to = join(dir, 'to')
    mkdirSync(from, { recursive: true })
    mkdirSync(to, { recursive: true })
    writeFileSync(join(from, 'eab.db'), 'db')
    writeFileSync(join(from, 'eab.db-wal'), 'wal')
    writeFileSync(join(from, 'secrets.json'), '{}')
    copyDatabaseCompanionFiles(from, to)
    expect(existsSync(join(to, 'secrets.json'))).toBe(true)
    expect(existsSync(join(to, 'eab.db'))).toBe(false)
    expect(existsSync(join(to, 'eab.db-wal'))).toBe(false)
  })
})
