import { describe, expect, it } from 'vitest'
import { openDatabase, migrate } from '@eab/storage'
import { SC } from '@eab/domain'
import { executeTool, TOOLS, toolSpecsForActor } from '../src/routes/tools.js'
import {
  bindScheduleSession,
  cancelSchedule,
  createSchedule,
  listScheduleEvents,
  nextRunAt,
  normalizeRule,
  removeSchedule,
  scheduleErrorCodeOf,
  setSchedulePaused,
  toLocalIso,
  updateSchedule,
  type ScheduleRow,
} from '../src/schedule.js'

const TZ = 'Asia/Shanghai'
const NOW = Date.parse('2026-11-09T12:00:00+08:00')

function testDb() {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  return db
}

function actor(scopes: string[]) {
  return {
    subject: {
      companyId: 'c1',
      userId: 'u1',
      status: 'active',
      deptId: 'd1',
      deptPath: '/d1',
      deptChain: [],
      roles: ['member'],
      scopes: new Set(scopes),
    },
    person: {
      id: 'u1',
      name: '测试员工',
      title: null,
      deptId: 'd1',
      deptPath: '/d1',
      deptName: '测试部门',
      companyId: 'c1',
      companyName: '测试公司',
    },
  }
}

describe('定时任务时间规则', () => {
  it('daily 到点后推进到明天同一时刻（上海时区）', () => {
    const rule = normalizeRule({ prompt: '日报', mode: 'daily', time: '09:00' })
    const next = nextRunAt(rule, TZ, NOW)
    expect(toLocalIso(next, TZ)).toBe('2026-11-10 09:00')
  })

  it('weekly 按星期集合找下一次，不会回退到今天已过的时间', () => {
    const rule = normalizeRule({ prompt: '周报', mode: 'weekly', time: '08:00', days: '1,3' })
    // 2026-11-09 是周一 12:00，下一次应是周三 08:00
    const next = nextRunAt(rule, TZ, NOW)
    expect(toLocalIso(next, TZ)).toBe('2026-11-11 08:00')
  })

  it('once 接受本地时间字符串并按任务时区解释', () => {
    const rule = normalizeRule({ prompt: '提醒', mode: 'once', at: '2026-11-10 09:00' })
    const next = nextRunAt(rule, TZ, NOW)
    expect(new Date(next).toISOString()).toBe('2026-11-10T01:00:00.000Z')
  })

  it('interval 支持数值 + 单位，秒级最低 30 秒', () => {
    const minute = normalizeRule({ prompt: '巡检', mode: 'interval', intervalValue: '5', intervalUnit: 'minute' })
    expect(minute).toEqual({ mode: 'interval', intervalValue: 5, intervalUnit: 'minute' })
    expect(nextRunAt(minute, TZ, NOW)).toBe(NOW + 5 * 60_000)

    const second = normalizeRule({ prompt: '巡检', mode: 'interval', intervalValue: 30, intervalUnit: '秒' })
    expect(second).toEqual({ mode: 'interval', intervalValue: 30, intervalUnit: 'second' })
    expect(nextRunAt(second, TZ, NOW)).toBe(NOW + 30_000)
    expect(toLocalIso(nextRunAt(second, TZ, NOW), TZ, true)).toBe('2026-11-09 12:00:30')

    expect(() => normalizeRule({ prompt: '太快', mode: 'interval', intervalValue: 29, intervalUnit: 'second' })).toThrow(/30/)
    expect(() => normalizeRule({ prompt: '巡检', mode: 'interval', intervalValue: 0, intervalUnit: 'minute' })).toThrow(/大于 0/)
    expect(() => normalizeRule({ prompt: '巡检', mode: 'interval', intervalValue: 10001, intervalUnit: 'day' })).toThrow(/10000/)
    expect(() => normalizeRule({ prompt: '巡检', mode: 'interval', intervalValue: 1, intervalUnit: 'week' })).toThrow(/间隔单位/)
  })

  it('interval 月/年按本地日历推进，月末与闰日夹到当月最后一天', () => {
    const month = normalizeRule({ prompt: '月度盘点', mode: 'interval', intervalValue: 1, intervalUnit: 'month' })
    expect(toLocalIso(nextRunAt(month, TZ, Date.parse('2026-01-31T09:00:00+08:00')), TZ)).toBe('2026-02-28 09:00')

    const year = normalizeRule({ prompt: '年度复盘', mode: 'interval', intervalValue: 1, intervalUnit: 'year' })
    expect(toLocalIso(nextRunAt(year, TZ, Date.parse('2028-02-29T09:00:00+08:00')), TZ)).toBe('2029-02-28 09:00')
  })

  it('interval 支持先设首次执行时间，之后按原定时间顺延', () => {
    const rule = normalizeRule({
      prompt: '巡检',
      mode: 'interval',
      intervalValue: '5',
      intervalUnit: 'minute',
      startAt: '2026-11-09 12:05',
    })
    expect(rule).toEqual({
      mode: 'interval',
      intervalValue: 5,
      intervalUnit: 'minute',
      startAt: '2026-11-09 12:05',
    })
    expect(nextRunAt(rule, TZ, NOW)).toBe(Date.parse('2026-11-09T12:05:00+08:00'))
    // 12:07:30 跑完，仍按 12:05 的锚点顺延到 12:10，而不是 12:12:30。
    expect(nextRunAt(rule, TZ, Date.parse('2026-11-09T12:07:30+08:00'))).toBe(
      Date.parse('2026-11-09T12:10:00+08:00'),
    )
    // 正好在锚点上完成时，下一次必须跳到再下一个周期。
    expect(nextRunAt(rule, TZ, Date.parse('2026-11-09T12:10:00+08:00'))).toBe(
      Date.parse('2026-11-09T12:15:00+08:00'),
    )
  })

  it('兼容旧 intervalMinutes 字段，按分钟解释', () => {
    const legacy = normalizeRule({ prompt: '旧任务', mode: 'interval', intervalMinutes: 5 })
    expect(legacy).toEqual({ mode: 'interval', intervalValue: 5, intervalUnit: 'minute' })
    expect(nextRunAt(legacy, TZ, NOW)).toBe(NOW + 5 * 60_000)
    expect(() => normalizeRule({ prompt: '旧任务', mode: 'interval', intervalMinutes: 0 })).toThrow(/intervalMinutes/)
  })

  it('DSH canonical 选择器：after_seconds 与 every_seconds', () => {
    const after = normalizeRule({ prompt: '一分钟后提醒', mode: '', afterSeconds: 60 })
    expect(after.mode).toBe('once')
    expect(() => normalizeRule({ prompt: '太近', mode: '', afterSeconds: 10 })).toThrow(/after_seconds/)
    try {
      normalizeRule({ prompt: '太近', mode: '', afterSeconds: 10 })
    } catch (error) {
      expect(scheduleErrorCodeOf(error)).toBe('not_future')
    }

    const every = normalizeRule({ prompt: '巡检', mode: '', everySeconds: 600 })
    expect(every).toEqual({ mode: 'interval', intervalValue: 600, intervalUnit: 'second' })
    try {
      normalizeRule({ prompt: '太快', mode: '', everySeconds: 20 })
    } catch (error) {
      expect(scheduleErrorCodeOf(error)).toBe('frequency_too_high')
    }
  })

  it('一次性任务最多提前一年', () => {
    const rule = normalizeRule({ prompt: '很久以后', mode: 'once', at: '2028-01-01T00:00:00+08:00' })
    try {
      nextRunAt(rule, TZ, NOW)
    } catch (error) {
      expect(scheduleErrorCodeOf(error)).toBe('time_out_of_range')
    }
  })
})

