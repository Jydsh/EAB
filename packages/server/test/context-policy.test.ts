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

describe('长期记忆的向量召回与情景衰减', () => {
  it('词面不重合但向量足够接近时也能召回', () => {
    const vectorMemories = [
      { content: 'Q3 营收目标口径按确认收入计算', embedding: [0.92, 0.08, 0] },
      { content: '办公室绿植每周三浇水', embedding: [0, 1, 0] },
    ]
    const picked = selectRelevantLongTermMemories(vectorMemories, '收入指标怎么算', {
      queryVector: [1, 0, 0],
      limit: 3,
    })
    expect(picked.map((item) => item.content)).toEqual([
      expect.stringContaining('Q3 营收目标口径'),
    ])
  })

  it('向量分低于门槛且词面不命中时不召回', () => {
    const vectorMemories = [{ content: '办公室绿植每周三浇水', embedding: [0.2, 0.98, 0] }]
    const picked = selectRelevantLongTermMemories(vectorMemories, '收入指标怎么算', {
      queryVector: [1, 0, 0],
    })
    expect(picked).toEqual([])
  })

  it('同领域但只有 0.66 相似且词面不命中时不召回，避免无关记忆占上下文', () => {
    const vectorMemories = [{ content: '出题/测试/考试场景一次只出一题', embedding: [0.66, 0.75, 0] }]
    const picked = selectRelevantLongTermMemories(vectorMemories, '修改方案文档时要注意什么', {
      queryVector: [1, 0, 0],
    })
    expect(picked).toEqual([])
  })

  it('情景记忆按 45 天半衰期降权，偏好与决策不衰减', () => {
    const now = Date.UTC(2026, 10, 24)
    const oldEpisode = {
      content: '项目复盘时先对齐目标再列问题',
      memoryType: 'episode',
      createdAt: now - 45 * 24 * 60 * 60 * 1000,
    }
    const freshEpisode = {
      content: '项目复盘时先对齐目标再列问题',
      memoryType: 'episode',
      createdAt: now,
    }
    expect(
      selectRelevantLongTermMemories([oldEpisode, freshEpisode], '项目复盘怎么做', { now })
        .map((item) => item.createdAt),
    ).toEqual([now, oldEpisode.createdAt])

    const oldDecision = { ...oldEpisode, memoryType: 'decision' }
    const freshDecision = { ...freshEpisode, memoryType: 'decision' }
    expect(
      selectRelevantLongTermMemories([oldDecision, freshDecision], '项目复盘怎么做', { now })
        .map((item) => item.createdAt),
    ).toEqual([oldDecision.createdAt, now])
  })
})
