/**
 * 开发预览数据（只在 devAuth 打开且库为空时执行）。
 *
 * 造的东西够页面看得懂就行：一家公司、6 个部门、7 个人、6 个知识库。
 * 生产环境不会走这里（company 表非空即跳过，且 main.ts 里只在 devAuth 时调用）。
 */
import { BUILTIN_ROLES } from '@eab/authz'
import type { Classification } from '@eab/domain'
import { withTransaction, type Db } from '@eab/storage'
import { hashPassword } from './password.js'

export const COMPANY_ID = 'c1'
export const COMPANY_NAME = '甲科技'

export interface SeedPerson {
  readonly id: string
  readonly name: string
  readonly title: string
  readonly deptId: string
  readonly roles: readonly string[]
}

const DEPTS = [
  { id: 'd_root', parent: null, name: COMPANY_NAME, path: `/c1/`, depth: 1 },
  { id: 'd10', parent: 'd_root', name: '研发中心', path: '/c1/d10/', depth: 2 },
  { id: 'd11', parent: 'd10', name: '后端组', path: '/c1/d10/d11/', depth: 3 },
  { id: 'd23', parent: 'd10', name: '前端组', path: '/c1/d10/d23/', depth: 3 },
  { id: 'd20', parent: 'd_root', name: '市场部', path: '/c1/d20/', depth: 2 },
  { id: 'd30', parent: 'd_root', name: '人力行政中心', path: '/c1/d30/', depth: 2 },
] as const

export const PEOPLE: readonly SeedPerson[] = [
  { id: 'u_wf', name: '王芳', title: '总经理办公室主任', deptId: 'd_root', roles: ['company_admin'] },
  { id: 'u_lj', name: '李静', title: '研发总监', deptId: 'd10', roles: ['dept_admin'] },
  { id: 'u_zt', name: '周涛', title: '后端工程师', deptId: 'd11', roles: ['member'] },
  { id: 'u_zw', name: '张伟', title: '前端工程师', deptId: 'd23', roles: ['member'] },
  { id: 'u_cm', name: '陈明', title: '市场策划', deptId: 'd20', roles: ['member'] },
  { id: 'u_sy', name: '孙悦', title: '知识库运营', deptId: 'd10', roles: ['kb_admin'] },
  { id: 'u_wm', name: '吴敏', title: '内审专员', deptId: 'd30', roles: ['auditor'] },
]

interface SeedDoc {
  readonly id: string
  readonly title: string
  readonly classification: Classification
  readonly chunks: number
}

interface SeedCollection {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly mode: 'all' | 'roles' | 'depts' | 'private'
  readonly roles?: readonly string[]
  readonly depts?: readonly string[]
  readonly owner?: string
  readonly docs: readonly SeedDoc[]
}

export const COLLECTIONS: readonly SeedCollection[] = [
  {
    id: 'kb_all',
    name: '公司制度',
    description: '员工手册、考勤、报销等全员适用的制度',
    mode: 'all',
    docs: [
      { id: 'doc_handbook', title: '员工手册 v3.2', classification: 'internal', chunks: 12 },
      { id: 'doc_leave', title: '请假与调休规定', classification: 'internal', chunks: 4 },
      { id: 'doc_expense', title: '差旅报销标准', classification: 'internal', chunks: 6 },
      { id: 'doc_ma', title: '并购项目底稿（2026）', classification: 'confidential', chunks: 9 },
    ],
  },
  {
    id: 'kb_mgmt',
    name: '薪酬与绩效',
    description: '薪酬结构、绩效评定，仅管理层可见',
    mode: 'roles',
    roles: ['dept_admin', 'company_admin'],
    docs: [
      { id: 'doc_salary', title: '薪酬结构与职级带宽', classification: 'internal', chunks: 8 },
      { id: 'doc_kpi', title: '绩效评定细则（Q4）', classification: 'internal', chunks: 5 },
    ],
  },
  {
    id: 'kb_rd',
    name: '研发规范',
    description: '代码规范、发布流程、架构决策记录',
    mode: 'depts',
    depts: ['/c1/d10/'],
    docs: [
      { id: 'doc_style', title: '前端代码规范', classification: 'internal', chunks: 7 },
      { id: 'doc_release', title: '灰度发布流程', classification: 'internal', chunks: 5 },
      { id: 'doc_adr', title: '架构决策记录 ADR 汇总', classification: 'internal', chunks: 11 },
    ],
  },
  {
    id: 'kb_mkt',
    name: '市场部资料',
    description: '活动方案、渠道投放复盘',
    mode: 'depts',
    depts: ['/c1/d20/'],
    docs: [
      { id: 'doc_campaign', title: '双十一活动方案', classification: 'internal', chunks: 6 },
      { id: 'doc_channel', title: '渠道投放复盘', classification: 'internal', chunks: 3 },
    ],
  },
  {
    id: 'kb_hr',
    name: '人力内部资料',
    description: '招聘、员工关系，仅人力中心可见',
    mode: 'depts',
    depts: ['/c1/d30/'],
    docs: [{ id: 'doc_hiring', title: '2026 招聘计划', classification: 'internal', chunks: 4 }],
  },
  {
    id: 'kb_wf',
    name: '王芳的工作笔记',
    description: '个人工作记录，仅本人可见',
    mode: 'private',
    owner: 'u_wf',
    docs: [{ id: 'doc_notes', title: '周会要点（10 月）', classification: 'internal', chunks: 2 }],
  },
]

