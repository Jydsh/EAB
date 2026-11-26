import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { EC, EabError } from '@eab/domain'
import { assertPublicHttpUrl, isPrivateAddress } from './net-policy.js'
import type { BrowserStorageState } from './browser-session-store.js'

/**
 * 内置浏览器会话。
 *
 * 使用 `playwright-core` + 本机 Edge/Chrome，不默认下载 Chromium：
 * - 一个用户一个 BrowserContext，不共享 Cookie/Storage；
 * - 每个页面有 pageId，snapshot 里的 eN 只对当前页面状态有效；
 * - 只允许打开、快照、点链接/普通按钮、在搜索框输入、滚动、后退、截图、关闭；
 * - 禁止提交表单、上传/下载、支付、密码框、任意 JavaScript 执行；
 * - 导航和子资源默认只过公网校验；管理员开启内网访问后，可放行企业局域网，
 *   本机、链路本地和云元数据地址仍拒绝。
 *
 * 这是给 Agent 看的浏览器，不是给用户在右侧自由操作的远程浏览器。
 */

const DEFAULT_IDLE_MS = 5 * 60_000
const DEFAULT_MAX_PAGES = 12
const DEFAULT_MAX_PAGES_PER_OWNER = 8
const PAGE_TEXT_LIMIT = 6_000
const MAX_ELEMENTS = 30
const NAV_TIMEOUT_MS = 20_000
const ACTION_TIMEOUT_MS = 5_000

export type BrowserAction =
  | 'open'
  | 'snapshot'
  | 'click'
  | 'type'
  | 'fill'
  | 'scroll'
  | 'back'
  | 'forward'
  | 'reload'
  | 'navigate'
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
  href: string
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

/** 工作台实时视口帧：只读截图，不落个人云空间，避免每帧生成文件。 */
export interface BrowserFrame {
  buffer: Buffer
  pageId: string
  title: string
  url: string
  favicon: string
  width: number
  height: number
}

/** 右侧面板的 CSS 尺寸；服务端按同一宽高比重设浏览器视口，让画面不被裁切也不留黑边。 */
export interface BrowserFrameViewportHint {
  width: number
  height: number
}

function fitFrameViewport(hint?: BrowserFrameViewportHint): { width: number; height: number } | null {
  if (!hint || !Number.isFinite(hint.width) || !Number.isFinite(hint.height)) return null
  if (hint.width <= 0 || hint.height <= 0) return null
  const ratio = Math.min(3, Math.max(0.3, hint.height / hint.width))
  let width = 1280
  let height = Math.round(width * ratio)
  if (height > 2000) {
    height = 2000
    width = Math.round(height / ratio)
  }
  if (width < 640) {
    width = 640
    height = Math.round(width * ratio)
  }
  return { width, height }
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
  /** 与 allowPrivateNetwork 搭配：只放行这些域名/IP；`*` 表示放行全部企业局域网。 */
  privateNetworkHosts?: readonly string[]
  allowedPorts?: readonly number[]
  /** 新建上下文时恢复的站点 Cookie/localStorage；只由服务端登录态库注入。 */
  storageState?: BrowserStorageState | null
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
  readonly pendingContexts: Map<string, Promise<PlaywrightContextState>>
  timer: NodeJS.Timeout | null
}

/** 一个页面只开一路 CDP screencast，允许多个前端连接共享同一批帧。 */
interface BrowserScreencastState {
  cdp: import('playwright-core').CDPSession
  listeners: Set<(jpegBase64: string) => void>
  lastFrame: string
}

const runtime: BrowserRuntimeState = {
  browser: null,
  launching: null,
  pages: new Map(),
  contexts: new Map(),
  pendingContexts: new Map(),
  timer: null,
}

const screencasts = new Map<string, BrowserScreencastState>()

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

