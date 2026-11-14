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
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Readable, Writable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import type { Db } from '@eab/storage'
import { listPluginDirectories, loadPlugins, readPluginDirectory, type PluginRecord } from './plugins.js'
import { dshCompatRoot, dshImCredentials, prepareDshImCompat, type DshImOptions } from './dsh-im-compat.js'
import { clearPluginContributions, registerPluginPrompt, registerPluginTool, unregisterPluginTool } from './plugin-tools.js'
import {
  companyScope,
  listEnabledPluginInstances,
  pluginDataRoot,
  pluginInstanceKey,
  pluginScopeKey,
  pluginSettingsNamespace,
  type PluginScope,
} from './plugin-scope.js'
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

/** Host 明确没有实现的 DSH 能力；调用时记录，状态里可见。 */
export interface PluginHostGap {
  readonly code: string
  readonly message: string
  readonly at: number
}

export interface PluginHostStatus {
  readonly id: string
  readonly companyId: string
  /** 实例归属：公司级或某个成员的个人实例 */
  readonly scope: 'company' | 'user'
  readonly userId: string | null
  /** 该实例独占的 DSH_HOME */
  readonly dataRoot: string
  readonly loaded: boolean
  readonly state: 'pending' | 'active' | 'failed' | 'disposed'
  readonly pendingServices: readonly string[]
  readonly hostEntry: string | null
  readonly startedAt: number | null
  readonly error: string | null
  readonly routes: readonly string[]
  /** 路由的形状（exact / prefix）与允许的方法，client 侧据此决定哪些同源请求要走网关 */
  readonly routeSpecs: ReadonlyArray<{ path: string; kind: 'exact' | 'prefix'; methods: readonly string[] }>
  /** 插件主动使用了 EAB 尚未实现的 host 能力（upgrade/fallback/tapIndex/agents 等） */
  readonly hostGaps: readonly PluginHostGap[]
  readonly logs: readonly string[]
  readonly llmProviders: number
  readonly llmModels: number
}

