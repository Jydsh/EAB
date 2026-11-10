/**
 * 用户自建定时任务（schedule）。
 *
 * 定位对齐 DSH `@deepseek-ai/dsh-schedule`：这不是任务编排平台，而是
 * **挂在会话上的持久提醒**——用户说“到点做某件事”，服务端把提醒写进
 * 原会话的事件流；到点后在同一会话里 follow-up 起一个新 turn。
 *
 * EAB 的差异是产品化的扩展，不照抄 DSH：
 * - DSH 只做会话内投递，EAB 额外把结果主动推到钉钉单聊（跨设备）；
 * - EAB 支持 daily/weekly 日历规则（DSH 明确不做 cron/日历）；
 * - EAB 会话是服务端持久化的，冷会话也能被“唤醒”执行，不要求客户端在线。
 *
 * 真相与投影：
 * - `schedule_events` 是 append-only 的事件日志（create/delete/fire/complete…）；
 * - `user_schedules` 是当前状态投影，`schedule_runs` 是执行投影；
 * - 同一 occurrence 用 `(schedule_id, scheduled_for)` 唯一键防重复执行。
 *
 * 不做：cron 表达式、跨用户下发、错过多个周期后的逐条回放。
 */
import { randomUUID } from 'node:crypto'
import type { Db } from '@eab/storage'
import { EC, EabError, SC } from '@eab/domain'
import type { ServerDeps } from './deps.js'
import { actorFor, findPerson, type RequestActor } from './session.js'
import { resolveModelForPurpose } from './model-registry.js'
import { publishChatEvent } from './chat-events.js'
import { dingTalkRecipientOf, sendDingTalkTextToUser } from './dingtalk-outbound.js'

export type ScheduleMode = 'once' | 'daily' | 'weekly' | 'interval'
export type ScheduleChannel = 'dingtalk' | 'web'
export type ScheduleStatus = 'active' | 'paused' | 'running' | 'done' | 'error' | 'cancelled'

/** DSH 的闭集错误码；`EabError.details.scheduleCode` 里原样带出。 */
export type ScheduleErrorCode =
  | 'invalid_prompt'
  | 'invalid_selector'
  | 'invalid_rule'
  | 'invalid_time_zone'
  | 'not_future'
  | 'time_out_of_range'
  | 'frequency_too_high'
  | 'corrupt_schedule_log'
  | 'persistence_uncertain'
  | 'internal_error'

export interface ScheduleRule {
  mode: ScheduleMode
  at?: string
  time?: string
  days?: number[]
  intervalMinutes?: number
}

export interface ScheduleInput {
  title?: string
  prompt: string
  mode: string
  at?: string
  time?: string
  days?: string | number[]
  intervalMinutes?: string | number
  /** DSH canonical：创建后多少秒触发一次（once）。 */
  afterSeconds?: string | number
  /** DSH canonical：每隔多少秒重复（interval），最小 300 秒。 */
  everySeconds?: string | number
  timezone?: string
  channel?: string
  sessionId?: string
}

export interface ScheduleRow {
  id: string
  company_id: string
  user_id: string
  session_id: string | null
  title: string
  prompt: string
  mode: ScheduleMode
  payload_json: string
  timezone: string
  channel: ScheduleChannel
  status: ScheduleStatus
  next_run_at: number
  last_run_at: number | null
  last_error: string | null
  attempts: number
  created_at: number
  updated_at: number
}

export interface ScheduleView {
  id: string
  title: string
  prompt: string
  mode: ScheduleMode
  rule: ScheduleRule
  timezone: string
  channel: ScheduleChannel
  status: ScheduleStatus
  sessionId: string | null
  nextRunAt: string
  nextRunLocal: string
  lastRunAt: string | null
  lastError: string | null
  attempts: number
  createdAt: string
}

const MODE_ALIASES: Record<string, ScheduleMode> = {
  once: 'once',
  at: 'once',
  daily: 'daily',
  weekly: 'weekly',
  interval: 'interval',
  every: 'interval',
}

const DEFAULT_TIMEZONE = 'Asia/Shanghai'
const MAX_PROMPT = 4000
const MAX_TITLE = 40
/** DSH 的 every_seconds 下限是 300 秒；EAB 沿用同一频率保护。 */
const MIN_INTERVAL_MINUTES = 5
const MAX_TASKS_PER_USER = 50
const MAX_TIME_AHEAD_MS = 365 * 24 * 60 * 60_000
const WORKER_TICK_MS = 15_000
const RETRY_DELAY_MS = 5 * 60_000
const MAX_ATTEMPTS = 3

