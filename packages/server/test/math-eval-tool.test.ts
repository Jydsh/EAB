import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate, openDatabase, type Db } from '@eab/storage'
import { SC } from '@eab/domain'
import { executeTool, toolSpecsForAgent, TOOLS } from '../src/routes/tools.js'

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

  it('同时给出 values 时和 expression 一起返回', async () => {
    const result = (await executeTool(deps, actor, 'math.eval', { expression: '(1200+300)/4' })) as { value: number }
    expect(result.value).toBe(375)
    const both = (await executeTool(deps, actor, 'math.eval', { expression: '1+1', values: [1, 2, 3] })) as {
      sum: number
      value: number
    }
    expect(both.sum).toBe(6)
    expect(both.value).toBe(2)
  })

  it('兼容模型误传的 {label,value} 对象数组，只取 value 汇总', async () => {
    const result = (await executeTool(deps, actor, 'math.eval', {
      values: [
        { label: '11月2-8日', value: 65.15 },
        { label: '11月9-15日', value: 55.2 },
        { label: '11月16-22日', value: 57.43 },
      ],
    })) as { count: number; sum: number; avg: number; unit: string }
    expect(result.count).toBe(3)
    expect(result.sum).toBe(177.78)
    expect(result.avg).toBe(59.26)
    expect(result.unit).toBe('number')
  })

  it('对象既没有 value 也不是数字时，报错要指出正确写法', async () => {
    await expect(
      executeTool(deps, actor, 'math.eval', { values: [{ label: '11月2-8日' }, { label: '11月9-15日' }, { label: '11月16-22日' }] }),
    ).rejects.toThrow(/不含 value/)
  })

  it('拒绝空参数和无法解析的取值', async () => {
    await expect(executeTool(deps, actor, 'math.eval', {})).rejects.toThrow(/expression 或 values/)
    await expect(executeTool(deps, actor, 'math.eval', { values: [1, '十小时', 3] })).rejects.toThrow(/不是有效数字/)
    await expect(executeTool(deps, actor, 'math.eval', { values: [] })).rejects.toThrow(/expression 或 values/)
  })

  it('工具定义明确说明 values 的元素结构，避免模型自己猜对象格式', () => {
    const specs = toolSpecsForAgent(db, actor, { kind: 'cloud' }, '')
    const math = specs.find((spec) => spec.function.name === 'math_eval')
    expect(math).toBeTruthy()
    const values = math?.function.parameters.properties.values
    expect(values?.type).toBe('array')
    expect(values?.items?.type).toBe('string')
    expect(values?.minItems).toBe(3)
    expect(values?.description).toContain('不要传 {label,value} 对象')
    expect(math?.function.description).toContain('不要传 [{label,value}]')
  })

  it('所有内置工具的数组参数都声明了 items，模型不用猜元素结构', () => {
    for (const tool of TOOLS) {
      for (const [name, schema] of Object.entries(tool.input)) {
        if (schema.type !== 'array') continue
        expect(schema.items, `${tool.id}.${name} 缺少 items`).toBeTruthy()
      }
    }
  })

  it('作为核心工具默认出现在对话工具清单里', () => {
    const specs = toolSpecsForAgent(db, actor, { kind: 'cloud' }, '')
    expect(specs.map((spec) => spec.function.name)).toContain('math_eval')
  })
})
