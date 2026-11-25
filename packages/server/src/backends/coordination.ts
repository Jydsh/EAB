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
import { hostname } from 'node:os'
import type { Db } from '@eab/storage'
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

/**
 * 多实例部署但没接 Redis 时，用同一份 SQLite 库做跨进程锁/计数。
 * 只有 main.ts 显式调用 `useDatabaseCoordination` 后才启用，单实例行为完全不变。
 */
let databaseCache: SqliteCoordinationCache | undefined

export function useDatabaseCoordination(db: Db): void {
  databaseCache = new SqliteCoordinationCache(db)
}

/** 仅供测试：恢复默认内存协调层。 */
export function resetDatabaseCoordination(): void {
  databaseCache = undefined
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
      const ready = cache.status().state === 'ready' && cache.id !== 'memory'
      if (ready) return { cache, shared: true }
      if (databaseCache) return { cache: databaseCache, shared: true }
      return { cache, shared: false }
    } catch {
      // 状态读取失败按未就绪处理
    }
  }
  if (databaseCache) return { cache: databaseCache, shared: true }
  return { cache: localCache(), shared: false }
}

/**
 * SQLite 协调缓存。
 *
 * 表 `runtime_coordination` 只存 TTL 键值；写入全部是单条 UPSERT/UPDATE，
 * 依赖 SQLite 的写串行化保证「只有一个进程抢到锁」。
 * 这不是高频缓存：只在显式多实例且没有 Redis 时承担 leader 租约与跨实例去重。
 */
export class SqliteCoordinationCache implements CacheBackend {
  readonly id = 'sqlite-coordination'
  private lastSweep = 0

  constructor(private readonly db: Db) {}

  private sweep(now = Date.now()): void {
    if (now - this.lastSweep < 60_000) return
    this.lastSweep = now
    try {
      this.db.prepare('DELETE FROM runtime_coordination WHERE expires_at <= ?').run(now)
    } catch {
      // 清理失败不影响业务，下次再试
    }
  }

