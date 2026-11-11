/**
 * DSH 插件宿主兼容层。
 *
 * D:/dsh 下的插件不是"静态页面包"，而是 DSH 的 bundle 插件：
 * - host 侧 `apply(ctx)`，通过 `ctx.connection.fetch.register()` 暴露自己的 RPC 通道；
 * - client 侧 `__ModuleLoader__` bundle，通过 `ctx.slots.register()` 往管理台挂页面。
 *
 * 这一层的职责：在 EAB 进程里给 host 侧造一个最小但契约正确的 ctx，把 apply() 真正跑起来；
 * client 侧交给 `public/plugin-host.html` 的 DSH 兼容运行时。两边收发的是同一套
 * `{type:'client-request'|'server-response', rpcId, method, payload}` 报文，所以插件源码不用改。
 *
 * 不假装支持的部分：
 * - `ctx.llm.registerAdapter` 会把模型投影到 EAB 模型目录，并进入对话路由；
 * - `ctx.inject(['tools'])` 支持注册，但工具只在插件对该员工安装且启用时进入对话；
 * - host 注册的 HTTP 路由只能通过控制台鉴权的桥接接口访问，不直接挂到公网路径上。
 */
import { existsSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Readable, Writable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import type { Db } from '@eab/storage'
import { listPluginDirectories, loadPlugins, readPluginDirectory, type PluginRecord } from './plugins.js'
import { dshCompatRoot, dshImCredentials, prepareDshImCompat, type DshImOptions } from './dsh-im-compat.js'
import { clearPluginContributions, registerPluginPrompt, registerPluginTool, unregisterPluginTool } from './plugin-tools.js'
import {
  listPluginChannels,
  listAllPluginModels,
  registerPluginAdapter,
  registerPluginConfigurableProviders,
  registerPluginModelDiscovery,
  removePluginModelsForPlugin,
  setPluginModelActiveResolver,
} from './plugin-models.js'

export interface PluginHostRoute {
  readonly path: string
  readonly kind: 'exact' | 'prefix'
  readonly methods: readonly string[]
  readonly fetch: (request: Request) => Promise<Response>
}

export interface PluginHostStatus {
  readonly id: string
  readonly companyId: string
  readonly loaded: boolean
  readonly state: 'pending' | 'active' | 'failed' | 'disposed'
  readonly pendingServices: readonly string[]
  readonly hostEntry: string | null
  readonly startedAt: number | null
  readonly error: string | null
  readonly routes: readonly string[]
  readonly logs: readonly string[]
  readonly llmProviders: number
  readonly llmModels: number
}

export interface HostInstance {
  readonly id: string
  readonly companyId: string
  readonly record: PluginRecord
  readonly routes: Map<string, PluginHostRoute>
  readonly upgrades: Map<string, unknown>
  readonly logs: string[]
  readonly disposers: Array<() => void | Promise<void>>
  root: Context | null
  fiber: Fiber | null
  startedAt: number
  error: string | null
  llmProviders: number
  llmModels: number
}

/** 插件不能占用的 EAB 自有接口前缀 */
const RESERVED_API_PREFIXES = [
  '/api/console',
  '/api/my',
  '/api/plugins',
  '/api/auth',
  '/api/admin',
  '/api/health',
  '/api/system',
  '/api/settings',
  '/api/workspace',
  '/api/memory',
  '/api/chat',
  '/api/org',
  '/api/channel',
  '/api/kb',
  '/api/quota',
  '/api/tools',
  '/api/sync',
]

const instances = new Map<string, HostInstance>()
let loadedDb: Db | null = null
let loadedOptions: DshImOptions | null = null

// 模型查询时按真实安装/启停状态兜底过滤；host 尚未初始化时一律不可见。
setPluginModelActiveResolver((companyId, pluginId) =>
  loadedDb ? pluginEnabledForModels(loadedDb, companyId, pluginId) : false,
)

function hostKey(companyId: string, pluginId: string): string {
  return `${companyId}:${pluginId}`
}

function getHostInstance(pluginId: string, companyId = 'c1'): HostInstance | undefined {
  // 必须严格按公司隔离：找不到本公司的 host 就返回空，不能回退到别的公司实例。
  return instances.get(hostKey(companyId, pluginId))
}

function isReserved(path: string): boolean {
  return RESERVED_API_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
}

/** 哪些公司真正启用了这个插件；host 必须按公司隔离，不能只启动最后一家。 */
function enabledCompanyIds(db: Db, pluginId: string): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT company_id FROM plugin_company_installs
        WHERE plugin_id = ? AND removed_at IS NULL
       UNION
       SELECT DISTINCT company_id FROM plugin_user_installs
        WHERE plugin_id = ? AND removed_at IS NULL AND enabled = 1`,
    )
    .all(pluginId, pluginId) as unknown as Array<{ company_id: string }>
  return rows
    .map((row) => row.company_id)
    .filter((companyId) => {
      const state = db
        .prepare('SELECT enabled FROM plugin_states WHERE company_id = ? AND plugin_id = ?')
        .get(companyId, pluginId) as { enabled: number } | undefined
      return !state || state.enabled === 1
    })
}

/**
 * 模型目录用的插件有效性判断：插件目录仍在磁盘、清单有效、安装未卸载且未被停用。
 * 卸载后目录会移入 .trash，仅看 plugin_company_installs 会把“已卸载但数据库残留”的
 * 插件模型继续暴露出来；这里以 loadPlugins 的实际可见结果为准，并保留个人安装启用。
 */
const pluginActiveCache = new Map<string, { db: Db; at: number; ids: Set<string> }>()
function activePluginIds(db: Db, companyId: string): Set<string> {
  const cached = pluginActiveCache.get(companyId)
  if (cached && cached.db === db && Date.now() - cached.at < 1_000) return cached.ids
  const plugins = loadPlugins(db, companyId)
  const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]))
  const ids = new Set(
    plugins
      .filter(
        (plugin) =>
          plugin.valid &&
          plugin.enabled &&
          Boolean(plugin.companyInstall && !plugin.companyInstall.removedAt),
      )
      .map((plugin) => plugin.id),
  )
  const userRows = db
    .prepare(
      `SELECT plugin_id FROM plugin_user_installs
        WHERE company_id = ? AND removed_at IS NULL AND enabled = 1`,
    )
    .all(companyId) as unknown as Array<{ plugin_id: string }>
  for (const row of userRows) {
    const plugin = byId.get(row.plugin_id)
    if (plugin?.valid && plugin.enabled) ids.add(plugin.id)
  }
  pluginActiveCache.set(companyId, { db, at: Date.now(), ids })
  return ids
}

function pluginEnabledForModels(db: Db, companyId: string, pluginId: string): boolean {
  return activePluginIds(db, companyId).has(String(pluginId))
}

function collectProviderRows(db: Db): Array<{ id: string; name: string; kind: string }> {
  return db
    .prepare(
      `SELECT id, name, kind FROM model_providers
        WHERE deleted_at IS NULL
        ORDER BY created_at ASC`,
    )
    .all() as unknown as Array<{ id: string; name: string; kind: string }>
}

function collectModelRows(db: Db, providerId: string): Array<{ provider: string; id: string; name: string }> {
  const rows = db
    .prepare(
      `SELECT provider_id, id, name, model_key FROM models
        WHERE provider_id = ? AND deleted_at IS NULL AND enabled = 1
        ORDER BY priority ASC, created_at ASC`,
    )
    .all(providerId) as unknown as Array<{ provider_id: string; id: string; name: string; model_key: string }>
  return rows.map((row) => ({
    provider: row.provider_id,
    id: row.model_key || row.id,
    name: row.name || row.model_key || row.id,
  }))
}

function formatLogArg(arg: unknown): string {
  if (typeof arg === 'string') return arg
  // Error 的属性不可枚举，JSON.stringify(new TypeError(...)) 只会得到 {}；
  // 插件渠道初始化失败正是以 Error 对象进日志的，必须单独取出 name/message。
  if (arg instanceof Error) {
    const message = arg.message ? `${arg.name}: ${arg.message}` : arg.name
    return message
  }
  try {
    return JSON.stringify(arg)
  } catch {
    return String(arg)
  }
}

function makeLogger(instance: HostInstance, scope = 'dsh-plugin'): Record<string, (...args: unknown[]) => void> {
  const emit = (level: string) =>
    (...args: unknown[]): void => {
      const message = args.map(formatLogArg).join(' ')
      instance.logs.push(`[${new Date().toISOString()}] ${level} ${scope}: ${message}`)
      if (instance.logs.length > 200) instance.logs.splice(0, instance.logs.length - 200)
      const target = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
      target(`[plugin:${instance.id}] ${message}`)
    }
  return {
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    debug: emit('debug'),
  }
}

/**
 * DSH 的 Typert 网关在 Host 进程里把插件对 Workspace / Session 的调用转给真正的
 * 会话后端。EAB 没有 DSH 的 Session 服务，但 dsh-im 的渠道初始化只要求网关
 * 存在且 shape 正确；这里把它桥到 EAB 已有的 chat_sessions / 模型目录。
 *
 * 明确边界：`session.prompt` / `commands.execute` 还没有接入 EAB 的 Agent 运行链，
 * 会返回可识别的 failure，而不是假装成功让插件在后续等待中挂住。
 */
function typertFailure(code: string, message: string, details: Record<string, unknown> = {}): Error {
  const error = new Error(message)
  error.name = 'TypertGatewayError'
  ;(error as Error & { failure?: unknown }).failure = { code, message, details }
  return error
}

function typertFrames<T>(frames: readonly T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: () => {
      let index = 0
      return {
        next: async () => (index < frames.length
          ? { value: frames[index++], done: false }
          : { value: undefined, done: true }),
        return: async () => ({ value: undefined, done: true }),
      }
    },
  }
}

function eabWorkspacePath(options: DshImOptions | null): string {
  if (!options) return join(process.cwd(), '.eab-dev', 'dsh-home', 'im')
  return join(dshCompatRoot(options), 'im')
}

function eabModelCatalog(db: Db): {
  groups: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>
  failures: unknown[]
  routableProviders: string[]
  default: { provider: string; model: string }
} {
  const groups = collectProviderRows(db)
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
      models: collectModelRows(db, provider.id).map((model) => ({ id: model.id, name: model.name })),
    }))
    .filter((group) => group.models.length > 0)
  const first = groups[0]?.models[0]
  return {
    groups,
    failures: [],
    routableProviders: groups.map((group) => group.id),
    default: first
      ? { provider: groups[0]!.id, model: first.id }
      : { provider: 'eab', model: 'default' },
  }
}

function eabSessionRows(db: Db, companyId: string): Array<{
  id: string
  title: string
  created_at: number
  updated_at: number
}> {
  return db
    .prepare(
      `SELECT id, title, created_at, updated_at
         FROM chat_sessions
        WHERE company_id = ? AND deleted_at IS NULL
        ORDER BY updated_at DESC
        LIMIT 200`,
    )
    .all(companyId) as unknown as Array<{
      id: string
      title: string
      created_at: number
      updated_at: number
    }>
}

function makeTypertGateway(db: Db, options: DshImOptions | null): {
  invoke: (request: unknown) => Promise<unknown>
  stream: (request: unknown) => AsyncIterable<unknown>
} {
  const companyId = options?.companyId ?? 'c1'
  const workspacePath = eabWorkspacePath(options)
  const workspace = Object.freeze({
    workspaceId: 'eab-im',
    name: 'EAB 工作台',
    path: workspacePath,
  })
  const catalog = () => eabModelCatalog(db)
  const defaultSelection = () => {
    const model = catalog().default
    return { values: { modelSelection: { lastUsed: model, next: model } } }
  }
  const snapshotFor = (sessionId: string) => {
    const row = db
      .prepare(
        `SELECT id, title, created_at, updated_at
           FROM chat_sessions
          WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
      )
      .get(sessionId, companyId) as
      | { id: string; title: string; created_at: number; updated_at: number }
      | undefined
    return {
      type: 'snapshot',
      cursor: Number(row?.updated_at ?? 0),
      header: {
        id: sessionId,
        cwd: workspacePath,
        title: row?.title ?? '',
        createdAt: row?.created_at ?? 0,
        updatedAt: row?.updated_at ?? 0,
      },
      records: [],
      hasMore: false,
      projections: {
        values: {
          permissions: { currentValue: 'default' },
          ...(defaultSelection().values),
        },
      },
    }
  }

  return {
    async invoke(raw: unknown) {
      const request = (raw ?? {}) as {
        namespace?: unknown
        method?: unknown
        args?: Record<string, any>
      }
      const namespace = String(request.namespace ?? '')
      const method = String(request.method ?? '')
      const args = request.args ?? {}
      const key = `${namespace}.${method}`
      switch (key) {
        case 'host.describe':
          return { ready: true, transport: 'typert' }
        case 'workspace.rename':
        case 'workspace.create':
          return {
            workspace: {
              ...workspace,
              path: typeof args.request?.path === 'string' ? args.request.path : workspacePath,
            },
          }
        case 'session.list':
          return {
            items: eabSessionRows(db, companyId).map((row) => ({
              sessionId: row.id,
              title: row.title,
              cwd: workspacePath,
              running: false,
              createdAt: row.created_at,
              updatedAt: row.updated_at,
              projections: defaultSelection(),
            })),
          }
        case 'session.create': {
          const requested = args.request?.sessionId
          const sessionId = typeof requested === 'string' && requested.trim()
            ? requested.trim()
            : randomUUID()
          return { sessionId, cwd: workspacePath, workspaceId: 'eab-im' }
        }
        case 'session.page':
          return { records: [], hasMore: false }
        case 'session.modelCatalog':
          return catalog()
        case 'session.projections': {
          const sessionId = String(args.request?.sessionId ?? '')
          return {
            values: {
              permissions: { currentValue: 'default' },
              ...(defaultSelection().values),
            },
            sessionId,
          }
        }
        case 'permissionPresets.catalog':
          return {
            options: [
              { id: 'default', name: '默认', description: 'EAB 网页工作台的默认权限' },
            ],
          }
        case 'session.rename':
          return { title: String(args.request?.title ?? '') }
        case 'session.cancel':
          return { cancelled: true, sessionId: String(args.request?.sessionId ?? '') }
        case 'session.selectModel':
          return {
            selected: {
              provider: String(args.request?.provider ?? ''),
              model: String(args.request?.model ?? ''),
              ...(args.request?.reasoningEffort === undefined
                ? {}
                : { reasoningEffort: String(args.request.reasoningEffort) }),
            },
          }
        case 'session.prompt':
          throw typertFailure(
            'gateway/session-prompt-unavailable',
            'EAB 的 Typert 网关桥还没有把插件会话提交接入 EAB Agent 运行链。',
            { method: key },
          )
        case 'commands.execute':
          throw typertFailure(
            'gateway/commands-unavailable',
            'EAB 的 Typert 网关桥还没有接入 DSH 命令执行器。',
            { method: key },
          )
        default:
          throw typertFailure(
            'gateway/not-supported',
            `EAB 的 Typert 网关桥不支持 ${key}`,
            { method: key },
          )
      }
    },
    stream(raw: unknown) {
      const request = (raw ?? {}) as { namespace?: unknown; method?: unknown; args?: Record<string, any> }
      const key = `${String(request.namespace ?? '')}.${String(request.method ?? '')}`
      if (key === 'workspace.follow') {
        return typertFrames([
          {
            type: 'baseline',
            value: {
              items: [{ ...workspace, sessionIds: eabSessionRows(db, companyId).map((row) => row.id) }],
              archivedSessionIds: [],
            },
          },
        ])
      }
      if (key === 'session.follow') {
        const sessionId = String(request.args?.request?.address?.sessionId ?? '')
        return typertFrames([snapshotFor(sessionId)])
      }
      return typertFrames([])
    },
  }
}

