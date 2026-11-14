/**
 * 协作层（可选 Redis 增强）。
 *
 * 目标：把「频控 / 事件去重 / 并发计数」这类必须跨进程一致的状态从进程内 Map 搬出去；
 * 没配 Redis、Redis 连不上或命令报错时，自动落回进程内内存实现，接口与行为不变。
 *
 * 判定顺序：
 *   1. backends 运行时里的 cache 且 state === 'ready'（Redis 或 Hybrid 均可）→ 共享实现；
 *   2. 否则用本模块自己的 MemoryCache → 等价于单进程部署的旧行为。
 *
 * 约束：这里只做「加速与协调」，不做账本。配额、审计、消息正文的权威值仍在 SQLite。
 */
import { randomUUID } from 'node:crypto'
import { MemoryCache, type CacheBackend } from './cache.js'
import { getBackendRuntime } from './runtime.js'
import type { BackendStatus } from './types.js'
import { KeyedMutex, KeyedSemaphore, LockAbortedError, LockTimeoutError, SemaphoreQueueFullError, SemaphoreTimeoutError } from '../concurrency.js'

/** 本模块自带的兜底缓存：与 backends 层分开，避免测试里没有运行时也能工作。 */
let fallbackCache: CacheBackend | undefined

function localCache(): CacheBackend {
  fallbackCache ??= new MemoryCache(20_000)
  return fallbackCache
}

interface ActiveCache {
  readonly cache: CacheBackend
  /** 是否用到了跨进程共享的缓存 */
  readonly shared: boolean
}

function activeCache(): ActiveCache {
  const runtime = getBackendRuntime()
  const cache = runtime?.cache
  if (cache) {
    try {
      // 降级时仍把请求交给它：HybridCache 内部会先试 Redis 再落内存，
      // 这样 Redis 恢复后下一次命令成功就能把状态翻回 ready；
      // 如果这里直接换成本地 Map，降级进程再也不会探测 Redis，永远恢复不了。
      return { cache, shared: cache.status().state === 'ready' }
    } catch {
      // 状态读取失败按未就绪处理
    }
  }
  return { cache: localCache(), shared: false }
}

/** 控制台展示用：当前协作层到底跑在 Redis 还是内存。 */
export function coordinationStatus(): { backend: string; shared: boolean; detail: string } {
  const active = activeCache()
  return {
    backend: active.cache.id,
    shared: active.shared,
    detail: active.shared
      ? '频控与去重计数在 Redis 里共享，多个实例看到同一份额度'
      : '频控与去重计数在进程内，重启清零；单实例部署即当前行为',
  }
}

/** 并入后端状态列表，控制台「系统 → 数据与运维」会多一行「协作层」。 */
export function coordinationBackendStatus(): BackendStatus {
  const status = coordinationStatus()
  return {
    id: 'coordination',
    kind: 'cache',
    label: '协作层（频控 · 去重）',
    mode: status.shared ? 'external' : 'builtin',
    state: 'ready',
    detail: status.detail,
    capabilities: status.shared ? ['rate', 'once', 'shared'] : ['rate', 'once'],
  }
}

export interface RateVerdict {
  readonly allowed: boolean
  readonly count: number
  readonly limit: number
  /** 距离当前窗口结束还有多少秒，用于提示「稍后再试」 */
  readonly retryAfterSec: number
}

/**
 * 固定窗口计数限流：同一 key 在 windowSec 秒内最多 limit 次。
 *
 * 用「窗口序号 + INCR」实现，窗口边界最多放过 2 倍瞬时流量，这是固定窗口的固有特性；
 * 相比滑窗实现更省命令、跨实例天然一致，20/分钟这类额度足够用。
 */
export async function hitRate(key: string, limit: number, windowSec = 60): Promise<RateVerdict> {
  const window = Math.max(1, Math.floor(windowSec))
  const slot = Math.floor(Date.now() / (window * 1000))
  const cacheKey = `rate:${key}:${slot}`
  const active = activeCache()
  let count = limit + 1
  try {
    count = await active.cache.incr(cacheKey, window)
  } catch {
    // Redis 抖动时退到内存，宁可放过也不把请求打挂
    const local = localCache()
    count = await local.incr(cacheKey, window)
  }
  const elapsed = Math.floor((Date.now() % (window * 1000)) / 1000)
  return {
    allowed: count <= limit,
    count,
    limit,
    retryAfterSec: Math.max(1, window - elapsed),
  }
}

