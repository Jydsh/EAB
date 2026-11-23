/**
 * 控制台登录守卫：失败次数锁定 + 全局限速。
 *
 * 为什么需要：`/api/console/login` 原来只比密码，没有失败计数。开了远程控制台之后，
 * 一个弱口令就是可被暴力枚举的入口。单公司本地部署没有 WAF，这里做最小可用的两道闸：
 * - 单账号/IP：连续失败 N 次锁一段时间（默认 5 次 / 10 分钟）；
 * - 全局限速：短时间内失败太多（默认 10 分钟内 30 次）说明在批量打，直接整体拒绝（默认锁 5 分钟）。
 *
 * 状态只放进程内存：控制台是"本机/跳板机"入口，重启即清空是合理的（重启也会换会话）；
 * 这样不必为限流再建表，也不影响多实例各自的独立性。
 */

export interface LoginGuardOptions {
  /** 单账号/IP 连续失败上限，达到即锁定 */
  readonly maxFailures?: number
  /** 单账号/IP 锁定时长 */
  readonly lockMs?: number
  /** 全局失败次数上限 */
  readonly globalMaxFailures?: number
  /** 全局统计窗口 */
  readonly globalWindowMs?: number
  /** 全局锁定时长 */
  readonly globalLockMs?: number
}

export interface LoginGuardState {
  readonly locked: boolean
  /** 还要等多少毫秒才能再试；未锁为 0 */
  readonly retryAfterMs: number
  readonly scope: 'account' | 'global' | 'none'
  readonly failures: number
}

const DEFAULT_MAX_FAILURES = 5
const DEFAULT_LOCK_MS = 10 * 60 * 1000
const DEFAULT_GLOBAL_MAX = 30
const DEFAULT_GLOBAL_WINDOW_MS = 10 * 60 * 1000
const DEFAULT_GLOBAL_LOCK_MS = 5 * 60 * 1000
/** 键数量上限：防止被随机 username 打爆内存。 */
const MAX_KEYS = 5_000

interface KeyState {
  failures: number
  lockedUntil: number
  lastFailureAt: number
}

const accounts = new Map<string, KeyState>()
let globalHits: number[] = []
let globalLockedUntil = 0

export function loginGuardKey(ip: string | undefined, username: string): string {
  const cleanIp = String(ip || '').trim().toLowerCase() || 'unknown'
  const cleanUser = String(username || '').trim().toLowerCase() || 'anonymous'
  return `${cleanIp}|${cleanUser}`
}

function prune(now: number, maxFailures: number, lockMs: number): void {
  if (accounts.size <= MAX_KEYS) {
    // 只清理已经过期且不再锁定的键；仍在锁定期内的保留，锁完自然被下一次清理带走。
    for (const [key, state] of accounts) {
      if (state.lockedUntil > now) continue
      if (now - state.lastFailureAt > lockMs * 2) accounts.delete(key)
    }
    return
  }
  for (const key of accounts.keys()) {
    accounts.delete(key)
    if (accounts.size <= MAX_KEYS / 2) break
  }
  void maxFailures
}

/** 登录前先查：当前是否被锁。 */
export function checkLoginGuard(
  key: string,
  options: LoginGuardOptions = {},
  now = Date.now(),
): LoginGuardState {
  const maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES
  const lockMs = options.lockMs ?? DEFAULT_LOCK_MS
  const windowMs = options.globalWindowMs ?? DEFAULT_GLOBAL_WINDOW_MS
  prune(now, maxFailures, lockMs)

  if (globalLockedUntil > now) {
    return { locked: true, retryAfterMs: globalLockedUntil - now, scope: 'global', failures: accounts.get(key)?.failures ?? 0 }
  }
  const state = accounts.get(key)
  if (state && state.lockedUntil > now) {
    return { locked: true, retryAfterMs: state.lockedUntil - now, scope: 'account', failures: state.failures }
  }
  globalHits = globalHits.filter((at) => now - at <= windowMs)
  return { locked: false, retryAfterMs: 0, scope: 'none', failures: state?.failures ?? 0 }
}

/** 记一次失败；返回记录后的状态（可能刚好触发锁定）。 */
export function recordLoginFailure(
  key: string,
  options: LoginGuardOptions = {},
  now = Date.now(),
): LoginGuardState {
  const maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES
  const lockMs = options.lockMs ?? DEFAULT_LOCK_MS
  const globalMax = options.globalMaxFailures ?? DEFAULT_GLOBAL_MAX
  const windowMs = options.globalWindowMs ?? DEFAULT_GLOBAL_WINDOW_MS
  const globalLockMs = options.globalLockMs ?? DEFAULT_GLOBAL_LOCK_MS

  const previous = accounts.get(key)
  const failures = (previous?.failures ?? 0) + 1
  const lockedUntil = failures >= maxFailures ? now + lockMs : (previous?.lockedUntil ?? 0)
  accounts.set(key, { failures: failures >= maxFailures ? 0 : failures, lockedUntil, lastFailureAt: now })

  globalHits.push(now)
  globalHits = globalHits.filter((at) => now - at <= windowMs)
  if (globalHits.length >= globalMax) {
    globalLockedUntil = now + globalLockMs
    globalHits = []
  }

  if (lockedUntil > now) {
    return { locked: true, retryAfterMs: lockedUntil - now, scope: 'account', failures }
  }
  if (globalLockedUntil > now) {
    return { locked: true, retryAfterMs: globalLockedUntil - now, scope: 'global', failures }
  }
  return { locked: false, retryAfterMs: 0, scope: 'none', failures }
}

/** 登录成功：清掉这个键的失败计数。 */
export function clearLoginFailures(key: string): void {
  accounts.delete(key)
}

/** 测试/运维用：完全重置（例如管理员在控制台手动解锁）。 */
export function resetLoginGuard(): void {
  accounts.clear()
  globalHits = []
  globalLockedUntil = 0
}
