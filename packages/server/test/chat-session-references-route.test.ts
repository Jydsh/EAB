import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { migrate, openDatabase, type Db } from '@eab/storage'
import type { ServerConfig } from '../src/config.js'
import type { ServerDeps } from '../src/deps.js'
import { buildApp } from '../src/app.js'
import { normalizeSessionReferences } from '../src/routes/chat.js'
import type { RequestActor } from '../src/session.js'

const dirs: string[] = []
const handles: Db[] = []
const apps: ReturnType<typeof buildApp>[] = []
const previousHomes: Array<string | undefined> = []

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
  for (const db of handles.splice(0)) db.close()
  for (const home of previousHomes.splice(0)) {
    if (home === undefined) delete process.env.EAB_HOME
    else process.env.EAB_HOME = home
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeApp() {
  const dir = mkdtempSync(join(tmpdir(), 'eab-chat-refs-route-'))
  dirs.push(dir)
  previousHomes.push(process.env.EAB_HOME)
  process.env.EAB_HOME = dir
  const db = openDatabase({ path: ':memory:' })
  handles.push(db)
  migrate(db)
  const now = Date.now()
  db.prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('c1', '测试公司', 'chat-refs-route', 'active', now)
  db.prepare('INSERT INTO departments (id, company_id, name, path, depth, order_no, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('d1', 'c1', '测试部门', '/c1/d1/', 1, 0, now)
  db.prepare('INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('u1', 'c1', 'd1', '/c1/d1/', '测试员工', 'active', now, now)

  const config = {
    host: '127.0.0.1',
    port: 0,
    adminPort: 0,
    dbPath: ':memory:',
    companyId: 'c1',
    devAuth: true,
    consoleToken: '',
    adminUser: 'admin',
    adminPassword: 'test-admin-password',
    logLevel: 'silent',
    onlyOfficeUrl: '',
    onlyOfficeJwtSecret: '',
    onlyOfficeInternalUrl: '',
    dataDir: dir,
    tmpDir: join(dir, 'tmp'),
    agentWorkerIdleMs: 60_000,
  } as ServerConfig
  const deps = { db, config, companyId: 'c1', migrations: [], consoleToken: '' } as ServerDeps
  const app = buildApp(deps, 'chat')
  apps.push(app)
  return { app, db }
}

async function createSession(app: ReturnType<typeof buildApp>, title: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/chat/sessions?as=u1',
    payload: { title },
  })
  expect(response.statusCode).toBe(200)
  return (response.json() as { data: { session: { id: string } } }).data.session.id
}

function insertOwnFile(
  db: Db,
  id: string,
  name: string,
  relPath: string,
  mime = 'text/plain',
) {
  const now = Date.now()
  db.prepare(
    `INSERT INTO workspace_files
       (id, company_id, scope_type, scope_id, owner_user_id, rel_path, name, size, mime, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, 'c1', 'user', 'u1', 'u1', relPath, name, 36, mime, now, now)
}

describe('chat session references', () => {
  it('把文件夹和对话常驻引用按会话保存，并在打开会话时返回', async () => {
    const { app, db } = makeApp()
    await app.ready()
    const s1 = await createSession(app, '引用测试一')
    const s2 = await createSession(app, '被引用对话')
    const now = Date.now()
    db.prepare('INSERT INTO chat_messages (id, session_id, company_id, user_id, role, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('m1', s2, 'c1', 'u1', 'user', '之前排查过端口', now)
    db.prepare('INSERT INTO chat_messages (id, session_id, company_id, user_id, role, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('m2', s2, 'c1', 'u1', 'assistant', '结论是 Gi0/1', now + 1)

    const put = await app.inject({
      method: 'PUT',
      url: `/api/chat/sessions/${s1}/references?as=u1`,
      payload: {
        references: [
          {
            name: 'workspace',
            workspaceKind: 'folder',
            workspaceFolderPath: 'workspace',
            workspaceFileCount: 2,
            workspaceFolderCount: 0,
          },
          {
            conversationId: s2,
            conversationTitle: '旧标题',
          },
        ],
      },
    })
    expect(put.statusCode).toBe(200)
    const putBody = put.json() as {
      data: { references: Array<{ name: string; workspaceFolderPath?: string; conversationId?: string; persistent: boolean }> }
    }
    expect(putBody.data.references).toHaveLength(2)
    expect(putBody.data.references[0]).toMatchObject({
      name: 'workspace',
      workspaceFolderPath: 'workspace',
      persistent: true,
    })
    expect(putBody.data.references[1]).toMatchObject({
      name: '被引用对话',
      conversationId: s2,
      persistent: true,
    })

    const open = await app.inject({ method: 'GET', url: `/api/chat/sessions/${s1}/messages?as=u1` })
    expect(open.statusCode).toBe(200)
    const openBody = open.json() as {
      data: { session: { references: Array<{ name: string; persistent: boolean }> } }
    }
    expect(openBody.data.session.references).toHaveLength(2)
    expect(openBody.data.session.references[0]).toMatchObject({ name: 'workspace', persistent: true })

    const other = await app.inject({ method: 'GET', url: `/api/chat/sessions/${s2}/messages?as=u1` })
    const otherBody = other.json() as { data: { session: { references: unknown[] } } }
    expect(otherBody.data.session.references).toEqual([])

    const cleared = await app.inject({
      method: 'PUT',
      url: `/api/chat/sessions/${s1}/references?as=u1`,
      payload: { references: [] },
    })
    expect(cleared.statusCode).toBe(200)
    const row = db.prepare('SELECT references_json FROM chat_sessions WHERE id = ?').get(s1) as { references_json: string }
    expect(JSON.parse(row.references_json)).toEqual([])
  })

  it('新建会话时可以带常驻引用，并限制最多 4 个', async () => {
    const { app } = makeApp()
    await app.ready()
    const create = await app.inject({
      method: 'POST',
      url: '/api/chat/sessions?as=u1',
      payload: {
        title: '带引用新会话',
        references: [{ name: 'workspace', workspaceKind: 'folder', workspaceFolderPath: 'workspace' }],
      },
    })
    expect(create.statusCode).toBe(200)
    const session = (create.json() as {
      data: { session: { id: string; references: Array<{ name: string; persistent: boolean }> } }
    }).data.session
    expect(session.references).toHaveLength(1)
    expect(session.references[0]).toMatchObject({ name: 'workspace', persistent: true })

    const tooMany = await app.inject({
      method: 'PUT',
      url: `/api/chat/sessions/${session.id}/references?as=u1`,
      payload: {
        references: [1, 2, 3, 4, 5].map((index) => ({
          name: `folder${index}`,
          workspaceKind: 'folder',
          workspaceFolderPath: `folder${index}`,
        })),
      },
    })
    expect(tooMany.statusCode).toBe(400)

    const localFile = await app.inject({
      method: 'PUT',
      url: `/api/chat/sessions/${session.id}/references?as=u1`,
      payload: { references: [{ name: '本地.txt', size: 10, type: 'text/plain', text: '一次性正文' }] },
    })
    expect(localFile.statusCode).toBe(400)
  })

  it('发送前解析常驻引用时跳过已删除对象，不让整轮失败', () => {
    const { db, app } = makeApp()
    void app
    const deps = { db, config: { companyId: 'c1' }, companyId: 'c1' } as unknown as ServerDeps
    const actor = {
      subject: { companyId: 'c1' },
      person: { id: 'u1', companyId: 'c1' },
    } as unknown as RequestActor
    const refs = [
      { conversationId: 'chat_not_exists' },
      { workspaceFileId: 'wf_not_exists' },
    ]

    expect(() => normalizeSessionReferences(deps, actor, refs, 'cloud', null)).toThrow()
    expect(normalizeSessionReferences(deps, actor, refs, 'cloud', null, true)).toEqual([])
  })

  it('把误存成文件夹的文件路径引用纠正为文件引用，并写回会话', async () => {
    const { app, db } = makeApp()
    await app.ready()
    const sessionId = await createSession(app, '文件引用修复')
    const fileName = '引用检查-20261121-1608.txt'
    insertOwnFile(db, 'wf_ref_check', fileName, fileName)

    db.prepare('UPDATE chat_sessions SET references_json = ? WHERE id = ?').run(
      JSON.stringify([
        {
          name: fileName,
          size: 0,
          type: 'inode/directory',
          workspaceKind: 'folder',
          workspaceFolderPath: fileName,
          workspaceRelPath: fileName,
          workspaceFileCount: 0,
          workspaceFolderCount: 0,
          persistent: true,
        },
      ]),
      sessionId,
    )
    const messageId = 'msg_ref_check'
    const dirtyAttachment = {
      name: fileName,
      size: 0,
      type: 'inode/directory',
      workspaceKind: 'folder',
      workspaceFolderPath: fileName,
      workspaceRelPath: fileName,
      workspaceFileCount: 0,
      workspaceFolderCount: 0,
      persistent: true,
    }
    db.prepare(
      `INSERT INTO chat_messages
         (id, company_id, session_id, user_id, role, text, meta_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      messageId,
      'c1',
      sessionId,
      'u1',
      'assistant',
      '收到',
      JSON.stringify({ attachments: [dirtyAttachment] }),
      Date.now(),
    )

    const open = await app.inject({ method: 'GET', url: `/api/chat/sessions/${sessionId}/messages?as=u1` })
    expect(open.statusCode).toBe(200)
    const body = open.json() as {
      data: {
        session: {
          references: Array<{
            name: string
            workspaceKind?: string
            workspaceFileId?: string
            workspaceRelPath?: string
            persistent: boolean
          }>
        }
        messages: Array<{
          id: string
          meta: { attachments: Array<Record<string, unknown>> }
        }>
      }
    }
    expect(body.data.session.references).toHaveLength(1)
    expect(body.data.session.references[0]).toMatchObject({
      name: fileName,
      workspaceKind: 'file',
      workspaceFileId: 'wf_ref_check',
      workspaceRelPath: fileName,
      persistent: true,
    })
    expect(body.data.messages[0].meta.attachments[0]).toMatchObject({
      name: fileName,
      workspaceKind: 'file',
      workspaceFileId: 'wf_ref_check',
      workspaceRelPath: fileName,
      persistent: true,
    })
    expect(body.data.messages[0].meta.attachments[0]).not.toHaveProperty('workspaceFolderPath')
    const stored = db.prepare('SELECT references_json FROM chat_sessions WHERE id = ?').get(sessionId) as {
      references_json: string
    }
    expect(JSON.parse(stored.references_json)[0]).toMatchObject({
      workspaceKind: 'file',
      workspaceFileId: 'wf_ref_check',
    })
    const storedMessage = db.prepare('SELECT meta_json FROM chat_messages WHERE id = ?').get(messageId) as {
      meta_json: string
    }
    expect(JSON.parse(storedMessage.meta_json).attachments[0]).toMatchObject({
      workspaceKind: 'file',
      workspaceFileId: 'wf_ref_check',
    })
    expect(JSON.parse(storedMessage.meta_json).attachments[0]).not.toHaveProperty('workspaceFolderPath')

    // 旧页面把同一文件再次按文件夹提交时，保存入口也应纠正，不能把脏引用写回来。
    const put = await app.inject({
      method: 'PUT',
      url: `/api/chat/sessions/${sessionId}/references?as=u1`,
      payload: {
        references: [{ name: fileName, workspaceKind: 'folder', workspaceFolderPath: fileName }],
      },
    })
    expect(put.statusCode).toBe(200)
    const putBody = put.json() as {
      data: { references: Array<{ workspaceKind?: string; workspaceFileId?: string }> }
    }
    expect(putBody.data.references[0]).toMatchObject({
      workspaceKind: 'file',
      workspaceFileId: 'wf_ref_check',
    })
  })
})