function maxPagesPerOwner(): number {
  return Math.min(
    maxPages(),
    envNumber('EAB_BROWSER_MAX_PAGES_PER_OWNER', DEFAULT_MAX_PAGES_PER_OWNER),
  )
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
        runtime.pendingContexts.clear()
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

/** 预热浏览器进程和当前用户 Context：新建网页标签时调用，省掉第一次打开的冷启动。 */
export async function warmBrowserSession(
  ownerKey: string,
  options: BrowserRuntimeOptions,
): Promise<void> {
  if (!browserStatus().enabled) return
  const context = await getContext(ownerKey, options)
  touchContext(context)
}

async function closeContext(contextId: string): Promise<void> {
  const state = runtime.contexts.get(contextId)
  if (!state) return
  runtime.contexts.delete(contextId)
  for (const [pageId, page] of runtime.pages) {
    if (page.contextId === contextId) {
      disposeBrowserScreencast(pageId)
      runtime.pages.delete(pageId)
    }
  }
  await state.context.close().catch(() => undefined)
}

async function createContext(
  ownerKey: string,
  options: BrowserRuntimeOptions,
): Promise<PlaywrightContextState> {
  const browser = await launchBrowser()
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    serviceWorkers: 'block',
    acceptDownloads: false,
    ignoreHTTPSErrors: false,
    ...(options.storageState ? { storageState: options.storageState } : {}),
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

async function getContext(
  ownerKey: string,
  options: BrowserRuntimeOptions,
): Promise<PlaywrightContextState> {
  for (const state of runtime.contexts.values()) {
    if (state.ownerKey === ownerKey) return state
  }
  const pending = runtime.pendingContexts.get(ownerKey)
  if (pending) return pending
  const promise = createContext(ownerKey, options).finally(() => {
    runtime.pendingContexts.delete(ownerKey)
  })
  runtime.pendingContexts.set(ownerKey, promise)
  return promise
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
      disposeBrowserScreencast(pageId)
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

async function settleAfterNavigation(page: import('playwright-core').Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: 3_000 }).catch(() => undefined)
  await page.waitForTimeout(150)
  await page
    .waitForFunction(
      () => {
        const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim()
        return text.length >= 30
      },
      undefined,
      { timeout: 1_000, polling: 200 },
    )
    .catch(() => undefined)
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

/** 工作台接口必须再校验一次 owner，不能只依赖调用方传对 pageId。 */
function ownedPageState(pageId: string | undefined, ownerKey: string): PlaywrightPageState {
  const state = pageState(pageId)
  if (state.ownerKey !== ownerKey) {
    throw new EabError(EC.FORBIDDEN, '不能操作其他用户的浏览器页面')
  }
  return state
}

/** 读取工作台当前页状态；不生成截图文件。 */
export async function browserPageState(
  pageId: string | undefined,
  ownerKey: string,
): Promise<BrowserResult> {
  const state = ownedPageState(pageId, ownerKey)
  touchPage(state)
  const result = await snapshot(state.page)
  return { ...result, action: 'snapshot', pageId: state.pageId }
}

function safeFaviconUrl(raw: string): string {
  const value = String(raw || '').trim()
  if (!value) return ''
  try {
    const parsed = new URL(value)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href
    if (parsed.protocol === 'data:' && /^data:image\//i.test(value) && value.length <= 2048) return value
  } catch {
    // 不是绝对 URL 就不下发，前端会回退通用图标。
  }
  return ''
}

/** 按右侧面板尺寸调整浏览器视口；高 DPI 页面只调整一次，避免每帧都重排。 */
async function ensureFrameViewport(
  state: PlaywrightPageState,
  viewportHint?: BrowserFrameViewportHint,
): Promise<{ width: number; height: number }> {
  const targetViewport = fitFrameViewport(viewportHint)
  const currentViewport = state.page.viewportSize()
  if (
    targetViewport &&
    (!currentViewport ||
      Math.abs(currentViewport.width - targetViewport.width) > 6 ||
      Math.abs(currentViewport.height - targetViewport.height) > 6)
  ) {
    try {
      await state.page.setViewportSize(targetViewport)
      await state.page.waitForTimeout(60)
    } catch {
      // 页面正在导航时重设视口可能失败，下一帧会再试，不阻塞当前取帧。
    }
  }
  return state.page.viewportSize() ?? currentViewport ?? { width: 1280, height: 800 }
}

/** 抓一帧给右侧工作台；JPEG 比 PNG 小，轮询只作为实时流的兜底。 */
export async function captureBrowserPageFrame(
  pageId: string | undefined,
  ownerKey: string,
  viewportHint?: BrowserFrameViewportHint,
): Promise<BrowserFrame> {
  const state = ownedPageState(pageId, ownerKey)
  const viewport = await ensureFrameViewport(state, viewportHint)
  const rawFavicon = await state.page
    .evaluate(() => {
      const links = Array.from(document.querySelectorAll('link[rel]'))
      const link = links.find((item) => /(^|\s)(icon|apple-touch-icon)(\s|$)/i.test(item.getAttribute('rel') || ''))
      return link?.href || ''
    })
    .catch(() => '')
  const buffer = await state.page.screenshot({ type: 'jpeg', quality: 70 })
  touchPage(state)
  return {
    buffer,
    pageId: state.pageId,
    title: (await state.page.title().catch(() => '')) || '',
    url: state.page.url(),
    favicon: safeFaviconUrl(rawFavicon),
    width: viewport.width,
    height: viewport.height,
  }
}

/** 页面关闭/超时/切换时停掉 screencast，避免 CDP 会话和帧继续占用资源。 */
export function disposeBrowserScreencast(pageId: string): void {
  const hub = screencasts.get(pageId)
  if (!hub) return
  screencasts.delete(pageId)
  hub.listeners.clear()
  void hub.cdp.send('Page.stopScreencast').catch(() => undefined)
  void hub.cdp.detach().catch(() => undefined)
}

/**
 * 订阅页面的 CDP screencast：只在画面变化时推帧，滚动和加载过程接近本地浏览器。
 * 返回取消订阅函数；最后一个订阅者离开后自动停掉 CDP。
 */
export async function subscribeBrowserScreencast(
  pageId: string | undefined,
  ownerKey: string,
  viewportHint: BrowserFrameViewportHint | undefined,
  listener: (jpegBase64: string) => void,
): Promise<() => void> {
  const state = ownedPageState(pageId, ownerKey)
  await ensureFrameViewport(state, viewportHint)
  let hub = screencasts.get(state.pageId)
  if (!hub) {
    const cdp = await state.page.context().newCDPSession(state.page)
    const next: BrowserScreencastState = { cdp, listeners: new Set(), lastFrame: '' }
    cdp.on('Page.screencastFrame', (event: { data: string; sessionId: number }) => {
      // 先 ack 再广播，Chromium 才会继续送下一帧。
      void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => undefined)
      if (!event.data) return
      next.lastFrame = event.data
      for (const emit of next.listeners) {
        try {
          emit(event.data)
        } catch {
          // 单个前端断开不应影响其他连接。
        }
      }
    })
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 70,
      maxWidth: 1280,
      maxHeight: 2000,
      everyNthFrame: 1,
    })
    screencasts.set(state.pageId, next)
    hub = next
  }
  const current = hub
  current.listeners.add(listener)
  // 新订阅者马上要一帧，不用等页面下次变化。
  if (current.lastFrame) listener(current.lastFrame)
  touchPage(state)
  return () => {
    current.listeners.delete(listener)
    if (current.listeners.size === 0 && screencasts.get(state.pageId) === current) {
      disposeBrowserScreencast(state.pageId)
    }
  }
}

