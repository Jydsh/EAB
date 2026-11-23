/**
 * MCP Server 注册表与工具目录。
 *
 * 边界：
 * - `mcp_servers` / `mcp_tools` 是公司级配置，跨公司不共享；
 * - 第一版只暴露 MCP `readOnlyHint = true` 且未被管理员白名单排除的工具；
 * - function 名统一生成 `mcp_<serverSlug>_<toolSlug>`，工具 id 为 `mcp:<serverId>:<toolName>`；
 * - 工具目录不写进内置 `TOOLS`，由 `toolSpecsForActor` 追加，`tool_search` 命中后才加载完整 schema；
 * - 调用失败连续 3 次熔断 60 秒；同步失败保留旧目录，只标记 degraded。
 */
import { createHash } from 'node:crypto'
import { EC, EabError, SC, ulid } from '@eab/domain'
import { appendAudit, type Db } from '@eab/storage'
import type { ToolParameterSchema } from './llm.js'
import { deleteSecret, resolveSecret, secretConfigured, storeSecret } from './secrets.js'
import { acquireCoordinationSlot } from './backends/coordination.js'
import { SemaphoreQueueFullError, SemaphoreTimeoutError } from './concurrency.js'
import { beginToolInflight } from './tool-inflight.js'
import { readToolRoleAccessMap, toolAllowedForRoles } from './tool-role-access.js'
import {
  callMcpTool,
  listMcpTools,
  normalizeMcpEndpoint,
  type McpRemoteTool,
  type McpTransport,
} from './mcp-client.js'

export type McpHealth = 'healthy' | 'degraded' | 'offline' | 'unknown'
export type McpAuthType = 'none' | 'bearer' | 'header'

export interface McpActor {
  readonly subject: {
    readonly companyId: string
    readonly userId: string
    readonly scopes: ReadonlySet<string>
    readonly roles?: readonly string[]
  }
}

export interface McpServerConfig {
  readonly id: string
  readonly companyId: string
  readonly name: string
  readonly transport: McpTransport
  readonly endpoint: string
  readonly authType: McpAuthType
  readonly secretRef: string
  readonly allowedTools: readonly string[]
  readonly enabled: boolean
  readonly health: McpHealth
  readonly lastSyncAt: number | null
  readonly lastError: string
  readonly failureCount: number
  readonly cooldownUntil: number | null
  readonly createdBy: string
  readonly createdAt: number
  readonly updatedAt: number
}

export interface McpToolRecord {
  readonly id: string
  readonly serverId: string
  readonly companyId: string
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly annotations: Record<string, unknown>
  readonly enabled: boolean
  readonly syncedAt: number
}

export interface McpToolView extends McpToolRecord {
  readonly functionName: string
  readonly readOnly: boolean
  readonly destructive: boolean
}

export interface McpServerView extends McpServerConfig {
  readonly secretConfigured: boolean
  readonly tools: McpToolView[]
  readonly toolCount: number
  readonly readOnlyToolCount: number
}

export interface McpToolSpec {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, ToolParameterSchema>
      required: string[]
      additionalProperties: false
    }
  }
}

export interface McpCatalogEntry {
  readonly server: McpServerConfig
  readonly tool: McpToolRecord
  readonly functionName: string
  readonly toolId: string
  readonly spec: McpToolSpec
}

export interface McpSyncOutcome {
  readonly ok: boolean
  readonly toolCount: number
  readonly readOnlyToolCount: number
  readonly error: string
}

interface McpServerRow {
  id: string
  company_id: string
  name: string
  transport: string
  endpoint: string
  auth_type: string
  secret_ref: string
  allowed_tools_json: string
  enabled: number
  health: string
  last_sync_at: number | null
  last_error: string
  failure_count: number
  cooldown_until: number | null
  created_by: string
  created_at: number
  updated_at: number
}

interface McpToolRow {
  id: string
  server_id: string
  company_id: string
  name: string
  description: string
  input_schema_json: string
  annotations_json: string
  enabled: number
  synced_at: number
}

