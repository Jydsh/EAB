-- 0025_workspace_quota_policies.sql
-- 目的：让个人工作区的容量与单文件上限可按「角色」或「用户」单独配置
-- 影响表：新建 workspace_quota_policies
-- 可在线执行：是（只新增表与索引）
-- 约定：scope_type = default | role | user；scope_id 分别是 default / 角色 code / 用户 id

CREATE TABLE IF NOT EXISTS workspace_quota_policies (
  company_id      TEXT NOT NULL REFERENCES companies(id),
  scope_type      TEXT NOT NULL,
  scope_id        TEXT NOT NULL,
  limit_bytes     INTEGER NOT NULL,
  file_limit_bytes INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (company_id, scope_type, scope_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_quota_policies_scope
  ON workspace_quota_policies (company_id, scope_type, scope_id);
