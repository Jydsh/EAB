/**
 * 钉钉 AI 卡片流。
 *
 * 和 dsh-im 的钉钉会话保持一致：一条回复只创建一个卡片实例，
 * 先投递「正在思考…」，之后按增量节流把同一张卡片的 msgContent
 * 持续替换成最新进度，最后 isFinalize 收口成完整回答。
 *
 * 卡片模板使用 dsh-im 的共享模板，不需要给每个机器人单独建模板。
 * 该模板的 msgContent 是钉钉原生流式组件，客户端会在流式正文末尾自带
 * 转圈加载动效；这是私聊回复默认走这条链路的原因（A2UI 卡没有这个 widget）。
 * 任何一步失败都只返回 false，由调用方回退到普通文字消息或 A2UI 卡，保证机器人仍可用。
 */
import { randomUUID } from 'node:crypto'
import { getBackendRuntime } from './backends/runtime.js'

const DINGTALK_API = 'https://api.dingtalk.com'
const AI_CARD_TEMPLATE_ID = '02fcf2f4-5e02-4a85-b672-46d1f715543e.schema'
/**
 * 流式刷新策略：
 * - 两次请求之间至少隔 UPDATE_INTERVAL_MS，避免钉钉接口被高频调用；
 * - 新增正文不足 MIN_UPDATE_CHARS 时先攒着，最长等 MAX_UPDATE_WAIT_MS 再发；
 * - 这三个值都可用环境变量回退/调整，效果不好时不用改代码。
 */
const DEFAULT_UPDATE_INTERVAL_MS = 150
const DEFAULT_MIN_UPDATE_CHARS = 15
const DEFAULT_MAX_UPDATE_WAIT_MS = 300

function envNonNegativeInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

const UPDATE_INTERVAL_MS = envNonNegativeInt('EAB_DINGTALK_STREAM_INTERVAL_MS', DEFAULT_UPDATE_INTERVAL_MS)
const MIN_UPDATE_CHARS = envNonNegativeInt('EAB_DINGTALK_STREAM_MIN_CHARS', DEFAULT_MIN_UPDATE_CHARS)
const MAX_UPDATE_WAIT_MS = envNonNegativeInt('EAB_DINGTALK_STREAM_MAX_WAIT_MS', DEFAULT_MAX_UPDATE_WAIT_MS)
const A2UI_DELTA_UPDATES = process.env.EAB_DINGTALK_A2UI_DELTA !== '0'
const REQUEST_TIMEOUT_MS = 15_000
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000

const tokenCache = new Map<string, { token: string; expiresAt: number }>()
const tokenRequests = new Map<string, Promise<string>>()
const SHARED_TOKEN_KEY_PREFIX = 'dingtalk:access-token:'

class DingTalkHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'DingTalkHttpError'
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function nonEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function parseBody(text: string): Record<string, unknown> {
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

async function requestJson(
  url: string,
  options: { method?: string; token?: string; body?: unknown } = {},
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: options.method ?? 'POST',
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { 'x-acs-dingtalk-access-token': options.token } : {}),
    },
    body: JSON.stringify(options.body ?? {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await response.text().catch(() => '')
  const body = parseBody(text)
  if (!response.ok) {
    const detail = nonEmpty(body.message) || nonEmpty(body.code) || text.slice(0, 200)
    throw new DingTalkHttpError(`钉钉卡片接口 HTTP ${response.status}：${detail}`, response.status)
  }
  if (body.success === false) {
    const detail = nonEmpty(body.message) || nonEmpty(body.code) || 'success=false'
    throw new Error(`钉钉卡片接口拒绝了请求：${detail}`)
  }
  return body
}

export async function dingTalkAccessToken(appId: string, appSecret: string): Promise<string> {
  const cached = tokenCache.get(appId)
  if (cached && cached.expiresAt > Date.now()) return cached.token

  const shared = getBackendRuntime()?.cache
  if (shared) {
    try {
      const remote = await shared.get<{ token: string; expiresAt: number }>(`${SHARED_TOKEN_KEY_PREFIX}${appId}`)
      if (remote && remote.expiresAt > Date.now()) {
        tokenCache.set(appId, remote)
        return remote.token
      }
    } catch {
      // 缓存读失败不影响拿新 token
    }
  }

  const inFlight = tokenRequests.get(appId)
  if (inFlight) return inFlight

  const request = (async () => {
    const body = await requestJson(`${DINGTALK_API}/v1.0/oauth2/accessToken`, {
      body: { appKey: appId, appSecret },
    })
    const token = nonEmpty(body.accessToken)
    if (!token) throw new Error('钉钉没有返回 accessToken')
    const expireIn = Number(body.expireIn ?? body.expiresIn)
    const expiresInMs = Number.isFinite(expireIn) && expireIn > 0 ? expireIn * 1000 : 7_200_000
    const record = {
      token,
      expiresAt: Date.now() + Math.max(60_000, expiresInMs - TOKEN_REFRESH_MARGIN_MS),
    }
    tokenCache.set(appId, record)
    if (shared) {
      const ttl = Math.max(1, Math.floor((record.expiresAt - Date.now()) / 1000))
      try {
        await shared.set(`${SHARED_TOKEN_KEY_PREFIX}${appId}`, record, ttl)
      } catch {
        // 缓存写失败不影响本轮回复
      }
    }
    return token
  })()
  tokenRequests.set(appId, request)
  try {
    return await request
  } finally {
    tokenRequests.delete(appId)
  }
}

/** 钉钉卡片的正文区在手机上约为 330px；超过这个宽度的表格会被裁掉。 */
const MAX_MARKDOWN_TABLE_WIDTH = 330

function tableTextWidth(value: string): number {
  let units = 0
  // 粗略按“中文 2 个字符宽、英文/数字 1 个字符宽”估算，宁可提前转列表，也不要让手机端裁列。
  for (const char of value.replace(/<[^>]*>/g, '')) {
    units += /[\u3000-\u9fff\uff00-\uffef]/.test(char) ? 2 : 1
  }
  return units
}

function markdownTableWidth(header: string[], rows: string[][]): number {
  const columns = Math.max(header.length, ...rows.map((row) => row.length))
  let units = 0
  for (let column = 0; column < columns; column += 1) {
    const cells = [header[column] ?? '', ...rows.map((row) => row[column] ?? '')]
    units += Math.max(...cells.map(tableTextWidth))
  }
  return units * 8.5 + columns * 24
}

/** 只把“手机宽度放不下”的表格拆成竖排列表；短表格继续保留 Markdown 表格。 */
export function flattenMarkdownTables(value: string): string {
  const lines = String(value ?? '').replace(/\r\n?/g, '\n').split('\n')
  const output: string[] = []
  let inFence = false
  let index = 0

  const cellsOf = (line: string): string[] =>
    line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())

  const isSeparator = (cells: string[]): boolean =>
    cells.length >= 2 && cells.every((cell) => /^:?-{2,}:?$/.test(cell.replace(/\s+/g, '')))

  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      output.push(line)
      index += 1
      continue
    }
    if (inFence) {
      output.push(line)
      index += 1
      continue
    }

    const header = cellsOf(line)
    const separator = lines[index + 1] ? cellsOf(lines[index + 1] ?? '') : []
    if (header.length >= 2 && line.includes('|') && isSeparator(separator)) {
      const rows: string[][] = []
      let rowIndex = index + 2
      while (rowIndex < lines.length && (lines[rowIndex] ?? '').includes('|')) {
        const row = cellsOf(lines[rowIndex] ?? '')
        if (row.length < 2 || isSeparator(row)) break
        rows.push(row)
        rowIndex += 1
      }

      if (markdownTableWidth(header, rows) <= MAX_MARKDOWN_TABLE_WIDTH) {
        output.push(...lines.slice(index, rowIndex))
        index = rowIndex
        continue
      }

      output.push(`**${header[0] || '列表'}**`)
      for (const row of rows) {
        const tail = row
          .slice(1)
          .map((cell, cellIndex) => {
            const label = header[cellIndex + 1]
            return label ? `${label}：${cell}` : cell
          })
          .filter(Boolean)
        output.push(`- ${row[0] || ''}${tail.length > 0 ? ` · ${tail.join(' · ')}` : ''}`)
      }
      index = rowIndex
      continue
    }

    output.push(line)
    index += 1
  }

  return output.join('\n')
}

