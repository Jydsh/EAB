import { app, BrowserWindow, WebContentsView, ipcMain, session, shell, Menu, clipboard, dialog } from 'electron'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { finished } from 'node:stream/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { DesktopLocalProjects } from './local-files.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_COMPANY = 'c1'
const PROBE = process.argv.includes('--probe')
const APP_ICON = path.join(here, 'assets', 'eab.ico')

// 开发态从源码启动时也复用安装版的用户目录与登录配置，避免出现两套账号/标签数据。
app.setName('EAB')

if (process.platform === 'win32') app.setAppUserModelId('com.eab.desktop')

let mainWindow = null
let chatUrl = ''
const browserViews = new Map()

function configPath() {
  return path.join(app.getPath('userData'), 'desktop-config.json')
}

function readLocalConfig() {
  const file = configPath()
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeLocalConfig(patch) {
  const file = configPath()
  const previous = readLocalConfig()
  const next = { ...previous, ...patch, updatedAt: new Date().toISOString() }
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(next, null, 2), 'utf8')
  return next
}

/* -------------------------------------------------------------------------- */
/* 本地项目文件桥：项目目录只存在于这台电脑，服务端通过登录态派发文件任务。 */
/* -------------------------------------------------------------------------- */

let localProjectFs = null
let bridgeRunning = false
let bridgeLoopPromise = null
let bridgeRegisteredBase = ''

function ensureDeviceId() {
  const config = readLocalConfig()
  const existing = String(config.desktopDeviceId || '').trim()
  if (/^[A-Za-z0-9_-]{8,80}$/.test(existing)) return existing
  const generated = `dev_${crypto.randomUUID().replace(/-/g, '')}`
  writeLocalConfig({ desktopDeviceId: generated })
  return generated
}

function ensureLocalProjectFs() {
  if (localProjectFs) return localProjectFs
  const config = readLocalConfig()
  localProjectFs = new DesktopLocalProjects({
    bindings: config.localProjectRoots && typeof config.localProjectRoots === 'object'
      ? config.localProjectRoots
      : {},
    onChange: (bindings) => writeLocalConfig({ localProjectRoots: bindings }),
  })
  return localProjectFs
}

function desktopInfo() {
  return {
    desktop: true,
    deviceId: ensureDeviceId(),
    deviceName: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    version: app.getVersion(),
  }
}

async function desktopCookieHeader() {
  if (!chatUrl) return ''
  try {
    const cookies = await webSession().cookies.get({ url: new URL(chatUrl).origin })
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
  } catch {
    return ''
  }
}

async function bridgeRequest(pathname, options = {}) {
  const base = serverBaseUrl()
  if (!base) throw new Error('尚未配置 EAB 服务器')
  const cookie = await desktopCookieHeader()
  if (!cookie) throw Object.assign(new Error('尚未登录'), { code: 'UNAUTHORIZED' })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Number(options.timeoutMs) || 35_000)
  try {
    const response = await fetch(new URL(pathname, base), {
      method: options.method || 'GET',
      headers: {
        accept: 'application/json',
        cookie,
        'x-eab-desktop': '1',
        'x-eab-desktop-device': desktopInfo().deviceId,
        ...(options.body ? { 'content-type': 'application/json' } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
      cache: 'no-store',
    })
    if (response.status === 401 || response.status === 403) {
      throw Object.assign(new Error('尚未登录'), { code: 'UNAUTHORIZED' })
    }
    if (response.status === 204) return null
    const text = await response.text()
    let payload = null
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      throw new Error(`桌面文件桥返回了非 JSON 响应（HTTP ${response.status}）`)
    }
    if (!response.ok) {
      const error = new Error(String(payload?.message || payload?.error || `HTTP ${response.status}`))
      error.payload = payload
      throw error
    }
    return payload?.data && typeof payload.data === 'object' ? payload.data : payload
  } finally {
    clearTimeout(timer)
  }
}

async function runDesktopBridgeLoop() {
  while (bridgeRunning) {
    try {
      if (!chatUrl) {
        await new Promise((resolve) => setTimeout(resolve, 3000))
        continue
      }
      const info = desktopInfo()
      const base = serverBaseUrl()
      if (!base) throw new Error('没有可用的服务器地址')
      if (bridgeRegisteredBase !== base) bridgeRegisteredBase = ''
      if (!bridgeRegisteredBase) {
        await bridgeRequest('api/desktop/bridge/register', {
          method: 'POST',
          timeoutMs: 15_000,
          body: {
            deviceId: info.deviceId,
            name: info.deviceName,
            platform: info.platform,
          },
        })
        bridgeRegisteredBase = base
        reportBrowserTabsSoon()
      }
      const jobData = await bridgeRequest(
        `api/desktop/bridge/jobs?deviceId=${encodeURIComponent(info.deviceId)}`,
        { timeoutMs: 28_000 },
      )
      const job = jobData?.job ?? jobData
      if (!bridgeRunning) break
      if (!job?.id) continue
      const result = job.kind === 'browser'
        ? await executeNativeBrowserJob(job)
        : ensureLocalProjectFs().execute(job)
      await bridgeRequest(`api/desktop/bridge/jobs/${encodeURIComponent(job.id)}/result`, {
        method: 'POST',
        timeoutMs: 15_000,
        body: result,
      })
    } catch (error) {
      if (!bridgeRunning) break
      console.warn('[bridge] error', error?.code || error?.message || error)
      // 服务重启、会话过期或设备表丢失时，服务端会要求重新注册，不能一直 409 空转。
      if (error?.code === 'UNAUTHORIZED' || error?.payload?.code === 'EAB_CONFLICT') {
        bridgeRegisteredBase = ''
      }
      await new Promise((resolve) => setTimeout(resolve, error?.code === 'UNAUTHORIZED' ? 4000 : 2500))
    }
  }
}

function restartDesktopBridge() {
  if (!chatUrl) return
  bridgeRegisteredBase = ''
  if (bridgeRunning) return
  bridgeRunning = true
  bridgeLoopPromise = runDesktopBridgeLoop()
    .catch(() => undefined)
    .finally(() => {
      bridgeRunning = false
      bridgeLoopPromise = null
    })
}

function stopDesktopBridge() {
  bridgeRunning = false
  bridgeRegisteredBase = ''
}

function normalizeChatUrl(raw) {
  const text = String(raw || '').trim()
  if (!text) throw new Error('请填写 EAB 服务地址')
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    throw new Error('地址格式不正确，需要以 http:// 或 https:// 开头')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('只支持 http/https 地址')
  }
  if (parsed.username || parsed.password) throw new Error('地址不能包含账号密码')
  if (parsed.pathname === '/' || parsed.pathname === '') {
    parsed.pathname = '/chat'
  }
  if (!parsed.searchParams.get('company') && (parsed.pathname === '/chat' || parsed.pathname === '/chat.html')) {
    parsed.searchParams.set('company', DEFAULT_COMPANY)
  }
  return parsed.href
}

function readConfiguredChatUrl() {
  const fromEnv = String(process.env.EAB_DESKTOP_URL || '').trim()
  if (fromEnv) {
    try {
      return normalizeChatUrl(fromEnv)
    } catch {
      // 环境变量写错时退回首次配置页，避免启动即白屏。
    }
  }
  const candidates = [configPath(), path.join(here, 'desktop-config.json')]
  for (const file of candidates) {
    if (!existsSync(file)) continue
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      const url = normalizeChatUrl(parsed?.serverUrl)
      return url
    } catch {
      // 配置损坏或地址非法时继续找下一个来源。
    }
  }
  return ''
}

/**
 * 桌面版加载的是 EAB 服务端页面，不是 localhost。
 * Chromium 默认只在安全上下文暴露 navigator.mediaDevices；内网 HTTP 会让语音按钮直接消失。
 * 启动时把当前 EAB 服务 origin 声明为可信来源，让桌面端在 HTTP 下也能录音；
 * 仅限当前已配置的 EAB origin，不影响右侧打开的其他网站。
 */
function insecureChatOrigin(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ''))
    if (parsed.protocol !== 'http:') return ''
    const host = parsed.hostname.toLowerCase()
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return ''
    return parsed.origin
  } catch {
    return ''
  }
}

