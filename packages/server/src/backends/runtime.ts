/**
 * 后端插件的启动装配。
 *
 * 组合矩阵：
 * - 不配任何外部服务：SQLite + 内存缓存（默认，完整可用）
 * - 只配 Redis：SQLite + Redis/内存兜底
 * - 只配 PostgreSQL：SQLite 主库 + PG 审计镜像
 * - 两个都配：SQLite + PG 审计镜像 + Redis 缓存
 * - strict=1：显式要求的外部后端连不上时启动失败，适合生产探针
 */
import { setAuditMirror } from '@eab/storage'
import type { Db } from '@eab/storage'
import type { ServerConfig } from '../config.js'
import { createAuditReader, type AuditReadSource } from './audit-read.js'
import { createChatReader, type ChatReadSource } from './chat-read.js'
import { HybridCache, MemoryCache, RedisCache, type CacheBackend, type RedisLike } from './cache.js'
import { RedisPubSub, type PubSubBackend, type PubSubClientLike } from './pubsub.js'
import { PostgresAuditMirror } from './postgres.js'
import { PostgresChatMirror } from './postgres-chat.js'
import type { BackendStatus } from './types.js'

export interface BackendRuntime {
  readonly cache: CacheBackend
  /** 跨实例实时广播（Redis Pub/Sub）；未接 Redis 时为 undefined */
  readonly pubsub?: PubSubBackend
  readonly postgres?: PostgresAuditMirror
  /** PostgreSQL 会话镜像；会话读取可选切 PG */
  readonly chatMirror?: PostgresChatMirror
  /** 审计只读仓储：默认 SQLite，可切 PG 镜像并自动回退 */
  readonly auditRead: AuditReadSource
  /** 会话列表只读仓储：默认 SQLite，可切 PG 镜像并自动回退 */
  readonly chatRead: ChatReadSource
  statuses(): BackendStatus[]
  close(): Promise<void>
}

let runtime: BackendRuntime | undefined

export function getBackendRuntime(): BackendRuntime | undefined {
  return runtime
}

/** 测试用：注入一个最小运行时，避免拉起真实外部连接。 */
export function setBackendRuntimeForTest(next: BackendRuntime | undefined): void {
  runtime = next
}

function log(message: string): void {
  console.log(`[eab:backends] ${message}`)
}

