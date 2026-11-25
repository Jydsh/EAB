/**
 * AGT-06 评测集 v0 跑分器。
 *
 * 目标不是模拟一家公司的全部业务，而是把 P0 的硬约束做成可回归的题：
 * - AGT-02：用户点名对象时，插件调用必须带对应条件；
 * - AGT-03：回合轮次 / 工具次数 / 总时长 / 单轮思考有硬预算。
 *
 * 答案数字核对（AGT-01）已随数字门禁一起下线，评测集不再包含数字一致性用例。
 *
 * 运行：pnpm eval:agent
 * 基准集：evals/agent-baseline.v0.json
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { missingConditionParams } from '../packages/server/src/routes/chat.js'
import { createExecutionController, executionStopNotice } from '../packages/server/src/execution-controller.js'

type ConditionCase = {
  id: string
  kind: 'condition'
  question: string
  schema: Record<string, unknown>
  args: Record<string, unknown>
  expected: { missing: Array<{ field: string; kind: string; expected: string }> }
  metrics: { toolRounds: number; reasoningChars: number }
}

type BudgetCase = {
  id: string
  kind: 'budget'
  action: 'beginRound' | 'duration' | 'toolCalls' | 'reasoning' | 'truncate' | 'reset' | 'notice'
  round?: number
  elapsedMs?: number
  toolCalls?: number
  reasoningChars?: number
  expected: { reason?: string; acceptedChars?: number; overBudget?: boolean; noticeIncludes?: string }
  metrics: { toolRounds: number; reasoningChars: number }
}

type EvalCase = ConditionCase | BudgetCase

type Baseline = {
  version: string
  name: string
  cases: EvalCase[]
}

const here = dirname(fileURLToPath(import.meta.url))
const baseline = JSON.parse(
  readFileSync(join(here, '..', 'evals', 'agent-baseline.v0.json'), 'utf8'),
) as Baseline

function p95(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0
}

function runCondition(test: ConditionCase): { pass: boolean; detail: string } {
  const actual = missingConditionParams({
    question: test.question,
    schema: test.schema,
    args: test.args,
  })
  const pass = JSON.stringify(actual) === JSON.stringify(test.expected.missing)
  return { pass, detail: pass ? 'ok' : JSON.stringify(actual) }
}

function runBudget(test: BudgetCase): { pass: boolean; detail: string } {
  let clockValue = 1000
  const controller = createExecutionController({
    maxRounds: 3,
    maxDurationMs: 1000,
    maxToolCalls: 2,
    maxReasoningCharsPerRound: 2000,
    now: () => clockValue,
  })
  if (test.action === 'notice') {
    const stop = {
      reason: 'tool_calls' as const,
      message: '达到本回合工具调用次数上限',
      round: 1,
      elapsedMs: 10,
      toolCalls: test.toolCalls ?? 0,
    }
    const notice = executionStopNotice(stop, test.toolCalls ?? 0)
    const pass = Boolean(test.expected.noticeIncludes && notice.includes(test.expected.noticeIncludes))
    return { pass, detail: notice.slice(0, 80) }
  }
  if (test.action === 'beginRound') {
    controller.beginRound(0)
    const stop = controller.beginRound(test.round ?? 3)
    const pass = stop?.reason === test.expected.reason
    return { pass, detail: stop?.reason ?? 'none' }
  }
  controller.beginRound(0)
  if (test.action === 'duration') {
    clockValue += test.elapsedMs ?? 1001
    const stop = controller.afterModelCall()
    return { pass: stop?.reason === test.expected.reason, detail: stop?.reason ?? 'none' }
  }
  if (test.action === 'toolCalls') {
    controller.addToolCalls(test.toolCalls ?? 2)
    const stop = controller.afterToolCalls()
    return { pass: stop?.reason === test.expected.reason, detail: stop?.reason ?? 'none' }
  }
  if (test.action === 'reasoning') {
    controller.acceptReasoning('思'.repeat(test.reasoningChars ?? 2001))
    const stop = controller.afterModelCall()
    return { pass: stop?.reason === test.expected.reason, detail: stop?.reason ?? 'none' }
  }
  if (test.action === 'truncate') {
    const accepted = controller.acceptReasoning('思'.repeat(test.reasoningChars ?? 2500))
    const pass = accepted.text.length === test.expected.acceptedChars
      && accepted.overBudget === test.expected.overBudget
    return { pass, detail: `${accepted.text.length}/${accepted.overBudget}` }
  }
  if (test.action === 'reset') {
    controller.acceptReasoning('1234567890')
    controller.beginRound(1)
    const accepted = controller.acceptReasoning('1234567890')
    return { pass: accepted.text.length === test.expected.acceptedChars, detail: String(accepted.text.length) }
  }
  return { pass: false, detail: `unknown action ${test.action}` }
}

const results = baseline.cases.map((test) => {
  if (test.kind === 'condition') {
    const result = runCondition(test)
    return { test, ...result }
  }
  const result = runBudget(test)
  return { test, ...result }
})

const passed = results.filter((item) => item.pass).length
const completionRate = passed / results.length
const toolRoundsP95 = p95(results.map((item) => item.test.metrics.toolRounds))
const reasoningP95 = p95(results.map((item) => item.test.metrics.reasoningChars))
const startedAt = Date.now()

const failures = results.filter((item) => !item.pass)
const thresholds = {
  completionRate: completionRate >= 0.95,
  toolRoundsP95: toolRoundsP95 <= 3,
  reasoningP95: reasoningP95 <= 2000,
}

console.log(`EAB Agent 评测集 ${baseline.version} · ${baseline.name}`)
console.log(`用例 ${passed}/${results.length} 通过 · 完成率 ${(completionRate * 100).toFixed(1)}%`)
console.log(`工具轮次 P95 ${toolRoundsP95} · 单轮思考 P95 ${reasoningP95} 字 · 用时 ${Date.now() - startedAt}ms`)
for (const item of failures) {
  console.log(`FAIL ${item.test.id}: ${item.detail}`)
}
const allPassed = Object.values(thresholds).every(Boolean) && failures.length === 0
if (!allPassed) {
  console.error(`发版闸门未通过：${JSON.stringify(thresholds)}`)
  process.exit(1)
}
console.log('发版闸门通过。')
