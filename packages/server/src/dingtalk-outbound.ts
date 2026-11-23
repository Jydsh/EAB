/**
 * 钉钉出站文件/图片：个人云空间文件、工作区图片或知识库图片资产 → 钉钉单聊消息。
 *
 * 链路：
 *   1. `POST oapi.dingtalk.com/media/upload`（multipart：type=file/image + media）→ media_id
 *   2. `POST api.dingtalk.com/v1.0/robot/oToMessages/batchSend`
 *      图片优先 msgKey=sampleImageMsg，msgParam={ photoURL }，失败降级 sampleFile；
 *      文件使用 msgKey=sampleFile，msgParam={ mediaId, fileName, fileType }。
 *
 * 注意：webhook 回复不支持文件，只有接口方式支持；这里不复用 replySessionWebhook。
 */
import { EC, EabError } from '@eab/domain'
import type { ServerDeps } from './deps.js'
import { resolveSecret } from './secrets.js'
import { DingTalkAICardStream, dingTalkAccessToken, type DingTalkRichCardState } from './dingtalk-card.js'

/** 钉钉媒体上传官方上限 20 MB；个人云空间单文件上限 50 MB，出站时按钉钉侧收窄。 */
export const DINGTALK_OUTBOUND_FILE_LIMIT_BYTES = 20 * 1024 * 1024

interface DingTalkOutboundConfig {
  readonly appId: string
  readonly secret: string
  readonly robotCode: string
}

interface UploadResult {
  readonly errcode?: number
  readonly errmsg?: string
  readonly media_id?: string
  readonly type?: string
}

interface BatchSendResult {
  readonly invalidStaffIdList?: string[]
  readonly flowControlledStaffIdList?: string[]
  readonly filteredStaffIdList?: string[]
}

export interface DingTalkFileSendResult {
  readonly mediaId: string
  readonly externalUserId: string
  readonly fileName: string
  readonly fileType: string
  readonly mediaType: 'file' | 'image'
}

export interface DingTalkVoiceSendResult {
  readonly mediaId: string
  readonly externalUserId: string
  readonly durationMs: number
}

function outboundConfig(deps: ServerDeps, companyId: string): DingTalkOutboundConfig {
  const row = deps.db
    .prepare(
      `SELECT app_id, secret_ref, robot_code
         FROM channel_configs
        WHERE company_id = ? AND provider = 'dingtalk'
        LIMIT 1`,
    )
    .get(companyId) as { app_id: string | null; secret_ref: string | null; robot_code: string | null } | undefined
  if (!row?.app_id || !row.secret_ref) {
    throw new EabError(EC.VALIDATION, '当前公司还没有配置钉钉机器人，无法发送文件', {
      hint: '请先在管理控制台的渠道页完成钉钉机器人配置。',
    })
  }
  const secret = resolveSecret(deps.config.dbPath, row.secret_ref)
  if (!secret) {
    throw new EabError(EC.VALIDATION, '钉钉机器人密钥读取失败，无法发送文件', {
      hint: '请检查管理控制台的钉钉 AppSecret 是否仍有效。',
    })
  }
  return { appId: row.app_id, secret, robotCode: row.robot_code || row.app_id }
}

function externalUserIdOf(deps: ServerDeps, companyId: string, userId: string): string {
  // 优先用渠道身份表；老数据只有组织同步的 user_identities，补一个兜底。
  const channel = deps.db
    .prepare(
      `SELECT external_id FROM channel_identities
        WHERE company_id = ? AND provider = 'dingtalk' AND user_id = ? AND revoked_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(companyId, userId) as { external_id: string } | undefined
  if (channel?.external_id) return channel.external_id

  const identity = deps.db
    .prepare(
      `SELECT external_user_id FROM user_identities
        WHERE provider = 'dingtalk' AND user_id = ?
        ORDER BY bound_at DESC LIMIT 1`,
    )
    .get(userId) as { external_user_id: string } | undefined
  if (identity?.external_user_id) return identity.external_user_id

  throw new EabError(EC.VALIDATION, '当前账号还没有绑定钉钉，无法发送到钉钉聊天', {
    hint: '请先在「设置 → 渠道绑定」里绑定钉钉账号。',
  })
}

function extensionOf(fileName: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(fileName)
  return match ? match[1].toLowerCase() : 'file'
}

function isImage(fileName: string, mime: string | null): boolean {
  if (mime && /^image\//i.test(mime)) {
    return /^(png|jpg|jpeg|gif|bmp|webp)$/i.test(extensionOf(fileName))
  }
  return /\.(png|jpg|jpeg|gif|bmp|webp)$/i.test(fileName)
}

async function uploadMedia(
  token: string,
  input: { fileName: string; mime: string | null; buffer: Buffer; mediaType: 'file' | 'image' | 'voice' },
): Promise<string> {
  const form = new FormData()
  form.append('type', input.mediaType)
  form.append(
    'media',
    new Blob([input.buffer], { type: input.mime || 'application/octet-stream' }),
    input.fileName,
  )
  const response = await fetch(
    `https://oapi.dingtalk.com/media/upload?access_token=${encodeURIComponent(token)}`,
    { method: 'POST', body: form },
  )
  const text = await response.text()
  let body: UploadResult | null = null
  try {
    body = JSON.parse(text) as UploadResult
  } catch {
    body = null
  }
  if (!response.ok || !body || body.errcode !== 0 || !body.media_id) {
    throw new EabError(EC.UPSTREAM, '钉钉文件上传失败', {
      details: { status: response.status, response: text.slice(0, 300) },
      hint: '请稍后重试；如果持续失败，检查钉钉机器人是否仍有媒体上传权限。',
    })
  }
  return body.media_id
}

