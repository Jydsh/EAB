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
    tokenCache.set(appId, {
      token,
      expiresAt: Date.now() + Math.max(60_000, expiresInMs - TOKEN_REFRESH_MARGIN_MS),
    })
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
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized || normalized === '正在分析你的问题…') return ''
  return normalized.length > maxLength ? `…${normalized.slice(-maxLength)}` : normalized
}

function formatDuration(ms: number | undefined): string {
  if (!ms || ms < 0) return ''
  return ms < 1000 ? ` · ${Math.max(1, Math.round(ms))}ms` : ` · ${(ms / 1000).toFixed(1)}s`
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

function richToolsPreview(details: DingTalkToolRecord[], tools: string[]): string {
  const running = details.find((tool) => tool.status === 'running')
  if (running) return `${running.name} · 执行中`
  // 工具详情还没到时，至少把最近一个工具名显示出来，避免工具面板只有标题。
  const latest = details.at(-1)
  if (latest) return `${latest.name}${latest.status === 'error' ? ' · 失败' : ''}${formatDuration(latest.durationMs)}`
  const last = tools.at(-1)
  return last ? `${last} · 执行中` : ''
}

/** 工具一出现就说明思考阶段已经结束，标题不能继续停在“正在思考”。 */
function richHasTools(state: DingTalkRichCardState): boolean {
  return (state.tools ?? []).length > 0 || (state.toolDetails ?? []).length > 0
}

function richThinkingDone(state: DingTalkRichCardState): boolean {
  return Boolean(state.thinkingDone) || richHasTools(state)
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
  // 思考结束或工具出现后，思考标题固定为“已深度思考”，不再被工具行覆盖。
  const blocks: string[] = []
  const usedTools = progress.tools ?? []
  const detailNames = (progress.toolDetails ?? []).map((tool) => tool.name).filter(Boolean)
  const toolNames = usedTools.length > 0 ? usedTools : detailNames
  const toolActive = Boolean(progress.tool) || toolNames.length > 0
  const thinkingDone = Boolean(progress.thinkingDone) || toolActive
  blocks.push(thinkingDone ? '**✦ 已深度思考**' : '**✦ 正在思考…**')
  if (!thinkingDone) {
    const preview = previewLine(progress.reasoning, 90)
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

/**
 * A2UI 的 Markdown 没有原生流式光标，所以把钉钉客户端自带的 loading 素材
 * （安装目录 image_resource/taiji_loading.gif）缩到 14px，作为 Text 的前置图标
 * 放在正文同一个 Row 的末尾。14px 与正文行高一致，不再单独占一行。
 */
const A2UI_ANSWER_SPINNER_URL = 'https://aka.doubaocdn.com/s/8Q14U759NP'

export interface DingTalkCardAttachment {
  fileName: string
  url: string
  previewUrl?: string
  size?: number
  mimeType?: string
  description?: string
}

export interface DingTalkRichCardState {
  answer: string
  reasoning: string
  tools: string[]
  thinkingDone?: boolean
  toolDetails?: DingTalkToolRecord[]
  /** 钉盘落盘后由 File 组件展示；最多三个，避免卡片过重。 */
  attachments?: DingTalkCardAttachment[]
}

function cloneRichState(state: DingTalkRichCardState): DingTalkRichCardState {
  return {
    answer: String(state.answer ?? ''),
    reasoning: String(state.reasoning ?? ''),
    tools: (state.tools ?? []).filter((tool) => typeof tool === 'string' && tool.trim()).map((tool) => tool.trim()),
    thinkingDone: Boolean(state.thinkingDone),
    toolDetails: (state.toolDetails ?? []).map((tool) => ({
      ...tool,
      args: tool.args ? { ...tool.args } : undefined,
      summary: tool.summary ?? '',
      durationMs: tool.durationMs ?? 0,
    })),
    attachments: (state.attachments ?? []).slice(0, 3).map((attachment) => ({ ...attachment })),
  }
}

function richTextLength(state: DingTalkRichCardState): number {
  return String(state.answer ?? '').length + String(state.reasoning ?? '').length
}

function richStateChanged(current: DingTalkRichCardState, previous: DingTalkRichCardState): boolean {
  return (
    current.answer !== previous.answer ||
    current.reasoning !== previous.reasoning ||
    Boolean(current.thinkingDone) !== Boolean(previous.thinkingDone) ||
    (current.tools ?? []).length !== (previous.tools ?? []).length ||
    JSON.stringify(current.toolDetails ?? []) !== JSON.stringify(previous.toolDetails ?? []) ||
    JSON.stringify(current.attachments ?? []) !== JSON.stringify(previous.attachments ?? [])
  )
}

function richStructureChanged(current: DingTalkRichCardState, previous: DingTalkRichCardState): boolean {
  return (
    Boolean(current.thinkingDone) !== Boolean(previous.thinkingDone) ||
    (current.tools ?? []).length !== (previous.tools ?? []).length ||
    JSON.stringify(current.toolDetails ?? []) !== JSON.stringify(previous.toolDetails ?? [])
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
  thinking: { text: string; preview: string }
  tools: { text: string; preview: string }
  attachments: Array<{
    fileName: string
    url: string
    previewUrl: string
    size: number
    mimeType: string
    description: string
  }>
  thinkingDone: boolean
  ui: {
    showThinking: boolean
    showThinkingPreview: boolean
    showTools: boolean
    showToolsPreview: boolean
    showAnswerSpinner: boolean
    showAttachments: boolean
    showAttachment0: boolean
    showAttachment1: boolean
    showAttachment2: boolean
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

/** A2UI 组件树里预留的正文块数；绝大多数回答只有“正文 + 表格 + 收尾”三块。 */
const MAX_ANSWER_BLOCKS = 6

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
  if (indexColumn < 0 && nameColumn < 0 && table.meta.length <= 3) {
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

function richCardData(
  state: DingTalkRichCardState,
  active: boolean,
): DingTalkRichCardData {
  const reasoning = state.reasoning.trim()
  const tools = state.tools ?? []
  const details = state.toolDetails ?? []
  const hasTools = richHasTools(state)
  const thinkingDone = richThinkingDone(state)
  const answer = state.answer.trim()
  const answerBlocks = parseAnswerBlocks(answer)
  const attachments = (state.attachments ?? []).slice(0, 3).map((attachment) => ({
    fileName: String(attachment.fileName ?? ''),
    url: String(attachment.url ?? ''),
    previewUrl: String(attachment.previewUrl ?? attachment.url ?? ''),
    size: Number(attachment.size ?? 0),
    mimeType: String(attachment.mimeType ?? ''),
    description: String(attachment.description ?? '钉盘在线预览'),
  }))
  const answerUi: Record<string, boolean> = {}
  answerBlocks.forEach((block, blockIndex) => {
    const hasText = Boolean(block.text.trim())
    const hasTable = block.table.meta.length > 0
    answerUi[`showAnswerText${blockIndex}`] = hasText
    answerUi[`showAnswerTable${blockIndex}`] = hasTable
    answerUi[`showAnswerUnit${blockIndex}`] = hasText || hasTable
  })
  return {
    // 正文拆成文本段和原生表格段；表格由 Table 组件自己横滚，不改成竖排列表。
    answer: { blocks: answerBlocks },
    thinking: {
      text: flattenMarkdownTables(reasoning || (active && !hasTools ? '正在分析你的问题…' : '')),
      preview: active && !thinkingDone ? previewLine(reasoning) : '',
    },
    tools: {
      text: flattenMarkdownTables(richToolsMarkdown(details, tools)),
      preview: active && hasTools ? richToolsPreview(details, tools) : '',
    },
    attachments,
    thinkingDone,
    ui: {
      // 思考面板不因工具出现而隐藏：工具阶段仍保留“已深度思考”，
      // 工具面板在它下面单独占一行标题 + 一行当前工具信息。
      showThinking: Boolean(reasoning) || hasTools,
      showThinkingPreview: active && !thinkingDone && Boolean(previewLine(reasoning)),
      showTools: hasTools,
      showToolsPreview: active && hasTools && Boolean(richToolsPreview(details, tools)),
      showAnswerSpinner: active && Boolean(answer),
      showAttachments: attachments.length > 0,
      showAttachment0: attachments.length > 0,
      showAttachment1: attachments.length > 1,
      showAttachment2: attachments.length > 2,
      ...answerUi,
    },
  }
}

/**
 * 思考/工具用 CollapsiblePanel 收起，默认只占标题一行；正文 Markdown 放在最后。
 * 生命周期沿用 dsh-im 的单卡流式，但组件树换成官方 A2UI 的可折叠面板。
 */
function richCardComponents(active: boolean, thinkingDone = false): Array<Record<string, unknown>> {
  const thinkingTitle = thinkingDone ? '✦ 已深度思考' : '✦ 正在思考…'
  const toolTitle = active ? '🛠️ 工具调用中…' : '🛠️ 工具调用记录'
  return [
    {
      id: 'root',
      component: 'Card',
      child: 'rootColumn',
      // 交给钉钉按当前主题解析底色，避免写死白底在桌面端变成一块灰边白卡。
      backgroundColorToken: 'common_bg_color',
      padding: 16,
      cornerRadius: 12,
    },
    {
      id: 'rootColumn',
      component: 'Column',
      children: ['thinkingBlock', 'toolBlock', 'answerRow', 'attachmentBlock'],
      gap: 10,
    },
    {
      id: 'thinkingBlock',
      component: 'Column',
      children: ['thinkingPanel', 'thinkingPreview'],
      gap: 4,
      visible: { path: '/ui/showThinking' },
    },
    {
      id: 'thinkingPanel',
      component: 'CollapsiblePanel',
      title: thinkingTitle,
      variant: 'reasoning',
      defaultExpanded: false,
      visible: { path: '/ui/showThinking' },
      children: ['thinkingText'],
      fallbackMarkdown: '思考过程',
      ...(active && !thinkingDone ? { textEffect: 'shimmer' } : {}),
    },
    {
      id: 'thinkingText',
      component: 'Markdown',
      content: { path: '/thinking/text' },
    },
    {
      // CollapsiblePanel 收起时 children 不渲染，所以预览行必须是面板外的独立组件。
      // Markdown 没有 maxLine；用 Text + maxLine:1 在数据层截断成一行。
      id: 'thinkingPreview',
      component: 'Text',
      text: { path: '/thinking/preview' },
      maxLine: 1,
      visible: { path: '/ui/showThinkingPreview' },
    },
    {
      id: 'toolBlock',
      component: 'Column',
      children: ['toolPanel', 'toolsPreview'],
      gap: 4,
      visible: { path: '/ui/showTools' },
    },
    {
      id: 'toolPanel',
      component: 'CollapsiblePanel',
      title: toolTitle,
      defaultExpanded: false,
      visible: { path: '/ui/showTools' },
      children: ['toolText'],
      fallbackMarkdown: '工具调用记录',
    },
    {
      id: 'toolText',
      component: 'Markdown',
      content: { path: '/tools/text' },
    },
    {
      id: 'toolsPreview',
      component: 'Text',
      text: { path: '/tools/preview' },
      maxLine: 1,
      visible: { path: '/ui/showToolsPreview' },
    },
    {
      // 正文与圆环放在同一行：Row 底部对齐，圆环落在最后一行行末，
      // 不会被 Markdown 的块级图片规则顶到下一行。
      id: 'answerRow',
      component: 'Row',
      align: 'end',
      gap: 0,
      children: active ? ['answerBlocks', 'answerSpinner'] : ['answerBlocks'],
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
    ...(active
      ? [
          {
            id: 'answerSpinner',
            component: 'Text',
            // 一个空格保证 Text 有可见内容，前缀图标就是那枚 14px 原生 loading GIF。
            text: ' ',
            icon: { url: A2UI_ANSWER_SPINNER_URL },
            maxLine: 1,
            visible: { path: '/ui/showAnswerSpinner' },
          },
        ]
      : []),
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
        components: richCardComponents(true, richThinkingDone(state)),
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
  pushData('/tools/text', data.tools.text, previousData?.tools.text)
  pushData('/tools/preview', data.tools.preview, previousData?.tools.preview)
  if (!previousData || JSON.stringify(data.ui) !== JSON.stringify(previousData.ui)) {
    messages.push(a2uiMessage({ updateDataModel: { surfaceId, path: '/ui', value: data.ui } }))
  }
  if (!previousData || JSON.stringify(data.attachments) !== JSON.stringify(previousData.attachments)) {
    pushData('/attachments', data.attachments, previousData?.attachments)
  }

  // 思考结束 / 工具出现或结束时才重发面板组件；纯流式阶段只更新变化的数据，
  // 避免每帧都让客户端重建组件树。
  const shouldUpdateComponents = previous
    ? !active || richStructureChanged(state, previous)
    : !active || data.thinkingDone
  if (shouldUpdateComponents) {
    const terminal = richCardComponents(active, Boolean(data.thinkingDone))
    messages.push(
      a2uiMessage({
        updateComponents: {
          surfaceId,
          components: terminal.filter((component) =>
            ['thinkingPanel', 'toolPanel'].includes(String(component.id)),
          ),
        },
      }),
    )
  }
  return messages
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
    const token = await this.token()
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
    return true
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

  /** flowStatus 枚举名以接口实际校验为准；终态按候选名逐个尝试，避免把卡片停在处理中。 */
  private async putFinalStatus(
    state: DingTalkRichCardState,
    candidates: string[],
  ): Promise<void> {
    let lastError: unknown = null
    for (const status of candidates) {
      try {
        await this.putUpdate(state, status, false)
        return
      } catch (error) {
        lastError = error
        // 400 可能是 flowStatus 枚举名不被接受，也可能是消息参数错误；继续试下一个终态名，
        // 全部失败后仍会把真实错误抛给调用方，由上层回退为文字消息。
        if (!(error instanceof DingTalkHttpError) || error.status !== 400) throw error
      }
    }
    throw lastError instanceof Error ? lastError : new Error('A2UI 终态更新失败')
  }

  /** 先建卡并投放，首帧即带上折叠面板，避免先出现一条纯文字再补卡。 */
  async start(initialState: DingTalkRichCardState, conversationSummary?: string): Promise<boolean> {
    if (this.phase !== 'idle') return false
    if (Date.now() < a2uiDisabledUntil) {
      this.phase = 'failed'
      return false
    }
    try {
      const token = await this.token()
      const suffix = randomUUID().replace(/-/g, '')
      const outTrackId = `eab_a2ui_${suffix}`
      const surfaceId = `${A2UI_SURFACE_PREFIX}${suffix}`
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
      })
      .catch((error) => {
        if (this.phase !== 'active') return
        this.phase = 'failed'
        this.logger.warn?.('[eab] 钉钉 A2UI 卡片更新失败：', (error as Error).message)
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
    if (this.phase !== 'active') return false

    this.phase = 'finishing'
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
        await this.putFinalStatus(cloneRichState(finalState), [
          A2UI_STATUS.finished,
          'FINISHED',
          'COMPLETED',
          'DONE',
        ])
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
