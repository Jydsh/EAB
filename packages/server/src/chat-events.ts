/**
 * 对话消息的进程内事件总线。
 *
 * 网页工作台和钉钉私聊共用同一份 chat_messages；网页自己发消息时由本地流式渲染，
 * 但钉钉侧生成中的增量和落库后的消息不会经过网页请求，所以需要在这里广播给
 * 已经打开网页的同一员工，避免必须刷新页面才能看到新消息。
 *
 * 配了 Redis 时，这里的事件还会经 Pub/Sub 发到其它实例，「员工连到哪台机器都能
 * 看到增量」；没配就是纯进程内广播，行为与升级前一致。
 */
import type { PubSubBackend } from './backends/pubsub.js'
export interface ChatLiveMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  modelId?: string | null
  modelName?: string | null
  meta?: unknown
  createdAt: string
}

export interface ChatLiveEvent {
  type: 'message'
  companyId: string
  userId: string
  sessionId: string
  message: ChatLiveMessage
}

/** 钉钉侧模型还在生成时，把增量正文/思考过程推给已经打开网页的同一员工。 */
export interface ChatLiveDeltaEvent {
  type: 'delta'
  companyId: string
  userId: string
  sessionId: string
  messageId: string
  kind: 'reasoning' | 'content'
  text: string
  modelId?: string | null
  modelName?: string | null
}

export type ChatLiveToolEventPayload =
  | { type: 'tool'; id: string; name: string; toolId?: string | null; args?: unknown }
  | { type: 'tool_result'; id: string; status: 'done' | 'error'; summary: string; durationMs: number }

/** 工具开始/结束，让网页在钉钉侧调用工具时也能实时看到工具卡片。 */
export interface ChatLiveToolEvent {
  type: 'tool'
  companyId: string
  userId: string
  sessionId: string
  messageId: string
  tool: ChatLiveToolEventPayload
}

export type ChatLiveEventPayload = ChatLiveEvent | ChatLiveDeltaEvent | ChatLiveToolEvent

type ChatEventListener = (event: ChatLiveEventPayload) => void

const listeners = new Set<ChatEventListener>()

/** 跨实例广播通道；没有 Redis 时保持 null，行为与升级前一致。 */
let bridge: PubSubBackend | null = null
let bridgeUnsubscribe: (() => void) | null = null
const BRIDGE_CHANNEL = 'chat'

function deliverLocal(event: ChatLiveEventPayload): void {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch {
      // 单个订阅者断开或写失败不能影响其它订阅者，也不能影响消息落库。
    }
  }
}

/**
 * 接上跨实例广播：本实例产生的事件会同时发到 Redis，其它实例订阅后转给各自的
 * 本地订阅者（同一个员工连到哪台机器都能收到增量）。自己的回环消息由 PubSub 层丢弃。
 *
 * 没有 Redis（bridge = null）时退化为纯进程内广播。
 */
export function initChatEventBridge(pubsub: PubSubBackend | null): void {
  if (bridge === pubsub) return
  bridgeUnsubscribe?.()
  bridgeUnsubscribe = null
  bridge = pubsub
  if (!pubsub) return
  void pubsub
    .subscribe(BRIDGE_CHANNEL, (payload) => {
      try {
        const event = JSON.parse(payload) as ChatLiveEventPayload
        if (event && (event.type === 'message' || event.type === 'delta' || event.type === 'tool')) {
          deliverLocal(event)
        }
      } catch {
        // 非法载荷直接丢弃
      }
    })
    .then((unsubscribe) => {
      bridgeUnsubscribe = unsubscribe
    })
    .catch(() => {
      // 订阅失败只影响跨实例实时性，本地仍可用
    })
}

export function subscribeChatEvents(listener: ChatEventListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function publishChatEvent(event: ChatLiveEventPayload): void {
  deliverLocal(event)
  if (bridge) {
    void bridge.publish(BRIDGE_CHANNEL, JSON.stringify(event)).catch(() => undefined)
  }
}
