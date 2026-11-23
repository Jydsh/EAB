import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { EC, EabError } from '@eab/domain'
import { assertPublicHttpUrl, isPrivateAddress } from './net-policy.js'

/**
 * 内置浏览器会话。
 *
 * 使用 `playwright-core` + 本机 Edge/Chrome，不默认下载 Chromium：
 * - 一个用户一个 BrowserContext，不共享 Cookie/Storage；
 * - 每个页面有 pageId，snapshot 里的 eN 只对当前页面状态有效；
 * - 只允许打开、快照、点链接/普通按钮、在搜索框输入、滚动、后退、截图、关闭；
 * - 禁止提交表单、上传/下载、支付、密码框、任意 JavaScript 执行；
 * - 导航和子资源都过公网校验，内网/本机地址一律拒绝。
 *
 * 这是给 Agent 看的浏览器，不是给用户在右侧自由操作的远程浏览器。
 */

const DEFAULT_IDLE_MS = 5 * 60_000
const DEFAULT_MAX_PAGES = 4
const MAX_PAGES_PER_OWNER = 2
const PAGE_TEXT_LIMIT = 6_000
const MAX_ELEMENTS = 30
const NAV_TIMEOUT_MS = 20_000
const ACTION_TIMEOUT_MS = 5_000

export type BrowserAction =
  | 'open'
  | 'snapshot'
  | 'click'
  | 'type'
  | 'scroll'
  | 'back'
  | 'screenshot'
  | 'close'

/**
 * page.evaluate 在浏览器里运行，但服务端 tsconfig 没有 DOM 库。
 * 这里用最小结构声明代替 HTMLElement/window，避免为服务端引入整套 DOM 类型。
 */
interface BrowserDomElement {
  tagName: string
  innerText: string
  value: string
  type: string
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  getBoundingClientRect(): { width: number; height: number }
  closest(selector: string): BrowserDomElement | null
}

declare const document: {
  querySelectorAll(selector: string): ArrayLike<BrowserDomElement>
  querySelector(selector: string): BrowserDomElement | null
  body: { innerText: string } | null
}
declare const window: {
  getComputedStyle(element: BrowserDomElement): { display: string; visibility: string }
}

export interface BrowserInput {
  action: BrowserAction
  url?: string
  pageId?: string
  ref?: string
  text?: string
  direction?: 'up' | 'down'
  fullPage?: boolean
}

export interface BrowserElement {
  ref: string
  role: string
  name: string
  tag: string
  type: string | null
  value: string | null
}

export interface BrowserScreenshot {
  fileId: string
  name: string
  relPath: string
  size: number
  mime: string
}

export interface BrowserResult {
  action: BrowserAction
  pageId: string | null
  title: string | null
  url: string | null
  text: string | null
  elements: BrowserElement[]
  screenshot: BrowserScreenshot | null
  truncated: boolean
  closed: boolean
  hint: string | null
}

export interface BrowserRuntimeOptions {
  ownerKey: string
  saveScreenshot: (buffer: Buffer, filename: string) => BrowserScreenshot
  signal?: AbortSignal
  /** 仅测试使用；生产不允许由模型指定。内网访问由控制台策略注入。 */
  allowPrivateNetwork?: boolean
  /** 与 allowPrivateNetwork 搭配：只放行这些域名/IP；为空表示不限制（仅测试）。 */
  privateNetworkHosts?: readonly string[]
  allowedPorts?: readonly number[]
}

interface PlaywrightPageState {
  readonly pageId: string
  readonly ownerKey: string
  readonly contextId: string
  page: import('playwright-core').Page
  lastUsedAt: number
}

interface PlaywrightContextState {
  readonly id: string
  readonly ownerKey: string
  context: import('playwright-core').BrowserContext
  lastUsedAt: number
}

interface BrowserRuntimeState {
  browser: import('playwright-core').Browser | null
  launching: Promise<import('playwright-core').Browser> | null
  readonly pages: Map<string, PlaywrightPageState>
  readonly contexts: Map<string, PlaywrightContextState>
  timer: NodeJS.Timeout | null
}

