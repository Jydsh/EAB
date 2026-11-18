/**
 * 知识库召回测试记录的保留期清理。
 *
 * 测试记录只用于调参，不应长期占库；按 kb_test_runs.expires_at 删除，
 * 业务侧在创建记录时已按知识库的 test_retention_days 算出过期时间。
 */
import type { Db } from '@eab/storage'

const CLEAN_INTERVAL_MS = 6 * 60 * 60 * 1000
let started = false

export function pruneKbTestRuns(db: Db, now = Date.now()): number {
  const result = db
    .prepare('DELETE FROM kb_test_runs WHERE expires_at IS NOT NULL AND expires_at < ?')
    .run(now)
  return Number(result.changes ?? 0)
}

export function startKbTestRetentionWorker(db: Db): void {
  if (started) return
  started = true
  pruneKbTestRuns(db)
  const timer = setInterval(() => pruneKbTestRuns(db), CLEAN_INTERVAL_MS)
  timer.unref?.()
}
