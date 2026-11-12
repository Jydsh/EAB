/**
 * 模型思考档位。
 *
 * 口径对齐 DSH 的 Effort：
 * - 档位不是提示词，而是真实下发到上游的控制项；
 * - 默认提供「精简 / 均衡 / 深思」三档，默认均衡；
 * - 模型可以只开放其中一部分档位；
 * - `strategy = budget` 时把档位换算成 max_tokens 上限，适合忽略
 *   reasoning_effort 的网关；`strategy = effort` 时下发原生思考参数。
 *
 * 插件模型由插件自己的 reasoning 声明推导档位，管理员不需要重复配置。
 */

export type ThinkingStrategy = 'effort' | 'budget'

export interface ThinkingOption {
  readonly id: string
  readonly label: string
  readonly hint: string
}

export interface ThinkingConfig {
  readonly enabled: boolean
  readonly options: readonly ThinkingOption[]
  readonly defaultEffort: string
  readonly strategy: ThinkingStrategy
  /** model = 控制台配置；plugin = 插件声明 */
  readonly source: 'model' | 'plugin'
}

interface LevelDefinition extends ThinkingOption {
  readonly budget: number | null
}

/** DSH 的三档；顺序就是选择器里的顺序。 */
export const THINKING_LEVELS: readonly LevelDefinition[] = [
  {
    id: 'light',
    label: '精简',
    hint: '更少思考，更快回答。',
    budget: 2048,
  },
  {
    id: 'balanced',
    label: '均衡',
    hint: '默认档位，兼顾速度与质量。',
    budget: 8192,
  },
  {
    id: 'deep',
    label: '深思',
    hint: '更充分的推理，输出上限跟随模型。',
    budget: null,
  },
]

/** 供应商原生档位的展示名；插件声明这些 id 时也能直接显示。 */
const EXTRA_LEVELS: Readonly<Record<string, ThinkingOption>> = {
  low: { id: 'low', label: '低', hint: '较少的推理投入。' },
  medium: { id: 'medium', label: '中', hint: '适中的推理投入。' },
  high: { id: 'high', label: '高', hint: '较多的推理投入。' },
  xhigh: { id: 'xhigh', label: '极高', hint: '很高的推理投入。' },
  max: { id: 'max', label: '最大', hint: '模型允许的最大推理投入。' },
  disabled: { id: 'disabled', label: '关闭', hint: '本轮不进行思考。' },
}

const LEVEL_MAP = new Map<string, ThinkingOption>(
  [...THINKING_LEVELS, ...Object.values(EXTRA_LEVELS)].map((level) => [level.id, level]),
)

export const DEFAULT_THINKING_LEVELS = THINKING_LEVELS.map((level) => level.id)

export function thinkingLabel(id: string): string {
  return LEVEL_MAP.get(id)?.label ?? id
}

export function thinkingHint(id: string): string {
  return LEVEL_MAP.get(id)?.hint ?? '上游模型声明的思考档位。'
}

export function thinkingOption(id: string): ThinkingOption {
  return LEVEL_MAP.get(id) ?? { id, label: id, hint: '上游模型声明的思考档位。' }
}

/**
 * 插件声明的文案优先，但已知档位遇到英文声明时仍用中文标准名，
 * 避免中文界面里出现 Low / Medium / High。
 */
function declaredText(id: string, value: unknown, fallback: string): string {
  const text = String(value ?? '').trim()
  if (!text) return fallback
  if (fallback !== id && !/[\u4e00-\u9fff]/.test(text)) return fallback
  return text
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function rawOptionId(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  const record = asRecord(value)
  return String(record.id ?? '').trim()
}

function normalizeOptionList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(rawOptionId).filter((id) => id.length > 0 && id.length <= 40))].slice(0, 8)
}

/**
 * 读取并规范化管理员保存的思考配置。
 *
 * 允许 `true` 作为「开启三档」的简写；其它非法形状一律当作未开启，
 * 避免把半截配置下发给上游。
 */
export function readThinkingConfig(raw: unknown, source: 'model' | 'plugin' = 'model'): ThinkingConfig | null {
  if (raw === true) {
    return {
      enabled: true,
      options: THINKING_LEVELS.map(({ id, label, hint }) => ({ id, label, hint })),
      defaultEffort: 'balanced',
      strategy: 'effort',
      source,
    }
  }
  const record = asRecord(raw)
  if (record.enabled === false) return null
  if (Object.keys(record).length === 0) return null

  const optionIds = normalizeOptionList(record.options ?? record.efforts)
  if (optionIds.length === 0) return null
  const options = optionIds.map(thinkingOption)
  const requestedDefault = String(record.defaultEffort ?? record.default ?? '').trim()
  const defaultEffort = optionIds.includes(requestedDefault) ? requestedDefault : optionIds[0]
  const strategy: ThinkingStrategy = record.strategy === 'budget' ? 'budget' : 'effort'

  return {
    enabled: true,
    options,
    defaultEffort,
    strategy,
    source,
  }
}