/** 错误信息进日志/控制台前先去掉可能出现的连接串，避免泄露密码。 */
function safeMessage(error: unknown, secret: string): string {
  const message = error instanceof Error ? error.message : String(error)
  return secret ? message.split(secret).join('[连接串已隐藏]') : message
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 连接超时（${ms}ms）`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function connectRedis(
  config: ServerConfig,
): Promise<{ cache: CacheBackend; pubsub?: PubSubBackend; failure?: BackendStatus }> {
  const memory = new MemoryCache()
  if (config.cacheBackend === 'off') {
    return { cache: memory }
  }
  const wantsRedis = config.cacheBackend === 'redis' || (config.cacheBackend === 'auto' && Boolean(config.redisUrl))
  if (!wantsRedis) return { cache: memory }

  const failed = (message: string): { cache: CacheBackend; failure: BackendStatus } => ({
    cache: memory,
    failure: {
      id: 'redis',
      kind: 'cache',
      label: 'Redis',
      mode: 'external',
      state: 'failed',
      detail: `未接入，已回退内存缓存：${message}`,
      capabilities: ['kv', 'ttl', 'counter', 'shared'],
    },
  })

  if (!config.redisUrl) {
    const message = 'EAB_CACHE=redis 但没有配置 EAB_REDIS_URL'
    if (config.backendsStrict) throw new Error(message)
    log(`${message}，回退内存缓存`)
    return failed(message)
  }

  try {
    const moduleName = 'redis'
    const redis = (await import(/* @vite-ignore */ moduleName)) as {
      createClient(options: {
        url: string
        socket?: Record<string, unknown>
        disableOfflineQueue?: boolean
      }): RedisLike & {
        connect(): Promise<unknown>
        on(event: string, listener: (...args: unknown[]) => void): unknown
      }
    }
    // 首次连接必须快速失败（否则启动会被无限重试拖住）；连上之后才允许断线重连。
    let cacheReconnectEnabled = false
    let cacheReadyOnce = false
    const cacheReconnectStrategy = (retries: number): number | false => {
      if (!cacheReconnectEnabled) return false
      return Math.min(500 * 2 ** Math.min(Math.max(retries, 0), 4), 5_000)
    }
    const client = redis.createClient({
      url: config.redisUrl,
      socket: { connectTimeout: 1500, reconnectStrategy: cacheReconnectStrategy, keepAlive: true, keepAliveInitialDelay: 30_000 },
      // 断开时不要排队等待，让业务立刻走内存兜底，避免请求被拖住。
      disableOfflineQueue: true,
    })
    const redisCache = new RedisCache(client, config.redisPrefix)
    const hybridCache = new HybridCache(redisCache, memory)
    client.on('error', (error: unknown) => {
      // 连接层错误可能发生在任何命令之前；先标降级，避免控制台显示假 ready。
      redisCache.markFailure(error)
      log(`Redis 错误：${safeMessage(error, config.redisUrl)}`)
    })
    client.on('ready', () => {
      if (!cacheReadyOnce) {
        cacheReadyOnce = true
        return
      }
      if (cacheReconnectEnabled) log('Redis 连接已恢复')
    })
    await withTimeout(Promise.resolve(client.connect()), 2500, 'Redis')
    cacheReconnectEnabled = true
    log('Redis 缓存已接入')

    /**
     * 订阅要用独立连接：Redis 客户端进入订阅态后不能再发普通命令。
     * 订阅失败不影响缓存与业务，只是跨实例实时性退化为单实例。
     */
    let pubsub: PubSubBackend | undefined
    try {
      let subscriberReconnectEnabled = false
      let subscriberReadyOnce = false
      const subscriberReconnectStrategy = (retries: number): number | false => {
        if (!subscriberReconnectEnabled) return false
        return Math.min(500 * 2 ** Math.min(Math.max(retries, 0), 4), 5_000)
      }
      const subscriber = redis.createClient({
        url: config.redisUrl,
        socket: { connectTimeout: 1500, reconnectStrategy: subscriberReconnectStrategy, keepAlive: true, keepAliveInitialDelay: 30_000 },
        disableOfflineQueue: true,
      })
      subscriber.on('error', (error: unknown) => {
        pubsub?.markError?.(error)
        log(`Redis 订阅连接错误：${safeMessage(error, config.redisUrl)}`)
      })
      subscriber.on('ready', () => {
        if (!subscriberReadyOnce) {
          subscriberReadyOnce = true
          return
        }
        if (!subscriberReconnectEnabled) return
        log('Redis 订阅连接已恢复，重新订阅频道')
        void pubsub?.resubscribe?.().catch((error: unknown) => {
          log(`Redis 重新订阅失败：${safeMessage(error, config.redisUrl)}`)
        })
      })
      await withTimeout(Promise.resolve(subscriber.connect()), 2500, 'Redis 订阅')
      subscriberReconnectEnabled = true
      pubsub = new RedisPubSub(subscriber as unknown as PubSubClientLike, `${config.redisPrefix}rt`)
      log('Redis 跨实例广播已接入')
    } catch (error) {
      log(`Redis 跨实例广播不可用（只影响 SSE 跨实例推送）：${safeMessage(error, config.redisUrl)}`)
    }

    return { cache: hybridCache, pubsub }
  } catch (error) {
    const message = safeMessage(error, config.redisUrl)
    if (config.backendsStrict) throw new Error(`Redis 接入失败：${message}`)
    log(`Redis 不可用，回退内存缓存：${message}`)
    return failed(message)
  }
}

async function connectPostgres(
  config: ServerConfig,
  db: Db,
): Promise<{ mirror?: PostgresAuditMirror; chat?: PostgresChatMirror; failure?: BackendStatus }> {
  if (config.postgresBackend === 'off') return {}
  const wantsPostgres =
    config.postgresBackend === 'mirror' || (config.postgresBackend === 'auto' && Boolean(config.postgresUrl))
  if (!wantsPostgres) return {}

  const failed = (message: string): { failure: BackendStatus } => ({
    failure: {
      id: 'postgres-audit',
      kind: 'storage',
      label: 'PostgreSQL 外部存储',
      mode: 'external',
      state: 'failed',
      detail: `未接入，审计镜像与会话镜像都跳过：${message}`,
      capabilities: ['audit-mirror', 'audit-read', 'chat-session-mirror', 'chat-session-read'],
    },
  })

  if (!config.postgresUrl) {
    const message = 'EAB_POSTGRES=mirror 但没有配置 EAB_POSTGRES_URL'
    if (config.backendsStrict) throw new Error(message)
    log(`${message}，跳过审计镜像与会话镜像`)
    return failed(message)
  }

  let pool:
    | {
        query(text: string, values?: readonly unknown[]): Promise<{ rows: unknown[] }>
        end(): Promise<void>
      }
    | undefined
  let mirror: PostgresAuditMirror | undefined
  try {
    const moduleName = 'pg'
    const pg = (await import(/* @vite-ignore */ moduleName)) as {
      Pool: new (options: Record<string, unknown>) => {
        query(text: string, values?: readonly unknown[]): Promise<{ rows: unknown[] }>
        end(): Promise<void>
      }
    }
    pool = new pg.Pool({
      connectionString: config.postgresUrl,
      max: 2,
      connectionTimeoutMillis: 1500,
      query_timeout: 3000,
      idleTimeoutMillis: 30_000,
      allowExitOnIdle: true,
      application_name: 'eab-postgres-plugin',
    })
    await withTimeout(pool.query('SELECT 1'), 2500, 'PostgreSQL')
    mirror = new PostgresAuditMirror(pool, {
      batchSize: 100,
      flushIntervalMs: 500,
      maxQueue: 20_000,
    })
    await mirror.init()
    // 先把 SQLite 里已有的审计灌进镜像；否则首次打开 PG 审计页会是空列表。
    const backfilled = await mirror.backfillFromSqlite(db)
    if (backfilled > 0) log(`PostgreSQL 审计镜像已回填 ${backfilled} 条历史记录`)
    const chat = new PostgresChatMirror(db, pool, {
      batchSize: 100,
      flushIntervalMs: 250,
    })
    await chat.init()
    log('PostgreSQL 审计镜像与会话镜像已接入')
    return { mirror, chat }
  } catch (error) {
    // 审计镜像已启动但会话镜像初始化失败时，先停审计定时器，避免它继续碰已关闭的连接池。
    await mirror?.close().catch(() => undefined)
    if (pool) await pool.end().catch(() => undefined)
    const message = safeMessage(error, config.postgresUrl)
    if (config.backendsStrict) throw new Error(`PostgreSQL 接入失败：${message}`)
    log(`PostgreSQL 不可用，跳过审计镜像与会话镜像：${message}`)
    return failed(message)
  }
}

export async function initBackends(config: ServerConfig, db: Db): Promise<BackendRuntime> {
  const { cache, pubsub, failure: cacheFailure } = await connectRedis(config)
  const {
    mirror: postgres,
    chat: chatMirror,
    failure: postgresFailure,
  } = await connectPostgres(config, db)
  if (postgres) {
    setAuditMirror({
      append: (record) => postgres.append(record),
    })
  } else {
    setAuditMirror(null)
  }
  const auditRead = createAuditReader(db, config.auditRead, postgres)
  const chatRead = createChatReader(db, config.chatRead, chatMirror)

  const instance: BackendRuntime = {
    cache,
    pubsub,
    postgres,
    chatMirror,
    auditRead,
    chatRead,
    statuses: () => {
      const statuses: BackendStatus[] = [
        {
          id: 'sqlite',
          kind: 'storage',
          label: 'SQLite 主库',
          mode: 'builtin',
          state: 'ready',
          detail: '默认主存储；无需外部数据库即可完整运行',
          capabilities: ['transactional', 'single-writer', 'wal'],
        },
        cache.status(),
      ]
      if (cacheFailure) statuses.push(cacheFailure)
      const pubsubStatus = pubsub?.status?.()
      if (pubsubStatus) statuses.push(pubsubStatus)
      if (postgres) statuses.push(postgres.status())
      if (chatMirror) statuses.push(chatMirror.status())
      if (postgresFailure) statuses.push(postgresFailure)
      if (!postgres && !postgresFailure) {
        statuses.push({
          id: 'postgres-audit',
          kind: 'storage',
          label: 'PostgreSQL 外部存储',
          mode: 'external',
          state: 'disabled',
          detail: '未启用；配置 EAB_POSTGRES_URL 与 EAB_POSTGRES=auto|mirror 后生效',
          capabilities: [
            'audit-mirror',
            'audit-read',
            'chat-session-mirror',
            'chat-session-read',
            'batch-write',
            'analytics',
          ],
        })
      }
      return statuses
    },
    close: async () => {
      setAuditMirror(null)
      await cache.close()
      await pubsub?.close?.().catch(() => undefined)
      // 先关闭会话镜像，再由审计镜像关闭共享连接池。
      await chatMirror?.close()
      await postgres?.close()
    },
  }
  runtime = instance
  log(
    `后端组合：${instance
      .statuses()
      .map((item) => `${item.label}=${item.state}`)
      .join('，')}`,
  )
  return instance
}

export async function closeBackends(): Promise<void> {
  const current = runtime
  runtime = undefined
  if (!current) return
  await current.close().catch((error) => {
    log(`关闭外部后端失败：${error instanceof Error ? error.message : String(error)}`)
  })
}
