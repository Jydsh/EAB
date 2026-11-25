import { chartTypeDefinition, resolveChartType, type ChartTypeId } from '@eab/domain'

/**
 * 把网页版 ` ```chart ` 配置映射成钉钉 A2UI 原生 Chart 组件。
 *
 * 图表类型清单来自 @eab/domain 的 CHART_CATALOG，不在这里另写一份。
 * 钉钉公开图表协议只有 lineChart / histogram / pieChart 三种：
 * - 多系列用数据点的 type 区分；
 * - 柱状堆叠只支持 config.stack；
 * - 横向柱用 histogram + rotate:true；
 * - 散点用 lineChart + lineShape:'dot'；
 * - 没有右轴配置，所以双轴折线拆成“左轴一张 + 右轴一张”，
 *   宁可分开展示，也不把两套量纲硬塞进同一个 Y 轴；
 * - 雷达、玫瑰、极坐标、热力、瀑布等没有原生几何。实际卡片解析会带
 *   nativeOnly=true，只保留目录里 fidelity=native 的类型；其余不再画成
 *   另一种图冒充原图，而是在正文里明确提示去网页端查看。
 */
export interface DingTalkA2UIChartPoint {
  x: string
  y: number
  type?: string
}

export interface DingTalkA2UIChart {
  type: 'lineChart' | 'histogram' | 'pieChart'
  data: DingTalkA2UIChartPoint[]
  config?: Record<string, unknown>
}

export interface DingTalkChartRender {
  title: string
  chart: DingTalkA2UIChart
}

/** 钉钉端是否真的能保持原图形态；近似/降级不算支持。 */
export function isDingTalkNativeChart(kind: ChartTypeId): boolean {
  return chartTypeDefinition(kind).dingtalk.fidelity === 'native'
}

interface ParseOptions {
  /** 只接受目录里钉钉原生同形的类型；实际卡片解析必须开启。 */
  nativeOnly?: boolean
}

type ChartKind = ChartTypeId
type Axis = 'left' | 'right'

interface NormalizedSeries {
  name: string
  values: Array<number | null>
  axis: Axis
}

type GenericChartKind = Exclude<ChartKind, 'scatter' | 'bubble' | 'gauge' | 'heatmap'>

interface NormalizedChart {
  kind: GenericChartKind
  title: string
  unit: string
  unitRight: string
  categories: string[]
  series: NormalizedSeries[]
  stacked: boolean
}

interface ScatterPoint {
  x: number
  y: number
  label: string
  indexed: boolean
}

interface NormalizedScatter {
  kind: 'scatter' | 'bubble'
  title: string
  unit: string
  xLabel: string
  yLabel: string
  series: Array<{ name: string; points: ScatterPoint[] }>
}

interface NormalizedGauge {
  kind: 'gauge'
  title: string
  unit: string
  value: number
  min: number
  max: number
}

interface NormalizedHeatmap {
  kind: 'heatmap'
  title: string
  unit: string
  xLabels: string[]
  yLabels: string[]
  cells: Array<{ x: number; y: number; value: number }>
  min: number
  max: number
}

function text(value: unknown, max = 0): string {
  const result = typeof value === 'string' ? value.trim() : ''
  return max > 0 ? result.slice(0, max) : result
}

