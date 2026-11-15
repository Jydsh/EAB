/**
 * 项目记录保留：日志之外的业务历史，按独立天数清理。
 *
 * 覆盖范围（全部只删“历史”和“已结束”的行）：
 * - 网页会话与消息：整个会话超过保留期才删，避免拆散仍在使用的对话；
 * - 云空间历史版本：同时删除 `_versions` 下的快照文件，活跃文件本身不删；
 * - 工具幂等记录、技能事件、机器人文件回声标记；
 * - 子 Agent 团队消息、已结束任务、已消费事件；
 * - 定时任务运行结果与事件；
 * - 已结束的异步任务与 GUI 兜底、过期的 Office 刷新水位。
 *
 * 不覆盖：用户、组织、角色、模型、插件/技能安装、知识库、数据连接配置、
 * 活跃云空间文件与审批中的业务记录。数据连接的外部库内容始终只读，不由本模块写删。
 *
 * 清理是幂等的：时间阈值固定，重复执行只会得到相同边界。
 */
import { existsSync, lstatSync, realpathSync, rmSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import type { Db } from '@eab/storage'
import { withTransaction } from '@eab/storage'

export interface ProjectRetentionResult {
  /** 生效的项目记录保留天数；0 表示永久保留 */
  days: number
  /** 早于这个时间点的记录会被清理 */
  cutoff: string | null
  deleted: Record<string, number>
  total: number
  /** 删除的历史版本快照文件数与释放字节数 */
  versionFiles: number
  versionBytes: number
  /** 因路径越界/非普通文件/删除失败而没有清理的版本 ID */
  skippedVersionIds: string[]
  skipped: boolean
}

interface VersionRow {
  id: string
  storage_path: string
}

function isInsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target)
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel)
}

/** 只删除工作区根目录内的普通快照文件；路径越界或删除失败时保留数据库行，下一轮再试。 */
function pruneVersionSnapshots(
  db: Db,
  cutoff: number,
  workspaceRoot: string | undefined,
): { rows: number; files: number; bytes: number; skippedIds: string[] } {
  const rows = db
    .prepare(
      `SELECT id, storage_path
         FROM workspace_file_versions
        WHERE created_at < ?
        ORDER BY created_at ASC`,
    )
    .all(cutoff) as unknown as VersionRow[]
  if (rows.length === 0) return { rows: 0, files: 0, bytes: 0, skippedIds: [] }

  const root = workspaceRoot ? resolve(workspaceRoot) : null
  // 没有工作区根目录就无法校验快照路径，宁可跳过版本清理，也不能按数据库里的路径乱删。
  if (!root) {
    return { rows: 0, files: 0, bytes: 0, skippedIds: rows.map((row) => row.id) }
  }
  let realRoot: string | null = null
  try {
    realRoot = realpathSync(root)
  } catch {
    // 根目录尚未创建时只做词法守卫。
  }

  let deletedRows = 0
  let files = 0
  let bytes = 0
  const skippedIds: string[] = []
  for (const row of rows) {
    const target = resolve(row.storage_path)
    if (!isInsideRoot(root, target)) {
      skippedIds.push(row.id)
      continue
    }
    let existed = false
    let isRegularFile = false
    try {
      if (existsSync(target)) {
        existed = true
        isRegularFile = lstatSync(target).isFile()
      }
    } catch {
      skippedIds.push(row.id)
      continue
    }
    if (existed && !isRegularFile) {
      skippedIds.push(row.id)
      continue
    }
    if (existed && realRoot) {
      try {
        if (!isInsideRoot(realRoot, realpathSync(target))) {
          skippedIds.push(row.id)
          continue
        }
      } catch {
        skippedIds.push(row.id)
        continue
      }
    }
    if (existed) {
      try {
        const size = lstatSync(target).size
        rmSync(target, { force: true })
        files += 1
        bytes += size
      } catch {
        skippedIds.push(row.id)
        continue
      }
    }
    db.prepare('DELETE FROM workspace_file_versions WHERE id = ?').run(row.id)
    deletedRows += 1
  }
  return { rows: deletedRows, files, bytes, skippedIds }
}

function deleteOlder(
  db: Db,
  table: string,
  column: string,
  cutoff: number,
  extraWhere = '',
): number {
  const result = db.prepare(`DELETE FROM ${table} WHERE ${column} < ?${extraWhere}`).run(cutoff) as {
    changes?: number
  }
  return Number(result.changes ?? 0)
}

