/**
 * 渠道绑定（扫码授权）——钉钉 / 飞书 / 企业微信。
 *
 * 为什么是"扫码绑定"而不是让管理员手填 app_secret：
 * 1. 企业租户只有一个管理员能授权，扫码是渠道原生的授权动作（谁扫谁负责，天然留痕）；
 * 2. 手填密钥必然出现"把 A 公司的应用配到 B 公司"，扫码拿到的是租户身份，可以在写入处做隔离校验；
 * 3. 同一套交互三家都能用（飞书/钉钉/企微都有扫码授权），前端不用为每家写一套表单。
 *
 * 状态机：pending（等扫码）→ scanned（已扫待确认）→ authorized（拿到租户）→ 写绑定；
 *         超时→expired，中途取消→cancelled，渠道报错→failed。页面靠轮询推进，不猜。
 */
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { EC, EabError, SC, ulid } from '@eab/domain'
import type { ServerDeps } from '../deps.js'
import { ok, requireScope } from '../http.js'
import { resolveActor } from '../session.js'
import { executeChannelUnbind, previewChannelUnbind } from '../channel-unbind.js'
import { refreshFeishuStream } from '../feishu-bot.js'
import { refreshDingTalkStream } from '../dingtalk-bot.js'

export type BindableProvider = 'feishu' | 'dingtalk' | 'wecom'

const PROVIDERS: Array<{ id: BindableProvider; label: string; hint: string }> = [
  { id: 'feishu', label: '飞书', hint: '管理员用飞书扫码，把本公司的飞书租户授权给 EAB' },
  { id: 'dingtalk', label: '钉钉', hint: '管理员用企业内部应用凭据绑定，绑定后按企业通讯录同步' },
  { id: 'wecom', label: '企业微信', hint: '管理员用企微扫码，授权后按部门与成员同步' },
]

const SESSION_TTL_MS = 5 * 60 * 1000

interface BindingRow {
  provider: string
  enabled: number
  status: string
  sync_mode: string
  tenant_id: string | null
  tenant_name: string | null
  bound_at: number | null
  last_synced_at: number | null
  last_sync_run_id: string | null
}

interface SessionRow {
  id: string
  company_id: string
  provider: string
  state: string
  status: string
  qr_content: string | null
  qr_image_url: string | null
  tenant_id: string | null
  tenant_name: string | null
  error_message: string | null
  created_by_user_id: string
  created_at: number
  expires_at: number
  authorized_at: number | null
}

function parseProvider(raw: unknown): BindableProvider {
  const value = String(raw ?? '')
  const hit = PROVIDERS.find((item) => item.id === value)
  if (!hit) {
    throw new EabError(EC.VALIDATION, `不支持的渠道: ${value || '（空）'}`, {
      hint: '可用值：feishu / dingtalk / wecom',
    })
  }
  return hit.id
}

function forCompany(deps: ServerDeps, companyId: string): ServerDeps {
  // 多公司：同一台服务里每家公司有自己的渠道行，请求属于哪家由成员决定
  return { ...deps, companyId }
}

function providerLabel(id: string): string {
  return PROVIDERS.find((item) => item.id === id)?.label ?? id
}

function companyName(deps: ServerDeps): string {
  const row = deps.db
    .prepare('SELECT name FROM companies WHERE id = ?')
    .get(deps.companyId) as { name?: string } | undefined
  return row?.name ?? '本公司'
}

function findBinding(deps: ServerDeps, provider: string): BindingRow | undefined {
  return deps.db
    .prepare(
      `SELECT provider, enabled, status, sync_mode, tenant_id, tenant_name, bound_at,
              last_synced_at, last_sync_run_id
         FROM channel_configs WHERE company_id = ? AND provider = ?`,
    )
    .get(deps.companyId, provider) as BindingRow | undefined
}

