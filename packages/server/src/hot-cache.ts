/**
 * 热数据读缓存（可选 Redis 共享）。
 *
 * 对象是「每轮对话都要重建、但几分钟内不会变」的配置类数据：模型目录、角色可见性、
 * 插件工具目录、组织快照。它们不该每次都查库/重新拼装。
 *
 * 设计取舍：
 * - **短 TTL + 主动失效** 双保险：默认 15 秒，配置保存时按 key 立即删除；
 * - 只缓存「配置」不缓存「状态」：模型健康探测结果、额度、会话正文不进缓存，
 *   否则容灾切换会被拖慢；
 * - 配了 Redis 就共享（一台实例算完，其它实例直接用），没配就进程内 Map，
 *   行为与升级前一致，只是少了几次重复查询。
 */
import { MemoryCache, type CacheBackend } from './backends/cache.js'
import { getBackendRuntime } from './backends/runtime.js'

const KEY_PREFIX = 'hot:'
/** 兜底缓存：没有 backends 运行时（测试/单机）时使用。 */
const localCache = new MemoryCache(5_000)

function activeCache(): { cache: CacheBackend; shared: boolean } {
  const runtime = getBackendRuntime()
  if (runtime?.cache) {
    try {
      if (runtime.cache.status().state === 'ready') return { cache: runtime.cache, shared: true }
    } catch {
      // 状态读失败按未就绪处理
    }
  }
  return { cache: localCache, shared: false }
}

export interface HotCacheStatus {
  readonly shared: boolean
  readonly backend: string
}

export function hotCacheStatus(): HotCacheStatus {
  const active = activeCache()
  return { shared: active.shared, backend: active.cache.id }
}

/** 直接读写共享缓存（用于「状态型」热数据：健康快照、在线人数等）。 */
export async function hotGet<T>(key: string): Promise<T | null> {
  const active = activeCache()
  try {
    const value = await active.cache.get<T>(`${KEY_PREFIX}${key}`)
    return value === undefined ? null : value
  } catch {
    return null
  }
}

export async function hotSet<T>(key: string, value: T, ttlSec: number): Promise<void> {
  const active = activeCache()
  try {
    await active.cache.set(`${KEY_PREFIX}${key}`, value, Math.max(1, Math.floor(ttlSec)))
  } catch {
    // 写失败只影响跨实例可见性
  }
}

/**
 * 读缓存，未命中时用 loader 计算并写回。loader 抛错时不缓存，直接把错误抛给调用方。
 * 缓存层的读写失败都静默降级为「直接算」，不影响业务。
 */
export async function hotRead<T>(key: string, ttlSec: number, loader: () => T | Promise<T>): Promise<T> {
  const active = activeCache()
  const cacheKey = `${KEY_PREFIX}${key}`
  try {
    const hit = await active.cache.get<T>(cacheKey)
    if (hit !== null && hit !== undefined) return hit
  } catch {
    // 读失败直接算
  }
  const value = await loader()
  try {
    await active.cache.set(cacheKey, value, Math.max(1, Math.floor(ttlSec)))
  } catch {
    // 写失败只影响下次命中
  }
  return value
}

/** 主动失效：配置保存/删除后调用，避免用户刚改完仍看到旧数据。 */
export async function invalidateHot(key: string): Promise<void> {
  const active = activeCache()
  try {
    await active.cache.del(`${KEY_PREFIX}${key}`)
  } catch {
    // 删失败等 TTL
  }
}

/** 当前实例的兜底缓存也一起清，保证同 key 在本实例立即生效。 */
export function invalidateHotLocal(key: string): void {
  void localCache.del(`${KEY_PREFIX}${key}`).catch(() => undefined)
}

export async function invalidateHotEverywhere(key: string): Promise<void> {
  invalidateHotLocal(key)
  await invalidateHot(key)
}

/**
 * 版本号做「按前缀失效」：模型目录的 key 带 userId，逐个删不掉；
 * 保存配置时把版本号 +1，所有用户的缓存 key 自然全部未命中。
 */
export async function hotVersionOf(scope: string): Promise<number> {
  const active = activeCache()
  try {
    const value = await active.cache.get<number>(`${KEY_PREFIX}ver:${scope}`)
    return Number(value) || 0
  } catch {
    return 0
  }
}

export async function bumpHotVersion(scope: string): Promise<void> {
  const active = activeCache()
  try {
    await active.cache.adjust(`${KEY_PREFIX}ver:${scope}`, 1, 86_400)
  } catch {
    // 失败等 TTL，最多看到 15 秒旧数据
  }
}

/** 按「作用域 + 版本」缓存：作用域版本号一变，整族 key 立即失效。 */
export async function hotReadVersioned<T>(
  scope: string,
  key: string,
  ttlSec: number,
  loader: () => T | Promise<T>,
): Promise<T> {
  const version = await hotVersionOf(scope)
  return hotRead(`${scope}:v${version}:${key}`, ttlSec, loader)
}
