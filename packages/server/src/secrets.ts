/**
 * 控制台写入的密钥（模型 API Key / 渠道 Secret）。
 *
 * 设计边界：
 * 1. 数据库只存"引用名"（api_key_env / secret_ref），不存明文；
 * 2. 进程环境变量优先，其次读同目录 secrets.json（只给单机部署/开发机用）；
 * 3. 文件写入用 0600 权限，目录不存在先建；
 * 4. 控制台接口只返回"是否已配置"，不回显值。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

type SecretFile = Record<string, string>

function secretsPath(dbPath: string): string {
  return join(dirname(dbPath), 'secrets.json')
}

function readFile(file: string): SecretFile {
  if (!existsSync(file)) return {}
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: SecretFile = {}
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

/** 解析密钥：环境变量优先，其次本地 secrets.json。 */
export function resolveSecret(dbPath: string, ref: string | null | undefined): string {
  if (!ref) return ''
  const fromEnv = process.env[ref]
  if (fromEnv) return fromEnv
  return readFile(secretsPath(dbPath))[ref] ?? ''
}

/** 写入密钥并返回引用名；ref 为空时自动生成。 */
export function storeSecret(dbPath: string, ref: string | null | undefined, value: string, prefix: string): string {
  const name = (ref && /^[A-Za-z_][A-Za-z0-9_]*$/.test(ref) ? ref : `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`)
  const file = secretsPath(dbPath)
  mkdirSync(dirname(file), { recursive: true })
  const current = readFile(file)
  current[name] = value
  writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    chmodSync(file, 0o600)
  } catch {
    /* Windows 上 chmod 只是尽力而为 */
  }
  return name
}

export function secretConfigured(dbPath: string, ref: string | null | undefined): boolean {
  return Boolean(resolveSecret(dbPath, ref))
}

/** 删除一个引用对应的本地密钥；环境变量里的同名项不会被删除。 */
export function deleteSecret(dbPath: string, ref: string | null | undefined): void {
  const name = typeof ref === 'string' ? ref.trim() : ''
  if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return
  const file = secretsPath(dbPath)
  if (!existsSync(file)) return
  const current = readFile(file)
  if (!(name in current)) return
  delete current[name]
  writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}
