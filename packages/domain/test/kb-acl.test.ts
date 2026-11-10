import { describe, expect, it } from 'vitest'
import {
  SC,
  isCollectionVisible,
  resolveVisibleCollections,
  type KbCollectionAcl,
  type Subject,
} from '@eab/domain'

function subject(over: Partial<Subject> = {}): Subject {
  return {
    userId: 'u1',
    companyId: 'c1',
    deptId: 'd10',
    deptPath: '/c1/d10/',
    deptChain: ['/c1/', '/c1/d10/'],
    roles: ['member'],
    scopes: new Set([SC.KB_READ]),
    dataScope: 'self',
    channelType: 'web',
    status: 'active',
    projectIds: [],
    ...over,
  }
}

function acl(over: Partial<KbCollectionAcl> = {}): KbCollectionAcl {
  return { collectionId: 'col1', companyId: 'c1', mode: 'all', ...over }
}

const member = subject()
const deptAdmin = subject({ roles: ['dept_admin'] })

describe('知识库可见范围：全员', () => {
  it('同公司任何角色都可见', () => {
    expect(isCollectionVisible(acl({ mode: 'all' }), member)).toBe(true)
    expect(isCollectionVisible(acl({ mode: 'all' }), deptAdmin)).toBe(true)
  })

  it('跨公司不可见（哪怕配了 all）', () => {
    expect(isCollectionVisible(acl({ mode: 'all', companyId: 'c2' }), member)).toBe(false)
  })

  it('禁用账号不可见', () => {
    expect(isCollectionVisible(acl({ mode: 'all' }), subject({ status: 'disabled' }))).toBe(false)
  })
})

describe('知识库可见范围：按角色', () => {
  it('命中角色才可见', () => {
    expect(isCollectionVisible(acl({ mode: 'roles', roleCodes: ['member', 'kb_admin'] }), member)).toBe(true)
    expect(isCollectionVisible(acl({ mode: 'roles', roleCodes: ['dept_admin'] }), member)).toBe(false)
  })

  it('空角色列表 = 谁都看不见（不猜）', () => {
    expect(isCollectionVisible(acl({ mode: 'roles', roleCodes: [] }), member)).toBe(false)
    expect(isCollectionVisible(acl({ mode: 'roles' }), member)).toBe(false)
  })
})

describe('知识库可见范围：按部门', () => {
  it('授权部门包含其下级', () => {
    const a = acl({ mode: 'depts', deptPaths: ['/c1/d10/'] })
    expect(isCollectionVisible(a, member)).toBe(true)
    expect(isCollectionVisible(a, subject({ deptId: 'd23', deptPath: '/c1/d10/d23/' }))).toBe(true)
  })

  it('兄弟部门不可见', () => {
    const a = acl({ mode: 'depts', deptPaths: ['/c1/d10/'] })
    expect(isCollectionVisible(a, subject({ deptId: 'd20', deptPath: '/c1/d20/' }))).toBe(false)
  })

  it('只授权子部门时，上级部门成员不可见（方向不能反）', () => {
    const a = acl({ mode: 'depts', deptPaths: ['/c1/d10/d23/'] })
    expect(isCollectionVisible(a, member)).toBe(false)
    expect(isCollectionVisible(a, subject({ deptId: 'd23', deptPath: '/c1/d10/d23/' }))).toBe(true)
  })

  it('授权到公司根 = 全员', () => {
    expect(isCollectionVisible(acl({ mode: 'depts', deptPaths: ['/c1/'] }), member)).toBe(true)
  })
})

describe('知识库可见范围：个人库', () => {
  it('仅所有者可见', () => {
    expect(isCollectionVisible(acl({ mode: 'private', ownerUserId: 'u1' }), member)).toBe(true)
    expect(isCollectionVisible(acl({ mode: 'private', ownerUserId: 'u2' }), member)).toBe(false)
  })

  it('没写所有者 = 谁都看不见', () => {
    expect(isCollectionVisible(acl({ mode: 'private' }), member)).toBe(false)
  })
})

describe('resolveVisibleCollections', () => {
  it('只返回可见的知识库 ID 集合', () => {
    const collections: KbCollectionAcl[] = [
      acl({ collectionId: 'all_kb', mode: 'all' }),
      acl({ collectionId: 'role_kb', mode: 'roles', roleCodes: ['dept_admin'] }),
      acl({ collectionId: 'dept_kb', mode: 'depts', deptPaths: ['/c1/d10/'] }),
      acl({ collectionId: 'other_dept_kb', mode: 'depts', deptPaths: ['/c1/d20/'] }),
      acl({ collectionId: 'other_company_kb', companyId: 'c2', mode: 'all' }),
    ]
    expect([...resolveVisibleCollections(member, collections)].sort()).toEqual(['all_kb', 'dept_kb'])
    expect([...resolveVisibleCollections(deptAdmin, collections)].sort()).toEqual([
      'all_kb',
      'dept_kb',
      'role_kb',
    ])
  })

  it('空配置得到空集合（不是全放行）', () => {
    expect(resolveVisibleCollections(member, []).size).toBe(0)
  })
})
