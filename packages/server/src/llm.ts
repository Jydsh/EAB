/**
 * 真实模型调用。支持 OpenAI 兼容的流式输出、思考内容（reasoning）与工具调用。
 *
 * 协议归三类：OpenAI 兼容 / Anthropic / Gemini，Azure 是 OpenAI 兼容的特例（部署名 + api-version）。
 * 密钥来自密钥文件（`EAB_PROVIDER_*`），只在服务端读取，绝不回传前端。
 */
import { EC, EabError } from '@eab/domain'
import type { Db } from '@eab/storage'
import { resolveSecret, secretConfigured } from './secrets.js'

export interface LlmToolCall {
  readonly id: string
  readonly type: 'function'
  readonly function: { readonly name: string; readonly arguments: string }
}

export type LlmContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image_url'; readonly image_url: { readonly url: string } }

export type LlmContent = string | LlmContentPart[]

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  readonly content: LlmContent
  readonly tool_calls?: LlmToolCall[]
  readonly tool_call_id?: string
}

function contentAsText(content: LlmContent): string {
  return typeof content === 'string'
    ? content
    : content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
}

function inlineImage(url: string): { mimeType: string; data: string } | null {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(url)
  if (!match) return null
  return {
    mimeType: match[1].toLowerCase().replace('image/jpg', 'image/jpeg'),
    data: match[2],
  }
}

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'image'; source: { type: 'url'; url: string } }

function anthropicContent(content: LlmContent): string | AnthropicContentBlock[] {
  if (typeof content === 'string') return content
  const blocks: AnthropicContentBlock[] = []
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text) blocks.push({ type: 'text', text: part.text })
      continue
    }
    const image = inlineImage(part.image_url.url)
    if (image) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } })
    } else if (/^https?:\/\//i.test(part.image_url.url)) {
      blocks.push({ type: 'image', source: { type: 'url', url: part.image_url.url } })
    }
  }
  return blocks.length ? blocks : [{ type: 'text', text: '' }]
}

type GeminiPart =
  | { text: string }
  | { inline_data: { mime_type: string; data: string } }
  | { file_data: { mime_type: string; file_uri: string } }

function geminiParts(content: LlmContent): GeminiPart[] {
  if (typeof content === 'string') return [{ text: content }]
  const parts: GeminiPart[] = []
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text) parts.push({ text: part.text })
      continue
    }
    const image = inlineImage(part.image_url.url)
    if (image) {
      parts.push({ inline_data: { mime_type: image.mimeType, data: image.data } })
    } else if (/^https?:\/\//i.test(part.image_url.url)) {
      parts.push({ file_data: { mime_type: 'image/jpeg', file_uri: part.image_url.url } })
    }
  }
  return parts.length ? parts : [{ text: '' }]
}

export interface ToolSpec {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, { type: string; description: string }>
      required: string[]
      additionalProperties: false
    }
  }
}

export interface CallResult {
  readonly text: string
  readonly reasoning?: string
  readonly toolCalls?: LlmToolCall[]
  readonly promptTokens: number
  readonly completionTokens: number
}

export type ModelStreamEvent = { type: 'reasoning'; text: string } | { type: 'content'; text: string }

export interface ModelCallOptions {
  tools?: ToolSpec[]
}

export interface ModelStreamOptions extends ModelCallOptions {
  onEvent?: (event: ModelStreamEvent) => void
  /** 调用方中止（例如用户点「停止当前回复」） */
  signal?: AbortSignal
}

interface ProviderRow {
  kind: string
  name: string
  base_url: string | null
  api_key_env: string | null
}

const DEFAULT_BASE: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4',
  moonshot: 'https://api.moonshot.cn/v1',
  anthropic: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  volcengine: 'https://ark.cn-beijing.volces.com/api/v3',
  qianfan: 'https://qianfan.baidubce.com/v2',
  hunyuan: 'https://api.hunyuan.cloud.tencent.com/v1',
  siliconflow: 'https://api.siliconflow.cn/v1',
  minimax: 'https://api.minimax.chat/v1',
  stepfun: 'https://api.stepfun.com/v1',
  xai: 'https://api.x.ai/v1',
  groq: 'https://api.groq.com/openai/v1',
  mistral: 'https://api.mistral.ai/v1',
  together: 'https://api.together.xyz/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  ollama: 'http://127.0.0.1:11434/v1',
  vllm: 'http://127.0.0.1:8000/v1',
  lmstudio: 'http://127.0.0.1:1234/v1',
}

