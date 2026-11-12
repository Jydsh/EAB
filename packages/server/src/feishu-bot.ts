/**
 * 飞书机器人入站 → EAB 对话。
 *
 * 两条通道共用这一份处理逻辑：
 * - 长连接（WSClient）：本地/无公网部署的默认方式，EAB 主动连飞书开放平台；
 * - HTTP 事件回调：有公网 HTTPS 域名时可选。
 *
 * 关键约束：
 * 1. 飞书租户没有组织架构、发送者没有 channel_identities 时，不能静默丢弃消息；
 *    没有飞书通讯录的公司按 open_id 自动建一个 EAB 成员，保证机器人仍能回复。
 * 2. 回复与网页工作台共用 chat_sessions / chat_messages，历史同源。
 * 3. 只处理飞书自己的渠道配置，不读写钉钉/企业微信的渠道行。
 */
import { createHash, randomUUID } from 'node:crypto'
import { ulid } from '@eab/domain'
import { appendAudit, type Db } from '@eab/storage'
import { actorFor, findPerson, type RequestActor } from './session.js'
import type { ServerDeps } from './deps.js'
import { resolveSecret } from './secrets.js'
import type { ChatMessage as LlmMessage } from './llm.js'
import {
  acquireTurn,
  buildSystemPrompt,
  bumpUsage,
  ensureChannelSession,
  historyOf,
  loadModelCatalog,
  releaseTurn,
  retrieveKb,
  runAgentTurn,
  visibleModelsFor,
  type AgentTurnResult,
} from './routes/chat.js'
import { assertChatQuota } from './quota.js'
import { planChannelModelCommand } from './channel-model-command.js'
import { publishChatEvent } from './chat-events.js'
import { pluginPromptTexts } from './plugin-tools.js'
import { toolSpecsForAgent } from './routes/tools.js'

/* ---------------- 配置与连接状态 ---------------- */

interface FeishuChannelRow {
  app_id: string | null
  secret_ref: string | null
  tenant_id: string | null
  tenant_name: string | null
  status: string | null
  enabled: number | null
}

interface FeishuStreamState {
  client: FeishuWsClientLike | null
  apiClient: any
  appId: string | null
  secretRef: string | null
  startedAt: number | null
  lastAttemptAt: number | null
  lastConnectedAt: number | null
  lastEventAt: number | null
  lastReplyAt: number | null
  connected: boolean
  registered: boolean
  error: string | null
}

interface FeishuWsClientLike {
  start: (params: { eventDispatcher: any }) => Promise<void>
  close: (params?: { force?: boolean }) => void
  getConnectionStatus?: () => { state?: string }
}

const streamState: FeishuStreamState = {
  client: null,
  apiClient: null,
  appId: null,
  secretRef: null,
  startedAt: null,
  lastAttemptAt: null,
  lastConnectedAt: null,
  lastEventAt: null,
  lastReplyAt: null,
  connected: false,
  registered: false,
  error: null,
}

export interface FeishuSetupCheck {
  readonly checkedAt: number
  readonly ok: boolean
  readonly appName: string | null
  readonly appStatus: number | null
  readonly onlineVersionId: string | null
  readonly callbackType: string | null
  readonly subscribedEvents: readonly string[]
  readonly missingEvents: readonly string[]
  readonly missingScopes: readonly string[]
  readonly issues: readonly string[]
  readonly error: string | null
}

let setupCheckCache: { at: number; value: FeishuSetupCheck } | null = null

/**
 * 飞书自检：不只检查“长连接有没有连上”，还要查开放平台里到底订阅了哪些事件、
 * 授了哪些权限。长连接连上但没订阅 im.message.receive_v1 时，事件永远不会推过来。
 */
