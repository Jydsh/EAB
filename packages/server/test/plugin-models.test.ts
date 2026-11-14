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
  setPluginModelsChangedListener,
  syncPluginModels,
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
      {
        onEvent: (event) => {
          if (event.type === 'reasoning' || event.type === 'content') {
            events.push(`${event.type}:${event.text}`)
          }
        },
      },
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

  it('插件声明 reasoning 时投影成思考菜单，并把员工的档位原样传给 adapter', async () => {
    const company = 'c_plugin_reasoning_test'
    const calls: Record<string, unknown>[] = []
    const adapter = {
      listModels: async (provider: string) => [
        { provider, id: 'demo/reasoner', name: '推理模型', inputModalities: ['text'] },
      ],
      resolveModel: async (provider: string, model: string) => ({
        provider,
        id: model,
        name: '推理模型',
        reasoning: {
          efforts: [
            { id: 'low', name: '轻量推理', description: '少想一点' },
            { id: 'high', name: '深度推理', description: '多想一点' },
          ],
          defaultEffort: 'high',
        },
      }),
      prepareCall: async (provider: string, model: string) => ({
        model: { provider, id: model, name: '推理模型' },
        stream: (options: Record<string, unknown>) => {
          calls.push(options)
          return stream()
        },
      }),
      stream: () => stream(),
    }
    const registration = registerPluginAdapter(company, 'dsh-reasoning', ['demo-route'], adapter)
    try {
      await new Promise((resolve) => setTimeout(resolve, 0))
      const model = listPluginModels(company)[0]
      expect(model?.thinking?.enabled).toBe(true)
      expect(model?.thinking?.source).toBe('plugin')
      expect(model?.thinking?.defaultEffort).toBe('high')
      expect(model?.thinking?.options.map((option) => option.id)).toEqual(['low', 'high'])
      expect(model?.thinking?.options.map((option) => option.label)).toEqual(['轻量推理', '深度推理'])
      expect(model?.thinking?.options[0]?.hint).toBe('少想一点')

      await callPluginModel(company, model!.id, [{ role: 'user', content: '嗨' }], {
        reasoningEffort: 'low',
      })
      expect(calls[0]?.reasoningEffort).toBe('low')
    } finally {
      registration.dispose()
    }
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

  it('插件目录移除模型后，周期同步会把模型从 EAB 目录删掉', async () => {
    const company = 'c_plugin_catalog_remove_test'
    let rows = [
      { provider: 'demo-route', id: 'demo/model', name: '演示模型' },
      { provider: 'demo-route', id: 'demo/other', name: '另一个模型' },
    ]
    const adapter = {
      listModels: async (provider: string) => rows.map((row) => ({ ...row, provider })),
      prepareCall: async (provider: string, model: string) => ({
        model: { provider, id: model, name: '演示模型' },
        stream: () => stream(),
      }),
      stream: () => stream(),
    }
    const registration = registerPluginAdapter(company, 'dsh-catalog', ['demo-route'], adapter)
    try {
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(listPluginModels(company)).toHaveLength(2)

      rows = [{ provider: 'demo-route', id: 'demo/model', name: '演示模型' }]
      const result = await syncPluginModels(company)
      expect(result.removed).toBe(1)
      expect(listPluginModels(company).map((model) => model.id)).toEqual(['plugin:demo-route:demo%2Fmodel'])
    } finally {
      registration.dispose()
    }
  })

  it('插件读取目录失败时保留上一次模型，不把整条通道误删', async () => {
    const company = 'c_plugin_catalog_failure_test'
    let broken = false
    const adapter = {
      listModels: async (provider: string) => {
        if (broken) throw new Error('临时读取失败')
        return [{ provider, id: 'demo/model', name: '演示模型' }]
      },
      prepareCall: async (provider: string, model: string) => ({
        model: { provider, id: model, name: '演示模型' },
        stream: () => stream(),
      }),
      stream: () => stream(),
    }
    const registration = registerPluginAdapter(company, 'dsh-catalog-failure', ['demo-route'], adapter)
    try {
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(listPluginModels(company)).toHaveLength(1)

      broken = true
      const result = await syncPluginModels(company)
      expect(result).toEqual({ added: 0, removed: 0, updated: 0 })
      expect(listPluginModels(company)).toHaveLength(1)
    } finally {
      registration.dispose()
    }
  })

  it('插件只返回动态附加字段时不算模型变化，避免每轮同步清空健康状态', async () => {
    const company = 'c_plugin_catalog_stable_test'
    let tick = 0
    const adapter = {
      listModels: async (provider: string) => [
        { provider, id: 'demo/model', name: '演示模型', checkedAt: ++tick, latencyMs: tick * 3 },
      ],
      prepareCall: async (provider: string, model: string) => ({
        model: { provider, id: model, name: '演示模型' },
        stream: () => stream(),
      }),
      stream: () => stream(),
    }
    const registration = registerPluginAdapter(company, 'dsh-catalog-stable', ['demo-route'], adapter)
    try {
      await new Promise((resolve) => setTimeout(resolve, 0))
      const first = await syncPluginModels(company)
      const second = await syncPluginModels(company)
      expect(first).toEqual({ added: 0, removed: 0, updated: 0 })
      expect(second).toEqual({ added: 0, removed: 0, updated: 0 })
    } finally {
      registration.dispose()
    }
  })

  it('插件模型定义变化时通过 updated 差量通知宿主重新探测', async () => {
    const company = 'c_plugin_catalog_update_test'
    const changes: string[][] = []
    let name = '旧名称'
    const adapter = {
      listModels: async (provider: string) => [{ provider, id: 'demo/model', name }],
      prepareCall: async (provider: string, model: string) => ({
        model: { provider, id: model, name: '演示模型' },
        stream: () => stream(),
      }),
      stream: () => stream(),
    }
    setPluginModelsChangedListener((_companyId, change) => {
      if (change?.updated.length) changes.push(change.updated)
    })
    const registration = registerPluginAdapter(company, 'dsh-catalog-update', ['demo-route'], adapter)
    try {
      await new Promise((resolve) => setTimeout(resolve, 0))
      name = '新名称'
      const result = await syncPluginModels(company)
      expect(result.updated).toBe(1)
      expect(listPluginModels(company)[0]?.name).toBe('新名称')
      expect(changes.at(-1)).toEqual(['plugin:demo-route:demo%2Fmodel'])
    } finally {
      registration.dispose()
      setPluginModelsChangedListener(null)
    }
  })
})
