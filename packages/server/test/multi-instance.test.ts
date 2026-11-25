import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { migrate, openDatabase, type Db } from '@eab/storage'
import { loadConfig } from '../src/config.js'
import { SqliteCoordinationCache } from '../src/backends/coordination.js'
import { claimJob, completeJob, getJob, recoverStaleJobs, submitJob } from '../src/job-queue.js'

const dirs: string[] = []
const dbs: Db[] = []

afterEach(() => {
  for (const db of dbs.splice(0)) {
    try {
      db.close()
    } catch {
      // already closed
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDb(): { db: Db; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'eab-multi-'))
  dirs.push(dir)
  const path = join(dir, 'eab.db')
  const db = openDatabase({ path })
  migrate(db)
  dbs.push(db)
  db.prepare(
    `INSERT INTO companies (id, name, slug, status, created_at)
     VALUES ('c1', '多实例测试', 'multi', 'active', ?)`,
  ).run(Date.now())
  return { db, path }
}

describe('AGT-17 运行角色', () => {
  it('多实例必须显式指定 api 或 worker，不能继续用 all', () => {
    expect(() =>
      loadConfig({
        EAB_MULTI_INSTANCE: '1',
        EAB_SERVER_ROLE: 'all',
        EAB_HOST: '0.0.0.0',
        EAB_PORT: '18787',
        EAB_ADMIN_PORT: '18788',
      }),
    ).toThrow(/EAB_SERVER_ROLE/)
  })

  it('api / worker 角色可解析，默认仍是单机 all', () => {
    const api = loadConfig({
      EAB_MULTI_INSTANCE: '1',
      EAB_SERVER_ROLE: 'api',
      EAB_HOST: '0.0.0.0',
      EAB_PORT: '18787',
      EAB_ADMIN_PORT: '18788',
    })
    expect(api.serverRole).toBe('api')
    expect(api.multiInstance).toBe(true)

    const single = loadConfig({ EAB_HOST: '127.0.0.1', EAB_PORT: '18787', EAB_ADMIN_PORT: '18788' })
    expect(single.serverRole).toBe('all')
    expect(single.multiInstance).toBe(false)
  })
})

describe('AGT-17 数据库协调层', () => {
  it('两个连接抢同一个键时只有一个成功，释放后另一个可接手', async () => {
    const first = tempDb()
    const second = openDatabase({ path: first.path })
    dbs.push(second)
    const a = new SqliteCoordinationCache(first.db)
    const b = new SqliteCoordinationCache(second)

    expect(await a.setIfAbsent('lock:demo', 'owner-a', 60)).toBe(true)
    expect(await b.setIfAbsent('lock:demo', 'owner-b', 60)).toBe(false)
    expect(await b.compareAndTouch('lock:demo', 'owner-b', 0)).toBe(false)
    expect(await a.compareAndTouch('lock:demo', 'owner-a', 0)).toBe(true)
    expect(await b.setIfAbsent('lock:demo', 'owner-b', 60)).toBe(true)
  })

  it('计数与加减跨连接一致，过期后可重新抢占', async () => {
    const first = tempDb()
    const second = openDatabase({ path: first.path })
    dbs.push(second)
    const a = new SqliteCoordinationCache(first.db)
    const b = new SqliteCoordinationCache(second)
    const now = Date.now()

    expect(await a.incr('rate:demo', 60)).toBe(1)
    expect(await b.incr('rate:demo', 60)).toBe(2)
    expect(await a.adjust('slot:demo', 2, 60)).toBe(2)
    expect(await b.adjust('slot:demo', -1, 60)).toBe(1)

    await a.set('lease:demo', 'v1', 60)
    first.db.prepare('UPDATE runtime_coordination SET expires_at = ? WHERE key = ?').run(now - 1, 'lease:demo')
    expect(await b.get('lease:demo')).toBeNull()
    expect(await b.setIfAbsent('lease:demo', 'v2', 60)).toBe(true)
  })
})

describe('AGT-17 队列持久性', () => {
  it('进程崩溃后租约过期，另一个实例能接走同一作业并完成', () => {
    const first = tempDb()
    const second = openDatabase({ path: first.path })
    dbs.push(second)
    const job = submitJob(first.db, {
      companyId: 'c1',
      kind: 'test.multi-instance',
      title: '重启不丢',
      payload: { hello: 'world' },
    })

    const claimedA = claimJob(second, { workerId: 'worker-a', leaseMs: 30_000 })
    expect(claimedA?.id).toBe(job.id)
    expect(claimJob(first.db, { workerId: 'worker-b', leaseMs: 30_000 })).toBeNull()

    const recovered = recoverStaleJobs(first.db, Date.now() + 31_000)
    expect(recovered).toBe(1)
    const claimedB = claimJob(first.db, { workerId: 'worker-b', leaseMs: 30_000 })
    expect(claimedB?.id).toBe(job.id)
    expect(claimedB?.attempts).toBe(2)
    completeJob(first.db, job.id, 'worker-b', { ok: true })
    expect(getJob(first.db, 'c1', job.id)?.status).toBe('succeeded')
  })
})
