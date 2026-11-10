import { describe, expect, it, vi } from 'vitest'
import { publishChatEvent, subscribeChatEvents, type ChatLiveDeltaEvent, type ChatLiveEvent } from '../src/chat-events.js'

const sample: ChatLiveEvent = {
  type: 'message',
  companyId: 'c1',
  userId: 'u1',
  sessionId: 's1',
  message: { id: 'm1', role: 'assistant', text: 'ok', createdAt: new Date(0).toISOString() },
}

const delta: ChatLiveDeltaEvent = {
  type: 'delta',
  companyId: 'c1',
  userId: 'u1',
  sessionId: 's1',
  messageId: 'm1',
  kind: 'content',
  text: '正文',
}

describe('对话实时事件总线', () => {
  it('把增量正文和最终消息都投递给订阅者', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeChatEvents(listener)
    publishChatEvent(delta)
    publishChatEvent(sample)
    expect(listener).toHaveBeenNthCalledWith(1, delta)
    expect(listener).toHaveBeenNthCalledWith(2, sample)
    unsubscribe()
  })

  it('只把消息发给当前订阅者，并在取消订阅后停止投递', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeChatEvents(listener)
    publishChatEvent(sample)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(sample)
    unsubscribe()
    publishChatEvent(sample)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('单个订阅者抛错不影响其它订阅者', () => {
    const good = vi.fn()
    const offBad = subscribeChatEvents(() => {
      throw new Error('sse write failed')
    })
    const offGood = subscribeChatEvents(good)
    expect(() => publishChatEvent(sample)).not.toThrow()
    expect(good).toHaveBeenCalledTimes(1)
    offBad()
    offGood()
  })
})
