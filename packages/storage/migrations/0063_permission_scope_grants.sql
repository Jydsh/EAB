-- 0063_permission_scope_grants.sql
-- 目的：权限申请从“申请角色”改为“申请权限点”，审批通过只写 scope 临时授权。
--
-- 设计边界：
-- 1. 历史角色申请继续保留 role 类型；新增 scope 类型只授所选 scope，不写 user_roles。
-- 2. 现有 permission_requests 的 role_id / role_code / role_name 为 NOT NULL，
--    因此 scope 申请仍写入申请人的一个现有角色作为“身份锚点”，不改变列约束；
--    授权与展示以 request_type + scopes_json 为准，锚点角色不会被授予。
-- 3. scope 临时授权到期后由读侧过滤；保留记录用于审计，不在到期时物理删除。
ALTER TABLE permission_requests
  ADD COLUMN request_type TEXT NOT NULL DEFAULT 'role';

CREATE TABLE IF NOT EXISTS permission_scope_grants (
  id             TEXT PRIMARY KEY,
  request_id     TEXT NOT NULL REFERENCES permission_requests(id),
  company_id     TEXT NOT NULL REFERENCES companies(id),
  user_id        TEXT NOT NULL REFERENCES users(id),
  scope          TEXT NOT NULL,
  granted_by     TEXT,
  granted_at     INTEGER NOT NULL,
  expires_at     INTEGER,
  revoked_at     INTEGER,
  created_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_permission_scope_grant_request_scope
  ON permission_scope_grants (request_id, scope);
CREATE INDEX IF NOT EXISTS idx_permission_scope_grants_user
  ON permission_scope_grants (company_id, user_id, scope, expires_at);
