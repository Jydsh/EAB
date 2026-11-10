import type { FastifyInstance } from 'fastify'
import { EC, EabError, resolveVisibleCollections, SC, scopeAllows } from '@eab/domain'
import { loadKbCollectionAcls } from '@eab/storage'
import type { ServerDeps } from '../deps.js'
import { ensureDingTalkUserAvatar } from '../dingtalk-avatar.js'
import { capabilityList, ok, readVersion } from '../http.js'
import { actorFor, listPersonas, resolveActor, roleCodesOf } from '../session.js'

/** 只代理钉钉自己的头像域名，避免把 users.avatar 当作任意 URL 去抓。 */
function isAllowedAvatarUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'dingtalk.com' || url.hostname.endsWith('.dingtalk.com'))
    )
  } catch {
    return false
  }
}

export function registerSystemRoutes(app: FastifyInstance, deps: ServerDeps): void {
  /**
   * 公开健康检查：只给"活着没、哪个版本"。
   * 库路径 / 迁移 / 控制台口令属于部署侧信息，只经环境变量与启动日志，不从任何接口回显。
   */
  app.get('/api/health', async () =>
    ok({
      version: readVersion(),
      uptimeSec: Math.round(process.uptime()),
      devAuth: deps.config.devAuth,
      host: deps.config.host,
      chatPort: deps.config.port,
      adminPort: deps.config.adminPort,
      allowRemoteConsole: deps.config.allowRemoteConsole,
      companyId: deps.companyId,
      singleCompany: true,
    }),
  )

  app.get('/healthz', async () => ok({ status: 'ok', version: readVersion() }))

  app.get('/readyz', async () => {
    deps.db.prepare('SELECT 1 AS ok').get()
    return ok({ status: 'ready', version: readVersion() })
  })

  /** Prometheus 文本格式指标（OPS-08）：库内计数 + 进程内存/运行时长 */
  app.get('/metrics', async (_req, reply) => {
    const users = Number((deps.db.prepare('SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL').get() as { n: number }).n)
    const chats = Number((deps.db.prepare('SELECT COUNT(*) AS n FROM chat_messages').get() as { n: number }).n)
    const audits = Number((deps.db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get() as { n: number }).n)
    const uptime = Math.round(process.uptime())
    const memory = process.memoryUsage()
    const text = [
      '# HELP eab_uptime_seconds 进程运行秒数',
      '# TYPE eab_uptime_seconds gauge',
      `eab_uptime_seconds ${uptime}`,
      '# HELP eab_users_total 有效成员数',
      '# TYPE eab_users_total gauge',
      `eab_users_total ${users}`,
      '# HELP eab_chat_messages_total 累计对话消息数',
      '# TYPE eab_chat_messages_total counter',
      `eab_chat_messages_total ${chats}`,
      '# HELP eab_audit_entries_total 累计审计条目数',
      '# TYPE eab_audit_entries_total counter',
      `eab_audit_entries_total ${audits}`,
      '# HELP eab_process_resident_memory_bytes 常驻内存',
      '# TYPE eab_process_resident_memory_bytes gauge',
      `eab_process_resident_memory_bytes ${memory.rss}`,
      '',
    ].join('\n')
    reply.type('text/plain; version=0.0.4; charset=utf-8')
    return reply.send(text)
  })

  app.get('/api/me', async (req) => {
    const { subject, person: basePerson } = resolveActor(deps.db, deps.config, req, deps.companyId)
    let person = basePerson
    /**
     * 老成员的组织同步跑在「加头像字段」之前，库里 avatar 还是 null。
     * 第一次打开工作台时补一次；成功后写库，后续请求不再打钉钉接口。
     */
    if (person.avatar === null) {
      const avatar = await ensureDingTalkUserAvatar(deps.db, deps.config.dbPath, person.companyId, person.id)
      if (avatar) person = { ...person, avatar }
    }
    const passwordRow = deps.db
      .prepare('SELECT password_set_at FROM users WHERE id = ?')
      .get(person.id) as { password_set_at?: number | null } | undefined
    return ok({
      person,
      company: { id: person.companyId, name: person.companyName },
      roles: [...subject.roles],
      dataScope: subject.dataScope,
      channelType: subject.channelType,
      capabilities: capabilityList(subject),
      passwordConfigured: passwordRow?.password_set_at != null,
    })
  })

  /**
   * 钉钉头像代理：浏览器直连 static-legacy.dingtalk.com 可能被防盗链/网络策略拦掉，
   * 由服务端按当前登录人取一次头像二进制再回给前端，前端只认同源的 /api/me/avatar。
   */
  app.get('/api/me/avatar', async (req, reply) => {
    const { person: basePerson } = resolveActor(deps.db, deps.config, req, deps.companyId)
    let avatar = basePerson.avatar
    if (avatar === null) {
      avatar = await ensureDingTalkUserAvatar(deps.db, deps.config.dbPath, basePerson.companyId, basePerson.id)
    }
    if (!avatar || !isAllowedAvatarUrl(avatar)) return reply.code(404).send()
    try {
      const response = await fetch(avatar, { signal: AbortSignal.timeout(10_000) })
      if (!response.ok) return reply.code(404).send()
      const type = response.headers.get('content-type') || 'image/jpeg'
      if (!type.startsWith('image/')) return reply.code(404).send()
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.byteLength > 5 * 1024 * 1024) return reply.code(404).send()
      reply.header('cache-control', 'private, max-age=86400').header('vary', 'Cookie').type(type)
      return reply.send(bytes)
    } catch (error) {
      req.log.warn({ err: error }, '读取钉钉头像失败')
      return reply.code(404).send()
    }
  })

  /** 开发预览：身份切换列表（单公司模式下只列唯一公司的成员） */
  app.get('/api/dev/personas', async () => {
    if (!deps.config.devAuth) throw new EabError(EC.NOT_FOUND, '未开放')
    const personas = listPersonas(deps.db, deps.companyId).map((person) => ({
      ...person,
      roles: roleCodesOf(deps.db, person.id),
    }))
    return ok({ personas })
  })

  /** 开发预览：视野矩阵（谁看得到哪个知识库），只画"当前身份那家公司" */
  app.get('/api/dev/kb-matrix', async (req) => {
    if (!deps.config.devAuth) throw new EabError(EC.NOT_FOUND, '未开放')

    const { subject } = resolveActor(deps.db, deps.config, req, deps.companyId)
    const companyId = subject.companyId

    const collections = loadKbCollectionAcls(deps.db, companyId)
    const libraryRows = deps.db
      .prepare(
        `SELECT id, name, acl_mode FROM kb_collections
          WHERE company_id = ? AND deleted_at IS NULL AND status = 'active'
          ORDER BY name`,
      )
      .all(companyId) as unknown as Array<{ id: string; name: string; acl_mode: string }>

    const personas = listPersonas(deps.db, companyId).map((person) => {
      const { subject: personSubject } = actorFor(deps.db, person)
      // 和真实接口同一条链：缺 kb:read 功能权限时一个库都不该出现，否则矩阵会骗人
      const canRead = scopeAllows(personSubject.scopes, SC.KB_READ)
      const visible = canRead ? resolveVisibleCollections(personSubject, collections) : new Set<string>()
      return {
        userId: person.id,
        name: person.name,
        deptName: person.deptName,
        roles: roleCodesOf(deps.db, person.id),
        blocked: canRead ? null : 'missing-scope',
        visibleCount: visible.size,
        visibleIds: [...visible],
      }
    })

    return ok({ collections: libraryRows, personas, companyId })
  })
}
