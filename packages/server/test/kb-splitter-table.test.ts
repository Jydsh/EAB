import { describe, expect, it } from 'vitest'
import type { KbBlock } from '../src/kb-splitter.js'
import { splitKbBlocks } from '../src/kb-splitter.js'

function tableBlock(): KbBlock {
  return {
    id: 'table',
    type: 'table',
    headingPath: ['制度', '附件：3、快奖程度值及情形、金额、审批、公告范围'],
    rowRange: [3, 12],
    meta: {
      format: 'docx',
      tableCaption: '快奖程度值及情形',
      tableHeaderRows: 3,
      tableColumns: 3,
    },
    text: [
      '快奖程度值及情形\t\t',
      '程度\t程度值\t情形',
      '程度\t程度值\tA:精神',
      '良好\t1\t行为值得倡导，能够影响身边同事。',
      '较高\t1.5\t体现了积极影响力，能够带动小组。',
      '很高\t2\t做出了文化践行的表率，能够影响部门。',
      '优秀\t2.5\t持续做出文化践行的表率，能够影响公司。',
    ].join('\n'),
  }
}

describe('splitKbBlocks table', () => {
  it('切分长表时重复标题和完整多行表头', () => {
    const chunks = splitKbBlocks([tableBlock()], { maxTokens: 100, overlapTokens: 0 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      const lines = chunk.text.split('\n')
      expect(lines[0]).toContain('快奖程度值及情形')
      expect(lines[1]).toBe('程度\t程度值\t情形')
      expect(lines[2]).toBe('程度\t程度值\tA:精神')
    }
  })
})
