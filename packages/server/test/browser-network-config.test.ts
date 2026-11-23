import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  browserNetworkSettingsView,
  normalizeBrowserPrivateHosts,
  saveBrowserNetworkSettings,
} from '../src/browser-network-config.js'

const dirs: string[] = []
const previousHomes: Array<string | undefined> = []

function useTempHome(): void {
  const dir = mkdtempSync(join(tmpdir(), 'eab-browser-network-'))
  dirs.push(dir)
  previousHomes.push(process.env.EAB_HOME)
  process.env.EAB_HOME = dir
}

afterEach(() => {
  const home = previousHomes.pop()
  if (home === undefined) delete process.env.EAB_HOME
  else process.env.EAB_HOME = home
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('内置浏览器内网访问配置', () => {
  it('默认关闭，空名单不会因为开关而放行', () => {
    useTempHome()
    expect(browserNetworkSettingsView()).toMatchObject({
      allowPrivateNetwork: false,
      allowedHosts: [],
      enabled: false,
    })
  })

  it('保存域名/IP 后生效，并去重、忽略空行', () => {
    useTempHome()
    const saved = saveBrowserNetworkSettings({
      allowPrivateNetwork: true,
      allowedHosts: 'oa.example.com\n10.20.30.40\noa.example.com\n\n',
    })
    expect(saved).toMatchObject({
      allowPrivateNetwork: true,
      allowedHosts: ['oa.example.com', '10.20.30.40'],
      enabled: true,
    })
  })

  it('开启开关但名单为空时拒绝保存', () => {
    useTempHome()
    expect(() =>
      saveBrowserNetworkSettings({ allowPrivateNetwork: true, allowedHosts: '' }),
    ).toThrow()
  })

  it('拒绝带协议、路径或账号的条目', () => {
    expect(() => normalizeBrowserPrivateHosts(['https://oa.example.com/path'])).toThrow()
    expect(() => normalizeBrowserPrivateHosts(['user:pass@oa.example.com'])).toThrow()
  })
})