/** 每行之间补 <br>，让钉钉卡片按聊天文本的换行习惯渲染。 */
export function normalizeCardMarkdown(value: string): string {
  const text = flattenMarkdownTables(String(value ?? ''))
  const lines = text.split('\n')
  let inCodeBlock = false
  return lines
    .map((line, index) => {
      const fenced = /^\s{0,3}```/.test(line)
      const currentInCodeBlock = inCodeBlock
      if (fenced) inCodeBlock = !inCodeBlock
      if (index === lines.length - 1) return line
      if (currentInCodeBlock || fenced || inCodeBlock || !line || !lines[index + 1]) return `${line}\n`
      if (/^\s{0,3}(?:[-*+] |\d+[.)] |#{1,6} |\||> )/.test(lines[index + 1])) return `${line}\n`
      return `${line}<br>`
    })
    .join('')
}

function cardData(
  text: string,
  flowStatus: '2' | '3' | '5',
  conversationSummary?: string,
): Record<string, unknown> {
  const cardParamMap: Record<string, string> = {
    flowStatus,
    msgContent: normalizeCardMarkdown(text),
    staticMsgContent: '',
    sys_full_json_obj: JSON.stringify({ order: ['msgContent'] }),
    config: JSON.stringify({ autoLayout: true }),
  }
  // 旧模板的会话列表摘要只能在发送时通过这个特殊 key 写入；
  // 收口时再带上回答正文，外层摘要就会从用户问题切成机器人回复。
  if (conversationSummary) {
    const summary = dingTalkConversationSummary(conversationSummary)
    cardParamMap.sys_lastMessageI18n = JSON.stringify({ zh_CN: summary, en_US: summary })
  }
  return { cardParamMap }
}

export interface DingTalkToolRecord {
  id: string
  name: string
  toolId?: string
  args?: Record<string, unknown>
  status: 'running' | 'done' | 'error'
  summary?: string
  durationMs?: number
}

export interface DingTalkCardProgress {
  answer: string
  reasoning: string
  tool: string
  thinkingDone?: boolean
  /** 本次回复已经调用过的工具；旧模板卡用它保持“工具调用中”状态，避免工具结束后又跳回“思考中”。 */
  tools?: string[]
  toolDetails?: DingTalkToolRecord[]
}

function previewLine(text: string, maxLength = 120): string {
  const lines = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const first = lines[0] ?? ''
  if (!first) return ''
  // 首行已经是完整句子就不再并下一行；只有短碎片才并上下一句。
  const completeSentence = /[。！？!?]$/.test(first)
  const normalized = !completeSentence && first.length < 24 && lines[1] ? `${first} ${lines[1]}` : first
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized
}

function thinkingDuration(ms: number | undefined): string {
  const seconds = Math.max(0.1, (Number(ms) || 0) / 1000)
  return `${seconds.toFixed(1)}s`
}

function compactDuration(ms: number | undefined): string {
  if (!ms || ms < 0) return ''
  return ms < 1000 ? `${Math.max(1, Math.round(ms))}ms` : `${(ms / 1000).toFixed(1)}s`
}

function formatDuration(ms: number | undefined): string {
  const value = compactDuration(ms)
  return value ? ` · ${value}` : ''
}

function richThinkingTitle(thinkingDone: boolean, thinkingMs?: number): string {
  // 与网页端保持一致：思考入口带 ✦，工具入口带圆点；图标必须进入数据字符串，
  // 否则真机上又变成没有前缀的纯文字。
  if (!thinkingDone) return '✦ 思考中'
  return thinkingMs && thinkingMs > 0 ? `✦ 已思考 ${thinkingDuration(thinkingMs)}` : '✦ 思考'
}

function richToolTitle(toolRunning: boolean): string {
  return toolRunning ? '• 工具调用中' : '• 工具'
}

/**
 * 收起态只允许一行：图标、标题和首句摘要进入同一个 Text 的数据。
 * 右侧箭头由独立的 Text 组件承载，避免 maxLine=1 省略预览时把箭头一起吃掉。
 */
function richPanelHeader(title: string, preview: string): string {
  return `${title}${preview ? ` · ${preview}` : ''}`
}

function compactValue(value: unknown, maxLength = 360): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (!text) return ''
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
}

function richToolsMarkdown(details: DingTalkToolRecord[], tools: string[]): string {
  if (!details.length) {
    return tools.map((tool, index) => `${index + 1}. 🔧 **${tool}**`).join('\n')
  }
  return details
    .map((tool, index) => {
      // 只有执行中的工具才展开参数和中间结果；结束后只保留工具名和耗时，
      // 避免折叠区里堆满参数，把真正的回答正文挤下去。
      if (tool.status === 'running') {
        const args = tool.args && Object.keys(tool.args).length ? `\n   参数：${compactValue(tool.args)}` : ''
        const summary = tool.summary ? `\n   结果：${compactValue(tool.summary)}` : ''
        return `${index + 1}. **${tool.name}** · 执行中${args}${summary}`
      }
      const failed = tool.status === 'error' ? ' · 失败' : ''
      return `${index + 1}. **${tool.name}**${failed}${formatDuration(tool.durationMs)}`
    })
    .join('\n\n')
}

function richToolsPreview(
  details: DingTalkToolRecord[],
  tools: string[],
  active: boolean,
): string {
  const running = details.find((tool) => tool.status === 'running')
  if (running) return `${running.name} · 执行中`
  if (!details.length) {
    if (!tools.length) return ''
    return active ? `${tools.at(-1)} · 执行中` : `${tools.length} 个`
  }
  const failed = details.filter((tool) => tool.status === 'error').length
  if (details.length === 1) {
    const only = details[0]
    return `${only.name}${only.status === 'error' ? ' · 失败' : ''}${formatDuration(only.durationMs)}`
  }
  const totalMs = details.reduce((sum, tool) => sum + (Number(tool.durationMs) || 0), 0)
  return `${details.length} 个${failed > 0 ? ` · ${failed} 个失败` : ''}${totalMs > 0 ? ` · ${compactDuration(totalMs)}` : ''}`
}

function richHasTools(state: DingTalkRichCardState): boolean {
  return (state.tools ?? []).length > 0 || (state.toolDetails ?? []).length > 0
}

/** 只有真的有工具在跑时才显示“工具调用中”并保留流光；工具结束后切回“工具”。 */
function richToolRunning(state: DingTalkRichCardState): boolean {
  return (state.toolDetails ?? []).some((tool) => tool.status === 'running')
}

/**
 * “思考结束”只由正文开始或收口决定，不能因为出现工具就提前切成“已思考”。
 * 工具执行期间仍要显示“思考中”标题和下方一行推理摘要。
 */
function richThinkingDone(state: DingTalkRichCardState): boolean {
  return Boolean(state.thinkingDone)
}

/**
 * 会话列表外层摘要取机器人回复正文：建卡时先放中性品牌文案，
 * 收口时再把摘要替换成正文（旧模板走 sys_lastMessageI18n，A2UI 走场域信息更新）。
 * 只放正文，不带品牌前缀，和 Hermes 等插件在会话列表里的观感一致。
 */
export function dingTalkConversationSummary(text: string): string {
  const oneLine = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!oneLine) return 'EAB 企业智能助手'
  const limit = 60
  return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine
}

export function renderDingTalkProgressCard(progress: DingTalkCardProgress): string {
  // 旧模板卡只能显示一段 msgContent，不能做真正的折叠。
  // 思考标题只在正文开始/收口后切“已深度思考”；工具执行期间仍保持“正在思考中”。
  const blocks: string[] = []
  const usedTools = progress.tools ?? []
  const detailNames = (progress.toolDetails ?? []).map((tool) => tool.name).filter(Boolean)
  const toolNames = usedTools.length > 0 ? usedTools : detailNames
  const thinkingDone = Boolean(progress.thinkingDone)
  blocks.push(thinkingDone ? '**✦ 已深度思考**' : '**✦ 正在思考中…**')
  if (!thinkingDone) {
    const preview = previewLine(progress.reasoning || '正在分析你的问题…', 90)
    if (preview) blocks.push(`> ${preview}`)
  }
  if (progress.tool) blocks.push(`**🛠️ 工具调用中…**\n_${progress.tool}_`)
  else if (toolNames.length > 0) blocks.push(`**🛠️ 工具调用中…**\n_${toolNames[toolNames.length - 1]}_`)
  if (progress.toolDetails?.length) blocks.push(richToolsMarkdown(progress.toolDetails, toolNames))
  if (progress.answer.trim()) blocks.push(progress.answer.trim())
  return blocks.join('\n\n')
}

export function renderDingTalkFinalCard(answer: string, _reasoning: string, _tools: string[]): string {
  // 旧模板卡不支持折叠面板：完成时用正文覆盖掉思考/工具，避免用户看到一大段过程。
  // 需要保留可展开过程时走 A2UI 卡片（见 DingTalkAICardStream）。
  return answer.trim() || '（本轮没有返回文字回答）'
}

/**
 * 一张卡片的生命周期：start → update* → finish。
 * update 是 latest-wins：模型连续吐 token 时只保留最后一帧，避免把钉钉接口打爆。
 */
export class DingTalkCardStream {
  private phase: 'idle' | 'active' | 'finishing' | 'finished' | 'failed' = 'idle'
  private cardInstanceId = ''
  private pendingText: string | null = null
  private pendingSince = 0
  private lastSentLength = 0
  private scheduled: NodeJS.Timeout | null = null
  private worker: Promise<void> | null = null
  private finishPromise: Promise<boolean> | null = null
  private closing = false
  private lastUpdateAt = 0

  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly userId: string,
    private readonly robotCode: string,
    private readonly logger: Pick<Console, 'warn'> = console,
  ) {}

  get providerMessageIds(): string[] {
    return this.cardInstanceId ? [this.cardInstanceId] : []
  }

  private async token(): Promise<string> {
    return dingTalkAccessToken(this.appId, this.appSecret)
  }

  /** 卡片接口偶发 403 是 token 传播延迟，和 dsh-im 一样退避 1 秒重试一次。 */
  private async cardRequest(
    path: string,
    options: { method?: string; token: string; body: unknown },
  ): Promise<Record<string, unknown>> {
    try {
      return await requestJson(`${DINGTALK_API}${path}`, options)
    } catch (error) {
      if (!(error instanceof DingTalkHttpError) || error.status !== 403) throw error
      await sleep(1_000)
      return requestJson(`${DINGTALK_API}${path}`, options)
    }
  }

  private async putStreaming(text: string, finalize: boolean, isError = false): Promise<void> {
    const token = await this.token()
    await this.cardRequest('/v1.0/card/streaming', {
      method: 'PUT',
      token,
      body: {
        outTrackId: this.cardInstanceId,
        guid: randomUUID(),
        key: 'msgContent',
        content: normalizeCardMarkdown(text).replace(/\n+$/, ''),
        isFull: true,
        isFinalize: finalize,
        isError,
      },
    })
  }

  private async putInstance(
    text: string,
    flowStatus: '2' | '3' | '5',
    conversationSummary?: string,
  ): Promise<void> {
    const token = await this.token()
    await this.cardRequest('/v1.0/card/instances', {
      method: 'PUT',
      token,
      body: {
        outTrackId: this.cardInstanceId,
        cardData: cardData(text, flowStatus, conversationSummary),
        cardUpdateOptions: { updateCardDataByKey: true },
      },
    })
  }

  /** 先建卡并投递，再启动同一条卡片的流式内容。返回 false 表示必须回退文字消息。 */
  async start(initialText: string, conversationSummary?: string): Promise<boolean> {
    if (this.phase !== 'idle') return false
    this.phase = 'idle' // 保持 idle 直到真正创建成功，避免半成品进入 active
    try {
      const token = await this.token()
      const cardInstanceId = `eab_${randomUUID()}`
      const robotCode = this.robotCode || this.appId
      const target = { userId: this.userId, robotCode }
      const summary = conversationSummary || 'EAB 企业智能助手'
      const created = await this.cardRequest('/v1.0/card/instances/createAndDeliver', {
        token,
        body: {
          outTrackId: cardInstanceId,
          userIdType: 1,
          openSpaceId: `dtv1.card//IM_ROBOT.${target.userId}`,
          imRobotOpenDeliverModel: {
            spaceType: 'IM_ROBOT',
            robotCode,
            extension: { dynamicSummary: 'true' },
          },
          cardTemplateId: AI_CARD_TEMPLATE_ID,
          cardData: cardData(initialText, '2'),
          callbackType: 'STREAM',
          // 旧模板无法在 update 里改 summary；会话列表用这个国际化摘要兜底，
          // 避免 create 时写死的「正在思考」一直留在外层。
          imRobotOpenSpaceModel: {
            supportForward: true,
            lastMessageI18n: { ZH_CN: summary, EN_US: summary },
          },
        },
      })

      const delivery = (created.result as { deliverResults?: Array<{ success?: boolean; errorMsg?: string }> } | undefined)
        ?.deliverResults?.[0]
      if (delivery && delivery.success === false) {
        throw new Error(delivery.errorMsg || '钉钉卡片没有投递成功')
      }

      this.cardInstanceId = cardInstanceId
      this.phase = 'active'
      this.lastUpdateAt = Date.now()
      this.lastSentLength = initialText.length
      try {
        await this.putStreaming(initialText, false)
      } catch (error) {
        // 卡片已经可见，createAndDeliver 里带了同一段思考文案；这里失败不影响后续 finish 原地替换。
        this.logger.warn?.('[eab] 钉钉卡片启动流失败：', (error as Error).message)
      }
      return true
    } catch (error) {
      this.phase = 'failed'
      this.logger.warn?.('[eab] 钉钉 AI 卡片创建失败，回退文字消息：', (error as Error).message)
      return false
    }
  }

  /**
   * 服务重启后复用已经投递到聊天里的旧模板卡。
   * 只在 idle 状态可用；失败时置 failed，由调用方决定是否回退新卡/文字消息。
   */
  async resume(outTrackId: string, initialText: string): Promise<boolean> {
    if (this.phase !== 'idle') return false
    const id = String(outTrackId ?? '').trim()
    if (!id) return false
    this.cardInstanceId = id
    this.phase = 'active'
    this.lastUpdateAt = Date.now()
    this.lastSentLength = initialText.length
    try {
      await this.putStreaming(initialText, false)
      return true
    } catch (error) {
      this.phase = 'failed'
      this.logger.warn?.('[eab] 钉钉旧卡片续用失败：', (error as Error).message)
      return false
    }
  }

  /** 旧模板卡续用失败时尽力把它收口，避免旧消息一直停在「处理中」。 */
  async closeAfterResumeFailure(outTrackId: string, text: string): Promise<boolean> {
    const id = String(outTrackId ?? '').trim()
    if (!id || this.phase === 'finished') return false
    this.cardInstanceId = id
    this.phase = 'failed'
    try {
      return await this.fail(text)
    } catch (error) {
      this.logger.warn('[eab] 钉钉旧卡片收口失败：', (error as Error).message)
      return false
    }
  }

  private schedule(): void {
    if (this.phase !== 'active' || this.worker || this.pendingText === null) return
    if (this.scheduled) {
      clearTimeout(this.scheduled)
      this.scheduled = null
    }
    const now = Date.now()
    const elapsed = now - this.lastUpdateAt
    const newChars = this.pendingText.length - this.lastSentLength
    const enoughChars = newChars >= MIN_UPDATE_CHARS
    const waitedEnough = this.pendingSince > 0 && now - this.pendingSince >= MAX_UPDATE_WAIT_MS
    if (!enoughChars && !waitedEnough) {
      const wait = Math.max(0, this.pendingSince + MAX_UPDATE_WAIT_MS - now)
      this.scheduled = setTimeout(() => {
        this.scheduled = null
        this.drain()
      }, wait)
      return
    }
    const delay = Math.max(0, UPDATE_INTERVAL_MS - elapsed)
    if (delay > 0) {
      this.scheduled = setTimeout(() => {
        this.scheduled = null
        this.drain()
      }, delay)
      return
    }
    this.drain()
  }

  private drain(): void {
    if (this.phase !== 'active' || this.worker || this.pendingText === null) return
    const text = this.pendingText
    this.pendingText = null
    this.pendingSince = 0
    this.worker = this.putStreaming(text, false)
      .then(() => {
        this.lastSentLength = text.length
        this.lastUpdateAt = Date.now()
      })
      .catch((error) => {
        if (this.phase !== 'active') return
        this.phase = 'failed'
        this.logger.warn?.('[eab] 钉钉卡片流更新失败：', (error as Error).message)
      })
      .finally(() => {
        this.worker = null
        if (this.phase === 'active' && this.pendingText !== null) this.schedule()
      })
  }

  /** 模型连续吐字时只保留最新一帧；phase 不对直接丢弃。 */
  update(text: string): void {
    if (this.phase !== 'active') return
    if (this.pendingText === text) return
    if (this.pendingText === null) this.pendingSince = Date.now()
    this.pendingText = text
    this.schedule()
  }

  async finish(finalText: string, conversationSummary?: string): Promise<boolean> {
    if (this.phase === 'finished') return true
    if (this.phase === 'finishing') return this.finishPromise ?? false
    if (this.phase !== 'active') return false

    this.phase = 'finishing'
    this.pendingText = null
    if (this.scheduled) {
      clearTimeout(this.scheduled)
      this.scheduled = null
    }
    const active = this.worker
    this.finishPromise = (async () => {
      if (active) await active
      if (this.phase !== 'finishing') return false
      try {
        await this.putStreaming(finalText, true)
        if (this.phase !== 'finishing') return false
        await this.putInstance(finalText, '3')
        // 会话列表摘要单独 best-effort：即使钉钉不接受 sys_lastMessageI18n，
        // 也不能让已经收口的卡片回退成文字消息。
        try {
          await this.putInstance(finalText, '3', conversationSummary ?? finalText)
        } catch (error) {
          this.logger.warn?.('[eab] 钉钉卡片更新外层摘要失败：', (error as Error).message)
        }
        this.phase = 'finished'
        return true
      } catch (error) {
        this.phase = 'failed'
        this.logger.warn?.('[eab] 钉钉卡片收口失败：', (error as Error).message)
        return false
      }
    })()
    return this.finishPromise
  }

  /** 异常退出时把卡片收成失败态，避免用户看到一张永远「思考中」的卡片。 */
  async fail(text: string): Promise<boolean> {
    if (this.phase === 'finished' || !this.cardInstanceId || this.closing) return false
    this.phase = 'failed'
    this.closing = true
    this.pendingText = null
    if (this.scheduled) {
      clearTimeout(this.scheduled)
      this.scheduled = null
    }
    if (this.worker) await this.worker.catch(() => undefined)
    const results = await Promise.allSettled([
      this.putStreaming(text, false, true),
      this.putInstance(text, '5'),
    ])
    this.closing = false
    return results.some((result) => result.status === 'fulfilled')
  }
}

const A2UI_CATALOG_ID = 'https://dingtalk.com/card/a2ui/catalogs/public/catalog.json'
const A2UI_SURFACE_PREFIX = 'eab_a2ui_surface_'
const A2UI_PERMISSION_COOLDOWN_MS = 5 * 60_000

