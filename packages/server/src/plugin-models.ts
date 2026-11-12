/**
 * DSH 插件模型注册表。
 *
 * 插件通过 `ctx.llm.registerAdapter(routes, adapter)` 注册的是「provider 路由 +
 * adapter」，不是 EAB `models` 表里的行。这里把 adapter 的 `listModels()` 结果
 * 投影成 EAB 模型目录里的虚拟模型，ID 统一加 `plugin:` 前缀；对话调用再按这个
 * ID 找回 adapter，避免插件模型必须落库才能出现在选择器里。
 */
import { EC, EabError } from '@eab/domain'
import type { CallResult, ChatMessage, ModelStreamOptions } from './llm.js'
import { DEFAULT_PLUGIN_MODEL_ROLES } from './plugin-model-settings.js'
import { companyScope, pluginInstanceKey, type PluginScope } from './plugin-scope.js'
import {
  thinkingConfigFromDeclaredReasoning,
  type ThinkingConfig,
} from './thinking.js'

interface PluginAdapterLike {
  listModels?: (provider: string) => unknown | Promise<unknown>
  resolveModel?: (provider: string, model: string) => unknown | Promise<unknown>
  prepareCall?: (provider: string, model: string) => unknown | Promise<unknown>
  stream?: (options: Record<string, unknown>) => unknown
}

interface RegisteredAdapter {
  pluginId: string
  /** (companyId, pluginId, scope) 的实例键；公司/个人同名插件各注册各的 adapter。 */
  instanceKey: string
  scope: PluginScope
  userId: string | null
  routes: Set<string>
  adapter: PluginAdapterLike
  revision: number
  configurable: Map<string, Record<string, unknown>>
  discovery: ((...args: unknown[]) => unknown) | null
  /** 上次从插件重读目录的时间，避免页面轮询把 listModels 打满。 */
  lastSyncedAt: number
}

interface PluginModelTarget {
  provider: string
  modelId: string
  pluginId: string
  channelId: string
  adapter: PluginAdapterLike
  info: Record<string, unknown>
  instanceKey: string
}

export interface PluginModelDefinition {
  id: string
  name: string
  desc: string
  tags: string[]
  capabilities: string[]
  endpointKind: string
  roles: string[]
  priority: number
  provider: string
  providerName: string
  modelKey: string
  maxContext: number | null
  maxOutputTokens: number | null
  contextCompression: boolean
  inputModalities: string[]
  outputModalities: string[]
  /** 插件声明的思考档位；没有声明时对话页不显示思考选择器。 */
  thinking: ThinkingConfig | null
  source: 'plugin'
  readonly: true
  pluginId: string
  channelId: string
  /** 模型所属实例：公司实例对全员可见，个人实例只对本人可见。 */
  instanceKey: string
  scope: 'company' | 'user'
  userId: string | null
}

export interface PluginChannelDefinition {
  id: string
  pluginId: string
  route: string
  name: string
  kind: 'plugin'
  status: 'active'
  models: number
  settingsNs: string | null
  settingsPath: string[]
  configurable: boolean
  discovery: boolean
  instanceKey: string
  scope: 'company' | 'user'
  userId: string | null
}

const adaptersByCompany = new Map<string, RegisteredAdapter[]>()
const modelsByCompany = new Map<string, Map<string, PluginModelDefinition>>()
const targetsByCompany = new Map<string, Map<string, PluginModelTarget>>()
// 插件允许先声明可配置 provider / 模型探测，再注册 adapter；先暂存，等 adapter
// 到位后合并，避免注册顺序决定控制台能否看到通道。
const pendingConfigurable = new Map<string, Map<string, Map<string, Record<string, unknown>>>>()
const pendingDiscovery = new Map<string, Map<string, (...args: unknown[]) => unknown>>()

type PluginActiveResolver = (companyId: string, pluginId: string) => boolean
type ModelVisibleResolver = (companyId: string, modelId: string) => boolean
export interface PluginModelCatalogChange {
  readonly added: string[]
  readonly removed: string[]
  readonly updated: string[]
}
type PluginModelsChangedListener = (companyId: string, change?: PluginModelCatalogChange) => void

