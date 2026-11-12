/**
 * 钉钉机器人私聊 → EAB 对话。
 *
 * 两条入站通道共用这一份处理逻辑：
 * - Stream 长连接（本地/无公网部署的默认方式，EAB 主动连钉钉网关）；
 * - HTTP 事件回调（有公网域名时可选）。
 *
 * 关键约束：
 * 1. 回复与网页工作台写同一份 chat_sessions / chat_messages，所以两端历史天然同源；
 * 2. 不要求用户先输入姓名，组织问题交给 org.directory 工具从对话推断意图；
 * 3. 机器人可见文案统一用「EAB + 公司名」，不出现第三方项目名。
 */
import { randomUUID } from 'node:crypto'
import { SC, scopeAllows } from '@eab/domain'
import { appendAudit, type Db } from '@eab/storage'
import { consumeRobotUserFileSend } from './dingtalk-file-echo.js'
import { publishChatEvent, type ChatLiveToolEventPayload } from './chat-events.js'
import { findActivePerson, findPerson, actorFor, type RequestActor } from './session.js'
import type { ServerDeps } from './deps.js'
import { resolveSecret } from './secrets.js'
import type { ChatMessage as LlmMessage, LlmContent } from './llm.js'
import {
  acquireTurn,
  formatClarifyText,
  buildSystemPrompt,
  bumpUsage,
  ensureChannelSession,
  historyOf,
  loadModelCatalog,
  modelSupportsVision,
  releaseTurn,
  setChannelOpenConversationId,
  retrieveKb,
  runAgentTurn,
  visibleModelsFor,
  type AgentTurnResult,
} from './routes/chat.js'
import { toolSpecsForAgent } from './routes/tools.js'
import type { ActiveSpace } from './space.js'
import { saveUserWorkspaceFile } from './routes/workspace.js'
import { prepareDshImCompat, syncDshImSession } from './dsh-im-compat.js'
import { pluginPromptTexts } from './plugin-tools.js'
import { assertChatQuota } from './quota.js'
import { planChannelModelCommand } from './channel-model-command.js'
import {
  resolveUserWorkspaceQuota,
  workspaceCapacity,
  workspaceUsedBytes,
} from './workspace-quota.js'
import {
  DingTalkAICardStream,
  DingTalkCardStream,
  DingTalkReaction,
  dingTalkAccessToken,
  dingTalkConversationSummary,
  renderDingTalkFinalCard,
  renderDingTalkProgressCard,
  type DingTalkCardAttachment,
  type DingTalkRichCardState,
  type DingTalkToolRecord,
} from './dingtalk-card.js'

interface DingTalkChannelRow {
  app_id: string | null
  secret_ref: string | null
  robot_code: string | null
  robot_mode: string | null
  tenant_name: string | null
  status: string | null
  enabled: number | null
}

interface DingTalkRichTextItem {
  type?: string
  text?: string
  downloadCode?: string
  fileName?: string
}

interface DingTalkMessage {
  msgtype?: string
  text?: { content?: string }
  /** picture / richText 消息里携带的临时下载码，用它换钉钉临时下载链接 */
  content?: { downloadCode?: string; richText?: DingTalkRichTextItem[]; fileName?: string }
  senderStaffId?: string
  senderId?: string
  senderNick?: string
  sessionWebhook?: string
  robotCode?: string
  conversationType?: string
  conversationId?: string
  openConversationId?: string
  msgId?: string
  createAt?: number
}

interface DingTalkResult {
  readonly handled: boolean
  readonly text: string | null
  readonly sessionId: string | null
  readonly reason: string
}

function dingTalkConfig(db: Db, companyId: string): DingTalkChannelRow | null {
  const row = db
    .prepare(
      `SELECT app_id, secret_ref, robot_code, robot_mode, tenant_name, status, enabled
         FROM channel_configs
        WHERE company_id = ? AND provider = 'dingtalk'
        LIMIT 1`,
    )
    .get(companyId) as DingTalkChannelRow | undefined
  return row ?? null
}

function splitText(content: string, max = 4000): string[] {
  const text = content.trim()
  if (text.length <= max) return [text]
  const chunks: string[] = []
  for (let index = 0; index < text.length; index += max) chunks.push(text.slice(index, index + max))
  return chunks
}

const MAX_INBOUND_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_INBOUND_FILE_BYTES = 50 * 1024 * 1024

function imageMimeType(buffer: Buffer, contentType: string): string | null {
  const declared = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (declared.startsWith('image/')) return declared === 'image/jpg' ? 'image/jpeg' : declared
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png'
  }
  if (buffer.length >= 6 && buffer.subarray(0, 6).toString('ascii') === 'GIF87a') return 'image/gif'
  if (buffer.length >= 6 && buffer.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif'
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp'
  }
  return null
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

const MIME_BY_EXT: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

function mimeFromFileName(name: string): string | null {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return MIME_BY_EXT[ext] ?? null
}

/** 钉钉文件消息的 downloadCode 与图片共用同一套换取链接接口。 */
async function downloadDingTalkAttachment(
  deps: ServerDeps,
  cfg: DingTalkChannelRow,
  downloadCode: string,
  options: { maxBytes: number; label: string },
): Promise<{ buffer: Buffer; contentType: string }> {
  if (!cfg.app_id || !cfg.secret_ref) throw new Error('钉钉渠道凭证不完整')
  const secret = resolveSecret(deps.config.dbPath, cfg.secret_ref)
  if (!secret) throw new Error('钉钉 AppSecret 未配置或已失效')
  const robotCode = cfg.robot_code || cfg.app_id
  const token = await dingTalkAccessToken(cfg.app_id, secret)
  const response = await fetch('https://api.dingtalk.com/v1.0/robot/messageFiles/download', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-acs-dingtalk-access-token': token,
    },
    body: JSON.stringify({ downloadCode, robotCode }),
    signal: AbortSignal.timeout(20000),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`钉钉${options.label}下载码换取链接失败 HTTP ${response.status}：${body.slice(0, 160)}`)
  }
  const data = (await response.json().catch(() => null)) as { downloadUrl?: string } | null
  const downloadUrl = String(data?.downloadUrl ?? '').trim()
  if (!downloadUrl) throw new Error(`钉钉没有返回${options.label}下载链接`)

  const file = await fetch(downloadUrl, { signal: AbortSignal.timeout(30000) })
  if (!file.ok) throw new Error(`钉钉${options.label}下载失败 HTTP ${file.status}`)
  const length = Number(file.headers.get('content-length') ?? 0)
  if (length > options.maxBytes) throw new Error(`${options.label}超过 ${formatFileSize(options.maxBytes)}`)
  const buffer = Buffer.from(await file.arrayBuffer())
  if (buffer.length > options.maxBytes) throw new Error(`${options.label}超过 ${formatFileSize(options.maxBytes)}`)
  return { buffer, contentType: file.headers.get('content-type') ?? '' }
}

async function downloadDingTalkImage(deps: ServerDeps, cfg: DingTalkChannelRow, downloadCode: string): Promise<string> {
  const { buffer, contentType } = await downloadDingTalkAttachment(deps, cfg, downloadCode, {
    maxBytes: MAX_INBOUND_IMAGE_BYTES,
    label: '图片',
  })
  const mime = imageMimeType(buffer, contentType)
  if (!mime) throw new Error('钉钉返回的文件不是可识别的图片')
  return `data:${mime};base64,${buffer.toString('base64')}`
}