// 应用没开通 AICard.Instance.Write 时，每次私聊都先撞一次 403 再等 1 秒重试，
// 用户会明显感觉机器人启动慢。这里做短时熔断，冷却期内直接走旧模板卡。
let a2uiDisabledUntil = 0

const A2UI_STATUS = {
  processing: 'PROCESSING',
  // 官方 JSON 卡文档的终态枚举名是 FINISH（不是 FINISHED）。
  finished: 'FINISH',
  failed: 'FAILED',
} as const

// 钉钉一次 A2UI update 最多接受 100 条 a2uiMessages，超过统一报 param.invalid。
const A2UI_MAX_MESSAGES = 95

/**
 * 澄清按钮的卡片归属。按钮事件里的 context 可能因客户端实现差异丢失，
 * 回调时用 outTrackId 反查会话和选项作为兜底；只保留最近少量卡片。
 */
const clarifyCardStates = new Map<string, DingTalkClarifyState>()

/** 卡片状态持久化接口；测试/未配置时只用进程内 Map。 */
export interface DingTalkClarifyCardStore {
  load(outTrackId: string): DingTalkClarifyState | null
  save(outTrackId: string, state: DingTalkClarifyState): void
}

let clarifyCardStore: DingTalkClarifyCardStore | null = null

export function configureDingTalkClarifyCardStore(store: DingTalkClarifyCardStore | null): void {
  clarifyCardStore = store
}

function normalizeClarifyKind(kind: unknown): DingTalkClarifyKind {
  return kind === 'multiple' || kind === 'text' ? kind : 'single'
}

function cloneClarifyState(clarify: DingTalkClarifyState): DingTalkClarifyState {
  const questions = (clarify.questions ?? []).map((question) => ({
    id: String(question.id ?? ''),
    question: String(question.question ?? ''),
    options: (question.options ?? []).slice(0, 4).map((option) => ({
      id: String(option.id ?? ''),
      label: String(option.label ?? ''),
      description: String(option.description ?? ''),
    })),
    kind: normalizeClarifyKind(question.kind),
    placeholder: String(question.placeholder ?? ''),
    allowCustom: question.allowCustom === undefined ? true : Boolean(question.allowCustom),
  }))
  const answers: Record<string, DingTalkClarifyAnswer> = {}
  for (const [key, answer] of Object.entries(clarify.answers ?? {})) {
    const blanks = (answer?.blanks ?? []).map((value) => String(value))
    answers[key] = {
      selected: (answer?.selected ?? []).map((value) => String(value)),
      text: String(answer?.text ?? ''),
      ...(blanks.length > 0 ? { blanks } : {}),
    }
  }
  return {
    sessionId: String(clarify.sessionId ?? ''),
    question: String(clarify.question ?? ''),
    options: (clarify.options ?? []).slice(0, 4).map((option) => ({
      id: String(option.id ?? ''),
      label: String(option.label ?? ''),
      description: String(option.description ?? ''),
    })),
    kind: normalizeClarifyKind(clarify.kind),
    placeholder: String(clarify.placeholder ?? ''),
    allowCustom: Boolean(clarify.allowCustom),
    flowId: String(clarify.flowId ?? ''),
    step: Number(clarify.step ?? 1) || 1,
    messageId: String(clarify.messageId ?? ''),
    ...(questions.length > 0 ? { questions } : {}),
    ...(Object.keys(answers).length > 0 ? { answers } : {}),
    index: Math.max(0, Math.trunc(Number(clarify.index ?? 0) || 0)),
  }
}

function rememberClarifyCard(outTrackId: string, clarify: DingTalkClarifyState | null | undefined): void {
  if (!outTrackId || !clarify) return
  const state = cloneClarifyState(clarify)
  clarifyCardStates.set(outTrackId, state)
  try {
    clarifyCardStore?.save(outTrackId, state)
  } catch (error) {
    console.warn('[eab] 钉钉澄清卡状态持久化失败：', error)
  }
  while (clarifyCardStates.size > 200) {
    const oldest = clarifyCardStates.keys().next().value
    if (!oldest) break
    clarifyCardStates.delete(oldest)
  }
}

function readClarifyCardState(outTrackId: string): DingTalkClarifyState | null {
  const cached = clarifyCardStates.get(outTrackId)
  if (cached) return cloneClarifyState(cached)
  if (!clarifyCardStore) return null
  try {
    const loaded = clarifyCardStore.load(outTrackId)
    if (!loaded) return null
    const state = cloneClarifyState(loaded)
    clarifyCardStates.set(outTrackId, state)
    return cloneClarifyState(state)
  } catch (error) {
    console.warn('[eab] 钉钉澄清卡状态读取失败：', error)
    return null
  }
}

export function dingTalkClarifyCardState(outTrackId: string): DingTalkClarifyState | null {
  return readClarifyCardState(outTrackId)
}

/** 题组回调：把某道题的草稿写回登记表，供同一张卡翻页/统一提交时读取。 */
export function updateDingTalkClarifyDraft(
  outTrackId: string,
  index: number,
  answer: DingTalkClarifyAnswer,
): DingTalkClarifyState | null {
  const state = readClarifyCardState(outTrackId)
  if (!state) return null
  const questions = state.questions ?? []
  if (index < 0 || index >= questions.length) return null
  const next = cloneClarifyState(state)
  const blanks = answer.blanks?.map((value) => String(value)) ?? []
  next.answers = { ...(next.answers ?? {}), [String(index + 1)]: {
    selected: answer.selected.map((value) => String(value)),
    text: String(answer.text ?? ''),
    ...(blanks.length > 0 ? { blanks } : {}),
  } }
  next.index = index
  clarifyCardStates.set(outTrackId, next)
  try {
    clarifyCardStore?.save(outTrackId, next)
  } catch (error) {
    console.warn('[eab] 钉钉澄清卡草稿持久化失败：', error)
  }
  return cloneClarifyState(next)
}

/** 题组翻页后更新当前页序号；不改变草稿。 */
export function updateDingTalkClarifyIndex(outTrackId: string, index: number): DingTalkClarifyState | null {
  const state = readClarifyCardState(outTrackId)
  if (!state) return null
  const questions = state.questions ?? []
  if (index < 0 || index >= questions.length) return null
  const next = cloneClarifyState(state)
  next.index = index
  clarifyCardStates.set(outTrackId, next)
  try {
    clarifyCardStore?.save(outTrackId, next)
  } catch (error) {
    console.warn('[eab] 钉钉澄清卡翻页持久化失败：', error)
  }
  return cloneClarifyState(next)
}


export interface DingTalkCardAttachment {
  fileName: string
  url: string
  previewUrl?: string
  size?: number
  mimeType?: string
  description?: string
}

export interface DingTalkClarifyOption {
  id: string
  label: string
  description?: string
}

export type DingTalkClarifyKind = 'single' | 'multiple' | 'text'

/** 题组里的一道题；卡片一次只展示当前页。 */
export interface DingTalkClarifyQuestion {
  id?: string
  question: string
  options: DingTalkClarifyOption[]
  kind?: DingTalkClarifyKind
  placeholder?: string
  allowCustom?: boolean
}

/** 用户在某道题上已填的草稿；多题统一提交前只存在服务端。 */
export interface DingTalkClarifyAnswer {
  selected: string[]
  text: string
  /** 填空题按横线拆开后的逐空答案；老调用方没有这个字段时回退 text。 */
  blanks?: string[]
}

/** 卡片底部的可点击澄清选项；sessionId 只用于回调校验，不展示在界面上。 */
export interface DingTalkClarifyState {
  sessionId: string
  question: string
  options: DingTalkClarifyOption[]
  /** 单选/多选/填空；旧卡片没有这个字段时按单选处理。 */
  kind?: DingTalkClarifyKind
  /** 填空题输入框提示；多选时作为补充说明。 */
  placeholder?: string
  allowCustom?: boolean
  /** 同一个 AI 消息/卡片的续跑标识；网页据此隐藏“我选择了…”的中间用户消息。 */
  flowId?: string
  /** 当前澄清页序号，从 1 开始；按钮回调按页做幂等，避免同一张卡只能点一次。 */
  step?: number
  /** 触发这次澄清的 assistant 消息 ID；回调续跑时直接更新这条消息，而不是新插一条。 */
  messageId?: string
  /** 多题模式：一次 ask_user 下发的整组题；单题模式为空。 */
  questions?: DingTalkClarifyQuestion[]
  /** 多题模式下每道题的草稿，key 是题序号（从 1 开始）。 */
  answers?: Record<string, DingTalkClarifyAnswer>
  /** 多题模式当前页，0-based；单题模式为 0。 */
  index?: number
}

export interface DingTalkRichCardState {
  answer: string
  reasoning: string
  tools: string[]
  /** 卡片所属 EAB 会话；仅用于 A2UI 点击回调切换思考/工具面板，不参与渲染。 */
  sessionId?: string
  thinkingDone?: boolean
  /** 思考阶段的实际耗时；历史卡没有持久化时只显示“思考”。 */
  thinkingMs?: number
  toolDetails?: DingTalkToolRecord[]
  /** 钉盘落盘后由 File 组件展示；最多三个，避免卡片过重。 */
  attachments?: DingTalkCardAttachment[]
  /** 收口时若有澄清请求，卡片底部渲染 2–4 个可点击方向。 */
  clarify?: DingTalkClarifyState | null
}

function cloneRichState(state: DingTalkRichCardState): DingTalkRichCardState {
  return {
    answer: String(state.answer ?? ''),
    reasoning: String(state.reasoning ?? ''),
    tools: (state.tools ?? []).filter((tool) => typeof tool === 'string' && tool.trim()).map((tool) => tool.trim()),
    sessionId: String(state.sessionId ?? ''),
    thinkingDone: Boolean(state.thinkingDone),
    thinkingMs: Math.max(0, Math.trunc(Number(state.thinkingMs) || 0)),
    toolDetails: (state.toolDetails ?? []).map((tool) => ({
      ...tool,
      args: tool.args ? { ...tool.args } : undefined,
      summary: tool.summary ?? '',
      durationMs: tool.durationMs ?? 0,
    })),
    attachments: (state.attachments ?? []).slice(0, 3).map((attachment) => ({ ...attachment })),
    clarify: state.clarify ? cloneClarifyState(state.clarify) : null,
  }
}

function richTextLength(state: DingTalkRichCardState): number {
  return (
    String(state.answer ?? '').length +
    String(state.reasoning ?? '').length +
    (state.clarify ? String(state.clarify.question ?? '').length : 0)
  )
}

function richStateChanged(current: DingTalkRichCardState, previous: DingTalkRichCardState): boolean {
  return (
    current.answer !== previous.answer ||
    current.reasoning !== previous.reasoning ||
    Boolean(current.thinkingDone) !== Boolean(previous.thinkingDone) ||
    Math.max(0, Math.trunc(Number(current.thinkingMs) || 0)) !==
      Math.max(0, Math.trunc(Number(previous.thinkingMs) || 0)) ||
    (current.tools ?? []).length !== (previous.tools ?? []).length ||
    JSON.stringify(current.toolDetails ?? []) !== JSON.stringify(previous.toolDetails ?? []) ||
    JSON.stringify(current.attachments ?? []) !== JSON.stringify(previous.attachments ?? []) ||
    JSON.stringify(current.clarify ?? null) !== JSON.stringify(previous.clarify ?? null)
  )
}

function richStructureChanged(current: DingTalkRichCardState, previous: DingTalkRichCardState): boolean {
  return (
    Boolean(current.thinkingDone) !== Boolean(previous.thinkingDone) ||
    Math.max(0, Math.trunc(Number(current.thinkingMs) || 0)) !==
      Math.max(0, Math.trunc(Number(previous.thinkingMs) || 0)) ||
    (current.tools ?? []).length !== (previous.tools ?? []).length ||
    JSON.stringify(current.toolDetails ?? []) !== JSON.stringify(previous.toolDetails ?? []) ||
    Boolean(current.clarify) !== Boolean(previous.clarify)
  )
}

interface DingTalkRichCardData {
  answer: {
    blocks: Array<{
      text: string
      table: {
        meta: Array<{ colKey: string; colName: string; type: 'text' }>
        data: Array<Record<string, string>>
      }
    }>
  }
  thinking: { text: string; preview: string; header: string }
  tools: { text: string; preview: string; header: string }
  attachments: Array<{
    fileName: string
    url: string
    previewUrl: string
    size: number
    mimeType: string
    description: string
  }>
  clarify: {
    sessionId: string
    badge: string
    hint: string
    kind: DingTalkClarifyKind
    question: string
    displayQuestion: string
    blanks: string[]
    placeholder: string
    progress: string
    selected: string[]
    text: string
    total: number
    index: number
    canPrev: boolean
    canNext: boolean
    isLast: boolean
    options: Array<{
      id: string
      label: string
      description: string
    }>
    pickerOptions: Array<{
      label: string
      value: string
    }>
  }
  thinkingDone: boolean
  ui: {
    showThinking: boolean
    showThinkingPreview: boolean
    showThinkingHeader: boolean
    thinkingExpanded: boolean
    showTools: boolean
    showToolsPreview: boolean
    showToolsHeader: boolean
    toolsExpanded: boolean
    showAttachments: boolean
    showAttachment0: boolean
    showAttachment1: boolean
    showAttachment2: boolean
    showClarify: boolean
    showClarifyProgress: boolean
    showClarifySingle: boolean
    showClarifyMultiple: boolean
    showClarifyText: boolean
    showClarifyBlanks: boolean
    showClarifySubmit: boolean
    showClarifyNav: boolean
    showClarifyPrev: boolean
    showClarifyNext: boolean
    showClarifyCustom: boolean
    showClarifyOption0: boolean
    showClarifyOption1: boolean
    showClarifyOption2: boolean
    showClarifyOption3: boolean
    showClarifyDesc0: boolean
    showClarifyDesc1: boolean
    showClarifyDesc2: boolean
    showClarifyDesc3: boolean
    [key: `showAnswerUnit${number}`]: boolean
    [key: `showAnswerText${number}`]: boolean
    [key: `showAnswerTable${number}`]: boolean
  }
}

