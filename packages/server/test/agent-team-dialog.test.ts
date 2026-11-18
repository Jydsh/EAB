import { describe, expect, it } from 'vitest'
import { formatAskParentMessage } from '../src/routes/chat.js'

describe('团队对话报文', () => {
  it('把问题、卡点、选项和建议组织成主 Agent 可决策的结构', () => {
    const text = formatAskParentMessage({
      question: '统计口径按 A 还是 B？',
      context: '已经跑完两份数据，A 口径 12 条，B 口径 31 条',
      options: '按 A 口径|按 B 口径',
      recommendation: '建议按 B，覆盖更完整',
    })
    expect(text).toContain('【需要主 Agent 决策】')
    expect(text).toContain('【问题】统计口径按 A 还是 B？')
    expect(text).toContain('【当前进度与卡点】')
    expect(text).toContain('【可选方向】按 A 口径|按 B 口径')
    expect(text).toContain('【我的建议】建议按 B，覆盖更完整')
    expect(text).toContain('【需要你给出】明确判断、下一步动作、不要做什么、以及怎么验收')
  })

  it('跨岗位协作会写清希望谁配合，空问题不生成报文', () => {
    const text = formatAskParentMessage({
      question: '接口字段以哪份文档为准？',
      target: 'researcher（研究员）',
    })
    expect(text).toContain('【申请协作】希望「researcher（研究员）」配合')
    expect(text).toContain('【问题】接口字段以哪份文档为准？')
    expect(formatAskParentMessage({ question: '   ' })).toBe('')
  })
})
