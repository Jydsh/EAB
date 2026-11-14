/**
 * Fastify 装配（T-04）。
 *
 * 这一层只做三件事：
 * 1. 统一响应信封（成功 `{ok:true,data}` / 失败 `{ok:false,code,...}`，见 domain 的 EabError）
 * 2. 统一错误处理（永远不把裸 Error / 500 细节暴露给页面）
 * 3. 静态页面（开发期直接读盘，改页面刷新即可，不需要构建）
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { EC, EabError, toEabError } from '@eab/domain'
import type { ServerDeps } from './deps.js'
import { createChatCapacity } from './chat-capacity.js'
import { readVersion } from './http.js'
import { hasConsoleSession, configureConsoleAuth } from './console-auth.js'
import { initChatEventBridge } from './chat-events.js'
import { initRealtimeControl } from './realtime-control.js'
import { getBackendRuntime } from './backends/runtime.js'
import { readSessionUserId } from './employee-session.js'
import { findActivePerson } from './session.js'
import { registerAdminRoutes } from './routes/admin.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerChannelRoutes } from './routes/channel.js'
import { registerChatRoutes } from './routes/chat.js'
import { registerConsoleRoutes } from './routes/console.js'
import { registerConsoleDatabaseRoutes } from './routes/console-databases.js'
import { registerConsoleOnlyOfficeRoutes } from './routes/console-onlyoffice.js'
import { registerConsoleScheduleRoutes } from './routes/console-schedules.js'
import { registerKbRoutes } from './routes/kb.js'
import { registerMemoryRoutes } from './routes/memory.js'
import { registerOrgRoutes } from './routes/org.js'
import { registerOrgSyncRoutes } from './routes/org-sync.js'
import { registerPluginRoutes } from './routes/plugins.js'
import { registerQuotaRoutes } from './routes/quota.js'
import { registerSettingsRoutes } from './routes/settings.js'
import { registerScheduleRoutes } from './routes/schedules.js'
import { registerSkillRoutes } from './routes/skills.js'
import { registerSystemRoutes } from './routes/system.js'
import { registerToolRoutes } from './routes/tools.js'
import { registerUpdateRoutes } from './routes/update.js'
import { registerWorkspaceRoutes } from './routes/workspace.js'

const CONTENT_TYPES: Record<string, string> = {
  'index.html': 'text/html; charset=utf-8',
  'admin-gate.html': 'text/html; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'app.css': 'text/css; charset=utf-8',
  'chat.html': 'text/html; charset=utf-8',
  'chat.js': 'text/javascript; charset=utf-8',
  'chat.css': 'text/css; charset=utf-8',
  'plugin-host.html': 'text/html; charset=utf-8',
  'plugin-kernel.html': 'text/html; charset=utf-8',
  'dsh-runtime.js': 'text/javascript; charset=utf-8',
  'plugin-kernel-lab.html': 'text/html; charset=utf-8',
  'vendor/react.production.min.js': 'text/javascript; charset=utf-8',
  'vendor/react-dom.production.min.js': 'text/javascript; charset=utf-8',
}

/** 静态文件按扩展名兜底；显式表优先，避免新增 lab 文件时反复补白名单。 */
const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
}

/** 服务面：员工对话页 / 管理控制台。`all` 只给测试与老装配用。 */
export type AppSurface = 'all' | 'chat' | 'console'

function isPath(path: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(prefix))
}

/**
 * 两个端口不是"同一个服务换了个 URL"，而是两套入口：
 * - 对话端口不暴露任何 `/api/console/*` 与管理页；
 * - 管理端口不暴露 `/chat`、员工对话接口、记忆、工作区。
 * 这样即使浏览器同时有两个 Cookie，也不会从对话页调到管理接口。
 */
function installSurfaceGuard(app: FastifyInstance, surface: AppSurface): void {
  if (surface === 'all') return
  const consoleOnly = ['/admin', '/admin.html', '/app.js', '/api/console']
  const chatOnly = ['/chat', '/chat.html', '/chat.js', '/chat.css', '/api/chat', '/api/memories', '/api/workspace', '/api/schedules', '/api/auth']
  app.addHook('onRequest', async (req, reply) => {
    const path = (req.raw.url ?? '').split('?')[0] ?? ''
    if (surface === 'chat' && isPath(path, consoleOnly)) {
      return reply.code(404).send({
        ok: false,
        code: 'EAB_NOT_FOUND',
        message: `这是员工对话端口，不提供管理接口：${req.method} ${path}。管理控制台请访问另一个端口。`,
      })
    }
    if (surface === 'console' && isPath(path, chatOnly)) {
      return reply.code(404).send({
        ok: false,
        code: 'EAB_NOT_FOUND',
        message: `这是管理控制台端口，不提供员工对话入口：${req.method} ${path}。员工工作台请访问另一个端口。`,
      })
    }
  })
}

