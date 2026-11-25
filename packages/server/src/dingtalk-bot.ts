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
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { SC, scopeAllows } from '@eab/domain'
import { appendAudit, type Db } from '@eab/storage'
import { consumeRobotUserFileSend } from './dingtalk-file-echo.js'
import { clearDingTalkClarifySync, registerDingTalkClarifySync } from './dingtalk-clarify-sync.js'
import { handlePermissionApprovalCardCallback } from './permission-approval-dingtalk.js'
import {
  handleToolApprovalCardCallback,
  isToolApprovalCardSession,
  notifyToolApprovalPending,
} from './tool-approval-dingtalk.js'
import { sendDingTalkVoiceReply } from './dingtalk-voice.js'
import {
  adoptLegacyInterruptedTurns,
  beginChannelTurn,
  claimChannelTurn,
  finishChannelTurn,
  getChannelTurn,
  listRecoverableChannelTurns,
  setChannelTurnCard,
  setChannelTurnProgress,
  type ChannelTurn,
} from './channel-turns.js'
import { acquireLeaderHold, claimOnce, hitRate, readLeaderOwner, type LeaderHold, type LeaderOwner } from './backends/coordination.js'
import { memoryQueryForTurn, recentMessageIds, searchChatMemory, shouldRecallPastConversations } from './chat-memory.js'
import { refreshSessionSummary, sessionSummaryForPrompt } from './chat-summary.js'
import { extractMemoryShadow } from './memory-extractor.js'
import { publishChatEvent, type ChatLiveToolEventPayload } from './chat-events.js'
import { findActivePerson, findPerson, actorFor, type RequestActor } from './session.js'
import type { ServerDeps } from './deps.js'
import { resolveSecret } from './secrets.js'
import { resolveModelForPurpose } from './model-registry.js'
import { callTranscription, type ChatMessage as LlmMessage, type LlmContent } from './llm.js'
import { shouldAutoRetrieveKb } from './intent.js'
import {
  acquireTurn,
  chooseAutoChatModel,
  formatClarifyText,
  buildSystemPrompt,
  bumpUsage,
  createTurnTimingTracker,
  ensureChannelSession,
  historyOf,
  loadModelCatalogCached,
  modelFailoverNotice,
  modelSupportsVision,
  releaseTurn,
  setChannelOpenConversationId,
  retrieveKb,
  runAgentTurn,
  shouldPersistFailoverModel,
  visibleModelsFor,
  type AgentTurnResult,
} from './routes/chat.js'
import {
  invalidateModelSpeedStats,
  rankModelsBySpeed,
  readModelSpeedStats,
} from './model-speed.js'
import { toolSpecsForAgent } from './routes/tools.js'
import type { ActiveSpace } from './space.js'
import { saveUserWorkspaceFile } from './routes/workspace.js'
import { prepareDshImCompat, syncDshImSession } from './dsh-im-compat.js'
import { pluginPromptTexts } from './plugin-tools.js'
import { skillCatalogTexts } from './skills.js'
import { assertChatQuota } from './quota.js'
import { planChannelModelCommand, planChannelModelPicker, planChannelModelSelection, type ChannelModelOption } from './channel-model-command.js'
import { SWITCH_CHAT_MODEL_TOOL_SPEC, updateConversationModelPreference, type ModelSwitchContext } from './channel-model-switch.js'
import {
  resolveUserWorkspaceQuota,
  workspaceCapacity,
  workspaceUsedBytes,
} from './workspace-quota.js'
import {
  dingTalkClarifyCardState,
  forgetDingTalkClarifyCard,
  isDingTalkClarifyCardConsumed,
  DingTalkAICardStream,
  DingTalkCardStream,
  DingTalkReaction,
  dingTalkAccessToken,
  dingTalkConversationSummary,
  registerDingTalkClarifyCard,
  renderDingTalkFinalCard,
  renderDingTalkProgressCard,
  updateDingTalkClarifyDraft,
  updateDingTalkClarifyIndex,
  type DingTalkCardAttachment,
  type DingTalkClarifyAnswer,
  type DingTalkClarifyQuestion,
  type DingTalkClarifyState,
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
  /**
   * picture / richText 消息里携带的临时下载码，用它换钉钉临时下载链接。
   * audio 消息另有 recognition（钉钉侧语音识别结果）和 duration（毫秒）。
   */
  content?: {
    downloadCode?: string
    richText?: DingTalkRichTextItem[]
    fileName?: string
    recognition?: string
    duration?: number
  }
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

interface DingTalkCardCallbackPayload {
  type?: string
  outTrackId?: string
  corpId?: string
  userId?: string
  /** JSON 字符串：{ cardPrivateData: { actionIds, params } } */
  content?: string
}

interface DingTalkResult {
  readonly handled: boolean
  readonly text: string | null
  readonly sessionId: string | null
  readonly reason: string
  /** 语音消息触发时，由调用方在文字/卡片发出后补发语音；非语音消息为 undefined。 */
  readonly voice?: {
    readonly companyId: string
    readonly userId: string
    readonly text: string
  }
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
/** 钉钉语音通常只有几秒到几十秒，12MB 足够且与网页端转写上限一致。 */
const MAX_INBOUND_AUDIO_BYTES = 12 * 1024 * 1024

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

/** 钉钉语音支持 ogg / amr；下载响应有时只给 application/octet-stream，需要按文件头兜底。 */
function audioMimeType(buffer: Buffer, contentType: string): string {
  const declared = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (declared === 'audio/x-wav' || declared === 'audio/wav') return 'audio/wav'
  if (declared.startsWith('audio/')) return declared
  if (buffer.length >= 6 && buffer.subarray(0, 5).toString('ascii') === '#!AMR') return 'audio/amr'
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString('ascii') === 'OggS') return 'audio/ogg'
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WAVE'
  ) {
    return 'audio/wav'
  }
  if (buffer.length >= 3 && buffer.subarray(0, 3).toString('ascii') === 'ID3') return 'audio/mpeg'
  if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return 'audio/mpeg'
  // 钉钉移动端语音默认是 AMR；无法判定时按 AMR 交给转写模型，仍保留原始字节。
  return 'audio/amr'
}

function audioExtension(mime: string): string {
  if (mime === 'audio/ogg') return 'ogg'
  if (mime === 'audio/wav') return 'wav'
  if (mime === 'audio/mpeg') return 'mp3'
  if (mime === 'audio/mp4') return 'm4a'
  return 'amr'
}

async function downloadDingTalkAudio(
  deps: ServerDeps,
  cfg: DingTalkChannelRow,
  downloadCode: string,
): Promise<{ buffer: Buffer; mime: string; fileName: string }> {
  const { buffer, contentType } = await downloadDingTalkAttachment(deps, cfg, downloadCode, {
    maxBytes: MAX_INBOUND_AUDIO_BYTES,
    label: '语音',
  })
  const mime = audioMimeType(buffer, contentType)
  return { buffer, mime, fileName: `钉钉语音.${audioExtension(mime)}` }
}

export interface DingTalkInboundAudio {
  readonly downloadCode: string
  readonly recognition: string
  readonly durationMs: number
}

