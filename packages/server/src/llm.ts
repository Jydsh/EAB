/**
 * 真实模型调用。支持 OpenAI 兼容的流式输出、思考内容（reasoning）与工具调用。
 *
 * 协议归三类：OpenAI 兼容 / Anthropic / Gemini，Azure 是 OpenAI 兼容的特例（部署名 + api-version）。
 * 密钥来自密钥文件（`EAB_PROVIDER_*`），只在服务端读取，绝不回传前端。
 */
import { EC, EabError } from '@eab/domain'
import type { Db } from '@eab/storage'
import { resolveSecret, secretConfigured } from './secrets.js'
import {
  anthropicThinkingBudget,
  geminiThinkingBudget,
  providerReasoningEffort,
} from './thinking.js'

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

export interface ToolParameterSchema {
  type: string
  description?: string
  items?: ToolParameterSchema
  properties?: Record<string, ToolParameterSchema>
  required?: string[]
  additionalProperties?: boolean
  enum?: string[]
  minItems?: number
  maxItems?: number
}

export interface ToolSpec {
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

export interface CallResult {
  readonly text: string
  readonly reasoning?: string
  readonly toolCalls?: LlmToolCall[]
  readonly promptTokens: number
  readonly completionTokens: number
}

export type ModelStreamEvent =
  | { type: 'reasoning'; text: string }
  | { type: 'content'; text: string }
  /**
   * 工具调用参数增量：模型生成 workspace.write 的 text 时就推给前端，
   * 右侧预览可以先显示草稿；真正落盘仍等完整参数到达后执行一次。
   */
  | {
      type: 'tool_delta'
      index: number
      id?: string
      name?: string
      argumentsDelta?: string
    }

export type ToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } }

export interface ModelCallOptions {
  tools?: ToolSpec[]
  /** 默认 auto；澄清修复时强制模型调用 ask_user。 */
  toolChoice?: ToolChoice
  /** 已解析的思考档位 ID；由模型配置和会话选择共同决定。 */
  reasoningEffort?: string
  /** OpenAI 兼容协议实际下发的 reasoning_effort 线值；优先于 reasoningEffort 的内置映射。 */
  reasoningWireEffort?: string
  /** budget 策略下，重试也不得突破的 max_tokens 上限。 */
  maxTokensCap?: number
  /** 单次上游请求超时；批量分析的大输入需要比普通对话更长的等待。 */
  timeoutMs?: number
  /** 本地 vLLM 上的 Qwen 清洗/抽取任务关闭思考，避免长输出被推理 token 拖到数分钟。 */
  disableThinking?: boolean
  /** 调用方中止（例如知识库文档清洗预算到点）。 */
  signal?: AbortSignal
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

const DEFAULT_STREAM_TIMEOUT_MS = 120_000
const LOCAL_STREAM_TIMEOUT_MS = 600_000

/**
 * 本地/内网模型端点的流式超时要比云供应商宽松。
 * 本地 vLLM 在长上下文、首次加载或长工具任务上可能超过 120 秒，
 * 不能把一次慢响应直接等同为模型不可用。
 */
function isLocalModelEndpoint(base: string): boolean {
  try {
    const host = new URL(base).hostname.toLowerCase()
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host.endsWith('.local') ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    )
  } catch {
    return false
  }
}

