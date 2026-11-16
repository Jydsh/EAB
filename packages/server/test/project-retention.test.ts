import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { migrate, openDatabase } from '@eab/storage'
import { runProjectRetention } from '../src/project-retention.js'
import { runRetention } from '../src/retention.js'

const roots: string[] = []
const DAY = 86_400_000

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'eab-project-retention-'))
  roots.push(root)
  return root
}

function seedCompany(db: ReturnType<typeof openDatabase>, now: number): void {
  db.prepare("INSERT INTO companies (id, name, slug, status, created_at) VALUES ('c1', '测试公司', 'c1', 'active', ?)").run(now)
  db.prepare(
    "INSERT INTO departments (id, company_id, name, path, created_at) VALUES ('d1', 'c1', '测试部门', 'd1', ?)",
  ).run(now)
  db.prepare(
    "INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at) VALUES ('u1', 'c1', 'd1', 'd1', '测试用户', 'active', ?, ?)",
  ).run(now, now)
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('项目记录保留', () => {
  it('清理过期会话、历史版本、已结束的工具/团队/计划/异步/GUI 记录', () => {
    const db = openDatabase({ path: ':memory:' })
    migrate(db)
    const now = Date.now()
    const root = tempRoot()
    seedCompany(db, now)

    const versionOld = join(root, 'c1', 'user-u1', '_versions', 'f1', 'old.txt')
    const versionNew = join(root, 'c1', 'user-u1', '_versions', 'f1', 'new.txt')
    mkdirSync(join(root, 'c1', 'user-u1', '_versions', 'f1'), { recursive: true })
    writeFileSync(versionOld, 'old-snapshot')
    writeFileSync(versionNew, 'new-snapshot')
    db.prepare(
      `INSERT INTO workspace_files
         (id, company_id, scope_type, scope_id, owner_user_id, rel_path, name, size, created_at, updated_at)
       VALUES ('f1', 'c1', 'user', 'u1', 'u1', 'a.txt', 'a.txt', 1, ?, ?)`,
    ).run(now - 40 * DAY, now)

    for (const [session, age] of [['s-old', 40], ['s-new', 1]] as const) {
      db.prepare(
        `INSERT INTO chat_sessions (id, company_id, user_id, title, created_at, updated_at, last_message_at)
         VALUES (?, 'c1', 'u1', '测试', ?, ?, ?)`,
      ).run(session, now - age * DAY, now - age * DAY, now - age * DAY)
      db.prepare(
        `INSERT INTO chat_messages (id, company_id, session_id, user_id, role, text, created_at)
         VALUES (?, 'c1', ?, 'u1', 'user', '内容', ?)`,
      ).run(`${session}-m1`, session, now - age * DAY)
    }

    db.prepare(
      `INSERT INTO workspace_file_versions
         (id, company_id, file_id, version, size, storage_path, source, created_by, created_at)
       VALUES ('v-old', 'c1', 'f1', 1, 12, ?, 'test', 'u1', ?)`,
    ).run(versionOld, now - 40 * DAY)
    db.prepare(
      `INSERT INTO workspace_file_versions
         (id, company_id, file_id, version, size, storage_path, source, created_by, created_at)
       VALUES ('v-new', 'c1', 'f1', 2, 12, ?, 'test', 'u1', ?)`,
    ).run(versionNew, now - 1 * DAY)

    db.prepare(
      `INSERT INTO tool_operations
         (id, company_id, user_id, tool_id, idempotency_key, status, created_at, updated_at, expires_at)
       VALUES ('tool-old', 'c1', 'u1', 't', 'k1', 'succeeded', ?, ?, ?)`,
    ).run(now - 40 * DAY, now - 40 * DAY, now - 10 * DAY)
    db.prepare(
      `INSERT INTO tool_operations
         (id, company_id, user_id, tool_id, idempotency_key, status, created_at, updated_at, expires_at)
       VALUES ('tool-running', 'c1', 'u1', 't', 'k2', 'running', ?, ?, ?)`,
    ).run(now - 40 * DAY, now - 40 * DAY, now - 10 * DAY)

    db.prepare("INSERT INTO skill_events (skill_id, company_id, event, at) VALUES ('sk', 'c1', 'install', ?)").run(now - 40 * DAY)
    db.prepare("INSERT INTO skill_events (skill_id, company_id, event, at) VALUES ('sk', 'c1', 'install', ?)").run(now - 1 * DAY)

    db.prepare(
      `INSERT INTO agent_tasks
         (id, team_id, company_id, user_id, worker_key, status, prompt, finished_at, created_at, updated_at)
       VALUES ('task-old', 'team-old', 'c1', 'u1', 'w1', 'succeeded', 'p', ?, ?, ?)`,
    ).run(now - 40 * DAY, now - 40 * DAY, now - 40 * DAY)
    db.prepare(
      `INSERT INTO agent_team_messages (id, team_id, worker_key, role, content, created_at)
       VALUES ('msg-old', 'team-old', 'w1', 'assistant', 'x', ?)`,
    ).run(now - 40 * DAY)
    db.prepare(
      `INSERT INTO agent_events (id, team_id, company_id, user_id, worker_key, kind, payload_json, created_at, consumed_at)
       VALUES ('ev-old', 'team-old', 'c1', 'u1', 'w1', 'done', '{}', ?, ?)`,
    ).run(now - 40 * DAY, now - 40 * DAY)
    db.prepare(
      `INSERT INTO agent_tasks
         (id, team_id, company_id, user_id, worker_key, status, prompt, created_at, updated_at)
       VALUES ('task-active', 'team-active', 'c1', 'u1', 'w2', 'queued', 'p', ?, ?)`,
    ).run(now - 40 * DAY, now - 40 * DAY)
    db.prepare(
      `INSERT INTO agent_team_messages (id, team_id, worker_key, role, content, created_at)
       VALUES ('msg-active', 'team-active', 'w2', 'assistant', 'x', ?)`,
    ).run(now - 40 * DAY)

    db.prepare(
      `INSERT INTO schedule_runs (id, schedule_id, company_id, user_id, scheduled_for, status, started_at, finished_at)
       VALUES ('run-old', 'sch1', 'c1', 'u1', ?, 'success', ?, ?)`,
    ).run(now - 40 * DAY, now - 40 * DAY, now - 40 * DAY)
    db.prepare(
      `INSERT INTO schedule_events (id, schedule_id, company_id, user_id, type, created_at)
       VALUES ('sev-old', 'sch1', 'c1', 'u1', 'complete', ?)`,
    ).run(now - 40 * DAY)

    db.prepare(
      `INSERT INTO async_jobs (id, company_id, kind, title, status, payload_json, created_at, finished_at, updated_at)
       VALUES ('job-old', 'c1', 'test', '旧任务', 'succeeded', '{}', ?, ?, ?)`,
    ).run(now - 40 * DAY, now - 40 * DAY, now - 40 * DAY)
    db.prepare(
      `INSERT INTO async_jobs (id, company_id, kind, title, status, payload_json, created_at, updated_at)
       VALUES ('job-running', 'c1', 'test', '运行中', 'running', '{}', ?, ?)`,
    ).run(now - 40 * DAY, now - 40 * DAY)

    db.prepare(
      `INSERT INTO workspace_gui_fallbacks
         (id, company_id, file_id, user_id, gui_action, gui_label, mode, steps_json, status, created_at, expires_at, finished_at)
       VALUES ('gui-old', 'c1', 'f1', 'u1', 'print', '打印', 'native', '[]', 'succeeded', ?, ?, ?)`,
    ).run(now - 40 * DAY, now - 39 * DAY, now - 39 * DAY)
    db.prepare(
      `INSERT INTO workspace_office_refresh_guards (company_id, file_id, cutoff, updated_at)
       VALUES ('c1', 'f1', ?, ?)`,
    ).run(now - 40 * DAY, now - 40 * DAY)

    db.prepare(
      `INSERT INTO robot_user_file_sends (id, company_id, user_id, conversation_id, file_name, status, created_at, updated_at)
       VALUES ('echo-old', 'c1', 'u1', 'conv', 'a.txt', 'sent', ?, ?)`,
    ).run(now - 40 * DAY, now - 40 * DAY)

    const result = runProjectRetention(db, 30, root)
    expect(result.days).toBe(30)
    expect(result.deleted.chatSessions).toBe(1)
    expect(result.deleted.chatMessages).toBe(1)
    expect(result.deleted.workspaceVersions).toBe(1)
    expect(result.versionFiles).toBe(1)
    expect(result.deleted.toolOperations).toBe(1)
    expect(result.deleted.skillEvents).toBe(1)
    expect(result.deleted.agentTeamMessages).toBe(1)
    expect(result.deleted.agentTasks).toBe(1)
    expect(result.deleted.agentEvents).toBe(1)
    expect(result.deleted.scheduleRuns).toBe(1)
    expect(result.deleted.scheduleEvents).toBe(1)
    expect(result.deleted.asyncJobs).toBe(1)
    expect(result.deleted.guiFallbacks).toBe(1)
    expect(result.deleted.officeRefreshGuards).toBe(1)
    expect(result.deleted.robotFileSends).toBe(1)

    expect(existsSync(versionOld)).toBe(false)
    expect(existsSync(versionNew)).toBe(true)
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM chat_sessions WHERE id = 's-new'").get() as { n: number }).n,
    ).toBe(1)
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM tool_operations WHERE id = 'tool-running'").get() as { n: number }).n,
    ).toBe(1)
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM async_jobs WHERE id = 'job-running'").get() as { n: number }).n,
    ).toBe(1)
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM agent_team_messages WHERE id = 'msg-active'").get() as { n: number }).n,
    ).toBe(1)
    db.close()
  })

  it('版本快照路径越界时跳过并保留数据库行', () => {
    const db = openDatabase({ path: ':memory:' })
    migrate(db)
    const now = Date.now()
    const root = tempRoot()
    const outside = tempRoot()
    seedCompany(db, now)
    const outsideFile = join(outside, 'secret.txt')
    writeFileSync(outsideFile, 'keep-me')
    db.prepare(
      `INSERT INTO workspace_files
         (id, company_id, scope_type, scope_id, owner_user_id, rel_path, name, size, created_at, updated_at)
       VALUES ('f1', 'c1', 'user', 'u1', 'u1', 'a.txt', 'a.txt', 1, ?, ?)`,
    ).run(now - 40 * DAY, now)
    db.prepare(
      `INSERT INTO workspace_file_versions
         (id, company_id, file_id, version, size, storage_path, source, created_by, created_at)
       VALUES ('v-out', 'c1', 'f1', 1, 7, ?, 'test', 'u1', ?)`,
    ).run(outsideFile, now - 40 * DAY)

    const result = runProjectRetention(db, 30, root)
    expect(result.deleted.workspaceVersions).toBeUndefined()
    expect(result.skippedVersionIds).toEqual(['v-out'])
    expect(existsSync(outsideFile)).toBe(true)
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM workspace_file_versions WHERE id = 'v-out'").get() as { n: number }).n,
    ).toBe(1)
    db.close()
  })

  it('没有工作区根目录时不按数据库路径删除快照', () => {
    const db = openDatabase({ path: ':memory:' })
    migrate(db)
    const now = Date.now()
    seedCompany(db, now)
    const outside = join(tempRoot(), 'secret.txt')
    writeFileSync(outside, 'keep-me')
    db.prepare(
      `INSERT INTO workspace_files
         (id, company_id, scope_type, scope_id, owner_user_id, rel_path, name, size, created_at, updated_at)
       VALUES ('f1', 'c1', 'user', 'u1', 'u1', 'a.txt', 'a.txt', 1, ?, ?)`,
    ).run(now - 40 * DAY, now)
    db.prepare(
      `INSERT INTO workspace_file_versions
         (id, company_id, file_id, version, size, storage_path, source, created_by, created_at)
       VALUES ('v-no-root', 'c1', 'f1', 1, 7, ?, 'test', 'u1', ?)`,
    ).run(outside, now - 40 * DAY)

    const result = runProjectRetention(db, 30)
    expect(result.skippedVersionIds).toEqual(['v-no-root'])
    expect(existsSync(outside)).toBe(true)
    db.close()
  })

  it('保留天数为 0 时不删除任何项目记录', () => {
    const db = openDatabase({ path: ':memory:' })
    migrate(db)
    const now = Date.now()
    seedCompany(db, now)
    db.prepare(
      `INSERT INTO chat_sessions (id, company_id, user_id, title, created_at, updated_at)
       VALUES ('s', 'c1', 'u1', '测试', ?, ?)`,
    ).run(now - 100 * DAY, now - 100 * DAY)

    const result = runProjectRetention(db, 0)
    expect(result.skipped).toBe(true)
    expect(result.total).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM chat_sessions').get() as { n: number }).n).toBe(1)
    db.close()
  })

  it('runRetention 将项目记录纳入同一轮清理', () => {
    const db = openDatabase({ path: ':memory:' })
    migrate(db)
    const now = Date.now()
    seedCompany(db, now)
    db.prepare(
      `INSERT INTO chat_sessions (id, company_id, user_id, title, created_at, updated_at)
       VALUES ('s', 'c1', 'u1', '测试', ?, ?)`,
    ).run(now - 100 * DAY, now - 100 * DAY)

    const result = runRetention(db, 0, 0, 0, 30)
    expect(result.recordDays).toBe(30)
    expect(result.deleted.chatSessions).toBe(1)
    expect((db.prepare('SELECT COUNT(*) AS n FROM chat_sessions').get() as { n: number }).n).toBe(0)
    db.close()
  })
})