function scheduleFailure(
  code: ScheduleErrorCode,
  message: string,
  options: { details?: Record<string, unknown>; hint?: string } = {},
): EabError {
  return new EabError(EC.VALIDATION, message, {
    details: { ...(options.details ?? {}), scheduleCode: code },
    hint:
      options.hint ??
      '请改用：after_seconds（多少秒后一次）、at（指定时间）、every_seconds（每多少秒，最少 300）、daily（每天 HH:MM）或 weekly（每周几 + HH:MM）。',
  })
}

function validation(message: string, details?: Record<string, unknown>): EabError {
  return scheduleFailure('invalid_rule', message, { details })
}

export function scheduleErrorCodeOf(error: unknown): ScheduleErrorCode | null {
  if (!(error instanceof EabError)) return null
  const code = (error.details as { scheduleCode?: unknown } | undefined)?.scheduleCode
  return typeof code === 'string' ? (code as ScheduleErrorCode) : null
}

export function normalizeTimeZone(value: string | undefined): string {
  const tz = (value ?? DEFAULT_TIMEZONE).trim()
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date())
  } catch {
    throw scheduleFailure('invalid_time_zone', `无法识别的时区：${tz}`, { details: { timezone: tz } })
  }
  return tz
}

function parseHhMm(value: string): { hour: number; minute: number } {
  const match = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(value.trim())
  if (!match) throw scheduleFailure('invalid_selector', `时间格式不对：${value}`, { details: { time: value } })
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) throw scheduleFailure('time_out_of_range', `时间超出范围：${value}`, { details: { time: value } })
  return { hour, minute }
}

function parseDays(value: string | number[] | undefined): number[] {
  const raw = Array.isArray(value)
    ? value.map(String)
    : String(value ?? '')
        .split(/[，,、\s]+/)
        .filter(Boolean)
  if (raw.length === 0) throw scheduleFailure('invalid_selector', 'weekly 任务需要指定星期（0=周日 … 6=周六）')
  const days = [...new Set(raw.map((item) => Number(item)))].sort((a, b) => a - b)
  if (days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    throw scheduleFailure('invalid_selector', `星期只能是 0-6：${raw.join(',')}`)
  }
  return days
}

interface LocalParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  weekday: number
}

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

function localPartsOf(epoch: number, timezone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(new Date(epoch))
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  return {
    year: Number(pick('year')),
    month: Number(pick('month')),
    day: Number(pick('day')),
    hour: Number(pick('hour')),
    minute: Number(pick('minute')),
    second: Number(pick('second')),
    weekday: WEEKDAY[pick('weekday')] ?? 0,
  }
}

function offsetAt(epoch: number, timezone: string): number {
  const p = localPartsOf(epoch, timezone)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - epoch
}

/** 把某个时区的“年月日时分秒”换成一个绝对时间；夏令时用两轮修正。 */
function zonedToEpoch(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timezone: string,
): number {
  let guess = Date.UTC(year, month - 1, day, hour, minute, second)
  for (let i = 0; i < 3; i += 1) {
    const next = Date.UTC(year, month - 1, day, hour, minute, second) - offsetAt(guess, timezone)
    if (next === guess) break
    guess = next
  }
  return guess
}

function addLocalDays(year: number, month: number, day: number, delta: number): { year: number; month: number; day: number } {
  const date = new Date(Date.UTC(year, month - 1, day + delta))
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }
}

/** 一次性时间支持 ISO 带偏移，也支持“YYYY-MM-DD HH:mm”按任务时区解释。 */
function parseAt(value: string, timezone: string): number {
  const trimmed = value.trim()
  const local = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed)
  if (local) {
    return zonedToEpoch(
      Number(local[1]),
      Number(local[2]),
      Number(local[3]),
      Number(local[4]),
      Number(local[5]),
      Number(local[6] ?? 0),
      timezone,
    )
  }
  const epoch = Date.parse(trimmed)
  if (Number.isNaN(epoch)) {
    throw scheduleFailure('invalid_selector', `时间格式不对：${value}`, { details: { at: value } })
  }
  return epoch
}

