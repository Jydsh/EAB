import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { migrate, openDatabase, type Db } from '@eab/storage'
import { AgentTeamStore } from '../src/agent-team.js'
import { publishAgentArtifact } from '../src/agent-artifacts.js'

describe('Agent 产物登记', () => {
  let db: Db
  let root: string
  let team: AgentTeamStore
  let taskId: string

  beforeEach(() => {
    db = openDatabase({ path: ':memory:' })
    migrate(db)
    db.prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('c1', '测试公司', 'test-co', 'active', 1000)
    root = mkdtempSync(join(tmpdir(), 'eab-artifacts-'))
    mkdirSync(join(root, 'reports'), { recursive: true })
    writeFileSync(join(root, 'reports', '巡检周报.md'), '# 巡检周报\n\n本周正常。\n')
    db.prepare(
      `INSERT INTO workspace_files
         (id, company_id, scope_type, scope_id, owner_user_id, rel_path, name, size, mime, created_at, updated_at)
       VALUES ('wf1', 'c1', 'user', 'u1', 'u1', 'reports/巡检周报.md', '巡检周报.md', 24, 'text/markdown', 1000, 1000)`,
    ).run()
    team = new AgentTeamStore({ db, teamId: 'session:s1', companyId: 'c1', userId: 'u1', idleMs: 120_000 })
    const task = team.createTask({ workerKey: 'a', prompt: '写周报', parentRunId: 'run-1', now: 1000 })
    taskId = task.id
    team.markTaskRunning(taskId, 'child-run', 1100)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function publish(path = 'reports/巡检周报.md', preview = '本周巡检正常') {
    return publishAgentArtifact({
      db,
      team,
      taskId,
      companyId: 'c1',
      userId: 'u1',
      workspaceRoot: root,
      path,
      preview,
    })
  }

  it('登记工作区文件只存引用，任务和产物表都能查到', async () => {
    const artifact = await publish()
    expect(artifact).toMatchObject({
      name: '巡检周报.md',
      mimeType: 'text/markdown',
      source: 'workspace',
      fileId: 'wf1',
      uri: 'eab://workspace/file/wf1',
      preview: '本周巡检正常',
    })
    expect(artifact.size).toBeGreaterThan(0)
    expect(artifact.checksum).toMatch(/^sha256:/)

    expect(team.listArtifacts(taskId)).toEqual([artifact])
    const row = db.prepare(
      'SELECT name, source, uri FROM agent_artifacts WHERE task_id = ?',
    ).get(taskId) as { name: string; source: string; uri: string }
    expect(row).toMatchObject({ name: '巡检周报.md', source: 'workspace', uri: 'eab://workspace/file/wf1' })
  })

  it('同一文件重复发布只保留一条，checksum 随文件更新', async () => {
    await publish()
    writeFileSync(join(root, 'reports', '巡检周报.md'), '# 巡检周报\n\n本周发现一处隐患。\n')
    writeFileSync(join(root, 'reports', '巡检周报.md'), '# 巡检周报\n\n本周发现两处隐患，已整改。\n')
    const updated = await publish('reports/巡检周报.md', '两处隐患已整改')

    expect(team.listArtifacts(taskId)).toHaveLength(1)
    expect(team.listArtifacts(taskId)[0]?.checksum).toBe(updated.checksum)
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_artifacts WHERE task_id = ?').get(taskId)).toEqual({ n: 1 })
  })

  it('fileId 直接登记为云空间产物，并复用同一个文件引用', async () => {
    await publish()
    const artifact = await publishAgentArtifact({
      db,
      team,
      taskId,
      companyId: 'c1',
      userId: 'u1',
      workspaceRoot: root,
      fileId: 'wf1',
    })
    expect(artifact.source).toBe('cloud')
    expect(artifact.fileId).toBe('wf1')
    expect(team.listArtifacts(taskId)).toHaveLength(1)
  })

  it('外部 uri 只存元数据，并生成稳定引用指纹和可读预览', async () => {
    const withoutPreview = await publishAgentArtifact({
      db,
      team,
      taskId,
      companyId: 'c1',
      userId: 'u1',
      workspaceRoot: root,
      uri: 'a2a://travel-agent/tasks/42/artifacts/plan',
      name: '东京行程单.pdf',
      mimeType: 'application/pdf',
    })
    expect(withoutPreview).toMatchObject({
      name: '东京行程单.pdf',
      source: 'a2a',
      uri: 'a2a://travel-agent/tasks/42/artifacts/plan',
      size: 0,
      mimeType: 'application/pdf',
    })
    expect(withoutPreview.checksum).toMatch(/^ref-sha256:/)
    expect(withoutPreview.preview).toContain('外部产物：东京行程单.pdf')
    expect(withoutPreview.preview).toContain('application/pdf')

    const artifact = await publishAgentArtifact({
      db,
      team,
      taskId,
      companyId: 'c1',
      userId: 'u1',
      workspaceRoot: root,
      uri: 'a2a://travel-agent/tasks/42/artifacts/plan',
      name: '东京行程单',
      preview: '三天两晚',
    })
    expect(artifact).toMatchObject({
      name: '东京行程单',
      source: 'a2a',
      uri: 'a2a://travel-agent/tasks/42/artifacts/plan',
      size: 0,
      preview: '三天两晚',
    })
    expect(artifact.checksum).toMatch(/^ref-sha256:/)
  })

  it('不传 preview 时，文本文件自动截取开头，二进制文件生成元数据摘要', async () => {
    const text = await publishAgentArtifact({
      db,
      team,
      taskId,
      companyId: 'c1',
      userId: 'u1',
      workspaceRoot: root,
      path: 'reports/巡检周报.md',
    })
    expect(text.preview).toContain('巡检周报')
    expect(text.preview).toContain('本周正常')

    writeFileSync(join(root, 'reports', '照片.pdf'), Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01, 0x02]))
    const binary = await publishAgentArtifact({
      db,
      team,
      taskId,
      companyId: 'c1',
      userId: 'u1',
      workspaceRoot: root,
      path: 'reports/照片.pdf',
    })
    expect(binary.mimeType).toBe('application/pdf')
    expect(binary.preview).toContain('文件：照片.pdf')
    expect(binary.preview).toContain('application/pdf')
    expect(binary.preview).toContain('B')
  })

  it('拒绝越界路径、别人的 fileId 和已结束任务', async () => {
    await expect(publish('../outside.txt')).rejects.toThrow(/个人云空间/)
    db.prepare(
      `INSERT INTO workspace_files
         (id, company_id, scope_type, scope_id, owner_user_id, rel_path, name, size, mime, created_at, updated_at)
       VALUES ('wf2', 'c1', 'user', 'u2', 'u2', 'reports/别人的.md', '别人的.md', 8, 'text/markdown', 1000, 1000)`,
    ).run()
    writeFileSync(join(root, 'reports', '别人的.md'), '别人的')
    await expect(publishAgentArtifact({
      db,
      team,
      taskId,
      companyId: 'c1',
      userId: 'u1',
      workspaceRoot: root,
      fileId: 'wf2',
    })).rejects.toThrow(/云空间/)

    team.markTaskDone(taskId, '完成', 2000, [])
    await expect(publish()).rejects.toThrow(/任务已结束/)
  })
})
