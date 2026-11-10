/**
 * 定时任务 API（员工端）。
 *
 * 对话里的 `schedule.create/list/cancel` 工具和这里的 HTTP 接口共用同一套
 * 存储与调度逻辑；网页/钉钉都可以创建，结果统一落到 chat_messages 并按 channel 回推。
 */
import type { FastifyInstance } from 'fastify'
import { SC } from '@eab/domain'
import type { ServerDeps } from '../deps.js'
import { ok, requireScope } from '../http.js'
import { resolveActor } from '../session.js'
import { cancelSchedule, createSchedule, listSchedules, setSchedulePaused } from '../schedule.js'

export function registerScheduleRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get('/api/schedules', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req, deps.companyId)
    requireScope(actor.subject, SC.SCHEDULE_READ)
    const query = req.query as { status?: string } | undefined
    return ok({ schedules: listSchedules(deps.db, actor, query?.status) })
  })

  app.post('/api/schedules', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req, deps.companyId)
    requireScope(actor.subject, SC.SCHEDULE_WRITE)
    const body = (req.body ?? {}) as Record<string, unknown>
    const schedule = createSchedule(
      deps.db,
      actor,
      {
        title: body.title === undefined ? undefined : String(body.title),
        prompt: String(body.prompt ?? ''),
        mode: String(body.mode ?? ''),
        at: body.at === undefined ? undefined : String(body.at),
        time: body.time === undefined ? undefined : String(body.time),
        days: body.days === undefined ? undefined : String(body.days),
        intervalMinutes: body.intervalMinutes === undefined ? undefined : String(body.intervalMinutes),
        afterSeconds: body.afterSeconds === undefined ? undefined : String(body.afterSeconds),
        everySeconds: body.everySeconds === undefined ? undefined : String(body.everySeconds),
        timezone: body.timezone === undefined ? undefined : String(body.timezone),
        channel: body.channel === undefined ? undefined : String(body.channel),
      },
      { sessionId: body.sessionId === undefined ? undefined : String(body.sessionId) },
    )
    return ok({ schedule })
  })

  app.post('/api/schedules/:id/cancel', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req, deps.companyId)
    requireScope(actor.subject, SC.SCHEDULE_WRITE)
    const id = String((req.params as { id?: string }).id ?? '')
    return ok({ schedule: cancelSchedule(deps.db, actor, id) })
  })

  app.post('/api/schedules/:id/pause', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req, deps.companyId)
    requireScope(actor.subject, SC.SCHEDULE_WRITE)
    const id = String((req.params as { id?: string }).id ?? '')
    return ok({ schedule: setSchedulePaused(deps.db, actor, id, true) })
  })

  app.post('/api/schedules/:id/resume', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req, deps.companyId)
    requireScope(actor.subject, SC.SCHEDULE_WRITE)
    const id = String((req.params as { id?: string }).id ?? '')
    return ok({ schedule: setSchedulePaused(deps.db, actor, id, false) })
  })
}
