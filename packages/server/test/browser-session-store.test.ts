import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EC } from '@eab/domain'
import { describe, expect, it } from 'vitest'
import {
  deleteBrowserSession,
  filterStorageStateForOrigin,
  getBrowserSessionStatus,
  readBrowserSessionState,
  saveBrowserSession,
} from '../src/browser-session-store.js'

function dbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'eab-session-')), 'eab.db')
}

function storageState(origin: string, value: string) {
  return {
    cookies: [
      { name: 'sid', value, domain: new URL(origin).hostname, path: '/', httpOnly: true, secure: true },
      { name: 'foreign', value: 'must-not-save', domain: 'other.example.com', path: '/' },
    ],
    origins: [{ origin, localStorage: [{ name: 'token', value }] }],
  }
}

describe('浏览器登录态库', () => {
  it('按 origin 过滤 Cookie 和 localStorage，并加密落盘', () => {
    const db = dbPath()
    const origin = 'https://work.example.com'
    const status = saveBrowserSession(db, 'c1:u1', origin, storageState(origin, 'session-secret'), 1000)
    expect(status).toMatchObject({ configured: true, cookieCount: 1, localStorageCount: 1 })
    const raw = readFileSync(join(db, '..', 'browser-sessions.json'), 'utf8')
    expect(raw).not.toContain('session-secret')
    expect(raw).not.toContain('must-not-save')
    const key = readFileSync(join(db, '..', 'browser-sessions.key'))
    expect(key.length).toBe(32)
    const state = readBrowserSessionState(db, 'c1:u1')
    expect(state?.cookies.map((cookie) => cookie.name)).toEqual(['sid'])
    expect(state?.origins[0]?.localStorage[0]?.value).toBe('session-secret')
  })

  it('按用户隔离，不跨用户读取', () => {
    const db = dbPath()
    const origin = 'https://work.example.com'
    saveBrowserSession(db, 'c1:u1', origin, storageState(origin, 'one'), 1000)
    expect(readBrowserSessionState(db, 'c1:u2')).toBeNull()
    expect(getBrowserSessionStatus(db, 'c1:u2', origin).configured).toBe(false)
  })

  it('同一用户多站点合并保存，删除只影响本站', () => {
    const db = dbPath()
    const a = 'https://a.example.com'
    const b = 'https://b.example.com'
    saveBrowserSession(db, 'c1:u1', a, storageState(a, 'a-value'), 1000)
    saveBrowserSession(db, 'c1:u1', b, storageState(b, 'b-value'), 2000)
    const state = readBrowserSessionState(db, 'c1:u1')
    expect(state?.cookies.map((cookie) => cookie.domain).sort()).toEqual(['a.example.com', 'b.example.com'])
    expect(state?.origins.map((item) => item.origin).sort()).toEqual([a, b])
    deleteBrowserSession(db, 'c1:u1', a)
    expect(getBrowserSessionStatus(db, 'c1:u1', a).configured).toBe(false)
    expect(getBrowserSessionStatus(db, 'c1:u1', b).configured).toBe(true)
  })

  it('拒绝没有可保存内容的空状态', () => {
    const db = dbPath()
    expect(() => saveBrowserSession(db, 'c1:u1', 'https://empty.example.com', { cookies: [], origins: [] })).toThrow(
      /没有可保存/,
    )
  })

  it('拒绝非 http/https 站点', () => {
    const db = dbPath()
    expect(() => saveBrowserSession(db, 'c1:u1', 'file:///etc/passwd', { cookies: [], origins: [] })).toThrow(
      /只支持 http\/https/,
    )
  })

  it('密文被篡改时拒绝恢复', () => {
    const db = dbPath()
    const origin = 'https://work.example.com'
    saveBrowserSession(db, 'c1:u1', origin, storageState(origin, 'tamper-me'), 1000)
    const file = join(db, '..', 'browser-sessions.json')
    const rows = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { secret: { data: string } }>
    const first = Object.values(rows)[0]!
    first.secret.data = Buffer.from('tampered').toString('base64')
    writeFileSync(file, JSON.stringify(rows), 'utf8')
    expect(readBrowserSessionState(db, 'c1:u1')).toBeNull()
  })

  it('过滤函数只保留当前 origin 的 Cookie', () => {
    const origin = 'https://app.example.com'
    const filtered = filterStorageStateForOrigin(
      {
        cookies: [
          { name: 'ok', value: '1', domain: '.example.com', path: '/' },
          { name: 'bad', value: '2', domain: 'evil.example.org', path: '/' },
        ],
        origins: [
          { origin, localStorage: [{ name: 'k', value: 'v' }] },
          { origin: 'https://evil.example.org', localStorage: [{ name: 'x', value: 'y' }] },
        ],
      },
      origin,
    )
    expect(filtered.cookies.map((cookie) => cookie.name)).toEqual(['ok'])
    expect(filtered.origins.map((item) => item.origin)).toEqual([origin])
  })

  it('错误码可区分校验失败', () => {
    try {
      saveBrowserSession(dbPath(), 'c1:u1', 'https://empty.example.com', { cookies: [] })
      throw new Error('should not reach')
    } catch (err) {
      expect((err as { code?: string }).code).toBe(EC.VALIDATION)
    }
  })
})
