import type { ServerConfig } from './config.js'
import { readConsoleSettings } from './settings.js'

/** 当前实际生效的网络项：环境变量锁定的项以进程配置为准，其余以设置文件为准。 */
export interface EffectiveNetwork {
  host: string
  chatPort: number
  adminPort: number
  allowRemoteConsole: boolean
}

/** 控制台保存网络设置时传给运行时的目标值；字段名与设置文件一致。 */
export type NetworkTarget = EffectiveNetwork

/** 运行时重建监听的结果；失败时由运行时把设置文件回滚到旧值。 */
export interface NetworkApplyResult {
  rebound: boolean
  error?: string
}

export function effectiveNetwork(config: ServerConfig): EffectiveNetwork {
  const locked = config.networkEnvLocked ?? {
    host: false,
    chatPort: false,
    adminPort: false,
    allowRemoteConsole: false,
  }
  const stored = readConsoleSettings()
  return {
    host: locked.host ? config.host : stored.host ?? config.host,
    chatPort: locked.chatPort ? config.port : stored.chatPort ?? config.port,
    adminPort: locked.adminPort ? config.adminPort : stored.adminPort ?? config.adminPort,
    allowRemoteConsole: locked.allowRemoteConsole ? config.allowRemoteConsole : stored.allowRemoteConsole,
  }
}

/** 监听重建成功后把进程内配置对齐到新值，后续请求不用再重启才能读到。 */
export function applyNetworkToConfig(config: ServerConfig, next: NetworkTarget): void {
  const mutable = config as unknown as {
    host: string
    port: number
    adminPort: number
    allowRemoteConsole: boolean
  }
  mutable.host = next.host
  mutable.port = next.chatPort
  mutable.adminPort = next.adminPort
  mutable.allowRemoteConsole = next.allowRemoteConsole
}
