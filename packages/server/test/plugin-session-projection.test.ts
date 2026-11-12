import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import type { Db } from '@eab/storage'
import { chatSessionEvents, foldContextActivity, foldContextTimeline } from '../src/plugin-host.js'

const nodeRequire = createRequire(import.meta.url)
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite')

function makeDb(): Db {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE chat_sessions (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
    CREATE TABLE chat_messages (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      model_id TEXT,
      model_name TEXT,
      meta_json TEXT,
      created_at INTEGER NOT NULL
    );
  `)
  return db
}

describe('DSH session projection', () => {
  it('maps EAB chat messages to DSH events and folds contextTimeline', () => {
    const db = makeDb()
    db.prepare(
      `INSERT INTO chat_messages
       (id, company_id, session_id, user_id, role, text, model_id, model_name, meta_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'msg_u1',
      'c1',
      's1',
      'u1',
      'user',
      '帮我查一下今天的情况',
      'm1',
      'Qwen',
      '{"channel":"web"}',
      1000,
    )
    db.prepare(
      `INSERT INTO chat_messages
       (id, company_id, session_id, user_id, role, text, model_id, model_name, meta_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'msg_a1',
      'c1',
      's1',
      'u1',
      'assistant',
      '今天有 3 条记录。',
      'm1',
      'Qwen',
      JSON.stringify({
        tokens: { prompt: 120, completion: 30 },
        reasoning: '先查询再统计',
        toolCalls: [{
          id: 'call_1',
          name: 'query_records',
          args: { day: 'today' },
          status: 'done',
          summary: '{"total":3}',
          durationMs: 12,
        }],
      }),
      1001,
    )

    const events = chatSessionEvents(db as unknown as Db, 'c1', 'u1', 's1')
    expect(events.map((event) => event.type)).toEqual([
      'user/message',
      'assistant/message',
      'tool/call',
      'tool/result',
    ])
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4])

    const state = foldContextTimeline(events)
    expect(state.sums.user).toBeGreaterThan(0)
    expect(state.sums.assistant).toBeGreaterThan(0)
    expect(state.sums.tool).toBeGreaterThan(0)
    expect(state.requests).toHaveLength(1)
    expect(state.requests[0].prompt).toBe(120)
    expect(state.requests[0].output).toBe(30)
    expect(state.totals.turns).toBe(1)
    expect(state.totals.steps).toBe(1)
    expect(state.surface.map((item: { cat: string }) => item.cat)).toEqual(['user', 'assistant', 'tool'])
    expect(state.toolTally.query_records).toBe(1)
    expect(state.turns).toBe(1)
    expect(state.current.total).toBe(state.sums.user + state.sums.assistant + state.sums.tool)
    expect(state.timing.toolCalls).toBe(1)
    expect(state.timing.calls).toBe(1)
    expect(state.timing.tools.query_records).toEqual({ calls: 1, ms: 12 })
    expect(state.cost.eab.estimated.peak.uncached).toBeGreaterThan(0)
    expect(state.cost.eab.estimated.peak.output).toBeGreaterThan(0)

    const activity = foldContextActivity(events)
    const activityTokens = Object.values(activity.days).reduce(
      (sum: number, day: any) => sum + Number(day.tokens || 0),
      0,
    )
    expect(activityTokens).toBeGreaterThan(state.sums.assistant + state.sums.tool)
  })

  it('keeps the official empty contextTimeline shape when there are no events', () => {
    const state = foldContextTimeline([])
    expect(state.surface).toEqual([])
    expect(state.requests).toEqual([])
    expect(state.totals).toMatchObject({ turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 })
    expect(state.sums).toEqual({ user: 0, inject: 0, skill: 0, assistant: 0, tool: 0 })
  })
})
