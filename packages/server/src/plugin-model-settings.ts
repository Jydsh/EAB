/**
 * 插件模型的宿主侧配置。
 *
 * 插件模型 ID 是 `plugin:` 前缀的虚拟 ID，不会写进 `models` 表；但“哪些角色能看到
 * 这个插件模型、上下文窗口多大、单次最多输出多少 token、超限时是否压缩较早历史”
 * 必须由管理员可配置并持久化。模型本身仍随插件启停出现/消失，避免把插件模型变成
 * 需要手工维护的普通模型。
 */
import type { Db } from '@eab/storage'

/** 新注入的插件模型默认只给普通员工，不再默认全部角色。 */
export const DEFAULT_PLUGIN_MODEL_ROLES = ['member']

export interface PluginModelSettings {
  readonly roles: string[]
  /** NULL 表示沿用插件声明的 contextWindow；非空时覆盖。 */
  readonly maxContext: number | null
  /** NULL 表示沿用插件声明的 defaultMaxTokens；非空时覆盖。 */
  readonly maxOutputTokens: number | null
  /** NULL 表示沿用插件声明；非空时覆盖是否自动压缩较早历史。 */
  readonly contextCompression: boolean | null
}

function readRoles(raw: string | null | undefined): string[] {
  if (!raw) return [...DEFAULT_PLUGIN_MODEL_ROLES]
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return [...DEFAULT_PLUGIN_MODEL_ROLES]
    return parsed.map(String).filter(Boolean)
  } catch {
    return [...DEFAULT_PLUGIN_MODEL_ROLES]
  }
}

function readLimit(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : null
}

function readCompression(value: unknown): boolean | null {
  if (value === null || value === undefined) return null
  const number = Number(value)
  return Number.isFinite(number) ? number !== 0 : null
}

/** 返回当前公司所有插件模型的配置；没有配置时调用方使用模型默认值。 */
export function loadPluginModelSettingsMap(
  db: Db,
  companyId: string,
): Map<string, PluginModelSettings> {
  const rows = db
    .prepare(
      `SELECT model_id, roles_json, max_context, max_output_tokens, context_compression
         FROM plugin_model_settings
        WHERE company_id = ?`,
    )
    .all(companyId) as unknown as Array<{
      model_id: string
      roles_json: string | null
      max_context: number | string | null
      max_output_tokens: number | string | null
      context_compression: number | string | null
    }>
  return new Map(
    rows.map((row) => [
      row.model_id,
      {
        roles: readRoles(row.roles_json),
        maxContext: readLimit(row.max_context),
        maxOutputTokens: readLimit(row.max_output_tokens),
        contextCompression: readCompression(row.context_compression),
      },
    ]),
  )
}

/**
 * 保存一个插件模型的配置。
 * 空角色数组表示不对任何角色开放；空上限/空压缩表示沿用插件声明。
 */
export function savePluginModelSettings(
  db: Db,
  companyId: string,
  modelId: string,
  settings: PluginModelSettings,
): void {
  const roles = [...new Set(settings.roles.map(String).filter(Boolean))]
  const maxContext = readLimit(settings.maxContext)
  const maxOutputTokens = readLimit(settings.maxOutputTokens)
  const contextCompression = settings.contextCompression === null
    ? null
    : settings.contextCompression
      ? 1
      : 0
  db.prepare(
    `INSERT INTO plugin_model_settings
       (company_id, model_id, roles_json, max_context, max_output_tokens, context_compression, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (company_id, model_id)
     DO UPDATE SET roles_json = excluded.roles_json,
                   max_context = excluded.max_context,
                   max_output_tokens = excluded.max_output_tokens,
                   context_compression = excluded.context_compression,
                   updated_at = excluded.updated_at`,
  ).run(companyId, modelId, JSON.stringify(roles), maxContext, maxOutputTokens, contextCompression, Date.now())
}

/** 把持久化配置应用到插件模型定义；没有配置的模型保持插件声明值。 */
export function applyPluginModelSettings<
  T extends {
    id: string
    roles: readonly string[]
    maxContext?: number | null
    maxOutputTokens?: number | null
    contextCompression?: boolean
  },
>(models: readonly T[], overrides: ReadonlyMap<string, PluginModelSettings>): T[] {
  return models.map((model) => {
    const override = overrides.get(model.id)
    if (!override) return model
    return {
      ...model,
      roles: [...override.roles],
      maxContext: override.maxContext ?? model.maxContext,
      maxOutputTokens: override.maxOutputTokens ?? model.maxOutputTokens,
      contextCompression: override.contextCompression ?? model.contextCompression,
    } as T
  })
}

/** 兼容旧调用方：只读取角色覆盖。 */
export function loadPluginModelRoleMap(db: Db, companyId: string): Map<string, string[]> {
  const settings = loadPluginModelSettingsMap(db, companyId)
  return new Map([...settings].map(([modelId, value]) => [modelId, value.roles]))
}

/** 兼容旧调用方：只更新角色，保留已保存的上下文、输出与压缩配置。 */
export function savePluginModelRoles(
  db: Db,
  companyId: string,
  modelId: string,
  roles: readonly string[],
): void {
  const current = loadPluginModelSettingsMap(db, companyId).get(modelId)
  savePluginModelSettings(db, companyId, modelId, {
    roles: roles.map(String).filter(Boolean),
    maxContext: current?.maxContext ?? null,
    maxOutputTokens: current?.maxOutputTokens ?? null,
    contextCompression: current?.contextCompression ?? null,
  })
}

/** 兼容旧调用方：只应用角色覆盖。 */
export function applyPluginModelRoles<T extends { id: string; roles: readonly string[] }>(
  models: readonly T[],
  overrides: ReadonlyMap<string, readonly string[]>,
): T[] {
  return models.map((model) => {
    const roles = overrides.get(model.id)
    return roles ? ({ ...model, roles: [...roles] } as T) : model
  })
}