export function runProjectRetention(
  db: Db,
  days: number,
  workspaceRoot?: string,
): ProjectRetentionResult {
  const keepDays = Number.isFinite(days) && days > 0 ? Math.trunc(days) : 0
  if (keepDays === 0) {
    return {
      days: 0,
      cutoff: null,
      deleted: {},
      total: 0,
      versionFiles: 0,
      versionBytes: 0,
      skippedVersionIds: [],
      skipped: true,
    }
  }

  const cutoffMs = Date.now() - keepDays * 86_400_000
  const cutoff = new Date(cutoffMs).toISOString()
  const versions = pruneVersionSnapshots(db, cutoffMs, workspaceRoot)
  const deleted: Record<string, number> = {}
  if (versions.rows > 0) deleted.workspaceVersions = versions.rows

  withTransaction(db, () => {
    // 会话按“整段过期”处理：只要会话仍在活跃使用，就不拆掉其中的旧消息。
    deleted.chatMessages = Number(
      (
        db
          .prepare(
            `DELETE FROM chat_messages
              WHERE session_id IN (
                SELECT id FROM chat_sessions
                 WHERE COALESCE(last_message_at, updated_at, created_at) < ?
              )`,
          )
          .run(cutoffMs) as { changes?: number }
      ).changes ?? 0,
    )
    deleted.chatSessions = Number(
      (
        db
          .prepare(
            `DELETE FROM chat_sessions
              WHERE COALESCE(last_message_at, updated_at, created_at) < ?`,
          )
          .run(cutoffMs) as { changes?: number }
      ).changes ?? 0,
    )

    deleted.toolOperations = deleteOlder(
      db,
      'tool_operations',
      'updated_at',
      cutoffMs,
      " AND status IN ('succeeded', 'failed')",
    )
    deleted.skillEvents = deleteOlder(db, 'skill_events', 'at', cutoffMs)
    deleted.robotFileSends = deleteOlder(
      db,
      'robot_user_file_sends',
      'updated_at',
      cutoffMs,
      " AND status IN ('sent', 'failed')",
    )

    // 团队消息不删仍在排队/运行的团队，避免正在派活的上下文被抽空。
    deleted.agentTeamMessages = Number(
      (
        db
          .prepare(
            `DELETE FROM agent_team_messages
              WHERE created_at < ?
                AND team_id NOT IN (
                  SELECT team_id FROM agent_tasks
                   WHERE status IN ('queued', 'running')
                )`,
          )
          .run(cutoffMs) as { changes?: number }
      ).changes ?? 0,
    )
    deleted.agentTasks = Number(
      (
        db
          .prepare(
            `DELETE FROM agent_tasks
              WHERE status IN ('succeeded', 'failed', 'cancelled')
                AND COALESCE(finished_at, updated_at, created_at) < ?`,
          )
          .run(cutoffMs) as { changes?: number }
      ).changes ?? 0,
    )
    // 未消费事件是父 Agent 还没取走的收件箱，保留。
    deleted.agentEvents = deleteOlder(
      db,
      'agent_events',
      'created_at',
      cutoffMs,
      ' AND consumed_at IS NOT NULL',
    )

    deleted.scheduleRuns = Number(
      (
        db
          .prepare(
            `DELETE FROM schedule_runs
              WHERE status IN ('success', 'error')
                AND COALESCE(finished_at, started_at) < ?`,
          )
          .run(cutoffMs) as { changes?: number }
      ).changes ?? 0,
    )
    deleted.scheduleEvents = deleteOlder(db, 'schedule_events', 'created_at', cutoffMs)
    deleted.asyncJobs = Number(
      (
        db
          .prepare(
            `DELETE FROM async_jobs
              WHERE status IN ('succeeded', 'failed', 'cancelled')
                AND COALESCE(finished_at, updated_at) < ?`,
          )
          .run(cutoffMs) as { changes?: number }
      ).changes ?? 0,
    )
    deleted.guiFallbacks = Number(
      (
        db
          .prepare(
            `DELETE FROM workspace_gui_fallbacks
              WHERE status IN ('succeeded', 'failed', 'expired')
                AND COALESCE(finished_at, expires_at, created_at) < ?`,
          )
          .run(cutoffMs) as { changes?: number }
      ).changes ?? 0,
    )
    deleted.officeRefreshGuards = deleteOlder(
      db,
      'workspace_office_refresh_guards',
      'updated_at',
      cutoffMs,
    )
  })

  const total = Object.values(deleted).reduce((sum, n) => sum + n, 0)
  return {
    days: keepDays,
    cutoff,
    deleted,
    total,
    versionFiles: versions.files,
    versionBytes: versions.bytes,
    skippedVersionIds: versions.skippedIds,
    skipped: false,
  }
}
