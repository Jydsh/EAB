-- 0001_init.sql
-- 目的：基座核心表（公司 / 组织 / 身份绑定 / 角色权限 / 会话 / 审计 / 系统元数据）
-- 影响表：新建 11 张表 + 索引 + 审计不可改触发器
-- 可在线执行：是（空库或小库，秒级）
-- 约定：主键 TEXT(ULID)，时间 INTEGER 毫秒(UTC)，软删除 deleted_at，全表带 company_id

CREATE TABLE IF NOT EXISTS companies (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'active',
  settings_json TEXT,
  created_at    INTEGER NOT NULL,
  deleted_at    INTEGER
);

CREATE TABLE IF NOT EXISTS departments (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES companies(id),
  parent_id       TEXT REFERENCES departments(id),
  name            TEXT NOT NULL,
  path            TEXT NOT NULL,
  depth           INTEGER NOT NULL DEFAULT 1,
  order_no        INTEGER NOT NULL DEFAULT 0,
  channel_dept_id TEXT,
  manager_user_id TEXT,
  created_at      INTEGER NOT NULL,
  deleted_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_departments_company_path ON departments (company_id, path);
CREATE UNIQUE INDEX IF NOT EXISTS uq_departments_channel ON departments (company_id, channel_dept_id)
  WHERE channel_dept_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS users (
  id                   TEXT PRIMARY KEY,
  company_id           TEXT NOT NULL REFERENCES companies(id),
  dept_id              TEXT NOT NULL REFERENCES departments(id),
  dept_path            TEXT NOT NULL,
  name                 TEXT NOT NULL,
  employee_no          TEXT,
  title                TEXT,
  email                TEXT,
  mobile               TEXT,
  avatar               TEXT,
  status               TEXT NOT NULL DEFAULT 'invited',
  data_scope_override  TEXT,
  password_hash        TEXT,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  disabled_at          INTEGER,
  deleted_at           INTEGER
);
CREATE INDEX IF NOT EXISTS idx_users_company_dept_path ON users (company_id, dept_path);
CREATE INDEX IF NOT EXISTS idx_users_status ON users (company_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_employee_no ON users (company_id, employee_no)
  WHERE employee_no IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_identities (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id),
  provider         TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  union_id         TEXT,
  bound_at         INTEGER NOT NULL,
  bound_by         TEXT,
  status           TEXT NOT NULL DEFAULT 'active'
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_identities_provider_external
  ON user_identities (provider, external_user_id);

CREATE TABLE IF NOT EXISTS roles (
  id         TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  code       TEXT NOT NULL,
  name       TEXT NOT NULL,
  data_scope TEXT NOT NULL DEFAULT 'self',
  builtin    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_roles_company_code ON roles (company_id, code);

CREATE TABLE IF NOT EXISTS role_scopes (
  role_id TEXT NOT NULL REFERENCES roles(id),
  scope   TEXT NOT NULL,
  PRIMARY KEY (role_id, scope)
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id    TEXT NOT NULL REFERENCES users(id),
  role_id    TEXT NOT NULL REFERENCES roles(id),
  granted_by TEXT,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS authz_overrides (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES companies(id),
  user_id       TEXT NOT NULL REFERENCES users(id),
  effect        TEXT NOT NULL,
  scope         TEXT NOT NULL,
  resource_type TEXT,
  resource_id   TEXT,
  reason        TEXT NOT NULL,
  expires_at    INTEGER,
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_authz_overrides_user ON authz_overrides (company_id, user_id);

CREATE TABLE IF NOT EXISTS sessions (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id),
  refresh_hash       TEXT NOT NULL,
  device_fingerprint TEXT,
  user_agent         TEXT,
  last_ip            TEXT,
  created_at         INTEGER NOT NULL,
  last_seen_at       INTEGER NOT NULL,
  revoked_at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id, revoked_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id              TEXT PRIMARY KEY,
  seq             INTEGER NOT NULL UNIQUE,
  company_id      TEXT NOT NULL,
  actor_user_id   TEXT,
  action          TEXT NOT NULL,
  resource_type   TEXT,
  resource_id     TEXT,
  resource_scope  TEXT,
  result          TEXT NOT NULL,
  detail_json     TEXT,
  trace_id        TEXT,
  ip              TEXT,
  channel         TEXT,
  prev_hash       TEXT NOT NULL,
  hash            TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_company_time ON audit_logs (company_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_actor_time ON audit_logs (actor_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_action_time ON audit_logs (action, created_at);

-- 审计不可改：数据库层直接拦住 UPDATE / DELETE，任何绕过应用层的改动都会失败
CREATE TRIGGER IF NOT EXISTS trg_audit_no_update
BEFORE UPDATE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_audit_no_delete
BEFORE DELETE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only');
END;

CREATE TABLE IF NOT EXISTS system_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
