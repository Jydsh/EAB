import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDatabase, migrate } from '@eab/storage'
import type { ServerConfig } from '../src/config.js'
import type { ServerDeps } from '../src/deps.js'
import type { RequestActor } from '../src/session.js'
import { saveUserWorkspaceFile, readUserWorkspaceFile } from '../src/routes/workspace.js'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function testDeps() {
  const dir = mkdtempSync(join(tmpdir(), 'eab-workspace-file-'))
  dirs.push(dir)
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  // 单测只关心文件落盘与配额逻辑，不在这里搭完整公司/部门/成员主数据
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
  return { db, deps, actor }
}

describe('渠道文件落个人云空间', () => {
  it('写入 workspace_files 和磁盘，同名自动加序号', () => {
    const { db, deps, actor } = testDeps()
    const first = saveUserWorkspaceFile(deps, actor, {
      relPath: '报表.xlsx',
      buffer: Buffer.from('first'),
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      channel: 'dingtalk',
    })
    const second = saveUserWorkspaceFile(deps, actor, {
      relPath: '报表.xlsx',
      buffer: Buffer.from('second'),
      channel: 'dingtalk',
    })

    expect(first.relPath).toBe('报表.xlsx')
    expect(second.relPath).toBe('报表 (1).xlsx')
    expect(readFileSync(join(first.root, first.relPath), 'utf8')).toBe('first')
    expect(existsSync(join(second.root, second.relPath))).toBe(true)

    const rows = db
      .prepare("SELECT rel_path, size FROM workspace_files WHERE company_id = 'c1' AND scope_type = 'user' ORDER BY rel_path")
      .all() as unknown as Array<{ rel_path: string; size: number }>
    expect(rows).toEqual([
      { rel_path: '报表 (1).xlsx', size: 6 },
      { rel_path: '报表.xlsx', size: 5 },
    ])
  })

  it('超过单文件上限时拒绝，且不写盘', () => {
    const { db, deps, actor } = testDeps()
    expect(() =>
      saveUserWorkspaceFile(deps, actor, {
        relPath: 'big.bin',
        buffer: Buffer.alloc(51 * 1024 * 1024),
        channel: 'dingtalk',
      }),
    ).toThrow(/超过单文件上限/)
    const count = db.prepare('SELECT COUNT(*) AS count FROM workspace_files').get() as { count: number }
    expect(Number(count.count)).toBe(0)
  })

  it('读取时以磁盘最新内容为准，网页编辑保存后发送能拿到新版本', () => {
    const { deps, actor } = testDeps()
    const saved = saveUserWorkspaceFile(deps, actor, {
      relPath: '编辑后发送.txt',
      buffer: Buffer.from('旧内容'),
      mime: 'text/plain',
    })
    expect(readUserWorkspaceFile(deps, actor, saved.id).buffer.toString('utf8')).toBe('旧内容')

    writeFileSync(join(saved.root, saved.relPath), '新内容', 'utf8')

    expect(readUserWorkspaceFile(deps, actor, saved.id).buffer.toString('utf8')).toBe('新内容')
  })
})