const HEALTH_VALUES = new Set<McpHealth>(['healthy', 'degraded', 'offline', 'unknown'])
const AUTH_VALUES = new Set<McpAuthType>(['none', 'bearer', 'header'])
const MAX_SYNC_TOOLS = 1_000
const MAX_RESULT_BYTES = 200 * 1024

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.map((value) => String(value ?? '').trim()).filter(Boolean)
  } catch {
    return []
  }
}

function healthOf(raw: string): McpHealth {
  return HEALTH_VALUES.has(raw as McpHealth) ? (raw as McpHealth) : 'unknown'
}

function authOf(raw: string): McpAuthType {
  return AUTH_VALUES.has(raw as McpAuthType) ? (raw as McpAuthType) : 'none'
}

function transportOf(raw: string): McpTransport {
  return raw === 'stdio' || raw === 'sse' || raw === 'http' ? raw : 'http'
}

function toServer(row: McpServerRow): McpServerConfig {
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    transport: transportOf(row.transport),
    endpoint: row.endpoint,
    authType: authOf(row.auth_type),
    secretRef: row.secret_ref,
    allowedTools: parseStringArray(row.allowed_tools_json),
    enabled: Number(row.enabled) === 1,
    health: healthOf(row.health),
    lastSyncAt: row.last_sync_at === null ? null : Number(row.last_sync_at),
    lastError: row.last_error,
    failureCount: Number(row.failure_count),
    cooldownUntil: row.cooldown_until === null ? null : Number(row.cooldown_until),
    createdBy: row.created_by,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function toTool(row: McpToolRow): McpToolRecord {
  return {
    id: row.id,
    serverId: row.server_id,
    companyId: row.company_id,
    name: row.name,
    description: row.description,
    inputSchema: parseJsonObject(row.input_schema_json),
    annotations: parseJsonObject(row.annotations_json),
    enabled: Number(row.enabled) === 1,
    syncedAt: Number(row.synced_at),
  }
}

function safeSlug(raw: string): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function shortHash(raw: string): string {
  return createHash('sha1').update(raw).digest('hex').slice(0, 6)
}

/** OpenAI function 名限制 64 字符；名称 hash 让同名 Server、工具重名和中文名也保持稳定且不冲突。 */
export function mcpToolFunctionName(serverName: string, toolName: string, serverId = ''): string {
  const serverSlug = safeSlug(serverName).slice(0, 12) || `s_${shortHash(serverName)}`
  const serverTag = shortHash(serverId || serverName)
  const toolSlug = safeSlug(toolName).slice(0, 30) || `t_${shortHash(toolName)}`
  const toolTag = shortHash(`${serverId}:${toolName}`)
  return `mcp_${serverSlug}_${serverTag}_${toolSlug}_${toolTag}`.slice(0, 64)
}

function readOnly(tool: McpToolRecord): boolean {
  return tool.annotations.readOnlyHint === true
}

function destructive(tool: McpToolRecord): boolean {
  return tool.annotations.destructiveHint === true
}

function sanitizeParameter(raw: unknown, depth = 0): ToolParameterSchema {
  if (depth > 5 || !raw || typeof raw !== 'object' || Array.isArray(raw)) return { type: 'string' }
  const record = raw as Record<string, unknown>
  const allowedTypes = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object'])
  const type = typeof record.type === 'string' && allowedTypes.has(record.type) ? record.type : 'string'
  const schema: ToolParameterSchema = { type }
  if (typeof record.description === 'string' && record.description.trim()) {
    schema.description = record.description.trim().slice(0, 300)
  }
  if (Array.isArray(record.enum)) {
    const values = record.enum.map(String).filter(Boolean)
    if (values.length > 0) schema.enum = values
  }
  if (type === 'array' && record.items && typeof record.items === 'object') {
    schema.items = sanitizeParameter(record.items, depth + 1)
  }
  if (type === 'object' && record.properties && typeof record.properties === 'object' && !Array.isArray(record.properties)) {
    const properties: Record<string, ToolParameterSchema> = {}
    for (const [key, value] of Object.entries(record.properties as Record<string, unknown>)) {
      if (!key) continue
      properties[key] = sanitizeParameter(value, depth + 1)
    }
    schema.properties = properties
    if (Array.isArray(record.required)) schema.required = record.required.map(String).filter(Boolean)
  }
  if (Number.isFinite(Number(record.minItems))) schema.minItems = Number(record.minItems)
  if (Number.isFinite(Number(record.maxItems))) schema.maxItems = Number(record.maxItems)
  return schema
}

/** MCP 的 inputSchema 是 JSON Schema；这里只保留模型工具声明支持的结构，避免未知字段破坏协议。 */
export function normalizeMcpInputSchema(raw: Record<string, unknown>): McpToolSpec['function']['parameters'] {
  const properties: Record<string, ToolParameterSchema> = {}
  if (raw.properties && typeof raw.properties === 'object' && !Array.isArray(raw.properties)) {
    for (const [key, value] of Object.entries(raw.properties as Record<string, unknown>)) {
      if (!key) continue
      properties[key] = sanitizeParameter(value)
    }
  }
  return {
    type: 'object',
    properties,
    required: Array.isArray(raw.required) ? raw.required.map(String).filter(Boolean) : [],
    additionalProperties: false,
  }
}

function toolSpec(server: McpServerConfig, tool: McpToolRecord, functionName: string): McpToolSpec {
  const description = `[MCP · ${server.name}] ${tool.description || tool.name}`.slice(0, 1_024)
  return {
    type: 'function',
    function: {
      name: functionName,
      description,
      parameters: normalizeMcpInputSchema(tool.inputSchema),
    },
  }
}

function authHeaders(server: McpServerConfig, dbPath: string): Record<string, string> {
  if (server.authType === 'none') return {}
  const secret = resolveSecret(dbPath, server.secretRef)
  if (!secret) {
    throw new EabError(EC.FORBIDDEN, `MCP Server「${server.name}」缺少凭证`, {
      hint: '在控制台重新保存该 Server 的密钥，或配置对应的环境变量',
    })
  }
  if (server.authType === 'bearer') return { authorization: `Bearer ${secret}` }
  const match = /^([A-Za-z0-9-]+)\s*:\s*(.+)$/.exec(secret)
  if (!match) {
    throw new EabError(EC.VALIDATION, `MCP Server「${server.name}」的 header 凭证格式不正确`, {
      hint: 'header 凭证应保存为「Header-Name: 值」',
    })
  }
  return { [match[1].toLowerCase()]: match[2].trim() }
}

function endpointInput(raw: unknown): string {
  return normalizeMcpEndpoint(String(raw ?? ''))
}

function nameInput(raw: unknown): string {
  const name = String(raw ?? '').trim()
  if (!name) throw new EabError(EC.VALIDATION, 'MCP Server 名称不能为空')
  if (name.length > 64) throw new EabError(EC.VALIDATION, 'MCP Server 名称不能超过 64 个字符')
  return name
}

function transportInput(raw: unknown): McpTransport {
  const transport = String(raw ?? 'http').trim().toLowerCase()
  if (transport === 'stdio') {
    throw new EabError(EC.VALIDATION, '第一版 MCP 适配不启动本地 stdio 进程，请使用 http 或 sse 传输')
  }
  if (transport !== 'http' && transport !== 'sse') {
    throw new EabError(EC.VALIDATION, 'MCP 传输只支持 http 或 sse')
  }
  return transport
}

function authTypeInput(raw: unknown): McpAuthType {
  const type = String(raw ?? 'none').trim().toLowerCase()
  if (!AUTH_VALUES.has(type as McpAuthType)) {
    throw new EabError(EC.VALIDATION, 'MCP 鉴权方式只支持 none / bearer / header')
  }
  return type as McpAuthType
}

function allowedToolsInput(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.map((value) => String(value ?? '').trim()).filter(Boolean))].slice(0, 200)
}