async function downloadDingTalkFile(
  deps: ServerDeps,
  cfg: DingTalkChannelRow,
  downloadCode: string,
  fileName: string,
): Promise<{ buffer: Buffer; mime: string; fileName: string }> {
  const { buffer, contentType } = await downloadDingTalkAttachment(deps, cfg, downloadCode, {
    maxBytes: MAX_INBOUND_FILE_BYTES,
    label: '文件',
  })
  const declared = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  const mime = declared && declared !== 'application/octet-stream' ? declared : mimeFromFileName(fileName) ?? 'application/octet-stream'
  return { buffer, mime, fileName }
}

function inboundImageCodes(payload: DingTalkMessage): string[] {
  const codes: string[] = []
  const push = (value: unknown) => {
    const code = String(value ?? '').trim()
    if (code && !codes.includes(code)) codes.push(code)
  }
  if (payload.msgtype === 'picture' || payload.msgtype === 'image') push(payload.content?.downloadCode)
  if (payload.msgtype === 'richText') {
    push(payload.content?.downloadCode)
    for (const item of payload.content?.richText ?? []) {
      if (item.type === 'picture') push(item.downloadCode)
    }
  }
  return codes
}

export function inboundFileAttachments(payload: DingTalkMessage): Array<{ downloadCode: string; fileName: string }> {
  const files: Array<{ downloadCode: string; fileName: string }> = []
  const push = (code: unknown, name: unknown) => {
    const downloadCode = String(code ?? '').trim()
    if (!downloadCode) return
    const rawName = String(name ?? '').trim()
    let fileName = rawName || '钉钉文件'
    try {
      fileName = decodeURIComponent(fileName)
    } catch {
      // 保持原样
    }
    if (!files.some((item) => item.downloadCode === downloadCode)) files.push({ downloadCode, fileName })
  }
  if (payload.msgtype === 'file') push(payload.content?.downloadCode, payload.content?.fileName)
  if (payload.msgtype === 'richText') {
    for (const item of payload.content?.richText ?? []) {
      if (item.type === 'file') push(item.downloadCode, item.fileName)
    }
  }
  return files
}

