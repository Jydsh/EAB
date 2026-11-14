/**
 * 插件工具桥。
 *
 * DSH 插件通过 `ctx.inject(['tools'], tools => tools.register(...))` 把自己的工具注册给宿主。
 * 这里把注册结果收进 EAB 的工具发现链，并按「插件对当前公司/当前员工是否安装且启用」过滤：
 * - 对话模型拿到的 function 列表里会出现插件工具；
 * - 模型发起 function call 后，由宿主调用插件自己的 `execute(args, exec)`；
 * - 插件停用、个人停用、卸载或宿主重扫时，注册项随 host 一起清空。
 *
 * 插件工具统一要求 `agent:tool:invoke` 权限，不能借插件绕过 EAB 的工具权限。
 */
import type { Db } from '@eab/storage'
import { EC, EabError, SC } from '@eab/domain'
import { KeyedSemaphore, LockAbortedError, SemaphoreQueueFullError, SemaphoreTimeoutError } from './concurrency.js'
import { acquireCoordinationSlot, coordinationStatus, readCapacityCount } from './backends/coordination.js'
import { getBackendRuntime } from './backends/runtime.js'
import { beginToolInflight } from './tool-inflight.js'
import { listActorPluginInstances, pluginInstanceKey, type PluginScope } from './plugin-scope.js'
import {
  pluginToolAccessId,
  readToolRoleAccessMap,
  toolAllowedForRoles,
  toolRoleAccessReady,
} from './tool-role-access.js'

export interface PluginToolActor {
  readonly subject: {
    readonly companyId: string
    readonly userId: string
    readonly scopes: ReadonlySet<string>
    /** 当前角色代码；用于工具级角色白名单，缺省视为没有角色。 */
    readonly roles?: readonly string[]
  }
}

export interface PluginToolRegistration {
  /** 实例键：(companyId, pluginId, scope)；同名插件的公司/个人实例互不覆盖。 */
  readonly instanceKey: string
  readonly companyId: string
  readonly scope: PluginScope
  readonly pluginId: string
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly execute: (args: Record<string, unknown>, exec: Record<string, unknown>) => unknown
}

interface PromptEntry {
  readonly name: string
  readonly order: number
  readonly text: string | (() => string)
}

const toolsByInstance = new Map<string, Map<string, PluginToolRegistration>>()
const promptsByInstance = new Map<string, Map<string, PromptEntry>>()

/** 插件工具并发上限；按插件隔离，避免一个插件递归/死循环拖垮整个服务。 */
export const pluginToolSemaphore = new KeyedSemaphore()

export interface PluginToolExecOptions {
  /** 同一插件同时执行上限；默认 4 */
  readonly maxConcurrent?: number
  /** 执行超时毫秒；默认 60 秒 */
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

function safeToolName(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 64)
}

function normalizeParameters(definition: Record<string, unknown>): Record<string, unknown> {
  const candidate = definition.parameters ?? definition.params ?? definition.inputSchema ?? definition.input
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
    const schema = candidate as Record<string, unknown>
    return {
      type: 'object',
      properties: schema.properties && typeof schema.properties === 'object' ? schema.properties : {},
      required: Array.isArray(schema.required) ? schema.required.map(String) : [],
      additionalProperties: false,
    }
  }
  return { type: 'object', properties: {}, required: [], additionalProperties: false }
}

function definitionsOf(nameOrDefinition: unknown, maybeDefinition: unknown): { name: string; definition: Record<string, unknown> } | null {
  if (typeof nameOrDefinition === 'string') {
    if (!maybeDefinition || typeof maybeDefinition !== 'object') return null
    return { name: nameOrDefinition, definition: maybeDefinition as Record<string, unknown> }
  }
  if (nameOrDefinition && typeof nameOrDefinition === 'object' && !Array.isArray(nameOrDefinition)) {
    const definition = nameOrDefinition as Record<string, unknown>
    if (typeof definition.name !== 'string') return null
    return { name: definition.name, definition }
  }
  return null
}

