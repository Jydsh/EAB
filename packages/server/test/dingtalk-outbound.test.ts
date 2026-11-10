import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDatabase, migrate } from '@eab/storage'
import type { ServerConfig } from '../src/config.js'
import type { ServerDeps } from '../src/deps.js'
import { sendDingTalkFileToUser } from '../src/dingtalk-outbound.js'

const dirs: string[] = []

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.EAB_TEST_DING_SECRET
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function testDeps(appId = 'ding_test_outbound') {
  const dir = mkdtempSync(join(tmpdir(), 'eab-ding-outbound-'))
  dirs.push(dir)
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  db.exec('PRAGMA foreign_keys = OFF')
  db.prepare(
    `INSERT INTO channel_configs (id, company_id, provider, enabled, status, app_id, secret_ref, robot_code, created_at, updated_at)
     VALUES (?, ?, 'dingtalk', 1, 'connected', ?, ?, ?, ?, ?)`,
  ).run('cc_test', 'c1', appId, 'EAB_TEST_DING_SECRET', 'robot_test', Date.now(), Date.now())
  db.prepare(
    `INSERT INTO channel_identities (id, company_id, provider, external_id, user_id, created_at)
     VALUES (?, ?, 'dingtalk', ?, ?, ?)`,
  ).run('ci_test', 'c1', 'staff_test', 'u_test', Date.now())
  const config = { dbPath: join(dir, 'eab.db'), dataDir: dir } as ServerConfig
  return { db, deps: { db, config, companyId: 'c1', migrations: [], consoleToken: '' } as ServerDeps }
}

function mockDingTalk() {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const text = String(url)
    calls.push({ url: text, init })
    if (text.includes('/v1.0/oauth2/accessToken')) {
      return new Response(JSON.stringify({ accessToken: 'token_test', expireIn: 7200 }), { status: 200 })
    }
    if (text.includes('/media/upload')) {
      return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok', media_id: '@media_test', type: 'file' }), {
        status: 200,
      })
    }
    if (text.includes('/oToMessages/batchSend')) {
      return new Response(JSON.stringify({ invalidStaffIdList: [], flowControlledStaffIdList: [] }), {
        status: 200,
      })
    }
    return new Response('not found', { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return calls
}

describe('钉钉出站文件', () => {
  it('先上传媒体，再用 sampleFile 发到当前员工的钉钉单聊', async () => {
    process.env.EAB_TEST_DING_SECRET = 'secret_test'
    const { deps } = testDeps()
    const calls = mockDingTalk()

    const sent = await sendDingTalkFileToUser(deps, {
      companyId: 'c1',
      userId: 'u_test',
      fileName: '报表.xlsx',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.from('xlsx-test'),
    })

    expect(sent).toMatchObject({
      mediaId: '@media_test',
      externalUserId: 'staff_test',
      fileName: '报表.xlsx',
      fileType: 'xlsx',
      mediaType: 'file',
    })
    expect(calls).toHaveLength(3)
    expect(calls[1]?.url).toContain('/media/upload')
    expect(calls[1]?.init?.method).toBe('POST')
    const sendBody = JSON.parse(String(calls[2]?.init?.body)) as Record<string, unknown>
    expect(sendBody).toMatchObject({
      robotCode: 'robot_test',
      userIds: ['staff_test'],
      msgKey: 'sampleFile',
    })
    expect(JSON.parse(String(sendBody.msgParam))).toEqual({
      mediaId: '@media_test',
      fileName: '报表.xlsx',
      fileType: 'xlsx',
    })
  })

  it('超过 20 MB 时直接拒绝，不发起任何钉钉请求', async () => {
    process.env.EAB_TEST_DING_SECRET = 'secret_test'
    const { deps } = testDeps('ding_test_oversize')
    const calls = mockDingTalk()
    await expect(
      sendDingTalkFileToUser(deps, {
        companyId: 'c1',
        userId: 'u_test',
        fileName: 'big.zip',
        mime: 'application/zip',
        buffer: Buffer.alloc(20 * 1024 * 1024 + 1),
      }),
    ).rejects.toThrow(/超过钉钉发送上限/)
    expect(calls).toHaveLength(0)
  })
})
