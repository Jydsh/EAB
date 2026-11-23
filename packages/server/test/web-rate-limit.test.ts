import { describe, expect, it, beforeEach } from 'vitest'
import {
  assertWebToolRateLimit,
  consumeWebToolRateLimit,
  resetWebToolRateLimit,
  webToolRateLimit,
} from '../src/web-rate-limit.js'
import { EabError } from '@eab/domain'

beforeEach(() => resetWebToolRateLimit())

describe('web tool rate limit', () => {
  it('defaults to 10 searches per minute and allows the first ten', () => {
    expect(webToolRateLimit('web.search', {})).toBe(10)
    for (let i = 0; i < 10; i += 1) {
      expect(consumeWebToolRateLimit('c1', 'u1', 'web.search', 1_000).allowed).toBe(true)
    }
    const blocked = consumeWebToolRateLimit('c1', 'u1', 'web.search', 1_000)
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterMs).toBe(60_000)
  })

  it('resets after the one minute window', () => {
    for (let i = 0; i < 10; i += 1) consumeWebToolRateLimit('c1', 'u1', 'web.search', 1_000)
    expect(consumeWebToolRateLimit('c1', 'u1', 'web.search', 61_000).allowed).toBe(true)
  })

  it('counts separately per user and per tool', () => {
    for (let i = 0; i < 10; i += 1) consumeWebToolRateLimit('c1', 'u1', 'web.search', 1_000)
    expect(consumeWebToolRateLimit('c1', 'u2', 'web.search', 1_000).allowed).toBe(true)
    expect(consumeWebToolRateLimit('c1', 'u1', 'web.fetch', 1_000).allowed).toBe(true)
    expect(consumeWebToolRateLimit('c2', 'u1', 'web.search', 1_000).allowed).toBe(true)
  })

  it('reads per-tool overrides and rejects non-positive values', () => {
    expect(webToolRateLimit('web.fetch', { EAB_WEB_FETCH_PER_MIN: '3' })).toBe(3)
    expect(webToolRateLimit('browser', { EAB_BROWSER_PER_MIN: '0' })).toBe(20)
    expect(webToolRateLimit('web.search', { EAB_WEB_SEARCH_PER_MIN: '-5' })).toBe(10)
  })

  it('throws a rate-limited error with retry guidance', () => {
    for (let i = 0; i < 10; i += 1) consumeWebToolRateLimit('c1', 'u1', 'web.search', 1_000)
    expect(() => assertWebToolRateLimit('c1', 'u1', 'web.search', 1_000)).toThrowError(EabError)
    try {
      assertWebToolRateLimit('c1', 'u1', 'web.search', 1_000)
    } catch (error) {
      expect((error as EabError).code).toBe('EAB_RATE_LIMITED')
      expect((error as EabError).hint).toContain('10')
    }
  })
})
