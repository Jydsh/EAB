import { afterEach, describe, expect, it } from 'vitest'
import {
  initChatEventBridge,
  publishChatEvent,
  subscribeChatEvents,
  type ChatLiveEventPayload,
} from '../src/chat-events.js'
import { PUBSUB_INSTANCE_ID, RedisPubSub, type PubSubBackend, type PubSubClientLike } from '../src/backends/pubsub.js'

class FakePubSub implements PubSubBackend {
  readonly id = 'fake'
  readonly shared = true
  readonly published: Array<{ channel: string; payload: string }> = []
  private readonly handlers = new Map<string, Set<(payload: string) => void>>()

  async publish(channel: string, payload: string): Promise<void> {
    this.published.push({ channel, payload })
  }

  async subscribe(channel: string, handler: (payload: string) => void): Promise<() => void> {
    let set = this.handlers.get(channel)
    if (!set) {
      set = new Set()
      this.handlers.set(channel, set)
    }
    set.add(handler)
    return () => set?.delete(handler)
  }

  deliverForTest(channel: string, payload: string): void {
    for (const handler of this.handlers.get(channel) ?? []) handler(payload)
  }
}

const sample: ChatLiveEventPayload = {
  type: 'delta',
  companyId: 'c1',
  userId: 'u1',
  sessionId: 's1',
  messageId: 'm1',
  kind: 'content',
  text: '你好',
}

afterEach(() => initChatEventBridge(null))

describe('对话事件跨实例广播', () => {
  it('有广播层时本地只收到一次，同时事件被发到别的实例', async () => {
    const bridge = new FakePubSub()
    initChatEventBridge(bridge)
    const received: ChatLiveEventPayload[] = []
    const off = subscribeChatEvents((event) => received.push(event))

    publishChatEvent(sample)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(received).toHaveLength(1)
    expect(bridge.published).toHaveLength(1)
    expect(JSON.parse(bridge.published[0]!.payload)).toMatchObject({ type: 'delta', text: '你好' })
    off()
  })

  it('其它实例推来的事件会被本地订阅者收到', () => {
    const bridge = new FakePubSub()
    initChatEventBridge(bridge)
    const received: ChatLiveEventPayload[] = []
    const off = subscribeChatEvents((event) => received.push(event))

    bridge.deliverForTest('chat', JSON.stringify(sample))
    expect(received).toHaveLength(1)
    expect(received[0]?.type).toBe('delta')
    off()
  })

  it('没有广播层时退回纯进程内', () => {
    const received: ChatLiveEventPayload[] = []
    const off = subscribeChatEvents((event) => received.push(event))
    publishChatEvent(sample)
    expect(received).toHaveLength(1)
    off()
  })
})

describe('Redis Pub/Sub 适配器', () => {
  it('丢弃本实例的回环消息，接收其它实例的消息', async () => {
    const listeners: Array<(message: string) => void> = []
    const client: PubSubClientLike = {
      publish: async () => 0,
      subscribe: async (_channel, listener) => {
        listeners.push(listener)
        return 1
      },
      unsubscribe: async () => 1,
    }
    const pubsub = new RedisPubSub(client)
    const received: string[] = []
    await pubsub.subscribe('chat', (payload) => received.push(payload))

    const other = JSON.stringify({ origin: 'other-instance', channel: 'chat', payload: JSON.stringify(sample) })
    listeners[0]!(other)
    expect(received).toHaveLength(1)

    const own = JSON.stringify({ origin: PUBSUB_INSTANCE_ID, channel: 'chat', payload: JSON.stringify(sample) })
    listeners[0]!(own)
    expect(received).toHaveLength(1)
  })

  it('订阅连接重连后可以重新订阅原频道', async () => {
    let subscribeCalls = 0
    const client: PubSubClientLike = {
      publish: async () => 0,
      subscribe: async () => {
        subscribeCalls += 1
        return 1
      },
      unsubscribe: async () => 1,
    }
    const pubsub = new RedisPubSub(client)
    await pubsub.subscribe('chat', () => undefined)
    expect(subscribeCalls).toBe(1)

    await pubsub.resubscribe()
    expect(subscribeCalls).toBe(2)
  })

  it('广播失败后状态降级，恢复发布后回到 ready', async () => {
    let failing = true
    const client: PubSubClientLike = {
      publish: async () => {
        if (failing) throw new Error('publish failed')
        return 1
      },
      subscribe: async () => 1,
      unsubscribe: async () => 1,
    }
    const pubsub = new RedisPubSub(client)
    await pubsub.publish('chat', '{}')
    expect(pubsub.status().state).toBe('degraded')
    expect(pubsub.status().detail).toContain('publish failed')

    failing = false
    await pubsub.publish('chat', '{}')
    expect(pubsub.status().state).toBe('ready')
  })
})
