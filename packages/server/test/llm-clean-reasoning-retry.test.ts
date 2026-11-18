import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { migrate, openDatabase } from '@eab/storage'
import { callModel } from '../src/llm.js'

describe('非流式模型输出预算', () => {
  let server: Server | undefined

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (!server) return resolve()
      server.close(() => resolve())
    })
    server = undefined
  })

  it('只有 reasoning、没有正文时，用 8192 预算重试一次', async () => {
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
        res.writeHead(200, { 'content-type': 'application/json' })
        if (requests.length === 1) {
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: { content: '', reasoning_content: '先判断哪些是页眉页脚，再逐块保留事实……' },
                  finish_reason: 'length',
                },
              ],
            }),
          )
          return
        }
        res.end(
          JSON.stringify({
            choices: [{ message: { content: '清洗后的正文' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 20, completion_tokens: 8 },
          }),
        )
      })
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试服务器没有端口')

    db.prepare(
      `INSERT INTO model_providers (id, company_id, kind, name, base_url, created_at, updated_at)
       VALUES ('p1', 'c1', 'openai', '本地模型', ?, 1, 1)`,
    ).run(`http://127.0.0.1:${address.port}/v1`)
    db.prepare(
      `INSERT INTO models
         (id, company_id, provider_id, name, model_key, tags, capabilities, endpoint_kind, priority, enabled, created_at, updated_at)
       VALUES ('m1', 'c1', 'p1', '推理模型', 'reasoner', '["chat","reasoning"]', '["chat"]', 'chat', 10, 1, 1, 1)`,
    ).run()

    const result = await callModel(db, ':memory:', 'c1', 'm1', [{ role: 'user', content: '清洗这一段' }], 1024)

    expect(requests).toHaveLength(2)
    expect(requests[0]?.max_tokens).toBe(1024)
    expect(requests[1]?.max_tokens).toBe(8192)
    expect(result?.text).toBe('清洗后的正文')
    db.close()
  })
})
