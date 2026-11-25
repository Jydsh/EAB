import { beforeEach, describe, expect, it } from 'vitest'
import { hostname } from 'node:os'
import { createSharedCache } from './helpers/shared-cache.js'
import {
  acquireCoordinationLock,
  acquireCoordinationSlot,
  acquireLeaderHold,
  claimOnce,
  clearRunAlive,
  coordinationStatus,
  hitRate,
  isRunAlive,
  markRunAlive,
  readLeaderOwner,
  resetCoordinationForTest,
  runAsLeader,
} from '../src/backends/coordination.js'
import { setBackendRuntimeForTest } from '../src/backends/runtime.js'

beforeEach(() => {
  setBackendRuntimeForTest(undefined)
  resetCoordinationForTest()
})

describe('协作层频控', () => {
  it('没有外部缓存时用进程内计数，只在额度内放行', async () => {
    const key = `test:${Math.random()}`
    const first = await hitRate(key, 2, 60)
    const second = await hitRate(key, 2, 60)
    const third = await hitRate(key, 2, 60)
    expect(first.allowed).toBe(true)
    expect(second.allowed).toBe(true)
    expect(third.allowed).toBe(false)
    expect(third.count).toBe(3)
    expect(third.retryAfterSec).toBeGreaterThan(0)
    expect(coordinationStatus().shared).toBe(false)
  })

  it('接入外部缓存后计数共享，状态标记为共享', async () => {
    const shared = createSharedCache(10_000)
    setBackendRuntimeForTest({ cache: shared } as never)
    const key = `test:${Math.random()}`
    const verdict = await hitRate(key, 1, 60)
    expect(verdict.allowed).toBe(true)
    const next = await hitRate(key, 1, 60)
    expect(next.allowed).toBe(false)
    expect(coordinationStatus().shared).toBe(true)
    expect(coordinationStatus().backend).toBe('redis')
  })

  it('Redis 读失败时退回进程内，不抛错', async () => {
    const broken = {
      id: 'redis',
      status: () => ({ state: 'ready' }),
      incr: () => Promise.reject(new Error('connection lost')),
      get: () => Promise.reject(new Error('connection lost')),
      set: () => Promise.reject(new Error('connection lost')),
      del: () => Promise.resolve(0),
      close: () => Promise.resolve(),
    }
    setBackendRuntimeForTest({ cache: broken } as never)
    const key = `test:${Math.random()}`
    const verdict = await hitRate(key, 5, 60)
    expect(verdict.allowed).toBe(true)
  })

  it('共享层降级后仍会探测外部缓存，恢复后重新标记为共享', async () => {
    let healthy = false
    const flaky = {
      id: 'redis',
      status: () => ({ state: healthy ? 'ready' : 'degraded' }),
      incr: async () => {
        healthy = true
        return 1
      },
    }
    setBackendRuntimeForTest({ cache: flaky } as never)
    const verdict = await hitRate(`test:${Math.random()}`, 5, 60)
    expect(verdict.allowed).toBe(true)
    expect(coordinationStatus().shared).toBe(true)
  })
})

describe('协作层事件去重', () => {
  it('同一事件第一次返回 true，后续返回 false', async () => {
    const eventKey = `evt:${Math.random()}`
    expect(await claimOnce(eventKey, 60)).toBe(true)
    expect(await claimOnce(eventKey, 60)).toBe(false)
  })

  it('并发重投时只有一个调用方拿到 true', async () => {
    const eventKey = `evt:${Math.random()}`
    const results = await Promise.all(
      Array.from({ length: 8 }, () => claimOnce(eventKey, 60)),
    )
    expect(results.filter(Boolean)).toHaveLength(1)
  })
})

