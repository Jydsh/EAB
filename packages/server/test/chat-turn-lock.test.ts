import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { acquireTurn, releaseTurn } from '../src/routes/chat.js'

describe('会话级串行锁', () => {
  it('同一会话后来的消息排队，前一轮释放后拿到锁', async () => {
    const sessionId = `queue-${randomUUID()}`
    const firstToken = await acquireTurn(sessionId)

    let secondToken: string | null = null
    const secondPromise = acquireTurn(sessionId)
    const second = secondPromise.then((token) => {
      secondToken = token
    })

    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(secondToken).toBeNull()

    releaseTurn(sessionId, firstToken)
    await second
    expect(secondToken).not.toBeNull()

    const acquiredToken = await secondPromise
    releaseTurn(sessionId, acquiredToken)
  })
})
