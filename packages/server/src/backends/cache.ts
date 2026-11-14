/**
 * 可选缓存插件。
 *
 * 默认永远有内存缓存；配置 Redis 后变成「Redis 优先 + 内存兜底」：
 * Redis 连不上、命令失败或超时都只降级，不把业务请求打挂。
 */
import type { BackendStatus } from './types.js'

export interface CacheBackend {
  readonly id: string
  get<T>(key: string): Promise<T | null>
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>
  del(key: string): Promise<void>
  incr(key: string, ttlSeconds: number): Promise<number>
  /**
   * 原子加减（delta 可为负数），结果不大于 0 时删除 key 并返回 0。
   * 用于分布式并发名额：先加再看是否超限，超了再减回去。
   */
  adjust(key: string, delta: number, ttlSeconds: number): Promise<number>
  /** 仅当 key 不存在时写入（Redis 用 SET NX），返回是否抢到。用于分布式锁。 */
  setIfAbsent(key: string, value: unknown, ttlSeconds: number): Promise<boolean>
  /**
   * 只有值仍等于 value 时才续期（ttlSeconds > 0）或删除（ttlSeconds <= 0）。
   * 返回是否命中。用于锁的续租与安全释放（避免删掉别人的锁）。
   */
  compareAndTouch(key: string, value: unknown, ttlSeconds: number): Promise<boolean>
  status(): BackendStatus
  close(): Promise<void>
}

interface MemoryEntry {
  value: unknown
  expiresAt: number
}

/** 进程内缓存：外部缓存不可用时的兜底，也是默认部署唯一实现。 */
export class MemoryCache implements CacheBackend {
  readonly id = 'memory'
  private readonly entries = new Map<string, MemoryEntry>()
  private hits = 0
  private misses = 0

  constructor(private readonly maxEntries = 5000) {}

  private prune(now = Date.now()): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key)
    }
    // 超上限时按插入顺序淘汰最老的一批，避免无界增长。
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  async get<T>(key: string): Promise<T | null> {
    const entry = this.entries.get(key)
    if (!entry || entry.expiresAt <= Date.now()) {
      if (entry) this.entries.delete(key)
      this.misses += 1
      return null
    }
    this.hits += 1
    return entry.value as T
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    this.prune()
    this.entries.set(key, { value, expiresAt: Date.now() + Math.max(1, ttlSeconds) * 1000 })
  }

  async del(key: string): Promise<void> {
    this.entries.delete(key)
  }

  async incr(key: string, ttlSeconds: number): Promise<number> {
    const now = Date.now()
    const entry = this.entries.get(key)
    const current = entry && entry.expiresAt > now ? Number(entry.value) || 0 : 0
    const next = current + 1
    this.entries.set(key, { value: next, expiresAt: entry && entry.expiresAt > now ? entry.expiresAt : now + Math.max(1, ttlSeconds) * 1000 })
    return next
  }

  async adjust(key: string, delta: number, ttlSeconds: number): Promise<number> {
    const now = Date.now()
    const entry = this.entries.get(key)
    const current = entry && entry.expiresAt > now ? Number(entry.value) || 0 : 0
    const next = current + delta
    if (next <= 0) {
      this.entries.delete(key)
      return 0
    }
    this.entries.set(key, { value: next, expiresAt: now + Math.max(1, ttlSeconds) * 1000 })
    return next
  }

  async setIfAbsent(key: string, value: unknown, ttlSeconds: number): Promise<boolean> {
    const now = Date.now()
    const entry = this.entries.get(key)
    if (entry && entry.expiresAt > now) return false
    this.prune(now)
    this.entries.set(key, { value, expiresAt: now + Math.max(1, ttlSeconds) * 1000 })
    return true
  }

  async compareAndTouch(key: string, value: unknown, ttlSeconds: number): Promise<boolean> {
    const now = Date.now()
    const entry = this.entries.get(key)
    if (!entry || entry.expiresAt <= now) return false
    if (JSON.stringify(entry.value) !== JSON.stringify(value)) return false
    if (ttlSeconds <= 0) {
      this.entries.delete(key)
      return true
    }
    this.entries.set(key, { value: entry.value, expiresAt: now + Math.max(1, ttlSeconds) * 1000 })
    return true
  }

  status(): BackendStatus {
    this.prune()
    return {
      id: this.id,
      kind: 'cache',
      label: '内存缓存',
      mode: 'builtin',
      state: 'ready',
      detail: '进程内缓存，重启后清空；单实例默认使用',
      capabilities: ['kv', 'ttl', 'counter'],
      metrics: { entries: this.entries.size, hits: this.hits, misses: this.misses },
    }
  }

  async close(): Promise<void> {
    this.entries.clear()
  }
}

