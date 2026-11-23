import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { migrate, openDatabase, type Db } from '@eab/storage'
import type { ServerConfig } from '../src/config.js'
import type { ServerDeps } from '../src/deps.js'
import { buildApp } from '../src/app.js'

const state = vi.hoisted(() => ({
  calls: 0,
  failNext: false,
  slowNextMs: 0,
  toolCallNext: false,
}))

vi.mock('../src/llm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm.js')>()
  return {
    ...actual,
    callModelStream: vi.fn(async (
      _db: unknown,
      _path: unknown,
      _company: unknown,
      _model: unknown,
      messages: Array<{ role: string; content: string }>,
      options: { onEvent?: (event: { type: 'content' | 'reasoning'; text: string }) => void },
    ) => {
      state.calls += 1
      if (state.failNext) {
        state.failNext = false
        throw new Error('mock model failure')
      }
      if (state.slowNextMs > 0) {
        const wait = state.slowNextMs
        state.slowNextMs = 0
        await new Promise((resolve) => setTimeout(resolve, wait))
      }
      if (state.toolCallNext) {
        state.toolCallNext = false
        return {
          text: '尝试调用内部工具',
          reasoning: '',
          toolCalls: [{
            id: 'bad-1',
            type: 'function',
            function: {
              name: 'agent_spawn',
              arguments: JSON.stringify({ tasks: [{ key: 'x', title: '越权', prompt: '越权任务' }] }),
            },
          }],
          promptTokens: 3,
          completionTokens: 2,
        }
      }
      const user = messages.filter((message) => message.role === 'user').at(-1)?.content ?? ''
      const text = `已收到：${user}`
      options.onEvent?.({ type: 'content', text })
      return {
        text,
        reasoning: 'mock-secret-cot',
        toolCalls: [],
        promptTokens: 11,
        completionTokens: 7,
      }
    }),
  }
})

const dirs: string[] = []
const handles: Db[] = []
const apps: ReturnType<typeof buildApp>[] = []