  async get<T>(key: string): Promise<T | null> {
    const row = this.db
      .prepare('SELECT value_json, expires_at FROM runtime_coordination WHERE key = ?')
      .get(key) as { value_json?: string; expires_at?: number } | undefined
    if (!row || Number(row.expires_at) <= Date.now()) {
      if (row) {
        try {
          this.db.prepare('DELETE FROM runtime_coordination WHERE key = ? AND expires_at <= ?').run(key, Date.now())
        } catch {
          // ignore
        }
      }
      return null
    }
    try {
      return JSON.parse(String(row.value_json)) as T
    } catch {
      return null
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    const now = Date.now()
    const expiresAt = now + Math.max(1, ttlSeconds) * 1000
    this.db
      .prepare(
        `INSERT INTO runtime_coordination(key, value_json, expires_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value ?? null), expiresAt, now)
    this.sweep(now)
  }

  async del(key: string): Promise<void> {
    this.db.prepare('DELETE FROM runtime_coordination WHERE key = ?').run(key)
  }

  async incr(key: string, ttlSeconds: number): Promise<number> {
    const now = Date.now()
    const expiresAt = now + Math.max(1, ttlSeconds) * 1000
    const row = this.db
      .prepare(
        `INSERT INTO runtime_coordination(key, value_json, expires_at, updated_at)
         VALUES (?, '1', ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = CASE
             WHEN runtime_coordination.expires_at > ? THEN CAST(runtime_coordination.value_json AS INTEGER) + 1
             ELSE 1
           END,
           expires_at = CASE
             WHEN runtime_coordination.expires_at > ? THEN runtime_coordination.expires_at
             ELSE excluded.expires_at
           END,
           updated_at = excluded.updated_at
         RETURNING CAST(value_json AS INTEGER) AS n`,
      )
      .get(key, expiresAt, now, now, now) as { n?: number } | undefined
    this.sweep(now)
    return Number(row?.n ?? 1)
  }

  async adjust(key: string, delta: number, ttlSeconds: number): Promise<number> {
    const now = Date.now()
    const expiresAt = now + Math.max(1, ttlSeconds) * 1000
    const row = this.db
      .prepare(
        `INSERT INTO runtime_coordination(key, value_json, expires_at, updated_at)
         VALUES (?, CAST(? AS TEXT), ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = CASE
             WHEN runtime_coordination.expires_at > ? THEN CAST(runtime_coordination.value_json AS INTEGER) + ?
             ELSE CAST(? AS INTEGER)
           END,
           expires_at = CASE
             WHEN runtime_coordination.expires_at > ? THEN runtime_coordination.expires_at
             ELSE excluded.expires_at
           END,
           updated_at = excluded.updated_at
         RETURNING CAST(value_json AS INTEGER) AS n`,
      )
      .get(key, String(delta), expiresAt, now, now, delta, delta, now) as { n?: number } | undefined
    const next = Number(row?.n ?? 0)
    if (next <= 0) {
      try {
        this.db
          .prepare(
            'DELETE FROM runtime_coordination WHERE key = ? AND CAST(value_json AS INTEGER) <= 0',
          )
          .run(key)
      } catch {
        // ignore
      }
      this.sweep(now)
      return 0
    }
    this.sweep(now)
    return next
  }

  async setIfAbsent(key: string, value: unknown, ttlSeconds: number): Promise<boolean> {
    const now = Date.now()
    const expiresAt = now + Math.max(1, ttlSeconds) * 1000
    const result = this.db
      .prepare(
        `INSERT INTO runtime_coordination(key, value_json, expires_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at
         WHERE runtime_coordination.expires_at <= ?`,
      )
      .run(key, JSON.stringify(value ?? null), expiresAt, now, now)
    this.sweep(now)
    return Number(result.changes ?? 0) === 1
  }

  async compareAndTouch(key: string, value: unknown, ttlSeconds: number): Promise<boolean> {
    const now = Date.now()
    const expiresAt = ttlSeconds > 0 ? now + Math.max(1, ttlSeconds) * 1000 : now
    const result = this.db
      .prepare(
        `UPDATE runtime_coordination
            SET expires_at = ?, updated_at = ?
          WHERE key = ? AND value_json = ? AND expires_at > ?`,
      )
      .run(expiresAt, now, key, JSON.stringify(value ?? null), now)
    return Number(result.changes ?? 0) === 1
  }

  status(): BackendStatus {
    return {
      id: this.id,
      kind: 'cache',
      label: '数据库协调层（多实例）',
      mode: 'builtin',
      state: 'ready',
      detail: '未接 Redis，用共享数据库的 TTL 租约协调 leader、频控与去重；只适合同机共享卷',
      capabilities: ['kv', 'ttl', 'counter', 'shared'],
    }
  }

  async close(): Promise<void> {
    // 连接归 LiveDatabase 管理，这里不关闭
  }
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
export interface LeaderOwner {
  readonly instanceId: string
  readonly host: string
  readonly pid: number
  readonly startedAt: number
  /** 旧版本只写随机 token，没有实例信息；只展示，不做同机接管判断。 */
  readonly legacy?: boolean
}

export interface LeaderHold {
  /** 是否共享层（false 表示单实例，恒为 true） */
  readonly shared: boolean
  /** 当前租约的持有者；待命时可用于展示「被谁持有」。 */
  readonly owner: LeaderOwner
  isHeld(): boolean
  release(): void
}

interface LeaderLease {
  readonly v: 1
  readonly token: string
  readonly owner: LeaderOwner
}

const PROCESS_HOST = hostname()
const PROCESS_STARTED_AT = Date.now() - Math.floor(process.uptime() * 1000)
const PROCESS_INSTANCE_ID = (process.env.EAB_INSTANCE_ID ?? '').trim() || `${PROCESS_HOST}:${process.pid}`

function currentLeaderOwner(): LeaderOwner {
  return {
    instanceId: PROCESS_INSTANCE_ID,
    host: PROCESS_HOST,
    pid: process.pid,
    startedAt: PROCESS_STARTED_AT,
  }
}

function parseLeaderLease(raw: unknown): LeaderLease | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  try {
    const parsed = JSON.parse(raw) as Partial<LeaderLease>
    if (!parsed || parsed.v !== 1 || typeof parsed.token !== 'string') return null
    const owner = parsed.owner as Partial<LeaderOwner> | undefined
    if (!owner || typeof owner.host !== 'string' || typeof owner.pid !== 'number') return null
    return {
      v: 1,
      token: parsed.token,
      owner: {
        instanceId: typeof owner.instanceId === 'string' ? owner.instanceId : '',
        host: owner.host,
        pid: owner.pid,
        startedAt: typeof owner.startedAt === 'number' ? owner.startedAt : 0,
      },
    }
  } catch {
    return null
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM 说明进程存在但当前用户无权发信号；ESRCH 才是已经退出。
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 只接管「同一台机器上、写锁的进程已经退出」的租约。
 *
 * 旧版本/其他主机持有、或同机进程仍存活时一律不接管，避免把正常实例踢掉。
 * 删除前用 compareAndTouch 比对完整值，防止读到旧值后又误删别人刚抢到的锁。
 */
async function takeOverSameHostDeadLeader(cache: CacheBackend, cacheKey: string): Promise<boolean> {
  try {
    const raw = await cache.get<string>(cacheKey)
    const lease = parseLeaderLease(raw)
    if (!lease) return false
    if (lease.owner.host !== PROCESS_HOST) return false
    // 自己进程内的重复调用不当作死锁；正常流程也不会走到这里。
    if (lease.owner.pid === process.pid) return false
    if (isProcessAlive(lease.owner.pid)) return false
    const cleared = await cache.compareAndTouch(cacheKey, raw, 0)
    if (cleared) {
      console.warn(
        `[eab] 接管同机已退出实例的领导权：${lease.owner.instanceId || `${lease.owner.host}:${lease.owner.pid}`}`,
      )
    }
    return cleared
  } catch {
    return false
  }
}

/** 控制台展示用：读取当前领导权持有者；旧版本租约只返回 legacy 标记。 */
export async function readLeaderOwner(key: string): Promise<LeaderOwner | null> {
  if (!coordinationStatus().shared) return currentLeaderOwner()
  try {
    const raw = await activeCache().cache.get<string>(`leader:${key}`)
    const lease = parseLeaderLease(raw)
    if (lease) return lease.owner
    if (typeof raw === 'string' && raw.length > 0) {
      return { instanceId: 'legacy', host: '', pid: 0, startedAt: 0, legacy: true }
    }
    return null
  } catch {
    return null
  }
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
    const owner = currentLeaderOwner()
    return {
      shared: false,
      owner,
      isHeld: () => held,
      release: () => {
        held = false
      },
    }
  }

  const cache = activeCache()
  const cacheKey = `leader:${key}`
  const token = randomUUID()
  const owner = currentLeaderOwner()
  // 写入完整持有者信息：新实例可在同机旧进程退出后立即接管，
  // 旧版本只写 token，新版本会把它当作「未知持有者」，等 TTL 或显式释放。
  const serialized = JSON.stringify({ v: 1, token, owner } satisfies LeaderLease)
  const ttlSec = Math.ceil(ttlMs / 1000)
  const deadline = Date.now() + waitMs
  while (true) {
    let acquired = false
    try {
      acquired = await cache.cache.setIfAbsent(cacheKey, serialized, ttlSec)
    } catch {
      return null
    }
    if (acquired) break
    if (await takeOverSameHostDeadLeader(cache.cache, cacheKey)) continue
    if (Date.now() >= deadline) return null
    await delay(250)
  }

  let held = true
  const renewTimer = setInterval(() => {
    void cache.cache
      .compareAndTouch(cacheKey, serialized, ttlSec)
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
    owner,
    isHeld: () => held,
    release: () => {
      if (!held) return
      held = false
      clearInterval(renewTimer)
      void cache.cache.compareAndTouch(cacheKey, serialized, 0).catch(() => undefined)
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
