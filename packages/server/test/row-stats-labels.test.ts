import { describe, expect, it } from 'vitest'
import { summarizeRowStats } from '../src/batch-results.js'

/** 与 DSH「客维班次排班」返回同形状：数字是字符串，姓名/部门是文本。 */
function dshPayload(rows: Array<Record<string, unknown>>) {
  return {
    Successful: true,
    ReturnData: { data: rows },
  }
}

function row(name: string, dept: string, hours: string) {
  return {
    ObjectId: `id-${name}-${hours}-${Math.random()}`,
    姓名: name,
    所在部门: dept,
    开始时间: '2026/11/20 18:00:00',
    结束时间: '2026/11/20 23:00:00',
    '加班时长（H）': hours,
    作业地: '安顺',
    工作内容: '其它（上述加班场景以外）',
    加班场景: '跨部门或支持本部门创收业务：实际管理或作业',
    填写时间: '2026/11/20 20:56:19',
  }
}

describe('summarizeRowStats 身份字段分布', () => {
  it('多人时给出 labels，让“整组当成个人”的错误可见', () => {
    const rows = [row('蒋平安', '重庆东环线组', '5.5'), row('魏竣豪', '重庆东环线组', '10.3'), row('蒋平安', '重庆东环线组', '2.5')]
    const stats = summarizeRowStats(dshPayload(rows))
    expect(stats).not.toBeNull()
    expect(stats!.rows).toBe(3)
    expect(stats!.fields['加班时长（H）']!.sum).toBe(18.3)
    expect(stats!.labels?.姓名?.count).toBe(2)
    expect(stats!.labels?.姓名?.values).toEqual(['蒋平安', '魏竣豪'])
    // 部门只有一个取值，不产生 labels，避免噪音。
    expect(stats!.labels?.所在部门).toBeUndefined()
  })

  it('单人时不输出 labels，正常回答不受影响', () => {
    const rows = [row('蒋平安', '重庆东环线组', '5.5'), row('蒋平安', '重庆东环线组', '2.45')]
    const stats = summarizeRowStats(dshPayload(rows))
    expect(stats!.labels).toBeUndefined()
    expect(stats!.fields['加班时长（H）']!.sum).toBe(7.95)
  })
})