function deptPathOf(deptId: string): string {
  const dept = DEPTS.find((item) => item.id === deptId)
  if (!dept) throw new Error(`未定义的部门: ${deptId}`)
  return dept.path
}

/** 库为空才造数据；返回是否真的造了。整段在一个事务里，失败不留半截数据。 */
export function ensureDemoData(db: Db): boolean {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM companies').get() as { n: number }
  if (Number(existing.n) > 0) return false

  return withTransaction(db, () => {
    seedAll(db)
    seedSecondCompany(db)
    return true
  })
}

/* ---------------- 第二家公司：证明"一个平台托多家公司"是隔离的 ---------------- */

const C2 = 'c2'
const C2_NAME = '乙软件'

/**
 * 增量种子：老库（只有 c1）启动时补上第二家公司。
 * 演示多租户最怕"上次的库还在，但新种子永远不执行"，所以这里按 c2 是否存在单独判一次。
 */
export function ensureSecondCompany(db: Db): boolean {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM companies WHERE id = ?').get(C2) as { n: number }
  if (Number(existing.n) > 0) return false
  return withTransaction(db, () => {
    seedSecondCompany(db)
    return true
  })
}

const C2_DEPTS = [
  { id: 'e_root', parent: null, name: C2_NAME, path: `/c2/`, depth: 1 },
  { id: 'e10', parent: 'e_root', name: '产品部', path: '/c2/e10/', depth: 2 },
  { id: 'e20', parent: 'e_root', name: '交付部', path: '/c2/e20/', depth: 2 },
] as const

const C2_PEOPLE: readonly SeedPerson[] = [
  { id: 'u2_admin', name: '赵倩', title: '乙软件负责人', deptId: 'e_root', roles: ['company_admin'] },
  { id: 'u2_pm', name: '钱磊', title: '产品经理', deptId: 'e10', roles: ['member'] },
  { id: 'u2_dev', name: '孙浩', title: '交付工程师', deptId: 'e20', roles: ['member'] },
]

const C2_COLLECTIONS: readonly SeedCollection[] = [
  {
    id: 'kb2_all',
    name: '乙软件员工手册',
    description: '乙软件自己的制度，甲科技看不到',
    mode: 'all',
    docs: [{ id: 'doc2_handbook', title: '乙软件员工手册 v1.0', classification: 'internal', chunks: 3 }],
  },
  {
    id: 'kb2_delivery',
    name: '交付规范',
    description: '只对交付部开放',
    mode: 'depts',
    depts: ['/c2/e20/'],
    docs: [{ id: 'doc2_delivery', title: '现场交付检查表', classification: 'internal', chunks: 2 }],
  },
]

function pathOf(depts: readonly { id: string; path: string }[], deptId: string): string {
  const dept = depts.find((item) => item.id === deptId)
  if (!dept) throw new Error(`未定义的部门: ${deptId}`)
  return dept.path
}

