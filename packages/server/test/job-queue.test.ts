import { describe, expect, it } from 'vitest'
import { migrate, openDatabase } from '@eab/storage'
import {
  JOB_KINDS,
  claimJob,
  completeJob,
  failJob,
  getJob,
  listJobs,
  recoverStaleJobs,
  startJobWorker,
  submitJob,
} from '../src/job-queue.js'

function testDb() {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  return db
}

describe('异步作业队列', () => {
  it('提交后立刻返回 queued 作业，任何实例都能按 id 回读', () => {
    const db = testDb()
    const job = submitJob(db, {
      companyId: 'c1',
      kind: JOB_KINDS.pluginChannelRefresh,
      title: '刷新通道',
      payload: { channelId: 'ch1' },
    })
    expect(job.status).toBe('queued')
    expect(job.payload).toEqual({ channelId: 'ch1' })
    expect(getJob(db, 'c1', job.id)?.status).toBe('queued')
    expect(listJobs(db, 'c1').length).toBe(1)
    // 别的公司读不到
    expect(getJob(db, 'c2', job.id)).toBeNull()
  })

  it('同一个作业只会被一个 worker 抢到', () => {
    const db = testDb()
    const job = submitJob(db, { companyId: 'c1', kind: JOB_KINDS.pluginChannelRefresh })
    const first = claimJob(db, { workerId: 'w1' })
    const second = claimJob(db, { workerId: 'w2' })
    expect(first?.id).toBe(job.id)
    expect(first?.status).toBe('running')
    expect(second).toBeNull()
  })

  it('租约过期的 running 作业会被放回队列', () => {
    const db = testDb()
    const job = submitJob(db, { companyId: 'c1', kind: JOB_KINDS.pluginChannelRefresh })
    claimJob(db, { workerId: 'w1', leaseMs: 30_000 })
    expect(recoverStaleJobs(db, Date.now())).toBe(0)
    expect(recoverStaleJobs(db, Date.now() + 60_000)).toBe(1)
    expect(getJob(db, 'c1', job.id)?.status).toBe('queued')
    const retried = claimJob(db, { workerId: 'w2' })
    expect(retried?.id).toBe(job.id)
    expect(retried?.attempts).toBe(2)
  })

  it('worker 跑完处理器后写回结果', async () => {
    const db = testDb()
    const job = submitJob(db, {
      companyId: 'c1',
      kind: JOB_KINDS.pluginChannelRefresh,
      payload: { channelId: 'ch1' },
    })
    let handled = ''
    const stop = startJobWorker({
      db,
      pollMs: 300,
      handlers: {
        [JOB_KINDS.pluginChannelRefresh]: async (claimed, report) => {
          handled = claimed.id
          report.progress(1, 1)
          return { channelId: 'ch1', checked: 2, models: 2 }
        },
      },
      instanceId: 'worker-test',
    })
    try {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const current = getJob(db, 'c1', job.id)
        if (current?.status === 'succeeded') break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      const finished = getJob(db, 'c1', job.id)
      expect(handled).toBe(job.id)
      expect(finished?.status).toBe('succeeded')
      expect(finished?.result).toEqual({ channelId: 'ch1', checked: 2, models: 2 })
      expect(finished?.progress).toBe(finished?.total)
    } finally {
      stop()
    }
  })

  it('处理器抛错时作业标 failed 并保留原因', async () => {
    const db = testDb()
    const job = submitJob(db, { companyId: 'c1', kind: JOB_KINDS.pluginChannelRefresh })
    const claimed = claimJob(db, { workerId: 'w1' })
    expect(claimed?.id).toBe(job.id)
    failJob(db, job.id, 'w1', '上游超时')
    const failed = getJob(db, 'c1', job.id)
    expect(failed?.status).toBe('failed')
    expect(failed?.error).toContain('上游超时')
    // 已经失败的作业不会被再次抢到
    expect(claimJob(db, { workerId: 'w2' })).toBeNull()
  })

  it('成功作业写回 result，且清空租约', () => {
    const db = testDb()
    const job = submitJob(db, { companyId: 'c1', kind: JOB_KINDS.pluginChannelRefresh })
    claimJob(db, { workerId: 'w1' })
    completeJob(db, job.id, 'w1', { checked: 3 })
    const done = getJob(db, 'c1', job.id)
    expect(done?.status).toBe('succeeded')
    expect(done?.result).toEqual({ checked: 3 })
    expect(done?.leaseOwner).toBeNull()
  })
})
