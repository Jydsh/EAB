import { describe, expect, it } from 'vitest'
import type { KbBlock } from '../src/kb-splitter.js'
import { cleanKbBlocks } from '../src/kb-cleaner.js'

function block(text: string, type: KbBlock['type'], meta: Record<string, unknown> = {}): KbBlock {
  return { id: type, text, type, headingPath: [], meta }
}

describe('cleanKbBlocks', () => {
  it('保留表格制表符与空单元格，不把列压成空格', () => {
    const table = block('事项\t金额\t备注\n奖励\t60\t/\n\t120\t改进观察', 'table')
    const result = cleanKbBlocks([table])
    expect(result.blocks[0]!.text.split('\n')).toEqual(['事项\t金额\t备注', '奖励\t60\t/', '\t120\t改进观察'])
  })

  it('不把表格里的纯数字单元格当成页码删除', () => {
    const table = block('程度值\t金额\n0\t口头表扬\n1\t60', 'table')
    const result = cleanKbBlocks([table])
    expect(result.removedLines).toBe(0)
    expect(result.blocks[0]!.text).toContain('0\t口头表扬')
    expect(result.blocks[0]!.text).toContain('1\t60')
  })

  it('代码块保留缩进和制表符，正文仍清理页码行', () => {
    const code = block('function demo() {\n\treturn 1\n}', 'code')
    const paragraph = block('正文\n第 2 页\n继续', 'paragraph')
    const result = cleanKbBlocks([code, paragraph])
    expect(result.blocks[0]!.text).toBe('function demo() {\n\treturn 1\n}')
    expect(result.blocks[1]!.text).toBe('正文\n继续')
    expect(result.removedLines).toBe(1)
  })
})
