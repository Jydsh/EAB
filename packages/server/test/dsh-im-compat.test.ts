import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '@eab/storage'
import { botIdFor, prepareDshImCompat, syncDshImSession } from '../src/dsh-im-compat.js'

const roots: string[] = []
const databases: Array<{ close: () => void }> = []
const originalHome = process.env.EAB_DSH_REAL_HOME
const originalDshHome = process.env.DSH_HOME
const originalProfile = process.env.DSH_PROFILE

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (originalHome === undefined) delete process.env.EAB_DSH_REAL_HOME
  else process.env.EAB_DSH_REAL_HOME = originalHome
  if (originalDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalDshHome
  if (originalProfile === undefined) delete process.env.DSH_PROFILE
  else process.env.DSH_PROFILE = originalProfile
})

function memoryDb() {
  const db = openDatabase({ path: ':memory:' })
  databases.push(db)
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, company_id TEXT, name TEXT, deleted_at INTEGER);
    CREATE TABLE channel_configs (
      company_id TEXT, provider TEXT, app_id TEXT, secret_ref TEXT, robot_code TEXT
    );
    CREATE TABLE channel_identities (
      company_id TEXT, provider TEXT, external_id TEXT, user_id TEXT, revoked_at INTEGER
    );
    CREATE TABLE chat_sessions (
      id TEXT PRIMARY KEY, company_id TEXT, source TEXT, external_id TEXT,
      title TEXT, updated_at INTEGER, last_message_at INTEGER, deleted_at INTEGER
    );
  `)
  return db
}

describe('EAB dsh-im 兼容落盘协议', () => {
  it('把机器人、成员、会话写成 dsh-ding-card 能直接读取的文件', () => {
    const root = mkdtempSync(join(tmpdir(), 'eab-dshim-'))
    roots.push(root)
    process.env.EAB_DSH_REAL_HOME = join(root, 'no-real-dsh')
    const db = memoryDb()
    db.prepare(`INSERT INTO users (id, company_id, name, deleted_at) VALUES ('u1','c1','李鹏',NULL)`).run()
    db.prepare(
      `INSERT INTO channel_configs (company_id, provider, app_id, secret_ref, robot_code)
       VALUES ('c1','dingtalk','ding1qokwhr1smspersq','EAB_DINGTALK_APP_SECRET_X','ding1qokwhr1smspersq')`,
    ).run()
    db.prepare(
      `INSERT INTO channel_identities (company_id, provider, external_id, user_id, revoked_at)
       VALUES ('c1','dingtalk','021724185801860353','u1',NULL)`,
    ).run()
    db.prepare(
      `INSERT INTO chat_sessions (id, company_id, source, external_id, title, updated_at, last_message_at, deleted_at)
       VALUES ('session-1','c1','dingtalk','021724185801860353','李鹏',1700000000000,NULL,NULL)`,
    ).run()

    prepareDshImCompat(db, { dbPath: join(root, 'eab.db'), companyId: 'c1' })

    const botConfig = JSON.parse(readFileSync(join(root, 'dsh-home/integrations/dsh-dingtalk/config.json'), 'utf8'))
    expect(botConfig.bots).toHaveLength(1)
    expect(botConfig.bots[0]).toMatchObject({
      clientId: 'ding1qokwhr1smspersq',
      secretRef: 'EAB_DINGTALK_APP_SECRET_X',
      approvedSenders: [{ staffId: '021724185801860353', displayName: '李鹏' }],
    })

    const state = JSON.parse(
      readFileSync(join(root, `dsh-home/integrations/dsh-dingtalk/bots/${botIdFor('ding1qokwhr1smspersq')}/state.json`), 'utf8'),
    )
    expect(state.sessions).toEqual({ 'p2p:021724185801860353': 'session-1' })
    expect(state.recentOutboundMessages[0].conversationKey).toBe('p2p:021724185801860353')

    const profile = JSON.parse(readFileSync(join(root, 'dsh-home/profiles/web/package.json'), 'utf8'))
    expect(profile.dependencies['@xmanrui/dsh-im']).toBe('^5.10.0')
    const installed = JSON.parse(
      readFileSync(join(root, 'dsh-home/profiles/web/node_modules/@xmanrui/dsh-im/package.json'), 'utf8'),
    )
    expect(installed.version).toBe('5.10.0-eab.1')
    expect(process.env.DSH_HOME).toBe(join(root, 'dsh-home'))
    expect(process.env.DSH_PROFILE).toBe('web')

    const names = JSON.parse(
      readFileSync(join(root, 'dsh-home/integrations/dsh-ding-card/profiles/web/user_names.json'), 'utf8'),
    )
    expect(names).toEqual({ '021724185801860353': '李鹏' })

    db.prepare(
      `INSERT INTO chat_sessions (id, company_id, source, external_id, title, updated_at, last_message_at, deleted_at)
       VALUES ('session-2','c1','dingtalk','01074756045639219574','魏竣豪',1700000001000,NULL,NULL)`,
    ).run()
    syncDshImSession(db, '01074756045639219574', 'session-2')
    const updated = JSON.parse(
      readFileSync(join(root, `dsh-home/integrations/dsh-dingtalk/bots/${botIdFor('ding1qokwhr1smspersq')}/state.json`), 'utf8'),
    )
    expect(updated.sessions['p2p:01074756045639219574']).toBe('session-2')
    expect(updated.sessions['p2p:021724185801860353']).toBe('session-1')
  })
})