function listBindings(deps: ServerDeps): unknown[] {
  return PROVIDERS.map((item) => {
    const row = findBinding(deps, item.id)
    const bound = Boolean(row?.tenant_id)
    return {
      provider: item.id,
      label: item.label,
      hint: item.hint,
      bound,
      status: row?.status ?? 'unconfigured',
      enabled: Boolean(row?.enabled),
      syncMode: row?.sync_mode ?? 'off',
      tenantId: row?.tenant_id ?? null,
      tenantName: row?.tenant_name ?? null,
      boundAt: row?.bound_at ?? null,
      lastSyncedAt: row?.last_synced_at ?? null,
      lastSyncRunId: row?.last_sync_run_id ?? null,
    }
  })
}

function readSession(deps: ServerDeps, sessionId: string): SessionRow {
  const row = deps.db
    .prepare(
      `SELECT id, company_id, provider, state, status, qr_content, qr_image_url, tenant_id, tenant_name,
              error_message, created_by_user_id, created_at, expires_at, authorized_at
         FROM channel_bind_sessions WHERE id = ? AND company_id = ?`,
    )
    .get(sessionId, deps.companyId) as SessionRow | undefined
  if (!row) throw new EabError(EC.NOT_FOUND, `绑定会话不存在或已失效: ${sessionId}`)

  // 到点没扫 → expired（只推进到终止态，不删记录）
  if ((row.status === 'pending' || row.status === 'scanned') && Date.now() > row.expires_at) {
    deps.db
      .prepare('UPDATE channel_bind_sessions SET status = ? WHERE id = ?')
      .run('expired', row.id)
    row.status = 'expired'
  }
  return row
}

function sessionPayload(row: SessionRow) {
  return {
    sessionId: row.id,
    provider: row.provider,
    providerLabel: providerLabel(row.provider),
    state: row.state,
    status: row.status,
    expiresAt: row.expires_at,
    qr:
      row.qr_content || row.qr_image_url
        ? { content: row.qr_content, imageUrl: row.qr_image_url }
        : null,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    error: row.error_message,
    authorizedAt: row.authorized_at,
  }
}

/** 把租户写到 channel_configs（同一公司同一渠道只有一行，重复绑定走 update） */
function writeBinding(
  deps: ServerDeps,
  provider: string,
  tenantId: string,
  tenantName: string,
  userId: string,
  now: number,
): void {
  const other = deps.db
    .prepare(
      'SELECT company_id FROM channel_configs WHERE provider = ? AND tenant_id = ? AND company_id <> ?',
    )
    .get(provider, tenantId, deps.companyId) as { company_id?: string } | undefined
  if (other?.company_id) {
    throw new EabError(EC.CONFLICT, `该${providerLabel(provider)}企业已被其他公司绑定`, {
      hint: '一个渠道租户只能绑定一家 EAB 公司。请让对应公司的管理员先解绑，或改用贵司自己的租户。',
      details: { provider, tenantId, boundTo: other.company_id },
    })
  }

  const existing = findBinding(deps, provider)
  if (existing) {
    deps.db
      .prepare(
        `UPDATE channel_configs
            SET tenant_id = ?, tenant_name = ?, bound_at = ?, bound_by_user_id = ?,
                enabled = 1, status = 'bound', sync_mode = 'daily', updated_at = ?
          WHERE company_id = ? AND provider = ?`,
      )
      .run(tenantId, tenantName, now, userId, now, deps.companyId, provider)
    return
  }

  deps.db
    .prepare(
      `INSERT INTO channel_configs
         (id, company_id, provider, enabled, status, sync_mode, tenant_id, tenant_name,
          bound_at, bound_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, 1, 'bound', 'daily', ?, ?, ?, ?, ?, ?)`,
    )
    .run(ulid(now), deps.companyId, provider, tenantId, tenantName, now, userId, now, now)
}

