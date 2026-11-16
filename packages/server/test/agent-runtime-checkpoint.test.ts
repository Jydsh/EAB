import { describe, expect, it } from 'vitest'
import { migrate, openDatabase } from '@eab/storage'
import { checkpointAgentRun, startAgentRun } from '../src/agent-runtime.js'

describe('Agent 检查点持久化', () => {
  it('超长检查点仍然写入合法 JSON，恢复时不会 parse 失败', () => {
    const db = openDatabase({ path: ':memory:' })
    migrate(db)
    const run = startAgentRun(db, {
      companyId: 'c1',
      userId: 'u1',
      agentId: 'main',
      title: '长任务',
      modelId: 'model_test',
    })
    checkpointAgentRun(db, run.id, {
      round: 8,
      maxRounds: 12,
      turnId: 'turn-1',
      text: '已经完成大部分',
      messages: Array.from({ length: 16 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
        content: `第 ${index} 条：${'很长的执行记录'.repeat(500)}`,
      })),
    })
    const row = db.prepare('SELECT resume_state_json FROM agent_runs WHERE id = ?').get(run.id) as {
      resume_state_json: string
    }
    const parsed = JSON.parse(row.resume_state_json) as { messages: unknown[]; truncated?: boolean }
    expect(Array.isArray(parsed.messages)).toBe(true)
    expect(parsed.messages.length).toBeGreaterThan(0)
    expect(parsed.messages.length).toBeLessThanOrEqual(6)
    expect(parsed.messages.length).toBeLessThanOrEqual(16)
  })

  it('单条消息本身超长时降级为保留 system 和原任务的精简检查点', () => {
    const db = openDatabase({ path: ':memory:' })
    migrate(db)
    const run = startAgentRun(db, {
      companyId: 'c1',
      userId: 'u1',
      agentId: 'main',
      title: '超长任务',
      modelId: 'model_test',
    })
    checkpointAgentRun(db, run.id, {
      round: 12,
      turnId: 'turn-huge',
      system: '你是父 Agent 分派的子 Agent',
      prompt: '核对全部记录',
      text: '已完成一部分',
      messages: [{ role: 'tool', content: '超长工具输出'.repeat(8_000) }],
    })
    const row = db.prepare('SELECT resume_state_json FROM agent_runs WHERE id = ?').get(run.id) as {
      resume_state_json: string
    }
    const parsed = JSON.parse(row.resume_state_json) as {
      truncated: boolean
      turnId: string
      messages: Array<{ role: string; content: string }>
    }
    expect(parsed.truncated).toBe(true)
    expect(parsed.turnId).toBe('turn-huge')
    expect(parsed.messages.some((message) => message.role === 'system')).toBe(true)
    expect(parsed.messages.some((message) => message.role === 'user' && message.content === '核对全部记录')).toBe(true)
  })
})
