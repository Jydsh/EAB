/**
 * 工具耗时度量（只读聚合，不写任何表）。
 *
 * 为什么先做这个：要不要把对话回合改成「可挂起 / 可续跑」，取决于慢工具是否真在堵住对话。
 * 数据就在 agent_steps 里（duration_ms 一直有记），聚合一下就能判断，不需要改回合主链路。
 *
 * 口径：
 * - 只看 kind = 'tool' 的步骤（模型步骤与子 Agent 步骤不计）；
 * - 默认窗口 7 天，最长 30 天；
 * - 「慢」默认按 8 秒计（可用 EAB_TOOL_SLOW_MS 覆盖），与后台化方案的阈值一致。
 */
import type { Db } from '@eab/storage'

export interface ToolDurationRow {
  toolId: string
  calls: number
  avgMs: number
  p50Ms: number
  p95Ms: number
  maxMs: number
  slowCalls: number
}

export interface ToolDurationStats {
  days: number
  thresholdMs: number
  totalCalls: number
  totalSlowCalls: number
  tools: ToolDurationRow[]
}

export function toolSlowThresholdMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.EAB_TOOL_SLOW_MS)
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 8_000
}

/**
 * 按工具聚合近 N 天的耗时。
 * p50/p95 用窗口函数取「第 rank 个」样本，避免把几万条样本拉进内存排序。
 */
export function toolDurationStats(
  db: Db,
  opts: { days?: number; limit?: number; thresholdMs?: number; now?: number } = {},
): ToolDurationStats {
  const days = Math.min(30, Math.max(1, Math.trunc(opts.days ?? 7)))
  const limit = Math.min(30, Math.max(1, Math.trunc(opts.limit ?? 10)))
  const thresholdMs = opts.thresholdMs ?? toolSlowThresholdMs()
  const since = (opts.now ?? Date.now()) - days * 86_400_000

  const rows = db
    .prepare(
      `WITH s AS (
         SELECT tool_id, duration_ms,
                ROW_NUMBER() OVER (PARTITION BY tool_id ORDER BY duration_ms) AS rn,
                COUNT(*) OVER (PARTITION BY tool_id) AS cnt
           FROM agent_steps
          WHERE kind = 'tool' AND tool_id IS NOT NULL AND created_at >= ?
       )
       SELECT tool_id,
              MAX(cnt) AS calls,
              CAST(AVG(duration_ms) AS INTEGER) AS avg_ms,
              MAX(CASE WHEN rn = CAST(cnt * 0.5 AS INTEGER) + 1 THEN duration_ms END) AS p50_ms,
              MAX(CASE WHEN rn = CAST(cnt * 0.95 AS INTEGER) + 1 THEN duration_ms END) AS p95_ms,
              MAX(duration_ms) AS max_ms,
              SUM(CASE WHEN duration_ms >= ? THEN 1 ELSE 0 END) AS slow_calls
         FROM s
        GROUP BY tool_id
        ORDER BY calls DESC, p95_ms DESC
        LIMIT ?`,
    )
    .all(since, thresholdMs, limit) as unknown as Array<{
    tool_id: string
    calls: number
    avg_ms: number | null
    p50_ms: number | null
    p95_ms: number | null
    max_ms: number | null
    slow_calls: number | null
  }>

  const tools: ToolDurationRow[] = rows.map((row) => ({
    toolId: row.tool_id,
    calls: Number(row.calls ?? 0),
    avgMs: Number(row.avg_ms ?? 0),
    p50Ms: Number(row.p50_ms ?? row.avg_ms ?? 0),
    p95Ms: Number(row.p95_ms ?? row.max_ms ?? 0),
    maxMs: Number(row.max_ms ?? 0),
    slowCalls: Number(row.slow_calls ?? 0),
  }))

  return {
    days,
    thresholdMs,
    totalCalls: tools.reduce((sum, row) => sum + row.calls, 0),
    totalSlowCalls: tools.reduce((sum, row) => sum + row.slowCalls, 0),
    tools,
  }
}
