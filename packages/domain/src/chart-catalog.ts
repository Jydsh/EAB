/**
 * EAB 图表能力目录（唯一数据源）。
 *
 * 三处消费者都必须从这里取类型清单，禁止各写一份：
 * - Agent 提示词：告诉模型现在到底能用哪些图表、怎么选、数据怎么给；
 * - 网页渲染器：`public/chat.js` 的 type 别名与 17 个 renderer 必须覆盖这里的 id；
 * - 钉钉 A2UI：`dingtalk-chart.ts` 把同一份配置降级到钉钉原生的三种图表协议。
 *
 * 以后加图表：先在这里加一条（enabled=true），再补网页 renderer 和钉钉映射，
 * Agent 提示词会自动带上新类型，不需要再改提示词文案。
 */

export const CHART_TYPE_IDS = [
  'pie',
  'doughnut',
  'bar',
  'horizontalBar',
  'line',
  'area',
  'scatter',
  'radar',
  'polarArea',
  'bubble',
  'stackedBar',
  'groupedBar',
  'rose',
  'gauge',
  'funnel',
  'heatmap',
  'waterfall',
] as const

export type ChartTypeId = (typeof CHART_TYPE_IDS)[number]

export type ChartDataShape =
  | 'value-list'
  | 'multi-series'
  | 'xy'
  | 'xy-size'
  | 'gauge'
  | 'heatmap'

/** 对外提供图表的渠道。钉钉消息与网页对话的原生渲染能力不同，能力清单必须分开。 */
export type ChartChannel = 'web' | 'dingtalk'

export interface ChartDingTalkCapability {
  /** 钉钉原生协议最终落成的图表类型。 */
  chart: 'pieChart' | 'histogram' | 'lineChart'
  /**
   * native=钉钉原生就能画成同形；
   * approx/fallback=只能换成另一种几何，视觉上会失真，钉钉端不再对外宣称支持。
   */
  fidelity: 'native' | 'approx' | 'fallback'
  note: string
}

export interface ChartTypeDefinition {
  id: ChartTypeId
  /** 中文名 + 常见英文/中文别名；网页和钉钉都按这份别名识别。 */
  aliases: readonly string[]
  name: string
  /** 什么时候该选它，给 Agent 做选型依据。 */
  purpose: string
  shape: ChartDataShape
  limits: string
  /** 是否已经同时具备网页与钉钉渲染能力。 */
  enabled: boolean
  dingtalk: ChartDingTalkCapability
  /** 标准配置示例；Agent 可直接照抄结构换数据。 */
  example: Record<string, unknown>
}

const VALUE_EXAMPLE = {
  type: 'bar',
  title: '各站加班时长',
  unit: '小时',
  data: [
    { label: '安顺', value: 214.79 },
    { label: '贵阳北', value: 10.93 },
  ],
}

const SERIES_EXAMPLE = {
  type: 'groupedBar',
  title: '按旬对比',
  unit: '小时',
  categories: ['11/01-11/10', '11/11-11/20'],
  series: [
    { name: '安顺', data: [61.72, 112.57] },
    { name: '贵阳北', data: [10.93, 0] },
  ],
}

const FOUR_VALUE_EXAMPLE = {
  type: 'rose',
  title: '按旬时长',
  unit: '小时',
  data: [
    { label: '11/01-11/10', value: 72.65 },
    { label: '11/11-11/20', value: 122.57 },
    { label: '11/21-11/24', value: 30.5 },
    { label: '合计', value: 225.72 },
  ],
}