export interface RedisLike {
  get(key: string): Promise<string | null>
  set(key: string, value: string, options?: { EX?: number; NX?: boolean }): Promise<unknown>
  del(key: string): Promise<unknown>
  incrBy(key: string, value: number): Promise<number>
  expire(key: string, seconds: number): Promise<unknown>
  /** 可选：node-redis 提供 eval；没有时锁的续租会退化为 GET+EXPIRE。 */
  eval?: (script: string, options: { keys: string[]; arguments: string[] }) => Promise<unknown>
  quit?(): Promise<unknown>
  disconnect?(): void
}

/**
 * 单条 Redis 命令的上限。
 *
 * 连接断开有 reconnectStrategy 兜底，但「TCP 还连着、命令一直不回」不会触发重连；
 * 没有超时的话，一次缓存读就能把对话请求挂住。超时按失败处理并落内存兜底，
 * 业务最多多花 2 秒，不会无限等待。可用环境变量调整。
 */
const REDIS_COMMAND_TIMEOUT_MS = (() => {
  const parsed = Number(process.env.EAB_REDIS_COMMAND_TIMEOUT_MS)
  return Number.isFinite(parsed) && parsed >= 100 ? Math.round(parsed) : 2_000
})()

/** Redis 适配器：只依赖最小命令集，测试可注入替身。 */
export class RedisCache implements CacheBackend {
  readonly id = 'redis'
  private failures = 0
  private totalFailures = 0
  private lastError = ''

  constructor(
    private readonly client: RedisLike,
    private readonly prefix = 'eab:',
    private readonly commandTimeoutMs = REDIS_COMMAND_TIMEOUT_MS,
  ) {}

  private key(key: string): string {
    return `${this.prefix}${key}`
  }

  private fail(error: unknown): void {
    this.failures += 1
    this.totalFailures += 1
    this.lastError = error instanceof Error ? error.message : String(error)
  }

  /** 连接层报错（还没走到具体命令）也要把状态标成降级，避免控制台假绿。 */
  markFailure(error: unknown): void {
    this.fail(error)
  }

  /** 任意命令成功即视为连接已恢复；状态不再永久停在 degraded。 */
  private succeed(): void {
    this.failures = 0
    this.lastError = ''
  }

