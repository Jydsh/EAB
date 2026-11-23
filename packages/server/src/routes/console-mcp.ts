/**
 * 控制台 MCP Server 登记接口。
 *
 * 准入与其它控制台数据接口一致：`x-eab-console: 1` + 控制台会话，按当前公司隔离。
 * 写入审计时不记录密钥、Authorization 头或完整请求体。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { EC, EabError } from '@eab/domain'
import { appendAudit } from '@eab/storage'
import type { ServerDeps } from '../deps.js'
import { ok } from '../http.js'
import { resolveActor } from '../session.js'
import { isConsoleRequest } from '../console-auth.js'
import {
  createMcpServer,
  deleteMcpServer,
  getMcpServerView,
  listMcpCatalogView,
  syncMcpServer,
  updateMcpServer,
} from '../mcp-registry.js'

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
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
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
    resourceType: 'mcp_server',
    resourceId,
    result,
    detail,
    ip: req.ip ?? null,
    channel: 'console',
  })
}

function auditDetail(view: { name: string; transport: string; endpoint: string; enabled: boolean; health: string }): Record<string, unknown> {
  return {
    name: view.name,
    transport: view.transport,
    endpoint: view.endpoint,
    enabled: view.enabled,
    health: view.health,
  }
}

export function registerConsoleMcpRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get('/api/console/mcp', async (req) => {
    const companyId = consoleCompany(req, deps)
    return ok({ servers: listMcpCatalogView(deps.db, deps.config.dbPath, companyId) })
  })

  app.post('/api/console/mcp', async (req) => {
    const companyId = consoleCompany(req, deps)
    const { subject } = consoleActor(req, deps)
    const input = bodyOf(req)
    const created = createMcpServer(deps.db, deps.config.dbPath, companyId, subject.userId, input)
    let sync = null
    if (created.enabled) {
      sync = await syncMcpServer(deps.db, deps.config.dbPath, companyId, created.id, {
        timeoutMs: Number(input.timeoutMs ?? 15_000),
      })
    }
    const server = getMcpServerView(deps.db, deps.config.dbPath, companyId, created.id)
    audit(req, deps, companyId, subject.userId, 'mcp.create', created.id, 'success', {
      ...auditDetail(server),
      syncOk: sync?.ok ?? false,
      toolCount: sync?.toolCount ?? 0,
    })
    return ok({ server, sync })
  })

  app.patch<{ Params: { id: string } }>('/api/console/mcp/:id', async (req) => {
    const companyId = consoleCompany(req, deps)
    const { subject } = consoleActor(req, deps)
    const id = String(req.params.id ?? '')
    const input = bodyOf(req)
    const updated = updateMcpServer(deps.db, deps.config.dbPath, companyId, id, input)
    let sync = null
    if (updated.enabled) {
      sync = await syncMcpServer(deps.db, deps.config.dbPath, companyId, id, {
        timeoutMs: Number(input.timeoutMs ?? 15_000),
      })
    }
    const server = getMcpServerView(deps.db, deps.config.dbPath, companyId, id)
    audit(req, deps, companyId, subject.userId, 'mcp.update', id, 'success', {
      ...auditDetail(server),
      syncOk: sync?.ok ?? false,
      toolCount: sync?.toolCount ?? 0,
    })
    return ok({ server, sync })
  })

  app.delete<{ Params: { id: string } }>('/api/console/mcp/:id', async (req) => {
    const companyId = consoleCompany(req, deps)
    const { subject } = consoleActor(req, deps)
    const id = String(req.params.id ?? '')
    const deleted = deleteMcpServer(deps.db, deps.config.dbPath, companyId, id)
    audit(req, deps, companyId, subject.userId, 'mcp.delete', id, 'success', auditDetail({ ...deleted, enabled: false, health: 'offline' }))
    return ok({ server: deleted })
  })

  app.post<{ Params: { id: string } }>('/api/console/mcp/:id/sync', async (req) => {
    const companyId = consoleCompany(req, deps)
    const { subject } = consoleActor(req, deps)
    const id = String(req.params.id ?? '')
    const body = bodyOf(req)
    const sync = await syncMcpServer(deps.db, deps.config.dbPath, companyId, id, {
      timeoutMs: Number(body.timeoutMs ?? 15_000),
    })
    const server = getMcpServerView(deps.db, deps.config.dbPath, companyId, id)
    audit(req, deps, companyId, subject.userId, 'mcp.sync', id, sync.ok ? 'success' : 'failure', {
      ...auditDetail(server),
      toolCount: sync.toolCount,
      error: sync.error.slice(0, 300),
    })
    return ok({ server, sync })
  })
}
