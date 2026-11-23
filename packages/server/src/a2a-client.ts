/**
 * A2A 出站客户端（JSON-RPC 2.0 over HTTP）。
 *
 * 第一版只做同步/轮询式任务，不接 push notification：
 * - 拉取 Agent Card，校验声明端点与公司登记端点同源，避免 Card 把请求带到另一台主机；
 * - `message/send` 建任务，`tasks/get` 读状态与产物，`tasks/cancel` 取消；
 * - 结果只抽状态、摘要和 Artifact 引用，不把远端历史、内部 CoT 或附件正文写进本地任务。
 *
 * 端点来自公司级登记，不由模型直接提供；鉴权头只在请求时解析，不进入错误和审计。
 */
import { randomUUID } from 'node:crypto'
import { EC, EabError } from '@eab/domain'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 300_000
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

export type A2AAuthType = 'none' | 'bearer'
export type A2ATaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'auth-required'
  | 'completed'
  | 'canceled'
  | 'failed'
  | 'rejected'
  | 'unknown'

export interface A2ATarget {
  endpoint: string
  cardUrl?: string
  authType?: A2AAuthType
  token?: string
  timeoutMs?: number
  signal?: AbortSignal
}

export interface A2ACardSkill {
  id: string
  name: string
  description: string
  tags: string[]
  examples: string[]
  inputModes: string[]
  outputModes: string[]
}

export interface A2AAgentCard {
  protocolVersion: string
  name: string
  description: string
  url: string
  version: string
  capabilities: {
    streaming: boolean
    pushNotifications: boolean
    stateTransitionHistory: boolean
  }
  skills: A2ACardSkill[]
  raw: Record<string, unknown>
}

export interface A2ATextPart {
  kind: 'text'
  text: string
}

export interface A2AFilePart {
  kind: 'file'
  file: {
    name?: string
    mimeType?: string
    uri?: string
    bytes?: string
  }
}

export interface A2ADataPart {
  kind: 'data'
  data: Record<string, unknown>
}

export type A2APart = A2ATextPart | A2AFilePart | A2ADataPart

export interface A2AMessage {
  role: 'user' | 'agent'
  parts: A2APart[]
  messageId: string
  taskId?: string
  contextId?: string
  metadata?: Record<string, unknown>
}

export interface A2AArtifact {
  artifactId: string
  name?: string
  description?: string
  parts: A2APart[]
  metadata?: Record<string, unknown>
}

export interface A2ATask {
  id: string
  contextId: string
  status: {
    state: A2ATaskState
    message?: A2AMessage
    timestamp?: string
  }
  artifacts: A2AArtifact[]
  history: A2AMessage[]
  metadata?: Record<string, unknown>
}

export interface A2ASendResult {
  /** 远端可能直接回 Message，也可能建 Task；调用方按 kind 分开处理。 */
  kind: 'task' | 'message'
  task?: A2ATask
  message?: A2AMessage
}

interface JsonRpcEnvelope {
  jsonrpc?: string
  id?: unknown
  result?: unknown
  error?: { code?: unknown; message?: unknown; data?: unknown }
}

function timeoutOf(value: number | undefined): number {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_TIMEOUT_MS
  return Math.min(MAX_TIMEOUT_MS, Math.max(1_000, Math.floor(num)))
}

/** 校验公司登记的 A2A 端点：只允许 http/https，不接受账号密码和片段。 */
export function normalizeA2AEndpoint(raw: string): string {
  const text = String(raw ?? '').trim()
  if (!text) throw new EabError(EC.VALIDATION, 'A2A 端点不能为空')
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new EabError(EC.VALIDATION, 'A2A 端点格式不正确', { hint: '填写完整的 http/https 地址' })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new EabError(EC.VALIDATION, 'A2A 端点只支持 http/https')
  }
  if (url.username || url.password) {
    throw new EabError(EC.VALIDATION, 'A2A 端点不能包含账号密码', { hint: '鉴权请使用 Bearer 密钥配置' })
  }
  url.hash = ''
  return url.href
}

/** 默认从端点同源根路径读取 Agent Card；也允许管理员登记同源的自定义 Card 地址。 */
export function a2aCardUrl(endpoint: string, cardUrl = ''): string {
  const normalized = normalizeA2AEndpoint(endpoint)
  const base = new URL(normalized)
  const raw = String(cardUrl ?? '').trim()
  let target: URL
  try {
    target = raw ? new URL(raw, `${base.protocol}//${base.host}`) : new URL('/.well-known/agent.json', base)
  } catch {
    throw new EabError(EC.VALIDATION, 'Agent Card 地址格式不正确')
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new EabError(EC.VALIDATION, 'Agent Card 地址只支持 http/https')
  }
  if (target.origin !== base.origin) {
    throw new EabError(EC.VALIDATION, 'Agent Card 必须与 A2A 端点同源', {
      hint: '跨域 Card 会被拒绝，请直接登记远端 Agent 的真实端点',
    })
  }
  target.hash = ''
  return target.href
}

