import { afterEach, describe, expect, it } from 'vitest'
import { MemoryCache } from '../src/backends/cache.js'
import {
  coordinationStatus,
  readCapacityCount,
  reserveCapacity,
  resetCoordinationForTest,
} from '../src/backends/coordination.js'
import { setBackendRuntimeForTest } from '../src/backends/runtime.js'
import { sharedToolCapacityStats } from '../src/routes/tools.js'

afterEach(() => {
  setBackendRuntimeForTest(undefined)
  resetCoordinationForTest()
})

describe('共享并发数回读', () => {
  it('未接共享层时读回为 null，面板继续用本实例统计', async () => {
    expect(coordinationStatus().shared).toBe(false)
    expect(await readCapacityCount('tool:tool.search')).toBeNull()
    expect(await sharedToolCapacityStats()).toBeNull()
  })

  it('共享层在线时能读回全局占用数', async () => {
    setBackendRuntimeForTest({ cache: new MemoryCache(1_000) } as never)
    const reservation = await reserveCapacity([{ key: 'tool:tool.search', limit: 4 }])
    expect(reservation.ok).toBe(true)
    if (reservation.ok) {
      expect(await readCapacityCount('tool:tool.search')).toBe(1)
      const stats = await sharedToolCapacityStats()
      expect(stats?.total).toBe(1)
      expect(stats?.keys[0]).toMatchObject({ key: 'tool:tool.search', active: 1 })
      reservation.lease.release()
    }
  })

  it('名额释放后读数回到 0', async () => {
    setBackendRuntimeForTest({ cache: new MemoryCache(1_000) } as never)
    const reservation = await reserveCapacity([{ key: 'tool:tool.search', limit: 4 }])
    if (reservation.ok) reservation.lease.release()
    // release 是异步发的，等一拍再读
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(await readCapacityCount('tool:tool.search')).toBe(0)
    const stats = await sharedToolCapacityStats()
    expect(stats?.total).toBe(0)
    expect(stats?.keys).toHaveLength(0)
  })
})