const startupChatUrl = readConfiguredChatUrl()
const startupInsecureOrigin = insecureChatOrigin(startupChatUrl)
if (startupInsecureOrigin) {
  // 必须在 app ready 前设置；Chromium 在创建网络上下文时读取该开关。
  app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', startupInsecureOrigin)
}

function saveConfiguredChatUrl(url) {
  writeLocalConfig({ serverUrl: url })
}

let sharedBrowserSession = null
function browserPartition() {
  const owner = String(process.env.EAB_DESKTOP_OWNER || 'default').replace(/[^a-zA-Z0-9_-]/g, '_')
  return `persist:eab-web-${owner}`
}

/**
 * 主窗口和所有原生网页标签必须共用同一个持久会话。
 * 否则用户在 EAB 里登录后只是登录了主窗口，右侧原生标签仍然是无登录状态。
 */
function webSession() {
  if (!sharedBrowserSession) sharedBrowserSession = session.fromPartition(browserPartition())
  return sharedBrowserSession
}

function validPageUrl(raw) {
  const text = String(raw || '').trim()
  if (!text) throw new Error('网址不能为空')
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    throw new Error('网址格式不正确')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('只允许 http/https 网页')
  }
  if (parsed.username || parsed.password) throw new Error('网址不能包含账号密码')
  return parsed.href
}

function validAction(raw) {
  const action = String(raw || '').trim()
  if (!['back', 'forward', 'reload', 'navigate'].includes(action)) throw new Error('不支持的浏览器动作')
  return action
}

function safeFavicon(raw) {
  const url = String(Array.isArray(raw) ? raw[0] || '' : raw || '').trim()
  if (!url) return ''
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href
    if (parsed.protocol === 'data:' && /^data:image\//i.test(url)) return url
    return ''
  } catch {
    return ''
  }
}

