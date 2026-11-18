/**
 * 成员后台访问相关接口：
 * - `POST /api/console/unified-login`：统一登录页，先校验平台管理员，再校验公司成员；
 * - `POST /api/console/member/login`：公司成员账号密码登录后台（兼容旧入口）；
 * - `GET /api/console/access`：当前后台身份能看/能管哪些页面；
 * - `GET/PUT /api/console/member-console-permissions/:userId`：平台管理员配置成员的页面权限；
 * - `GET /api/console/overview`：概览聚合，避免只给“概览”权限的成员去读其它页面明细；
 * - `GET /api/me/console-entry`：对话页判断是否显示“管理后台”入口；
 * - `POST /api/me/console-entry/session`：从对话页按当前员工身份签发成员后台会话（SSO），并清掉平台超管 Cookie。
 */
import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { EC, EabError, normalizeMobile } from '@eab/domain'
import { appendAudit } from '@eab/storage'
import type { ServerDeps } from '../deps.js'
import { ok } from '../http.js'
import { verifyPassword } from '../password.js'
import {
  clearMemberSessionCookie,
  clearSessionCookie,
  createSession,
  isConsoleRequest,
  isLoopback,
  memberSessionFromRequest,
  sessionCookie,
  sessionFromRequest,
  verifyAdminCredentials,
} from '../console-auth.js'
import { effectiveNetwork } from '../network-settings.js'
import { createConsoleMemberSession, readConsoleMemberSession } from '../console-member-session.js'
import {
  canConfigureMemberConsoleAccess,
  consoleActionParentPages,
  consoleActionsByPage,
  consolePermissionCatalog,
  consoleVisibleParentPages,
  hasAnyConsolePagePermission,
  readConsolePagePermissions,
  readMemberConsolePagePermissions,
  readUserRoleConsolePagePermissions,
  saveConsolePagePermissions,
} from '../console-permissions.js'
import { CONSOLE_PAGE_KEYS, consolePageActionMetas, consolePageSections } from '../console-pages.js'
import { readSessionUserId } from '../employee-session.js'
import { findActivePerson, findPerson, roleCodesOf } from '../session.js'

interface MemberRow {
  id: string
  company_id: string
  name: string
  employee_no: string | null
  email: string | null
  mobile: string | null
  password_hash: string | null
  status: string
  disabled_at: number | null
  deleted_at: number | null
}

const FAIL_LIMIT = 5
const LOCK_MS = 10 * 60 * 1000

function failKey(req: FastifyRequest, account: string): string {
  return `console-member:${req.ip ?? ''}:${account.toLowerCase()}`
}

function checkLock(db: ServerDeps['db'], key: string): void {
  const row = db.prepare('SELECT locked_until FROM login_attempts WHERE key = ?').get(key) as
    | { locked_until: number | null }
    | undefined
  if (row?.locked_until && row.locked_until > Date.now()) {
    const minutes = Math.max(1, Math.ceil((row.locked_until - Date.now()) / 60_000))
    throw new EabError(EC.RATE_LIMITED, `登录失败次数过多，请 ${minutes} 分钟后再试`)
  }
}

function recordFail(db: ServerDeps['db'], key: string): void {
  const now = Date.now()
  const row = db.prepare('SELECT fail_count FROM login_attempts WHERE key = ?').get(key) as
    | { fail_count: number }
    | undefined
  const count = (row?.fail_count ?? 0) + 1
  const lockedUntil = count >= FAIL_LIMIT ? now + LOCK_MS : null
  db.prepare(
    `INSERT INTO login_attempts (key, fail_count, locked_until, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET fail_count = excluded.fail_count,
       locked_until = excluded.locked_until, updated_at = excluded.updated_at`,
  ).run(key, lockedUntil ? 0 : count, lockedUntil, now)
}

function clearFails(db: ServerDeps['db'], key: string): void {
  db.prepare('DELETE FROM login_attempts WHERE key = ?').run(key)
}

