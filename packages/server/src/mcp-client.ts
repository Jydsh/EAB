/**
 * MCP 传输客户端（JSON-RPC 2.0）。
 *
 * 第一版只做 MCP Client 的 HTTP / SSE 传输：
 * - 一次连接固定为 `initialize` → `notifications/initialized` → `tools/list` 或 `tools/call`；
 * - 响应既支持普通 JSON，也支持 `text/event-stream` 的 `data:` 事件；
 * - Server 返回 `mcp-session-id` 时，后续请求原样带回；
 * - 端点由管理员在控制台登记，属于可信配置，因此不走网页抓取的公网限制；
 * - 但只允许 http/https，且拒绝 URL 里带账号密码或 hash。
 *
 * 这里只负责协议，不做权限、只读过滤、熔断和审计；这些在 `mcp-registry.ts`。
 */
import { EC, EabError } from '@eab/domain'

export type McpTransport = 'http' | 'sse' | 'stdio'

export interface McpHttpTarget {
  readonly endpoint: string
  readonly transport: McpTransport
  readonly headers?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
  readonly maxBytes?: number
  readonly signal?: AbortSignal
}

export interface McpRemoteTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly annotations: Record<string, unknown>
}

export interface McpInitializeResult {
  readonly sessionId: string
  readonly protocolVersion: string
  readonly serverInfo: Record<string, unknown>
  readonly capabilities: Record<string, unknown>
}

interface JsonRpcMessage {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: unknown
  result?: unknown
  error?: unknown
}

let nextRequestId = 1

/** 管理员填的地址可能是 base URL，也可能是完整的 `/mcp` 路径；原样使用，不做猜测。 */
export function normalizeMcpEndpoint(raw: string): string {
  const text = String(raw ?? '').trim()
  if (!text) throw new EabError(EC.VALIDATION, 'MCP Server 地址不能为空')
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new EabError(EC.VALIDATION, 'MCP Server 地址格式不正确', { hint: '填写完整的 http/https 地址' })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new EabError(EC.VALIDATION, 'MCP Server 只支持 http/https 地址')
  }
  if (url.username || url.password) {
    throw new EabError(EC.VALIDATION, 'MCP Server 地址不能包含账号密码，凭证请单独登记')
  }
  url.hash = ''
  return url.href
}

function timeoutError(timeoutMs: number): EabError {
  return new EabError(EC.UPSTREAM, `MCP Server 请求超时（${Math.round(timeoutMs / 1000)} 秒）`, {
    hint: '检查 MCP Server 是否在线，或稍后重试',
  })
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new EabError(EC.UPSTREAM, `MCP Server ${label}不是合法 JSON`, {
      hint: '确认该地址是 MCP Streamable HTTP / SSE 端点，而不是普通网页',
    })
  }
}

function pickRpcMessage(payload: unknown, id: number): JsonRpcMessage | null {
  if (Array.isArray(payload)) {
    for (const item of payload) {
      if (item && typeof item === 'object' && Number((item as JsonRpcMessage).id) === id) {
        return item as JsonRpcMessage
      }
    }
    return null
  }
  if (payload && typeof payload === 'object') {
    const message = payload as JsonRpcMessage
    if (message.id === undefined || Number(message.id) === id) return message
  }
  return null
}

/** 从 SSE 响应里取出 JSON-RPC 消息；一个 POST 可能返回多条事件，只取当前请求 id。 */
function parseSsePayload(text: string, id: number): JsonRpcMessage | null {
  let dataLines: string[] = []
  let candidate: JsonRpcMessage | null = null
  const flush = () => {
    if (dataLines.length === 0) return
    const data = dataLines.join('\n').trim()
    dataLines = []
    if (!data || data === '[DONE]') return
    const parsed = parseJson(data, '事件')
    const message = pickRpcMessage(parsed, id)
    if (message) candidate = message
  }
  for (const line of text.split(/\r?\n/)) {
    if (line === '') {
      flush()
      continue
    }
    if (line.startsWith(':')) continue
    const match = /^data:(.*)$/.exec(line)
    if (match) dataLines.push(match[1].replace(/^\s/, ''))
  }
  flush()
  return candidate
}

