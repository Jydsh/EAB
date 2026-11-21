-- 0083_permission_approval_progress.sql
-- 审批流程可视化与催办：
-- 1. 步骤行保存来源流程节点，详情页可显示真实节点标题、角色和会签/依次方式。
-- 2. 催办记录按节点落库，用于前端展示上次催办时间和后端冷却限制。

ALTER TABLE permission_approval_steps ADD COLUMN node_id TEXT NOT NULL DEFAULT '';
ALTER TABLE permission_approval_steps ADD COLUMN node_title TEXT NOT NULL DEFAULT '';
ALTER TABLE permission_approval_steps ADD COLUMN node_mode TEXT NOT NULL DEFAULT 'single';
ALTER TABLE permission_approval_steps ADD COLUMN approver_role_code TEXT NOT NULL DEFAULT '';
ALTER TABLE permission_approval_steps ADD COLUMN approver_role_name TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS permission_approval_urges (
  id               TEXT PRIMARY KEY,
  company_id       TEXT NOT NULL REFERENCES companies(id),
  request_id       TEXT NOT NULL REFERENCES permission_requests(id),
  step_no          INTEGER NOT NULL,
  from_user_id     TEXT NOT NULL REFERENCES users(id),
  to_user_ids_json TEXT NOT NULL DEFAULT '[]',
  delivered_count  INTEGER NOT NULL DEFAULT 0,
  failed_count     INTEGER NOT NULL DEFAULT 0,
  channel          TEXT NOT NULL DEFAULT 'dingtalk',
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_permission_urges_request_step
  ON permission_approval_urges (request_id, step_no, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_permission_urges_company
  ON permission_approval_urges (company_id, created_at DESC);