function ownerOf(instanceKey: string, name: string): string | null {
  const tools = toolsByInstance.get(instanceKey)
  return tools?.has(name) ? instanceKey : null
}

/**
 * 注册一个插件工具。
 *
 * 工具归属到实例而不是插件 id：公司安装和个人安装各自注册自己的工具，
 * 同名工具在不同实例里可以并存，执行时按当前员工可用的实例选择。
 */
export function registerPluginTool(
  instanceKey: string,
  companyId: string,
  pluginId: string,
  scope: PluginScope,
  nameOrDefinition: unknown,
  maybeDefinition?: unknown,
): { ok: boolean; name: string; dispose: () => void; reason?: string } {
  const parsed = definitionsOf(nameOrDefinition, maybeDefinition)
  if (!parsed) return { ok: false, name: '', dispose: () => undefined, reason: '工具定义缺少 name' }
  const name = safeToolName(parsed.name)
  if (!name) return { ok: false, name: '', dispose: () => undefined, reason: '工具名为空' }
  const definition = parsed.definition
  if (typeof definition.execute !== 'function') {
    return { ok: false, name, dispose: () => undefined, reason: '工具缺少 execute()' }
  }
  if (ownerOf(instanceKey, name)) {
    return { ok: false, name, dispose: () => undefined, reason: '同一插件实例里工具名重复' }
  }
  const list = toolsByInstance.get(instanceKey) ?? new Map<string, PluginToolRegistration>()
  const registration: PluginToolRegistration = {
    instanceKey,
    companyId,
    scope,
    pluginId,
    name,
    description: String(definition.description ?? definition.title ?? name),
    parameters: normalizeParameters(definition),
    execute: definition.execute as PluginToolRegistration['execute'],
  }
  list.set(name, registration)
  toolsByInstance.set(instanceKey, list)
  clearPluginToolSpecsCache()
  return {
    ok: true,
    name,
    dispose: () => {
      list.delete(name)
      if (list.size === 0) toolsByInstance.delete(instanceKey)
      clearPluginToolSpecsCache()
    },
  }
}

export function unregisterPluginTool(instanceKey: string, name: unknown): void {
  const toolName = safeToolName(name)
  const list = toolsByInstance.get(instanceKey)
  if (!list) return
  list.delete(toolName)
  if (list.size === 0) toolsByInstance.delete(instanceKey)
  clearPluginToolSpecsCache()
}

/** 注册插件对系统提示的贡献（如「什么时候该发钉钉卡片」） */
export function registerPluginPrompt(instanceKey: string, entry: unknown): void {
  if (!entry || typeof entry !== 'object') return
  const raw = entry as Record<string, unknown>
  const name = String(raw.name ?? '').trim()
  const text = raw.text
  if (!name || (typeof text !== 'string' && typeof text !== 'function')) return
  const list = promptsByInstance.get(instanceKey) ?? new Map<string, PromptEntry>()
  list.set(name, {
    name,
    order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : 100,
    text: text as string | (() => string),
  })
  promptsByInstance.set(instanceKey, list)
}

/** 插件实例卸载/停用/宿主重扫时调用；只摘掉该实例的贡献。 */
export function clearPluginContributions(instanceKey: string): void {
  toolsByInstance.delete(instanceKey)
  promptsByInstance.delete(instanceKey)
  clearPluginToolSpecsCache()
}

/**
 * 用户本轮是否明确要求使用个人插件。
 *
 * 只认“动作 + 个人插件/个人安装/个人版”这类明确指令，避免把
 * “公司和个人插件都有同名工具吗”这种普通提及误判成使用个人插件。
 */
