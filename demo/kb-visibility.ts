/**
 * EAB 基座演示：知识库可见范围（collection 级 ACL）
 *
 * 跑法：`pnpm demo:kb`
 *
 * 它做的事：
 * 1. 建一个真实的 SQLite 库（`.eab-dev/demo.db`），跑完两版迁移
 * 2. 造一家公司、4 个部门、4 个人、5 个知识库（覆盖 all / roles / depts / private）
 * 3. 对每个人、每个知识库，同时跑两条路径：
 *    - 逐条判定 `decide(subject, kb:read, chunk)`  ← 详情页口径
 *    - 列表查询 `buildScopeFilter` → SQL       ← 列表页口径
 *    两边的结论必须一致（这也是 storage 里那条一致性测试的现场版）
 * 4. 最后演示两个 fail-closed 场景：没加载可见范围配置、配置写坏
 */
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { buildScopeFilter, buildSubject, decide, predicateToSql } from '@eab/authz'
import { SC, type Classification } from '@eab/domain'
import { loadKbCollectionAcls, migrate, openDatabase, type Db } from '@eab/storage'

const DB_PATH = resolve(process.cwd(), '.eab-dev', 'demo.db')

// ---------------------------------------------------------------- 输出小工具

/** CJK 字符按 2 列宽计算，避免中文表格错位 */
function displayWidth(text: string): number {
  let width = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
    width += wide ? 2 : 1
  }
  return width
}

function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)))
}

function title(text: string): void {
  console.log(`\n${'─'.repeat(72)}`)
  console.log(text)
  console.log('─'.repeat(72))
}

// ---------------------------------------------------------------- 造数据

interface SeedCollection {
  readonly id: string
  readonly name: string
  readonly mode: 'all' | 'roles' | 'depts' | 'private'
  readonly roles?: readonly string[]
  readonly depts?: readonly string[]
  readonly owner?: string
  readonly docs: readonly { id: string; title: string; classification: Classification }[]
}

const COLLECTIONS: readonly SeedCollection[] = [
  {
    id: 'kb_all',
    name: '公司制度',
    mode: 'all',
    docs: [
      { id: 'doc_handbook', title: '员工手册 v3', classification: 'internal' },
      { id: 'doc_leave', title: '请假与调休规定', classification: 'internal' },
      { id: 'doc_ma', title: '并购项目底稿', classification: 'confidential' },
    ],
  },
  {
    id: 'kb_mgmt',
    name: '薪酬与绩效',
    mode: 'roles',
    roles: ['dept_admin', 'company_admin'],
    docs: [
      { id: 'doc_salary', title: '薪酬结构说明', classification: 'internal' },
      { id: 'doc_kpi', title: '绩效评定细则', classification: 'internal' },
    ],
  },
  {
    id: 'kb_rd',
    name: '研发规范',
    mode: 'depts',
    depts: ['/c1/d10/'],
    docs: [
      { id: 'doc_style', title: '前端代码规范', classification: 'internal' },
      { id: 'doc_release', title: '发布流程', classification: 'internal' },
    ],
  },
  {
    id: 'kb_mkt',
    name: '市场部资料',
    mode: 'depts',
    depts: ['/c1/d20/'],
    docs: [{ id: 'doc_campaign', title: '双十一活动方案', classification: 'internal' }],
  },
  {
    id: 'kb_wf',
    name: '王芳的工作笔记',
    mode: 'private',
    owner: 'u_wf',
    docs: [{ id: 'doc_notes', title: '周会要点', classification: 'internal' }],
  },
]

const PEOPLE = [
  { userId: 'u_zw', name: '张伟', deptId: 'd23', deptPath: '/c1/d10/d23/', roles: ['member'], note: '前端组 · 普通员工' },
  { userId: 'u_lj', name: '李静', deptId: 'd10', deptPath: '/c1/d10/', roles: ['dept_admin'], note: '研发中心 · 部门管理员' },
  { userId: 'u_wf', name: '王芳', deptId: 'd_root', deptPath: '/c1/', roles: ['company_admin'], note: '公司总部 · 公司管理员' },
  { userId: 'u_cm', name: '陈明', deptId: 'd20', deptPath: '/c1/d20/', roles: ['member'], note: '市场部 · 普通员工' },
] as const