export const CHART_CATALOG: readonly ChartTypeDefinition[] = [
  {
    id: 'pie',
    aliases: ['pie', '饼图', '占比图'],
    name: '饼图',
    purpose: '看构成与占比，分类不超过 10 项',
    shape: 'value-list',
    limits: '最多 10 项，超过合并为“其他”',
    enabled: true,
    dingtalk: { chart: 'pieChart', fidelity: 'native', note: '原生饼图' },
    example: { ...VALUE_EXAMPLE, type: 'pie', title: '作业地占比' },
  },
  {
    id: 'doughnut',
    aliases: ['doughnut', 'donut', 'ring', '环形图', '甜甜圈图', '圆环图'],
    name: '环形图',
    purpose: '和饼图相同，但中间留白可放合计',
    shape: 'value-list',
    limits: '最多 10 项',
    enabled: true,
    dingtalk: { chart: 'pieChart', fidelity: 'approx', note: '钉钉无环形挖空，按饼图展示' },
    example: { ...VALUE_EXAMPLE, type: 'doughnut', title: '作业地占比' },
  },
  {
    id: 'bar',
    aliases: ['bar', 'column', 'verticalBar', '柱状图', '纵向柱状图', '柱形图'],
    name: '纵向柱状图',
    purpose: '分类之间比大小，分类名较短时优先',
    shape: 'value-list',
    limits: '最多 10 项',
    enabled: true,
    dingtalk: { chart: 'histogram', fidelity: 'native', note: '原生柱状图' },
    example: { ...VALUE_EXAMPLE, type: 'bar', title: '各站加班时长' },
  },
  {
    id: 'horizontalBar',
    aliases: ['horizontalBar', 'horizontal-bar', 'hbar', 'barh', '条形图', '横向柱状图', '横向条形图'],
    name: '横向条形图',
    purpose: '分类名较长或项目多时，横排更好读',
    shape: 'value-list',
    limits: '最多 10 项',
    enabled: true,
    dingtalk: { chart: 'histogram', fidelity: 'native', note: '柱状图旋转 90°，横向展示' },
    example: { ...VALUE_EXAMPLE, type: 'horizontalBar', title: '各站加班时长' },
  },
  {
    id: 'line',
    aliases: ['line', 'trend', '折线图', '趋势图', '双轴折线图'],
    name: '折线图',
    purpose: '按时间或序号看趋势；多系列可配左右轴',
    shape: 'multi-series',
    limits: '最多 12 个类别、4 个系列',
    enabled: true,
    dingtalk: { chart: 'lineChart', fidelity: 'native', note: '原生折线图' },
    example: {
      type: 'line',
      title: '按旬趋势',
      unit: '小时',
      categories: ['11/01-11/10', '11/11-11/20', '11/21-11/24'],
      series: [{ name: '加班时长', data: [72.65, 122.57, 30.5] }],
    },
  },
  {
    id: 'area',
    aliases: ['area', '面积图', '面积折线图'],
    name: '面积图',
    purpose: '强调累计量或趋势的体量',
    shape: 'multi-series',
    limits: '最多 12 个类别、4 个系列',
    enabled: true,
    dingtalk: { chart: 'lineChart', fidelity: 'approx', note: '钉钉无面积填充，按折线展示' },
    example: {
      type: 'area',
      title: '按旬累计趋势',
      unit: '小时',
      categories: ['11/01-11/10', '11/11-11/20', '11/21-11/24'],
      series: [{ name: '加班时长', data: [72.65, 122.57, 30.5] }],
    },
  },
  {
    id: 'scatter',
    aliases: ['scatter', 'point', '散点图', '点图'],
    name: '散点图',
    purpose: '看两个数值之间的关系、离群点',
    shape: 'xy',
    limits: '最多 4 个系列、每系列 30 点',
    enabled: true,
    dingtalk: { chart: 'lineChart', fidelity: 'native', note: 'lineShape=dot，只画点不连线，和散点图同形' },
    example: {
      type: 'scatter',
      title: '条序与时长',
      xLabel: '条序',
      yLabel: '时长（小时）',
      series: [{ name: '赵帆', data: [[1, 4.5], [2, 3.2], [3, 5.1]] }],
    },
  },
  {
    id: 'radar',
    aliases: ['radar', 'spider', '雷达图', '蜘蛛图'],
    name: '雷达图',
    purpose: '3–8 个维度做画像或能力对比',
    shape: 'multi-series',
    limits: '3–8 个维度、最多 4 个系列',
    enabled: true,
    dingtalk: { chart: 'histogram', fidelity: 'fallback', note: '归一化后按维度分组柱展示' },
    example: {
      type: 'radar',
      title: '三人画像对比',
      categories: ['合计', '平均/次', '最大单次', '加班天数'],
      series: [
        { name: '赵帆', data: [195.86, 9.79, 15.08, 20] },
        { name: '张翔', data: [127.71, 6.72, 9.02, 19] },
      ],
    },
  },
  {
    id: 'polarArea',
    aliases: ['polarArea', 'polar-area', 'polar', '极坐标面积图', '极坐标图', '南丁格尔极区图'],
    name: '极坐标面积图',
    purpose: '分类不多时，用扇形面积比较数值',
    shape: 'value-list',
    limits: '最多 8 项',
    enabled: true,
    dingtalk: { chart: 'pieChart', fidelity: 'approx', note: '钉钉无极坐标，按饼图展示' },
    example: { ...FOUR_VALUE_EXAMPLE, type: 'polarArea', title: '按旬时长' },
  },
  {
    id: 'bubble',
    aliases: ['bubble', '气泡图', '气泡散点图'],
    name: '气泡图',
    purpose: '在散点关系上再加一个大小维度',
    shape: 'xy-size',
    limits: '最多 4 个系列、每系列 30 点',
    enabled: true,
    dingtalk: { chart: 'lineChart', fidelity: 'approx', note: '保留 X/Y，气泡大小不展示' },
    example: {
      type: 'bubble',
      title: '时长×开始时刻',
      xLabel: '开始时刻',
      yLabel: '时长（小时）',
      series: [{
        name: '魏竣豪',
        data: [
          { label: '11/05', x: 18, y: 10.93, r: 11 },
          { label: '11/07', x: 8.1, y: 17.33, r: 17 },
        ],
      }],
    },
  },
  {
    id: 'stackedBar',
    aliases: ['stackedBar', 'stacked-bar', 'stack', '堆叠柱状图', '堆叠柱'],
    name: '堆叠柱状图',
    purpose: '看每个分类内各部分组成与总量',
    shape: 'multi-series',
    limits: '最多 10 个类别、4 个系列',
    enabled: true,
    dingtalk: { chart: 'histogram', fidelity: 'native', note: '原生堆叠柱' },
    example: {
      ...SERIES_EXAMPLE,
      type: 'stackedBar',
      title: '作业地按旬堆叠',
      stacked: true,
    },
  },
  {
    id: 'groupedBar',
    aliases: ['groupedBar', 'grouped-bar', 'grouped', '分组柱状图', '分组柱', '簇状柱状图'],
    name: '分组柱状图',
    purpose: '同一分类下多系列并排比较',
    shape: 'multi-series',
    limits: '最多 10 个类别、4 个系列',
    enabled: true,
    dingtalk: { chart: 'histogram', fidelity: 'native', note: '原生分组柱' },
    example: { ...SERIES_EXAMPLE, type: 'groupedBar' },
  },
  {
    id: 'rose',
    aliases: ['rose', 'nightingale', '南丁格尔玫瑰图', '玫瑰图', '玫瑰'],
    name: '玫瑰图',
    purpose: '像饼图看占比，同时用半径强化差异',
    shape: 'value-list',
    limits: '最多 10 项',
    enabled: true,
    dingtalk: { chart: 'pieChart', fidelity: 'approx', note: '钉钉无玫瑰半径差，按饼图展示' },
    example: { ...FOUR_VALUE_EXAMPLE, type: 'rose', title: '按旬时长' },
  },
  {
    id: 'gauge',
    aliases: ['gauge', '仪表盘', '仪表图', '进度仪表'],
    name: '仪表盘',
    purpose: '单个指标对目标的完成度',
    shape: 'gauge',
    limits: '一个数值 + min/max',
    enabled: true,
    dingtalk: { chart: 'pieChart', fidelity: 'fallback', note: '按已用/剩余两段饼图展示' },
    example: {
      type: 'gauge',
      title: '本月累计加班',
      unit: '小时',
      value: 225.72,
      min: 0,
      max: 240,
    },
  },
  {
    id: 'funnel',
    aliases: ['funnel', '漏斗图', '转化漏斗'],
    name: '漏斗图',
    purpose: '看流程各环节的逐级转化与流失',
    shape: 'value-list',
    limits: '最多 8 阶，按数值从大到小',
    enabled: true,
    dingtalk: { chart: 'histogram', fidelity: 'fallback', note: '按从大到小柱状展示' },
    example: {
      type: 'funnel',
      title: '时长区间分布',
      unit: '条',
      data: [
        { label: '≥15H', value: 5 },
        { label: '12-15H', value: 3 },
        { label: '10-12H', value: 8 },
        { label: '<10H', value: 2 },
      ],
    },
  },
  {
    id: 'heatmap',
    aliases: ['heatmap', 'heat-map', '热力图', '热图'],
    name: '热力图',
    purpose: '看二维矩阵里的高低分布',
    shape: 'heatmap',
    limits: '最多 8×8 个格子',
    enabled: true,
    dingtalk: { chart: 'histogram', fidelity: 'fallback', note: '按行归一化后分组柱展示' },
    example: {
      type: 'heatmap',
      title: '上中下旬×指标',
      xAxis: ['11/01-11/10', '11/11-11/20', '11/21-11/24'],
      yAxis: ['总时长', '平均时长', '最长单次'],
      data: [
        [0, 0, 72.65], [1, 0, 122.57], [2, 0, 30.5],
        [0, 1, 12.11], [1, 1, 15.32], [2, 1, 8.4],
        [0, 2, 15.08], [1, 2, 17.33], [2, 2, 9.4],
      ],
    },
  },
  {
    id: 'waterfall',
    aliases: ['waterfall', '瀑布图', '瀑布'],
    name: '瀑布图',
    purpose: '看逐项累加、增减和最终合计',
    shape: 'value-list',
    limits: '最多 12 项，合计项标 total:true',
    enabled: true,
    dingtalk: { chart: 'histogram', fidelity: 'fallback', note: '按原始增减柱展示，不做悬空桥接' },
    example: {
      type: 'waterfall',
      title: '加班时长累加',
      unit: '小时',
      data: [
        { label: '11/01-11/10', value: 72.65 },
        { label: '11/11-11/20', value: 122.57 },
        { label: '11/21-11/24', value: 30.5 },
        { label: '合计', value: 225.72, total: true },
      ],
    },
  },
]