function parseRpcPayload(text: string, contentType: string, id: number): JsonRpcMessage | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  if (contentType.includes('text/event-stream') || trimmed.startsWith('event:') || trimmed.startsWith('data:')) {
    return parseSsePayload(trimmed, id)
  }
  return pickRpcMessage(parseJson(trimmed, '响应'), id)
}

function errorFromRpc(message: JsonRpcMessage): EabError {
  const error = message.error
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : {}
  const code = Number(record.code)
  const detail = String(record.message ?? '').trim() || '未知错误'
  return new EabError(EC.UPSTREAM, `MCP Server 返回错误${Number.isFinite(code) ? `（${code}）` : ''}：${detail}`, {
    details: { rpcCode: Number.isFinite(code) ? code : null, data: record.data ?? null },
  })
}

async function postRpc(
  target: McpHttpTarget,
  message: Record<string, unknown>,
): Promise<{ message: JsonRpcMessage | null; sessionId: string }> {
  const endpoint = normalizeMcpEndpoint(target.endpoint)
  if (target.transport === 'stdio') {
    throw new EabError(EC.FORBIDDEN, '第一版 MCP 适配不启动本地 stdio 进程，请使用 http 或 sse 传输')
  }
  const timeoutMs = Math.min(120_000, Math.max(1_000, target.timeoutMs ?? 30_000))
  const maxBytes = Math.min(10 * 1024 * 1024, Math.max(64 * 1024, target.maxBytes ?? 2 * 1024 * 1024))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const abortFromCaller = () => controller.abort()
  target.signal?.addEventListener('abort', abortFromCaller, { once: true })
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'user-agent': 'EAB-MCP/1.0',
        ...(target.headers ?? {}),
      },
      body: JSON.stringify(message),
      redirect: 'error',
      signal: controller.signal,
    })
    const contentLength = Number(response.headers.get('content-length') ?? '0')
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new EabError(EC.UPSTREAM, `MCP Server 响应过大（${contentLength} 字节）`)
    }
    const text = await response.text()
    if (text.length > maxBytes) {
      throw new EabError(EC.UPSTREAM, 'MCP Server 响应超过大小上限')
    }
    if (!response.ok) {
      throw new EabError(EC.UPSTREAM, `MCP Server 返回 HTTP ${response.status}${text ? `：${text.slice(0, 300)}` : ''}`, {
        hint: '检查 MCP Server 地址、鉴权和启动状态',
      })
    }
    const sessionId = String(response.headers.get('mcp-session-id') ?? '').trim()
    const parsed = parseRpcPayload(text, String(response.headers.get('content-type') ?? ''), Number(message.id ?? 0))
    if (parsed?.error !== undefined) throw errorFromRpc(parsed)
    return { message: parsed, sessionId }
  } catch (error) {
    if (error instanceof EabError) throw error
    if (controller.signal.aborted) throw timeoutError(timeoutMs)
    throw new EabError(EC.UPSTREAM, `MCP Server 请求失败：${error instanceof Error ? error.message : String(error)}`, {
      hint: '检查 MCP Server 地址、网络和鉴权配置',
    })
  } finally {
    clearTimeout(timer)
    target.signal?.removeEventListener('abort', abortFromCaller)
  }
}

async function rpcRequest(
  target: McpHttpTarget,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const id = nextRequestId++
  const response = await postRpc(target, { jsonrpc: '2.0', id, method, params })
  if (!response.message) throw new EabError(EC.UPSTREAM, `MCP Server 没有返回 ${method} 的结果`)
  return response.message.result
}

async function notify(target: McpHttpTarget, method: string, params: Record<string, unknown> = {}): Promise<void> {
  await postRpc(target, { jsonrpc: '2.0', method, params })
}

