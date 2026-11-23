import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase, migrate, type Db } from '@eab/storage'
import { SC } from '@eab/domain'
import {
  buildMcpCatalog,
  createMcpServer,
  deleteMcpServer,
  getMcpServer,
  listMcpCatalogView,
  mcpToolSpecsFor,
  resolveMcpToolForActor,
  syncMcpServer,
  executeMcpToolForActor,
  mcpToolFunctionName,
} from '../src/mcp-registry.js'
import { resolveSecret } from '../src/secrets.js'

interface Fixture {
  db: Db
  dbPath: string
  dir: string
  endpoint: string
  received: Array<Record<string, unknown>>
  close: () => Promise<void>
}

const fixtures: Fixture[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.close()
    fixture.db.close()
    rmSync(fixture.dir, { recursive: true, force: true })
  }
})

async function makeFixture(behavior: 'normal' | 'failure' = 'normal'): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'eab-mcp-'))
  const dbPath = join(dir, 'test.db')
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  db.prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('c1', '测试公司', 'mcp-registry', 'active', Date.now())
  const received: Array<Record<string, unknown>> = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const message = JSON.parse(body) as Record<string, unknown>
    received.push(message)
    if (behavior === 'failure' && message.method !== 'initialize') {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('boom')
      return
    }
    if (message.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26', capabilities: {} } }))
      return
    }
    if (message.method === 'notifications/initialized') {
      res.writeHead(202)
      res.end()
      return
    }
    const respond = (result: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    }
    if (message.method === 'tools/list') {
      respond({
        tools: [
          {
            name: 'docs.search',
            description: 'Search company docs',
            inputSchema: {
              type: 'object',
              properties: { query: { type: 'string', description: 'query' } },
              required: ['query'],
            },
            annotations: { readOnlyHint: true },
          },
          {
            name: 'docs.update',
            description: 'Update a doc',
            inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
            annotations: { readOnlyHint: false },
          },
          {
            name: 'docs.delete',
            description: 'Delete a doc',
            inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
            annotations: { readOnlyHint: true, destructiveHint: true },
          },
        ],
      })
      return
    }
    if (message.method === 'tools/call') {
      const params = message.params as { name?: string; arguments?: Record<string, unknown> }
      respond({ content: [{ type: 'text', text: `called ${params.name}:${String(params.arguments?.query ?? '')}` }] })
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('mock MCP server did not bind')
  const fixture: Fixture = {
    db,
    dbPath,
    dir,
    endpoint: `http://127.0.0.1:${address.port}/mcp`,
    received,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
  fixtures.push(fixture)
  return fixture
}

function actor() {
  return {
    subject: {
      companyId: 'c1',
      userId: 'u1',
      scopes: new Set([SC.AGENT_TOOL_INVOKE]),
      roles: ['employee'],
    },
  }
}

describe('MCP 注册表与工具目录', () => {
  it('同名 Server 和中文工具名生成稳定、互不冲突且不超过 64 字符的 function 名', () => {
    const first = mcpToolFunctionName('文档中心', '查询.制度', 'server-a')
    const second = mcpToolFunctionName('文档中心', '查询.制度', 'server-b')
    expect(first).not.toBe(second)
    expect(first.length).toBeLessThanOrEqual(64)
    expect(mcpToolFunctionName('文档中心', '查询.制度', 'server-a')).toBe(first)
  })

  it('同步后只启用 readOnly 工具，破坏性和写工具留在目录但不可调用', async () => {
    const fixture = await makeFixture()
    const created = createMcpServer(fixture.db, fixture.dbPath, 'c1', 'u1', {
      name: 'Docs Hub',
      transport: 'http',
      endpoint: fixture.endpoint,
      allowedTools: ['docs.search', 'docs.update'],
    })
    const outcome = await syncMcpServer(fixture.db, fixture.dbPath, 'c1', created.id)
    expect(outcome).toMatchObject({ ok: true, toolCount: 3, readOnlyToolCount: 1 })
    const view = listMcpCatalogView(fixture.db, fixture.dbPath, 'c1')[0]
    expect(view.secretConfigured).toBe(false)
    expect(view.tools.map((tool) => [tool.name, tool.enabled, tool.readOnly, tool.destructive])).toEqual([
      ['docs.delete', false, true, true],
      ['docs.search', true, true, false],
      ['docs.update', false, false, false],
    ])
    const catalog = buildMcpCatalog(fixture.db, 'c1', actor())
    expect(catalog).toHaveLength(1)
    expect(catalog[0].functionName).toBe(mcpToolFunctionName('Docs Hub', 'docs.search', created.id))
    expect(catalog[0].toolId).toBe(`mcp:${created.id}:docs.search`)
    expect(catalog[0].spec.function.parameters.required).toEqual(['query'])
  })

  it('白名单和停用状态会从模型工具目录里同步隐藏', async () => {
    const fixture = await makeFixture()
    const created = createMcpServer(fixture.db, fixture.dbPath, 'c1', 'u1', {
      name: 'Docs Hub',
      transport: 'http',
      endpoint: fixture.endpoint,
    })
    await syncMcpServer(fixture.db, fixture.dbPath, 'c1', created.id)
    expect(mcpToolSpecsFor(fixture.db, actor())).toHaveLength(1)

    fixture.db.prepare('UPDATE mcp_servers SET enabled = 0, health = ? WHERE id = ?').run('offline', created.id)
    expect(mcpToolSpecsFor(fixture.db, actor())).toEqual([])
  })

  it('调用只读工具并回写成功健康状态；跨公司不可见', async () => {
    const fixture = await makeFixture()
    const created = createMcpServer(fixture.db, fixture.dbPath, 'c1', 'u1', {
      name: 'Docs Hub',
      transport: 'http',
      endpoint: fixture.endpoint,
      secret: 'token-1',
    })
    await syncMcpServer(fixture.db, fixture.dbPath, 'c1', created.id)
    expect(resolveSecret(fixture.dbPath, created.secretRef)).toBe('token-1')
    const entry = resolveMcpToolForActor(fixture.db, actor(), mcpToolFunctionName('Docs Hub', 'docs.search', created.id))
    expect(entry).not.toBeNull()
    const result = await executeMcpToolForActor({
      db: fixture.db,
      dbPath: fixture.dbPath,
      actor: actor(),
      functionName: mcpToolFunctionName('Docs Hub', 'docs.search', created.id),
      args: { query: 'sop' },
      timeoutMs: 5_000,
    })
    expect(result).toMatchObject({ content: [{ type: 'text', text: 'called docs.search:sop' }] })
    expect(getMcpServer(fixture.db, 'c1', created.id)).toMatchObject({
      health: 'healthy',
      failureCount: 0,
      secretRef: created.secretRef,
    })
    expect(buildMcpCatalog(fixture.db, 'c2', actor())).toEqual([])
  })

  it('连续 3 次调用失败后熔断 60 秒，并从工具目录隐藏', async () => {
    const fixture = await makeFixture('normal')
    const created = createMcpServer(fixture.db, fixture.dbPath, 'c1', 'u1', {
      name: 'Docs Hub',
      transport: 'http',
      endpoint: fixture.endpoint,
    })
    await syncMcpServer(fixture.db, fixture.dbPath, 'c1', created.id)
    await fixture.close()
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(executeMcpToolForActor({
        db: fixture.db,
        dbPath: fixture.dbPath,
        actor: actor(),
        functionName: mcpToolFunctionName('Docs Hub', 'docs.search', created.id),
        args: { query: 'x' },
        timeoutMs: 2_000,
      })).rejects.toThrow(/MCP Server/)
    }
    const server = getMcpServer(fixture.db, 'c1', created.id)
    expect(server?.failureCount).toBe(3)
    expect(server?.health).toBe('degraded')
    expect(server?.cooldownUntil).toBeGreaterThan(Date.now())
    expect(mcpToolSpecsFor(fixture.db, actor())).toEqual([])
  })

  it('删除 Server 同时删除工具和密钥', async () => {
    const fixture = await makeFixture()
    const created = createMcpServer(fixture.db, fixture.dbPath, 'c1', 'u1', {
      name: 'Docs Hub',
      transport: 'http',
      endpoint: fixture.endpoint,
      secret: 'token-2',
    })
    await syncMcpServer(fixture.db, fixture.dbPath, 'c1', created.id)
    deleteMcpServer(fixture.db, fixture.dbPath, 'c1', created.id)
    expect(listMcpCatalogView(fixture.db, fixture.dbPath, 'c1')).toEqual([])
    expect(resolveSecret(fixture.dbPath, created.secretRef)).toBe('')
  })
})