export const CHART_TYPE_COUNT = CHART_CATALOG.length

const CHART_ALIAS_INDEX = new Map<string, ChartTypeId>(
  CHART_CATALOG.flatMap((definition) =>
    definition.aliases.map((alias) => [alias.toLowerCase(), definition.id] as const),
  ),
)

/**
 * 某个渠道是否真的能画这种图。
 * 网页端由自己的 SVG renderer 全量支持；钉钉只有 fidelity=native 的类型才算真的支持，
 * 近似/降级类型不再宣称可用，避免 Agent 输出后在钉钉里变形或被丢弃。
 */
export function chartSupportsChannel(id: ChartTypeId, channel: ChartChannel): boolean {
  const definition = chartTypeDefinition(id)
  if (!definition.enabled) return false
  return channel === 'web' || definition.dingtalk.fidelity === 'native'
}

/** 按渠道过滤后的图表清单；Agent 提示词和目录 API 都从这里取，避免两边口径不一致。 */
export function chartCatalogForChannel(channel: ChartChannel = 'web'): readonly ChartTypeDefinition[] {
  return CHART_CATALOG.filter((definition) => chartSupportsChannel(definition.id, channel))
}

export function chartCountForChannel(channel: ChartChannel = 'web'): number {
  return chartCatalogForChannel(channel).length
}

