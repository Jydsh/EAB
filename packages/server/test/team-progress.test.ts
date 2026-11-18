import { describe, expect, it } from 'vitest'
import { teamProgressCounters } from '../src/routes/chat.js'

describe('团队进度卡按岗位取最新尝试', () => {
  it('同一岗位先失败后成功，不再计入失败', () => {
    const counters = teamProgressCounters([
      { workerKey: 'fix-notes', status: 'succeeded' },
      { workerKey: 'fix-notes', status: 'failed' },
    ])
    expect(counters).toMatchObject({ total: 1, completed: 1, failed: 0, remaining: 0, done: 1 })
  })

  it('不同岗位的最终失败仍然显示', () => {
    const counters = teamProgressCounters([
      { workerKey: 'ok', status: 'succeeded' },
      { workerKey: 'bad', status: 'failed' },
    ])
    expect(counters).toMatchObject({ total: 2, completed: 1, failed: 1, remaining: 0, done: 2 })
  })

  it('仍在执行时保留剩余数，失败重试成功后回到零失败', () => {
    const active = teamProgressCounters([
      { workerKey: 'retrying', status: 'running' },
      { workerKey: 'retrying', status: 'failed' },
      { workerKey: 'done', status: 'succeeded' },
    ])
    expect(active).toMatchObject({ total: 2, completed: 1, failed: 0, active: 1, remaining: 1 })
    const finished = teamProgressCounters([
      { workerKey: 'retrying', status: 'succeeded' },
      { workerKey: 'retrying', status: 'failed' },
      { workerKey: 'done', status: 'succeeded' },
    ])
    expect(finished).toMatchObject({ total: 2, completed: 2, failed: 0, active: 0, remaining: 0 })
  })
})
