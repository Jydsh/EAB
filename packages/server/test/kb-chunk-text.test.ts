import { describe, expect, it } from 'vitest'
import {
  chunkEmbeddingText,
  chunkRetrievalText,
  headingPathFromMeta,
  headingLineFromMeta,
} from '../src/kb-chunk-text.js'

describe('kb chunk retrieval text', () => {
  it('把标题路径拼到正文前，让制度条框参与关键词和向量召回', () => {
    const meta = JSON.stringify({
      headingPath: ['快奖快罚管理制度（2026 版）', '三、申诉、执行与公示'],
    })
    expect(headingPathFromMeta(meta)).toEqual(['快奖快罚管理制度（2026 版）', '三、申诉、执行与公示'])
    expect(headingLineFromMeta(meta)).toBe('快奖快罚管理制度（2026 版） > 三、申诉、执行与公示')
    expect(chunkRetrievalText(meta, '快罚自决定书下达 72 小时内可提出异议。')).toBe(
      '快奖快罚管理制度（2026 版） > 三、申诉、执行与公示\n快罚自决定书下达 72 小时内可提出异议。',
    )
    expect(chunkEmbeddingText(meta, '快罚自决定书下达 72 小时内可提出异议。')).toBe(
      chunkRetrievalText(meta, '快罚自决定书下达 72 小时内可提出异议。'),
    )
  })

  it('正文已包含完整标题路径时不再重复', () => {
    const meta = JSON.stringify({ headingPath: ['制度', '一、定位与目标'] })
    expect(chunkRetrievalText(meta, '制度 > 一、定位与目标\n正文')).toBe('制度 > 一、定位与目标\n正文')
    expect(chunkRetrievalText(meta, '一、定位与目标 正文直接以标题开头')).toBe(
      '制度 > 一、定位与目标\n一、定位与目标 正文直接以标题开头',
    )
  })

  it('元数据缺失或损坏时退回正文，不影响旧切片', () => {
    expect(headingPathFromMeta(null)).toEqual([])
    expect(headingPathFromMeta('not-json')).toEqual([])
    expect(chunkRetrievalText(null, '旧切片正文')).toBe('旧切片正文')
    expect(chunkRetrievalText('{"headingPath":[]}', '旧切片正文')).toBe('旧切片正文')
  })
})
