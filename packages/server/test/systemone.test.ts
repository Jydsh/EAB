import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { migrate, openDatabase } from '@eab/storage'
import { callSystemOne } from '../src/llm.js'
import { planSubAgentModelsWithDecision } from '../src/agent-model-router.js'
import { MODEL_ENDPOINT_KINDS, MODEL_ROUTE_PURPOSES, inferModelProfile, modelSupportsPurpose } from '../src/model-registry.js'

function seededDb(baseUrl: string) {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  db.prepare("INSERT INTO companies (id, name, slug, created_at) VALUES ('c1', '甲公司', 'acme', 1)").run()
  db.prepare(
    `INSERT INTO model_providers (id, company_id, kind, name, base_url, created_at, updated_at)
     VALUES ('p1', 'c1', 'custom', 'SystemOne 网关', ?, 1, 1)`,
  ).run(baseUrl)
  db.prepare(
    `INSERT INTO models
       (id, company_id, provider_id, name, model_key, tags, capabilities, endpoint_kind, priority, enabled, created_at, updated_at)
     VALUES ('m_dec', 'c1', 'p1', '决策模型', 'ecnu-decision', '["decision"]', '["chat","reasoning","decision"]', 'systemone', 30, 1, 1, 1)`,
  ).run()
  db.prepare(
    `INSERT INTO models
       (id, company_id, provider_id, name, model_key, tags, capabilities, endpoint_kind, priority, enabled, created_at, updated_at)
     VALUES ('m_fast', 'c1', 'p1', '快速模型', 'fast-chat', '["chat","fast"]', '["chat","fast"]', 'chat', 10, 1, 1, 1)`,
  ).run()
  db.prepare(
    `INSERT INTO models
       (id, company_id, provider_id, name, model_key, tags, capabilities, endpoint_kind, priority, enabled, created_at, updated_at)
     VALUES ('m_code', 'c1', 'p1', '代码模型', 'code-chat', '["code","tool"]', '["chat","code","tool"]', 'chat', 5, 1, 1, 1)`,
  ).run()
  db.prepare(
    `INSERT INTO model_routes (id, company_id, purpose, model_id, priority, enabled, created_at, updated_at)
     VALUES ('r1', 'c1', 'agent.model_choice', 'm_dec', 10, 1, 1, 1)`,
  ).run()
  return db
}

