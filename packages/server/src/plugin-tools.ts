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
import { listActorPluginInstances, pluginInstanceKey, type PluginScope } from './plugin-scope.js'

export interface PluginToolActor {
  readonly subject: {
    readonly companyId: string
    readonly userId: string
    readonly scopes: ReadonlySet<string>
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
  return {
    ok: true,
    name,
    dispose: () => {
      list.delete(name)
      if (list.size === 0) toolsByInstance.delete(instanceKey)
    },
  }
}

export function unregisterPluginTool(instanceKey: string, name: unknown): void {
  const toolName = safeToolName(name)
  const list = toolsByInstance.get(instanceKey)
  if (!list) return
  list.delete(toolName)
  if (list.size === 0) toolsByInstance.delete(instanceKey)
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
}

/**
 * 当前公司/当前员工真正可用的插件实例：
 * 公司级安装且未被公司级状态停用；或个人级安装且启用。
 * 个人实例排在前面：同名插件同时存在公司/个人安装时，个人配置和数据优先。
 */
function actorInstanceKeys(db: Db, actor: Pick<PluginToolActor, 'subject'>): string[] {
  const rows = listActorPluginInstances(db, actor.subject.companyId, actor.subject.userId)
    .sort((a, b) => {
      const aUser = a.scope.kind === 'user' ? 0 : 1
      const bUser = b.scope.kind === 'user' ? 0 : 1
      if (aUser !== bUser) return aUser - bUser
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

export function pluginToolSpecsFor(db: Db, actor: PluginToolActor): Array<Record<string, unknown>> {
  // 可见性策略：
  // - 个人实例只属于安装人：actorInstanceKeys 只并入当前 userId 的个人实例；
  // - 公司实例属于当前公司，但仍要求角色具备 `agent:tool:invoke`；
  // - 内置工具的可见性由 routes/tools.ts 按各工具自己的 scope 逐项判断。
  if (!actor.subject.scopes.has(SC.AGENT_TOOL_INVOKE)) return []
  const specs: Array<Record<string, unknown>> = []
  const seen = new Set<string>()
  for (const instanceKey of actorInstanceKeys(db, actor)) {
    const tools = toolsByInstance.get(instanceKey)
    if (!tools) continue
    for (const tool of tools.values()) {
      // 公司和个人实例可能暴露同名工具；function 名不能重复，个人实例先入列。
      if (seen.has(tool.name)) continue
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
  return specs
}

/** 按模型给出的 function 名找当前员工可用的插件工具；优先本人实例，再公司实例 */
export function resolvePluginToolForActor(
  db: Db, actor: PluginToolActor, functionName: string,
): PluginToolRegistration | null {
  if (!actor.subject.scopes.has(SC.AGENT_TOOL_INVOKE)) return null
  for (const instanceKey of actorInstanceKeys(db, actor)) {
    const tool = toolsByInstance.get(instanceKey)?.get(functionName)
    if (tool) return tool
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
    release = await pluginToolSemaphore.acquire(tool.instanceKey, {
      limit: maxConcurrent,
      queueLimit: 50,
      timeoutMs: 30_000,
      signal: options.signal,
    })
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

/** 控制台「工具」页可展示的插件工具清单；可按实例类型只看个人或公司 */
export function pluginToolCatalogFor(
  db: Db,
  actor: PluginToolActor,
  options: { scope?: 'company' | 'user' } = {},
): Array<{
  id: string
  pluginId: string
  name: string
  description: string
  available: boolean
  input: Record<string, unknown>
}> {
  const rows: Array<{
    id: string
    pluginId: string
    name: string
    description: string
    available: boolean
    input: Record<string, unknown>
  }> = []
  for (const instanceKey of actorInstanceKeys(db, actor)) {
    const tools = toolsByInstance.get(instanceKey)
    if (!tools) continue
    for (const tool of tools.values()) {
      if (options.scope && tool.scope.kind !== options.scope) continue
      rows.push({
        id: `plugin:${tool.instanceKey}:${tool.name}`,
        pluginId: tool.pluginId,
        name: tool.name,
        description: tool.description,
        available: actor.subject.scopes.has(SC.AGENT_TOOL_INVOKE),
        input: tool.parameters,
      })
    }
  }
  return rows
}