export async function checkFeishuSetup(deps: ServerDeps, force = false): Promise<FeishuSetupCheck> {
  const now = Date.now()
  if (!force && setupCheckCache && now - setupCheckCache.at < 60_000) return setupCheckCache.value
  const cfg = feishuConfig(deps.db, deps.companyId)
  const empty = (error: string): FeishuSetupCheck => ({
    checkedAt: now,
    ok: false,
    appName: cfg?.tenant_name ?? null,
    appStatus: null,
    onlineVersionId: null,
    callbackType: null,
    subscribedEvents: [],
    missingEvents: [],
    missingScopes: [],
    issues: [],
    error,
  })
  if (!cfg?.app_id || !cfg.secret_ref) {
    return finishSetupCheck(empty('飞书渠道还没有配置 App ID / App Secret。'))
  }
  const secret = resolveSecret(deps.config.dbPath, cfg.secret_ref)
  if (!secret) {
    return finishSetupCheck(empty('飞书渠道密钥缺失，请重新保存 App Secret。'))
  }
  try {
    const tokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: cfg.app_id, app_secret: secret }),
      signal: AbortSignal.timeout(10_000),
    })
    const tokenBody = (await tokenRes.json()) as { code?: number; msg?: string; tenant_access_token?: string }
    if (!tokenBody.tenant_access_token) {
      return finishSetupCheck(
        empty(`飞书自检失败：${tokenBody.msg || `HTTP ${tokenRes.status}`}（请检查 App ID/App Secret 是否匹配当前应用）`),
      )
    }
    const appRes = await fetch(
      `https://open.feishu.cn/open-apis/application/v6/applications/${encodeURIComponent(cfg.app_id)}?lang=zh_cn`,
      {
        headers: { authorization: `Bearer ${tokenBody.tenant_access_token}` },
        signal: AbortSignal.timeout(10_000),
      },
    )
    const appBody = (await appRes.json()) as {
      code?: number
      msg?: string
      data?: {
        app?: {
          app_name?: string
          status?: number
          online_version_id?: string
          scopes?: Array<{ scope?: string }>
          callback_info?: { callback_type?: string; subscribed_callbacks?: string[] }
        }
      }
    }
    const app = appBody.data?.app
    if (appBody.code !== 0 || !app) {
      return finishSetupCheck(empty(`飞书自检失败：${appBody.msg || `HTTP ${appRes.status}`}`))
    }
    const scopes = (app.scopes ?? []).map((item) => item.scope ?? '').filter(Boolean)
    const subscribedEvents = app.callback_info?.subscribed_callbacks ?? []
    const callbackType = app.callback_info?.callback_type ?? null

    const hasSendScope = scopes.includes('im:message') || scopes.includes('im:message:send_as_bot')
    const hasReceiveScope =
      scopes.includes('im:message') ||
      scopes.includes('im:message.p2p_msg:readonly') ||
      scopes.includes('im:message.group_at_msg:readonly')
    const hasGroupScope =
      scopes.includes('im:message') ||
      scopes.includes('im:message.group_at_msg:readonly') ||
      scopes.includes('im:message.group_at_msg.include_bot:readonly')
    const missingScopes = [
      ...(hasSendScope ? [] : ['im:message:send_as_bot']),
      ...(hasReceiveScope ? [] : ['im:message.p2p_msg:readonly']),
      ...(hasGroupScope ? [] : ['im:message.group_at_msg:readonly']),
    ]
    const missingEvents = subscribedEvents.includes('im.message.receive_v1') ? [] : ['im.message.receive_v1']
    const issues: string[] = []
    if (missingEvents.length > 0) {
      issues.push(
        `飞书应用没有订阅“接收消息”事件 im.message.receive_v1（当前订阅：${subscribedEvents.length ? subscribedEvents.join('、') : '无'}）。到开放平台「事件与回调 → 事件订阅」添加 im.message.receive_v1，保存并发布版本。`,
      )
    }
    if (missingScopes.length > 0) {
      issues.push(`缺少发消息/收消息权限：${missingScopes.join('、')}。在「权限管理」添加后重新发布版本。`)
    }
    if (callbackType && callbackType !== 'websocket') {
      issues.push(`事件接收方式当前是 ${callbackType}，本地 127.0.0.1 部署应改为「长连接」。`)
    }
    if (!app.online_version_id) {
      issues.push('应用没有已发布版本；机器人能力与事件订阅只有在发布后才对用户生效。')
    }
    return finishSetupCheck({
      checkedAt: now,
      ok: issues.length === 0,
      appName: app.app_name ?? cfg.tenant_name ?? null,
      appStatus: app.status ?? null,
      onlineVersionId: app.online_version_id ?? null,
      callbackType,
      subscribedEvents,
      missingEvents,
      missingScopes,
      issues,
      error: null,
    })
  } catch (error) {
    return finishSetupCheck(empty(`飞书自检请求失败：${(error as Error).message}`))
  }
}

function finishSetupCheck(value: FeishuSetupCheck): FeishuSetupCheck {
  setupCheckCache = { at: value.checkedAt, value }
  return value
}


export interface FeishuStreamStatus {
  readonly running: boolean
  readonly appId: string | null
  readonly startedAt: number | null
  readonly connected: boolean
  readonly registered: boolean
  readonly lastConnectedAt: number | null
  readonly lastAttemptAt: number | null
  readonly lastEventAt: number | null
  readonly lastReplyAt: number | null
  readonly error: string | null
}