export function prefersPersonalPluginTools(text: string): boolean {
  const compact = String(text || '').replace(/\s+/g, ' ').trim()
  if (!compact) return false
  // “不要用个人插件”“别走个人安装”是否定意图，不能因为出现“用 + 个人插件”就误切。
  if (/(?:不要|别|不用|不使用|无需|没必要)[^。！？\n]{0,8}(?:个人|我的|我自己)[^。！？\n]{0,8}(?:插件|工具|安装|版本)/.test(compact)) {
    return false
  }
  // “用公司插件还是个人插件”属于二选一提问，没有明确选择，不能按个人模式执行。
  if (
    /(?:公司|企业|团队)[^。！？\n]{0,10}(?:还是|或者|或)[^。！？\n]{0,10}(?:个人|我的|我自己)/.test(compact)
    || /(?:个人|我的|我自己)[^。！？\n]{0,10}(?:还是|或者|或)[^。！？\n]{0,10}(?:公司|企业|团队)/.test(compact)
  ) {
    return false
  }
  return (
    /(?:用|使用|调用|走|选择|切换(?:到|成)?|优先|改成|换成)[^。！？\n]{0,12}(?:个人|我的|我自己)[^。！？\n]{0,8}(?:插件|工具|安装|版本)/.test(compact)
    || /(?:个人|我的|我自己)[^。！？\n]{0,8}(?:插件|工具|安装|版本)[^。！？\n]{0,10}(?:优先|执行|处理|调用|来|试试|吧)/.test(compact)
  )
}

/**
 * 当前公司/当前员工真正可用的插件实例：
 * 公司级安装且未被公司级状态停用；或个人级安装且启用。
 * 默认公司实例排在前面：同名插件同时存在公司/个人安装时，公司工具优先；
 * 只有本轮用户明确要求个人插件时，才把个人实例提前。
 */
function actorInstanceKeys(
  db: Db,
  actor: Pick<PluginToolActor, 'subject'>,
  preferPersonal = false,
): string[] {
  const rows = listActorPluginInstances(db, actor.subject.companyId, actor.subject.userId)
    .sort((a, b) => {
      const aUser = a.scope.kind === 'user' ? 0 : 1
      const bUser = b.scope.kind === 'user' ? 0 : 1
      if (aUser !== bUser) return preferPersonal ? aUser - bUser : bUser - aUser
      return a.pluginId.localeCompare(b.pluginId)
    })
  return rows.map((row) => pluginInstanceKey(row.companyId, row.pluginId, row.scope))
}

/** 兼容旧调用：当前操作者可用的插件 id 集合（不区分实例）。 */
export function enabledPluginIds(db: Db, actor: Pick<PluginToolActor, 'subject'>): Set<string> {
  const ids = new Set<string>()
  for (const row of listActorPluginInstances(db, actor.subject.companyId, actor.subject.userId)) {
    ids.add(row.pluginId)
  }
  return ids
}

/** 角色表就绪后，个人插件工具默认拒绝；公司插件工具沿用历史默认。 */
function pluginToolDefaultAllow(db: Db, tool: PluginToolRegistration): boolean {
  if (tool.scope.kind === 'company') return true
  return !toolRoleAccessReady(db)
}

/** 个人插件工具只归安装人本人：别人看不到，本人也不该再走角色授权。 */
function personalToolOwnedBy(
  tool: PluginToolRegistration,
  actor: Pick<PluginToolActor, 'subject'>,
): boolean {
  return tool.scope.kind === 'user' && tool.scope.userId === actor.subject.userId
}

/**
 * 插件工具对当前账号是否可用。
 * 个人工具：归属人自己就直接可用，不需要管理员按角色授权；
 * 公司工具：仍按控制台配置的角色白名单决定。
 */
function toolUsableForActor(
  db: Db,
  tool: PluginToolRegistration,
  actor: PluginToolActor,
  roleAccess: ReturnType<typeof readToolRoleAccessMap>,
): boolean {
  if (personalToolOwnedBy(tool, actor)) return true
  return toolAllowedForRoles(
    roleAccess.get(pluginToolAccessId(tool.pluginId, tool.name)),
    actor.subject.roles ?? [],
    pluginToolDefaultAllow(db, tool),
  )
}

