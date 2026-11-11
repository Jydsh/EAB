import { describe, expect, it } from 'vitest'
import { openDatabase } from '@eab/storage'
import { makeContext, type HostInstance } from '../src/plugin-host.js'

function instance(): HostInstance {
  return {
    id: 'probe-inject',
    companyId: 'c1',
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
})