function trimBase(url: string): string {
  return url.replace(/\/+$/, '')
}

function providerOf(db: Db, companyId: string, modelId: string): ProviderRow & { modelKey: string } {
  const row = db
    .prepare(
      `SELECT p.kind, p.name, p.base_url, p.api_key_env, m.model_key
         FROM models m JOIN model_providers p ON p.id = m.provider_id
        WHERE m.id = ? AND m.company_id = ? AND m.deleted_at IS NULL`,
    )
    .get(modelId, companyId) as (ProviderRow & { model_key: string }) | undefined
  if (!row) throw new EabError(EC.NOT_FOUND, '模型不存在或已删除')
  return {
    kind: row.kind,
    name: row.name,
    base_url: row.base_url,
    api_key_env: row.api_key_env,
    modelKey: row.model_key,
  }
}

function apiKeyOf(provider: ProviderRow, dbPath: string): string {
  if (provider.api_key_env && secretConfigured(dbPath, provider.api_key_env)) {
    return resolveSecret(dbPath, provider.api_key_env)
  }
  return ''
}

async function readError(res: Response): Promise<string> {
  const text = await res.text()
  try {
    const json = JSON.parse(text) as Record<string, unknown>
    const error = json.error as Record<string, unknown> | string | undefined
    if (typeof error === 'string') return error
    if (error && typeof error.message === 'string') return error.message
    if (typeof json.message === 'string') return json.message
  } catch {
    // 非 JSON 就截断原文
  }
  return text.slice(0, 300)
}

/**
 * 上游瞬时限流/网关错误才值得重试；超时、鉴权失败、模型名错误重试只会放大等待。
 * 只重试响应尚未开始读取的请求，流式调用也不会因为重试而把半截内容拼两次。
 */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])
const RETRY_MAX_ATTEMPTS = 3

function retryDelay(attempt: number, res: Response): number {
  const retryAfter = Number(res.headers.get('retry-after') ?? '')
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 2_000)
  return attempt === 1 ? 500 : 1_000
}

async function fetchModelWithRetry(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt += 1) {
    const res = await fetch(url, init)
    if (!RETRYABLE_STATUS.has(res.status) || attempt === RETRY_MAX_ATTEMPTS) return res
    if (init.signal?.aborted) return res
    await res.body?.cancel().catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, retryDelay(attempt, res)))
  }
  throw new EabError(EC.UPSTREAM, '模型请求重试次数已用完')
}