/**
 * 把 DSH webServer 的 Node 风格 handler 适配成 EAB 内部的 Request/Response 路由。
 * DSH 插件的 http handler 使用 IncomingMessage/ServerResponse，而 EAB 的桥接层
 * 目前用 fetch 风格；这里做一个最小适配，至少让注册、路由表、清理和调用都成立。
 */
function adaptNodeHandler(
  handler: (request: any, response: any) => unknown,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : Buffer.alloc(0)
    const req = Readable.from(body.length > 0 ? [body] : []) as any
    req.method = request.method
    req.url = new URL(request.url).pathname + new URL(request.url).search
    req.headers = Object.fromEntries(request.headers.entries())

    let status = 200
    let statusMessage: string | undefined
    const headers: Record<string, string> = {}
    const chunks: Buffer[] = []
    const res = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        callback()
      },
    }) as any
    res.writeHead = (code: number, messageOrHeaders?: string | Record<string, string>, maybeHeaders?: Record<string, string>) => {
      status = code
      if (typeof messageOrHeaders === 'string') statusMessage = messageOrHeaders
      const headerBag = typeof messageOrHeaders === 'string' ? maybeHeaders : messageOrHeaders
      if (headerBag) for (const [key, value] of Object.entries(headerBag)) headers[key] = String(value)
      return res
    }
    res.setHeader = (key: string, value: unknown) => {
      headers[key] = String(value)
      return res
    }
    res.getHeader = (key: string) => headers[key]

    try {
      await handler(req, res)
      // handler 正常会 end()；如果它只 return 不 end，等一个短窗口后照样返回已写内容，
      // 避免把插件调用挂死。
      await Promise.race([
        finished(res).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ])
    } catch (error) {
      if (!res.writableEnded) {
        status = 500
        res.end(String((error as Error)?.message ?? error))
      }
    }

    const responseHeaders = new Headers()
    for (const [key, value] of Object.entries(headers)) responseHeaders.set(key, value)
    return new Response(Buffer.concat(chunks), {
      status,
      statusText: statusMessage,
      headers: responseHeaders,
    })
  }
}

