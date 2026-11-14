/**
 * 异步作业队列（Phase 4 地基）。
 *
 * 目标：把「慢操作」从 HTTP 请求里挪出来——提交后立刻返回 jobId，控制台按 jobId
 * 轮询进度，几百人同时用也不会因为一个通道刷新把连接占几分钟。
 *
 * 设计取舍：
 * - **库是权威状态**：`async_jobs` 表跨实例共享，任何实例都能回读任意作业；
 * - **Redis 只做加速**：有 Redis 时提交作业会 publish 一条唤醒消息，worker 立刻开工；
 *   没 Redis 就按 pollMs 轮询，行为与升级前一致，只是慢一个轮询周期；
 * - **租约而不是锁**：`lease_owner + lease_until` 记录谁在跑；实例崩溃后
 *   `recoverStaleJobs` 把过期租约的 running 作业放回 queued，避免任务永久卡住；
 * - 作业参数只放调用所需的最小信息，不放会话正文、密钥和审计数据。
 */
import type { Db } from '@eab/storage'
import { randomUUID } from 'node:crypto'
import { getBackendRuntime } from './backends/runtime.js'

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export const JOB_STATUS: readonly JobStatus[] = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]

/** 已知作业类型；处理器在 main.ts 里装配，避免把业务依赖塞进队列模块。 */
export const JOB_KINDS = {
  /** 刷新插件通道并重新探测该通道下的模型。 */
  pluginChannelRefresh: 'plugin.channel-refresh',
} as const

export type JobKind = (typeof JOB_KINDS)[keyof typeof JOB_KINDS]

export interface AsyncJob {
  readonly id: string
  readonly companyId: string
  readonly userId: string | null
  readonly kind: string
  readonly title: string
  readonly status: JobStatus
  readonly progress: number
  readonly total: number
  readonly attempts: number
  readonly error: string
  readonly result: unknown
  readonly payload: unknown
  readonly createdAt: number
  readonly startedAt: number | null
  readonly finishedAt: number | null
  readonly leaseOwner: string | null
}

interface JobRow {
  id: string
  company_id: string
  user_id: string | null
  kind: string
  title: string
  status: string
  progress: number
  total: number
  attempts: number
  error: string | null
  result_json: string | null
  payload_json: string
  created_at: number
  started_at: number | null
  finished_at: number | null
  lease_owner: string | null
  lease_until: number | null
}

