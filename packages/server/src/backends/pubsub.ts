/**
 * 跨实例实时事件（Redis Pub/Sub）。
 *
 * 用途：网页工作台的 SSE 事件流原本只在产生事件的那个进程内广播；多实例部署时
 * 用户刷新/重连可能落到另一台机器，就看不到正在生成的增量。把事件同时发到 Redis
 * 频道，各实例订阅后转给本进程的订阅者，页面落在哪个实例都能收到。
 *
 * 边界：
 * - 没有 Redis 时不启用，进程内行为与升级前完全一致；
 * - 消息带 `origin` 实例标识，本实例收到自己的回环消息直接丢弃，避免重复推送；
 * - 订阅连接是独立连接（Redis 订阅态不能复用普通命令连接），断线只影响实时性，
 *   不影响消息落库与页面重连后的快照恢复。
 */
import { randomUUID } from 'node:crypto'
import type { BackendStatus } from './types.js'

/** node-redis 订阅客户端需要的最小接口；测试可注入替身。 */
export interface PubSubClientLike {
  publish(channel: string, message: string): Promise<number>
  subscribe(channel: string, listener: (message: string) => void): Promise<unknown>
  unsubscribe(channel: string): Promise<unknown>
  quit?(): Promise<unknown>
  disconnect?(): void
}

export interface PubSubMessage {
  /** 产生消息的实例；本实例自己的回环消息会被丢弃 */
  readonly origin: string
  readonly channel: string
  readonly payload: string
}

export interface PubSubBackend {
  readonly id: string
  readonly shared: boolean
  publish(channel: string, payload: string): Promise<void>
  subscribe(channel: string, handler: (payload: string) => void): Promise<() => void>
  /** 断线重连后重新订阅；未实现时 runtime 不调用。 */
  resubscribe?(): Promise<void>
  /** 广播连接健康状态；供控制台展示，未实现时 runtime 不追加。 */
  status?(): BackendStatus
  /** 连接层报错；runtime 用来让控制台及时显示 degraded。 */
  markError?(error: unknown): void
  /** 测试用：直接投递一条来自其它实例的消息 */
  deliverForTest?(channel: string, payload: string, origin?: string): void
  close?(): Promise<void>
}

/** 本进程的实例标识；用于丢弃 Redis 回环消息。 */
export const PUBSUB_INSTANCE_ID = randomUUID()

export class RedisPubSub implements PubSubBackend {
  readonly id = 'redis-pubsub'
  readonly shared = true
  private readonly handlers = new Map<string, Set<(payload: string) => void>>()
  private readonly listener = (message: string): void => this.dispatch(message)
  private subscribed = false
  private lastError = ''

  constructor(
    private readonly client: PubSubClientLike,
    private readonly redisChannel = 'eab:rt',
  ) {}

  async publish(channel: string, payload: string): Promise<void> {
    try {
      await this.client.publish(
        this.redisChannel,
        JSON.stringify({ origin: PUBSUB_INSTANCE_ID, channel, payload }),
      )
      // 广播成功就把上一次的失败清掉，控制台不会永久停在 degraded。
      this.lastError = ''
    } catch (error) {
      // 实时性可以降级，不能因为广播失败影响消息落库
      this.lastError = error instanceof Error ? error.message : String(error)
    }
  }

  async subscribe(channel: string, handler: (payload: string) => void): Promise<() => void> {
    let set = this.handlers.get(channel)
    if (!set) {
      set = new Set()
      this.handlers.set(channel, set)
    }
    set.add(handler)
    if (!this.subscribed) {
      await this.ensureSubscribed()
    }
    return () => {
      const current = this.handlers.get(channel)
      if (!current) return
      current.delete(handler)
      if (current.size === 0) this.handlers.delete(channel)
    }
  }

  /**
   * 断线重连后重新订阅。
   *
   * node-redis 重连成功后不保证恢复订阅态；由 runtime 在 subscriber 的 `ready`
   * 事件里调用这里。重复订阅同一频道是幂等的，不会多收消息。
   */
  async resubscribe(): Promise<void> {
    if (!this.subscribed) return
    try {
      await this.client.subscribe(this.redisChannel, this.listener)
      this.lastError = ''
    } catch (error) {
      this.subscribed = false
      this.lastError = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  private async ensureSubscribed(): Promise<void> {
    if (this.subscribed) return
    this.subscribed = true
    try {
      await this.client.subscribe(this.redisChannel, this.listener)
      this.lastError = ''
    } catch (error) {
      this.subscribed = false
      this.lastError = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  private dispatch(raw: string): void {
    let parsed: { origin?: string; channel?: string; payload?: string }
    try {
      parsed = JSON.parse(raw) as { origin?: string; channel?: string; payload?: string }
    } catch {
      return
    }
    if (!parsed || parsed.origin === PUBSUB_INSTANCE_ID) return
    const channel = typeof parsed.channel === 'string' ? parsed.channel : ''
    const payload = typeof parsed.payload === 'string' ? parsed.payload : ''
    if (!channel || !payload) return
    const handlers = this.handlers.get(channel)
    if (!handlers) return
    for (const handler of handlers) {
      try {
        handler(payload)
      } catch {
        // 单个订阅者失败不影响其它订阅者
      }
    }
  }

  markError(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : String(error)
  }

  statusDetail(): string {
    return this.lastError ? `跨实例广播曾报错：${this.lastError}` : '跨实例实时事件经 Redis 广播'
  }

  status(): BackendStatus {
    return {
      id: this.id,
      kind: 'cache',
      label: '跨实例广播',
      mode: 'external',
      state: this.lastError ? 'degraded' : 'ready',
      detail: this.statusDetail(),
      capabilities: ['pubsub', 'sse-fanout', 'stop-generation', 'cache-invalidation'],
    }
  }

  async close(): Promise<void> {
    try {
      await this.client.unsubscribe(this.redisChannel)
    } catch {
      // 关闭阶段忽略
    }
    await this.client.quit?.().catch(() => undefined)
    this.handlers.clear()
  }
}
