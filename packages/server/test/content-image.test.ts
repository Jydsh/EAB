import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type RequestListener, type Server } from 'node:http'
import { migrate, openDatabase } from '@eab/storage'
import { callImageGeneration } from '../src/llm.js'
import { inferModelProfile, modelSupportsPurpose, MODEL_ROUTE_PURPOSES } from '../src/model-registry.js'
import { routeCapabilities } from '../src/capability-route.js'

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function prepareDb(baseUrl: string) {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  db.prepare("INSERT INTO companies (id, name, slug, created_at) VALUES ('c1', '甲公司', 'acme', 1)").run()
  db.prepare(
    `INSERT INTO model_providers (id, company_id, kind, name, base_url, created_at, updated_at)
     VALUES ('p1', 'c1', 'openai_compatible', '本地图片模型', ?, 1, 1)`,
  ).run(baseUrl)
  db.prepare(
    `INSERT INTO models
       (id, company_id, provider_id, name, model_key, tags, capabilities, endpoint_kind, priority, enabled, created_at, updated_at)
     VALUES ('m1', 'c1', 'p1', '图片生成', 'test-image', '["chat"]', '["chat"]', 'image', 10, 1, 1, 1)`,
  ).run()
  return db
}

describe('AGT-19 图片生成调用', () => {
  let server: Server | undefined

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (!server) return resolve()
      server.close(() => resolve())
    })
    server = undefined
  })

  async function listen(handler: RequestListener): Promise<string> {
    server = createServer(handler)
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试服务器没有端口')
    return `http://127.0.0.1:${address.port}/v1`
  }

  it('读取 data[0].b64_json，并校验 PNG 魔数', async () => {
    let received: Record<string, unknown> | null = null
    const baseUrl = await listen((req, res) => {
      let raw = ''
      req.on('data', (chunk) => { raw += chunk })
      req.on('end', () => {
        received = JSON.parse(raw) as Record<string, unknown>
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ b64_json: PNG_1PX, revised_prompt: '一张测试图' }] }))
      })
    })
    const db = prepareDb(baseUrl)
    const result = await callImageGeneration(db, ':memory:', 'c1', 'm1', '画一只猫', { size: '1024x1024' })

    expect(received).toMatchObject({ model: 'test-image', prompt: '画一只猫', size: '1024x1024', n: 1 })
    expect(result.mime).toBe('image/png')
    expect(result.image.length).toBeGreaterThan(20)
    expect(result.revisedPrompt).toBe('一张测试图')
    db.close()
  })

  it('读取 data[0].url 并下载，非图片内容会被拒绝', async () => {
    let baseUrl = ''
    baseUrl = await listen((req, res) => {
      if (req.url === '/img.png') {
        res.writeHead(200, { 'content-type': 'image/png' })
        res.end(Buffer.from(PNG_1PX, 'base64'))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ url: `${baseUrl.replace('/v1', '')}/img.png` }] }))
    })
    const db = prepareDb(baseUrl)
    const result = await callImageGeneration(db, ':memory:', 'c1', 'm1', '画一个图标')
    expect(result.mime).toBe('image/png')
    db.close()
  })

  it('上游返回 HTML 错误页时给出可定位的报错', async () => {
    const baseUrl = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>bad gateway</html>')
    })
    const db = prepareDb(baseUrl)
    await expect(
      callImageGeneration(db, ':memory:', 'c1', 'm1', '画一张海报'),
    ).rejects.toMatchObject({ code: 'EAB_VALIDATION' })
    db.close()
  })
})

describe('AGT-19 端点与意图路由', () => {
  it('图片模型名推断到 image 端点与图片生成用途', () => {
    for (const key of ['gpt-image-1', 'dall-e-3', 'flux-dev', 'stable-diffusion-xl', 'seedream-4.0']) {
      const profile = inferModelProfile(key)
      expect(profile.endpointKind).toBe('image')
      expect(profile.label).toBe('图片生成')
    }
  })

  it('image.default 只认 image 端点', () => {
    expect(MODEL_ROUTE_PURPOSES.some((item) => item.purpose === 'image.default')).toBe(true)
    const image = { endpointKind: 'image' } as Parameters<typeof modelSupportsPurpose>[0]
    const chat = { endpointKind: 'chat' } as Parameters<typeof modelSupportsPurpose>[0]
    expect(modelSupportsPurpose(image, 'image.default')).toBe(true)
    expect(modelSupportsPurpose(chat, 'image.default')).toBe(false)
  })

  it('只有明确画图意图才下发内容工具', () => {
    expect(routeCapabilities('帮我画一张公司年会海报').content).toBe(true)
    expect(routeCapabilities('生成一张重庆夜景插画').content).toBe(true)
    expect(routeCapabilities('把图片发给我').content).toBe(false)
    expect(routeCapabilities('这个月的检查记录有多少条').content).toBe(false)
  })
})
