import { describe, expect, it } from 'vitest'
import {
  anthropicThinkingBudget,
  geminiThinkingBudget,
  providerReasoningEffort,
  readThinkingConfig,
  resolveThinkingEffort,
  thinkingBudgetCeiling,
  thinkingConfigFromDeclaredReasoning,
  thinkingConfigOf,
  storedThinkingConfig,
} from '../src/thinking.js'

describe('思考档位配置', () => {
  it('默认三档是精简 / 均衡 / 深思，非法默认档位回落到第一档', () => {
    const config = readThinkingConfig({ enabled: true, options: ['light', 'balanced', 'deep'], defaultEffort: 'max' })
    expect(config?.options.map((item) => item.label)).toEqual(['精简', '均衡', '深思'])
    expect(config?.defaultEffort).toBe('light')
    expect(config?.strategy).toBe('effort')
  })

  it('模型可以只开放部分档位，保存时保留完整对象', () => {
    const config = readThinkingConfig({ enabled: true, options: ['balanced', 'deep'], defaultEffort: 'deep', strategy: 'budget' })
    expect(config?.options.map((item) => item.id)).toEqual(['balanced', 'deep'])
    expect(storedThinkingConfig(config)).toEqual({
      enabled: true,
      options: [
        { id: 'balanced', label: '均衡', hint: '默认档位，兼顾速度与质量。', wire: 'medium', budget: 8192 },
        { id: 'deep', label: '深思', hint: '更充分的推理，输出上限跟随模型。', wire: 'high', budget: null },
      ],
      defaultEffort: 'deep',
      strategy: 'budget',
    })
  })

  it('自定义档位保留显示名、说明、上游线值和输出预算，并按顺序最多 8 个', () => {
    const config = readThinkingConfig({
      enabled: true,
      defaultEffort: 'deep',
      strategy: 'effort',
      options: [
        { id: 'fast', label: '快速', hint: '先给答案。', wire: 'minimal' },
        { id: 'deep', label: '极深', hint: '完整推理。', wire: 'xhigh', budget: null },
        ...Array.from({ length: 10 }, (_, index) => ({ id: `extra${index}`, label: `额外${index}` })),
      ],
    })
    expect(config?.options).toHaveLength(8)
    expect(config?.options[0]).toMatchObject({ id: 'fast', label: '快速', hint: '先给答案。', wire: 'minimal' })
    expect(config?.options[1]).toMatchObject({ id: 'deep', label: '极深', hint: '完整推理。', wire: 'xhigh', budget: null })
    expect(config?.defaultEffort).toBe('deep')
  })

  it('显式上游线值优先于内置 ID 映射', () => {
    expect(providerReasoningEffort('deep')).toBe('high')
    expect(providerReasoningEffort('deep', 'xhigh')).toBe('xhigh')
    expect(providerReasoningEffort('custom', 'low')).toBe('low')
    expect(providerReasoningEffort('custom', 'unsupported')).toBeUndefined()
  })

  it('没有配置或选择过期时按模型默认档位计算', () => {
    const config = readThinkingConfig({ enabled: true, options: ['light', 'balanced'], defaultEffort: 'balanced' })
    expect(thinkingConfigOf({})).toBeNull()
    expect(resolveThinkingEffort(null, 'deep')).toBe('')
    expect(resolveThinkingEffort(config, 'deep')).toBe('balanced')
    expect(resolveThinkingEffort(config, 'light')).toBe('light')
  })

  it('插件声明的 reasoning.efforts 直接投影成只读档位菜单', () => {
    const config = thinkingConfigFromDeclaredReasoning({
      efforts: [
        { id: 'low', name: 'Fast' },
        { id: 'high', name: 'Thorough' },
      ],
      defaultEffort: 'high',
    })
    expect(config?.source).toBe('plugin')
    expect(config?.options.map((item) => item.label)).toEqual(['低', '高'])
    expect(config?.defaultEffort).toBe('high')
    expect(config?.strategy).toBe('effort')
  })

  it('档位换算成真实下发参数，而不是提示词', () => {
    expect(providerReasoningEffort('light')).toBe('low')
    expect(providerReasoningEffort('balanced')).toBe('medium')
    expect(providerReasoningEffort('deep')).toBe('high')
    expect(providerReasoningEffort('unknown')).toBeUndefined()
    expect(thinkingBudgetCeiling('light')).toBe(2048)
    expect(thinkingBudgetCeiling('balanced')).toBe(8192)
    expect(thinkingBudgetCeiling('deep')).toBeNull()
    expect(anthropicThinkingBudget('balanced', 8192)).toBe(4096)
    expect(anthropicThinkingBudget('balanced', 1024)).toBeUndefined()
    expect(geminiThinkingBudget('balanced')).toBe(8192)
    expect(geminiThinkingBudget('disabled')).toBe(0)
  })
})
