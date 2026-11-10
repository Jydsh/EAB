-- 0027: 本地空间（Local Space）
--
-- 口径：
-- - 每个本地空间绑定一个本机目录，一个用户可以绑定多个本地空间；
-- - 默认 read_write，AI 不删除文件、不执行命令；
-- - 敏感文件默认拒绝，用户可显式开启；
-- - 当前对话使用哪个空间记录在 chat_sessions，消息里存快照。
--
-- 注意：账号安全方案原计划的 0027_account_security.sql 顺延为 0028，避免抢号。

CREATE TABLE IF NOT EXISTS user_local_spaces (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES companies(id),
  user_id         TEXT NOT NULL REFERENCES users(id),
  name            TEXT NOT NULL,
  root_path       TEXT NOT NULL,
  root_realpath   TEXT NOT NULL,
  mode            TEXT NOT NULL DEFAULT 'read_write',
  allow_sensitive INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  last_used_at    INTEGER,
  deleted_at      INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_local_spaces_root
  ON user_local_spaces (company_id, user_id, root_realpath)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_user_local_spaces_user
  ON user_local_spaces (company_id, user_id, deleted_at, updated_at);

ALTER TABLE chat_sessions ADD COLUMN space_kind TEXT NOT NULL DEFAULT 'cloud';
ALTER TABLE chat_sessions ADD COLUMN space_id TEXT;

-- 给已有角色补本地空间权限：沿用工作区文件权限的边界。
INSERT OR IGNORE INTO role_scopes (role_id, scope)
SELECT DISTINCT role_id, 'local-space:read'
  FROM role_scopes
 WHERE scope IN ('workspace:read', 'workspace:write');

INSERT OR IGNORE INTO role_scopes (role_id, scope)
SELECT DISTINCT role_id, 'local-space:write'
  FROM role_scopes
 WHERE scope = 'workspace:write';

-- 超级管理员即使历史库没同步全量 scope，也补上。
INSERT OR IGNORE INTO role_scopes (role_id, scope)
SELECT id, 'local-space:read'
  FROM roles
 WHERE code = 'super_admin' AND deleted_at IS NULL;

INSERT OR IGNORE INTO role_scopes (role_id, scope)
SELECT id, 'local-space:write'
  FROM roles
 WHERE code = 'super_admin' AND deleted_at IS NULL;
