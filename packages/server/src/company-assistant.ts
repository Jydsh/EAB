/**
 * 公司助手身份：网页工作台 AI 消息旁的头像和名字。
 *
 * 配置落在 `companies.settings_json.assistant`，不新增表；
 * 头像二进制单独存放在数据目录，数据库只留文件元信息，避免把图片塞进 SQLite。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { EC, EabError } from '@eab/domain'
import type { Db } from '@eab/storage'

export const DEFAULT_ASSISTANT_NAME = 'AI'
export const MAX_ASSISTANT_AVATAR_BYTES = 1024 * 1024
const MAX_ASSISTANT_NAME_LENGTH = 40

const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
}

export interface AssistantAvatar {
  /** 文件名固定为 assistant-avatar-<hash>.<ext>，只允许我们自己生成的名字。 */
  file: string
  mime: string
  /** 同时作为前端缓存键。 */
  updatedAt: number
}

export interface CompanyAssistant {
  name: string
  avatar: AssistantAvatar | null
}

export interface CompanyAssistantView {
  name: string
  /** 没有头像时为空字符串；前端据它决定显示图片还是姓名首字。 */
  avatarUrl: string
}

interface CompaniesSettingsRow {
  settings_json?: string | null
}

function parseSettings(raw: string | null | undefined, strict = false): Record<string, unknown> {
  if (!raw) return {}
  try {
    const value = JSON.parse(raw) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    if (!strict) return {}
    throw new EabError(EC.VALIDATION, '公司配置不是合法 JSON，请先修复后再保存助手身份', {
      hint: 'companies.settings_json 被外部写坏时，不能直接覆盖，否则会把其它配置一起丢掉。',
    })
  }
}

function readSettingsRow(db: Db, companyId: string): CompaniesSettingsRow {
  return (db.prepare('SELECT settings_json FROM companies WHERE id = ?').get(companyId) as
    | CompaniesSettingsRow
    | undefined) ?? {}
}

function safeCompanySegment(companyId: string): string {
  return String(companyId).replace(/[^A-Za-z0-9._-]/g, '_') || 'company'
}

function avatarDir(dataDir: string, companyId: string): string {
  return join(dataDir, 'company-assets', safeCompanySegment(companyId))
}

function isAvatarFileName(value: string): boolean {
  return /^assistant-avatar-[a-f0-9]{8,64}\.(png|jpg|webp)$/.test(value)
}

/** 从 settings_json 里读出经过校验的助手身份；坏字段一律回退默认值。 */
export function readCompanyAssistant(db: Db, companyId: string): CompanyAssistant {
  const settings = parseSettings(readSettingsRow(db, companyId).settings_json)
  const raw = settings.assistant
  const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const name = typeof record.name === 'string' ? normalizeAssistantName(record.name) : DEFAULT_ASSISTANT_NAME
  const avatarRaw = record.avatar
  let avatar: AssistantAvatar | null = null
  if (avatarRaw && typeof avatarRaw === 'object' && !Array.isArray(avatarRaw)) {
    const value = avatarRaw as Record<string, unknown>
    const file = typeof value.file === 'string' ? value.file : ''
    const mime = typeof value.mime === 'string' ? value.mime : ''
    const updatedAt = Number(value.updatedAt)
    if (isAvatarFileName(file) && EXT_TO_MIME[file.split('.').pop() ?? ''] === mime && Number.isFinite(updatedAt)) {
      avatar = { file, mime, updatedAt }
    }
  }
  return { name: name || DEFAULT_ASSISTANT_NAME, avatar }
}

/** 给 HTTP 层用的安全视图：不把磁盘文件名暴露给浏览器。 */
export function companyAssistantView(db: Db, companyId: string): CompanyAssistantView {
  const assistant = readCompanyAssistant(db, companyId)
  return {
    name: assistant.name,
    avatarUrl: assistant.avatar
      ? `/api/company/assistant-avatar?v=${encodeURIComponent(String(assistant.avatar.updatedAt))}`
      : '',
  }
}

export function normalizeAssistantName(value: string): string {
  const normalized = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) return ''
  return normalized.length > MAX_ASSISTANT_NAME_LENGTH
    ? normalized.slice(0, MAX_ASSISTANT_NAME_LENGTH)
    : normalized
}

interface ParsedAvatar {
  bytes: Buffer
  mime: string
  ext: string
}

function parseAvatarDataUrl(value: unknown): ParsedAvatar {
  if (typeof value !== 'string' || !value.trim()) {
    throw new EabError(EC.VALIDATION, '头像图片为空')
  }
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(value.trim())
  if (!match) {
    throw new EabError(EC.VALIDATION, '头像只支持 PNG / JPEG / WebP 图片', {
      hint: '请选择图片文件后重新上传；不接受 SVG 或外部图片地址。',
    })
  }
  const subtype = match[1] === 'jpeg' ? 'jpg' : match[1]
  const mime = `image/${match[1]}`
  const bytes = Buffer.from(match[2].replace(/\s+/g, ''), 'base64')
  if (bytes.byteLength === 0) throw new EabError(EC.VALIDATION, '头像图片为空')
  if (bytes.byteLength > MAX_ASSISTANT_AVATAR_BYTES) {
    throw new EabError(EC.VALIDATION, '头像图片不能超过 1 MB', {
      hint: '前端会先裁成 1:1 并压到 512px，仍超限请换一张更小的图片。',
    })
  }
  if (!magicMatches(bytes, subtype)) {
    throw new EabError(EC.VALIDATION, '头像文件内容与图片格式不符')
  }
  return { bytes, mime, ext: subtype }
}

