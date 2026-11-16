import { describe, expect, it } from 'vitest'
import {
  hasInteractiveWindowsDesktop,
  isLocalAddress,
  normalizeAddress,
  requestIsLocal,
} from '../src/console-locality.js'

describe('控制台请求来源判断', () => {
  it('识别 IPv4-mapped 回环地址和服务器自身网卡地址', () => {
    expect(normalizeAddress('::ffff:192.168.1.13')).toBe('192.168.1.13')
    expect(isLocalAddress('127.0.0.1', [])).toBe(true)
    expect(isLocalAddress('::1', [])).toBe(true)
    expect(isLocalAddress('192.168.1.13', ['192.168.1.13'])).toBe(true)
    expect(isLocalAddress('192.168.1.14', ['192.168.1.13'])).toBe(false)
  })

  it('远程请求和带非本机代理头的请求都按远程处理', () => {
    const locals = ['127.0.0.1', '192.168.1.13']
    expect(requestIsLocal('192.168.1.13', '', locals)).toBe(true)
    expect(requestIsLocal('192.168.1.14', '', locals)).toBe(false)
    expect(requestIsLocal('127.0.0.1', '', locals)).toBe(true)
    expect(requestIsLocal('127.0.0.1', '192.168.1.14', locals)).toBe(false)
    expect(requestIsLocal('::ffff:192.168.1.13', '', locals)).toBe(true)
  })

  it('只有交互式 Windows 会话才启用原生选择框', () => {
    expect(hasInteractiveWindowsDesktop('win32', 'Console')).toBe(true)
    expect(hasInteractiveWindowsDesktop('win32', 'RDP-Tcp#3')).toBe(true)
    expect(hasInteractiveWindowsDesktop('win32', 'Services')).toBe(false)
    expect(hasInteractiveWindowsDesktop('win32', '')).toBe(false)
    expect(hasInteractiveWindowsDesktop('linux', 'Console')).toBe(false)
  })
})
