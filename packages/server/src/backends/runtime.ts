/**
 * 后端插件的启动装配。
 *
 * 组合矩阵：
 * - 控制台“数据连接”里没有 Redis/PG：SQLite + 内存缓存（默认，完整可用）
 * - 数据连接里有 Redis：SQLite + Redis/内存兜底
 * - 数据连接里有 PostgreSQL：SQLite 主库 + PG 审计镜像/会话镜像
 * - 两者都有：SQLite + PG 镜像 + Redis 缓存
 * - 保存/删除数据连接后由 reloadBackends 热切换，不需要重启服务
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
import {
  resolveAutoBackends,
  type AutoBackendSelection,
  type AutoBackendSource,
} from './auto.js'

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

interface BackendSourceMeta {
  readonly source?: 'env' | 'data-connection'
  readonly connectionId?: string
  readonly connectionName?: string
}

function sourceMeta(source: AutoBackendSource | undefined): BackendSourceMeta {
  return source
    ? { source: 'data-connection', connectionId: source.id, connectionName: source.name }
    : { source: 'env' }
}

function withSource(status: BackendStatus, meta: BackendSourceMeta): BackendStatus {
  if (!meta.connectionName) return status
  return {
    ...status,
    ...meta,
    detail: `${status.detail} · 由数据连接「${meta.connectionName}」自动接入`,
  }
}

async function connectRedis(
  config: ServerConfig,
  redisUrl = config.redisUrl,
  source?: AutoBackendSource,
): Promise<{ cache: CacheBackend; pubsub?: PubSubBackend; failure?: BackendStatus }> {
  const memory = new MemoryCache()
  if (config.cacheBackend === 'off') {
    return { cache: memory }
  }
  const wantsRedis = config.cacheBackend === 'redis' || (config.cacheBackend === 'auto' && Boolean(redisUrl))
  if (!wantsRedis) return { cache: memory }
  const sourceText = source ? `（数据连接「${source.name}」）` : ''

  const failed = (message: string): { cache: CacheBackend; failure: BackendStatus } => ({
    cache: memory,
    failure: {
      id: 'redis',
      kind: 'cache',
      label: 'Redis',
      mode: 'external',
      state: 'failed',
      detail: `未接入，已回退内存缓存：${message}${sourceText}`,
      capabilities: ['kv', 'ttl', 'counter', 'shared'],
    },
  })

  if (!redisUrl) {
    // 数据连接为空时按“没有配置外部缓存”处理，不把环境变量里的旧 URL 当成待检测连接。
    log('未配置 Redis 数据连接，使用内存缓存')
    return { cache: memory }
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
      url: redisUrl,
      socket: { connectTimeout: 1500, reconnectStrategy: cacheReconnectStrategy, keepAlive: true, keepAliveInitialDelay: 30_000 },
      // 断开时不要排队等待，让业务立刻走内存兜底，避免请求被拖住。
      disableOfflineQueue: true,
    })
    const redisCache = new RedisCache(client, config.redisPrefix)
    const hybridCache = new HybridCache(redisCache, memory)
    client.on('error', (error: unknown) => {
      // 连接层错误可能发生在任何命令之前；先标降级，避免控制台显示假 ready。
      redisCache.markFailure(error)
      log(`Redis 错误：${safeMessage(error, redisUrl)}`)
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
        url: redisUrl,
        socket: { connectTimeout: 1500, reconnectStrategy: subscriberReconnectStrategy, keepAlive: true, keepAliveInitialDelay: 30_000 },
        disableOfflineQueue: true,
      })
      subscriber.on('error', (error: unknown) => {
        pubsub?.markError?.(error)
        log(`Redis 订阅连接错误：${safeMessage(error, redisUrl)}`)
      })
      subscriber.on('ready', () => {
        if (!subscriberReadyOnce) {
          subscriberReadyOnce = true
          return
        }
        if (!subscriberReconnectEnabled) return
        log('Redis 订阅连接已恢复，重新订阅频道')
        void pubsub?.resubscribe?.().catch((error: unknown) => {
          log(`Redis 重新订阅失败：${safeMessage(error, redisUrl)}`)
        })
      })
      await withTimeout(Promise.resolve(subscriber.connect()), 2500, 'Redis 订阅')
      subscriberReconnectEnabled = true
      pubsub = new RedisPubSub(subscriber as unknown as PubSubClientLike, `${config.redisPrefix}rt`)
      log('Redis 跨实例广播已接入')
    } catch (error) {
      log(`Redis 跨实例广播不可用（只影响 SSE 跨实例推送）：${safeMessage(error, redisUrl)}`)
    }

    return { cache: hybridCache, pubsub }
  } catch (error) {
    const message = safeMessage(error, redisUrl)
    if (config.backendsStrict) throw new Error(`Redis 接入失败：${message}`)
    log(`Redis 不可用，回退内存缓存：${message}`)
    return failed(message)
  }
}

async function connectPostgres(
  config: ServerConfig,
  db: Db,
  postgresUrl = config.postgresUrl,
  source?: AutoBackendSource,
): Promise<{ mirror?: PostgresAuditMirror; chat?: PostgresChatMirror; failure?: BackendStatus }> {
  if (config.postgresBackend === 'off') return {}
  if (!postgresUrl) {
    // 没有数据连接时 PG 就是未启用，不用环境变量里的旧连接串去探测。
    log('未配置 PostgreSQL 数据连接，跳过审计镜像与会话镜像')
    return {}
  }
  const wantsPostgres =
    config.postgresBackend === 'mirror' || (config.postgresBackend === 'auto' && Boolean(postgresUrl))
  if (!wantsPostgres) return {}
  const sourceText = source ? `（数据连接「${source.name}」）` : ''

  const failed = (message: string): { failure: BackendStatus } => ({
    failure: {
      id: 'postgres-audit',
      kind: 'storage',
      label: 'PostgreSQL 外部存储',
      mode: 'external',
      state: 'failed',
      detail: `未接入，审计镜像与会话镜像都跳过：${message}${sourceText}`,
      capabilities: ['audit-mirror', 'audit-read', 'chat-session-mirror', 'chat-session-read'],
    },
  })

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
      connectionString: postgresUrl,
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
    log(`PostgreSQL 审计镜像与会话镜像已接入${sourceText}`)
    return { mirror, chat }
  } catch (error) {
    // 审计镜像已启动但会话镜像初始化失败时，先停审计定时器，避免它继续碰已关闭的连接池。
    await mirror?.close().catch(() => undefined)
    if (pool) await pool.end().catch(() => undefined)
    const message = safeMessage(error, postgresUrl)
    if (config.backendsStrict) throw new Error(`PostgreSQL 接入失败：${message}`)
    log(`PostgreSQL 不可用，跳过审计镜像与会话镜像：${message}`)
    return failed(message)
  }
}

interface RuntimeState {
  cache: CacheBackend
  pubsub?: PubSubBackend
  postgres?: PostgresAuditMirror
  chatMirror?: PostgresChatMirror
  auditRead: AuditReadSource
  chatRead: ChatReadSource
  cacheFailure?: BackendStatus
  postgresFailure?: BackendStatus
  redisUrl: string
  postgresUrl: string
  redisSource?: AutoBackendSource
  postgresSource?: AutoBackendSource
  autoReason?: string
}

let runtimeState: RuntimeState | undefined
let reloadChain: Promise<unknown> = Promise.resolve()

/**
 * 平台后端地址以控制台「数据连接」为准。
 *
 * - 数据连接里有启用的 Redis/PG：无论环境变量写什么，都用数据连接；
 * - 数据连接里没有：默认只用 SQLite + 内存，不探测环境变量里的连接；
 * - 只有显式 EAB_BACKENDS_FROM_ENV=1 时，才把环境变量作为老部署的兼容回退。
 */