function seedSecondCompany(db: Db): void {
  const now = Date.now()
  db.prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)').run(
    C2,
    C2_NAME,
    'beta',
    'active',
    now,
  )

  const insertDept = db.prepare(
    'INSERT INTO departments (id, company_id, parent_id, name, path, depth, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  for (const dept of C2_DEPTS) {
    insertDept.run(dept.id, C2, dept.parent, dept.name, dept.path, dept.depth, now)
  }

  const insertUser = db.prepare(
    `INSERT INTO users (id, company_id, dept_id, dept_path, name, title, employee_no, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  )
  for (const person of C2_PEOPLE) {
    insertUser.run(
      person.id,
      C2,
      person.deptId,
      pathOf(C2_DEPTS, person.deptId),
      person.name,
      person.title,
      person.id.toUpperCase(),
      now,
      now,
    )
  }

  const insertRole = db.prepare(
    'INSERT INTO roles (id, company_id, code, name, data_scope, builtin, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
  )
  const insertRoleScope = db.prepare('INSERT INTO role_scopes (role_id, scope) VALUES (?, ?)')
  for (const role of BUILTIN_ROLES) {
    insertRole.run(`role_${C2}_${role.code}`, C2, role.code, role.name, role.dataScope, now)
    for (const scope of new Set(role.scopes)) {
      insertRoleScope.run(`role_${C2}_${role.code}`, scope)
    }
  }

  const insertGrant = db.prepare(
    'INSERT INTO user_roles (user_id, role_id, granted_by, granted_at) VALUES (?, ?, ?, ?)',
  )
  for (const person of C2_PEOPLE) {
    for (const code of person.roles) {
      insertGrant.run(person.id, `role_${C2}_${code}`, 'u2_admin', now)
    }
  }

  const insertCollection = db.prepare(
    `INSERT INTO kb_collections (id, company_id, name, description, acl_mode, acl_roles, acl_dept_paths, owner_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const insertDoc = db.prepare(
    `INSERT INTO kb_docs (id, company_id, collection_id, title, classification, status, chunk_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'indexed', ?, ?, ?)`,
  )
  const insertChunk = db.prepare(
    `INSERT INTO kb_chunks (id, company_id, doc_id, collection_id, ordinal, text, classification, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  for (const collection of C2_COLLECTIONS) {
    insertCollection.run(
      collection.id,
      C2,
      collection.name,
      collection.description,
      collection.mode,
      collection.roles ? JSON.stringify(collection.roles) : null,
      collection.depts ? JSON.stringify(collection.depts) : null,
      collection.owner ?? null,
      now,
      now,
    )
    for (const doc of collection.docs) {
      insertDoc.run(doc.id, C2, collection.id, doc.title, doc.classification, doc.chunks, now, now)
      for (let ordinal = 0; ordinal < doc.chunks; ordinal += 1) {
        insertChunk.run(
          `chunk_${doc.id}_${ordinal}`,
          C2,
          doc.id,
          collection.id,
          ordinal,
          `${doc.title} · 第 ${ordinal + 1} 段正文……`,
          doc.classification,
          now,
        )
      }
    }
  }
}

function seedAll(db: Db): void {
  const now = Date.now()
  db.prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)').run(
    COMPANY_ID,
    COMPANY_NAME,
    'acme',
    'active',
    now,
  )

  const insertDept = db.prepare(
    'INSERT INTO departments (id, company_id, parent_id, name, path, depth, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  for (const dept of DEPTS) {
    insertDept.run(dept.id, COMPANY_ID, dept.parent, dept.name, dept.path, dept.depth, now)
  }

  const insertUser = db.prepare(
    `INSERT INTO users (id, company_id, dept_id, dept_path, name, title, employee_no, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  )
  for (const person of PEOPLE) {
    insertUser.run(
      person.id,
      COMPANY_ID,
      person.deptId,
      deptPathOf(person.deptId),
      person.name,
      person.title,
      person.id.toUpperCase(),
      now,
      now,
    )
  }

  // 角色：直接按内置角色落库（DB 是控制台展示的事实来源，判定仍用同一份定义）
  const insertRole = db.prepare(
    'INSERT INTO roles (id, company_id, code, name, data_scope, builtin, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
  )
  const insertRoleScope = db.prepare('INSERT INTO role_scopes (role_id, scope) VALUES (?, ?)')
  for (const role of BUILTIN_ROLES) {
    insertRole.run(`role_${role.code}`, COMPANY_ID, role.code, role.name, role.dataScope, now)
    // 去重：角色定义里 dept_admin 的 MEMBER_SCOPES 已含 approval:read，直接逐条插会撞主键
    for (const scope of new Set(role.scopes)) {
      insertRoleScope.run(`role_${role.code}`, scope)
    }
  }

  const insertGrant = db.prepare(
    'INSERT INTO user_roles (user_id, role_id, granted_by, granted_at) VALUES (?, ?, ?, ?)',
  )
  for (const person of PEOPLE) {
    for (const code of person.roles) {
      insertGrant.run(person.id, `role_${code}`, 'u_wf', now)
    }
  }

  const insertCollection = db.prepare(
    `INSERT INTO kb_collections (id, company_id, name, description, acl_mode, acl_roles, acl_dept_paths, owner_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const insertDoc = db.prepare(
    `INSERT INTO kb_docs (id, company_id, collection_id, title, classification, status, chunk_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'indexed', ?, ?, ?)`,
  )
  const insertChunk = db.prepare(
    `INSERT INTO kb_chunks (id, company_id, doc_id, collection_id, ordinal, text, classification, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  for (const collection of COLLECTIONS) {
    insertCollection.run(
      collection.id,
      COMPANY_ID,
      collection.name,
      collection.description,
      collection.mode,
      collection.roles ? JSON.stringify(collection.roles) : null,
      collection.depts ? JSON.stringify(collection.depts) : null,
      collection.owner ?? null,
      now,
      now,
    )

    for (const doc of collection.docs) {
      insertDoc.run(
        doc.id,
        COMPANY_ID,
        collection.id,
        doc.title,
        doc.classification,
        doc.chunks,
        now,
        now,
      )
      for (let ordinal = 0; ordinal < doc.chunks; ordinal += 1) {
        insertChunk.run(
          `chunk_${doc.id}_${ordinal}`,
          COMPANY_ID,
          doc.id,
          collection.id,
          ordinal,
          `${doc.title} · 第 ${ordinal + 1} 段正文……`,
          doc.classification,
          now,
        )
      }
    }
  }
}


/**
 * 模型目录：只在"这家公司一个模型都没有"时补一份演示目录，
 * 让控制台的模型页一进去就有东西可看；真实厂商/本地模型由控制台自己加。
 */
export function ensureModelCatalog(db: Db): boolean {
  const now = Date.now()
  let inserted = false
  const companies: Array<{ id: string; name: string }> = [
    { id: COMPANY_ID, name: COMPANY_NAME },
    { id: C2, name: C2_NAME },
  ]
  for (const company of companies) {
    // 演示目录里包含第二家公司，但真实库可能只启用了一家公司；
    // 外键要求 provider 所属公司必须存在，缺失时不要硬插。
    const companyExists = db.prepare('SELECT 1 FROM companies WHERE id = ?').get(company.id)
    if (!companyExists) continue
    const existing = db.prepare('SELECT COUNT(*) AS n FROM models WHERE company_id = ?').get(company.id) as { n: number }
    if (Number(existing.n) > 0) continue
    const providerId = `prov_${company.id}_demo`
    db.prepare(
      `INSERT INTO model_providers (id, company_id, kind, name, base_url, api_key_env, status, created_at, updated_at)
       VALUES (?, ?, 'demo', ?, NULL, NULL, 'active', ?, ?)`,
    ).run(providerId, company.id, '演示回声（未接真厂商）', now, now)
    const insertModel = db.prepare(
      `INSERT INTO models (id, company_id, provider_id, name, model_key, tags, roles, priority, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    const catalog = [
      { suffix: 'general', name: '通用问答', key: 'demo-chat', tags: ['chat', 'writing'], roles: [], priority: 10 },
      {
        suffix: 'reason',
        name: '深度推理',
        key: 'demo-reason',
        tags: ['reasoning', 'analysis'],
        roles: ['super_admin', 'company_admin', 'dept_admin'],
        priority: 20,
      },
      {
        suffix: 'code',
        name: '代码助手',
        key: 'demo-code',
        tags: ['code'],
        roles: ['super_admin', 'company_admin', 'kb_admin'],
        priority: 15,
      },
    ]
    for (const item of catalog) {
      const id = company.id === COMPANY_ID ? `model_${item.suffix}` : `model_${company.id}_${item.suffix}`
      insertModel.run(
        id,
        company.id,
        providerId,
        item.name,
        item.key,
        JSON.stringify(item.tags),
        JSON.stringify(item.roles),
        item.priority,
        now,
        now,
      )
    }
    inserted = true
  }
  return inserted
}
/**
 * 给演示成员补默认密码（只补 password_hash 为空的，管理员改过密码不会被覆盖）。
 * 返回账号清单，由 main.ts 写进 .eab-dev/demo-accounts.txt。
 */
export interface DemoAccount {
  readonly companyId: string
  readonly companyName: string
  readonly userId: string
  readonly name: string
  readonly employeeNo: string
  readonly password: string
}

export function ensureDemoPasswords(db: Db): DemoAccount[] {
  const PASSWORD = 'Eab@2026demo'
  const rows = db
    .prepare(
      `SELECT u.id, u.name, u.employee_no, u.company_id, c.name AS company_name
         FROM users u
         JOIN companies c ON c.id = u.company_id
        WHERE u.deleted_at IS NULL AND u.password_hash IS NULL
          AND u.company_id IN (?, ?)
        ORDER BY u.company_id, u.id`,
    )
    .all(COMPANY_ID, 'c2') as unknown as Array<{
    id: string
    name: string
    employee_no: string | null
    company_id: string
    company_name: string
  }>
  if (rows.length === 0) return []
  const update = db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
  const now = Date.now()
  return rows.map((row) => {
    update.run(hashPassword(PASSWORD), now, row.id)
    return {
      companyId: row.company_id,
      companyName: row.company_name,
      userId: row.id,
      name: row.name,
      employeeNo: row.employee_no ?? row.id.toUpperCase(),
      password: PASSWORD,
    }
  })
}