async function callOpenAi(
  base: string,
  key: string,
  modelKey: string,
  messages: ChatMessage[],
  maxTokens: number,
  tools: ToolSpec[] = [],
): Promise<CallResult> {
  const res = await fetchModelWithRetry(`${trimBase(base)}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({
      model: modelKey,
      messages,
      max_tokens: maxTokens,
      temperature: 0.4,
      ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
    }),
    signal: AbortSignal.timeout(90_000),
  })
  if (!res.ok) {
    throw new EabError(EC.UPSTREAM, `模型返回 HTTP ${res.status}：${await readError(res)}`, {
      hint: '检查供应商端点、模型名、密钥与额度',
    })
  }
  const json = (await res.json()) as {
    choices?: Array<{
      message?: {
        content?: string | Array<{ type?: string; text?: string }>
        reasoning?: string
        reasoning_content?: string
        tool_calls?: LlmToolCall[]
      }
    }>
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  const message = json.choices?.[0]?.message
  const content = message?.content
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((part) => part.text ?? '').join('')
        : ''
  const toolCalls = message?.tool_calls ?? []
  if (!text.trim() && toolCalls.length === 0) {
    throw new EabError(EC.UPSTREAM, '模型返回了空内容', { hint: '上游可能限流或模型名不匹配' })
  }
  return {
    text,
    reasoning: message?.reasoning ?? message?.reasoning_content ?? '',
    toolCalls,
    promptTokens: Number(json.usage?.prompt_tokens ?? 0),
    completionTokens: Number(json.usage?.completion_tokens ?? 0),
  }
}

async function callAzure(
  base: string,
  key: string,
  deployment: string,
  messages: ChatMessage[],
  maxTokens: number,
): Promise<CallResult> {
  if (!base) throw new EabError(EC.VALIDATION, 'Azure OpenAI 需要填写资源 Endpoint')
  if (!key) throw new EabError(EC.VALIDATION, 'Azure OpenAI 没有可用密钥')
  const res = await fetchModelWithRetry(
    `${trimBase(base)}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=2024-06-01`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-key': key },
      body: JSON.stringify({ messages, max_tokens: maxTokens, temperature: 0.4 }),
      signal: AbortSignal.timeout(90_000),
    },
  )
  if (!res.ok) {
    throw new EabError(EC.UPSTREAM, `Azure 返回 HTTP ${res.status}：${await readError(res)}`)
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  const text = json.choices?.[0]?.message?.content ?? ''
  if (!text.trim()) throw new EabError(EC.UPSTREAM, 'Azure 返回了空内容')
  return {
    text,
    promptTokens: Number(json.usage?.prompt_tokens ?? 0),
    completionTokens: Number(json.usage?.completion_tokens ?? 0),
  }
}

async function callAnthropic(
  base: string,
  key: string,
  modelKey: string,
  messages: ChatMessage[],
  maxTokens: number,
): Promise<CallResult> {
  if (!key) throw new EabError(EC.VALIDATION, 'Anthropic 没有可用密钥')
  const system = messages.filter((item) => item.role === 'system').map((item) => contentAsText(item.content)).join('\n')
  const rest = messages.filter((item) => item.role !== 'system')
  const res = await fetchModelWithRetry(`${trimBase(base)}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: modelKey,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: rest.map((item) => ({ role: item.role, content: anthropicContent(item.content) })),
    }),
    signal: AbortSignal.timeout(90_000),
  })
  if (!res.ok) throw new EabError(EC.UPSTREAM, `Anthropic 返回 HTTP ${res.status}：${await readError(res)}`)
  const json = (await res.json()) as {
    content?: Array<{ type?: string; text?: string }>
    usage?: { input_tokens?: number; output_tokens?: number }
  }
  const text = (json.content ?? []).map((part) => part.text ?? '').join('')
  if (!text.trim()) throw new EabError(EC.UPSTREAM, 'Anthropic 返回了空内容')
  return {
    text,
    promptTokens: Number(json.usage?.input_tokens ?? 0),
    completionTokens: Number(json.usage?.output_tokens ?? 0),
  }
}

