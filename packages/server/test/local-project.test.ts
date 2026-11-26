import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { migrate, openDatabase } from '@eab/storage'
import { SC } from '@eab/domain'
import type { ServerConfig } from '../src/config.js'
import type { ServerDeps } from '../src/deps.js'
import type { RequestActor } from '../src/session.js'
import { createLocalProject, deleteLocalProject, listLocalProjectEntries, resolveLocalProjectPath } from '../src/local-project.js'
import { executeTool } from '../src/routes/tools.js'
import type { ActiveSpace } from '../src/space.js'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'eab-local-project-'))
  dirs.push(dir)
  const root = join(dir, 'demo')
  mkdirSync(root)
  writeFileSync(join(root, 'README.md'), '# demo\n')
  writeFileSync(join(root, '.env'), 'SECRET_TOKEN=supersecret\n')

  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  db.exec('PRAGMA foreign_keys = OFF')
  const config = { dbPath: join(dir, 'eab.db'), dataDir: dir } as ServerConfig
  const deps: ServerDeps = { db, config, companyId: 'c1', migrations: [], consoleToken: '' }
  const actor = {
    subject: {
      companyId: 'c1',
      userId: 'u_test',
      status: 'active',
      deptId: 'd_test',
      deptPath: '/d_test',
      deptChain: [],
      roles: [],
      scopes: new Set([SC.LOCAL_SPACE_READ, SC.LOCAL_SPACE_WRITE, SC.AGENT_TOOL_INVOKE]),
    },
    person: {
      id: 'u_test',
      name: '测试员工',
      title: null,
      deptId: 'd_test',
      deptPath: '/d_test',
      deptName: '测试部门',
      companyId: 'c1',
      companyName: '测试公司',
    },
  } as unknown as RequestActor
  const project = createLocalProject(db, 'c1', 'u_test', { path: root }).project
  const space: ActiveSpace = {
    kind: 'local',
    id: project.id,
    name: project.name,
    root: project.rootRealPath,
    mode: project.mode,
    allowSensitive: project.allowSensitive,
    deviceId: project.deviceId,
    instructions: project.instructions,
    cloudRefs: project.cloudRefs,
  }
  return { dir, root, db, deps, actor, project, space }
}

describe('本地项目空间', () => {
  it('空路径表示项目根，列表返回相对路径', () => {
    const { project } = setup()
    const listing = listLocalProjectEntries(project, '', { depth: 1, limit: 200 })
    expect(listing.path).toBe('')
    expect(listing.entries.map((item) => item.path)).toContain('README.md')
  })

  it('拒绝越界路径和敏感文件', () => {
    const { project, root } = setup()
    expect(() => resolveLocalProjectPath(project, '..\\outside.txt')).toThrow()
    expect(() => resolveLocalProjectPath(project, join(root, '..', 'outside.txt'))).toThrow()
    expect(() => resolveLocalProjectPath(project, '.env')).toThrow(/敏感文件/)
  })

  it('project.read/write 走项目根，project.search 不返回 .env 内容', async () => {
    const { deps, actor, space } = setup()
    const read = (await executeTool(
      deps,
      actor,
      'project.read',
      { path: 'README.md' },
      space,
      { sessionId: 'chat_local_project', channel: 'web' },
    )) as { text: string; path: string }
    expect(read.path).toBe('README.md')
    expect(read.text).toContain('# demo')

    const written = (await executeTool(
      deps,
      actor,
      'project.write',
      { path: 'src/hello.txt', text: 'hello local project' },
      space,
      { sessionId: 'chat_local_project', channel: 'web' },
    )) as { path: string; created: boolean }
    expect(written.path).toBe('src/hello.txt')
    expect(written.created).toBe(true)

    const search = (await executeTool(
      deps,
      actor,
      'project.search',
      { path: '', query: 'supersecret' },
      space,
      { sessionId: 'chat_local_project', channel: 'web' },
    )) as { count: number; matches: unknown[] }
    expect(search.count).toBe(0)
    expect(search.matches).toEqual([])

    await expect(
      executeTool(
        deps,
        actor,
        'project.read',
        { path: '.env' },
        space,
        { sessionId: 'chat_local_project', channel: 'web' },
      ),
    ).rejects.toThrow(/敏感文件/)
  })

  it('project.delete 删除文件且不能删除目录', async () => {
    const { deps, actor, space, root } = setup()
    const created = (await executeTool(
      deps,
      actor,
      'project.write',
      { path: 'tmp/to-delete.txt', text: 'bye' },
      space,
      { sessionId: 'chat_local_project', channel: 'web' },
    )) as { path: string }
    expect(created.path).toBe('tmp/to-delete.txt')

    const deleted = (await executeTool(
      deps,
      actor,
      'project.delete',
      { path: 'tmp/to-delete.txt' },
      space,
      { sessionId: 'chat_local_project', channel: 'web' },
    )) as { path: string; deleted: boolean; size: number }
    expect(deleted).toMatchObject({ path: 'tmp/to-delete.txt', deleted: true, size: 3 })
    expect(existsSync(join(root, 'tmp', 'to-delete.txt'))).toBe(false)

    await expect(
      executeTool(
        deps,
        actor,
        'project.delete',
        { path: 'tmp' },
        space,
        { sessionId: 'chat_local_project', channel: 'web' },
      ),
    ).rejects.toThrow(/只能删除文件/)
  })

  it('删除项目时逻辑删除项目内会话，不删除磁盘文件', () => {
    const { db, project } = setup()
    const now = Date.now()
    db.prepare(
      `INSERT INTO chat_sessions
        (id, company_id, user_id, title, source, space_kind, space_id, project_mode, references_json, created_at, updated_at)
       VALUES (?, 'c1', 'u_test', '新工作任务', 'web', 'local', ?, 'task', '[]', ?, ?)`,
    ).run('chat_project_task', project.id, now, now)

    deleteLocalProject(db, 'c1', 'u_test', project.id)

    const session = db.prepare('SELECT deleted_at FROM chat_sessions WHERE id = ?').get('chat_project_task') as
      | { deleted_at: number | null }
      | undefined
    expect(session?.deleted_at).toBeTypeOf('number')
    expect(db.prepare('SELECT deleted_at FROM user_local_spaces WHERE id = ?').get(project.id)).toMatchObject({
      deleted_at: expect.any(Number),
    })
  })
})
