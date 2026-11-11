import { describe, expect, it } from 'vitest'
import { EC, EabError } from '@eab/domain'
import { listPluginModels, registerPluginAdapter } from '../src/plugin-models.js'
import {
  filterHealthyModels,
  forgetModelHealth,
  isModelHealthy,
  markModelHealthy,
  markModelUnhealthy,
  probePluginModel,
  shouldMarkModelFailure,
} from '../src/model-health.js'

function pluginId(provider: string, model: string): string {
  return `plugin:${encodeURIComponent(provider)}:${encodeURIComponent(model)}`
}

function adapter(options: { fail?: boolean; content?: string }) {
  return {
    listModels: async () => [
      { id: 'health-probe', name: '健康探测模型', tags: ['chat'] },
    ],
    async *stream() {
      if (options.fail) throw new Error('upstream 503')
      yield { type: 'text-delta', text: options.content ?? '可用' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

describe('模型健康状态', () => {
  it('未探测默认不可用；成功恢复、失败过滤；全部失败时返回空数组', () => {
    const company = 'health-state-test'
    const models = [{ id: 'a' }, { id: 'b' }]
    // 新注入的插件模型必须先探测通过，未探测不能进入目录。
    expect(filterHealthyModels(company, models)).toEqual([])

    markModelHealthy(company, 'a')
    expect(filterHealthyModels(company, models)).toEqual([{ id: 'a' }])

    markModelUnhealthy(company, 'a', 'quota')
    expect(isModelHealthy(company, 'a')).toBe(false)
    expect(filterHealthyModels(company, models)).toEqual([])

    markModelUnhealthy(company, 'b', 'timeout')
    expect(filterHealthyModels(company, models)).toEqual([])

    markModelHealthy(company, 'b')
    expect(filterHealthyModels(company, models)).toEqual([{ id: 'b' }])
  })

  it('只把模型上游/限流类错误算作不可回复', () => {
    expect(shouldMarkModelFailure(new EabError(EC.UPSTREAM, '上游失败'))).toBe(true)
    expect(shouldMarkModelFailure(new EabError(EC.RATE_LIMITED, '额度用尽'))).toBe(true)
    expect(shouldMarkModelFailure(new EabError(EC.SCOPE_DENIED, '没权限'))).toBe(false)
    expect(shouldMarkModelFailure(new EabError(EC.VALIDATION, '参数错'))).toBe(false)
    const abort = new Error('stopped')
    abort.name = 'AbortError'
    expect(shouldMarkModelFailure(abort)).toBe(false)
  })

  it('插件移除模型时清掉健康结论，模型回来仍要重新探测', async () => {
    const company = 'health-forget-test'
    const model = [{ id: 'plugin:route:model' }]
    markModelHealthy(company, model[0].id)
    expect(filterHealthyModels(company, model)).toHaveLength(1)

    forgetModelHealth(company, [model[0].id])
    expect(isModelHealthy(company, model[0].id)).toBe(false)
    expect(filterHealthyModels(company, model)).toEqual([])
  })

  it('探测真实插件 adapter：成功标记可用，失败标记不可用', async () => {
    const company = 'health-probe-test'
    const good = registerPluginAdapter(company, 'probe-good', ['probe-good'], adapter({}))
    const bad = registerPluginAdapter(company, 'probe-bad', ['probe-bad'], adapter({ fail: true }))
    const goodId = pluginId('probe-good', 'health-probe')
    const badId = pluginId('probe-bad', 'health-probe')
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && listPluginModels(company).length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    expect(await probePluginModel(company, goodId, 2_000)).toBe(true)
    expect(isModelHealthy(company, goodId)).toBe(true)
    expect(await probePluginModel(company, badId, 2_000)).toBe(false)
    expect(isModelHealthy(company, badId)).toBe(false)

    good.dispose()
    bad.dispose()
  })
})