describe('定时任务工具与 API 共用存储', () => {
  it('注册 create/list/cancel，员工能创建自己的任务并取消', async () => {
    const db = testDb()
    const me = actor([SC.SCHEDULE_READ, SC.SCHEDULE_WRITE, SC.AGENT_TOOL_INVOKE, SC.WORKSPACE_READ])
    expect(TOOLS.some((tool) => tool.id === 'schedule.create')).toBe(true)
    const specs = toolSpecsForActor(db, me as any, { kind: 'cloud' })
    expect(specs.some((spec) => spec.function.name === 'schedule_create')).toBe(true)
    expect(specs.some((spec) => spec.function.name === 'schedule_list')).toBe(true)
    expect(specs.some((spec) => spec.function.name === 'schedule_delete')).toBe(true)

    const created = (await executeTool(
      { db, config: { dbPath: ':memory:' }, companyId: 'c1' } as any,
      me as any,
      'schedule.create',
      { prompt: '每天九点提醒我写日报', mode: 'daily', time: '09:00', title: '写日报' },
      { kind: 'cloud' },
      { sessionId: 'chat_test', channel: 'web' },
    )) as any
    expect(created.id).toMatch(/^sch_/)
    expect(created.title).toBe('写日报')
    expect(created.channel).toBe('dingtalk')
    expect(created.nextRunLocal).toMatch(/09:00$/)

    const listed = (await executeTool(
      { db, config: { dbPath: ':memory:' }, companyId: 'c1' } as any,
      me as any,
      'schedule.list',
      {},
      { kind: 'cloud' },
    )) as any
    expect(listed.schedules).toHaveLength(1)
    expect(listed.schedules[0].title).toBe('写日报')

    const removed = (await executeTool(
      { db, config: { dbPath: ':memory:' }, companyId: 'c1' } as any,
      me as any,
      'schedule.delete',
      { id: created.id },
      { kind: 'cloud' },
    )) as any
    expect(removed).toEqual({ id: created.id, deleted: true })
    expect((db as any).prepare('SELECT status FROM user_schedules WHERE id = ?').get(created.id)).toBeUndefined()
    expect(listScheduleEvents(db, created.id)).toHaveLength(0)
  })

  it('没有 schedule:write 的身份不能创建任务', async () => {
    const db = testDb()
    const me = actor([SC.SCHEDULE_READ])
    await expect(
      executeTool(
        { db, config: { dbPath: ':memory:' }, companyId: 'c1' } as any,
        me as any,
        'schedule.create',
        { prompt: '提醒', mode: 'daily', time: '09:00' },
        { kind: 'cloud' },
      ),
    ).rejects.toThrow(/schedule:write/)
  })
})