export interface HostInstance {
  readonly instanceKey: string
  readonly id: string
  readonly companyId: string
  readonly scope: PluginScope
  /** 实例自己的数据根（DSH_HOME）；同名插件的公司/个人实例从这里开始分叉。 */
  readonly dataRoot: string
  readonly settingsNamespace: string
  readonly record: PluginRecord
  readonly routes: Map<string, PluginHostRoute>
  readonly upgrades: Map<string, unknown>
  readonly logs: string[]
  /** 插件使用但 EAB 尚未实现的 host 能力；用于状态和插件页诊断。 */
  readonly hostGaps: PluginHostGap[]
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

/**
 * 除 EAB 自有 API 外，EAB 自己的页面和静态资源也不能被插件抢走。
 * DSH 插件可以注册任意绝对路径（例如 dsh-cy-api 的 `/dsh-cy-api/api`），
 * 这里只保护真正的宿主入口，其余路径全部交给插件命名空间。
 */
const RESERVED_HOST_PATHS = [
  '/',
  '/index.html',
  '/admin',
  '/admin-gate.html',
  '/chat',
  '/chat.html',
  '/plugin-host.html',
  '/plugin-kernel.html',
  '/plugin-kernel-lab.html',
  '/app.js',
  '/app.css',
  '/chat.js',
  '/chat.css',
  '/dsh-runtime.js',
  '/vendor',
  '/plugins',
  '/favicon.ico',
]

const instances = new Map<string, HostInstance>()
let loadedDb: Db | null = null
let loadedOptions: DshImOptions | null = null

// 模型查询时按真实安装/启停状态兜底过滤；host 尚未初始化时一律不可见。
setPluginModelActiveResolver((companyId, pluginId) =>
  loadedDb ? pluginEnabledForModels(loadedDb, companyId, pluginId) : false,
)

function getHostInstance(
  pluginId: string,
  companyId = 'c1',
  scope: PluginScope = companyScope(),
): HostInstance | undefined {
  // 必须严格按公司 + 实例范围隔离：同名插件的公司实例和个人实例互不复用。
  return instances.get(pluginInstanceKey(companyId, pluginId, scope))
}

function isReserved(path: string): boolean {
  const api = RESERVED_API_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
  if (api) return true
  return RESERVED_HOST_PATHS.some((prefix) =>
    prefix === '/' ? path === '/' : path === prefix || path.startsWith(`${prefix}/`),
  )
}

/** 哪些公司/成员真正启用了这个插件；host 必须按实例隔离，不能只启动最后一家。 */
function enabledInstancesOf(db: Db, pluginId: string): Array<{ companyId: string; scope: PluginScope }> {
  return listEnabledPluginInstances(db)
    .filter((row) => row.pluginId === pluginId)
    .map((row) => ({ companyId: row.companyId, scope: row.scope }))
}

/**
 * 模型目录用的插件有效性判断：插件目录仍在磁盘、清单有效、安装未卸载且未被停用。
 * 卸载会直接删除插件目录（不再进回收站），仅看 plugin_company_installs 会把“已卸载但数据库残留”的
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
    // 个人-only 插件不会出现在公司级 loadPlugins 结果里；这里单独补读目录，
    // 避免个人安装的模型/工具插件被误判为“不活跃”。
    // 同名插件公司级停用时，loadPlugins 里的 enabled 会是 false；
    // 个人安装自己的 enabled 已在 SQL 中过滤，这里不能再用公司级 enabled 覆盖。
    const plugin = byId.get(row.plugin_id) ?? readPluginDirectory(row.plugin_id)
    if (plugin?.valid) ids.add(plugin.id)
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

export type DshSessionEvent = {
  seq: number
  time: number
  type: string
  data: Record<string, any>
}

type ChatMessageRow = {
  id: string
  role: string
  text: string
  meta_json: string | null
  model_id: string | null
  model_name: string | null
  created_at: number
}

function parseMessageMeta(raw: string | null): Record<string, any> {
  if (!raw) return {}
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' ? value as Record<string, any> : {}
  } catch {
    return {}
  }
}

/** 只用于展示/统计的粗略 token 估算；EAB 没有逐消息的稳定 token 账本。 */
function estimateTokens(text: string): number {
  const value = String(text || '')
  if (!value) return 0
  return Math.max(1, Math.ceil(value.length / 2))
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part && typeof part === 'object') {
        const item = part as Record<string, unknown>
        if (typeof item.text === 'string') return item.text
        if (typeof item.content === 'string') return item.content
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function messageEvents(row: ChatMessageRow): DshSessionEvent[] {
  const meta = parseMessageMeta(row.meta_json)
  const text = String(row.text || '')
  if (row.role === 'user') {
    return [{
      seq: 0,
      time: Number(row.created_at) || Date.now(),
      type: 'user/message',
      data: {
        message: {
          role: 'user',
          content: [{ type: 'text', text }],
        },
      },
    }]
  }
  if (row.role !== 'assistant') return []

  const tokens = meta.tokens && typeof meta.tokens === 'object' ? meta.tokens : {}
  const reasoning = typeof meta.reasoning === 'string' ? meta.reasoning : ''
  const content: Array<Record<string, any>> = []
  if (reasoning) content.push({ type: 'reasoning', text: reasoning })
  if (text) content.push({ type: 'text', text })
  if (content.length === 0) content.push({ type: 'text', text: '' })

  const rawTiming = meta.timing && typeof meta.timing === 'object' ? meta.timing : {}
  const timing = {
    ttftMs: Math.max(0, Number(rawTiming.ttftMs) || 0),
    genMs: Math.max(0, Number(rawTiming.genMs) || 0),
    wallMs: Math.max(0, Number(rawTiming.wallMs) || 0),
  }
  const hasTiming = timing.ttftMs > 0 || timing.genMs > 0 || timing.wallMs > 0

  const events: DshSessionEvent[] = [{
    seq: 0,
    time: Number(row.created_at) || Date.now(),
    type: 'assistant/message',
    data: {
      message: { role: 'assistant', content },
      usage: {
        inputTokens: Number(tokens.prompt) || 0,
        outputTokens: Number(tokens.completion) || estimateTokens(text),
        reasoningTokens: estimateTokens(reasoning),
      },
      model: row.model_id || row.model_name || undefined,
      ...(hasTiming ? { timing } : {}),
    },
  }]

  const toolCalls = Array.isArray(meta.toolCalls) ? meta.toolCalls : []
  for (const raw of toolCalls) {
    if (!raw || typeof raw !== 'object') continue
    const tool = raw as Record<string, any>
    const callId = typeof tool.id === 'string' && tool.id ? tool.id : randomUUID()
    const name = typeof tool.name === 'string' && tool.name ? tool.name : 'tool'
    events.push({
      seq: 0,
      time: Number(row.created_at) || Date.now(),
      type: 'tool/call',
      data: {
        callId,
        name,
        arguments: tool.args && typeof tool.args === 'object' ? tool.args : {},
      },
    })
    const summary = typeof tool.summary === 'string' ? tool.summary.slice(0, 20_000) : ''
    events.push({
      seq: 0,
      time: Number(row.created_at) || Date.now(),
      type: 'tool/result',
      data: {
        content: [{ type: 'text', text: summary || String(tool.status || '') }],
        isError: tool.status !== 'done',
        source: { callId },
        durationMs: Number(tool.durationMs) || 0,
      },
    })
  }
  return events
}

export function chatSessionEvents(
  db: Db,
  companyId: string,
  userId: string | null,
  sessionId: string,
): DshSessionEvent[] {
  const rows = (userId
    ? db
      .prepare(
        `SELECT id, role, text, meta_json, model_id, model_name, created_at
           FROM chat_messages
          WHERE company_id = ? AND session_id = ? AND user_id = ?
          ORDER BY created_at ASC, id ASC
          LIMIT 2000`,
      )
      .all(companyId, sessionId, userId)
    : db
      .prepare(
        `SELECT id, role, text, meta_json, model_id, model_name, created_at
           FROM chat_messages
          WHERE company_id = ? AND session_id = ?
          ORDER BY created_at ASC, id ASC
          LIMIT 2000`,
      )
      .all(companyId, sessionId)) as unknown as ChatMessageRow[]

  const events: DshSessionEvent[] = []
  for (const row of rows) {
    for (const event of messageEvents(row)) events.push(event)
  }
  return events.map((event, index) => ({ ...event, seq: index + 1 }))
}

/**
 * dsh-context 的概览汇总按 contextActivity.days 里的 Token 成本结构累加。
 * EAB 没有模型计价服务，但可以把真实 Token 数写进同一份成本结构字段，
 * 页面“Token 消耗/近 7 天用量”显示真实用量，费用仍由插件按未计价处理。
 */
export function foldContextTiming(events: readonly DshSessionEvent[]): Record<string, any> {
  const starts = new Map<string, { time: number; name: string }>()
  const tools: Record<string, { calls: number; ms: number }> = {}
  let calls = 0
  let toolCalls = 0
  let toolsMs = 0
  let ttftMs = 0
  let genMs = 0
  let turnStart: number | null = null
  let lastActivity = 0
  let wallMs = 0

  const closeTurn = () => {
    if (turnStart !== null && lastActivity >= turnStart) wallMs += lastActivity - turnStart
    turnStart = null
  }

  for (const event of events) {
    const time = Number(event.time)
    if (!Number.isFinite(time) || time < 0) continue
    const data = event.data || {}
    if (event.type === 'user/message') {
      closeTurn()
      turnStart = time
      lastActivity = time
      continue
    }
    if (event.type === 'assistant/message') {
      calls += 1
      const eventTiming = data.timing && typeof data.timing === 'object' ? data.timing : {}
      ttftMs += Math.max(0, Number((eventTiming as any).ttftMs) || 0)
      genMs += Math.max(0, Number((eventTiming as any).genMs) || 0)
      lastActivity = Math.max(lastActivity, time)
      continue
    }
    if (event.type === 'tool/call') {
      const callId = typeof data.callId === 'string' ? data.callId : ''
      const name = typeof data.name === 'string' ? data.name : ''
      if (callId && name) starts.set(callId, { time, name })
      continue
    }
    if (event.type === 'tool/result') {
      const callId = typeof (data.source as any)?.callId === 'string' ? String((data.source as any).callId) : ''
      const call = callId ? starts.get(callId) : undefined
      if (call) {
        const recorded = Number(data.durationMs)
        const ms = Number.isFinite(recorded) && recorded >= 0
          ? recorded
          : Math.max(0, time - call.time)
        toolsMs += ms
        toolCalls += 1
        const tool = tools[call.name] ?? { calls: 0, ms: 0 }
        tool.calls += 1
        tool.ms += ms
        tools[call.name] = tool
        starts.delete(callId)
      }
      lastActivity = Math.max(lastActivity, time)
    }
  }
  closeTurn()
  return {
    wallMs,
    ttftMs,
    genMs,
    calls,
    toolsMs,
    toolBusyMs: toolsMs,
    toolCalls,
    tools,
  }
}

export function foldContextActivity(events: readonly DshSessionEvent[]): Record<string, any> {
  const days: Record<string, any> = {}
  const dayOf = (time: number) => {
    const date = new Date(typeof time === 'number' && Number.isFinite(time) ? time : Date.now())
    return Number.isNaN(date.getTime()) ? 'unknown' : date.toISOString().slice(0, 10)
  }
  const bucket = (time: number) => {
    const key = dayOf(time)
    if (!days[key]) {
      days[key] = {
        tokens: 0,
        requests: 0,
        turns: 0,
        toolCalls: 0,
        cost: { eab: { estimated: { peak: { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
      }
    }
    return days[key]
  }
  for (const event of events) {
    const data = event.data || {}
    if (event.type === 'user/message') {
      const text = contentText((data.message as any)?.content)
      const tokens = estimateTokens(text)
      const day = bucket(event.time)
      day.tokens += tokens
      day.turns += 1
      day.cost.eab.estimated.peak.uncached += tokens
      continue
    }
    if (event.type === 'assistant/message') {
      const text = contentText((data.message as any)?.content)
      const usage = data.usage && typeof data.usage === 'object' ? data.usage : {}
      const input = Number(usage.inputTokens) || 0
      const output = Number(usage.outputTokens) || estimateTokens(text)
      const day = bucket(event.time)
      day.tokens += input + output
      day.requests += 1
      day.cost.eab.estimated.peak.uncached += input
      day.cost.eab.estimated.peak.output += output
      continue
    }
    if (event.type === 'tool/result') {
      const tokens = estimateTokens(contentText(data.content))
      const day = bucket(event.time)
      day.tokens += tokens
      day.toolCalls += 1
      day.cost.eab.estimated.peak.output += tokens
    }
  }
  // 概览顶部 KPI 的“工具执行 / 活跃时长”读取 contextActivity.days 的
  // toolsMs / wallMs，而不是 contextTimeline.timing；补齐每日桶后再汇总。
  for (const [key, day] of Object.entries(days)) {
    const dayEvents = events.filter((event) => dayOf(event.time) === key)
    const timing = foldContextTiming(dayEvents)
    day.wallMs = timing.wallMs
    day.toolsMs = timing.toolsMs
  }
  return { days }
}

function emptyContextTimeline(): Record<string, any> {
  return {
    surface: [],
    sums: { user: 0, inject: 0, skill: 0, assistant: 0, tool: 0 },
    assistantReasoning: 0,
    assistantAnswerTokens: 0,
    assistantCallTokens: 0,
    systemTokens: 0,
    toolsTokens: 0,
    requests: [],
    turnRuns: 0,
    totals: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0, skills: {} },
    events: [],
    archived: [],
    callNames: {},
    timing: {
      wallMs: 0,
      ttftMs: 0,
      genMs: 0,
      calls: 0,
      toolsMs: 0,
      toolBusyMs: 0,
      toolCalls: 0,
      tools: {},
    },
    fileOps: [],
    commands: [],
    spans: [],
  }
}

/**
 * 把 EAB 的 chat_messages 事件折叠成 dsh-context 的 contextTimeline。
 * 只使用插件投影 schema 的稳定字段；没有事件时返回官方 init() 的空形状。
 */
export function foldContextTimeline(events: readonly DshSessionEvent[]): Record<string, any> {
  const state = emptyContextTimeline()
  const callNames: Record<string, { name: string; start: number; argsRaw?: string }> = {}
  let assistantSteps = 0

  for (const event of events) {
    const data = event.data || {}
    if (event.type === 'user/message') {
      const text = contentText((data.message as any)?.content)
      const tokens = estimateTokens(text)
      state.surface.push({ seq: event.seq, time: event.time, cat: 'user', tokens, text: text.slice(0, 200) })
      state.sums.user += tokens
      state.totals.turns += 1
      state.humanInputs = (state.humanInputs ?? 0) + 1
      state.lastUser = text.slice(0, 200)
      continue
    }
    if (event.type === 'assistant/message') {
      const text = contentText((data.message as any)?.content)
      const usage = data.usage && typeof data.usage === 'object' ? data.usage : {}
      const outputTokens = Number(usage.outputTokens) || estimateTokens(text)
      const inputTokens = Number(usage.inputTokens) || 0
      const reasoningTokens = Number(usage.reasoningTokens) || 0
      const item: Record<string, any> = {
        seq: event.seq,
        time: event.time,
        cat: 'assistant',
        tokens: outputTokens,
      }
      if (reasoningTokens > 0) item.reasoning = reasoningTokens
      if (outputTokens > 0) item.answerTokens = outputTokens
      state.surface.push(item)
      state.sums.assistant += outputTokens
      state.assistantReasoning += reasoningTokens
      state.assistantAnswerTokens += outputTokens
      assistantSteps += 1
      state.requests.push({
        seq: event.seq,
        time: event.time,
        total: inputTokens + outputTokens,
        ...(inputTokens > 0 ? { prompt: inputTokens } : {}),
        ...(outputTokens > 0 ? { output: outputTokens } : {}),
        ...(Number(data.turn) > 0 ? { turn: Number(data.turn) } : {}),
        ...(assistantSteps > 0 ? { step: assistantSteps } : {}),
      })
      state.totals.steps += 1
      state.answers = (state.answers ?? 0) + 1
      continue
    }
    if (event.type === 'tool/call') {
      const callId = typeof data.callId === 'string' ? data.callId : ''
      const name = typeof data.name === 'string' ? data.name : ''
      if (callId && name) {
        callNames[callId] = {
          name,
          start: event.time,
          ...(data.arguments !== undefined ? { argsRaw: JSON.stringify(data.arguments) } : {}),
        }
      }
      continue
    }
    if (event.type === 'tool/result') {
      const callId = typeof (data.source as any)?.callId === 'string' ? String((data.source as any).callId) : ''
      const call = callId ? callNames[callId] : undefined
      const text = contentText(data.content)
      const tokens = estimateTokens(text)
      state.surface.push({
        seq: event.seq,
        time: event.time,
        cat: 'tool',
        tokens,
        ...(call?.name ? { tool: call.name } : {}),
        ...(data.isError === true ? { err: true } : {}),
      })
      state.sums.tool += tokens
      if (call?.name) state.toolTally = { ...(state.toolTally || {}), [call.name]: (state.toolTally?.[call.name] || 0) + 1 }
      delete callNames[callId]
    }
  }

  state.callNames = callNames
  state.turnRuns = state.requests.length
  // dsh-context 的会话列表/汇总优先读 timeline.cost 聚合 Token；
  // EAB 没有计价服务，用同一份真实 Token 数补齐成本结构的四类计数。
  const activity = foldContextActivity(events)
  const cost = { eab: { estimated: { peak: { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 } } } }
  for (const day of Object.values(activity.days || {}) as any[]) {
    const peak = day?.cost?.eab?.estimated?.peak
    if (!peak) continue
    cost.eab.estimated.peak.uncached += Number(peak.uncached) || 0
    cost.eab.estimated.peak.cacheRead += Number(peak.cacheRead) || 0
    cost.eab.estimated.peak.cacheWrite += Number(peak.cacheWrite) || 0
    cost.eab.estimated.peak.output += Number(peak.output) || 0
  }
  state.cost = cost
  state.turns = state.totals.turns
  state.counts = {
    turns: state.totals.turns,
    steps: state.totals.steps,
    injects: state.totals.injects,
    compactions: state.totals.compactions,
    prunes: state.totals.prunes,
    skills: Object.keys(state.totals.skills || {}).length,
  }
  state.timing = foldContextTiming(events)
  const total = state.sums.user + state.sums.assistant + state.sums.tool
  state.current = {
    system: state.systemTokens,
    tools: state.toolsTokens,
    user: state.sums.user,
    inject: state.sums.inject,
    skill: state.sums.skill,
    assistant: state.sums.assistant,
    tool: state.sums.tool,
    total,
  }
  return state
}

function makeSessionsService(
  db: Db,
  companyId: string,
  workspacePath: string,
  userId: string | null = null,
) {
  const rows = () => (userId
    ? db
      .prepare(
        `SELECT id, user_id, title, created_at, updated_at
           FROM chat_sessions
          WHERE company_id = ? AND user_id = ? AND deleted_at IS NULL
          ORDER BY updated_at DESC
          LIMIT 500`,
      )
      .all(companyId, userId)
    : db
      .prepare(
        `SELECT id, user_id, title, created_at, updated_at
           FROM chat_sessions
          WHERE company_id = ? AND deleted_at IS NULL
          ORDER BY updated_at DESC
          LIMIT 500`,
      )
      .all(companyId)) as unknown as Array<{
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
    refresh: async () => rows().map((row) => load(row.id)!).filter(Boolean),
    getSnapshot: () => ({ current: null as string | null }),
    refreshProjections: async () => undefined,
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

function markHostGap(instance: HostInstance, code: string, message: string): void {
  const index = instance.hostGaps.findIndex((gap) => gap.code === code && gap.message === message)
  const gap: PluginHostGap = { code, message, at: Date.now() }
  if (index >= 0) {
    instance.hostGaps[index] = gap
  } else {
    instance.hostGaps.push(gap)
    if (instance.hostGaps.length > 20) instance.hostGaps.splice(0, instance.hostGaps.length - 20)
    instance.logs.push(`[${new Date().toISOString()}] warn host-gap: ${message}`)
  }
  if (instance.hostGaps.length > 20) instance.hostGaps.splice(0, instance.hostGaps.length - 20)
}

/** 明确不可用的服务调用：先记缺口，再抛带 code 的错误，让插件立即失败而不是空转。 */
function unsupportedHostCall(instance: HostInstance, code: string, message: string): never {
  markHostGap(instance, code, message)
  const error = new Error(message) as Error & { code?: string }
  error.code = code
  throw error
}

function makeWebServer(
  register: (spec: { path?: unknown; methods?: unknown; method?: unknown; fetch?: unknown; handler?: unknown; kind?: unknown }) => () => void,
  instance: HostInstance,
  _logger: Record<string, (...args: unknown[]) => void>,
) {
  return {
    available: true,
    /** EAB 的 HTTP 网关只支持普通请求；WebSocket upgrade 尚未接入。 */
    supportsUpgrade: false,
    supportsFallback: false,
    supportsTapIndex: false,
    register,
    /**
     * DSH webServer 还允许 WebSocket upgrade / fallback / index tap。
     * EAB 的 HTTP 网关没有这些通道，不能静默吞掉：登记缺口并在状态里可见，
     * 插件仍然可以启动，但插件页/控制台会显示“能力缺口”。
     */
    registerUpgrade: (spec: { path?: unknown; handler?: unknown }) => {
      const path = typeof spec?.path === 'string' ? spec.path : ''
      if (!path) {
        markHostGap(instance, 'webServer.upgrade', '插件注册 WebSocket upgrade 时缺少 path')
        return () => undefined
      }
      instance.upgrades.set(path, spec)
      markHostGap(
        instance,
        `webServer.upgrade:${path}`,
        `插件注册 WebSocket upgrade ${path}：EAB HTTP 网关暂不支持 upgrade，已登记`,
      )
      return () => instance.upgrades.delete(path)
    },
    registerFallback: (spec: unknown) => {
      const path = typeof (spec as { path?: unknown })?.path === 'string'
        ? (spec as { path: string }).path
        : ''
      markHostGap(
        instance,
        path ? `webServer.fallback:${path}` : 'webServer.fallback',
        path
          ? `插件注册 webServer fallback ${path}：EAB 暂不支持 fallback 路由`
          : '插件注册 webServer fallback：EAB 暂不支持 fallback 路由',
      )
      return () => undefined
    },
    tapIndex: (_fn: unknown) => {
      markHostGap(instance, 'webServer.tapIndex', '插件注册 tapIndex：EAB 暂不支持 index 注入')
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
      const result = registerPluginTool(
        instance.instanceKey,
        instance.companyId,
        instance.id,
        instance.scope,
        nameOrDefinition,
        maybeDefinition,
      )
      if (!result.ok) {
        logger.warn(`插件工具注册失败 ${result.name || '(未命名)'}：${result.reason ?? '未知原因'}`)
        return () => undefined
      }
      logger.info(`注册插件工具：${result.name}`)
      return result.dispose
    },
    registerTool: (nameOrDefinition: unknown, maybeDefinition?: unknown) =>
      toolsService.register(nameOrDefinition, maybeDefinition),
    unregister: (name: unknown) => unregisterPluginTool(instance.instanceKey, name),
  }
  services.set('tools', toolsService)

  // DSH systemPrompt 服务：插件可以把自己的使用说明挂进 EAB 系统提示
  const systemPromptService = {
    context: (entry: unknown) => registerPluginPrompt(instance.instanceKey, entry),
    add: (entry: unknown) => registerPluginPrompt(instance.instanceKey, entry),
    register: (entry: unknown) => registerPluginPrompt(instance.instanceKey, entry),
    section: (entry: unknown) => registerPluginPrompt(instance.instanceKey, entry),
    /**
     * dsh-cy-api 这类插件用 `ctx.systemPrompt.patch = (prev) => prev + 说明`
     * 挂自己的工具约定。EAB 的系统提示不在这里拼装，先把 patch 对空前缀
     * 求值成独立说明，再由 pluginPromptTexts 统一注入；否则赋值会被静默丢失。
     */
    set patch(value: unknown) {
      try {
        const text = typeof value === 'function'
          ? (value as (prev: string) => unknown)('')
          : String(value ?? '')
        if (typeof text === 'string' && text.trim()) {
          registerPluginPrompt(instance.instanceKey, { name: '__system_prompt_patch__', text })
        }
      } catch (error) {
        logger.warn(`插件 systemPrompt.patch 求值失败：${(error as Error)?.message ?? String(error)}`)
      }
    },
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
  const sessionsService = makeSessionsService(
    db,
    companyId,
    workspacePath,
    instance.scope.kind === 'user' ? instance.scope.userId : null,
  )
  services.set('sessions', sessionsService)

  /**
   * DSH 会话查询：dsh-context 的 detail 路由通过 `sessionQuery.observeSession(id)`
   * 读取会话事件并现场折叠。EAB 把 chat_messages 映射成 DSH 事件，
   * 让插件拿到真实事件而不是空上下文。
   */
  const sessionQuery = {
    available: true,
    /** dsh-context 的 overview/heads 路由先枚举会话，再按 id 读事件。 */
    listSessions: async () => sessionsService.list(),
    observeSession: async (id: string) => {
      const session = sessionsService.get(String(id))
      const events = chatSessionEvents(
        db,
        companyId,
        instance.scope.kind === 'user' ? instance.scope.userId : null,
        String(id),
      )
      return {
        id: String(id),
        sessionId: String(id),
        header: session?.header ?? { id: String(id), cwd: workspacePath },
        events,
        snapshotEvents: () => events,
      }
    },
  }
  services.set('sessionQuery', sessionQuery)
  /**
   * DSH sessionPersistence：dsh-context 的 projection backfill 会通过
   * `open(id, 'read')` 读取会话事件，再调用 `sessionProjectionCache.coldSnapshot`
   * 写入投影。EAB 没有 DSH 日志文件，但可以按 id 从 chat_messages 现场读出同一组
   * DSH 事件；没有这个服务时插件注入会直接返回，coverage 永远是 0。
   */
  const sessionPersistence = {
    available: true,
    async stat(id: unknown) {
      const sid = String(id || '')
      const session = sessionsService.get(sid)
      if (!session) return undefined
      const events = chatSessionEvents(
        db,
        companyId,
        instance.scope.kind === 'user' ? instance.scope.userId : null,
        sid,
      )
      return { header: session.header, eventCount: events.length }
    },
    async open(id: unknown) {
      const sid = String(id || '')
      const session = sessionsService.get(sid)
      if (!session) throw new Error(`SessionNotFound: ${sid}`)
      const events = chatSessionEvents(
        db,
        companyId,
        instance.scope.kind === 'user' ? instance.scope.userId : null,
        sid,
      )
      return {
        header: session.header,
        inheritedEventCount: 0,
        async read(from = 0, to?: number) {
          const start = Math.max(0, Number(from) || 0)
          const end = to === undefined ? events.length : Math.min(events.length, Math.max(start, Number(to) || 0))
          return { events: events.slice(start, end) }
        },
        async close() {},
      }
    },
  }
  services.set('sessionPersistence', sessionPersistence)
  /**
   * DSH 的会话投影缓存。dsh-context 的 overview/heads/snapshot 路由要求这个服务
   * 至少有 cachedSnapshot/coldSnapshot；EAB 没有持久投影缓存，直接按需从
   * chat_messages 折叠，避免概览页把会话当成没有 Token 的空会话。
   */
  const projectionCache = new Map<string, unknown>()
  const sessionProjectionCache = {
    available: true,
    /**
     * dsh-context 的 overview 通过 `cachedSnapshot(header, keys)` 取
     * `values.contextTimeline`。EAB 没有投影写缓存，直接把 chat_messages
     * 现场折叠成同一份 contextTimeline，让汇总页读到真实 Token 统计。
     */
    cachedSnapshot: (header: unknown) => {
      const value = header && typeof header === 'object' ? header as Record<string, any> : {}
      const id = String(value.id || value.sessionId || '')
      if (!id || !sessionsService.get(id)) return undefined
      const cacheKey = `${id}:${String(value.updatedAt ?? '')}:${String(value.createdAt ?? '')}`
      const hit = projectionCache.get(cacheKey)
      if (hit) return hit
      const events = chatSessionEvents(
        db,
        companyId,
        instance.scope.kind === 'user' ? instance.scope.userId : null,
        id,
      )
      const activity = foldContextActivity(events)
      const snapshot = { values: { contextTimeline: foldContextTimeline(events), contextActivity: activity } }
      projectionCache.set(cacheKey, snapshot)
      if (projectionCache.size > 50) {
        const oldest = projectionCache.keys().next().value
        if (oldest !== undefined) projectionCache.delete(oldest)
      }
      return snapshot
    },
    coldSnapshot: (header: unknown) => sessionProjectionCache.cachedSnapshot(header),
    write: () => undefined,
    delete: () => undefined,
    stat: async () => ({ size: 0, entries: 0 }),
  }
  services.set('sessionProjectionCache', sessionProjectionCache)
  const controllerServices = makeControllerServices(sessionsService, workspacePath)
  services.set('sessionController', controllerServices.sessionController)
  services.set('workspaceController', controllerServices.workspaceController)
  const settingsService = makeSettingsService(db, companyId, instance.settingsNamespace, emit)
  services.set('settings', settingsService)
  /** DSH 插件用 ctx.dshHomePath 定位自己的配置；同名插件的公司/个人实例拿到不同目录。 */
  services.set('dshHomePath', instance.dataRoot)
  services.set('dshProfile', 'web')

  /**
   * DSH sessionProjections：插件把自己的会话投影注册进 DSH 会话事件流。
   * EAB 还没有完整的 DSH Session 事件管线，但必须先提供可注册的服务，
   * 否则 dsh-context 这类插件会永远停在 pending；投影先保存在宿主里，
   * 后续接入会话事件时再由 EAB 驱动。
   */
  const projections = new Map<number, unknown>()
  let projectionSeq = 0
  const sessionProjections = {
    available: true,
    register: (projection: unknown) => {
      const id = ++projectionSeq
      projections.set(id, projection)
      return () => {
        projections.delete(id)
      }
    },
    list: () => [...projections.values()],
    get: (id: number) => projections.get(Number(id)),
    /**
     * DSH 会话投影的只读形状。dsh-context 的 host 路由会先查
     * `sessionProjections.stateOf(session, 'contextTimeline')`；返回 undefined
     * 时它会认为该会话没有可用上下文，页面显示“历史数据加载失败”。
     * 这里用 EAB 的 chat_messages 现场折叠，返回插件 schema 的原始状态。
     */
    stateOf: (session: unknown, key: string) => {
      if (typeof key !== 'string' || key !== 'contextTimeline') return undefined
      const value = session && typeof session === 'object' ? session as Record<string, any> : {}
      const id = String(value.id || value.sessionId || value.header?.id || '')
      if (!id) return undefined
      const known = sessionsService.get(id)
      if (!known) return undefined
      const events = chatSessionEvents(
        db,
        companyId,
        instance.scope.kind === 'user' ? instance.scope.userId : null,
        id,
      )
      logger.info(`sessionProjections.stateOf contextTimeline ${id} · ${events.length} events`)
      return foldContextTimeline(events)
    },
    /** dsh-context 的 overview 在 live 会话上走 snapshot(session, keys)。 */
    snapshot: (session: unknown, keys?: unknown) => {
      const value = session && typeof session === 'object' ? session as Record<string, any> : {}
      const id = String(value.id || value.sessionId || value.header?.id || '')
      if (!id || !sessionsService.get(id)) return undefined
      const requested = Array.isArray(keys)
        ? keys.filter((key) => key === 'contextTimeline' || key === 'contextActivity')
        : ['contextTimeline', 'contextActivity']
      if (requested.length === 0) return undefined
      const events = chatSessionEvents(
        db,
        companyId,
        instance.scope.kind === 'user' ? instance.scope.userId : null,
        id,
      )
      return {
        values: {
          ...(requested.includes('contextTimeline') ? { contextTimeline: foldContextTimeline(events) } : {}),
          ...(requested.includes('contextActivity') ? { contextActivity: foldContextActivity(events) } : {}),
        },
      }
    },
    dispose: () => projections.clear(),
  }
  services.set('sessionProjections', sessionProjections)
  services.set('speechToText', {
    available: false,
    transcribe: async () =>
      unsupportedHostCall(instance, 'speechToText.unavailable', 'EAB 当前没有接入语音转写服务'),
  })

  /**
   * Cordis 的标准服务是插件启动的硬依赖。即使 EAB 暂时没有实现，也必须给
   * 形状正确的对象，并显式标记 available=false；不能再塞 undefined，否则
   * inject 会把「键存在但值是 undefined」当成就绪，插件一用就崩。
   *
   * 读方法保留空结果以兼容“探测式”插件，但会登记 host gap；创建/写入类方法
   * 直接抛出带 code 的错误，避免插件把“假成功”继续传播。
   */
  const agentService = {
    available: false,
    list: () => {
      markHostGap(instance, 'agents.unavailable', '插件调用 agents.list：EAB 尚未接入 DSH Agent 运行时')
      return []
    },
    roots: () => {
      markHostGap(instance, 'agents.unavailable', '插件调用 agents.roots：EAB 尚未接入 DSH Agent 运行时')
      return []
    },
    get: () => {
      markHostGap(instance, 'agents.unavailable', '插件调用 agents.get：EAB 尚未接入 DSH Agent 运行时')
      return undefined
    },
    isOwnedBy: () => {
      markHostGap(instance, 'agents.unavailable', '插件调用 agents.isOwnedBy：EAB 尚未接入 DSH Agent 运行时')
      return false
    },
    create: async () =>
      unsupportedHostCall(instance, 'agents.create-unavailable', 'EAB 尚未把 DSH agents.create 接入会话运行时'),
    resume: async () =>
      unsupportedHostCall(instance, 'agents.resume-unavailable', 'EAB 尚未把 DSH agents.resume 接入会话运行时'),
  }
  services.set('agents', agentService)
  const pluginManagerService = {
    available: false,
    list: () => {
      markHostGap(instance, 'pluginManager.unavailable', '插件调用 pluginManager.list：EAB 尚未接入 DSH 插件管理服务')
      return []
    },
    get: () => {
      markHostGap(instance, 'pluginManager.unavailable', '插件调用 pluginManager.get：EAB 尚未接入 DSH 插件管理服务')
      return undefined
    },
    enable: async () =>
      unsupportedHostCall(instance, 'pluginManager.enable-unavailable', 'EAB 尚未接入 DSH 插件管理服务 pluginManager.enable'),
    disable: async () =>
      unsupportedHostCall(instance, 'pluginManager.disable-unavailable', 'EAB 尚未接入 DSH 插件管理服务 pluginManager.disable'),
    reload: async () =>
      unsupportedHostCall(instance, 'pluginManager.reload-unavailable', 'EAB 尚未接入 DSH 插件管理服务 pluginManager.reload'),
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
      const pluginChannels = listPluginChannels(
        instance.companyId,
        instance.scope.kind === 'user' ? instance.scope.userId : undefined,
      )
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
      const registration = registerPluginAdapter(instance.companyId, instance.id, ids, adapter, instance.scope)
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
      const disposeRegistry = registerPluginConfigurableProviders(
        instance.companyId,
        instance.id,
        list,
        instance.scope,
      )
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
      const disposeRegistry = registerPluginModelDiscovery(
        instance.companyId,
        instance.id,
        String(id),
        discover,
        instance.scope,
      )
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
  const profileUserId = instance.scope.kind === 'user' ? instance.scope.userId : null
  services.set('profileContext', {
    available: true,
    companyId,
    userId: profileUserId,
    get: () => ({ companyId, userId: profileUserId, locale: 'zh-CN' }),
    current: () => ({ companyId, userId: profileUserId, locale: 'zh-CN' }),
  })
  services.set('attachments', {
    available: false,
    list: async () => {
      markHostGap(instance, 'attachments.unavailable', '插件读取 attachments：EAB 尚未把 DSH attachments 接入文件服务')
      return []
    },
    read: async () => {
      markHostGap(instance, 'attachments.unavailable', '插件读取 attachments：EAB 尚未把 DSH attachments 接入文件服务')
      return null
    },
    upload: async () =>
      unsupportedHostCall(instance, 'attachments.upload-unavailable', 'EAB 尚未把 DSH attachments 接入文件服务'),
  })
  services.set('approval', {
    available: false,
    request: async () => {
      markHostGap(instance, 'approval.unavailable', '插件请求 approval：EAB 尚未接入审批服务')
      return { ok: false, code: 'approval-unavailable', message: 'EAB 尚未接入审批服务' }
    },
  })
  services.set('userQuestions', {
    available: false,
    ask: async () => {
      markHostGap(instance, 'userQuestions.unavailable', '插件请求 userQuestions：EAB 尚未接入交互提问')
      return { ok: false, code: 'user-questions-unavailable', message: 'EAB 尚未接入交互提问' }
    },
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
    if (!path || !path.startsWith('/') || path.includes('..') || path.startsWith('//') || isReserved(path)) {
      logger.warn(`拒绝注册路由 ${path || '(空)'}：必须是绝对路径，且不能占用 EAB 自有页面/接口`)
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

/** 同一个插件目录的依赖安装只跑一次，避免多公司/多入口并发 npm */
const dependencyInstalls = new Map<string, Promise<void>>()

function pluginPackageManifest(
  dir: string,
): {
  dependencies: Record<string, string>
  optional: Record<string, string>
  peers: Record<string, string>
} | null {
  const file = join(dir, 'package.json')
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      dependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    return {
      dependencies: parsed.dependencies ?? {},
      optional: parsed.optionalDependencies ?? {},
      peers: parsed.peerDependencies ?? {},
    }
  } catch {
    return null
  }
}

function hasResolvablePackage(dir: string, spec: string): boolean {
  const requireFromPlugin = createRequire(join(dir, 'package.json'))
  try {
    requireFromPlugin.resolve(spec)
    return true
  } catch {
    // 某些包只暴露 exports，不允许 resolve 根；退回目录探测
  }
  let current = dir
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(current, 'node_modules', spec, 'package.json'))) return true
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return false
}

/**
 * DSH 插件包只带源码，依赖由 DSH 安装器在 profile 里安装；EAB 安装器只落包内容。
 * host 启动前补装插件 `dependencies` 与缺失的 host 侧 peerDependencies。
 * 客户端 peer（React / primitives / Cordis）由 EAB 运行时提供，不从 registry 拉取。
 */
const HOST_PROVIDED_PACKAGES = new Set([
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-runtime',
  'react',
  'react-dom',
])

function packageSpec(name: string, range: string | undefined): string {
  return range ? `${name}@${range}` : name
}

/** 读取插件目录里已经落盘的包清单，用来补齐 peer 的 peer。 */
function installedPackageManifests(dir: string): Array<Record<string, unknown>> {
  const manifests: Array<Record<string, unknown>> = []
  const modules = join(dir, 'node_modules')
  if (!existsSync(modules)) return manifests
  const visit = (packageDir: string) => {
    const file = join(packageDir, 'package.json')
    if (!existsSync(file)) return
    try {
      manifests.push(JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>)
    } catch {
      // 单个损坏的包不影响其他依赖判断
    }
  }
  for (const name of readdirSync(modules)) {
    if (name.startsWith('.')) continue
    if (name.startsWith('@')) {
      const scopeDir = join(modules, name)
      if (!statSync(scopeDir).isDirectory()) continue
      for (const child of readdirSync(scopeDir)) visit(join(scopeDir, child))
    } else {
      const packageDir = join(modules, name)
      if (statSync(packageDir).isDirectory()) visit(packageDir)
    }
  }
  return manifests
}

/** 已安装包声明但当前解析不到的 peerDependencies。 */
function collectMissingPeers(dir: string): string[] {
  const missing = new Map<string, string | undefined>()
  for (const manifest of installedPackageManifests(dir)) {
    // 只递归 DSH 运行时包。普通第三方包会把 vite/vitest 这类构建工具的
    // peer 也声明进来，装到插件目录既无用又会触发大体积下载。
    const packageName = typeof manifest.name === 'string' ? manifest.name : ''
    if (!packageName.startsWith('@deepseek-ai/')) continue
    const peers = manifest.peerDependencies
    if (!peers || typeof peers !== 'object') continue
    const meta = manifest.peerDependenciesMeta
    for (const [name, range] of Object.entries(peers as Record<string, unknown>)) {
      if (HOST_PROVIDED_PACKAGES.has(name) || name.startsWith('@deepseek-ai/dsh-client-')) continue
      if (
        meta &&
        typeof meta === 'object' &&
        (meta as Record<string, { optional?: boolean }>)[name]?.optional === true
      ) {
        continue
      }
      if (hasResolvablePackage(dir, name)) continue
      missing.set(name, typeof range === 'string' ? range : undefined)
    }
  }
  return [...missing.entries()].map(([name, range]) => packageSpec(name, range))
}

const PLUGIN_DEPENDENCY_INSTALL_TIMEOUT_MS = Math.max(
  5_000,
  Number(process.env.EAB_PLUGIN_INSTALL_TIMEOUT_MS) || 60_000,
)
const PLUGIN_DEPENDENCY_BUDGET_MS = Math.max(
  5_000,
  Number(process.env.EAB_PLUGIN_INSTALL_BUDGET_MS) || 90_000,
)

function runNpmInstall(
  dir: string,
  specs: string[],
  logger: ReturnType<typeof makeLogger>,
  signal?: AbortSignal,
): Promise<void> {
  const shellSpecs = process.platform === 'win32'
    ? specs.map((spec) => `"${spec.replace(/"/g, '""')}"`)
    : specs
  return new Promise<void>((resolve, reject) => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const child = spawn(
      npm,
      [
        'install',
        '--no-save',
        '--ignore-scripts',
        '--omit=dev',
        '--legacy-peer-deps',
        '--no-package-lock',
        '--no-audit',
        '--no-fund',
        ...shellSpecs,
      ],
      {
        cwd: dir,
        windowsHide: true,
        shell: process.platform === 'win32',
        env: { ...process.env, npm_config_production: 'false' },
      },
    )
    let output = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      if (onAbort) signal?.removeEventListener('abort', onAbort)
    }
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      fn()
    }
    const stop = (message: string) => {
      output += `\n${message}`
      child.kill()
      finish(() => reject(new Error(output.slice(-800))))
    }
    onAbort = () => stop('依赖安装超出启动预算，已终止')
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(
      () => stop('安装超时，已终止'),
      PLUGIN_DEPENDENCY_INSTALL_TIMEOUT_MS,
    )
    child.stdout?.on('data', (chunk) => {
      output += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      output += String(chunk)
    })
    child.on('error', (error) => {
      finish(() => reject(error))
    })
    child.on('close', (code) => {
      finish(() => {
        if (code === 0) resolve()
        else reject(new Error(output.slice(-800) || `npm install 退出码 ${code}`))
        logger.info(`npm install 完成：${specs.join(',')}`)
      })
    })
  })
}

async function withAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  message: string,
): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) throw new Error(message)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error(message))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
  })
}

async function ensurePluginDependencies(
  instance: HostInstance,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new Error('依赖安装超出启动预算，已终止')
  const manifest = pluginPackageManifest(instance.record.dir)
  if (!manifest) return
  const declared: Record<string, string> = { ...manifest.dependencies, ...manifest.optional }
  for (const [name, range] of Object.entries(manifest.peers)) {
    if (HOST_PROVIDED_PACKAGES.has(name) || name.startsWith('@deepseek-ai/dsh-client-')) continue
    if (!(name in declared)) declared[name] = range
  }
  const firstMissing = Object.keys(declared).filter((name) => !hasResolvablePackage(instance.record.dir, name))
  const peerMissing = firstMissing.length === 0 ? collectMissingPeers(instance.record.dir) : []
  if (firstMissing.length === 0 && peerMissing.length === 0) return
  const existing = dependencyInstalls.get(instance.record.dir)
  if (existing) {
    await withAbort(existing, signal, '依赖安装超出启动预算，已终止')
    return
  }
  const logger = makeLogger(instance)
  const label = firstMissing.length > 0 ? firstMissing.join(',') : peerMissing.join(',')
  logger.info(`插件缺少运行时依赖：${label}，开始安装`)
  const job = (async () => {
    let specs = firstMissing.length > 0
      ? firstMissing.map((name) => packageSpec(name, declared[name]))
      : peerMissing
    for (let round = 0; round < 3 && specs.length > 0; round += 1) {
      await runNpmInstall(instance.record.dir, specs, logger, signal)
      // npm 不会安装 peerDependencies；DSH 运行时包里常有 peer 的 peer，
      // 例如 dsh-session -> dsh-scope。装完直接依赖后再扫一遍已落盘的清单。
      specs = collectMissingPeers(instance.record.dir)
    }
  })().finally(() => {
    dependencyInstalls.delete(instance.record.dir)
  })
  dependencyInstalls.set(instance.record.dir, job)
  try {
    await job
    logger.info(`插件运行时依赖安装完成：${label}`)
  } catch (error) {
    logger.error(`插件运行时依赖安装失败：${(error as Error)?.message ?? String(error)}`)
    throw error
  }
}

/**
 * 个人实例首次启动时，从公司实例继承插件自己的初始数据文件。
 *
 * 历史版本里同名插件只有公司一份数据（例如 dsh-cy-api 的 config.json/secret.key）；
 * 实例化隔离后，个人实例会得到空目录，插件就报告“未配置/接口为空”。这里只在
 * 个人目录缺少同名文件时复制一份，之后个人修改完全独立，不覆盖已有个人数据。
 */
function seedPersonalPluginData(
  record: PluginRecord,
  options: Pick<DshImOptions, 'dbPath' | 'dataDir' | 'dshHomeDir'>,
  companyId: string,
  dataRoot: string,
  scope: PluginScope,
): void {
  if (scope.kind !== 'user') return
  const sourceDir = join(pluginDataRoot(options, companyId, companyScope()), record.id)
  const targetDir = join(dataRoot, record.id)
  if (sourceDir === targetDir || !existsSync(sourceDir)) return
  mkdirSync(targetDir, { recursive: true })
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    const target = join(targetDir, entry.name)
    if (existsSync(target)) continue
    try {
      copyFileSync(join(sourceDir, entry.name), target)
    } catch {
      // 继承失败不阻断插件启动；插件会按自己的空配置运行，用户仍可在个人页面配置。
    }
  }
}

