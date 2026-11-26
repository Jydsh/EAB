/**
 * 桌面文件桥路由。
 *
 * 这些接口只给 EAB 桌面客户端主进程使用：带员工登录 Cookie，并带 x-eab-desktop 标记。
 * 网页页面不能借这些接口直接读写项目文件，真正的项目文件操作仍走 project.* 工具。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { EC, EabError, SC } from '@eab/domain'
import type { ServerDeps } from '../deps.js'
import { ok, requireScope } from '../http.js'
import { resolveActor } from '../session.js'
import { assertDesktopOrigin } from '../desktop-bridge.js'

function ownerOf(deps: ServerDeps, req: FastifyRequest) {
  const actor = resolveActor(deps.db, deps.config, req, deps.companyId)
  return { actor, companyId: actor.subject.companyId, userId: actor.person.id }
}

export function registerDesktopBridgeRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const bridge = deps.desktopBridge
  if (!bridge) return

  app.post<{
    Body: { deviceId?: string; name?: string; platform?: string }
  }>('/api/desktop/bridge/register', async (req) => {
    assertDesktopOrigin(req.headers as Record<string, unknown>)
    const { actor, companyId, userId } = ownerOf(deps, req)
    requireScope(actor.subject, SC.LOCAL_SPACE_READ)
    const data = bridge.register(companyId, userId, {
      deviceId: String(req.body?.deviceId ?? ''),
      name: req.body?.name,
      platform: req.body?.platform,
    })
    return ok({ device: data })
  })

  app.get<{ Querystring: { deviceId?: string } }>('/api/desktop/bridge/jobs', async (req, reply) => {
    assertDesktopOrigin(req.headers as Record<string, unknown>)
    const { actor, companyId, userId } = ownerOf(deps, req)
    requireScope(actor.subject, SC.LOCAL_SPACE_READ)
    let job
    try {
      job = await bridge.takeJob(companyId, userId, String(req.query.deviceId ?? ''))
    } catch (error) {
      if (error instanceof EabError) throw error
      throw new EabError(EC.CONFLICT, '桌面文件桥暂不可用')
    }
    if (!job) return reply.code(204).send()
    return ok({ job })
  })

  app.post<{
    Params: { id: string }
    Body: {
      ok?: boolean
      result?: unknown
      error?: {
        status?: 'not_found' | 'forbidden' | 'validation' | 'conflict' | 'internal'
        message?: string
        hint?: string
      }
    }
  }>('/api/desktop/bridge/jobs/:id/result', async (req) => {
    assertDesktopOrigin(req.headers as Record<string, unknown>)
    const { actor, companyId, userId } = ownerOf(deps, req)
    requireScope(actor.subject, SC.LOCAL_SPACE_READ)
    const deviceId = String((req.headers as Record<string, unknown>)['x-eab-desktop-device'] ?? '')
    if (!deviceId) throw new EabError(EC.VALIDATION, '缺少桌面设备标识')
    bridge.complete(companyId, userId, deviceId, String(req.params.id ?? ''), {
      ok: req.body?.ok === true,
      result: req.body?.result,
      error: req.body?.error,
    })
    return ok({ received: true })
  })

  app.post<{
    Body: {
      sessionId?: string
      activePageId?: string
      tabs?: Array<{ pageId?: string; title?: string; url?: string; favicon?: string }>
    }
  }>('/api/desktop/bridge/tabs', async (req) => {
    assertDesktopOrigin(req.headers as Record<string, unknown>)
    const { actor, companyId, userId } = ownerOf(deps, req)
    requireScope(actor.subject, SC.LOCAL_SPACE_READ)
    const deviceId = String((req.headers as Record<string, unknown>)['x-eab-desktop-device'] ?? '')
    if (!deviceId) throw new EabError(EC.VALIDATION, '缺少桌面设备标识')
    bridge.updateBrowserTabs(companyId, userId, deviceId, {
      sessionId: req.body?.sessionId,
      activePageId: req.body?.activePageId,
      tabs: Array.isArray(req.body?.tabs) ? req.body.tabs : [],
    })
    return ok({ received: true })
  })

  app.get<{ Querystring: { deviceId?: string } }>('/api/desktop/bridge/status', async (req) => {
    const { actor, companyId, userId } = ownerOf(deps, req)
    requireScope(actor.subject, SC.LOCAL_SPACE_READ)
    const deviceId = String(req.query.deviceId ?? '')
    if (!deviceId) return ok({ online: false, device: null })
    return ok({ online: bridge.isOnline(companyId, userId, deviceId), device: bridge.status(companyId, userId, deviceId) })
  })
}