export function normalizeRule(input: ScheduleInput): ScheduleRule {
  const rawMode = String(input.mode ?? '').trim().toLowerCase()
  // DSH canonical 选择器优先：给了 after_seconds / every_seconds 就不要求 mode。
  const afterSeconds = Number(input.afterSeconds)
  const everySeconds = Number(input.everySeconds)
  if (Number.isFinite(everySeconds) && everySeconds > 0) {
    if (everySeconds < MIN_INTERVAL_MINUTES * 60) {
      throw scheduleFailure('frequency_too_high', `every_seconds 不能小于 ${MIN_INTERVAL_MINUTES * 60} 秒`, {
        details: { everySeconds },
      })
    }
    return { mode: 'interval', intervalMinutes: Math.floor(everySeconds / 60) }
  }
  if (Number.isFinite(afterSeconds) && afterSeconds > 0) {
    if (afterSeconds < 30) {
      throw scheduleFailure('not_future', 'after_seconds 至少为 30 秒', { details: { afterSeconds } })
    }
    return { mode: 'once', at: new Date(Date.now() + afterSeconds * 1000).toISOString() }
  }
  const mode = MODE_ALIASES[rawMode]
  if (!mode) {
    throw scheduleFailure('invalid_selector', `不支持的定时方式：${input.mode || '(空)'}`, {
      details: { mode: input.mode },
    })
  }

  if (mode === 'once') {
    if (!input.at) {
      throw scheduleFailure('invalid_selector', 'once 任务需要 at（例如 2026-11-10 09:00 或带时区的 ISO 时间）')
    }
    return { mode, at: input.at.trim() }
  }
  if (mode === 'daily') {
    if (!input.time) throw scheduleFailure('invalid_selector', 'daily 任务需要 time（HH:MM）')
    parseHhMm(input.time)
    return { mode, time: input.time.trim() }
  }
  if (mode === 'weekly') {
    if (!input.time) throw scheduleFailure('invalid_selector', 'weekly 任务需要 time（HH:MM）')
    parseHhMm(input.time)
    return { mode, time: input.time.trim(), days: parseDays(input.days) }
  }
  const minutes = Number(input.intervalMinutes)
  if (!Number.isFinite(minutes) || minutes < MIN_INTERVAL_MINUTES) {
    throw scheduleFailure(
      minutes > 0 && minutes < MIN_INTERVAL_MINUTES ? 'frequency_too_high' : 'invalid_rule',
      `interval 任务需要 intervalMinutes >= ${MIN_INTERVAL_MINUTES}`,
      { details: { intervalMinutes: input.intervalMinutes } },
    )
  }
  return { mode, intervalMinutes: Math.floor(minutes) }
}

/** 下一次触发时间（绝对毫秒）。创建时和每次执行后都用它推进。 */
export function nextRunAt(rule: ScheduleRule, timezone: string, now = Date.now()): number {
  if (rule.mode === 'once') {
    if (!rule.at) throw scheduleFailure('invalid_rule', 'once 任务缺少 at')
    const epoch = parseAt(rule.at, timezone)
    if (epoch > now + MAX_TIME_AHEAD_MS) {
      throw scheduleFailure('time_out_of_range', '一次性任务不能超过一年后执行', { details: { at: rule.at } })
    }
    return epoch
  }
  if (rule.mode === 'interval') {
    return now + Math.max(MIN_INTERVAL_MINUTES, rule.intervalMinutes ?? MIN_INTERVAL_MINUTES) * 60_000
  }
  const { hour, minute } = parseHhMm(rule.time ?? '')
  if (rule.mode === 'daily') {
    const p = localPartsOf(now, timezone)
    let target = zonedToEpoch(p.year, p.month, p.day, hour, minute, 0, timezone)
    if (target <= now) {
      const date = addLocalDays(p.year, p.month, p.day, 1)
      target = zonedToEpoch(date.year, date.month, date.day, hour, minute, 0, timezone)
    }
    return target
  }
  if (rule.mode === 'weekly') {
    const days = rule.days ?? []
    const p = localPartsOf(now, timezone)
    for (let delta = 0; delta <= 7; delta += 1) {
      const date = addLocalDays(p.year, p.month, p.day, delta)
      const candidate = zonedToEpoch(date.year, date.month, date.day, hour, minute, 0, timezone)
      if (candidate <= now) continue
      if (days.includes(localPartsOf(candidate, timezone).weekday)) return candidate
    }
    throw validation('weekly 没有找到下一次触发时间')
  }
  throw validation('定时规则缺少模式')
}

export function toLocalIso(epoch: number, timezone: string): string {
  const p = localPartsOf(epoch, timezone)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`
}

function rowView(row: ScheduleRow): ScheduleView {
  const rule = JSON.parse(row.payload_json) as ScheduleRule
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    mode: row.mode,
    rule,
    timezone: row.timezone,
    channel: row.channel,
    status: row.status,
    sessionId: row.session_id,
    nextRunAt: new Date(row.next_run_at).toISOString(),
    nextRunLocal: toLocalIso(row.next_run_at, row.timezone),
    lastRunAt: row.last_run_at ? new Date(row.last_run_at).toISOString() : null,
    lastError: row.last_error,
    attempts: row.attempts,
    createdAt: new Date(row.created_at).toISOString(),
  }
}

export type ScheduleEventType =
  | 'create'
  | 'delete'
  | 'pause'
  | 'resume'
  | 'fire'
  | 'complete'
  | 'error'
  | 'delivery'
  | 'recover'

export interface ScheduleEventRow {
  id: string
  schedule_id: string
  company_id: string
  user_id: string
  type: ScheduleEventType
  payload_json: string
  created_at: number
}

/** 追加一条不可变事件；调用方负责和状态投影放在同一事务里。 */
export function appendScheduleEvent(
  db: Db,
  input: {
    scheduleId: string
    companyId: string
    userId: string
    type: ScheduleEventType
    payload?: Record<string, unknown>
  },
  at = Date.now(),
): void {
  db.prepare(
    `INSERT INTO schedule_events (id, schedule_id, company_id, user_id, type, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `evt_${randomUUID()}`,
    input.scheduleId,
    input.companyId,
    input.userId,
    input.type,
    JSON.stringify(input.payload ?? {}),
    at,
  )
}

