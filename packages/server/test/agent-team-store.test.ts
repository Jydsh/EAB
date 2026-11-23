import { beforeEach, describe, expect, it } from 'vitest'
import { migrate, openDatabase, type Db } from '@eab/storage'
import { AgentTeamStore, listRestartRecoveredTasks, recoverInterruptedAgentTasks } from '../src/agent-team.js'
import { protocolStatusOf } from '../src/agent-protocol.js'

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

  it('waiting 不会被空闲清理误删，idle 超期只软注销，保留窗口和消息', () => {
    const s = store()
    s.registerWorker({ key: 'a', name: 'A' }, 1000)
    s.markWorkerWaiting('a', '要查哪个部门？', 1000)
    expect(s.pruneIdleWorkers(999_999)).toEqual([])
    expect(s.findWorker('a')?.status).toBe('waiting')

    s.appendWorkerMessage('a', 'user', '继续查这个部门', 1100)
    s.markWorkerIdle('a', '完成', 1000)
    expect(s.pruneIdleWorkers(122_100)).toEqual(['a'])
    expect(s.findWorker('a')?.status).toBe('retired')
    expect(s.listWorkers()).toEqual([])
    expect(s.listAllWorkers().map((worker) => worker.key)).toEqual(['a'])
    expect(s.workerMessages('a').map((message) => message.content)).toEqual(['继续查这个部门'])
  })

  it('团队树按 parentKey 表达直属归属，critic 与 producer 平级', () => {
    const s = store()
    s.registerWorker({ key: 'producer', name: '产出', role: 'producer', index: 1 })
    s.registerWorker({ key: 'critic', name: '评审', role: 'critic', index: 2 })
    s.registerWorker({ key: 'builder', name: '实现', role: 'builder', index: 3 })
    const tree = s.teamTree()
    expect(tree.map((node) => node.key)).toEqual(['producer', 'critic', 'builder'])
    expect(tree.find((node) => node.key === 'critic')?.parentKey).toBeNull()
  })

  it('固定岗位注销后同 key 再派发会清空注销标记并复用原岗', () => {
    const s = store()
    s.registerWorker({ key: 'producer', name: '产出岗', role: 'producer', acceptance: '旧验收' }, 1000)
    s.markWorkerIdle('producer', '旧稿', 1000)
    s.retireWorker('producer', '本轮结束', { now: 2000 })
    expect(s.listWorkers()).toEqual([])

    const revived = s.registerWorker({
      key: 'producer', name: '产出岗', role: 'producer', acceptance: '新验收', pinned: true,
    }, 3000)
    expect(revived.status).toBe('running')
    expect(revived.retiredAt).toBeNull()
    expect(revived.acceptance).toBe('新验收')
    expect(revived.pinned).toBe(true)
    expect(s.listWorkers().map((worker) => worker.key)).toEqual(['producer'])
  })

  it('团队容量满时先软注销最老的空闲非固定岗位', () => {
    const s = new AgentTeamStore({
      db, teamId: 'session:s1', companyId: 'c1', userId: 'u1', maxWorkers: 2,
    })
    s.registerWorker({ key: 'a', name: 'A', pinned: true }, 1000)
    s.markWorkerIdle('a', '', 1000)
    s.registerWorker({ key: 'b', name: 'B' }, 2000)
    s.markWorkerIdle('b', '', 2000)

    expect(s.ensureCapacity(['c'])).toEqual(['b'])
    expect(s.listWorkers().map((worker) => worker.key)).toEqual(['a'])
    expect(s.findWorker('b')?.status).toBe('retired')
    expect(s.findWorker('a')?.pinned).toBe(true)
  })

  it('容量满且没有可淘汰的空闲岗位时明确报错，不静默丢任务', () => {
    const s = new AgentTeamStore({
      db, teamId: 'session:s1', companyId: 'c1', userId: 'u1', maxWorkers: 2,
    })
    s.registerWorker({ key: 'a', name: 'A' }, 1000)
    s.registerWorker({ key: 'b', name: 'B' }, 2000)
    s.markWorkerWaiting('a', '等回答', 1000)
    expect(() => s.ensureCapacity(['c'])).toThrow(/团队活跃岗位已满/)
  })

  it('手动注销 running 岗位默认拒绝，force 时取消任务并保留窗口', () => {
    const s = store()
    s.registerWorker({ key: 'a', name: 'A' }, 1000)
    const task = s.createTask({ workerKey: 'a', prompt: '长任务', parentRunId: 'run-1', now: 1000 })
    s.markTaskRunning(task.id, 'child-1', 1000)
    s.appendWorkerMessage('a', 'user', '长任务上下文', 1000)

    expect(() => s.retireWorker('a', '收岗')).toThrow(/正在执行/)
    const retired = s.retireWorker('a', '收岗', { force: true, now: 2000 })
    expect(retired.status).toBe('retired')
    expect(s.getTask(task.id)?.status).toBe('cancelled')
    expect(s.workerMessages('a').map((message) => message.content)).toEqual(['长任务上下文'])
    expect(s.listWorkers()).toEqual([])
  })

  it('等待父 Agent 回答超时会注销，超过保留期才硬清理', () => {
    const s = new AgentTeamStore({
      db, teamId: 'session:s1', companyId: 'c1', userId: 'u1',
      waitingTtlMs: 1000, retentionMs: 5000,
    })
    s.registerWorker({ key: 'a', name: 'A' }, 1000)
    s.markWorkerWaiting('a', '要查哪个部门？', 1000)
    expect(s.pruneStaleWaiting(3000)).toEqual(['a'])
    expect(s.findWorker('a')?.status).toBe('retired')

    expect(s.purgeRetiredWorkers(9000)).toEqual(['a'])
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
    const historical = s.createTask({ workerKey: 'b', prompt: '上一次已完成的任务', parentRunId: 'run-1' })
    s.markTaskDone(historical.id, '旧结果', 4600)
    expect(s.listTasksAwaitingWake(10).map((item) => item.id)).toEqual([historical.id])
    const count = recoverInterruptedAgentTasks(db, 5000)
    expect(count).toBe(1)
    expect(s.getTask(interrupted.id)?.status).toBe('failed')
    expect(s.getTask(interrupted.id)?.wakeAt).toBeNull()
    expect(s.getTask(interrupted.id)?.error).toContain('检查点已保留')
    expect(s.findWorker('b')?.status).toBe('idle')
    expect(s.listPendingEvents(10).some((event) => event.taskId === interrupted.id && event.kind === 'error'))
      .toBe(true)
    // 只有本次重启收尾的任务带 restart 标记；按 id 过滤时不能把历史任务一起叫醒。
    expect(listRestartRecoveredTasks(db).map((item) => item.id)).toEqual([interrupted.id])
    expect(s.listTasksAwaitingWake(10, [interrupted.id]).map((item) => item.id)).toEqual([interrupted.id])
    expect(s.listTasksAwaitingWake(10, [historical.id]).map((item) => item.id)).toEqual([historical.id])
  })

  it('重启收尾把等待父 Agent 的岗位也收回 idle，不留下永久等待', () => {
    const s = store()
    s.registerWorker({ key: 'asker', name: '等待岗位' })
    const task = s.createTask({ workerKey: 'asker', prompt: '等父 Agent 答复', parentRunId: 'run-1' })
    s.markTaskRunning(task.id, 'child-ask')
    s.markWorkerWaiting('asker', '需要父 Agent 回答', 1000)
    expect(s.findWorker('asker')?.status).toBe('waiting')

    expect(recoverInterruptedAgentTasks(db, 2000)).toBe(1)
    expect(s.getTask(task.id)?.status).toBe('failed')
    expect(s.findWorker('asker')?.status).toBe('idle')
    expect(s.findWorker('asker')?.lastTaskAt).toBe(2000)
    expect(s.findWorker('asker')?.lastText).toContain('服务重启中断')
  })

  it('任务携带 context、trace、输入和预算，兼容原有 status', () => {
    const s = store()
    const task = s.createTask({
      workerKey: 'a',
      prompt: '整理材料',
      parentRunId: 'run-root',
      contextId: 'ctx-1',
      traceId: 'trace-1',
      input: { fileId: 'file-1', mode: 'read' },
      budget: { maxTokens: 1200, maxRounds: 4, maxCostMicros: -1 },
      deadlineAt: 9000,
      now: 1000,
    })

    expect(task.status).toBe('queued')
    expect(task.contextId).toBe('ctx-1')
    expect(task.traceId).toBe('trace-1')
    expect(task.input).toEqual({ fileId: 'file-1', mode: 'read' })
    expect(task.budget).toEqual({ maxTokens: 1200, maxRounds: 4 })
    expect(task.deadlineAt).toBe(9000)
    expect(task.phase).toBe('none')
    expect(task.artifacts).toEqual([])
    expect(s.getTask(task.id)?.contextId).toBe('ctx-1')
  })

  it('暂停原因与生命周期正交，完成时清空暂停但保留产物', () => {
    const s = store()
    const task = s.createTask({ workerKey: 'a', prompt: '写报告', traceId: 'trace-2', now: 1000 })
    s.markTaskRunning(task.id, 'child-1', 1000)
    s.markTaskPhase(task.id, 'auth_required', '需要审批导出权限', 1100)
    expect(s.getTask(task.id)?.status).toBe('running')
    expect(s.getTask(task.id)?.phase).toBe('auth_required')
    expect(protocolStatusOf('running', 'auth_required')).toBe('auth-required')

    s.markTaskDone(task.id, '报告已生成', 1200, [{
      id: 'art-1',
      name: 'report.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 12,
      checksum: 'abc',
      source: 'workspace',
      uri: 'workspace://report.docx',
    }])
    expect(s.getTask(task.id)?.status).toBe('succeeded')
    expect(s.getTask(task.id)?.phase).toBe('none')
    expect(s.getTask(task.id)?.rejectReason).toBe('')
    expect(s.listArtifacts(task.id)).toHaveLength(1)
    expect(s.listArtifacts(task.id)[0].name).toBe('report.docx')
  })

  it('拒绝是独立原因，不伪装成普通失败', () => {
    const s = store()
    const task = s.createTask({ workerKey: 'a', prompt: '越权操作', traceId: 'trace-3' })
    s.markTaskRejected(task.id, '缺少数据权限，不能执行', 2000)
    const stored = s.getTask(task.id)
    expect(stored?.status).toBe('failed')
    expect(stored?.phase).toBe('rejected')
    expect(stored?.rejectReason).toContain('缺少数据权限')
    expect(protocolStatusOf(stored!.status, stored!.phase)).toBe('rejected')
  })

  it('按 trace 找回同一回合的父任务，事件继承任务的上下文', () => {
    const s = store()
    const first = s.createTask({ workerKey: 'a', prompt: '第一步', traceId: 'trace-4', now: 1000 })
    const second = s.createTask({ workerKey: 'b', prompt: '第二步', traceId: 'trace-4', now: 2000 })
    expect(s.listTasksByTrace('trace-4').map((task) => task.id)).toEqual([first.id, second.id])

    const event = s.recordEvent({
      workerKey: 'a',
      kind: 'question',
      taskId: first.id,
      payload: { text: '要哪个口径？' },
      now: 3000,
    })
    expect(event.contextId).toBe(first.contextId)
    expect(event.traceId).toBe('trace-4')
    expect(s.listPendingEvents(10)[0]).toMatchObject({
      contextId: first.contextId,
      traceId: 'trace-4',
    })
  })

  it('任务用量单独更新，不覆盖状态和产物', () => {
    const s = store()
    const task = s.createTask({ workerKey: 'a', prompt: '长任务', now: 1000 })
    s.markTaskDone(task.id, '完成', 2000)
    s.markTaskUsage(task.id, 321, 7, 3000)
    expect(s.getTask(task.id)?.usedTokens).toBe(321)
    expect(s.getTask(task.id)?.usedCostMicros).toBe(7)
    expect(s.getTask(task.id)?.status).toBe('succeeded')
  })
})
