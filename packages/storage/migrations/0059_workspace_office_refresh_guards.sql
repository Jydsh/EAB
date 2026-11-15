-- 0059_workspace_office_refresh_guards.sql
-- 目的：把 OnlyOffice 编辑态“刷新到云端版本”的版本水位持久化
-- 影响表：新建 workspace_office_refresh_guards
-- 可在线执行：是（只新增表）
-- 约定：company_id + file_id 唯一；cutoff 是刷新时云端文件 updated_at，旧编辑器回调版本低于它必须丢弃

CREATE TABLE IF NOT EXISTS workspace_office_refresh_guards (
  company_id        TEXT NOT NULL,
  file_id           TEXT NOT NULL REFERENCES workspace_files(id),
  cutoff            INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (company_id, file_id)
);
