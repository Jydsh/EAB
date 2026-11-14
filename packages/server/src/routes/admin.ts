/**
 * 控制台「真正能配置」的写接口：组织、成员、公司、审计、用量、审批、备份。
 *
 * 只给控制台会话用（x-eab-console: 1）；所有写操作都先校验再落库，并写审计。
 * 这些接口与页面一一对应，不靠脚本造数据。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { mkdirSync, existsSync, statSync, readdirSync, readFileSync, unlinkSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { basename, dirname, join, resolve as resolvePath } from 'node:path'
import QRCode from 'qrcode'
import { EC, EabError, isKnownScope, normalizeMobile, ulid } from '@eab/domain'
import { BUILTIN_ROLES } from '@eab/authz'
import { appendAudit, verifyAuditChain } from '@eab/storage'
import { SqliteAuditReadSource } from '../backends/audit-read.js'
import {
  applyOrgSync,
  fetchChannelOrg,
  fetchDingTalkTenant,
  mapRemoteOrg,
  pollDingTalkRegistration,
  startDingTalkRegistration,
} from '@eab/channel'
import type { ServerDeps } from '../deps.js'
import { ok } from '../http.js'
import { resolveActor } from '../session.js'
import { isConsoleRequest } from '../console-auth.js'
import { hashPassword } from '../password.js'
import { revokeAllSessions } from '../employee-session.js'
import { resolveSecret, storeSecret } from '../secrets.js'
import { companyAssistantView, resolveAssistantDataDir, saveCompanyAssistant } from '../company-assistant.js'
import { refreshDingTalkStream } from '../dingtalk-bot.js'
import { createRuntimeBackup } from '../runtime-backup.js'
import { recordSkillApprovalDecision } from '../skills.js'

function requireConsole(req: FastifyRequest, deps: ServerDeps): void {
  if (!isConsoleRequest(req, deps.config)) {
    throw new EabError(EC.AUTH_REQUIRED, '需要控制台会话（请先在 /admin 登录）')
  }
}

function companyOf(req: FastifyRequest, deps: ServerDeps): string {
  return resolveActor(deps.db, deps.config, req, deps.companyId).subject.companyId
}

function audit(
  deps: ServerDeps,
  req: FastifyRequest,
  companyId: string,
  action: string,
  resourceType: string,
  resourceId: string | null,
  detail?: Record<string, unknown>,
): void {
  appendAudit(deps.db, {
    companyId,
    actorUserId: 'console-operator',
    action,
    resourceType,
    resourceId,
    result: 'success',
    detail,
    ip: req.ip ?? null,
    channel: 'console',
  })
}

/** 欢迎语里的网页工作台地址：用当前控制台请求的 host，把端口换成员工端端口。 */
function publicChatUrl(req: FastifyRequest, deps: ServerDeps): string {
  const forwardedHost = String(req.headers['x-forwarded-host'] ?? '').split(',')[0]?.trim()
  const rawHost = forwardedHost || String(req.headers.host ?? '').trim()
  const hostname = rawHost.startsWith('[')
    ? rawHost.slice(0, rawHost.indexOf(']') + 1)
    : rawHost.split(':')[0]
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim() || 'http'
  const host = hostname && hostname !== '0.0.0.0' ? hostname : '127.0.0.1'
  return `${proto === 'https' ? 'https' : 'http'}://${host}:${deps.config.port}/chat`
}

/** 备份目录：优先用控制台配置的独立路径，没配则跟随数据库同级 backups。 */
function backupDir(deps: ServerDeps): string {
  return deps.config.backupsDir ?? resolvePath(deps.config.dbPath, '..', 'backups')
}

/** 运行数据备份目录只在 manifest 存在时才算完成；列表统一读 manifest 里的 size。 */
function runtimeBackupManifest(file: string): { size: number } | null {
  const manifest = join(file, 'manifest.json')
  if (!existsSync(manifest)) return null
  try {
    const raw = JSON.parse(readFileSync(manifest, 'utf8')) as { format?: string; size?: unknown }
    if (raw.format !== 'eab-runtime-backup-v1') return null
    return { size: Number(raw.size) || 0 }
  } catch {
    return null
  }
}

/** 备份操作只接受备份目录下的文件名/运行数据快照目录，避免把任意路径带进删除或打开动作。 */
function resolveBackupFile(
  deps: ServerDeps,
  rawName: unknown,
): { dir: string; file: string; size: number; kind: 'database' | 'runtime' } {
  const name = String(rawName ?? '')
  if (!name || name !== basename(name) || name.includes('..')) {
    throw new EabError(EC.VALIDATION, '备份文件名不合法')
  }
  const dir = backupDir(deps)
  const file = join(dir, name)
  if (!existsSync(file)) throw new EabError(EC.NOT_FOUND, '备份不存在')
  const stat = statSync(file)
  if (name.endsWith('.db') && stat.isFile()) return { dir, file, size: stat.size, kind: 'database' }
  if (name.startsWith('eab-runtime-') && stat.isDirectory()) {
    // 只有带 manifest 的目录才是完整快照；复制到一半的目录不暴露给列表/删除。
    const manifest = runtimeBackupManifest(file)
    if (!manifest) throw new EabError(EC.NOT_FOUND, '备份尚未完成')
    return { dir, file, size: manifest.size, kind: 'runtime' }
  }
  throw new EabError(EC.VALIDATION, '备份类型不合法')
}

function text(value: unknown, field: string, max = 200): string {
  const out = String(value ?? '').trim()
  if (!out) throw new EabError(EC.VALIDATION, `${field} 不能为空`)
  if (out.length > max) throw new EabError(EC.VALIDATION, `${field} 最多 ${max} 字`)
  return out
}

function optionalText(value: unknown, max = 200): string | null {
  if (value === undefined || value === null) return null
  const out = String(value).trim()
  if (!out) return null
  if (out.length > max) throw new EabError(EC.VALIDATION, `字段最多 ${max} 字`)
  return out
}

/**
 * 员工端登录时账号会同时匹配工号、邮箱和手机号（见 auth.ts 的登录查询）。
 * 新建管理员前按同一口径查占用，避免只查工号时仍然撞掉已有登录身份。
 */
function findAccountOwner(deps: ServerDeps, account: string): { id: string; name: string } | undefined {
  const mobileAccount = normalizeMobile(account)
  return deps.db
    .prepare(
      `SELECT id, name FROM users
        WHERE lower(employee_no) = lower(?) OR lower(email) = lower(?)
           OR (mobile IS NOT NULL AND mobile <> '' AND (mobile = ? OR mobile = ?))
        ORDER BY created_at LIMIT 1`,
    )
    .get(account, account, mobileAccount, account) as { id: string; name: string } | undefined
}

interface DeptRow {
  id: string
  name: string
  parent_id: string | null
  path: string
  depth: number
}

function deptOf(deps: ServerDeps, companyId: string, deptId: string): DeptRow {
  const row = deps.db
    .prepare(
      'SELECT id, name, parent_id, path, depth FROM departments WHERE id = ? AND company_id = ? AND deleted_at IS NULL',
    )
    .get(deptId, companyId) as DeptRow | undefined
  if (!row) throw new EabError(EC.NOT_FOUND, '部门不存在或不属于当前公司')
  return row
}

/**
 * 用一套钉钉应用凭证读企业名与通讯录，失败时翻译成可操作的中文提示。
 * 手工填凭证开通与扫码开通共用这段，保证两条入口的报错口径一致。
 */
async function readDingTalkOrg(appId: string, corpId: string, appSecret: string) {
  try {
    const tenant = await fetchDingTalkTenant({ provider: 'dingtalk', appId, corpId, appSecret })
    const remote = await fetchChannelOrg('dingtalk', { provider: 'dingtalk', appId, corpId, appSecret })
    return { tenant, remote }
  } catch (err) {
    const raw = (err as Error).message
    if (/invalidClientIdOrSecret|无效的clientId|invalid appkey|invalid appsecret/i.test(raw)) {
      throw new EabError(EC.UPSTREAM, '钉钉应用凭证不匹配：AppKey 与 AppSecret 不属于同一个应用', {
        hint: '请在钉钉开发者后台「凭证与基础信息」里重新复制当前 AppSecret。',
        details: { reason: 'invalid_credentials', original: raw.slice(0, 400) },
        cause: err,
      })
    }
    if (/60011|应用尚未开通|requiredScopes/.test(raw)) {
      const parsedScopes = (raw.match(/requiredScopes=\[([^\]]+)\]/)?.[1] ?? '')
        .split(',')
        .map((scope) => scope.trim())
        .filter(Boolean)
      const requiredScopes = parsedScopes.length
        ? parsedScopes
        : ['qyapi_get_department_list', 'qyapi_get_member', 'qyapi_get_department_member']
      throw new EabError(EC.UPSTREAM, `钉钉应用权限未生效（60011）：钉钉这次要求 ${requiredScopes.join('、')}`, {
        hint: '权限页显示「已开通」还不够；到「版本管理与发布」发布新版本，状态变成「已上线」后再试。拉成员列表用的是 qyapi_get_department_member。',
        details: {
          reason: 'permission_not_effective',
          requiredScopes,
          applyUrls: Object.fromEntries(
            requiredScopes.map((scope) => [
              scope,
              `https://open-dev.dingtalk.com/appscope/apply?content=${encodeURIComponent(`${appId}#${scope}`)}`,
            ]),
          ),
          versionUrl: 'https://open-dev.dingtalk.com/fe/ai',
          original: raw.slice(0, 400),
        },
        cause: err,
      })
    }
    throw new EabError(EC.UPSTREAM, `钉钉通讯录读取失败：${raw}`, {
      hint: '确认 AppKey/AppSecret/CorpId 匹配，且通讯录权限范围包含要同步的部门与成员。',
      cause: err,
    })
  }
}