/** 插件工具 schema 的进程内短缓存。
 *
 * 为什么不做 Redis 共享：`toolsByInstance` 是每个进程自己加载的插件注册表，
 * 把 A 实例的 schema 共享给没加载该插件的 B 实例，会让模型看到本机不存在的工具。
 * 所以缓存只在进程内，靠「5 秒 TTL + 安装/启停/授权时 Pub/Sub 广播清空」保持一致。
 */
const SPECS_CACHE_TTL_MS =
  process.env.NODE_ENV === 'test' || process.env.VITEST ? 0 : 5_000
const PLUGIN_TOOLS_CACHE_CHANNEL = 'plugin-tools'
const specsCache = new Map<string, { at: number; value: Array<Record<string, unknown>> }>()

function specsCacheKey(actor: PluginToolActor, options: { preferPersonal?: boolean }): string {
  const roles = [...(actor.subject.roles ?? [])].sort().join(',')
  const scopes = [...actor.subject.scopes].sort().join(',')
  return `${actor.subject.companyId}\u0000${actor.subject.userId}\u0000${options.preferPersonal ? 1 : 0}\u0000${roles}\u0000${scopes}`
}

/** 本进程立即清空；注册/卸载插件工具时调用，避免新工具要等 TTL 才出现。 */
export function clearPluginToolSpecsCache(): void {
  specsCache.clear()
}

/** 清本进程并通知其它实例；安装、启停、卸载、工具角色授权变更后调用。 */
export async function invalidatePluginToolSpecsEverywhere(): Promise<void> {
  clearPluginToolSpecsCache()
  const pubsub = getBackendRuntime()?.pubsub
  if (!pubsub) return
  try {
    await pubsub.publish(PLUGIN_TOOLS_CACHE_CHANNEL, 'invalidate')
  } catch {
    // 广播失败最多让其它实例多等 5 秒 TTL，不影响业务
  }
}

/** 启动时订阅一次；没接 Redis 时什么都不做，纯单实例用本地 TTL 即可。 */
export async function startPluginToolSpecsCacheInvalidation(): Promise<void> {
  const pubsub = getBackendRuntime()?.pubsub
  if (!pubsub) return
  try {
    // Redis 订阅连接偶发卡住时不阻塞主服务启动；订阅成功后再补上即可，5 秒 TTL 仍兜底。
    await Promise.race([
      pubsub.subscribe(PLUGIN_TOOLS_CACHE_CHANNEL, () => clearPluginToolSpecsCache()),
      new Promise<void>((resolve) => setTimeout(resolve, 2000)),
    ])
  } catch {
    // 订阅失败只影响跨实例即时性，5 秒 TTL 仍会兜底
  }
}

export function pluginToolSpecsFor(
  db: Db,
  actor: PluginToolActor,
  options: { preferPersonal?: boolean } = {},
): Array<Record<string, unknown>> {
  // 可见性策略：
  // - 个人实例只属于安装人：actorInstanceKeys 只并入当前 userId 的个人实例，
  //   本人调用自己的工具不需要角色授权；
  // - 公司实例属于当前公司，且要求角色具备 `agent:tool:invoke`，再按控制台角色白名单判定。
  if (!actor.subject.scopes.has(SC.AGENT_TOOL_INVOKE)) return []
  const cacheKey = SPECS_CACHE_TTL_MS > 0 ? specsCacheKey(actor, options) : ''
  if (cacheKey) {
    const hit = specsCache.get(cacheKey)
    if (hit && Date.now() - hit.at < SPECS_CACHE_TTL_MS) return hit.value
  }
  const roleAccess = readToolRoleAccessMap(db, actor.subject.companyId)
  const specs: Array<Record<string, unknown>> = []
  const seen = new Set<string>()
  for (const instanceKey of actorInstanceKeys(db, actor, options.preferPersonal === true)) {
    const tools = toolsByInstance.get(instanceKey)
    if (!tools) continue
    for (const tool of tools.values()) {
      // 公司和个人实例可能暴露同名工具；function 名不能重复，默认公司实例先入列。
      if (seen.has(tool.name)) continue
      if (!toolUsableForActor(db, tool, actor, roleAccess)) continue
      seen.add(tool.name)
      specs.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      })
    }
  }
  if (cacheKey) {
    // 防止长期运行的不同用户把缓存撑大：超过 1000 条时清掉过期项。
    if (specsCache.size > 1_000) {
      const now = Date.now()
      for (const [key, entry] of specsCache) {
        if (now - entry.at >= SPECS_CACHE_TTL_MS) specsCache.delete(key)
      }
    }
    specsCache.set(cacheKey, { at: Date.now(), value: specs })
  }
  return specs
}

