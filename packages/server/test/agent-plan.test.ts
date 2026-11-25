import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { migrate, openDatabase, type Db } from '@eab/storage'
import { SC } from '@eab/domain'
import type { ServerConfig } from '../src/config.js'
import type { ServerDeps } from '../src/deps.js'
import { buildApp } from '../src/app.js'
import {
  getCurrentAgentPlan,
  updateAgentPlanStep,
  writeAgentPlan,
} from '../src/agent-plan.js'
import { executeTool, toolSpecsForAgent } from '../src/routes/tools.js'

describe('Agent Plan 对象与版本化', () => {
  let db: Db
  let root: string
  let deps: ServerDeps
  let actor: any

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'eab-agent-plan-'))
    db = openDatabase({ path: join(root, 'eab.sqlite') })
    migrate(db)
    const now = Date.now()
    db.prepare("INSERT INTO companies (id, name, slug, status, created_at) VALUES ('c1', '测试公司', 'test-plan', 'active', ?)").run(now)
    db.prepare("INSERT INTO companies (id, name, slug, status, created_at) VALUES ('c2', '另一家公司', 'test-plan-other', 'active', ?)").run(now)
    db.prepare("INSERT INTO departments (id, company_id, name, path, depth, order_no, created_at) VALUES ('d1', 'c1', '测试部门', '/c1/d1/', 1, 0, ?)").run(now)
    db.prepare("INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at) VALUES ('u1', 'c1', 'd1', '/c1/d1/', '测试员工', 'active', ?, ?)").run(now, now)
    db.prepare("INSERT INTO chat_sessions (id, company_id, user_id, title, created_at, updated_at) VALUES ('s1', 'c1', 'u1', '计划测试', ?, ?)").run(now, now)
    db.prepare("INSERT INTO chat_sessions (id, company_id, user_id, title, created_at, updated_at) VALUES ('s2', 'c1', 'u1', '另一个会话', ?, ?)").run(now, now)

    const config = {
      dbPath: join(root, 'eab.sqlite'),
      dataDir: join(root, 'data'),
      tmpDir: join(root, 'tmp'),
      companyId: 'c1',
      devAuth: true,
      logLevel: 'silent',
      onlyOfficeUrl: '',
      onlyOfficeJwtSecret: '',
      onlyOfficeInternalUrl: '',
    } as ServerConfig
    deps = { db, config, companyId: 'c1', migrations: [], consoleToken: 'test-token' } as ServerDeps
    actor = {
      subject: {
        companyId: 'c1',
        userId: 'u1',
        status: 'active',
        deptId: 'd1',
        deptPath: '/d1',
        deptChain: [],
        roles: [],
        scopes: new Set(Object.values(SC)),
      },
      person: {
        id: 'u1',
        name: '测试员工',
        deptId: 'd1',
        deptPath: '/d1',
        deptName: '测试部门',
        companyId: 'c1',
        companyName: '测试公司',
      },
    }
  })

  afterEach(() => {
    try {
      db.close()
      rmSync(root, { recursive: true, force: true })
    } catch {
      // Windows 上 SQLite 句柄释放可能延迟。
    }
  })

  it('写计划、更新步骤，并按步骤推导整体状态', () => {
    const created = writeAgentPlan(db, {
      companyId: 'c1',
      userId: 'u1',
      sessionId: 's1',
      traceId: 'run-1',
      title: '核对加班并出表',
      steps: [
        { title: '确认统计口径', detail: '查《加班管理办法》', owner: 'researcher' },
        { title: '查询加班明细' },
        { title: '核对总额并出表' },
      ],
    })
    expect(created.version).toBe(1)
    expect(created.status).toBe('running')
    expect(created.steps.map((step) => [step.seq, step.status])).toEqual([
      [1, 'pending'],
      [2, 'pending'],
      [3, 'pending'],
    ])
    expect(created.versions.map((version) => version.version)).toEqual([1])

    const started = updateAgentPlanStep(db, {
      companyId: 'c1', userId: 'u1', sessionId: 's1', planKey: created.planKey,
      seq: 1, status: 'running', note: '正在读取制度',
    })
    expect(started.steps[0]?.status).toBe('running')
    const done1 = updateAgentPlanStep(db, {
      companyId: 'c1', userId: 'u1', sessionId: 's1', planKey: created.planKey,
      seq: 1, status: 'done', note: '口径已确认',
    })
    expect(done1.status).toBe('running')
    const failed = updateAgentPlanStep(db, {
      companyId: 'c1', userId: 'u1', sessionId: 's1', planKey: created.planKey,
      seq: 2, status: 'failed', note: '插件没有返回数据',
    })
    expect(failed.status).toBe('failed')
    expect(failed.steps[1]?.note).toBe('插件没有返回数据')
  })

  it('同一 planKey 改写生成新版本，旧版本和旧步骤保留', () => {
    const first = writeAgentPlan(db, {
      companyId: 'c1', userId: 'u1', sessionId: 's1',
      title: '初版计划',
      steps: [{ title: '先查资料', status: 'done' }],
    })
    const second = writeAgentPlan(db, {
      companyId: 'c1', userId: 'u1', sessionId: 's1', planKey: first.planKey,
      title: '调整后的计划',
      steps: [
        { title: '先查资料', status: 'done' },
        { title: '再补一次取数' },
      ],
    })
    expect(second.planKey).toBe(first.planKey)
    expect(second.version).toBe(2)
    expect(second.title).toBe('调整后的计划')
    expect(second.versions.map((version) => version.version)).toEqual([2, 1])
    const current = getCurrentAgentPlan(db, { companyId: 'c1', userId: 'u1', sessionId: 's1' })
    expect(current?.id).toBe(second.id)
    const oldSteps = db.prepare('SELECT seq, title FROM agent_plan_steps WHERE plan_id = ? ORDER BY seq')
      .all(first.id) as Array<{ seq: number; title: string }>
    expect(oldSteps).toEqual([{ seq: 1, title: '先查资料' }])
  })

  it('计划最多 7 步，超过直接拒绝；跨会话不能改写计划', () => {
    expect(() => writeAgentPlan(db, {
      companyId: 'c1', userId: 'u1', sessionId: 's1',
      steps: Array.from({ length: 8 }, (_, index) => ({ title: `第 ${index + 1} 步` })),
    })).toThrow(/最多 7 步/)

    const plan = writeAgentPlan(db, {
      companyId: 'c1', userId: 'u1', sessionId: 's1',
      steps: [{ title: '只测归属' }],
    })
    expect(() => writeAgentPlan(db, {
      companyId: 'c1', userId: 'u1', sessionId: 's2', planKey: plan.planKey,
      steps: [{ title: '偷改别的会话' }],
    })).toThrow(/不属于当前会话/)
    expect(() => updateAgentPlanStep(db, {
      companyId: 'c1', userId: 'u1', sessionId: 's2', planKey: plan.planKey,
      seq: 1, status: 'done',
    })).toThrow(/不属于当前会话/)
  })

  it('plan.write 工具把数组或 JSON 字符串都转成计划，并落到当前会话', async () => {
    const direct = (await executeTool(
      deps,
      actor,
      'plan.write',
      {
        title: '发布前检查',
        steps: [
          { title: '跑类型检查', owner: 'builder' },
          { title: '跑回归测试' },
        ],
      },
      { kind: 'cloud' },
      { sessionId: 's1', traceId: 'run-tool' },
    )) as { planKey: string; version: number; steps: Array<{ title: string }> }
    expect(direct.version).toBe(1)
    expect(direct.steps.map((step) => step.title)).toEqual(['跑类型检查', '跑回归测试'])

    const fromString = (await executeTool(
      deps,
      actor,
      'plan.write',
      { planKey: direct.planKey, steps: JSON.stringify([{ title: '只改一项' }]) },
      { kind: 'cloud' },
      { sessionId: 's1' },
    )) as { version: number; steps: Array<{ title: string }> }
    expect(fromString.version).toBe(2)
    expect(fromString.steps).toHaveLength(1)

    const mainNames = toolSpecsForAgent(db, actor, { kind: 'cloud' }, '计划', { allowPlanTools: true })
      .map((tool) => tool.function.name)
    const childNames = toolSpecsForAgent(db, actor, { kind: 'cloud' }, '计划', { allowPlanTools: false })
      .map((tool) => tool.function.name)
    expect(mainNames).toContain('plan_write')
    expect(childNames).not.toContain('plan_write')
    expect(childNames).not.toContain('plan_step')

    await expect(executeTool(
      deps,
      actor,
      'plan.step',
      { seq: 1, status: 'done' },
      { kind: 'cloud' },
      { sessionId: 'agent:child-run' },
    )).rejects.toThrow(/只能由主 Agent/)
  })

  it('会话计划接口只返回本人的最新计划，删除会话后 404', async () => {
    const plan = writeAgentPlan(db, {
      companyId: 'c1', userId: 'u1', sessionId: 's1',
      title: '接口取回计划',
      steps: [{ title: '第一步' }],
    })
    const app = buildApp(deps, 'chat')
    try {
      await app.ready()
      const response = await app.inject({ method: 'GET', url: '/api/chat/sessions/s1/plan?as=u1' })
      expect(response.statusCode).toBe(200)
      const body = response.json() as { data: { plan: { planKey: string; steps: Array<{ title: string }> } } }
      expect(body.data.plan.planKey).toBe(plan.planKey)
      expect(body.data.plan.steps[0]?.title).toBe('第一步')

      const missing = await app.inject({ method: 'GET', url: '/api/chat/sessions/s-missing/plan?as=u1' })
      expect(missing.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  })
})
