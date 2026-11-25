import { describe, expect, it } from 'vitest'
import { createExecutionController, executionStopNotice } from '../src/execution-controller.js'

function clock(start = 1000) {
  let value = start
  return {
    now: () => value,
    add: (ms: number) => { value += ms },
  }
}

describe('执行控制器', () => {
  it('轮次到线直接停', () => {
    const controller = createExecutionController({
      maxRounds: 3,
      maxDurationMs: 60_000,
      maxToolCalls: 10,
      maxReasoningCharsPerRound: 1_000,
      now: clock().now,
    })
    expect(controller.beginRound(0)).toBeNull()
    expect(controller.beginRound(2)).toBeNull()
    expect(controller.beginRound(3)?.reason).toBe('rounds')
  })

  it('总时长到线直接停', () => {
    const c = clock()
    const controller = createExecutionController({
      maxRounds: 5,
      maxDurationMs: 1_000,
      maxToolCalls: 10,
      maxReasoningCharsPerRound: 1_000,
      now: c.now,
    })
    controller.beginRound(0)
    c.add(1_001)
    expect(controller.afterModelCall()?.reason).toBe('duration')
  })

  it('工具调用次数到线直接停', () => {
    const controller = createExecutionController({
      maxRounds: 5,
      maxDurationMs: 60_000,
      maxToolCalls: 2,
      maxReasoningCharsPerRound: 1_000,
      now: clock().now,
    })
    controller.beginRound(0)
    controller.addToolCalls(1)
    expect(controller.afterToolCalls()).toBeNull()
    controller.addToolCalls(1)
    expect(controller.afterToolCalls()?.reason).toBe('tool_calls')
  })

  it('单轮思考超预算后只保留预算内文本', () => {
    const controller = createExecutionController({
      maxRounds: 5,
      maxDurationMs: 60_000,
      maxToolCalls: 10,
      maxReasoningCharsPerRound: 5,
      now: clock().now,
    })
    controller.beginRound(0)
    expect(controller.acceptReasoning('1234567')).toEqual({ text: '12345', overBudget: true })
    expect(controller.acceptReasoning('89')).toEqual({ text: '', overBudget: true })
    expect(controller.afterModelCall()?.reason).toBe('reasoning')
  })

  it('新轮次重置单轮思考预算，但累计工具次数不清零', () => {
    const controller = createExecutionController({
      maxRounds: 5,
      maxDurationMs: 60_000,
      maxToolCalls: 10,
      maxReasoningCharsPerRound: 5,
      now: clock().now,
    })
    controller.beginRound(0)
    controller.acceptReasoning('12345')
    controller.beginRound(1)
    expect(controller.acceptReasoning('abcde').text).toBe('abcde')
    controller.addToolCalls(2)
    expect(controller.snapshot().toolCalls).toBe(2)
  })

  it('累计 token 达到任务上限直接停，未命中不误杀', () => {
    const controller = createExecutionController({
      maxRounds: 5,
      maxDurationMs: 60_000,
      maxToolCalls: 10,
      maxReasoningCharsPerRound: 1_000,
      maxTokens: 1_000,
      now: clock().now,
    })
    controller.beginRound(0)
    expect(controller.afterTokenUsage(999)).toBeNull()
    expect(controller.afterTokenUsage(1_000)?.reason).toBe('tokens')
    expect(controller.afterTokenUsage(1_200)?.reason).toBe('tokens')
  })

  it('没设 token 上限时不做 token 判断', () => {
    const controller = createExecutionController({
      maxRounds: 5,
      maxDurationMs: 60_000,
      maxToolCalls: 10,
      maxReasoningCharsPerRound: 1_000,
      now: clock().now,
    })
    controller.beginRound(0)
    expect(controller.afterTokenUsage(10_000_000)).toBeNull()
  })


  it('超预算提示区分有没有拿到工具结果', () => {
    const stop = {
      reason: 'duration' as const,
      message: '达到本回合总时长上限',
      round: 1,
      elapsedMs: 180_001,
      toolCalls: 3,
    }
    expect(executionStopNotice(stop, 3)).toContain('已查到部分结果')
    expect(executionStopNotice(stop, 0)).toContain('没有拿到可用的工具结果')
    expect(executionStopNotice(stop, 3)).toContain('达到本回合总时长上限')
  })
})