/** 按模型给出的 function 名找当前员工可用的插件工具；默认公司实例优先 */
export function resolvePluginToolForActor(
  db: Db,
  actor: PluginToolActor,
  functionName: string,
  options: { preferPersonal?: boolean } = {},
): PluginToolRegistration | null {
  if (!actor.subject.scopes.has(SC.AGENT_TOOL_INVOKE)) return null
  const roleAccess = readToolRoleAccessMap(db, actor.subject.companyId)
  for (const instanceKey of actorInstanceKeys(db, actor, options.preferPersonal === true)) {
    const tool = toolsByInstance.get(instanceKey)?.get(functionName)
    if (tool && toolUsableForActor(db, tool, actor, roleAccess)) {
      return tool
    }
  }
  return null
}

/**
 * 按控制台目录 id 解析插件工具。
 *
 * 目录 id 形如 `plugin:<instanceKey>:<toolName>`，instanceKey 自身可能含冒号；
 * 不能像旧实现那样按第一个冒号拆成 pluginId + functionName。
 * 这里直接遍历当前员工可用实例，按完整目录 id 匹配，避免拆错和跨实例串工具。
 */
export function resolvePluginToolByCatalogId(
  db: Db, actor: PluginToolActor, catalogId: string,
): PluginToolRegistration | null {
  if (!actor.subject.scopes.has(SC.AGENT_TOOL_INVOKE)) return null
  const roleAccess = readToolRoleAccessMap(db, actor.subject.companyId)
  for (const instanceKey of actorInstanceKeys(db, actor)) {
    const tools = toolsByInstance.get(instanceKey)
    if (!tools) continue
    for (const tool of tools.values()) {
      if (`plugin:${instanceKey}:${tool.name}` !== catalogId) continue
      if (!toolUsableForActor(db, tool, actor, roleAccess)) continue
      return tool
    }
  }
  return null
}

export async function executePluginTool(
  tool: PluginToolRegistration,
  args: Record<string, unknown>,
  exec: Record<string, unknown>,
  options: PluginToolExecOptions = {},
): Promise<unknown> {
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? 4)
  const timeoutMs = Math.max(1, options.timeoutMs ?? 60_000)
  let release: (() => void) | null = null
  try {
    const lease = await acquireCoordinationSlot(`plugin:tool:${tool.instanceKey}`, {
      limit: maxConcurrent,
      ttlSec: 300,
      waitMs: 30_000,
      queueLimit: 50,
      signal: options.signal,
    })
    const inflight = beginToolInflight({
      toolId: `plugin:${tool.instanceKey.split(':').slice(-2).join(':')}`,
      channel: null,
    })
    release = () => {
      inflight.end()
      lease.release()
    }
  } catch (error) {
    if (error instanceof SemaphoreTimeoutError || error instanceof SemaphoreQueueFullError) {
      throw new EabError(EC.RATE_LIMITED, '插件工具并发已满，请稍后重试', {
        details: { pluginId: tool.pluginId, tool: tool.name },
      })
    }
    if (error instanceof LockAbortedError) throw new EabError(EC.CONFLICT, '操作已取消')
    throw error
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      Promise.resolve(tool.execute(args, exec)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new EabError(EC.UPSTREAM, `插件工具「${tool.name}」执行超时（${Math.round(timeoutMs / 1000)} 秒）`, {
              details: { pluginId: tool.pluginId, tool: tool.name, timeoutMs },
            }),
          )
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    release?.()
  }
}

