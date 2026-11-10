/**
 * 知识库可见范围（collection 级 ACL）的判定。
 *
 * 为什么知识库不用"部门数据范围"那套：
 * 部门范围只能表达"我的部门/我的下级"，但企业里配知识库的常见口径是
 * "全员可见"、"仅管理层可见"、"仅研发中心可见"——这是运营配置，不是组织树的副产品。
 * 所以把可见性抽成显式 ACL，读操作只看 ACL，写/删仍受组织范围约束（见 scope-filter / pdp）。
 */
import { isPathWithin } from './dept.js'
import type { KbCollectionAcl, Subject } from './types.js'

export const KB_ACL_MODES: readonly KbCollectionAcl['mode'][] = ['all', 'roles', 'depts', 'private']

/**
 * 某个知识库对某个主体是否可见。
 * 任何配置缺失/不合法都返回 false（缺省拒绝，不猜）。
 */
export function isCollectionVisible(acl: KbCollectionAcl, subject: Subject): boolean {
  if (acl.companyId !== subject.companyId) return false
  if (subject.status !== 'active') return false

  switch (acl.mode) {
    case 'all':
      return true
    case 'roles': {
      const roles = acl.roleCodes ?? []
      return roles.some((code) => subject.roles.includes(code))
    }
    case 'depts': {
      // 授权部门包含其下级：给"研发中心"授权，前端组的人也能看
      const paths = acl.deptPaths ?? []
      return paths.some((granted) => isPathWithin(subject.deptPath, granted))
    }
    case 'private':
      return acl.ownerUserId !== undefined && acl.ownerUserId === subject.userId
    default: {
      const never: never = acl.mode
      throw new TypeError(`未支持的知识库可见范围模式: ${String(never)}`)
    }
  }
}

/**
 * 主体可见的知识库 ID 集合。
 * 输入是"该公司全部知识库的 ACL"，输出直接喂给 `buildScopeFilter` 变成 `collection_id IN (...)`，
 * 这样权限仍然是一次 SQL 谓词，不需要在内存里对文档逐条判断。
 */
export function resolveVisibleCollections(
  subject: Subject,
  collections: readonly KbCollectionAcl[],
): Set<string> {
  const visible = new Set<string>()
  for (const acl of collections) {
    if (isCollectionVisible(acl, subject)) visible.add(acl.collectionId)
  }
  return visible
}

/** 是否知识类资源（读操作用 ACL 判定，不走部门范围） */
export function isKnowledgeKind(kind: string): boolean {
  return kind === 'kb_doc' || kind === 'kb_chunk'
}
