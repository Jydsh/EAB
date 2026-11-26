/**
 * AGT-21 可复跑压测 / SLO 基线。
 *
 * 目标不是“造一个好看的跑分”，而是给 EAB 单实例一条能重复验证的容量基线：
 * - 独立 EAB_HOME + 独立库 + 独立端口，绝不碰正在使用的 .eab-dev/eab.db；
 * - 自带一个 OpenAI 兼容的 mock 流式上游，显式控制首字和 token 间隔，模型延迟可复现；
 * - 自动补 50 个压测账号，不依赖演示库里的 7 个人；
 * - 四类场景：只读 HTTP、知识库读、对话流、工具调用；
 * - 采集 P50/P95/P99、错误率、首字、整轮、队列峰值、SQLITE_BUSY、RSS；
 * - 结果写到 .eab-dev/perf/result.json，供文档与回归对比。
 *
 * 用法：
 *   pnpm perf
 *   pnpm perf:enforce
 *   node scripts/perf.mjs --chat=50 --api=200 --tools=50 --enforce
 *
 * 口径：
 * - 运行中的用户服务不受影响：默认使用临时端口，启动完即停。
 * - mock 延迟不是厂商真实延迟；本基线证明 EAB 编排/DB/SSE/队列的开销，
 *   真实模型首字要在这条基线上再叠加供应商网络与推理耗时。
 */
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cpus } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { performance } from 'node:perf_hooks'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PERF_DIR = join(ROOT, '.eab-dev', 'perf')
const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const SERVER_ENTRY = join(ROOT, 'packages', 'server', 'src', 'main.ts')
const MOCK_MODEL_ID = 'perf_chat'
const PERF_USERS = 50
const COMPANY_ID = 'c1'

const options = parseOptions(process.argv.slice(2))
let server = null
let mock = null
let cleaning = false

function parseOptions(argv) {
  const out = {
    api: 200,
    chat: 50,
    tools: 50,
    apiConcurrency: 20,
    enforce: false,
  }
  for (const arg of argv) {
    if (arg === '--enforce') {
      out.enforce = true
      continue
    }
    const match = /^--(api|chat|tools|api-concurrency)=(\d+)$/.exec(arg)
    if (!match) continue
    const key = match[1] === 'api-concurrency' ? 'apiConcurrency' : match[1]
    out[key] = Math.max(1, Number(match[2]))
  }
  return out
}

function log(message) {
  console.log(message)
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => resolvePort(port))
    })
  })
}

function percentile(values, p) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = (sorted.length - 1) * p
  const low = Math.floor(rank)
  const high = Math.ceil(rank)
  if (low === high) return sorted[low]
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low)
}

function summarize(values) {
  if (!values.length) {
    return { count: 0, mean: null, p50: null, p95: null, p99: null, max: null }
  }
  const total = values.reduce((sum, value) => sum + value, 0)
  return {
    count: values.length,
    mean: round(total / values.length),
    p50: round(percentile(values, 0.5)),
    p95: round(percentile(values, 0.95)),
    p99: round(percentile(values, 0.99)),
    max: round(Math.max(...values)),
  }
}

function round(value) {
  return value === null || !Number.isFinite(value) ? null : Math.round(value * 10) / 10
}

