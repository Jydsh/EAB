import type { FastifyInstance } from 'fastify'
import { EC, EabError, resolveVisibleCollections, SC, scopeAllows } from '@eab/domain'
import { loadKbCollectionAcls, sqliteBusyStats } from '@eab/storage'
import type { ServerDeps } from '../deps.js'
import { ensureDingTalkUserAvatar } from '../dingtalk-avatar.js'
import {
  companyAssistantView,
  readCompanyAssistantAvatar,
  resolveAssistantDataDir,
} from '../company-assistant.js'
import { isConsoleRequest, hasConsoleSession } from '../console-auth.js'
import { pluginToolSemaphore } from '../plugin-tools.js'
import { toolConcurrencyStats } from './tools.js'
import { activeAgentRunCount, cancelAgentRunTree, listAgentRuns } from '../agent-runtime.js'
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

function chatSendModeOf(value: unknown): 'queue' | 'interrupt' {
  return value === 'interrupt' ? 'interrupt' : 'queue'
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
    const capacity = deps.chatCapacity?.stats()
    const toolStats = toolConcurrencyStats()
    const pluginStats = pluginToolSemaphore.stats()
    const sqliteBusy = sqliteBusyStats().count
    const capacityLines = capacity
      ? [
          '# HELP eab_chat_turns_active 当前正在生成的对话 turn 数',
          '# TYPE eab_chat_turns_active gauge',
          `eab_chat_turns_active ${capacity.active}`,
          '# HELP eab_chat_turns_queued 排队等待对话 turn 的数量',
          '# TYPE eab_chat_turns_queued gauge',
          `eab_chat_turns_queued ${capacity.queued}`,
          ...capacity.models.flatMap((model) => [
            `eab_chat_model_turns_active{model="${model.modelId.replace(/["\\]/g, '_')}"} ${model.active}`,
            `eab_chat_model_turns_queued{model="${model.modelId.replace(/["\\]/g, '_')}"} ${model.queued}`,
          ]),
        ]
      : []
    const toolLines = [
      '# HELP eab_tool_active 当前正在执行的内置工具数',
      '# TYPE eab_tool_active gauge',
      `eab_tool_active ${toolStats.active}`,
      '# HELP eab_tool_queued 排队等待工具名额的数量',
      '# TYPE eab_tool_queued gauge',
      `eab_tool_queued ${toolStats.queued}`,
      '# HELP eab_tool_runs_total 工具执行次数',
      '# TYPE eab_tool_runs_total counter',
      `eab_tool_runs_total ${toolStats.runs}`,
      '# HELP eab_tool_failures_total 工具执行失败次数',
      '# TYPE eab_tool_failures_total counter',
      `eab_tool_failures_total ${toolStats.failures}`,
      '# HELP eab_tool_duration_ms_avg 工具平均执行耗时（毫秒）',
      '# TYPE eab_tool_duration_ms_avg gauge',
      `eab_tool_duration_ms_avg ${toolStats.avgDurationMs}`,
      '# HELP eab_tool_duration_ms_max 工具最大执行耗时（毫秒）',
      '# TYPE eab_tool_duration_ms_max gauge',
      `eab_tool_duration_ms_max ${toolStats.maxDurationMs}`,
      '# HELP eab_tool_lock_wait_ms_total 工具等待资源锁累计耗时（毫秒）',
      '# TYPE eab_tool_lock_wait_ms_total counter',
      `eab_tool_lock_wait_ms_total ${toolStats.lockWaitMs}`,
      '# HELP eab_plugin_tool_active 当前正在执行的插件工具数',
      '# TYPE eab_plugin_tool_active gauge',
      `eab_plugin_tool_active ${pluginStats.active}`,
      '# HELP eab_plugin_tool_queued 排队等待插件工具名额的数量',
      '# TYPE eab_plugin_tool_queued gauge',
      `eab_plugin_tool_queued ${pluginStats.queued}`,
      '# HELP eab_agent_runs_active 当前进程内仍在运行的多 Agent 节点数',
      '# TYPE eab_agent_runs_active gauge',
      `eab_agent_runs_active ${activeAgentRunCount()}`,
      '# HELP eab_sqlite_busy_total 事务遇到 SQLITE_BUSY 的次数',
      '# TYPE eab_sqlite_busy_total counter',
      `eab_sqlite_busy_total ${sqliteBusy}`,
    ]
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
      '# HELP eab_process_heap_used_bytes V8 已用堆内存',
      '# TYPE eab_process_heap_used_bytes gauge',
      `eab_process_heap_used_bytes ${memory.heapUsed}`,
      '# HELP eab_process_external_bytes V8 外部内存（Buffer 等）',
      '# TYPE eab_process_external_bytes gauge',
      `eab_process_external_bytes ${memory.external}`,
      '# HELP eab_process_active_resources 进程活跃资源数（定时器/句柄/请求）',
      '# TYPE eab_process_active_resources gauge',
      `eab_process_active_resources ${process.getActiveResourcesInfo().length}`,
      ...capacityLines,
      ...toolLines,
      '',
    ].join('\n')
    reply.type('text/plain; version=0.0.4; charset=utf-8')
    return reply.send(text)
  })

  app.get('/api/console/concurrency', async (req) => {
    if (!isConsoleRequest(req, deps.config)) {
      throw new EabError(EC.FORBIDDEN, '需要控制台登录后再查看并发状态')
    }
    const chat = deps.chatCapacity?.stats()
    const tools = toolConcurrencyStats()
    const plugins = pluginToolSemaphore.stats()
    return ok({
      updatedAt: new Date().toISOString(),
      chat: {
        active: chat?.active ?? 0,
        queued: chat?.queued ?? 0,
        users: chat?.users ?? 0,
        models: chat?.models ?? [],
        companies: chat?.companies ?? [],
        limits: {
          maxConcurrent: deps.config.chatMaxConcurrent ?? 8,
          queueLimit: deps.config.chatQueueLimit ?? 100,
          queueTimeoutMs: deps.config.chatQueueTimeoutMs ?? 240_000,
          userMaxInFlight: deps.config.chatUserMaxInFlight ?? 2,
          userMessagesPerMinute: deps.config.chatUserMessagesPerMinute ?? 20,
          modelMaxConcurrent: deps.config.chatModelMaxConcurrent ?? 4,
          companyMaxConcurrent: deps.config.chatCompanyMaxConcurrent ?? deps.config.chatMaxConcurrent ?? 8,
        },
      },
      tools: {
        ...tools,
        limits: {
          maxConcurrent: deps.config.toolMaxConcurrent ?? 8,
          queueLimit: deps.config.toolQueueLimit ?? 200,
          timeoutMs: deps.config.toolTimeoutMs ?? 30_000,
        },
      },
      plugins: {
        ...plugins,
        limits: {
          maxConcurrent: deps.config.pluginToolMaxConcurrent ?? 4,
          timeoutMs: deps.config.pluginToolTimeoutMs ?? 60_000,
        },
      },
      sqlite: { busyTotal: sqliteBusyStats().count },
    })
  })

  app.get('/api/console/agent-runs', async (req) => {
    if (!isConsoleRequest(req, deps.config)) {
      throw new EabError(EC.FORBIDDEN, '需要控制台登录后再查看 Agent 运行树')
    }
    const query = req.query as { limit?: string; sessionId?: string } | undefined
    const parsedLimit = Number(query?.limit ?? 50)
    return ok({
      active: activeAgentRunCount(),
      runs: listAgentRuns(deps.db, deps.companyId, {
        limit: Number.isFinite(parsedLimit) ? Math.floor(parsedLimit) : 50,
        sessionId: typeof query?.sessionId === 'string' && query.sessionId ? query.sessionId : undefined,
      }),
    })
  })

  app.post('/api/console/agent-runs/:id/cancel', async (req) => {
    if (!isConsoleRequest(req, deps.config)) {
      throw new EabError(EC.FORBIDDEN, '需要控制台登录后再取消 Agent 任务')
    }
    const id = (req.params as { id?: string } | undefined)?.id ?? ''
    if (!id) throw new EabError(EC.VALIDATION, '缺少运行 id')
    const cancelled = cancelAgentRunTree(deps.db, id, '控制台取消了任务')
    return ok({ cancelled, count: cancelled.length })
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
    const sendModeRow = deps.db
      .prepare('SELECT chat_send_mode FROM users WHERE id = ?')
      .get(person.id) as { chat_send_mode?: string | null } | undefined
    return ok({
      person,
      company: { id: person.companyId, name: person.companyName },
      assistant: companyAssistantView(deps.db, person.companyId),
      roles: [...subject.roles],
      dataScope: subject.dataScope,
      channelType: subject.channelType,
      capabilities: capabilityList(subject),
      passwordConfigured: passwordRow?.password_set_at != null,
      chatSendMode: chatSendModeOf(sendModeRow?.chat_send_mode),
    })
  })

  /** 个人对话偏好：回复中再发消息时排队，或直接打断当前回复。 */
  app.patch<{ Body: { chatSendMode?: unknown } }>('/api/me/chat-send-mode', async (req) => {
    const mode = req.body?.chatSendMode
    if (mode !== 'queue' && mode !== 'interrupt') {
      throw new EabError(EC.VALIDATION, 'chatSendMode 只能是 queue 或 interrupt')
    }
    const { person } = resolveActor(deps.db, deps.config, req, deps.companyId)
    deps.db
      .prepare('UPDATE users SET chat_send_mode = ?, updated_at = ? WHERE id = ? AND company_id = ?')
      .run(mode, Date.now(), person.id, person.companyId)
    return ok({ chatSendMode: mode })
  })

  /**
   * 公司助手头像：只按当前登录人的公司取，避免把任意文件路径带进接口。
   * URL 带 updatedAt 版本号，换图后前端缓存自动失效。
   */
  app.get('/api/company/assistant-avatar', async (req, reply) => {
    // 控制台「公司资料」也用同一个地址做预览；图片请求带不了自定义头，所以控制台只认会话 Cookie。
    const companyId = hasConsoleSession(req)
      ? deps.companyId
      : resolveActor(deps.db, deps.config, req, deps.companyId).person.companyId
    const avatar = readCompanyAssistantAvatar(
      deps.db,
      resolveAssistantDataDir(deps.config.dataDir, deps.config.dbPath),
      companyId,
    )
    if (!avatar) return reply.code(404).send()
    const etag = `"${avatar.updatedAt}"`
    if (req.headers['if-none-match'] === etag) return reply.code(304).send()
    reply
      .header('cache-control', 'private, max-age=31536000, immutable')
      .header('etag', etag)
      .type(avatar.mime)
    return reply.send(avatar.bytes)
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
