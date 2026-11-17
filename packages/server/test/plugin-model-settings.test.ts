import { describe, expect, it } from 'vitest'
import { migrate, openDatabase } from '@eab/storage'
import {
  DEFAULT_PLUGIN_MODEL_ROLES,
  applyPluginModelSettings,
  loadPluginModelSettingsMap,
  savePluginModelSettings,
} from '../src/plugin-model-settings.js'

describe('插件模型配置', () => {
  it('默认 member；保存后按公司持久化可见角色', () => {
    const db = openDatabase({ path: ':memory:' })
    migrate(db)
    const company = 'c_plugin_settings_test'
    const models = [
      { id: 'plugin:demo:one', roles: [...DEFAULT_PLUGIN_MODEL_ROLES] },
      { id: 'plugin:demo:two', roles: [...DEFAULT_PLUGIN_MODEL_ROLES] },
    ]

    expect(loadPluginModelSettingsMap(db, company).size).toBe(0)
    expect(applyPluginModelSettings(models, new Map())).toEqual(models)

    savePluginModelSettings(db, company, 'plugin:demo:one', {
      roles: ['member', 'company_admin'],
    })
    const applied = applyPluginModelSettings(
      models,
      loadPluginModelSettingsMap(db, company),
    )
    expect(applied[0]?.roles).toEqual(['member', 'company_admin'])
    expect(applied[1]).toEqual(models[1])

    // 空数组是合法角色配置：管理员明确表示任何角色都不可见。
    savePluginModelSettings(db, company, 'plugin:demo:one', { roles: [] })
    expect(
      applyPluginModelSettings(models, loadPluginModelSettingsMap(db, company))[0]?.roles,
    ).toEqual([])
  })
})
