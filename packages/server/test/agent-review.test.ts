import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { migrate, openDatabase, type Db } from '@eab/storage'
import { SC } from '@eab/domain'
import type { ServerConfig } from '../src/config.js'
import type { ServerDeps } from '../src/deps.js'
import {
  AGENT_CRITIC_TOOL_NAMES,
  buildCriticPrompt,
  latestAgentTaskReview,
  recordAgentTaskReview,
  reviewVerdictFromTraces,
} from '../src/agent-review.js'
import { executeTool, toolSpecsForAgent } from '../src/routes/tools.js'

describe('独立验收员门禁', () => {
  let db: Db
  let root: string
  let deps: ServerDeps
  let actor: any

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'eab-agent-review-'))
    db = openDatabase({ path: join(root, 'eab.sqlite') })
    migrate(db)
    const now = Date.now()
    db.prepare("INSERT INTO companies (id, name, slug, status, created_at) VALUES ('c1', '测试公司', 'test-review', 'active', ?)").run(now)
    db.prepare("INSERT INTO departments (id, company_id, name, path, depth, order_no, created_at) VALUES ('d1', 'c1', '测试部门', '/c1/d1/', 1, 0, ?)").run(now)
    db.prepare("INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at) VALUES ('u1', 'c1', 'd1', '/c1/d1/', '测试员工', 'active', ?, ?)").run(now, now)

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
    deps = { db, config, companyId: 'c1', migrations: [] } as unknown as ServerDeps
    process.env.EAB_PROJECT_EXEC = 'local'
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
    delete process.env.EAB_PROJECT_EXEC
    try {
      db.close()
      rmSync(root, { recursive: true, force: true })
    } catch {
      // Windows 上 SQLite 句柄释放可能延迟。
    }
  })

  it('只认 review_verdict 工具参数，不认正文口头通过', () => {
    const submission = reviewVerdictFromTraces([
      {
        toolId: 'review.verdict',
        name: 'review_verdict',
        args: {
          verdict: 'approve',
          reason: 'test:agent-plan 通过',
          evidence: ['pnpm vitest run packages/server/test/agent-plan.test.ts：5 passed'],
        },
      },
    ])
    expect(submission).toEqual({
      verdict: 'approve',
      reason: 'test:agent-plan 通过',
      evidence: ['pnpm vitest run packages/server/test/agent-plan.test.ts：5 passed'],
    })

    // 没有证据的提交不成立。
    expect(reviewVerdictFromTraces([
      { toolId: 'review.verdict', args: { verdict: 'approve', reason: '看起来没问题', evidence: [] } },
    ])).toBeNull()

    // 只读工具不算结论。
    expect(reviewVerdictFromTraces([
      { toolId: 'workspace.read', args: { path: 'README.md' } },
    ])).toBeNull()

    // 最后一次提交无效时不能回退到更早的有效提交。
    expect(reviewVerdictFromTraces([
      {
        toolId: 'review.verdict',
        status: 'done',
        args: { verdict: 'approve', reason: '先通过', evidence: ['test：passed'] },
      },
      {
        toolId: 'review.verdict',
        status: 'done',
        args: { verdict: 'reject', reason: '', evidence: [] },
      },
    ])).toBeNull()

    // 工具执行失败时参数不可信，按没有结论处理。
    expect(reviewVerdictFromTraces([
      {
        toolId: 'review.verdict',
        status: 'error',
        args: { verdict: 'approve', reason: '工具失败但有参数', evidence: ['test：passed'] },
      },
    ])).toBeNull()
  })

  it('验收失败也要落库，并能取回最近一次结论', () => {
    recordAgentTaskReview(db, {
      companyId: 'c1',
      userId: 'u1',
      teamId: 't1',
      taskId: 'task1',
      workerKey: 'builder-1',
      childRunId: 'run-builder',
      reviewerRunId: 'run-critic-1',
      reviewerModelId: 'm2',
      verdict: 'reject',
      reason: '没有真实测试通过证据',
      evidence: ['project_exec pnpm test：exitCode=1'],
      durationMs: 1200,
    })
    const record = latestAgentTaskReview(db, 'c1', 'task1')
    expect(record?.verdict).toBe('reject')
    expect(record?.reason).toContain('没有真实测试')
    expect(record?.evidence[0]).toContain('exitCode=1')
  })

  it('review.verdict 只允许独立验收员会话提交', async () => {
    await expect(executeTool(
      deps,
      actor,
      'review.verdict',
      { verdict: 'approve', reason: '自测通过', evidence: ['pnpm test：passed'] },
      { kind: 'cloud' },
      { sessionId: 's-main' },
    )).rejects.toThrow(/独立验收员/)

    const result = await executeTool(
      deps,
      actor,
      'review.verdict',
      { verdict: 'approve', reason: '自测通过', evidence: ['pnpm test：passed'] },
      { kind: 'cloud' },
      { sessionId: 'agent:critic:run-1' },
    ) as { accepted: boolean; verdict: string; evidence: string[] }
    expect(result.accepted).toBe(true)
    expect(result.verdict).toBe('approve')
    expect(result.evidence).toEqual(['pnpm test：passed'])

    await expect(executeTool(
      deps,
      actor,
      'review.verdict',
      { verdict: 'approve', reason: '没有证据', evidence: [] },
      { kind: 'cloud' },
      { sessionId: 'agent:critic:run-2' },
    )).rejects.toThrow(/至少需要 1 条具体证据/)
  })

  it('critic 工具目录有只读验证工具和结论工具，允许清单里没有写文件工具', () => {
    const allow = new Set(AGENT_CRITIC_TOOL_NAMES)
    const names = toolSpecsForAgent(db, actor, { kind: 'cloud' }, '读取工作区文件并运行测试构建', {
      allowPlanTools: false,
      allowReviewTools: true,
    })
      .map((tool) => tool.function.name)
      .filter((name) => allow.has(name))
    expect(names).toContain('review_verdict')
    expect(names).toContain('workspace_read')
    expect(names).toContain('project_exec')
    expect(names).not.toContain('workspace_write')
    expect(names).not.toContain('workspace_edit')

    const hidden = toolSpecsForAgent(db, actor, { kind: 'cloud' }, '读取工作区文件并运行测试构建', {
      allowPlanTools: true,
      allowReviewTools: false,
    }).map((tool) => tool.function.name)
    expect(hidden).not.toContain('review_verdict')
  })

  it('critic 提示词带上验收标准、实现员回报和证据要求', () => {
    const prompt = buildCriticPrompt({
      taskTitle: '修复计划板刷新',
      prompt: '修复计划板在 SSE 下不刷新',
      acceptance: '刷新页面仍能看到最新计划；测试通过',
      builderText: '已补 plan 事件转发',
      artifacts: [{ name: '修复说明', path: 'docs/fix.md' }],
      toolSummary: ['project_exec｜done｜pnpm vitest：12 passed'],
    })
    expect(prompt).toContain('刷新页面仍能看到最新计划')
    expect(prompt).toContain('已补 plan 事件转发')
    expect(prompt).toContain('project_exec｜done')
    expect(prompt).toContain('review_verdict')
    expect(prompt).toContain('至少 1 条具体证据')
  })
})
