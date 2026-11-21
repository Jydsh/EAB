import { afterEach, describe, expect, it } from 'vitest'
import type { Scope } from '@eab/domain'
import { migrate, openDatabase, type Db } from '@eab/storage'
import { actorFor, consoleActor } from '../src/session.js'
import { publishApprovalWorkflow, saveApprovalWorkflow } from '../src/approval-workflows.js'
import {
  cancelPermissionRequest,
  createPermissionRequest,
  decidePermissionRequest,
  expirePermissionRequests,
  getPermissionRequest,
  listCompanyPermissionRequests,
  listCurrentRoles,
  listPermissionRequests,
  listRequestableRoles,
  listRequestableScopes,
  PERMISSION_URGE_COOLDOWN_MS,
  planPermissionUrge,
  previewWorkflowNodeApprovers,
  recordPermissionUrge,
} from '../src/permission-approvals.js'

const dbs: Db[] = []

afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
})

function person(id: string, name: string, deptId: string) {
  return {
    id,
    name,
    title: null,
    avatar: null,
    deptId,
    deptPath: `/c1/${deptId}`,
    deptName: deptId,
    companyId: 'c1',
    companyName: '测试公司',
  }
}

function testDb(): Db {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  dbs.push(db)
  const now = Date.now()
  db.prepare(
    `INSERT INTO companies (id, name, slug, status, created_at)
     VALUES ('c1', '测试公司', 'test', 'active', ?)`,
  ).run(now)
  for (const [id, parent, manager, path] of [
    ['d0', null, 'u3', '/c1/d0'],
    ['d1', 'd0', 'u2', '/c1/d0/d1'],
    ['d2', 'd1', 'u1', '/c1/d0/d1/d2'],
  ] as const) {
    db.prepare(
      `INSERT INTO departments (id, company_id, parent_id, name, path, depth, manager_user_id, created_at)
       VALUES (?, 'c1', ?, ?, ?, 1, ?, ?)`,
    ).run(id, parent, id, path, manager, now)
  }
  for (const [id, name, dept] of [
    ['u1', '申请人', 'd2'],
    ['u2', '直属负责人', 'd1'],
    ['u3', '上级负责人', 'd0'],
    ['u4', '公司管理员', 'd0'],
    ['u5', '无关成员', 'd0'],
  ] as const) {
    db.prepare(
      `INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at)
       VALUES (?, 'c1', ?, ?, ?, 'active', ?, ?)`,
    ).run(id, dept, `/c1/${dept}`, name, now, now)
  }
  for (const [id, code, requestable] of [
    ['r-member', 'member', 0],
    ['r-kb', 'kb_admin', 1],
    ['r-auditor', 'auditor', 1],
    ['r-dept', 'dept_admin', 0],
    ['r-company', 'company_admin', 0],
    ['r-head', 'company_sub_admin', 0],
  ] as const) {
    db.prepare(
      `INSERT INTO roles (id, company_id, code, name, data_scope, builtin, requestable, created_at)
       VALUES (?, 'c1', ?, ?, 'company', 1, ?, ?)`,
    ).run(id, code, code, requestable, now)
  }
  const scope = db.prepare('INSERT INTO role_scopes (role_id, scope) VALUES (?, ?)')
  scope.run('r-member', 'chat:use')
  scope.run('r-member', 'approval:read')
  scope.run('r-kb', 'kb:admin')
  scope.run('r-auditor', 'audit:read')
  scope.run('r-auditor', 'service:status')
  scope.run('r-dept', 'approval:decide')
  scope.run('r-company', 'approval:decide')
  scope.run('r-company', 'authz:grant')
  scope.run('r-head', 'approval:decide')

  const grant = db.prepare(
    `INSERT INTO user_roles (user_id, role_id, granted_by, granted_at, expires_at)
     VALUES (?, ?, 'seed', ?, NULL)`,
  )
  grant.run('u1', 'r-member', now)
  grant.run('u2', 'r-dept', now)
  grant.run('u3', 'r-head', now)
  grant.run('u4', 'r-company', now)

  for (const target of ['kb:admin', 'audit:read']) {
    db.prepare(
      `INSERT INTO permission_approval_policies
         (id, company_id, target_type, target_key, max_levels, include_company_admin,
          timeout_hours, approver_strategy, fixed_approvers_json, created_by, created_at, updated_at)
       VALUES (?, 'c1', 'scope', ?, 3, 1, 72, 'dept_chain', NULL, 'seed', ?, ?)`,
    ).run(`pol-${target}`, target, now, now)
  }
  // 比 audit:read 更严格：4 级、24 小时；用于验证多权限合并时取最严策略。
  db.prepare(
    `INSERT INTO permission_approval_policies
       (id, company_id, target_type, target_key, max_levels, include_company_admin,
        timeout_hours, approver_strategy, fixed_approvers_json, created_by, created_at, updated_at)
     VALUES ('pol-service:status', 'c1', 'scope', 'service:status', 4, 1, 24, 'dept_chain', NULL, 'seed', ?, ?)`,
  ).run(now, now)
  return db
}

function actorOf(db: Db, id: string) {
  return actorFor(db, person(id, id, `d${id === 'u1' ? 2 : id === 'u2' ? 1 : 0}`))
}