/**
 * 宿主可以在查询时判断插件是否仍对公司有效。插件卸载/停用后，host 的异步 dispose
 * 可能晚于下一次模型列表请求；只在 dispose 时删内存会留下“幽灵模型”，所以这里
 * 每次枚举都再按安装/启停状态过滤一次。
 */
let pluginActiveResolver: PluginActiveResolver | null = null
/** 插件模型只有探测通过才进入目录；未探测默认不可见。 */
let modelVisibleResolver: ModelVisibleResolver | null = null
/** adapter 注册/刷新后通知宿主去补做探测。 */
let modelsChangedListener: PluginModelsChangedListener | null = null

export function setPluginModelActiveResolver(resolver: PluginActiveResolver | null): void {
  pluginActiveResolver = resolver
}

export function setPluginModelVisibilityResolver(resolver: ModelVisibleResolver | null): void {
  modelVisibleResolver = resolver
}

export function setPluginModelsChangedListener(listener: PluginModelsChangedListener | null): void {
  modelsChangedListener = listener
}

function pluginIsActive(companyId: string, pluginId: string): boolean {
  return pluginActiveResolver ? pluginActiveResolver(companyId, pluginId) : true
}

function modelIsVisible(companyId: string, modelId: string): boolean {
  return modelVisibleResolver ? modelVisibleResolver(companyId, modelId) : true
}

function companyAdapters(companyId: string): RegisteredAdapter[] {
  let rows = adaptersByCompany.get(companyId)
  if (!rows) {
    rows = []
    adaptersByCompany.set(companyId, rows)
  }
  return rows
}

function companyModels(companyId: string): Map<string, PluginModelDefinition> {
  let rows = modelsByCompany.get(companyId)
  if (!rows) {
    rows = new Map()
    modelsByCompany.set(companyId, rows)
  }
  return rows
}