function effectiveHostOptions(options: DshImOptions | null) {
  return options ?? {
    dbPath: loadedOptions?.dbPath ?? '',
    dshHomeDir: loadedOptions?.dshHomeDir,
  }
}

function createHostInstance(
  record: PluginRecord,
  options: DshImOptions | null,
  companyId: string,
  scope: PluginScope,
): HostInstance {
  const effectiveOptions = effectiveHostOptions(options)
  const dataRoot = pluginDataRoot(effectiveOptions, companyId, scope)
  mkdirSync(dataRoot, { recursive: true })
  seedPersonalPluginData(record, effectiveOptions, companyId, dataRoot, scope)
  const instance: HostInstance = {
    instanceKey: pluginInstanceKey(companyId, record.id, scope),
    id: record.id,
    companyId,
    scope,
    dataRoot,
    settingsNamespace: pluginSettingsNamespace(record.id, scope),
    record,
    routes: new Map(),
    upgrades: new Map(),
    logs: [],
    hostGaps: [],
    disposers: [],
    root: null,
    fiber: null,
    startedAt: Date.now(),
    error: null,
    llmProviders: 0,
    llmModels: 0,
  }
  instances.set(instance.instanceKey, instance)
  return instance
}

/**
 * 依赖预装与 host 启动拆开：同一个插件目录只跑一次安装，不同插件目录并发安装。
 * 安装失败或超出预算只记在该实例上，后面的插件继续启动；DSH_HOME 仍然只在
 * startHostInstance 的 import/apply 窗口内串行切换，避免进程级环境变量串号。
 */
