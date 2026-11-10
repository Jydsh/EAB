/**
 * 钉钉钉盘（企业存储）出站：把个人云空间文件上传到当前员工的 USER 空间，
 * 再取「在线预览」链接。机器人文件消息本身不带钉盘 spaceId/fileId，钉钉不会
 * 为机器人推送的文件生成预览；落到钉盘后，互动卡片的 File 组件才能用
 * previewUrl 打开原生预览。
 */
import { EC, EabError } from '@eab/domain'
import type { ServerDeps } from './deps.js'
import { resolveSecret } from './secrets.js'
import { dingTalkAccessToken } from './dingtalk-card.js'

const DINGTALK_API = 'https://api.dingtalk.com'

interface DriveConfig {
  readonly appId: string
  readonly secret: string
}

interface SpaceRecord {
  readonly spaceId: string
  readonly folderUuid: string
}

interface UploadInfo {
  readonly uploadKey?: string
  readonly headerSignatureInfo?: {
    readonly resourceUrls?: string[]
    readonly headers?: Record<string, string>
  }
}

interface DentryRecord {
  readonly id?: string
  readonly spaceId?: string
  readonly parentId?: string
  readonly type?: string
  readonly name?: string
  readonly size?: number
  readonly path?: string
  readonly uuid?: string
}

export interface DingTalkDriveAttachment {
  readonly fileName: string
  readonly url: string
  readonly previewUrl: string
  readonly size: number
  readonly mimeType?: string
  readonly description?: string
  readonly spaceId: string
  readonly dentryUuid: string
  readonly dentryId: string
}

/** `convFile` 发出的是钉钉原生文件消息，下载/编辑由客户端提供。 */
export interface DingTalkNativeFileMessage {
  readonly fileId: string
  readonly conversationId: string
  readonly spaceId: string
  readonly name: string
  readonly size: number
  readonly path: string
}

interface UploadParams {
  readonly companyId: string
  readonly userId: string
  readonly fileName: string
  readonly mime: string | null
  readonly buffer: Buffer
}

const spaceCache = new Map<string, SpaceRecord>()

function driveConfig(deps: ServerDeps, companyId: string): DriveConfig {
  const row = deps.db
    .prepare(
      `SELECT app_id, secret_ref
         FROM channel_configs
        WHERE company_id = ? AND provider = 'dingtalk'
        LIMIT 1`,
    )
    .get(companyId) as { app_id: string | null; secret_ref: string | null } | undefined
  if (!row?.app_id || !row.secret_ref) {
    throw new EabError(EC.VALIDATION, '当前公司还没有配置钉钉机器人，无法上传钉盘', {
      hint: '请先在管理控制台的渠道页完成钉钉机器人配置。',
    })
  }
  const secret = resolveSecret(deps.config.dbPath, row.secret_ref)
  if (!secret) {
    throw new EabError(EC.VALIDATION, '钉钉机器人密钥读取失败，无法上传钉盘', {
      hint: '请检查管理控制台的钉钉 AppSecret 是否仍有效。',
    })
  }
  return { appId: row.app_id, secret }
}

function unionIdOf(deps: ServerDeps, userId: string): string {
  const row = deps.db
    .prepare(
      `SELECT union_id FROM user_identities
        WHERE user_id = ? AND provider = 'dingtalk' AND union_id IS NOT NULL
        ORDER BY bound_at DESC LIMIT 1`,
    )
    .get(userId) as { union_id: string | null } | undefined
  if (!row?.union_id) {
    throw new EabError(EC.VALIDATION, '当前员工没有钉钉 unionId，无法保存到钉盘', {
      hint: '请先在网页工作台用钉钉扫码登录一次，或让管理员同步组织通讯录。',
    })
  }
  return row.union_id
}

function permissionHint(text: string): string | null {
  try {
    const body = JSON.parse(text) as {
      code?: string
      message?: string
      accessdenieddetail?: { requiredScopes?: string[] }
    }
    if (body.code !== 'Forbidden.AccessDenied.AccessTokenPermissionDenied') return null
    const scopes = body.accessdenieddetail?.requiredScopes ?? []
    return scopes.length
      ? `钉钉应用缺少权限：${scopes.join('、')}。请到钉钉开发者后台给应用 ${scopes.join('、')} 申请并开通。`
      : body.message ?? '钉钉应用缺少钉盘权限'
  } catch {
    return null
  }
}

