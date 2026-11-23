/**
 * 联网工具的每用户限流。
 *
 * 工具并发槽解决的是「同时压满」，这里解决的是「一个用户连续打满外部站点」。
 * 计数只在进程内维护；默认每分钟：搜索 10 次、读网页 20 次、浏览器 20 次。
 * 可用 EAB_WEB_SEARCH_PER_MIN / EAB_WEB_FETCH_PER_MIN / EAB_BROWSER_PER_MIN 调整。
 */
import { EC, EabError } from '@eab/domain'

export type WebToolId = 'web.search' | 'web.fetch' | 'browser'

interface Bucket {
  windowStart: number
  count: number
  lastSeen: number
}

const WINDOW_MS = 60_000
const MAX_TRACKED_KEYS = 20_000
const buckets = new Map<string, Bucket>()

function positiveInt(raw: unknown, fallback: number): number {
  const value = Number(raw)
  return Number.isInteger(value) && value >= 1 && value <= 10_000 ? value : fallback
}

export function webToolRateLimit(toolId: WebToolId, env: NodeJS.ProcessEnv = process.env): number {
  if (toolId === 'web.search') return positiveInt(env.EAB_WEB_SEARCH_PER_MIN, 10)
  if (toolId === 'web.fetch') return positiveInt(env.EAB_WEB_FETCH_PER_MIN, 20)
  return positiveInt(env.EAB_BROWSER_PER_MIN, 20)
}

export interface RateLimitDecision {
  allowed: boolean
  limit: number
  remaining: number
  retryAfterMs: number
}

/** 消费一次额度；不抛错，让调用方决定如何表达拒绝。 */
export function consumeWebToolRateLimit(
  companyId: string,
  userId: string,
  toolId: WebToolId,
  now = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): RateLimitDecision {
  const limit = webToolRateLimit(toolId, env)
  const key = `${companyId}:${userId}:${toolId}`
  let bucket = buckets.get(key)
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    bucket = { windowStart: now, count: 0, lastSeen: now }
    buckets.set(key, bucket)
  }
  bucket.lastSeen = now
  if (bucket.count >= limit) {
    return {
      allowed: false,
      limit,
      remaining: 0,
      retryAfterMs: Math.max(1_000, bucket.windowStart + WINDOW_MS - now),
    }
  }
  bucket.count += 1
  if (buckets.size > MAX_TRACKED_KEYS) {
    for (const [candidate, item] of buckets) {
      if (now - item.lastSeen > WINDOW_MS * 5) buckets.delete(candidate)
    }
  }
  return { allowed: true, limit, remaining: limit - bucket.count, retryAfterMs: 0 }
}

/** 测试用：清空计数，避免用例互相影响。 */
export function resetWebToolRateLimit(): void {
  buckets.clear()
}

/** 工具执行入口使用的统一断言。 */
export function assertWebToolRateLimit(
  companyId: string,
  userId: string,
  toolId: WebToolId,
  now = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): void {
  const decision = consumeWebToolRateLimit(companyId, userId, toolId, now, env)
  if (decision.allowed) return
  throw new EabError(EC.RATE_LIMITED, `「${toolId}」调用过于频繁，请稍后再试`, {
    details: {
      toolId,
      limitPerMinute: decision.limit,
      retryAfterMs: decision.retryAfterMs,
    },
    hint: `每分钟最多 ${decision.limit} 次，约 ${Math.ceil(decision.retryAfterMs / 1000)} 秒后可再试`,
  })
}