function authHeaders(target: A2ATarget): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json, text/event-stream' }
  if (target.authType === 'bearer' && target.token) headers.authorization = `Bearer ${target.token}`
  return headers
}

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    size += value.byteLength
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw new EabError(EC.UPSTREAM, 'A2A 响应超过 2 MB 上限')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')
}

async function request(
  url: string,
  init: RequestInit,
  target: A2ATarget,
): Promise<{ status: number; contentType: string; body: string }> {
  const timeoutMs = timeoutOf(target.timeoutMs)
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onAbort = (): void => controller.abort()
  target.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const headers = new Headers(authHeaders(target))
    for (const [name, value] of new Headers(init.headers).entries()) headers.set(name, value)
    const response = await fetch(url, {
      ...init,
      headers,
      signal: controller.signal,
      redirect: 'error',
    })
    const contentType = String(response.headers.get('content-type') ?? '').toLowerCase()
    const body = await readCapped(response)
    return { status: response.status, contentType, body }
  } catch (error) {
    if (target.signal?.aborted) throw new EabError(EC.CONFLICT, 'A2A 请求已取消')
    if (timedOut) throw new EabError(EC.UPSTREAM, `A2A 请求超时（${timeoutMs} ms）`)
    if (error instanceof EabError) throw error
    throw new EabError(EC.UPSTREAM, '无法连接 A2A 远端 Agent', {
      hint: '检查端点、网络和鉴权配置；远端证书或地址不可用时不会自动重试',
    })
  } finally {
    clearTimeout(timer)
    target.signal?.removeEventListener('abort', onAbort)
  }
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function textOf(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((item) => String(item ?? '').trim()).filter(Boolean))]
}

function parseState(value: unknown): A2ATaskState {
  const state = String(value ?? '')
  return (
    state === 'submitted'
    || state === 'working'
    || state === 'input-required'
    || state === 'auth-required'
    || state === 'completed'
    || state === 'canceled'
    || state === 'failed'
    || state === 'rejected'
      ? state
      : 'unknown'
  ) as A2ATaskState
}

function parsePart(value: unknown): A2APart | null {
  const part = recordOf(value)
  if (!part) return null
  if (part.kind === 'text') return { kind: 'text', text: textOf(part.text) }
  if (part.kind === 'data') {
    const data = recordOf(part.data)
    return data ? { kind: 'data', data } : null
  }
  if (part.kind === 'file') {
    const file = recordOf(part.file)
    if (!file) return null
    return {
      kind: 'file',
      file: {
        name: textOf(file.name) || undefined,
        mimeType: textOf(file.mimeType) || undefined,
        uri: textOf(file.uri) || undefined,
        bytes: textOf(file.bytes) || undefined,
      },
    }
  }
  return null
}

function parseParts(value: unknown): A2APart[] {
  if (!Array.isArray(value)) return []
  return value.map(parsePart).filter((part): part is A2APart => part !== null)
}

function parseMessage(value: unknown): A2AMessage | null {
  const item = recordOf(value)
  if (!item || (item.role !== 'user' && item.role !== 'agent')) return null
  return {
    role: item.role,
    parts: parseParts(item.parts),
    messageId: textOf(item.messageId),
    taskId: textOf(item.taskId) || undefined,
    contextId: textOf(item.contextId) || undefined,
    metadata: recordOf(item.metadata) ?? undefined,
  }
}

function parseArtifact(value: unknown): A2AArtifact | null {
  const item = recordOf(value)
  if (!item) return null
  const artifactId = textOf(item.artifactId).trim()
  if (!artifactId) return null
  return {
    artifactId,
    name: textOf(item.name) || undefined,
    description: textOf(item.description) || undefined,
    parts: parseParts(item.parts),
    metadata: recordOf(item.metadata) ?? undefined,
  }
}

