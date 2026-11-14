/**
 * 控制台任务中心接口。
 *
 * 与员工端 `/api/schedules` 分开：
 * - 员工端按登录身份只看自己的任务；
 * - 控制台操作员按当前公司看全部任务，操作写审计。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { EC, EabError } from '@eab/domain'
import { appendAudit } from '@eab/storage'
import type { ServerDeps } from '../deps.js'
import { ok } from '../http.js'
import { resolveActor } from '../session.js'
import { isConsoleRequest } from '../console-auth.js'
import {
  cancelCompanySchedule,
  getCompanyScheduleDetail,
  listCompanySchedules,
  pauseCompanySchedule,
  resumeCompanySchedule,
  type CompanyScheduleMutation,
} from '../console-schedules.js'

function consoleCompany(req: FastifyRequest, deps: ServerDeps): string {
  if (!isConsoleRequest(req, deps.config)) {
    throw new EabError(EC.AUTH_REQUIRED, '需要控制台会话（请先在 /admin 登录）', {
      hint: '控制台数据接口必须带 x-eab-console: 1；浏览器登录后由页面自动携带',
    })
  }
  const { subject } = resolveActor(deps.db, deps.config, req, deps.companyId)
  return subject.companyId
}

function writeTaskAudit(
  req: FastifyRequest,
  deps: ServerDeps,
  companyId: string,
  action: string,
  id: string,
  result: CompanyScheduleMutation,
): void {
  appendAudit(deps.db, {
    companyId,
    actorUserId: 'console-operator',
    action,
    resourceType: 'user_schedule',
    resourceId: id,
    result: 'success',
    detail: {
      title: result.schedule.title,
      previousStatus: result.previousStatus,
      status: result.schedule.status,
    },
    ip: req.ip ?? null,
    channel: 'console',
  })
}

export function registerConsoleScheduleRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get<{ Querystring: { status?: string; limit?: string } }>(
    '/api/console/schedules',
    async (req) => {
      const companyId = consoleCompany(req, deps)
      const limit = Number(req.query?.limit)
      return ok(listCompanySchedules(deps.db, companyId, req.query?.status, Number.isFinite(limit) ? limit : undefined))
    },
  )

  app.get<{ Params: { id: string } }>('/api/console/schedules/:id', async (req) => {
    const companyId = consoleCompany(req, deps)
    return ok(getCompanyScheduleDetail(deps.db, companyId, String(req.params.id ?? '')))
  })

  app.post<{ Params: { id: string } }>('/api/console/schedules/:id/pause', async (req) => {
    const companyId = consoleCompany(req, deps)
    const id = String(req.params.id ?? '')
    const result = pauseCompanySchedule(deps.db, companyId, id)
    writeTaskAudit(req, deps, companyId, 'schedule.pause', id, result)
    return ok({ schedule: result.schedule })
  })

  app.post<{ Params: { id: string } }>('/api/console/schedules/:id/resume', async (req) => {
    const companyId = consoleCompany(req, deps)
    const id = String(req.params.id ?? '')
    const result = resumeCompanySchedule(deps.db, companyId, id)
    writeTaskAudit(req, deps, companyId, 'schedule.resume', id, result)
    return ok({ schedule: result.schedule })
  })

  app.post<{ Params: { id: string } }>('/api/console/schedules/:id/cancel', async (req) => {
    const companyId = consoleCompany(req, deps)
    const id = String(req.params.id ?? '')
    const result = cancelCompanySchedule(deps.db, companyId, id)
    writeTaskAudit(req, deps, companyId, 'schedule.cancel', id, result)
    return ok({ schedule: result.schedule })
  })
}
