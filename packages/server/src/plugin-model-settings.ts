/**
 * 插件模型的宿主侧配置。
 *
 * 插件模型 ID 是 `plugin:` 前缀的虚拟 ID，不会写进 `models` 表；但“哪些角色能看到
 * 这个插件模型”必须由管理员可配置并持久化。这里只保存角色，模型本身仍随插件
 * 启停出现/消失，避免把插件模型变成需要手工维护的普通模型。
 */
import type { Db } from '@eab/storage'

/** 新注入的插件模型默认只给普通员工，不再默认全部角色。 */
export const DEFAULT_PLUGIN_MODEL_ROLES = ['member']

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

/** 返回当前公司所有插件模型的角色覆盖；没有覆盖时调用方使用模型默认角色。 */
export function loadPluginModelRoleMap(db: Db, companyId: string): Map<string, string[]> {
  const rows = db
    .prepare('SELECT model_id, roles_json FROM plugin_model_settings WHERE company_id = ?')
    .all(companyId) as unknown as Array<{ model_id: string; roles_json: string }>
  return new Map(rows.map((row) => [row.model_id, readRoles(row.roles_json)]))
}

/** 保存一个插件模型的可见角色；空数组是合法值，表示不对任何角色开放。 */
export function savePluginModelRoles(
  db: Db,
  companyId: string,
  modelId: string,
  roles: readonly string[],
): void {
  const normalized = [...new Set(roles.map(String).filter(Boolean))]
  db.prepare(
    `INSERT INTO plugin_model_settings (company_id, model_id, roles_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (company_id, model_id)
     DO UPDATE SET roles_json = excluded.roles_json, updated_at = excluded.updated_at`,
  ).run(companyId, modelId, JSON.stringify(normalized), Date.now())
}

/** 把持久化角色应用到插件模型定义；调用方负责只在确有覆盖时覆盖默认角色。 */
export function applyPluginModelRoles<T extends { id: string; roles: string[] }>(
  models: readonly T[],
  overrides: ReadonlyMap<string, readonly string[]>,
): T[] {
  return models.map((model) => {
    const roles = overrides.get(model.id)
    return roles ? { ...model, roles: [...roles] } : model
  })
}
