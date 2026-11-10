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
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { EC, EabError, toEabError } from '@eab/domain'
import type { ServerDeps } from './deps.js'
import { readVersion } from './http.js'
import { hasConsoleSession } from './console-auth.js'
import { registerAdminRoutes } from './routes/admin.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerChannelRoutes } from './routes/channel.js'
import { registerChatRoutes } from './routes/chat.js'
import { registerConsoleRoutes } from './routes/console.js'
import { registerKbRoutes } from './routes/kb.js'
import { registerLocalSpaceRoutes } from './routes/local-spaces.js'
import { registerMemoryRoutes } from './routes/memory.js'
import { registerOrgRoutes } from './routes/org.js'
import { registerOrgSyncRoutes } from './routes/org-sync.js'
import { registerPluginRoutes } from './routes/plugins.js'
import { registerQuotaRoutes } from './routes/quota.js'
import { registerSettingsRoutes } from './routes/settings.js'
import { registerScheduleRoutes } from './routes/schedules.js'
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
  'dsh-runtime.js': 'text/javascript; charset=utf-8',
  'vendor/react.production.min.js': 'text/javascript; charset=utf-8',
  'vendor/react-dom.production.min.js': 'text/javascript; charset=utf-8',
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
  const chatOnly = ['/chat', '/chat.html', '/chat.js', '/chat.css', '/api/chat', '/api/memories', '/api/workspace', '/api/local-spaces', '/api/schedules', '/api/auth']
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

function servePublic(name: string, reply: FastifyReply): FastifyReply {
  const publicDir = process.env.EAB_PUBLIC_DIR || fileURLToPath(new URL('../public', import.meta.url))
  const body = readFileSync(join(publicDir, name))
  reply.type(CONTENT_TYPES[name] ?? 'application/octet-stream')
  reply.header('cache-control', 'no-store')
  return reply.send(body)
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

export function buildApp(deps: ServerDeps, surface: AppSurface = 'all'): FastifyInstance {
  const app = Fastify({
    logger: { level: deps.config.logLevel },
  })

  installSurfaceGuard(app, surface)

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
     * 个人工作台的 DSH 插件页面宿主。
     * 页面本身不碰控制台接口：带 `scope=user` 时会走 `/api/my/plugins/:id/{host,rpc}`，
     * 所以员工端口也要能加载同一份 host 页与 React/DSH 运行时。
     */
    if (surface === 'chat') {
      app.get('/plugin-host.html', async (_req, reply) => servePublic('plugin-host.html', reply))
      app.get('/dsh-runtime.js', async (_req, reply) => servePublic('dsh-runtime.js', reply))
      app.get('/vendor/react.production.min.js', async (_req, reply) =>
        servePublic('vendor/react.production.min.js', reply),
      )
      app.get('/vendor/react-dom.production.min.js', async (_req, reply) =>
        servePublic('vendor/react-dom.production.min.js', reply),
      )
    }
  }

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
      servePublic('vendor/react.production.min.js', reply),
    )
    app.get('/vendor/react-dom.production.min.js', async (_req, reply) =>
      servePublic('vendor/react-dom.production.min.js', reply),
    )
  }

  app.get('/favicon.ico', async (_req, reply) => reply.code(204).send())

  // ---- API ----
  registerSystemRoutes(app, deps)
  registerAuthRoutes(app, deps)
  registerOrgRoutes(app, deps)
  registerChannelRoutes(app, deps)
  registerOrgSyncRoutes(app, deps)
  registerKbRoutes(app, deps)
  registerChatRoutes(app, deps)
  registerMemoryRoutes(app, deps)
  registerPluginRoutes(app, deps)
  registerConsoleRoutes(app, deps)
  registerAdminRoutes(app, deps)
  registerQuotaRoutes(app, deps)
  registerSettingsRoutes(app, deps)
  registerUpdateRoutes(app, deps)
  registerScheduleRoutes(app, deps)
  registerWorkspaceRoutes(app, deps)
  registerLocalSpaceRoutes(app, deps)
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