export function listScheduleEvents(db: Db, scheduleId: string, limit = 100): ScheduleEventRow[] {
  return db
    .prepare(
      `SELECT * FROM schedule_events WHERE schedule_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(scheduleId, limit) as unknown as ScheduleEventRow[]
}

function transaction(db: Db, fn: () => void): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    fn()
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // 回滚失败时保留原始错误，避免把真正的失败原因吞掉。
    }
    throw error
  }
}

function findSchedule(db: Db, companyId: string, userId: string, id: string): ScheduleRow | null {
  const row = db
    .prepare('SELECT * FROM user_schedules WHERE id = ? AND company_id = ? AND user_id = ?')
    .get(id, companyId, userId) as unknown as ScheduleRow | undefined
  return row ?? null
}

export function createSchedule(
  db: Db,
  actor: RequestActor,
  input: ScheduleInput,
  options: { sessionId?: string; channel?: string } = {},
): ScheduleView {
  if (!actor.subject.scopes.has(SC.SCHEDULE_WRITE)) {
    throw new EabError(EC.SCOPE_DENIED, '当前身份没有创建定时任务的权限（schedule:write）')
  }
  const prompt = String(input.prompt ?? '').trim()
  if (!prompt) throw scheduleFailure('invalid_prompt', 'prompt 不能为空（到点要执行的任务描述）')
  if (prompt.length > MAX_PROMPT) {
    throw scheduleFailure('invalid_prompt', `任务描述太长，最多 ${MAX_PROMPT} 字`, {
      details: { length: prompt.length, limit: MAX_PROMPT },
    })
  }

  const count = db
    .prepare('SELECT COUNT(*) AS count FROM user_schedules WHERE company_id = ? AND user_id = ? AND status IN (\'active\',\'paused\',\'running\')')
    .get(actor.subject.companyId, actor.person.id) as { count: number }
  if (Number(count.count) >= MAX_TASKS_PER_USER) {
    throw scheduleFailure('frequency_too_high', `每个员工最多保留 ${MAX_TASKS_PER_USER} 个进行中的定时任务`, {
      hint: '请先删除不再需要的任务。',
    })
  }

  const timezone = normalizeTimeZone(input.timezone)
  const rule = normalizeRule(input)
  const now = Date.now()
  const next = nextRunAt(rule, timezone, now)
  if (rule.mode === 'once' && next <= now + 30_000) {
    throw scheduleFailure('not_future', '一次性任务时间必须至少晚于当前时间 30 秒', {
      details: { nextRunAt: new Date(next).toISOString() },
    })
  }
  const channel = (String(input.channel ?? 'dingtalk').trim() as ScheduleChannel)
  if (channel !== 'dingtalk' && channel !== 'web') {
    throw scheduleFailure('invalid_rule', `不支持的投递通道：${channel}`, { details: { channel } })
  }

  const title =
    String(input.title ?? '').trim().slice(0, MAX_TITLE) ||
    (prompt.length > 20 ? `${prompt.slice(0, 20)}…` : prompt)
  const id = `sch_${randomUUID()}`
  const payload = JSON.stringify(rule)
  const sessionId = options.sessionId || input.sessionId || null
  try {
    transaction(db, () => {
      db.prepare(
        `INSERT INTO user_schedules
           (id, company_id, user_id, session_id, title, prompt, mode, payload_json, timezone, channel,
            status, next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      ).run(
        id,
        actor.subject.companyId,
        actor.person.id,
        sessionId,
        title,
        prompt,
        rule.mode,
        payload,
        timezone,
        channel,
        next,
        now,
        now,
      )
      appendScheduleEvent(
        db,
        {
          scheduleId: id,
          companyId: actor.subject.companyId,
          userId: actor.person.id,
          type: 'create',
          payload: { title, prompt, rule, timezone, channel, sessionId, nextRunAt: next },
        },
        now,
      )
    })
  } catch (error) {
    throw scheduleFailure('persistence_uncertain', '定时任务没有保存成功，请稍后重试', {
      details: { cause: error instanceof Error ? error.message : String(error) },
    })
  }
  const row = findSchedule(db, actor.subject.companyId, actor.person.id, id)
  if (!row) throw scheduleFailure('persistence_uncertain', '定时任务保存后读取失败')
  return rowView(row)
}

