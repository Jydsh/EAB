import { describe, expect, it } from 'vitest'
import {
  businessDataGateDecision,
  isRealtimeDataEvidence,
  isRealtimeDataTool,
  type AgentToolTrace,
} from '../src/routes/chat.js'

function trace(over: Partial<AgentToolTrace>): AgentToolTrace {
  return {
    id: 't1',
    name: 'cy_api_dsh_5d941a8129da49be83719d1f014d5f07',
    toolId: 'plugin:dsh-cy-api:cy_api_dsh_5d941a8129da49be83719d1f014d5f07',
    args: {},
    status: 'done',
    summary: '{"ReturnData":{"data":[]}}',
    durationMs: 400,
    ...over,
  }
}

const names = new Set(['cy_api_dsh_5d941a8129da49be83719d1f014d5f07', 'kb_search', 'workspace_read_file'])

describe('isRealtimeDataTool 通用识别（不限插件）', () => {
  it('插件、知识库、数据库、文件读取都算取数能力', () => {
    expect(isRealtimeDataTool('plugin:dsh-cy-api:cy_api_x', 'cy_api_x')).toBe(true)
    expect(isRealtimeDataTool('', 'kb_search')).toBe(true)
    expect(isRealtimeDataTool('', 'workspace_read_file')).toBe(true)
    expect(isRealtimeDataTool('db.query', 'db_query')).toBe(true)
    expect(isRealtimeDataTool('mcp:web-fetch:search', 'mcp_search')).toBe(true)
  })
  it('元工具与写操作不算取数能力', () => {
    expect(isRealtimeDataTool('tool.search', 'tool_search')).toBe(false)
    expect(isRealtimeDataTool('math.eval', 'math_eval')).toBe(false)
    expect(isRealtimeDataTool('', 'workspace_write_file')).toBe(false)
    expect(isRealtimeDataTool('', 'agent_task')).toBe(false)
    expect(isRealtimeDataTool('', 'ask_user')).toBe(false)
  })
  it('时钟本身是权威实时数据', () => {
    expect(isRealtimeDataTool('time.now', 'time_now')).toBe(true)
  })
})

describe('isRealtimeDataEvidence', () => {
  it('带参数成功的知识库检索算证据', () => {
    expect(
      isRealtimeDataEvidence(trace({ name: 'kb_search', toolId: '', args: { query: '差旅报销' }, summary: '命中 2 条' })),
    ).toBe(true)
  })
  it('零参数的接口清单不算证据', () => {
    expect(isRealtimeDataEvidence(trace({ args: {} }))).toBe(false)
  })
  it('参数全为空字符串不算证据', () => {
    expect(isRealtimeDataEvidence(trace({ args: { Username: '   ' } }))).toBe(false)
  })
  it('失败或有空结果不算证据', () => {
    expect(isRealtimeDataEvidence(trace({ status: 'error', args: { Username: '邓骏' } }))).toBe(false)
    expect(isRealtimeDataEvidence(trace({ args: { Username: '邓骏' }, summary: '' }))).toBe(false)
  })
  it('算数工具不算实时数据证据', () => {
    expect(
      isRealtimeDataEvidence(trace({ name: 'math_eval', toolId: 'math.eval', args: { expression: '1+1' }, summary: '2' })),
    ).toBe(false)
  })
})

describe('businessDataGateDecision 对所有工具生效', () => {
  it('数据类问题一次工具都没调：拦回去取数（邓骏这类串答案就是因为没拦）', () => {
    const decision = businessDataGateDecision({
      question: '邓骏的本月加班数据',
      traces: [],
      dataCapableToolNames: names,
      forced: 0,
    })
    expect(decision.action).toBe('continue')
    if (decision.action === 'continue') {
      expect(decision.message).toContain('还没取数就要回答')
      expect(decision.message).toContain('知识库检索、数据库查询、文件/表格读取')
      expect(decision.message).toContain('都不是准确数据')
    }
  })

  it('只调了零参数的接口清单：仍算没取数', () => {
    const decision = businessDataGateDecision({
      question: '魏竣豪的本月加班数据分析',
      traces: [trace({})],
      dataCapableToolNames: names,
      forced: 0,
    })
    expect(decision.action).toBe('continue')
  })

  it('带了参数但只是算数：仍算没取数', () => {
    const decision = businessDataGateDecision({
      question: '本月加班合计多少',
      traces: [trace({ name: 'math_eval', toolId: 'math.eval', args: { expression: '213.27+1' }, summary: '214.27' })],
      dataCapableToolNames: names,
      forced: 0,
    })
    expect(decision.action).toBe('continue')
  })

  it('插件带参查到数据：放行', () => {
    const decision = businessDataGateDecision({
      question: '魏竣豪的本月加班数据分析',
      traces: [trace({ args: { Username: '魏竣豪', startStr: '2026-11-01', endStr: '2026-11-30' } })],
      dataCapableToolNames: names,
      forced: 0,
    })
    expect(decision.action).toBe('finish')
  })

  it('知识库检索查到条款：放行（非插件同样有效）', () => {
    const decision = businessDataGateDecision({
      question: '公司差旅报销制度是怎么规定的',
      traces: [trace({ name: 'kb_search', toolId: '', args: { query: '差旅报销' }, summary: '命中 2 条' })],
      dataCapableToolNames: names,
      forced: 0,
    })
    expect(decision.action).toBe('finish')
  })

  it('读文件算取数（文件内容也是实时数据）', () => {
    const decision = businessDataGateDecision({
      question: '这个月的考勤表里邓骏有几天',
      traces: [trace({ name: 'workspace_read_file', toolId: '', args: { path: '考勤/11月.xlsx' }, summary: 'sheet1 31 行' })],
      dataCapableToolNames: names,
      forced: 0,
    })
    expect(decision.action).toBe('finish')
  })

  it('问“今天几号”时 time_now 零参数也算取到实时数据', () => {
    const decision = businessDataGateDecision({
      question: '今天几号',
      traces: [trace({ name: 'time_now', toolId: 'time.now', args: {}, summary: '2026-11-23 星期一' })],
      dataCapableToolNames: new Set(['time_now']),
      forced: 0,
    })
    expect(decision.action).toBe('finish')
  })

  it('没有可用的取数工具时不硬塞调用', () => {
    const decision = businessDataGateDecision({
      question: '本月加班统计',
      traces: [],
      dataCapableToolNames: new Set(),
      forced: 0,
    })
    expect(decision.action).toBe('finish')
  })

  it('闲聊不拦', () => {
    const decision = businessDataGateDecision({
      question: '帮我起草一封跟进邮件',
      traces: [],
      dataCapableToolNames: names,
      forced: 0,
    })
    expect(decision.action).toBe('finish')
  })

  it('连续拦两次后放行，避免对话卡死', () => {
    const decision = businessDataGateDecision({
      question: '邓骏的本月加班数据',
      traces: [],
      dataCapableToolNames: names,
      forced: 2,
    })
    expect(decision.action).toBe('finish')
  })
})
