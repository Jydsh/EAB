/**
 * 跨实例控制指令（停止生成 / 取消 Agent 任务树）。
 *
 * 「停止生成」原本只能打断收到这次 HTTP 请求的那个进程；几百人同时用时页面请求
 * 和真正跑模型的进程可能不是同一台机器（刷新、重连、负载均衡都会造成错位）。
 * 这里复用 Redis Pub/Sub 通道：本进程找不到目标时广播一条控制消息，持有该任务的
 * 实例收到后执行真正的 abort。
 *
 * 没有 Redis 时 `requestXxx` 直接返回 false，调用方行为与升级前一致。
 */
import type { Db } from '@eab/storage'
import type { PubSubBackend } from './backends/pubsub.js'
import { cancelChatRun } from './chat-runs.js'
import { cancelAgentRunTree } from './agent-runtime.js'

const CONTROL_CHANNEL = 'control'

export type RealtimeControlMessage =
  | { kind: 'cancel-chat-run'; runId: string; companyId: string; userId: string }
  | { kind: 'cancel-agent-run'; runId: string; reason: string }

let bus: PubSubBackend | null = null
let database: Db | undefined
let unsubscribe: (() => void) | null = null

function handle(message: RealtimeControlMessage): void {
  if (message.kind === 'cancel-chat-run') {
    cancelChatRun(message.runId, { companyId: message.companyId, userId: message.userId })
    return
  }
  if (message.kind === 'cancel-agent-run' && database) {
    cancelAgentRunTree(database, message.runId, message.reason)
  }
}

/**
 * 注册控制通道监听。两个入口（对话 / 控制台）共用同一进程，重复调用只会订阅一次；
 * pubsub 变化（测试注入或重新装配）时重新订阅。
 */
export function initRealtimeControl(pubsub: PubSubBackend | null, db?: Db): void {
  if (bus === pubsub && database === db) return
  unsubscribe?.()
  unsubscribe = null
  bus = pubsub
  database = db
  if (!pubsub) return
  void pubsub
    .subscribe(CONTROL_CHANNEL, (payload) => {
      try {
        const parsed = JSON.parse(payload) as RealtimeControlMessage
        if (parsed && typeof parsed.kind === 'string') handle(parsed)
      } catch {
        // 非法载荷丢弃
      }
    })
    .then((off) => {
      unsubscribe = off
    })
    .catch(() => {
      // 订阅失败只影响跨实例控制，本地取消仍可用
    })
}

function publish(message: RealtimeControlMessage): boolean {
  if (!bus) return false
  void bus.publish(CONTROL_CHANNEL, JSON.stringify(message)).catch(() => undefined)
  return true
}

/** 通知其它实例停止网页对话的某一轮；返回是否已发出（未接 Redis 时为 false）。 */
export function requestCancelChatRun(
  runId: string,
  owner: { companyId: string; userId: string },
): boolean {
  return publish({ kind: 'cancel-chat-run', runId, companyId: owner.companyId, userId: owner.userId })
}

/** 通知其它实例取消一棵 Agent 运行树；返回是否已发出。 */
export function requestCancelAgentRun(runId: string, reason = '任务已取消'): boolean {
  return publish({ kind: 'cancel-agent-run', runId, reason })
}
