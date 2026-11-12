/**
 * 插件实例身份。
 *
 * EAB 里“同名插件”不是一份共享 host：公司安装一个实例，每个成员个人安装各自
 * 一个实例。实例 = (companyId, pluginId, scope)。host、数据目录、工具、模型和
 * 页面网关都必须按这个键隔离；物理包目录仍然只读共享。
 */
import type { Db } from '@eab/storage'
import { join } from 'node:path'
import type { DshImOptions } from './dsh-im-compat.js'

export type PluginScope =
  | { readonly kind: 'company' }
  | { readonly kind: 'user'; readonly userId: string }

export interface PluginInstanceRef {
  readonly companyId: string
  readonly pluginId: string
  readonly scope: PluginScope
}

export function companyScope(): PluginScope {
  return { kind: 'company' }
}

export function userScope(userId: string): PluginScope {
  return { kind: 'user', userId: String(userId) }
}

/** 实例内的 scope 短键：company 或 user:<userId>。 */
export function pluginScopeKey(scope: PluginScope): string {
  return scope.kind === 'company' ? 'company' : `user:${encodeURIComponent(scope.userId)}`
}

/** 全局唯一的实例键；host 的 instances Map、工具和模型注册表都用它。 */
export function pluginInstanceKey(
  companyId: string,
  pluginId: string,
  scope: PluginScope,
): string {
  return `${encodeURIComponent(companyId)}:${encodeURIComponent(pluginId)}:${pluginScopeKey(scope)}`
}

/** 公司级实例的快捷键。 */
export function companyInstanceKey(companyId: string, pluginId: string): string {
  return pluginInstanceKey(companyId, pluginId, companyScope())
}

/** 用户级实例的快捷键。 */
export function userInstanceKey(companyId: string, pluginId: string, userId: string): string {
  return pluginInstanceKey(companyId, pluginId, userScope(userId))
}

function safeSegment(value: string): string {
  return encodeURIComponent(String(value || 'unknown')).replace(/%/g, '_')
}

/**
 * 每个实例自己的 DSH_HOME。
 *
 * 布局：
 * - 公司实例：<base>（保持 dsh-im 兼容根和历史公司数据不变）
 * - 个人实例：<base>/scopes/users/<companyId>/<userId>
 *
 * 物理插件包仍共享 `plugins/<pluginId>`；这里只放实例配置、密钥和运行缓存。
 */
export function pluginDataRoot(
  options: Pick<DshImOptions, 'dbPath' | 'dataDir' | 'dshHomeDir'>,
  companyId: string,
  scope: PluginScope,
): string {
  const base = options.dshHomeDir?.trim()
    || join(options.dataDir || join(options.dbPath, '..'), 'dsh-home')
  if (scope.kind === 'company') return base
  return join(base, 'scopes', 'users', safeSegment(companyId), safeSegment(scope.userId))
}

/** 插件设置（公司 settings_json）里的命名空间；公司实例沿用插件 id 保持兼容。 */
export function pluginSettingsNamespace(pluginId: string, scope: PluginScope): string {
  return scope.kind === 'company' ? pluginId : `${pluginId}__user__${safeSegment(scope.userId)}`
}

export interface EnabledPluginInstance {
  readonly companyId: string
  readonly pluginId: string
  readonly scope: PluginScope
}

function tableExists(db: Db, table: string): boolean {
  try {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
      | { name?: string }
      | undefined
    return row?.name === table
  } catch {
    return false
  }
}

/**
 * 全部真正启用的插件实例：公司安装未被公司状态停用 + 各成员个人安装且启用。
 * host 重扫、工具发现和个人工作台都从这里取同一份口径。
 */
export function listEnabledPluginInstances(db: Db): EnabledPluginInstance[] {
  const rows: EnabledPluginInstance[] = []
  if (tableExists(db, 'plugin_company_installs')) {
    try {
      const companyRows = db
        .prepare(
          `SELECT pci.company_id AS company_id, pci.plugin_id AS plugin_id
             FROM plugin_company_installs pci
            WHERE pci.removed_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM plugin_states ps
                 WHERE ps.company_id = pci.company_id
                   AND ps.plugin_id = pci.plugin_id
                   AND ps.enabled = 0
              )`,
        )
        .all() as unknown as Array<{ company_id: string; plugin_id: string }>
      for (const row of companyRows) {
        if (!row.company_id || !row.plugin_id) continue
        rows.push({ companyId: row.company_id, pluginId: row.plugin_id, scope: companyScope() })
      }
    } catch {
      // 老库没有 installs 表时按空处理
    }
  }
  if (tableExists(db, 'plugin_user_installs')) {
    try {
      const userRows = db
        .prepare(
          `SELECT company_id, user_id, plugin_id
             FROM plugin_user_installs
            WHERE removed_at IS NULL AND enabled = 1`,
        )
        .all() as unknown as Array<{ company_id: string; user_id: string; plugin_id: string }>
      for (const row of userRows) {
        if (!row.company_id || !row.user_id || !row.plugin_id) continue
        rows.push({
          companyId: row.company_id,
          pluginId: row.plugin_id,
          scope: userScope(row.user_id),
        })
      }
    } catch {
      // 同上
    }
  }
  const seen = new Set<string>()
  return rows.filter((row) => {
    const key = pluginInstanceKey(row.companyId, row.pluginId, row.scope)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** 当前操作者实际可用的实例：公司实例 + 本人个人实例。 */export function listActorPluginInstances(
  db: Db,
  companyId: string,
  userId: string,
): EnabledPluginInstance[] {
  return listEnabledPluginInstances(db).filter(
    (row) =>
      row.companyId === companyId
      && (row.scope.kind === 'company' || (row.scope.kind === 'user' && row.scope.userId === userId)),
  )
}

/** 同一公司里是否仍有任何启用实例（模型/工具兜底过滤用）。 */
export function pluginHasEnabledInstance(db: Db, companyId: string, pluginId: string): boolean {
  return listEnabledPluginInstances(db).some(
    (row) => row.companyId === companyId && row.pluginId === pluginId,
  )
}