/** 建公司 + 根部门 + 内置角色副本 + 渠道绑定，再落通讯录。 */
export async function createDingTalkCompany(
  deps: ServerDeps,
  req: FastifyRequest,
  input: {
    appId: string
    appSecret: string
    corpId: string
    tenant: { tenantId: string; name: string }
    remote: Awaited<ReturnType<typeof fetchChannelOrg>>
    companyName?: string
    slug?: string
    actorLabel: string
    action: string
    /** 普通企业内部应用机器人：手工绑定与扫码共用这些字段 */
    robotCode?: string | null
    agentId?: string | null
    robotMode?: string | null
    unifiedAppId?: string | null
    botBoundAt?: number | null
    botBoundBy?: string | null
    extra?: Record<string, unknown>
  },
): Promise<{
  company: {
    id: string
    name: string
    slug: string
    rootDeptId: string
    provider: string
    tenantId: string
    tenantName: string
  }
  sync: { runId: string; departments: number; members: number }
}> {
  const boundElsewhere = deps.db
    .prepare(`SELECT company_id FROM channel_configs WHERE provider = 'dingtalk' AND tenant_id = ?`)
    .get(input.tenant.tenantId) as { company_id?: string } | undefined
  if (boundElsewhere?.company_id) {
    throw new EabError(EC.CONFLICT, '该钉钉企业已经开通过一家 EAB 公司', {
      hint: '同一钉钉 CorpId 只能对应一家公司；请直接登录那家公司，或先在原公司解绑。',
      details: { tenantId: input.tenant.tenantId, boundTo: boundElsewhere.company_id },
    })
  }
  /**
   * 单公司实例：库里已有公司时，绝不再通过扫码建第二家。
   * 但「已有公司但还没绑钉钉」是首次绑定的正常状态：把这次扫码的应用绑到它，
   * 复用现有根部门与角色，再把通讯录同步进来。
   */
  const existingCompany = deps.db
    .prepare('SELECT id, name, slug FROM companies ORDER BY created_at ASC LIMIT 1')
    .get() as { id: string; name: string; slug: string } | undefined
  if (existingCompany) {
    if (existingCompany.id !== deps.companyId) {
      throw new EabError(EC.CONFLICT, '当前实例已经有一家公司，不能再建第二家', {
        hint: '单公司本地部署只允许一个组织架构；请先删除或清理旧公司。',
        details: { existingCompany: existingCompany.id },
      })
    }
    const root = deps.db
      .prepare(
        `SELECT id, path, depth FROM departments
          WHERE company_id = ? AND parent_id IS NULL AND deleted_at IS NULL
          ORDER BY path LIMIT 1`,
      )
      .get(existingCompany.id) as { id: string; path: string; depth: number } | undefined
    if (!root) throw new EabError(EC.CONFLICT, '公司没有根部门，无法绑定组织', { hint: '先删除公司回到空库，再重新绑定机器人。' })

    const now = Date.now()
    const secretRef = storeSecret(deps.config.dbPath, null, input.appSecret, 'EAB_DINGTALK_APP_SECRET')
    const oldChannel = deps.db
      .prepare(`SELECT tenant_id FROM channel_configs WHERE company_id = ? AND provider = 'dingtalk'`)
      .get(existingCompany.id) as { tenant_id?: string | null } | undefined
    if (oldChannel?.tenant_id && oldChannel.tenant_id !== input.tenant.tenantId) {
      // 换绑到另一家钉钉企业：旧的外部账号映射必须先失效，避免旧组织的人还能扫码登录
      deps.db
        .prepare(`DELETE FROM channel_identities WHERE company_id = ? AND provider = 'dingtalk'`)
        .run(existingCompany.id)
    }
    const update = deps.db
      .prepare(
        `UPDATE channel_configs
            SET app_id = ?, corp_id = ?, secret_ref = ?, tenant_id = ?, tenant_name = ?,
                status = 'bound', enabled = 1, bound_at = COALESCE(bound_at, ?),
                bound_by_user_id = ?,
                robot_code = ?,
                agent_id = ?,
                robot_mode = ?,
                unified_app_id = ?,
                bot_bound_at = ?,
                bot_bound_by_user_id = ?,
                updated_at = ?
          WHERE company_id = ? AND provider = 'dingtalk'`,
      )
      .run(
        input.appId,
        input.corpId,
        secretRef,
        input.tenant.tenantId,
        input.tenant.name,
        now,
        input.actorLabel,
        input.robotCode ?? null,
        input.agentId ?? null,
        input.robotMode ?? null,
        input.unifiedAppId ?? null,
        input.botBoundAt ?? null,
        input.botBoundBy ?? null,
        now,
        existingCompany.id,
      )
    if (Number(update.changes) === 0) {
      deps.db
        .prepare(
          `INSERT INTO channel_configs
             (id, company_id, provider, enabled, status, sync_mode, app_id, corp_id, secret_ref,
              tenant_id, tenant_name, bound_at, bound_by_user_id,
              robot_code, agent_id, robot_mode, unified_app_id, bot_bound_at, bot_bound_by_user_id,
              created_at, updated_at)
           VALUES (?, ?, 'dingtalk', 1, 'bound', 'daily', ?, ?, ?, ?, ?, ?, ?,
                   ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `ch_${ulid()}`,
          existingCompany.id,
          input.appId,
          input.corpId,
          secretRef,
          input.tenant.tenantId,
          input.tenant.name,
          now,
          input.actorLabel,
          input.robotCode ?? null,
          input.agentId ?? null,
          input.robotMode ?? null,
          input.unifiedAppId ?? null,
          input.botBoundAt ?? null,
          input.botBoundBy ?? null,
          now,
          now,
        )
    }

    const plan = mapRemoteOrg(input.remote, {
      companyId: existingCompany.id,
      provider: 'dingtalk',
      root: { id: root.id, path: root.path, depth: Number(root.depth) },
      rootChannelDeptIds: ['1'],
    })
    const outcome = applyOrgSync(deps.db, { plan, now: Date.now(), recycleAfter: 2 })
    audit(deps, req, existingCompany.id, input.action, 'company', existingCompany.id, {
      name: existingCompany.name,
      slug: existingCompany.slug,
      tenantId: input.tenant.tenantId,
      tenantName: input.tenant.name,
      departments: input.remote.depts.length,
      members: input.remote.users.length,
      runId: outcome.runId,
      reboundExistingCompany: true,
      ...(input.extra ?? {}),
    })
    return {
      company: {
        id: existingCompany.id,
        name: existingCompany.name,
        slug: existingCompany.slug,
        rootDeptId: root.id,
        provider: 'dingtalk',
        tenantId: input.tenant.tenantId,
        tenantName: input.tenant.name,
      },
      sync: {
        runId: outcome.runId,
        departments: input.remote.depts.length,
        members: input.remote.users.length,
      },
    }
  }

  const name = String(input.companyName ?? '').trim() || input.tenant.name || `钉钉企业 ${input.corpId.slice(-6)}`
  if (name.length > 80) throw new EabError(EC.VALIDATION, '公司名称最多 80 字')
  const rawSlug = String(input.slug ?? '').trim().toLowerCase()
  const slug = rawSlug || `dt-${input.corpId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(-10)}`
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(slug)) throw new EabError(EC.VALIDATION, 'slug 只能是小写字母开头、字母数字和短横线')
  if (deps.db.prepare('SELECT id FROM companies WHERE slug = ?').get(slug)) {
    throw new EabError(EC.VALIDATION, `slug ${slug} 已存在，请换一个`)
  }

  const now = Date.now()
  /** 单公司：公司 ID 固定用配置值（默认 c1），不随每次扫码生成新 ID */
  const companyId = deps.companyId
  const rootDeptId = `d_${ulid()}`
  const channelId = `ch_${ulid()}`
  const secretRef = storeSecret(deps.config.dbPath, null, input.appSecret, 'EAB_DINGTALK_APP_SECRET')

  deps.db.exec('BEGIN')
  try {
    deps.db
      .prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(companyId, name, slug, 'active', now)
    deps.db
      .prepare(
        `INSERT INTO departments (id, company_id, parent_id, name, path, depth, order_no, created_at)
         VALUES (?, ?, NULL, ?, ?, 0, 0, ?)`,
      )
      .run(rootDeptId, companyId, '公司总部', `/${companyId}/`, now)

    const template = deps.db
      .prepare(
        `SELECT r.id, r.code, r.name, r.data_scope, r.builtin FROM roles r
          WHERE r.deleted_at IS NULL
          GROUP BY r.code
          ORDER BY r.builtin DESC LIMIT 20`,
      )
      .all() as unknown as Array<{ id: string; code: string; name: string; data_scope: string; builtin: number }>
    const insertRole = deps.db.prepare(
      'INSERT INTO roles (id, company_id, code, name, data_scope, builtin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    const insertScope = deps.db.prepare('INSERT OR IGNORE INTO role_scopes (role_id, scope) VALUES (?, ?)')
    for (const role of template) {
      const roleId = `r_${ulid()}`
      insertRole.run(roleId, companyId, role.code, role.name, role.data_scope, role.builtin, now)
      const scopes = deps.db.prepare('SELECT scope FROM role_scopes WHERE role_id = ?').all(role.id) as unknown as Array<{
        scope: string
      }>
      for (const scope of scopes) insertScope.run(roleId, scope.scope)
    }

    deps.db
      .prepare(
        `INSERT INTO channel_configs
           (id, company_id, provider, enabled, status, sync_mode, app_id, corp_id, secret_ref,
            tenant_id, tenant_name, bound_at, bound_by_user_id,
            robot_code, agent_id, robot_mode, unified_app_id, bot_bound_at, bot_bound_by_user_id,
            created_at, updated_at)
         VALUES (?, ?, 'dingtalk', 1, 'bound', 'daily', ?, ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        channelId,
        companyId,
        input.appId,
        input.corpId,
        secretRef,
        input.tenant.tenantId,
        input.tenant.name,
        now,
        input.actorLabel,
        input.robotCode ?? null,
        input.agentId ?? null,
        input.robotMode ?? null,
        input.unifiedAppId ?? null,
        input.botBoundAt ?? null,
        input.botBoundBy ?? null,
        now,
        now,
      )
    deps.db.exec('COMMIT')
  } catch (error) {
    deps.db.exec('ROLLBACK')
    throw error
  }

  const plan = mapRemoteOrg(input.remote, {
    companyId,
    provider: 'dingtalk',
    root: { id: rootDeptId, path: `/${companyId}/`, depth: 0 },
    rootChannelDeptIds: ['1'],
  })
  const outcome = applyOrgSync(deps.db, { plan, now: Date.now(), recycleAfter: 2 })

  audit(deps, req, companyId, input.action, 'company', companyId, {
    name,
    slug,
    tenantId: input.tenant.tenantId,
    tenantName: input.tenant.name,
    departments: input.remote.depts.length,
    members: input.remote.users.length,
    runId: outcome.runId,
    ...(input.extra ?? {}),
  })

  return {
    company: {
      id: companyId,
      name,
      slug,
      rootDeptId,
      provider: 'dingtalk',
      tenantId: input.tenant.tenantId,
      tenantName: input.tenant.name,
    },
    sync: {
      runId: outcome.runId,
      departments: input.remote.depts.length,
      members: input.remote.users.length,
    },
  }
}

export function registerAdminRoutes(app: FastifyInstance, deps: ServerDeps): void {
  type RuntimeBackupJob = {
    id: string
    status: 'running' | 'done' | 'failed'
    startedAt: string
    finishedAt?: string
    dir?: string
    size?: number
    manifest?: unknown
    error?: string
  }
  // 运行数据备份可能达到数百 MB；不能占住 HTTP 请求，改为后台任务 + 轮询。
  const runtimeBackupJobs = new Map<string, RuntimeBackupJob>()

  /* ---------------- 部门 ---------------- */

  app.post<{ Body: { name?: string; parentId?: string; managerUserId?: string } }>(
    '/api/console/departments',
    async (req) => {
      requireConsole(req, deps)
      const companyId = companyOf(req, deps)
      const name = text(req.body?.name, '部门名称', 60)
      const root = deps.db
        .prepare(
          `SELECT id, path, depth FROM departments WHERE company_id = ? AND parent_id IS NULL AND deleted_at IS NULL ORDER BY path LIMIT 1`,
        )
        .get(companyId) as { id: string; path: string; depth: number } | undefined
      if (!root) throw new EabError(EC.NOT_FOUND, '当前公司没有根部门')
      const parent = req.body?.parentId ? deptOf(deps, companyId, req.body.parentId) : root
      const id = `d_${ulid()}`
      const path = `${parent.path}${id}/`
      const now = Date.now()
      const orderNo = Number(
        (
          deps.db
            .prepare('SELECT COALESCE(MAX(order_no), 0) AS n FROM departments WHERE company_id = ? AND parent_id = ?')
            .get(companyId, parent.id) as { n: number }
        ).n,
      )
      deps.db
        .prepare(
          `INSERT INTO departments (id, company_id, parent_id, name, path, depth, order_no, manager_user_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          companyId,
          parent.id,
          name,
          path,
          Number(parent.depth) + 1,
          orderNo + 1,
          req.body?.managerUserId ?? null,
          now,
        )
      audit(deps, req, companyId, 'org.dept.create', 'department', id, { name, parentId: parent.id })
      return ok({ id, name, parentId: parent.id, path })
    },
  )

  app.patch<{
    Params: { id: string }
    Body: { name?: string; parentId?: string; orderNo?: number; managerUserId?: string | null }
  }>('/api/console/departments/:id', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const dept = deptOf(deps, companyId, req.params.id)
    if (dept.parent_id === null && req.body?.parentId !== undefined) {
      throw new EabError(EC.VALIDATION, '根部门不能移动')
    }

    const now = Date.now()
    const name = req.body?.name === undefined ? dept.name : text(req.body.name, '部门名称', 60)
    const parentId =
      req.body?.parentId === undefined ? dept.parent_id : req.body.parentId ? String(req.body.parentId) : null
    let newPath = dept.path
    let newDepth = Number(dept.depth)

    if (parentId && parentId !== dept.parent_id) {
      const parent = deptOf(deps, companyId, parentId)
      if (parent.path.startsWith(dept.path)) throw new EabError(EC.VALIDATION, '不能把部门移动到自己的子部门下')
      newPath = `${parent.path}${dept.id}/`
      newDepth = Number(parent.depth) + 1
    }

    deps.db.exec('BEGIN')
    try {
      deps.db
        .prepare(
          'UPDATE departments SET name = ?, parent_id = ?, path = ?, depth = ?, order_no = COALESCE(?, order_no), manager_user_id = ? WHERE id = ?',
        )
        .run(
          name,
          parentId,
          newPath,
          newDepth,
          req.body?.orderNo ?? null,
          req.body?.managerUserId === undefined ? null : req.body.managerUserId,
          dept.id,
        )
      if (newPath !== dept.path) {
        const descendants = deps.db
          .prepare('SELECT id, path FROM departments WHERE company_id = ? AND path LIKE ? AND id <> ?')
          .all(companyId, `${dept.path}%`, dept.id) as unknown as Array<{ id: string; path: string }>
        const updateDept = deps.db.prepare('UPDATE departments SET path = ? WHERE id = ?')
        for (const child of descendants) {
          updateDept.run(`${newPath}${child.path.slice(dept.path.length)}`, child.id)
        }
        deps.db
          .prepare('UPDATE users SET dept_path = ? || substr(dept_path, ?) WHERE company_id = ? AND dept_path LIKE ?')
          .run(newPath, dept.path.length + 1, companyId, `${dept.path}%`)
      }
      deps.db.exec('COMMIT')
    } catch (error) {
      deps.db.exec('ROLLBACK')
      throw error
    }

    audit(deps, req, companyId, 'org.dept.update', 'department', dept.id, { name, parentId, newPath, at: now })
    return ok({ id: dept.id, name, parentId, path: newPath })
  })

  app.delete<{ Params: { id: string } }>('/api/console/departments/:id', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const dept = deptOf(deps, companyId, req.params.id)
    if (dept.parent_id === null) throw new EabError(EC.VALIDATION, '根部门不能删除')
    const children = Number(
      (deps.db
        .prepare('SELECT COUNT(*) AS n FROM departments WHERE parent_id = ? AND deleted_at IS NULL')
        .get(dept.id) as { n: number }).n,
    )
    const users = Number(
      (deps.db
        .prepare('SELECT COUNT(*) AS n FROM users WHERE dept_id = ? AND deleted_at IS NULL')
        .get(dept.id) as { n: number }).n,
    )
    if (children > 0 || users > 0) {
      throw new EabError(EC.VALIDATION, `这个部门下还有 ${children} 个子部门、${users} 名成员，先把人和子部门移走`)
    }
    deps.db.prepare('UPDATE departments SET deleted_at = ? WHERE id = ?').run(Date.now(), dept.id)
    audit(deps, req, companyId, 'org.dept.delete', 'department', dept.id, { name: dept.name })
    return ok({ deleted: true })
  })

  /* ---------------- 成员 ---------------- */

  app.post<{
    Body: {
      name?: string
      employeeNo?: string
      deptId?: string
      title?: string
      email?: string
      mobile?: string
      password?: string
      roles?: string[]
    }
  }>('/api/console/members', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const name = text(req.body?.name, '姓名', 40)
    if (!req.body?.deptId) throw new EabError(EC.VALIDATION, '请选择部门')
    const dept = deptOf(deps, companyId, String(req.body.deptId))
    const employeeNo = optionalText(req.body?.employeeNo, 40) ?? `U_${ulid().slice(-6)}`
    const exists = deps.db
      .prepare('SELECT id FROM users WHERE company_id = ? AND employee_no = ?')
      .get(companyId, employeeNo)
    if (exists) throw new EabError(EC.VALIDATION, `工号 ${employeeNo} 已存在`)

    const password = req.body?.password === undefined ? null : String(req.body.password)
    const passwordHash = password ? hashPassword(password) : null
    const passwordSetAt = password ? Date.now() : null
    const now = Date.now()
    const id = `u_${ulid()}`
    deps.db
      .prepare(
        `INSERT INTO users (id, company_id, dept_id, dept_path, name, employee_no, title, email, mobile, status, password_hash, password_set_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        companyId,
        dept.id,
        dept.path,
        name,
        employeeNo,
        optionalText(req.body?.title, 60),
        optionalText(req.body?.email, 120),
        normalizeMobile(optionalText(req.body?.mobile, 30)) || null,
        'active',
        passwordHash,
        passwordSetAt,
        now,
        now,
      )

    const codes = Array.isArray(req.body?.roles) && req.body.roles.length > 0 ? req.body.roles : ['member']
    const roles = deps.db
      .prepare('SELECT id, code FROM roles WHERE company_id = ? AND deleted_at IS NULL')
      .all(companyId) as unknown as Array<{ id: string; code: string }>
    const byCode = new Map(roles.map((role) => [role.code, role.id]))
    const unknown = codes.filter((code) => !byCode.has(code))
    if (unknown.length > 0) throw new EabError(EC.VALIDATION, `未知角色：${unknown.join('、')}`)
    const insert = deps.db.prepare(
      'INSERT INTO user_roles (user_id, role_id, granted_by, granted_at) VALUES (?, ?, ?, ?)',
    )
    for (const code of codes) insert.run(id, byCode.get(code) as string, 'console-operator', now)

    audit(deps, req, companyId, 'org.member.create', 'user', id, { name, employeeNo, deptId: dept.id })
    return ok({ id, name, employeeNo, deptId: dept.id, roles: codes, passwordSet: Boolean(passwordHash) })
  })

  /** ORG-07 成员清单导出（CSV），导出本身写审计 */
  app.get('/api/console/members/export', async (req, reply) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const rows = deps.db
      .prepare(
        `SELECT u.name, u.employee_no, u.dept_path, d.name AS dept_name, u.title, u.status,
                u.email, u.mobile
           FROM users u JOIN departments d ON d.id = u.dept_id
          WHERE u.company_id = ? AND u.deleted_at IS NULL
          ORDER BY u.dept_path, u.name`,
      )
      .all(companyId) as unknown as Array<Record<string, unknown>>
    const head = ['姓名', '工号', '部门', '部门路径', '岗位', '状态', '邮箱', '手机号']
    const cell = (value: unknown) => {
      const text = value === null || value === undefined ? '' : String(value)
      return `"${text.replace(/"/g, '""')}"`
    }
    const csv = [
      head.map(cell).join(','),
      ...rows.map((row) =>
        [row.name, row.employee_no, row.dept_name, row.dept_path, row.title, row.status, row.email, row.mobile]
          .map(cell)
          .join(','),
      ),
    ].join('\r\n')
    audit(deps, req, companyId, 'org.member.export', 'company', companyId, { rows: rows.length })
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent('成员清单.csv')}`)
    return reply.send(`\uFEFF${csv}`)
  })

  app.patch<
    {
      Params: { id: string }
      Body: {
        name?: string
        title?: string
        email?: string
        mobile?: string
        deptId?: string
        status?: string
      }
    }
  >('/api/console/members/:id', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const user = deps.db
      .prepare('SELECT id, name, dept_id, dept_path, status FROM users WHERE id = ? AND company_id = ? AND deleted_at IS NULL')
      .get(req.params.id, companyId) as
      | { id: string; name: string; dept_id: string; dept_path: string; status: string }
      | undefined
    if (!user) throw new EabError(EC.NOT_FOUND, '成员不存在或不属于当前公司')

    const status = req.body?.status === undefined ? user.status : String(req.body.status)
    if (!['active', 'disabled', 'invited'].includes(status)) throw new EabError(EC.VALIDATION, '状态只能是 active / disabled / invited')
    let deptId = user.dept_id
    let deptPath = user.dept_path
    if (req.body?.deptId !== undefined) {
      const dept = deptOf(deps, companyId, String(req.body.deptId))
      deptId = dept.id
      deptPath = dept.path
    }
    const now = Date.now()
    deps.db
      .prepare(
        `UPDATE users SET name = COALESCE(?, name), title = COALESCE(?, title), email = COALESCE(?, email),
                mobile = COALESCE(?, mobile), dept_id = ?, dept_path = ?, status = ?,
                disabled_at = CASE WHEN ? = 'disabled' THEN COALESCE(disabled_at, ?) ELSE NULL END,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(
        optionalText(req.body?.name, 40),
        optionalText(req.body?.title, 60),
        optionalText(req.body?.email, 120),
        normalizeMobile(optionalText(req.body?.mobile, 30)) || null,
        deptId,
        deptPath,
        status,
        status,
        now,
        now,
        user.id,
      )
    if (status === 'disabled') {
      revokeAllSessions(deps.db, user.id)
      // WS-06：离职/停用后工作区转只读（归档标记），文件不删
      deps.db
        .prepare('UPDATE workspace_files SET archived_at = ? WHERE owner_user_id = ? AND deleted_at IS NULL AND archived_at IS NULL')
        .run(now, user.id)
    } else if (status === 'active') {
      deps.db
        .prepare('UPDATE workspace_files SET archived_at = NULL WHERE owner_user_id = ? AND deleted_at IS NULL')
        .run(user.id)
    }
    audit(deps, req, companyId, 'org.member.update', 'user', user.id, { status, deptId })
    return ok({ id: user.id, status, deptId })
  })

  app.delete<{ Params: { id: string } }>('/api/console/members/:id', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const user = deps.db
      .prepare('SELECT id, name FROM users WHERE id = ? AND company_id = ? AND deleted_at IS NULL')
      .get(req.params.id, companyId) as { id: string; name: string } | undefined
    if (!user) throw new EabError(EC.NOT_FOUND, '成员不存在或不属于当前公司')
    deps.db.prepare('UPDATE users SET deleted_at = ?, status = ? WHERE id = ?').run(Date.now(), 'disabled', user.id)
    deps.db
      .prepare('UPDATE workspace_files SET archived_at = ? WHERE owner_user_id = ? AND deleted_at IS NULL')
      .run(Date.now(), user.id)
    const revoked = revokeAllSessions(deps.db, user.id)
    audit(deps, req, companyId, 'org.member.delete', 'user', user.id, { name: user.name, revoked })
    return ok({ deleted: true, revoked })
  })

  app.post<{ Params: { id: string }; Body: { password?: string } }>(
    '/api/console/members/:id/password',
    async (req) => {
      requireConsole(req, deps)
      const companyId = companyOf(req, deps)
      const user = deps.db
        .prepare('SELECT id, name FROM users WHERE id = ? AND company_id = ? AND deleted_at IS NULL')
        .get(req.params.id, companyId) as { id: string; name: string } | undefined
      if (!user) throw new EabError(EC.NOT_FOUND, '成员不存在或不属于当前公司')
      const password = text(req.body?.password, '新密码', 128)
      if (password.length < 8) throw new EabError(EC.VALIDATION, '密码至少 8 位')
      const now = Date.now()
      deps.db
        .prepare('UPDATE users SET password_hash = ?, password_set_at = ?, updated_at = ? WHERE id = ?')
        .run(hashPassword(password), now, now, user.id)
      const revoked = revokeAllSessions(deps.db, user.id)
      audit(deps, req, companyId, 'org.member.password.reset', 'user', user.id, { revoked })
      return ok({ reset: true, revokedSessions: revoked })
    },
  )

  /** 批量授权（ADM-03）：给多个人一次性追加角色，不覆盖原有角色 */
  app.post<{ Body: { userIds?: string[]; roles?: string[] } }>('/api/console/members/bulk-roles', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const userIds = Array.isArray(req.body?.userIds) ? [...new Set(req.body.userIds.map(String))] : []
    const codes = Array.isArray(req.body?.roles) ? [...new Set(req.body.roles.map(String))] : []
    if (userIds.length === 0) throw new EabError(EC.VALIDATION, '至少选一个成员')
    if (codes.length === 0) throw new EabError(EC.VALIDATION, '至少选一个角色')
    const roles = deps.db
      .prepare('SELECT id, code FROM roles WHERE company_id = ? AND deleted_at IS NULL')
      .all(companyId) as unknown as Array<{ id: string; code: string }>
    const byCode = new Map(roles.map((role) => [role.code, role.id]))
    const unknown = codes.filter((code) => !byCode.has(code))
    if (unknown.length > 0) throw new EabError(EC.VALIDATION, `未知角色：${unknown.join('、')}`)
    const now = Date.now()
    const insert = deps.db.prepare(
      'INSERT OR IGNORE INTO user_roles (user_id, role_id, granted_by, granted_at) VALUES (?, ?, ?, ?)',
    )
    let changed = 0
    for (const userId of userIds) {
      const exists = deps.db
        .prepare('SELECT id FROM users WHERE id = ? AND company_id = ? AND deleted_at IS NULL')
        .get(userId, companyId)
      if (!exists) continue
      for (const code of codes) {
        insert.run(userId, byCode.get(code) as string, 'console-operator', now)
        changed += 1
      }
    }
    audit(deps, req, companyId, 'perm.bulk.grant', 'user', null, { userIds, roles: codes })
    return ok({ users: userIds.length, grants: changed })
  })

  app.get<{ Params: { id: string } }>('/api/console/members/:id/sessions', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const rows = deps.db
      .prepare(
        `SELECT s.id, s.created_at, s.last_seen_at, s.last_ip, s.user_agent, s.revoked_at
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.user_id = ? AND u.company_id = ?
          ORDER BY s.last_seen_at DESC LIMIT 50`,
      )
      .all(req.params.id, companyId) as unknown as Array<Record<string, unknown>>
    return ok({
      sessions: rows.map((row) => ({
        id: row.id,
        createdAt: new Date(Number(row.created_at)).toISOString(),
        lastSeenAt: new Date(Number(row.last_seen_at)).toISOString(),
        lastIp: row.last_ip,
        userAgent: row.user_agent,
        revoked: row.revoked_at !== null,
      })),
    })
  })

  app.delete<{ Params: { id: string } }>('/api/console/members/:id/sessions', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const user = deps.db
      .prepare('SELECT id FROM users WHERE id = ? AND company_id = ? AND deleted_at IS NULL')
      .get(req.params.id, companyId)
    if (!user) throw new EabError(EC.NOT_FOUND, '成员不存在')
    const revoked = revokeAllSessions(deps.db, req.params.id)
    audit(deps, req, companyId, 'auth.session.revoke_all', 'user', req.params.id, { revoked })
    return ok({ revoked })
  })

  /* ---------------- 临时授权 / 显式例外（PERM-05） ---------------- */

  app.get<{ Params: { id: string } }>('/api/console/members/:id/overrides', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const user = deps.db
      .prepare('SELECT id FROM users WHERE id = ? AND company_id = ? AND deleted_at IS NULL')
      .get(req.params.id, companyId)
    if (!user) throw new EabError(EC.NOT_FOUND, '成员不存在')
    const rows = deps.db
      .prepare(
        `SELECT id, scope, effect, reason, expires_at, created_at
           FROM permission_overrides
          WHERE user_id = ? AND revoked_at IS NULL
          ORDER BY created_at DESC`,
      )
      .all(req.params.id) as unknown as Array<Record<string, unknown>>
    return ok({
      overrides: rows.map((row) => ({
        id: row.id,
        scope: row.scope,
        effect: row.effect,
        reason: row.reason,
        expiresAt: row.expires_at === null ? null : new Date(Number(row.expires_at)).toISOString(),
        expired: row.expires_at !== null && Number(row.expires_at) <= Date.now(),
        createdAt: new Date(Number(row.created_at)).toISOString(),
      })),
    })
  })

  app.post<{
    Params: { id: string }
    Body: { scope?: string; effect?: string; expiresInHours?: number; reason?: string }
  }>('/api/console/members/:id/overrides', async (req, reply) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const user = deps.db
      .prepare('SELECT id FROM users WHERE id = ? AND company_id = ? AND deleted_at IS NULL')
      .get(req.params.id, companyId)
    if (!user) throw new EabError(EC.NOT_FOUND, '成员不存在')
    const scope = String(req.body?.scope ?? '').trim()
    if (!isKnownScope(scope)) throw new EabError(EC.VALIDATION, `未登记的权限点：${scope}`)
    const effect = String(req.body?.effect ?? 'allow')
    if (!['allow', 'deny'].includes(effect)) throw new EabError(EC.VALIDATION, 'effect 只能是 allow / deny')
    const hours = req.body?.expiresInHours === undefined ? null : Number(req.body.expiresInHours)
    if (hours !== null && (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 365)) {
      throw new EabError(EC.VALIDATION, '有效期需要是 1 到 8760 小时')
    }
    const now = Date.now()
    const id = `ov_${ulid()}`
    deps.db
      .prepare(
        `INSERT INTO permission_overrides (id, company_id, user_id, scope, effect, reason, expires_at, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        companyId,
        req.params.id,
        scope,
        effect,
        optionalText(req.body?.reason, 200),
        hours === null ? null : now + hours * 3600_000,
        'console-operator',
        now,
      )
    audit(deps, req, companyId, 'perm.override.create', 'user', req.params.id, { scope, effect, hours })
    reply.code(201)
    return ok({ id, scope, effect, expiresInHours: hours })
  })

  app.delete<{ Params: { id: string; overrideId: string } }>(
    '/api/console/members/:id/overrides/:overrideId',
    async (req) => {
      requireConsole(req, deps)
      const companyId = companyOf(req, deps)
      const row = deps.db
        .prepare(
          'SELECT id FROM permission_overrides WHERE id = ? AND user_id = ? AND company_id = ? AND revoked_at IS NULL',
        )
        .get(req.params.overrideId, req.params.id, companyId)
      if (!row) throw new EabError(EC.NOT_FOUND, '临时授权不存在')
      deps.db.prepare('UPDATE permission_overrides SET revoked_at = ? WHERE id = ?').run(Date.now(), req.params.overrideId)
      audit(deps, req, companyId, 'perm.override.revoke', 'user', req.params.id, { overrideId: req.params.overrideId })
      return ok({ id: req.params.overrideId, revoked: true })
    },
  )

  /* ---------------- 公司 ---------------- */

  app.post<{
    Body: {
      name?: string
      slug?: string
      adminName?: string
      adminAccount?: string
      adminPassword?: string
    }
  }>('/api/console/companies', async (req) => {
    requireConsole(req, deps)
    /**
     * 单公司实例只允许一家公司，但“空库”是首次部署的正常状态：
     * GitHub 发布后在服务器上第一次打开 /admin，库里还没有任何公司，
     * 此时必须允许创建这一家，否则控制台永远进不去。
     */
    const existing = deps.db
      .prepare('SELECT id, name FROM companies WHERE deleted_at IS NULL ORDER BY created_at ASC LIMIT 1')
      .get() as { id: string; name: string } | undefined
    if (existing) {
      throw new EabError(EC.CONFLICT, '当前是单公司本地部署，只允许一家公司', {
        hint: `本实例已经有公司「${existing.name}」；需要换组织请先删除它，或到「连接与平台 → 渠道」重新绑定钉钉机器人。`,
      })
    }

    const name = text(req.body?.name, '公司名称', 80)
    const requestedSlug = optionalText(req.body?.slug, 40)
    let slug = (requestedSlug ?? `eab-${ulid().slice(-8)}`).toLowerCase()
    if (!/^[a-z][a-z0-9-]{1,39}$/.test(slug)) {
      throw new EabError(EC.VALIDATION, 'slug 只能是小写字母开头、字母数字和短横线')
    }
    for (let attempt = 0; deps.db.prepare('SELECT id FROM companies WHERE slug = ?').get(slug); attempt += 1) {
      if (requestedSlug) throw new EabError(EC.VALIDATION, `slug ${slug} 已存在`)
      if (attempt >= 5) throw new EabError(EC.CONFLICT, '自动生成的公司标识连续冲突，请手动填写 slug')
      slug = `eab-${ulid().slice(-8)}`.toLowerCase()
    }

    const now = Date.now()
    /** 单公司：公司 ID 固定用配置值（默认 c1），这样控制台、员工端和后续绑定都指向同一家。 */
    const companyId = deps.companyId
    const rootDeptId = `d_${ulid()}`
    deps.db.exec('BEGIN')
    try {
      deps.db
        .prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(companyId, name, slug, 'active', now)
      deps.db
        .prepare(
          `INSERT INTO departments (id, company_id, parent_id, name, path, depth, order_no, created_at)
           VALUES (?, ?, NULL, ?, ?, 0, 0, ?)`,
        )
        .run(rootDeptId, companyId, '公司总部', `/${companyId}/`, now)

      /**
       * 空库里没有可复制的旧角色，必须直接从代码里的 BUILTIN_ROLES 建一套；
       * 否则新公司没有任何角色，后续成员授权和权限判断都会是空的。
       */
      const insertRole = deps.db.prepare(
        'INSERT INTO roles (id, company_id, code, name, data_scope, builtin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      const insertScope = deps.db.prepare('INSERT OR IGNORE INTO role_scopes (role_id, scope) VALUES (?, ?)')
      const roleByCode = new Map<string, string>()
      for (const role of BUILTIN_ROLES) {
        const roleId = `r_${ulid()}`
        insertRole.run(roleId, companyId, role.code, role.name, role.dataScope, 1, now)
        for (const scope of new Set(role.scopes)) insertScope.run(roleId, scope)
        roleByCode.set(role.code, roleId)
      }

      let adminUserId: string | null = null
      const adminName = optionalText(req.body?.adminName, 40)
      if (adminName) {
        const requestedAdminAccount = optionalText(req.body?.adminAccount, 40)
        const adminAccount = requestedAdminAccount ?? simAccount(slug)
        const adminPassword = String(req.body?.adminPassword ?? '')
        if (adminPassword.length < 8) throw new EabError(EC.VALIDATION, '管理员初始密码至少 8 位')
        const accountOwner = findAccountOwner(deps, adminAccount)
        if (accountOwner) {
          throw new EabError(
            EC.VALIDATION,
            `管理员账号 ${adminAccount} 已被${accountOwner.name ? `成员「${accountOwner.name}」` : '已有成员'}占用，请换一个`,
            { hint: '账号会同时匹配工号、邮箱和手机号；请换一个没有被任何成员使用的账号。' },
          )
        }
        adminUserId = `u_${ulid()}`
        deps.db
          .prepare(
            `INSERT INTO users (id, company_id, dept_id, dept_path, name, employee_no, title, status, password_hash, password_set_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
          )
          .run(
            adminUserId,
            companyId,
            rootDeptId,
            `/${companyId}/`,
            adminName,
            adminAccount,
            '公司管理员',
            hashPassword(adminPassword),
            now,
            now,
            now,
          )
        const roleId = roleByCode.get('company_admin')
        if (roleId) {
          deps.db
            .prepare('INSERT INTO user_roles (user_id, role_id, granted_by, granted_at) VALUES (?, ?, ?, ?)')
            .run(adminUserId, roleId, 'console-operator', now)
        }
      }

      deps.db.exec('COMMIT')
      audit(deps, req, companyId, 'platform.company.create', 'company', companyId, {
        name,
        slug,
        adminUserId,
        firstCompany: true,
      })
      return ok({ id: companyId, name, slug, rootDeptId, adminUserId })
    } catch (error) {
      deps.db.exec('ROLLBACK')
      throw error
    }
  })

  /**
   * 首次建公司时管理员账号的可用性预检。
   * 只读接口；真正创建时 POST /api/console/companies 会按同一口径再查一遍。
   */
  app.post<{ Body: { account?: string } }>('/api/console/companies/check-admin-account', async (req) => {
    requireConsole(req, deps)
    const account = optionalText(req.body?.account, 40)
    if (!account) throw new EabError(EC.VALIDATION, '请填写管理员账号')
    const owner = findAccountOwner(deps, account)
    return ok({
      account,
      available: !owner,
      ownerName: owner?.name ?? null,
    })
  })

  /* ---------------- 钉钉一键开通：建公司 + 绑定 + 同步 ---------------- */

  /**
   * 用户口径：钉钉同步组织架构 = 在 EAB 里直接“开一家公司”，
   * 不要先手工建公司、再去渠道页填凭证、再点同步。
   *
   * 一次请求完成：验凭证 → 读钉钉企业名与通讯录 → 建公司/根部门/角色副本 →
   * 写 channel_configs 绑定 → applyOrgSync 落部门与成员（含 UserID）。
   */
  app.post<{
    Body: {
      appId?: string
      appSecret?: string
      corpId?: string
      robotCode?: string
      agentId?: string
      companyName?: string
      slug?: string
    }
  }>('/api/console/companies/onboard-dingtalk', async (req) => {
    requireConsole(req, deps)
    const appId = String(req.body?.appId ?? '').trim().slice(0, 120)
    const corpId = String(req.body?.corpId ?? '').trim().slice(0, 120)
    const appSecret = String(req.body?.appSecret ?? '').trim()
    const robotCode = String(req.body?.robotCode ?? '').trim().slice(0, 120) || appId
    const agentId = String(req.body?.agentId ?? '').trim().slice(0, 120)
    if (!appId) throw new EabError(EC.VALIDATION, '缺少钉钉 AppKey')
    if (!corpId) throw new EabError(EC.VALIDATION, '缺少钉钉企业 CorpId')
    if (!appSecret) throw new EabError(EC.VALIDATION, '缺少钉钉 AppSecret')
    if (!robotCode) throw new EabError(EC.VALIDATION, '缺少机器人 RobotCode')

    const { tenant, remote } = await readDingTalkOrg(appId, corpId, appSecret)
    if (remote.depts.length === 0 && remote.users.length === 0) {
      throw new EabError(EC.UPSTREAM, '钉钉通讯录返回为空，拒绝开通', {
        hint: '确认应用的通讯录权限范围已包含要同步的部门与成员。',
      })
    }
    const created = await createDingTalkCompany(deps, req, {
      appId,
      appSecret,
      corpId,
      tenant,
      remote,
      companyName: req.body?.companyName,
      slug: req.body?.slug,
      actorLabel: 'console:onboard-dingtalk',
      action: 'platform.company.onboard_dingtalk',
      robotCode,
      agentId: agentId || null,
      robotMode: 'STREAM',
      botBoundAt: Date.now(),
      botBoundBy: 'console:dingtalk-manual',
      extra: { robotCode, agentId: agentId || null, binding: 'manual-robot' },
    })

    // 手工绑定的普通机器人也要立刻接 Stream；失败不阻塞绑定结果。
    void refreshDingTalkStream(deps).catch((error) =>
      console.warn('[eab] 手工绑定机器人后启动钉钉 Stream 失败：', (error as Error).message),
    )

    const chatUrl = publicChatUrl(req, deps)
    return ok({
      ...created,
      chatUrl,
    })
  })

  /**
   * 扫码建机器人 + 建公司：第一步出二维码。
   * 前端把二维码用官方组件渲染；用户用手机钉钉扫，落地页会完成机器人创建/权限配置。
   */
  app.post('/api/console/dingtalk/onboard/start', async (req) => {
    requireConsole(req, deps)
    const started = await startDingTalkRegistration()
    const now = Date.now()
    const attemptId = `dton_${ulid()}`
    deps.db
      .prepare(
        `INSERT INTO dingtalk_onboard_attempts
           (id, nonce, device_code, user_code, qr_url, status, interval_sec, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'waiting', ?, ?, ?, ?)`,
      )
      .run(
        attemptId,
        started.nonce,
        started.deviceCode,
        started.userCode,
        started.verificationUriComplete,
        started.interval,
        now + started.expiresIn * 1000,
        now,
        now,
      )
    return ok({
      attemptId,
      qrUrl: started.verificationUriComplete,
      qrSvg: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
        await QRCode.toString(started.verificationUriComplete, { type: 'svg', margin: 1, width: 300 }),
      )}`,
      userCode: started.userCode,
      expiresIn: started.expiresIn,
      interval: started.interval,
    })
  })

  /**
   * 扫码状态：前端每 interval 秒轮询。SUCCESS 时用扫码拿到的凭证直接建公司/绑机器人。
   * 幂等：同一 attempt 成功后再查，直接返回已保存的结果，不重复建公司。
   */
  app.post<{ Body: { attemptId?: string; companyName?: string; slug?: string } }>(
    '/api/console/dingtalk/onboard/status',
    async (req) => {
      requireConsole(req, deps)
      const attemptId = String(req.body?.attemptId ?? '').trim()
      if (!attemptId) throw new EabError(EC.VALIDATION, '缺少扫码尝试 ID')
      const row = deps.db
        .prepare('SELECT * FROM dingtalk_onboard_attempts WHERE id = ?')
        .get(attemptId) as
        | {
            id: string
            device_code: string
            qr_url: string
            user_code: string | null
            status: string
            interval_sec: number
            expires_at: number
            client_id: string | null
            client_secret_ref: string | null
            corp_id: string | null
            agent_id: string | null
            robot_code: string | null
            unified_app_id: string | null
            scanner_user_id: string | null
            company_id: string | null
            error: string | null
            result_json: string | null
          }
        | undefined
      if (!row) throw new EabError(EC.NOT_FOUND, '扫码会话不存在，请重新生成二维码')
      if (row.status === 'success' && row.result_json) {
        return ok(JSON.parse(row.result_json))
      }
      if (row.status === 'expired' || Date.now() > row.expires_at) {
        if (row.status !== 'expired') {
          deps.db
            .prepare(`UPDATE dingtalk_onboard_attempts SET status = 'expired', updated_at = ? WHERE id = ?`)
            .run(Date.now(), row.id)
        }
        return ok({ status: 'expired', qrUrl: row.qr_url, userCode: row.user_code })
      }

      const polled = await pollDingTalkRegistration(row.device_code)
      if (polled.status !== 'SUCCESS') {
        if (polled.status === 'FAIL' || polled.status === 'EXPIRED') {
          deps.db
            .prepare(`UPDATE dingtalk_onboard_attempts SET status = ?, error = ?, updated_at = ? WHERE id = ?`)
            .run(polled.status.toLowerCase(), polled.message ?? null, Date.now(), row.id)
        }
        return ok({
          status: polled.status.toLowerCase(),
          qrUrl: row.qr_url,
          userCode: row.user_code,
          interval: row.interval_sec,
          expiresAt: row.expires_at,
          message: polled.message ?? null,
        })
      }

      const appId = polled.clientId ?? ''
      const appSecret = polled.clientSecret ?? ''
      const corpId = polled.corpId ?? ''
      if (!appId || !appSecret || !corpId) {
        throw new EabError(EC.UPSTREAM, '钉钉扫码成功，但没有返回完整的应用凭证或企业 ID', {
          hint: '请重新生成二维码再扫一次；若仍失败，改用「手工填写 AppKey/AppSecret/CorpId」开通。',
        })
      }
      // 旧 attempt 的 ref 可能还在，但密钥文件已被覆盖/清理；不能只看 ref 名，
      // 必须确认现在仍能解析到值，否则会把新扫到的 secret 丢掉、继续指向空引用。
      const canReuseRef = Boolean(row.client_secret_ref && resolveSecret(deps.config.dbPath, row.client_secret_ref))
      const secretRef = canReuseRef
        ? row.client_secret_ref!
        : storeSecret(deps.config.dbPath, null, appSecret, 'EAB_DINGTALK_APP_SECRET')
      deps.db
        .prepare(
          `UPDATE dingtalk_onboard_attempts
              SET client_id = ?, client_secret_ref = ?, corp_id = ?, agent_id = ?, robot_code = ?,
                  unified_app_id = ?, scanner_user_id = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          appId,
          secretRef,
          corpId,
          polled.agentId ?? null,
          polled.robotCode ?? null,
          polled.unifiedAppId ?? null,
          polled.userId ?? null,
          Date.now(),
          row.id,
        )

      let tenant: { tenantId: string; name: string }
      let remote: Awaited<ReturnType<typeof fetchChannelOrg>>
      try {
        const read = await readDingTalkOrg(appId, corpId, appSecret)
        tenant = read.tenant
        remote = read.remote
      } catch (error) {
        const details = (error as EabError).details as
          | { reason?: string; requiredScopes?: string[]; versionUrl?: string }
          | undefined
        if (details?.reason === 'permission_not_effective') {
          // 扫码建出来的「机器人应用」会自动补机器人权限，但通讯录读取属于企业内部应用权限，
          // 钉钉不会替企业自动授权。这里一次列出三件套，避免用户被 60011 一条条牵着走。
          const requiredScopes = Array.from(
            new Set([
              ...(details.requiredScopes ?? []),
              'qyapi_get_department_list',
              'qyapi_get_member',
              'qyapi_get_department_member',
            ]),
          )
          deps.db
            .prepare(`UPDATE dingtalk_onboard_attempts SET status = 'needs_permission', error = ?, updated_at = ? WHERE id = ?`)
            .run((error as Error).message.slice(0, 500), Date.now(), row.id)
          return ok({
            status: 'needs_permission',
            appId,
            corpId,
            requiredScopes,
            applyUrls: Object.fromEntries(
              requiredScopes.map((scope) => [
                scope,
                `https://open-dev.dingtalk.com/appscope/apply?content=${encodeURIComponent(`${appId}#${scope}`)}`,
              ]),
            ),
            batchApplyUrl: `https://open-dev.dingtalk.com/appscope/apply?content=${encodeURIComponent(`${appId}#qyapi_get_`)}`,
            versionUrl: details.versionUrl ?? 'https://open-dev.dingtalk.com/fe/ai',
            message: '机器人已建好，但钉钉还没给这个应用通讯录读取权限。',
          })
        }
        deps.db
          .prepare(`UPDATE dingtalk_onboard_attempts SET status = 'error', error = ?, updated_at = ? WHERE id = ?`)
          .run((error as Error).message.slice(0, 500), Date.now(), row.id)
        throw error
      }
      if (remote.depts.length === 0 && remote.users.length === 0) {
        deps.db
          .prepare(`UPDATE dingtalk_onboard_attempts SET status = 'error', error = ?, updated_at = ? WHERE id = ?`)
          .run('钉钉通讯录返回为空', Date.now(), row.id)
        throw new EabError(EC.UPSTREAM, '钉钉通讯录返回为空，拒绝开通', {
          hint: '确认扫码时创建/连接的机器人拥有通讯录读取权限。',
        })
      }

      const robotCode = polled.robotCode || appId
      // 扫码只当普通机器人：不登记 AI 助理的 agentId / unifiedAppId，避免平台默认欢迎语跟着走。
      const robot = {
        clientId: appId,
        agentId: null,
        robotCode,
        mode: 'STREAM',
        unifiedAppId: null,
        scannerUserId: polled.userId ?? null,
      }

      // 这个钉钉企业已经开过公司：把这次扫码拿到的机器人挂到已有公司，不重复建公司。
      const boundRow = deps.db
        .prepare(
          `SELECT company_id FROM channel_configs WHERE provider = 'dingtalk' AND tenant_id = ?`,
        )
        .get(corpId) as { company_id?: string } | undefined
      if (boundRow?.company_id) {
        const company = deps.db
          .prepare('SELECT id, name, slug FROM companies WHERE id = ?')
          .get(boundRow.company_id) as { id: string; name: string; slug: string } | undefined
        const now = Date.now()
        deps.db
          .prepare(
            `UPDATE channel_configs
                SET app_id = ?, corp_id = ?, secret_ref = ?, tenant_name = ?, agent_id = NULL, robot_code = ?,
                    robot_mode = 'STREAM', unified_app_id = NULL, bot_bound_at = ?, bot_bound_by_user_id = ?,
                    status = 'bound', enabled = 1, updated_at = ?
              WHERE company_id = ? AND provider = 'dingtalk'`,
          )
          .run(
            appId,
            corpId,
            secretRef,
            tenant.name,
            robotCode,
            now,
            'console:dingtalk-qr',
            now,
            boundRow.company_id,
          )
        // 换机器人后旧二维码/旧 state 必须失效，否则登录页会拿新 AppKey 去兑换旧 state。
        deps.db
          .prepare('DELETE FROM auth_login_states WHERE company_id = ? AND provider = ?')
          .run(boundRow.company_id, 'dingtalk')
        const root = deps.db
          .prepare(
            `SELECT id, path, depth FROM departments
              WHERE company_id = ? AND parent_id IS NULL AND deleted_at IS NULL
              ORDER BY path LIMIT 1`,
          )
          .get(boundRow.company_id) as { id: string; path: string; depth: number } | undefined
        if (!root) {
          throw new EabError(EC.CONFLICT, '公司没有根部门，无法重新绑定组织', {
            hint: '先删除公司回到空库，再扫码重新建。',
          })
        }
        const plan = mapRemoteOrg(remote, {
          companyId: boundRow.company_id,
          provider: 'dingtalk',
          root: { id: root.id, path: root.path, depth: Number(root.depth) },
          rootChannelDeptIds: ['1'],
        })
        // 「扫码绑定」本身就要完成首次/再次同步，不能只换凭证而让组织数据空着。
        const outcome = applyOrgSync(deps.db, { plan, now: Date.now(), recycleAfter: 2 })
        const result = {
          status: 'success',
          existing: true,
          company: company ? { ...company, provider: 'dingtalk', tenantId: corpId, tenantName: tenant.name } : null,
          sync: {
            runId: outcome.runId,
            departments: remote.depts.length,
            members: remote.users.length,
          },
          robot,
        }
        deps.db
          .prepare(
            `UPDATE dingtalk_onboard_attempts SET status = 'success', tenant_name = ?, company_id = ?, result_json = ?, updated_at = ? WHERE id = ?`,
          )
          .run(tenant.name, boundRow.company_id, JSON.stringify(result), Date.now(), row.id)
        audit(deps, req, boundRow.company_id, 'platform.channel.bind_robot', 'channel', 'dingtalk', {
          appId,
          corpId,
          agentId: null,
          robotCode,
          reused: true,
          runId: outcome.runId,
        })
        void refreshDingTalkStream(deps).catch((error) =>
          console.warn('[eab] 换机器人后重建钉钉 Stream 失败：', (error as Error).message),
        )
        return ok(result)
      }

      const created = await createDingTalkCompany(deps, req, {
        appId,
        appSecret,
        corpId,
        tenant,
        remote,
        companyName: req.body?.companyName,
        slug: req.body?.slug,
        actorLabel: 'console:dingtalk-qr',
        action: 'platform.company.onboard_dingtalk_qr',
        robotCode,
        agentId: null,
        robotMode: 'STREAM',
        unifiedAppId: null,
        botBoundAt: Date.now(),
        botBoundBy: 'console:dingtalk-qr',
        extra: { agentId: null, robotCode, binding: 'scan-ordinary-robot' },
      })
      const result = { status: 'success', existing: false, ...created, robot }
      deps.db
        .prepare(
          `UPDATE dingtalk_onboard_attempts SET status = 'success', tenant_name = ?, company_id = ?, result_json = ?, updated_at = ? WHERE id = ?`,
        )
        .run(tenant.name, created.company.id, JSON.stringify(result), Date.now(), row.id)
      // 机器人字段补到刚建好的渠道配置（createDingTalkCompany 只写了应用凭证）。
      deps.db
        .prepare(
          `UPDATE channel_configs
              SET agent_id = NULL, robot_code = ?, robot_mode = 'STREAM', unified_app_id = NULL,
                  bot_bound_at = ?, bot_bound_by_user_id = ?, updated_at = ?
            WHERE company_id = ? AND provider = 'dingtalk'`,
        )
        .run(robotCode, Date.now(), 'console:dingtalk-qr', Date.now(), created.company.id)
      void refreshDingTalkStream(deps).catch((error) =>
        console.warn('[eab] 新机器人绑定后启动钉钉 Stream 失败：', (error as Error).message),
      )
      return ok(result)
    },
  )

  /**
   * 彻底删除唯一公司：把这家公司的所有业务数据一起打包删除。
   * 单公司实例删完就是空库，可以重新用钉钉扫码绑定一家新组织。
   */
  app.delete<{ Params: { id: string } }>('/api/console/companies/:id', async (req) => {
    requireConsole(req, deps)
    if (req.params.id !== deps.companyId) {
      throw new EabError(EC.NOT_FOUND, '公司不存在', { hint: '单公司实例只管理唯一那家公司' })
    }
    const company = deps.db.prepare('SELECT id, name FROM companies WHERE id = ?').get(deps.companyId) as
      | { id: string; name: string }
      | undefined
    if (!company) throw new EabError(EC.NOT_FOUND, '公司不存在')

    const deleted: Record<string, number> = {}
    /**
     * 业务表之间有很多外键，按表名遍历无法保证拓扑顺序；
     * 删除前临时关闭外键（连接级），提交后恢复，避免依赖手写删除顺序。
     */
    deps.db.exec('PRAGMA foreign_keys = OFF')
    deps.db.exec('BEGIN')
    try {
      // 没有 company_id 的子表，先按父表 ID 清掉
      const roleIds = deps.db.prepare('SELECT id FROM roles WHERE company_id = ?').all(company.id) as unknown as Array<{ id: string }>
      const userIds = deps.db.prepare('SELECT id FROM users WHERE company_id = ?').all(company.id) as unknown as Array<{ id: string }>
      const roleScope = deps.db.prepare('DELETE FROM role_scopes WHERE role_id = ?')
      for (const role of roleIds) roleScope.run(role.id)
      const userRole = deps.db.prepare('DELETE FROM user_roles WHERE user_id = ?')
      for (const user of userIds) userRole.run(user.id)

      /**
       * audit_logs 有 append-only 触发器，正常只能追加。
       * 删除公司时要在事务内临时摘掉触发器，删完立刻按原 SQL 重建；
       * 失败回滚会连 DDL 一起回滚，不会留下没有审计保护的库。
       */
      const auditTriggers = deps.db
        .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'audit_logs'`)
        .all() as unknown as Array<{ name: string; sql: string }>
      for (const trigger of auditTriggers) {
        deps.db.exec(`DROP TRIGGER IF EXISTS "${trigger.name.replaceAll('"', '""')}"`)
      }

      // 其余带 company_id 的表按表名遍历删除（单公司实例不必维护静态清单）
      const tables = deps.db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
        .all() as unknown as Array<{ name: string }>
      for (const table of tables) {
        if (table.name === 'companies') continue
        const columns = deps.db.prepare(`PRAGMA table_info("${table.name.replaceAll('"', '""')}")`).all() as unknown as Array<{
          name: string
        }>
        if (!columns.some((column) => column.name === 'company_id')) continue
        const result = deps.db.prepare(`DELETE FROM "${table.name.replaceAll('"', '""')}" WHERE company_id = ?`).run(company.id)
        deleted[table.name] = Number(result.changes)
      }

      const companyDelete = deps.db.prepare('DELETE FROM companies WHERE id = ?').run(company.id)
      deleted.companies = Number(companyDelete.changes)

      /**
       * 单公司实例里，旧演示遗留的公司也不该继续挡着重新绑定。
       * 删除唯一公司时把库里其余残留公司一并清掉，回到真正的空库。
       */
      const residualCompanies = deps.db.prepare('SELECT id FROM companies WHERE id <> ?').all(company.id) as unknown as Array<{
        id: string
      }>
      for (const residual of residualCompanies) {
        const residualRoleIds = deps.db.prepare('SELECT id FROM roles WHERE company_id = ?').all(residual.id) as unknown as Array<{ id: string }>
        const residualUserIds = deps.db.prepare('SELECT id FROM users WHERE company_id = ?').all(residual.id) as unknown as Array<{ id: string }>
        const residualRoleScope = deps.db.prepare('DELETE FROM role_scopes WHERE role_id = ?')
        for (const role of residualRoleIds) residualRoleScope.run(role.id)
        const residualUserRole = deps.db.prepare('DELETE FROM user_roles WHERE user_id = ?')
        for (const user of residualUserIds) residualUserRole.run(user.id)
        for (const table of tables) {
          if (table.name === 'companies') continue
          const columns = deps.db.prepare(`PRAGMA table_info("${table.name.replaceAll('"', '""')}")`).all() as unknown as Array<{
            name: string
          }>
          if (!columns.some((column) => column.name === 'company_id')) continue
          const result = deps.db.prepare(`DELETE FROM "${table.name.replaceAll('"', '""')}" WHERE company_id = ?`).run(residual.id)
          deleted[table.name] = (deleted[table.name] ?? 0) + Number(result.changes)
        }
        deleted.companies += Number(deps.db.prepare('DELETE FROM companies WHERE id = ?').run(residual.id).changes)
      }

      for (const trigger of auditTriggers) {
        if (trigger.sql) deps.db.exec(trigger.sql)
      }
      deps.db.exec('COMMIT')
    } catch (error) {
      deps.db.exec('ROLLBACK')
      throw error
    } finally {
      deps.db.exec('PRAGMA foreign_keys = ON')
    }

    console.log(`单公司实例：已删除公司 ${company.id}（${company.name}）及其全部数据`)
    return ok({ id: company.id, name: company.name, deleted, next: '空库后可在控制台用「钉钉扫码绑定组织」重新接入一家公司' })
  })

  /**
   * 网页工作台 AI 消息旁的助手身份：名字 + 头像。
   * 只 merge settings_json.assistant，不覆盖其它公司配置；头像文件落数据目录。
   */
  app.put<{ Body: { name?: unknown; avatarDataUrl?: unknown; removeAvatar?: unknown } }>(
    '/api/console/company/assistant',
    { bodyLimit: 4 * 1024 * 1024 },
    async (req) => {
      requireConsole(req, deps)
      const saved = saveCompanyAssistant(
        deps.db,
        resolveAssistantDataDir(deps.config.dataDir, deps.config.dbPath),
        deps.companyId,
        req.body ?? {},
      )
      audit(deps, req, deps.companyId, 'platform.company.assistant.update', 'company', deps.companyId, {
        name: saved.name,
        hasAvatar: Boolean(saved.avatar),
      })
      return ok({ assistant: companyAssistantView(deps.db, deps.companyId) })
    },
  )

  app.patch<{ Params: { id: string }; Body: { name?: string; status?: string; settings?: Record<string, unknown> } }>(
    '/api/console/companies/:id',
    async (req) => {
      requireConsole(req, deps)
      if (req.params.id !== deps.companyId) {
        throw new EabError(EC.NOT_FOUND, '公司不存在', { hint: '单公司实例只管理唯一那家公司' })
      }
      const company = deps.db.prepare('SELECT id, name, status FROM companies WHERE id = ?').get(req.params.id) as
        | { id: string; name: string; status: string }
        | undefined
      if (!company) throw new EabError(EC.NOT_FOUND, '公司不存在')
      const name = req.body?.name === undefined ? company.name : text(req.body.name, '公司名称', 80)
      const status = req.body?.status === undefined ? company.status : String(req.body.status)
      if (!['active', 'suspended'].includes(status)) throw new EabError(EC.VALIDATION, '状态只能是 active / suspended')
      const settings = req.body?.settings === undefined ? null : JSON.stringify(req.body.settings)
      /**
       * 根部门就是组织树的公司节点。公司改名后如果只改 companies.name，
       * 组织树、成员部门字段和通讯录工具仍会显示旧的根部门名（例如演示数据里的「甲科技」）。
       * 这里把根部门名一起同步，保证公司名只有一个口径。
       */
      deps.db.exec('BEGIN')
      try {
        deps.db
          .prepare('UPDATE companies SET name = ?, status = ?, settings_json = COALESCE(?, settings_json) WHERE id = ?')
          .run(name, status, settings, company.id)
        const root = deps.db
          .prepare(
            `SELECT id, name FROM departments
              WHERE company_id = ? AND parent_id IS NULL AND deleted_at IS NULL
              ORDER BY path LIMIT 1`,
          )
          .get(company.id) as { id: string; name: string } | undefined
        if (root && root.name !== name) {
          deps.db.prepare('UPDATE departments SET name = ? WHERE id = ?').run(name, root.id)
        }
        deps.db.exec('COMMIT')
      } catch (error) {
        deps.db.exec('ROLLBACK')
        throw error
      }
      audit(deps, req, company.id, 'platform.company.update', 'company', company.id, { name, status })
      return ok({ id: company.id, name, status })
    },
  )

  /**
   * 唯一公司的资料卡：公司标识、状态、创建时间、统计与渠道绑定摘要。
   * 改名/停用仍走 PATCH /api/console/companies/:id，页面不重复造一套写接口。
   */
  app.get('/api/console/company', async (req) => {
    requireConsole(req, deps)
    const companyId = deps.companyId
    const company = deps.db
      .prepare('SELECT id, name, slug, status, settings_json, created_at FROM companies WHERE id = ?')
      .get(companyId) as
      | { id: string; name: string; slug: string; status: string; settings_json: string | null; created_at: number }
      | undefined
    if (!company) throw new EabError(EC.NOT_FOUND, '公司不存在', { hint: '先在控制台用「钉钉扫码绑定组织」接入一家公司' })

    const counts = deps.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM users WHERE company_id = ? AND deleted_at IS NULL) AS members,
           (SELECT COUNT(*) FROM users WHERE company_id = ? AND deleted_at IS NULL AND status = 'active') AS active_members,
           (SELECT COUNT(*) FROM departments WHERE company_id = ? AND deleted_at IS NULL) AS departments,
           (SELECT COUNT(*) FROM kb_collections WHERE company_id = ? AND deleted_at IS NULL AND status = 'active') AS collections,
           (SELECT COUNT(*) FROM chat_sessions WHERE company_id = ? AND deleted_at IS NULL) AS chat_sessions`,
      )
      .get(companyId, companyId, companyId, companyId, companyId) as unknown as Record<string, unknown>

    const channels = deps.db
      .prepare(
        `SELECT provider, status, enabled, sync_mode, tenant_id, tenant_name, app_id, corp_id, agent_id,
                bot_bound_at, last_synced_at, updated_at
           FROM channel_configs WHERE company_id = ? ORDER BY provider`,
      )
      .all(companyId) as unknown as Array<Record<string, unknown>>

    const root = deps.db
      .prepare(
        `SELECT id, name, path FROM departments
          WHERE company_id = ? AND parent_id IS NULL AND deleted_at IS NULL ORDER BY path LIMIT 1`,
      )
      .get(companyId) as { id: string; name: string; path: string } | undefined

    let settings: Record<string, unknown> = {}
    if (company.settings_json) {
      try {
        settings = JSON.parse(company.settings_json) as Record<string, unknown>
      } catch {
        settings = {}
      }
    }

    return ok({
      company: {
        id: company.id,
        name: company.name,
        slug: company.slug,
        status: company.status,
        createdAt: new Date(Number(company.created_at)).toISOString(),
        settings,
        rootDeptId: root?.id ?? null,
        rootDeptName: root?.name ?? null,
      },
      counts: {
        members: Number(counts.members ?? 0),
        activeMembers: Number(counts.active_members ?? 0),
        departments: Number(counts.departments ?? 0),
        collections: Number(counts.collections ?? 0),
        chatSessions: Number(counts.chat_sessions ?? 0),
      },
      channels: channels.map((row) => ({
        provider: row.provider,
        status: row.status,
        enabled: Number(row.enabled) === 1,
        syncMode: row.sync_mode,
        tenantId: row.tenant_id,
        tenantName: row.tenant_name,
        appId: row.app_id,
        corpId: row.corp_id,
        agentId: row.agent_id,
        botBoundAt: row.bot_bound_at ? new Date(Number(row.bot_bound_at)).toISOString() : null,
        lastSyncedAt: row.last_synced_at ? new Date(Number(row.last_synced_at)).toISOString() : null,
        updatedAt: new Date(Number(row.updated_at)).toISOString(),
      })),
      assistant: companyAssistantView(deps.db, companyId),
    })
  })

  /* ---------------- 审计 ---------------- */

  app.get<{
    Querystring: { action?: string; actor?: string; result?: string; from?: string; to?: string; limit?: string; offset?: string }
  }>('/api/console/audit', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 500)
    const offset = Math.max(Number(req.query.offset ?? 0), 0)
    const reader = deps.backends?.auditRead ?? new SqliteAuditReadSource(deps.db)
    const page = await reader.list({
      companyId,
      action: req.query.action || undefined,
      actor: req.query.actor || undefined,
      result: req.query.result || undefined,
      from: req.query.from ? Date.parse(req.query.from) : undefined,
      to: req.query.to ? Date.parse(req.query.to) : undefined,
      limit,
      offset,
    })
    return ok({
      total: page.total,
      limit,
      offset,
      source: page.source,
      ...(page.fallbackReason ? { fallbackReason: page.fallbackReason } : {}),
      items: page.rows.map((row) => ({
        id: row.id,
        seq: row.seq,
        actorUserId: row.actor_user_id,
        action: row.action,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        result: row.result,
        detail: row.detail_json
          ? typeof row.detail_json === 'string'
            ? JSON.parse(row.detail_json)
            : row.detail_json
          : null,
        traceId: row.trace_id,
        ip: row.ip,
        channel: row.channel,
        hash: row.hash,
        createdAt: new Date(Number(row.created_at)).toISOString(),
      })),
    })
  })

  app.get<{ Querystring: { format?: string } }>('/api/console/audit/export', async (req, reply) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const reader = deps.backends?.auditRead ?? new SqliteAuditReadSource(deps.db)
    const exported = await reader.export(companyId)
    const rows = exported.rows as Array<Record<string, unknown>>
    audit(deps, req, companyId, 'audit.export', 'audit_log', null, {
      count: rows.length,
      format: req.query.format ?? 'csv',
      source: exported.source,
      ...(exported.fallbackReason ? { fallbackReason: exported.fallbackReason } : {}),
    })
    if (req.query.format === 'json') {
      reply.type('application/json; charset=utf-8')
      reply.header('content-disposition', 'attachment; filename="audit.json"')
      return reply.send(JSON.stringify(rows, null, 2))
    }
    const header = 'seq,actor_user_id,action,resource_type,resource_id,result,trace_id,ip,channel,hash,created_at'
    const csv = [
      header,
      ...rows.map((row) =>
        [row.seq, row.actor_user_id, row.action, row.resource_type, row.resource_id, row.result, row.trace_id, row.ip, row.channel, row.hash, row.created_at]
          .map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`)
          .join(','),
      ),
    ].join('\n')
    reply.type('text/csv; charset=utf-8')
    reply.header('content-disposition', 'attachment; filename="audit.csv"')
    return reply.send(csv)
  })

  app.get('/api/console/audit/verify', async (req) => {
    requireConsole(req, deps)
    const result = verifyAuditChain(deps.db)
    return ok(result)
  })

  /* ---------------- 用量看板（ADM-08 / CHAT-08） ---------------- */

  app.get<{ Querystring: { days?: string } }>('/api/console/usage', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const days = Math.min(Math.max(Number(req.query.days ?? 30), 1), 365)
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
    const rows = deps.db
      .prepare(
        `SELECT u.day, u.user_id, us.name, u.requests, u.prompt_tokens, u.completion_tokens
           FROM usage_daily u LEFT JOIN users us ON us.id = u.user_id
          WHERE u.company_id = ? AND u.day >= ?
          ORDER BY u.day DESC, u.requests DESC`,
      )
      .all(companyId, since) as unknown as Array<Record<string, unknown>>
    const totals = rows.reduce<{ requests: number; promptTokens: number; completionTokens: number }>(
      (acc, row) => ({
        requests: acc.requests + Number(row.requests),
        promptTokens: acc.promptTokens + Number(row.prompt_tokens),
        completionTokens: acc.completionTokens + Number(row.completion_tokens),
      }),
      { requests: 0, promptTokens: 0, completionTokens: 0 },
    )
    return ok({
      days,
      totals,
      items: rows.map((row) => ({
        day: row.day,
        userId: row.user_id,
        userName: row.name ?? row.user_id,
        requests: Number(row.requests),
        promptTokens: Number(row.prompt_tokens),
        completionTokens: Number(row.completion_tokens),
      })),
    })
  })

  /* ---------------- 审批（PERM-07） ---------------- */

  app.get<{ Querystring: { status?: string } }>('/api/console/approvals', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const status = req.query.status ?? 'pending'
    const rows = deps.db
      .prepare(
        `SELECT a.id, a.requester_user_id, u.name AS requester_name, a.action, a.resource_type, a.resource_id,
                a.payload_json, a.status, a.reason, a.decided_by, a.decided_at, a.expires_at, a.created_at
           FROM approvals a LEFT JOIN users u ON u.id = a.requester_user_id
          WHERE a.company_id = ? AND (? = 'all' OR a.status = ?)
          ORDER BY a.created_at DESC LIMIT 100`,
      )
      .all(companyId, status, status) as unknown as Array<Record<string, unknown>>
    return ok({
      items: rows.map((row) => ({
        id: row.id,
        requesterUserId: row.requester_user_id,
        requesterName: row.requester_name ?? row.requester_user_id,
        action: row.action,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        payload: row.payload_json ? JSON.parse(String(row.payload_json)) : null,
        status: row.status,
        reason: row.reason,
        decidedBy: row.decided_by,
        expiresAt: row.expires_at ? new Date(Number(row.expires_at)).toISOString() : null,
        createdAt: new Date(Number(row.created_at)).toISOString(),
      })),
    })
  })

  app.post<{ Params: { id: string }; Body: { decision?: string; reason?: string } }>(
    '/api/console/approvals/:id/decide',
    async (req) => {
      requireConsole(req, deps)
      const companyId = companyOf(req, deps)
      const decisionRaw = String(req.body?.decision ?? '')
      if (!['approved', 'rejected'].includes(decisionRaw)) throw new EabError(EC.VALIDATION, 'decision 只能是 approved / rejected')
      const decision = decisionRaw as 'approved' | 'rejected'
      const row = deps.db
        .prepare('SELECT id, status, action, requester_user_id, payload_json FROM approvals WHERE id = ? AND company_id = ?')
        .get(req.params.id, companyId) as
        | { id: string; status: string; action: string; requester_user_id: string; payload_json: string | null }
        | undefined
      if (!row) throw new EabError(EC.NOT_FOUND, '审批不存在')
      if (row.status !== 'pending') throw new EabError(EC.CONFLICT, `审批已是 ${row.status}`)
      deps.db
        .prepare('UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, reason = COALESCE(?, reason) WHERE id = ?')
        .run(decision, 'console-operator', Date.now(), optionalText(req.body?.reason, 200), row.id)
      audit(deps, req, companyId, `approval.${decision}`, 'approval', row.id, { decision })
      let payload: { toolId?: string; skillId?: string } | null = null
      try {
        payload = row.payload_json ? (JSON.parse(row.payload_json) as { toolId?: string; skillId?: string }) : null
      } catch {
        payload = null
      }
      recordSkillApprovalDecision(deps.db, {
        companyId,
        requesterUserId: row.requester_user_id,
        action: row.action,
        decision,
        actorId: 'console-operator',
        approvalId: row.id,
        toolId: payload?.toolId,
        skillId: payload?.skillId,
        reason: optionalText(req.body?.reason, 200),
      })
      return ok({ id: row.id, status: decision })
    },
  )

  /* ---------------- 备份（OPS-06） ---------------- */

  app.post('/api/console/backups', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const dir = backupDir(deps)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const file = join(dir, `eab-${stamp}.db`)
    deps.db.prepare('VACUUM INTO ?').run(file)
    const size = statSync(file).size
    audit(deps, req, companyId, 'ops.backup.create', 'database', file, { size })
    return ok({ file, size, createdAt: new Date().toISOString() })
  })

  app.post('/api/console/backups/runtime', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const running = [...runtimeBackupJobs.values()].find((job) => job.status === 'running')
    if (running) return ok({ jobId: running.id, status: running.status, startedAt: running.startedAt })
    const job: RuntimeBackupJob = {
      id: `bk_${ulid()}`,
      status: 'running',
      startedAt: new Date().toISOString(),
    }
    runtimeBackupJobs.set(job.id, job)
    void (async () => {
      try {
        const result = await createRuntimeBackup(deps)
        Object.assign(job, {
          status: 'done',
          finishedAt: new Date().toISOString(),
          dir: result.dir,
          size: result.size,
          manifest: result.manifest,
        })
        audit(deps, req, companyId, 'ops.backup.runtime.create', 'runtime-backup', result.dir, {
          size: result.size,
          includes: result.manifest.includes,
          excludes: result.manifest.excludes,
        })
      } catch (error) {
        job.status = 'failed'
        job.finishedAt = new Date().toISOString()
        job.error = error instanceof Error ? error.message : String(error)
      }
    })()
    return ok({ jobId: job.id, status: job.status, startedAt: job.startedAt })
  })

  app.get<{ Params: { id: string } }>('/api/console/backup-jobs/:id', async (req) => {
    requireConsole(req, deps)
    const job = runtimeBackupJobs.get(req.params.id)
    if (!job) throw new EabError(EC.NOT_FOUND, '备份任务不存在')
    return ok(job)
  })

  app.get('/api/console/backups', async (req) => {
    requireConsole(req, deps)
    const dir = backupDir(deps)
    if (!existsSync(dir)) return ok({ items: [] })
    const items = readdirSync(dir, { withFileTypes: true })
      .map((entry) => {
        const file = join(dir, entry.name)
        const stat = statSync(file)
        if (entry.name.endsWith('.db') && stat.isFile()) {
          return {
            kind: 'database' as const,
            file,
            name: entry.name,
            size: stat.size,
            createdAt: stat.mtime.toISOString(),
          }
        }
        if (entry.name.startsWith('eab-runtime-') && stat.isDirectory()) {
          const manifest = runtimeBackupManifest(file)
          if (!manifest) return null
          return {
            kind: 'runtime' as const,
            file,
            name: entry.name,
            size: manifest.size,
            createdAt: stat.mtime.toISOString(),
          }
        }
        return null
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return ok({ items })
  })

  app.post<{ Params: { name: string } }>('/api/console/backups/:name/reveal', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const { dir, file, kind } = resolveBackupFile(deps, req.params.name)
    let opened = false
    try {
      const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
      const args = process.platform === 'win32' ? [`/select,"${file}"`] : process.platform === 'darwin' ? ['-R', file] : [dirname(file)]
      const child = spawn(command, args, {
        detached: true,
        stdio: 'ignore',
        windowsVerbatimArguments: process.platform === 'win32',
      })
      child.on('error', () => {
        /* 打不开资源管理器时由前端提示手动路径 */
      })
      child.unref()
      opened = true
    } catch {
      opened = false
    }
    audit(deps, req, companyId, 'ops.backup.reveal', kind, file, { dir, opened })
    return ok({ file, opened })
  })

  app.delete<{ Params: { name: string } }>('/api/console/backups/:name', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const { file, size, kind } = resolveBackupFile(deps, req.params.name)
    if (kind === 'runtime') rmSync(file, { recursive: true, force: true })
    else unlinkSync(file)
    audit(deps, req, companyId, 'ops.backup.delete', kind, file, { size })
    return ok({ deleted: true, file })
  })
}

function simAccount(slug: string): string {
  return `${slug.replace(/-/g, '_')}_admin`.slice(0, 40)
}
