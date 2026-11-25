/*
 * 员工工作台（对话页）。
 *
 * 产品口径（12.7）：员工只对话。身份来自登录（开发期用 ?as= 预览），模型只列有权用的。
 * 布局对照 DeepSeek / 豆包 / 千问 网页版：左侧账号与可用模型，右侧对话；
 * 模型选择在输入框里；附件随消息发送：文本类读正文，图片转 dataURL 走视觉输入。
 */

const $ = (sel) => document.querySelector(sel)
const qs = (extra) => {
  const params = new URLSearchParams(location.search)
  if (extra) params.set('as', extra)
  const text = params.toString()
  return text ? `?${text}` : ''
}
const qsAppend = (url) => {
  const text = qs()
  if (!text) return url
  return `${url}${url.includes('?') ? '&' : '?'}${text.slice(1)}`
}
const currentAs = () => new URLSearchParams(location.search).get('as')

const ROLE_LABEL = {
  super_admin: '平台超管',
  company_admin: '公司管理员',
  company_sub_admin: '企业级子管理员',
  dept_admin: '部门管理员',
  kb_admin: '知识库运营',
  auditor: '审计员',
  member: '普通员工',
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  })
}

function answerInline(text) {
  const imageTokens = []
  const codeTokens = []
  let html = String(text ?? '').replace(
    /!\[([^\]\n]*)\]\(((?:https?:\/\/|\/api\/kb\/assets\/)[^\s)]+)\)/g,
    (_, alt, url) => {
      imageTokens.push(`<img class="answer-inline-image" src="${url}" alt="${alt}" loading="lazy">`)
      return `\u0002${imageTokens.length - 1}\u0002`
    },
  )
  html = html.replace(/`([^`\n]+)`/g, (_, code) => {
    codeTokens.push(`<code>${code}</code>`)
    return `\u0001${codeTokens.length - 1}\u0001`
  })
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
  html = html.replace(
    /\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>',
  )
  html = html.replace(/\u0002(\d+)\u0002/g, (_, index) => imageTokens[Number(index)] ?? '')
  return html.replace(/\u0001(\d+)\u0001/g, (_, index) => codeTokens[Number(index)] ?? '')
}

function answerImageOnly(line) {
  return /^\s*!\[([^\]\n]*)\]\(((?:https?:\/\/|\/api\/kb\/assets\/)[^\s)]+)\)\s*$/.exec(line)
}

function isAnswerTableSeparator(line) {
  const cells = String(line ?? '').trim().replace(/^\|/, '').replace(/\|$/, '').split('|')
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))
}

function splitAnswerTableRow(line) {
  const body = String(line ?? '').trim().replace(/^\|/, '').replace(/\|$/, '')
  return body.split('|').map((cell) => cell.trim())
}

function isAnswerBlockStart(lines, index) {
  const line = lines[index]
  if (!line.trim()) return true
  if (/^\u0000CODE\d+\u0000$/.test(line)) return true
  if (answerImageOnly(line)) return true
  if (/^\s{0,3}(#{1,6})\s+/.test(line)) return true
  if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return true
  if (/^\s{0,3}>\s?/.test(line)) return true
  if (/^\s*[-*+]\s+/.test(line)) return true
  if (/^\s*\d+[.)]\s+/.test(line)) return true
  if (line.includes('|') && index + 1 < lines.length && isAnswerTableSeparator(lines[index + 1])) return true
  return false
}

/** 归一化代码块内容，用于识别“文件正文被重复贴进回复”的情况。 */
function normalizeAnswerCodeBlock(value, alreadyEscaped = false) {
  const text = String(value ?? '').replace(/\r\n?/g, '\n')
  return (alreadyEscaped ? text : esc(text)).replace(/^\n+|\n+$/g, '').trim()
}

/** 去掉“内容如下：”这类只为引出被隐藏文件正文的尾句，避免气泡里留下空引子。 */
function trimFileContentCodeLeadIn(html) {
  const trimmed = html.replace(
    /(?:，|,)?\s*(?:文件)?(?:内容|正文)(?:如下|为|是)?\s*[：:]?(<\/p>)$/,
    '。$1',
  )
  return /^<p>\s*(?:。)?\s*<\/p>$/.test(trimmed) ? '' : trimmed
}

/** 写入成功的工作区文件正文；消息气泡里的同名代码块由顶部吊顶卡/文件预览承担，不再重复展示。 */
function writtenFileContentBlocks(tools) {
  const blocks = new Set()
  for (const trace of Array.isArray(tools) ? tools : []) {
    if (String(trace?.toolId || '') !== 'workspace.write') continue
    if (String(trace?.status || '') !== 'done') continue
    const args = trace?.args
    if (!args || typeof args !== 'object') continue
    for (const key of ['content', 'text', 'body', 'data']) {
      const value = args[key]
      if (typeof value === 'string' && value.trim()) blocks.add(normalizeAnswerCodeBlock(value))
    }
  }
  return blocks
}

/**
 * 把 esc() 之后的代码块还原回原文，供 ```chart 里的 JSON 解析。
 * 顺序必须先解 &amp; 再解其它，否则 &amp;quot; 会被拆坏。
 */
function decodeAnswerEntities(value) {
  return String(value ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

const CHART_COLORS = ['#4e79e6', '#36b37e', '#f5a623', '#e05252', '#8e6bd8', '#2ab7ca', '#d97706', '#6b7280', '#0ea5e9', '#a3a329']

/** 中文标签在 SVG 里不会自动换行，截断比溢出更安全；完整值放在 title 里。 */
function chartShort(value, max = 12) {
  const chars = Array.from(String(value ?? ''))
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('')
}

function chartNumberText(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return ''
  if (Math.abs(number) >= 10_000) return `${Math.round(number / 10_000 * 100) / 100}万`
  return String(Math.round(number * 100) / 100)
}

/**
 * 图表类型唯一入口。这里的 id 必须与 @eab/domain 的 CHART_CATALOG 一一对应，
 * 新增一种图表时先改目录，再在这里补别名和 renderer。
 */
const CHART_TYPE_ALIASES = {
  pie: ['pie', '饼图', '占比图'],
  doughnut: ['doughnut', 'donut', 'ring', '环形图', '甜甜圈图', '圆环图'],
  bar: ['bar', 'column', 'verticalbar', '柱状图', '纵向柱状图', '柱形图'],
  horizontalBar: ['horizontalbar', 'horizontal-bar', 'hbar', 'barh', '条形图', '横向柱状图', '横向条形图'],
  line: ['line', 'trend', '折线图', '趋势图', '双轴折线图'],
  area: ['area', '面积图', '面积折线图'],
  scatter: ['scatter', 'point', '散点图', '点图'],
  radar: ['radar', 'spider', '雷达图', '蜘蛛图'],
  polarArea: ['polararea', 'polar-area', 'polar', '极坐标面积图', '极坐标图', '南丁格尔极区图'],
  bubble: ['bubble', '气泡图', '气泡散点图'],
  stackedBar: ['stackedbar', 'stacked-bar', 'stack', '堆叠柱状图', '堆叠柱'],
  groupedBar: ['groupedbar', 'grouped-bar', 'grouped', '分组柱状图', '分组柱', '簇状柱状图'],
  rose: ['rose', 'nightingale', '南丁格尔玫瑰图', '玫瑰图', '玫瑰'],
  gauge: ['gauge', '仪表盘', '仪表图', '进度仪表'],
  funnel: ['funnel', '漏斗图', '转化漏斗'],
  heatmap: ['heatmap', 'heat-map', '热力图', '热图'],
  waterfall: ['waterfall', '瀑布图', '瀑布'],
}
const CHART_TYPE_MAP = new Map(Object.entries(CHART_TYPE_ALIASES).flatMap(([type, aliases]) =>
  aliases.map((alias) => [alias.toLowerCase(), type])))
const CHART_TYPE_COUNT = Object.keys(CHART_TYPE_ALIASES).length

function chartTypeOf(spec) {
  const raw = String(spec?.type ?? '').trim().toLowerCase()
  return CHART_TYPE_MAP.get(raw) || ''
}

/** 支持三种数据写法：数字、[标签, 数值]、{label, value}。 */
function chartValueItem(item) {
  if (typeof item === 'number' || typeof item === 'string') {
    const value = Number(item)
    return Number.isFinite(value) ? { label: null, value } : null
  }
  if (Array.isArray(item)) {
    const value = Number(item[1])
    return Number.isFinite(value) ? { label: String(item[0] ?? '').trim() || null, value } : null
  }
  if (item && typeof item === 'object') {
    const value = Number(item.value ?? item.y)
    return Number.isFinite(value) ? { label: String(item.label ?? item.name ?? item.x ?? '').trim() || null, value } : null
  }
  return null
}

/**
 * 归一化图表配置：
 * - 单系列：data = [3, 5] 或 [{label,value}]
 * - 多系列：categories + series: [{name, data:[...], axis?}]
 */
function chartModelOf(spec, type) {
  const categoriesRaw = Array.isArray(spec.categories) ? spec.categories : Array.isArray(spec.labels) ? spec.labels : []
  const rawSeries = Array.isArray(spec.series) && spec.series.length > 0 ? spec.series : null
  const series = []
  const fallbackLabels = []
  if (rawSeries) {
    rawSeries.slice(0, 6).forEach((entry, index) => {
      const raw = Array.isArray(entry?.data) ? entry.data : Array.isArray(entry?.values) ? entry.values : []
      const parsed = raw.map(chartValueItem)
      if (!fallbackLabels.length) {
        parsed.forEach((item) => { if (item?.label) fallbackLabels.push(item.label) })
      }
      series.push({
        name: String(entry?.name ?? entry?.label ?? `系列${index + 1}`).trim().slice(0, 24) || `系列${index + 1}`,
        values: parsed.map((item) => item?.value ?? null),
        axis: String(entry?.axis ?? '').toLowerCase() === 'right' ? 'right' : 'left',
      })
    })
  } else {
    const parsed = (Array.isArray(spec.data) ? spec.data : []).map(chartValueItem)
    parsed.forEach((item) => { fallbackLabels.push(item?.label ?? '') })
    series.push({ name: '数值', values: parsed.map((item) => item?.value ?? null), axis: 'left' })
  }
  const count = Math.max(categoriesRaw.length, ...series.map((item) => item.values.length), 0)
  if (!count) return null
  const categories = Array.from({ length: count }, (_, index) => {
    const raw = categoriesRaw[index]
    return String(raw ?? fallbackLabels[index] ?? `第 ${index + 1} 项`).trim() || `第 ${index + 1} 项`
  })
  for (const item of series) {
    while (item.values.length < count) item.values.push(null)
  }
  if (!series.some((item) => item.values.some((value) => Number.isFinite(value)))) return null
  return {
    type,
    categories,
    series,
    stacked: spec.stacked === true || spec.stacked === 'true' || spec.stacked === 'stacked' || /堆叠|stack/.test(String(spec.type ?? '').toLowerCase()),
    unit: String(spec.unit ?? '').trim().slice(0, 10),
    unitRight: String(spec.unitRight ?? '').trim().slice(0, 10),
    title: String(spec.title ?? '数据分析').trim().slice(0, 60) || '数据分析',
  }
}

function chartPointsOf(model) {
  const series = model?.series?.[0]
  if (!series) return []
  return model.categories
    .map((label, index) => ({ label, value: Number(series.values[index]) }))
    .filter((point) => Number.isFinite(point.value))
}

function chartPieArc(cx, cy, radius, start, end) {
  return [`M ${cx} ${cy}`, `L ${cx + radius * Math.cos(start)} ${cy + radius * Math.sin(start)}`,
    `A ${radius} ${radius} 0 ${end - start > Math.PI ? 1 : 0} 1 ${cx + radius * Math.cos(end)} ${cy + radius * Math.sin(end)}`,
    'Z'].join(' ')
}

function renderPieChart(points, unit) {
  const positive = points.filter((point) => point.value > 0)
  if (positive.length === 0) return ''
  const total = positive.reduce((sum, point) => sum + point.value, 0)
  if (!total) return ''
  let angle = -Math.PI / 2
  const slices = positive.map((point, index) => {
    const share = point.value / total
    const end = angle + share * Math.PI * 2
    const path = share >= 0.999
      ? ''
      : `<path d="${chartPieArc(110, 110, 86, angle, end)}" fill="${CHART_COLORS[index % CHART_COLORS.length]}"><title>${esc(point.label)} ${chartNumberText(point.value)}${unit ? ` ${esc(unit)}` : ''}（${(share * 100).toFixed(1)}%）</title></path>`
    angle = end
    return path || `<circle cx="110" cy="110" r="86" fill="${CHART_COLORS[index % CHART_COLORS.length]}"><title>${esc(point.label)} 100%</title></circle>`
  })
  const legend = positive.map((point, index) => {
    const pct = (point.value / total * 100).toFixed(1)
    return `<li><span class="answer-chart-dot" style="background:${CHART_COLORS[index % CHART_COLORS.length]}"></span>` +
      `<span class="answer-chart-label" title="${esc(point.label)}">${esc(chartShort(point.label, 14))}</span>` +
      `<strong>${chartNumberText(point.value)}${unit ? ` ${esc(unit)}` : ''}</strong><em>${pct}%</em></li>`
  }).join('')
  return `<div class="answer-chart-pie"><svg viewBox="0 0 220 220" role="img" aria-label="饼图">${slices.join('')}</svg><ul class="answer-chart-legend">${legend}</ul></div>`
}

function chartDonutArcPath(cx, cy, inner, outer, start, end) {
  return `M ${cx + outer * Math.cos(start)} ${cy + outer * Math.sin(start)} ` +
    `A ${outer} ${outer} 0 ${end - start > Math.PI ? 1 : 0} 1 ${cx + outer * Math.cos(end)} ${cy + outer * Math.sin(end)} ` +
    `L ${cx + inner * Math.cos(end)} ${cy + inner * Math.sin(end)} ` +
    `A ${inner} ${inner} 0 ${end - start > Math.PI ? 1 : 0} 0 ${cx + inner * Math.cos(start)} ${cy + inner * Math.sin(start)} Z`
}

/** 环形图与饼图共用一份数据与图例，只是挖空圆心并显示合计。 */
function renderDonutChart(points, unit) {
  const positive = points.filter((point) => point.value > 0)
  if (positive.length === 0) return ''
  const total = positive.reduce((sum, point) => sum + point.value, 0)
  if (!total) return ''
  const cx = 110
  const cy = 110
  const inner = 50
  const outer = 86
  let angle = -Math.PI / 2
  const slices = positive.map((point, index) => {
    const share = point.value / total
    const end = angle + share * Math.PI * 2
    const color = CHART_COLORS[index % CHART_COLORS.length]
    const title = `${esc(point.label)} ${chartNumberText(point.value)}${unit ? ` ${esc(unit)}` : ''}（${(share * 100).toFixed(1)}%）`
    const path = share >= 0.999
      ? `<circle cx="${cx}" cy="${cy}" r="${(inner + outer) / 2}" fill="none" stroke="${color}" stroke-width="${outer - inner}"><title>${title} 100%</title></circle>`
      : `<path d="${chartDonutArcPath(cx, cy, inner, outer, angle, end)}" fill="${color}"><title>${title}</title></path>`
    angle = end
    return path
  }).join('')
  const legend = positive.map((point, index) => {
    const pct = (point.value / total * 100).toFixed(1)
    return `<li><span class="answer-chart-dot" style="background:${CHART_COLORS[index % CHART_COLORS.length]}"></span>` +
      `<span class="answer-chart-label" title="${esc(point.label)}">${esc(chartShort(point.label, 14))}</span>` +
      `<strong>${chartNumberText(point.value)}${unit ? ` ${esc(unit)}` : ''}</strong><em>${pct}%</em></li>`
  }).join('')
  return `<div class="answer-chart-pie"><svg viewBox="0 0 220 220" role="img" aria-label="环形图">${slices}` +
    `<text class="answer-chart-donut-total" x="${cx}" y="${cy - 2}" text-anchor="middle">${chartNumberText(total)}${unit ? ` ${esc(unit)}` : ''}</text>` +
    `<text class="answer-chart-donut-caption" x="${cx}" y="${cy + 15}" text-anchor="middle">合计</text></svg>` +
    `<ul class="answer-chart-legend">${legend}</ul></div>`
}

function chartLegendHtml(model) {
  if (model.series.length < 2) return ''
  const mixedAxis = model.series.some((item) => item.axis === 'right')
  const entries = model.series.map((item, index) => {
    const right = item.axis === 'right'
    return `<li><span class="answer-chart-dot" style="background:${CHART_COLORS[index % CHART_COLORS.length]}"></span>` +
      `<span class="answer-chart-label">${esc(item.name)}</span>${mixedAxis ? `<em>${right ? '右轴' : '左轴'}</em>` : ''}</li>`
  }).join('')
  return `<ul class="answer-chart-series">${entries}</ul>`
}

function renderBarChart(model) {
  const width = 640
  const labelWidth = 116
  const valueWidth = 84
  const top = 10
  const plotWidth = width - labelWidth - valueWidth - 20
  const categoryCount = model.categories.length
  const seriesCount = model.series.length
  const stacked = model.stacked && seriesCount > 1 && model.series.every((item) => item.values.every((value) => value === null || value >= 0))
  const rowHeight = stacked ? 36 : seriesCount === 1 ? 32 : 24 + seriesCount * 10
  const height = top + categoryCount * rowHeight + 10
  const totals = model.categories.map((_, index) =>
    model.series.reduce((sum, item) => sum + (Number(item.values[index]) || 0), 0))
  const max = Math.max(...(stacked ? totals : model.series.flatMap((item) => item.values.map((value) => value ?? 0))), 0)
  const min = stacked ? 0 : Math.min(...model.series.flatMap((item) => item.values.map((value) => value ?? 0)), 0)
  const span = max - min || 1
  const zeroX = labelWidth + ((0 - min) / span) * plotWidth
  const rows = model.categories.map((label, index) => {
    const y = top + index * rowHeight
    const axisLabel = `<text class="answer-chart-axis-label" x="8" y="${y + rowHeight / 2 + 4}">${esc(chartShort(label, 10))}</text>` +
      `<rect x="${labelWidth}" y="${y + 5}" width="${plotWidth}" height="${rowHeight - 10}" rx="4" class="answer-chart-row"></rect>`
    if (stacked) {
      let cursorX = zeroX
      const segments = model.series.map((item, seriesIndex) => {
        const value = Number(item.values[index]) || 0
        if (value <= 0) return ''
        const segmentWidth = (value / span) * plotWidth
        const x = cursorX
        cursorX += segmentWidth
        return `<rect x="${x}" y="${y + 9}" width="${Math.max(1, segmentWidth)}" height="${rowHeight - 18}" fill="${CHART_COLORS[seriesIndex % CHART_COLORS.length]}">` +
          `<title>${esc(label)} · ${esc(item.name)} ${chartNumberText(value)}${model.unit ? ` ${esc(model.unit)}` : ''}</title></rect>`
      }).join('')
      const total = totals[index]
      return `<g>${axisLabel}${segments}<text class="answer-chart-value" x="${zeroX + (total / span) * plotWidth + 6}" y="${y + 22}">${chartNumberText(total)}</text></g>`
    }
    if (seriesCount === 1) {
      const value = Number(model.series[0].values[index]) || 0
      const valueX = labelWidth + ((value - min) / span) * plotWidth
      const x = Math.min(zeroX, valueX)
      const barWidth = Math.max(1, Math.abs(valueX - zeroX))
      const textX = value < 0 ? x - 6 : x + barWidth + 6
      return `<g><title>${esc(label)} ${chartNumberText(value)}${model.unit ? ` ${esc(model.unit)}` : ''}</title>${axisLabel}` +
        `<rect x="${x}" y="${y + 9}" width="${barWidth}" height="${rowHeight - 18}" rx="4" fill="${CHART_COLORS[index % CHART_COLORS.length]}"></rect>` +
        `<text class="answer-chart-value" x="${textX}" y="${y + 22}" text-anchor="${value < 0 ? 'end' : 'start'}">${chartNumberText(value)}</text></g>`
    }
    const bandTop = y + 7
    const bandHeight = rowHeight - 14
    const gap = 4
    const barHeight = Math.max(3, (bandHeight - gap * (seriesCount - 1)) / seriesCount)
    const bars = model.series.map((item, seriesIndex) => {
      const value = Number(item.values[index]) || 0
      const valueX = labelWidth + ((value - min) / span) * plotWidth
      const x = Math.min(zeroX, valueX)
      const barWidth = Math.max(1, Math.abs(valueX - zeroX))
      const barY = bandTop + seriesIndex * (barHeight + gap)
      const valueLabel = seriesCount <= 2
        ? `<text class="answer-chart-value" x="${value < 0 ? x - 5 : zeroX + barWidth + 5}" y="${barY + barHeight / 2 + 4}" text-anchor="${value < 0 ? 'end' : 'start'}">${chartNumberText(value)}</text>`
        : ''
      return `<rect x="${x}" y="${barY}" width="${barWidth}" height="${barHeight}" rx="3" fill="${CHART_COLORS[seriesIndex % CHART_COLORS.length]}">` +
        `<title>${esc(label)} · ${esc(item.name)} ${chartNumberText(value)}${model.unit ? ` ${esc(model.unit)}` : ''}</title></rect>${valueLabel}`
    }).join('')
    return `<g>${axisLabel}${bars}</g>`
  }).join('')
  const kind = stacked ? '堆叠柱状图' : seriesCount > 1 ? '分组柱状图' : '柱状图'
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${kind}" preserveAspectRatio="xMinYMid meet">${rows}</svg>`
}

function chartDomain(seriesList) {
  const values = seriesList.flatMap((item) => item.values.filter((value) => value !== null && Number.isFinite(value)))
  if (values.length === 0) return null
  let min = Math.min(...values)
  let max = Math.max(...values)
  if (min === max) {
    min -= 1
    max += 1
  }
  const pad = (max - min) * 0.12
  return { min: min - pad, max: max + pad }
}

function renderLineChart(model, options = {}) {
  const width = 640
  const height = 244
  const leftSeries = model.series.filter((item) => item.axis !== 'right')
  const rightSeries = model.series.filter((item) => item.axis === 'right')
  const hasRight = rightSeries.length > 0
  const leftDomain = chartDomain(leftSeries.length ? leftSeries : rightSeries)
  const rightDomain = hasRight ? chartDomain(rightSeries) : null
  if (!leftDomain) return ''
  const padding = { left: 54, right: hasRight ? 58 : 20, top: 16, bottom: 34 }
  const plotWidth = width - padding.left - padding.right
  const plotHeight = height - padding.top - padding.bottom
  const xAt = (index) => padding.left + (model.categories.length <= 1 ? plotWidth / 2 : (index / (model.categories.length - 1)) * plotWidth)
  const yAt = (value, axis) => {
    const domain = axis === 'right' && rightDomain ? rightDomain : leftDomain
    return padding.top + ((domain.max - value) / (domain.max - domain.min)) * plotHeight
  }
  const grid = [0, 1, 2, 3].map((tick) => {
    const y = padding.top + (tick / 3) * plotHeight
    const value = leftDomain.max - (tick / 3) * (leftDomain.max - leftDomain.min)
    return `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" class="answer-chart-grid"></line>` +
      `<text class="answer-chart-axis-value" x="${padding.left - 8}" y="${y + 4}" text-anchor="end">${chartNumberText(value)}</text>` +
      (rightDomain
        ? `<text class="answer-chart-axis-value" x="${width - padding.right + 8}" y="${y + 4}" text-anchor="start">${chartNumberText(rightDomain.max - (tick / 3) * (rightDomain.max - rightDomain.min))}</text>`
        : '')
  }).join('')
  const xLabels = model.categories.map((label, index) => {
    const step = Math.max(1, Math.ceil(model.categories.length / 7))
    if (index % step !== 0 && index !== model.categories.length - 1) return ''
    return `<text class="answer-chart-axis-label" x="${xAt(index)}" y="${height - 10}" text-anchor="middle">${esc(chartShort(label, 8))}</text>`
  }).join('')
  const areas = options.area ? model.series.map((item, seriesIndex) => {
    const color = CHART_COLORS[seriesIndex % CHART_COLORS.length]
    const domain = item.axis === 'right' && rightDomain ? rightDomain : leftDomain
    const baseY = yAt(Math.max(domain.min, Math.min(domain.max, 0)), item.axis)
    const shapes = []
    let run = []
    const flush = () => {
      if (run.length > 1) {
        shapes.push(`<path d="M ${run[0].split(',')[0]} ${baseY} L ${run.join(' L ')} L ${run[run.length - 1].split(',')[0]} ${baseY} Z" fill="${color}" fill-opacity="0.16"></path>`)
      }
      run = []
    }
    item.values.forEach((value, index) => {
      if (value === null || !Number.isFinite(value)) {
        flush()
        return
      }
      run.push(`${xAt(index).toFixed(1)},${yAt(value, item.axis).toFixed(1)}`)
    })
    flush()
    return shapes.join('')
  }).join('') : ''
  const lines = model.series.map((item, seriesIndex) => {
    const color = CHART_COLORS[seriesIndex % CHART_COLORS.length]
    const segments = []
    let points = []
    const flush = () => {
      if (points.length > 1) segments.push(`<polyline points="${points.join(' ')}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linejoin="round"></polyline>`)
      points = []
    }
    item.values.forEach((value, index) => {
      if (value === null || !Number.isFinite(value)) {
        flush()
        return
      }
      points.push(`${xAt(index)},${yAt(value, item.axis)}`)
    })
    flush()
    const dots = item.values.map((value, index) => value === null || !Number.isFinite(value) ? '' :
      `<circle cx="${xAt(index)}" cy="${yAt(value, item.axis)}" r="3.5" fill="${color}"><title>${esc(model.categories[index])} · ${esc(item.name)} ${chartNumberText(value)}${(item.axis === 'right' ? model.unitRight : model.unit) ? ` ${esc(item.axis === 'right' ? model.unitRight : model.unit)}` : ''}</title></circle>`).join('')
    return segments.join('') + dots
  }).join('')
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${options.area ? '面积图' : '折线图'}" preserveAspectRatio="xMinYMid meet">${grid}${areas}${lines}${xLabels}</svg>`
}

function chartNumericDomain(values, padRatio = 0.1) {
  const numbers = values.filter((value) => Number.isFinite(value))
  if (!numbers.length) return null
  let min = Math.min(...numbers)
  let max = Math.max(...numbers)
  if (min === max) {
    min -= 1
    max += 1
  }
  const pad = (max - min) * padRatio
  return { min: min >= 0 ? Math.max(0, min - pad) : min - pad, max: max + pad }
}

function chartScatterPoint(item, fallbackX) {
  if (typeof item === 'number') {
    return Number.isFinite(item) ? { x: fallbackX, y: item, label: '', indexed: true } : null
  }
  if (Array.isArray(item)) {
    const x = Number(item[0])
    const y = Number(item[1])
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    return { x, y, label: String(item[2] ?? '').trim(), indexed: false }
  }
  if (item && typeof item === 'object') {
    const x = Number(item.x ?? fallbackX)
    const y = Number(item.y ?? item.value ?? item.v)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    return { x, y, label: String(item.label ?? item.name ?? '').trim(), indexed: item.x === undefined }
  }
  return null
}

function chartScatterModelOf(spec) {
  const rawSeries = Array.isArray(spec.series) && spec.series.length
    ? spec.series
    : [{ name: '数据点', data: Array.isArray(spec.data) ? spec.data : Array.isArray(spec.values) ? spec.values : [] }]
  const series = []
  rawSeries.slice(0, 6).forEach((entry, seriesIndex) => {
    const raw = Array.isArray(entry?.data) ? entry.data : Array.isArray(entry?.values) ? entry.values : []
    const points = raw.map((item, index) => chartScatterPoint(item, index + 1)).filter(Boolean)
    if (!points.length) return
    series.push({
      name: String(entry?.name ?? entry?.label ?? `系列${seriesIndex + 1}`).trim().slice(0, 24) || `系列${seriesIndex + 1}`,
      points,
    })
  })
  if (!series.length) return null
  const indexed = series.some((item) => item.points.some((point) => point.indexed))
  const unit = String(spec.unit ?? '').trim().slice(0, 10)
  return {
    type: 'scatter',
    series,
    indexed,
    xLabel: String(spec.xLabel ?? spec.xAxis ?? (indexed ? '条序' : 'X')).trim().slice(0, 20) || 'X',
    yLabel: String(spec.yLabel ?? spec.yAxis ?? (unit ? `数值（${unit}）` : 'Y')).trim().slice(0, 20) || 'Y',
    title: String(spec.title ?? '数据分析').trim().slice(0, 60) || '数据分析',
  }
}

function renderScatterChart(model) {
  const width = 640
  const height = 260
  const padding = { left: 58, right: 26, top: 20, bottom: 44 }
  const plotWidth = width - padding.left - padding.right
  const plotHeight = height - padding.top - padding.bottom
  const xDomain = chartNumericDomain(model.series.flatMap((item) => item.points.map((point) => point.x)), model.indexed ? 0 : 0.1)
  const yDomain = chartNumericDomain(model.series.flatMap((item) => item.points.map((point) => point.y)))
  if (!xDomain || !yDomain) return ''
  const xAt = (value) => padding.left + ((value - xDomain.min) / (xDomain.max - xDomain.min)) * plotWidth
  const yAt = (value) => padding.top + ((yDomain.max - value) / (yDomain.max - yDomain.min)) * plotHeight
  const xTickText = (value) => model.indexed ? String(Math.round(value)) : chartNumberText(value)
  const ticks = [0, 1, 2, 3, 4]
  const grid = ticks.map((tick) => {
    const x = padding.left + (tick / 4) * plotWidth
    const y = padding.top + (tick / 4) * plotHeight
    const xValue = xDomain.min + (tick / 4) * (xDomain.max - xDomain.min)
    const yValue = yDomain.max - (tick / 4) * (yDomain.max - yDomain.min)
    return `<line x1="${x}" y1="${padding.top}" x2="${x}" y2="${height - padding.bottom}" class="answer-chart-grid"></line>` +
      `<text class="answer-chart-axis-value" x="${x}" y="${height - padding.bottom + 18}" text-anchor="middle">${xTickText(xValue)}</text>` +
      `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" class="answer-chart-grid"></line>` +
      `<text class="answer-chart-axis-value" x="${padding.left - 8}" y="${y + 4}" text-anchor="end">${chartNumberText(yValue)}</text>`
  }).join('')
  const dots = model.series.map((item, seriesIndex) => {
    const color = CHART_COLORS[seriesIndex % CHART_COLORS.length]
    return item.points.map((point) => {
      const tip = [point.label, `${model.xLabel} ${chartNumberText(point.x)}`, `${model.yLabel} ${chartNumberText(point.y)}`]
        .filter(Boolean).join(' · ')
      return `<circle cx="${xAt(point.x)}" cy="${yAt(point.y)}" r="4.6" fill="${color}" fill-opacity="0.88" stroke="#ffffff" stroke-width="1.2"><title>${esc(tip)}</title></circle>`
    }).join('')
  }).join('')
  const axisTitles =
    `<text class="answer-chart-axis-label" x="${padding.left + plotWidth / 2}" y="${height - 8}" text-anchor="middle">${esc(chartShort(model.xLabel, 18))}</text>` +
    `<text class="answer-chart-axis-label" x="14" y="${padding.top + plotHeight / 2}" text-anchor="middle" transform="rotate(-90 14 ${padding.top + plotHeight / 2})">${esc(chartShort(model.yLabel, 18))}</text>`
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="散点图" preserveAspectRatio="xMinYMid meet">${grid}${axisTitles}${dots}</svg>`
}

function chartRadarModelOf(spec) {
  const indicators = Array.isArray(spec.indicators) ? spec.indicators : []
  const categoriesRaw = Array.isArray(spec.categories) ? spec.categories : Array.isArray(spec.labels) ? spec.labels : []
  const labels = indicators.length
    ? indicators.map((item, index) => String(item?.name ?? item?.label ?? item ?? `指标${index + 1}`).trim() || `指标${index + 1}`)
    : categoriesRaw.map((item, index) => String(item ?? `指标${index + 1}`).trim() || `指标${index + 1}`)
  const rawSeries = Array.isArray(spec.series) && spec.series.length
    ? spec.series
    : [{ name: spec.name ?? '数值', data: Array.isArray(spec.data) ? spec.data : Array.isArray(spec.values) ? spec.values : [] }]
  const series = []
  rawSeries.slice(0, 6).forEach((entry, index) => {
    const raw = Array.isArray(entry?.data) ? entry.data : Array.isArray(entry?.values) ? entry.values : []
    const values = raw.map((value) => {
      const number = Number(value && typeof value === 'object' ? value.value ?? value.y : value)
      return Number.isFinite(number) ? number : null
    })
    if (!values.some((value) => value !== null)) return
    series.push({
      name: String(entry?.name ?? entry?.label ?? `系列${index + 1}`).trim().slice(0, 24) || `系列${index + 1}`,
      values,
    })
  })
  if (labels.length < 3 || !series.length) return null
  const count = Math.min(labels.length, 10)
  const axisMax = Array.from({ length: count }, (_, index) => {
    const declared = Number(indicators[index]?.max ?? indicators[index]?.maxValue)
    if (Number.isFinite(declared) && declared > 0) return declared
    const observed = Math.max(0, ...series.map((item) => Number(item.values[index] ?? 0)))
    return observed > 0 ? observed : 1
  })
  series.forEach((item) => {
    item.values = Array.from({ length: count }, (_, index) =>
      Math.max(0, Math.min(1, Number(item.values[index] ?? 0) / axisMax[index])))
  })
  return {
    type: 'radar',
    labels: labels.slice(0, count),
    series,
    unit: String(spec.unit ?? '').trim().slice(0, 10),
    title: String(spec.title ?? '数据分析').trim().slice(0, 60) || '数据分析',
  }
}

function renderRadarChart(model) {
  const width = 640
  const height = 300
  const cx = 320
  const cy = 146
  const radius = 98
  const count = model.labels.length
  const pointAt = (fraction, index) => {
    const angle = -Math.PI / 2 + (index / count) * Math.PI * 2
    return [cx + Math.cos(angle) * radius * fraction, cy + Math.sin(angle) * radius * fraction]
  }
  const rings = [0.25, 0.5, 0.75, 1].map((fraction) => {
    const points = Array.from({ length: count }, (_, index) => pointAt(fraction, index).map((value) => value.toFixed(1)).join(',')).join(' ')
    return `<polygon points="${points}" fill="none" class="answer-chart-grid"></polygon>`
  }).join('')
  const axes = model.labels.map((label, index) => {
    const [x, y] = pointAt(1, index)
    const labelRadius = radius + 18
    const angle = -Math.PI / 2 + (index / count) * Math.PI * 2
    const labelX = cx + Math.cos(angle) * labelRadius
    const labelY = cy + Math.sin(angle) * labelRadius
    const anchor = Math.cos(angle) > 0.3 ? 'start' : Math.cos(angle) < -0.3 ? 'end' : 'middle'
    return `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" class="answer-chart-grid"></line>` +
      `<text class="answer-chart-axis-label" x="${labelX}" y="${labelY + 4}" text-anchor="${anchor}">${esc(chartShort(label, 10))}</text>`
  }).join('')
  const shapes = model.series.map((item, seriesIndex) => {
    const color = CHART_COLORS[seriesIndex % CHART_COLORS.length]
    const points = item.values.map((value, index) => pointAt(Math.max(0.04, value), index).map((point) => point.toFixed(1)).join(','))
    return `<polygon points="${points.join(' ')}" fill="${color}" fill-opacity="0.1" stroke="${color}" stroke-width="2.2" stroke-linejoin="round"></polygon>` +
      item.values.map((value, index) => {
        const [x, y] = pointAt(Math.max(0.04, value), index)
        return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.2" fill="${color}"><title>${esc(model.labels[index])} · ${esc(item.name)} ${(value * 100).toFixed(0)}%</title></circle>`
      }).join('')
  }).join('')
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="雷达图" preserveAspectRatio="xMinYMid meet">${rings}${axes}${shapes}</svg>`
}

/** 纵向柱：单系列、分组、堆叠共用一个坐标系，保证 17 种里柱状家族不是同一张图换个名字。 */
function chartColumnDomain(model) {
  const values = model.stacked && model.series.length > 1
    ? model.categories.map((_, index) => model.series.reduce((sum, item) => sum + Math.max(0, Number(item.values[index]) || 0), 0))
    : model.series.flatMap((item) => item.values.map((value) => Number(value) || 0))
  const max = Math.max(0, ...values)
  const min = Math.min(0, ...values)
  if (max === min) return { min: 0, max: 1 }
  return { min, max }
}

function renderColumnChart(model, mode = 'grouped') {
  const width = 640
  const height = 288
  const padding = { left: 50, right: 18, top: 18, bottom: 48 }
  const plotWidth = width - padding.left - padding.right
  const plotHeight = height - padding.top - padding.bottom
  const stacked = mode === 'stacked' && model.series.length > 1 &&
    model.series.every((item) => item.values.every((value) => value === null || Number(value) >= 0))
  const domain = chartColumnDomain({ ...model, stacked })
  const yAt = (value) => padding.top + ((domain.max - value) / (domain.max - domain.min)) * plotHeight
  const ticks = [0, 1, 2, 3]
  const grid = ticks.map((tick) => {
    const y = padding.top + (tick / 3) * plotHeight
    const value = domain.max - (tick / 3) * (domain.max - domain.min)
    return `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" class="answer-chart-grid"></line>` +
      `<text class="answer-chart-axis-value" x="${padding.left - 8}" y="${y + 4}" text-anchor="end">${chartNumberText(value)}</text>`
  }).join('')
  const count = model.categories.length
  const band = plotWidth / Math.max(1, count)
  const bandInner = band * 0.7
  const seriesCount = model.series.length
  const slot = bandInner / Math.max(1, seriesCount)
  const barWidth = stacked ? band * 0.5 : Math.max(2, slot * 0.78)
  const categories = model.categories.map((label, index) => {
    const step = Math.max(1, Math.ceil(count / 8))
    if (index % step !== 0 && index !== count - 1) return ''
    return `<text class="answer-chart-axis-label" x="${padding.left + band * (index + 0.5)}" y="${height - 12}" text-anchor="middle">${esc(chartShort(label, 7))}</text>`
  }).join('')
  const bars = model.categories.map((label, index) => {
    const center = padding.left + band * (index + 0.5)
    const zeroY = yAt(Math.max(domain.min, Math.min(domain.max, 0)))
    if (stacked) {
      let cursor = 0
      const segments = model.series.map((item, seriesIndex) => {
        const value = Number(item.values[index]) || 0
        if (value <= 0) return ''
        const yTop = yAt(cursor + value)
        const yBottom = yAt(cursor)
        cursor += value
        return `<rect x="${center - barWidth / 2}" y="${yTop}" width="${barWidth}" height="${Math.max(1, yBottom - yTop)}" fill="${CHART_COLORS[seriesIndex % CHART_COLORS.length]}">` +
          `<title>${esc(label)} · ${esc(item.name)} ${chartNumberText(value)}${model.unit ? ` ${esc(model.unit)}` : ''}</title></rect>`
      }).join('')
      const total = Number(model.series.reduce((sum, item) => sum + (Number(item.values[index]) || 0), 0))
      const valueText = count <= 8
        ? `<text class="answer-chart-value" x="${center}" y="${yAt(total) - 6}" text-anchor="middle">${chartNumberText(total)}</text>`
        : ''
      return `<g>${segments}${valueText}</g>`
    }
    const groupWidth = seriesCount > 1 ? slot : barWidth
    return model.series.map((item, seriesIndex) => {
      const value = Number(item.values[index]) || 0
      const x = seriesCount > 1
        ? padding.left + band * index + (band - bandInner) / 2 + slot * seriesIndex + (slot - barWidth) / 2
        : center - barWidth / 2
      const y = Math.min(yAt(value), zeroY)
      const heightValue = Math.max(1, Math.abs(yAt(value) - zeroY))
      const valueText = seriesCount === 1 && count <= 8
        ? `<text class="answer-chart-value" x="${x + barWidth / 2}" y="${value >= 0 ? y - 6 : y + heightValue + 14}" text-anchor="middle">${chartNumberText(value)}</text>`
        : ''
      return `<rect x="${x}" y="${y}" width="${barWidth}" height="${heightValue}" rx="4" fill="${CHART_COLORS[seriesIndex % CHART_COLORS.length]}">` +
        `<title>${esc(label)} · ${esc(item.name)} ${chartNumberText(value)}${model.unit ? ` ${esc(model.unit)}` : ''}</title></rect>${valueText}`
    }).join('')
  }).join('')
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${stacked ? '堆叠柱状图' : seriesCount > 1 ? '分组柱状图' : '柱状图'}" preserveAspectRatio="xMinYMid meet">${grid}${bars}${categories}</svg>`
}

/** 极坐标面积图：等角度，半径按 sqrt(值) 开方，面积才与数值成正比。 */
function renderPolarAreaChart(points, unit) {
  const positive = points.filter((point) => point.value > 0)
  if (!positive.length) return ''
  const total = positive.reduce((sum, point) => sum + point.value, 0)
  const max = Math.max(...positive.map((point) => point.value))
  const cx = 130
  const cy = 126
  const outer = 92
  const angle = (Math.PI * 2) / positive.length
  const rings = [0.33, 0.66, 1].map((fraction) =>
    `<circle cx="${cx}" cy="${cy}" r="${outer * fraction}" fill="none" class="answer-chart-grid"></circle>`).join('')
  const sectors = positive.map((point, index) => {
    const start = -Math.PI / 2 + index * angle
    const end = start + angle - 0.02
    const radius = outer * Math.sqrt(point.value / max)
    const color = CHART_COLORS[index % CHART_COLORS.length]
    return `<path d="${chartPieArc(cx, cy, radius, start, end)}" fill="${color}" fill-opacity="0.82">` +
      `<title>${esc(point.label)} ${chartNumberText(point.value)}${unit ? ` ${esc(unit)}` : ''}（${(point.value / total * 100).toFixed(1)}%）</title></path>`
  }).join('')
  const legend = positive.map((point, index) =>
    `<li><span class="answer-chart-dot" style="background:${CHART_COLORS[index % CHART_COLORS.length]}"></span>` +
    `<span class="answer-chart-label">${esc(chartShort(point.label, 12))}</span><strong>${chartNumberText(point.value)}</strong></li>`).join('')
  return `<div class="answer-chart-pie"><svg viewBox="0 0 260 252" role="img" aria-label="极坐标面积图">${rings}${sectors}</svg><ul class="answer-chart-legend">${legend}</ul></div>`
}

/** 玫瑰图：等角度，半径按数值线性放大；与极坐标面积图区分开。 */
function renderRoseChart(points, unit) {
  const positive = points.filter((point) => point.value > 0)
  if (!positive.length) return ''
  const total = positive.reduce((sum, point) => sum + point.value, 0)
  const max = Math.max(...positive.map((point) => point.value))
  const cx = 130
  const cy = 126
  const outer = 96
  const angle = (Math.PI * 2) / positive.length
  const rings = [0.33, 0.66, 1].map((fraction) =>
    `<circle cx="${cx}" cy="${cy}" r="${outer * fraction}" fill="none" class="answer-chart-grid"></circle>`).join('')
  const petals = positive.map((point, index) => {
    const start = -Math.PI / 2 + index * angle
    const end = start + angle - 0.08
    const radius = Math.max(8, outer * point.value / max)
    const color = CHART_COLORS[index % CHART_COLORS.length]
    return `<path d="${chartPieArc(cx, cy, radius, start, end)}" fill="${color}" fill-opacity="0.8">` +
      `<title>${esc(point.label)} ${chartNumberText(point.value)}${unit ? ` ${esc(unit)}` : ''}（${(point.value / total * 100).toFixed(1)}%）</title></path>`
  }).join('')
  const legend = positive.map((point, index) =>
    `<li><span class="answer-chart-dot" style="background:${CHART_COLORS[index % CHART_COLORS.length]}"></span>` +
    `<span class="answer-chart-label">${esc(chartShort(point.label, 12))}</span><strong>${chartNumberText(point.value)}</strong></li>`).join('')
  return `<div class="answer-chart-pie"><svg viewBox="0 0 260 252" role="img" aria-label="玫瑰图">${rings}${petals}</svg><ul class="answer-chart-legend">${legend}</ul></div>`
}

function chartBubblePoint(item, fallbackX) {
  let x = fallbackX
  let y = null
  let r = null
  let label = ''
  let indexed = true
  if (typeof item === 'number') {
    y = item
  } else if (Array.isArray(item)) {
    x = Number(item[0])
    y = Number(item[1])
    r = Number(item[2])
    label = String(item[3] ?? '').trim()
    indexed = false
  } else if (item && typeof item === 'object') {
    x = Number(item.x ?? fallbackX)
    y = Number(item.y ?? item.value)
    r = Number(item.r ?? item.size)
    label = String(item.label ?? item.name ?? '').trim()
    indexed = item.x === undefined
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x, y, r: Number.isFinite(r) && r > 0 ? r : null, label, indexed }
}

function chartBubbleModelOf(spec) {
  const rawSeries = Array.isArray(spec.series) && spec.series.length
    ? spec.series
    : [{ name: '气泡', data: Array.isArray(spec.data) ? spec.data : [] }]
  const series = []
  rawSeries.slice(0, 4).forEach((entry, seriesIndex) => {
    const raw = Array.isArray(entry?.data) ? entry.data : Array.isArray(entry?.values) ? entry.values : []
    const points = raw.map((item, index) => chartBubblePoint(item, index + 1)).filter(Boolean)
    if (!points.length) return
    series.push({
      name: String(entry?.name ?? entry?.label ?? `系列${seriesIndex + 1}`).trim().slice(0, 24) || `系列${seriesIndex + 1}`,
      points,
    })
  })
  if (!series.length) return null
  const indexed = series.every((item) => item.points.every((point) => point.indexed))
  const unit = String(spec.unit ?? '').trim().slice(0, 10)
  return {
    type: 'bubble',
    series,
    indexed,
    xLabel: String(spec.xLabel ?? spec.xAxis ?? (indexed ? '条序' : 'X')).trim().slice(0, 20) || 'X',
    yLabel: String(spec.yLabel ?? spec.yAxis ?? (unit ? `数值（${unit}）` : 'Y')).trim().slice(0, 20) || 'Y',
    title: String(spec.title ?? '数据分析').trim().slice(0, 60) || '数据分析',
  }
}

function renderBubbleChart(model) {
  const width = 640
  const height = 270
  const padding = { left: 58, right: 26, top: 22, bottom: 44 }
  const plotWidth = width - padding.left - padding.right
  const plotHeight = height - padding.top - padding.bottom
  const all = model.series.flatMap((item) => item.points)
  const xDomain = chartNumericDomain(all.map((point) => point.x), model.indexed ? 0 : 0.1)
  const yDomain = chartNumericDomain(all.map((point) => point.y))
  if (!xDomain || !yDomain) return ''
  const sizes = all.map((point) => point.r).filter((value) => value !== null)
  const minSize = sizes.length ? Math.min(...sizes) : 0
  const maxSize = sizes.length ? Math.max(...sizes) : 0
  const xAt = (value) => padding.left + ((value - xDomain.min) / (xDomain.max - xDomain.min)) * plotWidth
  const yAt = (value) => padding.top + ((yDomain.max - value) / (yDomain.max - yDomain.min)) * plotHeight
  const radiusOf = (value) => {
    if (value === null || maxSize === minSize) return 7
    return 4 + Math.sqrt((value - minSize) / (maxSize - minSize)) * 10
  }
  const grid = [0, 1, 2, 3, 4].map((tick) => {
    const x = padding.left + (tick / 4) * plotWidth
    const y = padding.top + (tick / 4) * plotHeight
    return `<line x1="${x}" y1="${padding.top}" x2="${x}" y2="${height - padding.bottom}" class="answer-chart-grid"></line>` +
      `<text class="answer-chart-axis-value" x="${x}" y="${height - padding.bottom + 18}" text-anchor="middle">${chartNumberText(xDomain.min + (tick / 4) * (xDomain.max - xDomain.min))}</text>` +
      `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" class="answer-chart-grid"></line>` +
      `<text class="answer-chart-axis-value" x="${padding.left - 8}" y="${y + 4}" text-anchor="end">${chartNumberText(yDomain.max - (tick / 4) * (yDomain.max - yDomain.min))}</text>`
  }).join('')
  const bubbles = model.series.map((item, seriesIndex) => {
    const color = CHART_COLORS[seriesIndex % CHART_COLORS.length]
    return item.points.map((point) => {
      const tip = [point.label, `${model.xLabel} ${chartNumberText(point.x)}`, `${model.yLabel} ${chartNumberText(point.y)}`]
        .filter(Boolean).join(' · ')
      return `<circle cx="${xAt(point.x)}" cy="${yAt(point.y)}" r="${radiusOf(point.r)}" fill="${color}" fill-opacity="0.3" stroke="${color}" stroke-width="1.8">` +
        `<title>${esc(tip)}</title></circle>`
    }).join('')
  }).join('')
  const axisTitles =
    `<text class="answer-chart-axis-label" x="${padding.left + plotWidth / 2}" y="${height - 8}" text-anchor="middle">${esc(chartShort(model.xLabel, 18))}</text>` +
    `<text class="answer-chart-axis-label" x="14" y="${padding.top + plotHeight / 2}" text-anchor="middle" transform="rotate(-90 14 ${padding.top + plotHeight / 2})">${esc(chartShort(model.yLabel, 18))}</text>`
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="气泡图" preserveAspectRatio="xMinYMid meet">${grid}${axisTitles}${bubbles}</svg>`
}

function chartGaugeModelOf(spec) {
  const value = Number(spec.value)
  if (!Number.isFinite(value)) return null
  const min = Number.isFinite(Number(spec.min)) ? Number(spec.min) : 0
  const max = Number.isFinite(Number(spec.max)) ? Number(spec.max) : Math.max(min + 1, value)
  if (!(max > min)) return null
  return {
    type: 'gauge',
    value: Math.max(min, Math.min(max, value)),
    rawValue: value,
    min,
    max,
    unit: String(spec.unit ?? '').trim().slice(0, 10),
    title: String(spec.title ?? '数据分析').trim().slice(0, 60) || '数据分析',
  }
}

function renderGaugeChart(model) {
  const width = 640
  const height = 300
  const cx = 320
  const cy = 190
  const radius = 118
  const start = Math.PI * 0.75
  const totalAngle = Math.PI * 1.5
  const end = start + totalAngle
  const ratio = (model.value - model.min) / (model.max - model.min)
  const point = (angle, r) => [cx + Math.cos(angle) * r, cy + Math.sin(angle) * r]
  const arc = (from, to) => {
    const [x1, y1] = point(from, radius)
    const [x2, y2] = point(to, radius)
    return `M ${x1} ${y1} A ${radius} ${radius} 0 ${to - from > Math.PI ? 1 : 0} 1 ${x2} ${y2}`
  }
  const progressEnd = start + totalAngle * ratio
  const [nx, ny] = point(progressEnd, radius * 0.78)
  const [mx, my] = point(start, radius + 28)
  const [ex, ey] = point(end, radius + 28)
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="仪表盘" preserveAspectRatio="xMinYMid meet">` +
    `<path d="${arc(start, end)}" fill="none" stroke="#dbe3f0" stroke-width="20" stroke-linecap="round"></path>` +
    `<path d="${arc(start, progressEnd)}" fill="none" stroke="${CHART_COLORS[0]}" stroke-width="20" stroke-linecap="round"></path>` +
    `<line x1="${cx}" y1="${cy}" x2="${nx}" y2="${ny}" stroke="#1f2937" stroke-width="3"></line>` +
    `<circle cx="${cx}" cy="${cy}" r="7" fill="#1f2937"></circle>` +
    `<text class="answer-chart-axis-value" x="${mx}" y="${my}" text-anchor="middle">${chartNumberText(model.min)}</text>` +
    `<text class="answer-chart-axis-value" x="${ex}" y="${ey}" text-anchor="middle">${chartNumberText(model.max)}</text>` +
    `<text class="answer-chart-donut-total" x="${cx}" y="${cy - 16}" text-anchor="middle">${chartNumberText(model.rawValue)}${model.unit ? ` ${esc(model.unit)}` : ''}</text>` +
    `<text class="answer-chart-donut-caption" x="${cx}" y="${cy + 10}" text-anchor="middle">${(ratio * 100).toFixed(1)}%</text></svg>`
}

function renderFunnelChart(points, unit) {
  const positive = points.filter((point) => Number.isFinite(point.value) && point.value >= 0).slice(0, 8)
  if (!positive.length) return ''
  const sorted = [...positive].sort((a, b) => b.value - a.value)
  const max = Math.max(...sorted.map((point) => point.value), 1)
  const width = 640
  const topY = 12
  const stageHeight = 40
  const height = topY + sorted.length * stageHeight + 12
  const maxWidth = 500
  const minWidth = 150
  const stages = sorted.map((point, index) => {
    const y = topY + index * stageHeight
    const topWidth = maxWidth - (maxWidth - minWidth) * (index / Math.max(1, sorted.length))
    const bottomWidth = maxWidth - (maxWidth - minWidth) * ((index + 1) / Math.max(1, sorted.length))
    const color = CHART_COLORS[index % CHART_COLORS.length]
    return `<path d="M ${320 - topWidth / 2} ${y} L ${320 + topWidth / 2} ${y} L ${320 + bottomWidth / 2} ${y + stageHeight - 4} L ${320 - bottomWidth / 2} ${y + stageHeight - 4} Z" fill="${color}" fill-opacity="0.82">` +
      `<title>${esc(point.label)} ${chartNumberText(point.value)}${unit ? ` ${esc(unit)}` : ''}（${(point.value / max * 100).toFixed(0)}%）</title></path>` +
      `<text x="320" y="${y + stageHeight / 2 + 4}" text-anchor="middle" fill="#fff" font-size="12" font-weight="600">${esc(chartShort(point.label, 12))} · ${chartNumberText(point.value)}</text>`
  }).join('')
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="漏斗图" preserveAspectRatio="xMinYMid meet">${stages}</svg>`
}

function chartHeatmapModelOf(spec) {
  const xRaw = Array.isArray(spec.xAxis) ? spec.xAxis : Array.isArray(spec.categoriesX) ? spec.categoriesX : Array.isArray(spec.categories) ? spec.categories : []
  const yRaw = Array.isArray(spec.yAxis) ? spec.yAxis : Array.isArray(spec.categoriesY) ? spec.categoriesY : []
  const rows = Array.isArray(spec.data) ? spec.data : []
  const cells = []
  rows.forEach((row, rowIndex) => {
    if (Array.isArray(row)) {
      if (row.length >= 3 && Number.isFinite(Number(row[2]))) {
        cells.push({ x: Number(row[0]), y: Number(row[1]), value: Number(row[2]) })
      } else {
        row.forEach((value, xIndex) => {
          if (Number.isFinite(Number(value))) cells.push({ x: xIndex, y: rowIndex, value: Number(value) })
        })
      }
    } else if (row && typeof row === 'object') {
      const x = Number(row.x ?? row.xi ?? row.col)
      const y = Number(row.y ?? row.yi ?? row.row)
      const value = Number(row.value ?? row.v)
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(value)) cells.push({ x, y, value })
    }
  })
  if (!cells.length) return null
  const xCount = Math.max(xRaw.length, ...cells.map((cell) => cell.x + 1))
  const yCount = Math.max(yRaw.length, ...cells.map((cell) => cell.y + 1))
  const xLabels = Array.from({ length: Math.min(xCount, 8) }, (_, index) => String(xRaw[index] ?? `第 ${index + 1} 列`))
  const yLabels = Array.from({ length: Math.min(yCount, 8) }, (_, index) => String(yRaw[index] ?? `第 ${index + 1} 行`))
  const kept = cells.filter((cell) => cell.x < 8 && cell.y < 8)
  const values = kept.map((cell) => cell.value)
  return {
    type: 'heatmap',
    xLabels,
    yLabels,
    cells: kept,
    min: Math.min(...values),
    max: Math.max(...values),
    unit: String(spec.unit ?? '').trim().slice(0, 10),
    title: String(spec.title ?? '数据分析').trim().slice(0, 60) || '数据分析',
  }
}

function renderHeatmapChart(model) {
  const width = 640
  const left = 104
  const top = 44
  const cellWidth = Math.min(64, (width - left - 34) / Math.max(1, model.xLabels.length))
  const cellHeight = 42
  const height = top + model.yLabels.length * cellHeight + 24
  const span = model.max - model.min || 1
  const colorAt = (value) => {
    const ratio = (value - model.min) / span
    return `hsl(224 70% ${93 - ratio * 58}%)`
  }
  const xLabels = model.xLabels.map((label, index) =>
    `<text class="answer-chart-axis-label" x="${left + index * cellWidth + cellWidth / 2}" y="${top - 12}" text-anchor="middle">${esc(chartShort(label, 8))}</text>`).join('')
  const yLabels = model.yLabels.map((label, index) =>
    `<text class="answer-chart-axis-label" x="${left - 10}" y="${top + index * cellHeight + cellHeight / 2 + 4}" text-anchor="end">${esc(chartShort(label, 9))}</text>`).join('')
  const cells = model.cells.map((cell) => {
    const x = left + cell.x * cellWidth
    const y = top + cell.y * cellHeight
    const ratio = (cell.value - model.min) / span
    return `<rect x="${x + 2}" y="${y + 2}" width="${cellWidth - 4}" height="${cellHeight - 4}" rx="4" fill="${colorAt(cell.value)}">` +
      `<title>${esc(model.xLabels[cell.x])} · ${esc(model.yLabels[cell.y])} ${chartNumberText(cell.value)}${model.unit ? ` ${esc(model.unit)}` : ''}</title></rect>` +
      (cellWidth >= 42 && cellHeight >= 24
        ? `<text x="${x + cellWidth / 2}" y="${y + cellHeight / 2 + 4}" text-anchor="middle" font-size="11" fill="${ratio > 0.55 ? '#fff' : '#26334d'}">${chartNumberText(cell.value)}</text>`
        : '')
  }).join('')
  const legendColors = [0, 0.25, 0.5, 0.75, 1].map((ratio) =>
    `<rect x="${width - 154 + ratio * 40}" y="${height - 16}" width="24" height="8" fill="hsl(224 70% ${93 - ratio * 58}%)"></rect>`).join('')
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="热力图" preserveAspectRatio="xMinYMid meet">${xLabels}${yLabels}${cells}` +
    `<text class="answer-chart-axis-value" x="${width - 166}" y="${height - 9}" text-anchor="end">低</text><text class="answer-chart-axis-value" x="${width - 46}" y="${height - 9}">高</text>${legendColors}</svg>`
}

function chartWaterfallModelOf(spec) {
  const raw = Array.isArray(spec.data) ? spec.data : []
  const items = []
  let cursor = 0
  for (const [index, entry] of raw.slice(0, 12).entries()) {
    const record = entry && typeof entry === 'object' ? entry : {}
    const value = Number(Array.isArray(entry) ? entry[1] : record.value ?? entry)
    if (!Number.isFinite(value)) continue
    const total = record.total === true || record.isTotal === true
    const start = total ? 0 : cursor
    const end = total ? value : cursor + value
    items.push({
      label: String(record.label ?? (Array.isArray(entry) ? entry[0] : '') ?? `第 ${index + 1} 项`).trim() || `第 ${index + 1} 项`,
      value,
      start,
      end,
      total,
    })
    cursor = end
  }
  if (!items.length) return null
  const values = [0, ...items.flatMap((item) => [item.start, item.end])]
  const max = Math.max(...values)
  const min = Math.min(...values)
  return {
    type: 'waterfall',
    items,
    min,
    max,
    unit: String(spec.unit ?? '').trim().slice(0, 10),
    title: String(spec.title ?? '数据分析').trim().slice(0, 60) || '数据分析',
  }
}

function renderWaterfallChart(model) {
  const width = 640
  const height = 300
  const padding = { left: 50, right: 18, top: 20, bottom: 48 }
  const plotWidth = width - padding.left - padding.right
  const plotHeight = height - padding.top - padding.bottom
  const max = Math.max(0, model.max)
  const min = Math.min(0, model.min)
  const span = max - min || 1
  const yAt = (value) => padding.top + ((max - value) / span) * plotHeight
  const count = model.items.length
  const band = plotWidth / Math.max(1, count)
  const barWidth = band * 0.56
  const zeroY = yAt(0)
  const grid = [0, 1, 2, 3].map((tick) => {
    const y = padding.top + (tick / 3) * plotHeight
    return `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" class="answer-chart-grid"></line>` +
      `<text class="answer-chart-axis-value" x="${padding.left - 8}" y="${y + 4}" text-anchor="end">${chartNumberText(max - (tick / 3) * span)}</text>`
  }).join('')
  const connectors = model.items.slice(1).map((item, index) => {
    const prev = model.items[index]
    const x1 = padding.left + band * (index + 0.5) + barWidth / 2
    const x2 = padding.left + band * (index + 1.5) - barWidth / 2
    return `<line x1="${x1}" y1="${yAt(prev.end)}" x2="${x2}" y2="${yAt(item.total ? 0 : item.start)}" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="4 3"></line>`
  }).join('')
  const bars = model.items.map((item, index) => {
    const x = padding.left + band * (index + 0.5) - barWidth / 2
    const y = Math.min(yAt(item.start), yAt(item.end))
    const h = Math.max(1, Math.abs(yAt(item.end) - yAt(item.start)))
    const color = item.total ? CHART_COLORS[0] : item.value >= 0 ? '#36b37e' : '#e05252'
    return `<rect x="${x}" y="${y}" width="${barWidth}" height="${h}" rx="4" fill="${color}">` +
      `<title>${esc(item.label)} ${chartNumberText(item.value)}${model.unit ? ` ${esc(model.unit)}` : ''}</title></rect>` +
      `<text class="answer-chart-value" x="${x + barWidth / 2}" y="${Math.min(yAt(item.start), yAt(item.end)) - 5}" text-anchor="middle">${chartNumberText(item.value)}</text>` +
      `<text class="answer-chart-axis-label" x="${x + barWidth / 2}" y="${height - 12}" text-anchor="middle">${esc(chartShort(item.label, 7))}</text>`
  }).join('')
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="瀑布图" preserveAspectRatio="xMinYMid meet">${grid}${connectors}${bars}</svg>`
}

/** 把 SVG 的 CSS 计算样式写回元素属性，导出的 PNG 才能保留文字和网格颜色。 */
function inlineChartSvgStyles(source, clone) {
  const sourceNodes = [source, ...source.querySelectorAll('*')]
  const cloneNodes = [clone, ...clone.querySelectorAll('*')]
  sourceNodes.forEach((node, index) => {
    const target = cloneNodes[index]
    if (!target) return
    const style = getComputedStyle(node)
    for (const name of ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'font-size', 'font-weight', 'font-family', 'opacity', 'fill-opacity', 'stroke-opacity']) {
      const value = style.getPropertyValue(name)
      if (value) target.setAttribute(name, value)
    }
  })
}

async function chartPngDataUrl(card) {
  const svg = card?.querySelector('.answer-chart-body svg')
  if (!svg) throw new Error('没有可导出的图表')
  const viewBox = svg.viewBox?.baseVal
  const chartWidth = Math.max(220, Math.round(viewBox?.width || svg.getBoundingClientRect().width || 640))
  const chartHeight = Math.max(160, Math.round(viewBox?.height || svg.getBoundingClientRect().height || 240))
  const clone = svg.cloneNode(true)
  inlineChartSvgStyles(svg, clone)
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  clone.setAttribute('width', String(chartWidth))
  clone.setAttribute('height', String(chartHeight))
  const serialized = new XMLSerializer().serializeToString(clone)
  const imageUrl = URL.createObjectURL(new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const image = new Image()
    await new Promise((resolve, reject) => {
      image.onload = resolve
      image.onerror = () => reject(new Error('图表图片加载失败'))
      image.src = imageUrl
    })
    const padding = 24
    const header = 52
    const fontFamily = '"PingFang SC", "Microsoft YaHei", sans-serif'
    const pieLegend = [...card.querySelectorAll('.answer-chart-legend li')].map((item) => ({
      label: item.querySelector('.answer-chart-label')?.textContent?.trim() || '',
      value: item.querySelector('strong')?.textContent?.trim() || '',
      pct: item.querySelector('em')?.textContent?.trim() || '',
      color: getComputedStyle(item.querySelector('.answer-chart-dot')).backgroundColor,
      labelColor: getComputedStyle(item).color,
      valueColor: getComputedStyle(item.querySelector('strong')).color,
    }))
    const seriesLegend = [...card.querySelectorAll('.answer-chart-series li')].map((item) => ({
      text: [item.querySelector('.answer-chart-label')?.textContent?.trim(), item.querySelector('em')?.textContent?.trim()]
        .filter(Boolean).join(' · '),
      color: getComputedStyle(item.querySelector('.answer-chart-dot')).backgroundColor,
      labelColor: getComputedStyle(item).color,
    }))
    const isPie = pieLegend.length > 0
    const contentWidth = isPie ? 640 : chartWidth + padding * 2
    const measure = document.createElement('canvas').getContext('2d')
    measure.font = `12px ${fontFamily}`
    const legendRows = []
    if (seriesLegend.length && !isPie) {
      let row = []
      let rowWidth = 0
      for (const item of seriesLegend) {
        const itemWidth = 20 + measure.measureText(item.text).width + 18
        if (row.length && rowWidth + itemWidth > chartWidth) {
          legendRows.push(row)
          row = []
          rowWidth = 0
        }
        row.push({ ...item, x: rowWidth })
        rowWidth += itemWidth
      }
      if (row.length) legendRows.push(row)
    }
    const legendHeight = legendRows.length ? legendRows.length * 20 + 4 : 0
    const pieRows = isPie ? pieLegend.length : 0
    const bodyHeight = isPie ? Math.max(chartHeight, pieRows * 22 + 8) : chartHeight
    const scale = Math.min(3, Math.max(2, 2400 / contentWidth))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(contentWidth * scale)
    canvas.height = Math.round((header + legendHeight + bodyHeight + padding) * scale)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('浏览器不支持导出')
    context.scale(scale, scale)
    const cardBackground = getComputedStyle(card).backgroundColor
    context.fillStyle = !cardBackground || cardBackground === 'rgba(0, 0, 0, 0)' ? '#ffffff' : cardBackground
    context.fillRect(0, 0, contentWidth, header + legendHeight + bodyHeight + padding)
    const titleNode = card.querySelector('.answer-chart-title')
    context.fillStyle = titleNode ? getComputedStyle(titleNode).color || '#111827' : '#111827'
    context.font = `600 18px ${fontFamily}`
    context.textBaseline = 'middle'
    context.fillText(titleNode?.textContent?.trim() || '图表', padding, header / 2 - 2)
    const bodyY = header + legendHeight
    if (legendRows.length && !isPie) {
      context.font = `12px ${fontFamily}`
      legendRows.forEach((row, rowIndex) => {
        const y = header + rowIndex * 20 + 8
        for (const item of row) {
          const x = padding + item.x
          context.fillStyle = item.color
          context.beginPath()
          context.arc(x + 4, y, 4, 0, Math.PI * 2)
          context.fill()
          context.fillStyle = item.labelColor || '#6b7280'
          context.fillText(item.text, x + 15, y)
        }
      })
    }
    if (isPie) {
      context.drawImage(image, padding + 4, bodyY, chartWidth, chartHeight)
      const legendX = padding + chartWidth + 42
      pieLegend.forEach((item, index) => {
        const y = bodyY + 14 + index * 22
        context.fillStyle = item.color
        context.beginPath()
        context.arc(legendX + 4, y, 4, 0, Math.PI * 2)
        context.fill()
        context.font = `12px ${fontFamily}`
        context.fillStyle = item.labelColor || '#6b7280'
        context.fillText(chartShort(item.label, 14), legendX + 15, y)
        context.font = `600 12px ${fontFamily}`
        context.fillStyle = item.valueColor || '#111827'
        context.textAlign = 'right'
        context.fillText(item.value, contentWidth - padding - 54, y)
        context.font = `11px ${fontFamily}`
        context.fillStyle = item.labelColor || '#6b7280'
        context.fillText(item.pct, contentWidth - padding, y)
        context.textAlign = 'left'
      })
    } else {
      context.drawImage(image, padding, bodyY, chartWidth, chartHeight)
    }
    return canvas.toDataURL('image/png')
  } finally {
    URL.revokeObjectURL(imageUrl)
  }
}

async function exportChartPng(button) {
  const card = button.closest('.answer-chart')
  if (!card) return
  const label = button.textContent
  button.disabled = true
  button.textContent = '导出中…'
  try {
    const url = await chartPngDataUrl(card)
    const title = (card.querySelector('.answer-chart-title')?.textContent || '图表').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 60)
    const link = document.createElement('a')
    link.href = url
    link.download = `${title || '图表'}.png`
    document.body.appendChild(link)
    link.click()
    link.remove()
  } catch (error) {
    button.textContent = '导出失败'
    setTimeout(() => { button.textContent = label }, 1800)
    return
  } finally {
    button.disabled = false
    if (button.textContent === '导出中…') button.textContent = label
  }
}

document.addEventListener('click', (event) => {
  const button = event.target instanceof Element ? event.target.closest('[data-chart-export]') : null
  if (!button) return
  event.preventDefault()
  void exportChartPng(button)
})

/** 从还没闭合的图表 JSON 里取“已经完整”的字段和数组项，供流式阶段先长图。 */
function chartJsonValueStart(text, field) {
  const match = new RegExp(`"${field}"\\s*:\\s*`).exec(String(text ?? ''))
  return match ? match.index + match[0].length : -1
}

function chartJsonBalancedSlice(text, start) {
  let depth = 0
  let quote = false
  let escape = false
  for (let index = start; index < text.length; index += 1) {
    const ch = text[index]
    if (quote) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') quote = false
      continue
    }
    if (ch === '"') {
      quote = true
      continue
    }
    if (ch === '[' || ch === '{') {
      depth += 1
      continue
    }
    if (ch === ']' || ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return text.slice(start)
}

function chartJsonStringField(text, field) {
  const start = chartJsonValueStart(text, field)
  if (start < 0 || text[start] !== '"') return null
  let escape = false
  for (let index = start + 1; index < text.length; index += 1) {
    const ch = text[index]
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\') {
      escape = true
      continue
    }
    if (ch !== '"') continue
    try {
      return JSON.parse(text.slice(start, index + 1))
    } catch {
      return null
    }
  }
  return null
}

function chartJsonNumberField(text, field) {
  const start = chartJsonValueStart(text, field)
  if (start < 0) return null
  const match = /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(text.slice(start))
  return match ? Number(match[0]) : null
}

function chartJsonArrayBody(text, field) {
  const start = chartJsonValueStart(text, field)
  if (start < 0 || text[start] !== '[') return null
  return chartJsonBalancedSlice(text, start)
}

function chartJsonStructureClosed(text) {
  const value = String(text ?? '').trim()
  let depth = 0
  let quote = false
  let escape = false
  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index]
    if (quote) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') quote = false
      continue
    }
    if (ch === '"') {
      quote = true
      continue
    }
    if (ch === '[' || ch === '{') {
      depth += 1
      continue
    }
    if (ch === ']' || ch === '}') {
      depth -= 1
      if (depth === 0) return index === value.length - 1
    }
  }
  return false
}

function chartSplitTopLevelItems(body) {
  const value = String(body ?? '').trim()
  if (!value.startsWith('[')) return []
  let text = value.slice(1)
  if (chartJsonStructureClosed(value)) text = text.replace(/\]\s*$/, '')
  const parts = []
  let depth = 0
  let quote = false
  let escape = false
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index]
    if (quote) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') quote = false
      continue
    }
    if (ch === '"') {
      quote = true
      continue
    }
    if (ch === '[' || ch === '{') {
      depth += 1
      continue
    }
    if (ch === ']' || ch === '}') {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (ch !== ',' || depth !== 0) continue
    parts.push(text.slice(start, index))
    start = index + 1
  }
  parts.push(text.slice(start))
  return parts.map((part) => part.trim()).filter(Boolean)
}

function chartCompleteArrayItems(body) {
  if (!body) return []
  const items = []
  for (const part of chartSplitTopLevelItems(body)) {
    try {
      const item = JSON.parse(part)
      if (item !== null) items.push(item)
    } catch {
      // 最后一项通常只写了一半，等下一次流式刷新再取。
    }
  }
  return items
}

function chartTopLevelObjects(body) {
  const value = String(body ?? '').trim()
  if (!value.startsWith('[')) return []
  let text = value.slice(1)
  if (chartJsonStructureClosed(value)) text = text.replace(/\]\s*$/, '')
  const objects = []
  let index = 0
  while (index < text.length) {
    if (text[index] !== '{') {
      index += 1
      continue
    }
    const slice = chartJsonBalancedSlice(text, index)
    objects.push(slice)
    if (!slice.trim().endsWith('}')) break
    index += slice.length
  }
  return objects
}

function chartPartialSeries(raw) {
  const body = chartJsonArrayBody(raw, 'series')
  if (!body) return null
  const series = []
  for (const objectText of chartTopLevelObjects(body)) {
    let entry = null
    try {
      entry = JSON.parse(objectText)
    } catch {
      const dataBody = chartJsonArrayBody(objectText, 'data') ?? chartJsonArrayBody(objectText, 'values')
      const data = chartCompleteArrayItems(dataBody)
      if (!data.length) continue
      const name = chartJsonStringField(objectText, 'name') ?? chartJsonStringField(objectText, 'label')
      const axis = chartJsonStringField(objectText, 'axis')
      entry = { data }
      if (name) entry.name = name
      if (axis) entry.axis = axis
    }
    if (!entry || typeof entry !== 'object') continue
    const data = Array.isArray(entry.data) ? entry.data : Array.isArray(entry.values) ? entry.values : []
    if (!data.length) continue
    series.push({ ...entry, data })
  }
  return series.length ? series : null
}

function chartPartialSpec(raw) {
  const typeRaw = chartJsonStringField(raw, 'type')
  const type = chartTypeOf({ type: typeRaw })
  if (!typeRaw || !type) return null
  const spec = {
    type: typeRaw,
    title: chartJsonStringField(raw, 'title') ?? '图表生成中',
  }
  const unit = chartJsonStringField(raw, 'unit')
  const unitRight = chartJsonStringField(raw, 'unitRight')
  if (unit) spec.unit = unit
  if (unitRight) spec.unitRight = unitRight
  if (/"stacked"\s*:\s*(true|"true")/.test(raw)) spec.stacked = true
  const categories = chartCompleteArrayItems(chartJsonArrayBody(raw, 'categories'))
  if (categories.length) spec.categories = categories
  const labels = chartCompleteArrayItems(chartJsonArrayBody(raw, 'labels'))
  if (labels.length) spec.labels = labels
  const indicators = chartCompleteArrayItems(chartJsonArrayBody(raw, 'indicators'))
  if (indicators.length) spec.indicators = indicators
  const xLabel = chartJsonStringField(raw, 'xLabel')
  const yLabel = chartJsonStringField(raw, 'yLabel')
  if (xLabel) spec.xLabel = xLabel
  if (yLabel) spec.yLabel = yLabel
  const xAxis = chartCompleteArrayItems(chartJsonArrayBody(raw, 'xAxis'))
  const yAxis = chartCompleteArrayItems(chartJsonArrayBody(raw, 'yAxis'))
  const categoriesX = chartCompleteArrayItems(chartJsonArrayBody(raw, 'categoriesX'))
  const categoriesY = chartCompleteArrayItems(chartJsonArrayBody(raw, 'categoriesY'))
  if (xAxis.length) spec.xAxis = xAxis
  if (yAxis.length) spec.yAxis = yAxis
  if (categoriesX.length) spec.categoriesX = categoriesX
  if (categoriesY.length) spec.categoriesY = categoriesY
  if (type === 'gauge') {
    const value = chartJsonNumberField(raw, 'value')
    if (value === null) return null
    spec.value = value
    const min = chartJsonNumberField(raw, 'min')
    const max = chartJsonNumberField(raw, 'max')
    if (min !== null) spec.min = min
    if (max !== null) spec.max = max
    return spec
  }
  const series = type === 'pie' ? null : chartPartialSeries(raw)
  const data = chartCompleteArrayItems(chartJsonArrayBody(raw, 'data'))
  if (series) spec.series = series
  else if (data.length) spec.data = data
  else return null
  return spec
}

/** ```chart JSON → 气泡里的图表卡片；任何异常都降级成提示，不影响整条消息。 */
function renderChartBlock(rawCode, options = {}) {
  const partial = options.partial === true
  const decoded = decodeAnswerEntities(rawCode)
  let spec = null
  try {
    spec = JSON.parse(decoded)
  } catch {
    if (!partial) return '<div class="answer-chart is-error">图表配置解析失败，已跳过。</div>'
    spec = chartPartialSpec(decoded)
    if (!spec) return ''
  }
  if (!spec || typeof spec !== 'object') return partial ? '' : '<div class="answer-chart is-error">图表配置为空，已跳过。</div>'
  const type = chartTypeOf(spec)
  if (!type) return partial ? '' : `<div class="answer-chart is-error">不支持的图表类型：${esc(String(spec.type ?? ''))}</div>`
  let model = null
  if (type === 'scatter') model = chartScatterModelOf(spec)
  else if (type === 'bubble') model = chartBubbleModelOf(spec)
  else if (type === 'gauge') model = chartGaugeModelOf(spec)
  else if (type === 'heatmap') model = chartHeatmapModelOf(spec)
  else if (type === 'waterfall') model = chartWaterfallModelOf(spec)
  else if (type === 'radar') model = chartRadarModelOf(spec)
  else model = chartModelOf(spec, type)
  if (!model) return partial ? '' : '<div class="answer-chart is-error">图表没有可用的数据点。</div>'
  let body = ''
  const kindLabel = {
    pie: '占比', doughnut: '占比', polarArea: '极坐标分布', rose: '玫瑰占比',
    bar: '纵向对比', horizontalBar: '横向对比', stackedBar: '堆叠对比', groupedBar: '分组对比',
    line: '趋势', area: '面积趋势',
    scatter: '相关分布', bubble: '气泡分布', radar: '多维对比',
    gauge: '进度', funnel: '转化', heatmap: '热力分布', waterfall: '累加',
  }[type]
  if (type === 'pie' || type === 'doughnut' || type === 'polarArea' || type === 'rose') {
    let points = chartPointsOf(model)
    if (points.length === 0) return partial ? '' : '<div class="answer-chart is-error">图表没有可用的数据点。</div>'
    const limit = type === 'polarArea' || type === 'rose' ? 8 : 10
    if (points.length > limit) {
      const rest = points.slice(limit - 1)
      points = [...points.slice(0, limit - 1), { label: '其他', value: rest.reduce((sum, point) => sum + point.value, 0) }]
    }
    points.sort((a, b) => b.value - a.value)
    if (type === 'pie') body = renderPieChart(points, model.unit)
    else if (type === 'doughnut') body = renderDonutChart(points, model.unit)
    else if (type === 'polarArea') body = renderPolarAreaChart(points, model.unit)
    else body = renderRoseChart(points, model.unit)
  } else if (type === 'bar' || type === 'horizontalBar' || type === 'stackedBar' || type === 'groupedBar') {
    const limit = 12
    if (model.categories.length > limit) {
      model.categories = [...model.categories.slice(0, limit), '其他']
      model.series.forEach((item) => {
        const rest = item.values.slice(limit)
        const sum = rest.reduce((total, value) => total + (Number(value) || 0), 0)
        item.values = [...item.values.slice(0, limit), sum]
      })
    }
    if (type === 'horizontalBar') body = renderBarChart(model)
    else body = renderColumnChart(model, type === 'stackedBar' ? 'stacked' : 'grouped')
  } else if (type === 'line' || type === 'area') {
    body = renderLineChart(model, { area: type === 'area' })
  } else if (type === 'scatter') {
    body = renderScatterChart(model)
  } else if (type === 'bubble') {
    body = renderBubbleChart(model)
  } else if (type === 'radar') {
    body = renderRadarChart(model)
  } else if (type === 'gauge') {
    body = renderGaugeChart(model)
  } else if (type === 'funnel') {
    body = renderFunnelChart(chartPointsOf(model), model.unit)
  } else if (type === 'heatmap') {
    body = renderHeatmapChart(model)
  } else if (type === 'waterfall') {
    body = renderWaterfallChart(model)
  }
  if (!body) return partial ? '' : '<div class="answer-chart is-error">图表没有可展示的数值。</div>'
  const unitText = type === 'scatter' || type === 'bubble'
    ? `${model.xLabel} × ${model.yLabel}`
    : type === 'radar'
      ? '各维度归一化'
      : type === 'gauge'
        ? `${chartNumberText(model.min)}–${chartNumberText(model.max)}${model.unit ? ` ${model.unit}` : ''}`
        : type === 'heatmap'
          ? `${model.xLabels.length} × ${model.yLabels.length}${model.unit ? ` · ${model.unit}` : ''}`
          : model.unitRight
            ? [model.unit && `左轴 ${model.unit}`, `右轴 ${model.unitRight}`].filter(Boolean).join(' · ')
            : model.unit
  const hasSeriesLegend = !['pie', 'doughnut', 'polarArea', 'rose', 'gauge', 'funnel', 'heatmap', 'waterfall'].includes(type)
  return `<div class="answer-chart"><div class="answer-chart-head"><span class="answer-chart-title">${esc(model.title)}</span>` +
    `<span class="answer-chart-tools"><span class="answer-chart-kind">${kindLabel}${unitText ? ` · ${esc(unitText)}` : ''}</span>` +
    `<button class="answer-chart-export" type="button" data-chart-export data-tip="把当前图表导出为 PNG 图片" aria-label="导出 PNG">导出 PNG</button></span></div>` +
    `<div class="answer-chart-body">${hasSeriesLegend ? chartLegendHtml(model) : ''}${body}</div></div>`
}

/** Markdown：标题、列表、表格、引用、分隔线、代码块、行内代码、加粗、斜体、链接、图片。 */
function renderAnswer(text, options = {}) {
  let source = esc(String(text ?? '').replace(/\r\n?/g, '\n'))
  let partialChartCode = ''
  // 流式输出时图表 JSON 还没闭合：不再把半截代码整段丢掉，
  // 先把已经完整的数据点画出来；一个点都没有时显示“图表生成中”。
  const fenceCount = (source.match(/```/g) ?? []).length
  if (fenceCount % 2 === 1) {
    const lastFence = source.lastIndexOf('```')
    const opening = source.slice(lastFence).split('\n')[0].trim().slice(3).trim().toLowerCase()
    if (opening.startsWith('chart')) {
      const openingEnd = source.indexOf('\n', lastFence)
      partialChartCode = openingEnd >= 0 ? source.slice(openingEnd + 1) : ''
      source = `${source.slice(0, lastFence)}\n\u0000CHARTLOADING\u0000`
    }
  }
  const omitCodeBlocks = options.omitCodeBlocks instanceof Set ? options.omitCodeBlocks : null
  const codeBlocks = []
  const body = source.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_, language, code) => {
    const index = codeBlocks.length
    codeBlocks.push({
      code: code.replace(/\n$/, ''),
      language: String(language ?? '').trim().split(/\s+/)[0].toLowerCase(),
    })
    return `\u0000CODE${index}\u0000`
  })
  const lines = body.split('\n')
  const output = []

  for (let index = 0; index < lines.length; ) {
    const line = lines[index]
    if (!line.trim()) {
      index += 1
      continue
    }

    if (line.trim() === '\u0000CHARTLOADING\u0000') {
      const partialChart = partialChartCode ? renderChartBlock(partialChartCode, { partial: true }) : ''
      output.push(partialChart || '<div class="answer-chart is-loading">图表生成中…</div>')
      index += 1
      continue
    }

    const codeMatch = /^\u0000CODE(\d+)\u0000$/.exec(line.trim())
    if (codeMatch) {
      const block = codeBlocks[Number(codeMatch[1])] ?? { code: '', language: '' }
      const code = block.code ?? ''
      if (block.language === 'chart') {
        output.push(renderChartBlock(code))
        index += 1
        continue
      }
      if (omitCodeBlocks && omitCodeBlocks.has(normalizeAnswerCodeBlock(code, true))) {
        if (output.length) {
          const trimmed = trimFileContentCodeLeadIn(output[output.length - 1])
          if (trimmed) output[output.length - 1] = trimmed
          else output.pop()
        }
        index += 1
        continue
      }
      output.push(`<pre class="answer-code">${code}</pre>`)
      index += 1
      continue
    }

    const image = answerImageOnly(line)
    if (image) {
      const alt = image[1] || ''
      output.push(
        `<figure class="answer-figure"><img src="${image[2]}" alt="${alt}" loading="lazy">${
          alt ? `<figcaption>${alt}</figcaption>` : ''
        }</figure>`,
      )
      index += 1
      continue
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading) {
      const level = Math.min(6, heading[1].length)
      output.push(`<h${level}>${answerInline(heading[2].trim())}</h${level}>`)
      index += 1
      continue
    }

    if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      output.push('<hr>')
      index += 1
      continue
    }

    if (line.includes('|') && index + 1 < lines.length && isAnswerTableSeparator(lines[index + 1])) {
      const header = splitAnswerTableRow(line)
      const rows = []
      let cursor = index + 2
      while (cursor < lines.length && lines[cursor].includes('|') && lines[cursor].trim()) {
        rows.push(splitAnswerTableRow(lines[cursor]))
        cursor += 1
      }
      const headHtml = header.map((cell) => `<th>${answerInline(cell)}</th>`).join('')
      const bodyHtml = rows
        .map((row) => `<tr>${row.map((cell) => `<td>${answerInline(cell)}</td>`).join('')}</tr>`)
        .join('')
      output.push(
        `<div class="answer-table"><table><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`,
      )
      index = cursor
      continue
    }

    if (/^\s{0,3}>\s?/.test(line)) {
      const quotes = []
      let cursor = index
      while (cursor < lines.length && /^\s{0,3}>\s?/.test(lines[cursor])) {
        quotes.push(answerInline(lines[cursor].replace(/^\s{0,3}>\s?/, '')))
        cursor += 1
      }
      output.push(`<blockquote>${quotes.join('<br>')}</blockquote>`)
      index = cursor
      continue
    }

    const unordered = /^\s{0,3}[-*+]\s+(.+)$/.exec(line)
    const ordered = /^\s{0,3}\d+[.)]\s+(.+)$/.exec(line)
    if (unordered || ordered) {
      const tag = unordered ? 'ul' : 'ol'
      const pattern = unordered ? /^\s{0,3}[-*+]\s+(.+)$/ : /^\s{0,3}\d+[.)]\s+(.+)$/
      const items = []
      let cursor = index
      while (cursor < lines.length) {
        const match = pattern.exec(lines[cursor])
        if (!match) break
        items.push(`<li>${answerInline(match[1])}</li>`)
        cursor += 1
      }
      output.push(`<${tag}>${items.join('')}</${tag}>`)
      index = cursor
      continue
    }

    const paragraph = []
    let cursor = index
    while (cursor < lines.length && !isAnswerBlockStart(lines, cursor)) {
      paragraph.push(answerInline(lines[cursor]))
      cursor += 1
    }
    if (paragraph.length) output.push(`<p>${paragraph.join('<br>')}</p>`)
    index = cursor > index ? cursor : index + 1
  }

  return output.join('')
}

function fmtSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function fmtQuota(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  if (value >= 1024 * 1024 * 1024) {
    const gb = value / 1024 / 1024 / 1024
    return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`
  }
  if (value >= 1024 * 1024) {
    const mb = value / 1024 / 1024
    return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`
  }
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${value} B`
}

const CHAT_TOAST_MAX = 3
const CHAT_TOAST_ICON = {
  ok: '<path d="m5 12 4 4 10-10"/>',
  warn: '<path d="M12 7v6"/><path d="M12 17h.01"/>',
  bad: '<path d="M6 6l12 12"/><path d="m18 6-12 12"/>',
}

/**
 * 对话页唯一的瞬时提示出口：固定顶部居中，和后台的顶部提示保持同一套视觉。
 * 成功会自动消失；警告/错误保留更久并带关闭按钮，支持同时叠放最多 3 条。
 */
function banner(message, tone = 'ok') {
  const text = String(message ?? '').trim()
  if (!text) return
  const kind = tone === 'bad' ? 'bad' : tone === 'warn' ? 'warn' : 'ok'
  if (window.EABOverlay?.toast) {
    return window.EABOverlay.toast(text, {
      tone: kind === 'bad' ? 'error' : kind === 'warn' ? 'warn' : 'success',
    })
  }
  let host = document.querySelector('.top-toast-host')
  if (!host) {
    host = document.createElement('div')
    host.className = 'top-toast-host chat-toast-host'
    document.body.appendChild(host)
  }

  // 同一条提示重复触发时只刷新位置，不把同样的文案堆满屏幕。
  for (const item of host.querySelectorAll('.top-toast')) {
    if (item.dataset.message === text) {
      clearTimeout(item._chatToastTimer)
      item.remove()
    }
  }
  while (host.childElementCount >= CHAT_TOAST_MAX) {
    const oldest = host.firstElementChild
    if (!oldest) break
    clearTimeout(oldest._chatToastTimer)
    oldest.remove()
  }

  const el = document.createElement('div')
  el.className = `top-toast chat-toast is-${kind}`
  el.dataset.message = text
  el.setAttribute('role', kind === 'bad' ? 'alert' : 'status')
  el.setAttribute('aria-live', kind === 'bad' ? 'assertive' : 'polite')

  const icon = document.createElement('span')
  icon.className = 'top-toast-icon'
  icon.setAttribute('aria-hidden', 'true')
  icon.innerHTML = `<svg viewBox="0 0 24 24" focusable="false">${CHAT_TOAST_ICON[kind]}</svg>`

  const copy = document.createElement('span')
  copy.className = 'top-toast-copy'
  copy.textContent = text

  const close = document.createElement('button')
  close.className = 'top-toast-close'
  close.type = 'button'
  close.setAttribute('aria-label', '关闭提示')
  close.textContent = '×'

  el.append(icon, copy, close)
  host.appendChild(el)

  const dismiss = () => {
    if (!el.isConnected) return
    clearTimeout(el._chatToastTimer)
    el.classList.add('is-leaving')
    window.setTimeout(() => {
      el.remove()
      if (!host.childElementCount) host.remove()
    }, 180)
  }
  const duration = kind === 'bad' ? 6000 : kind === 'warn' ? 4800 : 3200
  el._chatToastTimer = window.setTimeout(dismiss, duration)
  close.addEventListener('click', dismiss)
  return { dismiss }
}

let loginRedirectStarted = false

function isAuthProbePath(path) {
  const raw = String(path || '')
  return raw.startsWith('/api/auth/') || raw.startsWith('/api/dev/personas')
}

/**
 * 员工会话缺失或过期：不再把 401 交给页面提示，直接回到登录页。
 * 保留 company，去掉可能失效的 as，避免重新进入预览身份。
 */
function redirectToLogin() {
  if (loginRedirectStarted) return
  loginRedirectStarted = true
  const params = new URLSearchParams()
  const company = new URLSearchParams(location.search).get('company')
  if (company) params.set('company', company)
  params.set('login', '1')
  location.replace(`/chat?${params.toString()}`)
}

/** 返回一个永不结束的 Promise：跳转已发起，调用方不应再显示错误或弹提示。 */
function waitForLoginRedirect() {
  return new Promise(() => {})
}

function isLoginSurface() {
  return new URLSearchParams(location.search).get('login') === '1'
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

async function api(path, options) {
  const response = await fetch(path, options)
  const payload = await response.json().catch(() => null)
  if (!response.ok || !payload || payload.ok === false) {
    const err = new Error((payload && (payload.error?.message || payload.message)) || `HTTP ${response.status}`)
    err.code = payload && (payload.error?.code || payload.code)
    err.details = payload && (payload.error?.details || payload.details)
    err.hint = payload && (payload.error?.hint || payload.hint)
    err.traceId = payload && (payload.error?.traceId || payload.traceId)
    err.status = response.status
    if (response.status === 401 && !isAuthProbePath(path)) {
      // 登录页本身不再通过 401 触发跳转：后台请求（如权限角标）失败只当错误处理，
      // 否则每次请求都会 location.replace 回同一个登录页，形成无限重载。
      if (isLoginSurface()) throw err
      redirectToLogin()
      return waitForLoginRedirect()
    }
    throw err
  }
  return payload.data
}

const state = {
  me: null,
  assistant: null,
  models: [],
  autoModelId: null,
  canChat: true,
  selected: '',
  /** 模型目录并发刷新：同一时刻只发一个请求 */
  modelRefreshPromise: null,
  /** 当前会话选中的思考档位；模型没有思考菜单时为空 */
  reasoningEffort: '',
  /** 会话切换序号：连续点击多个会话时只接受最后一次请求的结果 */
  openSeq: 0,
  /** 每个会话独立的发送队列、控制器和实时回答节点；null 键表示尚未落库的新对话 */
  runtimes: new Map(),
  /** 刷新/重新登录后从服务端取回仍在运行的回合，按 messageId 保存 */
  activeRunSnapshots: new Map(),
  /** queue=按顺序排队；interrupt=新消息打断当前回复 */
  chatSendMode: 'queue',
  /** 语音链路：模型是否可用 + 当前员工自己的语音配置。 */
  transcribeAvailable: false,
  speechAvailable: false,
  voiceSettings: {
    enabled: true,
    activeVoiceId: 'default',
    instructions: '',
    speechMode: 'stream',
    defaults: { enabled: true, activeVoiceId: 'default' },
    voices: [],
    speechAvailable: false,
  },
  /** 当前正在播放的语音，避免连续回答叠加播放。 */
  activeVoiceAudio: null,
  /** 停止播放时要触发的收尾回调（用于语音对话在播报结束后续听）。 */
  activeVoiceReset: null,
  /** 连续语音对话：入口在网页，转写和合成沿用现有 ASR/TTS 接口。 */
  voiceConversation: {
    active: false,
    phase: 'idle',
    sessionId: null,
    generation: 0,
    resumeTimer: 0,
    turnStartedAt: 0,
    speechStarted: false,
    speechMs: 0,
    silenceMs: 0,
    level: 0,
    threshold: 0.012,
    calibrating: true,
    calibrationUntil: 0,
    calibrationSamples: [],
    maxMs: 30_000,
    noSpeechTimeout: 10_000,
    stopReason: '',
  },
  /**
   * 语音唤醒：只在用户显式开启后占用麦克风。页面打开期间持续采集，
   * 识别到助手名字才进入语音对话；关掉页面/退出对话/播报时立即停。
   */
  wake: {
    enabled: false,
    active: false,
    phase: 'idle',
    generation: 0,
    lastError: '',
  },
  attachments: [],
  personas: [],
  sessionId: null,
  sessions: [],
  historyBefore: null,
  historyHasMore: false,
  historyLoading: false,
  historyMessageIds: new Set(),
  /** 正在实时更新的 AI 回合，按 assistant messageId 索引；节点可脱离当前会话保留 */
  liveTurns: new Map(),
  /** 本页 POST 流正在直接渲染的 messageId；EventSource 不重复叠加同一段增量 */
  localLiveMessageIds: new Set(),
  /** 当前等待用户在底部输入区选择方向的澄清请求 */
  pendingClarify: null,
  /** 非当前会话的钉钉实时输出提示（不强行切换会话） */
  remoteLive: null,
  /** 多页引导式澄清的当前流程：复用同一条 AI 消息继续推进，不新增用户气泡 */
  clarifyFlow: null,
  /** 右键“编辑后重发”暂存的消息；下一次发送会先回退并替换它 */
  messageEdit: null,
  liveEventSource: null,
  /** EventSource 至少成功连过一次；下一次 open 说明是重连，需要和服务端对账。 */
  liveEventSourceOpenedOnce: false,
  sessionRefreshTimer: 0,
  files: [],
  /** 当前所在的云空间虚拟目录（由文件 relPath 归并出来，空串为根目录）。 */
  workspacePath: '',
  /** 云空间列表并发刷新与 300ms 合并；避免 SSE 连续事件打出多组请求。 */
  workspaceLoadPromise: null,
  workspaceRefreshTimer: 0,
  workspaceRefreshPending: false,
  workspaceVisibilityBound: false,
  /** 云空间上传队列：每个文件有独立进度、状态和错误，刷新页面后清空。 */
  wsUploads: [],
  wsUploadHideTimer: 0,
  spaceKind: 'cloud',
  spaceLabel: '云空间',
  plugins: [],
  pluginData: null,
  pluginSelected: null,
  pluginTab: 'overview',
  pluginPageKey: null,
  workspaceKind: 'plugins',
  skills: [],
  skillData: null,
  skillSelected: null,
  mode: 'chat',
  /** 当前实际停留的界面：chat / workspace / settings，刷新后恢复 */
  view: 'chat',
  filePreview: null,
  /** 当前对话回合的子 Agent 团队；key 为 childId，同一子 Agent 复用同一窗口 */
  agentRuns: new Map(),
  /** 父 Agent 名称，用于团队标题 */
  agentParentName: '',
  /** 团队容量：{ active, limit, waitingTtlMs, retentionMs }，由 /api/chat/agents 返回 */
  agentCapacity: null,
  /** 当前回合的根 run */
  agentParentRunId: '',
  /** 当前父 Agent 消息气泡；子 Agent 进度事件到达后仍要能更新这条消息里的进度卡 */
  parentTeamTurn: null,
  /** 团队进度消息已被合并进父气泡，先暂存给紧接着渲染的父消息 */
  pendingTeamProgress: null,
  /** 团队列表里被选中、详情窗口正在展示的子 Agent */
  agentSelectedId: '',
  /** 用户最近一次手动点选团队行的时间；短时间内不让人工选择被新事件抢走 */
  agentUserSelectedAt: 0,
  /** 团队详情里用户手动展开过的 CoT 面板；key = childId:kind:块序号 */
  agentPanelOpen: new Map(),
  /** 每个子 Agent 窗口的滚动位置；和主对话一样：贴底时跟随新内容，上滑后停在历史 */
  agentScroll: new Map(),
  /** 右侧工作台当前面板：team / file */
  workbenchTab: 'team',
  /** 团队与文件是否并排显示 */
  workbenchSplit: false,
  /** 右侧工作台是否折叠为窄条；只收起外观，不丢 tab / 并排状态 */
  workbenchCollapsed: false,
  /** 权限审批面板是否被用户主动打开；它不是常驻栏，避免每次对话都占右栏 */
  permOpen: false,
  permView: 'apply',
  /** 申请权限时勾选的 scope 集合；只保留当前接口返回的可申请权限。 */
  permScopeCodes: [],
  /** 申请权限时选择的当前角色；只作为审批策略上下文，不作为授权落点。 */
  permRoleCode: '',
  permConfig: null,
  permRequests: { mine: [], todo: [] },
  permSelected: '',
  permError: '',
  permSuccess: '',
  /** 顶部吊顶卡片当前跟踪的文件操作；不随 AI 气泡销毁，整个会话内保留。 */
  fileActivity: null,
  fileDockClosed: false,
  /** 本轮对话结束后，吊顶卡不再常驻，避免和最终回答抢注意力。 */
  fileDockSettled: false,
  /** 右侧文件预览打开时，顶部吊顶卡让位给预览；关闭预览后恢复。 */
  fileDockPreviewSuppressed: false,
  previewSelection: null,
}

const HISTORY_PAGE_SIZE = 10
const HISTORY_TOP_THRESHOLD = 120
const SCROLL_STICK_THRESHOLD = 8
const SIDEBAR_COLLAPSED_KEY = 'eab.chat.sidebarCollapsed'
const FILE_SPLIT_RATIO_KEY = 'eab.chat.fileSplitRatio'
/** 右栏（Agent 团队 / 文件）与对话之间的宽度比例，独立于文件预览记住 */
const TEAM_SPLIT_RATIO_KEY = 'eab.chat.teamSplitRatio'
const WORKBENCH_COLLAPSED_KEY = 'eab.chat.workbenchCollapsed'
const TEAM_LIST_WIDTH_KEY = 'eab.chat.teamListWidth'
const SIDE_SECTION_RATIO_KEY = 'eab.chat.sideSectionRatio'
/** 用户主动上滚后，流式输出不再抢滚动；滚回触底附近才恢复跟随。 */
let threadScrollPinned = true
let threadScrollLastTop = 0
let threadHasNewBelow = false
/** 引导问题等待用户选择的最长时间；超时自动采用第一个方向。 */
const CLARIFY_AUTO_SELECT_MS = 180000
const DEFAULT_INPUT_PLACEHOLDER = '输入消息，Enter 发送，Shift + Enter 换行；/model 切换模型'
const CHAT_LOCATION_STORAGE_KEY = 'eab.chat.location.v1'

/**
 * 发送状态归属到会话，而不是页面全局：
 * A 会话回复时切到 B，B 仍可独立发送、独立选模型，A 的节点继续在后台更新。
 */
function runtimeKey(sessionId) {
  return sessionId || '__new__'
}

function runtimeFor(sessionId) {
  const key = runtimeKey(sessionId)
  let runtime = state.runtimes.get(key)
  if (!runtime) {
    runtime = {
      key,
      sessionId: sessionId || null,
      sending: false,
      controller: null,
      queue: [],
      turn: null,
      messageId: null,
      runId: null,
      title: '',
    }
    state.runtimes.set(key, runtime)
  }
  return runtime
}

function currentRuntime() {
  return runtimeFor(state.sessionId)
}

function migrateRuntime(runtime, sessionId) {
  if (!runtime || !sessionId) return runtime
  const next = runtimeFor(sessionId)
  if (next !== runtime) {
    const oldKey = runtime.key
    runtime.sessionId = sessionId
    if (next.queue.length > 0) runtime.queue.push(...next.queue)
    if (next.turn && !runtime.turn) runtime.turn = next.turn
    state.runtimes.delete(next.key)
    state.runtimes.delete(oldKey)
    runtime.key = runtimeKey(sessionId)
    state.runtimes.set(runtime.key, runtime)
  }
  return runtime
}

function markSessionReadLocally(sessionId) {
  const session = state.sessions.find((item) => item.id === sessionId)
  if (session) session.unread = false
}

function notifySessionRead(sessionId) {
  if (!sessionId) return
  markSessionReadLocally(sessionId)
  renderSessions()
  void api(`/api/chat/sessions/${encodeURIComponent(sessionId)}/read${qs()}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }).catch(() => {
    /* 已读标记失败不阻塞对话；下次打开会话会再次标记 */
  })
}

function chatLocationStorageKey() {
  const personId = state.me?.person?.id
  return personId ? `${CHAT_LOCATION_STORAGE_KEY}.${personId}` : ''
}

function readChatLocation() {
  const key = chatLocationStorageKey()
  if (!key) return null
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return {
      sessionId: typeof parsed?.sessionId === 'string' ? parsed.sessionId : null,
      view: ['chat', 'workspace', 'settings'].includes(parsed?.view) ? parsed.view : 'chat',
      mode: parsed?.mode === 'workspace' ? 'workspace' : 'chat',
    }
  } catch {
    return null
  }
}

function persistChatLocation() {
  const key = chatLocationStorageKey()
  if (!key) return
  try {
    localStorage.setItem(
      key,
      JSON.stringify({
        sessionId: state.sessionId || '',
        view: state.view || 'chat',
        mode: state.mode === 'workspace' ? 'workspace' : 'chat',
      }),
    )
  } catch {
    /* 浏览器禁用本地存储时不影响当前页面 */
  }
}

function restoreChatLocation(location) {
  if (!location || location.view === 'chat') return
  const workspaceBehindSettings = location.view === 'settings' && location.mode === 'workspace'
  setChatMode(location.view === 'workspace' || workspaceBehindSettings ? 'workspace' : 'chat')
  if (location.view === 'settings') showSettings()
}

/* ---------------- 登录态 ---------------- */

async function loadPersonas() {
  try {
    const data = await api('/api/dev/personas')
    state.personas = data.personas
    return data.personas
  } catch {
    state.personas = []
    return []
  }
}

function markLoginBoot(surface) {
  try {
    sessionStorage.setItem('eab.boot.next', surface)
  } catch {
    /* 隐私模式禁用 sessionStorage 时只影响启动动画，不影响登录 */
  }
}

function endBoot(text) {
  try {
    window.EABBoot?.ready(text)
  } catch {
    /* 启动层不可用时不能阻断工作台 */
  }
}

async function refreshConsoleEntry() {
  const entry = $('#console-entry')
  if (!entry) return
  try {
    const data = await api('/api/me/console-entry')
    if (!data?.visible) {
      entry.hidden = true
      return
    }
    entry.hidden = false
    const company = new URLSearchParams(location.search).get('company')
    const targetOf = (href) => {
      const target = new URL(href || '/admin', location.href)
      if (company) target.searchParams.set('company', company)
      target.searchParams.set('from', 'chat')
      return target.toString()
    }
    entry.onclick = async () => {
      if (entry.disabled) return
      entry.disabled = true
      const label = entry.textContent
      entry.textContent = '进入中…'
      try {
        const session = await api('/api/me/console-entry/session', {
          method: 'POST',
          headers: { 'x-eab-console-entry': '1' },
        })
        location.href = targetOf(session?.href || data.href)
      } catch (err) {
        entry.disabled = false
        entry.textContent = label
        banner(err?.message || '进入管理后台失败，请稍后重试', 'bad')
        if (err?.status === 403) refreshConsoleEntry()
      }
    }
  } catch {
    entry.hidden = true
  }
}

function showLogin() {
  $('#login-gate').hidden = false
  // 登录页是独占页面：把背后的工作台整体收掉，避免空状态或历史会话从登录卡上方/下方透出来。
  const side = $('#chat-side')
  const stage = $('#chat-stage')
  if (side) side.hidden = true
  if (stage) stage.hidden = true
  for (const id of ['#mode-switch', '#chat-title', '#login-btn', '#console-entry', '#side-user', '#side-actions', '#side-sessions', '#side-files', '#attach-strip']) {
    const node = $(id)
    if (node) node.hidden = true
  }
  $('#composer-box').style.display = 'none'
}

async function renderLogin() {
  // 登录页绝不列成员、绝不提供“直接选人登录”。身份只能由本人扫码或输入自己的账号密码取得。
  $('#login-sub').textContent = '用工号、邮箱或手机号登录。账号只能由本人登录，密码校验在服务端完成。'
  $('#login-sub').hidden = true
}

async function doLogin(event) {
  event.preventDefault()
  const account = $('#login-account').value.trim()
  const password = $('#login-password').value
  const errorBox = $('#login-error')
  const button = $('#login-submit')
  errorBox.hidden = true
  button.disabled = true
  button.textContent = '登录中…'
  try {
    await api('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account, password }),
    })
    markLoginBoot('chat')
    location.href = '/chat'
  } catch (err) {
    errorBox.textContent = `${err.message}${err.code ? `（${err.code}）` : ''}`
    errorBox.hidden = false
    button.disabled = false
    button.textContent = '登录'
  }
}

/* ---------------- 会话历史 ---------------- */

function resetThread() {
  clearClarifyDock({ abort: true })
  clearFileActivity()
  state.parentTeamTurn = null
  state.pendingTeamProgress = null
  // 空态没有“最新消息”可回；同时清掉上一会话遗留的“下方有新内容”状态。
  threadScrollPinned = true
  threadHasNewBelow = false
  const thread = $('#thread')
  for (const child of [...thread.children]) {
    if (child.id !== 'chat-empty') child.remove()
  }
  $('#chat-empty').hidden = false
  setEmptyVisible(true)
  updateScrollBottomButton()
}

function sessionUpdatedAt(session) {
  const raw = session && (session.updatedAt || session.lastMessageAt || session.createdAt)
  const ts = raw ? Date.parse(raw) : NaN
  return Number.isFinite(ts) ? ts : 0
}

/** 会话列表按最近活动倒序；接口已排序，这里再兜底保证本地即时更新也不会乱序。 */
function sortSessionsByRecent(sessions) {
  return [...(sessions || [])].sort((a, b) => sessionUpdatedAt(b) - sessionUpdatedAt(a))
}

function markSessionActive(sessionId) {
  const session = state.sessions.find((item) => item.id === sessionId)
  if (!session) return
  session.updatedAt = new Date().toISOString()
  state.sessions = sortSessionsByRecent(state.sessions)
}

/**
 * 会话是否仍在生成。当前页看 runtime，其它页看服务端运行快照；
 * 两者都覆盖后才能让左侧列表在切页/后台回复时保持同步。
 */
function sessionIsRunning(sessionId) {
  const runtime = state.runtimes.get(runtimeKey(sessionId))
  if (runtime?.sending) return true
  for (const snapshot of state.activeRunSnapshots.values()) {
    if (snapshot.sessionId === sessionId && snapshot.status === 'running') return true
  }
  return false
}

function renderSessions() {
  const box = $('#session-list')
  const sessions = sortSessionsByRecent(state.sessions)
  $('#side-sessions').hidden = sessions.length === 0 && !state.me
  if (sessions.length === 0) {
    box.innerHTML = '<div class="side-session-empty">还没有对话</div>'
    syncSideSectionSplit()
    return
  }
  box.innerHTML = sessions
    .map((session) => {
      // 左侧已经有「钉钉」来源徽标，标题里不再重复前缀。
      const displayTitle =
        session.source === 'dingtalk' ? String(session.title || '').replace(/^钉钉\s*·\s*/, '') : session.title
      const running = sessionIsRunning(session.id)
      return `<div class="side-session ${session.id === state.sessionId ? 'active' : ''}" data-session="${esc(session.id)}" draggable="true">
        <button class="side-session-main" type="button" data-open="${esc(session.id)}" title="${esc(session.title)}">${
          running
            ? '<span class="side-session-running" role="status" aria-label="正在回复" title="正在回复"></span>'
            : session.unread && session.id !== state.sessionId
              ? '<span class="side-session-unread" aria-label="有新的回复" title="有新的回复"></span>'
              : ''
        }${
          session.source === 'dingtalk' ? '<span class="side-session-source">钉钉</span>' : ''
        }${esc(displayTitle)}</button>
        <button class="side-session-more" type="button" data-more="${esc(session.id)}" title="会话操作" aria-label="会话操作">⋯</button>
      </div>`
    })
    .join('')
  for (const button of box.querySelectorAll('[data-open]')) {
    button.addEventListener('click', () => openSession(button.dataset.open))
  }
  for (const button of box.querySelectorAll('[data-more]')) {
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      showSessionMenu(button.dataset.more, button.getBoundingClientRect())
    })
  }
  for (const row of box.querySelectorAll('.side-session')) {
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      showSessionMenu(row.dataset.session, row.getBoundingClientRect())
    })
    row.addEventListener('dragstart', (event) => {
      const session = state.sessions.find((item) => item.id === row.dataset.session)
      if (!session) return
      const displayTitle =
        session.source === 'dingtalk' ? String(session.title || '').replace(/^钉钉\s*·\s*/, '') : session.title
      startConversationDrag(
        event,
        {
          conversationId: session.id,
          title: String(displayTitle || session.title || '未命名对话').trim(),
          current: session.id === state.sessionId,
        },
        row,
      )
    })
    row.addEventListener('dragend', () => row.classList.remove('is-dragging'))
  }
  syncSideSectionSplit()
}

async function loadSessions() {
  try {
    const data = await api(`/api/chat/sessions${qs()}`)
    state.sessions = sortSessionsByRecent(data.sessions || [])
  } catch {
    state.sessions = []
  }
  renderSessions()
}

/** 同一 messageId 的后续结果：更新原气泡，而不是再追加一条。 */
function updateKnownMessage(message, sessionId) {
  if (!message || !message.id) return false
  const id = String(message.id)
  if (isStandaloneTeamProgressMessage(message)) {
    rememberPendingTeamProgress(message)
    return true
  }
  const thread = $('#thread')
  if (!thread) return false
  const node = Array.from(thread.querySelectorAll('.msg')).find((item) => item.dataset.messageId === id)
  if (!node) return false
  const role = message.role === 'user' ? 'me' : 'ai'
  node.chatMessage = {
    id,
    role: message.role,
    text: String(message.text || ''),
    createdAt: message.createdAt || new Date().toISOString(),
  }
  setMessageTime(node, message.createdAt)
  const bubble = node.querySelector('.bubble')
  if (!bubble) return false
  if (
    role !== 'me' &&
    message.meta?.clarify &&
    node.querySelector('.clarify-slot .clarify-card')
  ) {
    // 本地 POST 收尾时已经把可交互面板渲染进实时气泡；随后 SSE 的最终消息
    // 不能再用 historyAiBubble 覆盖整个气泡，否则面板会被冲掉。
    refreshMessageActions(node)
    syncMessageActionAvailability()
    queueScrollBottomButtonUpdate()
    return true
  }
  if (role === 'me') {
    bubble.textContent = String(message.text || '')
  } else {
    bubble.innerHTML = historyAiBubble(
      String(message.text || ''),
      message.modelName || '',
      message.meta || {},
      {
        createdAt: message.createdAt,
        messageId: id,
        channel: message.meta?.channel,
      },
    )
    bindToolToggles(node)
  }
  refreshMessageActions(node)
  syncMessageActionAvailability()
  queueScrollBottomButtonUpdate()
  return true
}

/** 钉钉侧刚写入的消息：同一会话就追加到当前对话，其它会话只更新左侧列表。 */
function appendLiveMessage(message, sessionId) {
  if (!message || (message.role !== 'user' && message.role !== 'assistant')) return
  const id = String(message.id || '')
  if (!id) return
  // 独立的进度卡消息不再长成气泡；它的进度直接写进当前父 Agent 消息。
  if (isStandaloneTeamProgressMessage(message)) {
    rememberPendingTeamProgress(message)
    if (state.parentTeamTurn && typeof state.parentTeamTurn.teamProgress === 'function') {
      state.parentTeamTurn.teamProgress(state.pendingTeamProgress)
    }
    return
  }
  // 引导续跑复用原 assistant 消息 ID：已渲染过就就地替换正文/思考/工具，不再长新气泡。
  if (updateKnownMessage(message, sessionId)) return
  if (state.localLiveMessageIds.has(id)) return
  // 当前页面正在接收本地 SSE 的这一轮：最终消息由本地 turn 收尾，避免再叠加一条。
  if (message.role === 'assistant' && sessionId && sessionId === state.sessionId) {
    const runtime = runtimeFor(sessionId)
    if (runtime.sending) return
  }
  state.historyMessageIds.add(id)
  const messageClarify =
    message.role === 'assistant' && message.meta?.clarify && typeof message.meta.clarify === 'object'
      ? message.meta.clarify
      : null
  // 最新一条带 clarify 的 assistant 消息就是当前待答问题：
  // 不能按“中间澄清步骤”隐藏，否则网页只显示正文/空气泡，看不到可交互面板。
  if (messageClarify) {
    showClarifyDock(messageClarify, { flowMeta: message.meta, auto: true })
    if (sessionId && sessionId === state.sessionId) scheduleSessionRefresh()
    return
  }
  // 多页引导的中间选择/追问只用于续跑，不进入聊天消息流。
  if (isHiddenClarifyStep(message)) return

  const thread = $('#thread')
  const follow = Boolean(thread && threadScrollPinned)
  appendMessage(
    message.role === 'user' ? 'me' : 'ai',
    message.text,
    message.role === 'assistant' && message.modelName ? message.modelName : undefined,
    message.meta && message.meta.attachments,
    message.role === 'assistant' ? message.meta : undefined,
    { scroll: false, messageId: id, channel: message.meta?.channel, pendingClarify: false, createdAt: message.createdAt },
  )
  if (message.role === 'user') clearClarifyDock()
  else if (messageClarify) showClarifyDock(messageClarify, { flowMeta: message.meta, auto: true })
  if (follow) scrollThreadToBottomInstant()
  else markThreadNewContent()
  if (sessionId && sessionId === state.sessionId) scheduleSessionRefresh()
}

function scheduleSessionRefresh() {
  if (state.sessionRefreshTimer) return
  state.sessionRefreshTimer = window.setTimeout(async () => {
    state.sessionRefreshTimer = 0
    await loadSessions()
  }, 600)
}

/** 服务端仍在跑的回合快照；页面刷新/重新登录后据此恢复半截输出。 */
function runSnapshotOf(payload) {
  const messageId = String(payload?.messageId || '')
  if (!messageId) return null
  let snapshot = state.activeRunSnapshots.get(messageId)
  if (!snapshot) {
    snapshot = {
      runId: payload.runId || '',
      sessionId: String(payload.sessionId || ''),
      messageId,
      modelId: payload.modelId || '',
      modelName: payload.modelName || '',
      autoSelected: Boolean(payload.autoSelected),
      status: 'running',
      reasoning: '',
      text: '',
      toolCalls: [],
    }
    state.activeRunSnapshots.set(messageId, snapshot)
  }
  return snapshot
}

/** 为后台回合建立（或取回）可脱离当前会话存在的 AI 节点。 */
function liveTurnForSnapshot(snapshot, options = {}) {
  if (!snapshot?.messageId) return null
  let entry = state.liveTurns.get(snapshot.messageId)
  if (!entry && state.historyMessageIds.has(snapshot.messageId)) {
    // 该消息已经落库并渲染，迟到的运行快照不能再长出一个空节点。
    return null
  }
  if (!entry) {
    // 同一个会话可能已经由 POST 流创建了气泡；优先复用 runtime.turn，
    // 避免 EventSource 的增量画到一个隐藏节点上，页面一直停在“正在思考…”。
    const runtime = state.runtimes.get(runtimeKey(snapshot.sessionId))
    const reuseSameRuntimeTurn =
      runtime?.turn &&
      runtime.sending &&
      snapshot.sessionId === runtime.sessionId &&
      String(runtime.messageId || '') === snapshot.messageId
    const reuseTurn = reuseSameRuntimeTurn
      ? runtime.turn
      : runtime?.messageId === snapshot.messageId && runtime.turn
        ? runtime.turn
        : null
    entry = {
      turn: reuseTurn || createAiTurn({ append: false }),
      sessionId: snapshot.sessionId,
      messageId: snapshot.messageId,
      hydrated: Boolean(reuseTurn),
    }
    state.liveTurns.set(snapshot.messageId, entry)
    if (entry.turn.node) {
      entry.turn.node.dataset.messageId = snapshot.messageId
      entry.turn.node.chatMessage = {
        id: snapshot.messageId,
        role: 'assistant',
        text: String(snapshot.text || ''),
        createdAt: new Date().toISOString(),
      }
      refreshMessageActions(entry.turn.node)
    }
  }
  let hydratedNow = false
  if (!entry.hydrated && (snapshot.reasoning || snapshot.text || snapshot.toolCalls?.length)) {
    entry.hydrated = true
    entry.turn.hydrate(snapshot)
    hydratedNow = true
  }
  /**
   * 事件是先写进 run 快照再广播的，所以首次创建节点时 hydrate 已经包含
   * 当前这条增量；调用方不能再重复应用一次，否则正文/工具会多一份。
   */
  entry.skipPayload = Boolean(options.fromEvent && hydratedNow)
  if (snapshot.sessionId === state.sessionId) entry.turn.appendToThread()
  return entry
}

/** 切换回某个会话时，把仍在输出/排队的节点重新挂回消息流。 */
function attachLiveTurnForSession(sessionId) {
  for (const snapshot of state.activeRunSnapshots.values()) {
    if (snapshot.sessionId !== sessionId || snapshot.status !== 'running') continue
    const entry = liveTurnForSnapshot(snapshot)
    if (entry) entry.turn.appendToThread()
  }
  for (const entry of state.liveTurns.values()) {
    if (entry.sessionId !== sessionId) continue
    entry.turn.appendToThread()
  }
  const runtime = state.runtimes.get(runtimeKey(sessionId))
  if (runtime?.turn) runtime.turn.appendToThread()
}

async function fetchActiveRuns() {
  try {
    const data = await api(`/api/chat/runs/active${qs()}`)
    return Array.isArray(data.runs) ? data.runs : []
  } catch {
    // 恢复失败不阻塞页面；历史消息仍然可用
    return null
  }
}

async function loadActiveRuns() {
  const runs = await fetchActiveRuns()
  if (!runs) return
  for (const run of runs) {
    if (!run?.messageId) continue
    state.activeRunSnapshots.set(run.messageId, run)
  }
}

/**
 * EventSource 重连后和服务端对账：服务端内存里的运行态已经随重启清空，
 * 本地还标着 running 的气泡必须收口成“已中断”，否则页面会一直显示正在生成。
 * 先查一次会话历史：如果这一轮其实已经在断线期间落库，就只清理本地运行态，
 * 不误判成中断；查不到才提示重新发送。
 */
async function recentAssistantMessages(sessionId) {
  try {
    const data = await api(qsAppend(`/api/chat/sessions/${encodeURIComponent(sessionId)}/messages?limit=20`))
    return new Map(
      (data.messages || [])
        .filter((message) => message?.role === 'assistant' && String(message.id || '').trim())
        .map((message) => [String(message.id), message]),
    )
  } catch {
    return new Map()
  }
}

async function reconcileActiveRunsAfterReconnect() {
  const previous = new Map(state.activeRunSnapshots)
  const runs = await fetchActiveRuns()
  if (!runs) return
  const activeIds = new Set()
  for (const run of runs) {
    if (!run?.messageId) continue
    activeIds.add(String(run.messageId))
    state.activeRunSnapshots.set(run.messageId, run)
  }
  const assistantsBySession = new Map()
  for (const [messageId, snapshot] of previous) {
    if (activeIds.has(messageId)) continue
    if (snapshot?.status !== 'running') {
      state.activeRunSnapshots.delete(messageId)
      continue
    }
    state.activeRunSnapshots.delete(messageId)
    const entry = state.liveTurns.get(messageId)
    if (!entry) continue
    state.liveTurns.delete(messageId)
    const sessionId = String(snapshot.sessionId || entry.sessionId || '')
    let assistants = assistantsBySession.get(sessionId)
    if (!assistants && sessionId) {
      assistants = await recentAssistantMessages(sessionId)
      assistantsBySession.set(sessionId, assistants)
    }
    const persisted = assistants?.get(messageId)
    if (persisted) {
      // 断线期间已经落库：用落库正文收尾并保留已渲染的工具/思考记录，不误判成中断。
      state.historyMessageIds.add(messageId)
      entry.turn.node.chatMessage = {
        id: messageId,
        role: 'assistant',
        text: String(persisted.text || ''),
        createdAt: persisted.createdAt || new Date().toISOString(),
      }
      entry.turn.finish({
        text: persisted.text || '',
        modelId: persisted.modelId || '',
        modelName: persisted.modelName || '',
        autoSelected: persisted.meta?.autoSelected === true,
        citations: persisted.meta?.citations,
        tokens: persisted.meta?.tokens,
        timing: persisted.meta?.timing,
        createdAt: persisted.createdAt,
        clarify: null,
      })
      refreshMessageActions(entry.turn.node)
      continue
    }
    entry.turn.fail('服务已重启，这一轮回复已中断，请重新发送。', '连接已恢复')
  }
}

/**
 * 打开工作台后订阅服务端消息事件。
 * 钉钉私聊和网页对话共用 chat_messages；钉钉侧落库后由服务端广播到这里，
 * 当前会话直接追加，新会话则刷新左侧列表，不需要用户再手动刷新页面。
 */
/**
 * 非当前会话的实时输出：不强行切走用户正在看的对话，只在输入框上方
 * 显示一条可点击的“正在生成”提示，避免钉钉侧流式内容完全不可见。
 */
function renderRemoteLive() {
  const button = $('#remote-live')
  const label = $('#remote-live-text')
  if (!button || !label) return
  const live = state.remoteLive
  if (!live?.sessionId) {
    button.hidden = true
    label.textContent = ''
    return
  }
  const session = state.sessions.find((item) => item.id === live.sessionId)
  const title = session ? String(session.title || '').replace(/^钉钉\s*·\s*/, '') : '钉钉会话'
  label.textContent = `${title} · ${live.preview || '正在生成…'}`
  button.title = `打开「${title}」查看实时回复`
  button.hidden = false
}

let remoteLivePaint = 0
function updateRemoteLive(payload, snapshot) {
  if (!payload?.sessionId || payload.sessionId === state.sessionId) return
  const text = String(snapshot?.text || snapshot?.reasoning || '').replace(/\s+/g, ' ').trim()
  const preview = remoteLivePreview(text, 80) || '正在生成…'
  state.remoteLive = {
    sessionId: payload.sessionId,
    preview,
  }
  if (remoteLivePaint) return
  remoteLivePaint = window.setTimeout(() => {
    remoteLivePaint = 0
    renderRemoteLive()
  }, 120)
}

function clearRemoteLive(sessionId) {
  if (sessionId && state.remoteLive?.sessionId !== sessionId) return
  state.remoteLive = null
  renderRemoteLive()
}

function setupChatEvents() {
  if (state.liveEventSource || typeof EventSource === 'undefined') return
  const source = new EventSource(`/api/chat/events${qs()}`)
  state.liveEventSource = source
  source.onopen = () => {
    if (!state.liveEventSourceOpenedOnce) {
      state.liveEventSourceOpenedOnce = true
      return
    }
    void reconcileActiveRunsAfterReconnect()
  }
  const remoteLive = $('#remote-live')
  if (remoteLive) {
    remoteLive.addEventListener('click', () => {
      const sessionId = state.remoteLive?.sessionId
      if (!sessionId) return
      clearRemoteLive()
      void openSession(sessionId)
    })
  }

  source.addEventListener('chat', (event) => {
    let payload = null
    try {
      payload = JSON.parse(event.data)
    } catch {
      return
    }
    if (!payload?.sessionId) return

    // 后台子 Agent 的进度：父回合已经结束，团队面板仍按同一套事件实时更新。
    if (payload.type === 'subagent') {
      if (payload.sessionId !== state.sessionId) return
      updateAgentEvent(payload.data)
      return
    }

    // 模型正在生成：先把增量记到该消息的快照，再决定是否渲染。
    if (payload.type === 'delta') {
      if (payload.sessionId === state.sessionId) {
        const runtime = runtimeFor(payload.sessionId)
        // 只跳过“同一个正在 POST 渲染的 messageId”的重复增量；
        // 后台汇总轮会带新的 messageId，不能被上一轮仍为 sending 的运行时吞掉。
        if (runtime.sending && runtime.turn && String(runtime.messageId || '') === String(payload.messageId || '')) return
      }
      if (payload.messageId && state.localLiveMessageIds.has(String(payload.messageId))) return
      const wasKnown = state.activeRunSnapshots.has(String(payload.messageId || ''))
      const snapshot = runSnapshotOf(payload)
      if (!snapshot || !payload.text) return
      if (!wasKnown && payload.sessionId !== state.sessionId) renderSessions()
      if (payload.kind === 'reasoning') snapshot.reasoning += String(payload.text)
      else snapshot.text += String(payload.text)
      if (payload.sessionId !== state.sessionId) {
        updateRemoteLive(payload, snapshot)
        return
      }
      const entry = liveTurnForSnapshot(snapshot, { fromEvent: true })
      if (!entry) return
      if (entry.skipPayload) {
        entry.skipPayload = false
        return
      }
      if (payload.kind === 'reasoning') entry.turn.reasoning(payload.text)
      else entry.turn.content(payload.text)
      return
    }

    // 工具开始/结束：同样先补快照，当前会话才实时画卡片。
    if (payload.type === 'tool') {
      if (payload.sessionId === state.sessionId) {
        const runtime = runtimeFor(payload.sessionId)
        if (runtime.sending && runtime.turn && String(runtime.messageId || '') === String(payload.messageId || '')) return
      }
      if (payload.messageId && state.localLiveMessageIds.has(String(payload.messageId))) return
      const wasKnown = state.activeRunSnapshots.has(String(payload.messageId || ''))
      const snapshot = runSnapshotOf(payload)
      if (!snapshot || !payload.tool) return
      if (!wasKnown && payload.sessionId !== state.sessionId) renderSessions()
      const tool = payload.tool
      if (tool.type === 'tool') {
        snapshot.toolCalls.push({
          id: tool.id,
          name: tool.name,
          toolId: tool.toolId,
          args: tool.args,
          status: 'running',
          summary: '',
          durationMs: 0,
        })
      } else {
        const trace = snapshot.toolCalls.find((item) => item.id === tool.id)
        if (trace) {
          trace.status = tool.status
          trace.summary = tool.summary
          trace.durationMs = tool.durationMs
        }
      }
      if (payload.sessionId !== state.sessionId) return
      const entry = liveTurnForSnapshot(snapshot, { fromEvent: true })
      if (!entry) return
      if (entry.skipPayload) {
        entry.skipPayload = false
        return
      }
      if (tool.type === 'tool') entry.turn.tool(tool)
      else entry.turn.toolResult(tool)
      return
    }

    if (payload.type !== 'message' || !payload.message) return
    if (payload.message.role === 'assistant') clearRemoteLive(payload.sessionId)
    if (payload.message.id) state.activeRunSnapshots.delete(String(payload.message.id))
    if (payload.sessionId === state.sessionId) {
      const id = String(payload.message.id || '')
      const liveTurn = id ? state.liveTurns.get(id) : null
      if (liveTurn) {
        state.liveTurns.delete(id)
        state.localLiveMessageIds.delete(id)
        state.activeRunSnapshots.delete(id)
        state.historyMessageIds.add(id)
        if (liveTurn.turn.node) {
          liveTurn.turn.node.dataset.messageId = id
          liveTurn.turn.node.chatMessage = {
            id,
            role: 'assistant',
            text: String(payload.message.text || ''),
            createdAt: payload.message.createdAt || new Date().toISOString(),
          }
          setMessageTime(liveTurn.turn.node, payload.message.createdAt)
          refreshMessageActions(liveTurn.turn.node)
        }
        const meta = payload.message.meta || {}
        // EventSource 的最终消息也携带完整 reasoning / toolCalls；不能只传正文，
        // 否则实时气泡收尾后会丢掉“已深度思考”和工具调用记录（刷新后才恢复）。
        liveTurn.turn.finish({
          text: payload.message.text,
          modelId: payload.message.modelId,
          modelName: payload.message.modelName,
          autoSelected: meta.autoSelected === true,
          fallbackFromModelId: meta.fallbackFromModelId || null,
          citations: meta.citations,
          channel: meta.channel,
          reasoning: meta.reasoning || '',
          toolCalls: Array.isArray(meta.toolCalls) ? meta.toolCalls : [],
          teamProgress: meta.teamProgress,
          clarify: meta.clarify,
          tokens: meta.tokens,
          timing: meta.timing,
          createdAt: payload.message.createdAt,
        })
        syncMessageActionAvailability()
        if (payload.message.role === 'assistant') notifySessionRead(payload.sessionId)
        renderSessions()
        scheduleSessionRefresh()
        return
      }
      appendLiveMessage(payload.message, payload.sessionId)
      if (payload.message.role === 'assistant') {
        notifySessionRead(payload.sessionId)
        renderSessions()
      }
    } else {
      // 非当前会话完成回复：先在本页立刻点红点，再向服务端同步未读状态。
      if (payload.message.role === 'assistant') {
        const session = state.sessions.find((item) => item.id === payload.sessionId)
        if (session) {
          session.unread = true
          renderSessions()
        }
      }
      scheduleSessionRefresh()
    }
  })

  // 管理后台改了模型目录：后端通过 SSE 推 models 事件，页面收到后重拉一次目录。
  source.addEventListener('models', () => {
    void refreshModelCatalog()
  })
  // 管理后台改了助手名字/头像：名字同时是语音唤醒词，立即更新，不需要刷新页面。
  source.addEventListener('assistant', (event) => {
    let payload = null
    try {
      payload = JSON.parse(event.data || '{}')
    } catch {
      payload = null
    }
    if (!payload?.name) return
    applyAssistantIdentity(payload.name, payload.avatarUrl)
  })
  // 云空间文件变化：列表主动刷新；删除事件同时就地更新消息卡片。
  source.addEventListener('workspace', (event) => {
    let payload = null
    try {
      payload = JSON.parse(event.data || '{}')
    } catch {
      payload = null
    }
    handleWorkspaceFilesEvent(payload)
  })
  // SSE 首次连上或断线重连后补一次，覆盖“连接建立前目录/文件已变化”的空档。
  source.addEventListener('ready', () => {
    void refreshModelCatalog()
    scheduleWorkspaceRefresh()
  })
  if (!state.workspaceVisibilityBound) {
    state.workspaceVisibilityBound = true
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return
      if (state.workspaceRefreshPending) {
        state.workspaceRefreshPending = false
        scheduleWorkspaceRefresh()
      }
    })
  }

  // EventSource 会自己重连；这里不主动 close，避免服务重启后永久失去推送。
  source.addEventListener('error', () => {
    // 浏览器会自动重连，保持引用即可。
  })
}

let scrollBottomButtonFrame = 0

function threadDistanceToBottom(thread = $('#thread')) {
  if (!thread) return 0
  return thread.scrollHeight - thread.scrollTop - thread.clientHeight
}

function pinThreadToBottom() {
  threadScrollPinned = true
  threadHasNewBelow = false
  queueScrollBottomButtonUpdate()
}

/** 切回对话页时按当前真实位置校准贴底状态，避免旧位置仍被当成“正在跟随”。 */
function syncThreadScrollState() {
  const thread = $('#thread')
  if (!thread) return
  threadScrollLastTop = thread.scrollTop
  threadScrollPinned = threadDistanceToBottom(thread) <= SCROLL_STICK_THRESHOLD
  if (threadScrollPinned) threadHasNewBelow = false
  updateScrollBottomButton()
}

function unpinThreadFromBottom() {
  threadScrollPinned = false
  queueScrollBottomButtonUpdate()
}

/** 用户正在看旧内容时只记录“下方有新内容”，不改变滚动位置。 */
function markThreadNewContent() {
  if (threadScrollPinned) return
  threadHasNewBelow = true
  queueScrollBottomButtonUpdate()
}

function updateScrollBottomButton() {
  const button = $('#scroll-bottom')
  if (!button) return
  const thread = $('#thread')
  const empty = $('#chat-empty')
  const hasMessages = Boolean(thread?.querySelector('.msg'))
  const emptyVisible = Boolean(empty && !empty.hidden)
  // 空态/新建会话没有“最新消息”可回；贴底时内容增长也可能让距离暂时变大，不能因此闪出按钮。
  button.hidden = threadScrollPinned || emptyVisible || !hasMessages
  button.classList.toggle('has-new', threadHasNewBelow)
  const label = threadHasNewBelow ? '有新内容，回到最新消息' : '回到最新消息'
  button.title = label
  button.setAttribute('aria-label', label)
}

function queueScrollBottomButtonUpdate() {
  if (scrollBottomButtonFrame) return
  scrollBottomButtonFrame = requestAnimationFrame(() => {
    scrollBottomButtonFrame = 0
    updateScrollBottomButton()
  })
}

function scrollThreadToBottomSmooth() {
  const thread = $('#thread')
  if (!thread) return
  pinThreadToBottom()
  thread.scrollTo({ top: thread.scrollHeight, behavior: 'smooth' })
  queueScrollBottomButtonUpdate()
}

function scrollThreadToBottomInstant() {
  const thread = $('#thread')
  if (!thread) return
  pinThreadToBottom()
  const previous = thread.style.scrollBehavior
  // 容器 CSS 是 smooth；切会话要“直接落在底部”，不能从顶部再滑过去。
  thread.style.scrollBehavior = 'auto'
  thread.scrollTop = thread.scrollHeight
  threadScrollLastTop = thread.scrollTop
  queueScrollBottomButtonUpdate()
  requestAnimationFrame(() => {
    if (!thread.isConnected) return
    thread.scrollTop = thread.scrollHeight
    threadScrollLastTop = thread.scrollTop
    if (previous) thread.style.scrollBehavior = previous
    else thread.style.removeProperty('scroll-behavior')
    updateScrollBottomButton()
  })
}

function resetHistoryState() {
  state.historyBefore = null
  state.historyHasMore = false
  state.historyLoading = false
  state.historyMessageIds.clear()
}

function historyMessagesUrl(sessionId, before) {
  const params = new URLSearchParams({ limit: String(HISTORY_PAGE_SIZE) })
  if (before) params.set('before', String(before))
  const base = qs()
  return `/api/chat/sessions/${encodeURIComponent(sessionId)}/messages${base}${base ? '&' : '?'}${params.toString()}`
}

function ensureHistoryLoader() {
  const thread = $('#thread')
  if (!thread) return null
  let loader = thread.querySelector('.history-loader')
  if (loader) return loader
  loader = document.createElement('div')
  loader.className = 'history-loader'
  loader.textContent = '正在加载更早的消息…'
  loader.hidden = true
  const firstMessage = thread.querySelector('.msg')
  thread.insertBefore(loader, firstMessage || null)
  return loader
}

async function loadOlderMessages() {
  const thread = $('#thread')
  const sessionId = state.sessionId
  if (!thread || !sessionId || state.historyLoading || !state.historyHasMore || !state.historyBefore) return

  state.historyLoading = true
  const loader = ensureHistoryLoader()
  if (loader) {
    loader.hidden = false
    loader.textContent = '正在加载更早的消息…'
  }
  const previousBehavior = thread.style.scrollBehavior

  try {
    const data = await api(historyMessagesUrl(sessionId, state.historyBefore))
    if (state.sessionId !== sessionId) return
    const messages = Array.isArray(data.messages) ? data.messages : []
    if (messages.length === 0) {
      state.historyHasMore = false
      state.historyBefore = null
      if (loader) loader.hidden = true
      return
    }

    // 后端按 before 游标只会返回更早的消息；这里再按 id 去重，防止同一页
    // 因滚动事件或异常游标被重复插入，也保证“已加载过的历史不再重复请求”。
    const newMessages = messages.filter((message) => {
      const id = String(message.id || '')
      if (!id) return true
      if (state.historyMessageIds.has(id)) return false
      state.historyMessageIds.add(id)
      return true
    })
    if (newMessages.length === 0) {
      state.historyHasMore = false
      state.historyBefore = null
      if (loader) loader.hidden = true
      return
    }

    if (loader) loader.hidden = true
    // 先记录高度和位置，插到顶部后按“新增高度”补偿，避免阅读位置跳动。
    thread.style.scrollBehavior = 'auto'
    const previousHeight = thread.scrollHeight
    const previousTop = thread.scrollTop
    for (let index = newMessages.length - 1; index >= 0; index -= 1) {
      const message = newMessages[index]
      // 多页澄清的中间答复/中间问题只用于续跑，不在聊天记录里显示。
      if (isHiddenClarifyStep(message)) continue
      // 独立进度卡只作为父消息的进度数据源，不再单独占一条气泡。
      if (isStandaloneTeamProgressMessage(message)) {
        rememberPendingTeamProgress(message)
        continue
      }
      const teamProgress = teamProgressForMessage(message)
      appendMessage(
        message.role === 'user' ? 'me' : 'ai',
        message.text,
        message.role === 'assistant' && message.modelName ? message.modelName : undefined,
        message.meta && message.meta.attachments,
        message.role === 'assistant'
          ? (teamProgress ? { ...message.meta, teamProgress } : message.meta)
          : undefined,
        { scroll: false, prepend: true, channel: message.meta?.channel, messageId: message.id, createdAt: message.createdAt },
      )
    }
    state.pendingTeamProgress = null
    thread.scrollTop = previousTop + (thread.scrollHeight - previousHeight)

    state.historyBefore = Boolean(data.hasMore) ? data.nextBefore || newMessages[0].id : null
    state.historyHasMore = Boolean(data.hasMore)
  } catch (err) {
    console.warn('加载更早消息失败', err)
    if (loader) {
      loader.textContent = '加载更早的消息失败，继续上滑可重试'
      window.setTimeout(() => {
        if (loader.isConnected) loader.hidden = true
      }, 2500)
    }
  } finally {
    if (state.sessionId === sessionId) state.historyLoading = false
    requestAnimationFrame(() => {
      if (!thread.isConnected) return
      if (previousBehavior) thread.style.scrollBehavior = previousBehavior
      else thread.style.removeProperty('scroll-behavior')
      if (state.sessionId === sessionId) fillHistoryIfNeeded()
      updateScrollBottomButton()
    })
  }
}

function onThreadScroll() {
  const thread = $('#thread')
  if (!thread) return
  const top = thread.scrollTop
  const distance = threadDistanceToBottom(thread)
  // 程序滚动到底只会让 top 变大；top 变小说明用户主动上滚，立刻停止跟随。
  if (top < threadScrollLastTop - 1) {
    unpinThreadFromBottom()
  } else if (top > threadScrollLastTop + 1 && distance <= SCROLL_STICK_THRESHOLD) {
    // 用户向下滚到接近底部，或程序滚动落到底部时恢复跟随。
    pinThreadToBottom()
  }
  threadScrollLastTop = top
  updateScrollBottomButton()
  if (!thread || state.historyLoading || !state.historyHasMore || !state.historyBefore) return
  if (thread.scrollTop <= HISTORY_TOP_THRESHOLD) loadOlderMessages()
}

/** 首屏或上一页太短、没有滚动条时，继续补到能滚动为止，否则用户无法触发更早历史。 */
function fillHistoryIfNeeded() {
  const thread = $('#thread')
  if (!thread || state.historyLoading || !state.historyHasMore || !state.historyBefore) return
  if (thread.scrollHeight <= thread.clientHeight + 4) loadOlderMessages()
}

/** 从任务历史还原父子对话：每条任务先显示父 Agent 的派发，再显示子 Agent 的回报。 */
function rebuildAgentThreadFromTasks(worker, tasks) {
  const ordered = (Array.isArray(tasks) ? tasks : [])
    .slice()
    .sort((a, b) => (Number(a.startedAt) || Number(a.finishedAt) || 0) - (Number(b.startedAt) || Number(b.finishedAt) || 0))
  const thread = []
  for (const task of ordered) {
    const taskAt = Number(task.startedAt) || Number(task.finishedAt) || 0
    const prompt = String(task.prompt || '').trim()
    if (prompt) thread.push({ kind: 'assign', text: prompt, at: taskAt })
    const result = String(task.result || '').trim()
    if (result) {
      thread.push({
        kind: 'content',
        text: result,
        at: Number(task.finishedAt) || taskAt,
        final: true,
      })
      continue
    }
    if (task.status === 'failed' || task.status === 'cancelled') {
      thread.push({
        kind: 'done',
        text: String(task.error || (task.status === 'failed' ? '执行失败' : '已取消')),
        status: task.status,
        at: Number(task.finishedAt) || taskAt,
      })
    }
  }
  const lastText = String(worker?.lastText || '').trim()
  if (thread.length === 0) {
    if (lastText) {
      thread.push({
        kind: worker?.status === 'waiting' ? 'question' : 'content',
        text: lastText,
        at: Number(worker?.lastTaskAt) || Date.now(),
        final: worker?.status !== 'waiting',
      })
    }
  } else if (worker?.status === 'waiting' && lastText) {
    const last = thread[thread.length - 1]
    if (!last || last.kind !== 'question') {
      thread.push({
        kind: 'question',
        text: lastText,
        at: Number(worker?.lastTaskAt) || Date.now(),
      })
    }
  }
  return thread
}

async function loadPersistedAgentTeam(sessionId, seq) {
  if (!sessionId) return
  try {
    const data = await api(`/api/chat/agents?sessionId=${encodeURIComponent(sessionId)}`)
    if (seq !== agentTeamPollSeq || state.sessionId !== sessionId) return
    const workers = Array.isArray(data.workers) ? data.workers : []
    const tasks = Array.isArray(data.tasks) ? data.tasks : []
    state.agentCapacity = data.capacity && typeof data.capacity === 'object' ? data.capacity : null
    if (workers.length === 0) {
      renderAgentDock()
      return
    }
    const tasksByKey = new Map()
    for (const task of tasks) {
      if (!task || !task.key) continue
      const list = tasksByKey.get(task.key) || []
      list.push(task)
      tasksByKey.set(task.key, list)
    }
    for (const worker of workers) {
      const previous = state.agentRuns.get(`${sessionId}:k:${worker.key}`) || {}
      const workerTasks = tasksByKey.get(worker.key) || []
      const latestTask = workerTasks[0]
      const status = worker.status === 'waiting'
        ? 'waiting'
        : worker.status === 'idle'
          ? (latestTask?.status === 'failed' ? 'failed' : latestTask?.status === 'cancelled' ? 'cancelled' : 'done')
          : 'running'
      const lastText = String(worker.lastText || '')
      let thread = Array.isArray(previous.thread) ? previous.thread.slice() : []
      if (thread.length === 0) {
        // 刷新/切换会话后，SSE 已经断开，只能靠任务历史重建完整的父—子对话。
        thread = rebuildAgentThreadFromTasks(worker, workerTasks)
      } else if (!thread.some((entry) => entry.kind === 'assign' || entry.kind === 'answer') && workerTasks.length > 0) {
        // 实时 thread 只收到了子 Agent 的过程/正文：把父 Agent 的派发补到最前面。
        const parentEntries = workerTasks
          .slice()
          .sort((a, b) => (Number(a.startedAt) || Number(a.finishedAt) || 0) - (Number(b.startedAt) || Number(b.finishedAt) || 0))
          .flatMap((task) => {
            const text = String(task.prompt || '').trim()
            return text
              ? [{ kind: 'assign', text, at: Number(task.startedAt) || Number(task.finishedAt) || Date.now() }]
              : []
          })
        if (parentEntries.length > 0) thread = [...parentEntries, ...thread]
      }
      state.agentRuns.set(`${sessionId}:k:${worker.key}`, {
        ...previous,
        childId: `${sessionId}:k:${worker.key}`,
        key: worker.key,
        parentRunId: previous.parentRunId || latestTask?.parentRunId || '',
        runId: previous.runId || worker.runId || '',
        index: Number(worker.index) || previous.index || 1,
        title: worker.name || previous.title || worker.key,
        modelId: worker.modelId || previous.modelId || '',
        modelName: worker.modelName || previous.modelName || '',
        role: worker.role || previous.role || 'worker',
        parentKey: worker.parentKey !== undefined ? worker.parentKey : (previous.parentKey ?? null),
        depth: Number(worker.depth) || previous.depth || 1,
        acceptance: worker.acceptance || previous.acceptance || '',
        pinned: worker.pinned !== undefined ? Boolean(worker.pinned) : Boolean(previous.pinned),
        status,
        text: lastText || previous.text || '',
        thread,
        artifacts: Array.isArray(latestTask?.artifacts) ? latestTask.artifacts : (Array.isArray(previous.artifacts) ? previous.artifacts : []),
        error: previous.error || latestTask?.error || '',
        updatedAt: Date.now(),
      })
    }
    renderAgentDock()
  } catch {
    // 团队进度是辅助信息，接口失败不影响对话主流程。
  }
}

function startAgentTeamPolling(sessionId) {
  if (agentTeamPollTimer) clearInterval(agentTeamPollTimer)
  agentTeamPollTimer = null
  if (!sessionId) return
  const seq = ++agentTeamPollSeq
  void loadPersistedAgentTeam(sessionId, seq)
  agentTeamPollTimer = setInterval(() => {
    if (state.sessionId !== sessionId) return
    void loadPersistedAgentTeam(sessionId, seq)
  }, 4000)
}

async function openSession(sessionId) {
  if (state.voiceConversation.active) exitVoiceConversation({ silent: true, reason: '切换会话后，语音对话已结束' })
  clearRemoteLive()
  hideSettings()
  setChatMode('chat')
  resetAgentRuns()
  if (state.messageEdit) cancelMessageEdit({ clearInput: true, silent: true })
  const seq = ++state.openSeq
  try {
    const data = await api(historyMessagesUrl(sessionId))
    if (seq !== state.openSeq) return
    state.sessionId = data.session.id
    state.view = 'chat'
    persistChatLocation()
    applySessionSpace(data.session)
    // 每个会话有自己的常驻引用；切过来时按服务端快照恢复，不继承上一个会话的输入区。
    applySessionReferences(data.session.references)
    const sessionModelId = data.session.modelId || data.session.model_id || ''
    const sessionEffort = data.session.reasoningEffort || data.session.reasoning_effort || ''
    if (sessionModelId && state.models.some((model) => model.id === sessionModelId)) {
      setSelected(sessionModelId, { persist: false, reasoningEffort: sessionEffort })
    } else {
      setSelected('', { persist: false, reasoningEffort: sessionEffort })
      if (sessionModelId) banner('本会话原来使用的模型已不可用，已切回自动选择', 'warn')
    }
    state.historyBefore = Boolean(data.hasMore) ? data.nextBefore || null : null
    state.historyHasMore = Boolean(data.hasMore)
    state.historyLoading = false
    state.historyMessageIds.clear()
    markSessionReadLocally(data.session.id)
    renderSessions()
    $('#chat-title').textContent = data.session.title
    resetThread()
    const thread = $('#thread')
    const pendingClarify = trailingPendingClarify(data.messages)
    if (thread) thread.style.visibility = 'hidden'
    try {
      for (const message of data.messages) {
        if (message.id) state.historyMessageIds.add(message.id)
        // 多页澄清的中间答复/中间问题只用于续跑，不在聊天记录里显示。
        if (isHiddenClarifyStep(message)) continue
        // 独立进度卡只作为父消息的进度数据源，不再单独占一条气泡。
        if (isStandaloneTeamProgressMessage(message)) {
          rememberPendingTeamProgress(message)
          continue
        }
        const teamProgress = teamProgressForMessage(message)
        appendMessage(
          message.role === 'user' ? 'me' : 'ai',
          message.text,
          message.role === 'assistant' && message.modelName ? message.modelName : undefined,
          message.meta && message.meta.attachments,
          message.role === 'assistant'
            ? (teamProgress ? { ...message.meta, teamProgress } : message.meta)
            : undefined,
          { scroll: false, channel: message.meta?.channel, pendingClarify: pendingClarify === message, messageId: message.id, createdAt: message.createdAt },
        )
      }
      state.pendingTeamProgress = null
      if (data.messages.length > 0) {
        setEmptyVisible(false)
        scrollThreadToBottomInstant()
      }
    } finally {
      if (thread) thread.style.visibility = ''
    }
    attachLiveTurnForSession(data.session.id)
    startAgentTeamPolling(data.session.id)
    if (pendingClarify?.meta?.clarify) {
      showClarifyDock(pendingClarify.meta.clarify, { flowMeta: pendingClarify.meta, auto: true })
    } else {
      clearClarifyDock()
    }
    renderSessions()
    renderQueueState()
    requestAnimationFrame(() => {
      if (state.sessionId === data.session.id) fillHistoryIfNeeded()
      updateScrollBottomButton()
    })
  } catch (err) {
    resetHistoryState()
    if (err.code === 'EAB_NOT_FOUND') {
      // 列表可能是上一次加载留下的旧数据：会话已经删除时，顺手从侧边栏移除，
      // 不再把“会话不存在”渲染成一条假的 AI 回复。
      const before = state.sessions.length
      state.sessions = state.sessions.filter((session) => session.id !== sessionId)
      if (state.sessions.length !== before) renderSessions()
      banner('该对话已不存在，已从列表中移除', 'warn')
      return
    }
    appendMessage('ai', `${err.message}${err.code ? `（${err.code}）` : ''}`, undefined, undefined, undefined, { animate: true })
  }
}

function newSession() {
  hideSettings()
  // 新建对话等于换上下文：连续语音不能沿用旧会话的收听状态与播报归属。
  if (state.voiceConversation.active) exitVoiceConversation({ silent: true })
  setChatMode('chat')
  if (state.messageEdit) cancelMessageEdit({ clearInput: true, silent: true })
  state.openSeq += 1
  state.sessionId = null
  clearComposerAttachments()
  setSelected('', { persist: false })
  resetAgentRuns()
  resetHistoryState()
  $('#chat-title').textContent = '新对话'
  resetThread()
  renderSessions()
  renderQueueState()
  persistChatLocation()
  $('#input').focus()
}

function sessionById(sessionId) {
  return state.sessions.find((session) => session.id === sessionId)
}

function hideSessionMenu() {
  const menu = $('#session-menu')
  if (!menu) return
  menu.hidden = true
  menu.dataset.session = ''
}

function showSessionMenu(sessionId, anchor) {
  const menu = $('#session-menu')
  const session = sessionById(sessionId)
  if (!menu || !session) return
  hideFileMenu()
  menu.innerHTML = `<div class="session-menu-title">${esc(session.title)}</div>
    <button type="button" data-act="rename">重命名</button>
    <button type="button" data-act="delete" class="is-danger">删除</button>`
  menu.dataset.session = sessionId
  menu.hidden = false
  const box = menu.getBoundingClientRect()
  const left = Math.min(Math.max(8, anchor.right - box.width), window.innerWidth - box.width - 8)
  const below = anchor.bottom + 4
  const top = below + box.height + 8 > window.innerHeight ? Math.max(8, anchor.top - box.height - 4) : below
  menu.style.left = `${left}px`
  menu.style.top = `${top}px`
}

function hideMessageMenu() {
  const menu = $('#message-menu')
  if (!menu) return
  menu.hidden = true
  menu.dataset.message = ''
}

function showMessageMenu(node, x, y) {
  const menu = $('#message-menu')
  if (!menu || !node) return
  const data = node.chatMessage || null
  const id = String(data?.id || node.dataset.messageId || '')
  if (!id) return
  const role = data?.role === 'user' || node.classList.contains('me') ? 'user' : 'assistant'
  const text = String(data?.text || node.querySelector('.bubble')?.innerText || '').trim()
  const busy = sessionReplyBusy()
  const preview = text ? text.replace(/\s+/g, ' ').slice(0, 48) : role === 'user' ? '我的消息' : 'AI 回答'
  hideSessionMenu()
  hideFileMenu()
  menu.innerHTML = `<div class="session-menu-title">${esc(preview)}</div>
    ${
      role === 'user'
        ? `<button type="button" data-message-act="edit" ${busy ? 'disabled' : ''}>编辑后重发</button>
           <button type="button" data-message-act="recall" ${busy ? 'disabled' : ''}>撤回</button>`
        : ''
    }
    <button type="button" data-message-act="delete" class="is-danger" ${busy ? 'disabled' : ''}>删除</button>
    ${busy ? '<div class="session-menu-hint">回复结束后可操作</div>' : ''}`
  menu.dataset.message = id
  menu.hidden = false
  const box = menu.getBoundingClientRect()
  const left = Math.min(Math.max(8, x), window.innerWidth - box.width - 8)
  const top = Math.min(Math.max(8, y), window.innerHeight - box.height - 8)
  menu.style.left = `${left}px`
  menu.style.top = `${top}px`
}

function messageDeleteUrl(id, mode) {
  return qsAppend(`/api/chat/messages/${encodeURIComponent(id)}?mode=${encodeURIComponent(mode)}`)
}

async function deleteMessageApi(id, mode) {
  return api(messageDeleteUrl(id, mode), {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
}

function removeDeletedMessageNodes(ids) {
  const removed = new Set((ids || []).map((id) => String(id)))
  if (removed.size === 0) return
  const thread = $('#thread')
  if (thread) {
    for (const node of thread.querySelectorAll('.msg[data-message-id]')) {
      if (removed.has(String(node.dataset.messageId))) node.remove()
    }
  }
  for (const id of removed) {
    state.historyMessageIds.delete(id)
    state.liveTurns.delete(id)
    state.activeRunSnapshots.delete(id)
    state.localLiveMessageIds.delete(id)
  }
  const first = thread?.querySelector('.msg[data-message-id]')
  state.historyBefore = first?.dataset.messageId || null
  if (thread && !thread.querySelector('.msg')) setEmptyVisible(true)
  updateScrollBottomButton()
}

function renderMessageEditBar() {
  const bar = $('#message-edit-bar')
  if (!bar) return
  bar.hidden = !state.messageEdit
}

function cancelMessageEdit({ clearInput = false, silent = false } = {}) {
  const had = Boolean(state.messageEdit)
  state.messageEdit = null
  renderMessageEditBar()
  const input = $('#input')
  if (had && clearInput && input) {
    input.value = ''
    input.style.height = '44px'
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  if (had && !silent) banner('已取消编辑')
}

function beginEditMessage(message) {
  const id = String(message?.id || '')
  const text = String(message?.text || '')
  if (!id) return
  if (sessionReplyBusy()) {
    banner('回复结束后再编辑消息', 'warn')
    return
  }
  state.messageEdit = { id, sessionId: state.sessionId, text }
  const input = $('#input')
  if (input) {
    input.value = text
    input.style.height = '44px'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.focus()
    input.setSelectionRange(text.length, text.length)
  }
  renderMessageEditBar()
}

async function recallMessage(message) {
  const id = String(message?.id || '')
  if (!id) return
  if (sessionReplyBusy()) {
    banner('回复结束后再撤回消息', 'warn')
    return
  }
  const confirmed = await openConfirmCard({
    eyebrow: '撤回消息',
    title: '撤回这条提问？',
    targetLabel: '消息',
    target: String(message.text || '').slice(0, 40),
    message: '撤回后会删除这条提问和紧随其后的回答，并把原文放回输入框；后续消息不会被删除。',
    confirmText: '撤回',
  })
  if (!confirmed) return
  try {
    const result = await deleteMessageApi(id, 'turn')
    removeDeletedMessageNodes(result.deletedIds)
    const input = $('#input')
    if (input) {
      input.value = String(message.text || '')
      input.style.height = '44px'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.focus()
    }
    banner('已撤回，原文已放回输入框', 'ok')
    void loadSessions()
  } catch (err) {
    banner(`撤回失败：${err.message}`, 'bad')
  }
}

async function deleteMessage(message) {
  const id = String(message?.id || '')
  if (!id) return
  if (sessionReplyBusy()) {
    banner('回复结束后再删除消息', 'warn')
    return
  }
  const isUser = message.role === 'user'
  const confirmed = await openConfirmCard({
    eyebrow: '删除消息',
    title: isUser ? '删除这条提问和回答？' : '删除这条回答？',
    targetLabel: isUser ? '提问' : '回答',
    target: String(message.text || '').slice(0, 40),
    message: isUser ? '会同时删除这条提问和紧随其后的回答；后续消息保留。' : '只删除这一条回答，不影响其它消息。',
  })
  if (!confirmed) return
  try {
    const result = await deleteMessageApi(id, isUser ? 'turn' : 'message')
    removeDeletedMessageNodes(result.deletedIds)
    banner('已删除消息', 'ok')
    void loadSessions()
  } catch (err) {
    banner(`删除失败：${err.message}`, 'bad')
  }
}

function handleMessageAction(action, message) {
  const act = String(action || '')
  if (!message?.id || !act) return
  if (act === 'edit') beginEditMessage(message)
  else if (act === 'recall') recallMessage(message)
  else if (act === 'delete') deleteMessage(message)
}

function openConfirmCard({ eyebrow = '危险操作', title, targetLabel = '目标', target, message, confirmText = '删除', cancelText = '取消' }) {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay confirm-overlay'
    overlay.innerHTML = `<div class="modal confirm-card" role="dialog" aria-modal="true" aria-labelledby="confirm-card-title" aria-describedby="confirm-card-message">
      <div class="confirm-card-head">
        <span class="confirm-card-icon" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2.6 14.2 13.4H1.8L8 2.6Z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/><path d="M8 6.2v3.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/><circle cx="8" cy="11.4" r=".65" fill="currentColor"/></svg></span>
        <div class="confirm-card-titles">
          <span class="confirm-card-eyebrow">${esc(eyebrow)}</span>
          <h3 id="confirm-card-title">${esc(title)}</h3>
        </div>
        <button class="modal-x" type="button" aria-label="关闭">×</button>
      </div>
      <div class="confirm-card-body">
        <div class="confirm-card-target"><span>${esc(targetLabel)}</span><strong>${esc(target || '未命名')}</strong></div>
        <p class="confirm-card-message" id="confirm-card-message">${esc(message)}</p>
      </div>
      <div class="confirm-card-actions">
        <button class="btn ghost" type="button" data-confirm-cancel>${esc(cancelText)}</button>
        <button class="btn danger" type="button" data-confirm-ok>${esc(confirmText)}</button>
      </div>
    </div>`
    document.body.appendChild(overlay)
    document.body.classList.add('eab-modal-open')
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      document.removeEventListener('keydown', onKey)
      overlay.remove()
      document.body.classList.remove('eab-modal-open')
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected && !previousFocus.closest('[hidden]')) {
        previousFocus.focus({ preventScroll: true })
      } else {
        $('#input')?.focus()
      }
      resolve(value)
    }
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        finish(false)
        return
      }
      if (event.key !== 'Tab') return
      const focusables = [...overlay.querySelectorAll('button:not([disabled]), input:not([disabled])')]
      if (!focusables.length) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    overlay.querySelector('.modal-x').addEventListener('click', () => finish(false))
    overlay.querySelector('[data-confirm-cancel]').addEventListener('click', () => finish(false))
    overlay.querySelector('[data-confirm-ok]').addEventListener('click', () => finish(true))
    overlay.querySelector('[data-confirm-cancel]').focus()
  })
}

async function renameSession(sessionId, currentTitle) {
  if (!sessionId) return
  const title = window.prompt('会话名称', currentTitle || '新对话')
  if (!title || !title.trim()) return
  const next = title.trim()
  try {
    await api(`/api/chat/sessions/${encodeURIComponent(sessionId)}${qs()}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: next }),
    })
    if (state.sessionId === sessionId) $('#chat-title').textContent = next
    await loadSessions()
  } catch (err) {
    banner(err.message || '会话重命名失败，请稍后重试', 'bad')
  }
}

async function deleteSession(sessionId) {
  if (!sessionId) return
  const session = sessionById(sessionId)
  const confirmed = await openConfirmCard({
    eyebrow: '会话管理',
    title: '删除这个会话？',
    targetLabel: '要删除的会话',
    target: `「${session?.title || '未命名'}」`,
    message: '删除后聊天记录会软删除，可在数据库审计中追溯。',
    confirmText: '删除会话',
  })
  if (!confirmed) return
  try {
    await api(`/api/chat/sessions/${encodeURIComponent(sessionId)}${qs()}`, { method: 'DELETE' })
    banner('会话已删除', 'ok')
    if (state.sessionId === sessionId) {
      state.sessionId = null
      $('#chat-title').textContent = '新对话'
      resetHistoryState()
      resetThread()
      persistChatLocation()
    }
    await loadSessions()
  } catch (err) {
    banner(err.message || '会话删除失败，请稍后重试', 'bad')
  }
}

/* ---------------- 个人工作区（上传文件 + 对话写入文件） ---------------- */

async function loadWorkspaceFiles(options = {}) {
  const silent = options.silent === true
  if (state.workspaceLoadPromise) {
    state.workspaceRefreshPending = true
    return state.workspaceLoadPromise
  }
  if (silent && document.hidden) {
    state.workspaceRefreshPending = true
    return null
  }
  const list = $('#ws-list')
  const scrollTop = silent && list ? list.scrollTop : 0
  const promise = (async () => {
    try {
      const [data, quota] = await Promise.all([
        api(`/api/workspace/files${qs()}`),
        api(`/api/workspace/quota${qs()}`).catch(() => null),
      ])
      state.files = data.items || []
      if (!workspacePathExists(state.files, state.workspacePath)) state.workspacePath = ''
      if (state.me) $('#side-files').hidden = false
      renderWorkspaceFiles()
      if (silent && list) list.scrollTop = scrollTop
      if (quota) {
        renderWorkspaceQuota(quota)
        maybeWarnWorkspaceQuota(quota)
      }
    } catch (err) {
      // 后台静默刷新失败不能把已有列表清空，否则网络抖动一下界面就空了。
      if (!silent) {
        state.files = []
        state.workspacePath = ''
        const box = $('#ws-list')
        if (box) box.innerHTML = `<div class="muted" style="font-size:12px;padding:4px">${esc(err.message)}</div>`
      }
    }
  })()
  state.workspaceLoadPromise = promise
  try {
    return await promise
  } finally {
    state.workspaceLoadPromise = null
    if (state.workspaceRefreshPending && !document.hidden) {
      state.workspaceRefreshPending = false
      scheduleWorkspaceRefresh()
    }
  }
}

/** SSE 连续事件、重连、页面重新可见都走这里：300ms 合并，一次请求。 */
function scheduleWorkspaceRefresh() {
  if (!state.me) return
  if (document.hidden) {
    state.workspaceRefreshPending = true
    return
  }
  if (state.workspaceRefreshTimer) return
  state.workspaceRefreshTimer = window.setTimeout(() => {
    state.workspaceRefreshTimer = 0
    void loadWorkspaceFiles({ silent: true })
  }, 300)
}

function handleWorkspaceFilesEvent(payload) {
  const reason = String(payload?.reason || '')
  const fileIds = Array.isArray(payload?.fileIds) ? payload.fileIds.map(String) : []
  if (reason === 'deleted' && fileIds.length > 0) {
    markAttachmentCardsDeleted(fileIds)
    const deleted = new Set(fileIds)
    state.files = state.files.filter((file) => !deleted.has(String(file.id)))
    renderWorkspaceFiles()
    if (state.filePreview && deleted.has(String(state.filePreview.id))) {
      stopWorkspacePreviewWatch()
      closeWorkspaceFile()
      banner('当前预览的文件已从云空间删除', 'warn')
    }
  }
  scheduleWorkspaceRefresh()
}

function renderWorkspaceQuota(quota) {
  const box = $('#ws-quota-popover')
  if (!box) return
  const user = quota.user || {}
  const used = Math.max(0, Number(user.used) || 0)
  const limit = Math.max(0, Number(user.limit ?? user.limitBytes) || 0)
  const fileLimit = Math.max(0, Number(quota.fileLimitBytes ?? user.fileLimitBytes) || 0)
  const percent = limit > 0 ? Math.min(100, (used / limit) * 100) : 0
  const remaining = Math.max(
    0,
    Number(quota.remainingBytes ?? user.remainingBytes ?? (limit - used)) || 0,
  )
  const warning = quota.warning || user.warning || {}
  const level = String(warning.level || (percent >= 100 ? 'full' : percent >= 95 ? 'critical' : percent >= 85 ? 'warning' : percent >= 75 ? 'notice' : 'normal'))
  const warningMessage = String(warning.message || '').trim()
  const source = String(quota.quotaSource || user.source || 'default')
  const sourceLabel =
    source === 'user' ? '个人配置' : source === 'role' ? '角色配置' : '默认配置'
  const roleText = Array.isArray(quota.roleCodes) && quota.roleCodes.length ? ` · ${quota.roleCodes.join(' / ')}` : ''
  const storageNote = '文件保存在 EAB 服务端，换设备登录仍可见'
  const quotaBadgeTitle = `${sourceLabel}${roleText}；${storageNote}`
  const badge = $('#ws-info')
  badge?.classList.toggle('is-high', level === 'notice' || level === 'warning')
  badge?.classList.toggle('is-critical', level === 'critical' || level === 'full')
  badge?.setAttribute(
    'aria-label',
    `云空间剩余 ${fmtSize(remaining)}；已用 ${fmtSize(used)} / ${fmtQuota(limit)}${warningMessage ? `；${warningMessage}` : ''}`,
  )
  const warningHtml =
    warningMessage && level !== 'normal'
      ? `<div class="ws-quota-warning${level === 'critical' || level === 'full' ? ' is-critical' : ''}">${esc(warningMessage)}</div>`
      : ''
  box.innerHTML = `
    <div class="ws-quota-head">
      <div class="ws-quota-title">
        <span class="ws-quota-label">云空间</span>
        <span class="ws-quota-badge" title="${esc(quotaBadgeTitle)}" aria-label="${esc(quotaBadgeTitle)}">?</span>
      </div>
      <span class="ws-quota-value"><strong>${esc(fmtSize(used))}</strong><span class="ws-quota-sep">/</span>${esc(
        fmtQuota(limit),
      )}</span>
    </div>
    <div class="ws-quota-bar" role="progressbar" aria-label="云空间已用空间" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(
      percent,
    )}" title="已用 ${esc(fmtSize(used))}，容量 ${esc(fmtQuota(limit))}">
      <span class="ws-quota-fill${level === 'critical' || level === 'full' ? ' is-critical' : level === 'notice' || level === 'warning' ? ' is-high' : ''}" style="width:${percent.toFixed(1)}%"></span>
    </div>
    ${warningHtml}
    <div class="ws-quota-foot">
      <span>剩余 ${esc(fmtSize(remaining))} · 单文件 ≤ ${esc(fmtQuota(fileLimit))}</span>
    </div>`
}

let lastWorkspaceWarningLevel = ''
function maybeWarnWorkspaceQuota(quota) {
  const user = quota.user || {}
  const used = Math.max(0, Number(user.used) || 0)
  const limit = Math.max(0, Number(user.limit ?? user.limitBytes) || 0)
  const percent = limit > 0 ? Math.min(100, (used / limit) * 100) : 100
  const warning = quota.warning || user.warning || {}
  const level = String(
    warning.level ||
      (percent >= 100 ? 'full' : percent >= 95 ? 'critical' : percent >= 85 ? 'warning' : percent >= 75 ? 'notice' : 'normal'),
  )
  if (level === 'normal') {
    lastWorkspaceWarningLevel = ''
    return
  }
  if (level === lastWorkspaceWarningLevel) return
  lastWorkspaceWarningLevel = level
  const message = String(warning.message || '').trim()
  if (!message) return
  banner(`${message} 可在侧栏「云空间」查看详情。`, level === 'critical' || level === 'full' ? 'bad' : 'warn')
}

function spaceLabelFor(kind) {
  return kind === 'none' ? '不使用文件' : '云空间'
}

function renderSpaceChip() {
  const label = $('#space-chip-label')
  const chip = $('#space-chip')
  if (!label || !chip) return
  const kind = state.spaceKind === 'none' ? 'none' : 'cloud'
  state.spaceKind = kind
  state.spaceLabel = spaceLabelFor(kind)
  label.textContent = state.spaceLabel
  chip.classList.toggle('is-none', kind === 'none')
  chip.title = kind === 'none'
    ? '本轮不读写文件；点击可切换到云空间'
    : '云空间默认可用；点击可切换为不使用文件空间'
  chip.setAttribute('aria-label', `文件空间：${state.spaceLabel}`)
}

/** 文件空间固定为云空间：输入区不再提供切换入口，历史会话也统一回到默认。 */
function applySessionSpace(_session) {
  state.spaceKind = 'cloud'
  renderSpaceChip()
}

function setSpace(kind, _spaceId, options = {}) {
  state.spaceKind = kind === 'none' ? 'none' : 'cloud'
  renderSpaceChip()
  hideSpaceMenu()
  if (!options.silent) {
    closeWorkspaceFile()
    banner(`文件空间已切换为「${spaceLabelFor(state.spaceKind)}」；发送新消息后生效。`, 'ok')
  }
}

function hideSpaceMenu() {
  const menu = $('#space-menu')
  if (menu) menu.hidden = true
  $('#space-chip')?.setAttribute('aria-expanded', 'false')
}

/** 空间气泡独立绑定：即使当前账号没有可用模型，也能打开/关闭空间菜单 */
function bindSpacePicker() {
  const chip = $('#space-chip')
  const menu = $('#space-menu')
  if (!chip || !menu) return
  chip.addEventListener('click', (event) => {
    event.stopPropagation()
    const open = menu.hidden
    if (open) renderSpaceMenu()
    menu.hidden = !open
    chip.setAttribute('aria-expanded', open ? 'true' : 'false')
  })
  document.addEventListener('click', (event) => {
    if (!event.target.closest('#space-chip') && !event.target.closest('#space-menu')) hideSpaceMenu()
  })
}

function renderSpaceMenu() {
  const menu = $('#space-menu')
  if (!menu) return
  const options = [
    { kind: 'cloud', label: '云空间', desc: '默认可用，文件保存在云端' },
    { kind: 'none', label: '不使用文件空间', desc: '本轮只聊天，不读写任何文件' },
  ]
  menu.innerHTML = options
    .map(
      (option) => `<button class="space-menu-item${state.spaceKind === option.kind ? ' is-active' : ''}" type="button" data-space-kind="${option.kind}">
        <span class="space-menu-name">${option.label}</span>
        <span class="space-menu-desc">${option.desc}</span>
      </button>`,
    )
    .join('')
  for (const button of menu.querySelectorAll('[data-space-kind]')) {
    button.addEventListener('click', () => setSpace(button.dataset.spaceKind))
  }
}
/* ---------------- 云空间虚拟目录 ---------------- */

/** 云空间路径统一成无首尾斜杠的 `/` 分隔形式。 */
function workspaceNormalizePath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/')
}

function workspaceFilePath(file) {
  return workspaceNormalizePath(file?.relPath || file?.name || '')
}

/** 文件所在的目录；根目录文件返回空串。 */
function workspaceFileParentPath(fileOrPath) {
  const rel = workspaceNormalizePath(
    typeof fileOrPath === 'string' ? fileOrPath : workspaceFilePath(fileOrPath),
  )
  const slash = rel.lastIndexOf('/')
  return slash < 0 ? '' : rel.slice(0, slash)
}

function workspacePathExists(files, currentPath) {
  const dir = workspaceNormalizePath(currentPath)
  if (!dir) return true
  const prefix = `${dir}/`
  return (Array.isArray(files) ? files : []).some((file) =>
    workspaceFilePath(file).startsWith(prefix),
  )
}

/** 文件夹名称的前端校验与后端保持一致，提前给出可读提示。 */
function workspaceFolderNameError(value) {
  const name = String(value || '').trim()
  if (!name) return '文件夹名称不能为空'
  if (name.includes('/') || name.includes('\\')) return '文件夹名称不能包含斜杠'
  if (name === '.' || name === '..') return '请输入具体的文件夹名称'
  if (name.startsWith('.') || name.startsWith('_')) return '文件夹名称不能以 . 或 _ 开头'
  if (/[\u0000-\u001f\u007f<>:"|?*]/.test(name)) return '文件夹名称包含不允许的字符'
  if (name.endsWith('.') || name.endsWith(' ')) return '文件夹名称不能以点或空格结尾'
  if (name.length > 120) return '文件夹名称过长，最多 120 个字符'
  const base = name.split('.')[0].toLowerCase()
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(base)) return '文件夹名称不能使用 Windows 保留名'
  return ''
}

function workspaceFolderPathJoin(parentPath, name) {
  const parent = workspaceNormalizePath(parentPath)
  const leaf = String(name || '').trim()
  return parent ? `${parent}/${leaf}` : leaf
}

/** 当前层文件夹的计数/共享标记；路径来自菜单时也能找到对应元数据。 */
function workspaceFolderMeta(folderPath) {
  const path = workspaceNormalizePath(folderPath)
  if (!path) return { path: '', name: '云空间', fileCount: 0, folderCount: 0, shared: false }
  const parent = workspaceFileParentPath(path)
  const view = workspaceDirView(state.files, parent)
  const found = view.folders.find((folder) => folder.path === path)
  return found || {
    path,
    name: path.split('/').pop() || path,
    fileCount: 0,
    folderCount: 0,
    shared: false,
  }
}

/**
 * 把扁平的云空间文件按 relPath 归并成当前目录视图。
 * 文件夹本身不落库，同层同名目录合并；文件夹里的共享标记取任一后代文件。
 */
function workspaceDirView(files, currentPath) {
  const dir = workspaceNormalizePath(currentPath)
  const prefix = dir ? `${dir}/` : ''
  const folders = new Map()
  const rows = []
  for (const file of Array.isArray(files) ? files : []) {
    const rel = workspaceFilePath(file)
    if (!rel || !rel.startsWith(prefix)) continue
    const rest = rel.slice(prefix.length)
    if (!rest) continue
    const slash = rest.indexOf('/')
    const base = rest.slice(rest.lastIndexOf('/') + 1)
    const placeholder = base === '.gitkeep'
    if (slash < 0) {
      if (!placeholder) rows.push(file)
      continue
    }
    const name = rest.slice(0, slash)
    const path = dir ? `${dir}/${name}` : name
    const folder = folders.get(name) || {
      name,
      path,
      fileCount: 0,
      folderCount: 0,
      shared: false,
      childNames: new Set(),
    }
    const childName =
      rest.indexOf('/', slash + 1) >= 0 ? rest.slice(slash + 1).split('/')[0] : ''
    if (childName) folder.childNames.add(childName)
    if (!placeholder) {
      folder.fileCount += 1
      folder.shared = folder.shared || Boolean(file.shared)
    }
    folders.set(name, folder)
  }
  const folderRows = [...folders.values()]
    .map(({ childNames, ...folder }) => ({ ...folder, folderCount: childNames.size }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
  const fileRows = rows.sort((a, b) => {
    const byTime = (Number(b?.updatedAt) || 0) - (Number(a?.updatedAt) || 0)
    if (byTime) return byTime
    return String(a?.name || '').localeCompare(String(b?.name || ''), 'zh-CN', {
      numeric: true,
    })
  })
  return { path: dir, folders: folderRows, files: fileRows }
}

function renderWorkspacePath(currentPath) {
  const box = $('#ws-path')
  if (!box) return
  const parts = currentPath ? currentPath.split('/') : []
  if (!parts.length) {
    box.hidden = true
    box.innerHTML = ''
    return
  }
  box.hidden = false
  const crumbs = [
    '<button type="button" data-folder-open="" title="返回云空间根目录">云空间</button>',
  ]
  let path = ''
  for (const part of parts) {
    path = path ? `${path}/${part}` : part
    crumbs.push(
      '<span class="ws-path-sep" aria-hidden="true">/</span>',
      `<button type="button" data-folder-open="${esc(path)}" title="${esc(path)}">${esc(part)}</button>`,
    )
  }
  box.innerHTML = `<span class="ws-path-label">位置</span>${crumbs.join('')}`
  for (const button of box.querySelectorAll('[data-folder-open]')) {
    button.addEventListener('click', () => setWorkspacePath(button.dataset.folderOpen))
  }
}

function setWorkspacePath(nextPath) {
  const path = workspaceNormalizePath(nextPath)
  if (path === state.workspacePath) return
  state.workspacePath = path
  renderWorkspaceFiles()
  const list = $('#ws-list')
  if (list) list.scrollTop = 0
}

function workspaceFileUrl(file) {
  return `/api/workspace/files/${encodeURIComponent(file.id)}/download${qs()}`
}

function workspaceFileDate(value) {
  const date = new Date(Number(value) || 0)
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '—'
}

/** 侧栏行 -> 输入区引用：自定义 MIME 里带完整对象信息，drop 时可还原。 */
function startWorkspaceDrag(event, ref, row) {
  const transfer = event.dataTransfer
  if (!transfer || !ref) return
  const path = workspaceNormalizePath(ref.path || ref.relPath || ref.name || '')
  transfer.effectAllowed = 'copy'
  transfer.setData(WORKSPACE_DRAG_MIME, JSON.stringify(ref))
  transfer.setData('text/plain', path || ref.name || '')
  if (row) {
    row.classList.add('is-dragging')
    transfer.setDragImage(row, 18, 18)
  }
}

/** 对话行 -> 输入区引用：只带会话 ID 和标题，历史由服务端在发送时取一次。 */
function startConversationDrag(event, ref, row) {
  const transfer = event.dataTransfer
  if (!transfer || !ref?.conversationId) return
  transfer.effectAllowed = 'copy'
  transfer.setData(CONVERSATION_DRAG_MIME, JSON.stringify(ref))
  transfer.setData('text/plain', ref.title || ref.conversationId)
  if (row) {
    row.classList.add('is-dragging')
    transfer.setDragImage(row, 18, 18)
  }
}

function renderWorkspaceFiles() {
  const box = $('#ws-list')
  if (!box) return
  if (!workspacePathExists(state.files, state.workspacePath)) state.workspacePath = ''
  const view = workspaceDirView(state.files, state.workspacePath)
  renderWorkspacePath(view.path)
  if (view.folders.length === 0 && view.files.length === 0) {
    box.innerHTML = view.path
      ? '<div class="muted" style="font-size:12px;padding:4px">这个文件夹里还没有文件。点上方「云空间」可返回根目录。</div>'
      : '<div class="muted" style="font-size:12px;padding:4px">还没有文件。点「上传」，或让对话把内容写进云空间。</div>'
    syncSideSectionSplit()
    return
  }
  const activeId = state.filePreview?.id
  const folderRows = view.folders
    .map(
      (folder) => `<div class="side-file side-folder" data-folder-row="${esc(folder.path)}">
        <button class="side-file-name" type="button" data-folder-open="${esc(folder.path)}" title="进入文件夹 ${esc(folder.path)}">
          <span class="side-folder-icon" aria-hidden="true"></span>
          <span class="side-folder-name">${esc(folder.name)}</span>
          ${folder.shared ? '<span class="side-file-shared">共享</span>' : ''}
        </button>
        <span class="side-file-size">${
          folder.fileCount || folder.folderCount
            ? [
                folder.fileCount ? `${folder.fileCount} 个文件` : '',
                folder.folderCount ? `${folder.folderCount} 个文件夹` : '',
              ]
                .filter(Boolean)
                .join(' · ')
            : '空文件夹'
        }</span>
        <button class="side-file-more" type="button" data-folder-more="${esc(folder.path)}" title="文件夹操作" aria-label="文件夹操作" aria-haspopup="menu">⋯</button>
      </div>`,
    )
    .join('')
  const fileRows = view.files
    .map(
      (file) => `<div class="side-file${activeId === file.id ? ' is-active' : ''}" data-file-row="${esc(file.id)}">
        <button class="side-file-name" type="button" data-file-open="${esc(file.id)}" title="${esc(file.relPath)}">${esc(file.name)}${file.shared ? ' <span class="side-file-shared">共享</span>' : ''}</button>
        <span class="side-file-size">${fmtSize(file.size)}</span>
        <button class="side-file-more" type="button" data-file-more="${esc(file.id)}" title="文件操作" aria-label="文件操作" aria-haspopup="menu">⋯</button>
      </div>`,
    )
    .join('')
  box.innerHTML = folderRows + fileRows
  for (const button of box.querySelectorAll('[data-folder-open]')) {
    button.addEventListener('click', () => setWorkspacePath(button.dataset.folderOpen))
  }
  for (const button of box.querySelectorAll('[data-folder-more]')) {
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      showFolderMenu(button.dataset.folderMore, button.getBoundingClientRect())
    })
  }
  for (const row of box.querySelectorAll('[data-folder-row]')) {
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      showFolderMenu(
        row.dataset.folderRow,
        { left: event.clientX, top: event.clientY, right: event.clientX, bottom: event.clientY },
        true,
      )
    })
  }
  for (const button of box.querySelectorAll('[data-file-open]')) {
    button.addEventListener('click', (event) => {
      if (event.isTrusted) setWorkbenchCollapsed(false)
      openWorkspaceFile(button.dataset.fileOpen, { opener: button })
    })
  }
  for (const button of box.querySelectorAll('[data-file-more]')) {
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      showFileMenu(button.dataset.fileMore, button.getBoundingClientRect())
    })
  }
  for (const row of box.querySelectorAll('[data-file-row]')) {
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      showFileMenu(
        row.dataset.fileRow,
        { left: event.clientX, top: event.clientY, right: event.clientX, bottom: event.clientY },
        true,
      )
    })
  }
  // 文件/文件夹都能整行拖进输入区，只是引用，不会复制文件。
  for (const row of box.querySelectorAll('[data-folder-row]')) {
    row.draggable = true
    row.addEventListener('dragstart', (event) => {
      const path = row.dataset.folderRow
      const meta = workspaceFolderMeta(path)
      startWorkspaceDrag(
        event,
        {
          kind: 'folder',
          path,
          name: meta.name,
          fileCount: meta.fileCount,
          folderCount: meta.folderCount,
        },
        row,
      )
    })
    row.addEventListener('dragend', () => row.classList.remove('is-dragging'))
  }
  for (const row of box.querySelectorAll('[data-file-row]')) {
    row.draggable = true
    row.addEventListener('dragstart', (event) => {
      const file = fileById(row.dataset.fileRow)
      if (!file) return
      startWorkspaceDrag(
        event,
        {
          kind: 'file',
          fileId: file.id,
          path: workspaceFilePath(file),
          relPath: workspaceFilePath(file),
          name: file.name,
          size: file.size,
          mime: file.mime,
          shared: Boolean(file.shared),
        },
        row,
      )
    })
    row.addEventListener('dragend', () => row.classList.remove('is-dragging'))
  }
  syncSideSectionSplit()
}

function fileById(fileId) {
  return state.files.find((file) => file.id === fileId)
}

function hideFileMenu() {
  const menu = $('#file-menu')
  if (!menu) return
  menu.hidden = true
  menu.dataset.file = ''
  menu.dataset.folder = ''
}

function placeFileMenu(menu, anchor, atPoint = false) {
  const menuBox = menu.getBoundingClientRect()
  const left = atPoint
    ? Math.min(anchor.left, window.innerWidth - menuBox.width - 8)
    : Math.min(Math.max(8, anchor.right - menuBox.width), window.innerWidth - menuBox.width - 8)
  const top = atPoint
    ? Math.min(anchor.top, window.innerHeight - menuBox.height - 8)
    : anchor.bottom + 4 + menuBox.height + 8 > window.innerHeight
      ? Math.max(8, anchor.top - menuBox.height - 4)
      : anchor.bottom + 4
  menu.style.left = `${Math.max(8, left)}px`
  menu.style.top = `${Math.max(8, top)}px`
}

function showFileMenu(fileId, anchor, atPoint = false) {
  const menu = $('#file-menu')
  const file = fileById(fileId)
  if (!menu || !file) return
  hideSessionMenu()
  const owner = file.ownerUserId === state.me?.person?.id
  menu.innerHTML = `<div class="session-menu-title">${esc(file.name)}</div>
    ${
      owner
        ? `<button type="button" data-file-act="send-dingtalk">发送到钉钉</button>
           <button type="button" data-file-act="rename">重命名</button>
           <button type="button" data-file-act="edit">编辑</button>
           <button type="button" data-file-act="delete" class="is-danger">删除</button>`
        : `<button type="button" data-file-act="download">下载</button>
           <button type="button" data-file-act="send-dingtalk">发送到钉钉</button>`
    }`
  menu.dataset.file = fileId
  menu.dataset.folder = ''
  menu.hidden = false
  placeFileMenu(menu, anchor, atPoint)
}

function showFolderMenu(folderPath, anchor, atPoint = false) {
  const menu = $('#file-menu')
  const folder = workspaceFolderMeta(folderPath)
  if (!menu || !folder.path) return
  hideSessionMenu()
  const locked = Boolean(folder.shared)
  const lockedHint = locked
    ? '<div class="session-menu-hint">文件夹里有其他成员共享的文件，暂不支持整体重命名或删除。</div>'
    : ''
  menu.innerHTML = `<div class="session-menu-title">${esc(folder.name)}</div>
    <button type="button" data-folder-act="open">打开</button>
    <button type="button" data-folder-act="new">新建子文件夹</button>
    <button type="button" data-folder-act="rename"${locked ? ' disabled title="文件夹含他人共享文件"' : ''}>重命名</button>
    <button type="button" data-folder-act="delete" class="is-danger"${locked ? ' disabled title="文件夹含他人共享文件"' : ''}>删除</button>
    ${lockedHint}`
  menu.dataset.folder = folder.path
  menu.dataset.file = ''
  menu.hidden = false
  placeFileMenu(menu, anchor, atPoint)
}

function workspaceFolderLocationLabel(path) {
  const normalized = workspaceNormalizePath(path)
  return normalized ? `云空间 / ${normalized.split('/').join(' / ')}` : '云空间根目录'
}

function openWorkspaceFolderNameModal({ title, hint, value, confirmLabel, onSubmit }) {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `<div class="modal">
    <div class="modal-head"><h3>${esc(title)}</h3><button class="modal-x" type="button">×</button></div>
    <p class="hint">${esc(hint)}</p>
    <div class="form-grid"><label><span>文件夹名称</span><input id="ws-folder-name-input" value="${esc(
      value || '',
    )}" /></label></div>
    <div class="modal-state" id="ws-folder-name-state"></div>
    <div class="modal-actions"><button class="btn ghost" type="button" id="ws-folder-name-cancel">取消</button><button class="btn primary" type="button" id="ws-folder-name-save">${esc(
      confirmLabel || '保存',
    )}</button></div>
  </div>`
  document.body.appendChild(overlay)
  const close = () => overlay.remove()
  const input = overlay.querySelector('#ws-folder-name-input')
  const stateEl = overlay.querySelector('#ws-folder-name-state')
  const saveButton = overlay.querySelector('#ws-folder-name-save')
  const cancelButton = overlay.querySelector('#ws-folder-name-cancel')
  const closeButton = overlay.querySelector('.modal-x')
  let saving = false
  const setBusy = (busy) => {
    saving = busy
    saveButton.disabled = busy
    cancelButton.disabled = busy
    closeButton.disabled = busy
    input.disabled = busy
  }
  overlay.querySelector('.modal-x').addEventListener('click', close)
  cancelButton.addEventListener('click', close)
  input.focus()
  input.select()
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') saveButton.click()
  })
  saveButton.addEventListener('click', async () => {
    if (saving) return
    const name = String(input.value || '').trim()
    const error = workspaceFolderNameError(name)
    if (error) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = error
      input.focus()
      return
    }
    setBusy(true)
    stateEl.className = 'modal-state muted'
    stateEl.textContent = '正在保存…'
    try {
      await onSubmit(name)
      close()
    } catch (err) {
      setBusy(false)
      stateEl.className = 'modal-state bad'
      stateEl.textContent = err.message || '保存失败'
    }
  })
}

function createWorkspaceFolder(parentPath = state.workspacePath) {
  const parent = workspaceNormalizePath(parentPath)
  openWorkspaceFolderNameModal({
    title: '新建文件夹',
    hint: `创建在「${workspaceFolderLocationLabel(parent)}」。空文件夹会保留在云空间列表里。`,
    value: '新建文件夹',
    confirmLabel: '创建',
    onSubmit: async (name) => {
      const folderPath = workspaceFolderPathJoin(parent, name)
      await api(`/api/workspace/folders${qs()}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: folderPath }),
      })
      await loadWorkspaceFiles()
      banner(`文件夹「${name}」已创建`, 'ok')
    },
  })
}

function syncWorkspacePreviewAfterFolderRename(oldPath, nextPath) {
  const preview = state.filePreview
  if (!preview) return
  const relPath = workspaceFilePath(preview)
  if (!relPath.startsWith(`${oldPath}/`)) return
  const updated = fileById(preview.id)
  if (!updated) return
  state.filePreview = { ...preview, ...updated }
  const meta = [
    fmtSize(updated.size),
    `更新于 ${workspaceFileDate(updated.updatedAt)}`,
    updated.shared ? '共享文件' : '个人文件',
    updated.relPath,
  ]
  const box = $('#file-pane-meta')
  if (box) box.textContent = meta.filter(Boolean).join(' · ')
  const suffix = relPath.slice(oldPath.length)
  const nextRel = `${nextPath}${suffix}`
  if (state.filePreview.relPath !== nextRel) state.filePreview.relPath = nextRel
}

function renameWorkspaceFolder(folderPath) {
  const folder = workspaceFolderMeta(folderPath)
  if (!folder.path) return
  if (folder.shared) {
    banner('文件夹里有其他成员共享的文件，暂不支持整体重命名', 'warn')
    return
  }
  openWorkspaceFolderNameModal({
    title: '重命名文件夹',
    hint: `把「${folder.name}」改名，文件夹里的文件和子文件夹会一起移到新名称下。`,
    value: folder.name,
    confirmLabel: '保存',
    onSubmit: async (name) => {
      if (name === folder.name) return
      const result = await api(`/api/workspace/folders${qs()}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: folder.path, newName: name }),
      })
      const nextPath = workspaceNormalizePath(result?.folderPath || result?.to || folder.path)
      const currentPath = state.workspacePath
      if (currentPath === folder.path || currentPath.startsWith(`${folder.path}/`)) {
        state.workspacePath = `${nextPath}${currentPath.slice(folder.path.length)}`
      }
      await loadWorkspaceFiles()
      syncWorkspacePreviewAfterFolderRename(folder.path, nextPath)
      banner('文件夹已重命名', 'ok')
    },
  })
}

function deleteWorkspaceFolder(folderPath) {
  const folder = workspaceFolderMeta(folderPath)
  if (!folder.path) return
  if (folder.shared) {
    banner('文件夹里有其他成员共享的文件，暂不支持整体删除', 'warn')
    return
  }
  const count = Math.max(0, Number(folder.fileCount) || 0)
  const childFolderCount = Math.max(0, Number(folder.folderCount) || 0)
  const deleteHint = count
    ? `「${esc(folder.path)}」里的 ${count} 个文件会移到回收区，文件夹本身从云空间列表移除。此操作不可撤销，但回收区会按保留策略保留。`
    : childFolderCount
      ? `「${esc(folder.path)}」及其 ${childFolderCount} 个子文件夹会从云空间列表移除，空目录不会保留。`
      : `「${esc(folder.path)}」是空文件夹，会从云空间列表移除。此操作不可撤销。`
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `<div class="modal">
    <div class="modal-head"><h3>删除文件夹</h3><button class="modal-x" type="button">×</button></div>
    <p class="hint">${deleteHint}</p>
    <div class="install-progress" id="ws-folder-delete-progress" hidden role="progressbar" aria-label="删除文件夹进度" aria-live="polite">
      <div class="install-progress-track"><span class="install-progress-bar"></span></div>
      <div class="install-progress-meta"><span id="ws-folder-delete-progress-text">正在删除文件夹…</span><span id="ws-folder-delete-progress-time" class="mono">0s</span></div>
    </div>
    <div class="modal-state" id="ws-folder-delete-state"></div>
    <div class="modal-actions"><button class="btn ghost" type="button" id="ws-folder-delete-cancel">取消</button><button class="btn danger" type="button" id="ws-folder-delete-confirm">删除文件夹</button></div>
  </div>`
  document.body.appendChild(overlay)
  const stateEl = overlay.querySelector('#ws-folder-delete-state')
  const progressEl = overlay.querySelector('#ws-folder-delete-progress')
  const progressText = overlay.querySelector('#ws-folder-delete-progress-text')
  const progressTime = overlay.querySelector('#ws-folder-delete-progress-time')
  const confirmBtn = overlay.querySelector('#ws-folder-delete-confirm')
  const cancelBtn = overlay.querySelector('#ws-folder-delete-cancel')
  const closeBtn = overlay.querySelector('.modal-x')
  let progressTimer = null
  let progressStartedAt = 0
  const stopProgress = () => {
    if (progressTimer) clearInterval(progressTimer)
    progressTimer = null
  }
  const close = () => {
    stopProgress()
    overlay.remove()
  }
  const setBusy = (busy) => {
    confirmBtn.disabled = busy
    cancelBtn.disabled = busy
    closeBtn.disabled = busy
  }
  const startProgress = () => {
    progressEl.hidden = false
    progressEl.classList.remove('is-done')
    progressText.textContent = '正在删除文件夹…'
    progressTime.textContent = '0s'
    progressStartedAt = Date.now()
    stopProgress()
    progressTimer = setInterval(() => {
      progressTime.textContent = `${Math.max(0, Math.floor((Date.now() - progressStartedAt) / 1000))}s`
    }, 1000)
  }
  const finishProgress = (text) => {
    stopProgress()
    progressEl.hidden = false
    progressEl.classList.add('is-done')
    progressText.textContent = text
    progressTime.textContent = '完成'
  }
  closeBtn.addEventListener('click', close)
  cancelBtn.addEventListener('click', close)
  confirmBtn.addEventListener('click', async () => {
    if (confirmBtn.disabled) return
    setBusy(true)
    stateEl.className = 'modal-state muted'
    stateEl.textContent = ''
    startProgress()
    try {
      const result = await api(`/api/workspace/folders${qs()}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: folder.path }),
      })
      const deletedCount = Math.max(0, Number(result?.fileCount ?? count) || 0)
      finishProgress('已移入回收区')
      if (state.workspacePath === folder.path || state.workspacePath.startsWith(`${folder.path}/`)) {
        const slash = folder.path.lastIndexOf('/')
        state.workspacePath = slash < 0 ? '' : folder.path.slice(0, slash)
      }
      close()
      if (
        state.filePreview &&
        workspaceFilePath(state.filePreview).startsWith(`${folder.path}/`)
      ) {
        closeWorkspaceFile()
      }
      await loadWorkspaceFiles()
      banner(
        deletedCount
          ? `文件夹已删除，${deletedCount} 个文件已移到回收区`
          : childFolderCount
            ? '文件夹及其空子文件夹已删除'
            : '空文件夹已删除',
        'ok',
      )
    } catch (err) {
      stopProgress()
      progressEl.hidden = true
      setBusy(false)
      stateEl.className = 'modal-state bad'
      stateEl.textContent = err.message || '删除文件夹失败'
    }
  })
}

async function renameWorkspaceFile(file) {  if (!file) return
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `<div class="modal">
    <div class="modal-head"><h3>重命名文件</h3><button class="modal-x" type="button">×</button></div>
    <p class="hint">只改文件名；同名文件已存在时会提示。</p>
    <div class="form-grid"><label><span>文件名</span><input id="ws-rename-input" value="${esc(
      file.name,
    )}" /></label></div>
    <div class="modal-state" id="ws-rename-state"></div>
    <div class="modal-actions"><button class="btn ghost" type="button" id="ws-rename-cancel">取消</button><button class="btn primary" type="button" id="ws-rename-save">保存</button></div>
  </div>`
  document.body.appendChild(overlay)
  const close = () => overlay.remove()
  const input = overlay.querySelector('#ws-rename-input')
  const stateEl = overlay.querySelector('#ws-rename-state')
  overlay.querySelector('.modal-x').addEventListener('click', close)
  overlay.querySelector('#ws-rename-cancel').addEventListener('click', close)
  input.focus()
  input.select()
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') overlay.querySelector('#ws-rename-save').click()
  })
  overlay.querySelector('#ws-rename-save').addEventListener('click', async () => {
    const next = String(input.value || '')
      .trim()
      .split(/[\\/]+/)
      .filter(Boolean)
      .pop() || ''
    if (!next) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = '文件名不能为空'
      return
    }
    if (next === file.name) {
      close()
      return
    }
    const parent = workspaceFileParentPath(file)
    const nextRelPath = parent ? `${parent}/${next}` : next
    stateEl.className = 'modal-state muted'
    stateEl.textContent = '正在保存…'
    try {
      await api(`/api/workspace/files/${encodeURIComponent(file.id)}${qs()}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ relPath: nextRelPath }),
      })
      close()
      await loadWorkspaceFiles()
      if (state.filePreview?.id === file.id) await openWorkspaceFile(file.id)
      banner('文件已重命名', 'ok')
    } catch (err) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = err.message || '重命名失败'
    }
  })
}

async function editWorkspaceFile(file) {
  if (!file) return
  if (!isTextLike(file)) {
    banner('这个文件类型不支持在线编辑，请下载后编辑。', 'bad')
    return
  }
  if (Number(file.size) > 5 * 1024 * 1024) {
    banner('文本文件超过 5 MB，请下载后编辑。', 'bad')
    return
  }
  await openWorkspaceFile(file.id)
  if (state.filePreview?.id === file.id && workspacePreviewTextLoaded) beginWorkspaceEdit()
}

function deleteWorkspaceFile(file, fromPreview = false) {
  if (!file) return
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `<div class="modal">
    <div class="modal-head"><h3>删除文件</h3><button class="modal-x" type="button">×</button></div>
    <p class="hint">「${esc(file.name)}」会移到回收区并保留元数据，后台按回收区保留天数自动物理清理；设为 0 时永久保留。</p>
    <div class="install-progress" id="ws-delete-progress" hidden role="progressbar" aria-label="删除进度" aria-live="polite">
      <div class="install-progress-track"><span class="install-progress-bar"></span></div>
      <div class="install-progress-meta"><span id="ws-delete-progress-text">正在删除…</span><span id="ws-delete-progress-time" class="mono">0s</span></div>
    </div>
    <div class="modal-state" id="ws-delete-state"></div>
    <div class="modal-actions"><button class="btn ghost" type="button" id="ws-delete-cancel">取消</button><button class="btn danger" type="button" id="ws-delete-confirm">删除</button></div>
  </div>`
  document.body.appendChild(overlay)
  const stateEl = overlay.querySelector('#ws-delete-state')
  const progressEl = overlay.querySelector('#ws-delete-progress')
  const progressText = overlay.querySelector('#ws-delete-progress-text')
  const progressTime = overlay.querySelector('#ws-delete-progress-time')
  const confirmBtn = overlay.querySelector('#ws-delete-confirm')
  const cancelBtn = overlay.querySelector('#ws-delete-cancel')
  const closeBtn = overlay.querySelector('.modal-x')
  let progressTimer = null
  let progressStartedAt = 0
  const stopProgress = () => {
    if (progressTimer) clearInterval(progressTimer)
    progressTimer = null
  }
  const close = () => {
    stopProgress()
    overlay.remove()
  }
  const setBusy = (busy) => {
    confirmBtn.disabled = busy
    cancelBtn.disabled = busy
    closeBtn.disabled = busy
  }
  const startProgress = (text) => {
    progressEl.hidden = false
    progressEl.classList.remove('is-done')
    progressText.textContent = text
    progressTime.textContent = '0s'
    progressStartedAt = Date.now()
    stopProgress()
    progressTimer = setInterval(() => {
      progressTime.textContent = `${Math.max(0, Math.floor((Date.now() - progressStartedAt) / 1000))}s`
    }, 1000)
  }
  const finishProgress = (text) => {
    stopProgress()
    progressEl.hidden = false
    progressEl.classList.add('is-done')
    progressText.textContent = text
    progressTime.textContent = '完成'
  }
  closeBtn.addEventListener('click', close)
  cancelBtn.addEventListener('click', close)
  confirmBtn.addEventListener('click', async () => {
    if (confirmBtn.disabled) return
    setBusy(true)
    stateEl.className = 'modal-state muted'
    stateEl.textContent = ''
    startProgress('正在删除…')
    try {
      await api(`/api/workspace/files/${encodeURIComponent(file.id)}${qs()}`, { method: 'DELETE' })
      finishProgress('已移入回收区')
      setBusy(false)
      await new Promise((resolve) => setTimeout(resolve, 240))
      close()
      if (fromPreview && state.filePreview?.id === file.id) closeWorkspaceFile()
      await loadWorkspaceFiles()
      banner('文件已移到回收区', 'ok')
    } catch (err) {
      stopProgress()
      progressEl.hidden = true
      setBusy(false)
      stateEl.className = 'modal-state bad'
      stateEl.textContent = err.message || '删除失败'
    }
  })
}

async function sendWorkspaceFileToDingTalk(file) {
  if (!file) return
  const button = $('#file-pane-send-dingtalk')
  const oldText = button ? button.textContent : ''
  if (button) {
    button.disabled = true
    button.textContent = '发送中…'
  }
  try {
    const sent = await api(`/api/workspace/files/${encodeURIComponent(file.id)}/send-dingtalk${qs()}`, {
      method: 'POST',
    })
    banner(`已发送到钉钉：${sent.fileName}`, 'ok')
  } catch (err) {
    banner(err.message || '发送到钉钉失败', 'bad')
  } finally {
    if (button) {
      button.disabled = false
      button.textContent = oldText || '发送到钉钉'
    }
  }
}

/* ---------------- 多 Agent 运行台 ---------------- */

function agentStatusText(status) {
  if (status === 'waiting') return '等待主 Agent 回答'
  if (status === 'done') return '已完成 · 待命'
  if (status === 'failed') return '失败'
  if (status === 'cancelled') return '已取消'
  return '运行中'
}

function agentStatusClass(status) {
  if (status === 'waiting') return 'is-waiting'
  if (status === 'done') return 'is-done'
  if (status === 'failed') return 'is-failed'
  if (status === 'cancelled') return 'is-cancelled'
  return 'is-running'
}

function clampProgressPercent(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, Math.round(n)))
}

/** 团队整体完成度：只统计已进入终态的子 Agent；运行/等待都算未完成。 */
function agentTeamProgress(runs) {
  const list = Array.isArray(runs) ? runs : []
  const total = list.length
  const completed = list.filter((run) => run?.status === 'done').length
  const failed = list.filter((run) => run?.status === 'failed' || run?.status === 'cancelled').length
  const done = completed + failed
  const active = list.filter((run) => (run?.status || 'running') === 'running').length
  const waiting = list.filter((run) => run?.status === 'waiting').length
  const remaining = Math.max(0, total - done - active - waiting)
  return {
    total,
    completed,
    failed,
    done,
    remaining,
    active,
    waiting,
    percent: total > 0 ? clampProgressPercent((done / total) * 100) : 0,
    label: total > 0 ? (failed > 0 ? `已结束 ${done} / ${total}` : `已完成 ${completed} / ${total}`) : '等待派发',
    detail: failed > 0
      ? `成功 ${completed} · 失败 ${failed} · 待汇总 ${remaining}`
      : `已完成 ${completed} · 进行中 ${active + waiting} · 待汇总 ${remaining}`,
    state: total > 0 && done === total ? (failed > 0 ? '已结束' : '已完成') : waiting > 0 ? '等待回复' : '进行中',
    tone: total > 0 && done === total ? (failed > 0 ? 'is-failed' : 'is-complete') : failed > 0 ? 'is-failed' : waiting > 0 ? 'is-waiting' : 'is-running',
  }
}

/** 后端进度消息带的是计数快照，团队面板带的是实时 run；统一成同一个形状再渲染。 */
function normalizeTeamProgress(input) {
  if (!input || typeof input !== 'object') return null
  const completed = Math.max(0, Number(input.completed) || 0)
  const failed = Math.max(0, Number(input.failed) || 0)
  const explicitTotal = Math.max(0, Number(input.total) || 0)
  const remaining = Math.max(0, Number(input.remaining) || 0)
  const active = Math.max(0, Number(input.active) || 0)
  const waiting = Math.max(0, Number(input.waiting) || 0)
  const total = explicitTotal || completed + remaining
  if (total <= 0) return null
  // 成功和失败必须互斥：历史快照可能把同一个岗位的两次尝试分别计入，
  // 先按失败优先裁剪，再算完成数，避免出现“总数 1、成功 1、失败 1”。
  const failedCount = Math.min(total, failed)
  const completedCount = Math.min(total - failedCount, completed)
  const done = completedCount + failedCount
  const activeCount = Math.min(total - done, active)
  const waitingCount = Math.min(total - done - activeCount, waiting)
  // “待汇总”只指还没进入运行/等待的排队任务；进行中、等待回复各自单列，
  // 否则 total=1 + active=1 会同时显示“进行中 1”和“待汇总 1”。
  const left = Math.max(0, total - done - activeCount - waitingCount)
  const rawState = String(input.state || '').trim()
  const stateText = rawState === 'completed'
    ? '已完成'
    : rawState === 'waiting'
      ? '等待回复'
      : rawState === 'watching'
        ? '待汇总'
        : rawState === 'running'
          ? '进行中'
          : rawState
  const label = activeCount > 0 && done <= 0
    ? `进行中 ${activeCount} / ${total}`
    : done <= 0
      ? `已派发 ${total} 个`
      : activeCount > 0
        ? `已结束 ${done} / ${total} · ${activeCount} 进行中`
        : failedCount > 0
          ? `已结束 ${done} / ${total}`
          : `已完成 ${done} / ${total}`
  const detailParts = [`成功 ${completedCount}`, `失败 ${failedCount}`]
  if (activeCount > 0) detailParts.push(`进行中 ${activeCount}`)
  if (waitingCount > 0) detailParts.push(`等待回复 ${waitingCount}`)
  if (left > 0) detailParts.push(`待汇总 ${left}`)
  return {
    total,
    completed: completedCount,
    failed: failedCount,
    done,
    remaining: left,
    active: activeCount,
    waiting: waitingCount,
    percent: clampProgressPercent((done / total) * 100),
    label,
    detail: detailParts.join(' · '),
    state: done >= total && failedCount > 0
      ? '已结束'
      : stateText || (done >= total ? '已完成' : waitingCount > 0 ? '等待回复' : '进行中'),
    tone: done >= total
      ? (failedCount > 0 ? 'is-failed' : 'is-complete')
      : failedCount > 0
        ? 'is-failed'
        : waitingCount > 0
          ? 'is-waiting'
          : 'is-running',
    note: String(input.note || '').trim(),
    parentRunId: String(input.parentRunId || input.runId || '').trim(),
  }
}

function teamProgressCardHtml(progressInput, note = '') {
  const progress = normalizeTeamProgress(progressInput)
  if (!progress) return ''
  const runKey = esc(progress.parentRunId)
  let noteText = String(note || progress.note || '').trim()
  const finished = progress.total > 0 && progress.completed + progress.failed >= progress.total
  if (finished && noteText && !/最终汇总已生成|汇总已生成/.test(noteText)) {
    noteText = progress.failed > 0
      ? `全部子 Agent 已结束：成功 ${progress.completed} · 失败 ${progress.failed}，等待主 Agent 汇总。`
      : '全部子 Agent 已完成。'
  }
  if (!noteText) {
    noteText = progress.state === '进行中'
      ? `子 Agent 并行工作中 · ${progress.active} 个进行中，${progress.remaining} 个待汇总。`
      : progress.state === '等待回复'
        ? `${progress.waiting} 个子 Agent 正在等待回复。`
        : progress.state === '已结束' || progress.failed > 0
          ? `子 Agent 已结束：成功 ${progress.completed} · 失败 ${progress.failed}，等待主 Agent 汇总。`
          : '全部子 Agent 已完成。'
  }
  return `<div class="team-progress-card ${progress.tone}" data-team-progress data-team-progress-run="${runKey}"
    data-team-progress-total="${progress.total}" data-team-progress-completed="${progress.completed}"
    data-team-progress-failed="${progress.failed}" data-team-progress-active="${progress.active}"
    data-team-progress-waiting="${progress.waiting}" data-team-progress-state="${esc(progress.state)}">
    <div class="team-progress-head">
      <span class="team-progress-kicker">子 AGENT 进度</span>
      <span class="team-progress-count" data-team-progress-count>${esc(progress.label)}</span>
    </div>
    <div class="team-progress-track" role="progressbar" aria-label="子 Agent 完成进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress.percent}" data-team-progress-track>
      <span class="team-progress-fill" data-team-progress-fill style="width:${progress.percent}%"></span>
    </div>
    <div class="team-progress-foot">
      <span data-team-progress-label>${esc(progress.detail)}</span>
      <span class="team-progress-state" data-team-progress-state>${esc(progress.state)}</span>
    </div>
    ${noteText ? `<div class="team-progress-note" data-team-progress-note>${esc(oneLinePreview(noteText, 180))}</div>` : ''}
  </div>`
}

function applyTeamProgressCard(card, progress) {
  if (!card || !progress) return
  const tone = ['is-running', 'is-waiting', 'is-complete', 'is-failed', 'is-cancelled'].find((name) => progress.tone === name) || 'is-running'
  card.classList.remove('is-running', 'is-waiting', 'is-complete', 'is-failed', 'is-cancelled')
  card.classList.add(tone)
  card.dataset.teamProgressTotal = String(progress.total)
  card.dataset.teamProgressCompleted = String(progress.completed)
  card.dataset.teamProgressFailed = String(progress.failed)
  card.dataset.teamProgressActive = String(progress.active)
  card.dataset.teamProgressWaiting = String(progress.waiting)
  card.dataset.teamProgressState = progress.state
  if (progress.parentRunId) card.setAttribute('data-team-progress-run', progress.parentRunId)
  const fill = card.querySelector('[data-team-progress-fill]')
  const track = card.querySelector('[data-team-progress-track]')
  const count = card.querySelector('[data-team-progress-count]')
  const label = card.querySelector('[data-team-progress-label]')
  const state = card.querySelector('[data-team-progress-state]')
  const note = card.querySelector('[data-team-progress-note]')
  if (fill) fill.style.width = `${progress.percent}%`
  if (track) track.setAttribute('aria-valuenow', String(progress.percent))
  if (count) count.textContent = progress.label
  if (label) label.textContent = progress.detail
  if (state) state.textContent = progress.state
  if (note) {
    const fallbackNote = progress.state === '已完成'
      ? '全部子 Agent 已完成。'
      : progress.state === '等待回复'
        ? `${progress.waiting} 个子 Agent 正在等待回复。`
        : progress.state === '进行中'
          ? `子 Agent 并行工作中 · ${progress.active} 个进行中，${progress.remaining} 个待汇总。`
          : `子 Agent 已结束 · 已结束 ${progress.done} / ${progress.total}，等待主 Agent 汇总。`
    note.textContent = oneLinePreview(progress.note || fallbackNote, 180)
  }
}

/** 进度气泡和团队面板共享同一份实时 run；当前父运行中的进度卡随团队状态一起刷新。 */
function mergeTeamProgressCounts(previous, current) {
  const cardTotal = Math.max(0, Number(previous?.total) || 0)
  const cardCompleted = Math.max(0, Number(previous?.completed) || 0)
  const cardFailed = Math.max(0, Number(previous?.failed) || 0)
  const currentTotal = Math.max(0, Number(current?.total) || 0)
  const currentCompleted = Math.max(0, Number(current?.completed) || 0)
  const currentFailed = Math.max(0, Number(current?.failed) || 0)
  const currentActive = Math.max(0, Number(current?.active) || 0)
  const currentWaiting = Math.max(0, Number(current?.waiting) || 0)
  const total = Math.max(cardTotal, currentTotal)
  if (total <= 0) return null

  // 新快照只要还有可读计数，就以它为准；旧卡的累计只用于避免岗位退休后
  // 总数倒退。不能把旧快照的成功数和最新快照的失败数相加，那是两次尝试。
  const snapshotHasCounts = currentCompleted + currentFailed + currentActive + currentWaiting > 0
  const useSnapshot = snapshotHasCounts && (currentTotal >= cardTotal || currentActive > 0 || currentWaiting > 0)
  let completed = useSnapshot ? currentCompleted : Math.max(cardCompleted, currentCompleted)
  let failed = useSnapshot ? currentFailed : Math.max(cardFailed, currentFailed)
  let active = currentActive
  let waiting = currentWaiting

  // 成功、失败、进行中、等待回复互斥，且总和不能超过总数。
  failed = Math.min(total, failed)
  completed = Math.min(total - failed, completed)
  active = Math.min(total - completed - failed, active)
  waiting = Math.min(total - completed - failed - active, waiting)

  const done = completed + failed
  const remaining = Math.max(0, total - done - active - waiting)
  const state = active > 0
    ? '进行中'
    : waiting > 0
      ? '等待回复'
      : done >= total
        ? (failed > 0 ? '已结束' : '已完成')
        : '待汇总'
  const label = active > 0 && done <= 0
    ? `进行中 ${active} / ${total}`
    : done <= 0
      ? `已派发 ${total} 个`
      : active > 0
        ? `已结束 ${done} / ${total} · ${active} 进行中`
        : failed > 0
          ? `已结束 ${done} / ${total}`
          : `已完成 ${done} / ${total}`
  const detailParts = [`成功 ${completed}`, `失败 ${failed}`]
  if (active > 0) detailParts.push(`进行中 ${active}`)
  if (waiting > 0) detailParts.push(`等待回复 ${waiting}`)
  if (remaining > 0) detailParts.push(`待汇总 ${remaining}`)
  return {
    total,
    completed,
    failed,
    done,
    remaining,
    active,
    waiting,
    percent: total > 0 ? clampProgressPercent((done / total) * 100) : 0,
    label,
    detail: detailParts.join(' · '),
    state,
    tone: failed > 0
      ? 'is-failed'
      : active > 0
        ? 'is-running'
        : waiting > 0
          ? 'is-waiting'
          : 'is-complete',
  }
}

function syncTeamProgressBubbles(runs) {
  const parentRunId = String(state.agentParentRunId || '')
  if (!parentRunId) return
  const progress = agentTeamProgress(runs)
  if (!progress.total) return
  const cards = document.querySelectorAll('.team-progress-card[data-team-progress-run]')
  for (const card of cards) {
    const runKey = String(card.getAttribute('data-team-progress-run') || '')
    if (runKey && runKey !== parentRunId) continue
    if (!runKey && cards.length > 1) continue
    // 已完成的员工到 2 分钟会从团队栏注销，实时 run 的总数会变小；
    // 进度卡不能因此从 4/4 退回 2/2，必须保留已经写入的累计口径。
    const merged = mergeTeamProgressCounts({
      total: Math.max(0, Number(card.dataset.teamProgressTotal) || 0),
      completed: Math.max(0, Number(card.dataset.teamProgressCompleted) || 0),
      failed: Math.max(0, Number(card.dataset.teamProgressFailed) || 0),
    }, progress)
    if (!merged) continue
    applyTeamProgressCard(card, { ...merged, parentRunId })
  }
}


/** 子 Agent 完成、且这么久没有新任务，就从团队栏注销（执行资源早已释放）。 */
const AGENT_TEAM_IDLE_MS = 120000
/** 用户刚手动点过员工后，短时间内不让新派发/提问抢走右侧焦点。 */
const AGENT_USER_SELECTION_HOLD_MS = 5000

let workbenchLayoutSignature = ''

function workbenchLayoutStateSignature() {
  return [
    state.mode,
    state.agentRuns.size,
    Boolean(state.filePreview),
    Boolean(state.permOpen),
    state.workbenchCollapsed ? '1' : '0',
    state.workbenchSplit ? '1' : '0',
    state.workbenchTab,
    state.permRequests.todo.length,
  ].join('|')
}

function syncWorkbenchLayout() {
  const rail = $('#workbench-rail')
  const teamPane = $('#team-pane')
  const filePane = $('#file-pane')
  const permPane = $('#perm-pane')
  const main = $('.chat-main')
  if (!rail || !teamPane || !filePane || !permPane || !main) return
  const signature = workbenchLayoutStateSignature()
  if (signature === workbenchLayoutSignature) return
  workbenchLayoutSignature = signature

  const inChat = state.mode === 'chat'
  const hasTeam = inChat && state.agentRuns.size > 0
  // 工作台整页预览也复用同一个文件栏；只看对话模式会把它藏掉，导致 PDF/Office 预览只剩 DOM。
  const hasFile = Boolean(state.filePreview)
  const hasPerm = inChat && state.permOpen
  const hasWorkbench = hasTeam || hasFile || hasPerm
  rail.hidden = !hasWorkbench
  const collapsed = hasWorkbench && state.workbenchCollapsed
  rail.classList.toggle('is-collapsed', collapsed)

  // 当前面板没有内容时自动切到另一个，避免打开一个空白面板。
  const tabAvailable = (name) => (name === 'team' ? hasTeam : name === 'file' ? hasFile : hasPerm)
  if (state.workbenchSplit && !(hasTeam && hasFile)) state.workbenchSplit = false
  if (!tabAvailable(state.workbenchTab)) {
    state.workbenchTab = hasTeam ? 'team' : hasFile ? 'file' : hasPerm ? 'perm' : state.workbenchTab
  }

  const showTeam = hasTeam && (state.workbenchSplit || state.workbenchTab === 'team')
  const showFile = hasFile && (state.workbenchSplit || state.workbenchTab === 'file')
  const showPerm = hasPerm && !state.workbenchSplit && state.workbenchTab === 'perm'
  teamPane.hidden = !showTeam
  filePane.hidden = !showFile
  permPane.hidden = !showPerm
  $('#workbench-body')?.classList.toggle('is-split', state.workbenchSplit && showTeam && showFile)

  const tabs = $('#workbench-tabs')
  if (tabs) {
    tabs.hidden = !hasWorkbench
    tabs.querySelectorAll('[data-workbench-tab]').forEach((tab) => {
      const name = tab.getAttribute('data-workbench-tab')
      const available = tabAvailable(name)
      tab.hidden = !available
      const selected = state.workbenchSplit || state.workbenchTab === name
      tab.classList.toggle('is-active', selected)
      tab.setAttribute('aria-selected', selected ? 'true' : 'false')
    })
    const count = $('#workbench-team-count')
    if (count) {
      const total = state.agentRuns.size
      count.hidden = total === 0
      count.textContent = String(total)
    }
    const permCount = $('#workbench-perm-count')
    if (permCount) {
      const total = state.permRequests.todo.length
      permCount.hidden = total === 0
      permCount.textContent = String(total)
    }
    const split = $('#workbench-split')
    if (split) {
      split.hidden = !(hasTeam && hasFile)
      split.classList.toggle('is-active', state.workbenchSplit)
      split.setAttribute('aria-pressed', state.workbenchSplit ? 'true' : 'false')
    }
    const collapse = $('#workbench-collapse')
    if (collapse) {
      collapse.hidden = !hasWorkbench
      collapse.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
      collapse.title = collapsed ? '展开右侧工作台' : '收起右侧工作台'
      collapse.setAttribute('aria-label', collapse.title)
    }
    const close = $('#workbench-close')
    if (close) close.hidden = !showPerm
  }

  const restore = $('#workbench-restore')
  if (restore) {
    restore.hidden = !collapsed
    restore.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
    const restoreLabel = $('#workbench-restore-label')
    if (restoreLabel) restoreLabel.textContent = hasTeam ? '团队' : hasFile ? '文件' : '权限'
    const restoreCount = $('#workbench-restore-count')
    if (restoreCount) {
      const total = hasTeam ? state.agentRuns.size : hasPerm ? state.permRequests.todo.length : 0
      restoreCount.hidden = total === 0
      restoreCount.textContent = String(total)
    }
  }

  if (inChat) main.classList.toggle('is-split-preview', !rail.hidden)
  else main.classList.remove('is-split-preview')
  // 右栏（团队或文件）出现时就是可拖拽分栏，鼠标拖分界线即可改两边宽度。
  main.classList.toggle('is-workbench-open', !rail.hidden)
  main.classList.toggle('is-workbench-collapsed', collapsed)
  main.classList.toggle('is-team-only', !rail.hidden && hasTeam && !hasFile)
  main.classList.toggle('is-team-file', !rail.hidden && hasTeam && hasFile)
  main.classList.toggle('is-perm-only', !rail.hidden && hasPerm && !hasTeam && !hasFile)
  const resizer = $('#file-split-resizer')
  if (resizer) resizer.hidden = !(inChat && !rail.hidden && !collapsed)
  // 从文件 / 权限页切回团队，或展开右栏后，容器尺寸才真正可用；
  // 这时再还原一次滚动位置，避免隐藏期间 clientHeight=0 把贴底状态算丢。
  if (showTeam && state.agentSelectedId) {
    requestAnimationFrame(() => {
      if (state.agentSelectedId) restoreAgentThreadScroll(state.agentSelectedId)
    })
  }
}

function setWorkbenchCollapsed(collapsed, options = {}) {
  const next = Boolean(collapsed)
  if (state.workbenchCollapsed === next) return
  state.workbenchCollapsed = next
  if (options.persist !== false) {
    try {
      localStorage.setItem(WORKBENCH_COLLAPSED_KEY, next ? '1' : '0')
    } catch {
      /* 本地存储不可用时只影响记忆，不影响本次折叠 */
    }
  }
  syncWorkbenchLayout()
}

/* ---------------- 权限审批面板 ---------------- */

const PERM_STATUS_TEXT = {
  pending: '审批中',
  approved: '已通过',
  rejected: '已拒绝',
  cancelled: '已撤回',
  expired: '已超时',
}

const PERM_STEP_TEXT = {
  pending: '待处理',
  active: '待审批',
  approved: '已同意',
  rejected: '已拒绝',
  skipped: '已跳过',
  expired: '已超时',
}

function permTime(value) {
  const time = Number(value)
  if (!Number.isFinite(time) || time <= 0) return '—'
  return new Date(time).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function permStatusHtml(status) {
  const key = String(status || '')
  return `<span class="perm-status is-${esc(key)}">${esc(PERM_STATUS_TEXT[key] || key)}</span>`
}

function permScopeOf(code) {
  return (state.permConfig?.scopes || []).find((scope) => scope.code === code)
    || (state.permConfig?.currentScopes || []).find((scope) => scope.code === code)
    || null
}

function permScopeLabel(code) {
  return permScopeOf(code)?.label || code
}

function permPolicyText(policy) {
  if (!policy) return '暂不可申请'
  return `${policy.isDefault ? '默认审批链：' : ''}审批链最多 ${policy.maxLevels} 级，${policy.includeCompanyAdmin ? '公司管理员兜底' : '不兜底'}，${policy.timeoutHours} 小时内处理`
}

function permRoleEntries() {
  const configured = Array.isArray(state.permConfig?.currentRoles) ? state.permConfig.currentRoles : []
  if (configured.length) {
    return configured
      .map((role) => {
        const code = String(role?.code || '').trim()
        if (!code) return null
        return { code, name: role?.name || ROLE_LABEL[code] || code, policy: role?.policy || null }
      })
      .filter(Boolean)
  }
  const roles = Array.isArray(state.me?.roles) ? state.me.roles : []
  return roles
    .map((role) => {
      if (typeof role === 'string') return { code: role, name: ROLE_LABEL[role] || role }
      const code = String(role?.code || role?.roleCode || '').trim()
      if (!code) return null
      return { code, name: role?.name || role?.roleName || ROLE_LABEL[code] || code }
    })
    .filter(Boolean)
}

function permSelectedScopes() {
  const selected = new Set(state.permScopeCodes || [])
  return (state.permConfig?.scopes || []).filter((scope) => selected.has(scope.code))
}

/** 审批路径：角色级策略优先，否则按所选权限里最严格的一条策略展示。 */
function permPathInnerHtml() {
  const selected = permSelectedScopes()
  const role = permRoleEntries().find((item) => item.code === state.permRoleCode)
    || permRoleEntries()[0]
  if (!selected.length) {
    return '<div class="perm-path-empty">勾选权限后，这里会显示需要经过的审批节点。</div>'
  }
  const rolePolicy = role?.policy || null
  const policies = rolePolicy ? [rolePolicy] : selected.map((scope) => scope.policy).filter(Boolean)
  if (!policies.length) {
    return '<div class="perm-path-empty">所选权限还没有配置审批策略，暂时无法提交。</div>'
  }
  const maxLevels = Math.max(...policies.map((policy) => Number(policy.maxLevels) || 1))
  const includeCompanyAdmin = policies.some((policy) => policy.includeCompanyAdmin)
  const fixed = policies.some((policy) => policy.approverStrategy === 'fixed_users')
  const hasDefault = policies.some((policy) => policy.isDefault === true)
  const nodes = [{ label: '提交申请', tone: 'start' }]
  for (let level = 1; level <= Math.min(3, maxLevels); level += 1) {
    nodes.push({
      label: level === 1 ? (fixed ? '指定审批人' : '部门负责人') : `第 ${level} 级审批`,
      tone: 'approval',
    })
  }
  if (includeCompanyAdmin && maxLevels < 3) nodes.push({ label: '公司管理员兜底', tone: 'approval' })
  nodes.push({ label: '仅本人生效', tone: 'end' })
  return `<div class="perm-path">
    ${nodes.map((node, index) => `${index ? '<i class="perm-path-arrow" aria-hidden="true">→</i>' : ''}<span class="perm-path-node is-${node.tone}">${esc(node.label)}</span>`).join('')}
  </div>
  <div class="perm-path-meta">
    <span data-perm-path-role>身份：${esc(role?.name || '未识别角色')}</span>
    <span>${rolePolicy ? '按申请角色的审批策略执行' : hasDefault ? '按所选权限中最严格的一条执行，未单独配置的走默认链' : '按所选权限中最严格的一条执行'} · 最多 ${maxLevels} 级</span>
  </div>`
}

function permApplyHtml() {
  const scopes = state.permConfig?.scopes || []
  const current = state.permConfig?.currentScopes || []
  const roles = permRoleEntries()
  if (!state.permRoleCode || !roles.some((item) => item.code === state.permRoleCode)) {
    state.permRoleCode = roles[0]?.code || ''
  }
  const currentChips = current.map((scope) => `<span class="perm-chip${scope.dangerous ? ' is-dangerous' : ''}">${esc(scope.label)}</span>`).join('')
  if (!scopes.length) {
    return `
      <div class="perm-complete-state">
        <span class="perm-complete-badge">权限已齐全</span>
        <strong>当前身份已拥有全部可申请权限</strong>
        <span>无需再发起新申请。如需调整角色或回收权限，请联系公司管理员在控制台处理。</span>
        <div class="perm-complete-stats">
          <div><strong>${current.length}</strong><span>已生效权限</span></div>
          <div><strong>${scopes.length}</strong><span>可申请权限</span></div>
          <div><strong>${roles.length}</strong><span>可切换角色</span></div>
        </div>
      </div>
      <div class="perm-field perm-complete-current">
        <details class="perm-current-details">
          <summary><span class="perm-current-label">查看当前身份已有权限</span><span class="perm-selected-count">${current.length} 项</span></summary>
          <div class="perm-current-scopes">${currentChips || '<span class="perm-field-hint">暂无可用权限</span>'}</div>
        </details>
      </div>`
  }
  const selected = new Set(state.permScopeCodes || [])
  const emptyScopes = `<div class="perm-scope-empty">
    <strong>当前没有可申请的新权限</strong>
    <span>你已拥有全部已登记权限点。</span>
  </div>`
  const groups = new Map()
  for (const scope of scopes) {
    const key = scope.group || '其他'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(scope)
  }
  const groupHtml = [...groups.entries()].map(([group, items]) => `
    <section class="perm-scope-group">
      <div class="perm-scope-group-title">${esc(group)}</div>
      <div class="perm-scope-grid">
        ${items.map((scope) => `
          <label class="perm-scope${selected.has(scope.code) ? ' is-selected' : ''}${scope.dangerous ? ' is-dangerous' : ''}">
            <input type="checkbox" name="perm-scope" value="${esc(scope.code)}"${selected.has(scope.code) ? ' checked' : ''}>
            <span class="perm-scope-check" aria-hidden="true"></span>
            <span class="perm-scope-main">
              <span class="perm-scope-title">${esc(scope.label)} <span class="perm-scope-code">${esc(scope.code)}</span>${scope.dangerous ? '<span class="perm-danger">高危</span>' : ''}</span>
              <span class="perm-scope-note">${esc(permPolicyText(scope.policy))}</span>
            </span>
          </label>`).join('')}
      </div>
    </section>`).join('')
  return `
    <form class="perm-form" id="perm-apply-form">
      <div class="perm-field">
        <label class="perm-field-label" for="perm-role">申请角色</label>
        <select class="perm-select" id="perm-role"${roles.length ? '' : ' disabled'}>
          ${roles.length
            ? roles.map((role) => `<option value="${esc(role.code)}"${role.code === state.permRoleCode ? ' selected' : ''}>${esc(role.name)} · ${esc(role.code)}</option>`).join('')
            : '<option>未识别到当前角色</option>'}
        </select>
        <span class="perm-field-hint">角色只用于匹配审批策略和审批人。审批通过只给本人授权，不会把权限写入这个角色。</span>
      </div>
      <div class="perm-grant-note">
        <span class="perm-grant-icon" aria-hidden="true">✓</span>
        <div><strong>审批通过后只授予你本人</strong><span>不会加入任何角色，也不会连带开放给同角色的其他成员；到期自动失效。</span></div>
      </div>
      <div class="perm-field">
        <details class="perm-current-details">
          <summary><span class="perm-current-label">当前身份已有权限</span><span class="perm-selected-count">${current.length} 项</span></summary>
          <div class="perm-current-scopes">${currentChips || '<span class="perm-field-hint">暂无可用权限</span>'}</div>
        </details>
        <span class="perm-field-hint">下面列出当前身份没有的全部已登记权限点；未单独配置的按默认审批链。</span>
      </div>
      <div class="perm-field">
        <div class="perm-apply-head">
          <span class="perm-field-label">可申请权限</span>
          <span class="perm-selected-count" id="perm-selected-count">已选 ${selected.size} 项</span>
        </div>
        <div class="perm-scope-list">${groupHtml || emptyScopes}</div>
        <span class="perm-field-hint">可多选；审批链取所选权限中最严格的一条。</span>
      </div>
      <div class="perm-field">
        <div class="perm-apply-head">
          <span class="perm-field-label">审批路径预览</span>
          <span class="perm-selected-count">${selected.size > 0 ? `${selected.size} 项` : ''}</span>
        </div>
        <div class="perm-path-box" id="perm-path">${permPathInnerHtml()}</div>
      </div>
      <div class="perm-field">
        <label class="perm-field-label" for="perm-reason">申请原因</label>
        <textarea class="perm-textarea" id="perm-reason" maxlength="500" placeholder="说明你要用这些权限做什么，审批人会看到"></textarea>
        <span class="perm-field-hint">选填，最多 500 字。</span>
      </div>
      <div class="perm-field">
        <label class="perm-field-label" for="perm-duration">授权有效期</label>
        <select class="perm-select" id="perm-duration">
          <option value="72">3 天</option>
          <option value="168" selected>7 天</option>
          <option value="720">30 天</option>
        </select>
        <span class="perm-field-hint">最后一级同意后开始计时，到期自动失效；最长 30 天。</span>
      </div>
      ${state.permError ? `<div class="perm-error">${esc(state.permError)}</div>` : ''}
      ${state.permSuccess ? `<div class="perm-success">${esc(state.permSuccess)}</div>` : ''}
      <div class="perm-form-actions">
        <button class="btn primary" type="submit" id="perm-submit">${selected.size > 0 ? `提交 ${selected.size} 项申请` : '提交申请'}</button>
      </div>
    </form>`
}


function permRequestTitle(request) {
  if (request?.requestType === 'scope') {
    const labels = (request.scopes || []).map((scope) => permScopeLabel(scope))
    if (!labels.length) return '申请权限'
    return `申请权限：${labels.slice(0, 2).join('、')}${labels.length > 2 ? ` 等 ${labels.length} 项` : ''}`
  }
  return request?.roleName || request?.roleCode || '角色申请'
}

/** 同一 stepNo 可能有多名会签审批人；流程节点按 stepNo 聚合展示。 */
function permStepGroups(request) {
  const groups = new Map()
  for (const step of request?.steps || []) {
    const stepNo = Number(step.stepNo) || 1
    if (!groups.has(stepNo)) {
      groups.set(stepNo, {
        stepNo,
        nodeTitle: step.nodeTitle || `第 ${stepNo} 级审批`,
        nodeMode: step.nodeMode || '',
        roleName: step.approverRoleName || '',
        steps: [],
      })
    }
    groups.get(stepNo).steps.push(step)
  }
  return [...groups.values()]
    .sort((a, b) => a.stepNo - b.stepNo)
    .map((group) => {
      const statuses = group.steps.map((step) => step.status)
      let status = 'pending'
      if (statuses.every((value) => value === 'approved')) status = 'approved'
      else if (statuses.some((value) => value === 'rejected')) status = 'rejected'
      else if (statuses.some((value) => value === 'active')) status = 'active'
      else if (statuses.every((value) => value === 'skipped')) status = 'skipped'
      else if (statuses.every((value) => value === 'expired')) status = 'expired'
      return {
        ...group,
        status,
        approvedCount: statuses.filter((value) => value === 'approved').length,
        activeSteps: group.steps.filter((step) => step.status === 'active'),
        updatedAt: Math.max(0, ...group.steps.map((step) => Number(step.updatedAt) || 0)),
      }
    })
}

function permGroupStatusText(group, request) {
  if (request?.status === 'cancelled' && group.status !== 'approved') return '已撤回'
  if (group.status === 'approved') return group.steps.length > 1 ? `会签通过 ${group.steps.length}/${group.steps.length}` : '已通过'
  if (group.status === 'rejected') return '已拒绝'
  if (group.status === 'active') {
    return group.steps.length > 1
      ? `进行中 ${group.approvedCount}/${group.steps.length}`
      : '进行中'
  }
  if (group.status === 'expired') return '已超时'
  if (group.status === 'skipped') return '已跳过'
  return '待开始'
}

function permCurrentGroup(request) {
  return permStepGroups(request).find((group) => group.stepNo === Number(request.currentStep)) || null
}

function permDeadlineText(deadline) {
  const left = Number(deadline) - Date.now()
  if (!Number.isFinite(left) || left <= 0) return '已超过处理时限'
  const hours = Math.ceil(left / 3_600_000)
  if (hours < 24) return `剩余 ${hours} 小时`
  return `剩余 ${Math.ceil(hours / 24)} 天`
}

function permCurrentSummary(request, group, meId) {
  if (!request) return ''
  if (request.status === 'approved') {
    return request.requestType === 'scope' ? '审批已通过，所选权限已授予本人，到期自动失效。' : '审批已通过，角色已授予本人，到期自动失效。'
  }
  if (request.status === 'rejected') return '审批已拒绝，未授予任何权限。'
  if (request.status === 'cancelled') return '申请已撤回，流程已结束。'
  if (request.status === 'expired') return '审批已超过处理时限，流程已结束。'
  if (!group) return '流程等待推进。'
  const meActive = group.activeSteps.find((step) => step.approverUserId === meId)
  if (meActive) return '轮到你处理，请在下方选择同意或拒绝。'
  const activeNames = group.activeSteps.map((step) => step.approverName).filter(Boolean)
  if (!activeNames.length) return `等待进入「${group.nodeTitle}」。`
  if (group.steps.length > 1) {
    const others = activeNames.filter((name) => name !== (group.steps.find((step) => step.approverUserId === meId)?.approverName || ''))
    return `会签节点，已通过 ${group.approvedCount}/${group.steps.length} 人${others.length ? `，等待 ${others.join('、')} 处理` : ''}。`
  }
  return `等待 ${activeNames.join('、')} 处理「${group.nodeTitle}」。`
}

function permFlowNodeHtml(request, group, meId) {
  const current = request.status === 'pending' && group.stepNo === Number(request.currentStep)
  const state = group.status === 'approved' ? 'done' : group.status === 'rejected' ? 'rejected' : current ? 'current' : group.status === 'pending' ? 'waiting' : group.status === 'skipped' ? 'skipped' : group.status === 'expired' ? 'expired' : 'current'
  const people = group.steps.map((step) => {
    const statusText = step.status === 'approved'
      ? '已同意'
      : step.status === 'active'
        ? '待处理'
        : PERM_STEP_TEXT[step.status] || step.status
    return `<span class="perm-flow-person is-${esc(step.status)}"><i aria-hidden="true"></i>${esc(step.approverName)}<small>${esc(statusText)}</small></span>`
  }).join('')
  const timeText = group.status === 'approved' || group.status === 'rejected'
    ? `处理于 ${esc(permTime(Math.max(...group.steps.map((step) => Number(step.decidedAt) || 0)) || group.updatedAt))}`
    : group.status === 'skipped'
      ? '流程已结束，本节点未继续'
      : current && group.updatedAt
        ? `进入节点于 ${esc(permTime(group.updatedAt))}`
        : '等待上一节点完成'
  return `
    <li class="perm-flow-item is-${state}">
      <span class="perm-flow-marker" aria-hidden="true">${group.status === 'approved' ? '✓' : group.status === 'rejected' ? '×' : current ? '●' : String(group.stepNo)}</span>
      <div class="perm-flow-node">
        <div class="perm-flow-node-head">
          <span class="perm-flow-node-kicker">节点 ${String(group.stepNo).padStart(2, '0')}${current ? ' · 当前' : ''}</span>
          <span class="perm-flow-node-state">${esc(permGroupStatusText(group, request))}</span>
        </div>
        <strong class="perm-flow-node-title">${esc(group.nodeTitle)}</strong>
        ${group.steps.length > 1 ? `<span class="perm-flow-node-mode">会签 · 需 ${group.steps.length} 人全部同意${group.roleName ? ` · ${esc(group.roleName)}` : ''}</span>` : group.nodeMode && group.nodeMode !== 'single' ? `<span class="perm-flow-node-mode">${esc(group.nodeMode)}</span>` : ''}
        <div class="perm-flow-people">${people}</div>
        <div class="perm-flow-node-sub">${timeText}${group.steps.some((step) => step.comment) ? ` · ${esc(group.steps.find((step) => step.comment)?.comment || '')}` : ''}</div>
      </div>
    </li>`
}

function permFlowHtml(request, meId) {
  const groups = permStepGroups(request)
  const done = groups.filter((group) => group.status === 'approved').length
  const total = Math.max(1, Number(request.totalSteps) || groups.length || 1)
  const percent = request.status === 'approved' ? 100 : Math.round((done / total) * 100)
  const current = permCurrentGroup(request)
  const summary = permCurrentSummary(request, current, meId)
  return `
    <section class="perm-flow" aria-label="审批流程">
      <div class="perm-flow-head">
        <div>
          <span class="perm-flow-kicker">审批流程</span>
          <strong>${request.status === 'pending' ? `当前推进到第 ${Number(request.currentStep)} / ${total} 个节点` : summary}</strong>
        </div>
        <span class="perm-flow-fraction">${done}/${total} 节点完成</span>
      </div>
      <div class="perm-flow-track"><span class="perm-flow-fill is-${esc(request.status)}" style="width:${percent}%"></span></div>
      ${request.status === 'pending' ? `<div class="perm-current-note is-${esc(request.status)}">
        <span class="perm-current-dot" aria-hidden="true"></span>
        <div><strong>${esc(current?.nodeTitle || '等待流程推进')}</strong><span>${esc(summary)}</span></div>
      </div>` : ''}
      <ol class="perm-flow-list">
        <li class="perm-flow-item is-done is-submit">
          <span class="perm-flow-marker" aria-hidden="true">✓</span>
          <div class="perm-flow-node">
            <div class="perm-flow-node-head"><span class="perm-flow-node-kicker">提交申请</span><span class="perm-flow-node-state">已提交</span></div>
            <strong class="perm-flow-node-title">${esc(request.requesterName)}</strong>
            <div class="perm-flow-node-sub">${esc(permTime(request.createdAt))} · ${Number(request.durationHours) / 24 || 1} 天有效期</div>
          </div>
        </li>
        ${groups.map((group) => permFlowNodeHtml(request, group, meId)).join('')}
        <li class="perm-flow-item ${request.status === 'approved' ? 'is-done' : request.status === 'rejected' ? 'is-rejected' : request.status === 'pending' ? 'is-waiting' : 'is-skipped'} is-end">
          <span class="perm-flow-marker" aria-hidden="true">${request.status === 'approved' ? '✓' : '■'}</span>
          <div class="perm-flow-node">
            <div class="perm-flow-node-head"><span class="perm-flow-node-kicker">授权生效</span><span class="perm-flow-node-state">${request.status === 'approved' ? '已完成' : request.status === 'pending' ? '等待审批' : '未生效'}</span></div>
            <strong class="perm-flow-node-title">${request.status === 'approved' ? (request.requestType === 'scope' ? '仅授予本人所选权限' : '角色授权本人') : request.status === 'pending' ? (request.requestType === 'scope' ? '仅授予本人所选权限' : '角色授权本人') : '未授予任何权限'}</strong>
            <div class="perm-flow-node-sub">${request.status === 'approved' ? `已生效 · 到期 ${esc(permTime(request.requestedExpiresAt))}` : request.status === 'pending' ? '最后一级节点通过后生效，到期自动失效' : `流程于 ${esc(permTime(request.decidedAt || request.updatedAt))} 结束`}</div>
          </div>
        </li>
      </ol>
    </section>`
}

function permRequestCardHtml(request, activeId) {
  const total = Math.max(1, Number(request.totalSteps) || 1)
  const groups = permStepGroups(request)
  const done = groups.filter((group) => group.status === 'approved').length
  const width = request.status === 'approved' ? 100 : Math.round((done / total) * 100)
  const current = permCurrentGroup(request)
  const stageText = request.status === 'pending'
    ? `当前：${current?.nodeTitle || `第 ${Number(request.currentStep)} 级`}`
    : request.status === 'approved'
      ? '流程已完成'
      : request.status === 'rejected'
        ? '流程已拒绝'
        : `流程${{ cancelled: '已撤回', expired: '已超时' }[request.status] || '已结束'}`
  return `
    <button class="perm-card${request.id === activeId ? ' is-active' : ''}" type="button" data-perm-request="${esc(request.id)}">
      <span class="perm-card-top">
        <span class="perm-card-role">${esc(permRequestTitle(request))}</span>
        ${permStatusHtml(request.status)}
      </span>
      <span class="perm-card-meta">${esc(request.requesterName)} · ${esc(permTime(request.createdAt))} · ${Number(request.durationHours) / 24 || 1} 天</span>
      <span class="perm-card-stage">${esc(stageText)}</span>
      <span class="perm-card-progress">
        <span class="perm-progress-track"><span class="perm-progress-fill" style="width:${width}%"></span></span>
        <span>${done}/${total} 节点</span>
      </span>
    </button>`
}

function permDetailHtml(request) {
  if (!request) return ''
  const meId = state.me?.person?.id || ''
  const groups = permStepGroups(request)
  const current = permCurrentGroup(request)
  const currentStepMine = (current?.activeSteps || []).find((step) => step.approverUserId === meId)
  const canDecideHere = request.status === 'pending' && Boolean(currentStepMine)
  const canCancel = request.status === 'pending' && request.requesterUserId === meId
  const canResend = request.status === 'pending' && current && (current.steps.some((step) => step.cardStatus === 'failed' || step.cardStatus === 'sending'))
  const activeNames = (current?.activeSteps || []).map((step) => step.approverName).filter(Boolean)
  const isRequester = request.requesterUserId === meId
  const canUrgeTargets = isRequester
    ? activeNames.length > 0
    : Boolean(currentStepMine) && (current?.activeSteps || []).some((step) => step.approverUserId !== meId)
  const canUrge = request.status === 'pending' && canUrgeTargets
  const urgeNextAt = Number(request.urge?.nextAt) || 0
  const urgeLocked = urgeNextAt > Date.now()
  const urgeMinutes = urgeLocked ? Math.max(1, Math.ceil((urgeNextAt - Date.now()) / 60_000)) : 0
  const urgeText = isRequester ? '催办当前审批人' : '催办同节点审批人'
  const urgeNote = urgeLocked
    ? `已催办，${urgeMinutes} 分钟后可再次催办`
    : request.urge?.count
      ? `上次催办 ${esc(permTime(request.urge.lastAt))} · 共 ${Number(request.urge.count)} 次`
      : '会通过钉钉提醒当前待处理审批人'
  const actionButtons = []
  if (canDecideHere) {
    actionButtons.push('<button class="btn primary" type="button" data-perm-decide="approve">同意</button>')
    actionButtons.push('<button class="btn danger" type="button" data-perm-decide="reject">拒绝</button>')
  } else if (canCancel) {
    actionButtons.push('<button class="btn ghost" type="button" data-perm-cancel="1">撤回申请</button>')
  } else if (canResend) {
    actionButtons.push('<button class="btn ghost" type="button" data-perm-resend="1">重发钉钉审批卡</button>')
  }
  if (canUrge) {
    actionButtons.push(`<button class="btn ghost perm-urge-btn" type="button" data-perm-urge="1"${urgeLocked ? ' disabled' : ''}>${urgeLocked ? `${urgeMinutes} 分钟后可催办` : urgeText}</button>`)
  }
  const scopeLabels = (request.scopes || []).map((scope) => esc(permScopeLabel(scope))).join('、') || '—'
  const requestTypeText = request.requestType === 'scope'
    ? '权限点（通过后只授予所选权限，不新增角色）'
    : '角色'
  const deadlineText = `${esc(permTime(request.requestDeadline))} · ${esc(permDeadlineText(request.requestDeadline))}`
  const currentText = current
    ? `第 ${Number(request.currentStep)} / ${Number(request.totalSteps)} 节点 · ${esc(current.nodeTitle)}`
    : request.status === 'pending' ? '等待流程推进' : '流程已结束'
  const currentPeople = activeNames.length ? activeNames.join('、') : (request.status === 'pending' ? '—' : '已处理')
  return `
    <div class="perm-detail" data-perm-detail="${esc(request.id)}">
      <div class="perm-detail-head">
        <div class="perm-detail-title">
          <strong>${esc(permRequestTitle(request))}</strong>
          ${permStatusHtml(request.status)}
          <button class="icon-btn" type="button" data-perm-back="1" title="返回列表" aria-label="返回列表">←</button>
        </div>
        <dl class="perm-detail-facts">
          <dt>申请人</dt><dd>${esc(request.requesterName)}</dd>
          <dt>申请类型</dt><dd>${esc(requestTypeText)}</dd>
          <dt>申请权限</dt><dd>${scopeLabels}</dd>
          <dt>当前节点</dt><dd>${currentText}</dd>
          <dt>当前处理人</dt><dd>${esc(currentPeople)}</dd>
          <dt>处理时限</dt><dd>${deadlineText}</dd>
          <dt>有效期</dt><dd>${Number(request.durationHours) / 24 || 1} 天</dd>
          <dt>申请原因</dt><dd>${esc(request.reason || '未填写')}</dd>
          <dt>提交时间</dt><dd>${esc(permTime(request.createdAt))}</dd>
        </dl>
      </div>
      ${permFlowHtml(request, meId)}
      ${state.permError ? `<div class="perm-error">${esc(state.permError)}</div>` : ''}
      ${state.permSuccess ? `<div class="perm-success">${esc(state.permSuccess)}</div>` : ''}
      ${canDecideHere ? `
        <div class="perm-comment">
          <label class="perm-field-label" for="perm-comment">审批意见</label>
          <textarea class="perm-textarea" id="perm-comment" maxlength="500" placeholder="拒绝时建议写明原因"></textarea>
        </div>` : ''}
      ${actionButtons.length ? `<div class="perm-detail-actions">${actionButtons.join('')}</div>` : ''}
      ${canUrge ? `<div class="perm-urge-note">${urgeNote}</div>` : ''}
    </div>`
}

function renderPermissionPane() {
  const body = $('#perm-body')
  if (!body) return
  const counts = { mine: state.permRequests.mine.length, todo: state.permRequests.todo.length }
  const sub = $('#perm-pane-sub')
  if (sub && state.permConfig) {
    const available = (state.permConfig.scopes || []).length
    if (state.permView === 'mine') sub.textContent = '查看你已经发起过的权限申请，以及当前审批进度和处理结果。'
    else if (state.permView === 'todo') sub.textContent = '查看当前轮到你的审批；处理后结果会同步给申请人。'
    else if (available) sub.textContent = '勾选当前身份缺少的权限点，多选合并成一张审批单；通过后只授予所选权限，不新增角色，到期自动失效。'
    else sub.textContent = '你已拥有全部可申请权限；这里可以查看当前权限，或联系公司管理员调整角色。'
  }
  const todoCount = $('#perm-todo-count')
  if (todoCount) {
    todoCount.hidden = counts.todo === 0
    todoCount.textContent = String(counts.todo)
  }
  const entryCount = $('#perm-entry-count')
  if (entryCount) {
    entryCount.hidden = counts.todo === 0
    entryCount.textContent = String(counts.todo)
  }
  document.querySelectorAll('[data-perm-view]').forEach((button) => {
    const view = button.getAttribute('data-perm-view')
    const active = view === state.permView
    button.classList.toggle('is-active', active)
    button.setAttribute('aria-selected', active ? 'true' : 'false')
  })
  if (state.permLoading) {
    body.innerHTML = '<div class="perm-loading muted">正在读取权限审批…</div>'
    return
  }
  if (state.permView === 'apply') {
    body.innerHTML = permApplyHtml()
    return
  }
  const list = state.permView === 'todo' ? state.permRequests.todo : state.permRequests.mine
  if (state.permSelected) {
    const selected = list.find((request) => request.id === state.permSelected)
    if (selected) {
      body.innerHTML = permDetailHtml(selected)
      return
    }
  }
  if (!list.length) {
    body.innerHTML = state.permView === 'todo'
      ? '<div class="perm-empty"><span class="perm-empty-title">没有待你审批的申请</span>当前步骤轮到你时，钉钉会收到审批卡，也会出现在这里。</div>'
      : '<div class="perm-empty"><span class="perm-empty-title">还没有发起过申请</span>切到「申请权限」，勾选当前缺少的权限点提交即可。</div>'
    return
  }
  body.innerHTML = `<div class="perm-list">${list.map((request) => permRequestCardHtml(request, state.permSelected)).join('')}</div>`
}

async function loadPermissionData(options = {}) {
  if (!state.permOpen && !options.silent) return
  state.permLoading = true
  if (!options.silent) renderPermissionPane()
  try {
    const [config, mine, todo] = await Promise.all([
      api('/api/permissions/config'),
      api('/api/permissions/requests?mode=mine'),
      api('/api/permissions/requests?mode=todo'),
    ])
    state.permConfig = config
    const requestable = new Set((config.scopes || []).map((scope) => scope.code))
    state.permScopeCodes = (state.permScopeCodes || []).filter((code) => requestable.has(code))
    state.permRequests = { mine: mine.requests || [], todo: todo.requests || [] }
    state.permError = ''
    if (state.permSelected && ![...state.permRequests.mine, ...state.permRequests.todo].some((item) => item.id === state.permSelected)) {
      state.permSelected = ''
    }
  } catch (error) {
    state.permError = `${error.message}${error.hint ? `（${error.hint}）` : ''}`
  } finally {
    state.permLoading = false
    if (state.permOpen && !options.silent) renderPermissionPane()
    syncWorkbenchLayout()
  }
}

async function refreshPermissionBadge() {
  if (!state.me) return
  try {
    const todo = await api('/api/permissions/requests?mode=todo')
    state.permRequests.todo = todo.requests || []
    if (state.permConfig) renderPermissionPane()
    syncWorkbenchLayout()
  } catch {
    // 没有审批权限或后端未迁移时，徽标安静地不显示。
  }
}

function openPermissionPane() {
  state.permOpen = true
  state.workbenchTab = 'perm'
  state.permSuccess = ''
  setWorkbenchCollapsed(false)
  syncWorkbenchLayout()
  renderPermissionPane()
  void loadPermissionData()
  $('#perm-body')?.scrollTo?.({ top: 0 })
}

function closePermissionPane() {
  state.permOpen = false
  state.permSelected = ''
  state.permError = ''
  state.permSuccess = ''
  syncWorkbenchLayout()
}

async function submitPermissionApply(event) {
  event.preventDefault()
  const scopeCodes = [...(state.permScopeCodes || [])]
  if (!scopeCodes.length) {
    state.permError = '请先勾选至少一个要申请的权限'
    renderPermissionPane()
    return
  }
  const reason = $('#perm-reason')?.value || ''
  const durationHours = Number($('#perm-duration')?.value || 168)
  const button = $('#perm-submit')
  if (button) {
    button.disabled = true
    button.textContent = '提交中…'
  }
  state.permError = ''
  try {
    const result = await api('/api/permissions/requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scopeCodes, roleCode: state.permRoleCode || undefined, reason, durationHours }),
    })
    state.permSuccess = result.cardPending
      ? '权限申请已提交，正在给第一级审批人发钉钉审批卡。'
      : '权限申请已提交。'
    state.permScopeCodes = []
    state.permSelected = result.request?.id || ''
    state.permView = 'mine'
    await loadPermissionData()
    if (state.permSelected) renderPermissionPane()
  } catch (error) {
    state.permError = `${error.message}${error.hint ? `（${error.hint}）` : ''}`
  } finally {
    if (button) {
      button.disabled = false
      button.textContent = '提交申请'
    }
    renderPermissionPane()
  }
}

async function decidePermissionFromWeb(requestId, decision) {
  const comment = $('#perm-comment')?.value || ''
  state.permError = ''
  try {
    const result = await api(`/api/permissions/requests/${encodeURIComponent(requestId)}/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision, comment }),
    })
    state.permSuccess = decision === 'approve' ? '已同意，流程已推进。' : '已拒绝，流程已结束。'
    state.permSelected = result.request?.id || ''
    await loadPermissionData()
    if (state.permSelected) renderPermissionPane()
  } catch (error) {
    state.permError = `${error.message}${error.hint ? `（${error.hint}）` : ''}`
    renderPermissionPane()
  }
}

async function cancelPermissionFromWeb(requestId) {
  state.permError = ''
  try {
    const result = await api(`/api/permissions/requests/${encodeURIComponent(requestId)}/cancel`, { method: 'POST' })
    state.permSuccess = '申请已撤回。'
    state.permSelected = result.request?.id || ''
    await loadPermissionData()
    if (state.permSelected) renderPermissionPane()
  } catch (error) {
    state.permError = `${error.message}${error.hint ? `（${error.hint}）` : ''}`
    renderPermissionPane()
  }
}

async function resendPermissionCard(requestId) {
  state.permError = ''
  try {
    const result = await api(`/api/permissions/requests/${encodeURIComponent(requestId)}/resend-card`, { method: 'POST' })
    state.permSuccess = result.sent ? '审批卡已重新投递。' : '审批卡未投递成功，请检查审批人钉钉绑定。'
    await loadPermissionData()
    if (state.permSelected) renderPermissionPane()
  } catch (error) {
    state.permError = `${error.message}${error.hint ? `（${error.hint}）` : ''}`
    renderPermissionPane()
  }
}

async function urgePermissionFromWeb(requestId) {
  state.permError = ''
  state.permSuccess = ''
  try {
    const result = await api(`/api/permissions/requests/${encodeURIComponent(requestId)}/urge`, { method: 'POST' })
    const sent = Number(result.sent) || 0
    const failed = Number(result.failed) || 0
    state.permSuccess = sent > 0
      ? (failed > 0 ? `已向 ${sent} 位审批人发送催办，${failed} 位未能送达（可能未绑定钉钉）。` : `已向 ${sent} 位审批人发送催办。`)
      : '催办未送达，请确认当前审批人已经绑定钉钉。'
    state.permSelected = result.request?.id || state.permSelected
    await loadPermissionData()
    if (state.permSelected) renderPermissionPane()
  } catch (error) {
    state.permError = `${error.message}${error.hint ? `（${error.hint}）` : ''}`
    renderPermissionPane()
  }
}

function bindPermissionPane() {
  $('#perm-entry')?.addEventListener('click', () => {
    if (state.permOpen && state.workbenchTab === 'perm' && !state.workbenchCollapsed) {
      closePermissionPane()
      return
    }
    openPermissionPane()
  })
  $('#perm-switch')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-perm-view]')
    if (!button) return
    state.permView = button.getAttribute('data-perm-view') || 'apply'
    state.permSelected = ''
    state.permError = ''
    state.permSuccess = ''
    renderPermissionPane()
  })
  $('#perm-body')?.addEventListener('change', (event) => {
    const roleSelect = event.target.closest('#perm-role')
    if (roleSelect) {
      state.permRoleCode = roleSelect.value
      const path = document.querySelector('#perm-path')
      if (path) path.innerHTML = permPathInnerHtml()
      return
    }
    const input = event.target.closest('input[name="perm-scope"]')
    if (!input) return
    const code = input.value
    const selected = new Set(state.permScopeCodes || [])
    if (input.checked) selected.add(code)
    else selected.delete(code)
    state.permScopeCodes = [...selected]
    input.closest('.perm-scope')?.classList.toggle('is-selected', input.checked)
    const count = document.querySelector('#perm-selected-count')
    if (count) count.textContent = `已选 ${selected.size} 项`
    const submit = document.querySelector('#perm-submit')
    if (submit) submit.textContent = selected.size > 0 ? `提交 ${selected.size} 项申请` : '提交申请'
    const path = document.querySelector('#perm-path')
    if (path) path.innerHTML = permPathInnerHtml()
  })
  $('#perm-body')?.addEventListener('submit', (event) => {
    if (event.target?.id !== 'perm-apply-form') return
    void submitPermissionApply(event)
  })
  $('#perm-body')?.addEventListener('click', (event) => {
    const card = event.target.closest('[data-perm-request]')
    if (card) {
      state.permSelected = card.getAttribute('data-perm-request') || ''
      state.permError = ''
      state.permSuccess = ''
      renderPermissionPane()
      return
    }
    if (event.target.closest('[data-perm-back]')) {
      state.permSelected = ''
      state.permError = ''
      state.permSuccess = ''
      renderPermissionPane()
      return
    }
    const decide = event.target.closest('[data-perm-decide]')
    if (decide) {
      const requestId = state.permSelected
      if (requestId) void decidePermissionFromWeb(requestId, decide.getAttribute('data-perm-decide'))
      return
    }
    if (event.target.closest('[data-perm-cancel]') && state.permSelected) {
      void cancelPermissionFromWeb(state.permSelected)
      return
    }
    if (event.target.closest('[data-perm-resend]') && state.permSelected) {
      void resendPermissionCard(state.permSelected)
      return
    }
    const urge = event.target.closest('[data-perm-urge]')
    if (urge && state.permSelected) {
      if (urge.disabled) return
      urge.disabled = true
      urge.textContent = '催办中…'
      void urgePermissionFromWeb(state.permSelected)
    }
  })
  void refreshPermissionBadge()
}

function beginParentAgentTurn(runId) {
  const next = String(runId || '').trim()
  if (next) state.agentParentRunId = next
  const runtime = currentRuntime()
  if (runtime?.turn) state.parentTeamTurn = runtime.turn
  const title = $('#chat-title')?.textContent?.trim()
  state.agentParentName = title && title !== '新对话' ? title : '当前对话'
  renderAgentDock()
}

/** 一次任务结束后安排注销：空闲期内没有新事件就把窗口移出团队。 */
function scheduleAgentRetire(childId, updatedAt) {
  const run = state.agentRuns.get(childId)
  if (!run) return
  if (run.retireTimer) clearTimeout(run.retireTimer)
  const wait = Math.max(0, updatedAt + AGENT_TEAM_IDLE_MS - Date.now())
  run.retireTimer = setTimeout(() => {
    const current = state.agentRuns.get(childId)
    if (!current) return
    if ((current.status || 'running') === 'running') return
    // 用户正在这个子 Agent 的窗口里看历史时不能把窗口撤掉；
    // 否则上滑查看旧消息会被“自动注销”打断。切走后再按空闲期收尾。
    if (childId === state.agentSelectedId) {
      current.retireTimer = null
      return
    }
    if (Date.now() - (current.updatedAt || 0) < AGENT_TEAM_IDLE_MS - 1000) {
      scheduleAgentRetire(childId, current.updatedAt || Date.now())
      return
    }
    state.agentRuns.delete(childId)
    renderAgentDock()
  }, wait)
}

function pushThreadEntry(thread, entry) {
  const last = thread[thread.length - 1]
  // 流式输出碎片合并成一条，避免每几个字一个气泡。
  if (entry.kind === 'content' && last && last.kind === 'content') {
    last.text = `${last.text}${entry.text}`
    return
  }
  // 思考增量同样合并成一条，避免每个 token 建一个面板。
  if (entry.kind === 'reasoning' && last && last.kind === 'reasoning') {
    last.text = `${last.text}${entry.text}`
    return
  }
  thread.push(entry)
  if (thread.length > 200) thread.splice(0, thread.length - 200)
}

function updateAgentEvent(data) {
  if (!data || data.type !== 'agent' || !data.childId) return
  const previous = state.agentRuns.get(data.childId) || {}
  const thread = Array.isArray(previous.thread) ? previous.thread.slice() : []
  const next = {
    ...previous,
    childId: data.childId,
    key: data.key || previous.key || '',
    parentRunId: data.parentRunId || previous.parentRunId || '',
    runId: data.runId || previous.runId || '',
    agentId: data.agentId || previous.agentId || '',
    index: Number(data.index) || previous.index || state.agentRuns.size + 1,
    attempt: Number(data.attempt) || previous.attempt || 0,
    title: data.title || previous.title || '子 Agent',
    modelId: data.modelId || previous.modelId || '',
    modelName: data.modelName || previous.modelName || '',
    modelReason: data.modelReason || previous.modelReason || '',
    role: data.role || previous.role || 'worker',
    parentKey: data.parentKey !== undefined ? data.parentKey : (previous.parentKey ?? null),
    depth: Number(data.depth) || previous.depth || 1,
    acceptance: data.acceptance || previous.acceptance || '',
    pinned: data.pinned !== undefined ? Boolean(data.pinned) : Boolean(previous.pinned),
    status: data.status === 'unregistered' ? 'done' : (data.status || previous.status || 'running'),
    assign: data.action === 'assign' ? String(data.text || '').slice(0, 1200) : previous.assign || '',
    text: previous.text || '',
    steps: Array.isArray(previous.steps) ? previous.steps.slice() : [],
    thread,
    error: data.action === 'done' && (data.status === 'unregistered' || data.status === 'succeeded')
      ? ''
      : (data.error || previous.error || ''),
    durationMs: Number(data.durationMs) || previous.durationMs || 0,
    toolCount: Number.isFinite(Number(data.toolCount)) ? Number(data.toolCount) : (previous.toolCount || 0),
    artifacts: Array.isArray(data.artifacts) ? data.artifacts : (Array.isArray(previous.artifacts) ? previous.artifacts : []),
    updatedAt: Date.now(),
    retireTimer: previous.retireTimer,
  }

  if (data.action === 'assign') {
    // 子 Agent 处于 waiting 时的再次 assign，实际是父 Agent 对提问的答复/续跑指令，
    // 不能再显示成「派发」，否则多轮对话看起来像反复下新任务。
    const kind = previous.status === 'waiting' ? 'answer' : 'assign'
    pushThreadEntry(thread, {
      kind,
      text: String(data.text || (kind === 'answer' ? '（主 Agent 答复）' : '（派发任务）')),
      at: Date.now(),
    })
    // 新任务派下来 → 取消上一次的注销计划，并把窗口展开看过程。
    if (next.retireTimer) {
      clearTimeout(next.retireTimer)
      next.retireTimer = null
    }
    next.status = 'running'
  } else if (data.action === 'reasoning') {
    pushThreadEntry(thread, { kind: 'reasoning', text: String(data.text || ''), at: Date.now() })
  } else if (data.action === 'content') {
    next.text = `${next.text}${data.text || ''}`.slice(-4000)
    pushThreadEntry(thread, { kind: 'content', text: String(data.text || ''), at: Date.now() })
  } else if (data.action === 'report') {
    next.text = `${next.text}${next.text ? '\n' : ''}${data.text || ''}`.slice(-4000)
    // 重试过程保留为普通过程记录，最终状态由 done 决定，避免成功任务还挂着红字。
    pushThreadEntry(thread, { kind: 'report', text: String(data.text || ''), at: Date.now(), error: '' })
  } else if (data.action === 'question') {
    // 子 Agent 主动向父 Agent 提问：本轮暂停，等父 Agent 回复后继续。
    next.status = 'waiting'
    next.text = String(data.text || '').slice(0, 2400)
    pushThreadEntry(thread, { kind: 'question', text: next.text || '（需要主 Agent 回答）', at: Date.now() })
    if (next.retireTimer) {
      clearTimeout(next.retireTimer)
      next.retireTimer = null
    }
  } else if (data.action === 'guidance') {
    // 子 Agent 还在执行时，主 Agent 追加的约束/改方向，也要作为对话线程留痕。
    pushThreadEntry(thread, {
      kind: 'guidance',
      text: String(data.text || '（主 Agent 追加指示）'),
      at: Date.now(),
    })
  } else if (data.action === 'done') {
    if (data.text) next.text = String(data.text).slice(0, 2400)
    next.status = data.status === 'unregistered' ? 'done' : (data.status || 'done')
    const last = thread[thread.length - 1]
    const plain = (value) => String(value || '').replace(/\s+/g, '').trim()
    // 流式正文已经展示过同一段最终答案时，不再追加一条重复气泡。
    if (last && last.kind === 'content' && data.text && plain(last.text) === plain(data.text)) {
      last.final = true
      last.status = next.status
    } else {
      pushThreadEntry(thread, {
        kind: 'done',
        text: String(data.text || data.error || (next.status === 'failed' ? '执行失败' : '任务完成')),
        at: Date.now(),
        status: next.status,
      })
    }
  }

  if (data.action === 'tool' && data.tool) {
    const stepId = String(data.tool.id || '')
    if (stepId && !next.steps.some((step) => step.id === stepId)) {
      next.steps.push({
        id: stepId,
        name: data.tool.name || data.tool.toolId || '工具调用',
        toolId: data.tool.toolId || '',
        args: data.tool.args && typeof data.tool.args === 'object' ? data.tool.args : {},
        status: 'running',
        summary: '',
        durationMs: 0,
      })
      pushThreadEntry(thread, {
        kind: 'tool',
        id: stepId,
        text: data.tool.name || data.tool.toolId || '工具调用',
        args: data.tool.args && typeof data.tool.args === 'object' ? data.tool.args : {},
        at: Date.now(),
        status: 'running',
      })
    }
  }
  if (data.action === 'tool_result' && data.tool) {
    const stepId = String(data.tool.id || '')
    const step = next.steps.find((item) => item.id === stepId)
    if (step) {
      step.status = data.status === 'failed' ? 'error' : 'done'
      step.summary = data.summary || ''
      step.durationMs = Number(data.durationMs) || 0
    }
    const entry = thread.find((item) => item.kind === 'tool' && item.id === stepId)
    if (entry) {
      entry.status = data.status === 'failed' ? 'error' : 'done'
      entry.summary = data.summary || ''
      entry.durationMs = Number(data.durationMs) || 0
    }
  }

  state.agentRuns.set(data.childId, next)
  // 子任务的 parentRunId 才是这一批并行工作的真正父 run；团队头部和父气泡
  // 都按它过滤，避免上一轮已完成的子 Agent 把新一轮显示成 1/4。
  if (next.parentRunId) state.agentParentRunId = next.parentRunId
  // 新派发的子 Agent 成为详情焦点，但用户刚手动点过的员工不能被新事件立刻抢走。
  const userSelectionHeld = Boolean(state.agentUserSelectedAt)
    && Date.now() - state.agentUserSelectedAt < AGENT_USER_SELECTION_HOLD_MS
    && Boolean(state.agentSelectedId)
    && state.agentRuns.has(state.agentSelectedId)
  if (
    !userSelectionHeld && (
      data.action === 'assign' ||
      data.action === 'question' ||
      !state.agentSelectedId ||
      !state.agentRuns.has(state.agentSelectedId)
    )
  ) {
    state.agentSelectedId = data.childId
  }
  updateParentAgentProgress()
  // 一个 token 就全量重建工作台会把主线程压住，流式看起来像“卡一下再整段弹出”。
  // 合并到 ~25fps，既保留并行观感，又给主对话留出渲染时间。
  scheduleAgentDockRender()
  if (data.action === 'done') scheduleAgentRetire(data.childId, next.updatedAt)
}

/** 父消息里的进度卡按当前这一批子 Agent 更新；即使父回合已收尾仍保留。 */
function updateParentAgentProgress() {
  const parentRunId = String(state.agentParentRunId || '')
  if (!parentRunId) return
  const turn = state.parentTeamTurn || currentRuntime()?.turn
  if (!turn || typeof turn.teamProgress !== 'function') return
  const runs = Array.from(state.agentRuns.values()).filter(
    (run) => !run.parentRunId || run.parentRunId === parentRunId,
  )
  if (runs.length === 0) return
  const progress = agentTeamProgress(runs)
  const note = progress.active + progress.waiting > 0
    ? `子 Agent 并行工作中 · ${progress.active} 个进行中，${progress.remaining} 个待汇总`
    : progress.failed > 0
      ? `子 Agent 已结束：成功 ${progress.completed} · 失败 ${progress.failed}`
      : '全部子 Agent 已完成，主 Agent 正在整理最终汇总。'
  turn.teamProgress({
    ...progress,
    note,
  })
}

/** 子 Agent 对话里模型返回的正文按 Markdown 排版；工具过程和短状态仍保持纯文本。 */
function agentBubbleContent(text) {
  return `<div class="agent-markdown">${renderAnswer(String(text ?? ''))}</div>`
}

/** 事件行里显示子 Agent 的短名字，去掉标题里的岗位说明括号。 */
function agentDisplayName(run) {
  const title = String(run?.title || '').trim()
  if (!title) return '子 Agent'
  return title.replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '').trim() || title
}

function agentThreadEntryHtml(entry, run) {
  const name = agentDisplayName(run)
  const time = entry.at ? new Date(entry.at).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }) : ''
  if (entry.kind === 'assign') {
    return `<div class="agent-chat-row is-parent">
      <div class="agent-chat-main">
        <div class="agent-chat-meta"><span>主 Agent · 派发</span>${time ? `<time>${esc(time)}</time>` : ''}</div>
        <div class="agent-chat-bubble is-parent is-markdown">${agentBubbleContent(entry.text)}</div>
      </div>
      <span class="agent-chat-avatar is-parent" aria-hidden="true">主</span>
    </div>`
  }
  if (entry.kind === 'answer') {
    return `<div class="agent-chat-row is-parent">
      <div class="agent-chat-main">
        <div class="agent-chat-meta"><span>主 Agent · 回答</span>${time ? `<time>${esc(time)}</time>` : ''}</div>
        <div class="agent-chat-bubble is-parent is-answer is-markdown">${agentBubbleContent(entry.text)}</div>
      </div>
      <span class="agent-chat-avatar is-parent" aria-hidden="true">主</span>
    </div>`
  }
  if (entry.kind === 'guidance') {
    return `<div class="agent-chat-row is-parent">
      <div class="agent-chat-main">
        <div class="agent-chat-meta"><span>主 Agent · 追加指示</span>${time ? `<time>${esc(time)}</time>` : ''}</div>
        <div class="agent-chat-bubble is-parent is-answer is-markdown">${agentBubbleContent(entry.text)}</div>
      </div>
      <span class="agent-chat-avatar is-parent" aria-hidden="true">主</span>
    </div>`
  }
  if (entry.kind === 'question') {
    return `<div class="agent-chat-row is-agent">
      <span class="agent-chat-avatar is-agent" aria-hidden="true">子</span>
      <div class="agent-chat-main">
        <div class="agent-chat-meta"><span>${esc(name)} · 提问</span>${time ? `<time>${esc(time)}</time>` : ''}</div>
        <div class="agent-chat-bubble is-question is-markdown">${agentBubbleContent(entry.text)}</div>
      </div>
    </div>`
  }
  if (entry.kind === 'report') {
    return `<div class="agent-chat-row is-agent">
      <span class="agent-chat-avatar is-agent" aria-hidden="true">子</span>
      <div class="agent-chat-main">
        <div class="agent-chat-meta"><span>${esc(name)} · 过程记录</span>${time ? `<time>${esc(time)}</time>` : ''}</div>
        <div class="agent-chat-bubble is-report${entry.error ? ' is-error' : ''} is-markdown">${agentBubbleContent(entry.text)}</div>
      </div>
    </div>`
  }
  if (entry.kind === 'content') {
    const label = entry.final ? `${esc(name)} · 回报` : esc(name)
    return `<div class="agent-chat-row is-agent">
      <span class="agent-chat-avatar is-agent" aria-hidden="true">子</span>
      <div class="agent-chat-main">
        <div class="agent-chat-meta"><span>${label}</span>${time ? `<time>${esc(time)}</time>` : ''}</div>
        <div class="agent-chat-bubble is-agent${entry.final ? ' is-final' : ''} is-markdown">${agentBubbleContent(entry.text)}</div>
      </div>
    </div>`
  }
  if (entry.kind === 'tool') {
    const mark = entry.status === 'error' ? '✕' : entry.status === 'running' ? '◐' : '✓'
    const detail = entry.summary || (entry.status === 'running' ? '执行中…' : '')
    const seconds = entry.durationMs > 0 ? ` · ${formatElapsed(entry.durationMs)}` : ''
    return `<div class="agent-chat-tool is-${entry.status === 'error' ? 'error' : entry.status === 'running' ? 'running' : 'done'}">
      <span class="agent-chat-tool-mark" aria-hidden="true">${mark}</span>
      <strong title="${esc(entry.text)}">${esc(entry.text)}</strong>
      <span title="${esc(detail)}">${esc(detail)}${seconds}</span>
    </div>`
  }
  if (entry.kind === 'done') {
    const label = entry.status === 'failed' ? `${esc(name)} · 失败` : entry.status === 'cancelled' ? `${esc(name)} · 已取消` : `${esc(name)} · 完成`
    return `<div class="agent-chat-row is-agent">
      <span class="agent-chat-avatar is-agent${entry.status === 'failed' ? ' is-error' : ''}" aria-hidden="true">子</span>
      <div class="agent-chat-main">
        <div class="agent-chat-meta"><span>${label}</span>${time ? `<time>${esc(time)}</time>` : ''}</div>
        <div class="agent-chat-bubble is-done${entry.status === 'failed' ? ' is-error' : ''}">${esc(entry.text || label)}</div>
      </div>
    </div>`
  }
  return ''
}

/** 列表行的短状态，详情里用完整文案 */
function agentStatusShort(status) {
  if (status === 'waiting') return '待回复'
  if (status === 'done') return '待命'
  if (status === 'failed') return '失败'
  if (status === 'cancelled') return '已取消'
  return '运行中'
}

/** 按 parentKey 拼出团队树，再展平成列表；孤儿节点当根，避免坏数据丢行。 */
function sortAgentRunsAsTree(runs) {
  const keyed = new Map()
  for (const run of runs) {
    if (run.key) keyed.set(run.key, run)
  }
  const children = new Map()
  const roots = []
  const visited = new Set()
  for (const run of runs) {
    const parent = run.parentKey ? keyed.get(run.parentKey) : null
    if (parent && parent !== run && parent.childId !== run.childId) {
      const list = children.get(parent.childId) || []
      list.push(run)
      children.set(parent.childId, list)
    } else {
      roots.push(run)
    }
  }
  const byIndex = (a, b) => (Number(a.index) || 0) - (Number(b.index) || 0)
  const flat = []
  const walk = (run) => {
    if (!run || visited.has(run.childId)) return
    visited.add(run.childId)
    flat.push(run)
    ;(children.get(run.childId) || []).sort(byIndex).forEach(walk)
  }
  roots.sort(byIndex).forEach(walk)
  // 环路或父节点缺失时，把没走到的行补在末尾，不能让它们从面板消失。
  for (const run of runs.slice().sort(byIndex)) walk(run)
  return flat
}

function agentListRowModel(run, selected) {
  const status = run.status || 'running'
  const time = run.durationMs ? formatElapsed(run.durationMs) : ''
  const meta = [run.key, `${run.toolCount || 0} 次工具`, time].filter(Boolean).join(' · ')
  const latest = [...(run.thread || [])].reverse().find((entry) => entry.kind === 'content' || entry.kind === 'report')
  const preview = firstLinePreview(latest?.text || run.text || '', 56).slice(0, 48)
  const depth = Math.max(0, Math.min(3, (Number(run.depth) || 1) - 1))
  const className = `agent-row ${agentStatusClass(status)}${selected ? ' is-selected' : ''}`
  const inner = `<span class="agent-row-index">${String(run.index || 1).padStart(2, '0')}</span>
    <span class="agent-row-body">
      <span class="agent-row-line">
        <strong class="agent-row-title">${esc(agentDisplayName(run))}</strong>
      </span>
      <span class="agent-row-meta">
        <span class="agent-row-state"><span class="agent-status-dot" aria-hidden="true"></span>${agentStatusShort(status)}</span>
        <span class="agent-row-meta-text">${esc(meta)}</span>
      </span>
      ${preview ? `<span class="agent-row-preview">${esc(preview)}</span>` : ''}
    </span>`
  return {
    className,
    inner,
    signature: [run.title, status, meta, preview, depth, selected ? '1' : '0'].join('~'),
    title: run.title,
    depth,
  }
}

function agentListRowHtml(run, selected) {
  const model = agentListRowModel(run, selected)
  return `<button class="${model.className}" type="button" role="listitem" data-agent-select="${esc(run.childId)}" data-depth="${model.depth}" aria-current="${selected ? 'true' : 'false'}" title="${esc(run.title)}">${model.inner}</button>`
}

/**
 * 子 Agent 的思考/工具也按父对话同一套 CoT 设计展示：
 * 默认单行入口（✦ 思考 / 工具 · 摘要），点开后才显示完整思维链、参数和结果。
 * 面板展开状态存在 state.agentPanelOpen，流式重渲染不会把用户展开的面板又收回去。
 */
function agentCotPanelKey(run, kind, index) {
  return `${run.childId}:${kind}:${index}`
}

function agentReasoningPanelHtml(run, entries, index, isLastBlock) {
  const text = entries.map((entry) => String(entry.text || '')).join('')
  const key = agentCotPanelKey(run, 'think', index)
  const expanded = state.agentPanelOpen.get(key) === true
  const active = run.status === 'running' && isLastBlock
  const preview = active ? livePreview(text, 96) : firstLinePreview(text, 96)
  return `<div class="agent-cot-block" data-agent-panel-key="${esc(key)}">
    <div class="think-panel${active ? ' is-active' : ''}${expanded ? '' : ' is-collapsed'}">
      <button class="think-head" type="button" data-agent-cot-toggle="${esc(key)}" aria-expanded="${expanded ? 'true' : 'false'}" aria-label="展开思考过程">
        <span class="think-icon" aria-hidden="true">✦</span>
        <span class="think-title">${active ? '思考中' : '思考'}</span>
        <span class="think-divider"${preview ? '' : ' hidden'}>·</span>
        <span class="think-preview">${esc(preview)}</span>
        <span class="think-chevron" aria-hidden="true">⌄</span>
      </button>
      <div class="think-body">${esc(text)}</div>
    </div>
  </div>`
}

function agentToolPanelHtml(run, entries, index) {
  const key = agentCotPanelKey(run, 'tool', index)
  const expanded = state.agentPanelOpen.get(key) === true
  const traces = entries.map((entry) => ({
    id: String(entry.id || ''),
    name: entry.text || '工具调用',
    toolId: '',
    args: entry.args && typeof entry.args === 'object' ? entry.args : {},
    status: entry.status === 'error' ? 'error' : entry.status === 'running' ? 'running' : 'done',
    summary: entry.summary || '',
    durationMs: Number(entry.durationMs) || 0,
  }))
  const active = traces.some((trace) => trace.status === 'running') && run.status === 'running'
  return `<div class="agent-cot-block" data-agent-panel-key="${esc(key)}">${toolPanelHtml(traces, { active, expanded })}</div>`
}

/** 空正文/空思考是流式起始事件留下的占位，不能渲染成空气泡。 */
function agentEntryHasVisibleText(entry) {
  if (!entry) return false
  const text = String(entry.text ?? '').replace(/[\s\u200b\ufeff]/g, '')
  if (entry.kind === 'tool') return Boolean(text || String(entry.summary ?? '').replace(/[\s\u200b\ufeff]/g, ''))
  if (entry.kind === 'done') return true
  return Boolean(text)
}

/** 把连续思考、连续工具调用各自合并成一块；其余消息仍按父子对话气泡展示。 */
function agentChatThreadHtml(run) {
  const rawThread = (Array.isArray(run.thread) ? run.thread : []).filter(agentEntryHasVisibleText)
  // 子 Agent 自己也会在工具失败后重试；跨工具块统一归一化，避免旧失败在
  // 另一个工具块里仍显示成红色。
  const toolEntries = rawThread.filter((entry) => entry.kind === 'tool')
  const visibleToolIds = new Set(normalizeRecoveredToolCalls(toolEntries).map((entry) => entry.id))
  const thread = rawThread.filter((entry) => entry.kind !== 'tool' || visibleToolIds.has(entry.id))
  const blocks = []
  for (const entry of thread) {
    const kind = entry.kind === 'reasoning' ? 'reasoning' : entry.kind === 'tool' ? 'tool' : ''
    const last = blocks[blocks.length - 1]
    if (kind && last && last.kind === kind) {
      last.entries.push(entry)
      continue
    }
    if (kind) blocks.push({ kind, entries: [entry] })
    else blocks.push({ kind: entry.kind, entry })
  }
  // 严格按事件到达顺序展示：思考/工具出现在对话中间就留在中间，
  // 出现在回报之后就留在回报之后，不再把最终回报提前。
  return blocks.map((block, index) => {
    if (block.kind === 'reasoning') {
      return agentReasoningPanelHtml(run, block.entries, index, index === blocks.length - 1)
    }
    if (block.kind === 'tool') return agentToolPanelHtml(run, block.entries, index)
    return agentThreadEntryHtml(block.entry, run)
  }).join('')
}

/**
 * 子 Agent 窗口的滚动状态。和主对话一致：
 * - 贴底（pinned）时，新来的思考/工具/正文继续跟随到底部；
 * - 用户上滑看历史后停止跟随，只标“下方有新内容”；
 * - 点“回到最新消息”恢复贴底。
 * 状态按 childId 保存，流式重渲染（每 40ms 一次）不会把用户的位置冲掉。
 */
function agentThreadState(childId) {
  let scroll = state.agentScroll.get(childId)
  if (!scroll) {
    scroll = { pinned: true, top: 0, hasNew: false, scrollHeight: 0 }
    state.agentScroll.set(childId, scroll)
  }
  return scroll
}

function currentAgentPanel() {
  return document.querySelector('#team-detail .agent-chat-panel')
}

function currentAgentThread() {
  return currentAgentPanel()?.querySelector('.agent-chat-thread') || null
}

function agentThreadDistanceToBottom(thread) {
  if (!thread) return 0
  return thread.scrollHeight - thread.scrollTop - thread.clientHeight
}

function updateAgentScrollBottomButton(childId = state.agentSelectedId) {
  const button = currentAgentPanel()?.querySelector('[data-agent-scroll-bottom]')
  if (!button || !childId) return
  const scroll = agentThreadState(childId)
  button.hidden = scroll.pinned
  button.classList.toggle('has-new', scroll.hasNew)
  const label = scroll.hasNew ? '有新内容，回到最新消息' : '回到最新消息'
  button.title = label
  button.setAttribute('aria-label', label)
}

/** 重渲染前先记下旧容器的真实位置，渲染后才知道内容是不是变高了。 */
function captureAgentThreadScroll(childId) {
  const thread = currentAgentThread()
  if (!thread || !childId) return
  const scroll = agentThreadState(childId)
  // 不能在这里按“距底距离”重算 pinned：流式内容会让距离短暂变大，
  // 但用户并没有上滑；pinned 只由真实 scroll 事件改变。
  scroll.top = thread.scrollTop
  scroll.scrollHeight = thread.scrollHeight
}

/** 渲染完成后恢复位置。forceBottom 用于首次展示或切换到另一个子 Agent。 */
function restoreAgentThreadScroll(childId, forceBottom = false) {
  const thread = currentAgentThread()
  if (!thread || !childId) return
  const scroll = agentThreadState(childId)
  const grew = thread.scrollHeight > scroll.scrollHeight + 1
  if (forceBottom) {
    scroll.pinned = true
    scroll.hasNew = false
    scroll.top = 0
  }
  if (scroll.pinned) {
    const previous = thread.style.scrollBehavior
    thread.style.scrollBehavior = 'auto'
    thread.scrollTop = thread.scrollHeight
    if (previous) thread.style.scrollBehavior = previous
    else thread.style.removeProperty('scroll-behavior')
    scroll.top = thread.scrollTop
  } else {
    const maxTop = Math.max(0, thread.scrollHeight - thread.clientHeight)
    thread.scrollTop = Math.min(Math.max(0, scroll.top), maxTop)
    scroll.top = thread.scrollTop
    if (grew) scroll.hasNew = true
  }
  scroll.scrollHeight = thread.scrollHeight
  updateAgentScrollBottomButton(childId)
  if (scroll.pinned) {
    requestAnimationFrame(() => {
      const current = currentAgentThread()
      if (!current) return
      current.scrollTop = current.scrollHeight
      scroll.top = current.scrollTop
      scroll.scrollHeight = current.scrollHeight
      updateAgentScrollBottomButton(childId)
    })
  }
}

function scrollAgentThreadToBottom(childId = state.agentSelectedId, smooth = false) {
  const thread = currentAgentThread()
  if (!thread || !childId) return
  const scroll = agentThreadState(childId)
  scroll.pinned = true
  scroll.hasNew = false
  updateAgentScrollBottomButton(childId)
  thread.scrollTo({ top: thread.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  requestAnimationFrame(() => {
    const current = currentAgentThread()
    if (!current) return
    scroll.top = current.scrollTop
    scroll.scrollHeight = current.scrollHeight
    updateAgentScrollBottomButton(childId)
  })
}

/** 用户真实滚动：上滑立即停止跟随；滑回底部恢复跟随。 */
function onAgentThreadScroll(event) {
  const thread = event.target
  if (!thread || !thread.classList || !thread.classList.contains('agent-chat-thread')) return
  const childId = state.agentSelectedId
  if (!childId) return
  const scroll = agentThreadState(childId)
  const top = thread.scrollTop
  const distance = agentThreadDistanceToBottom(thread)
  if (top < scroll.top - 1) {
    scroll.pinned = false
  } else if (top > scroll.top + 1 && distance <= SCROLL_STICK_THRESHOLD) {
    scroll.pinned = true
    scroll.hasNew = false
  }
  scroll.top = top
  scroll.scrollHeight = thread.scrollHeight
  updateAgentScrollBottomButton(childId)
}

/** 子 Agent 交付的产物：只显示元数据，点击文件类产物复用右侧文件预览。 */
function agentArtifactsHtml(run) {
  const artifacts = Array.isArray(run.artifacts) ? run.artifacts.filter((item) => item && item.name) : []
  if (artifacts.length === 0) return ''
  const sourceLabel = { workspace: '工作区', cloud: '云空间', inline: '链接', mcp: 'MCP', a2a: 'A2A' }
  const rows = artifacts.slice(-8).map((artifact) => {
    const fileId = String(artifact.fileId || '')
    const meta = [sourceLabel[artifact.source] || artifact.source || '', fmtSize(Number(artifact.size) || 0)]
      .filter(Boolean).join(' · ')
    return `<button class="agent-artifact${fileId ? '' : ' is-plain'}" type="button"${fileId ? ` data-agent-artifact-open="${esc(fileId)}"` : ' disabled'} title="${esc(artifact.preview || artifact.uri || artifact.name)}">
      <span class="agent-artifact-icon" aria-hidden="true">◇</span>
      <span class="agent-artifact-body">
        <span class="agent-artifact-name">${esc(artifact.name)}</span>
        <span class="agent-artifact-meta">${esc(meta)}</span>
      </span>
    </button>`
  }).join('')
  return `<div class="agent-chat-artifacts" aria-label="任务产物">
    <span class="agent-chat-facts-label">产物 ${artifacts.length}</span>
    <div class="agent-chat-artifact-list">${rows}</div>
  </div>`
}

/** 右侧预览：一个子 Agent 与父 Agent 的对话流，父右子左。 */
function agentDetailHtml(run) {
  const status = run.status || 'running'
  const thread = agentChatThreadHtml(run)
  const model = run.modelName || run.modelId || '自动分配'
  const key = run.key || ''
  const facts = [
    `<span class="agent-chat-fact" title="${esc(run.modelReason || '')}"><b>${esc(model)}</b></span>`,
    `<span class="agent-chat-fact">${Number(run.toolCount) || 0} 次工具</span>`,
    run.pinned ? '<span class="agent-chat-fact">固定岗位</span>' : '',
    run.durationMs ? `<span class="agent-chat-fact">${formatElapsed(run.durationMs)}</span>` : '',
  ].filter(Boolean).join('')
  const hint = status === 'waiting'
    ? '子 Agent 正在等主 Agent 回答'
    : status === 'running'
      ? '子 Agent 正在工作，过程会实时出现在这里'
      : '本轮结束；继续对话会复用这个子 Agent 的上下文'
  return `<article class="agent-chat-panel ${agentStatusClass(status)}" data-agent-child="${esc(run.childId)}" aria-label="${esc(run.title)}，${agentStatusText(status)}">
    <header class="agent-chat-head">
      <div class="agent-chat-head-main">
        <span class="agent-chat-index">AGENT ${String(run.index || 1).padStart(2, '0')}</span>
        <strong class="agent-chat-title" title="${esc(run.title)}">${esc(run.title)}</strong>
        ${key ? `<span class="agent-chat-key" title="主 Agent 用这个 key 继续对话">${esc(key)}</span>` : ''}
      </div>
      <span class="agent-chat-state"><span class="agent-status-dot" aria-hidden="true"></span>${agentStatusText(status)}</span>
    </header>
    <div class="agent-chat-facts">${facts}</div>
    ${agentArtifactsHtml(run)}
    <div class="agent-chat-thread" role="log" aria-live="polite">
      ${thread || `<p class="agent-chat-placeholder">${status === 'running' ? '等待子 Agent 的第一条消息…' : '还没有对话记录。'}</p>`}
    </div>
    <footer class="agent-chat-foot">
      <span class="agent-chat-hint">${esc(hint)}</span>
      <span class="agent-scroll-slot">
        <button class="agent-scroll-bottom" type="button" data-agent-scroll-bottom title="回到最新消息" aria-label="回到最新消息" hidden>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <i class="agent-scroll-dot" aria-hidden="true"></i>
        </button>
      </span>
      ${run.error ? `<span class="agent-chat-error" title="${esc(run.error)}">${esc(run.error)}</span>` : ''}
      ${status === 'running' || status === 'waiting' ? '' : `<button class="agent-chat-continue" type="button" data-agent-continue="${esc(key)}" title="让主 Agent 继续和这个子 Agent 对话">继续对话</button>`}
    </footer>
  </article>`
}

/** 合并高频子 Agent 事件，避免每个 token 都整块重建工作台。 */
let agentDockRenderTimer = 0
/** 右侧详情比左侧列表更重：列表每 40ms 增量更新，详情最多 ~8fps 重建。 */
const AGENT_DETAIL_RENDER_MS = 120
let agentDetailRenderTimer = 0
let agentDetailRenderedAt = 0
let agentDetailSignature = ''

function scheduleAgentDockRender(delay = 40) {
  if (agentDockRenderTimer) return
  agentDockRenderTimer = setTimeout(() => {
    agentDockRenderTimer = 0
    renderAgentDock()
  }, delay)
}

/**
 * 左侧列表按 childId 复用行节点，只更新变化过的文本和状态。
 * 不能每次 innerHTML 全替换：流式期间行节点会被销毁，用户按下和抬起之间
 * 节点被换掉，浏览器就不会把 click 派发到行上，表现就是“点了没反应”。
 */
function renderAgentList(runs, selectedChildId) {
  const list = $('#team-list')
  if (!list) return
  const existing = new Map()
  for (const node of list.querySelectorAll('.agent-row')) {
    const childId = node.getAttribute('data-agent-select') || ''
    if (childId) existing.set(childId, node)
  }
  const ordered = []
  const desiredIds = new Set()
  for (const run of runs) {
    desiredIds.add(run.childId)
    let row = existing.get(run.childId)
    if (!row) {
      row = document.createElement('button')
      row.type = 'button'
      row.className = 'agent-row'
      row.setAttribute('role', 'listitem')
      row.setAttribute('data-agent-select', run.childId)
    }
    const model = agentListRowModel(run, run.childId === selectedChildId)
    if (row.className !== model.className) row.className = model.className
    if (row.getAttribute('data-depth') !== String(model.depth)) {
      row.setAttribute('data-depth', String(model.depth))
    }
    row.setAttribute('aria-current', run.childId === selectedChildId ? 'true' : 'false')
    if (row.title !== model.title) row.title = model.title
    // 只有内容真的变了才重写行内部；行节点本身始终保留，点击目标不会被换掉。
    if (row.dataset.agentRowSig !== model.signature) {
      row.innerHTML = model.inner
      row.dataset.agentRowSig = model.signature
    }
    ordered.push(row)
  }
  for (const [childId, row] of existing) {
    if (!desiredIds.has(childId)) row.remove()
  }
  const current = [...list.querySelectorAll('.agent-row')]
  const inOrder = current.length === ordered.length && current.every((node, index) => node === ordered[index])
  if (!inOrder) {
    const fragment = document.createDocumentFragment()
    for (const row of ordered) fragment.appendChild(row)
    list.appendChild(fragment)
  }
}

function agentDetailRenderSignature(run) {
  if (!run) return ''
  const thread = Array.isArray(run.thread) ? run.thread : []
  const entries = thread.map((entry) => [
    entry.kind || '',
    entry.id || '',
    entry.final ? '1' : '0',
    entry.status || '',
    entry.summary || '',
    String(entry.text || '').length,
  ].join(':')).join('|')
  const artifacts = (Array.isArray(run.artifacts) ? run.artifacts : []).map((artifact) => [
    artifact.id || '',
    artifact.name || '',
    Number(artifact.size) || 0,
    artifact.checksum || '',
    artifact.fileId || '',
  ].join(':')).join('|')
  return [
    run.childId,
    run.title || '',
    run.status || '',
    run.modelId || '',
    run.modelName || '',
    Number(run.toolCount) || 0,
    Number(run.durationMs) || 0,
    run.error || '',
    run.pinned ? '1' : '0',
    String(run.text || '').length,
    thread.length,
    entries,
    artifacts,
  ].join('~')
}

/** 只有详情内容真的变化才重建；流式 token 合并到 ~8fps，避免主线程一直被全量 Markdown 解析占住。 */
function renderAgentDetail(run, force = false) {
  const detail = $('#team-detail')
  if (!detail) return false
  if (!run) {
    if (agentDetailRenderTimer) {
      clearTimeout(agentDetailRenderTimer)
      agentDetailRenderTimer = 0
    }
    detail.innerHTML = ''
    agentDetailRenderedAt = 0
    agentDetailSignature = ''
    return true
  }
  const signature = agentDetailRenderSignature(run)
  const now = Date.now()
  if (!force && signature === agentDetailSignature) return false
  if (!force && agentDetailRenderedAt && now - agentDetailRenderedAt < AGENT_DETAIL_RENDER_MS) {
    if (!agentDetailRenderTimer) {
      const wait = AGENT_DETAIL_RENDER_MS - (now - agentDetailRenderedAt)
      agentDetailRenderTimer = setTimeout(() => {
        agentDetailRenderTimer = 0
        const current = state.agentRuns.get(state.agentSelectedId)
        if (!current) return
        captureAgentThreadScroll(current.childId)
        const rendered = renderAgentDetail(current, true)
        if (rendered) restoreAgentThreadScroll(current.childId)
      }, wait)
    }
    return false
  }
  if (agentDetailRenderTimer) {
    clearTimeout(agentDetailRenderTimer)
    agentDetailRenderTimer = 0
  }
  if (!force) captureAgentThreadScroll(run.childId)
  detail.innerHTML = agentDetailHtml(run)
  agentDetailSignature = signature
  agentDetailRenderedAt = Date.now()
  return true
}

function renderAgentDock() {
  const pane = $('#team-pane')
  const list = $('#team-list')
  const detail = $('#team-detail')
  const split = $('#team-split')
  const summary = $('#team-summary')
  if (!pane || !list || !detail) return
  const runs = sortAgentRunsAsTree([...state.agentRuns.values()])
  const empty = $('#team-empty')
  if (empty) empty.hidden = runs.length > 0
  if (split) split.hidden = runs.length === 0
  if (runs.length === 0) {
    if (state.agentSelectedId) state.agentScroll.delete(state.agentSelectedId)
    state.agentSelectedId = ''
    renderAgentList([], '')
    renderAgentDetail(null, true)
    if (summary) summary.textContent = '等待派发'
    syncWorkbenchLayout()
    return
  }
  syncTeamProgressBubbles(runs)
  const active = runs.filter((run) => (run.status || 'running') === 'running').length
  const waiting = runs.filter((run) => run.status === 'waiting').length
  const capacity = state.agentCapacity && Number(state.agentCapacity.limit) > 0
    ? ` / ${Number(state.agentCapacity.limit)} 岗位`
    : ''
  if (summary) {
    summary.textContent = waiting > 0
      ? `${active} 工作中 · ${waiting} 待回答 · 共 ${runs.length}${capacity}`
      : active > 0
        ? `${active} 工作中 · 共 ${runs.length}${capacity}`
        : `${runs.length}${capacity} · 已全部完成`
  }
  const parent = $('#team-manager-name')
  if (parent) parent.textContent = `主 Agent · ${state.agentParentName || '当前对话'}`
  // 选中项失效（被注销）时回落到运行中的第一个，否则第一个
  const previousSelectedId = state.agentSelectedId
  let selected = runs.find((run) => run.childId === state.agentSelectedId)
  if (!selected) {
    selected = runs.find((run) => (run.status || 'running') === 'running')
      || runs.find((run) => run.status === 'waiting')
      || runs[0]
    state.agentSelectedId = selected.childId
  }
  const selectionChanged = selected.childId !== previousSelectedId
  if (selectionChanged) {
    // 已完成的窗口被用户切走后，才按空闲期收尾；当前选中窗口一直保留，
    // 这样用户还能上滑看父子对话历史，不会被 2 分钟自动注销打断。
    // 这里从“现在”重新计 2 分钟，避免点一下就让上一个员工立刻从列表消失。
    const previous = state.agentRuns.get(previousSelectedId)
    if (previous && (previous.status || 'running') !== 'running' && previous.status !== 'waiting') {
      scheduleAgentRetire(previousSelectedId, Date.now())
    }
    // 和主对话切换会话一致：切到另一个子 Agent 时从最新消息开始看。
    const scroll = agentThreadState(selected.childId)
    scroll.pinned = true
    scroll.hasNew = false
    scroll.top = 0
    scroll.scrollHeight = 0
  }
  renderAgentList(runs, selected.childId)
  const detailRendered = renderAgentDetail(selected, selectionChanged)
  syncWorkbenchLayout()
  if (detailRendered) restoreAgentThreadScroll(selected.childId, selectionChanged)
}

/** 团队行选中：pointerdown 就先切，不等 click；键盘/无障碍仍走 click。 */
function selectAgentChild(childId) {
  if (!childId || !state.agentRuns.has(childId)) return false
  state.agentUserSelectedAt = Date.now()
  if (state.agentSelectedId === childId) return true
  state.agentSelectedId = childId
  renderAgentDock()
  return true
}

function resetAgentRuns() {
  for (const run of state.agentRuns.values()) {
    if (run.retireTimer) clearTimeout(run.retireTimer)
  }
  if (agentDetailRenderTimer) {
    clearTimeout(agentDetailRenderTimer)
    agentDetailRenderTimer = 0
  }
  state.agentRuns.clear()
  state.agentScroll.clear()
  state.agentSelectedId = ''
  state.agentUserSelectedAt = 0
  state.agentParentRunId = ''
  state.agentParentName = ''
  agentDetailRenderedAt = 0
  agentDetailSignature = ''
  renderAgentDock()
}

/* ---------------- 个人工作区：右侧文件预览与编辑 ---------------- */

let workspacePreviewText = ''
let agentTeamPollTimer = null
let agentTeamPollSeq = 0
let workspacePreviewTextLoaded = false
/** 打开文本预览时的云端原文，用于编辑态的逐行/字符差异对比。 */
let workspacePreviewOriginalText = ''
let workspaceDiffVisible = false
let workspacePreviewObjectUrl = ''
/** 云空间图片走中央大图，不复用右栏预览；连续点图时只保留最后一次。 */
let workspaceImagePreviewToken = 0
let workspacePreviewSaving = false
let workspacePreviewToken = 0
/** PDF 降级预览状态；只对当前打开的 PDF 文件有效。 */
let workspacePdfState = null
let workspacePdfjsPromise = null
let workspacePdfjsLib = null
let workspacePdfLoadSeq = 0
/** 预览打开期间的权限巡检；访问被撤销、文件被删或预览能力失效时关闭右栏。 */
let workspacePreviewWatchTimer = null
let workspacePreviewWatchBusy = false
let workspacePreviewWatchEpoch = 0
/** 关闭右栏预览后，把键盘焦点还给打开它的附件卡/文件行；列表重绘后按文件 id 找回。 */
let workspacePreviewReturnFocus = null
let workspacePreviewReturnFileId = ''
const WORKSPACE_PREVIEW_WATCH_MS = 30_000
/** 模型正在生成的文件内容草稿；只在右侧预览层展示，不参与磁盘写入。 */
let fileStreamDraft = null
/** 当前预览的字符揭示动画；tool 参数一次性到达时也保留打字机可见性。 */
let fileStreamReveal = null
/** Markdown 预览重绘节流：流式参数高频到达时不必每个字符都重排整篇文档。 */
let workspaceMarkdownRenderTimer = 0
let onlyOfficeScriptPromise = null
let onlyOfficeEditor = null
let onlyOfficeMode = 'view'
/** 编辑态收到云端新版本时，警告条绑定的文件 id；空表示没有待刷新提示。 */
let filePaneSyncFileId = ''

function isOfficeLike(file) {
  return /\.(docx?|docm|dotx?|rtf|xlsx?|xlsm|xltx?|pptx?|pptm|potx?|odt|ods|odp|ott|ots|otp)$/i.test(
    file?.name || '',
  )
}

function destroyOnlyOfficeEditor() {
  if (onlyOfficeEditor) {
    try {
      onlyOfficeEditor.destroyEditor()
    } catch {
      /* 编辑器已经关闭或脚本还没完成初始化 */
    }
    onlyOfficeEditor = null
  }
}

function loadOnlyOfficeApi(scriptUrl) {
  if (window.DocsAPI) return Promise.resolve()
  if (onlyOfficeScriptPromise) return onlyOfficeScriptPromise
  onlyOfficeScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = scriptUrl
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => {
      onlyOfficeScriptPromise = null
      reject(new Error('OnlyOffice 脚本加载失败，请检查文档服务地址'))
    }
    document.head.appendChild(script)
  })
  return onlyOfficeScriptPromise
}

async function openWorkspaceOffice(file, mode) {
  const token = workspacePreviewToken
  const owner = file.ownerUserId === state.me?.person?.id
  destroyOnlyOfficeEditor()
  filePaneMessage(mode === 'edit' ? '正在准备编辑…' : '正在加载文档…')
  try {
    const result = await api(
      qsAppend(`/api/workspace/files/${encodeURIComponent(file.id)}/office-config?mode=${mode === 'edit' ? 'edit' : 'view'}`),
    )
    if (token !== workspacePreviewToken || state.filePreview?.id !== file.id) return
    if (!result?.configured) {
      filePaneMessage(result?.reason || 'OnlyOffice 文档服务未配置')
      return
    }
    const holder = document.createElement('div')
    holder.id = 'onlyoffice-editor'
    holder.className = 'onlyoffice-editor'
    setFilePaneBody(holder)
    await loadOnlyOfficeApi(result.scriptUrl)
    if (token !== workspacePreviewToken || state.filePreview?.id !== file.id) return
    onlyOfficeMode = result.mode
    onlyOfficeEditor = new window.DocsAPI.DocEditor('onlyoffice-editor', result.config)
    const edit = $('#file-pane-edit')
    if (edit) {
      edit.hidden = !owner
      edit.textContent = onlyOfficeMode === 'edit' ? '预览' : '编辑'
      edit.title = onlyOfficeMode === 'edit' ? '切换为只读预览' : '在线编辑并保存回云空间'
    }
  } catch (err) {
    if (token !== workspacePreviewToken) return
    filePaneMessage(`文档服务加载失败：${err.message}`, 'bad')
  }
}


function isImageLike(file) {
  const mime = file.mime || file.type || ''
  return /^image\//i.test(mime) || /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(file.name || '')
}

function isPdfLike(file) {
  const mime = file.mime || file.type || ''
  return /^application\/pdf$/i.test(mime) || /\.pdf$/i.test(file.name || '')
}

function setFilePaneBody(node) {
  const body = $('#file-pane-body')
  if (!body) return
  body.innerHTML = ''
  body.appendChild(node)
}

function filePaneMessage(message, tone = 'muted') {
  const holder = document.createElement('div')
  holder.className = `file-pane-empty ${tone === 'bad' ? 'is-bad' : ''}`
  const text = document.createElement('p')
  text.textContent = message
  holder.appendChild(text)
  setFilePaneBody(holder)
  hidePreviewSelection()
}

function hideFilePaneSyncNotice() {
  filePaneSyncFileId = ''
  const notice = $('#file-pane-sync-notice')
  if (notice) notice.hidden = true
  const text = $('#file-pane-sync-text')
  if (text) text.textContent = ''
}

function showFilePaneSyncNotice(fileId, message) {
  const notice = $('#file-pane-sync-notice')
  const text = $('#file-pane-sync-text')
  if (!notice || !text) return
  filePaneSyncFileId = fileId || ''
  text.textContent = message
  notice.hidden = false
  const button = $('#file-pane-refresh')
  if (button) {
    button.disabled = false
    button.textContent = '刷新到云端版本'
  }
}

async function refreshFilePaneToCloudVersion() {
  const fileId = filePaneSyncFileId || String(state.filePreview?.id || '')
  if (!fileId) return
  const file = state.files.find((item) => item.id === fileId)
  const name = file?.name ? `《${file.name}》` : '当前文档'
  const confirmed = window.confirm(
    `刷新到云端版本会关闭 ${name} 当前编辑器，编辑器里还没保存的修改不会合并，会直接丢失。\n\n` +
      '请先点插件“保存到云空间”，或撤销未保存的修改，再刷新。\n\n' +
      '确定现在放弃当前编辑内容并刷新到云端版本吗？',
  )
  if (!confirmed) return
  const button = $('#file-pane-refresh')
  if (button) {
    button.disabled = true
    button.textContent = '正在刷新…'
  }
  try {
    // 先抬高刷新水位：关闭旧编辑器触发的保存回调若仍是旧版本，服务端会丢弃，
    // 避免旧内容覆盖刚多出来的云端版本。
    await api(`/api/workspace/office/${encodeURIComponent(fileId)}/refresh-guard`, {
      method: 'POST',
    })
    hideFilePaneSyncNotice()
    await loadWorkspaceFiles()
    const latest = state.files.find((item) => item.id === fileId)
    if (!latest) {
      closeWorkspaceFile()
      banner('文件已不存在，无法刷新到云端版本', 'bad')
      return
    }
    await openWorkspaceFile(fileId, { mode: 'edit' })
    banner('已刷新到云端版本', 'ok')
  } catch (err) {
    banner(`刷新到云端版本失败：${err.message}`, 'bad')
  } finally {
    if (button) {
      button.disabled = false
      button.textContent = '刷新到云端版本'
    }
  }
}

function hidePreviewSelection() {
  state.previewSelection = null
  const button = $('#file-selection-action')
  if (button) button.hidden = true
}

/**
 * 普通文本/表格预览在父页面 DOM 内，可以直接读取 selection；
 * OnlyOffice 在跨域 iframe 里，父页面拿不到它内部的选区，因此这里只对本地预览生效。
 */
function refreshPreviewSelection() {
  const body = $('#file-pane-body')
  const button = $('#file-selection-action')
  const file = state.filePreview
  if (!body || !button || !file) {
    hidePreviewSelection()
    return
  }
  const selection = window.getSelection()
  const rangeText = selection?.rangeCount ? String(selection.getRangeAt(0).toString() || '') : ''
  const text = String(selection?.toString?.() || rangeText || '').replace(/\s+/g, ' ').trim()
  const anchor = selection?.anchorNode
  if (!text || !anchor || !body.contains(anchor)) {
    hidePreviewSelection()
    return
  }
  state.previewSelection = { fileId: file.id, fileName: file.name, text: text.slice(0, 800) }
  button.hidden = false
  button.textContent = '引用选中内容并修改'
}

function quotePreviewSelection() {
  const selected = state.previewSelection
  const input = $('#input')
  if (!selected || !input) return
  if (state.mode !== 'chat') {
    setChatMode('chat')
    if (state.filePreview?.id) void openWorkspaceFile(state.filePreview.id, { split: true })
  }
  const truncated = String(selected.text).length >= 800 ? '\n（选中的内容较长，已截取前 800 字）' : ''
  input.value = `请修改《${selected.fileName}》中的这段内容：\n"""${selected.text}"""${truncated}\n\n修改要求：`
  input.style.height = '44px'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.focus()
  const end = input.value.length
  input.setSelectionRange(end, end)
  hidePreviewSelection()
  const selection = window.getSelection()
  selection?.removeAllRanges?.()
}

const WORKSPACE_DIFF_MAX_LINES = 20_000
const WORKSPACE_DIFF_MAX_MATRIX = 1_000_000
const WORKSPACE_DIFF_MAX_CHAR_MATRIX = 160_000
const WORKSPACE_DIFF_CONTEXT = 2
const WORKSPACE_DIFF_MAX_RENDER = 5_000

function splitWorkspaceDiffLines(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
}

/**
 * 行级 LCS + 相邻删除/新增行的字符级 LCS。
 * 大文件先按共同前后缀裁剪；改动块过大时退化为整段删除/新增，避免 UI 卡死。
 */
function buildWorkspaceTextDiff(oldText, newText) {
  const oldLines = splitWorkspaceDiffLines(oldText)
  const newLines = splitWorkspaceDiffLines(newText)
  if (oldLines.length > WORKSPACE_DIFF_MAX_LINES || newLines.length > WORKSPACE_DIFF_MAX_LINES) {
    return { tooManyLines: true, rows: [], changed: false, oldLines: oldLines.length, newLines: newLines.length }
  }
  const oldCount = oldLines.length
  const newCount = newLines.length
  const maxCommon = Math.min(oldCount, newCount)
  let prefix = 0
  while (prefix < maxCommon && oldLines[prefix] === newLines[prefix]) prefix += 1
  let suffix = 0
  while (suffix < maxCommon - prefix && oldLines[oldCount - 1 - suffix] === newLines[newCount - 1 - suffix]) suffix += 1

  const rows = []
  for (let i = 0; i < prefix; i += 1) {
    rows.push({ type: 'same', text: oldLines[i], oldNo: i + 1, newNo: i + 1 })
  }
  const oldMid = oldLines.slice(prefix, oldCount - suffix)
  const newMid = newLines.slice(prefix, newCount - suffix)
  let coarse = false
  if (oldMid.length * newMid.length > WORKSPACE_DIFF_MAX_MATRIX) {
    coarse = true
    for (let i = 0; i < oldMid.length; i += 1) {
      rows.push({ type: 'del', text: oldMid[i], oldNo: prefix + i + 1, newNo: null })
    }
    for (let j = 0; j < newMid.length; j += 1) {
      rows.push({ type: 'add', text: newMid[j], oldNo: null, newNo: prefix + j + 1 })
    }
  } else {
    const midRows = buildWorkspaceLineDiffRows(oldMid, newMid, prefix)
    for (const row of midRows) rows.push(row)
  }
  for (let k = 0; k < suffix; k += 1) {
    rows.push({
      type: 'same',
      text: oldLines[oldCount - suffix + k],
      oldNo: oldCount - suffix + k + 1,
      newNo: newCount - suffix + k + 1,
    })
  }

  const stats = annotateWorkspaceDiffRows(rows)
  const changed = stats.added + stats.removed + stats.modified > 0
  return { tooManyLines: false, rows, changed, stats, coarse, oldLines: oldCount, newLines: newCount }
}

function buildWorkspaceLineDiffRows(oldLines, newLines, startLine) {
  const m = oldLines.length
  const n = newLines.length
  const width = n + 1
  const dp = new Uint32Array((m + 1) * width)
  for (let i = m - 1; i >= 0; i -= 1) {
    const row = i * width
    const next = (i + 1) * width
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[row + j] = oldLines[i] === newLines[j]
        ? dp[next + j + 1] + 1
        : Math.max(dp[next + j], dp[row + j + 1])
    }
  }
  const rows = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      rows.push({ type: 'same', text: oldLines[i], oldNo: startLine + i + 1, newNo: startLine + j + 1 })
      i += 1
      j += 1
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      rows.push({ type: 'del', text: oldLines[i], oldNo: startLine + i + 1, newNo: null })
      i += 1
    } else {
      rows.push({ type: 'add', text: newLines[j], oldNo: null, newNo: startLine + j + 1 })
      j += 1
    }
  }
  while (i < m) {
    rows.push({ type: 'del', text: oldLines[i], oldNo: startLine + i + 1, newNo: null })
    i += 1
  }
  while (j < n) {
    rows.push({ type: 'add', text: newLines[j], oldNo: null, newNo: startLine + j + 1 })
    j += 1
  }
  return rows
}

function annotateWorkspaceDiffRows(rows) {
  const stats = { added: 0, removed: 0, modified: 0 }
  let i = 0
  while (i < rows.length) {
    if (rows[i].type === 'same') {
      i += 1
      continue
    }
    let end = i
    while (end < rows.length && rows[end].type !== 'same') end += 1
    const dels = []
    const adds = []
    for (let k = i; k < end; k += 1) {
      if (rows[k].type === 'del') dels.push(rows[k])
      else if (rows[k].type === 'add') adds.push(rows[k])
    }
    const paired = Math.min(dels.length, adds.length)
    for (let k = 0; k < paired; k += 1) {
      const charDiff = buildWorkspaceCharDiff(dels[k].text, adds[k].text)
      if (charDiff) {
        dels[k].segments = charDiff.old
        adds[k].segments = charDiff.new
      }
      stats.modified += 1
    }
    stats.removed += dels.length - paired
    stats.added += adds.length - paired
    i = end
  }
  return stats
}

function buildWorkspaceCharDiff(oldLine, newLine) {
  const a = String(oldLine ?? '')
  const b = String(newLine ?? '')
  if (a === b) {
    return { old: [{ text: a, changed: false }], new: [{ text: b, changed: false }] }
  }
  if (!a || !b) {
    return {
      old: a ? [{ text: a, changed: true }] : [],
      new: b ? [{ text: b, changed: true }] : [],
    }
  }
  if (a.length * b.length > WORKSPACE_DIFF_MAX_CHAR_MATRIX || a.length > 1_000 || b.length > 1_000) return null
  const m = a.length
  const n = b.length
  const width = n + 1
  const dp = new Uint32Array((m + 1) * width)
  for (let i = m - 1; i >= 0; i -= 1) {
    const row = i * width
    const next = (i + 1) * width
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[row + j] = a[i] === b[j]
        ? dp[next + j + 1] + 1
        : Math.max(dp[next + j], dp[row + j + 1])
    }
  }
  const oldSegments = []
  const newSegments = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      appendWorkspaceDiffSegment(oldSegments, a[i], false)
      appendWorkspaceDiffSegment(newSegments, b[j], false)
      i += 1
      j += 1
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      appendWorkspaceDiffSegment(oldSegments, a[i], true)
      i += 1
    } else {
      appendWorkspaceDiffSegment(newSegments, b[j], true)
      j += 1
    }
  }
  while (i < m) {
    appendWorkspaceDiffSegment(oldSegments, a[i], true)
    i += 1
  }
  while (j < n) {
    appendWorkspaceDiffSegment(newSegments, b[j], true)
    j += 1
  }
  return { old: oldSegments, new: newSegments }
}

function appendWorkspaceDiffSegment(list, text, changed) {
  const value = String(text ?? '')
  if (!value) return
  const last = list[list.length - 1]
  if (last && last.changed === changed) last.text += value
  else list.push({ text: value, changed })
}

function renderWorkspaceDiff(result) {
  if (result.tooManyLines) {
    return `<div class="file-diff-empty" role="status">文件超过 ${WORKSPACE_DIFF_MAX_LINES.toLocaleString('zh-CN')} 行，暂不生成逐行差异。<br>可保存后下载，用本地工具比较。</div>`
  }
  if (!result.changed) {
    return '<div class="file-diff-empty" role="status">当前编辑内容与打开时的云端原文一致。</div>'
  }
  const label = []
  if (result.stats.modified) label.push(`修改 ${result.stats.modified} 行`)
  if (result.stats.added) label.push(`新增 ${result.stats.added} 行`)
  if (result.stats.removed) label.push(`删除 ${result.stats.removed} 行`)
  const visible = new Set()
  for (let i = 0; i < result.rows.length; i += 1) {
    if (result.rows[i].type === 'same') continue
    const from = Math.max(0, i - WORKSPACE_DIFF_CONTEXT)
    const to = Math.min(result.rows.length - 1, i + WORKSPACE_DIFF_CONTEXT)
    for (let k = from; k <= to; k += 1) visible.add(k)
  }
  let html = `<div class="file-diff-head"><div class="file-diff-summary" role="status">${esc(label.join(' · '))}</div><div class="file-diff-meta">基线：打开时的云端原文 · ${result.oldLines} 行 → 当前 ${result.newLines} 行</div></div>`
  if (result.coarse) {
    html += '<div class="file-diff-note">改动区域较大，已按整段标记，未做字符级细分。</div>'
  }
  let lastShown = -1
  let rendered = 0
  for (let i = 0; i < result.rows.length; i += 1) {
    if (!visible.has(i)) continue
    const gap = lastShown < 0 ? i : i - lastShown - 1
    if (gap > 0) html += `<div class="file-diff-gap">… 未改动 ${gap} 行 …</div>`
    const row = result.rows[i]
    const gutter = row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' '
    const oldNo = row.oldNo == null ? '' : String(row.oldNo)
    const newNo = row.newNo == null ? '' : String(row.newNo)
    const code = renderWorkspaceDiffCode(row)
    html += `<div class="file-diff-row is-${row.type}"><span class="file-diff-gutter">${gutter}</span><span class="file-diff-no">${oldNo}</span><span class="file-diff-no">${newNo}</span><span class="file-diff-code">${code}</span></div>`
    lastShown = i
    rendered += 1
    if (rendered >= WORKSPACE_DIFF_MAX_RENDER && i < result.rows.length - 1) {
      html += `<div class="file-diff-gap">差异较多，仅显示前 ${WORKSPACE_DIFF_MAX_RENDER.toLocaleString('zh-CN')} 行。</div>`
      return html
    }
  }
  if (lastShown >= 0 && lastShown < result.rows.length - 1) {
    html += `<div class="file-diff-gap">… 未改动 ${result.rows.length - lastShown - 1} 行 …</div>`
  }
  return html
}

function renderWorkspaceDiffCode(row) {
  if (row.type === 'same' || !row.segments) {
    return esc(row.text || '') || '&nbsp;'
  }
  return row.segments
    .map((segment) => `<span class="file-diff-char is-${row.type}${segment.changed ? ' is-changed' : ''}">${esc(segment.text) || '&nbsp;'}</span>`)
    .join('')
}

function toggleWorkspaceDiff() {
  const file = state.filePreview
  if (!file || !workspacePreviewTextLoaded) return
  const textarea = $('#file-pane-text')
  const panel = $('#file-pane-diff')
  const toggle = $('#file-pane-diff-toggle')
  if (!textarea || !panel || !toggle) return
  if (workspaceDiffVisible) {
    panel.hidden = true
    panel.innerHTML = ''
    textarea.hidden = false
    workspaceDiffVisible = false
    toggle.textContent = '查看差异'
    toggle.setAttribute('aria-pressed', 'false')
    textarea.focus()
    return
  }
  const result = buildWorkspaceTextDiff(workspacePreviewOriginalText, textarea.value)
  panel.innerHTML = renderWorkspaceDiff(result)
  panel.hidden = false
  textarea.hidden = true
  workspaceDiffVisible = true
  toggle.textContent = '返回编辑'
  toggle.setAttribute('aria-pressed', 'true')
}


function releaseWorkspacePreviewUrl() {
  releaseWorkspacePdf()
  if (workspacePreviewObjectUrl) {
    URL.revokeObjectURL(workspacePreviewObjectUrl)
    workspacePreviewObjectUrl = ''
  }
}

function releaseWorkspacePdf() {
  const preview = workspacePdfState
  workspacePdfState = null
  workspacePdfLoadSeq += 1
  if (!preview) return
  try {
    preview.resizeObserver?.disconnect()
  } catch {
    // 旧浏览器没有 ResizeObserver，忽略。
  }
  if (preview.resizeTimer) clearTimeout(preview.resizeTimer)
  try {
    preview.renderTask?.cancel()
  } catch {
    // 渲染任务可能已经结束。
  }
  try {
    preview.textLayerTask?.cancel()
  } catch {
    // 文本层可能已经结束。
  }
  try {
    preview.doc?.destroy()
  } catch {
    // 文档已经销毁。
  }
}

const PDF_ANNOTATION_PREFIX = 'eab:pdf-annotations:v1:'
const PDF_ANNOTATION_MAX = 100
const PDF_VIEW_MAX_TEXT = 200_000

function ensureWorkspacePdfjs() {
  if (workspacePdfjsLib) return Promise.resolve(workspacePdfjsLib)
  if (!workspacePdfjsPromise) {
    workspacePdfjsPromise = import('/vendor/pdfjs/build/pdf.min.mjs')
      .then((lib) => {
        lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.min.mjs'
        workspacePdfjsLib = lib
        return lib
      })
      .catch((err) => {
        workspacePdfjsPromise = null
        throw err
      })
  }
  return workspacePdfjsPromise
}

function workspacePdfAnnotationKey(file) {
  return `${PDF_ANNOTATION_PREFIX}${file.id}:${file.updatedAt || file.size || 0}`
}

function readWorkspacePdfAnnotations(file) {
  try {
    const raw = JSON.parse(localStorage.getItem(workspacePdfAnnotationKey(file)) || '[]')
    if (!Array.isArray(raw)) return []
    return raw
      .filter((item) => {
        const rect = item?.rect
        return (
          typeof item?.id === 'string' &&
          Number.isFinite(item?.page) &&
          Array.isArray(rect) &&
          rect.length === 4 &&
          rect.every((value) => Number.isFinite(value) && value >= 0 && value <= 1) &&
          rect[2] - rect[0] > 0.002 &&
          rect[3] - rect[1] > 0.002
        )
      })
      .slice(0, PDF_ANNOTATION_MAX)
  } catch {
    return []
  }
}

function writeWorkspacePdfAnnotations(file, annotations) {
  try {
    localStorage.setItem(workspacePdfAnnotationKey(file), JSON.stringify(annotations.slice(0, PDF_ANNOTATION_MAX)))
    return true
  } catch {
    return false
  }
}

async function openWorkspacePdfPreview(file, blob, token) {
  const lib = await ensureWorkspacePdfjs()
  if (token !== workspacePreviewToken || state.filePreview?.id !== file.id) return
  const data = await blob.arrayBuffer()
  if (token !== workspacePreviewToken || state.filePreview?.id !== file.id) return
  filePaneMessage('正在加载 PDF…')
  const loadSeq = ++workspacePdfLoadSeq
  const doc = await lib.getDocument({
    data,
    cMapUrl: '/vendor/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
    wasmUrl: '/vendor/pdfjs/wasm/',
    iccUrl: '/vendor/pdfjs/iccs/',
    useSystemFonts: true,
  }).promise
  if (loadSeq !== workspacePdfLoadSeq || token !== workspacePreviewToken || state.filePreview?.id !== file.id) {
    try {
      doc.destroy()
    } catch {
      // 过期文档直接丢弃。
    }
    return
  }
  const annotations = readWorkspacePdfAnnotations(file)
  const viewer = buildWorkspacePdfViewer(file, doc, annotations, lib)
  workspacePdfState = viewer
  setFilePaneBody(viewer.root)
  bindWorkspacePdfViewer(viewer)
  await renderWorkspacePdfPage({ resetScroll: true })
  // 独立云空间里把焦点交给页码；对话内预览不抢聊天输入框的焦点。
  if (state.mode === 'workspace') viewer.root.querySelector('[data-pdf-page-input]')?.focus({ preventScroll: true })
}

function buildWorkspacePdfViewer(file, doc, annotations, lib) {
  const root = document.createElement('div')
  root.className = 'pdf-viewer'
  root.innerHTML = `
    <div class="pdf-toolbar">
      <div class="pdf-nav" role="group" aria-label="PDF 翻页">
        <button class="btn ghost sm" type="button" data-pdf-prev aria-label="上一页">‹</button>
        <span class="pdf-page-label">第 <input class="pdf-page-input" data-pdf-page-input type="number" min="1" value="1" inputmode="numeric" aria-label="页码" /> / <span data-pdf-page-count>—</span> 页</span>
        <button class="btn ghost sm" type="button" data-pdf-next aria-label="下一页">›</button>
      </div>
      <div class="pdf-actions">
        <div class="pdf-zoom" role="group" aria-label="PDF 缩放">
          <button class="btn ghost sm" type="button" data-pdf-zoom-out aria-label="缩小">−</button>
          <span class="pdf-zoom-label" data-pdf-zoom-label>适应</span>
          <button class="btn ghost sm" type="button" data-pdf-zoom-in aria-label="放大">＋</button>
          <button class="btn ghost sm" type="button" data-pdf-fit>适应宽度</button>
        </div>
        <button class="btn ghost sm is-active" type="button" data-pdf-tool="select" aria-pressed="true">选文本</button>
        <button class="btn ghost sm" type="button" data-pdf-tool="region" aria-pressed="false">框选区域</button>
        <button class="btn ghost sm" type="button" data-pdf-text-toggle aria-expanded="false">提取文本</button>
        <button class="btn ghost sm" type="button" data-pdf-annotations-toggle aria-expanded="false">批注 <span class="pdf-count" data-pdf-annotation-count>0</span></button>
      </div>
    </div>
    <div class="pdf-draft" data-pdf-draft hidden>
      <div class="pdf-draft-head"><strong>区域批注</strong><span data-pdf-draft-page>第 1 页</span></div>
      <blockquote class="pdf-draft-quote" data-pdf-draft-quote>（图片区域，未识别到文本）</blockquote>
      <textarea class="pdf-draft-comment" data-pdf-draft-comment rows="2" maxlength="500" placeholder="补充批注（可选）"></textarea>
      <div class="pdf-draft-actions">
        <button class="btn ghost sm" type="button" data-pdf-draft-cancel>取消</button>
        <button class="btn primary sm" type="button" data-pdf-draft-save>添加高亮</button>
      </div>
    </div>
    <div class="pdf-text-panel" data-pdf-text-panel hidden>
      <div class="pdf-panel-head">
        <strong>本页文本</strong>
        <span class="muted" data-pdf-text-page>第 1 页</span>
        <button class="btn ghost sm" type="button" data-pdf-text-copy>复制</button>
        <button class="btn ghost sm" type="button" data-pdf-text-quote>引用到对话</button>
        <button class="icon-btn" type="button" data-pdf-text-close aria-label="关闭文本面板">×</button>
      </div>
      <pre class="pdf-text-content" data-pdf-text-content></pre>
    </div>
    <div class="pdf-annotation-panel" data-pdf-annotation-panel hidden>
      <div class="pdf-panel-head">
        <strong>批注</strong>
        <span class="muted" data-pdf-annotation-note>仅保存在本机</span>
        <button class="icon-btn" type="button" data-pdf-annotations-close aria-label="关闭批注面板">×</button>
      </div>
      <div class="pdf-annotation-list" data-pdf-annotation-list></div>
    </div>
    <div class="pdf-stage" data-pdf-stage tabindex="0" aria-label="PDF 页面">
      <div class="pdf-page-shell">
        <div class="pdf-page" data-pdf-page>
          <div class="pdf-page-loading" data-pdf-loading>正在渲染第 1 页…</div>
        </div>
      </div>
    </div>
    <div class="pdf-status" role="status" aria-live="polite" data-pdf-status>正在加载 PDF…</div>
  `
  const page = root.querySelector('[data-pdf-page]')
  const canvas = document.createElement('canvas')
  canvas.className = 'pdf-canvas'
  canvas.setAttribute('aria-hidden', 'true')
  const textLayer = document.createElement('div')
  textLayer.className = 'pdf-text-layer textLayer'
  textLayer.setAttribute('aria-hidden', 'true')
  const annotationLayer = document.createElement('div')
  annotationLayer.className = 'pdf-annotation-layer'
  const draftLayer = document.createElement('div')
  draftLayer.className = 'pdf-region-draft'
  draftLayer.hidden = true
  const loading = root.querySelector('[data-pdf-loading]')
  page.prepend(draftLayer, annotationLayer, textLayer, canvas)

  return {
    root,
    file,
    doc,
    lib,
    annotations,
    page: 1,
    pageCount: doc.numPages,
    zoom: 1,
    tool: 'select',
    pageEl: page,
    stage: root.querySelector('[data-pdf-stage]'),
    canvas,
    textLayer,
    annotationLayer,
    draftLayer,
    loading,
    textContent: null,
    textItems: [],
    pageText: '',
    pendingRegion: null,
    renderTask: null,
    textLayerTask: null,
    renderSeq: 0,
    resizeObserver: null,
    resizeTimer: null,
    statusEl: root.querySelector('[data-pdf-status]'),
    pageInput: root.querySelector('[data-pdf-page-input]'),
    pageCountEl: root.querySelector('[data-pdf-page-count]'),
    zoomLabel: root.querySelector('[data-pdf-zoom-label]'),
    draft: root.querySelector('[data-pdf-draft]'),
    draftPage: root.querySelector('[data-pdf-draft-page]'),
    draftQuote: root.querySelector('[data-pdf-draft-quote]'),
    draftComment: root.querySelector('[data-pdf-draft-comment]'),
    textPanel: root.querySelector('[data-pdf-text-panel]'),
    textPage: root.querySelector('[data-pdf-text-page]'),
    textContentEl: root.querySelector('[data-pdf-text-content]'),
    annotationPanel: root.querySelector('[data-pdf-annotation-panel]'),
    annotationList: root.querySelector('[data-pdf-annotation-list]'),
  }
}

function setWorkspacePdfStatus(text, bad = false) {
  const preview = workspacePdfState
  if (!preview?.statusEl) return
  preview.statusEl.textContent = text
  preview.statusEl.classList.toggle('is-bad', bad)
}

function workspacePdfTextFromContent(content) {
  const items = (content?.items || []).filter((item) => typeof item?.str === 'string')
  let text = ''
  for (const item of items) {
    text += item.str
    if (item.hasEOL) text += '\n'
    else if (item.str) text += ' '
  }
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, PDF_VIEW_MAX_TEXT)
}

function workspacePdfTextItemsFromContent(content, viewport) {
  const items = []
  for (const item of content?.items || []) {
    if (typeof item?.str !== 'string' || !item.str.trim()) continue
    const tx = workspacePdfState?.lib?.Util?.transform?.(viewport.transform, item.transform)
    if (!tx) continue
    const height = Math.hypot(tx[2], tx[3])
    const width = Math.max(0, Number(item.width) || 0) * viewport.scale
    if (!Number.isFinite(height) || height <= 0) continue
    items.push({
      str: item.str,
      left: tx[4],
      top: tx[5] - height,
      right: tx[4] + Math.max(1, width),
      bottom: tx[5],
    })
  }
  items.sort((a, b) => Math.abs(a.top - b.top) > 2 ? a.top - b.top : a.left - b.left)
  return items
}

function workspacePdfPageCssSize(preview) {
  return {
    width: parseFloat(preview?.pageEl?.style.width) || preview?.pageEl?.clientWidth || 1,
    height: parseFloat(preview?.pageEl?.style.height) || preview?.pageEl?.clientHeight || 1,
  }
}

function workspacePdfTextFromRegion(preview, rect) {
  const { width, height } = workspacePdfPageCssSize(preview)
  const box = {
    left: rect[0] * width,
    top: rect[1] * height,
    right: rect[2] * width,
    bottom: rect[3] * height,
  }
  const selected = preview.textItems.filter((item) => {
    const cx = (item.left + item.right) / 2
    const cy = (item.top + item.bottom) / 2
    return cx >= box.left && cx <= box.right && cy >= box.top && cy <= box.bottom
  })
  return selected.map((item) => item.str).join(' ').replace(/[ \t]{2,}/g, ' ').trim().slice(0, 800)
}

function paintWorkspacePdfDraft(preview) {
  if (!preview?.pendingRegion) {
    preview.draftLayer.hidden = true
    return
  }
  const { width, height } = workspacePdfPageCssSize(preview)
  const [x1, y1, x2, y2] = preview.pendingRegion.rect
  preview.draftLayer.hidden = false
  preview.draftLayer.style.left = `${x1 * width}px`
  preview.draftLayer.style.top = `${y1 * height}px`
  preview.draftLayer.style.width = `${(x2 - x1) * width}px`
  preview.draftLayer.style.height = `${(y2 - y1) * height}px`
}

function updateWorkspacePdfChrome(preview) {
  const prev = preview.root.querySelector('[data-pdf-prev]')
  const next = preview.root.querySelector('[data-pdf-next]')
  preview.pageInput.value = String(preview.page)
  preview.pageInput.max = String(preview.pageCount)
  preview.pageCountEl.textContent = String(preview.pageCount)
  if (prev) prev.disabled = preview.page <= 1
  if (next) next.disabled = preview.page >= preview.pageCount
  preview.zoomLabel.textContent = preview.zoom === 1 ? '适应' : `${Math.round(preview.zoom * 100)}%`
  preview.root.querySelector('[data-pdf-annotation-count]').textContent = String(preview.annotations.length)
}

function applyWorkspacePdfTool(tool, { silent = false } = {}) {
  const preview = workspacePdfState
  if (!preview) return
  preview.tool = tool === 'region' ? 'region' : 'select'
  preview.pageEl.classList.toggle('is-region-mode', preview.tool === 'region')
  for (const button of preview.root.querySelectorAll('[data-pdf-tool]')) {
    const active = button.dataset.pdfTool === preview.tool
    button.classList.toggle('is-active', active)
    button.setAttribute('aria-pressed', String(active))
  }
  if (preview.tool === 'select') cancelWorkspacePdfDraft({ silent: true })
  if (!silent) {
    setWorkspacePdfStatus(preview.tool === 'region' ? '在页面上拖拽框选区域，松开后可添加高亮批注' : '可拖选文本，或切换到“框选区域”做高亮批注')
  }
}

function cancelWorkspacePdfDraft({ silent = false } = {}) {
  const preview = workspacePdfState
  if (!preview) return
  preview.pendingRegion = null
  preview.draft.hidden = true
  preview.draftLayer.hidden = true
  preview.draftComment.value = ''
  if (!silent) setWorkspacePdfStatus('已取消框选')
}

function startWorkspacePdfDraft(preview, rect) {
  const quote = workspacePdfTextFromRegion(preview, rect)
  preview.pendingRegion = { rect, quote }
  preview.draft.hidden = false
  paintWorkspacePdfDraft(preview)
  preview.draftPage.textContent = `第 ${preview.page} 页`
  preview.draftQuote.textContent = quote || '（图片区域，未识别到文本）'
  preview.draftComment.value = ''
  preview.draftComment.focus({ preventScroll: true })
  setWorkspacePdfStatus('已框选区域，可补充批注后添加高亮')
}

function saveWorkspacePdfDraft() {
  const preview = workspacePdfState
  if (!preview?.pendingRegion) return
  const quote = String(preview.pendingRegion.quote || '').slice(0, 800)
  const comment = String(preview.draftComment.value || '').trim().slice(0, 500)
  if (preview.annotations.length >= PDF_ANNOTATION_MAX) {
    setWorkspacePdfStatus(`最多保存 ${PDF_ANNOTATION_MAX} 条批注，请先删除旧批注`, true)
    return
  }
  const annotation = {
    id: `pdf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    page: preview.page,
    rect: preview.pendingRegion.rect,
    quote,
    comment,
    createdAt: Date.now(),
  }
  preview.annotations.push(annotation)
  const persisted = writeWorkspacePdfAnnotations(preview.file, preview.annotations)
  preview.pendingRegion = null
  preview.draft.hidden = true
  preview.draftLayer.hidden = true
  preview.draftComment.value = ''
  applyWorkspacePdfTool('select', { silent: true })
  updateWorkspacePdfChrome(preview)
  renderWorkspacePdfAnnotations()
  renderWorkspacePdfAnnotationList()
  preview.stage.focus({ preventScroll: true })
  setWorkspacePdfStatus(
    persisted
      ? `已添加第 ${preview.annotations.length} 条高亮批注（仅保存在本机）`
      : '高亮已添加，但本机存储失败，刷新后会丢失',
    !persisted,
  )
}

function flashWorkspacePdfAnnotation(id) {
  const preview = workspacePdfState
  if (!preview) return
  const element = [...preview.annotationLayer.querySelectorAll('[data-pdf-annotation-id]')].find(
    (node) => node.dataset.pdfAnnotationId === id,
  )
  if (!element) return
  element.classList.add('is-pulse')
  window.setTimeout(() => element.classList.remove('is-pulse'), 1600)
}

function renderWorkspacePdfAnnotations() {
  const preview = workspacePdfState
  if (!preview?.annotationLayer) return
  preview.annotationLayer.innerHTML = ''
  preview.annotations
    .filter((annotation) => annotation.page === preview.page)
    .forEach((annotation) => {
      const index = preview.annotations.indexOf(annotation) + 1
      const node = document.createElement('div')
      node.className = 'pdf-annotation'
      node.dataset.pdfAnnotationId = annotation.id
      node.style.left = `${annotation.rect[0] * 100}%`
      node.style.top = `${annotation.rect[1] * 100}%`
      node.style.width = `${(annotation.rect[2] - annotation.rect[0]) * 100}%`
      node.style.height = `${(annotation.rect[3] - annotation.rect[1]) * 100}%`
      node.title = [annotation.quote, annotation.comment].filter(Boolean).join('\n')
      const badge = document.createElement('span')
      badge.className = 'pdf-annotation-index'
      badge.textContent = String(index)
      node.appendChild(badge)
      preview.annotationLayer.appendChild(node)
    })
}

function renderWorkspacePdfAnnotationList() {
  const preview = workspacePdfState
  if (!preview?.annotationList) return
  preview.annotationList.innerHTML = ''
  const note = preview.root.querySelector('[data-pdf-annotation-note]')
  if (note) note.textContent = `${preview.annotations.length} 条 · 仅保存在本机`
  if (!preview.annotations.length) {
    const empty = document.createElement('div')
    empty.className = 'pdf-panel-empty'
    empty.textContent = '还没有批注。切换到“框选区域”，在页面上拖拽即可添加高亮。'
    preview.annotationList.appendChild(empty)
    return
  }
  preview.annotations.forEach((annotation, index) => {
    const row = document.createElement('div')
    row.className = 'pdf-annotation-item'
    row.dataset.pdfAnnotationId = annotation.id
    const open = document.createElement('button')
    open.type = 'button'
    open.className = 'pdf-annotation-open'
    open.dataset.pdfAnnotationOpen = annotation.id
    open.setAttribute('aria-label', `定位第 ${index + 1} 条批注`)
    const quote = annotation.quote || '图片区域'
    const comment = annotation.comment ? `<span class="pdf-annotation-comment">${esc(annotation.comment)}</span>` : ''
    open.innerHTML = `
      <span class="pdf-annotation-item-index">${index + 1}</span>
      <span class="pdf-annotation-item-main">
        <span class="pdf-annotation-item-meta">第 ${annotation.page} 页</span>
        <span class="pdf-annotation-item-quote">${esc(quote)}</span>
        ${comment}
      </span>
    `
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'icon-btn pdf-annotation-delete'
    remove.dataset.pdfAnnotationDelete = annotation.id
    remove.setAttribute('aria-label', `删除第 ${index + 1} 条批注`)
    remove.textContent = '×'
    row.append(open, remove)
    preview.annotationList.appendChild(row)
  })
}

function renderWorkspacePdfTextPanel() {
  const preview = workspacePdfState
  if (!preview?.textPanel) return
  preview.textPage.textContent = `第 ${preview.page} 页`
  preview.textContentEl.textContent = preview.pageText || '本页没有可提取的文本（可能是扫描件）。'
  for (const button of preview.root.querySelectorAll('[data-pdf-text-copy], [data-pdf-text-quote]')) {
    button.disabled = !preview.pageText
  }
}

function workspacePdfPageText(preview) {
  return String(preview?.pageText || '').slice(0, 800)
}

function copyWorkspacePdfText(text, label = '本页文本') {
  if (!text) {
    setWorkspacePdfStatus('没有可复制的文本', true)
    return
  }
  const done = () => setWorkspacePdfStatus(`已复制${label}`)
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done, () => fallbackCopyWorkspacePdfText(text, done))
    return
  }
  fallbackCopyWorkspacePdfText(text, done)
}

function fallbackCopyWorkspacePdfText(text, done) {
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.left = '-9999px'
  document.body.appendChild(area)
  area.select()
  try {
    if (document.execCommand('copy')) done()
    else setWorkspacePdfStatus('复制失败，请手动选中文本复制', true)
  } catch {
    setWorkspacePdfStatus('复制失败，请手动选中文本复制', true)
  } finally {
    area.remove()
  }
}

function quoteWorkspacePdfPage(preview) {
  const text = workspacePdfPageText(preview)
  if (!text) {
    setWorkspacePdfStatus('本页没有可引用的文本', true)
    return
  }
  if (state.mode !== 'chat') {
    setChatMode('chat')
    if (state.filePreview?.id) void openWorkspaceFile(state.filePreview.id, { split: true })
  }
  const input = $('#input')
  if (!input) return
  const truncated = String(preview.pageText).length >= 800 ? '\n（本页文本较长，已截取前 800 字）' : ''
  input.value = `请基于《${preview.file.name}》第 ${preview.page} 页的这段内容继续：\n"""${text}"""${truncated}\n\n`
  input.style.height = '44px'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.focus()
  const end = input.value.length
  input.setSelectionRange(end, end)
  setWorkspacePdfStatus('已把本页文本引用到对话输入框')
}

async function renderWorkspacePdfPage({ resetScroll = false } = {}) {
  const preview = workspacePdfState
  if (!preview) return
  const seq = ++preview.renderSeq
  try {
    preview.renderTask?.cancel()
  } catch {
    // 上一页可能已经渲染完成。
  }
  try {
    preview.textLayerTask?.cancel()
  } catch {
    // 文本层可能已经结束。
  }
  preview.loading.hidden = false
  preview.loading.textContent = `正在渲染第 ${preview.page} 页…`
  preview.textLayer.innerHTML = ''
  preview.annotationLayer.innerHTML = ''
  preview.pageEl.setAttribute('aria-label', `PDF 第 ${preview.page} 页`)
  preview.pageEl.classList.toggle('is-region-mode', preview.tool === 'region')
  try {
    const page = await preview.doc.getPage(preview.page)
    if (seq !== preview.renderSeq || workspacePdfState !== preview) return
    const baseViewport = page.getViewport({ scale: 1 })
    const stageWidth = Math.max(260, preview.stage.clientWidth || 520)
    // clientWidth 含 .pdf-stage 的左右各 16px 内边距；只留页面本身，否则会多出 4px 横向滚动。
    const fitScale = Math.max(0.2, (stageWidth - 32) / baseViewport.width)
    const scale = fitScale * preview.zoom
    const viewport = page.getViewport({ scale })
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    preview.canvas.width = Math.floor(viewport.width * dpr)
    preview.canvas.height = Math.floor(viewport.height * dpr)
    preview.canvas.style.width = `${viewport.width}px`
    preview.canvas.style.height = `${viewport.height}px`
    preview.pageEl.style.width = `${viewport.width}px`
    preview.pageEl.style.height = `${viewport.height}px`
    preview.pageEl.style.setProperty('--total-scale-factor', String(viewport.scale))
    preview.pageEl.style.setProperty('--scale-round-x', '1px')
    preview.pageEl.style.setProperty('--scale-round-y', '1px')
    preview.pageWidth = viewport.width
    preview.pageHeight = viewport.height
    const ctx = preview.canvas.getContext('2d', { alpha: false })
    preview.renderTask = page.render({
      canvasContext: ctx,
      viewport,
      // 后台标签页的 requestAnimationFrame 会被暂停；用 print 意图完成一次性绘制，避免预览一直停在“正在渲染”。
      intent: document.hidden ? 'print' : 'display',
      transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
    })
    await preview.renderTask.promise
    if (seq !== preview.renderSeq || workspacePdfState !== preview) return
    let content = null
    try {
      content = await page.getTextContent()
    } catch {
      content = null
    }
    if (seq !== preview.renderSeq || workspacePdfState !== preview) return
    preview.textContent = content
    preview.pageText = workspacePdfTextFromContent(content)
    preview.textItems = content ? workspacePdfTextItemsFromContent(content, viewport) : []
    if (content) {
      try {
        preview.textLayer.style.setProperty('--total-scale-factor', String(viewport.scale))
        preview.textLayer.style.setProperty('--scale-round-x', '1px')
        preview.textLayer.style.setProperty('--scale-round-y', '1px')
        const layer = new preview.lib.TextLayer({
          textContentSource: content,
          container: preview.textLayer,
          viewport,
        })
        preview.textLayerTask = layer
        await layer.render()
      } catch {
        // 文本层失败不影响页面阅读，文本面板仍可用 getTextContent 的结果。
      }
    }
    if (seq !== preview.renderSeq || workspacePdfState !== preview) return
    preview.loading.hidden = true
    updateWorkspacePdfChrome(preview)
    renderWorkspacePdfAnnotations()
    renderWorkspacePdfAnnotationList()
    renderWorkspacePdfTextPanel()
    paintWorkspacePdfDraft(preview)
    if (resetScroll) preview.stage.scrollTop = 0
    setWorkspacePdfStatus(`第 ${preview.page} / ${preview.pageCount} 页 · ${preview.pageText ? '可拖选文本' : '未提取到文本'}`)
  } catch (err) {
    if (seq !== preview.renderSeq || workspacePdfState !== preview) return
    preview.loading.hidden = true
    preview.loading.textContent = `第 ${preview.page} 页渲染失败：${err.message}`
    setWorkspacePdfStatus(`PDF 渲染失败：${err.message}`, true)
  }
}

function bindWorkspacePdfViewer(preview) {
  const goToPage = async (page) => {
    if (!workspacePdfState || workspacePdfState !== preview) return
    const next = Math.min(preview.pageCount, Math.max(1, Number(page) || 1))
    if (next === preview.page) {
      preview.pageInput.value = String(preview.page)
      return
    }
    cancelWorkspacePdfDraft({ silent: true })
    preview.page = next
    await renderWorkspacePdfPage({ resetScroll: true })
  }

  preview.root.addEventListener('click', (event) => {
    const target = event.target.closest('button')
    if (!target) return
    if (workspacePdfState !== preview) return
    if (target.hasAttribute('data-pdf-prev')) {
      void goToPage(preview.page - 1)
    } else if (target.hasAttribute('data-pdf-next')) {
      void goToPage(preview.page + 1)
    } else if (target.hasAttribute('data-pdf-zoom-out')) {
      preview.zoom = Math.max(0.7, Math.round((preview.zoom - 0.1) * 10) / 10)
      void renderWorkspacePdfPage()
    } else if (target.hasAttribute('data-pdf-zoom-in')) {
      preview.zoom = Math.min(2.2, Math.round((preview.zoom + 0.1) * 10) / 10)
      void renderWorkspacePdfPage()
    } else if (target.hasAttribute('data-pdf-fit')) {
      preview.zoom = 1
      void renderWorkspacePdfPage()
    } else if (target.dataset.pdfTool) {
      applyWorkspacePdfTool(target.dataset.pdfTool)
    } else if (target.hasAttribute('data-pdf-text-toggle')) {
      const open = preview.textPanel.hidden
      preview.textPanel.hidden = !open
      target.setAttribute('aria-expanded', String(open))
      if (open) {
        preview.annotationPanel.hidden = true
        preview.root.querySelector('[data-pdf-annotations-toggle]')?.setAttribute('aria-expanded', 'false')
        renderWorkspacePdfTextPanel()
      }
    } else if (target.hasAttribute('data-pdf-text-close')) {
      preview.textPanel.hidden = true
      preview.root.querySelector('[data-pdf-text-toggle]')?.setAttribute('aria-expanded', 'false')
    } else if (target.hasAttribute('data-pdf-text-copy')) {
      copyWorkspacePdfText(preview.pageText)
    } else if (target.hasAttribute('data-pdf-text-quote')) {
      quoteWorkspacePdfPage(preview)
    } else if (target.hasAttribute('data-pdf-annotations-toggle')) {
      const open = preview.annotationPanel.hidden
      preview.annotationPanel.hidden = !open
      target.setAttribute('aria-expanded', String(open))
      if (open) {
        preview.textPanel.hidden = true
        preview.root.querySelector('[data-pdf-text-toggle]')?.setAttribute('aria-expanded', 'false')
        renderWorkspacePdfAnnotationList()
      }
    } else if (target.hasAttribute('data-pdf-annotations-close')) {
      preview.annotationPanel.hidden = true
      preview.root.querySelector('[data-pdf-annotations-toggle]')?.setAttribute('aria-expanded', 'false')
    } else if (target.hasAttribute('data-pdf-draft-save')) {
      saveWorkspacePdfDraft()
    } else if (target.hasAttribute('data-pdf-draft-cancel')) {
      cancelWorkspacePdfDraft()
      preview.stage.focus({ preventScroll: true })
    } else if (target.dataset.pdfAnnotationOpen) {
      const annotation = preview.annotations.find((item) => item.id === target.dataset.pdfAnnotationOpen)
      if (!annotation) return
      preview.page = annotation.page
      void renderWorkspacePdfPage({ resetScroll: true }).then(() => flashWorkspacePdfAnnotation(annotation.id))
    } else if (target.dataset.pdfAnnotationDelete) {
      const id = target.dataset.pdfAnnotationDelete
      const index = preview.annotations.findIndex((item) => item.id === id)
      if (index < 0) return
      preview.annotations.splice(index, 1)
      writeWorkspacePdfAnnotations(preview.file, preview.annotations)
      updateWorkspacePdfChrome(preview)
      renderWorkspacePdfAnnotations()
      renderWorkspacePdfAnnotationList()
      setWorkspacePdfStatus('已删除 1 条批注')
    }
  })

  preview.pageInput.addEventListener('change', () => {
    const page = Number(preview.pageInput.value)
    if (Number.isFinite(page)) void goToPage(page)
    else preview.pageInput.value = String(preview.page)
  })
  preview.pageInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    const page = Number(preview.pageInput.value)
    if (Number.isFinite(page)) void goToPage(page)
  })

  preview.stage.addEventListener('keydown', (event) => {
    if (event.target.closest('input, textarea')) return
    if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
      event.preventDefault()
      void goToPage(preview.page - 1)
    } else if (event.key === 'ArrowRight' || event.key === 'PageDown') {
      event.preventDefault()
      void goToPage(preview.page + 1)
    }
  })

  let drag = null
  const localPoint = (event) => {
    const rect = preview.pageEl.getBoundingClientRect()
    const fallback = workspacePdfPageCssSize(preview)
    const width = rect.width || fallback.width
    const height = rect.height || fallback.height
    return {
      x: Math.min(width, Math.max(0, event.clientX - rect.left)),
      y: Math.min(height, Math.max(0, event.clientY - rect.top)),
      width,
      height,
    }
  }
  const paintDrag = (from, to) => {
    preview.draftLayer.hidden = false
    preview.draftLayer.style.left = `${Math.min(from.x, to.x)}px`
    preview.draftLayer.style.top = `${Math.min(from.y, to.y)}px`
    preview.draftLayer.style.width = `${Math.abs(to.x - from.x)}px`
    preview.draftLayer.style.height = `${Math.abs(to.y - from.y)}px`
  }
  preview.pageEl.addEventListener('pointerdown', (event) => {
    if (preview.tool !== 'region' || event.button !== 0) return
    if (event.target.closest('button, input, textarea, a')) return
    const point = localPoint(event)
    drag = { pointerId: event.pointerId, start: point, last: point }
    try {
      preview.pageEl.setPointerCapture?.(event.pointerId)
    } catch {
      // 合成事件或已释放的指针没有可捕获的 pointer。
    }
    cancelWorkspacePdfDraft({ silent: true })
    paintDrag(point, point)
    event.preventDefault()
  })
  preview.pageEl.addEventListener('pointermove', (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return
    drag.last = localPoint(event)
    paintDrag(drag.start, drag.last)
  })
  const finishDrag = (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return
    const { start, last } = drag
    const width = start.width
    const height = start.height
    drag = null
    try {
      preview.pageEl.releasePointerCapture?.(event.pointerId)
    } catch {
      // 指针已经释放。
    }
    if (Math.abs(last.x - start.x) < 8 || Math.abs(last.y - start.y) < 8 || width <= 0 || height <= 0) {
      preview.draftLayer.hidden = true
      setWorkspacePdfStatus('框选太小，请重新拖拽一个区域')
      return
    }
    const rect = [
      Math.min(start.x, last.x) / width,
      Math.min(start.y, last.y) / height,
      Math.max(start.x, last.x) / width,
      Math.max(start.y, last.y) / height,
    ]
    startWorkspacePdfDraft(preview, rect)
  }
  preview.pageEl.addEventListener('pointerup', finishDrag)
  preview.pageEl.addEventListener('pointercancel', (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return
    drag = null
    preview.draftLayer.hidden = true
  })

  if (typeof ResizeObserver === 'function') {
    preview.resizeObserver = new ResizeObserver(() => {
      if (workspacePdfState !== preview || !preview.stage.clientWidth) return
      if (preview.resizeTimer) clearTimeout(preview.resizeTimer)
      preview.resizeTimer = window.setTimeout(() => {
        if (workspacePdfState === preview) void renderWorkspacePdfPage()
      }, 180)
    })
    preview.resizeObserver.observe(preview.stage)
  }
  updateWorkspacePdfChrome(preview)
}

function previewKindForFile(file) {
  if (isOfficeLike(file)) return 'office'
  if (isTextLike(file)) return 'text'
  if (isImageLike(file)) return 'image'
  if (isPdfLike(file)) return 'pdf'
  return 'none'
}

function markdownPreviewHtml(text) {
  const value = String(text ?? '').replace(/\r\n?/g, '\n')
  return value.trim() ? renderAnswer(value) : '<p class="file-markdown-empty">（空文件）</p>'
}

async function fetchPreviewCapability(file) {
  try {
    return await api(`/api/workspace/files/${encodeURIComponent(file.id)}/preview-capability`)
  } catch {
    // 老服务或网络抖动时退回本地类型判断，打开失败由现有错误提示兜住。
    return null
  }
}

function stopWorkspacePreviewWatch() {
  if (workspacePreviewWatchTimer) {
    window.clearInterval(workspacePreviewWatchTimer)
    workspacePreviewWatchTimer = null
  }
  workspacePreviewWatchBusy = false
  workspacePreviewWatchEpoch += 1
}

/**
 * 预览打开后每 30 秒确认一次访问资格与预览能力。
 * 权限撤销、文件删除由服务端返回 403/404；OnlyOffice 失效会返回 kind=none。
 */
function startWorkspacePreviewWatch(file) {
  stopWorkspacePreviewWatch()
  const expectedId = String(file.id)
  const epoch = workspacePreviewWatchEpoch
  workspacePreviewWatchTimer = window.setInterval(() => {
    void checkWorkspacePreviewAccess(expectedId, epoch)
  }, WORKSPACE_PREVIEW_WATCH_MS)
}

async function checkWorkspacePreviewAccess(expectedId, epoch) {
  if (epoch !== workspacePreviewWatchEpoch) return
  if (document.hidden || workspacePreviewWatchBusy) return
  const file = state.filePreview
  if (!file || String(file.id) !== expectedId) return
  workspacePreviewWatchBusy = true
  try {
    const capability = await api(`/api/workspace/files/${encodeURIComponent(file.id)}/preview-capability`)
    if (epoch !== workspacePreviewWatchEpoch) return
    if (!state.filePreview || String(state.filePreview.id) !== expectedId) return
    if (capability?.kind === 'none') {
      const reason = String(capability.reason || '').replace(/。$/, '')
      stopWorkspacePreviewWatch()
      closeWorkspaceFile()
      banner(`《${file.name}》${reason ? `${reason}，` : ''}预览已关闭。`, 'warn')
    }
  } catch (err) {
    if (epoch !== workspacePreviewWatchEpoch) return
    if (!state.filePreview || String(state.filePreview.id) !== expectedId) return
    if (err.status === 404 || err.status === 403) {
      stopWorkspacePreviewWatch()
      closeWorkspaceFile()
      void loadWorkspaceFiles()
      const message =
        err.status === 404
          ? `《${file.name}》已被删除，预览已关闭。`
          : `《${file.name}》的访问权限已失效，预览已关闭。`
      banner(message, err.status === 404 ? 'warn' : 'bad')
    }
    // 网络抖动或服务端临时错误不关闭预览，等下一轮巡检继续确认。
  } finally {
    if (epoch === workspacePreviewWatchEpoch) workspacePreviewWatchBusy = false
  }
}

/** 本轮要上报的「右侧预览文件」：没有打开预览时返回 undefined，服务端据此忽略。 */
function activePreviewFilePayload() {
  const file = state.filePreview
  if (!file || state.mode !== 'chat') return undefined
  return {
    id: String(file.id || ''),
    name: String(file.name || ''),
    relPath: file.relPath ? String(file.relPath) : undefined,
  }
}

/** 云空间图片直接打开中央聚焦预览，不创建右侧文件面板。 */
async function openWorkspaceImagePreview(file) {
  const token = ++workspaceImagePreviewToken
  try {
    const response = await fetch(workspaceFileUrl(file), { credentials: 'same-origin' })
    if (response.status === 401) {
      redirectToLogin()
      return waitForLoginRedirect()
    }
    if (!response.ok) throw new Error(`读取图片失败（HTTP ${response.status}）`)
    const blob = await response.blob()
    if (token !== workspaceImagePreviewToken) return
    const objectUrl = URL.createObjectURL(blob)
    openImageLightbox(objectUrl, file.name, { objectUrl: true })
  } catch (err) {
    if (token !== workspaceImagePreviewToken) return
    banner(`图片预览失败：${err.message}`, 'bad')
  }
}

/** 记住打开预览前的焦点，关闭后优先还给它；文件列表会在关闭时重绘，所以同时记住文件 id。 */
function rememberWorkspacePreviewReturnFocus(opener) {
  if (state.filePreview) return
  const active = opener instanceof HTMLElement ? opener : document.activeElement
  if (!(active instanceof HTMLElement) || active === document.body || active === document.documentElement) return
  if (active.closest('#file-pane')) return
  workspacePreviewReturnFocus = active
  workspacePreviewReturnFileId = String(
    active.dataset?.fileOpen || active.closest('[data-file-open]')?.dataset.fileOpen || '',
  )
}

function restoreWorkspacePreviewReturnFocus() {
  const opener = workspacePreviewReturnFocus
  const fileId = workspacePreviewReturnFileId
  workspacePreviewReturnFocus = null
  workspacePreviewReturnFileId = ''
  const usable = (element) =>
    element instanceof HTMLElement &&
    element.isConnected &&
    element.getClientRects().length > 0 &&
    !element.closest('#file-pane')
  if (usable(opener)) {
    opener.focus({ preventScroll: true })
    return
  }
  if (fileId) {
    const current = [...document.querySelectorAll('#ws-list [data-file-open]')].find(
      (button) => button.dataset.fileOpen === fileId,
    )
    if (usable(current)) {
      current.focus({ preventScroll: true })
      return
    }
  }
  if (state.mode === 'chat') {
    const input = $('#input')
    if (usable(input)) input.focus({ preventScroll: true })
    return
  }
  const firstFile = document.querySelector('#ws-list [data-file-open]')
  if (usable(firstFile)) firstFile.focus({ preventScroll: true })
}

async function openWorkspaceFile(id, options = {}) {
  rememberWorkspacePreviewReturnFocus(options.opener)
  let file = state.files.find((item) => item.id === id)
  if (!file) {
    // 消息卡片可能在列表刷新前就被点击；按 ID 拉一次，不把“刚发完的附件”误判成不存在。
    try {
      file = await api(`/api/workspace/files/${encodeURIComponent(id)}${qs()}`)
      if (file?.id && !state.files.some((item) => item.id === file.id)) state.files.unshift(file)
    } catch {
      banner('文件已不存在，可能已从云空间删除', 'bad')
      await loadWorkspaceFiles()
      return
    }
  }
  if (!file) {
    banner('文件已不存在，可能已从云空间删除', 'bad')
    await loadWorkspaceFiles()
    return
  }
  if (isImageLike(file)) {
    const capability = await fetchPreviewCapability(file)
    const kind = capability?.kind || previewKindForFile(file)
    if (kind === 'none') {
      banner(capability?.reason || `《${file.name}》暂不支持在线预览，请下载后查看。`, 'warn')
      return
    }
    await openWorkspaceImagePreview(file)
    return
  }
  const requestSeq = ++workspacePreviewToken
  // 打开另一个文件时先冻结旧预览的巡检；若新文件不可预览，旧预览仍在，稍后恢复巡检。
  const previousFile = state.filePreview
  const replacing = Boolean(previousFile && previousFile.id !== file.id)
  if (replacing) stopWorkspacePreviewWatch()
  const capability = await fetchPreviewCapability(file)
  if (requestSeq !== workspacePreviewToken) return
  const kind = capability?.kind || previewKindForFile(file)
  if (kind === 'none') {
    // 没有可用预览能力时不创建面板，也不让右栏出现空白占位。
    if (replacing && state.filePreview?.id === previousFile.id) startWorkspacePreviewWatch(previousFile)
    banner(capability?.reason || `《${file.name}》暂不支持在线预览，请下载后查看。`, 'warn')
    return
  }
  // 新文件即将替换旧预览，先让上一份文件的巡检失效，避免旧请求关掉新面板。
  stopWorkspacePreviewWatch()
  if (fileStreamDraft && fileStreamDraft.fileId !== file.id) finishStreamingFilePreview()
  releaseWorkspacePreviewUrl()
  destroyOnlyOfficeEditor()
  hideFilePaneSyncNotice()
  const token = requestSeq
  const split = state.mode === 'chat' && options.split !== false
  state.filePreview = file
  workspacePreviewText = ''
  workspacePreviewTextLoaded = false
  workspacePreviewOriginalText = ''
  workspaceDiffVisible = false
  hidePreviewSelection()
  const pane = $('#file-pane')
  pane.hidden = false
  playPaneEnter(pane)
  suppressFileDockForPreview()
  const chatMain = $('.chat-main')
  chatMain.classList.add('is-file-preview')
  chatMain.classList.toggle('is-split-preview', split)
  if (split) restoreFileSplitRatio()
  syncWorkbenchLayout()
  // 对话内预览保留左栏对话和输入区，只把右侧让给文件；工作台/窄屏仍走整页预览。
  $('#thread').hidden = !split
  $('#workspace-pane').hidden = true
  $('.composer').hidden = !split
  $('#file-pane-editor').hidden = true
  $('#file-pane-diff').hidden = true
  $('#file-pane-diff-toggle').hidden = true
  $('#file-pane-body').hidden = false
  $('#file-pane-kicker').textContent = split ? '对话内预览' : '云空间'
  $('#file-pane-name').textContent = file.name
  const meta = [fmtSize(file.size), `更新于 ${workspaceFileDate(file.updatedAt)}`, file.shared ? '共享文件' : '个人文件', file.relPath]
  const metaText = meta.filter(Boolean).join(' · ')
  const metaBox = $('#file-pane-meta')
  metaBox.textContent = metaText
  metaBox.title = metaText
  if (!split) $('#chat-title').textContent = `云空间 · ${file.name}`
  else $('#chat-title').textContent = state.sessionId ? '对话' : '新对话'
  const owner = file.ownerUserId === state.me?.person?.id
  $('#file-pane-rename').hidden = true
  $('#file-pane-edit').hidden = true
  $('#file-pane-edit').textContent = '编辑'
  $('#file-pane-edit').title = '编辑文件内容'
  $('#file-pane-delete').hidden = !owner
  $('#file-pane-versions').hidden = !owner
  $('#file-pane-export').hidden = !(isOfficeLike(file) && capability?.kind === 'office')
  $('#file-pane-gui').hidden = !(owner && isOfficeLike(file) && capability?.kind === 'office')
  $('#file-pane-download').hidden = false
  $('#file-pane-send-dingtalk').hidden = false
  renderWorkspaceFiles()
  startWorkspacePreviewWatch(file)
  if (isOfficeLike(file)) {
    await openWorkspaceOffice(file, options.mode === 'edit' ? 'edit' : 'view')
    return
  }
  filePaneMessage('正在读取文件…')
  try {
    const response = await fetch(workspaceFileUrl(file), { credentials: 'same-origin' })
    if (response.status === 401) {
      redirectToLogin()
      return waitForLoginRedirect()
    }
    if (!response.ok) throw new Error(`读取文件失败（HTTP ${response.status}）`)
    const blob = await response.blob()
    if (token !== workspacePreviewToken || state.filePreview?.id !== file.id) return
    if (isTextLike(file)) {
      if (file.size > 5 * 1024 * 1024) {
        filePaneMessage('这个文本文件超过 5 MB，先在右侧下载后查看。')
        $('#file-pane-edit').hidden = true
        return
      }
      const text = await blob.text()
      const liveDraft = fileStreamDraft && fileStreamDraft.fileId === file.id ? fileStreamDraft : null
      const shownText = liveDraft ? liveDraft.text : text
      workspacePreviewText = shownText
      workspacePreviewOriginalText = text
      workspacePreviewTextLoaded = true
      if (isMarkdownLike(file)) {
        const view = document.createElement('div')
        view.className = `file-markdown-view${liveDraft ? ' is-streaming' : ''}`
        view.innerHTML = markdownPreviewHtml(shownText)
        setFilePaneBody(view)
      } else {
        const pre = document.createElement('pre')
        pre.className = `file-text-view${liveDraft ? ' is-streaming' : ''}`
        pre.textContent = shownText || '（空文件）'
        setFilePaneBody(pre)
      }
      $('#file-pane-edit').hidden = !owner
      return
    }
    if (isPdfLike(file)) {
      try {
        await openWorkspacePdfPreview(file, blob, token)
      } catch (err) {
        if (token !== workspacePreviewToken || state.filePreview?.id !== file.id) return
        releaseWorkspacePdf()
        if (workspacePreviewObjectUrl) URL.revokeObjectURL(workspacePreviewObjectUrl)
        workspacePreviewObjectUrl = URL.createObjectURL(blob)
        const frame = document.createElement('iframe')
        frame.className = 'file-pdf-view'
        frame.title = file.name
        frame.src = workspacePreviewObjectUrl
        setFilePaneBody(frame)
        banner(`PDF 增强预览不可用，已退回浏览器原生预览：${err.message}`, 'warn')
      }
      return
    }
    filePaneMessage('这个文件类型不能直接预览，点右上角「下载」查看内容。')
  } catch (err) {
    if (token !== workspacePreviewToken) return
    filePaneMessage(`读取失败：${err.message}`, 'bad')
  }
}

function updateFileFullscreenButton() {
  const pane = $('#file-pane')
  const button = $('#file-pane-fullscreen')
  if (!button) return
  const active = Boolean(
    pane && (document.fullscreenElement === pane || document.body.classList.contains('is-file-preview-fullscreen')),
  )
  button.classList.toggle('is-active', active)
  button.setAttribute('aria-pressed', String(active))
  button.title = active ? '退出全屏预览' : '全屏预览'
  button.setAttribute('aria-label', active ? '退出全屏预览' : '全屏预览')
  const label = $('#file-pane-fullscreen-label')
  if (label) label.textContent = active ? '退出全屏' : '全屏'
}

async function exitFilePreviewFullscreen() {
  const pane = $('#file-pane')
  document.body.classList.remove('is-file-preview-fullscreen')
  if (pane && document.fullscreenElement === pane && document.exitFullscreen) {
    try {
      await document.exitFullscreen()
    } catch {
      /* 浏览器可能已经退出全屏 */
    }
  }
  updateFileFullscreenButton()
}

async function toggleFilePreviewFullscreen() {
  const pane = $('#file-pane')
  if (!pane || pane.hidden) return
  if (document.fullscreenElement === pane) {
    await exitFilePreviewFullscreen()
    return
  }
  if (document.body.classList.contains('is-file-preview-fullscreen')) {
    await exitFilePreviewFullscreen()
    return
  }
  document.body.classList.add('is-file-preview-fullscreen')
  updateFileFullscreenButton()
}

function closeWorkspaceFile() {
  stopWorkspacePreviewWatch()
  void exitFilePreviewFullscreen()
  finishStreamingFilePreview()
  if (workspaceMarkdownRenderTimer) {
    window.clearTimeout(workspaceMarkdownRenderTimer)
    workspaceMarkdownRenderTimer = 0
  }
  workspacePreviewToken += 1
  state.filePreview = null
  workspacePreviewText = ''
  workspacePreviewTextLoaded = false
  workspacePreviewOriginalText = ''
  workspaceDiffVisible = false
  releaseWorkspacePreviewUrl()
  destroyOnlyOfficeEditor()
  hideFilePaneSyncNotice()
  $('#file-pane').hidden = true
  clearPaneEnter($('#file-pane'))
  $('#file-split-resizer').hidden = true
  $('.chat-main').classList.remove('is-file-preview')
  hidePreviewSelection()
  $('#file-pane-editor').hidden = true
  $('#file-pane-diff').hidden = true
  $('#file-pane-diff-toggle').hidden = true
  $('#file-pane-rename').hidden = true
  $('#file-pane-body').hidden = false
  $('#file-pane-body').innerHTML = ''
  $('#thread').hidden = state.mode !== 'chat'
  $('.composer').hidden = state.mode !== 'chat'
  $('#workspace-pane').hidden = state.mode !== 'workspace'
  $('#chat-title').textContent = state.mode === 'workspace' ? '工作台' : state.sessionId ? '对话' : '新对话'
  syncWorkbenchLayout()
  renderWorkspaceFiles()
  restoreFileDockAfterPreview()
  restoreWorkspacePreviewReturnFocus()
}

function beginWorkspaceEdit() {
  const file = state.filePreview
  if (!file || !workspacePreviewTextLoaded) return
  $('#file-pane-body').hidden = true
  $('#file-pane-editor').hidden = false
  workspaceDiffVisible = false
  const textarea = $('#file-pane-text')
  textarea.value = workspacePreviewText
  textarea.hidden = false
  const diff = $('#file-pane-diff')
  diff.hidden = true
  diff.innerHTML = ''
  const toggle = $('#file-pane-diff-toggle')
  toggle.hidden = false
  toggle.disabled = false
  toggle.textContent = '查看差异'
  toggle.setAttribute('aria-pressed', 'false')
  $('#file-pane-editor-hint').textContent = '保存后会覆盖原文件内容；空内容也可以保存。'
  textarea.focus()
}

function cancelWorkspaceEdit() {
  workspaceDiffVisible = false
  $('#file-pane-editor').hidden = true
  $('#file-pane-diff').hidden = true
  $('#file-pane-diff').innerHTML = ''
  $('#file-pane-text').hidden = false
  $('#file-pane-diff-toggle').hidden = true
  $('#file-pane-body').hidden = false
  const editButton = $('#file-pane-edit')
  if (editButton && !editButton.hidden) editButton.focus()
}

async function saveWorkspaceEdit() {
  const file = state.filePreview
  if (!file || workspacePreviewSaving) return
  const text = $('#file-pane-text').value
  workspacePreviewSaving = true
  $('#file-pane-save').disabled = true
  try {
    await api(`/api/workspace/files${qs()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: file.relPath, text, mime: file.mime || 'text/plain; charset=utf-8', baseVersion: file.updatedAt }),
    })
    banner('文件内容已保存', 'ok')
    await loadWorkspaceFiles()
    if (state.files.some((item) => item.id === file.id)) await openWorkspaceFile(file.id)
    else closeWorkspaceFile()
  } catch (err) {
    $('#file-pane-editor-hint').textContent = `保存失败：${err.message}`
  } finally {
    workspacePreviewSaving = false
    $('#file-pane-save').disabled = false
  }
}

async function deleteWorkspacePreview() {
  const file = state.filePreview
  if (!file) return
  deleteWorkspaceFile(file, true)
}

async function downloadWorkspaceFile(file) {
  const response = await fetch(workspaceFileUrl(file), { credentials: 'same-origin' })
  if (response.status === 401) {
    redirectToLogin()
    return waitForLoginRedirect()
  }
  if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`)
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = file.name
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

function downloadWorkspacePreview() {
  const file = state.filePreview
  if (!file) return
  downloadWorkspaceFile(file).catch((err) => banner(err.message, 'bad'))
}

function versionSourceLabel(source) {
  const labels = {
    'onlyoffice.save': 'OnlyOffice 保存前',
    'workspace.snapshot': '手动快照',
    'workspace.restore': '恢复前',
    'office.replace': '文本替换前',
    'office.insert': '结构修改前',
    'office.format': '格式修改前',
    'office.comment': '批注修改前',
    'office.revisions': '修订修改前',
    'workspace.edit': '文本编辑前',
  }
  return labels[String(source || '')] || String(source || '未知来源')
}

function formatVersionTime(value) {
  const time = Number(value)
  if (!Number.isFinite(time) || time <= 0) return '—'
  return new Date(time).toLocaleString('zh-CN', { hour12: false })
}

/** 历史版本弹窗：只给文件本人看，避免共享文件泄露旧内容。 */
async function openWorkspaceVersionHistory(file) {
  const previousFocus = document.activeElement
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay version-overlay'
  overlay.innerHTML = `<div class="modal version-card" role="dialog" aria-modal="true" aria-labelledby="version-card-title">
    <div class="version-card-head">
      <div>
        <span class="version-card-eyebrow">版本历史</span>
        <h3 id="version-card-title">${esc(file.name)}</h3>
        <p class="version-card-sub">每次保存或 Agent 修改前自动留一份；最多保留最近 20 个版本。</p>
      </div>
      <button class="modal-x" type="button" aria-label="关闭历史版本">×</button>
    </div>
    <div class="version-card-toolbar">
      <div class="version-card-actions">
        <button class="btn ghost sm" type="button" data-version-snapshot>保存当前版本</button>
        <button class="btn ghost sm" type="button" data-version-restore-last disabled>恢复到上一版本</button>
      </div>
      <span class="version-card-count" data-version-count>正在读取…</span>
    </div>
    <div class="version-card-list" data-version-list></div>
    <div class="version-card-status" data-version-status hidden></div>
  </div>`
  document.body.appendChild(overlay)

  let settled = false
  const status = overlay.querySelector('[data-version-status]')
  const list = overlay.querySelector('[data-version-list]')
  const count = overlay.querySelector('[data-version-count]')
  const quickRestore = overlay.querySelector('[data-version-restore-last]')
  const close = () => {
    if (settled) return
    settled = true
    document.removeEventListener('keydown', onKey)
    overlay.remove()
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected && !previousFocus.closest('[hidden]')) {
      previousFocus.focus({ preventScroll: true })
    } else {
      $('#input')?.focus()
    }
  }
  const onKey = (event) => {
    if (event.key === 'Escape') close()
  }
  document.addEventListener('keydown', onKey)
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close()
  })
  overlay.querySelector('.modal-x').addEventListener('click', close)

  const showStatus = (text, tone = '') => {
    if (!status) return
    status.hidden = !text
    status.textContent = text
    status.className = `version-card-status${tone ? ` is-${tone}` : ''}`
  }

  const render = (items) => {
    count.textContent = `${items.length} 个版本`
    quickRestore.disabled = true
    delete quickRestore.dataset.versionId
    delete quickRestore.dataset.versionLabel
    if (!items.length) {
      list.innerHTML = '<div class="version-card-empty">还没有历史版本。保存当前版本后，这里会出现可恢复的快照。</div>'
      return
    }
    list.innerHTML = items.map((item) => {
      const current = Number(item.version) === Number(file.updatedAt)
      const versionName = `v${item.version}`
      return `<div class="version-row${current ? ' is-current' : ''}">
        <div class="version-row-main">
          <div class="version-row-title">
            <strong>${esc(versionName)}</strong>
            ${current ? '<span class="version-current-badge">当前</span>' : ''}
            <span class="version-row-size">${esc(fmtSize(item.size))}</span>
          </div>
          <div class="version-row-meta">${esc(versionSourceLabel(item.source))} · ${esc(formatVersionTime(item.createdAt))}</div>
          ${item.summary ? `<div class="version-row-summary">${esc(item.summary)}</div>` : ''}
        </div>
        <div class="version-row-actions">
          <a class="btn ghost sm" href="/api/workspace/files/${encodeURIComponent(file.id)}/versions/${encodeURIComponent(item.id)}/download" download>下载</a>
          <button class="btn ghost sm" type="button" data-version-restore="${esc(item.id)}" ${current ? 'disabled' : ''}>${current ? '当前版本' : '恢复'}</button>
        </div>
      </div>`
    }).join('')
    const previous = items.find((item) => Number(item.version) !== Number(file.updatedAt))
    if (previous) {
      quickRestore.disabled = false
      quickRestore.dataset.versionId = previous.id
      quickRestore.dataset.versionLabel = `v${previous.version}`
    }
  }

  const load = async () => {
    try {
      const data = await api(`/api/workspace/files/${encodeURIComponent(file.id)}/versions`)
      render(Array.isArray(data?.items) ? data.items : [])
      showStatus('')
    } catch (err) {
      count.textContent = '读取失败'
      list.innerHTML = `<div class="version-card-empty is-error">读取版本历史失败：${esc(err.message)}</div>`
    }
  }

  overlay.querySelector('[data-version-snapshot]').addEventListener('click', async (event) => {
    const button = event.currentTarget
    button.disabled = true
    button.textContent = '保存中…'
    try {
      const result = await api(`/api/workspace/files/${encodeURIComponent(file.id)}/versions`, { method: 'POST' })
      showStatus(result?.created ? '已保存当前版本快照' : '当前版本已有快照', 'ok')
      await load()
    } catch (err) {
      showStatus(`保存快照失败：${err.message}`, 'bad')
    } finally {
      button.disabled = false
      button.textContent = '保存当前版本'
    }
  })

  const restoreVersion = async (versionId, versionLabel, triggerButton) => {
    if (!versionId) return
    const confirmed = await openConfirmCard({
      eyebrow: '恢复历史版本',
      title: `恢复到 ${versionLabel}？`,
      targetLabel: '文件',
      target: file.name,
      message: '当前内容会先自动保存为一份新快照，然后写回所选历史版本；恢复后编辑器需要重新打开。',
      confirmText: '恢复此版本',
    })
    if (!confirmed) return
    const originalText = triggerButton?.textContent
    if (triggerButton) {
      triggerButton.disabled = true
      triggerButton.textContent = '恢复中…'
    }
    try {
      await api(`/api/workspace/files/${encodeURIComponent(file.id)}/versions/${encodeURIComponent(versionId)}/restore`, {
        method: 'POST',
      })
      close()
      await loadWorkspaceFiles()
      const latest = state.files.find((item) => item.id === file.id)
      if (latest) await openWorkspaceFile(latest.id, { mode: 'view' })
      banner('已恢复到所选历史版本', 'ok')
    } catch (err) {
      showStatus(`恢复失败：${err.message}`, 'bad')
      if (triggerButton) {
        triggerButton.disabled = false
        triggerButton.textContent = originalText || '恢复'
      }
    }
  }

  list.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-version-restore]')
    if (!button || button.disabled) return
    const versionId = button.getAttribute('data-version-restore') || ''
    const row = button.closest('.version-row')
    const versionLabel = row?.querySelector('.version-row-title strong')?.textContent || '该版本'
    await restoreVersion(versionId, versionLabel, button)
  })

  quickRestore.addEventListener('click', async () => {
    if (quickRestore.disabled) return
    await restoreVersion(
      quickRestore.dataset.versionId || '',
      quickRestore.dataset.versionLabel || '上一版本',
      quickRestore,
    )
  })

  await load()
}

const GUI_FALLBACK_OPTIONS = [
  {
    id: 'print',
    label: '打印 / 打印设置',
    description: '打开 OnlyOffice 原生打印对话框；查看态也可用。',
    needsEdit: false,
  },
  {
    id: 'export',
    label: '导出选项',
    description: '打开原生导出/另存为，选择格式和本地保存位置；查看态也可用。',
    needsEdit: false,
  },
  {
    id: 'macro',
    label: '宏管理器',
    description: '只打开宏管理器；EAB 不会读取、保存或自动执行宏代码。',
    needsEdit: true,
  },
  {
    id: 'dialog',
    label: '原生对话框',
    description: '页面设置、页眉页脚；仅 docx，且需要先切到编辑态。',
    needsEdit: true,
  },
]

/**
 * GUI 兜底：前端负责用户确认和步骤引导，真正的原生按钮由用户自己点。
 * 服务端只认白名单动作，不做任意坐标点击或宏执行。
 */
async function openWorkspaceGuiFallback(file) {
  if (!file) return
  const previousFocus = document.activeElement
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay gui-overlay'
  const optionsHtml = GUI_FALLBACK_OPTIONS.map((option, index) => `
    <label class="gui-option">
      <input type="radio" name="gui-action" value="${esc(option.id)}"${index === 0 ? ' checked' : ''}>
      <span>
        <strong>${esc(option.label)}</strong>
        <em>${esc(option.description)}</em>
      </span>
    </label>`).join('')
  overlay.innerHTML = `<div class="modal gui-card" role="dialog" aria-modal="true" aria-labelledby="gui-card-title">
    <div class="gui-card-head">
      <div>
        <span class="gui-card-eyebrow">受控人工兜底</span>
        <h3 id="gui-card-title">${esc(file.name)}</h3>
        <p class="gui-card-sub">仅支持白名单里的原生入口。确认后由你自己在 OnlyOffice 点击；失败一次即停，不会自动重试。</p>
      </div>
      <button class="modal-x" type="button" aria-label="关闭 GUI 兜底">×</button>
    </div>
    <div class="gui-card-body">
      <section class="gui-setup" data-gui-setup>
        <div class="gui-options" role="radiogroup" aria-label="选择兜底动作">${optionsHtml}</div>
        <div class="gui-field" data-gui-dialog-row hidden>
          <label for="gui-dialog-select">原生对话框</label>
          <select id="gui-dialog-select" data-gui-dialog>
            <option value="page_setup">页面设置</option>
            <option value="header_footer">页眉页脚</option>
          </select>
        </div>
        <div class="gui-field" data-gui-format-row hidden>
          <label for="gui-format-select">导出格式提示</label>
          <select id="gui-format-select" data-gui-format>
            <option value="pdf">PDF</option>
            <option value="docx">Word (docx)</option>
            <option value="xlsx">Excel (xlsx)</option>
            <option value="pptx">PowerPoint (pptx)</option>
            <option value="csv">CSV</option>
          </select>
        </div>
        <p class="gui-note">当前只允许打印、宏管理器、导出选项、页面设置/页眉页脚。白名单外动作会被服务端拒绝。</p>
      </section>
      <section class="gui-steps" data-gui-steps hidden>
        <div class="gui-steps-head">
          <strong data-gui-steps-title>操作步骤</strong>
          <span data-gui-steps-meta></span>
        </div>
        <ol data-gui-steps-list></ol>
      </section>
      <div class="gui-card-status" data-gui-status hidden></div>
      <div class="gui-failure" data-gui-failure-row hidden>
        <label for="gui-failure-detail">失败原因</label>
        <textarea id="gui-failure-detail" data-gui-failure-detail rows="2" maxlength="500" placeholder="例如：打印对话框报错、宏被安全策略拦截、页面设置无法保存"></textarea>
        <button class="btn ghost sm" type="button" data-gui-submit-failure>提交失败原因</button>
      </div>
    </div>
    <div class="gui-card-actions">
      <button class="btn ghost" type="button" data-gui-cancel>取消</button>
      <button class="btn" type="button" data-gui-prepare>生成操作步骤</button>
      <button class="btn" type="button" data-gui-confirm hidden>我确认，开始操作</button>
      <button class="btn ghost" type="button" data-gui-success hidden>我已完成</button>
      <button class="btn ghost" type="button" data-gui-failure hidden>遇到问题</button>
      <button class="btn" type="button" data-gui-finish hidden>完成</button>
    </div>
  </div>`
  for (const existing of document.querySelectorAll('.gui-overlay')) {
    const closeButton = existing.querySelector('.modal-x')
    if (closeButton instanceof HTMLElement) closeButton.click()
    else existing.remove()
  }
  document.body.appendChild(overlay)

  let settled = false
  let fallback = null
  const status = overlay.querySelector('[data-gui-status]')
  const setup = overlay.querySelector('[data-gui-setup]')
  const stepsBox = overlay.querySelector('[data-gui-steps]')
  const stepsList = overlay.querySelector('[data-gui-steps-list]')
  const stepsTitle = overlay.querySelector('[data-gui-steps-title]')
  const stepsMeta = overlay.querySelector('[data-gui-steps-meta]')
  const dialogRow = overlay.querySelector('[data-gui-dialog-row]')
  const formatRow = overlay.querySelector('[data-gui-format-row]')
  const dialogSelect = overlay.querySelector('[data-gui-dialog]')
  const formatSelect = overlay.querySelector('[data-gui-format]')
  const failureRow = overlay.querySelector('[data-gui-failure-row]')
  const failureDetail = overlay.querySelector('[data-gui-failure-detail]')
  const prepareButton = overlay.querySelector('[data-gui-prepare]')
  const confirmButton = overlay.querySelector('[data-gui-confirm]')
  const successButton = overlay.querySelector('[data-gui-success]')
  const failureButton = overlay.querySelector('[data-gui-failure]')
  const finishButton = overlay.querySelector('[data-gui-finish]')
  const cancelButton = overlay.querySelector('[data-gui-cancel]')
  const actionInputs = [...overlay.querySelectorAll('input[name="gui-action"]')]

  const close = () => {
    document.removeEventListener('keydown', onKey)
    overlay.remove()
    if (settled) return
    settled = true
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected && !previousFocus.closest('[hidden]')) {
      previousFocus.focus({ preventScroll: true })
    } else {
      $('#input')?.focus()
    }
  }
  const onKey = (event) => {
    if (event.key === 'Escape') close()
  }
  document.addEventListener('keydown', onKey)
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close()
  })
  overlay.querySelector('.modal-x').addEventListener('click', close)
  cancelButton.addEventListener('click', close)

  const showStatus = (message, tone = '') => {
    status.className = `gui-card-status${tone ? ` is-${tone}` : ''}`
    status.hidden = !message
    status.textContent = message || ''
  }
  const selectedAction = () => overlay.querySelector('input[name="gui-action"]:checked')?.value || 'print'
  const syncFields = () => {
    const action = selectedAction()
    dialogRow.hidden = action !== 'dialog'
    formatRow.hidden = action !== 'export'
  }
  const setBusy = (busy) => {
    for (const button of [prepareButton, confirmButton, successButton, failureButton, finishButton]) {
      if (button) button.disabled = busy
    }
    for (const input of actionInputs) input.disabled = busy
  }
  const renderSteps = (data) => {
    setup.hidden = true
    stepsBox.hidden = false
    stepsTitle.textContent = data.guiLabel || '操作步骤'
    const expires = Number(data.expiresAt)
    stepsMeta.textContent = `${Number.isFinite(expires) ? `${formatVersionTime(expires)} 前有效` : ''}${data.mode === 'edit' ? ' · 编辑态' : ' · 查看态'}`
    stepsList.innerHTML = (data.steps || []).map((step) => `<li>${esc(step)}</li>`).join('')
  }
  const report = async (result) => {
    if (!fallback?.fallbackId) return
    let detail = ''
    if (result === 'failure') {
      detail = String(failureDetail?.value || '').trim()
      if (!detail) {
        showStatus('请先写清楚失败原因，提交后本次会停止，不能自动重试。', 'bad')
        failureDetail?.focus()
        return
      }
    }
    setBusy(true)
    try {
      fallback = await api(qsAppend(`/api/workspace/files/${encodeURIComponent(file.id)}/gui-fallback/${encodeURIComponent(fallback.fallbackId)}/report`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ result, detail }),
      })
      failureRow.hidden = true
      successButton.hidden = true
      failureButton.hidden = true
      finishButton.hidden = false
      setBusy(false)
      if (result === 'success') {
        showStatus('已记录完成。审计已写入 workspace.file.agent_gui。', 'ok')
        finishButton.textContent = '完成'
      } else {
        showStatus('已记录失败。本次已停止，不会自动重试；需要再试时请关闭后重新发起。', 'bad')
        finishButton.textContent = '关闭'
      }
    } catch (err) {
      setBusy(false)
      showStatus(`上报失败：${err.message}`, 'bad')
    }
  }

  actionInputs.forEach((input) => input.addEventListener('change', syncFields))
  syncFields()

  prepareButton.addEventListener('click', async () => {
    const action = selectedAction()
    const option = GUI_FALLBACK_OPTIONS.find((item) => item.id === action)
    if (option?.needsEdit && onlyOfficeMode !== 'edit') {
      showStatus('当前是查看态。请先关闭本弹窗，点右上角「编辑」切换到编辑态后再发起。', 'bad')
      return
    }
    setBusy(true)
    showStatus('正在生成步骤…')
    try {
      fallback = await api(qsAppend(`/api/workspace/files/${encodeURIComponent(file.id)}/gui-fallback`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action,
          dialog: action === 'dialog' ? dialogSelect?.value : undefined,
          format: action === 'export' ? formatSelect?.value : undefined,
        }),
      })
      setBusy(false)
      prepareButton.hidden = true
      confirmButton.hidden = false
      renderSteps(fallback)
      showStatus('步骤已生成。确认前不会执行任何操作；确认后由你本人在 OnlyOffice 完成。', 'warn')
      confirmButton.focus()
    } catch (err) {
      setBusy(false)
      showStatus(`生成失败：${err.message}`, 'bad')
    }
  })

  confirmButton.addEventListener('click', async () => {
    if (!fallback?.fallbackId) return
    setBusy(true)
    try {
      fallback = await api(qsAppend(`/api/workspace/files/${encodeURIComponent(file.id)}/gui-fallback/${encodeURIComponent(fallback.fallbackId)}/confirm`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      setBusy(false)
      confirmButton.hidden = true
      successButton.hidden = false
      failureButton.hidden = false
      showStatus('已确认。请按上面步骤在 OnlyOffice 完成，然后回来点「我已完成」；遇到问题就点「遇到问题」。', 'ok')
      successButton.focus()
    } catch (err) {
      setBusy(false)
      showStatus(`确认失败：${err.message}`, 'bad')
    }
  })

  successButton.addEventListener('click', () => void report('success'))
  failureButton.addEventListener('click', () => {
    failureRow.hidden = false
    showStatus('请填写失败原因。提交后本次兜底即停止，同一条记录不能再次确认或上报。', 'warn')
    failureDetail?.focus()
  })
  overlay.querySelector('[data-gui-submit-failure]').addEventListener('click', () => void report('failure'))
  finishButton.addEventListener('click', close)
  cancelButton.focus()
}

async function exportWorkspacePreviewPdf(file) {
  const button = $('#file-pane-export')
  if (!file || !button) return
  const original = button.textContent
  button.disabled = true
  button.textContent = '导出中…'
  try {
    const response = await fetch(`/api/workspace/files/${encodeURIComponent(file.id)}/export`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ format: 'pdf' }),
    })
    if (response.status === 401) {
      redirectToLogin()
      return waitForLoginRedirect()
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => null)
      throw new Error(payload?.error?.message || payload?.message || `导出失败（HTTP ${response.status}）`)
    }
    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${String(file.name || '文档').replace(/\.[^.]+$/, '')}.pdf`
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
    banner('已导出 PDF', 'ok')
  } catch (err) {
    banner(`导出 PDF 失败：${err.message}`, 'bad')
  } finally {
    button.disabled = false
    button.textContent = original
  }
}

/** 右侧工作台：团队 / 文件 / 并排。两个面板同级，团队不在文件预览里面。 */
function bindWorkbenchTabs() {
  try {
    state.workbenchCollapsed = localStorage.getItem(WORKBENCH_COLLAPSED_KEY) === '1'
  } catch {
    state.workbenchCollapsed = false
  }
  const tabs = $('#workbench-tabs')
  if (tabs) {
    tabs.addEventListener('click', (event) => {
      const tab = event.target.closest('[data-workbench-tab]')
      if (!tab) return
      const name = tab.getAttribute('data-workbench-tab')
      state.workbenchSplit = false
      state.workbenchTab = name === 'file' ? 'file' : name === 'perm' ? 'perm' : 'team'
      if (state.workbenchTab === 'perm') {
        state.permOpen = true
        state.permError = ''
        void loadPermissionData()
      }
      syncWorkbenchLayout()
    })
  }
  $('#workbench-split')?.addEventListener('click', () => {
    state.workbenchSplit = !state.workbenchSplit
    syncWorkbenchLayout()
  })
  $('#workbench-close')?.addEventListener('click', () => {
    closePermissionPane()
    $('#perm-entry')?.focus()
  })
  $('#workbench-collapse')?.addEventListener('click', () => {
    setWorkbenchCollapsed(true)
    $('#workbench-restore')?.focus()
  })
  $('#workbench-restore')?.addEventListener('click', () => {
    setWorkbenchCollapsed(false)
    $('#workbench-collapse')?.focus()
  })
  // 子 Agent 列表：点哪一行，右边的详情窗口就切到哪个 Agent 的工作过程。
  // 用 pointerdown 先选中：流式期间行节点即使被更新，也不会因为 click 跨帧丢失而“点了没反应”。
  $('#team-list')?.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    const row = event.target.closest('[data-agent-select]')
    if (!row) return
    selectAgentChild(row.getAttribute('data-agent-select') || '')
  })
  // 键盘 Enter/Space 和辅助技术仍通过 click 选中；已经选中时 selectAgentChild 不会重复渲染。
  $('#team-list')?.addEventListener('click', (event) => {
    const row = event.target.closest('[data-agent-select]')
    if (!row) return
    selectAgentChild(row.getAttribute('data-agent-select') || '')
  })
  // 子 Agent 产物：文件类直接在右侧预览打开，和云空间文件走同一条链路。
  $('#team-detail')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-agent-artifact-open]')
    if (!button) return
    event.preventDefault()
    void openWorkspaceFile(String(button.getAttribute('data-agent-artifact-open') || ''), { opener: button })
  })
  // 子 Agent 的思考/工具入口：和主对话一样单行折叠，点一下展开完整内容。
  $('#team-detail')?.addEventListener('click', (event) => {
    const block = event.target.closest('[data-agent-cot-toggle], .agent-cot-block .tool-head')?.closest('.agent-cot-block')
    if (!block) return
    const key = block.getAttribute('data-agent-panel-key') || ''
    const panel = block.querySelector('.think-panel, .tool-panel')
    if (!panel) return
    const collapsed = panel.classList.toggle('is-collapsed')
    const button = panel.querySelector('.think-head, .tool-head')
    if (button) button.setAttribute('aria-expanded', String(!collapsed))
    if (key) state.agentPanelOpen.set(key, !collapsed)
  })
  // 子 Agent 窗口的滚动和主对话同一套规则：上滑看历史时停止跟随，滑回底部恢复。
  $('#team-detail')?.addEventListener('scroll', onAgentThreadScroll, true)
  $('#team-detail')?.addEventListener('click', (event) => {
    const scrollButton = event.target.closest('[data-agent-scroll-bottom]')
    if (!scrollButton) return
    scrollAgentThreadToBottom(state.agentSelectedId, true)
  })
  // 「继续派活」：把这个子 Agent 的 key 写进输入框，父 Agent 拿到后就会用 agent_task 复用它
  $('#team-detail')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-agent-continue]')
    if (!button) return
    const key = button.getAttribute('data-agent-continue') || ''
    const input = $('#input')
    if (!input) return
    const prefix = key ? `让子 Agent「${key}」继续做：` : '让刚才的子 Agent 继续做：'
    if (!input.value.trim()) input.value = prefix
    else if (!input.value.includes(key)) input.value = `${prefix}${input.value}`
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  syncWorkbenchLayout()
}

function bindWorkspaceFilePane() {
  $('#file-pane-close')?.addEventListener('click', closeWorkspaceFile)
  $('#file-pane-download')?.addEventListener('click', downloadWorkspacePreview)
  $('#file-pane-versions')?.addEventListener('click', () => {
    const file = state.filePreview
    if (file) void openWorkspaceVersionHistory(file)
  })
  $('#file-pane-export')?.addEventListener('click', () => {
    const file = state.filePreview
    if (file) void exportWorkspacePreviewPdf(file)
  })
  $('#file-pane-gui')?.addEventListener('click', () => {
    const file = state.filePreview
    if (file) void openWorkspaceGuiFallback(file)
  })
  $('#file-pane-refresh')?.addEventListener('click', () => {
    void refreshFilePaneToCloudVersion()
  })
  window.addEventListener('message', (event) => {
    // OnlyOffice 插件嵌在文档服务器里，跨域不能直接调用 EAB；令牌过期时由它
    // 请求顶层页面重新打开当前预览，保存成功时由它请求刷新为查看态。
    const messageType = event.data && event.data.type
    if (messageType !== 'eab:onlyoffice:reopen' && messageType !== 'eab:onlyoffice:saved') return
    let origin
    try {
      origin = new URL(event.origin)
    } catch {
      return
    }
    const expectedPort = window.location.port || (window.location.protocol === 'https:' ? '443' : '80')
    if (origin.port !== expectedPort) return
    const file = state.filePreview
    if (!file || !isOfficeLike(file)) return
    if (messageType === 'eab:onlyoffice:saved') {
      if (String(event.data.fileId || '') !== String(file.id)) return
      refreshWorkspaceAfterPluginSave(file, event.data)
      return
    }
    const mode = onlyOfficeMode === 'edit' ? 'edit' : 'view'
    const reopen = async () => {
      await loadWorkspaceFiles()
      const latest = state.files.find((item) => item.id === file.id)
      if (!latest) {
        banner('文件已不存在，无法重新打开预览', 'bad')
        return
      }
      return openWorkspaceFile(latest.id, { mode }).catch((err) =>
        banner(`重新打开预览失败：${err.message}`, 'bad'),
      )
    }
    if (mode !== 'edit') {
      void reopen()
      return
    }
    // 与 S3 刷新共用同一水位保护：关闭旧编辑器前先抬高 cutoff，
    // 旧会话即使因关闭触发保存回调，也不能覆盖云端新版本。
    void api(`/api/workspace/office/${encodeURIComponent(file.id)}/refresh-guard`, {
      method: 'POST',
    })
      .then(reopen)
      .catch((err) => banner(`重新打开预览失败：${err.message}`, 'bad'))
  })
  $('#file-pane-fullscreen')?.addEventListener('click', () => {
    void toggleFilePreviewFullscreen()
  })
  document.addEventListener('fullscreenchange', updateFileFullscreenButton)
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    if (!document.body.classList.contains('is-file-preview-fullscreen')) return
    document.body.classList.remove('is-file-preview-fullscreen')
    updateFileFullscreenButton()
  })
  $('#file-pane-send-dingtalk')?.addEventListener('click', () => {
    const file = state.filePreview
    if (file && file.id) sendWorkspaceFileToDingTalk(file)
  })
  $('#file-pane-edit')?.addEventListener('click', () => {
    const file = state.filePreview
    if (!file) return
    if (isOfficeLike(file)) {
      openWorkspaceOffice(file, onlyOfficeMode === 'edit' ? 'view' : 'edit')
      return
    }
    beginWorkspaceEdit()
  })
  $('#file-pane-cancel')?.addEventListener('click', cancelWorkspaceEdit)
  $('#file-pane-save')?.addEventListener('click', saveWorkspaceEdit)
  $('#file-pane-diff-toggle')?.addEventListener('click', toggleWorkspaceDiff)
  $('#file-pane-delete')?.addEventListener('click', deleteWorkspacePreview)
}

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

const TEXT_EXT = /\.(txt|md|markdown|json|csv|tsv|log|js|mjs|cjs|ts|tsx|jsx|html|htm|css|xml|yml|yaml|ini|conf|sql|py|java|go|rs|sh|ps1|bat)\b/i
const TEXT_MIME = /^text\/|application\/(json|xml|x-yaml|yaml|x-ndjson|csv)/i

function isTextLike(file) {
  const mime = file.mime || file.type || ''
  return TEXT_EXT.test(file.name || '') || TEXT_MIME.test(mime)
}

/** 只有 Markdown 文件走文档排版；txt/json/log 等仍按等宽原文预览。 */
function isMarkdownLike(file) {
  const name = String(file.name || '')
  const mime = String(file.mime || file.type || '')
  return /\.(md|markdown)$/i.test(name) || /^(?:text|application)\/(?:x-)?markdown/i.test(mime)
}

function safeFileName(file) {
  if (file.name) return file.name
  const ext = file.type === 'image/png' ? 'png' : file.type === 'image/jpeg' ? 'jpg' : 'bin'
  return `粘贴文件-${Date.now()}.${ext}`
}

const MAX_TEXT_ATTACHMENT_BYTES = 4_800_000

async function readTextAttachment(file) {
  // 完整正文交给服务端落批次；超过单文件读取上限时明确拒绝，避免静默只读前一段。
  if (file.size > MAX_TEXT_ATTACHMENT_BYTES) {
    throw new Error(`文本附件超过 ${MAX_TEXT_ATTACHMENT_BYTES / 1_000_000}MB 读取上限`)
  }
  return file.text()
}

/* 云空间上传进度 */
function wsUploadStateText(item) {
  if (item.status === 'pending') return '等待上传'
  if (item.status === 'preparing') return '读取中'
  if (item.status === 'uploading') return item.progress > 0 ? `${Math.max(0, Math.min(99, Math.round(item.progress)))}%` : '处理中'
  if (item.status === 'done') return '已上传'
  if (item.status === 'error') return '失败'
  return ''
}

function wsUploadSummary(items) {
  const total = items.length
  const done = items.filter((item) => item.status === 'done').length
  const failed = items.filter((item) => item.status === 'error').length
  if (items.some((item) => item.status === 'uploading' || item.status === 'preparing' || item.status === 'pending')) {
    return `正在上传 ${Math.min(total, done + failed + 1)} / ${total}`
  }
  if (failed) return `${done} 个成功 · ${failed} 个失败`
  return `已上传 ${done} 个文件到云空间`
}

function renderWorkspaceUploads() {
  const box = $('#ws-upload-status')
  if (!box) return
  const items = state.wsUploads || []
  if (!items.length) {
    box.hidden = true
    box.innerHTML = ''
    return
  }
  box.hidden = false
  const allDone = items.every((item) => item.status === 'done')
  const hasError = items.some((item) => item.status === 'error')
  box.classList.toggle('has-error', hasError)
  box.innerHTML = `
    <div class="ws-upload-head">
      <span class="ws-upload-title">${esc(wsUploadSummary(items))}</span>
      <button class="ws-upload-close" type="button" data-ws-upload-close aria-label="关闭上传进度">×</button>
    </div>
    <div class="ws-upload-list">
      ${items.map((item) => {
        const percent = Math.max(0, Math.min(100, Number(item.progress) || 0))
        const active = item.status === 'uploading' || item.status === 'preparing'
        const visualPercent = item.status === 'preparing' ? 35 : item.status === 'uploading' && percent <= 0 ? 22 : percent
        const barClass = item.status === 'done' ? ' is-done' : item.status === 'error' ? ' is-error' : ''
        const fillClass = item.status === 'done' ? ' is-done' : item.status === 'error' ? ' is-error' : active ? ' is-active' : ''
        return `
          <div class="ws-upload-item" data-ws-upload-key="${esc(item.id)}">
            <div class="ws-upload-row">
              <span class="ws-upload-name" title="${esc(item.name)}">${esc(item.name)}</span>
              <span class="ws-upload-state">${esc(wsUploadStateText(item))}</span>
            </div>
            <div class="ws-upload-bar${barClass}" role="progressbar" aria-label="${esc(item.name)} 上传进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(percent)}" aria-valuetext="${esc(wsUploadStateText(item))}">
              <span class="ws-upload-fill${fillClass}" style="width:${visualPercent}%"></span>
            </div>
            ${item.error ? `<div class="ws-upload-error">${esc(item.error)}</div>` : ''}
          </div>`
      }).join('')}
    </div>`
  if (!allDone && !hasError) return
  window.clearTimeout(state.wsUploadHideTimer)
  if (allDone) {
    state.wsUploadHideTimer = window.setTimeout(() => {
      state.wsUploads = []
      renderWorkspaceUploads()
    }, 5000)
  }
}

function setWorkspaceUploadItem(id, patch) {
  const item = (state.wsUploads || []).find((entry) => entry.id === id)
  if (!item) return
  Object.assign(item, patch)
  renderWorkspaceUploads()
}

function uploadWorkspaceFileWithProgress(file, contentBase64, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `/api/workspace/files${qs()}`, true)
    xhr.setRequestHeader('content-type', 'application/json')
    xhr.setRequestHeader('accept', 'application/json')
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(Math.min(99, (event.loaded / event.total) * 100))
    }
    xhr.onload = () => {
      let payload = null
      try { payload = JSON.parse(xhr.responseText || 'null') } catch { payload = null }
      if (xhr.status >= 200 && xhr.status < 300 && (!payload || payload.ok !== false)) {
        resolve(payload?.data)
        return
      }
      const error = new Error(
        payload?.error?.message || payload?.message || `上传失败（HTTP ${xhr.status || 0}）`,
      )
      error.code = payload?.error?.code || payload?.code
      error.hint = payload?.error?.hint || payload?.hint
      error.status = xhr.status
      if (xhr.status === 401 && !isLoginSurface()) redirectToLogin()
      reject(error)
    }
    xhr.onerror = () => reject(new Error('网络中断，文件未上传'))
    xhr.onabort = () => reject(new Error('上传已取消'))
    const parent = workspaceNormalizePath(state.workspacePath)
    xhr.send(JSON.stringify({
      path: parent ? `${parent}/${file.name}` : file.name,
      name: file.name,
      mime: file.type || undefined,
      contentBase64,
    }))
  })
}

async function uploadWorkspaceFiles(fileList) {
  const files = Array.from(fileList || [])
  if (!files.length) return
  const uploadButton = $('#ws-upload')
  if (uploadButton?.disabled) return
  window.clearTimeout(state.wsUploadHideTimer)
  const stamp = Date.now()
  state.wsUploads = files.map((file, index) => ({
    id: `${stamp}-${index}`,
    name: file.name || `未命名文件 ${index + 1}`,
    size: file.size,
    progress: 0,
    status: 'pending',
    error: '',
  }))
  if (uploadButton) {
    uploadButton.disabled = true
    uploadButton.setAttribute('aria-busy', 'true')
  }
  renderWorkspaceUploads()

  try {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]
      const item = state.wsUploads[index]
      if (!item) continue
      if (file.size > 50 * 1024 * 1024) {
        setWorkspaceUploadItem(item.id, { status: 'error', error: '超过 50 MB，未上传' })
        continue
      }
      try {
        setWorkspaceUploadItem(item.id, { status: 'preparing', progress: 0 })
        const base64 = await readAsBase64(file)
        setWorkspaceUploadItem(item.id, { status: 'uploading', progress: 0 })
        await uploadWorkspaceFileWithProgress(file, base64, (progress) => {
          setWorkspaceUploadItem(item.id, { status: 'uploading', progress })
        })
        setWorkspaceUploadItem(item.id, { status: 'done', progress: 100 })
      } catch (err) {
        setWorkspaceUploadItem(item.id, {
          status: 'error',
          progress: 0,
          error: `${err.message || '上传失败'}${err.hint ? `；${err.hint}` : ''}`,
        })
      }
    }
    await loadWorkspaceFiles()
  } finally {
    if (uploadButton) {
      uploadButton.disabled = false
      uploadButton.removeAttribute('aria-busy')
    }
  }
}

/* ---------------- 左侧账号信息 ---------------- */

/** 只接受 http(s) 地址，避免把后端字段当任意 URI 塞进 img。 */
function safeAvatarUrl(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  // 同源头像代理；只接受固定路径（可带用户/头像版本参数），不接受任意相对地址。
  if (raw === '/api/me/avatar' || raw.startsWith('/api/me/avatar?')) return raw
  if (raw === '/api/company/assistant-avatar' || raw.startsWith('/api/company/assistant-avatar?')) return raw
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : ''
  } catch {
    return ''
  }
}

/**
 * 头像统一渲染：有地址就用钉钉头像，没有/加载失败就露姓名首字。
 * 首字始终在 span 里，img 盖在上面；onerror 只摘掉图片和 has-photo，不留下破图。
 */
function avatarInner(name, url, fallback, eager = false) {
  const initial = esc(String(fallback || String(name || '我').trim().slice(0, 1) || '我'))
  const safeUrl = safeAvatarUrl(url)
  if (!safeUrl) return initial
  return `<img class="avatar-img" src="${esc(safeUrl)}" alt="" loading="${eager ? 'eager' : 'lazy'}" onerror="this.parentElement.classList.remove('has-photo');this.remove()">${initial}`
}

function avatarMarkup(name, url, className, fallback, eager = false) {
  const hasPhoto = Boolean(safeAvatarUrl(url))
  return `<span class="${className}${hasPhoto ? ' has-photo' : ''}">${avatarInner(name, url, fallback, eager)}</span>`
}

/**
 * 头像代理地址必须按“当前用户 + 头像地址”区分。
 * 否则同一浏览器切换账号时，浏览器会命中上一个人的 /api/me/avatar 缓存，
 * 出现“所有人的头像都是同一个人”的假象。版本参数只用于换缓存键，服务端不读取。
 */
function meAvatarUrl(me = state.me) {
  const person = me?.person
  if (!person?.avatar) return ''
  return `/api/me/avatar?v=${encodeURIComponent(`${person.id}:${person.avatar}`)}`
}

/** 后台「公司资料 → 助手身份」配置；没配置时回退到现在的「AI」。 */
function assistantIdentity() {
  const assistant = state.assistant || {}
  const name = String(assistant.name || '').trim() || 'AI'
  return { name, avatarUrl: assistant.avatarUrl || '' }
}

/**
 * AI 消息左侧统一身份区：头像在上、名字在下，和「我」的 who-me 排版对应。
 * 短名字（AI / 小易）无头像时直接露全名，长名字只露首字。
 */
function aiWhoMarkup() {
  const { name, avatarUrl } = assistantIdentity()
  const fallback = name.length <= 2 ? name : name.slice(0, 1)
  // 没配头像且名字很短时，徽标本身就露全名，不再重复一行名字；保持旧版「AI」的观感。
  const showName = Boolean(avatarUrl) || name.length > 2
  return `<div class="who-ai">${avatarMarkup(name, avatarUrl, 'who-badge ai', fallback, true)}${
    showName ? `<span class="who-name" title="${esc(name)}">${esc(name)}</span>` : ''
  }</div>`
}

/** 管理后台改名/换头像后，已经渲染的 AI 消息身份区和语音唤醒词一起热更新。 */
function applyAssistantIdentity(name, avatarUrl) {
  state.assistant = {
    name: String(name || '').trim() || 'AI',
    avatarUrl: String(avatarUrl || ''),
  }
  for (const node of [...document.querySelectorAll('.who-ai')]) node.outerHTML = aiWhoMarkup()
  renderWakeSettings()
  renderVoiceControls()
}

function renderSideUser(me) {
  $('#side-user').hidden = false
  const sideAvatar = $('#user-avatar')
  const avatarSrc = meAvatarUrl(me)
  sideAvatar.innerHTML = avatarInner(me.person.name, avatarSrc)
  sideAvatar.classList.toggle('has-photo', Boolean(avatarSrc))
  $('#user-name').textContent = me.person.name
  $('#user-title').textContent = me.person.title || '—'
  const company = me.company?.name || ''
  const dept = me.person.deptName || ''
  const org = $('#user-org')
  if (company && dept && dept !== company) {
    org.innerHTML = `<span class="side-org-company">${esc(company)}</span><span class="side-org-dept">${esc(dept)}</span>`
    org.dataset.orgText = `${company} · ${dept}`
  } else {
    org.textContent = org.dataset.orgText = company || dept || '—'
  }
  $('#user-roles').innerHTML = (me.roles || [])
    .map((role) => `<span class="pill">${esc(ROLE_LABEL[role] || role)}</span>`)
    .join('')
}

async function loadVoiceSettings() {
  try {
    const data = await api('/api/me/voice', { cache: 'no-store' })
    const voices = Array.isArray(data.voices) ? data.voices : []
    state.voiceSettings = {
      enabled: data.enabled !== false,
      activeVoiceId: String(data.activeVoiceId || 'default'),
      instructions: String(data.instructions || ''),
      speechMode: data.speechMode === 'whole' ? 'whole' : 'stream',
      defaults: data.defaults || { enabled: true, activeVoiceId: 'default' },
      voices,
      speechAvailable: Boolean(data.speechAvailable),
    }
  } catch {
    // 语音配置读不到不阻断文字对话；按钮保持隐藏/默认。
  }
  renderVoiceControls()
  renderVoiceSettings()
}

function renderVoiceControls() {
  const modeButton = $('#voice-mode')
  if (modeButton) {
    modeButton.hidden = !state.transcribeAvailable || !voiceSupported()
    modeButton.classList.toggle('is-active', state.voiceConversation.active)
    modeButton.classList.toggle(
      'is-wake-armed',
      state.wake.enabled && state.wake.active && !state.voiceConversation.active,
    )
    modeButton.setAttribute('aria-pressed', state.voiceConversation.active ? 'true' : 'false')
    const title = state.voiceConversation.active
      ? '退出语音对话'
      : state.wake.enabled
        ? `开启语音对话（也可说“${wakeNameShort()}”唤醒）`
        : '开启语音对话'
    modeButton.title = title
    modeButton.setAttribute('aria-label', title)
  }
}

function renderVoiceSettings() {
  const voice = state.voiceSettings
  const segment = $('#settings-voice-segment')
  if (segment) {
    for (const button of segment.querySelectorAll('[data-voice-enabled]')) {
      const on = button.dataset.voiceEnabled === 'true'
      button.classList.toggle('is-active', on === voice.enabled)
      button.setAttribute('aria-checked', on === voice.enabled ? 'true' : 'false')
    }
  }
  const modeSegment = $('#settings-voice-mode-segment')
  if (modeSegment) {
    for (const button of modeSegment.querySelectorAll('[data-voice-mode]')) {
      const on = button.dataset.voiceMode === (voice.speechMode === 'whole' ? 'whole' : 'stream')
      button.classList.toggle('is-active', on)
      button.setAttribute('aria-checked', on ? 'true' : 'false')
    }
  }
  const modeHint = $('#settings-voice-mode-hint')
  if (modeHint) {
    modeHint.textContent =
      voice.speechMode === 'whole'
        ? '整段播报：回答写完后一次性合成再播'
        : '边生成边播：第一句说完就开口'
  }
  const hint = $('#settings-voice-hint')
  if (hint) {
    hint.textContent = !voice.speechAvailable
      ? '还没有配置语音合成模型，暂时只回复文字'
      : voice.enabled
        ? '用语音对话时，回答会自动转成语音'
        : '已关闭：语音对话只回复文字'
  }
  const label = $('#settings-voice-label')
  if (label) {
    const active = voice.voices.find((item) => item.id === voice.activeVoiceId)
    label.textContent = !active || active.builtin ? '系统默认' : `我的声音 · ${active.name}`
  }
}

/** 语音唤醒词就是管理后台的助手名字；展示时截断，匹配时用完整名字。 */
function wakeName() {
  return assistantIdentity().name
}

function wakeNameShort() {
  const name = wakeName()
  return name.length > 16 ? `${name.slice(0, 16)}…` : name
}

/** NFKC + 去空白/标点，兼顾“E A B”“EAB”“小易，”这类 ASR 结果。 */
function normalizeWakeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

/**
 * 单字母名字被 ASR 写成中文同音字时，用真实同音字表匹配，而不是放开任意 1 字差异。
 * 例如“小E”可命中“小艺/小易/小依”，但不会把“小爱”这种不同读音也算进来。
 */
const WAKE_LATIN_HOMOPHONES = {
  a: ['诶', '欸', '艾', '哎'],
  b: ['比', '必', '毕', '碧', '币', '笔'],
  c: ['西', '希', '熙', '溪', '喜'],
  d: ['迪', '帝', '弟', '地', '蒂', '笛'],
  e: ['伊', '一', '艺', '易', '依', '衣', '亿', '忆', '医', '姨', '义', '意'],
  f: ['弗', '夫', '福'],
  g: ['吉', '基', '几', '机', '姬'],
  h: ['奇', '棋', '希'],
  i: ['爱', '艾', '哎', '矮'],
  j: ['杰', '洁', '结', '姐', '捷'],
  k: ['开', '凯', '恺'],
  l: ['勒', '乐'],
  m: ['姆', '木'],
  n: ['恩', '嗯'],
  o: ['欧', '偶', '鸥', '藕'],
  p: ['皮', '匹', '批'],
  q: ['丘', '秋', '求', '球'],
  r: ['阿', '啊'],
  s: ['斯', '思', '丝'],
  t: ['提', '蒂', '题', '体'],
  u: ['优', '尤', '悠', '有', '友'],
  v: ['维', '薇', '威', '为'],
  w: ['吴', '无', '伍'],
  x: ['克', '西', '克斯'],
  y: ['歪', '外'],
  z: ['泽', '兹', '资', '子'],
}

function wakeLatinNameVariants(value) {
  const text = String(value || '')
  if (!/[a-z]/.test(text)) return [text]
  const queue = [text]
  const output = new Set([text])
  for (let index = 0; index < queue.length && output.size < 200; index++) {
    const current = queue[index]
    for (let position = 0; position < current.length; position++) {
      const letter = current[position]
      const homophones = WAKE_LATIN_HOMOPHONES[letter]
      if (!homophones) continue
      for (const homophone of homophones) {
        const variant = current.slice(0, position) + homophone + current.slice(position + 1)
        if (output.has(variant)) continue
        output.add(variant)
        queue.push(variant)
      }
    }
  }
  return [...output].filter(Boolean)
}

/**
 * 名字里带空格/分隔符时，用户通常只喊第一段（例如“EAB 企业智能助手”只喊 EAB）。
 * 全名始终保留；额外加入 2 字以上的分段，避免长名字必须一字不差。
 */
function wakeAliases() {
  const raw = wakeName()
  const aliases = new Set()
  const full = normalizeWakeText(raw)
  if (full) aliases.add(full)
  for (const token of raw.split(/[\s·•\-_/|]+/u)) {
    const normalized = normalizeWakeText(token)
    if (normalized.length >= 2) aliases.add(normalized)
  }
  const expanded = new Set()
  for (const alias of aliases) {
    for (const variant of wakeLatinNameVariants(alias)) expanded.add(variant)
  }
  return [...expanded].filter(Boolean).sort((a, b) => b.length - a.length)
}

/** 只在转写开头匹配唤醒词，避免普通回答里出现同音词就误唤醒。 */
function wakeEditDistance(left, right) {
  const a = String(left || '')
  const b = String(right || '')
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    previous = current
  }
  return previous[b.length]
}

/**
 * 名字是“小E”时，ASR 很可能写成“小艺/小易”；这些由同音字表提前展开，按精确前缀匹配。
 * 纯中文名字在开头同长度窗口允许 1 个字差异，但 2 字名字不放宽，避免“小爱”这类不同名字误唤醒。
 */
function wakeLeadingMatch(spoken, alias) {
  if (spoken.startsWith(alias)) return { length: alias.length, exact: true }
  if (alias.length < 3 || /[a-z]/.test(alias)) return null
  const window = spoken.slice(0, alias.length)
  if (window.length !== alias.length) return null
  return wakeEditDistance(window, alias) <= 1 ? { length: alias.length, exact: false } : null
}

const WAKE_COMMAND_PREFIX = /^(帮我|帮忙|请|麻烦|打开|关掉|关闭|查|搜索|找|发|写|做|生成|总结|翻译|提醒|今天|现在|给我|把|我想|我要|你能|能否|多少|怎么|什么|为什么|谁|哪里|几点|计算|安排|预约)/
const WAKE_GREETING = /^(你好|您好|在吗|在不在|早上好|下午好|晚上好|嗨)/

function matchWakePhrase(text) {
  let spoken = normalizeWakeText(text)
  if (!spoken) return null
  spoken = spoken.replace(/^(嗯+|喂+|你好|您好|请问)+/u, '')
  for (const alias of wakeAliases()) {
    if (!alias) continue
    const hit = wakeLeadingMatch(spoken, alias)
    if (!hit) continue
    let rest = spoken.slice(hit.length)
    while (rest.startsWith(alias)) rest = rest.slice(alias.length)
    rest = rest.replace(WAKE_GREETING, '')
    rest = rest.replace(/^(请|帮我|帮忙|麻烦|然后|就是)+/u, '')
    // 近音匹配只接受明确的指令开头；只喊名字/打招呼时直接进入聆听，不误发消息。
    if (!hit.exact && rest && !WAKE_COMMAND_PREFIX.test(rest)) rest = ''
    return { alias, exact: hit.exact, command: rest }
  }
  return null
}

function renderWakeSettings() {
  const wake = state.wake
  const segment = $('#settings-wake-segment')
  if (segment) {
    for (const button of segment.querySelectorAll('[data-wake-enabled]')) {
      const on = button.dataset.wakeEnabled === 'true'
      button.classList.toggle('is-active', on === wake.enabled)
      button.setAttribute('aria-checked', on === wake.enabled ? 'true' : 'false')
      button.disabled = !state.transcribeAvailable || !voiceSupported()
    }
  }
  const hint = $('#settings-wake-hint')
  if (hint) {
    if (!state.transcribeAvailable) hint.textContent = '还没有配置语音转写模型，暂时不能语音唤醒'
    else if (!voiceSupported()) hint.textContent = '当前浏览器不支持录音，暂时不能语音唤醒'
    else if (!wake.enabled) hint.textContent = `开启后说“${wakeNameShort()}”即可开始语音对话`
    else if (wake.lastError) hint.textContent = `麦克风未启动：${wake.lastError}`
    else if (wake.active) hint.textContent = `正在听，说“${wakeNameShort()}”开始对话（页面打开时持续使用麦克风）`
    else if (state.voiceConversation.active) hint.textContent = `语音对话进行中；退出对话后会自动恢复“${wakeNameShort()}”唤醒`
    else if (wake.phase === 'processing') hint.textContent = '正在识别刚才那句话…'
    else hint.textContent = `已开启，但麦克风暂未运行；点“开启”重新启用`
  }
  const modeButton = $('#voice-mode')
  if (modeButton) {
    const on = wake.enabled && wake.active && !state.voiceConversation.active
    modeButton.classList.toggle('is-wake-armed', on)
    if (!state.voiceConversation.active) {
      const title = wake.enabled
        ? `开启语音对话（也可说“${wakeNameShort()}”唤醒）`
        : '开启语音对话'
      modeButton.title = title
      modeButton.setAttribute('aria-label', title)
    }
  }
}

function persistWakePreference(enabled) {
  try {
    if (enabled) localStorage.setItem(WAKE_PREF_KEY, '1')
    else localStorage.removeItem(WAKE_PREF_KEY)
  } catch {
    // 隐私模式或存储被禁用时，只在本次页面内生效。
  }
}

function stopWakeVad() {
  window.clearInterval(wakeVadTimer)
  wakeVadTimer = 0
  wakeAnalyser = null
  wakeVadData = null
  wakeSpeechFrames = 0
  const context = wakeAudioContext
  wakeAudioContext = null
  if (context && context.state !== 'closed') void context.close().catch(() => {})
}

function resetWakeTurns() {
  window.clearInterval(wakeTimer)
  wakeTimer = 0
  wakeStartedAt = 0
  wakeSpeechStarted = false
  wakeSpeechMs = 0
  wakeSilenceMs = 0
  wakeNoSpeechMs = 0
  wakeThreshold = 0.012
  wakeCalibrating = true
  wakeCalibrationUntil = 0
  wakeCalibrationSamples = []
  wakeSpeechFrames = 0
  wakeChunks = []
  wakeDiscounted = false
}

function cleanupWakeCapture() {
  stopWakeVad()
  for (const track of wakeStream?.getTracks?.() || []) track.stop()
  wakeStream = null
  wakeRecorder = null
}

function stopWakeListener(options = {}) {
  const wake = state.wake
  wake.generation += 1
  const recorder = wakeRecorder
  wakeRecorder = null
  wakeDiscounted = true
  if (recorder) {
    recorder.onstop = null
    try {
      recorder.stop()
    } catch {
      // 已经停止时忽略
    }
  }
  cleanupWakeCapture()
  resetWakeTurns()
  wake.active = false
  wake.phase = 'idle'
  if (!options.keepEnabled) {
    wake.enabled = false
    persistWakePreference(false)
  }
  renderWakeSettings()
  renderVoiceControls()
}

function scheduleWakeRestart(delay = 350) {
  const wake = state.wake
  window.clearTimeout(wakeTimer)
  wakeTimer = 0
  if (!wake.enabled || wake.active || state.voiceConversation.active || document.hidden) return
  if (wakePlaybackAudible()) {
    // 助手正在播报：先把唤醒采集停住，播完再自动恢复，避免转录到自己的声音。
    wakeTimer = window.setTimeout(() => scheduleWakeRestart(600), 600)
    return
  }
  const generation = wake.generation
  wakeTimer = window.setTimeout(() => {
    if (!wake.enabled || wake.active || generation !== wake.generation) return
    if (state.voiceConversation.active || document.hidden) return
    void startWakeListener({ quiet: true })
  }, Math.max(0, delay))
}

/** 助手自己的播报声不能被当成唤醒词，否则回答里提到名字就会自我唤醒。 */
function wakePlaybackAudible() {
  const audio = state.activeVoiceAudio
  if (audio && !audio.paused && !audio.ended) return true
  return Boolean(voiceSpeechStream?.active)
}

async function startWakeListener(options = {}) {
  const wake = state.wake
  if (!wake.enabled || wake.active || state.voiceConversation.active || document.hidden) return false
  if (wakeRecorder || wakeTranscribing) return false
  if (!state.transcribeAvailable || !voiceSupported()) {
    wake.lastError = '当前环境不支持语音唤醒'
    renderWakeSettings()
    return false
  }
  const generation = wake.generation + 1
  wake.generation = generation
  wake.phase = 'starting'
  wake.lastError = ''
  try {
    wakeStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
  } catch {
    wake.lastError = '没有拿到麦克风权限'
    wake.phase = 'error'
    renderWakeSettings()
    return false
  }
  if (!wake.enabled || generation !== wake.generation || state.voiceConversation.active || document.hidden) {
    for (const track of wakeStream?.getTracks?.() || []) track.stop()
    wakeStream = null
    return false
  }
  const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
  const mime = preferred.find((type) => window.MediaRecorder.isTypeSupported?.(type)) || ''
  try {
    wakeRecorder = new MediaRecorder(wakeStream, mime ? { mimeType: mime } : undefined)
  } catch {
    cleanupWakeCapture()
    wake.lastError = '当前浏览器无法启动唤醒录音'
    wake.phase = 'error'
    renderWakeSettings()
    return false
  }
  resetWakeTurns()
  wakeStartedAt = Date.now()
  wakeCalibrationUntil = wakeStartedAt + 650
  wakeRecorder.ondataavailable = (event) => {
    if (event.data?.size) wakeChunks.push(event.data)
  }
  wakeRecorder.onstop = () => {
    const chunks = wakeChunks.slice()
    const type = wakeRecorder?.mimeType || wakeStream?.getAudioTracks?.()[0]?.getSettings?.()?.mimeType || 'audio/webm'
    const discounted = wakeDiscounted
    wakeChunks = []
    cleanupWakeCapture()
    resetWakeTurns()
    wake.active = false
    if (generation !== state.wake.generation || !state.wake.enabled) return
    if (discounted || !chunks.length) {
      wake.phase = 'idle'
      renderWakeSettings()
      scheduleWakeRestart(280)
      return
    }
    wake.phase = 'processing'
    renderWakeSettings()
    void transcribeWakeAudio(new Blob(chunks, { type }), generation)
  }
  wakeRecorder.start()
  wake.active = true
  wake.phase = 'listening'
  startWakeVad(wakeStream, generation)
  wakeTimer = window.setInterval(() => {
    if (!wakeRecorder) return
    if (Date.now() - wakeStartedAt >= WAKE_MAX_SEGMENT_MS) stopWakeSegment('max')
  }, 1000)
  renderWakeSettings()
  renderVoiceControls()
  if (!options.quiet) {
    banner(`语音唤醒已开启：页面打开期间会持续使用麦克风，说“${wakeNameShort()}”开始语音对话。`, 'ok')
  }
  return true
}

function stopWakeSegment(reason) {
  if (!wakeRecorder) return
  stopWakeVad()
  wakeDiscounted = reason !== 'speech'
  try {
    wakeRecorder.stop()
  } catch {
    cleanupWakeCapture()
    resetWakeTurns()
    scheduleWakeRestart(300)
  }
}

function startWakeVad(stream, generation) {
  stopWakeVad()
  const wake = state.wake
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext
  if (!AudioContextCtor) return
  try {
    wakeAudioContext = new AudioContextCtor()
    const source = wakeAudioContext.createMediaStreamSource(stream)
    wakeAnalyser = wakeAudioContext.createAnalyser()
    wakeAnalyser.fftSize = 1024
    wakeAnalyser.smoothingTimeConstant = 0.45
    source.connect(wakeAnalyser)
    wakeVadData = new Uint8Array(wakeAnalyser.fftSize)
    void wakeAudioContext.resume().catch(() => {})
  } catch {
    stopWakeVad()
    return
  }
  wakeVadTimer = window.setInterval(() => {
    if (!wakeAnalyser || !wakeVadData) return
    if (generation !== wake.generation || !wake.enabled || !wake.active) return
    if (state.voiceConversation.active || document.hidden) {
      stopWakeSegment('suspend')
      return
    }
    // 播报期间不能把助手自己的声音送进 ASR，等播完再重新开一段唤醒采集。
    if (wakePlaybackAudible()) {
      stopWakeSegment('playback')
      return
    }
    const now = Date.now()
    if (now - wakeStartedAt >= WAKE_MAX_SEGMENT_MS) {
      stopWakeSegment('max')
      return
    }
    wakeAnalyser.getByteTimeDomainData(wakeVadData)
    let sum = 0
    for (const value of wakeVadData) {
      const centered = (value - 128) / 128
      sum += centered * centered
    }
    const rms = Math.sqrt(sum / wakeVadData.length)
    if (wakeCalibrating) {
      wakeCalibrationSamples.push(rms)
      if (now >= wakeCalibrationUntil || wakeCalibrationSamples.length >= 8) {
        const average = wakeCalibrationSamples.reduce((total, value) => total + value, 0) /
          Math.max(1, wakeCalibrationSamples.length)
        wakeThreshold = Math.max(0.01, Math.min(0.06, average * 2.6))
        wakeCalibrating = false
      }
      return
    }
    if (!wakeSpeechStarted) {
      wakeNoSpeechMs += 90
      if (rms > wakeThreshold && rms > 0.016) wakeSpeechFrames += 1
      else wakeSpeechFrames = 0
      if (wakeSpeechFrames >= 3) {
        wakeSpeechStarted = true
        wakeSpeechMs = 240
        wakeSilenceMs = 0
        wakeNoSpeechMs = 0
      } else if (wakeNoSpeechMs >= WAKE_IDLE_RESTART_MS) {
        stopWakeSegment('idle')
      }
      return
    }
    wakeSpeechMs += 90
    if (rms > Math.max(0.012, wakeThreshold * 0.72)) wakeSilenceMs = 0
    else wakeSilenceMs += 90
    if (wakeSpeechMs >= 600 && wakeSilenceMs >= 1_050) stopWakeSegment('speech')
  }, 90)
}

async function transcribeWakeAudio(blob, generation) {
  const wake = state.wake
  if (!wake.enabled || generation !== wake.generation || state.voiceConversation.active) return
  if (blob.size < 600) {
    scheduleWakeRestart(260)
    return
  }
  wakeTranscribing = true
  try {
    const rawDataUrl = await blobToDataUrl(blob)
    const baseType = (blob.type || 'audio/webm').split(';')[0].toLowerCase()
    const dataUrl = rawDataUrl.replace(/^data:(audio\/[^;,]+)(?:;[^;,]*)*;base64,/i, `data:${baseType};base64,`)
    const result = await api('/api/chat/transcribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dataUrl }),
    })
    if (!wake.enabled || generation !== wake.generation || state.voiceConversation.active) return
    const text = String(result?.text || '').trim()
    if (!text) {
      scheduleWakeRestart(320)
      return
    }
    const hit = matchWakePhrase(text)
    if (!hit) {
      scheduleWakeRestart(220)
      return
    }
    const command = hit.command
    // 已经命中名字：先停唤醒采集，再进入正式语音对话；有后半句就直接发送。
    stopWakeListener({ keepEnabled: true })
    await enterVoiceConversation({ wake: true, command })
  } catch (err) {
    if (!wake.enabled || generation !== state.wake.generation || state.voiceConversation.active) return
    wake.lastError = String(err?.message || '语音识别失败')
    renderWakeSettings()
    scheduleWakeRestart(900)
  } finally {
    wakeTranscribing = false
  }
}

async function setWakeEnabled(enabled, options = {}) {
  const wake = state.wake
  const next = Boolean(enabled)
  wake.enabled = next
  persistWakePreference(next)
  renderWakeSettings()
  if (!next) {
    stopWakeListener({ keepEnabled: true })
    if (!options.quiet) banner('已关闭语音唤醒', 'ok')
    return
  }
  if (wake.active) {
    renderVoiceControls()
    if (!options.quiet) {
      banner(`语音唤醒已开启：页面打开期间会持续使用麦克风，说“${wakeNameShort()}”开始语音对话。`, 'ok')
    }
    return
  }
  const started = await startWakeListener(options)
  if (!started) {
    wake.enabled = false
    persistWakePreference(false)
    renderWakeSettings()
    if (!options.quiet) {
      banner(wake.lastError || '语音唤醒没有启动，请检查麦克风权限后重试', 'warn')
    }
  }
}

function restoreWakePreference() {
  let saved = false
  try {
    saved = localStorage.getItem(WAKE_PREF_KEY) === '1'
  } catch {
    saved = false
  }
  state.wake.enabled = saved
  renderWakeSettings()
  if (saved) {
    void startWakeListener({ quiet: true }).then((started) => {
      if (started) return
      state.wake.enabled = false
      persistWakePreference(false)
      renderWakeSettings()
    })
  }
}

function stopActiveVoice() {
  const audio = state.activeVoiceAudio
  const reset = state.activeVoiceReset
  state.activeVoiceReset = null
  if (audio) {
    try {
      audio.pause()
      audio.currentTime = 0
    } catch {
      // 音频对象被浏览器回收时忽略
    }
  }
  state.activeVoiceAudio = null
  reset?.({ ok: true, paused: true })
}

function voiceButtonState(node, text, disabled = false) {
  const button = node?.querySelector?.('.msg-voice')
  if (!button) return
  button.hidden = false
  button.disabled = disabled
  const label = button.querySelector('span')
  if (label) label.textContent = text
}

/**
 * 本地 TTS 端点通常只允许一个合成任务；把所有合成请求串起来，避免并发触发上游 409。
 * 队列只保证“请求不并发”，播放本身仍可自行重叠（例如用户快速重播上一条）。
 */
let voiceSpeakChain = Promise.resolve()

function speakAnswer(node, text, options = {}) {
  const run = () => speakAnswerNow(node, text, options)
  const queued = voiceSpeakChain.then(run, run)
  voiceSpeakChain = queued.then(
    () => undefined,
    () => undefined,
  )
  return queued
}

async function speakAnswerNow(node, text, options = {}) {
  if (!state.speechAvailable || !state.voiceSettings.enabled) {
    options.onDone?.({ ok: false, reason: 'unavailable' })
    return
  }
  const clean = String(text || '').trim()
  if (!clean) {
    options.onDone?.({ ok: false, reason: 'empty' })
    return
  }
  const button = node?.querySelector('.msg-voice')
  if (button && button.dataset.speaking === 'true') {
    // 同一回答正在播/正在合成：再点一次就暂停。
    if (state.activeVoiceAudio && !state.activeVoiceAudio.paused) stopActiveVoice()
    return
  }
  if (button) button.dataset.speaking = 'true'
  voiceButtonState(node, '生成语音…', true)
  try {
    const limit = Math.max(1, Math.min(600, Number(options.maxChars) || 240))
    let spoken = clean
    if (clean.length > limit) {
      const head = clean.slice(0, limit)
      const cut = Math.max(
        head.lastIndexOf('。'),
        head.lastIndexOf('！'),
        head.lastIndexOf('？'),
        head.lastIndexOf('；'),
        head.lastIndexOf('\n'),
        head.lastIndexOf('，'),
      )
      spoken = cut >= Math.floor(limit * 0.5) ? head.slice(0, cut + 1) : `${head}…`
    }
    const data = await api('/api/chat/speech', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: spoken }),
    })
    if (!data?.audio) throw new Error('语音合成没有返回音频')
    // 合成期间用户可能已经退出语音对话或切换会话；这里再确认一次，避免退出后突然播报。
    if (options.isStale?.()) {
      if (button) button.dataset.speaking = 'false'
      voiceButtonState(node, '播放语音')
      return
    }
    stopActiveVoice()
    const audio = new Audio(String(data.audio))
    state.activeVoiceAudio = audio
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      if (state.activeVoiceAudio === audio) state.activeVoiceAudio = null
      if (state.activeVoiceReset === finish) state.activeVoiceReset = null
      if (button) button.dataset.speaking = 'false'
      voiceButtonState(node, '播放语音')
      options.onDone?.(result)
    }
    const reset = () => finish({ ok: true, ended: true })
    state.activeVoiceReset = finish
    audio.addEventListener('ended', reset, { once: true })
    audio.addEventListener('error', () => finish({ ok: false, reason: 'audio-error' }), { once: true })
    if (button) {
      button.onclick = () => {
        if (audio.paused) {
          state.activeVoiceAudio = audio
          void audio.play().then(() => voiceButtonState(node, '暂停语音')).catch(() => voiceButtonState(node, '点此播放'))
        } else {
          stopActiveVoice()
        }
      }
    }
    voiceButtonState(node, '播放语音')
    if (options.auto !== false) {
      try {
        await audio.play()
        // 播放启动是异步的：如果 play() 尚未 resolve 时已被打断，不能再把按钮写回“暂停语音”。
        if (settled || state.activeVoiceAudio !== audio || audio.paused) return
        voiceButtonState(node, '暂停语音')
        options.onStart?.()
      } catch {
        // 浏览器自动播放策略拦截时，按钮已经在，用户点一下即可。
        voiceButtonState(node, '点此播放')
        finish({ ok: false, reason: 'autoplay-blocked' })
      }
    }
  } catch (err) {
    if (button) button.dataset.speaking = 'false'
    voiceButtonState(node, '语音生成失败')
    if (options.auto !== false) banner(err.message || '语音回复生成失败，文字回答已保留', 'warn')
    options.onDone?.({ ok: false, reason: 'error', error: err })
  }
}

function renderVoiceDockActions() {
  const vm = state.voiceConversation
  const button = $('#voice-dock-action')
  if (!button) return
  const labels = {
    listening: ['结束这句', false],
    speaking: ['打断', false],
    transcribing: ['处理中', true],
    thinking: ['处理中', true],
    paused: ['继续聆听', false],
    error: ['重试', false],
  }
  const entry = labels[vm.phase]
  if (!entry) {
    button.hidden = true
    return
  }
  button.hidden = false
  button.disabled = entry[1]
  button.textContent = entry[0]
}

function setVoiceDockStatus(phase, title, detail) {
  const vm = state.voiceConversation
  vm.phase = phase
  const dock = $('#voice-dock')
  if (dock) {
    dock.hidden = false
    dock.classList.remove('is-listening', 'is-transcribing', 'is-thinking', 'is-speaking', 'is-error')
    if (phase === 'listening') dock.classList.add('is-listening')
    else if (phase === 'transcribing') dock.classList.add('is-transcribing')
    else if (phase === 'thinking') dock.classList.add('is-thinking')
    else if (phase === 'speaking') dock.classList.add('is-speaking')
    else if (phase === 'error') dock.classList.add('is-error')
  }
  const titleEl = $('#voice-dock-title')
  const detailEl = $('#voice-dock-detail')
  if (titleEl) titleEl.textContent = title
  if (detailEl) detailEl.textContent = detail
  renderVoiceDockActions()
}

function scheduleVoiceConversationListen(delay = 350, force = false) {
  const vm = state.voiceConversation
  window.clearTimeout(vm.resumeTimer)
  vm.resumeTimer = 0
  if (!vm.active) return
  const generation = vm.generation
  vm.resumeTimer = window.setTimeout(() => {
    if (!vm.active || generation !== vm.generation) return
    void startVoiceConversationListening(force)
  }, Math.max(0, delay))
}

async function startVoiceConversationListening(force = false) {
  const vm = state.voiceConversation
  if (!vm.active) return false
  // 手动重试或定时续听重叠时，先取消尚未触发的续听，避免重复开麦。
  window.clearTimeout(vm.resumeTimer)
  vm.resumeTimer = 0
  if (voiceRecorder || voiceTranscribing) return false
  // 用户开口打断播报时，即使模型还在生成后半段，也要立刻回到聆听；
  // 新一句话会进入发送队列，等当前回答收尾后再发出去。
  if (!force && sessionReplyBusy()) {
    setVoiceDockStatus('thinking', '回答还在生成', '回答结束后会自动继续聆听')
    return false
  }
  setVoiceDockStatus('listening', '正在打开麦克风…', '稍等，马上就绪')
  const started = await startVoiceRecording()
  if (!started && vm.active && vm.phase !== 'error') {
    setVoiceDockStatus('error', '麦克风没有启动', '点“重试”重新开启麦克风，或退出语音对话')
  }
  return started
}

async function enterVoiceConversation(options = {}) {
  const vm = state.voiceConversation
  if (vm.active) {
    exitVoiceConversation()
    return
  }
  if (!state.transcribeAvailable) {
    banner('还没有配置语音转写模型，暂时不能使用语音对话', 'warn')
    return
  }
  if (!voiceSupported()) {
    banner('当前浏览器不支持录音，请换用 Chrome、Edge 或钉钉内置浏览器', 'warn')
    return
  }
  if (voiceTranscribing) {
    banner('正在识别上一条语音，请稍候再开启语音对话', 'warn')
    return
  }
  if (voiceRecorder) stopVoiceRecording(true, { reason: 'cancel' })
  // 正式对话和唤醒采集互斥；唤醒偏好保留，退出对话后再自动恢复。
  stopWakeListener({ keepEnabled: true })
  stopActiveVoice()
  abortVoiceSpeechStream({ quiet: true })
  voicePlayback()
  vm.active = true
  vm.generation += 1
  vm.sessionId = state.sessionId
  vm.resumeTimer = 0
  renderVoiceControls()
  renderWakeSettings()
  const dock = $('#voice-dock')
  if (dock) dock.hidden = false
  setVoiceDockStatus('listening', '正在连接麦克风…', '首次使用需要允许浏览器使用麦克风')
  if (!state.speechAvailable) banner('还没有配置语音合成模型，回答只会显示文字，播报后不会自动续听', 'warn')
  else if (!state.voiceSettings.enabled) banner('语音回复已关闭：回答只会显示文字，播报后不会自动续听', 'warn')
  const command = String(options.command || '').trim()
  if (command) {
    const input = $('#input')
    input.value = command
    input.style.height = '44px'
    updateSendState()
    setVoiceDockStatus(
      'thinking',
      '正在思考回答…',
      `通过“${wakeNameShort()}”唤醒：${command.length > 24 ? `${command.slice(0, 24)}…` : command}`,
    )
    await send({ voiceInput: true, voiceConversation: true })
    return
  }
  await startVoiceConversationListening()
}

function exitVoiceConversation(options = {}) {
  const vm = state.voiceConversation
  if (!vm.active && options.silent !== true) return
  vm.active = false
  vm.generation += 1
  window.clearTimeout(vm.resumeTimer)
  vm.resumeTimer = 0
  if (voiceRecorder) stopVoiceRecording(true, { reason: 'cancel' })
  stopActiveVoice()
  abortVoiceSpeechStream({ quiet: true })
  stopVoiceBargeInMonitor()
  closeVoicePlayback()
  voiceDiscount = false
  setVoiceDockStatus('idle', '语音对话已结束', '')
  const dock = $('#voice-dock')
  if (dock) dock.hidden = true
  renderVoiceControls()
  renderWakeSettings()
  if (!options.silent) banner(options.reason || '已退出语音对话', 'warn')
  // 用户显式开过语音唤醒时，退出对话后恢复待唤醒；否则保持静默。
  if (state.wake.enabled) scheduleWakeRestart(300)
}

function interruptVoiceConversation() {
  const vm = state.voiceConversation
  if (!vm.active) return
  abortVoiceSpeechStream({ quiet: true })
  stopActiveVoice()
  stopVoiceBargeInMonitor()
  setVoiceDockStatus('listening', '已打断播报', '现在可以直接说话')
  scheduleVoiceConversationListen(180, true)
}

function handleVoiceConversationAnswer(node, text) {
  const vm = state.voiceConversation
  if (!vm.active) return
  const generation = vm.generation
  const readable = String(text || '').trim()
  if (!readable) {
    scheduleVoiceConversationListen(300)
    return
  }
  if (!state.speechAvailable || !state.voiceSettings.enabled) {
    setVoiceDockStatus('paused', '回答已生成，未自动播报', '没有可用的语音合成，或语音回复已关闭')
    return
  }
  // 正常路径由 delta 边生成边播；这里兜底处理“只有最终文本、没有增量”的模型。
  const stream = voiceSpeechStream
  if (stream) {
    endVoiceSpeechStream(stream, readable)
    return
  }
  const next = beginVoiceSpeechStream(node, generation)
  if (!next) {
    setVoiceDockStatus('paused', '语音合成未启动', '文字回答已保留；可点“继续聆听”继续语音对话')
    return
  }
  feedVoiceSpeechStream(readable)
  endVoiceSpeechStream(next, readable)
}

function handleVoiceDockAction() {
  const vm = state.voiceConversation
  if (!vm.active) return
  if (vm.phase === 'speaking') {
    interruptVoiceConversation()
    return
  }
  if (vm.phase === 'listening') {
    stopVoiceRecording(false, { reason: 'manual' })
    return
  }
  if (vm.phase === 'paused' || vm.phase === 'error') {
    void startVoiceConversationListening()
  }
}

async function showVoiceSettings() {
  await loadVoiceSettings()
  const current = state.voiceSettings
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  let voices = current.voices.slice()
  let activeVoiceId = current.activeVoiceId
  let draft = null
  let preview = null
  overlay.innerHTML = `<div class="modal voice-modal">
    <div class="modal-head"><h3>我的音色</h3><button class="modal-x" type="button" aria-label="关闭">×</button></div>
    <div class="hint">默认使用系统音色。也可以创建自己的声音；EAB 会按你写的描述生成声音，不会采集或保存你的本人录音。</div>
    <div class="voice-body" id="voice-body"></div>
  </div>`
  document.body.appendChild(overlay)
  const body = overlay.querySelector('#voice-body')

  const close = () => {
    stopActiveVoice()
    preview = null
    overlay.remove()
  }
  const stopPreview = () => {
    stopActiveVoice()
    preview = null
  }
  const setNote = (text, bad = false) => {
    const note = overlay.querySelector('#voice-note')
    if (!note) return
    note.className = bad ? 'voice-note bad' : 'voice-note'
    note.textContent = text
  }
  const voiceById = (id) => voices.find((item) => item.id === id)

  const renderList = () => {
    const custom = voices.filter((item) => !item.builtin)
    const cards = custom
      .map((item) => {
        const active = item.id === activeVoiceId
        return `<div class="voice-card${active ? ' is-active' : ''}">
          <button class="voice-card-pick" type="button" data-voice-pick="${esc(item.id)}" aria-pressed="${active ? 'true' : 'false'}">
            <span class="voice-card-check" aria-hidden="true">${active ? '✓' : ''}</span>
            <span class="voice-card-copy">
              <strong>${esc(item.name)}</strong>
              <em>${esc(item.instructions)}</em>
            </span>
          </button>
          <div class="voice-card-tools">
            <button type="button" data-voice-edit="${esc(item.id)}">编辑</button>
            <button type="button" data-voice-delete="${esc(item.id)}">删除</button>
          </div>
        </div>`
      })
      .join('')
    body.innerHTML = `
      <div class="voice-section-head">
        <span class="voice-section-title">内置音色</span>
      </div>
      <div class="voice-card${activeVoiceId === 'default' ? ' is-active' : ''}">
        <button class="voice-card-pick" type="button" data-voice-pick="default" aria-pressed="${activeVoiceId === 'default' ? 'true' : 'false'}">
          <span class="voice-card-check" aria-hidden="true">${activeVoiceId === 'default' ? '✓' : ''}</span>
          <span class="voice-card-copy">
            <strong>系统默认 <span class="voice-badge">内置</span></strong>
            <em>${esc(voiceById('default')?.instructions || '清晰、自然、亲切的中文女声，语速平稳，适合办公助手。')}</em>
          </span>
        </button>
      </div>
      <div class="voice-section-head">
        <span class="voice-section-title">我的声音</span>
        <button class="voice-add" id="voice-add" type="button">＋ 新建声音</button>
      </div>
      ${cards || '<div class="voice-empty">还没有自己的声音。新建时写一段描述，保存后就可以选择使用。</div>'}
      <div class="voice-note" id="voice-note">${current.speechAvailable ? '选中后点“保存”，下一轮回答就会使用这个声音。' : '还没有配置语音合成模型，声音可以先保存，配置完成后再生效。'}</div>
      <div class="modal-actions">
        <button class="btn ghost" type="button" data-voice-cancel>取消</button>
        <button class="btn primary" type="button" id="voice-save-active">保存</button>
      </div>`
  }

  const renderEditor = () => {
    const isNew = !draft.id
    body.innerHTML = `
      <button class="voice-back" type="button" data-voice-back>← 返回我的声音</button>
      <div class="voice-section-title voice-editor-title">${isNew ? '新建声音' : '编辑声音'}</div>
      <label class="field voice-field"><span>名称</span><input id="voice-name" maxlength="40" placeholder="例如：稳重技术同事" value="${esc(draft.name || '')}" /></label>
      <label class="field voice-field"><span>声音描述</span><textarea id="voice-instructions" rows="4" maxlength="200" placeholder="例如：低沉、沉稳的男声，语速稍慢，像可靠的技术同事">${esc(draft.instructions || '')}</textarea></label>
      <div class="voice-count" id="voice-count">${draft.instructions.trim().length}/200</div>
      <div class="voice-note" id="voice-note">${current.speechAvailable ? '可以先试听，再保存并使用。' : '还没有配置语音合成模型，保存后等配置完成即可生效。'}</div>
      <div class="modal-actions">
        <button class="btn ghost" type="button" id="voice-preview" ${current.speechAvailable ? '' : 'disabled'}>试听</button>
        <button class="btn ghost" type="button" data-voice-back>取消</button>
        <button class="btn primary" type="button" id="voice-save-preset">${isNew ? '保存并使用' : '保存修改'}</button>
      </div>`
  }

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) {
      close()
      return
    }
    const pick = event.target.closest?.('[data-voice-pick]')
    if (pick) {
      stopPreview()
      activeVoiceId = pick.dataset.voicePick || 'default'
      renderList()
      return
    }
    if (event.target.closest?.('#voice-add')) {
      stopPreview()
      draft = { id: '', name: '', instructions: '' }
      renderEditor()
      return
    }
    const edit = event.target.closest?.('[data-voice-edit]')
    if (edit) {
      const voice = voiceById(edit.dataset.voiceEdit)
      if (!voice) return
      stopPreview()
      draft = { id: voice.id, name: voice.name, instructions: voice.instructions }
      renderEditor()
      return
    }
    if (event.target.closest?.('[data-voice-back]')) {
      stopPreview()
      draft = null
      renderList()
      return
    }
    if (event.target.closest?.('[data-voice-cancel]')) {
      close()
      return
    }
    if (event.target.closest?.('.modal-x')) {
      close()
      return
    }
  })

  overlay.addEventListener('input', (event) => {
    if (!draft) return
    if (event.target.id === 'voice-name') draft.name = String(event.target.value || '').slice(0, 40)
    if (event.target.id === 'voice-instructions') {
      draft.instructions = String(event.target.value || '').slice(0, 200)
      const count = overlay.querySelector('#voice-count')
      if (count) count.textContent = `${draft.instructions.trim().length}/200`
    }
  })

  overlay.addEventListener('click', async (event) => {
    if (event.target.closest?.('#voice-preview')) {
      const button = overlay.querySelector('#voice-preview')
      if (!draft || !button) return
      button.disabled = true
      setNote('正在生成试听…')
      try {
        stopPreview()
        const data = await api('/api/me/voice/preview', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            voiceId: draft.id || 'default',
            instructions: draft.instructions.trim(),
          }),
        })
        if (!data?.audio) throw new Error('试听没有返回音频')
        preview = new Audio(String(data.audio))
        state.activeVoiceAudio = preview
        await preview.play()
        setNote('正在播放试听。')
      } catch (err) {
        setNote(err.message || '试听失败', true)
      } finally {
        button.disabled = false
      }
      return
    }
    if (event.target.closest?.('#voice-save-preset')) {
      if (!draft) return
      if (!draft.instructions.trim()) {
        setNote('请先填写声音描述。', true)
        return
      }
      const button = overlay.querySelector('#voice-save-preset')
      button.disabled = true
      try {
        const path = draft.id ? `/api/me/voice/presets/${encodeURIComponent(draft.id)}` : '/api/me/voice/presets'
        const saved = await api(path, {
          method: draft.id ? 'PATCH' : 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: draft.name.trim(), instructions: draft.instructions.trim() }),
        })
        state.voiceSettings = { ...state.voiceSettings, ...saved, speechAvailable: current.speechAvailable }
        voices = state.voiceSettings.voices
        activeVoiceId = state.voiceSettings.activeVoiceId
        draft = null
        renderList()
        renderVoiceSettings()
        banner('声音已保存并使用，下一轮生效', 'ok')
      } catch (err) {
        setNote(err.message || '保存失败', true)
        button.disabled = false
      }
      return
    }
    if (event.target.closest?.('#voice-save-active')) {
      const button = overlay.querySelector('#voice-save-active')
      button.disabled = true
      try {
        const saved = await api('/api/me/voice', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ activeVoiceId }),
        })
        state.voiceSettings = { ...state.voiceSettings, ...saved, speechAvailable: current.speechAvailable }
        renderVoiceSettings()
        close()
        banner('已切换声音，下一轮生效', 'ok')
      } catch (err) {
        setNote(err.message || '保存失败', true)
        button.disabled = false
      }
      return
    }
    const remove = event.target.closest?.('[data-voice-delete]')
    if (remove) {
      const id = remove.dataset.voiceDelete
      const voice = voiceById(id)
      if (!voice) return
      if (!window.confirm(`删除“${voice.name}”？删除后如果它正在使用，会自动回到系统默认。`)) return
      remove.disabled = true
      try {
        const saved = await api(`/api/me/voice/presets/${encodeURIComponent(id)}`, { method: 'DELETE' })
        state.voiceSettings = { ...state.voiceSettings, ...saved, speechAvailable: current.speechAvailable }
        voices = state.voiceSettings.voices
        activeVoiceId = state.voiceSettings.activeVoiceId
        renderList()
        renderVoiceSettings()
        banner('声音方案已删除', 'ok')
      } catch (err) {
        setNote(err.message || '删除失败', true)
        remove.disabled = false
      }
    }
  })

  renderList()
}

async function showMemories() {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  let activeFilter = 'active'
  let searchText = ''
  const filters = [
    ['active', '生效中'],
    ['pending', '待确认'],
    ['conflict', '冲突'],
    ['archived', '已归档'],
    ['expired', '已失效'],
    ['all', '全部'],
  ]
  const matchesFilter = (item) => {
    if (activeFilter === 'all') return true
    if (activeFilter === 'active') return item.status === 'active' && item.confirmed
    if (activeFilter === 'pending') return item.status === 'pending'
    if (activeFilter === 'conflict') return item.status === 'conflict'
    if (activeFilter === 'archived') return item.status === 'archived'
    if (activeFilter === 'expired') return item.status === 'expired'
    return true
  }
  const countFor = (key, stats) => {
    if (!stats?.counts) return 0
    if (key === 'all') return stats.counts.total || 0
    if (key === 'active') return stats.counts.active || 0
    if (key === 'pending') return (stats.counts.pending || 0) + (stats.counts.conflict || 0)
    if (key === 'conflict') return stats.counts.conflict || 0
    if (key === 'archived') return stats.counts.archived || 0
    if (key === 'expired') return stats.counts.expired || 0
    return 0
  }
  const render = (items, stats, autoExtract) => {
    const autoMode = autoExtract?.mode || 'rules'
    const autoConfirm = autoExtract?.autoConfirm !== false
    const autoLabel = autoMode === 'off'
      ? '自动抽取已关闭'
      : autoConfirm
        ? `自动记忆已开启${autoMode === 'llm' ? '（规则 + 模型）' : ''}`
        : '自动抽取为影子模式，需确认后生效'
    const typeLabel = (type) => ({ preference: '偏好', fact: '事实', decision: '决策', episode: '情景' }[type] || '事实')
    const scopeLabel = (scope) => ({ user: '个人', dept: '部门', company: '公司' }[scope] || scope)
    const statusOf = (item) => {
      if (item.status === 'archived') return { tone: 'pending', text: '已归档' }
      if (item.status === 'expired') return { tone: 'pending', text: '已失效' }
      if (item.status === 'conflict') return { tone: 'warn', text: '冲突待确认' }
      if (item.confirmed) {
        if (item.source === 'consolidated') return { tone: 'ok', text: '情景合集' }
        return { tone: 'ok', text: item.source === 'auto' ? '自动记忆' : '已生效' }
      }
      if (item.source === 'auto') return { tone: 'pending', text: '自动待确认' }
      return { tone: 'pending', text: '待确认' }
    }
    const sourceTag = (item) => {
      if (item.source === 'auto') return item.confirmed ? '自动记忆' : '自动候选'
      if (item.source === 'consolidated') return '夜间合并'
      return ''
    }
    const visible = items
      .filter(matchesFilter)
      .filter((item) => {
        if (!searchText) return true
        return `${item.content} ${item.factKey || ''} ${item.object || ''}`.toLowerCase().includes(searchText)
      })
    const cards = visible
      .map((item) => {
        const status = statusOf(item)
        const conflict = item.status === 'conflict' && item.conflictContent
          ? `<p class="mem-conflict"><span>与旧记忆冲突</span>${esc(String(item.conflictContent).slice(0, 80))}</p>`
          : ''
        const action = !item.confirmed && item.status !== 'archived' && item.status !== 'expired'
          ? `<button class="link-btn accent" type="button" data-mem-confirm="${esc(item.id)}">${
            item.status === 'conflict' ? '确认替换' : '确认'
          }</button>`
          : ''
        const merged = item.mergedFrom?.length
          ? `<span class="mem-tag">合并 ${item.mergedFrom.length} 条</span>`
          : ''
        const recalled = item.recallCount > 0
          ? `<span class="mem-tag">召回 ${item.recallCount} 次</span>`
          : ''
        return `<article class="mem-card is-${status.tone}">
          <div class="mem-card-body">
            <p class="mem-text">${esc(item.content)}</p>
            <div class="mem-tags">
              <span class="mem-badge is-${status.tone}">${status.text}</span>
              <span class="mem-tag">${esc(typeLabel(item.memoryType))}</span>
              <span class="mem-tag">${esc(scopeLabel(item.scopeType))}</span>
              ${sourceTag(item) ? `<span class="mem-tag is-source">${esc(sourceTag(item))}</span>` : ''}
              ${item.factKey ? `<span class="mem-tag">${esc(item.factKey)}</span>` : ''}
              ${merged}${recalled}
            </div>
            ${conflict}
          </div>
          <div class="mem-card-actions">${action}<button class="link-btn danger-link" type="button" data-mem-del="${esc(item.id)}">删除</button></div>
        </article>`
      })
      .join('')
    const emptyText = activeFilter === 'archived'
      ? '还没有归档记忆。长期没被召回的情景会在夜间整理时归档。'
      : activeFilter === 'expired'
        ? '没有失效记忆。结构化事实被新值替换后会保留在这里。'
        : activeFilter === 'pending'
          ? '没有待确认记忆。个人高置信事实和偏好会自动生效。'
          : '还没有记忆。聊到稳定的偏好或事实时，会自动记住。'
    const list = visible.length
      ? `<div class="mem-list" data-motion="stagger">${cards}</div>`
      : `<div class="mem-empty"><span class="mem-empty-icon">✦</span><p>${esc(emptyText)}</p></div>`
    const tabs = filters.map(([key, label]) => {
      const count = countFor(key, stats)
      return `<button class="mem-filter${activeFilter === key ? ' is-active' : ''}" type="button" data-mem-filter="${key}">${label}<span>${count}</span></button>`
    }).join('')
    const statsLine = stats?.counts
      ? `<div class="mem-stats">
          <div class="mem-stat"><strong>${stats.counts.active}</strong><span>生效中</span></div>
          <div class="mem-stat"><strong>${stats.counts.autoActive}</strong><span>自动记忆</span></div>
          <div class="mem-stat"><strong>${(stats.counts.pending || 0) + (stats.counts.conflict || 0)}</strong><span>待确认</span></div>
          <div class="mem-stat"><strong>${stats.counts.archived}</strong><span>已归档</span></div>
          <div class="mem-stat"><strong>${stats.counts.recalls}</strong><span>累计召回</span></div>
        </div>`
      : ''
    const maintenance = stats?.maintenance
      ? `上次整理：${memoryStamp(stats.maintenance.finishedAt || stats.maintenance.startedAt) || '刚刚'}，合并 ${
        Number(stats.maintenance.result?.consolidated || 0)
      } 组、归档 ${Number(stats.maintenance.result?.archived || 0)} 条`
      : '还没有运行过记忆整理'
    const extraction = stats?.extraction
    const channelLabels = { web: '网页', dingtalk: '钉钉', feishu: '飞书', schedule: '定时任务' }
    const channelSummary = (extraction?.channels || [])
      .filter((item) => item.runs > 0)
      .map((item) => `${channelLabels[item.channel] || item.channel} ${item.runs} 轮`)
      .join('、')
    const extractionLine = extraction
      ? extraction.runs > 0
        ? `近 ${extraction.windowDays} 天自动记忆：${extraction.runs} 轮，生效 ${extraction.activated} 条（${extraction.activationRate}%），待确认 ${extraction.pending} 条，冲突 ${extraction.conflicts} 条，重复 ${extraction.duplicates} 条${channelSummary ? `；${channelSummary}` : ''}`
        : `近 ${extraction.windowDays} 天还没有自动记忆抽取记录`
      : ''
    const benchmark = stats?.benchmark
    const benchmarkDataset = benchmark?.dataset
    const benchmarkLast = benchmark?.lastRun
    const benchmarkLine = benchmarkDataset
      ? benchmarkLast
        ? `记忆评测：${benchmarkLast.total} 条基准用例，通过 ${benchmarkLast.passed} 条（${benchmarkLast.passRate}%）；漏写 ${benchmarkLast.missed} 条（${benchmarkLast.missRate}%），误写 ${benchmarkLast.unexpected} 条（${benchmarkLast.miswriteRate}%），敏感泄漏 ${benchmarkLast.sensitiveLeaks} 条；${benchmarkLast.retention.rounds} 轮针事实${
          benchmarkLast.retention.recalled ? `第 ${benchmarkLast.retention.rank} 位命中` : '未命中'
        }。上次 ${memoryStamp(benchmarkLast.createdAt) || '刚刚'}${benchmarkLast.stale ? '；基准已更新，建议重跑' : ''}`
        : `记忆评测：${benchmarkDataset.total} 条基准用例 + ${benchmarkDataset.retentionRounds} 轮针事实召回，还没有运行过`
      : ''
    const canWrite = (state.me?.capabilities || []).some((cap) => cap.scope === 'memory:write' || cap.scope === 'memory:admin')
    const canMaintain = (state.me?.capabilities || []).some((cap) => cap.scope === 'memory:admin')
    overlay.innerHTML = `<div class="modal memory-modal">
      <div class="modal-head mem-head">
        <span class="mem-head-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 3.75h9a2 2 0 0 1 2 2v14.5l-6.5-3.9-6.5 3.9V5.75a2 2 0 0 1 2-2z"/><path d="M9.5 8.75h5"/></svg>
        </span>
        <div class="mem-head-copy">
          <h3>我的记忆</h3>
          <p class="mem-head-note">${esc(autoLabel)}。${autoConfirm ? '不需要手动确认，随时可以删除。' : '自动候选必须确认后才生效。'}团队记忆仍需管理员确认。</p>
        </div>
        <button class="modal-x" type="button" aria-label="关闭">×</button>
      </div>
      <div class="mem-body">
        ${statsLine}
        <div class="mem-toolbar">
          <div class="mem-filters">${tabs}</div>
          <input class="mem-search" id="mem-search" placeholder="搜索记忆内容或键" value="${esc(searchText)}" />
        </div>
        <div class="mem-section-head">
          <span class="mem-section-title">${esc(filters.find(([key]) => key === activeFilter)?.[1] || '记忆')}</span>
          <span class="mem-count">${visible.length} 条</span>
        </div>
        ${list}
        ${extractionLine ? `<div class="mem-maintenance mem-quality"><span>${esc(extractionLine)}</span></div>` : ''}
        ${benchmarkLine ? `<div class="mem-benchmark">
          <div class="mem-benchmark-copy">
            <span class="mem-benchmark-title">规则基线</span>
            <span>${esc(benchmarkLine)}</span>
          </div>
          ${canWrite ? `<button class="link-btn" type="button" id="mem-benchmark-run">运行评测</button>` : ''}
        </div>` : ''}
        <div class="mem-maintenance">
          <span>${esc(maintenance)}</span>
          ${canMaintain ? '<button class="link-btn" type="button" id="mem-maintain">立即整理</button>' : ''}
        </div>
        <div class="mem-compose">
          <div class="mem-compose-head">
            <span class="mem-compose-title">新增一条</span>
            <label class="mem-type-pick">
              <span>类型</span>
              <select id="mem-type"><option value="preference">偏好</option><option value="fact">事实</option><option value="decision">决策</option><option value="episode">情景</option></select>
            </label>
          </div>
          <input id="mem-input" placeholder="例如：汇报材料尽量用一页纸" maxlength="1000" />
          <div class="modal-state" id="mem-state"></div>
          <div class="mem-compose-actions">
            <button class="link-btn" type="button" id="mem-close">关闭</button>
            <button class="btn primary" type="button" id="mem-add">保存</button>
          </div>
        </div>
      </div>
    </div>`
    const close = () => overlay.remove()
    overlay.querySelector('.modal-x').addEventListener('click', close)
    overlay.querySelector('#mem-close').addEventListener('click', close)
    for (const tab of overlay.querySelectorAll('[data-mem-filter]')) {
      tab.addEventListener('click', () => {
        activeFilter = tab.dataset.memFilter || 'active'
        render(items, stats, autoExtract)
      })
    }
    overlay.querySelector('#mem-search').addEventListener('input', (event) => {
      searchText = String(event.target.value || '').trim().toLowerCase()
      const caret = event.target.selectionStart
      // 列表、空态和计数一起重绘，避免搜索“从 0 条变多条”时只更新了计数。
      render(items, stats, autoExtract)
      const nextInput = overlay.querySelector('#mem-search')
      if (nextInput) {
        nextInput.focus()
        nextInput.setSelectionRange(caret, caret)
      }
    })
    overlay.querySelector('#mem-add').addEventListener('click', async () => {
      const stateEl = overlay.querySelector('#mem-state')
      const content = overlay.querySelector('#mem-input').value.trim()
      const memoryType = overlay.querySelector('#mem-type').value
      if (!content) {
        stateEl.className = 'modal-state bad'
        stateEl.textContent = '先写点内容'
        return
      }
      try {
        await api('/api/memories', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content, scopeType: 'user', memoryType }) })
        await refresh()
      } catch (err) {
        stateEl.className = 'modal-state bad'
        stateEl.textContent = err.message || '保存失败'
      }
    })
    const maintain = overlay.querySelector('#mem-maintain')
    if (maintain) {
      maintain.addEventListener('click', async () => {
        maintain.disabled = true
        try {
          const result = await api('/api/memories/maintenance/run', { method: 'POST' })
          banner(`记忆整理完成：合并 ${result.consolidated} 组，归档 ${result.archived} 条`, 'ok')
        } catch (err) {
          banner(err.message || '整理失败', 'bad')
        }
        await refresh()
      })
    }
    const benchmarkRun = overlay.querySelector('#mem-benchmark-run')
    if (benchmarkRun) {
      benchmarkRun.addEventListener('click', async () => {
        benchmarkRun.disabled = true
        benchmarkRun.textContent = '评测中…'
        try {
          const result = await api('/api/memories/benchmark/run', { method: 'POST' })
          const retention = result.retention?.recalled ? `，${result.retention.rounds} 轮召回第 ${result.retention.rank} 位` : ''
          banner(`记忆评测完成：通过 ${result.passed}/${result.total}，漏写 ${result.missed} 条，误写 ${result.unexpected} 条${retention}`, 'ok')
          await refresh()
        } catch (err) {
          banner(err.message || '评测失败', 'bad')
          benchmarkRun.disabled = false
          benchmarkRun.textContent = '运行评测'
        }
      })
    }
    for (const button of overlay.querySelectorAll('[data-mem-confirm]')) {
      button.addEventListener('click', async () => {
        await api(`/api/memories/${encodeURIComponent(button.dataset.memConfirm)}/confirm`, { method: 'POST' }).catch(() => null)
        await refresh()
      })
    }
    for (const button of overlay.querySelectorAll('[data-mem-del]')) {
      button.addEventListener('click', async () => {
        try {
          await api(`/api/memories/${encodeURIComponent(button.dataset.memDel)}`, { method: 'DELETE' })
          banner('记忆已删除', 'ok')
        } catch (err) {
          banner(err.message || '删除失败', 'bad')
        }
        await refresh()
      })
    }
  }
  const refresh = async () => {
    try {
      const [data, stats] = await Promise.all([
        api('/api/memories?status=all'),
        api('/api/memories/stats').catch(() => null),
      ])
      render(data.memories || [], stats, data.autoExtract || { mode: 'rules', autoConfirm: true })
    } catch (err) {
      render([], null, { mode: 'rules', autoConfirm: true })
      const stateEl = overlay.querySelector('#mem-state')
      if (stateEl) stateEl.textContent = err.message
    }
  }
  document.body.appendChild(overlay)
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) overlay.remove()
  })
  await refresh()
}

function showMyCaps() {
  const me = state.me
  if (!me) return
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  const caps = (me.capabilities || []).map((cap) => `<span class="chip" title="${esc(cap.scope)}">${esc(cap.label)}</span>`).join('')
  const roles = (me.roles || []).map((role) => `<span class="pill">${esc(ROLE_LABEL[role] || role)}</span>`).join('')
  overlay.innerHTML = `<div class="modal">
    <div class="modal-head"><h3>我的权限</h3><button class="modal-x" type="button">×</button></div>
    <div class="kv-grid">
      <div><span>姓名</span><strong>${esc(me.person.name)}</strong></div>
      <div><span>部门</span><strong>${esc(me.person.deptName || '—')}</strong></div>
      <div><span>公司</span><strong>${esc(me.company?.name || '—')}</strong></div>
      <div><span>角色</span><strong>${roles || '—'}</strong></div>
    </div>
    <div class="modal-section-title">能做的事 <span>${(me.capabilities || []).length} 项</span></div>
    <div class="scope-groups"><div class="scope-group">${caps || '<span class="muted">暂无</span>'}</div></div>
    <div class="modal-actions"><button class="btn primary" type="button" id="caps-ok">知道了</button></div>
  </div>`
  document.body.appendChild(overlay)
  const close = () => overlay.remove()
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close()
  })
  overlay.querySelector('.modal-x').addEventListener('click', close)
  overlay.querySelector('#caps-ok').addEventListener('click', close)
}

function showPasswordModal() {
  const configured = state.me?.passwordConfigured === true
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `<div class="modal password-modal">
    <div class="modal-head"><h3>${configured ? '修改密码' : '设置登录密码'}</h3><button class="modal-x" type="button">×</button></div>
    <p class="hint">${
      configured
        ? '修改成功后，其他设备上的登录会失效，当前浏览器保持登录。'
        : '当前账号由钉钉同步，还没有设置过登录密码，直接设置新密码即可；设置后其他设备上的登录会失效，当前浏览器保持登录。'
    }</p>
    <div class="form-grid">
      ${
        configured
          ? '<label class="password-old"><span>当前密码</span><input id="password-old" type="password" autocomplete="current-password" spellcheck="false" placeholder="输入当前登录密码" /></label>'
          : ''
      }
      <label><span>新密码</span><input id="password-new" type="password" autocomplete="new-password" spellcheck="false" maxlength="128" placeholder="至少 8 位" /></label>
      <label><span>确认新密码</span><input id="password-confirm" type="password" autocomplete="new-password" spellcheck="false" maxlength="128" placeholder="再输入一次新密码" /></label>
    </div>
    <div class="modal-state" id="password-state"></div>
    <div class="modal-actions"><button class="btn ghost" type="button" id="password-cancel">取消</button><button class="btn primary" type="button" id="password-save">${configured ? '保存新密码' : '设置密码'}</button></div>
  </div>`
  document.body.appendChild(overlay)
  const close = () => overlay.remove()
  const oldInput = overlay.querySelector('#password-old')
  const newInput = overlay.querySelector('#password-new')
  const confirmInput = overlay.querySelector('#password-confirm')
  const saveButton = overlay.querySelector('#password-save')
  const stateEl = overlay.querySelector('#password-state')
  let busy = false

  const fail = (message, focus) => {
    stateEl.className = 'modal-state bad'
    stateEl.textContent = message
    if (focus) {
      focus.focus()
      focus.select?.()
    }
  }

  const submit = async () => {
    if (busy) return
    const oldPassword = oldInput?.value ?? ''
    const newPassword = newInput.value
    const confirmPassword = confirmInput.value
    if (configured && !oldPassword) return fail('请输入当前密码', oldInput)
    if (newPassword.length < 8) return fail('新密码至少 8 位', newInput)
    if (newPassword !== confirmPassword) return fail('两次输入的新密码不一致', confirmInput)
    if (configured && newPassword === oldPassword) return fail('新密码不能和当前密码相同', newInput)
    busy = true
    saveButton.disabled = true
    saveButton.textContent = '正在保存…'
    stateEl.className = 'modal-state muted'
    stateEl.textContent = configured ? '正在更新密码…' : '正在设置密码…'
    try {
      await api('/api/auth/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ oldPassword, newPassword }),
      })
      if (state.me) state.me.passwordConfigured = true
      renderPasswordSettingRow()
      close()
      banner(configured ? '密码已修改，其他设备已退出登录' : '登录密码已设置，其他设备已退出登录', 'ok')
    } catch (err) {
      busy = false
      saveButton.disabled = false
      saveButton.textContent = configured ? '保存新密码' : '设置密码'
      fail(err.message || '密码设置失败', /当前密码|旧密码/.test(err.message || '') ? oldInput : null)
    }
  }

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close()
  })
  overlay.querySelector('.modal-x').addEventListener('click', close)
  overlay.querySelector('#password-cancel').addEventListener('click', close)
  saveButton.addEventListener('click', submit)
  for (const input of [oldInput, newInput, confirmInput].filter(Boolean)) {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        submit()
      }
    })
  }
  ;(oldInput ?? newInput).focus()
}

/* ---------------- 工作台：对话 / 个人插件 ---------------- */

/** 顶部标题跟随当前页面：工作台显示「工作台」，对话显示会话标题（没有就显示 对话 / 新对话） */
function syncChatTitle() {
  const el = $('#chat-title')
  if (!el) return
  if (state.mode === 'workspace') {
    el.textContent = '工作台'
    return
  }
  const sessions = Array.isArray(state.sessions) ? state.sessions : []
  const current = state.sessionId ? sessions.find((item) => item.id === state.sessionId) : null
  el.textContent = (current && current.title) || (state.sessionId ? '对话' : '新对话')
}

const paneEnterTimers = new WeakMap()

function clearPaneEnter(pane) {
  if (!pane) return
  const timer = paneEnterTimers.get(pane)
  if (timer) window.clearTimeout(timer)
  paneEnterTimers.delete(pane)
  pane.classList.remove('is-pane-enter')
}

/** 工作台整页 / 文件预览进入只做 6px 位移，不隐藏首屏；截图或 reduced-motion 下都不会挡住内容。 */
function playPaneEnter(pane) {
  if (!pane) return
  clearPaneEnter(pane)
  void pane.offsetWidth
  pane.classList.add('is-pane-enter')
  const timer = window.setTimeout(() => {
    pane.classList.remove('is-pane-enter')
    paneEnterTimers.delete(pane)
  }, 220)
  paneEnterTimers.set(pane, timer)
}

function playWorkspaceEnter() {
  playPaneEnter($('#workspace-pane'))
}

function setChatMode(mode) {
  if (state.filePreview) closeWorkspaceFile()
  const next = mode === 'workspace' ? 'workspace' : 'chat'
  state.mode = next
  state.view = next
  $('.chat-main').classList.toggle('is-workspace', next === 'workspace')
  $('#thread').hidden = next !== 'chat'
  $('.composer').hidden = next !== 'chat'
  $('#workspace-pane').hidden = next !== 'workspace'
  syncWorkbenchLayout()
  for (const button of $('#mode-switch').querySelectorAll('[data-mode]')) {
    const active = button.dataset.mode === next
    button.classList.toggle('is-active', active)
    button.setAttribute('aria-selected', active ? 'true' : 'false')
  }
  if (next === 'workspace') {
    playWorkspaceEnter()
    syncChatTitle()
    if (state.workspaceKind === 'skills') loadMySkills()
    else loadMyPlugins()
  } else {
    clearPaneEnter($('#workspace-pane'))
    syncChatTitle()
    syncThreadScrollState()
  }
  persistChatLocation()
}

async function loadMyPlugins() {
  const rail = $('#my-plugin-rail')
  const detail = $('#my-plugin-detail')
  if (!rail || !detail) return
  rail.innerHTML = '<div class="plugin-empty muted">正在读取插件…</div>'
  detail.innerHTML = '<div class="plugin-empty muted">正在读取插件…</div>'
  try {
    const data = await api(`/api/my/plugins${qs()}`)
    state.pluginData = data
    state.plugins = Array.isArray(data.plugins) ? data.plugins : []
    if (!state.pluginSelected || !state.plugins.some((item) => item.id === state.pluginSelected)) {
      state.pluginSelected = state.plugins[0]?.id ?? null
      state.pluginTab = 'overview'
      state.pluginPageKey = null
    }
    renderMyPluginWorkspace()
    warmMyPluginKernel(data)
  } catch (err) {
    rail.innerHTML = `<div class="plugin-empty bad">读取插件失败：${esc(err.message)}</div>`
    detail.innerHTML = `<div class="plugin-empty bad">读取插件失败：${esc(err.message)}</div>`
  }
}

const MY_PLUGIN_SOURCE_LABEL = {
  'browser-dir': '本机文件夹',
  npm: 'npm 包',
  github: 'GitHub 仓库',
  catalog: '服务器插件目录',
}

function myPluginStatus(plugin) {
  if (!plugin.valid) return { label: '清单无效', tone: 'danger' }
  if (!plugin.enabled) return { label: '已停用', tone: 'warn' }
  if (plugin.host?.error) return { label: '启用 · host 异常', tone: 'danger' }
  if (plugin.format === 'dsh') {
    return plugin.host?.loaded
      ? { label: '运行中', tone: 'ok' }
      : { label: '已启用 · host 待加载', tone: 'warn' }
  }
  return { label: '已启用', tone: 'ok' }
}

/** 个人插件操作按当前账号角色授权；权限数据未加载时先按锁定处理。 */
function myPluginCan(action) {
  return state.pluginData?.permissions?.[action] === true
}

function myPluginLockedNote(action) {
  const labels = { install: '安装个人插件', configure: '启停个人插件', uninstall: '卸载个人插件' }
  return `<div class="plugin-note plugin-permission-note">当前账号的角色没有「${labels[action] || action}」权限，操作已锁定；请联系管理员在控制台「角色管理」里授权。</div>`
}

function myPluginStatusPill(plugin) {
  const status = myPluginStatus(plugin)
  return `<span class="pill ${status.tone}">${esc(status.label)}</span>`
}

function myPluginSourceLabel(plugin) {
  return MY_PLUGIN_SOURCE_LABEL[plugin.install?.source] || plugin.install?.source || '个人安装'
}

let myPluginKernelWarmStarted = false
const prefetchedMyPluginAssets = new Set()

/** 个人插件 client bundle 的稳定 URL；v= 版本、h= 校验和，同版本覆盖更新也能失效。 */
function myPluginClientAssetUrl(plugin, page) {
  const path = String(page.file || '')
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')
  const version = encodeURIComponent(plugin.version || '')
  const checksum = encodeURIComponent(plugin.checksum || '')
  const versionKey = version ? `&v=${version}` : ''
  const checksumKey = checksum ? `&h=${checksum}` : ''
  return `/plugins/assets/${encodeURIComponent(plugin.id)}/${path}?scope=user${versionKey}${checksumKey}`
}

function prefetchMyPluginClientBundles(plugins) {
  for (const plugin of plugins || []) {
    if (!plugin.valid || !plugin.enabled) continue
    for (const page of plugin.pages || []) {
      if ((page.kind || 'html') !== 'dsh-client') continue
      const url = myPluginClientAssetUrl(plugin, page)
      if (prefetchedMyPluginAssets.has(url)) continue
      prefetchedMyPluginAssets.add(url)
      fetch(url, { credentials: 'include', cache: 'force-cache' }).catch(() => {})
    }
  }
}

function warmMyPluginKernel(data) {
  if (!data || !data.companyId) return
  const run = () => {
    // 共享内核只启动一次；每轮个人插件列表刷新只补拉新增/升级的 bundle。
    if (!myPluginKernelWarmStarted) {
      myPluginKernelWarmStarted = true
      const frame = document.createElement('iframe')
      const params = new URLSearchParams({ warm: '1', scope: 'user', company: data.companyId || '' })
      if (currentAs()) params.set('as', currentAs())
      frame.src = `/plugin-kernel.html?${params.toString()}`
      frame.title = 'DSH 插件内核预热'
      frame.tabIndex = -1
      frame.setAttribute('aria-hidden', 'true')
      frame.style.cssText = 'position:absolute;width:1px;height:1px;left:-10px;top:-10px;opacity:0;pointer-events:none;border:0'
      let cleaned = false
      const cleanup = () => {
        if (cleaned) return
        cleaned = true
        frame.remove()
        window.removeEventListener('message', onMessage)
      }
      const onMessage = (event) => {
        if (event.origin !== location.origin) return
        if (event.source !== frame.contentWindow) return
        if (event.data && event.data.type === 'eab-plugin-kernel-warm') cleanup()
      }
      window.addEventListener('message', onMessage)
      frame.addEventListener('load', () => setTimeout(cleanup, 8000), { once: true })
      document.body.appendChild(frame)
    }

    prefetchMyPluginClientBundles(data.plugins || [])
  }
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: 2000 })
  else setTimeout(run, 800)
}

function myPluginPageUrl(data, plugin, page) {
  const kind = page.kind || 'html'
  if (kind === 'dsh-client') {
    const params = new URLSearchParams({
      id: plugin.id,
      entry: page.file,
      company: data.companyId || '',
      version: plugin.version || '',
      title: page.title || plugin.name || plugin.id,
      scope: 'user',
    })
    if (plugin.checksum) params.set('h', plugin.checksum)
    if (currentAs()) params.set('as', currentAs())
    return `/plugin-kernel.html?${params.toString()}`
  }
  const path = String(page.file || '')
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')
  const params = new URLSearchParams(location.search)
  params.set('scope', 'user')
  const text = params.toString()
  return `/plugins/assets/${encodeURIComponent(plugin.id)}/${path}${text ? `?${text}` : ''}`
}

function myPluginRailItem(plugin) {
  const status = myPluginStatus(plugin)
  const active = plugin.id === state.pluginSelected
  const format = plugin.format === 'dsh' ? 'DSH' : 'EAB'
  return `<button class="plugin-rail-item ${active ? 'is-active' : ''} ${plugin.enabled ? '' : 'is-muted'}" type="button" data-motion="lift" data-my-plugin-select="${esc(plugin.id)}">
    <span class="plugin-rail-avatar ${plugin.enabled ? '' : 'ghost'}">${esc((plugin.name || plugin.id).slice(0, 1).toUpperCase())}</span>
    <span class="plugin-rail-text">
      <strong>${esc(plugin.name || plugin.id)}</strong>
      <small>${esc(format)} · v${esc(plugin.version || '—')} · ${esc(status.label)}</small>
    </span>
    <span class="plugin-rail-dot ${status.tone === 'ok' ? 'ok' : status.tone === 'warn' ? 'warn' : 'bad'}" aria-hidden="true"></span>
  </button>`
}

function myPluginRailHtml(data) {
  const plugins = data.plugins || state.plugins || []
  const stats = data.stats || { installed: plugins.length, enabled: 0, tools: 0 }
  const who = state.me?.person?.name || '个人空间'
  return `<div class="plugin-rail-top">
      <div class="plugin-scope-block">
        <span class="plugin-scope-eyebrow">个人空间</span>
        <strong>${esc(who)}</strong>
        <small>只显示你自己安装的插件</small>
      </div>
      <div class="plugin-rail-metrics">
        <div><strong>${stats.installed}</strong><span>已装</span></div>
        <div><strong>${stats.enabled}</strong><span>启用</span></div>
        <div><strong>${stats.tools}</strong><span>工具</span></div>
      </div>
      <div class="plugin-rail-actions">
        <button class="btn primary sm" type="button" data-my-plugin-install ${myPluginCan('install') ? '' : 'disabled title="当前角色没有安装个人插件权限"'}>＋ 安装插件</button>
        <button class="btn ghost sm" type="button" data-my-plugin-refresh>刷新</button>
      </div>
    </div>
    <div class="plugin-rail-head">已安装 <span class="muted">${plugins.length}</span><span class="plugin-rail-head-hint" title="点击卡片切换下方详情" aria-label="点击卡片切换下方详情"><svg aria-hidden="true" width="10" height="10" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.2" stroke="currentColor" stroke-width="1.2"/><path d="M8 7.4v3.6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="8" cy="4.6" r=".9" fill="currentColor"/></svg></span></div>
    <div class="plugin-rail-list">
      ${plugins.length ? plugins.map(myPluginRailItem).join('') : '<div class="plugin-empty">还没有个人插件</div>'}
    </div>`
}

function myPluginOverviewBody(data, plugin) {
  const pages = plugin.pages || []
  const tools = plugin.tools || []
  const scopes = plugin.scopes || []
  const pagesHtml = pages.length
    ? pages
        .map(
          (page) =>
            `<button class="btn ghost sm" type="button" data-my-plugin-page="${esc(page.file)}" ${plugin.enabled ? '' : 'disabled title="先启用插件"'}>${esc(page.title || page.id)}</button>`,
        )
        .join('')
    : '<span class="muted">没有页面入口</span>'
  const toolHtml = tools.length
    ? tools.map((tool) => `<span class="chip">${esc(tool.name)}</span>`).join('')
    : '<span class="muted">没有注册工具</span>'
  return `<div class="plugin-overview">
    <section class="plugin-block">
      <h3>插件概况</h3>
      <div class="plugin-kv">
        <div><span>版本</span><strong>v${esc(plugin.version || '—')}</strong></div>
        <div><span>格式</span><strong>${plugin.format === 'dsh' ? 'DSH 插件' : 'EAB 插件'}</strong></div>
        <div><span>作者</span><strong>${esc(plugin.author || '未知作者')}</strong></div>
        <div><span>许可证</span><strong>${esc(plugin.license || '未声明')}</strong></div>
        <div><span>关键词</span><strong>${esc((plugin.keywords || []).join('、') || '—')}</strong></div>
        <div><span>权限需求</span><strong>${esc(scopes.join('、') || '无')}</strong></div>
      </div>
      <div class="plugin-page-list"><span>贡献页面</span><div>${pagesHtml}</div></div>
    </section>
    <section class="plugin-block">
      <h3>安装与归属</h3>
      <div class="plugin-kv">
        <div><span>归属</span><strong>个人安装（只影响我）</strong></div>
        <div><span>安装方式</span><strong>${esc(myPluginSourceLabel(plugin))}</strong></div>
        <div><span>安装时间</span><strong>${esc(workspaceFileDate(plugin.install?.installedAt))}</strong></div>
        <div><span>最近更新</span><strong>${esc(workspaceFileDate(plugin.install?.updatedAt))}</strong></div>
        <div><span>校验和</span><span class="mono">${esc(plugin.install?.checksum || plugin.checksum || '—')}</span></div>
      </div>
      <div class="plugin-inject-row"><span>工具</span><div>${toolHtml}</div></div>
    </section>
    <section class="plugin-block">
      <h3>运行状态</h3>
      <div class="plugin-kv">
        <div><span>启用状态</span><strong>${esc(myPluginStatus(plugin).label)}</strong></div>
        <div><span>对话模型</span><strong>${tools.length ? `${tools.length} 个工具 · ${tools.filter((tool) => tool.available).length} 个已授权` : '没有工具，只提供页面'}</strong></div>
        <div><span>DSH 宿主</span><strong>${plugin.format === 'dsh' ? (plugin.host?.loaded ? '已运行' : plugin.host?.error || '未运行') : '不需要'}</strong></div>
      </div>
      <div class="plugin-note">停用或卸载个人安装后，这个插件由个人安装贡献的工具会从你的工具列表移除；如果公司也安装并启用了同一插件，公司那份仍可能对全员可用。</div>
    </section>
  </div>`
}

function myPluginPagesBody(data, plugin) {
  const pages = plugin.pages || []
  if (!plugin.valid) {
    return `<div class="plugin-page-blocked"><strong>插件清单无效</strong><span>${esc(plugin.error || '无法读取插件页面')}</span></div>`
  }
  if (!plugin.enabled) {
    return `<div class="plugin-page-blocked">
      <div><strong>插件已停用</strong><span>启用后才能在个人工作台里打开页面。</span></div>
      <button class="btn primary sm" type="button" data-my-plugin-toggle data-next-enabled="1" ${myPluginCan('configure') ? '' : 'disabled title="当前角色没有启停个人插件权限"'}>启用插件</button>
    </div>${myPluginCan('configure') ? '' : myPluginLockedNote('configure')}`
  }
  if (!pages.length) {
    return `<div class="plugin-note">这个插件没有声明页面，只提供工具或后台能力。</div>`
  }
  const active = pages.find((page) => page.file === state.pluginPageKey) || pages[0]
  const url = myPluginPageUrl(data, plugin, active)
  const switcher =
    pages.length > 1
      ? `<div class="plugin-page-switch">${pages
          .map(
            (page) =>
              `<button class="plugin-page-tab ${page === active ? 'is-active' : ''}" type="button" data-my-plugin-page="${esc(page.file)}">${esc(page.title || page.id)}</button>`,
          )
          .join('')}</div>`
      : ''
  return `${switcher}<div class="ws-plugin-frame"><iframe title="${esc(active.title || plugin.name)}" sandbox="allow-same-origin allow-scripts allow-forms" src="${esc(url)}"></iframe></div>`
}

function myPluginToolsBody(plugin) {
  const tools = plugin.tools || []
  if (!plugin.enabled) {
    return `<div class="plugin-page-blocked">
      <div><strong>插件已停用</strong><span>启用后，插件注册的工具才会出现在对话模型的工具列表里。</span></div>
      <button class="btn primary sm" type="button" data-my-plugin-toggle data-next-enabled="1" ${myPluginCan('configure') ? '' : 'disabled title="当前角色没有启停个人插件权限"'}>启用插件</button>
    </div>${myPluginCan('configure') ? '' : myPluginLockedNote('configure')}`
  }
  if (!tools.length) {
    return `<div class="plugin-note">这个插件没有注册工具；它的能力可能在页面里，或者只提供宿主通道。</div>`
  }
  return `<div class="plugin-note">这些是你个人安装的插件注册的工具，只有你能看到、也只有你能用，不需要角色授权。停用或卸载个人安装后会从你的个人工具集移除；公司级安装的同一插件不受影响。</div>
    <div class="ws-tool-list">
      ${tools
        .map((tool) => {
          const properties = tool.input?.properties && typeof tool.input.properties === 'object' ? tool.input.properties : {}
          const required = Array.isArray(tool.input?.required) ? tool.input.required : []
          const params = Object.keys(properties)
            .map((name) => `<span class="chip">${esc(name)}${required.includes(name) ? ' · 必填' : ''}</span>`)
            .join('')
          return `<article class="ws-tool-row">
            <div class="ws-tool-main">
              <div class="ws-tool-head"><code>${esc(tool.name)}</code><span class="pill ${tool.available ? 'ok' : 'warn'}">${tool.available ? '本人可用' : '当前账号不可用'}</span></div>
              <p>${esc(tool.description || '没有描述')}</p>
              <div class="ws-tool-params">${params || '<span class="muted">无参数</span>'}</div>
            </div>
            <span class="ws-tool-id mono">${esc(tool.id)}</span>
          </article>`
        })
        .join('')}
    </div>`
}

function myPluginVersionsBody(plugin) {
  const install = plugin.install || {}
  return `<div class="plugin-version-current">
      <div><span class="plugin-version-label">当前版本</span><strong>v${esc(plugin.version || '—')}</strong></div>
      ${myPluginStatusPill(plugin)}
    </div>
    <section class="plugin-block">
      <h3>安装记录</h3>
      <div class="plugin-kv">
        <div><span>安装范围</span><strong>个人安装</strong></div>
        <div><span>安装方式</span><strong>${esc(myPluginSourceLabel(plugin))}</strong></div>
        <div><span>首次安装</span><strong>${esc(workspaceFileDate(install.installedAt))}</strong></div>
        <div><span>最近更新</span><strong>${esc(workspaceFileDate(install.updatedAt))}</strong></div>
        <div><span>校验和</span><span class="mono">${esc(install.checksum || plugin.checksum || '—')}</span></div>
        <div><span>生命周期</span><strong>${esc(plugin.lifecycle || (plugin.enabled ? 'enabled' : 'disabled'))}</strong></div>
      </div>
      <div class="plugin-note">个人卸载只会解除你自己的安装，不会删除插件文件，也不影响公司和同事。</div>
    </section>`
}

function myPluginSettingsBody(plugin) {
  const host = plugin.host
  const hostBlock =
    plugin.format === 'dsh'
      ? `<div class="plugin-host-detail">
          <div class="plugin-setting-row" style="margin:0 0 10px;padding:0;border:0;background:transparent">
            <div><strong>DSH 宿主</strong><span>${host?.loaded ? '已运行，插件页面可以通过宿主通道读写数据。' : esc(host?.error || '尚未加载；启用后宿会自动重扫。')}</span></div>
            <span class="pill ${host?.loaded ? 'ok' : 'warn'}">${host?.loaded ? '运行中' : '未运行'}</span>
          </div>
          <div class="plugin-host-routes">${(host?.routes || []).length ? host.routes.map((route) => `<span class="chip">${esc(route)}</span>`).join('') : '<span class="muted">没有注册通道</span>'}</div>
          <button class="btn ghost sm" type="button" data-my-plugin-host-refresh>刷新宿主状态</button>
        </div>`
      : `<div class="plugin-note">这是静态页面插件，不需要 DSH 宿主。</div>`
  return `<div class="plugin-setting-row">
      <div><strong>个人启用</strong><span>只影响你自己；停用后个人安装的页面入口和工具会收起，公司安装的同一插件不受影响。</span></div>
      <button class="btn ${plugin.enabled ? 'ghost' : 'primary'} sm" type="button" data-my-plugin-toggle data-next-enabled="${plugin.enabled ? '0' : '1'}" ${myPluginCan('configure') ? '' : 'disabled title="当前角色没有启停个人插件权限"'}>${plugin.enabled ? '停用' : '启用'}</button>
    </div>
    ${myPluginCan('configure') ? '' : myPluginLockedNote('configure')}
    ${hostBlock}
    <div class="plugin-danger-zone">
      <div><strong>卸载个人插件</strong><span>只解除你自己的安装。公司级安装和别人的工作台不受影响。</span></div>
      <button class="btn ghost sm danger-text" type="button" data-my-plugin-uninstall ${myPluginCan('uninstall') ? '' : 'disabled title="当前角色没有卸载个人插件权限"'}>卸载…</button>
    </div>
    ${myPluginCan('uninstall') ? '' : myPluginLockedNote('uninstall')}`
}

function myPluginDetailHtml(data, plugin) {
  const status = myPluginStatus(plugin)
  const formatBadge = `<span class="plugin-format-badge ${plugin.format === 'dsh' ? 'dsh' : ''}">${plugin.format === 'dsh' ? 'DSH' : 'EAB'}</span>`
  const tab = state.pluginTab || 'overview'
  const tabs = [
    ['overview', '概览', ''],
    ['pages', '页面', (plugin.pages || []).length],
    ['tools', '工具', (plugin.tools || []).length],
    ['versions', '版本', ''],
    ['settings', '设置', ''],
  ]
  const tabHtml = tabs
    .map(
      ([key, label, count]) =>
        `<button class="plugin-tab ${tab === key ? 'is-active' : ''}" type="button" data-my-plugin-tab="${key}" role="tab" aria-selected="${tab === key}">${label}${count !== '' ? `<span class="plugin-tab-count">${count}</span>` : ''}</button>`,
    )
    .join('')
  const body =
    tab === 'pages'
      ? myPluginPagesBody(data, plugin)
      : tab === 'tools'
        ? myPluginToolsBody(plugin)
        : tab === 'versions'
          ? myPluginVersionsBody(plugin)
          : tab === 'settings'
            ? myPluginSettingsBody(plugin)
            : myPluginOverviewBody(data, plugin)
  const pageAction = (plugin.pages || []).length
    ? `<button class="btn ghost sm" type="button" data-my-plugin-page-first ${plugin.enabled ? '' : 'disabled title="先启用插件"'}>打开页面</button>`
    : ''
  const lockedActions = [
    myPluginCan('configure') ? '' : '启停个人插件',
    myPluginCan('uninstall') ? '' : '卸载个人插件',
  ].filter(Boolean)
  const permissionNote = lockedActions.length
    ? `<div class="plugin-note plugin-permission-note">当前账号的角色没有「${lockedActions.join('」「')}」权限，相关按钮已锁定；请联系管理员在控制台「角色管理」里授权。</div>`
    : ''
  return `<section class="panel plugin-detail">
    <div class="plugin-detail-head">
      <div class="plugin-title">
        <span class="plugin-avatar">${esc((plugin.name || plugin.id).slice(0, 1).toUpperCase())}</span>
        <div class="plugin-title-text">
          <div class="plugin-title-row"><h2>${esc(plugin.name || plugin.id)}</h2>${formatBadge}${myPluginStatusPill(plugin)}</div>
          <div class="plugin-subline"><span>v${esc(plugin.version || '—')}</span><span>${esc(plugin.author || '未知作者')}</span><span>个人安装</span></div>
        </div>
      </div>
      <div class="plugin-detail-actions">
        ${pageAction}
        <button class="btn ghost sm" type="button" data-my-plugin-toggle data-next-enabled="${plugin.enabled ? '0' : '1'}" ${myPluginCan('configure') ? '' : 'disabled title="当前角色没有启停个人插件权限"'}>${plugin.enabled ? '停用' : '启用'}</button>
        <button class="btn ghost sm danger-text" type="button" data-my-plugin-uninstall ${myPluginCan('uninstall') ? '' : 'disabled title="当前角色没有卸载个人插件权限"'}>卸载…</button>
      </div>
    </div>
    ${permissionNote}
    <div class="plugin-tabs" role="tablist">${tabHtml}</div>
    <div id="plugin-tab-body">${body}</div>
  </section>`
}

function myPluginWelcomeHtml(data) {
  const plugins = data.plugins || []
  const stats = data.stats || { installed: plugins.length, enabled: 0, tools: 0 }
  const empty = plugins.length === 0
  return `<div class="plugin-welcome">
    <div class="plugin-welcome-mark">P</div>
    <h2>${empty ? '还没有个人插件' : '从左侧选择一个插件'}</h2>
    <p>${empty ? '这里只显示你自己安装的插件。公司安装的插件不会混进来；安装后可以启停、卸载和打开插件页面。' : '左侧列出的是你本人安装的插件，点一个就能查看详情、启停、卸载和打开页面。'}</p>
    <div class="plugin-welcome-stats">
      <div><strong>${stats.installed}</strong><span>已安装</span></div>
      <div><strong>${stats.enabled}</strong><span>已启用</span></div>
      <div><strong>${stats.tools}</strong><span>可用工具</span></div>
    </div>
    <div class="plugin-welcome-actions">
      <button class="btn primary" type="button" data-my-plugin-install ${myPluginCan('install') ? '' : 'disabled title="当前角色没有安装个人插件权限"'}>安装个人插件</button>
      <button class="btn ghost" type="button" data-my-plugin-refresh>刷新</button>
    </div>
    ${myPluginCan('install') ? '' : myPluginLockedNote('install')}
  </div>`
}

function decorateWorkspaceMotion() {
  const detail = $('#my-plugin-detail')
  if (!detail) return
  for (const block of detail.querySelectorAll('.plugin-block')) {
    if (!block.hasAttribute('data-motion')) block.setAttribute('data-motion', 'reveal')
  }
  window.EABMotion?.init(detail)
}

function renderMyPluginWorkspace() {
  const rail = $('#my-plugin-rail')
  const detail = $('#my-plugin-detail')
  if (!rail || !detail) return
  const data = state.pluginData || { plugins: state.plugins, stats: null }
  rail.innerHTML = myPluginRailHtml(data)
  const plugin = (data.plugins || []).find((item) => item.id === state.pluginSelected)
  detail.innerHTML = plugin ? myPluginDetailHtml(data, plugin) : myPluginWelcomeHtml(data)
  bindMyPluginWorkspace()
  decorateWorkspaceMotion()
}

function openMyPluginUninstall(plugin) {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `<div class="modal plugin-install-modal">
    <div class="modal-head">
      <div><h3>卸载「${esc(plugin.name || plugin.id)}」</h3><span class="muted">只解除你自己的个人安装</span></div>
      <button class="modal-x" type="button">×</button>
    </div>
    <div class="plugin-danger-zone" style="margin-top:4px">
      <div><strong>确认从个人工作台卸载？</strong><span>插件文件不会被删除，公司级安装和别人的工作台不受影响；之后可以重新安装。</span></div>
    </div>
    <div class="install-progress" id="mu-progress" hidden aria-live="polite">
      <div class="install-progress-track"><span class="install-progress-bar"></span></div>
      <div class="install-progress-meta">
        <span id="mu-progress-text">正在卸载…</span>
        <span id="mu-progress-time" class="mono">0s</span>
      </div>
    </div>
    <div class="modal-state" id="mu-state"></div>
    <div class="modal-actions">
      <button class="btn ghost" type="button" data-my-uninstall-cancel>取消</button>
      <button class="btn danger" type="button" data-my-uninstall-confirm>卸载</button>
    </div>
  </div>`
  document.body.appendChild(overlay)
  const progressEl = overlay.querySelector('#mu-progress')
  const progressText = overlay.querySelector('#mu-progress-text')
  const progressTime = overlay.querySelector('#mu-progress-time')
  const stateEl = overlay.querySelector('#mu-state')
  const confirmButton = overlay.querySelector('[data-my-uninstall-confirm]')
  const cancelButton = overlay.querySelector('[data-my-uninstall-cancel]')
  const closeButton = overlay.querySelector('.modal-x')
  let progressTimer = null
  let progressStartedAt = 0
  let busy = false

  const stopProgressClock = () => {
    if (progressTimer) clearInterval(progressTimer)
    progressTimer = null
  }
  const setBusy = (next) => {
    busy = next
    confirmButton.disabled = next
    cancelButton.disabled = next
    closeButton.disabled = next
    confirmButton.textContent = next ? '卸载中…' : '卸载'
  }
  const startProgress = (text) => {
    stopProgressClock()
    progressStartedAt = Date.now()
    progressEl.hidden = false
    progressEl.classList.remove('is-done')
    progressText.textContent = text
    progressTime.textContent = '0s'
    stateEl.className = 'modal-state'
    stateEl.textContent = ''
    setBusy(true)
    progressTimer = setInterval(() => {
      const seconds = Math.max(0, Math.floor((Date.now() - progressStartedAt) / 1000))
      progressTime.textContent = `${seconds}s`
    }, 500)
  }
  const completeProgress = (text) => {
    stopProgressClock()
    progressEl.hidden = false
    progressEl.classList.add('is-done')
    progressText.textContent = text
    progressTime.textContent = '完成'
  }
  const failProgress = () => {
    stopProgressClock()
    progressEl.hidden = true
    setBusy(false)
  }
  const close = (force = false) => {
    if (busy && !force) return
    stopProgressClock()
    overlay.remove()
  }
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay || event.target.closest('[data-my-uninstall-cancel]') || event.target.closest('.modal-x')) close()
  })
  confirmButton.addEventListener('click', async () => {
    if (busy) return
    startProgress('正在解除你的个人安装…')
    try {
      await api(`/api/my/plugins/${encodeURIComponent(plugin.id)}/uninstall${qs()}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      completeProgress('卸载完成，正在刷新个人工作台…')
      try {
        await loadMyPlugins()
      } catch {
        // 卸载已经成功；列表刷新失败不改变结果，也不阻止自动关闭。
      }
      await new Promise((resolve) => setTimeout(resolve, 900))
      busy = false
      close(true)
      banner('已卸载个人插件', 'ok')
    } catch (err) {
      failProgress()
      stateEl.className = 'modal-state bad'
      stateEl.textContent = `${err.message}${err.code ? `（${err.code}）` : ''}`
      banner(`卸载失败：${err.message}`, 'bad')
    }
  })
}

function bindMyPluginWorkspace() {
  for (const button of document.querySelectorAll('[data-my-plugin-select]')) {
    button.onclick = () => {
      state.pluginSelected = button.dataset.myPluginSelect
      state.pluginTab = 'overview'
      state.pluginPageKey = null
      renderMyPluginWorkspace()
    }
  }
  for (const button of document.querySelectorAll('[data-my-plugin-tab]')) {
    button.onclick = () => {
      state.pluginTab = button.dataset.myPluginTab
      if (state.pluginTab === 'pages' && !state.pluginPageKey) {
        const plugin = state.plugins.find((item) => item.id === state.pluginSelected)
        state.pluginPageKey = plugin?.pages?.[0]?.file ?? null
      }
      renderMyPluginWorkspace()
    }
  }
  for (const button of document.querySelectorAll('[data-my-plugin-page]')) {
    button.onclick = () => {
      state.pluginTab = 'pages'
      state.pluginPageKey = button.dataset.myPluginPage
      renderMyPluginWorkspace()
    }
  }
  for (const button of document.querySelectorAll('[data-my-plugin-page-first]')) {
    button.onclick = () => {
      const plugin = state.plugins.find((item) => item.id === state.pluginSelected)
      state.pluginTab = 'pages'
      state.pluginPageKey = plugin?.pages?.[0]?.file ?? null
      renderMyPluginWorkspace()
    }
  }
  for (const button of document.querySelectorAll('[data-my-plugin-toggle]')) {
    button.onclick = async () => {
      const enabled = button.dataset.nextEnabled === '1'
      button.disabled = true
      try {
        await api(`/api/my/plugins/${encodeURIComponent(state.pluginSelected)}/state${qs()}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled }),
        })
        await loadMyPlugins()
        banner(enabled ? '已启用个人插件' : '已停用个人插件', 'ok')
      } catch (err) {
        button.disabled = false
        banner(`启停失败：${err.message}`, 'bad')
      }
    }
  }
  for (const button of document.querySelectorAll('[data-my-plugin-host-refresh]')) {
    button.onclick = async () => {
      button.disabled = true
      try {
        const data = await api(`/api/my/plugins/${encodeURIComponent(state.pluginSelected)}/host${qs()}`)
        const plugin = state.plugins.find((item) => item.id === state.pluginSelected)
        if (plugin) plugin.host = data.status
        renderMyPluginWorkspace()
      } catch (err) {
        button.disabled = false
        banner(`刷新宿主状态失败：${err.message}`, 'bad')
      }
    }
  }
  for (const button of document.querySelectorAll('[data-my-plugin-install]')) {
    button.onclick = showPluginInstall
  }
  for (const button of document.querySelectorAll('[data-my-plugin-refresh]')) {
    button.onclick = () => loadMyPlugins()
  }
  for (const button of document.querySelectorAll('[data-my-plugin-uninstall]')) {
    button.onclick = () => {
      const plugin = state.plugins.find((item) => item.id === state.pluginSelected)
      if (plugin) openMyPluginUninstall(plugin)
    }
  }
}

/* ---------------- 工作台：个人技能 ---------------- */

const SKILL_LEVEL_LABEL = {
  L0: 'L0 纯提示词',
  L1: 'L1 只读工具',
  L2: 'L2 写入工具',
  L3: 'L3 页面 / 后台',
}

const SKILL_RISK_LABEL = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
  critical: '严重风险',
}

function mySkillRiskTone(risk) {
  if (risk === 'low') return 'ok'
  if (risk === 'medium') return 'warn'
  return 'danger'
}

function mySkillStatus(skill) {
  if (!skill.valid) return { label: '已拦截', tone: 'danger' }
  if (!skill.enabled) return { label: '已停用', tone: 'warn' }
  if (skill.risk === 'medium') return { label: '已启用 · 中风险', tone: 'warn' }
  return { label: '已启用', tone: 'ok' }
}

function mySkillCan(action) {
  return state.skillData?.permissions?.[action] === true
}

function mySkillLockedNote(action) {
  const labels = { install: '安装个人技能', configure: '启停个人技能', uninstall: '卸载个人技能' }
  return `<div class="plugin-note plugin-permission-note">当前账号的角色没有「${labels[action] || action}」权限，操作已锁定；请联系管理员在控制台「角色管理」里授权。</div>`
}

function mySkillStatusPill(skill) {
  const status = mySkillStatus(skill)
  return `<span class="pill ${status.tone}">${esc(status.label)}</span>`
}

function mySkillRailItem(skill) {
  const status = mySkillStatus(skill)
  const active = skill.id === state.skillSelected
  return `<button class="plugin-rail-item ${active ? 'is-active' : ''} ${skill.enabled && skill.valid ? '' : 'is-muted'}" type="button" data-motion="lift" data-my-skill-select="${esc(skill.id)}">
    <span class="plugin-rail-avatar ${skill.enabled && skill.valid ? '' : 'ghost'}">${esc((skill.name || skill.id).slice(0, 1).toUpperCase())}</span>
    <span class="plugin-rail-text">
      <strong>${esc(skill.name || skill.id)}</strong>
      <small>${esc(skill.level || 'L0')} · v${esc(skill.version || '—')} · ${esc(status.label)}</small>
    </span>
    <span class="plugin-rail-dot ${status.tone === 'ok' ? 'ok' : status.tone === 'warn' ? 'warn' : 'bad'}" aria-hidden="true"></span>
  </button>`
}

function mySkillRailHtml(data) {
  const skills = data.skills || state.skills || []
  const stats = data.stats || { installed: skills.length, enabled: 0, valid: 0, blocked: 0 }
  const who = state.me?.person?.name || '个人空间'
  return `<div class="plugin-rail-top">
      <div class="plugin-scope-block">
        <span class="plugin-scope-eyebrow">个人技能</span>
        <strong>${esc(who)}</strong>
        <small>只显示你自己安装的技能</small>
      </div>
      <div class="plugin-rail-metrics">
        <div><strong>${stats.installed}</strong><span>已装</span></div>
        <div><strong>${stats.enabled}</strong><span>启用</span></div>
        <div><strong>${stats.blocked || 0}</strong><span>拦截</span></div>
      </div>
      <div class="plugin-rail-actions">
        <button class="btn primary sm" type="button" data-my-skill-install ${mySkillCan('install') ? '' : 'disabled title="当前角色没有安装个人技能权限"'}>＋ 安装技能</button>
        <button class="btn ghost sm" type="button" data-my-skill-refresh>刷新</button>
      </div>
    </div>
    <div class="plugin-rail-head">已安装 <span class="muted">${skills.length}</span><span class="plugin-rail-head-hint" title="点击卡片切换下方详情" aria-label="点击卡片切换下方详情"><svg aria-hidden="true" width="10" height="10" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.2" stroke="currentColor" stroke-width="1.2"/><path d="M8 7.4v3.6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="8" cy="4.6" r=".9" fill="currentColor"/></svg></span></div>
    <div class="plugin-rail-list">
      ${skills.length ? skills.map(mySkillRailItem).join('') : '<div class="plugin-empty">还没有个人技能</div>'}
    </div>`
}

function mySkillFindingsHtml(skill) {
  const findings = skill.findings || []
  if (!findings.length) {
    return `<div class="plugin-note">安装扫描、启用检查和文件指纹校验均通过；技能只注入业务说明，不执行脚本。</div>`
  }
  return `<div class="ws-tool-list">
    ${findings
      .slice(0, 12)
      .map(
        (finding) => `<article class="ws-tool-row">
          <div class="ws-tool-main">
            <div class="ws-tool-head"><code>${esc(finding.code)}</code><span class="pill ${finding.severity === 'critical' || finding.severity === 'high' ? 'danger' : 'warn'}">${esc(finding.category || finding.severity)}</span></div>
            <p>${esc(finding.message)}</p>
            <div class="ws-tool-params"><span class="chip">${esc(finding.file)}:${esc(finding.line)}</span>${finding.excerpt ? `<span class="chip">${esc(finding.excerpt.slice(0, 80))}</span>` : ''}</div>
          </div>
        </article>`,
      )
      .join('')}
  </div>`
}

function mySkillDetailHtml(data, skill) {
  const status = mySkillStatus(skill)
  const scopes = skill.scopes || []
  const tools = skill.tools || []
  const triggers = skill.triggers || []
  const references = skill.references || []
  const install = skill.install || {}
  const instructionPreview = String(skill.instructionPreview || '').trim()
  const blocked = !skill.valid
  return `<section class="panel plugin-detail">
    <div class="plugin-detail-head">
      <div class="plugin-title">
        <span class="plugin-avatar">${esc((skill.name || skill.id).slice(0, 1).toUpperCase())}</span>
        <div class="plugin-title-text">
          <div class="plugin-title-row"><h2>${esc(skill.name || skill.id)}</h2><span class="plugin-format-badge">SKILL</span><span class="pill ${mySkillRiskTone(skill.risk)}">${esc(SKILL_RISK_LABEL[skill.risk] || skill.risk)}</span>${mySkillStatusPill(skill)}</div>
          <div class="plugin-subline"><span>v${esc(skill.version || '—')}</span><span>${esc(skill.author || '未知作者')}</span><span>${esc(SKILL_LEVEL_LABEL[skill.level] || skill.level)}</span></div>
        </div>
      </div>
      <div class="plugin-detail-actions">
        <button class="btn ghost sm" type="button" data-my-skill-toggle data-next-enabled="${skill.enabled ? '0' : '1'}" ${mySkillCan('configure') && !blocked ? '' : 'disabled title="当前角色没有启停个人技能权限"'}>${skill.enabled ? '停用' : '启用'}</button>
        <button class="btn ghost sm danger-text" type="button" data-my-skill-uninstall ${mySkillCan('uninstall') ? '' : 'disabled title="当前角色没有卸载个人技能权限"'}>卸载…</button>
      </div>
    </div>
    <div class="plugin-block">
      <h3>技能概况</h3>
      <div class="plugin-kv">
        <div><span>技能 ID</span><strong class="mono">${esc(skill.id)}</strong></div>
        <div><span>能力等级</span><strong>${esc(SKILL_LEVEL_LABEL[skill.level] || skill.level)}</strong></div>
        <div><span>声明权限</span><strong>${esc(scopes.join('、') || '无')}</strong></div>
        <div><span>触发词</span><strong>${esc(triggers.join('、') || '无')}</strong></div>
        <div><span>声明工具</span><strong>${esc(tools.join('、') || '无')}</strong></div>
        <div><span>安装范围</span><strong>个人安装（只影响我）</strong></div>
        <div><span>安装方式</span><strong>${esc(install.source === 'browser-dir' ? '本机文件夹' : install.source || '个人安装')}</strong></div>
        <div><span>安装时间</span><strong>${esc(workspaceFileDate(install.installedAt))}</strong></div>
        <div><span>最近更新</span><strong>${esc(workspaceFileDate(install.updatedAt))}</strong></div>
        <div><span>校验和</span><span class="mono">${esc(skill.checksum || '—')}</span></div>
      </div>
      <div class="plugin-note">${esc(skill.description || '没有技能说明')}</div>
    </div>
    ${
      instructionPreview
        ? `<div class="plugin-block">
      <h3>技能说明 <span class="muted my-skill-doc-count">${esc(formatCount(Number(skill.instructionChars) || instructionPreview.length))} 字符</span></h3>
      <pre class="my-skill-doc">${esc(instructionPreview)}</pre>
      <div class="plugin-note">这是安装后的实际 SKILL.md 内容；改完文件再 install，刷新或稍等即可看到新版本。</div>
    </div>`
        : ''
    }
    <div class="plugin-block">
      <h3>安全与隔离</h3>
      ${blocked ? `<div class="plugin-page-blocked"><strong>技能已被拦截</strong><span>${esc(skill.error || '技能包没有通过安全扫描')}。检查 .quarantine 中的记录，修复后重新安装。</span></div>` : ''}
      <div class="plugin-kv">
        <div><span>风险结论</span><strong>${esc(SKILL_RISK_LABEL[skill.risk] || skill.risk)}</span></div>
        <div><span>checksum</span><span class="mono">${esc(skill.checksum || '—')}</span></div>
        <div><span>加载状态</span><strong>${skill.valid ? '扫描通过' : '拒绝加载'}</strong></div>
        <div><span>可执行脚本</span><strong>第一版禁止</strong></div>
      </div>
      ${mySkillFindingsHtml(skill)}
    </div>
    <div class="plugin-block">
      <h3>引用文件</h3>
      <div class="plugin-page-list"><span>references/assets</span><div>${references.length ? references.map((file) => `<span class="chip">${esc(file)}</span>`).join('') : '<span class="muted">没有引用或素材文件</span>'}</div></div>
    </div>
    <div class="plugin-block">
      <h3>运行状态</h3>
      <div class="plugin-kv">
        <div><span>启用状态</span><strong>${esc(status.label)}</strong></div>
        <div><span>对话注入</span><strong>${skill.valid && skill.enabled ? '已注入业务说明' : '未注入'}</strong></div>
        <div><span>工具调用</span><strong>仍受 agent:tool:invoke 与工具白名单约束</strong></div>
      </div>
      <div class="plugin-danger-zone">
        <div><strong>卸载个人技能</strong><span>只解除你自己的安装，不删除技能目录、审计和隔离记录。</span></div>
        <button class="btn ghost sm danger-text" type="button" data-my-skill-uninstall ${mySkillCan('uninstall') ? '' : 'disabled title="当前角色没有卸载个人技能权限"'}>卸载…</button>
      </div>
    </div>
  </section>`
}

function mySkillWelcomeHtml(data) {
  const skills = data.skills || []
  const stats = data.stats || { installed: 0, enabled: 0, valid: 0, blocked: 0 }
  const empty = skills.length === 0
  return `<div class="plugin-welcome">
    <div class="plugin-welcome-mark">S</div>
    <h2>${empty ? '还没有个人技能' : '从左侧选择一个技能'}</h2>
    <p>${empty ? '技能包由 skill.json 和 SKILL.md 组成；安装前会先扫描破坏命令、越权指令、凭证读取和外发行为，高风险包直接拦截。' : '左侧列出的是你本人安装的技能，点一个可以查看风险结论、引用文件、启停和卸载。'}</p>
    <div class="plugin-welcome-stats">
      <div><strong>${stats.installed}</strong><span>已安装</span></div>
      <div><strong>${stats.enabled}</strong><span>已启用</span></div>
      <div><strong>${stats.blocked || 0}</strong><span>被拦截</span></div>
    </div>
    <div class="plugin-welcome-actions">
      <button class="btn primary" type="button" data-my-skill-install ${mySkillCan('install') ? '' : 'disabled title="当前角色没有安装个人技能权限"'}>安装个人技能</button>
      <button class="btn ghost" type="button" data-my-skill-refresh>刷新</button>
    </div>
    ${mySkillCan('install') ? '' : mySkillLockedNote('install')}
  </div>`
}

function renderMySkillWorkspace() {
  const rail = $('#my-plugin-rail')
  const detail = $('#my-plugin-detail')
  if (!rail || !detail) return
  const data = state.skillData || { skills: state.skills, stats: null }
  rail.innerHTML = mySkillRailHtml(data)
  const skill = (data.skills || []).find((item) => item.id === state.skillSelected)
  detail.innerHTML = skill ? mySkillDetailHtml(data, skill) : mySkillWelcomeHtml(data)
  bindMySkillWorkspace()
  decorateWorkspaceMotion()
}

function mySkillSignature(data) {
  return JSON.stringify((data?.skills || []).map((item) => [item.id, item.checksum, item.enabled, item.valid]))
}

let mySkillWatchTimer = 0

/** 技能工作台只读轮询：Agent 热安装后，已打开的详情页自动刷新校验和与 SKILL.md。 */
function scheduleMySkillWatch() {
  window.clearTimeout(mySkillWatchTimer)
  if (state.mode !== 'workspace' || state.workspaceKind !== 'skills') return
  mySkillWatchTimer = window.setTimeout(async () => {
    if (state.mode !== 'workspace' || state.workspaceKind !== 'skills') return
    try {
      const next = await api(`/api/my/skills${qs()}`)
      if (mySkillSignature(next) !== mySkillSignature(state.skillData)) {
        state.skillData = next
        state.skills = Array.isArray(next.skills) ? next.skills : []
        if (!state.skillSelected || !state.skills.some((item) => item.id === state.skillSelected)) {
          state.skillSelected = state.skills[0]?.id ?? null
        }
        renderMySkillWorkspace()
      }
    } catch {
      /* 轮询失败不覆盖当前详情；下一轮继续 */
    }
    scheduleMySkillWatch()
  }, 5_000)
}

async function loadMySkills() {
  const rail = $('#my-plugin-rail')
  const detail = $('#my-plugin-detail')
  if (!rail || !detail) return
  rail.innerHTML = '<div class="plugin-empty muted">正在读取技能…</div>'
  detail.innerHTML = '<div class="plugin-empty muted">正在读取技能…</div>'
  try {
    const data = await api(`/api/my/skills${qs()}`)
    state.skillData = data
    state.skills = Array.isArray(data.skills) ? data.skills : []
    if (!state.skillSelected || !state.skills.some((item) => item.id === state.skillSelected)) {
      state.skillSelected = state.skills[0]?.id ?? null
    }
    renderMySkillWorkspace()
    scheduleMySkillWatch()
  } catch (err) {
    rail.innerHTML = `<div class="plugin-empty bad">读取技能失败：${esc(err.message)}</div>`
    detail.innerHTML = `<div class="plugin-empty bad">读取技能失败：${esc(err.message)}</div>`
  }
}

function openMySkillUninstall(skill) {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `<div class="modal plugin-install-modal">
    <div class="modal-head">
      <div><h3>卸载「${esc(skill.name || skill.id)}」</h3><span class="muted">只解除你自己的个人安装</span></div>
      <button class="modal-x" type="button">×</button>
    </div>
    <div class="plugin-danger-zone" style="margin-top:4px">
      <div><strong>确认从个人工作台卸载？</strong><span>技能目录、审计记录和隔离记录都会保留；之后可以重新安装。</span></div>
    </div>
    <div class="modal-actions">
      <button class="btn ghost" type="button" data-my-skill-uninstall-cancel>取消</button>
      <button class="btn danger" type="button" data-my-skill-uninstall-confirm>卸载</button>
    </div>
  </div>`
  document.body.appendChild(overlay)
  const close = () => overlay.remove()
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay || event.target.closest('[data-my-skill-uninstall-cancel]') || event.target.closest('.modal-x')) close()
  })
  overlay.querySelector('[data-my-skill-uninstall-confirm]').addEventListener('click', async (event) => {
    const button = event.currentTarget
    button.disabled = true
    try {
      await api(`/api/my/skills/${encodeURIComponent(skill.id)}${qs()}`, { method: 'DELETE' })
      close()
      state.skillSelected = null
      await loadMySkills()
      banner('已卸载个人技能', 'ok')
    } catch (err) {
      button.disabled = false
      banner(`卸载失败：${err.message}`, 'bad')
    }
  })
}

function showSkillInstall() {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `<div class="modal plugin-install-modal">
    <div class="modal-head install-modal-head">
      <div><span class="install-eyebrow">PERSONAL SKILL INSTALLER</span><h3>安装个人技能</h3><span class="muted">只影响你自己</span></div>
      <button class="modal-x" type="button">×</button>
    </div>
    <div class="install-source-tabs" role="tablist" aria-label="个人技能安装来源">
      <button class="install-source-tab is-active" type="button" data-si-source="browser-dir">
        <span class="install-source-icon">⌂</span><span><strong>本机文件夹</strong><small>选择已有技能包</small></span>
      </button>
      <button class="install-source-tab" type="button" data-si-source="git">
        <span class="install-source-icon">◐</span><span><strong>GitHub 仓库</strong><small>仓库 + 分支 / 子目录</small></span>
      </button>
      <button class="install-source-tab" type="button" data-si-source="http">
        <span class="install-source-icon">⇣</span><span><strong>压缩包 URL</strong><small>tar.gz / zip 直链</small></span>
      </button>
    </div>
    <div class="install-panel" data-si-panel="browser-dir">
      <input id="si-folder-input" type="file" webkitdirectory directory multiple hidden />
      <div class="plugin-install-actions">
        <button class="btn ghost" type="button" id="si-pick-folder">选择技能文件夹…</button>
        <span class="muted" id="si-folder-name">未选择</span>
      </div>
    </div>
    <div class="install-panel is-hidden" data-si-panel="git">
      <div class="install-grid">
        <label class="install-field install-span-2"><span class="install-label">GitHub 仓库</span>
          <input id="si-git-repo" placeholder="owner/repo，例如 Jydsh/eab-skills" autocomplete="off" />
        </label>
        <label class="install-field"><span class="install-label">分支 / 标签</span>
          <input id="si-git-ref" placeholder="留空 = 默认分支" autocomplete="off" />
        </label>
        <label class="install-field"><span class="install-label">仓库内子目录</span>
          <input id="si-git-subdir" placeholder="可选，例如 skills/fixed-field-edit" autocomplete="off" />
        </label>
      </div>
    </div>
    <div class="install-panel is-hidden" data-si-panel="http">
      <label class="install-field"><span class="install-label">技能压缩包 URL</span>
        <input id="si-http-url" placeholder="https://example.com/skills/fixed-field-edit.tar.gz" autocomplete="off" />
      </label>
    </div>
    <div class="install-options">
      <label class="install-check">
        <input type="checkbox" id="si-overwrite" />
        <span><strong>覆盖同名技能</strong><small>已安装同一技能 id 时替换为新包；不勾选会提示冲突。</small></span>
      </label>
    </div>
    <div class="install-flow">
      <span id="si-flow-first">① 读取文件夹</span><i>→</i><span>② 静态安全扫描</span><i>→</i><span>③ 安装到个人</span>
      <div class="install-note" id="si-note"></div>
    </div>
    <div class="install-progress" id="si-progress" hidden aria-live="polite">
      <div class="install-progress-track"><span class="install-progress-bar"></span></div>
      <div class="install-progress-meta"><span id="si-progress-text">正在安装…</span><span id="si-progress-time" class="mono">0s</span></div>
    </div>
    <div class="modal-state" id="si-state"></div>
    <div class="modal-actions">
      <button class="btn ghost" type="button" data-si-cancel>取消</button>
      <button class="btn primary" type="button" id="si-submit" disabled>安装技能</button>
    </div>
  </div>`
  document.body.appendChild(overlay)
  const close = () => {
    if (progressTimer) clearInterval(progressTimer)
    overlay.remove()
  }
  const stateEl = overlay.querySelector('#si-state')
  const submit = overlay.querySelector('#si-submit')
  const nameEl = overlay.querySelector('#si-folder-name')
  const noteEl = overlay.querySelector('#si-note')
  const flowFirst = overlay.querySelector('#si-flow-first')
  const progressEl = overlay.querySelector('#si-progress')
  const progressText = overlay.querySelector('#si-progress-text')
  const progressTime = overlay.querySelector('#si-progress-time')
  const tabs = Array.from(overlay.querySelectorAll('[data-si-source]'))
  const panels = Array.from(overlay.querySelectorAll('[data-si-panel]'))
  let entries = []
  let source = 'browser-dir'
  let progressTimer = null
  let progressStartedAt = 0

  const sourceNotes = {
    'browser-dir': {
      label: '本机副本',
      tip: '本机文件夹：浏览器只上传文件副本，服务端落到临时目录扫描；安装后立即删除临时目录。',
    },
    git: {
      label: '只取内容',
      tip: 'GitHub：下载仓库 tarball 后解包；仓库里必须有 skill.json 和 SKILL.md。只取内容，不执行仓库脚本。',
    },
    http: {
      label: '仅 HTTPS',
      tip: '压缩包 URL：只支持 tar.gz / zip；解包后照常静态扫描。默认只允许公网 https。',
    },
  }
  const setInstalling = (busy) => {
    for (const control of overlay.querySelectorAll('.install-source-tab, .install-field input, .install-check input, #si-pick-folder')) control.disabled = busy
  }
  const stopProgressClock = () => {
    if (progressTimer) clearInterval(progressTimer)
    progressTimer = null
  }
  const startProgress = (text) => {
    stopProgressClock()
    progressStartedAt = Date.now()
    progressEl.hidden = false
    progressEl.classList.remove('is-done')
    progressText.textContent = text
    progressTime.textContent = '0s'
    stateEl.className = 'modal-state'
    stateEl.textContent = ''
    setInstalling(true)
    progressTimer = setInterval(() => {
      const seconds = Math.max(0, Math.floor((Date.now() - progressStartedAt) / 1000))
      progressTime.textContent = `${seconds}s`
    }, 500)
  }
  const failProgress = () => {
    stopProgressClock()
    progressEl.hidden = true
    setInstalling(false)
  }
  const syncSubmit = () => {
    submit.disabled = source === 'browser-dir' && entries.length === 0
  }
  const syncSource = (next) => {
    source = next
    for (const tab of tabs) {
      const active = tab.dataset.siSource === next
      tab.classList.toggle('is-active', active)
      tab.setAttribute('aria-selected', active ? 'true' : 'false')
    }
    for (const panel of panels) panel.classList.toggle('is-hidden', panel.dataset.siPanel !== next)
    const note = sourceNotes[next] || { label: '来源说明', tip: '' }
    noteEl.innerHTML = `<span class="install-tab-badge hint-badge" data-tip="${esc(note.tip)}" tabindex="0" aria-label="安装来源说明">${esc(note.label)}</span>`
    flowFirst.textContent = next === 'browser-dir' ? '① 读取文件夹' : '① 下载并解包'
    stateEl.className = 'modal-state'
    stateEl.textContent = ''
    syncSubmit()
  }
  const apply = (list, label) => {
    entries = list
    nameEl.textContent = `${label} · ${list.length} 个文件`
    stateEl.className = 'modal-state ok'
    stateEl.textContent = list.length ? '已选择，点「安装技能」上传并扫描' : ''
    syncSubmit()
  }
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay || event.target.closest('[data-si-cancel]') || event.target.closest('.modal-x')) close()
  })
  for (const tab of tabs) tab.addEventListener('click', () => syncSource(tab.dataset.siSource))
  const pick = overlay.querySelector('#si-pick-folder')
  const input = overlay.querySelector('#si-folder-input')
  pick.addEventListener('click', async () => {
    if (typeof window.showDirectoryPicker === 'function') {
      try {
        const dir = await window.showDirectoryPicker({ id: 'eab-skill-folder', mode: 'read' })
        apply(await collectDirectoryEntries(dir, `${dir.name}/`, []), dir.name)
      } catch (err) {
        if (err && err.name === 'AbortError') return
        stateEl.className = 'modal-state bad'
        stateEl.textContent = `读取文件夹失败：${err?.message || err}`
      }
      return
    }
    input.value = ''
    input.click()
  })
  input.addEventListener('change', () => {
    const files = Array.from(input.files || [])
    apply(files.map((file) => ({ rel: String(file.webkitRelativePath || file.name), file })), files[0]?.webkitRelativePath?.split('/')[0] || '技能文件夹')
  })
  syncSource(source)
  bindHintTips(overlay)

  submit.addEventListener('click', async () => {
    const body = {
      source,
      overwrite: overlay.querySelector('#si-overwrite').checked,
    }
    if (source === 'git') {
      body.repo = overlay.querySelector('#si-git-repo').value.trim()
      body.ref = overlay.querySelector('#si-git-ref').value.trim()
      body.subdir = overlay.querySelector('#si-git-subdir').value.trim()
      if (!body.repo) {
        stateEl.className = 'modal-state bad'
        stateEl.textContent = '请填 GitHub 仓库（owner/repo）'
        return
      }
    } else if (source === 'http') {
      body.url = overlay.querySelector('#si-http-url').value.trim()
      if (!body.url) {
        stateEl.className = 'modal-state bad'
        stateEl.textContent = '请填写技能压缩包 URL'
        return
      }
    } else {
      if (!entries.length) {
        stateEl.className = 'modal-state bad'
        stateEl.textContent = '请选择技能文件夹'
        return
      }
      stateEl.className = 'modal-state'
      stateEl.textContent = '正在读取文件夹…'
      body.files = await readPluginFolderFiles(entries)
    }
    startProgress(source === 'git'
      ? '正在从 GitHub 下载仓库 tarball 并解包…'
      : source === 'http'
        ? '正在下载技能压缩包并解包…'
        : '正在上传并扫描技能包…')
    submit.textContent = '安装中…'
    try {
      await api(`/api/my/skills/install${qs()}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      stopProgressClock()
      progressEl.classList.add('is-done')
      progressText.textContent = '安装完成，正在刷新技能列表…'
      progressTime.textContent = '完成'
      try {
        await loadMySkills()
      } catch {
        // 安装已成功；刷新失败不改变结果。
      }
      await new Promise((resolve) => setTimeout(resolve, 700))
      close()
      state.skillSelected = null
      banner('已安装个人技能', 'ok')
    } catch (err) {
      failProgress()
      submit.disabled = false
      submit.textContent = '安装技能'
      if (err?.details?.approvalId || err?.code === 'EAB_APPROVAL_REQUIRED') {
        stateEl.className = 'modal-state'
        stateEl.textContent = `已提交安装审批：${err.message || '等待管理员通过'}`
      } else {
        stateEl.className = 'modal-state bad'
        stateEl.textContent = `安装失败：${err.message}`
      }
    }
  })
}

function bindMySkillWorkspace() {
  for (const button of document.querySelectorAll('[data-my-skill-select]')) {
    button.onclick = () => {
      state.skillSelected = button.dataset.mySkillSelect
      renderMySkillWorkspace()
    }
  }
  for (const button of document.querySelectorAll('[data-my-skill-toggle]')) {
    button.onclick = async () => {
      const enabled = button.dataset.nextEnabled === '1'
      button.disabled = true
      try {
        await api(`/api/my/skills/${encodeURIComponent(state.skillSelected)}/state${qs()}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled }),
        })
        await loadMySkills()
        banner(enabled ? '已启用技能' : '已停用技能', 'ok')
      } catch (err) {
        button.disabled = false
        banner(`启停失败：${err.message}`, 'bad')
      }
    }
  }
  for (const button of document.querySelectorAll('[data-my-skill-install]')) button.onclick = showSkillInstall
  for (const button of document.querySelectorAll('[data-my-skill-refresh]')) button.onclick = () => loadMySkills()
  for (const button of document.querySelectorAll('[data-my-skill-uninstall]')) {
    button.onclick = () => {
      const skill = state.skills.find((item) => item.id === state.skillSelected)
      if (skill) openMySkillUninstall(skill)
    }
  }
}

function setWorkspaceKind(kind) {
  const next = kind === 'skills' ? 'skills' : 'plugins'
  if (state.workspaceKind === next) return
  state.workspaceKind = next
  for (const button of document.querySelectorAll('#workspace-kind-switch [data-workspace-kind]')) {
    const active = button.dataset.workspaceKind === next
    button.classList.toggle('is-active', active)
    button.setAttribute('aria-selected', active ? 'true' : 'false')
  }
  const eyebrow = $('#workspace-eyebrow')
  const title = $('#workspace-title')
  const badge = $('#workspace-scope-badge')
  if (eyebrow) eyebrow.textContent = next === 'skills' ? 'PERSONAL SKILL WORKSPACE' : 'PERSONAL PLUGIN WORKSPACE'
  if (title) title.textContent = next === 'skills' ? '技能工作台' : '我的工作台'
  if (badge) {
    badge.textContent = next === 'skills' ? '仅本人技能' : '仅本人可见'
    badge.dataset.tip =
      next === 'skills'
        ? '只显示你自己安装的技能。安装、启停、卸载和风险详情都只影响你本人；高风险包会被拦截并写入隔离记录。'
        : '只显示你自己安装的插件。启停、卸载、查看详情和打开插件页面都只影响你本人，不会碰公司和别人的安装。'
  }
  if (state.mode === 'workspace') {
    if (next === 'skills') loadMySkills()
    else loadMyPlugins()
  }
}

function bindWorkspaceKindSwitch() {
  for (const button of document.querySelectorAll('#workspace-kind-switch [data-workspace-kind]')) {
    button.onclick = () => setWorkspaceKind(button.dataset.workspaceKind)
  }
}

/** 技能工具卡的 previewPath 用 ?workspace=skills&skill=<id> 直达技能工作台详情。 */
function applyWorkspaceDeepLink() {
  const params = new URLSearchParams(location.search)
  if (params.get('workspace') !== 'skills') return false
  const skillId = String(params.get('skill') || '').trim()
  const settingsStage = $('#settings-stage')
  if (settingsStage && !settingsStage.hidden) hideSettings()
  state.skillSelected = skillId || null
  setWorkspaceKind('skills')
  setChatMode('workspace')
  return true
}

function ensureHintTip() {
  let tip = document.getElementById('hint-tip')
  if (tip) return tip
  tip = document.createElement('div')
  tip.className = 'hint-tip'
  tip.id = 'hint-tip'
  tip.setAttribute('role', 'tooltip')
  document.body.appendChild(tip)
  return tip
}

function showHintTip(tip, target, text) {
  if (!text) return
  tip.textContent = text
  tip.style.left = '0px'
  tip.style.top = '0px'
  tip.classList.add('is-visible')
  const rect = target.getBoundingClientRect()
  const tipWidth = tip.offsetWidth
  const tipHeight = tip.offsetHeight
  let left = rect.left + rect.width / 2 - tipWidth / 2
  left = Math.max(8, Math.min(left, window.innerWidth - tipWidth - 8))
  let top = rect.bottom + 8
  if (top + tipHeight > window.innerHeight - 8) top = rect.top - tipHeight - 8
  tip.style.left = `${Math.round(left)}px`
  tip.style.top = `${Math.max(8, Math.round(top))}px`
}

function bindHintTips(root) {
  const targets = Array.from(root.querySelectorAll('[data-tip]'))
  if (!targets.length) return () => {}
  const tip = ensureHintTip()
  let current = null
  const hide = () => {
    if (current) current.removeAttribute('aria-describedby')
    current = null
    tip.classList.remove('is-visible')
  }
  const show = (target) => {
    const text = target.dataset.tip
    if (!text) return
    if (current && current !== target) current.removeAttribute('aria-describedby')
    current = target
    target.setAttribute('aria-describedby', 'hint-tip')
    showHintTip(tip, target, text)
  }
  for (const target of targets) {
    target.addEventListener('pointerenter', () => show(target))
    target.addEventListener('pointerleave', hide)
    target.addEventListener('focus', () => show(target))
    target.addEventListener('blur', hide)
  }
  return () => {
    hide()
  }
}

/**
 * 消息流是动态增删的，不能每来一条消息就重新绑一遍 [data-tip]。
 * 在 #thread 上做一次事件委托，气泡里的图标、思考/工具/记忆入口都能共用同一个提示层。
 */
function bindThreadHintTips() {
  const thread = document.getElementById('thread')
  if (!thread || thread.dataset.hintTipsBound === '1') return
  thread.dataset.hintTipsBound = '1'
  const tip = ensureHintTip()
  let current = null
  const hide = () => {
    if (current) current.removeAttribute('aria-describedby')
    current = null
    tip.classList.remove('is-visible')
  }
  const show = (target) => {
    const text = target?.dataset?.tip
    if (!text) return
    if (current && current !== target) current.removeAttribute('aria-describedby')
    current = target
    target.setAttribute('aria-describedby', 'hint-tip')
    showHintTip(tip, target, text)
  }
  const targetOf = (node) => {
    const element = node instanceof Element ? node : null
    const target = element?.closest('[data-tip]')
    return target && thread.contains(target) ? target : null
  }
  thread.addEventListener('pointermove', (event) => {
    const target = targetOf(event.target)
    if (target && target !== current) show(target)
  })
  thread.addEventListener('pointerover', (event) => {
    const target = targetOf(event.target)
    if (target && target !== current) show(target)
  })
  thread.addEventListener('pointerout', (event) => {
    if (!current) return
    if (event.relatedTarget instanceof Node && current.contains(event.relatedTarget)) return
    const next = targetOf(event.relatedTarget)
    if (next) {
      show(next)
      return
    }
    hide()
  })
  thread.addEventListener('focusin', (event) => {
    const target = targetOf(event.target)
    if (target) show(target)
  })
  thread.addEventListener('focusout', (event) => {
    if (!current) return
    if (event.relatedTarget instanceof Node && current.contains(event.relatedTarget)) return
    const next = targetOf(event.relatedTarget)
    if (next) show(next)
    else hide()
  })
  const reposition = () => {
    if (!current) return
    const rect = current.getBoundingClientRect()
    if (rect.bottom < 8 || rect.top > window.innerHeight - 8) {
      hide()
      return
    }
    showHintTip(tip, current, current.dataset.tip)
  }
  thread.addEventListener('scroll', reposition, { passive: true })
  window.addEventListener('resize', reposition)
  thread.addEventListener('pointerleave', hide)
}

/**
 * 原生 title 的提示要停一秒才出现，和页面自己的即时提示体验不一致。
 * 消息流里所有仍带 title 的节点（图表截断标签、工具明细、Artifact 等）统一提升成 data-tip，
 * 由 #thread 的事件委托即时显示；title 本身移除，避免原生黑框延迟后重复出现。
 */
function promoteThreadTitles(root = document.getElementById('thread')) {
  if (!root) return
  for (const node of root.querySelectorAll('[title]')) {
    const text = String(node.getAttribute('title') || '').trim()
    node.removeAttribute('title')
    if (!text || node.dataset.tip) continue
    node.dataset.tip = text
    if (!node.hasAttribute('aria-label') && node.matches('button, a, input, textarea, select, [role="button"]')) {
      node.setAttribute('aria-label', text)
    }
  }
  // 图表里的 <svg><title> 也会触发浏览器原生延迟提示；提升到父节点后删掉，
  // 让柱形、折线点、饼图扇区都走同一套即时提示。
  for (const titleNode of root.querySelectorAll('svg title')) {
    const text = String(titleNode.textContent || '').trim()
    const parent = titleNode.parentElement
    if (parent && text) {
      if (!parent.dataset.tip) parent.dataset.tip = text
      if (!parent.hasAttribute('aria-label')) parent.setAttribute('aria-label', text)
    }
    titleNode.remove()
  }
}

function watchThreadTitles() {
  const thread = document.getElementById('thread')
  if (!thread || thread.dataset.hintTitlesBound === '1') return
  thread.dataset.hintTitlesBound = '1'
  promoteThreadTitles(thread)
  new MutationObserver(() => promoteThreadTitles(thread)).observe(thread, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['title'],
  })
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error(`读取文件失败：${file.name}`))
    reader.readAsDataURL(file)
  })
}

/** 目录选择器（showDirectoryPicker）用：递归收集文件，跳过依赖/版本库目录，避免把 node_modules 一起传上去 */
const PLUGIN_FOLDER_SKIP = new Set(['node_modules', '.git', '.svn', '.hg'])

async function collectDirectoryEntries(dirHandle, prefix, out, limit = 4000) {
  for await (const entry of dirHandle.values()) {
    if (out.length >= limit) throw new Error(`这个文件夹里文件超过 ${limit} 个，请确认选的是插件目录本身`)
    if (entry.kind === 'directory') {
      if (PLUGIN_FOLDER_SKIP.has(entry.name)) continue
      await collectDirectoryEntries(entry, `${prefix}${entry.name}/`, out, limit)
      continue
    }
    out.push({ rel: `${prefix}${entry.name}`, file: await entry.getFile() })
  }
  return out
}

async function readPluginFolderFiles(entries) {
  const out = []
  for (const { rel: rawRel, file } of entries) {
    const rel = String(rawRel || file.name).replace(/\\/g, '/')
    const parts = rel.split('/').filter(Boolean)
    const path = parts.length > 1 ? parts.slice(1).join('/') : rel
    const dataUrl = await readFileAsDataUrl(file)
    const comma = dataUrl.indexOf(',')
    if (comma < 0) throw new Error(`读取文件失败：${file.name}`)
    out.push({ path, data: dataUrl.slice(comma + 1) })
  }
  return out
}

function showPluginInstall() {
  const installedCount = state.plugins?.length || 0
  const who = state.me?.person?.name || '你'
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `<div class="modal plugin-install-modal personal-install-modal">
    <div class="modal-head install-modal-head">
      <div>
        <span class="install-eyebrow">PERSONAL PLUGIN</span>
        <div class="personal-install-title"><h3>安装个人插件</h3><span class="install-tab-badge hint-badge" data-tip="个人安装只记在你名下：同事看不到、不会被公司启用；卸载也只移除你这一份。" tabindex="0" aria-label="个人安装说明">仅自己可见</span></div>
        <p class="install-sub">装到「${esc(who)}」的个人工作台 · 已装 ${installedCount} 个</p>
      </div>
      <button class="modal-x" type="button" aria-label="关闭">×</button>
    </div>
    <div class="install-source-tabs" role="tablist" aria-label="安装来源">
      <button class="install-source-tab" type="button" data-install-source="browser-dir">
        <span class="install-source-icon"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M1.8 4.3a1.3 1.3 0 0 1 1.3-1.3h3.1l1.4 1.5h4.3a1.3 1.3 0 0 1 1.3 1.3v6.1a1.3 1.3 0 0 1-1.3 1.3H3.1a1.3 1.3 0 0 1-1.3-1.3V4.3Z" stroke="currentColor" stroke-width="1.1"/><path d="M2 6.2h12" stroke="currentColor" stroke-width="1.1"/></svg></span>
        <span><strong>本机文件夹 <em class="install-tab-badge">推荐</em></strong><small>浏览器上传</small></span>
      </button>
      <button class="install-source-tab" type="button" data-install-source="npm">
        <span class="install-source-icon"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2.2 4.2 8 1.8l5.8 2.4v7.6L8 14.2l-5.8-3V4.2Z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/><path d="M2.6 4.4 8 6.8l5.4-2.4M8 6.8v7" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg></span>
        <span><strong>npm 包 <em class="install-tab-badge">联网</em></strong><small>包名直装</small></span>
      </button>
      <button class="install-source-tab" type="button" data-install-source="github">
        <span class="install-source-icon"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="4.4" cy="3.4" r="1.7" stroke="currentColor" stroke-width="1.1"/><circle cx="11.6" cy="3.4" r="1.7" stroke="currentColor" stroke-width="1.1"/><circle cx="8" cy="12.8" r="1.7" stroke="currentColor" stroke-width="1.1"/><path d="M4.4 5.1v2.4c0 1.3 1.1 2.4 2.4 2.4h2.4c1.3 0 2.4-1.1 2.4-2.4V5.1" stroke="currentColor" stroke-width="1.1"/><path d="M8 9.9v1.2" stroke="currentColor" stroke-width="1.1"/></svg></span>
        <span><strong>GitHub <em class="install-tab-badge">联网</em></strong><small>公开仓库直装</small></span>
      </button>
    </div>
    <div class="install-panel" data-install-panel="browser-dir">
      <div class="install-section-head">
        <div class="install-section-title"><strong>从我的电脑选择插件文件夹</strong><span class="hint-badge icon-only" data-tip="选择包含 plugin.json 的文件夹。支持 EAB 插件（plugin.json）和 DSH 插件（package.json 带 dsh 段）；只上传文件夹里的文件副本，安装结束即删除临时目录；会自动跳过 node_modules、.git 等依赖目录。" tabindex="0" aria-label="插件文件夹说明"><svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.2" stroke="currentColor" stroke-width="1.1"/><path d="M8 7.4v3.4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/><circle cx="8" cy="4.9" r=".8" fill="currentColor"/></svg></span></div>
        <span class="pi-local-pill">浏览器上传</span>
      </div>
      <div class="pi-path-row">
        <input id="pi-folder-input" type="file" webkitdirectory directory multiple hidden />
        <button class="btn ghost pi-browse" type="button" id="pi-pick-folder">选择插件文件夹…</button>
      </div>
      <div class="pi-path-status" id="pi-path-status" hidden></div>
    </div>
    <div class="install-panel" data-install-panel="npm">
      <div class="install-grid">
        <label class="install-field install-span-2"><span class="install-field-label">npm 包名 <span class="hint-badge icon-only" data-tip="只取包内容，不执行 npm install、prepare 或任何生命周期脚本。默认安装 latest 版本。" tabindex="0" aria-label="npm 安装说明"><svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.2" stroke="currentColor" stroke-width="1.1"/><path d="M8 7.4v3.4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/><circle cx="8" cy="4.9" r=".8" fill="currentColor"/></svg></span></span>
          <input id="pi-npm-name" class="mono" placeholder="eab-plugin-oncall 或 @scope/eab-plugin-x" />
        </label>
      </div>
    </div>
    <div class="install-panel" data-install-panel="github">
      <div class="install-grid">
        <label class="install-field install-span-2"><span class="install-field-label">GitHub 仓库 <span class="hint-badge icon-only" data-tip="公开仓库可直接装；私有仓库暂不支持匿名下载。默认分支和仓库根目录会自动识别。" tabindex="0" aria-label="GitHub 安装说明"><svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.2" stroke="currentColor" stroke-width="1.1"/><path d="M8 7.4v3.4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/><circle cx="8" cy="4.9" r=".8" fill="currentColor"/></svg></span></span>
          <input id="pi-github-repo" class="mono" placeholder="owner/repo，例如 your-name/eab-plugin-oncall" />
        </label>
      </div>
    </div>
    <div class="install-meta-row">
      <label class="install-overwrite-inline">
        <input type="checkbox" id="pi-overwrite" />
        <span>覆盖同名插件 <em class="install-tab-badge warn hint-badge" data-tip="会替换插件库里的同名目录；已有配置不保证保留。" tabindex="0" aria-label="覆盖风险说明">谨慎</em></span>
      </label>
      <span class="install-tab-badge hint-badge" id="pi-note" data-tip="本机文件夹：浏览器选中你电脑上的插件文件夹，把文件副本上传给服务端校验后安装；适合自己开发和离线安装。" tabindex="0" aria-label="安装来源说明">来源说明</span>
      <span class="install-tab-badge hint-badge" data-tip="① 读取插件目录 → ② 校验清单 → ③ 写入插件库 → ④ 出现在个人工作台" tabindex="0" aria-label="安装流程说明">安装流程</span>
      <span class="install-tab-badge hint-badge" data-tip="安装后可在个人工作台启停或卸载。" tabindex="0" aria-label="安装归属说明">只装到你名下</span>
    </div>
    <div class="install-progress" id="pi-progress" hidden aria-live="polite">
      <div class="install-progress-track"><span class="install-progress-bar"></span></div>
      <div class="install-progress-meta">
        <span id="pi-progress-text">正在安装…</span>
        <span id="pi-progress-time" class="mono">0s</span>
      </div>
    </div>
    <div class="modal-state" id="pi-state"></div>
    <div class="modal-actions">
      <button class="btn primary" type="button" id="pi-submit">安装插件</button>
      <button class="btn ghost" type="button" id="pi-cancel">取消</button>
    </div>
  </div>`
  document.body.appendChild(overlay)
  const disposeHintTips = bindHintTips(overlay)
  let progressTimer = null
  const close = () => {
    if (progressTimer) clearInterval(progressTimer)
    progressTimer = null
    disposeHintTips()
    overlay.remove()
  }
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close()
  })
  overlay.querySelector('.modal-x').addEventListener('click', close)
  overlay.querySelector('#pi-cancel').addEventListener('click', close)

  const tabs = Array.from(overlay.querySelectorAll('[data-install-source]'))
  const panels = Array.from(overlay.querySelectorAll('[data-install-panel]'))
  const noteEl = overlay.querySelector('#pi-note')
  const stateEl = overlay.querySelector('#pi-state')
  const progressEl = overlay.querySelector('#pi-progress')
  const progressText = overlay.querySelector('#pi-progress-text')
  const progressTime = overlay.querySelector('#pi-progress-time')
  let progressStartedAt = 0
  const stopProgressClock = () => {
    if (progressTimer) clearInterval(progressTimer)
    progressTimer = null
  }
  const setInstalling = (busy) => {
    overlay.querySelector('.modal').classList.toggle('is-installing', busy)
    for (const control of overlay.querySelectorAll('.install-source-tab, .install-field input, .install-field select, .install-overwrite-inline input, #pi-pick-folder')) {
      control.disabled = busy
    }
  }
  const startProgress = (text) => {
    stopProgressClock()
    progressStartedAt = Date.now()
    progressEl.hidden = false
    progressEl.classList.remove('is-done')
    progressText.textContent = text
    progressTime.textContent = '0s'
    stateEl.className = 'modal-state'
    stateEl.textContent = ''
    setInstalling(true)
    progressTimer = setInterval(() => {
      const seconds = Math.max(0, Math.floor((Date.now() - progressStartedAt) / 1000))
      progressTime.textContent = `${seconds}s`
    }, 500)
  }
  const updateProgress = (text) => {
    progressText.textContent = text
  }
  const completeProgress = (text) => {
    stopProgressClock()
    progressEl.hidden = false
    progressEl.classList.add('is-done')
    progressText.textContent = text
    progressTime.textContent = '完成'
  }
  const failProgress = () => {
    stopProgressClock()
    progressEl.hidden = true
    setInstalling(false)
  }
  const folderInput = overlay.querySelector('#pi-folder-input')
  const pickFolder = overlay.querySelector('#pi-pick-folder')
  const pathStatus = overlay.querySelector('#pi-path-status')
  let selectedFolderEntries = []
  let selectedFolderName = ''
  let source = 'browser-dir'

  const sourceNotes = {
    'browser-dir': '本机文件夹：浏览器选中你电脑上的插件文件夹，把文件副本上传给服务端校验后安装；适合自己开发和离线安装。',
    npm: 'npm / 镜像：从 registry 拉 tarball 后校验；不执行 npm install、prepare 或任何生命周期脚本。',
    github: 'GitHub：下载仓库 tarball 后校验；仓库里必须有 plugin.json，构建产物需随仓库提交。',
  }

  const syncFolderStatus = () => {
    if (selectedFolderEntries.length === 0) {
      pathStatus.hidden = true
      pathStatus.innerHTML = ''
      return
    }
    const total = selectedFolderEntries.reduce((sum, entry) => sum + (entry.file.size || 0), 0)
    pathStatus.hidden = false
    pathStatus.innerHTML = `<span class="pi-path-status-icon"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M1.8 4.3a1.3 1.3 0 0 1 1.3-1.3h3.1l1.4 1.5h4.3a1.3 1.3 0 0 1 1.3 1.3v6.1a1.3 1.3 0 0 1-1.3 1.3H3.1a1.3 1.3 0 0 1-1.3-1.3V4.3Z" stroke="currentColor" stroke-width="1.1"/></svg></span>
      <span class="pi-path-status-copy"><strong>${esc(selectedFolderName)}</strong><small>${selectedFolderEntries.length} 个文件 · ${esc(fmtSize(total))}</small></span>
      <span class="pill ok">已选择</span>`
  }

  const syncSource = (next) => {
    source = next
    for (const tab of tabs) {
      const active = tab.dataset.installSource === next
      tab.classList.toggle('is-active', active)
      tab.setAttribute('aria-selected', active ? 'true' : 'false')
    }
    for (const panel of panels) panel.classList.toggle('is-hidden', panel.dataset.installPanel !== next)
    noteEl.dataset.tip = sourceNotes[next] || ''
    noteEl.setAttribute('aria-label', sourceNotes[next] || '安装来源说明')
    stateEl.className = 'modal-state'
    stateEl.textContent = ''
  }
  for (const tab of tabs) tab.addEventListener('click', () => syncSource(tab.dataset.installSource))
  const applyFolderSelection = (entries) => {
    selectedFolderEntries = entries
    selectedFolderName = String(entries[0]?.rel || '').split('/').filter(Boolean)[0] || '插件文件夹'
    syncFolderStatus()
    if (entries.length > 0) {
      stateEl.className = 'modal-state ok'
      stateEl.textContent = `已选择「${selectedFolderName}」，共 ${entries.length} 个文件，点「安装插件」上传并安装`
    }
  }
  pickFolder.addEventListener('click', async () => {
    // 新版 Chrome/Edge 优先用目录选择器：它不会再弹浏览器原生的「将 N 个文件上传到此网站？」确认
    if (typeof window.showDirectoryPicker === 'function') {
      try {
        const dir = await window.showDirectoryPicker({ id: 'eab-plugin-folder', mode: 'read' })
        const entries = await collectDirectoryEntries(dir, `${dir.name}/`, [])
        applyFolderSelection(entries)
      } catch (err) {
        if (err && err.name === 'AbortError') return
        stateEl.className = 'modal-state bad'
        stateEl.textContent = `读取文件夹失败：${err?.message || err}`
      }
      return
    }
    folderInput.value = ''
    folderInput.click()
  })
  folderInput.addEventListener('change', () => {
    const files = Array.from(folderInput.files || [])
    applyFolderSelection(files.map((file) => ({ rel: String(file.webkitRelativePath || file.name), file })))
  })
  syncSource(source)

  const submit = overlay.querySelector('#pi-submit')
  submit.addEventListener('click', async () => {
    const body = {
      source,
      overwrite: overlay.querySelector('#pi-overwrite').checked,
    }
    if (source === 'browser-dir' && selectedFolderEntries.length === 0) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = '请选择一个插件文件夹（含 plugin.json 或 DSH 的 package.json）'
      return
    }
    if (source === 'npm') {
      body.packageName = overlay.querySelector('#pi-npm-name').value.trim()
      if (!body.packageName) {
        stateEl.className = 'modal-state bad'
        stateEl.textContent = '请填 npm 包名'
        return
      }
    }
    if (source === 'github') {
      body.repo = overlay.querySelector('#pi-github-repo').value.trim()
      if (!body.repo) {
        stateEl.className = 'modal-state bad'
        stateEl.textContent = '请填 GitHub 仓库（owner/repo）'
        return
      }
    }
    const initialText = source === 'browser-dir'
      ? '正在读取文件夹并上传…'
      : source === 'npm'
        ? '正在从 npm 拉取并校验…'
        : '正在从 GitHub 下载并校验…'
    startProgress(initialText)
    submit.disabled = true
    submit.textContent = '安装中…'
    try {
      if (source === 'browser-dir') {
        body.files = await readPluginFolderFiles(selectedFolderEntries)
        body.folderName = selectedFolderName
        updateProgress('正在上传并校验插件…')
      }
      await api('/api/my/plugins/install', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      completeProgress('安装完成，正在刷新个人工作台…')
      try {
        await loadMyPlugins()
      } catch {
        // 安装已经成功，列表刷新失败不改变安装结果，也不阻止自动关闭。
      }
      await new Promise((resolve) => setTimeout(resolve, 900))
      close()
      banner('个人插件已安装，入口已出现在工作台', 'ok')
    } catch (err) {
      failProgress()
      stateEl.className = 'modal-state bad'
      stateEl.textContent = `${err.message}${err.code ? `（${err.code}）` : ''}`
      submit.disabled = false
      submit.textContent = '安装插件'
    }
  })
}

function autoName() {
  return state.models.find((m) => m.id === state.autoModelId)?.name ?? ''
}

const CHAT_MODEL_TAG_LABELS = {
  chat: '对话',
  reasoning: '推理',
  decision: '决策',
  vision: '图片识别',
  multimodal: '多模态',
  code: '代码',
  tool: '工具调用',
  embedding: '向量',
  audio: '语音',
  video: '视频',
  long_context: '长文本',
  fast: '快速',
}

function modelTagsLabel(tags = []) {
  return (tags || []).map((tag) => CHAT_MODEL_TAG_LABELS[String(tag || '').toLowerCase()] || tag).join(' / ')
}

function modelLabel(modelId) {
  if (!modelId) return autoName() ? `自动（${autoName()}）` : '自动'
  return state.models.find((m) => m.id === modelId)?.name ?? modelId
}

function thinkingConfigForModel(modelId) {
  const id = modelId || state.autoModelId || ''
  const model = state.models.find((item) => item.id === id)
  const config = model?.thinking
  if (!config?.enabled || !Array.isArray(config.options) || config.options.length === 0) return null
  return config
}

function activeThinkingConfig() {
  return thinkingConfigForModel(state.selected)
}

function thinkingDefault(config) {
  const fallback = config.options[0]?.id || ''
  return config.options.some((item) => item.id === config.defaultEffort) ? config.defaultEffort : fallback
}

function thinkingLabel(config, effort) {
  return config.options.find((item) => item.id === effort)?.label || effort
}

function renderThinkingMenu(config) {
  const menu = $('#think-menu')
  if (!menu) return
  const options = config.options
    .map((item) => {
      const active = item.id === state.reasoningEffort
      return `<button class="think-option${active ? ' is-active' : ''}" type="button" role="option" aria-selected="${active}" data-think="${esc(item.id)}">
        <span>
          <strong>${esc(item.label || item.id)}</strong>
          <small>${esc(item.hint || '模型声明的思考档位。')}</small>
        </span>
        <span class="think-check" aria-hidden="true">${active ? '✓' : ''}</span>
      </button>`
    })
    .join('')
  menu.innerHTML = options
}

function syncThinkingChip() {
  const wrap = $('#think-wrap')
  const menu = $('#think-menu')
  const chip = $('#think-chip')
  if (!wrap || !menu || !chip) return
  const config = activeThinkingConfig()
  if (!config) {
    state.reasoningEffort = ''
    wrap.hidden = true
    menu.hidden = true
    chip.setAttribute('aria-expanded', 'false')
    return
  }
  if (!config.options.some((item) => item.id === state.reasoningEffort)) {
    state.reasoningEffort = thinkingDefault(config)
  }
  wrap.hidden = false
  $('#think-chip-label').textContent = `思考：${thinkingLabel(config, state.reasoningEffort)}`
  renderThinkingMenu(config)
}

function setThinkingEffort(effort, options = {}) {
  const config = activeThinkingConfig()
  if (!config || !config.options.some((item) => item.id === effort)) return
  state.reasoningEffort = effort
  $('#think-menu').hidden = true
  $('#think-chip').setAttribute('aria-expanded', 'false')
  syncThinkingChip()
  if (options.persist !== false && state.sessionId) {
    persistSessionModel(state.selected, state.reasoningEffort)
  }
}

function setSelected(modelId, options = {}) {
  const visible = modelId ? state.models.find((m) => m.id === modelId) : null
  state.selected = visible ? visible.id : ''
  const config = thinkingConfigForModel(state.selected)
  const requested = String(options.reasoningEffort || '').trim()
  state.reasoningEffort = config
    ? (config.options.some((item) => item.id === requested) ? requested : thinkingDefault(config))
    : ''
  $('#model-chip-label').textContent = modelLabel(state.selected)
  $('#model-menu').hidden = true
  $('#model-chip').setAttribute('aria-expanded', 'false')
  renderModelMenus()
  renderAttachments()
  syncThinkingChip()
  if (options.persist !== false && state.sessionId) {
    persistSessionModel(state.selected, state.reasoningEffort)
  }
}

async function persistSessionModel(modelId, reasoningEffort = state.reasoningEffort) {
  try {
    await api(`/api/chat/sessions/${encodeURIComponent(state.sessionId)}/model${qs()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        modelId: modelId || null,
        reasoningEffort: reasoningEffort || null,
      }),
    })
  } catch (err) {
    banner(`模型已切换，但当前会话没有保存：${err.message || '保存失败'}`, 'warn')
  }
}

/**
 * 接替模型成功后刷新一次目录：服务端会把真实成功的模型排到前面，
 * 自动模式下一次就直接选它，不再先撞刚失败的模型。
 */
async function refreshModelCatalog() {
  if (state.modelRefreshPromise) {
    try {
      await state.modelRefreshPromise
    } catch {
      /* 同一轮刷新失败由发起方统一处理 */
    }
    return
  }
  state.modelRefreshPromise = (async () => {
    const data = await api(`/api/chat/models${qs()}`, { cache: 'no-store' })
    if (!data || !Array.isArray(data.models)) return
    state.models = data.models
    state.autoModelId = data.autoModelId ?? null
    state.canChat = Boolean(data.canChat && data.canUseModel)
    state.transcribeAvailable = Boolean(data.transcribe?.available)
    state.speechAvailable = Boolean(data.speech?.available)
    state.voiceSettings.speechAvailable = state.speechAvailable
    renderVoiceControls()
    renderVoiceSettings()
    if (state.selected && !state.models.some((model) => model.id === state.selected)) {
      state.selected = ''
    }
    renderModelMenus()
    $('#model-chip-label').textContent = modelLabel(state.selected)
    syncThinkingChip()
    updateSendState()
    if (state.me) renderEmpty(state.me)
    $('#demo-pill').hidden = !state.models.length || !state.models.every((model) => model.provider === 'demo')
  })()
  try {
    await state.modelRefreshPromise
  } catch {
    // 目录刷新失败不影响已经完成的回答，下一轮服务端仍按健康顺序选择。
  } finally {
    state.modelRefreshPromise = null
  }
}

function renderSideModels() {
  const list = $('#side-models')
  const rows = []
  if (state.autoModelId) {
    rows.push(
      `<button class="side-model ${state.selected === '' ? 'is-active' : ''}" type="button" data-model="">
        <strong>自动选择</strong>
        <span>按你的权限挑一个最合适的${autoName() ? `（现在会选 ${esc(autoName())}）` : ''}</span>
      </button>`,
    )
  }
  for (const model of state.models) {
    rows.push(
      `<button class="side-model ${state.selected === model.id ? 'is-active' : ''}" type="button" data-model="${esc(model.id)}">
        <strong>${esc(model.name)}</strong>
        <span>${esc(model.desc || '')}${model.tags && model.tags.length ? ` · ${esc(modelTagsLabel(model.tags))}` : ''}${model.thinking?.enabled ? ' · 可调思考' : ''}</span>
      </button>`,
    )
  }
  list.innerHTML = rows.join('')
  for (const button of list.querySelectorAll('[data-model]')) {
    button.addEventListener('click', () => setSelected(button.dataset.model))
  }
}

function renderModelMenu() {
  const menu = $('#model-menu')
  const options = []
  if (state.autoModelId) {
    options.push(
      `<button class="model-option ${state.selected === '' ? 'is-active' : ''}" type="button" data-model="">
        <strong>自动选择</strong>
        <span>${autoName() ? `让系统按你的权限挑，现在会选 ${esc(autoName())}` : '让系统按你的权限挑'}</span>
      </button>`,
    )
  }
  for (const model of state.models) {
    options.push(
      `<button class="model-option ${state.selected === model.id ? 'is-active' : ''}" type="button" data-model="${esc(model.id)}">
        <strong>${esc(model.name)}</strong>
        <span>${esc(model.desc || '')}${model.supportsVision ? ' · 图片识别' : ''}${model.thinking?.enabled ? ' · 可调思考' : ''}</span>
      </button>`,
    )
  }
  menu.innerHTML = options.join('') || '<div class="muted" style="padding:8px;font-size:12px">没有可用模型</div>'
  for (const button of menu.querySelectorAll('[data-model]')) {
    button.addEventListener('click', () => setSelected(button.dataset.model))
  }
}

function renderModelMenus() {
  renderSideModels()
  renderModelMenu()
}

/* ---------------- 对话内模型切换 ---------------- */

function compactModelText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s\u3000·_.\-/／（）()]+/g, '')
}

function modelMatches(query) {
  const q = compactModelText(query).replace(/模型$/g, '')
  if (!q) return []
  const exact = state.models.filter((model) => compactModelText(model.name) === q || compactModelText(model.id) === q)
  if (exact.length > 0) return exact
  return state.models.filter((model) => {
    const name = compactModelText(model.name)
    const id = compactModelText(model.id)
    return name.includes(q) || id.includes(q) || (name.length >= 2 && q.includes(name))
  })
}

function appendModelCommandNote(text) {
  setEmptyVisible(false)
  const node = document.createElement('div')
  node.className = 'chat-command-note'
  node.textContent = text
  $('#thread').appendChild(node)
  scrollThreadToBottomInstant()
}

function appendModelCommandCard(title, models, hint = '') {
  setEmptyVisible(false)
  const node = document.createElement('div')
  node.className = 'chat-command-card'
  const autoRow = state.autoModelId
    ? `<button class="chat-command-option ${state.selected === '' ? 'is-active' : ''}" type="button" data-model="">
        <strong>自动选择${state.selected === '' ? ' · 当前' : ''}</strong>
        <span>${autoName() ? `让系统按你的权限挑，现在会选 ${esc(autoName())}` : '让系统按你的权限挑'}</span>
      </button>`
    : ''
  const rows = models.map((model) => {
    const active = state.selected === model.id
    const detail = [model.desc, model.tags && model.tags.length ? modelTagsLabel(model.tags) : '', model.supportsVision ? '图片识别' : '', model.thinking?.enabled ? '可调思考' : '']
      .filter(Boolean)
      .join(' · ')
    return `<button class="chat-command-option ${active ? 'is-active' : ''}" type="button" data-model="${esc(model.id)}">
      <strong>${esc(model.name)}${active ? ' · 当前' : ''}</strong>
      <span>${esc(detail || '可用模型')}</span>
    </button>`
  })
  node.innerHTML = `<div class="chat-command-head"><strong>${esc(title)}</strong><span>${esc(hint)}</span></div>
    <div class="chat-command-list">${autoRow}${rows.join('')}</div>`
  $('#thread').appendChild(node)
  node.querySelectorAll('[data-model]').forEach((button) => {
    button.addEventListener('click', () => {
      const modelId = button.dataset.model || ''
      const model = modelId ? state.models.find((item) => item.id === modelId) : null
      if (modelId && !model) return
      setSelected(modelId)
      node.remove()
      appendModelCommandNote(modelId ? `已切换到「${model.name}」。接下来的消息会使用它。` : `已切回自动选择${autoName() ? `（现在会选「${autoName()}」）` : ''}。`)
    })
  })
  scrollThreadToBottomInstant()
}

function handleModelCommand(rawText) {
  const text = String(rawText || '').trim()
  if (!text || text.length > 160 || state.attachments.length > 0) return false
  if (/^\/(model|models|模型)$/i.test(text) || /^(切换模型|换模型)$/.test(text)) {
    appendModelCommandCard(
      `可用模型（${state.models.length}）`,
      state.models,
      '只来自当前身份有权限使用的模型，点选即可切换',
    )
    return true
  }
  if (/^\/(auto|自动)$/i.test(text)) {
    setSelected('')
    appendModelCommandNote(`已切回自动选择${autoName() ? `（现在会选「${autoName()}」）` : ''}。`)
    return true
  }

  const patterns = [
    /^\/model\s+([\s\S]+)$/i,
    /^切换到\s*([\s\S]+)$/,
    /^切换模型(?:到|为|成)?\s*([\s\S]+)$/,
    /^换成\s*([\s\S]+)$/,
    /^换用\s*([\s\S]+)$/,
    /^使用\s*([\s\S]+?)\s*模型$/,
    /^用\s*([\s\S]+?)\s*模型$/,
  ]
  let query = ''
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match) {
      query = String(match[1] || '').trim().replace(/(?:模型|吧|呢|。|！|!)$/g, '').trim()
      break
    }
  }
  if (!query) return false
  if (compactModelText(query) === '自动' || compactModelText(query) === 'auto' || compactModelText(query) === '默认') {
    setSelected('')
    appendModelCommandNote(`已切回自动选择${autoName() ? `（现在会选「${autoName()}」）` : ''}。`)
    return true
  }

  const matches = modelMatches(query)
  if (matches.length === 0) {
    appendModelCommandCard(
      `没有找到「${query}」`,
      state.models,
      '只列出当前身份有权限使用的模型，可直接点选',
    )
    return true
  }
  if (matches.length > 1) {
    appendModelCommandCard(`找到 ${matches.length} 个匹配「${query}」的模型`, matches, '点选一个切换')
    return true
  }
  setSelected(matches[0].id)
  appendModelCommandNote(`已切换到「${matches[0].name}」。接下来的消息会使用它。`)
  return true
}

/* ---------------- 空态与消息 ---------------- */

function setEmptyVisible(visible) {
  const empty = $('#chat-empty')
  if (empty) empty.hidden = !visible
}

function renderEmpty(me) {
  const org =
    me.company && me.person.deptName !== me.company.name
      ? `${me.company.name} · ${me.person.deptName}`
      : me.person.deptName
  $('#empty-title').textContent = `你好，${me.person.name}`
  $('#empty-sub').textContent = `${org} · ${state.models.length} 个模型可用。问点什么开始。`
}

function renderSuggestions() {
  const prompts = ['帮我起草一封跟进邮件', '把这份会议要点整理成待办', '公司差旅报销怎么走']
  $('#suggest').innerHTML = prompts
    .map((text) => `<button type="button" data-prompt="${esc(text)}">${esc(text)}</button>`)
    .join('')
  for (const button of $('#suggest').querySelectorAll('[data-prompt]')) {
    button.addEventListener('click', () => {
      const input = $('#input')
      input.value = button.dataset.prompt
      input.focus()
      autosize()
    })
  }
}

function formatCount(value) {
  const number = Math.max(0, Number(value) || 0)
  return number.toLocaleString('zh-CN')
}

/** 批次数据接管卡：只说明“数据在哪、多大、能保留多久”，正文不塞进消息。 */
function batchCardHtml(batch, options = {}) {
  const id = String(batch?.id || batch?.batchId || '').trim()
  if (!id) return ''
  const rows = Math.max(0, Number(batch?.totalRows) || 0)
  const chars = Math.max(0, Number(batch?.chars ?? batch?.batchChars) || 0)
  const isText = batch?.kind === 'text' || rows === 0
  const kind = isText ? '文本批次' : '记录批次'
  const size = isText
    ? `${formatCount(chars)} 字符`
    : `${formatCount(rows)} 行 · ${formatCount(chars)} 字符`
  const source = String(options.name || '').trim()
  return `<div class="batch-card" data-batch-id="${esc(id)}" role="group" aria-label="批次数据接管：${esc(kind)} ${esc(size)}">
    <div class="batch-card-head">
      <span class="batch-card-pill">数据接管</span>
      <span class="batch-card-kind">${esc(kind)} · ${esc(size)}</span>
    </div>
    ${source ? `<div class="batch-card-source">${esc(source)}</div>` : ''}
    <div class="batch-card-id"><span>批次</span><code>${esc(id)}</code></div>
    <div class="batch-card-foot"><span>保留 24 小时</span><span>完整数据留在本地，不进入消息上下文</span><span>模型可按需 batch_read / batch_analyze</span></div>
  </div>`
}

function attachmentDisplayName(file) {
  return String(file?.workspaceName || file?.name || '附件')
}

function attachmentDisplaySize(file) {
  const value = file?.workspaceSize ?? file?.size
  return Number.isFinite(Number(value)) ? fmtSize(Number(value)) : ''
}

/** 消息卡片只内联栅格图片；SVG/PDF/Office 走文件卡，不生成 img。 */
function isRasterImageAttachment(file) {
  const mime = String(file?.workspaceMime || file?.type || '').toLowerCase()
  if (/^image\/(png|jpeg|jpg|webp|gif|avif|bmp)$/.test(mime)) return true
  return /\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(attachmentDisplayName(file))
}

function attachmentPreviewUrl(file) {
  const id = String(file?.workspaceFileId || '').trim()
  if (!id) return ''
  return `/api/workspace/files/${encodeURIComponent(id)}/preview${qs()}`
}

function attachmentKindLabel(file) {
  const name = attachmentDisplayName(file)
  const ext = (name.split('.').pop() || '').toLowerCase()
  const labels = {
    pdf: 'PDF', doc: 'DOC', docx: 'DOC', xls: 'XLS', xlsx: 'XLS', xlsm: 'XLS',
    ppt: 'PPT', pptx: 'PPT', txt: 'TXT', md: 'MD', csv: 'CSV', json: 'JSON',
    zip: 'ZIP', rar: 'RAR', '7z': '7Z', png: 'IMG', jpg: 'IMG', jpeg: 'IMG',
    webp: 'IMG', gif: 'GIF', svg: 'SVG', mp4: 'VID', mov: 'VID', mp3: 'AUD', wav: 'AUD',
  }
  return labels[ext] || (ext ? ext.slice(0, 4).toUpperCase() : 'FILE')
}

const ATTACHMENT_TRASH_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M7 7l1 12h8l1-12" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 10v6M14 10v6" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>'

function deletedAttachmentHtml(file) {
  const id = String(file?.workspaceFileId || '').trim()
  const name = attachmentDisplayName(file)
  const size = attachmentDisplaySize(file)
  return `<div class="bubble-attach is-deleted" role="img" aria-label="${esc(name)}已从云空间删除"${id ? ` data-attachment-file-id="${esc(id)}"` : ''} data-attachment-name="${esc(name)}" data-attachment-size="${esc(size)}">
    <span class="bubble-attach-icon is-deleted">${ATTACHMENT_TRASH_ICON}</span>
    <span class="bubble-attach-body"><span class="bubble-attach-name">已被删除</span><span class="bubble-attach-meta">${esc(name)} · 已从云空间删除</span></span>
  </div>`
}

function pendingAttachmentHtml(file) {
  return `<div class="bubble-attach is-pending" data-attachment-key="${esc(file.clientUploadId || '')}" aria-label="${esc(attachmentDisplayName(file))}正在保存到云空间">
    <span class="bubble-attach-spinner" aria-hidden="true"></span>
    <span class="bubble-attach-body"><span class="bubble-attach-name">${esc(attachmentDisplayName(file))}</span><span class="bubble-attach-meta">正在保存到云空间…</span></span>
  </div>`
}

function unsavedAttachmentHtml(file) {
  const reason = String(file?.workspaceError || '').trim()
  return `<div class="bubble-attach is-unsaved" data-attachment-key="${esc(file.clientUploadId || '')}" role="group" aria-label="${esc(attachmentDisplayName(file))}未保存到云空间">
    <span class="bubble-attach-icon is-unsaved" aria-hidden="true">!</span>
    <span class="bubble-attach-body"><span class="bubble-attach-name">${esc(attachmentDisplayName(file))}</span><span class="bubble-attach-meta">${esc(attachmentDisplaySize(file))}${reason ? ` · ${esc(reason)}` : ' · 未保存到云空间'}</span></span>
  </div>`
}

function folderAttachmentHtml(file) {
  const name = attachmentDisplayName(file)
  const path = String(file?.workspaceRelPath || file?.workspaceFolderPath || '').trim()
  return `<div class="bubble-attach is-folder" role="group" aria-label="云空间文件夹 ${esc(name)}"${path ? ` data-folder-ref="${esc(path)}"` : ''}>
    <span class="bubble-attach-icon" aria-hidden="true">${WORKSPACE_FOLDER_ICON}</span>
    <span class="bubble-attach-body"><span class="bubble-attach-name">${esc(name)}</span><span class="bubble-attach-meta">${path ? `${esc(path)} · ` : ''}云空间文件夹</span></span>
  </div>`
}

function conversationAttachmentHtml(file) {
  const title = attachmentDisplayName(file)
  const count = Math.max(0, Number(file?.conversationMessageCount) || 0)
  const meta = count
    ? `最近 ${formatCount(count)} 条消息${file?.conversationIsCurrent ? ' · 本对话' : ''}`
    : file?.conversationIsCurrent ? '本对话历史' : '对话历史'
  return `<div class="bubble-attach is-conversation" role="group" aria-label="对话引用 ${esc(title)}">
    <span class="bubble-attach-icon" aria-hidden="true">${CONVERSATION_ICON}</span>
    <span class="bubble-attach-body"><span class="bubble-attach-name">${esc(title)}</span><span class="bubble-attach-meta">${esc(meta)} · 对话引用</span></span>
  </div>`
}

function attachmentParseLabel(file) {
  if (!file?.parseKind) return ''
  const pages = Math.max(0, Number(file?.parsePageCount) || 0)
  const ocrPages = Math.max(0, Number(file?.parseOcrPageCount) || 0)
  const chars = Math.max(0, Number(file?.chars) || 0)
  const ocr = ocrPages ? ` · OCR ${ocrPages} 页` : ''
  if (chars > 0) return `${pages ? `已解析 ${pages} 页` : '正文已解析'}${ocr}`
  return ocrPages ? `OCR ${ocrPages} 页` : '未解析正文'
}

function attachmentCardHtml(file) {
  if (file?.conversationId) return conversationAttachmentHtml(file)
  if (file?.workspaceKind === 'folder' && !String(file.workspaceFileId || '').trim()) return folderAttachmentHtml(file)
  const status = String(file?.workspaceStatus || '')
  const id = String(file?.workspaceFileId || '').trim()
  const name = attachmentDisplayName(file)
  const size = attachmentDisplaySize(file)
  if (status === 'deleted' || status === 'missing') return deletedAttachmentHtml(file)
  if (status === 'forbidden') {
    return `<div class="bubble-attach is-deleted" role="img" aria-label="${esc(name)}无权访问"${id ? ` data-attachment-file-id="${esc(id)}"` : ''} data-attachment-name="${esc(name)}">
      <span class="bubble-attach-icon is-deleted" aria-hidden="true">!</span>
      <span class="bubble-attach-body"><span class="bubble-attach-name">无权访问</span><span class="bubble-attach-meta">${esc(name)}</span></span>
    </div>`
  }
  if (status === 'pending') return pendingAttachmentHtml(file)
  if (status === 'unsaved') return unsavedAttachmentHtml(file)
  if (!id) {
    // 旧消息没有 workspaceFileId，保持原来的文字 chip；不强行补预览。
    return `<span>${esc(name)} · ${esc(size)}${file.batchId ? ' · 已接管' : ''}</span>`
  }
  if (isRasterImageAttachment(file)) {
    const url = attachmentPreviewUrl(file)
    return `<button class="bubble-attach is-image" type="button" data-attachment-open="${esc(id)}" data-attachment-file-id="${esc(id)}" data-attachment-name="${esc(name)}" data-attachment-size="${esc(size)}" data-attachment-image-src="${esc(url)}" aria-label="预览图片 ${esc(name)}">
      <img src="${esc(url)}" alt="${esc(name)}" loading="lazy" decoding="async">
      <span class="bubble-attach-caption"><span class="bubble-attach-name">${esc(name)}</span><span class="bubble-attach-meta">${esc(size)} · 点击预览</span></span>
    </button>`
  }
  const parseLabel = attachmentParseLabel(file)
  const metaText = file.persistent
    ? `${size}${parseLabel ? ` · ${parseLabel}` : ''} · 云空间文件`
    : `${size}${parseLabel ? ` · ${parseLabel}` : ''} · 已保存到云空间`
  return `<button class="bubble-attach is-file" type="button" data-attachment-open="${esc(id)}" data-attachment-file-id="${esc(id)}" data-attachment-name="${esc(name)}" data-attachment-size="${esc(size)}" aria-label="预览文件 ${esc(name)}">
    <span class="bubble-attach-icon" data-kind="${esc(attachmentKindLabel(file))}" aria-hidden="true">${esc(attachmentKindLabel(file))}</span>
    <span class="bubble-attach-body"><span class="bubble-attach-name">${esc(name)}</span><span class="bubble-attach-meta">${esc(metaText)}</span></span>
    <span class="bubble-attach-open" aria-hidden="true">›</span>
  </button>`
}

function attachmentChips(list) {
  const cards = (Array.isArray(list) ? list : []).map((file) => attachmentCardHtml(file)).join('')
  const batches = (Array.isArray(list) ? list : [])
    .filter((file) => file.batchId)
    .map((file) =>
      batchCardHtml(
        { id: file.batchId, kind: 'text', totalRows: 0, chars: file.batchChars ?? file.chars },
        { name: file.name },
      ),
    )
    .join('')
  return cards + batches
}

let imageLightboxReturnFocus = null
let imageLightboxObjectUrl = ''
let imageLightboxScale = 1
let imageLightboxX = 0
let imageLightboxY = 0
let imageLightboxDrag = null
const IMAGE_LIGHTBOX_MIN_SCALE = 1
const IMAGE_LIGHTBOX_MAX_SCALE = 4

function releaseImageLightboxObjectUrl() {
  if (!imageLightboxObjectUrl) return
  URL.revokeObjectURL(imageLightboxObjectUrl)
  imageLightboxObjectUrl = ''
}

function imageLightboxElements() {
  const overlay = document.getElementById('image-lightbox')
  if (!overlay) return null
  return {
    overlay,
    body: overlay.querySelector('.image-lightbox-body'),
    image: overlay.querySelector('.image-lightbox-body img'),
    value: overlay.querySelector('[data-image-zoom-value]'),
    zoomOut: overlay.querySelector('[data-image-zoom-out]'),
    zoomIn: overlay.querySelector('[data-image-zoom-in]'),
  }
}

function clampImageLightboxPan() {
  const parts = imageLightboxElements()
  if (!parts?.body || !parts.image) return
  const maxX = Math.max(0, (parts.image.clientWidth * imageLightboxScale - parts.body.clientWidth) / 2)
  const maxY = Math.max(0, (parts.image.clientHeight * imageLightboxScale - parts.body.clientHeight) / 2)
  imageLightboxX = Math.min(maxX, Math.max(-maxX, imageLightboxX))
  imageLightboxY = Math.min(maxY, Math.max(-maxY, imageLightboxY))
}

function applyImageLightboxTransform() {
  const parts = imageLightboxElements()
  if (!parts?.image) return
  parts.image.style.transform = `translate3d(${imageLightboxX}px, ${imageLightboxY}px, 0) scale(${imageLightboxScale})`
  parts.overlay.classList.toggle('is-zoomed', imageLightboxScale > IMAGE_LIGHTBOX_MIN_SCALE + 0.001)
  if (parts.value) parts.value.textContent = `${Math.round(imageLightboxScale * 100)}%`
  if (parts.zoomOut) parts.zoomOut.disabled = imageLightboxScale <= IMAGE_LIGHTBOX_MIN_SCALE + 0.001
  if (parts.zoomIn) parts.zoomIn.disabled = imageLightboxScale >= IMAGE_LIGHTBOX_MAX_SCALE - 0.001
}

function resetImageLightboxZoom() {
  imageLightboxScale = 1
  imageLightboxX = 0
  imageLightboxY = 0
  imageLightboxDrag = null
  applyImageLightboxTransform()
}

function setImageLightboxScale(nextScale, anchorX = null, anchorY = null) {
  const parts = imageLightboxElements()
  if (!parts?.body) return
  const next = Math.min(IMAGE_LIGHTBOX_MAX_SCALE, Math.max(IMAGE_LIGHTBOX_MIN_SCALE, Number(nextScale) || 1))
  if (Math.abs(next - imageLightboxScale) < 0.001) return
  if (anchorX == null || anchorY == null) {
    const ratio = next / imageLightboxScale
    imageLightboxX *= ratio
    imageLightboxY *= ratio
  } else {
    const rect = parts.body.getBoundingClientRect()
    const centerX = anchorX - (rect.left + rect.width / 2)
    const centerY = anchorY - (rect.top + rect.height / 2)
    const ratio = next / imageLightboxScale
    imageLightboxX = imageLightboxX * ratio + centerX * (1 - ratio)
    imageLightboxY = imageLightboxY * ratio + centerY * (1 - ratio)
  }
  imageLightboxScale = next
  clampImageLightboxPan()
  applyImageLightboxTransform()
}

function closeImageLightbox() {
  const overlay = document.getElementById('image-lightbox')
  releaseImageLightboxObjectUrl()
  if (!overlay || overlay.hidden) return
  overlay.hidden = true
  overlay.classList.remove('is-panning')
  imageLightboxDrag = null
  resetImageLightboxZoom()
  document.body.classList.remove('is-image-lightbox-open')
  if (imageLightboxReturnFocus && typeof imageLightboxReturnFocus.focus === 'function') {
    imageLightboxReturnFocus.focus()
  }
  imageLightboxReturnFocus = null
}

function bindImageLightboxGestures(overlay) {
  const parts = imageLightboxElements()
  if (!parts?.body || !parts.image) return
  parts.overlay.querySelector('[data-image-zoom-out]')?.addEventListener('click', () => {
    setImageLightboxScale(imageLightboxScale - 0.25)
  })
  parts.overlay.querySelector('[data-image-zoom-in]')?.addEventListener('click', () => {
    setImageLightboxScale(imageLightboxScale + 0.25)
  })
  parts.overlay.querySelector('[data-image-zoom-reset]')?.addEventListener('click', resetImageLightboxZoom)

  parts.body.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault()
      const step = event.deltaY < 0 ? 0.2 : -0.2
      setImageLightboxScale(imageLightboxScale + step, event.clientX, event.clientY)
    },
    { passive: false },
  )

  parts.body.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || imageLightboxScale <= IMAGE_LIGHTBOX_MIN_SCALE + 0.001) return
    event.preventDefault()
    imageLightboxDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: imageLightboxX,
      originY: imageLightboxY,
    }
    try {
      parts.body.setPointerCapture(event.pointerId)
    } catch {
      // 某些浏览器不支持 pointer capture，仍可继续拖动。
    }
    parts.overlay.classList.add('is-panning')
  })

  parts.body.addEventListener('pointermove', (event) => {
    if (!imageLightboxDrag || event.pointerId !== imageLightboxDrag.pointerId) return
    imageLightboxX = imageLightboxDrag.originX + event.clientX - imageLightboxDrag.startX
    imageLightboxY = imageLightboxDrag.originY + event.clientY - imageLightboxDrag.startY
    clampImageLightboxPan()
    applyImageLightboxTransform()
  })

  const endDrag = (event) => {
    if (!imageLightboxDrag || event.pointerId !== imageLightboxDrag.pointerId) return
    imageLightboxDrag = null
    parts.overlay.classList.remove('is-panning')
    try {
      parts.body.releasePointerCapture(event.pointerId)
    } catch {
      // 指针已经释放时忽略。
    }
  }
  parts.body.addEventListener('pointerup', endDrag)
  parts.body.addEventListener('pointercancel', endDrag)

  parts.image.addEventListener('dblclick', (event) => {
    event.preventDefault()
    if (imageLightboxScale > IMAGE_LIGHTBOX_MIN_SCALE + 0.001) resetImageLightboxZoom()
    else setImageLightboxScale(2, event.clientX, event.clientY)
  })
}

function openImageLightbox(src, name = '图片', options = {}) {
  const url = String(src || '').trim()
  if (!url) return
  let overlay = document.getElementById('image-lightbox')
  if (!overlay) {
    overlay = document.createElement('div')
    overlay.id = 'image-lightbox'
    overlay.className = 'image-lightbox'
    overlay.hidden = true
    overlay.innerHTML = `<div class="image-lightbox-dialog" role="dialog" aria-modal="true" aria-label="图片预览">
      <div class="image-lightbox-head">
        <span class="image-lightbox-name"></span>
        <button class="image-lightbox-close" type="button" data-image-lightbox-close aria-label="关闭图片预览">×</button>
      </div>
      <div class="image-lightbox-body"><img alt="" draggable="false"></div>
      <div class="image-lightbox-foot">
        <span class="image-lightbox-hint">滚轮缩放 · 拖动平移 · 双击切换</span>
        <div class="image-lightbox-zoom" role="group" aria-label="图片缩放">
          <button type="button" data-image-zoom-out aria-label="缩小图片">−</button>
          <span class="image-lightbox-zoom-value" data-image-zoom-value aria-live="polite">100%</span>
          <button type="button" data-image-zoom-in aria-label="放大图片">＋</button>
          <button type="button" class="image-lightbox-fit" data-image-zoom-reset>适应窗口</button>
        </div>
      </div>
    </div>`
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay || event.target.closest('[data-image-lightbox-close]')) closeImageLightbox()
    })
    document.addEventListener('keydown', (event) => {
      if (overlay.hidden) return
      if (event.key === 'Escape') {
        closeImageLightbox()
        return
      }
      if (event.key === '+' || event.key === '=') {
        event.preventDefault()
        setImageLightboxScale(imageLightboxScale + 0.25)
      } else if (event.key === '-') {
        event.preventDefault()
        setImageLightboxScale(imageLightboxScale - 0.25)
      } else if (event.key === '0') {
        event.preventDefault()
        resetImageLightboxZoom()
      }
    })
    document.body.appendChild(overlay)
    bindImageLightboxGestures(overlay)
  }
  if (imageLightboxObjectUrl && imageLightboxObjectUrl !== url) releaseImageLightboxObjectUrl()
  imageLightboxObjectUrl = options.objectUrl ? url : ''
  const image = overlay.querySelector('img')
  const title = overlay.querySelector('.image-lightbox-name')
  if (image) {
    image.src = url
    image.alt = name
  }
  if (title) title.textContent = name
  resetImageLightboxZoom()
  imageLightboxReturnFocus = document.activeElement
  overlay.hidden = false
  document.body.classList.add('is-image-lightbox-open')
  const closeButton = overlay.querySelector('[data-image-lightbox-close]')
  if (closeButton && typeof closeButton.focus === 'function') closeButton.focus()
}

/** 消息气泡里的附件卡用事件委托，重绘 innerHTML 后仍可点击。 */
function bindAttachmentCards(node) {
  if (!node || node.dataset.attachmentClickBound === '1') return
  node.dataset.attachmentClickBound = '1'
  node.addEventListener('click', (event) => {
    const button = event.target.closest('[data-attachment-open]')
    if (!button || !node.contains(button)) return
    event.preventDefault()
    const imageSrc = String(button.dataset.attachmentImageSrc || '').trim()
    if (imageSrc) {
      // 图片直接走即时大图，不再等右侧文件预览的能力探测；小图卡片仍停留在消息里。
      openImageLightbox(imageSrc, String(button.dataset.attachmentName || '图片'))
      return
    }
    void openWorkspaceFile(String(button.dataset.attachmentOpen || ''), { opener: button })
  })
}

function updateAttachmentCards(node, list) {
  if (!node) return
  node.chatAttachments = Array.isArray(list) ? list : []
  const files = node.querySelector('.bubble-files')
  if (!files) return
  files.innerHTML = attachmentChips(node.chatAttachments)
  bindAttachmentCards(node)
}

/** 云空间删除事件：消息卡片就地变成“已被删除”，不重新加载整段历史。 */
function markAttachmentCardsDeleted(fileIds) {
  const ids = new Set((fileIds || []).map((id) => String(id || '').trim()).filter(Boolean))
  if (ids.size === 0) return
  for (const card of document.querySelectorAll('[data-attachment-file-id]')) {
    const id = String(card.dataset.attachmentFileId || '')
    if (!ids.has(id)) continue
    const file = {
      workspaceFileId: id,
      workspaceName: card.dataset.attachmentName || '',
      workspaceSize: card.dataset.attachmentSize || '',
      workspaceStatus: 'deleted',
    }
    const wrapper = document.createElement('div')
    wrapper.innerHTML = deletedAttachmentHtml(file)
    const next = wrapper.firstElementChild
    if (next) card.replaceWith(next)
  }
}

function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0.1s'
  return ms < 1000 ? `${Math.max(1, Math.round(ms))}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** 上游不返回 usage 时，按中英文混排字符估算输出 token；调用方必须标成近似值。 */
function estimateOutputTokens(text) {
  const source = String(text || '')
  if (!source) return 0
  let tokens = 0
  let asciiRun = 0
  const flushAscii = () => {
    if (asciiRun > 0) tokens += Math.ceil(asciiRun / 4)
    asciiRun = 0
  }
  for (const char of source) {
    const code = char.codePointAt(0) || 0
    if (code <= 0x7f) {
      if (/\s/.test(char)) flushAscii()
      else asciiRun += 1
    } else {
      flushAscii()
      tokens += 1
    }
  }
  flushAscii()
  return tokens
}

/** 模型生成速度：只把纯生成窗口当分母，工具执行和排队时间不算进去。 */
function tokenSpeedText(tokens, timing, fallbackText = '') {
  const completion = Number(tokens?.completion ?? tokens?.completionTokens ?? 0)
  const genMs = Number(timing?.genMs ?? 0)
  if (!Number.isFinite(genMs) || genMs <= 0) return ''
  const measured = Number.isFinite(completion) && completion > 0
  const count = measured ? completion : estimateOutputTokens(fallbackText)
  if (count <= 0) return ''
  const speed = count / (genMs / 1000)
  if (!Number.isFinite(speed) || speed <= 0) return ''
  const digits = speed >= 100 ? 0 : speed >= 10 ? 1 : 2
  return `${measured ? '' : '≈ '}${speed.toFixed(digits)} tok/s`
}

function prettyPayload(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  if (!text) return '（空）'
  return text.length > 1600 ? `${text.slice(0, 1600)}\n…（已截断）` : text
}

function oneLinePreview(text, maxLength = 120) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  return normalized.length > maxLength ? `…${normalized.slice(-maxLength)}` : normalized
}

/** 跨会话实时提示只展示可读正文，丢掉图表 JSON 和代码块，避免把原始协议当预览。 */
function remoteLivePreview(text, maxLength = 80) {
  const cleaned = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/```[\s\S]*/g, ' ')
    .replace(/\{[\s\S]*?\}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned ? oneLinePreview(cleaned, maxLength) : ''
}

/** CoT 单行摘要取思考内容的第一句，和 DSH 的 “Think · …” 预览一致。 */
function firstLinePreview(text, maxLength = 96) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\*\*/g, '').replace(/^\s*[#>*\-]+\s*/, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  if (lines.length === 0) return ''
  let first = lines[0]
  if (first.length < 24 && lines[1]) first = `${first} ${lines[1]}`
  return first.length > maxLength ? `${first.slice(0, maxLength).trimEnd()}…` : first
}

/**
 * 流式思考预览取最新一段：长段落没有换行时，首行摘要会一直停在开头，
 * 看起来像思考卡住了。结束后仍由 firstLinePreview 收回首行摘要。
 */
function livePreview(text, maxLength = 96) {
  const normalized = String(text || '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) return ''
  return normalized.length > maxLength ? `…${normalized.slice(-maxLength).trimStart()}` : normalized
}

/**
 * 一个回合里工具失败后，Agent 往往马上换参数或换工具重试。中间尝试不参与
 * 最终状态：后续已有成功或仍在执行的调用时，前面的失败直接隐藏；如果全都
 * 失败，也只保留最后一次失败作为未恢复的最终错误，避免整轮工具面板变红。
 */
function normalizeRecoveredToolCalls(tools) {
  if (!Array.isArray(tools)) return []
  let lastLive = -1
  let lastError = -1
  tools.forEach((tool, index) => {
    if (tool?.status === 'done' || tool?.status === 'running') lastLive = index
    if (tool?.status === 'error') lastError = index
  })
  return tools.filter((tool, index) => {
    if (tool?.status !== 'error') return true
    if (index < lastLive) return false
    return index === lastError
  })
}

function toolStatusText(trace) {
  if (trace.status === 'running') return '执行中'
  if (trace.status === 'error') return '失败'
  return `完成 · ${formatElapsed(trace.durationMs)}`
}

function toolDisplayName(name) {
  const raw = String(name || '')
  if (raw === 'batch_analyze') return '全量分批分析'
  if (raw === 'batch_read') return '分页读取批次'
  if (raw === 'workspace_search' || raw === 'workspace.search' || raw === '搜索工作区文件') return '检索文件'
  if (raw === 'workspace_read' || raw === 'workspace.read' || raw === '读取工作区文件') return '按行读取'
  if (raw === 'workspace_edit' || raw === 'workspace.edit' || raw === '编辑工作区文件') return '局部编辑'
  if (raw === 'workspace_write' || raw === 'workspace.write' || raw === '写入工作区文件') return '写入文件'
  if (raw === 'project_exec' || raw === 'project.exec' || raw === '执行项目命令') return '运行命令'
  if (raw === 'project_job' || raw === 'project.job' || raw === '项目后台任务') return '后台任务'
  if (raw === 'plugin_dev' || raw === 'plugin.dev' || raw === '自开发插件') return '自开发插件'
  if (raw === 'skill_dev' || raw === 'skill.dev' || raw === '自开发技能') return '自开发技能'
  if (raw === 'web_fetch' || raw === 'web.fetch' || raw === '读取网页') return '读取网页'
  if (raw === 'web_search' || raw === 'web.search' || raw === '搜索互联网') return '搜索互联网'
  if (raw === 'browser' || raw === '内置浏览器') return '内置浏览器'
  return raw
}

const BROWSER_ACTION_LABEL = {
  open: '打开网页',
  snapshot: '网页快照',
  click: '点击后浏览',
  type: '输入后浏览',
  scroll: '滚动浏览',
  back: '后退',
  screenshot: '网页截图',
  close: '关闭页面',
}

/** 批次与文件工具只占一行：显示范围、命中或批次数，而不是原始 JSON。 */
function toolInlineLabel(trace) {
  if (trace?.view && trace.view.kind === 'plugin') {
    const title = String(trace.view.title || trace.view.pluginId || '').trim()
    const version = String(trace.view.version || '').trim()
    return ['已热安装', title, version ? `v${version}` : ''].filter(Boolean).join(' · ')
  }
  if (trace?.view && trace.view.kind === 'skill') {
    const title = String(trace.view.title || trace.view.skillId || '').trim()
    const version = String(trace.view.version || '').trim()
    return ['已热安装技能', title, version ? `v${version}` : ''].filter(Boolean).join(' · ')
  }
  if (trace?.view && trace.view.kind === 'browser') {
    const view = trace.view
    const label = BROWSER_ACTION_LABEL[view.action] || '浏览网页'
    const target = String(view.title || view.url || '').trim()
    const shot = view.screenshot ? ' · 已截图' : ''
    return [label, target, `${formatCount(view.elementCount || 0)} 个可操作元素`].filter(Boolean).join(' · ') + shot
  }
  const summary = String(trace.summary || '').split('\n')[0]
  if (!summary) return toolDisplayName(trace.name)
  if (trace.name === 'batch_analyze') {
    const parts = summary.split('｜')
    return ['全量分析', parts[1], parts[2]].filter(Boolean).join(' · ')
  }
  if (trace.name === 'batch_read') {
    const detail = summary.replace(/^批次 [^｜]+｜/, '')
    return `读取批次 · ${detail}`
  }
  if (trace.toolId === 'workspace.read' || trace.name === '读取工作区文件') {
    const view = trace.view && trace.view.kind === 'read' ? trace.view : null
    const result = view || parseToolSummaryObject(trace) || {}
    const path = String(view?.path || result.path || trace.args?.path || '').trim()
    if (!path) return toolDisplayName(trace.name)
    const takeover = trace.batch
      ? ` · 已接管 ${trace.batch.kind === 'text' ? `${formatCount(trace.batch.chars)} 字符` : `${formatCount(trace.batch.totalRows)} 行`}`
      : ''
    const startLine = Math.max(1, Number(result.startLine) || 1)
    const endLine = Math.max(0, Number(result.endLine) || 0)
    const totalLines = Math.max(0, Number(result.totalLines) || 0)
    if (!totalLines) return `读取 ${path}${takeover}`
    if (startLine === 1 && endLine >= totalLines && !result.truncatedByBytes && !result.truncated) {
      return `读取 ${path} · 全文 ${totalLines} 行${takeover}`
    }
    if (endLine < startLine) return `读取 ${path}${takeover}`
    const remaining = Math.max(0, totalLines - endLine)
    return `读取 ${path} · 第 ${startLine}–${endLine} 行 / 共 ${totalLines} 行${remaining > 0 ? `（剩余 ${remaining}）` : ''}${takeover}`
  }
  if (trace.toolId === 'workspace.edit' || trace.name === '编辑工作区文件') {
    const result = parseToolSummaryObject(trace) || {}
    const path = String(result.path || trace.args?.path || '').trim()
    if (!path) return toolDisplayName(trace.name)
    const changes = Math.max(0, Number(result.changes) || 0)
    const added = Math.max(0, Number(trace.diff?.added) || 0)
    const removed = Math.max(0, Number(trace.diff?.removed) || 0)
    const diffStat = trace.diff ? ` · +${added} −${removed}` : ''
    return `编辑 ${path}${changes > 0 ? ` · ${changes} 处变更` : ''}${diffStat}`
  }
  if (trace.toolId === 'project.exec' || trace.name === '执行项目命令') {
    const result = parseToolSummaryObject(trace) || {}
    const command = String(trace.args?.command || result.command || '').replace(/\s+/g, ' ').trim()
    const exitCode = Number(result.exitCode)
    const shortCommand = command.length > 48 ? `${command.slice(0, 48)}…` : command
    const status = result.timedOut ? '超时' : result.status === 'failed' || (!Number.isNaN(exitCode) && exitCode !== 0) ? `exit ${result.exitCode ?? '失败'}` : '成功'
    return `运行 ${shortCommand || '命令'} · ${status}`
  }
  if (trace.toolId === 'project.job' || trace.name === '项目后台任务') {
    const result = parseToolSummaryObject(trace) || {}
    const action = String(trace.args?.action || 'output')
    const job = result.job && typeof result.job === 'object' ? result.job : result
    const status = String(job.status || '')
    return ['后台任务', action, status].filter(Boolean).join(' · ')
  }
  if (summary.startsWith('搜索“')) {
    const view = trace.view && trace.view.kind === 'search' ? trace.view : null
    if (view) {
      const first = view.matches[0]
      const countText = view.total > view.count
        ? `显示 ${formatCount(view.count)} / 共 ${formatCount(view.total)} 处命中`
        : `${formatCount(view.total)} 处命中`
      return [
        `搜索“${view.query}”`,
        `${countText}${view.truncated ? '（已截断）' : ''}`,
        first ? `${first.path}:${first.line}` : '',
      ].filter(Boolean).join(' · ')
    }
    const parts = summary.split('｜')
    const first = String(parts[3] || '').replace(/^首个 /, '')
    return [parts[0], parts[1], first].filter(Boolean).join(' · ')
  }
  if (summary.startsWith('读取 ')) return summary.replace('｜', ' · ')
  if (trace.batch) {
    const rows = Math.max(0, Number(trace.batch.totalRows) || 0)
    const chars = Math.max(0, Number(trace.batch.chars) || 0)
    const size = trace.batch.kind === 'text' || rows === 0
      ? `${formatCount(chars)} 字符`
      : `${formatCount(rows)} 行`
    return `${toolDisplayName(trace.name)} · 已接管 ${size}`
  }
  return toolDisplayName(trace.name)
}

function toolDiffHtml(diff) {
  const lines = Array.isArray(diff?.lines) ? diff.lines : []
  if (lines.length === 0) return ''
  const added = Math.max(0, Number(diff.added) || 0)
  const removed = Math.max(0, Number(diff.removed) || 0)
  const body = lines
    .map((line) => {
      const isAdd = line?.type === 'add'
      return `<div class="tool-diff-line ${isAdd ? 'is-add' : 'is-del'}"><span class="tool-diff-sign" aria-hidden="true">${isAdd ? '+' : '-'}</span><span class="tool-diff-text">${esc(String(line?.text ?? ' ') || ' ')}</span></div>`
    })
    .join('')
  return `<div class="tool-diff" role="group" aria-label="文件修改差异">
    <div class="tool-diff-head">
      <span>修改差异</span>
      <span class="tool-diff-stat"><span class="tool-diff-add">+${added}</span><span class="tool-diff-del">−${removed}</span>${diff.truncated ? '<span class="tool-diff-more">已截断</span>' : ''}</span>
    </div>
    <div class="tool-diff-body">${body}</div>
  </div>`
}

function toolReadCardHtml(trace) {
  const view = trace?.view && trace.view.kind === 'read' ? trace.view : null
  if (!view) return ''
  const source = String(view.previewText || '').replace(/\r\n/g, '\n').split('\n')
  if (source.length > 1 && source[source.length - 1] === '') source.pop()
  const startLine = Math.max(1, Number(view.startLine) || 1)
  const endLine = Math.max(0, Number(view.endLine) || 0)
  const totalLines = Math.max(0, Number(view.totalLines) || 0)
  const remaining = Math.max(0, totalLines - endLine)
  const rangeText = totalLines === 0
    ? '空文件'
    : `第 ${startLine}–${endLine} 行 / 共 ${formatCount(totalLines)} 行${remaining > 0 ? `（剩余 ${formatCount(remaining)}）` : ''}`
  const rows = source
    .map((line, index) => `<div class="tool-read-line"><span class="tool-read-no" aria-hidden="true">${startLine + index}</span><span class="tool-read-text">${esc(line || ' ')}</span></div>`)
    .join('')
  const notes = [
    view.truncatedByBytes ? '达到 50 KB 输出上限' : '',
    view.longLines > 0 ? `${formatCount(view.longLines)} 行超长已截断` : '',
    view.previewLines >= 20 && endLine - startLine + 1 > 20 ? '仅显示前 20 行' : '',
  ].filter(Boolean)
  const next = view.nextOffset ? `<span class="tool-read-next">继续读取：offset=${formatCount(view.nextOffset)}</span>` : ''
  return `<div class="tool-read" role="group" aria-label="按行读取：${esc(view.path)} ${esc(rangeText)}">
    <div class="tool-read-head">
      <span class="tool-read-kicker">按行读取</span>
      <strong class="tool-read-path">${esc(view.path)}</strong>
      <span class="tool-read-range">${esc(rangeText)}</span>
    </div>
    ${rows ? `<div class="tool-read-body">${rows}</div>` : '<div class="tool-read-empty">文件为空</div>'}
    <div class="tool-read-foot">
      <span>${esc(fmtSize(view.size))}</span>
      ${notes.length > 0 ? `<span>${esc(notes.join('，'))}</span>` : ''}
      ${next}
    </div>
  </div>`
}

function toolSearchCardHtml(trace) {
  const view = trace?.view && trace.view.kind === 'search' ? trace.view : null
  if (!view) return ''
  const matches = Array.isArray(view.matches) ? view.matches : []
  const groups = []
  for (const match of matches) {
    const path = String(match.path || '')
    let group = groups.at(-1)
    if (!group || group.path !== path) {
      group = { path, matches: [] }
      groups.push(group)
    }
    group.matches.push(match)
  }
  const rows = groups.map((group) => `<div class="tool-search-file">
    <div class="tool-search-filehead">
      <span class="tool-search-path">${esc(group.path)}</span>
      <em class="tool-search-filecount">${formatCount(group.matches.length)} 处</em>
    </div>
    ${group.matches.map((match) => `<div class="tool-search-line">
      <span class="tool-search-loc">${formatCount(match.line)}:${formatCount(match.column)}</span>
      <span class="tool-search-text">${esc(match.text || ' ')}</span>
    </div>`).join('')}
  </div>`).join('')
  const countText = view.total > view.count
    ? `显示 ${formatCount(view.count)} 条 / 共 ${formatCount(view.total)} 处命中`
    : `${formatCount(view.total)} 处命中`
  const notes = [
    view.path ? `范围 ${view.path}` : '整个工作区',
    `扫描 ${formatCount(view.filesScanned)} 个文件`,
    view.timeLimitHit ? '达到 30 秒搜索预算' : '',
  ].filter(Boolean)
  return `<div class="tool-search" role="group" aria-label="搜索：${esc(view.query)} ${esc(countText)}">
    <div class="tool-search-head">
      <span class="tool-search-kicker">搜索</span>
      <strong class="tool-search-query">“${esc(view.query)}”</strong>
      <span class="tool-search-count">${esc(countText)}${view.truncated ? '（已截断）' : ''}</span>
    </div>
    ${rows ? `<div class="tool-search-body">${rows}</div>` : '<div class="tool-search-empty">没有命中</div>'}
    <div class="tool-search-foot">${esc(notes.join(' · '))}${view.total > matches.length ? ` · 仅展示前 ${matches.length} 条` : ''}</div>
  </div>`
}

function toolPluginCardHtml(trace) {
  const view = trace?.view && trace.view.kind === 'plugin' ? trace.view : null
  if (!view || !view.previewPath) return ''
  let preview = String(view.previewPath)
  if (currentAs()) {
    const url = new URL(preview, location.origin)
    url.searchParams.set('as', currentAs())
    preview = url.pathname + url.search
  }
  const meta = [
    view.pluginId,
    view.version ? `v${view.version}` : '',
    view.checksum ? `指纹 ${view.checksum}` : '',
    view.pageCount > 0 ? `${formatCount(view.pageCount)} 个页面` : '',
  ].filter(Boolean).join(' · ')
  return `<div class="tool-plugin" role="group" aria-label="自开发插件 ${esc(view.title || view.pluginId)}">
    <div class="tool-plugin-head">
      <span class="tool-plugin-badge">自开发插件 · 已热安装</span>
      <strong class="tool-plugin-title">${esc(view.title || view.pluginId)}</strong>
      <span class="tool-plugin-meta">${esc(meta)}</span>
    </div>
    ${view.directory ? `<div class="tool-plugin-src">源码 ${esc(view.directory)}</div>` : ''}
    <iframe class="tool-plugin-frame" src="${esc(preview)}" title="${esc(view.title || view.pluginId)} 预览" loading="lazy"></iframe>
    <div class="tool-plugin-foot">
      <span>改完 client.js 再 install，页面会在 2 秒内自动刷新。</span>
      <a href="${esc(preview)}" target="_blank" rel="noopener">新窗口打开</a>
    </div>
  </div>`
}

function toolSkillCardHtml(trace) {  const view = trace?.view && trace.view.kind === 'skill' ? trace.view : null
  if (!view || !view.previewPath) return ''
  let preview = String(view.previewPath)
  if (currentAs()) {
    const url = new URL(preview, location.origin)
    url.searchParams.set('as', currentAs())
    preview = url.pathname + url.search
  }
  const meta = [
    view.skillId,
    view.version ? `v${view.version}` : '',
    view.checksum ? `指纹 ${view.checksum}` : '',
    view.level ? view.level : '',
    view.risk ? SKILL_RISK_LABEL[view.risk] || view.risk : '',
    view.triggerCount > 0 ? `${formatCount(view.triggerCount)} 个触发词` : '',
  ].filter(Boolean).join(' · ')
  const instructions = String(view.instructionPreview || '').trim()
  return `<div class="tool-skill" role="group" aria-label="自开发技能 ${esc(view.title || view.skillId)}">
    <div class="tool-skill-head">
      <span class="tool-skill-badge">自开发技能 · 已热安装</span>
      <strong class="tool-skill-title">${esc(view.title || view.skillId)}</strong>
      <span class="tool-skill-meta">${esc(meta)}</span>
    </div>
    ${view.directory ? `<div class="tool-skill-src">源码 ${esc(view.directory)}</div>` : ''}
    ${
      instructions
        ? `<div class="tool-skill-body"><div class="tool-skill-body-head">SKILL.md 预览</div><pre class="tool-skill-doc">${esc(instructions)}</pre></div>`
        : ''
    }
    <div class="tool-skill-foot">
      <span>改完 SKILL.md 再 install，下一轮对话立即加载新版本。</span>
      <a href="${esc(preview)}" target="_blank" rel="noopener">打开技能工作台</a>
    </div>
  </div>`
}

function toolBrowserCardHtml(trace) {
  const view = trace?.view && trace.view.kind === 'browser' ? trace.view : null
  if (!view) return ''
  const actionLabel = BROWSER_ACTION_LABEL[view.action] || '浏览网页'
  const target = String(view.title || view.url || '').trim()
  const url = String(view.url || '').trim()
  const preview = view.screenshot?.fileId
    ? `/api/workspace/files/${encodeURIComponent(view.screenshot.fileId)}/preview${qs()}`
    : ''
  const shot = preview
    ? `<a class="tool-browser-shot" href="${esc(preview)}" target="_blank" rel="noopener">
        <img src="${esc(preview)}" alt="${esc(view.screenshot?.name || '网页截图')}" loading="lazy">
      </a>`
    : ''
  const text = String(view.textPreview || '').trim()
  const meta = [
    `${formatCount(view.elementCount || 0)} 个可操作元素`,
    view.pageId ? `页面 ${view.pageId}` : '',
  ].filter(Boolean).join(' · ')
  return `<div class="tool-browser" role="group" aria-label="${esc(actionLabel)} ${esc(target)}">
    <div class="tool-browser-head">
      <span class="tool-browser-badge">内置浏览器 · ${esc(actionLabel)}</span>
      <strong class="tool-browser-title">${esc(target || '网页')}</strong>
    </div>
    ${url ? `<a class="tool-browser-url" href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>` : ''}
    ${shot}
    ${text ? `<pre class="tool-browser-text">${esc(text)}</pre>` : preview || view.action === 'close' ? '' : '<div class="tool-browser-empty">当前页面没有可读正文，可直接看截图。</div>'}
    <div class="tool-browser-foot"><span>${esc(meta)}</span>${preview ? '<span>截图已保存到个人云空间</span>' : ''}</div>
  </div>`
}

function toolDetailHtml(trace) {
  const diffHtml = toolDiffHtml(trace.diff)
  const result = parseToolSummaryObject(trace) || {}
  const batchSource =
    String(result.path || trace.args?.path || result.query || result.batchId || '').trim() ||
    toolDisplayName(trace.name)
  const batchHtml = batchCardHtml(trace.batch, { name: batchSource })
  const readHtml = trace.status === 'error' ? '' : toolReadCardHtml(trace)
  const searchHtml = trace.status === 'error' ? '' : toolSearchCardHtml(trace)
  const browserHtml = trace.status === 'error' ? '' : toolBrowserCardHtml(trace)
  const fileOpHtml = trace.status === 'error' ? '' : (!readHtml && !searchHtml ? fileOperationCardHtml(trace) : '')
  const pluginHtml = trace.status === 'error' ? '' : toolPluginCardHtml(trace)
  const skillHtml = trace.status === 'error' ? '' : toolSkillCardHtml(trace)
  const rawHtml = `<div class="tool-row"><span>参数</span><pre>${esc(prettyPayload(trace.args))}</pre></div>
    ${
      trace.summary
        ? `<div class="tool-row"><span>${trace.status === 'error' ? '错误' : '结果'}</span><pre>${esc(prettyPayload(trace.summary))}</pre></div>`
        : ''
    }`
  const structuredHtml = readHtml || searchHtml || browserHtml || fileOpHtml
  const primaryHtml = diffHtml || pluginHtml || skillHtml || structuredHtml || batchHtml || rawHtml
  return `<div class="tool-detail ${trace.status === 'error' ? 'is-error' : ''}" data-tool-detail="${esc(trace.id)}">
    <div class="tool-detail-head">
      <strong>${esc(toolDisplayName(trace.name))}</strong>
      <span class="tool-detail-status">${esc(toolStatusText(trace))}</span>
    </div>
    ${primaryHtml}
    ${(diffHtml || structuredHtml) && batchHtml ? batchHtml : ''}
  </div>`
}

/** 工具面板和思考入口一样只占一行：优先给当前工具，完成后给数量/总耗时/失败数。 */
function toolPanelPreview(tools, active) {
  if (!Array.isArray(tools) || tools.length === 0) return ''
  const running = tools.find((tool) => tool.status === 'running')
  if (active) {
    const current = running || tools.at(-1)
    return current ? `${toolDisplayName(current.name)} · 执行中` : ''
  }
  const failed = tools.filter((tool) => tool.status === 'error').length
  if (tools.length === 1) {
    const only = tools[0]
    const label = toolInlineLabel(only)
    return `${label}${only.status === 'error' ? ' · 失败' : ''}${only.durationMs > 0 ? ` · ${formatElapsed(only.durationMs)}` : ''}`
  }
  const totalMs = tools.reduce((sum, tool) => sum + (Number(tool.durationMs) || 0), 0)
  const labels = tools.map((tool) => toolInlineLabel(tool)).filter(Boolean)
  const sequence =
    labels.length <= 2
      ? labels.join(' → ')
      : `${labels[0]} → … → ${labels[labels.length - 1]}`
  return `${sequence}${tools.length > 2 ? ` · ${tools.length} 个` : ''}${failed > 0 ? ` · ${failed} 个失败` : ''}${totalMs > 0 ? ` · ${formatElapsed(totalMs)}` : ''}`
}

/* ---------------- Agent 文件操作预览 ---------------- */

const FILE_OPERATION_TOOLS = new Set([
  'workspace.write',
  'workspace.edit',
  'office.replace',
  'office.insert',
  'office.format',
  'office.comment',
  'workspace.read',
  'workspace.rename',
  'workspace.delete',
  'workspace.send_dingtalk',
])

const OFFICE_OPERATION_KINDS = {
  'office.replace': 'edit',
  'office.insert': 'insert',
  'office.format': 'format',
  'office.comment': 'comment',
}

const FILE_OPERATION_COPY = {
  write: { action: '写入文件', running: '正在写入', done: '已保存', error: '写入失败' },
  edit: { action: '局部修改文件', running: '正在修改', done: '已修改', error: '修改失败' },
  insert: { action: '插入文档内容', running: '正在插入', done: '已插入', error: '插入失败' },
  format: { action: '设置文档格式', running: '正在设置格式', done: '已设置格式', error: '设置格式失败' },
  comment: { action: '添加文档批注', running: '正在添加批注', done: '已添加批注', error: '添加批注失败' },
  read: { action: '读取文件', running: '正在读取', done: '已读取', error: '读取失败' },
  rename: { action: '重命名文件', running: '正在重命名', done: '已重命名', error: '重命名失败' },
  delete: { action: '删除文件', running: '正在删除', done: '已删除', error: '删除失败' },
  send: { action: '发送文件', running: '正在发送', done: '已发送', error: '发送失败' },
}

function parseToolSummaryObject(trace) {
  const raw = String(trace?.summary || '').trim()
  if (!raw.startsWith('{')) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    // 摘要超过服务端 1200 字上限时会被截断；至少把 fileId 取出来，预览按钮仍可用。
    const fileId = raw.match(/"fileId"\s*:\s*"([^"]+)"/)?.[1]
    return fileId ? { fileId } : null
  }
}

function baseFileName(path) {
  const value = String(path || '').trim()
  if (!value) return ''
  return value.split(/[\\/]/).pop() || value
}

function fileBadgeLabel(name) {
  const ext = String(name || '').split('.').pop()?.toLowerCase() || ''
  if (['doc', 'docx', 'docm', 'rtf', 'odt'].includes(ext)) return { label: 'DOC', tone: 'doc' }
  if (['xls', 'xlsx', 'xlsm', 'csv', 'ods'].includes(ext)) return { label: 'XLS', tone: 'sheet' }
  if (['ppt', 'pptx', 'pptm', 'odp'].includes(ext)) return { label: 'PPT', tone: 'slide' }
  if (ext === 'pdf') return { label: 'PDF', tone: 'pdf' }
  if (['md', 'markdown'].includes(ext)) return { label: 'MD', tone: 'text' }
  if (['txt', 'log', 'json', 'yml', 'yaml'].includes(ext)) return { label: 'TXT', tone: 'text' }
  return { label: 'FILE', tone: 'file' }
}

function isOfficeFileName(name) {
  return /\.(?:doc|docx|docm|xls|xlsx|xlsm|ppt|pptx|pptm|odt|ods|odp)(?:$)/i.test(String(name || ''))
}

/**
 * 从尚未闭合的 JSON 参数里取出字符串字段。
 * 模型流式生成 tool_call.arguments 时，text 往往只有开头一半；
 * 不能直接 JSON.parse，所以逐字符解析并处理 \"、\n、\uXXXX。
 */
function partialJsonStringField(raw, key) {
  const source = String(raw || '')
  const marker = `"${key}"`
  let searchFrom = 0
  while (searchFrom < source.length) {
    const keyAt = source.indexOf(marker, searchFrom)
    if (keyAt < 0) return ''
    let i = keyAt + marker.length
    while (i < source.length && /\s/.test(source[i])) i += 1
    if (source[i] !== ':') {
      searchFrom = keyAt + marker.length
      continue
    }
    i += 1
    while (i < source.length && /\s/.test(source[i])) i += 1
    if (source[i] !== '"') return ''
    i += 1
    let result = ''
    while (i < source.length) {
      const char = source[i]
      if (char === '"') return result
      if (char !== '\\') {
        result += char
        i += 1
        continue
      }
      const next = source[i + 1]
      if (next === undefined) return result
      if (next === 'n') {
        result += '\n'
        i += 2
        continue
      }
      if (next === 'r') {
        result += '\r'
        i += 2
        continue
      }
      if (next === 't') {
        result += '\t'
        i += 2
        continue
      }
      if (next === 'b') {
        result += '\b'
        i += 2
        continue
      }
      if (next === 'f') {
        result += '\f'
        i += 2
        continue
      }
      if (next === 'u') {
        const hex = source.slice(i + 2, i + 6)
        if (!/^[0-9a-f]{4}$/i.test(hex)) return result
        result += String.fromCharCode(parseInt(hex, 16))
        i += 6
        continue
      }
      result += next
      i += 2
    }
    return result
  }
  return ''
}

function partialWorkspaceWriteArgs(raw) {
  return {
    path: partialJsonStringField(raw, 'path') || partialJsonStringField(raw, 'relPath'),
    text:
      partialJsonStringField(raw, 'text') ||
      partialJsonStringField(raw, 'content') ||
      partialJsonStringField(raw, 'body') ||
      partialJsonStringField(raw, 'data'),
  }
}

function isWorkspaceWriteToolName(name) {
  return /workspace[._]write/i.test(String(name || ''))
}

function isOfficeReplaceToolName(name) {
  return /office[._]replace/i.test(String(name || ''))
}

function isOfficeInsertToolName(name) {
  return /office[._]insert/i.test(String(name || ''))
}

function partialOfficeReplaceArgs(raw) {
  return {
    path: partialJsonStringField(raw, 'path') || partialJsonStringField(raw, 'relPath'),
    fileId: partialJsonStringField(raw, 'fileId'),
    elementId: partialJsonStringField(raw, 'elementId'),
    newText: partialJsonStringField(raw, 'newText') || partialJsonStringField(raw, 'text'),
  }
}

function partialOfficeInsertArgs(raw) {
  return {
    path: partialJsonStringField(raw, 'path') || partialJsonStringField(raw, 'relPath'),
    fileId: partialJsonStringField(raw, 'fileId'),
    elementId: partialJsonStringField(raw, 'elementId'),
    text: partialJsonStringField(raw, 'text'),
  }
}

/** Office 局部编辑的流式预览：只展示当前目标元素的新文本，文件仍在工具完成后原子保存。 */
function applyStreamingOfficePreview(fileId, path, elementId, text) {
  const file = state.filePreview
  if (!file) return
  const idMatch = Boolean(fileId && String(file.id || '') === String(fileId))
  if (!idMatch && !filePreviewMatchesPath(file, path)) return
  const targetPath = path && filePreviewMatchesPath(file, path) ? path : file.relPath
  const prefix = elementId ? `编辑 ${elementId}\n` : ''
  applyStreamingFilePreview(targetPath || file.relPath, `${prefix}${String(text || '')}`)
}

function filePreviewMatchesPath(file, path) {
  if (!file) return false
  const target = String(path || '').trim()
  if (!target) return false
  const targetName = baseFileName(target)
  return Boolean(
    target === file.relPath ||
      target === file.name ||
      targetName === file.name ||
      targetName === baseFileName(file.relPath || ''),
  )
}

function streamingMarkdownNode() {
  const body = $('#file-pane-body')
  if (!body || body.hidden) return null
  const existing = body.querySelector('.file-markdown-view')
  if (existing) return existing
  // 已有等宽文本预览（例如非 Markdown 文件）时不替换宿主。
  if (body.querySelector('#onlyoffice-editor, iframe, img, pre.file-text-view')) return null
  const view = document.createElement('div')
  view.className = 'file-markdown-view'
  body.innerHTML = ''
  body.appendChild(view)
  return view
}

function scheduleMarkdownPreviewRender(view, text, body) {
  const stickToBottom = body ? body.scrollHeight - body.scrollTop - body.clientHeight < 80 : true
  if (workspaceMarkdownRenderTimer) {
    window.clearTimeout(workspaceMarkdownRenderTimer)
    workspaceMarkdownRenderTimer = 0
  }
  // 工具参数会高频到达；Markdown 需要整篇重排，合并到 ~20fps 避免每个字符都重排。
  workspaceMarkdownRenderTimer = window.setTimeout(() => {
    workspaceMarkdownRenderTimer = 0
    if (!view.isConnected) return
    const atBottom = body ? body.scrollHeight - body.scrollTop - body.clientHeight < 80 : false
    view.innerHTML = markdownPreviewHtml(text)
    if (body && (stickToBottom || atBottom)) body.scrollTop = body.scrollHeight
  }, 50)
}

function streamingPreviewNode() {
  const body = $('#file-pane-body')
  if (!body || body.hidden) return null
  const existing = body.querySelector('pre.file-text-view')
  if (existing) return existing
  // OnlyOffice / PDF / 图片预览时不替换宿主，避免把编辑器或 iframe 拆掉。
  if (body.querySelector('#onlyoffice-editor, iframe, img')) return null
  const pre = document.createElement('pre')
  pre.className = 'file-text-view'
  body.innerHTML = ''
  body.appendChild(pre)
  return pre
}

/** 把模型生成中的文本写入右侧文本预览；文件本身等 tool 完成后再原子落盘。 */
function applyStreamingFilePreview(path, text) {
  const file = state.filePreview
  if (!file || !filePreviewMatchesPath(file, path)) return
  const draft = {
    fileId: file.id,
    path: String(path || ''),
    text: String(text || ''),
    updatedAt: Date.now(),
    office: isOfficeLike(file),
  }
  fileStreamDraft = draft
  if (draft.office) {
    const body = $('#file-pane-body')
    if (!body || body.hidden) return
    let overlay = body.querySelector('.file-stream-draft')
    if (!overlay) {
      overlay = document.createElement('div')
      overlay.className = 'file-stream-draft'
      overlay.innerHTML = '<div class="file-stream-draft-head"><span class="file-stream-draft-dot"></span>Agent 正在生成 Office 文档内容 · 完成后由 OnlyOffice 刷新</div><pre></pre>'
      body.appendChild(overlay)
    }
    const pre = overlay.querySelector('pre')
    if (pre) revealPreviewText(pre, draft.text, body)
    body.scrollTop = body.scrollHeight
    return
  }
  if (!isTextLike(file)) return
  if (isMarkdownLike(file)) {
    const view = streamingMarkdownNode()
    if (!view) return
    view.classList.add('is-streaming')
    const body = $('#file-pane-body')
    scheduleMarkdownPreviewRender(view, draft.text, body)
    workspacePreviewText = draft.text
    workspacePreviewTextLoaded = true
    return
  }
  const pre = streamingPreviewNode()
  if (!pre) return
  const body = $('#file-pane-body')
  revealPreviewText(pre, draft.text, body)
  workspacePreviewText = draft.text
  workspacePreviewTextLoaded = true
}

/**
 * 模型工具参数若一次整块到达，直接整段替换会看不到过程；
 * 这里按字符揭示到完整文本，后续真实增量仍会继续续写。
 */
function revealPreviewText(el, text, body) {
  const full = String(text || '')
  const isText = el.classList.contains('file-text-view')
  el.classList.add('is-streaming')
  if (!full) {
    el.textContent = isText ? '（空文件）' : ''
    return
  }
  const same = fileStreamReveal && fileStreamReveal.el === el
  const previousFull = fileStreamReveal?.fullText || ''
  let shown = 0
  let startedAt = performance.now()
  if (same && full.startsWith(previousFull) && previousFull) {
    shown = fileStreamReveal.shown
    startedAt = performance.now() - (shown / Math.max(1, full.length)) * fileStreamReveal.duration
  }
  if (same) {
    fileStreamReveal.fullText = full
  } else {
    fileStreamReveal = {
      el,
      fullText: full,
      shown,
      startedAt,
      duration: Math.min(1600, Math.max(450, full.length * 1.2)),
      onDone: null,
    }
  }
  el.textContent = full.slice(0, shown)
  const nearBottom = body ? body.scrollHeight - body.scrollTop - body.clientHeight < 80 : true
  const tick = () => {
    const state = fileStreamReveal
    if (!state || state.el !== el) return
    const target = state.fullText
    const elapsed = performance.now() - state.startedAt
    const count = Math.max(
      state.shown,
      Math.min(target.length, Math.floor((target.length * elapsed) / state.duration)),
    )
    state.shown = count
    el.textContent = target.slice(0, count)
    if (body && nearBottom) body.scrollTop = body.scrollHeight
    if (count < target.length) {
      setTimeout(tick, 16)
      return
    }
    fileStreamReveal = null
    const onDone = state.onDone
    if (onDone) {
      clearStreamingPreviewArtifacts()
      onDone()
    }
  }
  setTimeout(tick, 16)
}

function clearStreamingPreviewArtifacts() {
  if (workspaceMarkdownRenderTimer) {
    window.clearTimeout(workspaceMarkdownRenderTimer)
    workspaceMarkdownRenderTimer = 0
  }
  const body = $('#file-pane-body')
  if (!body) return
  body.querySelector('.file-stream-draft')?.remove()
  body.querySelector('pre.file-text-view.is-streaming')?.classList.remove('is-streaming')
  body.querySelector('.file-markdown-view.is-streaming')?.classList.remove('is-streaming')
  fileStreamReveal = null
}

function finishStreamingFilePreview(onDone) {
  const draft = fileStreamDraft
  fileStreamDraft = null
  if (onDone && fileStreamReveal) {
    fileStreamReveal.onDone = onDone
    return
  }
  if (!draft && !fileStreamReveal) {
    onDone?.()
    return
  }
  // 生成完成后用完整草稿做最终 Markdown 排版，避免停在未闭合语法或半段内容。
  if (draft && state.filePreview && isMarkdownLike(state.filePreview)) {
    const view = $('#file-pane-body')?.querySelector('.file-markdown-view')
    if (view) {
      view.innerHTML = markdownPreviewHtml(draft.text)
      view.classList.remove('is-streaming')
    }
  }
  clearStreamingPreviewArtifacts()
  onDone?.()
}

/** 把工作区工具轨迹转成文件操作卡片所需的最小信息，不把原始参数直接铺在对话里。 */
function fileOperationInfo(trace) {
  if (!trace || !FILE_OPERATION_TOOLS.has(String(trace.toolId || ''))) return null
  const kind = OFFICE_OPERATION_KINDS[trace.toolId] || String(trace.toolId).slice('workspace.'.length)
  const copy = FILE_OPERATION_COPY[kind]
  if (!copy) return null
  const args = trace.args && typeof trace.args === 'object' ? trace.args : {}
  const summary = parseToolSummaryObject(trace) || {}
  const view = trace.view && typeof trace.view === 'object' ? trace.view : null
  const rawPath = String(args.path || '').trim()
  const summaryPath = String(summary.path || summary.relPath || '').trim()
  const targetPath = kind === 'rename'
    ? String(summary.to || args.newName || rawPath).trim()
    : (summaryPath || rawPath)
  const fallbackName = String(summary.fileName || summary.name || '').trim()
  const name = baseFileName(targetPath) || fallbackName || (kind === 'send' ? '云空间文件' : '文件')
  // 发送到钉钉的结果里 fileId 是钉钉侧文件 ID，不是云空间 ID；发送卡用 relPath 定位。
  const fileId = kind === 'send' ? '' : String(summary.fileId || args.fileId || '').trim()
  const text = kind === 'write'
    ? String(args.text ?? '')
    : (kind === 'read' ? String(view?.previewText ?? summary.text ?? '') : (
      kind === 'edit' ? String(args.newText ?? summary.nextText ?? '') : (
        kind === 'insert' ? String(args.text ?? (Array.isArray(summary.insertedValues) ? summary.insertedValues.join(' ') : '') ?? '') : ''
      )
    ))
  const previewPath = fileId && state.filePreview && String(state.filePreview.id || '') === fileId
    ? String(state.filePreview.relPath || '')
    : ''
  const edits = kind === 'edit' && Array.isArray(args.edits) ? args.edits : []
  const changes = kind === 'edit'
    ? Number(summary.changes ?? summary.replacements ?? edits.length) || 0
    : 0
  const created = summary.created === true
  const from = String(summary.from || rawPath || '').trim()
  const to = String(summary.to || args.newName || targetPath || '').trim()
  return {
    kind,
    copy,
    path: targetPath || from || previewPath,
    name,
    fileId,
    text,
    edits,
    changes,
    created,
    from,
    to,
    startLine: view?.kind === 'read' ? Math.max(1, Number(view.startLine) || 1) : 0,
    endLine: view?.kind === 'read' ? Math.max(0, Number(view.endLine) || 0) : 0,
    totalLines: view?.kind === 'read' ? Math.max(0, Number(view.totalLines) || 0) : 0,
    truncatedByBytes: view?.kind === 'read' && view.truncatedByBytes === true,
    nextOffset: view?.kind === 'read' && view.nextOffset ? Math.max(1, Number(view.nextOffset) || 1) : 0,
    status: trace.status === 'running' ? 'running' : trace.status === 'error' ? 'error' : 'done',
    statusLabel: trace.status === 'running'
      ? copy.running
      : trace.status === 'error' ? copy.error : copy.done,
    durationMs: Number(trace.durationMs) || 0,
    errorText: trace.status === 'error' ? String(trace.summary || '').trim() : '',
  }
}

function fileOperationPreviewHtml(op) {
  if (op.kind === 'rename') {
    if (!op.from && !op.to) return ''
    return `<div class="file-op-change">
      <span class="file-op-change-label">名称变更</span>
      <span class="file-op-change-value is-old">${esc(op.from || '—')}</span>
      <span class="file-op-change-arrow">→</span>
      <span class="file-op-change-value is-new">${esc(op.to || '—')}</span>
    </div>`
  }
  if (op.kind === 'delete') {
    return `<div class="file-op-note">文件已从云空间列表移除，移到回收目录保留审计。</div>`
  }
  if (op.kind === 'edit') {
    if (op.status === 'running') {
      return '<div class="file-op-note is-live"><span class="file-op-loading-dot"></span>Agent 正在定位并修改指定片段…</div>'
    }
    return `<div class="file-op-note">只修改了 ${op.changes || 0} 处片段，其余内容保持不变。</div>`
  }
  if (op.kind === 'insert' || op.kind === 'format' || op.kind === 'comment') {
    if (op.status === 'running') {
      return '<div class="file-op-note is-live"><span class="file-op-loading-dot"></span>Agent 正在写入目标元素…</div>'
    }
    if (op.status === 'error') return '<div class="file-op-note">没有写入文件，原始内容保持不变。</div>'
    const doneText = op.kind === 'insert'
      ? '已在目标位置插入新内容，其他元素未整体重写。'
      : op.kind === 'format'
        ? '已按目标元素设置字符格式，其他段落和表格结构未改动。'
        : '已给目标元素添加批注，原文未修改。'
    return `<div class="file-op-note">${doneText}</div>`
  }
  if (op.kind === 'write' || op.kind === 'read') {
    const raw = String(op.text || '')
    if (!raw) {
      return op.status === 'running'
        ? '<div class="file-op-note is-live"><span class="file-op-loading-dot"></span>Agent 正在生成内容…</div>'
        : '<div class="file-op-note">空文件</div>'
    }
    const lines = raw.split(/\r?\n/)
    const shown = lines.slice(0, 14).join('\n')
    const omitted = lines.length > 14 || raw.length > 1800
    const size = typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(raw).length : raw.length
    const officeWarning = op.kind === 'write' && isOfficeFileName(op.name)
      ? '<div class="file-op-note is-warning">Agent 当前只能写入文本内容；Word / Excel / PPT 的内容级编辑请在右侧用 OnlyOffice 完成。</div>'
      : ''
    const rangeText = op.kind === 'read' && op.totalLines
      ? `第 ${op.startLine}–${op.endLine} 行 / 共 ${op.totalLines} 行`
      : `${lines.length} 行`
    const omittedText = op.kind === 'read' && op.truncatedByBytes
      ? ' · 达到 50 KB 输出上限'
      : omitted ? ' · 仅显示开头' : ''
    return `${officeWarning}<div class="file-op-preview">
      <div class="file-op-preview-head">
        <span>${op.kind === 'write' ? 'Agent 写入内容' : '读取内容'}</span>
        <span>${rangeText} · ${esc(fmtSize(op.totalLines && op.kind === 'read' ? op.size || size : size))}${omittedText}</span>
      </div>
      <pre>${esc(shown)}${omitted ? '\n…' : ''}</pre>
    </div>`
  }
  return ''
}

function fileOperationCardHtml(trace) {
  const op = fileOperationInfo(trace)
  if (!op) return ''
  const badge = fileBadgeLabel(op.name)
  const canOpen = op.status !== 'running' && op.kind !== 'delete' && Boolean(op.fileId || op.path)
  const duration = op.status === 'done' && op.durationMs > 0 ? ` · ${formatElapsed(op.durationMs)}` : ''
  const actionText = op.kind === 'write'
    ? (op.created ? '新建文件' : op.status === 'done' ? '修改文件' : '写入文件')
    : op.copy.action
  return `<div class="file-op-card is-${op.status} is-${op.kind}" data-file-op-kind="${op.kind}">
    <div class="file-op-head">
      <span class="file-op-badge is-${badge.tone}">${badge.label}</span>
      <div class="file-op-main">
        <span class="file-op-kicker">Agent 文件操作</span>
        <strong>${esc(op.name)}</strong>
        <span class="file-op-sub">${esc(actionText)}${duration}</span>
      </div>
      <span class="file-op-state"><span class="file-op-dot"></span>${esc(op.statusLabel)}</span>
    </div>
    ${fileOperationPreviewHtml(op)}
    <div class="file-op-foot">
      <span class="file-op-path" title="${esc(op.path || op.name)}">${esc(op.path || op.name)}</span>
      ${op.status === 'error' ? `<span class="file-op-error">${esc(oneLinePreview(op.errorText, 60))}</span>` : ''}
      ${canOpen ? `<button class="file-op-open" type="button" data-file-op-open="${esc(op.fileId)}" data-file-op-path="${esc(op.path)}">在右侧预览</button>` : ''}
    </div>
  </div>`
}

function fileOpsPanelHtml(tools) {
  const cards = (Array.isArray(tools) ? tools : [])
    .map((trace) => fileOperationCardHtml(trace))
    .filter(Boolean)
  if (cards.length === 0) return ''
  return `<div class="file-op-stack">${cards.slice(-4).join('')}</div>`
}

async function openFileOperationPreview(button) {
  if (!button || button.disabled) return
  setWorkbenchCollapsed(false)
  let fileId = String(button.dataset.fileOpOpen || '').trim()
  const path = String(button.dataset.fileOpPath || '').trim()
  button.disabled = true
  try {
    if (!fileId || !state.files.some((file) => file.id === fileId)) await loadWorkspaceFiles()
    if (fileId && !state.files.some((file) => file.id === fileId)) fileId = ''
    if (!fileId && path) {
      const match = state.files.find((file) => file.relPath === path || file.name === path || baseFileName(file.relPath) === path)
      fileId = match?.id || ''
    }
    if (!fileId) {
      banner('文件列表还没有同步完成，请稍后再试。', 'bad')
      return
    }
    await openWorkspaceFile(fileId)
  } catch (err) {
    banner(`打开文件失败：${err.message}`, 'bad')
  } finally {
    button.disabled = false
  }
}

/**
 * 插件保存成功后，先把当前云端版本记为水位，再关闭旧编辑器并切回查看态。
 * 旧编辑器关闭时会再次触发 OnlyOffice 保存回调；refresh-guard 让旧 version 的回调
 * 被丢弃，避免同一份内容重复写回把 updated_at 再抬一次。
 */
function refreshWorkspaceAfterPluginSave(file, data) {
  void (async () => {
    try {
      await api(`/api/workspace/office/${encodeURIComponent(file.id)}/refresh-guard`, {
        method: 'POST',
      })
      await loadWorkspaceFiles()
      const latest = state.files.find((item) => item.id === file.id)
      if (!latest) {
        closeWorkspaceFile()
        banner('文件已不存在，无法刷新预览', 'bad')
        return
      }
      const updatedAt = Number(data.updatedAt) || latest.updatedAt
      const size = Number(data.size) || latest.size
      banner(
        `已保存《${latest.name}》到云空间（${workspaceFileDate(updatedAt)}，${fmtSize(size)}），已切换到查看态。`,
      )
      await openWorkspaceFile(latest.id, { mode: 'view' })
    } catch (err) {
      banner(`已保存成功，但刷新预览失败：${err.message}`, 'bad')
    }
  })()
}

function refreshWorkspaceAfterFileOperation(op) {
  if (!op || !['write', 'edit', 'insert', 'format', 'comment', 'rename', 'delete'].includes(op.kind)) return
  void (async () => {
    try {
      finishStreamingFilePreview()
      await loadWorkspaceFiles()
      const activeId = state.filePreview?.id
      if (op.kind === 'delete' && activeId && activeId === op.fileId) {
        closeWorkspaceFile()
        return
      }
      if (op.fileId && activeId && activeId === op.fileId) {
        if (onlyOfficeMode === 'edit') {
          const latest = state.files.find((file) => file.id === op.fileId)
          const cloudMeta = latest
            ? `（${workspaceFileDate(latest.updatedAt)}，${fmtSize(latest.size)}）`
            : ''
          showFilePaneSyncNotice(
            op.fileId,
            `文档已在云端更新${cloudMeta}。当前编辑器仍显示打开时的版本；未保存的修改不会自动合并。请先保存或撤销，再刷新到云端版本。`,
          )
          return
        }
        await openWorkspaceFile(op.fileId)
      }
    } catch {
      // 文件列表刷新失败不影响对话继续；下一次手动刷新会重新读取。
    }
  })()
}

function fileActivitySnippet(activity) {
  if (!activity) return ''
  if (activity.kind === 'rename') {
    return `${oneLinePreview(activity.from || '—', 70)} → ${oneLinePreview(activity.to || '—', 70)}`
  }
  if (activity.kind === 'delete') return '文件已移入回收目录，列表同步刷新中'
  if (activity.kind === 'edit' && activity.status !== 'error') {
    return `已局部修改 ${activity.changes || 0} 处片段，其余内容未变`
  }
  if (activity.status === 'error') return oneLinePreview(activity.errorText || '文件操作失败', 180)
  const text = String(activity.text || '')
  if (!text) {
    if (activity.status === 'running') return 'Agent 正在生成文件内容…'
    if (activity.status === 'done') return '操作已完成'
    return '等待文件操作'
  }
  const lines = text.split(/\r?\n/)
  const nonEmpty = lines.filter((line) => line.trim())
  const tail = nonEmpty.slice(-2).join('  /  ') || text
  return oneLinePreview(tail, 220)
}

function renderFileDock() {
  const dock = $('#file-dock')
  if (!dock) return
  const activity = state.fileActivity
  if (
    !activity ||
    state.fileDockClosed ||
    state.fileDockSettled ||
    state.fileDockPreviewSuppressed
  ) {
    dock.hidden = true
    dock.innerHTML = ''
    return
  }
  const badge = fileBadgeLabel(activity.name)
  const canOpen = activity.status !== 'running' && activity.kind !== 'delete' && Boolean(activity.fileId || activity.path)
  const lineCount = String(activity.text || '').split(/\r?\n/).length
  const size = String(activity.text || '')
    ? (typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(String(activity.text)).length : String(activity.text).length)
    : 0
  const duration = activity.status === 'done' && activity.durationMs > 0 ? ` · ${formatElapsed(activity.durationMs)}` : ''
  const actionText = activity.kind === 'write'
    ? (activity.created ? '新建文件' : activity.status === 'done' ? '修改文件' : '写入文件')
    : activity.copy?.action || '文件操作'
  const detail = activity.kind === 'write' || activity.kind === 'read'
    ? `${lineCount} 行${size ? ` · ${fmtSize(size)}` : ''}${duration}`
    : activity.kind === 'edit'
      ? `局部修改 ${activity.changes || 0} 处${duration}`
      : activity.kind === 'rename'
        ? `名称变更${duration}`
        : activity.kind === 'delete'
          ? '已删除'
          : `文件发送${duration}`
  dock.hidden = false
  dock.className = `file-dock is-${activity.status} is-${activity.kind}`
  dock.innerHTML = `<div class="file-dock-card" data-file-dock-open role="button" tabindex="0" title="打开文件预览">
    <span class="file-dock-badge is-${badge.tone}">${badge.label}</span>
    <div class="file-dock-main">
      <div class="file-dock-title-row">
        <strong>${esc(activity.name)}</strong>
        <span class="file-dock-status"><span class="file-dock-dot"></span>${esc(activity.statusLabel)}</span>
        <span class="file-dock-step">Agent 文件操作 · 第 ${activity.step || 1} 步</span>
      </div>
      <div class="file-dock-sub">${esc(actionText)}${activity.path ? ` · ${esc(activity.path)}` : ''}</div>
      <div class="file-dock-snippet">${esc(fileActivitySnippet(activity))}</div>
    </div>
    <div class="file-dock-actions">
      <span class="file-dock-detail">${esc(detail)}</span>
      ${canOpen ? '<button class="file-dock-open" type="button" data-file-dock-open>打开预览</button>' : `<span class="file-dock-wait">${activity.status === 'running' ? '完成后可预览' : ''}</span>`}
      <button class="file-dock-close" type="button" data-file-dock-close title="关闭文件操作卡片" aria-label="关闭文件操作卡片">×</button>
    </div>
    <span class="file-dock-progress"><span></span></span>
  </div>`
}

function settleFileDock() {
  if (!state.fileActivity) return
  state.fileDockSettled = true
  renderFileDock()
}

function suppressFileDockForPreview() {
  state.fileDockPreviewSuppressed = true
  renderFileDock()
}

function restoreFileDockAfterPreview() {
  if (!state.fileActivity) return
  state.fileDockPreviewSuppressed = false
  // 关闭预览时只恢复仍在执行的文件操作卡；已完成的卡片保持收起状态。
  if (!state.fileDockClosed && state.fileActivity.status === 'running') state.fileDockSettled = false
  renderFileDock()
}

function updateFileActivity(trace) {
  const op = fileOperationInfo(trace)
  if (!op) return
  const previous = state.fileActivity
  const traceId = String(trace?.id || '')
  const sameTrace = Boolean(previous && traceId && previous.traceId === traceId)
  const same = previous && (
    (op.fileId && previous.fileId === op.fileId) ||
    (op.path && previous.path === op.path) ||
    (!op.fileId && !op.path && previous.name === op.name)
  )
  state.fileActivity = {
    ...op,
    name: op.name || previous?.name || '文件',
    path: op.path || previous?.path || '',
    traceId,
    step: sameTrace ? previous.step : same ? Number(previous.step || 1) + 1 : 1,
    startedAt: same ? previous.startedAt : Date.now(),
    text: op.kind === 'delete' ? '' : (op.text || (same ? previous.text : '')),
    updatedAt: Date.now(),
  }
  state.fileDockClosed = false
  state.fileDockSettled = false
  renderFileDock()
}

function clearFileActivity() {
  state.fileActivity = null
  state.fileDockClosed = false
  state.fileDockSettled = false
  state.fileDockPreviewSuppressed = false
  renderFileDock()
}

async function openFileDockPreview() {
  setWorkbenchCollapsed(false)
  const activity = state.fileActivity
  if (!activity) return
  if (activity.status === 'running' && !activity.fileId) {
    banner('Agent 还在写入文件，完成后就能打开预览', 'warn')
    return
  }
  let fileId = String(activity.fileId || '').trim()
  const path = String(activity.path || '').trim()
  try {
    if (!fileId || !state.files.some((file) => file.id === fileId)) await loadWorkspaceFiles()
    if (fileId && !state.files.some((file) => file.id === fileId)) fileId = ''
    if (!fileId && path) {
      const match = state.files.find((file) => file.relPath === path || file.name === path || baseFileName(file.relPath) === path)
      fileId = match?.id || ''
    }
    if (!fileId) {
      banner('文件列表还没有同步完成，请稍后再试。', 'bad')
      return
    }
    await openWorkspaceFile(fileId, { split: true })
  } catch (err) {
    banner(`打开文件失败：${err.message}`, 'bad')
  }
}

document.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return
  const close = event.target.closest('[data-file-dock-close]')
  if (close) {
    event.preventDefault()
    event.stopPropagation()
    state.fileDockClosed = true
    renderFileDock()
    return
  }
  const open = event.target.closest('[data-file-dock-open]')
  if (!open) return
  event.preventDefault()
  event.stopPropagation()
  void openFileDockPreview()
})

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return
  if (!(event.target instanceof HTMLElement)) return
  const card = event.target.closest('.file-dock-card[data-file-dock-open]')
  if (!card || event.target.closest('button')) return
  event.preventDefault()
  void openFileDockPreview()
})

document.addEventListener('mouseup', (event) => {
  if (!(event.target instanceof Element) || !event.target.closest('#file-pane-body')) return
  // 等浏览器先完成 selection 更新，再显示“引用选中内容”。
  window.setTimeout(refreshPreviewSelection, 0)
})

document.addEventListener('keyup', (event) => {
  if (!(event.target instanceof Element) || !event.target.closest('#file-pane-body')) return
  window.setTimeout(refreshPreviewSelection, 0)
})

document.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return
  const button = event.target.closest('#file-selection-action')
  if (!button) return
  event.preventDefault()
  quotePreviewSelection()
})

/** 工具调用收成和思考一样的单行入口：默认只留 `工具 · 摘要`，展开了再看完整工具明细。 */
function toolPanelHtml(tools, { active = false, expanded = false } = {}) {
  const visibleTools = normalizeRecoveredToolCalls(tools)
  if (visibleTools.length === 0) return ''
  const preview = toolPanelPreview(visibleTools, active)
  const hasError = visibleTools.some((tool) => tool.status === 'error')
  const title = active ? '工具调用中' : '工具'
  return `<div class="tool-panel${active ? ' is-active' : ''}${hasError ? ' is-error' : ''}${expanded ? '' : ' is-collapsed'}" data-tool-panel>
    <button class="tool-head" type="button" data-tip="${expanded ? '收起这次工具调用的完整参数与结果' : '展开这次工具调用的完整参数与结果'}" aria-expanded="${expanded ? 'true' : 'false'}" aria-label="展开工具调用明细">
      <span class="tool-dot"></span>
      <span class="tool-title">${title}</span>
      <span class="tool-divider"${preview ? '' : ' hidden'}>·</span>
      <span class="tool-preview">${esc(preview)}</span>
      <span class="tool-chevron">⌄</span>
    </button>
    <div class="tool-body">${visibleTools.map((trace) => toolDetailHtml(trace)).join('')}</div>
  </div>`
}

/** 历史里的思考过程默认收起：DSH 风格单行摘要 + 可展开的完整思维链。 */
function thinkPanelHtml(reasoning) {
  const preview = firstLinePreview(reasoning, 96)
  return `<div class="think-panel is-collapsed">
    <button class="think-head" type="button" data-tip="展开这次回答的完整思考过程" aria-expanded="false" aria-label="展开思考过程">
      <span class="think-icon" aria-hidden="true">✦</span>
      <span class="think-title">思考</span>
      <span class="think-divider"${preview ? '' : ' hidden'}>·</span>
      <span class="think-preview">${esc(preview)}</span>
      <span class="think-chevron" aria-hidden="true">⌄</span>
    </button>
    <div class="think-body">${esc(reasoning)}</div>
  </div>`
}

function channelTag(channel) {
  if (channel === 'dingtalk') return '<span class="channel-tag" data-tip="来自钉钉渠道；这条对话和网页工作台共用同一份历史">钉钉</span>'
  return ''
}

function clarifyInlineNote() {
  return `<div class="clarify-inline-note"><span class="clarify-mark" aria-hidden="true">?</span><span>需要先确认方向，请选择或补充。</span></div>`
}

function historyMetaText(meta, text = '', rich = {}) {
  if (!meta && !rich) return ''
  if (typeof meta === 'number') return String(meta)
  const source = meta && typeof meta === 'object' ? meta : (rich && typeof rich === 'object' ? rich : {})
  const modelName = typeof meta === 'string' ? meta : source.modelName
  return [
    modelName,
    tokenSpeedText(source.tokens, source.timing, `${source.reasoning || ''}${text || ''}`),
    source.autoSelected ? '自动选择' : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

function historyAiBubble(text, meta, rich, options = {}) {
  const reasoning = String(rich?.reasoning || '').trim()
  const tools = normalizeRecoveredToolCalls(Array.isArray(rich?.toolCalls) ? rich.toolCalls : [])
  const channel = channelTag(rich?.channel)
  const clarify = rich?.clarify && typeof rich.clarify === 'object' ? rich.clarify : null
  const metaText = historyMetaText(meta, text, rich)
  const metaTip = [
    rich?.channel === 'dingtalk' ? '来自钉钉渠道，和网页工作台共用同一份历史' : '',
    metaText ? `这条回答使用的模型与生成速度：${metaText}` : '',
  ]
    .filter(Boolean)
    .join('；')
  const progressValue = rich?.teamProgress && typeof rich.teamProgress === 'object'
    ? rich.teamProgress
    : (rich?.progress && typeof rich.progress === 'object' ? rich.progress : null)
  const progressCard = progressValue ? teamProgressCardHtml(progressValue, progressValue.note || '') : ''
  const memoryCard = `${longTermMemorySourceHtml(rich?.longTermMemoryRecall)}${memorySourceHtml(rich?.memoryHits, rich?.memoryScope)}`
  const answerBody = clarify && options.pendingClarify
    ? clarifyInlineNote()
    : `<div class="answer-text">${renderAnswer(text, { omitCodeBlocks: writtenFileContentBlocks(tools) })}</div>`
  // 父消息同时有正文和进度卡时两份都要保留：进度卡紧跟在工具调用
  // 摘要下方、正文之前，先看子 Agent 进度，再读最终结论。
  const body = progressCard
    ? `${progressCard}${String(text || '').trim() ? answerBody : ''}`
    : answerBody
  return `${reasoning ? thinkPanelHtml(reasoning) : ''}
    ${tools.length > 0 ? toolPanelHtml(tools) : ''}
    ${memoryCard}
    ${body}
    ${metaText || channel ? `<span class="meta"${metaTip ? ` data-tip="${esc(metaTip)}"` : ''}>${channel}${metaText ? esc(metaText) : ''}</span>` : ''}`
}

function memoryStamp(value) {
  const date = value ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) return ''
  const pad = (number) => String(number).padStart(2, '0')
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 助手回复引用到的历史记忆来源；默认折叠，避免抢占正文阅读。 */
const LONG_TERM_MEMORY_TYPE_LABEL = { preference: '偏好', fact: '事实', decision: '决策', episode: '情景' }
const LONG_TERM_MEMORY_SCOPE_LABEL = { user: '个人', dept: '部门', company: '公司' }

/** 长期记忆召回来源：显示命中了哪几条、综合分和命中原因，方便用户判断 AI 为什么记得。 */
function longTermMemorySourceHtml(tracesInput) {
  const traces = Array.isArray(tracesInput)
    ? tracesInput.filter((trace) => trace && typeof trace === 'object' && String(trace.excerpt || '').trim()).slice(0, 4)
    : []
  if (traces.length === 0) return ''
  const items = traces.map((trace) => {
    const typeLabel = LONG_TERM_MEMORY_TYPE_LABEL[trace.memoryType] || '记忆'
    const scopeLabel = LONG_TERM_MEMORY_SCOPE_LABEL[trace.scopeType] || trace.scopeType || '个人'
    const reasons = Array.isArray(trace.reasons) ? trace.reasons.map((reason) => String(reason)).filter(Boolean).slice(0, 4) : []
    const score = typeof trace.score === 'number' ? trace.score.toFixed(2) : ''
    return `<div class="memory-item ltm-item">
      <span class="memory-item-title">${esc(typeLabel)} · ${esc(scopeLabel)}${
        trace.source === 'consolidated' ? ' · 情景合集' : ''
      }</span>
      ${score ? `<span class="memory-item-time">${esc(score)}</span>` : ''}
      <span class="memory-item-excerpt">${esc(String(trace.excerpt).slice(0, 100))}</span>
      ${reasons.length ? `<span class="ltm-reason">${esc(reasons.join(' · '))}</span>` : ''}
    </div>`
  }).join('')
  return `<div class="memory-panel memory-panel-longterm is-collapsed">
    <button class="memory-head" type="button" data-tip="展开长期记忆来源：看看这次回答记住了哪些偏好、事实或决策" aria-expanded="false" aria-label="展开长期记忆召回原因">
      <span class="memory-icon" aria-hidden="true">◎</span>
      <span class="memory-title">长期记忆</span>
      <span class="memory-divider">·</span>
      <span class="memory-summary">想起了 ${traces.length} 条</span>
      <span class="memory-chevron" aria-hidden="true">⌄</span>
    </button>
    <div class="memory-body">${items}</div>
  </div>`
}

function memorySourceHtml(hitsInput, scopeInput) {
  const hits = Array.isArray(hitsInput) ? hitsInput.filter((hit) => hit && typeof hit === 'object').slice(0, 5) : []
  if (hits.length === 0) return ''
  // 旧消息没有 memoryScope 时按“历史对话”展示；新消息明确 session 时才标为本会话。
  const scope = scopeInput === 'session' ? 'session' : 'history'
  const summary = scope === 'session'
    ? `参考了 ${hits.length} 段本会话记忆`
    : `参考了 ${hits.length} 段历史对话`
  const items = hits.map((hit) => {
    const title = String(hit.sessionTitle || '历史对话').trim() || '历史对话'
    const stamp = memoryStamp(hit.createdAt)
    const excerpt = String(hit.excerpt || '').trim()
    return `<div class="memory-item">
      <span class="memory-item-title">会话「${esc(title)}」</span>
      ${stamp ? `<span class="memory-item-time">${esc(stamp)}</span>` : ''}
      ${excerpt ? `<span class="memory-item-excerpt">${esc(excerpt)}</span>` : ''}
    </div>`
  }).join('')
  return `<div class="memory-panel is-collapsed">
    <button class="memory-head" type="button" data-tip="展开历史记忆来源：查看这次回答引用了哪些会话片段" aria-expanded="false" aria-label="展开历史记忆来源">
      <span class="memory-icon" aria-hidden="true">◈</span>
      <span class="memory-title">记忆</span>
      <span class="memory-divider">·</span>
      <span class="memory-summary">${summary}</span>
      <span class="memory-chevron" aria-hidden="true">⌄</span>
    </button>
    <div class="memory-body">${items}</div>
  </div>`
}

/** AI 没有足够方向时给出的结构化问题：单选、多选、填空或多题题组。 */
function clarifyPanelHtml(clarify, options = {}) {
  if (!clarify || typeof clarify !== 'object') return ''
  const questions = Array.isArray(clarify.questions) ? clarify.questions : []
  const total = questions.length > 1 ? questions.length : 0
  const index = total > 0
    ? Math.min(Math.max(0, Math.trunc(Number(clarify.index) || 0)), total - 1)
    : 0
  const current = total > 0 ? (questions[index] || {}) : clarify
  const kind = current.kind === 'multiple' || current.kind === 'text' ? current.kind : 'single'
  const question = String(current.question || '').trim()
  const intro = total > 0 && index > 0 ? '' : String(clarify.intro || '').trim()
  const optionsList = Array.isArray(current.options) ? current.options.slice(0, 4) : []
  if (!question) return ''
  if (kind !== 'text' && optionsList.length < 2) return ''
  const allowCustom = current.allowCustom !== false
  const placeholder = String(current.placeholder || (kind === 'text' ? '请输入你的答案…' : '也可以直接补充你的方向…')).trim()
  const docked = options.docked === true
  const step = Math.max(0, Math.trunc(Number(options.step) || 0))
  const previous = String(options.previous || '').trim()
  const exitable = options.exitable === true
  const answerKey = String(index + 1)
  const draft = total > 0 && clarify.answers && clarify.answers[answerKey]
    ? clarify.answers[answerKey]
    : null
  const selectedLabels = Array.isArray(draft?.selected) ? draft.selected.map((value) => String(value)) : []
  const draftText = String(draft?.text || '')
  const stepLine = total > 0
    ? `<div class="clarify-stepline">
        <span class="clarify-step">第 ${index + 1} / ${total} 题</span>
        ${previous ? `<span class="clarify-prev">上一步：${esc(oneLinePreview(previous, 24))}</span>` : ''}
        ${exitable ? '<button class="clarify-exit" type="button" data-clarify-exit>退出引导</button>' : ''}
      </div>`
    : step > 0
      ? `<div class="clarify-stepline">
          <span class="clarify-step">第 ${step} 步</span>
          ${previous ? `<span class="clarify-prev">上一步：${esc(oneLinePreview(previous, 24))}</span>` : ''}
          ${exitable ? '<button class="clarify-exit" type="button" data-clarify-exit>退出引导</button>' : ''}
        </div>`
      : ''
  const head =
    kind === 'text' ? '需要你填写答案' : kind === 'multiple' ? '本题可多选' : '需要你确认方向'
  const optionHtml = optionsList.map((option) => {
    const label = String(option?.label || '').trim()
    const description = String(option?.description || '').trim()
    if (!label) return ''
    const selected = selectedLabels.includes(label)
    return `<button class="clarify-option${kind === 'multiple' ? ' clarify-option-check' : ''}${selected ? ' is-selected' : ''}" type="button"
      data-clarify-answer="${esc(label)}" aria-pressed="${selected ? 'true' : 'false'}">
      ${kind === 'multiple' ? '<span class="clarify-check" aria-hidden="true">✓</span>' : ''}
      <span class="clarify-option-label">${esc(label)}</span>
      ${description ? `<span class="clarify-option-desc">${esc(description)}</span>` : ''}
    </button>`
  }).join('')
  const submitHtml = total > 0
    ? index === total - 1
      ? '<button class="clarify-send clarify-batch-submit" type="button" data-clarify-batch-submit>提交全部</button>'
      : ''
    : kind === 'multiple'
      ? '<button class="clarify-send clarify-multi-submit" type="button" data-clarify-multi-submit>提交多选</button>'
      : ''
  const inputHtml = kind === 'text'
    ? `<div class="clarify-custom">
        <input class="clarify-input" type="text" maxlength="200" value="${esc(draftText)}" placeholder="${esc(placeholder)}" aria-label="填写答案">
        ${total > 0 ? '' : '<button class="clarify-send" type="button" data-clarify-text-submit>提交答案</button>'}
      </div>`
    : kind === 'single' && allowCustom && total === 0
      ? docked
        ? '<div class="clarify-hint">也可以直接在下方输入框补充自己的方向。</div>'
        : `<div class="clarify-custom">
            <input class="clarify-input" type="text" maxlength="200" placeholder="${esc(placeholder)}" aria-label="补充你的方向">
            <button class="clarify-send" type="button">发送</button>
          </div>`
      : ''
  const navHtml = total > 0
    ? `<div class="clarify-nav">
        <button class="clarify-nav-btn" type="button" data-clarify-prev ${index === 0 ? 'disabled' : ''}>上一题</button>
        <span class="clarify-nav-progress">${index + 1} / ${total}</span>
        <button class="clarify-nav-btn" type="button" data-clarify-next ${index === total - 1 ? 'disabled' : ''}>下一题</button>
      </div>`
    : ''
  return `<div class="clarify-card${docked ? ' is-docked' : ''}" role="group" aria-label="${esc(head)}" data-clarify-kind="${kind}" data-clarify-total="${total}" data-clarify-index="${index}">
    ${stepLine}
    ${intro ? `<div class="clarify-intro">${esc(intro)}</div>` : ''}
    <div class="clarify-head"><span class="clarify-mark" aria-hidden="true">?</span><span>${esc(head)}</span></div>
    <div class="clarify-question">${esc(question)}</div>
    ${optionHtml ? `<div class="clarify-options${kind === 'multiple' ? ' is-multi' : ''}">
      ${optionHtml}
    </div>${submitHtml}` : ''}
    <div class="clarify-auto" id="clarify-auto" hidden></div>
    ${inputHtml}
    ${navHtml}
  </div>`
}

/** 多页澄清的中间消息只作为 Agent 上下文，不进入聊天消息流。 */
function isHiddenClarifyStep(message) {
  if (!message?.meta) return false
  if (message.role === 'user') return Boolean(message.meta.clarifyFlowId)
  return message.role === 'assistant' && Boolean(message.meta.clarify)
}

/**
 * 团队进度消息不再作为独立 assistant 气泡显示：它的 teamProgress 会合并到
 * 前面那条真正派发子 Agent 的父消息里。没有工具调用的 assistant 消息就是
 * 后端为持久化进度单独写的卡片行。
 */
function isStandaloneTeamProgressMessage(message) {
  const meta = message?.meta
  if (message?.role !== 'assistant' || !meta || !meta.teamProgress || typeof meta.teamProgress !== 'object') {
    return false
  }
  if (meta.backgroundWake !== true && meta.progress !== true) return false
  return !Array.isArray(meta.toolCalls) || meta.toolCalls.length === 0
}

function rememberPendingTeamProgress(message) {
  if (!message?.meta?.teamProgress) return false
  state.pendingTeamProgress = {
    ...message.meta.teamProgress,
    note: message.meta.teamProgress.note || message.text || '',
  }
  return true
}

/**
 * 父消息自己没带 teamProgress（旧历史或同步续派）时，把紧邻的进度卡补进
 * 下一条带工具调用的 assistant 消息，保证刷新后进度仍显示在派活消息里。
 */
function teamProgressForMessage(message) {
  if (message?.role !== 'assistant') return null
  const own = message.meta?.teamProgress
  if (own && typeof own === 'object') return own
  const pending = state.pendingTeamProgress
  if (!pending) return null
  const tools = Array.isArray(message.meta?.toolCalls) ? message.meta.toolCalls : []
  if (tools.length === 0) return null
  state.pendingTeamProgress = null
  return pending
}

function newClarifyFlowId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `cf_${crypto.randomUUID()}`
  }
  return `cf_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

/** 当前底部导引流程；历史刷新时用消息 meta 里的 flowId / step 续上同一个流程。 */
function ensureClarifyFlow(meta) {
  const incomingId = String(meta?.clarifyFlowId || '').trim()
  const incomingStep = Number(meta?.clarifyStep)
  const step =
    Number.isFinite(incomingStep) && incomingStep > 0 ? Math.min(20, Math.trunc(incomingStep)) : 1
  if (state.clarifyFlow && (!incomingId || state.clarifyFlow.id === incomingId)) {
    if (step > state.clarifyFlow.step) state.clarifyFlow.step = step
    return state.clarifyFlow
  }
  if (state.clarifyFlow) {
    stopClarifyAuto(state.clarifyFlow)
    if (state.clarifyFlow.controller) state.clarifyFlow.controller.abort()
  }
  state.clarifyFlow = {
    id: incomingId || newClarifyFlowId(),
    step,
    answers: [],
    busy: false,
    controller: null,
    sessionId: state.sessionId,
    modelId: state.selected || null,
    reasoningEffort: state.reasoningEffort || null,
    turn: null,
    autoTimer: 0,
    autoTick: 0,
    autoDeadline: 0,
    autoSelectMs: CLARIFY_AUTO_SELECT_MS,
    autoOptionLabel: '',
    lastAuto: false,
  }
  return state.clarifyFlow
}

/** 最后一条消息仍是 AI 的方向确认时，刷新后继续在底部输入区等待回答。 */
function trailingPendingClarify(messages) {
  if (!Array.isArray(messages)) return null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'user') return null
    if (message?.role === 'assistant') {
      return message.meta?.clarify && typeof message.meta.clarify === 'object' ? message : null
    }
  }
  return null
}

function stopClarifyAuto(flow = state.clarifyFlow) {
  if (!flow) return
  if (flow.autoTimer) window.clearTimeout(flow.autoTimer)
  if (flow.autoTick) window.clearInterval(flow.autoTick)
  flow.autoTimer = 0
  flow.autoTick = 0
  flow.autoDeadline = 0
  const hint = $('#clarify-auto')
  if (hint) {
    hint.hidden = true
    hint.textContent = ''
  }
}

function formatClarifyAutoWait(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0 ? `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒` : `${seconds} 秒`
}

function updateClarifyAutoHint(flow = state.clarifyFlow) {
  const hint = $('#clarify-auto')
  if (!hint) return
  if (!flow?.autoDeadline) {
    hint.hidden = true
    return
  }
  const remaining = Math.max(0, Math.ceil((flow.autoDeadline - Date.now()) / 1000))
  hint.hidden = false
  hint.textContent = remaining > 0
    ? `${formatClarifyAutoWait(flow.autoDeadline - Date.now())}后自动选择：${flow.autoOptionLabel || '第一个方向'}`
    : '等待超时，正在自动选择…'
}

/** 用户迟迟不选时，等待一段时间后自动采用第一个方向，避免流程一直悬着。 */
function startClarifyAutoSelect(flow = state.clarifyFlow) {
  const clarify = state.pendingClarify
  if (!flow || !clarify || flow.busy) return
  // 多选/填空没有唯一默认答案，自动替用户提交会污染答案，必须让用户自己确认。
  if (clarify.kind === 'multiple' || clarify.kind === 'text') return
  // 题组必须逐题作答后统一提交，不能自动选第一项。
  if (Array.isArray(clarify.questions) && clarify.questions.length > 1) return
  const optionsList = Array.isArray(clarify.options) ? clarify.options : []
  const first = optionsList.map((option) => String(option?.label || '').trim()).find(Boolean)
  if (!first) return
  stopClarifyAuto(flow)
  flow.autoSelectMs = Number(flow.autoSelectMs) > 0 ? flow.autoSelectMs : CLARIFY_AUTO_SELECT_MS
  flow.autoOptionLabel = first
  flow.autoDeadline = Date.now() + flow.autoSelectMs
  flow.autoTimer = window.setTimeout(() => {
    flow.autoTimer = 0
    if (state.clarifyFlow !== flow || !state.pendingClarify || flow.busy) return
    const runtime = runtimeFor(flow.sessionId ?? state.sessionId)
    if (runtime.sending) {
      startClarifyAutoSelect(flow)
      return
    }
    stopClarifyAuto(flow)
    banner(`已等待 ${formatClarifyAutoWait(flow.autoSelectMs)}，自动选择：${first}`)
    advanceClarifyFlow(first, { auto: true })
  }, flow.autoSelectMs)
  flow.autoTick = window.setInterval(() => updateClarifyAutoHint(flow), 1000)
  updateClarifyAutoHint(flow)
}

function hideClarifyDockView() {
  const dock = $('#clarify-dock')
  if (!dock) return
  dock.hidden = true
  dock.innerHTML = ''
}

/** 方向选项直接渲染进当前 AI 气泡；底部不再出现独立的引导浮层。 */
function showClarifyDock(clarify, options = {}) {
  const flow = ensureClarifyFlow(options.flowMeta)
  const step = Number(options.step)
  if (Number.isFinite(step) && step > 0) flow.step = Math.max(flow.step, Math.trunc(step))
  const previous = flow.answers.length
    ? flow.answers[flow.answers.length - 1].answer
    : String(options.previous || '').trim()
  if (!clarifyPanelHtml(clarify, { docked: false, step: flow.step, previous, exitable: true })) return
  let turn = flow.turn?.node?.isConnected ? flow.turn : null
  if (!turn) {
    turn = createAiTurn({ append: true })
    flow.turn = turn
  }
  hideClarifyDockView()
  const input = $('#input')
  if (input) input.placeholder = '也可以直接输入你的回答或补充，Enter 发送…'
  turn.showClarifyPrompt(clarify, { step: flow.step, previous, auto: options.auto })
}

function showClarifyBusy(flow, answer, options = {}) {  stopClarifyAuto(flow)
  hideClarifyDockView()
  const turn = flow.turn?.node?.isConnected ? flow.turn : null
  if (turn?.waitForReply) {
    turn.waitForReply(options.auto ? '等待超时，已自动选择，等待回复中…' : '等待回复中…')
  }
  const input = $('#input')
  if (input) input.placeholder = '正在等待回复…'
}

function clearClarifyDock(options = {}) {
  stopClarifyAuto(state.clarifyFlow)
  state.clarifyFlow?.turn?.clearClarifyPrompt?.()
  if (options.abort && state.clarifyFlow?.controller) state.clarifyFlow.controller.abort()
  state.pendingClarify = null
  state.clarifyFlow = null
  hideClarifyDockView()
  const input = $('#input')
  if (input) input.placeholder = DEFAULT_INPUT_PLACEHOLDER
}

/** 题组模式下，从当前卡片读取本题草稿；选项统一存标签，提交时直接拼给模型。 */
function clarifyDraftFromCard(card, question) {
  const kind = question?.kind === 'multiple' || question?.kind === 'text' ? question.kind : 'single'
  if (kind === 'text') {
    return { selected: [], text: String(card.querySelector('.clarify-input')?.value || '').trim() }
  }
  const selected = [...card.querySelectorAll('.clarify-option.is-selected')]
    .map((option) => String(option.dataset.clarifyAnswer || '').trim())
    .filter(Boolean)
  return { selected, text: '' }
}

function clarifyDraftEmpty(question, draft) {
  const kind = question?.kind === 'text' ? 'text' : question?.kind === 'multiple' ? 'multiple' : 'single'
  return kind === 'text' ? !String(draft?.text || '').trim() : !(draft?.selected || []).length
}

/** 当前页改动只写本地题组草稿，不触发服务端。 */
function saveClarifyBatchDraft(card, index) {
  const clarify = state.pendingClarify
  if (!clarify || !Array.isArray(clarify.questions)) return null
  const question = clarify.questions[index]
  if (!question) return null
  const draft = clarifyDraftFromCard(card, question)
  clarify.answers = clarify.answers || {}
  clarify.answers[String(index + 1)] = draft
  clarify.index = index
  return draft
}

function rerenderClarifyBatch() {
  const clarify = state.pendingClarify
  const flow = state.clarifyFlow
  if (!clarify || !flow?.turn?.showClarifyPrompt) return
  const previous = flow.answers.length
    ? flow.answers[flow.answers.length - 1].answer
    : ''
  flow.turn.showClarifyPrompt(clarify, { step: flow.step, previous, exitable: true })
}

/** 多题统一提交：校验每一题都有答案，再拼成一条完整答卷。 */
function submitClarifyBatch(card, index) {
  const clarify = state.pendingClarify
  if (!clarify || !Array.isArray(clarify.questions)) return
  const questions = clarify.questions
  saveClarifyBatchDraft(card, index)
  const missing = questions.findIndex((question, questionIndex) =>
    clarifyDraftEmpty(question, clarify.answers?.[String(questionIndex + 1)]))
  if (missing >= 0) {
    clarify.index = missing
    rerenderClarifyBatch()
    banner(`第 ${missing + 1} 题还没有作答，请先完成`, 'warn')
    return
  }
  const lines = questions.map((question, questionIndex) => {
    const draft = clarify.answers?.[String(questionIndex + 1)] || { selected: [], text: '' }
    const value = String(question.kind === 'text' ? draft.text : draft.selected.join('、')).trim()
    return `第${questionIndex + 1}题（${question.question}）：${value}`
  })
  const flow = ensureClarifyFlow()
  // 题组最终提交只续跑一次模型；step 直接推到总题数，下一轮 meta 即为 N+1。
  flow.step = questions.length
  advanceClarifyFlow(`我完成了以下 ${questions.length} 道题：\n${lines.join('\n')}`)
}

/** 题组翻页：保存当前页草稿并切换本地页，不产生模型请求；允许空答案先浏览后面的题。 */
function moveClarifyBatch(card, index, direction) {
  const clarify = state.pendingClarify
  if (!clarify || !Array.isArray(clarify.questions)) return
  const total = clarify.questions.length
  const draft = saveClarifyBatchDraft(card, index)
  if (!draft) return
  const target = direction === 'prev' ? index - 1 : index + 1
  if (target < 0 || target >= total) return
  clarify.index = target
  rerenderClarifyBatch()
}

function bindClarifyPanel(node) {
  for (const card of node.querySelectorAll('.clarify-card')) {
    if (card.dataset.bound === 'true') continue
    card.dataset.bound = 'true'
    const kind = card.dataset.clarifyKind || 'single'
    const batchTotal = Math.max(0, Math.trunc(Number(card.dataset.clarifyTotal) || 0))
    const batchIndex = Math.max(0, Math.trunc(Number(card.dataset.clarifyIndex) || 0))
    const submit = (value) => {
      const text = String(value || '').trim()
      if (!text) return
      advanceClarifyFlow(text)
    }
    if (batchTotal > 1) {
      // 题组：点选项只记本地草稿，翻页/最后一页“提交全部”才产生请求。
      for (const option of card.querySelectorAll('.clarify-option')) {
        option.addEventListener('click', () => {
          if (kind === 'multiple') {
            const selected = option.classList.toggle('is-selected')
            option.setAttribute('aria-pressed', selected ? 'true' : 'false')
            return
          }
          for (const other of card.querySelectorAll('.clarify-option')) {
            other.classList.toggle('is-selected', other === option)
            other.setAttribute('aria-pressed', other === option ? 'true' : 'false')
          }
          // 单选点完自动进入下一题；最后一页不自动提交，留给“提交全部”。
          if (batchIndex < batchTotal - 1) {
            const from = batchIndex
            const pendingTimer = Number(card.dataset.clarifyAutoNextTimer || '')
            if (pendingTimer) window.clearTimeout(pendingTimer)
            const timer = window.setTimeout(() => {
              delete card.dataset.clarifyAutoNextTimer
              if (card.isConnected) moveClarifyBatch(card, from, 'next')
            }, 240)
            card.dataset.clarifyAutoNextTimer = String(timer)
          }
        })
      }
      const prev = card.querySelector('[data-clarify-prev]')
      const next = card.querySelector('[data-clarify-next]')
      if (prev) prev.addEventListener('click', () => moveClarifyBatch(card, batchIndex, 'prev'))
      if (next) next.addEventListener('click', () => moveClarifyBatch(card, batchIndex, 'next'))
      const batchSubmit = card.querySelector('[data-clarify-batch-submit]')
      if (batchSubmit) batchSubmit.addEventListener('click', () => submitClarifyBatch(card, batchIndex))
      const batchInput = card.querySelector('.clarify-input')
      if (batchInput) {
        batchInput.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' && !event.isComposing) {
            event.preventDefault()
            if (batchIndex >= batchTotal - 1) submitClarifyBatch(card, batchIndex)
            else moveClarifyBatch(card, batchIndex, 'next')
          }
        })
      }
      const batchExit = card.querySelector('[data-clarify-exit]')
      if (batchExit) {
        batchExit.addEventListener('click', () => {
          clearClarifyDock()
          banner('已退出这次引导，之后可以直接发消息继续', 'warn')
        })
      }
      return
    }

    if (kind === 'multiple') {
      // 多选：先本地勾选，点“提交多选”再一次性发回，避免每勾一项都触发 Agent。
      for (const option of card.querySelectorAll('.clarify-option')) {
        option.addEventListener('click', () => {
          const selected = option.classList.toggle('is-selected')
          option.setAttribute('aria-pressed', selected ? 'true' : 'false')
        })
      }
      const submitButton = card.querySelector('[data-clarify-multi-submit]')
      if (submitButton) {
        submitButton.addEventListener('click', () => {
          const labels = [...card.querySelectorAll('.clarify-option.is-selected')]
            .map((option) => String(option.dataset.clarifyAnswer || '').trim())
            .filter(Boolean)
          if (labels.length === 0) {
            banner('请至少选择一个选项', 'warn')
            return
          }
          submit(labels.join('、'))
        })
      }
    } else {
      for (const option of card.querySelectorAll('.clarify-option')) {
        option.addEventListener('click', () => submit(option.dataset.clarifyAnswer || option.textContent))
      }
    }
    const input = card.querySelector('.clarify-input')
    const sendButton = card.querySelector('.clarify-send')
    if (input && sendButton && kind !== 'multiple') {
      sendButton.addEventListener('click', () => submit(input.value))
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.isComposing) {
          event.preventDefault()
          submit(input.value)
        }
      })
    }
    const exit = card.querySelector('[data-clarify-exit]')
    if (exit) {
      exit.addEventListener('click', () => {
        clearClarifyDock()
        banner('已退出这次引导，之后可以直接发消息继续', 'warn')
      })
    }
  }
}

/** 选择方向或补充内容：隐藏续跑 Agent，不新增用户气泡。 */
function advanceClarifyFlow(answer, options = {}) {
  const text = String(answer || '').trim()
  const clarify = state.pendingClarify
  if (!text || !clarify) return
  const flow = ensureClarifyFlow()
  if (flow.busy) return
  stopClarifyAuto(flow)
  flow.sessionId = flow.sessionId || state.sessionId
  flow.modelId = flow.modelId || state.selected || null
  flow.reasoningEffort = flow.reasoningEffort || state.reasoningEffort || null
  flow.answers.push({ question: String(clarify.question || ''), answer: text })
  flow.voiceConversation = options.voiceConversation === true
  flow.busy = true
  flow.lastAuto = options.auto === true
  if (flow.sessionId) {
    markSessionActive(flow.sessionId)
    renderSessions()
  }
  showClarifyBusy(flow, text, options)
  void runClarifyStep(flow, text, clarify)
}

/** 把一页答案作为隐藏续跑发给 Agent，下一页仍回到同一个 AI 气泡内的引导区。 */
async function runClarifyStep(flow, answer, answeredClarify) {
  const runtime = runtimeFor(flow.sessionId ?? state.sessionId)
  if (runtime.sending) return
  const controller = new AbortController()
  flow.controller = controller
  runtime.controller = controller
  runtime.sending = true
  renderSessions()
  renderQueueState()
  updateSendState()
  const targetSessionId = flow.sessionId ?? state.sessionId
  const nextStep = flow.step + 1
  const startedAt = Date.now()
  const selectionAt = new Date(startedAt).toISOString()
  let turn = null
  if (targetSessionId === state.sessionId || targetSessionId === null) {
    if (flow.turn?.node?.isConnected) {
      turn = flow.turn
      turn.reset({
        createdAt: selectionAt,
        waitingText: flow.lastAuto ? '等待超时，已自动选择，等待回复中…' : '等待回复中…',
      })
    } else {
      turn = createAiTurn({ append: true, createdAt: selectionAt })
      flow.turn = turn
      turn.waitForReply(flow.lastAuto ? '等待超时，已自动选择，等待回复中…' : '等待回复中…')
    }
    runtime.turn = turn
    scrollThreadToBottomInstant()
  }
  const turnStartedLive = Boolean(turn)
  const voiceStream =
    turn &&
    flow.voiceConversation &&
    state.voiceConversation.active &&
    (targetSessionId
      ? targetSessionId === state.voiceConversation.sessionId || state.voiceConversation.sessionId === null
      : state.voiceConversation.sessionId === null)
      ? beginVoiceSpeechStream(turn.node, state.voiceConversation.generation)
      : null
  const buffered = { reasoning: '', content: '', tools: [], toolResults: [], done: null, clarify: null, messageId: '' }
  let streamError = null
  let sawDone = false
  let messageId = ''
  try {
    await streamChat(
      {
        modelId: flow.modelId,
        reasoningEffort: flow.reasoningEffort,
        text: answer,
        sessionId: targetSessionId,
        spaceKind: state.spaceKind,
        clarifyFlowId: flow.id,
        clarifyStep: nextStep,
        activeFile: activePreviewFilePayload(),
      },
      (event, data) => {
        if (event === 'meta') {
          messageId = String(data.messageId || '')
          if (messageId) {
            state.localLiveMessageIds.add(messageId)
            state.historyMessageIds.add(messageId)
            if (turn) {
              turn.node.dataset.messageId = messageId
              state.liveTurns.set(messageId, {
                turn,
                sessionId: data.sessionId || runtime.sessionId,
                messageId,
                hydrated: true,
              })
              refreshMessageActions(turn.node)
            }
          }
          runtime.runId = data.runId || runtime.runId
          if (data.runId) beginParentAgentTurn(data.runId)
          runtime.messageId = messageId
          if (data.sessionId) {
            migrateRuntime(runtime, data.sessionId)
            flow.sessionId = data.sessionId
            if (state.sessionId === data.sessionId) {
              state.sessionId = data.sessionId
              persistChatLocation()
              if ($('#chat-title').textContent === '新对话') {
                $('#chat-title').textContent = '方向确认'
              }
            }
          }
        } else if (event === 'reasoning') {
          buffered.reasoning += String(data.text || '')
          if (turn) turn.reasoning(String(data.text || ''))
        } else if (event === 'delta') {
          buffered.content += String(data.text || '')
          if (turn) turn.content(String(data.text || ''))
          if (voiceStream?.active && !voiceSpeechDeferred()) feedVoiceSpeechStream(String(data.text || ''))
        } else if (event === 'tool') {
          buffered.tools.push(data)
          if (turn) turn.tool(data)
        } else if (event === 'tool_result') {
          buffered.toolResults.push(data)
          if (turn) turn.toolResult(data)
        } else if (event === 'agent') {
          updateAgentEvent(data)
        } else if (event === 'clarify') {
          buffered.clarify = data.clarify || buffered.clarify
        } else if (event === 'done') {
          sawDone = true
          buffered.done = data
          if (data.clarify) buffered.clarify = data.clarify
          if (data.sessionId) {
            migrateRuntime(runtime, data.sessionId)
            flow.sessionId = data.sessionId
            if (state.sessionId === data.sessionId) {
              state.sessionId = data.sessionId
              persistChatLocation()
            }
          }
        } else if (event === 'error') {
          const err = new Error(data.message || '模型调用失败')
          err.code = data.code
          streamError = err
        }
      },
      controller.signal,
    )
    if (controller.signal.aborted) throw new DOMException('已停止', 'AbortError')
    if (streamError) throw streamError
    if (!sawDone) throw new Error('回答流意外中断，请重试')

    const userMessageId = String(buffered.done?.userMessageId || '')
    if (userMessageId) state.historyMessageIds.add(userMessageId)

    if (buffered.clarify) {
      flow.busy = false
      flow.step = nextStep
      state.pendingClarify = buffered.clarify
      state.clarifyFlow = flow
      if (turn) {
        const doneData = buffered.done || { text: buffered.content }
        const questionText = String(
          doneData.text || buffered.clarify.question || buffered.content || '',
        )
        if (messageId) {
          turn.node.dataset.messageId = messageId
          turn.node.chatMessage = {
            id: messageId,
            role: 'assistant',
            text: questionText,
            createdAt: doneData.createdAt || new Date().toISOString(),
          }
          state.historyMessageIds.add(messageId)
          setMessageTime(turn.node, doneData.createdAt)
          refreshMessageActions(turn.node)
        }
        turn.finish({ ...doneData, text: questionText, clarify: null })
        if (messageId) state.liveTurns.delete(messageId)
        if (flow.voiceConversation && questionText) {
          if (voiceStream) endVoiceSpeechStream(voiceStream, questionText)
          else handleVoiceConversationAnswer(turn.node, questionText)
        }
      }
      showClarifyDock(buffered.clarify, { step: nextStep, auto: true })
      loadSessions()
      return
    }

    flow.busy = false
    flow.controller = null
    runtime.sending = false
    runtime.controller = null
    runtime.runId = null
    state.clarifyFlow = null
    state.pendingClarify = null
    clearClarifyDock()
    if (!turn && runtime.sessionId === state.sessionId) {
      turn = createAiTurn({ append: true, createdAt: selectionAt })
      runtime.turn = turn
    }
    if (turn && messageId) {
      turn.node.dataset.messageId = messageId
      turn.node.chatMessage = {
        id: messageId,
        role: 'assistant',
        text: String(buffered.done?.text || buffered.content || ''),
        createdAt: buffered.done?.createdAt || new Date().toISOString(),
      }
      setMessageTime(turn.node, buffered.done?.createdAt)
      refreshMessageActions(turn.node)
    }
    if (turn && !turnStartedLive) {
      if (buffered.reasoning.trim()) turn.reasoning(buffered.reasoning)
      for (const event of buffered.tools) turn.tool(event)
      for (const event of buffered.toolResults) turn.toolResult(event)
    }
    if (turn) turn.finish(buffered.done || { text: buffered.content })
    if (flow.voiceConversation && turn) {
      const replyText = String(buffered.done?.text || buffered.content || '').trim()
      if (voiceStream) endVoiceSpeechStream(voiceStream, replyText)
      else if (replyText) handleVoiceConversationAnswer(turn.node, replyText)
      else setVoiceDockStatus('paused', '回答已完成', '没有可播报的文本，点“继续聆听”继续语音对话')
    }
    if (messageId) state.liveTurns.delete(messageId)
    if (messageId) {
      state.historyMessageIds.add(messageId)
      state.localLiveMessageIds.delete(messageId)
    }
    loadSessions()
    renderQueueState()
    updateSendState()
  } catch (err) {
    const aborted = controller.signal.aborted
    if (voiceStream) abortVoiceSpeechStream({ quiet: true })
    if (turn) {
      if (aborted) turn.stop()
      else turn.fail(`引导续跑失败：${err.message}`)
    }
    if (state.clarifyFlow === flow) {
      flow.busy = false
      flow.controller = null
      if (flow.answers.length > 0) flow.answers.pop()
      if (aborted) {
        showClarifyDock(answeredClarify, { step: flow.step })
        banner('已停止这次引导，你可以重新选择或补充', 'warn')
      } else {
        showClarifyDock(answeredClarify, { step: flow.step })
        banner(`引导续跑失败：${err.message}`, 'warn')
      }
      if (flow.voiceConversation && state.voiceConversation.active) {
        setVoiceDockStatus('error', '这轮回答失败', '文字错误已保留；点“重试”重新开始语音对话')
      }
    }
  } finally {
    runtime.sending = false
    runtime.controller = null
    if (runtime.turn === turn) runtime.turn = null
    if (messageId) {
      const live = state.liveTurns.get(messageId)
      if (live?.turn === turn) state.liveTurns.delete(messageId)
    }
    if (messageId && runtime.messageId === messageId) runtime.messageId = null
    if (messageId) state.localLiveMessageIds.delete(messageId)
    renderSessions()
    updateSendState()
    renderQueueState()
    if (runtime.queue.length > 0) {
      void drainQueue(runtime)
    } else if (state.sessionId === runtime.sessionId || runtime.sessionId === null) {
      $('#input').focus()
    }
  }
}

function bindToolToggles(node) {
  for (const button of node.querySelectorAll('.tool-head, .think-head, .memory-head')) {
    if (button.dataset.bound === 'true') continue
    button.dataset.bound = 'true'
    button.addEventListener('click', () => {
      const panel = button.closest('.tool-panel, .tool-card, .think-panel, .memory-panel')
      if (!panel) return
      const collapsed = panel.classList.toggle('is-collapsed')
      button.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
      if (panel.classList.contains('think-panel')) {
        panel.dataset.userToggled = collapsed ? '0' : '1'
        button.dataset.tip = collapsed ? '展开这次回答的完整思考过程' : '收起思考过程，只看回答正文'
      } else if (panel.classList.contains('memory-panel')) {
        button.dataset.tip = collapsed ? '展开这次回答引用的记忆来源' : '收起记忆来源'
      } else if (panel.classList.contains('tool-panel') || panel.classList.contains('tool-card')) {
        button.dataset.tip = collapsed
          ? '展开这次工具调用的完整参数与结果'
          : '收起工具详情，只看调用摘要'
      }
    })
  }
}

function myDisplayName() {
  return String(state.me?.person?.name || $('#user-name')?.textContent || '我').trim() || '我'
}

function formatMessageStamp(value) {
  const date = value ? new Date(value) : new Date()
  if (Number.isNaN(date.getTime())) return null
  const now = new Date()
  const pad = (number) => String(number).padStart(2, '0')
  const hhmm = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const isSameDay = (left, right) =>
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  let short = hhmm
  if (!isSameDay(date, now)) {
    short = isSameDay(date, yesterday)
      ? `昨天 ${hhmm}`
      : date.getFullYear() === now.getFullYear()
        ? `${date.getMonth() + 1}月${date.getDate()}日 ${hhmm}`
        : `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${hhmm}`
  }
  const full = `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${hhmm}`
  return { iso: date.toISOString(), short, full }
}

function setMessageTime(node, value) {
  const time = node?.querySelector('.msg-time')
  const stamp = formatMessageStamp(value)
  if (!time || !stamp) return
  time.dateTime = stamp.iso
  time.dataset.tip = stamp.full
  time.textContent = stamp.short
}

const MESSAGE_ACTION_ICONS = {
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 19.5h4L19 9a2.2 2.2 0 0 0-3.1-3.1L5.5 16.4v3.1Z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m13.5 6.5 3.1 3.1" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  recall:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7 5 11l4 4" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M5 11h8.2A5.8 5.8 0 0 1 19 16.8" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>',
  delete:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9 7V5h6v2M8 7l1 12h6l1-12M10 10v6M14 10v6" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
}

function messageFooterMarkup(role) {
  const actions =
    role === 'me'
      ? `<button type="button" class="msg-action" data-message-act="edit" data-tip="编辑这条消息并重新发送" aria-label="编辑后重发">${MESSAGE_ACTION_ICONS.edit}</button>
         <button type="button" class="msg-action" data-message-act="recall" data-tip="撤回这条消息" aria-label="撤回">${MESSAGE_ACTION_ICONS.recall}</button>
         <button type="button" class="msg-action is-danger" data-message-act="delete" data-tip="删除这条消息" aria-label="删除">${MESSAGE_ACTION_ICONS.delete}</button>`
      : `<button type="button" class="msg-action is-danger" data-message-act="delete" data-tip="删除这条回答" aria-label="删除回答">${MESSAGE_ACTION_ICONS.delete}</button>`
  const actionsBlock = `<div class="msg-actions" role="group" aria-label="消息操作" hidden>${actions}</div>`
  const speech =
    role === 'ai'
      ? '<button class="msg-voice" type="button" data-tip="播放这条回答的语音；播放中可再点一次停止" aria-label="播放语音" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 10v4h3l4 3V7l-4 3H5Z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M15 9.5a3.5 3.5 0 0 1 0 5M17.5 7a7 7 0 0 1 0 10" fill="none" stroke="currentColor" stroke-width="1.5"/></svg><span>播放语音</span></button>'
      : ''
  const time = '<time class="msg-time" aria-label="消息时间"></time>'
  const blocks =
    role === 'me'
      ? `${actionsBlock}${time}`
      : `${speech}${time}${actionsBlock}`
  return `<div class="msg-footer">
    ${blocks}
  </div>`
}

function refreshMessageActions(node) {
  const actions = node?.querySelector('.msg-actions')
  if (!actions) return
  actions.hidden = !node.dataset.messageId
}

function sessionReplyBusy() {
  const runtime = currentRuntime()
  if (runtime?.sending) return true
  if (
    Array.from(state.liveTurns.values()).some((entry) => entry.sessionId === state.sessionId)
  ) {
    return true
  }
  return Array.from(state.activeRunSnapshots.values()).some(
    (run) => run.sessionId === state.sessionId && run.status === 'running',
  )
}

function syncMessageActionAvailability() {
  const thread = $('#thread')
  if (thread) thread.dataset.replyBusy = sessionReplyBusy() ? 'true' : 'false'
}

/**
 * 云空间引用只作为本轮上下文送进模型，不在用户消息气泡里重复展示文件/文件夹卡片。
 * 直传图片和普通上传附件没有 workspaceKind，仍按原样显示。
 */
function bubbleVisibleAttachments(list) {
  return (Array.isArray(list) ? list : []).filter((file) => !file?.workspaceKind)
}

/**
 * 只给这一轮新出现的消息加入场过渡。
 * 历史记录首屏直接落在最终状态，避免页面重新打开时整段对话被动画起始帧的 opacity:0 挡住。
 */
function markMessageNew(node) {
  if (!node) return
  node.classList.add('is-new')
  window.setTimeout(() => node.classList.remove('is-new'), 650)
}

function appendMessage(role, text, meta, attachments, rich, options = {}) {
  setEmptyVisible(false)
  const node = document.createElement('div')
  node.className = `msg ${role === 'me' ? 'me' : 'ai'}`
  if (options.messageId) {
    node.dataset.messageId = String(options.messageId)
    node.chatMessage = {
      id: String(options.messageId),
      role: role === 'me' ? 'user' : 'assistant',
      text: String(text || ''),
      createdAt: options.createdAt || new Date().toISOString(),
    }
  }
  const visibleAttachments = bubbleVisibleAttachments(attachments)
  const files = visibleAttachments.length ? `<div class="bubble-files">${attachmentChips(visibleAttachments)}</div>` : ''
  const meName = myDisplayName()
  const channel = channelTag(options.channel)
  const footer = messageFooterMarkup(role === 'me' ? 'me' : 'ai')
  node.innerHTML =
    role === 'me'
      ? `<div class="msg-body"><div class="bubble">${esc(text)}${files}</div>${footer}</div>
        <div class="who-me"><span class="who-name">${esc(meName)}</span>${channel}${avatarMarkup(meName, meAvatarUrl(), 'who-badge me')}</div>`
      : `${aiWhoMarkup()}<div class="msg-body"><div class="bubble ai-turn">${historyAiBubble(text, meta, rich || {}, options)}</div>${footer}</div>`
  const thread = $('#thread')
  if (options.animate) markMessageNew(node)
  if (options.prepend) {
    const firstMessage = thread.querySelector('.msg')
    thread.insertBefore(node, firstMessage || null)
  } else {
    thread.appendChild(node)
  }
  setMessageTime(node, options.createdAt)
  refreshMessageActions(node)
  bindToolToggles(node)
  node.chatAttachments = Array.isArray(attachments) ? attachments.slice() : []
  bindAttachmentCards(node)
  if (options.scroll !== false) {
    if (threadScrollPinned) node.scrollIntoView({ block: 'end', behavior: 'smooth' })
    else markThreadNewContent()
  }
  queueScrollBottomButtonUpdate()
  return node
}

/** 创建一条可实时更新的 AI 回答：思考过程 + 工具卡片 + 最终答案。 */
function createAiTurn(options = {}) {
  const append = options.append !== false
  if (append) setEmptyVisible(false)
  const node = document.createElement('div')
  node.className = 'msg ai'
  node.innerHTML = `${aiWhoMarkup()}<div class="msg-body"><div class="bubble ai-turn">
    <div class="think-panel is-collapsed" hidden>
      <button class="think-head" type="button" data-tip="查看这次回答的思考过程；生成中也会实时更新" aria-expanded="false" aria-label="展开思考过程">
        <span class="think-icon" aria-hidden="true">✦</span><span class="think-title">思考中</span><span class="think-divider" hidden>·</span><span class="think-preview"></span><span class="think-chevron" aria-hidden="true">⌄</span>
      </button>
      <div class="think-body"></div>
    </div>
    <div class="tool-slot" hidden></div>
    <div class="ai-team-progress" hidden></div>
    <div class="memory-slot" hidden></div>
    <div class="ai-status"><span class="ai-status-dot"></span><span class="ai-status-text">正在思考中…</span></div>
    <div class="ai-waiting" hidden><span class="ai-waiting-dot"></span><span class="ai-waiting-text">等待回复中…</span></div>
    <div class="clarify-slot" hidden></div>
    <div class="answer-text"></div>
    <span class="meta" hidden></span>
  </div>${messageFooterMarkup('ai')}</div>`
  setMessageTime(node, options.createdAt || Date.now())
  refreshMessageActions(node)
  if (append) {
    markMessageNew(node)
    $('#thread').appendChild(node)
    bindToolToggles(node)
    scrollThreadToBottomInstant()
  }
  const think = node.querySelector('.think-panel')
  const thinkTitle = node.querySelector('.think-title')
  const thinkPreview = node.querySelector('.think-preview')
  const thinkDivider = node.querySelector('.think-divider')
  const thinkBody = node.querySelector('.think-body')
  const toolPanel = node.querySelector('.tool-slot')
  const status = node.querySelector('.ai-status')
  const statusText = node.querySelector('.ai-status-text')
  const teamProgress = node.querySelector('.ai-team-progress')
  const memorySlot = node.querySelector('.memory-slot')
  const answer = node.querySelector('.answer-text')
  const metaLine = node.querySelector('.meta')
  const clarifySlot = node.querySelector('.clarify-slot')
  const waiting = node.querySelector('.ai-waiting')
  const waitingText = node.querySelector('.ai-waiting-text')
  let startedAt = Date.now()
  let reasoningStartedAt = 0
  let firstAnswerAt = 0
  let rawAnswer = ''
  /** 已揭示到界面的字符数：与 rawAnswer 解耦，保证大段 delta 也不会一次性铺满。 */
  let shownAnswerLength = 0
  /** 整段正文一次性到达（例如只有 done.text）时，按更慢的逐字节奏揭示。 */
  let batchReveal = false
  let answerRenderQueued = false
  let answerRenderTimer = 0
  let scrollQueued = false
  let renderGeneration = 0
  const toolTraces = []
  /** 当前回合按 tool_call index 累积的参数；只用于右侧预览，不写入工具轨迹。 */
  const streamToolDrafts = new Map()

  const scroll = () => {
    // 后台会话的节点不在当前消息流里，不能因为它的增量把当前页面滚到底部。
    if (!node.isConnected) return
    if (!threadScrollPinned) {
      markThreadNewContent()
      return
    }
    if (scrollQueued) return
    scrollQueued = true
    requestAnimationFrame(() => {
      scrollQueued = false
      // 用户可能在上滚已经打断了上一帧的跟随；这一帧也要重新确认。
      if (!threadScrollPinned) {
        markThreadNewContent()
        return
      }
      scrollThreadToBottomInstant()
    })
  }
  // 最后一条内容常常在 end 事件之后才完成排版，补一帧确保工具面板不被输入区遮住。
  const finalScroll = () => {
    if (!threadScrollPinned) {
      markThreadNewContent()
      return
    }
    scroll()
    setTimeout(() => {
      if (node.isConnected && threadScrollPinned) scrollThreadToBottomInstant()
    }, 120)
  }
  const setParentTeamProgress = (progressInput) => {
    if (!teamProgress) return
    const progress = normalizeTeamProgress(progressInput)
    if (!progress) {
      teamProgress.hidden = true
      teamProgress.innerHTML = ''
      return
    }
    // 父消息里显示与团队面板、独立进度卡完全同构的完整卡，而不是另一套简化条。
    let card = teamProgress.querySelector('.team-progress-card')
    if (!card) {
      teamProgress.innerHTML = teamProgressCardHtml(progress)
      card = teamProgress.querySelector('.team-progress-card')
    }
    if (card) applyTeamProgressCard(card, progress)
    teamProgress.hidden = false
  }
  const setMemorySources = (hits, scope, longTermTraces) => {
    if (!memorySlot) return
    const html = `${longTermMemorySourceHtml(longTermTraces)}${memorySourceHtml(hits, scope)}`
    memorySlot.innerHTML = html
    memorySlot.hidden = !html
    if (html) bindToolToggles(node)
  }
  const setStatus = (text, progressInput) => {
    if (!text) {
      status.hidden = true
      return
    }
    status.hidden = false
    statusText.textContent = text
    if (progressInput) setParentTeamProgress(progressInput)
  }
  const setThinkPreview = (text, streaming = false) => {
    const preview = streaming ? livePreview(text, 96) : firstLinePreview(text, 96)
    thinkPreview.textContent = preview
    thinkDivider.hidden = !preview
  }
  const collapseThink = (done) => {
    if (think.hidden) return
    if (done) {
      const thinkingMs = (firstAnswerAt || Date.now()) - (reasoningStartedAt || startedAt)
      thinkTitle.textContent = `已思考 ${formatElapsed(thinkingMs)}`
      setThinkPreview(thinkBody.textContent)
    }
    think.classList.remove('is-active')
    // 用户主动展开后，后续自动收起不覆盖这次选择。
    if (think.dataset.userToggled === '1' && !think.classList.contains('is-collapsed')) return
    think.classList.add('is-collapsed')
    think.querySelector('.think-head').setAttribute('aria-expanded', 'false')
  }
  const renderToolPanel = (active) => {
    if (toolTraces.length === 0) {
      toolPanel.hidden = true
      return
    }
    const current = toolPanel.querySelector('.tool-panel')
    const wasExpanded = current ? !current.classList.contains('is-collapsed') : false
    toolPanel.hidden = false
    toolPanel.innerHTML = toolPanelHtml(toolTraces, { active, expanded: wasExpanded })
    bindToolToggles(node)
    scroll()
  }
  /**
   * 实时事件有可能丢失（例如页面刚从后台恢复、SSE 重连或工具事件先于气泡创建）。
   * done 事件带着完整的 reasoning / toolCalls 快照，这里按快照补齐并合并，保证
   * 用户仍能看到“已深度思考”和可展开的工具调用记录。
   */
  const mergeDoneDetails = (data) => {
    const doneReasoning = String(data?.reasoning || '').trim()
    if (doneReasoning && think.hidden) {
      think.hidden = false
      think.classList.add('is-active')
      if (!reasoningStartedAt) reasoningStartedAt = startedAt
      thinkBody.textContent = doneReasoning
      thinkTitle.textContent = '思考中'
      setThinkPreview(doneReasoning)
    }
    const calls = Array.isArray(data?.toolCalls) ? data.toolCalls : []
    for (const item of calls) {
      const id = String(item?.id || '').trim()
      if (!id) continue
      const trace = {
        id,
        name: item.name || '工具调用',
        toolId: item.toolId || '',
        args: item.args ?? {},
        status: item.status === 'error' ? 'error' : 'done',
        summary: item.summary || '',
        durationMs: Number(item.durationMs) || 0,
      }
      const existing = toolTraces.find((entry) => entry.id === id)
      if (existing) {
        existing.name = trace.name || existing.name
        existing.toolId = trace.toolId || existing.toolId
        existing.status = trace.status
        existing.summary = trace.summary || existing.summary
        existing.durationMs = trace.durationMs || existing.durationMs
      } else {
        toolTraces.push(trace)
      }
    }
    if (toolTraces.length > 0 && toolPanel.hidden) {
      renderToolPanel(toolTraces.some((item) => item.status === 'running'))
    }
    const lastFileTrace = [...toolTraces].reverse().find((entry) => FILE_OPERATION_TOOLS.has(entry.toolId))
    if (lastFileTrace) updateFileActivity(lastFileTrace)
  }
  // 流式阶段也按 Markdown 渲染；合并到 ~30fps，避免长回答逐 token 反复解析整段 Markdown。
  // 语音播报期间降到 ~20fps：音频已经由 AudioWorklet 独立播放，正文渲染不必和声卡抢主线程。
  // 关键：界面只渲染“已揭示”的前缀，而不是 rawAnswer 全量。上游/门禁一次给来一大段
  // （例如工具轮结束后的整段正文）时，也按固定节奏逐段揭开，不会整段突然出现。
  const renderStreamingAnswer = () => {
    if (answerRenderQueued) return
    answerRenderQueued = true
    const generation = renderGeneration
    const interval = voiceSpeechStream?.active || state.voiceConversation.active ? 45 : 30
    answerRenderTimer = setTimeout(() => {
      answerRenderTimer = 0
      requestAnimationFrame(() => {
        answerRenderQueued = false
        if (generation !== renderGeneration) return
        const chars = Array.from(rawAnswer)
        const total = chars.length
        if (shownAnswerLength > total) shownAnswerLength = total
        const backlog = total - shownAnswerLength
        if (backlog > 0) {
          if (batchReveal) {
            // 成批到达（含 finish-only）按接近逐字的速度揭示，约 130 字/秒；
            // 正常 token 流不会走到这里，仍保持“有多少补多少”。
            shownAnswerLength += Math.min(backlog, 4)
          } else {
            // 正常小增量（模型逐 token 下发）直接补齐；只有明显成批到达时才限速揭开。
            shownAnswerLength += backlog <= 24 ? backlog : Math.min(60, Math.max(12, Math.ceil(backlog / 10)))
          }
          if (shownAnswerLength >= total) batchReveal = false
        }
        answer.innerHTML = renderAnswer(chars.slice(0, shownAnswerLength).join(''), { omitCodeBlocks: writtenFileContentBlocks(toolTraces) })
        scroll()
        // 一次调度只推进一帧；还有积压就继续排下一帧，形成稳定的打字节奏。
        if (shownAnswerLength < total) renderStreamingAnswer()
      })
    }, interval)
  }
  let turn = null
  const hideWaiting = () => {
    waiting.hidden = true
  }
  const showWaiting = (text = '等待回复中…') => {
    clarifySlot.hidden = true
    clarifySlot.innerHTML = ''
    answer.hidden = true
    setStatus('正在思考中…')
    waiting.hidden = false
    waitingText.textContent = text
    scroll()
  }
  const showClarifyPrompt = (clarify, options = {}) => {
    const flow = state.clarifyFlow || ensureClarifyFlow()
    flow.turn = turn
    const step = Number.isFinite(Number(options.step)) && Number(options.step) > 0
      ? Math.trunc(Number(options.step))
      : Number(flow?.step) || 1
    const previous = String(options.previous || '').trim()
    const content = clarifyPanelHtml(clarify, {
      docked: false,
      step,
      previous,
      exitable: true,
    })
    if (!content) return
    setStatus('')
    hideWaiting()
    collapseThink(true)
    if (toolTraces.length > 0) {
      toolPanel.innerHTML = toolPanelHtml(toolTraces, { active: false, expanded: false })
      toolPanel.hidden = false
      bindToolToggles(node)
    }
    rawAnswer = ''
    answer.innerHTML = ''
    answer.hidden = true
    answer.classList.remove('is-clarify-note', 'is-error')
    clarifySlot.innerHTML = content
    clarifySlot.hidden = false
    bindClarifyPanel(clarifySlot)
    state.pendingClarify = clarify
    if (state.clarifyFlow) state.clarifyFlow.turn = turn
    if (options.auto) startClarifyAutoSelect(state.clarifyFlow)
    finalScroll()
  }

  turn = {
    node,
    /** 在当前气泡内渲染方向选项，不再使用底部浮层。 */
    showClarifyPrompt(clarify, options = {}) {
      showClarifyPrompt(clarify, options)
      return this
    },
    /** 选项已提交后，在当前气泡显示“正在思考中 / 等待回复中”。 */
    waitForReply(text = '等待回复中…') {
      showWaiting(text)
      return this
    },
    clearClarifyPrompt() {
      clarifySlot.hidden = true
      clarifySlot.innerHTML = ''
      return this
    },
    /** 引导续跑时复用同一条 AI 气泡，清空上一问的内容但保留节点位置。 */
    reset(options = {}) {
      renderGeneration += 1
      if (answerRenderTimer) {
        clearTimeout(answerRenderTimer)
        answerRenderTimer = 0
      }
      answerRenderQueued = false
      startedAt = Date.now()
      reasoningStartedAt = 0
      firstAnswerAt = 0
      rawAnswer = ''
      shownAnswerLength = 0
      batchReveal = false
      answer.innerHTML = ''
      answer.hidden = true
      answer.classList.remove('is-clarify-note', 'is-error')
      think.hidden = true
      think.classList.remove('is-active')
      think.classList.add('is-collapsed')
      delete think.dataset.userToggled
      thinkTitle.textContent = '思考中'
      thinkPreview.textContent = ''
      thinkDivider.hidden = true
      thinkBody.textContent = ''
      toolTraces.length = 0
      streamToolDrafts.clear()
      finishStreamingFilePreview()
      toolPanel.innerHTML = ''
      toolPanel.hidden = true
      clarifySlot.innerHTML = ''
      clarifySlot.hidden = true
      metaLine.hidden = true
      metaLine.textContent = ''
      showWaiting(options.waitingText || '等待回复中…')
      delete node.dataset.messageId
      node.chatMessage = null
      setMessageTime(node, options.createdAt || Date.now())
      refreshMessageActions(node)
      scrollThreadToBottomInstant()
    },
    appendToThread() {
      if (node.isConnected) return
      setEmptyVisible(false)
      markMessageNew(node)
      $('#thread').appendChild(node)
      bindToolToggles(node)
      scrollThreadToBottomInstant()
    },
    hydrate(snapshot) {
      if (!snapshot) return
      if (snapshot.reasoning) this.reasoning(snapshot.reasoning)
      if (snapshot.text) this.content(snapshot.text)
      for (const trace of snapshot.toolCalls || []) {
        this.tool(trace)
        if (trace.status !== 'running') {
          this.toolResult({
            id: trace.id,
            status: trace.status,
            summary: trace.summary,
            durationMs: trace.durationMs,
          })
        }
      }
      if (snapshot.status === 'error') this.fail(snapshot.error || '回答失败')
      else if (snapshot.status === 'stopped') this.stop()
    },
    reasoning(text) {
      if (!text) return
      if (!reasoningStartedAt) reasoningStartedAt = Date.now()
      think.hidden = false
      think.classList.add('is-active')
      thinkBody.textContent += text
      thinkTitle.textContent = '思考中'
      setThinkPreview(thinkBody.textContent, true)
      setStatus('')
      thinkBody.scrollTop = thinkBody.scrollHeight
      scroll()
    },
    /** 父 Agent 等待子 Agent 时的轻量状态；一旦有思考或正文就让位。 */
    agentStatus(text, progress) {
      if (!text) return
      if (rawAnswer) return
      // 思考流式展开时不抢状态位；收起后继续显示子 Agent 进度。
      if (!think.hidden && think.classList.contains('is-active')) return
      setStatus(text, progress)
    },
    /** 团队进度卡独立于状态行存在；正文、思考结束后仍要保留在父消息里。 */
    teamProgress(progress) {
      setParentTeamProgress(progress)
    },
    content(text) {
      if (!text) return
      if (!firstAnswerAt) firstAnswerAt = Date.now()
      if (!rawAnswer) setStatus('')
      hideWaiting()
      clarifySlot.hidden = true
      clarifySlot.innerHTML = ''
      collapseThink(true)
      answer.hidden = false
      answer.classList.remove('is-clarify-note')
      rawAnswer += text
      // 一次 delta 就送来越过 120 字的整段正文，说明上游没有逐 token 下发；
      // 标记为成批揭示，避免这一大段在几帧内铺满。
      if (Array.from(text).length > 120) batchReveal = true
      renderStreamingAnswer()
    },
    tool(event) {
      const trace = { id: event.id, name: event.name, toolId: event.toolId, args: event.args, status: 'running', summary: '', durationMs: 0 }
      toolTraces.push(trace)
      setStatus('')
      updateFileActivity(trace)
      const op = fileOperationInfo(trace)
      if (op) {
        if (trace.toolId === 'office.replace' || trace.toolId === 'office.insert') {
          applyStreamingOfficePreview(trace.args?.fileId, op.path, trace.args?.elementId, op.text)
        } else {
          applyStreamingFilePreview(op.path, op.text)
        }
      }
      renderToolPanel(true)
    },
    /** 模型生成 workspace.write 参数时，同步更新右侧草稿和吊顶卡。 */
    toolDelta(event) {
      const index = Number(event?.index)
      if (!Number.isFinite(index)) return
      const draft = streamToolDrafts.get(index) || { id: '', name: '', raw: '' }
      if (event.name) draft.name = String(event.name)
      if (event.id) draft.id = String(event.id)
      const argumentsDelta = event.argsDelta || event.argumentsDelta
      if (argumentsDelta) draft.raw += String(argumentsDelta)
      streamToolDrafts.set(index, draft)
      if (isOfficeReplaceToolName(draft.name)) {
        const args = partialOfficeReplaceArgs(draft.raw)
        if (args.newText) applyStreamingOfficePreview(args.fileId, args.path, args.elementId, args.newText)
        return
      }
      if (isOfficeInsertToolName(draft.name)) {
        const args = partialOfficeInsertArgs(draft.raw)
        if (args.text) applyStreamingOfficePreview(args.fileId, args.path, args.elementId, args.text)
        return
      }
      if (!isWorkspaceWriteToolName(draft.name)) return
      const args = partialWorkspaceWriteArgs(draft.raw)
      if (!args.path && !args.text) return
      applyStreamingFilePreview(args.path, args.text)
      // 有 call id 才更新吊顶卡：tool 事件到达时按同一个 id 合并，避免多算一步。
      if (draft.id) {
        updateFileActivity({
          id: draft.id,
          name: draft.name,
          toolId: 'workspace.write',
          args: { path: args.path, text: args.text },
          status: 'running',
          summary: '',
          durationMs: 0,
        })
      }
    },
    toolResult(event) {
      const trace = toolTraces.find((item) => item.id === event.id)
      if (!trace) return
      trace.status = event.status
      trace.summary = event.summary
      trace.durationMs = event.durationMs
      if (event.diff) trace.diff = event.diff
      if (event.batch) trace.batch = event.batch
      if (event.view) trace.view = event.view
      setStatus('')
      updateFileActivity(trace)
      renderToolPanel(toolTraces.some((item) => item.status === 'running'))
      // 最后一个工具完成后收起吊顶卡；最终回答仍会保留在消息里。
      if (trace.status === 'done' && !toolTraces.some((item) => item.status === 'running')) {
        settleFileDock()
      }
      const op = fileOperationInfo(trace)
      if (op && op.status === 'done') {
        // 等右侧草稿把最后一段揭示完，再刷新真实文件，避免预览在收尾时跳一下。
        finishStreamingFilePreview(() => refreshWorkspaceAfterFileOperation(op))
      } else if (op) {
        finishStreamingFilePreview()
      }
    },
    clarify(clarify) {
      showClarifyPrompt(clarify)
    },
    finish(data) {
      setStatus('')
      if (data?.teamProgress) setParentTeamProgress(data.teamProgress)
      if (data?.createdAt) setMessageTime(node, data.createdAt)
      refreshMessageActions(node)
      mergeDoneDetails(data)
      collapseThink(true)
      if (toolTraces.length > 0) {
        const current = toolPanel.querySelector('.tool-panel')
        const wasExpanded = current ? !current.classList.contains('is-collapsed') : false
        toolPanel.innerHTML = toolPanelHtml(toolTraces, { active: false, expanded: wasExpanded })
        toolPanel.hidden = false
        bindToolToggles(node)
      }
      if (data?.clarify) {
        if (state.clarifyFlow) state.clarifyFlow.turn = turn
        showClarifyPrompt(data.clarify)
      } else {
        hideWaiting()
        setMemorySources(data?.memoryHits || [], data?.memoryScope, data?.longTermMemoryRecall || [])
        clarifySlot.hidden = true
        clarifySlot.innerHTML = ''
        const finalText = String(data?.text || '').trim()
        if (finalText) {
          // 收尾正文可能被门禁重写/服务端替换。如果和已经显示的前缀不是同一份内容，
          // 清空重播，避免“前半段旧文 + 后半段突然换成终稿”或终稿整段瞬间铺满。
          const revealed = Array.from(rawAnswer).slice(0, shownAnswerLength).join('')
          if (finalText.trim() !== rawAnswer.trim() && finalText.trim() !== revealed.trim()) {
            shownAnswerLength = 0
            batchReveal = true
            answer.innerHTML = ''
          }
          rawAnswer = finalText
        }
        answer.hidden = false
        answer.classList.remove('is-clarify-note')
        if (rawAnswer) {
          // 如果正文是随 done 一次性回来的（没有任何 delta），这里也从 0 开始按节奏揭示，
          // 而不是直接 innerHTML 全量铺开。已揭示到末尾时再补一次最终渲染，让图表完整收尾。
          const finalLength = Array.from(rawAnswer).length
          if (shownAnswerLength <= 0 || finalLength - shownAnswerLength > 120) batchReveal = true
          if (shownAnswerLength < finalLength) renderStreamingAnswer()
          else answer.innerHTML = renderAnswer(rawAnswer, { omitCodeBlocks: writtenFileContentBlocks(toolTraces) })
        } else if (!answer.textContent) answer.textContent = '（没有返回内容）'
      }
      const citations = data.citations && data.citations.length ? ` · 引用 ${data.citations.length} 条` : ''
      const speed = tokenSpeedText(data.tokens, data.timing, `${data.reasoning || ''}${data.text || ''}`)
      const thinking = think.hidden ? '' : ` · 思考 ${formatElapsed((firstAnswerAt || Date.now()) - (reasoningStartedAt || startedAt))}`
      metaLine.hidden = false
      metaLine.innerHTML = `${channelTag(data.channel)}${esc(`${data.modelName || ''}${speed ? ` · ${speed}` : ''}${data.autoSelected ? ' · 自动选择' : ''}${thinking}${citations}`)}`
      metaLine.dataset.tip = [
        data.channel === 'dingtalk' ? '来自钉钉渠道，和网页工作台共用同一份历史' : '',
        data.modelName ? `模型：${data.modelName}` : '',
        speed ? `生成速度：${speed}（每秒生成的 token 数）` : '',
        data.autoSelected ? '这个模型由系统自动选择' : '',
        thinking ? `思考耗时：${thinking.replace(/^\s*·\s*/, '')}` : '',
        citations ? `本次回答引用：${citations.replace(/^\s*·\s*/, '')}` : '',
      ]
        .filter(Boolean)
        .join('；')
      // 固定模型的会话发生故障转移时，后端已写回接替模型；气泡同步为实际接替模型。
      if (!data.autoSelected && data.fallbackFromModelId && data.modelId) {
        setSelected(data.modelId, { persist: false })
      }
      if (data.fallbackFromModelId) void refreshModelCatalog()
      finalScroll()
      if (node.isConnected) settleFileDock()
      if (data?.clarify) startClarifyAutoSelect(state.clarifyFlow)
    },
    fail(message, meta) {
      setStatus('')
      hideWaiting()
      clarifySlot.hidden = true
      clarifySlot.innerHTML = ''
      collapseThink(true)
      answer.hidden = false
      answer.classList.remove('is-clarify-note')
      if (!answer.textContent) answer.textContent = message || '回答失败'
      answer.classList.add('is-error')
      if (meta) {
        metaLine.hidden = false
        metaLine.textContent = meta
        metaLine.dataset.tip = `这次回答失败：${meta}`
      }
      if (node.isConnected) settleFileDock()
      scroll()
    },
    stop() {
      setStatus('')
      hideWaiting()
      clarifySlot.hidden = true
      clarifySlot.innerHTML = ''
      collapseThink(true)
      answer.hidden = false
      answer.classList.remove('is-clarify-note')
      if (!rawAnswer) answer.textContent = '已停止生成'
      metaLine.hidden = false
      metaLine.textContent = '已停止生成'
      metaLine.dataset.tip = '这次生成已手动停止；可以重新提问或继续追问'
      if (node.isConnected) settleFileDock()
      scroll()
    },
  }
  return turn
}

function appendTyping() {
  setEmptyVisible(false)
  const node = document.createElement('div')
  node.className = 'msg ai'
  node.innerHTML = `${aiWhoMarkup()}<div class="bubble"><span class="typing"><i></i><i></i><i></i></span></div>`
  $('#thread').appendChild(node)
  scrollThreadToBottomInstant()
  return node
}

function renderDenied(err) {
  $('#thread').innerHTML = `<div class="chat-denied">
    <strong>${esc(err.message)}</strong>
    <span class="mono">${esc(err.code || '')}${err.traceId ? ` · traceId ${esc(err.traceId)}` : ''}</span>
    <span class="mono">换一个账号登录，或让管理员在控制台里给你的角色授这个权限。</span>
  </div>`
  $('#model-chip').disabled = true
  $('#send').disabled = true
  const input = $('#input')
  input.disabled = true
  input.placeholder = '当前账号不能对话'
  $('#login-btn').hidden = false
  $('#login-btn').textContent = '切换账号'
}

/* ---------------- 附件 ---------------- */

const MAX_FILES = 4
const MAX_FILE_SIZE = 10 * 1024 * 1024
const WORKSPACE_DRAG_MIME = 'application/x-eab-workspace-ref'
const CONVERSATION_DRAG_MIME = 'application/x-eab-conversation-ref'
const WORKSPACE_FOLDER_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5A2 2 0 0 1 5.5 4.5h4l2 2h7A2 2 0 0 1 20.5 8.5v9A2 2 0 0 1 18.5 19.5h-13A2 2 0 0 1 3.5 17.5v-11Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>'
const CONVERSATION_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v7A2.5 2.5 0 0 1 17.5 15H10l-4.5 3v-3.5A2.5 2.5 0 0 1 4 12.5v-7Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M8 7.5h8M8 10.2h5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>'

function workspaceFolderSummaryText(file) {
  const fileCount = Number(file?.workspaceFileCount ?? file?.fileCount) || 0
  const folderCount = Number(file?.workspaceFolderCount ?? file?.folderCount) || 0
  return [
    fileCount ? `${fileCount} 个文件` : '',
    folderCount ? `${folderCount} 个子文件夹` : '',
  ]
    .filter(Boolean)
    .join(' · ') || '空文件夹'
}

function workspaceAttachmentKey(file) {
  if (!file) return ''
  if (file.workspaceKind === 'folder') {
    return `folder:${workspaceNormalizePath(file.workspaceFolderPath || file.workspaceRelPath)}`
  }
  const id = String(file.workspaceFileId || '').trim()
  return id ? `file:${id}` : ''
}

/** 拖进输入区后按会话保存的引用；本机临时文件不在此列。 */
function isPersistentAttachment(file) {
  return file?.persistent === true
}

function persistentReferencePayload(list = state.attachments) {
  return (Array.isArray(list) ? list : [])
    .filter(isPersistentAttachment)
    .map((file) => {
      const conversationId = String(file.conversationId || '').trim()
      if (conversationId) {
        return {
          conversationId,
          conversationTitle: String(file.conversationTitle || file.name || '').trim(),
        }
      }
      if (file.workspaceKind === 'folder') {
        return {
          name: String(file.name || '').trim(),
          workspaceKind: 'folder',
          workspaceFolderPath: workspaceNormalizePath(file.workspaceFolderPath || file.workspaceRelPath || ''),
          workspaceFileCount: Number(file.workspaceFileCount) || 0,
          workspaceFolderCount: Number(file.workspaceFolderCount) || 0,
          size: 0,
          type: 'inode/directory',
        }
      }
      const workspaceFileId = String(file.workspaceFileId || '').trim()
      if (!workspaceFileId) return null
      return {
        name: String(file.name || '').trim(),
        workspaceKind: 'file',
        workspaceFileId,
        workspaceRelPath: String(file.workspaceRelPath || '').trim(),
        workspaceMime: file.workspaceMime ?? file.type ?? null,
        size: Number(file.size) || 0,
        type: String(file.type || 'application/octet-stream'),
      }
    })
    .filter(Boolean)
}

/** 每个会话的 PUT 串行执行，快速增删时后一次状态不会被前一次覆盖。 */
const sessionReferenceSync = new Map()

function syncSessionReferences() {
  const sessionId = state.sessionId
  if (!sessionId) return Promise.resolve()
  const references = persistentReferencePayload()
  const previous = sessionReferenceSync.get(sessionId) || Promise.resolve()
  const task = previous
    .catch(() => {})
    .then(() =>
      api(`/api/chat/sessions/${encodeURIComponent(sessionId)}/references`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ references }),
      }),
    )
    .then(() => {})
    .catch((err) => {
      if (state.sessionId === sessionId) banner(`引用保存失败：${err.message}`, 'warn')
    })
  sessionReferenceSync.set(sessionId, task)
  void task.finally(() => {
    if (sessionReferenceSync.get(sessionId) === task) sessionReferenceSync.delete(sessionId)
  })
  return task
}

async function waitSessionReferenceSync(sessionId) {
  const task = sessionReferenceSync.get(sessionId)
  if (task) await task
}

function clearComposerAttachments() {
  for (const file of state.attachments) {
    if (String(file?.previewUrl || '').startsWith('blob:')) URL.revokeObjectURL(file.previewUrl)
  }
  state.attachments = []
  renderAttachments()
}

/** 服务端返回的是最小稳定字段；恢复成输入区同一个 chip 结构。 */
function attachmentFromSessionReference(ref) {
  if (!ref || typeof ref !== 'object') return null
  const conversationId = String(ref.conversationId || '').trim()
  if (conversationId) {
    const conversationTitle = String(ref.conversationTitle || ref.name || '未命名对话').trim()
    return {
      name: conversationTitle,
      size: 0,
      type: 'application/x-eab-conversation',
      source: 'conversation',
      conversationId,
      conversationTitle,
      conversationMessageCount: Number(ref.conversationMessageCount) || 0,
      conversationIsCurrent: Boolean(ref.conversationIsCurrent || conversationId === state.sessionId),
      readable: 'conversation',
      persistent: true,
      uploadId: newUploadId(),
    }
  }
  const workspaceFileId = String(ref.workspaceFileId || '').trim()
  if (workspaceFileId) {
    const type = String(ref.type || ref.workspaceMime || 'application/octet-stream')
    const isImage = type.startsWith('image/') ||
      /\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(String(ref.name || ''))
    return {
      name: String(ref.name || '云空间文件').trim(),
      size: Number(ref.size) || 0,
      type,
      source: 'workspace',
      workspaceKind: 'file',
      workspaceFileId,
      workspaceRelPath: String(ref.workspaceRelPath || '').trim(),
      workspaceFolderPath: '',
      workspaceMime: ref.workspaceMime ?? type,
      workspaceFileCount: 0,
      workspaceFolderCount: 0,
      readable: 'workspace',
      persistent: true,
      uploadId: newUploadId(),
      previewUrl: isImage ? attachmentPreviewUrl({ workspaceFileId: workspaceFileId }) : '',
    }
  }
  // 只有显式 folder 才是文件夹；workspaceRelPath 是文件自身的路径，不能拿它当文件夹路径。
  if (ref.workspaceKind !== 'folder') return null
  const folderPath = workspaceNormalizePath(ref.workspaceFolderPath || ref.workspaceRelPath || '')
  if (!folderPath) return null
  return {
    name: String(ref.name || folderPath.split('/').pop() || '云空间文件夹').trim(),
    size: 0,
    type: 'inode/directory',
    source: 'workspace',
    workspaceKind: 'folder',
    workspaceFolderPath: folderPath,
    workspaceRelPath: folderPath,
    workspaceMime: null,
    workspaceFileCount: Number(ref.workspaceFileCount) || 0,
    workspaceFolderCount: Number(ref.workspaceFolderCount) || 0,
    readable: 'workspace',
    persistent: true,
    uploadId: newUploadId(),
  }
}

function applySessionReferences(references) {
  const list = Array.isArray(references) ? references : []
  for (const file of state.attachments) {
    if (String(file?.previewUrl || '').startsWith('blob:')) URL.revokeObjectURL(file.previewUrl)
  }
  state.attachments = list
    .slice(0, MAX_FILES)
    .map(attachmentFromSessionReference)
    .filter(Boolean)
  renderAttachments()
}

/** 从侧栏拖进来的已有云空间对象：只做引用，不再复制/上传一份。 */
function addWorkspaceReference(ref) {
  const kind = ref?.kind === 'folder' ? 'folder' : 'file'
  const path = workspaceNormalizePath(ref?.path || ref?.relPath || '')
  const fileId = String(ref?.fileId || '').trim()
  if (kind === 'file' && !fileId) return
  if (kind === 'folder' && !path) return
  const key = kind === 'folder' ? `folder:${path}` : `file:${fileId}`
  if (state.attachments.some((file) => workspaceAttachmentKey(file) === key)) return
  if (state.attachments.length >= MAX_FILES) {
    banner(`一次最多引用 ${MAX_FILES} 个文件或文件夹`, 'warn')
    return
  }
  const name = String(ref.name || path.split('/').pop() || '云空间对象').trim()
  const type = kind === 'folder' ? 'inode/directory' : String(ref.mime || 'application/octet-stream')
  const isImage = kind === 'file' && (
    type.startsWith('image/') ||
    /\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(name)
  )
  state.attachments.push({
    name,
    size: kind === 'folder' ? 0 : Number(ref.size) || 0,
    type,
    source: 'workspace',
    workspaceKind: kind,
    workspaceFileId: fileId,
    workspaceRelPath: path,
    workspaceFolderPath: kind === 'folder' ? path : '',
    workspaceMime: kind === 'folder' ? null : type,
    workspaceFileCount: kind === 'folder' ? Number(ref.fileCount) || 0 : 0,
    workspaceFolderCount: kind === 'folder' ? Number(ref.folderCount) || 0 : 0,
    readable: 'workspace',
    persistent: true,
    uploadId: newUploadId(),
    previewUrl: isImage && fileId ? attachmentPreviewUrl({ workspaceFileId: fileId }) : '',
  })
  renderAttachments()
  void syncSessionReferences()
}

/** 从侧栏拖进来的对话：发送时由服务端取一次历史，模型直接读这段记忆回答。 */
function addConversationReference(ref) {
  const conversationId = String(ref?.conversationId || ref?.sessionId || '').trim()
  if (!conversationId) return
  if (state.attachments.some((file) => file.conversationId === conversationId)) return
  if (state.attachments.length >= MAX_FILES) {
    banner(`一次最多引用 ${MAX_FILES} 个文件、文件夹或对话`, 'warn')
    return
  }
  const conversationTitle = String(ref?.title || ref?.conversationTitle || '未命名对话').trim()
  state.attachments.push({
    name: conversationTitle,
    size: 0,
    type: 'application/x-eab-conversation',
    source: 'conversation',
    conversationId,
    conversationTitle,
    conversationMessageCount: 0,
    conversationIsCurrent: Boolean(ref?.current || conversationId === state.sessionId),
    readable: 'conversation',
    persistent: true,
    uploadId: newUploadId(),
  })
  renderAttachments()
  void syncSessionReferences()
}

function renderAttachments() {
  const strip = $('#attach-strip')
  if (state.attachments.length === 0) {
    strip.hidden = true
    strip.innerHTML = ''
    updateSendState()
    return
  }
  strip.hidden = false
  const activeModel = state.models.find((m) => m.id === (state.selected || state.autoModelId))
  const visionReady = !activeModel || activeModel.supportsVision !== false
  strip.innerHTML = state.attachments
    .map((file, index) => {
      const isConversation = file.source === 'conversation' || Boolean(file.conversationId)
      const isFolder = !isConversation && file.workspaceKind === 'folder'
      const isWorkspace = !isConversation && file.source === 'workspace'
      const type = String(file.type || '')
      const isImage = !isConversation && !isFolder && type.startsWith('image/')
      const previewUrl = file.previewUrl || (isImage && file.workspaceFileId ? attachmentPreviewUrl(file) : '')
      const thumb = isConversation
        ? `<span class="file-ico is-conversation" aria-hidden="true">${CONVERSATION_ICON}</span>`
        : isFolder
          ? `<span class="file-ico is-folder" aria-hidden="true">${WORKSPACE_FOLDER_ICON}</span>`
          : isImage
            ? `<img src="${esc(previewUrl)}" alt="" />`
            : `<span class="file-ico">${esc((file.name.split('.').pop() || 'FILE').slice(0, 4).toUpperCase())}</span>`
      const kind = isConversation
        ? '对话引用'
        : isFolder
          ? '文件夹引用'
          : isWorkspace
            ? '云空间引用'
            : file.readable === 'text'
              ? '文本可读'
              : file.readable === 'image'
                ? visionReady
                  ? '图片可读'
                  : '当前模型不支持图片'
                : '仅附件'
      // 对话 chip 的副标题已经说明历史范围，徽标只保留「常驻引用」，避免「对话历史 + 对话引用」重复。
      const kindText = isConversation ? '常驻引用' : isPersistentAttachment(file) ? `${kind} · 常驻` : kind
      const kindMuted = !isConversation && !isWorkspace && (file.readable === 'none' || (file.readable === 'image' && !visionReady))
      const sizeText = isConversation
        ? (Number(file.conversationMessageCount) > 0
            ? `最近 ${Number(file.conversationMessageCount)} 条消息`
            : file.conversationIsCurrent ? '本对话历史' : '对话历史')
        : isFolder ? workspaceFolderSummaryText(file) : (file.sizeLabel || fmtSize(file.size))
      const removeLabel = isPersistentAttachment(file) ? '移除引用，下一轮不再使用' : '移除'
      return `<div class="attach-chip">
        ${thumb}
        <div class="attach-meta">
          <span class="attach-name" title="${esc(file.name)}">${esc(file.name)}</span>
          <span class="attach-size">${esc(sizeText)}<span class="attach-kind ${kindMuted ? 'is-muted' : ''}">${esc(kindText)}</span></span>
        </div>
        <button class="attach-remove" type="button" data-remove="${index}" aria-label="${esc(removeLabel)}" title="${esc(removeLabel)}">×</button>
      </div>`
    })
    .join('')
  for (const button of strip.querySelectorAll('[data-remove]')) {
    button.addEventListener('click', () => {
      const index = Number(button.dataset.remove)
      const removed = state.attachments[index]
      if (removed && String(removed.previewUrl || '').startsWith('blob:')) URL.revokeObjectURL(removed.previewUrl)
      state.attachments.splice(index, 1)
      renderAttachments()
      if (isPersistentAttachment(removed)) void syncSessionReferences()
    })
  }
  updateSendState()
}

async function readClipboardImage() {
  if (!navigator.clipboard?.read) return null
  const items = await navigator.clipboard.read()
  for (const item of items) {
    const type = item.types.find((entry) => entry.startsWith('image/'))
    if (!type) continue
    const blob = await item.getType(type)
    if (!blob.size) continue
    const ext = type === 'image/jpeg' ? 'jpg' : type.split('/')[1] || 'png'
    return new File([blob], `粘贴图片-${Date.now()}.${ext}`, { type })
  }
  return null
}

async function addFiles(fileList) {
  const incoming = [...fileList]
  for (const raw of incoming) {
    if (state.attachments.length >= MAX_FILES) break
    let file = raw
    // 部分浏览器把剪贴板截图给成 0 字节 File；此时退回读剪贴板原图
    if (file.size === 0 && (file.type || '').startsWith('image/')) {
      try {
        file = (await readClipboardImage()) || file
      } catch {
        // 用户拒绝授权时继续走下面的提示
      }
    }
    if (file.size === 0 && (file.type || '').startsWith('image/')) {
      banner('没读到剪贴板图片：请在浏览器弹窗里允许读取剪贴板，或直接点「上传图片」。', 'warn')
      continue
    }
    if (file.size > MAX_FILE_SIZE) {
      banner(`「${safeFileName(file)}」超过 10MB，先不加入。`, 'warn')
      continue
    }
    const name = safeFileName(file)
    const type = file.type || 'application/octet-stream'
    if (isTextLike(file) && file.size > MAX_TEXT_ATTACHMENT_BYTES) {
      banner(`「${name}」超过单文件 4.8MB 的文本读取上限，无法保证完整读取；请拆分后再上传。`, 'warn')
      continue
    }
    const entry = {
      name,
      size: file.size,
      type,
      file,
      text: '',
      readable: 'none',
      previewUrl: type.startsWith('image/') ? URL.createObjectURL(file) : '',
      uploadId: newUploadId(),
    }
    if (isTextLike(file)) {
      try {
        entry.text = await readTextAttachment(file)
        entry.readable = entry.text ? 'text' : 'none'
      } catch {
        banner(`「${name}」文本正文读取失败，请确认文件编码或拆分后重试。`, 'bad')
        continue
      }
    } else if (type.startsWith('image/')) {
      entry.readable = 'image'
    }
    state.attachments.push(entry)
  }
  renderAttachments()
}

/* ---------------- 发送 ---------------- */

function updateSendState() {
  const input = $('#input')
  const sendButton = $('#send')
  if (!input || !sendButton) return
  const text = input.value.trim()
  const clarifyBusy = Boolean(state.clarifyFlow?.busy)
  const runtime = currentRuntime()
  const streaming = Boolean(runtime.sending)
  const hasContent = Boolean(text || state.attachments.length > 0)
  const queueSend = $('#queue-send')

  // 回复中做两个按钮的互换：右侧主按钮变暂停，左侧队列发送按钮出现。
  // 输入框保持可编辑，Enter 仍按 send() 走排队发送。
  if (streaming) {
    if (queueSend) {
      queueSend.hidden = false
      queueSend.disabled = clarifyBusy || state.models.length === 0 || !hasContent
    }
    if (sendButton.dataset.mode !== 'pause') {
      sendButton.dataset.mode = 'pause'
      sendButton.classList.add('is-stop')
      sendButton.title = '暂停当前回复'
      sendButton.setAttribute('aria-label', '暂停当前回复')
      sendButton.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="5" width="3.6" height="14" rx="1.2" fill="currentColor"/><rect x="13.4" y="5" width="3.6" height="14" rx="1.2" fill="currentColor"/></svg>'
    }
    sendButton.disabled = false
    syncMessageActionAvailability()
    return
  }

  if (queueSend) queueSend.hidden = true
  if (sendButton.dataset.mode !== 'send') {
    sendButton.dataset.mode = 'send'
    sendButton.classList.remove('is-stop')
    sendButton.title = '发送'
    sendButton.setAttribute('aria-label', '发送')
    sendButton.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11.5 20 4l-7.4 16-2.1-6.3-6.5-2.2Z" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>'
  }
  sendButton.disabled = clarifyBusy || state.models.length === 0 || !hasContent
  syncMessageActionAvailability()
}

/** 只在真的出现排队消息时提示；只有一条正在回复的消息时不占输入区。 */
function renderQueueState() {
  // 会话切换后主按钮必须跟着当前会话的 sending 状态走：
  // A 会话回复中切到 B，B 的按钮应恢复发送；切回 A 再变回暂停。
  updateSendState()
  const bar = $('#queue-bar')
  if (!bar) return
  const runtime = currentRuntime()
  const queued = runtime.queue.length
  bar.hidden = queued === 0
  if (bar.hidden) return
  const text = runtime.sending
    ? `正在回复，后面还有 ${queued} 条排队`
    : `有 ${queued} 条消息等待发送`
  const label = $('#queue-text')
  if (label) label.textContent = text
  const stop = $('#queue-stop')
  if (stop) {
    stop.textContent = '停止当前回复并发送'
    stop.disabled = !runtime.sending
  }
}

function stopCurrentReply() {
  const runtime = currentRuntime()
  if (!runtime.sending || !runtime.controller) return
  // 先通知服务端取消后台回合；只断浏览器连接不会再中止模型。
  if (runtime.runId) {
    void api(`/api/chat/runs/${encodeURIComponent(runtime.runId)}/cancel${qs()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }).catch(() => {})
  }
  runtime.controller.abort()
}

function autosize() {
  const el = $('#input')
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 180)}px`
}

/** 读取后端 SSE：meta / reasoning / delta / tool / tool_result / done / error。 */
async function streamChat(payload, onEvent, signal) {
  const response = await fetch(`/api/chat/messages${qs()}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, stream: true }),
    signal,
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    if (response.status === 401) {
      redirectToLogin()
      return waitForLoginRedirect()
    }
    const err = new Error(body?.error?.message || body?.message || `HTTP ${response.status}`)
    err.code = body?.error?.code || body?.code
    err.traceId = body?.error?.traceId || body?.traceId
    throw err
  }
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('text/event-stream') || !response.body) {
    throw new Error('服务端没有返回流式响应')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const consume = (block) => {
    let event = 'message'
    const dataLines = []
    for (const rawLine of block.split('\n')) {
      const line = rawLine.replace(/\r$/, '')
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
    }
    if (dataLines.length === 0) return
    let data = null
    try {
      data = JSON.parse(dataLines.join('\n'))
    } catch {
      return
    }
    onEvent(event, data)
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() ?? ''
    for (const block of blocks) consume(block)
  }
  buffer += decoder.decode()
  if (buffer.trim()) consume(buffer)
}

function newUploadId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replace(/-/g, '')
  } catch {
    // 老浏览器没有 randomUUID 时退回时间戳 + 随机串
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

function sanitizeChatUploadName(name) {
  let clean = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
  if (!clean) clean = '附件'
  if (clean.length <= 120) return clean
  const dot = clean.lastIndexOf('.')
  const ext = dot > 0 && clean.length - dot <= 12 ? clean.slice(dot) : ''
  return `${clean.slice(0, 120 - ext.length).trim()}${ext}`
}

function chatUploadPath(entry) {
  const now = new Date()
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return `对话附件/${day}/${entry.uploadId}/${sanitizeChatUploadName(entry.name)}`
}

async function uploadChatAttachment(entry) {
  const body = {
    path: chatUploadPath(entry),
    name: entry.name,
    mime: entry.type || 'application/octet-stream',
  }
  if (entry.readable === 'text' && entry.text) {
    body.text = entry.text
  } else if (entry.file) {
    body.contentBase64 = await readAsBase64(entry.file)
  } else {
    throw new Error('附件内容为空，无法保存到云空间')
  }
  return api(`/api/workspace/files${qs()}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** 按顺序逐个上传，避免 4 个并发写同时抢个人配额；失败只影响当前附件。 */
async function prepareChatAttachments(item) {
  const messageList = item.pending.filter((entry) => !isPersistentAttachment(entry))
  if (item.spaceKind !== 'cloud') return buildAttachmentPayload(messageList)
  for (let index = 0; index < item.pending.length; index += 1) {
    const entry = item.pending[index]
    const meta = item.attachmentMeta[index]
    if (!entry?.file || !meta || isPersistentAttachment(entry)) continue
    meta.workspaceStatus = 'pending'
    meta.clientUploadId = entry.uploadId
    delete meta.workspaceError
    updateAttachmentCards(item.node, item.attachmentMeta)
    try {
      const uploaded = await uploadChatAttachment(entry)
      entry.workspaceFileId = uploaded.id
      Object.assign(meta, {
        workspaceFileId: uploaded.id,
        workspaceRelPath: uploaded.relPath,
        workspaceMime: uploaded.mime || entry.type,
        workspaceStatus: 'active',
      })
      delete meta.workspaceError
    } catch (err) {
      meta.workspaceStatus = 'unsaved'
      meta.workspaceError = String(err?.message || '保存到云空间失败').slice(0, 120)
    }
    updateAttachmentCards(item.node, item.attachmentMeta)
  }
  return buildAttachmentPayload(messageList)
}

async function buildAttachmentPayload(list) {
  return Promise.all(
    list.map(async (item) => {
      const payload = { name: item.name, size: item.size, type: item.type }
      if (item.source === 'conversation' || item.conversationId) {
        payload.conversationId = item.conversationId
        payload.conversationTitle = item.conversationTitle || item.name
        payload.conversationIsCurrent = Boolean(item.conversationIsCurrent)
        return payload
      }
      if (item.workspaceKind === 'folder' && item.workspaceFolderPath) {
        payload.workspaceKind = 'folder'
        payload.workspaceFolderPath = item.workspaceFolderPath
        payload.workspaceRelPath = item.workspaceFolderPath
        payload.workspaceFileCount = Number(item.workspaceFileCount) || 0
        payload.workspaceFolderCount = Number(item.workspaceFolderCount) || 0
        return payload
      }
      if (item.workspaceFileId) {
        // 正文/图片已经在云空间里，消息只传文件 ID，避免把大文件再塞进聊天请求。
        payload.workspaceFileId = item.workspaceFileId
        payload.workspaceKind = 'file'
        if (item.workspaceRelPath) payload.workspaceRelPath = item.workspaceRelPath
        return payload
      }
      if (item.readable === 'text' && item.text) payload.text = item.text
      if (item.readable === 'image' && item.file) payload.dataUrl = await readAsDataUrl(item.file)
      return payload
    }),
  )
}

/** 服务端 done 里的附件元数据没有“未保存”状态，合并本地状态后重绘卡片。 */
function mergeDoneAttachments(local, server) {
  const serverList = Array.isArray(server) ? server : []
  const localList = Array.isArray(local) ? local : []
  return serverList.map((item, index) => {
    const localItem = localList[index] || {}
    const merged = { ...item }
    if (merged.workspaceFileId) {
      merged.workspaceStatus = 'active'
    } else if (localItem.workspaceStatus === 'unsaved') {
      merged.workspaceStatus = 'unsaved'
      merged.workspaceError = localItem.workspaceError
    }
    return merged
  })
}

let voiceRecorder = null
let voiceChunks = []
let voiceStartedAt = 0
let voiceTimer = 0
let voiceStream = null
let voiceDiscount = false
let voiceTranscribing = false
let voiceAudioContext = null
let voiceAnalyser = null
let voiceVadTimer = 0
let voiceVadData = null
let voiceSpeechFrames = 0

/** 语音唤醒独立采集链，和正式对话录音互斥，避免同时抢麦克风。 */
let wakeRecorder = null
let wakeChunks = []
let wakeStream = null
let wakeStartedAt = 0
let wakeSpeechStarted = false
let wakeSpeechMs = 0
let wakeSilenceMs = 0
let wakeNoSpeechMs = 0
let wakeThreshold = 0.012
let wakeCalibrating = true
let wakeCalibrationUntil = 0
let wakeCalibrationSamples = []
let wakeSpeechFrames = 0
let wakeDiscounted = false
let wakeTranscribing = false
let wakeTimer = 0
let wakeAudioContext = null
let wakeAnalyser = null
let wakeVadTimer = 0
let wakeVadData = null
const WAKE_PREF_KEY = 'eab.voiceWake.enabled'
const WAKE_MAX_SEGMENT_MS = 15_000
const WAKE_IDLE_RESTART_MS = 20_000

/** 连续语音的流式播报：文本边生成边按句合成 PCM，Web Audio 按时间轴排队播放。 */
let voiceSpeechStream = null
let voicePlaybackContext = null
let voiceWorkletNode = null
let voiceWorkletContext = null
let voiceWorkletReady = null
let voiceWorkletFilter = null
let voiceWorkletFailed = false
let voiceBargeStream = null
let voiceBargeContext = null
let voiceBargeTimer = 0
let voiceBargeData = null
const VOICE_PCM_SAMPLE_RATE = 24_000
// 首块到达后先攒一小段再起播，吸收网络与上游合成的抖动；后续句子沿用同一条时间轴。
// 长句按约 60 字切开，保证单次合成时长不超过 11 秒，避免上游 RTF>1 把缓冲吃穿。
const VOICE_PREBUFFER_SECONDS = 0.9
const VOICE_REBUFFER_SECONDS = 0.2

function voicePlayback() {
  if (voicePlaybackContext && voicePlaybackContext.state !== 'closed') {
    if (voicePlaybackContext.state === 'suspended') void voicePlaybackContext.resume().catch(() => {})
    return voicePlaybackContext
  }
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext
  if (!AudioContextCtor) return null
  // 直接按 24kHz 建上下文，避免每个 PCM 块都被浏览器单独重采样。
  try {
    voicePlaybackContext = new AudioContextCtor({
      // 语音播报优先连续、少爆音；交互延迟由预缓冲兜住，不需要 audio thread 的最小延迟。
      latencyHint: 'playback',
      sampleRate: VOICE_PCM_SAMPLE_RATE,
    })
  } catch {
    voicePlaybackContext = new AudioContextCtor({ latencyHint: 'playback' })
  }
  // 换了 AudioContext 后旧 worklet 节点失效；下一次播放会重新加载模块。
  voiceWorkletNode = null
  voiceWorkletContext = null
  voiceWorkletFilter = null
  voiceWorkletReady = null
  voiceWorkletFailed = false
  void voicePlaybackContext.resume().catch(() => {})
  return voicePlaybackContext
}

function closeVoicePlayback() {
  const context = voicePlaybackContext
  voicePlaybackContext = null
  voiceWorkletNode = null
  voiceWorkletContext = null
  voiceWorkletFilter = null
  voiceWorkletReady = null
  if (context && context.state !== 'closed') void context.close().catch(() => {})
}

function stopVoiceBargeInMonitor() {
  window.clearInterval(voiceBargeTimer)
  voiceBargeTimer = 0
  voiceBargeData = null
  const context = voiceBargeContext
  voiceBargeContext = null
  if (context && context.state !== 'closed') void context.close().catch(() => {})
  for (const track of voiceBargeStream?.getTracks?.() || []) track.stop()
  voiceBargeStream = null
}

/**
 * 播报期间单独监测麦克风：用户一开口就停播并回到聆听。
 * echoCancellation 让同一台机器外放的 TTS 尽量不被当成用户语音。
 */
async function startVoiceBargeInMonitor(generation) {
  if (voiceBargeStream) return
  const vm = state.voiceConversation
  if (!vm.active || generation !== vm.generation) return
  try {
    voiceBargeStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
  } catch {
    return
  }
  if (!vm.active || generation !== vm.generation || vm.phase !== 'speaking') {
    for (const track of voiceBargeStream?.getTracks?.() || []) track.stop()
    voiceBargeStream = null
    return
  }
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext
  if (!AudioContextCtor) {
    stopVoiceBargeInMonitor()
    return
  }
  try {
    voiceBargeContext = new AudioContextCtor()
    const source = voiceBargeContext.createMediaStreamSource(voiceBargeStream)
    const analyser = voiceBargeContext.createAnalyser()
    analyser.fftSize = 1024
    analyser.smoothingTimeConstant = 0.45
    source.connect(analyser)
    voiceBargeData = new Uint8Array(analyser.fftSize)
    void voiceBargeContext.resume().catch(() => {})
    const startedAt = Date.now()
    let baseline = []
    let threshold = 0.03
    let frames = 0
    voiceBargeTimer = window.setInterval(() => {
      if (!analyser || !voiceBargeData) return
      if (!vm.active || generation !== vm.generation) {
        stopVoiceBargeInMonitor()
        return
      }
      analyser.getByteTimeDomainData(voiceBargeData)
      let sum = 0
      for (const value of voiceBargeData) {
        const centered = (value - 128) / 128
        sum += centered * centered
      }
      const rms = Math.sqrt(sum / voiceBargeData.length)
      const now = Date.now()
      // 刚开播的前 350ms 用来校准外放回声与房间底噪。
      if (now - startedAt < 350) {
        baseline.push(rms)
        if (baseline.length > 6) baseline.shift()
        const average = baseline.reduce((total, value) => total + value, 0) / Math.max(1, baseline.length)
        threshold = Math.max(0.014, Math.min(0.06, average * 2.5))
        return
      }
      if (rms > threshold && rms > 0.012) frames += 1
      else frames = 0
      // 连续 4 帧（约 360ms）才打断：既能及时接话，又不因咳嗽或短促回声误触发。
      if (frames >= 4) {
        frames = 0
        stopVoiceBargeInMonitor()
        abortVoiceSpeechStream({ quiet: true })
        setVoiceDockStatus('listening', '检测到你说话，已停止播报', '继续说，停顿约 1 秒后会自动发送')
        scheduleVoiceConversationListen(140, true)
      }
    }, 90)
  } catch {
    stopVoiceBargeInMonitor()
  }
}

function cleanSpeechSegment(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)、]\s+/gm, '')
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 从流式文本里切出已经说完的句子。
 * 只在句末标点/换行处切，避免把“3.14”或“2026.11”拆成两段；
 * 极长无标点段落超过 600 字时硬切，防止单句请求过大。
 */
function takeVoiceSpeechSentences(buffer) {
  const text = String(buffer || '')
  const sentences = []
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if ('。！？!?；;\n'.includes(char)) {
      const piece = text.slice(start, index + 1).trim()
      if (piece) sentences.push(piece)
      start = index + 1
      continue
    }
    if (index - start >= 600) {
      const piece = text.slice(start, index + 1).trim()
      if (piece) sentences.push(piece)
      start = index + 1
    }
  }
  return { sentences, rest: text.slice(start) }
}

/** 播报时机：whole=等整段回答写完再合成，delta 阶段不入队。 */
function voiceSpeechDeferred() {
  return state.voiceSettings.speechMode === 'whole'
}

/** LLM 每吐出一句完整中文，就入队；上一句还在播时，下一句已经在合成。 */
function feedVoiceSpeechStream(text) {
  const stream = voiceSpeechStream
  if (!stream || !stream.active) return
  const piece = String(text || '')
  stream.received += piece
  stream.pending += piece
  const { sentences, rest } = takeVoiceSpeechSentences(stream.pending)
  stream.pending = rest
  let added = 0
  for (const sentence of sentences) {
    const cleaned = cleanSpeechSegment(sentence)
    if (!cleaned) continue
    stream.queue.push(cleaned)
    added += 1
  }
  if (added && !stream.startedAudio) {
    setVoiceDockStatus('thinking', '正在准备第一句…', '回答边生成边播报，后面的句子会在播放时继续合成')
  }
  if (added) void pumpVoiceSpeechStream(stream)
}

function stopVoiceSpeechSources(stream) {
  for (const source of stream.sources) {
    try {
      source.stop()
    } catch {
      // 已经自然结束的 source 再 stop 会抛 InvalidStateError
    }
  }
  stream.sources.clear()
}

function beginVoiceSpeechStream(node, generation) {
  const vm = state.voiceConversation
  if (!state.speechAvailable || !state.voiceSettings.enabled) return null
  const previous = voiceSpeechStream
  if (previous) abortVoiceSpeechStream({ quiet: true })
  const context = voicePlayback()
  if (!context) return null
  const stream = {
    active: true,
    node,
    generation,
    controller: new AbortController(),
    received: '',
    pending: '',
    queue: [],
    pumping: false,
    textComplete: false,
    startedAudio: false,
    audioStarted: false,
    useWorklet: false,
    workletChecked: false,
    workletDrained: true,
    nextStart: 0,
    underruns: 0,
    sources: new Set(),
    context,
    failed: false,
    prebuffer: VOICE_PREBUFFER_SECONDS,
  }
  voiceSpeechStream = stream
  if (voiceWorkletNode && voiceWorkletContext === context) {
    voiceWorkletNode.port.postMessage({ type: 'reset' })
  }
  const dock = document.querySelector('#voice-dock')
  if (dock) {
    dock.dataset.voiceUnderruns = '0'
    dock.dataset.voiceSampleRate = String(context.sampleRate)
  }
  setVoiceDockStatus(
    'thinking',
    '正在生成回答…',
    voiceSpeechDeferred()
      ? '整段播报：回答写完后一次性合成再播放'
      : '第一句说完就会开始播报，不用等整段回答',
  )
  return stream
}

function maybeFinishVoiceSpeech(stream) {
  if (!stream.active || !stream.textComplete || stream.pumping || stream.queue.length) return
  if (stream.sources.size) return
  if (stream.useWorklet && !stream.workletDrained) return
  stream.active = false
  stopVoiceBargeInMonitor()
  if (voiceSpeechStream === stream) voiceSpeechStream = null
  const vm = state.voiceConversation
  if (!vm.active || stream.generation !== vm.generation) return
  setVoiceDockStatus('listening', '回答播报完毕', '继续说话即可开始下一轮')
  scheduleVoiceConversationListen(260)
}

function abortVoiceSpeechStream(options = {}) {
  const stream = voiceSpeechStream
  if (!stream) return
  stream.active = false
  stream.controller.abort()
  stopVoiceSpeechSources(stream)
  stream.queue.length = 0
  stream.pending = ''
  if (stream.useWorklet && voiceWorkletNode && voiceWorkletContext === stream.context) {
    voiceWorkletNode.port.postMessage({ type: 'reset' })
  }
  stopVoiceBargeInMonitor()
  if (voiceSpeechStream === stream) voiceSpeechStream = null
  if (options.quiet) return
  if (state.voiceConversation.active) {
    setVoiceDockStatus('paused', '语音播报中断', '文字回答已保留；点“继续聆听”继续语音对话')
  }
}

function handleVoiceWorkletMessage(event) {
  const stream = voiceSpeechStream
  if (!stream || !stream.active || !stream.useWorklet) return
  const type = event?.data?.type
  if (type === 'started') {
    markVoiceAudioStarted(stream)
    return
  }
  if (type === 'underrun') {
    stream.underruns = (stream.underruns || 0) + 1
    const dock = document.querySelector('#voice-dock')
    if (dock) dock.dataset.voiceUnderruns = String(stream.underruns)
    return
  }
  if (type === 'drained') {
    stream.workletDrained = true
    maybeFinishVoiceSpeech(stream)
  }
}

/**
 * 用 AudioWorklet 在音频线程里持续消费 PCM。
 * 旧实现每 80ms 新建一个 AudioBufferSourceNode，块边界反复起停既会咔哒，也会被主线程渲染拖累。
 */
async function ensureVoiceWorklet(context) {
  if (voiceWorkletFailed || !context?.audioWorklet || context.sampleRate !== VOICE_PCM_SAMPLE_RATE) return null
  if (voiceWorkletNode && voiceWorkletContext === context) return voiceWorkletNode
  if (!voiceWorkletReady) {
    voiceWorkletReady = context.audioWorklet
      .addModule('/voice-pcm-player-worklet.js?v=20261123audio4')
      .then(() => {
        const node = new AudioWorkletNode(context, 'eab-voice-pcm-player', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          processorOptions: {
            sourceRate: VOICE_PCM_SAMPLE_RATE,
            prebufferSeconds: 0.8,
            fadeSeconds: 0.006,
          },
        })
        node.port.onmessage = handleVoiceWorkletMessage
        // 60Hz 高通去掉低频嗡声/直流偏置；语音主频远高于这里，不会削弱清晰度。
        const filter = context.createBiquadFilter()
        filter.type = 'highpass'
        filter.frequency.value = 60
        filter.Q.value = 0.7
        node.connect(filter)
        filter.connect(context.destination)
        voiceWorkletNode = node
        voiceWorkletContext = context
        voiceWorkletFilter = filter
        const dock = document.querySelector('#voice-dock')
        if (dock) dock.dataset.voiceEngine = 'worklet'
        return node
      })
      .catch(() => {
        voiceWorkletFailed = true
        return null
      })
  }
  return voiceWorkletReady
}

function scheduleWorkletPcmChunk(stream, bytes) {
  if (!voiceWorkletNode || voiceWorkletContext !== stream.context) return
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  stream.workletDrained = false
  stream.startedAudio = true
  voiceWorkletNode.port.postMessage({ type: 'pcm', buffer: copy.buffer }, [copy.buffer])
}

function schedulePcmChunk(stream, bytes) {
  if (!stream.active || bytes.byteLength < 2) return
  if (stream.useWorklet) {
    scheduleWorkletPcmChunk(stream, bytes)
    return
  }
  scheduleLegacyPcmChunk(stream, bytes)
}

function markVoiceAudioStarted(stream) {
  if (stream.audioStarted) return
  stream.audioStarted = true
  const vm = state.voiceConversation
  if (!vm.active || stream.generation !== vm.generation) return
  setVoiceDockStatus('speaking', '正在同步播报…', '回答还在生成，语音已按句跟上')
  void startVoiceBargeInMonitor(stream.generation)
}

function scheduleLegacyPcmChunk(stream, bytes) {
  const context = stream.context
  if (!context || context.state === 'closed') return
  const frames = Math.floor(bytes.byteLength / 2)
  if (!frames) return
  const buffer = context.createBuffer(1, frames, VOICE_PCM_SAMPLE_RATE)
  const channel = buffer.getChannelData(0)
  for (let index = 0; index < frames; index += 1) {
    const offset = index * 2
    const value = (bytes[offset] | (bytes[offset + 1] << 8)) << 16 >> 16
    channel[index] = value / 32768
  }
  if (context.state === 'suspended') void context.resume().catch(() => {})
  const source = context.createBufferSource()
  source.buffer = buffer
  source.connect(context.destination)
  const now = context.currentTime
  // 播放时间轴已经落后于当前时间，说明上一段缓冲被网络抖动吃完；重新攒一小段再继续，
  // 否则每一块都会以“已过期”的时间起播，听起来就是连续卡顿。
  if (stream.nextStart && stream.nextStart < now + 0.03) {
    stream.nextStart = now + VOICE_REBUFFER_SECONDS
    stream.underruns = (stream.underruns || 0) + 1
    const dock = document.querySelector('#voice-dock')
    if (dock) dock.dataset.voiceUnderruns = String(stream.underruns)
  }
  const lead = stream.startedAudio ? 0.16 : stream.prebuffer || VOICE_PREBUFFER_SECONDS
  const when = Math.max(now + lead, stream.nextStart)
  stream.nextStart = when + buffer.duration
  stream.sources.add(source)
  source.onended = () => {
    stream.sources.delete(source)
    maybeFinishVoiceSpeech(stream)
  }
  try {
    source.start(when)
  } catch {
    stream.sources.delete(source)
  }
  if (!stream.startedAudio) {
    stream.startedAudio = true
    // 旧路径没有音频线程回调，按首个 source 的真实起播时间再标记，避免预缓冲期间就启动打断监听。
    const delay = Math.max(0, (when - now) * 1000)
    window.setTimeout(() => {
      if (stream.active) markVoiceAudioStarted(stream)
    }, delay)
  }
}

async function playVoiceSpeechSegment(stream, text) {
  const response = await fetch(`/api/chat/speech/stream${qs()}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: stream.controller.signal,
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    throw new Error(payload?.error?.message || payload?.message || `HTTP ${response.status}`)
  }
  if (!response.body) throw new Error('流式语音没有返回音频')
  const sampleRate = Number(response.headers.get('x-audio-sample-rate')) || VOICE_PCM_SAMPLE_RATE
  if (sampleRate !== VOICE_PCM_SAMPLE_RATE) {
    throw new Error(`流式语音采样率 ${sampleRate}Hz，当前播放器只支持 ${VOICE_PCM_SAMPLE_RATE}Hz`)
  }
  if (!stream.workletChecked) {
    stream.workletChecked = true
    const node = await ensureVoiceWorklet(stream.context)
    if (!stream.active) return
    if (node) {
      stream.useWorklet = true
      stream.workletDrained = true
    } else {
      const dock = document.querySelector('#voice-dock')
      if (dock) dock.dataset.voiceEngine = 'legacy'
    }
  }
  const reader = response.body.getReader()
  let carry = new Uint8Array(0)
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!stream.active) {
        void reader.cancel().catch(() => {})
        return
      }
      let chunk = value
      if (carry.byteLength) {
        const merged = new Uint8Array(carry.byteLength + value.byteLength)
        merged.set(carry)
        merged.set(value, carry.byteLength)
        chunk = merged
      }
      const usable = chunk.byteLength - (chunk.byteLength % 2)
      if (usable > 0) schedulePcmChunk(stream, chunk.subarray(0, usable))
      carry = usable < chunk.byteLength ? chunk.subarray(usable) : new Uint8Array(0)
    }
  } finally {
    reader.releaseLock()
  }
  if (stream.useWorklet && voiceWorkletNode && voiceWorkletContext === stream.context) {
    voiceWorkletNode.port.postMessage({ type: 'end' })
  }
}

async function pumpVoiceSpeechStream(stream) {
  if (stream.pumping) return
  stream.pumping = true
  try {
    while (stream.active && stream.queue.length) {
      const segment = stream.queue.shift()
      if (!segment) continue
      await playVoiceSpeechSegment(stream, segment)
    }
  } catch (err) {
    if (!stream.active || err?.name === 'AbortError') return
    stream.failed = true
    stream.active = false
    stopVoiceSpeechSources(stream)
    stopVoiceBargeInMonitor()
    if (voiceSpeechStream === stream) voiceSpeechStream = null
    if (state.voiceConversation.active) {
      setVoiceDockStatus('paused', '语音播放失败', err.message || '文字回答已保留；可点“继续聆听”')
    }
  } finally {
    stream.pumping = false
    maybeFinishVoiceSpeech(stream)
  }
}

function endVoiceSpeechStream(stream, fullText) {
  if (!stream) return
  const vm = state.voiceConversation
  if (!vm.active || stream.generation !== vm.generation) {
    abortVoiceSpeechStream({ quiet: true })
    return
  }
  const text = String(fullText || '').trim()
  if (!stream.received && text) feedVoiceSpeechStream(text)
  else if (text && text.length > stream.received.length && text.startsWith(stream.received)) {
    feedVoiceSpeechStream(text.slice(stream.received.length))
  }
  stream.textComplete = true
  // 最后一段可能没有句末标点（例如列表项），收尾时补入队；每一句仍然复用同一个锚点。
  const tail = cleanSpeechSegment(stream.pending)
  stream.pending = ''
  if (tail) stream.queue.push(tail)
  if (!stream.startedAudio && stream.queue.length) {
    setVoiceDockStatus('thinking', '正在准备语音…', '按句合成，第一句马上开始播报')
  }
  void pumpVoiceSpeechStream(stream)
  maybeFinishVoiceSpeech(stream)
}

function stopVoiceVad() {
  window.clearInterval(voiceVadTimer)
  voiceVadTimer = 0
  voiceAnalyser = null
  voiceVadData = null
  voiceSpeechFrames = 0
  const context = voiceAudioContext
  voiceAudioContext = null
  if (context) void context.close().catch(() => {})
}

function voiceSupported() {
  return Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder)
}

function resetVoiceUi() {
  window.clearInterval(voiceTimer)
  voiceTimer = 0
  stopVoiceVad()
  for (const track of voiceStream?.getTracks?.() || []) track.stop()
  voiceStream = null
  renderVoiceControls()
}

async function startVoiceRecording() {
  const generation = state.voiceConversation.generation
  if (voiceRecorder || voiceTranscribing) return false
  if (!voiceSupported()) {
    setVoiceDockStatus('error', '当前浏览器不支持录音', '请换用 Chrome、Edge 或钉钉内置浏览器')
    return false
  }
  try {
    voiceStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
  } catch {
    setVoiceDockStatus('error', '没有拿到麦克风权限', '请在浏览器设置里允许录音后点“重试”')
    return false
  }
  if (!state.voiceConversation.active || generation !== state.voiceConversation.generation) {
    for (const track of voiceStream?.getTracks?.() || []) track.stop()
    voiceStream = null
    return false
  }
  const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
  const mime = preferred.find((type) => window.MediaRecorder.isTypeSupported?.(type)) || ''
  try {
    voiceRecorder = new MediaRecorder(voiceStream, mime ? { mimeType: mime } : undefined)
  } catch {
    resetVoiceUi()
    setVoiceDockStatus('error', '当前浏览器无法启动录音', '请换用 Chrome 或 Edge 后重试')
    return false
  }
  const vm = state.voiceConversation
  vm.stopReason = ''
  vm.turnStartedAt = Date.now()
  vm.speechStarted = false
  vm.speechMs = 0
  vm.silenceMs = 0
  vm.level = 0
  vm.threshold = 0.012
  vm.calibrating = true
  vm.calibrationUntil = vm.turnStartedAt + 650
  vm.calibrationSamples = []
  voiceSpeechFrames = 0
  voiceChunks = []
  voiceStartedAt = Date.now()
  voiceDiscount = false
  voiceRecorder.ondataavailable = (event) => {
    if (event.data?.size) voiceChunks.push(event.data)
  }
  voiceRecorder.onstop = () => {
    const chunks = voiceChunks.slice()
    const type = voiceRecorder?.mimeType || 'audio/webm'
    const stopReason = state.voiceConversation.stopReason
    voiceRecorder = null
    voiceChunks = []
    resetVoiceUi()
    if (voiceDiscount) return
    if (!state.voiceConversation.active) return
    if (stopReason === 'no-speech' || !chunks.length) {
      setVoiceDockStatus('listening', '没有听到声音', '再说一遍，或点“退出”结束语音对话')
      scheduleVoiceConversationListen(500)
      return
    }
    void transcribeVoice(new Blob(chunks, { type }), { generation })
  }
  voiceRecorder.start()
  setVoiceDockStatus('listening', '正在聆听', '直接说话，停顿约 1 秒后会自动发送')
  startVoiceVad(voiceStream, generation)
  const maxMs = vm.maxMs
  voiceTimer = window.setInterval(() => {
    if (!voiceRecorder) return
    if (Date.now() - voiceStartedAt >= maxMs) stopVoiceRecording(false, { reason: 'max' })
  }, 1000)
  return true
}

/** 用 Web Audio 的 RMS 做轻量 VAD：检测开口、停顿自动断句并更新状态条音量。 */
function startVoiceVad(stream, generation) {
  stopVoiceVad()
  const vm = state.voiceConversation
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext
  if (!AudioContextCtor) return
  try {
    voiceAudioContext = new AudioContextCtor()
    const source = voiceAudioContext.createMediaStreamSource(stream)
    voiceAnalyser = voiceAudioContext.createAnalyser()
    voiceAnalyser.fftSize = 1024
    voiceAnalyser.smoothingTimeConstant = 0.45
    source.connect(voiceAnalyser)
    voiceVadData = new Uint8Array(voiceAnalyser.fftSize)
    // 录音授权通常已允许音频上下文运行；仍主动 resume 一次，避免个别浏览器把新建上下文停在 suspended。
    void voiceAudioContext.resume().catch(() => {})
  } catch {
    stopVoiceVad()
    return
  }
  voiceVadTimer = window.setInterval(() => {
    if (!voiceAnalyser || !voiceVadData) return
    if (generation !== vm.generation || !vm.active) return
    voiceAnalyser.getByteTimeDomainData(voiceVadData)
    let sum = 0
    for (const value of voiceVadData) {
      const centered = (value - 128) / 128
      sum += centered * centered
    }
    const rms = Math.sqrt(sum / voiceVadData.length)
    vm.level = Math.min(1, rms * 6)
    const dock = $('#voice-dock')
    if (dock) dock.style.setProperty('--voice-level', vm.level.toFixed(3))
    const now = Date.now()
    if (vm.calibrating) {
      vm.calibrationSamples.push(rms)
      if (now >= vm.calibrationUntil || vm.calibrationSamples.length >= 8) {
        const average = vm.calibrationSamples.reduce((total, value) => total + value, 0) / Math.max(1, vm.calibrationSamples.length)
        vm.threshold = Math.max(0.01, Math.min(0.06, average * 2.6))
        vm.calibrating = false
      }
      return
    }
    if (!vm.speechStarted) {
      if (rms > vm.threshold && rms > 0.016) voiceSpeechFrames += 1
      else voiceSpeechFrames = 0
      if (voiceSpeechFrames >= 3) {
        vm.speechStarted = true
        vm.speechMs = 240
        vm.silenceMs = 0
        setVoiceDockStatus('listening', '听到了，请继续', '说完后停顿约 1 秒，我会自动发送')
      } else if (now - vm.turnStartedAt >= vm.noSpeechTimeout) {
        stopVoiceRecording(false, { reason: 'no-speech' })
      }
      return
    }
    vm.speechMs += 90
    if (rms > Math.max(0.012, vm.threshold * 0.72)) vm.silenceMs = 0
    else vm.silenceMs += 90
    if (vm.speechMs >= 800 && vm.silenceMs >= 1_150) {
      stopVoiceRecording(false, { reason: 'silence' })
    }
  }, 90)
}

function stopVoiceRecording(discount = false, meta = {}) {
  // 续听定时器可能在“没有听到声音”后的 500ms 空档里等待触发，用户点“结束这句”时要一并取消。
  window.clearTimeout(state.voiceConversation.resumeTimer)
  state.voiceConversation.resumeTimer = 0
  voiceDiscount = Boolean(discount)
  state.voiceConversation.stopReason = String(meta.reason || (discount ? 'cancel' : 'manual'))
  if (!voiceRecorder) {
    resetVoiceUi()
    return
  }
  try {
    voiceRecorder.stop()
  } catch {
    resetVoiceUi()
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('读取录音失败'))
    reader.readAsDataURL(blob)
  })
}

async function transcribeVoice(blob, options = {}) {
  const generation = Number(options.generation ?? state.voiceConversation.generation)
  if (!state.voiceConversation.active || generation !== state.voiceConversation.generation) return
  if (blob.size < 600) {
    setVoiceDockStatus('listening', '没有听清', '请再说一遍，停顿后会自动发送')
    scheduleVoiceConversationListen(400)
    return
  }
  voiceTranscribing = true
  renderVoiceControls()
  setVoiceDockStatus('transcribing', '正在识别语音…', '识别完成后会直接发送')
  const input = $('#input')
  try {
    const rawDataUrl = await blobToDataUrl(blob)
    // MediaRecorder 的 blob.type 会带 codecs 参数；上传前收敛成基础 MIME，避免服务端把参数当成文件名/类型。
    const baseType = (blob.type || 'audio/webm').split(';')[0].toLowerCase()
    const dataUrl = rawDataUrl.replace(/^data:(audio\/[^;,]+)(?:;[^;,]*)*;base64,/i, `data:${baseType};base64,`)
    const result = await api('/api/chat/transcribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dataUrl }),
    })
    const text = String(result?.text || '').trim()
    if (!text) throw new Error('没有识别出文字，请再说一遍')
    if (!state.voiceConversation.active || generation !== state.voiceConversation.generation) return
    input.value = text
    input.style.height = '44px'
    updateSendState()
    state.voiceConversation.phase = 'thinking'
    setVoiceDockStatus('thinking', '正在思考回答…', `已识别：“${text.length > 26 ? `${text.slice(0, 26)}…` : text}”`)
    if (state.clarifyFlow && state.pendingClarify) {
      advanceClarifyFlow(text, { voiceConversation: true })
      return
    }
    await send({ voiceInput: true, voiceConversation: true })
  } catch (err) {
    if (!state.voiceConversation.active || generation !== state.voiceConversation.generation) return
    setVoiceDockStatus('error', '语音识别失败', err.message || '请再说一遍，或退出语音对话')
  } finally {
    voiceTranscribing = false
    renderVoiceControls()
  }
}

async function send(options = {}) {
  if (!options.voiceInput && state.voiceConversation.active) exitVoiceConversation({ silent: true })
  const input = $('#input')
  const text = input.value.trim()
  if (!text && state.attachments.length === 0) return
  if (handleModelCommand(text)) {
    input.value = ''
    input.style.height = '44px'
    updateSendState()
    return
  }
  // 引导式澄清还开着时，底部输入框里的内容也算当前这一步的回答；
  // 直接续跑同一个澄清流程，不落成普通用户消息。
  if (state.clarifyFlow && state.pendingClarify && state.attachments.length === 0) {
    if (state.clarifyFlow.busy) return
    input.value = ''
    input.style.height = '44px'
    updateSendState()
    advanceClarifyFlow(text, { voiceConversation: options.voiceConversation === true })
    return
  }
  // 只要用户真正发了消息（包括带附件），底部澄清就完成使命。
  clearClarifyDock()

  // 编辑后重发：先回退到被编辑消息之前，再按正常发送走一遍，
  // 避免旧提问和旧回答继续留在模型上下文里。
  if (state.messageEdit) {
    const edit = state.messageEdit
    if (state.sessionId !== edit.sessionId) {
      cancelMessageEdit({ clearInput: true, silent: true })
      banner('会话已切换，编辑已取消', 'warn')
      return
    }
    if (sessionReplyBusy()) {
      banner('回复结束后再发送编辑后的消息', 'warn')
      return
    }
    try {
      const result = await deleteMessageApi(edit.id, 'after')
      removeDeletedMessageNodes(result.deletedIds)
      state.messageEdit = null
      renderMessageEditBar()
    } catch (err) {
      banner(`替换原消息失败：${err.message}`, 'bad')
      return
    }
  }

  if (state.sessionId) {
    markSessionActive(state.sessionId)
    renderSessions()
  }

  const modelId = state.selected || null
  const pending = state.attachments.slice()
  const spaceKind = state.spaceKind
  const attachmentMeta = pending.map((file) => {
    const base = {
      name: file.name,
      size: file.size,
      type: file.type,
      clientUploadId: file.uploadId,
      ...(isPersistentAttachment(file) ? { persistent: true } : {}),
    }
    if (file.source === 'conversation') {
      return {
        ...base,
        conversationId: file.conversationId,
        conversationTitle: file.conversationTitle || file.name,
        conversationIsCurrent: Boolean(file.conversationIsCurrent),
      }
    }
    if (file.source === 'workspace') {
      if (file.workspaceKind === 'folder') {
        return {
          ...base,
          workspaceKind: 'folder',
          workspaceFolderPath: file.workspaceFolderPath,
          workspaceRelPath: file.workspaceRelPath,
          workspaceFileCount: Number(file.workspaceFileCount) || 0,
          workspaceFolderCount: Number(file.workspaceFolderCount) || 0,
        }
      }
      return {
        ...base,
        workspaceKind: 'file',
        workspaceFileId: file.workspaceFileId,
        workspaceRelPath: file.workspaceRelPath,
        workspaceMime: file.workspaceMime || file.type,
        workspaceStatus: 'active',
      }
    }
    return {
      ...base,
      ...(spaceKind === 'cloud' ? { workspaceStatus: 'pending' } : {}),
    }
  })

  const runtime = currentRuntime()
  const item = {
    text,
    modelId,
    reasoningEffort: state.reasoningEffort || null,
    pending,
    attachmentMeta,
    spaceKind,
    sessionId: state.sessionId,
    runtimeKey: runtime.key,
    voiceInput: Boolean(options.voiceInput),
    voiceConversation: Boolean(options.voiceConversation),
    createdAt: Date.now(),
    node: null,
  }

  // 打断模式：新消息优先。只丢当前会话尚未发送的旧排队项，并中止当前会话回复；
  // 其它会话的回复不受影响。
  if (runtime.sending && state.chatSendMode === 'interrupt') {
    const dropped = runtime.queue.splice(0)
    for (const queued of dropped) {
      queued.node?.remove()
      for (const file of queued.pending) {
        if (String(file.previewUrl || '').startsWith('blob:')) URL.revokeObjectURL(file.previewUrl)
      }
    }
    stopCurrentReply()
  }

  runtime.queue.push(item)
  input.value = ''
  input.style.height = '44px'
  item.node = appendMessage('me', text, undefined, attachmentMeta, undefined, { createdAt: item.createdAt, animate: true })
  scrollThreadToBottomInstant()

  state.attachments = pending.filter(isPersistentAttachment)
  renderAttachments()
  for (const file of pending) {
    if (!isPersistentAttachment(file) && String(file.previewUrl || '').startsWith('blob:')) URL.revokeObjectURL(file.previewUrl)
  }

  renderQueueState()
  void drainQueue(runtime)
}

/** 依次消费某个会话的排队消息；各会话独立，互不阻塞。 */
async function drainQueue(runtime = currentRuntime()) {
  if (runtime.sending) return
  const item = runtime.queue.shift()
  if (!item) {
    renderQueueState()
    return
  }

  runtime.sending = true
  renderSessions()
  const controller = new AbortController()
  runtime.controller = controller
  runtime.runId = null
  runtime.messageId = null
  renderQueueState()
  updateSendState()

  // 队列里的消息可能在等待期间已被切走；回到该会话时才重新挂回消息流。
  const visibleAtStart = runtime.sessionId ? runtime.sessionId === state.sessionId : state.sessionId === null
  if (item.node && !item.node.isConnected && visibleAtStart) {
    $('#thread').appendChild(item.node)
    setEmptyVisible(false)
    scrollThreadToBottomInstant()
  }
  let turn = createAiTurn({ append: visibleAtStart })
  runtime.turn = turn
  state.parentTeamTurn = turn
  let streamError = null
  let sawDone = false
  let messageId = ''
  const createdSession = !item.sessionId
  const voiceTurn = Boolean(
    item.voiceConversation &&
      state.voiceConversation.active &&
      (item.sessionId
        ? item.sessionId === state.voiceConversation.sessionId
        : state.voiceConversation.sessionId === null),
  )
  const voiceStream = voiceTurn ? beginVoiceSpeechStream(turn.node, state.voiceConversation.generation) : null

  try {
    const references = await buildAttachmentPayload(item.pending.filter(isPersistentAttachment))
    const attachments = await prepareChatAttachments(item)
    if (controller.signal.aborted) throw new DOMException('已停止', 'AbortError')
    if (item.sessionId) await waitSessionReferenceSync(item.sessionId)
    if (controller.signal.aborted) throw new DOMException('已停止', 'AbortError')
    await streamChat(
      {
        modelId: item.modelId,
        reasoningEffort: item.reasoningEffort,
        text: item.text,
        attachments,
        references,
        sessionId: item.sessionId,
        spaceKind: item.spaceKind,
        // 右侧正在预览的文件：让模型知道「这个文件」指谁；面板没开就不传。
        activeFile: activePreviewFilePayload(),
      },
      (event, data) => {
        const isCurrentRun = runtime.sessionId ? runtime.sessionId === state.sessionId : state.sessionId === null
        if (event === 'meta') {
          messageId = String(data.messageId || '')
          runtime.messageId = messageId
          runtime.runId = data.runId || null
          if (data.runId) beginParentAgentTurn(data.runId)
          const userMessageId = String(data.userMessageId || '')
          if (userMessageId && item.node) {
            item.node.dataset.messageId = userMessageId
            item.node.chatMessage = {
              id: userMessageId,
              role: 'user',
              text: item.text,
              createdAt: new Date(item.createdAt).toISOString(),
            }
            refreshMessageActions(item.node)
            state.historyMessageIds.add(userMessageId)
          }
          if (messageId) {
            state.localLiveMessageIds.add(messageId)
            // EventSource 可能先于 meta 到达并已经建好实时节点；复用它，
            // 删掉 POST 刚建的占位节点，避免一个回答两个气泡或增量画到隐藏节点。
            const existingLive = state.liveTurns.get(messageId)
            if (existingLive?.turn && existingLive.turn !== turn) {
              if (turn.node.isConnected) turn.node.remove()
              turn = existingLive.turn
              runtime.turn = turn
              state.parentTeamTurn = turn
              existingLive.hydrated = true
            } else {
              state.liveTurns.set(messageId, {
                turn,
                sessionId: data.sessionId || runtime.sessionId,
                messageId,
                hydrated: true,
              })
            }
          }
          if (data.sessionId) {
            if (runtime.sessionId && runtime.sessionId !== data.sessionId) {
              // 服务端可能为旧空会话补了新 id；以服务端为准迁移运行时。
            }
            migrateRuntime(runtime, data.sessionId)
            item.sessionId = data.sessionId
            for (const queued of runtime.queue) {
              if (!queued.sessionId) queued.sessionId = data.sessionId
            }
            if (!state.sessions.some((session) => session.id === data.sessionId)) {
              // 新会话第一次回复时还没进左侧列表，先拉一次，运行中的绿点才有落点。
              void loadSessions()
            }
            if (state.sessionId === null || state.sessionId === data.sessionId) {
              state.sessionId = data.sessionId
              persistChatLocation()
              // 新会话首条消息落库后，把输入区当前常驻引用（含发送过程中新增/删除的）同步一次。
              if (createdSession) void syncSessionReferences()
            }
            if (isCurrentRun && $('#chat-title').textContent === '新对话') {
              $('#chat-title').textContent = (item.text || attachments[0]?.name || '新对话').slice(0, 24)
            }
            markSessionActive(data.sessionId)
            renderSessions()
            // 新会话首轮语音：把连续语音的归属从“尚未落库”更新到真实会话 id，下一轮才能继续收听。
            if (state.voiceConversation.active && !state.voiceConversation.sessionId) {
              state.voiceConversation.sessionId = data.sessionId
            }
          }
          if (!isCurrentRun && turn.node.isConnected) {
            // 发送瞬间还在当前会话，meta 回来前已经切走；保留在后台，不删节点。
          }
        } else if (
          event === 'reasoning' ||
          event === 'delta' ||
          event === 'tool' ||
          event === 'tool_delta' ||
          event === 'tool_result'
        ) {
          /**
           * POST 流负责本次发送的实时渲染。EventSource 在 setupChatEvents
           * 里会跳过当前会话正在 POST 的同一轮，避免重复；这里不能再因为
           * EventSource 已连接就不画，否则两处互相让路，气泡会一直停在
           * “正在思考中…”，刷新后才从历史消息恢复。
           */
          if (event === 'reasoning') turn.reasoning(data.text)
          else if (event === 'delta') {
            turn.content(data.text)
            if (voiceStream?.active && !voiceSpeechDeferred()) feedVoiceSpeechStream(String(data.text || ''))
          } else if (event === 'tool') turn.tool(data)
          else if (event === 'tool_delta') turn.toolDelta(data)
          else turn.toolResult(data)
        } else if (event === 'agent') {
          updateAgentEvent(data)
        } else if (event === 'clarify') {
          turn.clarify(data.clarify)
        } else if (event === 'done') {
          sawDone = true
          const id = String(data.messageId || messageId || '')
          const liveEntry = id ? state.liveTurns.get(id) : null
          if (liveEntry?.turn && liveEntry.turn !== turn) {
            // EventSource 已经建好并渲染了实时节点：收编它，删掉 POST 的空占位。
            if (turn.node.isConnected) turn.node.remove()
            turn = liveEntry.turn
            runtime.turn = turn
          } else if (id && state.historyMessageIds.has(id) && !liveEntry) {
            // EventSource 已先收到最终消息并完成渲染，POST 只做收尾，不再画第二个气泡。
            if (turn.node.isConnected) turn.node.remove()
            turn = liveEntry?.turn || turn
          }
          if (id) {
            state.historyMessageIds.add(id)
            state.activeRunSnapshots.delete(id)
            state.localLiveMessageIds.delete(id)
            state.liveTurns.delete(id)
            if (turn.node) {
              turn.node.dataset.messageId = id
              turn.node.chatMessage = {
                id,
                role: 'assistant',
                text: String(data.text || ''),
                createdAt: data.createdAt || new Date().toISOString(),
              }
              setMessageTime(turn.node, data.createdAt)
              refreshMessageActions(turn.node)
            }
          }
          if (data.sessionId) {
            migrateRuntime(runtime, data.sessionId)
            if (state.sessionId === null || state.sessionId === data.sessionId) {
              state.sessionId = data.sessionId
              persistChatLocation()
            }
          }
          if (data.attachments && item.node) {
            const merged = mergeDoneAttachments(item.attachmentMeta, data.attachments)
            item.attachmentMeta = merged
            updateAttachmentCards(item.node, merged)
          }
          turn.finish(data)
          const voiceReplyText = String(data?.text || '').trim() || String(data?.clarify?.question || '').trim()
          if (
            item.voiceInput &&
            (isCurrentRun || runtime.sessionId === state.sessionId)
          ) {
            if (item.voiceConversation) {
              if (voiceStream) endVoiceSpeechStream(voiceStream, voiceReplyText)
              else if (voiceReplyText) handleVoiceConversationAnswer(turn.node, voiceReplyText)
              else setVoiceDockStatus('paused', '回答已完成', '没有可播报的文本，点“继续聆听”继续语音对话')
            } else if (!data?.clarify && voiceReplyText) {
              void speakAnswer(turn.node, voiceReplyText, { auto: true })
            }
          }
          syncMessageActionAvailability()
          if (isCurrentRun || runtime.sessionId === state.sessionId) {
            notifySessionRead(runtime.sessionId)
          }
          loadSessions()
          scheduleWorkspaceRefresh()
        } else if (event === 'error') {
          const err = new Error(data.message || '模型调用失败')
          err.code = data.code
          err.traceId = data.traceId
          streamError = err
        }
      },
      controller.signal,
    )
    if (streamError) throw streamError
    if (!sawDone && !controller.signal.aborted) throw new Error('回答流意外中断，请重试')
  } catch (err) {
    if (voiceStream) abortVoiceSpeechStream({ quiet: true })
    if (controller.signal.aborted) {
      turn.stop()
      if (messageId) {
        state.liveTurns.delete(messageId)
        state.activeRunSnapshots.delete(messageId)
      }
    } else {
      turn.fail(`${err.message}${err.code ? `\n（${err.code}）` : ''}`, err.traceId ? `traceId ${err.traceId}` : '请求失败')
      if (messageId) state.localLiveMessageIds.delete(messageId)
      if (item.voiceConversation && state.voiceConversation.active) {
        setVoiceDockStatus('error', '这轮回答失败', '文字错误已保留；点“重试”重新开始语音对话')
      }
    }
  } finally {
    runtime.sending = false
    runtime.controller = null
    runtime.runId = null
    if (runtime.turn === turn) runtime.turn = null
    if (messageId) state.localLiveMessageIds.delete(messageId)
    renderSessions()
    updateSendState()
    renderQueueState()
    if (runtime.queue.length > 0) {
      void drainQueue(runtime)
    } else if (
      (runtime.sessionId && runtime.sessionId === state.sessionId) ||
      (!runtime.sessionId && state.sessionId === null)
    ) {
      $('#input').focus()
    }
  }
}

/* ---------------- 启动 ---------------- */

/* ---------------- 设置页 ---------------- */

function renderSettingsProfile() {
  const box = $('#settings-profile')
  if (!box) return
  // 直接复用侧栏已经渲染好的身份信息，避免两处字段口径不一致
  const name = $('#user-name')?.textContent?.trim() || '—'
  const title = $('#user-title')?.textContent?.trim() || '—'
  const org = $('#user-org')?.dataset.orgText || $('#user-org')?.textContent?.trim() || '—'
  const roles = $('#user-roles')?.innerHTML || ''
  const rawId = String(state.me?.person?.id || '')
  const account = rawId.replace(/^u_[a-z0-9]+_/i, '') || '—'
  box.innerHTML = `
    ${avatarMarkup(name, meAvatarUrl(), 'settings-profile-avatar')}
    <div class="settings-profile-main">
      <strong>${esc(name)}</strong>
      <span>${esc(title)} · ${esc(org)}</span>
      <span class="settings-profile-account" title="${esc(rawId)}">账号：${esc(account)}</span>
    </div>
    <div class="settings-profile-roles">${roles}</div>`
  renderPasswordSettingRow()
}

function renderPasswordSettingRow() {
  const row = $('#settings-password')
  if (!row) return
  const configured = state.me?.passwordConfigured === true
  const title = row.querySelector('strong')
  const hint = row.querySelector('em')
  if (title) title.textContent = configured ? '修改密码' : '设置登录密码'
  if (hint) {
    hint.textContent = configured
      ? '更新登录密码，其他设备会退出登录'
      : '当前账号还没有设置过密码，先设置一个登录密码'
  }
}

function renderChatSendModeSetting() {
  const segment = $('#settings-send-segment')
  const hint = $('#settings-send-mode-hint')
  if (!segment) return
  const mode = state.chatSendMode === 'interrupt' ? 'interrupt' : 'queue'
  for (const button of segment.querySelectorAll('[data-send-mode]')) {
    const active = button.dataset.sendMode === mode
    button.classList.toggle('is-active', active)
    button.setAttribute('aria-checked', active ? 'true' : 'false')
  }
  if (hint) {
    hint.textContent =
      mode === 'interrupt'
        ? '打断：立即停止当前回复，优先发送这条新消息'
        : '排队：当前回复结束后，再按顺序发送'
  }
}

function showSettings() {
  const stage = $('#settings-stage')
  if (!stage) return
  $('.chat-head').hidden = true
  $('.chat-main').hidden = true
  stage.hidden = false
  playPaneEnter(stage)
  $('#open-settings').classList.add('is-active')
  state.view = 'settings'
  persistChatLocation()
  renderSettingsProfile()
  renderChatSendModeSetting()
  renderVoiceSettings()
  void loadVoiceSettings()
}

function hideSettings() {
  const stage = $('#settings-stage')
  if (!stage) return
  stage.hidden = true
  clearPaneEnter(stage)
  $('.chat-head').hidden = false
  $('.chat-main').hidden = false
  $('#open-settings').classList.remove('is-active')
  state.view = state.mode
  persistChatLocation()
  $('#input').focus()
}

async function logout() {
  try {
    await api('/api/auth/logout', { method: 'POST' })
  } catch {
    // 网络失败也要回登录页
  }
  location.href = '/chat'
}

let settingsBound = false
function bindSettings() {
  if (settingsBound) return
  settingsBound = true
  $('#open-settings').addEventListener('click', showSettings)
  $('#settings-back').addEventListener('click', hideSettings)
  $('#settings-memories').addEventListener('click', showMemories)
  $('#settings-caps').addEventListener('click', showMyCaps)
  $('#settings-wake-segment').addEventListener('click', async (event) => {
    const button = event.target.closest?.('[data-wake-enabled]')
    if (!button || button.disabled) return
    const next = button.dataset.wakeEnabled === 'true'
    if (next === state.wake.enabled && (next ? state.wake.active : !state.wake.active)) return
    await setWakeEnabled(next)
  })
  $('#settings-voice').addEventListener('click', showVoiceSettings)
  $('#settings-voice-mode-segment').addEventListener('click', async (event) => {
    const button = event.target.closest?.('[data-voice-mode]')
    if (!button) return
    const next = button.dataset.voiceMode === 'whole' ? 'whole' : 'stream'
    if (next === state.voiceSettings.speechMode) return
    const previous = state.voiceSettings.speechMode
    state.voiceSettings.speechMode = next
    renderVoiceSettings()
    try {
      const saved = await api('/api/me/voice', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ speechMode: next }),
      })
      state.voiceSettings = {
        ...state.voiceSettings,
        ...saved,
        speechMode: saved.speechMode === 'whole' ? 'whole' : 'stream',
      }
      renderVoiceSettings()
      banner(next === 'whole' ? '已改为整段播报' : '已改为边生成边播', 'ok')
    } catch (err) {
      state.voiceSettings.speechMode = previous
      renderVoiceSettings()
      banner(err.message || '保存失败，请重试', 'bad')
    }
  })
  $('#settings-voice-segment').addEventListener('click', async (event) => {
    const button = event.target.closest?.('[data-voice-enabled]')
    if (!button) return
    const next = button.dataset.voiceEnabled === 'true'
    if (next === state.voiceSettings.enabled) return
    const previous = state.voiceSettings.enabled
    state.voiceSettings.enabled = next
    renderVoiceSettings()
    try {
      const saved = await api('/api/me/voice', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      })
      state.voiceSettings = { ...state.voiceSettings, ...saved }
      renderVoiceSettings()
      banner(next ? '已开启语音回复' : '已关闭语音回复，语音对话仍会转成文字', 'ok')
    } catch (err) {
      state.voiceSettings.enabled = previous
      renderVoiceSettings()
      banner(err.message || '保存失败，请重试', 'bad')
    }
  })
  $('#settings-password').addEventListener('click', showPasswordModal)
  $('#settings-logout').addEventListener('click', logout)
  $('#settings-send-segment').addEventListener('click', async (event) => {
    const button = event.target.closest?.('[data-send-mode]')
    if (!button) return
    const next = button.dataset.sendMode
    if (next !== 'queue' && next !== 'interrupt') return
    if (next === state.chatSendMode) return
    const previous = state.chatSendMode
    state.chatSendMode = next
    renderChatSendModeSetting()
    const buttons = [...$('#settings-send-segment').querySelectorAll('button')]
    for (const item of buttons) item.disabled = true
    try {
      const saved = await api('/api/me/chat-send-mode', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatSendMode: next }),
      })
      state.chatSendMode = saved.chatSendMode === 'interrupt' ? 'interrupt' : 'queue'
      if (state.me) state.me.chatSendMode = state.chatSendMode
      renderChatSendModeSetting()
      banner(state.chatSendMode === 'interrupt' ? '已改为打断模式' : '已改为排队模式', 'ok')
    } catch (err) {
      state.chatSendMode = previous
      renderChatSendModeSetting()
      banner(err.message || '保存失败，请重试', 'bad')
    } finally {
      for (const item of buttons) item.disabled = false
    }
  })
}

let ssoSdkPromise = null
let ssoBound = false
let ssoQrLoaded = false
let ssoQrAppId = null
let ssoMethods = null
let loginMode = 'password'
let loginModeBound = false
let ssoWatchTimer = 0
let qrExpiryTimer = 0
/** 钉钉登录二维码官方有效期为 15 分钟；到期先罩一层灰，不让用户继续扫死码。 */
const DINGTALK_QR_TTL_MS = 15 * 60 * 1000
const SSO_EXCHANGE_TIMEOUT_MS = 15 * 1000

function hideQrExpired() {
  const overlay = $('#login-qr-expired')
  if (overlay) overlay.hidden = true
}

function showQrExpired() {
  const overlay = $('#login-qr-expired')
  if (!overlay) return
  overlay.hidden = false
  hideSsoError()
}

function hideSsoError() {
  const errorBox = $('#login-sso-error')
  const errorLink = $('#login-sso-error-link')
  if (errorBox) errorBox.hidden = true
  if (errorLink) {
    errorLink.hidden = true
    errorLink.href = '#'
  }
}

function renderSsoError(err) {
  const errorBox = $('#login-sso-error')
  const errorLink = $('#login-sso-error-link')
  if (errorBox) {
    errorBox.textContent = err?.message || '登录失败，请重试'
    errorBox.hidden = false
  }
  const applyUrl = String(err?.details?.applyUrl || '')
  if (errorLink) {
    if (applyUrl) {
      errorLink.href = applyUrl
      errorLink.hidden = false
    } else {
      errorLink.hidden = true
      errorLink.href = '#'
    }
  }
}

function scheduleQrExpiry() {
  clearTimeout(qrExpiryTimer)
  const qr = $('#login-qr')
  if (qr) qr.dataset.expiresAt = String(Date.now() + DINGTALK_QR_TTL_MS)
  qrExpiryTimer = window.setTimeout(() => {
    if (ssoQrLoaded) showQrExpired()
  }, DINGTALK_QR_TTL_MS)
}

function loadDingTalkLoginSdk() {
  if (window.DTFrameLogin) return Promise.resolve()
  if (ssoSdkPromise) return ssoSdkPromise
  ssoSdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://g.alicdn.com/dingding/h5-dingtalk-login/0.21.0/ddlogin.js'
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('钉钉扫码组件加载失败，请检查网络或刷新本页重试'))
    document.head.appendChild(script)
  })
  return ssoSdkPromise
}

async function showDingTalkQr(force = false) {
  // 已经渲染过且 AppKey 没变才复用；换机器人后必须重新生成二维码，不能拿旧 client_id 硬扫。
  if (ssoQrLoaded && !force) {
    const current = String(ssoMethods?.dingtalk?.appId || '')
    if (current && current === ssoQrAppId) return
  }
  const panel = $('#login-sso-dingtalk')
  const frame = $('#login-qr-frame')
  const tab = $('#login-tab-dingtalk')
  hideQrExpired()
  clearTimeout(qrExpiryTimer)
  hideSsoError()
  if (tab) tab.disabled = true
  try {
    const company = new URLSearchParams(location.search).get('company') || ''
    const query = company ? `?company=${encodeURIComponent(company)}` : ''
    const data = await api(`/api/auth/dingtalk/start${query}`)
    if (!data.url || !data.appId) throw new Error('没有拿到钉钉登录地址')
    panel.hidden = false
    frame.innerHTML = ''
    const openLink = $('#login-qr-open')
    if (openLink) openLink.href = data.url
    await loadDingTalkLoginSdk()
    if (typeof window.DTFrameLogin !== 'function') {
      throw new Error('钉钉扫码组件加载失败，请刷新本页重试')
    }
    window.DTFrameLogin(
      { id: 'login-qr-frame', width: 260, height: 260 },
      {
        redirect_uri: encodeURIComponent(`${location.origin}/api/auth/dingtalk/callback`),
        client_id: data.appId,
        scope: 'openid',
        response_type: 'code',
        state: data.state,
        prompt: 'consent',
      },
      async (result) => {
        // 钉钉组件确认扫码后先铺加载层，避免停在二维码上等 exchange 返回。
        window.EABBoot?.beginLogin?.('已识别扫码，正在登录…')
        try {
          const login = await withTimeout(
            api('/api/auth/dingtalk/exchange', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                company,
                authCode: result.authCode,
                state: result.state || data.state,
              }),
            }),
            SSO_EXCHANGE_TIMEOUT_MS,
            '登录请求超时，请重新扫码或改用账号密码登录',
          )
          markLoginBoot('chat')
          location.href = (login && login.redirectPath) || '/chat'
        } catch (err) {
          // 扫码/登录失败：撤掉加载层，回到仍可重试的二维码页。
          window.EABBoot?.finish?.(true)
          renderSsoError(err)
        }
      },
      (msg) => {
        // 组件偶尔会用空消息回调一次；此时二维码通常仍可扫，不弹误导性的红条
        if (!msg) return
        const bootOverlay = document.getElementById('eab-boot')
        if (bootOverlay && !bootOverlay.hidden) window.EABBoot?.finish?.(true)
        const text = String(msg)
        if (/过期|失效|expired|refresh/i.test(text)) {
          showQrExpired()
          return
        }
        renderSsoError(new Error(text))
      },
    )
    ssoQrLoaded = true
    ssoQrAppId = data.appId
    scheduleQrExpiry()
  } catch (err) {
    renderSsoError(err)
  } finally {
    if (tab) tab.disabled = false
  }
}

function selectLoginMode(mode) {
  const qr = mode === 'qr'
  loginMode = qr ? 'qr' : 'password'
  $('#login-card')?.classList.toggle('is-password-mode', !qr)
  $('#login-mode-qr')?.classList.toggle('is-active', qr)
  $('#login-mode-password')?.classList.toggle('is-active', !qr)
  const paneQr = $('#login-pane-qr')
  const panePassword = $('#login-pane-password')
  if (paneQr) paneQr.hidden = !qr
  if (panePassword) panePassword.hidden = qr
  if (!qr) return
  if (ssoMethods?.dingtalk?.configured) void showDingTalkQr(false)
}

function selectSsoMethod(method) {
  const isDing = method === 'dingtalk'
  $('#login-tab-dingtalk')?.classList.toggle('is-active', isDing)
  $('#login-tab-feishu')?.classList.toggle('is-active', !isDing)
  $('#login-sso-dingtalk').hidden = !isDing
  $('#login-sso-feishu').hidden = isDing
  hideSsoError()
  const sub = $('#login-qr-sub')
  const foot = $('#login-qr-foot')
  if (sub) sub.textContent = isDing
    ? '打开手机钉钉扫一扫，确认后这台电脑会自动登录。'
    : '飞书扫码登录链路还在接入中；可先切到「账号密码」登录。'
  if (foot) foot.textContent = isDing
    ? '二维码由钉钉官方组件渲染，手机不需要访问本机地址；扫码只用于身份登录。'
    : '飞书扫码登录接入中；企业身份与权限仍按公司、部门、角色隔离。'
  if (isDing && ssoMethods?.dingtalk?.configured) void showDingTalkQr(false)
}

function paintSsoAppId() {
  // AppKey 是内部路由排障信息，登录页不给普通员工展示。
  const appIdEl = $('#login-sso-appid')
  if (!appIdEl) return
  appIdEl.hidden = true
  appIdEl.textContent = ''
}

function paintLoginBrand() {
  const el = $('#login-brand-name')
  if (!el) return
  const base = String(window.EABBrand?.current?.chat?.brandName || '').trim() || '企业智能体基座'
  const companyName = String(ssoMethods?.companyName || ssoMethods?.dingtalk?.tenantName || '').trim()
  el.textContent = companyName ? `${base} · ${companyName}` : base
}

async function setupLoginSso() {
  const tabs = $('#login-sso-tabs')
  const empty = $('#login-sso-empty')
  const modeTabs = $('#login-mode-tabs')
  const paneQr = $('#login-pane-qr')
  const panePassword = $('#login-pane-password')
  try {
    const company = new URLSearchParams(location.search).get('company') || ''
    const query = company ? `?company=${encodeURIComponent(company)}` : ''
    ssoMethods = await api(`/api/auth/methods${query}`)
  } catch {
    ssoMethods = null
  }
  const ding = Boolean(ssoMethods?.dingtalk?.configured)
  const feishu = Boolean(ssoMethods?.feishu?.configured)
  $('#login-card')?.classList.toggle('has-sso', ding || feishu)
  paintSsoAppId()
  paintLoginBrand()

  if (!loginModeBound) {
    loginModeBound = true
    $('#login-mode-qr')?.addEventListener('click', () => selectLoginMode('qr'))
    $('#login-mode-password')?.addEventListener('click', () => selectLoginMode('password'))
  }

  if (!ding && !feishu) {
    // 没配扫码：直接把账号密码作为唯一入口，不显示模式切换。
    modeTabs.hidden = true
    tabs.hidden = true
    $('#login-sso-dingtalk').hidden = true
    $('#login-sso-feishu').hidden = true
    empty.hidden = false
    if (paneQr) paneQr.hidden = true
    if (panePassword) panePassword.hidden = false
    loginMode = 'password'
    return
  }

  // 配了扫码：扫码是主入口，账号密码是次级模式。
  modeTabs.hidden = false
  if (paneQr) paneQr.hidden = false
  if (panePassword) panePassword.hidden = true
  loginMode = 'qr'
  const qrSub = $('#login-qr-sub')
  if (qrSub) qrSub.textContent = ding
    ? '打开手机钉钉扫一扫，确认后这台电脑会自动登录。'
    : '打开手机飞书扫一扫，确认后这台电脑会自动登录。'

  empty.hidden = true
  tabs.hidden = !(ding && feishu)
  $('.login-sso-body')?.classList.toggle('with-tabs', !tabs.hidden)
  if (ding) {
    $('#login-tab-dingtalk').hidden = false
    $('#login-tab-feishu').hidden = !feishu
    selectSsoMethod('dingtalk')
  } else {
    $('#login-tab-dingtalk').hidden = true
    $('#login-tab-feishu').hidden = false
    selectSsoMethod('feishu')
  }

  /**
   * 控制台换机器人时，登录页可能一直开着。
   * 每 30 秒核对一次 AppKey：变了就丢缓存，重新出二维码，避免一直扫旧码报 900103。
   */
  if (!ssoWatchTimer) {
    ssoWatchTimer = setInterval(async () => {
      const previous = String(ssoMethods?.dingtalk?.appId || '')
      try {
        const company = new URLSearchParams(location.search).get('company') || ''
        const query = company ? `?company=${encodeURIComponent(company)}` : ''
        const next = await api(`/api/auth/methods${query}`)
        const changed = String(next?.dingtalk?.appId || '') !== previous
        ssoMethods = next
        paintLoginBrand()
        if (!changed) return
        paintSsoAppId()
        ssoQrLoaded = false
        ssoQrAppId = null
        if (loginMode === 'qr' && next?.dingtalk?.configured) void showDingTalkQr(true)
      } catch {
        /* 网络抖动不影响当前二维码 */
      }
    }, 30_000)
  }

  if (ssoBound) return
  ssoBound = true
  $('#login-tab-dingtalk')?.addEventListener('click', () => selectSsoMethod('dingtalk'))
  $('#login-tab-feishu')?.addEventListener('click', () => selectSsoMethod('feishu'))
  $('#login-qr-refresh')?.addEventListener('click', () => {
    ssoQrLoaded = false
    void showDingTalkQr(true)
  })
  $('#login-qr-expired')?.addEventListener('click', () => {
    hideQrExpired()
    ssoQrLoaded = false
    void showDingTalkQr(true)
  })
}

let sidePeekCloseTimer = 0
let sidePeekWatchTimer = 0
let sidePeekPinnedByFocus = false
let sidePeekFocusGuard = false
let sidePeekLastX = -10000
let sidePeekLastY = -10000

function startSidePeekWatch() {
  if (sidePeekWatchTimer) return
  sidePeekWatchTimer = window.setInterval(() => {
    if (!document.body.classList.contains('is-side-peek')) {
      stopSidePeekWatch()
      return
    }
    const side = $('#chat-side')
    const button = $('#side-toggle')
    if (sidePeekPinnedByFocus || side?.contains(document.activeElement)) return
    if (sidePeekPointerInZone(sidePeekLastX, sidePeekLastY)) return
    if (button?.matches(':hover') || side?.matches(':hover')) return
    setSidePeek(false)
  }, 300)
}

function stopSidePeekWatch() {
  if (!sidePeekWatchTimer) return
  window.clearInterval(sidePeekWatchTimer)
  sidePeekWatchTimer = 0
}

function focusSideToggle() {
  sidePeekFocusGuard = true
  $('#side-toggle')?.focus()
  sidePeekFocusGuard = false
}

function canSidePeek() {
  return window.matchMedia('(min-width: 861px)').matches
}

function syncSidePeekInsets() {
  const side = $('#chat-side')
  if (!side) return
  const composer = document.querySelector('.composer')
  const top = composer ? composer.getBoundingClientRect().top : 0
  const bottom = top > 0 ? Math.max(14, Math.round(window.innerHeight - top + 10)) : 14
  side.style.setProperty('--eab-side-peek-bottom', `${bottom}px`)
}

function setSidePeek(peek) {
  const side = $('#chat-side')
  const isCollapsed = document.body.classList.contains('is-side-collapsed')
  const want = Boolean(peek && isCollapsed && canSidePeek())
  document.body.classList.toggle('is-side-peek', want)
  if (!side) return
  if (want) {
    syncSidePeekInsets()
    side.inert = false
    side.setAttribute('aria-hidden', 'false')
    startSidePeekWatch()
    return
  }
  stopSidePeekWatch()
  sidePeekPinnedByFocus = false
  if (isCollapsed) {
    if (side.contains(document.activeElement)) focusSideToggle()
    side.inert = true
    side.setAttribute('aria-hidden', 'true')
  }
}

function cancelSidePeekClose() {
  if (!sidePeekCloseTimer) return
  window.clearTimeout(sidePeekCloseTimer)
  sidePeekCloseTimer = 0
}

function scheduleSidePeekClose() {
  cancelSidePeekClose()
  sidePeekCloseTimer = window.setTimeout(() => {
    sidePeekCloseTimer = 0
    if (!document.body.classList.contains('is-side-peek')) return
    const side = $('#chat-side')
    const button = $('#side-toggle')
    if (button === document.activeElement) return
    if (sidePeekPointerInZone(sidePeekLastX, sidePeekLastY)) return
    if (button?.matches(':hover') || side?.matches(':hover') || side?.contains(document.activeElement)) return
    setSidePeek(false)
  }, 240)
}

function sidePeekPointerInZone(x, y) {
  const side = $('#chat-side')
  const button = $('#side-toggle')
  if (!side || !button) return false
  const sideRect = side.getBoundingClientRect()
  const buttonRect = button.getBoundingClientRect()
  const sideVisible = sideRect.width > 20 && sideRect.height > 20
  const inSide = sideVisible && x >= sideRect.left - 8 && x <= sideRect.right + 8 && y >= sideRect.top - 8 && y <= sideRect.bottom + 8
  const inButton = x >= buttonRect.left - 8 && x <= buttonRect.right + 8 && y >= buttonRect.top - 8 && y <= buttonRect.bottom + 8
  return inSide || inButton
}

function trackSidePeekPointer(event) {
  if (event.pointerType === 'touch') return
  if (!document.body.classList.contains('is-side-collapsed')) return
  const x = event.clientX
  const y = event.clientY
  sidePeekLastX = x
  sidePeekLastY = y
  const inZone = sidePeekPointerInZone(x, y)
  if (inZone) sidePeekPinnedByFocus = false
  if (!document.body.classList.contains('is-side-peek')) {
    if (inZone) setSidePeek(true)
    return
  }
  if (inZone) cancelSidePeekClose()
  else scheduleSidePeekClose()
}

function setSidebarCollapsed(collapsed, options = {}) {
  const isCollapsed = Boolean(collapsed)
  document.body.classList.toggle('is-side-collapsed', isCollapsed)
  if (!isCollapsed) {
    document.body.classList.remove('is-side-peek')
    stopSidePeekWatch()
    sidePeekPinnedByFocus = false
  }
  const side = $('#chat-side')
  if (side) {
    side.setAttribute('aria-hidden', String(isCollapsed))
    // 收起时从键盘 Tab 顺序和点击命中中移除，避免焦点落进屏幕外的浮层。
    side.inert = isCollapsed
  }
  const button = $('#side-toggle')
  if (button) {
    button.setAttribute('aria-expanded', String(!isCollapsed))
    button.setAttribute('aria-label', isCollapsed ? '展开侧边栏' : '收起侧边栏')
    button.title = isCollapsed ? '展开侧边栏' : '收起侧边栏'
  }
  if (options.persist !== false) {
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, isCollapsed ? '1' : '0')
    } catch {
      /* 本地存储不可用时只影响记忆，不影响折叠 */
    }
  }
  syncSideSectionSplit()
}

function initSidebarToggle() {
  let collapsed = false
  try {
    collapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'
  } catch {
    collapsed = false
  }
  setSidebarCollapsed(collapsed, { persist: false })
  const button = $('#side-toggle')
  const side = $('#chat-side')
  if (button && button.dataset.bound !== '1') {
    button.dataset.bound = '1'
    button.addEventListener('click', () => {
      setSidebarCollapsed(!document.body.classList.contains('is-side-collapsed'))
    })
    button.addEventListener('pointerenter', (event) => {
      if (event.pointerType === 'touch') return
      sidePeekLastX = event.clientX
      sidePeekLastY = event.clientY
      cancelSidePeekClose()
      if (document.body.classList.contains('is-side-collapsed')) setSidePeek(true)
    })
    button.addEventListener('pointerleave', scheduleSidePeekClose)
    button.addEventListener('focus', () => {
      if (sidePeekFocusGuard) return
      if (document.body.classList.contains('is-side-collapsed')) {
        sidePeekPinnedByFocus = true
        setSidePeek(true)
      }
    })
    button.addEventListener('blur', scheduleSidePeekClose)
  }
  if (side && side.dataset.peekBound !== '1') {
    side.dataset.peekBound = '1'
    side.addEventListener('pointerenter', (event) => {
      sidePeekLastX = event.clientX
      sidePeekLastY = event.clientY
      cancelSidePeekClose()
      if (document.body.classList.contains('is-side-collapsed')) setSidePeek(true)
    })
    side.addEventListener('pointerleave', scheduleSidePeekClose)
    side.addEventListener('focusin', cancelSidePeekClose)
    side.addEventListener('focusout', scheduleSidePeekClose)
  }
  if (document.body.dataset.sidePeekMoveBound !== '1') {
    document.body.dataset.sidePeekMoveBound = '1'
    document.addEventListener('pointermove', trackSidePeekPointer, { passive: true })
    document.addEventListener('mousemove', trackSidePeekPointer, { passive: true })
    window.addEventListener('resize', () => {
      if (!canSidePeek()) setSidePeek(false)
      else if (document.body.classList.contains('is-side-peek')) syncSidePeekInsets()
    }, { passive: true })
  }
  if (document.body.dataset.sidebarEscBound !== '1') {
    document.body.dataset.sidebarEscBound = '1'
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return
      if (document.body.classList.contains('is-side-peek')) {
        setSidePeek(false)
        focusSideToggle()
        return
      }
      if (document.body.classList.contains('is-side-collapsed')) return
      if (!$('#chat-side')?.contains(document.activeElement) && document.activeElement?.id !== 'side-toggle') return
      setSidebarCollapsed(true)
      focusSideToggle()
    })
  }
}

function readSideSectionRatio() {
  try {
    const saved = Number(localStorage.getItem(SIDE_SECTION_RATIO_KEY))
    if (Number.isFinite(saved) && saved >= 0.2 && saved <= 0.8) return saved
  } catch {
    /* 本地存储不可用时使用默认比例 */
  }
  return 0.5
}

function applySideSectionRatio(ratio, options = {}) {
  const side = $('#chat-side')
  if (!side) return
  const value = Math.max(0.2, Math.min(0.8, Number(ratio) || 0.5))
  side.style.setProperty('--side-sessions-grow', String(value))
  side.style.setProperty('--side-files-grow', String(1 - value))
  const resizer = $('#side-split-resizer')
  if (resizer) resizer.setAttribute('aria-valuenow', String(Math.round(value * 100)))
  if (options.persist !== false) {
    try {
      localStorage.setItem(SIDE_SECTION_RATIO_KEY, String(value))
    } catch {
      /* 本地存储不可用时只影响记忆，不影响本次拖动 */
    }
  }
}

function syncSideSectionSplit() {
  const side = $('#chat-side')
  const sessions = $('#side-sessions')
  const files = $('#side-files')
  const resizer = $('#side-split-resizer')
  if (!side || !sessions || !files || !resizer) return
  const collapsed = document.body.classList.contains('is-side-collapsed')
  const peek = document.body.classList.contains('is-side-peek')
  const show = !side.hidden && !sessions.hidden && !files.hidden && (!collapsed || peek)
  side.classList.toggle('is-side-sections-resizable', show)
  resizer.hidden = !show
  if (show) applySideSectionRatio(readSideSectionRatio(), { persist: false })
}

function bindSideSectionResizer() {
  const resizer = $('#side-split-resizer')
  if (!resizer || resizer.dataset.bound === '1') return
  resizer.dataset.bound = '1'
  let drag = null

  const finishDrag = (pointerId) => {
    if (!drag || (pointerId != null && pointerId !== drag.pointerId)) return
    const ratio = Number.parseFloat(
      $('#chat-side')?.style.getPropertyValue('--side-sessions-grow') || '0.5',
    )
    if (Number.isFinite(ratio)) applySideSectionRatio(ratio)
    drag = null
    document.body.classList.remove('is-resizing-side')
  }

  resizer.addEventListener('pointerdown', (event) => {
    if (resizer.hidden || document.body.classList.contains('is-side-collapsed')) {
      if (!document.body.classList.contains('is-side-peek')) return
    }
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const sessions = $('#side-sessions')
    const files = $('#side-files')
    if (!sessions || !files) return
    const sessionsHeight = sessions.getBoundingClientRect().height
    const filesHeight = files.getBoundingClientRect().height
    const total = sessionsHeight + filesHeight
    if (total <= 0) return
    drag = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startSessions: sessionsHeight,
      total,
    }
    resizer.setPointerCapture?.(event.pointerId)
    document.body.classList.add('is-resizing-side')
    event.preventDefault()
  })

  resizer.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return
    const minHeight = Math.min(96, drag.total * 0.2)
    const nextSessions = Math.max(
      minHeight,
      Math.min(drag.total - minHeight, drag.startSessions + event.clientY - drag.startY),
    )
    applySideSectionRatio(nextSessions / drag.total, { persist: false })
    event.preventDefault()
  })

  resizer.addEventListener('pointerup', (event) => finishDrag(event.pointerId))
  resizer.addEventListener('pointercancel', (event) => finishDrag(event.pointerId))
  resizer.addEventListener('lostpointercapture', (event) => finishDrag(event.pointerId))

  resizer.addEventListener('keydown', (event) => {
    if (resizer.hidden || (document.body.classList.contains('is-side-collapsed') && !document.body.classList.contains('is-side-peek'))) return
    let next = readSideSectionRatio()
    if (event.key === 'ArrowUp') next -= 0.02
    else if (event.key === 'ArrowDown') next += 0.02
    else if (event.key === 'Home') next = 0.2
    else if (event.key === 'End') next = 0.8
    else return
    event.preventDefault()
    applySideSectionRatio(next)
  })
}

function fileSplitContentWidth(main) {
  const rect = main.getBoundingClientRect()
  const styles = getComputedStyle(main)
  const padLeft = Number.parseFloat(styles.paddingLeft) || 0
  const padRight = Number.parseFloat(styles.paddingRight) || 0
  return {
    rect,
    padLeft,
    contentWidth: Math.max(1, rect.width - padLeft - padRight),
  }
}

/** 右栏最小 440（列表 200 + 详情）、对话最小 360；文件模式沿用原来的 284/320。 */
function splitBounds(teamMode, contentWidth) {
  const minRail = teamMode ? 440 : 284
  const minChat = teamMode ? 360 : 320
  const minRatio = Math.min(0.5, minRail / contentWidth)
  const maxRatio = Math.max(minRatio, 1 - minChat / contentWidth)
  return { minRatio, maxRatio }
}

function applySplitRatio(ratio, options = {}) {
  const main = $('.chat-main')
  if (!main) return
  const teamMode = Boolean(options.team)
  const varName = teamMode ? '--team-split' : '--file-split'
  const fallback = teamMode ? 0.56 : 0.5
  const geometry = fileSplitContentWidth(main)
  let value = Number(ratio)
  if (!Number.isFinite(value) || value <= 0) value = fallback
  if (geometry.contentWidth > 1) {
    const bounds = splitBounds(teamMode, geometry.contentWidth)
    value = Math.max(bounds.minRatio, Math.min(bounds.maxRatio, value))
  }
  main.style.setProperty(varName, `${(value * 100).toFixed(2)}%`)
  const resizer = $('#file-split-resizer')
  if (resizer) resizer.setAttribute('aria-valuenow', String(Math.round(value * 100)))
  if (options.persist !== false) {
    try {
      localStorage.setItem(teamMode ? TEAM_SPLIT_RATIO_KEY : FILE_SPLIT_RATIO_KEY, String(value))
    } catch {
      /* 忽略本地存储失败 */
    }
  }
}

function applyFileSplitRatio(ratio, options = {}) {
  applySplitRatio(ratio, { ...options, team: false })
}

function applyTeamSplitRatio(ratio, options = {}) {
  applySplitRatio(ratio, { ...options, team: true })
}

function restoreFileSplitRatio() {
  let ratio = 0.5
  try {
    const saved = Number(localStorage.getItem(FILE_SPLIT_RATIO_KEY))
    if (Number.isFinite(saved) && saved >= 0.2 && saved <= 0.8) ratio = saved
  } catch {
    ratio = 0.5
  }
  applyFileSplitRatio(ratio, { persist: false })
}

/** 团队栏宽度也记住：默认对话 56% / 团队 44% */
function restoreTeamSplitRatio() {
  let ratio = 0.56
  try {
    const saved = Number(localStorage.getItem(TEAM_SPLIT_RATIO_KEY))
    if (Number.isFinite(saved) && saved >= 0.25 && saved <= 0.75) ratio = saved
  } catch {
    ratio = 0.56
  }
  applyTeamSplitRatio(ratio, { persist: false })
}

/** 团队栏内部的列表/预览分界线：像左侧对话/文件一样可拖，宽度记在本地。 */
function applyTeamListWidth(width, options = {}) {
  const split = $('#team-split')
  if (!split) return
  const total = split.getBoundingClientRect().width || 0
  const min = 128
  const max = total > 1 ? Math.max(min, total - 260) : 480
  let value = Number(width)
  if (!Number.isFinite(value) || value <= 0) value = 196
  value = Math.round(Math.max(min, Math.min(max, value)))
  split.style.setProperty('--team-list-width', `${value}px`)
  const resizer = $('#team-list-resizer')
  if (resizer) {
    resizer.setAttribute('aria-valuenow', String(value))
    resizer.setAttribute('aria-valuemin', String(min))
    resizer.setAttribute('aria-valuemax', String(Math.round(max)))
  }
  if (options.persist !== false) {
    try {
      localStorage.setItem(TEAM_LIST_WIDTH_KEY, String(value))
    } catch {
      /* 忽略本地存储失败 */
    }
  }
}

function restoreTeamListWidth() {
  let width = 196
  try {
    const saved = Number(localStorage.getItem(TEAM_LIST_WIDTH_KEY))
    if (Number.isFinite(saved) && saved >= 120 && saved <= 480) width = saved
  } catch {
    width = 196
  }
  applyTeamListWidth(width, { persist: false })
}

function bindTeamListResizer() {
  const resizer = $('#team-list-resizer')
  if (!resizer || resizer.dataset.bound === '1') return
  resizer.dataset.bound = '1'
  let drag = null

  const finish = (pointerId) => {
    if (!drag || (pointerId != null && pointerId !== drag.pointerId)) return
    applyTeamListWidth(drag.lastWidth)
    drag = null
    document.body.classList.remove('is-resizing-team-list')
  }

  resizer.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const list = $('#team-list')
    if (!list) return
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: list.getBoundingClientRect().width,
      lastWidth: list.getBoundingClientRect().width,
    }
    resizer.setPointerCapture?.(event.pointerId)
    document.body.classList.add('is-resizing-team-list')
    event.preventDefault()
  })

  resizer.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return
    drag.lastWidth = drag.startWidth + event.clientX - drag.startX
    applyTeamListWidth(drag.lastWidth, { persist: false })
    event.preventDefault()
  })

  resizer.addEventListener('pointerup', (event) => finish(event.pointerId))
  resizer.addEventListener('pointercancel', (event) => finish(event.pointerId))
  resizer.addEventListener('lostpointercapture', (event) => finish(event.pointerId))

  resizer.addEventListener('keydown', (event) => {
    const list = $('#team-list')
    if (!list) return
    const step = event.shiftKey ? 32 : 12
    let next = list.getBoundingClientRect().width
    if (event.key === 'ArrowLeft') next -= step
    else if (event.key === 'ArrowRight') next += step
    else if (event.key === 'Home') next = 128
    else if (event.key === 'End') next = 420
    else return
    event.preventDefault()
    applyTeamListWidth(next)
  })

  window.addEventListener('resize', () => {
    const list = $('#team-list')
    if (list) applyTeamListWidth(list.getBoundingClientRect().width, { persist: false })
  })
}

/** 当前分栏是不是团队模式（团队独占或团队+文件并排） */
function isTeamSplitMode(main) {
  return Boolean(main?.classList.contains('is-team-only') || main?.classList.contains('is-team-file'))
}

function bindFileSplitResizer() {
  const resizer = $('#file-split-resizer')
  if (!resizer || resizer.dataset.bound === '1') return
  resizer.dataset.bound = '1'
  let drag = null

  const finishDrag = (pointerId) => {
    if (!drag || (pointerId != null && pointerId !== drag.pointerId)) return
    const main = $('.chat-main')
    const varName = drag.team ? '--team-split' : '--file-split'
    const ratio = Number.parseFloat(main?.style.getPropertyValue(varName) || '') / 100
    if (Number.isFinite(ratio)) applySplitRatio(ratio, { team: drag.team })
    drag = null
    document.body.classList.remove('is-resizing-split')
  }

  resizer.addEventListener('pointerdown', (event) => {
    const main = $('.chat-main')
    if (!main?.classList.contains('is-workbench-open')) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const geometry = fileSplitContentWidth(main)
    drag = { pointerId: event.pointerId, ...geometry, team: isTeamSplitMode(main) }
    resizer.setPointerCapture?.(event.pointerId)
    document.body.classList.add('is-resizing-split')
    event.preventDefault()
  })

  resizer.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return
    const x = event.clientX - drag.rect.left - drag.padLeft
    const bounds = splitBounds(drag.team, drag.contentWidth)
    const ratio = Math.max(bounds.minRatio, Math.min(bounds.maxRatio, x / drag.contentWidth))
    applySplitRatio(ratio, { team: drag.team, persist: false })
    event.preventDefault()
  })

  resizer.addEventListener('pointerup', (event) => finishDrag(event.pointerId))
  resizer.addEventListener('pointercancel', (event) => finishDrag(event.pointerId))
  resizer.addEventListener('lostpointercapture', (event) => finishDrag(event.pointerId))

  resizer.addEventListener('keydown', (event) => {
    const main = $('.chat-main')
    if (!main?.classList.contains('is-workbench-open')) return
    const team = isTeamSplitMode(main)
    const varName = team ? '--team-split' : '--file-split'
    const current = Number.parseFloat(main.style.getPropertyValue(varName) || '') / 100
    let next = Number.isFinite(current) && current > 0 ? current : (team ? 0.56 : 0.5)
    if (event.key === 'ArrowLeft') next -= 0.02
    else if (event.key === 'ArrowRight') next += 0.02
    else if (event.key === 'Home') next = team ? 0.36 : 0.3
    else if (event.key === 'End') next = team ? 0.7 : 0.7
    else return
    event.preventDefault()
    applySplitRatio(next, { team })
  })

  // 窗口变窄时按新宽度重新夹一次，避免对话区被压没
  window.addEventListener('resize', () => {
    const main = $('.chat-main')
    if (!main?.classList.contains('is-workbench-open')) return
    const team = isTeamSplitMode(main)
    const varName = team ? '--team-split' : '--file-split'
    const current = Number.parseFloat(main.style.getPropertyValue(varName) || '') / 100
    if (Number.isFinite(current) && current > 0) {
      applySplitRatio(current, { team, persist: false })
    }
  })
}

async function boot() {
  const as = currentAs()
  $('#login-form').addEventListener('submit', doLogin)

  // 登录页右侧扫码入口由 setupLoginSso() 按公司已配置的渠道动态展示。

  for (const button of $('#mode-switch').querySelectorAll('[data-mode]')) {
    button.addEventListener('click', () => setChatMode(button.dataset.mode))
  }
  initSidebarToggle()
  bindFileSplitResizer()
  restoreTeamSplitRatio()
  bindTeamListResizer()
  restoreTeamListWidth()
  bindSideSectionResizer()
  bindWorkspaceFilePane()
  bindWorkbenchTabs()
  bindPermissionPane()
  bindSpacePicker()
  setChatMode('chat')
  syncSideSectionSplit()

  let hasSession = false
  try {
    await api('/api/auth/me')
    hasSession = true
  } catch {
    hasSession = false
  }

  // 既没有开发预览身份、也没有真实登录会话 → 只显示登录
  // ?login=1 可强制回到登录页，用于切换账号或验证扫码登录。
  const forceLogin = new URLSearchParams(location.search).get('login') === '1'
  if (forceLogin || (!as && !hasSession)) {
    showLogin()
    await renderLogin()
    await setupLoginSso()
    endBoot('正在打开登录入口…')
    return
  }

  $('#login-gate').hidden = true
  const deniedFromConsole = new URLSearchParams(location.search).get('console_denied') === '1'
  if (deniedFromConsole) {
    window.setTimeout(() => {
      banner('你没有权限进入管理后台，已进入对话页；如需后台权限，请联系平台管理员开通。', 'warn')
    }, 2600)
  }
  const sideShell = $('#chat-side')
  const stageShell = $('#chat-stage')
  if (sideShell) sideShell.hidden = false
  if (stageShell) stageShell.hidden = false
  $('#mode-switch').hidden = false
  $('#chat-title').hidden = false
  $('#demo-pill').hidden = true

  // 侧栏需要身份列表（开发预览可切换账号）
  await loadPersonas()

  let me = null
  try {
    me = await api(`/api/me${qs()}`)
    state.me = me
    state.chatSendMode = me.chatSendMode === 'interrupt' ? 'interrupt' : 'queue'
    state.assistant = me.assistant || { name: 'AI', avatarUrl: '' }
  } catch (err) {
    // as 指向不存在/失效的人 → 回到登录页，而不是显示别人的信息
    showLogin()
    await renderLogin()
    await setupLoginSso()
    $('#login-sub').textContent = `登录态无效（${err.message}），请重新登录。`
    $('#login-sub').hidden = false
    endBoot('登录态失效，正在打开登录入口…')
    return
  }

  renderSideUser(me)
  void refreshConsoleEntry()
  $('#side-files').hidden = false
  // 权限角标依赖登录态；登录成功后再拉取，避免登录页发出 401 请求。
  void refreshPermissionBadge()

  try {
    const models = await api(`/api/chat/models${qs()}`)
    state.models = models.models
    state.autoModelId = models.autoModelId
    state.canChat = models.canChat && models.canUseModel
    state.transcribeAvailable = Boolean(models.transcribe?.available)
    state.speechAvailable = Boolean(models.speech?.available)
    renderVoiceControls()
    renderWakeSettings()
    void loadVoiceSettings()
    restoreWakePreference()
    if (!state.canChat) {
      renderDenied(new Error('当前账号没有对话 / 使用模型的权限（chat:use、model:use）'))
      endBoot('权限校验完成…')
      return
    }
    if (models.models.length === 0) {
      renderDenied(new Error('你的角色里没有任何可用模型，请联系管理员授权'))
      endBoot('模型配置已加载…')
      return
    }
    renderModelMenus()
    setSelected('')
    renderEmpty(me)
    renderSuggestions()
    renderAttachments()
    $('#demo-pill').hidden = !models.models.every((model) => model.provider === 'demo')
    await loadSessions()
    setupChatEvents()
    await loadActiveRuns()
    const savedLocation = deniedFromConsole ? null : readChatLocation()
    if (state.sessions.length > 0) {
      const savedSessionId = savedLocation?.sessionId
      if (savedSessionId && state.sessions.some((session) => session.id === savedSessionId)) {
        await openSession(savedSessionId)
      } else if (savedSessionId === '') {
        newSession()
      } else {
        await openSession(state.sessions[0].id)
      }
    } else {
      newSession()
    }
    restoreChatLocation(savedLocation)
    await loadWorkspaceFiles()
  } catch (err) {
    renderDenied(err)
    endBoot('工作台加载遇到问题…')
    return
  }

  // 输入区
  $('#thread').addEventListener('scroll', onThreadScroll, { passive: true })
  $('#scroll-bottom').addEventListener('click', scrollThreadToBottomSmooth)
  window.addEventListener('resize', queueScrollBottomButtonUpdate)

  // 用户一上滚就立即解除贴底，不等 scroll 事件，避免流式增量抢先滚回底部。
  const threadEl = $('#thread')
  threadEl.addEventListener('wheel', (event) => {
    if (event.deltaY < 0) unpinThreadFromBottom()
  }, { passive: true })
  let touchStartY = 0
  threadEl.addEventListener('touchstart', (event) => {
    touchStartY = event.touches[0]?.clientY || 0
  }, { passive: true })
  threadEl.addEventListener('touchmove', (event) => {
    const y = event.touches[0]?.clientY || 0
    if (touchStartY && y - touchStartY > 6) unpinThreadFromBottom()
  }, { passive: true })
  document.addEventListener('keydown', (event) => {
    const target = event.target
    if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]')) return
    if (event.key === 'PageUp' || event.key === 'Home' || event.key === 'ArrowUp') {
      unpinThreadFromBottom()
    }
  })
  $('#send').addEventListener('click', () => {
    // 回复中主按钮是暂停；不在回复时才是发送。
    if (currentRuntime().sending) stopCurrentReply()
    else send()
  })
  $('#queue-stop').addEventListener('click', stopCurrentReply)
  $('#queue-send').addEventListener('click', () => send())
  $('#voice-mode')?.addEventListener('click', () => {
    if (state.voiceConversation.active) exitVoiceConversation()
    else void enterVoiceConversation()
  })
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (!state.voiceConversation.active) stopWakeListener({ keepEnabled: true })
      return
    }
    if (state.wake.enabled && !state.voiceConversation.active) scheduleWakeRestart(120)
  })
  window.addEventListener('pagehide', () => {
    if (!state.voiceConversation.active) stopWakeListener({ keepEnabled: true })
  })
  $('#voice-dock-action')?.addEventListener('click', handleVoiceDockAction)
  $('#voice-dock-exit')?.addEventListener('click', () => exitVoiceConversation())
  $('#input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send()
    }
  })
  $('#input').addEventListener('input', () => {
    autosize()
    updateSendState()
  })
  $('#input').addEventListener('focus', () => $('#composer-box').classList.add('is-focus'))

  // 空间选择：输入框左侧气泡（已在 boot 早期绑定，保证无模型时也可切换）
  // 云空间角标：悬停 / 聚焦 / 点击都能看到配额信息
  const quotaPopover = $('#ws-quota-popover')
  const quotaBadge = $('#ws-info')
  const showQuota = () => {
    if (!quotaPopover) return
    quotaPopover.hidden = false
    quotaBadge?.setAttribute('aria-expanded', 'true')
  }
  const hideQuota = () => {
    if (!quotaPopover) return
    quotaPopover.hidden = true
    quotaBadge?.setAttribute('aria-expanded', 'false')
  }
  quotaBadge?.addEventListener('mouseenter', showQuota)
  quotaBadge?.addEventListener('focus', showQuota)
  quotaBadge?.addEventListener('click', (event) => {
    event.stopPropagation()
    // 鼠标点击前会先触发 mouseenter；这里始终展示，避免点一下反而把浮层关掉。
    showQuota()
  })
  quotaBadge?.addEventListener('mouseleave', () => {
    if (!quotaBadge.matches(':focus')) hideQuota()
  })
  quotaBadge?.addEventListener('blur', hideQuota)
  quotaPopover?.addEventListener('mouseenter', showQuota)
  quotaPopover?.addEventListener('mouseleave', hideQuota)

  document.addEventListener('click', (event) => {
    if (!event.target.closest('#ws-info') && !event.target.closest('#ws-quota-popover')) hideQuota()
  })

  // 模型选择：输入框里的气泡
  $('#model-chip').addEventListener('click', () => {
    const menu = $('#model-menu')
    const open = menu.hidden
    menu.hidden = !open
    if (open) {
      $('#think-menu').hidden = true
      $('#think-chip').setAttribute('aria-expanded', 'false')
    }
    $('#model-chip').setAttribute('aria-expanded', open ? 'true' : 'false')
  })
  document.addEventListener('click', (event) => {
    if (!event.target.closest('#model-chip') && !event.target.closest('#model-menu')) {
      $('#model-menu').hidden = true
      $('#model-chip').setAttribute('aria-expanded', 'false')
    }
  })

  // 思考档位：只有模型开放思考选项时才出现
  $('#think-chip').addEventListener('click', () => {
    const menu = $('#think-menu')
    const open = menu.hidden
    menu.hidden = !open
    if (open) {
      $('#model-menu').hidden = true
      $('#model-chip').setAttribute('aria-expanded', 'false')
    }
    $('#think-chip').setAttribute('aria-expanded', open ? 'true' : 'false')
  })
  $('#think-menu').addEventListener('click', (event) => {
    const button = event.target.closest('[data-think]')
    if (button) setThinkingEffort(button.dataset.think)
  })
  document.addEventListener('click', (event) => {
    if (!event.target.closest('#think-wrap')) {
      $('#think-menu').hidden = true
      $('#think-chip').setAttribute('aria-expanded', 'false')
    }
  })

  // 附件：一个加号入口，菜单向上展开；后续新增能力只需往 add-menu 里加项
  const addTrigger = $('#pick-add')
  const addMenu = $('#add-menu')
  const hideAddMenu = (restoreFocus = false) => {
    if (!addMenu || addMenu.hidden) return
    addMenu.hidden = true
    addTrigger?.setAttribute('aria-expanded', 'false')
    if (restoreFocus) addTrigger?.focus()
  }
  addTrigger?.addEventListener('click', (event) => {
    event.stopPropagation()
    const open = addMenu?.hidden
    if (!addMenu) return
    addMenu.hidden = !open
    addTrigger.setAttribute('aria-expanded', open ? 'true' : 'false')
    if (open) $('#add-menu-image')?.focus()
  })
  document.addEventListener('click', (event) => {
    if (!event.target.closest('#pick-add') && !event.target.closest('#add-menu')) hideAddMenu()
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && addMenu && !addMenu.hidden) {
      event.preventDefault()
      hideAddMenu(true)
    }
  })
  $('#add-menu-image')?.addEventListener('click', () => {
    hideAddMenu(true)
    $('#file-image').click()
  })
  $('#add-menu-file')?.addEventListener('click', () => {
    hideAddMenu(true)
    $('#file-any').click()
  })
  $('#file-image').addEventListener('change', (event) => {
    addFiles(event.target.files || [])
    event.target.value = ''
  })
  $('#file-any').addEventListener('change', (event) => {
    addFiles(event.target.files || [])
    event.target.value = ''
  })

  // 粘贴：截图/图片/文件可直接 Ctrl+V 进输入区
  $('#composer-box').addEventListener('paste', (event) => {
    const items = Array.from(event.clipboardData?.items || [])
    const files = items
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter(Boolean)
    if (files.length === 0) return
    event.preventDefault()
    addFiles(files)
  })

  // 拖拽对象到输入区：对话和云空间对象只做引用，外部文件仍走上传。
  const composer = $('.composer')
  const composerBox = $('#composer-box')
  const clearComposerDrop = () => composerBox?.classList.remove('is-drop-target')
  const dragRef = (event, mime) => {
    try {
      const raw = event.dataTransfer?.getData(mime) || ''
      return raw ? JSON.parse(raw) : null
    } catch {
      return null
    }
  }
  const workspaceDragRef = (event) => dragRef(event, WORKSPACE_DRAG_MIME)
  const conversationDragRef = (event) => dragRef(event, CONVERSATION_DRAG_MIME)
  const hasComposerDrag = (types) =>
    types.includes(CONVERSATION_DRAG_MIME) || types.includes(WORKSPACE_DRAG_MIME) || types.includes('Files')
  composer?.addEventListener('dragenter', (event) => {
    const types = Array.from(event.dataTransfer?.types || [])
    if (hasComposerDrag(types)) composerBox?.classList.add('is-drop-target')
  })
  composer?.addEventListener('dragover', (event) => {
    const types = Array.from(event.dataTransfer?.types || [])
    if (!hasComposerDrag(types)) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    composerBox?.classList.add('is-drop-target')
  })
  composer?.addEventListener('dragleave', (event) => {
    if (!composer.contains(event.relatedTarget)) clearComposerDrop()
  })
  composer?.addEventListener('drop', (event) => {
    const conversationRef = conversationDragRef(event)
    if (conversationRef) {
      event.preventDefault()
      clearComposerDrop()
      addConversationReference(conversationRef)
      return
    }
    const ref = workspaceDragRef(event)
    if (ref) {
      event.preventDefault()
      clearComposerDrop()
      addWorkspaceReference(ref)
      return
    }
    const files = Array.from(event.dataTransfer?.files || [])
    if (files.length === 0) {
      clearComposerDrop()
      return
    }
    event.preventDefault()
    clearComposerDrop()
    addFiles(files)
  })

  // 会话
  $('#new-session').addEventListener('click', newSession)
  $('#session-menu').addEventListener('click', (event) => {
    const action = event.target.closest('[data-act]')
    if (!action) return
    const sessionId = $('#session-menu').dataset.session
    const session = sessionById(sessionId)
    hideSessionMenu()
    if (action.dataset.act === 'rename') renameSession(sessionId, session?.title)
    else if (action.dataset.act === 'delete') deleteSession(sessionId)
  })
  $('#file-menu').addEventListener('click', (event) => {
    const menu = $('#file-menu')
    const folderAction = event.target.closest('[data-folder-act]')
    if (folderAction) {
      const folderPath = menu.dataset.folder
      hideFileMenu()
      if (!folderPath || folderAction.disabled) return
      if (folderAction.dataset.folderAct === 'open') setWorkspacePath(folderPath)
      else if (folderAction.dataset.folderAct === 'new') createWorkspaceFolder(folderPath)
      else if (folderAction.dataset.folderAct === 'rename') renameWorkspaceFolder(folderPath)
      else if (folderAction.dataset.folderAct === 'delete') deleteWorkspaceFolder(folderPath)
      return
    }
    const action = event.target.closest('[data-file-act]')
    if (!action) return
    const fileId = menu.dataset.file
    const file = fileById(fileId)
    hideFileMenu()
    if (!file) return
    if (action.dataset.fileAct === 'rename') renameWorkspaceFile(file)
    else if (action.dataset.fileAct === 'edit') editWorkspaceFile(file)
    else if (action.dataset.fileAct === 'delete') deleteWorkspaceFile(file)
    else if (action.dataset.fileAct === 'send-dingtalk') sendWorkspaceFileToDingTalk(file)
    else if (action.dataset.fileAct === 'download') {
      downloadWorkspaceFile(file).catch((err) => banner(err.message, 'bad'))
    }
  })
  $('#message-menu').addEventListener('click', (event) => {
    const action = event.target.closest('[data-message-act]')
    if (!action || action.disabled) return
    const id = $('#message-menu').dataset.message
    const node = Array.from($('#thread').querySelectorAll('.msg[data-message-id]')).find(
      (item) => item.dataset.messageId === id,
    )
    const message = node?.chatMessage || null
    hideMessageMenu()
    if (!message) return
    handleMessageAction(action.dataset.messageAct, message)
  })
  $('#message-edit-cancel').addEventListener('click', () => cancelMessageEdit({ clearInput: true }))
  $('#thread').addEventListener('click', (event) => {
    const action = event.target.closest('.msg-actions [data-message-act]')
    if (!action || action.disabled) return
    const node = action.closest('.msg')
    const message = node?.chatMessage || null
    if (!message) return
    event.preventDefault()
    event.stopPropagation()
    hideMessageMenu()
    handleMessageAction(action.dataset.messageAct, message)
  })
  $('#thread').addEventListener('contextmenu', (event) => {
    const node = event.target.closest('.msg')
    if (!node || !node.dataset.messageId) return
    event.preventDefault()
    showMessageMenu(node, event.clientX, event.clientY)
  })
  $('#thread').addEventListener('scroll', hideMessageMenu, { passive: true })
  document.addEventListener('click', (event) => {
    if (!event.target.closest('#session-menu') && !event.target.closest('.side-session-more')) hideSessionMenu()
    if (!event.target.closest('#file-menu') && !event.target.closest('.side-file-more')) hideFileMenu()
    if (!event.target.closest('#message-menu')) hideMessageMenu()
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hideSessionMenu()
      hideFileMenu()
      hideSpaceMenu()
      hideQuota()
      hideMessageMenu()
    }
  })
  window.addEventListener('resize', () => {
    hideSessionMenu()
    hideFileMenu()
    hideSpaceMenu()
    hideQuota()
    hideMessageMenu()
  })
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !workspacePreviewWatchTimer || !state.filePreview) return
    void checkWorkspacePreviewAccess(String(state.filePreview.id), workspacePreviewWatchEpoch)
  })

  // 个人工作区
  $('#ws-new-folder').addEventListener('click', () => createWorkspaceFolder())
  $('#ws-upload').addEventListener('click', () => $('#ws-input').click())
  $('#ws-input').addEventListener('change', async (event) => {
    // FileList 是实时集合：先复制再清空 input，否则 next files.length 会变成 0。
    const files = Array.from(event.target.files || [])
    event.target.value = ''
    if (files.length) await uploadWorkspaceFiles(files)
  })
  $('#ws-upload-status').addEventListener('click', (event) => {
    if (!event.target.closest('[data-ws-upload-close]')) return
    window.clearTimeout(state.wsUploadHideTimer)
    state.wsUploads = []
    renderWorkspaceUploads()
  })

  // 设置入口与设置页
  bindSettings()
  $('#login-btn').addEventListener('click', () => {
    location.href = '/chat'
  })

  $('#input').focus()
  applyWorkspaceDeepLink()
  endBoot('正在进入工作台…')
}

bindSettings()
window.addEventListener('eab:branding', () => {
  try { paintLoginBrand() } catch { /* 登录页不在当前视图时忽略 */ }
})
bindHintTips($('#workspace-pane'))
bindThreadHintTips()
watchThreadTitles()
bindWorkspaceKindSwitch()
boot()