function missingMcpTable(error: unknown): boolean {
  return /no such table: mcp_(servers|tools)/.test(error instanceof Error ? error.message : String(error))
}

export function listMcpServers(db: Db, companyId: string): McpServerConfig[] {
  try {
    const rows = db
      .prepare('SELECT * FROM mcp_servers WHERE company_id = ? ORDER BY updated_at DESC, name ASC')
      .all(companyId) as unknown as McpServerRow[]
    return rows.map(toServer)
  } catch (error) {
    // 迁移尚未跑完或嵌入式调用只建了部分表时，MCP 目录按空处理，不影响原有工具。
    if (missingMcpTable(error)) return []
    throw error
  }
}

export function getMcpServer(db: Db, companyId: string, id: string): McpServerConfig | null {
  const row = db
    .prepare('SELECT * FROM mcp_servers WHERE company_id = ? AND id = ? LIMIT 1')
    .get(companyId, id) as McpServerRow | undefined
  return row ? toServer(row) : null
}

export function listMcpToolsForServer(db: Db, serverId: string): McpToolRecord[] {
  try {
    const rows = db
      .prepare('SELECT * FROM mcp_tools WHERE server_id = ? ORDER BY name ASC')
      .all(serverId) as unknown as McpToolRow[]
    return rows.map(toTool)
  } catch (error) {
    if (missingMcpTable(error)) return []
    throw error
  }
}

