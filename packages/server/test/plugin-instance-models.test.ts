import { describe, expect, it } from 'vitest'
import {
  listAllPluginModels,
  listPluginModels,
  registerPluginAdapter,
  removePluginModelsForPlugin,
} from '../src/plugin-models.js'
import { userScope } from '../src/plugin-scope.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForModels(companyId: string, count: number): Promise<void> {
  const end = Date.now() + 5_000
  while (Date.now() < end) {
    if (listAllPluginModels(companyId).length >= count) return
    await sleep(20)
  }
  throw new Error(`等待插件模型目录超时：期望 ${count} 条`)
}

describe('插件模型按实例隔离', () => {
  it('公司和成员各自注册同名模型时 ID 不冲突，且个人模型只对本人可见', async () => {
    const companyId = `c_plugin_model_${Date.now()}`
    const pluginId = 'same-plugin'
    const makeAdapter = () => ({
      listModels: () => [{ id: 'same-model', name: '同名模型', providerName: '同名插件' }],
    })
    const companyAdapter = makeAdapter()
    const userAAdapter = makeAdapter()
    const userBAdapter = makeAdapter()

    const companyRegistration = registerPluginAdapter(companyId, pluginId, ['route'], companyAdapter)
    const userARegistration = registerPluginAdapter(
      companyId,
      pluginId,
      ['route'],
      userAAdapter,
      userScope('user-a'),
    )
    const userBRegistration = registerPluginAdapter(
      companyId,
      pluginId,
      ['route'],
      userBAdapter,
      userScope('user-b'),
    )

    await waitForModels(companyId, 3)

    const companyOnly = listPluginModels(companyId)
    const userA = listPluginModels(companyId, 'user-a')
    const userB = listPluginModels(companyId, 'user-b')
    expect(companyOnly).toHaveLength(1)
    expect(userA.map((model) => model.id)).toHaveLength(2)
    expect(userB.map((model) => model.id)).toHaveLength(2)
    expect(new Set([companyOnly[0].id, userA[1].id, userB[1].id]).size).toBe(3)
    expect(userA.some((model) => model.userId === 'user-b')).toBe(false)

    companyRegistration.dispose()
    userARegistration.dispose()
    userBRegistration.dispose()
    removePluginModelsForPlugin(companyId, pluginId)
  })

  it('卸载一个个人实例只摘掉该成员的模型，公司实例和其他成员不受影响', async () => {
    const companyId = `c_plugin_model_remove_${Date.now()}`
    const pluginId = 'same-plugin'
    const makeAdapter = () => ({
      listModels: () => [{ id: 'same-model', name: '同名模型' }],
    })
    const companyAdapter = makeAdapter()
    const userAAdapter = makeAdapter()
    const userBAdapter = makeAdapter()

    const companyRegistration = registerPluginAdapter(companyId, pluginId, ['route'], companyAdapter)
    const userARegistration = registerPluginAdapter(
      companyId,
      pluginId,
      ['route'],
      userAAdapter,
      userScope('user-a'),
    )
    const userBRegistration = registerPluginAdapter(
      companyId,
      pluginId,
      ['route'],
      userBAdapter,
      userScope('user-b'),
    )
    await waitForModels(companyId, 3)

    removePluginModelsForPlugin(companyId, pluginId, userScope('user-a'))
    expect(listPluginModels(companyId)).toHaveLength(1)
    expect(listPluginModels(companyId, 'user-a')).toHaveLength(1)
    expect(listPluginModels(companyId, 'user-b')).toHaveLength(2)

    companyRegistration.dispose()
    userBRegistration.dispose()
    userARegistration.dispose()
    removePluginModelsForPlugin(companyId, pluginId)
  })
})
