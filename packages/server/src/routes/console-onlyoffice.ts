/**
 * 控制台「在线文档」绑定接口（OnlyOffice DocumentServer）。
 *
 * 边界：
 * - URL / 内部回访地址属于普通配置，立即生效；
 * - JWT 密钥只写 secrets.json，接口只返回“已配置 / 来源”，不回显；
 * - 环境变量优先级高于控制台，存在时页面显示为锁定，避免控制台改动被静默覆盖。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { EC, EabError } from '@eab/domain'
import { appendAudit } from '@eab/storage'
import type { ServerDeps } from '../deps.js'
import { ok } from '../http.js'
import { isConsoleRequest } from '../console-auth.js'
import { deleteSecret, storeSecret } from '../secrets.js'
import { readConsoleSettings, writeConsoleSettings } from '../settings.js'
import { resolveOnlyOffice } from '../onlyoffice-runtime.js'

const SECRET_REF = 'EAB_ONLYOFFICE_JWT_SECRET'

function requireConsole(req: FastifyRequest, deps: ServerDeps): void {
  if (!isConsoleRequest(req, deps.config)) {
    throw new EabError(EC.AUTH_REQUIRED, '需要控制台会话（请先在 /admin 登录）')
  }
}

function normalizeBaseUrl(value: unknown, label: string): string | null {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new EabError(EC.VALIDATION, `${label}不是合法地址：${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new EabError(EC.VALIDATION, `${label}只支持 http/https：${raw}`)
  }
  if (url.search || url.hash) {
    throw new EabError(EC.VALIDATION, `${label}不能带查询参数或锚点：${raw}`)
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '')
}

function audit(deps: ServerDeps, req: FastifyRequest, action: string, detail: Record<string, unknown>): void {
  appendAudit(deps.db, {
    companyId: deps.companyId,
    actorUserId: 'console-operator',
    action,
    resourceType: 'console_settings',
    resourceId: 'onlyoffice',
    result: 'success',
    ip: req.ip,
    channel: 'console',
    detail: detail as never,
  })
}

function bindingView(deps: ServerDeps) {
  const runtime = resolveOnlyOffice(deps.config, deps.config.dbPath)
  const saved = readConsoleSettings().onlyOffice
  return {
    enabled: runtime.enabled,
    url: runtime.url,
    internalUrl: runtime.internalUrl,
    jwtSecretConfigured: Boolean(runtime.jwtSecret),
    urlSource: runtime.urlSource,
    internalUrlSource: runtime.internalUrlSource,
    secretSource: runtime.secretSource,
    envLocked: {
      url: Boolean(deps.config.onlyOfficeUrl),
      secret: Boolean(deps.config.onlyOfficeJwtSecret),
      internalUrl: Boolean((process.env.EAB_ONLYOFFICE_INTERNAL_URL ?? '').trim()),
    },
    defaultInternalUrl: `http://host.docker.internal:${deps.config.port}`,
    secretRef: saved.jwtSecretRef,
  }
}

/** 测试 DocumentServer：先试 /health，失败再试 api.js；只做连通性，不校验 JWT。 */
async function testDocumentServer(url: string): Promise<{
  ok: boolean
  endpoint: string
  status: number | null
  latencyMs: number
  detail: string
}> {
  const base = url.replace(/\/+$/, '')
  const candidates = [`${base}/health`, `${base}/web-apps/apps/api/documents/api.js`]
  const started = Date.now()
  let lastError = ''
  for (const endpoint of candidates) {
    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: { Accept: 'text/plain, text/javascript, application/javascript, */*' },
        signal: AbortSignal.timeout(8_000),
      })
      const body = (await response.text()).slice(0, 80).replace(/\s+/g, ' ').trim()
      if (response.ok) {
        return {
          ok: true,
          endpoint,
          status: response.status,
          latencyMs: Date.now() - started,
          detail: body ? `HTTP ${response.status} · ${body}` : `HTTP ${response.status}`,
        }
      }
      lastError = `HTTP ${response.status}`
    } catch (err) {
      lastError = (err as Error).message
    }
  }
  return {
    ok: false,
    endpoint: candidates[0],
    status: null,
    latencyMs: Date.now() - started,
    detail: lastError || '无法连接 DocumentServer',
  }
}

export function registerConsoleOnlyOfficeRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get('/api/console/onlyoffice', async (req) => {
    requireConsole(req, deps)
    return ok(bindingView(deps))
  })

  app.put<{
    Body: {
      url?: string
      internalUrl?: string
      jwtSecret?: string
      clearSecret?: boolean
    }
  }>('/api/console/onlyoffice', async (req) => {
    requireConsole(req, deps)
    const env = bindingView(deps).envLocked
    if (env.url && req.body?.url !== undefined) {
      throw new EabError(EC.VALIDATION, '文档服务地址由环境变量 EAB_ONLYOFFICE_URL 锁定，控制台不能修改')
    }
    if (env.secret && (req.body?.jwtSecret !== undefined || req.body?.clearSecret)) {
      throw new EabError(EC.VALIDATION, 'JWT 密钥由环境变量 EAB_ONLYOFFICE_JWT_SECRET 锁定，控制台不能修改')
    }
    if (env.internalUrl && req.body?.internalUrl !== undefined) {
      throw new EabError(EC.VALIDATION, '内部回访地址由环境变量 EAB_ONLYOFFICE_INTERNAL_URL 锁定，控制台不能修改')
    }
    const current = readConsoleSettings().onlyOffice
    const url =
      req.body?.url === undefined ? current.url : normalizeBaseUrl(req.body.url, '文档服务地址')
    const internalUrl =
      req.body?.internalUrl === undefined
        ? current.internalUrl
        : normalizeBaseUrl(req.body.internalUrl, '内部回访地址')

    let jwtSecretRef = current.jwtSecretRef
    if (req.body?.clearSecret) {
      deleteSecret(deps.config.dbPath, jwtSecretRef ?? SECRET_REF)
      jwtSecretRef = null
    } else if (req.body?.jwtSecret?.trim()) {
      jwtSecretRef = storeSecret(deps.config.dbPath, SECRET_REF, req.body.jwtSecret.trim(), SECRET_REF)
    }

    writeConsoleSettings({ onlyOffice: { url, internalUrl, jwtSecretRef } })
    const runtime = resolveOnlyOffice(deps.config, deps.config.dbPath)
    audit(deps, req, 'onlyoffice.binding.update', {
      url: url ?? '',
      internalUrl: internalUrl ?? '',
      secretConfigured: Boolean(jwtSecretRef),
      enabled: runtime.enabled,
    })
    return ok(bindingView(deps))
  })

  app.post<{ Body: { url?: string; jwtSecret?: string } }>('/api/console/onlyoffice/test', async (req) => {
    requireConsole(req, deps)
    const runtime = resolveOnlyOffice(deps.config, deps.config.dbPath)
    const url =
      req.body?.url === undefined
        ? runtime.url
        : normalizeBaseUrl(req.body.url, '文档服务地址') ?? ''
    if (!url) throw new EabError(EC.VALIDATION, '请先填写文档服务地址')
    const result = await testDocumentServer(url)
    audit(deps, req, 'onlyoffice.binding.test', {
      endpoint: result.endpoint,
      ok: result.ok,
      status: result.status,
      latencyMs: result.latencyMs,
    })
    return ok({ result })
  })
}
