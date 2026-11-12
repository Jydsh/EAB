/**
 * 请求 → 主体（Subject）。
 *
 * 现在是开发预览模式：`?as=<userId>` 指定身份，方便一屏对比"不同人看到的东西不一样"。
 * 生产必须换成"已验证会话 / 渠道签名事件"，这个文件就是那个唯一的替换点——
 * 路由里只拿 `Subject`，永远不自己从 query/body 拼身份。
 *
 * 多租户（ADR：一个平台托多家公司）：
 * - **公司从人身上取，不从进程配置取**。`deps.companyId` 只是"单公司部署时的默认公司"，
 *   一旦库里有多家公司，请求属于哪家由这个成员本人决定（`person.companyId`）。
 * - 成员 id 是全局唯一的，所以查人不需要先限定公司；限定公司反而会让别家公司的人
 *   在 `?as=` 下变成"找不到成员"，掩盖真正的越权。
 */
import type { FastifyRequest } from 'fastify'
import { buildSubject, createRoleLookup, type RoleDefinition, type RoleLookup } from '@eab/authz'
import { EC, EabError, type DataScope, type Scope, type Subject } from '@eab/domain'
import type { Db } from '@eab/storage'
import type { ServerConfig } from './config.js'
import { isConsoleRequest } from './console-auth.js'
import { readSessionUserId } from './employee-session.js'

export interface PersonRow {
  readonly id: string
  readonly name: string
  readonly title: string | null
  readonly avatar: string | null
  readonly deptId: string
  readonly deptPath: string
  readonly deptName: string
  readonly companyId: string
  readonly companyName: string
}

export interface RequestActor {
  readonly subject: Subject
  readonly person: PersonRow
}

interface UserRow {
  id: string
  name: string
  title: string | null
  avatar: string | null
  dept_id: string
  dept_path: string
  dept_name: string
  company_id: string
  company_name: string
}

interface RoleRow {
  code: string
}

const PERSON_SELECT = `
  SELECT u.id, u.name, u.title, u.avatar, u.dept_id, u.dept_path, d.name AS dept_name,
         u.company_id, c.name AS company_name
    FROM users u
    JOIN departments d ON d.id = u.dept_id
    JOIN companies c ON c.id = u.company_id
   WHERE u.deleted_at IS NULL`

function toPerson(row: UserRow): PersonRow {
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    avatar: row.avatar,
    deptId: row.dept_id,
    deptPath: row.dept_path,
    deptName: row.dept_name,
    companyId: row.company_id,
    companyName: row.company_name,
  }
}

/** 列出可继续使用的成员：不传 companyId 就是整个平台（开发预览的身份下拉要跨公司才看得见隔离） */
export function listPersonas(db: Db, companyId?: string): PersonRow[] {
  const active = "AND u.status = 'active' AND u.disabled_at IS NULL"
  const rows = companyId
    ? (db
        .prepare(`${PERSON_SELECT} ${active} AND u.company_id = ? ORDER BY c.name, d.path, u.name`)
        .all(companyId) as unknown as UserRow[])
    : (db.prepare(`${PERSON_SELECT} ${active} ORDER BY c.name, d.path, u.name`).all() as unknown as UserRow[])
  return rows.map(toPerson)
}

export function findPerson(db: Db, userId: string): PersonRow | null {
  const row = db.prepare(`${PERSON_SELECT} AND u.id = ?`).get(userId) as unknown as UserRow | undefined
  return row ? toPerson(row) : null
}

/**
 * 平台内可继续使用的成员。
 * 组织同步把离职/连续缺失成员置为 disabled/departed 后，网页会话、渠道机器人
 * 和定时任务都必须按这个判断拒绝，而不是只看 deleted_at。
 */
export function findActivePerson(db: Db, userId: string): PersonRow | null {
  const row = db
    .prepare(`${PERSON_SELECT} AND u.status = 'active' AND u.disabled_at IS NULL AND u.id = ?`)
    .get(userId) as unknown as UserRow | undefined
  return row ? toPerson(row) : null
}

export function roleCodesOf(db: Db, userId: string): string[] {
  const rows = db
    .prepare(
      `SELECT r.code AS code
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = ?
        ORDER BY r.code`,
    )
    .all(userId) as unknown as RoleRow[]
  return rows.map((row) => row.code)
}

/** 控制台操作员的固定 id（不是组织成员，不参与任何"人"的统计） */
export const CONSOLE_OPERATOR_ID = 'console-operator'