/**
 * 一次性声明：第一次调用返回 true，TTL 内后续调用返回 false。
 *
 * 与 DB 唯一约束配合使用：Redis 挡住绝大多数重复事件，DB 仍是最终一致的那道闸。
 */
export async function claimOnce(key: string, ttlSec = 300): Promise<boolean> {
  const cacheKey = `once:${key}`
  const active = activeCache()
  try {
    // 必须是原子的 SET NX：先 GET 再 SET 在并发重投时会让两个实例同时拿到 true。
    return await active.cache.setIfAbsent(cacheKey, 1, Math.max(1, Math.floor(ttlSec)))
  } catch {
    // 缓存层抖动时宁可放行，后面还有 DB 唯一约束兜底。
    return true
  }
}

export interface CapacityRequest {
  readonly key: string
  readonly limit: number
}

export interface CapacityLease {
  release: () => void
}

export type CapacityReservation =
  | { readonly ok: true; readonly lease: CapacityLease }
  /** full = 名额已满；unavailable = 共享层不可用，调用方应退回本地实现 */
  | { readonly ok: false; readonly reason: 'full' | 'unavailable' }

/**
 * 预留一组并发名额（全有或全无）。
 *
 * 逐个 `INCR` 再判断是否超过各自的 limit，任一超限就把已占的减回去并返回 full；
 * 缓存层报错则同样回滚并返回 unavailable，让调用方退回进程内实现而不是拒绝用户。
 * 名额自带 TTL，实例崩溃时不会永久占坑（TTL 到期后计数自动清零）。
 */
export async function reserveCapacity(
  requests: readonly CapacityRequest[],
  ttlSec = 600,
): Promise<CapacityReservation> {
  const active = activeCache()
  const ttl = Math.max(1, Math.floor(ttlSec))
  const acquired: string[] = []
  const rollback = async (): Promise<void> => {
    for (const key of acquired) {
      try {
        await active.cache.adjust(key, -1, ttl)
      } catch {
        // 回滚失败只能等 TTL 过期，不把错误抛给业务
      }
    }
  }
  try {
    for (const item of requests) {
      const value = await active.cache.adjust(item.key, 1, ttl)
      if (value > item.limit) {
        await active.cache.adjust(item.key, -1, ttl)
        await rollback()
        return { ok: false, reason: 'full' }
      }
      acquired.push(item.key)
    }
    return {
      ok: true,
      lease: {
        release: () => {
          for (const key of acquired) {
            void active.cache.adjust(key, -1, ttl).catch(() => undefined)
          }
        },
      },
    }
  } catch {
    await rollback()
    return { ok: false, reason: 'unavailable' }
  }
}

/** 读回某个并发名额 key 当前被占用的数量（跨实例总量）。未共享或读失败返回 null。 */
export async function readCapacityCount(key: string): Promise<number | null> {
  if (!coordinationStatus().shared) return null
  try {
    const value = await activeCache().cache.get<number>(key)
    if (value === null || value === undefined) return 0
    const count = Number(value)
    return Number.isFinite(count) && count > 0 ? count : 0
  } catch {
    return null
  }
}

/** 本地兜底信号量：没有共享层时与原来的 KeyedSemaphore 行为一致。 */
const localSlotSemaphore = new KeyedSemaphore()
/** 共享模式下本实例每个 key 的排队人数，用于限制等待者过多。 */
const sharedSlotWaiters = new Map<string, number>()

/**
 * 分布式并发名额（信号量）。
 *
 * Redis 在线时用 `reserveCapacity` 抢一个共享名额（所有实例共用一个上限）；
 * 抢不到每 `pollMs` 重试，`waitMs` 超时抛 `SemaphoreTimeoutError`，排队超过
 * `queueLimit` 抛 `SemaphoreQueueFullError`。离线或 Redis 报错时退回进程内信号量。
 */