  /** 所有 Redis 命令统一走这里：成功清零失败计数，超时按失败处理。 */
  private async run<T>(label: string, task: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const value = await Promise.race([
        Promise.resolve().then(task),
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Redis 命令超时（${label}，${this.commandTimeoutMs}ms）`)),
            this.commandTimeoutMs,
          )
        }),
      ])
      this.succeed()
      return value
    } catch (error) {
      this.fail(error)
      throw error
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async get<T>(key: string): Promise<T | null> {
    return this.run('GET', async () => {
      const raw = await this.client.get(this.key(key))
      if (raw === null) return null
      return JSON.parse(raw) as T
    })
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.run('SET', () =>
      this.client.set(this.key(key), JSON.stringify(value), { EX: Math.max(1, Math.round(ttlSeconds)) }),
    )
  }

  async del(key: string): Promise<void> {
    await this.run('DEL', () => this.client.del(this.key(key)))
  }

  async incr(key: string, ttlSeconds: number): Promise<number> {
    return this.run('INCR', async () => {
      const next = await this.client.incrBy(this.key(key), 1)
      if (next === 1) await this.client.expire(this.key(key), Math.max(1, Math.round(ttlSeconds)))
      return next
    })
  }

  async adjust(key: string, delta: number, ttlSeconds: number): Promise<number> {
    return this.run('ADJUST', async () => {
      const next = await this.client.incrBy(this.key(key), delta)
      if (next <= 0) {
        await this.client.del(this.key(key))
        return 0
      }
      // 只在 key 刚创建（本次就是第一次加）时设置 TTL；释放不做续期，避免名额被无限延长。
      if (next === delta) await this.client.expire(this.key(key), Math.max(1, Math.round(ttlSeconds)))
      return next
    })
  }

  async setIfAbsent(key: string, value: unknown, ttlSeconds: number): Promise<boolean> {
    return this.run('SET NX', async () => {
      const result = await this.client.set(this.key(key), JSON.stringify(value), {
        EX: Math.max(1, Math.round(ttlSeconds)),
        NX: true,
      })
      return result === 'OK'
    })
  }

  async compareAndTouch(key: string, value: unknown, ttlSeconds: number): Promise<boolean> {
    const fullKey = this.key(key)
    const expected = JSON.stringify(value)
    const ttl = Math.round(ttlSeconds)
    return this.run('COMPARE & TOUCH', async () => {
      if (this.client.eval) {
        const script = [
          "if redis.call('GET', KEYS[1]) == ARGV[1] then",
          "  if tonumber(ARGV[2]) > 0 then redis.call('EXPIRE', KEYS[1], ARGV[2]) else redis.call('DEL', KEYS[1]) end",
          '  return 1',
          'else',
          '  return 0',
          'end',
        ].join('\n')
        const result = await this.client.eval(script, { keys: [fullKey], arguments: [expected, String(ttl)] })
        return Number(result) === 1
      }
      const current = await this.client.get(fullKey)
      if (current !== expected) return false
      if (ttl > 0) await this.client.expire(fullKey, ttl)
      else await this.client.del(fullKey)
      return true
    })
  }

  status(): BackendStatus {
    return {
      id: this.id,
      kind: 'cache',
      label: 'Redis',
      mode: 'external',
      state: this.failures > 0 ? 'degraded' : 'ready',
      detail: this.failures > 0 ? `最近有 ${this.failures} 次命令失败，使用内存兜底：${this.lastError}` : 'Redis 缓存可用',
      capabilities: ['kv', 'ttl', 'counter', 'shared'],
      metrics: { failures: this.totalFailures },
    }
  }

  async close(): Promise<void> {
    try {
      if (this.client.quit) await this.client.quit()
      else this.client.disconnect?.()
    } catch {
      this.client.disconnect?.()
    }
  }
}

/**
 * Redis 优先、内存兜底。
 * set 会同时写两份：Redis 抖动时至少本次进程还能命中；读取失败自动落回内存。
 */
export class HybridCache implements CacheBackend {
  readonly id = 'hybrid'
  private primaryErrors = 0
  private lastError = ''

  constructor(
    private readonly primary: RedisCache,
    private readonly fallback: MemoryCache,
  ) {}

  private note(error: unknown): void {
    this.primaryErrors += 1
    this.lastError = error instanceof Error ? error.message : String(error)
  }

  /** 主缓存有一条命令成功，就说明连接已恢复，降级状态立即解除。 */
  private recover(): void {
    this.primaryErrors = 0
    this.lastError = ''
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const value = await this.primary.get<T>(key)
      this.recover()
      if (value !== null) return value
    } catch (error) {
      this.note(error)
    }
    return this.fallback.get<T>(key)
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.fallback.set(key, value, ttlSeconds)
    try {
      await this.primary.set(key, value, ttlSeconds)
      this.recover()
    } catch (error) {
      this.note(error)
    }
  }

  async del(key: string): Promise<void> {
    await this.fallback.del(key)
    try {
      await this.primary.del(key)
      this.recover()
    } catch (error) {
      this.note(error)
    }
  }

  async incr(key: string, ttlSeconds: number): Promise<number> {
    try {
      const count = await this.primary.incr(key, ttlSeconds)
      this.recover()
      return count
    } catch (error) {
      this.note(error)
      return this.fallback.incr(key, ttlSeconds)
    }
  }

  async adjust(key: string, delta: number, ttlSeconds: number): Promise<number> {
    try {
      const count = await this.primary.adjust(key, delta, ttlSeconds)
      this.recover()
      return count
    } catch (error) {
      this.note(error)
      return this.fallback.adjust(key, delta, ttlSeconds)
    }
  }

  async setIfAbsent(key: string, value: unknown, ttlSeconds: number): Promise<boolean> {
    try {
      const claimed = await this.primary.setIfAbsent(key, value, ttlSeconds)
      this.recover()
      return claimed
    } catch (error) {
      this.note(error)
      return this.fallback.setIfAbsent(key, value, ttlSeconds)
    }
  }

  async compareAndTouch(key: string, value: unknown, ttlSeconds: number): Promise<boolean> {
    try {
      const touched = await this.primary.compareAndTouch(key, value, ttlSeconds)
      this.recover()
      return touched
    } catch (error) {
      this.note(error)
      return this.fallback.compareAndTouch(key, value, ttlSeconds)
    }
  }

  status(): BackendStatus {
    const primary = this.primary.status()
    const fallback = this.fallback.status()
    return {
      ...primary,
      id: 'redis',
      state: this.primaryErrors > 0 || primary.state !== 'ready' ? 'degraded' : 'ready',
      detail:
        this.primaryErrors > 0 || primary.state !== 'ready'
          ? `Redis 降级，内存兜底生效（${this.primaryErrors} 次失败${this.lastError ? `：${this.lastError}` : ''}）`
          : 'Redis 缓存可用，内存作为同进程兜底',
      metrics: {
        entries: Number(fallback.metrics?.entries ?? 0),
        primaryFailures: this.primaryErrors,
      },
    }
  }

  async close(): Promise<void> {
    await Promise.all([this.primary.close(), this.fallback.close()])
  }
}
