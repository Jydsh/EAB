-- 0012_workspace.sql
-- 目的：工作区共享、回收站、归档字段与更精确的唯一键
-- 影响表：workspace_files（重建唯一索引）/ 新建 workspace_shares
-- 可在线执行：是

DROP INDEX IF EXISTS uq_workspace_files_rel;

CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_files_scope_rel
  ON workspace_files (company_id, scope_type, scope_id, rel_path)
  WHERE deleted_at IS NULL;

ALTER TABLE workspace_files ADD COLUMN storage_path TEXT;
ALTER TABLE workspace_files ADD COLUMN recycled_path TEXT;
ALTER TABLE workspace_files ADD COLUMN archived_at INTEGER;

CREATE TABLE IF NOT EXISTS workspace_shares (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES companies(id),
  file_id     TEXT NOT NULL REFERENCES workspace_files(id),
  scope_type  TEXT NOT NULL,
  scope_id    TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_workspace_shares_file ON workspace_shares (company_id, file_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_workspace_shares_scope ON workspace_shares (company_id, scope_type, scope_id, revoked_at);
