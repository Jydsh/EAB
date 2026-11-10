import { describe, expect, it } from 'vitest'
import { isUlid, ulid, ulidTimestamp } from '@eab/domain'

describe('ULID', () => {
  it('生成 26 位 Crockford Base32', () => {
    const id = ulid()
    expect(id).toHaveLength(26)
    expect(isUlid(id)).toBe(true)
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  it('时间戳可还原', () => {
    const now = 1_760_000_000_000
    const id = ulid(now)
    expect(ulidTimestamp(id)).toBe(now)
  })

  it('同毫秒内不重复', () => {
    const now = Date.now()
    const ids = new Set(Array.from({ length: 200 }, () => ulid(now)))
    expect(ids.size).toBe(200)
  })

  it('字典序随时间递增', () => {
    const a = ulid(1_700_000_000_000)
    const b = ulid(1_700_000_001_000)
    expect(a < b).toBe(true)
  })

  it('拒绝非法输入', () => {
    expect(() => ulid(-1)).toThrow(RangeError)
    expect(() => ulidTimestamp('not-a-ulid')).toThrow(TypeError)
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(true)
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FA')).toBe(false)
    expect(isUlid('01arz3ndektsv4rrffq69g5fav')).toBe(false)
  })
})
