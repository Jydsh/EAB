import { describe, expect, it } from 'vitest'
import {
  ALL_SCOPES,
  SC,
  SCOPE_REGISTRY,
  expandScopes,
  isKnownScope,
  scopeAllows,
  type Scope,
} from '@eab/domain'

describe('scope 目录', () => {
  it('每个常量都在 registry 里登记', () => {
    for (const scope of ALL_SCOPES) {
      expect(SCOPE_REGISTRY[scope], `未登记: ${scope}`).toBeDefined()
      expect(SCOPE_REGISTRY[scope].group.length).toBeGreaterThan(0)
      expect(SCOPE_REGISTRY[scope].label.length).toBeGreaterThan(0)
    }
  })

  it('没有重复定义', () => {
    expect(new Set(ALL_SCOPES).size).toBe(ALL_SCOPES.length)
  })

  it('命名形如 资源:动作[:限定]', () => {
    for (const scope of ALL_SCOPES) {
      expect(scope, scope).toMatch(/^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*){1,2}$/)
    }
  })

  it('隐含关系是传递的', () => {
    const granted = expandScopes([SC.KB_ADMIN])
    expect(granted.has(SC.KB_WRITE)).toBe(true)
    expect(granted.has(SC.KB_READ)).toBe(true)
  })

  it('scopeAllows 尊重隐含关系，不会反向放大', () => {
    const adminHeld = new Set<Scope>([SC.KB_ADMIN])
    expect(scopeAllows(adminHeld, SC.KB_READ)).toBe(true)

    const readerHeld = new Set<Scope>([SC.KB_READ])
    expect(scopeAllows(readerHeld, SC.KB_ADMIN)).toBe(false)
    expect(scopeAllows(readerHeld, SC.KB_WRITE)).toBe(false)
  })

  it('未登记 scope 不被识别', () => {
    expect(isKnownScope(SC.CHAT_USE)).toBe(true)
    expect(isKnownScope('kb:hack')).toBe(false)
    expect(isKnownScope('')).toBe(false)
  })

  it('高危 scope 被标记（控制台二次确认的依据）', () => {
    expect(SCOPE_REGISTRY[SC.AUTHZ_ROLE_MANAGE].dangerous).toBe(true)
    expect(SCOPE_REGISTRY[SC.SYSTEM_RESTORE].dangerous).toBe(true)
    expect(SCOPE_REGISTRY[SC.CHAT_USE].dangerous).toBeUndefined()
  })
})