async function runPool(total, concurrency, worker) {
  let next = 0
  const results = []
  async function lane() {
    while (true) {
      const index = next++
      if (index >= total) return
      results[index] = await worker(index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => lane()))
  return results
}

function serverEnv({ chatPort, adminPort, modelBase }) {
  const env = { ...process.env }
  // EAB_HOME 决定 console-settings / workspaces / plugins / tmp / backups 的根，
  // 必须和 EAB_DB 一起指向本次压测目录，否则会读写真实实例的运行目录。
  env.EAB_HOME = PERF_DIR
  env.EAB_DB = join(PERF_DIR, 'eab.db')
  env.EAB_PORT = String(chatPort)
  env.EAB_ADMIN_PORT = String(adminPort)
  env.EAB_COMPANY_ID = COMPANY_ID
  env.EAB_DEV_AUTH = '1'
  env.EAB_LOG_LEVEL = 'warn'
  env.EAB_ADMIN_USER = 'admin'
  env.EAB_ADMIN_PASSWORD = 'perf-admin-password'
  env.EAB_CONSOLE_TOKEN = 'perf-console-token'
  // 本脚本固定使用独立的 mock 模型，禁止回退到真实模型，避免误打外部供应商。
  env.EAB_ALLOW_DEMO_FALLBACK = '0'
  // 压测基线固定按生产默认限额跑，避免本机环境变量把限额悄悄改掉。
  env.EAB_CHAT_MAX_CONCURRENT = '8'
  env.EAB_CHAT_QUEUE_LIMIT = '100'
  env.EAB_CHAT_QUEUE_TIMEOUT_MS = '240000'
  env.EAB_CHAT_USER_MAX_IN_FLIGHT = '0'
  env.EAB_CHAT_USER_MESSAGES_PER_MINUTE = '20'
  env.EAB_CHAT_MODEL_MAX_CONCURRENT = '4'
  env.EAB_CHAT_COMPANY_MAX_CONCURRENT = '8'
  env.EAB_TOOL_MAX_CONCURRENT = '8'
  env.EAB_TOOL_QUEUE_LIMIT = '200'
  if (modelBase) env.EAB_PERF_MODEL_BASE = modelBase
  delete env.EAB_MULTI_INSTANCE
  delete env.EAB_SERVER_ROLE
  return env
}

async function startServer(label, chatPort, adminPort) {
  if (!existsSync(TSX_CLI)) throw new Error(`找不到 tsx：${TSX_CLI}`)
  const logPath = join(PERF_DIR, `${label}.log`)
  const logStream = createWriteStream(logPath, { flags: 'a' })
  const child = spawn(process.execPath, [TSX_CLI, SERVER_ENTRY], {
    cwd: ROOT,
    env: serverEnv({ chatPort, adminPort }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const tail = []
  const capture = (chunk) => {
    const text = String(chunk)
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      tail.push(line)
      if (tail.length > 80) tail.shift()
    }
    logStream.write(text)
  }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  try {
    await waitForHealth(`http://127.0.0.1:${chatPort}/healthz`, child, () => tail.join('\n'), label)
  } catch (error) {
    await stopServer(child)
    logStream.end()
    throw error
  }
  return { child, base: `http://127.0.0.1:${chatPort}`, adminBase: `http://127.0.0.1:${adminPort}`, logPath, tail, logStream }
}

async function waitForHealth(url, child, tailOf, label) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${label} 启动失败（exit ${child.exitCode}）：\n${tailOf()}`)
    }
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      // 启动期连接拒绝是正常态，继续等。
    }
    await sleep(400)
  }
  throw new Error(`${label} 60s 内没有通过健康检查：\n${tailOf()}`)
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  const exited = await Promise.race([once(child, 'exit').then(() => true), sleep(6_000).then(() => false)])
  if (!exited && child.exitCode === null) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      child.kill('SIGKILL')
    }
    await Promise.race([once(child, 'exit'), sleep(2_000)])
  }
}

function openDb() {
  const db = new DatabaseSync(join(PERF_DIR, 'eab.db'))
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  return db
}

async function openDbWithRetry() {
  let lastError = null
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      return openDb()
    } catch (error) {
      lastError = error
      // Windows 在服务刚退出时可能还会短暂持有 WAL/共享内存映射；
      // 这不是库坏了，重试几轮即可。不能把真实业务的库放进这个目录。
      await sleep(500)
    }
  }
  throw lastError
}

async function seedPerfAccountsAndModel() {
  const db = await openDbWithRetry()
  try {
    const now = Date.now()
    const memberRole = db
      .prepare(`SELECT id FROM roles WHERE company_id = ? AND code = 'member' AND deleted_at IS NULL`)
      .get(COMPANY_ID)
    if (!memberRole) throw new Error('演示库里找不到 member 角色，无法创建压测账号')

    const insertUser = db.prepare(
      `INSERT OR REPLACE INTO users
        (id, company_id, dept_id, dept_path, name, employee_no, title, status, created_at, updated_at)
       VALUES (?, ?, 'd11', '/c1/d10/d11/', ?, ?, '性能压测账号', 'active', ?, ?)`,
    )
    const insertRole = db.prepare(
      `INSERT OR REPLACE INTO user_roles (user_id, role_id, granted_by, granted_at)
       VALUES (?, ?, 'perf', ?)`,
    )
    for (let i = 1; i <= PERF_USERS; i += 1) {
      const id = `u_perf_${String(i).padStart(2, '0')}`
      insertUser.run(id, COMPANY_ID, `压测用户${i}`, `PERF-${String(i).padStart(3, '0')}`, now, now)
      insertRole.run(id, memberRole.id, now)
    }

    const providerId = 'prov_perf_mock'
    db.prepare(
      `INSERT OR REPLACE INTO model_providers
        (id, company_id, kind, name, base_url, api_key_env, status, created_at, updated_at)
       VALUES (?, ?, 'openai', '性能 mock 供应商', ?, '', 'active', ?, ?)`,
    ).run(providerId, COMPANY_ID, joinMockBase(), now, now)

    db.prepare(
      `INSERT OR REPLACE INTO models
        (id, company_id, provider_id, name, model_key, tags, roles, priority, enabled,
         created_at, updated_at, endpoint_kind, capabilities)
       VALUES (?, ?, ?, '性能 Mock 对话模型', 'perf-chat', '["chat"]', '["member","super_admin","company_admin","company_sub_admin","dept_admin","kb_admin","auditor","guest"]', 1, 1, ?, ?, 'chat', '["chat"]')`,
    ).run(MOCK_MODEL_ID, COMPANY_ID, providerId, now, now)
    return { providerId, users: PERF_USERS }
  } finally {
    db.close()
  }
}

let mockBase = ''
function joinMockBase() {
  if (!mockBase) throw new Error('mock 上游还没有启动')
  return `${mockBase}/v1`
}

function startMockModel() {
  return new Promise((resolveStart, reject) => {
    const serverMock = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
        res.writeHead(404).end('not found')
        return
      }
      let body = ''
      try {
        for await (const chunk of req) body += chunk
      } catch {
        res.writeHead(400).end('bad body')
        return
      }
      const payload = safeJson(body)
      if (!payload.stream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            id: 'chatcmpl-perf',
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: '性能基线 OK' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
          }),
        )
        return
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.flushHeaders?.()
      const chunks = ['性能', '基线', ' OK', '：', 'mock', ' 流式', '上游', '正常', '完成']
      const write = (data) => {
        if (res.writableEnded || res.destroyed) return false
        res.write(`data: ${JSON.stringify(data)}\n\n`)
        return true
      }
      // 首字 60ms，之后每 45ms 一包；50 并发 × 9 包 ≈ 0.42s/轮，足够让 4 路模型并发出现排队。
      await sleep(60)
      write({ id: 'chatcmpl-perf', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
      for (const text of chunks) {
        await sleep(45)
        if (!write({ id: 'chatcmpl-perf', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })) break
      }
      write({
        id: 'chatcmpl-perf',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 120, completion_tokens: 10, total_tokens: 130 },
      })
      if (!res.writableEnded) {
        res.write('data: [DONE]\n\n')
        res.end()
      }
    })
    serverMock.once('error', reject)
    serverMock.listen(0, '127.0.0.1', () => {
      const port = serverMock.address().port
      mockBase = `http://127.0.0.1:${port}`
      resolveStart(serverMock)
    })
  })
}

