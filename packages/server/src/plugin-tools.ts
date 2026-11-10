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
import { SC } from '@eab/domain'

export interface PluginToolActor {
  readonly subject: {
    readonly companyId: string
    readonly userId: string
    readonly scopes: ReadonlySet<string>
  }
}

export interface PluginToolRegistration {
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

const toolsByPlugin = new Map<string, Map<string, PluginToolRegistration>>()
const promptsByPlugin = new Map<string, Map<string, PromptEntry>>()

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

function ownerOf(name: string): string | null {
  for (const [pluginId, tools] of toolsByPlugin) {
    if (tools.has(name)) return pluginId
  }
  return null
}

/** 注册一个插件工具；同名工具先到先得，后注册的返回空 disposer 并由宿主日志提醒 */
export function registerPluginTool(
  pluginId: string, nameOrDefinition: unknown, maybeDefinition?: unknown,
): { ok: boolean; name: string; dispose: () => void; reason?: string } {
  const parsed = definitionsOf(nameOrDefinition, maybeDefinition)
  if (!parsed) return { ok: false, name: '', dispose: () => undefined, reason: '工具定义缺少 name' }
  const name = safeToolName(parsed.name)
  if (!name) return { ok: false, name: '', dispose: () => undefined, reason: '工具名为空' }
  const definition = parsed.definition
  if (typeof definition.execute !== 'function') {
    return { ok: false, name, dispose: () => undefined, reason: '工具缺少 execute()' }
  }
  const existing = ownerOf(name)
  if (existing && existing !== pluginId) {
    return { ok: false, name, dispose: () => undefined, reason: `工具名已被插件 ${existing} 占用` }
  }
  const list = toolsByPlugin.get(pluginId) ?? new Map<string, PluginToolRegistration>()
  const registration: PluginToolRegistration = {
    pluginId,
    name,
    description: String(definition.description ?? definition.title ?? name),
    parameters: normalizeParameters(definition),
    execute: definition.execute as PluginToolRegistration['execute'],
  }
  list.set(name, registration)
  toolsByPlugin.set(pluginId, list)
  return {
    ok: true,
    name,
    dispose: () => {
      list.delete(name)
      if (list.size === 0) toolsByPlugin.delete(pluginId)
    },
  }
}

export function unregisterPluginTool(pluginId: string, name: unknown): void {
  const toolName = safeToolName(name)
  const list = toolsByPlugin.get(pluginId)
  if (!list) return
  list.delete(toolName)
  if (list.size === 0) toolsByPlugin.delete(pluginId)
}

/** 注册插件对系统提示的贡献（如「什么时候该发钉钉卡片」） */
export function registerPluginPrompt(pluginId: string, entry: unknown): void {
  if (!entry || typeof entry !== 'object') return
  const raw = entry as Record<string, unknown>
  const name = String(raw.name ?? '').trim()
  const text = raw.text
  if (!name || (typeof text !== 'string' && typeof text !== 'function')) return
  const list = promptsByPlugin.get(pluginId) ?? new Map<string, PromptEntry>()
  list.set(name, {
    name,
    order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : 100,
    text: text as string | (() => string),
  })
  promptsByPlugin.set(pluginId, list)
}

/** 插件卸载/停用/宿主重扫时调用，工具和提示一起摘掉 */
export function clearPluginContributions(pluginId: string): void {
  toolsByPlugin.delete(pluginId)
  promptsByPlugin.delete(pluginId)
}

function tableExists(db: Db, table: string): boolean {
  try {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
      | { name?: string }
      | undefined
    return row?.name === table
  } catch {
    return false
  }
}

/**
 * 当前公司/当前员工真正可用的插件 id：
 * 公司级安装且未卸载、且没有被公司级状态停用；或个人级安装且启用。
 * 任何一边都不要求目录还在——目录被删时 host 已重启，注册项也已被清空。
 */
export function enabledPluginIds(db: Db, actor: Pick<PluginToolActor, 'subject'>): Set<string> {
  const companyId = actor.subject.companyId
  const userId = actor.subject.userId
  const ids = new Set<string>()
  if (!tableExists(db, 'plugin_company_installs')) return ids
  try {
    const companyRows = db
      .prepare(
        `SELECT pci.plugin_id AS plugin_id
           FROM plugin_company_installs pci
          WHERE pci.company_id = ? AND pci.removed_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM plugin_states ps
               WHERE ps.company_id = pci.company_id AND ps.plugin_id = pci.plugin_id AND ps.enabled = 0
            )`,
      )
      .all(companyId) as unknown as Array<{ plugin_id: string }>
    for (const row of companyRows) if (row.plugin_id) ids.add(row.plugin_id)
    if (tableExists(db, 'plugin_user_installs')) {
      const userRows = db
        .prepare(
          `SELECT pui.plugin_id AS plugin_id FROM plugin_user_installs pui
            WHERE pui.company_id = ? AND pui.user_id = ? AND pui.removed_at IS NULL AND pui.enabled = 1
              AND NOT EXISTS (
                SELECT 1 FROM plugin_states ps
                 WHERE ps.company_id = pui.company_id AND ps.plugin_id = pui.plugin_id AND ps.enabled = 0
              )`,
        )
        .all(companyId, userId) as unknown as Array<{ plugin_id: string }>
      for (const row of userRows) if (row.plugin_id) ids.add(row.plugin_id)
    }
  } catch {
    return ids
  }
  return ids
}

export function pluginToolSpecsFor(db: Db, actor: PluginToolActor): Array<Record<string, unknown>> {
  if (!actor.subject.scopes.has(SC.AGENT_TOOL_INVOKE)) return []
  const enabled = enabledPluginIds(db, actor)
  const specs: Array<Record<string, unknown>> = []
  for (const pluginId of enabled) {
    const tools = toolsByPlugin.get(pluginId)
    if (!tools) continue
    for (const tool of tools.values()) {
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

/** 按模型给出的 function 名找当前员工可用的插件工具；重名/停用/未安装一律找不到 */
export function resolvePluginToolForActor(
  db: Db, actor: PluginToolActor, functionName: string,
): PluginToolRegistration | null {
  if (!actor.subject.scopes.has(SC.AGENT_TOOL_INVOKE)) return null
  const enabled = enabledPluginIds(db, actor)
  for (const pluginId of enabled) {
    const tool = toolsByPlugin.get(pluginId)?.get(functionName)
    if (tool) return tool
  }
  return null
}

export function executePluginTool(
  tool: PluginToolRegistration,
  args: Record<string, unknown>,
  exec: Record<string, unknown>,
): Promise<unknown> {
  return Promise.resolve(tool.execute(args, exec))
}

/** 插件给系统提示的贡献；执行时会实时调用 text()，拿到插件当前配置 */
export function pluginPromptTexts(db: Db, actor: PluginToolActor): string[] {
  if (!actor.subject.scopes.has(SC.AGENT_TOOL_INVOKE)) return []
  const enabled = enabledPluginIds(db, actor)
  const entries: Array<{ order: number; name: string; text: string }> = []
  for (const pluginId of enabled) {
    const prompts = promptsByPlugin.get(pluginId)
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

/** 控制台「工具」页可展示的插件工具清单 */
export function pluginToolCatalogFor(db: Db, actor: PluginToolActor): Array<{
  id: string
  pluginId: string
  name: string
  description: string
  available: boolean
  input: Record<string, unknown>
}> {
  const enabled = enabledPluginIds(db, actor)
  const rows: Array<{
    id: string
    pluginId: string
    name: string
    description: string
    available: boolean
    input: Record<string, unknown>
  }> = []
  for (const pluginId of enabled) {
    const tools = toolsByPlugin.get(pluginId)
    if (!tools) continue
    for (const tool of tools.values()) {
      rows.push({
        id: `plugin:${pluginId}:${tool.name}`,
        pluginId,
        name: tool.name,
        description: tool.description,
        available: actor.subject.scopes.has(SC.AGENT_TOOL_INVOKE),
        input: tool.parameters,
      })
    }
  }
  return rows
}
