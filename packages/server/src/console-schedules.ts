/**
 * 控制台任务中心的数据层。
 *
 * 这里只做“公司级读取 + 受控状态变更”，不复制调度器的执行逻辑：
 * - `user_schedules` 是当前状态投影；
 * - `schedule_runs` 是执行投影；
 * - `schedule_events` 是 append-only 真相，详情页直接读它，不再拼日志。
 *
 * 员工端仍然通过 `/api/schedules` 管自己的任务；控制台操作员看到的是
 * 整个公司的任务，因此单独放在 console-schedules，避免把员工身份硬套进管理员。
 */
import { EC, EabError } from '@eab/domain'
import { withTransaction, type Db } from '@eab/storage'
import {
  appendScheduleEvent,
  listScheduleEvents,
  nextRunAt,
  toLocalIso,
  type ScheduleEventRow,
  type ScheduleRow,
  type ScheduleRule,
} from './schedule.js'

export const COMPANY_SCHEDULE_STATUSES = [
  'active',
  'paused',
  'running',
  'done',
  'error',
  'cancelled',
] as const

export type CompanyScheduleStatus = (typeof COMPANY_SCHEDULE_STATUSES)[number]

export interface CompanyScheduleRunView {
  id: string
  status: string
  scheduledFor: string
  scheduledForLocal: string
  startedAt: string
  finishedAt: string | null
  error: string | null
  resultText: string | null
  channel: string | null
  delivery: string | null
  deliveryError: string | null
}

export interface CompanyScheduleView {
  id: string
  title: string
  prompt: string
  mode: string
  rule: ScheduleRule
  timezone: string
  channel: string
  status: string
  userId: string
  userName: string | null
  sessionId: string | null
  nextRunAt: string
  nextRunLocal: string
  lastRunAt: string | null
  lastRunLocal: string | null
  lastError: string | null
  attempts: number
  createdAt: string
  updatedAt: string
  lastRun: CompanyScheduleRunView | null
}

export interface CompanyScheduleList {
  items: CompanyScheduleView[]
  counts: Record<CompanyScheduleStatus | 'all', number>
  total: number
  status: string
}

interface ScheduleListRow extends ScheduleRow {
  user_name: string | null
  run_id: string | null
  run_status: string | null
  run_scheduled_for: number | null
  run_started_at: number | null
  run_finished_at: number | null
  run_error: string | null
  run_result_text: string | null
  run_channel: string | null
  run_delivery: string | null
  run_delivery_error: string | null
}

interface ScheduleDetailRow extends ScheduleRow {
  user_name: string | null
}

interface ScheduleRunRow {
  id: string
  schedule_id: string
  company_id: string
  user_id: string
  scheduled_for: number
  status: string
  started_at: number
  finished_at: number | null
  error: string | null
  result_text: string | null
  channel: string | null
  delivery: string | null
  delivery_error: string | null
}

export interface CompanyScheduleDetail extends CompanyScheduleView {
  runs: CompanyScheduleRunView[]
  events: Array<{
    id: string
    type: string
    payload: unknown
    createdAt: string
  }>
}

function iso(epoch: number): string {
  return new Date(epoch).toISOString()
}

function safeJson(value: string | null | undefined): unknown {
  if (!value) return {}
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

function ruleOf(row: ScheduleRow): ScheduleRule {
  const parsed = safeJson(row.payload_json)
  if (parsed && typeof parsed === 'object' && 'mode' in parsed) {
    return parsed as ScheduleRule
  }
  return { mode: row.mode }
}

function normalizeStatus(value: string | undefined): string {
  const status = String(value ?? 'all').trim()
  if (status === 'all') return 'all'
  return (COMPANY_SCHEDULE_STATUSES as readonly string[]).includes(status) ? status : 'all'
}

function clampLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return 100
  return Math.min(200, Math.max(1, Math.floor(Number(value))))
}

function runView(row: ScheduleRunRow, timezone: string): CompanyScheduleRunView {
  return {
    id: row.id,
    status: row.status,
    scheduledFor: iso(row.scheduled_for),
    scheduledForLocal: toLocalIso(row.scheduled_for, timezone),
    startedAt: iso(row.started_at),
    finishedAt: row.finished_at ? iso(row.finished_at) : null,
    error: row.error,
    resultText: row.result_text,
    channel: row.channel,
    delivery: row.delivery,
    deliveryError: row.delivery_error,
  }
}

function runViewFromList(row: ScheduleListRow): CompanyScheduleRunView | null {
  if (!row.run_id || row.run_status === null || row.run_started_at === null) return null
  return {
    id: row.run_id,
    status: row.run_status,
    scheduledFor: row.run_scheduled_for ? iso(row.run_scheduled_for) : '',
    scheduledForLocal: row.run_scheduled_for ? toLocalIso(row.run_scheduled_for, row.timezone) : '',
    startedAt: iso(row.run_started_at),
    finishedAt: row.run_finished_at ? iso(row.run_finished_at) : null,
    error: row.run_error,
    resultText: row.run_result_text,
    channel: row.run_channel,
    delivery: row.run_delivery,
    deliveryError: row.run_delivery_error,
  }
}

