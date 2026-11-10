/**
 * 进程内按 key 串行执行。
 *
 * 用途：同一公司/员工/文件（或同一会话、同一任务）被多个 Agent 同时操作时，
 * 让它们排队而不是同时读改写。锁只在当前 EAB 服务进程内有效；多进程部署必须
 * 换成数据库或 Redis 锁（见 P0-4 的单写进程约束）。
 */

export interface KeyedLockOptions {
  /** 等待锁的最长时间，默认 30 秒 */
  readonly timeoutMs?: number
  /** 用户停止生成时用它中断等待；不会中断已经拿到锁的任务 */
  readonly signal?: AbortSignal
}

export class LockTimeoutError extends Error {
  readonly code = 'LOCK_TIMEOUT'
  constructor(readonly key: string, readonly timeoutMs: number) {
    super(`等待资源锁超时：${key}（${timeoutMs}ms）`)
    this.name = 'LockTimeoutError'
  }
}

export class LockAbortedError extends Error {
  readonly code = 'LOCK_ABORTED'
  constructor(readonly key: string) {
    super(`等待资源锁已取消：${key}`)
    this.name = 'LockAbortedError'
  }
}

export class SemaphoreTimeoutError extends Error {
  readonly code = 'SEMAPHORE_TIMEOUT'
  constructor(readonly key: string, readonly timeoutMs: number) {
    super(`等待并发名额超时：${key}（${timeoutMs}ms）`)
    this.name = 'SemaphoreTimeoutError'
  }
}

export class SemaphoreQueueFullError extends Error {
  readonly code = 'SEMAPHORE_QUEUE_FULL'
  constructor(readonly key: string, readonly queueLimit: number) {
    super(`并发排队已满：${key}（上限 ${queueLimit}）`)
    this.name = 'SemaphoreQueueFullError'
  }
}

type Release = () => void

interface Waiter {
  readonly resolve: (release: Release) => void
  readonly reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  readonly signal?: AbortSignal
  abortListener?: () => void
  settled: boolean
}

interface LockEntry {
  held: boolean
  waiters: Waiter[]
}

export class KeyedMutex {
  private readonly entries = new Map<string, LockEntry>()

  /** 当前是否有人持有该 key 的锁 */
  isHeld(key: string): boolean {
    return Boolean(this.entries.get(key)?.held)
  }

  /** 当前排队等待该 key 的数量，用于观测 */
  pending(key: string): number {
    return this.entries.get(key)?.waiters.length ?? 0
  }

  /**
   * 获取锁，返回一次性 release。
   * 空闲时立即拿到；被占用时按 FIFO 排队，超时/取消会把自己从队列摘掉。
   */
  async acquire(key: string, options: KeyedLockOptions = {}): Promise<Release> {
    const timeoutMs = options.timeoutMs ?? 30_000
    const existing = this.entries.get(key)
    if (!existing || !existing.held) {
      const entry = existing ?? { held: false, waiters: [] }
      entry.held = true
      this.entries.set(key, entry)
      return this.makeRelease(key)
    }

    if (options.signal?.aborted) throw new LockAbortedError(key)

    return new Promise<Release>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => undefined, 0),
        signal: options.signal,
        settled: false,
      }

      const removeWaiter = (): void => {
        const entry = this.entries.get(key)
        if (entry) entry.waiters = entry.waiters.filter((item) => item !== waiter)
        if (waiter.abortListener && waiter.signal) {
          waiter.signal.removeEventListener('abort', waiter.abortListener)
        }
        clearTimeout(waiter.timer)
      }

      waiter.timer = setTimeout(() => {
        if (waiter.settled) return
        waiter.settled = true
        removeWaiter()
        reject(new LockTimeoutError(key, timeoutMs))
      }, timeoutMs)

      if (options.signal) {
        waiter.abortListener = () => {
          if (waiter.settled) return
          waiter.settled = true
          removeWaiter()
          reject(new LockAbortedError(key))
        }
        options.signal.addEventListener('abort', waiter.abortListener, { once: true })
      }

      existing.waiters.push(waiter)
    })
  }

  /** 获取锁并执行，异常/取消也会释放 */
  async runExclusive<T>(key: string, fn: () => Promise<T> | T, options: KeyedLockOptions = {}): Promise<T> {
    const release = await this.acquire(key, options)
    try {
      return await fn()
    } finally {
      release()
    }
  }

  private makeRelease(key: string): Release {
    let released = false
    return () => {
      if (released) return
      released = true
      const entry = this.entries.get(key)
      if (!entry || !entry.held) return
      this.handoff(key, entry)
    }
  }

  private handoff(key: string, entry: LockEntry): void {
    const waiter = entry.waiters.shift()
    if (!waiter) {
      entry.held = false
      this.entries.delete(key)
      return
    }
    waiter.settled = true
    clearTimeout(waiter.timer)
    if (waiter.abortListener && waiter.signal) {
      waiter.signal.removeEventListener('abort', waiter.abortListener)
    }
    // 锁直接交给队首，entry.held 保持 true；新持有者 release 时再交接给下一个。
    waiter.resolve(this.makeRelease(key))
  }
}

