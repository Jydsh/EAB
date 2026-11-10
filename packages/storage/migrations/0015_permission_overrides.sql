-- 0015_permission_overrides.sql
-- 目的：PERM-05 显式 allow / deny 覆盖（临时授权 / 例外），带过期时间
CREATE TABLE IF NOT EXISTS permission_overrides (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  scope        TEXT NOT NULL,
  effect       TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
  reason       TEXT,
  expires_at   INTEGER,
  created_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  revoked_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_permission_overrides_user
  ON permission_overrides (company_id, user_id, scope);