export function feishuStreamStatus(): FeishuStreamStatus {
  // SDK 自带的连接状态比回调布尔值更可靠；轮询/巡检时用它校正。
  const sdkState = streamState.client?.getConnectionStatus?.().state
  const connected = sdkState ? sdkState === 'connected' : streamState.connected
  return {
    running: Boolean(streamState.client),
    appId: streamState.appId,
    startedAt: streamState.startedAt,
    connected,
    registered: streamState.registered,
    lastConnectedAt: streamState.lastConnectedAt,
    lastAttemptAt: streamState.lastAttemptAt,
    lastEventAt: streamState.lastEventAt,
    lastReplyAt: streamState.lastReplyAt,
    error: streamState.error,
  }
}

function feishuConfig(db: Db, companyId: string): FeishuChannelRow | undefined {
  return db
    .prepare(
      `SELECT app_id, secret_ref, tenant_id, tenant_name, status, enabled
         FROM channel_configs WHERE company_id = ? AND provider = 'feishu'`,
    )
    .get(companyId) as FeishuChannelRow | undefined
}

let refreshPromise: Promise<void> | null = null

/** 启动/重建飞书长连接。绑定换应用后调用它即可切换凭证，不必重启整个服务。 */
export function refreshFeishuStream(deps: ServerDeps): Promise<void> {
  if (refreshPromise) return refreshPromise
  refreshPromise = doRefreshFeishuStream(deps).finally(() => {
    refreshPromise = null
  })
  return refreshPromise
}

async function doRefreshFeishuStream(deps: ServerDeps): Promise<void> {
  const cfg = feishuConfig(deps.db, deps.companyId)
  streamState.lastAttemptAt = Date.now()
  if (!cfg?.app_id || !cfg.secret_ref || cfg.status !== 'bound') {
    stopFeishuStream()
    streamState.error = '飞书渠道未满足长连接启动条件（需已绑定且填写 App ID/App Secret）'
    return
  }
  const secret = resolveSecret(deps.config.dbPath, cfg.secret_ref)
  if (!secret) {
    stopFeishuStream()
    streamState.error = `飞书渠道密钥缺失：${cfg.secret_ref} 未配置，请重新保存 App Secret`
    console.warn(`[eab] 飞书长连接未启动：${streamState.error}`)
    return
  }

  if (streamState.client && streamState.appId === cfg.app_id) {
    const sdkState = streamState.client.getConnectionStatus?.().state
    if (sdkState === 'connected' || sdkState === 'connecting' || sdkState === 'reconnecting') return
    if (streamState.connected && !sdkState) return
  }

  stopFeishuStream()
  const Lark = await import('@larksuiteoapi/node-sdk')
  const larkConfig = { appId: cfg.app_id, appSecret: secret, domain: Lark.Domain.Feishu }
  const apiClient = new Lark.Client(larkConfig)
  const dispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': (event: any) => {
      streamState.lastEventAt = Date.now()
      void handleFeishuEvent(deps, { header: { event_id: event?.event_id }, event }).catch((error) => {
        console.warn('[eab] 飞书消息处理失败：', (error as Error).message)
      })
    },
  })

  const wsClient = new Lark.WSClient({
    ...larkConfig,
    loggerLevel: Lark.LoggerLevel.info,
    autoReconnect: true,
    onReady: () => {
      streamState.connected = true
      streamState.registered = true
      streamState.lastConnectedAt = Date.now()
      streamState.error = null
      console.log(`[eab] 飞书长连接已连接：EAB · ${cfg.tenant_name ?? deps.companyId}`)
    },
    onError: (error: Error) => {
      streamState.connected = false
      streamState.registered = false
      streamState.error = `飞书长连接失败：${(error as Error).message}（请检查 App ID/App Secret、网络和飞书开放平台应用状态）`
      console.warn(`[eab] ${streamState.error}`)
    },
    onReconnecting: () => {
      streamState.connected = false
      streamState.registered = false
    },
    onReconnected: () => {
      streamState.connected = true
      streamState.registered = true
      streamState.lastConnectedAt = Date.now()
      streamState.error = null
    },
  })

  streamState.client = wsClient
  streamState.apiClient = apiClient
  streamState.appId = cfg.app_id
  streamState.secretRef = cfg.secret_ref
  streamState.startedAt = Date.now()
  streamState.error = null
  try {
    await wsClient.start({ eventDispatcher: dispatcher })
    streamState.registered = true
    if (!streamState.connected) {
      // 部分版本 start() 在握手成功前就返回；这里再读一次 SDK 状态。
      streamState.connected = wsClient.getConnectionStatus?.().state === 'connected'
    }
    if (!streamState.connected) {
      streamState.error = '飞书长连接握手未完成，正在自动重连；请检查网络或飞书应用是否已发布'
    }
  } catch (error) {
    streamState.error = `飞书长连接启动失败：${(error as Error).message}`
    console.warn(`[eab] ${streamState.error}`)
  }
}