async function batchSendMessage(
  token: string,
  input: { robotCode: string; externalUserId: string; msgKey: string; msgParam: Record<string, string> },
): Promise<void> {
  const response = await fetch('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-acs-dingtalk-access-token': token,
    },
    body: JSON.stringify({
      robotCode: input.robotCode,
      userIds: [input.externalUserId],
      msgKey: input.msgKey,
      msgParam: JSON.stringify(input.msgParam),
    }),
  })
  const text = await response.text()
  let body: BatchSendResult | null = null
  try {
    body = JSON.parse(text) as BatchSendResult
  } catch {
    body = null
  }
  if (!response.ok) {
    throw new EabError(EC.UPSTREAM, '钉钉消息发送失败', {
      details: { status: response.status, response: text.slice(0, 300) },
      hint: '请稍后重试；如果持续失败，检查钉钉机器人是否仍有单聊消息权限。',
    })
  }
  if (body?.invalidStaffIdList?.length) {
    throw new EabError(EC.UPSTREAM, '钉钉没有接收这条消息：接收人不在机器人可见范围内', {
      details: { invalidStaffIdList: body.invalidStaffIdList },
      hint: '请确认当前钉钉账号与机器人在同一组织，并且机器人可见范围包含该成员。',
    })
  }
  if (body?.flowControlledStaffIdList?.length) {
    throw new EabError(EC.RATE_LIMITED, '钉钉发送被限流，消息没有发出去', {
      details: { flowControlledStaffIdList: body.flowControlledStaffIdList },
      hint: '请稍后再试。',
    })
  }
}

/**
 * 把一段纯文本主动推到当前员工的钉钉单聊。
 *
 * 定时任务、子 Agent 完成汇报等面向用户的主动通知请用 `sendDingTalkRichTextToUser`，
 * 它会优先走 A2UI 卡片；这里仅保留为纯文本兜底/兼容出口。
 */
export async function sendDingTalkTextToUser(
  deps: ServerDeps,
  input: { companyId: string; userId: string; text: string },
): Promise<{ externalUserId: string }> {
  const text = String(input.text ?? '').trim()
  if (!text) throw new EabError(EC.VALIDATION, '消息内容不能为空')
  const config = outboundConfig(deps, input.companyId)
  const externalUserId = externalUserIdOf(deps, input.companyId, input.userId)
  const token = await dingTalkAccessToken(config.appId, config.secret)
  await batchSendMessage(token, {
    robotCode: config.robotCode,
    externalUserId,
    msgKey: 'sampleText',
    msgParam: { content: text },
  })
  return { externalUserId }
}

export interface DingTalkRichTextSendResult {
  readonly externalUserId: string
  /** a2ui=已用 AI 卡片；markdown=卡片不可用，退回钉钉 Markdown 消息；text=最后退回纯文本。 */
  readonly mode: 'a2ui' | 'markdown' | 'text'
  readonly cardId?: string
  readonly finished?: boolean
}

/**
 * 主动推送到当前员工的钉钉单聊，优先复用聊天回复的 A2UI 卡片，
 * 让子 Agent 完成汇报、定时任务通知也有标题、分段和表格排版。
 *
 * A2UI 创建失败（例如应用没有 AICard.Instance.Write 权限）时退回
 * sampleMarkdown；连 Markdown 也不可用时才退回原来的纯文本。
 */