export function listSchedules(
  db: Db,
  actor: RequestActor,
  status?: string,
): ScheduleView[] {
  if (!actor.subject.scopes.has(SC.SCHEDULE_READ)) {
    throw new EabError(EC.SCOPE_DENIED, '当前身份没有查看定时任务的权限（schedule:read）')
  }
  const normalized = status && ['active', 'paused', 'done', 'error', 'cancelled', 'running'].includes(status) ? status : null
  const rows = (normalized
    ? db
        .prepare('SELECT * FROM user_schedules WHERE company_id = ? AND user_id = ? AND status = ? ORDER BY created_at DESC LIMIT 100')
        .all(actor.subject.companyId, actor.person.id, normalized)
    : db
        .prepare('SELECT * FROM user_schedules WHERE company_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 100')
        .all(actor.subject.companyId, actor.person.id)) as unknown as ScheduleRow[]
  return rows.map(rowView)
}

/** DSH 的 delete 语义：删除即终止，不再有后续 occurrence。 */
export function deleteSchedule(db: Db, actor: RequestActor, id: string): ScheduleView {
  if (!actor.subject.scopes.has(SC.SCHEDULE_WRITE)) {
    throw new EabError(EC.SCOPE_DENIED, '当前身份没有删除定时任务的权限（schedule:write）')
  }
  const row = findSchedule(db, actor.subject.companyId, actor.person.id, id)
  if (!row) throw new EabError(EC.NOT_FOUND, `定时任务不存在：${id}`)
  if (row.status === 'cancelled') return rowView(row)
  const now = Date.now()
  transaction(db, () => {
    db.prepare('UPDATE user_schedules SET status = \'cancelled\', updated_at = ? WHERE id = ?').run(now, id)
    appendScheduleEvent(
      db,
      {
        scheduleId: id,
        companyId: row.company_id,
        userId: row.user_id,
        type: 'delete',
        payload: { previousStatus: row.status },
      },
      now,
    )
  })
  return rowView({ ...row, status: 'cancelled', updated_at: now })
}

/** 兼容旧调用名；语义就是 DSH 的 delete。 */
export function cancelSchedule(db: Db, actor: RequestActor, id: string): ScheduleView {
  return deleteSchedule(db, actor, id)
}

export function setSchedulePaused(db: Db, actor: RequestActor, id: string, paused: boolean): ScheduleView {
  if (!actor.subject.scopes.has(SC.SCHEDULE_WRITE)) {
    throw new EabError(EC.SCOPE_DENIED, '当前身份没有修改定时任务的权限（schedule:write）')
  }
  const row = findSchedule(db, actor.subject.companyId, actor.person.id, id)
  if (!row) throw new EabError(EC.NOT_FOUND, `定时任务不存在：${id}`)
  if (row.status === 'done' || row.status === 'cancelled') {
    throw new EabError(EC.CONFLICT, '已结束的任务不能暂停或恢复')
  }
  const now = Date.now()
  if (paused) {
    transaction(db, () => {
      db.prepare('UPDATE user_schedules SET status = \'paused\', updated_at = ? WHERE id = ?').run(now, id)
      appendScheduleEvent(
        db,
        { scheduleId: id, companyId: row.company_id, userId: row.user_id, type: 'pause' },
        now,
      )
    })
    return rowView({ ...row, status: 'paused', updated_at: now })
  }
  const rule = JSON.parse(row.payload_json) as ScheduleRule
  const next = nextRunAt(rule, row.timezone, now)
  transaction(db, () => {
    db.prepare('UPDATE user_schedules SET status = \'active\', next_run_at = ?, updated_at = ? WHERE id = ?').run(next, now, id)
    appendScheduleEvent(
      db,
      { scheduleId: id, companyId: row.company_id, userId: row.user_id, type: 'resume', payload: { nextRunAt: next } },
      now,
    )
  })
  return rowView({ ...row, status: 'active', next_run_at: next, updated_at: now })
}

