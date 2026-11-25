import { describe, expect, it } from 'vitest'
import { CHART_CATALOG, chartCatalogForChannel } from '@eab/domain'
import { parseDingTalkChartPartials, parseDingTalkChartRenders } from '../src/dingtalk-chart.js'
import { buildDingTalkA2UICreateMessages } from '../src/dingtalk-card.js'

describe('图表目录与钉钉 A2UI 映射', () => {
  it('网页 17 种目录示例都能解析出钉钉原生协议结构（兼容旧消息）', () => {
    for (const definition of CHART_CATALOG) {
      const blocks = parseDingTalkChartRenders(JSON.stringify(definition.example))
      expect(blocks.length).toBeGreaterThan(0)
      for (const block of blocks) {
        expect(['lineChart', 'histogram', 'pieChart']).toContain(block.chart.type)
        expect(block.chart.data.length).toBeGreaterThan(0)
        expect(block.chart.data.every((point) => Number.isFinite(point.y))).toBe(true)
      }
    }
  })

  it('钉钉实际卡片只接受 7 种原生同形图表，降级类型直接不画', () => {
    const native = chartCatalogForChannel('dingtalk')
    expect(native.map((item) => item.id)).toEqual([
      'pie',
      'bar',
      'horizontalBar',
      'line',
      'scatter',
      'stackedBar',
      'groupedBar',
    ])
    for (const definition of native) {
      const blocks = parseDingTalkChartRenders(JSON.stringify(definition.example), { nativeOnly: true })
      expect(blocks.length, definition.id).toBeGreaterThan(0)
      expect(blocks[0]?.chart.data.length, definition.id).toBeGreaterThan(0)
    }
    for (const definition of CHART_CATALOG.filter((item) => !native.includes(item))) {
      expect(
        parseDingTalkChartRenders(JSON.stringify(definition.example), { nativeOnly: true }),
        definition.id,
      ).toHaveLength(0)
      expect(
        parseDingTalkChartPartials(JSON.stringify(definition.example), { nativeOnly: true }),
        definition.id,
      ).toHaveLength(0)
    }
  })

  it('横向条形图用 rotate:true 旋转成横向，不冒充纵向柱', () => {
    const horizontalBar = chartCatalogForChannel('dingtalk').find((item) => item.id === 'horizontalBar')!
    const [block] = parseDingTalkChartRenders(JSON.stringify(horizontalBar.example), { nativeOnly: true })
    expect(block?.chart.config).toMatchObject({ rotate: true })
  })

  it('散点图用 lineShape=dot 只画点，不连成折线', () => {
    const scatter = chartCatalogForChannel('dingtalk').find((item) => item.id === 'scatter')!
    const [block] = parseDingTalkChartRenders(JSON.stringify(scatter.example), { nativeOnly: true })
    expect(block?.chart.type).toBe('lineChart')
    expect(block?.chart.config).toMatchObject({ lineShape: 'dot' })
  })

  it('气泡图保留 X/Y，标题标明气泡降级（仅旧消息兼容）', () => {
    const bubble = CHART_CATALOG.find((item) => item.id === 'bubble')!
    const [block] = parseDingTalkChartRenders(JSON.stringify(bubble.example))
    expect(block?.title).toContain('气泡')
    expect(block?.chart.type).toBe('lineChart')
    expect(block?.chart.data).toHaveLength(2)
    expect(block?.chart.data[0]).toMatchObject({ y: 17.33 })
  })

  it('仪表盘按已用/剩余两段饼图展示（仅旧消息兼容）', () => {
    const gauge = CHART_CATALOG.find((item) => item.id === 'gauge')!
    const [block] = parseDingTalkChartRenders(JSON.stringify(gauge.example))
    expect(block?.chart.type).toBe('pieChart')
    expect(block?.chart.data).toHaveLength(2)
    expect(block?.chart.data[0]?.x).toContain('已用')
    expect(block?.chart.data[1]?.x).toContain('剩余')
  })

  it('热力图按行归一化成分组柱，不丢行列标签（仅旧消息兼容）', () => {
    const heatmap = CHART_CATALOG.find((item) => item.id === 'heatmap')!
    const [block] = parseDingTalkChartRenders(JSON.stringify(heatmap.example))
    expect(block?.chart.type).toBe('histogram')
    expect(block?.title).toContain('热力矩阵')
    expect(new Set(block?.chart.data.map((point) => point.x))).toEqual(
      new Set(['11/01-11/10', '11/11-11/20', '11/21-11/24']),
    )
    expect(block?.chart.data.filter((point) => point.type === '总时长')).toHaveLength(3)
  })

  it('旧配置里的面积、雷达、漏斗、瀑布也能兼容旧消息', () => {
    const cases = [
      { type: 'area', title: '面积', categories: ['A', 'B'], series: [{ name: '甲', data: [2, 5] }] },
      { type: 'radar', title: '雷达', categories: ['A', 'B', 'C'], series: [{ name: '甲', data: [2, 5, 3] }] },
      { type: 'funnel', title: '漏斗', data: [{ label: 'A', value: 2 }, { label: 'B', value: 5 }] },
      { type: 'waterfall', title: '瀑布', data: [{ label: 'A', value: 2 }, { label: 'B', value: 5 }] },
    ]
    for (const spec of cases) {
      const blocks = parseDingTalkChartRenders(JSON.stringify(spec))
      expect(blocks.length).toBeGreaterThan(0)
      expect(blocks[0]?.chart.data.length).toBeGreaterThan(0)
      expect(parseDingTalkChartRenders(JSON.stringify(spec), { nativeOnly: true })).toHaveLength(0)
    }
  })

  it('正文超过 24 块时优先保留全部 7 张图表，不压成“已省略”', () => {
    const native = chartCatalogForChannel('dingtalk')
    const text = [
      '## 图表自检',
      ...native.flatMap((item, index) => [
        `**${item.id} · ${item.name}**`,
        '```chart',
        JSON.stringify(item.example),
        '```',
        ...Array.from({ length: 4 }, (_, line) => `第 ${index + 1} 张图的说明 ${line + 1}`),
      ]),
    ].join('\n')
    const messages = buildDingTalkA2UICreateMessages('surface-overflow', {
      answer: text,
      reasoning: '',
      tools: [],
      thinkingDone: true,
      sessionId: 'chart-overflow-check',
    })
    const data = JSON.parse(messages[1]).updateDataModel.value as {
      answer: { blocks: Array<{ chart?: unknown }> }
    }
    const charts = data.answer.blocks.filter((block) => block.chart)
    expect(data.answer.blocks).toHaveLength(24)
    expect(charts).toHaveLength(native.length)
  })
})
