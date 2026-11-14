import { afterEach, describe, expect, it, vi } from 'vitest'
import { HybridCache, MemoryCache, RedisCache, type RedisLike } from '../src/backends/cache.js'
import { createAuditReader } from '../src/backends/audit-read.js'
import { createChatReader } from '../src/backends/chat-read.js'
import { PostgresAuditMirror } from '../src/backends/postgres.js'
import { PostgresChatMirror } from '../src/backends/postgres-chat.js'

describe('可选后端插件', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('没有 Redis 时内存缓存可读写并支持 TTL', async () => {
    vi.useFakeTimers()
    const cache = new MemoryCache(2)
    await cache.set('a', { value: 1 }, 10)
    expect(await cache.get<{ value: number }>('a')).toEqual({ value: 1 })
    vi.advanceTimersByTime(10_001)
    expect(await cache.get('a')).toBeNull()
    await cache.close()
  })

  it('Redis 命令失败时自动回退内存，且状态标为降级', async () => {
    const broken: RedisLike = {
      get: async () => {
        throw new Error('redis down')
      },
      set: async () => {
        throw new Error('redis down')
      },
      del: async () => {
        throw new Error('redis down')
      },
      incrBy: async () => {
        throw new Error('redis down')
      },
      expire: async () => 1,
    }
    const hybrid = new HybridCache(new RedisCache(broken, 'test:'), new MemoryCache())
    await hybrid.set('token', { value: 'ok' }, 30)
    expect(await hybrid.get<{ value: string }>('token')).toEqual({ value: 'ok' })
    expect(hybrid.status().state).toBe('degraded')
    expect(hybrid.status().detail).toContain('内存兜底')
    await hybrid.close()
  })

  it('Redis 恢复后状态自动回到 ready，不永久卡在降级', async () => {
    let down = true
    const flaky: RedisLike = {
      get: async () => {
        if (down) throw new Error('redis down')
        return null
      },
      set: async () => {
        if (down) throw new Error('redis down')
        return 'OK'
      },
      del: async () => 1,
      incrBy: async () => {
        if (down) throw new Error('redis down')
        return 1
      },
      expire: async () => 1,
    }
    const hybrid = new HybridCache(new RedisCache(flaky, 'test:'), new MemoryCache())
    await hybrid.set('token', { value: 'ok' }, 30)
    expect(hybrid.status().state).toBe('degraded')

    down = false
    await hybrid.set('token', { value: 'ok' }, 30)
    expect(hybrid.status().state).toBe('ready')
    expect(hybrid.status().detail).toBe('Redis 缓存可用，内存作为同进程兜底')
    await hybrid.close()
  })

  it('连接层报错立即标降级，后续命令成功恢复 ready', async () => {
    const client: RedisLike = {
      get: async () => null,
      set: async () => 'OK',
      del: async () => 1,
      incrBy: async () => 1,
      expire: async () => 1,
    }
    const cache = new RedisCache(client, 'test:')
    cache.markFailure(new Error('socket closed unexpectedly'))
    expect(cache.status().state).toBe('degraded')
    expect(cache.status().detail).toContain('socket closed unexpectedly')

    await cache.get('recover')
    expect(cache.status().state).toBe('ready')
  })

  it('Redis 命令挂住时按超时失败，不拖住调用方', async () => {
    const hanging: RedisLike = {
      get: () => new Promise<string | null>(() => undefined),
      set: async () => 'OK',
      del: async () => 1,
      incrBy: async () => 1,
      expire: async () => 1,
    }
    const hybrid = new HybridCache(new RedisCache(hanging, 'test:', 20), new MemoryCache())
    const started = Date.now()
    const value = await hybrid.get('missing')
    expect(value).toBeNull()
    expect(Date.now() - started).toBeLessThan(500)
    expect(hybrid.status().state).toBe('degraded')
    expect(hybrid.status().detail).toContain('超时')
    await hybrid.close()
  })

  it('PostgreSQL 审计镜像按批写入，不等待每条审计', async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = []
    const db = {
      query: async (sql: string, values?: readonly unknown[]) => {
        calls.push({ sql, values: values ?? [] })
        return { rows: [] }
      },
      end: async () => undefined,
    }
    const mirror = new PostgresAuditMirror(db, { batchSize: 2, flushIntervalMs: 10_000 })
    const record = {
      id: 'a1',
      seq: 1,
      companyId: 'c1',
      actorUserId: null,
      action: 'test',
      resourceType: null,
      resourceId: null,
      resourceScope: null,
      result: 'success',
      detailJson: null,
      traceId: null,
      ip: null,
      channel: null,
      prevHash: 'EAB-GENESIS',
      hash: 'h1',
      createdAt: 1,
    }
    mirror.append(record)
    mirror.append({ ...record, id: 'a2', seq: 2 })
    await mirror.flush()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.sql).toContain('ON CONFLICT')
    expect(calls[0]?.values).toHaveLength(32)
    expect(mirror.status().metrics?.written).toBe(2)
    await mirror.close()
  })

  it('PostgreSQL 审计镜像首次接入回填 SQLite 历史审计', async () => {
    const { appendAudit, migrate, openDatabase } = await import('@eab/storage')
    const sqlite = openDatabase({ path: ':memory:' })
    migrate(sqlite)
    appendAudit(sqlite, { companyId: 'c1', action: 'audit.first', result: 'success' }, 1000)
    appendAudit(sqlite, { companyId: 'c1', action: 'audit.second', result: 'success' }, 2000)

    const calls: Array<{ sql: string; values: readonly unknown[] }> = []
    const pg = {
      query: async (sql: string, values?: readonly unknown[]) => {
        calls.push({ sql, values: values ?? [] })
        if (sql.includes('MAX(seq)')) return { rows: [{ max_seq: '0' }] }
        return { rows: [] }
      },
      end: async () => undefined,
    }
    const mirror = new PostgresAuditMirror(pg)
    const count = await mirror.backfillFromSqlite(sqlite)
    expect(count).toBe(2)
    expect(calls.filter((call) => call.sql.includes('INSERT INTO eab_audit_mirror'))).toHaveLength(1)
    expect(calls.at(-1)?.values).toHaveLength(32)
    expect(mirror.status().metrics?.written).toBe(2)
    sqlite.close()
  })

  it('PostgreSQL 审计镜像可按公司筛选、分页并导出', async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = []
    const db = {
      query: async (sql: string, values?: readonly unknown[]) => {
        calls.push({ sql, values: values ?? [] })
        if (sql.includes('COUNT(*)')) return { rows: [{ n: '3' }] }
        if (sql.includes('LIMIT $')) {
          return {
            rows: [
              {
                id: 'a9',
                seq: '9',
                actor_user_id: 'u1',
                action: 'chat.send',
                resource_type: 'chat',
                resource_id: 'm1',
                result: 'success',
                detail_json: { ok: true },
                trace_id: null,
                ip: '127.0.0.1',
                channel: 'web',
                hash: 'h9',
                created_at: '1700000000000',
              },
            ],
          }
        }
        return { rows: [{ seq: 9, action: 'chat.send' }] }
      },
      end: async () => undefined,
    }
    const mirror = new PostgresAuditMirror(db, { batchSize: 2, flushIntervalMs: 10_000 })
    const page = await mirror.listAudit({
      companyId: 'c1',
      action: 'chat',
      actor: 'u1',
      result: 'success',
      from: 1000,
      to: 2000,
      limit: 30,
      offset: 60,
    })
    expect(page.total).toBe(3)
    expect((page.rows[0] as { hash: string }).hash).toBe('h9')
    const listCall = calls.find((call) => call.sql.includes('ORDER BY seq DESC LIMIT'))
    expect(listCall?.sql).toContain('company_id = $1')
    expect(listCall?.sql).toContain('action LIKE $2')
    expect(listCall?.sql).toContain('actor_user_id = $3')
    expect(listCall?.sql).toContain('result = $4')
    expect(listCall?.sql).toContain('created_at >= $5')
    expect(listCall?.sql).toContain('created_at <= $6')
    expect(listCall?.sql).toContain('LIMIT $7 OFFSET $8')
    expect(listCall?.values).toEqual(['c1', '%chat%', 'u1', 'success', 1000, 2000, 30, 60])

    const exported = await mirror.exportAudit('c1')
    expect(exported).toHaveLength(1)
    expect(calls.at(-1)?.sql).toContain('ORDER BY seq ASC LIMIT 100000')
    expect(calls.at(-1)?.values).toEqual(['c1'])
    await mirror.close()
  })

  it('审计镜像初始化会建只读查询索引', async () => {
    const calls: string[] = []
    const db = {
      query: async (sql: string) => {
        calls.push(sql)
        return { rows: [] }
      },
    }
    const mirror = new PostgresAuditMirror(db)
    await mirror.init()
    expect(calls.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS eab_audit_mirror'))).toBe(true)
    expect(calls.some((sql) => sql.includes('idx_eab_audit_mirror_company_seq'))).toBe(true)
    expect(calls.some((sql) => sql.includes('idx_eab_audit_mirror_company_created'))).toBe(true)
    await mirror.close()
  })

  it('审计只读仓储默认走 SQLite，并支持列筛选与导出', async () => {
    const { appendAudit, migrate, openDatabase, setAuditMirror } = await import('@eab/storage')
    const db = openDatabase({ path: ':memory:' })
    migrate(db)
    setAuditMirror(null)
    appendAudit(db, { companyId: 'c1', action: 'chat.send', result: 'success' }, 1000)
    appendAudit(db, { companyId: 'c1', action: 'auth.login', result: 'success' }, 2000)
    appendAudit(db, { companyId: 'c2', action: 'chat.send', result: 'success' }, 3000)
    const reader = createAuditReader(db, 'sqlite')
    const page = await reader.list({ companyId: 'c1', limit: 30, offset: 0 })
    expect(page.source).toBe('sqlite')
    expect(page.total).toBe(2)
    expect(page.rows).toHaveLength(2)
    const filtered = await reader.list({ companyId: 'c1', action: 'auth', limit: 30, offset: 0 })
    expect(filtered.total).toBe(1)
    expect(filtered.rows[0]?.action).toBe('auth.login')
    const exported = await reader.export('c1')
    expect(exported.source).toBe('sqlite')
    expect(exported.rows).toHaveLength(2)
    expect(exported.rows[0]?.seq).toBe(1)
    db.close()
  })

  it('EAB_AUDIT_READ=postgres 时优先读 PG 镜像', async () => {
    const mirror = {
      listAudit: async () => ({
        total: 1,
        rows: [{ id: 'a1', seq: 1, action: 'chat.send' }],
      }),
      exportAudit: async () => [{ seq: 1, action: 'chat.send' }],
    }
    const reader = createAuditReader(null as never, 'postgres', mirror as unknown as PostgresAuditMirror)
    const page = await reader.list({ companyId: 'c1', limit: 30, offset: 0 })
    expect(page.source).toBe('postgres')
    expect(page.total).toBe(1)
    expect(page.rows[0]?.id).toBe('a1')
    expect((await reader.export('c1')).source).toBe('postgres')
  })

  it('PG 审计读取失败时回退 SQLite，并带出原因', async () => {
    const { appendAudit, migrate, openDatabase, setAuditMirror } = await import('@eab/storage')
    const db = openDatabase({ path: ':memory:' })
    migrate(db)
    setAuditMirror(null)
    appendAudit(db, { companyId: 'c1', action: 'chat.send', result: 'success' }, 1000)
    const mirror = {
      listAudit: async () => {
        throw new Error('pg down')
      },
      exportAudit: async () => {
        throw new Error('pg down')
      },
    }
    const reader = createAuditReader(db, 'postgres', mirror as unknown as PostgresAuditMirror)
    const page = await reader.list({ companyId: 'c1', limit: 30, offset: 0 })
    expect(page.source).toBe('sqlite')
    expect(page.total).toBe(1)
    expect(page.fallbackReason).toContain('PG 审计读取失败')
    const exported = await reader.export('c1')
    expect(exported.source).toBe('sqlite')
    expect(exported.fallbackReason).toContain('PG 审计读取失败')
    db.close()
  })

  it('审计镜像失败不会反向影响主审计写入', async () => {
    const { appendAudit, migrate, openDatabase, setAuditMirror } = await import('@eab/storage')
    const db = openDatabase({ path: ':memory:' })
    migrate(db)
    setAuditMirror({
      append: () => {
        throw new Error('mirror down')
      },
    })
    const record = appendAudit(db, { companyId: 'c1', action: 'audit.test', result: 'success' }, 1000)
    expect(record.seq).toBe(1)
    expect((db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get() as { n: number }).n).toBe(1)
    setAuditMirror(null)
    db.close()
  })

  it('会话 outbox 捕获会话与助手消息，并批量镜像到 PG', async () => {
    const { migrate, openDatabase } = await import('@eab/storage')
    const db = openDatabase({ path: ':memory:' })
    migrate(db)
    // 镜像测试只关心 outbox 链路，不准备完整公司/用户外键数据。
    db.exec('PRAGMA foreign_keys = OFF')
    db.prepare(
      `INSERT INTO chat_sessions (id, company_id, user_id, title, created_at, updated_at, last_message_at)
       VALUES ('s1', 'c1', 'u1', '测试会话', 1000, 1000, 1000)`,
    ).run()
    db.prepare(
      `INSERT INTO chat_messages (id, company_id, session_id, user_id, role, text, created_at)
       VALUES ('m1', 'c1', 's1', 'u1', 'assistant', '回答', 2000)`,
    ).run()

    const session = db
      .prepare('SELECT last_assistant_at FROM chat_sessions WHERE id = ?')
      .get('s1') as { last_assistant_at: number }
    expect(session.last_assistant_at).toBe(2000)
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM eab_pg_outbox WHERE entity = 'chat_sessions'").get() as {
        n: number
      }).n,
    ).toBe(1)

    const calls: Array<{ sql: string; values: readonly unknown[] }> = []
    const pg = {
      query: async (sql: string, values?: readonly unknown[]) => {
        calls.push({ sql, values: values ?? [] })
        return { rows: [] }
      },
    }
    const mirror = new PostgresChatMirror(db, pg, { batchSize: 50, flushIntervalMs: 10_000 })
    await mirror.init()
    expect(mirror.pendingCount()).toBe(0)
    const upsert = calls.find((call) => call.sql.includes('INSERT INTO eab_chat_sessions_mirror'))
    expect(upsert?.values).toHaveLength(17)
    expect(upsert?.values[6]).toBe(1000)
    expect(upsert?.values[16]).toBe(2000)
    expect(mirror.status().metrics?.written).toBe(1)
    await mirror.close()
    db.close()
  })

  it('EAB_CHAT_READ=postgres 时优先读 PG，镜像未追平则回退 SQLite', async () => {
    const { migrate, openDatabase } = await import('@eab/storage')
    const db = openDatabase({ path: ':memory:' })
    migrate(db)
    db.exec('PRAGMA foreign_keys = OFF')
    db.prepare(
      `INSERT INTO chat_sessions (id, company_id, user_id, title, created_at, updated_at, last_message_at)
       VALUES ('s1', 'c1', 'u1', '测试会话', 1000, 1000, 1000)`,
    ).run()

    const pgMirror = {
      pendingCount: () => 0,
      listSessions: async () => [
        { id: 's1', title: 'PG 会话', source: 'web', created_at: '1000', updated_at: '1000', unread: 1 },
      ],
    }
    const reader = createChatReader(db, 'postgres', pgMirror as unknown as PostgresChatMirror)
    const page = await reader.list({ companyId: 'c1', userId: 'u1', limit: 50 })
    expect(page.source).toBe('postgres')
    expect(page.sessions[0]?.title).toBe('PG 会话')

    const pendingMirror = {
      ...pgMirror,
      pendingCount: () => 2,
    }
    const pendingReader = createChatReader(db, 'postgres', pendingMirror as unknown as PostgresChatMirror)
    const fallback = await pendingReader.list({ companyId: 'c1', userId: 'u1', limit: 50 })
    expect(fallback.source).toBe('sqlite')
    expect(fallback.fallbackReason).toContain('还有 2 条待同步')
    expect(fallback.sessions[0]?.title).toBe('测试会话')

    const failingMirror = {
      pendingCount: () => 0,
      listSessions: async () => {
        throw new Error('pg down')
      },
    }
    const failingReader = createChatReader(db, 'postgres', failingMirror as unknown as PostgresChatMirror)
    const failed = await failingReader.list({ companyId: 'c1', userId: 'u1', limit: 50 })
    expect(failed.source).toBe('sqlite')
    expect(failed.fallbackReason).toContain('PG 会话读取失败')
    db.close()
  })
})
