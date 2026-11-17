/**
 * 插件模型的宿主侧配置。
 *
 * 插件模型 ID 是 `plugin:` 前缀的虚拟 ID，不会写进 `models` 表。按 DSH 的设计，
 * 上下文窗口、默认输出上限和思考档位都由插件在 `resolveModel()` 里自描述，宿主不再
 * 保存逐模型覆盖；控制台只保留“哪些角色能看到这个模型”这一项宿主职责。
 *
 * 0064/0065 迁移留下的 max_context、max_output_tokens、context_compression 列
 * 不再读写：插件模型参数只有插件声明一个来源，避免同一个值有两套真相。
 */
import type { Db } from '@eab/storage'

/** 新注入的插件模型默认只给普通员工，不再默认全部角色。 */
export const DEFAULT_PLUGIN_MODEL_ROLES = ['member']

export interface PluginModelSettings {
  readonly roles: string[]
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

/** 返回当前公司所有插件模型的角色配置；没有配置时调用方使用默认角色。 */
export function loadPluginModelSettingsMap(
  db: Db,
  companyId: string,
): Map<string, PluginModelSettings> {
  const rows = db
    .prepare(
      `SELECT model_id, roles_json
         FROM plugin_model_settings
        WHERE company_id = ?`,
    )
    .all(companyId) as unknown as Array<{
      model_id: string
      roles_json: string | null
    }>
  return new Map(
    rows.map((row) => [
      row.model_id,
      { roles: readRoles(row.roles_json) },
    ]),
  )
}

/** 保存一个插件模型的可见角色；空数组表示不对任何角色开放。 */
export function savePluginModelSettings(
  db: Db,
  companyId: string,
  modelId: string,
  settings: PluginModelSettings,
): void {
  const roles = [...new Set(settings.roles.map(String).filter(Boolean))]
  db.prepare(
    `INSERT INTO plugin_model_settings
       (company_id, model_id, roles_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (company_id, model_id)
     DO UPDATE SET roles_json = excluded.roles_json,
                   updated_at = excluded.updated_at`,
  ).run(companyId, modelId, JSON.stringify(roles), Date.now())
}

/** 把持久化的角色配置应用到插件模型定义；没有配置的模型保持默认角色。 */
export function applyPluginModelSettings<
  T extends { id: string; roles: readonly string[] },
>(models: readonly T[], overrides: ReadonlyMap<string, PluginModelSettings>): T[] {
  return models.map((model) => {
    const override = overrides.get(model.id)
    return override ? ({ ...model, roles: [...override.roles] } as T) : model
  })
}

/** 兼容旧调用方：只读取角色覆盖。 */
export function loadPluginModelRoleMap(db: Db, companyId: string): Map<string, string[]> {
  const settings = loadPluginModelSettingsMap(db, companyId)
  return new Map([...settings].map(([modelId, value]) => [modelId, value.roles]))
}

/** 兼容旧调用方：只更新角色。 */
export function savePluginModelRoles(
  db: Db,
  companyId: string,
  modelId: string,
  roles: readonly string[],
): void {
  savePluginModelSettings(db, companyId, modelId, {
    roles: roles.map(String).filter(Boolean),
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
