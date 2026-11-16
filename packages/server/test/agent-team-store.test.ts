import { beforeEach, describe, expect, it } from 'vitest'
import { migrate, openDatabase, type Db } from '@eab/storage'
import { AgentTeamStore, recoverInterruptedAgentTasks } from '../src/agent-team.js'

describe('AgentTeamStore 持久化团队', () => {
  let db: Db

  beforeEach(() => {
    db = openDatabase({ path: ':memory:' })
    migrate(db)
  })

  function store(teamId = 'session:s1'): AgentTeamStore {
    return new AgentTeamStore({ db, teamId, companyId: 'c1', userId: 'u1', idleMs: 120_000 })
  }

  it('两个 store 实例共享同一团队的 worker、消息和任务', () => {
    const a = store()
    a.registerWorker({ key: 'research-a', name: '资料 A', index: 1 }, 1000)
    a.appendWorkerMessage('research-a', 'user', '查一下安全巡检流程', 1100)
    a.appendWorkerMessage('research-a', 'assistant', '知识库里没有这条制度', 1200)
    a.createTask({ workerKey: 'research-a', prompt: '继续查 2025 年版本', parentRunId: 'run-1', now: 1300 })

    const b = store()
    expect(b.findWorker('research-a')?.name).toBe('资料 A')
    expect(b.workerMessages('research-a').map((message) => message.content))
      .toEqual(['查一下安全巡检流程', '知识库里没有这条制度'])
    expect(b.listTasks(10)[0].status).toBe('queued')
  })

  it('waiting 不会被空闲清理误删，idle 超期才会注销', () => {
    const s = store()
    s.registerWorker({ key: 'a', name: 'A' }, 1000)
    s.markWorkerWaiting('a', '要查哪个部门？', 1000)
    expect(s.pruneIdleWorkers(999_999)).toEqual([])
    expect(s.findWorker('a')?.status).toBe('waiting')

    s.markWorkerIdle('a', '完成', 1000)
    expect(s.pruneIdleWorkers(122_100)).toEqual(['a'])
    expect(s.findWorker('a')).toBeUndefined()
  })

  it('事件先落库再唤醒等待者，父 Agent 只消费一次', async () => {
    const s = store()
    s.registerWorker({ key: 'a', name: 'A' })
    const waiting = s.waitForEvent(50)
    s.recordEvent({ workerKey: 'a', kind: 'question', payload: { text: '要哪个部门？' }, taskId: 'task-1' })
    const event = await waiting
    expect(event?.kind).toBe('question')
    expect(event?.payload).toEqual({ text: '要哪个部门？' })

    // 已消费：再次等待不会重复拿到同一条
    expect(await s.waitForEvent(0)).toBeNull()
  })

  it('父 Agent 的追加指示只由子 Agent 取走一次', () => {
    const s = store()
    s.sendGuidance('a', '优先看 2025 年数据', 1000)
    expect(s.takeGuidance('a')).toEqual(['优先看 2025 年数据'])
    expect(s.takeGuidance('a')).toEqual([])
  })

  it('子 Agent 提问也能唤醒父 Agent，回答后完成会重新获得唤醒资格', () => {
    const s = store()
    const task = s.createTask({ workerKey: 'a', prompt: '需要确认部门', parentRunId: 'run-1' })
    s.markTaskRunning(task.id, 'child-1')
    s.recordEvent({ workerKey: 'a', kind: 'question', taskId: task.id, payload: { text: '要查哪个部门？' } })
    expect(s.listTasksAwaitingWake(10).map((item) => item.id)).toEqual([task.id])

    s.markTasksWoken([task.id], 2000)
    expect(s.listTasksAwaitingWake(10)).toEqual([])

    // 同一个任务回答完再结束，不能沿用上一次的 wake_at 而永久失去唤醒机会。
    s.recordEvent({ workerKey: 'a', kind: 'done', taskId: task.id, payload: { text: '已经查完' } })
    s.markTaskDone(task.id, '最终结果', 3000)
    expect(s.listTasksAwaitingWake(10).map((item) => item.id)).toEqual([task.id])
  })

  it('任务结束只唤醒父 Agent 一次；重启收尾把 running 任务标为失败并保留检查点', () => {
    const s = store()
    const task = s.createTask({ workerKey: 'a', prompt: '长任务', parentRunId: 'run-1' })
    s.markTaskRunning(task.id, 'child-1')
    s.markTaskDone(task.id, '阶段成果', 2000)
    expect(s.listTasksAwaitingWake(10).map((item) => item.id)).toEqual([task.id])
    s.markTasksWoken([task.id], 3000)
    expect(s.listTasksAwaitingWake(10)).toEqual([])
    expect(s.getTask(task.id)?.wakeAt).toBe(3000)

    const interrupted = s.createTask({ workerKey: 'b', prompt: '另一个长任务', parentRunId: 'run-1' })
    s.markTaskRunning(interrupted.id, 'child-2')
    s.registerWorker({ key: 'b', name: 'B' })
    s.markWorkerRun('b', 'child-2', 4000)
    s.markTasksWoken([interrupted.id], 4500)
    const count = recoverInterruptedAgentTasks(db, 5000)
    expect(count).toBe(1)
    expect(s.getTask(interrupted.id)?.status).toBe('failed')
    expect(s.getTask(interrupted.id)?.wakeAt).toBeNull()
    expect(s.getTask(interrupted.id)?.error).toContain('检查点已保留')
    expect(s.findWorker('b')?.status).toBe('idle')
    expect(s.listPendingEvents(10).some((event) => event.taskId === interrupted.id && event.kind === 'error'))
      .toBe(true)
  })
})
