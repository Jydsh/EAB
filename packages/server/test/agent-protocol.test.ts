import { describe, expect, it } from 'vitest'
import {
  parseAgentArtifacts,
  parseTaskBudget,
  protocolStatusOf,
  normalizeTaskPhase,
} from '../src/agent-protocol.js'

describe('agent protocol core', () => {
  it('把内部生命周期与暂停原因合成对外状态', () => {
    expect(protocolStatusOf('queued', 'none')).toBe('submitted')
    expect(protocolStatusOf('running', 'none')).toBe('working')
    expect(protocolStatusOf('running', 'input_required')).toBe('input-required')
    expect(protocolStatusOf('queued', 'auth_required')).toBe('auth-required')
    expect(protocolStatusOf('succeeded', 'none')).toBe('completed')
    expect(protocolStatusOf('failed', 'none')).toBe('failed')
    expect(protocolStatusOf('cancelled', 'none')).toBe('canceled')
    expect(protocolStatusOf('failed', 'rejected')).toBe('rejected')
  })

  it('拒绝状态优先于失败状态，未知 phase 回落到 none', () => {
    expect(protocolStatusOf('failed', 'rejected')).toBe('rejected')
    expect(normalizeTaskPhase('auth_required')).toBe('auth_required')
    expect(normalizeTaskPhase('bad')).toBe('none')
    expect(normalizeTaskPhase(null, 'input_required')).toBe('input_required')
  })

  it('预算只保留正整数，坏值不进入执行器', () => {
    expect(parseTaskBudget({
      maxTokens: 1200,
      maxCostMicros: -1,
      maxDurationMs: 30.9,
      maxRounds: '8',
    })).toEqual({ maxTokens: 1200, maxDurationMs: 30, maxRounds: 8 })
    expect(parseTaskBudget(null)).toEqual({})
    expect(parseTaskBudget('bad')).toEqual({})
  })

  it('产物引用过滤空条目并归一化字段', () => {
    const artifacts = parseAgentArtifacts([
      {
        id: 'art-1',
        name: '报告.docx',
        uri: 'workspace://report.docx',
        source: 'workspace',
        fileId: 'wf-1',
        size: 12.9,
        preview: '摘要',
      },
      { id: '', name: '空 id', uri: 'x' },
      { id: 'art-2', name: '坏来源', uri: 'y', source: 'unknown' },
      null,
    ])
    expect(artifacts).toHaveLength(2)
    expect(artifacts[0]).toMatchObject({
      id: 'art-1',
      name: '报告.docx',
      size: 12,
      source: 'workspace',
      fileId: 'wf-1',
      preview: '摘要',
    })
    expect(artifacts[1].source).toBe('workspace')
  })
})
