import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { migrate, openDatabase, type Db } from '@eab/storage'
import { readOfficeRefreshCutoff, setOfficeRefreshCutoff } from '../src/routes/workspace.js'

const dbs: Db[] = []
const dirs: string[] = []

afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function openTestDb(path: string): Db {
  const db = openDatabase({ path })
  migrate(db)
  // 这个用例只验证刷新水位的持久化，不搭公司/成员主数据
  db.exec('PRAGMA foreign_keys = OFF')
  dbs.push(db)
  return db
}

describe('OnlyOffice 刷新水位持久化', () => {
  it('写入后覆盖更新，关闭再打开数据库仍能读回', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eab-office-refresh-'))
    dirs.push(dir)
    const dbPath = join(dir, 'eab.db')

    let db = openTestDb(dbPath)
    setOfficeRefreshCutoff(db, 'c1', 'f1', 100)
    expect(readOfficeRefreshCutoff(db, 'c1', 'f1')).toBe(100)

    setOfficeRefreshCutoff(db, 'c1', 'f1', 200)
    expect(readOfficeRefreshCutoff(db, 'c1', 'f1')).toBe(200)
    db.close()
    dbs.splice(dbs.indexOf(db), 1)

    db = openTestDb(dbPath)
    expect(readOfficeRefreshCutoff(db, 'c1', 'f1')).toBe(200)
  })

  it('按公司和文件隔离，没有记录时返回 undefined', () => {
    const db = openTestDb(':memory:')

    expect(readOfficeRefreshCutoff(db, 'c1', 'f1')).toBeUndefined()
    setOfficeRefreshCutoff(db, 'c1', 'f1', 300)
    expect(readOfficeRefreshCutoff(db, 'c1', 'f1')).toBe(300)
    expect(readOfficeRefreshCutoff(db, 'c2', 'f1')).toBeUndefined()
    expect(readOfficeRefreshCutoff(db, 'c1', 'f2')).toBeUndefined()
  })
})
