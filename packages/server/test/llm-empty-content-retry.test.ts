import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { migrate, openDatabase } from '@eab/storage'
import { callModelStream } from '../src/llm.js'

function sse(events: string[]): string {
  return `${events.map((event) => `data: ${event}\n\n`).join('')}data: [DONE]\n\n`
}

describe('模型输出上限', () => {
  let server: Server | undefined

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (!server) return resolve()
      server.close(() => resolve())
    })
    server = undefined
  })

  it('推理占满输出上限、没有正文时，用更大预算重试一次', async () => {
    const db = openDatabase({ path: ':memory:' })
    migrate(db)
    db.prepare("INSERT INTO companies (id, name, slug, created_at) VALUES ('c1', '甲公司', 'acme', 1)").run()

    const requests: Array<{ max_tokens?: number }> = []
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += String(chunk)
      })
      req.on('end', () => {
        requests.push(JSON.parse(body) as { max_tokens?: number })
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        if (requests.length === 1) {
          res.end(
            sse([
              '{"choices":[{"delta":{"reasoning_content":"先算日期，再算星期，反复核对……"},"finish_reason":null}]}',
              '{"choices":[{"delta":{},"finish_reason":"length"}]}',
            ]),
          )
          return
        }
        res.end(
          sse([
            '{"choices":[{"delta":{"content":"最终答复"},"finish_reason":null}]}',
            '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}',
          ]),
        )
      })
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试服务器没有端口')

    db.prepare(
      `INSERT INTO model_providers (id, company_id, kind, name, base_url, created_at, updated_at)
       VALUES ('p1', 'c1', 'openai_compatible', '本地模型', ?, 1, 1)`,
    ).run(`http://127.0.0.1:${address.port}/v1`)
    db.prepare(
      `INSERT INTO models
         (id, company_id, provider_id, name, model_key, tags, capabilities, endpoint_kind, priority, enabled, created_at, updated_at)
       VALUES ('m1', 'c1', 'p1', '推理模型', 'reasoner', '["chat","reasoning"]', '["chat"]', 'chat', 10, 1, 1, 1)`,
    ).run()

    const result = await callModelStream(
      db,
      ':memory:',
      'c1',
      'm1',
      [{ role: 'user', content: '帮我整理今天的工作记录' }],
      {},
      1024,
    )

    expect(requests).toHaveLength(2)
    expect(requests[0]?.max_tokens).toBe(1024)
    expect(requests[1]?.max_tokens).toBe(2048)
    expect(result?.text).toBe('最终答复')
    expect(result?.completionTokens).toBe(5)
    db.close()
  })

  it('上游返回空正文时，用同一预算重试一次再决定是否故障转移', async () => {
    const db = openDatabase({ path: ':memory:' })
    migrate(db)
    db.prepare("INSERT INTO companies (id, name, slug, created_at) VALUES ('c1', '甲公司', 'acme', 1)").run()

    const requests: Array<{ max_tokens?: number }> = []
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += String(chunk)
      })
      req.on('end', () => {
        requests.push(JSON.parse(body) as { max_tokens?: number })
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        if (requests.length === 1) {
          res.end(sse(['{"choices":[{"delta":{},"finish_reason":"stop"}]}']))
          return
        }
        res.end(
          sse([
            '{"choices":[{"delta":{"content":"重试后的答复"},"finish_reason":null}]}',
            '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
          ]),
        )
      })
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试服务器没有端口')

    db.prepare(
      `INSERT INTO model_providers (id, company_id, kind, name, base_url, created_at, updated_at)
       VALUES ('p1', 'c1', 'openai_compatible', '本地模型', ?, 1, 1)`,
    ).run(`http://127.0.0.1:${address.port}/v1`)
    db.prepare(
      `INSERT INTO models
         (id, company_id, provider_id, name, model_key, tags, capabilities, endpoint_kind, priority, enabled, created_at, updated_at)
       VALUES ('m1', 'c1', 'p1', '本地模型', 'local', '["chat"]', '["chat"]', 'chat', 10, 1, 1, 1)`,
    ).run()

    const result = await callModelStream(
      db,
      ':memory:',
      'c1',
      'm1',
      [{ role: 'user', content: '你好' }],
      {},
      1024,
    )

    expect(requests).toHaveLength(2)
    expect(requests[0]?.max_tokens).toBe(1024)
    expect(requests[1]?.max_tokens).toBe(1024)
    expect(result?.text).toBe('重试后的答复')
    db.close()
  })

  it('Qwen + vLLM 的「精简」档位直接关闭模板思考，不再先长时间 reasoning', async () => {
    const db = openDatabase({ path: ':memory:' })
    migrate(db)
    db.prepare("INSERT INTO companies (id, name, slug, created_at) VALUES ('c1', '甲公司', 'acme', 1)").run()

    const requests: Array<{ max_tokens?: number; chat_template_kwargs?: { enable_thinking?: boolean } }> = []
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += String(chunk)
      })
      req.on('end', () => {
        requests.push(JSON.parse(body) as { max_tokens?: number; chat_template_kwargs?: { enable_thinking?: boolean } })
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(
          sse([
            '{"choices":[{"delta":{"content":"直接答复"},"finish_reason":null}]}',
            '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
          ]),
        )
      })
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试服务器没有端口')

    db.prepare(
      `INSERT INTO model_providers (id, company_id, kind, name, base_url, created_at, updated_at)
       VALUES ('p1', 'c1', 'openai', 'vllm', ?, 1, 1)`,
    ).run(`http://127.0.0.1:${address.port}/v1`)
    db.prepare(
      `INSERT INTO models
         (id, company_id, provider_id, name, model_key, tags, capabilities, endpoint_kind, priority, enabled, created_at, updated_at)
       VALUES ('m1', 'c1', 'p1', 'Qwen3.6', 'Qwen3.6-35B-A3B-NVFP4', '["chat","reasoning"]', '["chat"]', 'chat', 10, 1, 1, 1)`,
    ).run()

    const result = await callModelStream(
      db,
      ':memory:',
      'c1',
      'm1',
      [{ role: 'user', content: '你好' }],
      { reasoningEffort: 'light' },
      32768,
    )

    expect(requests).toHaveLength(1)
    expect(requests[0]?.max_tokens).toBe(32768)
    expect(requests[0]?.chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(result?.text).toBe('直接答复')
    db.close()
  })

  it('预算已到上限仍只出思考时不缩小预算，改用关闭思考重试', async () => {
    const db = openDatabase({ path: ':memory:' })
    migrate(db)
    db.prepare("INSERT INTO companies (id, name, slug, created_at) VALUES ('c1', '甲公司', 'acme', 1)").run()

    const requests: Array<{ max_tokens?: number; chat_template_kwargs?: { enable_thinking?: boolean } }> = []
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += String(chunk)
      })
      req.on('end', () => {
        requests.push(JSON.parse(body) as { max_tokens?: number; chat_template_kwargs?: { enable_thinking?: boolean } })
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        if (requests.length === 1) {
          res.end(
            sse([
              '{"choices":[{"delta":{"reasoning_content":"反复推理，始终没有进入正文……"},"finish_reason":null}]}',
              '{"choices":[{"delta":{},"finish_reason":"length"}]}',
            ]),
          )
          return
        }
        res.end(
          sse([
            '{"choices":[{"delta":{"content":"关闭思考后的正文"},"finish_reason":null}]}',
            '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
          ]),
        )
      })
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试服务器没有端口')

    db.prepare(
      `INSERT INTO model_providers (id, company_id, kind, name, base_url, created_at, updated_at)
       VALUES ('p1', 'c1', 'openai', 'vllm', ?, 1, 1)`,
    ).run(`http://127.0.0.1:${address.port}/v1`)
    db.prepare(
      `INSERT INTO models
         (id, company_id, provider_id, name, model_key, tags, capabilities, endpoint_kind, priority, enabled, created_at, updated_at)
       VALUES ('m1', 'c1', 'p1', 'Qwen3.6', 'Qwen3.6-35B-A3B-NVFP4', '["chat","reasoning"]', '["chat"]', 'chat', 10, 1, 1, 1)`,
    ).run()

    const result = await callModelStream(
      db,
      ':memory:',
      'c1',
      'm1',
      [{ role: 'user', content: '帮我处理这个长任务' }],
      { reasoningEffort: 'balanced' },
      32768,
    )

    expect(requests).toHaveLength(2)
    expect(requests[0]?.max_tokens).toBe(32768)
    expect(requests[0]?.chat_template_kwargs).toBeUndefined()
    expect(requests[1]?.max_tokens).toBe(32768)
    expect(requests[1]?.chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(result?.text).toBe('关闭思考后的正文')
    db.close()
  })
})
