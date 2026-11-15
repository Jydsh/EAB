-- 0056_workspace_versions.sql
-- 目的：工作区文件保存前版本快照、历史列表与恢复
-- 影响表：新建 workspace_file_versions
-- 可在线执行：是（只新增表与索引）
-- 约定：每个文件同一 updated_at 只保留一条快照；快照文件不计入用户/公司配额，按文件保留最近 20 条

CREATE TABLE IF NOT EXISTS workspace_file_versions (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL,
  file_id       TEXT NOT NULL REFERENCES workspace_files(id),
  version       INTEGER NOT NULL,
  size          INTEGER NOT NULL,
  storage_path  TEXT NOT NULL,
  operation_id  TEXT,
  source        TEXT NOT NULL,
  summary       TEXT,
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_file_versions_version
  ON workspace_file_versions (file_id, version);
CREATE INDEX IF NOT EXISTS idx_workspace_file_versions_file
  ON workspace_file_versions (company_id, file_id, created_at DESC);
