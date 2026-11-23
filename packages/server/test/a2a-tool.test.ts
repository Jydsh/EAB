import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrate, openDatabase, type Db } from '@eab/storage'
import { SC } from '@eab/domain'
import { createA2APeer, listA2ATasks, syncA2APeer } from '../src/a2a-registry.js'
import { executeTool, toolSpecsForAgent } from '../src/routes/tools.js'

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const item of cleanup.splice(0).reverse()) await item()
})

async function makeFixture(): Promise<{ db: Db; dbPath: string; dir: string; endpoint: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'eab-a2a-tool-'))
  const dbPath = join(dir, 'eab.sqlite')
  const db = openDatabase({ path: dbPath })
  migrate(db)
  const now = Date.now()
  db.prepare("INSERT INTO companies (id, name, slug, status, created_at) VALUES ('c1', '测试公司', 'a2a-tool', 'active', ?)").run(now)
  db.prepare("INSERT INTO departments (id, company_id, name, path, depth, order_no, created_at) VALUES ('d1', 'c1', '测试部门', '/d1', 0, 0, ?)").run(now)
  db.prepare("INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at) VALUES ('u1', 'c1', 'd1', '/d1', '测试员工', 'active', ?, ?)").run(now, now)
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    if (req.method === 'GET') {
      const address = server.address()
      const port = address && typeof address !== 'string' ? address.port : 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        protocolVersion: '0.2.6',
        name: '交付 Agent',
        url: `http://127.0.0.1:${port}/a2a`,
        version: '1',
        skills: [{ id: 'report.write', name: '报告撰写' }],
      }))
      return
    }
    const message = JSON.parse(body) as Record<string, unknown>
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        id: 'remote-1',
        contextId: 'ctx-1',
        status: {
          state: 'completed',
          message: { role: 'agent', messageId: 'm-1', parts: [{ kind: 'text', text: '报告已完成' }] },
        },
        artifacts: [],
      },
    }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('mock A2A server did not bind')
  cleanup.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { db, dbPath, dir, endpoint: `http://127.0.0.1:${address.port}/a2a` }
}

function actor() {
  return {
    subject: {
      companyId: 'c1',
      userId: 'u1',
      status: 'active' as const,
      deptId: 'd1',
      deptPath: '/d1',
      deptChain: [],
      roles: [],
      scopes: new Set(Object.values(SC)),
      dataScope: 'global' as const,
      channelType: 'web' as const,
      projectIds: [],
    },
    person: { id: 'u1', name: '测试员工', title: null, avatar: null, deptId: 'd1', deptPath: '/d1', deptName: '测试部门', companyId: 'c1', companyName: '测试公司' },
  }
}

describe('A2A 工具目录与执行入口', () => {
  it('有可用 Peer 时主 Agent 直接拿到 a2a_delegate；执行后沿 traceId 落任务映射', async () => {
    const fixture = await makeFixture()
    const deps = { db: fixture.db, config: { dbPath: fixture.dbPath }, companyId: 'c1' } as any
    const me = actor()
    expect(toolSpecsForAgent(fixture.db, me).some((tool) => tool.function.name === 'a2a_delegate')).toBe(false)
    const peer = createA2APeer(fixture.db, fixture.dbPath, 'c1', 'u1', {
      name: '交付 Agent',
      endpoint: fixture.endpoint,
      allowedSkills: ['report.write'],
    })
    await syncA2APeer(fixture.db, fixture.dbPath, 'c1', peer.id)
    expect(toolSpecsForAgent(fixture.db, me).some((tool) => tool.function.name === 'a2a_delegate')).toBe(true)

    const result = await executeTool(
      deps,
      me,
      'a2a.delegate',
      { peer: peer.id, prompt: '写一份周报', skill: 'report.write', timeoutSeconds: 5 },
      { kind: 'cloud' },
      { sessionId: 's1', turnId: 't1', traceId: 'trace-tool' },
    ) as { status: string; text: string; delegationId: string }
    expect(result).toMatchObject({ status: 'completed', text: '报告已完成' })
    expect(listA2ATasks(fixture.db, 'c1')[0]).toMatchObject({
      id: result.delegationId,
      state: 'completed',
      traceId: 'trace-tool',
      skillId: 'report.write',
    })
  })
})
