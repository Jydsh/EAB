/**
 * 回合执行控制器（AGT-03）。
 *
 * 只做确定性预算：本回合最多几轮模型→工具、最多几次工具调用、最多多久、
 * 每轮最多多少字思考。到线就返回一个明确的停止原因，由对话层输出
 * “已查到部分 + 未完成原因”，不允许继续空转。
 *
 * 不调用模型裁判，也不根据内容猜“该不该停”；所有判断都是计数和时钟。
 */

export type ExecutionStopReason = 'rounds' | 'duration' | 'tool_calls' | 'reasoning' | 'tokens'

export interface ExecutionStop {
  readonly reason: ExecutionStopReason
  readonly message: string
  /** 停止发生在第几轮（从 1 开始） */
  readonly round: number
  readonly elapsedMs: number
  readonly toolCalls: number
}

export interface ExecutionBudgetConfig {
  /** 本回合最多几轮模型调用；到线后不再开新一轮 */
  readonly maxRounds: number
  /** 本回合总墙钟预算（毫秒） */
  readonly maxDurationMs: number
  /** 本回合最多几次工具调用（按实际发起的 call 计） */
  readonly maxToolCalls: number
  /** 单轮思考最多多少字；超出部分不再进入上下文和前端 */
  readonly maxReasoningCharsPerRound: number
  /** 本任务累计 token 预算（prompt + completion）；未设则不按 token 停 */
  readonly maxTokens?: number
  /** 测试可注入时钟 */
  readonly now?: () => number
}

export interface ReasoningChunk {
  /** 本轮还能接受的思考文本；超预算时可能为空或截断 */
  readonly text: string
  /** 这段之后本轮思考预算已用尽 */
  readonly overBudget: boolean
}

const REASON_TEXT: Record<ExecutionStopReason, string> = {
  rounds: '达到本回合模型轮次上限',
  duration: '达到本回合总时长上限',
  tool_calls: '达到本回合工具调用次数上限',
  reasoning: '达到本轮思考字数上限',
  tokens: '达到本任务 token 上限',
}

export function createExecutionController(config: ExecutionBudgetConfig) {
  const now = config.now ?? Date.now
  const startedAt = now()
  let rounds = 0
  let toolCalls = 0
  let reasoningCharsThisRound = 0

  const elapsedMs = (): number => Math.max(0, now() - startedAt)

  function stop(reason: ExecutionStopReason): ExecutionStop {
    return {
      reason,
      message: REASON_TEXT[reason],
      round: Math.max(1, rounds),
      elapsedMs: elapsedMs(),
      toolCalls,
    }
  }

  return {
    /** 开新一轮前调用；超过墙钟或轮次直接停。 */
    beginRound(nextRound: number): ExecutionStop | null {
      rounds = Math.max(rounds, nextRound + 1)
      reasoningCharsThisRound = 0
      if (nextRound >= config.maxRounds) return stop('rounds')
      if (elapsedMs() >= config.maxDurationMs) return stop('duration')
      return null
    },

    /** 接收本轮思考增量；超过字数预算的部分直接截掉。 */
    acceptReasoning(text: string): ReasoningChunk {
      const room = Math.max(0, config.maxReasoningCharsPerRound - reasoningCharsThisRound)
      if (room <= 0) return { text: '', overBudget: true }
      const accepted = text.slice(0, room)
      reasoningCharsThisRound += accepted.length
      return { text: accepted, overBudget: accepted.length < text.length }
    },

    addToolCalls(count: number): void {
      if (Number.isFinite(count) && count > 0) toolCalls += Math.floor(count)
    },

    /** 工具执行完一轮后调用：先看总时长，再看工具次数。 */
    afterToolCalls(): ExecutionStop | null {
      if (elapsedMs() >= config.maxDurationMs) return stop('duration')
      if (toolCalls >= config.maxToolCalls) return stop('tool_calls')
      return null
    },

    /** 模型返回但还没执行工具时，检查本轮思考是否已超预算。 */
    afterModelCall(): ExecutionStop | null {
      if (reasoningCharsThisRound >= config.maxReasoningCharsPerRound) return stop('reasoning')
      if (elapsedMs() >= config.maxDurationMs) return stop('duration')
      return null
    },

    /**
     * 每轮拿到真实 usage 后调用；累计 token 只按 prompt + completion 计。
     * 达到上限就返回 tokens 停止原因，由调用方把子任务判失败，不伪装成部分成功。
     */
    afterTokenUsage(totalTokens: number): ExecutionStop | null {
      if (config.maxTokens === undefined) return null
      if (!Number.isFinite(totalTokens)) return null
      return totalTokens >= config.maxTokens ? stop('tokens') : null
    },

    snapshot(): { rounds: number; toolCalls: number; reasoningCharsThisRound: number; elapsedMs: number } {
      return { rounds, toolCalls, reasoningCharsThisRound, elapsedMs: elapsedMs() }
    },
  }
}

/** 超预算时的可见收口：有工具结果就是“已查到部分”，没有就明说没拿到。 */
export function executionStopNotice(stop: ExecutionStop, completedToolCalls: number): string {
  const prefix = completedToolCalls > 0
    ? `已查到部分结果（完成 ${completedToolCalls} 次工具调用），但本轮执行已停止。`
    : '本轮没有拿到可用的工具结果，执行已停止。'
  return `【执行预算】${prefix}未完成原因：${stop.message}。`
    + '为避免继续空转，先停在这里；可以缩小查询范围、拆成更小的问题再试。'
}