export function resolveChartType(value: unknown): ChartTypeId | null {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return raw ? CHART_ALIAS_INDEX.get(raw) ?? null : null
}

export function chartTypeDefinition(id: ChartTypeId): ChartTypeDefinition {
  const definition = CHART_CATALOG.find((item) => item.id === id)
  if (!definition) throw new Error(`unknown chart type: ${id}`)
  return definition
}

const SHAPE_GUIDE: Record<ChartDataShape, string> = {
  'value-list': '{"data":[{"label":"A","value":3}]}；waterfall 的合计项加 "total":true。',
  'multi-series': '{"categories":["A","B"],"series":[{"name":"甲","data":[3,5]}]}；stackedBar 加 "stacked":true；line/area 右轴系列加 "axis":"right" 并给 "unitRight"。',
  xy: '{"series":[{"name":"甲","data":[[1,4.5],[2,3.2]]}]}，也可只给 data:[4.5,3.2] 让 X 按条序。',
  'xy-size': '{"series":[{"name":"甲","data":[{"x":1,"y":4.5,"r":8}]}]}，r 是气泡半径。',
  gauge: '{"value":225.72,"min":0,"max":240,"unit":"小时"}。',
  heatmap: '{"xAxis":["A","B"],"yAxis":["甲","乙"],"data":[[0,0,3],[1,0,5]]}，data 是 [x下标,y下标,数值]。',
}

