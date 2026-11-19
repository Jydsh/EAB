/**
 * 模型实测速度：把真实对话留下的 timing / tokens 聚合成“自动选模”依据。
 *
 * - 回复速度 = 首字延迟 ttftMs（用户看到第一个字要等多久）
 * - 生成速度 = completion tokens / genMs（首字之后每秒能吐多少 token）
 * - 预计回复耗时 = ttftMs + 生成 256 token 的时间，用来同时比较上面两个指标
 *
 * 数据来自 chat_messages.meta_json，不额外探测上游；没有历史样本的模型保持原顺序，
 * 让自动模式在冷启动时仍能工作。显式选模和 Agent 团队的工具决策不走这里。
 */
import type { Db } from '@eab/storage'

/** 用于比较“谁更快回复完一段典型回答”的固定 token 数。 */
export const MODEL_SPEED_TARGET_TOKENS = 256
/** 每个模型最多取最近多少条真实回答，避免少量异常值长期主导。 */
const SAMPLES_PER_MODEL = 20
/** 统计窗口：太旧的速度不能代表当前端点状态。 */
const SAMPLE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
/** 同一家公司短时间内的重复选模共享一次查询。 */
const CACHE_TTL_MS = 15_000

export interface ModelSpeedStat {
  readonly modelId: string
  readonly modelName: string
  readonly samples: number
  /** 首字延迟中位数（毫秒），越小回复越快。 */
  readonly ttftMs: number
  /** 生成速度中位数（token/秒），越大越快。 */
  readonly tokensPerSecond: number
  /** 按 256 token 估算的回复总耗时（毫秒），用于综合排序。 */
  readonly estimatedReplyMs: number
  /** 最近一条样本时间（毫秒）。 */
  readonly measuredAt: number
}

export interface SpeedSample {
  readonly modelId: string
  readonly modelName?: string
  readonly text?: string | null
  readonly reasoning?: string | null
  readonly ttftMs?: number | null
  readonly genMs?: number | null
  readonly completionTokens?: number | null
  readonly createdAt?: number | null
}

export interface SpeedModelLike {
  readonly id: string
  readonly name?: string
  readonly priority?: number
  readonly endpointKind?: string
  readonly capabilities?: readonly string[]
  readonly tags?: readonly string[]
}

interface SpeedCacheEntry {
  readonly createdAt: number
  readonly stats: Map<string, ModelSpeedStat>
}

const cache = new Map<string, SpeedCacheEntry>()

/**
 * 粗略 token 估算，只用于上游没有返回 usage 的情况。
 * 中文/日文/韩文等非 ASCII 字符按 1 token，ASCII 连续文本按 4 字符 1 token。
 * 这是排序用的相对指标，不替代计费 token。
 */
export function estimateTokensFromText(text: string | null | undefined): number {
  const value = String(text ?? '')
  if (!value) return 0
  let tokens = 0
  let asciiRun = 0
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code <= 0x7f) {
      asciiRun += 1
      continue
    }
    if (asciiRun > 0) {
      tokens += Math.ceil(asciiRun / 4)
      asciiRun = 0
    }
    tokens += 1
  }
  if (asciiRun > 0) tokens += Math.ceil(asciiRun / 4)
  return tokens
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

/**
 * 把真实回答样本聚合成按模型的速度统计。
 * 单条样本里 ttft / gen 缺失的直接跳过；completion=0 时用正文与推理文本估算。
 */
export function aggregateModelSpeed(
  samples: readonly SpeedSample[],
): Map<string, ModelSpeedStat> {
  const buckets = new Map<string, {
    modelId: string
    modelName: string
    ttfts: number[]
    tokenSpeeds: number[]
    lastAt: number
  }>()

  for (const sample of samples) {
    const modelId = String(sample.modelId ?? '').trim()
    if (!modelId) continue
    const ttftMs = Number(sample.ttftMs)
    const genMs = Number(sample.genMs)
    if (!Number.isFinite(ttftMs) || ttftMs <= 0) continue
    if (!Number.isFinite(genMs) || genMs <= 0) continue

    const reported = Number(sample.completionTokens)
    const completionTokens = Number.isFinite(reported) && reported > 0
      ? reported
      : estimateTokensFromText(sample.text) + estimateTokensFromText(sample.reasoning)
    if (completionTokens <= 0) continue

    const tokensPerSecond = completionTokens / (genMs / 1000)
    if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) continue

    const existing = buckets.get(modelId) ?? {
      modelId,
      modelName: String(sample.modelName ?? modelId),
      ttfts: [],
      tokenSpeeds: [],
      lastAt: 0,
    }
    existing.modelName = String(sample.modelName ?? existing.modelName)
    existing.ttfts.push(ttftMs)
    existing.tokenSpeeds.push(tokensPerSecond)
    existing.lastAt = Math.max(existing.lastAt, Number(sample.createdAt) || 0)
    buckets.set(modelId, existing)
  }

  const stats = new Map<string, ModelSpeedStat>()
  for (const [modelId, bucket] of buckets) {
    if (bucket.ttfts.length === 0) continue
    const ttftMs = median(bucket.ttfts)
    const tokensPerSecond = median(bucket.tokenSpeeds)
    const estimatedReplyMs = Math.round(
      ttftMs + (MODEL_SPEED_TARGET_TOKENS / tokensPerSecond) * 1000,
    )
    stats.set(modelId, {
      modelId,
      modelName: bucket.modelName,
      samples: bucket.ttfts.length,
      ttftMs: Math.round(ttftMs),
      tokensPerSecond: Number(tokensPerSecond.toFixed(2)),
      estimatedReplyMs,
      measuredAt: bucket.lastAt,
    })
  }
  return stats
}

