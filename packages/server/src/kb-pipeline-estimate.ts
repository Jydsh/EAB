/**
 * 知识库四步流水线的耗时预估。
 *
 * 这里只做“可解释的粗略预估”，不假装精确：
 * - 已解析的文档按真实字符数、块数、图片数和切片数估算；
 * - 尚未解析的文件按文件大小和页数估算；
 * - 清洗按实际批次吞吐估算：批次数 × 单批耗时，已用 README 与 5 万字真实文档校准；
 * - 任何一步都给出下限，避免 UI 出现“预计 0 秒”。
 *
 * 预估结果用于展示和给文档级超时留预算，不参与是否成功的判断。
 */
export type KbPipelineStage = 'parse' | 'clean' | 'chunk' | 'index'

export interface KbEstimateInput {
  readonly rawChars: number
  readonly sizeBytes: number
  readonly pageCount: number
  readonly imageCount: number
  readonly blockCount: number
  readonly chunkCount: number
  readonly chunkSize: number
  /** rules | model | auto | null；auto 按模型清洗估算。 */
  readonly cleanMode: string | null
  readonly hasEmbeddingModel: boolean
}

export interface KbPipelineEstimates {
  readonly parse: number
  readonly clean: number
  readonly chunk: number
  readonly index: number
  readonly total: number
  /** rough：只按文件大小/页数估；content：已拿到真实字符和块数。 */
  readonly confidence: 'rough' | 'content'
  /** 估算依据，便于 UI 悬浮说明。 */
  readonly basis: {
    readonly chars: number
    readonly blocks: number
    readonly pages: number
    readonly chunks: number
    readonly cleanBatches: number
    readonly embeddingCalls: number
  }
}

const MAX_BATCH_CHARS = 6000
const MAX_BATCH_BLOCKS = 12
const EMBED_BATCH = 32

function clampSeconds(value: number): number {
  return Math.max(1, Math.round(value))
}

function effectiveChars(input: KbEstimateInput): number {
  if (input.rawChars > 0) return input.rawChars
  // 未解析时只能按文件体积估；中文 UTF-8 约 3 字节/字，混合文本取 2.2。
  return Math.max(1, Math.round(input.sizeBytes / 2.2))
}

function effectiveBlocks(input: KbEstimateInput, chars: number): number {
  if (input.blockCount > 0) return input.blockCount
  // 版式解析通常 120~180 字符一个结构块；160 是 README/普通文档的中间值。
  return Math.max(1, Math.ceil(chars / 160))
}

function effectivePages(input: KbEstimateInput): number {
  if (input.pageCount > 0) return input.pageCount
  if (input.rawChars > 0) return 1
  return Math.max(1, Math.ceil(input.sizeBytes / 40_000))
}

export function estimateKbPipeline(input: KbEstimateInput): KbPipelineEstimates {
  const chars = effectiveChars(input)
  const blocks = effectiveBlocks(input, chars)
  const pages = effectivePages(input)
  const chunkSize = Math.max(80, Number(input.chunkSize) || 500)
  const chunks =
    input.chunkCount > 0
      ? input.chunkCount
      : Math.max(Math.ceil(chars / Math.max(120, chunkSize * 0.55)), Math.ceil(blocks * 0.6))

  const parse = clampSeconds(1.0 + pages * 0.5 + input.imageCount * 2.8 + chars / 200_000)
  const modelClean = input.cleanMode === 'model' || input.cleanMode === 'auto' || input.cleanMode === null
  const cleanBatches = modelClean
    ? Math.max(Math.ceil(blocks / MAX_BATCH_BLOCKS), Math.ceil(chars / MAX_BATCH_CHARS))
    : 0
  /*
   * 真实实测（8.5k 字符 / 5 批 = 43 秒，51k 字符 / 27 批 = 242 秒）表明：
   * 并发 3 时瓶颈是每批模型生成的 token 吞吐，整篇耗时基本按“批次数 × 单批耗时”线性增长，
   * 而不是按三批一波的波次数增长。单批耗时约 7.6~8.3 秒，随批内字符数缓慢上升。
   */
  const clean = modelClean
    ? clampSeconds(5 + cleanBatches * (7.6 + Math.min(MAX_BATCH_CHARS, chars / Math.max(1, cleanBatches)) / 600 * 0.2))
    : clampSeconds(0.6 + chars / 50_000 * 0.4)
  const chunk = clampSeconds(0.5 + chars / 100_000 * 0.4 + chunks * 0.003)
  const embeddingCalls = input.hasEmbeddingModel ? Math.ceil(chunks / EMBED_BATCH) : 0
  const index = clampSeconds(input.hasEmbeddingModel ? 1.0 + embeddingCalls * 0.5 : 0.4)

  return {
    parse,
    clean,
    chunk,
    index,
    total: parse + clean + chunk + index,
    confidence: input.rawChars > 0 ? 'content' : 'rough',
    basis: { chars, blocks, pages, chunks, cleanBatches, embeddingCalls },
  }
}

/** 文档级模型清洗预算：按预估清洗时间留 2.5 倍余量，4~20 分钟封顶。 */
export function modelCleanTimeoutMs(input: KbEstimateInput): number {
  const estimate = estimateKbPipeline(input)
  const budget = Math.round((estimate.clean * 2.5 + 60) * 1000)
  return Math.max(4 * 60 * 1000, Math.min(20 * 60 * 1000, budget))
}

const ACTIVE_STAGE: Record<string, KbPipelineStage> = {
  parsing: 'parse',
  cleaning: 'clean',
  chunking: 'chunk',
  indexing: 'index',
}

const DONE_THROUGH: Record<string, number> = {
  parsed: 0,
  cleaned: 1,
  chunked: 2,
  indexed: 3,
}

/**
 * 计算当前步骤和剩余时间。
 *
 * - 已完成步骤不参与剩余；
 * - 当前步骤有进度时按“剩余比例”折算，没有进度时按“预估 - 已用时”；
 * - 失败/待配置不承诺剩余时间。
 */
export function remainingPipelineSeconds(
  estimate: KbPipelineEstimates,
  pipelineStage: string,
  progress: number,
  stageStartedAt: number | null,
  now = Date.now(),
): { activeStage: KbPipelineStage | null; remaining: number | null } {
  if (pipelineStage === 'failed' || pipelineStage === 'needs_config') {
    return { activeStage: null, remaining: null }
  }
  if (pipelineStage === 'indexed') {
    return { activeStage: null, remaining: 0 }
  }
  const activeStage = ACTIVE_STAGE[pipelineStage] ?? (pipelineStage === 'uploaded' ? 'parse' : null)
  const doneThrough = DONE_THROUGH[pipelineStage] ?? -1
  const stages: readonly KbPipelineStage[] = ['parse', 'clean', 'chunk', 'index']
  let remaining = 0
  stages.forEach((stage, index) => {
    if (index <= doneThrough) return
    const stepEstimate = estimate[stage]
    if (activeStage === stage) {
      const elapsed = stageStartedAt ? Math.max(0, (now - stageStartedAt) / 1000) : 0
      const byProgress = progress > 0.02 ? stepEstimate * (1 - Math.min(0.98, progress)) : null
      remaining += byProgress ?? Math.max(1, stepEstimate - elapsed)
    } else {
      remaining += stepEstimate
    }
  })
  return { activeStage, remaining: Math.max(0, Math.round(remaining)) }
}

export function formatEstimateSeconds(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  if (rest === 0) return `${minutes} 分钟`
  return `${minutes} 分 ${rest} 秒`
}
