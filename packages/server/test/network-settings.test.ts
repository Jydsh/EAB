import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ServerConfig } from '../src/config.js'
import { applyNetworkToConfig, effectiveNetwork } from '../src/network-settings.js'
import { writeConsoleSettings } from '../src/settings.js'

let home = ''
let previousHome: string | undefined

function baseConfig(): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 8787,
    adminPort: 8788,
    allowRemoteConsole: false,
    networkEnvLocked: {
      host: false,
      chatPort: false,
      adminPort: false,
      allowRemoteConsole: false,
    },
  } as unknown as ServerConfig
}

beforeEach(() => {
  previousHome = process.env.EAB_HOME
  home = mkdtempSync(join(tmpdir(), 'eab-network-settings-'))
  process.env.EAB_HOME = home
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.EAB_HOME
  else process.env.EAB_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

describe('网络设置热生效', () => {
  it('设置文件里的网络项优先于启动时配置，且只有访问开关能独立热切换', () => {
    writeConsoleSettings({
      host: '0.0.0.0',
      chatPort: 9000,
      adminPort: 9001,
      allowRemoteConsole: true,
    })
    expect(effectiveNetwork(baseConfig())).toEqual({
      host: '0.0.0.0',
      chatPort: 9000,
      adminPort: 9001,
      allowRemoteConsole: true,
    })

    writeConsoleSettings({ allowRemoteConsole: false })
    expect(effectiveNetwork(baseConfig()).allowRemoteConsole).toBe(false)
  })

  it('环境变量锁定的项仍以进程配置为准，设置文件不能覆盖', () => {
    const config = {
      ...baseConfig(),
      networkEnvLocked: {
        host: true,
        chatPort: true,
        adminPort: true,
        allowRemoteConsole: true,
      },
    } as ServerConfig
    writeConsoleSettings({ host: '0.0.0.0', chatPort: 9000, adminPort: 9001, allowRemoteConsole: true })
    expect(effectiveNetwork(config)).toEqual({
      host: '127.0.0.1',
      chatPort: 8787,
      adminPort: 8788,
      allowRemoteConsole: false,
    })
  })

  it('监听重建成功后把进程内配置更新到新值', () => {
    const config = baseConfig()
    applyNetworkToConfig(config, {
      host: '0.0.0.0',
      chatPort: 9100,
      adminPort: 9101,
      allowRemoteConsole: true,
    })
    const mutable = config as unknown as {
      host: string
      port: number
      adminPort: number
      allowRemoteConsole: boolean
    }
    expect(mutable).toMatchObject({
      host: '0.0.0.0',
      port: 9100,
      adminPort: 9101,
      allowRemoteConsole: true,
    })
  })
})