/**
 * 大请求体在 Fastify 解析前就按 Content-Length 记账，避免几十个 60MB 附件
 * 同时被读进内存。预算按“声明大小之和”粗算；base64/JSON 的实际开销更高，
 * 所以这里故意留了余量。
 */
function installBodyBudgetGuard(app: FastifyInstance, deps: ServerDeps): void {
  const budgetBytes = (deps.config.maxInflightBodyMb ?? 256) * 1024 * 1024
  let inflightBytes = 0
  const reservations = new WeakMap<FastifyRequest, () => void>()

  app.addHook('onRequest', async (req, reply) => {
    const header = req.headers['content-length']
    if (header === undefined) return
    const bytes = Number(Array.isArray(header) ? header[0] : header)
    if (!Number.isFinite(bytes) || bytes <= 0) return
    if (bytes > budgetBytes || inflightBytes + bytes > budgetBytes) {
      throw new EabError(EC.RATE_LIMITED, '当前同时上传或提交的数据太多，请稍后重试', {
        hint: `同时在内存中的请求体预算约 ${Math.round(budgetBytes / 1024 / 1024)}MB`,
        details: { inflightBytes, requestBytes: bytes, budgetBytes },
      })
    }

    inflightBytes += bytes
    let released = false
    const release = () => {
      if (released) return
      released = true
      inflightBytes = Math.max(0, inflightBytes - bytes)
    }
    reservations.set(req, release)
    // 客户端中途断开时 onResponse 不一定触发，这里兜底。
    reply.raw.once('close', release)
  })

  app.addHook('onResponse', async (req) => {
    reservations.get(req)?.()
  })
}

function servePublic(name: string, reply: FastifyReply, cacheControl = 'no-store'): FastifyReply {
  const publicDir = process.env.EAB_PUBLIC_DIR || fileURLToPath(new URL('../public', import.meta.url))
  const body = readFileSync(join(publicDir, name))
  reply.type(CONTENT_TYPES[name] ?? EXTENSION_CONTENT_TYPES[extname(name)] ?? 'application/octet-stream')
  reply.header('cache-control', cacheControl)
  return reply.send(body)
}

/** 只允许读取 lab 自己的静态目录，避免把整个 public 变成通配静态站。 */
function serveKernelVendor(file: string, reply: FastifyReply): FastifyReply {
  if (!/^[A-Za-z0-9._-]+\.(?:js|css)$/u.test(file)) {
    return reply.code(404).send({ ok: false, code: 'EAB_NOT_FOUND', message: 'unknown kernel asset' })
  }
  // 内核 vendor 是共享静态资源：每次都 no-store 会让每个插件 iframe 重新下载
  // primitives.js（约 4.2MB）和 CSS，点击插件页面时体感就是“一直在准备内核”。
  // 用私有缓存 + 1 小时有效期；插件页/控制台 HTML 仍保持 no-store。
  return servePublic(`vendor/dsh-kernel/${file}`, reply, 'private, max-age=3600, must-revalidate')
}

function toChat(req: FastifyRequest, reply: FastifyReply): FastifyReply {
  const raw = req.query as Record<string, unknown> | undefined
  const as = typeof raw?.as === 'string' && raw.as ? raw.as : ''
  const target = as ? `/chat?as=${encodeURIComponent(as)}` : '/chat'
  reply.header('cache-control', 'no-store')
  return reply.redirect(target, 302)
}

/** 控制台页面门：浏览器登录过超级管理员会话才放行；服务令牌只用于脚本接口。 */
function consoleAuthorized(req: FastifyRequest): boolean {
  return hasConsoleSession(req)
}

/**
 * 插件页入口门。
 * 插件页是独立 HTML，不能只靠前端传的 `scope`：直接打开时也必须按
 * 员工 Cookie 或控制台 Cookie 校验；未登录的 scope 分别回员工登录页 /
 * 管理员登录门，已登录但身份不匹配的返回 403，不泄露另一身份的插件数据。
 */
