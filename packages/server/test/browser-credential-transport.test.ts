import { describe, expect, it } from 'vitest'
import {
  allowCredentialTransport,
  isLoopbackAddress,
  trustedCredentialProxyHosts,
} from '../src/browser-credential-transport.js'

const local = { peerAddress: '127.0.0.1', headers: {} }
const remote = { peerAddress: '192.168.10.24', headers: {} }

describe('browser credential transport boundary', () => {
  it('允许本机回环直连 HTTP', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(allowCredentialTransport(local)).toBe(true)
  })

  it('拒绝远程 HTTP 明文保存密码', () => {
    expect(allowCredentialTransport(remote)).toBe(false)
    expect(allowCredentialTransport({ peerAddress: '::ffff:192.168.10.24', headers: {} })).toBe(false)
  })

  it('允许远程直连 TLS', () => {
    expect(allowCredentialTransport({ ...remote, encrypted: true })).toBe(true)
  })

  it('同机反代必须声明 HTTPS', () => {
    expect(
      allowCredentialTransport({
        ...local,
        headers: { 'x-forwarded-for': '192.168.10.24', 'x-forwarded-proto': 'http' },
      }),
    ).toBe(false)
    expect(
      allowCredentialTransport({
        ...local,
        headers: { 'x-forwarded-for': '192.168.10.24', 'x-forwarded-proto': 'https' },
      }),
    ).toBe(true)
  })

  it('跨机反代只信任显式白名单且要求 HTTPS', () => {
    expect(
      allowCredentialTransport({
        ...remote,
        headers: { 'x-forwarded-proto': 'https' },
      }),
    ).toBe(false)
    expect(
      allowCredentialTransport({
        ...remote,
        headers: { 'x-forwarded-proto': 'https' },
        trustedProxyHosts: ['192.168.10.24'],
      }),
    ).toBe(true)
    expect(
      allowCredentialTransport({
        ...remote,
        headers: { 'x-forwarded-proto': 'http' },
        trustedProxyHosts: ['192.168.10.24'],
      }),
    ).toBe(false)
  })

  it('只接受逗号分隔的真实代理白名单', () => {
    expect(trustedCredentialProxyHosts({ EAB_CREDENTIAL_PROXY_HOSTS: '10.0.0.2, 10.0.0.3' } as NodeJS.ProcessEnv)).toEqual([
      '10.0.0.2',
      '10.0.0.3',
    ])
    expect(trustedCredentialProxyHosts({} as NodeJS.ProcessEnv)).toEqual([])
  })
})
