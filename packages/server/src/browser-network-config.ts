/**
 * 内置浏览器内网访问策略。
 *
 * 默认关闭；管理员显式打开并填写域名/IP 白名单后，只放行名单内的私网目标。
 * 公共域名仍然按公网规则访问，web.fetch 不跟随这份白名单。
 */
import { EC, EabError } from '@eab/domain'
import {
  readConsoleSettings,
  writeConsoleSettings,
  type BrowserNetworkSettings,
} from './settings.js'

const HOST_MAX = 253
const HOST_LIMIT = 200

export interface BrowserNetworkSettingsView extends BrowserNetworkSettings {
  /** 实际生效状态：开关 + 非空名单 */
  enabled: boolean
  /** 是否因为开关打开但没有域名而未生效 */
  missingHosts: boolean
}

export function browserNetworkSettingsView(): BrowserNetworkSettingsView {
  const settings = readConsoleSettings().browserNetwork
  return {
    ...settings,
    enabled: settings.allowPrivateNetwork && settings.allowedHosts.length > 0,
    missingHosts: settings.allowPrivateNetwork && settings.allowedHosts.length === 0,
  }
}

export function normalizeBrowserPrivateHosts(raw: unknown): string[] {
  if (raw === undefined || raw === null) return []
  const values =
    typeof raw === 'string'
      ? raw.split(/[\n,，;；]+/)
      : Array.isArray(raw)
        ? raw
        : [raw]
  const hosts: string[] = []
  for (const item of values) {
    if (typeof item !== 'string') {
      throw new EabError(EC.VALIDATION, '内网域名必须是文本')
    }
    const host = item.trim().toLowerCase()
    if (!host) continue
    if (host.length > HOST_MAX) {
      throw new EabError(EC.VALIDATION, `内网域名过长：${host.slice(0, 32)}…`)
    }
    if (/[\/@?#\s]/.test(host)) {
      throw new EabError(EC.VALIDATION, `内网域名不合法：${host}`, {
        hint: '只填域名或 IP，不要带 http://、路径或账号',
      })
    }
    if (!hosts.includes(host)) hosts.push(host)
  }
  if (hosts.length > HOST_LIMIT) {
    throw new EabError(EC.VALIDATION, `内网域名最多 ${HOST_LIMIT} 个`)
  }
  return hosts
}

export function saveBrowserNetworkSettings(input: {
  allowPrivateNetwork?: unknown
  allowedHosts?: unknown
}): BrowserNetworkSettingsView {
  const allowPrivateNetwork = input.allowPrivateNetwork === true
  const allowedHosts = normalizeBrowserPrivateHosts(input.allowedHosts)
  if (allowPrivateNetwork && allowedHosts.length === 0) {
    throw new EabError(EC.VALIDATION, '开启内网访问前，至少填写一个域名或 IP', {
      hint: '默认关闭；只有名单内的目标会被放行',
    })
  }
  writeConsoleSettings({
    browserNetwork: {
      allowPrivateNetwork: allowPrivateNetwork && allowedHosts.length > 0,
      allowedHosts,
    },
  })
  return browserNetworkSettingsView()
}