/** 插件给系统提示的贡献；执行时会实时调用 text()，拿到插件当前配置 */
export function pluginPromptTexts(db: Db, actor: PluginToolActor): string[] {
  if (!actor.subject.scopes.has(SC.AGENT_TOOL_INVOKE)) return []
  const entries: Array<{ order: number; name: string; text: string }> = []
  for (const instanceKey of actorInstanceKeys(db, actor)) {
    const prompts = promptsByInstance.get(instanceKey)
    if (!prompts) continue
    for (const entry of prompts.values()) {
      let text = ''
      try {
        text = typeof entry.text === 'function' ? entry.text() : entry.text
      } catch {
        text = ''
      }
      if (text.trim()) entries.push({ order: entry.order, name: entry.name, text: text.trim() })
    }
  }
  return entries.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)).map((entry) => entry.text)
}

/** 控制台配置插件工具角色时，需要看到本公司的全部插件工具，而不只是控制台操作者本人安装的实例。 */
function companyInstanceKeys(companyId: string): string[] {
  const keys: string[] = []
  for (const [instanceKey, tools] of toolsByInstance) {
    for (const tool of tools.values()) {
      if (tool.companyId === companyId) {
        keys.push(instanceKey)
        break
      }
    }
  }
  return keys.sort((a, b) => a.localeCompare(b))
}

/** 控制台「工具」页可展示的插件工具清单；可按实例类型只看个人或公司 */
export function pluginToolCatalogFor(
  db: Db,
  actor: PluginToolActor,
  options: { scope?: 'company' | 'user'; allCompanyInstances?: boolean } = {},
): Array<{
  id: string
  pluginId: string
  name: string
  description: string
  personal: boolean
  available: boolean
  input: Record<string, unknown>
}> {
  const rows: Array<{
    id: string
    pluginId: string
    name: string
    description: string
    personal: boolean
    available: boolean
    input: Record<string, unknown>
  }> = []
  const roleAccess = readToolRoleAccessMap(db, actor.subject.companyId)
  const instanceKeys = options.allCompanyInstances
    ? companyInstanceKeys(actor.subject.companyId)
    : actorInstanceKeys(db, actor)
  for (const instanceKey of instanceKeys) {
    const tools = toolsByInstance.get(instanceKey)
    if (!tools) continue
    for (const tool of tools.values()) {
      if (options.scope && tool.scope.kind !== options.scope) continue
      // 个人插件工具只属于安装人本人：除他本人外，任何人的目录里都不出现（管理员后台也不展示）。
      if (tool.scope.kind === 'user' && tool.scope.userId !== actor.subject.userId) continue
      rows.push({
        id: `plugin:${tool.instanceKey}:${tool.name}`,
        pluginId: tool.pluginId,
        name: tool.name,
        description: tool.description,
        personal: tool.scope.kind === 'user',
        available:
          (tool.scope.kind === 'company' || tool.scope.userId === actor.subject.userId) &&
          actor.subject.scopes.has(SC.AGENT_TOOL_INVOKE) &&
          toolUsableForActor(db, tool, actor, roleAccess),
        input: tool.parameters,
      })
    }
  }
  return rows
}

/**
 * 共享模式下把插件工具并发数从 Redis 读回来（与工具那边同理）。
 * 未接 Redis 时返回 null，控制台继续显示本实例统计。
 */
export async function sharedPluginCapacityStats(): Promise<{
  total: number
  keys: Array<{ key: string; active: number; queued: number }>
} | null> {
  if (!coordinationStatus().shared) return null
  const keys = [...toolsByInstance.keys()].map((instanceKey) => `plugin:tool:${instanceKey}`)
  if (keys.length === 0) return { total: 0, keys: [] }
  const counts = await Promise.all(keys.map((key) => readCapacityCount(key)))
  if (counts.every((count) => count === null)) return null
  const entries = keys
    .map((key, index) => ({ key, active: counts[index] ?? 0, queued: 0 }))
    .filter((item) => item.active > 0)
  return {
    total: entries.reduce((sum, item) => sum + item.active, 0),
    keys: entries,
  }
}
