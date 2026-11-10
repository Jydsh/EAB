import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { migrate, openDatabase } from '@eab/storage'
import { callModel } from '../src/llm.js'

function prepareDb(baseUrl: string) {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  db.prepare("INSERT INTO companies (id, name, slug, created_at) VALUES ('c1', '甲公司', 'acme', 1)").run()
  db.prepare(
    `INSERT INTO model_providers (id, company_id, kind, name, base_url, created_at, updated_at)
     VALUES ('p1', 'c1', 'openai_compatible', '本地模型', ?, 1, 1)`,
  ).run(baseUrl)
  db.prepare(
    `INSERT INTO models
       (id, company_id, provider_id, name, model_key, tags, capabilities, endpoint_kind, priority, enabled, created_at, updated_at)
     VALUES ('m1', 'c1', 'p1', '测试模型', 'test-model', '["chat"]', '["chat"]', 'chat', 10, 1, 1, 1)`,
  ).run()
  return db
}

describe('模型上游瞬时失败重试', () => {
  let server: Server | undefined

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (!server) return resolve()
      server.close(() => resolve())
    })
    server = undefined
  })

  it('429/5xx 在响应未读取时短退避重试，第三次成功', async () => {
    const requests: number[] = []
    server = createServer((_req, res) => {
      requests.push(requests.length + 1)
      if (requests.length < 3) {
        res.writeHead(requests.length === 1 ? 429 : 503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: '上游忙' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '恢复' } }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        }),
      )
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试服务器没有端口')

    const db = prepareDb(`http://127.0.0.1:${address.port}/v1`)
    const result = await callModel(db, ':memory:', 'c1', 'm1', [{ role: 'user', content: '你好' }], 100)

    expect(requests).toHaveLength(3)
    expect(result?.text).toBe('恢复')
    db.close()
  })

  it('401 不重试，避免把鉴权错误放大成三次等待', async () => {
    let requests = 0
    server = createServer((_req, res) => {
      requests += 1
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: '密钥无效' } }))
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试服务器没有端口')

    const db = prepareDb(`http://127.0.0.1:${address.port}/v1`)
    await expect(
      callModel(db, ':memory:', 'c1', 'm1', [{ role: 'user', content: '你好' }], 100),
    ).rejects.toMatchObject({ code: 'EAB_UPSTREAM' })
    expect(requests).toBe(1)
    db.close()
  })
})