function stringField(raw: string, key: string): string {
  const match = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`).exec(raw)
  if (!match?.[1]) return ''
  try {
    return String(JSON.parse(`"${match[1]}"`))
  } catch {
    return match[1]
  }
}

function numberField(raw: string, key: string): number | null {
  const match = new RegExp(`"${key}"\\s*:\\s*(-?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[+-]?\\d+)?)`, 'i').exec(raw)
  if (!match?.[1]) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? value : null
}

/** 找到 `"key": [` 后的数组正文；数组没闭合时返回从 `[` 到文末的内容。 */
function arrayBody(raw: string, key: string): string | null {
  const match = new RegExp(`"${key}"\\s*:\\s*\\[`).exec(raw)
  if (!match) return null
  const start = match.index + match[0].length
  let depth = 1
  let inString = false
  let escaped = false
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '[') depth += 1
    else if (char === ']') {
      depth -= 1
      if (depth === 0) return raw.slice(start, index)
    }
  }
  return raw.slice(start)
}

/** 按顶层逗号拆数组，嵌套对象/数组里的逗号不拆。 */
function splitTopLevel(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let inString = false
  let escaped = false
  let start = 0
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '[' || char === '{') depth += 1
    else if (char === ']' || char === '}') depth -= 1
    else if (char === ',' && depth === 0) {
      parts.push(value.slice(start, index))
      start = index + 1
    }
  }
  parts.push(value.slice(start))
  return parts
}

/** 只取已经完整的数组项；正在生成的最后一项先跳过。 */
function completeArrayItems(body: string | null): unknown[] {
  if (!body) return []
  return splitTopLevel(body).flatMap((part) => {
    const textValue = part.trim()
    if (!textValue) return []
    try {
      return [JSON.parse(textValue)]
    } catch {
      return []
    }
  })
}

/**
 * 流式版图表解析：只消费已经完整的字段和数组项。
 * 这样图表能随着模型输出逐步长出来，又不会因为 JSON 还没闭合而解析失败。
 */
export function parseDingTalkChartPartials(raw: string, options: ParseOptions = {}): DingTalkChartRender[] {
  const type = stringField(raw, 'type')
  if (!type) return []
  const kind = chartKindOf(type)
  if (options.nativeOnly && (!kind || !isDingTalkNativeChart(kind))) return []
  const title = stringField(raw, 'title') || '图表生成中'
  const unit = stringField(raw, 'unit')
  const unitRight = stringField(raw, 'unitRight')
  const stacked = /"stacked"\s*:\s*(?:true|"true"|"stacked")/.test(raw)
  const categories = completeArrayItems(arrayBody(raw, 'categories') ?? arrayBody(raw, 'labels'))
    .map((item) => text(item, 60))
    .filter(Boolean)
  const xAxis = completeArrayItems(arrayBody(raw, 'xAxis') ?? arrayBody(raw, 'categoriesX'))
    .map((item) => text(item, 60))
    .filter(Boolean)
  const yAxis = completeArrayItems(arrayBody(raw, 'yAxis') ?? arrayBody(raw, 'categoriesY'))
    .map((item) => text(item, 60))
    .filter(Boolean)

  const seriesBody = arrayBody(raw, 'series')
  const series = sectionSeries(seriesBody)
  const data = seriesBody === null
    ? completeArrayItems(arrayBody(raw, 'data'))
    : []
  const gaugeValue = kind === 'gauge' ? numberField(raw, 'value') : null
  const gaugeReady = kind === 'gauge' && gaugeValue !== null

  if (!gaugeReady && series.length === 0 && data.length === 0) return []

  const spec: Record<string, unknown> = {
    type,
    title,
    ...(unit ? { unit } : {}),
    ...(unitRight ? { unitRight } : {}),
    ...(stacked ? { stacked: true } : {}),
    ...(categories.length > 0 ? { categories } : {}),
    ...(xAxis.length > 0 ? { xAxis } : {}),
    ...(yAxis.length > 0 ? { yAxis } : {}),
    ...(series.length > 0 ? { series } : data.length > 0 ? { data } : {}),
    ...(gaugeReady ? { value: gaugeValue } : {}),
  }
  if (gaugeReady) {
    const min = numberField(raw, 'min')
    const max = numberField(raw, 'max')
    if (min !== null) spec.min = min
    if (max !== null) spec.max = max
  }
  return parseDingTalkChartRenders(JSON.stringify(spec), options)
}

function sectionSeries(body: string | null): Array<Record<string, unknown>> {
  const complete = completeArrayItems(body).flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const record = item as Record<string, unknown>
    const name = text(record.name ?? record.label, 24)
    const values = Array.isArray(record.data)
      ? record.data
      : Array.isArray(record.values)
        ? record.values
        : []
    if (values.length === 0) return []
    return [{
      name: name || '系列',
      data: values,
      axis: text(record.axis).toLowerCase() === 'right' ? 'right' : 'left',
    }]
  })
  if (complete.length > 0) return complete

  // 第一个 series 对象还没闭合时，只要它的 data 数组已经有完整项，也可以先画出来。
  const partial = body?.trim() ?? ''
  if (!partial.startsWith('{')) return []
  const name = stringField(partial, 'name') || '系列'
  const values = completeArrayItems(arrayBody(partial, 'data') ?? arrayBody(partial, 'values'))
  if (values.length === 0) return []
  return [{
    name,
    data: values,
    axis: stringField(partial, 'axis').toLowerCase() === 'right' ? 'right' : 'left',
  }]
}

function valueItem(item: unknown): { label: string | null; value: number } | null {
  if (typeof item === 'number' || typeof item === 'string') {
    const value = Number(item)
    return Number.isFinite(value) ? { label: null, value } : null
  }
  if (Array.isArray(item)) {
    const value = Number(item[1])
    return Number.isFinite(value)
      ? { label: text(item[0]) || null, value }
      : null
  }
  if (item && typeof item === 'object') {
    const record = item as Record<string, unknown>
    const value = Number(record.value ?? record.y)
    if (!Number.isFinite(value)) return null
    return {
      label: text(record.label ?? record.name ?? record.x) || null,
      value,
    }
  }
  return null
}

function chartKindOf(value: unknown): ChartKind | null {
  return resolveChartType(value)
}

function scatterPointOf(item: unknown, fallbackX: number): ScatterPoint | null {
  if (typeof item === 'number' || typeof item === 'string') {
    const value = Number(item)
    return Number.isFinite(value) ? { x: fallbackX, y: value, label: '', indexed: true } : null
  }
  if (Array.isArray(item)) {
    const x = Number(item[0])
    const y = Number(item[1])
    return Number.isFinite(x) && Number.isFinite(y)
      ? { x, y, label: text(item[2]), indexed: false }
      : null
  }
  if (item && typeof item === 'object') {
    const record = item as Record<string, unknown>
    const x = Number(record.x ?? fallbackX)
    const y = Number(record.y ?? record.value ?? record.v)
    return Number.isFinite(x) && Number.isFinite(y)
      ? { x, y, label: text(record.label ?? record.name), indexed: record.x === undefined }
      : null
  }
  return null
}

function normalizeScatter(record: Record<string, unknown>, kind: 'scatter' | 'bubble' = 'scatter'): NormalizedScatter | null {
  const unit = text(record.unit, 10)
  const rawSeries = Array.isArray(record.series) && record.series.length > 0
    ? record.series.slice(0, 4)
    : null
  const series: NormalizedScatter['series'] = []
  const rawValues = rawSeries ? null : Array.isArray(record.data) ? record.data : []
  if (rawSeries) {
    rawSeries.forEach((entry, index) => {
      const item = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
      const values = Array.isArray(item.data)
        ? item.data
        : Array.isArray(item.values)
          ? item.values
          : []
      const points = values
        .map((value, pointIndex) => scatterPointOf(value, pointIndex + 1))
        .filter((point): point is ScatterPoint => Boolean(point))
        .sort((a, b) => a.x - b.x)
      if (points.length === 0) return
      series.push({
        name: text(item.name ?? item.label, 24) || `系列${index + 1}`,
        points,
      })
    })
  } else if (rawValues) {
    const points = rawValues
      .map((value, index) => scatterPointOf(value, index + 1))
      .filter((point): point is ScatterPoint => Boolean(point))
      .sort((a, b) => a.x - b.x)
    if (points.length > 0) series.push({ name: '数值', points })
  }
  if (series.length === 0) return null

  const indexed = series.every((item) => item.points.every((point) => point.indexed))
  return {
    kind,
    title: text(record.title, 60) || '数据分析',
    unit,
    xLabel: text(record.xLabel ?? record.xAxis, 20) || (indexed ? '条序' : 'X'),
    yLabel: text(record.yLabel ?? record.yAxis, 20) || (unit ? `数值（${unit}）` : 'Y'),
    series: series.map((item) => ({ ...item, points: item.points.slice(0, 30) })),
  }
}

function normalizeGauge(record: Record<string, unknown>): NormalizedGauge | null {
  const value = Number(record.value)
  if (!Number.isFinite(value)) return null
  const declaredMin = Number(record.min)
  const declaredMax = Number(record.max)
  const min = Number.isFinite(declaredMin) ? declaredMin : 0
  const max = Number.isFinite(declaredMax) && declaredMax > min
    ? declaredMax
    : Math.max(min + 1, value > min ? value : min + 1)
  if (!(max > min)) return null
  return {
    kind: 'gauge',
    title: `${text(record.title, 50) || '数据分析'}（仪表进度）`,
    unit: text(record.unit, 10),
    value: Math.max(min, Math.min(max, value)),
    min,
    max,
  }
}

function normalizeHeatmap(record: Record<string, unknown>): NormalizedHeatmap | null {
  const xRaw = Array.isArray(record.xAxis)
    ? record.xAxis
    : Array.isArray(record.categoriesX)
      ? record.categoriesX
      : Array.isArray(record.categories)
        ? record.categories
        : []
  const yRaw = Array.isArray(record.yAxis)
    ? record.yAxis
    : Array.isArray(record.categoriesY)
      ? record.categoriesY
      : []
  const rows = Array.isArray(record.data) ? record.data : []
  const cells: NormalizedHeatmap['cells'] = []
  rows.forEach((row, rowIndex) => {
    if (Array.isArray(row)) {
      if (row.length >= 3 && Number.isFinite(Number(row[2]))) {
        const x = Number(row[0])
        const y = Number(row[1])
        const value = Number(row[2])
        if (Number.isInteger(x) && Number.isInteger(y)) cells.push({ x, y, value })
        return
      }
      row.forEach((value, xIndex) => {
        const number = Number(value)
        if (Number.isFinite(number)) cells.push({ x: xIndex, y: rowIndex, value: number })
      })
      return
    }
    if (!row || typeof row !== 'object') return
    const item = row as Record<string, unknown>
    const x = Number(item.x ?? item.xi ?? item.col)
    const y = Number(item.y ?? item.yi ?? item.row)
    const value = Number(item.value ?? item.v)
    if (Number.isInteger(x) && Number.isInteger(y) && Number.isFinite(value)) cells.push({ x, y, value })
  })
  const kept = cells.filter((cell) => cell.x >= 0 && cell.y >= 0 && cell.x < 8 && cell.y < 8)
  if (kept.length === 0) return null
  const xCount = Math.max(xRaw.length, ...kept.map((cell) => cell.x + 1))
  const yCount = Math.max(yRaw.length, ...kept.map((cell) => cell.y + 1))
  const xLabels = Array.from({ length: xCount }, (_, index) => text(xRaw[index], 60) || `第${index + 1}列`)
  const yLabels = Array.from({ length: yCount }, (_, index) => text(yRaw[index], 60) || `第${index + 1}行`)
  const values = kept.map((cell) => cell.value)
  return {
    kind: 'heatmap',
    title: `${text(record.title, 50) || '数据分析'}（热力矩阵）`,
    unit: text(record.unit, 10),
    xLabels,
    yLabels,
    cells: kept,
    min: Math.min(...values),
    max: Math.max(...values),
  }
}

function normalizeChart(spec: unknown): NormalizedChart | NormalizedScatter | NormalizedGauge | NormalizedHeatmap | null {
  if (!spec || typeof spec !== 'object') return null
  const record = spec as Record<string, unknown>
  const kind = chartKindOf(record.type)
  if (!kind) return null
  if (kind === 'scatter' || kind === 'bubble') return normalizeScatter(record, kind)
  if (kind === 'gauge') return normalizeGauge(record)
  if (kind === 'heatmap') return normalizeHeatmap(record)

  const categoriesRaw = Array.isArray(record.categories)
    ? record.categories
    : Array.isArray(record.labels)
      ? record.labels
      : []
  const rawSeries = Array.isArray(record.series) && record.series.length > 0
    ? record.series.slice(0, 6)
    : null
  const series: NormalizedSeries[] = []
  const fallbackLabels: string[] = []

  if (rawSeries) {
    rawSeries.forEach((entry, index) => {
      const item = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
      const raw = Array.isArray(item.data)
        ? item.data
        : Array.isArray(item.values)
          ? item.values
          : []
      const values = raw.map(valueItem)
      if (fallbackLabels.length === 0) {
        values.forEach((value) => {
          if (value?.label) fallbackLabels.push(value.label)
        })
      }
      series.push({
        name: text(item.name ?? item.label, 24) || `系列${index + 1}`,
        values: values.map((value) => value?.value ?? null),
        axis: text(item.axis).toLowerCase() === 'right' ? 'right' : 'left',
      })
    })
  } else {
    const values = (Array.isArray(record.data) ? record.data : []).map(valueItem)
    values.forEach((value) => {
      fallbackLabels.push(value?.label ?? '')
    })
    series.push({
      name: '数值',
      values: values.map((value) => value?.value ?? null),
      axis: 'left',
    })
  }

  const count = Math.max(categoriesRaw.length, ...series.map((item) => item.values.length), 0)
  if (count === 0) return null
  if (!series.some((item) => item.values.some((value) => Number.isFinite(value)))) return null

  const categories = Array.from({ length: count }, (_, index) => {
    const raw = categoriesRaw[index]
    return text(raw ?? fallbackLabels[index], 60) || `第 ${index + 1} 项`
  })
  for (const item of series) {
    while (item.values.length < count) item.values.push(null)
  }

  if (kind === 'radar') {
    const dimensions = Math.min(categories.length, 8)
    if (dimensions < 3) return null
    const indicators = Array.isArray(record.indicators) ? record.indicators : []
    const axisMax = Array.from({ length: dimensions }, (_, index) => {
      const indicator = indicators[index]
      const declared = Number(
        indicator && typeof indicator === 'object'
          ? (indicator as Record<string, unknown>).max ?? (indicator as Record<string, unknown>).maxValue
          : NaN,
      )
      if (Number.isFinite(declared) && declared > 0) return declared
      const observed = Math.max(
        0,
        ...series.map((item) => Math.abs(Number(item.values[index] ?? 0))),
      )
      return observed > 0 ? observed : 1
    })
    return {
      kind: 'radar',
      title: `${text(record.title, 50) || '数据分析'}（维度分组对比）`,
      unit: '%',
      unitRight: '',
      categories: categories.slice(0, dimensions),
      series: series.slice(0, 4).map((item) => ({
        ...item,
        values: Array.from({ length: dimensions }, (_, index) => {
          const value = Number(item.values[index])
          return Number.isFinite(value)
            ? Math.round(Math.max(0, Math.min(1, value / axisMax[index])) * 1000) / 10
            : null
        }),
      })),
      stacked: false,
    }
  }

  return {
    kind,
    title: text(record.title, 60) || '数据分析',
    unit: text(record.unit, 10),
    unitRight: text(record.unitRight, 10),
    categories,
    series,
    stacked: record.stacked === true || record.stacked === 'true' ||
      record.stacked === 'stacked' || /堆叠|stack/i.test(text(record.type)),
  }
}

function compactCategories(model: NormalizedChart, limit = 10): void {
  if (model.categories.length <= limit) return
  const keep = limit - 1
  model.categories = [...model.categories.slice(0, keep), '其他']
  model.series.forEach((series) => {
    const rest = series.values.slice(keep)
    const hasValue = rest.some((value) => value !== null && Number.isFinite(value))
    const sum = rest.reduce<number>((total, value) => total + (Number(value) || 0), 0)
    series.values = [...series.values.slice(0, keep), hasValue ? sum : null]
  })
}

function pointsFor(
  series: NormalizedSeries[],
  categories: string[],
  includeType: boolean,
): DingTalkA2UIChartPoint[] {
  const points: DingTalkA2UIChartPoint[] = []
  for (const item of series) {
    categories.forEach((category, index) => {
      const value = item.values[index]
      if (value === null || !Number.isFinite(value)) return
      points.push({
        x: category,
        y: value,
        ...(includeType ? { type: item.name } : {}),
      })
    })
  }
  return points
}

function baseConfig(unit: string): Record<string, unknown> | undefined {
  const config: Record<string, unknown> = {}
  if (unit) config.yAxisConfig = { alias: unit }
  return Object.keys(config).length > 0 ? config : undefined
}

/**
 * 折线图不压缩数据点（压缩会把趋势和峰值抹平），但日期一多，X 轴标签会挤成一团。
 * 钉钉图表协议透传 G2，tickCount 控制刻度个数；这里按 3.5 个数据点一个标签估算，
 * 限定在 4~7 个，既能看出整体走势，又能让 11-01 这种日期完整读出来。
 */
function lineConfig(unit: string, categoryCount: number): Record<string, unknown> | undefined {
  const config = { ...(baseConfig(unit) ?? {}) }
  if (categoryCount > 10) {
    config.xAxisConfig = {
      tickCount: Math.max(4, Math.min(7, Math.ceil(categoryCount / 3.5))),
    }
    // tickCount 选刻度，autoHide 兜底处理个别超长分类名；两者都透传给 G2。
    config.xAxisOptions = { label: { autoHide: true } }
  }
  return Object.keys(config).length > 0 ? config : undefined
}

function titleWithAxis(model: NormalizedChart, axis: 'left' | 'right'): string {
  const unit = axis === 'right' ? model.unitRight : model.unit
  return `${model.title}（${axis === 'right' ? '右轴' : '左轴'}${unit ? ` · ${unit}` : ''}）`
}

function lineRenders(model: NormalizedChart): DingTalkChartRender[] {
  const left = model.series.filter((series) => series.axis !== 'right')
  const right = model.series.filter((series) => series.axis === 'right')
  const groups = left.length > 0 && right.length > 0
    ? [
        { axis: 'left' as const, series: left, title: titleWithAxis(model, 'left'), unit: model.unit },
        { axis: 'right' as const, series: right, title: titleWithAxis(model, 'right'), unit: model.unitRight },
      ]
    : left.length === 0 && right.length > 0
      ? [{ axis: 'right' as const, series: right, title: titleWithAxis(model, 'right'), unit: model.unitRight }]
      : [{ axis: 'left' as const, series: model.series, title: model.title, unit: model.unit }]

  return groups.flatMap((group) => {
    const data = pointsFor(group.series, model.categories, group.series.length > 1)
    if (data.length === 0) return []
    const config = lineConfig(group.unit, model.categories.length)
    return [{
      title: group.title,
      chart: {
        type: 'lineChart' as const,
        data,
        ...(config ? { config } : {}),
      },
    }]
  })
}

function pieLabel(value: string): string {
  // 钉钉原生饼图不会像网页 SVG 那样截断或换行；括号说明太长会把图例挤爆。
  const label = text(value, 60).replace(/[（(].*$/, '').trim() || '其他'
  const normalized = label === '其它' ? '其他' : label
  return normalized.length > 8 ? `${normalized.slice(0, 8)}…` : normalized
}

function gaugeRender(model: NormalizedGauge): DingTalkChartRender[] {
  const used = Math.max(0, model.value - model.min)
  const remaining = Math.max(0, model.max - model.value)
  const data: DingTalkA2UIChartPoint[] = []
  if (used > 0) data.push({ x: `已用 ${Math.round(used * 100) / 100}`, y: used })
  if (remaining > 0) data.push({ x: `剩余 ${Math.round(remaining * 100) / 100}`, y: remaining })
  if (data.length === 0) return []
  return [{ title: model.title, chart: { type: 'pieChart', data } }]
}

function heatmapRender(model: NormalizedHeatmap): DingTalkChartRender[] {
  const series: NormalizedSeries[] = model.yLabels.map((name, y) => {
    const row = model.xLabels.map((_, x) => model.cells.find((cell) => cell.x === x && cell.y === y)?.value ?? null)
    const rowMax = Math.max(0, ...row.map((value) => Math.abs(Number(value) || 0)))
    return {
      name,
      axis: 'left',
      values: row.map((value) => {
        if (value === null || !Number.isFinite(value) || rowMax <= 0) return value === null ? null : 0
        return Math.round(Math.max(0, Math.min(1, Number(value) / rowMax)) * 1000) / 10
      }),
    }
  })
  const data = pointsFor(series, model.xLabels, series.length > 1)
  if (data.length === 0) return []
  return [{
    title: model.title,
    chart: {
      type: 'histogram',
      data,
      config: { yAxisConfig: { alias: '%' } },
    },
  }]
}

function funnelRender(model: NormalizedChart): DingTalkChartRender[] {
  compactCategories(model, 8)
  if (model.series.length === 1) {
    const order = model.categories
      .map((_, index) => index)
      .sort((a, b) => (Number(model.series[0].values[b]) || 0) - (Number(model.series[0].values[a]) || 0))
    model.categories = order.map((index) => model.categories[index])
    model.series[0].values = order.map((index) => model.series[0].values[index])
  }
  const data = pointsFor(model.series, model.categories, model.series.length > 1)
  if (data.length === 0) return []
  const config = baseConfig(model.unit)
  return [{
    title: `${model.title}（漏斗逐级）`,
    chart: {
      type: 'histogram',
      data,
      ...(config ? { config } : {}),
    },
  }]
}

function waterfallRender(model: NormalizedChart): DingTalkChartRender[] {
  compactCategories(model)
  const data = pointsFor(model.series, model.categories, model.series.length > 1)
  if (data.length === 0) return []
  const config = baseConfig(model.unit)
  return [{
    title: `${model.title}（瀑布逐项）`,
    chart: {
      type: 'histogram',
      data,
      ...(config ? { config } : {}),
    },
  }]
}

/** 散点/气泡共用一个降级：保留 X/Y，钉钉没有第三个大小维度。 */
function scatterRender(model: NormalizedScatter): DingTalkChartRender[] {
  const categories: string[] = []
  const seen = new Set<string>()
  for (const item of model.series) {
    for (const point of item.points) {
      const label = point.label || String(point.x)
      if (!seen.has(label)) {
        seen.add(label)
        categories.push(label)
      }
    }
  }
  if (categories.length === 0) return []
  const data: DingTalkA2UIChartPoint[] = []
  for (const item of model.series) {
    for (const point of item.points) {
      data.push({
        x: point.label || String(point.x),
        y: point.y,
        ...(model.series.length > 1 ? { type: item.name } : {}),
      })
    }
  }
  if (data.length === 0) return []
  const config: Record<string, unknown> = { lineShape: 'dot' }
  if (model.xLabel) {
    config.xAxisConfig = {
      alias: model.xLabel,
      ...(categories.length > 10 ? { tickCount: 6 } : {}),
    }
  }
  if (categories.length > 10) config.xAxisOptions = { label: { autoHide: true } }
  if (model.unit || model.yLabel) config.yAxisConfig = { alias: model.unit || model.yLabel }
  return [{
    title: model.kind === 'bubble' ? `${model.title}（气泡）` : `${model.title}（散点）`,
    chart: { type: 'lineChart', data, config },
  }]
}

function pieFamilyRender(model: NormalizedChart): DingTalkChartRender[] {
  const first = model.series[0]
  if (!first) return []
  let data = model.categories.flatMap((category, index) => {
    const value = first.values[index]
    return value !== null && Number.isFinite(value) && value > 0
      ? [{ x: category, y: value }]
      : []
  })
  if (data.length === 0) return []
  data.sort((a, b) => b.y - a.y)
  // 饼图扇区超过 6 个时图例不可读，保留前 5 项，其余合并成“其他”。
  if (data.length > 6) {
    const top = data.slice(0, 5)
    const rest = data.slice(5).reduce((sum, point) => sum + point.y, 0)
    if (rest > 0) top.push({ x: '其他', y: rest })
    data = top
  }
  const grouped = new Map<string, number>()
  for (const point of data) {
    const label = pieLabel(point.x)
    grouped.set(label, (grouped.get(label) ?? 0) + point.y)
  }
  data = [...grouped.entries()].map(([x, y]) => ({ x, y }))
  const suffix = model.kind === 'doughnut'
    ? '（环形）'
    : model.kind === 'polarArea'
      ? '（极坐标）'
      : model.kind === 'rose'
        ? '（玫瑰）'
        : ''
  return [{
    title: `${model.title}${suffix}`,
    chart: { type: 'pieChart', data },
  }]
}

/** 解析 ```chart JSON；返回 0 条表示配置非法、没有可画的数据，或该类型不是钉钉原生支持。 */
export function parseDingTalkChartRenders(raw: string, options: ParseOptions = {}): DingTalkChartRender[] {
  let spec: unknown
  try {
    spec = JSON.parse(String(raw ?? ''))
  } catch {
    return []
  }
  const model = normalizeChart(spec)
  if (!model) return []
  if (options.nativeOnly && !isDingTalkNativeChart(model.kind)) return []
  if (model.kind === 'scatter' || model.kind === 'bubble') return scatterRender(model)
  if (model.kind === 'gauge') return gaugeRender(model)
  if (model.kind === 'heatmap') return heatmapRender(model)
  if (
    model.kind === 'pie' || model.kind === 'doughnut' ||
    model.kind === 'polarArea' || model.kind === 'rose'
  ) return pieFamilyRender(model)
  if (model.kind === 'funnel') return funnelRender(model)
  if (model.kind === 'waterfall') return waterfallRender(model)

  const chart = model as NormalizedChart
  if (chart.kind === 'radar') {
    const data = pointsFor(chart.series, chart.categories, chart.series.length > 1)
    if (data.length === 0) return []
    return [{
      title: chart.title,
      chart: {
        type: 'histogram',
        data,
        config: { yAxisConfig: { alias: '%' } },
      },
    }]
  }

  if (
    chart.kind === 'bar' || chart.kind === 'horizontalBar' ||
    chart.kind === 'stackedBar' || chart.kind === 'groupedBar'
  ) {
    compactCategories(chart)
    if ((chart.kind === 'bar' || chart.kind === 'horizontalBar') && chart.series.length === 1) {
      const order = chart.categories
        .map((_, index) => index)
        .sort((a, b) => (Number(chart.series[0].values[b]) || 0) - (Number(chart.series[0].values[a]) || 0))
      chart.categories = order.map((index) => chart.categories[index])
      chart.series[0].values = order.map((index) => chart.series[0].values[index])
    }
    const data = pointsFor(chart.series, chart.categories, chart.series.length > 1)
    if (data.length === 0) return []
    const config = {
      ...(baseConfig(chart.unit) ?? {}),
      ...(chart.stacked && chart.series.length > 1 ? { stack: true } : {}),
      ...(chart.kind === 'horizontalBar' ? { rotate: true } : {}),
    }
    return [{
      title: chart.title,
      chart: {
        type: 'histogram',
        data,
        ...(Object.keys(config).length > 0 ? { config } : {}),
      },
    }]
  }

  if (chart.categories.length > 30) {
    chart.categories = chart.categories.slice(0, 30)
    chart.series.forEach((series) => {
      series.values = series.values.slice(0, 30)
    })
  }
  const renders = lineRenders(chart)
  if (chart.kind === 'area') {
    return renders.map((render) => ({ ...render, title: `${render.title}（面积）` }))
  }
  return renders
}
