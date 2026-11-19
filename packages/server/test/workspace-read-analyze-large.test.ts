import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate, openDatabase } from '@eab/storage'
import { SC } from '@eab/domain'
import { executeTool } from '../src/routes/tools.js'

const dirs: string[] = []
const dbs: Array<{ close: () => void }> = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const db of dbs.splice(0)) db.close()
})

function testEnv() {
  const dataDir = mkdtempSync(join(tmpdir(), 'eab-workspace-analyze-large-'))
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

describe('workspace.read 大文件全量概览', () => {
  it('超过直读阈值的文本会统计全部行，不再只返回第一页', async () => {
    const { deps, actor, root } = testEnv()
    const lines = Array.from({ length: 4000 }, (_, index) => `第 ${index + 1} 行：站台设备检查记录`)
    const text = lines.join('\n')
    expect(text.length).toBeGreaterThan(50_000)
    writeFileSync(join(root, '大文件.txt'), text, 'utf8')

    const result = await executeTool(deps, actor, 'workspace.read', {
      path: '大文件.txt',
      mode: 'analyze',
      question: '统计总行数和最后一行',
    }) as any

    expect(result.mode).toBe('overview')
    expect(result.kind).toBe('text')
    expect(result.totalLines).toBe(4000)
    expect(result.overview).toContain('全文')
    expect(result.overview).toContain('第 4000 行')
    expect(result.coverage).toContain('已完整统计全部 4,000 行')
  })

  it('大 CSV 会解析全部记录并给出逐字段全量计数', async () => {
    const { deps, actor, root } = testEnv()
    const rows = ['编号,站名,问题类别']
    for (let index = 1; index <= 5000; index += 1) {
      rows.push(`${index},${index % 2 === 0 ? '贵阳北' : '三星堆'},${index % 3 === 0 ? '安全隐患' : '功能异常'}`)
    }
    const text = rows.join('\n')
    expect(text.length).toBeGreaterThan(50_000)
    writeFileSync(join(root, '大记录.csv'), text, 'utf8')

    const result = await executeTool(deps, actor, 'workspace.read', {
      path: '大记录.csv',
      mode: 'analyze',
      question: '统计每个站名的记录数',
    }) as any

    expect(result.mode).toBe('overview')
    expect(result.kind).toBe('records')
    expect(result.totalRows).toBe(5000)
    expect(result.columns).toEqual(['编号', '站名', '问题类别'])
    expect(result.overview).toContain('总记录数 5000 条')
    expect(result.overview).toContain('站名（非空 5000/5000，去重 2）')
    expect(result.overview).toContain('贵阳北=2500')
    expect(result.coverage).toContain('已完整解析全部 5000 条记录')
  })
})
