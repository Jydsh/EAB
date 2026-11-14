import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrate, openDatabase } from '@eab/storage'
import {
  createDatabaseConnection,
  deleteDatabaseConnection,
  listDatabaseConnections,
  queryDatabaseConnection,
  testDatabaseConnection,
  testDatabaseDraft,
  updateDatabaseConnection,
} from '../src/database-connections.js'
import { resolveSecret } from '../src/secrets.js'

const tempDirs: string[] = []

function testDb() {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  db.exec(`
    INSERT INTO companies (id, name, slug, status, created_at) VALUES ('c1', '测试公司', 'test', 'active', 1);
    INSERT INTO companies (id, name, slug, status, created_at) VALUES ('c2', '另一家公司', 'other', 'active', 1);
  `)
  return db
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'eab-database-'))
  tempDirs.push(dir)
  return dir
}

function sqliteFixture(dir: string): string {
  const file = join(dir, 'business.db')
  const database = openDatabase({ path: file })
  database.exec('CREATE TABLE demo (id INTEGER PRIMARY KEY, name TEXT)')
  for (let index = 1; index <= 120; index += 1) {
    database.prepare('INSERT INTO demo (name) VALUES (?)').run(`row-${String(index).padStart(3, '0')}`)
  }
  database.close()
  return file
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* Windows 上偶发占用，测试临时目录留待系统清理 */
    }
  }
})