const runtime: BrowserRuntimeState = {
  browser: null,
  launching: null,
  pages: new Map(),
  contexts: new Map(),
  timer: null,
}

function envNumber(key: string, fallback: number): number {
  const raw = Number(process.env[key] ?? '')
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback
}

function browserChannel(): string {
  const raw = String(process.env.EAB_BROWSER_CHANNEL ?? '').trim().toLowerCase()
  if (raw) return raw
  if (process.platform === 'win32') return 'msedge'
  return 'chromium'
}

function browserExecutable(): string | null {
  const raw = String(process.env.EAB_BROWSER_EXECUTABLE_PATH ?? '').trim()
  return raw && existsSync(raw) ? raw : null
}

/**
 * 浏览器代理：优先 `EAB_BROWSER_PROXY`，否则复用 `EAB_HTTP_PROXY` / 标准代理变量。
 * 只把地址和 NO_PROXY 交给 Chromium，凭据由 Playwright 通过代理认证参数传入。
 */
export function browserProxyConfig(env: NodeJS.ProcessEnv = process.env): {
  server: string
  bypass?: string
  username?: string
  password?: string
} | null {
  const raw = ['EAB_BROWSER_PROXY', 'EAB_HTTP_PROXY', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']
    .map((key) => String(env[key] ?? '').trim())
    .find(Boolean)
  if (!raw) return null
  let proxy: URL
  try {
    proxy = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`)
  } catch {
    throw new EabError(EC.VALIDATION, '浏览器代理地址无效', {
      hint: 'EAB_BROWSER_PROXY 应形如 http://127.0.0.1:7890',
    })
  }
  if (proxy.protocol !== 'http:' && proxy.protocol !== 'https:') {
    throw new EabError(EC.VALIDATION, '浏览器代理只支持 http/https')
  }
  if (!proxy.hostname) throw new EabError(EC.VALIDATION, '浏览器代理缺少主机名')
  const bypass = ['EAB_NO_PROXY', 'NO_PROXY', 'no_proxy']
    .map((key) => String(env[key] ?? '').trim())
    .find(Boolean)
  return {
    server: `${proxy.protocol}//${proxy.hostname}${proxy.port ? `:${proxy.port}` : ''}`,
    ...(bypass ? { bypass } : {}),
    ...(proxy.username ? { username: decodeURIComponent(proxy.username) } : {}),
    ...(proxy.password ? { password: decodeURIComponent(proxy.password) } : {}),
  }
}

/** 控制台状态摘要：只报告是否可用，不启动浏览器。 */
export function browserStatus(): {
  enabled: boolean
  available: boolean
  channel: string
  detail: string
  proxy: string | null
} {
  const enabled = String(process.env.EAB_BROWSER_ENABLED ?? '1').trim() !== '0'
  let proxy: string | null = null
  try {
    const config = browserProxyConfig()
    proxy = config ? config.server : null
  } catch {
    proxy = '配置无效'
  }
  if (!enabled) {
    return { enabled: false, available: false, channel: browserChannel(), detail: 'EAB_BROWSER_ENABLED=0', proxy }
  }
  const channel = browserChannel()
  const executable = browserExecutable()
  if (executable) return { enabled, available: true, channel, detail: executable, proxy }
  if (channel === 'msedge') {
    const candidates = [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ]
    const found = candidates.find((path) => existsSync(path))
    return { enabled, available: Boolean(found), channel, detail: found ?? '未找到本机 Edge', proxy }
  }
  if (channel === 'chrome') {
    const candidates = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ]
    const found = candidates.find((path) => existsSync(path))
    return { enabled, available: Boolean(found), channel, detail: found ?? '未找到本机 Chrome', proxy }
  }
  return { enabled, available: true, channel, detail: '使用 playwright 自带 Chromium', proxy }
}

function idleMs(): number {
  return envNumber('EAB_BROWSER_IDLE_MS', DEFAULT_IDLE_MS)
}

function maxPages(): number {
  return envNumber('EAB_BROWSER_MAX_PAGES', DEFAULT_MAX_PAGES)
}

