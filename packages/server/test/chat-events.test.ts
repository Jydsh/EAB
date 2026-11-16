import { describe, expect, it, vi } from 'vitest'
import {
  isChatUserOnline,
  publishChatEvent,
  registerChatPresence,
  subscribeChatEvents,
  type ChatLiveDeltaEvent,
  type ChatLiveEvent,
} from '../src/chat-events.js'

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

  it('多标签页在线计数只在最后一个页面关闭后判定离线', () => {
    expect(isChatUserOnline('c-presence', 'u1')).toBe(false)
    const first = registerChatPresence('c-presence', 'u1')
    const second = registerChatPresence('c-presence', 'u1')
    expect(isChatUserOnline('c-presence', 'u1')).toBe(true)
    first()
    expect(isChatUserOnline('c-presence', 'u1')).toBe(true)
    second()
    expect(isChatUserOnline('c-presence', 'u1')).toBe(false)
  })

  it('重复释放同一个在线登记不会把计数减成负数', () => {
    const release = registerChatPresence('c-presence-2', 'u2')
    release()
    release()
    expect(isChatUserOnline('c-presence-2', 'u2')).toBe(false)
  })
})