export async function sendDingTalkRichTextToUser(
  deps: ServerDeps,
  input: { companyId: string; userId: string; title?: string; text: string },
): Promise<DingTalkRichTextSendResult> {
  const text = String(input.text ?? '').trim()
  if (!text) throw new EabError(EC.VALIDATION, '消息内容不能为空')
  const title = String(input.title ?? '').trim() || 'EAB 通知'
  const config = outboundConfig(deps, input.companyId)
  const externalUserId = externalUserIdOf(deps, input.companyId, input.userId)

  const state: DingTalkRichCardState = {
    answer: text,
    reasoning: '',
    tools: [],
    thinkingDone: true,
  }
  const card = new DingTalkAICardStream(config.appId, config.secret, externalUserId, config.robotCode)
  if (await card.start(state, title)) {
    const finished = await card.finish(state, title)
    return {
      externalUserId,
      mode: 'a2ui',
      cardId: card.providerMessageIds[0],
      finished,
    }
  }

  const token = await dingTalkAccessToken(config.appId, config.secret)
  try {
    await batchSendMessage(token, {
      robotCode: config.robotCode,
      externalUserId,
      msgKey: 'sampleMarkdown',
      msgParam: { title, text },
    })
    return { externalUserId, mode: 'markdown' }
  } catch {
    // 部分老机器人没有 sampleMarkdown 权限；最后退回纯文本，至少保证消息送达。
    await batchSendMessage(token, {
      robotCode: config.robotCode,
      externalUserId,
      msgKey: 'sampleText',
      msgParam: { content: text },
    })
    return { externalUserId, mode: 'text' }
  }
}

/** 供定时任务创建时预检：当前员工有没有可用的钉钉接收人。 */
export function dingTalkRecipientOf(deps: ServerDeps, companyId: string, userId: string): string {
  return externalUserIdOf(deps, companyId, userId)
}


export async function sendDingTalkFileToUser(
  deps: ServerDeps,
  input: { companyId: string; userId: string; fileName: string; mime: string | null; buffer: Buffer },
): Promise<DingTalkFileSendResult> {
  const fileName = String(input.fileName || '').trim()
  if (!fileName) throw new EabError(EC.VALIDATION, '文件名不能为空')
  if (input.buffer.length > DINGTALK_OUTBOUND_FILE_LIMIT_BYTES) {
    throw new EabError(EC.VALIDATION, '文件超过钉钉发送上限（20 MB），没有发出去', {
      details: { size: input.buffer.length, limit: DINGTALK_OUTBOUND_FILE_LIMIT_BYTES },
      hint: '请把文件压缩到 20 MB 以内，或先在个人云空间里下载后再通过其他方式发送。',
    })
  }

  const config = outboundConfig(deps, input.companyId)
  const externalUserId = externalUserIdOf(deps, input.companyId, input.userId)
  const mediaType: 'file' | 'image' = isImage(fileName, input.mime) ? 'image' : 'file'
  const fileType = extensionOf(fileName)
  const token = await dingTalkAccessToken(config.appId, config.secret)
  const mediaId = await uploadMedia(token, {
    fileName,
    mime: input.mime,
    buffer: input.buffer,
    mediaType,
  })

  if (mediaType === 'image') {
    // 图片优先发钉钉原生图片消息，客户端直接渲染成图片气泡；部分老机器人没有
    // sampleImageMsg 权限时才退回 sampleFile，至少保证文件送达。
    try {
      await batchSendMessage(token, {
        robotCode: config.robotCode,
        externalUserId,
        msgKey: 'sampleImageMsg',
        msgParam: { photoURL: mediaId },
      })
    } catch (error) {
      await batchSendMessage(token, {
        robotCode: config.robotCode,
        externalUserId,
        msgKey: 'sampleFile',
        msgParam: { mediaId, fileName, fileType },
      })
    }
  } else {
    await batchSendMessage(token, {
      robotCode: config.robotCode,
      externalUserId,
      msgKey: 'sampleFile',
      msgParam: { mediaId, fileName, fileType },
    })
  }

  return { mediaId, externalUserId, fileName, fileType, mediaType }
}

/**
 * 把已经转成 OGG/Opus 的语音发成钉钉原生语音气泡。
 * 钉钉要求 media/upload 的 type=voice，发送模板用 sampleAudio。
 */
export async function sendDingTalkVoiceToUser(
  deps: ServerDeps,
  input: { companyId: string; userId: string; buffer: Buffer; mime: string; durationMs: number; fileName?: string },
): Promise<DingTalkVoiceSendResult> {
  const mime = String(input.mime || '').toLowerCase()
  if (!mime.includes('audio/ogg') && !mime.includes('audio/amr')) {
    throw new EabError(EC.VALIDATION, '钉钉语音只支持 OGG 或 AMR 格式', { details: { mime: input.mime } })
  }
  const durationMs = Math.max(1000, Math.round(Number(input.durationMs) || 0))
  const config = outboundConfig(deps, input.companyId)
  const externalUserId = externalUserIdOf(deps, input.companyId, input.userId)
  const token = await dingTalkAccessToken(config.appId, config.secret)
  const mediaId = await uploadMedia(token, {
    fileName: input.fileName || (mime.includes('amr') ? 'EAB语音.amr' : 'EAB语音.ogg'),
    mime,
    buffer: input.buffer,
    mediaType: 'voice',
  })
  await batchSendMessage(token, {
    robotCode: config.robotCode,
    externalUserId,
    msgKey: 'sampleAudio',
    msgParam: { mediaId, duration: String(durationMs) },
  })
  return { mediaId, externalUserId, durationMs }
}
