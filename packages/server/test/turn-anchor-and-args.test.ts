import { describe, expect, it } from 'vitest'
import { businessDataGateDecision, missingRequiredParams, multiPersonWarning, turnChecklistAnchor, wantsBusinessDataAnswer } from '../src/routes/chat.js'

describe('turnChecklistAnchor', () => {
  it('把本轮原话放在系统提示最后一段，并写明不许沿用上一轮结论', () => {
    const anchor = turnChecklistAnchor('蒋平安本月加班数据分析一下')
    expect(anchor).toContain('本轮只回答这最后一条用户消息')
    expect(anchor).toContain('蒋平安本月加班数据分析一下')
    expect(anchor).toContain('不要把上一轮的人名、数字、结论搬过来当答案')
    expect(anchor).toContain('人名原样传')
  })

  it('原话过长时保留首尾，避免把整段历史塞进锚点', () => {
    const anchor = turnChecklistAnchor(`${'甲'.repeat(300)}结尾问题`)
    expect(anchor.length).toBeLessThan(600)
    expect(anchor).toContain('结尾问题')
  })

  it('没有用户原话时不产出空洞锚点', () => {
    expect(turnChecklistAnchor('')).toBe('')
  })
})

describe('wantsBusinessDataAnswer', () => {
  it('数据类问题命中：要求先取数', () => {
    for (const text of [
      '李鹏的本月加班总时长',
      '蒋平安的本月的加班数据分析一下',
      '这个月谁加班最多',
      '报销一共多少钱',
      '统计一下这周的天窗作业条数',
    ]) {
      expect(wantsBusinessDataAnswer(text), text).toBe(true)
    }
  })

  it('闲聊与写作不命中：不强行塞工具', () => {
    for (const text of ['你好', '帮我写一封跟进邮件', '公司差旅报销怎么走', '谢谢你']) {
      expect(wantsBusinessDataAnswer(text), text).toBe(false)
    }
  })
})

describe('missingRequiredParams', () => {
  // 与 DSH「客维班次排班」同形状：姓名 + 起止时间都是必填。
  const schema = {
    type: 'object',
    properties: { Username: { type: 'string' }, startStr: { type: 'string' }, endStr: { type: 'string' } },
    required: ['Username', 'startStr', 'endStr'],
  }

  it('空参数调用时把三个必填项都报出来（这就是拿到全组数据的原因）', () => {
    expect(missingRequiredParams(schema, {})).toEqual(['Username', 'startStr', 'endStr'])
  })

  it('只填了时间没填人名，仍然算缺参数', () => {
    expect(missingRequiredParams(schema, { startStr: '2026-11-01', endStr: '2026-11-30' })).toEqual(['Username'])
  })

  it('空字符串等同于没传', () => {
    expect(missingRequiredParams(schema, { Username: '   ', startStr: '2026-11-01', endStr: '2026-11-30' })).toEqual(['Username'])
  })

  it('参数齐全或 schema 没有必填项时放行', () => {
    expect(missingRequiredParams(schema, { Username: '蒋平安', startStr: '2026-11-01', endStr: '2026-11-30' })).toEqual([])
    expect(missingRequiredParams({ type: 'object' }, {})).toEqual([])
    expect(missingRequiredParams(undefined, {})).toEqual([])
  })
})

describe('multiPersonWarning', () => {
  it('多人数据必出硬警告，点明不能当个人合计', () => {
    const warning = multiPersonWarning({
      rows: 105,
      path: 'ReturnData.data',
      fields: {},
      labels: { 姓名: { count: 8, values: ['王铁雄', '陈杰', '蒋平安'] }, 所在部门: { count: 2, values: ['重庆东环线组', '经营中心'] } },
      note: '',
    })
    expect(warning).toContain('不是一个人')
    expect(warning).toContain('8 个不同姓名')
    expect(warning).toContain('不能当成用户问的那一个人的答案')
  })

  it('单人数据不出警告', () => {
    expect(multiPersonWarning({
      rows: 7,
      path: 'ReturnData.data',
      fields: {},
      labels: { 姓名: { count: 1, values: ['蒋平安'] } },
      note: '',
    })).toBe('')
  })

  it('没有 labels 时安全返回空串', () => {
    expect(multiPersonWarning({ rows: 3, path: '$', fields: {}, note: '' })).toBe('')
  })
})