interface SpeedRow {
  model_id: string
  model_name: string | null
  text: string | null
  reasoning: string | null
  ttft_ms: number | null
  gen_ms: number | null
  completion_tokens: number | null
  created_at: number | null
}

/**
 * 读取某公司最近 30 天、每个模型最近 20 条真实回答的速度统计。
 * 查询用窗口函数按模型取样，避免一个高频模型把其他模型挤出样本。
 */
export function readModelSpeedStats(
  db: Db,
  companyId: string,
  now = Date.now(),
): Map<string, ModelSpeedStat> {
  const cached = cache.get(companyId)
  if (cached && now - cached.createdAt < CACHE_TTL_MS) return cached.stats

  const since = now - SAMPLE_WINDOW_MS
  let rows: SpeedRow[] = []
  try {
    rows = db.prepare(`
      SELECT model_id, model_name, text, reasoning, ttft_ms, gen_ms, completion_tokens, created_at
      FROM (
        SELECT model_id, model_name, text,
               CASE WHEN json_valid(meta_json) THEN json_extract(meta_json, '$.reasoning') END AS reasoning,
               CASE WHEN json_valid(meta_json) THEN json_extract(meta_json, '$.timing.ttftMs') END AS ttft_ms,
               CASE WHEN json_valid(meta_json) THEN json_extract(meta_json, '$.timing.genMs') END AS gen_ms,
               CASE WHEN json_valid(meta_json) THEN json_extract(meta_json, '$.tokens.completion') END AS completion_tokens,
               created_at,
               ROW_NUMBER() OVER (PARTITION BY model_id ORDER BY created_at DESC) AS sample_rank
        FROM chat_messages
        WHERE company_id = ?
          AND role = 'assistant'
          AND model_id IS NOT NULL
          AND created_at >= ?
      )
      WHERE sample_rank <= ?
    `).all(companyId, since, SAMPLES_PER_MODEL) as unknown as SpeedRow[]
  } catch (error) {
    // 速度统计只是自动选模的优化项；表结构异常或旧库没有相关字段时不能让对话不可用。
    console.warn(`[model-speed] 读取实测速度失败，回退原顺序：${String(error)}`)
    rows = []
  }

  const stats = aggregateModelSpeed(rows.map((row) => ({
    modelId: String(row.model_id),
    modelName: row.model_name ?? undefined,
    text: row.text,
    reasoning: row.reasoning,
    ttftMs: row.ttft_ms,
    genMs: row.gen_ms,
    completionTokens: row.completion_tokens,
    createdAt: row.created_at,
  })))
  cache.set(companyId, { createdAt: now, stats })
  return stats
}

/** 新回答落库后清掉缓存，下一条消息立即使用最新样本。 */
export function invalidateModelSpeedStats(companyId?: string): void {
  if (companyId) {
    cache.delete(companyId)
    return
  }
  cache.clear()
}

/**
 * 按实测速度排序：有样本的模型按预计回复耗时升序，没有样本的模型保持调用方给的顺序。
 * 显式 `priority` 只在实测样本完全缺失时作为调用方的原始顺序保留，不参与已测模型排序。
 */
export function rankModelsBySpeed<T extends SpeedModelLike>(
  models: readonly T[],
  stats: ReadonlyMap<string, ModelSpeedStat>,
): T[] {
  const measured: T[] = []
  const unmeasured: T[] = []
  for (const model of models) {
    if (stats.has(model.id)) measured.push(model)
    else unmeasured.push(model)
  }
  measured.sort((left, right) => {
    const leftStat = stats.get(left.id)!
    const rightStat = stats.get(right.id)!
    return leftStat.estimatedReplyMs - rightStat.estimatedReplyMs
      || rightStat.tokensPerSecond - leftStat.tokensPerSecond
      || leftStat.ttftMs - rightStat.ttftMs
      || (left.name ?? left.id).localeCompare(right.name ?? right.id)
  })
  return [...measured, ...unmeasured]
}

/** 取实测速度最快的模型；没有速度样本时返回第一个候选，由调用方保持原有兜底。 */
export function pickFastestModel<T extends SpeedModelLike>(
  models: readonly T[],
  stats: ReadonlyMap<string, ModelSpeedStat>,
): T | undefined {
  return rankModelsBySpeed(models, stats)[0]
}
