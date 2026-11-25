import { describe, expect, it } from 'vitest'
import { parseDingTalkChartPartials, parseDingTalkChartRenders } from '../src/dingtalk-chart.js'

function render(value: unknown): ReturnType<typeof parseDingTalkChartRenders> {
  return parseDingTalkChartRenders(JSON.stringify(value))
}

describe('钉钉 A2UI 原生图表映射', () => {
  it('饼图转成 pieChart，并按数值降序', () => {
    const [block] = render({
      type: 'pie',
      title: '时长占比',
      data: [
        ['A', 3],
        ['B', 9],
        ['C', 1],
      ],
    })
    expect(block?.title).toBe('时长占比')
    expect(block?.chart.type).toBe('pieChart')
    expect(block?.chart.data).toEqual([
      { x: 'B', y: 9 },
      { x: 'A', y: 3 },
      { x: 'C', y: 1 },
    ])
    expect(block?.chart.config).toBeUndefined()
  })

  it('饼图去掉长括号说明并把超过 6 项的尾巴合并成其他', () => {
    const [block] = render({
      type: 'pie',
      title: '加班时长占比',
      data: [
        ['其它（上述加班场景以外）', 420],
        ['连续性工作（排班时间外）', 180],
        ['站、点外作业（休班人员）', 90],
        ['值守加班（值守人员在关站至开站期间加班）', 13],
        ['A', 8],
        ['B', 6],
        ['C', 4],
      ],
    })
    expect(block?.chart.data).toEqual([
      { x: '其他', y: 420 + 6 + 4 },
      { x: '连续性工作', y: 180 },
      { x: '站、点外作业', y: 90 },
      { x: '值守加班', y: 13 },
      { x: 'A', y: 8 },
    ])
  })

  it('多系列柱状图用 type 区分系列，堆叠时加 config.stack', () => {
    const [block] = render({
      type: 'bar',
      title: '各站数据',
      stacked: true,
      categories: ['A', 'B'],
      series: [
        { name: '时长', data: [3, 2] },
        { name: '次数', data: [1, 4], axis: 'right' },
      ],
    })
    expect(block?.chart.type).toBe('histogram')
    expect(block?.chart.data).toEqual([
      { x: 'A', y: 3, type: '时长' },
      { x: 'B', y: 2, type: '时长' },
      { x: 'A', y: 1, type: '次数' },
      { x: 'B', y: 4, type: '次数' },
    ])
    expect(block?.chart.config).toMatchObject({ stack: true })
  })

  it('多系列单轴折线保留系列名，双轴折线拆成左右两张图', () => {
    const single = render({
      type: 'line',
      title: '趋势',
      categories: ['11-18', '11-19'],
      series: [
        { name: '时长', data: [3, 2] },
        { name: '次数', data: [1, 4] },
      ],
    })
    expect(single[0]?.chart.type).toBe('lineChart')
    expect(single[0]?.chart.data).toEqual([
      { x: '11-18', y: 3, type: '时长' },
      { x: '11-19', y: 2, type: '时长' },
      { x: '11-18', y: 1, type: '次数' },
      { x: '11-19', y: 4, type: '次数' },
    ])

    const dual = render({
      type: 'line',
      title: '各站加班趋势',
      unit: '小时',
      unitRight: '次',
      categories: ['11-18', '11-19'],
      series: [
        { name: '时长', data: [3, 2] },
        { name: '次数', data: [1, 4], axis: 'right' },
      ],
    })
    expect(dual).toHaveLength(2)
    expect(dual[0]?.title).toBe('各站加班趋势（左轴 · 小时）')
    expect(dual[0]?.chart.config).toMatchObject({ yAxisConfig: { alias: '小时' } })
    expect(dual[1]?.title).toBe('各站加班趋势（右轴 · 次）')
    expect(dual[1]?.chart.config).toMatchObject({ yAxisConfig: { alias: '次' } })
    expect(dual[1]?.chart.data).toEqual([
      { x: '11-18', y: 1 },
      { x: '11-19', y: 4 },
    ])
  })

  it('密集折线图限制 X 轴刻度数量，但保留全部数据点', () => {
    const categories = Array.from({ length: 22 }, (_, index) => `11-${String(index + 1).padStart(2, '0')}`)
    const [block] = render({
      type: 'line',
      title: '张翔11月加班时长（按加班开始日）',
      categories,
      series: [{ name: '时长', data: categories.map(() => 6) }],
    })
    expect(block?.chart.type).toBe('lineChart')
    expect(block?.chart.data).toHaveLength(22)
    expect(block?.chart.config).toMatchObject({
      xAxisConfig: { tickCount: 7 },
      xAxisOptions: { label: { autoHide: true } },
    })
  })

  it('少量折线图不额外改 X 轴刻度', () => {
    const [block] = render({
      type: 'line',
      title: '趋势',
      categories: ['11-18', '11-19', '11-20'],
      series: [{ name: '时长', data: [3, 2, 4] }],
    })
    expect(block?.chart.config).toBeUndefined()
  })

  it('环形图按饼图协议渲染，不再落到不支持', () => {
    const [block] = render({
      type: 'doughnut',
      title: '三人加班占比',
      unit: '小时',
      data: [
        { label: '赵帆', value: 195.86 },
        { label: '张翔', value: 127.71 },
        { label: '李鹏', value: 102.69 },
      ],
    })
    expect(block?.chart.type).toBe('pieChart')
    expect(block?.chart.data).toEqual([
      { x: '赵帆', y: 195.86 },
      { x: '张翔', y: 127.71 },
      { x: '李鹏', y: 102.69 },
    ])
  })

  it('散点图的单列数值按条序展开，并用点模式折线协议渲染', () => {
    const [block] = render({
      type: 'scatter',
      title: '赵帆逐条加班时长散点',
      unit: '小时',
      series: [{ name: '赵帆', data: [9.18, 8.83, 9.5] }],
    })
    expect(block?.chart.type).toBe('lineChart')
    expect(block?.chart.config).toMatchObject({
      lineShape: 'dot',
      xAxisConfig: { alias: '条序' },
      yAxisConfig: { alias: '小时' },
    })
    expect(block?.chart.data).toEqual([
      { x: '1', y: 9.18 },
      { x: '2', y: 8.83 },
      { x: '3', y: 9.5 },
    ])
  })

  it('散点图支持 [x,y] 坐标对，保留真实横坐标', () => {
    const [block] = render({
      type: 'scatter',
      title: '条序与时长',
      xLabel: '条序',
      yLabel: '时长（小时）',
      series: [{ name: '赵帆', data: [[1, 4.5], [2, 3.2]] }],
    })
    expect(block?.chart.type).toBe('lineChart')
    expect(block?.chart.data).toEqual([
      { x: '1', y: 4.5 },
      { x: '2', y: 3.2 },
    ])
    expect(block?.chart.config).toMatchObject({
      lineShape: 'dot',
      xAxisConfig: { alias: '条序' },
      yAxisConfig: { alias: '时长（小时）' },
    })
  })

  it('雷达图按各维度最大值归一化后，用分组柱状协议渲染', () => {
    const [block] = render({
      type: 'radar',
      title: '三人加班画像对比',
      unit: '小时',
      categories: ['合计', '平均/次', '最大单次', '加班天数', '作业地数'],
      series: [
        { name: '赵帆', data: [195.86, 9.79, 15.08, 20, 5] },
        { name: '张翔', data: [127.71, 6.72, 9.02, 19, 1] },
      ],
    })
    expect(block?.chart.type).toBe('histogram')
    expect(block?.title).toBe('三人加班画像对比（维度分组对比）')
    expect(block?.chart.config).toMatchObject({ yAxisConfig: { alias: '%' } })
    expect(block?.chart.data).toHaveLength(10)
    expect(block?.chart.data[0]).toEqual({ x: '合计', y: 100, type: '赵帆' })
    expect(block?.chart.data[5]).toEqual({ x: '合计', y: 65.2, type: '张翔' })
  })

  it('流式散点图在只输出一列数值时也能先画点', () => {
    const partial = '{"type":"scatter","title":"点","unit":"小时","series":[{"name":"A","data":[9.18,8.83'
    const [block] = parseDingTalkChartPartials(partial)
    expect(block?.chart.type).toBe('lineChart')
    expect(block?.chart.data).toEqual([
      { x: '1', y: 9.18 },
      { x: '2', y: 8.83 },
    ])
  })

  it('流式雷达图在维度与已有系列值完整时先出图', () => {
    const partial = '{"type":"radar","title":"画像","categories":["合计","平均","天数"],' +
      '"series":[{"name":"赵帆","data":[195.86,9.79,20]}]}'
    const renders = parseDingTalkChartPartials(partial)
    expect(renders[0]?.chart.type).toBe('histogram')
    expect(renders[0]?.chart.data).toHaveLength(3)
  })

  it('空数据或非法 JSON 不生成图表', () => {
    expect(render({ type: 'pie', title: '空', data: [] })).toEqual([])
    expect(render({ type: 'bar', title: '空', categories: [], data: [] })).toEqual([])
    expect(parseDingTalkChartRenders('{not json')).toEqual([])
    expect(parseDingTalkChartRenders('')).toEqual([])
  })

  it('流式饼图只消费已经完整的数据点', () => {
    const partial = '{"type":"pie","title":"占比","data":[["A",3],["B",2'
    const [block] = parseDingTalkChartPartials(partial)
    expect(block?.chart.type).toBe('pieChart')
    expect(block?.chart.data).toEqual([{ x: 'A', y: 3 }])
  })

  it('流式柱状图外层 data 数组未闭合时保留所有完整数据点', () => {
    const partial = '{"type":"bar","title":"各站加班","data":[["A站",3],["B站",5]'
    const [block] = parseDingTalkChartPartials(partial)
    expect(block?.chart.type).toBe('histogram')
    expect(block?.chart.data).toEqual([
      { x: 'B站', y: 5 },
      { x: 'A站', y: 3 },
    ])
  })

  it('流式折线图在 series 对象未闭合时也能先画出已有数据', () => {
    const partial = '{"type":"line","title":"趋势","categories":["11-18","11-19"],' +
      '"series":[{"name":"时长","data":[3,2'
    const [block] = parseDingTalkChartPartials(partial)
    expect(block?.chart.type).toBe('lineChart')
    expect(block?.chart.data).toEqual([
      { x: '11-18', y: 3 },
      { x: '11-19', y: 2 },
    ])
  })
})
