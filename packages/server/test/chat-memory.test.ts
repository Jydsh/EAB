import { describe, expect, it } from 'vitest'
import { migrate, openDatabase } from '@eab/storage'
import {
  extractMemoryTerms,
  recentMessageIds,
  searchChatMemory,
  shouldRecallPastConversations,
} from '../src/chat-memory.js'

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
  database.prepare('INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    'u2',
    'c1',
    'd1',
    '/d1',
    '其他员工',
    'active',
    1,
    1,
  )
  return database
}

function seedSession(
  database: ReturnType<typeof db>,
  id: string,
  userId = 'u1',
  title = '历史会话',
  deletedAt: number | null = null,
) {
  database
    .prepare(
      `INSERT INTO chat_sessions (id, company_id, user_id, title, created_at, updated_at, last_message_at, deleted_at)
       VALUES (?, 'c1', ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, userId, title, 1, 1, 1, deletedAt)
}

function seedMessage(
  database: ReturnType<typeof db>,
  id: string,
  sessionId: string,
  text: string,
  createdAt: number,
  userId = 'u1',
) {
  database
    .prepare(
      `INSERT INTO chat_messages (id, company_id, session_id, user_id, role, text, meta_json, created_at)
       VALUES (?, 'c1', ?, ?, 'user', ?, '{}', ?)`,
    )
    .run(id, sessionId, userId, text, createdAt)
}

describe('对话历史记忆检索', () => {
  it('从问题中提取实体和编号，不把问句尾巴当关键词', () => {
    expect(extractMemoryTerms('橙子-7319 的负责人是谁？')).toEqual(
      expect.arrayContaining(['橙子-7319', '负责人']),
    )
    expect(extractMemoryTerms('我们之前说过的交付日期是哪天？')).toEqual(
      expect.arrayContaining(['交付日期']),
    )
    const terms = extractMemoryTerms('记忆引用测试-1118 里，项目代号、负责人、交付日期分别是什么？只凭记忆回答，不要调用工具。')
    expect(terms).toEqual(expect.arrayContaining(['项目代号', '负责人', '交付日期']))
    expect(terms.join('')).not.toContain('只凭记忆')
    expect(terms.join('')).not.toContain('调用工具')
  })

  it('明确提到历史时才跨会话召回旧消息，并把相邻一条作为上下文', () => {
    const database = db()
    seedSession(database, 's1', 'u1', '项目 A 讨论')
    seedSession(database, 's2', 'u1', '当前会话')
    seedMessage(database, 'm1', 's1', '项目代号是橙子-7319，负责人和交付日期后面确认。', 1000)
    seedMessage(database, 'm2', 's1', '好的，负责人确认后告诉我。', 1001)
    seedMessage(database, 'm3', 's2', '今天先聊别的。', 2000)

    const hits = searchChatMemory({
      db: database,
      companyId: 'c1',
      userId: 'u1',
      sessionId: 's2',
      crossSession: true,
      query: '橙子-7319 的负责人是谁？',
    })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].sessionTitle).toBe('项目 A 讨论')
    expect(hits[0].context).toContain('橙子-7319')
    expect(hits[0].context).toContain('负责人确认后')
  })

  it('默认只查当前会话，普通问题不会把别的会话记忆带进来', () => {
    const database = db()
    seedSession(database, 's1', 'u1', '网络 IP 资料')
    seedSession(database, 's2', 'u1', '当前会话')
    seedMessage(database, 'm1', 's1', '核心交换机 SW-CORE-01 的巡检周期是每周一次。', 1000)
    seedMessage(database, 'm2', 's2', '今天聊巡检。', 2000)

    const hits = searchChatMemory({
      db: database,
      companyId: 'c1',
      userId: 'u1',
      sessionId: 's2',
      query: '核心交换机 SW-CORE-01 的巡检周期是多少？只回答周期。',
    })
    expect(hits).toEqual([])
  })

  it('当前会话更早的消息仍可作为本会话记忆召回', () => {
    const database = db()
    seedSession(database, 's1', 'u1', '当前会话')
    seedMessage(database, 'm1', 's1', '核心交换机 SW-CORE-01 的巡检周期是每周一次。', 1000)
    seedMessage(database, 'm2', 's1', '后面再确认别的设备。', 2000)

    const hits = searchChatMemory({
      db: database,
      companyId: 'c1',
      userId: 'u1',
      sessionId: 's1',
      query: 'SW-CORE-01 的巡检周期',
      excludeMessageIds: ['m2'],
    })
    expect(hits.map((hit) => hit.messageId)).toContain('m1')
    expect(hits.every((hit) => hit.sessionId === 's1')).toBe(true)
  })

  it('没有当前会话时默认不跨会话兜底', () => {
    const database = db()
    seedSession(database, 's1', 'u1', '旧会话')
    seedMessage(database, 'm1', 's1', '核心交换机 SW-CORE-01 的巡检周期是每周一次。', 1000)

    const hits = searchChatMemory({
      db: database,
      companyId: 'c1',
      userId: 'u1',
      query: 'SW-CORE-01 的巡检周期',
    })
    expect(hits).toEqual([])
  })

  it('只有明确指代过去对话才允许跨会话', () => {
    expect(shouldRecallPastConversations('上次说的巡检周期是多少？')).toBe(true)
    expect(shouldRecallPastConversations('之前说过的交付日期是哪天？')).toBe(true)
    expect(shouldRecallPastConversations('你还记得那个项目吗？')).toBe(true)
    expect(shouldRecallPastConversations('历史记录里有没有这条？')).toBe(true)
    expect(shouldRecallPastConversations('那个对话里是怎么处理的？')).toBe(true)
    expect(shouldRecallPastConversations('核心交换机 SW-CORE-01 的巡检周期是多少？只回答周期。')).toBe(false)
    expect(shouldRecallPastConversations('之前端口的配置是什么？')).toBe(false)
    expect(shouldRecallPastConversations('之前的流程是什么？')).toBe(false)
    expect(shouldRecallPastConversations('今天天气怎么样？')).toBe(false)
  })

  it('两字关键词回退 LIKE，不因 trigram 限制漏掉“何工”', () => {
    const database = db()
    seedSession(database, 's1', 'u1', '项目 A 讨论')
    seedMessage(database, 'm1', 's1', '项目负责人何工确认交付日期为 2026-12-01。', 1000)

    const hits = searchChatMemory({
      db: database,
      companyId: 'c1',
      userId: 'u1',
      crossSession: true,
      query: '何工是谁？',
    })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].excerpt).toContain('何工')
  })

  it('只返回当前用户、当前公司、未删除会话的消息', () => {
    const database = db()
    seedSession(database, 's1', 'u1', '我的旧会话')
    seedSession(database, 's2', 'u2', '同事的会话')
    seedSession(database, 's3', 'u1', '已删除会话', 999)
    seedMessage(database, 'm1', 's1', '项目代号橙子-7319 由何工负责。', 1000, 'u1')
    seedMessage(database, 'm2', 's2', '项目代号橙子-7319 由别人负责。', 1100, 'u2')
    seedMessage(database, 'm3', 's3', '项目代号橙子-7319 是废弃记录。', 1200, 'u1')

    const hits = searchChatMemory({
      db: database,
      companyId: 'c1',
      userId: 'u1',
      crossSession: true,
      query: '橙子-7319 的负责人',
    })
    expect(hits.map((hit) => hit.messageId)).toEqual(['m1'])
  })

  it('排除已经进入最近窗口的消息，避免重复注入', () => {
    const database = db()
    seedSession(database, 's1')
    seedMessage(database, 'm1', 's1', '项目代号橙子-7319 由何工负责。', 1000)
    expect(recentMessageIds(database, 's1')).toEqual(['m1'])

    const hits = searchChatMemory({
      db: database,
      companyId: 'c1',
      userId: 'u1',
      crossSession: true,
      query: '橙子-7319 的负责人',
      excludeMessageIds: ['m1'],
    })
    expect(hits).toEqual([])
  })

  it('消息更新或删除后，FTS 索引同步变化', () => {
    const database = db()
    seedSession(database, 's1')
    seedMessage(database, 'm1', 's1', '项目代号橙子-7319 由何工负责。', 1000)
    database.prepare('UPDATE chat_messages SET text = ? WHERE id = ?').run('这里不再包含旧项目信息。', 'm1')

    const updated = searchChatMemory({
      db: database,
      companyId: 'c1',
      userId: 'u1',
      crossSession: true,
      query: '橙子-7319 的负责人',
    })
    expect(updated).toEqual([])

    database.prepare('DELETE FROM chat_messages WHERE id = ?').run('m1')
    const deleted = searchChatMemory({
      db: database,
      companyId: 'c1',
      userId: 'u1',
      crossSession: true,
      query: '旧项目信息',
    })
    expect(deleted).toEqual([])
  })
})