function parseTask(value: unknown): A2ATask | null {
  const item = recordOf(value)
  if (!item) return null
  const id = textOf(item.id).trim()
  const status = recordOf(item.status)
  if (!id || !status) return null
  return {
    id,
    contextId: textOf(item.contextId),
    status: {
      state: parseState(status.state),
      message: parseMessage(status.message) ?? undefined,
      timestamp: textOf(status.timestamp) || undefined,
    },
    artifacts: Array.isArray(item.artifacts)
      ? item.artifacts.map(parseArtifact).filter((artifact): artifact is A2AArtifact => artifact !== null)
      : [],
    history: Array.isArray(item.history)
      ? item.history.map(parseMessage).filter((message): message is A2AMessage => message !== null)
      : [],
    metadata: recordOf(item.metadata) ?? undefined,
  }
}

function parseEnvelope(body: string, contentType: string): JsonRpcEnvelope {
  const candidates: JsonRpcEnvelope[] = []
  if (contentType.includes('text/event-stream')) {
    for (const line of body.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data) continue
      try {
        const parsed = JSON.parse(data) as JsonRpcEnvelope
        if (parsed && typeof parsed === 'object') candidates.push(parsed)
      } catch {
        // 单个坏事件不阻断后续合法事件；全部坏掉时下面统一报错。
      }
    }
  } else {
    try {
      const parsed = JSON.parse(body) as JsonRpcEnvelope
      if (parsed && typeof parsed === 'object') candidates.push(parsed)
    } catch {
      // 交给下面统一报错。
    }
  }
  let envelope: JsonRpcEnvelope | undefined
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const item = candidates[index]
    if (item.error !== undefined || item.result !== undefined) {
      envelope = item
      break
    }
  }
  if (!envelope) envelope = candidates[candidates.length - 1]
  if (!envelope) throw new EabError(EC.UPSTREAM, 'A2A 返回了无法解析的响应')
  if (envelope.error) {
    const message = textOf(envelope.error.message, 'A2A 远端返回错误')
    throw new EabError(EC.UPSTREAM, message.slice(0, 500), {
      details: {
        code: typeof envelope.error.code === 'number' ? envelope.error.code : undefined,
      },
    })
  }
  return envelope
}

/** 拉取并归一化 Agent Card；卡里的 url 必须与登记端点同源。 */
export async function fetchA2AAgentCard(target: A2ATarget): Promise<A2AAgentCard> {
  const endpoint = normalizeA2AEndpoint(target.endpoint)
  const url = a2aCardUrl(endpoint, target.cardUrl)
  const response = await request(url, { method: 'GET' }, { ...target, endpoint })
  if (response.status < 200 || response.status >= 300) {
    throw new EabError(EC.UPSTREAM, `A2A Agent Card 返回 HTTP ${response.status}`, {
      hint: '检查卡地址和鉴权；远端要求登录时需配置 Bearer 密钥',
    })
  }
  let raw: Record<string, unknown> | null = null
  try {
    const parsed = JSON.parse(response.body) as unknown
    raw = recordOf(parsed)
  } catch {
    raw = null
  }
  if (!raw) throw new EabError(EC.UPSTREAM, 'A2A Agent Card 不是合法 JSON 对象')
  const name = textOf(raw.name).trim()
  if (!name) throw new EabError(EC.UPSTREAM, 'A2A Agent Card 缺少 name')
  const cardEndpoint = textOf(raw.url).trim()
  if (!cardEndpoint) throw new EabError(EC.UPSTREAM, 'A2A Agent Card 缺少 url')
  const normalizedCardEndpoint = normalizeA2AEndpoint(cardEndpoint)
  const expected = new URL(endpoint)
  const declared = new URL(normalizedCardEndpoint)
  if (declared.origin !== expected.origin) {
    throw new EabError(EC.UPSTREAM, 'A2A Agent Card 声明的端点与登记端点不同源', {
      hint: '拒绝跨域端点，避免 Card 把请求重定向到未登记主机',
    })
  }
  const capabilities = recordOf(raw.capabilities) ?? {}
  const skills = Array.isArray(raw.skills)
    ? raw.skills
        .map((item): A2ACardSkill | null => {
          const skill = recordOf(item)
          if (!skill) return null
          const id = textOf(skill.id).trim()
          if (!id) return null
          return {
            id,
            name: textOf(skill.name) || id,
            description: textOf(skill.description),
            tags: stringList(skill.tags),
            examples: stringList(skill.examples),
            inputModes: stringList(skill.inputModes),
            outputModes: stringList(skill.outputModes),
          }
        })
        .filter((skill): skill is A2ACardSkill => skill !== null)
    : []
  return {
    protocolVersion: textOf(raw.protocolVersion, '0.2.6'),
    name,
    description: textOf(raw.description),
    url: normalizedCardEndpoint,
    version: textOf(raw.version, '1'),
    capabilities: {
      streaming: capabilities.streaming === true,
      pushNotifications: capabilities.pushNotifications === true,
      stateTransitionHistory: capabilities.stateTransitionHistory === true,
    },
    skills,
    raw,
  }
}