/** 给 Agent 的图表能力说明；类型清单、数量、数据形态全部由目录按渠道生成。 */
export function chartCatalogPrompt(channel: ChartChannel = 'web'): string {
  const types = chartCatalogForChannel(channel)
  const count = types.length
  const channelLabel = channel === 'dingtalk' ? '钉钉消息' : '网页对话'
  const lines = types.map(
    (item) => `- ${item.id}（${item.name}，${item.shape}）：${item.purpose}；${item.limits}`,
  )
  const shapes = [...new Set(types.map((item) => item.shape))]
  const shapeLines = shapes.map((shape, index) => {
    const ids = types.filter((item) => item.shape === shape).map((item) => item.id)
    return `${index + 1}. ${shape}（${ids.join('/')}）：${SHAPE_GUIDE[shape] ?? '按该类型的 limits 给数据。'}`
  })
  const channelRule = channel === 'dingtalk'
    ? '钉钉卡片原生只认 lineChart、histogram、pieChart；清单里剩下的都是能保持原形的类型。清单外的类型（如环形、面积、雷达、极坐标、气泡、玫瑰、仪表盘、漏斗、热力、瀑布）在钉钉会被丢弃或变形，不要输出，改为说明“该图请在网页端查看”，并推荐清单内的近似类型。'
    : '网页端 17 种图表都有独立 SVG 渲染器；type 在清单内就能显示。'
  return [
    `【图表能力｜${channelLabel}当前可用 ${count} 种，统一用代码块输出 JSON，语言标记固定写 chart】`,
    '用户问“有哪些图表/能画什么图”时，直接按这份清单回答，不要猜、不要去搜工具。',
    ...lines,
    '数据结构（按 shape 分组，新增同形态图表会自动归入对应组）：',
    ...shapeLines,
    '选型：每条的类型名和 purpose 就是选型依据；常见场景——占比 pie/doughnut，比较 bar/horizontalBar，趋势 line/area，关系 scatter，大小+关系 bubble，多维画像 radar，结构对比 stackedBar/groupedBar，单指标完成度 gauge，流程转化 funnel，二维分布 heatmap，逐项累加 waterfall。',
    channelRule,
    `硬约束：type 只能是上面 ${count} 个 id；data 的每个数值必须来自工具真实结果或已抄好的统计，没有可靠数据就不要画。`,
  ].join('\n')
}

/** 非数据回合也要让 Agent 知道“现在有哪些图表”，但只给一行摘要，避免每轮塞满提示词。 */
export function chartCatalogSummary(channel: ChartChannel = 'web'): string {
  const types = chartCatalogForChannel(channel)
  const channelLabel = channel === 'dingtalk' ? '钉钉消息' : '网页对话'
  return `【图表能力｜${channelLabel}】当前可用 ${types.length} 种：${types.map((item) => `${item.id}(${item.name})`).join('、')}。用户问图表能力时按这份清单回答；要画图时按数据回合规则，用语言标记为 chart 的代码块输出 JSON。`
}