/** 从模型 config_json 的 `thinking` 字段读配置。 */
export function thinkingConfigOf(config: Record<string, unknown> | null | undefined): ThinkingConfig | null {
  return readThinkingConfig(config?.thinking)
}

/** 输出给控制台保存的紧凑结构。 */
export function storedThinkingConfig(config: ThinkingConfig | null): Record<string, unknown> | null {
  if (!config?.enabled || config.options.length === 0) return null
  return {
    enabled: true,
    options: config.options.map((option) => option.id),
    defaultEffort: config.defaultEffort,
    strategy: config.strategy,
  }
}

/** 选中的档位必须属于该模型；非法或过期选择回落到模型默认档位。 */
export function resolveThinkingEffort(config: ThinkingConfig | null, requested: string | null | undefined): string {
  if (!config?.enabled || config.options.length === 0) return ''
  const choice = String(requested ?? '').trim()
  return config.options.some((option) => option.id === choice) ? choice : config.defaultEffort
}

/** 某个档位在 budget 策略下的输出上限；深思没有上限。 */
export function thinkingBudgetCeiling(effort: string): number | null {
  const level = THINKING_LEVELS.find((item) => item.id === effort)
  if (level) return level.budget
  if (effort === 'low') return 2048
  if (effort === 'medium') return 8192
  if (effort === 'high') return 16384
  if (effort === 'xhigh') return 32768
  return null
}

/** OpenAI 兼容协议的实际字段值。未知档位不猜，直接不下发。 */
export function providerReasoningEffort(effort: string): string | undefined {
  const mapped: Record<string, string> = {
    light: 'low',
    balanced: 'medium',
    deep: 'high',
  }
  const wire = mapped[effort] ?? effort
  return ['low', 'medium', 'high', 'xhigh', 'max', 'none', 'minimal'].includes(wire) ? wire : undefined
}

/** Anthropic extended-thinking 预算；必须小于 max_tokens。 */
export function anthropicThinkingBudget(effort: string, maxTokens: number): number | undefined {
  if (effort === 'disabled') return undefined
  if (maxTokens <= 1024) return undefined
  const mapped: Record<string, number> = {
    light: 1024,
    low: 1024,
    balanced: 4096,
    medium: 4096,
    deep: 16384,
    high: 16384,
    xhigh: 24576,
    max: 24576,
  }
  const budget = mapped[effort]
  if (budget === undefined) return undefined
  return Math.max(1024, Math.min(budget, maxTokens - 1))
}

/** Gemini thinkingConfig.thinkingBudget；-1 表示由模型动态决定。 */
export function geminiThinkingBudget(effort: string): number | undefined {
  if (effort === 'disabled') return 0
  const mapped: Record<string, number> = {
    light: 1024,
    low: 1024,
    balanced: 8192,
    medium: 8192,
    deep: 24576,
    high: 24576,
    xhigh: 32768,
    max: -1,
  }
  return mapped[effort]
}

/**
 * 把插件 adapter 的 `reasoning` 声明转成 EAB 的档位配置。
 *
 * DSH 形状：
 *   { efforts: [{ id, name, description }], defaultEffort: 'balanced' }
 */
export function thinkingConfigFromDeclaredReasoning(raw: unknown): ThinkingConfig | null {
  const reasoning = asRecord(raw)
  const efforts = Array.isArray(reasoning.efforts) ? reasoning.efforts : []
  const seen = new Set<string>()
  const options: ThinkingOption[] = []
  for (const effort of efforts) {
    const id = rawOptionId(effort)
    if (!id || id.length > 40 || seen.has(id)) continue
    const declared = asRecord(effort)
    options.push({
      id,
      label: declaredText(id, declared.name, thinkingLabel(id)),
      hint: declaredText(id, declared.description, thinkingHint(id)),
    })
    seen.add(id)
    if (options.length >= 8) break
  }
  if (options.length === 0) return null
  const ids = options.map((option) => option.id)
  const requestedDefault = String(reasoning.defaultEffort ?? '').trim()
  const defaultEffort = ids.includes(requestedDefault) ? requestedDefault : ids[0]
  return {
    enabled: true,
    options,
    defaultEffort,
    strategy: 'effort',
    source: 'plugin',
  }
}
