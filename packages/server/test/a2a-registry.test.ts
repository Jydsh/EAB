import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrate, openDatabase, type Db } from '@eab/storage'
import { SC } from '@eab/domain'
import { listAgentCards } from '../src/agent-capability-registry.js'
import { resolveSecret } from '../src/secrets.js'
import {
  a2aPeerBrief,
  cancelA2ADelegation,
  createA2APeer,
  delegateA2ATask,
  hasUsableA2APeers,
  listA2APeers,
  listA2APeerViews,
  listA2ATasks,
  syncA2APeer,
} from '../src/a2a-registry.js'

interface Fixture {
  db: Db
  dbPath: string
  dir: string
  endpoint: string
  received: Array<{ method: string; headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }>
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

async function makeFixture(cardStatus = 200): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'eab-a2a-'))
  const dbPath = join(dir, 'test.db')
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  const now = Date.now()
  db.prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('c1', '测试公司', 'a2a-registry', 'active', now)
  db.prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('c2', '另一公司', 'a2a-registry-2', 'active', now)
  const received: Fixture['received'] = []
  let lastTaskId = 'remote-task-1'
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const parsed = body ? JSON.parse(body) as Record<string, unknown> : {}
    received.push({ method: String(parsed.method ?? req.method ?? ''), headers: req.headers, body: parsed })
    if (req.method === 'GET') {
      if (cardStatus !== 200) {
        res.writeHead(cardStatus, { 'content-type': 'text/plain' })
        res.end('card down')
        return
      }
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
          { id: 'travel.plan', name: '行程规划', description: '按预算规划行程', tags: ['travel'] },
          { id: 'travel.book', name: '票务预订', description: '订机票' },
        ],
      }))
      return
    }
    const method = String(parsed.method ?? '')
    const id = parsed.id
    const reply = (result: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }))
    }
    if (method === 'message/send') {
      const params = (parsed.params ?? {}) as Record<string, unknown>
      const message = params.message as Record<string, unknown> | undefined
      const parts = Array.isArray(message?.parts) ? message.parts as Array<Record<string, unknown>> : []
      const prompt = parts.filter((part) => part.kind === 'text').map((part) => String(part.text ?? '')).join('\n')
      lastTaskId = prompt.includes('pause') ? 'remote-pause' : prompt.includes('wait') ? 'remote-input' : 'remote-task-1'
      reply({
        id: lastTaskId,
        contextId: 'ctx-1',
        status: { state: 'working', message: { role: 'agent', messageId: 'm-1', parts: [{ kind: 'text', text: '正在规划' }] } },
        artifacts: [],
      })
      return
    }
    if (method === 'tasks/get') {
      if (lastTaskId === 'remote-input') {
        reply({
          id: 'remote-input',
          contextId: 'ctx-1',
          status: {
            state: 'input-required',
            message: { role: 'agent', messageId: 'm-q', parts: [{ kind: 'text', text: '请补充出发日期' }] },
          },
          artifacts: [],
        })
        return
      }
      reply({
        id: 'remote-task-1',
        contextId: 'ctx-1',
        status: { state: 'completed', message: { role: 'agent', messageId: 'm-2', parts: [{ kind: 'text', text: '已订好东京行程' }] } },
        artifacts: [
          {
            artifactId: 'art-1',
            name: '行程单',
            parts: [{ kind: 'file', file: { name: 'itinerary.pdf', mimeType: 'application/pdf', uri: 'https://example.com/itinerary.pdf' } }],
          },
        ],
      })
      return
    }
    if (method === 'tasks/cancel') {
      reply({ id: 'remote-task-1', contextId: 'ctx-1', status: { state: 'canceled' }, artifacts: [] })
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('mock A2A server did not bind')
  received.push({ method: 'LISTEN', headers: {}, body: { port: address.port } })
  const fixture: Fixture = {
    db,
    dbPath,
    dir,
    endpoint: `http://127.0.0.1:${address.port}/a2a`,
    received,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
  fixtures.push(fixture)
  return fixture
}

function actor(companyId = 'c1') {
  return {
    subject: {
      companyId,
      userId: 'u1',
      scopes: new Set([SC.AGENT_TOOL_INVOKE]),
      roles: ['employee'],
    },
  }
}

describe('A2A 注册表与出站派遣', () => {
  it('同步 Agent Card 后把远端卡并入能力卡，白名单技能才可派遣', async () => {
    const fixture = await makeFixture()
    const created = createA2APeer(fixture.db, fixture.dbPath, 'c1', 'u1', {
      name: '旅行 Agent',
      endpoint: fixture.endpoint,
      authType: 'bearer',
      secret: 'a2a-token',
      allowedSkills: ['travel.plan'],
    })
    expect(created.health).toBe('unknown')
    expect(resolveSecret(fixture.dbPath, created.secretRef)).toBe('a2a-token')
    const sync = await syncA2APeer(fixture.db, fixture.dbPath, 'c1', created.id)
    expect(sync).toEqual({ ok: true, skillCount: 1, error: '' })
    const views = listA2APeerViews(fixture.db, fixture.dbPath, 'c1')
    expect(views[0]).toMatchObject({
      name: '旅行 Agent',
      health: 'healthy',
      secretConfigured: true,
      effectiveSkills: ['行程规划（travel.plan）'],
    })
    const cards = listAgentCards(fixture.db, 'c1')
    expect(cards.find((card) => card.kind === 'a2a')).toMatchObject({
      agentKey: `a2a:${created.id}`,
      name: '旅行规划员',
      skills: ['行程规划'],
      health: 'healthy',
      enabled: true,
    })
    expect(hasUsableA2APeers(fixture.db, 'c1')).toBe(true)
    expect(a2aPeerBrief(fixture.db, 'c1')).toContain(`peer=${created.id}`)
    expect(listA2APeers(fixture.db, 'c2')).toEqual([])
  })

  it('委派必须显式指定白名单技能，完成后回写 Task 摘要和 A2A 产物引用', async () => {
    const fixture = await makeFixture()
    const created = createA2APeer(fixture.db, fixture.dbPath, 'c1', 'u1', {
      name: '旅行 Agent',
      endpoint: fixture.endpoint,
      allowedSkills: ['travel.plan', 'travel.book'],
    })
    await syncA2APeer(fixture.db, fixture.dbPath, 'c1', created.id)
    await expect(delegateA2ATask({
      db: fixture.db,
      dbPath: fixture.dbPath,
      actor: actor(),
      peer: created.id,
      prompt: '规划东京三日',
    })).rejects.toThrow(/skill 必须指定/)

    const result = await delegateA2ATask({
      db: fixture.db,
      dbPath: fixture.dbPath,
      actor: actor(),
      peer: `a2a:${created.id}`,
      prompt: '规划东京三日',
      skill: 'travel.plan',
      traceId: 'trace-1',
      timeoutMs: 5_000,
      pollIntervalMs: 100,
    })
    expect(result).toMatchObject({
      status: 'completed',
      peerId: created.id,
      traceId: 'trace-1',
      remoteTaskId: 'remote-task-1',
      contextId: 'ctx-1',
    })
    expect(result.text).toContain('已订好东京行程')
    expect(result.artifacts[0]).toMatchObject({
      source: 'a2a',
      name: '行程单',
      mimeType: 'application/pdf',
      size: 0,
      uri: 'https://example.com/itinerary.pdf',
    })
    expect(result.artifacts[0].checksum).toMatch(/^ref-sha256:/)
    expect(result.artifacts[0].preview).toContain('application/pdf')
    expect(result.artifacts[0].preview).toContain('有下载地址')
    const task = listA2ATasks(fixture.db, 'c1')[0]
    expect(task).toMatchObject({ state: 'completed', traceId: 'trace-1', skillId: 'travel.plan' })
    const sent = fixture.received.find((item) => item.method === 'message/send')
    expect(sent?.body).toMatchObject({
      jsonrpc: '2.0',
      params: { metadata: { skillId: 'travel.plan', eabTraceId: 'trace-1' } },
    })
  })

  it('远端 input-required 会立即返回，等待用户补充而不是空转', async () => {
    const fixture = await makeFixture()
    const created = createA2APeer(fixture.db, fixture.dbPath, 'c1', 'u1', {
      name: '旅行 Agent',
      endpoint: fixture.endpoint,
      allowedSkills: ['travel.plan'],
    })
    await syncA2APeer(fixture.db, fixture.dbPath, 'c1', created.id)
    const result = await delegateA2ATask({
      db: fixture.db,
      dbPath: fixture.dbPath,
      actor: actor(),
      peer: created.id,
      prompt: 'wait 规划东京',
      skill: 'travel.plan',
      timeoutMs: 5_000,
      pollIntervalMs: 100,
    })
    expect(result.status).toBe('input-required')
    expect(result.text).toContain('请补充出发日期')
    expect(result.hint).toContain('等输入')
  })

  it('同步失败保留旧卡状态、标记 degraded，并从可用目录隐藏', async () => {
    const fixture = await makeFixture(500)
    const created = createA2APeer(fixture.db, fixture.dbPath, 'c1', 'u1', {
      name: '旅行 Agent',
      endpoint: fixture.endpoint,
    })
    const sync = await syncA2APeer(fixture.db, fixture.dbPath, 'c1', created.id)
    expect(sync.ok).toBe(false)
    expect(listA2APeerViews(fixture.db, fixture.dbPath, 'c1')[0]).toMatchObject({
      health: 'degraded',
      failureCount: 1,
    })
    expect(hasUsableA2APeers(fixture.db, 'c1')).toBe(false)
    expect(listAgentCards(fixture.db, 'c1').some((card) => card.kind === 'a2a')).toBe(false)
  })

  it('按本地 delegationId 取消远端任务，并把状态收敛为 canceled', async () => {
    const fixture = await makeFixture()
    const created = createA2APeer(fixture.db, fixture.dbPath, 'c1', 'u1', {
      name: '旅行 Agent',
      endpoint: fixture.endpoint,
      allowedSkills: ['travel.plan'],
    })
    await syncA2APeer(fixture.db, fixture.dbPath, 'c1', created.id)
    const now = Date.now()
    fixture.db.prepare(`
      INSERT INTO a2a_tasks
        (id, company_id, user_id, peer_id, peer_name, remote_task_id, remote_context_id,
         context_id, trace_id, skill_id, state, prompt, result_text, error, artifacts_json,
         created_at, updated_at, finished_at)
      VALUES ('deleg-1', 'c1', 'u1', ?, '旅行 Agent', 'remote-task-1', 'ctx-1',
              'ctx-1', 'trace-1', 'travel.plan', 'working', 'pause', '', '', '[]', ?, ?, NULL)
    `).run(created.id, now, now)
    const result = await cancelA2ADelegation({
      db: fixture.db,
      dbPath: fixture.dbPath,
      actor: actor(),
      delegationId: 'deleg-1',
      timeoutMs: 5_000,
    })
    expect(result.status).toBe('canceled')
    expect(listA2ATasks(fixture.db, 'c1')[0].state).toBe('canceled')
  })

  it('轻量数据库缺少 A2A 表时目录按空处理', () => {
    const db = openDatabase({ path: ':memory:' })
    try {
      expect(listA2APeers(db, 'c1')).toEqual([])
      expect(hasUsableA2APeers(db, 'c1')).toBe(false)
    } finally {
      db.close()
    }
  })
})
