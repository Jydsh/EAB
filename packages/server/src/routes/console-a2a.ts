/**
 * 控制台 A2A 远端 Agent 登记接口。
 *
 * 准入与其它控制台数据接口一致：`x-eab-console: 1` + 控制台会话，按当前公司隔离。
 * 响应只返回 `secretConfigured`，不返回密钥、Authorization 头或 Agent Card 全文中的鉴权信息。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { EC, EabError } from '@eab/domain'
import { appendAudit } from '@eab/storage'
import type { ServerDeps } from '../deps.js'
import { ok } from '../http.js'
import { resolveActor } from '../session.js'
import { isConsoleRequest } from '../console-auth.js'
import {
  createA2APeer,
  deleteA2APeer,
  getA2APeerView,
  listA2APeerViews,
  listA2ATasks,
  syncA2APeer,
  updateA2APeer,
} from '../a2a-registry.js'
import {
  auditInboundConfig,
  deleteA2AInboundToken,
  getA2AInboundConfig,
  listInboundTasks,
  rotateA2AInboundToken,
  updateA2AInboundConfig,
} from '../a2a-inbound.js'
import { loadModelCatalogCached } from './chat.js'

function consoleCompany(req: FastifyRequest, deps: ServerDeps): string {
  if (!isConsoleRequest(req, deps.config)) {
    throw new EabError(EC.AUTH_REQUIRED, '需要控制台会话（请先在 /admin 登录）', {
      hint: '控制台数据接口必须带 x-eab-console: 1；浏览器登录后由页面自动携带',
    })
  }
  const { subject } = resolveActor(deps.db, deps.config, req, deps.companyId)
  return subject.companyId
}

function consoleActor(req: FastifyRequest, deps: ServerDeps) {
  return resolveActor(deps.db, deps.config, req, deps.companyId)
}

function bodyOf(req: FastifyRequest): Record<string, unknown> {
  const body = req.body
  return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
}

function audit(
  req: FastifyRequest,
  deps: ServerDeps,
  companyId: string,
  actorUserId: string,
  action: string,
  resourceId: string | null,
  result: 'success' | 'failure',
  detail: Record<string, unknown>,
): void {
  appendAudit(deps.db, {
    companyId,
    actorUserId,
    action,
    resourceType: 'a2a_peer',
    resourceId,
    result,
    detail,
    ip: req.ip ?? null,
    channel: 'console',
  })
}

function auditDetail(view: { name: string; endpoint: string; enabled: boolean; health: string; allowedSkills: readonly string[] }): Record<string, unknown> {
  return {
    name: view.name,
    endpoint: view.endpoint,
    enabled: view.enabled,
    health: view.health,
    allowedSkills: view.allowedSkills.slice(0, 20),
  }
}

export function registerConsoleA2ARoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get('/api/console/a2a', async (req) => {
    const companyId = consoleCompany(req, deps)
    return ok({
      peers: listA2APeerViews(deps.db, deps.config.dbPath, companyId),
      tasks: listA2ATasks(deps.db, companyId, 20),
      inbound: getA2AInboundConfig(deps.db, deps.config, companyId),
      inboundTasks: listInboundTasks(deps.db, companyId, 20),
    })
  })

  app.put('/api/console/a2a/inbound', async (req) => {
    const companyId = consoleCompany(req, deps)
    const { subject } = consoleActor(req, deps)
    const input = bodyOf(req)
    if (input.modelId !== undefined) {
      const modelId = String(input.modelId ?? '').trim()
      if (modelId) {
        const catalog = await loadModelCatalogCached(deps.db, companyId, deps.config.devAuth, undefined)
        const model = catalog.find((item) => item.id === modelId)
        if (!model || (model.endpointKind ?? 'chat') !== 'chat') {
          throw new EabError(EC.VALIDATION, '入站模型不可用或不是对话模型', {
            details: { modelId },
          })
        }
      }
    }
    const inbound = updateA2AInboundConfig(deps.db, deps.config, companyId, subject.userId, input)
    auditInboundConfig(deps, req, companyId, subject.userId, 'a2a.inbound.update', inbound)
    return ok({ inbound })
  })

  app.post('/api/console/a2a/inbound/token', async (req) => {
    const companyId = consoleCompany(req, deps)
    const { subject } = consoleActor(req, deps)
    const rotated = rotateA2AInboundToken(deps.db, deps.config, companyId, subject.userId)
    auditInboundConfig(deps, req, companyId, subject.userId, 'a2a.inbound.token', rotated.config)
    return ok({ inbound: rotated.config, token: rotated.token })
  })

  app.delete('/api/console/a2a/inbound/token', async (req) => {
    const companyId = consoleCompany(req, deps)
    const { subject } = consoleActor(req, deps)
    deleteA2AInboundToken(deps.db, deps.config, companyId)
    const inbound = getA2AInboundConfig(deps.db, deps.config, companyId)
    auditInboundConfig(deps, req, companyId, subject.userId, 'a2a.inbound.token.delete', inbound)
    return ok({ inbound })
  })

  app.post('/api/console/a2a', async (req) => {
    const companyId = consoleCompany(req, deps)
    const { subject } = consoleActor(req, deps)
    const input = bodyOf(req)
    const created = createA2APeer(deps.db, deps.config.dbPath, companyId, subject.userId, input)
    const sync = created.enabled
      ? await syncA2APeer(deps.db, deps.config.dbPath, companyId, created.id, { timeoutMs: Number(input.timeoutMs ?? 15_000) })
      : null
    const peer = getA2APeerView(deps.db, deps.config.dbPath, companyId, created.id)
    audit(req, deps, companyId, subject.userId, 'a2a.create', created.id, 'success', {
      ...auditDetail(peer),
      syncOk: sync?.ok ?? false,
      skillCount: sync?.skillCount ?? 0,
    })
    return ok({ peer, sync })
  })

  app.patch<{ Params: { id: string } }>('/api/console/a2a/:id', async (req) => {
    const companyId = consoleCompany(req, deps)
    const { subject } = consoleActor(req, deps)
    const id = String(req.params.id ?? '')
    const input = bodyOf(req)
    const updated = updateA2APeer(deps.db, deps.config.dbPath, companyId, id, input)
    const sync = updated.enabled
      ? await syncA2APeer(deps.db, deps.config.dbPath, companyId, id, { timeoutMs: Number(input.timeoutMs ?? 15_000) })
      : null
    const peer = getA2APeerView(deps.db, deps.config.dbPath, companyId, id)
    audit(req, deps, companyId, subject.userId, 'a2a.update', id, 'success', {
      ...auditDetail(peer),
      syncOk: sync?.ok ?? false,
      skillCount: sync?.skillCount ?? 0,
    })
    return ok({ peer, sync })
  })

  app.delete<{ Params: { id: string } }>('/api/console/a2a/:id', async (req) => {
    const companyId = consoleCompany(req, deps)
    const { subject } = consoleActor(req, deps)
    const id = String(req.params.id ?? '')
    const deleted = deleteA2APeer(deps.db, deps.config.dbPath, companyId, id)
    audit(req, deps, companyId, subject.userId, 'a2a.delete', id, 'success', {
      ...auditDetail({ ...deleted, enabled: false, health: 'offline' }),
    })
    return ok({ peer: { ...deleted, enabled: false, health: 'offline', secretRef: '' } })
  })

  app.post<{ Params: { id: string } }>('/api/console/a2a/:id/sync', async (req) => {
    const companyId = consoleCompany(req, deps)
    const { subject } = consoleActor(req, deps)
    const id = String(req.params.id ?? '')
    const body = bodyOf(req)
    const sync = await syncA2APeer(deps.db, deps.config.dbPath, companyId, id, { timeoutMs: Number(body.timeoutMs ?? 15_000) })
    const peer = getA2APeerView(deps.db, deps.config.dbPath, companyId, id)
    audit(req, deps, companyId, subject.userId, 'a2a.sync', id, sync.ok ? 'success' : 'failure', {
      ...auditDetail(peer),
      skillCount: sync.skillCount,
      error: sync.error.slice(0, 300),
    })
    return ok({ peer, sync })
  })
}
