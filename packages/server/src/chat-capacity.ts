/**
 * 网页对话的承载闸门。
 *
 * 目的不是“限制用户”，而是把无限并发变成可控排队：
 * - 全局同时进行的对话 turn 有上限，超出的按到达顺序排队；
 * - 公司级、模型级再各有一层上限，避免一个公司/一个模型被单个入口打满；
 * - 单个用户同时最多 N 条在途、每分钟最多 M 条，避免一个人把模型打满；
 * - 排队满或等待超时明确返回 429，不让请求无声地堆在内存里。
 *
 * 这里只管“网页对话”这一条入口；钉钉入站已有自己的每分钟限频，后台定时任务
 * 也不走这里，避免把不同来源混成一个队列。
 */
import { EC, EabError } from '@eab/domain'
import {
  coordinationStatus,
  hitRate,
  reserveCapacity,
  type CapacityLease,
  type CapacityRequest,
} from './backends/coordination.js'

export interface ChatCapacityContext {
  readonly companyId?: string
  readonly modelId?: string
}

export interface ChatCapacityOptions {
  readonly maxConcurrent: number
  readonly queueLimit: number
  readonly queueTimeoutMs: number
  readonly maxInFlightPerUser: number
  readonly messagesPerMinute: number
  /** 同一模型同时生成上限；默认 4 */
  readonly modelMaxConcurrent?: number
  /** 同一公司同时生成上限；默认等于全局上限 */
  readonly companyMaxConcurrent?: number
}

export interface ChatSlot {
  readonly release: () => void
}

interface UserWindow {
  inFlight: number
  /** 最近一分钟内的消息发起时间；用于每用户频率限制 */
  timestamps: number[]
}

interface Waiter {
  readonly userId: string
  readonly user: UserWindow
  readonly modelId?: string
  readonly companyId?: string
  readonly resolve: (slot: ChatSlot) => void
  readonly reject: (error: EabError) => void
  timer: ReturnType<typeof setTimeout> | null
  done: boolean
}

export interface ChatCapacityStats {
  readonly active: number
  readonly queued: number
  readonly users: number
  readonly models: ReadonlyArray<{ modelId: string; active: number; queued: number }>
  readonly companies: ReadonlyArray<{ companyId: string; active: number; queued: number }>
}

export interface ChatCapacity {
  /** 取得一个 turn 名额；满员时排队，排队满/超时抛 429。 */
  acquire(userId: string, context?: ChatCapacityContext): Promise<ChatSlot>
  /** 给健康检查/诊断用，不暴露用户身份。 */
  stats(): ChatCapacityStats
}

const RATE_WINDOW_MS = 60_000

