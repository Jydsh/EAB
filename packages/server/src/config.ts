/**
 * 服务端配置（T-05）。
 *
 * 规则：
 * 1. 只从环境变量读，不从请求读——租户/路径/端口这类东西绝不允许客户端决定。
 * 2. 非法值直接启动失败（带人话原因），不做"猜一个默认值"。
 * 3. 开发预览开关（devAuth）默认关；只有本机自动化测试显式设 EAB_DEV_AUTH=1 才允许 ?as= 冒充。
 */
import { join } from 'node:path'
import { EC, EabError } from '@eab/domain'
import { defaultHomeDir, readConsoleSettings } from './settings.js'

/** 默认部署目录；桌面端用 EAB_HOME 指到用户数据目录。 */
export const DEFAULT_DATA_DIR = defaultHomeDir()
/** 默认库位置锚定部署目录，而不是进程 cwd——`pnpm --filter` 会把 cwd 切到包目录 */
export const DEFAULT_DB_PATH = join(DEFAULT_DATA_DIR, 'eab.db')

export interface ServerConfig {
  readonly host: string
  /** 员工对话端口（默认 8787） */
  readonly port: number
  /** 管理控制台端口（默认 8788）；必须与员工端口不同 */
  readonly adminPort: number
  readonly dbPath: string
  /** 单公司模式：整个实例只服务这一家公司、一个组织架构（默认 c1） */
  readonly companyId: string
  /** 开发预览：允许用 ?as=<userId> 冒充身份。生产必须关。 */
  readonly devAuth: boolean
  /**
   * 控制台服务令牌（可选，给脚本/自动化用）。
   * 浏览器不用它，浏览器走"超级管理员账号 + 密码"登录。
   */
  readonly consoleToken: string
  /** 控制台超级管理员账号：默认 admin，可用 EAB_ADMIN_USER 覆盖 */
  readonly adminUser: string
  /** 控制台超级管理员密码：未配置时启动自动生成并写 .eab-dev/admin-credentials.txt */
  readonly adminPassword: string
  /** 密码来源：环境变量（改了要重启）还是自动生成并落盘（可在账号中心直接改） */
  readonly adminPasswordSource?: 'env' | 'auto'
  /** 总存储位置（所有未独立配置的分类都以它为根）；启动时由 settings 解析后填入 */
  readonly dataDir?: string
  /** 数据目录是否由 EAB_DB 环境变量锁定（锁定时控制台不能改数据库位置） */
  readonly dataDirEnvLocked?: boolean
  /** 数据库目录（eab.db、secrets.json、管理员凭据所在目录） */
  readonly dbDir?: string
  /** 个人 / 部门 / 公司云空间根目录 */
  readonly workspacesDir?: string
  /** OnlyOffice DocumentServer 的浏览器访问地址；为空表示未启用在线文档编辑 */
  readonly onlyOfficeUrl: string
  /** OnlyOffice JWT 密钥，必须与容器里的 JWT_SECRET 一致 */
  readonly onlyOfficeJwtSecret: string
  /** OnlyOffice 容器回访 EAB 的内部地址；默认按 Docker Desktop 的 host.docker.internal 推导 */
  readonly onlyOfficeInternalUrl: string
  /** 临时文件目录 */
  readonly tmpDir?: string
  /** 数据库备份目录 */
  readonly backupsDir?: string
  /** 插件安装目录 */
  readonly pluginsDir?: string
  /** 插件运行数据目录（DSH_HOME 隔离树） */
  readonly dshHomeDir?: string
  /** 插件目录是否由 EAB_PLUGINS_DIR 环境变量锁定 */
  readonly pluginsEnvLocked?: boolean
  /** 是否允许非本机地址登录控制台。默认否——控制台只在服务器本机/内网跳板用。 */
  readonly allowRemoteConsole: boolean
  /** 网络项由环境变量固定时，控制台不能改；未固定的项可在控制台保存。 */
  readonly networkEnvLocked?: {
    readonly host: boolean
    readonly chatPort: boolean
    readonly adminPort: boolean
    readonly allowRemoteConsole: boolean
  }
  readonly logLevel: string
  /** 网页对话全局同时生成上限；超出排队 */
  readonly chatMaxConcurrent?: number
  /** 全局排队上限；满了直接 429 */
  readonly chatQueueLimit?: number
  /** 排队最长等待毫秒数；超时 429 */
  readonly chatQueueTimeoutMs?: number
  /** 同一个人同时最多几条在途消息 */
  readonly chatUserMaxInFlight?: number
  /** 同一个人每分钟最多发起几条消息 */
  readonly chatUserMessagesPerMinute?: number
  /** 同一个模型同时生成上限；默认 4 */
  readonly chatModelMaxConcurrent?: number
  /** 同一个公司同时生成上限；默认等于全局上限 */
  readonly chatCompanyMaxConcurrent?: number
  /** 同一内置工具同时执行上限；默认 8 */
  readonly toolMaxConcurrent?: number
  /** 工具级排队上限；默认 200 */
  readonly toolQueueLimit?: number
  /** 工具级等待名额超时毫秒；默认 30 秒 */
  readonly toolTimeoutMs?: number
  /** 同一插件工具同时执行上限；默认 4 */
  readonly pluginToolMaxConcurrent?: number
  /** 插件工具执行超时毫秒；默认 60 秒 */
  readonly pluginToolTimeoutMs?: number
  /** 一次 agent.spawn 最多并行几个子 Agent；默认 4 */
  readonly agentMaxParallel?: number
  /** 子 Agent 最大嵌套深度（根为 0）；默认 2 */
  readonly agentMaxDepth?: number
  /** 单个子 Agent 最多重试几次；默认 1 */
  readonly agentMaxRetries?: number
  /** 子 Agent 空闲多久没有新任务就自动注销；默认 120 秒 */
  readonly agentWorkerIdleMs?: number
  /** 所有请求体同时在内存中的粗略预算（MB）；超过时新的大请求直接 429 */
  readonly maxInflightBodyMb?: number
  /** 缓存后端：auto（有 URL 用 Redis）、memory、redis、off（仍用内存，只是不尝试外部） */
  readonly cacheBackend: 'auto' | 'memory' | 'redis' | 'off'
  /** Redis 连接串；为空时 auto 自动使用内存缓存 */
  readonly redisUrl: string
  /** Redis key 前缀，避免与服务器上其它应用冲突 */
  readonly redisPrefix: string
  /** PostgreSQL 后端：auto（有 URL 用镜像）、off、mirror（审计镜像） */
  readonly postgresBackend: 'auto' | 'off' | 'mirror'
  /** PostgreSQL 连接串；为空时 auto 自动关闭镜像 */
  readonly postgresUrl: string
  /**
   * 审计读取数据源：
   * - sqlite（默认）：始终读 SQLite 权威链；
   * - postgres：PG 审计镜像可用时读 PG，失败回退 SQLite；
   * - auto：PG 审计镜像可用时读 PG，否则读 SQLite。
   */
  readonly auditRead: 'sqlite' | 'postgres' | 'auto'
  /**
   * 会话列表读取数据源：
   * - sqlite（默认）：始终读 SQLite 权威会话；
   * - postgres：PG 会话镜像追平后读 PG，未追平/失败回退 SQLite；
   * - auto：PG 会话镜像可用时读 PG，否则读 SQLite。
   */
  readonly chatRead: 'sqlite' | 'postgres' | 'auto'
  /** 显式要求的外部后端连不上时是否启动失败；默认 false，降级继续跑 */
  readonly backendsStrict: boolean
}

function readInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new EabError(EC.VALIDATION, `环境变量 ${name} 必须是正整数，当前是 ${raw}`)
  }
  return value
}

/** 0 表示不限制；用于“每用户同时在途”这类可关闭的闸门。 */
function readNonNegativeInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw new EabError(EC.VALIDATION, `环境变量 ${name} 必须是非负整数，当前是 ${raw}`)
  }
  return value
}

function readEnum<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
  name: string,
): T {
  const value = (raw ?? '').trim().toLowerCase()
  if (!value) return fallback
  if (!allowed.includes(value as T)) {
    throw new EabError(EC.VALIDATION, `环境变量 ${name} 只能是 ${allowed.join(' / ')}，当前是 ${raw}`)
  }
  return value as T
}

function normalizeBaseUrl(raw: string | undefined, name: string): string {
  const value = (raw ?? '').trim()
  if (!value) return ''
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new EabError(EC.VALIDATION, `环境变量 ${name} 不是合法地址：${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new EabError(EC.VALIDATION, `环境变量 ${name} 只支持 http/https：${value}`)
  }
  if (url.search || url.hash) {
    throw new EabError(EC.VALIDATION, `环境变量 ${name} 不能带查询参数或锚点：${value}`)
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '')
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const settings = readConsoleSettings()
  const port = readInt(
    env.EAB_PORT ?? (settings.chatPort === null ? undefined : String(settings.chatPort)),
    8787,
    'EAB_PORT',
  )
  if (port > 65535) {
    throw new EabError(EC.VALIDATION, `环境变量 EAB_PORT 超出范围：${port}`)
  }
  const adminPort = readInt(
    env.EAB_ADMIN_PORT ?? (settings.adminPort === null ? undefined : String(settings.adminPort)),
    8788,
    'EAB_ADMIN_PORT',
  )
  if (adminPort > 65535) {
    throw new EabError(EC.VALIDATION, `环境变量 EAB_ADMIN_PORT 超出范围：${adminPort}`)
  }
  if (adminPort === port) {
    throw new EabError(EC.VALIDATION, 'EAB_ADMIN_PORT 不能与 EAB_PORT 相同：两个入口必须分端口', {
      hint: '例如员工 8787、管理 8788',
    })
  }

  const host = (env.EAB_HOST ?? settings.host ?? '127.0.0.1').trim()
  if (!host || /\s/.test(host)) {
    throw new EabError(EC.VALIDATION, `监听地址不合法：${host}`, { hint: '本机用 127.0.0.1，局域网用 0.0.0.0' })
  }

  const onlyOfficeUrl = normalizeBaseUrl(env.EAB_ONLYOFFICE_URL, 'EAB_ONLYOFFICE_URL')
  const onlyOfficeJwtSecret = (env.EAB_ONLYOFFICE_JWT_SECRET ?? '').trim()
  if (onlyOfficeUrl && !onlyOfficeJwtSecret) {
    throw new EabError(EC.VALIDATION, '启用了 OnlyOffice 但缺少 JWT 密钥', {
      hint: 'EAB_ONLYOFFICE_JWT_SECRET 必须与 OnlyOffice 容器的 JWT_SECRET 一致',
    })
  }
  const onlyOfficeInternalUrl = normalizeBaseUrl(
    env.EAB_ONLYOFFICE_INTERNAL_URL ?? `http://host.docker.internal:${port}`,
    'EAB_ONLYOFFICE_INTERNAL_URL',
  )

  return {
    host,
    port,
    adminPort,
    dbPath: env.EAB_DB ?? DEFAULT_DB_PATH,
    companyId: env.EAB_COMPANY_ID ?? 'c1',
    devAuth: (env.EAB_DEV_AUTH ?? '0') === '1',
    onlyOfficeUrl,
    onlyOfficeJwtSecret,
    onlyOfficeInternalUrl,
    /** 新名字优先；`EAB_PLATFORM_TOKEN` 只为兼容旧部署保留 */
    consoleToken: env.EAB_CONSOLE_TOKEN ?? env.EAB_PLATFORM_TOKEN ?? '',
    adminUser: env.EAB_ADMIN_USER ?? 'admin',
    adminPassword: env.EAB_ADMIN_PASSWORD ?? '',
    allowRemoteConsole:
      env.EAB_CONSOLE_ALLOW_REMOTE === undefined
        ? settings.allowRemoteConsole
        : env.EAB_CONSOLE_ALLOW_REMOTE === '1',
    networkEnvLocked: {
      host: env.EAB_HOST !== undefined,
      chatPort: env.EAB_PORT !== undefined,
      adminPort: env.EAB_ADMIN_PORT !== undefined,
      allowRemoteConsole: env.EAB_CONSOLE_ALLOW_REMOTE !== undefined,
    },
    logLevel: env.EAB_LOG_LEVEL ?? 'info',
    chatMaxConcurrent: readInt(env.EAB_CHAT_MAX_CONCURRENT, 8, 'EAB_CHAT_MAX_CONCURRENT'),
    chatQueueLimit: readInt(env.EAB_CHAT_QUEUE_LIMIT, 100, 'EAB_CHAT_QUEUE_LIMIT'),
    chatQueueTimeoutMs: readInt(env.EAB_CHAT_QUEUE_TIMEOUT_MS, 240_000, 'EAB_CHAT_QUEUE_TIMEOUT_MS'),
    // 0 = 不限制；每个会话独立回复，用户开多个对话时不应该被“同时最多 2 条”挡住。
    chatUserMaxInFlight: readNonNegativeInt(
      env.EAB_CHAT_USER_MAX_IN_FLIGHT,
      0,
      'EAB_CHAT_USER_MAX_IN_FLIGHT',
    ),
    chatUserMessagesPerMinute: readInt(env.EAB_CHAT_USER_MESSAGES_PER_MINUTE, 20, 'EAB_CHAT_USER_MESSAGES_PER_MINUTE'),
    chatModelMaxConcurrent: readInt(env.EAB_CHAT_MODEL_MAX_CONCURRENT, 4, 'EAB_CHAT_MODEL_MAX_CONCURRENT'),
    chatCompanyMaxConcurrent: readInt(env.EAB_CHAT_COMPANY_MAX_CONCURRENT, 8, 'EAB_CHAT_COMPANY_MAX_CONCURRENT'),
    toolMaxConcurrent: readInt(env.EAB_TOOL_MAX_CONCURRENT, 8, 'EAB_TOOL_MAX_CONCURRENT'),
    toolQueueLimit: readInt(env.EAB_TOOL_QUEUE_LIMIT, 200, 'EAB_TOOL_QUEUE_LIMIT'),
    toolTimeoutMs: readInt(env.EAB_TOOL_TIMEOUT_MS, 30_000, 'EAB_TOOL_TIMEOUT_MS'),
    pluginToolMaxConcurrent: readInt(env.EAB_PLUGIN_TOOL_MAX_CONCURRENT, 4, 'EAB_PLUGIN_TOOL_MAX_CONCURRENT'),
    pluginToolTimeoutMs: readInt(env.EAB_PLUGIN_TOOL_TIMEOUT_MS, 60_000, 'EAB_PLUGIN_TOOL_TIMEOUT_MS'),
    agentMaxParallel: readInt(env.EAB_AGENT_MAX_PARALLEL, 4, 'EAB_AGENT_MAX_PARALLEL'),
    agentMaxDepth: readInt(env.EAB_AGENT_MAX_DEPTH, 2, 'EAB_AGENT_MAX_DEPTH'),
    agentMaxRetries: readInt(env.EAB_AGENT_MAX_RETRIES, 1, 'EAB_AGENT_MAX_RETRIES'),
    agentWorkerIdleMs: readInt(env.EAB_AGENT_WORKER_IDLE_MS, 120_000, 'EAB_AGENT_WORKER_IDLE_MS'),
    maxInflightBodyMb: readInt(env.EAB_MAX_INFLIGHT_BODY_MB, 256, 'EAB_MAX_INFLIGHT_BODY_MB'),
    cacheBackend: readEnum(env.EAB_CACHE, ['auto', 'memory', 'redis', 'off'] as const, 'auto', 'EAB_CACHE'),
    redisUrl: (env.EAB_REDIS_URL ?? '').trim(),
    redisPrefix: (env.EAB_REDIS_PREFIX ?? 'eab:').trim() || 'eab:',
    postgresBackend: readEnum(
      env.EAB_POSTGRES,
      ['auto', 'off', 'mirror'] as const,
      'auto',
      'EAB_POSTGRES',
    ),
    postgresUrl: (env.EAB_POSTGRES_URL ?? '').trim(),
    auditRead: readEnum(
      env.EAB_AUDIT_READ,
      ['sqlite', 'postgres', 'auto'] as const,
      'sqlite',
      'EAB_AUDIT_READ',
    ),
    chatRead: readEnum(
      env.EAB_CHAT_READ,
      ['sqlite', 'postgres', 'auto'] as const,
      'sqlite',
      'EAB_CHAT_READ',
    ),
    backendsStrict: (env.EAB_BACKENDS_STRICT ?? '0') === '1',
  }
}
