import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig } from '../src/config.js'

let home = ''
let previousHome: string | undefined

beforeEach(() => {
  previousHome = process.env.EAB_HOME
  home = mkdtempSync(join(tmpdir(), 'eab-backends-config-'))
  process.env.EAB_HOME = home
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.EAB_HOME
  else process.env.EAB_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

describe('可选后端配置', () => {
  it('不配置 PostgreSQL/Redis 时默认 auto，不会强制外部依赖', () => {
    const config = loadConfig({} as NodeJS.ProcessEnv)
    expect(config.cacheBackend).toBe('auto')
    expect(config.postgresBackend).toBe('auto')
    expect(config.redisUrl).toBe('')
    expect(config.postgresUrl).toBe('')
    expect(config.auditRead).toBe('sqlite')
    expect(config.chatRead).toBe('sqlite')
    expect(config.backendsStrict).toBe(false)
  })

  it('支持任意组合与 strict 开关', () => {
    const config = loadConfig({
      EAB_CACHE: 'redis',
      EAB_REDIS_URL: 'redis://127.0.0.1:6379/0',
      EAB_REDIS_PREFIX: 'eab-test:',
      EAB_POSTGRES: 'mirror',
      EAB_POSTGRES_URL: 'postgres://eab@127.0.0.1:5432/eab',
      EAB_AUDIT_READ: 'postgres',
      EAB_CHAT_READ: 'postgres',
      EAB_BACKENDS_STRICT: '1',
    } as NodeJS.ProcessEnv)
    expect(config.cacheBackend).toBe('redis')
    expect(config.postgresBackend).toBe('mirror')
    expect(config.auditRead).toBe('postgres')
    expect(config.chatRead).toBe('postgres')
    expect(config.redisPrefix).toBe('eab-test:')
    expect(config.backendsStrict).toBe(true)
  })

  it('非法模式直接报人话错误，不猜默认值', () => {
    expect(() =>
      loadConfig({ EAB_CACHE: 'memcached' } as NodeJS.ProcessEnv),
    ).toThrow('EAB_CACHE 只能是 auto / memory / redis / off')
    expect(() =>
      loadConfig({ EAB_POSTGRES: 'primary' } as NodeJS.ProcessEnv),
    ).toThrow('EAB_POSTGRES 只能是 auto / off / mirror')
    expect(() =>
      loadConfig({ EAB_AUDIT_READ: 'pg' } as NodeJS.ProcessEnv),
    ).toThrow('EAB_AUDIT_READ 只能是 sqlite / postgres / auto')
    expect(() =>
      loadConfig({ EAB_CHAT_READ: 'pg' } as NodeJS.ProcessEnv),
    ).toThrow('EAB_CHAT_READ 只能是 sqlite / postgres / auto')
  })
})
