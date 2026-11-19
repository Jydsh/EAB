import { describe, expect, it } from 'vitest'
import {
  buildWorkspaceToolView,
  summarizeBatchToolResult,
  summarizeWorkspaceFileToolResult,
  summarizeWorkspaceReadToolResult,
} from '../src/routes/chat.js'

describe('批次工具的工具卡摘要', () => {
  it('分页读取记录时给出范围和剩余，而不是原始 JSON', () => {
    const text = summarizeBatchToolResult('batch_read', {
      batchId: 'aae11716-754e-4d0b-a8b7-43ec79e39d2c',
      kind: 'rows',
      offset: 0,
      totalRows: 6425,
      rows: new Array(50).fill({ 姓名: '张辉权' }),
      remaining: 6375,
    })
    expect(text).toContain('批次 aae11716')
    expect(text).toContain('记录第 1–50 条 / 共 6425 条')
    expect(text).toContain('剩余 6375')
    expect(text).not.toContain('张辉权')
  })

  it('分页读取文本时按字符给出范围', () => {
    const text = summarizeBatchToolResult('batch_read', {
      kind: 'text',
      totalChars: 31188,
      offset: 0,
      text: 'x'.repeat(4000),
      remaining: 27188,
    })
    expect(text).toContain('文本第 1–4000 字符 / 共 31188 字符')
    expect(text).toContain('剩余 27188')
  })

  it('全量分析给出段数、失败数和覆盖范围', () => {
    const text = summarizeBatchToolResult('batch_analyze', {
      kind: 'text',
      totalChars: 31188,
      chunks: 2,
      failedChunks: 0,
      answer: '蓝鲸-7742，张辉权 37 条',
    })
    expect(text).toContain('全量分批分析｜2 段 / 失败 0')
    expect(text).toContain('31188 字符')
    expect(text).toContain('覆盖 2/2')
    expect(text).toContain('蓝鲸-7742')
  })

  it('非批次工具不接管摘要', () => {
    expect(summarizeBatchToolResult('workspace_read', { text: 'hello' })).toBeNull()
  })
})

describe('文件读写工具的工具卡摘要', () => {
  it('按行读取只给行段、剩余和续读位置，不把正文当摘要', () => {
    const text = summarizeWorkspaceReadToolResult('workspace_read', {
      path: 'code-range-test.ts',
      startLine: 16,
      endLine: 20,
      totalLines: 30,
      text: 'private-content-marker',
      truncated: true,
      nextOffset: 21,
    })
    expect(text).toContain('读取 code-range-test.ts')
    expect(text).toContain('第 16–20 行 / 共 30 行')
    expect(text).toContain('剩余 10')
    expect(text).toContain('继续 offset=21')
    expect(text).not.toContain('private-content-marker')
  })

  it('读取全文时直接说明总行数', () => {
    const text = summarizeWorkspaceReadToolResult('workspace_read', {
      path: 'small.md',
      startLine: 1,
      endLine: 12,
      totalLines: 12,
      truncated: false,
    })
    expect(text).toBe('读取 small.md｜全文 12 行')
  })

  it('达到字节上限时在同一括号里说明剩余行和上限', () => {
    const text = summarizeWorkspaceReadToolResult('workspace_read', {
      path: 'big.ts',
      startLine: 250001,
      endLine: 251505,
      totalLines: 300000,
      truncated: true,
      truncatedByBytes: true,
      nextOffset: 251506,
    })
    expect(text).toBe('读取 big.ts｜第 250001–251505 行 / 共 300000 行（剩余 48495 行，达到 50 KB 输出上限）｜继续 offset=251506')
  })

  it('全量概览说明总字符、总行数、记录数和覆盖情况', () => {
    const text = summarizeWorkspaceReadToolResult('workspace_read', {
      path: '大文件.csv',
      mode: 'overview',
      totalChars: 1_200_000,
      totalLines: 20_000,
      totalRows: 5_000,
      coverage: '已完整解析全部 5000 条记录，字段统计覆盖 100% 记录',
      answer: 'private-analysis-marker',
    })
    expect(text).toContain('分析 大文件.csv')
    expect(text).toContain('全文 1,200,000 字符 / 20,000 行 / 5,000 条记录')
    expect(text).toContain('覆盖 100% 记录')
    expect(text).not.toContain('private-analysis-marker')
  })

  it('搜索显示命中数、扫描文件数和首个 path:line', () => {
    const text = summarizeWorkspaceFileToolResult('workspace_search', {
      query: '蓝鲸-行号-18',
      count: 1,
      total: 1,
      filesScanned: 35,
      truncated: false,
      matches: [{ path: 'code-range-test.ts', line: 18, column: 29, text: 'export const batchMarker = "蓝鲸-行号-18"' }],
    })
    expect(text).toContain('搜索“蓝鲸-行号-18”｜1 处命中')
    expect(text).toContain('扫描 35 个文件')
    expect(text).toContain('首个 code-range-test.ts:18')
  })

  it('命中总数多于返回条数时说明截断', () => {
    const text = summarizeWorkspaceFileToolResult('workspace_search', {
      query: 'needle',
      count: 3,
      total: 10,
      filesScanned: 2,
      truncated: true,
      matches: [{ path: 'many.txt', line: 1, column: 1, text: 'Needle' }],
    })
    expect(text).toContain('显示 3 条 / 共 10 处命中（已截断）')
  })

  it('正文 0 命中但文件名命中时把可用路径直接写给模型', () => {
    const text = summarizeWorkspaceFileToolResult('workspace_search', {
      query: '检查整治_近半个月_343 条.csv',
      count: 0,
      total: 0,
      filesScanned: 88,
      matches: [],
      nameMatches: [{ path: '检查整治_近半个月_343条.csv', name: '检查整治_近半个月_343条.csv' }],
    })
    expect(text).toContain('0 处命中')
    expect(text).toContain('文件名命中 1 个：检查整治_近半个月_343条.csv')
  })
})

describe('文件工具的结构化展示视图', () => {
  it('读取视图只带路径、行段和有界预览', () => {
    const view = buildWorkspaceToolView('workspace_read', {
      path: 'big.ts',
      size: 9_000_000,
      startLine: 1,
      endLine: 2000,
      totalLines: 300000,
      truncated: true,
      truncatedByBytes: false,
      longLines: 2,
      nextOffset: 2001,
      text: Array.from({ length: 30 }, (_, index) => `line-${index + 1}`).join('\n'),
    })
    expect(view?.kind).toBe('read')
    if (!view || view.kind !== 'read') return
    expect(view.path).toBe('big.ts')
    expect(view.totalLines).toBe(300000)
    expect(view.nextOffset).toBe(2001)
    expect(view.previewText).toContain('line-1')
    expect(view.previewText).not.toContain('line-21')
  })

  it('搜索视图只保留前 8 条命中', () => {
    const view = buildWorkspaceToolView('workspace_search', {
      query: 'needle',
      path: 'src',
      count: 30,
      total: 120,
      filesScanned: 35,
      truncated: true,
      timeLimitHit: false,
      matches: Array.from({ length: 30 }, (_, index) => ({
        path: 'src/app.ts',
        line: index + 1,
        column: 1,
        text: `needle-${index + 1}`,
      })),
    })
    expect(view?.kind).toBe('search')
    if (!view || view.kind !== 'search') return
    expect(view.total).toBe(120)
    expect(view.matches).toHaveLength(8)
    expect(view.matches[7].text).toBe('needle-8')
  })
})
