import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { EC } from '@eab/domain'
import { isPrivateAddress, fetchJson, proxyForUrl, safeGet } from '../src/net-policy.js'

const servers: Server[] = []

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
): Promise<{ server: Server; port: number; calls: () => number }> {
  let calls = 0
  const server = createServer((req, res) => {
    calls += 1
    handler(req, res)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server missing port')
  return { server, port: address.port, calls: () => calls }
}

describe('公网访问安全层', () => {
  it('识别 IPv4 私网、环回、链路本地、CGNAT、组播和保留地址', () => {
    for (const address of [
      '0.0.0.0',
      '10.1.2.3',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.0.0.1',
      '192.168.1.1',
      '198.18.0.1',
      '224.0.0.1',
      '255.255.255.255',
    ]) {
      expect(isPrivateAddress(address), address).toBe(true)
    }
    expect(isPrivateAddress('8.8.8.8')).toBe(false)
    expect(isPrivateAddress('93.184.216.34')).toBe(false)
    expect(isPrivateAddress('172.32.0.1')).toBe(false)
  })

  it('识别 IPv6 环回、ULA、链路本地、组播和 IPv4 映射私网', () => {
    for (const address of [
      '::',
      '::1',
      '0:0:0:0:0:0:0:1',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:192.168.1.1',
      '64:ff9b::10.0.0.1',
    ]) {
      expect(isPrivateAddress(address), address).toBe(true)
    }
    expect(isPrivateAddress('2001:4860:4860::8888')).toBe(false)
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false)
  })

  it('默认拒绝本机地址，并且拒绝发生在建立连接之前', async () => {
    const { port, calls } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('should not be reached')
    })

    await expect(safeGet(`http://127.0.0.1:${port}/`)).rejects.toMatchObject({
      code: EC.VALIDATION,
    })
    expect(calls()).toBe(0)
  })

  it('拒绝带账号密码、非 http(s) 协议和非标准端口', async () => {
    await expect(safeGet('https://user:pass@example.com/')).rejects.toMatchObject({ code: EC.VALIDATION })
    await expect(safeGet('file:///etc/passwd')).rejects.toMatchObject({ code: EC.VALIDATION })
    await expect(safeGet('https://example.com:8443/')).rejects.toMatchObject({ code: EC.VALIDATION })
  })

  it('受控放行本机后能读取内容，并处理 gzip', async () => {
    const { gzipSync } = await import('node:zlib')
    const { port } = await startServer((_req, res) => {
      const body = gzipSync(Buffer.from('压缩后的正文', 'utf8'))
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-encoding': 'gzip' })
      res.end(body)
    })

    const response = await safeGet(`http://127.0.0.1:${port}/`, {
      allowPrivateNetwork: true,
      allowedPorts: [port],
    })
    expect(response.status).toBe(200)
    expect(response.body.toString('utf8')).toBe('压缩后的正文')
  })

  it('内网白名单只放行名单内目标，localhost 始终拒绝', async () => {
    const { port } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('allowlisted')
    })

    const allowed = await safeGet(`http://127.0.0.1:${port}/`, {
      allowPrivateNetwork: true,
      privateNetworkHosts: ['127.0.0.1'],
      allowedPorts: [port],
    })
    expect(allowed.status).toBe(200)

    await expect(
      safeGet(`http://127.0.0.1:${port}/`, {
        allowPrivateNetwork: true,
        privateNetworkHosts: ['oa.example.com'],
        allowedPorts: [port],
      }),
    ).rejects.toMatchObject({ code: EC.VALIDATION })

    await expect(
      safeGet(`http://localhost:${port}/`, {
        allowPrivateNetwork: true,
        privateNetworkHosts: ['localhost'],
        allowedPorts: [port],
      }),
    ).rejects.toMatchObject({ code: EC.VALIDATION })
  })

  it('响应超过上限立即失败', async () => {
    const { port } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('x'.repeat(100_000))
    })

    await expect(
      safeGet(`http://127.0.0.1:${port}/`, {
        allowPrivateNetwork: true,
        allowedPorts: [port],
        maxBytes: 64 * 1024,
      }),
    ).rejects.toMatchObject({ code: EC.UPSTREAM })
  })

  it('重定向循环会被识别', async () => {
    const { port } = await startServer((_req, res) => {
      res.writeHead(302, { location: '/' })
      res.end()
    })

    await expect(
      safeGet(`http://127.0.0.1:${port}/`, {
        allowPrivateNetwork: true,
        allowedPorts: [port],
      }),
    ).rejects.toMatchObject({ code: EC.UPSTREAM, message: expect.stringContaining('循环') })
  })

  it('域名白名单和黑名单都生效', async () => {
    await expect(
      safeGet('https://example.com/', {}, { EAB_WEB_DENIED_DOMAINS: 'example.com' } as NodeJS.ProcessEnv),
    ).rejects.toMatchObject({ code: EC.VALIDATION })
    await expect(
      safeGet('https://example.com/', {}, { EAB_WEB_ALLOWED_DOMAINS: 'gov.cn' } as NodeJS.ProcessEnv),
    ).rejects.toMatchObject({ code: EC.VALIDATION })
  })

  it('NO_PROXY 命中域名后缀、端口和通配符时不走代理', () => {
    const proxy = 'http://127.0.0.1:7890'
    expect(proxyForUrl('https://www.example.com/a', { EAB_HTTP_PROXY: proxy, EAB_NO_PROXY: 'example.com' })).toBeNull()
    expect(proxyForUrl('https://www.example.com/a', { EAB_HTTP_PROXY: proxy, NO_PROXY: '.example.com' })).toBeNull()
    expect(proxyForUrl('https://example.com/a', { EAB_HTTP_PROXY: proxy, EAB_NO_PROXY: '*' })).toBeNull()
    expect(
      proxyForUrl('https://example.com:443/a', { EAB_HTTP_PROXY: proxy, EAB_NO_PROXY: 'example.com:8443' }),
    ).not.toBeNull()
    expect(proxyForUrl('https://other.test/a', { EAB_HTTP_PROXY: proxy, EAB_NO_PROXY: 'example.com' })).not.toBeNull()
  })

  it('代理配置支持无协议前缀、标准环境变量和鉴权地址', () => {
    expect(proxyForUrl('https://example.com/', { EAB_HTTP_PROXY: '127.0.0.1:7890' })?.href).toBe(
      'http://127.0.0.1:7890/',
    )
    expect(proxyForUrl('https://example.com/', { HTTPS_PROXY: 'http://proxy.test:8080' })?.hostname).toBe('proxy.test')
    expect(
      proxyForUrl('https://example.com/', { EAB_HTTP_PROXY: 'http://user:pass@proxy.test:8080' })?.username,
    ).toBe('user')
  })

  it('无效代理地址在出网前报配置错误', () => {
    expect(() => proxyForUrl('https://example.com/', { EAB_HTTP_PROXY: 'socks5://127.0.0.1:1080' })).toThrow(
      /只支持 http\/https/,
    )
    expect(() => proxyForUrl('https://example.com/', { EAB_HTTP_PROXY: 'http://' })).toThrow(/不是有效地址/)
  })

  it('HTTP 目标通过代理发送 absolute-form 请求并返回内容', async () => {
    let seenUrl = ''
    const { port, calls } = await startServer((req, res) => {
      seenUrl = String(req.url ?? '')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><body><p>proxy ok</p></body></html>')
    })

    const response = await safeGet(
      'http://93.184.216.34/proxy-path?q=1',
      {},
      {
        EAB_HTTP_PROXY: `http://127.0.0.1:${port}`,
        EAB_NO_PROXY: '',
      } as NodeJS.ProcessEnv,
    )
    expect(response.status).toBe(200)
    expect(response.body.toString('utf8')).toContain('proxy ok')
    expect(calls()).toBe(1)
    expect(seenUrl).toBe('http://93.184.216.34/proxy-path?q=1')
  })

  it('搜索 provider 的 JSON POST 也走同一个代理', async () => {
    let seenUrl = ''
    let seenBody = ''
    const { port, calls } = await startServer((req, res) => {
      seenUrl = String(req.url ?? '')
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        seenBody = Buffer.concat(chunks).toString('utf8')
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ results: [{ title: '代理命中' }] }))
      })
    })

    const data = (await fetchJson(
      'http://93.184.216.34/api/search',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ q: 'eab' }),
      },
      { EAB_HTTP_PROXY: `http://127.0.0.1:${port}`, EAB_NO_PROXY: '' } as NodeJS.ProcessEnv,
    )) as { results: Array<{ title: string }> }
    expect(data.results[0].title).toBe('代理命中')
    expect(calls()).toBe(1)
    expect(seenUrl).toBe('http://93.184.216.34/api/search')
    expect(JSON.parse(seenBody)).toEqual({ q: 'eab' })
  })
})
