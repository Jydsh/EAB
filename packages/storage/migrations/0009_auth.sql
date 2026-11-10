-- 0009_auth.sql
-- 目的：员工本地账号登录的失败计数（密码哈希已有 users.password_hash，会话已有 sessions）
CREATE TABLE IF NOT EXISTS login_attempts (
  key          TEXT PRIMARY KEY,
  fail_count   INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  updated_at   INTEGER NOT NULL
);
