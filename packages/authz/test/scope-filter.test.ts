import { describe, expect, it } from 'vitest'
import { assertScoped, buildScopeFilter, evaluatePredicate } from '@eab/authz'
import { ALL_SCOPES, SC, type EntityKind } from '@eab/domain'
import { COLLECTIONS, COMPANY, subject } from './fixtures.js'

const member = subject()
const deptAdmin = subject({ roles: ['dept_admin'] })
const companyAdmin = subject({ roles: ['company_admin'] })
const globalAdmin = subject({ roles: ['super_admin'] })
const disabled = subject({ status: 'disabled' })

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  company_id: COMPANY,
  ...over,
})

describe('buildScopeFilter：普通员工（self）', () => {
  const filter = buildScopeFilter(member, SC.CHAT_HISTORY_READ, 'conversation')

  it('命中自己的会话', () => {
    expect(evaluatePredicate(filter.predicate, row({ owner_user_id: 'u1', scope_type: 'user', scope_id: 'u1' }))).toBe(true)
  })

  it('不命中同事的会话', () => {
    expect(evaluatePredicate(filter.predicate, row({ owner_user_id: 'u2', scope_type: 'user', scope_id: 'u2' }))).toBe(false)
  })

  it('命中本部门共享会话', () => {
    expect(evaluatePredicate(filter.predicate, row({ owner_user_id: undefined, scope_type: 'dept', scope_id: 'd10' }))).toBe(true)
  })

  it('不命中他部门共享会话', () => {
    expect(evaluatePredicate(filter.predicate, row({ scope_type: 'dept', scope_id: 'd20' }))).toBe(false)
  })

  it('不命中其他公司（哪怕字段看起来一样）', () => {
    expect(
      evaluatePredicate(filter.predicate, { company_id: 'c2', owner_user_id: 'u1', scope_type: 'user', scope_id: 'u1' }),
    ).toBe(false)
  })
})

describe('buildScopeFilter：部门管理员', () => {
  it('人员列表向"下级"展开（deptMode=down）', () => {
    const filter = buildScopeFilter(deptAdmin, SC.ORG_MEMBER_READ, 'user')
    expect(evaluatePredicate(filter.predicate, row({ dept_path: '/c1/d10/', id: 'u9' }))).toBe(true)
    expect(evaluatePredicate(filter.predicate, row({ dept_path: '/c1/d10/d23/', id: 'u9' }))).toBe(true)
    expect(evaluatePredicate(filter.predicate, row({ dept_path: '/c1/d20/', id: 'u9' }))).toBe(false)
  })

  it('知识检索（读）由知识库 ACL 决定，不再叠加部门范围', () => {
    const filter = buildScopeFilter(deptAdmin, SC.KB_READ, 'kb_chunk', { collections: COLLECTIONS })
    // 部门管理员的 dept 范围不影响"全员可见"的知识库
    expect(
      evaluatePredicate(filter.predicate, row({ collection_id: 'kb_all', classification: 'internal' }))
    ).toBe(true)
    // 角色命中的知识库可见
    expect(
      evaluatePredicate(filter.predicate, row({ collection_id: 'kb_admin_only', classification: 'internal' }))
    ).toBe(true)
    // 兄弟部门的库仍然不可见
    expect(
      evaluatePredicate(filter.predicate, row({ collection_id: 'kb_d20', classification: 'internal' }))
    ).toBe(false)
  })

  it('项目成员可看项目共享文件', () => {
    const pm = subject({ roles: ['dept_admin'], projectIds: ['p1'] })
    const filter = buildScopeFilter(pm, SC.WORKSPACE_READ, 'file')
    expect(evaluatePredicate(filter.predicate, row({ scope_type: 'project', scope_id: 'p1' }))).toBe(true)
    expect(evaluatePredicate(filter.predicate, row({ scope_type: 'project', scope_id: 'p2' }))).toBe(false)
  })
})

