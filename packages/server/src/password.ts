/**
 * 员工密码哈希。
 *
 * 不引第三方依赖：Node 内置 scrypt 即足够（Argon2id 需要原生模块，Windows 部署成本高）。
 * 存储格式 `scrypt$N$r$p$salt$hash`，参数随哈希一起存，后续调参不用迁移旧密码。
 * 校验时固定时间比较，避免按字节提前返回。
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const N = 16384
const R = 8
const P = 1
const KEY_LEN = 32

export function hashPassword(password: string): string {
  if (password.length < 8) throw new Error('密码至少 8 位')
  if (password.length > 128) throw new Error('密码最多 128 位')
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, KEY_LEN, { N, r: R, p: P }).toString('hex')
  return `scrypt$${N}$${R}$${P}$${salt}$${hash}`
}

export function verifyPassword(stored: string | null, password: string): boolean {
  if (!stored || !password) return false
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, n, r, p, salt, expected] = parts
  const want = Buffer.from(expected!, 'hex')
  const got = scryptSync(password, salt!, want.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  })
  return want.length === got.length && timingSafeEqual(want, got)
}