async function callGemini(
  base: string,
  key: string,
  modelKey: string,
  messages: ChatMessage[],
  maxTokens: number,
): Promise<CallResult> {
  if (!key) throw new EabError(EC.VALIDATION, 'Gemini 没有可用密钥')
  const system = messages.filter((item) => item.role === 'system').map((item) => contentAsText(item.content)).join('\n')
  const contents = messages
    .filter((item) => item.role !== 'system')
    .map((item) => ({
      role: item.role === 'assistant' ? 'model' : 'user',
      parts: geminiParts(item.content),
    }))
  const res = await fetchModelWithRetry(
    `${trimBase(base)}/models/${encodeURIComponent(modelKey)}:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents,
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.4 },
      }),
      signal: AbortSignal.timeout(90_000),
    },
  )
  if (!res.ok) throw new EabError(EC.UPSTREAM, `Gemini 返回 HTTP ${res.status}：${await readError(res)}`)
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
  }
  const text = (json.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? '').join('')
  if (!text.trim()) throw new EabError(EC.UPSTREAM, 'Gemini 返回了空内容')
  return {
    text,
    promptTokens: Number(json.usageMetadata?.promptTokenCount ?? 0),
    completionTokens: Number(json.usageMetadata?.candidatesTokenCount ?? 0),
  }
}

interface ToolCallAccumulator {
  id: string
  type: 'function'
  name: string
  arguments: string
}

async function callOpenAiStream(
  base: string,
  key: string,
  modelKey: string,
  messages: ChatMessage[],
  maxTokens: number,
  options: ModelStreamOptions,
): Promise<CallResult> {
  const timeout = AbortSignal.timeout(120_000)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const res = await fetchModelWithRetry(`${trimBase(base)}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({
      model: modelKey,
      messages,
      max_tokens: maxTokens,
      temperature: 0.4,
      stream: true,
      ...(options.tools && options.tools.length > 0 ? { tools: options.tools, tool_choice: 'auto' } : {}),
    }),
    signal,
  })
  if (!res.ok) {
    throw new EabError(EC.UPSTREAM, `模型返回 HTTP ${res.status}：${await readError(res)}`, {
      hint: '检查供应商端点、模型名、密钥与额度',
    })
  }
  if (!res.body) throw new EabError(EC.UPSTREAM, '模型没有返回流式内容')

  let text = ''
  let reasoning = ''
  let promptTokens = 0
  let completionTokens = 0
  const toolCalls = new Map<number, ToolCallAccumulator>()
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const handleLine = (rawLine: string) => {
    const line = rawLine.trim()
    if (!line || line.startsWith(':') || !line.startsWith('data:')) return
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') return
    let json: {
      choices?: Array<{
        delta?: {
          content?: string
          reasoning?: string
          reasoning_content?: string
          tool_calls?: Array<{
            index?: number
            id?: string
            type?: 'function'
            function?: { name?: string; arguments?: string }
          }>
        }
        finish_reason?: string | null
      }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    try {
      json = JSON.parse(payload)
    } catch {
      return
    }
    if (json.usage) {
      promptTokens = Number(json.usage.prompt_tokens ?? promptTokens)
      completionTokens = Number(json.usage.completion_tokens ?? completionTokens)
    }
    const delta = json.choices?.[0]?.delta
    if (!delta) return
    const reasoningDelta = delta.reasoning_content ?? delta.reasoning ?? ''
    if (reasoningDelta) {
      reasoning += reasoningDelta
      options.onEvent?.({ type: 'reasoning', text: reasoningDelta })
    }
    if (delta.content) {
      text += delta.content
      options.onEvent?.({ type: 'content', text: delta.content })
    }
    for (const part of delta.tool_calls ?? []) {
      const index = Number(part.index ?? 0)
      const current = toolCalls.get(index) ?? { id: '', type: 'function' as const, name: '', arguments: '' }
      if (part.id) current.id = part.id
      if (part.function?.name) current.name += part.function.name
      if (part.function?.arguments) current.arguments += part.function.arguments
      toolCalls.set(index, current)
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) handleLine(line)
  }
  buffer += decoder.decode()
  if (buffer) handleLine(buffer)

  const normalizedToolCalls: LlmToolCall[] = [...toolCalls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, item]) => ({
      id: item.id || `call_${index}`,
      type: 'function' as const,
      function: { name: item.name, arguments: item.arguments || '{}' },
    }))

  if (!text.trim() && normalizedToolCalls.length === 0) {
    // 推理模型把 max_tokens 全花在 reasoning 上时，content 会是空的；
    // 这里单独标记，交给 callModelStream 用更大的预算重试一次。
    if (reasoning.trim()) {
      throw new EabError(EC.UPSTREAM, '模型只输出了推理内容，没有生成最终答复', {
        hint: '推理过程可能占满了 max_tokens',
        details: { reasoningChars: reasoning.length },
      })
    }
    throw new EabError(EC.UPSTREAM, '模型返回了空内容', { hint: '上游可能限流或模型名不匹配' })
  }
  return {
    text,
    reasoning,
    toolCalls: normalizedToolCalls,
    promptTokens,
    completionTokens,
  }
}

/** 流式调用：OpenAI 兼容协议走真实 SSE；其它协议退化成一次性结果，前端仍按同一套事件渲染。 */
export async function callModelStream(
  db: Db,
  dbPath: string,
  companyId: string,
  modelId: string,
  messages: ChatMessage[],
  options: ModelStreamOptions = {},
  maxTokens = 4096,
): Promise<CallResult | null> {
  const provider = providerOf(db, companyId, modelId)
  if (provider.kind === 'demo') return null
  const base = provider.base_url || DEFAULT_BASE[provider.kind] || ''
  if (!base) throw new EabError(EC.VALIDATION, `供应商「${provider.name}」还没有填写端点`)
  const key = apiKeyOf(provider, dbPath)

  if (provider.kind === 'anthropic' || provider.kind === 'gemini' || provider.kind === 'azure_openai') {
    const result = await callModel(db, dbPath, companyId, modelId, messages, maxTokens)
    if (result?.reasoning) options.onEvent?.({ type: 'reasoning', text: result.reasoning })
    if (result?.text) options.onEvent?.({ type: 'content', text: result.text })
    return result
  }
  try {
    return await callOpenAiStream(base, key, provider.modelKey, messages, maxTokens, options)
  } catch (error) {
    if (error instanceof EabError && error.message === '模型只输出了推理内容，没有生成最终答复') {
      // 推理模型在长任务上可能把预算全用在 thinking 上。用翻倍预算重试一次，
      // 并丢弃第二次的 reasoning 事件，避免前端看到重复思考过程。
      const retryTokens = Math.min(maxTokens * 2, 16_384)
      return await callOpenAiStream(base, key, provider.modelKey, messages, retryTokens, {
        ...options,
        onEvent: (event) => {
          if (event.type === 'content') options.onEvent?.(event)
        },
      })
    }
    throw error
  }
}


