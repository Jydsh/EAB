import { beforeEach, describe, expect, it } from 'vitest'
import {
  checkLoginGuard,
  clearLoginFailures,
  loginGuardKey,
  recordLoginFailure,
  resetLoginGuard,
} from '../src/console-login-guard.js'

const options = { maxFailures: 5, lockMs: 10 * 60_000, globalMaxFailures: 30, globalWindowMs: 10 * 60_000 }

describe('控制台登录守卫', () => {
  beforeEach(() => resetLoginGuard())

  it('连续失败 5 次后锁定，期间同一来源直接被拒', () => {
    const key = loginGuardKey('127.0.0.1', 'admin')
    let last = checkLoginGuard(key, options, 1_000)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      last = recordLoginFailure(key, options, 1_000 + attempt)
    }
    expect(last.locked).toBe(true)
    expect(last.scope).toBe('account')
    expect(last.retryAfterMs).toBeGreaterThan(0)

    const checked = checkLoginGuard(key, options, 2_000)
    expect(checked.locked).toBe(true)
    expect(checked.retryAfterMs).toBeGreaterThanOrEqual(10 * 60_000 - 1_000)
  })

  it('锁定期过后自动恢复', () => {
    const key = loginGuardKey('127.0.0.1', 'admin')
    for (let attempt = 0; attempt < 5; attempt += 1) recordLoginFailure(key, options, 1_000)
    expect(checkLoginGuard(key, options, 1_000 + 10 * 60_000 + 1).locked).toBe(false)
  })

  it('登录成功后清掉失败计数', () => {
    const key = loginGuardKey('127.0.0.1', 'admin')
    recordLoginFailure(key, options, 1_000)
    recordLoginFailure(key, options, 1_001)
    clearLoginFailures(key)
    expect(checkLoginGuard(key, options, 1_002).failures).toBe(0)
    // 清空后再失败 4 次也不锁：计数确实从 0 开始。
    for (let attempt = 0; attempt < 4; attempt += 1) recordLoginFailure(key, options, 1_003 + attempt)
    expect(checkLoginGuard(key, options, 1_010).locked).toBe(false)
  })

  it('换账号名继续试也会触发全局锁定', () => {
    let locked = false
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const result = recordLoginFailure(loginGuardKey('10.0.0.9', `guess-${attempt}`), options, 5_000 + attempt)
      if (result.locked && result.scope === 'global') locked = true
    }
    expect(locked).toBe(true)
    const other = checkLoginGuard(loginGuardKey('10.0.0.9', 'admin'), options, 5_100)
    expect(other.locked).toBe(true)
    expect(other.scope).toBe('global')
  })
})
