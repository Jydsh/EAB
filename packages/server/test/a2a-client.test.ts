import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import {
  a2aCardUrl,
  cancelA2ATask,
  fetchA2AAgentCard,
  getA2ATask,
  normalizeA2AEndpoint,
  sendA2AMessage,
  summarizeA2ATask,
} from '../src/a2a-client.js'

const servers: Array<ReturnType<typeof createServer>> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })))
})

interface Received {
  method: string
  headers: Record<string, string | string[] | undefined>
  body: Record<string, unknown> | null
  url: string
}

async function startA2A(): Promise<{ endpoint: string; received: Received[]; base: string }> {
  const received: Received[] = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const parsed = body ? JSON.parse(body) as Record<string, unknown> : null
    received.push({ method: String(parsed?.method ?? req.method ?? ''), headers: req.headers, body: parsed, url: req.url ?? '' })
    if (req.method === 'GET' && req.url === '/.well-known/agent.json') {
      const address = server.address()
      const port = address && typeof address !== 'string' ? address.port : 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        protocolVersion: '0.2.6',
        name: '旅行规划员',
        description: '规划差旅并订票',
        url: `http://127.0.0.1:${port}/a2a`,
        version: '1.2',
        capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: true },
        skills: [
          {
            id: 'travel.plan',
            name: '行程规划',
            description: '按预算规划行程',
            tags: ['travel'],
            examples: ['规划东京三日'],
            inputModes: ['text/plain'],
            outputModes: ['text/plain', 'application/json'],
          },
          { id: 'travel.book', name: '票务预订', description: '订机票' },
        ],
      }))
      return
    }
    if (req.method === 'POST' && req.url === '/a2a') {
      const method = String(parsed?.method ?? '')
      const id = parsed?.id
      if (method === 'message/send') {
        const textPart = (parsed?.params as { message?: { parts?: Array<{ text?: string }> } } | undefined)?.message?.parts?.[0]?.text ?? ''
        if (textPart.includes('触发错误')) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'remote exploded' } }))
          return
        }
        if (textPart.includes('SSE')) {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.end(`data: ${JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: {
              id: 'remote-task-sse',
              contextId: 'ctx-sse',
              status: { state: 'completed' },
              artifacts: [],
            },
          })}\n\n`)
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            id: 'remote-task-1',
            contextId: 'ctx-1',
            status: {
              state: 'working',
              message: {
                role: 'agent',
                messageId: 'm-1',
                parts: [{ kind: 'text', text: '正在规划' }],
              },
            },
            artifacts: [],
          },
        }))
        return
      }
      if (method === 'tasks/get') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            id: 'remote-task-1',
            contextId: 'ctx-1',
            status: {
              state: 'completed',
              message: { role: 'agent', messageId: 'm-2', parts: [{ kind: 'text', text: '已订好东京行程' }] },
            },
            artifacts: [
              {
                artifactId: 'art-1',
                name: '行程单',
                parts: [{ kind: 'file', file: { name: 'itinerary.pdf', mimeType: 'application/pdf', uri: 'https://example.com/itinerary.pdf' } }],
              },
            ],
          },
        }))
        return
      }
      if (method === 'tasks/cancel') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            id: 'remote-task-1',
            contextId: 'ctx-1',
            status: { state: 'canceled' },
            artifacts: [],
          },
        }))
        return
      }
    }
    res.writeHead(404)
    res.end('not found')
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('mock A2A server did not bind')
  const base = `http://127.0.0.1:${address.port}`
  return { endpoint: `${base}/a2a`, base, received }
}

function target(endpoint: string, extra: Record<string, unknown> = {}) {
  return { endpoint, timeoutMs: 5_000, ...extra }
}

