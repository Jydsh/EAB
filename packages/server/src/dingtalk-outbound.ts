/**
 * 钉钉出站文件：个人云空间文件 → 钉钉单聊文件消息。
 *
 * 链路：
 *   1. `POST oapi.dingtalk.com/media/upload`（multipart：type=file/image + media）→ media_id
 *   2. `POST api.dingtalk.com/v1.0/robot/oToMessages/batchSend`
 *      msgKey=sampleFile，msgParam={ mediaId, fileName, fileType }
 *
 * 注意：webhook 回复不支持文件，只有接口方式支持；这里不复用 replySessionWebhook。
 */
import { EC, EabError } from '@eab/domain'
import type { ServerDeps } from './deps.js'
import { resolveSecret } from './secrets.js'
import { dingTalkAccessToken } from './dingtalk-card.js'

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
        ORDER BY created_at DESC LIMIT 1`,
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
  input: { fileName: string; mime: string | null; buffer: Buffer; mediaType: 'file' | 'image' },
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
 * 和被动回复不同：这条出口不经过 webhook，不需要用户先发消息；
 * 定时任务、审批提醒这类“到点主动通知”走这里。
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

  try {
    await batchSendMessage(token, {
      robotCode: config.robotCode,
      externalUserId,
      msgKey: 'sampleFile',
      msgParam: { mediaId, fileName, fileType },
    })
  } catch (error) {
    // 图片在 sampleFile 不被接受时，退回钉钉原生图片消息；其它类型不降级成链接或文本。
    if (mediaType !== 'image') throw error
    await batchSendMessage(token, {
      robotCode: config.robotCode,
      externalUserId,
      msgKey: 'sampleImageMsg',
      msgParam: { photoURL: mediaId },
    })
  }

  return { mediaId, externalUserId, fileName, fileType, mediaType }
}
