-- 0081_approval_workflows.sql
-- 权限审批可视化流程设计器：流程模板 + 草稿/发布版本快照。
--
-- 设计边界：
-- 1. 模板元信息只存一份；每次发布冻结一个版本的 flow_json，运行中的申请可按版本回溯。
-- 2. 草稿版本号固定为 current_version + 1，保存草稿用 upsert，重复保存不会制造无意义版本。
-- 3. 模板、版本都按公司隔离；删除只做软删除。

CREATE TABLE IF NOT EXISTS approval_workflows (
  id                  TEXT PRIMARY KEY,
  company_id          TEXT NOT NULL REFERENCES companies(id),
  name                TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL DEFAULT 'draft',
  scope_mode          TEXT NOT NULL DEFAULT '全部权限点',
  role_mode           TEXT NOT NULL DEFAULT '全部员工角色',
  current_version      INTEGER NOT NULL DEFAULT 0,
  draft_version_id    TEXT,
  published_version_id TEXT,
  created_by          TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  deleted_at          INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_approval_workflow_name
  ON approval_workflows (company_id, name)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_approval_workflow_company
  ON approval_workflows (company_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS approval_workflow_versions (
  id              TEXT PRIMARY KEY,
  workflow_id     TEXT NOT NULL REFERENCES approval_workflows(id),
  company_id      TEXT NOT NULL REFERENCES companies(id),
  version         INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft',
  flow_json       TEXT NOT NULL,
  validation_json TEXT,
  created_by      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  published_at    INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_approval_workflow_version
  ON approval_workflow_versions (workflow_id, version);
CREATE INDEX IF NOT EXISTS idx_approval_workflow_version_status
  ON approval_workflow_versions (company_id, workflow_id, status, version DESC);
