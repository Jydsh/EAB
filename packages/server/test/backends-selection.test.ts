import { describe, expect, it } from 'vitest'
import type { ServerConfig } from '../src/config.js'
import type { AutoBackendSelection, AutoBackendSource } from '../src/backends/auto.js'
import { resolveBackendUrls } from '../src/backends/runtime.js'

function config(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    cacheBackend: 'auto',
    redisUrl: 'redis://env-redis:6379/0',
    postgresBackend: 'auto',
    postgresUrl: 'postgres://env-postgres/eab',
    backendsFromEnv: false,
    ...overrides,
  } as ServerConfig
}

function source(kind: 'redis' | 'postgres'): AutoBackendSource {
  return {
    id: `conn-${kind}`,
    companyId: 'c1',
    name: `数据连接 ${kind}`,
    kind,
    url: kind === 'redis' ? 'redis://admin-redis:6379/1' : 'postgres://admin-postgres/eab',
  }
}

describe('平台后端来源选择', () => {
  it('数据连接为空时不探测环境变量里的 Redis/PG', () => {
    const urls = resolveBackendUrls(config(), {})
    expect(urls.redisUrl).toBe('')
    expect(urls.postgresUrl).toBe('')
    expect(urls.redisSource).toBeUndefined()
    expect(urls.postgresSource).toBeUndefined()
  })

  it('数据连接有启用项时优先于环境变量', () => {
    const auto: AutoBackendSelection = { redis: source('redis'), postgres: source('postgres') }
    const urls = resolveBackendUrls(config(), auto)
    expect(urls.redisUrl).toBe('redis://admin-redis:6379/1')
    expect(urls.postgresUrl).toBe('postgres://admin-postgres/eab')
    expect(urls.redisSource?.name).toBe('数据连接 redis')
    expect(urls.postgresSource?.name).toBe('数据连接 postgres')
  })

  it('显式 EAB_BACKENDS_FROM_ENV=1 且没有数据连接时保留环境变量回退', () => {
    const urls = resolveBackendUrls(config({ backendsFromEnv: true }), {})
    expect(urls.redisUrl).toBe('redis://env-redis:6379/0')
    expect(urls.postgresUrl).toBe('postgres://env-postgres/eab')
    expect(urls.redisSource).toBeUndefined()
    expect(urls.postgresSource).toBeUndefined()
  })

  it('显式 memory / off 会关闭对应的外部后端', () => {
    const auto: AutoBackendSelection = { redis: source('redis'), postgres: source('postgres') }
    const urls = resolveBackendUrls(config({ cacheBackend: 'memory', postgresBackend: 'off' }), auto)
    expect(urls.redisUrl).toBe('')
    expect(urls.redisSource).toBeUndefined()
    expect(urls.postgresUrl).toBe('')
    expect(urls.postgresSource).toBeUndefined()
  })
})