export async function acquireCoordinationSlot(
  key: string,
  options: {
    readonly limit: number
    readonly ttlSec?: number
    readonly waitMs?: number
    readonly pollMs?: number
    readonly queueLimit?: number
    readonly signal?: AbortSignal
  },
): Promise<CoordinationLease> {
  const limit = Math.max(1, Math.floor(options.limit))
  const ttlSec = Math.max(1, Math.floor(options.ttlSec ?? 300))
  const waitMs = Math.max(0, Math.floor(options.waitMs ?? 30_000))
  const pollMs = Math.max(50, Math.floor(options.pollMs ?? 500))
  const queueLimit = Math.max(1, Math.floor(options.queueLimit ?? 200))

  const local = async (): Promise<CoordinationLease> => {
    const release = await localSlotSemaphore.acquire(`slot:${key}`, {
      limit,
      queueLimit: 1_000,
      timeoutMs: waitMs,
      signal: options.signal,
    })
    return { release }
  }

  if (!coordinationStatus().shared) return local()

  const waiting = sharedSlotWaiters.get(key) ?? 0
  if (waiting >= queueLimit) throw new SemaphoreQueueFullError(key, queueLimit)
  sharedSlotWaiters.set(key, waiting + 1)

  const deadline = Date.now() + waitMs
  try {
    while (true) {
      if (options.signal?.aborted) throw new LockAbortedError(key)
      const reservation = await reserveCapacity([{ key, limit }], ttlSec)
      if (reservation.ok) return reservation.lease
      if (reservation.reason === 'unavailable') return await local()
      if (Date.now() >= deadline) throw new SemaphoreTimeoutError(key, waitMs)
      await delay(pollMs, options.signal)
    }
  } finally {
    const left = (sharedSlotWaiters.get(key) ?? 1) - 1
    if (left <= 0) sharedSlotWaiters.delete(key)
    else sharedSlotWaiters.set(key, left)
  }
}

export interface CoordinationLockOptions {
  /** 锁的存活时间，长任务靠续租维持；默认 180 秒 */
  readonly ttlMs?: number
  /** 最多等多久拿不到就抛 LOCK_TIMEOUT；默认 120 秒 */
  readonly waitMs?: number
  readonly signal?: AbortSignal
}

export interface CoordinationLease {
  release(): void
}

/** 没有共享层时的兜底锁：与原来的 KeyedMutex 行为一致，仅进程内有效。 */
const localLockFallback = new KeyedMutex()

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

/**
 * 分布式互斥锁：Redis 在线时跨进程生效，离线退化为进程内锁（与升级前一致）。
 *
 * - 抢锁：`SET NX EX`，抢不到每 250ms 重试，直到 waitMs 超时抛 `LOCK_TIMEOUT`；
 * - 持有：按 ttlMs/3 自动续租，避免长任务跑过 TTL 被别的实例抢走；
 * - 释放：只在值仍等于自己的 token 时删除/续期，绝不误删别人的锁。
 */
export async function acquireCoordinationLock(
  key: string,
  options: CoordinationLockOptions = {},
): Promise<CoordinationLease> {
  const ttlMs = Math.max(1000, options.ttlMs ?? 180_000)
  const waitMs = Math.max(0, options.waitMs ?? 120_000)
  const localKey = `lock:${key}`

  const fallback = async (): Promise<CoordinationLease> => {
    const release = await localLockFallback.acquire(localKey, { timeoutMs: waitMs, signal: options.signal })
    return { release }
  }

  if (!coordinationStatus().shared) return fallback()

  const token = randomUUID()
  const ttlSec = Math.ceil(ttlMs / 1000)
  const deadline = Date.now() + waitMs
  while (true) {
    if (options.signal?.aborted) throw new LockAbortedError(key)
    let acquired = false
    try {
      acquired = await activeCache().cache.setIfAbsent(localKey, token, ttlSec)
    } catch {
      // 共享层报错：退回进程内锁，宁可少一层保护也不让业务卡死
      return fallback()
    }
    if (acquired) break
    if (Date.now() >= deadline) throw new LockTimeoutError(key, waitMs)
    await delay(250, options.signal)
  }

  const renewMs = Math.max(500, Math.floor(ttlMs / 3))
  const renewTimer = setInterval(() => {
    void activeCache()
      .cache.compareAndTouch(localKey, token, ttlSec)
      .catch(() => undefined)
  }, renewMs)
  renewTimer.unref?.()

  let released = false
  return {
    release: () => {
      if (released) return
      released = true
      clearInterval(renewTimer)
      void activeCache()
        .cache.compareAndTouch(localKey, token, 0)
        .catch(() => undefined)
    },
  }
}

