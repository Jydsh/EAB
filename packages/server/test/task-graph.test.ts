import { afterEach, describe, expect, it } from 'vitest'
import { migrate, openDatabase, type Db } from '@eab/storage'
import {
  cancelTaskGraphRun,
  createTaskGraphRun,
  decideTaskGraphManual,
  getTaskGraphRun,
  getTaskGraphRunByTrace,
  listTaskGraphs,
  publishTaskGraph,
  recoverStaleTaskGraphRuns,
  resumeDueTaskGraphRuns,
  runTaskGraphRun,
  saveTaskGraph,
  startTaskGraphRun,
  validateTaskGraph,
  type TaskGraphDefinition,
  type TaskGraphExecutor,
} from '../src/task-graph.js'

const dbs: Db[] = []

afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
})

function testDb(): Db {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  dbs.push(db)
  db.prepare(
    `INSERT INTO companies (id, name, slug, status, created_at)
     VALUES ('c1', '测试公司', 'test', 'active', ?)`,
  ).run(Date.now())
  return db
}

function linearGraph(tool = 'kb.search', extra: Partial<TaskGraphDefinition['nodes'][number]> = {}): TaskGraphDefinition {
  return {
    entry: 'start',
    nodes: [
      { id: 'start', kind: 'start', title: '开始', nextIds: ['lookup'] },
      {
        id: 'lookup',
        kind: 'tool',
        title: '检索',
        tool,
        args: { query: '{{input.question}}' },
        nextIds: ['end'],
        ...extra,
      },
      { id: 'end', kind: 'end', title: '结束' },
    ],
  }
}

function published(graph: TaskGraphDefinition, name = '测试任务图'): string {
  const db = dbs[dbs.length - 1]
  const saved = saveTaskGraph(db, 'c1', 'tester', { name, definition: graph })
  publishTaskGraph(db, 'c1', 'tester', saved.id)
  return saved.id
}

function fakeExecutor(toolImpl?: (args: Record<string, unknown>) => unknown): TaskGraphExecutor & {
  toolCalls: Array<{ tool: string; args: Record<string, unknown> }>
  agentCalls: Array<{ prompt: string; modelId: string }>
} {
  const toolCalls: Array<{ tool: string; args: Record<string, unknown> }> = []
  const agentCalls: Array<{ prompt: string; modelId: string }> = []
  return {
    toolCalls,
    agentCalls,
    async runTool({ tool, args }) {
      toolCalls.push({ tool, args })
      return toolImpl ? toolImpl(args) : { hits: [{ title: '年休假制度' }], count: 1 }
    },
    async runAgent({ prompt, modelId }) {
      agentCalls.push({ prompt, modelId })
      return { text: `回答：${prompt}`, runId: 'agent-run-1' }
    },
  }
}

describe('task graph definition', () => {
  it('接受线性工具图，拒绝缺工具、循环和缺分支规则', () => {
    expect(validateTaskGraph(linearGraph())).toEqual({ valid: true, errors: [] })

    const explicitEmptyEnd = linearGraph()
    explicitEmptyEnd.nodes[2].nextIds = []
    expect(validateTaskGraph(explicitEmptyEnd)).toEqual({ valid: true, errors: [] })

    const missingTool = linearGraph()
    delete missingTool.nodes[1].tool
    expect(validateTaskGraph(missingTool).valid).toBe(false)

    const cycle: TaskGraphDefinition = {
      entry: 'start',
      nodes: [
        { id: 'start', kind: 'start', title: '开始', nextIds: ['a'] },
        { id: 'a', kind: 'tool', title: 'A', tool: 'kb.search', nextIds: ['b'] },
        { id: 'b', kind: 'tool', title: 'B', tool: 'kb.search', nextIds: ['a'] },
        { id: 'end', kind: 'end', title: '结束' },
      ],
    }
    expect(validateTaskGraph(cycle).valid).toBe(false)

    const badCondition: TaskGraphDefinition = {
      entry: 'start',
      nodes: [
        { id: 'start', kind: 'start', title: '开始', nextIds: ['cond'] },
        { id: 'cond', kind: 'condition', title: '判断', nextIds: ['yes', 'no'], edgeRules: { yes: { field: 'nodes.x.count', op: 'gte', value: 1 } } },
        { id: 'yes', kind: 'tool', title: '是', tool: 'kb.search', nextIds: ['end'] },
        { id: 'no', kind: 'end', title: '否' },
        { id: 'end', kind: 'end', title: '结束' },
      ],
    }
    expect(validateTaskGraph(badCondition).errors.join('；')).toContain('缺少判断规则')
  })

  it('拒绝重复节点 id 和人工拒绝边成环', () => {
    const duplicate: TaskGraphDefinition = {
      entry: 'start',
      nodes: [
        { id: 'start', kind: 'start', title: '开始', nextIds: ['a'] },
        { id: 'a', kind: 'tool', title: 'A1', tool: 'kb.search', nextIds: ['end'] },
        { id: 'a', kind: 'tool', title: 'A2', tool: 'kb.search', nextIds: ['end'] },
        { id: 'end', kind: 'end', title: '结束' },
      ],
    }
    expect(validateTaskGraph(duplicate).errors.join('；')).toContain('节点 id 重复：a')

    const rejectCycle: TaskGraphDefinition = {
      entry: 'start',
      nodes: [
        { id: 'start', kind: 'start', title: '开始', nextIds: ['manual'] },
        {
          id: 'manual',
          kind: 'manual',
          title: '审批',
          nextIds: ['end'],
          manual: { rejectNextId: 'start' },
        },
        { id: 'end', kind: 'end', title: '结束' },
      ],
    }
    expect(validateTaskGraph(rejectCycle).valid).toBe(false)
    expect(validateTaskGraph(rejectCycle).errors.join('；')).toContain('循环')
  })
})

