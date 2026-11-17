import { describe, expect, it } from 'vitest'
import { migrate, openDatabase } from '@eab/storage'
import {
  DEFAULT_PLUGIN_MODEL_ROLES,
  applyPluginModelSettings,
  loadPluginModelSettingsMap,
  savePluginModelSettings,
} from '../src/plugin-model-settings.js'

describe('插件模型配置', () => {
  it('默认 member；保存后按公司持久化角色、上下文、输出与自动压缩', () => {
    const db = openDatabase({ path: ':memory:' })
    migrate(db)
    const company = 'c_plugin_settings_test'
    const models = [
      {
        id: 'plugin:demo:one',
        roles: [...DEFAULT_PLUGIN_MODEL_ROLES],
        maxContext: 128_000,
        maxOutputTokens: 8_192,
        contextCompression: false,
      },
      {
        id: 'plugin:demo:two',
        roles: [...DEFAULT_PLUGIN_MODEL_ROLES],
        maxContext: 32_000,
        maxOutputTokens: 4_096,
        contextCompression: true,
      },
    ]

    expect(loadPluginModelSettingsMap(db, company).size).toBe(0)
    expect(applyPluginModelSettings(models, new Map())).toEqual(models)

    savePluginModelSettings(db, company, 'plugin:demo:one', {
      roles: ['member', 'company_admin'],
      maxContext: 200_000,
      maxOutputTokens: 16_384,
      contextCompression: true,
    })
    const settings = loadPluginModelSettingsMap(db, company)
    const applied = applyPluginModelSettings(models, settings)
    expect(applied[0]?.roles).toEqual(['member', 'company_admin'])
    expect(applied[0]?.maxContext).toBe(200_000)
    expect(applied[0]?.maxOutputTokens).toBe(16_384)
    expect(applied[0]?.contextCompression).toBe(true)
    expect(applied[1]).toEqual(models[1])

    // 显式关闭也必须持久化，不能因为 false 被当成“没有配置”。
    savePluginModelSettings(db, company, 'plugin:demo:one', {
      roles: ['member', 'company_admin'],
      maxContext: 200_000,
      maxOutputTokens: 16_384,
      contextCompression: false,
    })
    expect(applyPluginModelSettings(models, loadPluginModelSettingsMap(db, company))[0]?.contextCompression).toBe(false)

    // 空数组是合法角色配置：管理员明确表示任何角色都不可见。
    savePluginModelSettings(db, company, 'plugin:demo:one', {
      roles: [],
      maxContext: null,
      maxOutputTokens: null,
      contextCompression: null,
    })
    const cleared = applyPluginModelSettings(models, loadPluginModelSettingsMap(db, company))
    expect(cleared[0]?.roles).toEqual([])
    // 清空上限表示回到插件声明值，而不是把模型改成没有上下文。
    expect(cleared[0]?.maxContext).toBe(128_000)
    expect(cleared[0]?.maxOutputTokens).toBe(8_192)
    expect(cleared[0]?.contextCompression).toBe(false)
  })
})