function parseJson(value: string | null): unknown {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function toJob(row: JobRow): AsyncJob {
  return {
    id: row.id,
    companyId: row.company_id,
    userId: row.user_id,
    kind: row.kind,
    title: row.title,
    status: (JOB_STATUS.includes(row.status as JobStatus) ? row.status : 'failed') as JobStatus,
    progress: Number(row.progress) || 0,
    total: Number(row.total) || 0,
    attempts: Number(row.attempts) || 0,
    error: row.error ?? '',
    result: parseJson(row.result_json),
    payload: parseJson(row.payload_json),
    createdAt: Number(row.created_at),
    startedAt: row.started_at === null ? null : Number(row.started_at),
    finishedAt: row.finished_at === null ? null : Number(row.finished_at),
    leaseOwner: row.lease_owner,
  }
}

export interface SubmitJobInput {
  readonly companyId: string
  readonly userId?: string | null
  readonly kind: string
  readonly title?: string
  readonly payload?: unknown
  readonly total?: number
}

/** 提交作业：落库为 queued，并尽量即时唤醒本实例/其它实例的 worker。 */
export function submitJob(db: Db, input: SubmitJobInput): AsyncJob {
  const id = `job_${randomUUID()}`
  const now = Date.now()
  db.prepare(
    `INSERT INTO async_jobs
       (id, company_id, user_id, kind, title, status, payload_json, progress, total, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'queued', ?, 0, ?, 0, ?, ?)`,
  ).run(
    id,
    input.companyId,
    input.userId ?? null,
    input.kind,
    (input.title ?? input.kind).slice(0, 120),
    JSON.stringify(input.payload ?? {}),
    Math.max(0, Math.trunc(input.total ?? 0)),
    now,
    now,
  )
  notifyJobQueue()
  return getJob(db, input.companyId, id) as AsyncJob
}

const LOCAL_WAKERS = new Set<() => void>()

/** 本实例 worker 立即开工；返回取消订阅函数。 */
function onLocalWake(listener: () => void): () => void {
  LOCAL_WAKERS.add(listener)
  return () => LOCAL_WAKERS.delete(listener)
}

function notifyJobQueue(): void {
  for (const wake of LOCAL_WAKERS) {
    try {
      wake()
    } catch {
      // 唤醒失败不影响轮询兜底
    }
  }
  const pubsub = getBackendRuntime()?.pubsub
  if (!pubsub) return
  void pubsub.publish(JOB_WAKE_CHANNEL, JSON.stringify({ kind: 'job-queued' })).catch(() => undefined)
}

export const JOB_WAKE_CHANNEL = 'jobs'

/** 跨实例唤醒：没有 Redis 时返回空函数。 */
export function initJobQueueBus(onWake: () => void): () => void {
  const pubsub = getBackendRuntime()?.pubsub
  if (!pubsub) return () => undefined
  let stopped = false
  let release: (() => void) | null = null
  void pubsub
    .subscribe(JOB_WAKE_CHANNEL, () => {
      if (!stopped) onWake()
    })
    .then((off) => {
      if (stopped) off()
      else release = off
    })
    .catch(() => undefined)
  return () => {
    stopped = true
    release?.()
  }
}

export interface ClaimOptions {
  readonly workerId: string
  readonly leaseMs?: number
  readonly kinds?: readonly string[]
}

/**
 * 抢一个排队中的作业。先查候选 id，再用「status 仍为 queued」的条件更新抢占；
 * 两个实例同时抢同一个 id 时只有一个 changes=1，另一个下一轮再抢。
 */
export function claimJob(db: Db, options: ClaimOptions): AsyncJob | null {
  const leaseMs = Math.max(30_000, options.leaseMs ?? 5 * 60_000)
  const kinds = options.kinds && options.kinds.length > 0 ? options.kinds : null
  const now = Date.now()
  const candidateSql = kinds
    ? `SELECT id FROM async_jobs WHERE status = 'queued' AND kind IN (${kinds.map(() => '?').join(',')})
        ORDER BY created_at ASC LIMIT 1`
    : `SELECT id FROM async_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`
  const candidate = (
    kinds
      ? db.prepare(candidateSql).get(...kinds)
      : db.prepare(candidateSql).get()
  ) as { id: string } | undefined
  if (!candidate) return null
  const updated = db
    .prepare(
      `UPDATE async_jobs
          SET status = 'running', lease_owner = ?, lease_until = ?, attempts = attempts + 1,
              started_at = COALESCE(started_at, ?), updated_at = ?
        WHERE id = ? AND status = 'queued'`,
    )
    .run(options.workerId, now + leaseMs, now, now, candidate.id)
  if (updated.changes !== 1) return null
  return getJobById(db, candidate.id)
}

export function heartbeatJob(db: Db, jobId: string, workerId: string, leaseMs = 5 * 60_000): void {
  const now = Date.now()
  db.prepare(
    `UPDATE async_jobs SET lease_until = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND lease_owner = ?`,
  ).run(now + leaseMs, now, jobId, workerId)
}

export function updateJobProgress(db: Db, jobId: string, patch: { progress?: number; total?: number }): void {
  const now = Date.now()
  db.prepare(
    `UPDATE async_jobs
        SET progress = COALESCE(?, progress), total = COALESCE(?, total), updated_at = ?
      WHERE id = ? AND status = 'running'`,
  ).run(
    patch.progress === undefined ? null : Math.max(0, Math.trunc(patch.progress)),
    patch.total === undefined ? null : Math.max(0, Math.trunc(patch.total)),
    now,
    jobId,
  )
}

export function completeJob(db: Db, jobId: string, workerId: string, result: unknown): void {
  const now = Date.now()
  const payload = result === undefined ? null : JSON.stringify(result)
  db.prepare(
    `UPDATE async_jobs
        SET status = 'succeeded', result_json = ?, error = '', progress = total,
            finished_at = ?, updated_at = ?, lease_owner = NULL, lease_until = NULL
      WHERE id = ? AND status = 'running' AND lease_owner = ?`,
  ).run(payload, now, now, jobId, workerId)
}

export function failJob(db: Db, jobId: string, workerId: string | null, error: string): void {
  const now = Date.now()
  if (workerId === null) {
    db.prepare(
      `UPDATE async_jobs
          SET status = 'failed', error = ?, finished_at = ?, updated_at = ?,
              lease_owner = NULL, lease_until = NULL
        WHERE id = ? AND status IN ('queued', 'running')`,
    ).run(error.slice(0, 500), now, now, jobId)
    return
  }
  db.prepare(
    `UPDATE async_jobs
        SET status = 'failed', error = ?, finished_at = ?, updated_at = ?,
            lease_owner = NULL, lease_until = NULL
      WHERE id = ? AND status = 'running' AND lease_owner = ?`,
  ).run(error.slice(0, 500), now, now, jobId, workerId)
}

/** 只取消还没开跑的作业；running 作业交给处理器自己的取消信号。 */
export function cancelJob(db: Db, jobId: string): boolean {
  const now = Date.now()
  const updated = db
    .prepare(
      `UPDATE async_jobs SET status = 'cancelled', finished_at = ?, updated_at = ?
        WHERE id = ? AND status = 'queued'`,
    )
    .run(now, now, jobId)
  return updated.changes === 1
}

/** 实例崩溃后把过期租约的 running 作业放回 queued；返回回收数量。 */
export function recoverStaleJobs(db: Db, now = Date.now()): number {
  const updated = db
    .prepare(
      `UPDATE async_jobs
          SET status = 'queued', lease_owner = NULL, lease_until = NULL, updated_at = ?
        WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until < ?`,
    )
    .run(now, now)
  return Number(updated.changes) || 0
}

function getJobById(db: Db, jobId: string): AsyncJob | null {
  const row = db.prepare('SELECT * FROM async_jobs WHERE id = ?').get(jobId) as JobRow | undefined
  return row ? toJob(row) : null
}

export function getJob(db: Db, companyId: string, jobId: string): AsyncJob | null {
  const row = db
    .prepare('SELECT * FROM async_jobs WHERE id = ? AND company_id = ?')
    .get(jobId, companyId) as JobRow | undefined
  return row ? toJob(row) : null
}

export function listJobs(db: Db, companyId: string, limit = 20): AsyncJob[] {
  const rows = db
    .prepare(
      `SELECT * FROM async_jobs WHERE company_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(companyId, Math.min(100, Math.max(1, Math.trunc(limit)))) as unknown as JobRow[]
  return rows.map(toJob)
}

export interface JobReport {
  progress(completed: number, total?: number): void
}

export type JobHandler = (job: AsyncJob, report: JobReport) => Promise<unknown>

export interface JobWorkerOptions {
  readonly db: Db
  readonly handlers: Readonly<Record<string, JobHandler>>
  readonly pollMs?: number
  readonly leaseMs?: number
  readonly concurrency?: number
  readonly instanceId?: string
}

/**
 * 启动 worker：轮询 + 本实例唤醒 + Redis 跨实例唤醒，三路都通往同一个 tick。
 * 同一实例内按 concurrency 控制并行作业数，避免一个实例把队列全吃满。
 */
export function startJobWorker(options: JobWorkerOptions): () => void {
  const workerId = options.instanceId ?? `worker_${randomUUID()}`
  const pollMs = Math.max(300, options.pollMs ?? 1_500)
  const leaseMs = Math.max(30_000, options.leaseMs ?? 5 * 60_000)
  const concurrency = Math.max(1, Math.min(8, options.concurrency ?? 2))
  const kinds = Object.keys(options.handlers)
  let running = 0
  let stopped = false
  let ticking = false

  const runJob = async (job: AsyncJob): Promise<void> => {
    const handler = options.handlers[job.kind]
    if (!handler) {
      failJob(options.db, job.id, workerId, `没有注册作业类型 ${job.kind} 的处理器`)
      return
    }
    const leaseTimer = setInterval(() => {
      try {
        heartbeatJob(options.db, job.id, workerId, leaseMs)
      } catch {
        // 心跳失败等租约过期后由 recoverStaleJobs 回收
      }
    }, Math.max(10_000, Math.floor(leaseMs / 3)))
    leaseTimer.unref?.()
    try {
      const result = await handler(job, {
        progress: (completed, total) => {
          updateJobProgress(options.db, job.id, { progress: completed, total })
        },
      })
      completeJob(options.db, job.id, workerId, result)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failJob(options.db, job.id, workerId, message || '作业执行失败')
    } finally {
      clearInterval(leaseTimer)
    }
  }

  const tick = async (): Promise<void> => {
    if (stopped || ticking) return
    ticking = true
    try {
      while (!stopped && running < concurrency) {
        const job = claimJob(options.db, { workerId, leaseMs, kinds })
        if (!job) break
        running += 1
        void runJob(job).finally(() => {
          running -= 1
          void tick()
        })
      }
    } finally {
      ticking = false
    }
  }

  const unwakeLocal = onLocalWake(() => void tick())
  const unbus = initJobQueueBus(() => void tick())
  const timer = setInterval(() => void tick(), pollMs)
  timer.unref?.()
  void tick()

  return () => {
    stopped = true
    clearInterval(timer)
    unwakeLocal()
    unbus()
  }
}