/** MCP 生命周期握手。后续 `tools/*` 在当前实现里每次重新握手，避免持有不可靠的长会话。 */
export async function initializeMcp(target: McpHttpTarget, signal?: AbortSignal): Promise<McpInitializeResult> {
  const effective: McpHttpTarget = signal ? { ...target, signal } : target
  const response = await postRpc(effective, {
    jsonrpc: '2.0',
    id: nextRequestId++,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'EAB', version: '1.0' },
    },
  })
  if (!response.message) throw new EabError(EC.UPSTREAM, 'MCP Server 没有返回 initialize 结果')
  const result = response.message.result
  const resultRecord = result && typeof result === 'object' ? (result as Record<string, unknown>) : {}
  const sessionId = response.sessionId
  const initializedTarget: McpHttpTarget = sessionId
    ? { ...target, headers: { ...(target.headers ?? {}), 'mcp-session-id': sessionId } }
    : target
  try {
    await notify(initializedTarget, 'notifications/initialized')
  } catch {
    // 部分无状态 Server 不处理通知；握手通知失败不阻断 tools/list。
  }
  return {
    sessionId,
    protocolVersion: String(resultRecord.protocolVersion ?? ''),
    serverInfo: resultRecord.serverInfo && typeof resultRecord.serverInfo === 'object'
      ? (resultRecord.serverInfo as Record<string, unknown>)
      : {},
    capabilities: resultRecord.capabilities && typeof resultRecord.capabilities === 'object'
      ? (resultRecord.capabilities as Record<string, unknown>)
      : {},
  }
}

export interface McpToolListResult {
  readonly initialized: McpInitializeResult
  readonly tools: McpRemoteTool[]
}

/** 读取完整 `tools/list`，最多 5 页，避免一个坏 Server 用 cursor 无限拖住同步。 */
export async function listMcpTools(target: McpHttpTarget, signal?: AbortSignal): Promise<McpToolListResult> {
  const effective: McpHttpTarget = signal ? { ...target, signal } : target
  const initialized = await initializeMcp(effective)
  const sessionTarget: McpHttpTarget = {
    ...effective,
    headers: {
      ...(effective.headers ?? {}),
      ...(initialized.sessionId ? { 'mcp-session-id': initialized.sessionId } : {}),
      'mcp-protocol-version': '2025-03-26',
    },
  }
  const tools: McpRemoteTool[] = []
  let cursor = ''
  for (let page = 0; page < 5; page += 1) {
    const result = await rpcRequest(sessionTarget, 'tools/list', cursor ? { cursor } : {})
    const record = result && typeof result === 'object' ? (result as Record<string, unknown>) : {}
    const rows = Array.isArray(record.tools) ? record.tools : []
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const tool = row as Record<string, unknown>
      const name = String(tool.name ?? '').trim()
      if (!name) continue
      tools.push({
        name,
        description: String(tool.description ?? '').trim(),
        inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object' && !Array.isArray(tool.inputSchema)
          ? (tool.inputSchema as Record<string, unknown>)
          : {},
        annotations: tool.annotations && typeof tool.annotations === 'object' && !Array.isArray(tool.annotations)
          ? (tool.annotations as Record<string, unknown>)
          : {},
      })
    }
    cursor = String(record.nextCursor ?? '').trim()
    if (!cursor) break
  }
  return { initialized, tools }
}

export interface McpToolCallResult {
  readonly initialized: McpInitializeResult
  readonly result: unknown
}

/** 调用一个 MCP 工具；协议错误抛异常，工具自身 `isError` 由上层决定如何呈现。 */
export async function callMcpTool(
  target: McpHttpTarget,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<McpToolCallResult> {
  const effective: McpHttpTarget = signal ? { ...target, signal } : target
  const initialized = await initializeMcp(effective)
  const sessionTarget: McpHttpTarget = {
    ...effective,
    headers: {
      ...(effective.headers ?? {}),
      ...(initialized.sessionId ? { 'mcp-session-id': initialized.sessionId } : {}),
      'mcp-protocol-version': '2025-03-26',
    },
  }
  const result = await rpcRequest(sessionTarget, 'tools/call', { name, arguments: args })
  return { initialized, result }
}
