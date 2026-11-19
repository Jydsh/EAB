import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate, openDatabase } from '@eab/storage'
import { EC, SC } from '@eab/domain'
import { executeTool } from '../src/routes/tools.js'

const dirs: string[] = []
const dbs: Array<{ close: () => void }> = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const db of dbs.splice(0)) db.close()
})

function testEnv() {
  const dataDir = mkdtempSync(join(tmpdir(), 'eab-workspace-analyze-'))
  dirs.push(dataDir)
  const db = openDatabase({ path: ':memory:' })
  dbs.push(db)
  migrate(db)
  const actor = {
    subject: {
      companyId: 'c1',
      userId: 'u1',
      status: 'active',
      deptId: 'd1',
      deptPath: '/d1',
      deptChain: [],
      roles: ['member'],
      scopes: new Set(Object.values(SC)),
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
  } as any
  const deps = {
    db,
    config: {
      dataDir,
      workspacesDir: join(dataDir, 'workspaces'),
      dbPath: ':memory:',
      toolTimeoutMs: 30_000,
      toolQueueLimit: 200,
    },
    companyId: 'c1',
  } as any
  const root = join(dataDir, 'workspaces', 'c1', 'user-u1')
  mkdirSync(root, { recursive: true })
  return { deps, actor, root }
}

describe('workspace.read 全文分析模式', () => {
  it('小文件走 analyze 时直接返回全文，不再只给一页', async () => {
    const { deps, actor, root } = testEnv()
    const lines = Array.from({ length: 180 }, (_, index) => `第 ${index + 1} 行：检查记录`)
    writeFileSync(join(root, '记录.csv'), lines.join('\n'), 'utf8')

    const result = await executeTool(deps, actor, 'workspace.read', {
      path: '记录.csv',
      mode: 'analyze',
      question: '统计所有记录',
    }) as any

    expect(result.mode).toBe('full')
    expect(result.totalLines).toBe(180)
    expect(result.truncated).toBe(false)
    expect(result.text).toContain('第 180 行')
    expect(result.coverage).toContain('全文已返回')
  })

  it('超过 2000 行的文件按默认分页仍只返回一页，并明确提示改用 analyze', async () => {
    const { deps, actor, root } = testEnv()
    const lines = Array.from({ length: 2500 }, (_, index) => `第 ${index + 1} 行`)
    writeFileSync(join(root, '大文件.txt'), lines.join('\n'), 'utf8')

    const first = await executeTool(deps, actor, 'workspace.read', { path: '大文件.txt' }) as any
    expect(first.mode).toBe('lines')
    expect(first.endLine).toBe(2000)
    expect(first.truncated).toBe(true)
    expect(first.nextOffset).toBe(2001)
    expect(first.analysisHint).toContain('mode="analyze"')

    const analyzed = await executeTool(deps, actor, 'workspace.read', {
      path: '大文件.txt',
      mode: 'analyze',
    }) as any
    // 2,500 行仍低于 50,000 字符直读阈值，所以直接返回全文。
    expect(analyzed.mode).toBe('full')
    expect(analyzed.totalLines).toBe(2500)
    expect(analyzed.text).toContain('第 2500 行')
  })

  it('超过全文分析上限时明确拒绝，并引导缩小范围或拆分文件', async () => {
    const { deps, actor, root } = testEnv()
    writeFileSync(join(root, '超大.txt'), 'x'.repeat(2_000_001), 'utf8')
    await expect(executeTool(deps, actor, 'workspace.read', {
      path: '超大.txt',
      mode: 'analyze',
    })).rejects.toMatchObject({
      code: EC.VALIDATION,
      message: expect.stringContaining('超过全文分析上限'),
    })
  })
})
