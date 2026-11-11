import { describe, expect, it } from 'vitest'
import { migrate, openDatabase } from '@eab/storage'
import {
  DEFAULT_PLUGIN_MODEL_ROLES,
  applyPluginModelRoles,
  loadPluginModelRoleMap,
  savePluginModelRoles,
} from '../src/plugin-model-settings.js'

describe('插件模型角色配置', () => {
  it('默认 member；保存后按公司持久化并覆盖默认角色', () => {
    const db = openDatabase({ path: ':memory:' })
    migrate(db)
    const company = 'c_plugin_roles_test'
    const models = [
      { id: 'plugin:demo:one', roles: [...DEFAULT_PLUGIN_MODEL_ROLES] },
      { id: 'plugin:demo:two', roles: [...DEFAULT_PLUGIN_MODEL_ROLES] },
    ]

    expect(loadPluginModelRoleMap(db, company).size).toBe(0)
    expect(applyPluginModelRoles(models, new Map())).toEqual(models)

    savePluginModelRoles(db, company, 'plugin:demo:one', ['member', 'company_admin'])
    const overrides = loadPluginModelRoleMap(db, company)
    const applied = applyPluginModelRoles(models, overrides)
    expect(applied[0]?.roles).toEqual(['member', 'company_admin'])
    expect(applied[1]?.roles).toEqual(['member'])

    // 空数组是合法配置：管理员明确表示任何角色都不可见。
    savePluginModelRoles(db, company, 'plugin:demo:one', [])
    expect(applyPluginModelRoles(models, loadPluginModelRoleMap(db, company))[0]?.roles).toEqual([])
  })
})
