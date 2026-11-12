import { beforeEach, describe, expect, it } from 'vitest'
import { migrate, openDatabase, type Db } from '@eab/storage'
import { executeChannelUnbind, previewChannelUnbind } from '../src/channel-unbind.js'

const NOW = 1_800_000_000_000
const COMPANY = 'c1'
const ROOT = 'd_root'

let db: Db

function insertDept(id: string, parentId: string | null, name: string, path: string, depth: number, channel: string | null, channelDeptId: string | null) {
  db.prepare(
    `INSERT INTO departments (id, company_id, parent_id, name, path, depth, channel, channel_dept_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, COMPANY, parentId, name, path, depth, channel, channelDeptId, NOW)
}

function insertUser(id: string, deptId: string, deptPath: string, name: string) {
  db.prepare(
    `INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).run(id, COMPANY, deptId, deptPath, name, NOW, NOW)
}

function insertIdentity(id: string, userId: string, provider: string, externalId: string, status = 'active') {
  db.prepare(
    `INSERT INTO user_identities (id, user_id, provider, external_user_id, bound_at, bound_by, status)
     VALUES (?, ?, ?, ?, ?, 'seed', ?)`,
  ).run(id, userId, provider, externalId, NOW, status)
}

function insertChannelIdentity(id: string, provider: string, externalId: string, userId: string) {
  db.prepare(
    `INSERT INTO channel_identities (id, company_id, provider, external_id, user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, COMPANY, provider, externalId, userId, NOW)
}

function seed() {
  db.prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)').run(
    COMPANY,
    '居易智能',
    'juyi',
    'active',
    NOW,
  )
  insertDept(ROOT, null, '居易智能', '/c1/', 1, null, null)

  insertDept('d_feishu_0', ROOT, '飞书 · 企业', '/c1/d_feishu_0/', 2, 'feishu', 'feishu-root')
  insertDept('d_feishu_sub', 'd_feishu_0', '飞书研发组', '/c1/d_feishu_0/d_feishu_sub/', 3, null, null)
  insertDept('d_ding', ROOT, '钉钉 · 企业', '/c1/d_ding/', 2, 'dingtalk', 'ding-root')

  insertUser('u_fs1', 'd_feishu_0', '/c1/d_feishu_0/', '飞书甲')
  insertUser('u_fs2', 'd_feishu_sub', '/c1/d_feishu_0/d_feishu_sub/', '飞书乙')
  insertUser('u_eab', 'd_feishu_sub', '/c1/d_feishu_0/d_feishu_sub/', 'EAB 自有成员')
  insertUser('u_ding', 'd_ding', '/c1/d_ding/', '钉钉甲')

  insertIdentity('ui_fs1', 'u_fs1', 'feishu', 'ou_fs1')
  insertIdentity('ui_fs2', 'u_fs2', 'feishu', 'ou_fs2')
  insertIdentity('ui_ding', 'u_ding', 'dingtalk', 'dt_ding')
  insertChannelIdentity('ci_fs1', 'feishu', 'ou_fs1', 'u_fs1')
  insertChannelIdentity('ci_fs2', 'feishu', 'ou_fs2', 'u_fs2')
  insertChannelIdentity('ci_ding', 'dingtalk', 'dt_ding', 'u_ding')

  db.prepare(
    `INSERT INTO roles (id, company_id, code, name, data_scope, builtin, created_at)
     VALUES ('r_owner', ?, 'owner', '企业负责人', 'company', 1, ?)`,
  ).run(COMPANY, NOW)
  db.prepare('INSERT INTO user_roles (user_id, role_id, granted_by, granted_at) VALUES (?, ?, ?, ?)').run(
    'u_fs1',
    'r_owner',
    'seed',
    NOW,
  )
  db.prepare('INSERT INTO user_roles (user_id, role_id, granted_by, granted_at) VALUES (?, ?, ?, ?)').run(
    'u_eab',
    'r_owner',
    'seed',
    NOW,
  )
  db.prepare(
    `INSERT INTO authz_overrides (id, company_id, user_id, effect, scope, reason, created_by, created_at)
     VALUES ('ao_fs1', ?, 'u_fs1', 'allow', 'org', '测试', 'seed', ?)`,
  ).run(COMPANY, NOW)
  db.prepare(
    `INSERT INTO sessions (id, user_id, refresh_hash, created_at, last_seen_at)
     VALUES ('s_fs1', 'u_fs1', 'hash', ?, ?)`,
  ).run(NOW, NOW)
  db.prepare(
    `INSERT INTO workspace_files (id, company_id, scope_type, scope_id, owner_user_id, rel_path, name, created_at, updated_at)
     VALUES ('wf_fs1', ?, 'user', 'u_fs1', 'u_fs1', 'notes.md', 'notes.md', ?, ?)`,
  ).run(COMPANY, NOW, NOW)
  db.prepare(
    `INSERT INTO chat_sessions (id, company_id, user_id, title, created_at, updated_at)
     VALUES ('cs_fs1', ?, 'u_fs1', '历史会话', ?, ?)`,
  ).run(COMPANY, NOW, NOW)
  db.prepare(
    `INSERT INTO channel_configs (id, company_id, provider, enabled, status, sync_mode, tenant_id, tenant_name, created_at, updated_at)
     VALUES ('cc_feishu', ?, 'feishu', 1, 'bound', 'org', 'tenant_fs', '飞书企业', ?, ?),
            ('cc_ding', ?, 'dingtalk', 1, 'bound', 'org', 'tenant_dt', '钉钉企业', ?, ?)`,
  ).run(COMPANY, NOW, NOW, COMPANY, NOW, NOW)
}

beforeEach(() => {
  db = openDatabase({ path: ':memory:' })
  migrate(db)
  seed()
})

describe('渠道解绑清理', () => {
  it('飞书预览只统计飞书带来的部门、成员和身份，EAB 自有成员算保护', () => {
    const preview = previewChannelUnbind(db, COMPANY, 'feishu')

    expect(preview.departments).toBe(2)
    expect(preview.users).toBe(2)
    expect(preview.roles).toBe(1)
    expect(preview.overrides).toBe(1)
    expect(preview.sessions).toBe(1)
    expect(preview.workspaces).toBe(1)
    expect(preview.identities).toBe(4)
    expect(preview.protectedUsers).toBe(1)
    expect(preview.crossChannelUsers).toBe(0)
    expect(preview.chatSessions).toBe(1)
  })

  it('飞书解绑：删部门/成员/角色，保护成员回根部门，保留会话和聊天历史', () => {
    const result = executeChannelUnbind(db, { companyId: COMPANY, provider: 'feishu', actorUserId: 'admin', now: NOW })

    expect(result.removed).toMatchObject({ departments: 2, users: 2, roles: 1, overrides: 1, identities: 4 })
    expect(result.preserved).toEqual({ protectedUsers: 1, chatSessions: 1 })

    const dept = db
      .prepare("SELECT deleted_at FROM departments WHERE id = 'd_feishu_sub'")
      .get() as { deleted_at: number | null }
    expect(dept.deleted_at).toBe(NOW)
    expect((db.prepare("SELECT deleted_at FROM departments WHERE id = 'd_ding'").get() as { deleted_at: number | null }).deleted_at).toBeNull()
    expect((db.prepare("SELECT manager_user_id FROM departments WHERE id = 'd_feishu_0'").get() as { manager_user_id: string | null }).manager_user_id).toBeNull()

    const fs = db.prepare("SELECT deleted_at, status FROM users WHERE id = 'u_fs1'").get() as {
      deleted_at: number | null
      status: string
    }
    expect(fs.deleted_at).toBe(NOW)
    expect(fs.status).toBe('disabled')
    const eab = db.prepare("SELECT dept_id, dept_path, status, deleted_at FROM users WHERE id = 'u_eab'").get() as {
      dept_id: string
      dept_path: string
      status: string
      deleted_at: number | null
    }
    expect(eab).toMatchObject({ dept_id: ROOT, dept_path: '/c1/', status: 'active', deleted_at: null })
    expect((db.prepare("SELECT status FROM users WHERE id = 'u_ding'").get() as { status: string }).status).toBe('active')

    expect((db.prepare("SELECT COUNT(*) AS n FROM user_roles WHERE user_id = 'u_fs1'").get() as { n: number }).n).toBe(0)
    expect((db.prepare("SELECT COUNT(*) AS n FROM user_roles WHERE user_id = 'u_eab'").get() as { n: number }).n).toBe(1)
    expect((db.prepare("SELECT COUNT(*) AS n FROM authz_overrides WHERE user_id = 'u_fs1'").get() as { n: number }).n).toBe(0)

    const session = db.prepare("SELECT revoked_at FROM sessions WHERE id = 's_fs1'").get() as { revoked_at: number | null }
    expect(session.revoked_at).toBe(NOW)
    const workspace = db.prepare("SELECT archived_at, deleted_at FROM workspace_files WHERE id = 'wf_fs1'").get() as {
      archived_at: number | null
      deleted_at: number | null
    }
    expect(workspace).toMatchObject({ archived_at: NOW, deleted_at: null })
    const chat = db.prepare("SELECT deleted_at FROM chat_sessions WHERE id = 'cs_fs1'").get() as { deleted_at: number | null }
    expect(chat.deleted_at).toBeNull()

    const identities = db
      .prepare("SELECT provider, status FROM user_identities WHERE user_id IN ('u_fs1', 'u_ding') ORDER BY provider")
      .all() as unknown as Array<{ provider: string; status: string }>
    expect(identities).toEqual([
      { provider: 'dingtalk', status: 'active' },
      { provider: 'feishu', status: 'revoked' },
    ])
    const channelIdentities = db
      .prepare("SELECT provider, revoked_at FROM channel_identities ORDER BY provider")
      .all() as unknown as Array<{ provider: string; revoked_at: number | null }>
    expect(channelIdentities).toEqual([
      { provider: 'dingtalk', revoked_at: null },
      { provider: 'feishu', revoked_at: NOW },
      { provider: 'feishu', revoked_at: NOW },
    ])

    const config = db
      .prepare("SELECT tenant_id, status, enabled, sync_mode, last_sync_run_id FROM channel_configs WHERE provider = 'feishu'")
      .get() as { tenant_id: string | null; status: string; enabled: number; sync_mode: string; last_sync_run_id: string | null }
    expect(config).toMatchObject({ tenant_id: null, status: 'unbound', enabled: 0, sync_mode: 'off', last_sync_run_id: null })
    expect((db.prepare("SELECT status FROM channel_configs WHERE provider = 'dingtalk'").get() as { status: string }).status).toBe('bound')

    const audit = db.prepare("SELECT action, detail_json FROM audit_logs WHERE action = 'channel.unbind'").get() as {
      action: string
      detail_json: string
    }
    expect(audit.action).toBe('channel.unbind')
    expect(JSON.parse(audit.detail_json)).toMatchObject({
      provider: 'feishu',
      protectedUsers: 1,
      removed: { departments: 2, users: 2, roles: 1 },
    })
  })

  it('钉钉解绑全量清理钉钉组织，不影响飞书组织和飞书配置', () => {
    const result = executeChannelUnbind(db, { companyId: COMPANY, provider: 'dingtalk', actorUserId: 'admin', now: NOW })

    expect(result.removed.departments).toBe(1)
    expect(result.removed.users).toBe(1)
    expect((db.prepare("SELECT deleted_at FROM departments WHERE id = 'd_ding'").get() as { deleted_at: number | null }).deleted_at).toBe(NOW)
    expect((db.prepare("SELECT deleted_at FROM departments WHERE id = 'd_feishu_0'").get() as { deleted_at: number | null }).deleted_at).toBeNull()
    expect((db.prepare("SELECT deleted_at FROM users WHERE id = 'u_ding'").get() as { deleted_at: number | null }).deleted_at).toBe(NOW)
    expect((db.prepare("SELECT deleted_at FROM users WHERE id = 'u_fs1'").get() as { deleted_at: number | null }).deleted_at).toBeNull()
    expect((db.prepare("SELECT status FROM channel_configs WHERE provider = 'feishu'").get() as { status: string }).status).toBe('bound')
    expect((db.prepare("SELECT status FROM channel_configs WHERE provider = 'dingtalk'").get() as { status: string }).status).toBe('unbound')
  })
})