function pluginPageGate(
  req: FastifyRequest,
  reply: FastifyReply,
  config: { companyId: string },
  db: ServerDeps['db'],
): FastifyReply {
  const query = (req.query ?? {}) as Record<string, unknown>
  const scope = typeof query.scope === 'string' ? query.scope : 'console'
  const company = typeof query.company === 'string' ? query.company : ''
  if (company && company !== config.companyId) {
    return reply
      .code(403)
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send('<!doctype html><meta charset="utf-8"><title>插件页不可用</title><p>插件页不属于当前公司。</p>')
  }
  if (scope !== 'user') {
    return consoleAuthorized(req) ? servePublic('plugin-kernel.html', reply) : servePublic('admin-gate.html', reply)
  }
  const sessionUserId = readSessionUserId(db, req)
  if (!sessionUserId) {
    const loginQuery = company
      ? `?company=${encodeURIComponent(company)}&login=1`
      : '?login=1'
    reply.header('cache-control', 'no-store')
    return reply.redirect(`/chat${loginQuery}`, 302)
  }
  const person = findActivePerson(db, sessionUserId)
  if (!person || person.companyId !== config.companyId) {
    return reply
      .code(403)
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send('<!doctype html><meta charset="utf-8"><title>插件页不可用</title><p>当前员工身份不能打开该插件页。</p>')
  }
  const requestedAs = typeof query.as === 'string' ? query.as : ''
  if (requestedAs && requestedAs !== sessionUserId) {
    return reply
      .code(403)
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send('<!doctype html><meta charset="utf-8"><title>插件页不可用</title><p>插件页身份与当前登录身份不一致。</p>')
  }
  return servePublic('plugin-kernel.html', reply)
}

export const MAX_ROUTE_PARAM_LENGTH = 1024