function companyTargets(companyId: string): Map<string, PluginModelTarget> {
  let rows = targetsByCompany.get(companyId)
  if (!rows) {
    rows = new Map()
    targetsByCompany.set(companyId, rows)
  }
  return rows
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function instanceToken(scope: PluginScope): string {
  return scope.kind === 'company' ? '' : `user:${encodeURIComponent(scope.userId)}:`
}

function pluginModelId(provider: string, modelId: string, scope: PluginScope): string {
  return `plugin:${instanceToken(scope)}${encodeURIComponent(provider)}:${encodeURIComponent(modelId)}`
}

function pluginChannelId(pluginId: string, route: string, scope: PluginScope): string {
  return `plugin:${instanceToken(scope)}${encodeURIComponent(pluginId)}:${encodeURIComponent(route)}`
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : []
}

function asCapabilities(info: Record<string, unknown>): string[] {
  const modalities = Array.isArray(info.inputModalities) ? info.inputModalities.map(String) : []
  const out = new Set<string>(modalities.includes('image') ? ['vision'] : [])
  if (Array.isArray(info.capabilities)) for (const item of info.capabilities) out.add(String(item))
  return [...out]
}

function toDefinition(
  provider: string,
  info: Record<string, unknown>,
  pluginId: string,
  channelId: string,
  reasoning: unknown,
  registration: RegisteredAdapter,
): PluginModelDefinition {
  const id = String(info.id ?? '')
  if (!id) throw new Error('插件模型缺少 id')
  const context = asRecord(info.context)
  const capabilities = asCapabilities(info)
  const tags = [...new Set([...(Array.isArray(info.tags) ? info.tags.map(String) : ['chat']), ...capabilities])]
  return {
    id: pluginModelId(provider, id, registration.scope),
    name: String(info.name ?? id),
    desc: String(info.description ?? '插件模型'),
    tags,
    capabilities,
    endpointKind: 'chat',
    roles: [...DEFAULT_PLUGIN_MODEL_ROLES],
    priority: 1,
    provider: 'plugin',
    providerName: String(info.providerName ?? provider),
    modelKey: id,
    maxContext: typeof context.contextWindow === 'number' ? Number(context.contextWindow) : null,
    maxOutputTokens: typeof info.defaultMaxTokens === 'number' ? Number(info.defaultMaxTokens) : null,
    contextCompression: false,
    inputModalities: asStringList(info.inputModalities),
    outputModalities: asStringList(info.outputModalities),
    thinking: thinkingConfigFromDeclaredReasoning(reasoning),
    source: 'plugin',
    readonly: true,
    pluginId,
    channelId,
    instanceKey: registration.instanceKey,
    scope: registration.scope.kind,
    userId: registration.userId,
  }
}

const emptyCatalogChange = (): PluginModelCatalogChange => ({ added: [], removed: [], updated: [] })

/**
 * 从插件重读 adapter 的模型目录并做差量同步。
 *
 * 关键点：先读取成功再替换。某个 route 的 listModels 抛错或返回非数组时保留它
 * 上一次的模型，避免插件临时探测失败把整条通道的模型误删；只有成功返回的空数组
 * 才代表“插件确实不再提供这些模型”，此时才删除。
 */
async function refreshAdapter(
  companyId: string,
  registration: RegisteredAdapter,
): Promise<PluginModelCatalogChange> {
  const revision = (registration.revision ?? 0) + 1
  registration.revision = revision
  registration.lastSyncedAt = Date.now()
  const routes = [...registration.routes]
  const fetched = new Map<string, unknown[]>()
  const failed = new Set<string>()
  await Promise.all(
    routes.map(async (route) => {
      let rows: unknown = []
      try {
        rows = registration.adapter.listModels ? await registration.adapter.listModels(route) : []
      } catch {
        failed.add(route)
        return
      }
      if (!Array.isArray(rows)) {
        failed.add(route)
        return
      }
      fetched.set(route, rows)
    }),
  )
  if (registration.revision !== revision) return emptyCatalogChange()

  const models = companyModels(companyId)
  const targets = companyTargets(companyId)
  const before = new Map<string, string>()
  for (const [id, target] of targets) {
    if (target.adapter !== registration.adapter) continue
    const definition = models.get(id)
    if (definition) before.set(id, JSON.stringify(definition))
  }

  // route 被 replace 掉时，旧 route 的模型必须一起消失。
  for (const [id, target] of [...targets]) {
    if (target.adapter === registration.adapter && !routes.includes(target.provider)) {
      targets.delete(id)
      models.delete(id)
    }
  }

  for (const route of routes) {
    if (failed.has(route)) continue
    const channelId = pluginChannelId(registration.pluginId, route, registration.scope)
    // 同一 route 只有成功读到目录时才整体替换，未变化的内容不会触发探测。
    for (const [id, target] of [...targets]) {
      if (target.adapter === registration.adapter && target.provider === route) {
        targets.delete(id)
        models.delete(id)
      }
    }
    for (const raw of fetched.get(route) ?? []) {
      const info = asRecord(raw)
      const modelId = String(info.id ?? '')
      if (!modelId) continue
      // 档位菜单是模型级声明：DSH 的 resolveModel 会返回 reasoning.efforts。
      // 单个模型解析失败不影响目录投影，只是这个模型不显示思考选择器。
      let reasoning: unknown
      if (registration.adapter.resolveModel) {
        try {
          const resolved = asRecord(await registration.adapter.resolveModel(route, modelId))
          reasoning = resolved.reasoning
        } catch {
          reasoning = undefined
        }
      }
      try {
        const definition = toDefinition(route, info, registration.pluginId, channelId, reasoning, registration)
        models.set(definition.id, definition)
        targets.set(definition.id, {
          provider: route,
          modelId,
          pluginId: registration.pluginId,
          channelId,
          adapter: registration.adapter,
          info,
          instanceKey: registration.instanceKey,
        })
      } catch {
        // 单个模型形状不对不影响同一 adapter 的其它模型。
      }
    }
  }

  const added: string[] = []
  const removed: string[] = []
  const updated: string[] = []
  for (const [id, signature] of before) {
    if (!targets.has(id) || targets.get(id)?.adapter !== registration.adapter) removed.push(id)
    else if (JSON.stringify(models.get(id)) !== signature) updated.push(id)
  }
  for (const [id, target] of targets) {
    if (target.adapter === registration.adapter && !before.has(id)) added.push(id)
  }

  const change: PluginModelCatalogChange = { added, removed, updated }
  if (added.length || removed.length || updated.length) {
    // 新增/变更的模型要重新探测；移除的模型由宿主清掉健康状态，避免模型回来时沿用旧结果。
    modelsChangedListener?.(companyId, change)
  }
  return change
}

/**
 * 登记一个插件的 LLM adapter；返回值和 DSH registration 一致，支持 replace / dispose。
 * pluginId 用于把 adapter 路由归到控制台的「插件通道」，不与 EAB 供应商混淆。
 */
export function registerPluginAdapter(
  companyId: string,
  pluginId: string,
  ids: unknown,
  adapter: unknown,
  scope: PluginScope = companyScope(),
): { replace: (next: unknown) => void; dispose: () => void } {
  const normalized = (Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean)
  const instanceKey = pluginInstanceKey(companyId, pluginId, scope)
  const existing = companyAdapters(companyId).find((row) => row.adapter === adapter)
  const registration: RegisteredAdapter = existing ?? {
    pluginId: String(pluginId),
    instanceKey,
    scope,
    userId: scope.kind === 'user' ? scope.userId : null,
    routes: new Set(normalized),
    adapter: (adapter ?? {}) as PluginAdapterLike,
    revision: 0,
    configurable: new Map(),
    discovery: null,
    lastSyncedAt: 0,
  }
  if (existing) {
    registration.pluginId = String(pluginId || registration.pluginId)
    registration.instanceKey = instanceKey
    registration.scope = scope
    registration.userId = scope.kind === 'user' ? scope.userId : null
    registration.routes = new Set(normalized)
  } else {
    companyAdapters(companyId).push(registration)
  }
  const pendingMeta = pendingConfigurable.get(companyId)?.get(instanceKey)
  if (pendingMeta) {
    for (const [route, meta] of pendingMeta) registration.configurable.set(route, meta)
    pendingConfigurable.get(companyId)?.delete(instanceKey)
  }
  const pendingProbe = pendingDiscovery.get(companyId)?.get(instanceKey)
  if (pendingProbe && !registration.discovery) {
    registration.discovery = pendingProbe
    pendingDiscovery.get(companyId)?.delete(instanceKey)
  }
  void refreshAdapter(companyId, registration)

  const replace = (next: unknown): void => {
    registration.routes = new Set((Array.isArray(next) ? next : [next]).map(String).filter(Boolean))
    void refreshAdapter(companyId, registration)
  }
  const dispose = (): void => {
    const list = companyAdapters(companyId)
    const index = list.indexOf(registration)
    if (index >= 0) list.splice(index, 1)
    const models = companyModels(companyId)
    const targets = companyTargets(companyId)
    const removed: string[] = []
    for (const [id, target] of targets) {
      if (target.adapter === registration.adapter) {
        targets.delete(id)
        models.delete(id)
        removed.push(id)
      }
    }
    if (removed.length) {
      modelsChangedListener?.(companyId, { added: [], removed, updated: [] })
    }
  }
  return { replace, dispose }
}

/** 当前公司仍启用插件的全部模型（含探测失败、暂不可见的模型），供健康探测使用。 */
export function listAllPluginModels(companyId: string): PluginModelDefinition[] {
  const activeByPlugin = new Map<string, boolean>()
  return [...companyModels(companyId).values()].filter((model) => {
    let active = activeByPlugin.get(model.pluginId)
    if (active === undefined) {
      active = pluginIsActive(companyId, model.pluginId)
      activeByPlugin.set(model.pluginId, active)
    }
    return active
  })
}

/**
 * 对外可见的插件模型：插件仍启用，并且已经探测通过。
 * 未探测的模型默认不返回，避免服务刚启动时把尚未验证的插件模型放进对话候选。
 *
 * 不传 userId 时只返回公司实例；传了才并入该成员自己的个人实例模型。
 * 个人模型绝不能出现在其他成员的候选列表里。
 */
export function listPluginModels(companyId: string, userId?: string): PluginModelDefinition[] {
  return listAllPluginModels(companyId).filter((model) => {
    if (!modelIsVisible(companyId, model.id)) return false
    if (model.scope === 'company') return true
    return Boolean(userId && model.userId === String(userId))
  })
}

/**
 * 控制台看到的插件通道。一个 adapter 可以注册多条 route，每条 route 是一个
 * 独立通道；配置元数据来自 `ctx.llm.registerConfigurableProviders`。
 */
export function listPluginChannels(companyId: string, userId?: string): PluginChannelDefinition[] {
  const channels = new Map<string, PluginChannelDefinition>()
  const models = listPluginModels(companyId, userId)
  for (const registration of companyAdapters(companyId)) {
    if (!pluginIsActive(companyId, registration.pluginId)) continue
    if (registration.scope.kind === 'user' && registration.userId !== String(userId ?? '')) continue
    for (const route of registration.routes) {
      const id = pluginChannelId(registration.pluginId, route, registration.scope)
      const meta = registration.configurable.get(route) ?? {}
      const settingsPath = Array.isArray(meta.settingsPath) ? meta.settingsPath.map(String) : []
      const modelCount = models.filter((model) => model.channelId === id).length
      channels.set(id, {
        id,
        pluginId: registration.pluginId,
        route,
        name: String(meta.displayName ?? meta.name ?? route),
        kind: 'plugin',
        status: 'active',
        models: modelCount,
        settingsNs: typeof meta.settingsNs === 'string' ? meta.settingsNs : null,
        settingsPath,
        configurable: registration.configurable.has(route),
        discovery: Boolean(registration.discovery),
        instanceKey: registration.instanceKey,
        scope: registration.scope.kind,
        userId: registration.userId,
      })
    }
  }
  return [...channels.values()]
}

/** 登记插件声明的可配置 provider，用于控制台显示通道名称与设置归属。 */
export function registerPluginConfigurableProviders(
  companyId: string,
  pluginId: string,
  list: unknown,
  scope: PluginScope = companyScope(),
): () => void {
  if (!Array.isArray(list)) return () => undefined
  const rows = list.map(asRecord)
  const instanceKey = pluginInstanceKey(companyId, pluginId, scope)
  const registration = companyAdapters(companyId).find((row) => row.instanceKey === instanceKey)
  if (!registration) {
    let byPlugin = pendingConfigurable.get(companyId)
    if (!byPlugin) {
      byPlugin = new Map()
      pendingConfigurable.set(companyId, byPlugin)
    }
    let meta = byPlugin.get(instanceKey)
    if (!meta) {
      meta = new Map()
      byPlugin.set(instanceKey, meta)
    }
    const added: string[] = []
    for (const row of rows) {
      const route = String(row.provider ?? row.id ?? '')
      if (!route) continue
      meta.set(route, row)
      added.push(route)
    }
    return () => {
      for (const route of added) {
        if (meta.get(route) === rows.find((row) => String(row.provider ?? row.id ?? '') === route)) {
          meta.delete(route)
        }
      }
    }
  }
  const added: string[] = []
  for (const row of rows) {
    const route = String(row.provider ?? row.id ?? '')
    if (!route) continue
    registration.configurable.set(route, row)
    added.push(route)
  }
  return () => {
    for (const route of added) registration.configurable.delete(route)
  }
}

/** 登记插件的模型探测函数；控制台「刷新模型」会调用它并重新投影目录。 */
export function registerPluginModelDiscovery(
  companyId: string,
  pluginId: string,
  id: string,
  discover: (...args: unknown[]) => unknown,
  scope: PluginScope = companyScope(),
): () => void {
  const instanceKey = pluginInstanceKey(companyId, pluginId, scope)
  const registration = companyAdapters(companyId).find((row) => row.instanceKey === instanceKey)
  if (!registration) {
    let byPlugin = pendingDiscovery.get(companyId)
    if (!byPlugin) {
      byPlugin = new Map()
      pendingDiscovery.set(companyId, byPlugin)
    }
    byPlugin.set(instanceKey, discover)
    return () => {
      if (byPlugin.get(instanceKey) === discover) byPlugin.delete(instanceKey)
    }
  }
  const previous = registration.discovery
  registration.discovery = discover
  void id
  return () => {
    if (registration.discovery === discover) registration.discovery = previous
  }
}

/** 控制台「刷新模型」：先让插件重新探测，再重读 adapter 的模型目录。 */
export async function refreshPluginChannel(companyId: string, channelId: string): Promise<number> {
  const registration = companyAdapters(companyId).find((row) =>
    [...row.routes].some((route) => pluginChannelId(row.pluginId, route, row.scope) === String(channelId)),
  )
  if (!registration) return 0
  try {
    await registration.discovery?.()
  } catch {
    // 探测失败仍保留旧模型，控制台只显示刷新后的真实数量。
  }
  await refreshAdapter(companyId, registration)
  return listPluginModels(companyId, registration.userId ?? undefined).filter(
    (model) => model.channelId === String(channelId),
  ).length
}

export interface PluginModelSyncResult {
  readonly added: number
  readonly removed: number
  readonly updated: number
}

const catalogSyncsInFlight = new Map<string, Promise<PluginModelSyncResult>>()

/**
 * 让 EAB 目录跟随插件当前的模型目录。
 *
 * 插件会在自己的免费额度扫描里把不再免费的模型从 `listModels()` 摘掉；EAB 不能只在
 * 注册时读一次，否则插件里已经消失的模型仍会留在对话和控制台里。这里只重读
 * adapter 的目录，不额外打上游，失败时保留旧模型，成功返回的空目录才会清理。
 */
export function syncPluginModels(
  companyId: string,
  options: { minIntervalMs?: number } = {},
): Promise<PluginModelSyncResult> {
  const existing = catalogSyncsInFlight.get(companyId)
  if (existing) return existing
  const minIntervalMs = Math.max(0, Number(options.minIntervalMs ?? 0))
  const task = (async (): Promise<PluginModelSyncResult> => {
    const result = { added: 0, removed: 0, updated: 0 }
    for (const registration of [...companyAdapters(companyId)]) {
      if (!pluginIsActive(companyId, registration.pluginId)) continue
      if (registration.routes.size === 0) continue
      if (minIntervalMs > 0 && Date.now() - registration.lastSyncedAt < minIntervalMs) continue
      const change = await refreshAdapter(companyId, registration)
      result.added += change.added.length
      result.removed += change.removed.length
      result.updated += change.updated.length
    }
    return result
  })()
  catalogSyncsInFlight.set(companyId, task)
  const cleanup = (): void => {
    if (catalogSyncsInFlight.get(companyId) === task) catalogSyncsInFlight.delete(companyId)
  }
  void task.then(cleanup, cleanup)
  return task
}

const DEFAULT_CATALOG_SYNC_INTERVAL_MS = 15_000

/**
 * 周期性把插件目录同步到 EAB。只读插件的 `listModels()`，不触发真实回复探测；
 * 新增或变更的模型由 modelsChangedListener 统一补探测。
 */
export function startPluginModelCatalogSync(
  companyId: string,
  options: { intervalMs?: number } = {},
): () => void {
  const raw = Number(options.intervalMs ?? DEFAULT_CATALOG_SYNC_INTERVAL_MS)
  const intervalMs = Number.isFinite(raw) && raw >= 5_000 ? Math.trunc(raw) : DEFAULT_CATALOG_SYNC_INTERVAL_MS
  let stopped = false
  const run = (): void => {
    if (stopped) return
    void syncPluginModels(companyId, { minIntervalMs: intervalMs }).catch(() => undefined)
  }
  run()
  const timer = setInterval(run, intervalMs)
  timer.unref?.()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}

export function findPluginModel(companyId: string, id: string): PluginModelDefinition | null {
  const model = companyModels(companyId).get(String(id))
  if (!model || !pluginIsActive(companyId, model.pluginId)) return null
  return model
}

/**
 * 插件停用/卸载时立即把它的模型摘掉。host 的 root fiber dispose 是异步的，
 * 单靠 adapter.dispose 可能让下一次模型列表请求仍读到旧模型。
 */
export function removePluginModelsForPlugin(
  companyId: string,
  pluginId: string,
  scope: PluginScope = companyScope(),
): void {
  const models = companyModels(companyId)
  const targets = companyTargets(companyId)
  const instanceKey = pluginInstanceKey(companyId, pluginId, scope)
  const removed: string[] = []
  for (const [id, model] of models) {
    if (model.pluginId === String(pluginId) && model.instanceKey === instanceKey) {
      models.delete(id)
      removed.push(id)
    }
  }
  for (const [id, target] of targets) {
    if (target.pluginId === String(pluginId) && target.instanceKey === instanceKey) targets.delete(id)
  }
  const registrations = companyAdapters(companyId)
  const registrationIndex = registrations.findIndex((row) => row.instanceKey === instanceKey)
  if (registrationIndex >= 0) registrations.splice(registrationIndex, 1)
  for (const [key] of pendingConfigurable.get(companyId) ?? []) {
    if (key === instanceKey) pendingConfigurable.get(companyId)?.delete(key)
  }
  for (const [key] of pendingDiscovery.get(companyId) ?? []) {
    if (key === instanceKey) pendingDiscovery.get(companyId)?.delete(key)
  }
  if (removed.length) {
    modelsChangedListener?.(companyId, { added: [], removed, updated: [] })
  }
}

export function isPluginModelId(id: string): boolean {
  return String(id).startsWith('plugin:')
}

function extractUsage(value: unknown): { input: number; output: number } {
  const usage = asRecord(value)
  const input = Number(usage.inputTokens ?? usage.promptTokens ?? 0)
  const output = Number(usage.outputTokens ?? usage.completionTokens ?? 0)
  return {
    input: Number.isFinite(input) ? input : 0,
    output: Number.isFinite(output) ? output : 0,
  }
}

function toHarnessMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages.map((message) => {
    const content = typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content.map((part) => {
          if (part.type === 'text') return { type: 'text', text: part.text }
          if (part.type === 'image_url') {
            return { type: 'image', attachment: { url: part.image_url.url } }
          }
          return part
        })
    const toolCalls = (message as unknown as { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }).tool_calls ?? []
    const blocks = [
      ...content,
      ...toolCalls.map((call) => ({
        type: 'tool-call',
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      })),
    ]
    return {
      role: message.role,
      content: blocks,
      ...(message.tool_call_id ? { toolCallId: message.tool_call_id } : {}),
    }
  })
}