/**
 * 控制台操作员：服务器侧的管理身份。
 *
 * 它不是组织里的人，也不继承任何成员角色 —— 它代表"拿到控制台口令、正在管理某家公司"。
 * 权限等价于 super_admin，但**公司范围固定在被选中的那家**，跨公司要靠切换公司再查。
 */
export function consoleActor(db: Db, companyId?: string): RequestActor {
  const company =
    (companyId
      ? (db.prepare('SELECT id, name FROM companies WHERE id = ?').get(companyId) as
          | { id: string; name: string }
          | undefined)
      : undefined) ??
    (db.prepare('SELECT id, name FROM companies ORDER BY id LIMIT 1').get() as
      | { id: string; name: string }
      | undefined)
  if (!company) {
    throw new EabError(EC.NOT_FOUND, '库里还没有任何公司', {
      hint: '首次部署请在 /admin 点击「创建第一家公司」完成初始化',
    })
  }

  const root = db
    .prepare(
      `SELECT id, name, path FROM departments
        WHERE company_id = ? AND deleted_at IS NULL
        ORDER BY path LIMIT 1`,
    )
    .get(company.id) as { id: string; name: string; path: string } | undefined
  if (!root) {
    throw new EabError(EC.NOT_FOUND, `公司 ${company.id} 还没有部门，控制台无处落权限`, {
      hint: '先同步或造该公司的组织架构',
    })
  }

  const subject = buildSubject({
    userId: CONSOLE_OPERATOR_ID,
    companyId: company.id,
    deptId: root.id,
    deptPath: root.path,
    roles: ['super_admin'],
    channelType: 'web',
    dataScopeOverride: 'global',
  })

  const person: PersonRow = {
    id: CONSOLE_OPERATOR_ID,
    name: '控制台管理员',
    title: '服务器侧管理',
    avatar: null,
    deptId: root.id,
    deptPath: root.path,
    deptName: root.name,
    companyId: company.id,
    companyName: company.name,
  }
  return { subject, person }
}

export function resolveActor(
  db: Db,
  config: ServerConfig,
  req: FastifyRequest,
  /** 单公司部署的唯一公司 ID；控制台与员工都只能用这一家 */
  _defaultCompanyId?: string,
): RequestActor {
  const canonicalCompanyId = _defaultCompanyId ?? config.companyId
  /**
   * 控制台不用组织成员登录：超级管理员账号会话（或服务令牌）有效即操作员。
   * 但要求同时带 `x-eab-console: 1` —— 否则同一个浏览器里登录过控制台之后，
   * 再打开员工对话页会被误认成操作员。两条入口靠这个标记彻底分开。
   * 单公司模式下忽略 `?company=`：控制台永远管唯一那家公司。
   */
  if (isConsoleRequest(req, config)) {
    return consoleActor(db, canonicalCompanyId)
  }

  /**
   * 真实员工登录优先于开发预览；但开发预览显式带 `?as=` 时以它为准，
   * 这样演示「不同人看到不同东西」不会因为浏览器里已有会话而失效。
   */
  const query = (req.query ?? {}) as Record<string, string | undefined>
  if (config.devAuth && typeof query.as === 'string' && query.as.length > 0) {
    const previewPerson = findActivePerson(db, query.as)
    if (!previewPerson) {
      throw new EabError(EC.NOT_FOUND, `找不到成员: ${query.as}`, { hint: '检查 ?as= 传的 userId' })
    }
    assertSingleCompany(db, previewPerson, canonicalCompanyId)
    return actorFor(db, previewPerson)
  }

  const sessionUserId = readSessionUserId(db, req)
  if (sessionUserId) {
    const sessionPerson = findActivePerson(db, sessionUserId)
    if (!sessionPerson) throw new EabError(EC.AUTH_REQUIRED, '会话对应的成员已不存在')
    assertSingleCompany(db, sessionPerson, canonicalCompanyId)
    return actorFor(db, sessionPerson)
  }

  if (!config.devAuth) {
    throw new EabError(EC.AUTH_REQUIRED, '未登录', { hint: '请到 /chat 用企业账号登录' })
  }

  const personas = listPersonas(db, canonicalCompanyId)
  if (personas.length === 0) {
    throw new EabError(EC.NOT_FOUND, '库里没有任何成员，无法预览', { hint: '先执行 pnpm dev 造演示数据' })
  }

  // 单公司模式：只在这家公司里找默认成员
  const fallback = personas.find((item) => item.companyId === canonicalCompanyId) ?? personas[0]!
  const wanted = query.as ?? fallback.id
  const person = findActivePerson(db, wanted)
  if (!person) {
    throw new EabError(EC.NOT_FOUND, `找不到成员: ${wanted}`, { hint: '检查 ?as= 传的 userId' })
  }
  assertSingleCompany(db, person, canonicalCompanyId)

  return actorFor(db, person)
}

