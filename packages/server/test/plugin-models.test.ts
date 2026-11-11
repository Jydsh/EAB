import { describe, expect, it } from 'vitest'
import {
  callPluginModel,
  findPluginModel,
  listPluginChannels,
  listPluginModels,
  refreshPluginChannel,
  registerPluginAdapter,
  registerPluginConfigurableProviders,
  registerPluginModelDiscovery,
  setPluginModelActiveResolver,
} from '../src/plugin-models.js'

const COMPANY = 'c_plugin_models_test'

function makeAdapter() {
  return {
    listModels: async (provider: string) => [
      { provider, id: 'demo/model', name: '演示模型', description: '插件模型', inputModalities: ['text', 'image'] },
    ],
    prepareCall: async (provider: string, model: string) => ({
      model: { provider, id: model, name: '演示模型' },
      stream: () => stream(),
    }),
    stream: () => stream(),
  }
}

async function* stream() {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: '你好' }
  yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: '你好' } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

describe('插件 LLM adapter 注册表', () => {
  it('把 adapter 的模型投影成 plugin: 前缀模型并可调用', async () => {
    const adapter = makeAdapter()
    const registration = registerPluginAdapter(COMPANY, 'dsh-demo', ['demo-route'], adapter)
    await new Promise((resolve) => setTimeout(resolve, 0))

    const models = listPluginModels(COMPANY)
    expect(models.map((model) => model.id)).toEqual(['plugin:demo-route:demo%2Fmodel'])
    expect(models[0]?.capabilities).toContain('vision')
    expect(models[0]?.source).toBe('plugin')
    expect(models[0]?.pluginId).toBe('dsh-demo')
    // 插件模型默认只给普通员工，不再默认全部角色。
    expect(models[0]?.roles).toEqual(['member'])

    const events: string[] = []
    const result = await callPluginModel(
      COMPANY,
      'plugin:demo-route:demo%2Fmodel',
      [{ role: 'user', content: '嗨' }],
      { onEvent: (event) => events.push(`${event.type}:${event.text}`) },
    )
    expect(result?.text).toBe('你好')
    expect(result?.promptTokens).toBe(3)
    expect(result?.completionTokens).toBe(2)
    expect(events).toEqual(['content:你好'])

    registration.dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(findPluginModel(COMPANY, 'plugin:demo-route:demo%2Fmodel')).toBeNull()
  })

  it('把 adapter 路由投影成控制台插件通道，并支持刷新模型', async () => {
    const company = 'c_plugin_channels_test'
    const adapter = makeAdapter()
    const registration = registerPluginAdapter(company, 'dsh-demo', ['demo-route'], adapter)
    registerPluginConfigurableProviders(company, 'dsh-demo', [
      { provider: 'demo-route', displayName: '演示通道', settingsNs: 'dsh-demo', settingsPath: [] },
    ])
    let discovered = 0
    registerPluginModelDiscovery(company, 'dsh-demo', 'dsh-demo', async () => {
      discovered += 1
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const channels = listPluginChannels(company)
    expect(channels).toHaveLength(1)
    expect(channels[0]).toMatchObject({
      id: 'plugin:dsh-demo:demo-route',
      pluginId: 'dsh-demo',
      route: 'demo-route',
      name: '演示通道',
      models: 1,
      configurable: true,
      discovery: true,
    })

    const count = await refreshPluginChannel(company, 'plugin:dsh-demo:demo-route')
    expect(discovered).toBe(1)
    expect(count).toBe(1)

    registration.dispose()
  })

  it('插件先声明可配置 provider / 探测，再注册 adapter 也能形成通道', async () => {
    const company = 'c_plugin_order_test'
    registerPluginConfigurableProviders(company, 'dsh-order', [
      { provider: 'demo-route', displayName: '先声明的通道', settingsNs: 'dsh-order', settingsPath: [] },
    ])
    registerPluginModelDiscovery(company, 'dsh-order', 'dsh-order', async () => undefined)
    const registration = registerPluginAdapter(company, 'dsh-order', ['demo-route'], makeAdapter())
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(listPluginChannels(company)[0]).toMatchObject({
      id: 'plugin:dsh-order:demo-route',
      name: '先声明的通道',
      models: 1,
      configurable: true,
      discovery: true,
    })
    registration.dispose()
  })

  it('插件停用后查询层立即隐藏模型和通道，不依赖异步 dispose', async () => {
    const company = 'c_plugin_disabled_test'
    let active = true
    setPluginModelActiveResolver((_companyId, _pluginId) => active)
    const registration = registerPluginAdapter(company, 'dsh-disabled', ['demo-route'], makeAdapter())
    try {
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(listPluginModels(company)).toHaveLength(1)
      expect(listPluginChannels(company)).toHaveLength(1)

      active = false
      expect(listPluginModels(company)).toEqual([])
      expect(listPluginChannels(company)).toEqual([])
    } finally {
      registration.dispose()
      setPluginModelActiveResolver(null)
    }
  })
})