/** 工作台人工接管：按视口坐标点击页面，用于点输入框、验证码图片等。 */
export async function clickBrowserPageAt(
  pageId: string | undefined,
  ownerKey: string,
  x: number,
  y: number,
): Promise<BrowserResult> {
  const state = ownedPageState(pageId, ownerKey)
  const viewport = state.page.viewportSize() ?? { width: 1280, height: 800 }
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new EabError(EC.VALIDATION, '点击坐标无效')
  }
  const px = Math.min(Math.max(0, Math.round(x)), Math.max(0, viewport.width - 1))
  const py = Math.min(Math.max(0, Math.round(y)), Math.max(0, viewport.height - 1))
  return withPageResult('click', state, async () => {
    await state.page.mouse.click(px, py)
    await state.page.waitForTimeout(250)
    await state.page.waitForLoadState('domcontentloaded', { timeout: 3_000 }).catch(() => undefined)
  })
}

/** 工作台人工接管：向当前焦点输入框打字；不记录输入内容。 */
export async function typeBrowserPageText(
  pageId: string | undefined,
  ownerKey: string,
  text: string,
): Promise<BrowserResult> {
  const state = ownedPageState(pageId, ownerKey)
  const value = String(text ?? '')
  if (!value) throw new EabError(EC.VALIDATION, '输入内容不能为空')
  if (value.length > 1_000) throw new EabError(EC.VALIDATION, '输入内容过长（最多 1000 字）')
  return withPageResult('type', state, async () => {
    await state.page.keyboard.type(value, { delay: 0 })
    await state.page.waitForTimeout(150)
  })
}