export async function preparePluginDependencies(
  instancesToPrepare: readonly HostInstance[],
): Promise<Map<string, string>> {
  const errors = new Map<string, string>()
  const byDir = new Map<string, HostInstance>()
  for (const instance of instancesToPrepare) {
    if (!instance.record.dsh?.hostEntry) continue
    if (!byDir.has(instance.record.dir)) byDir.set(instance.record.dir, instance)
  }
  await Promise.all(
    [...byDir.entries()].map(async ([dir, instance]) => {
      if (!pluginPackageManifest(dir)) return
      const controller = new AbortController()
      const timer = setTimeout(
        () => controller.abort(),
        PLUGIN_DEPENDENCY_BUDGET_MS,
      )
      try {
        await withAbort(
          ensurePluginDependencies(instance, controller.signal),
          controller.signal,
          '依赖安装超出启动预算，已终止',
        )
      } catch (error) {
        errors.set(dir, (error as Error)?.message ?? String(error))
      } finally {
        clearTimeout(timer)
      }
    }),
  )
  return errors
}

async function startHostInstance(
  db: Db,
  instance: HostInstance,
  options: DshImOptions | null,
): Promise<void> {
  const record = instance.record
  const entry = record.dsh?.hostEntry
  if (!entry) return
  const full = join(record.dir, entry)
  if (!existsSync(full)) {
    instance.error = `host 入口不存在：${entry}`
    makeLogger(instance).warn(instance.error)
    return
  }
  const dataRoot = instance.dataRoot
  const envHome = process.env.DSH_HOME
  const envProfile = process.env.DSH_PROFILE
  // DSH_HOME 是进程级变量；在 import/apply 期间临时指向本实例目录。
  // 个人实例因此不会读到公司实例的 config.json / secret.key。
  process.env.DSH_HOME = dataRoot
  process.env.DSH_PROFILE = 'web'
  try {
    // 带 mtime + 实例 scope 的 query：同一物理包被公司/个人安装时各求值一份，
    // 模块级读取 DSH_HOME 的插件也不会共享第一次导入时捕获的路径。
    const url = `${pathToFileURL(full).href}?v=${statSync(full).mtimeMs}&scope=${encodeURIComponent(pluginScopeKey(instance.scope))}`
    const mod = (await import(url)) as Record<string, unknown>
    const plugin = normalizePluginModule(mod)
    if (!plugin) {
      instance.error = 'host 入口不是 DSH/Cordis 插件（需要 apply、default 或类插件）'
      return
    }
    const ctx = makeContext(
      db,
      instance,
      options ? { ...options, dshHomeDir: dataRoot } : null,
    ) as unknown as Context
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
    clearPluginContributions(instance.instanceKey)
    makeLogger(instance).error(`插件 host 启动失败：${instance.error}`)
  } finally {
    if (envHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = envHome
    if (envProfile === undefined) delete process.env.DSH_PROFILE
    else process.env.DSH_PROFILE = envProfile
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
    removePluginModelsForPlugin(instance.companyId, instance.id, instance.scope)
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
    clearPluginContributions(instance.instanceKey)
    instance.routes.clear()
    instance.upgrades.clear()
    instance.hostGaps.length = 0
  }
  instances.clear()
}

/** 启动/重扫 DSH 插件 host：公司装一个实例，每个成员个人安装各跑一个独立 Context */
export async function reloadPluginHosts(db: Db, options?: DshImOptions): Promise<void> {
  loadedDb = db
  if (options) loadedOptions = options
  // 先准备 dsh-im 兼容文件树：公司实例的 DSH_HOME 就是它；个人实例另起子目录。
  if (loadedOptions) prepareDshImCompat(db, loadedOptions)
  disposeAll()
  const targets: Array<{ record: PluginRecord; companyId: string; scope: PluginScope }> = []
  for (const item of listPluginDirectories()) {
    const record = readPluginDirectory(item.id)
    if (!record || !record.valid || record.format !== 'dsh' || !record.dsh?.hasHost) continue
    for (const enabled of enabledInstancesOf(db, record.id)) {
      targets.push({ record, companyId: enabled.companyId, scope: enabled.scope })
    }
  }
  const pending = targets.map((target) =>
    createHostInstance(target.record, loadedOptions, target.companyId, target.scope),
  )
  const dependencyErrors = await preparePluginDependencies(pending)
  for (const instance of pending) {
    const dependencyError = dependencyErrors.get(instance.record.dir)
    if (dependencyError) {
      instance.error = `依赖安装失败：${dependencyError}`
      clearPluginContributions(instance.instanceKey)
      makeLogger(instance).error(instance.error)
      continue
    }
    await startHostInstance(db, instance, loadedOptions)
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

export function pluginHostStatus(
  id: string,
  companyId = 'c1',
  scope: PluginScope = companyScope(),
): PluginHostStatus | null {
  const instance = getHostInstance(id, companyId, scope)
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
    scope: instance.scope.kind,
    userId: instance.scope.kind === 'user' ? instance.scope.userId : null,
    dataRoot: instance.dataRoot,
    loaded: !instance.error && state !== 'failed',
    state,
    pendingServices,
    hostEntry: instance.record.dsh?.hostEntry ?? null,
    startedAt: instance.startedAt,
    error: instance.error,
    routes: [...instance.routes.keys()],
    routeSpecs: [...instance.routes.values()].map((route) => ({
      path: route.path,
      kind: route.kind,
      methods: [...route.methods],
    })),
    hostGaps: [...instance.hostGaps],
    logs: [...instance.logs].slice(-40),
    llmProviders: instance.llmProviders,
    llmModels: instance.llmModels,
  }
}

export function listPluginHostStatuses(
  ids: readonly string[],
  companyId = 'c1',
  scope: PluginScope = companyScope(),
): PluginHostStatus[] {
  return ids.flatMap((id) => {
    const status = pluginHostStatus(id, companyId, scope)
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
  scope: PluginScope = companyScope(),
): Promise<Response> {
  const instance = getHostInstance(id, companyId, scope)
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
  scope: PluginScope = companyScope(),
): Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }> {
  const instance = getHostInstance(id, companyId, scope)
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