interface DingTalkAnswerTable {
  meta: Array<{ colKey: string; colName: string; type: 'text' }>
  data: Array<Record<string, string>>
}

interface DingTalkAnswerBlock {
  text: string
  table: DingTalkAnswerTable
}

/**
 * A2UI 组件树里预留的正文块数。真实业务回答经常有“总览 + 多部门明细 + 收尾”
 * 多张表，6 块会把后面的表降级成纯文本；这里留足 24 块，覆盖 9 张表左右的回答。
 */
const MAX_ANSWER_BLOCKS = 24

function plainTableCell(value: string): string {
  return String(value ?? '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/<br\s*\/?>/gi, ' ')
    .trim()
}

function emptyAnswerTable(): DingTalkAnswerTable {
  return { meta: [], data: [] }
}

function emptyAnswerBlocks(): DingTalkAnswerBlock[] {
  return Array.from({ length: MAX_ANSWER_BLOCKS }, () => ({ text: '', table: emptyAnswerTable() }))
}

/**
 * 手机卡片正文区约 320px，5 列一定放不下。文件清单这类表把
 * “文件名 + 路径”合成一列、丢掉纯序号列，压到 3 列才能完整显示。
 */
function compactAnswerTable(table: DingTalkAnswerTable): DingTalkAnswerTable {
  const normal = (value: string): string => value.replace(/\s+/g, '').toLowerCase()
  const labels = table.meta.map((column) => column.colName)
  const indexColumn = labels.findIndex((label) => /^(#|序号|no\.?)$/i.test(label.trim()))
  const nameColumn = labels.findIndex((label) => /文件名|文件名称|名称|filename|name/i.test(label))
  const pathColumn = labels.findIndex((label) => /路径|目录|path/i.test(label))
  // 只有“文件清单”才需要合并名称/路径并压到 3 列；普通业务表必须保留全部列，
  // 交给 Table 的横向滚动显示，否则桌面端会像手机一样只剩前 3 列。
  const isFileTable =
    labels.some((label) => /文件名|文件名称|filename/i.test(label)) ||
    (nameColumn >= 0 && pathColumn >= 0)
  if (!isFileTable || table.meta.length <= 3) {
    return table
  }

  const mergedFile = nameColumn >= 0
  const outputLabels: string[] = []
  const outputKeys: Array<number | 'file'> = []
  if (mergedFile) {
    outputLabels.push('文件')
    outputKeys.push('file')
  }
  labels.forEach((label, index) => {
    if (index === indexColumn || index === nameColumn || index === pathColumn) return
    // 文件清单里 3 列是上限：优先保留大小、更新时间，其余列不再挤进来。
    if (mergedFile && outputLabels.length >= 3) return
    if (!mergedFile && outputLabels.length >= 3) return
    outputLabels.push(label)
    outputKeys.push(index)
  })

  if (outputLabels.length === 0) return table
  const meta = outputLabels.map((colName, index) => ({
    colKey: `c${index}`,
    colName,
    type: 'text' as const,
  }))
  const data = table.data.map((row) => {
    const next: Record<string, string> = {}
    outputKeys.forEach((key, index) => {
      if (key === 'file') {
        const name = normal(String(row[`c${nameColumn}`] ?? '')) ? String(row[`c${nameColumn}`] ?? '') : ''
        const path = pathColumn >= 0 ? String(row[`c${pathColumn}`] ?? '') : ''
        next[`c${index}`] = path && path !== name ? `${name}（${path}）` : name || path
      } else {
        next[`c${index}`] = String(row[`c${key}`] ?? '')
      }
    })
    return next
  })
  return { meta, data }
}

/**
 * 把回答拆成“普通 Markdown 段 + 原生 A2UI Table 段”。
 * 钉钉 A2UI 的 Markdown 组件没有横向滚动，宽表格会被裁；原生 Table 才有 scrollAreaWidth，
 * 所以这里保留真表格，交给 Table 组件内部横滚，而不是把表格改写成竖排列表。
 */
function parseAnswerBlocks(value: string): DingTalkAnswerBlock[] {
  const lines = String(value ?? '').replace(/\r\n?/g, '\n').split('\n')
  const blocks: Array<{ kind: 'text' | 'table'; text: string; table: DingTalkAnswerTable }> = []
  let textLines: string[] = []
  let inFence = false
  let index = 0

  const cellsOf = (line: string): string[] =>
    line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())

  const isSeparator = (cells: string[]): boolean =>
    cells.length >= 2 && cells.every((cell) => /^:?-{2,}:?$/.test(cell.replace(/\s+/g, '')))

  const flushText = (): void => {
    const text = textLines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
    textLines = []
    if (text) blocks.push({ kind: 'text', text, table: emptyAnswerTable() })
  }

  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      textLines.push(line)
      index += 1
      continue
    }
    if (inFence) {
      textLines.push(line)
      index += 1
      continue
    }

    const header = cellsOf(line)
    const separator = lines[index + 1] ? cellsOf(lines[index + 1] ?? '') : []
    if (header.length >= 2 && line.includes('|') && isSeparator(separator)) {
      const rows: string[][] = []
      let rowIndex = index + 2
      while (rowIndex < lines.length && (lines[rowIndex] ?? '').includes('|')) {
        const row = cellsOf(lines[rowIndex] ?? '')
        if (row.length < 2 || isSeparator(row)) break
        rows.push(row)
        rowIndex += 1
      }

      flushText()
      const columns = Math.max(header.length, ...rows.map((row) => row.length))
      const labels = Array.from({ length: columns }, (_, column) =>
        plainTableCell(header[column] ?? '') || `列${column + 1}`,
      )
      const meta = labels.map((colName, column) => ({
        colKey: `c${column}`,
        colName,
        type: 'text' as const,
      }))
      const data = rows.map((row) =>
        Object.fromEntries(
          labels.map((_, column) => [`c${column}`, plainTableCell(row[column] ?? '')]),
        ),
      )
      const table = compactAnswerTable({ meta, data })
      blocks.push({ kind: 'table', text: '', table })
      index = rowIndex
      continue
    }

    textLines.push(line)
    index += 1
  }
  flushText()

  // 超出预留块数的部分不能再丢：把后续表格/文字并回最后一块文本，至少保持可读。
  if (blocks.length > MAX_ANSWER_BLOCKS) {
    const extra = blocks.slice(MAX_ANSWER_BLOCKS)
    const tail = extra
      .map((block) => {
        if (block.kind === 'text') return block.text
        return block.table.data
          .map((row) => Object.values(row).join(' · '))
          .join('\n')
      })
      .filter(Boolean)
      .join('\n\n')
    const last = blocks[MAX_ANSWER_BLOCKS - 1]
    if (last) {
      last.text = [last.text, tail].filter(Boolean).join('\n\n')
      last.table = emptyAnswerTable()
    }
    blocks.length = MAX_ANSWER_BLOCKS
  }

  const padded = emptyAnswerBlocks()
  blocks.forEach((block, blockIndex) => {
    padded[blockIndex] = { text: block.text, table: block.table }
  })
  return padded
}

