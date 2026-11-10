import { describe, expect, it } from 'vitest'
import { openDatabase } from '@eab/storage'
import { historyOf } from '../src/routes/chat.js'

function memoryDb() {
  const db = openDatabase({ path: ':memory:' })
  db.exec(`
    CREATE TABLE chat_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      meta_json TEXT,
      created_at INTEGER NOT NULL
    )
  `)
  return db
}

describe('historyOf 按消息来源过滤', () => {
  it('钉钉侧历史只包含钉钉来源消息，不混入网页消息', () => {
    const db = memoryDb()
    const insert = db.prepare(
      `INSERT INTO chat_messages (id, session_id, role, text, meta_json, created_at)
       VALUES (?, 's1', 'user', ?, ?, ?)`,
    )
    insert.run('m1', '钉钉问题', JSON.stringify({ channel: 'dingtalk' }), 1)
    insert.run('m2', '网页追问', JSON.stringify({ channel: 'web' }), 2)
    insert.run('m3', '钉钉追问', JSON.stringify({ channel: 'dingtalk' }), 3)

    expect(historyOf(db, 's1', 10, 'dingtalk')).toEqual([
      { role: 'user', content: '钉钉问题' },
      { role: 'user', content: '钉钉追问' },
    ])
  })

  it('网页侧历史保留钉钉消息，便于在网页继续同一会话', () => {
    const db = memoryDb()
    const insert = db.prepare(
      `INSERT INTO chat_messages (id, session_id, role, text, meta_json, created_at)
       VALUES (?, 's1', 'user', ?, ?, ?)`,
    )
    insert.run('m1', '钉钉问题', JSON.stringify({ channel: 'dingtalk' }), 1)
    insert.run('m2', '网页追问', JSON.stringify({ channel: 'web' }), 2)

    expect(historyOf(db, 's1', 10)).toEqual([
      { role: 'user', content: '钉钉问题' },
      { role: 'user', content: '网页追问' },
    ])
  })
})