async function dingRequest<T>(
  url: string,
  init: RequestInit,
  token: string,
  label: string,
): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      'x-acs-dingtalk-access-token': token,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  })
  const text = await res.text()
  if (!res.ok) {
    const hint = permissionHint(text)
    throw new EabError(
      EC.INTERNAL,
      hint ?? `钉钉${label}失败 ${res.status}：${text.slice(0, 220)}`,
      hint ? { hint } : undefined,
    )
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new EabError(EC.INTERNAL, `钉钉${label}返回了无法解析的内容`)
  }
}

/**
 * 为当前员工准备一个 USER 空间和固定的上传目录。
 * 使用 scene/sceneId 让钉钉返回已存在的空间，避免每次发送都新建空间。
 */
async function prepareSpace(
  config: DriveConfig,
  token: string,
  companyId: string,
  unionId: string,
): Promise<SpaceRecord> {
  const cacheKey = `${config.appId}:${companyId}:${unionId}`
  const cached = spaceCache.get(cacheKey)
  if (cached) return cached

  const spaceBody = {
    unionId,
    option: {
      name: 'EAB 文件',
      ownerType: 'USER',
      scene: 'eabFileSend',
      sceneId: companyId,
    },
  }
  const spaceRes = await dingRequest<{ space?: { id?: string } }>(
    `${DINGTALK_API}/v1.0/storage/spaces?unionId=${encodeURIComponent(unionId)}`,
    { method: 'POST', body: JSON.stringify(spaceBody) },
    token,
    '创建存储空间',
  )
  const spaceId = String(spaceRes.space?.id ?? '')
  if (!spaceId) throw new EabError(EC.INTERNAL, '钉钉没有返回存储空间 ID')

  const folderRes = await dingRequest<{ dentry?: DentryRecord }>(
    `${DINGTALK_API}/v1.0/storage/spaces/${encodeURIComponent(spaceId)}/dentries/0/folders?unionId=${encodeURIComponent(unionId)}`,
    {
      method: 'POST',
      body: JSON.stringify({
        name: 'EAB 发送文件',
        option: { conflictStrategy: 'RETURN_DENTRY_IF_EXISTS' },
      }),
    },
    token,
    '创建钉盘目录',
  )
  const folderUuid = String(folderRes.dentry?.uuid ?? '')
  if (!folderUuid) throw new EabError(EC.INTERNAL, '钉钉没有返回钉盘目录 ID')

  const record = { spaceId, folderUuid }
  spaceCache.set(cacheKey, record)
  return record
}

async function putOssObject(
  resourceUrl: string,
  headers: Record<string, string>,
  buffer: Buffer,
): Promise<void> {
  // 官方要求 Content-Type 必须为空字符串，否则 OSS 签名校验会失败。
  const normalized: Record<string, string> = { ...headers, 'content-type': '' }
  const res = await fetch(resourceUrl, {
    method: 'PUT',
    headers: normalized,
    body: buffer,
  })
  if (!res.ok) {
    throw new EabError(EC.INTERNAL, `上传文件到钉盘 OSS 失败 ${res.status}`)
  }
}

/**
 * 上传文件到当前员工钉盘，返回可被互动卡片 File 组件直接打开的预览链接。
 */