export function startFeishuStreamMonitor(deps: ServerDeps, intervalMs = 30_000): () => void {
  let stopped = false
  const timer = setInterval(() => {
    if (stopped) return
    void refreshFeishuStream(deps).catch((error) => {
      console.warn('[eab] 飞书长连接巡检失败：', (error as Error).message)
    })
  }, Math.max(5_000, intervalMs))
  timer.unref?.()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}

export function stopFeishuStream(): void {
  if (streamState.client) {
    try {
      streamState.client.close({ force: true })
    } catch {
      /* 已断开 */
    }
  }
  streamState.client = null
  streamState.apiClient = null
  streamState.appId = null
  streamState.secretRef = null
  streamState.startedAt = null
  streamState.connected = false
  streamState.registered = false
}

/* ---------------- 入站事件 ---------------- */

interface FeishuMessageEvent {
  header?: { event_id?: string; event_type?: string; token?: string }
  event?: {
    sender?: {
      sender_id?: { open_id?: string; union_id?: string; user_id?: string }
      sender_type?: string
    }
    message?: {
      message_id?: string
      chat_id?: string
      chat_type?: string
      message_type?: string
      content?: string
      mentions?: Array<{ id?: { open_id?: string }; name?: string; key?: string }>
    }
  }
}

export interface FeishuHandleResult {
  readonly handled: boolean
  readonly text: string | null
  readonly sessionId: string | null
  readonly reason: string
}

const replyBuckets = new Map<string, number[]>()

/**
 * 飞书入站统一入口。长连接直接调用；HTTP 回调先 ack，再把事件交给它异步处理。
 * `eventRecorded` 表示 webhook 路由已经写过 channel_events，避免重复插入/误判重复。
 */