function currentState(pageId, extra = {}) {
  const entry = browserViews.get(pageId)
  if (!entry) return null
  const wc = entry.view.webContents
  return {
    native: true,
    pageId,
    sessionId: String(entry.sessionId || ''),
    url: wc.getURL(),
    title: wc.getTitle(),
    favicon: entry.favicon || '',
    loading: wc.isLoading(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    ...extra,
  }
}

function emitState(pageId, extra = {}) {
  const state = currentState(pageId, extra)
  if (!state || !mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('eab:browser-state', state)
}

/* -------------------------------------------------------------------------- */
/* 右侧浏览器标签页持久化与 Agent 桥：标签页在本机主进程里常驻，页面刷新不丢。 */
/* -------------------------------------------------------------------------- */

let activeBrowserPageId = ''
let activeChatSessionId = ''
let browserTabsRestored = false
let browserTabsRestoring = false
let browserTabsOwnerUserId = ''
let browserTabsPersistTimer = null
let browserTabsReportTimer = null

/** 右侧标签页按对话归属；没有会话归属的旧标签不会显示在任何对话里。 */
function browserTabsPayload(sessionId = activeChatSessionId) {
  const target = String(sessionId || '')
  const entries = [...browserViews.values()].filter(
    (entry) => String(entry.sessionId || '') === target,
  )
  const tabs = entries.map((entry) => ({
    pageId: entry.pageId,
    sessionId: target,
    title: entry.view.webContents.getTitle() || '',
    url: entry.view.webContents.getURL() || '',
    favicon: entry.favicon || '',
    active: entry.pageId === activeBrowserPageId,
  }))
  const activeEntry = browserViews.get(activeBrowserPageId)
  const activePageId = activeEntry && String(activeEntry.sessionId || '') === target
    ? activeBrowserPageId
    : entries[0]?.pageId || ''
  for (const tab of tabs) tab.active = tab.pageId === activePageId
  return { sessionId: target, activePageId, tabs }
}

/** 切换对话时只显示该对话自己的原生标签，并立即隐藏其它对话的网页视图。 */
function setActiveChatSession(sessionId) {
  const target = String(sessionId || '')
  if (activeChatSessionId === target) return browserTabsPayload(target)
  activeChatSessionId = target
  const first = [...browserViews.values()].find(
    (entry) => String(entry.sessionId || '') === target,
  )
  activeBrowserPageId = first?.pageId || ''
  hideAllViews()
  persistBrowserTabsSoon()
  return browserTabsPayload(target)
}

function browserTabsConfigPayload() {
  const sessions = {}
  for (const entry of browserViews.values()) {
    const sessionId = String(entry.sessionId || '')
    if (!sessionId || !/^[A-Za-z0-9_-]{1,120}$/.test(sessionId)) continue
    const group = sessions[sessionId] || { activePageId: '', tabs: [] }
    const active = entry.pageId === activeBrowserPageId
    if (active) group.activePageId = entry.pageId
    group.tabs.push({
      pageId: entry.pageId,
      title: entry.view.webContents.getTitle() || '',
      url: entry.view.webContents.getURL() || '',
      favicon: entry.favicon || '',
    })
    sessions[sessionId] = group
  }
  return {
    version: 2,
    ownerUserId: browserTabsOwnerUserId,
    activeSessionId: activeChatSessionId,
    sessions,
  }
}

function reportBrowserTabsSoon() {
  if (browserTabsReportTimer) clearTimeout(browserTabsReportTimer)
  browserTabsReportTimer = setTimeout(() => {
    browserTabsReportTimer = null
    const payload = browserTabsPayload()
    void bridgeRequest('api/desktop/bridge/tabs', {
      method: 'POST',
      timeoutMs: 10_000,
      body: payload,
    }).catch(() => {
      // 未登录/服务重启期间忽略；下一轮状态变化或桥重连后会再上报。
    })
  }, 500)
}

function persistBrowserTabsSoon() {
  if (browserTabsRestoring) return
  if (browserTabsPersistTimer) clearTimeout(browserTabsPersistTimer)
  browserTabsPersistTimer = setTimeout(() => {
    browserTabsPersistTimer = null
    writeLocalConfig({ browserTabs: browserTabsConfigPayload() })
    reportBrowserTabsSoon()
  }, 300)
}

function persistBrowserTabsNow() {
  if (browserTabsPersistTimer) {
    clearTimeout(browserTabsPersistTimer)
    browserTabsPersistTimer = null
  }
  writeLocalConfig({ browserTabs: browserTabsConfigPayload() })
  reportBrowserTabsSoon()
}

function setActiveBrowserPage(pageId) {
  const target = String(pageId || '')
  if (target && !browserViews.has(target)) return
  activeBrowserPageId = target
  persistBrowserTabsSoon()
}

function resetBrowserTabsForOwner(ownerUserId) {
  for (const entry of browserViews.values()) {
    try {
      entry.view.webContents.close()
    } catch {
      // 已销毁时忽略
    }
    try {
      mainWindow?.contentView?.removeChildView(entry.view)
    } catch {
      // 窗口已关闭时忽略
    }
  }
  browserViews.clear()
  activeBrowserPageId = ''
  activeChatSessionId = ''
  browserTabsOwnerUserId = String(ownerUserId || '')
  writeLocalConfig({
    browserTabs: {
      version: 2,
      ownerUserId: browserTabsOwnerUserId,
      activeSessionId: '',
      sessions: {},
    },
  })
}

async function restoreBrowserTabsIfNeeded(userId = '', sessionId = '') {
  const targetUser = String(userId || '')
  const targetSession = String(sessionId || '')
  if (browserTabsRestored) {
    if (targetUser && browserTabsOwnerUserId && targetUser !== browserTabsOwnerUserId) {
      resetBrowserTabsForOwner(targetUser)
      setActiveChatSession(targetSession)
      reportBrowserTabsSoon()
      return
    }
    if (targetSession !== activeChatSessionId) {
      setActiveChatSession(targetSession)
      reportBrowserTabsSoon()
    }
    return
  }
  browserTabsRestored = true
  if (browserViews.size > 0) {
    setActiveChatSession(targetSession)
    return
  }
  const saved = readLocalConfig().browserTabs
  if (targetUser && saved?.ownerUserId && String(saved.ownerUserId) !== targetUser) {
    resetBrowserTabsForOwner(targetUser)
    setActiveChatSession(targetSession)
    return
  }
  browserTabsOwnerUserId = targetUser || String(saved?.ownerUserId || '')
  const savedSessions = saved?.sessions && typeof saved.sessions === 'object' && !Array.isArray(saved.sessions)
    ? saved.sessions
    : null
  const sessions = savedSessions
    ? Object.entries(savedSessions).map(([key, value]) => [String(key), value])
    : []
  browserTabsRestoring = true
  try {
    let opened = 0
    // 按会话恢复；每个会话最多 12 个，总量上限 24，避免历史会话无限开页面。
    for (const [ownerSessionId, value] of sessions) {
      if (!ownerSessionId || !/^[A-Za-z0-9_-]{1,120}$/.test(ownerSessionId)) continue
      const tabs = Array.isArray(value?.tabs) ? value.tabs : []
      for (const tab of tabs) {
        if (opened >= 24) break
        const pageId = String(tab?.pageId || '')
        if (!/^dp_[A-Za-z0-9_-]{4,80}$/.test(pageId)) continue
        try {
          await openNativePage(String(tab?.url || ''), {
            pageId,
            sessionId: ownerSessionId,
            broadcast: false,
            activate: false,
          })
          opened += 1
        } catch {
          // 历史网址失效（协议变化/数据损坏）时跳过，不影响其它标签。
        }
      }
      if (opened >= 24) break
    }
  } finally {
    browserTabsRestoring = false
  }
  setActiveChatSession(targetSession || String(saved?.activeSessionId || ''))
  const savedActive = String(saved?.sessions?.[activeChatSessionId]?.activePageId || '')
  const currentEntries = [...browserViews.values()].filter(
    (entry) => String(entry.sessionId || '') === activeChatSessionId,
  )
  activeBrowserPageId = currentEntries.some((entry) => entry.pageId === savedActive)
    ? savedActive
    : currentEntries[0]?.pageId || ''
  persistBrowserTabsSoon()
}

function clearPersistedBrowserTabs() {
  browserTabsRestored = true
  activeBrowserPageId = ''
  activeChatSessionId = ''
  browserTabsOwnerUserId = ''
  writeLocalConfig({
    browserTabs: {
      version: 2,
      ownerUserId: '',
      activeSessionId: '',
      sessions: {},
    },
  })
}

function hideAllViews() {
  for (const entry of browserViews.values()) {
    entry.visible = false
    entry.view.setVisible(false)
  }
}

function clampRect(rect) {
  if (!mainWindow || mainWindow.isDestroyed()) return null
  const bounds = mainWindow.getContentBounds()
  const x = Math.max(0, Math.round(Number(rect?.x) || 0))
  const y = Math.max(0, Math.round(Number(rect?.y) || 0))
  const width = Math.max(0, Math.round(Number(rect?.width) || 0))
  const height = Math.max(0, Math.round(Number(rect?.height) || 0))
  return {
    x,
    y,
    width: Math.max(0, Math.min(width, bounds.width - x)),
    height: Math.max(0, Math.min(height, bounds.height - y)),
  }
}

function sendBrowserEvent(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(channel, payload)
}

function openLinkInNewTab(pageId, rawUrl, disposition) {
  let url = ''
  try {
    url = validPageUrl(rawUrl)
  } catch {
    return
  }
  const activate = disposition !== 'background-tab'
  void openNativePage(url, {
    broadcast: true,
    activate,
    openerPageId: pageId,
    disposition: String(disposition || 'foreground-tab'),
  })
}

function showPageContextMenu(pageId, wc, params) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const template = []
  let linkUrl = ''
  if (params.linkURL) {
    try {
      linkUrl = validPageUrl(params.linkURL)
    } catch {
      linkUrl = ''
    }
  }
  if (linkUrl) {
    template.push(
      { label: '在新标签页打开', click: () => openLinkInNewTab(pageId, linkUrl, 'foreground-tab') },
      { label: '在后台标签页打开', click: () => openLinkInNewTab(pageId, linkUrl, 'background-tab') },
      { label: '在系统浏览器打开', click: () => void shell.openExternal(linkUrl) },
      { type: 'separator' },
      { label: '复制链接地址', click: () => clipboard.writeText(linkUrl) },
      { type: 'separator' },
    )
  }
  if (params.isEditable) {
    template.push(
      { role: 'undo', label: '撤销' },
      { role: 'redo', label: '重做' },
      { type: 'separator' },
      { role: 'cut', label: '剪切' },
      { role: 'copy', label: '复制' },
      { role: 'paste', label: '粘贴' },
      { role: 'selectAll', label: '全选' },
      { type: 'separator' },
    )
  } else if (params.selectionText) {
    template.push({ role: 'copy', label: '复制选中文字' }, { type: 'separator' })
  }
  if (wc.navigationHistory.canGoBack()) {
    template.push({ label: '后退', click: () => wc.navigationHistory.goBack() })
  }
  if (wc.navigationHistory.canGoForward()) {
    template.push({ label: '前进', click: () => wc.navigationHistory.goForward() })
  }
  template.push(
    { label: '刷新', click: () => wc.reload() },
    { label: '复制页面地址', click: () => clipboard.writeText(wc.getURL()) },
    { label: '在系统浏览器打开', click: () => void shell.openExternal(wc.getURL()) },
  )
  Menu.buildFromTemplate(template).popup({ window: mainWindow })
}

function handleWindowBrowserShortcut(event, input) {
  if (!input || input.type !== 'keyDown') return
  const key = String(input.key || '')
  const lower = key.toLowerCase()
  const ctrl = Boolean(input.control || input.meta)
  const alt = Boolean(input.alt)
  const send = (command) => {
    event.preventDefault()
    sendBrowserEvent('eab:browser-command', { command, scope: 'shell' })
  }
  if (ctrl && lower === 't') return send('new-tab')
  if (ctrl && lower === 'w') return send('close-tab')
  if (ctrl && key === 'Tab') return send(input.shift ? 'previous-tab' : 'next-tab')
  if (ctrl && lower === 'l') return send('focus-address')
  if (ctrl && lower === 'r') return send('reload')
  if (lower === 'f5') return send('reload')
  if (alt && key === 'ArrowLeft') return send('back')
  if (alt && key === 'ArrowRight') return send('forward')
}

function handleBrowserShortcut(pageId, wc, event, input) {
  if (!input || input.type !== 'keyDown') return
  const key = String(input.key || '')
  const lower = key.toLowerCase()
  const ctrl = Boolean(input.control || input.meta)
  const alt = Boolean(input.alt)
  const send = (command) => {
    event.preventDefault()
    sendBrowserEvent('eab:browser-command', { command, pageId })
  }
  if (ctrl && lower === 't') return send('new-tab')
  if (ctrl && lower === 'w') return send('close-tab')
  if (ctrl && key === 'Tab') return send(input.shift ? 'previous-tab' : 'next-tab')
  if (ctrl && lower === 'l') return send('focus-address')
  if (alt && key === 'ArrowLeft') return send('back')
  if (alt && key === 'ArrowRight') return send('forward')
  if (lower === 'f5' || (ctrl && lower === 'r')) {
    event.preventDefault()
    wc.reload()
  }
}

function wireBrowserView(pageId, view) {
  const wc = view.webContents
  wc.setWindowOpenHandler((details) => {
    // 与豆包浏览器一致：target=_blank / window.open 进入 EAB 自己的标签页，
    // Ctrl+点击或中键点击按 background-tab 在后台打开；当前页的普通链接仍走 will-navigate 同页跳转。
    openLinkInNewTab(pageId, details.url, details.disposition)
    return { action: 'deny' }
  })
  wc.on('will-navigate', (event, url) => {
    try {
      validPageUrl(url)
    } catch {
      event.preventDefault()
    }
  })
  wc.on('will-redirect', (event, url) => {
    try {
      validPageUrl(url)
    } catch {
      event.preventDefault()
    }
  })
  wc.on('context-menu', (_event, params) => showPageContextMenu(pageId, wc, params))
  wc.on('before-input-event', (event, input) => handleBrowserShortcut(pageId, wc, event, input))
  for (const event of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated']) {
    wc.on(event, () => {
      if (event === 'did-navigate') {
        const entry = browserViews.get(pageId)
        if (entry) entry.favicon = ''
      }
      emitState(pageId)
      persistBrowserTabsSoon()
    })
  }
  wc.on('page-favicon-updated', (_event, favicons) => {
    const entry = browserViews.get(pageId)
    if (!entry) return
    const favicon = safeFavicon(favicons)
    if (!favicon || favicon === entry.favicon) return
    entry.favicon = favicon
    emitState(pageId)
    persistBrowserTabsSoon()
  })
  wc.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame) return
    if (code === -3) return // ERR_ABORTED：用户切页或重复导航
    emitState(pageId, { error: String(description || `加载失败 (${code})`), url })
  })
  wc.on('destroyed', () => {
    const entry = browserViews.get(pageId)
    browserViews.delete(pageId)
    if (activeBrowserPageId === pageId) {
      activeBrowserPageId = [...browserViews.values()].find(
        (item) => String(item.sessionId || '') === String(entry?.sessionId || activeChatSessionId),
      )?.pageId || ''
    }
    persistBrowserTabsSoon()
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('eab:browser-closed', { pageId })
  })
}