function readCompanySettings(db: Db, companyId: string): Record<string, any> {
  const row = db
    .prepare('SELECT settings_json FROM companies WHERE id = ?')
    .get(companyId) as { settings_json?: string | null } | undefined
  if (!row?.settings_json) return {}
  try {
    const parsed = JSON.parse(row.settings_json)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function writeCompanySettings(db: Db, companyId: string, value: Record<string, any>): void {
  db.prepare('UPDATE companies SET settings_json = ? WHERE id = ?').run(JSON.stringify(value), companyId)
}

function makeSettingsService(
  db: Db,
  companyId: string,
  pluginId: string,
  emit: (event: string, ...args: unknown[]) => void,
): {
  get: (ns: string) => Record<string, any>
  describe: () => Array<Record<string, any>>
  set: (ns: string, value: Record<string, any>) => void
  update: (ns: string, patch: Record<string, any>) => void
  all: () => Record<string, any>
} {
  const root = () => {
    const settings = readCompanySettings(db, companyId)
    if (!settings.pluginSettings || typeof settings.pluginSettings !== 'object') settings.pluginSettings = {}
    if (!settings.pluginSettings[pluginId] || typeof settings.pluginSettings[pluginId] !== 'object') {
      settings.pluginSettings[pluginId] = {}
    }
    return settings
  }
  const namespace = (settings: Record<string, any>, ns: string): Record<string, any> => {
    // locale 是 DSH 的公共设置命名空间；兼容它放在顶层，其余插件设置按插件隔离。
    const bag = ns === 'locale'
      ? (settings.locale && typeof settings.locale === 'object' ? settings.locale : {})
      : (settings.pluginSettings[pluginId][ns] && typeof settings.pluginSettings[pluginId][ns] === 'object'
        ? settings.pluginSettings[pluginId][ns]
        : {})
    return bag
  }
  const write = (settings: Record<string, any>, ns: string, value: Record<string, any>) => {
    if (ns === 'locale') settings.locale = value
    else settings.pluginSettings[pluginId][ns] = value
    writeCompanySettings(db, companyId, settings)
    emit('settings/updated', ns)
    emit('settings/document-updated', ns)
  }
  return {
    get(ns: string) {
      return { ...namespace(root(), String(ns)) }
    },
    describe() {
      const settings = root()
      const rows: Array<Record<string, any>> = []
      const locale = namespace(settings, 'locale')
      if (Object.keys(locale).length > 0) rows.push({ ns: 'locale', ...locale })
      for (const [ns, value] of Object.entries(settings.pluginSettings[pluginId] ?? {})) {
        if (ns === 'locale' || !value || typeof value !== 'object') continue
        rows.push({ ns, ...(value as Record<string, any>) })
      }
      return rows
    },
    set(ns: string, value: Record<string, any>) {
      const settings = root()
      write(settings, String(ns), { ...(value ?? {}) })
    },
    update(ns: string, patch: Record<string, any>) {
      const settings = root()
      const current = namespace(settings, String(ns))
      write(settings, String(ns), { ...current, ...(patch ?? {}) })
    },
    all() {
      return root().pluginSettings[pluginId] ?? {}
    },
  }
}

function makeSessionsService(db: Db, companyId: string, workspacePath: string) {
  const rows = () => db
    .prepare(
      `SELECT id, user_id, title, created_at, updated_at
         FROM chat_sessions
        WHERE company_id = ? AND deleted_at IS NULL
        ORDER BY updated_at DESC
        LIMIT 500`,
    )
    .all(companyId) as unknown as Array<{
    id: string
    user_id: string
    title: string
    created_at: number
    updated_at: number
  }>
  const toSession = (row: {
    id: string
    user_id: string
    title: string
    created_at: number
    updated_at: number
  }) => ({
    id: row.id,
    sessionId: row.id,
    user_id: row.user_id,
    header: {
      id: row.id,
      title: row.title,
      cwd: workspacePath,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    events: [] as unknown[],
    snapshotEvents: () => [] as unknown[],
    append: () => undefined,
  })
  const byId = new Map<string, ReturnType<typeof toSession>>()
  const load = (id: string) => {
    const cached = byId.get(id)
    if (cached) return cached
    const row = rows().find((item) => item.id === id)
    if (!row) return undefined
    const session = toSession(row)
    byId.set(id, session)
    return session
  }
  return {
    list: () => rows().map((row) => load(row.id)!).filter(Boolean),
    get: (id: string) => load(String(id)),
  }
}

function makeControllerServices(
  sessions: ReturnType<typeof makeSessionsService>,
  workspacePath: string,
) {
  const workspace = {
    workspaceId: 'eab-im',
    name: 'EAB 工作台',
    path: workspacePath,
  }
  return {
    sessionController: {
      get: (id: string) => sessions.get(id),
      list: () => sessions.list(),
      create: async () => ({ sessionId: randomUUID(), cwd: workspacePath, workspaceId: workspace.workspaceId }),
    },
    workspaceController: {
      get: () => workspace,
      list: () => [workspace],
      create: async () => workspace,
    },
  }
}

function makeWebServer(
  register: (spec: { path?: unknown; methods?: unknown; method?: unknown; fetch?: unknown; handler?: unknown; kind?: unknown }) => () => void,
  instance: HostInstance,
  logger: Record<string, (...args: unknown[]) => void>,
) {
  return {
    register,
    /**
     * DSH webServer 还允许 WebSocket upgrade / fallback / index tap。
     * HTTP 网关目前没有 upgrade 通道，但不能静默吞掉：登记下来并在状态里可见。
     */
    registerUpgrade: (spec: { path?: unknown; handler?: unknown }) => {
      const path = typeof spec?.path === 'string' ? spec.path : ''
      if (!path) return () => undefined
      instance.upgrades.set(path, spec)
      logger.warn(`插件注册 WebSocket upgrade ${path}：EAB HTTP 网关暂不支持 upgrade，已登记`)
      return () => instance.upgrades.delete(path)
    },
    registerFallback: (_spec: unknown) => {
      logger.warn('插件注册 webServer fallback：EAB 暂不支持 fallback 路由')
      return () => undefined
    },
    tapIndex: (_fn: unknown) => {
      logger.warn('插件注册 tapIndex：EAB 暂不支持 index 注入')
      return () => undefined
    },
  }
}

export function makeContext(db: Db, instance: HostInstance, options: DshImOptions | null): Record<string, unknown> {
  const services = new Map<string, unknown>()
  const eventHandlers = new Map<string, Array<(...args: unknown[]) => unknown>>()
  const logger = makeLogger(instance)
  const companyId = instance.companyId || options?.companyId || 'c1'
  const workspacePath = eabWorkspacePath(options)

  // DSH 的 credentials 服务：插件只拿 secretRef，真实密钥仍由 EAB 的 secrets.json 保管
  const credentials = dshImCredentials()
  services.set('credentials', credentials)
  // EAB 的 Typert 网关桥：插件渠道初始化会强校验 ctx.typertGateway.invoke/stream
  const typertGateway = makeTypertGateway(db, options)
  services.set('typertGateway', typertGateway)

  // DSH tools 服务：插件注册的工具会进入 EAB 对话工具发现链，宿主停用/卸载时统一摘除
  const toolsService = {
    register: (nameOrDefinition: unknown, maybeDefinition?: unknown) => {
      const result = registerPluginTool(instance.id, nameOrDefinition, maybeDefinition)
      if (!result.ok) {
        logger.warn(`插件工具注册失败 ${result.name || '(未命名)'}：${result.reason ?? '未知原因'}`)
        return () => undefined
      }
      logger.info(`注册插件工具：${result.name}`)
      return result.dispose
    },
    registerTool: (nameOrDefinition: unknown, maybeDefinition?: unknown) =>
      toolsService.register(nameOrDefinition, maybeDefinition),
    unregister: (name: unknown) => unregisterPluginTool(instance.id, name),
  }
  services.set('tools', toolsService)

  // DSH systemPrompt 服务：插件可以把自己的使用说明挂进 EAB 系统提示
  const systemPromptService = {
    context: (entry: unknown) => registerPluginPrompt(instance.id, entry),
    add: (entry: unknown) => registerPluginPrompt(instance.id, entry),
    register: (entry: unknown) => registerPluginPrompt(instance.id, entry),
    section: (entry: unknown) => registerPluginPrompt(instance.id, entry),
  }
  services.set('systemPrompt', systemPromptService)

  /** DSH 的事件总线由 Cordis 提供；这里只保留 settings 需要的最小 emit 兼容。 */
  const emit = (event: unknown, ...args: unknown[]): void => {
    const list = eventHandlers.get(String(event || '')) ?? []
    for (const handler of list) {
      try {
        handler(...args)
      } catch (error) {
        logger.warn(`事件 ${String(event)} 处理失败：${(error as Error)?.message ?? error}`)
      }
    }
  }

  // DSH sessions/settings/controllers：dsh-im 的标题前缀、语言设置和 channel
  // 初始化会分别注入这些服务。即使 EAB 没有完整的 DSH Session 事件流，也要提供
  // shape 正确的适配对象，不能让插件因为服务缺失而在启动阶段直接退出。
  const sessionsService = makeSessionsService(db, companyId, workspacePath)
  services.set('sessions', sessionsService)
  const controllerServices = makeControllerServices(sessionsService, workspacePath)
  services.set('sessionController', controllerServices.sessionController)
  services.set('workspaceController', controllerServices.workspaceController)
  const settingsService = makeSettingsService(db, companyId, instance.id, emit)
  services.set('settings', settingsService)
  services.set('speechToText', {
    available: false,
    transcribe: async () => {
      throw new Error('EAB 当前没有接入语音转写服务')
    },
  })

  /**
   * Cordis 的标准服务是插件启动的硬依赖。即使 EAB 暂时没有实现，也必须给
   * 形状正确的对象，并显式标记 available=false；不能再塞 undefined，否则
   * inject 会把「键存在但值是 undefined」当成就绪，插件一用就崩。
   */
  const agentService = {
    available: false,
    list: () => [],
    roots: () => [],
    get: () => undefined,
    isOwnedBy: () => false,
    create: async () => {
      throw new Error('EAB 尚未把 DSH agents.create 接入会话运行时')
    },
    resume: async () => {
      throw new Error('EAB 尚未把 DSH agents.resume 接入会话运行时')
    },
  }
  services.set('agents', agentService)
  const pluginManagerService = {
    available: false,
    list: () => [],
    get: () => undefined,
    enable: async () => undefined,
    disable: async () => undefined,
    reload: async () => undefined,
  }
  services.set('pluginManager', pluginManagerService)

  // DSH 命令服务：先实现注册/列表/查找，执行明确返回未接执行面的 failure。
  const commandMap = new Map<string, any>()
  const commands = {
    register: (definition: any) => {
      const name = String(definition?.name ?? definition?.id ?? '').trim()
      if (!name) {
        logger.warn('插件注册命令失败：缺少 name')
        return () => undefined
      }
      commandMap.set(name, definition)
      logger.info(`注册插件命令：${name}`)
      return () => {
        if (commandMap.get(name) === definition) commandMap.delete(name)
      }
    },
    list: () => [...commandMap.values()],
    find: (_agent: unknown, name: string) => commandMap.get(String(name)),
    execute: async () => ({
      ok: false,
      error: { code: 'commands-unavailable', message: 'EAB 尚未把 DSH commands.execute 接入对话链路' },
    }),
  }
  services.set('commands', commands)

  // DSH LLM 服务：adapter 先登记，registration.replace 必须真实可用；
  // 真正接入 EAB 模型路由放到 P1，当前至少让插件完成初始化。
  const llmAdapters = new Map<string, unknown>()
  const llmDiscoveries = new Map<string, (...args: unknown[]) => unknown>()
  const configurableProviders: any[] = []
  const llm = {
    listProviders: () => {
      // 这里返回 EAB 自己的 provider 列表，再合并插件通过 adapter 暴露的通道；
      // 插件看到的「provider」和 DSH 一样，应当包括自己注入的通道。
      const rows = collectProviderRows(db)
      const pluginChannels = listPluginChannels(instance.companyId)
      return [
        ...rows.map((row) => ({ id: row.id, name: row.name, kind: row.kind })),
        ...pluginChannels.map((channel) => ({
          id: channel.id,
          name: channel.name,
          kind: 'plugin',
          pluginId: channel.pluginId,
          route: channel.route,
        })),
      ]
    },
    listModels: async (providerId: string) => {
      if (String(providerId).startsWith('plugin:')) {
        const models = listAllPluginModels(instance.companyId)
          .filter((model) => model.channelId === String(providerId))
          .map((model) => ({ id: model.modelKey, name: model.name, contextWindow: model.maxContext, maxTokens: model.maxOutputTokens }))
        instance.llmModels += models.length
        return models
      }
      const rows = collectModelRows(db, String(providerId))
      instance.llmModels += rows.length
      return rows
    },
    registerAdapter: (ids: unknown, adapter: unknown) => {
      const normalize = (value: unknown): string[] =>
        (Array.isArray(value) ? value : [value]).map(String).filter(Boolean)
      const apply = (next: string[]) => {
        for (const [key, value] of llmAdapters) if (value === adapter) llmAdapters.delete(key)
        for (const key of next) llmAdapters.set(key, adapter)
        instance.llmProviders = llmAdapters.size
        logger.info(`插件注册模型 adapter：${next.join('/') || '(空)'}`)
      }
      const registration = registerPluginAdapter(instance.companyId, instance.id, ids, adapter)
      apply(normalize(ids))
      return {
        replace: (next: unknown) => {
          registration.replace(next)
          apply(normalize(next))
        },
        dispose: () => {
          registration.dispose()
          for (const [key, value] of llmAdapters) if (value === adapter) llmAdapters.delete(key)
          instance.llmProviders = llmAdapters.size
        },
      }
    },
    registerConfigurableProviders: (list: unknown) => {
      if (Array.isArray(list)) configurableProviders.push(...list)
      const disposeRegistry = registerPluginConfigurableProviders(instance.companyId, instance.id, list)
      logger.info(`插件注册可配置 provider：${Array.isArray(list) ? list.length : 0}`)
      return () => {
        disposeRegistry()
        if (Array.isArray(list)) {
          for (const item of list) {
            const index = configurableProviders.indexOf(item)
            if (index >= 0) configurableProviders.splice(index, 1)
          }
        }
      }
    },
    registerModelDiscovery: (id: string, discover: (...args: unknown[]) => unknown) => {
      llmDiscoveries.set(String(id), discover)
      const disposeRegistry = registerPluginModelDiscovery(instance.companyId, instance.id, String(id), discover)
      logger.info(`插件注册模型探测：${String(id)}`)
      return () => {
        disposeRegistry()
        llmDiscoveries.delete(String(id))
      }
    },
    _adapters: llmAdapters,
    _discoveries: llmDiscoveries,
    _configurableProviders: configurableProviders,
  }
  services.set('llm', llm)

  // 可选上下文：插件用 ctx.get('profileContext') / ctx.get('attachments') 探测
  services.set('profileContext', {
    available: true,
    companyId,
    get: () => ({ companyId, userId: null, locale: 'zh-CN' }),
    current: () => ({ companyId, userId: null, locale: 'zh-CN' }),
  })
  services.set('attachments', {
    available: false,
    list: async () => [],
    read: async () => null,
    upload: async () => {
      throw new Error('EAB 尚未把 DSH attachments 接入文件服务')
    },
  })
  services.set('approval', {
    available: false,
    request: async () => ({ ok: false, code: 'approval-unavailable', message: 'EAB 尚未接入审批服务' }),
  })
  services.set('userQuestions', {
    available: false,
    ask: async () => ({ ok: false, code: 'user-questions-unavailable', message: 'EAB 尚未接入交互提问' }),
  })

  const register = (spec: {
    path?: unknown
    methods?: unknown
    method?: unknown
    fetch?: unknown
    handler?: unknown
    kind?: unknown
  }): (() => void) => {
    const path = typeof spec?.path === 'string' ? spec.path.trim() : ''
    if (!path || !path.startsWith('/api/') || path.includes('..') || isReserved(path)) {
      logger.warn(`拒绝注册路由 ${path || '(空)'}：只允许 /api/ 下且不能占用 EAB 自有接口`)
      return () => undefined
    }
    const methodList = Array.isArray(spec.methods)
      ? spec.methods
      : (typeof spec.method === 'string' ? [spec.method] : ['GET', 'POST'])
    const allowed = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
    const methods = methodList
      .map((item) => String(item).toUpperCase())
      .filter((item) => allowed.has(item))
    const kind = spec.kind === 'prefix' ? 'prefix' : 'exact'
    const fetchHandler = spec.fetch
    const nodeHandler = spec.handler
    if (typeof fetchHandler !== 'function' && typeof nodeHandler !== 'function') {
      logger.warn(`拒绝注册路由 ${path}：fetch/handler 都不是函数`)
      return () => undefined
    }
    const route: PluginHostRoute = {
      path,
      kind,
      methods: methods.length ? methods : ['GET', 'POST'],
      fetch: typeof fetchHandler === 'function'
        ? async (request: Request) => (fetchHandler as (request: Request) => Promise<Response>)(request)
        : adaptNodeHandler(nodeHandler as (request: any, response: any) => unknown),
    }
    instance.routes.set(path, route)
    logger.info(`DSH 路由已挂载：${route.kind} ${route.methods.join('/')} ${path}`)
    return () => {
      instance.routes.delete(path)
    }
  }

  const connection = {
    fetch: { register },
    // EAB 的插件 HTTP 只从控制台 / 个人接口网关暴露，网关已做会话与插件启用校验；
    // 这里返回“放行”给那些把 connection.admit 当作请求准入判断的 DSH 插件。
    // 不实现 admit 会让它们把 undefined 当异常，整页报 admission unavailable。
    admit: () => undefined,
  }
  // DSH 插件的 `ctx.inject(['connection'], cb)` 依赖服务表判断就绪；只把 connection
  // 挂在 context 上而不登记到 services，会让 dsh-ding-card 永远等不到回调，
  // 结果它的 `/api/dsh-ding-card` 管理路由不会注册。
  services.set('connection', connection)
  // DSH 的 webServer 与 connection.fetch 共用同一张路由表：
  // dsh-im 的 delivery-http 用 webServer.register({kind,path,handler})。
  const webServer = makeWebServer(register, instance, logger)
  services.set('webServer', webServer)

  /**
   * 真正的插件容器：Cordis Context。
   *
   * 之前这里手写 services Map + inject 队列，插件每碰一个新服务就要补一次。
   * 现在 EAB 只负责 provide 服务，插件用 ctx.plugin() 启动，Cordis 负责
   * inject 等待、provide、effect、fiber 和事件模式。
   */
  const root = new Context()
  instance.root = root

  // 把插件日志收进 host status，控制台插件页能看到真实启动错误。
  const logDispose = root.logger.exporter({
    export(message) {
      const args = (message.args ?? []).map(formatLogArg).join(' ')
      instance.logs.push(`[${new Date(message.ts).toISOString()}] ${message.type} ${message.name}: ${args}`)
      if (instance.logs.length > 200) instance.logs.splice(0, instance.logs.length - 200)
    },
  })
  instance.disposers.push(logDispose as () => void | Promise<void>)

  for (const [name, value] of services) {
    if (value === undefined) continue
    const dispose = root.provide(name, value)
    instance.disposers.push(dispose)
  }

  const interval = (fn: (...args: unknown[]) => unknown, ms: number, ...args: unknown[]): (() => void) => {
    if (typeof fn !== 'function') return () => undefined
    const timer = setInterval(() => fn(...args), Math.max(1, Number(ms) || 1))
    const dispose = root.effect(() => () => clearInterval(timer))
    instance.disposers.push(dispose as () => void)
    return dispose as unknown as () => void
  }
  const timeout = (fn: (...args: unknown[]) => unknown, ms: number, ...args: unknown[]): (() => void) => {
    if (typeof fn !== 'function') return () => undefined
    const timer = setTimeout(() => fn(...args), Math.max(0, Number(ms) || 0))
    const dispose = root.effect(() => () => clearTimeout(timer))
    instance.disposers.push(dispose as () => void)
    return dispose as unknown as () => void
  }

  const hostContext = root.extend({
    interval,
    timeout,
    sleep: (ms: number) => new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.max(0, Number(ms) || 0))
      root.effect(() => () => clearTimeout(timer))
    }),
  })

  return hostContext as unknown as Record<string, unknown>
}

