import { afterEach, describe, expect, it } from 'vitest'
import { MemoryCache } from '../src/backends/cache.js'
import { setBackendRuntimeForTest } from '../src/backends/runtime.js'
import { hotGet, hotSet, hotCacheStatus } from '../src/hot-cache.js'
import {
  hydrateModelHealth,
  isModelHealthy,
  markModelHealthy,
  markModelUnhealthy,
} from '../src/model-health.js'

const KEY = 'model-health:share-test'

afterEach(() => {
  setBackendRuntimeForTest(undefined)
})

describe('模型健康状态跨实例共享', () => {
  it('接 Redis（共享缓存）时能读到 leader 的探测结论', async () => {
    const cache = new MemoryCache(1_000)
    setBackendRuntimeForTest({ cache } as never)
    expect(hotCacheStatus()).toMatchObject({ shared: true })

    await hotSet(KEY, { m1: { healthy: true, checkedAt: 1000, failures: 0, lastError: '' } }, 120)
    await hydrateModelHealth('share-test')
    expect(isModelHealthy('share-test', 'm1')).toBe(true)
    // 其它实例的本地表确实被合并
    expect(await cache.get('hot:model-health:share-test')).toMatchObject({ m1: { healthy: true } })
  })

  it('本实例更新的结论不会被旧快照覆盖', async () => {
    setBackendRuntimeForTest({ cache: new MemoryCache(1_000) } as never)
    markModelUnhealthy('share-test', 'm2', '上游 500')
    await hotSet(KEY, { m2: { healthy: true, checkedAt: Date.now() - 60_000, failures: 0, lastError: '' } }, 120)
    await hydrateModelHealth('share-test')
    expect(isModelHealthy('share-test', 'm2')).toBe(false)
  })

  it('健康结论会批量写回共享缓存', async () => {
    setBackendRuntimeForTest({ cache: new MemoryCache(1_000) } as never)
    markModelHealthy('push-test', 'm3')
    await new Promise((resolve) => setTimeout(resolve, 300))
    const shared = await hotGet<Record<string, unknown>>('model-health:push-test')
    expect(shared).toMatchObject({ m3: { healthy: true } })
  })
})