async function rpc(
  target: A2ATarget,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const endpoint = normalizeA2AEndpoint(target.endpoint)
  const response = await request(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
  }, { ...target, endpoint })
  if (response.status < 200 || response.status >= 300) {
    throw new EabError(EC.UPSTREAM, `A2A ${method} 返回 HTTP ${response.status}`)
  }
  return parseEnvelope(response.body, response.contentType).result
}

/** 发起一条 A2A 消息；远端可能直接返回 Message，也可能返回 Task。 */
export async function sendA2AMessage(input: {
  target: A2ATarget
  text: string
  contextId?: string
  taskId?: string
  skillId?: string
  metadata?: Record<string, unknown>
}): Promise<A2ASendResult> {
  const text = String(input.text ?? '').trim()
  if (!text) throw new EabError(EC.VALIDATION, 'A2A 消息不能为空')
  const message: Record<string, unknown> = {
    role: 'user',
    parts: [{ kind: 'text', text }],
    messageId: randomUUID(),
  }
  if (input.contextId) message.contextId = input.contextId
  if (input.taskId) message.taskId = input.taskId
  const result = await rpc(
    input.target,
    'message/send',
    {
      message,
      configuration: {
        blocking: true,
        acceptedOutputModes: ['text/plain', 'application/json'],
      },
      metadata: {
        ...(input.metadata ?? {}),
        ...(input.skillId ? { skillId: input.skillId } : {}),
      },
    },
  )
  const task = parseTask(result)
  if (task) return { kind: 'task', task }
  const reply = parseMessage(result)
  if (reply) return { kind: 'message', message: reply }
  throw new EabError(EC.UPSTREAM, 'A2A message/send 返回了无法识别的结果')
}

/** 读取远端任务当前状态。 */
export async function getA2ATask(target: A2ATarget, taskId: string, historyLength = 0): Promise<A2ATask> {
  const id = String(taskId ?? '').trim()
  if (!id) throw new EabError(EC.VALIDATION, 'A2A taskId 不能为空')
  const result = await rpc(target, 'tasks/get', { id, historyLength })
  const task = parseTask(result)
  if (!task) throw new EabError(EC.UPSTREAM, 'A2A tasks/get 没有返回 Task')
  return task
}

/** 请求取消远端任务；返回远端取消后的任务状态。 */
export async function cancelA2ATask(target: A2ATarget, taskId: string): Promise<A2ATask> {
  const id = String(taskId ?? '').trim()
  if (!id) throw new EabError(EC.VALIDATION, 'A2A taskId 不能为空')
  const result = await rpc(target, 'tasks/cancel', { id })
  const task = parseTask(result)
  if (!task) throw new EabError(EC.UPSTREAM, 'A2A tasks/cancel 没有返回 Task')
  return task
}

/** 从 Task 里提取给模型看的摘要和产物；不返回远端 history 原文。 */
export function summarizeA2ATask(task: A2ATask): {
  statusText: string
  resultText: string
  artifacts: Array<{
    id: string
    name: string
    mimeType: string
    size: number
    checksum: string
    source: 'a2a'
    uri: string
    preview?: string
  }>
} {
  const statusText = task.status.message?.parts
    .filter((part): part is A2ATextPart => part.kind === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim() ?? ''
  const artifacts: ReturnType<typeof summarizeA2ATask>['artifacts'] = []
  const parts: string[] = []
  for (const artifact of task.artifacts) {
    for (const part of artifact.parts) {
      if (part.kind === 'text') {
        parts.push(part.text)
        continue
      }
      if (part.kind === 'data') {
        parts.push(JSON.stringify(part.data))
        continue
      }
      if (part.kind === 'file' && part.file.uri) {
        artifacts.push({
          id: artifact.artifactId,
          name: artifact.name || part.file.name || artifact.artifactId,
          mimeType: part.file.mimeType ?? '',
          size: 0,
          checksum: '',
          source: 'a2a',
          uri: part.file.uri,
          preview: part.file.name ? `A2A 文件：${part.file.name}` : undefined,
        })
        continue
      }
      if (part.kind === 'file' && part.file.name) {
        parts.push(`[远端文件：${part.file.name}${part.file.mimeType ? `（${part.file.mimeType}）` : ''}，未提供下载地址]`)
      }
    }
  }
  const resultText = [statusText, ...parts].filter(Boolean).join('\n').trim().slice(0, 8_000)
  return { statusText, resultText, artifacts }
}
