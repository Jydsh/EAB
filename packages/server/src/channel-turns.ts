/**
 * 渠道机器人「一轮进行中回合」的持久化登记。
 *
 * 钉钉 Stream 的入站消息一旦 ACK，服务重启后钉钉不会重推；因此必须在本地把
 * 原始 payload、会话、用户/助手消息 id 和卡片 outTrackId 落库，启动后才有东西可恢复。
 *
 * 这里只做存取，不依赖钉钉/模型模块，便于单测和以后给飞书复用。
 */
import { randomUUID } from 'node:crypto'
import type { Db } from '@eab/storage'

export type ChannelTurnStatus = 'running' | 'recovering' | 'completed' | 'failed'

export interface ChannelTurn {
  readonly id: string
  readonly companyId: string
  readonly provider: string
  readonly externalId: string
  readonly userId: string
  readonly sessionId: string
  readonly eventKey: string
  readonly payload: unknown
  readonly userMessageId: string | null
  readonly assistantMessageId: string | null
  readonly cardInstanceId: string | null
  readonly cardKind: string | null
  readonly agentTurnId: string | null
  readonly status: ChannelTurnStatus
  readonly attempts: number
  readonly progress: unknown
  readonly error: string
  readonly startedAt: number
  readonly updatedAt: number
  readonly finishedAt: number | null
}

interface TurnRow {
  id: string
  company_id: string
  provider: string
  external_id: string
  user_id: string
  session_id: string
  event_key: string
  payload_json: string
  user_message_id: string | null
  assistant_message_id: string | null
  card_instance_id: string | null
  card_kind: string | null
  agent_turn_id: string | null
  status: string
  attempts: number
  progress_json: string | null
  last_error: string | null
  started_at: number
  updated_at: number
  finished_at: number | null
}

