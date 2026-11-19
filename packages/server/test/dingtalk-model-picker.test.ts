import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { migrate, openDatabase, type Db } from '@eab/storage'
import type { ServerConfig } from '../src/config.js'
import type { ServerDeps } from '../src/deps.js'
import { handleDingTalkMessage } from '../src/dingtalk-bot.js'
import { dingTalkClarifyCardState } from '../src/dingtalk-card.js'
import { storeSecret } from '../src/secrets.js'

const dirs: string[] = []
const handles: Db[] = []

afterEach(() => {
  vi.unstubAllGlobals()
  for (const db of handles.splice(0)) db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    text: async () => JSON.stringify(body),
  } as Response
}

function seed(db: Db, dbPath: string) {
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
     VALUES ('u1', 'c1', 'd_root', '/c1/', '钉钉用户', 'active', ?, ?)`,
  ).run(now, now)
  db.prepare(
    `INSERT INTO user_identities (id, user_id, provider, external_user_id, bound_at, bound_by, status)
     VALUES ('ui1', 'u1', 'dingtalk', 'dt_u1', ?, 'seed', 'active')`,
  ).run(now)
  db.prepare(
    `INSERT INTO roles (id, company_id, code, name, data_scope, builtin, created_at)
     VALUES ('r_member', 'c1', 'member', '普通员工', 'self', 1, ?)`,
  ).run(now)
  db.prepare('INSERT INTO user_roles (user_id, role_id, granted_by, granted_at) VALUES (?, ?, ?, ?)').run(
    'u1',
    'r_member',
    'seed',
    now,
  )
  db.prepare('INSERT INTO role_scopes (role_id, scope) VALUES (?, ?)').run('r_member', 'chat:use')
  db.prepare('INSERT INTO role_scopes (role_id, scope) VALUES (?, ?)').run('r_member', 'model:use')
  db.prepare(
    `INSERT INTO channel_configs (id, company_id, provider, enabled, status, app_id, secret_ref, robot_code, created_at, updated_at)
     VALUES ('cc_dingtalk', 'c1', 'dingtalk', 1, 'bound', 'ding_test_app', 'EAB_DINGTALK_APP_SECRET_TEST', 'robot_test', ?, ?)`,
  ).run(now, now)
  storeSecret(dbPath, 'EAB_DINGTALK_APP_SECRET_TEST', 'ding_test_secret', 'EAB_DINGTALK_APP_SECRET')

  db.prepare(
    `INSERT INTO model_providers (id, company_id, kind, name, base_url, created_at, updated_at)
     VALUES ('p1', 'c1', 'openai_compatible', '本地模型', 'http://127.0.0.1:1/v1', ?, ?)`,
  ).run(now, now)
  const insertModel = db.prepare(
    `INSERT INTO models
       (id, company_id, provider_id, name, model_key, tags, capabilities, endpoint_kind, roles, priority, enabled, created_at, updated_at)
     VALUES (?, 'c1', 'p1', ?, ?, '["chat"]', '["chat"]', 'chat', '["member"]', ?, 1, ?, ?)`,
  )
  insertModel.run('Qwen/Qwen3-8B', 'Qwen/Qwen3-8B', 'qwen3-8b', 10, now, now)
  insertModel.run('Qwen/Qwen3.5-4B', 'Qwen/Qwen3.5-4B', 'qwen3.5-4b', 9, now, now)
  insertModel.run('plugin:our-free-model:kilo-auto%2Ffree', 'Kilo Auto Free', 'kilo-auto', 8, now, now)
}

describe('钉钉模型意图自动出引导卡', () => {
  it('“现在有哪些模型”直接创建带模型选项的 A2UI 卡片，不返回文字列表', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eab-dingtalk-model-picker-'))
    dirs.push(dir)
    const dbPath = join(dir, 'eab.db')
    const db = openDatabase({ path: dbPath })
    handles.push(db)
    migrate(db)
    seed(db, dbPath)

    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      calls.push({ url, body })
      if (url.includes('/oauth2/accessToken')) {
        return jsonResponse({ accessToken: 'token_test', expireIn: 7200 })
      }
      return jsonResponse({ success: true, result: { deliverResults: [{ success: true }] } })
    })

    const config = { dbPath, dataDir: dir, companyId: 'c1', devAuth: false } as ServerConfig
    const deps = { db, config, companyId: 'c1', migrations: [], consoleToken: '' } as ServerDeps
    const result = await handleDingTalkMessage(
      deps,
      {
        senderStaffId: 'dt_u1',
        msgtype: 'text',
        text: { content: '现在有那些模型，用引导模型弄出来我点击后切换' },
        msgId: 'msg-model-picker-1',
      },
      { dedupe: false },
    )

    expect(result).toMatchObject({ handled: true, text: null, reason: 'model-picker-card' })
    const create = calls.find((call) => call.url.includes('/card/ai/instances/createAndDeliver'))
    expect(create).toBeTruthy()
    const payload = JSON.stringify(create?.body ?? {})
    expect(payload).toContain('要切换到哪个模型')
    expect(payload).toContain('Qwen/Qwen3-8B')
    expect(payload).toContain('Kilo Auto Free')
    expect(payload).toContain('option-model-1')
    expect(payload).toContain('option-auto')

    const outTrackId = String(create?.body.outTrackId ?? '')
    expect(outTrackId).toMatch(/^eab_a2ui_/)
    expect(dingTalkClarifyCardState(outTrackId)?.question).toContain('要切换到哪个模型')

    // “列出模型”不应顺手改掉会话固定模型。
    const session = db
      .prepare('SELECT model_id FROM chat_sessions WHERE company_id = ? AND user_id = ? ORDER BY updated_at DESC LIMIT 1')
      .get('c1', 'u1') as { model_id: string | null } | undefined
    expect(session?.model_id ?? null).toBeNull()
  })
})
