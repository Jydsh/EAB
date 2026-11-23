import { describe, expect, it } from 'vitest'
import { businessDataGateDecision, type AgentToolTrace } from '../src/routes/chat.js'

function trace(over: Partial<AgentToolTrace>): AgentToolTrace {
  return {
    id: 't1',
    name: 'cy_api_dsh_5d941a8129da49be83719d1f014d5f07',
    toolId: 'plugin:c1:dsh-cy-api:user:cy_api_dsh_5d941a8129da49be83719d1f014d5f07',
    args: {},
    status: 'done',
    summary: '',
    durationMs: 400,
    ...over,
  }
}

describe('businessDataGateDecision', () => {
  const names = new Set(['cy_api_dsh_5d941a8129da49be83719d1f014d5f07'])

  it('数据类问题一次工具都没调：拦回去取数（邓骏这类串答案就是因为没拦）', () => {
    const decision = businessDataGateDecision({ question: '邓骏的本月加班数据', traces: [], pluginToolNames: names, forced: 0 })
    expect(decision.action).toBe('continue')
    if (decision.action === 'continue') {
      expect(decision.message).toContain('还没取数就要回答')
      expect(decision.message).toContain('人名按用户原话原样传')
    }
  })

  it('只调了零参数的接口清单：仍算没取数', () => {
    const decision = businessDataGateDecision({ question: '魏竣豪的本月加班数据分析', traces: [trace({})], pluginToolNames: names, forced: 0 })
    expect(decision.action).toBe('continue')
  })

  it('真的带参数查到了数据：放行', () => {
    const decision = businessDataGateDecision({
      question: '魏竣豪的本月加班数据分析',
      traces: [trace({ args: { Username: '魏竣豪', startStr: '2026-11-01', endStr: '2026-11-30' } })],
      pluginToolNames: names,
      forced: 0,
    })
    expect(decision.action).toBe('finish')
  })

  it('没有业务工具可用时不硬塞调用', () => {
    const decision = businessDataGateDecision({ question: '本月加班统计', traces: [], pluginToolNames: new Set(), forced: 0 })
    expect(decision.action).toBe('finish')
  })

  it('闲聊不拦', () => {
    const decision = businessDataGateDecision({ question: '帮我起草一封跟进邮件', traces: [], pluginToolNames: names, forced: 0 })
    expect(decision.action).toBe('finish')
  })

  it('连续拦两次后放行，避免对话卡死', () => {
    const decision = businessDataGateDecision({ question: '邓骏的本月加班数据', traces: [], pluginToolNames: names, forced: 2 })
    expect(decision.action).toBe('finish')
  })
})