export function buildApp(deps: ServerDeps, surface: AppSurface = 'all'): FastifyInstance {
  // 控制台会话是签名 Cookie：先把当前管理员密码登记成签名密钥，
  // 这样多实例/重启后彼此的 Cookie 都认，改密码时旧 Cookie 自动失效。
  configureConsoleAuth(deps.config)
  // 配了 Redis 的话，SSE 的实时事件同时跨实例广播；没配就是纯进程内。
  initChatEventBridge(getBackendRuntime()?.pubsub ?? null)
  // 「停止生成 / 取消 Agent 任务树」跨实例转发，同样只在接了 Redis 时生效。
  initRealtimeControl(getBackendRuntime()?.pubsub ?? null, deps.db)
  const app = Fastify({
    logger: { level: deps.config.logLevel },
    // OnlyOffice 内容/回调令牌约 300+ 字符，Fastify 默认 100 会在进入路由前返回 414。
    routerOptions: { maxParamLength: MAX_ROUTE_PARAM_LENGTH },
  })

  installSurfaceGuard(app, surface)
  installBodyBudgetGuard(app, deps)

  const runtimeDeps: ServerDeps = deps.chatCapacity
    ? deps
    : {
        ...deps,
        chatCapacity: createChatCapacity({
          maxConcurrent: deps.config.chatMaxConcurrent ?? 8,
          queueLimit: deps.config.chatQueueLimit ?? 100,
          queueTimeoutMs: deps.config.chatQueueTimeoutMs ?? 240_000,
          maxInFlightPerUser: deps.config.chatUserMaxInFlight ?? 0,
          messagesPerMinute: deps.config.chatUserMessagesPerMinute ?? 20,
          modelMaxConcurrent: deps.config.chatModelMaxConcurrent ?? 4,
          companyMaxConcurrent: deps.config.chatCompanyMaxConcurrent ?? deps.config.chatMaxConcurrent ?? 8,
        }),
      }

  app.addHook('onSend', async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.header('x-eab-version', readVersion())
  })

  // ---- 页面 ----
  /**
   * 员工入口就是对话。`/` 不再落到管理控制台：
   * 员工登录后只应该看到对话页，组织/权限/渠道是服务器侧管理员的事（12.8）。
   */
  if (surface === 'all' || surface === 'chat') {
    app.get('/', async (req, reply) => toChat(req, reply))
    app.get('/index.html', async (req, reply) => toChat(req, reply))
    app.get('/chat', async (_req, reply) => servePublic('chat.html', reply))
    app.get('/chat.html', async (_req, reply) => servePublic('chat.html', reply))
    app.get('/chat.js', async (_req, reply) => servePublic('chat.js', reply))
    app.get('/chat.css', async (_req, reply) => servePublic('chat.css', reply))
    // 设计令牌与共享组件都在 app.css；对话页只读这份静态样式，不因此获得任何管理接口。
    app.get('/app.css', async (_req, reply) => servePublic('app.css', reply))
    /**
     * EAB OnlyOffice 插件静态资源。
     * 只放行插件自己的三个文件，不把 public 变成通配静态站；config.json 走
     * `/api/workspace/office/plugin/config` 动态签发，不在这里暴露。
     */
    const onlyOfficePluginAssets = new Set(['index.html', 'plugin.js', 'icon.png'])
    app.get<{ Params: { file: string } }>('/onlyoffice-plugin/:file', async (req, reply) => {
      const file = req.params.file
      if (!onlyOfficePluginAssets.has(file)) {
        return reply.code(404).send({ ok: false, code: 'EAB_NOT_FOUND', message: 'unknown onlyoffice plugin asset' })
      }
      return servePublic(`onlyoffice-plugin/${file}`, reply, 'no-store')
    })
    /**
     * 个人工作台的 DSH 插件页面宿主。
     * 页面本身不碰控制台接口：带 `scope=user` 时会走 `/api/my/plugins/:id/{host,rpc}`，
     * 所以员工端口也要能加载同一份 host 页与 React/DSH 运行时。
     */
    if (surface === 'chat') {
      app.get('/plugin-host.html', async (_req, reply) => servePublic('plugin-host.html', reply))
      app.get('/dsh-runtime.js', async (_req, reply) => servePublic('dsh-runtime.js', reply))
      app.get('/vendor/react.production.min.js', async (_req, reply) =>
        servePublic('vendor/react.production.min.js', reply, 'private, max-age=3600, must-revalidate'),
      )
      app.get('/vendor/react-dom.production.min.js', async (_req, reply) =>
        servePublic('vendor/react-dom.production.min.js', reply, 'private, max-age=3600, must-revalidate'),
      )
    }
  }

  // Phase 0 插件内核原型：只服务 lab 页面和它自己的内核静态文件。
  app.get('/plugin-kernel-lab.html', async (_req, reply) => servePublic('plugin-kernel-lab.html', reply))
  // 正式插件页：官方 Cordis + slots + renderer 内核；员工端与控制台共用同一份页面。
  // 入口必须校验对应 scope 的会话，不能只信查询参数里的 scope。
  app.get('/plugin-kernel.html', async (req, reply) =>
    pluginPageGate(req, reply, deps.config, deps.db),
  )
  app.get('/vendor/dsh-kernel/:file', async (req, reply) =>
    serveKernelVendor((req.params as { file: string }).file, reply),
  )

  /**
   * 管理控制台是服务器侧的管理面，不登录任何组织成员：
   * 有控制台口令才出页面，没有就先出"输入口令"的门（不是员工登录）。
   */
  if (surface === 'all' || surface === 'console') {
    const adminPage = async (req: FastifyRequest, reply: FastifyReply) =>
      consoleAuthorized(req) ? servePublic('index.html', reply) : servePublic('admin-gate.html', reply)
    if (surface === 'console') app.get('/', async (_req, reply) => reply.redirect('/admin', 302))
    app.get('/admin', adminPage)
    app.get('/admin.html', adminPage)
    app.get('/app.js', async (_req, reply) => servePublic('app.js', reply))
    app.get('/app.css', async (_req, reply) => servePublic('app.css', reply))
    // DSH 插件页面宿主：独立的 iframe 页面 + React UMD + DSH client 兼容运行时
    app.get('/plugin-host.html', async (_req, reply) => servePublic('plugin-host.html', reply))
    app.get('/dsh-runtime.js', async (_req, reply) => servePublic('dsh-runtime.js', reply))
    app.get('/vendor/react.production.min.js', async (_req, reply) =>
      servePublic('vendor/react.production.min.js', reply, 'private, max-age=3600, must-revalidate'),
    )
    app.get('/vendor/react-dom.production.min.js', async (_req, reply) =>
      servePublic('vendor/react-dom.production.min.js', reply, 'private, max-age=3600, must-revalidate'),
    )
  }

  app.get('/favicon.ico', async (_req, reply) => reply.code(204).send())

  // ---- API ----
  registerSystemRoutes(app, runtimeDeps)
  registerAuthRoutes(app, deps)
  registerOrgRoutes(app, deps)
  registerChannelRoutes(app, deps)
  registerOrgSyncRoutes(app, deps)
  registerKbRoutes(app, deps)
  registerChatRoutes(app, runtimeDeps)
  registerMemoryRoutes(app, deps)
  registerPluginRoutes(app, deps)
  registerSkillRoutes(app, deps)
  registerConsoleRoutes(app, deps)
  registerConsoleDatabaseRoutes(app, deps)
  registerConsoleOnlyOfficeRoutes(app, deps)
  registerConsoleScheduleRoutes(app, deps)
  registerAdminRoutes(app, deps)
  registerQuotaRoutes(app, deps)
  registerSettingsRoutes(app, deps)
  registerUpdateRoutes(app, deps)
  registerScheduleRoutes(app, deps)
  registerWorkspaceRoutes(app, deps)
  registerToolRoutes(app, deps)

  app.setNotFoundHandler((req, reply) => {
    const err = new EabError(EC.NOT_FOUND, `接口不存在: ${req.method} ${req.url}`)
    reply.code(404).send(err.toEnvelope())
  })

  app.setErrorHandler((error, req, reply) => {
    const traceId = randomUUID()
    const eab = toEabError(error)
    if (eab.code === EC.INTERNAL) {
      req.log.error({ err: error, traceId }, '未预期的内部错误')
    } else {
      req.log.info({ code: eab.code, traceId, path: req.url }, '请求被拒绝')
    }
    reply.code(eab.httpStatus).header('x-trace-id', traceId).send(eab.toEnvelope(traceId))
  })

  return app
}
