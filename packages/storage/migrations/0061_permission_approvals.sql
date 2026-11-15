-- 多级权限审批：角色申请、按 scope 配置审批链、审批步骤、决策与授权记录。
--
-- 只授角色、不授 scope：最终通过时写 permission_role_grants + user_roles，
-- 角色到期由 user_roles.expires_at 控制，读侧在 roleCodesOf 里过滤。

ALTER TABLE roles ADD COLUMN requestable INTEGER NOT NULL DEFAULT 0;

-- 先开放两个内置角色作为可申请角色；管理角色仍保持不可申请。
UPDATE roles SET requestable = 1 WHERE code IN ('kb_admin', 'auditor');

CREATE TABLE IF NOT EXISTS permission_approval_policies (
  id                       TEXT PRIMARY KEY,
  company_id               TEXT NOT NULL REFERENCES companies(id),
  target_type              TEXT NOT NULL DEFAULT 'scope',
  target_key               TEXT NOT NULL,
  max_levels               INTEGER NOT NULL DEFAULT 3,
  include_company_admin    INTEGER NOT NULL DEFAULT 1,
  timeout_hours            INTEGER NOT NULL DEFAULT 72,
  approver_strategy        TEXT NOT NULL DEFAULT 'dept_chain',
  fixed_approvers_json     TEXT,
  created_by               TEXT,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_permission_policy_target
  ON permission_approval_policies (company_id, target_type, target_key);
CREATE INDEX IF NOT EXISTS idx_permission_policy_company
  ON permission_approval_policies (company_id, target_type);

CREATE TABLE IF NOT EXISTS permission_requests (
  id                     TEXT PRIMARY KEY,
  company_id             TEXT NOT NULL REFERENCES companies(id),
  requester_user_id      TEXT NOT NULL REFERENCES users(id),
  role_id                TEXT NOT NULL REFERENCES roles(id),
  role_code              TEXT NOT NULL,
  role_name              TEXT NOT NULL,
  scopes_json            TEXT NOT NULL DEFAULT '[]',
  reason                 TEXT NOT NULL DEFAULT '',
  status                 TEXT NOT NULL DEFAULT 'pending',
  current_step           INTEGER NOT NULL DEFAULT 1,
  total_steps            INTEGER NOT NULL DEFAULT 0,
  policy_id              TEXT REFERENCES permission_approval_policies(id),
  duration_hours         INTEGER NOT NULL DEFAULT 168,
  requested_expires_at   INTEGER NOT NULL,
  request_deadline       INTEGER NOT NULL,
  decided_at             INTEGER,
  granted_role_grant_id  TEXT,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_permission_requests_requester
  ON permission_requests (company_id, requester_user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_permission_requests_status
  ON permission_requests (company_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS permission_approval_steps (
  id                    TEXT PRIMARY KEY,
  request_id            TEXT NOT NULL REFERENCES permission_requests(id),
  company_id            TEXT NOT NULL REFERENCES companies(id),
  step_no               INTEGER NOT NULL,
  approver_user_id      TEXT NOT NULL REFERENCES users(id),
  approver_name         TEXT NOT NULL DEFAULT '',
  status                TEXT NOT NULL DEFAULT 'pending',
  card_out_track_id     TEXT,
  card_status           TEXT NOT NULL DEFAULT 'none',
  card_error            TEXT NOT NULL DEFAULT '',
  decided_at            INTEGER,
  decided_by            TEXT,
  comment               TEXT NOT NULL DEFAULT '',
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_permission_step_request_no
  ON permission_approval_steps (request_id, step_no);
CREATE INDEX IF NOT EXISTS idx_permission_steps_todo
  ON permission_approval_steps (company_id, approver_user_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_permission_steps_card
  ON permission_approval_steps (card_out_track_id);

CREATE TABLE IF NOT EXISTS permission_request_decisions (
  id                 TEXT PRIMARY KEY,
  request_id         TEXT NOT NULL REFERENCES permission_requests(id),
  step_id            TEXT REFERENCES permission_approval_steps(id),
  step_no            INTEGER NOT NULL DEFAULT 0,
  company_id         TEXT NOT NULL REFERENCES companies(id),
  approver_user_id   TEXT NOT NULL REFERENCES users(id),
  decision           TEXT NOT NULL,
  comment            TEXT NOT NULL DEFAULT '',
  event_key          TEXT NOT NULL,
  created_at         INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_permission_decision_event
  ON permission_request_decisions (event_key);
CREATE INDEX IF NOT EXISTS idx_permission_decisions_request
  ON permission_request_decisions (request_id, created_at);

CREATE TABLE IF NOT EXISTS permission_role_grants (
  id             TEXT PRIMARY KEY,
  request_id     TEXT NOT NULL REFERENCES permission_requests(id),
  company_id     TEXT NOT NULL REFERENCES companies(id),
  user_id        TEXT NOT NULL REFERENCES users(id),
  role_id        TEXT NOT NULL REFERENCES roles(id),
  role_code      TEXT NOT NULL,
  granted_by     TEXT,
  granted_at     INTEGER NOT NULL,
  expires_at     INTEGER,
  revoked_at     INTEGER,
  created_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_permission_grant_request
  ON permission_role_grants (request_id);

-- 默认策略：可申请角色当前拥有的 scope 各生成一条“直属负责人 → 上级负责人 → 公司管理员”链。
-- 管理员后续可按 scope 调整 max_levels / include_company_admin / timeout_hours。
INSERT OR IGNORE INTO permission_approval_policies (
  id, company_id, target_type, target_key, max_levels, include_company_admin,
  timeout_hours, approver_strategy, fixed_approvers_json, created_by, created_at, updated_at
)
SELECT
  'pap_' || lower(hex(randomblob(8))),
  r.company_id,
  'scope',
  rs.scope,
  3,
  1,
  72,
  'dept_chain',
  NULL,
  'system-seed',
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM roles r
JOIN role_scopes rs ON rs.role_id = r.id
WHERE r.code IN ('kb_admin', 'auditor')
  AND r.deleted_at IS NULL;
