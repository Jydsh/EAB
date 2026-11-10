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
})
