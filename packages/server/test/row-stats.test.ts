import { describe, expect, it } from 'vitest'
import { summarizeRowStats } from '../src/batch-results.js'

describe('业务工具结果的逐字段统计 rowStats', () => {
  it('对 DSH 返回的加班记录按字段精确汇总', () => {
    const payload = {
      Successful: true,
      ErrorMessage: null,
      ReturnData: {
        data: [
          { ObjectId: 'a1', 姓名: '魏竣豪', 所在部门: '重庆东环线组', 开始时间: '2026/11/22 18:42:00', 结束时间: '2026/11/23 5:00:00', '加班时长（H）': '10.3' },
          { ObjectId: 'a2', 姓名: '魏竣豪', 所在部门: '重庆东环线组', 开始时间: '2026/11/21 21:15:00', 结束时间: '2026/11/22 5:00:00', '加班时长（H）': '7.75' },
          { ObjectId: 'a3', 姓名: '魏竣豪', 所在部门: '重庆东环线组', 开始时间: '2026/11/20 18:12:00', 结束时间: '2026/11/21 5:12:00', '加班时长（H）': '11' },
          { ObjectId: 'a4', 姓名: '魏竣豪', 所在部门: '重庆东环线组', 开始时间: '2026/11/19 18:02:00', 结束时间: '2026/11/20 5:26:00', '加班时长（H）': '11.4' },
          { ObjectId: 'a5', 姓名: '魏竣豪', 所在部门: '重庆东环线组', 开始时间: '2026/11/18 12:17:00', 结束时间: '2026/11/19 7:06:00', '加班时长（H）': '17.6' },
        ],
      },
    }
    const stats = summarizeRowStats(payload)
    expect(stats).not.toBeNull()
    expect(stats?.rows).toBe(5)
    expect(stats?.path).toBe('ReturnData.data')
    expect(stats?.fields['加班时长（H）']).toEqual({ count: 5, sum: 58.05, avg: 11.61, min: 7.75, max: 17.6 })
  })

  it('用这次真实 17 条数据算出 213.27，而不是模型口算的 188.55', () => {
    const values = [10.3, 7.75, 11, 11.4, 17.6, 15.13, 9.22, 11.7, 11.65, 11, 12.87, 11, 11.25, 16.32, 16.82, 17.33, 10.93]
    const payload = { rows: values.map((value, index) => ({ id: `r${index}`, 时长: String(value) })) }
    const stats = summarizeRowStats(payload)
    expect(stats?.rows).toBe(17)
    expect(stats?.fields['时长']).toEqual({ count: 17, sum: 213.27, avg: 12.55, min: 7.75, max: 17.6 })
  })

  it('跳过非数值字段和零散数字，纯文本结果不产生统计', () => {
    const payload = { data: [{ 姓名: '甲', 部门: '一', 备注: '1' }, { 姓名: '乙', 部门: '二', 备注: 'x' }, { 姓名: '丙', 部门: '三' }] }
    expect(summarizeRowStats(payload)).toBeNull()
    expect(summarizeRowStats({ ok: true, text: 'done' })).toBeNull()
  })
})