interface SemaphoreWaiter {
  readonly key: string
  readonly resolve: (release: Release) => void
  readonly reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  readonly signal?: AbortSignal
  abortListener?: () => void
  settled: boolean
}

interface SemaphoreEntry {
  active: number
  readonly limit: number
  waiters: SemaphoreWaiter[]
}

export interface KeyedSemaphoreOptions {
  /** 该 key 同时允许执行的数量 */
  readonly limit: number
  /** 该 key 最多排多少人，默认 100 */
  readonly queueLimit?: number
  /** 等待名额的最长时间，默认 30 秒 */
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

export interface KeyedSemaphoreStats {
  readonly active: number
  readonly queued: number
  readonly keys: ReadonlyArray<{ key: string; active: number; queued: number }>
}

/**
 * 按 key 限制同时执行数量（不是互斥锁）。
 * 工具级并发、插件工具并发都用它；排队按 FIFO，超时/取消会摘除自己。
 */
export class KeyedSemaphore {
  private readonly entries = new Map<string, SemaphoreEntry>()

  pending(key: string): number {
    return this.entries.get(key)?.waiters.length ?? 0
  }

  stats(): KeyedSemaphoreStats {
    let active = 0
    let queued = 0
    const keys: Array<{ key: string; active: number; queued: number }> = []
    for (const [key, entry] of this.entries) {
      active += entry.active
      queued += entry.waiters.length
      keys.push({ key, active: entry.active, queued: entry.waiters.length })
    }
    return { active, queued, keys: keys.sort((a, b) => b.active + b.queued - (a.active + a.queued)) }
  }

  async acquire(key: string, options: KeyedSemaphoreOptions): Promise<Release> {
    const limit = Math.max(1, Math.floor(options.limit))
    const queueLimit = Math.max(1, Math.floor(options.queueLimit ?? 100))
    const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? 30_000))
    const existing = this.entries.get(key)
    const entry: SemaphoreEntry = existing ?? { active: 0, limit, waiters: [] }
    if (!existing) this.entries.set(key, entry)

    if (entry.active < entry.limit && entry.waiters.length === 0) {
      entry.active += 1
      return this.makeRelease(key, entry)
    }

    if (options.signal?.aborted) throw new LockAbortedError(key)
    if (entry.waiters.length >= queueLimit) throw new SemaphoreQueueFullError(key, queueLimit)

    return new Promise<Release>((resolve, reject) => {
      const waiter: SemaphoreWaiter = {
        key,
        resolve,
        reject,
        timer: setTimeout(() => undefined, 0),
        signal: options.signal,
        settled: false,
      }
      const removeWaiter = (): void => {
        entry.waiters = entry.waiters.filter((item) => item !== waiter)
        if (entry.active === 0 && entry.waiters.length === 0) this.entries.delete(key)
        if (waiter.abortListener && waiter.signal) {
          waiter.signal.removeEventListener('abort', waiter.abortListener)
        }
        clearTimeout(waiter.timer)
      }

      waiter.timer = setTimeout(() => {
        if (waiter.settled) return
        waiter.settled = true
        removeWaiter()
        reject(new SemaphoreTimeoutError(key, timeoutMs))
      }, timeoutMs)

      if (options.signal) {
        waiter.abortListener = () => {
          if (waiter.settled) return
          waiter.settled = true
          removeWaiter()
          reject(new LockAbortedError(key))
        }
        options.signal.addEventListener('abort', waiter.abortListener, { once: true })
      }
      entry.waiters.push(waiter)
    })
  }

  private makeRelease(key: string, entry: SemaphoreEntry): Release {
    let released = false
    return () => {
      if (released) return
      released = true
      entry.active = Math.max(0, entry.active - 1)
      this.grant(key, entry)
    }
  }

  private grant(key: string, entry: SemaphoreEntry): void {
    while (entry.active < entry.limit && entry.waiters.length > 0) {
      const waiter = entry.waiters.shift()
      if (!waiter || waiter.settled) continue
      waiter.settled = true
      clearTimeout(waiter.timer)
      if (waiter.abortListener && waiter.signal) {
        waiter.signal.removeEventListener('abort', waiter.abortListener)
      }
      entry.active += 1
      waiter.resolve(this.makeRelease(key, entry))
    }
    if (entry.active === 0 && entry.waiters.length === 0) this.entries.delete(key)
  }
}