async function openNativePage(rawUrl, options = {}) {
  const url = validPageUrl(rawUrl)
  const requestedPageId = String(options.pageId || '')
  const pageId = /^dp_[A-Za-z0-9_-]{4,80}$/.test(requestedPageId)
    ? requestedPageId
    : `dp_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
  const browserSession = webSession()
  const view = new WebContentsView({
    webPreferences: {
      session: browserSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })
  view.setBackgroundColor('#ffffff')
  view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
  view.setVisible(false)
  mainWindow.contentView.addChildView(view)
  const entry = {
    pageId,
    view,
    visible: false,
    favicon: '',
    sessionId: String(options.sessionId || activeChatSessionId || ''),
  }
  browserViews.set(pageId, entry)
  wireBrowserView(pageId, view)
  view.webContents.loadURL(url).catch(() => undefined)
  if (options.activate !== false) activeBrowserPageId = pageId
  const state = currentState(pageId, {
    url,
    activate: options.activate !== false,
    openerPageId: String(options.openerPageId || ''),
    disposition: String(options.disposition || ''),
  })
  persistBrowserTabsSoon()
  if (options.broadcast) {
    // 由页面自身 window.open / target=_blank 触发的新标签：让工作台把它加入标签栏。
    sendBrowserEvent('eab:browser-tab-open', state)
  }
  return state
}

function waitForWebContentsLoad(wc, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      wc.removeListener('did-stop-loading', finish)
      wc.removeListener('did-fail-load', finish)
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    wc.once('did-stop-loading', finish)
    wc.once('did-fail-load', finish)
  })
}

async function navigateNativePage(pageId, rawAction, rawUrl) {
  const entry = browserViews.get(pageId)
  if (!entry) throw new Error('页面不存在或已关闭')
  const action = validAction(rawAction)
  const wc = entry.view.webContents
  if (action === 'navigate') {
    const url = validPageUrl(rawUrl)
    await wc.loadURL(url)
  } else if (action === 'back') {
    if (wc.navigationHistory.canGoBack()) {
      const settled = waitForWebContentsLoad(wc)
      wc.navigationHistory.goBack()
      await settled
    }
  } else if (action === 'forward') {
    if (wc.navigationHistory.canGoForward()) {
      const settled = waitForWebContentsLoad(wc)
      wc.navigationHistory.goForward()
      await settled
    }
  } else if (action === 'reload') {
    const settled = waitForWebContentsLoad(wc)
    wc.reload()
    await settled
  }
  return currentState(pageId)
}

function browserTargetEntry(rawPageId, sessionId = '') {
  const scope = String(sessionId || '')
  const pageId = String(rawPageId || '').trim() || activeBrowserPageId || ''
  let entry = browserViews.get(pageId)
  if (!entry && !rawPageId) {
    entry = [...browserViews.values()].find(
      (item) => !scope || String(item.sessionId || '') === scope,
    )
  }
  if (!entry) throw Object.assign(new Error('右侧没有可操作的浏览器标签页'), { code: 'not_found' })
  if (scope && String(entry.sessionId || '') !== scope) {
    throw Object.assign(new Error('该标签页不属于当前对话'), { code: 'not_found' })
  }
  return entry
}

const NATIVE_SNAPSHOT_SCRIPT = `(() => {
  const textLimit = 8000
  const maxElements = 80
  const compact = (value, max) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, max)
  const visible = (el) => {
    const rect = el.getBoundingClientRect()
    const style = window.getComputedStyle(el)
    return rect.width > 2 && rect.height > 2 && style.display !== 'none' && style.visibility !== 'hidden'
  }
  const selector = 'a,button,input,select,textarea,summary,[role="button"],[role="link"],[contenteditable="true"]'
  const nodes = [...document.querySelectorAll(selector)].filter(visible).slice(0, maxElements)
  const elements = nodes.map((el, index) => {
    const ref = 'e' + (index + 1)
    el.setAttribute('data-eab-ref', ref)
    const tag = String(el.tagName || '').toLowerCase()
    const type = tag === 'input' ? compact(el.getAttribute('type') || 'text', 20) : null
    const role = tag === 'a' ? 'link'
      : tag === 'button' ? 'button'
        : tag === 'input' ? 'input'
          : tag === 'textarea' ? 'textbox'
            : tag === 'select' ? 'combobox'
              : String(el.getAttribute('role') || tag)
    const rawName = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.value || el.getAttribute('title') || ''
    return {
      ref,
      role,
      name: compact(rawName, 100),
      tag,
      type,
      value: tag === 'input' || tag === 'textarea' || tag === 'select' ? compact(el.value, 120) : null,
    }
  })
  const rawText = String(document.body?.innerText || '')
  const text = rawText.replace(/\\n{3,}/g, '\\n\\n').trim()
  return {
    title: String(document.title || ''),
    url: String(location.href || ''),
    text: text.slice(0, textLimit),
    truncated: text.length > textLimit,
    elements,
  }
})()`

async function snapshotNativePage(pageId, action, extra = {}) {
  const entry = browserTargetEntry(pageId)
  const wc = entry.view.webContents
  let info = { title: '', url: wc.getURL(), text: '', elements: [], truncated: false }
  try {
    const value = await wc.executeJavaScript(NATIVE_SNAPSHOT_SCRIPT, true)
    if (value && typeof value === 'object') info = value
  } catch {
    // 错误页 / 受限页可能拒绝脚本；仍返回标题和网址，让 Agent知道页面状态。
  }
  const state = currentState(entry.pageId) || {}
  return {
    action,
    pageId: entry.pageId,
    title: String(info.title || state.title || ''),
    url: String(info.url || state.url || ''),
    text: String(info.text || ''),
    elements: Array.isArray(info.elements) ? info.elements : [],
    screenshot: null,
    truncated: Boolean(info.truncated),
    closed: false,
    hint: null,
    native: true,
    ...extra,
  }
}

async function clickNativeRef(entry, ref) {
  const targetRef = String(ref || '').trim()
  if (!/^e[0-9]{1,4}$/.test(targetRef)) throw Object.assign(new Error('元素引用无效，请重新 snapshot'), { code: 'validation' })
  const check = await entry.view.webContents.executeJavaScript(`(() => {
    const node = document.querySelector('[data-eab-ref="${targetRef}"]')
    if (!node) return { ok: false, code: 'not_found', message: '页面元素已变化，请重新 snapshot' }
    const tag = String(node.tagName || '').toLowerCase()
    const type = String(node.type || node.getAttribute('type') || '').toLowerCase()
    const inForm = Boolean(node.closest('form'))
    if (tag === 'select' || tag === 'textarea') return { ok: false, code: 'validation', message: '该元素不支持直接点击' }
    if (tag === 'button' && (inForm || type === 'submit')) return { ok: false, code: 'validation', message: '不允许提交表单' }
    if (tag === 'input' && type !== 'button') return { ok: false, code: 'validation', message: '该输入框不支持直接点击，请用 type' }
    node.scrollIntoView({ block: 'center' })
    node.focus()
    node.click()
    return { ok: true }
  })()`, true)
  if (!check?.ok) throw Object.assign(new Error(String(check?.message || '点击失败')), { code: check?.code || 'validation' })
}

async function typeNativeRef(entry, ref, text) {
  const targetRef = String(ref || '').trim()
  if (!/^e[0-9]{1,4}$/.test(targetRef)) throw Object.assign(new Error('元素引用无效，请重新 snapshot'), { code: 'validation' })
  const value = String(text || '')
  if (!value.trim()) throw Object.assign(new Error('输入内容不能为空'), { code: 'validation' })
  if (value.length > 500) throw Object.assign(new Error('输入内容过长（最多 500 字）'), { code: 'validation' })
  const check = await entry.view.webContents.executeJavaScript(`(() => {
    const node = document.querySelector('[data-eab-ref="${targetRef}"]')
    if (!node) return { ok: false, code: 'not_found', message: '页面元素已变化，请重新 snapshot' }
    const tag = String(node.tagName || '').toLowerCase()
    const type = String(node.type || node.getAttribute('type') || '').toLowerCase()
    if (tag !== 'input' && tag !== 'textarea') return { ok: false, code: 'validation', message: '只能向搜索框或文本框输入内容' }
    if (tag === 'input' && !['search', 'text', 'url'].includes(type)) return { ok: false, code: 'validation', message: '该输入框类型不允许自动输入' }
    node.scrollIntoView({ block: 'center' })
    node.focus()
    if (typeof node.select === 'function') node.select()
    return { ok: true }
  })()`, true)
  if (!check?.ok) throw Object.assign(new Error(String(check?.message || '输入失败')), { code: check?.code || 'validation' })
  await entry.view.webContents.insertText(value)
}

async function scrollNativePage(entry, direction) {
  const delta = direction === 'up' ? -600 : 600
  await entry.view.webContents.executeJavaScript(`window.scrollBy(0, ${delta})`, true)
}

async function screenshotNativePage(entry) {
  const image = await entry.view.webContents.capturePage()
  const buffer = image.toPNG()
  const size = image.getSize()
  return {
    base64: buffer.toString('base64'),
    mime: 'image/png',
    width: size.width,
    height: size.height,
  }
}

function browserRefErrorStatus(code) {
  if (code === 'not_found') return 'not_found'
  if (code === 'forbidden') return 'forbidden'
  if (code === 'conflict') return 'conflict'
  return 'validation'
}

async function executeNativeBrowserJob(job) {
  const args = job?.args && typeof job.args === 'object' ? job.args : {}
  const action = String(args.action || 'snapshot').trim()
  const sessionId = String(args.sessionId || activeChatSessionId || '')
  try {
    if (action === 'list') {
      const payload = browserTabsPayload(sessionId)
      const active = payload.tabs.find((tab) => tab.pageId === payload.activePageId)
      return {
        ok: true,
        result: {
          action,
          pageId: payload.activePageId || null,
          title: active?.title || '',
          url: active?.url || '',
          text: payload.tabs.length === 0
            ? '右侧浏览器当前没有标签页。'
            : `右侧浏览器共有 ${payload.tabs.length} 个标签页：${payload.tabs.map((tab, index) => `${index + 1}. ${tab.active ? '[当前] ' : ''}${tab.title || '未命名页面'} ${tab.url}`).join('；')}`,
          elements: [],
          screenshot: null,
          truncated: false,
          closed: false,
          hint: null,
          native: true,
          activePageId: payload.activePageId,
          tabs: payload.tabs,
        },
      }
    }
    if (action === 'open') {
      const rawUrl = String(args.url || '').trim()
      if (!rawUrl) throw Object.assign(new Error('打开网页需要 url'), { code: 'validation' })
      const state = await openNativePage(rawUrl, {
        broadcast: true,
        activate: true,
        sessionId,
      })
      const entry = browserViews.get(state.pageId)
      await waitForWebContentsLoad(entry.view.webContents)
      return { ok: true, result: await snapshotNativePage(state.pageId, 'open') }
    }
    const entry = browserTargetEntry(args.pageId, sessionId)
    if (action === 'activate') {
      const payload = browserTabsPayload(sessionId)
      setActiveBrowserPage(entry.pageId)
      sendBrowserEvent('eab:browser-activate', { pageId: entry.pageId, tabs: payload.tabs })
      return { ok: true, result: await snapshotNativePage(entry.pageId, 'activate') }
    }
    if (action === 'snapshot') {
      return { ok: true, result: await snapshotNativePage(entry.pageId, 'snapshot') }
    }
    if (action === 'click') {
      await clickNativeRef(entry, args.ref)
      await new Promise((resolve) => setTimeout(resolve, 300))
      return { ok: true, result: await snapshotNativePage(entry.pageId, 'click') }
    }
    if (action === 'type') {
      await typeNativeRef(entry, args.ref, args.text)
      await new Promise((resolve) => setTimeout(resolve, 120))
      return { ok: true, result: await snapshotNativePage(entry.pageId, 'type') }
    }
    if (action === 'scroll') {
      await scrollNativePage(entry, args.direction === 'up' ? 'up' : 'down')
      await new Promise((resolve) => setTimeout(resolve, 200))
      return { ok: true, result: await snapshotNativePage(entry.pageId, 'scroll') }
    }
    if (action === 'navigate' || action === 'back' || action === 'forward' || action === 'reload') {
      setActiveBrowserPage(entry.pageId)
      await navigateNativePage(entry.pageId, action, args.url)
      return { ok: true, result: await snapshotNativePage(entry.pageId, action) }
    }
    if (action === 'screenshot') {
      const shot = await screenshotNativePage(entry)
      return {
        ok: true,
        result: {
          ...(await snapshotNativePage(entry.pageId, 'screenshot')),
          screenshotBase64: shot.base64,
          screenshotMime: shot.mime,
          screenshotWidth: shot.width,
          screenshotHeight: shot.height,
        },
      }
    }
    if (action === 'close') {
      const pageId = entry.pageId
      browserViews.delete(pageId)
      try {
        entry.view.webContents.close()
      } catch {
        // 已销毁忽略
      }
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(entry.view)
      if (activeBrowserPageId === pageId) activeBrowserPageId = [...browserViews.keys()][0] || ''
      persistBrowserTabsSoon()
      return {
        ok: true,
        result: {
          action: 'close', pageId, title: null, url: null, text: null, elements: [],
          screenshot: null, truncated: false, closed: true, hint: null, native: true,
        },
      }
    }
    throw Object.assign(new Error(`不支持的浏览器操作：${action}`), { code: 'validation' })
  } catch (error) {
    return {
      ok: false,
      error: {
        status: browserRefErrorStatus(error?.code),
        message: String(error?.message || error),
        hint: '桌面右侧浏览器操作失败；确认标签页仍打开，并在页面变化后重新 snapshot。',
      },
    }
  }
}

async function applyDesktopSessionCookie() {
  // 仅用于本机自动化验收：显式传 EAB_DESKTOP_COOKIE 时注入当前员工会话。
  // 打包后的正式应用不走这个分支，正常由用户在窗口内登录。
  if (app.isPackaged) return
  const raw = String(process.env.EAB_DESKTOP_COOKIE || '').trim()
  if (!raw) return
  const origin = new URL(chatUrl).origin
  await webSession().cookies.set({
    url: origin,
    name: 'eab_session',
    value: raw,
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
  })
}

/* -------------------------------------------------------------------------- */
/* 桌面自动更新：版本清单、下载、SHA256 校验和静默安装。更新源固定为登录的 EAB 服务器。 */
/* -------------------------------------------------------------------------- */

const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
const UPDATE_STARTUP_DELAY_MS = 12 * 1000
let updateTimer = null
let updateStartupTimer = null
let updateChecking = false
let updateDialogOpen = false
let updatePromptedFor = ''
let updateDownloading = false
let updateState = {
  status: 'idle',
  current: app.getVersion(),
  latest: '',
  version: '',
  progress: 0,
  received: 0,
  total: 0,
  error: '',
}

function versionParts(value) {
  const parts = String(value || '').match(/\d+/g)
  return parts ? parts.map((part) => Number(part)) : []
}

function compareVersions(left, right) {
  const a = versionParts(left)
  const b = versionParts(right)
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const x = a[index] ?? 0
    const y = b[index] ?? 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

function serverBaseUrl() {
  if (!chatUrl) return ''
  try {
    const parsed = new URL(chatUrl)
    parsed.search = ''
    parsed.hash = ''
    if (!parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, parsed.pathname.lastIndexOf('/') + 1) || '/'
    }
    return parsed.href
  } catch {
    return ''
  }
}

function sendUpdateState(patch = {}) {
  updateState = { ...updateState, ...patch }
  sendBrowserEvent('eab:update-state', updateState)
  return updateState
}

function setTaskbarProgress(value) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    mainWindow.setProgressBar(value)
  } catch {
    // 某些窗口状态下不支持任务栏进度，忽略即可。
  }
}

function resolveUpdateDownloadUrl(raw) {
  const base = serverBaseUrl()
  if (!base) throw new Error('尚未配置 EAB 服务器')
  const baseUrl = new URL(base)
  const target = new URL(String(raw || '/download/desktop/setup'), baseUrl)
  // 更新必须来自当前登录的 EAB 服务器，避免被服务端元数据带到第三方地址。
  if (target.origin !== baseUrl.origin) throw new Error('更新地址必须来自当前 EAB 服务器')
  return target.href
}

async function fetchUpdateInfo() {
  const base = serverBaseUrl()
  if (!base) throw new Error('尚未配置 EAB 服务器')
  const url = new URL('api/desktop/update', base)
  url.searchParams.set('platform', 'win32')
  url.searchParams.set('arch', 'x64')
  url.searchParams.set('currentVersion', app.getVersion())
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(`更新检查失败（HTTP ${response.status}）`)
    const payload = await response.json()
    const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload
    if (!data || !data.version) throw new Error('服务器没有返回桌面版本信息')
    return {
      version: String(data.version),
      current: String(data.currentVersion || app.getVersion()),
      hasUpdate: Boolean(data.hasUpdate) || compareVersions(String(data.version), app.getVersion()) > 0,
      downloadUrl: String(data.downloadUrl || '/download/desktop/setup'),
      fileName: String(data.fileName || data.file || ''),
      size: Number(data.size) || 0,
      sha256: String(data.sha256 || ''),
      publishedAt: String(data.publishedAt || ''),
      notes: String(data.notes || ''),
      mandatory: Boolean(data.mandatory),
    }
  } finally {
    clearTimeout(timer)
  }
}

async function showUpdatePrompt(info) {
  if (updateDialogOpen || !mainWindow || mainWindow.isDestroyed()) return
  updateDialogOpen = true
  try {
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'EAB 有新版本',
      message: `发现 EAB 桌面版 v${info.version}`,
      detail: [
        `当前版本：v${app.getVersion()} → 新版本：v${info.version}`,
        info.publishedAt ? `发布时间：${info.publishedAt}` : '',
        info.size ? `安装包大小：${(info.size / 1024 / 1024).toFixed(1)} MB` : '',
        '',
        '更新来自当前登录的 EAB 服务器；下载完成后会校验 SHA256，再启动安装程序。',
        info.notes ? `\n${info.notes}` : '',
      ].filter(Boolean).join('\n'),
      buttons: ['下载并安装', '稍后'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    if (result.response === 0) void downloadUpdate(info)
  } finally {
    updateDialogOpen = false
  }
}

async function checkForUpdates(options = {}) {
  const interactive = Boolean(options.interactive)
  if (!chatUrl) {
    return sendUpdateState({ status: 'unconfigured', current: app.getVersion(), error: '' })
  }
  if (updateChecking || updateDownloading) return updateState
  updateChecking = true
  sendUpdateState({ status: 'checking', current: app.getVersion(), error: '' })
  try {
    const info = await fetchUpdateInfo()
    if (info.hasUpdate) {
      const state = sendUpdateState({
        status: 'available',
        current: app.getVersion(),
        latest: info.version,
        version: info.version,
        downloadUrl: info.downloadUrl,
        fileName: info.fileName,
        size: info.size,
        sha256: info.sha256,
        publishedAt: info.publishedAt,
        notes: info.notes,
        mandatory: info.mandatory,
        error: '',
      })
      if (interactive || updatePromptedFor !== info.version) {
        updatePromptedFor = info.version
        void showUpdatePrompt(info)
      }
      return state
    }
    const state = sendUpdateState({
      status: 'current',
      current: app.getVersion(),
      latest: info.version,
      version: info.version,
      error: '',
    })
    if (interactive) {
      await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'EAB 已是最新版本',
        message: `当前已是最新版本 v${app.getVersion()}`,
        buttons: ['知道了'],
        noLink: true,
      })
    }
    return state
  } catch (error) {
    const message = String(error?.message || error)
    const state = sendUpdateState({ status: 'error', current: app.getVersion(), error: message })
    if (interactive) {
      await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: '检查更新失败',
        message: '暂时无法从当前 EAB 服务器检查桌面版本',
        detail: message,
        buttons: ['知道了'],
        noLink: true,
      })
    }
    return state
  } finally {
    updateChecking = false
  }
}

function safeUpdateFileName(info) {
  const raw = String(info.fileName || `EAB-Setup-${info.version}-x64.exe`)
  const name = path.basename(raw).replace(/[^a-zA-Z0-9._-]/g, '_')
  return name.toLowerCase().endsWith('.exe') ? name : `EAB-Setup-${info.version}-x64.exe`
}

async function downloadUpdate(info) {
  if (updateDownloading || !info?.version) return updateState
  updateDownloading = true
  const updatesDir = path.join(app.getPath('userData'), 'updates')
  const target = path.join(updatesDir, safeUpdateFileName(info))
  const part = `${target}.part`
  mkdirSync(updatesDir, { recursive: true })
  rmSync(part, { force: true })
  setTaskbarProgress(2)
  sendUpdateState({
    status: 'downloading',
    version: info.version,
    latest: info.version,
    progress: 0,
    received: 0,
    total: Number(info.size) || 0,
    error: '',
  })
  let stream = null
  try {
    const response = await fetch(resolveUpdateDownloadUrl(info.downloadUrl), {
      headers: { accept: 'application/octet-stream' },
      cache: 'no-store',
    })
    if (!response.ok || !response.body) throw new Error(`下载更新失败（HTTP ${response.status}）`)
    const total = Number(response.headers.get('content-length')) || Number(info.size) || 0
    stream = createWriteStream(part)
    const hash = crypto.createHash('sha256')
    let received = 0
    let lastEmit = 0
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk)
      stream.write(buffer)
      hash.update(buffer)
      received += buffer.length
      const now = Date.now()
      if (now - lastEmit > 250) {
        lastEmit = now
        const progress = total > 0 ? Math.min(1, received / total) : 0
        setTaskbarProgress(total > 0 ? progress : 2)
        sendUpdateState({ status: 'downloading', received, total, progress })
      }
    }
    stream.end()
    await finished(stream)
    stream = null
    if (total > 0 && received !== total) throw new Error(`更新包不完整（${received}/${total} 字节）`)
    const digest = hash.digest('hex').toLowerCase()
    if (info.sha256 && digest !== String(info.sha256).toLowerCase()) {
      throw new Error('更新包 SHA256 校验失败，已删除下载文件')
    }
    renameSync(part, target)
    setTaskbarProgress(-1)
    const state = sendUpdateState({
      status: 'ready',
      version: info.version,
      latest: info.version,
      installedFile: target,
      received,
      total: total || received,
      progress: 1,
      error: '',
    })
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'EAB 更新已下载',
      message: `EAB v${info.version} 已下载完成`,
      detail: '点击“立即重启并安装”后，EAB 会关闭，安装程序静默升级，完成后自动重新打开。安装过程可能出现 Windows 管理员权限提示。',
      buttons: ['立即重启并安装', '稍后'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    if (result.response === 0) applyUpdate(target)
    return state
  } catch (error) {
    setTaskbarProgress(-1)
    if (stream) {
      try {
        stream.destroy()
      } catch {
        // 忽略
      }
    }
    rmSync(part, { force: true })
    const message = String(error?.message || error)
    const state = sendUpdateState({ status: 'error', error: message })
    await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '更新下载失败',
      message: 'EAB 桌面版更新没有完成',
      detail: message,
      buttons: ['知道了'],
      noLink: true,
    })
    return state
  } finally {
    updateDownloading = false
  }
}

function applyUpdate(installerPath) {
  if (!installerPath || !existsSync(installerPath)) return { started: false, error: '更新安装包不存在' }
  const scriptPath = path.join(app.getPath('userData'), 'updates', 'apply-update.ps1')
  const script = `param([string]$Installer)