describe('task graph versions and runs', () => {
  it('发布冻结版本，草稿不影响已发布运行，再次发布才切换', async () => {
    const db = testDb()
    const executor = fakeExecutor()
    const graphId = published(linearGraph('kb.search'), '版本隔离')
    const v1Run = await startTaskGraphRun(db, 'c1', 'u1', graphId, { question: '年假' }, executor)
    expect(v1Run.status).toBe('succeeded')
    expect(v1Run.traceId).toMatch(/^trace_/)
    expect(executor.toolCalls[0]).toEqual({ tool: 'kb.search', args: { query: '年假' } })

    const view = listTaskGraphs(db, 'c1').find((item) => item.id === graphId)
    expect(view?.version).toBe(1)
    saveTaskGraph(db, 'c1', 'tester', { id: graphId, name: '版本隔离', definition: linearGraph('other.tool') })
    expect(listTaskGraphs(db, 'c1').find((item) => item.id === graphId)?.draftVersion).toBe(2)

    // 只保存草稿时，运行仍使用已发布 v1。
    executor.toolCalls.length = 0
    const stillV1 = await startTaskGraphRun(db, 'c1', 'u1', graphId, {}, executor)
    expect(stillV1.graphVersion).toBe(1)
    expect(executor.toolCalls[0].tool).toBe('kb.search')

    publishTaskGraph(db, 'c1', 'tester', graphId)
    const v2 = await startTaskGraphRun(db, 'c1', 'u1', graphId, {}, executor)
    expect(v2.graphVersion).toBe(2)
    expect(executor.toolCalls[1].tool).toBe('other.tool')
  })

  it('执行工具 → 条件 → 子 Agent，并可按 traceId 查到完整步骤', async () => {
    const db = testDb()
    const executor = fakeExecutor(() => ({ count: 2, title: '命中' }))
    const definition: TaskGraphDefinition = {
      entry: 'start',
      nodes: [
        { id: 'start', kind: 'start', title: '开始', nextIds: ['lookup'] },
        { id: 'lookup', kind: 'tool', title: '检索', tool: 'kb.search', args: { query: '{{input.question}}' }, nextIds: ['branch'] },
        {
          id: 'branch',
          kind: 'condition',
          title: '有没有命中',
          nextIds: ['answer', 'empty'],
          edgeRules: {
            answer: { field: 'nodes.lookup.count', op: 'gte', value: 1 },
            empty: { else: true },
          },
        },
        {
          id: 'answer',
          kind: 'agent',
          title: '子 Agent 回答',
          agent: { modelId: 'model-1', prompt: '根据{{nodes.lookup.title}}回答{{input.question}}', maxRounds: 3 },
          nextIds: ['end'],
        },
        { id: 'empty', kind: 'end', title: '没命中结束' },
        { id: 'end', kind: 'end', title: '结束' },
      ],
    }
    const graphId = published(definition, '分支与子 Agent')
    const run = await startTaskGraphRun(db, 'c1', 'u1', graphId, { question: '怎么请假' }, executor)

    expect(run.status).toBe('succeeded')
    expect(run.steps.map((step) => step.nodeId)).toEqual(['start', 'lookup', 'branch', 'answer', 'end'])
    expect(executor.agentCalls[0]).toEqual({ modelId: 'model-1', prompt: '根据命中回答怎么请假' })
    const vars = run.variables as { nodes: Record<string, { text: string }> }
    expect(vars.nodes.answer.text).toBe('回答：根据命中回答怎么请假')

    const byTrace = getTaskGraphRunByTrace(db, 'c1', run.traceId)
    expect(byTrace.id).toBe(run.id)
    expect(byTrace.steps).toHaveLength(5)
    expect(byTrace.steps.find((step) => step.nodeId === 'branch')?.output).toEqual({ matchedNext: 'answer' })
  })

  it('条件未命中进入人工节点，人工通过后继续到结束', async () => {
    const db = testDb()
    const executor = fakeExecutor(() => ({ count: 0 }))
    const definition: TaskGraphDefinition = {
      entry: 'start',
      nodes: [
        { id: 'start', kind: 'start', title: '开始', nextIds: ['lookup'] },
        { id: 'lookup', kind: 'tool', title: '检索', tool: 'kb.search', args: {}, nextIds: ['branch'] },
        {
          id: 'branch',
          kind: 'condition',
          title: '有没有命中',
          nextIds: ['manual', 'end'],
          edgeRules: { manual: { field: 'nodes.lookup.count', op: 'eq', value: 0 }, end: { else: true } },
        },
        {
          id: 'manual',
          kind: 'manual',
          title: '人工确认',
          nextIds: ['end'],
          manual: { instructions: '确认是否继续', assigneeRole: 'super_admin' },
        },
        { id: 'end', kind: 'end', title: '结束' },
      ],
    }
    const graphId = published(definition, '人工确认')
    const run = await startTaskGraphRun(db, 'c1', 'u1', graphId, {}, executor)
    expect(run.status).toBe('waiting_manual')
    expect(run.currentNodeId).toBe('manual')
    expect(run.steps[run.steps.length - 1].status).toBe('waiting')

    const approved = await decideTaskGraphManual(db, 'c1', run.id, 'approved', '同意继续', executor)
    expect(approved.status).toBe('succeeded')
    expect(approved.steps.find((step) => step.nodeId === 'manual')?.output).toEqual({
      decision: 'approved',
      note: '同意继续',
    })
  })

  it('人工通过可先落库再由后台继续执行', async () => {
    const db = testDb()
    const executor = fakeExecutor()
    const definition: TaskGraphDefinition = {
      entry: 'start',
      nodes: [
        { id: 'start', kind: 'start', title: '开始', nextIds: ['manual'] },
        { id: 'manual', kind: 'manual', title: '审批', nextIds: ['end'] },
        { id: 'end', kind: 'end', title: '结束' },
      ],
    }
    const graphId = published(definition, '人工延后执行')
    const run = await startTaskGraphRun(db, 'c1', 'u1', graphId, {}, executor)
    expect(run.status).toBe('waiting_manual')

    const decided = await decideTaskGraphManual(
      db,
      'c1',
      run.id,
      'approved',
      '同意',
      executor,
      ['super_admin'],
      true,
    )
    expect(decided.status).toBe('running')
    expect(decided.steps.find((step) => step.nodeId === 'manual')?.status).toBe('succeeded')

    const finished = await runTaskGraphRun(db, 'c1', decided.id, executor)
    expect(finished.status).toBe('succeeded')
  })

  it('人工节点拒绝不在 assigneeRole 的处理人', async () => {
    const db = testDb()
    const definition: TaskGraphDefinition = {
      entry: 'start',
      nodes: [
        { id: 'start', kind: 'start', title: '开始', nextIds: ['manual'] },
        {
          id: 'manual',
          kind: 'manual',
          title: '审批',
          nextIds: ['end'],
          manual: { assigneeRole: 'super_admin' },
        },
        { id: 'end', kind: 'end', title: '结束' },
      ],
    }
    const graphId = published(definition, '人工角色')
    const run = await startTaskGraphRun(db, 'c1', 'u1', graphId, {}, fakeExecutor())
    expect(run.status).toBe('waiting_manual')
    await expect(
      decideTaskGraphManual(db, 'c1', run.id, 'approved', '同意', fakeExecutor(), ['member']),
    ).rejects.toThrow('只允许角色')
  })

  it('人工拒绝且没有拒绝分支时直接结束为 rejected', async () => {
    const db = testDb()
    const executor = fakeExecutor()
    const definition: TaskGraphDefinition = {
      entry: 'start',
      nodes: [
        { id: 'start', kind: 'start', title: '开始', nextIds: ['manual'] },
        { id: 'manual', kind: 'manual', title: '审批', nextIds: ['end'] },
        { id: 'end', kind: 'end', title: '结束' },
      ],
    }
    const graphId = published(definition, '人工拒绝')
    const run = await startTaskGraphRun(db, 'c1', 'u1', graphId, {}, executor)
    expect(run.status).toBe('waiting_manual')
    const rejected = await decideTaskGraphManual(db, 'c1', run.id, 'rejected', '资料不足', executor)
    expect(rejected.status).toBe('rejected')
    expect(rejected.error).toContain('资料不足')
  })

  it('等待节点到点后由 worker 自动恢复并完成', async () => {
    const db = testDb()
    const executor = fakeExecutor()
    const definition: TaskGraphDefinition = {
      entry: 'start',
      nodes: [
        { id: 'start', kind: 'start', title: '开始', nextIds: ['sleep'] },
        { id: 'sleep', kind: 'wait', title: '等待一分钟', wait: { durationSec: 1 }, nextIds: ['end'] },
        { id: 'end', kind: 'end', title: '结束' },
      ],
    }
    const graphId = published(definition, '等待恢复')
    const run = await startTaskGraphRun(db, 'c1', 'u1', graphId, {}, executor)
    expect(run.status).toBe('waiting_wait')
    expect(run.waiting?.kind).toBe('wait')

    const resumed = await resumeDueTaskGraphRuns(db, 'c1', executor, Date.now() + 2500)
    expect(resumed).toBe(1)
    const after = getTaskGraphRun(db, 'c1', run.id)
    expect(after.status).toBe('succeeded')
    expect(after.steps.find((step) => step.nodeId === 'sleep')?.status).toBe('succeeded')
  })

  it('未发布不能运行，名称重复会被拒绝', async () => {
    const db = testDb()
    const saved = saveTaskGraph(db, 'c1', 'tester', { name: '草稿图', definition: linearGraph() })
    expect(() => saveTaskGraph(db, 'c1', 'tester', { name: '草稿图', definition: linearGraph() }))
      .toThrow('任务图名称已存在')
    await expect(startTaskGraphRun(db, 'c1', 'u1', saved.id, {}, fakeExecutor())).rejects.toThrow(
      '还没有发布',
    )
  })
})

