/**
 * 测试用「共享缓存」替身。
 *
 * 协作层只把 `id !== 'memory'` 且状态 ready 的缓存视为跨进程共享；
 * 直接注入 MemoryCache 会被正确识别为本机兜底，不再是共享层。
 * 这里保留 MemoryCache 的存储语义，只把 id 与状态改成外部缓存的样子。
 */
import { MemoryCache, type CacheBackend } from '../../src/backends/cache.js'
import { setBackendRuntimeForTest } from '../../src/backends/runtime.js'

export function createSharedCache(maxEntries = 1_000): CacheBackend {
  const inner = new MemoryCache(maxEntries)
  return {
    id: 'redis',
    get: <T>(key: string) => inner.get<T>(key),
    set: (key, value, ttlSeconds) => inner.set(key, value, ttlSeconds),
    del: (key) => inner.del(key),
    incr: (key, ttlSeconds) => inner.incr(key, ttlSeconds),
    adjust: (key, delta, ttlSeconds) => inner.adjust(key, delta, ttlSeconds),
    setIfAbsent: (key, value, ttlSeconds) => inner.setIfAbsent(key, value, ttlSeconds),
    compareAndTouch: (key, value, ttlSeconds) => inner.compareAndTouch(key, value, ttlSeconds),
    status: () => ({
      id: 'redis',
      kind: 'cache',
      label: 'Redis（测试替身）',
      mode: 'external',
      state: 'ready',
      detail: '测试用共享缓存',
      capabilities: ['rate', 'once', 'shared'],
    }),
    close: async () => {},
  }
}

/** 注入共享层运行时并返回该替身，供测试直接读写 key。 */
export function installSharedCache(maxEntries = 1_000): CacheBackend {
  const cache = createSharedCache(maxEntries)
  setBackendRuntimeForTest({ cache } as never)
  return cache
}