async function startOne(
  db: Db,
  record: PluginRecord,
  options: DshImOptions | null,
  companyId: string,
): Promise<void> {
  const entry = record.dsh?.hostEntry
  if (!entry) return
  const instance: HostInstance = {
    id: record.id,
    companyId,
    record,
    routes: new Map(),
    upgrades: new Map(),
    logs: [],
    disposers: [],
    root: null,
    fiber: null,
    startedAt: Date.now(),
    error: null,
    llmProviders: 0,
    llmModels: 0,
  }
  instances.set(hostKey(companyId, record.id), instance)
  const full = join(record.dir, entry)
  if (!existsSync(full)) {
    instance.error = `host 入口不存在：${entry}`
    makeLogger(instance).warn(instance.error)
    return
  }
  try {
    // 带 mtime 的 query：更新插件后重新 import 拿到新模块，而不是命中旧的模块缓存
    const url = `${pathToFileURL(full).href}?v=${statSync(full).mtimeMs}`
    const mod = (await import(url)) as Record<string, unknown>
    const plugin = normalizePluginModule(mod)
    if (!plugin) {
      instance.error = 'host 入口不是 DSH/Cordis 插件（需要 apply、default 或类插件）'
      return
    }
    const ctx = makeContext(db, instance, options) as unknown as Context
    const wrapped = withHostEntry(plugin, record)
    const fiber = ctx.plugin(wrapped as any, {})
    instance.fiber = fiber

    // 不要直接 await fiber：依赖尚未就绪时 Cordis 会保持 PENDING，
    // await 会一直挂着，宿主启动流程就卡死了。这里只等一个短窗口，
    // 然后按 Fiber.state 把 active / pending / failed 写进状态。
    const outcome = await Promise.race([
      Promise.resolve(fiber).then(() => 'settled' as const),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 1_200)),
    ])
    if (fiber.state === 3) {
      instance.error = (fiber as unknown as { error?: Error }).error?.message ?? '插件 host 启动失败'
      makeLogger(instance).error(`插件 host 启动失败：${instance.error}`)
      return
    }
    if (outcome === 'pending' || fiber.state === 0) {
      const pending = Object.keys(fiber.inject ?? {})
      makeLogger(instance).warn(`插件 host 仍在等待服务：${pending.join(',') || '(未知)'}`)
    } else {
      makeLogger(instance).info(`插件 host 已启动，注册路由 ${instance.routes.size} 条`)
    }
  } catch (error) {
    instance.error = (error as Error)?.message ?? String(error)
    clearPluginContributions(instance.id)
    makeLogger(instance).error(`插件 host 启动失败：${instance.error}`)
  }
}