async function loadPlaywright(): Promise<typeof import('playwright-core')> {
  try {
    return await import('playwright-core')
  } catch (err) {
    throw new EabError(EC.UPSTREAM, '内置浏览器组件未安装', {
      hint: '安装 playwright-core，并把 EAB_BROWSER_CHANNEL 指向本机 Edge/Chrome',
      cause: err,
    })
  }
}

async function launchBrowser(): Promise<import('playwright-core').Browser> {
  if (runtime.browser && runtime.browser.isConnected()) return runtime.browser
  if (runtime.launching) return runtime.launching
  if (!browserStatus().enabled) {
    throw new EabError(EC.VALIDATION, '内置浏览器已关闭', { hint: '让管理员设置 EAB_BROWSER_ENABLED=1' })
  }
  runtime.launching = (async () => {
    const playwright = await loadPlaywright()
    const channel = browserChannel()
    const executablePath = browserExecutable()
    const proxy = browserProxyConfig()
    const args = ['--disable-dev-shm-usage', '--disable-background-networking', '--disable-sync']
    if (String(process.env.EAB_BROWSER_NO_SANDBOX ?? '').trim() === '1') args.push('--no-sandbox')
    try {
      const browser = await playwright.chromium.launch({
        headless: String(process.env.EAB_BROWSER_HEADLESS ?? '1').trim() !== '0',
        ...(executablePath ? { executablePath } : { channel }),
        ...(proxy ? { proxy } : {}),
        args,
        timeout: 30_000,
      })
      runtime.browser = browser
      browser.on('disconnected', () => {
        runtime.browser = null
        runtime.pages.clear()
        runtime.contexts.clear()
      })
      startReaper()
      return browser
    } catch (err) {
      throw new EabError(EC.UPSTREAM, '内置浏览器启动失败', {
        hint: '检查本机 Edge/Chrome 是否可启动，或设置 EAB_BROWSER_EXECUTABLE_PATH',
        cause: err,
      })
    }
  })()
  try {
    return await runtime.launching
  } finally {
    runtime.launching = null
  }
}

async function closeContext(contextId: string): Promise<void> {
  const state = runtime.contexts.get(contextId)
  if (!state) return
  runtime.contexts.delete(contextId)
  for (const [pageId, page] of runtime.pages) {
    if (page.contextId === contextId) runtime.pages.delete(pageId)
  }
  await state.context.close().catch(() => undefined)
}

