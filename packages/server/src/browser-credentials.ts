/**
 * 浏览器站点凭据库 v1。
 *
 * 边界：
 * 1. 凭据按「公司 + 用户 + 站点 origin」隔离，不能跨用户读取；
 * 2. 用户名按需回显，密码只以 AES-256-GCM 密文落盘，不写数据库、不进模型上下文；
 * 3. 主密钥单独存放并收紧权限；凭据文件只存密文与认证标签；
 * 4. 本模块只给服务端工作台接口使用，不导出给 Agent 工具。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { EC, EabError } from '@eab/domain'
import { hardenRuntimePath } from './runtime-permissions.js'

interface EncryptedValue {
  iv: string
  tag: string
  data: string
}

interface CredentialRecord {
  ownerKey: string
  origin: string
  username: string
  secret: EncryptedValue
  updatedAt: number
}

type CredentialFile = Record<string, CredentialRecord>

export interface BrowserCredentialStatus {
  configured: boolean
  origin: string
  username: string | null
  updatedAt: number | null
}

function credentialsPath(dbPath: string): string {
  return join(dirname(dbPath), 'browser-credentials.json')
}

function keyPath(dbPath: string): string {
  return join(dirname(dbPath), 'browser-credentials.key')
}

function recordId(ownerKey: string, origin: string): string {
  return createHash('sha256').update(`${ownerKey}\n${origin}`).digest('hex')
}

function readJson(file: string): CredentialFile {
  if (!existsSync(file)) return {}
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: CredentialFile = {}
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!/^[a-f0-9]{64}$/.test(id) || !value || typeof value !== 'object') continue
      const row = value as Record<string, unknown>
      const encrypted = row.secret
      if (!encrypted || typeof encrypted !== 'object') continue
      const secret = encrypted as Record<string, unknown>
      if (
        typeof row.ownerKey !== 'string' ||
        typeof row.origin !== 'string' ||
        typeof row.username !== 'string' ||
        typeof row.updatedAt !== 'number' ||
        typeof secret.iv !== 'string' ||
        typeof secret.tag !== 'string' ||
        typeof secret.data !== 'string'
      ) {
        continue
      }
      out[id] = {
        ownerKey: row.ownerKey,
        origin: row.origin,
        username: row.username,
        secret: { iv: secret.iv, tag: secret.tag, data: secret.data },
        updatedAt: row.updatedAt,
      }
    }
    return out
  } catch {
    return {}
  }
}

/** 主密钥只生成一次；文件权限收紧到当前用户。 */
function readKey(dbPath: string): Buffer {
  const file = keyPath(dbPath)
  if (existsSync(file)) {
    const key = readFileSync(file)
    if (key.length !== 32) throw new EabError(EC.INTERNAL, '浏览器凭据主密钥损坏')
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
    if (key.length !== 32) throw new EabError(EC.INTERNAL, '浏览器凭据主密钥损坏')
    return key
  }
}

function encrypt(dbPath: string, ownerKey: string, origin: string, plain: string): EncryptedValue {
  const key = readKey(dbPath)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(`${ownerKey}\n${origin}`, 'utf8'))
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }
}

function decrypt(dbPath: string, ownerKey: string, origin: string, secret: EncryptedValue): string {
  try {
    const key = readKey(dbPath)
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(secret.iv, 'base64'))
    decipher.setAAD(Buffer.from(`${ownerKey}\n${origin}`, 'utf8'))
    decipher.setAuthTag(Buffer.from(secret.tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(secret.data, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    throw new EabError(EC.CONFLICT, '保存的登录信息无法解密，请重新保存', {
      hint: '可能更换过数据目录或凭据文件被修改；删除后重新保存本站账号',
    })
  }
}

function writeFile(file: string, value: CredentialFile): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temp, file)
  try {
    hardenRuntimePath(file)
  } catch {
    /* 权限收紧失败不阻断保存；启动时会再收紧运行目录 */
  }
}

export function normalizeBrowserOrigin(raw: string): string {
  const text = String(raw ?? '').trim()
  if (!text) throw new EabError(EC.VALIDATION, '站点地址不能为空')
  if (text.length > 2_000) throw new EabError(EC.VALIDATION, '站点地址过长')
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new EabError(EC.VALIDATION, '站点地址无效', { hint: '请输入完整的 http/https 地址' })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new EabError(EC.VALIDATION, '只支持 http/https 站点')
  }
  if (url.username || url.password) {
    throw new EabError(EC.VALIDATION, '站点地址不能包含账号密码')
  }
  return url.origin
}

export function saveBrowserCredential(
  dbPath: string,
  ownerKey: string,
  rawOrigin: string,
  username: string,
  password: string,
  now = Date.now(),
): BrowserCredentialStatus {
  const origin = normalizeBrowserOrigin(rawOrigin)
  const user = String(username ?? '').trim()
  const pass = String(password ?? '')
  if (!ownerKey) throw new EabError(EC.VALIDATION, '缺少凭据归属用户')
  if (!user) throw new EabError(EC.VALIDATION, '账号不能为空')
  if (user.length > 256) throw new EabError(EC.VALIDATION, '账号过长')
  if (!pass) throw new EabError(EC.VALIDATION, '密码不能为空')
  if (pass.length > 512) throw new EabError(EC.VALIDATION, '密码过长')
  if (user.includes('\n') || user.includes('\r') || pass.includes('\n') || pass.includes('\r')) {
    throw new EabError(EC.VALIDATION, '账号或密码不能包含换行')
  }

  const file = credentialsPath(dbPath)
  const rows = readJson(file)
  const id = recordId(ownerKey, origin)
  rows[id] = {
    ownerKey,
    origin,
    username: user,
    secret: encrypt(dbPath, ownerKey, origin, pass),
    updatedAt: now,
  }
  writeFile(file, rows)
  return { configured: true, origin, username: user, updatedAt: now }
}

export function getBrowserCredentialStatus(
  dbPath: string,
  ownerKey: string,
  rawOrigin: string,
): BrowserCredentialStatus {
  const origin = normalizeBrowserOrigin(rawOrigin)
  const row = readJson(credentialsPath(dbPath))[recordId(ownerKey, origin)]
  if (!row || row.ownerKey !== ownerKey || row.origin !== origin) {
    return { configured: false, origin, username: null, updatedAt: null }
  }
  return { configured: true, origin, username: row.username, updatedAt: row.updatedAt }
}

/** 只返回给服务端填充流程，调用方不得把结果写入日志、审计或模型上下文。 */
export function readBrowserCredential(
  dbPath: string,
  ownerKey: string,
  rawOrigin: string,
): { origin: string; username: string; password: string } {
  const origin = normalizeBrowserOrigin(rawOrigin)
  const row = readJson(credentialsPath(dbPath))[recordId(ownerKey, origin)]
  if (!row || row.ownerKey !== ownerKey || row.origin !== origin) {
    throw new EabError(EC.NOT_FOUND, '本站还没有保存登录信息', { hint: '先保存账号密码，再填入' })
  }
  return { origin, username: row.username, password: decrypt(dbPath, ownerKey, origin, row.secret) }
}

export function deleteBrowserCredential(
  dbPath: string,
  ownerKey: string,
  rawOrigin: string,
): BrowserCredentialStatus {
  const origin = normalizeBrowserOrigin(rawOrigin)
  const file = credentialsPath(dbPath)
  const rows = readJson(file)
  const id = recordId(ownerKey, origin)
  if (id in rows) {
    delete rows[id]
    writeFile(file, rows)
  }
  return { configured: false, origin, username: null, updatedAt: null }
}
