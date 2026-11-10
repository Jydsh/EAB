import { describe, expect, it } from 'vitest'
import { buildScopeFilter, buildSubject, decide, predicateToSql } from '@eab/authz'
import { SC } from '@eab/domain'
import { loadKbCollectionAcls, migrate, openDatabase, tableExists } from '@eab/storage'

function seededDb() {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)

  db.prepare("INSERT INTO companies (id, name, slug, created_at) VALUES ('c1', '甲公司', 'acme', 1)").run()
  db.prepare("INSERT INTO departments (id, company_id, parent_id, name, path, created_at) VALUES ('d10', 'c1', NULL, '研发部', '/c1/d10/', 1)").run()

  const collection = (
    id: string,
    mode: string,
    roles: string[] | null,
    depts: string[] | null,
    owner: string | null,
  ) =>
    db
      .prepare(
        `INSERT INTO kb_collections (id, company_id, name, acl_mode, acl_roles, acl_dept_paths, owner_user_id, created_at, updated_at)
         VALUES (?, 'c1', ?, ?, ?, ?, ?, 1, 1)`,
      )
      .run(id, id, mode, roles === null ? null : JSON.stringify(roles), depts === null ? null : JSON.stringify(depts), owner)

  collection('col_all', 'all', null, null, null)
  collection('col_d10', 'depts', null, ['/c1/d10/'], null)
  collection('col_admin', 'roles', ['dept_admin'], null, null)
  collection('col_private', 'private', null, null, 'u1')
  // 配置坏了的知识库（未知模式）：读取时应被跳过 → 永远不可见
  collection('col_broken', 'weird-mode', null, null, null)

  const doc = (id: string, collectionId: string, classification: string) =>
    db
      .prepare(
        `INSERT INTO kb_docs (id, company_id, collection_id, title, classification, status, created_at, updated_at)
         VALUES (?, 'c1', ?, ?, ?, 'indexed', 1, 1)`,
      )
      .run(id, collectionId, id, classification)

  doc('doc_all', 'col_all', 'internal')
  doc('doc_all_secret', 'col_all', 'confidential')
  doc('doc_d10', 'col_d10', 'internal')
  doc('doc_admin', 'col_admin', 'internal')
  doc('doc_private', 'col_private', 'internal')
  doc('doc_broken', 'col_broken', 'internal')

  const docs: Array<[string, string, string]> = [
    ['doc_all', 'col_all', 'internal'],
    ['doc_all_secret', 'col_all', 'confidential'],
    ['doc_d10', 'col_d10', 'internal'],
    ['doc_admin', 'col_admin', 'internal'],
    ['doc_private', 'col_private', 'internal'],
    ['doc_broken', 'col_broken', 'internal'],
  ]
  for (const [docId, collectionId, classification] of docs) {
    db.prepare(
      `INSERT INTO kb_chunks (id, company_id, doc_id, collection_id, ordinal, text, classification, created_at)
       VALUES (?, 'c1', ?, ?, 0, '正文', ?, 1)`,
    ).run(`chunk_${docId}`, docId, collectionId, classification)
  }

  return db
}

const member = buildSubject({
  userId: 'u1',
  companyId: 'c1',
  deptId: 'd10',
  deptPath: '/c1/d10/',
  roles: ['member'],
})

const deptAdmin = buildSubject({
  userId: 'u1',
  companyId: 'c1',
  deptId: 'd10',
  deptPath: '/c1/d10/',
  roles: ['dept_admin'],
})

describe('知识库表与配置读取', () => {
  it('迁移后三张知识库表存在', () => {
    const db = seededDb()
    for (const table of ['kb_collections', 'kb_docs', 'kb_chunks']) {
      expect(tableExists(db, table), `缺表: ${table}`).toBe(true)
    }
    db.close()
  })

  it('配置读取：解析 JSON、跳过非法模式、跳过软删除', () => {
    const db = seededDb()
    const acls = loadKbCollectionAcls(db, 'c1')
    const ids = acls.map((a) => a.collectionId).sort()
    expect(ids).toEqual(['col_admin', 'col_all', 'col_d10', 'col_private'])

    const d10 = acls.find((a) => a.collectionId === 'col_d10')
    expect(d10?.mode).toBe('depts')
    expect(d10?.deptPaths).toEqual(['/c1/d10/'])

    const admin = acls.find((a) => a.collectionId === 'col_admin')
    expect(admin?.roleCodes).toEqual(['dept_admin'])
    db.close()
  })

  it('坏配置的知识库对谁都不开放（fail-closed）', () => {
    const db = seededDb()
    const acls = loadKbCollectionAcls(db, 'c1')
    expect(acls.some((a) => a.collectionId === 'col_broken')).toBe(false)
    db.close()
  })
})

describe('知识库检索实际 SQL 效果', () => {
  function visibleChunkIds(
    db: ReturnType<typeof seededDb>,
    subject: ReturnType<typeof buildSubject>,
  ): string[] {
    const collections = loadKbCollectionAcls(db, 'c1')
    const filter = buildScopeFilter(subject, SC.KB_READ, 'kb_chunk', { collections })
    const compiled = predicateToSql(filter.predicate, {
      allowedFields: ['company_id', 'collection_id', 'classification'],
    })
    const rows = db
      .prepare(`SELECT id FROM kb_chunks WHERE ${compiled.sql} ORDER BY id`)
      .all(...(compiled.params as string[])) as unknown as Array<{ id: string }>
    return rows.map((r) => r.id)
  }

  it('普通员工：全员库 + 本部门库 + 自己的个人库，机密与坏配置不可见', () => {
    const db = seededDb()
    expect(visibleChunkIds(db, member)).toEqual(['chunk_doc_all', 'chunk_doc_d10', 'chunk_doc_private'])
    db.close()
  })

  it('部门管理员：额外可见"仅部门管理员"的知识库', () => {
    const db = seededDb()
    expect(visibleChunkIds(db, deptAdmin)).toEqual([
      'chunk_doc_admin',
      'chunk_doc_all',
      'chunk_doc_d10',
      'chunk_doc_private',
    ])
    db.close()
  })

  it('列表可见 == 逐条放行（沿用同一套 ACL 判定）', () => {
    const db = seededDb()
    const collections = loadKbCollectionAcls(db, 'c1')
    const visible = new Set(visibleChunkIds(db, member))
    const rows = db
      .prepare('SELECT id, company_id, doc_id, collection_id, classification FROM kb_chunks ORDER BY id')
      .all() as unknown as Array<{
      id: string
      company_id: string
      doc_id: string
      collection_id: string
      classification: string
    }>

    for (const row of rows) {
      const acl = collections.find((a) => a.collectionId === row.collection_id)
      const decision = decide(member, SC.KB_READ, {
        kind: 'kb_chunk',
        id: row.id,
        companyId: row.company_id,
        scopeType: 'company',
        scopeId: row.company_id,
        collectionId: row.collection_id,
        collectionAcl: acl,
        classification: row.classification as 'internal' | 'confidential',
      }).result
      expect(visible.has(row.id), `${row.id} 的列表与逐条判定不一致`).toBe(decision === 'allow')
    }
    db.close()
  })
})
