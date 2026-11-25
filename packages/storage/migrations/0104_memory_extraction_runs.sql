-- 0104: 自动记忆抽取运行记录（E 阶段）
-- 用于统计各入口的抽取量、生效率、待确认/冲突/重复比例，不保存用户原话。

CREATE TABLE IF NOT EXISTS memory_extraction_runs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_id TEXT,
  source_message_id TEXT,
  channel TEXT NOT NULL DEFAULT 'web',
  mode TEXT NOT NULL,
  auto_confirm INTEGER NOT NULL DEFAULT 1,
  extracted INTEGER NOT NULL DEFAULT 0,
  inserted INTEGER NOT NULL DEFAULT 0,
  activated INTEGER NOT NULL DEFAULT 0,
  duplicates INTEGER NOT NULL DEFAULT 0,
  conflicts INTEGER NOT NULL DEFAULT 0,
  skipped_sensitive INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_extraction_runs_user
  ON memory_extraction_runs (company_id, user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_extraction_runs_channel
  ON memory_extraction_runs (company_id, channel, created_at DESC);