/**
 * 工作台凭据填充：由服务端把已保存的账号密码直接写进页面输入框。
 *
 * 安全边界：
 * - 凭据只在 Playwright 页面上下文使用，不返回给模型、不写审计详情；
 * - 只填账号和密码，不自动点击登录/提交，交由用户确认；
 * - 页面没有可见密码框时直接失败，不尝试猜测验证码、扫码或绕过登录。
 */
export async function fillBrowserPageCredentials(
  pageId: string | undefined,
  ownerKey: string,
  username: string,
  password: string,
): Promise<BrowserResult> {
  const state = ownedPageState(pageId, ownerKey)
  if (!username || !password) throw new EabError(EC.VALIDATION, '保存的登录信息不完整')
  const result = await withPageResult('fill', state, async () => {
    // 用字符串脚本而不是箭头函数：tsx/esbuild 会给函数注入 __name 辅助，
    // 传到 Playwright 页面上下文后找不到该辅助会抛 ReferenceError。
    const script = `(() => {
      const user = ${JSON.stringify(username)};
      const pass = ${JSON.stringify(password)};
      const visible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 2 && rect.height > 2;
      };
      const passwordInput = Array.from(document.querySelectorAll('input[type="password"]')).find(visible);
      if (!passwordInput || passwordInput.disabled || passwordInput.readOnly) {
        // 没有密码框时只判断是不是扫码登录页；不做任何二维码解码或登录绕过。
        const qrLogin = Array.from(document.querySelectorAll('img,canvas,svg,[class],[id],[aria-label],[title],[alt]')).some((el) => {
          if (!visible(el)) return false;
          const rect = el.getBoundingClientRect();
          if (rect.width < 60 || rect.height < 60) return false;
          const label = [
            el.getAttribute('class'),
            el.getAttribute('id'),
            el.getAttribute('aria-label'),
            el.getAttribute('title'),
            el.getAttribute('alt'),
          ].filter(Boolean).join(' ').toLowerCase();
          return /(qrcode|qr-code|qr_code|二维码|扫码|scan.*code)/.test(label);
        });
        return { ok: false, reason: qrLogin ? 'qr-login' : 'no-password' };
      }
      const form = passwordInput.closest('form') || document;
      const candidates = Array.from(form.querySelectorAll('input')).filter((el) => {
        if (el === passwordInput || !visible(el) || el.disabled || el.readOnly) return false;
        const type = String(el.type || 'text').toLowerCase();
        return type === 'text' || type === 'email' || type === 'tel' || type === 'search' || type === 'url';
      });
      // 只选密码框之前、距离最近的一个文本输入，避免把搜索框当账号框。
      const before = candidates.filter((el) => (passwordInput.compareDocumentPosition(el) & 2) === 2);
      const usernameInput = before[before.length - 1];
      const setValue = (el, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(el, value);
        else el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      if (usernameInput) setValue(usernameInput, user);
      setValue(passwordInput, pass);
      passwordInput.focus();
      return { ok: true, username: Boolean(usernameInput) };
    })()`
    const filled = (await state.page.evaluate(script)) as {
      ok: boolean
      reason?: string
      username?: boolean
    }
    if (!filled.ok) {
      if (filled.reason === 'qr-login') {
        throw new EabError(EC.VALIDATION, '当前页面是扫码登录，请用手机扫码完成', {
          hint: '扫码需要本人确认，账号密码填充不适用于此页；登录后可在工作台点“保存登录态”复用',
        })
      }
      throw new EabError(
        EC.VALIDATION,
        filled.reason === 'no-password' ? '当前页面没有可填写的密码框，请先打开登录页' : '没有找到可填写的登录框',
        { hint: '可以先人工点击页面输入框，或直接在接管区输入；不会绕过验证码或扫码登录' },
      )
    }
    await state.page.waitForTimeout(120)
  })
  return { ...result, hint: '已填入保存的账号密码，请确认后手动点击登录' }
}

