/**
 * 日志保留策略：把"越积越多但只用于回溯"的运维日志按天清理，降低磁盘与查询压力。
 *
 * 边界：
 * - 运维/事件类日志：组织同步记录与差异、渠道事件、登录失败计数、插件事件、扫码尝试。
 * - 审计日志：按独立的审计保留天数，只从最老一端连续删除；被删段最后一行
 *   的哈希记成新锚点，哈希链校验从锚点继续，所以清理不会把链判成断裂。
 * - 用户对话、知识库、工作区文件仍不在自动清理范围内（业务数据）。
 *
 * 清理是可重复执行的幂等操作：按时间阈值删除，重复跑只会删到同样的边界。
 */
import type { AuditPruneResult, Db } from '@eab/storage'
import { runAsLeader } from './backends/coordination.js'
import { pruneAuditLogs, withTransaction } from '@eab/storage'

export interface RetentionStats {
  [table: string]: number
}

export interface RetentionResult {
  /** 生效的日志保留天数；0 表示未配置日志清理 */
  days: number
  /** 早于这个时间点的日志会被清理 */
  cutoff: string | null
  /** 生效的 Agent 轨迹保留天数；0 表示永久保留 */
  agentDays: number
  deleted: RetentionStats
  /** 实际删掉的记录总数（包含审计） */
  total: number
  skipped: boolean
  /** 审计清理结果；审计保留为 0 时 skipped=true */
  audit: AuditPruneResult
}

function deleteOlder(db: Db, table: string, column: string, cutoff: number, extraWhere = ''): number {
  const stmt = db.prepare(`DELETE FROM ${table} WHERE ${column} < ?${extraWhere}`)
  const result = stmt.run(cutoff) as { changes?: number }
  return Number(result.changes ?? 0)
}

export function runRetention(db: Db, days: number, auditDays = 0, agentDays = 0): RetentionResult {
  const logDays = Number.isFinite(days) && days > 0 ? Math.trunc(days) : 0
  const deleted: RetentionStats = {}
  let cutoff: string | null = null

  if (logDays > 0) {
    const cutoffMs = Date.now() - logDays * 86_400_000
    cutoff = new Date(cutoffMs).toISOString()
    withTransaction(db, () => {
      // 同步差异先删：靠 run 关联，避免外键留下孤儿
      deleted['syncDiffs'] = Number(
        (
          db
            .prepare(
              `DELETE FROM org_sync_diffs
                WHERE run_id IN (SELECT id FROM org_sync_runs WHERE started_at < ?)`,
            )
            .run(cutoffMs) as { changes?: number }
        ).changes ?? 0,
      )
      deleted['syncRuns'] = deleteOlder(db, 'org_sync_runs', 'started_at', cutoffMs)
      deleted['channelEvents'] = deleteOlder(db, 'channel_events', 'received_at', cutoffMs)
      deleted['loginAttempts'] = deleteOlder(db, 'login_attempts', 'updated_at', cutoffMs)
      deleted['pluginEvents'] = deleteOlder(db, 'plugin_events', 'at', cutoffMs)
      deleted['onboardAttempts'] = deleteOlder(db, 'dingtalk_onboard_attempts', 'expires_at', cutoffMs)
    })
  }

  const agentLogDays = Number.isFinite(agentDays) && agentDays > 0 ? Math.trunc(agentDays) : 0
  if (agentLogDays > 0) {
    const agentCutoffMs = Date.now() - agentLogDays * 86_400_000
    withTransaction(db, () => {
      // 只删「已经结束」的 run：running / suspended 是活任务或等后台结果的挂起任务，不能动。
      deleted['agentSteps'] = Number(
        (
          db
            .prepare(
              `DELETE FROM agent_steps
                WHERE run_id IN (
                  SELECT id FROM agent_runs
                   WHERE status IN ('succeeded', 'failed', 'cancelled')
                     AND COALESCE(ended_at, started_at) < ?
                )`,
            )
            .run(agentCutoffMs) as { changes?: number }
        ).changes ?? 0,
      )
      deleted['agentRuns'] = Number(
        (
          db
            .prepare(
              `DELETE FROM agent_runs
                WHERE status IN ('succeeded', 'failed', 'cancelled')
                  AND COALESCE(ended_at, started_at) < ?`,
            )
            .run(agentCutoffMs) as { changes?: number }
        ).changes ?? 0,
      )
    })
  }

  const audit = pruneAuditLogs(db, auditDays)
  if (audit.deleted > 0) deleted['auditLogs'] = audit.deleted

  const total = Object.values(deleted).reduce((sum, n) => sum + n, 0)
  return {
    days: logDays,
    cutoff,
    agentDays: agentLogDays,
    deleted,
    total,
    skipped: logDays === 0 && agentLogDays === 0 && audit.skipped,
    audit,
  }
}

/**
 * 后台定时清理：启动后先跑一次，之后每 6 小时检查一次。
 * 用 unref 让定时器不拦住进程退出。
 */
export function startRetention(
  db: Db,
  readDays: () => number,
  onDone?: (result: RetentionResult) => void,
  readAuditDays?: () => number,
  readAgentDays?: () => number,
): () => void {
  const tick = () => {
    void runAsLeader('retention', 10 * 60_000, () => {
      try {
        const result = runRetention(db, readDays(), readAuditDays?.() ?? 0, readAgentDays?.() ?? 0)
        if (!result.skipped) onDone?.(result)
      } catch (err) {
        console.warn(`[eab] 保留清理失败：${(err as Error).message}`)
      }
    })
  }
  const first = setTimeout(tick, 30_000)
  const timer = setInterval(tick, 6 * 60 * 60 * 1000)
  first.unref()
  timer.unref()
  return () => {
    clearTimeout(first)
    clearInterval(timer)
  }
}