$ErrorActionPreference = 'Stop'
$log = Join-Path $PSScriptRoot 'apply-update.log'
try {
  # 安装器需要管理员权限；当前 EAB 以普通用户运行时，RunAs 会触发一次 UAC 确认。
  $process = Start-Process -FilePath $Installer -ArgumentList '/S' -Verb RunAs -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    "installer exit $($process.ExitCode)" | Out-File -FilePath $log -Encoding utf8
    exit $process.ExitCode
  }
  $installDir = (Get-ItemProperty -Path 'HKLM:\\Software\\EAB' -Name InstallDir).InstallDir
  Start-Process -FilePath (Join-Path $installDir 'EAB.exe')
  "ok" | Out-File -FilePath $log -Encoding utf8
} catch {
  ($_.Exception.Message) | Out-File -FilePath $log -Encoding utf8
  exit 1
}
`
  mkdirSync(path.dirname(scriptPath), { recursive: true })
  writeFileSync(scriptPath, script, 'utf8')
  try {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath, '-Installer', installerPath],
      { detached: true, stdio: 'ignore', windowsHide: true },
    )
    child.unref()
  } catch (error) {
    return { started: false, error: String(error?.message || error) }
  }
  setTimeout(() => app.quit(), 700)
  return { started: true }
}

function scheduleUpdateChecks() {
  if (updateStartupTimer) clearTimeout(updateStartupTimer)
  if (updateTimer) clearInterval(updateTimer)
  updateStartupTimer = null
  updateTimer = null
  if (!chatUrl) return
  updateStartupTimer = setTimeout(() => {
    updateStartupTimer = null
    void checkForUpdates({ interactive: false })
  }, UPDATE_STARTUP_DELAY_MS)
  updateTimer = setInterval(() => {
    void checkForUpdates({ interactive: false })
  }, UPDATE_CHECK_INTERVAL_MS)
}

function destroyAllViews() {
  for (const entry of browserViews.values()) {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.contentView.removeChildView(entry.view)
      }
      entry.view.webContents.close()
    } catch {
      // 已销毁时忽略
    }
  }
  browserViews.clear()
}

async function loadChatPage() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (!chatUrl) {
    await mainWindow.loadFile(path.join(here, 'setup.html'))
    return
  }
  destroyAllViews()
  await mainWindow.loadURL(chatUrl).catch((err) => {
    const message = String(err?.message || err)
    return mainWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(
        `<body style="font-family:system-ui;padding:40px;color:#333"><h2>连接 EAB 服务失败</h2><p>当前地址：${chatUrl}</p><p>请确认服务已启动、网络可达，然后在桌面窗口里重新配置服务器。</p><pre>${message}</pre></body>`,
      )}`,
    )
  })
}