type NormalizedPlugin =
  | ((ctx: Context, config: any) => unknown)
  | { apply: (ctx: Context, config: any) => unknown; [key: string]: unknown }
  | (new (ctx: Context, config: any) => unknown)

/**
 * DSH 插件入口有三种形态：函数、{ apply }、class，模块还可能导出
 * inject / Config / name。这里统一成 Cordis 能识别的 plugin，而不是只认 apply。
 */
function normalizePluginModule(mod: Record<string, unknown>): NormalizedPlugin | null {
  const candidate = (mod.default ?? mod) as any
  if (candidate && typeof candidate === 'object' && typeof candidate.apply === 'function') {
    return {
      ...candidate,
      inject: candidate.inject ?? mod.inject,
      Config: candidate.Config ?? mod.Config,
      name: candidate.name ?? mod.name,
    }
  }
  if (typeof candidate === 'function') {
    if (!(candidate as any).inject && mod.inject) (candidate as any).inject = mod.inject
    if (!(candidate as any).Config && mod.Config) (candidate as any).Config = mod.Config
    return candidate
  }
  return null
}

/** 把 DSH loader 的 entry.options.id 补到 fiber 上，插件设置命名空间会用到。 */
function withHostEntry(plugin: NormalizedPlugin, record: PluginRecord): NormalizedPlugin {
  const hostEntry = { options: { id: record.id, name: record.name ?? record.id } }
  const attach = (ctx: Context): void => {
    try {
      ;(ctx.fiber as unknown as { entry?: unknown }).entry = hostEntry
    } catch {
      // Fiber 是宿主对象，个别版本可能不可写；插件会 fallback 到 name。
    }
  }
  if (typeof plugin === 'function') {
    if (/^\s*class\s/.test(plugin.toString())) {
      // Cordis 用 new 调类插件；包一层普通函数，才能在任何入口形态上都把
      // loader entry 挂到 fiber 上，settings 命名空间不会退回成 name。
      const Ctor = plugin as new (ctx: Context, config: any) => unknown
      const wrapped = (ctx: Context, config: any) => {
        attach(ctx)
        return new Ctor(ctx, config)
      }
      Object.assign(wrapped, plugin)
      return wrapped
    }
    const callable = plugin as (ctx: Context, config: any) => unknown
    const wrapped = (ctx: Context, config: any) => {
      attach(ctx)
      return callable(ctx, config)
    }
    Object.assign(wrapped, plugin)
    return wrapped
  }
  return {
    ...plugin,
    apply: (ctx: Context, config: any) => {
      attach(ctx)
      return plugin.apply(ctx, config)
    },
  }
}