/** 读取当前页面的登录态快照；过滤与加密由服务端登录态库完成。 */
export async function captureBrowserPageStorageState(
  pageId: string | undefined,
  ownerKey: string,
): Promise<{ origin: string; storageState: unknown }> {
  const state = ownedPageState(pageId, ownerKey)
  const raw = String(state.page.url() ?? '')
  let origin = ''
  try {
    const url = new URL(raw)
    origin = url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : ''
  } catch {
    origin = ''
  }
  if (!origin) throw new EabError(EC.VALIDATION, '当前页面还没有可保存的站点地址')
  const storageState = await state.page.context().storageState()
  return { origin, storageState }
}

/** 工作台人工接管：滚轮滚动页面，只允许有限幅度。 */
export async function scrollBrowserPageBy(
  pageId: string | undefined,
  ownerKey: string,
  deltaY: number,
): Promise<BrowserResult> {
  const state = ownedPageState(pageId, ownerKey)
  const raw = Number(deltaY)
  if (!Number.isFinite(raw) || raw === 0) throw new EabError(EC.VALIDATION, '滚动幅度无效')
  const delta = Math.max(-800, Math.min(800, Math.round(raw)))
  return withPageResult('scroll', state, async () => {
    await state.page.mouse.wheel(0, delta)
    await state.page.waitForTimeout(250)
  })
}

/** 工作台人工接管：只放行导航/编辑常用键，避免变成任意快捷键执行器。 */
export async function pressBrowserPageKey(
  pageId: string | undefined,
  ownerKey: string,
  key: string,
): Promise<BrowserResult> {
  const state = ownedPageState(pageId, ownerKey)
  const allowed = new Set([
    'Enter',
    'Tab',
    'Backspace',
    'Delete',
    'Escape',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Home',
    'End',
    'PageUp',
    'PageDown',
  ])
  const value = String(key ?? '').trim()
  if (!allowed.has(value)) {
    throw new EabError(EC.VALIDATION, '该按键不在工作台白名单内')
  }
  return withPageResult('type', state, async () => {
    await state.page.keyboard.press(value)
    await state.page.waitForTimeout(200)
    await state.page.waitForLoadState('domcontentloaded', { timeout: 3_000 }).catch(() => undefined)
  })
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
    action === 'forward' ||
    action === 'reload' ||
    action === 'navigate' ||
    action === 'screenshot' ||
    action === 'close'
  ) {
    return action
  }
  throw new EabError(EC.VALIDATION, 'browser action 不支持', {
    hint: '可用动作：open / snapshot / click / type / scroll / back / forward / reload / navigate / screenshot / close',
  })
}

/**
 * 建一个受管页面并登记到运行时；配额、对话框和弹窗策略都在这里统一处理。
 * 调用方负责导航成功/失败后的清理。
 */
