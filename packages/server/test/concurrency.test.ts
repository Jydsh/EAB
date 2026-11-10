import { describe, expect, it } from 'vitest'
import {
  KeyedMutex,
  KeyedSemaphore,
  LockAbortedError,
  LockTimeoutError,
  SemaphoreQueueFullError,
  SemaphoreTimeoutError,
} from '../src/concurrency.js'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('KeyedMutex', () => {
  it('同一个 key 串行执行，后来者按 FIFO 排队', async () => {
    const mutex = new KeyedMutex()
    const order: string[] = []

    const first = mutex.runExclusive('file:a', async () => {
      order.push('first:start')
      await sleep(30)
      order.push('first:end')
    })

    const second = mutex.runExclusive('file:a', async () => {
      order.push('second:start')
      order.push('second:end')
    })

    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end'])
    expect(mutex.isHeld('file:a')).toBe(false)
  })

  it('不同 key 可以并行，不会互相阻塞', async () => {
    const mutex = new KeyedMutex()
    let releaseA: () => void = () => {}
    const heldA = new Promise<void>((resolve) => {
      releaseA = resolve
    })

    const a = mutex.runExclusive('file:a', async () => {
      await heldA
    })
    const b = mutex.runExclusive('file:b', async () => 'b-done')

    await expect(b).resolves.toBe('b-done')
    releaseA()
    await a
  })

  it('release 重复调用不会把锁交给多个持有者', async () => {
    const mutex = new KeyedMutex()
    const release = await mutex.acquire('file:a')
    release()
    release()

    const next = await mutex.acquire('file:a')
    expect(mutex.isHeld('file:a')).toBe(true)
    next()
    expect(mutex.isHeld('file:a')).toBe(false)
  })

  it('等待超时会从队列摘除，后续请求仍能拿到锁', async () => {
    const mutex = new KeyedMutex()
    const release = await mutex.acquire('file:a')

    await expect(
      mutex.acquire('file:a', { timeoutMs: 20 }),
    ).rejects.toBeInstanceOf(LockTimeoutError)

    release()
    const next = await mutex.acquire('file:a', { timeoutMs: 20 })
    expect(mutex.isHeld('file:a')).toBe(true)
    next()
  })

  it('AbortSignal 能取消等待中的请求', async () => {
    const mutex = new KeyedMutex()
    const release = await mutex.acquire('file:a')
    const controller = new AbortController()

    const waiting = mutex.acquire('file:a', { signal: controller.signal })
    controller.abort()

    await expect(waiting).rejects.toBeInstanceOf(LockAbortedError)
    release()
  })
})

describe('KeyedSemaphore', () => {
  it('同一 key 按 limit 并发，超过 limit 的按 FIFO 排队', async () => {
    const gate = new KeyedSemaphore()
    const order: string[] = []
    const first = await gate.acquire('tool:a', { limit: 2, timeoutMs: 500 })
    const second = await gate.acquire('tool:a', { limit: 2, timeoutMs: 500 })
    expect(gate.stats()).toMatchObject({ active: 2, queued: 0 })

    let thirdStarted = false
    const third = gate.acquire('tool:a', { limit: 2, timeoutMs: 500 }).then((release) => {
      thirdStarted = true
      order.push('third')
      return release
    })
    await Promise.resolve()
    expect(thirdStarted).toBe(false)

    first()
    const thirdRelease = await third
    expect(thirdStarted).toBe(true)
    expect(order).toEqual(['third'])
    second()
    thirdRelease()
    expect(gate.stats()).toMatchObject({ active: 0, queued: 0 })
  })

  it('排队满和等待超时会明确拒绝，不会永久占名额', async () => {
    const gate = new KeyedSemaphore()
    const release = await gate.acquire('tool:a', { limit: 1, queueLimit: 1 })

    const waiting = gate.acquire('tool:a', { limit: 1, queueLimit: 1, timeoutMs: 20 })
    await expect(gate.acquire('tool:a', { limit: 1, queueLimit: 1, timeoutMs: 20 })).rejects.toBeInstanceOf(
      SemaphoreQueueFullError,
    )
    await expect(waiting).rejects.toBeInstanceOf(SemaphoreTimeoutError)
    expect(gate.pending('tool:a')).toBe(0)
    release()
    expect(gate.stats()).toMatchObject({ active: 0, queued: 0 })
  })
})