async function startSystemOneServer(
  handler: (body: Record<string, unknown>, url: string) => { status: number; payload: unknown },
) {
  const requests: Array<{ url: string; body: Record<string, unknown>; authorization: string }> = []
  const server: Server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += String(chunk)
    })
    req.on('end', () => {
      let body: Record<string, unknown> = {}
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      } catch {
        body = {}
      }
      requests.push({
        url: String(req.url ?? ''),
        body,
        authorization: String(req.headers.authorization ?? ''),
      })
      const result = handler(body, String(req.url ?? ''))
      res.writeHead(result.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result.payload))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('mock server 没有端口')
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1`, requests }
}

let server: Server | undefined
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
  server = undefined
})

describe('SystemOne 端点与用途注册', () => {
  it('端点枚举包含 systemone，且只有 systemone 模型能进入子 Agent 分配用途', () => {
    expect(MODEL_ENDPOINT_KINDS).toContain('systemone')
    const purpose = MODEL_ROUTE_PURPOSES.find((item) => item.purpose === 'agent.model_choice')
    expect(purpose?.label).toBe('子 Agent 模型分配')

    const decisionModel = {
      id: 'm_dec',
      name: '决策模型',
      modelKey: 'ecnu-decision',
      providerId: 'p1',
      providerKind: 'custom',
      providerName: 'SystemOne 网关',
      priority: 10,
      capabilities: ['chat', 'reasoning', 'decision'],
      endpointKind: 'systemone',
      inputModalities: ['text'],
      outputModalities: ['text'],
      maxContext: null,
      maxOutputTokens: null,
      contextCompression: true,
      embeddingDim: null,
      config: {},
      thinking: null,
    }
    expect(modelSupportsPurpose(decisionModel, 'agent.model_choice')).toBe(true)
    expect(modelSupportsPurpose({ ...decisionModel, endpointKind: 'chat' }, 'agent.model_choice')).toBe(false)
  })

  it('模型名里带 systemone 时按高置信度推断为决策端点', () => {
    const profile = inferModelProfile('ecnu-systemone-decision')
    expect(profile.modelType).toBe('decision')
    expect(profile.endpointKind).toBe('systemone')
    expect(profile.api.path).toBe('/systemone')
  })
})

describe('SystemOne 决策端点', () => {
  it('按 POST /v1/systemone 发送 state + questions，并解析 choice 与置信度', async () => {
    const mock = await startSystemOneServer(() => ({
      status: 200,
      payload: {
        id: 'dec_1',
        object: 'structured_decision',
        model: 'vllm-sr/d3-flash',
        answers: {
          task_1: {
            type: 'choice',
            choice: 'm_code',
            probabilities: { m_code: 0.91, m_fast: 0.09 },
            confidence: 0.91,
          },
        },
        usage: { input_tokens: 42, output_tokens: 0 },
      },
    }))
    server = mock.server
    const db = seededDb(mock.baseUrl)
    const result = await callSystemOne(
      db,
      ':memory:',
      'c1',
      'm_dec',
      { task: '修复登录接口', models: ['m_fast', 'm_code'] },
      {
        task_1: {
          type: 'choice',
          instructions: '选择最适合的模型',
          criteria: { m_fast: '快速模型', m_code: '代码模型' },
        },
      },
    )

    expect(mock.requests).toHaveLength(1)
    expect(mock.requests[0].url).toBe('/v1/systemone')
    expect(mock.requests[0].authorization).toBe('')
    expect(mock.requests[0].body).toMatchObject({
      model: 'ecnu-decision',
      state: { task: '修复登录接口', models: ['m_fast', 'm_code'] },
      questions: {
        task_1: {
          type: 'choice',
          instructions: '选择最适合的模型',
          criteria: { m_fast: '快速模型', m_code: '代码模型' },
        },
      },
    })
    expect(result.answers.task_1.choice).toBe('m_code')
    expect(result.answers.task_1.confidence).toBe(0.91)
    expect(result.usage.input_tokens).toBe(42)
    db.close()
  })

  it('兼容网关注入的 detail 数组错误', async () => {
    const mock = await startSystemOneServer(() => ({
      status: 400,
      payload: {
        detail: [{ loc: ['body', 'questions', 0, 'instructions'], msg: 'questions.0.instructions is required' }],
      },
    }))
    server = mock.server
    const db = seededDb(mock.baseUrl)
    await expect(
      callSystemOne(
        db,
        ':memory:',
        'c1',
        'm_dec',
        { task: '测试' },
        { task_1: { type: 'choice', instructions: '', criteria: { a: 'A', b: 'B' } } },
      ),
    ).rejects.toThrow(/questions.0.instructions is required/)
    db.close()
  })
})

describe('父 Agent 用 SystemOne 分配子 Agent 模型', () => {
  it('按每道任务题返回的 choice 分配模型，并把置信度写进原因', async () => {
    const mock = await startSystemOneServer((body) => {
      expect(body.state).toMatchObject({ purpose: 'agent.model_choice' })
      const questions = body.questions as Record<string, unknown>
      expect(Object.keys(questions)).toEqual(['task_1', 'task_2'])
      const stateModels = (body.state as { models?: Array<{ label?: string; id?: string }> }).models ?? []
      expect(stateModels.map((item) => item.label)).toEqual(['m1', 'm2'])
      expect(Object.keys((questions.task_1 as { criteria: Record<string, string> }).criteria)).toEqual(['m1', 'm2'])
      return {
        status: 200,
        payload: {
          object: 'structured_decision',
          model: 'vllm-sr/d3-flash',
          answers: {
            task_1: { type: 'choice', choice: 'm2', confidence: 0.94 },
            task_2: { type: 'choice', choice: 'm1', confidence: 0.88 },
          },
          usage: { input_tokens: 200, output_tokens: 0 },
        },
      }
    })
    server = mock.server
    const db = seededDb(mock.baseUrl)
    const models = [
      { id: 'm_dec', name: '决策模型', capabilities: ['chat', 'reasoning', 'decision'], priority: 30, endpointKind: 'systemone' },
      { id: 'm_fast', name: '快速模型', capabilities: ['chat', 'fast'], priority: 10, endpointKind: 'chat' },
      { id: 'm_code', name: '代码模型', capabilities: ['chat', 'code', 'tool'], priority: 5, endpointKind: 'chat' },
    ]
    const decisions = await planSubAgentModelsWithDecision({
      db,
      dbPath: ':memory:',
      companyId: 'c1',
      tasks: [
        { title: '修接口', prompt: '修复登录接口的 bug，并补单元测试' },
        { title: '摘要', prompt: '快速整理一段会议摘要' },
      ],
      models,
      decisionCatalog: models,
    })

    expect(decisions?.get(0)?.modelId).toBe('m_code')
    expect(decisions?.get(0)?.reason).toContain('置信度 94%')
    expect(decisions?.get(1)?.modelId).toBe('m_fast')
    expect(decisions?.get(1)?.reason).toContain('置信度 88%')
    db.close()
  })

  it('低置信度不采用，返回 null 交给能力匹配回退', async () => {
    const mock = await startSystemOneServer(() => ({
      status: 200,
      payload: {
        object: 'structured_decision',
        answers: { task_1: { type: 'choice', choice: 'm_code', confidence: 0.2 } },
      },
    }))
    server = mock.server
    const db = seededDb(mock.baseUrl)
    const models = [
      { id: 'm_dec', name: '决策模型', capabilities: ['decision'], priority: 30, endpointKind: 'systemone' },
      { id: 'm_fast', name: '快速模型', capabilities: ['chat'], priority: 10, endpointKind: 'chat' },
      { id: 'm_code', name: '代码模型', capabilities: ['chat', 'code'], priority: 5, endpointKind: 'chat' },
    ]
    const decisions = await planSubAgentModelsWithDecision({
      db,
      dbPath: ':memory:',
      companyId: 'c1',
      tasks: [{ title: '修接口', prompt: '修复登录接口的 bug' }],
      models,
      decisionCatalog: models,
    })
    expect(decisions).toBeNull()
    db.close()
  })
})