function inboundText(payload: DingTalkMessage): string {
  const direct = String(payload.text?.content ?? '').trim()
  if (direct) return direct
  if (payload.msgtype !== 'richText') return ''
  return (payload.content?.richText ?? [])
    .map((item) => String(item.text ?? '').trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

async function handleInboundFiles(
  deps: ServerDeps,
  actor: RequestActor,
  sessionId: string,
  cfg: DingTalkChannelRow,
  externalId: string,
  payload: DingTalkMessage,
  files: Array<{ downloadCode: string; fileName: string }>,
): Promise<DingTalkResult> {
  const saved: Array<{ name: string; relPath: string; size: number; mime: string | null; id: string }> = []
  const echoed: Array<{ name: string; size: number }> = []
  const failures: string[] = []
  const conversationId = String(payload.openConversationId ?? payload.conversationId ?? '')
  for (const attachment of files) {
    // 机器人以用户身份发出的文件会回流成 file 入站消息。命中一次性标记就跳过
    // 下载和保存，否则同一份文件会被重复写进个人云空间。
    const echo = consumeRobotUserFileSend(deps.db, {
      companyId: actor.subject.companyId,
      userId: actor.person.id,
      conversationId,
      fileName: attachment.fileName,
    })
    if (echo) {
      echoed.push({ name: echo.fileName, size: echo.sizeBytes })
      continue
    }
    try {
      const downloaded = await downloadDingTalkFile(deps, cfg, attachment.downloadCode, attachment.fileName)
      const stored = saveUserWorkspaceFile(deps, actor, {
        relPath: downloaded.fileName,
        buffer: downloaded.buffer,
        mime: downloaded.mime,
        channel: 'dingtalk',
        traceId: payload.msgId ?? null,
      })
      saved.push({ name: stored.name, relPath: stored.relPath, size: stored.size, mime: stored.mime, id: stored.id })
    } catch (error) {
      failures.push(`${attachment.fileName}：${error instanceof Error ? error.message : '保存失败'}`)
    }
  }

  if (saved.length === 0 && echoed.length === 0) {
    return {
      handled: false,
      text: `文件没有保存成功：${failures.join('；')}`,
      sessionId,
      reason: 'file-save-failed',
    }
  }

  const now = Date.now()
  const attachments = [
    ...saved.map((item) => ({
      name: item.name,
      size: item.size,
      mime: item.mime,
      workspaceFileId: item.id,
      relPath: item.relPath,
    })),
    ...echoed.map((item) => ({
      name: item.name,
      size: item.size,
      mime: null,
      robotUserFile: true,
    })),
  ]
  const userText = `[文件] ${attachments.map((item) => item.name).join('、')}`
  const userMessageId = `msg_${randomUUID()}`
  const userMeta = {
    channel: 'dingtalk',
    externalUserId: externalId,
    attachments,
  }
  deps.db
    .prepare(
      `INSERT INTO chat_messages (id, company_id, session_id, user_id, role, text, model_id, model_name, meta_json, created_at)
       VALUES (?, ?, ?, ?, 'user', ?, ?, ?, ?, ?)`,
    )
    .run(userMessageId, actor.subject.companyId, sessionId, actor.person.id, userText, null, '钉钉文件', JSON.stringify(userMeta), now)
  publishChatEvent({
    type: 'message',
    companyId: actor.subject.companyId,
    userId: actor.person.id,
    sessionId,
    message: {
      id: userMessageId,
      role: 'user',
      text: userText,
      meta: userMeta,
      createdAt: new Date(now).toISOString(),
    },
  })

  const lines = saved.map((item) => `• ${item.name}（${item.relPath}，${formatFileSize(item.size)}）`)
  const policy = resolveUserWorkspaceQuota(deps.db, actor.subject.companyId, actor.subject.userId)
  const capacity = workspaceCapacity(
    policy.limitBytes,
    workspaceUsedBytes(deps.db, actor.subject.companyId, 'user', actor.subject.userId),
  )
  const capacityWarning = capacity.level === 'normal' ? '' : `容量提醒：${capacity.message}`
  const assistantText =
    saved.length === 0
      ? '你要的文件已发送'
      : [
          echoed.length > 0 ? '你要的文件已发送' : '',
          '文件已保存到你的个人云空间：',
          ...lines,
          failures.length > 0 ? `另有未保存：${failures.join('；')}` : '',
          '你想让我对这个文件做什么？比如：总结要点、提取表格、改写格式、找出问题。',
          capacityWarning,
        ]
          .filter(Boolean)
          .join('\n')
  const assistantMessageId = `msg_${randomUUID()}`
  const assistantMeta = {
    channel: 'dingtalk',
    externalUserId: externalId,
    attachments,
    fileQuestion: saved.length > 0,
  }
  const assistantAt = now + 1
  deps.db
    .prepare(
      `INSERT INTO chat_messages (id, company_id, session_id, user_id, role, text, model_id, model_name, meta_json, created_at)
       VALUES (?, ?, ?, ?, 'assistant', ?, ?, ?, ?, ?)`,
    )
    .run(
      assistantMessageId,
      actor.subject.companyId,
      sessionId,
      actor.person.id,
      assistantText,
      null,
      'EAB',
      JSON.stringify(assistantMeta),
      assistantAt,
    )
  publishChatEvent({
    type: 'message',
    companyId: actor.subject.companyId,
    userId: actor.person.id,
    sessionId,
    message: {
      id: assistantMessageId,
      role: 'assistant',
      text: assistantText,
      meta: assistantMeta,
      createdAt: new Date(assistantAt).toISOString(),
    },
  })
  deps.db
    .prepare('UPDATE chat_sessions SET updated_at = ?, last_message_at = ? WHERE id = ?')
    .run(assistantAt, assistantAt, sessionId)
  appendAudit(deps.db, {
    companyId: actor.subject.companyId,
    actorUserId: actor.person.id,
    action: 'chat.message',
    resourceType: 'chat_session',
    resourceId: sessionId,
    resourceScope: 'dingtalk',
    result: 'success',
    detail: {
      fileCount: saved.length,
      echoCount: echoed.length,
      files: saved.map((item) => ({ id: item.id, relPath: item.relPath, size: item.size })),
      channel: 'dingtalk',
    },
    traceId: payload.msgId ?? null,
    ip: null,
    channel: 'dingtalk',
  })
  return {
    handled: true,
    text: assistantText,
    sessionId,
    reason: saved.length === 0 && echoed.length > 0 ? 'file-echo' : 'file-saved',
  }
}

function pendingFileNote(deps: ServerDeps, sessionId: string): string {
  const row = deps.db
    .prepare(
      `SELECT role, meta_json FROM chat_messages
        WHERE session_id = ?
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .get(sessionId) as { role: string; meta_json: string | null } | undefined
  if (!row || row.role !== 'assistant' || !row.meta_json) return ''
  try {
    const meta = JSON.parse(row.meta_json) as {
      fileQuestion?: boolean
      attachments?: Array<{ name?: string; relPath?: string }>
    }
    if (!meta.fileQuestion) return ''
    const files = (meta.attachments ?? [])
      .map((item) => {
        const relPath = String(item.relPath ?? '').trim()
        if (!relPath) return ''
        return `${relPath}${item.name ? `（${item.name}）` : ''}`
      })
      .filter(Boolean)
    if (files.length === 0) return ''
    return `补充：用户上一轮上传的文件已保存在个人云空间，相对路径为 ${files.join('、')}。本轮如果要处理文件，请调用 workspace.read 读取这些路径，不要编造文件内容。`
  } catch {
    return ''
  }
}

/** sessionWebhook 回复（HTTP 回调/Stream 消息都带这个地址）。 */
export async function replySessionWebhook(deps: ServerDeps, webhook: string, text: string): Promise<void> {
  const cfg = dingTalkConfig(deps.db, deps.companyId)
  if (!cfg?.app_id || !cfg.secret_ref) throw new Error('钉钉渠道凭证不完整，无法回复')
  const secret = resolveSecret(deps.config.dbPath, cfg.secret_ref)
  if (!secret) throw new Error('钉钉 AppSecret 未配置或已失效')
  const token = await dingTalkAccessToken(cfg.app_id, secret)
  for (const chunk of splitText(text)) {
    const response = await fetch(webhook, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-acs-dingtalk-access-token': token,
      },
      body: JSON.stringify({ msgtype: 'text', text: { content: chunk } }),
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`钉钉会话回复失败 HTTP ${response.status}：${body.slice(0, 200)}`)
    }
  }
}

/** 主动发单聊消息（仅用于欢迎语等平台通知；网页对话不回写钉钉）。 */
export async function notifyDingTalkUser(
  deps: ServerDeps,
  userId: string,
  text: string,
  options: { reasoning?: string; tools?: string[] } = {},
): Promise<void> {
  const cfg = dingTalkConfig(deps.db, deps.companyId)
  if (!cfg?.app_id || !cfg.secret_ref) throw new Error('钉钉渠道未绑定')
  const secret = resolveSecret(deps.config.dbPath, cfg.secret_ref)
  if (!secret) throw new Error('钉钉 AppSecret 未配置或已失效')
  const robotCode = cfg.robot_code || cfg.app_id

  // 欢迎语等平台通知如果带思考/工具轨迹，也把内容收成 AI 卡片。
  // 优先 A2UI 折叠面板，权限未开通时回退旧模板；两块都失败再走普通文本。
  if (options.reasoning || options.tools?.length) {
    const richState: DingTalkRichCardState = {
      answer: text,
      reasoning: options.reasoning ?? '',
      tools: options.tools ?? [],
    }
    const richCard = new DingTalkAICardStream(cfg.app_id, secret, userId, robotCode)
    const summary = dingTalkConversationSummary(text)
    if (await richCard.start(richState, summary)) {
      if (await richCard.finish(richState, text)) return
      await richCard.fail('卡片已结束，完整回答见下一条消息。')
    }
    const card = new DingTalkCardStream(cfg.app_id, secret, userId, robotCode)
    if (await card.start('**EAB 正在回复…**\n\n> 已收到一条平台通知。', summary)) {
      const finished = await card.finish(
        renderDingTalkFinalCard(text, options.reasoning ?? '', options.tools ?? []),
        text,
      )
      if (finished) return
      await card.fail('卡片已结束，完整回答见下一条消息。')
    }
  }

  const token = await dingTalkAccessToken(cfg.app_id, secret)
  for (const chunk of splitText(text)) {
    const response = await fetch('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-acs-dingtalk-access-token': token,
      },
      body: JSON.stringify({
        robotCode,
        userIds: [userId],
        msgKey: 'sampleText',
        msgParam: JSON.stringify({ content: chunk }),
      }),
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`钉钉主动消息失败 HTTP ${response.status}：${body.slice(0, 200)}`)
    }
  }
}

/** 绑定成功后不发送 EAB 自建欢迎语，使用钉钉平台原生欢迎语。 */

function resolveDingTalkUser(db: Db, companyId: string, externalId: string): string | null {
  const channel = db
    .prepare(
      `SELECT user_id FROM channel_identities
        WHERE provider = 'dingtalk' AND external_id = ? AND revoked_at IS NULL
        LIMIT 1`,
    )
    .get(externalId) as { user_id: string } | undefined
  if (channel?.user_id) return channel.user_id

  // 老数据：组织同步只写了 user_identities，没有 channel_identities。这里补桥接，不要求用户重新绑定。
  const identity = db
    .prepare(
      `SELECT user_id FROM user_identities
        WHERE provider = 'dingtalk' AND external_user_id = ? AND status <> 'revoked'
        LIMIT 1`,
    )
    .get(externalId) as { user_id: string } | undefined
  if (!identity?.user_id) return null
  db.prepare(
    `INSERT OR IGNORE INTO channel_identities (id, company_id, provider, external_id, user_id, created_at)
     VALUES (?, ?, 'dingtalk', ?, ?, ?)`,
  ).run(`ci_${randomUUID()}`, companyId, externalId, identity.user_id, Date.now())
  return identity.user_id
}

const rateBuckets = new Map<string, { window: number; count: number }>()

function rateLimited(externalId: string): boolean {
  const now = Date.now()
  const bucket = rateBuckets.get(externalId)
  if (!bucket || now - bucket.window >= 60_000) {
    rateBuckets.set(externalId, { window: now, count: 1 })
    return false
  }
  bucket.count += 1
  return bucket.count > 20
}

/**
 * 处理一条钉钉私聊消息。
 * `dedupe=true` 时由本函数自己写 channel_events；HTTP 路由已去重时传 false。
 */
export async function handleDingTalkMessage(
  deps: ServerDeps,
  payload: DingTalkMessage,
  options: { dedupe?: boolean } = {},
): Promise<DingTalkResult> {
  const externalId = String(payload.senderStaffId ?? payload.senderId ?? '').trim()
  const rawText = inboundText(payload)
  const imageCodes = inboundImageCodes(payload)
  const fileAttachments = inboundFileAttachments(payload)
  if (!externalId) return { handled: false, text: null, sessionId: null, reason: 'missing-sender' }
  if (!rawText && imageCodes.length === 0 && fileAttachments.length === 0) {
    return {
      handled: false,
      text: 'EAB 目前支持文字、图片和文件：可以直接问我制度、部门、组长或工作资料，也可以发图片让我读取内容，或发文件到个人云空间。发送 /model 可以查看并切换你有权限使用的模型，发送 /auto 恢复自动选择。',
      sessionId: null,
      reason: 'empty-text',
    }
  }
  if (rateLimited(externalId)) {
    return { handled: false, text: '消息有点频繁，请 1 分钟后再发。', sessionId: null, reason: 'rate-limited' }
  }

  const eventKey =
    String(payload.msgId ?? '').trim() ||
    `${externalId}:${payload.createAt ?? ''}:${rawText.slice(0, 40) || imageCodes[0]?.slice(0, 40) || fileAttachments[0]?.fileName.slice(0, 40) || payload.msgtype || ''}`
  if (options.dedupe !== false) {
    const inserted = deps.db
      .prepare(
        `INSERT INTO channel_events (id, company_id, provider, event_key, sender_id, received_at)
         VALUES (?, ?, 'dingtalk', ?, ?, ?)
         ON CONFLICT (provider, event_key) DO NOTHING`,
      )
      .run(`evt_${randomUUID()}`, deps.companyId, eventKey, externalId, Date.now())
    if (Number(inserted.changes) === 0) {
      return { handled: false, text: null, sessionId: null, reason: 'duplicate' }
    }
  }

  const cfg = dingTalkConfig(deps.db, deps.companyId)
  if (!cfg?.app_id || cfg.status !== 'bound') {
    return {
      handled: false,
      text: 'EAB 还没有连接企业。请管理员先到 EAB 管理控制台「连接与平台 → 渠道」完成钉钉机器人绑定。',
      sessionId: null,
      reason: 'channel-unbound',
    }
  }

  const userId = resolveDingTalkUser(deps.db, deps.companyId, externalId)
  if (!userId) {
    return {
      handled: false,
      text: '这个钉钉账号还没有对应到 EAB 成员。请管理员先同步企业通讯录，或到 EAB 控制台「渠道 → 外部账号绑定」完成身份绑定。',
      sessionId: null,
      reason: 'identity-unbound',
    }
  }
  const person = findActivePerson(deps.db, userId)
  if (!person) {
    if (findPerson(deps.db, userId)) {
      return {
        handled: false,
        text: '这个钉钉账号对应的 EAB 成员已离职或已停用，不能继续使用平台。如需恢复，请联系管理员在控制台确认成员状态。',
        sessionId: null,
        reason: 'member-disabled',
      }
    }
    return {
      handled: false,
      text: '这个钉钉账号不属于当前 EAB 实例的唯一公司，暂时不能对话。',
      sessionId: null,
      reason: 'company-mismatch',
    }
  }
  if (person.companyId !== deps.companyId) {
    return {
      handled: false,
      text: '这个钉钉账号不属于当前 EAB 实例的唯一公司，暂时不能对话。',
      sessionId: null,
      reason: 'company-mismatch',
    }
  }
  const actor: RequestActor = actorFor(deps.db, person)
  if (!scopeAllows(actor.subject.scopes, SC.CHAT_USE)) {
    return { handled: false, text: '当前身份没有对话权限（chat:use）。', sessionId: null, reason: 'scope-denied' }
  }
  if (!scopeAllows(actor.subject.scopes, SC.MODEL_USE)) {
    return { handled: false, text: '当前身份没有使用模型的权限（model:use）。', sessionId: null, reason: 'scope-denied' }
  }
  const catalog = loadModelCatalog(
    deps.db,
    actor.subject.companyId,
    deps.config.devAuth,
    actor.subject.userId,
  )
  const available = visibleModelsFor(catalog, [...actor.subject.roles], actor.subject.companyId)

  /**
   * 渠道里的模型切换必须先于额度校验：它不调用模型，也不消耗额度。
   * 命令只匹配 available（已按当前员工角色过滤），不会探测未授权模型。
   * 先用 null 当前模型做一次纯解析，只有命中命令才建/取会话，普通消息不提前落会话。
   */
  const commandPreview =
    imageCodes.length === 0 && fileAttachments.length === 0
      ? planChannelModelCommand(rawText, available, null)
      : null
  if (commandPreview) {
    const commandSessionId = ensureChannelSession(
      deps.db,
      actor,
      'dingtalk',
      externalId,
      rawText || '模型切换',
    )
    const storedModelId =
      (deps.db
        .prepare('SELECT model_id FROM chat_sessions WHERE id = ? AND deleted_at IS NULL')
        .get(commandSessionId) as { model_id: string | null } | undefined)?.model_id ?? null
    const currentModelId =
      storedModelId && available.some((item) => item.id === storedModelId) ? storedModelId : null
    if (storedModelId && !currentModelId) {
      // 旧模型下线或角色被收回时先清空，命令列表不能把无权模型 ID 展示出来。
      deps.db.prepare('UPDATE chat_sessions SET model_id = NULL, updated_at = ? WHERE id = ?').run(Date.now(), commandSessionId)
    }
    const modelCommand = planChannelModelCommand(rawText, available, currentModelId)
    if (modelCommand) {
      if (modelCommand.modelId !== undefined) {
        deps.db
          .prepare('UPDATE chat_sessions SET model_id = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
          .run(modelCommand.modelId, Date.now(), commandSessionId)
      }
      return {
        handled: true,
        text: modelCommand.text,
        sessionId: commandSessionId,
        reason: 'model-command',
      }
    }
  }

  /**
   * 渠道侧与网页共用同一份月度额度：钉钉机器人不走 /api/chat/messages，
   * 所以这里必须单独挡一次，否则"网页被拦、钉钉照用"会变成绕过口。
   */
  try {
    assertChatQuota(deps.db, {
      companyId: actor.subject.companyId,
      userId: actor.person.id,
      deptId: actor.subject.deptId,
      deptPath: actor.subject.deptPath,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : '本月对话额度已用完'
    return {
      handled: false,
      text: `${message}。管理员可在 EAB 控制台「运营与审计 → 额度」里调整上限。`,
      sessionId: null,
      reason: 'quota-exceeded',
    }
  }

  let imageUrls: string[] = []
  if (imageCodes.length > 0) {
    try {
      imageUrls = await Promise.all(imageCodes.map((code) => downloadDingTalkImage(deps, cfg, code)))
    } catch (error) {
      console.warn('[eab] 钉钉图片下载失败：', (error as Error)?.message ?? error)
      return {
        handled: false,
        text: '图片没有下载成功，请重新发送图片，或者先把图片里的关键内容用文字发给我。',
        sessionId: null,
        reason: 'image-download-failed',
      }
    }
  }
  const fileTitle = fileAttachments.length > 0 ? `[文件] ${fileAttachments.map((item) => item.fileName).join('、')}` : ''
  const promptText = rawText || fileTitle || '请查看这张图片，告诉我图片里有哪些关键信息。'
  const displayText = imageUrls.length > 0
    ? rawText ? `[图片] ${rawText}` : '[图片] 请识别图片内容'
    : rawText || fileTitle

  const sessionId = ensureChannelSession(deps.db, actor, 'dingtalk', externalId, promptText)
  // 入站 payload 的 conversationId 就是该员工与机器人单聊的 openConversationId；
  // 后续出站文件要靠它发回机器人会话，而不是应用「工作通知」。
  const openConversationId = String(payload.conversationId || payload.openConversationId || '').trim()
  if (openConversationId) setChannelOpenConversationId(deps.db, sessionId, openConversationId)
  const fileNote = fileAttachments.length > 0 ? '' : pendingFileNote(deps, sessionId)
  // 把这次会话写进 dsh-im 兼容协议，钉卡片插件才能按 sessionId 找到发卡对象
  try {
    prepareDshImCompat(deps.db, {
      dbPath: deps.config.dbPath,
      dshHomeDir: deps.config.dshHomeDir,
      companyId: deps.companyId,
    })
    syncDshImSession(deps.db, externalId, sessionId)
  } catch (error) {
    console.warn('[eab] dsh-im 兼容文件写入失败：', (error as Error)?.message ?? error)
  }
  const turnToken = await acquireTurn(sessionId)
  const started = Date.now()
  let card: DingTalkAICardStream | null = null
  let legacyCard: DingTalkCardStream | null = null
  let reaction: DingTalkReaction | null = null
  let reactionOk = false
  try {
    if (fileAttachments.length > 0) {
      return await handleInboundFiles(deps, actor, sessionId, cfg, externalId, payload, fileAttachments)
    }

    const firstMessage =
      Number(
        (
          deps.db.prepare('SELECT COUNT(*) AS count FROM chat_messages WHERE session_id = ?').get(sessionId) as {
            count: number
          }
        ).count,
      ) === 0

    let modelFallbackNote = ''
    const sessionModelId =
      (deps.db
        .prepare('SELECT model_id FROM chat_sessions WHERE id = ? AND deleted_at IS NULL')
        .get(sessionId) as { model_id: string | null } | undefined)?.model_id ?? null
    const preferredModel = sessionModelId ? available.find((item) => item.id === sessionModelId) : undefined
    if (sessionModelId && !preferredModel) {
      // 会话里保存的模型下线或当前角色无权后再回退自动，避免每轮继续拿旧 ID。
      deps.db.prepare('UPDATE chat_sessions SET model_id = NULL, updated_at = ? WHERE id = ?').run(Date.now(), sessionId)
      modelFallbackNote = '原会话模型已不可用，已切回自动选择。\n\n'
    }
    if (imageUrls.length > 0 && preferredModel && !modelSupportsVision(preferredModel.tags, preferredModel.capabilities)) {
      return {
        handled: false,
        text: `当前会话模型「${preferredModel.name}」没有开启图片识别能力。请发送 /model 切换到一个支持图片的模型后再发图片。`,
        sessionId,
        reason: 'model-not-vision',
      }
    }
    const autoModel = imageUrls.length > 0
      ? available.find((item) => modelSupportsVision(item.tags, item.capabilities)) ?? available[0]
      : available[0]
    const model = preferredModel ?? autoModel
    if (!model) {
      return {
        handled: false,
        text: `${modelFallbackNote}EAB 当前还没有可用模型。请管理员到「模型接入」启用一个模型后再试。`,
        sessionId,
        reason: 'no-model',
      }
    }
    if (imageUrls.length > 0 && !modelSupportsVision(model.tags, model.capabilities)) {
      return {
        handled: false,
        text: '当前可用模型都没有开启图片识别能力。请管理员到 EAB 控制台「模型接入」给一个模型勾选「图片识别 / 多模态」后再发图片。',
        sessionId,
        reason: 'no-vision-model',
      }
    }

    // 先投递一张「正在思考」的 AI 卡片，后续 reasoning/content/tool 事件都在这张卡片里流式刷新。
    // 优先用 A2UI 折叠面板（思考/工具收起、正文最后）；权限未开通时自动回退旧模板卡片。
    // 只对私聊用 IM_ROBOT 卡片；群聊仍走 sessionWebhook 文字，避免把回答私发给提问人而群里看不到。
    const isPrivateChat = String(payload.conversationType ?? '1') === '1'
    const channelSecret = cfg.secret_ref ? resolveSecret(deps.config.dbPath, cfg.secret_ref) : null
    const robotCode = cfg.robot_code || cfg.app_id
    const initialRichState: DingTalkRichCardState = {
      answer: '',
      reasoning: imageUrls.length > 0 ? '正在读取图片内容…' : '正在分析你的问题…',
      tools: [],
      thinkingDone: false,
      toolDetails: [],
    }
    // 建卡时回答还没生成，外层摘要先放中性品牌文案；
    // 收口时再把外层摘要替换成回复正文（A2UI 卡片走场域信息更新，旧模板走 sys_lastMessageI18n）。
    const conversationSummary = 'EAB 企业智能助手'
    if (isPrivateChat && channelSecret) {
      // 私聊优先用 A2UI 卡：保留思考/工具折叠面板。
      // 正文末尾的原生转圈由 richCardData() 拼入钉钉客户端自带 loading 素材，
      // 旧模板卡仅作为 A2UI 建卡失败时的降级方案。
      card = new DingTalkAICardStream(cfg.app_id, channelSecret, externalId, robotCode)
      if (!(await card.start(initialRichState, conversationSummary))) {
        card = null
        legacyCard = new DingTalkCardStream(cfg.app_id, channelSecret, externalId, robotCode)
        if (
          !(await legacyCard.start(
            imageUrls.length > 0
              ? '**EAB 正在读取图片…**\n\n> 已收到你的图片，正在识别。'
              : '**EAB 正在思考…**\n\n> 已收到你的问题，正在分析。',
            conversationSummary,
          ))
        ) {
          legacyCard = null
        }
      } else {
        console.info('[eab] 钉钉私聊回复使用 A2UI 折叠面板，正文末尾拼钉钉原生 loading 素材')
      }
    }

    // 给用户那条消息打「思考中」标签；完成/失败后替换成「已完成 / 处理失败」。
    reaction = new DingTalkReaction(
      cfg.app_id,
      channelSecret ?? '',
      robotCode,
      String(payload.msgId ?? ''),
      String(payload.conversationId || payload.openConversationId || ''),
    )
    void reaction.start()

    const hits = await retrieveKb(deps.db, deps.config.dbPath, actor, rawText)
    const memories = deps.db
      .prepare(
        `SELECT content FROM memories
          WHERE company_id = ? AND deleted_at IS NULL AND confirmed = 1
            AND ((scope_type = 'user' AND scope_id = ?)
              OR (scope_type = 'dept' AND scope_id = ?)
              OR (scope_type = 'company' AND scope_id = ?))
          ORDER BY created_at DESC LIMIT 8`,
      )
      .all(actor.subject.companyId, actor.person.id, actor.subject.deptId, actor.subject.companyId) as unknown as Array<{
      content: string
    }>
    // A2UI 卡能展示钉盘 File 组件；建卡失败时退回 sampleFile 文件消息。
    const toolSpace: ActiveSpace = { kind: 'cloud', channel: card ? 'dingtalk-a2ui' : 'dingtalk-file' }
    const chatTools = toolSpecsForAgent(deps.db, actor, toolSpace, promptText)
    const pluginPrompts = pluginPromptTexts(deps.db, actor)
    const system = buildSystemPrompt({
      actor,
      chatTools,
      memories,
      hits,
      hasAttachments: imageUrls.length > 0,
      pluginPrompts,
    })
    const imageSystemNote =
      imageUrls.length > 0
        ? '本条消息包含真实图片附件，请直接读取图片内容后回答。历史对话里如果出现过“不支持图片/只支持文字提问”的说法，那是旧版本能力限制，已经过时，不要再沿用。'
        : ''
    const fileSendSystemNote =
      '当前版本已经支持把个人云空间文件作为钉钉文件消息发给用户，也支持重命名和删除云空间文件：用户要求发文件时，先调用 workspace_list 找到文件名或相对路径，再调用 workspace_send_dingtalk（参数 path 或 fileId）；用户要求改名时，调用 workspace_rename（参数 path 或 fileId，以及 newName）；用户明确要求删除某个文件时，调用 workspace_delete（参数 path 或 fileId，只能删当前员工自己的文件，软删到回收目录）。在钉钉单聊里，发文件会优先用“用户方向”的原生文件消息：文件气泡出现在用户与机器人的单聊右侧、显示为用户发出，这是机器人代发；机器人能识别自己代发的文件，不会把它再存进个人云空间，只会补一句“你要的文件已发送”。不要声称文件一定是机器人头像发出，也不要声称一定能在钉钉内预览或在线编辑。不要把文件正文当成附件发送，也不要沿用历史里“没有发送文件附件的通道/没有重命名功能/没有删除文件的工具”的旧说法。'
    const systemContent = `${system}\n\n${[imageSystemNote, fileSendSystemNote].filter(Boolean).join('\n\n')}`
    const modelPromptText = fileNote ? `${promptText}\n\n${fileNote}` : promptText
    const userContent: LlmContent =
      imageUrls.length > 0
        ? [
            { type: 'text', text: modelPromptText },
            ...imageUrls.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
          ]
        : modelPromptText
    const messages: LlmMessage[] = [
      { role: 'system', content: systemContent },
      ...historyOf(deps.db, sessionId, 16, 'dingtalk'),
      { role: 'user', content: userContent },
    ]

    const now = Date.now()
    const userMessageId = `msg_${randomUUID()}`
    const userMessageMeta = {
      channel: 'dingtalk',
      externalUserId: externalId,
      hasImage: imageUrls.length > 0,
      imageCount: imageUrls.length,
    }
    deps.db
      .prepare(
        `INSERT INTO chat_messages (id, company_id, session_id, user_id, role, text, model_id, model_name, meta_json, created_at)
         VALUES (?, ?, ?, ?, 'user', ?, ?, ?, ?, ?)`,
      )
      .run(
        userMessageId,
        actor.subject.companyId,
        sessionId,
        actor.person.id,
        displayText,
        model.id,
        model.name,
        JSON.stringify(userMessageMeta),
        now,
      )
    publishChatEvent({
      type: 'message',
      companyId: actor.subject.companyId,
      userId: actor.person.id,
      sessionId,
      message: {
        id: userMessageId,
        role: 'user',
        text: displayText,
        modelId: model.id,
        modelName: model.name,
        meta: userMessageMeta,
        createdAt: new Date(now).toISOString(),
      },
    })

    let agentText = ''
    let agentResult: AgentTurnResult | null = null
    let toolCallCount = 0
    let rounds = 0
    let promptTokens = 0
    let completionTokens = 0
    let effectiveModel = model
    let failoverNote = ''
    const assistantMessageId = `msg_${randomUUID()}`
    const publishDelta = (kind: 'reasoning' | 'content', text: string) => {
      if (!text) return
      publishChatEvent({
        type: 'delta',
        companyId: actor.subject.companyId,
        userId: actor.person.id,
        sessionId,
        messageId: assistantMessageId,
        kind,
        text,
        modelId: effectiveModel.id,
        modelName: effectiveModel.name,
      })
    }
    const publishTool = (tool: ChatLiveToolEventPayload) => {
      publishChatEvent({
        type: 'tool',
        companyId: actor.subject.companyId,
        userId: actor.person.id,
        sessionId,
        messageId: assistantMessageId,
        tool,
      })
    }
    const cardState = { answer: '', reasoning: '', tool: '' }
    const cardAttachments: DingTalkCardAttachment[] = []
    const toolsUsed: string[] = []
    const toolDetails: DingTalkToolRecord[] = []
    let thinkingDone = false
    const pushCard = () => {
      if (card) {
        card.update({
          answer: cardState.answer,
          reasoning: cardState.reasoning,
          tools: toolsUsed,
          thinkingDone,
          toolDetails,
          attachments: cardAttachments,
        })
      } else if (legacyCard) {
        legacyCard.update(
          renderDingTalkProgressCard({
            ...cardState,
            tools: toolsUsed,
            thinkingDone,
            toolDetails,
          }),
        )
      }
    }
    try {
      agentResult = await runAgentTurn({
        deps,
        actor,
        modelId: model.id,
        fallbackModelIds: available
          .filter((item) => item.id !== model.id && (imageUrls.length === 0 || modelSupportsVision(item.tags, item.capabilities)))
          .map((item) => item.id),
        bufferModelEvents: true,
        onModelFailover: (change) => {
          const next = available.find((item) => item.id === change.toModelId)
          if (next) effectiveModel = next
          failoverNote = `当前模型「${change.fromModelName}」暂时不可用，已自动切换到「${change.toModelName}」。\n\n`
        },
        messages,
        sessionId,
        space: toolSpace,
        emit: (event) => {
          if (event.type === 'reasoning') {
            cardState.reasoning += event.text
            pushCard()
            publishDelta('reasoning', event.text)
          } else if (event.type === 'content') {
            // 正文开始即代表思考阶段结束：预览行隐藏、标题切成“已深度思考”。
            thinkingDone = true
            cardState.answer += event.text
            pushCard()
            publishDelta('content', event.text)
          } else if (event.type === 'tool') {
            // 一旦真的调用工具，思考阶段同样结束；思考面板让位给工具面板。
            thinkingDone = true
            cardState.tool = `正在使用「${event.name}」…`
            if (!toolsUsed.includes(event.name)) toolsUsed.push(event.name)
            toolDetails.push({
              id: event.id,
              name: event.name,
              toolId: event.toolId,
              args: event.args,
              status: 'running',
              summary: '',
              durationMs: 0,
            })
            pushCard()
            publishTool({ type: 'tool', id: event.id, name: event.name, toolId: event.toolId, args: event.args })
          } else if (event.type === 'tool_result') {
            const record = toolDetails.find((tool) => tool.id === event.id)
            if (record) {
              record.status = event.status
              record.summary = event.summary
              record.durationMs = event.durationMs
              if (record.toolId === 'workspace.send_dingtalk' && event.status === 'done') {
                // 工具结果里带了钉盘附件时，把它挂到 A2UI 卡片；File 组件的 previewUrl
                // 由钉钉客户端打开原生预览。summary 是工具 payload 的 JSON。
                try {
                  const payload = JSON.parse(event.summary) as {
                    attachment?: DingTalkCardAttachment
                  }
                  if (payload?.attachment?.fileName && payload.attachment.previewUrl) {
                    cardAttachments.splice(0, cardAttachments.length, payload.attachment)
                  }
                } catch {
                  // 结果被截断或不是 JSON 时保持普通文件消息的结果，不阻断主回答。
                }
              }
            }
            cardState.tool = ''
            pushCard()
            publishTool({
              type: 'tool_result',
              id: event.id,
              status: event.status,
              summary: event.summary,
              durationMs: event.durationMs,
            })
          }
        },
      })
      if (agentResult) {
        const usedId = agentResult.usedModelId
        const used = usedId ? available.find((item) => item.id === usedId) : undefined
        if (used) effectiveModel = used
        if (preferredModel && agentResult.fallbackFromModelId && effectiveModel.id !== model.id) {
          // 用户固定选过模型时，故障转移后的模型写入本会话；自动模式仍保持 NULL。
          deps.db
            .prepare('UPDATE chat_sessions SET model_id = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
            .run(effectiveModel.id, Date.now(), sessionId)
        }
        agentText = agentResult.text.trim()
        toolCallCount = agentResult.toolCalls.length
        rounds = agentResult.rounds
        promptTokens = agentResult.promptTokens
        completionTokens = agentResult.completionTokens
      }
    } catch (error) {
      agentText = `这次回答没有成功：${error instanceof Error ? error.message : '模型调用失败'}。可以换个问法再试。`
    }

    if (!agentText) {
      agentText = `（演示应答）${actor.person.name}，你问的是：「${promptText}」。当前模型来自演示供应商，还没有接真实 API。`
    }

    // 模型自己已经按系统提示报了 EAB 品牌时不再重复加前缀，避免「你好，我是 EAB……你好，我是 EAB……」。
    const alreadyBranded = /EAB|企业智能助手/.test(agentText)
    const greeting = firstMessage && !alreadyBranded
      ? `你好，${actor.person.name}。我是「${actor.person.companyName}」的 EAB 企业智能助手（Enterprise Agent Base）。钉钉这里的对话和 EAB 网页工作台是同一份历史。\n\n`
      : ''
    const clarifyText = formatClarifyText(agentResult?.clarify)
    const answerText = `${modelFallbackNote}${failoverNote}${greeting}${clarifyText || agentText}`

    // 卡片成功收口时返回 null，交给调用方跳过 sessionWebhook 纯文本；失败才回退文字。
    let replyText: string | null = answerText
    const finalReasoning = (agentResult?.reasoning || cardState.reasoning || '').trim()
    if (card) {
      try {
        const finalState: DingTalkRichCardState = {
          answer: answerText,
          reasoning: finalReasoning,
          tools: toolsUsed,
          thinkingDone: true,
          toolDetails,
          attachments: cardAttachments,
        }
        if (await card.finish(finalState, answerText)) {
          replyText = null
        } else {
          await card.fail('卡片已结束，完整回答见下一条消息。')
        }
      } catch (error) {
        console.warn('[eab] 钉钉 A2UI 卡片收口异常，回退文字消息：', (error as Error).message)
        await card.fail('卡片已结束，完整回答见下一条消息。')
      }
    } else if (legacyCard) {
      try {
        if (
          await legacyCard.finish(
            renderDingTalkFinalCard(answerText, finalReasoning, toolsUsed),
            answerText,
          )
        ) {
          replyText = null
        } else {
          await legacyCard.fail('卡片已结束，完整回答见下一条消息。')
        }
      } catch (error) {
        console.warn('[eab] 钉钉旧卡片收口异常，回退文字消息：', (error as Error).message)
        await legacyCard.fail('卡片已结束，完整回答见下一条消息。')
      }
    }

    const assistantCreatedAt = Date.now()
    const assistantMeta = {
      channel: 'dingtalk',
      citations: hits.map((hit, index) => ({
        index: index + 1,
        collection: hit.collectionName,
        title: hit.docTitle,
        excerpt: hit.text.slice(0, 120),
        docId: hit.docId ?? null,
        chunkId: hit.chunkId ?? null,
        score: hit.score ?? null,
        source: hit.source ?? 'local',
      })),
      tokens: { prompt: promptTokens, completion: completionTokens },
      reasoning: (agentResult?.reasoning || cardState.reasoning || '').trim(),
      toolCalls: agentResult?.toolCalls ?? [],
      rounds,
      clarify: agentResult?.clarify ?? null,
    }
    deps.db
      .prepare(
        `INSERT INTO chat_messages (id, company_id, session_id, user_id, role, text, model_id, model_name, meta_json, created_at)
         VALUES (?, ?, ?, ?, 'assistant', ?, ?, ?, ?, ?)`,
      )
      .run(
        assistantMessageId,
        actor.subject.companyId,
        sessionId,
        actor.person.id,
        answerText,
        effectiveModel.id,
        effectiveModel.name,
        JSON.stringify(assistantMeta),
        assistantCreatedAt,
      )
    publishChatEvent({
      type: 'message',
      companyId: actor.subject.companyId,
      userId: actor.person.id,
      sessionId,
      message: {
        id: assistantMessageId,
        role: 'assistant',
        text: answerText,
        modelId: effectiveModel.id,
        modelName: effectiveModel.name,
        meta: assistantMeta,
        createdAt: new Date(assistantCreatedAt).toISOString(),
      },
    })
    deps.db
      .prepare('UPDATE chat_sessions SET updated_at = ?, last_message_at = ? WHERE id = ?')
      .run(Date.now(), Date.now(), sessionId)
    bumpUsage(deps.db, actor.subject.companyId, actor.person.id, promptTokens, completionTokens)
    appendAudit(deps.db, {
      companyId: actor.subject.companyId,
      actorUserId: actor.person.id,
      action: 'chat.message',
      resourceType: 'chat_session',
      resourceId: sessionId,
      result: 'success',
      detail: { channel: 'dingtalk', modelId: effectiveModel.id, tools: toolCallCount, rounds },
      channel: 'dingtalk',
      ip: null,
    })

    deps.db
      .prepare('UPDATE channel_events SET result_json = ? WHERE provider = ? AND event_key = ?')
      .run(JSON.stringify({ sessionId, modelId: effectiveModel.id, durationMs: Date.now() - started }), 'dingtalk', eventKey)

    reactionOk = true
    return { handled: true, text: replyText, sessionId, reason: 'ok' }
  } catch (error) {
    if (card) await card.fail('处理失败，请稍后重试。').catch(() => undefined)
    if (legacyCard) await legacyCard.fail('处理失败，请稍后重试。').catch(() => undefined)
    appendAudit(deps.db, {
      companyId: actor.subject.companyId,
      actorUserId: actor.person.id,
      action: 'chat.message',
      resourceType: 'chat_session',
      resourceId: sessionId,
      result: 'failure',
      detail: { channel: 'dingtalk', error: error instanceof Error ? error.message : 'unknown' },
      channel: 'dingtalk',
      ip: null,
    })
    throw error
  } finally {
    void reaction?.finish(reactionOk)
    releaseTurn(sessionId, turnToken)
  }
}

// ---------- Stream 长连接（本地无公网地址时使用） ----------

interface StreamClientLike {
  connected?: boolean
  registered?: boolean
  reconnecting?: boolean
  disconnect: () => void
}

interface StreamState {
  client: StreamClientLike | null
  appId: string | null
  startedAt: number | null
  lastConnectedAt: number | null
  lastAttemptAt: number | null
  error: string | null
}

const streamState: StreamState = {
  client: null,
  appId: null,
  startedAt: null,
  lastConnectedAt: null,
  lastAttemptAt: null,
  error: null,
}

export interface DingTalkStreamStatus {
  readonly running: boolean
  readonly appId: string | null
  readonly startedAt: number | null
  readonly connected: boolean
  readonly registered: boolean
  readonly lastConnectedAt: number | null
  readonly lastAttemptAt: number | null
  readonly error: string | null
}

export function dingTalkStreamStatus(): DingTalkStreamStatus {
  return {
    // running 只代表宿主持有客户端；真正能收消息看 connected + registered。
    running: Boolean(streamState.client),
    appId: streamState.appId,
    startedAt: streamState.startedAt,
    connected: streamState.client?.connected === true,
    registered: streamState.client?.registered === true,
    lastConnectedAt: streamState.lastConnectedAt,
    lastAttemptAt: streamState.lastAttemptAt,
    error: streamState.error,
  }
}

let refreshPromise: Promise<void> | null = null

/**
 * 启动/重建钉钉 Stream。绑定换机器人后调用它即可切换凭证，不必重启整个服务。
 * 只有 robot_mode=STREAM（钉钉扫码默认给这个模式）才需要主动连网关。
 */
export function refreshDingTalkStream(deps: ServerDeps): Promise<void> {
  // 启动、绑定回写、30 秒巡检可能同时触发；串行化，避免并发建出多条长连接。
  if (refreshPromise) return refreshPromise
  refreshPromise = doRefreshDingTalkStream(deps).finally(() => {
    refreshPromise = null
  })
  return refreshPromise
}

async function doRefreshDingTalkStream(deps: ServerDeps): Promise<void> {
  const cfg = dingTalkConfig(deps.db, deps.companyId)
  const mode = String(cfg?.robot_mode ?? '').toUpperCase()
  streamState.lastAttemptAt = Date.now()
  if (!cfg?.app_id || !cfg.secret_ref || cfg.status !== 'bound' || mode !== 'STREAM') {
    stopDingTalkStream()
    streamState.error = '钉钉渠道未满足 Stream 启动条件（需已绑定且 robot_mode=STREAM）'
    return
  }
  const secret = resolveSecret(deps.config.dbPath, cfg.secret_ref)
  if (!secret) {
    // 密钥文件被覆盖/迁移丢失时，之前这里直接 return，界面仍显示“已绑定”，
    // 手机端会表现为机器人完全不回复。必须把原因挂到状态里让控制台可见。
    stopDingTalkStream()
    streamState.error = `钉钉渠道密钥缺失：${cfg.secret_ref} 未配置，请重新保存 AppSecret`
    console.warn(`[eab] 钉钉 Stream 未启动：${streamState.error}`)
    return
  }
  if (streamState.client && streamState.appId === cfg.app_id) {
    if (streamState.client.connected || streamState.client.registered) return
    // 客户端还在建连/等待自动重连时不要拆掉它；否则每轮巡检都会打断退避。
    if (streamState.client.reconnecting) return
  }

  stopDingTalkStream()
  const { DWClient, TOPIC_ROBOT } = await import('dingtalk-stream')
  const client = new DWClient({
    clientId: cfg.app_id,
    clientSecret: secret,
    keepAlive: true,
    debug: false,
  })
  client.registerCallbackListener(TOPIC_ROBOT, (res) => {
    const messageId = res.headers?.messageId ?? ''
    void (async () => {
      try {
        const payload = JSON.parse(res.data) as DingTalkMessage
        const result = await handleDingTalkMessage(deps, payload)
        if (result.text && payload.sessionWebhook) {
          await replySessionWebhook(deps, payload.sessionWebhook, result.text)
        }
      } catch (error) {
        console.warn('[eab] 钉钉 Stream 消息处理失败：', (error as Error).message)
      } finally {
        if (messageId) client.socketCallBackResponse(messageId, { status: 'SUCCESS' })
      }
    })()
  })
  streamState.client = client
  streamState.appId = cfg.app_id
  streamState.startedAt = Date.now()
  streamState.error = null
  try {
    await client.connect()
    if (client.connected) {
      streamState.lastConnectedAt = Date.now()
      streamState.error = null
      console.log(`[eab] 钉钉 Stream 已连接：EAB · ${cfg.tenant_name ?? deps.companyId}`)
    } else {
      // 库的 connect() 内部会吞掉网关错误并返回，不能只看它有没有抛异常。
      streamState.error = '钉钉 Stream 连接未建立（网关鉴权或网络失败），正在自动重连'
      console.warn(`[eab] ${streamState.error}`)
    }
  } catch (error) {
    streamState.error = `钉钉 Stream 连接失败：${(error as Error).message}`
    console.warn(`[eab] ${streamState.error}`)
  }
}

/**
 * 定期巡检 Stream：只有 connected 但未 registered 仍收不到消息；
 * 连续失败或客户端卡死时重建，避免“服务在跑、机器人却静默”的状态长期存在。
 */
export function startDingTalkStreamMonitor(deps: ServerDeps, intervalMs = 30_000): () => void {
  let stopped = false
  const timer = setInterval(() => {
    if (stopped) return
    void refreshDingTalkStream(deps).catch((error) => {
      console.warn('[eab] 钉钉 Stream 巡检失败：', (error as Error).message)
    })
  }, Math.max(5_000, intervalMs))
  timer.unref?.()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}

export function stopDingTalkStream(): void {
  if (streamState.client) {
    try {
      streamState.client.disconnect()
    } catch {
      /* 已断开 */
    }
  }
  streamState.client = null
  streamState.appId = null
  streamState.startedAt = null
}
