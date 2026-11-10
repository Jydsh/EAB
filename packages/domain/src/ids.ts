/**
 * ULID：48 位时间戳 + 80 位随机，Crockford Base32 编码，共 26 字符。
 * 用途：全库主键。字典序即时间序，分页与索引友好，避免自增整数暴露业务规模。
 *
 * 注意：同毫秒内不保证严格单调（随机位不递增）。需要严格顺序的场景用显式 seq 字段。
 */
import { randomBytes } from 'node:crypto'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const TIME_LEN = 10
const RAND_LEN = 16
const ULID_LEN = TIME_LEN + RAND_LEN

function encodeTime(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0 || ms > 0xffffffffffff) {
    throw new RangeError(`ULID 时间戳越界: ${ms}`)
  }
  let value = ms
  let out = ''
  for (let i = 0; i < TIME_LEN; i++) {
    const mod = value % 32
    out = (ALPHABET[mod] as string) + out
    value = Math.floor(value / 32)
  }
  if (value !== 0) throw new RangeError('ULID 时间戳超出编码长度')
  return out
}

function decodeTime(id: string): number {
  let value = 0
  for (let i = 0; i < TIME_LEN; i++) {
    const char = id[i] as string
    const index = ALPHABET.indexOf(char)
    if (index < 0) throw new RangeError(`ULID 含非法字符: ${char}`)
    value = value * 32 + index
  }
  return value
}

function encodeRandom(bytes: Uint8Array): string {
  // 16 个 Base32 字符 = 80 bit
  let out = ''
  let buffer = 0
  let bits = 0
  for (let i = 0; i < bytes.length; i++) {
    buffer = (buffer << 8) | (bytes[i] as number)
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += ALPHABET[(buffer >>> bits) & 0x1f]
    }
  }
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 0x1f]
  return out.slice(0, RAND_LEN)
}

export function ulid(now: number = Date.now()): string {
  const random = randomBytes(10)
  return encodeTime(now) + encodeRandom(random)
}

export function isUlid(value: string): boolean {
  if (value.length !== ULID_LEN) return false
  for (let i = 0; i < value.length; i++) {
    if (ALPHABET.indexOf(value[i] as string) < 0) return false
  }
  return true
}

export function ulidTimestamp(id: string): number {
  if (!isUlid(id)) throw new TypeError(`非法 ULID: ${id}`)
  return decodeTime(id)
}

/** 前缀过滤用：取某个时间点对应的 ULID 时间前缀 */
export function ulidTimePrefix(ms: number): string {
  return encodeTime(ms)
}