function magicMatches(bytes: Buffer, ext: string): boolean {
  if (ext === 'png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  if (ext === 'jpg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (ext === 'webp') {
    return (
      bytes.length >= 12 &&
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP'
    )
  }
  return false
}

function writeAvatarFile(dataDir: string, companyId: string, parsed: ParsedAvatar): AssistantAvatar {
  const dir = avatarDir(dataDir, companyId)
  mkdirSync(dir, { recursive: true })
  const hash = createHash('sha256').update(parsed.bytes).digest('hex').slice(0, 24)
  const file = `assistant-avatar-${hash}.${parsed.ext}`
  const target = join(dir, file)
  if (!existsSync(target)) {
    const temp = join(dir, `.${file}.tmp-${process.pid}-${Date.now()}`)
    try {
      writeFileSync(temp, parsed.bytes, { mode: 0o600 })
      renameSync(temp, target)
    } catch (error) {
      rmSync(temp, { force: true })
      throw error
    }
  }
  return { file, mime: parsed.mime, updatedAt: Date.now() }
}

function removeAvatarFile(dataDir: string, companyId: string, avatar: AssistantAvatar | null): void {
  if (!avatar) return
  const target = join(avatarDir(dataDir, companyId), basename(avatar.file))
  try {
    rmSync(target, { force: true })
  } catch {
    // 旧文件删不掉不影响新配置生效；下次同内容上传会复用同名文件。
  }
}

export interface SaveCompanyAssistantInput {
  name?: unknown
  avatarDataUrl?: unknown
  removeAvatar?: unknown
}

/**
 * 保存助手身份。只 merge `assistant` 这一个 key，其它 settings 原样保留；
 * 图片先落盘再写库，写库失败时删掉新文件，旧头像不会被破坏。
 */
export function saveCompanyAssistant(
  db: Db,
  dataDir: string,
  companyId: string,
  input: SaveCompanyAssistantInput,
): CompanyAssistant {
  const currentSettings = parseSettings(readSettingsRow(db, companyId).settings_json, true)
  const current = readCompanyAssistant(db, companyId)
  const hasName = input.name !== undefined
  const name = hasName ? normalizeAssistantName(String(input.name ?? '')) : current.name
  if (!name) throw new EabError(EC.VALIDATION, '助手名称不能为空', { hint: '最多 40 个字。' })

  const wantsRemove = input.removeAvatar === true
  const wantsUpload = input.avatarDataUrl !== undefined && input.avatarDataUrl !== null && input.avatarDataUrl !== ''
  if (wantsRemove && wantsUpload) {
    throw new EabError(EC.VALIDATION, '不能同时上传新头像和删除头像')
  }

  const previousAvatar = current.avatar
  let avatar = previousAvatar
  let newAvatarFileWritten = false
  if (wantsRemove) {
    avatar = null
  } else if (wantsUpload) {
    const parsed = parseAvatarDataUrl(input.avatarDataUrl)
    avatar = writeAvatarFile(dataDir, companyId, parsed)
    newAvatarFileWritten = true
  }

  const nextSettings = { ...currentSettings, assistant: { name, avatar } }
  try {
    db.prepare('UPDATE companies SET settings_json = ? WHERE id = ?').run(JSON.stringify(nextSettings), companyId)
  } catch (error) {
    if (newAvatarFileWritten && avatar) removeAvatarFile(dataDir, companyId, avatar)
    throw error
  }

  if (previousAvatar && previousAvatar.file !== avatar?.file) {
    removeAvatarFile(dataDir, companyId, previousAvatar)
  }
  return { name, avatar }
}

export interface AssistantAvatarFile {
  bytes: Buffer
  mime: string
  updatedAt: number
}

/** 读取已校验的头像文件；文件丢失或配置被改坏时返回 null，由前端回退首字。 */
export function readCompanyAssistantAvatar(
  db: Db,
  dataDir: string,
  companyId: string,
): AssistantAvatarFile | null {
  const avatar = readCompanyAssistant(db, companyId).avatar
  if (!avatar) return null
  const filePath = join(avatarDir(dataDir, companyId), avatar.file)
  if (!existsSync(filePath)) return null
  try {
    const bytes = readFileSync(filePath)
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ASSISTANT_AVATAR_BYTES) return null
    if (!magicMatches(bytes, avatar.file.split('.').pop() ?? '')) return null
    return { bytes, mime: avatar.mime, updatedAt: avatar.updatedAt }
  } catch {
    return null
  }
}

/** 数据目录缺省时与数据库同目录，和现有 tmp/backups 的解析口径一致。 */
export function resolveAssistantDataDir(dataDir: string | undefined, dbPath: string): string {
  return dataDir || dirname(dbPath)
}
