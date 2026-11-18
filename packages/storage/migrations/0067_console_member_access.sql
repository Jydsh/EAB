-- 0067_console_member_access.sql
-- 管理后台多用户权限第一步：
-- 1) 公司成员的后台会话单独存表，和员工对话 sessions、平台超管无状态 Cookie 分开；
-- 2) 页面级权限只存“可见 / 管理”，管理自动包含可见；
-- 3) 权限按 (company_id, user_id, page) 存，前端导航与服务端接口守卫共用同一套 page key。

CREATE TABLE IF NOT EXISTS console_member_sessions (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL REFERENCES companies(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  token_hash   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER,
  user_agent   TEXT,
  last_ip      TEXT,
  revoked_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_console_member_sessions_user
  ON console_member_sessions (company_id, user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_console_member_sessions_token
  ON console_member_sessions (token_hash);

CREATE TABLE IF NOT EXISTS console_page_permissions (
  company_id TEXT NOT NULL REFERENCES companies(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  page       TEXT NOT NULL,
  can_view   INTEGER NOT NULL DEFAULT 0,
  can_manage INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (company_id, user_id, page)
);
CREATE INDEX IF NOT EXISTS idx_console_page_permissions_user
  ON console_page_permissions (company_id, user_id);