function toolsView(server: McpServerConfig, tools: McpToolRecord[]): McpToolView[] {
  return tools.map((tool) => ({
    ...tool,
    functionName: mcpToolFunctionName(server.name, tool.name, server.id),
    readOnly: readOnly(tool),
    destructive: destructive(tool),
  }))
}

function serverView(db: Db, dbPath: string, server: McpServerConfig): McpServerView {
  const tools = toolsView(server, listMcpToolsForServer(db, server.id))
  return {
    ...server,
    secretConfigured: server.authType === 'none' ? false : secretConfigured(dbPath, server.secretRef),
    tools,
    toolCount: tools.length,
    readOnlyToolCount: tools.filter((tool) => tool.readOnly).length,
  }
}

export function listMcpCatalogView(db: Db, dbPath: string, companyId: string): McpServerView[] {
  return listMcpServers(db, companyId).map((server) => serverView(db, dbPath, server))
}

export function getMcpServerView(db: Db, dbPath: string, companyId: string, id: string): McpServerView {
  const server = getMcpServer(db, companyId, id)
  if (!server) throw new EabError(EC.NOT_FOUND, `MCP Server 不存在：${id}`)
  return serverView(db, dbPath, server)
}

export interface McpServerInput {
  readonly name?: unknown
  readonly transport?: unknown
  readonly endpoint?: unknown
  readonly authType?: unknown
  readonly secret?: unknown
  readonly secretRef?: unknown
  readonly clearSecret?: unknown
  readonly allowedTools?: unknown
  readonly enabled?: unknown
}

function writeSecretIfPresent(
  dbPath: string,
  currentRef: string,
  input: McpServerInput,
  name: string,
): string {
  const secret = typeof input.secret === 'string' ? input.secret.trim() : ''
  if (secret) {
    return storeSecret(dbPath, typeof input.secretRef === 'string' ? input.secretRef.trim() : '', secret, `MCP_${safeSlug(name).toUpperCase() || 'TOKEN'}`)
  }
  if (input.clearSecret === true) {
    deleteSecret(dbPath, currentRef)
    return ''
  }
  return currentRef || (typeof input.secretRef === 'string' ? input.secretRef.trim() : '')
}

