import { describe, expect, it } from 'vitest'
import {
  CHART_CATALOG,
  CHART_TYPE_COUNT,
  CHART_TYPE_IDS,
  chartCatalogForChannel,
  chartCatalogPrompt,
  chartCatalogSummary,
  chartCountForChannel,
  chartSupportsChannel,
  resolveChartType,
} from '../src/chart-catalog.js'

describe('图表能力目录', () => {
  it('固定包含用户确认的 17 种图表，顺序与清单一致', () => {
    expect(CHART_TYPE_COUNT).toBe(17)
    expect(CHART_CATALOG.map((item) => item.id)).toEqual([...CHART_TYPE_IDS])
  })

  it('每种图表都启用、有中英文别名、有示例和钉钉映射策略', () => {
    for (const definition of CHART_CATALOG) {
      expect(definition.enabled).toBe(true)
      expect(definition.aliases.length).toBeGreaterThan(0)
      expect(definition.name.length).toBeGreaterThan(0)
      expect(definition.limits.length).toBeGreaterThan(0)
      expect(definition.example.type).toBe(definition.id)
      expect(['pieChart', 'histogram', 'lineChart']).toContain(definition.dingtalk.chart)
    }
  })

  it('网页端 17 种全支持；钉钉端只保留 native 同形的类型', () => {
    expect(chartCatalogForChannel('web')).toHaveLength(17)
    const dingtalk = chartCatalogForChannel('dingtalk')
    expect(dingtalk.map((item) => item.id)).toEqual([
      'pie',
      'bar',
      'horizontalBar',
      'line',
      'scatter',
      'stackedBar',
      'groupedBar',
    ])
    expect(chartCountForChannel('dingtalk')).toBe(7)
    for (const definition of dingtalk) {
      expect(definition.dingtalk.fidelity).toBe('native')
      expect(chartSupportsChannel(definition.id, 'dingtalk')).toBe(true)
    }
    for (const id of ['doughnut', 'area', 'radar', 'bubble', 'gauge', 'funnel', 'heatmap', 'waterfall'] as const) {
      expect(chartSupportsChannel(id, 'dingtalk')).toBe(false)
    }
  })

  it('所有别名都解析回自己的 id，未知类型返回 null', () => {
    for (const definition of CHART_CATALOG) {
      for (const alias of definition.aliases) {
        expect(resolveChartType(alias)).toBe(definition.id)
        expect(resolveChartType(alias.toUpperCase())).toBe(definition.id)
      }
    }
    expect(resolveChartType('not-a-chart')).toBeNull()
    expect(resolveChartType('')).toBeNull()
  })

  it('网页提示词包含全部 17 个 id，钉钉提示词只含 7 个原生类型', () => {
    const webPrompt = chartCatalogPrompt('web')
    for (const id of CHART_TYPE_IDS) expect(webPrompt).toContain(id)
    expect(webPrompt).toContain('网页对话当前可用 17 种')
    expect(webPrompt).toContain('type 只能是上面 17 个 id')

    const dingtalkPrompt = chartCatalogPrompt('dingtalk')
    for (const item of chartCatalogForChannel('dingtalk')) {
      expect(dingtalkPrompt).toContain(`- ${item.id}（`)
    }
    for (const id of ['doughnut', 'area', 'radar', 'bubble', 'gauge', 'funnel', 'heatmap', 'waterfall'] as const) {
      expect(dingtalkPrompt).not.toContain(`- ${id}（`)
    }
    expect(dingtalkPrompt).toContain('钉钉消息当前可用 7 种')
    expect(dingtalkPrompt).toContain('清单外的类型')
  })

  it('非数据回合摘要按渠道带上对应清单，Agent 不需猜', () => {
    const webSummary = chartCatalogSummary('web')
    for (const id of CHART_TYPE_IDS) expect(webSummary).toContain(`${id}(`)
    expect(webSummary).toContain('网页对话】当前可用 17 种')

    const dingtalkSummary = chartCatalogSummary('dingtalk')
    expect(dingtalkSummary).toContain('钉钉消息】当前可用 7 种')
    expect(dingtalkSummary).not.toContain('radar(')
  })
})