const CONSOLE_HEADERS = {
  'x-eab-console': '1',
  'x-eab-console-token': 'test-console-token',
}

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
  for (const db of handles.splice(0)) db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeApps() {
  const dir = mkdtempSync(join(tmpdir(), 'eab-a2a-inbound-'))
  dirs.push(dir)
  const dbPath = join(dir, 'test.db')
  const db = openDatabase({ path: ':memory:' })
  handles.push(db)
  migrate(db)
  const now = Date.now()
  db.prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('c1', '测试公司', 'a2a-inbound', 'active', now)
  db.prepare('INSERT INTO departments (id, company_id, name, path, depth, order_no, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('d1', 'c1', '测试部门', '/c1/d1/', 1, 0, now)
  db.prepare('INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('u1', 'c1', 'd1', '/c1/d1/', '测试员工', 'active', now, now)
  const config = {
    host: '127.0.0.1',
    port: 0,
    adminPort: 0,
    dbPath,
    companyId: 'c1',
    devAuth: true,
    consoleToken: 'test-console-token',
    adminUser: 'admin',
    adminPassword: 'test-admin-password',
    logLevel: 'silent',
    onlyOfficeUrl: '',
    onlyOfficeJwtSecret: '',
    onlyOfficeInternalUrl: '',
    dataDir: dir,
    tmpDir: join(dir, 'tmp'),
    agentWorkerIdleMs: 60_000,
    agentMaxWorkers: 10,
    agentMaxWorkersFromEnv: true,
  } as ServerConfig
  const deps = {
    db,
    config,
    companyId: 'c1',
    migrations: [],
    consoleToken: 'test-console-token',
  } as ServerDeps
  const consoleApp = buildApp(deps, 'console')
  const chatApp = buildApp(deps, 'chat')
  apps.push(consoleApp, chatApp)
  return { db, consoleApp, chatApp }
}

async function setInbound(
  consoleApp: ReturnType<typeof buildApp>,
  patch: Record<string, unknown> = {},
) {
  const rotated = await consoleApp.inject({
    method: 'POST',
    url: '/api/console/a2a/inbound/token',
    headers: CONSOLE_HEADERS,
  })
  const token = (rotated.json() as { data: { token: string } }).data.token
  const updated = await consoleApp.inject({
    method: 'PUT',
    url: '/api/console/a2a/inbound',
    headers: CONSOLE_HEADERS,
    payload: {
      enabled: true,
      allowedSkills: ['eab.answer'],
      publicBaseUrl: 'http://127.0.0.1:8787',
      ...patch,
    },
  })
  return { token, updated }
}

function rpc(method: string, params: Record<string, unknown>, id = 'rpc-1') {
  return { jsonrpc: '2.0', id, method, params }
}

describe('A2A 入站端点', () => {
  it('未启用时能力卡 404，启用后只暴露受限技能且不泄露内部工具', async () => {
    const { consoleApp, chatApp } = makeApps()
    await consoleApp.ready()
    await chatApp.ready()
    const disabled = await chatApp.inject({ method: 'GET', url: '/.well-known/agent.json' })
    expect(disabled.statusCode).toBe(404)
    expect(disabled.body).not.toContain('eab.answer')

    const { updated } = await setInbound(consoleApp)
    expect(updated.statusCode).toBe(200)

    const card = await chatApp.inject({ method: 'GET', url: '/.well-known/agent.json' })
    expect(card.statusCode).toBe(200)
    const payload = card.json() as Record<string, unknown>
    expect(payload.protocolVersion).toBe('0.2.6')
    expect(payload.url).toBe('http://127.0.0.1:8787/a2a')
    expect(payload.security).toEqual([{ bearer: [] }])
    expect(payload.skills).toEqual([
      expect.objectContaining({ id: 'eab.answer' }),
    ])
    expect(JSON.stringify(payload)).not.toContain('workspace')
    expect(JSON.stringify(payload)).not.toContain('agent_spawn')
    expect(JSON.stringify(payload)).not.toContain('系统提示')
  })

  it('Bearer 令牌错误返回 401，正确令牌完成无工具任务并可查询、取消', async () => {
    const { db, consoleApp, chatApp } = makeApps()
    await consoleApp.ready()
    await chatApp.ready()
    state.failNext = false
    const { token } = await setInbound(consoleApp)
    const headers = { authorization: `Bearer ${token}` }

    const unauthorized = await chatApp.inject({
      method: 'POST',
      url: '/a2a',
      headers: { authorization: 'Bearer wrong' },
      payload: rpc('message/send', {
        message: { role: 'user', parts: [{ kind: 'text', text: '你好' }] },
        metadata: { skill: 'eab.answer' },
      }, 'auth-1'),
    })
    expect(unauthorized.statusCode).toBe(401)
    expect(unauthorized.json()).toMatchObject({ id: 'auth-1', error: { code: -32001 } })

    const sent = await chatApp.inject({
      method: 'POST',
      url: '/a2a',
      headers,
      payload: rpc('message/send', {
        message: { role: 'user', parts: [{ kind: 'text', text: '你好' }] },
        metadata: { skill: 'eab.answer' },
      }, 'send-1'),
    })
    expect(sent.statusCode).toBe(200)
    const sentBody = sent.json() as {
      result: {
        kind: string
        id: string
        contextId: string
        status: { state: string; message: { parts: Array<{ text: string }> } }
        metadata: { traceId: string; skill: string }
      }
    }
    expect(sentBody.result.status.state).toBe('completed')
    expect(sentBody.result.status.message.parts[0].text).toBe('已收到：你好')
    expect(sentBody.result.metadata).toMatchObject({ skill: 'eab.answer' })
    expect(JSON.stringify(sentBody)).not.toContain('mock-secret-cot')
    const taskId = sentBody.result.id

    const row = db
      .prepare('SELECT state, result_text, prompt_tokens, completion_tokens FROM a2a_inbound_tasks WHERE id = ?')
      .get(taskId) as { state: string; result_text: string; prompt_tokens: number; completion_tokens: number }
    expect(row).toMatchObject({ state: 'completed', result_text: '已收到：你好', prompt_tokens: 11, completion_tokens: 7 })

    const got = await chatApp.inject({
      method: 'POST',
      url: '/a2a',
      headers,
      payload: rpc('tasks/get', { id: taskId }, 'get-1'),
    })
    expect((got.json() as { result: { status: { state: string } } }).result.status.state).toBe('completed')

    const canceled = await chatApp.inject({
      method: 'POST',
      url: '/a2a',
      headers,
      payload: rpc('tasks/cancel', { id: taskId }, 'cancel-1'),
    })
    expect((canceled.json() as { result: { status: { state: string } } }).result.status.state).toBe('completed')

    const list = await consoleApp.inject({ method: 'GET', url: '/api/console/a2a', headers: CONSOLE_HEADERS })
    const listBody = list.json() as { data: { inboundTasks: Array<{ id: string }> } }
    expect(listBody.data.inboundTasks[0].id).toBe(taskId)
  })

  it('技能不在白名单时返回 JSON-RPC 校验错误，且不创建任务', async () => {
    const { db, consoleApp, chatApp } = makeApps()
    await consoleApp.ready()
    await chatApp.ready()
    const { token } = await setInbound(consoleApp)
    const before = Number((db.prepare('SELECT COUNT(*) AS n FROM a2a_inbound_tasks').get() as { n: number }).n)
    const result = await chatApp.inject({
      method: 'POST',
      url: '/a2a',
      headers: { authorization: `Bearer ${token}` },
      payload: rpc('message/send', {
        message: { role: 'user', parts: [{ kind: 'text', text: '测试' }] },
        metadata: { skill: 'eab.read_workspace' },
      }, 'bad-skill'),
    })
    expect(result.statusCode).toBe(200)
    expect(result.json()).toMatchObject({ id: 'bad-skill', error: { code: -32602 } })
    const after = Number((db.prepare('SELECT COUNT(*) AS n FROM a2a_inbound_tasks').get() as { n: number }).n)
    expect(after).toBe(before)
  })

  it('运行中的任务可取消，message/send 返回 canceled 而不是继续等模型', async () => {
    const { db, consoleApp, chatApp } = makeApps()
    await consoleApp.ready()
    await chatApp.ready()
    const { token } = await setInbound(consoleApp)
    state.slowNextMs = 1200
    const headers = { authorization: `Bearer ${token}` }
    const sendPromise = chatApp.inject({
      method: 'POST',
      url: '/a2a',
      headers,
      payload: rpc('message/send', {
        message: { role: 'user', parts: [{ kind: 'text', text: '慢任务' }] },
        metadata: { skill: 'eab.answer' },
      }, 'slow-1'),
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    const row = db
      .prepare("SELECT id FROM a2a_inbound_tasks WHERE state IN ('submitted', 'working') ORDER BY created_at DESC LIMIT 1")
      .get() as { id: string }
    const canceled = await chatApp.inject({
      method: 'POST',
      url: '/a2a',
      headers,
      payload: rpc('tasks/cancel', { id: row.id }, 'cancel-slow'),
    })
    expect((canceled.json() as { result: { status: { state: string } } }).result.status.state).toBe('canceled')
    const sent = await sendPromise
    expect((sent.json() as { result: { status: { state: string } } }).result.status.state).toBe('canceled')
    await new Promise((resolve) => setTimeout(resolve, 1100))
    const final = db.prepare('SELECT state FROM a2a_inbound_tasks WHERE id = ?').get(row.id) as { state: string }
    expect(final.state).toBe('canceled')
  })

  it('模型即使伪造内部工具调用，也不会派生 Agent 或执行工具', async () => {
    const { db, consoleApp, chatApp } = makeApps()
    await consoleApp.ready()
    await chatApp.ready()
    const { token } = await setInbound(consoleApp)
    state.toolCallNext = true
    const sent = await chatApp.inject({
      method: 'POST',
      url: '/a2a',
      headers: { authorization: `Bearer ${token}` },
      payload: rpc('message/send', {
        message: { role: 'user', parts: [{ kind: 'text', text: '调用工具' }] },
        metadata: { skill: 'eab.answer' },
      }, 'tool-call'),
    })
    expect(sent.statusCode).toBe(200)
    const agents = Number((db.prepare('SELECT COUNT(*) AS n FROM agent_tasks').get() as { n: number }).n)
    const workers = Number((db.prepare('SELECT COUNT(*) AS n FROM agent_workers').get() as { n: number }).n)
    expect(agents).toBe(0)
    expect(workers).toBe(0)
  }, 15_000)

  it('模型失败落 failed，轮换令牌后旧令牌立即失效', async () => {
    const { db, consoleApp, chatApp } = makeApps()
    await consoleApp.ready()
    await chatApp.ready()
    const { token } = await setInbound(consoleApp)
    state.failNext = true
    const failed = await chatApp.inject({
      method: 'POST',
      url: '/a2a',
      headers: { authorization: `Bearer ${token}` },
      payload: rpc('message/send', {
        message: { role: 'user', parts: [{ kind: 'text', text: '失败测试' }] },
        metadata: { skill: 'eab.answer' },
      }, 'fail-1'),
    })
    const failedBody = failed.json() as { result: { id: string; status: { state: string; message: { parts: Array<{ text: string }> } } } }
    expect(failedBody.result.status.state).toBe('failed')
    expect(failedBody.result.status.message.parts[0].text).not.toContain('mock model failure')
    const failedRow = db
      .prepare('SELECT state FROM a2a_inbound_tasks WHERE id = ?')
      .get(failedBody.result.id) as { state: string }
    expect(failedRow.state).toBe('failed')

    const rotated = await consoleApp.inject({
      method: 'POST',
      url: '/api/console/a2a/inbound/token',
      headers: CONSOLE_HEADERS,
    })
    const newToken = (rotated.json() as { data: { token: string } }).data.token
    expect(newToken).not.toBe(token)
    const oldToken = await chatApp.inject({
      method: 'POST',
      url: '/a2a',
      headers: { authorization: `Bearer ${token}` },
      payload: rpc('tasks/get', { id: failedBody.result.id }, 'old-token'),
    })
    expect(oldToken.statusCode).toBe(401)
  })

  it('控制台写入非法对外地址或未生成令牌就启用会被拒绝', async () => {
    const { consoleApp } = makeApps()
    await consoleApp.ready()
    const noToken = await consoleApp.inject({
      method: 'PUT',
      url: '/api/console/a2a/inbound',
      headers: CONSOLE_HEADERS,
      payload: { enabled: true, allowedSkills: ['eab.answer'] },
    })
    expect(noToken.statusCode).toBe(400)
    expect(noToken.json()).toMatchObject({ ok: false })

    await consoleApp.inject({
      method: 'POST',
      url: '/api/console/a2a/inbound/token',
      headers: CONSOLE_HEADERS,
    })
    const badUrl = await consoleApp.inject({
      method: 'PUT',
      url: '/api/console/a2a/inbound',
      headers: CONSOLE_HEADERS,
      payload: { enabled: true, publicBaseUrl: 'https://example.com/a2a' },
    })
    expect(badUrl.statusCode).toBe(400)
  })
})