export async function handleFeishuEvent(
  deps: ServerDeps,
  body: FeishuMessageEvent,
  opts: { eventKey?: string; eventRecorded?: boolean; skipRateLimit?: boolean } = {},
): Promise<FeishuHandleResult> {
  // HTTP 回调是 {header, event}；长连接的 SDK 回调直接把 {sender, message} 交给 handler。
  const payload = ((body as { event?: unknown }).event ?? body) as FeishuMessageEvent['event']
  const message = payload?.message
  const senderId = payload?.sender?.sender_id?.open_id || payload?.sender?.sender_id?.user_id || ''
  if (!message?.message_id || !senderId) {
    return { handled: false, text: null, sessionId: null, reason: 'invalid-event' }
  }

  const eventKey =
    opts.eventKey ||
    body.header?.event_id ||
    message.message_id ||
    createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 32)

  if (!opts.eventRecorded) {
    const existing = deps.db
      .prepare('SELECT id FROM channel_events WHERE provider = ? AND event_key = ?')
      .get('feishu', eventKey) as { id: string } | undefined
    if (existing) {
      return { handled: false, text: null, sessionId: null, reason: 'duplicate' }
    }
    deps.db
      .prepare(
        `INSERT INTO channel_events (id, company_id, provider, event_key, sender_id, received_at)
         VALUES (?, ?, 'feishu', ?, ?, ?)`,
      )
      .run(`evt_${randomUUID()}`, deps.companyId, eventKey, senderId, Date.now())
  }

  streamState.lastEventAt = Date.now()

  // 同一发送者每分钟最多 20 条，避免模型接口被打爆。
  if (!opts.skipRateLimit) {
    const key = `feishu:${senderId}`
    const now = Date.now()
    const bucket = (replyBuckets.get(key) ?? []).filter((at) => now - at < 60_000)
    if (bucket.length >= 20) {
      replyBuckets.set(key, bucket)
      return finish(deps, eventKey, {
        handled: false,
        text: null,
        sessionId: null,
        reason: 'throttled',
      })
    }
    bucket.push(now)
    replyBuckets.set(key, bucket)
  }

  // 群里只有被 @ 才回应；私聊全量回应。
  const chatType = String(message.chat_type || '')
  const mentions = message.mentions ?? []
  if (chatType === 'group' && mentions.length === 0) {
    return finish(deps, eventKey, {
      handled: false,
      text: null,
      sessionId: null,
      reason: 'group-no-mention',
    })
  }

  const rawText = parseFeishuText(message)
  if (!rawText) {
    const text = '飞书这边暂时只处理文字消息。请把要问的内容直接发成文字；图片、文件、语音的支持需要额外开通飞书消息资源权限。'
    await sendFeishuReply(deps, message, text)
    return finish(deps, eventKey, { handled: true, text, sessionId: null, reason: 'unsupported-message-type' })
  }

  try {
    const actor = resolveFeishuActor(deps.db, deps.companyId, senderId)
    if (!actor) {
      const text =
        '这个飞书账号还没有对应到 EAB 成员。当前公司已经同步过飞书通讯录，但没找到你的身份；请联系管理员在 EAB 控制台「渠道 → 外部账号绑定」完成绑定。若公司还没有飞书组织架构，请让管理员确认 EAB 中存在公司根部门后重试。'
      await sendFeishuReply(deps, message, text)
      return finish(deps, eventKey, { handled: true, text, sessionId: null, reason: 'identity-unbound' })
    }

    const catalog = loadModelCatalog(deps.db, actor.subject.companyId, deps.config.devAuth)
    const available = visibleModelsFor(catalog, [...actor.subject.roles])
    if (available.length === 0) {
      const text =
        'EAB 当前没有你这个角色可用的模型。请管理员到控制台「模型接入」启用一个模型，并确认模型可见角色包含「普通员工」或「外部访客」。'
      await sendFeishuReply(deps, message, text)
      return finish(deps, eventKey, { handled: true, text, sessionId: null, reason: 'no-model-visible' })
    }

    const commandSessionId = ensureChannelSession(deps.db, actor, 'feishu', senderId, rawText)
    const storedModelId =
      (deps.db
        .prepare('SELECT model_id FROM chat_sessions WHERE id = ? AND deleted_at IS NULL')
        .get(commandSessionId) as { model_id: string | null } | undefined)?.model_id ?? null
    const currentModelId =
      storedModelId && available.some((item) => item.id === storedModelId) ? storedModelId : null
    const modelCommand = planChannelModelCommand(rawText, available, currentModelId)
    if (modelCommand) {
      if (modelCommand.modelId !== undefined) {
        deps.db
          .prepare('UPDATE chat_sessions SET model_id = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
          .run(modelCommand.modelId, Date.now(), commandSessionId)
      }
      await sendFeishuReply(deps, message, modelCommand.text)
      return finish(deps, eventKey, {
        handled: true,
        text: modelCommand.text,
        sessionId: commandSessionId,
        reason: 'model-command',
      })
    }

    try {
      assertChatQuota(deps.db, {
        companyId: actor.subject.companyId,
        userId: actor.person.id,
        deptId: actor.subject.deptId,
        deptPath: actor.subject.deptPath,
      })
    } catch (error) {
      const text = `${error instanceof Error ? error.message : '本月对话额度已用完'}。管理员可在 EAB 控制台「运营与审计 → 额度」里调整上限。`
      await sendFeishuReply(deps, message, text)
      return finish(deps, eventKey, { handled: true, text, sessionId: null, reason: 'quota-exceeded' })
    }

    const sessionId = ensureChannelSession(deps.db, actor, 'feishu', senderId, rawText)
    const sessionModelId =
      (deps.db
        .prepare('SELECT model_id FROM chat_sessions WHERE id = ? AND deleted_at IS NULL')
        .get(sessionId) as { model_id: string | null } | undefined)?.model_id ?? null
    const preferredModel = sessionModelId ? available.find((item) => item.id === sessionModelId) : undefined
    if (sessionModelId && !preferredModel) {
      deps.db
        .prepare('UPDATE chat_sessions SET model_id = NULL, updated_at = ? WHERE id = ?')
        .run(Date.now(), sessionId)
    }
    const model = preferredModel ?? available[0]
    if (!model) {
      const text = 'EAB 当前还没有可用模型。请管理员到「模型接入」启用一个模型后再试。'
      await sendFeishuReply(deps, message, text)
      return finish(deps, eventKey, { handled: true, text, sessionId, reason: 'no-model' })
    }

    const started = Date.now()
    const firstMessage =
      Number(
        (
          deps.db.prepare('SELECT COUNT(*) AS count FROM chat_messages WHERE session_id = ?').get(sessionId) as {
            count: number
          }
        ).count,
      ) === 0

    const hits = await retrieveKb(deps.db, deps.config.dbPath, actor, rawText)
    const memories = deps.db
      .prepare(
        `SELECT content FROM memories
          WHERE company_id = ? AND deleted_at IS NULL AND confirmed = 1
            AND ((scope_type = 'user' AND scope_id = ?)
              OR (scope_type = 'dept' AND scope_id = ?)
              OR (scope_type = 'company' AND scope_id = ?))
          ORDER BY created_at DESC LIMIT 8`,
      )
      .all(actor.subject.companyId, actor.person.id, actor.subject.deptId, actor.subject.companyId) as unknown as Array<{
      content: string
    }>
    const chatTools = toolSpecsForAgent(deps.db, actor, { kind: 'none' })
    const system = buildSystemPrompt({
      actor,
      chatTools,
      memories,
      hits,
      hasAttachments: false,
      pluginPrompts: pluginPromptTexts(deps.db, actor),
    })
    const messages: LlmMessage[] = [
      { role: 'system', content: system },
      ...historyOf(deps.db, sessionId, 16, 'feishu'),
      { role: 'user', content: rawText },
    ]

    const now = Date.now()
    const userMessageId = `msg_${randomUUID()}`
    deps.db
      .prepare(
        `INSERT INTO chat_messages (id, company_id, session_id, user_id, role, text, model_id, model_name, meta_json, created_at)
         VALUES (?, ?, ?, ?, 'user', ?, ?, ?, ?, ?)`,
      )
      .run(
        userMessageId,
        actor.subject.companyId,
        sessionId,
        actor.person.id,
        rawText,
        model.id,
        model.name,
        JSON.stringify({ channel: 'feishu', externalUserId: senderId }),
        now,
      )

    const turnToken = await acquireTurn(sessionId)
    let agentText = ''
    let agentResult: AgentTurnResult | null = null
    let effectiveModel = model
    let failoverNote = ''
    try {
      agentResult = await runAgentTurn({
        deps,
        actor,
        modelId: model.id,
        fallbackModelIds: available.filter((item) => item.id !== model.id).map((item) => item.id),
        bufferModelEvents: true,
        onModelFailover: (change) => {
          const next = available.find((item) => item.id === change.toModelId)
          if (next) effectiveModel = next
          failoverNote = `当前模型「${change.fromModelName}」暂时不可用，已自动切换到「${change.toModelName}」。\n\n`
        },
        messages,
        sessionId,
        space: { kind: 'none' },
        emit: () => undefined,
      })
      if (agentResult) {
        const usedId = agentResult.usedModelId
        const used = usedId ? available.find((item) => item.id === usedId) : undefined
        if (used) effectiveModel = used
        agentText = agentResult.text.trim()
      }
    } catch (error) {
      agentText = `这次回答没有成功：${error instanceof Error ? error.message : '模型调用失败'}。可以换个问法再试。`
    } finally {
      releaseTurn(sessionId, turnToken)
    }
    if (!agentText) agentText = '模型没有返回内容，请换个说法再试。'

    const alreadyBranded = /EAB|企业智能助手/.test(agentText)
    const greeting =
      firstMessage && !alreadyBranded
        ? `你好，${actor.person.name}。我是「${actor.person.companyName}」的 EAB 企业智能助手。飞书这里的对话和 EAB 网页工作台是同一份历史。\n\n`
        : ''
    const answerText = `${failoverNote}${greeting}${agentText}`
    const assistantCreatedAt = Date.now()
    const assistantMessageId = `msg_${randomUUID()}`
    const assistantMeta = {
      channel: 'feishu',
      citations: hits.map((hit, index) => ({
        index: index + 1,
        collection: hit.collectionName,
        title: hit.docTitle,
        excerpt: hit.text.slice(0, 120),
        docId: hit.docId ?? null,
        chunkId: hit.chunkId ?? null,
      })),
      reasoning: agentResult?.reasoning ?? '',
      toolCalls: agentResult?.toolCalls ?? [],
      rounds: agentResult?.rounds ?? 0,
    }
    deps.db
      .prepare(
        `INSERT INTO chat_messages (id, company_id, session_id, user_id, role, text, model_id, model_name, meta_json, created_at)
         VALUES (?, ?, ?, ?, 'assistant', ?, ?, ?, ?, ?)`,
      )
      .run(
        assistantMessageId,
        actor.subject.companyId,
        sessionId,
        actor.person.id,
        answerText,
        effectiveModel.id,
        effectiveModel.name,
        JSON.stringify(assistantMeta),
        assistantCreatedAt,
      )
    deps.db
      .prepare('UPDATE chat_sessions SET updated_at = ?, last_message_at = ? WHERE id = ?')
      .run(Date.now(), Date.now(), sessionId)
    bumpUsage(
      deps.db,
      actor.subject.companyId,
      actor.person.id,
      agentResult?.promptTokens ?? 0,
      agentResult?.completionTokens ?? 0,
    )
    publishChatEvent({
      type: 'message',
      companyId: actor.subject.companyId,
      userId: actor.person.id,
      sessionId,
      message: {
        id: assistantMessageId,
        role: 'assistant',
        text: answerText,
        modelId: effectiveModel.id,
        modelName: effectiveModel.name,
        meta: assistantMeta,
        createdAt: new Date(assistantCreatedAt).toISOString(),
      },
    })
    appendAudit(deps.db, {
      companyId: actor.subject.companyId,
      actorUserId: actor.person.id,
      action: 'chat.message',
      resourceType: 'chat_session',
      resourceId: sessionId,
      result: 'success',
      detail: { channel: 'feishu', modelId: effectiveModel.id, tools: agentResult?.toolCalls.length ?? 0 },
      channel: 'feishu',
      ip: null,
    })

    await sendFeishuReply(deps, message, answerText)
    return finish(deps, eventKey, {
      handled: true,
      text: answerText,
      sessionId,
      reason: 'ok',
      extra: { modelId: effectiveModel.id, durationMs: Date.now() - started },
    })
  } catch (error) {
    const text = `飞书消息处理失败：${(error as Error).message}`
    console.warn('[eab] 飞书消息处理异常：', text)
    try {
      await sendFeishuReply(deps, message, '这次消息处理失败了，请稍后再试。管理员可在 EAB 控制台「渠道」查看飞书长连接状态和权限提示。')
    } catch (replyError) {
      console.warn('[eab] 飞书失败提示也没有发出去：', (replyError as Error).message)
    }
    return finish(deps, eventKey, { handled: false, text: null, sessionId: null, reason: 'error' })
  }
}

