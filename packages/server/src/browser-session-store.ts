/**
 * 浏览器登录态库 v1。
 *
 * 只保存用户主动点“保存登录态”的站点 Cookie 与 localStorage，按用户隔离、
 * 按站点合并，AES-256-GCM 加密落盘。不保存密码，不采集密码框内容。
 *
 * 安全边界：
 * 1. 状态文件与密钥分离，权限收紧到当前用户；
 * 2. 记录按 ownerKey 隔离，不能跨用户读取；
 * 3. 保存时只收当前 origin 的 Cookie 和 localStorage，避免顺手把其他站点状态混入；
 * 4. 状态只用于重新打开网页时恢复会话，不进入模型上下文、审计详情或接口回显。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { EC, EabError } from '@eab/domain'
import { hardenRuntimePath } from './runtime-permissions.js'
import { normalizeBrowserOrigin } from './browser-credentials.js'

export interface BrowserStorageCookie {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite: 'Strict' | 'Lax' | 'None'
}

export interface BrowserStorageOrigin {
  origin: string
  localStorage: Array<{ name: string; value: string }>
}

export interface BrowserStorageState {
  cookies: BrowserStorageCookie[]
  origins: BrowserStorageOrigin[]
}

interface EncryptedValue {
  iv: string
  tag: string
  data: string
}

interface StoredSessionRow {
  ownerKey: string
  updatedAt: number
  secret: EncryptedValue
}

interface SessionRecord {
  ownerKey: string
  cookies: BrowserStorageCookie[]
  origins: BrowserStorageOrigin[]
  updatedAt: number
}

type SessionFile = Record<string, StoredSessionRow>

export interface BrowserSessionStatus {
  configured: boolean
  origin: string
  cookieCount: number
  localStorageCount: number
  updatedAt: number | null
}

const MAX_COOKIES = 1_000
const MAX_LOCAL_STORAGE_ITEMS = 2_000
const MAX_PLAIN_BYTES = 4 * 1024 * 1024

function sessionsPath(dbPath: string): string {
  return join(dirname(dbPath), 'browser-sessions.json')
}

function keyPath(dbPath: string): string {
  return join(dirname(dbPath), 'browser-sessions.key')
}

function ownerId(ownerKey: string): string {
  return createHash('sha256').update(String(ownerKey)).digest('hex')
}

function readKey(dbPath: string): Buffer {
  const file = keyPath(dbPath)
  if (existsSync(file)) {
    const key = readFileSync(file)
    if (key.length !== 32) throw new EabError(EC.INTERNAL, '浏览器登录态主密钥损坏')
    return key
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  try {
    const fd = openSync(file, 'wx', 0o600)
    try {
      const key = randomBytes(32)
      writeSync(fd, key)
      closeSync(fd)
      hardenRuntimePath(file)
      return key
    } finally {
      try {
        closeSync(fd)
      } catch {
        /* 已关闭 */
      }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EEXIST') throw err
    const key = readFileSync(file)
    if (key.length !== 32) throw new EabError(EC.INTERNAL, '浏览器登录态主密钥损坏')
    return key
  }
}

function encrypt(dbPath: string, ownerKey: string, plain: string): EncryptedValue {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', readKey(dbPath), iv)
  cipher.setAAD(Buffer.from(String(ownerKey), 'utf8'))
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }
}