/** 非流式调用。返回 null 表示这是演示供应商，调用方走本地回声。 */
export async function callModel(
  db: Db,
  dbPath: string,
  companyId: string,
  modelId: string,
  messages: ChatMessage[],
  maxTokens = 4096,
): Promise<CallResult | null> {
  const provider = providerOf(db, companyId, modelId)
  if (provider.kind === 'demo') return null
  const base = provider.base_url || DEFAULT_BASE[provider.kind] || ''
  if (!base) throw new EabError(EC.VALIDATION, `供应商「${provider.name}」还没有填写端点`)
  const key = apiKeyOf(provider, dbPath)

  if (provider.kind === 'anthropic') {
    return callAnthropic(base, key, provider.modelKey, messages, maxTokens)
  }
  if (provider.kind === 'gemini') {
    return callGemini(base, key, provider.modelKey, messages, maxTokens)
  }
  if (provider.kind === 'azure_openai') {
    return callAzure(base, key, provider.modelKey, messages, maxTokens)
  }
  return callOpenAi(base, key, provider.modelKey, messages, maxTokens)
}

export interface EmbeddingResult {
  readonly vectors: readonly number[][]
  readonly dim: number
  readonly promptTokens: number
}

function normalizeVector(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => Number(item)).filter((item) => Number.isFinite(item))
}

async function callOpenAiEmbeddings(
  base: string,
  key: string,
  modelKey: string,
  texts: readonly string[],
): Promise<EmbeddingResult> {
  const res = await fetch(`${trimBase(base)}/embeddings`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({ model: modelKey, input: texts, encoding_format: 'float' }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new EabError(EC.UPSTREAM, `向量模型返回 HTTP ${res.status}：${await readError(res)}`, {
    hint: '检查供应商 Base URL、embedding 模型名和密钥；OpenAI 兼容端点应支持 /embeddings',
  })
  const json = (await res.json()) as {
    data?: Array<{ embedding?: unknown; index?: number }>
    usage?: { prompt_tokens?: number; total_tokens?: number }
  }
  const vectors = (json.data ?? [])
    .slice()
    .sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0))
    .map((item) => normalizeVector(item.embedding))
    .filter((item) => item.length > 0)
  if (vectors.length !== texts.length) {
    throw new EabError(EC.UPSTREAM, `向量模型返回数量不匹配：期望 ${texts.length}，实际 ${vectors.length}`)
  }
  const dim = vectors[0]?.length ?? 0
  if (vectors.some((item) => item.length !== dim)) {
    throw new EabError(EC.UPSTREAM, '向量模型返回的维度不一致')
  }
  return {
    vectors,
    dim,
    promptTokens: Number(json.usage?.prompt_tokens ?? json.usage?.total_tokens ?? 0),
  }
}

async function callAzureEmbeddings(
  base: string,
  key: string,
  deployment: string,
  texts: readonly string[],
): Promise<EmbeddingResult> {
  if (!base) throw new EabError(EC.VALIDATION, 'Azure OpenAI 需要填写资源 Endpoint')
  if (!key) throw new EabError(EC.VALIDATION, 'Azure OpenAI 没有可用密钥')
  const res = await fetch(
    `${trimBase(base)}/openai/deployments/${encodeURIComponent(deployment)}/embeddings?api-version=2024-06-01`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-key': key },
      body: JSON.stringify({ input: texts, encoding_format: 'float' }),
      signal: AbortSignal.timeout(60_000),
    },
  )
  if (!res.ok) throw new EabError(EC.UPSTREAM, `Azure 向量接口返回 HTTP ${res.status}：${await readError(res)}`)
  const json = (await res.json()) as {
    data?: Array<{ embedding?: unknown; index?: number }>
    usage?: { prompt_tokens?: number }
  }
  const vectors = (json.data ?? [])
    .slice()
    .sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0))
    .map((item) => normalizeVector(item.embedding))
    .filter((item) => item.length > 0)
  if (vectors.length !== texts.length) {
    throw new EabError(EC.UPSTREAM, `Azure 向量返回数量不匹配：期望 ${texts.length}，实际 ${vectors.length}`)
  }
  return { vectors, dim: vectors[0]?.length ?? 0, promptTokens: Number(json.usage?.prompt_tokens ?? 0) }
}