async function createWindow() {
  chatUrl = readConfiguredChatUrl()
  if (chatUrl) await applyDesktopSessionCookie()
  // Windows 默认菜单会把 Ctrl+W 注册成“关闭窗口”加速键，导致网页标签的 Ctrl+W 永远收不到。
  // EAB 自己接管浏览器快捷键，所以直接移除默认应用菜单。
  if (process.platform === 'win32') Menu.setApplicationMenu(null)
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#f7f8fa',
    title: 'EAB',
    icon: existsSync(APP_ICON) ? APP_ICON : undefined,
    show: false,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      session: webSession(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow.setMenuBarVisibility(false)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // 聊天页里的文档/外链仍允许打开系统浏览器；OAuth 类弹窗不在这里处理。
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.once('ready-to-show', () => mainWindow.show())
  // 主页面刷新时不要销毁右侧标签页：标签页本体在 Electron 主进程里，
  // 刷新只重建聊天页面。这里先隐藏，等新页面通过 eab:browser-tabs 取回并重新绑定。
  mainWindow.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) hideAllViews()
  })
  mainWindow.webContents.on('render-process-gone', () => {
    if (browserViews.size > 0) persistBrowserTabsNow()
    destroyAllViews()
    browserTabsRestored = false
  })
  // 地址栏 / 新标签输入框在主窗口渲染进程里，原生页的 before-input-event 接不到；
  // 主窗口也补一份快捷键，chat.js 用 scope=shell 判断网页工作台是否在前台。
  mainWindow.webContents.on('before-input-event', (event, input) => {
    handleWindowBrowserShortcut(event, input)
  })
  await loadChatPage()
  scheduleUpdateChecks()
  restartDesktopBridge()
  mainWindow.on('closed', () => {
    // 退出前同步落盘一次，避免最后一个标签页的防抖保存还没执行。
    if (browserViews.size > 0) persistBrowserTabsNow()
    destroyAllViews()
    stopDesktopBridge()
    mainWindow = null
  })
}

