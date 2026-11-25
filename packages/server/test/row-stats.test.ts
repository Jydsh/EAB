import { describe, expect, it } from 'vitest'
import {
  formatRowStatsBrief,
  formatRowStatsChart,
  formatRowStatsCharts,
  formatRowStatsInsights,
  formatRowStatsTable,
  formatRowStatsTrendChart,
  summarizeRowStats,
} from '../src/batch-results.js'

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

  it('插件把数据表作为 JSON 数组字符串返回时也能统计', () => {
    const stats = summarizeRowStats(JSON.stringify([
      { 姓名: '赵帆', 作业地: '贵定北站', '加班时长（H）': '5.22' },
      { 姓名: '赵帆', 作业地: '贵定北站', '加班时长（H）': '12.77' },
      { 姓名: '赵帆', 作业地: '独山站', '加班时长（H）': '9.52' },
    ]))
    expect(stats?.rows).toBe(3)
    expect(stats?.path).toBe('$')
    expect(stats?.fields['加班时长（H）']).toEqual({ count: 3, sum: 27.51, avg: 9.17, min: 5.22, max: 12.77 })
    const group = stats?.groups?.find((item) => item.field === '作业地')
    expect(group?.values.find((value) => value.value === '贵定北站')?.fields['加班时长（H）']?.sharePct).toBe(65.39)
  })

  it('按分类字段预聚合条数、合计、平均和占比', () => {
    const payload = {
      data: [
        { 姓名: '赵帆', 作业地: '贵定北', '加班时长（H）': '5.22' },
        { 姓名: '赵帆', 作业地: '贵定北', '加班时长（H）': '12.77' },
        { 姓名: '赵帆', 作业地: '铜仁南', '加班时长（H）': '15.08' },
        { 姓名: '赵帆', 作业地: '铜仁南', '加班时长（H）': '11.93' },
        { 姓名: '赵帆', 作业地: '独山', '加班时长（H）': '9.52' },
      ],
    }
    const stats = summarizeRowStats(payload)
    expect(stats?.fields['加班时长（H）']).toEqual({ count: 5, sum: 54.52, avg: 10.9, min: 5.22, max: 15.08 })
    const group = stats?.groups?.find((item) => item.field === '作业地')
    expect(group?.values).toEqual([
      { value: '贵定北', count: 2, fields: { '加班时长（H）': { count: 2, sum: 17.99, avg: 8.99, sharePct: 33 } } },
      { value: '铜仁南', count: 2, fields: { '加班时长（H）': { count: 2, sum: 27.01, avg: 13.51, sharePct: 49.54 } } },
      { value: '独山', count: 1, fields: { '加班时长（H）': { count: 1, sum: 9.52, avg: 9.52, sharePct: 17.46 } } },
    ])
  })

  it('不按唯一值字段（时间、编号）分组', () => {
    const payload = {
      data: [
        { 开始时间: '2026/11/22 18:42:00', 时长: '10.3' },
        { 开始时间: '2026/11/21 21:15:00', 时长: '7.75' },
      ],
    }
    const stats = summarizeRowStats(payload)
    expect(stats?.groups).toBeUndefined()
  })

  it('把统计摊平成模型可直接抄的短句', () => {
    const payload = {
      data: [
        { 姓名: '赵帆', 作业地: '贵定北站', '加班时长（H）': '5.22' },
        { 姓名: '赵帆', 作业地: '贵定北站', '加班时长（H）': '12.77' },
        { 姓名: '赵帆', 作业地: '独山站', '加班时长（H）': '9.52' },
      ],
    }
    const stats = summarizeRowStats(payload)
    const brief = formatRowStatsBrief(stats!)
    expect(brief).toContain('整批 3 条。加班时长（H）：3 条有值，合计 27.51，平均 9.17')
    expect(brief).toContain('按作业地分组：')
    expect(brief).toContain('- 贵定北站：2 条，加班时长（H）合计 17.99（2 条，平均 8.99，占 65.39%）')
    expect(brief).toContain('- 独山站：1 条，加班时长（H）合计 9.52（1 条，平均 9.52，占 34.61%）')
  })

  it('兜底解读只做排序和相减，数字仍来自预聚合分组', () => {
    const payload = {
      data: [
        { 姓名: '赵帆', 作业地: '贵定北站', '加班时长（H）': '5.22' },
        { 姓名: '赵帆', 作业地: '贵定北站', '加班时长（H）': '12.77' },
        { 姓名: '赵帆', 作业地: '独山站', '加班时长（H）': '9.52' },
      ],
    }
    const insights = formatRowStatsInsights(summarizeRowStats(payload)!)
    expect(insights).toContain('作业地里加班时长（H）合计最高的是贵定北站：17.99（2 条，占 65.39%）')
    expect(insights).toContain('最低的是独山站：9.52（1 条，占 34.61%）')
    expect(insights).toContain('两者相差 8.47；整批平均 9.17，单条区间 5.22–12.77')
  })

  it('保留少量原始行，模型失败时能直接还原明细表', () => {
    const payload = {
      data: [
        { 开始时间: '2026/11/22 18:42:00', 作业地: '贵定北站', '加班时长（H）': '10.3', 工作内容: '跨部门支持' },
        { 开始时间: '2026/11/21 21:15:00', 作业地: '独山站', '加班时长（H）': '9.52', 工作内容: '其它' },
        { 开始时间: '2026/11/20 18:12:00', 作业地: '贵定北站', '加班时长（H）': '7.75', 工作内容: '跨部门支持' },
      ],
    }
    const stats = summarizeRowStats(payload)!
    expect(stats.sample?.columns).toEqual(expect.arrayContaining(['开始时间', '作业地', '加班时长（H）']))
    const table = formatRowStatsTable(stats)
    expect(table).toContain('明细列表：')
    expect(table).toContain('| 开始时间 | 作业地 | 加班时长（H） |')
    expect(table).toContain('| 2026/11/22 18:42:00 | 贵定北站 | 10.3 |')
  })

  it('从分组和采样行生成可渲染的图表配置', () => {
    const payload = {
      data: [
        { 开始时间: '2026/11/01 18:00:00', 作业地: '贵定北站', '加班时长（H）': '5.22', 工作内容: '巡检' },
        { 开始时间: '2026/11/02 19:00:00', 作业地: '贵定北站', '加班时长（H）': '7.77', 工作内容: '巡检' },
        { 开始时间: '2026/11/03 20:00:00', 作业地: '铜仁南站', '加班时长（H）': '9.52', 工作内容: '检修' },
        { 开始时间: '2026/11/04 21:00:00', 作业地: '铜仁南站', '加班时长（H）': '11.93', 工作内容: '检修' },
        { 开始时间: '2026/11/05 22:00:00', 作业地: '凯里南站', '加班时长（H）': '15.08', 工作内容: '值守' },
        { 开始时间: '2026/11/06 23:00:00', 作业地: '凯里南站', '加班时长（H）': '8.08', 工作内容: '值守' },
      ],
    }
    const stats = summarizeRowStats(payload)!
    const groupChart = formatRowStatsChart(stats)
    expect(groupChart).toContain('```chart')
    expect(groupChart).toContain('"type":"pie"')
    expect(groupChart).toContain('"label":"凯里南站"')
    const trendChart = formatRowStatsTrendChart(stats)
    expect(trendChart).toContain('"type":"line"')
    expect(trendChart).toContain('"label":"11-01"')
    expect(formatRowStatsCharts(stats)).toContain('"type":"line"')
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
