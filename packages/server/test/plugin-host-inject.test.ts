import { describe, expect, it } from 'vitest'
import { openDatabase } from '@eab/storage'
import { SC } from '@eab/domain'
import { makeContext, type HostInstance } from '../src/plugin-host.js'
import { clearPluginContributions, pluginPromptTexts } from '../src/plugin-tools.js'

function instance(): HostInstance {
  return {
    instanceKey: 'c1:probe-inject:company',
    id: 'probe-inject',
    companyId: 'c1',
    scope: { kind: 'company' },
    dataRoot: process.cwd(),
    settingsNamespace: 'probe-inject',
    record: { id: 'probe-inject', dir: process.cwd() } as HostInstance['record'],
    routes: new Map(),
    upgrades: new Map(),
    logs: [],
    disposers: [],
    root: null,
    fiber: null,
    startedAt: Date.now(),
    error: null,
    llmProviders: 0,
    llmModels: 0,
  }
}

describe('插件 host 内置服务注入', () => {
  it('ctx.inject([connection]) 立即回调并允许插件注册管理 RPC', async () => {
    const db = openDatabase({ path: ':memory:' })
    const host = instance()
    const ctx = makeContext(db, host, { dbPath: ':memory:', companyId: 'c1' })

    let called = false
    const inject = ctx.inject as (
      keys: string[],
      callback: (child: any) => unknown,
    ) => Promise<unknown>
    await inject(['connection'], (child: any) => {
      called = true
      child.connection.fetch.register({
        path: '/api/probe-inject',
        methods: ['POST'],
        fetch: async () =>
          Response.json({ ok: true }),
      })
    })

    expect(called).toBe(true)
    expect(host.routes.has('/api/probe-inject')).toBe(true)
    // 只把 connection 挂在 ctx 上不够：DSH 插件会直接调 connection.admit()
    // 做请求准入；缺这个方法会被插件当成 admission-error，整页 503。
    expect(typeof (ctx.connection as { admit?: unknown }).admit).toBe('function')
    expect((ctx.connection as { admit: () => unknown }).admit()).toBeUndefined()
    db.close()
  })

  it('ctx.systemPrompt.patch 赋值会进入插件系统提示，而不是静默丢失', async () => {
    const db = openDatabase({ path: ':memory:' })
    db.exec(`CREATE TABLE plugin_company_installs (
      company_id TEXT, plugin_id TEXT, installed_by TEXT, installed_at INTEGER, updated_at INTEGER, removed_at INTEGER
    );
    CREATE TABLE plugin_states (company_id TEXT, plugin_id TEXT, enabled INTEGER, updated_by TEXT, updated_at INTEGER);
    CREATE TABLE plugin_user_installs (company_id TEXT, user_id TEXT, plugin_id TEXT, enabled INTEGER, installed_at INTEGER, updated_at INTEGER, removed_at INTEGER);`)
    db.prepare(
      'INSERT INTO plugin_company_installs (company_id, plugin_id, installed_by, installed_at, updated_at, removed_at) VALUES (?, ?, ?, ?, ?, NULL)',
    ).run('c1', 'probe-inject', 'u1', 1, 1)
    const host = instance()
    const ctx = makeContext(db, host, { dbPath: ':memory:', companyId: 'c1' })

    const inject = ctx.inject as (
      keys: string[],
      callback: (child: any) => unknown,
    ) => Promise<unknown>
    await inject(['systemPrompt'], (child: any) => {
      child.systemPrompt.patch = (prev: string) => `${prev}PROBE_PROMPT`
    })
    await new Promise((resolve) => setTimeout(resolve, 50))

    const actor = {
      subject: { companyId: 'c1', userId: 'u1', scopes: new Set([SC.AGENT_TOOL_INVOKE]) },
    }
    expect(pluginPromptTexts(db, actor)).toContain('PROBE_PROMPT')
    clearPluginContributions('probe-inject')
    db.close()
  })
})
