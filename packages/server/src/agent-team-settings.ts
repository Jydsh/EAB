/**
 * Agent 团队运行策略的生效值。
 *
 * 优先级固定为「控制台显式值 > 环境变量 > 默认值」：
 * - 控制台值存在时，不再受 EAB_AGENT_MAX_WORKERS 影响；
 * - 控制台值被清空（null）时，才回落到环境变量或默认 8；
 * - 每一回合、每次团队状态查询都重新读设置文件，所以保存后不需要重启。
 */
import type { ServerConfig } from './config.js'
import { readConsoleSettings } from './settings.js'

export const AGENT_TEAM_MAX_WORKERS_MIN = 1
export const AGENT_TEAM_MAX_WORKERS_MAX = 32
export const DEFAULT_AGENT_MAX_WORKERS = 8

export type AgentTeamSettingSource = 'console' | 'env' | 'default'

export interface EffectiveAgentTeamSettings {
  readonly maxWorkers: number
  readonly source: AgentTeamSettingSource
}

export interface AgentTeamSettingsView extends EffectiveAgentTeamSettings {
  /** 控制台显式值；null 表示没有覆盖 */
  readonly configured: number | null
  readonly defaultValue: number
  readonly envValue: number
  readonly envPresent: boolean
  readonly range: { readonly min: number; readonly max: number }
}

/** 保存接口和设置文件读取共用的范围校验；非法值返回 null。 */
export function normalizeAgentMaxWorkers(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(parsed)) return null
  if (parsed < AGENT_TEAM_MAX_WORKERS_MIN || parsed > AGENT_TEAM_MAX_WORKERS_MAX) return null
  return parsed
}

export function resolveAgentTeamSettings(
  config: ServerConfig,
  storedMaxWorkers: unknown,
): EffectiveAgentTeamSettings {
  const configured = normalizeAgentMaxWorkers(storedMaxWorkers)
  if (configured !== null) return { maxWorkers: configured, source: 'console' }

  const envValue = normalizeAgentMaxWorkers(config.agentMaxWorkers)
  if (envValue !== null) {
    return {
      maxWorkers: envValue,
      source: config.agentMaxWorkersFromEnv ? 'env' : 'default',
    }
  }
  return { maxWorkers: DEFAULT_AGENT_MAX_WORKERS, source: 'default' }
}

export function effectiveAgentTeamSettings(config: ServerConfig): EffectiveAgentTeamSettings {
  return resolveAgentTeamSettings(config, readConsoleSettings().agentTeam.maxWorkers)
}

export function agentTeamSettingsView(config: ServerConfig): AgentTeamSettingsView {
  const settings = readConsoleSettings()
  const effective = resolveAgentTeamSettings(config, settings.agentTeam.maxWorkers)
  const envValue = normalizeAgentMaxWorkers(config.agentMaxWorkers) ?? DEFAULT_AGENT_MAX_WORKERS
  return {
    ...effective,
    configured: settings.agentTeam.maxWorkers,
    defaultValue: DEFAULT_AGENT_MAX_WORKERS,
    envValue,
    envPresent: Boolean(config.agentMaxWorkersFromEnv),
    range: { min: AGENT_TEAM_MAX_WORKERS_MIN, max: AGENT_TEAM_MAX_WORKERS_MAX },
  }
}
