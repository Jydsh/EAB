import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { callMcpTool, listMcpTools } from '../src/mcp-client.js'

interface Received {
  method: string
  headers: IncomingMessage['headers']
  body: Record<string, unknown>
}

const servers: Array<ReturnType<typeof createServer>> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })))
})

async function startServer(
  handler: (message: Record<string, unknown>, res: ServerResponse) => void | Promise<void>,
): Promise<{ endpoint: string; received: Received[] }> {
  const received: Received[] = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const parsed = JSON.parse(body) as Record<string, unknown>
    received.push({ method: String(parsed.method ?? ''), headers: req.headers, body: parsed })
    await handler(parsed, res)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('mock server did not bind')
  return { endpoint: `http://127.0.0.1:${address.port}/mcp`, received }
}

function json(res: ServerResponse, payload: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function sse(res: ServerResponse, payload: unknown): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`)
}

describe('MCP JSON-RPC 客户端', () => {
  it('完成 initialize、initialized 通知、tools/list，并回传 session 和鉴权头', async () => {
    const { endpoint, received } = await startServer((message, res) => {
      if (message.method === 'initialize') {
        res.setHeader('mcp-session-id', 'sess-1')
        json(res, {
          jsonrpc: '2.0',
          id: message.id,
          result: { protocolVersion: '2025-03-26', serverInfo: { name: 'mock' }, capabilities: { tools: {} } },
        })
        return
      }
      if (message.method === 'notifications/initialized') {
        res.writeHead(202)
        res.end()
        return
      }
      if (message.method === 'tools/list') {
        json(res, {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            tools: [
              { name: 'search', description: 'search docs', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, annotations: { readOnlyHint: true } },
              { name: 'delete', description: 'delete docs', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } },
            ],
          },
        })
      }
    })
    const result = await listMcpTools({
      endpoint,
      transport: 'http',
      headers: { authorization: 'Bearer token-1' },
      timeoutMs: 5_000,
    })
    expect(result.initialized.sessionId).toBe('sess-1')
    expect(result.tools.map((tool) => tool.name)).toEqual(['search', 'delete'])
    expect(received.map((item) => item.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list'])
    expect(received[0].headers.authorization).toBe('Bearer token-1')
    expect(received[2].headers['mcp-session-id']).toBe('sess-1')
    expect(received[0].body.jsonrpc).toBe('2.0')
  })

    it('解析 SSE 事件和 nextCursor 分页', async () => {
    let listPage = 0
    const { endpoint } = await startServer((message, res) => {
      if (message.method === 'initialize') {
        sse(res, { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26', capabilities: {} } })
        return
      }
      if (message.method === 'notifications/initialized') {
        res.writeHead(202)
        res.end()
        return
      }
      if (message.method === 'tools/list') {
        listPage += 1
        sse(res, {
          jsonrpc: '2.0',
          id: message.id,
          result: listPage === 1
            ? { tools: [{ name: 'a', inputSchema: {}, annotations: { readOnlyHint: true } }], nextCursor: 'p2' }
            : { tools: [{ name: 'b', inputSchema: {}, annotations: { readOnlyHint: true } }] },
        })
      }
    })
    const result = await listMcpTools({ endpoint, transport: 'sse', timeoutMs: 5_000 })
    expect(result.tools.map((tool) => tool.name)).toEqual(['a', 'b'])
  })

  it('把 JSON-RPC error 转成可读错误，并调用 tools/call', async () => {
    let called = false
    const { endpoint } = await startServer((message, res) => {
      if (message.method === 'initialize') {
        json(res, { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26', capabilities: {} } })
        return
      }
      if (message.method === 'notifications/initialized') {
        res.writeHead(202)
        res.end()
        return
      }
      if (message.method === 'tools/call') {
        called = true
        json(res, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'ok' }] } })
      }
    })
    const result = await callMcpTool({ endpoint, transport: 'http', timeoutMs: 5_000 }, 'echo', { text: 'hi' })
    expect(called).toBe(true)
    expect(result.result).toMatchObject({ content: [{ type: 'text', text: 'ok' }] })

    const broken = await startServer((message, res) => {
      json(res, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } })
    })
    await expect(listMcpTools({ endpoint: broken.endpoint, transport: 'http', timeoutMs: 5_000 }))
      .rejects.toThrow(/method not found/)
  })
})
