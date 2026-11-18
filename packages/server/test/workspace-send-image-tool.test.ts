import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDatabase, migrate } from '@eab/storage'
import { SC } from '@eab/domain'
import type { ServerConfig } from '../src/config.js'
import type { ServerDeps } from '../src/deps.js'
import { executeTool } from '../src/routes/tools.js'

const dirs: string[] = []

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.EAB_TEST_DING_SECRET
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function testDeps() {
  const dir = mkdtempSync(join(tmpdir(), 'eab-send-image-'))
  dirs.push(dir)
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  db.exec('PRAGMA foreign_keys = OFF')
  db.prepare(
    `INSERT INTO channel_configs (id, company_id, provider, enabled, status, app_id, secret_ref, robot_code, created_at, updated_at)
     VALUES ('cc_image', 'c1', 'dingtalk', 1, 'connected', 'ding_image', 'EAB_TEST_DING_SECRET', 'robot_image', ?, ?)`,
  ).run(Date.now(), Date.now())
  db.prepare(
    `INSERT INTO channel_identities (id, company_id, provider, external_id, user_id, created_at)
     VALUES ('ci_image', 'c1', 'dingtalk', 'staff_image', 'u1', ?)`,
  ).run(Date.now())
  const config = { dbPath: join(dir, 'eab.db'), dataDir: dir } as ServerConfig
  return { dir, deps: { db, config, companyId: 'c1', migrations: [], consoleToken: '' } as ServerDeps }
}

function actor() {
  return {
    subject: {
      companyId: 'c1',
      userId: 'u1',
      status: 'active',
      deptId: 'd1',
      deptPath: '/d1',
      deptChain: [],
      roles: [],
      scopes: new Set([SC.WORKSPACE_READ, SC.KB_READ]),
    },
    person: {
      id: 'u1',
      name: '测试员工',
      title: null,
      deptId: 'd1',
      deptPath: '/d1',
      deptName: '测试部门',
      companyId: 'c1',
      companyName: '测试公司',
    },
  } as unknown as Parameters<typeof executeTool>[1]
}

function mockDingTalk() {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const text = String(url)
      calls.push({ url: text, init })
      if (text.includes('/v1.0/oauth2/accessToken')) {
        return new Response(JSON.stringify({ accessToken: 'token_image', expireIn: 7200 }), { status: 200 })
      }
      if (text.includes('/media/upload')) {
        return new Response(
          JSON.stringify({ errcode: 0, errmsg: 'ok', media_id: '@media_image', type: 'image' }),
          { status: 200 },
        )
      }
      if (text.includes('/oToMessages/batchSend')) {
        return new Response(JSON.stringify({ invalidStaffIdList: [], flowControlledStaffIdList: [] }), {
          status: 200,
        })
      }
      return new Response('not found', { status: 404 })
    }),
  )
  return calls
}

describe('workspace.send_dingtalk 图片发送', () => {
  it('工作区里未登记进 workspace_files 的图片也能发成钉钉原生图片消息', async () => {
    process.env.EAB_TEST_DING_SECRET = 'secret_image'
    const { dir, deps } = testDeps()
    const userDir = join(dir, 'workspaces', 'c1', 'user-u1')
    mkdirSync(join(userDir, 'charts'), { recursive: true })
    writeFileSync(join(userDir, 'charts', 'trend.png'), Buffer.from('png-image'))
    const calls = mockDingTalk()

    const result = (await executeTool(
      deps,
      actor(),
      'workspace.send_dingtalk',
      { path: 'charts/trend.png' },
    )) as Record<string, unknown>

    expect(result).toMatchObject({
      sent: true,
      delivery: 'image',
      fileName: 'trend.png',
      relPath: 'charts/trend.png',
      mime: 'image/png',
      mediaType: 'image',
      mediaId: '@media_image',
    })
    const upload = calls.find((call) => call.url.includes('/media/upload'))
    expect((upload?.init?.body as FormData).get('type')).toBe('image')
    const send = calls.find((call) => call.url.includes('/oToMessages/batchSend'))
    const body = JSON.parse(String(send?.init?.body)) as Record<string, unknown>
    expect(body.msgKey).toBe('sampleImageMsg')
    expect(JSON.parse(String(body.msgParam))).toEqual({ photoURL: '@media_image' })
  })

  it('拒绝用图片工具发送非图片文件', async () => {
    process.env.EAB_TEST_DING_SECRET = 'secret_image'
    const { dir, deps } = testDeps()
    const userDir = join(dir, 'workspaces', 'c1', 'user-u1')
    mkdirSync(join(userDir, 'docs'), { recursive: true })
    writeFileSync(join(userDir, 'docs', 'notes.txt'), 'not an image')

    await expect(
      executeTool(deps, actor(), 'workspace.send_dingtalk', { path: 'docs/notes.txt' }),
    ).rejects.toThrow(/只有图片可以作为图片消息发送/)
  })

  it('知识库图片地址能发成钉钉原生图片消息', async () => {
    process.env.EAB_TEST_DING_SECRET = 'secret_image'
    const { dir, deps } = testDeps()
    const assetDir = join(dir, 'kb', 'c1', 'kbd1', 'assets')
    mkdirSync(assetDir, { recursive: true })
    writeFileSync(join(assetDir, 'a1.png'), Buffer.from('kb-png'))
    deps.db.prepare(
      `INSERT INTO kb_collections (id, company_id, name, acl_mode, status, created_at, updated_at)
       VALUES ('kbc1', 'c1', '网络IP资料', 'all', 'active', 1, 1)`,
    ).run()
    deps.db.prepare(
      `INSERT INTO kb_docs (id, company_id, collection_id, title, status, chunk_count, created_at, updated_at)
       VALUES ('kbd1', 'c1', 'kbc1', '图片测试', 'indexed', 1, 1, 1)`,
    ).run()
    deps.db.prepare(
      `INSERT INTO kb_doc_assets
         (id, company_id, collection_id, doc_id, kind, source_name, relative_path, mime, size_bytes, ordinal, created_at, updated_at)
       VALUES ('kba1', 'c1', 'kbc1', 'kbd1', 'document_image', 'diagram.png', 'kb/c1/kbd1/assets/a1.png', 'image/png', 6, 0, 1, 1)`,
    ).run()
    const calls = mockDingTalk()

    const result = (await executeTool(
      deps,
      actor(),
      'workspace.send_dingtalk',
      { url: '/api/kb/assets/kbd1/kba1' },
    )) as Record<string, unknown>

    expect(result).toMatchObject({
      sent: true,
      delivery: 'image',
      source: 'kb-asset',
      docId: 'kbd1',
      assetId: 'kba1',
      fileName: 'diagram.png',
      mime: 'image/png',
      mediaType: 'image',
      mediaId: '@media_image',
    })
    const send = calls.find((call) => call.url.includes('/oToMessages/batchSend'))
    const body = JSON.parse(String(send?.init?.body)) as Record<string, unknown>
    expect(body.msgKey).toBe('sampleImageMsg')
  })

  it('拒绝把任意外部 URL 当作图片发送', async () => {
    process.env.EAB_TEST_DING_SECRET = 'secret_image'
    const { deps } = testDeps()

    await expect(
      executeTool(deps, actor(), 'workspace.send_dingtalk', { url: 'https://example.com/a.png' }),
    ).rejects.toThrow(/只支持发送 EAB 知识库图片地址/)
  })
})