async function getContext(
  ownerKey: string,
  options: BrowserRuntimeOptions,
): Promise<PlaywrightContextState> {
  for (const state of runtime.contexts.values()) {
    if (state.ownerKey === ownerKey) return state
  }
  const browser = await launchBrowser()
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    serviceWorkers: 'block',
    acceptDownloads: false,
    ignoreHTTPSErrors: false,
  })
  const state: PlaywrightContextState = {
    id: `bc_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    ownerKey,
    context,
    lastUsedAt: Date.now(),
  }
  runtime.contexts.set(state.id, state)

  context.on('download', (download) => {
    void download.cancel().catch(() => undefined)
  })
  await context.route('**/*', async (route) => {
    const url = route.request().url()
    try {
      if (url.startsWith('data:') || url.startsWith('blob:')) {
        await route.continue()
        return
      }
      await assertPublicHttpUrl(url, {
        allowPrivateNetwork: options.allowPrivateNetwork,
        privateNetworkHosts: options.privateNetworkHosts,
        allowedPorts: options.allowedPorts,
      })
      await route.continue()
    } catch {
      await route.abort('blockedbyclient').catch(() => undefined)
    }
  })
  return state
}

function touchContext(state: PlaywrightContextState): void {
  state.lastUsedAt = Date.now()
}

function touchPage(state: PlaywrightPageState): void {
  state.lastUsedAt = Date.now()
  const context = runtime.contexts.get(state.contextId)
  if (context) context.lastUsedAt = state.lastUsedAt
}

function startReaper(): void {
  if (runtime.timer) return
  runtime.timer = setInterval(() => {
    void reapIdle()
  }, 60_000)
  runtime.timer.unref()
}

async function reapIdle(): Promise<void> {
  const now = Date.now()
  for (const [pageId, state] of runtime.pages) {
    if (now - state.lastUsedAt > idleMs()) {
      runtime.pages.delete(pageId)
      await state.page.close().catch(() => undefined)
    }
  }
  for (const [contextId, state] of runtime.contexts) {
    if (now - state.lastUsedAt > idleMs() && ![...runtime.pages.values()].some((page) => page.contextId === contextId)) {
      await closeContext(contextId)
    }
  }
}

function pageState(pageId: string | undefined): PlaywrightPageState {
  const id = String(pageId ?? '').trim()
  if (!id) throw new EabError(EC.VALIDATION, 'pageId 不能为空', { hint: '先执行 browser action=open' })
  const state = runtime.pages.get(id)
  if (!state) throw new EabError(EC.NOT_FOUND, '浏览器页面已关闭或超时', { hint: '重新打开该链接' })
  return state
}

async function assertPageUrl(page: import('playwright-core').Page, options: BrowserRuntimeOptions): Promise<void> {
  const url = page.url()
  if (!url || url === 'about:blank') return
  try {
    await assertPublicHttpUrl(url, {
      allowPrivateNetwork: options.allowPrivateNetwork,
      privateNetworkHosts: options.privateNetworkHosts,
      allowedPorts: options.allowedPorts,
    })
  } catch (err) {
    await page.close().catch(() => undefined)
    throw err
  }
}

async function snapshot(page: import('playwright-core').Page): Promise<BrowserResult> {
  const title = (await page.title().catch(() => '')) || null
  const url = page.url()
  const { text, elements } = await page.evaluate(
    (limits: { text: number; elements: number }) => {
      const nodes = Array.from(
        document.querySelectorAll(
          'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"]',
        ),
      )
      const visible = nodes.filter((node) => {
        const style = window.getComputedStyle(node)
        const rect = node.getBoundingClientRect()
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 1 && rect.height > 1
      })
      const items = visible.slice(0, limits.elements).map((node, index) => {
        const ref = `e${index + 1}`
        node.setAttribute('data-eab-ref', ref)
        const tag = node.tagName.toLowerCase()
        const role = node.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'button' ? 'button' : tag)
        const value = tag === 'input' || tag === 'textarea' ? String(node.value ?? '') : null
        const name =
          node.getAttribute('aria-label') ||
          node.getAttribute('placeholder') ||
          (node.innerText || '').trim().slice(0, 80)
        return { ref, role, name: name.slice(0, 80), tag, type: tag === 'input' ? node.type : null, value }
      })
      const bodyText = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim()
      return { text: bodyText.slice(0, limits.text), elements: items }
    },
    { text: PAGE_TEXT_LIMIT, elements: MAX_ELEMENTS },
  )
  return {
    action: 'snapshot',
    pageId: null,
    title,
    url,
    text,
    elements,
    screenshot: null,
    truncated: text.length >= PAGE_TEXT_LIMIT,
    closed: false,
    hint: null,
  }
}

async function withPageResult(
  action: BrowserAction,
  state: PlaywrightPageState,
  pageAction: () => Promise<void>,
): Promise<BrowserResult> {
  await pageAction()
  touchPage(state)
  const result = await snapshot(state.page)
  return { ...result, action, pageId: state.pageId }
}

function screenshotName(): string {
  const date = new Date()
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}-${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}${String(date.getSeconds()).padStart(2, '0')}`
  return `浏览器截图-${stamp}-${randomUUID().slice(0, 4)}.png`
}

async function capture(
  state: PlaywrightPageState,
  fullPage: boolean,
  options: BrowserRuntimeOptions,
): Promise<BrowserResult> {
  const buffer = await state.page.screenshot({ type: 'png', fullPage })
  const name = screenshotName()
  const screenshot = options.saveScreenshot(buffer, name)
  touchPage(state)
  const result = await snapshot(state.page)
  return { ...result, action: 'screenshot', pageId: state.pageId, screenshot }
}

function validAction(value: unknown): BrowserAction {
  const action = String(value ?? '').trim() as BrowserAction
  if (
    action === 'open' ||
    action === 'snapshot' ||
    action === 'click' ||
    action === 'type' ||
    action === 'scroll' ||
    action === 'back' ||
    action === 'screenshot' ||
    action === 'close'
  ) {
    return action
  }
  throw new EabError(EC.VALIDATION, 'browser action 不支持', {
    hint: '可用动作：open / snapshot / click / type / scroll / back / screenshot / close',
  })
}

