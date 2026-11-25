import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '@eab/storage'
import { SC } from '@eab/domain'
import { executeTool, TOOLS, toolSpecsForActor } from '../src/routes/tools.js'

const dirs: string[] = []

function testDb() {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  return db
}

function actor(scopes: string[]) {
  return {
    subject: {
      companyId: 'c1',
      userId: 'u-project-tool',
      status: 'active',
      deptId: 'd1',
      deptPath: '/d1',
      deptChain: [],
      roles: ['member'],
      scopes: new Set(scopes),
    },
    person: {
      id: 'u-project-tool',
      name: '测试员工',
      title: null,
      deptId: 'd1',
      deptPath: '/d1',
      deptName: '测试部门',
      companyId: 'c1',
      companyName: '测试公司',
    },
  }
}

function deps(dataDir: string) {
  mkdirSync(join(dataDir, 'workspaces', 'c1', 'user-u-project-tool'), { recursive: true })
  return {
    db: testDb(),
    config: { dbPath: ':memory:', dataDir, workspacesDir: join(dataDir, 'workspaces') },
    companyId: 'c1',
  } as any
}

beforeAll(() => {
  process.env.EAB_PROJECT_EXEC = '1'
})

afterAll(() => {
  delete process.env.EAB_PROJECT_EXEC
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

async function waitForJobOutput(d: ReturnType<typeof deps>, me: ReturnType<typeof actor>, jobId: string) {
  const end = Date.now() + 10_000
  let output: any = null
  while (Date.now() < end) {
    output = await executeTool(
      d,
      me as any,
      'project.job',
      { action: 'output', jobId },
      { kind: 'cloud' },
      { sessionId: 'chat_project_job', channel: 'web' },
    )
    if (output?.status !== 'running') return output
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return output
}

describe('project.exec 工具接入', () => {
  it('注册工具并在工具目录里可见', () => {
    expect(TOOLS.some((tool) => tool.id === 'project.exec')).toBe(true)
    expect(TOOLS.some((tool) => tool.id === 'project.job')).toBe(true)
    const db = testDb()
    const me = actor([SC.AGENT_TOOL_INVOKE, SC.WORKSPACE_READ, SC.WORKSPACE_WRITE])
    const specs = toolSpecsForActor(db, me as any, { kind: 'cloud' })
    expect(specs.some((spec) => spec.function.name === 'project_exec')).toBe(true)
    expect(specs.some((spec) => spec.function.name === 'project_job')).toBe(true)
  })

  it('未审批的高危工具被门禁拦住，审批后只能执行一次', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'eab-project-tool-'))
    dirs.push(dataDir)
    const d = deps(dataDir)
    d.db.exec('PRAGMA foreign_keys = OFF')
    const me = actor([SC.AGENT_TOOL_INVOKE, SC.WORKSPACE_READ, SC.WORKSPACE_WRITE])
    const args = { command: 'node -e "console.log(\'审批-ok\')"' }

    const blocked = (await executeTool(d, me as any, 'project.exec', args, { kind: 'cloud' }, {
      sessionId: 'chat_approval', channel: 'web', approval: 'defer', messageId: 'msg-approval',
    }).catch((error) => error)) as any
    expect(blocked.code).toBe('EAB_APPROVAL_REQUIRED')
    const approvalId = blocked.details.approvalId as string
    expect(approvalId).toBeTruthy()

    d.db.prepare("UPDATE approvals SET status = 'approved', decided_by = 'admin', decided_at = ? WHERE id = ?")
      .run(Date.now(), approvalId)
    const allowed = (await executeTool(d, me as any, 'project.exec', args, { kind: 'cloud' }, {
      sessionId: 'chat_approval', channel: 'web', approval: 'defer', approvalId,
    })) as any
    expect(allowed.status).toBe('completed')
    expect(allowed.stdout).toContain('审批-ok')

    const reused = (await executeTool(d, me as any, 'project.exec', args, { kind: 'cloud' }, {
      sessionId: 'chat_approval', channel: 'web', approval: 'defer', approvalId,
    }).catch((error) => error)) as any
    expect(reused.code).toBe('EAB_CONFLICT')
  }, 20_000)

  it('执行前台命令并返回退出码、stdout 和 stderr', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'eab-project-tool-'))
    dirs.push(dataDir)
    const me = actor([SC.AGENT_TOOL_INVOKE, SC.WORKSPACE_READ, SC.WORKSPACE_WRITE])
    const result = (await executeTool(
      deps(dataDir),
      me as any,
      'project.exec',
      {
        description: '验证项目命令执行',
        command: `node -e "console.log('工具-ok'); console.error('工具-err'); process.exit(3)"`,
      },
      { kind: 'cloud' },
      { sessionId: 'chat_project_tool', channel: 'web' },
    )) as any
    expect(result.exitCode).toBe(3)
    expect(result.stdout).toContain('工具-ok')
    expect(result.stderr).toContain('工具-err')
    expect(result.status).toBe('failed')
    expect(result.enforcement).toBe('none')
    expect(result.fullOutput).toBeUndefined()
  }, 20_000)

  it('后台任务可通过 project.job 读取', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'eab-project-tool-'))
    dirs.push(dataDir)
    const me = actor([SC.AGENT_TOOL_INVOKE, SC.WORKSPACE_READ, SC.WORKSPACE_WRITE])
    const d = deps(dataDir)
    const started = (await executeTool(
      d,
      me as any,
      'project.exec',
      {
        description: '后台输出验证',
        command: `node -e "setTimeout(() => console.log('后台-ok'), 1200)"`,
        runInBackground: true,
      },
      { kind: 'cloud' },
      { sessionId: 'chat_project_job', channel: 'web' },
    )) as any
    expect(started.mode).toBe('background')
    expect(started.jobId).toBeTruthy()
    const output = await waitForJobOutput(d, me, started.jobId)
    expect(output.status).toBe('completed')
    expect(output.stdout).toContain('后台-ok')
  }, 20_000)
})