ipcMain.handle('eab:server-info', () => ({
  serverUrl: chatUrl,
  version: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
}))

ipcMain.handle('eab:save-server', async (_event, rawUrl) => {
  const url = normalizeChatUrl(rawUrl)
  const changed = url !== chatUrl
  chatUrl = url
  updatePromptedFor = ''
  saveConfiguredChatUrl(url)
  if (changed) clearPersistedBrowserTabs()
  // Chromium 的可信来源开关必须在进程启动前写入。
  // 如果用户是在首次配置页把服务从 HTTPS 改成内网 HTTP，先把配置落盘再重启一次，
  // 否则当前进程没有 mediaDevices，语音按钮会一直是灰的。
  const nextInsecureOrigin = insecureChatOrigin(url)
  if (nextInsecureOrigin && nextInsecureOrigin !== startupInsecureOrigin) {
    setTimeout(() => {
      app.relaunch()
      app.exit(0)
    }, 150)
    return { serverUrl: url, restarting: true }
  }
  await loadChatPage()
  scheduleUpdateChecks()
  restartDesktopBridge()
  return { serverUrl: url }
})

ipcMain.handle('eab:open-server-settings', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return { opened: false }
  destroyAllViews()
  await mainWindow.loadFile(path.join(here, 'setup.html'))
  return { opened: true }
})

ipcMain.handle('eab:get-server', () => ({ serverUrl: chatUrl }))

/**
 * 本地项目目录选择：文件夹选择框在桌面客户端所在机器弹出，
 * 返回真实绝对路径给网页；服务端只接受已存在且可写的目录。
 */
ipcMain.handle('eab:desktop-info', () => desktopInfo())

ipcMain.handle('eab:bind-project', (_event, payload) => {
  try {
    const projectId = String(payload?.projectId || '').trim()
    const rootPath = String(payload?.rootPath || '').trim()
    if (!projectId || !rootPath) return { ok: false, error: '项目或目录为空' }
    const saved = ensureLocalProjectFs().bind(projectId, rootPath)
    return { ok: true, projectId, rootPath: saved.rootRealPath, name: saved.name }
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }
})

ipcMain.handle('eab:unbind-project', (_event, projectId) => {
  try {
    return { ok: true, ...ensureLocalProjectFs().unbind(projectId) }
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }
})

ipcMain.handle('eab:sync-projects', (_event, projects) => {
  const fs = ensureLocalProjectFs()
  const saved = []
  const rejected = []
  for (const item of Array.isArray(projects) ? projects : []) {
    const projectId = String(item?.id || '').trim()
    const rootPath = String(item?.rootPath || '').trim()
    if (!projectId || !rootPath) continue
    try {
      const binding = fs.bind(projectId, rootPath)
      saved.push({ projectId, rootPath: binding.rootRealPath })
    } catch (error) {
      rejected.push({ projectId, error: String(error?.message || error) })
    }
  }
  return { ok: true, saved, rejected }
})