/** 比较卡片正文和澄清题干时去掉 Markdown 修饰与空白，避免“同一道题渲染两遍”。 */
function compactCardText(text: string): string {
  return String(text || '')
    .replace(/\*\*|__|`/g, '')
    .replace(/^[#>\s-]+/gm, '')
    .replace(/\s+/g, '')
    .trim()
}

/** 填空题里连续下划线/全角下划线代表一个空；最多拆 8 个输入框，避免卡片过重。 */
const CLARIFY_BLANK_PATTERN = /_{2,}|＿{2,}/g
const MAX_CLARIFY_BLANKS = 8

function countClarifyBlanks(text: string): number {
  return (String(text || '').match(CLARIFY_BLANK_PATTERN) ?? []).length
}

function clarifyQuestionWithBlankLabels(text: string): string {
  let index = 0
  return String(text || '').replace(CLARIFY_BLANK_PATTERN, () => `〔空${++index}〕`)
}

function richCardData(
  state: DingTalkRichCardState,
  active: boolean,
): DingTalkRichCardData {
  const reasoning = state.reasoning.trim()
  const tools = state.tools ?? []
  const details = state.toolDetails ?? []
  const hasTools = richHasTools(state)
  const thinkingDone = richThinkingDone(state)
  const toolRunning = richToolRunning(state)
  const thinkingPreviewText = reasoning || (active && !thinkingDone ? '正在分析你的问题…' : '')
  const thinkingPreview = previewLine(thinkingPreviewText, 96)
  const toolsPreview = hasTools ? richToolsPreview(details, tools, active) : ''
  const thinkingHeader = richPanelHeader(richThinkingTitle(thinkingDone, state.thinkingMs), thinkingPreview)
  // 工具事件可能先到 tools 名称、后到 toolDetails；预览已经显示“执行中”时，
  // 头部也要同步切成“工具调用中”，不能只剩一个“工具”。
  const toolRunningForHeader = toolRunning || toolsPreview.endsWith('执行中')
  const toolsHeader = richPanelHeader(richToolTitle(toolRunningForHeader), toolsPreview)
  const answerText = state.answer.trim()
  const answerBlocks = parseAnswerBlocks(answerText)  // 不在正文里拼光标或 loading 图标：流式刷新本身已经能表达“还在生成”。
  // 光标既会破坏 Markdown（表格/代码块尾部尤其明显），也容易在收口失败时残留。
  const attachments = (state.attachments ?? []).slice(0, 3).map((attachment) => ({
    fileName: String(attachment.fileName ?? ''),
    url: String(attachment.url ?? ''),
    previewUrl: String(attachment.previewUrl ?? attachment.url ?? ''),
    size: Number(attachment.size ?? 0),
    mimeType: String(attachment.mimeType ?? ''),
    description: String(attachment.description ?? '钉盘在线预览'),
  }))
  const clarifyQuestions = state.clarify?.questions ?? []
  const clarifyTotal = clarifyQuestions.length
  const clarifyIndex = Math.min(
    Math.max(0, Math.trunc(Number(state.clarify?.index ?? 0) || 0)),
    Math.max(0, clarifyTotal - 1),
  )
  const currentClarify = clarifyTotal > 0 ? clarifyQuestions[clarifyIndex] : null
  const clarifyKind: DingTalkClarifyKind = normalizeClarifyKind(
    currentClarify?.kind ?? state.clarify?.kind,
  )
  const clarifyQuestion = String(currentClarify?.question ?? state.clarify?.question ?? '')
  const hasClarify = Boolean(clarifyQuestion.trim())
  const clarifyAnswer = state.clarify?.answers?.[String(clarifyIndex + 1)]
  const clarifyBlankCount = clarifyKind === 'text' ? countClarifyBlanks(clarifyQuestion) : 0
  const useClarifyBlankFields = clarifyBlankCount > 0 && clarifyBlankCount <= MAX_CLARIFY_BLANKS
  const clarifyBlanks = useClarifyBlankFields
    ? Array.from({ length: clarifyBlankCount }, (_, index) => String(clarifyAnswer?.blanks?.[index] ?? ''))
    : []
  const clarifyDisplayQuestion = useClarifyBlankFields
    ? clarifyQuestionWithBlankLabels(clarifyQuestion)
    : clarifyQuestion
  const clarifyIsBatch = clarifyTotal > 1
  const clarifyLooksLikeQuiz = /第\s*[0-9一二三四五六七八九十百]+\s*题|(?:\*\*)?(?:判断|选择|填空|问答)题|作答|答题/.test(clarifyQuestion)
  // 题组/单题的正文里已经包含当前题干时，正文区不要再渲染一遍：
  // 题干统一由 clarifyQuestion 展示，避免钉钉里出现“同一道题上下两遍”。
  // 只在“题卡场景”或正文与题干完全相同时去重，保留普通澄清前的分析正文。
  const clarifyCompact = compactCardText(clarifyQuestion)
  const answerCompact = compactCardText(answerText)
  const answerContainsClarifyQuestion = Boolean(clarifyCompact) && answerCompact.includes(clarifyCompact)
  const shouldSuppressDuplicateAnswer = hasClarify
    && answerContainsClarifyQuestion
    && (answerCompact === clarifyCompact || clarifyIsBatch || clarifyLooksLikeQuiz)
  const visibleAnswerBlocks = shouldSuppressDuplicateAnswer ? emptyAnswerBlocks() : answerBlocks
  const clarifyStep = Math.max(1, Math.trunc(Number(state.clarify?.step) || 1))
  const clarifySelected = (clarifyAnswer?.selected ?? []).map((value) => String(value))
  const clarifyText = String(clarifyAnswer?.text ?? '')
  const clarifyOptions = (currentClarify?.options ?? state.clarify?.options ?? []).slice(0, 4).map((option) => {
    const id = String(option.id ?? '')
    const label = String(option.label ?? '')
    const description = String(option.description ?? '')
    // 单选的选中态没有 ChoicePicker 的勾选框；在描述前加显式标记，
    // 让钉钉客户端上“已选”和未选一眼能分开。
    const selected = clarifyKind === 'single' && (clarifySelected.includes(id) || clarifySelected.includes(label))
    return {
      id,
      label,
      description: selected ? `✓ 已选${description ? ` · ${description}` : ''}` : description,
    }
  })
  const clarifyPlaceholder = String(
    currentClarify?.placeholder ?? state.clarify?.placeholder ?? '',
  )
  const clarifyIsLast = clarifyIsBatch && clarifyIndex === clarifyTotal - 1
  const clarifyCanPrev = clarifyIsBatch && clarifyIndex > 0
  const clarifyCanNext = clarifyIsBatch && clarifyIndex < clarifyTotal - 1
  const clarifyProgress = clarifyIsBatch
    ? `第 ${clarifyIndex + 1} / ${clarifyTotal} 题`
    : hasClarify && clarifyStep > 1
      ? `第 ${clarifyStep} 题`
      : ''
  const clarifyUi: Record<string, boolean> = {}
  clarifyOptions.forEach((option, optionIndex) => {
    clarifyUi[`showClarifyOption${optionIndex}`] = clarifyKind === 'single' && Boolean(option.label)
    clarifyUi[`showClarifyDesc${optionIndex}`] = clarifyKind === 'single' && Boolean(option.description)
  })
  const answerUi: Record<string, boolean> = {}
  visibleAnswerBlocks.forEach((block, blockIndex) => {
    const hasText = Boolean(block.text.trim())
    const hasTable = block.table.meta.length > 0
    answerUi[`showAnswerText${blockIndex}`] = hasText
    answerUi[`showAnswerTable${blockIndex}`] = hasTable
    answerUi[`showAnswerUnit${blockIndex}`] = hasText || hasTable
  })
  return {
    // 正文拆成文本段和原生表格段；表格由 Table 组件自己横滚，不改成竖排列表。
    answer: { blocks: visibleAnswerBlocks },
    thinking: {
      text: flattenMarkdownTables(thinkingPreviewText),
      // 和网页 CoT 一样保留首句摘要：收起时标题 + 首句，展开后仍能看完整思维链。
      preview: thinkingPreview,
      // 单行入口由同一个 Text 承载标题、首句和箭头，避免 A2UI 客户端拆成两行。
      header: thinkingHeader,
    },
    tools: {
      text: flattenMarkdownTables(richToolsMarkdown(details, tools)),
      // 工具结束后仍保留数量/总耗时，避免收起后只剩一个“工具”标题。
      preview: toolsPreview,
      header: toolsHeader,
    },
    attachments,
    clarify: {
      sessionId: String(state.clarify?.sessionId ?? ''),
      badge: hasClarify
        ? clarifyIsBatch || clarifyLooksLikeQuiz
          ? clarifyKind === 'text'
            ? '请填写答案'
            : '请选择答案'
          : clarifyKind === 'text'
            ? '需要你填写答案'
            : clarifyKind === 'multiple'
              ? '需要你多选'
              : '需要你确认方向'
        : '',
      hint: hasClarify
        ? clarifyIsBatch
          ? '**一题一页作答**，可点“上一题/下一题”切换；最后一题点“提交全部”。'
          : clarifyKind === 'text'
            ? useClarifyBlankFields
              ? '**请逐个填写每个空后提交**'
              : clarifyPlaceholder || '**请填写答案后提交**'
            : clarifyKind === 'multiple'
              ? '**请选择所有符合的选项**，然后点“提交多选”'
              : state.clarify?.allowCustom !== false
                ? '**请选择一个方向继续**，也可以直接回复你自己的方向'
                : '**请选择一个方向继续**'
        : '',
      kind: clarifyKind,
      question: clarifyQuestion,
      displayQuestion: clarifyDisplayQuestion,
      blanks: clarifyBlanks,
      placeholder: clarifyPlaceholder || '请输入你的答案…',
      progress: clarifyProgress,
      selected: clarifySelected,
      text: clarifyText,
      total: clarifyTotal,
      index: clarifyIndex,
      canPrev: clarifyCanPrev,
      canNext: clarifyCanNext,
      isLast: clarifyIsLast,
      options: clarifyOptions,
      pickerOptions: clarifyOptions.map((option) => ({ label: option.label, value: option.id })),
    },
    thinkingDone,
    ui: {
      // 思考面板不因工具出现而隐藏：工具阶段仍保留“正在思考中”，
      // 工具面板在它下面单独占一行标题 + 一行当前工具信息。
      showThinking: active || Boolean(reasoning) || hasTools,
      showThinkingPreview: Boolean(thinkingPreview),
      showThinkingHeader: active || Boolean(reasoning) || hasTools,
      thinkingExpanded: false,
      showTools: hasTools,
      showToolsPreview: Boolean(toolsPreview),
      showToolsHeader: hasTools,
      toolsExpanded: false,
      showAttachments: attachments.length > 0,
      showAttachment0: attachments.length > 0,
      showAttachment1: attachments.length > 1,
      showAttachment2: attachments.length > 2,
      showClarify: hasClarify,
      showClarifyProgress: hasClarify && (clarifyIsBatch || clarifyStep > 1),
      showClarifySingle: hasClarify && clarifyKind === 'single' && clarifyOptions.length > 0,
      showClarifyMultiple: hasClarify && clarifyKind === 'multiple',
      showClarifyText: hasClarify && clarifyKind === 'text' && !useClarifyBlankFields,
      showClarifyBlanks: hasClarify && clarifyKind === 'text' && useClarifyBlankFields,
      showClarifySubmit: hasClarify && (clarifyIsBatch ? clarifyIsLast : clarifyKind === 'multiple' || clarifyKind === 'text'),
      showClarifyNav: clarifyIsBatch,
      showClarifyPrev: clarifyCanPrev,
      showClarifyNext: clarifyCanNext,
      showClarifyCustom: hasClarify && clarifyKind === 'single' && state.clarify?.allowCustom !== false,
      showClarifyOption0: false,
      showClarifyOption1: false,
      showClarifyOption2: false,
      showClarifyOption3: false,
      showClarifyDesc0: false,
      showClarifyDesc1: false,
      showClarifyDesc2: false,
      showClarifyDesc3: false,
      ...clarifyUi,
      ...answerUi,
    },
  }
}

/**
 * 思考/工具用 CollapsiblePanel 收起，默认只占标题一行；正文 Markdown 放在最后。
 * 生命周期沿用 dsh-im 的单卡流式，但组件树换成官方 A2UI 的可折叠面板。
 */
function richCardComponents(
  active: boolean,
  thinkingDone = false,
  clarify?: DingTalkClarifyState | null,
  toolRunning = false,
  _thinkingMs?: number,
  sessionId = '',
): Array<Record<string, unknown>> {
  const clarifyQuestions = clarify?.questions ?? []
  const clarifyTotal = clarifyQuestions.length
  const clarifyIndex = Math.min(
    Math.max(0, Math.trunc(Number(clarify?.index ?? 0) || 0)),
    Math.max(0, clarifyTotal - 1),
  )
  const currentClarify = clarifyTotal > 0 ? clarifyQuestions[clarifyIndex] : null
  const clarifyKind: DingTalkClarifyKind = normalizeClarifyKind(
    currentClarify?.kind ?? clarify?.kind,
  )
  const clarifyRawQuestion = String(currentClarify?.question ?? clarify?.question ?? '')
  const clarifyBlankCount = clarifyKind === 'text' ? countClarifyBlanks(clarifyRawQuestion) : 0
  const useClarifyBlankFields = clarifyBlankCount > 0 && clarifyBlankCount <= MAX_CLARIFY_BLANKS
  const clarifyStep = Math.max(1, Math.trunc(Number(clarify?.step) || 1))
  // 输入框 ID 按“当前页 + 步骤”变化：A2UI 客户端会保留同名 TextField 的本地输入态，
  // 若翻页后沿用 clarifyBlank0，上一题的文字会带到下一题。换 ID 等于强制换组件实例。
  const clarifyFieldKey = `${clarifyIndex}_${clarifyStep}`
  const clarifyBlankId = (index: number) => `clarifyBlank_${clarifyFieldKey}_${index}`
  const clarifyTextFieldId = `clarifyTextField_${clarifyFieldKey}`
  const clarifyOptions = (currentClarify?.options ?? clarify?.options ?? []).slice(0, 4).map((option) => ({
    id: String(option.id ?? ''),
    label: String(option.label ?? ''),
    description: String(option.description ?? ''),
  }))
  const clarifyIsBatch = clarifyTotal > 1
  // 只让“进行中”的标题做流光，不碰面板内容、正文和终态；
  // 这样 iOS 上是标题文字扫光，不会整块面板一起动。
  const thinkingShimmer = active && !thinkingDone
  return [
    {
      id: 'root',
      component: 'Card',
      child: 'rootColumn',
      // 交给钉钉按当前主题解析底色，避免写死白底在桌面端变成一块灰边白卡。
      backgroundColorToken: 'common_bg_color',
      padding: 18,
      cornerRadius: 16,
    },
    {
      id: 'rootColumn',
      component: 'Column',
      children: ['thinkingBlock', 'toolBlock', 'answerRow', 'clarifyBlock', 'attachmentBlock'],
      gap: 12,
    },
    {
      id: 'thinkingBlock',
      component: 'Column',
      children: ['thinkingHeaderRow', 'thinkingBody'],
      gap: 2,
      visible: { path: '/ui/showThinking' },
    },
    {
      // 入口是 Row + Text(weight=1) + 独立箭头：手机宽度不足时只有预览被省略，
      // 箭头永远留在行尾，不会像单个 Text 那样被省略号一起挤掉。
      id: 'thinkingHeaderRow',
      component: 'Row',
      align: 'center',
      gap: 2,
      children: ['thinkingHeader', 'thinkingChevron'],
      visible: { path: '/ui/showThinkingHeader' },
    },
    {
      // 字号用 body，贴近网页端 12–13px 的入口，不使用更小的 caption。
      id: 'thinkingHeader',
      component: 'Text',
      text: { path: '/thinking/header' },
      maxLine: 1,
      weight: 1,
      variant: 'body',
      customLightColor: '#667085',
      customDarkColor: '#98A2B3',
      ...(thinkingShimmer ? { textEffect: 'shimmer' } : {}),
      onLinkClick: {
        event: {
          name: 'eab_panel_toggle',
          context: {
            action: 'panel_toggle',
            panel: 'thinking',
            sessionId,
          },
        },
      },
      fallbackMarkdown: '思考',
    },
    {
      id: 'thinkingChevron',
      component: 'Text',
      text: '›',
      maxLine: 1,
      variant: 'body',
      customLightColor: '#667085',
      customDarkColor: '#98A2B3',
      visible: { path: '/ui/showThinkingHeader' },
      onLinkClick: {
        event: {
          name: 'eab_panel_toggle',
          context: {
            action: 'panel_toggle',
            panel: 'thinking',
            sessionId,
          },
        },
      },
    },
    {
      id: 'thinkingBody',
      component: 'Markdown',
      content: { path: '/thinking/text' },
      visible: { path: '/ui/thinkingExpanded' },
    },
    {
      id: 'toolBlock',
      component: 'Column',
      children: ['toolHeaderRow', 'toolBody'],
      gap: 2,
      visible: { path: '/ui/showTools' },
    },
    {
      id: 'toolHeaderRow',
      component: 'Row',
      align: 'center',
      gap: 2,
      children: ['toolHeader', 'toolChevron'],
      visible: { path: '/ui/showToolsHeader' },
    },
    {
      id: 'toolHeader',
      component: 'Text',
      text: { path: '/tools/header' },
      maxLine: 1,
      weight: 1,
      variant: 'body',
      customLightColor: '#667085',
      customDarkColor: '#98A2B3',
      ...(toolRunning ? { textEffect: 'shimmer' } : {}),
      onLinkClick: {
        event: {
          name: 'eab_panel_toggle',
          context: {
            action: 'panel_toggle',
            panel: 'tools',
            sessionId,
          },
        },
      },
      fallbackMarkdown: '工具',
    },
    {
      id: 'toolChevron',
      component: 'Text',
      text: '›',
      maxLine: 1,
      variant: 'body',
      customLightColor: '#667085',
      customDarkColor: '#98A2B3',
      visible: { path: '/ui/showToolsHeader' },
      onLinkClick: {
        event: {
          name: 'eab_panel_toggle',
          context: {
            action: 'panel_toggle',
            panel: 'tools',
            sessionId,
          },
        },
      },
    },
    {
      id: 'toolBody',
      component: 'Markdown',
      content: { path: '/tools/text' },
      visible: { path: '/ui/toolsExpanded' },
    },
    {
      // 正文是唯一渲染主体；保持纯 Markdown，不加光标或 loading 图标。
      id: 'answerRow',
      component: 'Row',
      align: 'end',
      gap: 0,
      children: ['answerBlocks'],
    },
    {
      id: 'answerBlocks',
      component: 'Column',
      gap: 8,
      weight: 1,
      children: Array.from({ length: MAX_ANSWER_BLOCKS }, (_, index) => `answerUnit${index}`),
    },
    ...Array.from({ length: MAX_ANSWER_BLOCKS }, (_, index) => [
      {
        id: `answerUnit${index}`,
        component: 'Column',
        gap: 6,
        visible: { path: `/ui/showAnswerUnit${index}` },
        children: [`answerText${index}`, `answerTable${index}`],
      },
      {
        id: `answerText${index}`,
        component: 'Markdown',
        content: { path: `/answer/blocks/${index}/text` },
        visible: { path: `/ui/showAnswerText${index}` },
      },
      {
        // 原生 Table 才有 scrollAreaWidth；宽表格在这里横向滚动，不再被裁列。
        id: `answerTable${index}`,
        component: 'Table',
        data: { path: `/answer/blocks/${index}/table` },
        scrollAreaWidth: 320,
        cellPadding: 6,
        maxLine: 3,
        zebra: true,
        visible: { path: `/ui/showAnswerTable${index}` },
      },
    ]).flat(),
    {
      // 澄清区做成一张浅色面板：顶部标签说明当前状态，下面每个方向是一整行可点击卡片。
      id: 'clarifyBlock',
      component: 'Column',
      children: ['clarifyProgress', 'clarifyBadge', 'clarifyQuestion', 'clarifyHint', 'clarifyOptions', 'clarifyPicker', 'clarifyBlanks', clarifyTextFieldId, 'clarifyNav', 'clarifySubmit'],
      gap: 8,
      visible: { path: '/ui/showClarify' },
    },
    {
      id: 'clarifyProgress',
      component: 'Text',
      text: { path: '/clarify/progress' },
      variant: 'caption',
      maxLine: 1,
      visible: { path: '/ui/showClarifyProgress' },
    },
    {
      id: 'clarifyBadge',
      component: 'Tag',
      text: { path: '/clarify/badge' },
      theme: 'warning',
      variant: 'filled',
      visible: { path: '/ui/showClarify' },
    },
    {
      id: 'clarifyQuestion',
      component: 'Markdown',
      content: { path: '/clarify/displayQuestion' },
      visible: { path: '/ui/showClarify' },
    },
    {
      id: 'clarifyHint',
      component: 'Markdown',
      content: { path: '/clarify/hint' },
      visible: { path: '/ui/showClarify' },
    },
    {
      id: 'clarifyOptions',
      component: 'Column',
      children: ['clarifyOptionCard0', 'clarifyOptionCard1', 'clarifyOptionCard2', 'clarifyOptionCard3'],
      gap: 8,
      visible: { path: '/ui/showClarifySingle' },
    },
    {
      // 多选题用官方 ChoicePicker(multipleSelection) 绑定字符串数组；
      // 用户勾完再点提交，避免每勾一项就触发一次回调。
      id: 'clarifyPicker',
      component: 'ChoicePicker',
      variant: 'multipleSelection',
      displayStyle: 'checkbox',
      options: clarifyOptions.map((option) => ({ label: option.label, value: option.id })),
      value: { path: '/clarify/selected' },
      visible: { path: '/ui/showClarifyMultiple' },
    },
    {
      // 填空题按题干里的横线拆成多个输入框；每个空单独绑定一个数据路径。
      id: 'clarifyBlanks',
      component: 'Column',
      children: Array.from({ length: useClarifyBlankFields ? clarifyBlankCount : 0 }, (_, index) => clarifyBlankId(index)),
      gap: 8,
      visible: { path: '/ui/showClarifyBlanks' },
    },
    ...Array.from({ length: useClarifyBlankFields ? clarifyBlankCount : 0 }, (_, index) => ({
      id: clarifyBlankId(index),
      component: 'TextField',
      variant: 'shortText',
      label: `第 ${index + 1} 空`,
      placeholder: `请输入第 ${index + 1} 空`,
      value: { path: `/clarify/blanks/${index}` },
      visible: { path: '/ui/showClarifyBlanks' },
    })),
    {
      // 没有横线的填空仍保留原来的单输入框。
      id: clarifyTextFieldId,
      component: 'TextField',
      variant: 'shortText',
      label: '你的答案',
      placeholder: { path: '/clarify/placeholder' },
      value: { path: '/clarify/text' },
      visible: { path: '/ui/showClarifyText' },
    },
    {
      id: 'clarifyNav',
      component: 'Row',
      children: ['clarifyPrev', 'clarifyNext'],
      gap: 8,
      visible: { path: '/ui/showClarifyNav' },
    },
    {
      id: 'clarifyPrev',
      component: 'Button',
      child: 'clarifyPrevLabel',
      variant: 'text',
      action: {
        event: {
          name: 'eab_clarify_nav',
          context: {
            action: 'clarify_nav',
            direction: 'prev',
            sessionId: clarify?.sessionId ?? '',
            step: clarifyStep,
            index: clarifyIndex,
            selected: { path: '/clarify/selected' },
            text: { path: '/clarify/text' },
            blanks: { path: '/clarify/blanks' },
          },
        },
      },
      visible: { path: '/ui/showClarifyPrev' },
    },
    {
      id: 'clarifyPrevLabel',
      component: 'Text',
      text: '上一题',
      maxLine: 1,
    },
    {
      id: 'clarifyNext',
      component: 'Button',
      child: 'clarifyNextLabel',
      variant: 'text',
      action: {
        event: {
          name: 'eab_clarify_nav',
          context: {
            action: 'clarify_nav',
            direction: 'next',
            sessionId: clarify?.sessionId ?? '',
            step: clarifyStep,
            index: clarifyIndex,
            selected: { path: '/clarify/selected' },
            text: { path: '/clarify/text' },
            blanks: { path: '/clarify/blanks' },
          },
        },
      },
      visible: { path: '/ui/showClarifyNext' },
    },
    {
      id: 'clarifyNextLabel',
      component: 'Text',
      text: '下一题',
      maxLine: 1,
    },
    {
      id: 'clarifySubmit',
      component: 'Button',
      child: 'clarifySubmitLabel',
      action: {
        event: {
          name: 'eab_clarify_submit',
          context: {
            action: clarifyKind === 'multiple' ? 'clarify_multi' : 'clarify_text',
            sessionId: clarify?.sessionId ?? '',
            step: clarifyStep,
            index: clarifyIndex,
            // ChoicePicker/TextField 的值在客户端数据模型里，按钮点击时由 A2UI 解析成真实值。
            selected: { path: '/clarify/selected' },
            text: { path: '/clarify/text' },
            blanks: { path: '/clarify/blanks' },
          },
        },
      },
      visible: { path: '/ui/showClarifySubmit' },
    },
    {
      id: 'clarifySubmitLabel',
      component: 'Text',
      text: clarifyIsBatch ? '提交全部' : clarifyKind === 'multiple' ? '提交多选' : '提交答案',
      maxLine: 1,
    },
    // 用带背景/圆角的 Row 承载整个选项，并把 action 挂在 Row 上：
    // 这样整行都能点，不再只有文字宽度的小按钮；Button 的 child 只能放 Text，
    // 无法同时放标题和描述，也不方便做整行卡片。
    ...[0, 1, 2, 3].map((index) => ({
      id: `clarifyOptionCard${index}`,
      component: 'Row',
      children: [`clarifyOptionBody${index}`, `clarifyOptionArrow${index}`],
      gap: 8,
      align: 'center',
      padding: 12,
      cornerRadius: 12,
      backgroundColor: index === 0 ? '#141F7A4D' : '#0A1F7A4D',
      borderWidth: 1,
      borderColor: '#261F7A4D',
      visible: { path: `/ui/showClarifyOption${index}` },
      action: {
        event: clarifyIsBatch
          ? {
              name: 'eab_clarify_nav',
              context: {
                action: 'clarify_nav',
                // 题组单选：点选项先存草稿；非最后一页直接进下一题，最后一页只记选中。
                direction: clarifyIndex < clarifyTotal - 1 ? 'next' : 'pick',
                sessionId: clarify?.sessionId ?? '',
                step: clarifyStep,
                index: clarifyIndex,
                optionId: clarifyOptions[index]?.id ?? '',
                optionLabel: clarifyOptions[index]?.label ?? '',
                selected: { path: '/clarify/selected' },
                text: { path: '/clarify/text' },
              },
            }
          : {
              name: 'eab_clarify_select',
              // A2UI 的交互事件不会自动完成请求闭环，业务标识直接放进 context，
              // Stream 卡片回调里再从 cardPrivateData.params 校验并续跑同一会话。
              context: {
                action: 'clarify_select',
                sessionId: clarify?.sessionId ?? '',
                optionId: clarifyOptions[index]?.id ?? '',
                optionLabel: clarifyOptions[index]?.label ?? '',
              },
            },
      },
    })),
    ...[0, 1, 2, 3].map((index) => ({
      id: `clarifyOptionBody${index}`,
      component: 'Column',
      gap: 3,
      weight: 1,
      children: [`clarifyOptionLabel${index}`, `clarifyOptionDesc${index}`],
      visible: { path: `/ui/showClarifyOption${index}` },
    })),
    ...[0, 1, 2, 3].flatMap((index) => [
      {
        id: `clarifyOptionLabel${index}`,
        component: 'Text',
        text: { path: `/clarify/options/${index}/label` },
        maxLine: 2,
      },
      {
        id: `clarifyOptionDesc${index}`,
        component: 'Text',
        variant: 'caption',
        text: { path: `/clarify/options/${index}/description` },
        maxLine: 2,
        visible: { path: `/ui/showClarifyDesc${index}` },
      },
      {
        id: `clarifyOptionArrow${index}`,
        component: 'Text',
        text: '›',
        maxLine: 1,
        visible: { path: `/ui/showClarifyOption${index}` },
      },
    ]),
    {
      // 钉盘文件卡片：File 组件整行点击走 previewUrl，钉钉客户端会打开自己的
      // 在线预览页；url 仍保留给行尾打开按钮。
      id: 'attachmentBlock',
      component: 'Column',
      children: ['attachment0', 'attachment1', 'attachment2'],
      gap: 8,
      visible: { path: '/ui/showAttachments' },
    },
    ...[0, 1, 2].map((index) => ({
      id: `attachment${index}`,
      component: 'File',
      fileName: { path: `/attachments/${index}/fileName` },
      url: { path: `/attachments/${index}/url` },
      previewUrl: { path: `/attachments/${index}/previewUrl` },
      size: { path: `/attachments/${index}/size` },
      mimeType: { path: `/attachments/${index}/mimeType` },
      description: { path: `/attachments/${index}/description` },
      visible: { path: `/ui/showAttachment${index}` },
      fallbackMarkdown: '文件',
    })),
  ]
}

function a2uiMessage(payload: Record<string, unknown>): string {
  return JSON.stringify({ version: 'v1.0', ...payload })
}

export function buildDingTalkA2UIArtifactAnnotations(surfaceId: string): Array<{
  surfaceId: string
  componentId: string
  type: 'artifact'
}> {
  // 钉钉用标为 artifact 的组件生成会话列表里的文本；正文现在拆成多个段，
  // 每个 Markdown 段都标上，避免“只有表格没有正文”时摘要为空。
  return Array.from({ length: MAX_ANSWER_BLOCKS }, (_, index) => ({
    surfaceId,
    componentId: `answerText${index}`,
    type: 'artifact' as const,
  }))
}

export function buildDingTalkA2UICreateMessages(
  surfaceId: string,
  state: DingTalkRichCardState,
): string[] {
  return [
    a2uiMessage({
      createSurface: {
        surfaceId,
        catalogId: A2UI_CATALOG_ID,
      },
    }),
    a2uiMessage({
      updateDataModel: {
        surfaceId,
        path: '/',
        value: richCardData(state, true),
      },
    }),
    a2uiMessage({
      updateComponents: {
        surfaceId,
        components: richCardComponents(
          true,
          richThinkingDone(state),
          undefined,
          richToolRunning(state),
          state.thinkingMs,
          state.sessionId,
        ),
      },
    }),
  ]
}

export function buildDingTalkA2UIUpdateMessages(
  surfaceId: string,
  state: DingTalkRichCardState,
  active: boolean,
  previous?: DingTalkRichCardState,
): string[] {
  const data = richCardData(state, active)
  const previousData = previous ? richCardData(previous, active) : null
  const messages: string[] = []
  const pushData = (path: string, value: unknown, previousValue: unknown) => {
    if (previousData && value === previousValue) return
    messages.push(a2uiMessage({ updateDataModel: { surfaceId, path, value } }))
  }

  if (!previousData || JSON.stringify(data.answer) !== JSON.stringify(previousData.answer)) {
    messages.push(a2uiMessage({ updateDataModel: { surfaceId, path: '/answer', value: data.answer } }))
  }
  pushData('/thinking/text', data.thinking.text, previousData?.thinking.text)
  pushData('/thinking/preview', data.thinking.preview, previousData?.thinking.preview)
  pushData('/thinking/header', data.thinking.header, previousData?.thinking.header)
  pushData('/tools/text', data.tools.text, previousData?.tools.text)
  pushData('/tools/preview', data.tools.preview, previousData?.tools.preview)
  pushData('/tools/header', data.tools.header, previousData?.tools.header)
  // UI 字段逐项更新，不整份下发：用户点开后服务端仍以为 thinkingExpanded=false，
  // 整份 /ui 会在下一帧把刚展开的面板重新收起。
  // 没有上一帧时（首次渲染 / resume / 澄清卡收口）整份下发一次即可；
  // 题组有 3 道题时逐项 /ui 会把消息数推到 100+，被钉钉以 param.invalid 拒绝。
  if (previousData) {
    for (const key of Object.keys(data.ui) as Array<keyof DingTalkRichCardData['ui']>) {
      pushData(`/ui/${String(key)}`, data.ui[key], previousData.ui[key])
    }
  } else {
    messages.push(a2uiMessage({ updateDataModel: { surfaceId, path: '/ui', value: data.ui } }))
  }
  if (!previousData || JSON.stringify(data.attachments) !== JSON.stringify(previousData.attachments)) {
    pushData('/attachments', data.attachments, previousData?.attachments)
  }
  if (!previousData || JSON.stringify(data.clarify) !== JSON.stringify(previousData.clarify)) {
    pushData('/clarify', data.clarify, previousData?.clarify)
  }

  // 只在“某个面板的结构/标题真的变了”时重发对应组件；纯流式阶段只更新数据。
  // 工具开始/结束不再顺带重发思考面板，避免把正在播放的标题流光打断。
  // 思考/工具标题和首句都在数据路径里，纯流式只更新数据即可；
  // 但标题流光（textEffect）是组件静态属性，进入/离开“进行中”时必须重发头部组件。
  // 澄清区会换组件 ID（输入框按页重建），也需要重发对应组件。
  const finalFrame = !active
  const thinkingChanged =
    !previous ||
    Boolean(state.thinkingDone) !== Boolean(previous.thinkingDone) ||
    Math.max(0, Math.trunc(Number(state.thinkingMs) || 0)) !==
      Math.max(0, Math.trunc(Number(previous.thinkingMs) || 0))
  const toolsChanged =
    !previous ||
    (state.tools ?? []).length !== (previous.tools ?? []).length ||
    JSON.stringify(state.toolDetails ?? []) !== JSON.stringify(previous.toolDetails ?? [])
  const clarifyChanged =
    Boolean(state.clarify || previous?.clarify) &&
    (finalFrame ||
      !previous ||
      JSON.stringify(state.clarify ?? null) !== JSON.stringify(previous.clarify ?? null))
  if (thinkingChanged || toolsChanged || clarifyChanged) {
    const terminal = richCardComponents(
      active,
      Boolean(data.thinkingDone),
      state.clarify,
      richToolRunning(state),
      state.thinkingMs,
      state.sessionId,
    )
    const structuralIds = new Set<string>()
    if (thinkingChanged) structuralIds.add('thinkingHeader')
    if (toolsChanged) structuralIds.add('toolHeader')
    if (clarifyChanged) {
      // 输入框 ID 带页序号，不能再靠固定 ID 列表筛选；澄清区变化时整体重发 clarify* 组件。
      for (const component of terminal) {
        const id = String(component.id ?? '')
        if (id.startsWith('clarify')) structuralIds.add(id)
      }
    }
    if (structuralIds.size > 0) {
      messages.push(
        a2uiMessage({
          updateComponents: {
            surfaceId,
            components: terminal.filter((component) => structuralIds.has(String(component.id))),
          },
        }),
      )
    }
  }
  return messages
}

/**
 * 终态兜底：把数据压到 9 条以内。钉钉单次 update 超过 100 条会统一报
 * param.invalid；正文/头部/附件/澄清外，UI 显隐整包下发一次即可。
 */
function compactFinalDataMessages(surfaceId: string, state: DingTalkRichCardState): string[] {
  const data = richCardData(state, false)
  return [
    a2uiMessage({ updateDataModel: { surfaceId, path: '/answer', value: data.answer } }),
    a2uiMessage({ updateDataModel: { surfaceId, path: '/thinking/text', value: data.thinking.text } }),
    a2uiMessage({ updateDataModel: { surfaceId, path: '/thinking/header', value: data.thinking.header } }),
    a2uiMessage({ updateDataModel: { surfaceId, path: '/tools/text', value: data.tools.text } }),
    a2uiMessage({ updateDataModel: { surfaceId, path: '/tools/header', value: data.tools.header } }),
    a2uiMessage({ updateDataModel: { surfaceId, path: '/ui', value: data.ui } }),
    a2uiMessage({ updateDataModel: { surfaceId, path: '/attachments', value: data.attachments } }),
    a2uiMessage({ updateDataModel: { surfaceId, path: '/clarify', value: data.clarify } }),
    a2uiMessage({
      updateDataModel: { surfaceId, path: '/ui/thinkingExpanded', value: false },
    }),
  ]
}

/**
 * 钉钉新版 A2UI AI 卡片。需要应用开通 AICard.Instance.Write；
 * 旧模板卡不支持折叠面板，所以这里单独走 /v1.0/card/ai/instances/*。
 */
export class DingTalkAICardStream {
  private phase: 'idle' | 'active' | 'finishing' | 'finished' | 'failed' = 'idle'
  private cardInstanceId = ''
  private surfaceId = ''
  private pendingState: DingTalkRichCardState | null = null
  private lastSentState: DingTalkRichCardState | null = null
  private pendingSince = 0
  private lastSentChars = 0
  private scheduled: NodeJS.Timeout | null = null
  private worker: Promise<void> | null = null
  private finishPromise: Promise<boolean> | null = null
  private closing = false
  private lastUpdateAt = 0
  /** 连续刷新失败次数；瞬时网络错误不应直接判死整张流式卡。 */
  private updateFailures = 0

  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly userId: string,
    private readonly robotCode: string,
    private readonly logger: Pick<Console, 'warn'> = console,
  ) {}

  get providerMessageIds(): string[] {
    return this.cardInstanceId ? [this.cardInstanceId] : []
  }

  private async token(): Promise<string> {
    return dingTalkAccessToken(this.appId, this.appSecret)
  }

  private async cardRequest(
    path: string,
    options: { method?: string; token: string; body: unknown },
  ): Promise<Record<string, unknown>> {
    try {
      return await requestJson(`${DINGTALK_API}${path}`, options)
    } catch (error) {
      if (!(error instanceof DingTalkHttpError) || error.status !== 403) throw error
      await sleep(1_000)
      return requestJson(`${DINGTALK_API}${path}`, options)
    }
  }

  private async putUpdate(
    state: DingTalkRichCardState,
    flowStatus: string,
    active: boolean,
    previous?: DingTalkRichCardState | null,
  ): Promise<boolean> {
    const messages = buildDingTalkA2UIUpdateMessages(
      this.surfaceId,
      state,
      active,
      A2UI_DELTA_UPDATES && previous ? previous : undefined,
    )
    if (messages.length === 0) return false
    await this.putUpdateMessages(messages, flowStatus)
    return true
  }

  private async putUpdateMessages(messages: string[], flowStatus: string): Promise<void> {
    const token = await this.token()
    try {
      await this.cardRequest('/v1.0/card/ai/instances/update', {
        method: 'PUT',
        token,
        body: {
          outTrackId: this.cardInstanceId,
          outUpdateId: randomUUID(),
          flowStatus,
          a2uiMessages: messages,
        },
      })
    } catch (error) {
      // 钉钉 A2UI 更新一次最多接受 100 条 a2uiMessages；超过时接口只返回
      // 笼统的 param.invalid，看起来像 flowStatus 非法，实际是消息条数超限。
      if (error instanceof DingTalkHttpError && error.status === 400) {
        this.logger.warn?.(
          `[eab] 钉钉 A2UI 更新被拒：outTrackId=${this.cardInstanceId} phase=${this.phase} flowStatus=${flowStatus} 消息数=${messages.length} 含组件=${messages.some((message) => message.includes('"updateComponents"'))}`,
        )
      }
      throw error
    }
  }

  /**
   * 会话列表文本的主路径是 create 时把 answer 组件标成 artifact；
   * lastMessageI18n 作为国际化摘要补充在收口后刷新。
   */
  private async putLastMessage(summary: string): Promise<void> {
    const token = await this.token()
    const updated = await this.cardRequest('/v1.0/card/instances/spaces', {
      method: 'PUT',
      token,
      body: {
        outTrackId: this.cardInstanceId,
        imRobotOpenSpaceModel: {
          supportForward: false,
          lastMessageI18n: { ZH_CN: summary, EN_US: summary },
        },
      },
    })
    if (updated.result === false) throw new Error('钉钉卡片场域信息未更新（result=false）')
    console.info('[eab] 钉钉 A2UI 外层摘要已更新：', summary)
  }

  /**
   * flowStatus 枚举名以接口实际校验为准。FINISH 本身是合法值（已用真实卡验证 200），
   * 但在终态帧里同时带 updateComponents 时，钉钉会返回 400 且错误文案仍是
   * “flowStatus is not valid”。因此整包失败后依次降级：只发数据消息 -> 只推进状态，
   * 保证已经在流式阶段渲染的正文能被正常收口，不再回退成第二条纯文本。
   */
  private async putFinalStatus(
    state: DingTalkRichCardState,
    candidates: string[],
  ): Promise<void> {
    let lastError: unknown = null
    for (const status of candidates) {
      try {
        // 终态必须沿用上一帧做增量：整份 data 有 100+ 条 updateDataModel，
        // 钉钉会直接返回 param.invalid（错误文案却常被误读成 flowStatus 非法）。
        await this.putUpdate(state, status, false, this.lastSentState)
        return
      } catch (error) {
        lastError = error
        if (!(error instanceof DingTalkHttpError) || error.status !== 400) throw error
        // FINISH 已经是实测合法的终态名；它失败说明是消息体而不是枚举名，直接降级。
        if (status === A2UI_STATUS.finished) break
      }
    }

    // 只有完成态才做上面两条降级；失败态仍按原候选名尝试，失败就交给调用方处理。
    if (!candidates.includes(A2UI_STATUS.finished)) {
      throw lastError instanceof Error ? lastError : new Error('A2UI 终态更新失败')
    }

    // 降级 1：去掉 updateComponents，只把数据模型推到终态。
    // 仍然优先用增量；增量仍超限时退回到 9 条左右的紧凑终态数据。
    try {
      let messages = buildDingTalkA2UIUpdateMessages(
        this.surfaceId,
        state,
        false,
        A2UI_DELTA_UPDATES ? this.lastSentState ?? undefined : undefined,
      ).filter((message) => !message.includes('"updateComponents"'))
      if (messages.length > A2UI_MAX_MESSAGES) {
        messages = compactFinalDataMessages(this.surfaceId, state)
      }
      if (messages.length > 0) {
        await this.putUpdateMessages(messages, A2UI_STATUS.finished)
        this.lastSentState = cloneRichState(state)
        return
      }
    } catch (error) {
      lastError = error
      this.logger.warn?.('[eab] 钉钉 A2UI 终态数据更新失败，继续仅推进状态：', (error as Error).message)
    }

    // 降级 2：正文已经由流式帧写入时，只切状态即可；这条请求已实测 200。
    try {
      await this.putUpdateMessages(
        [
          a2uiMessage({
            updateDataModel: {
              surfaceId: this.surfaceId,
              path: '/ui/thinkingExpanded',
              value: false,
            },
          }),
        ],
        A2UI_STATUS.finished,
      )
      return
    } catch (error) {
      lastError = error
    }

    throw lastError instanceof Error ? lastError : new Error('A2UI 终态更新失败')
  }

  /** 先建卡并投放，首帧即带上折叠面板，避免先出现一条纯文字再补卡。 */
  async start(
    initialState: DingTalkRichCardState,
    conversationSummary?: string,
    options: { outTrackId?: string; surfaceId?: string } = {},
  ): Promise<boolean> {
    if (this.phase !== 'idle') return false
    if (Date.now() < a2uiDisabledUntil) {
      this.phase = 'failed'
      return false
    }
    try {
      const token = await this.token()
      const provided = String(options.outTrackId ?? '').trim()
      const suffix = provided
        ? provided.startsWith('eab_a2ui_')
          ? provided.slice('eab_a2ui_'.length)
          : ''
        : randomUUID().replace(/-/g, '')
      if (!suffix) {
        this.phase = 'failed'
        return false
      }
      const outTrackId = provided || `eab_a2ui_${suffix}`
      const surfaceId = String(options.surfaceId ?? '').trim() || `${A2UI_SURFACE_PREFIX}${suffix}`
      const robotCode = this.robotCode || this.appId
      const state = cloneRichState(initialState)
      const summary = conversationSummary || 'EAB 企业智能助手'
      const created = await this.cardRequest('/v1.0/card/ai/instances/createAndDeliver', {
        token,
        body: {
          userIdType: 1,
          outTrackId,
          openSpaceId: `dtv1.card//im_robot.${this.userId}`,
          imRobotOpenDeliverModel: { robotCode },
          // 会话列表文本由 a2uiAnnotations 标为 artifact 的 answer 组件生成；
          // lastMessageI18n 仍保留为国际化摘要，收口后再用 /v1.0/card/instances/spaces 更新。
          imRobotOpenSpaceModel: {
            supportForward: false,
            lastMessageI18n: { ZH_CN: summary, EN_US: summary },
          },
          protocolVersion: '1.0',
          flowStatus: A2UI_STATUS.processing,
          a2uiMessages: buildDingTalkA2UICreateMessages(surfaceId, state),
          a2uiAnnotations: buildDingTalkA2UIArtifactAnnotations(surfaceId),
          summary,
          callbackType: 'STREAM',
        },
      })

      const delivery = (created.result as { deliverResults?: Array<{ success?: boolean; errorMsg?: string }> } | undefined)
        ?.deliverResults?.[0]
      if (delivery && delivery.success === false) {
        throw new Error(delivery.errorMsg || '钉钉 A2UI 卡片没有投递成功')
      }

      this.cardInstanceId = outTrackId
      this.surfaceId = surfaceId
      this.phase = 'active'
      this.lastUpdateAt = Date.now()
      this.lastSentState = cloneRichState(state)
      this.lastSentChars = richTextLength(state)
      a2uiDisabledUntil = 0
      this.updateFailures = 0
      console.info('[eab] 钉钉 A2UI 新卡已创建：', outTrackId, 'initial=PROCESSING')
      return true
    } catch (error) {
      this.phase = 'failed'
      if (
        error instanceof DingTalkHttpError &&
        error.status === 403 &&
        /AICard\.Instance\.Write|AICard/i.test(error.message)
      ) {
        a2uiDisabledUntil = Date.now() + A2UI_PERMISSION_COOLDOWN_MS
      }
      this.logger.warn?.('[eab] 钉钉 A2UI 卡片创建失败，回退旧卡片：', (error as Error).message)
      return false
    }
  }

  /**
   * 只切换思考/工具正文的显隐，不重建整张卡。
   * 回调只需要一条 updateDataModel：服务端不持久化展开态，避免用户点开后
   * 下一次流式更新又把面板收回。
   */
  async togglePanel(
    outTrackId: string,
    panel: 'thinking' | 'tools',
    expanded: boolean,
  ): Promise<boolean> {
    const id = String(outTrackId ?? '').trim()
    if (!id.startsWith('eab_a2ui_')) return false
    if (panel !== 'thinking' && panel !== 'tools') return false
    this.cardInstanceId = id
    this.surfaceId = `${A2UI_SURFACE_PREFIX}${id.slice('eab_a2ui_'.length)}`
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const token = await this.token()
        await this.cardRequest('/v1.0/card/ai/instances/update', {
          method: 'PUT',
          token,
          body: {
            outTrackId: id,
            outUpdateId: randomUUID(),
            flowStatus: A2UI_STATUS.finished,
            a2uiMessages: [
              a2uiMessage({
                updateDataModel: {
                  surfaceId: this.surfaceId,
                  path: `/ui/${panel}Expanded`,
                  value: Boolean(expanded),
                },
              }),
            ],
          },
        })
        return true
      } catch (error) {
        // 真机上偶发 system.dependencyUnavailable（500），通常是卡片收口与点击
        // 同时打到更新接口；退避一次再试，失败才交给回调层提示。
        if (attempt === 0 && error instanceof DingTalkHttpError && error.status >= 500) {
          await sleep(300)
          continue
        }
        this.logger.warn?.('[eab] 钉钉 A2UI 面板切换失败：', (error as Error).message)
        return false
      }
    }
    return false
  }

  /**
   * 用户点击澄清按钮后复用原卡片，而不是再发一条新消息。
   * surfaceId 与 outTrackId 的 suffix 在创建时一一对应，这里按同一规则还原。
   */
  async resume(outTrackId: string, initialState: DingTalkRichCardState): Promise<boolean> {
    if (this.phase !== 'idle') return false
    const id = String(outTrackId ?? '').trim()
    if (!id.startsWith('eab_a2ui_')) return false
    const suffix = id.slice('eab_a2ui_'.length)
    if (!suffix) return false
    this.cardInstanceId = id
    this.surfaceId = `${A2UI_SURFACE_PREFIX}${suffix}`
    this.phase = 'active'
    const state = cloneRichState(initialState)
    this.lastSentState = null
    this.lastSentChars = 0
    this.lastUpdateAt = 0
    try {
      // 先回到处理中并清空上一轮的澄清数据，旧卡片按钮立即失效。
      await this.putUpdate(state, A2UI_STATUS.processing, true, null)
      this.lastSentState = state
      this.lastSentChars = richTextLength(state)
      this.lastUpdateAt = Date.now()
      this.updateFailures = 0
      console.info('[eab] 钉钉 A2UI 卡片已续用：', id)
      return true
    } catch (error) {
      this.phase = 'failed'
      this.logger.warn?.('[eab] 钉钉 A2UI 卡片续用失败：', (error as Error).message)
      return false
    }
  }

  /**
   * 题组翻页：只更新同一张卡的当前页，不触发模型。
   * 与 resume 不同，这里不要求客户端 phase=idle，因为卡片还在等待用户作答。
   */
  /**
   * 网页工作台已经作答时，把同一张澄清卡真正收口成完成态。
   * 不能复用 updateClarify：那条路径刻意保持 PROCESSING 以便继续翻页，
   * 用在“网页已答完”的场景会让钉钉卡片一直停在处理中。
   */
  async completeClarify(outTrackId: string, state: DingTalkRichCardState): Promise<boolean> {
    const id = String(outTrackId ?? '').trim()
    if (!id.startsWith('eab_a2ui_')) return false
    this.cardInstanceId = id
    this.surfaceId = `${A2UI_SURFACE_PREFIX}${id.slice('eab_a2ui_'.length)}`
    try {
      await this.putFinalStatus(cloneRichState(state), [A2UI_STATUS.finished])
      this.phase = 'finished'
      return true
    } catch (error) {
      this.logger.warn?.('[eab] 钉钉澄清卡片收口失败：', (error as Error).message)
      return false
    }
  }

  async updateClarify(outTrackId: string, state: DingTalkRichCardState): Promise<boolean> {
    const id = String(outTrackId ?? '').trim()
    if (!id.startsWith('eab_a2ui_')) return false
    this.cardInstanceId = id
    this.surfaceId = `${A2UI_SURFACE_PREFIX}${id.slice('eab_a2ui_'.length)}`
    try {
      await this.putUpdate(state, A2UI_STATUS.processing, true, null)
      return true
    } catch (error) {
      this.logger.warn?.('[eab] 钉钉题组翻页更新失败：', (error as Error).message)
      return false
    }
  }

  /**
   * 续用失败后尽力收口原卡。瞬时失败时旧卡还能从「处理中」拉回来；
   * 卡片确实失效时这次调用也会失败，调用方仍会新建卡，保证用户拿到回答。
   */
  async closeAfterResumeFailure(outTrackId: string, text: string): Promise<boolean> {
    const id = String(outTrackId ?? '').trim()
    if (!id.startsWith('eab_a2ui_')) return false
    if (this.phase === 'finished') return false
    this.cardInstanceId = id
    this.surfaceId = `${A2UI_SURFACE_PREFIX}${id.slice('eab_a2ui_'.length)}`
    this.phase = 'failed'
    try {
      return await this.fail(text)
    } catch (error) {
      this.logger.warn('[eab] 钉钉 A2UI 旧卡收口失败：', (error as Error).message)
      return false
    }
  }

  private schedule(): void {
    if (this.phase !== 'active' || this.worker || this.pendingState === null) return
    if (this.lastSentState && !richStateChanged(this.pendingState, this.lastSentState)) return
    if (this.scheduled) {
      clearTimeout(this.scheduled)
      this.scheduled = null
    }
    const now = Date.now()
    const elapsed = now - this.lastUpdateAt
    const newChars = richTextLength(this.pendingState) - this.lastSentChars
    const structureChanged = this.lastSentState
      ? richStructureChanged(this.pendingState, this.lastSentState)
      : true
    const enoughChars = newChars >= MIN_UPDATE_CHARS
    const waitedEnough = this.pendingSince > 0 && now - this.pendingSince >= MAX_UPDATE_WAIT_MS
    if (!enoughChars && !waitedEnough && !structureChanged) {
      const wait = Math.max(0, this.pendingSince + MAX_UPDATE_WAIT_MS - now)
      this.scheduled = setTimeout(() => {
        this.scheduled = null
        this.drain()
      }, wait)
      return
    }
    const delay = Math.max(0, UPDATE_INTERVAL_MS - elapsed)
    if (delay > 0) {
      this.scheduled = setTimeout(() => {
        this.scheduled = null
        this.drain()
      }, delay)
      return
    }
    this.drain()
  }

  private drain(): void {
    if (this.phase !== 'active' || this.worker || this.pendingState === null) return
    const state = this.pendingState
    this.pendingState = null
    this.pendingSince = 0
    this.worker = this.putUpdate(state, A2UI_STATUS.processing, true, this.lastSentState)
      .then((sent) => {
        if (!sent) return
        this.lastSentState = state
        this.lastSentChars = richTextLength(state)
        this.lastUpdateAt = Date.now()
        this.updateFailures = 0
      })
      .catch((error) => {
        if (this.phase !== 'active') return
        this.updateFailures += 1
        this.logger.warn?.(
          `[eab] 钉钉 A2UI 卡片更新失败（第 ${this.updateFailures} 次，保留卡片重试）：`,
          (error as Error).message,
        )
        // 瞬时网络错误不应让整张卡退出流式：把最新状态放回待发队列，
        // 由 finally 重新排期；连续失败 3 次才判死，且 finish 仍会尝试终态。
        if (this.updateFailures >= 3) {
          this.phase = 'failed'
          return
        }
        if (this.pendingState === null) this.pendingState = cloneRichState(state)
        // 失败也算一次发送窗口，避免 150ms 内立刻重试造成风暴。
        this.lastUpdateAt = Date.now()
      })
      .finally(() => {
        this.worker = null
        if (this.phase === 'active' && this.pendingState !== null) this.schedule()
      })
  }

  update(state: DingTalkRichCardState): void {
    if (this.phase !== 'active') return
    if (this.lastSentState && !richStateChanged(state, this.lastSentState)) return
    if (this.pendingState === null) this.pendingSince = Date.now()
    this.pendingState = cloneRichState(state)
    this.schedule()
  }

  async finish(finalState: DingTalkRichCardState, conversationSummary?: string): Promise<boolean> {
    if (this.phase === 'finished') return true
    if (this.phase === 'finishing') return this.finishPromise ?? false
    // 刷新连续失败后仍允许尝试终态：否则卡片会永久停在 PROCESSING，
    // 客户端表现就是“文字停在处理中不动”。
    if (!this.cardInstanceId || (this.phase !== 'active' && this.phase !== 'failed')) return false

    this.phase = 'finishing'
    this.updateFailures = 0
    this.pendingState = null
    if (this.scheduled) {
      clearTimeout(this.scheduled)
      this.scheduled = null
    }
    const summary = conversationSummary ? dingTalkConversationSummary(conversationSummary) : ''
    const active = this.worker
    this.finishPromise = (async () => {
      if (active) await active
      if (this.phase !== 'finishing') return false
      try {
        /**
         * 带澄清选项的卡片不能收口成 FINISH：用户点击后还要在同一张卡上继续。
         * 钉钉的已完成卡片不接受回退到 PROCESSING，真机上会表现为“原卡保留 +
         * 另发一条新卡”。这里保持和处理中一样的状态，只把 spinner 关掉并渲染选项，
         * 下一轮回调直接对同一个 outTrackId 继续 update。
         */
        if (finalState.clarify) {
          await this.putUpdate(cloneRichState(finalState), A2UI_STATUS.processing, false, null)
          rememberClarifyCard(this.cardInstanceId, finalState.clarify)
          if (summary) {
            try {
              await this.putLastMessage(summary)
            } catch (error) {
              this.logger.warn?.('[eab] 钉钉 A2UI 卡片更新外层摘要失败：', (error as Error).message)
            }
          }
          this.phase = 'finished'
          return true
        }
        await this.putFinalStatus(cloneRichState(finalState), [A2UI_STATUS.finished])
        rememberClarifyCard(this.cardInstanceId, finalState.clarify)
        // 外层摘要失败不能让已经收口的卡片回退成文字消息。
        if (summary) {
          try {
            await this.putLastMessage(summary)
          } catch (error) {
            this.logger.warn?.('[eab] 钉钉 A2UI 卡片更新外层摘要失败：', (error as Error).message)
          }
        }
        this.phase = 'finished'
        return true
      } catch (error) {
        this.phase = 'failed'
        this.logger.warn?.('[eab] 钉钉 A2UI 卡片收口失败：', (error as Error).message)
        return false
      }
    })()
    return this.finishPromise
  }

  async fail(text: string): Promise<boolean> {
    if (this.phase === 'finished' || !this.cardInstanceId || this.closing) return false
    this.phase = 'failed'
    this.closing = true
    this.pendingState = null
    if (this.scheduled) {
      clearTimeout(this.scheduled)
      this.scheduled = null
    }
    if (this.worker) await this.worker.catch(() => undefined)
    const results = await Promise.allSettled([
      this.putFinalStatus({ answer: text, reasoning: '', tools: [] }, [A2UI_STATUS.failed, 'ERROR']),
    ])
    this.closing = false
    return results.some((result) => result.status === 'fulfilled')
  }
}