export function createMcpServer(
  db: Db,
  dbPath: string,
  companyId: string,
  createdBy: string,
  input: McpServerInput,
): McpServerConfig {
  const name = nameInput(input.name)
  const transport = transportInput(input.transport)
  const endpoint = endpointInput(input.endpoint)
  const authType = authTypeInput(input.authType)
  const allowedTools = allowedToolsInput(input.allowedTools)
  const enabled = input.enabled === false || input.enabled === 0 || input.enabled === '0' ? 0 : 1
  const now = Date.now()
  const id = ulid()
  const secretRef = writeSecretIfPresent(dbPath, '', input, name)
  try {
    db.prepare(`INSERT INTO mcp_servers
      (id, company_id, name, transport, endpoint, auth_type, secret_ref, allowed_tools_json, enabled, health, last_sync_at, last_error, failure_count, cooldown_until, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', NULL, '', 0, NULL, ?, ?, ?)`)
      .run(
        id, companyId, name, transport, endpoint, authType, secretRef,
        JSON.stringify(allowedTools), enabled, createdBy, now, now,
      )
  } catch (error) {
    if (String(error instanceof Error ? error.message : error).includes('UNIQUE')) {
      throw new EabError(EC.VALIDATION, `公司里已有同名的 MCP Server：${name}`)
    }
    throw error
  }
  const server = getMcpServer(db, companyId, id)
  if (!server) throw new EabError(EC.INTERNAL, 'MCP Server 保存后读取失败')
  return server
}

export function updateMcpServer(
  db: Db,
  dbPath: string,
  companyId: string,
  id: string,
  input: McpServerInput,
): McpServerConfig {
  const current = getMcpServer(db, companyId, id)
  if (!current) throw new EabError(EC.NOT_FOUND, `MCP Server 不存在：${id}`)
  const name = input.name === undefined ? current.name : nameInput(input.name)
  const transport = input.transport === undefined ? current.transport : transportInput(input.transport)
  const endpoint = input.endpoint === undefined ? current.endpoint : endpointInput(input.endpoint)
  const authType = input.authType === undefined ? current.authType : authTypeInput(input.authType)
  const allowedTools = input.allowedTools === undefined ? [...current.allowedTools] : allowedToolsInput(input.allowedTools)
  const enabled = input.enabled === undefined
    ? (current.enabled ? 1 : 0)
    : (input.enabled === false || input.enabled === 0 || input.enabled === '0' ? 0 : 1)
  const secretRef = writeSecretIfPresent(dbPath, current.secretRef, input, name)
  const now = Date.now()
  try {
    db.prepare(`UPDATE mcp_servers SET
      name = ?, transport = ?, endpoint = ?, auth_type = ?, secret_ref = ?, allowed_tools_json = ?,
      enabled = ?, health = ?, updated_at = ?
      WHERE company_id = ? AND id = ?`)
      .run(
        name, transport, endpoint, authType, secretRef, JSON.stringify(allowedTools),
        enabled, enabled === 0 ? 'offline' : (current.enabled ? current.health : 'unknown'), now, companyId, id,
      )
  } catch (error) {
    if (String(error instanceof Error ? error.message : error).includes('UNIQUE')) {
      throw new EabError(EC.VALIDATION, `公司里已有同名的 MCP Server：${name}`)
    }
    throw error
  }
  const server = getMcpServer(db, companyId, id)
  if (!server) throw new EabError(EC.INTERNAL, 'MCP Server 更新后读取失败')
  return server
}

export function deleteMcpServer(db: Db, dbPath: string, companyId: string, id: string): McpServerConfig {
  const server = getMcpServer(db, companyId, id)
  if (!server) throw new EabError(EC.NOT_FOUND, `MCP Server 不存在：${id}`)
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM mcp_tools WHERE company_id = ? AND server_id = ?').run(companyId, id)
    db.prepare('DELETE FROM mcp_servers WHERE company_id = ? AND id = ?').run(companyId, id)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  deleteSecret(dbPath, server.secretRef)
  return server
}

