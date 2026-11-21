import { afterEach, describe, expect, it } from 'vitest'
import { migrate, openDatabase, type Db } from '@eab/storage'
import {
  deleteApprovalWorkflow,
  ensureApprovalWorkflowSeeds,
  getApprovalWorkflow,
  listApprovalWorkflows,
  publishApprovalWorkflow,
  saveApprovalWorkflow,
  validateWorkflowFlow,
} from '../src/approval-workflows.js'

const dbs: Db[] = []

afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
})

function testDb(): Db {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  dbs.push(db)
  db.prepare(
    `INSERT INTO companies (id, name, slug, status, created_at)
     VALUES ('c1', '测试公司', 'test', 'active', ?)`,
  ).run(Date.now())
  ensureApprovalWorkflowSeeds(db, 'c1')
  return db
}

describe('approval workflows', () => {
  it('首次读取写入三套种子模板，并返回已发布版本的流程', () => {
    const db = testDb()
    const workflows = listApprovalWorkflows(db, 'c1')
    expect(workflows).toHaveLength(3)
    expect(workflows.map((item) => item.id)).toEqual(expect.arrayContaining(['awf_default', 'awf_sensitive', 'awf_dept_custom']))
    const published = workflows.find((item) => item.id === 'awf_default')
    expect(published?.status).toBe('published')
    expect(published?.version).toBe(1)
    expect(published?.draftVersion).toBeNull()
    expect(published?.flow.length).toBeGreaterThan(3)
  })

  it('保存草稿写入版本表，重新读取仍能拿到同一草稿', () => {
    const db = testDb()
    const seeded = getApprovalWorkflow(db, 'c1', 'awf_default')
    const changed = seeded.flow.map((node) =>
      node.kind === 'condition' ? { ...node, title: `${node.title}（已调整）` } : node,
    )
    const saved = saveApprovalWorkflow(db, 'c1', 'tester', {
      id: seeded.id,
      name: seeded.name,
      description: '测试草稿',
      scopeMode: seeded.scopeMode,
      roleMode: seeded.roleMode,
      flow: changed,
    })

    expect(saved.status).toBe('draft')
    expect(saved.version).toBe(1)
    expect(saved.draftVersion).toBe(2)
    expect(saved.description).toBe('测试草稿')
    expect(saved.flow.some((node) => String(node.title).includes('已调整'))).toBe(true)

    const reloaded = getApprovalWorkflow(db, 'c1', 'awf_default')
    expect(reloaded.draftVersion).toBe(2)
    expect(reloaded.flow.some((node) => String(node.title).includes('已调整'))).toBe(true)
    const versions = db
      .prepare(`SELECT version, status FROM approval_workflow_versions WHERE workflow_id = 'awf_default' ORDER BY version`)
      .all() as { version: number; status: string }[]
    expect(versions).toEqual([
      { version: 1, status: 'published' },
      { version: 2, status: 'draft' },
    ])
  })

  it('发布接受未保存的流程，冻结新版本并清空草稿指针', () => {
    const db = testDb()
    const seeded = getApprovalWorkflow(db, 'c1', 'awf_default')
    const edited = seeded.flow.map((node) =>
      node.kind === 'end' ? { ...node, title: '结束（复核完成）' } : node,
    )
    const published = publishApprovalWorkflow(db, 'c1', 'tester', seeded.id, edited)

    expect(published.status).toBe('published')
    expect(published.version).toBe(2)
    expect(published.draftVersion).toBeNull()
    expect(published.flow.find((node) => node.kind === 'end')?.title).toBe('结束（复核完成）')

    const versions = db
      .prepare(`SELECT version, status FROM approval_workflow_versions WHERE workflow_id = 'awf_default' ORDER BY version`)
      .all() as { version: number; status: string }[]
    expect(versions).toEqual([
      { version: 1, status: 'superseded' },
      { version: 2, status: 'published' },
    ])
  })

  it('新建模板默认是草稿，发布前严格校验节点结构', () => {
    const db = testDb()
    const created = saveApprovalWorkflow(db, 'c1', 'tester', {
      name: '测试专用流程',
      description: '仅用于测试',
      flow: [
        { id: 'start', kind: 'start', title: '发起申请' },
        { id: 'a1', kind: 'approval', title: '部门负责人审批', meta: '或签' },
        { id: 'end', kind: 'end', title: '结束' },
      ],
    })
    expect(created.status).toBe('draft')
    expect(created.version).toBe(0)
    expect(created.draftVersion).toBe(1)
    expect(created.validation).toEqual([])

    const invalid = [
      { id: 'start', kind: 'start' as const, title: '发起申请' },
      { id: 'start', kind: 'start' as const, title: '重复开始' },
      { id: 'end', kind: 'end' as const, title: '结束' },
    ]
    const validation = validateWorkflowFlow(invalid)
    expect(validation.valid).toBe(false)
    expect(validation.errors.join(' ')).toContain('节点 id 重复')
    const versionsBefore = db
      .prepare(`SELECT COUNT(*) AS n FROM approval_workflow_versions WHERE workflow_id = ?`)
      .get(created.id) as { n: number }
    expect(() => publishApprovalWorkflow(db, 'c1', 'tester', created.id, invalid)).toThrow(/校验/)
    const versionsAfter = db
      .prepare(`SELECT COUNT(*) AS n FROM approval_workflow_versions WHERE workflow_id = ?`)
      .get(created.id) as { n: number }
    expect(versionsAfter.n).toBe(versionsBefore.n)
    expect(getApprovalWorkflow(db, 'c1', created.id).draftVersion).toBe(1)
  })

  it('删除模板后列表立即消失，且全部删空后不会再次自动补回种子', () => {
    const db = testDb()
    const removed = deleteApprovalWorkflow(db, 'c1', 'awf_dept_custom')
    expect(removed.name).toBe('研发部临时权限')
    expect(listApprovalWorkflows(db, 'c1').map((item) => item.id)).not.toContain('awf_dept_custom')
    deleteApprovalWorkflow(db, 'c1', 'awf_default')
    deleteApprovalWorkflow(db, 'c1', 'awf_sensitive')
    ensureApprovalWorkflowSeeds(db, 'c1')
    expect(listApprovalWorkflows(db, 'c1')).toEqual([])
    expect(() => getApprovalWorkflow(db, 'c1', 'awf_dept_custom')).toThrow(/不存在/)
    const rows = db
      .prepare(`SELECT status, deleted_at FROM approval_workflows WHERE company_id = 'c1'`)
      .all() as { status: string; deleted_at: number | null }[]
    expect(rows).toHaveLength(3)
    expect(rows.every((row) => row.status === 'disabled' && Boolean(row.deleted_at))).toBe(true)
  })

  it('指定成员审批必须选择成员，条件分支只允许一个否则分支', () => {
    const flow = [
      { id: 'start', kind: 'start' as const, title: '发起申请' },
      {
        id: 'cond',
        kind: 'condition' as const,
        title: '权限风险判断',
        branches: [
          {
            id: 'b1',
            label: '包含高危权限',
            rule: { field: 'scopeRisk', op: 'eq', value: 'high' },
            nodes: [
              { id: 'a_members', kind: 'approval' as const, title: '指定成员审批', meta: '会签', source: 'members', approvers: [] },
            ],
          },
          { id: 'b2', label: '其他情况', rule: { field: 'else' }, nodes: [{ id: 'a2', kind: 'approval' as const, title: '负责人审批', meta: '或签' }] },
          { id: 'b3', label: '又一个否则', rule: { field: 'else' }, nodes: [{ id: 'a3', kind: 'approval' as const, title: '兜底审批', meta: '或签' }] },
        ],
      },
      { id: 'end', kind: 'end' as const, title: '结束' },
    ]
    const invalid = validateWorkflowFlow(flow)
    expect(invalid.valid).toBe(false)
    expect(invalid.errors.join(' ')).toContain('至少需要 1 名成员')
    expect(invalid.errors.join(' ')).toContain('最多只能有一个「否则」分支')

    const fixed = flow.map((node) => {
      if (node.kind !== 'condition') return node
      return {
        ...node,
        branches: node.branches
          .filter((branch) => branch.id !== 'b3')
          .map((branch) =>
            branch.id === 'b1'
              ? {
                  ...branch,
                  nodes: branch.nodes.map((item) =>
                    item.id === 'a_members' ? { ...item, approvers: [{ id: 'u_1', name: '李鹏' }] } : item,
                  ),
                }
              : branch,
          ),
      }
    })
    expect(validateWorkflowFlow(fixed)).toEqual({ valid: true, errors: [] })
  })

  it('指定角色审批必须选择角色且固定使用会签', () => {
    const flow = [
      { id: 'start', kind: 'start' as const, title: '发起申请' },
      { id: 'a_role', kind: 'approval' as const, title: '角色审批', meta: '会签', source: 'role', roleCode: '' },
      { id: 'end', kind: 'end' as const, title: '结束' },
    ]
    const missingRole = validateWorkflowFlow(flow)
    expect(missingRole.valid).toBe(false)
    expect(missingRole.errors.join(' ')).toContain('必须选择角色')

    const wrongMode = validateWorkflowFlow(
      flow.map((node) => (node.id === 'a_role' ? { ...node, meta: '或签', mode: '或签', roleCode: 'auditor' } : node)),
    )
    expect(wrongMode.valid).toBe(false)
    expect(wrongMode.errors.join(' ')).toContain('必须使用会签')

    expect(
      validateWorkflowFlow(
        flow.map((node) => (node.id === 'a_role' ? { ...node, roleCode: 'auditor', roleName: '审计员' } : node)),
      ),
    ).toEqual({ valid: true, errors: [] })
  })

  it('直属上级 / 部门负责人链支持按节点配置 1–10 级', () => {
    const flow = [
      { id: 'start', kind: 'start' as const, title: '发起申请' },
      {
        id: 'a_dept',
        kind: 'approval' as const,
        title: '部门负责人审批',
        meta: '依次审批',
        mode: '依次审批',
        source: 'dept_chain',
        maxLevels: 2,
      },
      { id: 'end', kind: 'end' as const, title: '结束' },
    ]
    expect(validateWorkflowFlow(flow)).toEqual({ valid: true, errors: [] })

    for (const maxLevels of [0, 11, 2.5]) {
      const invalid = validateWorkflowFlow(
        flow.map((node) => (node.id === 'a_dept' ? { ...node, maxLevels } : node)),
      )
      expect(invalid.valid).toBe(false)
      expect(invalid.errors.join(' ')).toContain('审批级数必须是 1–10 的整数')
    }
  })

  it('自由连线按显式出线保存，条件标签与规则随连线持久化', () => {
    const db = testDb()
    const flow = [
      { id: 'start', kind: 'start' as const, title: '发起申请', x: 340, y: 24, nextIds: ['cond'], edgePorts: { cond: { from: 'bottom', to: 'top' } } },
      {
        id: 'cond',
        kind: 'condition' as const,
        title: '权限风险判断',
        x: 340,
        y: 120,
        nextIds: ['a_high', 'a_low'],
        edgeLabels: { a_high: '高危权限', a_low: '其他情况' },
        edgeRules: {
          a_high: { field: 'scopeRisk', op: 'eq', value: 'high' },
          a_low: { field: 'else' },
        },
        edgePorts: {
          a_high: { from: 'left', to: 'right' },
          a_low: { from: 'right', to: 'left' },
        },
      },
      { id: 'a_high', kind: 'approval' as const, title: '管理员审批', meta: '会签', source: 'company_admin', x: 197, y: 216, nextIds: ['merge'], edgePorts: { merge: { from: 'bottom', to: 'top' } } },
      { id: 'a_low', kind: 'approval' as const, title: '部门负责人审批', meta: '或签', source: 'dept_chain', x: 483, y: 216, nextIds: ['merge'], edgePorts: { merge: { from: 'bottom', to: 'top' } } },
      { id: 'merge', kind: 'cc' as const, title: '抄送申请人', x: 340, y: 312, nextIds: ['end'] },
      { id: 'end', kind: 'end' as const, title: '结束', x: 340, y: 408, nextIds: [] },
    ]
    const validation = validateWorkflowFlow(flow)
    expect(validation).toEqual({ valid: true, errors: [] })

    const created = saveApprovalWorkflow(db, 'c1', 'tester', {
      name: '自由连线流程',
      description: '任意出线与汇合',
      flow,
    })
    expect(created.status).toBe('draft')
    const reloaded = getApprovalWorkflow(db, 'c1', created.id)
    const condition = reloaded.flow.find((node) => node.id === 'cond')
    expect(condition?.nextIds).toEqual(['a_high', 'a_low'])
    expect(condition?.edgeLabels).toEqual({ a_high: '高危权限', a_low: '其他情况' })
    expect(condition?.edgeRules).toEqual({
      a_high: { field: 'scopeRisk', op: 'eq', value: 'high' },
      a_low: { field: 'else' },
    })
    expect(condition?.edgePorts).toEqual({
      a_high: { from: 'left', to: 'right' },
      a_low: { from: 'right', to: 'left' },
    })
    expect(reloaded.flow.find((node) => node.id === 'start')?.edgePorts).toEqual({
      cond: { from: 'bottom', to: 'top' },
    })
    const published = publishApprovalWorkflow(db, 'c1', 'tester', created.id, flow)
    expect(published.status).toBe('published')
    expect(published.version).toBe(1)
  })

  it('连线端口必须是已存在的出线且方向合法', () => {
    const base = [
      { id: 'start', kind: 'start' as const, title: '发起申请', nextIds: ['a1'], edgePorts: { a1: { from: 'right', to: 'left' } } },
      { id: 'a1', kind: 'approval' as const, title: '管理员审批', meta: '或签', nextIds: ['end'] },
      { id: 'end', kind: 'end' as const, title: '结束', nextIds: [] },
    ]
    expect(validateWorkflowFlow(base)).toEqual({ valid: true, errors: [] })

    const danglingPort = base.map((node) =>
      node.id === 'start' ? { ...node, edgePorts: { missing: { from: 'right' } } } : node,
    )
    const invalidSide = base.map((node) =>
      node.id === 'start' ? { ...node, edgePorts: { a1: { from: 'center' } } } : node,
    )
    expect(validateWorkflowFlow(danglingPort).errors.join(' ')).toContain('连线端口指向不存在的出线')
    expect(validateWorkflowFlow(invalidSide).errors.join(' ')).toContain('端口方向不合法')
  })

  it('自由连线发布前拦截成环、悬空、不可达与非法出线数量', () => {
    const base = [
      { id: 'start', kind: 'start' as const, title: '发起申请', nextIds: ['cond'] },
      {
        id: 'cond',
        kind: 'condition' as const,
        title: '风险判断',
        nextIds: ['a1', 'a2'],
        edgeLabels: { a1: '高危', a2: '其他' },
        edgeRules: { a1: { field: 'scopeRisk', op: 'eq', value: 'high' }, a2: { field: 'else' } },
      },
      { id: 'a1', kind: 'approval' as const, title: '管理员审批', meta: '或签', nextIds: ['end'] },
      { id: 'a2', kind: 'approval' as const, title: '负责人审批', meta: '或签', nextIds: ['end'] },
      { id: 'end', kind: 'end' as const, title: '结束', nextIds: [] },
    ]
    expect(validateWorkflowFlow(base)).toEqual({ valid: true, errors: [] })

    const endToCc = [
      { id: 'start', kind: 'start' as const, title: '发起申请', nextIds: ['a1'] },
      { id: 'a1', kind: 'approval' as const, title: '管理员审批', meta: '或签', nextIds: ['end'] },
      { id: 'end', kind: 'end' as const, title: '结束', nextIds: ['cc'] },
      { id: 'cc', kind: 'cc' as const, title: '抄送审计员', nextIds: [] },
    ]
    expect(validateWorkflowFlow(endToCc)).toEqual({ valid: true, errors: [] })

    const cycle = base.map((node) => (node.id === 'a1' ? { ...node, nextIds: ['cond'] } : node))
    const dangling = base.map((node) => (node.id === 'a2' ? { ...node, nextIds: [] } : node))
    const illegal = base.map((node) => {
      if (node.id === 'start') return { ...node, nextIds: ['cond', 'end'] }
      if (node.id === 'end') return { ...node, nextIds: ['a1'] }
      return node
    })
    const unreachable = base.map((node) =>
      node.id === 'cond'
        ? { ...node, nextIds: ['a1'], edgeLabels: { a1: '高危' }, edgeRules: { a1: { field: 'scopeRisk', op: 'eq', value: 'high' } } }
        : node,
    )

    const errors = (flow: unknown[]) => validateWorkflowFlow(flow).errors.join(' ')
    expect(errors(cycle)).toContain('循环连线')
    expect(errors(dangling)).toContain('没有出线')
    expect(errors(illegal)).toContain('开始节点必须且只能有一条出线')
    expect(errors(illegal)).toContain('结束节点 end 只能连接到抄送节点')
    expect(errors(unreachable)).toContain('无法从开始节点到达')
  })
})
