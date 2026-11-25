/**
 * 记忆维护（D 阶段）：
 * - 情景聚类：把同一用户、时间相近、内容高度相似的多条 episode 合并成一条合集；
 * - 归档：合并后的原始情景、长期未被召回的低价值情景不再参与召回，但保留审计；
 * - 每日运行：服务启动后延迟一分钟尝试一次，之后每 6 小时检查一次，20 小时内不重复跑。
 *
 * 维护只动已确认的个人/部门/公司情景记忆；待确认候选不合并、不归档。
 */
import { createHash, randomUUID } from 'node:crypto'
import { withTransaction, type Db } from '@eab/storage'
import { memoryContentSimilarity } from './memory-os.js'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

export const DEFAULT_ARCHIVE_AFTER_DAYS = 120
export const DEFAULT_CLUSTER_WINDOW_DAYS = 60
export const DEFAULT_MIN_CLUSTER_SIZE = 2
const MAINTENANCE_INTERVAL_MS = 6 * HOUR
const DAILY_GUARD_MS = 20 * HOUR

interface EpisodeRow {
  id: string
  scope_type: string
  scope_id: string
  user_id: string | null
  content: string
  created_at: number
  event_at: number | null
  importance: number | null
  salience: number | null
  recall_count: number
}

export interface MemoryMaintenanceResult {
  readonly runId: string
  readonly skipped: boolean
  readonly scanned: number
  readonly clusters: number
  readonly consolidated: number
  readonly archived: number
  readonly startedAt: number
  readonly finishedAt: number
}

function clusterKey(ids: readonly string[]): string {
  const hash = createHash('sha1').update([...ids].sort().join('|')).digest('hex').slice(0, 16)
  return `ep_${hash}`
}

function mergedContent(rows: readonly EpisodeRow[]): string {
  const unique: string[] = []
  for (const row of rows) {
    const text = row.content.trim()
    if (text && !unique.includes(text)) unique.push(text)
  }
  return `情景合集（${rows.length} 条）：${unique.join('；')}`.slice(0, 500)
}

function hasRecentRun(db: Db, companyId: string, now: number): boolean {
  const row = db
    .prepare(
      `SELECT started_at FROM memory_maintenance_runs
        WHERE company_id = ? AND kind = 'all' AND finished_at IS NOT NULL
        ORDER BY started_at DESC LIMIT 1`,
    )
    .get(companyId) as { started_at: number } | undefined
  return Boolean(row && now - row.started_at < DAILY_GUARD_MS)
}

/**
 * 执行一次记忆维护。`force=true` 忽略每日门槛，供管理员手动触发和测试使用。
 */
