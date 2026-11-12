/**
 * 模型能力与用途路由。
 *
 * 设计口径：
 * - `tags` 是历史字段，继续用于界面展示；
 * - `capabilities` 是运行时能力声明，缺省时从 tags 回填，保证旧数据不失效；
 * - `purpose` 是"这次调用要干什么"，例如 kb.embed / asr.default / router.intent；
 * - `model_routes` 允许管理员把一个用途显式绑到某个模型，未绑定则按能力和优先级自动挑。
 */
import type { Db } from '@eab/storage'
import { thinkingConfigOf, type ThinkingConfig } from './thinking.js'

export const MODEL_CAPABILITIES = [
  'chat',
  'reasoning',
  'decision',
  'vision',
  'multimodal',
  'code',
  'tool',
  'embedding',
  'rerank',
  'audio',
  'video',
  'long_context',
  'fast',
] as const

export type ModelCapability = (typeof MODEL_CAPABILITIES)[number]

export const MODEL_ENDPOINT_KINDS = [
  'chat',
  'embeddings',
  'rerank',
  'asr',
  'tts',
  'video',
] as const

export type ModelEndpointKind = (typeof MODEL_ENDPOINT_KINDS)[number]

/** 管理后台可选的用途；顺序就是页面上的展示顺序。 */
export const MODEL_ROUTE_PURPOSES = [
  { purpose: 'chat.default', label: '默认对话', hint: '普通问答与工作台默认模型' },
  { purpose: 'chat.vision', label: '图片 / 多模态', hint: '带图片的消息优先走它' },
  { purpose: 'router.intent', label: '意图判定', hint: '决定查人、查制度还是普通问答' },
  { purpose: 'kb.embed', label: '知识库向量化', hint: '切片入库与问题向量化共用' },
  { purpose: 'kb.rerank', label: '检索重排', hint: '可选，提升混合检索准确率' },
  { purpose: 'asr.default', label: '语音转写', hint: '钉钉/企微语音消息转文本' },
  { purpose: 'tts.default', label: '语音合成', hint: '回答转语音条，可选' },
  { purpose: 'video.analyze', label: '视频理解', hint: '异步抽帧、转写与画面描述' },
] as const

export type ModelRoutePurpose = (typeof MODEL_ROUTE_PURPOSES)[number]['purpose']

export interface ModelCapabilityRecord {
  readonly id: string
  readonly name: string
  readonly modelKey: string
  readonly providerId: string
  readonly providerKind: string
  readonly providerName: string
  readonly priority: number
  readonly capabilities: readonly string[]
  readonly endpointKind: string
  readonly inputModalities: readonly string[]
  readonly outputModalities: readonly string[]
  readonly maxContext: number | null
  readonly maxOutputTokens: number | null
  readonly contextCompression: boolean
  readonly embeddingDim: number | null
  readonly config: Record<string, unknown>
  readonly thinking: ThinkingConfig | null
}

const CAPABILITY_ALIASES: Record<string, string> = {
  image: 'vision',
  visual: 'vision',
  'multi_modal': 'multimodal',
  multimodal_input: 'multimodal',
  function_call: 'tool',
  function_calling: 'tool',
  tools: 'tool',
  embed: 'embedding',
  embeddings: 'embedding',
  vector: 'embedding',
  reranker: 'rerank',
  reranking: 'rerank',
  rerank_model: 'rerank',
  speech: 'audio',
  voice: 'audio',
  asr: 'audio',
  tts: 'audio',
  video_understanding: 'video',
  '图片': 'vision',
  '图片识别': 'vision',
  '视觉': 'vision',
  '多模态': 'multimodal',
  '推理': 'reasoning',
  '决策': 'decision',
  '对话': 'chat',
  '代码': 'code',
  '工具调用': 'tool',
  '向量': 'embedding',
  '语音': 'audio',
  '视频': 'video',
  '长文本': 'long_context',
  '快速': 'fast',
}

export function normalizeCapability(raw: string): string {
  const value = raw.trim().toLowerCase()
  return CAPABILITY_ALIASES[value] ?? value
}