/** 执行一个到期任务；结果写入 chat_messages，并按 channel 回推。 */
async function runSchedule(deps: ServerDeps, row: ScheduleRow, runId: string): Promise<{ resultText: string; delivered: boolean; deliveryError?: string }> {
  const person = findPerson(deps.db, row.user_id)
  if (!person) throw new EabError(EC.NOT_FOUND, '任务创建人已不存在')
  if (person.companyId !== row.company_id) throw new EabError(EC.FORBIDDEN, '任务与创建人不在同一公司')
  const actor = actorFor(deps.db, person)
  if (!actor.subject.scopes.has(SC.SCHEDULE_WRITE)) {
    throw new EabError(EC.SCOPE_DENIED, '创建人已没有定时任务权限')
  }

  // 动态导入避免 schedule -> chat -> tools -> schedule 的静态循环。
  const chat = await import('./routes/chat.js')
  const { toolSpecsForAgent } = await import('./routes/tools.js')
  const catalog = chat.loadModelCatalog(deps.db, row.company_id, deps.config.devAuth)
  const visible = chat.visibleModelsFor(catalog, [...actor.subject.roles])
  const routed = resolveModelForPurpose(deps.db, row.company_id, 'chat.default')
  const model = (routed && visible.find((item) => item.id === routed.id)) ?? visible[0]
  if (!model) throw new EabError(EC.CONFLICT, '当前身份没有可用模型，定时任务无法执行')

  const externalUserId = row.channel === 'dingtalk' ? dingTalkRecipientOf(deps, row.company_id, row.user_id) : ''
  let sessionId = row.session_id
  if (sessionId) {
    const exists = deps.db
      .prepare('SELECT id FROM chat_sessions WHERE id = ? AND company_id = ? AND user_id = ? AND deleted_at IS NULL')
      .get(sessionId, row.company_id, row.user_id) as { id: string } | undefined
    if (!exists) sessionId = null
  }
  if (!sessionId && row.channel === 'dingtalk') {
    sessionId = chat.ensureChannelSession(deps.db, actor, 'dingtalk', externalUserId, `⏰ ${row.title}`)
  }
  if (!sessionId) {
    sessionId = `chat_${randomUUID()}`
    const now = Date.now()
    deps.db
      .prepare(
        `INSERT INTO chat_sessions (id, company_id, user_id, title, created_at, updated_at, last_message_at, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'schedule')`,
      )
      .run(sessionId, row.company_id, row.user_id, `定时任务 · ${row.title}`.slice(0, 40), now, now, now)
  }
  // 回写会话 id：下次执行继续用同一个会话，网页也能从这条会话看到历史。
  if (row.session_id !== sessionId) {
    deps.db
      .prepare('UPDATE user_schedules SET session_id = ?, updated_at = ? WHERE id = ?')
      .run(sessionId, Date.now(), row.id)
  }

  const tools = toolSpecsForAgent(deps.db, actor, { kind: 'cloud' })
  const system = chat.buildSystemPrompt({
    actor,
    chatTools: tools,
    memories: [],
    hits: [],
    hasAttachments: false,
    spaceLabel: '云空间（定时任务自动执行）',
  })
  // DSH 的 follow-up 语义：到点后不是“假装用户又发了一条”，而是带提醒信封的
  // 新 turn。模型能明确知道这是计划任务，回答里也会自然带出时间。
  const reminderText =
    `【定时提醒】${row.title}\n` +
    `计划时间：${toLocalIso(row.next_run_at, row.timezone)}（${row.timezone}）\n` +
    `任务：${row.prompt}`
  const history = chat.historyOf(deps.db, sessionId, 8, row.channel === 'dingtalk' ? 'dingtalk' : undefined)
  const messages = [
    { role: 'system' as const, content: system },
    ...history,
    { role: 'user' as const, content: reminderText },
  ]

  const now = Date.now()
  const userMessageId = `msg_${randomUUID()}`
  deps.db
    .prepare(
      `INSERT INTO chat_messages (id, company_id, session_id, user_id, role, text, model_id, model_name, meta_json, created_at)
       VALUES (?, ?, ?, ?, 'user', ?, ?, ?, ?, ?)`,
    )
    .run(
      userMessageId,
      row.company_id,
      sessionId,
      row.user_id,
      reminderText,
      model.id,
      model.name,
      JSON.stringify({
        channel: row.channel,
        scheduleId: row.id,
        scheduled: true,
        scheduledFor: row.next_run_at,
        framing: 'schedule_reminder',
      }),
      now,
    )
  publishChatEvent({
    type: 'message',
    companyId: row.company_id,
    userId: row.user_id,
    sessionId,
    message: {
      id: userMessageId,
      role: 'user',
      text: reminderText,
      modelId: model.id,
      modelName: model.name,
      meta: {
        channel: row.channel,
        scheduleId: row.id,
        scheduled: true,
        scheduledFor: row.next_run_at,
        framing: 'schedule_reminder',
      },
      createdAt: new Date(now).toISOString(),
    },
  })

  const trace: Array<{ id: string; name: string; toolId: string; args: unknown; status: string; summary: string; durationMs: number }> = []
  const agent = await chat.runAgentTurn({
    deps,
    actor,
    modelId: model.id,
    messages,
    sessionId,
    space: { kind: 'cloud' },
    emit: (event) => {
      if (event.type === 'tool') {
        trace.push({ id: event.id, name: event.name, toolId: event.toolId, args: event.args, status: 'running', summary: '执行中…', durationMs: 0 })
      } else if (event.type === 'tool_result') {
        const current = trace.find((item) => item.id === event.id)
        if (current) {
          current.status = event.status
          current.summary = event.summary
          current.durationMs = event.durationMs
        }
      }
    },
  })

  const fallback = '（定时任务已执行，但当前模型来自演示供应商，没有返回真实结果）'
  const resultText = agent?.text?.trim() || fallback
  const assistantMessageId = `msg_${randomUUID()}`
  const finishedAt = Date.now()
  deps.db
    .prepare(
      `INSERT INTO chat_messages (id, company_id, session_id, user_id, role, text, model_id, model_name, meta_json, created_at)
       VALUES (?, ?, ?, ?, 'assistant', ?, ?, ?, ?, ?)`,
    )
    .run(
      assistantMessageId,
      row.company_id,
      sessionId,
      row.user_id,
      resultText,
      model.id,
      model.name,
      JSON.stringify({
        channel: row.channel,
        scheduleId: row.id,
        scheduled: true,
        reasoning: agent?.reasoning ?? '',
        tools: trace,
        runId,
      }),
      finishedAt,
    )
  deps.db
    .prepare('UPDATE chat_sessions SET updated_at = ?, last_message_at = ? WHERE id = ?')
    .run(finishedAt, finishedAt, sessionId)
  chat.bumpUsage(deps.db, row.company_id, row.user_id, agent?.promptTokens ?? 0, agent?.completionTokens ?? 0)
  publishChatEvent({
    type: 'message',
    companyId: row.company_id,
    userId: row.user_id,
    sessionId,
    message: {
      id: assistantMessageId,
      role: 'assistant',
      text: resultText,
      modelId: model.id,
      modelName: model.name,
      meta: { channel: row.channel, scheduleId: row.id, scheduled: true, reasoning: agent?.reasoning ?? '', tools: trace, runId },
      createdAt: new Date(finishedAt).toISOString(),
    },
  })

  let delivered = false
  let deliveryError: string | undefined
  if (row.channel === 'dingtalk') {
    try {
      await sendDingTalkTextToUser(deps, {
        companyId: row.company_id,
        userId: row.user_id,
        text: `⏰ ${row.title}\n\n${resultText}`,
      })
      delivered = true
    } catch (error) {
      deliveryError = error instanceof EabError ? error.message : (error as Error)?.message ?? '钉钉推送失败'
    }
  } else {
    delivered = true
  }
  return { resultText, delivered, deliveryError }
}

