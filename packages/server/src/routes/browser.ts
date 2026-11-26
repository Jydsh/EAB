/**
 * 右侧“网页”工作台 API。
 *
 * 和 Agent 的 `browser` 工具共用同一套 Playwright 会话：同一用户、同一 Context，
 * 页面按 pageId 隔离。这里提供工作台需要的打开、前进后退、刷新、地址栏跳转、取帧、
 * 状态、人工点击/输入和关闭，不把密码、浏览器 Cookie 或完整正文回传给模型。
 */
import type { FastifyInstance } from 'fastify'
import { EC, EabError, SC } from '@eab/domain'
import { appendAudit } from '@eab/storage'
import type { ServerDeps } from '../deps.js'
import { ok, requireScope } from '../http.js'
import { resolveActor } from '../session.js'
import { browserNetworkSettingsView } from '../browser-network-config.js'
import {
  allowCredentialTransport,
  trustedCredentialProxyHosts,
} from '../browser-credential-transport.js'
import {
  deleteBrowserCredential,
  getBrowserCredentialStatus,
  readBrowserCredential,
  saveBrowserCredential,
} from '../browser-credentials.js'
import {
  deleteBrowserSession,
  getBrowserSessionStatus,
  readBrowserSessionState,
  saveBrowserSession,
} from '../browser-session-store.js'
import {
  browserPageState,
  captureBrowserPageFrame,
  captureBrowserPageStorageState,
  clickBrowserPageAt,
  executeBrowserAction,
  fillBrowserPageCredentials,
  navigateBrowserPageFast,
  openBrowserPageFast,
  pressBrowserPageKey,
  scrollBrowserPageBy,
  subscribeBrowserScreencast,
  typeBrowserPageText,
  warmBrowserSession,
  type BrowserResult,
  type BrowserScreenshot,
} from '../browser-session.js'

/** 工作台的 open/close 不产生截图文件；占位对象只在误触 screenshot 时才可能用到。 */
function noScreenshot(): BrowserScreenshot {
  return { fileId: '', name: '', relPath: '', size: 0, mime: 'image/jpeg' }
}

function ownerKeyOf(actor: ReturnType<typeof resolveActor>): string {
  return `${actor.subject.companyId}:${actor.subject.userId}`
}

/** 审计只落站点 origin，不带路径、查询参数或账号信息。 */
function safeOrigin(raw: string): string {
  try {
    const url = new URL(String(raw ?? ''))
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : ''
  } catch {
    return ''
  }
}

/** 远程保存站点密码必须走 HTTPS；本机回环直连保留开发便利。 */
function assertCredentialTransport(req: {
  socket: { remoteAddress?: string | null; encrypted?: boolean }
  headers: Record<string, unknown>
}): void {
  const allowed = allowCredentialTransport({
    peerAddress: req.socket.remoteAddress,
    encrypted: Boolean(req.socket.encrypted),
    headers: req.headers,
    trustedProxyHosts: trustedCredentialProxyHosts(),
  })
  if (!allowed) {
    throw new EabError(EC.FORBIDDEN, '远程保存站点密码必须使用 HTTPS', {
      hint: '请通过 HTTPS 反向代理访问；本机 127.0.0.1 直连不受影响。跨机反代需把代理 IP 写入 EAB_CREDENTIAL_PROXY_HOSTS',
    })
  }
}

function browserOptions(actor: ReturnType<typeof resolveActor>, dbPath: string) {
  const policy = browserNetworkSettingsView()
  let storageState = null
  try {
    storageState = readBrowserSessionState(dbPath, ownerKeyOf(actor))
  } catch {
    storageState = null
  }
  return {
    ownerKey: ownerKeyOf(actor),
    allowPrivateNetwork: policy.enabled,
    privateNetworkHosts: policy.enabled ? policy.allowedHosts : [],
    storageState,
    saveScreenshot: noScreenshot,
  }
}