/**
 * 列表视图统一用任务自己的时区转换，展示执行记录时才用上海默认；
 * 任务创建时可显式指定时区，避免跨时区公司看错“下一次”。
 */
function taskView(row: ScheduleListRow | ScheduleDetailRow, userName: string | null): CompanyScheduleView {
  const rule = ruleOf(row)
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    mode: row.mode,
    rule,
    timezone: row.timezone,
    channel: row.channel,
    status: row.status,
    userId: row.user_id,
    userName,
    sessionId: row.session_id,
    nextRunAt: iso(row.next_run_at),
    nextRunLocal: toLocalIso(row.next_run_at, row.timezone),
    lastRunAt: row.last_run_at ? iso(row.last_run_at) : null,
    lastRunLocal: row.last_run_at ? toLocalIso(row.last_run_at, row.timezone) : null,
    lastError: row.last_error,
    attempts: row.attempts,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    lastRun: 'run_id' in row ? runViewFromList(row) : null,
  }
}

function emptyCounts(): Record<CompanyScheduleStatus | 'all', number> {
  return {
    all: 0,
    active: 0,
    paused: 0,
    running: 0,
    done: 0,
    error: 0,
    cancelled: 0,
  }
}

export function listCompanySchedules(
  db: Db,
  companyId: string,
  statusValue?: string,
  limitValue?: number,
): CompanyScheduleList {
  const status = normalizeStatus(statusValue)
  const limit = clampLimit(limitValue)
  const counts = emptyCounts()

  const countRows = db
    .prepare('SELECT status, COUNT(*) AS count FROM user_schedules WHERE company_id = ? GROUP BY status')
    .all(companyId) as Array<{ status: string; count: number }>
  for (const row of countRows) {
    const count = Number(row.count ?? 0)
    counts.all += count
    if ((COMPANY_SCHEDULE_STATUSES as readonly string[]).includes(row.status)) {
      counts[row.status as CompanyScheduleStatus] = count
    }
  }

  const where = status === 'all' ? '' : ' AND s.status = ?'
  const params: Array<string | number> = status === 'all' ? [companyId, limit] : [companyId, status, limit]
  const rows = db
    .prepare(
      `SELECT s.*, u.name AS user_name,
              r.id AS run_id, r.status AS run_status, r.scheduled_for AS run_scheduled_for,
              r.started_at AS run_started_at, r.finished_at AS run_finished_at,
              r.error AS run_error, r.result_text AS run_result_text,
              r.channel AS run_channel, r.delivery AS run_delivery, r.delivery_error AS run_delivery_error
         FROM user_schedules s
         LEFT JOIN users u ON u.id = s.user_id
         LEFT JOIN schedule_runs r ON r.id = (
           SELECT id FROM schedule_runs
            WHERE schedule_id = s.id
            ORDER BY started_at DESC, id DESC
            LIMIT 1
         )
        WHERE s.company_id = ?${where}
        ORDER BY CASE s.status
          WHEN 'running' THEN 0
          WHEN 'active' THEN 1
          WHEN 'paused' THEN 2
          WHEN 'error' THEN 3
          WHEN 'done' THEN 4
          ELSE 5
        END, COALESCE(s.last_run_at, 0) DESC, s.updated_at DESC
        LIMIT ?`,
    )
    .all(...params) as unknown as ScheduleListRow[]

  return {
    items: rows.map((row) => taskView(row, row.user_name)),
    counts,
    total: counts.all,
    status,
  }
}

function findCompanySchedule(db: Db, companyId: string, id: string): ScheduleDetailRow | undefined {
  return db
    .prepare(
      `SELECT s.*, u.name AS user_name
         FROM user_schedules s
         LEFT JOIN users u ON u.id = s.user_id
        WHERE s.id = ? AND s.company_id = ?`,
    )
    .get(id, companyId) as unknown as ScheduleDetailRow | undefined
}

function requireCompanySchedule(db: Db, companyId: string, id: string): ScheduleDetailRow {
  const row = findCompanySchedule(db, companyId, id)
  if (!row) throw new EabError(EC.NOT_FOUND, `定时任务不存在：${id}`)
  return row
}

function eventView(row: ScheduleEventRow): CompanyScheduleDetail['events'][number] {
  return {
    id: row.id,
    type: row.type,
    payload: safeJson(row.payload_json),
    createdAt: iso(row.created_at),
  }
}

