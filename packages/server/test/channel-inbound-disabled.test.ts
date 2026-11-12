import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { migrate, openDatabase, type Db } from '@eab/storage'
import type { ServerConfig } from '../src/config.js'
import type { ServerDeps } from '../src/deps.js'
import { handleDingTalkMessage } from '../src/dingtalk-bot.js'
import { findActivePerson, findPerson } from '../src/session.js'

const dirs: string[] = []
const handles: Db[] = []

afterEach(() => {
  for (const db of handles.splice(0)) db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeDeps() {
  const dir = mkdtempSync(join(tmpdir(), 'eab-inbound-disabled-'))
  dirs.push(dir)
  const db = openDatabase({ path: join(dir, 'eab.db') })
  handles.push(db)
  migrate(db)
  const now = Date.now()
  db.prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)').run(
    'c1',
    '测试公司',
    'test-company',
    'active',
    now,
  )
  db.prepare(
    'INSERT INTO departments (id, company_id, parent_id, name, path, depth, order_no, created_at) VALUES (?, ?, NULL, ?, ?, 0, 0, ?)',
  ).run('d_root', 'c1', '公司总部', '/c1/', now)
  db.prepare(
    `INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at)
     VALUES ('u_departed', 'c1', 'd_root', '/c1/', '离职员工', 'disabled', ?, ?)`,
  ).run(now, now)
  db.prepare(
    `INSERT INTO user_identities (id, user_id, provider, external_user_id, bound_at, bound_by, status)
     VALUES ('ui_departed', 'u_departed', 'dingtalk', 'dt_departed', ?, 'sync:dingtalk', 'active')`,
  ).run(now)
  db.prepare(
    `INSERT INTO channel_configs (id, company_id, provider, enabled, status, app_id, created_at, updated_at)
     VALUES ('cc_dingtalk', 'c1', 'dingtalk', 1, 'bound', 'ding_test_app', ?, ?)`,
  ).run(now, now)
  const config = { dbPath: join(dir, 'eab.db'), dataDir: dir, companyId: 'c1' } as ServerConfig
  const deps = { db, config, companyId: 'c1', migrations: [], consoleToken: '' } as ServerDeps
  return { db, deps }
}

describe('渠道入站按成员状态拦截', () => {
  it('同步停用的成员不能再通过钉钉机器人对话', async () => {
    const { db, deps } = makeDeps()
    expect(findPerson(db, 'u_departed')).not.toBeNull()
    expect(findActivePerson(db, 'u_departed')).toBeNull()

    const result = await handleDingTalkMessage(
      deps,
      { senderStaffId: 'dt_departed', msgtype: 'text', text: { content: '你好' }, msgId: 'msg-1' },
      { dedupe: false },
    )
    expect(result.handled).toBe(false)
    expect(result.reason).toBe('member-disabled')
    expect(result.text).toContain('已离职或已停用')
  })
})
