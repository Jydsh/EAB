import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  deleteBrowserCredential,
  getBrowserCredentialStatus,
  normalizeBrowserOrigin,
  readBrowserCredential,
  saveBrowserCredential,
} from '../src/browser-credentials.js'

function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), 'eab-browser-cred-')), 'eab.db')
}

describe('浏览器站点凭据库', () => {
  it('按用户和 origin 保存，状态只回账号，密码不落明文', () => {
    const db = tempDb()
    const status = saveBrowserCredential(db, 'c1:u1', 'https://example.com/login?x=1', 'alice', 'S3cret!')
    expect(status).toMatchObject({ configured: true, origin: 'https://example.com', username: 'alice' })
    expect(getBrowserCredentialStatus(db, 'c1:u1', 'https://example.com/other')).toMatchObject({
      configured: true,
      username: 'alice',
    })
    const raw = readFileSync(join(dirname(db), 'browser-credentials.json'), 'utf8')
    expect(raw).not.toContain('S3cret!')
    expect(raw).not.toContain('alice@example.com')
    expect(raw).not.toContain('"password"')
    expect(readBrowserCredential(db, 'c1:u1', 'https://example.com')).toEqual({
      origin: 'https://example.com',
      username: 'alice',
      password: 'S3cret!',
    })
  })

  it('不同用户、不同站点互相隔离', () => {
    const db = tempDb()
    saveBrowserCredential(db, 'c1:u1', 'https://a.example', 'alice', 'a-pass')
    expect(getBrowserCredentialStatus(db, 'c1:u2', 'https://a.example').configured).toBe(false)
    expect(getBrowserCredentialStatus(db, 'c1:u1', 'https://b.example').configured).toBe(false)
    expect(() => readBrowserCredential(db, 'c1:u2', 'https://a.example')).toThrow(/还没有保存/)
  })

  it('同站点重存覆盖账号，删除后状态清空', () => {
    const db = tempDb()
    saveBrowserCredential(db, 'c1:u1', 'https://example.com', 'alice', 'old')
    saveBrowserCredential(db, 'c1:u1', 'https://example.com', 'bob', 'new')
    expect(readBrowserCredential(db, 'c1:u1', 'https://example.com').username).toBe('bob')
    expect(deleteBrowserCredential(db, 'c1:u1', 'https://example.com').configured).toBe(false)
    expect(getBrowserCredentialStatus(db, 'c1:u1', 'https://example.com').configured).toBe(false)
  })

  it('只接受 http/https，拒绝带账号密码的地址', () => {
    expect(normalizeBrowserOrigin('https://example.com/a/b?q=1')).toBe('https://example.com')
    expect(normalizeBrowserOrigin('http://example.com:8080/x')).toBe('http://example.com:8080')
    expect(() => normalizeBrowserOrigin('ftp://example.com')).toThrow(/http\/https/)
    expect(() => normalizeBrowserOrigin('https://user:pass@example.com')).toThrow(/不能包含账号密码/)
    expect(() => normalizeBrowserOrigin('not a url')).toThrow(/无效/)
  })

  it('密文被篡改时拒绝解密', () => {
    const db = tempDb()
    saveBrowserCredential(db, 'c1:u1', 'https://example.com', 'alice', 'secret')
    const file = join(dirname(db), 'browser-credentials.json')
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { secret: { data: string } }>
    const first = Object.values(parsed)[0]
    first.secret.data = Buffer.from('tampered').toString('base64')
    writeFileSync(file, JSON.stringify(parsed))
    expect(() => readBrowserCredential(db, 'c1:u1', 'https://example.com')).toThrow(/无法解密/)
  })
})