function seed(db: Db): void {
  const now = Date.now()
  db.prepare("INSERT INTO companies (id, name, slug, created_at) VALUES ('c1', '甲科技', 'acme', ?)").run(now)

  const dept = (id: string, parent: string | null, name: string, path: string, depth: number) =>
    db
      .prepare(
        'INSERT INTO departments (id, company_id, parent_id, name, path, depth, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, 'c1', parent, name, path, depth, now)

  dept('d_root', null, '甲科技', '/c1/', 1)
  dept('d10', 'd_root', '研发中心', '/c1/d10/', 2)
  dept('d23', 'd10', '前端组', '/c1/d10/d23/', 3)
  dept('d20', 'd_root', '市场部', '/c1/d20/', 2)

  for (const person of PEOPLE) {
    db.prepare(
      `INSERT INTO users (id, company_id, dept_id, dept_path, name, title, status, created_at, updated_at)
       VALUES (?, 'c1', ?, ?, ?, ?, 'active', ?, ?)`,
    ).run(person.userId, person.deptId, person.deptPath, person.name, person.note, now, now)
  }

  for (const collection of COLLECTIONS) {
    db.prepare(
      `INSERT INTO kb_collections (id, company_id, name, acl_mode, acl_roles, acl_dept_paths, owner_user_id, created_at, updated_at)
       VALUES (?, 'c1', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      collection.id,
      collection.name,
      collection.mode,
      collection.roles ? JSON.stringify(collection.roles) : null,
      collection.depts ? JSON.stringify(collection.depts) : null,
      collection.owner ?? null,
      now,
      now,
    )

    for (const doc of collection.docs) {
      db.prepare(
        `INSERT INTO kb_docs (id, company_id, collection_id, title, classification, status, chunk_count, created_at, updated_at)
         VALUES (?, 'c1', ?, ?, ?, 'indexed', 1, ?, ?)`,
      ).run(doc.id, collection.id, doc.title, doc.classification, now, now)

      db.prepare(
        `INSERT INTO kb_chunks (id, company_id, doc_id, collection_id, ordinal, text, classification, created_at)
         VALUES (?, 'c1', ?, ?, 0, ?, ?, ?)`,
      ).run(`chunk_${doc.id}`, doc.id, collection.id, `${doc.title} 的正文……`, doc.classification, now)
    }
  }
}

// ---------------------------------------------------------------- 演示

function buildFreshDb(): Db {
  mkdirSync(dirname(DB_PATH), { recursive: true })
  rmSync(DB_PATH, { force: true })
  rmSync(`${DB_PATH}-wal`, { force: true })
  rmSync(`${DB_PATH}-shm`, { force: true })
  const db = openDatabase({ path: DB_PATH })
  const result = migrate(db)
  console.log(`数据库: ${DB_PATH}`)
  console.log(`迁移: ${result.applied.join(', ') || '（已是最新）'}`)
  seed(db)
  return db
}

const ALLOWED_FIELDS = ['company_id', 'collection_id', 'classification'] as const

function main(): void {
  console.log('EAB 基座演示 · 知识库可见范围（collection 级 ACL）')
  const db = buildFreshDb()

  const collections = loadKbCollectionAcls(db, 'c1')

  title('① 组织与知识库配置')
  console.log('部门: 甲科技(/c1/) → 研发中心(/c1/d10/) → 前端组(/c1/d10/d23/)，市场部(/c1/d20/)')
  console.log('\n知识库:')
  const nameWidth = Math.max(...COLLECTIONS.map((c) => displayWidth(c.name)))
  for (const collection of COLLECTIONS) {
    const how =
      collection.mode === 'all'
        ? '全员可见'
        : collection.mode === 'roles'
          ? `仅角色 ${collection.roles?.join('/')}`
          : collection.mode === 'depts'
            ? `仅部门 ${collection.depts?.join(',')}（含下级）`
            : `仅本人（${collection.owner}）`
    const docCount = collection.docs.length
    console.log(`  ${pad(collection.name, nameWidth)}  ${pad(how, 40)} ${docCount} 篇`)
  }

  title('② 每个人的实际视野（逐条判定 vs 列表 SQL）')
  for (const person of PEOPLE) {
    const subject = buildSubject({
      userId: person.userId,
      companyId: 'c1',
      deptId: person.deptId,
      deptPath: person.deptPath,
      roles: [...person.roles],
    })

    const filter = buildScopeFilter(subject, SC.KB_READ, 'kb_chunk', { collections })
    const compiled = predicateToSql(filter.predicate, { allowedFields: ALLOWED_FIELDS })
    const counts = db
      .prepare(`SELECT collection_id AS cid, COUNT(*) AS n FROM kb_chunks WHERE ${compiled.sql} GROUP BY collection_id`)
      .all(...(compiled.params as string[])) as unknown as Array<{ cid: string; n: number }>
    const countMap = new Map(counts.map((row) => [row.cid, Number(row.n)]))

    console.log(`\n${person.name}（${person.note}）`)
    for (const collection of COLLECTIONS) {
      const doc = collection.docs[0]
      const decision = decide(subject, SC.KB_READ, {
        kind: 'kb_chunk',
        id: `chunk_${doc.id}`,
        companyId: 'c1',
        scopeType: 'company',
        scopeId: 'c1',
        collectionId: collection.id,
        collectionAcl: collections.find((acl) => acl.collectionId === collection.id),
        classification: doc.classification,
      })
      const sqlCount = countMap.get(collection.id) ?? 0
      const mark = decision.result === 'allow' ? '✓' : '✗'
      const why = decision.result === 'allow' ? `放行(${decision.matchedBy})` : `拒绝(${decision.matchedBy})`
      const consistent = decision.result === 'allow' ? sqlCount > 0 : sqlCount === 0
      console.log(
        `  ${mark} ${pad(collection.name, nameWidth)}  ${pad(why, 30)} SQL 查到 ${sqlCount} 条` +
          (consistent ? '' : '   ← 口径不一致！'),
      )
    }
  }

  title('③ 下推的 SQL 长什么样（以张伟为例，读 kb_chunk）')
  const zhangwei = buildSubject({
    userId: 'u_zw',
    companyId: 'c1',
    deptId: 'd23',
    deptPath: '/c1/d10/d23/',
    roles: ['member'],
  })
  const filter = buildScopeFilter(zhangwei, SC.KB_READ, 'kb_chunk', { collections })
  const compiled = predicateToSql(filter.predicate, { allowedFields: ALLOWED_FIELDS })
  console.log(`reason: ${filter.reason}`)
  console.log(`SQL   : SELECT ... FROM kb_chunks WHERE ${compiled.sql}`)
  console.log(`params: ${JSON.stringify(compiled.params)}`)

  title('④ 两个 fail-closed 场景')
  console.log('1) 忘了把可见范围配置传进来（collections 缺失）')
  const noContext = buildScopeFilter(zhangwei, SC.KB_READ, 'kb_chunk')
  const noCtxSql = predicateToSql(noContext.predicate, { allowedFields: ALLOWED_FIELDS })
  const noCtxRows = db
    .prepare(`SELECT COUNT(*) AS n FROM kb_chunks WHERE ${noCtxSql.sql}`)
    .all(...(noCtxSql.params as string[])) as unknown as Array<{ n: number }>
  console.log(`   reason=${noContext.reason}  → 查到 ${Number(noCtxRows[0]?.n ?? 0)} 条（应为 0）`)

  console.log('2) 配置写坏了（新插一个 acl_mode=everyone 的知识库）')
  const now = Date.now()
  db.prepare(
    `INSERT INTO kb_collections (id, company_id, name, acl_mode, created_at, updated_at)
     VALUES ('kb_typo', 'c1', '写错配置的库', 'everyone', ?, ?)`,
  ).run(now, now)
  db.prepare(
    `INSERT INTO kb_docs (id, company_id, collection_id, title, classification, status, created_at, updated_at)
     VALUES ('doc_typo', 'c1', 'kb_typo', '不该被看到的内容', 'internal', 'indexed', ?, ?)`,
  ).run(now, now)
  db.prepare(
    `INSERT INTO kb_chunks (id, company_id, doc_id, collection_id, ordinal, text, classification, created_at)
     VALUES ('chunk_typo', 'c1', 'doc_typo', 'kb_typo', 0, '机密正文', 'internal', ?)`,
  ).run(now)

  const reloaded = loadKbCollectionAcls(db, 'c1')
  const visibleIds = new Set(reloaded.map((acl) => acl.collectionId))
  const typoFilter = buildScopeFilter(zhangwei, SC.KB_READ, 'kb_chunk', { collections: reloaded })
  const typoSql = predicateToSql(typoFilter.predicate, { allowedFields: ALLOWED_FIELDS })
  const typoRows = db
    .prepare(`SELECT COUNT(*) AS n FROM kb_chunks WHERE ${typoSql.sql} AND collection_id = 'kb_typo'`)
    .all(...(typoSql.params as string[])) as unknown as Array<{ n: number }>
  console.log(`   kb_typo 是否进入可见集合: ${visibleIds.has('kb_typo')}（应为 false）`)
  console.log(`   查询 kb_typo 命中: ${Number(typoRows[0]?.n ?? 0)} 条（应为 0）`)

  db.close()
  console.log('\n演示结束。换人/换配置改 COLLECTIONS 与 PEOPLE 即可重跑；数据库每次重建。')
}

main()