ipcMain.handle('eab:pick-directory', async (_event, options) => {
  const parent = BrowserWindow.getFocusedWindow() || mainWindow
  const config = {
    title: String(options?.title || '选择本地项目文件夹'),
    buttonLabel: '选择此文件夹',
    properties: ['openDirectory', 'createDirectory'],
  }
  const defaultPath = String(options?.defaultPath || '').trim()
  if (defaultPath) config.defaultPath = defaultPath
  const result = parent && !parent.isDestroyed()
    ? await dialog.showOpenDialog(parent, config)
    : await dialog.showOpenDialog(config)
  if (result.canceled || result.filePaths.length === 0) return { canceled: true, path: '' }
  const chosen = result.filePaths[0]
  return { canceled: false, path: chosen, name: path.basename(chosen) }
})

ipcMain.handle('eab:open-path', async (_event, targetPath) => {
  const target = String(targetPath || '').trim()
  if (!target) return { ok: false, error: '路径为空' }
  if (!existsSync(target)) return { ok: false, error: '路径不存在' }
  // 只允许打开文件夹：避免网页侧借 shell.openPath 启动任意可执行文件。
  let stat
  try {
    stat = statSync(target)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '无法访问路径' }
  }
  if (!stat.isDirectory()) return { ok: false, error: '只允许打开文件夹' }
  const error = await shell.openPath(target)
  return error ? { ok: false, error } : { ok: true }
})

ipcMain.handle('eab:reveal-path', async (_event, targetPath) => {
  const target = String(targetPath || '').trim()
  if (!target) return { ok: false, error: '路径为空' }
  if (!existsSync(target)) return { ok: false, error: '路径不存在' }
  // 在资源管理器里定位文件或文件夹，不直接执行目标。
  shell.showItemInFolder(target)
  return { ok: true }
})

ipcMain.handle('eab:update-check', () => checkForUpdates({ interactive: true }))
ipcMain.handle('eab:update-download', async () => {
  if (updateState.status === 'ready') return updateState
  if (!updateState.latest) return checkForUpdates({ interactive: true })
  return downloadUpdate(updateState)
})
ipcMain.handle('eab:update-apply', () => applyUpdate(updateState.installedFile))

ipcMain.handle('eab:open', (_event, url) => openNativePage(url))
ipcMain.handle('eab:navigate', (_event, pageId, action, url) => navigateNativePage(String(pageId || ''), action, url))
ipcMain.handle('eab:close', (_event, pageId) => {
  const entry = browserViews.get(String(pageId || ''))
  if (!entry) return { closed: true }
  browserViews.delete(entry.pageId)
  try {
    entry.view.webContents.close()
  } catch {
    // 已销毁时忽略
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(entry.view)
  if (activeBrowserPageId === entry.pageId) {
    activeBrowserPageId = [...browserViews.values()].find(
      (item) => String(item.sessionId || '') === String(entry.sessionId || ''),
    )?.pageId || ''
  }
  persistBrowserTabsSoon()
  return { closed: true, pageId: String(pageId || '') }
})

ipcMain.handle('eab:browser-tabs', async (_event, userId, sessionId) => {
  await restoreBrowserTabsIfNeeded(String(userId || ''), String(sessionId || ''))
  return browserTabsPayload(String(sessionId || activeChatSessionId || ''))
})

ipcMain.handle('eab:set-browser-session', (_event, sessionId) => {
  const payload = setActiveChatSession(String(sessionId || ''))
  reportBrowserTabsSoon()
  return payload
})

/**
 * 草稿首条消息落库后，把空白草稿（sessionId 为空）的原生标签整体改归正式会话。
 * 只接收明确列出的 pageId，避免把其它对话的标签误收养。
 */
ipcMain.handle('eab:adopt-browser-session', (_event, sessionId, pageIds) => {
  const target = String(sessionId || '')
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(target)) {
    return { ok: false, error: '会话标识无效' }
  }
  const wanted = new Set(
    (Array.isArray(pageIds) ? pageIds : [])
      .map((id) => String(id || ''))
      .filter((id) => /^[A-Za-z0-9_-]{1,120}$/.test(id)),
  )
  const adopted = []
  for (const entry of browserViews.values()) {
    if (!wanted.has(entry.pageId)) continue
    if (String(entry.sessionId || '') !== '') continue
    entry.sessionId = target
    adopted.push(entry.pageId)
  }
  activeChatSessionId = target
  const activeEntry = browserViews.get(activeBrowserPageId)
  activeBrowserPageId = activeEntry && String(activeEntry.sessionId || '') === target
    ? activeBrowserPageId
    : adopted[0] || ''
  persistBrowserTabsSoon()
  reportBrowserTabsSoon()
  return { ok: true, adopted, ...browserTabsPayload(target) }
})

ipcMain.handle('eab:activate-tab', (_event, pageId) => {
  const target = String(pageId || '')
  const entry = browserViews.get(target)
  if (!entry) return { ok: false, error: '页面不存在或已关闭' }
  if (String(entry.sessionId || '') !== activeChatSessionId) {
    return { ok: false, error: '该标签页不属于当前对话' }
  }
  setActiveBrowserPage(target)
  sendBrowserEvent('eab:browser-activate', { pageId: target, tabs: browserTabsPayload().tabs })
  return { ok: true, pageId: target }
})

ipcMain.on('eab:bounds', (_event, payload) => {
  const entry = browserViews.get(String(payload?.pageId || ''))
  if (!entry) return
  if (String(entry.sessionId || '') !== activeChatSessionId) {
    entry.visible = false
    entry.view.setVisible(false)
    return
  }
  const rect = clampRect(payload?.rect)
  if (!rect || rect.width < 24 || rect.height < 24) {
    entry.visible = false
    entry.view.setVisible(false)
    return
  }
  entry.view.setBounds(rect)
  if (!entry.visible) {
    entry.visible = true
    entry.view.setVisible(true)
  }
})

ipcMain.on('eab:show', (_event, pageId) => {
  const target = String(pageId || '')
  const targetEntry = target ? browserViews.get(target) : null
  if (targetEntry && String(targetEntry.sessionId || '') !== activeChatSessionId) return
  for (const [id, entry] of browserViews) {
    const visible = id === target
    entry.visible = visible
    entry.view.setVisible(visible)
  }
  if (target && browserViews.has(target)) setActiveBrowserPage(target)
})

ipcMain.on('eab:hide-all', () => hideAllViews())

ipcMain.on('eab:focus-shell', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.focus()
})

ipcMain.on('eab:focus-page', (_event, pageId) => {
  const entry = browserViews.get(String(pageId || ''))
  if (!entry) return
  setActiveBrowserPage(entry.pageId)
  entry.view.webContents.focus()
})

// 仅开发态可用的自检口：返回窗口内容区与每个原生页的实时 bounds/可见性。
// 打包后的正式应用不暴露内部视图结构。
ipcMain.handle('eab:diagnostics', () => {
  if (app.isPackaged) return { ok: false, reason: 'packaged' }
  return {
    ok: true,
    window: mainWindow && !mainWindow.isDestroyed() ? mainWindow.getContentBounds() : null,
    views: [...browserViews.values()].map((entry) => ({
      pageId: entry.pageId,
      visible: entry.visible,
      bounds: entry.view.getBounds(),
      url: entry.view.webContents.getURL(),
      title: entry.view.webContents.getTitle(),
      favicon: entry.favicon || '',
      loading: entry.view.webContents.isLoading(),
    })),
  }
})

app.whenReady().then(async () => {
  if (PROBE) {
    // 冒烟探针：不开窗口，只验证 Electron 能启动并创建原生 WebContentsView。
    const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } })
    await view.webContents.loadURL('https://example.com/')
    console.log(JSON.stringify({ ok: true, title: view.webContents.getTitle(), url: view.webContents.getURL() }))
    app.quit()
    return
  }
  createWindow().catch((err) => {
    console.error('[eab-desktop] create window failed', err)
    app.quit()
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow().catch(() => undefined)
    }
  })
})

app.on('window-all-closed', () => {
  stopDesktopBridge()
  if (updateStartupTimer) clearTimeout(updateStartupTimer)
  if (updateTimer) clearInterval(updateTimer)
  if (process.platform !== 'darwin') app.quit()
})
