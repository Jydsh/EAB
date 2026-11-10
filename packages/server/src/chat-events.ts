/**
 * 对话消息的进程内事件总线。
 *
 * 网页工作台和钉钉私聊共用同一份 chat_messages；网页自己发消息时由本地流式渲染，
 * 但钉钉侧生成中的增量和落库后的消息不会经过网页请求，所以需要在这里广播给
 * 已经打开网页的同一员工，避免必须刷新页面才能看到新消息。
 */
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

export function subscribeChatEvents(listener: ChatEventListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function publishChatEvent(event: ChatLiveEventPayload): void {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch {
      // 单个订阅者断开或写失败不能影响其它订阅者，也不能影响消息落库。
    }
  }
}