function safeJson(text) {
  try {
    return JSON.parse(text || '{}')
  } catch {
    return {}
  }
}

async function getJson(url) {
  const started = performance.now()
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  const text = await res.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    body = null
  }
  return { status: res.status, ok: res.ok, body, ms: performance.now() - started, text }
}

async function createPerfSessions(base) {
  const sessions = []
  for (let i = 1; i <= PERF_USERS; i += 1) {
    const user = perfUser(i)
    const res = await fetch(`${base}/api/chat/sessions?as=${user}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ title: `性能基线 ${i}` }),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`创建压测会话失败 ${user} HTTP ${res.status}: ${text.slice(0, 300)}`)
    const body = safeJson(text)
    const sessionId = body?.data?.session?.id
    if (!sessionId) throw new Error(`创建压测会话没有返回 id：${text.slice(0, 300)}`)
    sessions.push({ user, sessionId })
  }
  return sessions
}

function perfUser(index) {
  return `u_perf_${String(index).padStart(2, '0')}`
}

async function readSse(res, startedAt) {
  let firstDeltaAt = null
  let doneAt = null
  let donePayload = null
  let error = null
  let buffer = ''
  const decoder = new TextDecoder()
  const reader = res.body?.getReader()
  if (!reader) throw new Error('SSE 响应没有 body')
  const parseBlock = (block) => {
    const lines = block.split('\n')
    let event = 'message'
    let data = ''
    for (const rawLine of lines) {
      const line = rawLine.trimEnd()
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data += line.slice(5).trim()
    }
    if (!data) return
    let payload = null
    try {
      payload = JSON.parse(data)
    } catch {
      payload = { raw: data }
    }
    if (event === 'delta' && typeof payload?.text === 'string' && payload.text && firstDeltaAt === null) {
      firstDeltaAt = performance.now()
    }
    if (event === 'error') {
      error = String(payload?.message ?? payload?.code ?? 'SSE error')
    }
    if (event === 'done') {
      doneAt = performance.now()
      donePayload = payload
    }
  }
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() ?? ''
    for (const block of blocks) parseBlock(block)
  }
  if (buffer.trim()) parseBlock(buffer)
  return {
    firstTokenMs: firstDeltaAt === null ? null : firstDeltaAt - startedAt,
    totalMs: doneAt === null ? null : doneAt - startedAt,
    done: doneAt !== null,
    error,
    textLength: typeof donePayload?.text === 'string' ? donePayload.text.length : 0,
  }
}

async function chatOnce(base, session, text) {
  const startedAt = performance.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 120_000)
  let res
  try {
    res = await fetch(`${base}/api/chat/messages?as=${session.user}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({
        text,
        sessionId: session.sessionId,
        modelId: MOCK_MODEL_ID,
        stream: true,
        spaceKind: 'none',
      }),
      signal: controller.signal,
    })
  } catch (error) {
    clearTimeout(timeout)
    return {
      ok: false,
      status: 0,
      firstTokenMs: null,
      totalMs: performance.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    }
  }
  if (!res.ok) {
    const body = await res.text()
    clearTimeout(timeout)
    return {
      ok: false,
      status: res.status,
      firstTokenMs: null,
      totalMs: performance.now() - startedAt,
      error: body.slice(0, 240),
    }
  }
  try {
    const metrics = await readSse(res, startedAt)
    return {
      ok: metrics.done && !metrics.error,
      status: res.status,
      firstTokenMs: round(metrics.firstTokenMs),
      totalMs: round(metrics.totalMs ?? performance.now() - startedAt),
      error: metrics.error,
      textLength: metrics.textLength,
    }
  } catch (error) {
    return {
      ok: false,
      status: res.status,
      firstTokenMs: null,
      totalMs: performance.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function apiOnce(base, testCase, user) {
  const url = `${base}${testCase.path}${testCase.path.includes('?') ? '&' : '?'}as=${user}`
  const started = performance.now()
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } })
    const text = await res.text()
    return {
      name: testCase.name,
      ok: res.ok,
      status: res.status,
      ms: performance.now() - started,
      error: res.ok ? null : text.slice(0, 180),
    }
  } catch (error) {
    return {
      name: testCase.name,
      ok: false,
      status: 0,
      ms: performance.now() - started,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function toolOnce(base, user) {
  const started = performance.now()
  try {
    const res = await fetch(`${base}/api/tools/math.eval/invoke?as=${user}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ args: { expression: '(1200+300)/4' } }),
    })
    const text = await res.text()
    return { ok: res.ok, status: res.status, ms: performance.now() - started, error: res.ok ? null : text.slice(0, 180) }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      ms: performance.now() - started,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function readMetricsText(text) {
  const exact = (name) => {
    const line = text.split('\n').find((item) => item.startsWith(`${name} `))
    if (!line) return null
    const value = Number(line.slice(name.length + 1).trim())
    return Number.isFinite(value) ? value : null
  }
  return {
    rss: exact('eab_process_resident_memory_bytes'),
    heap: exact('eab_process_heap_used_bytes'),
    active: exact('eab_chat_turns_active'),
    queued: exact('eab_chat_turns_queued'),
    toolActive: exact('eab_tool_active'),
    toolQueued: exact('eab_tool_queued'),
    sqliteBusy: exact('eab_sqlite_busy_total'),
    messages: exact('eab_chat_messages_total'),
  }
}

async function scrapeMetrics(base) {
  try {
    const res = await fetch(`${base}/metrics`)
    if (!res.ok) return null
    return readMetricsText(await res.text())
  } catch {
    return null
  }
}

function startMetricsSampler(base) {
  const state = {
    baseline: null,
    peakRss: 0,
    peakHeap: 0,
    peakActive: 0,
    peakQueued: 0,
    peakToolActive: 0,
    peakToolQueued: 0,
    sqliteBusy: 0,
    samples: 0,
    interval: null,
  }
  state.interval = setInterval(async () => {
    const snapshot = await scrapeMetrics(base)
    if (!snapshot) return
    state.samples += 1
    state.peakRss = Math.max(state.peakRss, snapshot.rss ?? 0)
    state.peakHeap = Math.max(state.peakHeap, snapshot.heap ?? 0)
    state.peakActive = Math.max(state.peakActive, snapshot.active ?? 0)
    state.peakQueued = Math.max(state.peakQueued, snapshot.queued ?? 0)
    state.peakToolActive = Math.max(state.peakToolActive, snapshot.toolActive ?? 0)
    state.peakToolQueued = Math.max(state.peakToolQueued, snapshot.toolQueued ?? 0)
    state.sqliteBusy = Math.max(state.sqliteBusy, snapshot.sqliteBusy ?? 0)
    if (!state.baseline) state.baseline = snapshot
  }, 150)
  return state
}

function analyze(results) {
  const ok = results.filter((item) => item.ok)
  const failed = results.filter((item) => !item.ok)
  const latency = results.map((item) => item.ms).filter((value) => Number.isFinite(value))
  return {
    total: results.length,
    success: ok.length,
    failed: failed.length,
    errorRatePct: results.length ? round((failed.length / results.length) * 100) : 0,
    statuses: Object.fromEntries(
      [...new Set(results.map((item) => item.status))].map((status) => [
        String(status),
        results.filter((item) => item.status === status).length,
      ]),
    ),
    latencyMs: summarize(latency),
    failures: failed.slice(0, 5).map((item) => ({ name: item.name ?? '', status: item.status, error: item.error })),
  }
}

function printScenario(name, scenario) {
  const latency = scenario.latencyMs
  log(
    `\n[${name}] ${scenario.success}/${scenario.total} 成功 · 错误 ${scenario.errorRatePct}% · P50 ${latency.p50}ms · P95 ${latency.p95}ms · P99 ${latency.p99}ms · max ${latency.max}ms`,
  )
  if (scenario.firstTokenMs) {
    const first = scenario.firstTokenMs
    log(`  首字 P50 ${first.p50}ms · P95 ${first.p95}ms · P99 ${first.p99}ms`)
  }
  if (scenario.totalMs) {
    const total = scenario.totalMs
    log(`  整轮 P50 ${total.p50}ms · P95 ${total.p95}ms · P99 ${total.p99}ms`)
  }
  if (scenario.failures?.length) {
    for (const item of scenario.failures) log(`  失败 ${item.status} ${item.error}`)
  }
}

async function main() {
  if (existsSync(PERF_DIR)) rmSync(PERF_DIR, { recursive: true, force: true })
  mkdirSync(PERF_DIR, { recursive: true })

  log('启动 mock 模型上游…')
  mock = await startMockModel()
  log(`  mock: ${mockBase}/v1`)

  const seedChatPort = await freePort()
  const seedAdminPort = await freePort()
  log('启动一次性种子实例（迁移 + 演示数据 + 管理员凭据）…')
  const seedServer = await startServer('seed', seedChatPort, seedAdminPort)
  server = seedServer.child
  await stopServer(seedServer.child)
  server = null
  seedServer.logStream.end()

  log('补 50 个压测账号 + perf_chat 模型…')
  const seeded = await seedPerfAccountsAndModel()
  log(`  用户 ${seeded.users} 个，模型 ${MOCK_MODEL_ID}`)

  const chatPort = await freePort()
  const adminPort = await freePort()
  log(`启动压测实例 127.0.0.1:${chatPort}（管理端口 ${adminPort}）…`)
  const perfServer = await startServer('server', chatPort, adminPort)
  server = perfServer.child
  const base = perfServer.base

  const models = await getJson(`${base}/api/chat/models?as=${perfUser(1)}`)
  const modelIds = (models.body?.data?.models ?? []).map((item) => item.id)
  if (!models.ok || !modelIds.includes(MOCK_MODEL_ID)) {
    throw new Error(
      `压测模型没有进入可用目录：HTTP ${models.status}，模型 ${modelIds.join(',') || '空'}，响应 ${JSON.stringify(models.body).slice(0, 500)}`,
    )
  }
  log(`可用模型：${modelIds.join(', ')}`)

  // 只读 API：只看服务端鉴权、ScopeFilter、列表读和序列化，不碰写事务。
  const apiCases = [
    { name: 'health', path: '/api/health' },
    { name: 'org-tree', path: '/api/org/tree' },
    { name: 'org-members', path: '/api/org/members' },
    { name: 'kb-collections', path: '/api/kb/collections' },
    { name: 'kb-docs-public', path: '/api/kb/docs?collectionId=kb_all' },
    { name: 'kb-docs-roles', path: '/api/kb/docs?collectionId=kb_mgmt' },
    { name: 'chat-models', path: '/api/chat/models' },
    { name: 'tools', path: '/api/tools' },
  ]
  // 组织树/成员接口要求 org:dept:read / org:member:read，member 角色没有这两个 scope；
  // 只读容量用 company_admin（u_wf）跑，避免把“无权限”的 403 误算成服务端错误。
  const apiUsers = ['u_wf']
  for (const testCase of apiCases.slice(0, 3)) await apiOnce(base, testCase, apiUsers[0])

  const apiStarted = performance.now()
  const apiResults = await runPool(options.api, options.apiConcurrency, async (index) => {
    const testCase = apiCases[index % apiCases.length]
    return await apiOnce(base, testCase, apiUsers[index % apiUsers.length])
  })
  const apiDuration = performance.now() - apiStarted
  const apiLatency = apiResults.map((item) => item.ms)
  const apiScenario = {
    ...analyze(apiResults),
    latencyMs: summarize(apiLatency),
    durationMs: round(apiDuration),
    rps: round(apiResults.length / (apiDuration / 1000)),
    byCase: Object.fromEntries(
      apiCases.map((item) => {
        const rows = apiResults.filter((row) => row.name === item.name)
        return [
          item.name,
          {
            total: rows.length,
            success: rows.filter((row) => row.ok).length,
            errorRatePct: rows.length ? round((rows.filter((row) => !row.ok).length / rows.length) * 100) : 0,
            latencyMs: summarize(rows.map((row) => row.ms)),
          },
        ]
      }),
    ),
  }
  printScenario('read-api', apiScenario)
  log(`  吞吐 ${apiScenario.rps} req/s，耗时 ${apiScenario.durationMs}ms`)

  log('\n创建 50 个压测会话…')
  const sessions = await createPerfSessions(base)

  // 对话：50 个不同账号、50 条流式消息；默认限额是全局 8 / 单模型 4，因此会主动排队。
  const chatWarmup = []
  for (let i = 0; i < 5; i += 1) {
    chatWarmup.push(await chatOnce(base, sessions[i], `性能预热 ${i + 1}，只回复 OK。`))
  }
  log(`预热：${chatWarmup.filter((item) => item.ok).length}/5 成功`)

  const metrics = startMetricsSampler(base)
  const chatStarted = performance.now()
  const chatResults = await runPool(options.chat, options.chat, async (index) => {
    return await chatOnce(base, sessions[index], `性能基线 ${index + 1}，只回复 OK。`)
  })
  const chatDuration = performance.now() - chatStarted
  const chatFirst = chatResults.map((item) => item.firstTokenMs).filter((value) => Number.isFinite(value))
  const chatTotal = chatResults.map((item) => item.totalMs).filter((value) => Number.isFinite(value))
  const chatScenario = {
    ...analyze(chatResults),
    latencyMs: summarize(chatTotal),
    firstTokenMs: summarize(chatFirst),
    totalMs: summarize(chatTotal),
    durationMs: round(chatDuration),
    throughputTurnsPerSec: round(chatResults.length / (chatDuration / 1000)),
    peakQueue: metrics.peakQueued,
    peakActive: metrics.peakActive,
    peakRssBytes: metrics.peakRss,
    peakHeapBytes: metrics.peakHeap,
    sqliteBusy: metrics.sqliteBusy,
    metricsSamples: metrics.samples,
  }
  printScenario('chat-50', chatScenario)
  log(`  吞吐 ${chatScenario.throughputTurnsPerSec} turn/s，队列峰值 ${chatScenario.peakQueue}，活跃峰值 ${chatScenario.peakActive}`)
  log(`  RSS 峰值 ${(chatScenario.peakRssBytes / 1024 / 1024).toFixed(1)}MB，SQLITE_BUSY ${chatScenario.sqliteBusy}`)

  // 工具：50 并发打同一个只读工具；工具执行走 `acquireCoordinationSlot`，默认每工具 8 个名额。
  // 注意：/metrics 的 `eab_tool_queued` 仍读旧的 `toolSemaphore`，和执行路径不是同一个对象，
  // 因此工具排队只从耗时曲线判断，不拿该指标做 SLO。
  const toolStarted = performance.now()
  const toolResults = await runPool(options.tools, options.tools, async (index) => toolOnce(base, perfUser((index % PERF_USERS) + 1)))
  const toolDuration = performance.now() - toolStarted
  await sleep(250)
  clearInterval(metrics.interval)
  const toolScenario = {
    ...analyze(toolResults),
    latencyMs: summarize(toolResults.map((item) => item.ms)),
    durationMs: round(toolDuration),
    throughputPerSec: round(toolResults.length / (toolDuration / 1000)),
    peakQueue: metrics.peakToolQueued,
    peakActive: metrics.peakToolActive,
  }
  printScenario('tools-50', toolScenario)

  const rssMb = round((chatScenario.peakRssBytes ?? 0) / 1024 / 1024)
  const baselineRssMb = round(((metrics.baseline?.rss ?? 0) / 1024 / 1024))
  const slo = {
    readApi: {
      pass: apiScenario.errorRatePct === 0 && apiScenario.latencyMs.p95 !== null && apiScenario.latencyMs.p95 < 250,
      threshold: '错误率 0%，读接口 P95 < 250ms',
    },
    chat: {
      pass:
        chatScenario.errorRatePct === 0 &&
        chatScenario.firstTokenMs.p95 !== null &&
        chatScenario.firstTokenMs.p95 < 12_000 &&
        chatScenario.peakQueue <= 50 &&
        chatScenario.sqliteBusy === 0,
      threshold: '50 并发默认限额下错误率 0%，首字 P95 < 12s，队列峰值 ≤ 50，SQLITE_BUSY = 0',
    },
    tools: {
      pass: toolScenario.errorRatePct === 0 && toolScenario.latencyMs.p95 !== null && toolScenario.latencyMs.p95 < 1_000,
      threshold: '50 并发工具调用错误率 0%，P95 < 1s',
    },
    memory: {
      pass: rssMb > 0 && rssMb < 1024,
      threshold: 'RSS 峰值 < 1GB',
    },
  }
  const passed = Object.values(slo).every((item) => item.pass)

  const result = {
    generatedAt: new Date().toISOString(),
    version: readVersion(),
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpus: cpus().length,
      host: '127.0.0.1',
      isolatedHome: PERF_DIR,
    },
    options,
    accounts: seeded.users,
    model: { id: MOCK_MODEL_ID, kind: 'mock-openai-stream', firstTokenDelayMs: 60, chunkDelayMs: 45, chunks: 9 },
    scenarios: {
      readApi: apiScenario,
      chat: chatScenario,
      tools: toolScenario,
    },
    resources: {
      baselineRssMb,
      peakRssMb: rssMb,
      peakHeapMb: round((chatScenario.peakHeapBytes ?? 0) / 1024 / 1024),
      peakQueue: chatScenario.peakQueue,
      sqliteBusy: chatScenario.sqliteBusy,
    },
    slo,
    pass: passed,
    notes: [
      'mock 透明上游，不代表真实厂商网络与推理延迟；真实模型首字 = 本基线 + 供应商耗时。',
      '默认限额：全局对话 8、单模型 4、单公司 8；50 条并发会有明确排队，这正是本场景要验证的行为。',
      'KB 场景只覆盖演示库与读接口，未构造 10 万 chunk；NFR-P-04 的向量检索 P95 仍待独立数据规模测试。',
      '子 Agent / 长上下文 / 双实例未在本轮覆盖，避免把不同维度的延迟混成一个数字。',
      '工具执行走 acquireCoordinationSlot；/metrics 的 eab_tool_queued 仍读旧 toolSemaphore，本轮不把该值当作工具排队证据。',
    ],
  }
  writeFileSync(join(PERF_DIR, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  log(`\n结果写入 ${join(PERF_DIR, 'result.json')}`)
  log(`SLO：${passed ? 'PASS' : 'FAIL'}`)
  for (const [name, item] of Object.entries(slo)) log(`  ${name}: ${item.pass ? 'PASS' : 'FAIL'} · ${item.threshold}`)

  if (options.enforce && !passed) process.exitCode = 1
}

function readVersion() {
  try {
    const text = readFileSync(join(ROOT, 'package.json'), 'utf8')
    return JSON.parse(text).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

async function cleanup() {
  if (cleaning) return
  cleaning = true
  try {
    if (server && server.exitCode === null) await stopServer(server)
  } catch {
    // 清理失败不覆盖原始错误。
  }
  if (mock) {
    await new Promise((resolveClose) => mock.close(resolveClose))
    mock = null
  }
}

process.on('SIGINT', async () => {
  await cleanup()
  process.exit(130)
})
process.on('SIGTERM', async () => {
  await cleanup()
  process.exit(143)
})

main()
  .catch(async (error) => {
    console.error('\n压测失败：', error instanceof Error ? error.stack ?? error.message : error)
    process.exitCode = 1
  })
  .finally(async () => {
    await cleanup()
  })