function disposeAll(): void {
  for (const instance of instances.values()) {
    // 先同步摘掉模型，避免 root fiber 异步 dispose 期间列表仍读到已停用插件的模型。
    pluginActiveCache.delete(instance.companyId)
    removePluginModelsForPlugin(instance.companyId, instance.id)
    void instance.root?.fiber?.dispose?.()
    for (const dispose of instance.disposers.reverse()) {
      try {
        const result = dispose()
        if (result && typeof (result as Promise<void>).catch === 'function') {
          ;(result as Promise<void>).catch(() => undefined)
        }
      } catch {
        // 插件清理失败不阻塞宿主重启
      }
    }
    clearPluginContributions(instance.id)
    instance.routes.clear()
    instance.upgrades.clear()
  }
  instances.clear()
}

/** 启动/重扫 DSH 插件 host：每个真正启用的公司各跑一个独立 Context */
export async function reloadPluginHosts(db: Db, options?: DshImOptions): Promise<void> {
  loadedDb = db
  if (options) loadedOptions = options
  // 先准备 dsh-im 兼容文件树：DSH_HOME 必须在 import 插件之前指到隔离副本
  if (loadedOptions) prepareDshImCompat(db, loadedOptions)
  disposeAll()
  for (const item of listPluginDirectories()) {
    const record = readPluginDirectory(item.id)
    if (!record || !record.valid || record.format !== 'dsh' || !record.dsh?.hasHost) continue
    for (const companyId of enabledCompanyIds(db, record.id)) {
      await startOne(db, record, loadedOptions, companyId)
    }
  }
}