function markSyncFailure(db: Db, server: McpServerConfig, error: string): void {
  const message = error.slice(0, 500)
  db.prepare(`UPDATE mcp_servers SET health = 'degraded', last_error = ?, failure_count = failure_count + 1, updated_at = ?
    WHERE company_id = ? AND id = ?`)
    .run(message, Date.now(), server.companyId, server.id)
}

/**
 * 同步 `tools/list`：
 * - 成功时整体替换该 Server 的工具目录，并清空失败/熔断状态；
 * - 失败时不动旧目录，只把 Server 标记为 degraded，便于管理端看到原因。
 */
export async function syncMcpServer(
  db: Db,
  dbPath: string,
  companyId: string,
  id: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<McpSyncOutcome> {
  const server = getMcpServer(db, companyId, id)
  if (!server) throw new EabError(EC.NOT_FOUND, `MCP Server 不存在：${id}`)
  try {
    const headers = authHeaders(server, dbPath)
    const listed = await listMcpTools(
      { endpoint: server.endpoint, transport: server.transport, headers, timeoutMs: options.timeoutMs },
      options.signal,
    )
    if (listed.tools.length > MAX_SYNC_TOOLS) {
      throw new EabError(EC.UPSTREAM, `MCP Server「${server.name}」工具过多（${listed.tools.length}），上限 ${MAX_SYNC_TOOLS}`)
    }
    const now = Date.now()
    const rows = listed.tools.map((tool: McpRemoteTool) => {
      const isReadOnly = tool.annotations.readOnlyHint === true
      const isDestructive = tool.annotations.destructiveHint === true
      const whitelisted = server.allowedTools.length === 0 || server.allowedTools.includes(tool.name)
      return {
        id: ulid(),
        name: tool.name.slice(0, 128),
        description: tool.description.slice(0, 1_024),
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
        enabled: isReadOnly && !isDestructive && whitelisted,
        readOnly: isReadOnly,
      }
    })
    db.exec('BEGIN')
    try {
      db.prepare('DELETE FROM mcp_tools WHERE company_id = ? AND server_id = ?').run(companyId, server.id)
      const insert = db.prepare(`INSERT INTO mcp_tools
        (id, server_id, company_id, name, description, input_schema_json, annotations_json, enabled, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      for (const row of rows) {
        insert.run(
          row.id, server.id, companyId, row.name, row.description,
          JSON.stringify(row.inputSchema), JSON.stringify(row.annotations), row.enabled ? 1 : 0, now,
        )
      }
      db.prepare(`UPDATE mcp_servers SET health = 'healthy', last_sync_at = ?, last_error = '',
        failure_count = 0, cooldown_until = NULL, updated_at = ?
        WHERE company_id = ? AND id = ?`)
        .run(now, now, companyId, server.id)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    const tools = listMcpToolsForServer(db, server.id)
    return {
      ok: true,
      toolCount: tools.length,
      readOnlyToolCount: tools.filter((tool) => readOnly(tool) && !destructive(tool)).length,
      error: '',
    }
  } catch (error) {
    const message = error instanceof EabError ? error.message : (error instanceof Error ? error.message : String(error))
    markSyncFailure(db, server, message)
    return { ok: false, toolCount: listMcpToolsForServer(db, server.id).length, readOnlyToolCount: 0, error: message }
  }
}

/**
 * 构造当前员工可见的 MCP 工具目录。
 * 只读过滤、白名单、启用状态、health、熔断冷却和角色白名单都在这里统一处理。
 */
export function buildMcpCatalog(db: Db, companyId: string, actor?: McpActor): McpCatalogEntry[] {
  const now = Date.now()
  const roleAccess = actor ? readToolRoleAccessMap(db, companyId) : new Map()
  const entries: McpCatalogEntry[] = []
  for (const server of listMcpServers(db, companyId)) {
    if (!server.enabled || server.health === 'offline' || server.health === 'unknown') continue
    if (server.cooldownUntil !== null && server.cooldownUntil > now) continue
    for (const tool of listMcpToolsForServer(db, server.id)) {
      if (!tool.enabled || !readOnly(tool) || destructive(tool)) continue
      if (server.allowedTools.length > 0 && !server.allowedTools.includes(tool.name)) continue
      const toolId = `mcp:${server.id}:${tool.name}`
      if (actor) {
        if (!actor.subject.scopes.has(SC.AGENT_TOOL_INVOKE)) continue
        if (!toolAllowedForRoles(roleAccess.get(toolId), actor.subject.roles ?? [], true)) continue
      }
      const functionName = mcpToolFunctionName(server.name, tool.name, server.id)
      entries.push({
        server,
        tool,
        functionName,
        toolId,
        spec: toolSpec(server, tool, functionName),
      })
    }
  }
  return entries
}

export function mcpToolSpecsFor(db: Db, actor: McpActor): McpToolSpec[] {
  return buildMcpCatalog(db, actor.subject.companyId, actor).map((entry) => entry.spec)
}

export function resolveMcpToolForActor(
  db: Db,
  actor: McpActor,
  functionName: string,
): McpCatalogEntry | null {
  const clean = String(functionName ?? '').trim()
  if (!clean) return null
  return buildMcpCatalog(db, actor.subject.companyId, actor)
    .find((entry) => entry.functionName === clean) ?? null
}

function truncateText(text: string, limit = 20_000): string {
  return text.length > limit ? `${text.slice(0, limit)}…（已截断）` : text
}

/** MCP 结果可能是文本块、图片、资源引用；这里只限制体积，不改写结构。 */
export function boundMcpToolResult(result: unknown, maxBytes = MAX_RESULT_BYTES): unknown {
  let text: string
  try {
    text = JSON.stringify(result)
  } catch {
    text = String(result)
  }
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return result
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>
    if (Array.isArray(record.content)) {
      const content = record.content.slice(0, 40).map((item) => {
        if (!item || typeof item !== 'object') return item
        const part = item as Record<string, unknown>
        return typeof part.text === 'string' ? { ...part, text: truncateText(part.text) } : part
      })
      return { ...record, content, truncated: true, originalBytes: Buffer.byteLength(text, 'utf8') }
    }
  }
  return {
    truncated: true,
    originalBytes: Buffer.byteLength(text, 'utf8'),
    preview: text.slice(0, 50_000),
    note: 'MCP 工具结果过大，已截断；如需完整内容请缩小查询范围。',
  }
}

function mcpErrorText(result: unknown): string {
  if (!result || typeof result !== 'object') return 'MCP 工具返回错误'
  const record = result as Record<string, unknown>
  if (Array.isArray(record.content)) {
    const text = record.content
      .map((item) => (item && typeof item === 'object' ? String((item as Record<string, unknown>).text ?? '') : ''))
      .filter(Boolean)
      .join(' ')
    if (text.trim()) return text.trim().slice(0, 500)
  }
  return 'MCP 工具返回错误'
}

function markCallFailure(db: Db, server: McpServerConfig, error: string): void {
  const current = getMcpServer(db, server.companyId, server.id)
  if (!current) return
  const count = current.failureCount + 1
  const cooldown = count >= 3 ? Date.now() + 60_000 : current.cooldownUntil
  db.prepare(`UPDATE mcp_servers SET health = 'degraded', failure_count = ?, cooldown_until = ?, last_error = ?, updated_at = ?
    WHERE company_id = ? AND id = ?`)
    .run(count, cooldown, error.slice(0, 500), Date.now(), server.companyId, server.id)
}

function markCallSuccess(db: Db, server: McpServerConfig): void {
  db.prepare(`UPDATE mcp_servers SET health = 'healthy', failure_count = 0, cooldown_until = NULL, last_error = '', updated_at = ?
    WHERE company_id = ? AND id = ?`)
    .run(Date.now(), server.companyId, server.id)
}

export interface ExecuteMcpToolInput {
  readonly db: Db
  readonly dbPath: string
  readonly actor: McpActor
  readonly functionName: string
  readonly args: Record<string, unknown>
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly channel?: string | null
}

/** 从聊天工具循环调用 MCP 工具；返回值直接作为工具结果进入模型上下文。 */
export async function executeMcpToolForActor(input: ExecuteMcpToolInput): Promise<unknown> {
  const entry = resolveMcpToolForActor(input.db, input.actor, input.functionName)
  if (!entry) throw new EabError(EC.NOT_FOUND, `MCP 工具未对当前员工或公司开放: ${input.functionName}`)
  const { server, tool, toolId } = entry
  const endpoint = normalizeMcpEndpoint(server.endpoint)
  const headers = authHeaders(server, input.dbPath)
  const timeoutMs = Math.min(120_000, Math.max(1_000, input.timeoutMs ?? 30_000))
  let release: (() => void) | null = null
  try {
    const lease = await acquireCoordinationSlot(`mcp:${server.id}`, {
      limit: 4,
      ttlSec: 300,
      waitMs: timeoutMs,
      queueLimit: 50,
      signal: input.signal,
    })
    const inflight = beginToolInflight({ toolId, channel: input.channel ?? null })
    release = () => {
      inflight.end()
      lease.release()
    }
  } catch (error) {
    if (error instanceof SemaphoreTimeoutError) {
      throw new EabError(EC.RATE_LIMITED, 'MCP Server 并发已满，等待超时', {
        details: { serverId: server.id, timeoutMs: (error as { timeoutMs?: number }).timeoutMs ?? timeoutMs },
      })
    }
    if (error instanceof SemaphoreQueueFullError) {
      throw new EabError(EC.RATE_LIMITED, 'MCP Server 排队已满，请稍后重试', { details: { serverId: server.id } })
    }
    throw error
  }

  const startedAt = Date.now()
  let callResult: unknown
  try {
    const response = await callMcpTool(
      { endpoint, transport: server.transport, headers, timeoutMs, signal: input.signal },
      tool.name,
      input.args,
      input.signal,
    )
    callResult = response.result
  } catch (error) {
    const message = error instanceof EabError ? error.message : (error instanceof Error ? error.message : String(error))
    markCallFailure(input.db, server, message)
    appendAudit(input.db, {
      companyId: server.companyId,
      actorUserId: input.actor.subject.userId,
      action: 'mcp.tool.call',
      resourceType: 'mcp_tool',
      resourceId: toolId,
      result: 'failure',
      detail: {
        server: server.name,
        tool: tool.name,
        durationMs: Date.now() - startedAt,
        error: message.slice(0, 300),
      },
      channel: input.channel ?? 'chat',
    })
    throw error
  } finally {
    release?.()
  }

  const isErrorResult = Boolean(
    callResult && typeof callResult === 'object'
    && (callResult as Record<string, unknown>).isError === true,
  )
  if (isErrorResult) {
    const message = mcpErrorText(callResult)
    appendAudit(input.db, {
      companyId: server.companyId,
      actorUserId: input.actor.subject.userId,
      action: 'mcp.tool.call',
      resourceType: 'mcp_tool',
      resourceId: toolId,
      result: 'failure',
      detail: { server: server.name, tool: tool.name, durationMs: Date.now() - startedAt, error: message.slice(0, 300) },
      channel: input.channel ?? 'chat',
    })
    throw new EabError(EC.UPSTREAM, `MCP 工具「${tool.name}」返回错误：${message}`, {
      details: { serverId: server.id, toolName: tool.name },
    })
  }

  markCallSuccess(input.db, server)
  appendAudit(input.db, {
    companyId: server.companyId,
    actorUserId: input.actor.subject.userId,
    action: 'mcp.tool.call',
    resourceType: 'mcp_tool',
    resourceId: toolId,
    result: 'success',
    detail: { server: server.name, tool: tool.name, durationMs: Date.now() - startedAt },
    channel: input.channel ?? 'chat',
  })
  return boundMcpToolResult(callResult)
}