describe('task graph leases and cancellation', () => {
  it('新建运行立即返回 running，后台执行完成后可查到 succeeded', async () => {
    const db = testDb()
    const graphId = published(linearGraph(), '后台运行')
    const created = createTaskGraphRun(db, 'c1', 'u1', graphId, { question: '年假' })
    expect(created.status).toBe('running')
    const done = await runTaskGraphRun(db, 'c1', created.id, fakeExecutor())
    expect(done.status).toBe('succeeded')
    expect(done.steps.map((step) => step.nodeId)).toEqual(['start', 'lookup', 'end'])
  })

  it('取消会中止在途工具并把运行和步骤标为 cancelled', async () => {
    const db = testDb()
    const graphId = published(linearGraph('slow.tool'), '取消运行')
    const created = createTaskGraphRun(db, 'c1', 'u1', graphId, { question: '年假' })
    let started!: () => void
    const toolStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const executor: TaskGraphExecutor = {
      async runTool({ signal }) {
        started()
        return await new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
      async runAgent() {
        return { text: '不应该执行' }
      },
    }
    const execution = runTaskGraphRun(db, 'c1', created.id, executor)
    await toolStarted
    const cancelled = cancelTaskGraphRun(db, 'c1', created.id)
    expect(cancelled.status).toBe('cancelled')
    expect((await execution).status).toBe('cancelled')
    const after = getTaskGraphRun(db, 'c1', created.id)
    expect(after.status).toBe('cancelled')
    expect(after.steps.find((step) => step.nodeId === 'lookup')?.status).toBe('cancelled')
  })

  it('租约过期的 running 运行会被回收为 failed', () => {
    const db = testDb()
    const graphId = published(linearGraph(), '崩溃恢复')
    const created = createTaskGraphRun(db, 'c1', 'u1', graphId, {})
    db.prepare(
      `UPDATE task_graph_runs SET lease_until = ?, updated_at = ? WHERE id = ?`,
    ).run(Date.now() - 1000, Date.now() - 1000, created.id)
    expect(recoverStaleTaskGraphRuns(db, 'c1')).toBe(1)
    expect(getTaskGraphRun(db, 'c1', created.id).status).toBe('failed')
  })
})
