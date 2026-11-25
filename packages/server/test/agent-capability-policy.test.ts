import { describe, expect, it } from 'vitest'
import {
  builtinAgentCards,
  resolveAgentTaskPolicy,
  type AgentCard,
} from '../src/agent-capability-registry.js'

function cards(): AgentCard[] {
  return builtinAgentCards()
}

describe('岗位卡运行时合同', () => {
  it('每个岗位都有工具白名单和三类硬上限', () => {
    for (const card of cards()) {
      expect(card.tools.length).toBeGreaterThan(0)
      expect(card.limits.maxRounds).toBeGreaterThan(0)
      expect(card.limits.timeoutMs).toBeGreaterThan(0)
      expect(card.limits.maxTokens).toBeGreaterThan(0)
    }
  })

  it('工具按岗位隔离：builder 能写，critic 只能读和验收', () => {
    const builder = resolveAgentTaskPolicy(cards(), 'builder')
    expect(builder.toolIds).toEqual(expect.arrayContaining([
      'workspace.write',
      'workspace.edit',
      'project.exec',
      'agent.ask_parent',
      'agent.publish_artifact',
    ]))
    expect(builder.toolIds).not.toContain('review.verdict')

    const critic = resolveAgentTaskPolicy(cards(), 'critic')
    expect(critic.toolIds).toEqual(expect.arrayContaining([
      'workspace.read',
      'project.exec',
      'review.verdict',
    ]))
    expect(critic.toolIds).not.toContain('workspace.write')
    expect(critic.toolIds).not.toContain('workspace.edit')
    expect(critic.toolIds).not.toContain('agent.publish_artifact')
  })

  it('worker 是通用执行集，不会因为硬白名单失去写文件/跑命令能力', () => {
    const worker = resolveAgentTaskPolicy(cards(), undefined)
    expect(worker.role).toBe('worker')
    expect(worker.toolIds).toEqual(expect.arrayContaining([
      'workspace.read',
      'workspace.write',
      'workspace.edit',
      'project.exec',
      'project.job',
      'agent.publish_artifact',
    ]))
  })

  it('任务预算只能收紧岗位卡，不能把上限调大', () => {
    const builder = resolveAgentTaskPolicy(cards(), 'builder', {
      maxTokens: 9_999_999,
      maxDurationMs: 9_999_999,
      maxRounds: 9_999,
    })
    const base = cards().find((card) => card.agentKey === 'builder')!
    expect(builder.budget.maxTokens).toBe(base.limits.maxTokens)
    expect(builder.budget.maxDurationMs).toBe(base.limits.timeoutMs)
    expect(builder.budget.maxRounds).toBe(base.limits.maxRounds)

    const tightened = resolveAgentTaskPolicy(cards(), 'builder', {
      maxTokens: 10_000,
      maxDurationMs: 60_000,
      maxRounds: 8,
    })
    expect(tightened.budget).toMatchObject({ maxTokens: 10_000, maxDurationMs: 60_000, maxRounds: 8 })
  })

  it('截止时间与时长上限来自同一时刻，停用岗位不能派活', () => {
    const now = 1_000_000
    const worker = resolveAgentTaskPolicy(cards(), 'worker', { maxDurationMs: 30_000 }, now)
    expect(worker.deadlineAt).toBe(now + 30_000)

    const disabled = cards().map((card) => (
      card.agentKey === 'critic' ? { ...card, enabled: false } : card
    ))
    expect(() => resolveAgentTaskPolicy(disabled, 'critic')).toThrow(/不可用/)
  })
})
