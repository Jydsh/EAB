/**
 * 控制台「额度与用量」接口。
 *
 * 与其他控制台写接口同一套准入：控制台会话 + `x-eab-console: 1`，所有写操作写审计。
 * 额度本身只存上限，用量从 `usage_daily` 实时聚合，页面与拦截共用同一份判定函数（quota.ts）。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { EC, EabError } from '@eab/domain'
import { appendAudit } from '@eab/storage'
import type { ServerDeps } from '../deps.js'
import { ok } from '../http.js'
import { isConsoleRequest } from '../console-auth.js'
import { resolveActor } from '../session.js'
import {
  isMonth,
  isQuotaScopeType,
  loadCompanyQuotas,
  monthNow,
  scopeUsage,
  usageRowsForMonth,
  type QuotaLimits,
  type QuotaScopeType,
} from '../quota.js'

function requireConsole(req: FastifyRequest, deps: ServerDeps): void {
  if (!isConsoleRequest(req, deps.config)) {
    throw new EabError(EC.AUTH_REQUIRED, '需要控制台会话（请先在 /admin 登录）')
  }
}

function companyOf(req: FastifyRequest, deps: ServerDeps): string {
  return resolveActor(deps.db, deps.config, req, deps.companyId).subject.companyId
}

function audit(
  deps: ServerDeps,
  req: FastifyRequest,
  companyId: string,
  action: string,
  resourceType: string,
  resourceId: string | null,
  detail?: Record<string, unknown>,
): void {
  appendAudit(deps.db, {
    companyId,
    actorUserId: 'console-operator',
    action,
    resourceType,
    resourceId,
    result: 'success',
    ip: req.ip,
    channel: 'console',
    detail: detail as never,
  })
}

function quotaOfRow(limits: QuotaLimits | undefined): {
  requests: number | null
  tokens: number | null
  mode: 'hard' | 'soft'
  enabled: boolean
} | null {
  if (!limits) return null
  return { requests: limits.requests, tokens: limits.tokens, mode: limits.mode, enabled: limits.enabled }
}

export function registerQuotaRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get<{ Querystring: { month?: string } }>('/api/console/quotas', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const month = String(req.query.month ?? '').trim() || monthNow()
    if (!isMonth(month)) throw new EabError(EC.VALIDATION, 'month 需要是 YYYY-MM')

    const company = deps.db
      .prepare('SELECT id, name FROM companies WHERE id = ?')
      .get(companyId) as { id: string; name: string } | undefined
    const quotas = loadCompanyQuotas(deps.db, companyId)
    const usageRows = usageRowsForMonth(deps.db, companyId, month)

    const companyUsage = scopeUsage(deps.db, {
      companyId,
      month,
      scopeType: 'company',
      scopeId: companyId,
    })

    const deptRows = deps.db
      .prepare(
        `SELECT d.id, d.name, d.path,
                (SELECT COUNT(*) FROM users u
                  WHERE u.company_id = d.company_id AND u.deleted_at IS NULL
                    AND u.dept_path LIKE d.path || '%') AS members
           FROM departments d
          WHERE d.company_id = ? AND d.deleted_at IS NULL
          ORDER BY d.path`,
      )
      .all(companyId) as unknown as Array<{ id: string; name: string; path: string; members: number }>

    const departments = deptRows.map((row) => {
      const prefix = row.path.endsWith('/') ? row.path : `${row.path}/`
      const items = usageRows.filter((item) => (item.deptPath || '').startsWith(prefix))
      const usage = items.reduce(
        (acc, item) => ({
          requests: acc.requests + item.requests,
          promptTokens: acc.promptTokens + item.promptTokens,
          completionTokens: acc.completionTokens + item.completionTokens,
        }),
        { requests: 0, promptTokens: 0, completionTokens: 0 },
      )
      const totalTokens = usage.promptTokens + usage.completionTokens
      return {
        id: row.id,
        name: row.name,
        path: row.path,
        members: Number(row.members),
        usage: { ...usage, totalTokens },
        quota: quotaOfRow(quotas.get(`dept:${row.id}`)),
      }
    })

    const memberRows = deps.db
      .prepare(
        `SELECT u.id, u.name, u.status, u.dept_id, u.dept_path, d.name AS dept_name
           FROM users u JOIN departments d ON d.id = u.dept_id
          WHERE u.company_id = ? AND u.deleted_at IS NULL
          ORDER BY u.dept_path, u.name`,
      )
      .all(companyId) as unknown as Array<{
      id: string
      name: string
      status: string
      dept_id: string
      dept_path: string
      dept_name: string
    }>

    const usageByUser = new Map(usageRows.map((item) => [item.userId, item]))
    const members = memberRows.map((row) => {
      const item = usageByUser.get(row.id)
      return {
        id: row.id,
        name: row.name,
        status: row.status,
        deptId: row.dept_id,
        deptName: row.dept_name,
        deptPath: row.dept_path,
        usage: {
          requests: item?.requests ?? 0,
          promptTokens: item?.promptTokens ?? 0,
          completionTokens: item?.completionTokens ?? 0,
          totalTokens: item?.totalTokens ?? 0,
        },
        quota: quotaOfRow(quotas.get(`user:${row.id}`)),
      }
    })

    return ok({
      month,
      company: {
        id: companyId,
        name: company?.name ?? companyId,
        usage: companyUsage,
        quota: quotaOfRow(quotas.get(`company:${companyId}`)),
      },
      departments,
      members,
      totals: companyUsage,
    })
  })

  app.put<{
    Params: { scopeType: string; scopeId: string }
    Body: {
      monthlyRequests?: number | null
      monthlyTokens?: number | null
      mode?: string
      enabled?: boolean
    }
  }>('/api/console/quotas/:scopeType/:scopeId', async (req, reply) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const scopeType = String(req.params.scopeType)
    if (!isQuotaScopeType(scopeType)) throw new EabError(EC.VALIDATION, 'scopeType 只能是 company / dept / user')
    const scopeId = String(req.params.scopeId)

    assertScopeExists(deps, companyId, scopeType, scopeId)

    const requests = readLimit(req.body?.monthlyRequests, 'monthlyRequests')
    const tokens = readLimit(req.body?.monthlyTokens, 'monthlyTokens')
    const mode = String(req.body?.mode ?? 'hard')
    if (!['hard', 'soft'].includes(mode)) throw new EabError(EC.VALIDATION, 'mode 只能是 hard / soft')
    const enabled = req.body?.enabled === undefined ? true : req.body.enabled === true

    if (requests === null && tokens === null && enabled) {
      // 两个指标都不限却又启用，等于没设；直接提示，避免页面上出现"看起来有额度其实没有"的行
      throw new EabError(EC.VALIDATION, '至少要设置一个上限（请求数或 token）', {
        hint: '两个都不限时请直接删除这条额度',
      })
    }

    const now = Date.now()
    deps.db
      .prepare(
        `INSERT INTO usage_quotas
           (company_id, scope_type, scope_id, monthly_requests, monthly_tokens, mode, enabled, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(company_id, scope_type, scope_id) DO UPDATE SET
           monthly_requests = excluded.monthly_requests,
           monthly_tokens = excluded.monthly_tokens,
           mode = excluded.mode,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      )
      .run(companyId, scopeType, scopeId, requests, tokens, mode, enabled ? 1 : 0, now)

    audit(deps, req, companyId, 'ops.quota.update', 'usage_quota', `${scopeType}:${scopeId}`, {
      requests,
      tokens,
      mode,
      enabled,
    })
    reply.code(201)
    return ok({ scopeType, scopeId, requests, tokens, mode, enabled })
  })

  app.delete<{ Params: { scopeType: string; scopeId: string } }>(
    '/api/console/quotas/:scopeType/:scopeId',
    async (req) => {
      requireConsole(req, deps)
      const companyId = companyOf(req, deps)
      const scopeType = String(req.params.scopeType)
      if (!isQuotaScopeType(scopeType)) throw new EabError(EC.VALIDATION, 'scopeType 只能是 company / dept / user')
      const result = deps.db
        .prepare('DELETE FROM usage_quotas WHERE company_id = ? AND scope_type = ? AND scope_id = ?')
        .run(companyId, scopeType, String(req.params.scopeId))
      audit(deps, req, companyId, 'ops.quota.delete', 'usage_quota', `${scopeType}:${req.params.scopeId}`, {
        removed: Number(result.changes),
      })
      return ok({ deleted: Number(result.changes) > 0 })
    },
  )
}

function readLimit(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === '') return null
  const num = Number(value)
  if (!Number.isFinite(num) || !Number.isInteger(num) || num < 0) {
    throw new EabError(EC.VALIDATION, `${field} 需要是 0 或正整数`)
  }
  return num
}

function assertScopeExists(deps: ServerDeps, companyId: string, scopeType: QuotaScopeType, scopeId: string): void {
  if (scopeType === 'company') {
    if (scopeId !== companyId) throw new EabError(EC.NOT_FOUND, '公司不存在')
    return
  }
  const table = scopeType === 'dept' ? 'departments' : 'users'
  const row = deps.db
    .prepare(`SELECT id FROM ${table} WHERE id = ? AND company_id = ? AND deleted_at IS NULL`)
    .get(scopeId, companyId)
  if (!row) throw new EabError(EC.NOT_FOUND, scopeType === 'dept' ? '部门不存在' : '成员不存在')
}
