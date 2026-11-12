import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '@eab/storage'
import type { ServerDeps } from '../src/deps.js'
import { checkFeishuSetup } from '../src/feishu-bot.js'
import { storeSecret } from '../src/secrets.js'

const roots: string[] = []
const databases: Array<{ close: () => void }> = []

afterEach(() => {
  vi.unstubAllGlobals()
  for (const db of databases.splice(0)) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function depsWithFeishu(): { deps: ServerDeps; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'eab-feishu-check-'))
  roots.push(root)
  const dbPath = join(root, 'eab.db')
  const db = openDatabase({ path: dbPath })
  databases.push(db)
  db.exec(`
    CREATE TABLE companies (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
    CREATE TABLE channel_configs (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, provider TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'unconfigured', app_id TEXT, tenant_id TEXT, tenant_name TEXT,
      secret_ref TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `)
  db.prepare(`INSERT INTO companies (id, name, slug, created_at) VALUES ('c1','Hermes','c1',?)`).run(Date.now())
  const secretRef = 'EAB_FEISHU_APP_SECRET_TEST'
  storeSecret(dbPath, secretRef, 'secret', 'EAB_FEISHU_APP_SECRET')
  db.prepare(
    `INSERT INTO channel_configs
       (id, company_id, provider, enabled, status, app_id, tenant_id, tenant_name, secret_ref, created_at, updated_at)
     VALUES ('ch_feishu','c1','feishu',1,'bound','cli_aa8e2bfac5f8dbee','cli_aa8e2bfac5f8dbee','Hermes',?,?,?)`,
  ).run(secretRef, Date.now(), Date.now())
  const deps = {
    db,
    config: { dbPath },
    companyId: 'c1',
    migrations: [],
    consoleToken: '',
  } as unknown as ServerDeps
  return { deps, dbPath }
}

function mockFeishu(callbacks: string[], scopes: string[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const target = String(url)
      if (target.includes('tenant_access_token')) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: 't-test' }), { status: 200 })
      }
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            app: {
              app_name: 'Hermes',
              status: 1,
              online_version_id: 'oav_test',
              scopes: scopes.map((scope) => ({ scope })),
              callback_info: { callback_type: 'websocket', subscribed_callbacks: callbacks },
            },
          },
        }),
        { status: 200 },
      )
    }),
  )
}

describe('飞书接入自检', () => {
  it('长连接已连上但没订阅接收消息事件时，明确指出缺 im.message.receive_v1', async () => {
    const { deps } = depsWithFeishu()
    mockFeishu(['card.action.trigger'], ['im:message:send_as_bot', 'im:message.p2p_msg:readonly'])
    const result = await checkFeishuSetup(deps, true)
    expect(result.ok).toBe(false)
    expect(result.missingEvents).toEqual(['im.message.receive_v1'])
    expect(result.issues.join('\n')).toContain('im.message.receive_v1')
  })

  it('订阅和权限齐全时自检通过', async () => {
    const { deps } = depsWithFeishu()
    mockFeishu(
      ['im.message.receive_v1'],
      [
        'im:message:send_as_bot',
        'im:message.p2p_msg:readonly',
        'im:message.group_at_msg:readonly',
      ],
    )
    const result = await checkFeishuSetup(deps, true)
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.callbackType).toBe('websocket')
  })
})
