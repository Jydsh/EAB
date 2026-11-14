import { describe, expect, it } from 'vitest'
import type { FastifyRequest } from 'fastify'
import type { ServerConfig } from '../src/config.js'
import {
  configureConsoleAuth,
  createSession,
  hasConsoleSession,
  sessionFromRequest,
  setAdminPassword,
} from '../src/console-auth.js'

function configWith(password: string): ServerConfig {
  return { adminUser: 'admin', adminPassword: password } as ServerConfig
}

function requestWith(sessionId: string | null): FastifyRequest {
  return {
    headers: sessionId ? { cookie: `eab_console_sid=${encodeURIComponent(sessionId)}` } : {},
    ip: '127.0.0.1',
  } as unknown as FastifyRequest
}

describe('控制台会话（签名 Cookie）', () => {
  it('签发后能验回同一身份，篡改内容验不过', () => {
    configureConsoleAuth(configWith('first-password'))
    const session = createSession('admin', '127.0.0.1')
    const read = sessionFromRequest(requestWith(session.id))
    expect(read?.user).toBe('admin')
    expect(hasConsoleSession(requestWith(session.id))).toBe(true)

    const tampered = `${session.id.slice(0, -2)}xx`
    expect(sessionFromRequest(requestWith(tampered))).toBeNull()
    expect(sessionFromRequest(requestWith(null))).toBeNull()
  })

  it('改密码后旧会话全端失效，当前设备换发的新会话有效', () => {
    configureConsoleAuth(configWith('first-password'))
    const before = createSession('admin', '127.0.0.1')
    expect(sessionFromRequest(requestWith(before.id))).not.toBeNull()

    setAdminPassword('second-password')
    expect(sessionFromRequest(requestWith(before.id))).toBeNull()

    const after = createSession('admin', '127.0.0.1')
    expect(sessionFromRequest(requestWith(after.id))?.user).toBe('admin')
  })

  it('实例重启（重新 configure）后同一密码签发的会话仍然有效', () => {
    configureConsoleAuth(configWith('stable-password'))
    setAdminPassword('stable-password')
    const session = createSession('admin', '10.0.0.1')

    // 模拟另一个实例/重启：同样的密码重新登记
    configureConsoleAuth(configWith('stable-password'))
    const read = sessionFromRequest(requestWith(session.id))
    expect(read?.user).toBe('admin')
    expect(read?.ip).toBe('10.0.0.1')
  })
})