function parseJsonList(raw: string | null): string[] {
  if (!raw) return []
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function parseJsonObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const value: unknown = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** capabilities 为空时从 tags 回填；两者都空就返回空数组，不猜能力。 */
export function capabilitiesOf(rawCapabilities: string | null, rawTags: string | null): string[] {
  const declared = parseJsonList(rawCapabilities).map(normalizeCapability)
  const fallback = parseJsonList(rawTags).map(normalizeCapability)
  return [...new Set([...declared, ...fallback])]
}

export function endpointKindOf(rawEndpoint: string | null, capabilities: readonly string[]): string {
  if (rawEndpoint) return rawEndpoint
  if (capabilities.includes('embedding')) return 'embeddings'
  if (capabilities.includes('rerank')) return 'rerank'
  if (capabilities.includes('video')) return 'video'
  if (capabilities.includes('audio')) return 'audio'
  return 'chat'
}

interface ModelRow {
  id: string
  name: string
  model_key: string
  provider_id: string
  provider_kind: string
  provider_name: string
  priority: number
  tags: string | null
  capabilities: string | null
  endpoint_kind: string | null
  input_modalities: string | null
  output_modalities: string | null
  max_context: number | null
  max_output_tokens: number | null
  context_compression: number | null
  embedding_dim: number | null
  config_json: string | null
}

const MODEL_SELECT = `
  SELECT m.id, m.name, m.model_key, m.provider_id, m.priority, m.tags,
         m.capabilities, m.endpoint_kind, m.input_modalities, m.output_modalities,
         m.max_context, m.max_output_tokens, m.context_compression,
         m.embedding_dim, m.config_json,
         p.kind AS provider_kind, p.name AS provider_name
    FROM models m
    JOIN model_providers p ON p.id = m.provider_id
   WHERE m.company_id = ? AND m.enabled = 1 AND m.deleted_at IS NULL
     AND p.deleted_at IS NULL AND p.status = 'active'
`

function toRecord(row: ModelRow): ModelCapabilityRecord {
  const capabilities = capabilitiesOf(row.capabilities, row.tags)
  const config = parseJsonObject(row.config_json)
  return {
    id: row.id,
    name: row.name,
    modelKey: row.model_key,
    providerId: row.provider_id,
    providerKind: row.provider_kind,
    providerName: row.provider_name,
    priority: Number(row.priority),
    capabilities,
    endpointKind: endpointKindOf(row.endpoint_kind, capabilities),
    inputModalities: parseJsonList(row.input_modalities),
    outputModalities: parseJsonList(row.output_modalities),
    maxContext: row.max_context === null ? null : Number(row.max_context),
    maxOutputTokens: row.max_output_tokens === null ? null : Number(row.max_output_tokens),
    contextCompression: row.context_compression === null || Number(row.context_compression) !== 0,
    embeddingDim: row.embedding_dim === null ? null : Number(row.embedding_dim),
    config,
    thinking: thinkingConfigOf(config),
  }
}

export function listModelCapabilities(db: Db, companyId: string): ModelCapabilityRecord[] {
  const rows = db
    .prepare(`${MODEL_SELECT} ORDER BY m.priority DESC, m.name ASC`)
    .all(companyId) as unknown as ModelRow[]
  return rows.map(toRecord)
}

export function findModelById(db: Db, companyId: string, modelId: string): ModelCapabilityRecord | null {
  const row = db.prepare(`${MODEL_SELECT} AND m.id = ?`).get(companyId, modelId) as unknown as ModelRow | undefined
  return row ? toRecord(row) : null
}

export interface ModelProfileSuggestion {
  readonly modelType: 'chat' | 'decision' | 'vision' | 'embedding' | 'rerank' | 'audio' | 'video'
  readonly label: string
  readonly capabilities: readonly string[]
  readonly endpointKind: string
  readonly confidence: 'high' | 'medium' | 'low'
  readonly basis: string
  readonly api: { readonly method: 'POST'; readonly path: string; readonly request: string; readonly response: string }
}

/**
 * 根据模型名推断用途与端点类型。
 *
 * 只用于「导入模型」时给出默认值：OpenAI 的 /models 清单只返回 id/owner，
 * 不返回输入模态、能力或接口类型，所以这里不是协议探测，推断结果必须允许人工改。
 */
export function inferModelProfile(modelKey: string): ModelProfileSuggestion {
  const key = modelKey.trim().toLowerCase()
  const has = (pattern: RegExp) => pattern.test(key)

  if (has(/rerank|reranker|bge-reranker|gte-reranker|jina-reranker|qwen3-reranker|mxbai-rerank|voyage-rerank|cohere-rerank/)) {
    return {
      modelType: 'rerank',
      label: '重排序',
      capabilities: ['rerank'],
      endpointKind: 'rerank',
      confidence: 'high',
      basis: '模型名包含 rerank / reranker',
      api: {
        method: 'POST',
        path: '/rerank',
        request: '{ model, query, documents[], top_n }',
        response: 'results[{ index, relevance_score }]',
      },
    }
  }
  if (has(/embedding|text-embedding|embed-|bge-|bge-m3|e5-|gte-|qwen3-embedding|nomic-embed|jina-embeddings|voyage-|text2vec/)) {
    return {
      modelType: 'embedding',
      label: '向量化',
      capabilities: ['embedding'],
      endpointKind: 'embeddings',
      confidence: 'high',
      basis: '模型名包含 embedding / bge / e5 等向量模型特征',
      api: {
        method: 'POST',
        path: '/embeddings',
        request: '{ model, input[] }',
        response: 'data[{ index, embedding[] }]',
      },
    }
  }
  if (has(/whisper|funasr|paraformer|sensevoice|transcribe|speech-to-text|^asr-|-asr$/)) {
    return {
      modelType: 'audio',
      label: '语音转写',
      capabilities: ['audio'],
      endpointKind: 'asr',
      confidence: 'high',
      basis: '模型名包含 whisper / paraformer / asr 等转写特征',
      api: {
        method: 'POST',
        path: '/audio/transcriptions',
        request: 'multipart: file + model',
        response: '{ text }',
      },
    }
  }
  if (has(/tts|cosyvoice|chattts|text-to-speech|speech-synthesis|voice-clone|f5-tts/)) {
    return {
      modelType: 'audio',
      label: '语音合成',
      capabilities: ['audio'],
      endpointKind: 'tts',
      confidence: 'high',
      basis: '模型名包含 tts / cosyvoice 等合成特征',
      api: {
        method: 'POST',
        path: '/audio/speech',
        request: '{ model, input, voice }',
        response: 'audio binary',
      },
    }
  }
  if (has(/video|internvideo|video-llava|videochat|cogvideo/)) {
    return {
      modelType: 'video',
      label: '视频理解',
      capabilities: ['video'],
      endpointKind: 'video',
      confidence: 'high',
      basis: '模型名包含 video 特征',
      api: {
        method: 'POST',
        path: '/video/analyze（EAB 自定义管线）',
        request: '{ model, frames[], prompt }',
        response: '{ text }',
      },
    }
  }
  if (has(/vision|llava|internvl|pixtral|multimodal|omni|-vl|vl-/)) {
    return {
      modelType: 'vision',
      label: '多模态',
      capabilities: ['chat', 'vision', 'multimodal'],
      endpointKind: 'chat',
      confidence: 'medium',
      basis: '模型名包含 vision / vl / multimodal 特征',
      api: {
        method: 'POST',
        path: '/chat/completions',
        request: '{ model, messages[{ role, content[] }] }',
        response: 'choices[{ message }]',
      },
    }
  }
  if (has(/router|intent|classifier|guard|moderation|decision|judge/)) {
    return {
      modelType: 'decision',
      label: '决策 / 路由',
      capabilities: ['chat', 'reasoning', 'decision'],
      endpointKind: 'chat',
      confidence: 'medium',
      basis: '模型名包含 router / intent / classifier 特征',
      api: {
        method: 'POST',
        path: '/chat/completions',
        request: '{ model, messages[] }',
        response: 'choices[{ message }]',
      },
    }
  }
  return {
    modelType: 'chat',
    label: '对话',
    capabilities: ['chat'],
    endpointKind: 'chat',
    confidence: 'low',
    basis: '未命中类型特征，按普通对话模型处理',
    api: {
      method: 'POST',
      path: '/chat/completions',
      request: '{ model, messages[] }',
      response: 'choices[{ message }]',
    },
  }
}

export function modelSupportsPurpose(model: ModelCapabilityRecord, purpose: string): boolean {
  return purposeMatches(model, purpose)
}

function purposeMatches(model: ModelCapabilityRecord, purpose: string): boolean {
  const capability = model.capabilities
  switch (purpose) {
    case 'chat.default':
      return capability.includes('chat') && model.endpointKind === 'chat'
    case 'chat.vision':
      return (capability.includes('vision') || capability.includes('multimodal')) && model.endpointKind === 'chat'
    case 'router.intent':
      return (
        (capability.includes('decision') || capability.includes('reasoning') || capability.includes('chat')) &&
        model.endpointKind === 'chat'
      )
    case 'kb.embed':
      return capability.includes('embedding') || model.endpointKind === 'embeddings'
    case 'kb.rerank':
      return model.endpointKind === 'rerank'
    case 'asr.default':
      return model.endpointKind === 'asr'
    case 'tts.default':
      return model.endpointKind === 'tts'
    case 'video.analyze':
      return model.endpointKind === 'video' || capability.includes('video')
    default:
      return false
  }
}

interface RouteRow {
  model_id: string
  priority: number
}

/**
 * 解析一个用途最终用哪个模型。
 * 先看显式 model_routes；没有可用绑定时，按能力 + 优先级自动挑。
 * 返回 null 表示"这个用途现在没配模型"，调用方必须走降级而不是报错。
 */
export function resolveModelForPurpose(
  db: Db,
  companyId: string,
  purpose: string,
): ModelCapabilityRecord | null {
  const routes = db
    .prepare(
      `SELECT r.model_id, r.priority
         FROM model_routes r
         JOIN models m ON m.id = r.model_id
         JOIN model_providers p ON p.id = m.provider_id
        WHERE r.company_id = ? AND r.purpose = ? AND r.enabled = 1 AND r.deleted_at IS NULL
          AND m.company_id = ? AND m.enabled = 1 AND m.deleted_at IS NULL
          AND p.deleted_at IS NULL AND p.status = 'active'
        ORDER BY r.priority DESC, m.priority DESC
        LIMIT 8`,
    )
    .all(companyId, purpose, companyId) as unknown as RouteRow[]

  for (const route of routes) {
    const row = db
      .prepare(`${MODEL_SELECT} AND m.id = ?`)
      .get(companyId, route.model_id) as unknown as ModelRow | undefined
    if (!row) continue
    const model = toRecord(row)
    if (purposeMatches(model, purpose)) return model
  }

  const rows = db
    .prepare(`${MODEL_SELECT} ORDER BY m.priority DESC, m.name ASC`)
    .all(companyId) as unknown as ModelRow[]
  return rows.map(toRecord).find((model) => purposeMatches(model, purpose)) ?? null
}

/** 给控制台展示：某个用途当前会落到哪个模型，以及是显式绑定还是自动挑的。 */
export function explainModelRoute(
  db: Db,
  companyId: string,
  purpose: string,
): { model: ModelCapabilityRecord | null; source: 'route' | 'fallback' | 'none' } {
  const bound = db
    .prepare(
      `SELECT r.model_id
         FROM model_routes r
         JOIN models m ON m.id = r.model_id
         JOIN model_providers p ON p.id = m.provider_id
        WHERE r.company_id = ? AND r.purpose = ? AND r.enabled = 1 AND r.deleted_at IS NULL
          AND m.company_id = ? AND m.enabled = 1 AND m.deleted_at IS NULL
          AND p.deleted_at IS NULL AND p.status = 'active'
        ORDER BY r.priority DESC, m.priority DESC
        LIMIT 1`,
    )
    .get(companyId, purpose, companyId) as { model_id: string } | undefined
  if (bound) {
    const row = db.prepare(`${MODEL_SELECT} AND m.id = ?`).get(companyId, bound.model_id) as unknown as
      | ModelRow
      | undefined
    if (row) {
      const model = toRecord(row)
      if (purposeMatches(model, purpose)) return { model, source: 'route' }
    }
  }
  const fallback = resolveModelForPurpose(db, companyId, purpose)
  return { model: fallback, source: fallback ? 'fallback' : 'none' }
}