/**
 * 单公司本地部署的边界：账号必须属于唯一那家公司，且这家公司必须是启用状态。
 * 旧库里残留的第二家公司账号即使有密码，也只能被拒绝，不能从员工入口读到本实例数据。
 */
function assertSingleCompany(db: Db, person: PersonRow, companyId: string): void {
  if (person.companyId !== companyId) {
    throw new EabError(EC.AUTH_REQUIRED, '该账号不属于当前实例的唯一公司', {
      hint: '本实例只允许一家公司、一个组织架构；旧的多公司账号已停用。',
      details: { accountCompany: person.companyId, instanceCompany: companyId },
    })
  }
  const company = db.prepare('SELECT status FROM companies WHERE id = ?').get(companyId) as
    | { status?: string }
    | undefined
  if (company?.status === 'suspended') {
    throw new EabError(EC.FORBIDDEN, '当前公司已停用，员工暂时不能登录', {
      hint: '管理员可在管理控制台「公司信息」恢复启用。',
    })
  }
}

/**
 * 从库里实时组装角色权限。
 *
 * 控制台改角色权限写的是 `role_scopes`；如果这里继续用内置的 DEFAULT_ROLE_LOOKUP，
 * 保存后下一次工具调用仍会按旧权限判断，看起来像“改了没生效”。这里以当前公司的
 * roles + role_scopes 为准，内置角色定义只作为缺失角色时的兜底。
 */
function roleLookupOf(db: Db, companyId: string): RoleLookup {
  const rows = db
    .prepare(
      `SELECT r.code, r.name, r.data_scope, r.builtin, rs.scope
         FROM roles r
         LEFT JOIN role_scopes rs ON rs.role_id = r.id
        WHERE r.company_id = ? AND r.deleted_at IS NULL
        ORDER BY r.code, rs.scope`,
    )
    .all(companyId) as unknown as Array<{
    code: string
    name: string
    data_scope: string
    builtin: number
    scope: string | null
  }>

  const definitions = new Map<string, RoleDefinition & { scopes: Scope[] }>()
  for (const row of rows) {
    let role = definitions.get(row.code)
    if (!role) {
      role = {
        code: row.code,
        name: row.name,
        dataScope: row.data_scope as DataScope,
        scopes: [],
        builtin: Boolean(row.builtin),
      }
      definitions.set(row.code, role)
    }
    if (row.scope && !role.scopes.includes(row.scope as Scope)) {
      role.scopes.push(row.scope as Scope)
    }
  }
  return createRoleLookup([...definitions.values()])
}

/** 按成员构造主体（预览矩阵/测试用）。身份只来自库里的组织数据，不来自请求参数。 */
export function actorFor(db: Db, person: PersonRow): RequestActor {
  // PERM-05：显式 allow/deny 覆盖，过期自动失效；表不存在时按无覆盖处理（老库兼容）
  let allow: string[] = []
  let deny: string[] = []
  try {
    const overrides = db
      .prepare(
        `SELECT scope, effect, expires_at FROM permission_overrides
          WHERE user_id = ? AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .all(person.id, Date.now()) as unknown as Array<{ scope: string; effect: string }>
    allow = overrides.filter((row) => row.effect === 'allow').map((row) => row.scope)
    deny = overrides.filter((row) => row.effect === 'deny').map((row) => row.scope)
  } catch {
    allow = []
    deny = []
  }

  const roleCodes = roleCodesOf(db, person.id)
  const roleLookup = roleLookupOf(db, person.companyId)
  const subject = buildSubject({
    userId: person.id,
    companyId: person.companyId,
    deptId: person.deptId,
    deptPath: person.deptPath,
    // 从渠道同步进来的成员还没有分配角色；按“普通员工”兜底，避免整站无权限
    roles: roleCodes.length > 0 ? roleCodes : ['member'],
    channelType: 'web',
    extraScopes: allow.length > 0 ? (allow as Scope[]) : undefined,
    deniedScopes: deny.length > 0 ? (deny as Scope[]) : undefined,
    roleLookup,
  })

  return { subject, person }
}
