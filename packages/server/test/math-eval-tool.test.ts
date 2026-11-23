import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate, openDatabase, type Db } from '@eab/storage'
import { SC } from '@eab/domain'
import { executeTool, toolSpecsForAgent } from '../src/routes/tools.js'

describe('math.eval 汇总工具', () => {
  let db: Db
  let root: string
  let deps: any
  let actor: any

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'eab-math-eval-'))
    db = openDatabase({ path: join(root, 'eab.sqlite') })
    migrate(db)
    db.prepare("INSERT INTO companies (id, name, slug, status, created_at) VALUES ('c1', '测试公司', 'test', 'active', 1)").run()
    db.prepare("INSERT INTO departments (id, company_id, name, path, depth, order_no, created_at) VALUES ('d1', 'c1', '测试部门', '/d1', 0, 0, 1)").run()
    db.prepare("INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at) VALUES ('u1', 'c1', 'd1', '/d1', '测试员工', 'active', 1, 1)").run()
    deps = { db, config: { dbPath: join(root, 'eab.sqlite'), workspacesDir: join(root, 'workspaces') }, companyId: 'c1' }
    actor = {
      subject: { companyId: 'c1', userId: 'u1', status: 'active', deptId: 'd1', deptPath: '/d1', deptChain: [], roles: [], scopes: new Set(Object.values(SC)) },
      person: { id: 'u1', name: '测试员工', deptId: 'd1', deptPath: '/d1', deptName: '测试部门', companyId: 'c1', companyName: '测试公司' },
    }
  })

  afterEach(() => {
    try {
      db.close()
      rmSync(root, { recursive: true, force: true })
    } catch {
      // Windows 上 SQLite 句柄释放可能延迟。
    }
  })

  it('按原值汇总一批时长，返回准确的合计', async () => {
    const values = [10.3, 7.75, 11, 11.4, 17.6, 15.13, 9.22, 11.7, 11.65, 11, 12.87, 11, 11.25, 16.32, 16.82, 17.33, 10.93]
    const result = (await executeTool(deps, actor, 'math.eval', { values })) as {
      count: number
      sum: number
      avg: number
      unit: string
    }
    expect(result.count).toBe(17)
    expect(result.sum).toBe(213.27)
    expect(result.avg).toBe(12.55)
    expect(result.unit).toBe('number')
  })

  it('支持“10.3小时”和“10:18”这类写法，按小时计算', async () => {
    const result = (await executeTool(deps, actor, 'math.eval', { values: ['10.3小时', '10:18', '7.75h'] })) as {
      sum: number
      unit: string
    }
    expect(result.unit).toBe('hours')
    expect(result.sum).toBe(28.35)
  })

  it('保留原有四则运算，并在同时给 values 时一起返回', async () => {
    const result = (await executeTool(deps, actor, 'math.eval', { expression: '(1200+300)/4' })) as { value: number }
    expect(result.value).toBe(375)
    const both = (await executeTool(deps, actor, 'math.eval', { expression: '1+1', values: [1, 2, 3] })) as {
      sum: number
      value: number
    }
    expect(both.sum).toBe(6)
    expect(both.value).toBe(2)
  })

  it('拒绝空参数和无法解析的取值', async () => {
    await expect(executeTool(deps, actor, 'math.eval', {})).rejects.toThrow(/expression 或 values/)
    await expect(executeTool(deps, actor, 'math.eval', { values: [1, '十小时'] })).rejects.toThrow(/不是有效数字/)
    await expect(executeTool(deps, actor, 'math.eval', { values: [] })).rejects.toThrow(/expression 或 values/)
  })

  it('作为核心工具默认出现在对话工具清单里', () => {
    const specs = toolSpecsForAgent(db, actor, { kind: 'cloud' }, '')
    expect(specs.map((spec) => spec.function.name)).toContain('math_eval')
  })
})