/**
 * 插件侧失败统一对外表达为上游错误：插件模型不在 EAB 供应商配置里，落 500
 * 会让用户误以为是基座故障。
 */
function pluginUpstreamError(target: PluginModelTarget, error: unknown): EabError {
  if (error instanceof EabError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new EabError(EC.UPSTREAM, `插件模型「${target.modelId}」调用失败：${message}`, {
    hint: '检查插件设置里的上游凭据、额度或网络出口；该模型由插件提供，不在 EAB 模型供应商配置中。',
    details: { modelId: target.modelId, provider: target.provider },
  })
}

/**
 * 按 `plugin:` 模型 ID 调插件 adapter，把 DSH 的扁平 block 流投影成 EAB 的
 * CallResult / onEvent。未登记的 ID 返回 null，交给原有 EAB 模型路径。
 */
export async function callPluginModel(
  companyId: string,
  modelId: string,
  messages: ChatMessage[],
  options: ModelStreamOptions = {},
  maxTokens = 4096,
): Promise<CallResult | null> {
  const target = companyTargets(companyId).get(String(modelId))
  if (!target) return null
  const adapter = target.adapter
  const callOptions: Record<string, unknown> = {
    model: target.modelId,
    messages: toHarnessMessages(messages),
    tools: options.tools,
    toolChoice: options.toolChoice,
    maxTokens,
    signal: options.signal,
  }
  if (options.reasoningEffort) callOptions.reasoningEffort = options.reasoningEffort
  let prepared: unknown = null
  try {
    prepared = adapter.prepareCall ? await adapter.prepareCall(target.provider, target.modelId) : null
  } catch (error) {
    throw pluginUpstreamError(target, error)
  }
  const preparedRecord = asRecord(prepared)
  const streamFn = typeof preparedRecord.stream === 'function'
    ? (preparedRecord.stream as (options: Record<string, unknown>) => AsyncIterable<unknown>)
    : adapter.stream as ((options: Record<string, unknown>) => AsyncIterable<unknown>) | undefined
  if (typeof streamFn !== 'function') {
    throw new EabError(EC.UPSTREAM, `插件模型「${target.modelId}」没有实现 stream()`, {
      details: { modelId: target.modelId, provider: target.provider },
    })
  }

  let text = ''
  let reasoning = ''
  let promptTokens = 0
  let completionTokens = 0
  let finishKind = ''
  let finishMessage = ''
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>()

  try {
    for await (const raw of streamFn.call(target.adapter, callOptions)) {
      const chunk = asRecord(raw)
      const type = String(chunk.type ?? '')
      if (type === 'reasoning-delta') {
        const delta = String(chunk.text ?? '')
        reasoning += delta
        if (delta) options.onEvent?.({ type: 'reasoning', text: delta })
      } else if (type === 'text-delta') {
        const delta = String(chunk.text ?? '')
        text += delta
        if (delta) options.onEvent?.({ type: 'content', text: delta })
      } else if (type === 'tool-call-delta') {
        const index = Number(chunk.index ?? 0)
        const current = toolCalls.get(index) ?? { id: '', name: '', arguments: '' }
        if (chunk.id) current.id = String(chunk.id)
        if (chunk.name) current.name = String(chunk.name)
        if (chunk.argumentsDelta) current.arguments += String(chunk.argumentsDelta)
        toolCalls.set(index, current)
      } else if (type === 'block-end') {
        const block = asRecord(chunk.block)
        if (String(block.type ?? '') === 'tool-call') {
          const index = Number(chunk.index ?? 0)
          toolCalls.set(index, {
            id: String(block.id ?? ''),
            name: String(block.name ?? ''),
            arguments: String(block.arguments ?? '{}'),
          })
        }
      } else if (type === 'usage') {
        const usage = extractUsage(chunk.usage)
        promptTokens = usage.input || promptTokens
        completionTokens = usage.output || completionTokens
      } else if (type === 'finish') {
        const reason = asRecord(chunk.reason)
        finishKind = String(reason.kind ?? '')
        finishMessage = String(asRecord(reason.failure).message ?? '')
      }
    }
  } catch (error) {
    throw pluginUpstreamError(target, error)
  }

  if (options.signal?.aborted) {
    throw new EabError(EC.UPSTREAM, '请求已取消')
  }
  if (finishKind === 'error') {
    throw new EabError(EC.UPSTREAM, finishMessage || `插件模型「${target.modelId}」调用失败`, {
      details: { modelId: target.modelId, provider: target.provider },
    })
  }
  if (!text.trim() && toolCalls.size === 0) {
    throw new EabError(EC.UPSTREAM, finishMessage || `插件模型「${target.modelId}」返回了空内容`, {
      details: { modelId: target.modelId, provider: target.provider },
    })
  }
  return {
    text,
    reasoning,
    toolCalls: [...toolCalls.values()]
      .filter((call) => call.name)
      .map((call, index) => ({
        id: call.id || `plugin_call_${index}`,
        type: 'function' as const,
        function: { name: call.name, arguments: call.arguments || '{}' },
      })),
    promptTokens,
    completionTokens,
  }
}