export async function uploadFileToUserDrive(
  deps: ServerDeps,
  params: UploadParams,
): Promise<DingTalkDriveAttachment> {
  const config = driveConfig(deps, params.companyId)
  const unionId = unionIdOf(deps, params.userId)
  const token = await dingTalkAccessToken(config.appId, config.secret)
  const { spaceId, folderUuid } = await prepareSpace(
    config,
    token,
    params.companyId,
    unionId,
  )

  const uploadRes = await dingRequest<UploadInfo>(
    `${DINGTALK_API}/v2.0/storage/spaces/files/${encodeURIComponent(folderUuid)}/uploadInfos/query?unionId=${encodeURIComponent(unionId)}`,
    {
      method: 'POST',
      body: JSON.stringify({
        protocol: 'HEADER_SIGNATURE',
        option: {
          storageDriver: 'DINGTALK',
          preCheckParam: { size: params.buffer.byteLength, name: params.fileName },
        },
      }),
    },
    token,
    '申请文件上传信息',
  )
  const uploadKey = String(uploadRes.uploadKey ?? '')
  const resourceUrl = uploadRes.headerSignatureInfo?.resourceUrls?.[0]
  const headers = uploadRes.headerSignatureInfo?.headers ?? {}
  if (!uploadKey || !resourceUrl) {
    throw new EabError(EC.INTERNAL, '钉钉没有返回文件上传地址')
  }
  await putOssObject(resourceUrl, headers, params.buffer)

  const commitRes = await dingRequest<{ dentry?: DentryRecord }>(
    `${DINGTALK_API}/v2.0/storage/spaces/files/${encodeURIComponent(folderUuid)}/commit?unionId=${encodeURIComponent(unionId)}`,
    {
      method: 'POST',
      body: JSON.stringify({
        uploadKey,
        name: params.fileName,
        option: { conflictStrategy: 'OVERWRITE' },
      }),
    },
    token,
    '提交文件到钉盘',
  )
  const dentry = commitRes.dentry
  const dentryUuid = String(dentry?.uuid ?? '')
  const dentryId = String(dentry?.id ?? '')
  if (!dentryUuid || !dentryId) throw new EabError(EC.INTERNAL, '钉钉没有返回文件 dentry id')

  const previewRes = await dingRequest<{ url?: string }>(
    `${DINGTALK_API}/v1.0/storage/spaces/${encodeURIComponent(spaceId)}/dentries/${encodeURIComponent(dentryId)}/openInfos/query?unionId=${encodeURIComponent(unionId)}`,
    {
      method: 'POST',
      body: JSON.stringify({ option: { type: 'PREVIEW', checkLogin: true } }),
    },
    token,
    '获取文件预览链接',
  )
  const previewUrl = String(previewRes.url ?? '')
  if (!previewUrl) throw new EabError(EC.INTERNAL, '钉钉没有返回文件预览链接')

  const size = Number(dentry?.size ?? params.buffer.byteLength)
  return {
    fileName: String(dentry?.name ?? params.fileName),
    // File 组件行尾下载按钮仍用 url；当前没有单独的下载地址，预览链接同样能打开文件。
    url: previewUrl,
    previewUrl,
    size: Number.isFinite(size) ? size : params.buffer.byteLength,
    mimeType: params.mime ?? undefined,
    description: '钉盘在线预览',
    spaceId,
    dentryUuid,
    dentryId,
  }
}

/**
 * 取钉盘文件的下载信息。返回的是 `HEADER_SIGNATURE` 协议的临时地址：
 * `resourceUrls` 里的地址必须带上 `headers` 才能下载，约 900 秒有效。
 * 目前只做探测/记录，不直接塞进卡片 `File.url`，因为客户端按钮不带自定义 header。
 */
export async function getDingTalkDownloadInfo(
  deps: ServerDeps,
  params: { companyId: string; userId: string; spaceId: string; dentryId: string },
): Promise<{ resourceUrls: string[]; headers: Record<string, string> }> {
  const config = driveConfig(deps, params.companyId)
  const unionId = unionIdOf(deps, params.userId)
  const token = await dingTalkAccessToken(config.appId, config.secret)
  const res = await dingRequest<{
    protocol?: string
    headerSignatureInfo?: {
      resourceUrls?: string[]
      headers?: Record<string, string>
      expirationSeconds?: number
    }
  }>(
    `${DINGTALK_API}/v1.0/storage/spaces/${encodeURIComponent(params.spaceId)}/dentries/${encodeURIComponent(params.dentryId)}/downloadInfos/query?unionId=${encodeURIComponent(unionId)}`,
    {
      method: 'POST',
      body: JSON.stringify({ option: { version: 1, preferIntranet: false } }),
    },
    token,
    '获取文件下载链接',
  )
  return {
    resourceUrls: res.headerSignatureInfo?.resourceUrls ?? [],
    headers: res.headerSignatureInfo?.headers ?? {},
  }
}

/**
 * 取钉盘文件的可编辑链接。`type: 'EDIT'` 只对支持在线编辑的文档返回；
 * 不支持时钉钉会报错，这里返回空串，由调用方退回预览链接。
 */
