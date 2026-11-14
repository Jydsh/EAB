import { describe, expect, it } from 'vitest'
import { migrate, openDatabase } from '@eab/storage'
import {
  cancelCompanySchedule,
  getCompanyScheduleDetail,
  listCompanySchedules,
  pauseCompanySchedule,
  resumeCompanySchedule,
} from '../src/console-schedules.js'
import { appendScheduleEvent } from '../src/schedule.js'

const NOW = Date.parse('2026-11-13T10:00:00+08:00')
const DAY = 24 * 60 * 60 * 1000

function testDb() {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  db.exec(`
    INSERT INTO companies (id, name, slug, status, created_at) VALUES ('c1', '测试公司', 'test', 'active', 1);
    INSERT INTO companies (id, name, slug, status, created_at) VALUES ('c2', '另一家公司', 'other', 'active', 1);
    INSERT INTO departments (id, company_id, name, path, depth, order_no, created_at)
      VALUES ('d1', 'c1', '测试部门', '/d1', 1, 0, 1);
    INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at)
      VALUES ('u1', 'c1', 'd1', '/d1', '测试员工', 'active', 1, 1);
  `)
  return db
}

function insertSchedule(
  db: ReturnType<typeof testDb>,
  input: {
    id: string
    companyId?: string
    userId?: string
    status?: string
    mode?: string
    payload?: Record<string, unknown>
    nextRunAt?: number
    lastRunAt?: number | null
    updatedAt?: number
  },
) {
  const companyId = input.companyId ?? 'c1'
  const userId = input.userId ?? 'u1'
  const mode = input.mode ?? 'daily'
  const payload = input.payload ?? { mode: 'daily', time: '09:00' }
  db.prepare(
    `INSERT INTO user_schedules
      (id, company_id, user_id, session_id, title, prompt, mode, payload_json, timezone,
       channel, status, next_run_at, last_run_at, last_error, attempts, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'Asia/Shanghai', 'dingtalk', ?, ?, ?, NULL, 0, ?, ?)`,
  ).run(
    input.id,
    companyId,
    userId,
    `任务 ${input.id}`,
    '生成今天的工作简报',
    mode,
    JSON.stringify(payload),
    input.status ?? 'active',
    input.nextRunAt ?? NOW + DAY,
    input.lastRunAt ?? null,
    NOW - DAY,
    input.updatedAt ?? NOW,
  )
}

function insertRun(
  db: ReturnType<typeof testDb>,
  input: {
    id: string
    scheduleId: string
    status: string
    startedAt: number
    error?: string | null
    resultText?: string | null
  },
) {
  db.prepare(
    `INSERT INTO schedule_runs
      (id, schedule_id, company_id, user_id, scheduled_for, status, started_at, finished_at,
       error, result_text, channel, delivery, delivery_error)
     VALUES (?, ?, 'c1', 'u1', ?, ?, ?, NULL, ?, ?, 'dingtalk', 'sent', NULL)`,
  ).run(
    input.id,
    input.scheduleId,
    input.startedAt,
    input.status,
    input.startedAt,
    input.error ?? null,
    input.resultText ?? null,
  )
}

describe('控制台任务中心数据层', () => {
  it('列出公司任务、状态计数和最近一次执行', () => {
    const db = testDb()
    insertSchedule(db, { id: 's1' })
    insertSchedule(db, { id: 's2', status: 'paused', updatedAt: NOW + 1 })
    insertSchedule(db, { id: 's3', companyId: 'c2' })
    insertRun(db, { id: 'r1', scheduleId: 's1', status: 'success', startedAt: NOW - 60_000, resultText: '已完成' })

    const list = listCompanySchedules(db, 'c1', 'all')

    expect(list.total).toBe(2)
    expect(list.counts.active).toBe(1)
    expect(list.counts.paused).toBe(1)
    expect(list.items.map((item) => item.id).sort()).toEqual(['s1', 's2'])
    const s1 = list.items.find((item) => item.id === 's1')
    expect(s1?.userName).toBe('测试员工')
    expect(s1?.rule).toEqual({ mode: 'daily', time: '09:00' })
    expect(s1?.lastRun?.status).toBe('success')

    const paused = listCompanySchedules(db, 'c1', 'paused')
    expect(paused.items.map((item) => item.id)).toEqual(['s2'])
  })

  it('详情同时返回执行记录与 append-only 事件流', () => {
    const db = testDb()
    insertSchedule(db, { id: 's1' })
    insertRun(db, { id: 'r1', scheduleId: 's1', status: 'error', startedAt: NOW - 60_000, error: '模型失败' })
    appendScheduleEvent(db, { scheduleId: 's1', companyId: 'c1', userId: 'u1', type: 'create' }, NOW - 2 * DAY)
    appendScheduleEvent(
      db,
      { scheduleId: 's1', companyId: 'c1', userId: 'u1', type: 'error', payload: { code: 'model_failed' } },
      NOW - 60_000,
    )

    const detail = getCompanyScheduleDetail(db, 'c1', 's1')

    expect(detail.runs).toHaveLength(1)
    expect(detail.runs[0]?.error).toBe('模型失败')
    expect(detail.events.map((event) => event.type).sort()).toEqual(['create', 'error'])
    expect(detail.events.find((event) => event.type === 'error')?.payload).toEqual({ code: 'model_failed' })
  })

  it('暂停 -> 恢复 -> 取消都会写事件，并重算下一次触发时间', () => {
    const db = testDb()
    insertSchedule(db, { id: 's1' })

    const paused = pauseCompanySchedule(db, 'c1', 's1', NOW)
    expect(paused.schedule.status).toBe('paused')
    expect(paused.previousStatus).toBe('active')

    const resumed = resumeCompanySchedule(db, 'c1', 's1', NOW)
    expect(resumed.schedule.status).toBe('active')
    expect(Date.parse(resumed.schedule.nextRunAt)).toBeGreaterThan(NOW)

    const cancelled = cancelCompanySchedule(db, 'c1', 's1', NOW)
    expect(cancelled.schedule.status).toBe('cancelled')

    const events = getCompanyScheduleDetail(db, 'c1', 's1').events.map((event) => event.type)
    expect(events).toContain('pause')
    expect(events).toContain('resume')
    expect(events).toContain('delete')
  })

  it('执行中的任务不允许暂停、恢复或取消；已结束任务不允许暂停', () => {
    const db = testDb()
    insertSchedule(db, { id: 'running', status: 'running' })
    insertSchedule(db, { id: 'done', status: 'done' })

    expect(() => pauseCompanySchedule(db, 'c1', 'running', NOW)).toThrow(/正在执行/)
    expect(() => resumeCompanySchedule(db, 'c1', 'running', NOW)).toThrow(/正在执行/)
    expect(() => cancelCompanySchedule(db, 'c1', 'running', NOW)).toThrow(/正在执行/)
    expect(() => pauseCompanySchedule(db, 'c1', 'done', NOW)).toThrow(/已结束/)
  })

  it('按公司隔离，不能通过控制台读取或修改其他公司的任务', () => {
    const db = testDb()
    insertSchedule(db, { id: 'other', companyId: 'c2' })

    expect(listCompanySchedules(db, 'c1', 'all').total).toBe(0)
    expect(() => getCompanyScheduleDetail(db, 'c1', 'other')).toThrow(/不存在/)
    expect(() => pauseCompanySchedule(db, 'c1', 'other', NOW)).toThrow(/不存在/)
  })
})