export function registerChannelRoutes(app: FastifyInstance, deps: ServerDeps): void {
  /** 三个渠道的绑定状态 */
  app.get('/api/channel/bindings', async (req) => {
    const { subject } = resolveActor(deps.db, deps.config, req)
    requireScope(subject, SC.ORG_DEPT_READ)
    const scope = forCompany(deps, subject.companyId)
    return ok({ bindings: listBindings(scope), devAuth: deps.config.devAuth })
  })

  /** 发起扫码绑定：返回会话 + 二维码内容（真渠道会返回渠道生成的二维码图片/链接） */
  app.post('/api/channel/bind/start', async (req) => {
    const { subject } = resolveActor(deps.db, deps.config, req)
    requireScope(subject, SC.CHANNEL_MANAGE)
    const scope = forCompany(deps, subject.companyId)

    const body = (req.body ?? {}) as { provider?: unknown }
    const provider = parseProvider(body.provider)

    const current = findBinding(scope, provider)
    if (current?.tenant_id) {
      throw new EabError(
        EC.CONFLICT,
        `本公司已绑定${providerLabel(provider)}（${current.tenant_name ?? current.tenant_id}）`,
        { hint: '要换企业请先解绑，再重新扫码。' },
      )
    }

    const now = Date.now()
    // 同公司同渠道只保留一个"还能扫"的会话，避免页面上多个二维码互相打架
    deps.db
      .prepare(
        `UPDATE channel_bind_sessions SET status = 'cancelled'
          WHERE company_id = ? AND provider = ? AND status IN ('pending', 'scanned')`,
      )
      .run(subject.companyId, provider)

    const id = `bnd_${randomUUID().replace(/-/g, '').slice(0, 20)}`
    const state = `st_${randomUUID().replace(/-/g, '').slice(0, 24)}`
    const qrContent = `eab://channel/bind?provider=${provider}&state=${state}`
    deps.db
      .prepare(
        `INSERT INTO channel_bind_sessions
           (id, company_id, provider, state, status, qr_content, qr_image_url,
            tenant_id, tenant_name, error_message, created_by_user_id, created_at, expires_at, authorized_at)
         VALUES (?, ?, ?, ?, 'pending', ?, NULL, NULL, NULL, NULL, ?, ?, ?, NULL)`,
      )
      .run(id, subject.companyId, provider, state, qrContent, subject.userId, now, now + SESSION_TTL_MS)

    return ok({
      ...sessionPayload(readSession(scope, id)),
      mock: deps.config.devAuth,
      ttlMs: SESSION_TTL_MS,
    })
  })

  /** 轮询绑定状态 */
  app.get('/api/channel/bind/:sessionId', async (req) => {
    const { subject } = resolveActor(deps.db, deps.config, req)
    requireScope(subject, SC.CHANNEL_MANAGE)
    const scope = forCompany(deps, subject.companyId)
    const params = (req.params ?? {}) as { sessionId?: string }
    return ok(sessionPayload(readSession(scope, params.sessionId ?? '')))
  })

  /** 取消绑定 */
  app.post('/api/channel/bind/:sessionId/cancel', async (req) => {
    const { subject } = resolveActor(deps.db, deps.config, req)
    requireScope(subject, SC.CHANNEL_MANAGE)
    const scope = forCompany(deps, subject.companyId)
    const params = (req.params ?? {}) as { sessionId?: string }
    const row = readSession(scope, params.sessionId ?? '')
    if (row.status === 'pending' || row.status === 'scanned') {
      deps.db
        .prepare('UPDATE channel_bind_sessions SET status = ? WHERE id = ?')
        .run('cancelled', row.id)
      row.status = 'cancelled'
    }
    return ok(sessionPayload(row))
  })

  /**
   * 模拟扫码（仅开发预览）。
   * 真渠道这里换成"渠道回调/轮询到授权码后换租户"，后面的写绑定逻辑完全复用。
   */
  app.post('/api/channel/bind/:sessionId/mock-scan', async (req) => {
    const { subject } = resolveActor(deps.db, deps.config, req)
    requireScope(subject, SC.CHANNEL_MANAGE)
    const scope = forCompany(deps, subject.companyId)
    if (!deps.config.devAuth) {
      throw new EabError(EC.NOT_FOUND, '未开放', { hint: '正式环境请用渠道回调完成授权' })
    }

    const params = (req.params ?? {}) as { sessionId?: string }
    const row = readSession(scope, params.sessionId ?? '')
    if (row.status !== 'pending' && row.status !== 'scanned') {
      throw new EabError(EC.CONFLICT, `当前会话状态是 ${row.status}，不能再扫码`, {
        hint: '重新点一次「扫码绑定」拿新的二维码。',
      })
    }

    const now = Date.now()
    const tenantId = `demo-${row.provider}-tenant`
    const tenantName = `${companyName(scope)}（${providerLabel(row.provider)}演示租户）`

    // 真渠道这里拿到的是"临时授权码 → 换 permanent_code / tenant_access_token"，再取租户 ID
    writeBinding(scope, row.provider, tenantId, tenantName, subject.userId, now)

    deps.db
      .prepare(
        `UPDATE channel_bind_sessions
            SET status = 'authorized', tenant_id = ?, tenant_name = ?, authorized_at = ?
          WHERE id = ?`,
      )
      .run(tenantId, tenantName, now, row.id)

    return ok({ session: sessionPayload(readSession(scope, row.id)), bindings: listBindings(scope) })
  })

  /** 解绑预览：只读，给出将删除的部门/成员/角色数量，供控制台二次确认 */
  app.get('/api/channel/unbind/preview', async (req) => {
    const { subject } = resolveActor(deps.db, deps.config, req)
    requireScope(subject, SC.CHANNEL_MANAGE)
    const scope = forCompany(deps, subject.companyId)
    const provider = parseProvider((req.query as { provider?: unknown } | undefined)?.provider)

    const current = findBinding(scope, provider)
    if (!current?.tenant_id) {
      throw new EabError(EC.CONFLICT, `本公司还没有绑定${providerLabel(provider)}`, {
        hint: '未绑定就无需解绑。',
      })
    }

    return ok(previewChannelUnbind(deps.db, scope.companyId, provider))
  })

  /**
   * 解绑：按 1B/2B/3A 清理该渠道带来的组织、成员、角色和身份。
   * 必须带 confirm:true，避免旧页面或脚本误触发不可逆清理。
   */
  app.post('/api/channel/unbind', async (req) => {
    const { subject } = resolveActor(deps.db, deps.config, req)
    requireScope(subject, SC.CHANNEL_MANAGE)
    const scope = forCompany(deps, subject.companyId)
    const body = (req.body ?? {}) as { provider?: unknown; confirm?: unknown }
    const provider = parseProvider(body.provider)
    if (body.confirm !== true) {
      throw new EabError(EC.VALIDATION, '解绑会删除该渠道的部门、成员和角色，请先确认', {
        hint: '请求体需要带 confirm: true。',
      })
    }

    const current = findBinding(scope, provider)
    if (!current?.tenant_id) {
      throw new EabError(EC.CONFLICT, `本公司还没有绑定${providerLabel(provider)}`, {
        hint: '未绑定就无需解绑。',
      })
    }

    const result = executeChannelUnbind(deps.db, {
      companyId: scope.companyId,
      provider,
      actorUserId: subject.userId,
      ip: req.ip ?? null,
    })

    // 解绑已提交；连接刷新失败不影响数据库结果，只把状态带回控制台
    let streamRefreshFailed = false
    try {
      if (provider === 'feishu') await refreshFeishuStream(scope)
      if (provider === 'dingtalk') await refreshDingTalkStream(scope)
    } catch {
      streamRefreshFailed = true
    }

    return ok({ bindings: listBindings(scope), ...result, streamRefreshFailed })
  })
}