describe('定时任务编辑、重新启用与物理删除', () => {
  function writableActor() {
    return actor([SC.SCHEDULE_READ, SC.SCHEDULE_WRITE, SC.AGENT_TOOL_INVOKE, SC.WORKSPACE_READ])
  }

  function create(db: ReturnType<typeof testDb>, me: ReturnType<typeof writableActor>) {
    return createSchedule(
      db,
      me as any,
      { title: '日报', prompt: '每天九点提醒我写日报', mode: 'daily', time: '09:00', channel: 'web' },
      { sessionId: 'chat_test' },
    )
  }

  it('创建已过期的单次任务时明确说明不会执行', () => {
    const db = testDb()
    const me = writableActor()
    const past = new Date(Date.now() - 60_000).toISOString()
    try {
      createSchedule(
        db,
        me as any,
        { title: '过期提醒', prompt: '过期提醒', mode: 'once', at: past, channel: 'web' },
        { sessionId: 'chat_test' },
      )
      throw new Error('应当拒绝过期任务')
    } catch (error) {
      expect(scheduleErrorCodeOf(error)).toBe('not_future')
      expect((error as Error).message).toContain('已过期')
      expect((error as Error).message).toContain('不会执行')
    }
  })

  it('创建间隔任务按用户设定的首次时间排期，过期时间直接拒绝', () => {
    const db = testDb()
    const me = writableActor()
    const start = new Date(Date.now() + 10 * 60_000).toISOString()
    const created = createSchedule(
      db,
      me as any,
      {
        title: '巡检',
        prompt: '每五分钟巡检一次',
        mode: 'interval',
        intervalValue: '5',
        intervalUnit: 'minute',
        startAt: start,
        channel: 'web',
      },
      { sessionId: 'chat_test' },
    )
    expect(Math.abs(Date.parse(created.nextRunAt) - Date.parse(start))).toBeLessThan(1000)

    const updated = updateSchedule(db, me as any, created.id, {
      title: '巡检（改名）',
      prompt: '每五分钟巡检一次',
      mode: 'interval',
      intervalValue: '10',
      intervalUnit: 'minute',
      channel: 'web',
    })
    expect(updated.rule.startAt).toBe(start)
    expect(updated.nextRunAt).toBe(created.nextRunAt)
    expect(updated.rule.intervalValue).toBe(10)

    const past = new Date(Date.now() - 60_000).toISOString()
    try {
      createSchedule(
        db,
        me as any,
        {
          title: '已过期巡检',
          prompt: '已过期巡检',
          mode: 'interval',
          intervalValue: '5',
          intervalUnit: 'minute',
          startAt: past,
          channel: 'web',
        },
        { sessionId: 'chat_test' },
      )
      throw new Error('应当拒绝已过期的首次执行时间')
    } catch (error) {
      expect(scheduleErrorCodeOf(error)).toBe('not_future')
      expect((error as Error).message).toContain('首次执行时间')
    }
  })

  it('钉钉通道不复用网页会话，切换回推通道时解绑旧会话', () => {
    const db = testDb()
    const me = writableActor()
    const ding = createSchedule(
      db,
      me as any,
      { title: '钉钉日报', prompt: '每天九点提醒我写日报', mode: 'daily', time: '09:00', channel: 'dingtalk' },
      { sessionId: 'chat_web_source' },
    )
    expect(ding.sessionId).toBeNull()

    const web = createSchedule(
      db,
      me as any,
      { title: '网页日报', prompt: '每天九点提醒我写日报', mode: 'daily', time: '09:00', channel: 'web' },
      { sessionId: 'chat_web_source' },
    )
    expect(web.sessionId).toBe('chat_web_source')

    const switched = updateSchedule(
      db,
      me as any,
      web.id,
      { title: '网页日报', prompt: '每天九点提醒我写日报', mode: 'daily', time: '09:00', channel: 'dingtalk' },
    )
    expect(switched.channel).toBe('dingtalk')
    expect(switched.sessionId).toBeNull()
  })

  it('网页任务可以选择已有对话，也可以选择新建对话；编辑时显式 null 会解绑', () => {
    const db = testDb()
    const me = writableActor()
    const fresh = createSchedule(db, me as any, {
      title: '新建对话日报',
      prompt: '每天九点把日报发到新对话',
      mode: 'daily',
      time: '09:00',
      channel: 'web',
      sessionId: null,
    })
    expect(fresh.channel).toBe('web')
    expect(fresh.sessionId).toBeNull()

    const bound = createSchedule(db, me as any, {
      title: '绑定对话日报',
      prompt: '每天九点把日报发到指定对话',
      mode: 'daily',
      time: '09:00',
      channel: 'web',
      sessionId: 'chat_selected',
    })
    expect(bound.sessionId).toBe('chat_selected')

    const kept = updateSchedule(db, me as any, bound.id, {
      title: '绑定对话日报',
      prompt: '每天九点把日报发到指定对话',
      mode: 'daily',
      time: '09:00',
      channel: 'web',
    })
    expect(kept.sessionId).toBe('chat_selected')

    const switched = updateSchedule(db, me as any, bound.id, {
      title: '绑定对话日报',
      prompt: '每天九点把日报发到指定对话',
      mode: 'daily',
      time: '09:00',
      channel: 'web',
      sessionId: 'chat_other',
    })
    expect(switched.sessionId).toBe('chat_other')

    const detached = updateSchedule(db, me as any, bound.id, {
      title: '绑定对话日报',
      prompt: '每天九点把日报发到指定对话',
      mode: 'daily',
      time: '09:00',
      channel: 'web',
      sessionId: null,
    })
    expect(detached.sessionId).toBeNull()
  })

  it('新建对话只在首次执行建会话，后续执行沿用同一个会话', () => {
    const db = testDb()
    const me = writableActor()
    const now = Date.now()
    db.prepare("INSERT INTO companies (id, name, slug, status, created_at) VALUES ('c1', '测试公司', 'schedule-session-test', 'active', ?)").run(now)
    db.prepare("INSERT INTO departments (id, company_id, parent_id, name, path, depth, order_no, created_at) VALUES ('d1', 'c1', NULL, '测试部门', '/d1', 1, 0, ?)").run(now)
    db.prepare("INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at) VALUES ('u1', 'c1', 'd1', '/d1', '测试员工', 'active', ?, ?)").run(now, now)
    const created = createSchedule(
      db,
      me as any,
      {
        title: '新建对话巡检',
        prompt: '每五分钟巡检一次，把结果留在同一个对话',
        mode: 'daily',
        time: '09:00',
        channel: 'web',
        sessionId: null,
      },
      { sessionId: null },
    )
    const row = db.prepare('SELECT * FROM user_schedules WHERE id = ?').get(created.id) as unknown as ScheduleRow
    expect(row.session_id).toBeNull()

    const first = bindScheduleSession(db, row, '', () => {
      throw new Error('网页任务不应创建钉钉会话')
    })
    expect(first).toMatch(/^chat_/)
    const afterFirst = db.prepare('SELECT * FROM user_schedules WHERE id = ?').get(created.id) as unknown as ScheduleRow
    expect(afterFirst.session_id).toBe(first)
    expect(db.prepare("SELECT COUNT(*) AS count FROM chat_sessions WHERE company_id = 'c1' AND source = 'schedule'").get()).toEqual({ count: 1 })

    const second = bindScheduleSession(db, afterFirst, '', () => {
      throw new Error('网页任务不应创建钉钉会话')
    })
    expect(second).toBe(first)
    expect(db.prepare("SELECT COUNT(*) AS count FROM chat_sessions WHERE company_id = 'c1' AND source = 'schedule'").get()).toEqual({ count: 1 })

    const afterSecond = db.prepare('SELECT * FROM user_schedules WHERE id = ?').get(created.id) as unknown as ScheduleRow
    expect(afterSecond.session_id).toBe(first)
  })

  it('编辑启用中的任务后保持启用，并重算下次执行', () => {
    const db = testDb()
    const me = writableActor()
    const created = create(db, me)
    const edited = updateSchedule(
      db,
      me as any,
      created.id,
      { title: '周报', prompt: '每周一和周三提醒我写周报', mode: 'weekly', time: '08:00', days: '1,3', channel: 'web' },
    )
    expect(edited.status).toBe('active')
    expect(edited.title).toBe('周报')
    expect(edited.mode).toBe('weekly')
    expect(edited.rule).toEqual({ mode: 'weekly', time: '08:00', days: [1, 3] })
    expect(listScheduleEvents(db, created.id).map((event) => event.type)).toEqual(['update', 'create'])
  })

  it('编辑已暂停的任务后保持暂停，之后可以手动启用', () => {
    const db = testDb()
    const me = writableActor()
    const created = create(db, me)
    setSchedulePaused(db, me as any, created.id, true)
    const edited = updateSchedule(
      db,
      me as any,
      created.id,
      { title: '晚一点写日报', prompt: '每天十点提醒我写日报', mode: 'daily', time: '10:00', channel: 'web' },
    )
    expect(edited.status).toBe('paused')
    const resumed = setSchedulePaused(db, me as any, created.id, false)
    expect(resumed.status).toBe('active')
  })

  it('编辑已结束的任务必须显式启用，保存后转为 active', () => {
    const db = testDb()
    const me = writableActor()
    const created = create(db, me)
    cancelSchedule(db, me as any, created.id)
    expect(() =>
      updateSchedule(db, me as any, created.id, {
        title: '恢复日报',
        prompt: '每天九点提醒我写日报',
        mode: 'daily',
        time: '09:00',
        channel: 'web',
      }),
    ).toThrow(/启用/)
    const revived = updateSchedule(
      db,
      me as any,
      created.id,
      { title: '恢复日报', prompt: '每天九点提醒我写日报', mode: 'daily', time: '09:30', channel: 'web' },
      { activate: true },
    )
    expect(revived.status).toBe('active')
  })

  it('物理删除会清除任务行、执行记录和事件日志', () => {
    const db = testDb()
    const me = writableActor()
    const created = create(db, me)
    db.prepare(
      `INSERT INTO schedule_runs (id, schedule_id, company_id, user_id, scheduled_for, status, started_at, channel)
       VALUES ('run_test', ?, 'c1', 'u1', ?, 'success', ?, 'web')`,
    ).run(created.id, Date.now(), Date.now())
    expect(removeSchedule(db, me as any, created.id)).toEqual({ id: created.id, deleted: true })
    expect(db.prepare('SELECT COUNT(*) AS count FROM user_schedules WHERE id = ?').get(created.id)).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM schedule_runs WHERE schedule_id = ?').get(created.id)).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM schedule_events WHERE schedule_id = ?').get(created.id)).toEqual({ count: 0 })
    expect(listScheduleEvents(db, created.id)).toHaveLength(0)
  })

  it('执行中的任务拒绝编辑和物理删除', () => {
    const db = testDb()
    const me = writableActor()
    const created = create(db, me)
    db.prepare('UPDATE user_schedules SET status = \'running\' WHERE id = ?').run(created.id)
    expect(() =>
      updateSchedule(db, me as any, created.id, {
        title: '不能改', prompt: '不能改', mode: 'daily', time: '09:00', channel: 'web',
      }),
    ).toThrow(/正在执行/)
    expect(() => removeSchedule(db, me as any, created.id)).toThrow(/正在执行/)
  })
})
