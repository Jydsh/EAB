import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { migrate, openDatabase } from '@eab/storage'
import { callModelStream } from '../src/llm.js'

interface RequestBody {
  max_tokens?: number
  reasoning_effort?: string
}

function sse(events: string[]): string {
  return `${events.map((event) => `data: ${event}\n\n`).join('')}data: [DONE]\n\n`
}

function setup(handler: (body: RequestBody, index: number) => string) {
  const requests: RequestBody[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += String(chunk)
    })
    req.on('end', () => {
      const body = JSON.parse(raw) as RequestBody
      requests.push(body)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(handler(body, requests.length))
    })
  })
  return { requests, server }
}

async function prepare(server: Server, modelId = 'm1') {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  db.prepare("INSERT INTO companies (id, name, slug, created_at) VALUES ('c1', '甲公司', 'acme', 1)").run()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('测试服务器没有端口')
  db.prepare(
    `INSERT INTO model_providers (id, company_id, kind, name, base_url, created_at, updated_at)
     VALUES ('p1', 'c1', 'openai_compatible', '本地模型', ?, 1, 1)`,
  ).run(`http://127.0.0.1:${address.port}/v1`)
  db.prepare(
    `INSERT INTO models
       (id, company_id, provider_id, name, model_key, tags, capabilities, endpoint_kind, priority, enabled, created_at, updated_at)
     VALUES (?, 'c1', 'p1', '推理模型', 'reasoner', '["chat","reasoning"]', '["chat"]', 'chat', 10, 1, 1, 1)`,
  ).run(modelId)
  return db
}

describe('思考档位真实下发', () => {
  let server: Server | undefined

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (!server) return resolve()
      server.close(() => resolve())
    })
    server = undefined
  })

  it('原生思考档位映射成 reasoning_effort 发送给上游', async () => {
    const context = setup(() =>
      sse(['{"choices":[{"delta":{"content":"答复"},"finish_reason":"stop"}]}']),
    )
    server = context.server
    const db = await prepare(server)
    await callModelStream(
      db,
      ':memory:',
      'c1',
      'm1',
      [{ role: 'user', content: '你好' }],
      { reasoningEffort: 'light' },
      4096,
    )
    expect(context.requests[0]?.reasoning_effort).toBe('low')
    expect(context.requests[0]?.max_tokens).toBe(4096)
    db.close()
  })

  it('输出预算上限下，推理占满预算也不会把精简档翻倍突破', async () => {
    const context = setup(() =>
      sse([
        '{"choices":[{"delta":{"reasoning_content":"一直在思考"},"finish_reason":null}]}',
        '{"choices":[{"delta":{},"finish_reason":"length"}]}',
      ]),
    )
    server = context.server
    const db = await prepare(server)
    await expect(
      callModelStream(
        db,
        ':memory:',
        'c1',
        'm1',
        [{ role: 'user', content: '你好' }],
        { maxTokensCap: 2048 },
        2048,
      ),
    ).rejects.toThrow('模型只输出了推理内容')
    expect(context.requests).toHaveLength(1)
    expect(context.requests[0]?.max_tokens).toBe(2048)
    db.close()
  })
})