function finish(
  deps: ServerDeps,
  eventKey: string,
  result: FeishuHandleResult & { extra?: Record<string, unknown> },
): FeishuHandleResult {
  deps.db
    .prepare('UPDATE channel_events SET result_json = ? WHERE provider = ? AND event_key = ?')
    .run(JSON.stringify({ ...result.extra, reason: result.reason, handled: result.handled }), 'feishu', eventKey)
  return { handled: result.handled, text: result.text, sessionId: result.sessionId, reason: result.reason }
}

function parseFeishuText(message: { message_type?: string; content?: string }): string {
  if (message.message_type !== 'text' || !message.content) return ''
  try {
    const parsed = JSON.parse(message.content) as { text?: unknown }
    return typeof parsed.text === 'string' ? parsed.text.replace(/@_user_\d+/g, '').trim() : ''
  } catch {
    return ''
  }
}

/* ---------------- 身份兜底 ---------------- */

function resolveFeishuActor(db: Db, companyId: string, externalId: string): RequestActor | null {
  const bound = db
    .prepare(
      `SELECT ci.user_id
         FROM channel_identities ci
         JOIN users u ON u.id = ci.user_id
        WHERE ci.provider = 'feishu' AND ci.external_id = ? AND ci.revoked_at IS NULL
          AND u.company_id = ? AND u.deleted_at IS NULL
        LIMIT 1`,
    )
    .get(externalId, companyId) as { user_id: string } | undefined
  if (bound?.user_id) {
    const person = findPerson(db, bound.user_id)
    return person ? actorFor(db, person) : null
  }

  const userId = provisionFeishuUser(db, companyId, externalId)
  if (!userId) return null
  const person = findPerson(db, userId)
  return person ? actorFor(db, person) : null
}