async function executeDueSchedule(deps: ServerDeps, row: ScheduleRow): Promise<void> {
  const now = Date.now()
  const runId = `run_${randomUUID()}`
  const inserted = deps.db
    .prepare(
      `INSERT OR IGNORE INTO schedule_runs
        (id, schedule_id, company_id, user_id, scheduled_for, status, started_at, channel)
       VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`,
    )
    .run(runId, row.id, row.company_id, row.user_id, row.next_run_at, now, row.channel)
  if (Number(inserted.changes) === 0) return

  // 事件日志先落 fire，再执行模型；fire 只代表“已派发”，不等于模型成功。
  appendScheduleEvent(deps.db, {
    scheduleId: row.id,
    companyId: row.company_id,
    userId: row.user_id,
    type: 'fire',
    payload: { runId, scheduledFor: row.next_run_at, channel: row.channel },
  }, now)

  deps.db
    .prepare('UPDATE user_schedules SET status = \'running\', last_run_at = ?, updated_at = ? WHERE id = ? AND status = \'active\'')
    .run(now, now, row.id)

  try {
    const outcome = await runSchedule(deps, row, runId)
    const finishedAt = Date.now()
    deps.db
      .prepare(
        `UPDATE schedule_runs SET status = 'success', finished_at = ?, result_text = ?,
           delivery = ?, delivery_error = ? WHERE id = ?`,
      )
      .run(finishedAt, outcome.resultText.slice(0, 8000), outcome.delivered ? 'sent' : 'failed', outcome.deliveryError ?? null, runId)

    const rule = JSON.parse(row.payload_json) as ScheduleRule
    if (rule.mode === 'once') {
      deps.db
        .prepare('UPDATE user_schedules SET status = \'done\', last_error = ?, updated_at = ? WHERE id = ?')
        .run(outcome.deliveryError ?? null, finishedAt, row.id)
    } else {
      // latest-only：只按“现在”推进下一次，不补跑错过的多个周期。
      const next = nextRunAt(rule, row.timezone, finishedAt)
      deps.db
        .prepare('UPDATE user_schedules SET status = \'active\', next_run_at = ?, attempts = 0, last_error = ?, updated_at = ? WHERE id = ?')
        .run(next, outcome.deliveryError ?? null, finishedAt, row.id)
    }
    try {
      appendScheduleEvent(deps.db, {
        scheduleId: row.id,
        companyId: row.company_id,
        userId: row.user_id,
        type: 'complete',
        payload: { runId, resultText: outcome.resultText.slice(0, 2000), delivered: outcome.delivered },
      }, finishedAt)
      appendScheduleEvent(deps.db, {
        scheduleId: row.id,
        companyId: row.company_id,
        userId: row.user_id,
        type: 'delivery',
        payload: { runId, channel: row.channel, ok: outcome.delivered, error: outcome.deliveryError ?? null },
      }, finishedAt)
    } catch (eventError) {
      console.warn('[eab] 定时任务完成事件写入失败：', (eventError as Error).message)
    }
    console.log(
      `[eab] 定时任务已执行：${row.title}（${row.id}）${outcome.delivered ? '，已推送到钉钉' : '，钉钉推送失败：' + (outcome.deliveryError ?? '未知原因')}`,
    )
  } catch (error) {
    const finishedAt = Date.now()
    const message = error instanceof EabError ? error.message : (error as Error)?.message ?? '定时任务执行失败'
    deps.db
      .prepare(`UPDATE schedule_runs SET status = 'error', finished_at = ?, error = ? WHERE id = ?`)
      .run(finishedAt, message.slice(0, 1000), runId)
    const attempts = Number(row.attempts) + 1
    if (attempts >= MAX_ATTEMPTS) {
      deps.db
        .prepare('UPDATE user_schedules SET status = \'error\', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?')
        .run(attempts, message.slice(0, 1000), finishedAt, row.id)
    } else {
      deps.db
        .prepare('UPDATE user_schedules SET status = \'active\', next_run_at = ?, attempts = ?, last_error = ?, updated_at = ? WHERE id = ?')
        .run(finishedAt + RETRY_DELAY_MS, attempts, message.slice(0, 1000), finishedAt, row.id)
    }
    try {
      appendScheduleEvent(deps.db, {
        scheduleId: row.id,
        companyId: row.company_id,
        userId: row.user_id,
        type: 'error',
        payload: {
          runId,
          attempts,
          error: message.slice(0, 1000),
          scheduleCode: scheduleErrorCodeOf(error),
          retryAt: attempts >= MAX_ATTEMPTS ? null : finishedAt + RETRY_DELAY_MS,
        },
      }, finishedAt)
    } catch (eventError) {
      console.warn('[eab] 定时任务失败事件写入失败：', (eventError as Error).message)
    }
    console.warn(`[eab] 定时任务执行失败：${row.title}（${row.id}）：${message}`)
  }
}

