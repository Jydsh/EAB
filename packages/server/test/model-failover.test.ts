import { describe, expect, it } from 'vitest'
import { SC } from '@eab/domain'
import { migrate, openDatabase } from '@eab/storage'
import { isModelHealthy } from '../src/model-health.js'
import { listPluginModels, registerPluginAdapter } from '../src/plugin-models.js'
import { runAgentTurn } from '../src/routes/chat.js'

const COMPANY = 'failover-test-company'

function pluginId(provider: string, model: string): string {
  return `plugin:${encodeURIComponent(provider)}:${encodeURIComponent(model)}`
}

function actor() {
  return {
    subject: {
      companyId: COMPANY,
      userId: 'u1',
      status: 'active',
      deptId: 'd1',
      deptPath: '/d1',
      deptChain: [],
      roles: [],
      scopes: new Set(Object.values(SC)),
    },
    person: {
      id: 'u1',
      name: '测试员工',
      title: null,
      deptId: 'd1',
      deptPath: '/d1',
      deptName: '测试部门',
      companyId: COMPANY,
      companyName: '测试公司',
    },
  } as any
}

function deps() {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  return {
    db,
    config: { dbPath: ':memory:' },
    companyId: COMPANY,
  } as any
}

async function waitForModels(): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline && listPluginModels(COMPANY).length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function makeAdapter(mode: 'recover' | 'all-fail') {
  return {
    listModels: async () => [
      { id: 'bad', name: '坏模型', tags: ['chat'] },
      { id: 'good', name: '接替模型', tags: ['chat'] },
    ],
    async *stream(options: Record<string, unknown>) {
      const model = String(options.model ?? '')
      if (model === 'bad') {
        // 先吐一点内容再失败，验证渠道的缓冲模式不会把半截回答留下。
        yield { type: 'text-delta', text: '半截回答' }
        throw new Error('上游 503')
      }
      if (mode === 'all-fail') throw new Error('上游超时')
      yield { type: 'text-delta', text: '接替回答' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

describe('对话模型故障转移', () => {
  it('首选模型失败后切换到仍有权限的备用模型，丢弃半截输出', async () => {
    const d = deps()
    const registration = registerPluginAdapter(COMPANY, 'failover-plugin', ['failover-route'], makeAdapter('recover'))
    const badId = pluginId('failover-route', 'bad')
    const goodId = pluginId('failover-route', 'good')
    await waitForModels()
    const emitted: string[] = []
    const events: Array<{ fromModelId: string; toModelId: string }> = []

    try {
      const result = await runAgentTurn({
        deps: d,
        actor: actor(),
        modelId: badId,
        fallbackModelIds: [goodId],
        bufferModelEvents: true,
        messages: [{ role: 'user', content: '你好' }],
        emit: (event) => {
          if (event.type === 'content') emitted.push(event.text)
        },
        onModelFailover: (change) => events.push(change),
      })

      expect(result?.text).toBe('接替回答')
      expect(result?.usedModelId).toBe(goodId)
      expect(result?.fallbackFromModelId).toBe(badId)
      expect(emitted).toEqual(['接替回答'])
      expect(events).toHaveLength(1)
      expect(events[0]?.toModelId).toBe(goodId)
      expect(isModelHealthy(COMPANY, badId)).toBe(false)
      expect(isModelHealthy(COMPANY, goodId)).toBe(true)
    } finally {
      registration.dispose()
      d.db.close()
    }
  })

  it('所有有权限模型都失败时返回聚合错误，而不是单个上游报错', async () => {
    const d = deps()
    const registration = registerPluginAdapter(COMPANY, 'failover-all-fail', ['failover-route'], makeAdapter('all-fail'))
    const badId = pluginId('failover-route', 'bad')
    const goodId = pluginId('failover-route', 'good')
    await waitForModels()

    try {
      await expect(
        runAgentTurn({
          deps: d,
          actor: actor(),
          modelId: badId,
          fallbackModelIds: [goodId],
          bufferModelEvents: true,
          messages: [{ role: 'user', content: '你好' }],
          emit: () => {},
        }),
      ).rejects.toThrow('当前有权限的模型都暂时无法回复')
      expect(isModelHealthy(COMPANY, badId)).toBe(false)
      expect(isModelHealthy(COMPANY, goodId)).toBe(false)
    } finally {
      registration.dispose()
      d.db.close()
    }
  })
})