function streamTimeoutFor(base: string, explicit?: number): number {
  if (Number.isFinite(explicit) && (explicit ?? 0) >= 1_000) return Math.trunc(explicit as number)
  return isLocalModelEndpoint(base) ? LOCAL_STREAM_TIMEOUT_MS : DEFAULT_STREAM_TIMEOUT_MS
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
    if (typeof json.detail === 'string' && json.detail) return json.detail
    if (Array.isArray(json.detail)) {
      const detail = json.detail
        .map((item) => {
          if (typeof item === 'string') return item
          if (item && typeof item === 'object') {
            const record = item as Record<string, unknown>
            if (typeof record.msg === 'string') return record.msg
            if (typeof record.message === 'string') return record.message
          }
          return ''
        })
        .filter(Boolean)
        .join('；')
      if (detail) return detail
    }
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
  reasoningEffort?: string,
  wireEffortOverride?: string,
  timeoutMs = 90_000,
  disableThinking = false,
  signal?: AbortSignal,
): Promise<CallResult> {
  const wireEffort = wireEffortOverride
    ? providerReasoningEffort(reasoningEffort ?? wireEffortOverride, wireEffortOverride)
    : reasoningEffort
      ? providerReasoningEffort(reasoningEffort)
      : undefined
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
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
      ...(wireEffort ? { reasoning_effort: wireEffort } : {}),
      // vLLM 的 Qwen 模板参数：关闭思考后清洗吞吐约提升一个数量级。
      ...(disableThinking ? { chat_template_kwargs: { enable_thinking: false } } : {}),
      ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
    }),
    signal: requestSignal,
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
  const reasoning = message?.reasoning ?? message?.reasoning_content ?? ''
  const toolCalls = message?.tool_calls ?? []
  if (!text.trim() && toolCalls.length === 0) {
    // 推理模型把 max_tokens 花在 reasoning 上时 content 会是空的。
    // 单独标记，交给 callModel 用更大的预算重试，而不是当成上游故障。
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
  reasoningEffort?: string,
): Promise<CallResult> {
  if (!base) throw new EabError(EC.VALIDATION, 'Azure OpenAI 需要填写资源 Endpoint')
  if (!key) throw new EabError(EC.VALIDATION, 'Azure OpenAI 没有可用密钥')
  const wireEffort = reasoningEffort ? providerReasoningEffort(reasoningEffort) : undefined
  const res = await fetchModelWithRetry(
    `${trimBase(base)}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=2024-06-01`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-key': key },
      body: JSON.stringify({
        messages,
        max_tokens: maxTokens,
        temperature: 0.4,
        ...(wireEffort ? { reasoning_effort: wireEffort } : {}),
      }),
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
  reasoningEffort?: string,
): Promise<CallResult> {
  if (!key) throw new EabError(EC.VALIDATION, 'Anthropic 没有可用密钥')
  const system = messages.filter((item) => item.role === 'system').map((item) => contentAsText(item.content)).join('\n')
  const rest = messages.filter((item) => item.role !== 'system')
  const thinkingBudget = reasoningEffort ? anthropicThinkingBudget(reasoningEffort, maxTokens) : undefined
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
      ...(thinkingBudget ? { thinking: { type: 'enabled', budget_tokens: thinkingBudget } } : {}),
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
  // 扩展思考会额外返回 thinking block；正文只取 text，避免把推理内容拼进答案。
  const text = (json.content ?? [])
    .filter((part) => part.type !== 'thinking' && part.type !== 'redacted_thinking')
    .map((part) => part.text ?? '')
    .join('')
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
  reasoningEffort?: string,
): Promise<CallResult> {
  if (!key) throw new EabError(EC.VALIDATION, 'Gemini 没有可用密钥')
  const system = messages.filter((item) => item.role === 'system').map((item) => contentAsText(item.content)).join('\n')
  const contents = messages
    .filter((item) => item.role !== 'system')
    .map((item) => ({
      role: item.role === 'assistant' ? 'model' : 'user',
      parts: geminiParts(item.content),
    }))
  const thinkingBudget = reasoningEffort ? geminiThinkingBudget(reasoningEffort) : undefined
  const res = await fetchModelWithRetry(
    `${trimBase(base)}/models/${encodeURIComponent(modelKey)}:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents,
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature: 0.4,
          ...(thinkingBudget === undefined ? {} : { thinkingConfig: { thinkingBudget } }),
        },
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

/**
 * vLLM 上的 Qwen 模板支持用 `chat_template_kwargs.enable_thinking=false`
 * 真正关闭思考；`reasoning_effort` 这类参数会被它忽略。
 */
function canToggleThinking(provider: ProviderRow & { modelKey: string }): boolean {
  return /vllm/i.test(provider.name) || /qwen/i.test(provider.modelKey)
}

async function callOpenAiStream(
  base: string,
  key: string,
  modelKey: string,
  messages: ChatMessage[],
  maxTokens: number,
  options: ModelStreamOptions,
): Promise<CallResult> {
  const timeout = AbortSignal.timeout(
    Math.max(1_000, options.timeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS),
  )
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const wireEffort = options.reasoningWireEffort
    ? providerReasoningEffort(options.reasoningEffort ?? options.reasoningWireEffort, options.reasoningWireEffort)
    : options.reasoningEffort
      ? providerReasoningEffort(options.reasoningEffort)
      : undefined
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
      ...(wireEffort ? { reasoning_effort: wireEffort } : {}),
      // vLLM 的 Qwen 模板参数：关闭思考，避免推理 token 把正文预算吃光。
      ...(options.disableThinking ? { chat_template_kwargs: { enable_thinking: false } } : {}),
      ...(options.tools && options.tools.length > 0
        ? { tools: options.tools, tool_choice: options.toolChoice ?? 'auto' }
        : {}),
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
      const argumentsDelta = String(part.function?.arguments ?? '')
      if (part.id) current.id = part.id
      if (part.function?.name) current.name += part.function.name
      if (argumentsDelta) current.arguments += argumentsDelta
      toolCalls.set(index, current)
      // 工具参数分片也实时交给调用方：网页端靠它做文件写入预览。
      // 注意只推增量，完整参数仍以最终 toolCalls 为准。
      if (part.id || part.function?.name || argumentsDelta) {
        options.onEvent?.({
          type: 'tool_delta',
          index,
          ...(current.id ? { id: current.id } : {}),
          ...(current.name ? { name: current.name } : {}),
          ...(argumentsDelta ? { argumentsDelta } : {}),
        })
      }
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
    const result = await callModel(db, dbPath, companyId, modelId, messages, maxTokens, options)
    if (result?.reasoning) options.onEvent?.({ type: 'reasoning', text: result.reasoning })
    if (result?.text) options.onEvent?.({ type: 'content', text: result.text })
    return result
  }
  const canDisableThinking = canToggleThinking(provider)
  // Qwen + vLLM 不认 reasoning_effort；选择「精简/关闭」时直接关模板思考，
  // 否则模型会先长时间 reasoning，正文预算被吃光后只剩一个空答复。
  const initialOptions: ModelStreamOptions = canDisableThinking
    && (options.disableThinking || options.reasoningEffort === 'light' || options.reasoningEffort === 'disabled')
    ? { ...options, disableThinking: true }
    : options
  try {
    const timeoutMs = streamTimeoutFor(base, options.timeoutMs)
    return await callOpenAiStream(base, key, provider.modelKey, messages, maxTokens, {
      ...initialOptions,
      timeoutMs,
    })
  } catch (error) {
    // 推理模型在长任务上可能把预算全用在 thinking 上；本地上游也可能偶发返回
    // 200 但正文为空。这两种结果都不代表模型不可用，先用更大预算重试一次，
    // 再决定是否关闭思考或故障转移。重试的 reasoning 事件丢弃，避免前端看到重复思考。
    // budget 策略下不得超过档位上限，否则「精简」会被悄悄放大。
    const reasoningOnly = error instanceof EabError && error.message === '模型只输出了推理内容，没有生成最终答复'
    const emptyContent = error instanceof EabError && error.message === '模型返回了空内容'
    if (!reasoningOnly && !emptyContent) throw error
    const timeoutMs = streamTimeoutFor(base, options.timeoutMs)
    const cap = options.maxTokensCap ?? 16_384
    // 已到上限时不能把预算改小；否则 32768 会被压成 16384，重试只会再次失败。
    const doubled = Math.min(maxTokens * 2, cap)
    const retryTokens = reasoningOnly && doubled > maxTokens ? doubled : maxTokens
    if (reasoningOnly && retryTokens > maxTokens) {
      try {
        return await callOpenAiStream(base, key, provider.modelKey, messages, retryTokens, {
          ...initialOptions,
          timeoutMs,
          onEvent: (event) => {
            if (event.type === 'content') options.onEvent?.(event)
          },
        })
      } catch (retryError) {
        // 更大预算仍然只出思考时，继续走关闭思考兜底；其它错误直接交给上层。
        if (!(retryError instanceof EabError) || retryError.message !== '模型只输出了推理内容，没有生成最终答复') {
          throw retryError
        }
      }
    }
    if (reasoningOnly && canDisableThinking && !initialOptions.disableThinking) {
      return await callOpenAiStream(base, key, provider.modelKey, messages, maxTokens, {
        ...initialOptions,
        disableThinking: true,
        timeoutMs,
        onEvent: (event) => {
          if (event.type === 'content') options.onEvent?.(event)
        },
      })
    }
    if (emptyContent) {
      return await callOpenAiStream(base, key, provider.modelKey, messages, maxTokens, {
        ...initialOptions,
        timeoutMs,
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
  options: ModelCallOptions = {},
): Promise<CallResult | null> {
  const provider = providerOf(db, companyId, modelId)
  if (provider.kind === 'demo') return null
  const base = provider.base_url || DEFAULT_BASE[provider.kind] || ''
  if (!base) throw new EabError(EC.VALIDATION, `供应商「${provider.name}」还没有填写端点`)
  const key = apiKeyOf(provider, dbPath)

  if (provider.kind === 'anthropic') {
    return callAnthropic(base, key, provider.modelKey, messages, maxTokens, options.reasoningEffort)
  }
  if (provider.kind === 'gemini') {
    return callGemini(base, key, provider.modelKey, messages, maxTokens, options.reasoningEffort)
  }
  if (provider.kind === 'azure_openai') {
    return callAzure(base, key, provider.modelKey, messages, maxTokens, options.reasoningEffort)
  }
  const disableThinking = Boolean(options.disableThinking) && canToggleThinking(provider)
  const callOpenAiWithBudget = (tokens: number, withoutThinking = disableThinking) =>
    callOpenAi(
      base,
      key,
      provider.modelKey,
      messages,
      tokens,
      options.tools ?? [],
      options.reasoningEffort,
      options.reasoningWireEffort,
      options.timeoutMs,
      withoutThinking,
      options.signal,
    )
  try {
    return await callOpenAiWithBudget(maxTokens)
  } catch (error) {
    // 推理模型把输出预算全花在 thinking 上时，content 为空但 reasoning 有内容。
    // 对这类结果用更大预算重试一次，避免小批次清洗被误判成“模型没有返回”。
    if (error instanceof EabError && error.message === '模型只输出了推理内容，没有生成最终答复') {
      if (maxTokens < 8192) return callOpenAiWithBudget(8192)
      // 预算已经很大仍然只出思考时，加大预算通常无效，直接关模板思考兜底。
      if (canToggleThinking(provider) && !disableThinking) {
        return callOpenAiWithBudget(maxTokens, true)
      }
    }
    throw error
  }
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

export interface SystemOneChoiceQuestion {
  readonly type: 'choice'
  readonly instructions: string
  readonly criteria: Record<string, string>
}

export interface SystemOneNoUlQuestion {
  readonly type: 'noul'
  readonly instructions: string
}

export interface SystemOneScoreQuestion {
  readonly type: 'score'
  readonly instructions: string
  readonly criteria: readonly string[]
}

export type SystemOneQuestion = SystemOneChoiceQuestion | SystemOneNoUlQuestion | SystemOneScoreQuestion

export interface SystemOneAnswer {
  readonly choice?: string
  readonly noul?: boolean | string
  readonly score?: number
  readonly probabilities?: Record<string, number>
  readonly confidence?: number
}

export interface SystemOneResult {
  readonly id: string
  readonly model: string
  readonly answers: Record<string, SystemOneAnswer>
  readonly usage: Record<string, unknown>
}

export interface SystemOneOptions {
  readonly images?: readonly string[]
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

/**
 * SystemOne 是结构化决策协议：输入状态 + 若干问题，输出每个问题的选择/概率/置信度，
 * 不生成自然语言。它和 chat completions 是两套端点，不能走 callModel 的 OpenAI 分支。
 */
export async function callSystemOne(
  db: Db,
  dbPath: string,
  companyId: string,
  modelId: string,
  state: string | Record<string, unknown>,
  questions: Record<string, SystemOneQuestion>,
  options: SystemOneOptions = {},
): Promise<SystemOneResult> {
  const provider = providerOf(db, companyId, modelId)
  if (provider.kind === 'demo') {
    throw new EabError(EC.VALIDATION, '演示模型不提供 SystemOne 决策能力', {
      hint: '请接入华东师大 SystemOne 或其他兼容 POST /v1/systemone 的决策端点',
    })
  }
  const base = provider.base_url || ''
  if (!base) {
    throw new EabError(EC.VALIDATION, `供应商「${provider.name}」还没有填写 SystemOne Base URL`, {
      hint: 'SystemOne 不是内置协议，必须在供应商里填写自定义 Base URL，例如 https://chat.ecnu.edu.cn/open/api/v1',
    })
  }
  if (state === null || state === undefined || (typeof state === 'string' && !state.trim())) {
    throw new EabError(EC.VALIDATION, 'SystemOne 的 state 不能为空')
  }
  const entries = Object.entries(questions)
  if (entries.length === 0) throw new EabError(EC.VALIDATION, 'SystemOne 至少需要 1 个问题')
  if (entries.length > 64) throw new EabError(EC.VALIDATION, 'SystemOne 单次最多 64 个问题')

  const key = apiKeyOf(provider, dbPath)
  const url = /\/systemone$/i.test(base) ? trimBase(base) : `${trimBase(base)}/systemone`
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 20_000, 120_000))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`SystemOne 超时（${timeoutMs}ms）`)), timeoutMs)
  const onAbort = () => controller.abort(options.signal?.reason)
  if (options.signal) {
    if (options.signal.aborted) onAbort()
    else options.signal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({
          model: provider.modelKey,
          state,
          questions,
          ...(options.images && options.images.length > 0 ? { images: options.images } : {}),
        }),
        signal: controller.signal,
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new EabError(EC.UPSTREAM, `SystemOne 请求失败：${reason}`, {
        hint: '检查 Base URL 是否填到 /v1，以及上游是否支持 POST /v1/systemone',
      })
    }

    if (!res.ok) {
      const detail = await readError(res)
      throw new EabError(EC.UPSTREAM, `SystemOne 返回 HTTP ${res.status}：${detail}`, {
        hint: '网关 detail 数组或后端 error.message 已原样带出；检查模型标识、state 结构与问题格式',
      })
    }

    let payload: Record<string, unknown>
    try {
      payload = (await res.json()) as Record<string, unknown>
    } catch {
      throw new EabError(EC.UPSTREAM, 'SystemOne 返回的不是 JSON', {
        hint: '该端点可能不是 SystemOne 协议，确认 Base URL 和 /v1/systemone 路径',
      })
    }
    const answers = payload.answers
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
      throw new EabError(EC.UPSTREAM, 'SystemOne 响应缺少 answers', {
        hint: '期望 structured_decision.answers，按问题 ID 返回选择与置信度',
      })
    }
    return {
      id: String(payload.id ?? ''),
      model: String(payload.model ?? ''),
      answers: answers as Record<string, SystemOneAnswer>,
      usage: payload.usage && typeof payload.usage === 'object' ? (payload.usage as Record<string, unknown>) : {},
    }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
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

export interface TranscriptionResult {
  readonly text: string
  readonly modelKey: string
}

/**
 * 语音转写（用途路由 `asr.default` 的运行时实现）。
 *
 * 兼容 OpenAI 协议：POST /audio/transcriptions（multipart）。
 * Azure OpenAI 走 deployments 路径；Anthropic / Gemini 没有标准转写接口，直接给可执行提示。
 */
export async function callTranscription(
  db: Db,
  dbPath: string,
  companyId: string,
  modelId: string,
  audio: { readonly buffer: Uint8Array; readonly mime: string; readonly fileName?: string },
): Promise<TranscriptionResult> {
  if (!audio.buffer || audio.buffer.byteLength === 0) {
    throw new EabError(EC.VALIDATION, '转写缺少音频内容')
  }
  const provider = providerOf(db, companyId, modelId)
  if (provider.kind === 'demo') {
    throw new EabError(EC.VALIDATION, '演示模型不提供语音转写能力', {
      hint: '请接入 Whisper、FunASR、Paraformer 或 SenseVoice 这类提供 /audio/transcriptions 的端点',
    })
  }
  if (provider.kind === 'anthropic' || provider.kind === 'gemini') {
    throw new EabError(EC.VALIDATION, `供应商「${provider.name}」没有标准的语音转写接口`, {
      hint: '请选择 OpenAI 兼容的转写端点，或把 Base URL 指向自建 whisper / funasr 服务',
    })
  }
  const base = provider.base_url || DEFAULT_BASE[provider.kind] || ''
  if (!base) throw new EabError(EC.VALIDATION, `供应商「${provider.name}」还没有填写端点`)
  const key = apiKeyOf(provider, dbPath)
  const url =
    provider.kind === 'azure_openai'
      ? `${trimBase(base)}/openai/deployments/${encodeURIComponent(provider.modelKey)}/audio/transcriptions?api-version=2024-02-01`
      : /\/audio\/transcriptions$/i.test(base)
        ? trimBase(base)
        : `${trimBase(base)}/audio/transcriptions`

  const form = new FormData()
  form.append('model', provider.modelKey)
  form.append('file', new Blob([audio.buffer], { type: audio.mime }), audio.fileName || 'audio.webm')
  form.append('response_format', 'json')
  const headers: Record<string, string> = { accept: 'application/json' }
  if (key) {
    if (provider.kind === 'azure_openai') headers['api-key'] = key
    else headers.authorization = `Bearer ${key}`
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: form,
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new EabError(EC.VALIDATION, `语音转写失败：HTTP ${res.status} ${await readError(res)}`.trim())
  let payload: unknown = null
  try {
    payload = await res.json()
  } catch {
    payload = null
  }
  const text =
    payload && typeof payload === 'object' ? String((payload as { text?: unknown }).text ?? '').trim() : ''
  if (!text) throw new EabError(EC.VALIDATION, '语音转写返回空文本', { hint: '检查转写端点是否支持 multipart 上传与 response_format=json' })
  return { text, modelKey: provider.modelKey }
}

export interface SpeechResult {
  readonly audio: Uint8Array
  readonly mime: string
  readonly modelKey: string
  /** 供应商明确返回音频时长时透传，用于钉钉语音气泡。 */
  readonly durationMs?: number
}

export interface SpeechStreamResult {
  readonly body: ReadableStream<Uint8Array>
  readonly mime: string
  readonly modelKey: string
  readonly sampleRate: number
}

/**
 * 本地 Breeze-TTS-2 官方 API（8110）与 OpenAI 兼容 shim（8100）不是同一套协议：
 * 官方 API 只接收 multipart 表单的 text/instruction/ref_audio/ref_text，
 * 播放端只给裸 PCM；shim 才接收 JSON input/voice/instructions。
 */
function isBreezeOfficialTts(provider: ProviderRow & { modelKey: string }): boolean {
  return provider.modelKey === 'breeze-tts-2' && /:8110(?:\/|$)/.test(provider.base_url || '')
}

/** 把 24kHz 单声道 s16le 裸 PCM 包一层 WAV，便于试听接口和锚点复用。 */
function pcmToWav(pcm: Uint8Array, sampleRate = 24_000): Uint8Array {
  const header = Buffer.alloc(44)
  const data = Buffer.from(pcm)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return new Uint8Array(Buffer.concat([header, data]))
}

interface VoiceAnchorAudio {
  readonly audio: Uint8Array
  readonly text: string
}

function breezeSpeechForm(
  input: string,
  options: {
    instructions?: string
    seed?: number
    anchor?: VoiceAnchorAudio
  },
): FormData {
  const form = new FormData()
  form.append('text', input)
  if (options.anchor?.audio.byteLength && options.anchor.text) {
    // Voice Clone：参考音频 + 精确文字稿，锁定说话人；此时不能再叠加 instruction。
    form.append(
      'ref_audio',
      new Blob([Buffer.from(options.anchor.audio)], { type: 'audio/wav' }),
      'voice-anchor.wav',
    )
    form.append('ref_text', options.anchor.text)
    form.append('cfg_scale', '1')
  } else {
    const instructions = String(options.instructions ?? '').trim()
    if (instructions) form.append('instruction', instructions.slice(0, 200))
    form.append('cfg_scale', '4')
  }
  if (Number.isFinite(options.seed) && Number(options.seed) > 0) {
    form.append('seed', String(Math.floor(Number(options.seed))))
  }
  return form
}

/** 部分 OpenAI 兼容 TTS 服务把格式写在请求里，响应头却固定 audio/wav；以文件头为准。 */
function speechMimeFromBytes(bytes: Uint8Array, declared: string, format: string): string {
  if (bytes.length >= 12) {
    const ascii = Buffer.from(bytes.subarray(0, 12)).toString('ascii')
    if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE') return 'audio/wav'
    if (ascii.startsWith('ID3')) return 'audio/mpeg'
    if (ascii.startsWith('OggS')) return 'audio/ogg'
    if (ascii.startsWith('fLaC')) return 'audio/flac'
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'audio/mpeg'
  const clean = String(declared || '').split(';')[0]?.trim().toLowerCase()
  if (clean && clean !== 'application/octet-stream') return clean
  return format === 'wav' ? 'audio/wav' : format === 'opus' ? 'audio/ogg' : 'audio/mpeg'
}

/**
 * 语音合成（用途路由 `tts.default` 的运行时实现）。
 * 兼容 OpenAI 协议 POST /audio/speech；Azure 走 deployments 路径；不支持时给出提示。
 */
export async function callSpeech(
  db: Db,
  dbPath: string,
  companyId: string,
  modelId: string,
  text: string,
  options: {
    voice?: string
    instructions?: string
    seed?: number
    format?: 'mp3' | 'wav' | 'opus'
    anchor?: VoiceAnchorAudio
  } = {},
): Promise<SpeechResult> {
  const input = text.trim()
  if (!input) throw new EabError(EC.VALIDATION, '合成缺少文本')
  const provider = providerOf(db, companyId, modelId)
  if (provider.kind === 'demo') {
    throw new EabError(EC.VALIDATION, '演示模型不提供语音合成能力', {
      hint: '请接入 CosyVoice、ChatTTS、F5-TTS 或任意提供 /audio/speech 的端点',
    })
  }
  if (provider.kind === 'anthropic' || provider.kind === 'gemini') {
    throw new EabError(EC.VALIDATION, `供应商「${provider.name}」没有标准的语音合成接口`, {
      hint: '请选择 OpenAI 兼容的 /audio/speech 端点',
    })
  }
  const base = provider.base_url || DEFAULT_BASE[provider.kind] || ''
  if (!base) throw new EabError(EC.VALIDATION, `供应商「${provider.name}」还没有填写端点`)
  const key = apiKeyOf(provider, dbPath)
  if (isBreezeOfficialTts(provider)) {
    const url = `${trimBase(base)}/audio/speech`
    const headers: Record<string, string> = { accept: 'audio/pcm, audio/*' }
    if (key) headers.authorization = `Bearer ${key}`
    const requestOfficial = () =>
      fetch(url, {
        method: 'POST',
        headers,
        body: breezeSpeechForm(input, options),
        signal: AbortSignal.timeout(90_000),
      })
    let res = await requestOfficial()
    if (!res.ok && (res.status === 409 || res.status === 429 || res.status >= 500)) {
      await new Promise((resolve) => setTimeout(resolve, res.status === 409 ? 1_200 : 500))
      res = await requestOfficial()
    }
    if (!res.ok) throw new EabError(EC.VALIDATION, `语音合成失败：HTTP ${res.status} ${await readError(res)}`.trim())
    const pcm = new Uint8Array(await res.arrayBuffer())
    if (pcm.byteLength === 0) throw new EabError(EC.VALIDATION, '语音合成返回空音频')
    const sampleRate = 24_000
    return {
      audio: pcmToWav(pcm, sampleRate),
      mime: 'audio/wav',
      modelKey: provider.modelKey,
      durationMs: Math.round((pcm.byteLength / (sampleRate * 2)) * 1000),
    }
  }
  const format = options.format ?? 'mp3'
  const url =
    provider.kind === 'azure_openai'
      ? `${trimBase(base)}/openai/deployments/${encodeURIComponent(provider.modelKey)}/audio/speech?api-version=2024-02-01`
      : /\/audio\/speech$/i.test(base)
        ? trimBase(base)
        : `${trimBase(base)}/audio/speech`
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'audio/*' }
  if (key) {
    if (provider.kind === 'azure_openai') headers['api-key'] = key
    else headers.authorization = `Bearer ${key}`
  }
  const body: Record<string, unknown> = {
    model: provider.modelKey,
    input: input.slice(0, 1_200),
    voice: options.voice || 'S0',
    response_format: format,
  }
  const instructions = String(options.instructions ?? '').trim()
  if (instructions) body.instructions = instructions.slice(0, 200)
  if (Number.isFinite(options.seed) && Number(options.seed) > 0) body.seed = Math.floor(Number(options.seed))
  const requestSpeech = () =>
    fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    })
  let res = await requestSpeech()
  // 本地 TTS 在并发/忙碌时会返回 409 Conflict，限流时会返回 429；这类是瞬时冲突，退避后重试一次。
  // 其它 4xx 是请求本身有问题，不重试。
  if (!res.ok && (res.status === 409 || res.status === 429 || res.status >= 500)) {
    await new Promise((resolve) => setTimeout(resolve, res.status === 409 ? 1_200 : 500))
    res = await requestSpeech()
  }
  if (!res.ok) throw new EabError(EC.VALIDATION, `语音合成失败：HTTP ${res.status} ${await readError(res)}`.trim())
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.byteLength === 0) throw new EabError(EC.VALIDATION, '语音合成返回空音频')
  const mime = speechMimeFromBytes(bytes, res.headers.get('content-type') || '', format)
  const durationHeader = Number(res.headers.get('x-audio-duration-seconds'))
  return {
    audio: bytes,
    mime,
    modelKey: provider.modelKey,
    durationMs: Number.isFinite(durationHeader) && durationHeader > 0 ? Math.round(durationHeader * 1000) : undefined,
  }
}

/**
 * 语音合成流式入口：供应商在几十毫秒内先回头、随后持续推送裸 PCM。
 * 这里不读取响应体，交给 HTTP 路由边收边转发；客户端断开后取消 body 即可让上游释放推理槽。
 */
export async function callSpeechStream(
  db: Db,
  dbPath: string,
  companyId: string,
  modelId: string,
  text: string,
  options: {
    voice?: string
    instructions?: string
    cfgScale?: number
    seed?: number
    anchor?: VoiceAnchorAudio
  } = {},
): Promise<SpeechStreamResult> {
  const input = text.trim()
  if (!input) throw new EabError(EC.VALIDATION, '合成缺少文本')
  const provider = providerOf(db, companyId, modelId)
  if (provider.kind === 'demo') {
    throw new EabError(EC.VALIDATION, '演示模型不提供语音合成能力', {
      hint: '请接入支持 /audio/speech/stream 的流式 TTS 端点',
    })
  }
  if (provider.kind === 'anthropic' || provider.kind === 'gemini') {
    throw new EabError(EC.VALIDATION, `供应商「${provider.name}」没有标准的语音合成接口`, {
      hint: '请选择 OpenAI 兼容的流式 TTS 端点',
    })
  }
  const base = provider.base_url || DEFAULT_BASE[provider.kind] || ''
  if (!base) throw new EabError(EC.VALIDATION, `供应商「${provider.name}」还没有填写端点`)
  const key = apiKeyOf(provider, dbPath)
  const baseUrl = trimBase(base)
  if (isBreezeOfficialTts(provider)) {
    const url = `${baseUrl}/audio/speech`
    const headers: Record<string, string> = { accept: 'audio/pcm, audio/*;q=0.9' }
    if (key) headers.authorization = `Bearer ${key}`
    const requestOfficial = () =>
      fetch(url, {
        method: 'POST',
        headers,
        body: breezeSpeechForm(input, {
          instructions: options.instructions,
          seed: options.seed,
          anchor: options.anchor,
        }),
        signal: AbortSignal.timeout(120_000),
      })
    let res = await requestOfficial()
    if (res.status === 409 || res.status === 429) {
      await new Promise((resolve) => setTimeout(resolve, res.status === 409 ? 1_200 : 500))
      res = await requestOfficial()
    }
    if (!res.ok) throw new EabError(EC.VALIDATION, `流式语音合成失败：HTTP ${res.status} ${await readError(res)}`.trim())
    if (!res.body) throw new EabError(EC.VALIDATION, '流式语音合成没有返回音频流')
    const rawSampleRate = Number(
      res.headers.get('x-audio-sample-rate') ||
        res.headers.get('x-sample-rate') ||
        res.headers.get('x-audio-samplerate'),
    )
    return {
      body: res.body,
      mime: (res.headers.get('content-type') || 'audio/pcm').split(';')[0].trim().toLowerCase() || 'audio/pcm',
      modelKey: provider.modelKey,
      sampleRate: Number.isFinite(rawSampleRate) && rawSampleRate > 0 ? Math.round(rawSampleRate) : 24_000,
    }
  }
  const url = /\/audio\/speech\/stream$/i.test(baseUrl)
    ? baseUrl
    : /\/audio\/speech$/i.test(baseUrl)
      ? `${baseUrl}/stream`
      : `${baseUrl}/audio/speech/stream`
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'audio/pcm, audio/*;q=0.9',
  }
  if (key) headers.authorization = `Bearer ${key}`
  const body: Record<string, unknown> = {
    model: provider.modelKey,
    input,
    voice: options.voice || 'S0',
    // breeze-tts 的流式端点用 cfg_scale 控制韵律；其他 OpenAI 兼容端点会忽略未知字段。
    cfg_scale: Number.isFinite(options.cfgScale) ? Number(options.cfgScale) : 1,
  }
  // 员工选择的“我的声音”在 EAB 里是一段文字描述；非流式路径一直会传 instructions，
  // 流式路径此前漏传，导致所有自定义音色都退回系统默认。这里补齐同一份配置。
  const instructions = String(options.instructions ?? '').trim()
  if (instructions) body.instructions = instructions.slice(0, 200)
  if (Number.isFinite(options.seed) && Number(options.seed) > 0) body.seed = Math.floor(Number(options.seed))
  const requestStream = () =>
    fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    })
  let res = await requestStream()
  // 单推理槽在并发时返回 409；退避后重试一次，避免网页刚上一段播完就切下一段时撞上忙状态。
  if (res.status === 409) {
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    res = await requestStream()
  }
  if (!res.ok) throw new EabError(EC.VALIDATION, `流式语音合成失败：HTTP ${res.status} ${await readError(res)}`.trim())
  if (!res.body) throw new EabError(EC.VALIDATION, '流式语音合成没有返回音频流')
  const rawSampleRate = Number(
    res.headers.get('x-audio-sample-rate') || res.headers.get('x-sample-rate') || res.headers.get('x-audio-samplerate'),
  )
  return {
    body: res.body,
    mime: (res.headers.get('content-type') || 'audio/pcm').split(';')[0].trim().toLowerCase() || 'audio/pcm',
    modelKey: provider.modelKey,
    sampleRate: Number.isFinite(rawSampleRate) && rawSampleRate > 0 ? Math.round(rawSampleRate) : 24_000,
  }
}