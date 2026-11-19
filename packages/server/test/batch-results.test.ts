import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EabError } from '@eab/domain'
import { parseTabularBatchText, readBatchPage, saveTextBatch, saveToolResultBatch } from '../src/batch-results.js'

const dirs: string[] = []

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'eab-batch-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function rows(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    姓名: '张辉权',
    部门: index % 2 === 0 ? '安全部' : '生产部',
    状态: '进行中',
  }))
}

describe('大工具结果批次', () => {
  it('从氚云信封里识别记录数组并落盘，分页读取保持原始顺序', () => {
    const dataDir = makeDir()
    const saved = saveToolResultBatch({
      dataDir,
      companyId: 'c1',
      userId: 'u1',
      toolId: 'plugin:dsh-cy-api:cy_api_dsh_0c7d',
      payload: { ok: true, result: { ReturnData: { data: rows(500) } } },
      minChars: 1_000,
    })

    expect(saved).not.toBeNull()
    expect(saved?.totalRows).toBe(500)
    expect(saved?.columns).toContain('姓名')

    const page = readBatchPage({
      dataDir,
      companyId: 'c1',
      userId: 'u1',
      batchId: saved!.id,
      offset: 10,
      limit: 20,
    })
    expect(page.totalRows).toBe(500)
    expect(page.rows).toHaveLength(20)
    expect((page.rows[0] as Record<string, unknown>).id).toBe(11)
    expect(page.remaining).toBe(470)
  })

  it('结果未超过预算时不重复落盘', () => {
    const dataDir = makeDir()
    const saved = saveToolResultBatch({
      dataDir,
      companyId: 'c1',
      userId: 'u1',
      toolId: 'small',
      payload: { data: rows(3) },
      minChars: 32_000,
    })
    expect(saved).toBeNull()
  })

  it('批次只允许所属员工读取', () => {
    const dataDir = makeDir()
    const saved = saveToolResultBatch({
      dataDir,
      companyId: 'c1',
      userId: 'u1',
      toolId: 'plugin',
      payload: { data: rows(50) },
      minChars: 1_000,
    })
    expect(() =>
      readBatchPage({
        dataDir,
        companyId: 'c1',
        userId: 'u2',
        batchId: saved!.id,
      }),
    ).toThrow(EabError)
  })

  it('不是记录数组但正文超过阈值时按文本批次落盘，并按字符分页读取', () => {
    const dataDir = makeDir()
    const text = Array.from({ length: 800 }, (_, index) => `第 ${index + 1} 行：张辉权的目标与计划。`).join('\n')
    const saved = saveToolResultBatch({
      dataDir,
      companyId: 'c1',
      userId: 'u1',
      toolId: 'document.read',
      payload: { ok: true, result: { content: text } },
      minChars: 1_000,
    })
    expect(saved).not.toBeNull()
    expect(saved?.kind).toBe('text')
    expect(saved?.totalRows).toBe(0)
    expect(saved?.chars).toBe(text.length)

    const page = readBatchPage({
      dataDir,
      companyId: 'c1',
      userId: 'u1',
      batchId: saved!.id,
      offset: 100,
      limit: 500,
    })
    expect(page.kind).toBe('text')
    expect(page.totalChars).toBe(text.length)
    expect(page.text).toBe(text.slice(100, 600))
    expect(page.remaining).toBe(text.length - 600)
  })

  it('附件文本可独立保存为文本批次，短文本不重复落盘', () => {
    const dataDir = makeDir()
    const text = '张辉权的计划内容。'.repeat(1_500)
    const saved = saveTextBatch({
      dataDir,
      companyId: 'c1',
      userId: 'u1',
      toolId: 'attachment:计划.csv',
      text,
      minChars: 12_000,
    })
    expect(saved).not.toBeNull()
    expect(saved?.kind).toBe('text')
    expect(saved?.chars).toBe(text.length)

    const short = saveTextBatch({
      dataDir,
      companyId: 'c1',
      userId: 'u1',
      toolId: 'attachment:短.txt',
      text: '只有一小段。',
      minChars: 12_000,
    })
    expect(short).toBeNull()

    expect(() =>
      readBatchPage({
        dataDir,
        companyId: 'c1',
        userId: 'u2',
        batchId: saved!.id,
      }),
    ).toThrow(EabError)
  })

  it('同一响应里有多个数组时取最大的记录数组', () => {
    const dataDir = makeDir()
    const saved = saveToolResultBatch({
      dataDir,
      companyId: 'c1',
      userId: 'u1',
      toolId: 'plugin:multi-array',
      payload: {
        data: [{ 提示: '不是记录' }, { 提示: '也不是' }],
        records: rows(120),
      },
      minChars: 1_000,
    })
    expect(saved?.kind).toBe('rows')
    expect(saved?.totalRows).toBe(120)
  })

  it('小数组配大正文字段时不丢正文，改按文本批次保存', () => {
    const dataDir = makeDir()
    const body = `正文开始\n${'张辉权的计划内容。'.repeat(1_200)}\n正文末尾标记：蓝鲸-7742`
    const saved = saveToolResultBatch({
      dataDir,
      companyId: 'c1',
      userId: 'u1',
      toolId: 'plugin:small-array-big-body',
      payload: {
        data: [{ a: 1 }, { a: 2 }],
        body,
      },
      minChars: 1_000,
    })
    expect(saved?.kind).toBe('text')
    const page = readBatchPage({
      dataDir,
      companyId: 'c1',
      userId: 'u1',
      batchId: saved!.id,
      offset: 0,
      limit: 20_000,
    })
    expect(page.text).toContain('蓝鲸-7742')
  })

  it('CSV 文本批次按行还原成全量记录，不再按字符切段', () => {
    const csv = '站名,问题类别,严重程度描述\n贵阳北（弱电）,A,一般\n贵阳北（机电）,B,严重\n眉山东,A,一般\n'
    const table = parseTabularBatchText(csv, 'attachment:检查整治_近半个月_343条.csv')
    expect(table?.columns).toEqual(['站名', '问题类别', '严重程度描述'])
    expect(table?.rows).toHaveLength(3)
    expect(table?.rows[0]).toMatchObject({ 站名: '贵阳北（弱电）', 问题类别: 'A' })
    expect(parseTabularBatchText('普通文章，不是表格。\n第二行。', 'attachment:说明.txt')).toBeNull()
  })

  it('默认日志级别不把批次落盘和进度写进控制台', () => {
    const oldLevel = process.env.EAB_LOG_LEVEL
    delete process.env.EAB_LOG_LEVEL
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const dataDir = makeDir()
      const saved = saveToolResultBatch({
        dataDir,
        companyId: 'c1',
        userId: 'u1',
        toolId: 'plugin:quiet',
        payload: { data: rows(500) },
        minChars: 1_000,
      })
      expect(saved?.totalRows).toBe(500)
      expect(info).not.toHaveBeenCalled()
      expect(warn).not.toHaveBeenCalled()
    } finally {
      info.mockRestore()
      warn.mockRestore()
      if (oldLevel === undefined) delete process.env.EAB_LOG_LEVEL
      else process.env.EAB_LOG_LEVEL = oldLevel
    }
  })
})
