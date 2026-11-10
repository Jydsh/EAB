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
 * - `ctx.llm.registerAdapter` 只登记、不接入 EAB 对话链路（虚拟模型不会出现在 EAB 模型选择器）；
 * - `ctx.inject(['tools'])` 支持注册，但工具只在插件对该员工安装且启用时进入对话；
 * - host 注册的 HTTP 路由只能通过控制台鉴权的桥接接口访问，不直接挂到公网路径上。
 */
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Db } from '@eab/storage'
import { listPluginDirectories, readPluginDirectory, type PluginRecord } from './plugins.js'
import { dshImCredentials, prepareDshImCompat, type DshImOptions } from './dsh-im-compat.js'
import { clearPluginContributions, registerPluginPrompt, registerPluginTool, unregisterPluginTool } from './plugin-tools.js'

export interface PluginHostRoute {
  readonly path: string
  readonly methods: readonly string[]
  readonly fetch: (request: Request) => Promise<Response>
}

export interface PluginHostStatus {
  readonly id: string
  readonly loaded: boolean
  readonly hostEntry: string | null
  readonly startedAt: number | null
  readonly error: string | null
  readonly routes: readonly string[]
  readonly logs: readonly string[]
  readonly llmProviders: number
  readonly llmModels: number
}

interface HostInstance {
  readonly id: string
  readonly record: PluginRecord
  readonly routes: Map<string, PluginHostRoute>
  readonly logs: string[]
  readonly disposers: Array<() => void>
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

function isReserved(path: string): boolean {
  return RESERVED_API_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
}

function activeAndEnabled(db: Db, pluginId: string): boolean {
  const company = db
    .prepare('SELECT COUNT(*) AS total FROM plugin_company_installs WHERE plugin_id = ? AND removed_at IS NULL')
    .get(pluginId) as { total: number } | undefined
  const user = db
    .prepare(
      'SELECT COUNT(*) AS total FROM plugin_user_installs WHERE plugin_id = ? AND removed_at IS NULL AND enabled = 1',
    )
    .get(pluginId) as { total: number } | undefined
  if (Number(company?.total ?? 0) + Number(user?.total ?? 0) > 0) {
    const states = db
      .prepare('SELECT enabled FROM plugin_states WHERE plugin_id = ?')
      .all(pluginId) as unknown as Array<{ enabled: number }>
    // 没有显式状态 = 安装后默认启用；只要有一家公司启用就启动共享 host
    return states.length === 0 || states.some((row) => row.enabled === 1)
  }
  return false
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

function makeLogger(instance: HostInstance, scope = 'dsh-plugin'): Record<string, (...args: unknown[]) => void> {
  const emit = (level: string) =>
    (...args: unknown[]): void => {
      const message = args
        .map((arg) => (typeof arg === 'string' ? arg : (() => {
          try {
            return JSON.stringify(arg)
          } catch {
            return String(arg)
          }
        })()))
        .join(' ')
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

function makeContext(db: Db, instance: HostInstance): Record<string, unknown> {
  const services = new Map<string, unknown>()
  const eventHandlers = new Map<string, Array<(...args: unknown[]) => unknown>>()
  const disposers = instance.disposers
  const logger = makeLogger(instance)
  const loggerFactory = Object.assign((scope: string) => makeLogger(instance, scope), logger)
  // DSH 的 credentials 服务：插件只拿 secretRef，真实密钥仍由 EAB 的 secrets.json 保管
  const credentials = dshImCredentials()
  services.set('credentials', credentials)

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

  /** DSH 的事件总线：插件会注册 user-questions / approval 等监听；EAB 没有这些事件，注册后不触发即可 */
  const on = (event: unknown, handler: unknown): (() => void) => {
    const name = String(event || '')
    if (!name || typeof handler !== 'function') return () => undefined
    const list = eventHandlers.get(name) ?? []
    list.push(handler as (...args: unknown[]) => unknown)
    eventHandlers.set(name, list)
    logger.debug(`on(${name}) 已注册（EAB 暂无该事件源）`)
    return () => {
      const current = eventHandlers.get(name) ?? []
      eventHandlers.set(
        name,
        current.filter((item) => item !== handler),
      )
    }
  }
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

  const register = (spec: {
    path?: unknown
    methods?: unknown
    fetch?: unknown
  }): (() => void) => {
    const path = typeof spec?.path === 'string' ? spec.path.trim() : ''
    if (!path || !path.startsWith('/api/') || path.includes('..') || isReserved(path)) {
      logger.warn(`拒绝注册路由 ${path || '(空)'}：只允许 /api/ 下且不能占用 EAB 自有接口`)
      return () => undefined
    }
    const methods = Array.isArray(spec.methods)
      ? spec.methods.map((item) => String(item).toUpperCase()).filter((item) => item === 'GET' || item === 'POST')
      : ['POST']
    const handler = spec.fetch
    if (typeof handler !== 'function') {
      logger.warn(`拒绝注册路由 ${path}：fetch 不是函数`)
      return () => undefined
    }
    const route: PluginHostRoute = {
      path,
      methods: methods.length ? methods : ['POST'],
      fetch: async (request: Request) => (handler as (request: Request) => Promise<Response>)(request),
    }
    instance.routes.set(path, route)
    logger.info(`RPC 通道已挂载：${route.methods.join('/')} ${path}`)
    return () => {
      instance.routes.delete(path)
    }
  }

  const connection = {
    fetch: { register },
  }

  const llm = {
    listProviders: () => {
      const rows = collectProviderRows(db)
      instance.llmProviders = rows.length
      return rows.map((row) => ({ id: row.id, name: row.name, kind: row.kind }))
    },
    listModels: async (providerId: string) => {
      const rows = collectModelRows(db, String(providerId))
      instance.llmModels += rows.length
      return rows
    },
    registerAdapter: (ids: unknown, _adapter: unknown) => {
      logger.warn(
        `插件尝试注册虚拟模型 ${Array.isArray(ids) ? ids.join('/') : String(ids)}：EAB 暂未把 DSH adapter 接入对话链路，已跳过`,
      )
      return () => undefined
    },
  }

  const context: Record<string, any> = {
    logger: loggerFactory,
    connection,
    llm,
    credentials,
    tools: toolsService,
    systemPrompt: systemPromptService,
    effect: (fn: unknown, label?: string) => {
      if (typeof fn === 'function') {
        disposers.push(fn as () => void)
        logger.debug(`effect 注册：${label || '未命名'}`)
      }
      return fn
    },
    on,
    off: (event: unknown, handler: unknown) => {
      const name = String(event || '')
      const list = eventHandlers.get(name) ?? []
      eventHandlers.set(
        name,
        list.filter((item) => item !== handler),
      )
    },
    once: (event: unknown, handler: unknown) => {
      const name = String(event || '')
      let dispose = (): void => undefined
      const wrapper = (...args: unknown[]) => {
        dispose()
        return (handler as (...args: unknown[]) => unknown)(...args)
      }
      dispose = on(name, wrapper)
      return dispose
    },
    emit,
    provide: (key: string, value: unknown) => {
      services.set(key, value)
      logger.debug(`provide：${key}`)
    },
    get: (key: string) => services.get(key),
    inject: (keys: unknown, callback: unknown) => {
      if (typeof callback !== 'function') return
      const list = Array.isArray(keys) ? keys.map(String) : []
      const child: Record<string, any> = {
        ...context,
        get: (key: string) => (list.includes(key) ? services.get(key) : services.get(key)),
        connection: list.includes('connection') ? connection : context.connection,
        llm: list.includes('llm') ? llm : context.llm,
      }
      for (const key of list) {
        if (services.has(key)) child[key] = services.get(key)
      }
      try {
        ;(callback as (ctx: unknown) => void)(child)
      } catch (error) {
        logger.error(`inject(${list.join(',')}) 回调失败：${(error as Error)?.message ?? error}`)
      }
    },
  }
  return context
}

async function startOne(db: Db, record: PluginRecord): Promise<void> {
  const entry = record.dsh?.hostEntry
  if (!entry) return
  const instance: HostInstance = {
    id: record.id,
    record,
    routes: new Map(),
    logs: [],
    disposers: [],
    startedAt: Date.now(),
    error: null,
    llmProviders: 0,
    llmModels: 0,
  }
  instances.set(record.id, instance)
  const full = join(record.dir, entry)
  if (!existsSync(full)) {
    instance.error = `host 入口不存在：${entry}`
    makeLogger(instance).warn(instance.error)
    return
  }
  try {
    // 带 mtime 的 query：更新插件后重新 import 拿到新模块，而不是命中旧的模块缓存
    const url = `${pathToFileURL(full).href}?v=${statSync(full).mtimeMs}`
    const mod = (await import(url)) as { apply?: unknown; name?: unknown }
    if (typeof mod.apply !== 'function') {
      instance.error = 'host 入口没有导出 apply()，不是 DSH 插件'
      return
    }
    const ctx = makeContext(db, instance)
    await (mod.apply as (ctx: unknown, config: unknown) => Promise<void>)(ctx, {})
    makeLogger(instance).info(`插件 host 已启动，注册路由 ${instance.routes.size} 条`)
  } catch (error) {
    instance.error = (error as Error)?.message ?? String(error)
    clearPluginContributions(instance.id)
    makeLogger(instance).error(`插件 host 启动失败：${instance.error}`)
  }
}

function disposeAll(): void {
  for (const instance of instances.values()) {
    for (const dispose of instance.disposers.reverse()) {
      try {
        dispose()
      } catch {
        // 插件清理失败不阻塞宿主重启
      }
    }
    clearPluginContributions(instance.id)
    instance.routes.clear()
  }
  instances.clear()
}

/** 启动/重扫 DSH 插件 host：只跑已安装且至少一家公司启用、带 host 入口的包 */
export async function reloadPluginHosts(db: Db, options?: DshImOptions): Promise<void> {
  loadedDb = db
  if (options) loadedOptions = options
  // 先准备 dsh-im 兼容文件树：DSH_HOME 必须在 import 插件之前指到隔离副本
  if (loadedOptions) prepareDshImCompat(db, loadedOptions)
  disposeAll()
  for (const item of listPluginDirectories()) {
    const record = readPluginDirectory(item.id)
    if (!record || !record.valid || record.format !== 'dsh' || !record.dsh?.hasHost) continue
    if (!activeAndEnabled(db, record.id)) continue
    await startOne(db, record)
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

export function pluginHostStatus(id: string): PluginHostStatus | null {
  const instance = instances.get(id)
  if (!instance) return null
  return {
    id,
    loaded: !instance.error,
    hostEntry: instance.record.dsh?.hostEntry ?? null,
    startedAt: instance.startedAt,
    error: instance.error,
    routes: [...instance.routes.keys()],
    logs: [...instance.logs].slice(-40),
    llmProviders: instance.llmProviders,
    llmModels: instance.llmModels,
  }
}

export function listPluginHostStatuses(ids: readonly string[]): PluginHostStatus[] {
  return ids.flatMap((id) => {
    const status = pluginHostStatus(id)
    return status ? [status] : []
  })
}

/**
 * 把 DSH client 发来的调用转给插件 host 注册的 fetch 通道。
 * `channel` 对应 DSH 的 `connection.rpc.call(base, channel, call)` 第二个参数。
 */
export async function dispatchPluginRpc(
  id: string,
  channel: string,
  call: unknown,
): Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }> {
  const instance = instances.get(id)
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
  const body = JSON.stringify({
    type: 'client-request',
    rpcId,
    method: channel,
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