/**
 * 飞书租户没有通讯录时，用 open_id 建一个可对话的 EAB 成员。
 * 只写 channel_identities，不写 user_identities：这样后续飞书组织同步不会把
 * 自动创建的人当成“上游缺失成员”回收，也不会碰钉钉/企微的身份。
 */
function provisionFeishuUser(db: Db, companyId: string, openId: string): string | null {
  const synced = db
    .prepare(
      `SELECT COUNT(*) AS count
         FROM user_identities ui
         JOIN users u ON u.id = ui.user_id
        WHERE ui.provider = 'feishu' AND u.company_id = ? AND u.deleted_at IS NULL
          AND u.status = 'active'
          AND COALESCE(ui.bound_by, '') LIKE 'sync:%'`,
    )
    .get(companyId) as { count: number }
  // 公司已经通过飞书组织同步导入过通讯录时，未匹配的人不能自动变成正式成员，避免越权。
  // 手工绑定（console:...）不算组织同步，否则一个手工绑定会把其他飞书同事挡在门外。
  if (Number(synced.count) > 0) return null

  const root = db
    .prepare(
      `SELECT id, path FROM departments
        WHERE company_id = ? AND parent_id IS NULL AND deleted_at IS NULL
        ORDER BY path LIMIT 1`,
    )
    .get(companyId) as { id: string; path: string } | undefined
  if (!root?.id) return null

  const role = db
    .prepare(`SELECT id FROM roles WHERE company_id = ? AND code = 'member' AND deleted_at IS NULL LIMIT 1`)
    .get(companyId) as { id: string } | undefined
  if (!role?.id) return null

  const userId = `u_feishu_${createHash('sha256').update(`${companyId}:${openId}`).digest('hex').slice(0, 16)}`
  const name = `飞书用户 ${openId.slice(-6)}`
  const now = Date.now()
  const existingUser = db.prepare('SELECT id FROM users WHERE id = ? AND company_id = ?').get(userId, companyId) as
    | { id: string }
    | undefined
  if (existingUser?.id) {
    db.prepare('UPDATE users SET deleted_at = NULL, status = ?, updated_at = ? WHERE id = ? AND company_id = ?').run(
      'active',
      now,
      userId,
      companyId,
    )
  } else {
    db.prepare(
      `INSERT INTO users
         (id, company_id, dept_id, dept_path, name, title, employee_no, mobile, avatar, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 'active', ?, ?)`,
    ).run(userId, companyId, root.id, root.path, name, now, now)
  }

  const identity = db
    .prepare(
      'SELECT id FROM channel_identities WHERE company_id = ? AND provider = ? AND external_id = ? AND revoked_at IS NULL',
    )
    .get(companyId, 'feishu', openId) as { id: string } | undefined
  if (!identity?.id) {
    db.prepare(
      `INSERT OR IGNORE INTO channel_identities (id, company_id, provider, external_id, user_id, created_at)
       VALUES (?, ?, 'feishu', ?, ?, ?)`,
    ).run(ulid(now), companyId, openId, userId, now)
  }

  db.prepare(
    `INSERT OR IGNORE INTO user_roles (user_id, role_id, granted_by, granted_at, expires_at)
     VALUES (?, ?, 'auto:feishu', ?, NULL)`,
  ).run(userId, role.id, now)

  appendAudit(db, {
    companyId,
    actorUserId: null,
    action: 'channel.identity.auto_provision',
    resourceType: 'user',
    resourceId: userId,
    result: 'success',
    detail: { provider: 'feishu', externalId: openId, reason: 'no-feishu-directory' },
    channel: 'feishu',
    ip: null,
  })
  return userId
}

