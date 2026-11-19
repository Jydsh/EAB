import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Db } from '@eab/storage'
import type { KbBlock } from '../src/kb-splitter.js'

const { callModelMock } = vi.hoisted(() => ({ callModelMock: vi.fn() }))

vi.mock('../src/llm.js', () => ({ callModel: callModelMock }))

import { cleanBlocksWithModel } from '../src/kb-model-clean.js'

function blocks(count: number): KbBlock[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `b${index}`,
    text: `第 ${index + 1} 段正文，保留 IP 10.0.0.${index + 1}。`,
    type: 'paragraph',
    headingPath: [],
  }))
}

function echoBatch(messages: unknown[]) {
  const body = (messages[4] as Array<{ content: string }>)[1]!.content
  const start = Number(/【块(\d+)】/.exec(body)?.[1] ?? 0)
  // 第二批复刻模型把编号重新从 1 开始的情况，验证会映射回整篇序号。
  const text =
    start > 0
      ? body.replace(/【块(\d+)】/g, (_match, value: string) => `【块${Number(value) - start + 1}】`)
      : body
  return { text }
}

describe('cleanBlocksWithModel', () => {
  beforeEach(() => {
    callModelMock.mockReset()
    callModelMock.mockImplementation(async (...args: unknown[]) => echoBatch(args))
  })

  it('长文档按小批次有限并发，不再为 53 个块串行发起 7 次请求', async () => {
    const result = await cleanBlocksWithModel(null as unknown as Db, ':memory:', 'c1', 'model-clean', blocks(53))

    expect(callModelMock).toHaveBeenCalledTimes(5)
    expect(result.blocks).toHaveLength(53)
    expect(result.keptOriginalCount).toBe(0)
  })

  it('单批模型失败时保留该批原文，不把整篇清洗判失败', async () => {
    callModelMock.mockRejectedValueOnce(new Error('模型请求超时'))

    const result = await cleanBlocksWithModel(null as unknown as Db, ':memory:', 'c1', 'model-clean', blocks(53))

    expect(result.blocks).toHaveLength(53)
    expect(result.keptOriginalCount).toBeGreaterThan(0)
  })

  it('表格和代码块不交给模型改写，清洗后原样保留在原有位置', async () => {
    const input: KbBlock[] = [
      ...blocks(2),
      { id: 'table-1', text: '列A\t列B\n奖励\t60', type: 'table', headingPath: [] },
      { id: 'code-1', text: 'npm run build\n\t--watch', type: 'code', headingPath: [] },
    ]
    const result = await cleanBlocksWithModel(null as unknown as Db, ':memory:', 'c1', 'model-clean', input)

    expect(callModelMock).toHaveBeenCalledTimes(1)
    const body = (callModelMock.mock.calls[0]![4] as Array<{ content: string }>)[1]!.content
    expect(body).not.toContain('列A')
    expect(body).not.toContain('npm run build')
    expect(result.blocks.map((block) => block.type)).toEqual(['paragraph', 'paragraph', 'table', 'code'])
    expect(result.blocks[2]).toEqual(input[2])
    expect(result.blocks[3]).toEqual(input[3])
  })

  it('只有表格/代码/图片时跳过模型，不发起请求', async () => {
    const input: KbBlock[] = [
      { id: 'table-1', text: '列A\t列B\n1\t2', type: 'table', headingPath: [] },
      { id: 'image-1', text: '[图片] 插图', type: 'image', headingPath: [] },
    ]
    const result = await cleanBlocksWithModel(null as unknown as Db, ':memory:', 'c1', 'model-clean', input)

    expect(callModelMock).not.toHaveBeenCalled()
    expect(result.blocks).toEqual(input)
  })
})