describe('协作层互斥锁', () => {
  it('共享层在线时同一 key 只允许一个持有者，释放后交接', async () => {
    setBackendRuntimeForTest({ cache: createSharedCache(10_000) } as never)
    const first = await acquireCoordinationLock('agent:session:s1', { ttlMs: 5_000, waitMs: 100 })
    let secondDone = false
    const pending = acquireCoordinationLock('agent:session:s1', { ttlMs: 5_000, waitMs: 800 }).then((lease) => {
      secondDone = true
      return lease
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(secondDone).toBe(false)

    first.release()
    const second = await pending
    expect(secondDone).toBe(true)
    second.release()
  })

  it('等不到锁时抛 LOCK_TIMEOUT', async () => {
    setBackendRuntimeForTest({ cache: createSharedCache(10_000) } as never)
    const held = await acquireCoordinationLock('agent:session:s2', { ttlMs: 5_000, waitMs: 100 })
    await expect(
      acquireCoordinationLock('agent:session:s2', { ttlMs: 5_000, waitMs: 200 }),
    ).rejects.toThrow('等待资源锁超时')
    held.release()
  })

  it('没有共享层时退化为进程内锁，仍然互斥', async () => {
    const held = await acquireCoordinationLock('local:only', { ttlMs: 5_000, waitMs: 100 })
    await expect(acquireCoordinationLock('local:only', { ttlMs: 5_000, waitMs: 150 })).rejects.toThrow(
      '等待资源锁超时',
    )
    held.release()
  })
})

describe('协作层并发名额（信号量）', () => {
  it('共享层在线时上限跨实例生效，释放后交接', async () => {
    setBackendRuntimeForTest({ cache: createSharedCache(10_000) } as never)
    const first = await acquireCoordinationSlot('tool:demo', { limit: 1, ttlSec: 10, waitMs: 100 })
    let secondDone = false
    const pending = acquireCoordinationSlot('tool:demo', { limit: 1, ttlSec: 10, waitMs: 2_000 }).then((lease) => {
      secondDone = true
      return lease
    })
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(secondDone).toBe(false)

    first.release()
    const second = await pending
    expect(secondDone).toBe(true)
    second.release()
  })

  it('等不到名额时抛 SEMAPHORE_TIMEOUT', async () => {
    setBackendRuntimeForTest({ cache: createSharedCache(10_000) } as never)
    const held = await acquireCoordinationSlot('tool:busy', { limit: 1, ttlSec: 10, waitMs: 100 })
    await expect(
      acquireCoordinationSlot('tool:busy', { limit: 1, ttlSec: 10, waitMs: 300 }),
    ).rejects.toThrow('等待并发名额超时')
    held.release()
  })

  it('离线时退回进程内信号量，同样有上限', async () => {
    const held = await acquireCoordinationSlot('tool:local', { limit: 1, ttlSec: 10, waitMs: 100 })
    await expect(
      acquireCoordinationSlot('tool:local', { limit: 1, ttlSec: 10, waitMs: 200 }),
    ).rejects.toThrow('等待并发名额超时')
    held.release()
  })
})

describe('定时任务领导权', () => {  it('共享层在线时同一时刻只有一个实例执行任务', async () => {
    setBackendRuntimeForTest({ cache: createSharedCache(10_000) } as never)
    let concurrent = 0
    let maxConcurrent = 0
    const task = async () => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise((resolve) => setTimeout(resolve, 250))
      concurrent -= 1
    }
    const first = runAsLeader('retention', 5_000, task)
    const second = runAsLeader('retention', 5_000, task)
    const [a, b] = await Promise.all([first, second])
    expect(a.ran).toBe(true)
    expect(b.ran).toBe(false)
    expect(maxConcurrent).toBe(1)
  })

  it('离线时直接执行，等同单实例旧行为', async () => {
    let ran = 0
    const result = await runAsLeader('retention', 5_000, () => {
      ran += 1
    })
    expect(result.ran).toBe(true)
    expect(ran).toBe(1)
  })
})

describe('协作层 run 心跳', () => {  it('写入后可见，清理后不可见', async () => {
    const runId = `run-${Math.random()}`
    expect(await isRunAlive(runId)).toBe(false)
    await markRunAlive(runId, 30)
    expect(await isRunAlive(runId)).toBe(true)
    await clearRunAlive(runId)
    expect(await isRunAlive(runId)).toBe(false)
  })
})

describe('长连接领导权', () => {
  it('写入实例元数据，并可按 key 读回持有者', async () => {
    setBackendRuntimeForTest({ cache: createSharedCache(10_000) } as never)
    const key = `stream-meta-${Math.random()}`
    const hold = await acquireLeaderHold(key, { ttlMs: 5_000 })
    expect(hold).not.toBeNull()
    expect(hold?.owner.host).toBe(hostname())
    expect(hold?.owner.pid).toBe(process.pid)
    expect((await readLeaderOwner(key))?.instanceId).toBe(hold?.owner.instanceId)
    hold?.release()
  })

  it('同机旧进程已退出时立即接管，不等 90 秒 TTL', async () => {
    setBackendRuntimeForTest({ cache: createSharedCache(10_000) } as never)
    const key = `stream-dead-${Math.random()}`
    const stale = JSON.stringify({
      v: 1,
      token: 'stale-token',
      owner: { instanceId: 'stale', host: hostname(), pid: 2_147_483_646, startedAt: 1 },
    })
    // 用同一个缓存实例，确保读到上面预置的 key。
    const cache = createSharedCache(10_000)
    setBackendRuntimeForTest({ cache } as never)
    await cache.setIfAbsent(`leader:${key}`, stale, 60)
    const hold = await acquireLeaderHold(key, { ttlMs: 5_000, waitMs: 0 })
    expect(hold).not.toBeNull()
    expect(hold?.owner.pid).toBe(process.pid)
    expect(await cache.get(`leader:${key}`)).not.toBe(stale)
    hold?.release()
  })

  it('同机进程仍存活或旧版本租约时不接管', async () => {
    setBackendRuntimeForTest({ cache: createSharedCache(10_000) } as never)
    const cache = createSharedCache(10_000)
    setBackendRuntimeForTest({ cache } as never)
    const liveKey = `stream-live-${Math.random()}`
    const live = JSON.stringify({
      v: 1,
      token: 'live-token',
      owner: { instanceId: 'live', host: hostname(), pid: process.pid, startedAt: 1 },
    })
    await cache.setIfAbsent(`leader:${liveKey}`, live, 60)
    expect(await acquireLeaderHold(liveKey, { ttlMs: 5_000, waitMs: 0 })).toBeNull()

    const legacyKey = `stream-legacy-${Math.random()}`
    await cache.setIfAbsent(`leader:${legacyKey}`, 'legacy-token', 60)
    expect(await acquireLeaderHold(legacyKey, { ttlMs: 5_000, waitMs: 0 })).toBeNull()
  })
})