function decrypt(dbPath: string, ownerKey: string, secret: EncryptedValue): string {
  try {
    const decipher = createDecipheriv('aes-256-gcm', readKey(dbPath), Buffer.from(secret.iv, 'base64'))
    decipher.setAAD(Buffer.from(String(ownerKey), 'utf8'))
    decipher.setAuthTag(Buffer.from(secret.tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(secret.data, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    throw new EabError(EC.CONFLICT, '保存的登录态无法解密，请重新保存', {
      hint: '可能更换过数据目录或登录态文件被修改',
    })
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readStoredRows(file: string): SessionFile {
  if (!existsSync(file)) return {}
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (!isObject(raw)) return {}
    const out: SessionFile = {}
    for (const [id, value] of Object.entries(raw)) {
      if (!/^[a-f0-9]{64}$/.test(id) || !isObject(value)) continue
      const secret = value.secret
      if (!isObject(secret)) continue
      if (
        typeof value.ownerKey !== 'string' ||
        typeof value.updatedAt !== 'number' ||
        typeof secret.iv !== 'string' ||
        typeof secret.tag !== 'string' ||
        typeof secret.data !== 'string'
      ) {
        continue
      }
      out[id] = {
        ownerKey: value.ownerKey,
        updatedAt: value.updatedAt,
        secret: { iv: secret.iv, tag: secret.tag, data: secret.data },
      }
    }
    return out
  } catch {
    return {}
  }
}

function decodeRecord(dbPath: string, row: StoredSessionRow): SessionRecord | null {
  try {
    const parsed = JSON.parse(decrypt(dbPath, row.ownerKey, row.secret)) as unknown
    if (!isObject(parsed)) return null
    return {
      ownerKey: row.ownerKey,
      cookies: Array.isArray(parsed.cookies) ? (parsed.cookies as BrowserStorageCookie[]) : [],
      origins: Array.isArray(parsed.origins) ? (parsed.origins as BrowserStorageOrigin[]) : [],
      updatedAt: row.updatedAt,
    }
  } catch {
    return null
  }
}

function cookieDomain(cookie: BrowserStorageCookie): string {
  return String(cookie?.domain ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\./, '')
}

function hostnameOf(origin: string): string {
  try {
    return new URL(origin).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function cookieBelongs(cookie: BrowserStorageCookie, origin: string): boolean {
  const host = hostnameOf(origin)
  const domain = cookieDomain(cookie)
  if (!host || !domain) return false
  return host === domain || host.endsWith(`.${domain}`)
}

function sanitizeCookie(raw: unknown): BrowserStorageCookie | null {
  if (!isObject(raw)) return null
  const name = String(raw.name ?? '')
  const value = String(raw.value ?? '')
  const domain = String(raw.domain ?? '')
  const path = String(raw.path ?? '/')
  if (!name || name.length > 512 || value.length > 8_192 || !domain || domain.length > 512) return null
  const cookie: BrowserStorageCookie = {
    name,
    value,
    domain,
    path: path || '/',
    expires: typeof raw.expires === 'number' && Number.isFinite(raw.expires) ? raw.expires : -1,
    httpOnly: raw.httpOnly === true,
    secure: raw.secure === true,
    sameSite: raw.sameSite === 'Strict' || raw.sameSite === 'None' ? raw.sameSite : 'Lax',
  }
  return cookie
}

function sanitizeOrigin(raw: unknown): BrowserStorageOrigin | null {
  if (!isObject(raw)) return null
  const origin = String(raw.origin ?? '')
  if (!origin) return null
  const localStorage = Array.isArray(raw.localStorage)
    ? raw.localStorage
        .map((item) => {
          if (!isObject(item)) return null
          const name = String(item.name ?? '')
          const value = String(item.value ?? '')
          if (!name || name.length > 1_024 || value.length > 32_768) return null
          return { name, value }
        })
        .filter((item): item is { name: string; value: string } => Boolean(item))
        .slice(0, MAX_LOCAL_STORAGE_ITEMS)
    : []
  return { origin, localStorage }
}

/** 只保留当前站点 origin 的 Cookie 和 localStorage，避免混入其他站点。 */
export function filterStorageStateForOrigin(raw: unknown, rawOrigin: string): BrowserStorageState {
  const origin = normalizeBrowserOrigin(rawOrigin)
  if (!isObject(raw)) return { cookies: [], origins: [] }
  const cookies = Array.isArray(raw.cookies)
    ? raw.cookies
        .map(sanitizeCookie)
        .filter((cookie): cookie is BrowserStorageCookie => {
          if (!cookie) return false
          return cookieBelongs(cookie, origin)
        })
        .slice(0, MAX_COOKIES)
    : []
  const origins = Array.isArray(raw.origins)
    ? raw.origins
        .map(sanitizeOrigin)
        .filter((item): item is BrowserStorageOrigin => {
          if (!item) return false
          return item.origin === origin
        })
    : []
  return { cookies, origins }
}

function writeFile(file: string, rows: SessionFile): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(rows, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temp, file)
  try {
    hardenRuntimePath(file)
  } catch {
    /* 权限收紧失败不阻断保存 */
  }
}

function readRecord(dbPath: string, ownerKey: string): SessionRecord | null {
  const row = readStoredRows(sessionsPath(dbPath))[ownerId(ownerKey)]
  if (!row || row.ownerKey !== ownerKey) return null
  return decodeRecord(dbPath, row)
}

function writeRecord(dbPath: string, record: SessionRecord): void {
  const file = sessionsPath(dbPath)
  const rows = readStoredRows(file)
  const id = ownerId(record.ownerKey)
  rows[id] = {
    ownerKey: record.ownerKey,
    updatedAt: record.updatedAt,
    secret: encrypt(
      dbPath,
      record.ownerKey,
      JSON.stringify({ cookies: record.cookies, origins: record.origins }),
    ),
  }
  writeFile(file, rows)
}

export function saveBrowserSession(
  dbPath: string,
  ownerKey: string,
  rawOrigin: string,
  rawState: unknown,
  now = Date.now(),
): BrowserSessionStatus {
  if (!ownerKey) throw new EabError(EC.VALIDATION, '缺少登录态归属用户')
  const origin = normalizeBrowserOrigin(rawOrigin)
  const scoped = filterStorageStateForOrigin(rawState, origin)
  const existing = readRecord(dbPath, ownerKey)
  const others = existing
    ? {
        cookies: existing.cookies.filter((cookie) => !cookieBelongs(cookie, origin)),
        origins: existing.origins.filter((item) => item.origin !== origin),
      }
    : { cookies: [], origins: [] }
  const cookies = [...others.cookies, ...scoped.cookies].slice(-MAX_COOKIES)
  const origins = [...others.origins, ...scoped.origins]
  const plain = JSON.stringify({ cookies, origins })
  if (Buffer.byteLength(plain, 'utf8') > MAX_PLAIN_BYTES) {
    throw new EabError(EC.VALIDATION, '登录态过大，请减少本站本地存储后再保存')
  }
  if (!cookies.length && !scoped.origins.some((item) => item.localStorage.length)) {
    throw new EabError(EC.VALIDATION, '当前站点没有可保存的登录态', {
      hint: '先完成登录，再点“保存登录态”',
    })
  }
  writeRecord(dbPath, { ownerKey, cookies, origins, updatedAt: now })
  return {
    configured: true,
    origin,
    cookieCount: scoped.cookies.length,
    localStorageCount: scoped.origins.reduce((sum, item) => sum + item.localStorage.length, 0),
    updatedAt: now,
  }
}

export function getBrowserSessionStatus(
  dbPath: string,
  ownerKey: string,
  rawOrigin: string,
): BrowserSessionStatus {
  const origin = normalizeBrowserOrigin(rawOrigin)
  const record = readRecord(dbPath, ownerKey)
  if (!record) {
    return { configured: false, origin, cookieCount: 0, localStorageCount: 0, updatedAt: null }
  }
  const cookies = record.cookies.filter((cookie) => cookieBelongs(cookie, origin))
  const localStorageCount = record.origins
    .filter((item) => item.origin === origin)
    .reduce((sum, item) => sum + item.localStorage.length, 0)
  return {
    configured: cookies.length + localStorageCount > 0,
    origin,
    cookieCount: cookies.length,
    localStorageCount,
    updatedAt: record.updatedAt,
  }
}

/** 返回给浏览器上下文恢复使用；损坏时返回 null，不阻断打开网页。 */
export function readBrowserSessionState(dbPath: string, ownerKey: string): BrowserStorageState | null {
  const record = readRecord(dbPath, ownerKey)
  if (!record) return null
  if (!record.cookies.length && !record.origins.length) return null
  return { cookies: record.cookies, origins: record.origins }
}

export function deleteBrowserSession(
  dbPath: string,
  ownerKey: string,
  rawOrigin: string,
): BrowserSessionStatus {
  const origin = normalizeBrowserOrigin(rawOrigin)
  const file = sessionsPath(dbPath)
  const rows = readStoredRows(file)
  const id = ownerId(ownerKey)
  const row = rows[id]
  if (row && row.ownerKey === ownerKey) {
    const record = decodeRecord(dbPath, row)
    if (record) {
      const cookies = record.cookies.filter((cookie) => !cookieBelongs(cookie, origin))
      const origins = record.origins.filter((item) => item.origin !== origin)
      if (cookies.length || origins.length) {
        writeRecord(dbPath, { ownerKey, cookies, origins, updatedAt: Date.now() })
      } else {
        delete rows[id]
        writeFile(file, rows)
      }
    }
  }
  return { configured: false, origin, cookieCount: 0, localStorageCount: 0, updatedAt: null }
}