function positiveInt(value: number, fallback: number): number {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

export function createChatCapacity(options: ChatCapacityOptions): ChatCapacity {
  const maxConcurrent = positiveInt(options.maxConcurrent, 8)
  const queueLimit = positiveInt(options.queueLimit, 100)
  const queueTimeoutMs = positiveInt(options.queueTimeoutMs, 240_000)
  // 0 表示不限制单个用户同时在途的回合数；负数/非法值回落到 2。
  const maxInFlightPerUser =
    Number.isInteger(options.maxInFlightPerUser) && options.maxInFlightPerUser >= 0
      ? options.maxInFlightPerUser
      : 2
  const messagesPerMinute = positiveInt(options.messagesPerMinute, 20)
  const modelMaxConcurrent = positiveInt(options.modelMaxConcurrent ?? 4, 4)
  const companyMaxConcurrent = positiveInt(options.companyMaxConcurrent ?? maxConcurrent, maxConcurrent)

  let active = 0
  const waiters: Waiter[] = []
  const users = new Map<string, UserWindow>()
  const modelActive = new Map<string, number>()
  const companyActive = new Map<string, number>()

  function prune(now = Date.now()): void {
    for (const [userId, user] of users) {
      user.timestamps = user.timestamps.filter((time) => now - time < RATE_WINDOW_MS)
      if (user.inFlight === 0 && user.timestamps.length === 0) users.delete(userId)
    }
  }

  function userWindow(userId: string, now = Date.now()): UserWindow {
    const existing = users.get(userId)
    if (existing) {
      existing.timestamps = existing.timestamps.filter((time) => now - time < RATE_WINDOW_MS)
      return existing
    }
    const created: UserWindow = { inFlight: 0, timestamps: [] }
    users.set(userId, created)
    return created
  }

  function reject(userId: string, message: string, hint: string): EabError {
    const user = users.get(userId)
    if (user && user.inFlight === 0) prune()
    return new EabError(EC.RATE_LIMITED, message, {
      hint,
      details: {
        queueLimit,
        maxConcurrent,
        maxInFlightPerUser,
        messagesPerMinute,
        modelMaxConcurrent,
        companyMaxConcurrent,
      },
    })
  }

  function hasCapacity(context: ChatCapacityContext): boolean {
    if (active >= maxConcurrent) return false
    if (context.companyId && (companyActive.get(context.companyId) ?? 0) >= companyMaxConcurrent) return false
    if (context.modelId && (modelActive.get(context.modelId) ?? 0) >= modelMaxConcurrent) return false
    return true
  }

  function reserve(user: UserWindow, context: ChatCapacityContext): ChatSlot {
    active += 1
    if (context.modelId) modelActive.set(context.modelId, (modelActive.get(context.modelId) ?? 0) + 1)
    if (context.companyId) companyActive.set(context.companyId, (companyActive.get(context.companyId) ?? 0) + 1)
    return makeSlot(user, context)
  }

  function makeSlot(user: UserWindow, context: ChatCapacityContext): ChatSlot {
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        active = Math.max(0, active - 1)
        user.inFlight = Math.max(0, user.inFlight - 1)
        if (context.modelId) {
          const next = Math.max(0, (modelActive.get(context.modelId) ?? 0) - 1)
          if (next === 0) modelActive.delete(context.modelId)
          else modelActive.set(context.modelId, next)
        }
        if (context.companyId) {
          const next = Math.max(0, (companyActive.get(context.companyId) ?? 0) - 1)
          if (next === 0) companyActive.delete(context.companyId)
          else companyActive.set(context.companyId, next)
        }
        prune()
        grantNext()
      },
    }
  }

  function grantNext(): void {
    // 不严格按队首阻塞：队首可能只差一个模型名额，后面的人可以用别的模型。
    let index = 0
    while (active < maxConcurrent && index < waiters.length) {
      const waiter = waiters[index]
      if (!waiter || waiter.done) {
        waiters.splice(index, 1)
        continue
      }
      if (!hasCapacity(waiter)) {
        index += 1
        continue
      }
      waiters.splice(index, 1)
      grant(waiter)
    }
  }

  function grant(waiter: Waiter): void {
    waiter.done = true
    if (waiter.timer) clearTimeout(waiter.timer)
    waiter.resolve(reserve(waiter.user, waiter))
  }

  /** 合作层名额的 TTL：比最长单轮对话更宽裕，实例崩溃后名额自动过期，不会永久占坑 */
  const SLOT_TTL_SECONDS = 600
  /** 排队者轮询共享名额的间隔 */
  const SHARED_POLL_MS = 500

  interface SharedWaiter {
    readonly userId: string
    readonly context: ChatCapacityContext
    readonly resolve: (slot: ChatSlot) => void
    readonly reject: (error: EabError) => void
    timer: ReturnType<typeof setTimeout> | null
    poll: ReturnType<typeof setInterval> | null
    done: boolean
  }

  const sharedWaiters: SharedWaiter[] = []

  /** Redis 在线时才走共享名额；否则完全沿用原来的进程内实现 */
  function sharedReady(): boolean {
    try {
      return coordinationStatus().shared
    } catch {
      return false
    }
  }

  function sharedRequests(userId: string, context: ChatCapacityContext): CapacityRequest[] {
    const requests: CapacityRequest[] = [{ key: 'chat:slot:active', limit: maxConcurrent }]
    if (context.companyId) {
      requests.push({ key: `chat:slot:company:${context.companyId}`, limit: companyMaxConcurrent })
    }
    if (context.modelId) {
      requests.push({ key: `chat:slot:model:${context.modelId}`, limit: modelMaxConcurrent })
    }
    if (maxInFlightPerUser > 0) {
      requests.push({ key: `chat:slot:user:${userId}`, limit: maxInFlightPerUser })
    }
    return requests
  }

  /** 共享名额拿到后，本地只镜像计数用于观测（不参与准入判断）。 */
  function grantShared(context: ChatCapacityContext, lease: CapacityLease): ChatSlot {
    active += 1
    if (context.modelId) modelActive.set(context.modelId, (modelActive.get(context.modelId) ?? 0) + 1)
    if (context.companyId) companyActive.set(context.companyId, (companyActive.get(context.companyId) ?? 0) + 1)
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        lease.release()
        active = Math.max(0, active - 1)
        if (context.modelId) {
          const next = Math.max(0, (modelActive.get(context.modelId) ?? 0) - 1)
          if (next === 0) modelActive.delete(context.modelId)
          else modelActive.set(context.modelId, next)
        }
        if (context.companyId) {
          const next = Math.max(0, (companyActive.get(context.companyId) ?? 0) - 1)
          if (next === 0) companyActive.delete(context.companyId)
          else companyActive.set(context.companyId, next)
        }
      },
    }
  }

  async function acquireShared(userId: string, context: ChatCapacityContext): Promise<ChatSlot> {
    if (sharedWaiters.length >= queueLimit) {
      throw reject(
        userId,
        '当前对话排队已满，请稍后重试',
        `同时最多 ${maxConcurrent} 条回答在生成，排队上限 ${queueLimit} 条`,
      )
    }
    const rate = await hitRate(`chat:msg:${userId}`, messagesPerMinute, 60)
    if (!rate.allowed) {
      throw reject(userId, '发送太快了，请稍后再发', `每分钟最多 ${messagesPerMinute} 条消息`)
    }

    const first = await reserveCapacity(sharedRequests(userId, context), SLOT_TTL_SECONDS)
    if (first.ok) return grantShared(context, first.lease)
    // 共享层不可用：交给本地实现，宁可多开也不拒绝用户
    if (first.reason === 'unavailable') return acquireLocal(userId, context)

    return new Promise<ChatSlot>((resolve, rejectPromise) => {
      const waiter: SharedWaiter = {
        userId,
        context,
        resolve,
        reject: rejectPromise as (error: EabError) => void,
        timer: null,
        poll: null,
        done: false,
      }
      const cleanup = (): void => {
        if (waiter.timer) clearTimeout(waiter.timer)
        if (waiter.poll) clearInterval(waiter.poll)
        const index = sharedWaiters.indexOf(waiter)
        if (index >= 0) sharedWaiters.splice(index, 1)
      }
      waiter.timer = setTimeout(() => {
        if (waiter.done) return
        waiter.done = true
        cleanup()
        rejectPromise(
          reject(
            userId,
            '排队等待超时，请稍后重试',
            `当前回答并发较高，等待超过 ${Math.round(queueTimeoutMs / 1000)} 秒`,
          ),
        )
      }, queueTimeoutMs)
      waiter.poll = setInterval(() => {
        if (waiter.done) return
        void reserveCapacity(sharedRequests(userId, context), SLOT_TTL_SECONDS)
          .then((result) => {
            if (waiter.done) {
              // 超时后名额刚好下来：立刻还回去，避免泄漏
              if (result.ok) result.lease.release()
              return
            }
            if (!result.ok) return
            waiter.done = true
            cleanup()
            resolve(grantShared(context, result.lease))
          })
          .catch(() => undefined)
      }, SHARED_POLL_MS)
      sharedWaiters.push(waiter)
    })
  }

  async function acquireLocal(userId: string, context: ChatCapacityContext): Promise<ChatSlot> {
    const now = Date.now()
    const user = userWindow(userId, now)
    if (user.timestamps.length >= messagesPerMinute) {
      throw reject(userId, '发送太快了，请稍后再发', `每分钟最多 ${messagesPerMinute} 条消息`)
    }
    if (maxInFlightPerUser > 0 && user.inFlight >= maxInFlightPerUser) {
      throw reject(
        userId,
        '你已有回答正在生成，请等当前回复结束后再发',
        `同一个人同时最多 ${maxInFlightPerUser} 条在途消息`,
      )
    }

    // 先占住“在途”名额，排队期间也算；这样同一个人连续发不会绕过每用户上限。
    user.inFlight += 1
    user.timestamps.push(now)

    if (hasCapacity(context)) {
      return Promise.resolve(reserve(user, context))
    }

    if (waiters.length >= queueLimit) {
      user.inFlight -= 1
      prune(now)
      throw reject(
        userId,
        '当前对话排队已满，请稍后重试',
        `同时最多 ${maxConcurrent} 条回答在生成，排队上限 ${queueLimit} 条`,
      )
    }

    return new Promise<ChatSlot>((resolve, rejectPromise) => {
      const waiter: Waiter = {
        userId,
        user,
        modelId: context.modelId,
        companyId: context.companyId,
        resolve,
        reject: rejectPromise as (error: EabError) => void,
        timer: null,
        done: false,
      }
      waiter.timer = setTimeout(() => {
        if (waiter.done) return
        waiter.done = true
        const index = waiters.indexOf(waiter)
        if (index >= 0) waiters.splice(index, 1)
        user.inFlight = Math.max(0, user.inFlight - 1)
        prune()
        rejectPromise(
          reject(
            userId,
            '排队等待超时，请稍后重试',
            `当前回答并发较高，等待超过 ${Math.round(queueTimeoutMs / 1000)} 秒`,
          ),
        )
      }, queueTimeoutMs)
      waiters.push(waiter)
    })
  }

  return {
    async acquire(userId: string, context: ChatCapacityContext = {}): Promise<ChatSlot> {
      if (sharedReady()) {
        try {
          return await acquireShared(userId, context)
        } catch (error) {
          // 明确的 429 照常抛出；共享层其它异常退回本地实现，不让用户看到内部错误
          if (error instanceof EabError) throw error
        }
      }
      return acquireLocal(userId, context)
    },
    stats() {
      prune()
      const models = [...modelActive.entries()]
        .map(([modelId, count]) => ({ modelId, active: count, queued: 0 }))
        .sort((a, b) => b.active - a.active)
      const companies = [...companyActive.entries()]
        .map(([companyId, count]) => ({ companyId, active: count, queued: 0 }))
        .sort((a, b) => b.active - a.active)
      for (const waiter of waiters) {
        if (waiter.modelId) {
          const entry = models.find((item) => item.modelId === waiter.modelId)
          if (entry) entry.queued += 1
          else models.push({ modelId: waiter.modelId, active: 0, queued: 1 })
        }
        if (waiter.companyId) {
          const entry = companies.find((item) => item.companyId === waiter.companyId)
          if (entry) entry.queued += 1
          else companies.push({ companyId: waiter.companyId, active: 0, queued: 1 })
        }
      }
      // 共享名额的排队只记数量与模型/公司分布，不暴露用户身份
      for (const waiter of sharedWaiters) {
        if (waiter.context.modelId) {
          const entry = models.find((item) => item.modelId === waiter.context.modelId)
          if (entry) entry.queued += 1
          else models.push({ modelId: waiter.context.modelId, active: 0, queued: 1 })
        }
        if (waiter.context.companyId) {
          const entry = companies.find((item) => item.companyId === waiter.context.companyId)
          if (entry) entry.queued += 1
          else companies.push({ companyId: waiter.context.companyId, active: 0, queued: 1 })
        }
      }
      return {
        active,
        queued: waiters.length + sharedWaiters.length,
        users: users.size,
        models,
        companies,
      }
    },
  }
}