function publishRoleFlow(db: Db, name: string, roleCode: string) {
  const workflow = saveApprovalWorkflow(db, 'c1', 'tester', {
    name,
    scopeMode: '按权限点',
    roleMode: '全部员工角色',
    flow: [
      { id: 'start', kind: 'start', title: '发起申请' },
      {
        id: 'a_role',
        kind: 'approval',
        title: '角色会签',
        meta: '会签',
        mode: '会签',
        source: 'role',
        roleCode,
      },
      { id: 'end', kind: 'end', title: '结束' },
    ],
  })
  return publishApprovalWorkflow(db, 'c1', 'tester', workflow.id)
}

function publishDeptChainFlow(
  db: Db,
  maxLevels: number,
  source: 'dept_chain' | 'manager' = 'dept_chain',
  fallbackAdmin?: boolean,
) {
  const workflow = saveApprovalWorkflow(db, 'c1', 'tester', {
    name: `部门负责人链-${source}-${maxLevels}级-${fallbackAdmin === false ? '无兜底' : '默认兜底'}`,
    scopeMode: '全部权限点',
    roleMode: '全部员工角色',
    flow: [
      { id: 'start', kind: 'start', title: '发起申请' },
      {
        id: 'a_dept',
        kind: 'approval',
        title: '部门负责人审批',
        meta: '依次审批',
        mode: '依次审批',
        source,
        ...(source === 'dept_chain' ? { maxLevels } : {}),
        ...(fallbackAdmin === undefined ? {} : { fallbackAdmin }),
      },
      { id: 'end', kind: 'end', title: '结束' },
    ],
  })
  return publishApprovalWorkflow(db, 'c1', 'tester', workflow.id)
}

