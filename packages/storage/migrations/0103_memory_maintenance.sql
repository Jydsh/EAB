-- 0103: 记忆维护层（D 阶段）
-- 情景聚类/归档、召回次数、维护运行记录。所有列都可空或带默认值，历史数据无需回填。

ALTER TABLE memories ADD COLUMN archived_at INTEGER;
ALTER TABLE memories ADD COLUMN cluster_key TEXT;
ALTER TABLE memories ADD COLUMN merged_from TEXT;
ALTER TABLE memories ADD COLUMN recall_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN last_recalled_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_memories_archive
  ON memories (company_id, scope_type, scope_id, memory_type, archived_at);

CREATE INDEX IF NOT EXISTS idx_memories_cluster
  ON memories (company_id, cluster_key, archived_at);

CREATE TABLE IF NOT EXISTS memory_maintenance_runs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  result_json TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_memory_maintenance_runs
  ON memory_maintenance_runs (company_id, started_at DESC);
