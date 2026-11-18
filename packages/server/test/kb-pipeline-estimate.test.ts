import { describe, expect, it } from 'vitest'
import {
  estimateKbPipeline,
  formatEstimateSeconds,
  modelCleanTimeoutMs,
  remainingPipelineSeconds,
  type KbEstimateInput,
} from '../src/kb-pipeline-estimate.js'

function input(chars: number, overrides: Partial<KbEstimateInput> = {}): KbEstimateInput {
  return {
    rawChars: chars,
    sizeBytes: chars * 2.2,
    pageCount: 1,
    imageCount: 0,
    blockCount: Math.ceil(chars / 160),
    chunkCount: 0,
    chunkSize: 500,
    cleanMode: 'model',
    hasEmbeddingModel: true,
    ...overrides,
  }
}

describe('kb pipeline estimate', () => {
  it('几万字文档的清洗时间和总时间随内容增长，且不是固定 4 分钟', () => {
    const thirty = estimateKbPipeline(input(30_000))
    const fifty = estimateKbPipeline(input(50_000))
    const hundred = estimateKbPipeline(input(100_000))
    expect(thirty.clean).toBeLessThan(fifty.clean)
    expect(fifty.clean).toBeLessThan(hundred.clean)
    expect(thirty.total).toBeGreaterThan(40)
    expect(hundred.total).toBeGreaterThan(fifty.total)
    expect(thirty.confidence).toBe('content')
    expect(thirty.basis.cleanBatches).toBeGreaterThan(1)
  })

  it('未解析文件按体积给出粗略预估，且至少 1 秒', () => {
    const rough = estimateKbPipeline(
      input(0, { rawChars: 0, sizeBytes: 2_000_000, blockCount: 0, pageCount: 50, chunkCount: 0 }),
    )
    expect(rough.confidence).toBe('rough')
    expect(rough.parse).toBeGreaterThan(10)
    expect(rough.total).toBeGreaterThan(60)
  })

  it('清洗预估贴近真实批次吞吐：8.5k 约 43 秒、51k 约 242 秒', () => {
    const readme = estimateKbPipeline(input(8_485, { blockCount: 54 }))
    const large = estimateKbPipeline(input(51_016, { blockCount: 324 }))
    expect(readme.clean).toBeGreaterThanOrEqual(38)
    expect(readme.clean).toBeLessThanOrEqual(52)
    expect(large.clean).toBeGreaterThanOrEqual(210)
    expect(large.clean).toBeLessThanOrEqual(255)
  })

  it('文档级清洗预算随预估增长，并限制在 4~20 分钟', () => {
    expect(modelCleanTimeoutMs(input(8_000))).toBe(4 * 60 * 1000)
    expect(modelCleanTimeoutMs(input(100_000))).toBeGreaterThan(4 * 60 * 1000)
    expect(modelCleanTimeoutMs(input(1_000_000))).toBe(20 * 60 * 1000)
  })

  it('清洗中按完成批次折算剩余时间，完成后为 0', () => {
    const estimate = estimateKbPipeline(input(30_000))
    const running = remainingPipelineSeconds(estimate, 'cleaning', 0.5, Date.now())
    expect(running.activeStage).toBe('clean')
    expect(running.remaining).toBeGreaterThan(Math.round(estimate.clean * 0.4))
    expect(running.remaining).toBeLessThanOrEqual(estimate.clean * 0.5 + estimate.chunk + estimate.index + 4)
    const done = remainingPipelineSeconds(estimate, 'indexed', 0, null)
    expect(done.remaining).toBe(0)
    const failed = remainingPipelineSeconds(estimate, 'failed', 0, null)
    expect(failed.remaining).toBeNull()
  })

  it('耗时文案对秒、分钟和分秒混合都可读', () => {
    expect(formatEstimateSeconds(45)).toBe('45 秒')
    expect(formatEstimateSeconds(90)).toBe('1 分 30 秒')
    expect(formatEstimateSeconds(120)).toBe('2 分钟')
  })
})