describe('多级权限审批', () => {
  it('可申请角色只包含 requestable 且 scope 策略齐全的角色', () => {
    const db = testDb()
    const roles = listRequestableRoles(db, 'c1')
    expect(roles.map((role) => role.code)).toEqual(['auditor', 'kb_admin'])
    expect(roles.every((role) => role.applicable)).toBe(true)
    expect(roles[0]?.policy?.maxLevels).toBe(4)
  })

  it('默认审批链从直属负责人向上，跳过申请人，并以公司管理员兜底', () => {
    const db = testDb()
    const view = createPermissionRequest(db, actorOf(db, 'u1'), {
      roleCode: 'kb_admin',
      reason: '需要维护知识库',
      durationHours: 48,
    })
    expect(view.status).toBe('pending')
    expect(view.totalSteps).toBe(3)
    expect(view.steps.map((step) => step.approverUserId)).toEqual(['u2', 'u3', 'u4'])
    expect(view.steps[0]?.status).toBe('active')
    expect(view.steps[1]?.status).toBe('pending')
    expect(view.durationHours).toBe(48)
  })

  it('逐级同意到最后一层才授予角色，并记录到期时间', () => {
    const db = testDb()
    const now = Date.now()
    const created = createPermissionRequest(db, actorOf(db, 'u1'), { roleCode: 'kb_admin' })
    const first = decidePermissionRequest(db, actorOf(db, 'u2'), {
      requestId: created.id,
      decision: 'approve',
      now,
    })
    expect(first.status).toBe('pending')
    expect(first.currentStep).toBe(2)
    expect(first.steps[0]?.status).toBe('approved')
    expect(first.steps[1]?.status).toBe('active')
    expect(db.prepare(`SELECT 1 FROM permission_role_grants WHERE request_id = ?`).get(created.id)).toBeUndefined()

    const second = decidePermissionRequest(db, actorOf(db, 'u3'), {
      requestId: created.id,
      decision: 'approve',
      now,
    })
    expect(second.currentStep).toBe(3)
    expect(db.prepare(`SELECT 1 FROM permission_role_grants WHERE request_id = ?`).get(created.id)).toBeUndefined()

    const final = decidePermissionRequest(db, actorOf(db, 'u4'), {
      requestId: created.id,
      decision: 'approve',
      now,
    })
    expect(final.status).toBe('approved')
    expect(final.grantedRoleGrantId).toBeTruthy()
    expect(db.prepare(`SELECT COUNT(*) AS n FROM user_roles WHERE user_id = 'u1' AND role_id = 'r-kb'`).get()).toEqual({ n: 1 })
    const expires = db.prepare(`SELECT expires_at FROM user_roles WHERE user_id = 'u1' AND role_id = 'r-kb'`).get() as { expires_at: number }
    expect(expires.expires_at).toBe(now + 168 * 3_600_000)
    expect(getPermissionRequest(db, 'c1', created.id)?.status).toBe('approved')
  })

  it('拒绝当前步骤后其余步骤跳过，不写授权', () => {
    const db = testDb()
    const created = createPermissionRequest(db, actorOf(db, 'u1'), { roleCode: 'auditor' })
    const rejected = decidePermissionRequest(db, actorOf(db, 'u2'), {
      requestId: created.id,
      decision: 'reject',
      comment: '理由不充分',
    })
    expect(rejected.status).toBe('rejected')
    expect(rejected.steps.map((step) => step.status)).toEqual(['rejected', 'skipped', 'skipped'])
    expect(db.prepare(`SELECT 1 FROM permission_role_grants WHERE request_id = ?`).get(created.id)).toBeUndefined()
  })

  it('只有申请人本人能撤回，撤回后待办清空', () => {
    const db = testDb()
    const created = createPermissionRequest(db, actorOf(db, 'u1'), { roleCode: 'kb_admin' })
    expect(() => cancelPermissionRequest(db, actorOf(db, 'u2'), created.id)).toThrow(/只有申请人本人/)
    const cancelled = cancelPermissionRequest(db, actorOf(db, 'u1'), created.id)
    expect(cancelled.status).toBe('cancelled')
    expect(listPermissionRequests(db, actorOf(db, 'u2'), 'todo')).toHaveLength(0)
  })

  it('超过处理时限后被懒清扫为 expired', () => {
    const db = testDb()
    const now = Date.now()
    const created = createPermissionRequest(db, actorOf(db, 'u1'), { roleCode: 'kb_admin', now })
    expect(expirePermissionRequests(db, 'c1', now + 73 * 3_600_000)).toBe(1)
    expect(getPermissionRequest(db, 'c1', created.id, now + 73 * 3_600_000)?.status).toBe('expired')
    expect(listPermissionRequests(db, actorOf(db, 'u2'), 'todo', now + 73 * 3_600_000)).toHaveLength(0)
  })

  it('同一角色已有 pending 单时重复申请返回原单', () => {
    const db = testDb()
    const first = createPermissionRequest(db, actorOf(db, 'u1'), { roleCode: 'kb_admin' })
    const second = createPermissionRequest(db, actorOf(db, 'u1'), { roleCode: 'kb_admin' })
    expect(second.id).toBe(first.id)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM permission_requests`).get()).toEqual({ n: 1 })
  })

  it('权限点列表包含全部未拥有的已登记权限，未配置策略走默认链', () => {
    const db = testDb()
    const scopes = listRequestableScopes(db, actorOf(db, 'u1'))
    expect(scopes.map((scope) => scope.code)).not.toContain('approval:read')
    expect(scopes.map((scope) => scope.code)).not.toContain('chat:use')
    expect(scopes.length).toBeGreaterThan(3)
    const exportScope = scopes.find((scope) => scope.code === 'audit:export')
    expect(exportScope).toBeTruthy()
    expect(exportScope?.applicable).toBe(true)
    expect(exportScope?.policy?.maxLevels).toBe(3)
    expect(exportScope?.reason).toMatch(/默认审批链/)
    const configured = scopes.find((scope) => scope.code === 'kb:admin')
    expect(configured?.policy?.id).toBe('pol-kb:admin')
  })

  it('未单独配置策略的权限点可以提交，并按默认链建三步审批', () => {
    const db = testDb()
    const created = createPermissionRequest(db, actorOf(db, 'u1'), {
      scopeCodes: ['audit:export'],
      roleCode: 'member',
      reason: '导出审计记录',
    })
    expect(created.requestType).toBe('scope')
    expect(created.roleCode).toBe('member')
    expect(created.totalSteps).toBe(3)
    expect(db.prepare(`SELECT policy_id FROM permission_requests WHERE id = ?`).get(created.id)).toEqual({ policy_id: null })
  })

  it('默认审批链可持久化，未单独配置的权限按新默认策略建单', () => {
    const db = testDb()
    const now = Date.now()
    db.prepare(
      `INSERT INTO permission_approval_policies
         (id, company_id, target_type, target_key, max_levels, include_company_admin,
          timeout_hours, approver_strategy, fixed_approvers_json, created_by, created_at, updated_at)
       VALUES ('pol-default', 'c1', 'default', 'default', 2, 0, 24, 'dept_chain', NULL, 'seed', ?, ?)`,
    ).run(now, now)
    const exportScope = listRequestableScopes(db, actorOf(db, 'u1')).find((scope) => scope.code === 'audit:export')
    expect(exportScope?.policy?.id).toBe('pol-default')
    expect(exportScope?.policy?.maxLevels).toBe(2)
    expect(exportScope?.policy?.includeCompanyAdmin).toBe(false)
    expect(exportScope?.reason).toMatch(/默认审批链/)
    const created = createPermissionRequest(db, actorOf(db, 'u1'), {
      scopeCodes: ['audit:export'],
      roleCode: 'member',
      now,
    })
    expect(created.totalSteps).toBe(2)
    expect(created.steps.map((step) => step.approverUserId)).toEqual(['u2', 'u3'])
    expect(db.prepare(`SELECT policy_id FROM permission_requests WHERE id = ?`).get(created.id)).toEqual({ policy_id: 'pol-default' })
  })

  it('申请角色只接受当前身份拥有的角色，并作为申请单锚点与策略优先项', () => {
    const db = testDb()
    const now = Date.now()
    db.prepare(
      `INSERT INTO user_roles (user_id, role_id, granted_by, granted_at, expires_at)
       VALUES ('u1', 'r-auditor', 'seed', ?, NULL)`,
    ).run(now)
    db.prepare(
      `INSERT INTO permission_approval_policies
         (id, company_id, target_type, target_key, max_levels, include_company_admin,
          timeout_hours, approver_strategy, fixed_approvers_json, created_by, created_at, updated_at)
       VALUES ('pol-auditor', 'c1', 'role', 'auditor', 2, 1, 48, 'dept_chain', NULL, 'seed', ?, ?)`,
    ).run(now, now)
    expect(listCurrentRoles(db, actorOf(db, 'u1')).map((role) => role.code)).toEqual(['auditor', 'member'])
    expect(listCurrentRoles(db, actorOf(db, 'u1')).find((role) => role.code === 'auditor')?.policy?.id).toBe('pol-auditor')
    const created = createPermissionRequest(db, actorOf(db, 'u1'), {
      scopeCodes: ['kb:admin'],
      roleCode: 'auditor',
      now,
    })
    expect(created.roleCode).toBe('auditor')
    expect(created.roleName).toBe('auditor')
    expect(db.prepare(`SELECT policy_id FROM permission_requests WHERE id = ?`).get(created.id)).toEqual({ policy_id: 'pol-auditor' })
    expect(created.requestDeadline).toBe(now + 48 * 3_600_000)
    expect(() => createPermissionRequest(db, actorOf(db, 'u1'), {
      scopeCodes: ['kb:admin'],
      roleCode: 'company_admin',
    })).toThrow(/申请角色不属于当前身份/)
  })

  it('当前身份已经拥有的权限点不能重复申请', () => {
    const db = testDb()
    expect(() => createPermissionRequest(db, actorOf(db, 'u1'), {
      scopeCodes: ['chat:use'],
      roleCode: 'member',
    })).toThrow(/当前身份已经拥有权限/)
  })

  it('多权限合并成一张单，审批时限取所选权限中最严格的一条', () => {
    const db = testDb()
    const now = Date.now()
    const created = createPermissionRequest(db, actorOf(db, 'u1'), {
      scopeCodes: ['service:status', 'audit:read'],
      reason: '需要审计和运维状态',
      durationHours: 72,
      now,
    })
    expect(created.requestType).toBe('scope')
    expect(created.scopes).toEqual(['audit:read', 'service:status'])
    expect(created.roleCode).toBe('member')
    expect(created.totalSteps).toBe(3)
    expect(created.requestDeadline).toBe(now + 24 * 3_600_000)
  })

  it('权限点申请通过后只写 scope grant，不写角色授权；到期后读侧失效', () => {
    const db = testDb()
    const now = Date.now()
    const created = createPermissionRequest(db, actorOf(db, 'u1'), {
      scopeCodes: ['audit:read', 'service:status'],
      durationHours: 168,
      now,
    })
    for (const approver of ['u2', 'u3']) {
      decidePermissionRequest(db, actorOf(db, approver), { requestId: created.id, decision: 'approve', now })
    }
    const final = decidePermissionRequest(db, actorOf(db, 'u4'), {
      requestId: created.id,
      decision: 'approve',
      now,
    })
    expect(final.status).toBe('approved')
    expect(final.requestType).toBe('scope')
    expect(final.grantedRoleGrantId).toBeNull()
    expect(db.prepare(`SELECT COUNT(*) AS n FROM permission_role_grants WHERE request_id = ?`).get(created.id)).toEqual({ n: 0 })
    expect(db.prepare(`SELECT COUNT(*) AS n FROM permission_scope_grants WHERE request_id = ?`).get(created.id)).toEqual({ n: 2 })
    expect(db.prepare(`SELECT COUNT(*) AS n FROM user_roles WHERE user_id = 'u1'`).get()).toEqual({ n: 1 })

    const active = actorFor(db, person('u1', 'u1', 'd2'))
    expect(active.subject.scopes.has('audit:read' as Scope)).toBe(true)
    expect(active.subject.scopes.has('service:status' as Scope)).toBe(true)

    // 读侧按 expires_at 过滤；把两条临时授权改成已过期后，权限立即消失。
    db.prepare(`UPDATE permission_scope_grants SET expires_at = ? WHERE request_id = ?`).run(now - 1, created.id)
    const expired = actorFor(db, person('u1', 'u1', 'd2'))
    expect(expired.subject.scopes.has('audit:read' as Scope)).toBe(false)
    expect(expired.subject.scopes.has('service:status' as Scope)).toBe(false)
  })

  it('相同权限集合已有 pending 单时复用，不同集合另建单', () => {
    const db = testDb()
    const first = createPermissionRequest(db, actorOf(db, 'u1'), { scopeCodes: ['audit:read'] })
    const same = createPermissionRequest(db, actorOf(db, 'u1'), { scopeCodes: ['audit:read'] })
    const other = createPermissionRequest(db, actorOf(db, 'u1'), { scopeCodes: ['service:status'] })
    expect(same.id).toBe(first.id)
    expect(other.id).not.toBe(first.id)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM permission_requests`).get()).toEqual({ n: 2 })
  })

  it('多个固定审批人策略的审批人集合不一致时拒绝合并', () => {
    const db = testDb()
    db.prepare(
      `UPDATE permission_approval_policies
          SET approver_strategy = 'fixed_users', fixed_approvers_json = '["u2"]'
        WHERE target_type = 'scope' AND target_key = 'kb:admin'`,
    ).run()
    db.prepare(
      `UPDATE permission_approval_policies
          SET approver_strategy = 'fixed_users', fixed_approvers_json = '["u3"]'
        WHERE target_type = 'scope' AND target_key = 'audit:read'`,
    ).run()
    expect(() => createPermissionRequest(db, actorOf(db, 'u1'), {
      scopeCodes: ['kb:admin', 'audit:read'],
    })).toThrow(/审批策略不一致/)
  })

  it('平台控制台兜底审批按真实审批人落库，并能按公司列出待处理/全部', () => {
    const db = testDb()
    const created = createPermissionRequest(db, actorOf(db, 'u1'), { roleCode: 'auditor' })
    expect(listCompanyPermissionRequests(db, 'c1', 'todo').map((item) => item.id)).toContain(created.id)
    const decided = decidePermissionRequest(db, consoleActor(db, 'c1'), {
      requestId: created.id,
      decision: 'approve',
      platformOverride: true,
      eventKey: 'console-test-override',
    })
    expect(decided.currentStep).toBe(2)
    expect(decided.steps[0]?.status).toBe('approved')
    const decision = db
      .prepare(`SELECT approver_user_id FROM permission_request_decisions WHERE request_id = ?`)
      .get(created.id) as { approver_user_id: string }
    expect(decision.approver_user_id).toBe('u2')
    expect(listCompanyPermissionRequests(db, 'c1', 'all').map((item) => item.id)).toContain(created.id)
  })

  it('已发布的自定义流程会按节点顺序生成审批步骤', () => {
    const db = testDb()
    const workflow = saveApprovalWorkflow(db, 'c1', 'tester', {
      name: '导出权限两级审批',
      scopeMode: '按权限点',
      roleMode: '全部员工角色',
      flow: [
        { id: 'start', kind: 'start', title: '发起申请' },
        {
          id: 'a_lead',
          kind: 'approval',
          title: '直属负责人',
          meta: '或签',
          source: 'members',
          approvers: [{ id: 'u2', name: 'u2' }],
        },
        {
          id: 'a_owner',
          kind: 'approval',
          title: '公司管理员复核',
          meta: '依次审批',
          source: 'members',
          approvers: [{ id: 'u3', name: 'u3' }],
        },
        { id: 'end', kind: 'end', title: '结束' },
      ],
    })
    publishApprovalWorkflow(db, 'c1', 'tester', workflow.id)

    const created = createPermissionRequest(db, actorOf(db, 'u1'), {
      scopeCodes: ['audit:export'],
      roleCode: 'member',
    })
    expect(created.totalSteps).toBe(2)
    expect(created.steps.map((step) => step.approverUserId)).toEqual(['u2', 'u3'])
    expect(created.steps.map((step) => step.status)).toEqual(['active', 'pending'])
    expect(created.steps.map((step) => step.nodeTitle)).toEqual(['直属负责人', '公司管理员复核'])
  })

  it('部门负责人链一级从申请人上级开始，申请人本人是部门负责人时跳过本人', () => {
    const db = testDb()
    publishDeptChainFlow(db, 1)
    const created = createPermissionRequest(db, actorOf(db, 'u1'), { roleCode: 'kb_admin' })
    expect(created.totalSteps).toBe(1)
    expect(created.steps.map((step) => step.approverUserId)).toEqual(['u2'])
    expect(created.steps[0]?.nodeTitle).toBe('部门负责人审批')
  })

  it('部门负责人链按节点配置的级数逐级展开', () => {
    const db = testDb()
    publishDeptChainFlow(db, 2)
    const created = createPermissionRequest(db, actorOf(db, 'u1'), { roleCode: 'kb_admin' })
    expect(created.totalSteps).toBe(2)
    expect(created.steps.map((step) => step.approverUserId)).toEqual(['u2', 'u3'])
    expect(created.steps.map((step) => step.status)).toEqual(['active', 'pending'])
  })

  it('上级部门没有负责人且关闭兜底时跳过该级，继续读取更高层负责人', () => {
    const withoutFallback = testDb()
    withoutFallback.prepare(`UPDATE departments SET manager_user_id = NULL WHERE id = 'd1'`).run()
    publishDeptChainFlow(withoutFallback, 3, 'dept_chain', false)
    const skipped = createPermissionRequest(withoutFallback, actorOf(withoutFallback, 'u1'), {
      roleCode: 'kb_admin',
    })
    expect(skipped.totalSteps).toBe(1)
    expect(skipped.steps.map((step) => step.approverUserId)).toEqual(['u3'])

    const withFallback = testDb()
    withFallback.prepare(`UPDATE departments SET manager_user_id = NULL WHERE id = 'd1'`).run()
    publishDeptChainFlow(withFallback, 3, 'dept_chain', true)
    const filled = createPermissionRequest(withFallback, actorOf(withFallback, 'u1'), {
      roleCode: 'kb_admin',
    })
    expect(filled.totalSteps).toBe(2)
    expect(filled.steps.map((step) => step.approverUserId)).toEqual(['u3', 'u4'])

    const allEmpty = testDb()
    allEmpty
      .prepare(`UPDATE departments SET manager_user_id = NULL WHERE id IN ('d0', 'd1', 'd2')`)
      .run()
    publishDeptChainFlow(allEmpty, 3, 'dept_chain', false)
    expect(() =>
      createPermissionRequest(allEmpty, actorOf(allEmpty, 'u1'), { roleCode: 'kb_admin' }),
    ).toThrow(/没有可用审批人/)
  })

  it('设计器实人预览返回真实审批人链，并区分负责人与管理员兜底', () => {
    const db = testDb()
    const node = {
      id: 'a_dept',
      kind: 'approval' as const,
      title: '部门负责人审批',
      source: 'dept_chain' as const,
      mode: '依次审批',
      maxLevels: 3,
      fallbackAdmin: true,
    }
    const preview = previewWorkflowNodeApprovers(db, 'c1', node, 'u1')
    expect(preview.fallbackAdmin).toBe(true)
    expect(preview.people).toEqual([
      { id: 'u2', name: '直属负责人', kind: 'manager', deptName: 'd1', level: 2 },
      { id: 'u3', name: '上级负责人', kind: 'manager', deptName: 'd0', level: 3 },
      { id: 'u4', name: '公司管理员', kind: 'company_admin', deptName: '', level: 0 },
    ])
    expect(preview.skipped).toEqual([
      { level: 1, deptName: 'd2', name: '申请人', reason: 'self' },
    ])
    expect(
      previewWorkflowNodeApprovers(db, 'c1', { ...node, mode: '或签' }, 'u1').people.map((item) => item.id),
    ).toEqual(['u2'])
    expect(
      previewWorkflowNodeApprovers(db, 'c1', { ...node, fallbackAdmin: false }, 'u1').people.map((item) => item.id),
    ).toEqual(['u2', 'u3'])
  })

  it('实人预览会列出部门层级，并标明无负责人/无审批权限的跳过原因', () => {
    const db = testDb()
    // 直属部门无负责人，上级部门负责人没有审批权限，最上层负责人可用。
    db.prepare(`UPDATE departments SET manager_user_id = NULL WHERE id = 'd2'`).run()
    db.prepare(`UPDATE departments SET manager_user_id = 'u5' WHERE id = 'd1'`).run()
    const preview = previewWorkflowNodeApprovers(
      db,
      'c1',
      {
        id: 'a_dept',
        kind: 'approval',
        title: '部门负责人审批',
        source: 'dept_chain',
        mode: '依次审批',
        maxLevels: 3,
        fallbackAdmin: false,
      },
      'u1',
    )
    expect(preview.people).toEqual([
      { id: 'u3', name: '上级负责人', kind: 'manager', deptName: 'd0', level: 3 },
    ])
    expect(preview.skipped).toEqual([
      { level: 1, deptName: 'd2', name: null, reason: 'no_manager' },
      { level: 2, deptName: 'd1', name: '无关成员', reason: 'no_permission' },
    ])
  })

  it('未写 source 的旧审批节点按部门负责人链实人预览', () => {
    const db = testDb()
    const preview = previewWorkflowNodeApprovers(
      db,
      'c1',
      {
        id: 'a_legacy',
        kind: 'approval',
        title: '旧审批节点',
        mode: '依次审批',
        maxLevels: 2,
      },
      'u1',
    )
    expect(preview.source).toBe('dept_chain')
    expect(preview.levels).toBe(2)
    expect(preview.people.map((item) => item.id)).toEqual(['u2', 'u3'])
  })

  it('旧 manager 来源等价于部门负责人链 1 级', () => {
    const db = testDb()
    publishDeptChainFlow(db, 3, 'manager')
    const created = createPermissionRequest(db, actorOf(db, 'u1'), { roleCode: 'kb_admin' })
    expect(created.totalSteps).toBe(1)
    expect(created.steps.map((step) => step.approverUserId)).toEqual(['u2'])
  })

  it('催办只针对当前节点待处理人，30 分钟内重复催办被拒绝', () => {
    const db = testDb()
    const now = Date.now()
    const created = createPermissionRequest(db, actorOf(db, 'u1'), { roleCode: 'kb_admin', now })
    const plan = planPermissionUrge(db, actorOf(db, 'u1'), created.id, now)
    expect(plan.stepNo).toBe(1)
    expect(plan.nodeTitle).toBe('第 1 级审批')
    expect(plan.targets.map((target) => target.userId)).toEqual(['u2'])

    recordPermissionUrge(db, {
      companyId: 'c1',
      requestId: created.id,
      stepNo: plan.stepNo,
      fromUserId: 'u1',
      toUserIds: plan.targets.map((target) => target.userId),
      deliveredCount: 1,
      failedCount: 0,
      now,
    })
    const view = getPermissionRequest(db, 'c1', created.id)!
    expect(view.urge.count).toBe(1)
    expect(view.urge.lastAt).toBe(now)
    expect(view.urge.nextAt).toBe(now + PERMISSION_URGE_COOLDOWN_MS)

    expect(() => planPermissionUrge(db, actorOf(db, 'u1'), created.id, now + 60_000)).toThrow(/刚刚催办过/)
    // 当前节点只有一位审批人时，审批人自己没有可催的对象。
    expect(() => planPermissionUrge(db, actorOf(db, 'u2'), created.id, now + 60_000)).toThrow(/只有你一位/)
    // 无关成员不能催办。
    expect(() => planPermissionUrge(db, actorOf(db, 'u5'), created.id, now + 60_000)).toThrow(/只有申请人或当前节点审批人/)

    const later = planPermissionUrge(db, actorOf(db, 'u1'), created.id, now + PERMISSION_URGE_COOLDOWN_MS + 1)
    expect(later.nextUrgeAt).toBe(now + PERMISSION_URGE_COOLDOWN_MS * 2 + 1)
  })

  it('会签节点审批人可以催同节点其他审批人，但不能催自己', () => {
    const db = testDb()
    const now = Date.now()
    db.prepare(
      `INSERT INTO user_roles (user_id, role_id, granted_by, granted_at, expires_at)
       VALUES ('u2', 'r-head', 'seed', ?, NULL)`,
    ).run(now)
    db.prepare(
      `INSERT INTO user_roles (user_id, role_id, granted_by, granted_at, expires_at)
       VALUES ('u5', 'r-head', 'seed', ?, NULL)`,
    ).run(now)
    const workflow = saveApprovalWorkflow(db, 'c1', 'tester', {
      name: '催办会签流程',
      scopeMode: '按权限点',
      roleMode: '全部员工角色',
      flow: [
        { id: 'start', kind: 'start', title: '发起申请' },
        {
          id: 'a_role',
          kind: 'approval',
          title: '角色会签',
          meta: '会签',
          mode: '会签',
          source: 'role',
          roleCode: 'company_sub_admin',
        },
        { id: 'end', kind: 'end', title: '结束' },
      ],
    })
    publishApprovalWorkflow(db, 'c1', 'tester', workflow.id)
    const created = createPermissionRequest(db, actorOf(db, 'u1'), {
      scopeCodes: ['audit:export'],
      roleCode: 'member',
      now,
    })
    expect(created.steps.filter((step) => step.stepNo === 1).map((step) => step.nodeTitle)).toEqual(['角色会签', '角色会签', '角色会签'])

    const plan = planPermissionUrge(db, actorOf(db, 'u2'), created.id, now)
    expect(plan.targets.map((target) => target.userId)).toEqual(['u3', 'u5'])
  })

  it('指定角色把全部成员放进同一步骤会签，全部同意后才进入下一节点', () => {
    const db = testDb()
    const now = Date.now()
    const grant = db.prepare(
      `INSERT INTO user_roles (user_id, role_id, granted_by, granted_at, expires_at)
       VALUES (?, 'r-head', 'seed', ?, NULL)`,
    )
    grant.run('u2', now)
    grant.run('u5', now)
    const workflow = saveApprovalWorkflow(db, 'c1', 'tester', {
      name: '角色会签流程',
      scopeMode: '按权限点',
      roleMode: '全部员工角色',
      flow: [
        { id: 'start', kind: 'start', title: '发起申请' },
        {
          id: 'a_role',
          kind: 'approval',
          title: '角色会签',
          meta: '会签',
          mode: '会签',
          source: 'role',
          roleCode: 'company_sub_admin',
          roleName: 'company_sub_admin',
        },
        {
          id: 'a_admin',
          kind: 'approval',
          title: '管理员复核',
          meta: '或签',
          source: 'members',
          approvers: [{ id: 'u4', name: 'u4' }],
        },
        { id: 'end', kind: 'end', title: '结束' },
      ],
    })
    publishApprovalWorkflow(db, 'c1', 'tester', workflow.id)

    const created = createPermissionRequest(db, actorOf(db, 'u1'), {
      scopeCodes: ['audit:export'],
      roleCode: 'member',
    })
    expect(created.totalSteps).toBe(2)
    const roleSteps = created.steps.filter((step) => step.stepNo === 1)
    expect(roleSteps).toHaveLength(3)
    expect(new Set(roleSteps.map((step) => step.approverUserId))).toEqual(new Set(['u2', 'u3', 'u5']))
    expect(roleSteps.every((step) => step.status === 'active')).toBe(true)
    for (const userId of ['u2', 'u3', 'u5']) {
      expect(listPermissionRequests(db, actorOf(db, userId), 'todo').map((item) => item.id)).toContain(created.id)
    }

    const first = decidePermissionRequest(db, actorOf(db, 'u2'), {
      requestId: created.id,
      stepNo: 1,
      decision: 'approve',
      eventKey: 'role-approve-u2',
    })
    expect(first.status).toBe('pending')
    expect(first.currentStep).toBe(1)
    expect(first.steps.filter((step) => step.stepNo === 1).find((step) => step.approverUserId === 'u2')?.status).toBe('approved')
    expect(first.steps.filter((step) => step.stepNo === 1).filter((step) => step.status === 'active')).toHaveLength(2)
    expect(() =>
      decidePermissionRequest(db, actorOf(db, 'u2'), {
        requestId: created.id,
        stepNo: 1,
        decision: 'approve',
        eventKey: 'role-approve-u2-again',
      }),
    ).toThrow(/等待同节点其他审批人/)

    const second = decidePermissionRequest(db, actorOf(db, 'u3'), {
      requestId: created.id,
      stepNo: 1,
      decision: 'approve',
      eventKey: 'role-approve-u3',
    })
    expect(second.status).toBe('pending')
    expect(second.currentStep).toBe(1)

    const third = decidePermissionRequest(db, actorOf(db, 'u5'), {
      requestId: created.id,
      stepNo: 1,
      decision: 'approve',
      eventKey: 'role-approve-u5',
    })
    expect(third.status).toBe('pending')
    expect(third.currentStep).toBe(2)
    expect(third.steps.filter((step) => step.stepNo === 1).every((step) => step.status === 'approved')).toBe(true)
    expect(third.steps.find((step) => step.stepNo === 2)?.status).toBe('active')

    const final = decidePermissionRequest(db, actorOf(db, 'u4'), {
      requestId: created.id,
      stepNo: 2,
      decision: 'approve',
      eventKey: 'role-final-u4',
    })
    expect(final.status).toBe('approved')
    const decisions = db
      .prepare('SELECT COUNT(*) AS count FROM permission_request_decisions WHERE request_id = ?')
      .get(created.id) as { count: number }
    expect(decisions.count).toBe(4)
    const grants = db
      .prepare('SELECT COUNT(*) AS count FROM permission_scope_grants WHERE request_id = ?')
      .get(created.id) as { count: number }
    expect(grants.count).toBe(1)
  })

  it('角色会签中任意一人拒绝时整单拒绝，同组和后续步骤跳过', () => {
    const db = testDb()
    const now = Date.now()
    db.prepare(
      `INSERT INTO user_roles (user_id, role_id, granted_by, granted_at, expires_at)
       VALUES ('u2', 'r-head', 'seed', ?, NULL)`,
    ).run(now)
    const workflow = saveApprovalWorkflow(db, 'c1', 'tester', {
      name: '角色会签拒绝流程',
      scopeMode: '按权限点',
      roleMode: '全部员工角色',
      flow: [
        { id: 'start', kind: 'start', title: '发起申请' },
        {
          id: 'a_role',
          kind: 'approval',
          title: '角色会签',
          meta: '会签',
          mode: '会签',
          source: 'role',
          roleCode: 'company_sub_admin',
        },
        { id: 'end', kind: 'end', title: '结束' },
      ],
    })
    publishApprovalWorkflow(db, 'c1', 'tester', workflow.id)

    const created = createPermissionRequest(db, actorOf(db, 'u1'), {
      scopeCodes: ['audit:export'],
      roleCode: 'member',
    })
    expect(created.steps).toHaveLength(2)
    const approved = decidePermissionRequest(db, actorOf(db, 'u2'), {
      requestId: created.id,
      stepNo: 1,
      decision: 'approve',
      eventKey: 'role-reject-u2',
    })
    expect(approved.status).toBe('pending')
    const rejected = decidePermissionRequest(db, actorOf(db, 'u3'), {
      requestId: created.id,
      stepNo: 1,
      decision: 'reject',
      eventKey: 'role-reject-u3',
    })
    expect(rejected.status).toBe('rejected')
    expect(rejected.steps.find((step) => step.approverUserId === 'u2')?.status).toBe('approved')
    expect(rejected.steps.find((step) => step.approverUserId === 'u3')?.status).toBe('rejected')
    const grants = db
      .prepare('SELECT COUNT(*) AS count FROM permission_scope_grants WHERE request_id = ?')
      .get(created.id) as { count: number }
    expect(grants.count).toBe(0)
  })

  it('角色不存在、角色为空、仅有申请人和成员缺审批权限时拒绝建单', () => {
    const cases = [
      {
        roleCode: 'missing_role',
        seed: () => {},
        message: /角色不存在/,
      },
      {
        roleCode: 'kb_admin',
        seed: () => {},
        message: /没有可审批成员/,
      },
      {
        roleCode: 'kb_admin',
        seed: (db: Db) => {
          db.prepare(
            `INSERT INTO user_roles (user_id, role_id, granted_by, granted_at, expires_at)
             VALUES ('u1', 'r-kb', 'seed', ?, NULL)`,
          ).run(Date.now())
        },
        message: /没有可审批成员/,
      },
      {
        roleCode: 'auditor',
        seed: (db: Db) => {
          db.prepare(
            `INSERT INTO user_roles (user_id, role_id, granted_by, granted_at, expires_at)
             VALUES ('u5', 'r-auditor', 'seed', ?, NULL)`,
          ).run(Date.now())
        },
        message: /缺少「审批决定」权限/,
      },
    ]
    for (const [index, item] of cases.entries()) {
      const db = testDb()
      item.seed(db)
      publishRoleFlow(db, `角色建单校验 ${index}`, item.roleCode)
      expect(() =>
        createPermissionRequest(db, actorOf(db, 'u1'), {
          scopeCodes: ['audit:export'],
          roleCode: 'member',
        }),
      ).toThrow(item.message)
    }
  })

  it('自由连线流程按条件出线选择审批分支', () => {
    const db = testDb()
    const workflow = saveApprovalWorkflow(db, 'c1', 'tester', {
      name: '高危权限分流审批',
      scopeMode: '按权限点',
      roleMode: '全部员工角色',
      flow: [
        { id: 'start', kind: 'start', title: '发起申请', nextIds: ['cond_risk'] },
        {
          id: 'cond_risk',
          kind: 'condition',
          title: '是否高危',
          nextIds: ['a_high', 'a_low'],
          edgeLabels: { a_high: '包含高危权限', a_low: '仅普通权限' },
          edgeRules: {
            a_high: { field: 'scopeRisk', op: 'eq', value: 'high' },
            a_low: { field: 'else', op: 'eq', value: '' },
          },
        },
        {
          id: 'a_high',
          kind: 'approval',
          title: '高危审批',
          meta: '或签',
          source: 'members',
          approvers: [{ id: 'u3', name: 'u3' }],
          nextIds: ['end'],
        },
        {
          id: 'a_low',
          kind: 'approval',
          title: '普通审批',
          meta: '或签',
          source: 'members',
          approvers: [{ id: 'u2', name: 'u2' }],
          nextIds: ['end'],
        },
        { id: 'end', kind: 'end', title: '结束' },
      ],
    })
    publishApprovalWorkflow(db, 'c1', 'tester', workflow.id)

    const created = createPermissionRequest(db, actorOf(db, 'u1'), {
      scopeCodes: ['audit:export'],
      roleCode: 'member',
    })
    expect(created.totalSteps).toBe(1)
    expect(created.steps.map((step) => step.approverUserId)).toEqual(['u3'])
  })
})
