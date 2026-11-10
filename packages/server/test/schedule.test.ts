import { describe, expect, it } from 'vitest'
import { openDatabase, migrate } from '@eab/storage'
import { SC } from '@eab/domain'
import { executeTool, TOOLS, toolSpecsForActor } from '../src/routes/tools.js'
import { listScheduleEvents, nextRunAt, normalizeRule, scheduleErrorCodeOf, toLocalIso } from '../src/schedule.js'

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

  it('interval 最小间隔 5 分钟（对齐 DSH every_seconds >= 300）', () => {
    const rule = normalizeRule({ prompt: '巡检', mode: 'interval', intervalMinutes: 5 })
    expect(nextRunAt(rule, TZ, NOW)).toBe(NOW + 5 * 60_000)
    expect(() => normalizeRule({ prompt: '巡检', mode: 'interval', intervalMinutes: 0 })).toThrow(/interval/)
    expect(() => normalizeRule({ prompt: '巡检', mode: 'interval', intervalMinutes: 1 })).toThrow(/interval/)
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
    expect(every).toEqual({ mode: 'interval', intervalMinutes: 10 })
    try {
      normalizeRule({ prompt: '太快', mode: '', everySeconds: 60 })
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

    const cancelled = (await executeTool(
      { db, config: { dbPath: ':memory:' }, companyId: 'c1' } as any,
      me as any,
      'schedule.delete',
      { id: created.id },
      { kind: 'cloud' },
    )) as any
    expect(cancelled.status).toBe('cancelled')
    expect((db as any).prepare('SELECT status FROM user_schedules WHERE id = ?').get(created.id).status).toBe('cancelled')
    // 事件日志是真相：create + delete 两条，且删除事件排在前面（DESC）。
    const events = listScheduleEvents(db, created.id)
    expect(events.map((event) => event.type)).toEqual(['delete', 'create'])
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