function parseJson(value: string | null): unknown {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function toTurn(row: TurnRow): ChannelTurn {
  return {
    id: row.id,
    companyId: row.company_id,
    provider: row.provider,
    externalId: row.external_id,
    userId: row.user_id,
    sessionId: row.session_id,
    eventKey: row.event_key,
    payload: parseJson(row.payload_json),
    userMessageId: row.user_message_id,
    assistantMessageId: row.assistant_message_id,
    cardInstanceId: row.card_instance_id,
    cardKind: row.card_kind,
    agentTurnId: row.agent_turn_id,
    status: (row.status === 'recovering' || row.status === 'completed' || row.status === 'failed'
      ? row.status
      : 'running') as ChannelTurnStatus,
    attempts: Number(row.attempts) || 0,
    progress: parseJson(row.progress_json),
    error: row.last_error ?? '',
    startedAt: Number(row.started_at),
    updatedAt: Number(row.updated_at),
    finishedAt: row.finished_at === null ? null : Number(row.finished_at),
  }
}

export interface BeginChannelTurnInput {
  readonly id: string
  readonly companyId: string
  readonly provider: string
  readonly externalId: string
  readonly userId: string
  readonly sessionId: string
  readonly eventKey: string
  readonly payload: unknown
  readonly userMessageId?: string | null
  readonly assistantMessageId?: string | null
  readonly agentTurnId?: string | null
  readonly startedAt?: number
}

/** 登记一轮开始；同一 provider + eventKey 只保留第一条，避免重复事件覆盖进度。 */
export function beginChannelTurn(db: Db, input: BeginChannelTurnInput): boolean {
  const now = input.startedAt ?? Date.now()
  const inserted = db
    .prepare(
      `INSERT INTO channel_turns
         (id, company_id, provider, external_id, user_id, session_id, event_key, payload_json,
          user_message_id, assistant_message_id, agent_turn_id, status, attempts, started_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 0, ?, ?)
       ON CONFLICT (provider, event_key) DO NOTHING`,
    )
    .run(
      input.id,
      input.companyId,
      input.provider,
      input.externalId,
      input.userId,
      input.sessionId,
      input.eventKey,
      JSON.stringify(input.payload ?? null),
      input.userMessageId ?? null,
      input.assistantMessageId ?? null,
      input.agentTurnId ?? null,
      now,
      now,
    )
  return Number(inserted.changes) === 1
}

/** 卡片投递成功后立刻记下 outTrackId；重启恢复时要复用这张卡。 */
export function setChannelTurnCard(
  db: Db,
  turnId: string,
  cardInstanceId: string | null,
  cardKind: string | null,
): void {
  const id = String(cardInstanceId ?? '').trim()
  if (!id) return
  db.prepare(
    `UPDATE channel_turns
        SET card_instance_id = ?, card_kind = ?, updated_at = ?
      WHERE id = ?`,
  ).run(id, cardKind, Date.now(), turnId)
}

/** 只记最近一次可见进度，供恢复时提示模型哪些工具已经执行过。 */
export function setChannelTurnProgress(db: Db, turnId: string, progress: unknown): void {
  db.prepare('UPDATE channel_turns SET progress_json = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(progress ?? null),
    Date.now(),
    turnId,
  )
}

/** 收口：completed / failed 后不再进入恢复队列。 */
export function finishChannelTurn(
  db: Db,
  turnId: string,
  status: 'completed' | 'failed',
  error = '',
): void {
  const now = Date.now()
  db.prepare(
    `UPDATE channel_turns
        SET status = ?, last_error = ?, finished_at = ?, updated_at = ?
      WHERE id = ?`,
  ).run(status, error.slice(0, 500), now, now, turnId)
}

/** 启动时列出没跑完的回合；只恢复最近一段时间，避免把很早以前的对话翻出来重放。 */
export function listRecoverableChannelTurns(
  db: Db,
  provider: string,
  options: { sinceMs?: number; limit?: number } = {},
): ChannelTurn[] {
  const since = Date.now() - Math.max(60_000, options.sinceMs ?? 24 * 60 * 60 * 1000)
  const limit = Math.min(50, Math.max(1, Math.trunc(options.limit ?? 20)))
  const rows = db
    .prepare(
      `SELECT * FROM channel_turns
        WHERE provider = ? AND status IN ('running', 'recovering') AND started_at >= ?
        ORDER BY started_at ASC
        LIMIT ?`,
    )
    .all(provider, since, limit) as unknown as TurnRow[]
  return rows.map(toTurn)
}

/**
 * 抢占恢复权：多实例同时启动时只有一个实例能把 running/recovering 改成 recovering。
 * attempts 超过上限的回合不再抢占，由调用方直接收口，防止无限重试。
 */
export function claimChannelTurn(db: Db, turnId: string, maxAttempts = 3): boolean {
  const now = Date.now()
  const updated = db
    .prepare(
      `UPDATE channel_turns
          SET status = 'recovering', attempts = attempts + 1, updated_at = ?
        WHERE id = ?
          AND status IN ('running', 'recovering')
          AND attempts < ?`,
    )
    .run(now, turnId, Math.max(1, Math.trunc(maxAttempts)))
  return Number(updated.changes) === 1
}

export function getChannelTurn(db: Db, turnId: string): ChannelTurn | null {
  const row = db.prepare('SELECT * FROM channel_turns WHERE id = ?').get(turnId) as TurnRow | undefined
  return row ? toTurn(row) : null
}

/**
 * 兼容升级前已经卡住的事件：旧代码只写 channel_events，没有 channel_turns，
 * 重启后既没有 payload 也没有卡片 id。这里用「事件时间附近唯一的一条用户消息」
 * 反推原始提问，补登成正常回合，让 0057 之后的恢复流程也能接住它。
 *
 * 只处理满足全部条件的事件，避免把已正常回答/用户已撤回的旧消息重新发一遍：
 * - result_json 为空（旧代码没写回结果）；
 * - 24 小时内，且事件发送人仍绑定到在职成员；
 * - 附近有且只有一条用户消息，且这条消息之后没有 assistant 回复。
 */
export function adoptLegacyInterruptedTurns(
  db: Db,
  companyId: string,
  options: { sinceMs?: number; limit?: number } = {},
): number {
  const since = Date.now() - Math.max(60_000, options.sinceMs ?? 24 * 60 * 60 * 1000)
  const limit = Math.min(50, Math.max(1, Math.trunc(options.limit ?? 20)))
  const events = db
    .prepare(
      `SELECT id, event_key, sender_id, received_at
         FROM channel_events
        WHERE company_id = ? AND provider = 'dingtalk'
          AND result_json IS NULL AND received_at >= ?
        ORDER BY received_at ASC
        LIMIT ?`,
    )
    .all(companyId, since, limit) as Array<{
    id: string
    event_key: string
    sender_id: string | null
    received_at: number
  }>

  let adopted = 0
  for (const event of events) {
    // 卡片按钮回调不是新提问；它要复用原卡，不能按文本消息补登成一张新卡。
    if (String(event.event_key).startsWith('card:')) continue
    const externalId = String(event.sender_id ?? '').trim()
    if (!externalId) continue
    const identity = db
      .prepare(
        `SELECT user_id FROM user_identities
          WHERE provider = 'dingtalk' AND external_user_id = ? AND status = 'active'
          LIMIT 1`,
      )
      .get(externalId) as { user_id: string } | undefined
    if (!identity) continue
    const existingTurn = db
      .prepare('SELECT id FROM channel_turns WHERE provider = ? AND event_key = ? LIMIT 1')
      .get('dingtalk', event.event_key) as { id: string } | undefined
    if (existingTurn) continue

    // 事件落库与用户消息落库通常差几百毫秒；给 15 秒前 / 5 分钟后的窗口，
    // 用「时间最近」挑出这一条，避免把上一轮消息配错。
    const userMessage = db
      .prepare(
        `SELECT m.id, m.session_id, m.text, m.created_at
           FROM chat_messages m
           JOIN chat_sessions s ON s.id = m.session_id
          WHERE s.company_id = ? AND s.user_id = ? AND s.source = 'dingtalk'
            AND m.role = 'user'
            AND m.created_at BETWEEN ? AND ?
          ORDER BY ABS(m.created_at - ?) ASC
          LIMIT 1`,
      )
      .get(
        companyId,
        identity.user_id,
        event.received_at - 15_000,
        event.received_at + 300_000,
        event.received_at,
      ) as
      | { id: string; session_id: string; text: string; created_at: number }
      | undefined
    if (!userMessage || !String(userMessage.text ?? '').trim()) continue

    const answered = db
      .prepare(
        `SELECT 1 FROM chat_messages
          WHERE session_id = ? AND role = 'assistant' AND created_at > ?
          LIMIT 1`,
      )
      .get(userMessage.session_id, userMessage.created_at)
    if (answered) continue

    const turnId = `msg_${randomUUID()}`
    beginChannelTurn(db, {
      id: turnId,
      companyId,
      provider: 'dingtalk',
      externalId,
      userId: identity.user_id,
      sessionId: userMessage.session_id,
      eventKey: event.event_key,
      payload: {
        msgId: event.event_key,
        senderStaffId: externalId,
        conversationType: '1',
        createAt: event.received_at,
        text: { content: userMessage.text },
      },
      userMessageId: userMessage.id,
      assistantMessageId: turnId,
      agentTurnId: randomUUID(),
      startedAt: event.received_at,
    })
    adopted += 1
  }
  return adopted
}