export function runMemoryMaintenance(
  db: Db,
  options: {
    companyId: string
    now?: number
    force?: boolean
    archiveAfterDays?: number
    clusterWindowDays?: number
    minClusterSize?: number
  },
): MemoryMaintenanceResult {
  const now = options.now ?? Date.now()
  const archiveAfterDays = Math.max(7, options.archiveAfterDays ?? DEFAULT_ARCHIVE_AFTER_DAYS)
  const clusterWindowDays = Math.max(1, options.clusterWindowDays ?? DEFAULT_CLUSTER_WINDOW_DAYS)
  const minClusterSize = Math.max(2, options.minClusterSize ?? DEFAULT_MIN_CLUSTER_SIZE)
  const runId = `mm_${randomUUID()}`
  if (options.force !== true && hasRecentRun(db, options.companyId, now)) {
    return { runId, skipped: true, scanned: 0, clusters: 0, consolidated: 0, archived: 0, startedAt: now, finishedAt: now }
  }

  const result = withTransaction(db, () => {
    let scanned = 0
    let clusters = 0
    let consolidated = 0
    let archived = 0

    const groups = db
      .prepare(
        `SELECT scope_type, scope_id
           FROM memories
          WHERE company_id = ? AND memory_type = 'episode' AND confirmed = 1
            AND deleted_at IS NULL AND archived_at IS NULL
            AND (valid_to IS NULL OR valid_to > ?)
            AND created_at >= ?
          GROUP BY scope_type, scope_id
          ORDER BY MAX(created_at) DESC
          LIMIT 200`,
      )
      .all(options.companyId, now, now - clusterWindowDays * DAY) as unknown as Array<{
      scope_type: string
      scope_id: string
    }>

    for (const group of groups) {
      const rows = db
        .prepare(
          `SELECT id, scope_type, scope_id, user_id, content, created_at, event_at,
                  importance, salience, recall_count
             FROM memories
            WHERE company_id = ? AND scope_type = ? AND scope_id = ?
              AND memory_type = 'episode' AND confirmed = 1
              AND deleted_at IS NULL AND archived_at IS NULL
              AND (valid_to IS NULL OR valid_to > ?)
              AND created_at >= ?
            ORDER BY created_at ASC
            LIMIT 200`,
        )
        .all(options.companyId, group.scope_type, group.scope_id, now, now - clusterWindowDays * DAY) as unknown as EpisodeRow[]
      scanned += rows.length
      if (rows.length < minClusterSize) continue

      const episodeGroups: EpisodeRow[][] = []
      for (const row of rows) {
        let target: EpisodeRow[] | null = null
        let bestScore = 0
        for (const cluster of episodeGroups) {
          const last = cluster[cluster.length - 1]
          if (!last) continue
          // 时间窗控制在一周内，避免把“同一种说法但不同时期”的事件合并。
          if (Math.abs(row.created_at - last.created_at) > 7 * DAY) continue
          const score = memoryContentSimilarity(row.content, cluster[0]?.content ?? '')
          if (score >= 0.55 && score > bestScore) {
            bestScore = score
            target = cluster
          }
        }
        if (target) target.push(row)
        else episodeGroups.push([row])
      }

      for (const cluster of episodeGroups) {
        if (cluster.length < minClusterSize) continue
        const ids = cluster.map((item) => item.id)
        const key = clusterKey(ids)
        const exists = db
          .prepare('SELECT 1 AS hit FROM memories WHERE company_id = ? AND cluster_key = ? AND archived_at IS NULL LIMIT 1')
          .get(options.companyId, key) as { hit?: number } | undefined
        if (exists?.hit) continue
        clusters += 1
        const nowRow = cluster[0]
        if (!nowRow) continue
        const importance = Math.max(...cluster.map((item) => item.importance ?? 0.5))
        const salience = Math.max(...cluster.map((item) => item.salience ?? 0.55))
        const eventAt = Math.max(...cluster.map((item) => item.event_at ?? item.created_at))
        const mergedId = `mem_${randomUUID()}`
        db.prepare(
          `INSERT INTO memories
             (id, company_id, scope_type, scope_id, user_id, content, memory_type, confirmed,
              valid_from, importance, sensitivity, extraction_source, cluster_key, merged_from,
              event_at, salience, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'episode', 1, ?, ?, 'normal', 'consolidated', ?, ?, ?, ?, ?)`,
        ).run(
          mergedId,
          options.companyId,
          nowRow.scope_type,
          nowRow.scope_id,
          nowRow.user_id,
          mergedContent(cluster),
          now,
          importance,
          key,
          JSON.stringify(ids),
          eventAt,
          salience,
          now,
        )
        db.prepare(
          `UPDATE memories
              SET archived_at = ?, cluster_key = ?
            WHERE company_id = ? AND id IN (${ids.map(() => '?').join(', ')})`,
        ).run(now, key, options.companyId, ...ids)
        consolidated += 1
      }
    }

    const stale = db
      .prepare(
        `UPDATE memories
            SET archived_at = ?
          WHERE company_id = ? AND memory_type = 'episode' AND confirmed = 1
            AND deleted_at IS NULL AND archived_at IS NULL
            AND valid_to IS NULL
            AND recall_count = 0
            AND created_at < ?`,
      )
      .run(now, options.companyId, now - archiveAfterDays * DAY)
    archived = Number(stale.changes ?? 0)

    const finishedAt = Date.now()
    const payload: MemoryMaintenanceResult = {
      runId,
      skipped: false,
      scanned,
      clusters,
      consolidated,
      archived,
      startedAt: now,
      finishedAt,
    }
    db.prepare(
      `INSERT INTO memory_maintenance_runs (id, company_id, kind, started_at, finished_at, result_json)
       VALUES (?, ?, 'all', ?, ?, ?)`,
    ).run(runId, options.companyId, now, finishedAt, JSON.stringify(payload))
    return payload
  })
  return result
}

export function lastMemoryMaintenanceRun(db: Db, companyId: string): {
  startedAt: number
  finishedAt: number | null
  result: Record<string, unknown> | null
  error: string | null
} | null {
  const row = db
    .prepare(
      `SELECT started_at, finished_at, result_json, error
         FROM memory_maintenance_runs
        WHERE company_id = ? AND kind = 'all'
        ORDER BY started_at DESC LIMIT 1`,
    )
    .get(companyId) as
    | { started_at: number; finished_at: number | null; result_json: string | null; error: string | null }
    | undefined
  if (!row) return null
  let result: Record<string, unknown> | null = null
  try {
    result = row.result_json ? JSON.parse(row.result_json) as Record<string, unknown> : null
  } catch {
    result = null
  }
  return { startedAt: row.started_at, finishedAt: row.finished_at, result, error: row.error }
}

/**
 * 后台每日维护。只在 worker 角色启动；返回停止函数。
 * 首跑延迟一分钟，避免和启动期迁移、插件加载抢写锁。
 */
export function startMemoryMaintenance(db: Db, companyId: string): () => void {
  let stopped = false
  const run = (source: string) => {
    if (stopped) return
    try {
      const result = runMemoryMaintenance(db, { companyId })
      if (result.skipped) return
      console.log(
        `[eab] 记忆维护完成（${source}）：扫描 ${result.scanned} 条情景，合并 ${result.consolidated} 组，归档 ${result.archived} 条`,
      )
    } catch (error) {
      console.warn('[eab] 记忆维护失败：', (error as Error).message)
    }
  }
  const first = setTimeout(() => run('启动'), 60_000)
  first.unref?.()
  const timer = setInterval(() => run('定时'), MAINTENANCE_INTERVAL_MS)
  timer.unref?.()
  return () => {
    stopped = true
    clearTimeout(first)
    clearInterval(timer)
  }
}
