import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate, openDatabase, type Db } from '@eab/storage'
import { SC } from '@eab/domain'
import { AgentTeamStore } from '../src/agent-team.js'
import { executeTool } from '../src/routes/tools.js'

describe('agent.publish_artifact 工具接线', () => {
  let db: Db
  let root: string
  let deps: any
  let actor: any
  let team: AgentTeamStore
  let taskId: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'eab-publish-tool-'))
    const workspacesDir = join(root, 'workspaces')
    const userDir = join(workspacesDir, 'c1', 'user-u1')
    mkdirSync(join(userDir, 'out'), { recursive: true })
    writeFileSync(join(userDir, 'out', 'report.md'), '# 报告\n')
    db = openDatabase({ path: join(root, 'eab.sqlite') })
    migrate(db)
    db.prepare("INSERT INTO companies (id, name, slug, status, created_at) VALUES ('c1', '测试公司', 'test', 'active', 1)").run()
    db.prepare("INSERT INTO departments (id, company_id, name, path, depth, order_no, created_at) VALUES ('d1', 'c1', '测试部门', '/d1', 0, 0, 1)").run()
    db.prepare("INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at) VALUES ('u1', 'c1', 'd1', '/d1', '测试员工', 'active', 1, 1)").run()
    db.prepare(
      `INSERT INTO workspace_files
         (id, company_id, scope_type, scope_id, owner_user_id, rel_path, name, size, mime, created_at, updated_at)
       VALUES ('wf1', 'c1', 'user', 'u1', 'u1', 'out/report.md', 'report.md', 5, 'text/markdown', 1, 1)`,
    ).run()
    deps = { db, config: { dbPath: join(root, 'eab.sqlite'), workspacesDir }, companyId: 'c1' }
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
      person: { id: 'u1', name: '测试员工', title: null, deptId: 'd1', deptPath: '/d1', deptName: '测试部门', companyId: 'c1', companyName: '测试公司' },
    }
    team = new AgentTeamStore({ db, teamId: 'session:s1', companyId: 'c1', userId: 'u1', idleMs: 120_000 })
    const task = team.createTask({ workerKey: 'writer', prompt: '写报告', parentRunId: 'run-1', now: 1 })
    taskId = task.id
    team.markTaskRunning(taskId, 'child-run', 2)
  })

  afterEach(() => {
    try {
      db.close()
      rmSync(root, { recursive: true, force: true })
    } catch {
      // Windows 上 SQLite 句柄释放可能延迟，临时目录残留不影响测试结论。
    }
  })

  it('子 Agent 工具上下文带 taskId 时登记成功，未带上下文时明确拒绝', async () => {
    const payload = await executeTool(
      deps,
      actor,
      'agent.publish_artifact',
      { path: 'out/report.md', preview: '报告完成' },
      { kind: 'cloud' },
      { sessionId: 's1', turnId: 't1', agentTaskId: taskId, agentTeam: team },
    ) as { ok: boolean; artifact: { fileId?: string; preview?: string } }

    expect(payload.ok).toBe(true)
    expect(payload.artifact.fileId).toBe('wf1')
    expect(payload.artifact.preview).toBe('报告完成')
    expect(team.listArtifacts(taskId)).toHaveLength(1)

    await expect(executeTool(
      deps,
      actor,
      'agent.publish_artifact',
      { path: 'out/report.md' },
      { kind: 'cloud' },
      { sessionId: 's1', turnId: 't2' },
    )).rejects.toThrow(/子 Agent 任务/)
  })
})
