import { describe, expect, it } from 'vitest'
import {
  answerFactGateDecision,
  collectToolFactEvidence,
  extractAnswerClaims,
  numberInEvidence,
  numbersInText,
} from '../src/answer-facts.js'
import { missingConditionParams, type AgentToolTrace } from '../src/routes/chat.js'

function trace(numbers: number[], over: Partial<AgentToolTrace> = {}): AgentToolTrace {
  return {
    id: 't1',
    name: 'cy_api_attendance',
    toolId: 'plugin:dsh-cy-api:attendance',
    args: { Username: '邓骏' },
    status: 'done',
    summary: '{"rows":105}',
    durationMs: 300,
    evidence: { numbers, sampleText: '' },
    ...over,
  }
}

describe('numbersInText', () => {
  it('抽业务数字，保留小数、千分位和万/亿单位', () => {
    expect(numbersInText('合计 864.92 小时，共 105 条，金额 1.2 万元')).toEqual([864.92, 105, 12_000])
    expect(numbersInText('1,234.56 元')).toEqual([1234.56])
  })

  it('不把日期、版本号、手机号、长编号当业务数字', () => {
    expect(numbersInText('2026-11-23 与 2026年11月23日')).toEqual([])
    expect(numbersInText('v2026.11.23.04')).toEqual([])
    expect(numbersInText('手机号 13800138000，编号 123456789012')).toEqual([])
  })

  it('工号/编号这类标识不混进统计数字', () => {
    expect(numbersInText('工号 12345、编号 Q-2026-001，合计 17.5 小时')).toEqual([17.5])
  })

  it('标识符里的数字不误抓', () => {
    expect(numbersInText('cy_api_dsh_5d941a8129da49be')).toEqual([])
  })
})

describe('collectToolFactEvidence', () => {
  it('收集 payload 里的数值与字符串里的数字', () => {
    const evidence = collectToolFactEvidence({ rows: [{ 时长: 17.5 }, { 时长: 20 }], note: '共 2 条' })
    expect(evidence.numbers).toContain(17.5)
    expect(evidence.numbers).toContain(20)
    expect(evidence.numbers).toContain(2)
  })

  it('rowStats 的合计/平均/条数也进入证据', () => {
    const evidence = collectToolFactEvidence({ data: [{ hours: 10 }, { hours: 7.5 }] }, {
      rows: 2,
      path: 'data',
      fields: { hours: { count: 2, sum: 17.5, avg: 8.75, min: 7.5, max: 10 } },
      note: '',
    })
    expect(evidence.numbers).toContain(17.5)
    expect(evidence.numbers).toContain(8.75)
    expect(evidence.numbers).toContain(2)
  })
})

describe('extractAnswerClaims', () => {
  it('只抓带统计口径的句子', () => {
    const claims = extractAnswerClaims('2026-11-01 至 2026-11-30 的加班合计 864.92 小时，共 105 条。')
    expect(claims).toHaveLength(1)
    expect(claims[0].numbers.map((item) => item.value)).toEqual([864.92, 105])
  })

  it('日期和版本号不单独形成 claim', () => {
    expect(extractAnswerClaims('查询时间：2026-11-01 至 2026-11-30\n版本 v2026.11.23.04')).toEqual([])
  })

  it('明细表行有至少两个数字时逐行核对', () => {
    const claims = extractAnswerClaims('| 邓骏 | 17.5 | 2026-11-03 |')
    expect(claims).toHaveLength(1)
    expect(claims[0].marker).toBe('明细行')
  })
})

describe('numberInEvidence', () => {
  it('百分比与小数互认', () => {
    expect(numberInEvidence(12.5, [0.125])).toBe(true)
    expect(numberInEvidence(0.125, [12.5])).toBe(true)
    expect(numberInEvidence(12.5, [12.4])).toBe(false)
  })
})