export async function getDingTalkEditUrl(
  deps: ServerDeps,
  params: { companyId: string; userId: string; spaceId: string; dentryId: string },
): Promise<string> {
  const config = driveConfig(deps, params.companyId)
  const unionId = unionIdOf(deps, params.userId)
  const token = await dingTalkAccessToken(config.appId, config.secret)
  const res = await dingRequest<{ url?: string }>(
    `${DINGTALK_API}/v1.0/storage/spaces/${encodeURIComponent(params.spaceId)}/dentries/${encodeURIComponent(params.dentryId)}/openInfos/query?unionId=${encodeURIComponent(unionId)}`,
    {
      method: 'POST',
      body: JSON.stringify({ option: { type: 'EDIT', checkLogin: true } }),
    },
    token,
    '获取文件编辑链接',
  )
  return String(res.url ?? '')
}

/**
 * 把钉盘文件发进指定会话（机器人单聊 / 群）。
 *
 * 这是「机器人会话内」的原生文件消息：`convFile/conversations/files/send`
 * 需要 `openConversationId`（入站消息回调里的 `conversationId`）。
 * 与 `apps/conversations/files/send` 的区别：后者是应用身份发到“工作通知”，
 * 不在机器人私聊里；本接口才会落在用户与机器人的会话中。
 */
export async function sendDingTalkFileToConversation(
  deps: ServerDeps,
  params: {
    readonly companyId: string
    readonly userId: string
    readonly openConversationId: string
    readonly spaceId: string
    readonly dentryId: string
  },
): Promise<DingTalkNativeFileMessage> {
  const config = driveConfig(deps, params.companyId)
  const unionId = unionIdOf(deps, params.userId)
  const token = await dingTalkAccessToken(config.appId, config.secret)
  const res = await dingRequest<{
    file?: {
      id?: string
      conversationId?: string
      spaceId?: string
      name?: string
      size?: number
      path?: string
    }
  }>(
    `${DINGTALK_API}/v1.0/convFile/conversations/files/send?unionId=${encodeURIComponent(unionId)}`,
    {
      method: 'POST',
      body: JSON.stringify({
        spaceId: params.spaceId,
        dentryId: params.dentryId,
        openConversationId: params.openConversationId,
      }),
    },
    token,
    '发送会话文件消息',
  )
  const file = res.file
  const fileId = String(file?.id ?? '')
  if (!fileId) throw new EabError(EC.INTERNAL, '钉钉没有返回文件消息 ID')
  return {
    fileId,
    conversationId: String(file?.conversationId ?? params.openConversationId),
    spaceId: String(file?.spaceId ?? params.spaceId),
    name: String(file?.name ?? ''),
    size: Number(file?.size ?? 0),
    path: String(file?.path ?? ''),
  }
}


/**
 * 兼容旧路径：以应用身份把文件发到“工作通知”，不落在机器人私聊里。
 * 默认发送到机器人会话请用 `sendDingTalkFileToConversation`。
 */
export async function sendDingTalkFileMessageToUser(
  deps: ServerDeps,
  params: {
    readonly companyId: string
    readonly userId: string
    readonly spaceId: string
    readonly dentryId: string
    /** 仅用于探测：某些版本可能接受 openConversationId，让它改投会话而不是工作通知。 */
    readonly openConversationId?: string
  },
): Promise<DingTalkNativeFileMessage> {
  const config = driveConfig(deps, params.companyId)
  const unionId = unionIdOf(deps, params.userId)
  const token = await dingTalkAccessToken(config.appId, config.secret)
  const body: Record<string, string> = { spaceId: params.spaceId, dentryId: params.dentryId }
  if (params.openConversationId) body.openConversationId = params.openConversationId
  const res = await dingRequest<{
    file?: {
      id?: string
      conversationId?: string
      spaceId?: string
      name?: string
      size?: number
      path?: string
    }
  }>(
    `${DINGTALK_API}/v1.0/convFile/apps/conversations/files/send?unionId=${encodeURIComponent(unionId)}`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
    token,
    '发送原生文件消息',
  )
  const file = res.file
  const fileId = String(file?.id ?? '')
  if (!fileId) throw new EabError(EC.INTERNAL, '钉钉没有返回文件消息 ID')
  return {
    fileId,
    conversationId: String(file?.conversationId ?? ''),
    spaceId: String(file?.spaceId ?? params.spaceId),
    name: String(file?.name ?? ''),
    size: Number(file?.size ?? 0),
    path: String(file?.path ?? ''),
  }
}
