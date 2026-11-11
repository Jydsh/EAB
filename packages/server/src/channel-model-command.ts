/**
 * 渠道机器人（钉钉/后续飞书、企微）的对话内模型切换。
 *
 * 与网页共用同一套语义：
 * - /model、切换模型：列出当前身份可用模型；
 * - /auto、切换到自动：清空会话固定模型；
 * - /model X、切换到 X、切换模型到 X、换成 X、使用 X 模型：切换。
 *
 * 本模块只做纯文本解析和可见模型匹配，不读 DB、不调用模型；
 * 候选模型必须由调用方传入已经按角色过滤后的 available 列表。
 */

export interface ChannelModelOption {
  id: string
  name: string
  desc?: string
  tags?: readonly string[]
}

export type ChannelModelCommandKind = 'list' | 'auto' | 'switch' | 'ambiguous' | 'not-found'

export interface ChannelModelCommandResult {
  kind: ChannelModelCommandKind
  text: string
  /** switch 时为选中的模型 ID；auto 时为 null；list/ambig/not-found 不修改。 */
  modelId?: string | null
}

function compact(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s\u3000·_.\-/／（）()]+/g, '')
}

function modelName(models: readonly ChannelModelOption[], modelId: string | null): string {
  if (!modelId) return '自动选择'
  return models.find((model) => model.id === modelId)?.name || '当前模型不可用'
}

function availableListText(models: readonly ChannelModelOption[], currentModelId: string | null): string {
  const header = `当前模型：${modelName(models, currentModelId)}`
  if (models.length === 0) {
    return `${header}\n当前身份没有可用的模型，请联系管理员授权。`
  }
  const rows = models.map((model, index) => `${index + 1}. ${model.name}`).join('\n')
  return `${header}\n可用模型（${models.length}）：\n${rows}\n\n发送 /model 模型名 切换；发送 /auto 恢复自动选择。`
}

function parseQuery(text: string): string {
  return String(text || '')
    .trim()
    .replace(/(?:模型|吧|呢|。|！|!)$/g, '')
    .trim()
}

export function matchChannelModels(
  models: readonly ChannelModelOption[],
  query: string,
): ChannelModelOption[] {
  const q = compact(query).replace(/模型$/g, '')
  if (!q) return []
  const exact = models.filter((model) => compact(model.name) === q || compact(model.id) === q)
  if (exact.length > 0) return exact
  return models.filter((model) => {
    const name = compact(model.name)
    const id = compact(model.id)
    return name.includes(q) || id.includes(q) || (name.length >= 2 && q.includes(name))
  })
}

/**
 * 解析一条渠道消息；不是模型命令时返回 null，调用方继续走普通对话。
 * 传入的 models 已经是当前员工可见模型；本函数不会访问任何未传入的模型。
 */
export function planChannelModelCommand(
  text: string,
  models: readonly ChannelModelOption[],
  currentModelId: string | null,
): ChannelModelCommandResult | null {
  const raw = String(text || '').trim()
  if (!raw || raw.length > 160) return null

  if (/^\/(model|models|模型)$/i.test(raw) || /^(切换模型|换模型)$/.test(raw)) {
    return { kind: 'list', text: availableListText(models, currentModelId) }
  }
  if (/^\/(auto|自动)$/i.test(raw)) {
    return { kind: 'auto', text: '已切回自动选择；接下来的消息会按当前可用模型自动选择。', modelId: null }
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
    const match = pattern.exec(raw)
    if (match) {
      query = parseQuery(String(match[1] || ''))
      break
    }
  }
  if (!query) return null

  const normalized = compact(query)
  if (normalized === 'auto' || normalized === '自动' || normalized === '默认') {
    return { kind: 'auto', text: '已切回自动选择；接下来的消息会按当前可用模型自动选择。', modelId: null }
  }

  const matches = matchChannelModels(models, query)
  if (matches.length === 0) {
    return {
      kind: 'not-found',
      text: `没有找到你有权限使用的模型「${query}」。发送 /model 查看当前可用模型。`,
    }
  }
  if (matches.length > 1) {
    const names = matches.slice(0, 8).map((model, index) => `${index + 1}. ${model.name}`).join('\n')
    return {
      kind: 'ambiguous',
      text: `找到多个匹配「${query}」的模型：\n${names}\n请发送更完整的模型名称。`,
    }
  }
  return {
    kind: 'switch',
    text: `已切换到「${matches[0].name}」。接下来的消息会使用它。`,
    modelId: matches[0].id,
  }
}
