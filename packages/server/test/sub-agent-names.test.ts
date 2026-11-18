import { describe, expect, it } from 'vitest'
import { subAgentDisplayName, SUB_AGENT_HEAVENLY_STEMS, SUB_AGENT_ZODIAC_NAMES } from '../src/sub-agent-names.js'

describe('子 Agent 团队显示名', () => {
  it('前 12 个用十二生肖，第 13–22 个用十天干', () => {
    const first22 = Array.from({ length: 22 }, (_, index) => subAgentDisplayName(index + 1))
    expect(first22.slice(0, 12)).toEqual([...SUB_AGENT_ZODIAC_NAMES])
    expect(first22.slice(12)).toEqual([...SUB_AGENT_HEAVENLY_STEMS])
    expect(new Set(first22).size).toBe(22)
  })

  it('第 23 个开始组合生肖与天干，并按轮次继续扩展且不重名', () => {
    expect(subAgentDisplayName(23)).toBe('子鼠·甲')
    expect(subAgentDisplayName(24)).toBe('丑牛·甲')
    expect(subAgentDisplayName(142)).toBe('亥猪·癸')
    expect(subAgentDisplayName(143)).toBe('子鼠·甲·2')

    const names = Array.from({ length: 200 }, (_, index) => subAgentDisplayName(index + 1))
    expect(new Set(names).size).toBe(200)
  })

  it('非法或缺失序号按第 1 个岗位处理', () => {
    expect(subAgentDisplayName(0)).toBe('子鼠')
    expect(subAgentDisplayName(-3)).toBe('子鼠')
  })
})
