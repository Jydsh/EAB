-- 0105: 记忆抽取基准评测运行记录（F 阶段）
-- 只记录固定数据集的通过/漏写/误写/敏感泄漏计数与失败用例编号，不保存对话原文。

CREATE TABLE IF NOT EXISTS memory_benchmark_runs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  dataset_version TEXT NOT NULL,
  total_cases INTEGER NOT NULL,
  passed INTEGER NOT NULL,
  expected_extract INTEGER NOT NULL,
  extracted_hits INTEGER NOT NULL,
  missed INTEGER NOT NULL,
  expected_ignore INTEGER NOT NULL,
  unexpected INTEGER NOT NULL,
  sensitive_cases INTEGER NOT NULL,
  sensitive_leaks INTEGER NOT NULL,
  hit_rate REAL NOT NULL,
  miss_rate REAL NOT NULL,
  miswrite_rate REAL NOT NULL,
  pass_rate REAL NOT NULL,
  retention_rounds INTEGER NOT NULL,
  retention_hit INTEGER NOT NULL,
  retention_rank INTEGER,
  duration_ms INTEGER NOT NULL,
  failure_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_benchmark_runs_company
  ON memory_benchmark_runs (company_id, created_at DESC);
