import { describe, expect, it } from 'vitest'
import { selectRelevantLongTermMemories } from '../src/context-policy.js'

const memories = [
  {
    content:
      '修改方案文档时，只修改用户指定的段落、表格单元格或 Excel 单元格，不要整篇/整表重写。',
  },
  {
    content: '出题/测试/考试场景下，必须使用引导模式：一次只出一题，用户回答后立即判分。',
  },
  {
    content: '公司周报统一在每周五 17:00 前提交。',
  },
]

describe('长期记忆的相关性过滤', () => {
  it('无关问题不注入任何长期记忆', () => {
    expect(selectRelevantLongTermMemories(memories, '今天天气怎么样？')).toEqual([])
    expect(selectRelevantLongTermMemories(memories, '帮我讲个笑话')).toEqual([])
  })

  it('只注入与当前问题有实际词面交集的记忆', () => {
    const picked = selectRelevantLongTermMemories(memories, '帮我改一下这个方案文档，只改第二段')
    expect(picked).toHaveLength(1)
    expect(picked[0].content).toContain('只修改用户指定的段落')
  })

  it('命中两个短词也算相关，避免“文档/方案”这类两字实体漏掉', () => {
    const picked = selectRelevantLongTermMemories(memories, '这个文档的方案怎么改')
    expect(picked.map((item) => item.content)).toEqual([
      expect.stringContaining('只修改用户指定的段落'),
    ])
  })

  it('出题场景只带回出题规则，不把文档规则一起塞进来', () => {
    const picked = selectRelevantLongTermMemories(memories, '帮我出三道考试题，一次一题')
    expect(picked).toHaveLength(1)
    expect(picked[0].content).toContain('一次只出一题')
  })

  it('最多只注入配置上限条数', () => {
    expect(selectRelevantLongTermMemories(memories, '方案 文档 周报 考试 出题', 1)).toHaveLength(1)
  })
})
