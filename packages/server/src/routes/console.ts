/**
 * 管理控制台接口（服务器侧）。
 *
 * 身份：超级管理员账号 + 密码 → 控制台会话 → 操作员（不是组织成员，不继承角色）。
 * 所有数据接口都要求 `x-eab-console: 1`，避免同浏览器登录控制台后员工页被误认成操作员。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ALL_SCOPES, EC, EabError, SCOPE_REGISTRY, isKnownScope } from '@eab/domain'
import { appendAudit } from '@eab/storage'
import type { ServerDeps } from '../deps.js'
import { ok } from '../http.js'
import { resolveActor } from '../session.js'
import { effectiveNetwork } from '../network-settings.js'
import { resolveSecret, secretConfigured, storeSecret } from '../secrets.js'
import {
  defaultWorkspaceQuota,
  readWorkspaceQuotaPolicy,
  resolveUserWorkspaceQuota,
} from '../workspace-quota.js'
import { applyOrgSync, fetchChannelOrg, fetchDingTalkTenant, mapRemoteOrg, pollFeishuScanNative, pollWecomScan, startFeishuScanNative, startWecomScan, verifyFeishuApp } from '@eab/channel'
import { dispatchPluginRpc } from '../plugin-host.js'
import { listPluginChannels, listAllPluginModels, listPluginModels, refreshPluginChannel } from '../plugin-models.js'
import { filterHealthyModels, probePluginChannelModels } from '../model-health.js'
import {
  applyPluginModelRoles,
  loadPluginModelRoleMap,
  savePluginModelRoles,
} from '../plugin-model-settings.js'
import { loadPlugins } from '../plugins.js'
import { KB_SOURCE_LABEL, listExternalDocs, probeExternalCollection, syncObsidianCollection } from '../kb-external.js'
import {
  MODEL_CAPABILITIES,
  MODEL_ENDPOINT_KINDS,
  MODEL_ROUTE_PURPOSES,
  capabilitiesOf,
  explainModelRoute,
  findModelById,
  inferModelProfile,
  modelSupportsPurpose,
  normalizeCapability,
  type ModelProfileSuggestion,
} from '../model-registry.js'
import { collectionVectorStats, latestKbIndexJob, startKbIndexJob } from '../kb-vector.js'
import { callModel } from '../llm.js'
import { createModelStressState, modelStressSnapshot, runModelStress, type ModelStressState } from '../model-stress.js'
import {
  clearSessionCookie,
  createSession,
  destroySession,
  isConsoleRequest,
  isLoopback,
  revokeOtherSessions,
  sessionCookie,
  sessionFromRequest,
  setAdminPassword,
  verifyAdminCredentials,
} from '../console-auth.js'

const PROVIDER_KINDS = [
  { kind: 'openai', label: 'OpenAI', defaultBaseUrl: 'https://api.openai.com/v1', protocol: 'openai' },
  { kind: 'deepseek', label: 'DeepSeek', defaultBaseUrl: 'https://api.deepseek.com/v1', protocol: 'openai' },
  { kind: 'qwen', label: '通义千问 / 阿里云百炼', defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', protocol: 'openai' },
  { kind: 'zhipu', label: '智谱 GLM', defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4', protocol: 'openai' },
  { kind: 'moonshot', label: '月之暗面 Kimi', defaultBaseUrl: 'https://api.moonshot.cn/v1', protocol: 'openai' },
  { kind: 'azure_openai', label: 'Azure OpenAI', defaultBaseUrl: '', protocol: 'azure' },
  { kind: 'anthropic', label: 'Anthropic Claude', defaultBaseUrl: 'https://api.anthropic.com/v1', protocol: 'anthropic' },
  { kind: 'gemini', label: 'Google Gemini', defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta', protocol: 'gemini' },
  { kind: 'openai_compatible', label: 'OpenAI 兼容（自建/中转）', defaultBaseUrl: '', protocol: 'openai' },
  { kind: 'volcengine', label: '火山方舟 / 豆包', defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3', protocol: 'openai' },
  { kind: 'qianfan', label: '百度千帆', defaultBaseUrl: 'https://qianfan.baidubce.com/v2', protocol: 'openai' },
  { kind: 'hunyuan', label: '腾讯混元', defaultBaseUrl: 'https://api.hunyuan.cloud.tencent.com/v1', protocol: 'openai' },
  { kind: 'siliconflow', label: '硅基流动 SiliconFlow', defaultBaseUrl: 'https://api.siliconflow.cn/v1', protocol: 'openai' },
  { kind: 'minimax', label: 'MiniMax', defaultBaseUrl: 'https://api.minimax.chat/v1', protocol: 'openai' },
  { kind: 'stepfun', label: '阶跃星辰 StepFun', defaultBaseUrl: 'https://api.stepfun.com/v1', protocol: 'openai' },
  { kind: 'xai', label: 'xAI Grok', defaultBaseUrl: 'https://api.x.ai/v1', protocol: 'openai' },
  { kind: 'groq', label: 'Groq', defaultBaseUrl: 'https://api.groq.com/openai/v1', protocol: 'openai' },
  { kind: 'mistral', label: 'Mistral', defaultBaseUrl: 'https://api.mistral.ai/v1', protocol: 'openai' },
  { kind: 'together', label: 'Together AI', defaultBaseUrl: 'https://api.together.xyz/v1', protocol: 'openai' },
  { kind: 'openrouter', label: 'OpenRouter', defaultBaseUrl: 'https://openrouter.ai/api/v1', protocol: 'openai' },
  { kind: 'ollama', label: '本地 · Ollama', defaultBaseUrl: 'http://127.0.0.1:11434/v1', protocol: 'openai' },
  { kind: 'vllm', label: '本地 · vLLM', defaultBaseUrl: 'http://127.0.0.1:8000/v1', protocol: 'openai' },
  { kind: 'lmstudio', label: '本地 · LM Studio', defaultBaseUrl: 'http://127.0.0.1:1234/v1', protocol: 'openai' },
  { kind: 'custom', label: '自定义（OpenAI 兼容）', defaultBaseUrl: '', protocol: 'openai' },
  { kind: 'demo', label: '演示回声', defaultBaseUrl: '', protocol: 'demo' },
] as const

const PROVIDER_KIND_SET = new Set(PROVIDER_KINDS.map((item) => item.kind))
const DATA_SCOPES = new Set(['self', 'dept', 'company', 'global'])

type ProviderKind = (typeof PROVIDER_KINDS)[number]['kind']


interface ModelRow {
  id: string
  company_id: string
  provider_id: string
  name: string
  model_key: string
  tags: string | null
  roles: string | null
  priority: number
  enabled: number
  provider_kind: string
  provider_name: string
  provider_status: string
  capabilities?: string | null
  endpoint_kind?: string | null
  input_modalities?: string | null
  output_modalities?: string | null
  max_context?: number | null
  max_output_tokens?: number | null
  context_compression?: number | null
  embedding_dim?: number | null
  config_json?: string | null
}

function parseList(raw: string | null): string[] {
  if (!raw) return []
  try {
    const value = JSON.parse(raw) as unknown
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function parseObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const value = JSON.parse(raw) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function stringArrayField(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new EabError(EC.VALIDATION, `${field} 必须是数组`)
  return value.map(String)
}

function optionalIntField(value: unknown, field: string): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) throw new EabError(EC.VALIDATION, `${field} 必须是正整数`)
  return Math.trunc(number)
}

function validateEndpointKind(value: unknown): string | undefined {
  if (value === undefined) return undefined
  const kind = String(value)
  if (!(MODEL_ENDPOINT_KINDS as readonly string[]).includes(kind)) {
    throw new EabError(EC.VALIDATION, `endpointKind 只能是 ${MODEL_ENDPOINT_KINDS.join(' / ')}`)
  }
  return kind
}

function validateCapabilityList(value: unknown): string[] | undefined {
  const list = stringArrayField(value, 'capabilities')
  if (list === undefined) return undefined
  const unknown = list.filter((item) => !(MODEL_CAPABILITIES as readonly string[]).includes(item))
  if (unknown.length > 0) throw new EabError(EC.VALIDATION, `未知能力：${unknown.join('、')}`)
  return list
}

function companyOf(req: FastifyRequest, deps: ServerDeps): string {
  const { subject } = resolveActor(deps.db, deps.config, req, deps.companyId)
  return subject.companyId
}

function requireConsole(req: FastifyRequest, deps: ServerDeps): void {
  if (!isConsoleRequest(req, deps.config)) {
    throw new EabError(EC.AUTH_REQUIRED, '需要控制台会话（请先在 /admin 登录）', {
      hint: '控制台数据接口必须带 x-eab-console: 1；浏览器登录后由页面自动携带',
    })
  }
}

export function registerConsoleRoutes(app: FastifyInstance, deps: ServerDeps): void {
  /** 控制台手压测任务：只在进程内保留最近结果，不落库；重启后需要重跑。 */
  const stressJobs = new Map<
    string,
    { companyId: string; modelId: string; modelName: string; state: ModelStressState }
  >()

  app.post<{ Body: { username?: string; password?: string; token?: string } }>(
    '/api/console/login',
    async (req, reply) => {
      // 控制台只给服务器本机/跳板机用；要远程必须显式打开。这个开关可以在系统页热切换。
      if (!effectiveNetwork(deps.config).allowRemoteConsole && !isLoopback(req.ip)) {
        throw new EabError(EC.FORBIDDEN, '控制台只允许在服务器本机登录', {
          hint: '如需从其他机器访问，请在部署侧设置 EAB_CONSOLE_ALLOW_REMOTE=1 并配合内网/隧道',
        })
      }

      const username = String(req.body?.username ?? '').trim()
      const password = String(req.body?.password ?? '')
      const token = String(req.body?.token ?? '').trim()

      const byPassword = username !== '' && verifyAdminCredentials(deps.config, username, password)
      const byToken = Boolean(deps.config.consoleToken) && token !== '' && token === deps.config.consoleToken
      if (!byPassword && !byToken) {
        throw new EabError(EC.AUTH_REQUIRED, '账号或密码不正确', {
          hint: '默认超级管理员账号见启动日志 / .eab-dev/admin-credentials.txt',
        })
      }

      const session = createSession(byPassword ? username : 'service-token', req.ip ?? '')
      reply.header('set-cookie', sessionCookie(session))
      return ok({ user: session.user, expiresAt: new Date(session.expiresAt).toISOString() })
    },
  )

  app.post('/api/console/logout', async (req, reply) => {
    destroySession(req)
    reply.header('set-cookie', clearSessionCookie())
    return ok({ loggedOut: true })
  })

  app.get('/api/console/session', async (req) => {
    requireConsole(req, deps)
    return ok({ authenticated: true })
  })

  /** 账号中心：顶栏头像点开后展示的身份信息 */
  app.get('/api/console/account', async (req) => {
    requireConsole(req, deps)
    const session = sessionFromRequest(req)
    return ok({
      user: session?.user ?? deps.config.adminUser,
      displayName: '超级管理员',
      role: '服务器侧',
      passwordSource: deps.config.adminPasswordSource ?? 'auto',
      allowRemote: deps.config.allowRemoteConsole,
      ip: session?.ip ?? req.ip ?? '',
      expiresAt: session ? new Date(session.expiresAt).toISOString() : null,
    })
  })

  /** 改控制台密码：校验当前口令 → 落盘 → 运行时立即生效 → 其它设备会话失效 */
  app.post<{ Body: { currentPassword?: string; newPassword?: string } }>(
    '/api/console/password',
    async (req) => {
      requireConsole(req, deps)
      const session = sessionFromRequest(req)
      const username = session?.user ?? ''
      if (!username || username === 'service-token') {
        throw new EabError(EC.FORBIDDEN, '服务令牌登录不能修改控制台密码', {
          hint: '请用超级管理员账号在 /admin 登录后再改',
        })
      }
      const current = String(req.body?.currentPassword ?? '')
      const next = String(req.body?.newPassword ?? '')
      if (!verifyAdminCredentials(deps.config, username, current)) {
        throw new EabError(EC.AUTH_REQUIRED, '当前密码不正确', { hint: '忘记密码可看 .eab-dev/admin-credentials.txt' })
      }
      if (deps.config.adminPasswordSource === 'env') {
        throw new EabError(EC.FORBIDDEN, '密码由环境变量 EAB_ADMIN_PASSWORD 管理', {
          hint: '请改部署环境变量后重启服务；控制台内改密码只对自动生成的密码生效',
        })
      }
      if (next.length < 8 || next.length > 72) {
        throw new EabError(EC.VALIDATION, '新密码长度需要 8–72 位')
      }
      if (next === current) {
        throw new EabError(EC.VALIDATION, '新密码不能和当前密码相同')
      }

      const credentialsPath = join(dirname(deps.config.dbPath), 'admin-credentials.txt')
      writeFileSync(
        credentialsPath,
        `# EAB 控制台超级管理员（仅本机/服务器使用）\n` +
          `username=${deps.config.adminUser}\n` +
          `password=${next}\n` +
          `# 改密码：在控制台「账号中心 → 修改密码」；不要让这个文件进版本库\n`,
        'utf8',
      )
      setAdminPassword(next)
      const revoked = revokeOtherSessions(req)
      appendAudit(deps.db, {
        companyId: deps.companyId,
        actorUserId: 'console-operator',
        action: 'ops.console.password.change',
        resourceType: 'console_account',
        resourceId: username,
        result: 'success',
        ip: req.ip,
        channel: 'console',
        detail: { revokedSessions: revoked } as never,
      })
      return ok({ changed: true, revokedSessions: revoked })
    },
  )

  app.get('/api/console/companies', async (req) => {
    requireConsole(req, deps)
    /**
     * 单公司本地部署：控制台只认配置里的唯一公司。
     * 库里即使残留旧演示公司，也不再回给前端，避免顶栏出现“切换管理范围”。
     */
    const rows = deps.db
      .prepare(
        `SELECT c.id, c.name, c.status,
                (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id AND u.deleted_at IS NULL) AS users,
                (SELECT COUNT(*) FROM departments d WHERE d.company_id = c.id) AS depts,
                (SELECT COUNT(*) FROM kb_collections k WHERE k.company_id = c.id) AS collections
           FROM companies c
          WHERE c.id = ?
          ORDER BY c.created_at ASC`,
      )
      .all(deps.companyId) as unknown as Array<{
      id: string
      name: string
      status: string
      users: number
      depts: number
      collections: number
    }>
    return ok({
      singleCompany: true,
      companies: rows.map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status,
        counts: { users: Number(row.users), depts: Number(row.depts), collections: Number(row.collections) },
      })),
      defaultCompanyId: rows[0]?.id ?? null,
    })
  })

  /* ---------------- 角色与权限 ---------------- */

  app.get('/api/console/roles', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const rows = deps.db
      .prepare(
        `SELECT r.id, r.code, r.name, r.data_scope, r.builtin,
                (SELECT COUNT(*) FROM user_roles ur WHERE ur.role_id = r.id) AS members
           FROM roles r
          WHERE r.company_id = ? AND r.deleted_at IS NULL
          ORDER BY r.builtin DESC, r.code ASC`,
      )
      .all(companyId) as unknown as Array<{
      id: string
      code: string
      name: string
      data_scope: string
      builtin: number
      members: number
    }>

    const scopeRows = deps.db
      .prepare(
        `SELECT rs.role_id, rs.scope
           FROM role_scopes rs
           JOIN roles r ON r.id = rs.role_id
          WHERE r.company_id = ? AND r.deleted_at IS NULL`,
      )
      .all(companyId) as unknown as Array<{ role_id: string; scope: string }>
    const scopesByRole = new Map<string, string[]>()
    for (const row of scopeRows) {
      const list = scopesByRole.get(row.role_id) ?? []
      list.push(row.scope)
      scopesByRole.set(row.role_id, list)
    }

    const roleQuotaRows = deps.db
      .prepare(
        `SELECT scope_id, limit_bytes, file_limit_bytes
           FROM workspace_quota_policies
          WHERE company_id = ? AND scope_type = 'role'`,
      )
      .all(companyId) as unknown as Array<{
      scope_id: string
      limit_bytes: number
      file_limit_bytes: number
    }>
    const quotasByRole = new Map(
      roleQuotaRows.map((row) => [
        row.scope_id,
        { limitBytes: Number(row.limit_bytes), fileLimitBytes: Number(row.file_limit_bytes) },
      ]),
    )

    return ok({
      companyId,
      dataScopes: ['self', 'dept', 'company', 'global'],
      quotaDefaults: defaultWorkspaceQuota(deps.db, companyId),
      roles: rows.map((row) => ({
        code: row.code,
        name: row.name,
        dataScope: row.data_scope,
        builtin: row.builtin === 1,
        members: Number(row.members),
        scopes: (scopesByRole.get(row.id) ?? []).sort(),
        quota: quotasByRole.get(row.code) ?? null,
      })),
    })
  })

  app.put<{
    Params: { code: string }
    Body: { name?: string; dataScope?: string; scopes?: string[] }
  }>('/api/console/roles/:code', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const code = String(req.params.code)
    const role = deps.db
      .prepare('SELECT id, code, name, data_scope FROM roles WHERE company_id = ? AND code = ? AND deleted_at IS NULL')
      .get(companyId, code) as { id: string; code: string; name: string; data_scope: string } | undefined
    if (!role) throw new EabError(EC.NOT_FOUND, `角色不存在：${code}`)

    const name = req.body?.name === undefined ? role.name : String(req.body.name).trim()
    if (!name) throw new EabError(EC.VALIDATION, '角色名不能为空')

    const dataScope = req.body?.dataScope === undefined ? role.data_scope : String(req.body.dataScope)
    if (!DATA_SCOPES.has(dataScope)) {
      throw new EabError(EC.VALIDATION, `数据范围只能是 self / dept / company / global，当前是 ${dataScope}`)
    }

    let scopes: string[] | null = null
    if (req.body?.scopes !== undefined) {
      if (!Array.isArray(req.body.scopes)) throw new EabError(EC.VALIDATION, 'scopes 必须是数组')
      scopes = [...new Set(req.body.scopes.map((item) => String(item).trim()))]
      const unknown = scopes.filter((scope) => !isKnownScope(scope))
      if (unknown.length > 0) {
        throw new EabError(EC.VALIDATION, `存在未知权限点：${unknown.join('、')}`, {
          hint: `可用权限点见 /api/console/scopes`,
        })
      }
    }

    const now = Date.now()
    deps.db
      .prepare('UPDATE roles SET name = ?, data_scope = ? WHERE id = ?')
      .run(name, dataScope, role.id)
    if (scopes) {
      deps.db.prepare('DELETE FROM role_scopes WHERE role_id = ?').run(role.id)
      const insert = deps.db.prepare('INSERT INTO role_scopes (role_id, scope) VALUES (?, ?)')
      for (const scope of scopes) insert.run(role.id, scope)
    }

    return ok({ code, name, dataScope, scopes: scopes ?? null, updatedAt: new Date(now).toISOString() })
  })

  app.post<{
    Body: { code?: string; name?: string; dataScope?: string; scopes?: string[] }
  }>('/api/console/roles', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const code = String(req.body?.code ?? '').trim().toLowerCase()
    const name = String(req.body?.name ?? '').trim()
    if (!/^[a-z][a-z0-9_]{2,40}$/.test(code)) {
      throw new EabError(EC.VALIDATION, '角色标识只能是小写字母、数字、下划线，3–41 位，且以字母开头')
    }
    if (!name) throw new EabError(EC.VALIDATION, '角色名不能为空')
    if (name.length > 30) throw new EabError(EC.VALIDATION, '角色名不能超过 30 个字')
    const exists = deps.db
      .prepare('SELECT id FROM roles WHERE company_id = ? AND code = ? AND deleted_at IS NULL')
      .get(companyId, code)
    if (exists) throw new EabError(EC.VALIDATION, `角色标识已存在：${code}`)

    const dataScope = String(req.body?.dataScope ?? 'dept')
    if (!DATA_SCOPES.has(dataScope)) throw new EabError(EC.VALIDATION, '数据范围只能是 self / dept / company / global')
    const scopes = [...new Set((req.body?.scopes ?? []).map((item) => String(item).trim()).filter(Boolean))]
    const unknown = scopes.filter((scope) => !isKnownScope(scope))
    if (unknown.length > 0) throw new EabError(EC.VALIDATION, `存在未知权限点：${unknown.join('、')}`)

    const id = randomUUID()
    const now = Date.now()
    deps.db
      .prepare(
        'INSERT INTO roles (id, company_id, code, name, data_scope, builtin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
      )
      .run(id, companyId, code, name, dataScope, now)
    const insert = deps.db.prepare('INSERT INTO role_scopes (role_id, scope) VALUES (?, ?)')
    for (const scope of scopes) insert.run(id, scope)
    return ok({ id, code, name, dataScope, scopes, builtin: false })
  })

  app.post<{ Params: { code: string }; Body: { userIds?: string[] } }>(
    '/api/console/roles/:code/members',
    async (req) => {
      requireConsole(req, deps)
      const companyId = companyOf(req, deps)
      const code = String(req.params.code)
      const role = deps.db
        .prepare(
          `SELECT r.id, r.code, r.name, r.builtin,
                  (SELECT COUNT(*) FROM user_roles ur WHERE ur.role_id = r.id) AS members
             FROM roles r
            WHERE r.company_id = ? AND r.code = ? AND r.deleted_at IS NULL`,
        )
        .get(companyId, code) as
        | { id: string; code: string; name: string; builtin: number; members: number }
        | undefined
      if (!role) throw new EabError(EC.NOT_FOUND, `角色不存在：${code}`)

      const rawUserIds = req.body?.userIds
      if (!Array.isArray(rawUserIds)) throw new EabError(EC.VALIDATION, 'userIds 必须是数组')
      const userIds = [...new Set(rawUserIds.map((item) => String(item).trim()).filter(Boolean))]

      const users = deps.db
        .prepare('SELECT id, name FROM users WHERE company_id = ? AND deleted_at IS NULL')
        .all(companyId) as unknown as Array<{ id: string; name: string }>
      const userName = new Map(users.map((row) => [row.id, row.name]))
      const unknown = userIds.filter((id) => !userName.has(id))
      if (unknown.length > 0) {
        throw new EabError(EC.VALIDATION, `成员不存在或不属于当前公司：${unknown.join('、')}`)
      }

      const currentRows = deps.db
        .prepare('SELECT user_id FROM user_roles WHERE role_id = ?')
        .all(role.id) as unknown as Array<{ user_id: string }>
      const current = currentRows.map((row) => String(row.user_id))
      const wanted = new Set(userIds)
      const currentSet = new Set(current)
      const toAdd = userIds.filter((id) => !currentSet.has(id))
      const toRemove = current.filter((id) => !wanted.has(id))

      // 不允许通过角色页把某个成员的角色清空：成员必须至少保留一个角色
      if (toRemove.length > 0) {
        const roleCount = deps.db.prepare(
          'SELECT COUNT(*) AS n FROM user_roles WHERE user_id = ?',
        )
        for (const userId of toRemove) {
          // 已删除/不在当前公司的历史授权可以直接清掉，不参与「至少保留一个角色」判断
          if (!userName.has(userId)) continue
          const row = roleCount.get(userId) as { n: number } | undefined
          if (Number(row?.n ?? 0) <= 1) {
            throw new EabError(
              EC.VALIDATION,
              `成员「${userName.get(userId) ?? userId}」至少要保留一个角色；请先在成员管理中调整`,
            )
          }
        }
      }

      if (toRemove.length > 0) {
        const remove = deps.db.prepare('DELETE FROM user_roles WHERE role_id = ? AND user_id = ?')
        for (const userId of toRemove) remove.run(role.id, userId)
      }
      if (toAdd.length > 0) {
        const insert = deps.db.prepare(
          'INSERT OR IGNORE INTO user_roles (user_id, role_id, granted_by, granted_at) VALUES (?, ?, ?, ?)',
        )
        const now = Date.now()
        for (const userId of toAdd) insert.run(userId, role.id, 'console-operator', now)
      }

      appendAudit(deps.db, {
        companyId,
        actorUserId: 'console-operator',
        action: 'perm.role.members.sync',
        resourceType: 'role',
        resourceId: role.code,
        result: 'success',
        detail: { added: toAdd.length, removed: toRemove.length, members: userIds.length },
        ip: req.ip ?? null,
        channel: 'console',
      })

      return ok({
        code: role.code,
        members: userIds.length,
        added: toAdd.length,
        removed: toRemove.length,
      })
    },
  )

  app.delete<{ Params: { code: string } }>('/api/console/roles/:code', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const code = String(req.params.code)
    const role = deps.db
      .prepare(
        `SELECT r.id, r.code, r.name, r.builtin,
                (SELECT COUNT(*) FROM user_roles ur WHERE ur.role_id = r.id) AS members
           FROM roles r
          WHERE r.company_id = ? AND r.code = ? AND r.deleted_at IS NULL`,
      )
      .get(companyId, code) as
      | { id: string; code: string; name: string; builtin: number; members: number }
      | undefined
    if (!role) throw new EabError(EC.NOT_FOUND, `角色不存在：${code}`)
    if (Number(role.builtin) === 1) throw new EabError(EC.VALIDATION, '内置角色不能删除')

    // 删除自定义角色时，连带解除所有成员绑定，避免留下指向已删除角色的授权行
    deps.db.prepare('DELETE FROM user_roles WHERE role_id = ?').run(role.id)
    deps.db.prepare('DELETE FROM role_scopes WHERE role_id = ?').run(role.id)
    deps.db
      .prepare('DELETE FROM workspace_quota_policies WHERE company_id = ? AND scope_type = ? AND scope_id = ?')
      .run(companyId, 'role', role.code)
    deps.db.prepare('UPDATE roles SET deleted_at = ? WHERE id = ?').run(Date.now(), role.id)
    appendAudit(deps.db, {
      companyId,
      actorUserId: 'console-operator',
      action: 'perm.role.delete',
      resourceType: 'role',
      resourceId: role.code,
      result: 'success',
      detail: { name: role.name, unboundMembers: Number(role.members) },
      ip: req.ip ?? null,
      channel: 'console',
    })
    return ok({ code, deleted: true, unboundMembers: Number(role.members) })
  })

  /* ---------------- 个人工作区存储配额 ---------------- */

  function workspaceQuotaTarget(
    companyId: string,
    scopeType: string,
    scopeId: string,
  ): { scopeType: 'default' | 'role' | 'user'; scopeId: string } {
    if (scopeType === 'default') return { scopeType: 'default', scopeId: 'default' }
    if (scopeType === 'role') {
      const role = deps.db
        .prepare('SELECT id FROM roles WHERE company_id = ? AND code = ? AND deleted_at IS NULL')
        .get(companyId, scopeId)
      if (!role) throw new EabError(EC.NOT_FOUND, `角色不存在：${scopeId}`)
      return { scopeType: 'role', scopeId }
    }
    if (scopeType === 'user') {
      const user = deps.db
        .prepare('SELECT id FROM users WHERE company_id = ? AND id = ? AND deleted_at IS NULL')
        .get(companyId, scopeId)
      if (!user) throw new EabError(EC.NOT_FOUND, '成员不存在或不属于当前公司')
      return { scopeType: 'user', scopeId }
    }
    throw new EabError(EC.VALIDATION, 'scopeType 只能是 default / role / user')
  }

  function quotaBytesOf(value: unknown, field: string): number {
    const bytes = Number(value)
    if (!Number.isFinite(bytes) || bytes <= 0) {
      throw new EabError(EC.VALIDATION, `${field}必须是正整数（字节）`)
    }
    if (bytes > 1024 * 1024 * 1024 * 1024) {
      throw new EabError(EC.VALIDATION, `${field}不能超过 1 TB`)
    }
    return Math.floor(bytes)
  }

  app.get<{ Querystring: { userId?: string } }>('/api/console/workspace-quotas', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const defaults = defaultWorkspaceQuota(deps.db, companyId)
    const userId = String(req.query?.userId ?? '').trim()

    if (userId) {
      const user = deps.db
        .prepare('SELECT id, name FROM users WHERE company_id = ? AND id = ? AND deleted_at IS NULL')
        .get(companyId, userId) as { id: string; name: string } | undefined
      if (!user) throw new EabError(EC.NOT_FOUND, '成员不存在或不属于当前公司')
      return ok({
        defaults,
        userId: user.id,
        userName: user.name,
        policy: readWorkspaceQuotaPolicy(deps.db, companyId, 'user', user.id),
        effective: resolveUserWorkspaceQuota(deps.db, companyId, user.id),
      })
    }

    const rows = deps.db
      .prepare(
        `SELECT scope_type, scope_id, limit_bytes, file_limit_bytes
           FROM workspace_quota_policies
          WHERE company_id = ? AND scope_type IN ('role', 'user')
          ORDER BY scope_type, scope_id`,
      )
      .all(companyId) as unknown as Array<{
      scope_type: 'role' | 'user'
      scope_id: string
      limit_bytes: number
      file_limit_bytes: number
    }>
    return ok({
      defaults,
      roles: rows
        .filter((row) => row.scope_type === 'role')
        .map((row) => ({
          roleCode: row.scope_id,
          limitBytes: Number(row.limit_bytes),
          fileLimitBytes: Number(row.file_limit_bytes),
        })),
      users: rows
        .filter((row) => row.scope_type === 'user')
        .map((row) => ({
          userId: row.scope_id,
          limitBytes: Number(row.limit_bytes),
          fileLimitBytes: Number(row.file_limit_bytes),
        })),
    })
  })

  app.put<{
    Body: {
      scopeType?: string
      scopeId?: string
      limitBytes?: number | null
      fileLimitBytes?: number | null
    }
  }>('/api/console/workspace-quotas', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const target = workspaceQuotaTarget(
      companyId,
      String(req.body?.scopeType ?? ''),
      String(req.body?.scopeId ?? ''),
    )
    const limitBytes = req.body?.limitBytes
    const fileLimitBytes = req.body?.fileLimitBytes

    // 两个值都为空 = 清除该 scope 的单独配置，回落到上一级
    if (limitBytes == null && fileLimitBytes == null) {
      deps.db
        .prepare('DELETE FROM workspace_quota_policies WHERE company_id = ? AND scope_type = ? AND scope_id = ?')
        .run(companyId, target.scopeType, target.scopeId)
      appendAudit(deps.db, {
        companyId,
        actorUserId: 'console-operator',
        action: 'workspace.quota.clear',
        resourceType: 'workspace_quota',
        resourceId: `${target.scopeType}:${target.scopeId}`,
        result: 'success',
        ip: req.ip ?? null,
        channel: 'console',
      })
      return ok({ cleared: true, scopeType: target.scopeType, scopeId: target.scopeId })
    }
    if (limitBytes == null || fileLimitBytes == null) {
      throw new EabError(EC.VALIDATION, '容量和单文件上限要一起填，留空表示跟随上一级')
    }
    const nextLimit = quotaBytesOf(limitBytes, '个人容量')
    const nextFile = quotaBytesOf(fileLimitBytes, '单文件上限')
    if (nextFile > nextLimit) throw new EabError(EC.VALIDATION, '单文件上限不能大于个人容量')

    deps.db
      .prepare(
        `INSERT INTO workspace_quota_policies
           (company_id, scope_type, scope_id, limit_bytes, file_limit_bytes, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (company_id, scope_type, scope_id) DO UPDATE SET
           limit_bytes = excluded.limit_bytes,
           file_limit_bytes = excluded.file_limit_bytes,
           updated_at = excluded.updated_at`,
      )
      .run(companyId, target.scopeType, target.scopeId, nextLimit, nextFile, Date.now())
    appendAudit(deps.db, {
      companyId,
      actorUserId: 'console-operator',
      action: 'workspace.quota.set',
      resourceType: 'workspace_quota',
      resourceId: `${target.scopeType}:${target.scopeId}`,
      result: 'success',
      detail: { limitBytes: nextLimit, fileLimitBytes: nextFile },
      ip: req.ip ?? null,
      channel: 'console',
    })
    return ok({
      scopeType: target.scopeType,
      scopeId: target.scopeId,
      policy: { limitBytes: nextLimit, fileLimitBytes: nextFile },
    })
  })

  app.delete<{ Params: { scopeType: string; scopeId: string } }>(
    '/api/console/workspace-quotas/:scopeType/:scopeId',
    async (req) => {
      requireConsole(req, deps)
      const companyId = companyOf(req, deps)
      const target = workspaceQuotaTarget(
        companyId,
        String(req.params.scopeType),
        decodeURIComponent(String(req.params.scopeId)),
      )
      deps.db
        .prepare('DELETE FROM workspace_quota_policies WHERE company_id = ? AND scope_type = ? AND scope_id = ?')
        .run(companyId, target.scopeType, target.scopeId)
      appendAudit(deps.db, {
        companyId,
        actorUserId: 'console-operator',
        action: 'workspace.quota.clear',
        resourceType: 'workspace_quota',
        resourceId: `${target.scopeType}:${target.scopeId}`,
        result: 'success',
        ip: req.ip ?? null,
        channel: 'console',
      })
      return ok({ cleared: true })
    },
  )

  app.get('/api/console/scopes', async (req) => {
    requireConsole(req, deps)
    return ok({
      scopes: ALL_SCOPES,
      labels: Object.fromEntries(ALL_SCOPES.map((scope) => [scope, SCOPE_REGISTRY[scope].label])),
      groups: Object.fromEntries(ALL_SCOPES.map((scope) => [scope, SCOPE_REGISTRY[scope].group])),
      dangerous: ALL_SCOPES.filter((scope) => SCOPE_REGISTRY[scope].dangerous === true),
    })
  })

  app.post<{ Params: { userId: string }; Body: { roles?: string[] } }>(
    '/api/console/members/:userId/roles',
    async (req) => {
      requireConsole(req, deps)
      const companyId = companyOf(req, deps)
      const userId = String(req.params.userId)
      const user = deps.db
        .prepare('SELECT id, name FROM users WHERE id = ? AND company_id = ? AND deleted_at IS NULL')
        .get(userId, companyId) as { id: string; name: string } | undefined
      if (!user) throw new EabError(EC.NOT_FOUND, '成员不存在或不属于当前公司')

      const codes = req.body?.roles
      if (!Array.isArray(codes)) throw new EabError(EC.VALIDATION, 'roles 必须是数组')
      const wanted = [...new Set(codes.map((item) => String(item).trim()).filter(Boolean))]
      const roles = deps.db
        .prepare('SELECT id, code FROM roles WHERE company_id = ? AND deleted_at IS NULL')
        .all(companyId) as unknown as Array<{ id: string; code: string }>
      const byCode = new Map(roles.map((row) => [row.code, row.id]))
      const unknown = wanted.filter((code) => !byCode.has(code))
      if (unknown.length > 0) throw new EabError(EC.VALIDATION, `未知角色：${unknown.join('、')}`)
      if (wanted.length === 0) throw new EabError(EC.VALIDATION, '至少保留一个角色')

      deps.db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(userId)
      const insert = deps.db.prepare(
        'INSERT INTO user_roles (user_id, role_id, granted_by, granted_at) VALUES (?, ?, ?, ?)',
      )
      for (const code of wanted) insert.run(userId, byCode.get(code) as string, 'console-operator', Date.now())
      return ok({ userId, name: user.name, roles: wanted })
    },
  )

  /* ---------------- 知识库配置 ---------------- */

  const KB_ACL_MODES = new Set(['all', 'roles', 'depts'])

  function validateKbAcl(
    companyId: string,
    aclMode: string,
    roles: string[],
    deptPaths: string[],
  ): { roles: string[]; deptPaths: string[] } {
    if (!KB_ACL_MODES.has(aclMode)) throw new EabError(EC.VALIDATION, '可见范围只能是 all / roles / depts')
    if (aclMode === 'roles') {
      if (roles.length === 0) throw new EabError(EC.VALIDATION, '选择“按角色”时至少要选一个角色')
      const known = deps.db
        .prepare('SELECT code FROM roles WHERE company_id = ? AND deleted_at IS NULL')
        .all(companyId) as unknown as Array<{ code: string }>
      const unknown = roles.filter((code) => !known.some((row) => row.code === code))
      if (unknown.length > 0) throw new EabError(EC.VALIDATION, `未知角色：${unknown.join('、')}`)
    }
    if (aclMode === 'depts') {
      if (deptPaths.length === 0) throw new EabError(EC.VALIDATION, '选择“按部门”时至少要选一个部门')
      const known = deps.db
        .prepare('SELECT path FROM departments WHERE company_id = ? AND deleted_at IS NULL')
        .all(companyId) as unknown as Array<{ path: string }>
      const unknown = deptPaths.filter((path) => !known.some((row) => row.path === path))
      if (unknown.length > 0) throw new EabError(EC.VALIDATION, `未知部门路径：${unknown.join('、')}`)
    }
    return {
      roles: aclMode === 'roles' ? [...new Set(roles)] : [],
      deptPaths: aclMode === 'depts' ? [...new Set(deptPaths)] : [],
    }
  }

  const KB_SOURCE_KINDS = new Set(['local', 'dify', 'obsidian', 'generic'])

  function normalizeKbSource(kindRaw: unknown, configRaw: unknown): { kind: string; config: Record<string, unknown> } {
    const kind = String(kindRaw ?? 'local')
    if (!KB_SOURCE_KINDS.has(kind)) throw new EabError(EC.VALIDATION, `不支持的知识库来源：${kind}`)
    const input = configRaw && typeof configRaw === 'object' && !Array.isArray(configRaw)
      ? (configRaw as Record<string, unknown>)
      : {}
    if (kind === 'local') return { kind, config: {} }
    if (kind === 'dify') {
      const baseUrl = String(input.baseUrl ?? '').trim()
      const datasetId = String(input.datasetId ?? '').trim()
      if (!/^https?:\/\//i.test(baseUrl)) throw new EabError(EC.VALIDATION, 'Dify 地址必须是 http(s) URL')
      if (!datasetId) throw new EabError(EC.VALIDATION, 'Dify 知识库 ID（datasetId）不能为空')
      return { kind, config: { baseUrl, datasetId } }
    }
    if (kind === 'obsidian') {
      const vaultPath = String(input.vaultPath ?? '').trim()
      if (!vaultPath) throw new EabError(EC.VALIDATION, 'Obsidian Vault 目录不能为空')
      const classification = String(input.classification ?? 'internal')
      if (!['public', 'internal', 'confidential'].includes(classification)) {
        throw new EabError(EC.VALIDATION, 'Obsidian 密级只能是 public / internal / confidential')
      }
      return { kind, config: { vaultPath, classification } }
    }
    const endpoint = String(input.endpoint ?? '').trim()
    if (!/^https?:\/\//i.test(endpoint)) throw new EabError(EC.VALIDATION, '外部知识库地址必须是 http(s) URL')
    const method = String(input.method ?? 'POST').toUpperCase()
    if (!['GET', 'POST'].includes(method)) throw new EabError(EC.VALIDATION, '通用 HTTP 只支持 GET / POST')
    return {
      kind,
      config: {
        endpoint,
        method,
        queryField: String(input.queryField ?? 'query').trim() || 'query',
        topKField: String(input.topKField ?? 'top_k').trim() || 'top_k',
        resultsPath: String(input.resultsPath ?? 'results').trim() || 'results',
        titleField: String(input.titleField ?? 'title').trim() || 'title',
        textField: String(input.textField ?? 'text').trim() || 'text',
      },
    }
  }

  function chunkKbContent(content: string): string[] {
    const rawChunks = content
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .filter(Boolean)
    const chunks: string[] = []
    for (const part of rawChunks.length ? rawChunks : [content]) {
      if (part.length <= 800) chunks.push(part)
      else for (let i = 0; i < part.length; i += 800) chunks.push(part.slice(i, i + 800))
    }
    return chunks
  }

  app.get('/api/console/kb/collections', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const rows = deps.db
      .prepare(
        `SELECT c.id, c.name, c.description, c.acl_mode, c.acl_roles, c.acl_dept_paths, c.created_at,
                c.source_kind, c.source_config, c.source_secret_ref, c.last_synced_at,
                (SELECT COUNT(*) FROM kb_docs d
                   WHERE d.collection_id = c.id AND d.company_id = c.company_id AND d.status != 'deleted') AS doc_count
           FROM kb_collections c
          WHERE c.company_id = ? AND c.deleted_at IS NULL
          ORDER BY c.created_at ASC`,
      )
      .all(companyId) as unknown as Array<{
      id: string
      name: string
      description: string | null
      acl_mode: string
      acl_roles: string | null
      acl_dept_paths: string | null
      created_at: number
      source_kind: string | null
      source_config: string | null
      source_secret_ref: string | null
      last_synced_at: number | null
      doc_count: number
    }>
    return ok({
      companyId,
      collections: rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description ?? '',
        aclMode: row.acl_mode,
        roles: parseList(row.acl_roles),
        deptPaths: parseList(row.acl_dept_paths),
        docCount: Number(row.doc_count ?? 0),
        createdAt: Number(row.created_at),
        sourceKind: row.source_kind ?? 'local',
        sourceLabel: KB_SOURCE_LABEL[(row.source_kind ?? 'local') as keyof typeof KB_SOURCE_LABEL] ?? row.source_kind,
        sourceConfig: row.source_config ? (JSON.parse(row.source_config) as unknown) : {},
        sourceSecretConfigured: secretConfigured(deps.config.dbPath, row.source_secret_ref),
        lastSyncedAt: row.last_synced_at,
      })),
    })
  })

  app.post<{
    Body: {
      name?: string
      description?: string
      aclMode?: string
      roles?: string[]
      deptPaths?: string[]
      sourceKind?: string
      sourceConfig?: Record<string, unknown>
      sourceSecret?: string
    }
  }>('/api/console/kb/collections', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const name = String(req.body?.name ?? '').trim()
    if (!name) throw new EabError(EC.VALIDATION, '知识库名称不能为空')
    if (name.length > 60) throw new EabError(EC.VALIDATION, '知识库名称最多 60 个字')
    const description = String(req.body?.description ?? '').trim()
    const aclMode = String(req.body?.aclMode ?? 'all')
    const roles = Array.isArray(req.body?.roles) ? req.body.roles.map(String) : []
    const deptPaths = Array.isArray(req.body?.deptPaths) ? req.body.deptPaths.map(String) : []
    const acl = validateKbAcl(companyId, aclMode, roles, deptPaths)
    const source = normalizeKbSource(req.body?.sourceKind, req.body?.sourceConfig)
    const sourceSecret = String(req.body?.sourceSecret ?? '').trim()
    const sourceSecretRef = sourceSecret
      ? storeSecret(deps.config.dbPath, null, sourceSecret, `EAB_KB_${source.kind.toUpperCase()}`)
      : null

    const dup = deps.db
      .prepare('SELECT id FROM kb_collections WHERE company_id = ? AND name = ? AND deleted_at IS NULL')
      .get(companyId, name)
    if (dup) throw new EabError(EC.VALIDATION, `同名知识库已存在：${name}`)

    const id = `kb_${randomUUID()}`
    const now = Date.now()
    deps.db
      .prepare(
        `INSERT INTO kb_collections
           (id, company_id, name, description, acl_mode, acl_roles, acl_dept_paths, status, created_by,
            source_kind, source_config, source_secret_ref, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'console-operator', ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        companyId,
        name,
        description || null,
        aclMode,
        JSON.stringify(acl.roles),
        JSON.stringify(acl.deptPaths),
        source.kind,
        JSON.stringify(source.config),
        sourceSecretRef,
        now,
        now,
      )
    return ok({
      collection: {
        id,
        name,
        description,
        aclMode,
        roles: acl.roles,
        deptPaths: acl.deptPaths,
        sourceKind: source.kind,
        sourceLabel: KB_SOURCE_LABEL[source.kind as keyof typeof KB_SOURCE_LABEL] ?? source.kind,
        sourceConfig: source.config,
      },
    })
  })

  app.patch<{
    Params: { id: string }
    Body: {
      name?: string
      description?: string
      aclMode?: string
      roles?: string[]
      deptPaths?: string[]
      sourceKind?: string
      sourceConfig?: Record<string, unknown>
      sourceSecret?: string
    }
  }>('/api/console/kb/collections/:id', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const row = deps.db
      .prepare(
        `SELECT id, name, description, acl_mode, acl_roles, acl_dept_paths,
                source_kind, source_config, source_secret_ref
           FROM kb_collections WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
      )
      .get(String(req.params.id), companyId) as
      | {
          id: string
          name: string
          description: string | null
          acl_mode: string
          acl_roles: string | null
          acl_dept_paths: string | null
          source_kind: string | null
          source_config: string | null
          source_secret_ref: string | null
        }
      | undefined
    if (!row) throw new EabError(EC.NOT_FOUND, '知识库不存在')

    const name = req.body?.name === undefined ? row.name : String(req.body.name).trim()
    if (!name) throw new EabError(EC.VALIDATION, '知识库名称不能为空')
    const description = req.body?.description === undefined ? (row.description ?? '') : String(req.body.description).trim()
    const aclMode = req.body?.aclMode === undefined ? row.acl_mode : String(req.body.aclMode)
    const roles = req.body?.roles === undefined ? parseList(row.acl_roles) : req.body.roles.map(String)
    const deptPaths = req.body?.deptPaths === undefined ? parseList(row.acl_dept_paths) : req.body.deptPaths.map(String)
    const acl = validateKbAcl(companyId, aclMode, roles, deptPaths)
    let existingConfig: Record<string, unknown> = {}
    try {
      const parsed: unknown = row.source_config ? JSON.parse(row.source_config) : {}
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existingConfig = parsed as Record<string, unknown>
    } catch {
      existingConfig = {}
    }
    const source = normalizeKbSource(
      req.body?.sourceKind ?? row.source_kind ?? 'local',
      req.body?.sourceConfig ?? existingConfig,
    )
    const sourceSecret = String(req.body?.sourceSecret ?? '').trim()
    const sourceSecretRef = sourceSecret
      ? storeSecret(deps.config.dbPath, row.source_secret_ref, sourceSecret, `EAB_KB_${source.kind.toUpperCase()}`)
      : source.kind === 'local'
        ? null
        : row.source_secret_ref

    deps.db
      .prepare(
        `UPDATE kb_collections
            SET name = ?, description = ?, acl_mode = ?, acl_roles = ?, acl_dept_paths = ?,
                source_kind = ?, source_config = ?, source_secret_ref = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        name,
        description || null,
        aclMode,
        JSON.stringify(acl.roles),
        JSON.stringify(acl.deptPaths),
        source.kind,
        JSON.stringify(source.config),
        sourceSecretRef,
        Date.now(),
        row.id,
      )
    return ok({
      collection: {
        id: row.id,
        name,
        description,
        aclMode,
        roles: acl.roles,
        deptPaths: acl.deptPaths,
        sourceKind: source.kind,
        sourceLabel: KB_SOURCE_LABEL[source.kind as keyof typeof KB_SOURCE_LABEL] ?? source.kind,
        sourceConfig: source.config,
        sourceSecretConfigured: secretConfigured(deps.config.dbPath, sourceSecretRef),
      },
    })
  })

  app.delete<{ Params: { id: string } }>('/api/console/kb/collections/:id', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const row = deps.db
      .prepare('SELECT id FROM kb_collections WHERE id = ? AND company_id = ? AND deleted_at IS NULL')
      .get(String(req.params.id), companyId)
    if (!row) throw new EabError(EC.NOT_FOUND, '知识库不存在')
    const now = Date.now()
    const collectionId = String(req.params.id)
    deps.db.exec('BEGIN')
    try {
      deps.db.prepare('DELETE FROM kb_chunks WHERE collection_id = ? AND company_id = ?').run(collectionId, companyId)
      deps.db
        .prepare(`UPDATE kb_docs SET status = 'deleted', deleted_at = ?, chunk_count = 0, updated_at = ?
                   WHERE collection_id = ? AND company_id = ? AND deleted_at IS NULL`)
        .run(now, now, collectionId, companyId)
      deps.db
        .prepare('UPDATE kb_collections SET deleted_at = ?, updated_at = ? WHERE id = ?')
        .run(now, now, collectionId)
      deps.db.exec('COMMIT')
    } catch (error) {
      deps.db.exec('ROLLBACK')
      throw error
    }
    return ok({ deleted: true })
  })

  app.get<{ Params: { id: string } }>('/api/console/kb/collections/:id/docs', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const collectionId = String(req.params.id)
    const collection = deps.db
      .prepare(
        `SELECT id, name, acl_mode, source_kind, source_config, source_secret_ref
           FROM kb_collections WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
      )
      .get(collectionId, companyId) as
      | {
          id: string
          name: string
          acl_mode: string
          source_kind: string | null
          source_config: string | null
          source_secret_ref: string | null
        }
      | undefined
    if (!collection) throw new EabError(EC.NOT_FOUND, '知识库不存在')

    const sourceKind = collection.source_kind ?? 'local'
    const external = sourceKind === 'dify' || sourceKind === 'generic'
    if (external) {
      const remoteDocs = await listExternalDocs(deps.config.dbPath, {
        id: collection.id,
        name: collection.name,
        source_kind: sourceKind,
        source_config: collection.source_config,
        source_secret_ref: collection.source_secret_ref,
      })
      return ok({
        collection: {
          id: collection.id,
          name: collection.name,
          aclMode: collection.acl_mode,
          sourceKind,
          sourceLabel: KB_SOURCE_LABEL[sourceKind as keyof typeof KB_SOURCE_LABEL] ?? sourceKind,
        },
        external: true,
        docs: remoteDocs.map((doc) => ({
          id: doc.id,
          title: doc.title,
          classification: 'internal',
          chunkCount: doc.chunkCount,
          status: doc.status,
          visible: true,
          sourceUri: doc.sourceUri,
        })),
      })
    }

    const docs = deps.db
      .prepare(
        `SELECT id, title, classification, chunk_count, status, index_error, indexed_at, index_model_id
           FROM kb_docs
          WHERE collection_id = ? AND company_id = ? AND deleted_at IS NULL
          ORDER BY title`,
      )
      .all(collectionId, companyId) as unknown as Array<{
      id: string
      title: string
      classification: string
      chunk_count: number
      status: string
      index_error: string | null
      indexed_at: number | null
      index_model_id: string | null
    }>
    const vectorStats = collectionVectorStats(deps.db, companyId, collectionId)
    return ok({
      collection: {
        id: collection.id,
        name: collection.name,
        aclMode: collection.acl_mode,
        sourceKind,
        sourceLabel: KB_SOURCE_LABEL[sourceKind as keyof typeof KB_SOURCE_LABEL] ?? sourceKind,
      },
      external: false,
      vector: vectorStats,
      docs: docs.map((doc) => ({
        id: doc.id,
        title: doc.title,
        classification: doc.classification,
        chunkCount: Number(doc.chunk_count),
        status: doc.status,
        indexError: doc.index_error,
        indexedAt: doc.indexed_at ? new Date(Number(doc.indexed_at)).toISOString() : null,
        indexModelId: doc.index_model_id,
        visible: doc.classification !== 'confidential',
      })),
    })
  })

  app.post<{
    Params: { id: string }
    Body: { docId?: string }
  }>('/api/console/kb/collections/:id/reindex', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const collectionId = String(req.params.id)
    const collection = deps.db
      .prepare('SELECT id, name, source_kind FROM kb_collections WHERE id = ? AND company_id = ? AND deleted_at IS NULL')
      .get(collectionId, companyId) as { id: string; name: string; source_kind: string | null } | undefined
    if (!collection) throw new EabError(EC.NOT_FOUND, '知识库不存在')
    if (collection.source_kind === 'dify' || collection.source_kind === 'generic') {
      throw new EabError(EC.VALIDATION, '外部知识库的向量化由上游负责，EAB 不重建在线文档索引')
    }
    const docId = req.body?.docId ? String(req.body.docId) : undefined
    if (docId) {
      const doc = deps.db
        .prepare('SELECT id FROM kb_docs WHERE id = ? AND collection_id = ? AND company_id = ? AND deleted_at IS NULL')
        .get(docId, collectionId, companyId)
      if (!doc) throw new EabError(EC.NOT_FOUND, '文档不存在')
    }
    const job = startKbIndexJob(deps.db, deps.config.dbPath, companyId, collectionId, docId ? { docId } : {})
    return ok({
      jobId: job.jobId,
      modelId: job.modelId,
      collectionId,
      docId: docId ?? null,
      message: '索引任务已开始，完成后可在索引状态里查看',
    })
  })

  app.get<{ Params: { id: string } }>('/api/console/kb/collections/:id/index-status', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const collectionId = String(req.params.id)
    const job = latestKbIndexJob(deps.db, companyId, collectionId)
    const vector = collectionVectorStats(deps.db, companyId, collectionId)
    return ok({
      collectionId,
      job: job
        ? {
            id: job.id,
            status: job.status,
            total: Number(job.total),
            done: Number(job.done),
            failed: Number(job.failed),
            error: job.error,
            modelId: job.model_id,
          }
        : null,
      vector,
    })
  })

  app.post<{
    Params: { id: string }
    Body: { title?: string; content?: string; classification?: string }
  }>('/api/console/kb/collections/:id/docs', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const collectionId = String(req.params.id)
    const collection = deps.db
      .prepare('SELECT id, name, source_kind FROM kb_collections WHERE id = ? AND company_id = ? AND deleted_at IS NULL')
      .get(collectionId, companyId) as { id: string; name: string; source_kind: string | null } | undefined
    if (!collection) throw new EabError(EC.NOT_FOUND, '知识库不存在')
    if (collection.source_kind === 'dify' || collection.source_kind === 'generic') {
      throw new EabError(EC.VALIDATION, '外部知识库的文档由上游管理，不能在 EAB 里新增')
    }

    const title = String(req.body?.title ?? '').trim()
    const content = String(req.body?.content ?? '').trim()
    if (!title) throw new EabError(EC.VALIDATION, '文档标题不能为空')
    if (!content) throw new EabError(EC.VALIDATION, '文档正文不能为空')
    const classification = String(req.body?.classification ?? 'internal')
    if (!['public', 'internal', 'confidential'].includes(classification)) {
      throw new EabError(EC.VALIDATION, '密级只能是 public / internal / confidential')
    }

    const docId = `doc_${randomUUID()}`
    const now = Date.now()
    const rawChunks = content
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .filter(Boolean)
    const chunks: string[] = []
    for (const part of rawChunks.length ? rawChunks : [content]) {
      if (part.length <= 800) chunks.push(part)
      else for (let i = 0; i < part.length; i += 800) chunks.push(part.slice(i, i + 800))
    }

    deps.db
      .prepare(
        `INSERT INTO kb_docs
           (id, company_id, collection_id, title, source_type, mime, size_bytes, classification, status, chunk_count, content, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'manual', 'text/plain', ?, ?, 'indexed', ?, ?, ?, ?)`,
      )
      .run(docId, companyId, collectionId, title, Buffer.byteLength(content, 'utf8'), classification, chunks.length, content, now, now)
    const insertChunk = deps.db.prepare(
      `INSERT INTO kb_chunks (id, company_id, doc_id, collection_id, ordinal, text, token_count, classification, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    chunks.forEach((text, ordinal) => {
      insertChunk.run(`chunk_${randomUUID()}`, companyId, docId, collectionId, ordinal, text, Math.ceil(text.length / 2), classification, now)
    })

    // 文本先可用：向量化是增强，不是上传前置条件。配了向量模型就后台补索引，没配就保持关键词可检索。
    try {
      startKbIndexJob(deps.db, deps.config.dbPath, companyId, collectionId, { docId })
    } catch (err) {
      if (err instanceof EabError) {
        deps.db
          .prepare('UPDATE kb_docs SET index_error = ? WHERE id = ?')
          .run(err.message.slice(0, 500), docId)
      }
    }

    return ok({ doc: { id: docId, title, classification, chunks: chunks.length, collectionId } })
  })

  app.get<{ Params: { docId: string } }>('/api/console/kb/docs/:docId', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const row = deps.db
      .prepare(
        `SELECT d.id, d.collection_id, d.title, d.classification, d.chunk_count, d.status, d.content,
                k.name AS collection_name, k.source_kind
           FROM kb_docs d
           JOIN kb_collections k ON k.id = d.collection_id
          WHERE d.id = ? AND d.company_id = ? AND d.deleted_at IS NULL`,
      )
      .get(String(req.params.docId), companyId) as
      | {
          id: string
          collection_id: string
          title: string
          classification: string
          chunk_count: number
          status: string
          content: string | null
          collection_name: string
          source_kind: string | null
        }
      | undefined
    if (!row) throw new EabError(EC.NOT_FOUND, '文档不存在')
    let content = row.content
    if (content === null || content === '') {
      const chunks = deps.db
        .prepare('SELECT text FROM kb_chunks WHERE doc_id = ? AND company_id = ? ORDER BY ordinal')
        .all(row.id, companyId) as unknown as Array<{ text: string }>
      content = chunks.map((chunk) => chunk.text).join('\n\n')
    }
    return ok({
      doc: {
        id: row.id,
        collectionId: row.collection_id,
        collectionName: row.collection_name,
        title: row.title,
        classification: row.classification,
        chunkCount: Number(row.chunk_count),
        status: row.status,
        content,
        sourceKind: row.source_kind ?? 'local',
      },
    })
  })

  app.patch<{
    Params: { docId: string }
    Body: { title?: string; content?: string; classification?: string }
  }>('/api/console/kb/docs/:docId', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const row = deps.db
      .prepare(
        `SELECT d.id, d.collection_id, d.title, d.classification, d.content, k.source_kind
           FROM kb_docs d
           JOIN kb_collections k ON k.id = d.collection_id
          WHERE d.id = ? AND d.company_id = ? AND d.deleted_at IS NULL`,
      )
      .get(String(req.params.docId), companyId) as
      | { id: string; collection_id: string; title: string; classification: string; content: string | null; source_kind: string | null }
      | undefined
    if (!row) throw new EabError(EC.NOT_FOUND, '文档不存在')
    if (row.source_kind === 'dify' || row.source_kind === 'generic') {
      throw new EabError(EC.VALIDATION, '外部知识库文档由上游管理，不能在 EAB 里编辑')
    }

    const title = req.body?.title === undefined ? row.title : String(req.body.title).trim()
    if (!title) throw new EabError(EC.VALIDATION, '文档标题不能为空')
    let content = req.body?.content === undefined ? row.content : String(req.body.content)
    if (content === null || content === '') {
      const chunks = deps.db
        .prepare('SELECT text FROM kb_chunks WHERE doc_id = ? AND company_id = ? ORDER BY ordinal')
        .all(row.id, companyId) as unknown as Array<{ text: string }>
      content = chunks.map((chunk) => chunk.text).join('\n\n')
    }
    content = String(content ?? '').trim()
    if (!content) throw new EabError(EC.VALIDATION, '文档正文不能为空')
    const classification = String(req.body?.classification ?? row.classification)
    if (!['public', 'internal', 'confidential'].includes(classification)) {
      throw new EabError(EC.VALIDATION, '密级只能是 public / internal / confidential')
    }
    const chunks = chunkKbContent(content)
    const now = Date.now()
    const checksum = createHash('sha256').update(content).digest('hex')
    deps.db.exec('BEGIN')
    try {
      deps.db.prepare('DELETE FROM kb_chunks WHERE doc_id = ? AND company_id = ?').run(row.id, companyId)
      const insertChunk = deps.db.prepare(
        `INSERT INTO kb_chunks (id, company_id, doc_id, collection_id, ordinal, text, token_count, classification, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      chunks.forEach((text, ordinal) => {
        insertChunk.run(
          `chunk_${randomUUID()}`,
          companyId,
          row.id,
          row.collection_id,
          ordinal,
          text,
          Math.ceil(text.length / 2),
          classification,
          now,
        )
      })
      deps.db
        .prepare(
          `UPDATE kb_docs
              SET title = ?, classification = ?, size_bytes = ?, checksum = ?, status = 'indexed',
                  chunk_count = ?, content = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(title, classification, Buffer.byteLength(content, 'utf8'), checksum, chunks.length, content, now, row.id)
      deps.db.exec('COMMIT')
    } catch (error) {
      deps.db.exec('ROLLBACK')
      throw error
    }
    try {
      startKbIndexJob(deps.db, deps.config.dbPath, companyId, row.collection_id, { docId: row.id })
    } catch (err) {
      if (err instanceof EabError) {
        deps.db.prepare('UPDATE kb_docs SET index_error = ? WHERE id = ?').run(err.message.slice(0, 500), row.id)
      }
    }
    return ok({
      doc: {
        id: row.id,
        collectionId: row.collection_id,
        title,
        classification,
        chunks: chunks.length,
        content,
      },
    })
  })

  app.delete<{ Params: { docId: string } }>('/api/console/kb/docs/:docId', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const row = deps.db
      .prepare(
        `SELECT d.id, d.collection_id, k.source_kind
           FROM kb_docs d
           JOIN kb_collections k ON k.id = d.collection_id
          WHERE d.id = ? AND d.company_id = ? AND d.deleted_at IS NULL`,
      )
      .get(String(req.params.docId), companyId) as
      | { id: string; collection_id: string; source_kind: string | null }
      | undefined
    if (!row) throw new EabError(EC.NOT_FOUND, '文档不存在')
    if (row.source_kind === 'dify' || row.source_kind === 'generic') {
      throw new EabError(EC.VALIDATION, '外部知识库文档由上游管理，不能在 EAB 里删除')
    }
    const now = Date.now()
    deps.db.exec('BEGIN')
    try {
      deps.db.prepare('DELETE FROM kb_chunks WHERE doc_id = ? AND company_id = ?').run(row.id, companyId)
      deps.db
        .prepare(`UPDATE kb_docs SET status = 'deleted', deleted_at = ?, chunk_count = 0, updated_at = ?
                   WHERE id = ?`)
        .run(now, now, row.id)
      deps.db.exec('COMMIT')
    } catch (error) {
      deps.db.exec('ROLLBACK')
      throw error
    }
    return ok({ deleted: true })
  })

  app.post<{ Params: { id: string } }>('/api/console/kb/collections/:id/test', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const row = deps.db
      .prepare(
        `SELECT id, name, source_kind, source_config, source_secret_ref
           FROM kb_collections WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
      )
      .get(String(req.params.id), companyId) as
      | { id: string; name: string; source_kind: string | null; source_config: string | null; source_secret_ref: string | null }
      | undefined
    if (!row) throw new EabError(EC.NOT_FOUND, '知识库不存在')
    const outcome = await probeExternalCollection(deps.config.dbPath, {
      id: row.id,
      name: row.name,
      source_kind: row.source_kind ?? 'local',
      source_config: row.source_config,
      source_secret_ref: row.source_secret_ref,
    })
    return ok({ sourceKind: row.source_kind ?? 'local', ...outcome })
  })

  app.post<{ Params: { id: string } }>('/api/console/kb/collections/:id/sync', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const row = deps.db
      .prepare(
        `SELECT id, name, source_kind, source_config, source_secret_ref
           FROM kb_collections WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
      )
      .get(String(req.params.id), companyId) as
      | { id: string; name: string; source_kind: string | null; source_config: string | null; source_secret_ref: string | null }
      | undefined
    if (!row) throw new EabError(EC.NOT_FOUND, '知识库不存在')
    if (row.source_kind !== 'obsidian') {
      throw new EabError(EC.VALIDATION, '只有 Obsidian 库需要同步；Dify / 通用 HTTP 走在线检索')
    }
    const outcome = await syncObsidianCollection(deps.db, companyId, {
      id: row.id,
      name: row.name,
      source_kind: row.source_kind,
      source_config: row.source_config,
      source_secret_ref: row.source_secret_ref,
    })
    deps.db
      .prepare('UPDATE kb_collections SET last_synced_at = ?, updated_at = ? WHERE id = ?')
      .run(Date.now(), Date.now(), row.id)
    try {
      startKbIndexJob(deps.db, deps.config.dbPath, companyId, row.id)
    } catch (err) {
      if (err instanceof EabError) {
        deps.db
          .prepare('UPDATE kb_docs SET index_error = ? WHERE collection_id = ? AND company_id = ? AND deleted_at IS NULL')
          .run(err.message.slice(0, 500), row.id, companyId)
      }
    }
    return ok({ sourceKind: row.source_kind, ...outcome })
  })

  /* ---------------- 模型接入 ---------------- */

  app.get('/api/console/model-kinds', async (req) => {
    requireConsole(req, deps)
    return ok({ kinds: PROVIDER_KINDS })
  })

  app.get('/api/console/providers', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const rows = deps.db
      .prepare(
        `SELECT p.id, p.kind, p.name, p.base_url, p.api_key_env, p.status, p.created_at,
                (SELECT COUNT(*) FROM models m WHERE m.provider_id = p.id AND m.deleted_at IS NULL) AS models
           FROM model_providers p
          WHERE p.company_id = ? AND p.deleted_at IS NULL
          ORDER BY p.created_at ASC`,
      )
      .all(companyId) as unknown as Array<{
      id: string
      kind: string
      name: string
      base_url: string | null
      api_key_env: string | null
      status: string
      created_at: number
      models: number
    }>

    return ok({
      companyId,
      kinds: PROVIDER_KINDS,
      providers: [
        ...rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          kindLabel: PROVIDER_KINDS.find((item) => item.kind === row.kind)?.label ?? row.kind,
          name: row.name,
          baseUrl: row.base_url,
          apiKeyEnv: row.api_key_env,
          keyPresent: row.api_key_env ? secretConfigured(deps.config.dbPath, row.api_key_env) : null,
          status: row.status,
          models: Number(row.models),
          source: 'db' as const,
          readonly: false,
        })),
        ...listPluginChannels(companyId).map((channel) => ({
          id: channel.id,
          kind: 'plugin',
          kindLabel: 'DSH 插件通道',
          name: channel.name,
          baseUrl: '',
          apiKeyEnv: '',
          keyPresent: null,
          status: channel.status,
          models: channel.models,
          source: 'plugin' as const,
          readonly: true,
          pluginId: channel.pluginId,
          route: channel.route,
          configurable: channel.configurable,
          discovery: channel.discovery,
          settingsNs: channel.settingsNs,
          settingsPath: channel.settingsPath,
        })),
      ],
    })
  })

  app.post<{ Params: { id: string } }>('/api/console/plugin-channels/:id/refresh', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const channelId = String(req.params.id)
    const channels = listPluginChannels(companyId)
    if (!channels.some((channel) => channel.id === channelId)) {
      throw new EabError(EC.NOT_FOUND, '插件通道不存在、未启用或尚未完成注册')
    }
    await refreshPluginChannel(companyId, channelId)
    const probe = await probePluginChannelModels(companyId, channelId)
    return ok({ channelId, models: probe.healthy, checked: probe.checked })
  })

  app.post<{
    Body: { kind?: string; name?: string; baseUrl?: string; apiKeyEnv?: string; apiKey?: string }
  }>('/api/console/providers', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const kind = String(req.body?.kind ?? '')
    if (!PROVIDER_KIND_SET.has(kind as ProviderKind)) {
      throw new EabError(EC.VALIDATION, `不支持的供应商类型：${kind}`)
    }
    const name = String(req.body?.name ?? '').trim()
    if (!name) throw new EabError(EC.VALIDATION, '供应商名称不能为空')
    const baseUrl = String(req.body?.baseUrl ?? '').trim()
    if (baseUrl && !/^https?:\/\//.test(baseUrl)) {
      throw new EabError(EC.VALIDATION, 'baseUrl 必须是 http(s) 地址')
    }
    let apiKeyEnv = String(req.body?.apiKeyEnv ?? '').trim()
    if (apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
      throw new EabError(EC.VALIDATION, 'apiKeyEnv 必须是环境变量名（字母/数字/下划线）')
    }

    const duplicate = deps.db
      .prepare('SELECT id FROM model_providers WHERE company_id = ? AND name = ? AND deleted_at IS NULL')
      .get(companyId, name)
    if (duplicate) throw new EabError(EC.VALIDATION, `同名供应商已存在：${name}`)

    const apiKey = String(req.body?.apiKey ?? '').trim()
    if (apiKey) {
      apiKeyEnv = storeSecret(deps.config.dbPath, apiKeyEnv, apiKey, `EAB_PROVIDER_${kind.toUpperCase()}`)
    }

    const id = `prov_${randomUUID()}`
    const now = Date.now()
    deps.db
      .prepare(
        `INSERT INTO model_providers (id, company_id, kind, name, base_url, api_key_env, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(id, companyId, kind, name, baseUrl || null, apiKeyEnv || null, now, now)

    const preset = PROVIDER_KINDS.find((item) => item.kind === kind)
    return ok({ provider: { id, kind, name, baseUrl: baseUrl || null, apiKeyEnv: apiKeyEnv || null, protocol: preset?.protocol ?? 'openai' } })
  })

  app.patch<{
    Params: { id: string }
    Body: { kind?: string; name?: string; baseUrl?: string; apiKeyEnv?: string; apiKey?: string; status?: string }
  }>('/api/console/providers/:id', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const id = String(req.params.id)
    const row = deps.db
      .prepare('SELECT id, kind, name, base_url, api_key_env, status FROM model_providers WHERE id = ? AND company_id = ? AND deleted_at IS NULL')
      .get(id, companyId) as
      | { id: string; kind: string; name: string; base_url: string | null; api_key_env: string | null; status: string }
      | undefined
    if (!row) throw new EabError(EC.NOT_FOUND, '供应商不存在')

    const kind = req.body?.kind === undefined ? row.kind : String(req.body.kind)
    if (!PROVIDER_KIND_SET.has(kind as ProviderKind)) {
      throw new EabError(EC.VALIDATION, `不支持的供应商类型：${kind}`)
    }
    const name = req.body?.name === undefined ? row.name : String(req.body.name).trim()
    if (!name) throw new EabError(EC.VALIDATION, '供应商名称不能为空')
    const baseUrl = req.body?.baseUrl === undefined ? row.base_url : String(req.body.baseUrl).trim()
    if (baseUrl && !/^https?:\/\//.test(baseUrl)) throw new EabError(EC.VALIDATION, 'baseUrl 必须是 http(s) 地址')
    let apiKeyEnv = req.body?.apiKeyEnv === undefined ? row.api_key_env : String(req.body.apiKeyEnv).trim()
    if (apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
      throw new EabError(EC.VALIDATION, 'apiKeyEnv 必须是环境变量名')
    }
    const apiKey = String(req.body?.apiKey ?? '').trim()
    if (apiKey) {
      apiKeyEnv = storeSecret(deps.config.dbPath, apiKeyEnv, apiKey, 'EAB_PROVIDER')
    }
    const status = req.body?.status === undefined ? row.status : String(req.body.status)
    if (status !== 'active' && status !== 'disabled') {
      throw new EabError(EC.VALIDATION, 'status 只能是 active / disabled')
    }

    deps.db
      .prepare('UPDATE model_providers SET kind = ?, name = ?, base_url = ?, api_key_env = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(kind, name, baseUrl || null, apiKeyEnv || null, status, Date.now(), id)
    return ok({ provider: { id, kind, name, baseUrl: baseUrl || null, apiKeyEnv: apiKeyEnv || null, status } })
  })

  app.delete<{ Params: { id: string } }>('/api/console/providers/:id', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const id = String(req.params.id)
    const models = deps.db
      .prepare('SELECT COUNT(*) AS n FROM models WHERE provider_id = ? AND deleted_at IS NULL')
      .get(id) as { n: number }
    if (Number(models.n) > 0) {
      throw new EabError(EC.VALIDATION, '这个供应商下还有模型，先删模型或换供应商再删它')
    }
    const row = deps.db
      .prepare('SELECT id FROM model_providers WHERE id = ? AND company_id = ? AND deleted_at IS NULL')
      .get(id, companyId)
    if (!row) throw new EabError(EC.NOT_FOUND, '供应商不存在')
    deps.db.prepare('UPDATE model_providers SET deleted_at = ?, updated_at = ? WHERE id = ?').run(Date.now(), Date.now(), id)
    return ok({ deleted: true })
  })

  app.post<{ Params: { id: string } }>('/api/console/providers/:id/test', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const row = deps.db
      .prepare(
        `SELECT id, kind, name, base_url, api_key_env FROM model_providers
          WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
      )
      .get(String(req.params.id), companyId) as
      | { id: string; kind: string; name: string; base_url: string | null; api_key_env: string | null }
      | undefined
    if (!row) throw new EabError(EC.NOT_FOUND, '供应商不存在')

    const preset = PROVIDER_KINDS.find((item) => item.kind === row.kind)
    const baseUrl = (row.base_url || (preset?.defaultBaseUrl ?? '')).replace(/\/$/, '')
    if (!baseUrl) return ok({ ok: false, tested: false, message: '还没填 Base URL' })
    if (preset?.protocol === 'demo') {
      return ok({ ok: true, tested: false, message: '演示供应商不需要联网探测，可直接建模型' })
    }

    const key = resolveSecret(deps.config.dbPath, row.api_key_env)
    if (row.api_key_env && !key) {
      return ok({ ok: false, tested: true, message: `密钥 ${row.api_key_env} 还没配置，请在编辑里填入 API Key` })
    }

    let url = `${baseUrl}/models`
    const headers: Record<string, string> = { accept: 'application/json' }
    if (preset?.protocol === 'anthropic') {
      url = `${baseUrl}/models`
      if (key) headers['x-api-key'] = key
      headers['anthropic-version'] = '2023-06-01'
    } else if (preset?.protocol === 'gemini') {
      url = `${baseUrl}/models${key ? `?key=${encodeURIComponent(key)}` : ''}`
    } else if (preset?.protocol === 'azure') {
      url = `${baseUrl}/openai/models?api-version=2024-02-01`
      if (key) headers['api-key'] = key
    } else if (key) {
      headers.authorization = `Bearer ${key}`
    }

    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 6000)
      const response = await fetch(url, { headers, signal: controller.signal })
      clearTimeout(timer)
      if (!response.ok) {
        return ok({ ok: false, tested: true, message: `端点返回 HTTP ${response.status}`, baseUrl })
      }
      const body = (await response.json()) as { data?: unknown[]; models?: unknown[] }
      const count = Array.isArray(body.data) ? body.data.length : Array.isArray(body.models) ? body.models.length : 0
      return ok({
        ok: true,
        tested: true,
        message: `连接成功，端点报告 ${count} 个模型`,
        baseUrl,
      })
    } catch (error) {
      return ok({
        ok: false,
        tested: true,
        message: `连不上：${error instanceof Error ? error.message : String(error)}`,
        baseUrl,
      })
    }
  })

  /* ---------------- 模型清单自动发现 ---------------- */

  interface ProviderDetailRow {
    id: string
    kind: string
    name: string
    base_url: string | null
    api_key_env: string | null
  }

  interface DiscoveredModel {
    id: string
    label: string
    suggested: ModelProfileSuggestion
  }

  function providerDetailOf(id: string, companyId: string): ProviderDetailRow {
    const row = deps.db
      .prepare(
        `SELECT id, kind, name, base_url, api_key_env FROM model_providers
          WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
      )
      .get(id, companyId) as ProviderDetailRow | undefined
    if (!row) throw new EabError(EC.NOT_FOUND, '供应商不存在')
    return row
  }

  async function discoverModelsOfProvider(row: ProviderDetailRow): Promise<{
    models: DiscoveredModel[]
    baseUrl: string
    message: string
    promotedFromDemo: boolean
  }> {
    const preset = PROVIDER_KINDS.find((item) => item.kind === row.kind)
    let protocol = preset?.protocol ?? 'openai'
    let promotedFromDemo = false
    const baseUrl = (row.base_url || (preset?.defaultBaseUrl ?? '')).replace(/\/+$/, '')
    if (!baseUrl) throw new EabError(EC.VALIDATION, '还没填 Base URL，无法读取模型清单')
    if (protocol === 'demo') {
      if (row.base_url) {
        // 演示类型却填了真实地址：按 OpenAI 兼容端点探测，导入成功后自动切换类型
        protocol = 'openai'
        promotedFromDemo = true
      } else {
        return {
          models: [],
          baseUrl,
          message: '演示供应商没有远端模型清单，填入真实 Base URL 后会自动探测',
          promotedFromDemo: false,
        }
      }
    }
    if (protocol === 'azure') {
      throw new EabError(EC.VALIDATION, 'Azure OpenAI 不提供模型清单接口，请手动填写部署名（deployment）')
    }

    const key = resolveSecret(deps.config.dbPath, row.api_key_env)
    if (row.api_key_env && !key) {
      throw new EabError(EC.VALIDATION, `密钥 ${row.api_key_env} 还没配置`)
    }

    let url = `${baseUrl}/models`
    const headers: Record<string, string> = { accept: 'application/json' }
    if (protocol === 'anthropic') {
      if (key) headers['x-api-key'] = key
      headers['anthropic-version'] = '2023-06-01'
    } else if (protocol === 'gemini') {
      url = `${baseUrl}/models${key ? `?key=${encodeURIComponent(key)}` : ''}`
    } else if (key) {
      headers.authorization = `Bearer ${key}`
    }

    let response: Response
    try {
      response = await fetch(url, { headers, signal: AbortSignal.timeout(12_000) })
    } catch (error) {
      throw new EabError(
        EC.UPSTREAM,
        `连不上 ${baseUrl}：${error instanceof Error ? error.message : String(error)}`,
        { hint: '确认地址是 OpenAI 兼容的 /v1 根路径，服务器能访问该地址' },
      )
    }
    if (!response.ok) {
      throw new EabError(EC.UPSTREAM, `模型清单返回 HTTP ${response.status}：${await readProviderError(response)}`, {
        hint: '检查 Base URL 是否为 /v1 根路径、API Key 是否正确、账号是否有模型列表权限',
      })
    }

    let payload: { data?: unknown; models?: unknown }
    try {
      payload = (await response.json()) as { data?: unknown; models?: unknown }
    } catch {
      throw new EabError(EC.UPSTREAM, '模型清单返回的不是 JSON')
    }
    const rawList = Array.isArray(payload.data)
      ? payload.data
      : Array.isArray(payload.models)
        ? payload.models
        : []
    const seen = new Set<string>()
    const models: DiscoveredModel[] = []
    for (const raw of rawList.slice(0, 300)) {
      let id = ''
      let label = ''
      if (typeof raw === 'string') {
        id = raw
      } else if (raw && typeof raw === 'object') {
        const item = raw as Record<string, unknown>
        const candidate = item.id ?? item.model ?? item.name
        if (typeof candidate === 'string') id = candidate
        const nameCandidate = item.display_name ?? item.displayName ?? item.name
        if (typeof nameCandidate === 'string') label = nameCandidate
      }
      id = id.trim().replace(/^models\//, '')
      if (!id || seen.has(id)) continue
      seen.add(id)
      label = (label.trim().replace(/^models\//, '') || id).trim()
      models.push({ id, label: label === id ? '' : label, suggested: inferModelProfile(id) })
    }

    return {
      models,
      baseUrl,
      message: models.length
        ? `从 ${baseUrl}/models 读到 ${models.length} 个模型${
            promotedFromDemo ? '（该供应商原为演示类型，导入后会自动切换为 OpenAI 兼容）' : ''
          }`
        : `${baseUrl}/models 没有返回可用模型`,
      promotedFromDemo,
    }
  }

  async function readProviderError(response: Response): Promise<string> {
    const text = await response.text()
    try {
      const json = JSON.parse(text) as Record<string, unknown>
      const error = json.error as Record<string, unknown> | string | undefined
      if (typeof error === 'string') return error
      if (error && typeof error.message === 'string') return error.message
      if (typeof json.message === 'string') return json.message
    } catch {
      // 非 JSON 截断原文
    }
    return text.slice(0, 240)
  }

  app.get<{ Params: { id: string } }>('/api/console/providers/:id/models', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const row = providerDetailOf(String(req.params.id), companyId)
    const result = await discoverModelsOfProvider(row)
    return ok({
      providerId: row.id,
      providerName: row.name,
      protocol: PROVIDER_KINDS.find((item) => item.kind === row.kind)?.protocol ?? 'openai',
      models: result.models,
      count: result.models.length,
      baseUrl: result.baseUrl,
      promotedFromDemo: result.promotedFromDemo,
      message: result.message,
    })
  })

  app.post<{
    Params: { id: string }
    Body: {
      models?: Array<
        | string
        | {
            modelKey?: string
            id?: string
            name?: string
            capabilities?: string[]
            endpointKind?: string
            tags?: string[]
            maxContext?: number | null
            embeddingDim?: number | null
          }
      >
      roles?: string[]
      tags?: string[]
      enabled?: boolean
    }
  }>('/api/console/providers/:id/models/import', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const row = providerDetailOf(String(req.params.id), companyId)
    const requested = Array.isArray(req.body?.models) ? req.body.models : []
    if (requested.length === 0) throw new EabError(EC.VALIDATION, 'models 不能为空')
    const defaultTags = req.body?.tags === undefined ? null : req.body.tags
    if (defaultTags !== null && !Array.isArray(defaultTags)) throw new EabError(EC.VALIDATION, 'tags 必须是数组')

    const knownRoleCodes = (
      deps.db
        .prepare('SELECT code FROM roles WHERE company_id = ? AND deleted_at IS NULL ORDER BY code')
        .all(companyId) as unknown as Array<{ code: string }>
    ).map((item) => item.code)
    let roles = req.body?.roles === undefined ? knownRoleCodes : req.body.roles
    if (!Array.isArray(roles)) throw new EabError(EC.VALIDATION, 'roles 必须是数组')
    roles = [...new Set(roles.map((code) => String(code).trim()).filter(Boolean))]
    if (roles.length > 0) {
      const unknown = roles.filter((code) => !knownRoleCodes.includes(code))
      if (unknown.length > 0) throw new EabError(EC.VALIDATION, `未知角色：${unknown.join('、')}`)
    }

    const existing = deps.db
      .prepare(
        `SELECT id, name, model_key FROM models
          WHERE company_id = ? AND provider_id = ? AND deleted_at IS NULL`,
      )
      .all(companyId, row.id) as unknown as Array<{ id: string; name: string; model_key: string }>
    const existingIds = existing.map((item) => item.id)
    const existingKeys = new Set(existing.map((item) => item.model_key))
    const companyNames = new Set(
      (
        deps.db.prepare('SELECT name FROM models WHERE company_id = ? AND deleted_at IS NULL').all(companyId) as unknown as Array<{
          name: string
        }>
      ).map((item) => item.name),
    )

    const added: Array<{ id: string; name: string; modelKey: string; endpointKind: string }> = []
    const skipped: Array<{ modelKey: string; reason: string }> = []
    const insert = deps.db.prepare(
      `INSERT INTO models
         (id, company_id, provider_id, name, model_key, tags, capabilities, endpoint_kind,
          roles, priority, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const raw of requested.slice(0, 300)) {
      const item = typeof raw === 'string' ? { modelKey: raw } : raw && typeof raw === 'object' ? raw : null
      const modelKey = String(item?.modelKey ?? item?.id ?? '').trim()
      if (!modelKey) continue
      if (existingKeys.has(modelKey)) {
        skipped.push({ modelKey, reason: '已存在' })
        continue
      }

      const inferred = inferModelProfile(modelKey)
      const declaredCaps = validateCapabilityList(item?.capabilities)
      const declaredTags = stringArrayField(item?.tags, 'tags')
      const capabilities = [
        ...new Set(
          declaredCaps ??
            declaredTags?.map((tag) => normalizeCapability(tag)) ??
            (defaultTags ? defaultTags.map((tag) => normalizeCapability(tag)) : inferred.capabilities),
        ),
      ]
      const unknown = capabilities.filter((item) => !(MODEL_CAPABILITIES as readonly string[]).includes(item))
      if (unknown.length > 0) throw new EabError(EC.VALIDATION, `未知能力：${unknown.join('、')}`)
      const tags = [...new Set(declaredTags ?? capabilities)]
      const endpointKind =
        validateEndpointKind(item?.endpointKind) ??
        (capabilities.includes('rerank')
          ? 'rerank'
          : capabilities.includes('embedding')
            ? 'embeddings'
            : capabilities.includes('video')
              ? 'video'
              : capabilities.includes('audio')
                ? (inferred.endpointKind === 'tts' ? 'tts' : 'asr')
                : 'chat')
      let name = modelKey
      if (companyNames.has(name)) name = `${modelKey} · ${row.name}`
      if (companyNames.has(name)) name = `${modelKey} · ${row.name} #2`
      let index = 3
      while (companyNames.has(name)) name = `${modelKey} · ${row.name} #${index++}`
      const id = `model_${randomUUID()}`
      const now = Date.now()
      insert.run(
        id,
        companyId,
        row.id,
        name,
        modelKey,
        JSON.stringify(tags),
        JSON.stringify(capabilities),
        endpointKind,
        JSON.stringify(roles),
        Math.max(1, 100 - added.length),
        req.body?.enabled === false ? 0 : 1,
        now,
        now,
      )
      existingKeys.add(modelKey)
      companyNames.add(name)
      added.push({ id, name, modelKey, endpointKind })
    }

    let promotedFromDemo = false
    if (row.kind === 'demo' && row.base_url && added.length > 0) {
      // 演示供应商填了真实地址：导入真实模型后切换成 OpenAI 兼容，并停用原演示模型
      deps.db
        .prepare("UPDATE model_providers SET kind = 'openai_compatible', updated_at = ? WHERE id = ?")
        .run(Date.now(), row.id)
      for (const oldId of existingIds) {
        deps.db.prepare('UPDATE models SET enabled = 0, updated_at = ? WHERE id = ?').run(Date.now(), oldId)
      }
      promotedFromDemo = true
    }

    appendAudit(deps.db, {
      companyId,
      actorUserId: 'console-operator',
      action: 'model.discover.import',
      resourceType: 'provider',
      resourceId: row.id,
      result: 'success',
      detail: {
        provider: row.name,
        added: added.length,
        skipped: skipped.length,
        modelKeys: added.map((item) => item.modelKey),
        promotedFromDemo,
      },
      ip: req.ip ?? null,
      channel: 'console',
    })

    return ok({
      providerId: row.id,
      added,
      skipped,
      promotedFromDemo,
      message: `已加入 ${added.length} 个模型${skipped.length ? `，跳过 ${skipped.length} 个已存在的` : ''}${
        promotedFromDemo ? '；供应商已从演示回声切换为 OpenAI 兼容' : ''
      }`,
    })
  })

  app.get('/api/console/models', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const rows = deps.db
      .prepare(
        `SELECT m.id, m.provider_id, m.name, m.model_key, m.tags, m.roles, m.priority, m.enabled,
                m.capabilities, m.endpoint_kind, m.input_modalities, m.output_modalities,
                m.max_context, m.max_output_tokens, m.context_compression,
                m.embedding_dim, m.config_json,
                p.kind AS provider_kind, p.name AS provider_name, p.status AS provider_status
           FROM models m
           JOIN model_providers p ON p.id = m.provider_id
          WHERE m.company_id = ? AND m.deleted_at IS NULL AND p.deleted_at IS NULL
          ORDER BY m.priority DESC, m.name ASC`,
      )
      .all(companyId) as unknown as ModelRow[]

    const roles = deps.db
      .prepare('SELECT code, name FROM roles WHERE company_id = ? AND deleted_at IS NULL ORDER BY code')
      .all(companyId) as unknown as Array<{ code: string; name: string }>

    const pluginChannels = listPluginChannels(companyId)
    const channels = new Map(pluginChannels.map((channel) => [channel.id, channel]))
    const channelPluginIds = new Set(pluginChannels.map((channel) => channel.pluginId))
    const pluginRoleOverrides = loadPluginModelRoleMap(deps.db, companyId)
    const pluginModels = applyPluginModelRoles(
      filterHealthyModels(companyId, listPluginModels(companyId)),
      pluginRoleOverrides,
    ).map((model) => {
      const channel = channels.get(model.channelId)
      return {
        id: model.id,
        providerId: model.channelId,
        providerKind: 'plugin',
        providerName: channel?.name ?? model.providerName,
        providerStatus: 'active',
        name: model.name,
        modelKey: model.modelKey,
        tags: model.tags,
        capabilities: model.capabilities,
        endpointKind: model.endpointKind,
        inputModalities: model.inputModalities,
        outputModalities: model.outputModalities,
        maxContext: model.maxContext,
        maxOutputTokens: model.maxOutputTokens,
        contextCompression: model.contextCompression,
        embeddingDim: null,
        config: {},
        roles: model.roles,
        priority: model.priority,
        enabled: true,
        source: 'plugin' as const,
        readonly: true,
        pluginId: model.pluginId,
        channelId: model.channelId,
      }
    })

    // 插件来源状态：仍活跃的模型通道 + 已停用/清单不完整的 DSH 插件。
    // 停用后模型会被宿主清掉，但这里仍要把“插件已停用”告诉控制台，而不是让模型静默消失。
    const pluginStates = loadPlugins(deps.db, companyId)
      .filter((plugin) => plugin.format === 'dsh' && plugin.companyInstall && plugin.companyInstall.removedAt === null)
      .filter((plugin) => channelPluginIds.has(plugin.id) || !plugin.enabled || !plugin.valid)
      .map((plugin) => ({
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        enabled: plugin.enabled && plugin.valid,
        valid: plugin.valid,
        error: plugin.error,
        modelCount: pluginModels.filter((model) => model.pluginId === plugin.id).length,
        channelCount: pluginChannels.filter((channel) => channel.pluginId === plugin.id).length,
      }))

    return ok({
      companyId,
      roles,
      pluginStates,
      models: [
        ...rows.map((row) => ({
          id: row.id,
          providerId: row.provider_id,
          providerKind: row.provider_kind,
          providerName: row.provider_name,
          providerStatus: row.provider_status,
          name: row.name,
          modelKey: row.model_key,
          tags: parseList(row.tags),
          capabilities: capabilitiesOf(row.capabilities ?? null, row.tags),
          endpointKind: row.endpoint_kind ?? 'chat',
          inputModalities: parseList(row.input_modalities ?? null),
          outputModalities: parseList(row.output_modalities ?? null),
          maxContext: row.max_context ?? null,
          maxOutputTokens: row.max_output_tokens ?? null,
          contextCompression: row.context_compression === null || row.context_compression === undefined
            ? true
            : Number(row.context_compression) !== 0,
          embeddingDim: row.embedding_dim ?? null,
          config: parseObject(row.config_json),
          roles: parseList(row.roles),
          priority: Number(row.priority),
          enabled: row.enabled === 1,
          source: 'db' as const,
          readonly: false,
        })),
        ...pluginModels,
      ],
    })
  })

  app.post<{
    Body: {
      name?: string
      providerId?: string
      modelKey?: string
      tags?: string[]
      capabilities?: string[]
      endpointKind?: string
      inputModalities?: string[]
      outputModalities?: string[]
      maxContext?: number | null
      maxOutputTokens?: number | null
      contextCompression?: boolean
      embeddingDim?: number | null
      config?: Record<string, unknown>
      roles?: string[]
      priority?: number
      enabled?: boolean
    }
  }>('/api/console/models', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const providerId = String(req.body?.providerId ?? '')
    const provider = deps.db
      .prepare('SELECT id FROM model_providers WHERE id = ? AND company_id = ? AND deleted_at IS NULL')
      .get(providerId, companyId)
    if (!provider) throw new EabError(EC.VALIDATION, '供应商不存在或不属于当前公司')

    const name = String(req.body?.name ?? '').trim()
    const modelKey = String(req.body?.modelKey ?? '').trim()
    if (!name) throw new EabError(EC.VALIDATION, '模型显示名不能为空')
    if (!modelKey) throw new EabError(EC.VALIDATION, '模型标识（vendor model id）不能为空')

    const dup = deps.db
      .prepare('SELECT id FROM models WHERE company_id = ? AND name = ? AND deleted_at IS NULL')
      .get(companyId, name)
    if (dup) throw new EabError(EC.VALIDATION, `同名模型已存在：${name}`)

    const roles = req.body?.roles === undefined ? [] : req.body.roles
    if (!Array.isArray(roles)) throw new EabError(EC.VALIDATION, 'roles 必须是数组')
    const known = deps.db
      .prepare('SELECT code FROM roles WHERE company_id = ? AND deleted_at IS NULL')
      .all(companyId) as unknown as Array<{ code: string }>
    const unknown = roles.map(String).filter((code) => !known.some((row) => row.code === code))
    if (unknown.length > 0) throw new EabError(EC.VALIDATION, `未知角色：${unknown.join('、')}`)

    const tags = req.body?.tags === undefined ? [] : req.body.tags
    if (!Array.isArray(tags)) throw new EabError(EC.VALIDATION, 'tags 必须是数组')
    const capabilities = validateCapabilityList(req.body?.capabilities) ?? tags.map(String)
    const endpointKind = validateEndpointKind(req.body?.endpointKind) ??
      (capabilities.includes('embedding')
        ? 'embeddings'
        : capabilities.includes('rerank')
          ? 'rerank'
          : capabilities.includes('video')
            ? 'video'
            : capabilities.includes('audio')
              ? 'asr'
              : 'chat')
    const inputModalities =
      stringArrayField(req.body?.inputModalities, 'inputModalities') ??
      (capabilities.some((item) => item === 'vision' || item === 'multimodal')
        ? ['text', 'image']
        : capabilities.includes('audio')
          ? ['audio']
          : capabilities.includes('video')
            ? ['text', 'video']
            : ['text'])
    const outputModalities = stringArrayField(req.body?.outputModalities, 'outputModalities') ?? ['text']
    const maxContext = optionalIntField(req.body?.maxContext, 'maxContext') ?? null
    const maxOutputTokens = optionalIntField(req.body?.maxOutputTokens, 'maxOutputTokens') ?? null
    if (maxContext !== null && maxOutputTokens !== null && maxOutputTokens >= maxContext) {
      throw new EabError(EC.VALIDATION, '输出上限必须小于上下文上限', {
        hint: '上下文上限包含输入与输出；输出留 1/4 左右给回答更安全。',
      })
    }
    const contextCompression = req.body?.contextCompression === false ? 0 : 1
    const embeddingDim = optionalIntField(req.body?.embeddingDim, 'embeddingDim') ?? null
    const config = req.body?.config && typeof req.body.config === 'object' ? req.body.config : {}
    const priority = Number(req.body?.priority ?? 10)
    if (!Number.isFinite(priority)) throw new EabError(EC.VALIDATION, 'priority 必须是数字')

    const id = `model_${randomUUID()}`
    const now = Date.now()
    deps.db
      .prepare(
        `INSERT INTO models
           (id, company_id, provider_id, name, model_key, tags, capabilities, endpoint_kind,
            input_modalities, output_modalities, max_context, max_output_tokens, context_compression,
            embedding_dim, config_json, roles, priority, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        companyId,
        providerId,
        name,
        modelKey,
        JSON.stringify(tags.map(String)),
        JSON.stringify(capabilities.map(String)),
        endpointKind,
        JSON.stringify(inputModalities),
        JSON.stringify(outputModalities),
        maxContext,
        maxOutputTokens,
        contextCompression,
        embeddingDim,
        JSON.stringify(config),
        JSON.stringify(roles.map(String)),
        Math.trunc(priority),
        req.body?.enabled === false ? 0 : 1,
        now,
        now,
      )
    return ok({
      model: {
        id,
        name,
        modelKey,
        providerId,
        roles,
        tags,
        capabilities,
        endpointKind,
        inputModalities,
        outputModalities,
        maxContext,
        maxOutputTokens,
        contextCompression: contextCompression !== 0,
        embeddingDim,
        config,
        priority: Math.trunc(priority),
      },
    })
  })

  app.patch<{
    Params: { id: string }
    Body: {
      name?: string
      modelKey?: string
      tags?: string[]
      capabilities?: string[]
      endpointKind?: string
      inputModalities?: string[]
      outputModalities?: string[]
      maxContext?: number | null
      maxOutputTokens?: number | null
      contextCompression?: boolean
      embeddingDim?: number | null
      config?: Record<string, unknown>
      roles?: string[]
      priority?: number
      enabled?: boolean
      providerId?: string
    }
  }>('/api/console/models/:id', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const id = String(req.params.id)
    const row = deps.db
      .prepare(
        `SELECT id, provider_id, name, model_key, tags, capabilities, endpoint_kind,
                input_modalities, output_modalities, max_context, max_output_tokens,
                context_compression, embedding_dim, config_json,
                roles, priority, enabled
           FROM models WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
      )
      .get(id, companyId) as
      | {
          id: string
          provider_id: string
          name: string
          model_key: string
          tags: string | null
          capabilities: string | null
          endpoint_kind: string | null
          input_modalities: string | null
          output_modalities: string | null
          max_context: number | null
          max_output_tokens: number | null
          context_compression: number | null
          embedding_dim: number | null
          config_json: string | null
          roles: string | null
          priority: number
          enabled: number
        }
      | undefined
    if (!row) throw new EabError(EC.NOT_FOUND, '模型不存在')

    const name = req.body?.name === undefined ? row.name : String(req.body.name).trim()
    const modelKey = req.body?.modelKey === undefined ? row.model_key : String(req.body.modelKey).trim()
    if (!name || !modelKey) throw new EabError(EC.VALIDATION, '模型显示名与模型标识都不能为空')
    const providerId = req.body?.providerId === undefined ? row.provider_id : String(req.body.providerId)
    const provider = deps.db
      .prepare('SELECT id FROM model_providers WHERE id = ? AND company_id = ? AND deleted_at IS NULL')
      .get(providerId, companyId)
    if (!provider) throw new EabError(EC.VALIDATION, '供应商不存在或不属于当前公司')

    let roles = parseList(row.roles)
    if (req.body?.roles !== undefined) {
      if (!Array.isArray(req.body.roles)) throw new EabError(EC.VALIDATION, 'roles 必须是数组')
      roles = req.body.roles.map(String)
      const known = deps.db
        .prepare('SELECT code FROM roles WHERE company_id = ? AND deleted_at IS NULL')
        .all(companyId) as unknown as Array<{ code: string }>
      const unknown = roles.filter((code) => !known.some((item) => item.code === code))
      if (unknown.length > 0) throw new EabError(EC.VALIDATION, `未知角色：${unknown.join('、')}`)
    }
    let tags = parseList(row.tags)
    if (req.body?.tags !== undefined) {
      if (!Array.isArray(req.body.tags)) throw new EabError(EC.VALIDATION, 'tags 必须是数组')
      tags = req.body.tags.map(String)
    }
    const capabilities =
      validateCapabilityList(req.body?.capabilities) ??
      (row.capabilities ? parseList(row.capabilities) : tags)
    const endpointKind =
      validateEndpointKind(req.body?.endpointKind) ??
      row.endpoint_kind ??
      (capabilities.includes('embedding')
        ? 'embeddings'
        : capabilities.includes('rerank')
          ? 'rerank'
          : capabilities.includes('video')
            ? 'video'
            : capabilities.includes('audio')
              ? 'asr'
              : 'chat')
    const inputModalities =
      stringArrayField(req.body?.inputModalities, 'inputModalities') ??
      parseList(row.input_modalities)
    const outputModalities =
      stringArrayField(req.body?.outputModalities, 'outputModalities') ??
      parseList(row.output_modalities)
    const maxContext =
      req.body?.maxContext === undefined
        ? row.max_context ?? null
        : optionalIntField(req.body.maxContext, 'maxContext') ?? null
    const maxOutputTokens =
      req.body?.maxOutputTokens === undefined
        ? row.max_output_tokens ?? null
        : optionalIntField(req.body.maxOutputTokens, 'maxOutputTokens') ?? null
    if (maxContext !== null && maxOutputTokens !== null && maxOutputTokens >= maxContext) {
      throw new EabError(EC.VALIDATION, '输出上限必须小于上下文上限', {
        hint: '上下文上限包含输入与输出；输出留 1/4 左右给回答更安全。',
      })
    }
    const contextCompression =
      req.body?.contextCompression === undefined
        ? row.context_compression === null || Number(row.context_compression) !== 0
        : req.body.contextCompression !== false
    const embeddingDim =
      req.body?.embeddingDim === undefined
        ? row.embedding_dim ?? null
        : optionalIntField(req.body.embeddingDim, 'embeddingDim') ?? null
    const config =
      req.body?.config && typeof req.body.config === 'object'
        ? req.body.config
        : parseObject(row.config_json)
    const priority = req.body?.priority === undefined ? Number(row.priority) : Number(req.body.priority)
    if (!Number.isFinite(priority)) throw new EabError(EC.VALIDATION, 'priority 必须是数字')
    const enabled = req.body?.enabled === undefined ? row.enabled === 1 : req.body.enabled

    deps.db
      .prepare(
        `UPDATE models
            SET provider_id = ?, name = ?, model_key = ?, tags = ?, capabilities = ?, endpoint_kind = ?,
                input_modalities = ?, output_modalities = ?, max_context = ?, max_output_tokens = ?,
                context_compression = ?, embedding_dim = ?,
                config_json = ?, roles = ?, priority = ?, enabled = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        providerId,
        name,
        modelKey,
        JSON.stringify(tags),
        JSON.stringify(capabilities),
        endpointKind,
        JSON.stringify(inputModalities),
        JSON.stringify(outputModalities),
        maxContext,
        maxOutputTokens,
        contextCompression ? 1 : 0,
        embeddingDim,
        JSON.stringify(config),
        JSON.stringify(roles),
        Math.trunc(priority),
        enabled ? 1 : 0,
        Date.now(),
        id,
      )
    return ok({
      model: {
        id,
        name,
        modelKey,
        providerId,
        roles,
        tags,
        capabilities,
        endpointKind,
        inputModalities,
        outputModalities,
        maxContext,
        maxOutputTokens,
        contextCompression,
        embeddingDim,
        config,
        priority: Math.trunc(priority),
        enabled,
      },
    })
  })

  app.put<{ Params: { id: string }; Body: { roles?: string[] } }>(
    '/api/console/models/:id/plugin-settings',
    async (req) => {
      requireConsole(req, deps)
      const companyId = companyOf(req, deps)
      const id = String(req.params.id)
      const model = listAllPluginModels(companyId).find((item) => item.id === id)
      if (!model) throw new EabError(EC.NOT_FOUND, '插件模型不存在、插件已停用或尚未完成注册')
      if (!Array.isArray(req.body?.roles)) throw new EabError(EC.VALIDATION, 'roles 必须是数组')
      const roles = [...new Set(req.body.roles.map(String).filter(Boolean))]
      if (roles.length > 0) {
        const known = deps.db
          .prepare('SELECT code FROM roles WHERE company_id = ? AND deleted_at IS NULL')
          .all(companyId) as unknown as Array<{ code: string }>
        const unknown = roles.filter((code) => !known.some((item) => item.code === code))
        if (unknown.length > 0) throw new EabError(EC.VALIDATION, `未知角色：${unknown.join('、')}`)
      }
      savePluginModelRoles(deps.db, companyId, id, roles)
      return ok({ model: { id, roles } })
    },
  )

  app.delete<{ Params: { id: string } }>('/api/console/models/:id', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const id = String(req.params.id)
    const row = deps.db
      .prepare('SELECT id FROM models WHERE id = ? AND company_id = ? AND deleted_at IS NULL')
      .get(id, companyId)
    if (!row) throw new EabError(EC.NOT_FOUND, '模型不存在')
    deps.db.prepare('UPDATE models SET deleted_at = ?, updated_at = ? WHERE id = ?').run(Date.now(), Date.now(), id)
    return ok({ deleted: true })
  })

  app.post<{
    Params: { id: string }
    Body: { concurrency?: number; requests?: number; prompt?: string; maxTokens?: number }
  }>('/api/console/models/:id/stress-test', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const modelId = String(req.params.id)
    const model = deps.db
      .prepare(
        `SELECT m.id, m.name, m.model_key, m.endpoint_kind, m.enabled,
                p.kind AS provider_kind, p.name AS provider_name, p.status AS provider_status
           FROM models m
           JOIN model_providers p ON p.id = m.provider_id
          WHERE m.id = ? AND m.company_id = ? AND m.deleted_at IS NULL AND p.deleted_at IS NULL`,
      )
      .get(modelId, companyId) as
      | {
          id: string
          name: string
          model_key: string
          endpoint_kind: string | null
          enabled: number
          provider_kind: string
          provider_name: string
          provider_status: string
        }
      | undefined
    if (!model) throw new EabError(EC.NOT_FOUND, '模型不存在')
    if (model.enabled !== 1) throw new EabError(EC.VALIDATION, '这个模型已停用，先启用再做压测')
    if (model.provider_status !== 'active') throw new EabError(EC.VALIDATION, '供应商已停用，先启用再做压测')
    if ((model.endpoint_kind ?? 'chat') !== 'chat') {
      throw new EabError(EC.VALIDATION, '压测目前只支持对话模型；向量、重排、语音和视频模型不适用')
    }
    if (model.provider_kind === 'demo') {
      throw new EabError(EC.VALIDATION, '演示回声模型没有真实上游，不能做压力测试')
    }

    const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
      const number = Number(value)
      if (!Number.isFinite(number)) return fallback
      return Math.min(max, Math.max(min, Math.trunc(number)))
    }
    const total = clampInt(req.body?.requests, 1, 100, 10)
    const concurrency = Math.min(total, clampInt(req.body?.concurrency, 1, 20, 3))
    const prompt = String(req.body?.prompt ?? '').trim() || '请只回复 OK。'
    if (prompt.length > 2000) throw new EabError(EC.VALIDATION, '测试提示词最多 2000 字')
    const maxTokens = clampInt(req.body?.maxTokens, 16, 512, 128)

    const jobId = `stress_${randomUUID()}`
    const state = createModelStressState(total, concurrency)
    stressJobs.set(jobId, { companyId, modelId, modelName: model.name, state })
    for (const [key, job] of stressJobs) {
      if (stressJobs.size <= 32) break
      if (!job.state.running && job.companyId === companyId) stressJobs.delete(key)
    }

    void runModelStress(state, async () => {
      const result = await callModel(deps.db, deps.config.dbPath, companyId, modelId, [
        { role: 'user' as const, content: prompt },
      ], maxTokens)
      if (!result) throw new EabError(EC.UPSTREAM, '模型没有返回真实结果')
      if (!result.text.trim()) throw new EabError(EC.UPSTREAM, '模型返回了空正文')
      return result
    }).catch((error) => {
      state.running = false
      state.finishedAt = Date.now()
      state.errors.push({
        index: state.completed,
        code: error instanceof EabError ? error.code : 'EAB_STRESS_FAILED',
        message: error instanceof Error ? error.message : String(error),
        durationMs: 0,
      })
    })

    return ok({
      jobId,
      status: 'running',
      model: {
        id: model.id,
        name: model.name,
        modelKey: model.model_key,
        providerName: model.provider_name,
        providerKind: model.provider_kind,
      },
      total,
      concurrency,
      prompt,
      maxTokens,
      startedAt: state.startedAt,
    })
  })

  app.get<{ Params: { jobId: string } }>('/api/console/model-stress-tests/:jobId', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const job = stressJobs.get(String(req.params.jobId))
    if (!job || job.companyId !== companyId) throw new EabError(EC.NOT_FOUND, '压测任务不存在或已过期')
    return ok({
      jobId: req.params.jobId,
      modelId: job.modelId,
      modelName: job.modelName,
      ...modelStressSnapshot(job.state),
    })
  })

  /* ---------------- 模型用途路由：把"要干什么"绑定到"哪个模型" ---------------- */

  app.get('/api/console/model-routes', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const rows = deps.db
      .prepare(
        `SELECT r.id, r.purpose, r.model_id, r.priority, r.enabled,
                m.name AS model_name, m.model_key, m.endpoint_kind
           FROM model_routes r
           JOIN models m ON m.id = r.model_id
          WHERE r.company_id = ? AND r.deleted_at IS NULL AND m.deleted_at IS NULL
          ORDER BY r.purpose, r.priority DESC`,
      )
      .all(companyId) as unknown as Array<{
      id: string
      purpose: string
      model_id: string
      priority: number
      enabled: number
      model_name: string
      model_key: string
      endpoint_kind: string | null
    }>
    const bound = new Map(rows.filter((row) => row.enabled === 1).map((row) => [row.purpose, row]))
    return ok({
      companyId,
      purposes: MODEL_ROUTE_PURPOSES,
      capabilities: MODEL_CAPABILITIES,
      endpointKinds: MODEL_ENDPOINT_KINDS,
      routes: MODEL_ROUTE_PURPOSES.map((item) => {
        const explicit = bound.get(item.purpose)
        const effective = explainModelRoute(deps.db, companyId, item.purpose)
        return {
          ...item,
          boundModelId: explicit?.model_id ?? null,
          boundModelName: explicit?.model_name ?? null,
          boundModelKey: explicit?.model_key ?? null,
          effectiveModelId: effective.model?.id ?? null,
          effectiveModelName: effective.model?.name ?? null,
          effectiveModelKey: effective.model?.modelKey ?? null,
          effectiveEndpointKind: effective.model?.endpointKind ?? null,
          source: effective.source,
        }
      }),
    })
  })

  app.put<{
    Params: { purpose: string }
    Body: { modelId?: string | null }
  }>('/api/console/model-routes/:purpose', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const purpose = String(req.params.purpose)
    if (!MODEL_ROUTE_PURPOSES.some((item) => item.purpose === purpose)) {
      throw new EabError(EC.VALIDATION, `未知用途：${purpose}`)
    }

    const modelId = req.body?.modelId === undefined || req.body.modelId === null || req.body.modelId === ''
      ? null
      : String(req.body.modelId)
    const now = Date.now()

    if (modelId) {
      const model = findModelById(deps.db, companyId, modelId)
      if (!model) throw new EabError(EC.NOT_FOUND, '模型不存在、已停用或所属供应商已停用')
      if (!modelSupportsPurpose(model, purpose)) {
        throw new EabError(EC.VALIDATION, `模型「${model.name}」不支持用途「${purpose}」`, {
          hint: '请检查模型的能力标签与 endpointKind：向量用途要选 embedding 模型，语音转写要选 endpointKind=asr 的模型。',
        })
      }
    }

    // 只有校验通过才动旧绑定：避免"改错一次把原来好用的路由也清掉"。
    deps.db
      .prepare('UPDATE model_routes SET deleted_at = ?, updated_at = ? WHERE company_id = ? AND purpose = ? AND deleted_at IS NULL')
      .run(now, now, companyId, purpose)

    if (modelId) {
      deps.db
        .prepare(
          `INSERT INTO model_routes
             (id, company_id, purpose, model_id, priority, enabled, config_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, 10, 1, '{}', ?, ?)`,
        )
        .run(`route_${randomUUID()}`, companyId, purpose, modelId, now, now)
    }

    const effective = explainModelRoute(deps.db, companyId, purpose)
    return ok({
      purpose,
      boundModelId: modelId,
      effectiveModelId: effective.model?.id ?? null,
      effectiveModelName: effective.model?.name ?? null,
      source: effective.source,
    })
  })

  /* ---------------- 渠道接入配置（飞书 / 钉钉 / 企业微信） ---------------- */

  const CHANNEL_PROVIDERS = new Set(['feishu', 'dingtalk', 'wecom'])
  const CHANNEL_LABEL: Record<string, string> = { feishu: '飞书', dingtalk: '钉钉', wecom: '企业微信' }

  function signWebhook(provider: string, secret: string): Record<string, string> {
    if (!secret) return {}
    const timestamp = String(Date.now())
    if (provider === 'dingtalk') {
      const sign = encodeURIComponent(
        createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64'),
      )
      return { timestamp, sign }
    }
    if (provider === 'feishu') {
      const sign = createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64')
      return { timestamp, sign }
    }
    return {}
  }

  async function sendWebhook(
    provider: string,
    url: string,
    secret: string,
    text: string,
  ): Promise<{ ok: boolean; status: number; message: string }> {
    const sign = signWebhook(provider, secret)
    let target = url
    let body: Record<string, unknown>
    if (provider === 'dingtalk') {
      const query = new URLSearchParams(sign).toString()
      target = `${url}${url.includes('?') ? '&' : '?'}${query}`
      body = { msgtype: 'text', text: { content: text } }
    } else if (provider === 'feishu') {
      body = { msg_type: 'text', content: { text }, ...sign }
    } else {
      body = { msgtype: 'text', text: { content: text } }
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    try {
      const response = await fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      clearTimeout(timer)
      const raw = await response.text()
      return {
        ok: response.ok,
        status: response.status,
        message: raw.slice(0, 240) || `HTTP ${response.status}`,
      }
    } catch (error) {
      clearTimeout(timer)
      return { ok: false, status: 0, message: `连不上：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  app.get('/api/console/channels', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    // 回调令牌：渠道配置还没保存过也要有，否则企业后台没法配回调地址
    const insertChannel = deps.db.prepare(
      `INSERT OR IGNORE INTO channel_configs (id, company_id, provider, enabled, status, sync_mode, created_at, updated_at)
       VALUES (?, ?, ?, 0, 'unconfigured', 'off', ?, ?)`,
    )
    const ensureToken = deps.db.prepare(
      `UPDATE channel_configs SET callback_token = ?
        WHERE company_id = ? AND provider = ? AND (callback_token IS NULL OR callback_token = '')`,
    )
    const now = Date.now()
    for (const provider of ['feishu', 'dingtalk', 'wecom']) {
      insertChannel.run(`ch_${randomUUID()}`, companyId, provider, now, now)
      ensureToken.run(randomUUID().replace(/-/g, ''), companyId, provider)
    }
    const rows = deps.db
      .prepare(
        `SELECT provider, enabled, status, app_id, agent_id, corp_id, secret_ref,
                webhook_url, webhook_secret_ref, callback_token, tenant_id, tenant_name, bound_at
           FROM channel_configs WHERE company_id = ?`,
      )
      .all(companyId) as unknown as Array<{
      provider: string
      enabled: number
      status: string
      app_id: string | null
      agent_id: string | null
      corp_id: string | null
      secret_ref: string | null
      webhook_url: string | null
      webhook_secret_ref: string | null
      callback_token: string | null
      tenant_id: string | null
      tenant_name: string | null
      bound_at: number | null
    }>
    const byProvider = new Map(rows.map((row) => [row.provider, row]))
    const org = deps.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM departments d
             WHERE d.company_id = ? AND d.deleted_at IS NULL) AS departments,
           (SELECT COUNT(*) FROM departments d
             WHERE d.company_id = ? AND d.deleted_at IS NULL AND d.channel_dept_id IS NOT NULL) AS channel_departments,
           (SELECT COUNT(*) FROM departments d
             WHERE d.company_id = ? AND d.deleted_at IS NULL AND d.id LIKE 'd_dingtalk_%') AS dingtalk_departments,
           (SELECT COUNT(*) FROM users u
             WHERE u.company_id = ? AND u.deleted_at IS NULL) AS members,
           (SELECT COUNT(*) FROM users u
             WHERE u.company_id = ? AND u.deleted_at IS NULL AND u.id LIKE 'u_dingtalk_%') AS dingtalk_members`,
      )
      .get(companyId, companyId, companyId, companyId, companyId) as {
      departments: number
      channel_departments: number
      dingtalk_departments: number
      members: number
      dingtalk_members: number
    }
    const organization = {
      departments: Number(org.departments),
      channelDepartments: Number(org.channel_departments),
      dingtalkDepartments: Number(org.dingtalk_departments),
      dingtalkMembers: Number(org.dingtalk_members),
      members: Number(org.members),
      source:
        Number(org.dingtalk_departments) > 0
          ? 'dingtalk'
          : Number(org.channel_departments) > 0
            ? 'channel'
            : Number(org.departments) > 1 || Number(org.members) > 0
              ? 'local'
              : 'empty',
    }
    // 钉钉是主动连网关的长连接，“已绑定”不等于机器人能收消息；
    // 把 Stream 的 connected / registered / error 一并交给控制台，避免静默失联。
    const dingTalkStream = await import('../dingtalk-bot.js')
      .then((bot) => bot.dingTalkStreamStatus())
      .catch(() => null)
    return ok({
      organization,
      channels: ['feishu', 'dingtalk', 'wecom'].map((provider) => {
        const row = byProvider.get(provider)
        return {
          provider,
          label: CHANNEL_LABEL[provider],
          enabled: Boolean(row?.enabled),
          status: row?.status ?? 'unconfigured',
          appId: row?.app_id ?? '',
          agentId: row?.agent_id ?? '',
          corpId: row?.corp_id ?? '',
          appSecretConfigured: secretConfigured(deps.config.dbPath, row?.secret_ref),
          webhookUrl: row?.webhook_url ?? '',
          webhookSecretConfigured: secretConfigured(deps.config.dbPath, row?.webhook_secret_ref),
          tenantName: row?.tenant_name ?? '',
          tenantId: row?.tenant_id ?? '',
          bound: Boolean(row?.tenant_id),
          callbackPath: `/api/channel/webhooks/${provider}`,
          callbackToken: row?.callback_token ?? '',
          stream: provider === 'dingtalk' ? dingTalkStream : null,
        }
      }),
    })
  })

  app.post<{
    Params: { provider: string }
    Body: {
      appId?: string
      agentId?: string
      corpId?: string
      appSecret?: string
      webhookUrl?: string
      webhookSecret?: string
      enabled?: boolean
    }
  }>('/api/console/channels/:provider', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const provider = String(req.params.provider)
    if (!CHANNEL_PROVIDERS.has(provider)) throw new EabError(EC.VALIDATION, `不支持的渠道：${provider}`)

    const existing = deps.db
      .prepare(
        `SELECT id, secret_ref, webhook_secret_ref, callback_token, enabled
           FROM channel_configs WHERE company_id = ? AND provider = ?`,
      )
      .get(companyId, provider) as
      | { id: string; secret_ref: string | null; webhook_secret_ref: string | null; callback_token: string | null; enabled: number }
      | undefined

    const appId = String(req.body?.appId ?? '').trim().slice(0, 120)
    const agentId = String(req.body?.agentId ?? '').trim().slice(0, 120)
    const corpId = String(req.body?.corpId ?? '').trim().slice(0, 120)
    const webhookUrl = String(req.body?.webhookUrl ?? '').trim().slice(0, 500)
    if (webhookUrl && !/^https?:\/\//.test(webhookUrl)) {
      throw new EabError(EC.VALIDATION, 'Webhook 必须是 http(s) 地址')
    }

    let secretRef = existing?.secret_ref ?? null
    const appSecret = String(req.body?.appSecret ?? '').trim()
    if (appSecret) {
      secretRef = storeSecret(deps.config.dbPath, secretRef, appSecret, `EAB_${provider.toUpperCase()}_APP_SECRET`)
    }
    let webhookSecretRef = existing?.webhook_secret_ref ?? null
    const webhookSecret = String(req.body?.webhookSecret ?? '').trim()
    if (webhookSecret) {
      webhookSecretRef = storeSecret(
        deps.config.dbPath,
        webhookSecretRef,
        webhookSecret,
        `EAB_${provider.toUpperCase()}_WEBHOOK_SECRET`,
      )
    }

    const callbackToken = existing?.callback_token ?? randomUUID().replace(/-/g, '')
    const enabled = req.body?.enabled === undefined ? Boolean(existing?.enabled) : req.body.enabled
    const configured = Boolean(appId || webhookUrl)
    const status = configured ? 'configured' : 'unconfigured'
    const now = Date.now()
    const id = existing?.id ?? `ch_${randomUUID()}`

    if (existing) {
      deps.db
        .prepare(
          `UPDATE channel_configs
              SET app_id = ?, agent_id = ?, corp_id = ?, secret_ref = ?, webhook_url = ?,
                  webhook_secret_ref = ?, callback_token = ?, enabled = ?, status = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          appId || null,
          agentId || null,
          corpId || null,
          secretRef,
          webhookUrl || null,
          webhookSecretRef,
          callbackToken,
          enabled ? 1 : 0,
          status,
          now,
          id,
        )
    } else {
      deps.db
        .prepare(
          `INSERT INTO channel_configs
             (id, company_id, provider, enabled, status, app_id, agent_id, corp_id, secret_ref,
              webhook_url, webhook_secret_ref, callback_token, sync_mode, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)`,
        )
        .run(
          id,
          companyId,
          provider,
          enabled ? 1 : 0,
          status,
          appId || null,
          agentId || null,
          corpId || null,
          secretRef,
          webhookUrl || null,
          webhookSecretRef,
          callbackToken,
          now,
          now,
        )
    }

    return ok({
      channel: {
        provider,
        label: CHANNEL_LABEL[provider],
        status,
        enabled,
        appSecretConfigured: secretConfigured(deps.config.dbPath, secretRef),
        webhookSecretConfigured: secretConfigured(deps.config.dbPath, webhookSecretRef),
        callbackPath: `/api/channel/webhooks/${provider}`,
        callbackToken,
      },
    })
  })

  async function testChannelCredentials(
    provider: string,
    appId: string | null,
    appSecret: string | null,
    corpId: string | null,
  ): Promise<{ tested: boolean; ok: boolean; message: string }> {
    if (provider === 'wecom') {
      if (!corpId || !appSecret) return { tested: false, ok: false, message: '未填写企业 ID 或应用密钥' }
      try {
        const url = new URL('https://qyapi.weixin.qq.com/cgi-bin/gettoken')
        url.searchParams.set('corpid', corpId)
        url.searchParams.set('corpsecret', appSecret)
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
        const data = (await res.json()) as { errcode?: number; errmsg?: string }
        if (data.errcode === 0) return { tested: true, ok: true, message: '企业微信应用凭证有效' }
        return {
          tested: true,
          ok: false,
          message: `企业微信返回错误 ${data.errcode ?? res.status}：${data.errmsg ?? '未知错误'}`,
        }
      } catch (err) {
        return { tested: true, ok: false, message: `请求企业微信失败：${(err as Error).message}` }
      }
    }
    if (!appId || !appSecret) return { tested: false, ok: false, message: '未填写应用凭证或密钥' }
    if (provider === 'feishu') {
      try {
        const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
          signal: AbortSignal.timeout(8000),
        })
        const data = (await res.json()) as { code?: number; msg?: string; tenant_access_token?: string }
        if (data.code === 0 && data.tenant_access_token) {
          return { tested: true, ok: true, message: '飞书应用凭证有效，可继续授权通讯录' }
        }
        return { tested: true, ok: false, message: `飞书返回错误 ${data.code ?? res.status}：${data.msg ?? '未知错误'}` }
      } catch (err) {
        return { tested: true, ok: false, message: `请求飞书失败：${(err as Error).message}` }
      }
    }
    if (provider === 'dingtalk') {
      try {
        const res = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ appKey: appId, appSecret }),
          signal: AbortSignal.timeout(8000),
        })
        const data = (await res.json()) as { accessToken?: string; message?: string }
        if (data.accessToken) return { tested: true, ok: true, message: '钉钉应用凭证有效' }
        return { tested: true, ok: false, message: `钉钉返回错误 ${res.status}：${data.message ?? '未知错误'}` }
      } catch (err) {
        return { tested: true, ok: false, message: `请求钉钉失败：${(err as Error).message}` }
      }
    }
    return { tested: false, ok: false, message: '该渠道暂不支持凭证测试' }
  }

  app.post<{ Params: { provider: string }; Body: { text?: string } }>(
    '/api/console/channels/:provider/test',
    async (req) => {
      requireConsole(req, deps)
      const companyId = companyOf(req, deps)
      const provider = String(req.params.provider)
      if (!CHANNEL_PROVIDERS.has(provider)) throw new EabError(EC.VALIDATION, `不支持的渠道：${provider}`)
      const row = deps.db
        .prepare(
          `SELECT app_id, corp_id, secret_ref, webhook_url, webhook_secret_ref, status
             FROM channel_configs WHERE company_id = ? AND provider = ?`,
        )
        .get(companyId, provider) as
        | {
            app_id: string | null
            corp_id: string | null
            secret_ref: string | null
            webhook_url: string | null
            webhook_secret_ref: string | null
            status: string
          }
        | undefined

      const appSecret = resolveSecret(deps.config.dbPath, row?.secret_ref)
      const credential = await testChannelCredentials(provider, row?.app_id ?? null, appSecret, row?.corp_id ?? null)
      const text = String(req.body?.text ?? '').trim() || `EAB 渠道连通性测试 · ${new Date().toLocaleString('zh-CN')}`

      if (row?.webhook_url) {
        const result = await sendWebhook(
          provider,
          row.webhook_url,
          resolveSecret(deps.config.dbPath, row.webhook_secret_ref),
          text,
        )
        const prefix = credential.tested ? `${credential.ok ? '✓' : '✗'} ${credential.message}；` : ''
        return ok({
          ok: result.ok,
          tested: true,
          status: result.status,
          message: `${prefix}群机器人${result.ok ? '已收到测试消息' : `发送失败：${result.message}`}`,
          response: result.message,
          credential,
        })
      }
      if (credential.tested) {
        return ok({
          ok: credential.ok,
          tested: true,
          status: null,
          message: credential.message,
          response: null,
          credential,
        })
      }
      return ok({
        ok: false,
        tested: false,
        message: `${credential.message}；也没有配置群机器人 Webhook`,
        credential,
      })
    },
  )

  app.post<{ Params: { provider: string } }>(
    '/api/console/channels/:provider/sync',
    async (req) => {
      requireConsole(req, deps)
      const companyId = companyOf(req, deps)
      const provider = String(req.params.provider)
      if (!CHANNEL_PROVIDERS.has(provider)) throw new EabError(EC.VALIDATION, `不支持的渠道：${provider}`)
      const row = deps.db
        .prepare(
          `SELECT app_id, corp_id, secret_ref, enabled FROM channel_configs
            WHERE company_id = ? AND provider = ?`,
        )
        .get(companyId, provider) as
        | { app_id: string | null; corp_id: string | null; secret_ref: string | null; enabled: number }
        | undefined
      const appSecret = resolveSecret(deps.config.dbPath, row?.secret_ref)
      if (!appSecret) {
        throw new EabError(EC.VALIDATION, '还没有保存应用密钥，无法拉取通讯录', {
          hint: '先在渠道接入里填 App ID / 企业 ID 与密钥，保存后再同步',
        })
      }
      const appId = row?.app_id ?? ''
      const corpId = row?.corp_id ?? ''
      if (provider === 'wecom' ? !corpId : !appId) {
        throw new EabError(EC.VALIDATION, `缺少 ${provider === 'wecom' ? '企业 ID' : 'App ID'}，无法拉取通讯录`)
      }

      let remote
      try {
        remote = await fetchChannelOrg(provider, {
          provider: provider as 'feishu' | 'dingtalk' | 'wecom',
          appId,
          corpId,
          appSecret,
        })
      } catch (err) {
        throw new EabError(EC.UPSTREAM, `拉取${CHANNEL_LABEL[provider]}通讯录失败：${(err as Error).message}`, {
          hint: '检查应用凭证、通讯录权限范围（部门/成员是否授权给该应用）以及服务器出网',
        })
      }

      const root = deps.db
        .prepare(
          `SELECT id, path, depth FROM departments
            WHERE company_id = ? AND parent_id IS NULL AND deleted_at IS NULL
            ORDER BY path LIMIT 1`,
        )
        .get(companyId) as { id: string; path: string; depth: number } | undefined
      if (!root) throw new EabError(EC.VALIDATION, '库里没有公司根部门，无法同步组织')

      const plan = mapRemoteOrg(remote, {
        companyId,
        provider: provider as 'feishu' | 'dingtalk' | 'wecom',
        root,
        rootChannelDeptIds: provider === 'feishu' ? ['0'] : ['1'],
      })
      const outcome = applyOrgSync(deps.db, { plan, now: Date.now(), recycleAfter: 2 })
      deps.db
        .prepare('UPDATE channel_configs SET last_synced_at = ?, last_sync_run_id = ?, updated_at = ? WHERE company_id = ? AND provider = ?')
        .run(Date.now(), outcome.runId, Date.now(), companyId, provider)

      return ok({
        runId: outcome.runId,
        provider,
        mode: 'full',
        departments: remote.depts.length,
        members: remote.users.length,
        mobileCount: plan.users.filter((user) => Boolean(user.mobile)).length,
        stats: outcome.stats,
        diffCount: outcome.diffs.length,
        diffs: outcome.diffs.slice(0, 60),
      })
    },
  )

  /**
   * 飞书 / 企业微信统一开通：
   * - 扫码：企业微信直接走官方扫码接口；飞书走 dsh-im 插件的 app registration 流程。
   * - 手工：填 App ID + App Secret（飞书）或 Bot ID + Secret（企业微信）。
   * - 组织通讯录：企业微信必须另填 CorpId + CorpSecret；飞书复用 App 凭据。
   */
  const onboardingProviders = new Set(['feishu', 'wecom'])
  const pluginIdForFeishu = 'xmanrui-dsh-im'

  const readOnboardingProvider = (raw: unknown): 'feishu' | 'wecom' => {
    const provider = String(raw ?? '')
    if (!onboardingProviders.has(provider)) {
      throw new EabError(EC.VALIDATION, `不支持的渠道：${provider}`, { hint: '本期只统一飞书与企业微信的开通入口' })
    }
    return provider as 'feishu' | 'wecom'
  }

  const writeChannelBinding = (input: {
    companyId: string
    provider: 'feishu' | 'wecom'
    tenantId: string
    tenantName: string
    bindMode: 'scan' | 'manual'
    userId: string
    appId?: string | null
    corpId?: string | null
    secretRef?: string | null
    botId?: string | null
    botSecretRef?: string | null
  }): void => {
    const now = Date.now()
    const existing = deps.db
      .prepare('SELECT id FROM channel_configs WHERE company_id = ? AND provider = ?')
      .get(input.companyId, input.provider) as { id?: string } | undefined
    if (existing?.id) {
      deps.db
        .prepare(
          `UPDATE channel_configs
              SET enabled = 1, status = 'bound', tenant_id = ?, tenant_name = ?, bind_mode = ?,
                  app_id = COALESCE(?, app_id), corp_id = COALESCE(?, corp_id),
                  secret_ref = COALESCE(?, secret_ref), bot_id = COALESCE(?, bot_id),
                  bot_secret_ref = COALESCE(?, bot_secret_ref),
                  bound_at = COALESCE(bound_at, ?), bot_bound_at = COALESCE(bot_bound_at, ?),
                  bot_bound_by_user_id = COALESCE(bot_bound_by_user_id, ?),
                  sync_mode = CASE WHEN sync_mode = 'off' THEN 'daily' ELSE sync_mode END,
                  updated_at = ?
            WHERE id = ?`,
        )
        .run(
          input.tenantId,
          input.tenantName,
          input.bindMode,
          input.appId ?? null,
          input.corpId ?? null,
          input.secretRef ?? null,
          input.botId ?? null,
          input.botSecretRef ?? null,
          now,
          now,
          input.userId,
          now,
          existing.id,
        )
      return
    }
    deps.db
      .prepare(
        `INSERT INTO channel_configs
           (id, company_id, provider, enabled, status, sync_mode, tenant_id, tenant_name,
            bound_at, bound_by_user_id, bind_mode, app_id, corp_id, secret_ref, bot_id,
            bot_secret_ref, bot_bound_at, bot_bound_by_user_id, created_at, updated_at)
         VALUES (?, ?, ?, 1, 'bound', 'daily', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `ch_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
        input.companyId,
        input.provider,
        input.tenantId,
        input.tenantName,
        now,
        input.userId,
        input.bindMode,
        input.appId ?? null,
        input.corpId ?? null,
        input.secretRef ?? null,
        input.botId ?? null,
        input.botSecretRef ?? null,
        now,
        input.userId,
        now,
        now,
      )
  }

  const dshImAvailable = (companyId: string): boolean => {
    const plugin = loadPlugins(deps.db, companyId).find((item) => item.id === pluginIdForFeishu)
    return Boolean(plugin && plugin.enabled && plugin.format === 'dsh')
  }

  /**
   * 机器人凭据优先交给 dsh-im；没有装插件、或插件 host 没起来时不让绑定失败，
   * EAB 仍保存自己的渠道配置，后续装上插件可再走同一条手工绑定补写。
   */
  const bindPluginBot = async (
    companyId: string,
    provider: 'feishu' | 'wecom',
    payload: Record<string, unknown>,
  ): Promise<boolean> => {
    if (!dshImAvailable(companyId)) return false
    const method = provider === 'feishu' ? 'bind-credentials' : 'bot.bind-credentials'
    const rpc = await dispatchPluginRpc(pluginIdForFeishu, provider, { method, payload })
    if (!rpc.ok) {
      const code = rpc.error?.code ?? ''
      if (code === 'host-not-running' || code === 'host-error' || code === 'channel-not-found') return false
      throw new EabError(
        EC.UPSTREAM,
        `${CHANNEL_LABEL[provider]}机器人凭据写入插件失败：${rpc.error?.message ?? '插件不可用'}`,
        {
          hint: '确认凭据属于同一个机器人；不需要插件也能先保存到 EAB，稍后可在插件页补装 dsh-im',
        },
      )
    }
    return true
  }

  const syncChannelNow = async (companyId: string, provider: 'feishu' | 'wecom') => {
    const row = deps.db
      .prepare(
        `SELECT app_id, corp_id, secret_ref, enabled FROM channel_configs
          WHERE company_id = ? AND provider = ?`,
      )
      .get(companyId, provider) as
      | { app_id: string | null; corp_id: string | null; secret_ref: string | null; enabled: number }
      | undefined
    const appSecret = resolveSecret(deps.config.dbPath, row?.secret_ref)
    if (!appSecret) {
      throw new EabError(EC.VALIDATION, '还没有保存通讯录密钥，无法拉取组织架构', {
        hint: provider === 'wecom'
          ? '企业微信机器人凭据不能拉通讯录，请在「同步组织」里补 CorpId + CorpSecret'
          : '请重新填飞书 App Secret，保存后再同步',
      })
    }
    const appId = row?.app_id ?? ''
    const corpId = row?.corp_id ?? ''
    if (provider === 'wecom' ? !corpId : !appId) {
      throw new EabError(EC.VALIDATION, `缺少 ${provider === 'wecom' ? 'CorpId' : 'App ID'}，无法拉取通讯录`)
    }
    let remote
    try {
      remote = await fetchChannelOrg(provider, {
        provider,
        appId,
        corpId,
        appSecret,
      })
    } catch (error) {
      throw new EabError(EC.UPSTREAM, `拉取${CHANNEL_LABEL[provider]}通讯录失败：${(error as Error).message}`, {
        hint: '检查应用凭证、通讯录权限范围（部门/成员是否授权给该应用）以及服务器出网',
      })
    }
    const root = deps.db
      .prepare(
        `SELECT id, path, depth FROM departments
          WHERE company_id = ? AND parent_id IS NULL AND deleted_at IS NULL
          ORDER BY path LIMIT 1`,
      )
      .get(companyId) as { id: string; path: string; depth: number } | undefined
    if (!root) throw new EabError(EC.VALIDATION, '库里没有公司根部门，无法同步组织')
    const plan = mapRemoteOrg(remote, {
      companyId,
      provider,
      root,
      rootChannelDeptIds: provider === 'feishu' ? ['0'] : ['1'],
    })
    const outcome = applyOrgSync(deps.db, { plan, now: Date.now(), recycleAfter: 2 })
    deps.db
      .prepare(
        'UPDATE channel_configs SET last_synced_at = ?, last_sync_run_id = ?, last_sync_status = ?, last_sync_error = NULL, updated_at = ? WHERE company_id = ? AND provider = ?',
      )
      .run(Date.now(), outcome.runId, 'ok', Date.now(), companyId, provider)
    return {
      runId: outcome.runId,
      departments: remote.depts.length,
      members: remote.users.length,
      stats: outcome.stats,
      diffCount: outcome.diffs.length,
      diffs: outcome.diffs.slice(0, 60),
    }
  }

  app.post<{ Params: { provider: string } }>(
    '/api/console/channels/:provider/onboard/start',
    async (req) => {
      requireConsole(req, deps)
      const provider = readOnboardingProvider(req.params.provider)
      const companyId = companyOf(req, deps)

      deps.db
        .prepare(
          `UPDATE channel_bind_sessions SET status = 'cancelled'
            WHERE company_id = ? AND provider = ? AND status IN ('pending', 'scanned')`,
        )
        .run(companyId, provider)

      const sessionId = `bnd_${randomUUID().replace(/-/g, '').slice(0, 20)}`
      const state = `st_${randomUUID().replace(/-/g, '').slice(0, 24)}`
      const now = Date.now()

      if (provider === 'wecom') {
        const started = await startWecomScan().catch((error) => {
          throw new EabError(EC.UPSTREAM, `企业微信扫码初始化失败：${(error as Error).message}`, {
            hint: '确认服务器能访问 work.weixin.qq.com，然后重新生成二维码',
          })
        })
        deps.db
          .prepare(
            `INSERT INTO channel_bind_sessions
               (id, company_id, provider, state, status, qr_content, qr_image_url, meta_json,
                created_by_user_id, created_at, expires_at)
             VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            sessionId,
            companyId,
            provider,
            state,
            started.qrContent,
            started.qrDataUrl,
            JSON.stringify({ kind: 'wecom-qc', scode: started.remoteId }),
            'console:admin',
            now,
            started.expiresAt,
          )
        return ok({
          sessionId,
          provider,
          mode: 'scan',
          qrContent: started.qrContent,
          qrImageUrl: started.qrDataUrl,
          expiresAt: started.expiresAt,
          pollIntervalMs: started.pollIntervalMs,
        })
      }

      let verificationUrl = ''
      let qrCodeDataUrl = ''
      let attemptId = ''
      let expiresAt = now + 5 * 60_000
      let pollIntervalMs = 1_800
      let meta: Record<string, unknown> = {}
      if (dshImAvailable(companyId)) {
        const rpc = await dispatchPluginRpc(pluginIdForFeishu, 'feishu', {
          method: 'provision.begin',
          payload: { locale: 'zh-CN' },
        })
        if (rpc.ok) {
          const value = (rpc.value ?? {}) as {
            provisioning?: Record<string, unknown>
            verificationUrl?: string
            qrCodeDataUrl?: string
            attemptId?: string
            expiresAt?: number
            pollIntervalMs?: number
          }
          const provisioning = value.provisioning ?? value
          verificationUrl = String(provisioning?.verificationUrl ?? '')
          qrCodeDataUrl = String(provisioning?.qrCodeDataUrl ?? '')
          attemptId = String(provisioning?.attemptId ?? '')
          expiresAt = Number(provisioning?.expiresAt ?? expiresAt)
          pollIntervalMs = Number(provisioning?.pollIntervalMs ?? pollIntervalMs)
          meta = { kind: 'feishu-plugin', attemptId }
        } else if (!['host-not-running', 'host-error', 'channel-not-found'].includes(rpc.error?.code ?? '')) {
          throw new EabError(EC.UPSTREAM, `飞书扫码初始化失败：${rpc.error?.message ?? '插件不可用'}`, {
            hint: '确认 dsh-im 插件的飞书 SDK 依赖完整，或卸载插件后使用 EAB 原生扫码',
          })
        }
      }
      if (!verificationUrl || !qrCodeDataUrl || !attemptId) {
        const native = await startFeishuScanNative().catch((error) => {
          throw new EabError(EC.UPSTREAM, `飞书扫码初始化失败：${(error as Error).message}`, {
            hint: '确认服务器能访问 accounts.feishu.cn，然后重新生成二维码',
          })
        })
        verificationUrl = native.qrContent
        qrCodeDataUrl = native.qrDataUrl
        attemptId = native.remoteId
        expiresAt = native.expiresAt
        pollIntervalMs = native.pollIntervalMs
        meta = { ...native.meta, deviceCode: native.remoteId }
      }
      deps.db
        .prepare(
          `INSERT INTO channel_bind_sessions
             (id, company_id, provider, state, status, qr_content, qr_image_url, meta_json,
              created_by_user_id, created_at, expires_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sessionId,
          companyId,
          provider,
          state,
          verificationUrl,
          qrCodeDataUrl,
          JSON.stringify(meta),
          'console:admin',
          now,
          expiresAt,
        )
      return ok({
        sessionId,
        provider,
        mode: 'scan',
        qrContent: verificationUrl,
        qrImageUrl: qrCodeDataUrl,
        expiresAt,
        pollIntervalMs,
      })
    },
  )

  app.get<{ Params: { provider: string; sessionId: string } }>(
    '/api/console/channels/:provider/onboard/:sessionId',
    async (req) => {
      requireConsole(req, deps)
      const provider = readOnboardingProvider(req.params.provider)
      const companyId = companyOf(req, deps)
      const row = deps.db
        .prepare(
          `SELECT * FROM channel_bind_sessions
            WHERE id = ? AND company_id = ? AND provider = ?`,
        )
        .get(req.params.sessionId, companyId, provider) as
        | {
          id: string
          state: string
          status: string
          qr_content: string | null
          qr_image_url: string | null
          meta_json: string | null
          expires_at: number
        }
        | undefined
      if (!row) throw new EabError(EC.NOT_FOUND, '绑定会话不存在或已失效')
      if (row.status === 'success' || row.status === 'cancelled' || row.status === 'expired') {
        return ok({ status: row.status })
      }
      if (row.expires_at <= Date.now()) {
        deps.db.prepare(`UPDATE channel_bind_sessions SET status = 'expired' WHERE id = ?`).run(row.id)
        return ok({ status: 'expired', message: '二维码已过期，请重新生成' })
      }

      let meta: Record<string, unknown> = {}
      try {
        meta = row.meta_json ? JSON.parse(row.meta_json) : {}
      } catch {
        meta = {}
      }

      if (provider === 'wecom') {
        const scode = String(meta.scode ?? '')
        if (!scode) return ok({ status: 'failed', message: '扫码会话缺少 scode' })
        const polled = await pollWecomScan(scode)
        if (polled.status === 'waiting') return ok({ status: 'waiting' })
        if (polled.status === 'expired') {
          deps.db.prepare(`UPDATE channel_bind_sessions SET status = 'expired' WHERE id = ?`).run(row.id)
          return ok({ status: 'expired', message: polled.message })
        }
        if (polled.status === 'failed' || !polled.botId || !polled.botSecret) {
          deps.db
            .prepare(`UPDATE channel_bind_sessions SET status = 'error', error_message = ? WHERE id = ?`)
            .run(polled.message ?? '企业微信扫码授权失败', row.id)
          return ok({ status: 'failed', message: polled.message })
        }
        const botSecretRef = storeSecret(
          deps.config.dbPath,
          null,
          polled.botSecret,
          'EAB_WECOM_BOT_SECRET',
        )
        writeChannelBinding({
          companyId,
          provider,
          tenantId: polled.botId,
          tenantName: polled.tenantName ?? '企业微信机器人',
          bindMode: 'scan',
          userId: 'console:admin',
          botId: polled.botId,
          botSecretRef,
        })
        deps.db
          .prepare(
            `UPDATE channel_bind_sessions SET status = 'success', tenant_id = ?, tenant_name = ?, authorized_at = ? WHERE id = ?`,
          )
          .run(polled.botId, polled.tenantName ?? '企业微信机器人', Date.now(), row.id)
        return ok({
          status: 'success',
          tenantName: polled.tenantName,
          needsOrgCredentials: true,
          message: '机器人已连接；同步组织架构还需要企业 CorpId + CorpSecret',
        })
      }

      if (String(meta.kind ?? '') === 'feishu-native' || meta.deviceCode) {
        const deviceCode = String(meta.deviceCode ?? meta.attemptId ?? '')
        if (!deviceCode) {
          deps.db.prepare(`UPDATE channel_bind_sessions SET status = 'error', error_message = ? WHERE id = ?`).run('扫码会话缺少飞书 deviceCode', row.id)
          return ok({ status: 'failed', message: '扫码会话缺少飞书 deviceCode' })
        }
        let domain: 'feishu' | 'lark' = meta.domain === 'lark' ? 'lark' : 'feishu'
        const polled = await pollFeishuScanNative(deviceCode, domain).catch((error) => {
          throw new EabError(EC.UPSTREAM, `飞书扫码轮询失败：${(error as Error).message}`, {
            hint: '确认服务器能访问 accounts.feishu.cn / accounts.larksuite.com',
          })
        })
        if (polled.domain && polled.domain !== domain) {
          domain = polled.domain
          meta.domain = domain
          deps.db.prepare(`UPDATE channel_bind_sessions SET meta_json = ? WHERE id = ?`).run(JSON.stringify(meta), row.id)
        }
        if (polled.status === 'waiting') {
          if (polled.pollIntervalMs) {
            return ok({ status: 'waiting', pollIntervalMs: polled.pollIntervalMs, message: polled.message })
          }
          return ok({ status: 'waiting' })
        }
        if (polled.status !== 'success' || !polled.appId || !polled.appSecret) {
          const failed = polled.status === 'failed' || polled.status === 'expired'
          deps.db
            .prepare(`UPDATE channel_bind_sessions SET status = ?, error_message = ? WHERE id = ?`)
            .run(polled.status === 'expired' ? 'expired' : (failed ? 'error' : 'pending'), polled.message ?? null, row.id)
          return ok({ status: failed ? 'failed' : 'waiting', message: polled.message })
        }
        const appId = polled.appId
        const appSecret = polled.appSecret
        let tenantName = '飞书机器人'
        try {
          const verified = await verifyFeishuApp(appId, appSecret, domain)
          tenantName = verified.tenantName
        } catch {
          // 应用刚创建时 bot info 可能短暂不可读；凭据已有效，绑定不因此失败。
        }
        const secretRef = storeSecret(deps.config.dbPath, null, appSecret, 'EAB_FEISHU_APP_SECRET')
        writeChannelBinding({
          companyId,
          provider,
          tenantId: appId,
          tenantName,
          bindMode: 'scan',
          userId: 'console:admin',
          appId,
          secretRef,
        })
        deps.db
          .prepare(
            `UPDATE channel_bind_sessions SET status = 'success', tenant_id = ?, tenant_name = ?, authorized_at = ? WHERE id = ?`,
          )
          .run(appId, tenantName, Date.now(), row.id)
        let syncError: string | null = null
        try {
          await syncChannelNow(companyId, provider)
        } catch (error) {
          syncError = (error as Error).message
        }
        return ok({
          status: 'success',
          tenantName,
          needsOrgCredentials: false,
          syncError,
          message: syncError
            ? `飞书应用已绑定；通讯录同步未完成：${syncError}`
            : '飞书应用和机器人已绑定，组织架构已同步',
        })
      }

      const attemptId = String(meta.attemptId ?? '')
      if (!attemptId) return ok({ status: 'failed', message: '扫码会话缺少飞书 attemptId' })
      const rpc = await dispatchPluginRpc(pluginIdForFeishu, 'feishu', {
        method: 'provision.poll',
        payload: { attemptId },
      })
      if (!rpc.ok) {
        return ok({ status: 'failed', message: rpc.error?.message ?? '飞书插件轮询失败' })
      }
      const raw = (rpc.value ?? {}) as {
        status?: string
        message?: string
        bot?: { name?: string; tenantName?: string; botId?: string }
        connection?: {
          status?: string
          message?: string
          bot?: { name?: string; tenantName?: string; botId?: string }
        }
      }
      const value = raw.connection ?? raw
      if (value.status === 'connecting' || value.status === 'provisioning' || value.status === 'disconnected') {
        return ok({ status: 'waiting' })
      }
      if (value.status !== 'connected') {
        const failed = value.status === 'expired' || value.status === 'failed'
        deps.db
          .prepare(`UPDATE channel_bind_sessions SET status = ?, error_message = ? WHERE id = ?`)
          .run(failed ? 'error' : 'pending', value.message ?? null, row.id)
        return ok({ status: failed ? 'failed' : 'waiting', message: value.message })
      }
      const botId = String(value.bot?.botId ?? '')
      const tenantName = String(value.bot?.tenantName ?? value.bot?.name ?? '飞书机器人')
      writeChannelBinding({
        companyId,
        provider,
        tenantId: botId || `feishu-${row.id}`,
        tenantName,
        bindMode: 'scan',
        userId: 'console:admin',
      })
      deps.db
        .prepare(
          `UPDATE channel_bind_sessions SET status = 'success', tenant_id = ?, tenant_name = ?, authorized_at = ? WHERE id = ?`,
        )
        .run(botId || null, tenantName, Date.now(), row.id)
      return ok({
        status: 'success',
        tenantName,
        needsOrgCredentials: true,
        message: '飞书机器人已连接；同步组织架构请补 App ID + App Secret',
      })
    },
  )

  app.post<{ Params: { provider: string }; Body: Record<string, unknown> }>(
    '/api/console/channels/:provider/onboard/manual',
    async (req) => {
      requireConsole(req, deps)
      const provider = readOnboardingProvider(req.params.provider)
      const companyId = companyOf(req, deps)
      const body = req.body ?? {}
      const userId = 'console:admin'

      if (provider === 'feishu') {
        const appId = String(body.appId ?? '').trim()
        const appSecret = String(body.appSecret ?? '').trim()
        const domain = body.domain === 'lark' ? 'lark' : 'feishu'
        if (!appId || !appSecret) {
          throw new EabError(EC.VALIDATION, '飞书需要 App ID 和 App Secret', {
            hint: '在飞书开放平台「凭证与基础信息」里复制',
          })
        }
        const verified = await verifyFeishuApp(appId, appSecret, domain).catch((error) => {
          throw new EabError(EC.UPSTREAM, `飞书凭证校验失败：${(error as Error).message}`, {
            hint: '确认 App ID / App Secret 属于同一个应用，且应用已启用',
          })
        })
        const pluginBound = await bindPluginBot(companyId, 'feishu', { appId, appSecret, domain })
        const secretRef = storeSecret(deps.config.dbPath, null, appSecret, 'EAB_FEISHU_APP_SECRET')
        writeChannelBinding({
          companyId,
          provider,
          tenantId: appId,
          tenantName: verified.tenantName,
          bindMode: 'manual',
          userId,
          appId,
          secretRef,
        })
        let sync: unknown = null
        let syncError: string | null = null
        try {
          sync = await syncChannelNow(companyId, provider)
        } catch (error) {
          syncError = (error as Error).message
        }
        return ok({
          provider,
          mode: 'manual',
          tenantName: verified.tenantName,
          appName: verified.appName,
          pluginBound,
          sync,
          syncError,
        })
      }

      const botId = String(body.botId ?? body.botid ?? '').trim()
      const botSecret = String(body.botSecret ?? body.secret ?? '').trim()
      if (!botId || !botSecret) {
        throw new EabError(EC.VALIDATION, '企业微信机器人需要 Bot ID 和 Secret', {
          hint: '在企业微信管理后台「智能机器人」里取',
        })
      }
      const corpId = String(body.corpId ?? '').trim()
      const corpSecret = String(body.corpSecret ?? '').trim()
      const pluginBound = await bindPluginBot(companyId, 'wecom', { botId, secret: botSecret })
      const botSecretRef = storeSecret(deps.config.dbPath, null, botSecret, 'EAB_WECOM_BOT_SECRET')
      const secretRef = corpSecret
        ? storeSecret(deps.config.dbPath, null, corpSecret, 'EAB_WECOM_CORP_SECRET')
        : null
      writeChannelBinding({
        companyId,
        provider,
        tenantId: corpId || botId,
        tenantName: String(body.tenantName ?? '').trim() || '企业微信机器人',
        bindMode: 'manual',
        userId,
        corpId: corpId || null,
        secretRef,
        botId,
        botSecretRef,
      })
      let sync: unknown = null
      let syncError: string | null = null
      if (corpId && corpSecret) {
        try {
          sync = await syncChannelNow(companyId, provider)
        } catch (error) {
          syncError = (error as Error).message
        }
      }
      return ok({
        provider,
        mode: 'manual',
        tenantName: String(body.tenantName ?? '').trim() || '企业微信机器人',
        pluginBound,
        sync,
        syncError,
        needsOrgCredentials: !corpId || !corpSecret,
      })
    },
  )

  app.post<{ Params: { provider: string }; Body: Record<string, unknown> }>(
    '/api/console/channels/:provider/org',
    async (req) => {
      requireConsole(req, deps)
      const provider = readOnboardingProvider(req.params.provider)
      const companyId = companyOf(req, deps)
      const body = req.body ?? {}
      if (provider === 'wecom') {
        const corpId = String(body.corpId ?? '').trim()
        const corpSecret = String(body.corpSecret ?? '').trim()
        if (!corpId || !corpSecret) {
          throw new EabError(EC.VALIDATION, '企业微信同步通讯录需要 CorpId 和 CorpSecret', {
            hint: '机器人凭据（Bot ID + Secret）不能拉通讯录，必须使用企业应用的通讯录 Secret',
          })
        }
        const secretRef = storeSecret(deps.config.dbPath, null, corpSecret, 'EAB_WECOM_CORP_SECRET')
        deps.db
          .prepare(
            `UPDATE channel_configs
                SET corp_id = ?, secret_ref = ?, enabled = 1, status = 'bound',
                    last_sync_status = 'pending', last_sync_error = NULL, updated_at = ?
              WHERE company_id = ? AND provider = 'wecom'`,
          )
          .run(corpId, secretRef, Date.now(), companyId)
      }
      if (provider === 'feishu') {
        const appId = String(body.appId ?? '').trim()
        const appSecret = String(body.appSecret ?? '').trim()
        if (appId && appSecret) {
          const verified = await verifyFeishuApp(appId, appSecret).catch((error) => {
            throw new EabError(EC.UPSTREAM, `飞书凭证校验失败：${(error as Error).message}`)
          })
          const secretRef = storeSecret(deps.config.dbPath, null, appSecret, 'EAB_FEISHU_APP_SECRET')
          deps.db
            .prepare(
              `UPDATE channel_configs
                  SET app_id = ?, secret_ref = ?, tenant_name = COALESCE(NULLIF(tenant_name, ''), ?),
                      enabled = 1, status = 'bound', last_sync_status = 'pending', last_sync_error = NULL, updated_at = ?
                WHERE company_id = ? AND provider = 'feishu'`,
            )
            .run(appId, secretRef, verified.tenantName, Date.now(), companyId)
        }
      }
      try {
        const sync = await syncChannelNow(companyId, provider)
        return ok({ provider, sync })
      } catch (error) {
        deps.db
          .prepare(
            `UPDATE channel_configs SET last_sync_status = 'error', last_sync_error = ?, updated_at = ?
              WHERE company_id = ? AND provider = ?`,
          )
          .run((error as Error).message, Date.now(), companyId, provider)
        throw error
      }
    },
  )


  app.post<{ Body: { appId?: string; appSecret?: string; corpId?: string; replaceDemo?: boolean } }>(
    '/api/console/channels/dingtalk/bind',
    async (req) => {
      requireConsole(req, deps)
      const companyId = companyOf(req, deps)
      const existing = deps.db
        .prepare(
          `SELECT id, app_id, corp_id, secret_ref, tenant_id, tenant_name
             FROM channel_configs WHERE company_id = ? AND provider = 'dingtalk'`,
        )
        .get(companyId) as
        | {
            id: string
            app_id: string | null
            corp_id: string | null
            secret_ref: string | null
            tenant_id: string | null
            tenant_name: string | null
          }
        | undefined

      const appId = String(req.body?.appId ?? existing?.app_id ?? '').trim().slice(0, 120)
      const corpId = String(req.body?.corpId ?? existing?.corp_id ?? '').trim().slice(0, 120)
      if (!appId) throw new EabError(EC.VALIDATION, '缺少钉钉 AppKey')
      if (!corpId) throw new EabError(EC.VALIDATION, '缺少钉钉企业 CorpId', {
        hint: 'CorpId 用来确认这是哪家钉钉企业，也是跨公司唯一绑定的依据。',
      })

      let secretRef = existing?.secret_ref ?? null
      const typedSecret = String(req.body?.appSecret ?? '').trim()
      const appSecret = typedSecret || resolveSecret(deps.config.dbPath, secretRef)
      if (!appSecret) {
        throw new EabError(EC.VALIDATION, '缺少钉钉 AppSecret', {
          hint: '在钉钉开发者后台的企业内部应用里复制 AppSecret；已有密钥可留空。',
        })
      }

      let tenant: { tenantId: string; name: string }
      let remote: Awaited<ReturnType<typeof fetchChannelOrg>>
      try {
        tenant = await fetchDingTalkTenant({ provider: 'dingtalk', appId, corpId, appSecret })
        remote = await fetchChannelOrg('dingtalk', { provider: 'dingtalk', appId, corpId, appSecret })
      } catch (err) {
        const raw = (err as Error).message
        if (/invalidClientIdOrSecret|无效的clientId|invalid appkey|invalid appsecret/i.test(raw)) {
          throw new EabError(EC.UPSTREAM, '钉钉应用凭证不匹配：AppKey 与 AppSecret 不属于同一个应用', {
            hint: '当前保存的 AppSecret 对该 AppKey 无效（可能来自旧应用或被重置）。请在弹窗里重新粘贴这个应用当前的 AppSecret，不要留空沿用旧密钥，再点「绑定并同步」。',
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
          const applyUrls = Object.fromEntries(
            requiredScopes.map((scope) => [
              scope,
              `https://open-dev.dingtalk.com/appscope/apply?content=${encodeURIComponent(`${appId}#${scope}`)}`,
            ]),
          )
          throw new EabError(
            EC.UPSTREAM,
            `钉钉应用权限未生效（60011）：钉钉这次要求 ${requiredScopes.join('、')}`,
            {
              hint: `钉钉这次点名的权限是 ${requiredScopes.join('、')}。如果它已经显示「已开通」，请到「版本管理与发布」创建并发布一个新版本，等状态变成「已上线」后再回来重试；如果还没开通，点下面的按钮开通。注意：拉取成员列表用的是「通讯录部门成员读权限 qyapi_get_department_member」，不是 qyapi_get_member。钉钉的权限变更属于配置变更，只在权限页点「立即开通」不够，必须走版本发布才会对接口生效。`,
              details: {
                reason: 'permission_not_effective',
                requiredScopes,
                applyUrls,
                versionUrl: 'https://open-dev.dingtalk.com/fe/ai',
                original: raw.slice(0, 400),
              },
              cause: err,
            },
          )
        }
        throw new EabError(EC.UPSTREAM, `钉钉授权/读取通讯录失败：${raw}`, {
          hint: '检查 AppKey/AppSecret、CorpId 是否匹配，并在钉钉开发者后台给该应用开通「通讯录部门信息读权限 qyapi_get_department_list」和「通讯录成员信息读权限 qyapi_get_member」；只开 qyapi_manage_addresslist 不够。',
          cause: err,
        })
      }
      if (remote.depts.length === 0 && remote.users.length === 0) {
        throw new EabError(EC.UPSTREAM, '钉钉通讯录返回为空，拒绝绑定', {
          hint: '确认应用的通讯录权限范围已包含要同步的部门与成员。',
        })
      }

      const boundElsewhere = deps.db
        .prepare(
          `SELECT company_id FROM channel_configs
            WHERE provider = 'dingtalk' AND tenant_id = ? AND company_id <> ?`,
        )
        .get(tenant.tenantId, companyId) as { company_id?: string } | undefined
      if (boundElsewhere?.company_id) {
        throw new EabError(EC.CONFLICT, '该钉钉企业已被其他 EAB 公司绑定', {
          hint: '一个钉钉 CorpId 只能绑定一家公司；请让对应公司先解绑，或使用贵司自己的钉钉企业。',
          details: { provider: 'dingtalk', tenantId: tenant.tenantId, boundTo: boundElsewhere.company_id },
        })
      }
      const demoExisting = Boolean(
        existing?.tenant_id &&
          (existing.tenant_id.startsWith('demo-') || String(existing.tenant_name ?? '').includes('演示')),
      )
      if (existing?.tenant_id && existing.tenant_id !== tenant.tenantId && !demoExisting) {
        throw new EabError(EC.CONFLICT, '本公司已绑定另一个钉钉企业', {
          hint: '要换企业请先在渠道页解绑，再重新绑定。',
          details: { currentTenantId: existing.tenant_id, nextTenantId: tenant.tenantId },
        })
      }

      if (typedSecret) {
        secretRef = storeSecret(deps.config.dbPath, secretRef, typedSecret, 'EAB_DINGTALK_APP_SECRET')
      }

      const now = Date.now()
      const id = existing?.id ?? `ch_${randomUUID()}`
      if (existing) {
        deps.db
          .prepare(
            `UPDATE channel_configs
                SET app_id = ?, corp_id = ?, secret_ref = ?, tenant_id = ?, tenant_name = ?,
                    bound_at = ?, bound_by_user_id = ?, enabled = 1, status = 'bound',
                    sync_mode = 'daily', updated_at = ?
              WHERE id = ?`,
          )
          .run(appId, corpId, secretRef, tenant.tenantId, tenant.name, now, 'console:dingtalk-bind', now, id)
      } else {
        deps.db
          .prepare(
            `INSERT INTO channel_configs
               (id, company_id, provider, enabled, status, sync_mode, app_id, corp_id, secret_ref,
                tenant_id, tenant_name, bound_at, bound_by_user_id, created_at, updated_at)
             VALUES (?, ?, 'dingtalk', 1, 'bound', 'daily', ?, ?, ?, ?, ?, ?, 'console:dingtalk-bind', ?, ?)`,
          )
          .run(id, companyId, appId, corpId, secretRef, tenant.tenantId, tenant.name, now, now, now)
      }

      const root = deps.db
        .prepare(
          `SELECT id, path, depth FROM departments
            WHERE company_id = ? AND parent_id IS NULL AND deleted_at IS NULL
            ORDER BY path LIMIT 1`,
        )
        .get(companyId) as { id: string; path: string; depth: number } | undefined
      if (!root) throw new EabError(EC.VALIDATION, '库里没有公司根部门，无法导入钉钉组织')

      const plan = mapRemoteOrg(remote, {
        companyId,
        provider: 'dingtalk',
        root,
        rootChannelDeptIds: ['1'],
      })
      const orgBefore = deps.db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM departments d
               WHERE d.company_id = ? AND d.deleted_at IS NULL) AS departments,
             (SELECT COUNT(*) FROM departments d
               WHERE d.company_id = ? AND d.deleted_at IS NULL AND d.channel_dept_id IS NOT NULL) AS channel_departments,
             (SELECT COUNT(*) FROM departments d
               WHERE d.company_id = ? AND d.deleted_at IS NULL AND d.id LIKE 'd_dingtalk_%') AS dingtalk_departments,
             (SELECT COUNT(*) FROM users u
               WHERE u.company_id = ? AND u.deleted_at IS NULL) AS members`,
        )
        .get(companyId, companyId, companyId, companyId) as {
        departments: number
        channel_departments: number
        dingtalk_departments: number
        members: number
      }
      const outcome = applyOrgSync(deps.db, { plan, now: Date.now(), recycleAfter: 2 })

      let archived = { departments: 0, members: 0 }
      const replaceable =
        Number(orgBefore.dingtalk_departments) === 0 &&
        (Number(orgBefore.departments) > 1 || Number(orgBefore.members) > 0)
      if (req.body?.replaceDemo && replaceable) {
        const members = deps.db
          .prepare(
            `UPDATE users
                SET deleted_at = ?, disabled_at = ?, updated_at = ?
              WHERE company_id = ? AND deleted_at IS NULL
                AND id NOT LIKE 'u_dingtalk_%'`,
          )
          .run(now, now, now, companyId)
        const departments = deps.db
          .prepare(
            `UPDATE departments
                SET deleted_at = ?
              WHERE company_id = ? AND deleted_at IS NULL
                AND id <> ?
                AND id NOT LIKE 'd_dingtalk_%'`,
          )
          .run(now, companyId, root.id)
        archived = { departments: Number(departments.changes), members: Number(members.changes) }
      }

      appendAudit(deps.db, {
        companyId,
        actorUserId: 'console-operator',
        action: 'channel.dingtalk.bind',
        resourceType: 'channel',
        resourceId: 'dingtalk',
        result: 'success',
        detail: {
          tenantId: tenant.tenantId,
          tenantName: tenant.name,
          departments: remote.depts.length,
          members: remote.users.length,
          runId: outcome.runId,
          archived,
        },
        ip: req.ip ?? null,
        channel: 'console',
      })

      return ok({
        binding: {
          provider: 'dingtalk',
          tenantId: tenant.tenantId,
          tenantName: tenant.name,
          boundAt: now,
        },
        sync: {
          runId: outcome.runId,
          departments: remote.depts.length,
          members: remote.users.length,
          stats: outcome.stats,
          archived,
          diffCount: outcome.diffs.length,
          diffs: outcome.diffs.slice(0, 60),
        },
      })
    },
  )

  /* ---------------- 渠道身份绑定（CHN-03） ---------------- */

  app.get<{ Querystring: { limit?: string; offset?: string } }>('/api/console/channel-identities', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const rawLimit = Number(req.query?.limit ?? '20')
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100) : 20
    const rawOffset = Number(req.query?.offset ?? '0')
    const offset = Number.isFinite(rawOffset) ? Math.max(Math.trunc(rawOffset), 0) : 0
    const total = Number(
      (
        deps.db
          .prepare(
            `SELECT COUNT(*) AS n FROM channel_identities ci
               JOIN users u ON u.id = ci.user_id
              WHERE ci.company_id = ? AND ci.revoked_at IS NULL`,
          )
          .get(companyId) as { n: number }
      ).n,
    )
    const items = deps.db
      .prepare(
        `SELECT ci.id, ci.provider, ci.external_id, ci.user_id, ci.created_at,
                u.name AS user_name, u.employee_no
           FROM channel_identities ci
           JOIN users u ON u.id = ci.user_id
          WHERE ci.company_id = ? AND ci.revoked_at IS NULL
          ORDER BY ci.provider, ci.created_at DESC
          LIMIT ? OFFSET ?`,
      )
      .all(companyId, limit, offset)
    return ok({ items, total, limit, offset })
  })

  app.post<{ Body: { provider?: string; externalId?: string; userId?: string } }>(
    '/api/console/channel-identities',
    async (req, reply) => {
      requireConsole(req, deps)
      const companyId = companyOf(req, deps)
      const provider = String(req.body?.provider ?? '')
      if (!CHANNEL_PROVIDERS.has(provider)) throw new EabError(EC.VALIDATION, '渠道类型不合法')
      const externalId = String(req.body?.externalId ?? '').trim()
      const userId = String(req.body?.userId ?? '').trim()
      if (!externalId || !userId) throw new EabError(EC.VALIDATION, '外部账号 ID 与成员都不能为空')
      const user = deps.db
        .prepare('SELECT id, name FROM users WHERE id = ? AND company_id = ? AND deleted_at IS NULL')
        .get(userId, companyId) as { id: string; name: string } | undefined
      if (!user) throw new EabError(EC.NOT_FOUND, '成员不存在或不属于当前公司')
      deps.db
        .prepare(
          `INSERT INTO channel_identities (id, company_id, provider, external_id, user_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(`ci_${randomUUID()}`, companyId, provider, externalId, userId, Date.now())
      appendAudit(deps.db, {
        companyId,
        actorUserId: 'console-operator',
        action: 'channel.identity.bind',
        resourceType: 'user',
        resourceId: userId,
        result: 'success',
        detail: { provider, externalId },
        ip: req.ip ?? null,
        channel: 'console',
      })
      reply.code(201)
      return ok({ provider, externalId, userId, userName: user.name })
    },
  )

  app.delete<{ Params: { id: string } }>('/api/console/channel-identities/:id', async (req) => {
    requireConsole(req, deps)
    const companyId = companyOf(req, deps)
    const id = String(req.params.id)
    const row = deps.db
      .prepare('SELECT id FROM channel_identities WHERE id = ? AND company_id = ? AND revoked_at IS NULL')
      .get(id, companyId)
    if (!row) throw new EabError(EC.NOT_FOUND, '绑定不存在')
    deps.db.prepare('UPDATE channel_identities SET revoked_at = ? WHERE id = ?').run(Date.now(), id)
    appendAudit(deps.db, {
      companyId,
      actorUserId: 'console-operator',
      action: 'channel.identity.unbind',
      resourceType: 'channel_identity',
      resourceId: id,
      result: 'success',
      ip: req.ip ?? null,
      channel: 'console',
    })
    return ok({ id, revoked: true })
  })

  /** 渠道回调入口：URL 验证 + 钉钉机器人回显；带事件去重、身份绑定与频控。 */
  const rateBuckets = new Map<string, number[]>()
  app.post<{ Params: { provider: string }; Querystring: { token?: string }; Body: Record<string, unknown> }>(
    '/api/channel/webhooks/:provider',
    async (req, reply) => {
      const provider = String(req.params.provider)
      if (!CHANNEL_PROVIDERS.has(provider)) throw new EabError(EC.NOT_FOUND, '未知渠道')
      const token = String((req.query as { token?: string } | undefined)?.token ?? '')
      if (!token) throw new EabError(EC.FORBIDDEN, '缺少回调 token')
      const row = deps.db
        .prepare('SELECT callback_token, company_id FROM channel_configs WHERE provider = ? AND callback_token = ?')
        .get(provider, token) as { callback_token: string; company_id: string } | undefined
      if (!row) throw new EabError(EC.FORBIDDEN, '回调 token 不匹配')

      const body = req.body ?? {}
      if (provider === 'feishu' && body.type === 'url_verification') {
        return ok({ challenge: body.challenge })
      }

      // CHN-02 幂等：同一事件重推不重复处理
      const header = (body.header ?? {}) as { event_id?: unknown }
      const eventKey =
        (typeof header.event_id === 'string' && header.event_id) ||
        (typeof body.event_id === 'string' && body.event_id) ||
        (typeof body.msgId === 'string' && body.msgId) ||
        (typeof body.MsgId === 'string' && body.MsgId) ||
        createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 32)
      const existing = deps.db
        .prepare('SELECT id FROM channel_events WHERE provider = ? AND event_key = ?')
        .get(provider, eventKey) as { id: string } | undefined
      if (existing) return ok({ received: true, duplicate: true, eventKey })

      const senderId =
        (typeof body.senderStaffId === 'string' && body.senderStaffId) ||
        (typeof body.senderId === 'string' && body.senderId) ||
        (typeof body.FromUserName === 'string' && body.FromUserName) ||
        (() => {
          const sender = (body.event as { sender?: { sender_id?: { open_id?: unknown } } } | undefined)?.sender
          return typeof sender?.sender_id?.open_id === 'string' ? sender.sender_id.open_id : ''
        })()

      deps.db
        .prepare(
          `INSERT INTO channel_events (id, company_id, provider, event_key, sender_id, received_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(`evt_${randomUUID()}`, row.company_id, provider, eventKey, senderId || null, Date.now())

      // CHN-03 外部身份绑定：未绑定不进入检索，也不消耗模型 token
      const binding = senderId
        ? (deps.db
            .prepare(
              `SELECT ci.user_id, u.name
                 FROM channel_identities ci
                 JOIN users u ON u.id = ci.user_id
                WHERE ci.provider = ? AND ci.external_id = ? AND ci.revoked_at IS NULL
                  AND u.deleted_at IS NULL
                LIMIT 1`,
            )
            .get(provider, senderId) as { user_id: string; name: string } | undefined)
        : undefined

      // CHN-06 频控：同一发送者每分钟最多 20 条
      if (senderId) {
        const key = `${provider}:${senderId}`
        const now = Date.now()
        const bucket = (rateBuckets.get(key) ?? []).filter((at) => now - at < 60_000)
        if (bucket.length >= 20) {
          rateBuckets.set(key, bucket)
          return ok({ received: true, throttled: true, limitPerMinute: 20 })
        }
        bucket.push(now)
        rateBuckets.set(key, bucket)
      }

      if (provider === 'dingtalk') {
        /**
         * 钉钉回调必须立刻 200，否则钉钉会判定超时并重推；
         * 模型回答放到后台跑，完成后用 sessionWebhook 回给用户。
         */
        const payload = body as {
          msgtype?: string
          text?: { content?: string }
          content?: {
            downloadCode?: string
            fileName?: string
            richText?: Array<{ type?: string; text?: string; downloadCode?: string; fileName?: string }>
          }
          senderStaffId?: string
          senderId?: string
          sessionWebhook?: string
          msgId?: string
          createAt?: number
        }
        const sessionWebhook = typeof payload.sessionWebhook === 'string' ? payload.sessionWebhook : ''
        void import('../dingtalk-bot.js')
          .then(async (bot) => {
            const result = await bot.handleDingTalkMessage(deps, payload, { dedupe: false })
            if (result.text && sessionWebhook) await bot.replySessionWebhook(deps, sessionWebhook, result.text)
            return result
          })
          .catch((error) => console.warn('[eab] 钉钉回调处理失败：', (error as Error).message))
        return ok({
          received: true,
          queued: true,
          bound: Boolean(binding),
          senderId: senderId || null,
        })
      }

      if (provider === 'feishu') {
        return ok({
          received: true,
          replied: false,
          bound: Boolean(binding),
          senderId: senderId || null,
          note: binding ? '飞书消息事件已接收（已绑定成员）' : '飞书消息事件已接收；发送者未绑定 EAB 账号',
        })
      }

      reply.code(501)
      return ok({ received: false, note: '企业微信回调需要 AES 解密，当前版本未启用' })
    },
  )
}