/**
 * 执行一次浏览器动作。
 *
 * `ownerKey` 必须是公司+用户，不能只传会话 id；同一用户的多个会话可以共享浏览器上下文，
 * 但不同用户绝不共享 Cookie。
 */
export async function executeBrowserAction(
  input: BrowserInput,
  options: BrowserRuntimeOptions,
): Promise<BrowserResult> {
  const action = validAction(input.action)
  if (options.signal?.aborted) throw new EabError(EC.CONFLICT, '浏览器操作已取消')

  if (action === 'open') {
    const rawUrl = String(input.url ?? '').trim()
    if (!rawUrl) throw new EabError(EC.VALIDATION, 'url 不能为空', { hint: '提供要打开的 http/https 链接' })
    const validated = await assertPublicHttpUrl(rawUrl, {
      allowPrivateNetwork: options.allowPrivateNetwork,
      privateNetworkHosts: options.privateNetworkHosts,
      allowedPorts: options.allowedPorts,
    })
    const context = await getContext(options.ownerKey, options)
    if (runtime.pages.size >= maxPages()) {
      throw new EabError(EC.RATE_LIMITED, '浏览器页面已满，请先关闭不用的页面', {
        hint: '同一时间最多打开 4 个页面',
      })
    }
    const ownerPages = [...runtime.pages.values()].filter((page) => page.ownerKey === options.ownerKey)
    if (ownerPages.length >= MAX_PAGES_PER_OWNER) {
      throw new EabError(EC.RATE_LIMITED, '你打开的浏览器页面太多，请先关闭不用的页面', {
        hint: '每个用户最多同时保留 2 个页面',
      })
    }
    const page = await context.context.newPage()
    const pageId = `bp_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    const state: PlaywrightPageState = {
      pageId,
      ownerKey: options.ownerKey,
      contextId: context.id,
      page,
      lastUsedAt: Date.now(),
    }
    runtime.pages.set(pageId, state)
    touchContext(context)
    page.setDefaultTimeout(ACTION_TIMEOUT_MS)
    page.on('dialog', (dialog) => {
      void dialog.dismiss().catch(() => undefined)
    })
    page.on('popup', (popup) => {
      // 弹窗一律关闭；Agent 只能通过当前页面继续操作。
      void popup.close().catch(() => undefined)
    })
    try {
      await page.goto(validated.href, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
      await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined)
      await assertPageUrl(page, options)
      const result = await snapshot(page)
      return { ...result, action: 'open', pageId }
    } catch (err) {
      runtime.pages.delete(pageId)
      await page.close().catch(() => undefined)
      if (err instanceof EabError) throw err
      throw new EabError(EC.UPSTREAM, '打开网页失败或超时', {
        hint: '换一个链接，或先用 web.fetch 读取静态正文',
        cause: err,
      })
    }
  }

  const state = pageState(input.pageId)
  if (state.ownerKey !== options.ownerKey) {
    throw new EabError(EC.FORBIDDEN, '不能操作其他用户的浏览器页面')
  }
  if (options.signal?.aborted) throw new EabError(EC.CONFLICT, '浏览器操作已取消')

  if (action === 'snapshot') {
    touchPage(state)
    const result = await snapshot(state.page)
    return { ...result, action, pageId: state.pageId }
  }

  if (action === 'close') {
    runtime.pages.delete(state.pageId)
    await state.page.close().catch(() => undefined)
    return {
      action,
      pageId: null,
      title: null,
      url: null,
      text: null,
      elements: [],
      screenshot: null,
      truncated: false,
      closed: true,
      hint: null,
    }
  }

  if (action === 'screenshot') {
    return capture(state, input.fullPage === true, options)
  }

  if (action === 'scroll') {
    const delta = input.direction === 'up' ? -600 : 600
    return withPageResult(action, state, async () => {
      await state.page.mouse.wheel(0, delta)
      await state.page.waitForTimeout(300)
    })
  }

  if (action === 'back') {
    return withPageResult(action, state, async () => {
      await state.page.goBack({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
      await assertPageUrl(state.page, options)
    })
  }

  if (action === 'click') {
    const ref = String(input.ref ?? '').trim()
    if (!ref) throw new EabError(EC.VALIDATION, 'ref 不能为空', { hint: '先用 snapshot 获取元素引用' })
    const info = await state.page.evaluate((targetRef: string) => {
      const node = document.querySelector(`[data-eab-ref="${targetRef}"]`)
      if (!node) return null
      return {
        tag: node.tagName.toLowerCase(),
        type: node.type ?? null,
        inForm: Boolean(node.closest('form')),
      }
    }, ref)
    if (!info) throw new EabError(EC.NOT_FOUND, '页面元素已变化，请重新 snapshot', { hint: '元素引用只对当前页面状态有效' })
    if (info.tag === 'select' || info.tag === 'textarea') {
      throw new EabError(EC.VALIDATION, '该元素不支持直接点击', { hint: '只支持链接、普通按钮和搜索框' })
    }
    if (info.tag === 'button' && (info.inForm || info.type === 'submit')) {
      throw new EabError(EC.VALIDATION, '不允许提交表单', { hint: '当前浏览器只做浏览，不代替用户提交表单' })
    }
    if (info.tag === 'input' && info.type !== 'button') {
      throw new EabError(EC.VALIDATION, '该输入框不支持直接点击', { hint: '用 action=type 在搜索框输入' })
    }
    return withPageResult(action, state, async () => {
      await state.page.locator(`[data-eab-ref="${ref}"]`).click({ timeout: ACTION_TIMEOUT_MS })
      await state.page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => undefined)
      await assertPageUrl(state.page, options)
    })
  }

  const ref = String(input.ref ?? '').trim()
  if (!ref) throw new EabError(EC.VALIDATION, 'ref 不能为空', { hint: '先用 snapshot 获取输入框引用' })
  const value = String(input.text ?? '')
  if (value.length === 0) throw new EabError(EC.VALIDATION, 'text 不能为空')
  if (value.length > 500) throw new EabError(EC.VALIDATION, '输入内容过长（最多 500 字）')
  const info = await state.page.evaluate((targetRef: string) => {
    const node = document.querySelector(`[data-eab-ref="${targetRef}"]`)
    if (!node) return null
    const tag = node.tagName.toLowerCase()
    const type = node.type ?? ''
    const inForm = Boolean(node.closest('form'))
    return { tag, type, inForm }
  }, ref)
  if (!info) throw new EabError(EC.NOT_FOUND, '页面元素已变化，请重新 snapshot', { hint: '元素引用只对当前页面状态有效' })
  if (info.tag !== 'input' && info.tag !== 'textarea') {
    throw new EabError(EC.VALIDATION, '只能向搜索框或文本框输入内容')
  }
  if (info.tag === 'input' && !['search', 'text', 'url'].includes(info.type)) {
    throw new EabError(EC.VALIDATION, '该输入框类型不允许自动输入', {
      hint: '当前浏览器只允许搜索框/文本框，禁止密码、邮箱、支付和文件输入',
    })
  }
  return withPageResult(action, state, async () => {
    await state.page.locator(`[data-eab-ref="${ref}"]`).fill(value, { timeout: ACTION_TIMEOUT_MS })
  })
}

/** 关闭所有浏览器会话；测试或服务停机时使用。 */
export async function closeBrowserRuntime(): Promise<void> {
  if (runtime.timer) {
    clearInterval(runtime.timer)
    runtime.timer = null
  }
  for (const state of [...runtime.contexts.values()]) {
    await state.context.close().catch(() => undefined)
  }
  runtime.contexts.clear()
  runtime.pages.clear()
  if (runtime.browser) {
    await runtime.browser.close().catch(() => undefined)
    runtime.browser = null
  }
}

/** 判断一个主机名是否是浏览器必须拒绝的内网字面量。 */
export function isBlockedBrowserHost(hostname: string): boolean {
  return isPrivateAddress(hostname) || hostname === 'localhost' || hostname.endsWith('.local')
}