function auditBrowser(
  deps: ServerDeps,
  actor: ReturnType<typeof resolveActor>,
  action: string,
  result: 'success' | 'failure',
  detail: Record<string, unknown>,
): void {
  appendAudit(deps.db, {
    companyId: actor.subject.companyId,
    actorUserId: actor.subject.userId,
    action,
    resourceType: 'browser_page',
    resourceId: String(detail.pageId ?? ''),
    resourceScope: `user:${actor.subject.userId}`,
    result,
    detail,
    channel: 'web',
  })
}

function auditCredential(
  deps: ServerDeps,
  actor: ReturnType<typeof resolveActor>,
  action: string,
  result: 'success' | 'failure',
  detail: Record<string, unknown>,
): void {
  appendAudit(deps.db, {
    companyId: actor.subject.companyId,
    actorUserId: actor.subject.userId,
    action,
    resourceType: 'browser_credential',
    resourceId: String(detail.origin ?? ''),
    resourceScope: `user:${actor.subject.userId}`,
    result,
    detail,
    channel: 'web',
  })
}

function auditBrowserSession(
  deps: ServerDeps,
  actor: ReturnType<typeof resolveActor>,
  action: string,
  result: 'success' | 'failure',
  detail: Record<string, unknown>,
): void {
  appendAudit(deps.db, {
    companyId: actor.subject.companyId,
    actorUserId: actor.subject.userId,
    action,
    resourceType: 'browser_session',
    resourceId: String(detail.origin ?? ''),
    resourceScope: `user:${actor.subject.userId}`,
    result,
    detail,
    channel: 'web',
  })
}

