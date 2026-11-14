import { afterEach, describe, expect, it } from 'vitest'
import { MemoryCache } from '../src/backends/cache.js'
import { setBackendRuntimeForTest } from '../src/backends/runtime.js'
import { bumpHotVersion, hotRead, hotReadVersioned, invalidateHotEverywhere, hotCacheStatus } from '../src/hot-cache.js'

afterEach(() => {
  setBackendRuntimeForTest(undefined)
})

describe('热数据读缓存', () => {
  it('TTL 内只计算一次，失效后重新计算', async () => {
    let calls = 0
    const loader = () => {
      calls += 1
      return { version: calls }
    }
    const first = await hotRead('test:single', 60, loader)
    const second = await hotRead('test:single', 60, loader)
    expect(first).toEqual({ version: 1 })
    expect(second).toEqual({ version: 1 })
    expect(calls).toBe(1)

    await invalidateHotEverywhere('test:single')
    const third = await hotRead('test:single', 60, loader)
    expect(third).toEqual({ version: 2 })
  })

  it('接 Redis（共享缓存）时读取同一份缓存', async () => {
    const cache = new MemoryCache(1_000)
    setBackendRuntimeForTest({ cache } as never)
    expect(hotCacheStatus()).toMatchObject({ shared: true })
    let calls = 0
    const loader = () => {
      calls += 1
      return 'value'
    }
    expect(await hotRead('test:shared', 60, loader)).toBe('value')
    expect(await hotRead('test:shared', 60, loader)).toBe('value')
    expect(calls).toBe(1)
    // 共享缓存里确实写入了键
    expect(await cache.get('hot:test:shared')).toBe('value')
  })

  it('版本号 +1 后整族 key 立即失效', async () => {
    let calls = 0
    const loader = () => {
      calls += 1
      return calls
    }
    const a = await hotReadVersioned('models', 'c1:u1', 60, loader)
    const b = await hotReadVersioned('models', 'c1:u1', 60, loader)
    expect(a).toBe(1)
    expect(b).toBe(1)
    await bumpHotVersion('models')
    const c = await hotReadVersioned('models', 'c1:u1', 60, loader)
    expect(c).toBe(2)
  })
})
