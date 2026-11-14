import { describe, expect, it, afterEach } from 'vitest'
import { createChatCapacity } from '../src/chat-capacity.js'
import { MemoryCache } from '../src/backends/cache.js'
import { setBackendRuntimeForTest } from '../src/backends/runtime.js'

describe('网页对话并发闸门', () => {
  it('满员时按顺序排队，排队满后拒绝新请求', async () => {
    const capacity = createChatCapacity({
      maxConcurrent: 1,
      queueLimit: 1,
      queueTimeoutMs: 500,
      maxInFlightPerUser: 2,
      messagesPerMinute: 100,
    })

    const first = await capacity.acquire('u1')
    let secondDone = false
    const second = capacity.acquire('u2').then((slot) => {
      secondDone = true
      return slot
    })

    await expect(capacity.acquire('u3')).rejects.toThrow('排队已满')
    expect(secondDone).toBe(false)

    first.release()
    const secondSlot = await second
    expect(secondDone).toBe(true)
    secondSlot.release()
  })

  it('同一个人最多在途 N 条，且每分钟有上限', async () => {
    const capacity = createChatCapacity({
      maxConcurrent: 10,
      queueLimit: 10,
      queueTimeoutMs: 500,
      maxInFlightPerUser: 1,
      messagesPerMinute: 2,
    })

    const first = await capacity.acquire('u1')
    await expect(capacity.acquire('u1')).rejects.toThrow('已有回答正在生成')
    first.release()

    const second = await capacity.acquire('u1')
    second.release()

    await expect(capacity.acquire('u1')).rejects.toThrow('发送太快')
  })

  it('maxInFlightPerUser 为 0 时同一用户可同时开多个会话', async () => {
    const capacity = createChatCapacity({
      maxConcurrent: 10,
      queueLimit: 10,
      queueTimeoutMs: 500,
      maxInFlightPerUser: 0,
      messagesPerMinute: 100,
    })

    const slots = await Promise.all(
      Array.from({ length: 5 }, () => capacity.acquire('u1')),
    )
    expect(capacity.stats().active).toBe(5)
    for (const slot of slots) slot.release()
    expect(capacity.stats().active).toBe(0)
  })

  it('排队等待超时会释放名额，不会永久占住', async () => {
    const capacity = createChatCapacity({
      maxConcurrent: 1,
      queueLimit: 5,
      queueTimeoutMs: 40,
      maxInFlightPerUser: 2,
      messagesPerMinute: 100,
    })

    const first = await capacity.acquire('u1')
    await expect(capacity.acquire('u2')).rejects.toThrow('排队等待超时')
    first.release()
    expect(capacity.stats()).toMatchObject({ active: 0, queued: 0 })
  })

  it('同一模型达到上限后排队，换一个模型可以立即执行', async () => {
    const capacity = createChatCapacity({
      maxConcurrent: 10,
      queueLimit: 5,
      queueTimeoutMs: 500,
      maxInFlightPerUser: 2,
      messagesPerMinute: 100,
      modelMaxConcurrent: 1,
    })

    const first = await capacity.acquire('u1', { companyId: 'c1', modelId: 'm1' })
    let secondSameModelDone = false
    const secondSameModel = capacity
      .acquire('u2', { companyId: 'c1', modelId: 'm1' })
      .then((slot) => {
        secondSameModelDone = true
        return slot
      })
    const otherModel = await capacity.acquire('u3', { companyId: 'c1', modelId: 'm2' })
    expect(secondSameModelDone).toBe(false)
    expect(capacity.stats().models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ modelId: 'm1', active: 1, queued: 1 }),
        expect.objectContaining({ modelId: 'm2', active: 1, queued: 0 }),
      ]),
    )

    first.release()
    const secondSlot = await secondSameModel
    expect(secondSameModelDone).toBe(true)
    secondSlot.release()
    otherModel.release()
  })

  it('同一公司达到上限后排队，另一个公司不受影响', async () => {
    const capacity = createChatCapacity({
      maxConcurrent: 10,
      queueLimit: 5,
      queueTimeoutMs: 500,
      maxInFlightPerUser: 2,
      messagesPerMinute: 100,
      companyMaxConcurrent: 1,
    })

    const first = await capacity.acquire('u1', { companyId: 'c1', modelId: 'm1' })
    let sameCompanyDone = false
    const sameCompany = capacity
      .acquire('u2', { companyId: 'c1', modelId: 'm2' })
      .then((slot) => {
        sameCompanyDone = true
        return slot
      })
    const otherCompany = await capacity.acquire('u3', { companyId: 'c2', modelId: 'm3' })
    expect(sameCompanyDone).toBe(false)
    first.release()
    const sameCompanySlot = await sameCompany
    expect(sameCompanyDone).toBe(true)
    sameCompanySlot.release()
    otherCompany.release()
  })
})

describe('接入共享缓存后的并发闸门', () => {
  afterEach(() => setBackendRuntimeForTest(undefined))

  function sharedOptions() {
    return {
      maxConcurrent: 1,
      queueLimit: 5,
      queueTimeoutMs: 800,
      maxInFlightPerUser: 2,
      messagesPerMinute: 100,
    }
  }

  it('两个实例共享同一份全局名额：一边占满，另一边必须等', async () => {
    setBackendRuntimeForTest({ cache: new MemoryCache(10_000) } as never)
    const a = createChatCapacity(sharedOptions())
    const b = createChatCapacity(sharedOptions())

    const slotA = await a.acquire('u1')
    let grantedB = false
    const pendingB = b.acquire('u2').then((slot) => {
      grantedB = true
      return slot
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(grantedB).toBe(false)

    slotA.release()
    const slotB = await pendingB
    expect(grantedB).toBe(true)
    slotB.release()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(a.stats().active).toBe(0)
    expect(b.stats().active).toBe(0)
  })

  it('同一模型的名额也跨实例共享', async () => {
    setBackendRuntimeForTest({ cache: new MemoryCache(10_000) } as never)
    const options = { ...sharedOptions(), maxConcurrent: 5, modelMaxConcurrent: 1 }
    const a = createChatCapacity(options)
    const b = createChatCapacity(options)

    const first = await a.acquire('u1', { companyId: 'c1', modelId: 'm1' })
    let otherModelDone = false
    const otherModel = b.acquire('u2', { companyId: 'c1', modelId: 'm1' }).then((slot) => {
      otherModelDone = true
      return slot
    })
    const different = await b.acquire('u3', { companyId: 'c1', modelId: 'm2' })
    expect(otherModelDone).toBe(false)

    first.release()
    const slot = await otherModel
    expect(otherModelDone).toBe(true)
    slot.release()
    different.release()
  })

  it('共享层报错时退回本地实现，不拒绝用户', async () => {
    const broken = {
      id: 'redis',
      status: () => ({ state: 'ready' }),
      adjust: () => Promise.reject(new Error('redis down')),
      incr: () => Promise.reject(new Error('redis down')),
      get: () => Promise.reject(new Error('redis down')),
      set: () => Promise.reject(new Error('redis down')),
      del: () => Promise.resolve(0),
      close: () => Promise.resolve(),
    }
    setBackendRuntimeForTest({ cache: broken } as never)
    const capacity = createChatCapacity({ ...sharedOptions(), maxConcurrent: 5, messagesPerMinute: 100 })
    // 频控读取失败会退回内存计数，名额预留失败会退回本地闸门
    const slot = await capacity.acquire('u1')
    expect(slot).toBeTruthy()
    slot.release()
  })
})
