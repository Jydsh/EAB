/**
 * OnlyOffice DocumentServer 接入辅助。
 *
 * 这里只放无状态逻辑：文档类型、JWT、编辑器配置。
 * 文件权限、配额和落盘仍由 workspace 路由统一处理，避免出现第二套文件权限。
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export type OfficeDocumentType = 'word' | 'cell' | 'slide'
export type OfficeMode = 'view' | 'edit'

export type OfficeTokenKind = 'content' | 'callback' | 'plugin'

/** EAB 自定义插件在 Document Server 里的固定 GUID。 */
export const OFFICE_PLUGIN_GUID = 'asc.{EAB00001-0000-4000-8000-000000000001}'

export interface OfficeTokenPayload {
  readonly kind: OfficeTokenKind
  readonly fileId: string
  readonly companyId: string
  readonly userId: string
  readonly mode: OfficeMode
  readonly version: number
  readonly iat: number
  readonly exp: number
}

const EXTENSION_TYPES: Record<string, OfficeDocumentType> = {
  doc: 'word',
  docx: 'word',
  docm: 'word',
  dot: 'word',
  dotx: 'word',
  odt: 'word',
  ott: 'word',
  rtf: 'word',
  txt: 'word',
  htm: 'word',
  html: 'word',
  xls: 'cell',
  xlsx: 'cell',
  xlsm: 'cell',
  xlt: 'cell',
  xltx: 'cell',
  ods: 'cell',
  ots: 'cell',
  csv: 'cell',
  ppt: 'slide',
  pptx: 'slide',
  pptm: 'slide',
  pot: 'slide',
  potx: 'slide',
  odp: 'slide',
  otp: 'slide',
}

export function officeDocumentType(fileName: string, mime?: string | null): OfficeDocumentType | null {
  const ext = String(fileName || '')
    .toLowerCase()
    .split('.')
    .pop()
    ?.trim()
  if (ext && EXTENSION_TYPES[ext]) return EXTENSION_TYPES[ext]
  const lowerMime = String(mime || '').toLowerCase()
  if (lowerMime.includes('wordprocessing') || lowerMime === 'application/msword') return 'word'
  if (lowerMime.includes('spreadsheet') || lowerMime === 'application/vnd.ms-excel') return 'cell'
  if (lowerMime.includes('presentation') || lowerMime === 'application/vnd.ms-powerpoint') return 'slide'
  return null
}

export function officeFileType(fileName: string): string {
  const ext = String(fileName || '')
    .toLowerCase()
    .split('.')
    .pop()
    ?.trim()
  return ext || 'bin'
}

export function officeScriptUrl(onlyOfficeUrl: string): string {
  return `${onlyOfficeUrl.replace(/\/+$/, '')}/web-apps/apps/api/documents/api.js`
}

