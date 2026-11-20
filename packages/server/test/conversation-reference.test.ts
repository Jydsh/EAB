import { describe, expect, it } from 'vitest'
import { migrate, openDatabase } from '@eab/storage'
import {
  prefetchConversationReferenceDetails,
  readChatConversationMessages,
  readChatConversationReference,
} from '../src/conversation-reference.js'

function setup() {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  db.prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)').run(
    'c1',
    '测试公司',
    'test',
    'active',
    1,
  )
  db.prepare('INSERT INTO departments (id, company_id, name, path, depth, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    'd1',
    'c1',
    '测试部门',
    '/d1',
    1,
    1,
  )
  db.prepare('INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    'u1',
    'c1',
    'd1',
    '/d1',
    '测试员工',
    'active',
    1,
    1,
  )
  db.prepare(
    `INSERT INTO chat_sessions (id, company_id, user_id, title, created_at, updated_at, last_message_at)
     VALUES ('s1', 'c1', 'u1', '贵阳北弱电组检查整治', 1, 1, 1)`,
  ).run()
  const actor = {
    subject: { companyId: 'c1' },
    person: { id: 'u1' },
  }
  const add = (id: string, role: 'user' | 'assistant', text: string, createdAt: number) => {
    db.prepare(
      `INSERT INTO chat_messages (id, company_id, session_id, user_id, role, text, meta_json, created_at)
       VALUES (?, 'c1', 's1', 'u1', ?, ?, '{}', ?)`,
    ).run(id, role, text, createdAt)
  }
  add('m1', 'user', '本周检查了哪些点位？结果要写进周报。', 1)
  for (let i = 1; i <= 20; i += 1) {
    add(`u${i}`, 'user', `第 ${i} 轮：继续核对检查整治记录。`, 1 + i * 10)
    add(`a${i}`, 'assistant', `第 ${i} 轮结论：已核对 ${i} 条，台账编号 ${1000 + i}。`, 1 + i * 10 + 5)
  }
  return { db, actor }
}

describe('对话引用摘要与按需读取', () => {
  it('默认只注入摘要，不再返回整段转录', () => {
    const { db, actor } = setup()
    const summary = readChatConversationReference(db, actor, 's1')
    expect(summary.title).toBe('贵阳北弱电组检查整治')
    expect(summary.messageCount).toBe(41)
    expect(summary.text).toContain('共 41 条用户/助手消息')
    expect(summary.text).toContain('最早的用户需求')
    expect(summary.text).toContain('conversation_read')
    expect(summary.text.length).toBeLessThan(2_200)
  })

  it('按关键词读取细节，而不是把全部消息塞回上下文', () => {
    const { db, actor } = setup()
    const detail = readChatConversationMessages(db, actor, 's1', { query: '台账编号 1007', limit: 4 })
    expect(detail.messageCount).toBeLessThanOrEqual(4)
    expect(detail.text).toContain('1007')
  })

  it('关键词能命中最近 50 条之外的更早消息', () => {
    const { db, actor } = setup()
    for (let i = 1; i <= 80; i += 1) {
      db.prepare(
        `INSERT INTO chat_messages (id, company_id, session_id, user_id, role, text, meta_json, created_at)
         VALUES (?, 'c1', 's1', 'u1', 'user', ?, '{}', ?)`,
      ).run(`extra-${i}`, `补充记录 ${i}`, 1_000 + i * 10)
    }
    const detail = readChatConversationMessages(db, actor, 's1', { query: '周报', limit: 2 })
    expect(detail.text).toContain('周报')
    expect(detail.text).not.toContain('补充记录')
  })

  it('细节问题会预读摘要之外的原文，避免模型拿相近字段硬答', () => {
    const { db, actor } = setup()
    const details = prefetchConversationReferenceDetails(
      db,
      actor,
      [{ conversationId: 's1', title: '贵阳北弱电组检查整治', messageCount: 41 }],
      '引用对话里周报的具体要求是什么？',
    )
    expect(details).toHaveLength(1)
    expect(details[0].text).toContain('周报')
    expect(details[0].text).not.toContain('第 20 轮结论')
  })

  it('可以按 offset 分页读取更早的消息，不与最近一页重叠', () => {
    const { db, actor } = setup()
    const newest = readChatConversationMessages(db, actor, 's1', { limit: 3 })
    expect(newest.messageCount).toBe(3)
    expect(newest.totalMessages).toBe(41)
    expect(newest.hasMore).toBe(true)
    expect(newest.nextOffset).toBe(3)
    const older = readChatConversationMessages(db, actor, 's1', { limit: 3, offset: 3 })
    expect(older.messageCount).toBe(3)
    expect(older.offset).toBe(3)
    expect(older.nextOffset).toBe(6)
    const overlap = older.text
      .split('\n\n')
      .filter((line) => line && newest.text.split('\n\n').includes(line))
    expect(overlap).toHaveLength(0)
  })

  it('泛问题不触发整段预读，只有问具体字段或具体值才预读', () => {
    const { db, actor } = setup()
    const references = [{ conversationId: 's1', title: '贵阳北弱电组检查整治', messageCount: 41 }]
    expect(prefetchConversationReferenceDetails(db, actor, references, '这个对话讲的是什么？')).toEqual([])
    expect(prefetchConversationReferenceDetails(db, actor, references, '这个对话有多少条消息？')).toEqual([])
    expect(prefetchConversationReferenceDetails(db, actor, references, '第 5 条消息的结论是什么？')).toHaveLength(1)
  })

  it('不能读取别人的对话', () => {
    const { db } = setup()
    expect(() =>
      readChatConversationReference(db, { subject: { companyId: 'c1' }, person: { id: 'u2' } }, 's1'),
    ).toThrow('只能引用自己的对话')
  })
})
