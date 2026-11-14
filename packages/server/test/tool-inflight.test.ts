import { describe, expect, it } from 'vitest'
import {
  beginToolInflight,
  resetToolInflightForTest,
  toolInflightCount,
  toolInflightSnapshot,
} from '../src/tool-inflight.js'

describe('正在执行的工具登记', () => {
  it('登记后可按已耗时倒序读出，结束即注销', () => {
    resetToolInflightForTest()
    const a = beginToolInflight({ toolId: 'office.replace', channel: 'web' })
    const b = beginToolInflight({ toolId: 'tool.search' })
    expect(toolInflightCount()).toBe(2)

    // 让第一个先开始，读出时应排在前面
    const now = Date.now() + 5_000
    const rows = toolInflightSnapshot(10, now)
    expect(rows.map((row) => row.toolId)).toEqual(['office.replace', 'tool.search'])
    expect(rows[0].channel).toBe('web')
    expect(rows[0].elapsedMs).toBeGreaterThanOrEqual(5_000)

    a.end()
    expect(toolInflightCount()).toBe(1)
    b.end()
    expect(toolInflightCount()).toBe(0)
    expect(toolInflightSnapshot()).toEqual([])
  })

  it('重复结束不会把别人的登记删掉', () => {
    resetToolInflightForTest()
    const a = beginToolInflight({ toolId: 'workspace.write' })
    const b = beginToolInflight({ toolId: 'workspace.write' })
    a.end()
    a.end()
    expect(toolInflightCount()).toBe(1)
    b.end()
    expect(toolInflightCount()).toBe(0)
  })

  it('快照按上限截断', () => {
    resetToolInflightForTest()
    for (let i = 0; i < 5; i += 1) beginToolInflight({ toolId: `t${i}` })
    expect(toolInflightSnapshot(3)).toHaveLength(3)
    resetToolInflightForTest()
  })
})