describe('A2A JSON-RPC 客户端', () => {
  it('拉取 Agent Card，并使用 Bearer 鉴权、同源校验和默认卡地址', async () => {
    const { endpoint, received, base } = await startA2A()
    expect(a2aCardUrl(endpoint)).toBe(`${base}/.well-known/agent.json`)
    expect(() => normalizeA2AEndpoint('ftp://example.com/a2a')).toThrow(/http\/https/)
    expect(() => normalizeA2AEndpoint('http://user:pass@example.com/a2a')).toThrow(/账号密码/)
    const card = await fetchA2AAgentCard(target(endpoint, { authType: 'bearer', token: 'token-1' }))
    expect(card).toMatchObject({ name: '旅行规划员', version: '1.2', protocolVersion: '0.2.6' })
    expect(card.skills.map((skill) => skill.id)).toEqual(['travel.plan', 'travel.book'])
    expect(received[0].headers.authorization).toBe('Bearer token-1')
  })

  it('拒绝跨域 Agent Card 和自定义卡地址', async () => {
    const { endpoint } = await startA2A()
    await expect(fetchA2AAgentCard(target(endpoint.replace('127.0.0.1', 'localhost')))).rejects.toThrow()
    expect(() => a2aCardUrl(endpoint, 'https://evil.example/card.json')).toThrow(/同源/)
  })
  it('发送 message/send，并把 Task、Message 和 JSON-RPC error 分开表达', async () => {
    const { endpoint, received } = await startA2A()
    const result = await sendA2AMessage({ target: target(endpoint), text: '规划东京', contextId: 'ctx-old', skillId: 'travel.plan' })
    expect(result.kind).toBe('task')
    expect(result.task?.status.state).toBe('working')
    expect(received.find((item) => item.method === 'message/send')?.body).toMatchObject({
      jsonrpc: '2.0',
      method: 'message/send',
      params: {
        configuration: { blocking: true },
        metadata: { skillId: 'travel.plan' },
      },
    })

    const task = await getA2ATask(target(endpoint), 'remote-task-1')
    expect(task.status.state).toBe('completed')
    expect(task.artifacts[0].parts[0]).toMatchObject({ kind: 'file' })
  })

  it('取消远端任务并返回终端状态', async () => {
    const { endpoint } = await startA2A()
    const task = await cancelA2ATask(target(endpoint), 'remote-task-1')
    expect(task.status.state).toBe('canceled')
  })

  it('把 JSON-RPC error 转成可读失败，不当作空任务', async () => {
    const { endpoint } = await startA2A()
    await expect(sendA2AMessage({ target: target(endpoint), text: '触发错误' }))
      .rejects.toThrow(/remote exploded/)
  })

  it('解析 text/event-stream 响应里的最终 result', async () => {
    const { endpoint } = await startA2A()
    const result = await sendA2AMessage({ target: target(endpoint), text: '走 SSE' })
    expect(result.kind).toBe('task')
    expect(result.task?.id).toBe('remote-task-sse')
    expect(result.task?.status.state).toBe('completed')
  })

  it('A2A 文件产物带 mime、大小、校验和、稳定 uri 和预览', () => {
    const task = {
      id: 'remote-task-preview',
      contextId: 'ctx-preview',
      status: { state: 'completed' as const },
      history: [],
      artifacts: [
        {
          artifactId: 'art-uri',
          name: '行程单',
          parts: [{
            kind: 'file' as const,
            file: { name: 'itinerary.pdf', mimeType: 'application/pdf', uri: 'https://example.com/itinerary.pdf' },
          }],
        },
        {
          artifactId: 'art-bytes',
          name: '说明',
          parts: [{
            kind: 'file' as const,
            file: {
              name: 'notes.txt',
              mimeType: 'text/plain',
              bytes: Buffer.from('# 说明\n\n已订好酒店。').toString('base64'),
            },
          }],
        },
        {
          artifactId: 'art-multi',
          name: '多部分',
          parts: [
            { kind: 'file' as const, file: { name: 'a.txt', mimeType: 'text/plain', uri: 'https://example.com/a.txt' } },
            { kind: 'file' as const, file: { name: 'b.txt', mimeType: 'text/plain', uri: 'https://example.com/b.txt' } },
          ],
        },
      ],
    }
    const summary = summarizeA2ATask(task)
    expect(summary.artifacts).toHaveLength(4)
    expect(summary.artifacts[0]).toMatchObject({
      id: 'art-uri',
      name: '行程单',
      mimeType: 'application/pdf',
      size: 0,
      source: 'a2a',
      uri: 'https://example.com/itinerary.pdf',
    })
    expect(summary.artifacts[0].checksum).toMatch(/^ref-sha256:/)
    expect(summary.artifacts[0].preview).toContain('application/pdf')
    expect(summary.artifacts[0].preview).toContain('有下载地址')

    expect(summary.artifacts[1]).toMatchObject({
      name: '说明',
      mimeType: 'text/plain',
      size: Buffer.from('# 说明\n\n已订好酒店。').length,
    })
    expect(summary.artifacts[1].checksum).toMatch(/^sha256:/)
    expect(summary.artifacts[1].uri).toMatch(/^a2a:artifact\//)
    expect(summary.artifacts[1].preview).toContain('已订好酒店')

    expect(summary.artifacts.slice(2).map((item) => item.id)).toEqual(['art-multi:0', 'art-multi:1'])
  })
})