describe('知识库可见范围（知识类读操作）', () => {
  const context = { collections: COLLECTIONS }
  const filter = buildScopeFilter(member, SC.KB_READ, 'kb_chunk', context)
  const kbRow = (over: Record<string, unknown>) =>
    row({ company_id: COMPANY, classification: 'internal', ...over })

  it('配了"全员可见"的库，普通员工能查到', () => {
    expect(evaluatePredicate(filter.predicate, kbRow({ collection_id: 'kb_all' }))).toBe(true)
  })

  it('配了"本部门可见"的库能查到，兄弟部门的查不到', () => {
    expect(evaluatePredicate(filter.predicate, kbRow({ collection_id: 'kb_d10' }))).toBe(true)
    expect(evaluatePredicate(filter.predicate, kbRow({ collection_id: 'kb_d20' }))).toBe(false)
  })

  it('配了"仅某些角色"的库，普通员工查不到', () => {
    expect(evaluatePredicate(filter.predicate, kbRow({ collection_id: 'kb_admin_only' }))).toBe(false)
  })

  it('别人的个人库查不到', () => {
    expect(evaluatePredicate(filter.predicate, kbRow({ collection_id: 'kb_private_u1' }))).toBe(true)
    expect(evaluatePredicate(filter.predicate, kbRow({ collection_id: 'kb_private_u2' }))).toBe(false)
  })

  it('非知识库管理员查不到机密切片（与 PDP 一致，避免"列表里有、点开被拒"）', () => {
    expect(
      evaluatePredicate(filter.predicate, kbRow({ collection_id: 'kb_all', classification: 'confidential' }))
    ).toBe(false)
  })

  it('其他公司的切片永远查不到', () => {
    expect(evaluatePredicate(filter.predicate, kbRow({ company_id: 'c2', collection_id: 'kb_all' }))).toBe(false)
  })

  it('没传可见范围配置时是空集（fail-closed）', () => {
    const noContext = buildScopeFilter(member, SC.KB_READ, 'kb_chunk')
    expect(noContext.predicate.kind).toBe('false')
    expect(noContext.reason).toContain('kb-acl')
  })
})

describe('安全不变量', () => {
  it('非 global 主体在任何实体上都拿不到"无限制"谓词', () => {
    const entities: EntityKind[] = [
      'company', 'dept', 'user', 'conversation', 'file', 'kb_doc', 'kb_chunk', 'plugin', 'approval', 'audit', 'memory',
    ]
    for (const entity of entities) {
      const filter = buildScopeFilter(member, SC.CHAT_USE, entity)
      expect(filter.predicate.kind, `${entity} 不应为无限制`).not.toBe('true')
      expect(() => assertScoped(filter, member)).not.toThrow()
    }
  })

  it('global 主体本公司内无限制，但不跨公司（多公司共用一个平台）', () => {
    const filter = buildScopeFilter(globalAdmin, SC.AUDIT_READ, 'audit')
    expect(filter.predicate.kind).not.toBe('true')
    expect(filter.reason).toBe('global-scope:company')
    expect(evaluatePredicate(filter.predicate, row({ company_id: globalAdmin.companyId }))).toBe(true)
    expect(evaluatePredicate(filter.predicate, row({ company_id: 'c2' }))).toBe(false)
    expect(() => assertScoped(filter, globalAdmin)).not.toThrow()
  })

  it('assertScoped 会拦住"非 global 却无限制"的越权过滤器', () => {
    expect(() => assertScoped({ entity: 'user', action: SC.ORG_MEMBER_READ, predicate: { kind: 'true' }, reason: 'bug' }, member)).toThrow()
  })

  it('禁用账号得到空集（查不到而不是报错，避免探测）', () => {
    const filter = buildScopeFilter(disabled, SC.CHAT_HISTORY_READ, 'conversation')
    expect(filter.predicate.kind).toBe('false')
    expect(evaluatePredicate(filter.predicate, row({ owner_user_id: 'u1' }))).toBe(false)
  })

  it('公司管理员只看本公司，不是全库', () => {
    const filter = buildScopeFilter(companyAdmin, SC.ORG_MEMBER_READ, 'user')
    expect(evaluatePredicate(filter.predicate, row({ id: 'u2' }))).toBe(true)
    expect(evaluatePredicate(filter.predicate, { company_id: 'c2', id: 'u3' })).toBe(false)
  })

  it('功能权限不具备时直接给空集（不给仓储层"看似合法"的过滤器）', () => {
    const filter = buildScopeFilter(member, SC.ORG_MEMBER_READ, 'user')
    expect(filter.reason).toBe('missing-scope')
    expect(filter.predicate.kind).toBe('false')
  })

  it('所有已登记 scope 都能构建过滤器而不抛错', () => {
    for (const scope of ALL_SCOPES) {
      expect(() => buildScopeFilter(member, scope, 'conversation')).not.toThrow()
    }
  })
})
