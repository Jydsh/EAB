import { afterEach, describe, expect, it } from 'vitest'
import { MemoryCache } from '../src/backends/cache.js'
import { acquireLeaderHold, resetCoordinationForTest } from '../src/backends/coordination.js'
import { setBackendRuntimeForTest } from '../src/backends/runtime.js'

afterEach(() => {
  setBackendRuntimeForTest(undefined)
  resetCoordinationForTest()
})

function sharedCache(): MemoryCache {
  const cache = new MemoryCache(1_000)
  setBackendRuntimeForTest({ cache } as never)
  return cache
}

describe('长期领导权（长连接托管）', () => {
  it('未接共享层时直接持有，释放后失效', async () => {
    const hold = await acquireLeaderHold('stream:test')
    expect(hold).not.toBeNull()
    expect(hold!.shared).toBe(false)
    expect(hold!.isHeld()).toBe(true)
    hold!.release()
    expect(hold!.isHeld()).toBe(false)
  })

  it('共享层在线时同一 key 只有一个实例持有，释放后下一个接手', async () => {
    sharedCache()
    const first = await acquireLeaderHold('stream:test')
    const second = await acquireLeaderHold('stream:test')
    expect(first).not.toBeNull()
    expect(second).toBeNull()

    first!.release()
    const third = await acquireLeaderHold('stream:test')
    expect(third).not.toBeNull()
    expect(third!.isHeld()).toBe(true)
    third!.release()
  })

  it('租约被别处删除后，续租失败会把 held 置为 false', async () => {
    const cache = sharedCache()
    const hold = await acquireLeaderHold('stream:lost', { ttlMs: 1200 })
    expect(hold!.isHeld()).toBe(true)
    await cache.del('leader:stream:lost')
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(hold!.isHeld()).toBe(false)
  })
})