/** 钉钉机器人给用户消息打表情标签；openMsgId 与 openConversationId 缺一不可。 */
const REACTION_NAME = {
  thinking: '🤔思考中',
  done: '✅已完成',
  error: '❌处理失败',
} as const
const REACTION_TEXT_ID = '2659900'
const REACTION_BACKGROUND_ID = 'im_bg_1'

export class DingTalkReaction {
  private started = false
  private phase: 'idle' | 'active' | 'finished' = 'idle'

  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly robotCode: string,
    private readonly openMsgId: string,
    private readonly openConversationId: string,
    private readonly logger: Pick<Console, 'warn'> = console,
  ) {}

  get available(): boolean {
    return Boolean(this.openMsgId && this.openConversationId)
  }

  private async send(action: 'reply' | 'recall', emotionName: string): Promise<boolean> {
    if (!this.available) return false
    try {
      const token = await dingTalkAccessToken(this.appId, this.appSecret)
      const body = await requestJson(`${DINGTALK_API}/v1.0/robot/emotion/${action}`, {
        method: 'POST',
        token,
        body: {
          robotCode: this.robotCode || this.appId,
          openMsgId: this.openMsgId,
          openConversationId: this.openConversationId,
          emotionType: 2,
          emotionName,
          textEmotion: {
            emotionId: REACTION_TEXT_ID,
            emotionName,
            text: emotionName,
            backgroundId: REACTION_BACKGROUND_ID,
          },
        },
      })
      if (body.success === false) return false
      if (body.errcode !== undefined && Number(body.errcode) !== 0) return false
      return true
    } catch (error) {
      this.logger.warn?.('[eab] 钉钉表情标签失败：', (error as Error).message)
      return false
    }
  }

  async start(): Promise<boolean> {
    if (this.phase !== 'idle') return false
    if (!this.available) {
      this.logger.warn?.('[eab] 钉钉表情标签跳过：缺少 openMsgId 或 openConversationId')
      return false
    }
    this.phase = 'active'
    this.started = await this.send('reply', REACTION_NAME.thinking)
    return this.started
  }

  async finish(ok: boolean): Promise<boolean> {
    if (this.phase === 'finished') return false
    if (this.phase === 'idle') return false
    this.phase = 'finished'
    // 与 dsh-im 一致：先撤回「思考中」，撤回失败重试一次；撤不干净时不叠加终态标签。
    let recalled = await this.send('recall', REACTION_NAME.thinking)
    if (!this.started || !recalled) {
      await sleep(1_000)
      recalled = (await this.send('recall', REACTION_NAME.thinking)) || recalled
    }
    if (!recalled) return false
    return this.send('reply', ok ? REACTION_NAME.done : REACTION_NAME.error)
  }
}
