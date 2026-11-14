import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

/**
 * 鉴权跳转回归：管理后台导航 / 导出、员工 API、插件 iframe。
 *
 * 前置：pnpm dev 已在 8787/8788 运行；本机有 Chrome。
 * 默认复用 9335 的独立测试 Chrome；没有就自动启动 headless Chrome。
 * 运行：pnpm test:auth-redirect
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const employeeBase = process.env.EAB_EMPLOYEE_BASE || 'http://127.0.0.1:8787'
const consoleBase = process.env.EAB_CONSOLE_BASE || 'http://127.0.0.1:8788'
const cdpBase = process.env.EAB_CDP_BASE || 'http://127.0.0.1:9335'
const chromePath = process.env.EAB_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const chromeProfile = process.env.EAB_CHROME_PROFILE || 'C:\\Temp\\eab-chrome-cdp'
const screenshotDir = join(root, '.eab-dev', 'tmp')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(fn, timeout = 15000, label = '等待超时') {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      const value = await fn()
      if (value) return value
    } catch {}
    await sleep(300)
  }
  throw new Error(label)
}

function readAdminCredentials() {
  const file = join(root, '.eab-dev', 'admin-credentials.txt')
  if (!existsSync(file)) {
    throw new Error(`找不到控制台凭据：${file}；可设置 EAB_ADMIN_USER / EAB_ADMIN_PASSWORD`)
  }
  const values = {}
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^(username|password)=(.+)$/.exec(line.trim())
    if (match) values[match[1]] = match[2]
  }
  if (!values.username || !values.password) throw new Error('控制台凭据文件缺少 username/password')
  return values
}

async function ensureCdp() {
  try {
    if ((await fetch(cdpBase + '/json/version')).ok) return
  } catch {}
  if (!existsSync(chromePath)) throw new Error(`找不到 Chrome：${chromePath}；可设置 EAB_CHROME`)
  mkdirSync(chromeProfile, { recursive: true })
  spawn(
    chromePath,
    [
      '--headless=new',
      '--remote-debugging-port=9335',
      `--user-data-dir=${chromeProfile}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { detached: true, stdio: 'ignore' },
  ).unref()
  await waitFor(async () => (await fetch(cdpBase + '/json/version')).ok, 15000, 'Chrome CDP 未启动')
}

class Cdp {
  static async connect() {
    const target = await (await fetch(cdpBase + '/json/new?' + encodeURIComponent('about:blank'), { method: 'PUT' })).json()
    const client = new Cdp(target)
    await client.open()
    return client
  }

  constructor(target) {
    this.target = target
    this.ws = new WebSocket(target.webSocketDebuggerUrl)
    this.seq = 0
    this.pending = new Map()
  }

  async open() {
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (!msg.id || !this.pending.has(msg.id)) return
      const { resolve, reject } = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
    })
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true })
      this.ws.addEventListener('error', reject, { once: true })
    })
    await this.send('Page.enable')
    await this.send('Runtime.enable')
    await this.send('Network.enable')
  }

  send(method, params = {}) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return result.result?.value
  }

  async navigate(url, settle = 3000) {
    await this.send('Page.navigate', { url })
    await sleep(1000)
    await waitFor(async () => (await this.eval('document.readyState')) === 'complete', 20000, `页面未完成加载：${url}`)
    await sleep(settle)
  }

  async state() {
    return this.eval(`(() => ({
      url: location.href,
      title: document.title,
      body: document.body ? document.body.innerText.slice(0, 800) : '',
    }))()`)
  }

  async setConsoleCookie(value) {
    await this.send('Network.setCookie', {
      name: 'eab_console_sid',
      value,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
    })
  }

  async clearCookies() {
    await this.send('Network.clearBrowserCookies')
  }

  async screenshot(name) {
    const shot = await this.send('Page.captureScreenshot', { format: 'png' })
    mkdirSync(screenshotDir, { recursive: true })
    const file = join(screenshotDir, `auth-redirect-${name}.png`)
    writeFileSync(file, Buffer.from(shot.data, 'base64'))
    return file
  }

  close() {
    this.ws.close()
    fetch(`${cdpBase}/json/close/${this.target.id}`).catch(() => {})
  }
}

async function loginConsole(credentials) {
  const response = await fetch(consoleBase + '/api/console/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: credentials.username, password: credentials.password }),
  })
  const body = await response.json().catch(() => null)
  if (!response.ok || !body || body.ok !== true) throw new Error(`控制台登录失败：HTTP ${response.status}`)
  const raw = response.headers.getSetCookie?.()[0] || response.headers.get('set-cookie') || ''
  const cookie = raw.split(';')[0]
  const value = cookie.slice(cookie.indexOf('=') + 1)
  if (!value) throw new Error('控制台登录响应没有 eab_console_sid')
  return value
}

function assert(condition, message, results) {
  if (!condition) throw new Error(message)
  results.push(message)
}

async function main() {
  const results = []
  let credentials
  if (process.env.EAB_ADMIN_USER && process.env.EAB_ADMIN_PASSWORD) {
    credentials = { username: process.env.EAB_ADMIN_USER, password: process.env.EAB_ADMIN_PASSWORD }
  } else {
    const fileCredentials = readAdminCredentials()
    credentials = {
      username: process.env.EAB_ADMIN_USER || fileCredentials.username,
      password: process.env.EAB_ADMIN_PASSWORD || fileCredentials.password,
    }
  }
  await ensureCdp()
  let cdp
  let failureShot = ''
  try {
    cdp = await Cdp.connect()

    const cookie = await loginConsole(credentials)
    await cdp.setConsoleCookie(cookie)
    await cdp.navigate(consoleBase + '/admin?company=c1')
    const admin = await cdp.state()
    assert(admin.title === 'EAB 管理控制台', '控制台有效会话进入管理页', results)
    assert(!/管理员登录/.test(admin.body), '管理页未显示登录门', results)

    await cdp.clearCookies()
    await cdp.eval(`document.querySelector('.nav-rail-item')?.click()`)
    await sleep(3500)
    const navState = await cdp.state()
    assert(/管理员登录/.test(navState.title) && /管理员账号/.test(navState.body), '控制台导航 401 -> 管理员登录门', results)

    await cdp.setConsoleCookie(cookie)
    await cdp.navigate(consoleBase + '/admin?company=c1')
    await cdp.clearCookies()
    await cdp.eval(`downloadConsoleFile('/api/console/members/export', 'members.csv'); true`)
    await sleep(3500)
    const exportState = await cdp.state()
    assert(/管理员登录/.test(exportState.title) && /管理员账号/.test(exportState.body), '控制台导出 401 -> 管理员登录门', results)

    await cdp.navigate(employeeBase + '/chat?as=u_nonexistent_auth_probe')
    const chatState = await cdp.state()
    assert(new URL(chatState.url).searchParams.get('login') === '1', '员工 API 401 -> /chat?login=1', results)
    assert(/扫码登录/.test(chatState.body), '员工登录页可见', results)

    await cdp.navigate(
      employeeBase +
        '/plugin-kernel.html?id=dsh-cy-api&entry=lib%2Fclient.js&company=c1&version=2026.11.12&title=dsh-cy-api&scope=user&as=u_nonexistent_auth_probe',
    )
    const pluginState = await cdp.state()
    assert(new URL(pluginState.url).searchParams.get('login') === '1', '插件 iframe 401 -> 外层登录页', results)
    assert(/扫码登录/.test(pluginState.body), '插件外层登录页可见', results)

    cdp.close()
    console.log(JSON.stringify({ ok: true, results }, null, 2))
  } catch (error) {
    if (cdp) {
      try {
        failureShot = await cdp.screenshot('failure')
      } catch {}
      cdp.close()
    }
    console.error(JSON.stringify({ ok: false, error: error.message, screenshot: failureShot }, null, 2))
    process.exitCode = 1
  }
}

main()