export function stopPluginHosts(): void {
  disposeAll()
}

/** 安装/启停/卸载后调用：没有初始化过就初始化，已初始化就重扫 */
export async function refreshPluginHosts(db: Db, options?: DshImOptions): Promise<void> {
  if (!loadedDb) {
    await reloadPluginHosts(db, options)
    return
  }
  await reloadPluginHosts(db, options)
}

export function pluginHostStatus(id: string, companyId = 'c1'): PluginHostStatus | null {
  const instance = getHostInstance(id, companyId)
  if (!instance) return null
  const stateCode = instance.fiber?.state
  const state: PluginHostStatus['state'] =
    stateCode === 2 ? 'active'
      : stateCode === 3 ? 'failed'
        : stateCode === 4 ? 'disposed'
          : 'pending'
  const pendingServices = instance.fiber
    ? Object.keys(instance.fiber.inject ?? {}).filter((name) => !instance.root?.get(name, true))
    : []
  return {
    id,
    companyId: instance.companyId,
    loaded: !instance.error && state !== 'failed',
    state,
    pendingServices,
    hostEntry: instance.record.dsh?.hostEntry ?? null,
    startedAt: instance.startedAt,
    error: instance.error,
    routes: [...instance.routes.keys()],
    logs: [...instance.logs].slice(-40),
    llmProviders: instance.llmProviders,
    llmModels: instance.llmModels,
  }
}