function isPlatformRequest(req: FastifyRequest, deps: ServerDeps): boolean {
  if (sessionFromRequest(req)) return true
  if (!isConsoleRequest(req, deps.config)) return false
  // 成员 Cookie 也满足 isConsoleRequest，这里必须排除，避免成员冒充平台管理员。
  const token = String(req.headers['x-eab-console-token'] ?? '').trim()
  const expected = deps.config.consoleToken ?? ''
  if (!token || !expected) return false
  const left = Buffer.from(token)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * 配置成员后台访问的授权入口。
 *
 * 平台管理员始终可以操作；成员账号必须拥有「成员管理 → 后台访问 → 配置后台访问」，
 * 这样这项设置本身就是可授权的，而不是只能由平台管理员代配。
 */
function requireMemberConsoleAdmin(req: FastifyRequest, deps: ServerDeps): { actorUserId: string | null } {
  if (isPlatformRequest(req, deps)) return { actorUserId: null }
  const session = readConsoleMemberSession(deps.db, req)
  if (!session) throw new EabError(EC.AUTH_REQUIRED, '成员后台会话已失效，请重新登录管理后台')
  const permissions = readConsolePagePermissions(deps.db, session.companyId, session.userId)
  if (!canConfigureMemberConsoleAccess(permissions)) {
    throw new EabError(EC.FORBIDDEN, '当前后台账号没有配置成员后台访问的权限', {
      hint: '让平台管理员或有权限的成员在「成员管理 → 后台访问」里勾选“配置后台访问”。',
    })
  }
  return { actorUserId: session.userId }
}

function memberPayload(db: ServerDeps['db'], companyId: string, userId: string) {
  const person = findPerson(db, userId)
  const roles = roleCodesOf(db, userId)
  const account = db
    .prepare('SELECT employee_no, email, mobile FROM users WHERE id = ?')
    .get(userId) as { employee_no: string | null; email: string | null; mobile: string | null } | undefined
  const permissions = readConsolePagePermissions(db, companyId, userId)
  const actionsByPage = consoleActionsByPage(permissions)
  const allowedPages = consoleVisibleParentPages(permissions)
  const managePages = consoleActionParentPages(permissions, 'create')
    .concat(consoleActionParentPages(permissions, 'edit'), consoleActionParentPages(permissions, 'delete'))
  return {
    id: userId,
    name: person?.name ?? '成员',
    account: account?.employee_no || account?.email || account?.mobile || null,
    roles,
    pages: [...permissions.values()],
    allowedPages,
    managePages: [...new Set(managePages)],
    createPages: consoleActionParentPages(permissions, 'create'),
    editPages: consoleActionParentPages(permissions, 'edit'),
    deletePages: consoleActionParentPages(permissions, 'delete'),
    actionsByPage,
    canConfigureAccess: canConfigureMemberConsoleAccess(permissions),
  }
}

function accessPayload(db: ServerDeps['db'], companyId: string) {
  const company = db.prepare('SELECT id, name FROM companies WHERE id = ?').get(companyId) as
    | { id: string; name: string }
    | undefined
  return {
    catalog: consolePermissionCatalog(),
    company: company ?? { id: companyId, name: companyId },
  }
}

/**
 * 账号密码登录成员后台。统一登录页与管理后台成员登录共用这段，
 * 避免两套入口在权限、锁定和审计口径上漂移。
 */
async function loginMemberByPassword(
  deps: ServerDeps,
  req: FastifyRequest,
  reply: FastifyReply,
  account: string,
  password: string,
  source: 'web' | 'unified' = 'web',
) {
  if (!account || !password) throw new EabError(EC.VALIDATION, '请输入账号和密码')
  const key = failKey(req, account)
  checkLock(deps.db, key)
  const mobileAccount = normalizeMobile(account)

  const row = deps.db
    .prepare(
      `SELECT id, company_id, name, employee_no, email, mobile, password_hash, status, disabled_at, deleted_at
         FROM users
        WHERE lower(employee_no) = lower(?) OR lower(email) = lower(?)
           OR (mobile IS NOT NULL AND mobile <> '' AND (mobile = ? OR mobile = ?))
        ORDER BY created_at LIMIT 1`,
    )
    .get(account, account, mobileAccount, account) as unknown as MemberRow | undefined

  if (!row || !row.password_hash || !verifyPassword(row.password_hash, password)) {
    recordFail(deps.db, key)
    throw new EabError(EC.AUTH_REQUIRED, '账号或密码不正确', {
      hint: '账号是工号、邮箱或手机号；连续错 5 次会锁定 10 分钟。',
    })
  }
  if (row.status !== 'active' || row.disabled_at !== null || row.deleted_at !== null) {
    throw new EabError(EC.FORBIDDEN, '该账号已停用，请联系管理员')
  }
  if (row.company_id !== deps.companyId) {
    throw new EabError(EC.FORBIDDEN, '该账号不属于当前实例的唯一公司')
  }
  const companyStatus = deps.db.prepare('SELECT status FROM companies WHERE id = ?').get(deps.companyId) as
    | { status?: string }
    | undefined
  if (companyStatus?.status === 'suspended') {
    throw new EabError(EC.FORBIDDEN, '当前公司已停用，暂时不能登录管理后台')
  }
  if (!hasAnyConsolePagePermission(deps.db, row.company_id, row.id)) {
    throw new EabError(EC.FORBIDDEN, '该成员还没有开通后台访问权限', {
      hint: '让平台管理员在「角色管理 → 角色权限 → 后台访问」给角色配置页面，或保留「成员管理 → 角色权限 → 后台访问」的个人配置。',
    })
  }

  clearFails(deps.db, key)
  const session = createConsoleMemberSession(deps.db, row.id, row.company_id, req)
  // 同时清掉平台超管 Cookie，避免成员登录后仍带着旧超管身份。
  reply.header('set-cookie', [clearSessionCookie(), session.cookie])
  appendAudit(deps.db, {
    companyId: row.company_id,
    actorUserId: row.id,
    action: 'console.member.login',
    resourceType: 'session',
    result: 'success',
    ip: req.ip ?? null,
    channel: 'web',
    detail: { account, source },
  })
  return ok({ kind: 'member', ...memberPayload(deps.db, row.company_id, row.id), redirect: '/admin' })
}

export function registerConsoleAccessRoutes(app: FastifyInstance, deps: ServerDeps): void {
  /**
   * 对话页和后台分端口部署，入口必须使用后台端口；只换相对 /admin 会落到对话端口。
   */
  function consoleEntryHref(req: FastifyRequest): string {
    const host = String(req.headers.host ?? '127.0.0.1').split(':')[0]
    return `http://${host}:${deps.config.adminPort}/admin`
  }

  /**
   * 统一登录入口：先按平台管理员账号校验，不匹配再按公司成员账号校验。
   * 平台管理员仍保留本机/显式放行网络的限制，成员不受影响。
   */
  app.post<{ Body: { account?: string; username?: string; password?: string } }>(
    '/api/console/unified-login',
    async (req, reply) => {
      const account = String(req.body?.account ?? req.body?.username ?? '').trim()
      const password = String(req.body?.password ?? '')
      if (!account || !password) throw new EabError(EC.VALIDATION, '请输入账号和密码')

      if (verifyAdminCredentials(deps.config, account, password)) {
        if (!effectiveNetwork(deps.config).allowRemoteConsole && !isLoopback(req.ip)) {
          throw new EabError(EC.FORBIDDEN, '平台管理员只允许在服务器本机登录', {
            hint: '公司成员请使用工号、邮箱或手机号登录；如需远程管理，请配置 EAB_CONSOLE_ALLOW_REMOTE=1 并配合内网或隧道。',
          })
        }
        const session = createSession(account, req.ip ?? '')
        reply.header('set-cookie', [clearMemberSessionCookie(), sessionCookie(session)])
        return ok({ kind: 'platform', user: session.user, redirect: '/admin' })
      }

      return loginMemberByPassword(deps, req, reply, account, password, 'unified')
    },
  )

  /**
   * 成员登录后台：和对话页账号密码同一套账号（工号/邮箱/手机号）。
   * 登录成功后签发成员后台 Cookie；没有页面权限的成员即使密码正确也拒绝。
   */
  app.post<{ Body: { account?: string; password?: string; company?: string } }>(
    '/api/console/member/login',
    async (req, reply) => {
      const account = String(req.body?.account ?? '').trim()
      const password = String(req.body?.password ?? '')
      return loginMemberByPassword(deps, req, reply, account, password, 'web')
    },
  )

  /** 当前后台身份的页面权限；平台管理员返回全量可管理。 */
  app.get('/api/console/access', async (req) => {
    const memberToken = memberSessionFromRequest(req)
    if (memberToken) {
      const session = readConsoleMemberSession(deps.db, req)
      if (!session) throw new EabError(EC.AUTH_REQUIRED, '成员后台会话已失效，请重新登录')
      return ok({
        kind: 'member',
        ...memberPayload(deps.db, session.companyId, session.userId),
        ...accessPayload(deps.db, session.companyId),
      })
    }
    if (isPlatformRequest(req, deps)) {
      const companyId = deps.companyId
      const sections = CONSOLE_PAGE_KEYS.flatMap((page) =>
        consolePageSections(page).map((section) => ({
          page: `${page}:${section.key}`,
          parentPage: page,
          section: section.key,
          canView: true,
          canCreate: true,
          canEdit: true,
          canDelete: true,
          canManage: true,
        })),
      )
      const pages = [
        ...CONSOLE_PAGE_KEYS.map((page) => ({
          page,
          parentPage: page,
          canView: true,
          canCreate: true,
          canEdit: true,
          canDelete: true,
          canManage: true,
        })),
        ...sections,
      ]
      const actionsByPage = {
        ...Object.fromEntries(
          CONSOLE_PAGE_KEYS.map((page) => [page, consolePageActionMetas(page).map((meta) => meta.id)]),
        ),
        ...Object.fromEntries(
          CONSOLE_PAGE_KEYS.flatMap((page) =>
            consolePageSections(page).map((section) => [
              `${page}:${section.key}`,
              section.actions.map((meta) => meta.id),
            ]),
          ),
        ),
      }
      return ok({
        kind: 'platform',
        id: 'console-operator',
        name: '平台管理员',
        displayName: '平台管理员',
        account: deps.config.adminUser,
        roles: ['super_admin'],
        pages,
        allowedPages: [...CONSOLE_PAGE_KEYS],
        managePages: [...CONSOLE_PAGE_KEYS],
        createPages: [...CONSOLE_PAGE_KEYS],
        editPages: [...CONSOLE_PAGE_KEYS],
        deletePages: [...CONSOLE_PAGE_KEYS],
        actionsByPage,
        ...accessPayload(deps.db, companyId),
        canConfigureAccess: true,
      })
    }
    throw new EabError(EC.AUTH_REQUIRED, '请先登录管理后台')
  })

  /** 平台管理员或已授权成员读取某个成员的页面权限。 */
  app.get<{ Params: { userId: string } }>(
    '/api/console/member-console-permissions/:userId',
    async (req) => {
      requireMemberConsoleAdmin(req, deps)
      const userId = req.params.userId
      const person = findPerson(deps.db, userId)
      if (!person) throw new EabError(EC.NOT_FOUND, '成员不存在')
      if (person.companyId !== deps.companyId) throw new EabError(EC.FORBIDDEN, '成员不属于当前实例公司')
      const permissions = readMemberConsolePagePermissions(deps.db, person.companyId, person.id)
      const rolePermissions = readUserRoleConsolePagePermissions(deps.db, person.companyId, person.id)
      return ok({
        user: { id: person.id, name: person.name },
        ...accessPayload(deps.db, person.companyId),
        pages: [...permissions.values()],
        allowedPages: consoleVisibleParentPages(permissions),
        managePages: [...new Set([
          ...consoleActionParentPages(permissions, 'create'),
          ...consoleActionParentPages(permissions, 'edit'),
          ...consoleActionParentPages(permissions, 'delete'),
        ])],
        createPages: consoleActionParentPages(permissions, 'create'),
        editPages: consoleActionParentPages(permissions, 'edit'),
        deletePages: consoleActionParentPages(permissions, 'delete'),
        actionsByPage: consoleActionsByPage(permissions),
        rolePages: [...rolePermissions.values()],
        roleAllowedPages: consoleVisibleParentPages(rolePermissions),
        roleActionsByPage: consoleActionsByPage(rolePermissions),
      })
    },
  )

  /** 平台管理员或已授权成员全量保存某个成员的页面权限；传空数组等于收回全部后台权限。 */
  app.put<{
    Params: { userId: string }
    Body: {
      pages?: Array<{
        page?: string
        section?: string
        canView?: boolean
        canCreate?: boolean
        canEdit?: boolean
        canDelete?: boolean
        canManage?: boolean
      }>
    }
  }>('/api/console/member-console-permissions/:userId', async (req) => {
    const { actorUserId } = requireMemberConsoleAdmin(req, deps)
    const userId = req.params.userId
    const person = findPerson(deps.db, userId)
    if (!person) throw new EabError(EC.NOT_FOUND, '成员不存在')
    if (person.companyId !== deps.companyId) throw new EabError(EC.FORBIDDEN, '成员不属于当前实例公司')
    const entries = Array.isArray(req.body?.pages) ? req.body.pages : []
    const permissions = saveConsolePagePermissions(
      deps.db,
      person.companyId,
      person.id,
      entries.map((item) => ({
        page: String(item.page ?? ''),
        section: item.section ? String(item.section) : undefined,
        canView: item.canView === true,
        canCreate: item.canCreate === true,
        canEdit: item.canEdit === true,
        canDelete: item.canDelete === true,
        canManage: item.canManage === true,
      })),
      actorUserId ?? 'console-operator',
    )
    appendAudit(deps.db, {
      companyId: person.companyId,
      actorUserId,
      action: 'console.member.permissions.update',
      resourceType: 'member',
      resourceId: person.id,
      result: 'success',
      channel: 'web',
      detail: { pages: [...permissions.values()] },
    })
    const rolePermissions = readUserRoleConsolePagePermissions(deps.db, person.companyId, person.id)
    return ok({
      user: { id: person.id, name: person.name },
      ...accessPayload(deps.db, person.companyId),
      pages: [...permissions.values()],
      allowedPages: consoleVisibleParentPages(permissions),
      managePages: [...new Set([
        ...consoleActionParentPages(permissions, 'create'),
        ...consoleActionParentPages(permissions, 'edit'),
        ...consoleActionParentPages(permissions, 'delete'),
      ])],
      createPages: consoleActionParentPages(permissions, 'create'),
      editPages: consoleActionParentPages(permissions, 'edit'),
      deletePages: consoleActionParentPages(permissions, 'delete'),
      actionsByPage: consoleActionsByPage(permissions),
      rolePages: [...rolePermissions.values()],
      roleAllowedPages: consoleVisibleParentPages(rolePermissions),
      roleActionsByPage: consoleActionsByPage(rolePermissions),
    })
  })

  /**
   * 概览聚合：只给概览权限的成员不需要再读 roles/providers/models/channels/plugins 明细。
   */
  app.get('/api/console/overview', async (_req) => {
    const count = (sql: string, ...params: unknown[]): number => {
      try {
        const row = deps.db.prepare(sql).get(...(params as never[])) as { n?: number } | undefined
        return Number(row?.n ?? 0)
      } catch {
        return 0
      }
    }
    const companyId = deps.companyId
    const counts = {
      members: count(
        "SELECT COUNT(*) AS n FROM users WHERE company_id = ? AND deleted_at IS NULL AND status = 'active'",
        companyId,
      ),
      departments: count('SELECT COUNT(*) AS n FROM departments WHERE company_id = ?', companyId),
      roles: count('SELECT COUNT(*) AS n FROM roles WHERE company_id = ?', companyId),
      kbCollections: count('SELECT COUNT(*) AS n FROM kb_collections WHERE company_id = ?', companyId),
      providers: count('SELECT COUNT(*) AS n FROM model_providers WHERE company_id = ?', companyId),
      models: count('SELECT COUNT(*) AS n FROM models WHERE company_id = ?', companyId),
      channels: count('SELECT COUNT(*) AS n FROM channel_configs WHERE company_id = ? AND enabled = 1', companyId),
      plugins: count('SELECT COUNT(*) AS n FROM plugin_installs WHERE removed_at IS NULL'),
      consoleMembers: count('SELECT COUNT(DISTINCT user_id) AS n FROM console_page_permissions WHERE company_id = ?', companyId),
    }
    const channels = deps.db
      .prepare(
        `SELECT provider, enabled, status, tenant_name
           FROM channel_configs WHERE company_id = ?
          ORDER BY provider`,
      )
      .all(companyId) as unknown as Array<{ provider: string; enabled: number; status: string; tenant_name: string | null }>
    let recent: Array<{ action: string; actorName: string | null; result: string; at: number }> = []
    try {
      recent = deps.db
        .prepare(
          `SELECT a.action, a.result, a.created_at AS at, u.name AS actorName
             FROM audit_logs a
             LEFT JOIN users u ON u.id = a.actor_user_id
            WHERE a.company_id = ?
            ORDER BY a.created_at DESC LIMIT 6`,
        )
        .all(companyId) as unknown as typeof recent
    } catch {
      recent = []
    }
    const company = deps.db.prepare('SELECT id, name, status FROM companies WHERE id = ?').get(companyId) as
      | { id: string; name: string; status: string }
      | undefined
    return ok({ company: company ?? null, counts, channels, recent })
  })

  /**
   * 对话页入口：只有成员在当前公司拥有至少一个后台页面权限时才返回 true。
   * 只判断是否显示入口，不签发后台会话；真正进入后台走下面的 SSO 接口。
   */
  app.get('/api/me/console-entry', async (req) => {
    let userId = ''
    try {
      userId = readSessionUserId(deps.db, req) ?? ''
    } catch {
      userId = ''
    }
    const member = userId ? findActivePerson(deps.db, userId) : null
    if (!member || member.companyId !== deps.companyId) {
      return ok({ visible: false, reason: 'not_logged_in' })
    }
    const visible = hasAnyConsolePagePermission(deps.db, member.companyId, member.id)
    return ok({
      visible,
      href: consoleEntryHref(req),
      reason: visible ? 'allowed' : 'no_console_permission',
    })
  })

  /**
   * 从员工对话页直接进入本人管理后台。
   *
   * 员工会话和后台会话是两套 Cookie；只给 `/admin` 链接会把浏览器里残留的
   * 平台管理员身份带过去。这里用当前员工身份签发成员后台会话，并清掉平台
   * 超管 Cookie，保证进入的一定是本人、且只能看到本人被授权的页面。
   */
  app.post('/api/me/console-entry/session', async (req, reply) => {
    if (String(req.headers['x-eab-console-entry'] ?? '') !== '1') {
      throw new EabError(EC.FORBIDDEN, '请从对话页点击“管理后台”进入')
    }
    let userId = ''
    try {
      userId = readSessionUserId(deps.db, req) ?? ''
    } catch {
      userId = ''
    }
    const member = userId ? findActivePerson(deps.db, userId) : null
    if (!member || member.companyId !== deps.companyId) {
      throw new EabError(EC.AUTH_REQUIRED, '员工会话已失效，请重新登录对话页')
    }
    if (!hasAnyConsolePagePermission(deps.db, member.companyId, member.id)) {
      throw new EabError(EC.FORBIDDEN, '当前账号还没有开通管理后台权限', {
        hint: '请联系平台管理员在「成员管理 → 角色权限 → 后台访问」里为你开通页面。',
      })
    }
    const session = createConsoleMemberSession(deps.db, member.id, member.companyId, req)
    reply.header('set-cookie', [clearSessionCookie(), session.cookie])
    appendAudit(deps.db, {
      companyId: member.companyId,
      actorUserId: member.id,
      action: 'console.member.sso',
      resourceType: 'session',
      result: 'success',
      ip: req.ip ?? null,
      channel: 'web',
      detail: { via: 'chat-console-entry' },
    })
    return ok({
      visible: true,
      kind: 'member',
      userId: member.id,
      name: member.name,
      href: consoleEntryHref(req),
    })
  })
}
