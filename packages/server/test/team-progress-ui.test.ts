import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

/**
 * 进度卡是前端纯函数，单独从 chat.js 截取计数区间执行；
 * 不启动整页脚本，也不依赖 DOM。
 */
function loadProgressFunctions() {
  const source = readFileSync(new URL('../public/chat.js', import.meta.url), 'utf8')
  const start = source.indexOf('function clampProgressPercent')
  const end = source.indexOf('function syncTeamProgressBubbles')
  if (start < 0 || end <= start) throw new Error('chat.js 中找不到进度卡函数区间')
  const context: Record<string, unknown> = {}
  vm.createContext(context)
  vm.runInContext(
    `${source.slice(start, end)}
globalThis.__teamProgressTest = { mergeTeamProgressCounts, normalizeTeamProgress }`,
    context,
  )
  return context.__teamProgressTest as {
    mergeTeamProgressCounts: (previous: Record<string, number>, current: Record<string, number>) => Record<string, unknown>
    normalizeTeamProgress: (input: Record<string, unknown>) => Record<string, unknown> | null
  }
}

describe('团队进度卡计数', () => {
  const { mergeTeamProgressCounts, normalizeTeamProgress } = loadProgressFunctions()

  it('同一岗位从成功变为失败时，成功数不会被旧快照保留成 1', () => {
    const merged = mergeTeamProgressCounts(
      { total: 1, completed: 1, failed: 0 },
      { total: 1, completed: 0, failed: 1, active: 0, waiting: 0 },
    )
    expect(merged.total).toBe(1)
    expect(merged.completed).toBe(0)
    expect(merged.failed).toBe(1)
    expect(merged.done).toBe(1)
    expect(merged.state).toBe('已结束')
    expect(merged.detail).toContain('成功 0 · 失败 1')
  })

  it('同一岗位重新运行时清掉旧完成数，显示为进行中', () => {
    const merged = mergeTeamProgressCounts(
      { total: 1, completed: 1, failed: 0 },
      { total: 1, completed: 0, failed: 0, active: 1, waiting: 0 },
    )
    expect(merged.completed).toBe(0)
    expect(merged.failed).toBe(0)
    expect(merged.active).toBe(1)
    expect(merged.state).toBe('进行中')
    expect(merged.label).toBe('进行中 1 / 1')
    expect(merged.remaining).toBe(0)
    expect(merged.detail).not.toContain('待汇总 1')
    expect(merged.percent).toBe(0)
  })

  it('只有进行中时不再同时显示待汇总', () => {
    const normalized = normalizeTeamProgress({
      total: 1,
      completed: 0,
      failed: 0,
      active: 1,
      waiting: 0,
      remaining: 1,
      state: 'running',
    })
    expect(normalized?.remaining).toBe(0)
    expect(normalized?.active).toBe(1)
    expect(normalized?.detail).toBe('成功 0 · 失败 0 · 进行中 1')
  })

  it('坏快照里的成功和失败也不会同时超过总数', () => {
    const normalized = normalizeTeamProgress({
      total: 1,
      completed: 1,
      failed: 1,
      active: 0,
      waiting: 0,
      remaining: 0,
      state: 'completed',
    })
    expect(normalized?.completed).toBe(0)
    expect(normalized?.failed).toBe(1)
    expect(normalized?.detail).toContain('成功 0 · 失败 1')
    expect(normalized?.state).toBe('已结束')
  })

  it('岗位退休导致当前总数变小时，历史累计总数不会倒退', () => {
    const merged = mergeTeamProgressCounts(
      { total: 4, completed: 3, failed: 1 },
      { total: 1, completed: 0, failed: 1, active: 0, waiting: 0 },
    )
    expect(merged.total).toBe(4)
    expect(merged.completed).toBe(3)
    expect(merged.failed).toBe(1)
    expect(merged.done).toBe(4)
    expect(merged.state).toBe('已结束')
  })
})