let workerStarted = false

/** 启动调度器：每 15 秒扫一次到期任务；`unref()` 不阻止进程退出。 */
export function startScheduleWorker(deps: ServerDeps): () => void {
  if (workerStarted) return () => {}
  workerStarted = true

  // 上次进程异常退出留下的 running 记录：不重放，避免同一任务重复执行。
  const now = Date.now()
  try {
    deps.db
      .prepare(
        `UPDATE schedule_runs SET status = 'error', finished_at = ?, error = 'host_interrupted'
          WHERE status = 'running' AND started_at < ?`,
      )
      .run(now, now - 10 * 60_000)
    const stuck = deps.db
      .prepare('SELECT id, company_id, user_id FROM user_schedules WHERE status = \'running\'')
      .all() as unknown as Array<{ id: string; company_id: string; user_id: string }>
    deps.db
      .prepare('UPDATE user_schedules SET status = \'active\', updated_at = ? WHERE status = \'running\'')
      .run(now)
    for (const row of stuck) {
      appendScheduleEvent(
        deps.db,
        {
          scheduleId: row.id,
          companyId: row.company_id,
          userId: row.user_id,
          type: 'recover',
          payload: { reason: 'host_interrupted', replayed: false },
        },
        now,
      )
    }
  } catch (error) {
    console.warn('[eab] 定时任务恢复旧记录失败：', (error as Error).message)
  }

  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      const due = deps.db
        .prepare(
          `SELECT * FROM user_schedules
            WHERE status = 'active' AND next_run_at <= ?
            ORDER BY CASE WHEN mode = 'once' THEN 0 ELSE 1 END, next_run_at ASC
            LIMIT 5`,
        )
        .all(Date.now()) as unknown as ScheduleRow[]
      for (const row of due) await executeDueSchedule(deps, row)
    } catch (error) {
      console.warn('[eab] 定时任务调度失败：', (error as Error).message)
    } finally {
      running = false
    }
  }

  const first = setTimeout(() => void tick(), 10_000)
  const timer = setInterval(() => void tick(), WORKER_TICK_MS)
  first.unref()
  timer.unref()
  return () => {
    workerStarted = false
    clearTimeout(first)
    clearInterval(timer)
  }
}