/** 解析钉钉语音消息；只有 msgtype=audio 才返回，richText 不使用这一结构。 */
export function inboundAudio(payload: DingTalkMessage): DingTalkInboundAudio | null {
  if (payload.msgtype !== 'audio') return null
  const downloadCode = String(payload.content?.downloadCode ?? '').trim()
  const recognition = String(payload.content?.recognition ?? '').trim()
  const duration = Number(payload.content?.duration ?? 0)
  return {
    downloadCode,
    recognition,
    durationMs: Number.isFinite(duration) && duration > 0 ? duration : 0,
  }
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

export function inboundText(payload: DingTalkMessage): string {
  const direct = String(payload.text?.content ?? '').trim()
  if (direct) return direct
  if (payload.msgtype === 'audio') {
    const recognized = String(payload.content?.recognition ?? '').trim()
    if (recognized) return recognized
    return ''
  }
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

/** 钉钉 HTTP 回调签名：Base64(HMAC-SHA256(timestamp + "\n" + appSecret, appSecret))。 */
export function verifyDingTalkCallbackSignature(input: {
  timestamp: string
  sign: string
  appSecret: string
  now?: number
}): boolean {
  const timestamp = input.timestamp.trim()
  const sign = input.sign.trim()
  if (!/^\d{10,13}$/.test(timestamp) || !sign || !input.appSecret) return false
  const ts = Number(timestamp)
  const now = input.now ?? Date.now()
  const skew = Math.abs(now - ts)
  if (!Number.isFinite(skew) || skew > 60 * 60 * 1000) return false
  const expected = createHmac('sha256', input.appSecret).update(`${timestamp}\n${input.appSecret}`).digest('base64')
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(sign, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * 钉钉 sessionWebhook 只允许开放平台域名，且必须是 HTTPS、无账号信息。
 * 机器人 access token 只会发往这里，避免被任意请求体 URL 带走。
 */
export function normalizeDingTalkSessionWebhook(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('sessionWebhook 不是合法 URL')
  }
  if (url.protocol !== 'https:') throw new Error('sessionWebhook 必须使用 HTTPS')
  if (url.username || url.password) throw new Error('sessionWebhook 不允许携带账号信息')
  const host = url.hostname.toLowerCase()
  if (host !== 'oapi.dingtalk.com' && host !== 'api.dingtalk.com') {
    throw new Error(`sessionWebhook 域名不在白名单：${host}`)
  }
  if (url.port && url.port !== '443') throw new Error('sessionWebhook 只允许 443 端口')
  return url.toString()
}

/** sessionWebhook 回复（HTTP 回调/Stream 消息都带这个地址）。 */
export async function replySessionWebhook(deps: ServerDeps, webhook: string, text: string): Promise<void> {
  const target = normalizeDingTalkSessionWebhook(webhook)
  const cfg = dingTalkConfig(deps.db, deps.companyId)
  if (!cfg?.app_id || !cfg.secret_ref) throw new Error('钉钉渠道凭证不完整，无法回复')
  const secret = resolveSecret(deps.config.dbPath, cfg.secret_ref)
  if (!secret) throw new Error('钉钉 AppSecret 未配置或已失效')
  const token = await dingTalkAccessToken(cfg.app_id, secret)
  for (const chunk of splitText(text)) {
    const response = await fetch(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-acs-dingtalk-access-token': token,
      },
      body: JSON.stringify({ msgtype: 'text', text: { content: chunk } }),
      redirect: 'error',
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

/** 每人每分钟最多 20 条。Redis 在线时跨实例共享计数，离线回退进程内，重启清零。 */
const RATE_LIMIT_PER_MINUTE = 20

async function rateLimited(externalId: string): Promise<boolean> {
  const verdict = await hitRate(`dingtalk:dm:${externalId}`, RATE_LIMIT_PER_MINUTE, 60)
  return !verdict.allowed
}


/**
 * “有哪些模型/切换模型”不再回一段文字列表，而是直接下发可点击的模型卡。
 *
 * 卡片只负责呈现和回传选项；真正的切换仍由卡片回调里的静默分支完成，
 * 因此点选后不会再出现一条独立的“已切换模型”机器人消息。
 */
async function showDingTalkModelPickerCard(
  deps: ServerDeps,
  cfg: DingTalkChannelRow,
  externalId: string,
  sessionId: string,
  models: readonly ChannelModelOption[],
  currentModelId: string | null,
): Promise<boolean> {
  const picker = planChannelModelPicker(models, currentModelId)
  if (!picker) return false
  const appId = String(cfg.app_id ?? '').trim()
  const secret = cfg.secret_ref ? resolveSecret(deps.config.dbPath, cfg.secret_ref) : ''
  if (!appId || !secret) return false
  const robotCode = String(cfg.robot_code ?? '').trim() || appId

  const card = new DingTalkAICardStream(appId, secret, externalId, robotCode)
  const clarify: DingTalkClarifyState = {
    sessionId,
    question: picker.question,
    options: picker.options,
    kind: 'single',
    allowCustom: false,
    flowId: `cf_model_picker_${randomUUID()}`,
    step: 1,
    origin: 'model-picker',
  }
  const state: DingTalkRichCardState = {
    answer: picker.question,
    reasoning: '',
    tools: [],
    thinkingDone: true,
    toolDetails: [],
    sessionId,
    clarify,
  }

  if (!(await card.start(state, '选择对话模型'))) return false
  // start 成功后卡片选项已经可见；先登记再 finish，避免 finish 失败时按钮点了无响应。
  const outTrackId = card.providerMessageIds[0] ?? ''
  if (!outTrackId) return false
  registerDingTalkClarifyCard(outTrackId, clarify)
  if (!(await card.finish(state, '选择对话模型'))) {
    console.warn('[eab] 钉钉模型卡收口失败，选项已可见，保留卡片等待点选：', outTrackId)
  }
  return true
}

/**
 * 处理一条钉钉私聊消息。
 * `dedupe=true` 时由本函数自己写 channel_events；HTTP 路由已去重时传 false。
 */
export async function handleDingTalkMessage(
  deps: ServerDeps,
  payload: DingTalkMessage,
  options: {
    dedupe?: boolean
    sessionId?: string
    card?: DingTalkAICardStream
    /**
     * 卡片按钮回调的“隐藏续跑”：同一张卡/同一条 assistant 消息内继续，
     * 网页端不新增“我选择了…”的用户气泡，也不新插一条 assistant 消息。
     */
    clarifyFlow?: {
      flowId: string
      step: number
      assistantMessageId?: string
      /** 续用原卡失败时不再新建卡片，避免真机出现两条机器人消息。 */
      suppressNewCard?: boolean
    }
    /**
     * 服务重启后的恢复：复用上次已落库的消息 id / 卡片 / 工具幂等键。
     * 只由 recoverInterruptedDingTalkTurns 传入，普通入站不设置。
     */
    resume?: {
      turnId: string
      userMessageId: string
      assistantMessageId: string
      cardInstanceId?: string | null
      cardKind?: string | null
      agentTurnId?: string | null
      priorTools?: string[]
    }
  } = {},
): Promise<DingTalkResult> {
  const externalId = String(payload.senderStaffId ?? payload.senderId ?? '').trim()
  let rawText = inboundText(payload)
  const audio = inboundAudio(payload)
  const imageCodes = inboundImageCodes(payload)
  const fileAttachments = inboundFileAttachments(payload)
  if (!externalId) return { handled: false, text: null, sessionId: null, reason: 'missing-sender' }
  if (!rawText && imageCodes.length === 0 && fileAttachments.length === 0 && !audio) {
    return {
      handled: false,
      text: 'EAB 目前支持文字、图片、文件和语音：可以直接问我制度、部门、组长或工作资料，也可以发图片让我读取内容，发文件到个人云空间，或直接发语音。发送 /model 可以查看并切换你有权限使用的模型，发送 /auto 恢复自动选择。',
      sessionId: null,
      reason: 'empty-text',
    }
  }
  if (!options.resume && (await rateLimited(externalId))) {
    return { handled: false, text: '消息有点频繁，请 1 分钟后再发。', sessionId: null, reason: 'rate-limited' }
  }

  const eventKey =
    String(payload.msgId ?? '').trim() ||
    `${externalId}:${payload.createAt ?? ''}:${rawText.slice(0, 40) || imageCodes[0]?.slice(0, 40) || fileAttachments[0]?.fileName.slice(0, 40) || audio?.downloadCode.slice(0, 40) || payload.msgtype || ''}`
  if (options.dedupe !== false && !options.resume) {
    // 先用 Redis 做一次跨实例的原子预去重，避免同一条事件被多个实例同时处理；
    // 缓存层没接或抖动时放行，下面 channel_events 的唯一约束仍是最终闸门。
    const firstSeen = await claimOnce(`dingtalk:event:${deps.companyId}:${eventKey}`, 300)
    if (!firstSeen) {
      return { handled: false, text: null, sessionId: null, reason: 'duplicate' }
    }
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
  const catalog = await loadModelCatalogCached(
    deps.db,
    actor.subject.companyId,
    deps.config.devAuth,
    actor.subject.userId,
  )
  const available = visibleModelsFor(catalog, [...actor.subject.roles], actor.subject.companyId)
  const availableChatModels = available.filter((item) => (item.endpointKind ?? 'chat') === 'chat')

  /**
   * 渠道里的模型切换必须先于额度校验：它不调用模型，也不消耗额度。
   * 命令只匹配 available（已按当前员工角色过滤），不会探测未授权模型。
   * 先用 null 当前模型做一次纯解析，只有命中命令才建/取会话，普通消息不提前落会话。
   */
  const commandPreview =
    audio === null && imageCodes.length === 0 && fileAttachments.length === 0
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
      // “有哪些模型/切换模型/模型名有歧义”统一走引导卡，不再回文字列表；
      // 点选后由卡片回调静默切换，用户不需要再说“用引导模式”。
      if (modelCommand.kind === 'list' || modelCommand.kind === 'ambiguous') {
        const pickerModels =
          modelCommand.kind === 'ambiguous'
            ? (modelCommand.candidates ?? []).filter((candidate) =>
                availableChatModels.some((model) => model.id === candidate.id),
              )
            : availableChatModels
        if (
          await showDingTalkModelPickerCard(
            deps,
            cfg,
            externalId,
            commandSessionId,
            pickerModels.length > 0 ? pickerModels : availableChatModels,
            currentModelId,
          )
        ) {
          return {
            handled: true,
            text: null,
            sessionId: commandSessionId,
            reason: 'model-picker-card',
          }
        }
      }
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

  /**
   * 钉钉语音消息两条路径：
   * 1. 钉钉已在 content.recognition 返回识别文本时直接使用（上面的 inboundText 已取到）；
   * 2. recognition 为空时，下载语音二进制交给 asr.default 转写。
   * 不能把 audio 当成空消息回退成能力介绍，否则用户会以为机器人听不见。
   */
  if (audio && !rawText) {
    if (!audio.downloadCode) {
      return {
        handled: false,
        text: '语音已收到，但钉钉没有返回语音文件，无法转写。请重发一次，或改用文字。',
        sessionId: null,
        reason: 'audio-missing',
      }
    }
    const asrModel = resolveModelForPurpose(deps.db, deps.companyId, 'asr.default')
    if (!asrModel) {
      return {
        handled: false,
        text: '语音已收到，但 EAB 还没有配置语音转写模型。请管理员在控制台「模型接入 → 用途路由」把 asr.default 绑定到语音转写模型后重试。',
        sessionId: null,
        reason: 'audio-no-asr',
      }
    }
    try {
      const voice = await downloadDingTalkAudio(deps, cfg, audio.downloadCode)
      const transcribed = await callTranscription(deps.db, deps.config.dbPath, deps.companyId, asrModel.id, {
        buffer: voice.buffer,
        mime: voice.mime,
        fileName: voice.fileName,
      })
      rawText = String(transcribed.text ?? '').trim()
    } catch (error) {
      console.warn(
        '[eab] 钉钉语音转写失败：',
        `model=${asrModel.id}`,
        (error as Error)?.message ?? error,
      )
      return {
        handled: false,
        text: '语音没有转写成功，请稍后重发一次，或先用文字告诉我。',
        sessionId: null,
        reason: 'audio-transcribe-failed',
      }
    }
    if (!rawText) {
      return {
        handled: false,
        text: '语音已收到，但没有识别出文字。请靠近麦克风再说一次，或改用文字。',
        sessionId: null,
        reason: 'audio-empty-result',
      }
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

  const forcedSessionId = options.sessionId
    ? (deps.db
        .prepare(
          `SELECT id FROM chat_sessions
            WHERE id = ? AND company_id = ? AND user_id = ? AND source = 'dingtalk'
              AND external_id = ? AND deleted_at IS NULL
            LIMIT 1`,
        )
        .get(options.sessionId, actor.subject.companyId, actor.person.id, externalId) as { id: string } | undefined)?.id
    : undefined
  const sessionId = forcedSessionId ?? ensureChannelSession(deps.db, actor, 'dingtalk', externalId, promptText)
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
  let card: DingTalkAICardStream | null = options.card ?? null
  let legacyCard: DingTalkCardStream | null = null
  let reaction: DingTalkReaction | null = null
  let reactionOk = false
  let trackedTurnId: string | null = null
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
    let sessionModelId =
      (deps.db
        .prepare('SELECT model_id FROM chat_sessions WHERE id = ? AND deleted_at IS NULL')
        .get(sessionId) as { model_id: string | null } | undefined)?.model_id ?? null
    const preferredModel = sessionModelId ? available.find((item) => item.id === sessionModelId) : undefined
    if (sessionModelId && !preferredModel) {
      // 会话里保存的模型下线或当前角色无权后再回退自动，避免每轮继续拿旧 ID。
      deps.db.prepare('UPDATE chat_sessions SET model_id = NULL, updated_at = ? WHERE id = ?').run(Date.now(), sessionId)
      sessionModelId = null
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
    // 用途路由「图片 / 多模态」优先：绑定模型可见且支持图片时用它，否则沿用按能力的自动挑选。
    const visionRoute = imageUrls.length > 0
      ? resolveModelForPurpose(deps.db, actor.subject.companyId, 'chat.vision')
      : null
    const visionRouted = visionRoute
      ? available.find(
          (item) => item.id === visionRoute.id && modelSupportsVision(item.tags, item.capabilities),
        )
      : undefined
    /**
     * 自动模式按真实对话实测速度选：首字延迟 + 生成 tok/s 综合最快的模型先回复。
     * 显式 /model 选过的会话模型、用途路由 chat.vision 仍然优先；没有速度样本时
     * 保持原来的首个可用模型，冷启动不会因为缺样本而选不出模型。
     */
    const speedStats = readModelSpeedStats(deps.db, actor.subject.companyId)
    const hasMeasuredSpeed = availableChatModels.some((item) => speedStats.has(item.id))
    const visionModels = availableChatModels.filter((item) => modelSupportsVision(item.tags, item.capabilities))
    const dataModels = imageUrls.length > 0 ? visionModels : availableChatModels
    // 会话里显式选过 /model 时优先用它；否则按视觉路由与实测速度自动选，没有实测速度就取第一个可用。
    const preferredAvailable = preferredModel && dataModels.some((item) => item.id === preferredModel.id)
      ? preferredModel
      : undefined
    const model =
      preferredAvailable ??
      (imageUrls.length > 0
        ? visionRouted ??
          (hasMeasuredSpeed ? chooseAutoChatModel(visionModels, speedStats) : visionModels[0]) ??
          availableChatModels[0]
        : hasMeasuredSpeed
          ? chooseAutoChatModel(availableChatModels, speedStats)
          : availableChatModels[0])
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

    /**
     * 先把这一轮的 id 固定下来并落库，再建卡/跑模型。
     * 这样进程在任意时刻被重启，启动后都能拿回同一条用户消息、同一张卡片和同一组工具幂等键。
     */
    const now = Date.now()
    const continueAssistantId = String(
      options.resume?.assistantMessageId ?? options.clarifyFlow?.assistantMessageId ?? '',
    ).trim()
    const assistantMessageId = continueAssistantId || `msg_${randomUUID()}`
    const userMessageId =
      String(options.resume?.userMessageId ?? '').trim() || `msg_${randomUUID()}`
    const agentTurnId = String(options.resume?.agentTurnId ?? '').trim() || randomUUID()
    const clarifyFlow = options.clarifyFlow
      ? {
          clarifyFlowId: String(options.clarifyFlow.flowId || '').slice(0, 80),
          clarifyStep: Math.max(1, Math.trunc(Number(options.clarifyFlow.step) || 1)),
          interaction: 'clarify_select',
        }
      : null
    const userMessageMeta = {
      channel: 'dingtalk',
      externalUserId: externalId,
      hasImage: imageUrls.length > 0,
      imageCount: imageUrls.length,
      // 网页端把带 clarifyFlowId 的用户消息视为隐藏续跑，不渲染绿色气泡。
      ...(clarifyFlow ?? {}),
    }
    // 普通回合用 assistant 消息 id 作为 recovery 主键；卡片按钮的隐藏续跑会复用
    // 原 assistant 消息，但它是独立的一次处理，必须单独登记一条 channel_turns 才能重启恢复。
    const clarifyTurnId = options.clarifyFlow ? `turn_${randomUUID()}` : ''
    const turnRecordId = options.resume?.turnId || clarifyTurnId || assistantMessageId
    trackedTurnId = turnRecordId
    if (!options.resume) {
      const began = beginChannelTurn(deps.db, {
        id: turnRecordId,
        companyId: actor.subject.companyId,
        provider: 'dingtalk',
        externalId,
        userId: actor.person.id,
        sessionId,
        eventKey,
        // clarify 续跑需要把“隐藏续跑”的上下文一起持久化，恢复时才能同时带 resume + clarifyFlow。
        payload: clarifyFlow
          ? {
              kind: 'dingtalk_clarify',
              message: payload,
              clarifyFlow: {
                flowId: clarifyFlow.clarifyFlowId,
                step: clarifyFlow.clarifyStep,
                suppressNewCard: true,
              },
            }
          : payload,
        userMessageId,
        assistantMessageId,
        agentTurnId,
        startedAt: started,
      })
      if (!began) trackedTurnId = null
    }

    // 先投递一张「正在思考」的 AI 卡片，后续 reasoning/content/tool 事件都在这张卡片里流式刷新。
    // 优先用 A2UI 折叠面板（思考/工具收起、正文最后）；权限未开通时自动回退旧模板卡片。
    // 只对私聊用 IM_ROBOT 卡片；群聊仍走 sessionWebhook 文字，避免把回答私发给提问人而群里看不到。
    const isPrivateChat = String(payload.conversationType ?? '1') === '1'
    const channelSecret = cfg.secret_ref ? resolveSecret(deps.config.dbPath, cfg.secret_ref) : null
    const robotCode = cfg.robot_code || cfg.app_id
    const initialRichState: DingTalkRichCardState = {
      answer: '',
      reasoning: options.resume
        ? '服务重启，正在继续上一轮回答…'
        : imageUrls.length > 0
          ? '正在读取图片内容…'
          : '正在分析你的问题…',
      tools: [],
      thinkingDone: false,
      toolDetails: [],
      sessionId,
    }
    // 建卡时回答还没生成，外层摘要先放中性品牌文案；
    // 收口时再把外层摘要替换成回复正文（A2UI 卡片走场域信息更新，旧模板走 sys_lastMessageI18n）。
    const conversationSummary = 'EAB 企业智能助手'
    if (
      isPrivateChat &&
      channelSecret &&
      !card &&
      (options.clarifyFlow?.suppressNewCard !== true || Boolean(options.resume?.cardInstanceId))
    ) {
      // 服务重启恢复时优先复用原卡：不新建机器人消息，直接在旧卡里继续刷新。
      const resumeCardId = String(options.resume?.cardInstanceId ?? '').trim()
      if (resumeCardId) {
        const resumeKind =
          options.resume?.cardKind || (resumeCardId.startsWith('eab_a2ui_') ? 'a2ui' : 'legacy')
        if (resumeKind === 'legacy') {
          const resumed = new DingTalkCardStream(cfg.app_id, channelSecret, externalId, robotCode)
          if (
            await resumed.resume(
              resumeCardId,
              imageUrls.length > 0
                ? '**EAB 正在读取图片…**\n\n> 服务重启，正在继续上一轮。'
                : '**EAB 正在继续上一轮回答…**\n\n> 服务重启前的这一轮已恢复。',
            )
          ) {
            legacyCard = resumed
          } else {
            // 续用失败但卡片可能只是瞬时不可用：尽力把旧卡收口，避免它永久停在处理中。
            await resumed.closeAfterResumeFailure(
              resumeCardId,
              '服务重启后这一轮已转到新消息继续，请查看下方回复。',
            )
          }
        } else {
          const resumed = new DingTalkAICardStream(cfg.app_id, channelSecret, externalId, robotCode)
          if (await resumed.resume(resumeCardId, initialRichState)) {
            card = resumed
            console.info('[eab] 钉钉 A2UI 卡片已复用，继续中断的回合：', resumeCardId)
          } else {
            await resumed.closeAfterResumeFailure(
              resumeCardId,
              '服务重启后这一轮已转到新消息继续，请查看下方回复。',
            )
          }
        }
      }
      // 原卡不在、或续用失败（例如卡片已过期）时才新建一张，至少保证用户能拿到完整回答。
      if (!card && !legacyCard) {
        clearDingTalkClarifySync(sessionId)
        // 私聊优先用 A2UI 卡：保留思考/工具折叠面板，正文保持纯 Markdown，不加光标或 loading 素材。
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
          console.info('[eab] 钉钉私聊回复使用 A2UI 折叠面板，正文保持纯 Markdown')
        }
      }
      const cardId = card?.providerMessageIds[0] ?? legacyCard?.providerMessageIds[0] ?? ''
      if (trackedTurnId && cardId) {
        setChannelTurnCard(deps.db, trackedTurnId, cardId, card ? 'a2ui' : 'legacy')
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

    const kbAuto = shouldAutoRetrieveKb(rawText)
    const hits = kbAuto ? await retrieveKb(deps.db, deps.config.dbPath, actor, rawText) : []
    const kbMode = hits.length > 0 ? 'retrieved' : kbAuto ? 'miss' : 'skipped'
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
    const channelChatTools = [...chatTools, SWITCH_CHAT_MODEL_TOOL_SPEC]
    const pluginPrompts = pluginPromptTexts(deps.db, actor, { query: promptText })
    // 钉钉与网页共用同一套紧凑技能目录：只列摘要，完整步骤由 runAgentTurn 注入的 skill_load 按需加载，
    // 避免单轮把 20k 技能正文全部塞进系统提示。
    const skillPrompts = skillCatalogTexts(deps.db, actor)
    const channelHistory = historyOf(deps.db, sessionId, 8, 'dingtalk', options.resume?.userMessageId)
    const memoryCrossSession = shouldRecallPastConversations(promptText)
    const memoryHits = searchChatMemory({
      db: deps.db,
      companyId: actor.subject.companyId,
      userId: actor.person.id,
      sessionId,
      crossSession: memoryCrossSession,
      query: memoryQueryForTurn(promptText, channelHistory),
      excludeMessageIds: recentMessageIds(deps.db, sessionId),
      limit: 5,
      maxChars: 1800,
    })
    const system = buildSystemPrompt({
      actor,
      chatTools: channelChatTools,
      memories,
      memoryHits,
      memoryCrossSession,
      sessionSummary: sessionSummaryForPrompt(deps.db, sessionId),
      userQuestion: promptText,
      kbMode,
      hits,
      hasAttachments: imageUrls.length > 0,
      pluginPrompts,
      skillPrompts,
      availableModels: availableChatModels.map((item) => ({ id: item.id, name: item.name })),
      currentModelId: model.id,
      channel: 'dingtalk',
    })
    const imageSystemNote =
      imageUrls.length > 0
        ? '本条消息包含真实图片附件，请直接读取图片内容后回答。历史对话里如果出现过“不支持图片/只支持文字提问”的说法，那是旧版本能力限制，已经过时，不要再沿用。'
        : ''
    const fileSendSystemNote =
      '当前版本已经支持把个人云空间文件作为钉钉文件消息发给用户，也支持重命名和删除云空间文件：用户要求发文件时，先调用 workspace_list 找到文件名或相对路径，再调用 workspace_send_dingtalk（参数 path 或 fileId）；用户要求改名时，调用 workspace_rename（参数 path 或 fileId，以及 newName）；用户明确要求删除某个文件时，调用 workspace_delete（参数 path 或 fileId，只能删当前员工自己的文件，软删到回收目录）。在钉钉单聊里，发文件会优先用“用户方向”的原生文件消息：文件气泡出现在用户与机器人的单聊右侧、显示为用户发出，这是机器人代发；机器人能识别自己代发的文件，不会把它再存进个人云空间，只会补一句“你要的文件已发送”。不要声称文件一定是机器人头像发出，也不要声称一定能在钉钉内预览或在线编辑。不要把文件正文当成附件发送，也不要沿用历史里“没有发送文件附件的通道/没有重命名功能/没有删除文件的工具”的旧说法。'
    const recoveryNote = options.resume
      ? [
          '本轮对话在 EAB 服务重启前中断，现在正在恢复同一轮回答。',
          options.resume.priorTools && options.resume.priorTools.length > 0
            ? `重启前已经调用过这些工具：${options.resume.priorTools.join('、')}。不要重复执行已经成功的写操作（写文件、发文件、删改数据、发消息）；如果必须再次执行，先向用户说明原因。`
            : '重启前还没有调用过会产生副作用的工具，可以正常继续。',
        ].join('')
      : ''
    const systemContent = `${system}\n\n${[imageSystemNote, fileSendSystemNote, recoveryNote].filter(Boolean).join('\n\n')}`
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
      // 恢复时当前用户消息可能已经落库；先排除它再单独拼一次，避免模型看到两遍相同提问。
      ...channelHistory,
      { role: 'user', content: userContent },
    ]

    const existingUserMessage = options.resume?.userMessageId
      ? (deps.db
          .prepare(
            `SELECT id FROM chat_messages
              WHERE id = ? AND session_id = ? AND role = 'user'
              LIMIT 1`,
          )
          .get(options.resume.userMessageId, sessionId) as { id: string } | undefined)
      : undefined
    if (!existingUserMessage) {
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
    }
    if (!existingUserMessage) {
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
    }

    let agentText = ''
    let agentResult: AgentTurnResult | null = null
    let toolCallCount = 0
    let rounds = 0
    let promptTokens = 0
    let completionTokens = 0
    let effectiveModel = model
    let failoverNote = ''
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
    const turnStartedAt = Date.now()
    const turnTiming = createTurnTimingTracker(turnStartedAt)
    let thinkingStartedAt = 0
    let thinkingMs = 0
    const pushCard = () => {
      if (card) {
        card.update({
          answer: cardState.answer,
          reasoning: cardState.reasoning,
          tools: toolsUsed,
          thinkingDone,
          thinkingMs,
          toolDetails,
          attachments: cardAttachments,
          sessionId,
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
    /** 只在工具状态变化时写一次进度，供进程重启后提示模型哪些工具已经执行过。 */
    const noteTurnProgress = () => {
      if (!trackedTurnId) return
      setChannelTurnProgress(deps.db, trackedTurnId, {
        tools: toolDetails.map((tool) => ({
          name: tool.name,
          toolId: tool.toolId,
          status: tool.status,
        })),
        updatedAt: Date.now(),
      })
    }
    const modelSwitchContext: ModelSwitchContext = {
      models: availableChatModels,
      currentModelId: sessionModelId,
      activeModelId: model.id,
      onChange: (modelId) => {
        updateConversationModelPreference(deps.db, {
          companyId: actor.subject.companyId,
          userId: actor.person.id,
          sessionId,
          modelId,
        })
        // 同一轮里模型可能连续调用 list/switch；同步上下文，避免第二次还看过期值。
        modelSwitchContext.currentModelId = modelId
      },
    }
    const fallbackCandidates = availableChatModels.filter(
      (item) => item.id !== model.id &&
        (imageUrls.length === 0 || modelSupportsVision(item.tags, item.capabilities)),
    )
    const fallbackModelIds = (hasMeasuredSpeed
      ? rankModelsBySpeed(fallbackCandidates, speedStats)
      : fallbackCandidates
    ).map((item) => item.id)
    try {
      agentResult = await runAgentTurn({
        deps,
        actor,
        modelId: model.id,
        turnId: agentTurnId,
        fallbackModelIds,
        // 钉钉卡片需要看到真实的逐字输出；缓冲会让所有事件等到模型跑完才一次性刷出，
        // 用户看到的就是“一直转圈、最后突然出全文”。故障转移时在下方的回调里清空旧卡片状态。
        bufferModelEvents: false,
        onModelFailover: (change) => {
          const next = available.find((item) => item.id === change.toModelId)
          if (next) effectiveModel = next
          modelSwitchContext.activeModelId = change.toModelId
          failoverNote = modelFailoverNotice(change)
        },
        onModelFallbackStart: () => {
          // 备用模型开始输出前清空失败模型的半截内容；等成功后再清会把新模型的 token 也抹掉。
          cardState.answer = ''
          cardState.reasoning = ''
          cardState.tool = ''
          toolsUsed.splice(0, toolsUsed.length)
          toolDetails.splice(0, toolDetails.length)
          cardAttachments.splice(0, cardAttachments.length)
          thinkingDone = false
          thinkingStartedAt = 0
          thinkingMs = 0
          pushCard()
          noteTurnProgress()
        },
        messages,
        sessionId,
        modelSwitch: modelSwitchContext,
        space: toolSpace,
        // 钉钉没有网页审批气泡：高危工具在渠道里等 A2UI 审批卡回调，
        // 通过后同一轮继续执行；没有可送达审批人时由回调返回 false 立即失败。
        approvalMode: 'wait',
        messageId: assistantMessageId,
        onToolApprovalPending: (request) =>
          notifyToolApprovalPending(deps, actor, request),
        emit: (event) => {
          if (event.type === 'reasoning') {
            turnTiming.token()
            if (!thinkingStartedAt) thinkingStartedAt = Date.now()
            cardState.reasoning += event.text
            pushCard()
            publishDelta('reasoning', event.text)
          } else if (event.type === 'content') {
            turnTiming.token()
            // 正文开始即代表思考阶段结束：标题切成“已思考 X”，预览行保留首句。
            if (!thinkingDone) {
              thinkingDone = true
              thinkingMs = Date.now() - (thinkingStartedAt || turnStartedAt)
            }
            cardState.answer += event.text
            pushCard()
            publishDelta('content', event.text)
          } else if (event.type === 'tool') {
            turnTiming.boundary()
            // 工具执行期间不是“思考结束”：保持“正在思考中”标题和下方摘要，
            // 只把工具面板切换成“工具调用中”。
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
            noteTurnProgress()
          } else if (event.type === 'tool_result') {
            turnTiming.boundary()
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
            noteTurnProgress()
          }
        },
      })
      turnTiming.finish()
      if (agentResult) {
        const usedId = agentResult.usedModelId
        const used = usedId ? available.find((item) => item.id === usedId) : undefined
        if (used) effectiveModel = used
        if (preferredModel && shouldPersistFailoverModel(agentResult.fallbackFromModelId)) {
          // 只有插件模型失败才把接替模型写回：插件模型会被健康表长期排除；
          // 本地/自建模型的一次失败是临时的，保持用户原来的选择。
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
    const clarify = agentResult?.clarify ?? null
    // 卡片上不重复编号文本：问题下面直接给可点击按钮，历史消息仍保留编号兜底。
    // “也可以直接回复你自己的方向”由卡片 /clarify/hint 统一显示，避免正文重复一遍。
    const clarifyCardAnswer = clarify
      ? `${modelFallbackNote}${failoverNote}${greeting}${clarify.question}`
      : answerText

    // 卡片成功收口时返回 null，交给调用方跳过 sessionWebhook 纯文本；失败才回退文字。
    let replyText: string | null = answerText
    const finalReasoning = (agentResult?.reasoning || cardState.reasoning || '').trim()
    const finalThinkingMs = thinkingMs > 0
      ? thinkingMs
      : finalReasoning
        ? Date.now() - (thinkingStartedAt || turnStartedAt)
        : 0
    const clarifyFlowId = clarifyFlow?.clarifyFlowId ?? (clarify ? `cf_${assistantMessageId}` : '')
    const clarifyStep = clarifyFlow?.clarifyStep ?? 1
    if (card) {
      try {
        const finalState: DingTalkRichCardState = {
          answer: clarifyCardAnswer,
          reasoning: finalReasoning,
          tools: toolsUsed,
          thinkingDone: true,
          thinkingMs: finalThinkingMs,
          toolDetails,
          attachments: cardAttachments,
          sessionId,
          clarify: clarify
            ? {
                sessionId,
                question: clarify.question,
                options: clarify.options,
                kind: clarify.kind === 'multiple' || clarify.kind === 'text' ? clarify.kind : 'single',
                placeholder: clarify.placeholder,
                allowCustom: clarify.allowCustom,
                flowId: clarifyFlowId,
                step: clarifyStep,
                messageId: assistantMessageId,
                ...(clarify.questions && clarify.questions.length > 1
                  ? {
                      questions: clarify.questions.map((question) => ({
                        id: question.id,
                        question: question.question,
                        options: question.options,
                        kind: question.kind,
                        placeholder: question.placeholder,
                        allowCustom: question.allowCustom,
                      })),
                      answers: {},
                      index: 0,
                    }
                  : {}),
              }
            : null,
        }
        if (await card.finish(finalState, clarifyCardAnswer)) {
          replyText = null
          // 同一会话也可能在网页工作台继续作答；登记后网页提交会把这张卡切到已作答，
          // 避免钉钉这边一直停在旧选项。只登记最近一张带澄清的卡。
          const cardInstanceId = card.providerMessageIds[0] ?? ''
          if (clarify && cardInstanceId) {
            const cardStream = card
            registerDingTalkClarifySync(sessionId, async (answer) => {
              const answeredState: DingTalkRichCardState = {
                answer: `✅ 已在网页工作台作答\n\n> ${String(answer ?? '').replace(/\n/g, '\n> ')}`,
                reasoning: '',
                tools: [],
                thinkingDone: true,
                toolDetails: [],
                attachments: [],
                clarify: null,
              }
              return cardStream.completeClarify(cardInstanceId, answeredState)
            })
          }
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

    const existingAssistant = continueAssistantId
      ? (deps.db
          .prepare(
            `SELECT id, session_id, created_at FROM chat_messages
              WHERE id = ? AND company_id = ? AND user_id = ? AND role = 'assistant'
              LIMIT 1`,
          )
          .get(continueAssistantId, actor.subject.companyId, actor.person.id) as
          | { id: string; session_id: string; created_at: number }
          | undefined)
      : undefined
    if (existingAssistant && existingAssistant.session_id !== sessionId) {
      return { handled: false, text: '这次引导已经失效，请重新发送一条消息。', sessionId, reason: 'clarify-message-mismatch' }
    }
    const assistantCreatedAt = existingAssistant?.created_at ?? Date.now()
    const assistantMeta = {
      channel: 'dingtalk',
      ...(clarifyFlow ?? {}),
      ...(clarify ? { clarifyFlowId, clarifyStep } : {}),
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
      timing: agentResult ? turnTiming.snapshot() : undefined,
      reasoning: (agentResult?.reasoning || cardState.reasoning || '').trim(),
      toolCalls: agentResult?.toolCalls ?? [],
      rounds,
      clarify: agentResult?.clarify ?? null,
    }
    if (existingAssistant) {
      // 续跑同一条 AI 消息：只替换正文和元数据，不新插一条，网页端也就只有同一个气泡。
      deps.db
        .prepare(
          `UPDATE chat_messages
              SET text = ?, model_id = ?, model_name = ?, meta_json = ?
            WHERE id = ? AND session_id = ? AND role = 'assistant'`,
        )
        .run(
          answerText,
          effectiveModel.id,
          effectiveModel.name,
          JSON.stringify(assistantMeta),
          assistantMessageId,
          sessionId,
        )
    } else {
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
    }
    invalidateModelSpeedStats(actor.subject.companyId)
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
    void refreshSessionSummary({
      db: deps.db,
      dbPath: deps.config.dbPath,
      companyId: actor.subject.companyId,
      userId: actor.person.id,
      sessionId,
      modelId: effectiveModel.id,
    }).catch((error) => {
      console.warn('[eab] 钉钉会话摘要更新失败：', (error as Error).message)
    })
    void extractMemoryShadow({
      db: deps.db,
      dbPath: deps.config.dbPath,
      companyId: actor.subject.companyId,
      userId: actor.person.id,
      sessionId,
      sourceMessageId: userMessageId,
      userText: rawText,
      modelId: effectiveModel.id,
      channel: 'dingtalk',
    }).catch((error) => {
      console.warn('[eab] 钉钉自动记忆抽取失败：', (error as Error).message)
    })

    deps.db
      .prepare('UPDATE channel_events SET result_json = ? WHERE provider = ? AND event_key = ?')
      .run(JSON.stringify({ sessionId, modelId: effectiveModel.id, durationMs: Date.now() - started }), 'dingtalk', eventKey)

    if (trackedTurnId) finishChannelTurn(deps.db, trackedTurnId, 'completed')
    reactionOk = true
    return {
      handled: true,
      text: replyText,
      sessionId,
      reason: 'ok',
      // 钉钉原生语音条会被客户端强制附上转写文字，和正文卡片必然重复一遍；
      // 卡片内的 AudioPlayer 又固定是大播放条、不支持自动播放。用户权衡后选择只要文字，
      // 因此这里不再发语音，voice 保持 undefined。
      voice: undefined,
    }
  } catch (error) {
    if (card) await card.fail('处理失败，请稍后重试。').catch(() => undefined)
    if (legacyCard) await legacyCard.fail('处理失败，请稍后重试。').catch(() => undefined)
    const message = error instanceof Error ? error.message : 'unknown'
    if (trackedTurnId) finishChannelTurn(deps.db, trackedTurnId, 'failed', message)
    // 事件结果也写上失败原因，控制台不会把它误认为「还在处理」。
    deps.db
      .prepare('UPDATE channel_events SET result_json = ? WHERE provider = ? AND event_key = ?')
      .run(JSON.stringify({ sessionId, status: 'failed', error: message }), 'dingtalk', eventKey)
    appendAudit(deps.db, {
      companyId: actor.subject.companyId,
      actorUserId: actor.person.id,
      action: 'chat.message',
      resourceType: 'chat_session',
      resourceId: sessionId,
      result: 'failure',
      detail: { channel: 'dingtalk', error: message },
      channel: 'dingtalk',
      ip: null,
    })
    throw error
  } finally {
    void reaction?.finish(reactionOk)
    releaseTurn(sessionId, turnToken)
  }
}

// ---------- 服务重启后的中断回合恢复 ----------

const MAX_TURN_RECOVERY_ATTEMPTS = 3
/** 超过 24 小时的旧回合不再重新调用模型，只把卡片收口，避免把很早以前的问题重新答一遍。 */
const TURN_RECOVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000

function priorToolNames(turn: ChannelTurn): string[] {
  const progress = turn.progress as { tools?: Array<{ name?: unknown }> } | null
  if (!progress || !Array.isArray(progress.tools)) return []
  return progress.tools
    .map((tool) => String(tool?.name ?? '').trim())
    .filter((name, index, all) => Boolean(name) && all.indexOf(name) === index)
    .slice(0, 20)
}

/**
 * 把一张没能恢复的旧卡收口成明确终态。
 * 只复用已有 outTrackId，不新建卡片；否则用户会看到“旧的还在转圈 + 新的又发一条”。
 */
async function closeInterruptedCard(
  deps: ServerDeps,
  turn: ChannelTurn,
  message: string,
): Promise<void> {
  const cardId = String(turn.cardInstanceId ?? '').trim()
  if (!cardId) return
  const cfg = dingTalkConfig(deps.db, deps.companyId)
  if (!cfg?.app_id || cfg.status !== 'bound') return
  const secret = cfg.secret_ref ? resolveSecret(deps.config.dbPath, cfg.secret_ref) : null
  if (!secret) return
  const robotCode = cfg.robot_code || cfg.app_id
  const state: DingTalkRichCardState = {
    answer: message,
    reasoning: '服务重启导致这一轮中断。',
    tools: [],
    thinkingDone: true,
    toolDetails: [],
  }
  try {
    if (turn.cardKind === 'legacy') {
      const card = new DingTalkCardStream(cfg.app_id, secret, turn.externalId, robotCode)
      if (await card.resume(cardId, message)) {
        await card.finish(renderDingTalkFinalCard(message, '', []), message)
      }
      return
    }
    const card = new DingTalkAICardStream(cfg.app_id, secret, turn.externalId, robotCode)
    if (await card.resume(cardId, state)) {
      await card.finish(state, message)
    }
  } catch (error) {
    console.warn('[eab] 中断回合卡片收口失败：', (error as Error).message)
  }
}

function markInterruptedEventFailed(deps: ServerDeps, turn: ChannelTurn, error: string): void {
  deps.db
    .prepare('UPDATE channel_events SET result_json = ? WHERE provider = ? AND event_key = ?')
    .run(JSON.stringify({ sessionId: turn.sessionId, status: 'recovery-failed', error }), 'dingtalk', turn.eventKey)
}

/**
 * 启动后扫描上次进程留下的 running/recovering 回合：
 * - 复用原卡、原消息 id、原工具幂等键，重新跑同一轮；
 * - 会话已删/超过 24h/重试超限的，只把卡片收口成“请重发”，不再自动重跑。
 *
 * 由 main.ts 在钉钉 Stream 启动后异步调用，不阻塞服务监听。
 */
export async function recoverInterruptedDingTalkTurns(
  deps: ServerDeps,
  runTurn: typeof handleDingTalkMessage = handleDingTalkMessage,
): Promise<{ resumed: number; closed: number; failed: number }> {
  const summary = { resumed: 0, closed: 0, failed: 0 }
  // 先把升级前只留下 channel_events、没有 channel_turns 的旧中断事件补登，
  // 这样它们和 0057 之后的新回合走同一条恢复路径。
  try {
    const adopted = adoptLegacyInterruptedTurns(deps.db, deps.companyId, {
      sinceMs: 7 * TURN_RECOVERY_MAX_AGE_MS,
      limit: 10,
    })
    if (adopted > 0) console.log(`[eab] 补登 ${adopted} 个升级前遗留的钉钉中断回合`)
  } catch (error) {
    console.warn('[eab] 补登旧钉钉中断回合失败：', (error as Error).message)
  }
  let turns: ChannelTurn[] = []
  try {
    turns = listRecoverableChannelTurns(deps.db, 'dingtalk', {
      sinceMs: 7 * TURN_RECOVERY_MAX_AGE_MS,
      limit: 10,
    })
  } catch (error) {
    console.warn('[eab] 查询中断回合失败：', (error as Error).message)
    return summary
  }
  if (turns.length === 0) return summary
  console.log(`[eab] 发现 ${turns.length} 个重启前未完成的钉钉回合，开始恢复`)

  for (const turn of turns) {
    if (!claimChannelTurn(deps.db, turn.id, MAX_TURN_RECOVERY_ATTEMPTS)) {
      const current = getChannelTurn(deps.db, turn.id)
      if (current && current.status !== 'completed' && current.attempts >= MAX_TURN_RECOVERY_ATTEMPTS) {
        markInterruptedEventFailed(deps, current, '恢复次数超过上限')
        await closeInterruptedCard(deps, current, '服务重启导致这一轮多次恢复失败，请重新发送一次。')
        finishChannelTurn(deps.db, current.id, 'failed', '恢复次数超过上限')
        summary.closed += 1
      }
      // 否则是其它实例已经接手，当前实例不重复跑。
      continue
    }

    const age = Date.now() - turn.startedAt
    if (age > TURN_RECOVERY_MAX_AGE_MS) {
      const message = '这一轮对话在服务重启前中断，已经超过自动恢复时限，请重新发送一次。'
      markInterruptedEventFailed(deps, turn, '超过恢复时限')
      await closeInterruptedCard(deps, turn, message)
      finishChannelTurn(deps.db, turn.id, 'failed', '超过恢复时限')
      summary.closed += 1
      continue
    }

    const payload = turn.payload
    if (!payload || typeof payload !== 'object') {
      const message = '服务重启导致这一轮中断，请重新发送一次。'
      markInterruptedEventFailed(deps, turn, '原始消息缺失')
      await closeInterruptedCard(deps, turn, message)
      finishChannelTurn(deps.db, turn.id, 'failed', '原始消息缺失')
      summary.failed += 1
      continue
    }
    // 卡片按钮的隐藏续跑在入站时存的是包装对象：真实消息 + clarifyFlow。
    // 恢复时两者必须一起还原，否则会把续跑当普通文本重发，或者续不上原卡。
    const clarifyEnvelope = (payload as {
      kind?: string
      message?: unknown
      clarifyFlow?: { flowId?: string; step?: number; suppressNewCard?: boolean }
    })
    const isClarifyTurn = clarifyEnvelope.kind === 'dingtalk_clarify'
    const messagePayload = isClarifyTurn ? clarifyEnvelope.message : payload
    if (!messagePayload || typeof messagePayload !== 'object') {
      const message = '服务重启导致这一轮中断，请重新发送一次。'
      markInterruptedEventFailed(deps, turn, '原始消息缺失')
      await closeInterruptedCard(deps, turn, message)
      finishChannelTurn(deps.db, turn.id, 'failed', '原始消息缺失')
      summary.failed += 1
      continue
    }

    const session = deps.db
      .prepare('SELECT id FROM chat_sessions WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1')
      .get(turn.sessionId, deps.companyId) as { id: string } | undefined
    if (!session) {
      const message = '服务重启导致这一轮中断，原会话已失效，请重新发送一次。'
      markInterruptedEventFailed(deps, turn, '会话已失效')
      await closeInterruptedCard(deps, turn, message)
      finishChannelTurn(deps.db, turn.id, 'failed', '会话已失效')
      summary.failed += 1
      continue
    }

    const user = findActivePerson(deps.db, turn.userId)
    if (!user) {
      const message = '服务重启导致这一轮中断，原成员身份已失效，请重新发送一次。'
      markInterruptedEventFailed(deps, turn, '成员已失效')
      await closeInterruptedCard(deps, turn, message)
      finishChannelTurn(deps.db, turn.id, 'failed', '成员已失效')
      summary.failed += 1
      continue
    }

    try {
      console.log(`[eab] 恢复中断回合 ${turn.id}（第 ${turn.attempts + 1} 次，会话 ${turn.sessionId}）`)
      const result = await runTurn(deps, messagePayload as DingTalkMessage, {
        dedupe: false,
        sessionId: turn.sessionId,
        resume: {
          turnId: turn.id,
          userMessageId: turn.userMessageId || '',
          assistantMessageId: turn.assistantMessageId || turn.id,
          cardInstanceId: turn.cardInstanceId,
          cardKind: turn.cardKind,
          agentTurnId: turn.agentTurnId,
          priorTools: priorToolNames(turn),
        },
        // 恢复 clarify 续跑时允许续用原卡；suppressNewCard 只用于正常回调路径，
        // 恢复路径没有外部 card，必须靠 resume.cardInstanceId 把旧卡接回来。
        clarifyFlow: isClarifyTurn
          ? {
              flowId: String(clarifyEnvelope.clarifyFlow?.flowId || ''),
              step: Math.max(1, Math.trunc(Number(clarifyEnvelope.clarifyFlow?.step) || 1)),
              assistantMessageId: turn.assistantMessageId || turn.id,
              suppressNewCard: false,
            }
          : undefined,
      })
      if (!result.handled) {
        throw new Error(result.text || result.reason || '恢复后未能继续回答')
      }
      summary.resumed += 1
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[eab] 中断回合恢复失败 ${turn.id}：`, message)
      finishChannelTurn(deps.db, turn.id, 'failed', message)
      markInterruptedEventFailed(deps, turn, message)
      await closeInterruptedCard(deps, turn, '服务重启导致这一轮回答中断，请重新发送一次。')
      summary.failed += 1
    }
  }

  console.log(
    `[eab] 中断回合恢复完成：继续 ${summary.resumed} / 收口 ${summary.closed} / 失败 ${summary.failed}`,
  )
  return summary
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
  /** 当前领导权持有者；旧版本租约只带 legacy 标记。 */
  readonly leader: LeaderOwner | null
}

function cardCallbackContent(raw: unknown): {
  actionIds: string[]
  params: Record<string, unknown>
} {
  const value = typeof raw === 'string' ? JSON.parse(raw) as Record<string, unknown> : raw
  if (!value || typeof value !== 'object') return { actionIds: [], params: {} }
  const content = value as Record<string, unknown>
  const privateData = content.cardPrivateData
  const privateObject = privateData && typeof privateData === 'object'
    ? privateData as Record<string, unknown>
    : content
  const actionIds = Array.isArray(privateObject.actionIds)
    ? privateObject.actionIds.map((item) => String(item ?? '')).filter(Boolean)
    : []
  const rawParams = privateObject.params
  const params = typeof rawParams === 'string'
    ? JSON.parse(rawParams) as Record<string, unknown>
    : rawParams && typeof rawParams === 'object'
      ? rawParams as Record<string, unknown>
      : privateObject
  return { actionIds, params }
}

/** 回调参数可能是扁平对象，也可能包在 context 里；递归找第一个字符串值。 */
function cardParamString(value: unknown, key: string, depth = 0): string {
  if (!value || depth > 5) return ''
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = cardParamString(item, key, depth + 1)
      if (found) return found
    }
    return ''
  }
  if (typeof value !== 'object') return ''
  const object = value as Record<string, unknown>
  for (const [name, item] of Object.entries(object)) {
    if (name === key) {
      if (typeof item === 'string' || typeof item === 'number') return String(item)
      if (item && typeof item === 'object') {
        const nestedValue = (item as Record<string, unknown>).value
        if (typeof nestedValue === 'string' || typeof nestedValue === 'number') return String(nestedValue)
      }
    }
  }
  for (const item of Object.values(object)) {
    if (item && typeof item === 'object') {
      const found = cardParamString(item, key, depth + 1)
      if (found) return found
    }
  }
  return ''
}

/** A2UI 提交按钮的 context 可能是数组；优先取原始值，兼容包在 value 里的回传。 */
function cardParamValue(value: unknown, key: string, depth = 0): unknown {
  if (!value || depth > 5) return undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = cardParamValue(item, key, depth + 1)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (typeof value !== 'object') return undefined
  const object = value as Record<string, unknown>
  if (key in object) {
    const item = object[key]
    if (item && typeof item === 'object' && !Array.isArray(item) && 'value' in (item as Record<string, unknown>)) {
      return (item as Record<string, unknown>).value
    }
    return item
  }
  for (const item of Object.values(object)) {
    if (item && typeof item === 'object') {
      const found = cardParamValue(item, key, depth + 1)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/** 多选值可能回传数组、JSON 字符串或顿号分隔文本；统一拆成 id/标签列表。 */
function cardParamList(value: unknown, key: string): string[] {
  const raw = cardParamValue(value, key)
  let items: unknown[] = []
  if (Array.isArray(raw)) items = raw
  else if (typeof raw === 'string') {
    const text = raw.trim()
    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text) as unknown
        if (Array.isArray(parsed)) items = parsed
      } catch {
        items = text.split(/[,，、]/)
      }
    } else {
      items = text.split(/[,，、]/)
    }
  } else if (raw !== undefined && raw !== null) {
    items = [raw]
  }
  return items
    .map((item) => {
      if (typeof item === 'string' || typeof item === 'number') return String(item).trim()
      if (item && typeof item === 'object') {
        const object = item as Record<string, unknown>
        return String(object.value ?? object.id ?? object.label ?? '').trim()
      }
      return ''
    })
    .filter(Boolean)
}

/** 逐空输入值需要保留位置和空串，不能复用按顿号/逗号拆分的多选解析。 */
function cardParamTextList(value: unknown, key: string): string[] {
  const raw = cardParamValue(value, key)
  let items: unknown[] = []
  if (Array.isArray(raw)) items = raw
  else if (typeof raw === 'string') {
    const text = raw.trim()
    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text) as unknown
        if (Array.isArray(parsed)) items = parsed
      } catch {
        items = [text]
      }
    } else if (text) {
      items = [text]
    }
  } else if (raw !== undefined && raw !== null) {
    items = [raw]
  }
  return items
    .slice(0, 8)
    .map((item) => {
      if (typeof item === 'string' || typeof item === 'number') return String(item).trim().slice(0, 200)
      if (item && typeof item === 'object') {
        const object = item as Record<string, unknown>
        return String(object.value ?? object.text ?? object.label ?? '').trim().slice(0, 200)
      }
      return ''
    })
}

/** 当前页回传的勾选/文本整理成草稿。 */
function clarifyAnswerFor(
  question: DingTalkClarifyQuestion,
  selectedIds: string[],
  answerInput: string,
  blankInputs: string[] = [],
): DingTalkClarifyAnswer {
  const kind = question.kind === 'multiple' || question.kind === 'text' ? question.kind : 'single'
  if (kind === 'text') {
    const blanks = blankInputs.map((value) => String(value ?? '').trim().slice(0, 200))
    return {
      selected: [],
      text: blanks.length > 0 ? blanks.join('、') : String(answerInput ?? '').trim().slice(0, 500),
      ...(blanks.length > 0 ? { blanks } : {}),
    }
  }
  return { selected: selectedIds.map((value) => String(value)), text: '' }
}

/** 把选项 id 还原成用户能读懂的标签；找不到时回退原始值。 */
function clarifyAnswerLabel(question: DingTalkClarifyQuestion, answer: DingTalkClarifyAnswer): string {
  const kind = question.kind === 'multiple' || question.kind === 'text' ? question.kind : 'single'
  if (kind === 'text') {
    const blanks = (answer.blanks ?? []).map((value) => String(value ?? '').trim()).filter(Boolean)
    if (blanks.length > 0) return blanks.map((value, index) => `第${index + 1}空：${value}`).join('；')
    return String(answer.text ?? '').trim()
  }
  const labels = (answer.selected ?? []).map((id) => {
    const option = (question.options ?? []).find((item) => item.id === id || item.label === id)
    return option?.label ?? id
  })
  return labels.filter(Boolean).join('、')
}

function clarifyAnswerEmpty(question: DingTalkClarifyQuestion, answer: DingTalkClarifyAnswer): boolean {
  const kind = question.kind === 'multiple' || question.kind === 'text' ? question.kind : 'single'
  if (kind !== 'text') return (answer.selected ?? []).length === 0
  const blanks = answer.blanks ?? []
  if (blanks.length > 0) return blanks.some((value) => !String(value ?? '').trim())
  return !String(answer.text ?? '').trim()
}

/** 多题统一提交时合成一条完整答卷，模型只看到这一条 user 消息。 */
function composeClarifyBatchText(
  questions: DingTalkClarifyQuestion[],
  answers: Record<string, DingTalkClarifyAnswer>,
): string {
  const lines = questions.map((question, index) => {
    const answer = answers[String(index + 1)] ?? { selected: [], text: '' }
    const value = clarifyAnswerLabel(question, answer) || '（未作答）'
    return `第${index + 1}题（${question.question}）：${value}`
  })
  return `我完成了以下 ${questions.length} 道题：\n${lines.join('\n')}`
}

/**
 * A2UI 思考/工具面板的展开态只在进程内保存：卡片本身不持久化展开状态，
 * 这样用户点开后，后续流式更新不会把面板重新收起。键为 outTrackId + panel。
 */
const a2uiPanelOpenState = new Map<string, boolean>()

/** 处理钉钉卡片按钮回调。回调本身必须在 2 秒内 ACK，所以这里只做身份/会话校验，
 * 真正的模型回合由调用方的异步任务继续跑；同一张卡片只接受第一次选择。
 */
export async function handleDingTalkCardCallback(
  deps: ServerDeps,
  payload: DingTalkCardCallbackPayload,
): Promise<void> {
  if (String(payload.type ?? '') !== 'actionCallback') return
  const outTrackId = String(payload.outTrackId ?? '').trim()
  const externalId = String(payload.userId ?? '').trim()
  if (!outTrackId || !externalId) return
  // 模型点选已经把这张卡消费完：后续再点同一张卡直接忽略，
  // 不能因为卡片收口失败就重新跑一轮 Agent、再冒出一条独立消息。
  if (isDingTalkClarifyCardConsumed(outTrackId)) return

  let content: { actionIds: string[]; params: Record<string, unknown> }
  try {
    content = cardCallbackContent(payload.content)
  } catch {
    console.warn('[eab] 钉钉卡片回调 content 不是合法 JSON，已忽略')
    return
  }

  const actionIds = content.actionIds
  const params = content.params
  const registered = dingTalkClarifyCardState(outTrackId)
  // A2UI 思考/工具入口的卡片不一定在进程内有澄清登记；用 outTrackId 反查本轮会话，
  // 这样点击回调不依赖客户端是否完整回传 sessionId。
  const cardTurn = deps.db
    .prepare(
      `SELECT session_id, external_id, card_kind, status
         FROM channel_turns
        WHERE provider = 'dingtalk' AND card_instance_id = ? AND external_id = ?
        ORDER BY started_at DESC
        LIMIT 1`,
    )
    .get(outTrackId, externalId) as
    | { session_id: string; external_id: string; card_kind: string | null; status: string }
    | undefined
  let sessionId = cardParamString(params, 'sessionId') || registered?.sessionId || cardTurn?.session_id || ''
  const cardAction = cardParamString(params, 'action')
  const batchQuestions = registered?.questions ?? []
  const batchIndex = Math.min(
    Math.max(0, Math.trunc(Number(registered?.index ?? 0) || 0)),
    Math.max(0, batchQuestions.length - 1),
  )
  const batchCurrent = batchQuestions.length > 0 ? batchQuestions[batchIndex] : null
  const registeredOptions = batchCurrent?.options ?? registered?.options ?? []
  const registeredKind: 'single' | 'multiple' | 'text' =
    batchCurrent?.kind === 'multiple' || batchCurrent?.kind === 'text'
      ? batchCurrent.kind
      : batchCurrent
        ? 'single'
        : registered?.kind === 'multiple' || registered?.kind === 'text'
          ? registered.kind
          : cardAction === 'clarify_multi'
            ? 'multiple'
            : cardAction === 'clarify_text'
              ? 'text'
              : 'single'
  const selectedIds = cardParamList(params, 'selected')
  const blankInputs = cardParamTextList(params, 'blanks')
  const answerInput = (blankInputs.length > 0 ? blankInputs.join('、') : cardParamString(params, 'text')).trim().slice(0, 500)
  let optionId = cardParamString(params, 'optionId')
  let optionLabel = ''

  if (registered && sessionId && sessionId !== registered.sessionId) {
    console.warn('[eab] 钉钉卡片回调：sessionId 与卡片登记不一致，已拒绝')
    return
  }
  if (!sessionId) {
    console.warn('[eab] 钉钉卡片回调缺少 sessionId，已忽略')
    return
  }

  // 思考/工具单行入口：只切换当前卡的正文显隐，不进入模型回合。
  // 旧卡片没有登记 channel_turn 时拒绝，避免任意卡片回调切换其他会话的面板。
  if (cardAction === 'panel_toggle') {
    const panel = cardParamString(params, 'panel')
    if (panel !== 'thinking' && panel !== 'tools') {
      console.warn('[eab] 钉钉面板切换：未知 panel，已忽略')
      return
    }
    if (!cardTurn || cardTurn.card_kind !== 'a2ui' || cardTurn.session_id !== sessionId) {
      console.warn('[eab] 钉钉面板切换：卡片与会话不匹配，已拒绝')
      return
    }
    const cfg = dingTalkConfig(deps.db, deps.companyId)
    const channelSecret = cfg?.secret_ref ? resolveSecret(deps.config.dbPath, cfg.secret_ref) : null
    if (!cfg?.app_id || !channelSecret) {
      console.warn('[eab] 钉钉面板切换：渠道凭证不完整')
      return
    }
    const key = `${outTrackId}:${panel}`
    const current = a2uiPanelOpenState.get(key) === true
    const expanded = !current
    const stream = new DingTalkAICardStream(
      cfg.app_id,
      channelSecret,
      externalId,
      cfg.robot_code || cfg.app_id,
    )
    // 回调必须在 2 秒内 ACK；卡片更新接口不能在回调栈里同步等待，
    // 先返回，再异步更新原卡，避免钉钉判定回调超时。
    void stream
      .togglePanel(outTrackId, panel, expanded)
      .then((updated) => {
        if (!updated) {
          console.warn('[eab] 钉钉面板切换：更新原卡失败')
          return
        }
        a2uiPanelOpenState.set(key, expanded)
        // 单进程内只保留少量最近卡片，防止长期运行后 Map 无限增长。
        if (a2uiPanelOpenState.size > 200) {
          const oldest = a2uiPanelOpenState.keys().next().value
          if (oldest) a2uiPanelOpenState.delete(oldest)
        }
      })
      .catch((error) => {
        console.warn('[eab] 钉钉面板切换：更新原卡异常', error)
      })
    return
  }

  // 工具执行审批卡：sessionId 是 toolapproval:<approvalId>；必须在题组/模型分支前拦截。
  if (isToolApprovalCardSession(sessionId)) {
    const consumed = await handleToolApprovalCardCallback(deps, {
      outTrackId,
      externalUserId: externalId,
      sessionId,
      optionId,
      actionIds,
    })
    if (consumed) return
  }

  // 权限审批卡复用 clarify 的选项组件，但 sessionId 是 approval:<requestId>:<stepNo>；
  // 必须在题组/模型分支前拦截，直接走审批状态机。
  if (sessionId.startsWith('approval:')) {
    const consumed = await handlePermissionApprovalCardCallback(deps, {
      outTrackId,
      externalUserId: externalId,
      sessionId,
      optionId,
      actionIds,
    })
    if (consumed) return
  }

  // 题组翻页：保存当前页草稿、切换 index，只更新同一张卡；不写幂等事件、不调用模型。
  if (cardAction === 'clarify_nav') {
    const questions = registered?.questions ?? []
    if (!registered || questions.length < 2) {
      console.warn('[eab] 钉钉题组翻页：卡片没有题组登记，已忽略')
      return
    }
    const userId = resolveDingTalkUser(deps.db, deps.companyId, externalId)
    if (!userId) {
      console.warn('[eab] 钉钉题组翻页：外部账号还没有绑定 EAB 成员')
      return
    }
    const person = findActivePerson(deps.db, userId)
    if (!person) {
      console.warn('[eab] 钉钉题组翻页：EAB 成员不存在或已停用')
      return
    }
    const actor = actorFor(deps.db, person)
    if (!scopeAllows(actor.subject.scopes, SC.CHAT_USE) || !scopeAllows(actor.subject.scopes, SC.MODEL_USE)) {
      console.warn('[eab] 钉钉题组翻页：当前成员没有对话或模型权限')
      return
    }
    const session = deps.db
      .prepare(
        `SELECT id FROM chat_sessions
          WHERE id = ? AND company_id = ? AND user_id = ? AND source = 'dingtalk'
            AND external_id = ? AND deleted_at IS NULL
          LIMIT 1`,
      )
      .get(sessionId, deps.companyId, userId, externalId) as { id: string } | undefined
    if (!session) {
      console.warn('[eab] 钉钉题组翻页：sessionId 不属于当前钉钉用户，已拒绝')
      return
    }
    const current = Math.min(
      Math.max(0, Math.trunc(Number(cardParamString(params, 'index') ?? registered.index ?? 0) || 0)),
      questions.length - 1,
    )
    const direction = cardParamString(params, 'direction').toLowerCase()
    const navOptionId = cardParamString(params, 'optionId')
    const target =
      direction === 'prev'
        ? current - 1
        : direction === 'next'
          ? current + 1
          : current
    // pick：最后一题点选项只保存选中，不离开当前页；其余方向必须真的换页。
    if (target < 0 || target >= questions.length || (target === current && direction !== 'pick')) return
    const draftSelected = navOptionId ? [navOptionId] : selectedIds
    const draft = clarifyAnswerFor(questions[current], draftSelected, answerInput, blankInputs)
    // 先存当前页草稿，再切到目标页；返回上一题时能把刚答的内容回填。
    updateDingTalkClarifyDraft(outTrackId, current, draft)
    const next = updateDingTalkClarifyIndex(outTrackId, target)
    if (!next) return
    const cfg = dingTalkConfig(deps.db, deps.companyId)
    const channelSecret = cfg?.secret_ref ? resolveSecret(deps.config.dbPath, cfg.secret_ref) : null
    if (!cfg?.app_id || !channelSecret) return
    const stream = new DingTalkAICardStream(
      cfg.app_id,
      channelSecret,
      externalId,
      cfg.robot_code || cfg.app_id,
    )
    const updated = await stream.updateClarify(outTrackId, {
      answer: '',
      reasoning: '',
      tools: [],
      thinkingDone: true,
      toolDetails: [],
      clarify: next,
    })
    if (!updated) console.warn('[eab] 钉钉题组翻页：更新原卡失败')
    return
  }

  if (registeredKind === 'single') {
    // 题组单选在最后一页先点选项、再点“提交全部”；提交按钮本身不带 optionId，
    // 从当前页选中值或已存草稿里取回，避免被单题校验挡掉。
    if (!optionId && batchCurrent) {
      optionId =
        selectedIds[0]
        || registered?.answers?.[String(batchIndex + 1)]?.selected?.[0]
        || ''
    }
    if (!optionId) {
      // 兼容只回传选项卡片/文案组件 ID 的情况：clarifyOptionCard0 对应 option-1。
      const option = actionIds.find((id) => /^clarifyOption(?:Card|Body|Label)?[0-3]$/.test(id))
      const index = option ? Number(option.match(/[0-3]$/)?.[0] ?? -1) : -1
      if (index >= 0) optionId = `option-${index + 1}`
    }
    if (!optionId) {
      console.warn('[eab] 钉钉卡片回调缺少 sessionId/optionId，已忽略')
      return
    }
    if (registered && !registeredOptions.some((option) => option.id === optionId)) {
      console.warn('[eab] 钉钉卡片回调：选项不属于当前卡片，已拒绝')
      return
    }
    // 优先用服务端登记的选项文案，避免只信任客户端回传的 context。
    optionLabel =
      registeredOptions.find((option) => option.id === optionId)?.label
      || cardParamString(params, 'optionLabel')
    if (!optionLabel) {
      const index = Number(optionId.replace(/^option-/, ''))
      optionLabel = Number.isFinite(index) && index > 0 ? `第 ${index} 个方向` : '用户选择的方向'
    }
  } else if (registeredKind === 'multiple') {
    if (selectedIds.length === 0) {
      console.warn('[eab] 钉钉卡片回调：多选提交为空，已忽略')
      return
    }
    const matched = selectedIds.map((id) => {
      const option = registeredOptions.find((item) => item.id === id || item.label === id)
      return option || { id, label: id }
    })
    optionLabel = matched.map((option) => option.label).join('、')
  } else if (registeredKind === 'text') {
    if (blankInputs.length > 0 && blankInputs.some((value) => !value.trim())) {
      console.warn('[eab] 钉钉卡片回调：填空题还有空位未填写，已忽略')
      return
    }
    if (!answerInput) {
      console.warn('[eab] 钉钉卡片回调：填空提交为空，已忽略')
      return
    }
    optionLabel = blankInputs.length > 0
      ? blankInputs.map((value, index) => `第${index + 1}空：${value}`).join('；')
      : answerInput
  }
  if (registered && registeredKind !== 'single' && cardAction && cardAction !== 'clarify_multi' && cardAction !== 'clarify_text') {
    console.warn('[eab] 钉钉卡片回调：未知的提交动作，已拒绝')
    return
  }

  const isBatch = Boolean(registered && batchQuestions.length > 1 && batchCurrent)
  let batchAnswers: Record<string, DingTalkClarifyAnswer> = registered?.answers ?? {}
  let answerText = registeredKind === 'text'
    ? `我的答案是「${optionLabel.slice(0, 200)}」。`
    : `我选择了「${optionLabel.slice(0, 200)}」。`

  if (isBatch && batchCurrent) {
    let draft = clarifyAnswerFor(batchCurrent, selectedIds, answerInput, blankInputs)
    const existing = batchAnswers[String(batchIndex + 1)]
    // 单选选项在上一次点击时已经存进草稿；提交按钮可能不再回传选中值，沿用已有答案。
    if (clarifyAnswerEmpty(batchCurrent, draft) && existing && !clarifyAnswerEmpty(batchCurrent, existing)) {
      draft = existing
    }
    if (clarifyAnswerEmpty(batchCurrent, draft)) {
      console.warn('[eab] 钉钉题组提交：当前题还没有作答，已忽略')
      return
    }
    const updated = updateDingTalkClarifyDraft(outTrackId, batchIndex, draft)
    batchAnswers = updated?.answers ?? { ...batchAnswers, [String(batchIndex + 1)]: draft }
    const missing = batchQuestions.findIndex((question, index) => {
      const answer = batchAnswers[String(index + 1)]
      return !answer || clarifyAnswerEmpty(question, answer)
    })
    if (missing >= 0) {
      console.warn(`[eab] 钉钉题组提交：第 ${missing + 1} 题还没有作答，已忽略`)
      return
    }
    optionLabel = batchQuestions
      .map((question, index) => clarifyAnswerLabel(question, batchAnswers[String(index + 1)] ?? { selected: [], text: '' }))
      .filter(Boolean)
      .join('；')
    answerText = composeClarifyBatchText(batchQuestions, batchAnswers)
  }

  const userId = resolveDingTalkUser(deps.db, deps.companyId, externalId)
  if (!userId) {
    console.warn('[eab] 钉钉卡片回调：外部账号还没有绑定 EAB 成员')
    return
  }
  const person = findActivePerson(deps.db, userId)
  if (!person) {
    console.warn('[eab] 钉钉卡片回调：EAB 成员不存在或已停用')
    return
  }
  const actor = actorFor(deps.db, person)
  if (!scopeAllows(actor.subject.scopes, SC.CHAT_USE) || !scopeAllows(actor.subject.scopes, SC.MODEL_USE)) {
    console.warn('[eab] 钉钉卡片回调：当前成员没有对话或模型权限')
    return
  }

  const session = deps.db
    .prepare(
      `SELECT id FROM chat_sessions
        WHERE id = ? AND company_id = ? AND user_id = ? AND source = 'dingtalk'
          AND external_id = ? AND deleted_at IS NULL
        LIMIT 1`,
    )
    .get(sessionId, deps.companyId, userId, externalId) as { id: string } | undefined
  if (!session) {
    console.warn('[eab] 钉钉卡片回调：sessionId 不属于当前钉钉用户，已拒绝')
    return
  }

  /**
   * 服务端重启会清空内存里的卡片登记表；这时从会话里最后一条带 clarify 的
   * assistant 消息恢复 flowId/messageId，仍然把回答写回同一条消息。
   */
  let assistantMessageId = registered?.messageId || ''
  let flowId = registered?.flowId || ''
  let questionStep = Number(registered?.step ?? 0)
  let clarifyQuestion = String(registered?.question ?? '')
  let fallbackOptions: Array<{ id: string; label: string }> = []
  // 模型卡没有对应的 assistant 消息；若仍按历史消息兜底，会误把上一条
  // 真实澄清消息当成这张卡的归属，点选模型后改写错消息。
  if (!assistantMessageId && registered?.origin !== 'model-picker') {
    const rows = deps.db
      .prepare(
        `SELECT id, meta_json FROM chat_messages
          WHERE session_id = ? AND role = 'assistant'
          ORDER BY created_at DESC LIMIT 20`,
      )
      .all(sessionId) as Array<{ id: string; meta_json: string | null }>
    for (const row of rows) {
      try {
        const meta = JSON.parse(row.meta_json || '{}') as {
          clarify?: unknown
          clarifyFlowId?: unknown
          clarifyStep?: unknown
        }
        if (!meta.clarify || typeof meta.clarify !== 'object') continue
        const clarify = meta.clarify as {
          question?: unknown
          options?: Array<{ id?: unknown; label?: unknown }>
        }
        assistantMessageId = row.id
        flowId = typeof meta.clarifyFlowId === 'string' ? meta.clarifyFlowId : ''
        questionStep = Number(meta.clarifyStep) || 0
        clarifyQuestion = String(clarify.question ?? '')
        fallbackOptions = (clarify.options ?? [])
          .map((option) => ({
            id: String(option.id ?? ''),
            label: String(option.label ?? ''),
          }))
          .filter((option) => option.id)
        break
      } catch {
        // 跳过损坏的历史 meta
      }
    }
  }
  if (fallbackOptions.length > 0 && registeredKind === 'single') {
    const option = fallbackOptions.find((item) => item.id === optionId)
    if (!option) {
      console.warn('[eab] 钉钉卡片回调：选项不属于这条澄清消息，已拒绝')
      return
    }
    if (!optionLabel) optionLabel = option.label
  }
  if (!questionStep) questionStep = 1
  if (!flowId && assistantMessageId) flowId = `cf_${assistantMessageId}`

  const clarifyNextStep = isBatch
    ? batchQuestions.length + 1
    : Math.max(1, Math.trunc(questionStep)) + 1
  const cardQuestionStep = isBatch ? clarifyNextStep : Math.max(1, Math.trunc(questionStep))
  // 同一张卡片会承载多页澄清；幂等键必须带上当前页和实际提交值，
  // 否则第二页按钮、或多选题里不同选择会被整卡幂等挡住。
  const answerKey = isBatch
    ? `batch:${batchQuestions.length}:${optionLabel}`
    : registeredKind === 'single'
      ? optionId
      : `${registeredKind}:${optionLabel}`
  const cardEventKey = `card:${outTrackId}:${externalId}:${cardQuestionStep}:${answerKey.slice(0, 120)}`
  const inserted = deps.db
    .prepare(
      `INSERT INTO channel_events (id, company_id, provider, event_key, sender_id, received_at)
       VALUES (?, ?, 'dingtalk', ?, ?, ?)
       ON CONFLICT (provider, event_key) DO NOTHING`,
    )
    .run(`evt_${randomUUID()}`, deps.companyId, cardEventKey, externalId, Date.now())
  if (Number(inserted.changes) === 0) return

  const cfg = dingTalkConfig(deps.db, deps.companyId)
  const channelSecret = cfg?.secret_ref ? resolveSecret(deps.config.dbPath, cfg.secret_ref) : null

  /**
   * 模型选择卡片走静默切换：这是用户点选，不是自然语言提问，不需要再跑一轮
   * Agent，也不该生成一条新的“已切换模型”消息。直接写会话偏好，并把结果
   * 收口回用户点的同一张卡；卡片失效时宁可无提示，也不再补发文字气泡。
   */
  let selectedModel: ReturnType<typeof planChannelModelSelection> = null
  if (!isBatch && registeredKind === 'single' && /(模型|model)/i.test(clarifyQuestion)) {
    const catalog = await loadModelCatalogCached(
      deps.db,
      actor.subject.companyId,
      deps.config.devAuth,
      actor.subject.userId,
    )
    const available = visibleModelsFor(catalog, [...actor.subject.roles], actor.subject.companyId)
      .filter((item) => (item.endpointKind ?? 'chat') === 'chat')
    selectedModel = planChannelModelSelection(clarifyQuestion, optionLabel, available)
  }
  if (selectedModel) {
    const stored = deps.db
      .prepare('SELECT model_id FROM chat_sessions WHERE id = ? AND deleted_at IS NULL')
      .get(sessionId) as { model_id: string | null } | undefined
    const currentModelId = stored?.model_id ?? null
    const changed = currentModelId !== selectedModel.modelId
    if (changed) {
      updateConversationModelPreference(deps.db, {
        companyId: actor.subject.companyId,
        userId: actor.person.id,
        sessionId,
        modelId: selectedModel.modelId,
      })
    }
    const confirmation = selectedModel.modelId
      ? changed
        ? `已切换到「${selectedModel.modelName}」，下一条消息开始使用。`
        : `当前已经在使用「${selectedModel.modelName}」。`
      : changed
        ? '已切回自动选择，下一条消息开始按可用模型自动选择。'
        : '当前已经是自动选择。'

    const richState: DingTalkRichCardState = {
      answer: confirmation,
      reasoning: '',
      tools: [],
      thinkingDone: true,
      toolDetails: [],
      clarify: null,
    }
    let cardUpdated = false
    if (cfg?.app_id && channelSecret) {
      const stream = new DingTalkAICardStream(
        cfg.app_id,
        channelSecret,
        externalId,
        cfg.robot_code || cfg.app_id,
      )
      cardUpdated = await stream.completeClarify(outTrackId, richState)
      if (!cardUpdated) {
        const resumed = await stream.resume(outTrackId, richState)
        if (resumed) cardUpdated = await stream.finish(richState)
      }
    }
    if (!cardUpdated) {
      console.info(
        `[eab] 钉钉模型点选：原卡已失效，已静默切换为「${selectedModel.modelName}」，不补发文字消息`,
      )
    }

    // 网页工作台和钉钉共用同一份历史：把原来那张提问卡改成切换结果，
    // 不在消息列表里留下一个永远等你点选的旧问题。
    if (assistantMessageId) {
      const row = deps.db
        .prepare('SELECT id, meta_json FROM chat_messages WHERE id = ? AND role = ? LIMIT 1')
        .get(assistantMessageId, 'assistant') as { id: string; meta_json: string | null } | undefined
      if (row) {
        try {
          const meta = JSON.parse(row.meta_json || '{}') as Record<string, unknown>
          const clarify = meta.clarify as { question?: unknown } | null | undefined
          if (clarify && String(clarify.question ?? '') === clarifyQuestion) {
            deps.db
              .prepare('UPDATE chat_messages SET text = ?, meta_json = ? WHERE id = ?')
              .run(
                confirmation,
                JSON.stringify({ ...meta, clarify: null, interaction: 'model_select' }),
                assistantMessageId,
              )
          }
        } catch (error) {
          console.warn('[eab] 钉钉模型点选改写历史失败：', (error as Error).message)
        }
      }
    }

    forgetDingTalkClarifyCard(outTrackId)
    deps.db
      .prepare('UPDATE channel_events SET result_json = ? WHERE provider = ? AND event_key = ?')
      .run(
        JSON.stringify({
          phase: 'model-select',
          target: selectedModel.modelId,
          changed,
          cardUpdated,
          outTrackId,
        }),
        'dingtalk',
        cardEventKey,
      )
    return
  }

  let resumedCard: DingTalkAICardStream | undefined
  if (cfg?.app_id && channelSecret) {
    const stream = new DingTalkAICardStream(
      cfg.app_id,
      channelSecret,
      externalId,
      cfg.robot_code || cfg.app_id,
    )
    const resumed = await stream.resume(outTrackId, {
      answer: '',
      reasoning: isBatch
        ? `已收到全部 ${batchQuestions.length} 道题的答案，正在统一判分…`
        : `已收到你的${registeredKind === 'text' ? '答案' : '选择'}「${optionLabel.slice(0, 40)}」，正在继续…`,
      tools: [],
      thinkingDone: false,
      toolDetails: [],
      clarify: null,
    })
    if (resumed) resumedCard = stream
  }
  // 把续用结果留在事件里，真机排查时能直接看出是“原卡续用”还是“续用失败”。
  deps.db
    .prepare('UPDATE channel_events SET result_json = ? WHERE provider = ? AND event_key = ?')
    .run(JSON.stringify({ phase: 'resume', resumed: Boolean(resumedCard), outTrackId }), 'dingtalk', cardEventKey)

  const synthetic: DingTalkMessage = {
    msgtype: 'text',
    text: { content: answerText },
    senderStaffId: externalId,
    senderId: externalId,
    senderNick: person.name,
    robotCode: cfg?.robot_code ?? cfg?.app_id ?? undefined,
    conversationType: '1',
    msgId: `card_${outTrackId}_${answerKey.slice(0, 60)}`,
    createAt: Date.now(),
  }
  let result: Awaited<ReturnType<typeof handleDingTalkMessage>>
  try {
    result = await handleDingTalkMessage(deps, synthetic, {
      sessionId,
      dedupe: false,
      card: resumedCard,
      clarifyFlow: assistantMessageId
        ? {
            flowId: flowId || `cf_${assistantMessageId}`,
            step: clarifyNextStep,
            assistantMessageId,
            // 原卡续用失败时也不新建卡片，避免真机出现第二条机器人消息。
            suppressNewCard: true,
          }
        : {
            flowId: flowId || `cf_card_${outTrackId}`,
            step: clarifyNextStep,
            suppressNewCard: true,
          },
    })
  } catch (error) {
    if (resumedCard) await resumedCard.fail('处理失败，请稍后再试。')
    console.warn('[eab] 钉钉卡片回调续跑失败：', (error as Error).message)
    return
  }
  if (result.text) {
    // 复用原卡片时，错误/权限提示直接落到原卡片，避免再发一条文字。
    const shownOnCard = resumedCard ? await resumedCard.fail(result.text) : false
    if (!shownOnCard) await notifyDingTalkUser(deps, externalId, result.text)
  }
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
    leader: streamLeaderOwner,
  }
}

let refreshPromise: Promise<void> | null = null

/**
 * 钉钉 Stream 长连接是「一条连接对应一个机器人」：多实例各连一份会重复收到消息、
 * 重复给用户回复。这里用 Redis 租约选一个实例持有连接，其余实例只待命。
 * 没接 Redis 时租约恒为「本实例持有」，行为与升级前一致。
 */
let streamLeader: LeaderHold | null = null
let streamLeaderKey = ''
let streamLeaderOwner: LeaderOwner | null = null

async function ensureStreamLeadership(appId: string): Promise<boolean> {
  const key = `dingtalk-stream:${appId}`
  if (streamLeader && streamLeaderKey === key && streamLeader.isHeld()) {
    streamLeaderOwner = streamLeader.owner
    return true
  }
  streamLeader?.release()
  streamLeader = null
  streamLeaderKey = key
  streamLeader = await acquireLeaderHold(key, { ttlMs: 90_000 })
  if (streamLeader?.isHeld()) {
    streamLeaderOwner = streamLeader.owner
    return true
  }
  // 待命时把真正持有者读出来，控制台能直接看到是主机/PID 还是旧版本租约。
  streamLeaderOwner = await readLeaderOwner(key)
  return false
}

function releaseStreamLeadership(): void {
  streamLeader?.release()
  streamLeader = null
  streamLeaderKey = ''
  streamLeaderOwner = null
}

function describeLeader(owner: LeaderOwner | null): string {
  if (!owner) return '未知实例'
  if (owner.legacy) return '旧版本租约（无实例信息）'
  if (!owner.host) return owner.instanceId || '未知实例'
  return `${owner.host} · PID ${owner.pid}`
}

/**
 * 进程退出时显式释放 Stream 领导权。
 * `stopDingTalkStream` 只断连接，不释放租约；如果重启时不调用本函数，
 * 新进程会等旧租约的 90 秒 TTL 过期，期间钉钉消息完全收不到。
 */
export function releaseDingTalkStreamLeadership(): void {
  releaseStreamLeadership()
}

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
    releaseStreamLeadership()
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
  // 多实例部署时只让一个实例持有这条长连接，避免同一条消息被两个实例各回一次。
  if (!(await ensureStreamLeadership(cfg.app_id))) {
    if (streamState.client) stopDingTalkStream()
    const reason = `钉钉 Stream 正由另一实例持有（${describeLeader(streamLeaderOwner)}），本实例待命（Redis 领导权）`
    // 只在原因变化时打一次，避免 10 秒巡检刷屏；否则线上只看到“已绑定”，
    // 机器人静默无响应时无从判断是配置、密钥还是领导权。
    if (streamState.error !== reason) console.warn(`[eab] ${reason}`)
    streamState.error = reason
    return
  }
  if (streamState.client && streamState.appId === cfg.app_id) {
    // SDK 的 registered 在部分网关环境不会置位，不能拿它当“必须重建”的条件；
    // 心跳断开时 SDK 会自行重连并把 connected 置 false，这里只判断是否掉线。
    if (streamState.client.connected || streamState.client.registered) {
      streamState.error = null
      return
    }
    if (streamState.client.reconnecting) return
  }

  stopDingTalkStream()
  const { DWClient, TOPIC_CARD, TOPIC_ROBOT } = await import('dingtalk-stream')
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
        let textSent = !result.text
        if (result.text && payload.sessionWebhook) {
          await replySessionWebhook(deps, payload.sessionWebhook, result.text)
          textSent = true
        }
        // 语音是文字后的附加通道；文字没发出去时不要只发一条语音。
        if (result.voice && textSent) {
          try {
            await sendDingTalkVoiceReply(deps, result.voice.companyId, result.voice.userId, result.voice.text)
          } catch (error) {
            console.warn('[eab] 钉钉语音回复发送失败：', (error as Error).message)
          }
        }
      } catch (error) {
        console.warn('[eab] 钉钉 Stream 消息处理失败：', (error as Error).message)
      } finally {
        if (messageId) client.socketCallBackResponse(messageId, { status: 'SUCCESS' })
      }
    })()
  })
  client.registerCallbackListener(TOPIC_CARD, (res) => {
    const messageId = res.headers?.messageId ?? ''
    // 卡片回调有 2 秒超时：先 ACK，再异步校验身份、续跑模型回合。
    if (messageId) client.socketCallBackResponse(messageId, {})
    void (async () => {
      try {
        const payload = JSON.parse(res.data) as DingTalkCardCallbackPayload
        await handleDingTalkCardCallback(deps, payload)
      } catch (error) {
        console.warn('[eab] 钉钉卡片回调处理失败：', (error as Error).message)
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
      console.log(`[eab] 钉钉 Stream 已连接：EAB · ${cfg.tenant_name ?? deps.companyId}（registered=${client.registered === true}）`)
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
