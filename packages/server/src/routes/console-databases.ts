/**
 * 控制台「连接与平台 > 数据库」接口。
 *
 * 准入与其它控制台数据接口一致：`x-eab-console: 1` + 控制台会话，
 * 按当前公司隔离；写操作和连通性测试都写审计，但审计里不出现密码。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { EC, EabError } from '@eab/domain'
import { appendAudit } from '@eab/storage'
import type { ServerDeps } from '../deps.js'
import { ok } from '../http.js'
import { resolveActor } from '../session.js'
import { isConsoleRequest } from '../console-auth.js'
import {
  createDatabaseConnection,
  deleteDatabaseConnection,
  listDatabaseConnections,
  queryDatabaseConnection,
  testDatabaseConnection,
  testDatabaseDraft,
  updateDatabaseConnection,
  type DatabaseConnectionView,
} from '../database-connections.js'

function consoleCompany(req: FastifyRequest, deps: ServerDeps): string {
  if (!isConsoleRequest(req, deps.config)) {
    throw new EabError(EC.AUTH_REQUIRED, '需要控制台会话（请先在 /admin 登录）', {
      hint: '控制台数据接口必须带 x-eab-console: 1；浏览器登录后由页面自动携带',
    })
  }
  const { subject } = resolveActor(deps.db, deps.config, req, deps.companyId)
  return subject.companyId
}

function bodyOf(req: FastifyRequest): Record<string, unknown> {
  const body = req.body
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
}

function audit(
  req: FastifyRequest,
  deps: ServerDeps,
  companyId: string,
  action: string,
  resourceId: string | null,
  result: 'success' | 'failure',
  detail: Record<string, unknown>,
): void {
  appendAudit(deps.db, {
    companyId,
    actorUserId: 'console-operator',
    action,
    resourceType: 'database_connection',
    resourceId,
    result,
    detail,
    ip: req.ip ?? null,
    channel: 'console',
  })
}

function viewDetail(connection: DatabaseConnectionView): Record<string, unknown> {
  return {
    name: connection.name,
    kind: connection.kind,
    target: connection.target,
    enabled: connection.enabled,
  }
}

export function registerConsoleDatabaseRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get<{ Querystring: { status?: string } }>('/api/console/databases', async (req) => {
    const companyId = consoleCompany(req, deps)
    return ok(listDatabaseConnections(deps.db, deps.config.dbPath, companyId, req.query?.status))
  })

  app.post('/api/console/databases', async (req) => {
    const companyId = consoleCompany(req, deps)
    const connection = createDatabaseConnection(deps.db, deps.config.dbPath, companyId, bodyOf(req))
    audit(req, deps, companyId, 'database.create', connection.id, 'success', viewDetail(connection))
    return ok({ connection })
  })

  app.patch<{ Params: { id: string } }>('/api/console/databases/:id', async (req) => {
    const companyId = consoleCompany(req, deps)
    const id = String(req.params.id ?? '')
    const connection = updateDatabaseConnection(
      deps.db,
      deps.config.dbPath,
      companyId,
      id,
      bodyOf(req),
    )
    audit(req, deps, companyId, 'database.update', id, 'success', viewDetail(connection))
    return ok({ connection })
  })

  app.delete<{ Params: { id: string } }>('/api/console/databases/:id', async (req) => {
    const companyId = consoleCompany(req, deps)
    const id = String(req.params.id ?? '')
    const connection = deleteDatabaseConnection(deps.db, deps.config.dbPath, companyId, id)
    audit(req, deps, companyId, 'database.delete', id, 'success', connection)
    return ok({ connection })
  })

  // 静态路径必须单独注册：前端在“保存前”测试还没落库的草稿连接。
  app.post('/api/console/databases/test', async (req) => {
    const companyId = consoleCompany(req, deps)
    const body = bodyOf(req)
    const result = await testDatabaseDraft(deps.db, deps.config.dbPath, companyId, body)
    audit(req, deps, companyId, 'database.test', typeof body.id === 'string' ? body.id : null, result.ok ? 'success' : 'failure', {
      name: typeof body.name === 'string' ? body.name : '',
      kind: typeof body.kind === 'string' ? body.kind : '',
      latencyMs: result.latencyMs,
      error: result.error.slice(0, 200),
    })
    return ok({ result })
  })

  app.post<{ Params: { id: string } }>('/api/console/databases/:id/query', async (req) => {
    const companyId = consoleCompany(req, deps)
    const id = String(req.params.id ?? '')
    const body = bodyOf(req)
    const sql = typeof body.sql === 'string' ? body.sql : ''
    const outcome = await queryDatabaseConnection(deps.db, deps.config.dbPath, companyId, id, sql)
    audit(req, deps, companyId, 'database.query', id, outcome.result.ok ? 'success' : 'failure', {
      name: outcome.connection.name,
      kind: outcome.connection.kind,
      target: outcome.connection.target,
      sql: sql.replace(/\s+/g, ' ').trim().slice(0, 200),
      rowCount: outcome.result.rowCount,
      truncated: outcome.result.truncated,
      durationMs: outcome.result.durationMs,
      error: outcome.result.error.slice(0, 200),
    })
    return ok(outcome)
  })

  app.post<{ Params: { id: string } }>('/api/console/databases/:id/test', async (req) => {
    const companyId = consoleCompany(req, deps)
    const id = String(req.params.id ?? '')
    const outcome = await testDatabaseConnection(deps.db, deps.config.dbPath, companyId, id)
    audit(
      req,
      deps,
      companyId,
      'database.test',
      id,
      outcome.result.ok ? 'success' : 'failure',
      {
        name: outcome.connection.name,
        kind: outcome.connection.kind,
        target: outcome.connection.target,
        latencyMs: outcome.result.latencyMs,
        error: outcome.result.error.slice(0, 200),
      },
    )
    return ok(outcome)
  })
}
