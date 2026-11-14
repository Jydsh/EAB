import { describe, expect, it } from 'vitest'
import { migrate, openDatabase } from '@eab/storage'
import {
  activeAgentRunCount,
  cancelAgentRunTree,
  listAgentRuns,
  recordAgentStep,
  startAgentRun,
  sweepOrphanAgentRuns,
} from '../src/agent-runtime.js'
import { isRunAlive } from '../src/backends/coordination.js'

function db() {
  const database = openDatabase({ path: ':memory:' })
  migrate(database)
  return database
}

const base = {
  companyId: 'c1',
  userId: 'u1',
  modelId: 'm1',
}

describe('Agent 运行树', () => {
  it('记录父子 run 和工具步骤，并按深度返回运行树', () => {
    const database = db()
    const parent = startAgentRun(database, { ...base, id: 'root', agentId: 'eab-main', title: '总任务' })
    recordAgentStep(database, {
      runId: parent.id,
      seq: 0,
      kind: 'tool',
      toolId: 'agent.spawn',
      name: '并行子 Agent',
      status: 'done',
      resultSummary: '派发两个子任务',
      durationMs: 12,
    })
    const childA = startAgentRun(database, {
      ...base,
      id: 'child-a',
      parentRunId: parent.id,
      agentId: 'sub-1',
      title: '子任务 A',
      sessionId: 'agent:child-a',
    })
    recordAgentStep(database, {
      runId: childA.id,
      seq: 0,
      kind: 'tool',
      toolId: 'kb.search',
      name: '知识库检索',
      status: 'done',
      durationMs: 30,
    })
    const childB = startAgentRun(database, {
      ...base,
      id: 'child-b',
      parentRunId: parent.id,
      agentId: 'sub-2',
      title: '子任务 B',
      sessionId: 'agent:child-b',
    })

    childA.finish('succeeded', null, 100)
    childB.finish('failed', '子任务 B 失败')
    parent.finish('succeeded', null, 200)

    const runs = listAgentRuns(database, 'c1')
    expect(runs).toHaveLength(3)
    const root = runs.find((run) => run.id === 'root')
    const a = runs.find((run) => run.id === 'child-a')
    const b = runs.find((run) => run.id === 'child-b')
    expect(root?.depth).toBe(0)
    expect(a?.parentRunId).toBe('root')
    expect(a?.depth).toBe(1)
    expect(a?.steps).toHaveLength(1)
    expect(a?.steps[0]?.toolId).toBe('kb.search')
    expect(b?.status).toBe('failed')
    expect(b?.error).toBe('子任务 B 失败')
  })

  it('取消父任务会级联取消子任务并中止子任务 signal', () => {
    const database = db()
    const parent = startAgentRun(database, { ...base, id: 'root-cancel', agentId: 'eab-main' })
    const child = startAgentRun(database, { ...base, id: 'child-cancel', parentRunId: parent.id })
    expect(activeAgentRunCount()).toBe(2)

    cancelAgentRunTree(database, parent.id, '用户取消了父任务')

    expect(child.signal.aborted).toBe(true)
    const runs = listAgentRuns(database, 'c1')
    expect(runs.find((run) => run.id === parent.id)?.status).toBe('cancelled')
    expect(runs.find((run) => run.id === child.id)?.status).toBe('cancelled')
  })

  it('启动清理只回收没有心跳的僵尸 run，活着的 run 不动', async () => {
    const database = db()
    // 模拟上次进程异常退出遗留：库里是 running，但没有心跳
    database
      .prepare(
        `INSERT INTO agent_runs
          (id, company_id, user_id, agent_id, status, spent_tokens, started_at, created_at)
         VALUES ('zombie-run', 'c1', 'u1', 'eab-main', 'running', 0, ?, ?)`,
      )
      .run(Date.now() - 3_600_000, Date.now() - 3_600_000)

    const live = startAgentRun(database, { ...base, id: 'live-run' })
    expect(await isRunAlive('live-run')).toBe(true)

    const swept = await sweepOrphanAgentRuns(database)
    expect(swept).toBe(1)

    const rows = database
      .prepare(`SELECT id, status FROM agent_runs ORDER BY id`)
      .all() as unknown as Array<{ id: string; status: string }>
    expect(rows.find((row) => row.id === 'zombie-run')?.status).toBe('cancelled')
    expect(rows.find((row) => row.id === 'live-run')?.status).toBe('running')
    live.finish('succeeded')
  })
})
