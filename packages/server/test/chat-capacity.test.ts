import { describe, expect, it } from 'vitest'
import { createChatCapacity } from '../src/chat-capacity.js'

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
