import { describe, expect, it } from 'vitest'
import { migrate, openDatabase } from '@eab/storage'
import type { ServerDeps } from '../src/deps.js'
import {
  adoptLegacyInterruptedTurns,
  beginChannelTurn,
  finishChannelTurn,
  getChannelTurn,
  listRecoverableChannelTurns,
} from '../src/channel-turns.js'
import { recoverInterruptedDingTalkTurns } from '../src/dingtalk-bot.js'

function seedDb() {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  const now = Date.now()
  db.prepare(
    `INSERT INTO companies (id, name, slug, status, created_at) VALUES ('c1', '测试公司', 'test', 'active', ?)`,
  ).run(now)
  db.prepare(
    `INSERT INTO departments (id, company_id, name, path, depth, order_no, created_at)
     VALUES ('d1', 'c1', '经营中心', '/经营中心', 1, 0, ?)`,
  ).run(now)
  db.prepare(
    `INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at)
     VALUES ('u1', 'c1', 'd1', '/经营中心', '测试员工', 'active', ?, ?)`,
  ).run(now, now)
  db.prepare(
    `INSERT INTO chat_sessions (id, company_id, user_id, title, source, external_id, created_at, updated_at)
     VALUES ('s1', 'c1', 'u1', '钉钉会话', 'dingtalk', 'staff-1', ?, ?)`,
  ).run(now, now)
  db.prepare(
    `INSERT INTO user_identities (id, user_id, provider, external_user_id, bound_at, status)
     VALUES ('id1', 'u1', 'dingtalk', 'staff-1', ?, 'active')`,
  ).run(now)
  return db
}

function depsOf(db: ReturnType<typeof seedDb>): ServerDeps {
  return {
    db,
    companyId: 'c1',
    config: { dbPath: ':memory:' },
  } as unknown as ServerDeps
}

function addTurn(db: ReturnType<typeof seedDb>) {
  beginChannelTurn(db, {
    id: 'turn-1',
    companyId: 'c1',
    provider: 'dingtalk',
    externalId: 'staff-1',
    userId: 'u1',
    sessionId: 's1',
    eventKey: 'msg-1',
    payload: {
      msgId: 'msg-1',
      senderStaffId: 'staff-1',
      conversationType: '1',
      text: { content: '经营中心有哪些人' },
    },
    userMessageId: 'user-1',
    assistantMessageId: 'turn-1',
    agentTurnId: 'agent-1',
    startedAt: Date.now(),
  })
}

describe('钉钉中断回合启动恢复', () => {
  it('复用原消息 id、卡片和工具幂等键重新跑同一轮', async () => {
    const db = seedDb()
    addTurn(db)
    const calls: Array<Record<string, unknown>> = []
    const result = await recoverInterruptedDingTalkTurns(depsOf(db), async (_deps, _payload, options) => {
      calls.push(options?.resume as Record<string, unknown>)
      finishChannelTurn(db, 'turn-1', 'completed')
      return { handled: true, text: null, sessionId: 's1', reason: 'ok' }
    })

    expect(result.resumed).toBe(1)
    expect(calls[0]).toMatchObject({
      turnId: 'turn-1',
      userMessageId: 'user-1',
      assistantMessageId: 'turn-1',
      agentTurnId: 'agent-1',
      priorTools: [],
    })
    expect(getChannelTurn(db, 'turn-1')?.status).toBe('completed')
  })

  it('恢复失败时标记 failed，不会无限重复重跑', async () => {
    const db = seedDb()
    addTurn(db)
    const result = await recoverInterruptedDingTalkTurns(depsOf(db), async () => {
      throw new Error('模型调用失败')
    })

    expect(result.failed).toBe(1)
    expect(getChannelTurn(db, 'turn-1')?.status).toBe('failed')
    expect(getChannelTurn(db, 'turn-1')?.error).toContain('模型调用失败')
  })

  it('升级前只留下 channel_events 的旧中断可以用邻近用户消息补登', () => {
    const db = seedDb()
    const now = Date.now()
    db.prepare(
      `INSERT INTO chat_messages (id, company_id, session_id, user_id, role, text, created_at)
       VALUES ('legacy-user-1', 'c1', 's1', 'u1', 'user', '你自己选择出题', ?)`,
    ).run(now)
    db.prepare(
      `INSERT INTO channel_events (id, company_id, provider, event_key, sender_id, received_at)
       VALUES ('evt-legacy-1', 'c1', 'dingtalk', 'legacy-msg-1', 'staff-1', ?)`,
    ).run(now - 300)
    db.prepare(
      `INSERT INTO channel_events (id, company_id, provider, event_key, sender_id, received_at)
       VALUES ('evt-card-1', 'c1', 'dingtalk', 'card:eab_a2ui_test:staff-1', 'staff-1', ?)`,
    ).run(now - 200)

    expect(adoptLegacyInterruptedTurns(db, 'c1')).toBe(1)
    const turns = listRecoverableChannelTurns(db, 'dingtalk', { sinceMs: 7 * 24 * 3600_000 })
    expect(turns).toHaveLength(1)
    expect(turns[0].eventKey).toBe('legacy-msg-1')
    expect(turns[0].userMessageId).toBe('legacy-user-1')
    expect((turns[0].payload as { text?: { content?: string } }).text?.content).toBe(
      '你自己选择出题',
    )
  })

  it('旧事件后面已经有 assistant 回复时不再补登，避免重复回答', () => {
    const db = seedDb()
    const now = Date.now()
    db.prepare(
      `INSERT INTO chat_messages (id, company_id, session_id, user_id, role, text, created_at)
       VALUES ('legacy-user-1', 'c1', 's1', 'u1', 'user', '你自己选择出题', ?)`,
    ).run(now)
    db.prepare(
      `INSERT INTO chat_messages (id, company_id, session_id, user_id, role, text, created_at)
       VALUES ('legacy-assistant-1', 'c1', 's1', 'u1', 'assistant', '已经回答过了', ?)`,
    ).run(now + 2000)
    db.prepare(
      `INSERT INTO channel_events (id, company_id, provider, event_key, sender_id, received_at)
       VALUES ('evt-legacy-1', 'c1', 'dingtalk', 'legacy-msg-1', 'staff-1', ?)`,
    ).run(now - 300)

    expect(adoptLegacyInterruptedTurns(db, 'c1')).toBe(0)
  })
})