describe('database connections', () => {
  it('creates, tests, updates and deletes a real SQLite connection', async () => {
    const db = testDb()
    const dir = tempDir()
    const file = sqliteFixture(dir)
    const secretPath = join(dir, 'eab.db')

    const created = createDatabaseConnection(db, secretPath, 'c1', {
      name: '业务库',
      kind: 'sqlite',
      filePath: file,
    })
    expect(created.status).toBe('untested')
    expect(created.target).toContain('business.db')

    const listed = listDatabaseConnections(db, secretPath, 'c1')
    expect(listed.items).toHaveLength(1)
    expect(listed.counts.untested).toBe(1)
    expect(listDatabaseConnections(db, secretPath, 'c2').items).toHaveLength(0)

    const tested = await testDatabaseConnection(db, secretPath, 'c1', created.id)
    expect(tested.result.ok).toBe(true)
    expect(tested.result.detail).toContain('SQLite')
    expect(tested.connection.status).toBe('ok')
    expect(tested.connection.latencyMs).toBeGreaterThanOrEqual(0)

    const renamed = updateDatabaseConnection(db, secretPath, 'c1', created.id, { name: '业务只读库' })
    expect(renamed.name).toBe('业务只读库')
    expect(renamed.status).toBe('ok')

    const deleted = deleteDatabaseConnection(db, secretPath, 'c1', created.id)
    expect(deleted.name).toBe('业务只读库')
    expect(listDatabaseConnections(db, secretPath, 'c1').items).toHaveLength(0)
  })

  it('keeps passwords in secrets.json and never exposes them in list views', () => {
    const db = testDb()
    const dir = tempDir()
    const secretPath = join(dir, 'eab.db')

    const created = createDatabaseConnection(db, secretPath, 'c1', {
      name: '报表 PostgreSQL',
      kind: 'postgres',
      host: '127.0.0.1',
      port: 5432,
      database: 'reporting',
      username: 'reader',
      password: 'p@ss-word',
      ssl: true,
    })
    expect(created.passwordConfigured).toBe(true)
    const ref = (db.prepare('SELECT secret_ref FROM database_connections WHERE id = ?').get(created.id) as {
      secret_ref: string
    }).secret_ref
    expect(ref).toMatch(/^EAB_DATABASE_PASSWORD_/)
    expect(resolveSecret(secretPath, ref)).toBe('p@ss-word')
    expect(JSON.stringify(listDatabaseConnections(db, secretPath, 'c1'))).not.toContain('p@ss-word')

    // 编辑时留空密码应保留原密钥，而不是把已保存的密码清掉。
    const updated = updateDatabaseConnection(db, secretPath, 'c1', created.id, {
      name: '报表 PostgreSQL 只读',
      password: '',
    })
    expect(updated.passwordConfigured).toBe(true)
    expect(resolveSecret(secretPath, ref)).toBe('p@ss-word')

    const rotated = updateDatabaseConnection(db, secretPath, 'c1', created.id, {
      name: '报表 PostgreSQL 只读',
      password: 'new-secret',
    })
    expect(rotated.passwordConfigured).toBe(true)
    expect(resolveSecret(secretPath, ref)).toBe('new-secret')

    deleteDatabaseConnection(db, secretPath, 'c1', created.id)
    expect(resolveSecret(secretPath, ref)).toBe('')
  })

  it('validates names, drivers and connection fields', () => {
    const db = testDb()
    const dir = tempDir()
    const secretPath = join(dir, 'eab.db')

    expect(() =>
      createDatabaseConnection(db, secretPath, 'c1', { name: '空类型', kind: 'oracle' }),
    ).toThrow(/数据库类型不支持/)

    expect(() =>
      createDatabaseConnection(db, secretPath, 'c1', { name: '缺主机', kind: 'postgres', database: 'postgres' }),
    ).toThrow(/主机不能为空/)

    expect(() =>
      createDatabaseConnection(db, secretPath, 'c1', {
        name: '错误端口',
        kind: 'mysql',
        host: '127.0.0.1',
        port: 70000,
        database: 'app',
      }),
    ).toThrow(/端口需要/)

    const first = createDatabaseConnection(db, secretPath, 'c1', {
      name: '同名',
      kind: 'redis',
      host: '127.0.0.1',
    })
    expect(first.kind).toBe('redis')
    expect(first.category).toBe('cache')
    expect(first.categoryLabel).toBe('键值缓存')
    expect(first.supportsQuery).toBe(false)
    expect(first.supportsTls).toBe(true)

    const drivers = listDatabaseConnections(db, secretPath, 'c1').drivers
    expect(drivers.find((driver) => driver.id === 'redis')).toMatchObject({
      category: 'cache',
      supportsQuery: false,
      supportsTls: true,
    })
    expect(drivers.find((driver) => driver.id === 'sqlite')).toMatchObject({
      category: 'file',
      supportsQuery: true,
      supportsTls: false,
    })
    expect(drivers.filter((driver) => driver.category === 'relational').map((driver) => driver.id)).toEqual([
      'postgres',
      'mysql',
    ])
    expect(() =>
      createDatabaseConnection(db, secretPath, 'c1', { name: '同名', kind: 'redis', host: '127.0.0.1' }),
    ).toThrow(/已有名为/)

    // 不同公司可以使用相同名称。
    expect(
      createDatabaseConnection(db, secretPath, 'c2', { name: '同名', kind: 'redis', host: '127.0.0.1' }).id,
    ).toBeTruthy()
  })

  it('tests an unsaved draft without writing the saved status', async () => {
    const db = testDb()
    const dir = tempDir()
    const file = sqliteFixture(dir)
    const secretPath = join(dir, 'eab.db')

    const created = createDatabaseConnection(db, secretPath, 'c1', {
      name: '草稿测试',
      kind: 'sqlite',
      filePath: file,
    })

    const ok = await testDatabaseDraft(db, secretPath, 'c1', {
      id: created.id,
      kind: 'sqlite',
      name: created.name,
      filePath: file,
    })
    expect(ok.ok).toBe(true)

    const missing = await testDatabaseDraft(db, secretPath, 'c1', {
      kind: 'sqlite',
      name: '坏路径',
      filePath: join(dir, 'missing.db'),
    })
    expect(missing.ok).toBe(false)
    expect(missing.error).toContain('文件不存在')

    const stillUntested = listDatabaseConnections(db, secretPath, 'c1').items[0]
    expect(stillUntested.status).toBe('untested')
  })

  it('runs a single read-only query, caps rows and rejects writes', async () => {
    const db = testDb()
    const dir = tempDir()
    const file = sqliteFixture(dir)
    const secretPath = join(dir, 'eab.db')

    const created = createDatabaseConnection(db, secretPath, 'c1', {
      name: '查询验收库',
      kind: 'sqlite',
      filePath: file,
    })

    const first = await queryDatabaseConnection(
      db,
      secretPath,
      'c1',
      created.id,
      'SELECT id, name FROM demo ORDER BY id LIMIT 3',
    )
    expect(first.result.ok).toBe(true)
    expect(first.result.columns).toEqual(['id', 'name'])
    expect(first.result.rows).toHaveLength(3)
    expect(first.result.rows[0]?.name).toBe('row-001')
    expect(first.result.truncated).toBe(false)

    const limited = await queryDatabaseConnection(db, secretPath, 'c1', created.id, 'SELECT id FROM demo')
    expect(limited.result.ok).toBe(true)
    expect(limited.result.rows).toHaveLength(100)
    expect(limited.result.truncated).toBe(true)

    const write = await queryDatabaseConnection(db, secretPath, 'c1', created.id, 'DELETE FROM demo')
    expect(write.result.ok).toBe(false)
    expect(write.result.error).toContain('只允许执行单条只读查询')

    const multiple = await queryDatabaseConnection(db, secretPath, 'c1', created.id, 'SELECT 1; SELECT 2')
    expect(multiple.result.ok).toBe(false)
    expect(multiple.result.error).toContain('一次只能执行一条 SQL')

    updateDatabaseConnection(db, secretPath, 'c1', created.id, { enabled: false })
    await expect(
      queryDatabaseConnection(db, secretPath, 'c1', created.id, 'SELECT 1'),
    ).rejects.toThrow(/连接已停用/)

    const redis = createDatabaseConnection(db, secretPath, 'c1', {
      name: 'Redis 不查询',
      kind: 'redis',
      host: '127.0.0.1',
    })
    const redisQuery = await queryDatabaseConnection(db, secretPath, 'c1', redis.id, 'PING')
    expect(redisQuery.result.ok).toBe(false)
    expect(redisQuery.result.error).toContain('Redis 暂不开放查询控制台')
  })
})