async function createBrowserPageState(
  ownerKey: string,
  options: BrowserRuntimeOptions,
): Promise<PlaywrightPageState> {
  const context = await getContext(ownerKey, options)
  if (runtime.pages.size >= maxPages()) {
    throw new EabError(EC.RATE_LIMITED, '浏览器页面已满，请先关闭不用的页面', {
      hint: `同一时间最多打开 ${maxPages()} 个页面`,
    })
  }
  const ownerPages = [...runtime.pages.values()].filter((page) => page.ownerKey === ownerKey)
  if (ownerPages.length >= maxPagesPerOwner()) {
    throw new EabError(EC.RATE_LIMITED, '你打开的浏览器页面太多，请先关闭不用的页面', {
      hint: `每个用户最多同时保留 ${maxPagesPerOwner()} 个页面`,
    })
  }
  const page = await context.context.newPage()
  const pageId = `bp_${randomUUID().replace(/-/g, '').slice(0, 12)}`
  const state: PlaywrightPageState = {
    pageId,
    ownerKey,
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
  page.on('close', () => {
    disposeBrowserScreencast(pageId)
  })
  return state
}

function pendingBrowserResult(action: BrowserAction, pageId: string, url: string): BrowserResult {
  return {
    action,
    pageId,
    title: null,
    url,
    text: null,
    elements: [],
    screenshot: null,
    truncated: false,
    closed: false,
    hint: null,
  }
}

/**
 * 工作台快速打开：先把 pageId 返回给前端，导航在后台继续。
 * 画面由 CDP screencast 推送，所以用户能立刻看到浏览器开始加载，而不是等完整快照。
 */
export async function openBrowserPageFast(
  rawUrl: string,
  options: BrowserRuntimeOptions,
): Promise<BrowserResult> {
  const validated = await assertPublicHttpUrl(rawUrl, {
    allowPrivateNetwork: options.allowPrivateNetwork,
    privateNetworkHosts: options.privateNetworkHosts,
    allowedPorts: options.allowedPorts,
  })
  const state = await createBrowserPageState(options.ownerKey, options)
  touchPage(state)
  const { page, pageId } = state
  void (async () => {
    try {
      await page.goto(validated.href, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
      await settleAfterNavigation(page)
      await assertPageUrl(page, options)
    } catch {
      // 打不开就关掉页面，前端流会断开并显示失败状态。
      disposeBrowserScreencast(pageId)
      runtime.pages.delete(pageId)
      await page.close().catch(() => undefined)
    }
  })()
  return pendingBrowserResult('open', pageId, validated.href)
}

/**
 * 工作台快速导航：后退/前进/刷新/跳转都先返回，实际导航在后台执行。
 * 仅用于右侧工作台；Agent 的 browser 工具仍走同步动作，必须拿到完整快照。
 */
export async function navigateBrowserPageFast(
  pageId: string | undefined,
  ownerKey: string,
  action: 'back' | 'forward' | 'reload' | 'navigate',
  rawUrl: string | undefined,
  options: BrowserRuntimeOptions,
): Promise<BrowserResult> {
  const state = ownedPageState(pageId, ownerKey)
  let targetUrl = state.page.url()
  if (action === 'navigate') {
    const raw = String(rawUrl ?? '').trim()
    if (!raw) throw new EabError(EC.VALIDATION, 'url 不能为空', { hint: '提供要打开的 http/https 链接' })
    const validated = await assertPublicHttpUrl(raw, {
      allowPrivateNetwork: options.allowPrivateNetwork,
      privateNetworkHosts: options.privateNetworkHosts,
      allowedPorts: options.allowedPorts,
    })
    targetUrl = validated.href
  }
  touchPage(state)
  const page = state.page
  void (async () => {
    try {
      if (action === 'navigate') {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
      } else if (action === 'back') {
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
      } else if (action === 'forward') {
        await page.goForward({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
      } else {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
      }
      await settleAfterNavigation(page)
      await assertPageUrl(page, options)
    } catch {
      // 导航失败时保留当前画面；下一次操作或刷新可恢复。
    }
  })()
  return pendingBrowserResult(action, state.pageId, targetUrl)
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
    const state = await createBrowserPageState(options.ownerKey, options)
    const page = state.page
    const pageId = state.pageId
    try {
      await page.goto(validated.href, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
      await settleAfterNavigation(page)
      await assertPageUrl(page, options)
      const result = await snapshot(page)
      return { ...result, action: 'open', pageId }
    } catch (err) {
      disposeBrowserScreencast(pageId)
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
    disposeBrowserScreencast(state.pageId)
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
      await settleAfterNavigation(state.page)
      await assertPageUrl(state.page, options)
    })
  }

  if (action === 'forward') {
    return withPageResult(action, state, async () => {
      await state.page.goForward({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
      await settleAfterNavigation(state.page)
      await assertPageUrl(state.page, options)
    })
  }

  if (action === 'reload') {
    return withPageResult(action, state, async () => {
      await state.page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
      await settleAfterNavigation(state.page)
      await assertPageUrl(state.page, options)
    })
  }

  if (action === 'navigate') {
    const rawUrl = String(input.url ?? '').trim()
    if (!rawUrl) throw new EabError(EC.VALIDATION, 'url 不能为空', { hint: '提供要打开的 http/https 链接' })
    const validated = await assertPublicHttpUrl(rawUrl, {
      allowPrivateNetwork: options.allowPrivateNetwork,
      privateNetworkHosts: options.privateNetworkHosts,
      allowedPorts: options.allowedPorts,
    })
    try {
      return await withPageResult(action, state, async () => {
        await state.page.goto(validated.href, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
        await settleAfterNavigation(state.page)
        await assertPageUrl(state.page, options)
      })
    } catch (err) {
      if (err instanceof EabError) throw err
      throw new EabError(EC.UPSTREAM, '跳转网页失败或超时', {
        hint: '检查网址或稍后重试',
        cause: err,
      })
    }
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
  runtime.pendingContexts.clear()
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