/* ---------------- 回复发送 ---------------- */

async function apiClientFor(deps: ServerDeps): Promise<any> {
  if (streamState.apiClient && streamState.appId) return streamState.apiClient
  const cfg = feishuConfig(deps.db, deps.companyId)
  if (!cfg?.app_id || !cfg.secret_ref) throw new Error('飞书渠道未配置 App ID / App Secret')
  const secret = resolveSecret(deps.config.dbPath, cfg.secret_ref)
  if (!secret) throw new Error('飞书渠道密钥缺失，请重新保存 App Secret')
  // webhook-only 场景没有长连接客户端，按事件发送时临时建一个；SDK 会自行缓存 token。
  const Lark = await import('@larksuiteoapi/node-sdk')
  const client = new Lark.Client({ appId: cfg.app_id, appSecret: secret, domain: Lark.Domain.Feishu })
  streamState.apiClient = client
  streamState.appId = cfg.app_id
  return client
}

async function sendFeishuReply(
  deps: ServerDeps,
  message: { message_id?: string; chat_id?: string },
  text: string,
): Promise<void> {
  const content = String(text || '').trim()
  if (!content) return
  const client = await apiClientFor(deps)
  const chunks = splitFeishuText(content)
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]
    try {
      if (index === 0 && message.message_id) {
        await client.im.v1.message.reply({
          path: { message_id: message.message_id },
          data: { msg_type: 'text', content: JSON.stringify({ text: chunk }) },
        })
      } else if (message.chat_id) {
        await client.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: message.chat_id,
            msg_type: 'text',
            content: JSON.stringify({ text: chunk }),
          },
        })
      } else if (message.message_id) {
        await client.im.v1.message.reply({
          path: { message_id: message.message_id },
          data: { msg_type: 'text', content: JSON.stringify({ text: chunk }) },
        })
      }
    } catch (error) {
      const hint = feishuSendHint(error)
      streamState.error = `飞书回复发送失败：${hint}`
      throw new Error(hint)
    }
  }
  streamState.lastReplyAt = Date.now()
}

function splitFeishuText(text: string): string[] {
  const max = 3500
  if (text.length <= max) return [text]
  const chunks: string[] = []
  let rest = text
  while (rest.length > max) {
    const cut = rest.lastIndexOf('\n', max)
    const at = cut > max / 2 ? cut : max
    chunks.push(rest.slice(0, at))
    rest = rest.slice(at)
  }
  if (rest) chunks.push(rest)
  return chunks
}

function feishuSendHint(error: unknown): string {
  const raw = JSON.stringify(error ?? {}) + String((error as Error)?.message ?? '')
  if (/99991672|99991663|access denied|permission|scope/i.test(raw)) {
    return '缺少机器人发消息权限。请在飞书开放平台给应用添加「获取与发送单聊、群组消息」权限（im:message 或 im:message:send_as_bot），发布应用版本后再试。'
  }
  return (error as Error)?.message || '未知错误'
}
