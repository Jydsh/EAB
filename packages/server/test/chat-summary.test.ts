import { describe, expect, it } from 'vitest'
import { migrate, openDatabase } from '@eab/storage'
import {
  buildExtractiveSummary,
  refreshSessionSummary,
  sessionSummaryForPrompt,
} from '../src/chat-summary.js'

function db() {
  const database = openDatabase({ path: ':memory:' })
  migrate(database)
  database.prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)').run(
    'c1',
    '测试公司',
    'test',
    'active',
    1,
  )
  database.prepare('INSERT INTO departments (id, company_id, name, path, depth, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    'd1',
    'c1',
    '测试部门',
    '/d1',
    1,
    1,
  )
  database.prepare('INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    'u1',
    'c1',
    'd1',
    '/d1',
    '测试员工',
    'active',
    1,
    1,
  )
  const sessionInsert = database.prepare(
    `INSERT INTO chat_sessions (id, company_id, user_id, title, created_at, updated_at, last_message_at)
     VALUES ('s1', 'c1', 'u1', '长会话', 1, 1, 1)`,
  )
  sessionInsert.run()
  return database
}

function addMessage(
  database: ReturnType<typeof db>,
  id: string,
  role: 'user' | 'assistant',
  text: string,
  createdAt: number,
) {
  database
    .prepare(
      `INSERT INTO chat_messages (id, company_id, session_id, user_id, role, text, meta_json, created_at)
       VALUES (?, 'c1', 's1', 'u1', ?, ?, '{}', ?)`,
    )
    .run(id, role, text, createdAt)
}

function seedConversation(database: ReturnType<typeof db>, turns: number) {
  for (let index = 0; index < turns; index += 1) {
    addMessage(
      database,
      `u${index}`,
      'user',
      index === 0 ? '项目代号橙子-7319，负责人何工，交付日期 2026-12-01。' : `继续推进第 ${index} 步，补充细节。`,
      1_000 + index * 10,
    )
    addMessage(
      database,
      `a${index}`,
      'assistant',
      index === 0 ? '已记录：橙子-7319 / 何工 / 2026-12-01。' : `第 ${index} 步已完成，结论已记录。`,
      1_005 + index * 10,
    )
  }
}

describe('会话滚动摘要', () => {
  it('确定性摘要保留目标和结论，不逐句复述寒暄', () => {
    const text = buildExtractiveSummary('', [
      { id: 'm1', role: 'user', text: '帮我检查 notes 和 test 两个文件夹', createdAt: 1 },
      { id: 'm2', role: 'assistant', text: '一共 3 个文件：notes/a.md、test/b.md、test/c.md。', createdAt: 2 },
    ])
    expect(text).toContain('用户目标/问题')
    expect(text).toContain('助手结论/进展')
    expect(text).toContain('notes 和 test')
    expect(text).toContain('3 个文件')
  })

  it('老会话没有摘要时懒生成，注入只覆盖滑出最近窗口的内容', () => {
    const database = db()
    seedConversation(database, 10)
    const prompt = sessionSummaryForPrompt(database, 's1')
    expect(prompt).toContain('本会话早期内容摘要')
    expect(prompt).toContain('橙子-7319')
    expect(prompt).toContain('2026-12-01')
    const row = database
      .prepare('SELECT source_message_count, through_created_at FROM chat_session_summaries WHERE session_id = ?')
      .get('s1') as { source_message_count: number; through_created_at: number }
    expect(row.source_message_count).toBe(12)
    expect(row.through_created_at).toBeLessThan(1_000 + 9 * 10)
  })

  it('回答后刷新会写入摘要，且不把最近 8 条压进去', async () => {
    const database = db()
    seedConversation(database, 14)
    const changed = await refreshSessionSummary({
      db: database,
      dbPath: ':memory:',
      companyId: 'c1',
      userId: 'u1',
      sessionId: 's1',
      modelId: null,
    })
    expect(changed).toBe(true)
    const row = database
      .prepare(
        `SELECT summary_text, generated_by, source_message_count, through_message_id
           FROM chat_session_summaries WHERE session_id = ?`,
      )
      .get('s1') as {
      summary_text: string
      generated_by: string
      source_message_count: number
      through_message_id: string
    }
    expect(row.generated_by).toBe('extractive')
    expect(row.source_message_count).toBe(20)
    expect(row.summary_text).toContain('橙子-7319')
    expect(row.through_message_id).toBe('a9')
    expect(row.through_message_id).not.toBe('a13')
  })

  it('旧消息不足阈值时不写摘要', async () => {
    const database = db()
    seedConversation(database, 6)
    const changed = await refreshSessionSummary({
      db: database,
      dbPath: ':memory:',
      companyId: 'c1',
      userId: 'u1',
      sessionId: 's1',
      modelId: null,
    })
    expect(changed).toBe(false)
    const count = database
      .prepare('SELECT COUNT(*) AS count FROM chat_session_summaries WHERE session_id = ?')
      .get('s1') as { count: number }
    expect(count.count).toBe(0)
  })
})
