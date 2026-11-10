/**
 * 知识库可见范围的读取。
 *
 * 只做一件事：把 `kb_collections` 里的配置翻译成 `KbCollectionAcl[]`，
 * 供 `buildScopeFilter(..., { collections })` 与 PDP 使用。
 * 读失败/配置不合法的行直接跳过（= 该知识库对任何人都不可见），
 * 这是有意的 fail-closed：配置坏了宁可少看见，也不能多看见。
 */
import type { KbAclMode, KbCollectionAcl } from '@eab/domain'
import type { Db } from './db.js'

const VALID_MODES: readonly KbAclMode[] = ['all', 'roles', 'depts', 'private']

interface CollectionRow {
  id: string
  company_id: string
  acl_mode: string
  acl_roles: string | null
  acl_dept_paths: string | null
  owner_user_id: string | null
}

function parseStringArray(raw: string | null): string[] {
  if (raw === null || raw.length === 0) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0)
  } catch {
    return []
  }
}

function isAclMode(value: string): value is KbAclMode {
  return (VALID_MODES as readonly string[]).includes(value)
}

/** 读取某公司全部有效知识库 ACL（只读，不含软删除的库） */
export function loadKbCollectionAcls(db: Db, companyId: string): KbCollectionAcl[] {
  const rows = db
    .prepare(
      `SELECT id, company_id, acl_mode, acl_roles, acl_dept_paths, owner_user_id
         FROM kb_collections
        WHERE company_id = ? AND deleted_at IS NULL AND status = 'active'`,
    )
    .all(companyId) as unknown as CollectionRow[]

  const result: KbCollectionAcl[] = []
  for (const row of rows) {
    if (!isAclMode(row.acl_mode)) continue
    if (row.acl_mode === 'private' && row.owner_user_id === null) continue

    result.push({
      collectionId: row.id,
      companyId: row.company_id,
      mode: row.acl_mode,
      roleCodes: parseStringArray(row.acl_roles),
      deptPaths: parseStringArray(row.acl_dept_paths),
      ownerUserId: row.owner_user_id ?? undefined,
    })
  }
  return result
}

/** 序列化为入库形态（管理端保存配置时用；保证与读取端格式一致） */
export function serializeKbAcl(acl: {
  readonly mode: KbAclMode
  readonly roleCodes?: readonly string[]
  readonly deptPaths?: readonly string[]
}): { acl_mode: KbAclMode; acl_roles: string | null; acl_dept_paths: string | null } {
  return {
    acl_mode: acl.mode,
    acl_roles: acl.roleCodes && acl.roleCodes.length > 0 ? JSON.stringify(acl.roleCodes) : null,
    acl_dept_paths: acl.deptPaths && acl.deptPaths.length > 0 ? JSON.stringify(acl.deptPaths) : null,
  }
}