export function listPluginHostStatuses(ids: readonly string[], companyId = 'c1'): PluginHostStatus[] {
  return ids.flatMap((id) => {
    const status = pluginHostStatus(id, companyId)
    return status ? [status] : []
  })
}

/**
 * 把 DSH client 发来的调用转给插件 host 注册的 fetch 通道。
 * `channel` 对应 DSH 的 `connection.rpc.call(base, channel, call)` 第二个参数。
 */
export async function dispatchPluginWeb(
  id: string,
  targetPath: string,
  init: { method: string; headers?: Record<string, string>; body?: string; query?: string },
  companyId = 'c1',
): Promise<Response> {
  const instance = getHostInstance(id, companyId)
  if (!instance) return new Response('plugin host not running', { status: 404 })
  if (instance.error) return new Response(instance.error, { status: 503 })
  const path = targetPath.startsWith('/') ? targetPath : `/${targetPath}`
  const method = init.method.toUpperCase()
  const routes = [...instance.routes.values()]
    .filter((item) => (item.kind === 'exact' ? item.path === path : path === item.path || path.startsWith(`${item.path}/`)))
    .sort((a, b) => b.path.length - a.path.length)
  const route = routes.find((item) => item.methods.includes(method))
  if (!route) {
    const available = [...instance.routes.keys()].join(',')
    instance.logs.push(`[${new Date().toISOString()}] warn gateway 未命中 ${method} ${path}；已注册 ${available}`)
    return new Response(`plugin route not found: ${method} ${path}`, { status: 404 })
  }
  const headers = new Headers(init.headers ?? {})
  if (!headers.has('content-type')) headers.set('content-type', 'application/json')
  const request = new Request(`http://eab-plugin.local${path}${init.query ?? ''}`, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : (init.body ?? ''),
  })
  return route.fetch(request)
}

export async function dispatchPluginRpc(
  id: string,
  channel: string,
  call: unknown,
  companyId = 'c1',
): Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }> {
  const instance = getHostInstance(id, companyId)
  if (!instance) {
    return { ok: false, error: { code: 'host-not-running', message: `插件 ${id} 的 host 没有运行（未安装、未启用或没有 host 入口）` } }
  }
  if (instance.error) {
    return { ok: false, error: { code: 'host-error', message: instance.error } }
  }
  const route =
    instance.routes.get(`/api/${channel}`) ??
    [...instance.routes.values()].find((item) => item.path.endsWith(`/${channel}`))
  if (!route) {
    return { ok: false, error: { code: 'channel-not-found', message: `插件 ${id} 没有注册通道 /api/${channel}` } }
  }
  if (!route.methods.includes('POST')) {
    return { ok: false, error: { code: 'bad-method', message: `通道 /api/${channel} 不接受 POST` } }
  }
  const rpcId = `eab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  // DSH 插件用 `message.method` 校验它注册的 RPC 端点（例如 dsh-im/dingtalk），
  // 不是通道短名 `dingtalk`；从真实路由反推，避免插件把桥接请求判成 bad-request。
  const rpcMethod = route.path.replace(/^\/api\//, '')
  const body = JSON.stringify({
    type: 'client-request',
    rpcId,
    method: rpcMethod,
    payload: call,
  })
  try {
    const request = new Request(`http://eab-plugin.local${route.path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    const response = await route.fetch(request)
    if (!response.ok) {
      const text = await response.text()
      return { ok: false, error: { code: `http-${response.status}`, message: text.slice(0, 300) } }
    }
    const payload = (await response.json()) as {
      type?: string
      rpcId?: string
      result?: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } }
    }
    const result = payload?.result
    if (!result || typeof result.ok !== 'boolean') {
      return { ok: false, error: { code: 'bad-response', message: '插件返回的不是 DSH RPC 报文' } }
    }
    if (result.ok) return { ok: true, value: result.value }
    return {
      ok: false,
      error: {
        code: result.error?.code ?? 'operation-failed',
        message: result.error?.message ?? '操作失败',
      },
    }
  } catch (error) {
    const message = (error as Error)?.message ?? String(error)
    instance.logs.push(`[${new Date().toISOString()}] error rpc ${channel}: ${message}`)
    return { ok: false, error: { code: 'rpc-failed', message } }
  }
}
