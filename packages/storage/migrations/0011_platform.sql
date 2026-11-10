-- 0011_platform.sql
-- 目的：审计/审批/访客/记忆/工作区配额五类平台能力的落地表
-- 影响表：新建 approvals / guest_invites / memories / storage_quotas / workspace_files
-- 可在线执行：是（只新增表与索引）
-- 约定：时间 INTEGER 毫秒(UTC)，软删除 deleted_at

CREATE TABLE IF NOT EXISTS approvals (
  id               TEXT PRIMARY KEY,
  company_id       TEXT NOT NULL REFERENCES companies(id),
  requester_user_id TEXT NOT NULL,
  action           TEXT NOT NULL,
  resource_type    TEXT NOT NULL,
  resource_id      TEXT,
  payload_json     TEXT,
  status           TEXT NOT NULL DEFAULT 'pending',
  reason           TEXT,
  decided_by       TEXT,
  decided_at       INTEGER,
  expires_at       INTEGER,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_company_status ON approvals (company_id, status, created_at);

CREATE TABLE IF NOT EXISTS guest_invites (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES companies(id),
  code_hash   TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL,
  features_json TEXT,
  max_uses    INTEGER NOT NULL DEFAULT 1,
  used_count  INTEGER NOT NULL DEFAULT 0,
  expires_at  INTEGER,
  created_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);

CREATE TABLE IF NOT EXISTS memories (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES companies(id),
  scope_type    TEXT NOT NULL,
  scope_id      TEXT NOT NULL,
  user_id       TEXT,
  content       TEXT NOT NULL,
  confirmed     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  deleted_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories (company_id, scope_type, scope_id, deleted_at);

CREATE TABLE IF NOT EXISTS storage_quotas (
  company_id  TEXT NOT NULL REFERENCES companies(id),
  scope_type  TEXT NOT NULL,
  scope_id    TEXT NOT NULL,
  limit_bytes INTEGER NOT NULL,
  used_bytes  INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (company_id, scope_type, scope_id)
);

CREATE TABLE IF NOT EXISTS workspace_files (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES companies(id),
  scope_type    TEXT NOT NULL,
  scope_id      TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  rel_path      TEXT NOT NULL,
  name          TEXT NOT NULL,
  size          INTEGER NOT NULL DEFAULT 0,
  mime          TEXT,
  deleted_at    INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspace_files_scope ON workspace_files (company_id, scope_type, scope_id, deleted_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_files_rel ON workspace_files (company_id, rel_path)
  WHERE deleted_at IS NULL;