/**
 * 定时任务的领导权：同一时刻只有一个实例执行 `task`。
 *
 * - Redis 在线：抢 `leader:<key>` 租约，抢不到直接返回 false（别的实例在做）；
 * - 离线：视为唯一实例，直接执行，与升级前行为一致。
 *
 * 租约在任务执行期间自动续租，因此长任务（保留清理、组织同步）不会被中途抢走。
 */
export async function runAsLeader<T = void>(
  key: string,
  ttlMs: number,
  task: () => Promise<T> | T,
): Promise<{ ran: boolean; value?: T }> {
  if (!coordinationStatus().shared) {
    return { ran: true, value: await task() }
  }
  let lease: CoordinationLease
  try {
    lease = await acquireCoordinationLock(`leader:${key}`, { ttlMs, waitMs: 0 })
  } catch {
    return { ran: false }
  }
  try {
    return { ran: true, value: await task() }
  } finally {
    lease.release()
  }
}

/**
 * 长期领导权（用于「同一条长连接只允许一个实例持有」）：
 * 与 `runAsLeader` 不同，租约在业务持有期间一直续租，直到显式释放或续租失败。
 *
 * 续租失败（key 已过期被别的实例抢走、或 Redis 抖动）时 `isHeld()` 变为 false，
 * 调用方应在下一轮巡检里主动断开自己的连接，避免两个实例同时收消息。
 */
export interface LeaderHold {
  /** 是否共享层（false 表示单实例，恒为 true） */
  readonly shared: boolean
  isHeld(): boolean
  release(): void
}

export async function acquireLeaderHold(
  key: string,
  options: { ttlMs?: number; waitMs?: number } = {},
): Promise<LeaderHold | null> {
  const ttlMs = Math.max(1000, options.ttlMs ?? 90_000)
  const waitMs = Math.max(0, options.waitMs ?? 0)

  if (!coordinationStatus().shared) {
    // 单实例部署：与升级前一致，直接认为自己是唯一持有者
    let held = true
    return {
      shared: false,
      isHeld: () => held,
      release: () => {
        held = false
      },
    }
  }

  const cacheKey = `leader:${key}`
  const token = randomUUID()
  const ttlSec = Math.ceil(ttlMs / 1000)
  const deadline = Date.now() + waitMs
  while (true) {
    let acquired = false
    try {
      acquired = await activeCache().cache.setIfAbsent(cacheKey, token, ttlSec)
    } catch {
      return null
    }
    if (acquired) break
    if (Date.now() >= deadline) return null
    await delay(250)
  }

  let held = true
  const renewTimer = setInterval(() => {
    void activeCache()
      .cache.compareAndTouch(cacheKey, token, ttlSec)
      .then((hit) => {
        if (!hit && held) {
          held = false
          clearInterval(renewTimer)
        }
      })
      .catch(() => {
        // 单次续租失败不立刻放弃：网络抖动时给下一轮机会，真正过期会返回 false
      })
  }, Math.max(500, Math.floor(ttlMs / 3)))
  renewTimer.unref?.()

  return {
    shared: true,
    isHeld: () => held,
    release: () => {
      if (!held) return
      held = false
      clearInterval(renewTimer)
      void activeCache().cache.compareAndTouch(cacheKey, token, 0).catch(() => undefined)
    },
  }
}

const RUN_ALIVE_PREFIX = 'run:alive:'

/** 记录某个 Agent run 还活着；TTL 到期即视为实例已退出。 */
export async function markRunAlive(runId: string, ttlSec = 90): Promise<void> {
  try {
    await activeCache().cache.set(`${RUN_ALIVE_PREFIX}${runId}`, Date.now(), Math.max(1, Math.floor(ttlSec)))
  } catch {
    // 心跳写失败不影响主流程
  }
}

export async function isRunAlive(runId: string): Promise<boolean> {
  try {
    return Boolean(await activeCache().cache.get(`${RUN_ALIVE_PREFIX}${runId}`))
  } catch {
    return false
  }
}

export async function clearRunAlive(runId: string): Promise<void> {
  try {
    await activeCache().cache.del(`${RUN_ALIVE_PREFIX}${runId}`)
  } catch {
    // 清理失败交给 TTL
  }
}

/** 测试用：清掉兜底缓存，避免用例之间互相污染。 */
export function resetCoordinationForTest(): void {
  fallbackCache?.close?.()
  fallbackCache = undefined
}