describe('answerFactGateDecision', () => {
  it('答案数字都能在工具结果里找到：放行', () => {
    const decision = answerFactGateDecision({
      dataTurn: true,
      answer: '本月加班合计 864.92 小时，共 105 条。',
      traces: [trace([864.92, 105])],
      forced: 0,
    })
    expect(decision.action).toBe('finish')
  })

  it('答案数字与工具结果对不上：拦回去核对', () => {
    const decision = answerFactGateDecision({
      dataTurn: true,
      answer: '本月加班合计 188.55 小时，共 105 条。',
      traces: [trace([864.92, 105])],
      forced: 0,
    })
    expect(decision.action).toBe('continue')
    if (decision.action === 'continue') {
      expect(decision.message).toContain('188.55')
      expect(decision.message).toContain('没有证据')
    }
  })

  it('派生指标没有 math_eval 证据：拦截', () => {
    const decision = answerFactGateDecision({
      dataTurn: true,
      answer: '日均 28.82 小时。',
      traces: [trace([864.92, 105])],
      forced: 0,
    })
    expect(decision.action).toBe('continue')
  })

  it('math_eval 的结果可以作为派生指标证据', () => {
    const decision = answerFactGateDecision({
      dataTurn: true,
      answer: '日均 28.82 小时。',
      traces: [trace([864.92, 105]), trace([28.82], { name: 'math_eval', toolId: 'math.eval', summary: '{"sum":28.82}' })],
      forced: 0,
    })
    expect(decision.action).toBe('finish')
  })

  it('连续拦截到上限：改为安全答复，不再把错误数字放出去', () => {
    const decision = answerFactGateDecision({
      dataTurn: true,
      answer: '合计 188.55 小时。',
      traces: [trace([864.92])],
      forced: 2,
    })
    expect(decision.action).toBe('finish')
    if (decision.action === 'finish') {
      expect(decision.text).toContain('无法与工具返回结果核对')
      expect(decision.text).toContain('缩小查询范围')
    }
  })

  it('非数据回合与无口径句子不拦', () => {
    expect(answerFactGateDecision({ dataTurn: false, answer: '合计 188.55 小时', traces: [], forced: 0 }).action).toBe('finish')
    expect(answerFactGateDecision({ dataTurn: true, answer: '今天天气不错。', traces: [trace([864.92])], forced: 0 }).action).toBe('finish')
  })
})

describe('missingConditionParams', () => {
  const schema = {
    type: 'object',
    properties: { Username: { type: 'string' }, startStr: { type: 'string' }, endStr: { type: 'string' } },
  }

  it('用户点名了人，但 Username 为空：硬拦', () => {
    expect(
      missingConditionParams({
        question: '邓骏本月加班数据分析一下',
        schema,
        args: { startStr: '2026-11-01', endStr: '2026-11-30' },
      }),
    ).toEqual([{ field: 'Username', kind: 'person', expected: '邓骏' }])
  })

  it('UserName 已传：放行', () => {
    expect(
      missingConditionParams({
        question: '邓骏本月加班数据分析一下',
        schema,
        args: { Username: '邓骏', startStr: '2026-11-01', endStr: '2026-11-30' },
      }),
    ).toEqual([])
  })

  it('用户没点名具体人：不硬塞条件', () => {
    expect(
      missingConditionParams({
        question: '本月加班数据分析一下',
        schema,
        args: { startStr: '2026-11-01', endStr: '2026-11-30' },
      }),
    ).toEqual([])
  })

  it('点名的文档标题为空：硬拦', () => {
    expect(
      missingConditionParams({
        question: '查一下《员工考勤管理办法》里的加班规定',
        schema: { type: 'object', properties: { title: { type: 'string' } } },
        args: {},
      }),
    ).toEqual([{ field: 'title', kind: 'title', expected: '员工考勤管理办法' }])
  })

  it('点名的编号为空：硬拦', () => {
    expect(
      missingConditionParams({
        question: '查编号 Q-2026-001 的审批进度',
        schema: { type: 'object', properties: { code: { type: 'string' } } },
        args: {},
      }),
    ).toEqual([{ field: 'code', kind: 'id', expected: 'Q-2026-001' }])
  })
})
