import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { openDatabase, migrate } from '@eab/storage'
import { SC } from '@eab/domain'
import type { ServerConfig } from '../src/config.js'
import type { ServerDeps } from '../src/deps.js'
import type { RequestActor } from '../src/session.js'
import { executeTool, toolSpecsForActor } from '../src/routes/tools.js'
import {
  createUserWorkspaceFolder,
  deleteUserWorkspaceFolder,
  renameUserWorkspaceFolder,
  userScopeDir,
  workspaceFolderSummaries,
} from '../src/routes/workspace.js'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function testDeps() {
  const dir = mkdtempSync(join(tmpdir(), 'eab-workspace-folders-'))
  dirs.push(dir)
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
      scopes: new Set([SC.WORKSPACE_READ, SC.WORKSPACE_WRITE]),
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
  return { dir, db, deps, actor }
}

function insertFile(
  deps: ServerDeps,
  actor: RequestActor,
  relPath: string,
  content: string,
): string {
  const root = userScopeDir(deps, actor.subject.companyId, actor.subject.userId)
  const target = join(root, relPath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
  const id = `f_${relPath.replace(/[^a-zA-Z0-9]/g, '_')}`
  const now = Date.now()
  deps.db.prepare(
    `INSERT INTO workspace_files
       (id, company_id, scope_type, scope_id, owner_user_id, rel_path, name, size, mime, storage_path, created_at, updated_at)
     VALUES (?, ?, 'user', ?, ?, ?, ?, ?, 'text/plain', ?, ?, ?)`,
  ).run(
    id,
    actor.subject.companyId,
    actor.subject.userId,
    actor.subject.userId,
    relPath,
    relPath.split('/').pop() || relPath,
    Buffer.byteLength(content),
    target,
    now,
    now,
  )
  return id
}

describe('个人云空间文件夹操作', () => {
  it('新建文件夹写 .gitkeep 占位，能从扁平文件推导出文件夹树', () => {
    const { deps, actor } = testDeps()
    const created = createUserWorkspaceFolder(deps, actor, 'docs/工作计划')
    expect(created.folderPath).toBe('docs/工作计划')
    expect(created.row.rel_path).toBe('docs/工作计划/.gitkeep')
    expect(existsSync(join(userScopeDir(deps, actor.subject.companyId, actor.subject.userId), 'docs/工作计划/.gitkeep')).toString())
      .toBe('true')

    const summaries = workspaceFolderSummaries([
      { rel_path: 'docs/工作计划/.gitkeep' },
      { rel_path: 'docs/工作计划/计划.md' },
      { rel_path: 'docs/其他.md' },
      { rel_path: 'README.md' },
    ])
    expect(summaries).toMatchObject([
      { path: 'docs', name: 'docs', parentPath: '', fileCount: 2 },
      { path: 'docs/工作计划', name: '工作计划', parentPath: 'docs', fileCount: 1 },
    ])
  })

  it('重命名文件夹会整体搬移文件并同步后代元数据', () => {
    const { db, deps, actor } = testDeps()
    createUserWorkspaceFolder(deps, actor, 'docs/工作计划')
    insertFile(deps, actor, 'docs/工作计划/计划.md', '旧内容')
    const renamed = renameUserWorkspaceFolder(deps, actor, 'docs', '资料')

    expect(renamed).toMatchObject({ from: 'docs', to: '资料', fileCount: 1 })
    const root = userScopeDir(deps, actor.subject.companyId, actor.subject.userId)
    expect(existsSync(join(root, 'docs'))).toBe(false)
    expect(existsSync(join(root, '资料/工作计划/计划.md'))).toBe(true)
    const rows = db
      .prepare("SELECT rel_path FROM workspace_files WHERE owner_user_id = 'u_test' ORDER BY rel_path")
      .all() as unknown as Array<{ rel_path: string }>
    expect(rows.map((row) => row.rel_path)).toEqual([
      '资料/工作计划/.gitkeep',
      '资料/工作计划/计划.md',
    ])

    createUserWorkspaceFolder(deps, actor, '备份')
    expect(() => renameUserWorkspaceFolder(deps, actor, '资料', '备份')).toThrow(/目标路径已被/)
  })

  it('删除文件夹会把全部后代文件软删到回收区，并清理空目录', () => {
    const { db, deps, actor } = testDeps()
    createUserWorkspaceFolder(deps, actor, 'docs/工作计划')
    insertFile(deps, actor, 'docs/工作计划/计划.md', '待删除')
    const deleted = deleteUserWorkspaceFolder(deps, actor, 'docs')

    expect(deleted).toMatchObject({ folderPath: 'docs', fileCount: 1 })
    const root = userScopeDir(deps, actor.subject.companyId, actor.subject.userId)
    expect(existsSync(join(root, 'docs'))).toBe(false)
    const recycleDir = join(root, '_recycle')
    expect(readdirSync(recycleDir).length).toBe(2)
    const rows = db
      .prepare('SELECT rel_path, deleted_at FROM workspace_files ORDER BY rel_path')
      .all() as unknown as Array<{ rel_path: string; deleted_at: number | null }>
    expect(rows.every((row) => row.deleted_at !== null)).toBe(true)
  })

  it('拒绝内部目录、斜杠和重复创建', () => {
    const { deps, actor } = testDeps()
    expect(() => createUserWorkspaceFolder(deps, actor, '_recycle/备份')).toThrow(/内部目录/)
    expect(() => createUserWorkspaceFolder(deps, actor, '.eab-skills/新技能')).toThrow(/内部目录/)
    createUserWorkspaceFolder(deps, actor, '资料')
    expect(() => createUserWorkspaceFolder(deps, actor, '资料')).toThrow(/文件夹已存在/)
    expect(() => renameUserWorkspaceFolder(deps, actor, '资料', 'a/b')).toThrow(/斜杠/)
  })

  it('文件夹里有其他成员共享来的文件时拒绝整体重命名和删除', () => {
    const { db, deps, actor } = testDeps()
    createUserWorkspaceFolder(deps, actor, 'docs')
    const now = Date.now()
    db.prepare(
      `INSERT INTO workspace_files
         (id, company_id, scope_type, scope_id, owner_user_id, rel_path, name, size, mime, storage_path, created_at, updated_at)
       VALUES ('f_foreign', 'c1', 'user', 'u_other', 'u_other', 'docs/其他成员.md', '其他成员.md', 1, 'text/plain', 'x', ?, ?)`,
    ).run(now, now)
    db.prepare(
      `INSERT INTO workspace_shares (id, company_id, file_id, scope_type, scope_id, created_by, created_at)
       VALUES ('s1', 'c1', 'f_foreign', 'user', 'u_test', 'u_other', ?)`,
    ).run(now)

    expect(() => renameUserWorkspaceFolder(deps, actor, 'docs', '资料')).toThrow(/其他成员共享/)
    expect(() => deleteUserWorkspaceFolder(deps, actor, 'docs')).toThrow(/其他成员共享/)
  })

  it('Agent 的 workspace.folder 能创建、列出、重命名和删除文件夹', async () => {
    const { deps, actor } = testDeps()
    const specs = toolSpecsForActor(deps.db, actor as unknown as Parameters<typeof toolSpecsForActor>[1])
    expect(specs.map((spec) => spec.function.name)).toContain('workspace_folder')
    const created = (await executeTool(
      deps,
      actor as unknown as Parameters<typeof executeTool>[1],
      'workspace.folder',
      { action: 'create', path: 'docs/工作计划' },
    )) as Record<string, unknown>
    expect(created).toMatchObject({ created: true, folderPath: 'docs/工作计划' })

    const listed = (await executeTool(
      deps,
      actor as unknown as Parameters<typeof executeTool>[1],
      'workspace.list',
      {},
    )) as {
      folders: Array<{ path: string; fileCount: number }>
      files: unknown[]
    }
    expect(listed.folders).toMatchObject([
      { path: 'docs', name: 'docs', parentPath: '', fileCount: 0 },
      { path: 'docs/工作计划', name: '工作计划', parentPath: 'docs', fileCount: 0 },
    ])
    expect(listed.files).toEqual([])

    const renamed = (await executeTool(
      deps,
      actor as unknown as Parameters<typeof executeTool>[1],
      'workspace.folder',
      { action: 'rename', path: 'docs/工作计划', newName: '计划' },
    )) as Record<string, unknown>
    expect(renamed).toMatchObject({ renamed: true, from: 'docs/工作计划', to: 'docs/计划' })

    const deleted = (await executeTool(
      deps,
      actor as unknown as Parameters<typeof executeTool>[1],
      'workspace.folder',
      { action: 'delete', path: 'docs/计划' },
    )) as Record<string, unknown>
    expect(deleted).toMatchObject({ deleted: true, folderPath: 'docs/计划', fileCount: 0 })
  })
})
