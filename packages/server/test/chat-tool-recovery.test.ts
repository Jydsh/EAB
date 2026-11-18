import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../public/chat.js', import.meta.url), 'utf8')
const start = source.indexOf('function normalizeRecoveredToolCalls')
const end = source.indexOf('function toolStatusText')
if (start < 0 || end <= start) throw new Error('无法从 chat.js 定位工具失败归一化函数')
const normalizeSource = source.slice(start, end)
const { normalizeRecoveredToolCalls } = new Function(
  `${normalizeSource}; return { normalizeRecoveredToolCalls }`,
)() as {
  normalizeRecoveredToolCalls: (tools: Array<{ id: string; status: string }>) => Array<{ id: string; status: string }>
}

const tool = (id: string, status: 'running' | 'done' | 'error') => ({ id, status })

describe('工具中间失败不进入最终红色状态', () => {
  it('失败后重试成功，只保留成功调用', () => {
    expect(normalizeRecoveredToolCalls([tool('fail', 'error'), tool('retry', 'done')]))
      .toEqual([tool('retry', 'done')])
  })

  it('失败后仍在重试，先隐藏失败，等重试结果', () => {
    expect(normalizeRecoveredToolCalls([tool('fail', 'error'), tool('retry', 'running')]))
      .toEqual([tool('retry', 'running')])
  })

  it('全部失败时只保留最后一次作为最终失败', () => {
    expect(normalizeRecoveredToolCalls([tool('first', 'error'), tool('last', 'error')]))
      .toEqual([tool('last', 'error')])
  })

  it('成功之后再次失败仍显示为最终失败', () => {
    expect(normalizeRecoveredToolCalls([tool('ok', 'done'), tool('final', 'error')]))
      .toEqual([tool('ok', 'done'), tool('final', 'error')])
  })

  it('单次失败没有重试时保持失败状态', () => {
    expect(normalizeRecoveredToolCalls([tool('only', 'error')])).toEqual([tool('only', 'error')])
  })
})