async function callGeminiEmbeddings(
  base: string,
  key: string,
  modelKey: string,
  texts: readonly string[],
): Promise<EmbeddingResult> {
  if (!key) throw new EabError(EC.VALIDATION, 'Gemini 没有可用密钥')
  const model = modelKey.replace(/^models\//, '')
  const res = await fetch(
    `${trimBase(base)}/models/${encodeURIComponent(model)}:batchEmbedContents?key=${encodeURIComponent(key)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requests: texts.map((text) => ({
          model: `models/${model}`,
          content: { parts: [{ text }] },
        })),
      }),
      signal: AbortSignal.timeout(60_000),
    },
  )
  if (!res.ok) throw new EabError(EC.UPSTREAM, `Gemini 向量接口返回 HTTP ${res.status}：${await readError(res)}`)
  const json = (await res.json()) as { embeddings?: Array<{ values?: unknown }> }
  const vectors = (json.embeddings ?? []).map((item) => normalizeVector(item.values)).filter((item) => item.length > 0)
  if (vectors.length !== texts.length) {
    throw new EabError(EC.UPSTREAM, `Gemini 向量返回数量不匹配：期望 ${texts.length}，实际 ${vectors.length}`)
  }
  return { vectors, dim: vectors[0]?.length ?? 0, promptTokens: 0 }
}

/**
 * 批量向量化。只支持能提供 embedding 端点的协议：
 * OpenAI 兼容（含本地 vLLM/Ollama）、Azure OpenAI、Gemini；Anthropic 没有 embeddings。
 */
export async function callEmbeddings(
  db: Db,
  dbPath: string,
  companyId: string,
  modelId: string,
  texts: readonly string[],
): Promise<EmbeddingResult> {
  if (texts.length === 0) throw new EabError(EC.VALIDATION, '没有需要向量化的文本')
  const provider = providerOf(db, companyId, modelId)
  if (provider.kind === 'demo') {
    throw new EabError(EC.VALIDATION, '演示模型不提供向量能力', {
      hint: '请接入一个带 embedding 能力的真实模型，例如 BGE-M3、Qwen-Embedding 或 OpenAI embeddings',
    })
  }
  const base = provider.base_url || DEFAULT_BASE[provider.kind] || ''
  if (!base) throw new EabError(EC.VALIDATION, `供应商「${provider.name}」还没有填写端点`)
  const key = apiKeyOf(provider, dbPath)

  if (provider.kind === 'anthropic') {
    throw new EabError(EC.VALIDATION, 'Anthropic 协议没有 embeddings 接口，不能用作向量模型', {
      hint: '请选择 OpenAI 兼容、Azure OpenAI 或 Gemini 的 embedding 模型',
    })
  }
  if (provider.kind === 'gemini') return callGeminiEmbeddings(base, key, provider.modelKey, texts)
  if (provider.kind === 'azure_openai') return callAzureEmbeddings(base, key, provider.modelKey, texts)
  return callOpenAiEmbeddings(base, key, provider.modelKey, texts)
}

export interface RerankHit {
  readonly index: number
  readonly score: number
}

export interface RerankResult {
  readonly results: RerankHit[]
  readonly modelKey: string
}

function parseRerankHits(payload: unknown, documentCount: number): RerankHit[] {
  let rawList: unknown[] = []
  if (Array.isArray(payload)) {
    rawList = payload
  } else if (payload && typeof payload === 'object') {
    const root = payload as Record<string, unknown>
    if (Array.isArray(root.results)) rawList = root.results
    else if (Array.isArray(root.data)) rawList = root.data
    else if (Array.isArray(root.output)) rawList = root.output
  }
  const hits: RerankHit[] = []
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const index = Number(item.index)
    const score = Number(item.relevance_score ?? item.score ?? item.relevance)
    if (!Number.isInteger(index) || index < 0 || index >= documentCount) continue
    if (!Number.isFinite(score)) continue
    hits.push({ index, score })
  }
  return hits.sort((a, b) => b.score - a.score)
}

/**
 * 调用重排序接口。
 *
 * 兼容两类主流形态，均以供应商 Base URL 为根：
 * - Cohere / Jina / SiliconFlow / vLLM / Xinference：POST /rerank
 *   { model, query, documents[], top_n, return_documents }
 * - HuggingFace TEI：POST /rerank { query, texts[], truncate }
 *
 * 先发第一类；服务端返回 4xx 或响应里没有结果时，再用 TEI 形态重试一次。
 */
export async function callRerank(
  db: Db,
  dbPath: string,
  companyId: string,
  modelId: string,
  query: string,
  documents: readonly string[],
  topN = 4,
): Promise<RerankResult> {
  if (!query.trim()) throw new EabError(EC.VALIDATION, '重排序缺少查询文本')
  const docs = documents.map((item) => item.trim().slice(0, 1_200)).filter(Boolean).slice(0, 24)
  if (docs.length === 0) throw new EabError(EC.VALIDATION, '重排序没有候选文档')
  if (docs.length === 1) return { results: [{ index: 0, score: 1 }], modelKey: '' }

  const provider = providerOf(db, companyId, modelId)
  if (provider.kind === 'demo') {
    throw new EabError(EC.VALIDATION, '演示模型不提供重排序能力', {
      hint: '请接入 BGE-Reranker、Jina Reranker、Cohere Rerank 或 SiliconFlow 的重排序模型',
    })
  }
  if (provider.kind === 'anthropic' || provider.kind === 'gemini' || provider.kind === 'azure_openai') {
    throw new EabError(EC.VALIDATION, `供应商「${provider.name}」没有标准的 /rerank 接口`, {
      hint: '请选择提供 POST /rerank 的 OpenAI 兼容供应商，或使用自定义 Base URL',
    })
  }
  const base = provider.base_url || DEFAULT_BASE[provider.kind] || ''
  if (!base) throw new EabError(EC.VALIDATION, `供应商「${provider.name}」还没有填写端点`)
  const key = apiKeyOf(provider, dbPath)
  const url = /\/rerank$/i.test(base) ? trimBase(base) : `${trimBase(base)}/rerank`
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' }
  if (key) headers.authorization = `Bearer ${key}`

  const post = async (body: Record<string, unknown>) => {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) return { ok: false as const, status: res.status, error: await readError(res) }
    try {
      return { ok: true as const, status: res.status, json: (await res.json()) as unknown }
    } catch {
      return { ok: false as const, status: res.status, error: '响应不是 JSON' }
    }
  }

  let attempt = await post({
    model: provider.modelKey,
    query,
    documents: docs,
    top_n: Math.min(topN, docs.length),
    return_documents: false,
  })
  let hits = attempt.ok ? parseRerankHits(attempt.json, docs.length) : []
  if (!attempt.ok || hits.length === 0) {
    attempt = await post({ query, texts: docs, truncate: true })
    hits = attempt.ok ? parseRerankHits(attempt.json, docs.length) : []
  }
  if (!attempt.ok) {
    throw new EabError(EC.UPSTREAM, `重排序接口返回 HTTP ${attempt.status}：${attempt.error}`, {
      hint: `${url} 需支持 POST /rerank；已尝试 {model,query,document} 与 TEI 的 {query,texts} 两种请求体`,
    })
  }
  if (hits.length === 0) {
    throw new EabError(EC.UPSTREAM, '重排序接口返回里没有可用的 results[{ index, relevance_score }]', {
      hint: '确认该模型是重排序模型、不是对话模型；部分服务返回 score 字段也可识别',
    })
  }
  return { results: hits.slice(0, Math.max(1, topN)), modelKey: provider.modelKey }
}

/** 给控制台「测试连接」用：只发一句最小请求，不落库 */
export async function testProviderModel(  db: Db,
  dbPath: string,
  companyId: string,
  modelId: string,
): Promise<CallResult | null> {
  return callModel(db, dbPath, companyId, modelId, [{ role: 'user', content: '只回复 OK 两个字母。' }], 16)
}
