import { beforeEach, describe, expect, it } from 'vitest'
import {
  appendWorkerMessage,
  clearTeam,
  findWorker,
  listWorkers,
  markWorkerIdle,
  markWorkerRun,
  markWorkerWaiting,
  pruneIdleWorkers,
  registerWorker,
  resetAgentTeamsForTest,
  teamRoster,
  workerMessages,
} from '../src/agent-team.js'

describe('子 Agent 团队登记表', () => {
  beforeEach(() => resetAgentTeamsForTest())

  it('注册后是可派活的 worker，重复注册复用序号', () => {
    const first = registerWorker('run-1', { key: 'research-a', name: '资料 A', index: 1 })
    expect(first.status).toBe('running')
    const again = registerWorker('run-1', { key: 'research-a', name: '资料 A' })
    expect(again.index).toBe(1)
    expect(listWorkers('run-1').length).toBe(1)
  })

  it('完成任务进入 idle，空闲超期后自动注销', () => {
    registerWorker('run-1', { key: 'research-a', name: '资料 A' }, 1000)
    markWorkerRun('run-1', 'research-a', 'run-child')
    expect(findWorker('run-1', 'research-a')?.runId).toBe('run-child')

    markWorkerIdle('run-1', 'research-a', '整理完了', 2000)
    expect(findWorker('run-1', 'research-a')?.status).toBe('idle')
    // 未到空闲期：保留，父 Agent 还能继续派活
    expect(pruneIdleWorkers('run-1', 120_000, 121_000)).toEqual([])
    expect(findWorker('run-1', 'research-a')).toBeTruthy()
    // 超过空闲期：注销
    expect(pruneIdleWorkers('run-1', 120_000, 122_100)).toEqual(['research-a'])
    expect(findWorker('run-1', 'research-a')).toBeUndefined()
  })

  it('工作中的 worker 不会被空闲清理误删', () => {
    registerWorker('run-1', { key: 'research-a', name: '资料 A' }, 1000)
    expect(pruneIdleWorkers('run-1', 120_000, 999_999)).toEqual([])
  })

  it('父回合结束清空整个团队', () => {
    registerWorker('run-1', { key: 'a', name: 'A' })
    registerWorker('run-1', { key: 'b', name: 'B' })
    expect(listWorkers('run-1').length).toBe(2)
    clearTeam('run-1')
    expect(listWorkers('run-1')).toEqual([])
  })

  it('会话清单会列出仍存活的子 Agent，并提示用 key 继续派活', () => {
    registerWorker('session:s1', { key: 'research-a', name: '资料 A' }, 1000)
    markWorkerIdle('session:s1', 'research-a', '  三条结论  ', 2000)
    const roster = teamRoster('session:s1', 120_000, 3000)
    expect(roster).toContain('research-a')
    expect(roster).toContain('空闲')
    expect(roster).toContain('三条结论')
    expect(roster).toContain('agent_task')
    // 空闲超期后清单为空，提示词里不会出现这一段
    expect(teamRoster('session:s1', 120_000, 300_000)).toBe('')
  })

  it('同一 key 的多轮对话会保留上下文，等待父 Agent 时不被空闲清理', () => {
    registerWorker('session:s1', { key: 'research-a', name: '资料 A' }, 1000)
    appendWorkerMessage('session:s1', 'research-a', 'user', '查一下安全巡检流程', 1100)
    appendWorkerMessage('session:s1', 'research-a', 'assistant', '知识库里没有这条制度', 1200)
    markWorkerWaiting('session:s1', 'research-a', '要查哪个部门的巡检流程？', 1300)

    expect(findWorker('session:s1', 'research-a')?.status).toBe('waiting')
    expect(workerMessages('session:s1', 'research-a').map((message) => message.role))
      .toEqual(['user', 'assistant'])
    expect(teamRoster('session:s1', 120_000, 999_999)).toContain('等待父 Agent 回答')
    // waiting 不是 idle，不会被空闲退休误删
    expect(pruneIdleWorkers('session:s1', 120_000, 999_999)).toEqual([])
  })
})
