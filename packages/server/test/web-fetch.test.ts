import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EC } from '@eab/domain'
import { clearWebFetchCache, decodeHtmlBuffer, extractHtml, htmlToText, webFetch } from '../src/web-fetch.js'

const servers: Server[] = []

beforeEach(() => clearWebFetchCache())

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        }),
    ),
  )
})

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ port: number; calls: () => number }> {
  let calls = 0
  const server = createServer((req, res) => {
    calls += 1
    handler(req, res)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server missing port')
  return { port: address.port, calls: () => calls }
}

const ARTICLE = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>站点标题 - 频道</title>
  <meta property="og:title" content="一篇真实文章">
  <meta property="og:site_name" content="测试站点">
  <meta property="article:published_time" content="2026-11-20T10:00:00+08:00">
  <link rel="canonical" href="/article/1">
</head>
<body>
  <nav><a href="/">首页</a><a href="/about">关于</a></nav>
  <article>
    <h1>一篇真实文章</h1>
    <p>第一段正文，包含中文和 <strong>加粗内容</strong>，以及 &amp; 实体。</p>
    <p>第二段正文，用来确认正文提取不会把导航和页脚拼进来。这里再补一些文字，让正文长度超过回退阈值。</p>
    <p>第三段正文，继续补充内容。EAB 需要读取公开网页，但不能把导航、广告和页脚当成正文返回给模型。</p>
    <p>第四段正文，测试链接提取。</p>
    <a href="/article/2">下一篇</a>
  </article>
  <footer><a href="/privacy">隐私政策</a></footer>
</body>
</html>`

describe('HTML 正文提取', () => {
  it('优先 article，去掉导航和页脚，并解码实体', () => {
    const extraction = extractHtml(ARTICLE, 'https://example.com/news/1')
    expect(extraction.title).toBe('一篇真实文章')
    expect(extraction.siteName).toBe('测试站点')
    expect(extraction.publishedAt).toBe('2026-11-20T10:00:00+08:00')
    expect(extraction.text).toContain('第一段正文')
    expect(extraction.text).toContain('加粗内容')
    expect(extraction.text).toContain('& 实体')
    expect(extraction.text).not.toContain('隐私政策')
    expect(extraction.links).toEqual([{ text: '下一篇', url: 'https://example.com/article/2' }])
  })

  it('HTML 转文本保留段落和列表结构', () => {
    const text = htmlToText('<p>第一段</p><ul><li>甲</li><li>乙</li></ul><p>第二段<br>换行</p>')
    expect(text).toBe('第一段\n\n- 甲\n- 乙\n第二段\n换行')
  })

  it('按响应头 charset 解码 GBK', () => {
    // “中文”的 GBK 字节
    const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4])
    expect(decodeHtmlBuffer(gbk, 'text/html; charset=gbk')).toBe('中文')
  })
})

describe('网页读取', () => {
  it('读取网页并返回标题、正文和链接', async () => {
    const { port } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(ARTICLE)
    })

    const result = await webFetch(
      { url: `http://127.0.0.1:${port}/news/1` },
      { allowPrivateNetwork: true, allowedPorts: [port] },
    )

    expect(result.title).toBe('一篇真实文章')
    expect(result.siteName).toBe('测试站点')
    expect(result.finalUrl).toBe(`http://127.0.0.1:${port}/news/1`)
    expect(result.text).toContain('第一段正文')
    expect(result.text).not.toContain('隐私政策')
    expect(result.provider).toBe('direct')
  })

  it('按字符分页且复用缓存，不重复请求上游', async () => {
    const unique = Array.from({ length: 800 }, (_, index) => `段落${index}。`).join('')
    const longHtml = `<html><head><title>长文</title></head><body><article><p>${unique}</p></article></body></html>`
    const { port, calls } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(longHtml)
    })
    const options = { allowPrivateNetwork: true, allowedPorts: [port] }

    const first = await webFetch({ url: `http://127.0.0.1:${port}/a`, maxChars: 200 }, options)
    expect(first.text.length).toBe(200)
    expect(first.truncated).toBe(true)
    expect(first.nextStart).toBe(200)

    const second = await webFetch({ url: `http://127.0.0.1:${port}/a`, start: first.nextStart ?? 0, maxChars: 200 }, options)
    expect(second.text).not.toBe(first.text)
    expect(calls()).toBe(1)
  })

  it('no-store 响应不进入缓存', async () => {
    const { port, calls } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end('动态内容')
    })
    const options = { allowPrivateNetwork: true, allowedPorts: [port] }
    await webFetch({ url: `http://127.0.0.1:${port}/d` }, options)
    await webFetch({ url: `http://127.0.0.1:${port}/d` }, options)
    expect(calls()).toBe(2)
  })

  it('404 和需要登录的页面给出明确错误', async () => {
    const { port } = await startServer((req, res) => {
      if (req.url === '/missing') {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('not found')
        return
      }
      res.writeHead(403, { 'content-type': 'text/html' })
      res.end('forbidden')
    })
    const options = { allowPrivateNetwork: true, allowedPorts: [port] }

    await expect(webFetch({ url: `http://127.0.0.1:${port}/missing` }, options)).rejects.toMatchObject({
      code: EC.NOT_FOUND,
    })
    await expect(webFetch({ url: `http://127.0.0.1:${port}/private` }, options)).rejects.toMatchObject({
      code: EC.UPSTREAM,
      message: expect.stringContaining('需要登录'),
    })
  })

  it('拒绝不支持的二进制类型', async () => {
    const { port } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(Buffer.from([0, 1, 2, 3]))
    })

    await expect(
      webFetch(
        { url: `http://127.0.0.1:${port}/file.bin` },
        { allowPrivateNetwork: true, allowedPorts: [port] },
      ),
    ).rejects.toMatchObject({ code: EC.VALIDATION })
  })
})
