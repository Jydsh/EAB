import { describe, expect, it } from 'vitest'
import { capReasoningForStorage, tracesForStorage, type AgentToolTrace } from '../src/routes/chat.js'

function trace(over: Partial<AgentToolTrace> = {}): AgentToolTrace {
  return {
    id: 't1',
    name: 'cy_api_attendance',
    toolId: 'plugin:dsh-cy-api:attendance',
    args: { Username: '邓骏' },
    status: 'done',
    summary: '{"rows":1}',
    durationMs: 100,
    ...over,
  }
}

describe('capReasoningForStorage', () => {
  it('短思考原样保留', () => {
    expect(capReasoningForStorage('先查邓骏的加班数据。', 100)).toBe('先查邓骏的加班数据。')
  })
  it('超长思考保留首尾并标注省略字数', () => {
    const long = `${'甲'.repeat(4_000)}${'乙'.repeat(4_000)}`
    const capped = capReasoningForStorage(long, 1_000)
    expect(capped.length).toBeLessThan(1_200)
    expect(capped).toContain('省略中间约')
    expect(capped.startsWith('甲')).toBe(true)
    expect(capped.endsWith('乙')).toBe(true)
  })
})

describe('tracesForStorage', () => {
  it('保留工具结果的关键字段，供历史消息回放', () => {
    const stored = tracesForStorage([trace()])
    expect(stored[0].args).toEqual({ Username: '邓骏' })
    expect(stored[0].summary).toBe('{"rows":1}')
  })
})