/** OnlyOffice 的文档 key 必须在文件版本变化时变化，否则会读到上一次缓存。 */
export function officeDocumentKey(fileId: string, updatedAt: number): string {
  return createHash('sha256')
    .update(`${fileId}:${updatedAt}`)
    .digest('hex')
    .slice(0, 24)
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function hmac(input: string, secret: string): string {
  return createHmac('sha256', secret).update(input).digest('base64url')
}

/** 标准 HS256 JWT，供 OnlyOffice 校验编辑器配置。 */
export function signOfficeJwt(payload: Record<string, unknown>, secret: string): string {
  const header = base64urlJson({ alg: 'HS256', typ: 'JWT' })
  const body = base64urlJson(payload)
  const unsigned = `${header}.${body}`
  return `${unsigned}.${hmac(unsigned, secret)}`
}

/** 校验我们自己签发的文件/回调 JWT；失败、过期或格式不符都返回 null。 */
export function verifyOfficeJwt(token: string, secret: string, now = Date.now()): OfficeTokenPayload | null {
  if (!token || !secret) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [header, body, signature] = parts
  const expected = hmac(`${header}.${body}`, secret)
  if (signature.length !== expected.length) return null
  try {
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as OfficeTokenPayload
    if (!payload || (payload.kind !== 'content' && payload.kind !== 'callback' && payload.kind !== 'plugin')) return null
    if (!payload.fileId || !payload.companyId || !payload.userId) return null
    if (!payload.exp || payload.exp <= Math.floor(now / 1000)) return null
    return payload
  } catch {
    return null
  }
}

export interface OfficeEditorInput {
  readonly fileId: string
  readonly fileName: string
  readonly mime?: string | null
  readonly updatedAt: number
  readonly userId: string
  readonly userName: string
  readonly mode: OfficeMode
  readonly contentUrl: string
  readonly callbackUrl: string
  /** EAB 插件 config.json 的短期签名地址；按文档类型注入 word/cell/slide。 */
  readonly pluginConfigUrl?: string
  readonly secret: string
}

/** 生成 DocsAPI.DocEditor 需要的完整配置；token 放在顶层，由 OnlyOffice 校验。 */
export function buildOfficeEditorConfig(input: OfficeEditorInput): {
  documentType: OfficeDocumentType
  document: Record<string, unknown>
  editorConfig: Record<string, unknown>
  type: 'desktop'
  width: '100%'
  height: '100%'
  token: string
} {
  const documentType = officeDocumentType(input.fileName, input.mime)
  if (!documentType) throw new Error(`不支持的 Office 文件类型：${input.fileName}`)
  const editable = input.mode === 'edit'
  const document = {
    fileType: officeFileType(input.fileName),
    key: officeDocumentKey(input.fileId, input.updatedAt),
    title: input.fileName,
    url: input.contentUrl,
    permissions: {
      edit: editable,
      download: true,
      print: true,
    },
  }
  const editorConfig: Record<string, unknown> = {
    mode: input.mode,
    lang: 'zh-CN',
    callbackUrl: input.callbackUrl,
    user: { id: input.userId, name: input.userName },
    permissions: {
      edit: editable,
      download: true,
      print: true,
    },
    customization: {
      autosave: true,
      forcesave: editable,
      compactHeader: true,
      hideRightMenu: true,
      toolbarNoTabs: false,
      help: false,
      feedback: false,
      uiTheme: 'theme-light',
    },
  }
  if (input.pluginConfigUrl) {
    editorConfig.plugins = {
      autostart: [OFFICE_PLUGIN_GUID],
      pluginsData: [input.pluginConfigUrl],
    }
  }
  const config = {
    documentType,
    document,
    editorConfig,
    type: 'desktop' as const,
    width: '100%' as const,
    height: '100%' as const,
  }
  return { ...config, token: signOfficeJwt(config, input.secret) }
}

export interface OfficeForceSaveResult {
  readonly error: number
  readonly key: string
  readonly noChanges: boolean
  readonly message: string
}

const FORCE_SAVE_ERROR_MESSAGES: Record<number, string> = {
  0: '保存请求已接受',
  1: 'OnlyOffice 找不到当前编辑会话，请重新打开预览',
  2: 'OnlyOffice 回调地址不正确',
  3: 'OnlyOffice 内部错误',
  4: '没有需要保存的修改',
  5: 'OnlyOffice 不接受该保存命令',
  6: 'OnlyOffice 拒绝保存令牌',
}

/**
 * 调用 OnlyOffice 文档命令服务强制保存当前编辑会话。
 * 8.2 起官方地址是 `/command`；旧版本仍是 `/coauthoring/CommandService.ashx`，
 * 只在 `/command` 返回 404 时回退，避免把正常失败误判成地址不兼容。
 */
export async function forceSaveOfficeDocument(input: {
  readonly url: string
  readonly secret: string
  readonly key: string
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
}): Promise<OfficeForceSaveResult> {
  const base = String(input.url || '').replace(/\/+$/, '')
  if (!base) throw new Error('OnlyOffice 文档服务地址未配置')
  if (!input.secret) throw new Error('OnlyOffice JWT 密钥未配置')
  if (!input.key) throw new Error('OnlyOffice 文档 key 为空')
  const fetchImpl = input.fetchImpl ?? fetch
  const token = signOfficeJwt({ c: 'forcesave', key: input.key }, input.secret)
  const body = JSON.stringify({ c: 'forcesave', key: input.key, token })
  const paths = ['/command', '/coauthoring/CommandService.ashx']
  let lastError = ''
  for (let index = 0; index < paths.length; index += 1) {
    const commandUrl = `${base}${paths[index]}?shardkey=${encodeURIComponent(input.key)}`
    let response: Response
    try {
      response = await fetchImpl(commandUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(input.timeoutMs ?? 8000),
      })
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      if (index === 0) continue
      throw new Error(`连接 OnlyOffice 命令服务失败：${lastError}`)
    }
    if (response.status === 404 && index === 0) continue
    if (!response.ok) {
      throw new Error(`OnlyOffice 命令服务返回 HTTP ${response.status}`)
    }
    const payload = (await response.json().catch(() => null)) as { error?: unknown; key?: unknown } | null
    const errorCode = Number(payload?.error)
    if (!payload || !Number.isFinite(errorCode)) {
      throw new Error('OnlyOffice 命令服务返回了无法解析的响应')
    }
    return {
      error: errorCode,
      key: typeof payload.key === 'string' && payload.key ? payload.key : input.key,
      noChanges: errorCode === 4,
      message: FORCE_SAVE_ERROR_MESSAGES[errorCode] ?? `OnlyOffice 保存失败（错误码 ${errorCode}）`,
    }
  }
  throw new Error(`连接 OnlyOffice 命令服务失败：${lastError || '没有可用地址'}`)
}

/**
 * EAB 自定义插件的 config.json。
 * 插件入口绝对地址带短期 plugin token；OnlyOffice 启动插件时由浏览器加载。
 */
export function buildOfficePluginConfig(
  token: string,
  editorTypes: OfficeDocumentType | OfficeDocumentType[] = ['word', 'cell', 'slide'],
): Record<string, unknown> {
  return {
    name: 'EAB Agent',
    nameLocale: { zh: 'EAB Agent', en: 'EAB Agent' },
    guid: OFFICE_PLUGIN_GUID,
    version: '0.1.0',
    variations: [
      {
        description: 'EAB 文档操作与执行过程面板',
        descriptionLocale: { zh: 'EAB 文档操作与执行过程面板' },
        // config.json 必须与插件文件同目录；OnlyOffice 会用 config.json 的目录作为 baseUrl。
        url: `index.html?token=${encodeURIComponent(token)}`,
        icons: ['icon.png'],
        isViewer: true,
        EditorsSupport: Array.isArray(editorTypes) ? editorTypes : [editorTypes],
        initDataType: 'none',
        initData: '',
        type: 'panelRight',
      },
    ],
  }
}
