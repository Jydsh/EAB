import { buildSubject, type BuildSubjectInput } from '@eab/authz'
import type { KbCollectionAcl, ResourceRef } from '@eab/domain'

export const COMPANY = 'c1'

/** 造一个 Subject。默认是"普通员工 u1，属于部门 d10"。 */
export function subject(over: Partial<BuildSubjectInput> = {}) {
  const input: BuildSubjectInput = {
    userId: 'u1',
    companyId: COMPANY,
    deptId: 'd10',
    deptPath: '/c1/d10/',
    roles: ['member'],
    ...over,
  }
  return buildSubject(input)
}

/** 造一个 ResourceRef。默认是"本公司、u1 的个人资源"。 */
export function ref(over: Partial<ResourceRef> & Pick<ResourceRef, 'kind' | 'id'>): ResourceRef {
  return {
    companyId: COMPANY,
    scopeType: 'user',
    scopeId: 'u1',
    ownerId: 'u1',
    ...over,
  }
}

/** 知识库可见范围样本：覆盖四种模式 */
export const COLLECTIONS: readonly KbCollectionAcl[] = [
  { collectionId: 'kb_all', companyId: COMPANY, mode: 'all' },
  { collectionId: 'kb_d10', companyId: COMPANY, mode: 'depts', deptPaths: ['/c1/d10/'] },
  { collectionId: 'kb_d20', companyId: COMPANY, mode: 'depts', deptPaths: ['/c1/d20/'] },
  { collectionId: 'kb_admin_only', companyId: COMPANY, mode: 'roles', roleCodes: ['dept_admin', 'kb_admin'] },
  { collectionId: 'kb_private_u1', companyId: COMPANY, mode: 'private', ownerUserId: 'u1' },
  { collectionId: 'kb_private_u2', companyId: COMPANY, mode: 'private', ownerUserId: 'u2' },
]

export function collection(id: string): KbCollectionAcl {
  const found = COLLECTIONS.find((item) => item.collectionId === id)
  if (!found) throw new Error(`未定义的测试知识库: ${id}`)
  return found
}

function kbRef(id: string, collectionId: string, over: Partial<ResourceRef> = {}): ResourceRef {
  return ref({
    kind: 'kb_doc',
    id,
    scopeType: 'company',
    scopeId: COMPANY,
    ownerId: undefined,
    collectionId,
    collectionAcl: collection(collectionId),
    ...over,
  })
}

export const ownFile = ref({ kind: 'file', id: 'f_own' })
export const peerFile = ref({ kind: 'file', id: 'f_peer', scopeId: 'u2', ownerId: 'u2' })
/** 本部门知识库（depts: /c1/d10/） */
export const ownDeptKb = kbRef('kb_doc_d10', 'kb_d10')
/** 兄弟部门知识库（depts: /c1/d20/） */
export const siblingDeptKb = kbRef('kb_doc_d20', 'kb_d20')
/** 公司级知识库（all：全员可见） */
export const companyKb = kbRef('kb_doc_all', 'kb_all')
/** 仅部门管理员可见 */
export const adminOnlyKb = kbRef('kb_doc_admin', 'kb_admin_only')
/** 个人知识库 */
export const privateKb = kbRef('kb_doc_private', 'kb_private_u1')
/** 未配置可见范围的知识资源（应被拒绝，不猜） */
export const noAclKb: ResourceRef = ref({
  kind: 'kb_doc',
  id: 'kb_doc_no_acl',
  scopeType: 'company',
  scopeId: COMPANY,
  ownerId: undefined,
})