export function resolveBackendUrls(config: ServerConfig, auto: AutoBackendSelection): {
  redisUrl: string
  postgresUrl: string
  redisSource?: AutoBackendSource
  postgresSource?: AutoBackendSource
} {
  const redisEnabled = config.cacheBackend !== 'memory' && config.cacheBackend !== 'off'
  const postgresEnabled = config.postgresBackend !== 'off'
  const redisSource = redisEnabled ? auto.redis : undefined
  const postgresSource = postgresEnabled ? auto.postgres : undefined
  const envRedisUrl =
    !redisSource && config.backendsFromEnv && redisEnabled ? config.redisUrl : ''
  const envPostgresUrl =
    !postgresSource && config.backendsFromEnv && postgresEnabled ? config.postgresUrl : ''
  return {
    redisUrl: redisSource?.url || envRedisUrl || '',
    postgresUrl: postgresSource?.url || envPostgresUrl || '',
    redisSource,
    postgresSource,
  }
}

function statusesOf(state: RuntimeState): BackendStatus[] {
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
    state.redisSource
      ? withSource(state.cache.status(), sourceMeta(state.redisSource))
      : state.cache.status(),
  ]
  if (state.cacheFailure) statuses.push(state.cacheFailure)
  const pubsubStatus = state.pubsub?.status?.()
  if (pubsubStatus) {
    statuses.push(
      state.redisSource ? withSource(pubsubStatus, sourceMeta(state.redisSource)) : pubsubStatus,
    )
  }
  if (state.postgres) {
    statuses.push(
      state.postgresSource
        ? withSource(state.postgres.status(), sourceMeta(state.postgresSource))
        : state.postgres.status(),
    )
  }
  if (state.chatMirror) {
    statuses.push(
      state.postgresSource
        ? withSource(state.chatMirror.status(), sourceMeta(state.postgresSource))
        : state.chatMirror.status(),
    )
  }
  if (state.postgresFailure) statuses.push(state.postgresFailure)
  if (!state.postgres && !state.postgresFailure) {
    statuses.push({
      id: 'postgres-audit',
      kind: 'storage',
      label: 'PostgreSQL 外部存储',
      mode: 'external',
      state: 'disabled',
      detail: state.autoReason
        ? `未启用；${state.autoReason}`
        : '未启用；只有控制台“数据连接”中启用 PostgreSQL 后才会探测和接入',
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
}

async function closeState(state: RuntimeState): Promise<void> {
  await state.cache.close().catch(() => undefined)
  await state.pubsub?.close?.().catch(() => undefined)
  // 先关闭会话镜像，再由审计镜像关闭共享连接池。
  await state.chatMirror?.close().catch(() => undefined)
  await state.postgres?.close().catch(() => undefined)
}

export async function initBackends(config: ServerConfig, db: Db): Promise<BackendRuntime> {
  const auto = resolveAutoBackends(db, config.dbPath)
  const urls = resolveBackendUrls(config, auto)
  const { cache, pubsub, failure: cacheFailure } = await connectRedis(
    config,
    urls.redisUrl,
    urls.redisSource,
  )
  const {
    mirror: postgres,
    chat: chatMirror,
    failure: postgresFailure,
  } = await connectPostgres(config, db, urls.postgresUrl, urls.postgresSource)
  if (postgres) {
    setAuditMirror({
      append: (record) => postgres.append(record),
    })
  } else {
    setAuditMirror(null)
  }
  const state: RuntimeState = {
    cache,
    pubsub,
    postgres,
    chatMirror,
    auditRead: createAuditReader(db, config.auditRead, postgres),
    chatRead: createChatReader(db, config.chatRead, chatMirror),
    cacheFailure,
    postgresFailure,
    redisUrl: urls.redisUrl,
    postgresUrl: urls.postgresUrl,
    redisSource: urls.redisSource,
    postgresSource: urls.postgresSource,
    autoReason: auto.reason,
  }
  runtimeState = state

  const instance: BackendRuntime = {
    get cache() {
      return runtimeState?.cache ?? cache
    },
    get pubsub() {
      return runtimeState?.pubsub
    },
    get postgres() {
      return runtimeState?.postgres
    },
    get chatMirror() {
      return runtimeState?.chatMirror
    },
    get auditRead() {
      return runtimeState?.auditRead ?? state.auditRead
    },
    get chatRead() {
      return runtimeState?.chatRead ?? state.chatRead
    },
    statuses: () => statusesOf(runtimeState ?? state),
    close: async () => {
      setAuditMirror(null)
      const current = runtimeState
      runtimeState = undefined
      if (current) await closeState(current)
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

/**
 * 数据连接保存/测试/删除后热重连平台后端。
 *
 * 只采纳单公司部署的启用连接；控制台有连接时以连接为准，
 * 没有连接时退回 SQLite + 内存，不会继续沿用环境变量里的外部连接。
 */
export async function reloadBackends(config: ServerConfig, db: Db): Promise<boolean> {
  const run = async (): Promise<boolean> => {
    if (!runtimeState) return false
    const auto = resolveAutoBackends(db, config.dbPath)
    const urls = resolveBackendUrls(config, auto)
    const current = runtimeState
    const redisChanged =
      current.redisUrl !== urls.redisUrl ||
      current.redisSource?.id !== urls.redisSource?.id ||
      current.redisSource?.name !== urls.redisSource?.name
    const postgresChanged =
      current.postgresUrl !== urls.postgresUrl ||
      current.postgresSource?.id !== urls.postgresSource?.id ||
      current.postgresSource?.name !== urls.postgresSource?.name
    if (!redisChanged && !postgresChanged) {
      current.autoReason = auto.reason
      return false
    }

    try {
      let { cache, pubsub, cacheFailure } = current
      if (redisChanged) {
        const connected = await connectRedis(config, urls.redisUrl, urls.redisSource)
        cache = connected.cache
        pubsub = connected.pubsub
        cacheFailure = connected.failure
      }

      let { postgres, chatMirror, postgresFailure } = current
      if (postgresChanged) {
        const connected = await connectPostgres(config, db, urls.postgresUrl, urls.postgresSource)
        postgres = connected.mirror
        chatMirror = connected.chat
        postgresFailure = connected.failure
      }

      const next: RuntimeState = {
        cache,
        pubsub,
        postgres,
        chatMirror,
        auditRead: createAuditReader(db, config.auditRead, postgres),
        chatRead: createChatReader(db, config.chatRead, chatMirror),
        cacheFailure,
        postgresFailure,
        redisUrl: urls.redisUrl,
        postgresUrl: urls.postgresUrl,
        redisSource: urls.redisSource,
        postgresSource: urls.postgresSource,
        autoReason: auto.reason,
      }
      if (postgresChanged) {
        setAuditMirror(
          postgres
            ? {
                append: (record) => postgres.append(record),
              }
            : null,
        )
      }
      runtimeState = next
      log(
        `平台后端已按数据连接切换：Redis=${urls.redisSource?.name ?? (urls.redisUrl ? '环境变量' : '内存')}，` +
          `PostgreSQL=${urls.postgresSource?.name ?? (urls.postgresUrl ? '环境变量' : '未启用')}`,
      )
      // 只关闭本次真正被替换的连接，给在途读取留出收尾时间。
      const timer = setTimeout(() => {
        if (redisChanged) {
          void current.cache.close().catch(() => undefined)
          void current.pubsub?.close?.().catch(() => undefined)
        }
        if (postgresChanged) {
          void current.chatMirror?.close().catch(() => undefined)
          void current.postgres?.close().catch(() => undefined)
        }
      }, 5_000)
      timer.unref?.()
      return true
    } catch (error) {
      log(`平台后端自动接入失败，保留原连接：${safeMessage(error, urls.postgresUrl || urls.redisUrl)}`)
      return false
    }
  }
  reloadChain = reloadChain.then(run, run)
  return reloadChain as Promise<boolean>
}

export async function closeBackends(): Promise<void> {
  const current = runtime
  runtime = undefined
  if (!current) return
  await current.close().catch((error) => {
    log(`关闭外部后端失败：${error instanceof Error ? error.message : String(error)}`)
  })
}