export function getCompanyScheduleDetail(db: Db, companyId: string, id: string): CompanyScheduleDetail {
  const row = requireCompanySchedule(db, companyId, id)
  const runs = db
    .prepare(
      `SELECT id, schedule_id, company_id, user_id, scheduled_for, status, started_at,
              finished_at, error, result_text, channel, delivery, delivery_error
         FROM schedule_runs
        WHERE schedule_id = ? AND company_id = ?
        ORDER BY started_at DESC, id DESC
        LIMIT 50`,
    )
    .all(id, companyId) as unknown as ScheduleRunRow[]
  const events = listScheduleEvents(db, id, 100)
  return {
    ...taskView(row, row.user_name),
    runs: runs.map((run) => runView(run, row.timezone)),
    events: events.map(eventView),
  }
}

export interface CompanyScheduleMutation {
  schedule: CompanyScheduleView
  previousStatus: string
}

export function pauseCompanySchedule(
  db: Db,
  companyId: string,
  id: string,
  at = Date.now(),
): CompanyScheduleMutation {
  const row = requireCompanySchedule(db, companyId, id)
  if (row.status === 'done' || row.status === 'cancelled') {
    throw new EabError(EC.CONFLICT, '已结束的任务不能暂停')
  }
  if (row.status === 'running') {
    throw new EabError(EC.CONFLICT, '任务正在执行，结束后再暂停')
  }
  if (row.status === 'paused') {
    return { schedule: taskView(row, row.user_name), previousStatus: row.status }
  }

  withTransaction(db, () => {
    const updated = db
      .prepare(
        "UPDATE user_schedules SET status = 'paused', updated_at = ? WHERE id = ? AND company_id = ? AND status = ?",
      )
      .run(at, id, companyId, row.status)
    if (updated.changes !== 1) {
      throw new EabError(EC.CONFLICT, '任务状态已变化，请刷新后重试')
    }
    appendScheduleEvent(
      db,
      { scheduleId: id, companyId, userId: row.user_id, type: 'pause', payload: { by: 'console' } },
      at,
    )
  })
  return {
    schedule: taskView({ ...row, status: 'paused', updated_at: at }, row.user_name),
    previousStatus: row.status,
  }
}

export function resumeCompanySchedule(
  db: Db,
  companyId: string,
  id: string,
  at = Date.now(),
): CompanyScheduleMutation {
  const row = requireCompanySchedule(db, companyId, id)
  if (row.status === 'done' || row.status === 'cancelled') {
    throw new EabError(EC.CONFLICT, '已结束的任务不能恢复')
  }
  if (row.status === 'running') {
    throw new EabError(EC.CONFLICT, '任务正在执行，结束后再恢复')
  }
  if (row.status === 'active') {
    return { schedule: taskView(row, row.user_name), previousStatus: row.status }
  }

  const rule = ruleOf(row)
  const next = nextRunAt(rule, row.timezone, at)
  withTransaction(db, () => {
    const updated = db
      .prepare(
        "UPDATE user_schedules SET status = 'active', next_run_at = ?, updated_at = ? WHERE id = ? AND company_id = ? AND status = ?",
      )
      .run(next, at, id, companyId, row.status)
    if (updated.changes !== 1) {
      throw new EabError(EC.CONFLICT, '任务状态已变化，请刷新后重试')
    }
    appendScheduleEvent(
      db,
      {
        scheduleId: id,
        companyId,
        userId: row.user_id,
        type: 'resume',
        payload: { by: 'console', nextRunAt: next },
      },
      at,
    )
  })
  return {
    schedule: taskView(
      { ...row, status: 'active', next_run_at: next, updated_at: at },
      row.user_name,
    ),
    previousStatus: row.status,
  }
}

export function cancelCompanySchedule(
  db: Db,
  companyId: string,
  id: string,
  at = Date.now(),
): CompanyScheduleMutation {
  const row = requireCompanySchedule(db, companyId, id)
  if (row.status === 'cancelled') {
    return { schedule: taskView(row, row.user_name), previousStatus: row.status }
  }
  if (row.status === 'running') {
    throw new EabError(EC.CONFLICT, '任务正在执行，结束后再取消')
  }

  withTransaction(db, () => {
    const updated = db
      .prepare(
        "UPDATE user_schedules SET status = 'cancelled', updated_at = ? WHERE id = ? AND company_id = ? AND status = ?",
      )
      .run(at, id, companyId, row.status)
    if (updated.changes !== 1) {
      throw new EabError(EC.CONFLICT, '任务状态已变化，请刷新后重试')
    }
    appendScheduleEvent(
      db,
      {
        scheduleId: id,
        companyId,
        userId: row.user_id,
        type: 'delete',
        payload: { by: 'console', previousStatus: row.status },
      },
      at,
    )
  })
  return {
    schedule: taskView({ ...row, status: 'cancelled', updated_at: at }, row.user_name),
    previousStatus: row.status,
  }
}