export function registerBrowserRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get<{ Querystring: { url?: string } }>('/api/browser/credentials', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireScope(actor.subject, SC.CHAT_USE)
    const url = String(req.query?.url ?? '')
    const status = getBrowserCredentialStatus(deps.config.dbPath, ownerKeyOf(actor), url)
    const session = getBrowserSessionStatus(deps.config.dbPath, ownerKeyOf(actor), url)
    return ok({ ...status, session })
  })

  app.post<{ Body: { url?: unknown; username?: unknown; password?: unknown } }>(
    '/api/browser/credentials',
    async (req) => {
      const actor = resolveActor(deps.db, deps.config, req)
      requireScope(actor.subject, SC.CHAT_USE)
      const url = String(req.body?.url ?? '')
      try {
        assertCredentialTransport(req)
        const status = saveBrowserCredential(
          deps.config.dbPath,
          ownerKeyOf(actor),
          url,
          String(req.body?.username ?? ''),
          String(req.body?.password ?? ''),
        )
        auditCredential(deps, actor, 'browser.credentials.save', 'success', {
          origin: status.origin,
        })
        return ok(status)
      } catch (err) {
        auditCredential(deps, actor, 'browser.credentials.save', 'failure', {
          origin: safeOrigin(url),
        })
        throw err
      }
    },
  )

  app.delete<{ Querystring: { url?: string } }>('/api/browser/credentials', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireScope(actor.subject, SC.CHAT_USE)
    const url = String(req.query?.url ?? '')
    try {
      const status = deleteBrowserCredential(deps.config.dbPath, ownerKeyOf(actor), url)
      auditCredential(deps, actor, 'browser.credentials.delete', 'success', {
        origin: status.origin,
      })
      return ok(status)
    } catch (err) {
      auditCredential(deps, actor, 'browser.credentials.delete', 'failure', {
        origin: safeOrigin(url),
      })
      throw err
    }
  })

  app.post<{ Params: { pageId: string } }>(
    '/api/browser/workspace/:pageId/save-session',
    async (req) => {
      const actor = resolveActor(deps.db, deps.config, req)
      requireScope(actor.subject, SC.CHAT_USE)
      let origin = ''
      try {
        assertCredentialTransport(req)
        const snapshot = await captureBrowserPageStorageState(req.params.pageId, ownerKeyOf(actor))
        origin = snapshot.origin
        const status = saveBrowserSession(
          deps.config.dbPath,
          ownerKeyOf(actor),
          origin,
          snapshot.storageState,
        )
        auditBrowserSession(deps, actor, 'browser.session.save', 'success', {
          origin: status.origin,
          cookieCount: status.cookieCount,
          localStorageCount: status.localStorageCount,
        })
        return ok(status)
      } catch (err) {
        auditBrowserSession(deps, actor, 'browser.session.save', 'failure', {
          origin: safeOrigin(origin),
        })
        throw err
      }
    },
  )

  app.delete<{ Querystring: { url?: string } }>('/api/browser/session', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireScope(actor.subject, SC.CHAT_USE)
    const url = String(req.query?.url ?? '')
    try {
      const status = deleteBrowserSession(deps.config.dbPath, ownerKeyOf(actor), url)
      auditBrowserSession(deps, actor, 'browser.session.delete', 'success', {
        origin: status.origin,
      })
      return ok(status)
    } catch (err) {
      auditBrowserSession(deps, actor, 'browser.session.delete', 'failure', {
        origin: safeOrigin(url),
      })
      throw err
    }
  })

  app.post<{ Params: { pageId: string } }>(
    '/api/browser/workspace/:pageId/fill-credentials',
    async (req) => {
      const actor = resolveActor(deps.db, deps.config, req)
      requireScope(actor.subject, SC.CHAT_USE)
      let origin = ''
      try {
        const state = await browserPageState(req.params.pageId, ownerKeyOf(actor))
        origin = String(state.url ?? '')
        const credential = readBrowserCredential(
          deps.config.dbPath,
          ownerKeyOf(actor),
          origin,
        )
        const result = await fillBrowserPageCredentials(
          req.params.pageId,
          ownerKeyOf(actor),
          credential.username,
          credential.password,
        )
        // 只记站点和 pageId；账号、密码和页面正文都不进审计。
        auditBrowser(deps, actor, 'browser.workspace.fill_credentials', 'success', {
          pageId: result.pageId,
          origin: credential.origin,
        })
        return ok(result)
      } catch (err) {
        auditBrowser(deps, actor, 'browser.workspace.fill_credentials', 'failure', {
          pageId: req.params.pageId,
          origin: safeOrigin(origin),
        })
        throw err
      }
    },
  )

  app.post<{ Body: { url?: unknown } }>('/api/browser/workspace/open', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireScope(actor.subject, SC.CHAT_USE)
    const url = String(req.body?.url ?? '').trim()
    if (!url) throw new EabError(EC.VALIDATION, '网址不能为空', { hint: '输入 http/https 网址后再打开' })
    if (url.length > 2_000) throw new EabError(EC.VALIDATION, '网址过长')

    let result: BrowserResult
    try {
      result = await executeBrowserAction({ action: 'open', url }, browserOptions(actor, deps.config.dbPath))
    } catch (err) {
      auditBrowser(deps, actor, 'browser.workspace.open', 'failure', { url })
      throw err
    }
    auditBrowser(deps, actor, 'browser.workspace.open', 'success', {
      pageId: result.pageId,
      url: result.url,
      title: result.title,
    })
    return ok(result)
  })

  /**
   * 工作台专用：先占标签页并返回 pageId，导航在后台继续。
   * 这样右侧可以在几十毫秒内显示“加载中”的浏览器画面，而不是等完整快照。
   */
  app.post<{ Body: { url?: unknown } }>('/api/browser/workspace/open-fast', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireScope(actor.subject, SC.CHAT_USE)
    const url = String(req.body?.url ?? '').trim()
    if (!url) throw new EabError(EC.VALIDATION, '网址不能为空', { hint: '输入 http/https 网址后再打开' })
    if (url.length > 2_000) throw new EabError(EC.VALIDATION, '网址过长')

    let result: BrowserResult
    try {
      result = await openBrowserPageFast(url, browserOptions(actor, deps.config.dbPath))
    } catch (err) {
      auditBrowser(deps, actor, 'browser.workspace.open', 'failure', { url })
      throw err
    }
    auditBrowser(deps, actor, 'browser.workspace.open', 'success', {
      pageId: result.pageId,
      url: result.url,
      async: true,
    })
    return ok(result)
  })

  app.post('/api/browser/workspace/warm', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireScope(actor.subject, SC.CHAT_USE)
    await warmBrowserSession(ownerKeyOf(actor), browserOptions(actor, deps.config.dbPath))
    return ok({ warmed: true })
  })

  app.post<{
    Params: { pageId: string }
    Body: { action?: unknown; url?: unknown }
  }>('/api/browser/workspace/:pageId/nav', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireScope(actor.subject, SC.CHAT_USE)
    const action = String(req.body?.action ?? '').trim()
    if (action !== 'back' && action !== 'forward' && action !== 'reload' && action !== 'navigate') {
      throw new EabError(EC.VALIDATION, '导航动作不支持', { hint: '可用 back / forward / reload / navigate' })
    }
    let result: BrowserResult
    try {
      result = await executeBrowserAction(
        {
          action,
          pageId: req.params.pageId,
          ...(action === 'navigate' ? { url: String(req.body?.url ?? '').trim() } : {}),
        },
        browserOptions(actor, deps.config.dbPath),
      )
    } catch (err) {
      auditBrowser(deps, actor, `browser.workspace.${action}`, 'failure', {
        pageId: req.params.pageId,
        ...(action === 'navigate' ? { url: String(req.body?.url ?? '').trim() } : {}),
      })
      throw err
    }
    auditBrowser(deps, actor, `browser.workspace.${action}`, 'success', {
      pageId: result.pageId,
      url: result.url,
      title: result.title,
    })
    return ok(result)
  })

  /** 工作台专用：导航动作先返回，页面加载过程由 screencast 实时上屏。 */
  app.post<{
    Params: { pageId: string }
    Body: { action?: unknown; url?: unknown }
  }>('/api/browser/workspace/:pageId/nav-fast', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireScope(actor.subject, SC.CHAT_USE)
    const action = String(req.body?.action ?? '').trim()
    if (action !== 'back' && action !== 'forward' && action !== 'reload' && action !== 'navigate') {
      throw new EabError(EC.VALIDATION, '导航动作不支持', { hint: '可用 back / forward / reload / navigate' })
    }
    let result: BrowserResult
    try {
      result = await navigateBrowserPageFast(
        req.params.pageId,
        ownerKeyOf(actor),
        action,
        action === 'navigate' ? String(req.body?.url ?? '').trim() : undefined,
        browserOptions(actor, deps.config.dbPath),
      )
    } catch (err) {
      auditBrowser(deps, actor, `browser.workspace.${action}`, 'failure', {
        pageId: req.params.pageId,
        ...(action === 'navigate' ? { url: String(req.body?.url ?? '').trim() } : {}),
      })
      throw err
    }
    auditBrowser(deps, actor, `browser.workspace.${action}`, 'success', {
      pageId: result.pageId,
      url: result.url,
      async: true,
    })
    return ok(result)
  })

  app.get<{ Params: { pageId: string } }>('/api/browser/workspace/:pageId', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireScope(actor.subject, SC.CHAT_USE)
    const result = await browserPageState(req.params.pageId, ownerKeyOf(actor))
    return ok(result)
  })

  app.get<{
    Params: { pageId: string }
    Querystring: { w?: string; h?: string }
  }>('/api/browser/workspace/:pageId/frame', async (req, reply) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireScope(actor.subject, SC.CHAT_USE)
    const width = Number(req.query.w)
    const height = Number(req.query.h)
    const frame = await captureBrowserPageFrame(
      req.params.pageId,
      ownerKeyOf(actor),
      Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
        ? { width, height }
        : undefined,
    )
    reply
      .header('cache-control', 'no-store')
      .header('x-eab-tile-width', String(frame.width))
      .header('x-eab-tile-height', String(frame.height))
      .header('x-eab-favicon', encodeURIComponent(frame.favicon))
      .type('image/jpeg')
      .send(frame.buffer)
  })

  /**
   * 实时画面流：CDP screencast 只在页面变化时推 JPEG 帧，滚动/加载接近本地浏览器。
   * EventSource 自带 cookie；断流时前端自动退回 `/frame` 轮询。
   */
  app.get<{
    Params: { pageId: string }
    Querystring: { w?: string; h?: string }
  }>('/api/browser/workspace/:pageId/stream', async (req, reply) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireScope(actor.subject, SC.CHAT_USE)
    const width = Number(req.query.w)
    const height = Number(req.query.h)
    const viewportHint =
      Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
        ? { width, height }
        : undefined

    reply.hijack()
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    reply.raw.write('retry: 1500\n\n')

    let closed = false
    let unsubscribe = () => {}
    let cleanup = () => {}
    const write = (chunk: string) => {
      if (closed) return
      try {
        reply.raw.write(chunk)
      } catch {
        cleanup()
      }
    }
    const heartbeat = setInterval(() => write(': ping\n\n'), 15_000)
    cleanup = () => {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      unsubscribe()
      try {
        reply.raw.end()
      } catch {
        // 客户端已断开
      }
    }

    try {
      unsubscribe = await subscribeBrowserScreencast(
        req.params.pageId,
        ownerKeyOf(actor),
        viewportHint,
        (jpegBase64) => {
          // 网络跟不上时丢帧而不是无限堆积，保持服务端内存稳定。
          if (reply.raw.writableLength > 1_000_000) return
          write(`event: frame\ndata: ${jpegBase64}\n\n`)
        },
      )
      write(`event: ready\ndata: ${JSON.stringify({ pageId: req.params.pageId })}\n\n`)
    } catch (err) {
      write(`event: error\ndata: ${JSON.stringify({ message: err instanceof Error ? err.message : '画面流失败' })}\n\n`)
      cleanup()
      return reply
    }

    req.raw.once('close', cleanup)
    reply.raw.once('close', cleanup)
    return reply
  })

  app.post<{
    Params: { pageId: string }
    Body: { kind?: unknown; x?: unknown; y?: unknown; text?: unknown; key?: unknown; dy?: unknown }
  }>('/api/browser/workspace/:pageId/input', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireScope(actor.subject, SC.CHAT_USE)
    const kind = String(req.body?.kind ?? '')
    let result: BrowserResult
    try {
      if (kind === 'click') {
        result = await clickBrowserPageAt(
          req.params.pageId,
          ownerKeyOf(actor),
          Number(req.body?.x),
          Number(req.body?.y),
        )
      } else if (kind === 'text') {
        result = await typeBrowserPageText(req.params.pageId, ownerKeyOf(actor), String(req.body?.text ?? ''))
      } else if (kind === 'key') {
        result = await pressBrowserPageKey(req.params.pageId, ownerKeyOf(actor), String(req.body?.key ?? ''))
      } else if (kind === 'scroll') {
        result = await scrollBrowserPageBy(req.params.pageId, ownerKeyOf(actor), Number(req.body?.dy))
      } else {
        throw new EabError(EC.VALIDATION, '输入类型不支持', { hint: '可用 click / text / key / scroll' })
      }
    } catch (err) {
      // 不记录 text，避免密码/验证码进入审计细节。
      auditBrowser(deps, actor, 'browser.workspace.input', 'failure', {
        pageId: req.params.pageId,
        kind,
      })
      throw err
    }
    auditBrowser(deps, actor, 'browser.workspace.input', 'success', {
      pageId: result.pageId,
      kind,
      url: result.url,
    })
    return ok(result)
  })

  app.post<{ Params: { pageId: string } }>('/api/browser/workspace/:pageId/close', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireScope(actor.subject, SC.CHAT_USE)
    const result = await executeBrowserAction(
      { action: 'close', pageId: req.params.pageId },
      browserOptions(actor, deps.config.dbPath),
    )
    auditBrowser(deps, actor, 'browser.workspace.close', 'success', {
      pageId: req.params.pageId,
      closed: result.closed,
    })
    return ok(result)
  })
}
